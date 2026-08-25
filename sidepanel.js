import { DEFAULT_COACH } from './coach.js';
import { toSpanish } from './translate.js';

const $ = (id) => document.getElementById(id);

const els = {
  dot: $('dot'), toggle: $('toggle'), status: $('status'), transcript: $('transcript'),
  themSource: $('themSource'), themDevice: $('themDevice'), deviceField: $('deviceField'),
  captureMic: $('captureMic'), settings: $('settings'),
  coach: $('coach'), chips: $('chips'), nudge: $('nudge'), hintOpeners: $('hintOpeners'), askReply: $('askReply'),
  replyBox: $('replyBox'), replyStatus: $('replyStatus'),
  replyOpeners: $('replyOpeners'), replyIdeas: $('replyIdeas'),
  report: $('report'), analyze: $('analyze'), download: $('download'), clear: $('clear'),
  openWindow: $('openWindow'),
  partial: $('partial'), partialEn: $('partialEn'), partialEs: $('partialEs'),
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
    if (e.speaker !== 'me' && settings.translate !== false) {
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
  els.themSource.disabled = v;
  els.themDevice.disabled = v;
  els.captureMic.disabled = v;
  els.coach.hidden = !(v && settings.liveCoach);
}

// ------------------------------------------------------------------- coach

function showHints({ words = [], nudge = '', openers = [] }) {
  // Unconditional rebuild in a slot of their own: an empty round clears stale
  // openers, and the reply box's ⌘⇧E openers/ideas pairing is never touched.
  fillGroup(els.hintOpeners, openers);
  els.chips.innerHTML = '';
  for (const w of words) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const en = document.createElement('b');
    en.textContent = w.en;
    chip.append(en);
    if (w.es) {
      const es = document.createElement('span');
      es.textContent = ' · ' + w.es;
      chip.append(es);
    }
    els.chips.append(chip);
  }
  els.nudge.textContent = nudge || '';
}

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
  if (settings.translate === false) return;
  const wait = Math.max(0, PARTIAL_TR_MS - (Date.now() - partialTrAt));
  partialTimer = setTimeout(() => {
    partialTrAt = Date.now();
    const id = ++partialTrSeq;
    toSpanish(els.partialEn.textContent).then((txt) => {
      if (txt && id > partialTrShown) { partialTrShown = id; els.partialEs.textContent = txt; }
    });
  }, wait);
}

// One click copies the phrase: mid-conversation there is no time to select text
// with the mouse.
function fillGroup(box, items) {
  const list = box.querySelector('.reply-list');
  list.innerHTML = '';
  box.hidden = !items.length;
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'reply-item small';
    const en = document.createElement('b');
    en.textContent = item.en;
    btn.append(en);
    if (item.es) {
      const es = document.createElement('i');
      es.textContent = item.es;
      btn.append(es);
    }
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.en);
      btn.classList.add('copied');
      setStatus('Copiado: ' + item.en, 'ok');
    });
    list.append(btn);
  }
}

function showReply({ openers = [], ideas = [], pending = false, error = '' } = {}) {
  els.coach.hidden = false;
  els.replyBox.hidden = false;
  const aviso = pending ? 'Pensando…' : error;
  els.replyStatus.textContent = aviso;
  els.replyStatus.hidden = !aviso;
  fillGroup(els.replyOpeners, pending || error ? [] : openers);
  fillGroup(els.replyIdeas, pending || error ? [] : ideas);
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
    themSource: els.themSource.value,
    themDeviceId: els.themDevice.value || null,
    captureMic: els.captureMic.checked,
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
  els.themSource.value = settings.themSource || 'tab';
  els.captureMic.checked = settings.captureMic !== false;
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

els.themSource.addEventListener('change', async () => {
  els.deviceField.hidden = els.themSource.value !== 'device';
  await saveUi();
});
els.themDevice.addEventListener('change', saveUi);
els.captureMic.addEventListener('change', saveUi);

els.toggle.addEventListener('click', async () => {
  if (running) {
    setStatus('Deteniendo…');
    await chrome.runtime.sendMessage({ type: 'STOP' });
    setRunning(false);
    return;   // the offscreen document fires the automatic report on stop
  }
  await saveUi();
  setStatus('Iniciando captura…');
  const res = await chrome.runtime.sendMessage({ type: 'START' });
  if (res && res.ok) {
    setRunning(true);
    setStatus('Grabando…', 'ok');
    els.chips.innerHTML = '';
    els.nudge.textContent = '';
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
  const blob = new Blob([`# Conversación\n\n${toMarkdown()}\n`], { type: 'text/markdown' });
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
  els.chips.innerHTML = '';
  els.nudge.textContent = '';
  els.replyBox.hidden = true;
  setStatus('Transcripción borrada.');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'ui') return;
  if (msg.type === 'SEGMENT') { entries.push(msg.entry); render(); }
  else if (msg.type === 'PARTIAL') showPartial(msg.text);
  else if (msg.type === 'LIVE_STATE') {
    if (msg.state !== 'available') showPartial('');
    const aviso = {
      error: 'Transcripción en vivo desactivada: ' + (msg.detail || ''),
      unsupported: 'Sin transcripción en vivo: este Chrome no la expone donde graba la extensión.',
      unavailable: 'Sin transcripción en vivo: el reconocimiento local no está disponible aquí.',
      downloadable: 'Sin transcripción en vivo: falta el paquete de idioma (instálalo en Ajustes).',
      downloading: 'Descargando el paquete de idioma para la transcripción en vivo…',
    }[msg.state];
    if (aviso) setStatus(aviso, msg.state === 'downloading' ? 'info' : 'error');
  }
  else if (msg.type === 'HINTS') showHints(msg);
  else if (msg.type === 'REPLY') showReply(msg);
  else if (msg.type === 'STATUS') setStatus(msg.text, msg.kind);
  else if (msg.type === 'RUNNING') { setRunning(msg.running); if (!msg.running) showPartial(''); }
  else if (msg.type === 'QUEUE' && msg.pending > 0) setStatus(`Transcribiendo… (${msg.pending} en cola)`);
});

init();
