// Offscreen document: captures audio (tab + microphone), segments it by voice
// and sends it to be transcribed (local Whisper or the Groq API).

import { Segmenter, floatToWav, isJunk, foldIntoTranscript, SR } from './segmenter.js';
import { openCaptureStream } from './capture.js';
import { askHints, askStarter, askReply, askReport, askDistill, tpmOf, groqBaseOf, redact, resolveProvider, PROVIDERS, DEFAULT_COACH } from './coach.js';
import { sizing, emptyMemory, reconcile, selectChunk, acceptItems, acceptErrors, mergeTopics, Ledger, CAPS, DISTILL_COOLDOWN_MS, mergeLake, emptyLake, confirmedEntries } from './memory.js';
import { buildReplyContext } from './retrieval.js';
import { startLive, liveAvailability } from './live.js';

const HINT_DEBOUNCE_MS = 1200;   // wait in case the other speaker keeps talking
// Soft cuts turn a monologue into a stream of 4-6 s turns, each of which
// schedules hints — the cooldown is what keeps that within Groq's free tier
// (8000 tokens/min): 12 s allows at most 5 rounds a minute (~5.3k tokens),
// leaving room for a suggested reply and even the report in the same minute.
const HINT_COOLDOWN_MS = 12000;
// A preview has to cost less than the interval that schedules it, or the lane
// stops paying for itself: on the WASM fallback a single pass can take seconds,
// and a real segment arriving mid-preview waits for it. Two slow rounds and the
// lane retires for the rest of the session.
const PREVIEW_MAX_MS = 1500;
const PREVIEW_SLOW_ROUNDS = 2;

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
  busyPreview: false,
  previewSlow: 0,
  previewOff: false,
  seq: 0,
  turns: [],
  hintTimer: null,
  hintBusy: false,
  lastHintAt: 0,
  starterBusy: false,
  replyBusy: false,
  live: null,
  liveTrack: null,
  memory: null,
  ledger: new Ledger(() => Date.now()),
  distillBusy: null,
  lastDistillAt: 0,
  lastSkippedAt: 0,
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
  // The broadcast carries the folded turn: its `t` repeats when a turn was
  // extended, and the UIs upsert by (speaker, t) instead of appending.
  const shown = foldIntoTranscript(transcript, entry);
  state.turns = transcript;
  await store.set({ transcript });
  broadcast({ type: 'SEGMENT', entry: shown });
  if (entry.speaker === 'them') { clearPartial(); scheduleHints(); }
  distill().catch(() => {});
}

// Two provisional layers can feed the same line — Web Speech word by word, or a
// throwaway Whisper pass over the phrase in progress — and the authoritative
// segment retires whichever one was showing.
function clearPartial() {
  if (state.live) state.live.reset();
  else broadcast({ type: 'PARTIAL', text: '' });
}

// ---------------------------------------------------------------- coach

function coachSettings() {
  return { ...DEFAULT_COACH, ...(state.settings || {}) };
}

const sortedTurns = () => [...state.turns].sort((a, b) => a.t - b.t);

async function loadMemory() {
  const { memory } = (await store.get('memory')) || {};
  state.memory = reconcile(memory || emptyMemory(state.memory?.sessionId || null), state.turns);
  return state.memory;
}

// Takes the object to persist rather than reading `state.memory`. Two rounds each
// hold their own copy, and a save that reads shared state would write whichever
// copy loaded last — silently discarding the round that is actually finishing.
const saveMemory = (memory) => { state.memory = memory; return store.set({ memory }); };

// The session's errors reach the history once the session is over, so a mistake
// repeated all afternoon still counts as one occurrence.
async function mergeIntoLake() {
  const memory = state.memory;
  // Deliberately NOT gated on memory.merged. A crash-and-resume merges once from
  // start(), and a boolean would then block every error recorded afterwards from
  // ever reaching the lake — not even as a first sighting. mergeLake already
  // dedupes per session, so calling it again is free and lossless.
  if (!memory || !memory.errors.length) return;
  const { lake } = (await store.get('lake')) || {};
  const next = mergeLake(lake || emptyLake(), memory.errors, memory.sessionId, Date.now());
  await store.set({ lake: next });
  memory.merged = true;
  await saveMemory(memory);
}

