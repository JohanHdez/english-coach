import { DEFAULT_COACH, CONTEXT_MAX_CHARS } from './coach.js';
import { toSpanish } from './translate.js';
import { installLive } from './live.js';
import { resolveChips, toggleNoteOpen } from './phrasebook.js';

const $ = (id) => document.getElementById(id);

const els = {
  dot: $('dot'), toggle: $('toggle'), status: $('status'), transcript: $('transcript'),
  lang: $('lang'),
  themSource: $('themSource'), themDevice: $('themDevice'), deviceField: $('deviceField'),
  captureMic: $('captureMic'), settings: $('settings'), sessionContext: $('sessionContext'),
  coach: $('coach'), askReply: $('askReply'),
  phrases: $('phrases'), notes: $('notes'),
  replyBox: $('replyBox'), replyStatus: $('replyStatus'),
  replyAnswer: $('replyAnswer'), replyIdeas: $('replyIdeas'),
  report: $('report'), analyze: $('analyze'), download: $('download'), clear: $('clear'),
  openWindow: $('openWindow'),
  partial: $('partial'), partialEn: $('partialEn'), partialEs: $('partialEs'),
  liveNote: $('liveNote'), liveNoteText: $('liveNoteText'), liveNoteAction: $('liveNoteAction'),
};

let running = false;
let entries = [];
let settings = { ...DEFAULT_COACH };

const PROMPT = `Eres un coach de inglés. Abajo está la transcripción de una conversación real.
"Yo" es quien practica (español nativo); "Interlocutor" es la otra persona.

Analiza SOLO mis intervenciones y dame:
1. Errores de gramática y por qué, con la versión corregida.
2. Vocabulario y expresiones que sonaron poco naturales, con la alternativa nativa.
3. Muletillas, repeticiones y frases traducidas literalmente del español.
4. 5 frases clave que debería memorizar para esta situación.
5. Una nota de nivel aproximado (CEFR) y qué practicar esta semana.

Transcripción:
`;

const fmtTime = (t) => new Date(t).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sorted = () => [...entries].sort((a, b) => a.t - b.t);
// In a Spanish session the learner is the native speaker: nothing to translate.
const traducir = () => settings.translate !== false && settings.lang !== 'es';

