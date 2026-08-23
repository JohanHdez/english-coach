// Offscreen document: captures audio (tab + microphone), segments it by voice
// and sends it to be transcribed (local Whisper or the Groq API).

import { Segmenter, floatToWav, isJunk, SR } from './segmenter.js';
import { openCaptureStream } from './capture.js';
import { askHints, askReply, askReport, groqBaseOf, redact, resolveProvider, PROVIDERS, DEFAULT_COACH } from './coach.js';
import { startLive, liveAvailability } from './live.js';

const HINT_DEBOUNCE_MS = 1200;   // wait in case the other speaker keeps talking
const HINT_COOLDOWN_MS = 6000;   // at most one round of chips every 6 s

const state = {
  running: false,
  settings: null,
  playbackCtx: null,
  workCtx: null,
  streams: [],
  worker: null,
  workerReady: false,
  queue: [],
  busy: false,
  seq: 0,
  turns: [],
  hintTimer: null,
  hintBusy: false,
  lastHintAt: 0,
  live: null,
  liveTrack: null,
};

// ---------------------------------------------------------------- utilities

// An offscreen document only has chrome.runtime: no chrome.storage at all.
// All of its storage goes through the service worker.
const store = {
  get: (keys) => chrome.runtime.sendMessage({ target: 'background', type: 'STORE_GET', keys }),
  set: (items) => chrome.runtime.sendMessage({ target: 'background', type: 'STORE_SET', items }),
};

// Always re-read. The offscreen document outlives the session, so a key saved
// after startup would never arrive if this were cached: the coach would keep
// reporting a missing API key that is in fact configured. It is a message to the
// service worker, not an expensive read, and only happens on coach calls.
async function ensureSettings() {
  const { settings } = (await store.get('settings')) || {};
  state.settings = { ...(state.settings || {}), ...(settings || {}) };
  return coachSettings();
}

// One channel for both interfaces: side panel and in-page overlay (the service
// worker mirrors these messages into the tab).
function broadcast(msg) {
  chrome.runtime.sendMessage({ target: 'ui', ...msg }).catch(() => {});
}

function status(text, kind = 'info', extra = {}) {
  broadcast({ type: 'STATUS', text, kind, ...extra });
}

async function appendTranscript(entry) {
  const { transcript = [] } = (await store.get('transcript')) || {};
  transcript.push(entry);
  state.turns = transcript;
  await store.set({ transcript });
  broadcast({ type: 'SEGMENT', entry });
  if (entry.speaker === 'them') { state.live?.reset(); scheduleHints(); }
}

// ---------------------------------------------------------------- coach

function coachSettings() {
  return { ...DEFAULT_COACH, ...(state.settings || {}) };
}

const sortedTurns = () => [...state.turns].sort((a, b) => a.t - b.t);

function scheduleHints() {
  if (!coachSettings().liveCoach || !state.running) return;
  clearTimeout(state.hintTimer);
  state.hintTimer = setTimeout(async () => {
    if (state.hintBusy || Date.now() - state.lastHintAt < HINT_COOLDOWN_MS) return;
    state.hintBusy = true;
    try {
      const hints = await askHints({ turns: sortedTurns(), settings: await ensureSettings() });
      state.lastHintAt = Date.now();
      broadcast({ type: 'HINTS', ...hints });
    } catch (e) {
      broadcast({ type: 'HINTS', words: [], nudge: 'Coach: ' + (e.message || e) });
    } finally {
      state.hintBusy = false;
    }
  }, HINT_DEBOUNCE_MS);
}

async function suggestReply() {
  broadcast({ type: 'REPLY', pending: true });
  try {
    const { openers, ideas } = await askReply({ turns: sortedTurns(), settings: await ensureSettings() });
    broadcast({ type: 'REPLY', openers, ideas });
    return { ok: true };
  } catch (e) {
    const error = 'No se pudo sugerir: ' + (e.message || e);
    broadcast({ type: 'REPLY', error });
    return { ok: false, error };
  }
}

async function makeReport(auto = false) {
  const settings = await ensureSettings();
  const { transcript = [] } = (await store.get('transcript')) || {};
  state.turns = transcript;
  if (!transcript.some((t) => t.speaker === 'me')) {
    if (!auto) status('No hay intervenciones tuyas para analizar.', 'error');
    return { ok: false, error: 'sin intervenciones' };
  }
  const elegido = resolveProvider(settings.reportProvider, settings);
  if (!elegido) {
    const falta = `Falta la API key de ${PROVIDERS[settings.reportProvider]?.label || settings.reportProvider} (ábrela en Ajustes).`;
    status((auto ? 'Informe automático: ' : '') + falta, 'error');
    return { ok: false, error: falta };
  }
  if (elegido.fallback) {
    const pedido = PROVIDERS[settings.reportProvider]?.label || settings.reportProvider;
    status(`Informe con ${elegido.label}: no hay API key de ${pedido}.`, 'info');
  } else {
    status('Generando informe…');
  }
  try {
    const markdown = await askReport({ turns: sortedTurns(), settings });
    const asText = sortedTurns()
      .map((e) => `**${e.speaker === 'me' ? 'Yo' : 'Interlocutor'}**: ${e.text}`)
      .join('\n\n');
    await store.set({
      report: { markdown, at: Date.now(), turns: transcript.length, transcript: asText },
    });
    status('Informe listo.', 'ok');
    chrome.runtime.sendMessage({ target: 'background', type: 'OPEN_REPORT' }).catch(() => {});
    return { ok: true };
  } catch (e) {
    status((auto ? 'Informe automático: ' : '') + (e.message || e), 'error');
    return { ok: false, error: e.message || String(e) };
  }
}

