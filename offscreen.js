// Offscreen document: captures audio (tab + microphone), segments it by voice
// and sends it to be transcribed (local Whisper or the Groq API).

import { Segmenter, floatToWav, isJunk, foldIntoTranscript, SR } from './segmenter.js';
import { openCaptureStream } from './capture.js';
import { askReply, askReport, groqBaseOf, redact, resolveProvider, PROVIDERS, DEFAULT_COACH } from './coach.js';
import { startLive, liveAvailability } from './live.js';
import { EMPTY as STITCH_EMPTY, stitch } from './stitch.js';
import { insertPreview, insertReal, takeNext } from './queue.js';
import { detect } from './langid.js';

// A preview has to cost less than the interval that schedules it, or the lane
// stops paying for itself: on the WASM fallback a single pass can take seconds,
// and a real segment arriving mid-preview waits for it. Two slow rounds and the
// lane retires for the rest of the session.
const PREVIEW_MAX_MS = 1500;
const PREVIEW_SLOW_ROUNDS = 2;
// How much real speech Whisper has to transcribe before a silent word-by-word lane
// counts as dead rather than slow to warm up. Retiring a working layer only costs
// the learner word-by-word text; keeping a dead one costs them every live line.
const LIVE_PROOF_MS = 6000;
// Below this, langid.js saw mixed evidence — an English sentence carrying a Spanish
// name, say — and switching a speaker's language on that would be worse than
// keeping the one that is working.
const LANG_CONFIDENCE = 0.5;