function render() {
  els.transcript.innerHTML = '';
  if (!entries.length) {
    els.transcript.innerHTML = '<p class="empty">Aquí aparecerá la conversación transcrita.</p>';
    return;
  }
  for (const e of sorted()) {
    const div = document.createElement('div');
    div.className = 'bubble ' + (e.speaker === 'me' ? 'me' : 'them');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${e.speaker === 'me' ? 'Yo' : 'Interlocutor'} · ${fmtTime(e.t)}`;
    const p = document.createElement('span');
    p.textContent = e.text;
    div.append(meta, p);
    if (e.speaker !== 'me' && traducir()) {
      const es = document.createElement('span');
      es.className = 'es';
      div.append(es);
      // The translation is cached on the entry: render() rebuilds the DOM on every
      // new turn, and the promise would resolve onto an already-detached node.
      if (e.es) es.textContent = e.es;
      else toSpanish(e.text).then((txt) => { if (txt) { e.es = txt; es.textContent = txt; } });
    }
    els.transcript.append(div);
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

const toMarkdown = () => sorted()
  .map((e) => `**${e.speaker === 'me' ? 'Yo' : 'Interlocutor'}** (${fmtTime(e.t)}): ${e.text}`)
  .join('\n\n');

function setStatus(text, kind = 'info') {
  els.status.textContent = text;
  els.status.className = 'status ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
}

function setRunning(v) {
  running = v;
  els.dot.classList.toggle('on', v);
  els.toggle.textContent = v ? '■ Detener' : '● Empezar';
  els.toggle.classList.toggle('stop', v);
  // Mid-session the language cannot change: the Whisper model is already loaded.
  els.lang.disabled = v;
  els.themSource.disabled = v;
  els.themDevice.disabled = v;
  els.captureMic.disabled = v;
  syncCoach();
}

// The two halves of the coach answer to different things. The lanes are settings,
// so they show with no session at all; resolveChips already empties them when
// liveCoach is off, which is why their visibility is read off their own content
// instead of a second copy of that rule. The reply needs a running session —
// exactly how the overlay gates it on .card.idle — so the panel, the floating
// window and the page overlay agree about what is on screen when.
function syncCoach() {
  const lanes = els.phrases.childElementCount > 0 || els.notes.childElementCount > 0;
  els.askReply.hidden = !running;
  if (!running) els.replyBox.hidden = true;
  els.coach.hidden = !(lanes || running);
}

// ------------------------------------------------------------------- coach

// Phrases need no interaction: they are there to be glanced at mid-sentence.
// Notes are collapsed but remember their state, so the learner opens "Mi daily"
// before the meeting and never has to click while the other person waits.
function showChips({ phrases = [], notes = [] }) {
  els.phrases.textContent = '';
  for (const p of phrases) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const en = document.createElement('b');
    en.textContent = p.en;
    chip.append(en);
    if (p.es) {
      const es = document.createElement('span');
      es.textContent = ' · ' + p.es;
      chip.append(es);
    }
    els.phrases.append(chip);
  }

  els.notes.textContent = '';
  for (const n of notes) {
    const item = document.createElement('div');
    item.className = 'note';
    const head = document.createElement('button');
    head.className = 'note-head';
    head.type = 'button';
    head.textContent = (n.open ? '▾ ' : '▸ ') + (n.title || 'Nota');
    const body = document.createElement('p');
    body.className = 'note-body';
    body.textContent = n.body;
    body.hidden = !n.open;
    head.addEventListener('click', () => toggleNote(n.id));
    item.append(head, body);
    els.notes.append(item);
  }
  syncCoach();
}

async function toggleNote(id) {
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: toggleNoteOpen(stored, id) });
  // No re-render here: the write trips storage.onChanged in background.js, which
  // re-broadcasts COACH_CHIPS to all three views at once.
}

// What the learner loses when Chrome's on-device recognition is missing depends
// on whether the Whisper preview lane can stand in: with it there is still live
// English, in ~1 s pieces instead of word by word. Saying "sin transcripción en
// vivo" while text is in fact appearing would just read as a broken extension.
function liveNotice({ state: st, detail, fallback }) {
  if (!st || st === 'available' || st === 'unknown') return '';
  if (st === 'downloading') return 'Descargando el paquete de idioma…';
  const porque = {
    unsupported: 'este Chrome no lo expone donde graba la extensión',
    unavailable: 'el reconocimiento local no está disponible aquí',
    downloadable: 'falta el paquete de idioma',
    slow: 'este equipo transcribe demasiado despacio',
    error: detail ? `falló el reconocimiento local (${detail})` : 'falló el reconocimiento local',
  }[st] || 'el reconocimiento local no está disponible aquí';
  return fallback
    ? `En vivo con Whisper, no palabra por palabra: ${porque}.`
    : `Sin transcripción en vivo: ${porque}.`;
}

function showLiveNote(msg) {
  const texto = msg ? liveNotice(msg) : '';
  els.liveNoteText.textContent = texto;
  els.liveNote.hidden = !texto;
  els.liveNoteAction.hidden = !texto || msg.state !== 'downloadable';
}

// The pack installs from here rather than from Ajustes: this is the moment the
// learner notices it is missing, and install() wants a user gesture.
els.liveNoteAction.addEventListener('click', async () => {
  els.liveNoteAction.disabled = true;
  els.liveNoteText.textContent = 'Descargando el paquete de idioma…';
  const ok = await installLive(settings.lang === 'es' ? 'es-ES' : 'en-US');
  els.liveNoteAction.disabled = false;
  els.liveNoteAction.hidden = ok;
  els.liveNoteText.textContent = ok
    ? 'Paquete instalado: la transcripción palabra por palabra entra en la próxima sesión.'
    : 'No se pudo instalar el paquete de idioma.';
});

// Provisional text from the live layer. A debounce would reset on every interim
// word and never fire while the speaker keeps talking, so this throttles: one
// translation per second at most, always of the latest text, applied in order.
let partialTimer = null;
let partialTrAt = 0;
let partialTrSeq = 0;
let partialTrShown = 0;
const PARTIAL_TR_MS = 1000;

function showPartial(text) {
  if (!els.partial) return;
  clearTimeout(partialTimer);
  if (!text) {
    // A late toSpanish resolution must not paint the previous phrase's Spanish
    // under the next phrase's English: invalidate everything in flight.
    partialTrShown = ++partialTrSeq;
    els.partial.hidden = true;
    els.partialEn.textContent = '';
    els.partialEs.textContent = '';
    return;
  }
  els.partial.hidden = false;
  els.partialEn.textContent = text;
  if (!traducir()) return;
  const wait = Math.max(0, PARTIAL_TR_MS - (Date.now() - partialTrAt));
  partialTimer = setTimeout(() => {
    partialTrAt = Date.now();
    const id = ++partialTrSeq;
    toSpanish(els.partialEn.textContent).then((txt) => {
      if (txt && id > partialTrShown) { partialTrShown = id; els.partialEs.textContent = txt; }
    });
  }, wait);
}

// The answer's **key term** arrives marked in double asterisks: rendered bold,
// stripped when copying. Everything goes in via createElement, never innerHTML.
function richText(el, text) {
  String(text).split('**').forEach((part, i) => {
    if (!part) return;
    if (i % 2) { const b = document.createElement('b'); b.textContent = part; el.append(b); }
    else el.append(document.createTextNode(part));
  });
}

// One click copies the phrase: mid-conversation there is no time to select text
// with the mouse.
function fillGroup(box, items, rich = false) {
  const list = box.querySelector('.reply-list');
  list.innerHTML = '';
  box.hidden = !items.length;
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'reply-item small';
    if (rich) {
      const en = document.createElement('span');
      en.className = 'rich';
      richText(en, item.en);
      btn.append(en);
    } else {
      const en = document.createElement('b');
      en.textContent = item.en.replace(/\*\*/g, '');
      btn.append(en);
    }
    if (item.es) {
      const es = document.createElement('i');
      es.textContent = item.es;
      btn.append(es);
    }
    btn.addEventListener('click', async () => {
      const texto = item.en.replace(/\*\*/g, '');
      await navigator.clipboard.writeText(texto);
      btn.classList.add('copied');
      setStatus('Copiado: ' + texto, 'ok');
    });
    list.append(btn);
  }
}

function showReply({ answer = [], ideas = [], pending = false, error = '' } = {}) {
  const aviso = pending ? 'Pensando…' : error;
  els.replyStatus.textContent = aviso;
  els.replyStatus.hidden = !aviso;
  fillGroup(els.replyAnswer, pending || error ? [] : answer, true);
  fillGroup(els.replyIdeas, pending || error ? [] : ideas);
  els.replyBox.hidden = false;
  // syncCoach has the last word: a reply that lands after the session ended must
  // not reopen the section, or the panel would show what the overlay hides.
  syncCoach();
}

// The heavy lifting lives in the offscreen document: the panel only asks and paints.
const suggestReply = () => chrome.runtime.sendMessage({ type: 'SUGGEST_REPLY' });

async function generateReport() {
  if (!entries.length) { setStatus('Todavía no hay conversación que analizar.', 'error'); return; }
  setStatus('Generando informe…');
  const res = await chrome.runtime.sendMessage({ type: 'REPORT' });
  if (res && res.error) setStatus(res.error, 'error');
}

// ------------------------------------------------------------------ state

async function loadDevices() {
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    els.themDevice.innerHTML = '';
    for (const d of inputs) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Entrada ${els.themDevice.length + 1}`;
      els.themDevice.append(opt);
    }
    if (!inputs.length || !inputs[0].label) {
      setStatus('Abre Ajustes y concede el permiso de micrófono para ver los dispositivos.', 'error');
    }
  } catch {
    setStatus('No se pudieron listar los dispositivos de audio.', 'error');
  }
}

