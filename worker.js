// Worker: runs Whisper locally with transformers.js (ONNX Runtime Web).
import { pipeline, env } from './vendor/transformers.js';

let transcriber = null;
let modelId = null;
let sessionLang = 'en';
let ready = null; // load promise (kept so transcriptions can await it)
let lastInit = null;      // last init args, so a failed load can retry in-session
let loadError = null;     // why the last load failed: shown instead of a generic
let loadFailedAt = 0;
const RETRY_COOLDOWN_MS = 60000; // segments arrive every few seconds; without
                                 // this a dead network would re-download per segment

// The .en Whisper exports only understand English: a session that is not purely
// English silently transcribing garbage would be worse than a bigger download, so
// the model is swapped for its multilingual sibling instead. Stated as "anything
// but English" rather than "Spanish", so a new session language cannot quietly
// inherit an English-only model. A missing lang defaults to English, matching
// init()'s own default parameter.
export function modelForLang(model, lang) {
  return (lang == null || lang === 'en') ? model : String(model).replace(/\.en$/, '');
}

function configure(base) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = base;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

// Load ladder. The vendored ONNX Runtime (1.26) rejects every old q8/uint8
// Whisper export whose tied-embedding weights share scale initializers
// ("Missing required scale … MatMulNBits", fixed upstream in ort-web 1.27), so
// q8 is not offered at all: q4 ships MatMulNBits pre-fused with its scales and
// loads on both backends (verified against this vendor), and fp32 has no
// quantization to rewrite. Restore a q8 first rung when vendor/ is refreshed
// with ort-web >= 1.27 — it is a quarter of q4's download.
export function loadAttempts(device) {
  const wasm = [['wasm', 'q4'], ['wasm', 'fp32']];
  if (device !== 'webgpu') return wasm;
  return [['webgpu', 'q4'], ['webgpu', 'fp32'], ...wasm];
}

async function build(model, device, decoder) {
  return pipeline('automatic-speech-recognition', model, {
    device,
    dtype: { encoder_model: 'fp32', decoder_model_merged: decoder },
    progress_callback: (p) => {
      if (p.status === 'progress') {
        self.postMessage({ type: 'progress', file: p.file, progress: p.progress });
      }
    },
  });
}

function init(model, device, base, lang = 'en') {
  const objetivo = modelForLang(model, lang);
  if (ready && modelId === objetivo) return ready;

  configure(base);
  modelId = objetivo;
  sessionLang = lang;
  lastInit = { model, device, base, lang };
  loadError = null;
  ready = (async () => {
    let lastErr = null;
    let first = true;
    for (const [dev, decoder] of loadAttempts(device)) {
      if (dev === 'webgpu' && !('gpu' in navigator)) continue;
      if (!first) {
        self.postMessage({
          type: 'progress',
          file: `Reintentando con ${dev === 'webgpu' ? 'GPU' : 'CPU'} y decoder ${decoder}…`,
          progress: 0,
        });
      }
      first = false;
      try {
        transcriber = await build(objetivo, dev, decoder);
        self.postMessage({ type: 'ready', device: dev === 'webgpu' ? 'GPU' : 'CPU' });
        return transcriber;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No se pudo cargar el modelo.');
  })();

  ready.catch((err) => {
    // A rejected load must not stick: transcriptions await this same promise, so
    // a cached rejection would keep the engine dead until the offscreen document
    // is torn down. The reason is kept — later segments must show it, not a
    // generic "not initialized".
    ready = null;
    modelId = null;
    transcriber = null;
    loadError = err;
    loadFailedAt = Date.now();
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  });
  return ready;
}

// Guarded so Node can import loadAttempts for the unit tests: there `self` does
// not exist, and this file must stay importable without a worker harness.
if (typeof self !== 'undefined') self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await init(msg.model, msg.device, msg.base, msg.lang);
      return;
    }

    if (msg.type === 'transcribe') {
      // After a failed load, retry it in-session (the failure may have been a
      // flaky download) — but not more than once a minute, or a dead network
      // would restart the model download for every queued segment.
      if (!ready && lastInit && Date.now() - loadFailedAt > RETRY_COOLDOWN_MS) {
        init(lastInit.model, lastInit.device, lastInit.base, lastInit.lang);
      }
      if (!ready) {
        throw new Error(loadError
          ? `[modelo] ${loadError.message || loadError}`
          : 'El modelo no se ha inicializado.');
      }
      await ready; // wait for the first load instead of dropping the audio
      if (!transcriber) throw new Error('El modelo no se pudo cargar.');
      const opts = { chunk_length_s: 30, return_timestamps: false };
      if (!/\.en$/.test(modelId || '')) {
        // Per request, not per session: in a bilingual meeting consecutive segments
        // are in different languages, and a multilingual model decodes whichever
        // language its token names.
        const lang = msg.lang || sessionLang;
        opts.language = lang === 'es' ? 'spanish' : 'english';
        opts.task = 'transcribe';
      }
      const out = await transcriber(msg.audio, opts);
      self.postMessage({ type: 'result', id: msg.id, text: (out && out.text) || '' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