// Background work, so it yields to everything the learner can see: an in-flight
// reply on every provider, a busy transcription queue, and — only where a
// per-minute budget exists — a hints round.
function distillEligible(settings) {
  // Not distillBusy: by the time this runs the round has already claimed the mutex.
  if (state.replyBusy) return false;
  if (!queueIdle()) return false;
  if (tpmOf(settings) && state.hintBusy) return false;
  if (Date.now() - state.lastDistillAt < DISTILL_COOLDOWN_MS) return false;
  return state.ledger.room(tpmOf(settings), 'distill');
}

async function distill({ force = false } = {}) {
  // The forced flush waits its turn instead of bailing: it is the last chance to
  // distil before the report.
  if (state.distillBusy) {
    if (!force) return false;
    await state.distillBusy.catch(() => {});
  }

  // Claimed here, synchronously, with no await between the check above and this
  // line. Claiming it later — after ensureSettings and loadMemory — would let two
  // calls both pass the check, each load its own copy of the memory, and the
  // second overwrite the first's promise: the very bug the mutex exists to stop.
  let release;
  state.distillBusy = new Promise((r) => { release = r; });
  let memory = null;
  try {
    const settings = await ensureSettings();
    memory = await loadMemory();
    const { chunkChars } = sizing(tpmOf(settings));
    const chunk = selectChunk(state.turns, memory, chunkChars, { all: force });
    if (!chunk) return false;
    if (!force && !distillEligible(settings)) {
      // One skipped round, not one per segment that arrives while it stays skipped:
      // `skipped` divides into the coverage figure the report states out loud.
      if (state.lastSkippedAt !== chunk.endsAt) {
        state.lastSkippedAt = chunk.endsAt;
        memory.skipped++;
        await saveMemory(memory);
      }
      return false;
    }

    state.ledger.spend('distill');
    const raw = await askDistill({ chunk: { ...chunk, carry: memory.carry }, settings });

    const anchor = [...chunk.overlapTurns, ...chunk.turns];
    const topics = acceptItems(raw.topics, anchor);
    const open = acceptItems(raw.open, anchor);
    const errors = acceptErrors(raw.errors, chunk.turns);
    memory.rejected += (raw.topics.length - topics.length)
      + (raw.open.length - open.length)
      + (raw.errors.length - errors.length);

    memory.topics = mergeTopics(memory.topics, topics, CAPS.topics);
    memory.open = mergeTopics(memory.open, open, CAPS.open);
    memory.errors = [...memory.errors, ...errors].slice(-CAPS.errors);
    memory.carry = raw.carry;
    memory.coveredUntil = chunk.endsAt;
    memory.rounds++;
    state.lastDistillAt = Date.now();
    await saveMemory(memory);
    return true;
  } catch {
    // Silent by design: a missing key or a 429 is already surfaced by the hints
    // round, and the reply keeps working on the tail plus literal retrieval.
    // `memory` is null when the throw came from ensureSettings or loadMemory.
    if (memory) { memory.skipped++; await saveMemory(memory).catch(() => {}); }
    return false;
  } finally {
    state.distillBusy = null;
    release();
  }
}