async function saveUi() {
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  const next = {
    ...stored,
    lang: els.lang.value,
    themSource: els.themSource.value,
    themDeviceId: els.themDevice.value || null,
    captureMic: els.captureMic.checked,
    sessionContext: els.sessionContext.value.trim().slice(0, CONTEXT_MAX_CHARS),
  };
  await chrome.storage.local.set({ settings: next });
  settings = { ...DEFAULT_COACH, ...next };
}

async function init() {
  // In the floating window there is no point offering to open another.
  const isWindow = new URLSearchParams(location.search).get('window') === '1';
  if (els.openWindow) els.openWindow.hidden = isWindow;
  document.body.classList.toggle('as-window', isWindow);

  const { settings: stored = {}, transcript = [], lastError } =
    await chrome.storage.local.get(['settings', 'transcript', 'lastError']);
  settings = { ...DEFAULT_COACH, ...stored };
  // First paint without waiting for a broadcast; COACH_CHIPS keeps it live afterwards.
  showChips(resolveChips(settings));
  els.lang.value = settings.lang || 'en';
  els.themSource.value = settings.themSource || 'tab';
  els.captureMic.checked = settings.captureMic !== false;
  els.sessionContext.value = settings.sessionContext || '';
  entries = transcript;
  render();
  await loadDevices();
  if (settings.themDeviceId) els.themDevice.value = settings.themDeviceId;
  els.deviceField.hidden = els.themSource.value !== 'device';

  const st = await chrome.runtime.sendMessage({ type: 'PING_STATE' }).catch(() => null);
  setRunning(!!(st && st.running));
  if (st && st.running) setStatus('Grabando…', 'ok');
  // If the session failed while this view was closed, the error is still here.
  else if (lastError && Date.now() - lastError.at < 10 * 60 * 1000) setStatus(lastError.text, 'error');
  else if ((settings.themSource || 'tab') === 'tab') {
    const atajo = navigator.platform.includes('Mac') ? '⌘⇧S' : 'Ctrl+Shift+S';
    setStatus(`Para el audio de la pestaña: ve a ella y pulsa ${atajo}, o clic derecho → English Coach.`);
  }
}