// ------------------------------------------------------------------- engines

function ensureWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      status(`Descargando modelo ${m.file || ''} ${m.progress ? Math.round(m.progress) + '%' : ''}`, 'loading');
    } else if (m.type === 'ready') {
      state.workerReady = true;
      status(`Modelo listo (${m.device}). Escuchando…`, 'ok');
    } else if (m.type === 'error') {
      status('Error del modelo: ' + m.message, 'error');
    }
  };
  worker.onerror = (e) => status('Error del worker: ' + (e.message || 'desconocido'), 'error');
  state.worker = worker;
  return worker;
}

function localTranscribe(audio) {
  return new Promise((resolve, reject) => {
    const id = ++state.seq;
    const worker = ensureWorker();
    const onMsg = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      worker.removeEventListener('message', onMsg);
      if (m.type === 'result') resolve(m.text);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}

async function apiTranscribe(audio) {
  const key = state.settings.groqKey;
  if (!key) throw new Error('Falta la API key de Groq (ábrela en Ajustes).');
  const form = new FormData();
  form.append('file', floatToWav(audio), 'audio.wav');
  form.append('model', state.settings.groqModel || 'whisper-large-v3-turbo');
  form.append('language', 'en');
  form.append('response_format', 'json');
  const res = await fetch(`${groqBaseOf(state.settings)}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${redact(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.text || '';
}

// ---------------------------------------------------------------- serial queue

// What the other speaker says is urgent for following the conversation; your own
// turns can wait. They jump ahead without disturbing the order within each voice.
function enqueue(seg) {
  if (seg.speaker === 'them') {
    const i = state.queue.findIndex((s) => s.speaker === 'me');
    if (i === -1) state.queue.push(seg);
    else state.queue.splice(i, 0, seg);
  } else {
    state.queue.push(seg);
  }
  broadcast({ type: 'QUEUE', pending: state.queue.length + (state.busy ? 1 : 0) });
  drain();
}

const queueIdle = () => !state.busy && state.queue.length === 0;

// The report only analyses the learner's own turns, which are exactly the ones
// the queue defers. Without waiting here, an automatic report would omit them.
async function waitForQueue(timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (!queueIdle() && Date.now() < until) {
    const pending = state.queue.length + (state.busy ? 1 : 0);
    status(`Terminando de transcribir… (${pending} en cola)`, 'loading');
    await new Promise((r) => setTimeout(r, 250));
  }
  return queueIdle();
}

async function drain() {
  if (state.busy || state.queue.length === 0) return;
  state.busy = true;
  const seg = state.queue.shift();
  try {
    const text = state.settings.engine === 'api'
      ? await apiTranscribe(seg.audio)
      : await localTranscribe(seg.audio);
    const clean = (text || '').trim();
    if (!isJunk(clean)) {
      await appendTranscript({
        speaker: seg.speaker,
        text: clean,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
      });
    } else if (seg.speaker === 'them') {
      // A discarded turn also clears the provisional line: otherwise it stays
      // frozen on screen until the other speaker talks again.
      state.live?.reset();
    }
  } catch (e) {
    status('Error transcribiendo: ' + (e.message || e), 'error');
  } finally {
    state.busy = false;
    broadcast({ type: 'QUEUE', pending: state.queue.length + (state.busy ? 1 : 0) });
    drain();
  }
}

// ------------------------------------------------------------------- capture

async function attach(stream, speaker) {
  const src = state.workCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(state.workCtx, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  const seg = new Segmenter(speaker, enqueue, () => Date.now(), {
    minSegMs: Number(state.settings?.minSegMs) || undefined,
  });
  node.port.onmessage = (e) => seg.push(e.data);
  src.connect(node);
  // Silent sink: keeps the graph alive without emitting sound.
  const mute = state.workCtx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(state.workCtx.destination);
  return seg;
}

async function start(streamId, settings, streamKind) {
  if (state.running) return { ok: true };
  state.settings = settings;
  state.queue = [];
  state.seq = 0;
  state.segmenters = [];
  state.streams = [];
  const { transcript = [] } = (await store.get('transcript')) || {};
  state.turns = transcript;

  state.workCtx = new AudioContext({ sampleRate: SR });
  await state.workCtx.audioWorklet.addModule(chrome.runtime.getURL('recorder-worklet.js'));

  // --- the other speaker's audio
  let themStream = null;
  if (settings.themSource === 'tab') {
    if (!streamId) throw new Error('No se obtuvo el id de captura de la pestaña.');
    themStream = await openCaptureStream(streamKind, streamId);
    // Reinject the sound to the speakers: capturing mutes the tab.
    state.playbackCtx = new AudioContext();
    state.playbackCtx.createMediaStreamSource(themStream).connect(state.playbackCtx.destination);
  } else if (settings.themSource === 'device' && settings.themDeviceId) {
    themStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: settings.themDeviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  }

  // --- your microphone
  let micStream = null;
  if (settings.captureMic !== false) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };
    micStream = await navigator.mediaDevices.getUserMedia({ audio });
  }

  if (!themStream && !micStream) throw new Error('No hay ninguna fuente de audio activa.');

  if (themStream && settings.liveTranscript !== false) await startLiveLayer(themStream);

  const segmenters = [];
  if (themStream) { state.streams.push(themStream); segmenters.push(await attach(themStream, 'them')); }
  if (micStream) { state.streams.push(micStream); segmenters.push(await attach(micStream, 'me')); }
  state.segmenters = segmenters;

  for (const s of state.streams) {
    for (const t of s.getTracks()) t.onended = () => stop();
  }

  if (settings.engine !== 'api') {
    status('Cargando modelo local…', 'loading');
    ensureWorker().postMessage({
      type: 'init',
      model: settings.model || 'onnx-community/whisper-base.en',
      device: settings.device || 'webgpu',
      base: chrome.runtime.getURL('vendor/'),
    });
  } else {
    status('Escuchando (Groq API)…', 'ok');
  }

  state.running = true;
  broadcast({ type: 'RUNNING', running: true });
  return { ok: true };
}

// Provisional layer: shows what is being said while Whisper works. The text is in
// English; each interface translates it on its own, because Translator's
// availability inside an offscreen document is undocumented.
async function startLiveLayer(themStream) {
  const estado = await liveAvailability();
  if (estado !== 'available' && estado !== 'unknown') {
    broadcast({ type: 'LIVE_STATE', state: estado });
    return;
  }
  const source = themStream.getAudioTracks()[0];
  if (!source) return;
  // Our own clone: the original already feeds Whisper's audio graph.
  const track = typeof source.clone === 'function' ? source.clone() : source;
  state.liveTrack = track === source ? null : track;
  state.live = startLive({
    track,
    onText: (text) => broadcast({ type: 'PARTIAL', text }),
    onError: (code) => {
      broadcast({ type: 'PARTIAL', text: '' });
      broadcast({ type: 'LIVE_STATE', state: 'error', detail: String(code) });
      stopLiveLayer();
    },
  });
  if (state.live) broadcast({ type: 'LIVE_STATE', state: 'available' });
}

function stopLiveLayer() {
  state.live?.stop();
  state.live = null;
  try { state.liveTrack?.stop(); } catch { /* ya estaba parada */ }
  state.liveTrack = null;
  broadcast({ type: 'PARTIAL', text: '' });
}

async function stop() {
  if (!state.running) return { ok: true };
  state.running = false;
  stopLiveLayer();
  for (const seg of state.segmenters || []) seg.flush();
  for (const s of state.streams) s.getTracks().forEach((t) => t.stop());
  state.streams = [];
  if (state.workCtx) { await state.workCtx.close().catch(() => {}); state.workCtx = null; }
  if (state.playbackCtx) { await state.playbackCtx.close().catch(() => {}); state.playbackCtx = null; }
  broadcast({ type: 'RUNNING', running: false });
  if (coachSettings().autoReport) {
    (async () => {
      await waitForQueue();
      status('Detenido.', 'info');
      makeReport(true);
    })();
  } else {
    waitForQueue().then(() => status('Detenido.', 'info'));
  }
  return { ok: true };
}

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'START') sendResponse(await start(msg.streamId, msg.settings, msg.streamKind));
      else if (msg.type === 'STOP') sendResponse(await stop());
      else if (msg.type === 'SUGGEST_REPLY') sendResponse(await suggestReply());
      else if (msg.type === 'REPORT') sendResponse(await makeReport(false));
      else if (msg.type === 'STATE') sendResponse({ running: state.running, pending: state.queue.length });
      else sendResponse({ ok: false, error: 'Mensaje desconocido' });
    } catch (e) {
      status('Error: ' + (e.message || e), 'error');
      sendResponse({ error: e.message || String(e) });
    }
  })();
  return true;
});

// Settings must be available even if the document was recreated (for example, to
// request the report when no session is running any more).
ensureSettings().catch(() => {});
