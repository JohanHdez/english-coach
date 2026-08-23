// Worker: runs Whisper locally with transformers.js (ONNX Runtime Web).
import { pipeline, env } from './vendor/transformers.js';

let transcriber = null;
let modelId = null;
let ready = null; // load promise (kept so transcriptions can await it)

function configure(base) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = base;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

async function build(model, device) {
  const dtype = device === 'webgpu'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    : { encoder_model: 'fp32', decoder_model_merged: 'q8' };

  return pipeline('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress') {
        self.postMessage({ type: 'progress', file: p.file, progress: p.progress });
      }
    },
  });
}

function init(model, device, base) {
  if (ready && modelId === model) return ready;

  configure(base);
  modelId = model;
  ready = (async () => {
    let used = device;
    if (device === 'webgpu' && !('gpu' in navigator)) used = 'wasm';
    try {
      transcriber = await build(model, used);
    } catch (e) {
      if (used === 'webgpu') {
        self.postMessage({ type: 'progress', file: 'WebGPU no disponible, usando CPU…', progress: 0 });
        used = 'wasm';
        transcriber = await build(model, used);
      } else {
        throw e;
      }
    }
    self.postMessage({ type: 'ready', device: used === 'webgpu' ? 'GPU' : 'CPU' });
    return transcriber;
  })();

  ready.catch((err) => self.postMessage({ type: 'error', message: err?.message || String(err) }));
  return ready;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await init(msg.model, msg.device, msg.base);
      return;
    }

    if (msg.type === 'transcribe') {
      if (!ready) throw new Error('El modelo no se ha inicializado.');
      await ready; // wait for the first load instead of dropping the audio
      if (!transcriber) throw new Error('El modelo no se pudo cargar.');
      const opts = { chunk_length_s: 30, return_timestamps: false };
      if (!/\.en$/.test(modelId || '')) { opts.language = 'english'; opts.task = 'transcribe'; }
      const out = await transcriber(msg.audio, opts);
      self.postMessage({ type: 'result', id: msg.id, text: (out && out.text) || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