// ------------------------------------------------------------------ events

els.lang.addEventListener('change', saveUi);
els.themSource.addEventListener('change', async () => {
  els.deviceField.hidden = els.themSource.value !== 'device';
  await saveUi();
});
els.themDevice.addEventListener('change', saveUi);
els.captureMic.addEventListener('change', saveUi);
// Unlike the source controls, the context stays enabled during a session on
// purpose: the offscreen document re-reads settings on every coach call, so
// notes edited mid-interview reach the very next suggested reply.
els.sessionContext.addEventListener('change', saveUi);

els.toggle.addEventListener('click', async () => {
  if (running) {
    setStatus('Deteniendo…');
    await chrome.runtime.sendMessage({ type: 'STOP' });
    setRunning(false);
    return;   // the offscreen document fires the automatic report on stop
  }
  await saveUi();
  setStatus('Iniciando captura…');
  // Before START, never after: the offscreen document broadcasts LIVE_STATE from
  // inside start(), so it lands while this await is still pending.
  showLiveNote(null);
  const res = await chrome.runtime.sendMessage({ type: 'START' });
  if (res && res.ok) {
    setRunning(true);
    setStatus('Grabando…', 'ok');
    els.replyBox.hidden = true;
  } else {
    setStatus(res?.error || 'No se pudo iniciar.', 'error');
  }
});

els.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.openWindow?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_WINDOW' }));
els.askReply.addEventListener('click', suggestReply);
els.report.addEventListener('click', () => generateReport());

els.analyze.addEventListener('click', async () => {
  await navigator.clipboard.writeText(PROMPT + '\n' + toMarkdown());
  setStatus('Prompt + transcripción copiados. Pégalos en Claude.', 'ok');
});

els.download.addEventListener('click', () => {
  // Without the charset, apps that default to Latin-1 render «Sesión» as «SesiÃ³n».
  const blob = new Blob([`# Conversación\n\n${toMarkdown()}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversacion-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

els.clear.addEventListener('click', async () => {
  entries = [];
  await chrome.storage.local.set({ transcript: [] });
  render();
  els.replyBox.hidden = true;
  setStatus('Transcripción borrada.');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'ui') return;
  if (msg.type === 'SEGMENT') {
    // A repeated (speaker, t) is a turn extended by folding: replace it, which
    // also drops the cached translation so the whole merged text retranslates.
    const i = entries.findIndex((e) => e.t === msg.entry.t && e.speaker === msg.entry.speaker);
    if (i >= 0) entries[i] = msg.entry;
    else entries.push(msg.entry);
    render();
  }
  else if (msg.type === 'PARTIAL') showPartial(msg.text);
  else if (msg.type === 'LIVE_STATE') {
    if (msg.state !== 'available') showPartial('');
    showLiveNote(msg);
  }
  else if (msg.type === 'COACH_CHIPS') showChips(msg);
  else if (msg.type === 'REPLY') showReply(msg);
  else if (msg.type === 'STATUS') setStatus(msg.text, msg.kind);
  else if (msg.type === 'RUNNING') { setRunning(msg.running); if (!msg.running) showPartial(''); }
  else if (msg.type === 'QUEUE' && msg.pending > 0) setStatus(`Transcribiendo… (${msg.pending} en cola)`);
});

init();