function scheduleHints() {
  if (!coachSettings().liveCoach || !state.running) return;
  clearTimeout(state.hintTimer);
  state.hintTimer = setTimeout(async () => {
    if (state.hintBusy || Date.now() - state.lastHintAt < HINT_COOLDOWN_MS) return;
    state.hintBusy = true;
    try {
      state.ledger.spend('hints');
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

// Opening chips built from the session context alone, before the other person
// has said anything. Fired on start and on a mid-session context edit; once a
// real hints round has painted (lastHintAt), the starter is stale and yields.
// Failures stay silent on purpose: the first real hints round surfaces any key
// or rate-limit problem, and an error toast at every session start would nag.
async function sendStarter() {
  if (!state.running || state.starterBusy) return;
  const settings = await ensureSettings();
  if (!settings.liveCoach || !(settings.sessionContext || '').trim()) return;
  state.starterBusy = true;
  try {
    state.ledger.spend('starter');
    const hints = await askStarter({ settings });
    if (state.running && !state.lastHintAt) broadcast({ type: 'HINTS', ...hints });
  } catch { /* the real hints round will surface a missing key or a rate limit */ }
  finally { state.starterBusy = false; }
}

async function suggestReply() {
  // One request at a time: every click costs Groq tokens, and impatient
  // re-clicks while "Pensando…" is on screen would burn the free minute.
  if (state.replyBusy) return { ok: false, error: 'ya en curso' };
  state.replyBusy = true;
  broadcast({ type: 'REPLY', pending: true });
  try {
    const settings = await ensureSettings();
    const memory = await loadMemory();
    const { tailChars } = sizing(tpmOf(settings));
    const room = state.ledger.room(tpmOf(settings), 'reply')
      ? {}
      : { evidence: false, situation: false };
    const context = buildReplyContext({ turns: sortedTurns(), memory, tailChars, room });
    state.ledger.spend('reply');
    const { answer, ideas } = await askReply({ turns: sortedTurns(), settings, context });
    broadcast({ type: 'REPLY', answer, ideas });
    return { ok: true };
  } catch (e) {
    const error = 'No se pudo sugerir: ' + (e.message || e);
    broadcast({ type: 'REPLY', error });
    return { ok: false, error };
  } finally {
    state.replyBusy = false;
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
    state.ledger.spend('report');
    const { lake } = (await store.get('lake')) || {};
    const markdown = await askReport({
      turns: sortedTurns(),
      settings,
      memory: await loadMemory(),
      recurring: confirmedEntries(lake || emptyLake()),
    });
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
  form.append('language', state.settings.lang === 'es' ? 'es' : 'en');
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
// turns can wait — but not forever. Soft cuts make a monologue produce a 'them'
// segment every few seconds, so an unbounded priority would starve queued 'me'
// turns for as long as the other person keeps talking. Each 'me' segment can be
// overtaken at most MAX_BYPASS times; after that, new 'them' segments queue
// behind it. Order within each voice is never disturbed.
const MAX_BYPASS = 3;

function enqueue(seg) {
  if (seg.speaker === 'them') {
    const i = state.queue.findIndex((s) => s.speaker === 'me' && (s.bypassed || 0) < MAX_BYPASS);
    if (i === -1) state.queue.push(seg);
    else {
      for (let j = i; j < state.queue.length; j++) {
        if (state.queue[j].speaker === 'me') state.queue[j].bypassed = (state.queue[j].bypassed || 0) + 1;
      }
      state.queue.splice(i, 0, seg);
    }
  } else {
    state.queue.push(seg);
  }
  broadcast({ type: 'QUEUE', pending: pendingCount() });
  drain();
}

// Previews are invisible work: counting them would flash "Transcribiendo…" in
// both interfaces every second while the other person is still speaking.
const pendingCount = () =>
  state.queue.filter((s) => !s.preview).length + (state.busy && !state.busyPreview ? 1 : 0);

const queueIdle = () => !state.busy && state.queue.length === 0;

// The provisional lane. It only covers the gap left when Chrome's on-device
// speech recognition is unavailable: while that layer runs it is word by word
// and strictly better, so the two never compete for the same line.
function previewEligible() {
  const s = state.settings || {};
  return state.running
    && !state.previewOff
    && !state.live
    // Before the model is loaded a preview would block on the download and take
    // the real segments hostage behind it — and trip the slowness guard.
    && state.workerReady
    && s.liveTranscript !== false
    // One Groq audio request per preview would exhaust the free tier in minutes.
    // On that engine Web Speech stays the only live source.
    && s.engine !== 'api';
}

function queuePreview(seg) {
  if (!previewEligible()) return;
  // Dropped, never queued: nothing provisional may delay a real turn, so a
  // preview runs only while the engine has nothing else to do.
  if (state.busy || state.queue.length) return;
  state.queue.push({ ...seg, preview: true });
  drain();
}

// The report only analyses the learner's own turns, which are exactly the ones
// the queue defers. Without waiting here, an automatic report would omit them.
async function waitForQueue(timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (!queueIdle() && Date.now() < until) {
    status(`Terminando de transcribir… (${pendingCount()} en cola)`, 'loading');
    await new Promise((r) => setTimeout(r, 250));
  }
  return queueIdle();
}

async function drain() {
  if (state.busy || state.queue.length === 0) return;
  const seg = state.queue.shift();
  // Settings are re-read on every coach call, so the engine can flip to the API
  // mid-session. A preview queued before that must never become a Groq request:
  // the lane is local-only, and provisional audio has no business leaving.
  if (seg.preview && state.settings.engine === 'api') return drain();
  state.busy = true;
  state.busyPreview = !!seg.preview;
  const startedAt = Date.now();
  try {
    const text = state.settings.engine === 'api'
      ? await apiTranscribe(seg.audio)
      : await localTranscribe(seg.audio);
    const clean = (text || '').trim();
    if (seg.preview) {
      if (Date.now() - startedAt > PREVIEW_MAX_MS && ++state.previewSlow >= PREVIEW_SLOW_ROUNDS) {
        state.previewOff = true;
        broadcast({ type: 'LIVE_STATE', state: 'slow', fallback: false });
      }
      // Provisional only: displayed, never stored, never given to the coach.
      if (state.running && !isJunk(clean)) broadcast({ type: 'PARTIAL', text: clean });
    } else if (!isJunk(clean)) {
      await appendTranscript({
        speaker: seg.speaker,
        text: clean,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
      });
    } else if (seg.speaker === 'them') {
      // A discarded turn also clears the provisional line: otherwise it stays
      // frozen on screen until the other speaker talks again.
      clearPartial();
    }
  } catch (e) {
    // A failed preview stays silent: the real segment reports the same problem
    // a moment later, and one toast per second would bury it.
    if (!seg.preview) status('Error transcribiendo: ' + (e.message || e), 'error');
  } finally {
    state.busy = false;
    state.busyPreview = false;
    broadcast({ type: 'QUEUE', pending: pendingCount() });
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
    onPreview: speaker === 'them' ? queuePreview : null,
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
  state.previewSlow = 0;
  state.previewOff = false;
  state.segmenters = [];
  state.streams = [];
  const { transcript = [] } = (await store.get('transcript')) || {};
  state.turns = transcript;
  const stored = (await store.get('memory'))?.memory;
  state.memory = reconcile(stored || emptyMemory(String(Date.now())), state.turns);
  // Chrome can close without a STOP. The previous session's mistakes are still
  // in memory and still unmerged: send them to the history before moving on.
  if (state.memory?.errors?.length && !state.memory.merged) await mergeIntoLake().catch(() => {});
  if (!stored) await saveMemory(state.memory);

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
      lang: settings.lang || 'en',
    });
  } else {
    status('Escuchando (Groq API)…', 'ok');
  }

  state.running = true;
  broadcast({ type: 'RUNNING', running: true });
  sendStarter();
  return { ok: true };
}

// Provisional layer: shows what is being said while Whisper works. The text is in
// English; each interface translates it on its own, because Translator's
// availability inside an offscreen document is undocumented.
async function startLiveLayer(themStream) {
  const lang = state.settings?.lang === 'es' ? 'es-ES' : 'en-US';
  const estado = await liveAvailability(lang);
  if (estado !== 'available' && estado !== 'unknown') {
    broadcast({ type: 'LIVE_STATE', state: estado, fallback: previewFallback() });
    return;
  }
  const source = themStream.getAudioTracks()[0];
  if (!source) return;
  // Our own clone: the original already feeds Whisper's audio graph.
  const track = typeof source.clone === 'function' ? source.clone() : source;
  state.liveTrack = track === source ? null : track;
  state.live = startLive({
    track,
    lang,
    onText: (text) => broadcast({ type: 'PARTIAL', text }),
    onError: (code) => {
      broadcast({ type: 'PARTIAL', text: '' });
      broadcast({ type: 'LIVE_STATE', state: 'error', detail: String(code), fallback: previewFallback() });
      stopLiveLayer();
    },
  });
  broadcast(state.live
    ? { type: 'LIVE_STATE', state: 'available' }
    : { type: 'LIVE_STATE', state: 'unavailable', fallback: previewFallback() });
}

// Whether losing Web Speech actually costs the learner the live line. It does not
// on the local engine: the preview lane still shows English, in ~1 s pieces
// instead of word by word.
const previewFallback = () => (state.settings || {}).engine !== 'api';

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
  // Provisional work is worthless once the session ended, and waitForQueue would
  // otherwise wait on it before the report.
  state.queue = state.queue.filter((s) => !s.preview);
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
      await distill({ force: true }).catch(() => {});
      await mergeIntoLake().catch(() => {});
      status('Detenido.', 'info');
      makeReport(true);
    })();
  } else {
    (async () => {
      await waitForQueue();
      await distill({ force: true }).catch(() => {});
      await mergeIntoLake().catch(() => {});
      status('Detenido.', 'info');
    })();
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
      else if (msg.type === 'CONTEXT_CHANGED') { sendStarter(); sendResponse({ ok: true }); }
      else if (msg.type === 'REPORT') sendResponse(await makeReport(false));
      else if (msg.type === 'STATE') sendResponse({ running: state.running, pending: pendingCount() });
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