const state = {
  running: false,
  paused: false,
  settings: null,
  themStream: null,
  playbackCtx: null,
  workCtx: null,
  streams: [],
  worker: null,
  workerReady: false,
  // Set only on an actual load/runtime failure, distinct from workerReady being
  // merely not-yet-true during a legitimate first-run download.
  workerFailed: false,
  queue: [],
  // One segment in flight per resource. A Whisper pass on the GPU and a request to
  // Groq do not wait on each other, so on the API engine the archive and the live
  // line each get their own lane; on the local engine both are the same lane.
  inFlight: { local: null, api: null },
  // The startedAt of the last authoritative piece finished per speaker. With two
  // lanes a preview of that piece can land after its turn did, and it would repaint
  // the line the turn just cleared.
  realDone: { them: 0, me: 0 },
  // Per lane. Slowness is really a property of the shared engine, not of a voice,
  // so which lane draws the slow pass is partly luck — and one shared counter
  // meant one voice's bad luck silenced the other's live line too, which is the
  // one thing this feature may never do.
  previewSlow: { them: 0, me: 0 },
  previewOff: { them: false, me: false },
  seq: 0,
  turns: [],
  session: 0,
  replyBusy: false,
  live: null,
  liveTrack: null,
  liveHeard: false,
  liveSilentMs: 0,
  // The last kind sent to LIVE_STATE, replayed by rebroadcastLiveState() when a
  // later worker failure makes an earlier broadcast's `fallback` wrong.
  liveState: null,
  stitch: { them: STITCH_EMPTY, me: STITCH_EMPTY },
  // Which piece each speaker's stitched line belongs to, by its startedAt. The
  // segmenter opens a new piece at every cut; its first preview must start from
  // nothing or it inherits the previous piece's committed prefix.
  pieceStart: { them: 0, me: 0 },
  // The language each speaker is currently being transcribed in. Whisper has to be
  // told a language before it decodes, so this is what a preview is decoded with;
  // an authoritative turn is what corrects it (Groq detects the language itself,
  // and on the local engine langid.js decides whether a re-pass is warranted).
  lang: { them: 'en', me: 'en' },
  // Which language the accumulated line was decoded in, so a switch discards it
  // rather than appending across two languages.
  stitchLang: { them: 'en', me: 'en' },
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

// LIVE_STATE describes a condition that holds for the whole session (message
// contract rule 11), so unlike STATUS its last kind is worth keeping: a later
// correction can replay it with a fixed `fallback` instead of inventing a new one.
function broadcastLiveState(kind, extra = {}) {
  state.liveState = kind;
  broadcast({ type: 'LIVE_STATE', state: kind, ...extra });
}

async function appendTranscript(entry) {
  const { transcript = [] } = (await store.get('transcript')) || {};
  // The broadcast carries the folded turn: its `t` repeats when a turn was
  // extended, and the UIs upsert by (speaker, t) instead of appending.
  const shown = foldIntoTranscript(transcript, entry);
  state.turns = transcript;
  await store.set({ transcript });
  broadcast({ type: 'SEGMENT', entry: shown });
}

// The phrase ended: blank that speaker's live line. Only then — on a mid-speech
// cut the line stays standing until the next piece's preview replaces it, because
// blanking text under someone who is still talking is exactly the disappearing
// line this lane exists to prevent.
function clearPartial(speaker) {
  state.stitch[speaker] = STITCH_EMPTY;
  if (speaker === 'them' && state.live) state.live.reset();
  else broadcast({ type: 'PARTIAL', speaker, text: '', committed: '', lang: state.lang[speaker] });
}

// ---------------------------------------------------------------- coach

function coachSettings() {
  return { ...DEFAULT_COACH, ...(state.settings || {}) };
}

const sortedTurns = () => [...state.turns].sort((a, b) => a.t - b.t);

async function suggestReply() {
  // One request at a time: every click costs Groq tokens, and impatient
  // re-clicks while "Pensando…" is on screen would burn the free minute.
  if (state.replyBusy) return { ok: false, error: 'ya en curso' };
  state.replyBusy = true;
  broadcast({ type: 'REPLY', pending: true });
  try {
    const { answer, ideas } = await askReply({ turns: sortedTurns(), settings: await ensureSettings() });
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

const isApiEngine = () => (state.settings || {}).engine === 'api';

// On the local engine the model IS the engine: a failed load ends the session and
// says so in red. On the API engine the model only draws the live line — Groq
// keeps transcribing real turns whether or not this ever loads — so the identical
// failure must read as that one lane degrading, never as the session having died.
// previewFallback() is what tells the UI the lane is actually gone.
function failWorker(detail, stage) {
  const wasFailed = state.workerFailed;
  state.workerFailed = true;
  if (isApiEngine()) status(`Sin línea en vivo: ${detail} · escuchando con Groq`, 'info');
  else status(`Error del ${stage}: ${detail}`, 'error');
  // The broadcast that told the UI Web Speech was down may have gone out with
  // fallback: true before this failure existed; that promise is now false.
  if (!wasFailed) rebroadcastLiveState();
}

function ensureWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      status(`Descargando modelo ${m.file || ''} ${m.progress ? Math.round(m.progress) + '%' : ''}`, 'loading');
    } else if (m.type === 'ready') {
      state.workerReady = true;
      // The worker retries a failed load after a cooldown; a later success clears
      // the failure this session already reported.
      state.workerFailed = false;
      status(isApiEngine()
        ? `Línea en vivo lista (${m.device}). Escuchando con Groq…`
        : `Modelo listo (${m.device}). Escuchando…`, 'ok');
    } else if (m.type === 'error') {
      // Every worker message reaches this listener and, when it carries an id,
      // localTranscribe's own per-request listener below as well. A transcribe
      // failure has that id and already reaches the user as that one segment's
      // "Error transcribiendo" (drain's catch) — only a load failure, which has
      // none, is a failure of the worker itself.
      if (m.id == null) failWorker(m.message, 'modelo');
    }
  };
  worker.onerror = (e) => failWorker(e.message || 'desconocido', 'worker');
  state.worker = worker;
  return worker;
}

function localTranscribe(audio, lang) {
  return new Promise((resolve, reject) => {
    const id = ++state.seq;
    const worker = ensureWorker();
    const onMsg = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      // Only a terminal message retires the listener. Dropping it before the type
      // is known costs nothing today — the worker sends exactly one result or one
      // error per id — but the day it also sends something non-terminal for this
      // id (a streamed partial, a per-pass progress note), that message would
      // deregister the listener and the real result would land on nobody: the
      // promise never settles, `state.inFlight[lane]` never clears, and that lane
      // stops for the rest of the session. A silent, total stall is too expensive
      // to leave resting on a message shape nobody has any reason to preserve.
      if (m.type !== 'result' && m.type !== 'error') return;
      worker.removeEventListener('message', onMsg);
      if (m.type === 'result') resolve(m.text);
      else reject(new Error(m.message));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'transcribe', id, audio, lang }, [audio.buffer]);
  });
}

async function apiTranscribe(audio) {
  const key = state.settings.groqKey;
  if (!key) throw new Error('Falta la API key de Groq (ábrela en Ajustes).');
  const multi = state.settings.lang === 'multi';
  const form = new FormData();
  form.append('file', floatToWav(audio), 'audio.wav');
  form.append('model', state.settings.groqModel || 'whisper-large-v3-turbo');
  // In a bilingual meeting the language is the question, not an input: omitting it
  // is what makes Whisper detect it, and it costs nothing extra — the price is per
  // hour of audio either way. A single-language session keeps pinning it, which the
  // API documents as better for accuracy and latency.
  if (!multi) form.append('language', state.settings.lang === 'es' ? 'es' : 'en');
  // verbose_json is where a detected language can come back. It is not promised, so
  // the caller falls back to langid.js.
  form.append('response_format', multi ? 'verbose_json' : 'json');
  const res = await fetch(`${groqBaseOf(state.settings)}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${redact(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const reported = typeof data.language === 'string' ? data.language.toLowerCase() : '';
  // Whisper names languages in English words ("spanish"), not codes.
  const detected = /^(es|spa|spanish|castilian|español)$/.test(reported) ? 'es'
    : /^(en|eng|english|inglés)$/.test(reported) ? 'en'
    : null;
  return { text: data.text || '', lang: detected };
}

// ---------------------------------------------------------------- serial queue

// Ordering lives in queue.js, where it is testable. The one rule that matters
// here: the live line outranks the archive, so previews go ahead of queued real
// segments — a turn landing in its bubble a beat later costs the learner nothing,
// a live line that freezes while someone talks costs them the conversation.
function enqueue(seg) {
  insertReal(state.queue, seg);
  broadcast({ type: 'QUEUE', pending: pendingCount() });
  drain();
}

// Previews are invisible work: counting them would flash "Transcribiendo…" in
// both interfaces every second while the other person is still speaking.
const pendingCount = () =>
  state.queue.filter((s) => !s.preview).length
  + Object.values(state.inFlight).filter((s) => s && !s.preview).length;

const queueIdle = () => state.queue.length === 0 && !state.inFlight.local && !state.inFlight.api;

// The provisional lane, per speaker. Web Speech, while it lives, covers the other
// speaker's line word by word and strictly better — but it never hears the
// microphone, so the learner's own lane stays on regardless.
// The lane is local whatever the engine: a preview is provisional audio, so sending
// it to Groq would both leak speech still being spoken and exhaust the free tier's
// request budget in minutes. Keeping it local is what lets the engine setting govern
// authoritative turns alone.
function previewEligible(speaker) {
  const s = state.settings || {};
  return state.running
    && !state.previewOff[speaker]
    && !(speaker === 'them' && state.live)
    // Before the model is loaded a preview would block on the download and take
    // the real segments hostage behind it — and trip the slowness guard.
    && state.workerReady
    && s.liveTranscript !== false;
}

function queuePreview(seg) {
  if (!previewEligible(seg.speaker)) return;
  insertPreview(state.queue, seg);
  drain();
}

// Whether any voice in this session still has a live line at all: Web Speech covers
// 'them' while it runs, the preview lane covers either. The 'slow' notice speaks for
// the session, so it may only fire once nothing is left — announcing that there is
// no live transcription while the other voice still has one would read as a broken
// extension to someone watching text appear.
const anyLiveLaneLeft = () => (state.segmenters || [])
  .some((s) => (s.speaker === 'them' && !!state.live) || previewEligible(s.speaker));

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

// Which resource transcribes a segment: previews are local on every engine, and
// authoritative turns go to the network on the API engine.
const laneOf = (seg) => (!seg.preview && isApiEngine() ? 'api' : 'local');

function drain() {
  for (const lane of ['local', 'api']) {
    if (state.inFlight[lane]) continue;
    const seg = takeNext(state.queue, (s) => laneOf(s) === lane);
    if (!seg) continue;
    state.inFlight[lane] = seg;
    transcribe(seg, lane);
  }
}

async function transcribe(seg, lane) {
  const startedAt = Date.now();
  try {
    const result = lane === 'api'
      ? await apiTranscribe(seg.audio)
      : { text: await localTranscribe(seg.audio, state.lang[seg.speaker]), lang: null };
    const clean = (result.text || '').trim();
    if (seg.preview) {
      // Consecutive rounds, which is what the constant has always claimed. Counting
      // cumulatively meant two slow passes twenty minutes apart retired the lane.
      if (Date.now() - startedAt > PREVIEW_MAX_MS) {
        if (++state.previewSlow[seg.speaker] >= PREVIEW_SLOW_ROUNDS) {
          state.previewOff[seg.speaker] = true;
          if (!anyLiveLaneLeft()) broadcastLiveState('slow', { fallback: false });
        }
      } else {
        state.previewSlow[seg.speaker] = 0;
      }
      // Provisional only: displayed, never stored, never given to the coach.
      // Successive passes are overlapping re-transcriptions of the same speech, not
      // pieces to swap in. Stitched, the line grows and only its tail can change.
      // Not while paused: a pass that was in flight when the pause landed would
      // otherwise repaint the line pause() just blanked. Not for a piece whose turn
      // already landed: the other lane got there first.
      if (state.running && !state.paused && !isJunk(clean)
        && seg.startedAt > state.realDone[seg.speaker]) {
        if (state.pieceStart[seg.speaker] !== seg.startedAt
          || state.stitchLang[seg.speaker] !== state.lang[seg.speaker]) {
          // First preview of a new piece — or of a new language for this speaker.
          // Either way the accumulated line cannot be built on: its words were
          // decoded under a rule that no longer applies.
          state.stitch[seg.speaker] = STITCH_EMPTY;
          state.pieceStart[seg.speaker] = seg.startedAt;
          state.stitchLang[seg.speaker] = state.lang[seg.speaker];
        }
        const out = stitch(state.stitch[seg.speaker], clean);
        state.stitch[seg.speaker] = out.state;
        broadcast({
          type: 'PARTIAL',
          speaker: seg.speaker,
          text: `${out.committed} ${out.tail}`.trim(),
          committed: out.committed,
          lang: state.lang[seg.speaker],
        });
      }
    } else if (!isJunk(clean)) {
      if (seg.speaker === 'them' && state.live && !state.liveHeard) {
        state.liveSilentMs += seg.durationMs || 0;
        if (state.liveSilentMs >= LIVE_PROOF_MS) retireSilentLiveLayer();
      }
      // What the engine detected outranks what langid.js reads off the text, and both
      // outrank the sticky value. This is also what the next preview is decoded with,
      // so the live line follows a speaker's switch within one turn.
      const read = detect(clean);
      const turnLang = result.lang
        || (read.confidence >= LANG_CONFIDENCE ? read.lang : null);
      if (turnLang) state.lang[seg.speaker] = turnLang;
      await appendTranscript({
        speaker: seg.speaker,
        text: clean,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
        lang: state.lang[seg.speaker],
      });
      // An open cut means the speaker never paused: their line stays on screen and
      // the next piece's preview replaces it. Web Speech is the exception — its
      // accumulated results now live in the bubble, and without a reset the line
      // would repeat them and keep growing for the rest of the monologue.
      if (!seg.open || (seg.speaker === 'them' && state.live)) clearPartial(seg.speaker);
    } else if (!seg.open) {
      // A discarded closing turn also clears the provisional line: otherwise it
      // stays frozen on screen until that speaker talks again.
      clearPartial(seg.speaker);
    }
    if (!seg.preview) state.realDone[seg.speaker] = Math.max(state.realDone[seg.speaker], seg.startedAt);
  } catch (e) {
    // A failed preview stays silent: the real segment reports the same problem
    // a moment later, and one toast per second would bury it.
    if (!seg.preview) status('Error transcribiendo: ' + (e.message || e), 'error');
  } finally {
    state.inFlight[lane] = null;
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
    // Both voices get a live line: the learner watching their own words appear is
    // the feedback loop this extension exists for, not a nicety.
    onPreview: queuePreview,
    // Consulted before the audio is copied, so a refusal costs nothing and does not
    // spend the phrase's next preview slot.
    canPreview: () => previewEligible(speaker),
  });
  // Pausing drops the audio here rather than tearing the capture down. Chrome only
  // grants tab audio on a user invocation (the action icon, a command, the context
  // menu), so a Reanudar button in the page could never get the stream back.
  node.port.onmessage = (e) => { if (!state.paused) seg.push(e.data); };
  src.connect(node);
  // Silent sink: keeps the graph alive without emitting sound.
  const mute = state.workCtx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(state.workCtx.destination);
  return seg;
}

const RESUME_WINDOW_MS = 3 * 60 * 1000;

async function start(streamId, settings, streamKind) {
  if (state.running) return { ok: true };
  state.settings = settings;
  state.queue = [];
  state.seq = 0;
  state.inFlight = { local: null, api: null };
  state.realDone = { them: 0, me: 0 };
  state.previewSlow = { them: 0, me: 0 };
  state.previewOff = { them: false, me: false };
  state.workerFailed = false;
  state.liveState = null;
  state.stitch = { them: STITCH_EMPTY, me: STITCH_EMPTY };
  state.pieceStart = { them: 0, me: 0 };
  const sessionLang = settings.lang === 'es' ? 'es' : 'en';
  state.lang = { them: sessionLang, me: sessionLang };
  state.stitchLang = { them: sessionLang, me: sessionLang };
  state.segmenters = [];
  state.streams = [];
  // A stopped session is finished: its transcript must not become the opening of
  // the next one, or the report analyses two conversations as if they were one.
  // Only a restart inside the window resumes — stopping by accident, or pausing
  // while someone walked into the room.
  const { transcript = [], stoppedAt = 0 } = (await store.get(['transcript', 'stoppedAt'])) || {};
  const resume = stoppedAt > 0 && Date.now() - stoppedAt <= RESUME_WINDOW_MS;
  state.session = Date.now();
  state.turns = resume ? transcript : [];
  // Persisted, not only broadcast: the overlay is re-injected on every tab switch
  // and reload, and asks for the session with UI_SYNC rather than a RUNNING it missed.
  await store.set(resume ? { startedAt: state.session } : { startedAt: state.session, transcript: [] });

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
  if (themStream) { state.streams.push(themStream); state.themStream = themStream; segmenters.push(await attach(themStream, 'them')); }
  if (micStream) { state.streams.push(micStream); segmenters.push(await attach(micStream, 'me')); }
  state.segmenters = segmenters;

  for (const s of state.streams) {
    for (const t of s.getTracks()) t.onended = () => stop();
  }

  // The model is what draws the live line, so it loads on both engines now. On the
  // API engine Groq is what makes the session work, so it is 'ok' the instant
  // capture is running rather than waiting on the worker's 'ready' — which would
  // report a working Groq session as stuck loading, or as failed outright if the
  // download never completes.
  if (settings.engine === 'api') status('Escuchando (Groq API)…', 'ok');
  // On the API engine with the live line switched off, nothing downstream ever
  // reads the model's output, so loading it would only spend the download.
  if (settings.engine !== 'api' || settings.liveTranscript !== false) {
    if (settings.engine !== 'api') status('Cargando modelo local…', 'loading');
    ensureWorker().postMessage({
      type: 'init',
      model: settings.model || 'onnx-community/whisper-base.en',
      device: settings.device || 'webgpu',
      base: chrome.runtime.getURL('vendor/'),
      lang: settings.lang || 'en',
    });
  }

  state.running = true;
  state.paused = false;
  broadcast({ type: 'RUNNING', running: true, session: state.session });
  broadcast({ type: 'PAUSED', paused: false });
  return { ok: true };
}

// Provisional layer: shows what is being said while Whisper works. The text is in
// English; each interface translates it on its own, because Translator's
// availability inside an offscreen document is undocumented.
async function startLiveLayer(themStream) {
  state.liveHeard = false;
  state.liveSilentMs = 0;
  // A recogniser listens for one language. In a bilingual meeting it would hear
  // half the room and mis-transcribe the other half, so the Whisper preview lane —
  // which decodes whichever language the speaker's turn is in — covers both.
  if (state.settings?.lang === 'multi') {
    broadcastLiveState('unavailable', { fallback: previewFallback() });
    return;
  }
  const lang = state.settings?.lang === 'es' ? 'es-ES' : 'en-US';
  const estado = await liveAvailability(lang);
  if (estado !== 'available' && estado !== 'unknown') {
    broadcastLiveState(estado, { fallback: previewFallback() });
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
    onText: (text) => {
      if (text) state.liveHeard = true;
      broadcast({ type: 'PARTIAL', speaker: 'them', text, lang: state.lang.them });
    },
    onError: (code) => {
      broadcast({ type: 'PARTIAL', speaker: 'them', text: '', lang: state.lang.them });
      broadcastLiveState('error', { detail: String(code), fallback: previewFallback() });
      stopLiveLayer();
    },
  });
  if (state.live) broadcastLiveState('available');
  else broadcastLiveState('unavailable', { fallback: previewFallback() });
}

// Web Speech can report itself available and then never emit a single word — the
// open macOS bug does exactly that. Nothing downstream notices, because
// previewEligible() reads a live object as proof the word-by-word lane works and
// keeps the Whisper fallback disabled, so the learner gets no live text at all and
// no warning either. Whisper having just transcribed real speech is the evidence
// that settles it: somebody spoke, and the other lane produced nothing.
function retireSilentLiveLayer() {
  if (!state.live || state.liveHeard) return;
  stopLiveLayer();
  broadcastLiveState('error', { detail: 'no devolvió texto', fallback: previewFallback() });
}

// Whether losing Web Speech actually costs the learner the live line. It does not,
// unless the preview lane itself is off, retired, or its worker never came up —
// the lane is local on every engine now, but only once it is real. workerReady
// alone would be the wrong signal here: it reads false during a legitimate
// first-run download too, which is not a failure.
const previewFallback = () =>
  (state.settings || {}).liveTranscript !== false && !state.previewOff.them && !state.workerFailed;

// The LIVE_STATE broadcasts above compute `fallback` from the worker's fate at
// that instant. A failure arriving afterward makes an already-sent broadcast
// wrong — promising Whisper text that will never arrive — so replay its kind
// with a corrected fallback. Only when it would change anything shown: once Web
// Speech is covering 'them' the preview lane's state is moot.
function rebroadcastLiveState() {
  if (!state.running || state.live) return;
  broadcastLiveState(state.liveState || 'unavailable', { fallback: previewFallback() });
}

function stopLiveLayer() {
  state.live?.stop();
  state.live = null;
  try { state.liveTrack?.stop(); } catch { /* ya estaba parada */ }
  state.liveTrack = null;
  broadcast({ type: 'PARTIAL', speaker: 'them', text: '', lang: state.lang.them });
}

// Pause is not a small stop: the session, the streams and the invocation all stay
// alive, and no report is written. Only the audio stops reaching the segmenters.
async function pause() {
  if (!state.running || state.paused) return { ok: true };
  state.paused = true;
  // Close the phrase in flight instead of letting it merge with whatever gets said
  // after the resume, which would produce one turn spanning the gap.
  for (const seg of state.segmenters || []) seg.flush();
  stopLiveLayer();
  // Provisional work must not outlive the pause: a queued preview would repaint
  // the line this is about to blank. One already in flight is caught in drain.
  state.queue = state.queue.filter((s) => !s.preview);
  // A flushed stub too short to become a segment never reaches drain, so nothing
  // downstream would blank a line it left frozen.
  clearPartial('them');
  clearPartial('me');
  broadcast({ type: 'PAUSED', paused: true });
  status('En pausa. La sesión sigue abierta.', 'info');
  return { ok: true };
}

async function resume() {
  if (!state.running || !state.paused) return { ok: true };
  state.paused = false;
  broadcast({ type: 'PAUSED', paused: false });
  status('');
  // A fresh clone of the same live stream: stopLiveLayer stopped the previous one.
  if (state.themStream) startLiveLayer(state.themStream).catch(() => {});
  return { ok: true };
}

async function stop() {
  if (!state.running) return { ok: true };
  state.running = false;
  state.paused = false;
  state.themStream = null;
  await store.set({ stoppedAt: Date.now() });
  // Provisional work is worthless once the session ended, and waitForQueue would
  // otherwise wait on it before the report.
  state.queue = state.queue.filter((s) => !s.preview);
  stopLiveLayer();
  for (const seg of state.segmenters || []) seg.flush();
  for (const s of state.streams) s.getTracks().forEach((t) => t.stop());
  state.streams = [];
  if (state.workCtx) { await state.workCtx.close().catch(() => {}); state.workCtx = null; }
  if (state.playbackCtx) { await state.playbackCtx.close().catch(() => {}); state.playbackCtx = null; }
  broadcast({ type: 'RUNNING', running: false, session: state.session });
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
      else if (msg.type === 'PAUSE') sendResponse(await pause());
      else if (msg.type === 'RESUME') sendResponse(await resume());
      else if (msg.type === 'SUGGEST_REPLY') sendResponse(await suggestReply());
      else if (msg.type === 'REPORT') sendResponse(await makeReport(false));
      else if (msg.type === 'STATE') sendResponse({ running: state.running, paused: state.paused, pending: pendingCount() });
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
