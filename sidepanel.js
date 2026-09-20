import { DEFAULT_COACH, CONTEXT_MAX_CHARS, PROFILE_MAX_CHARS } from './coach.js';
import { toSpanish } from './translate.js';
import { phraseCategories } from './phrasebook.js';
import { installLive } from './live.js';
import { resolveChips, NOTE_TITLE_MAX, NOTE_BODY_MAX } from './phrasebook.js';

const $ = (id) => document.getElementById(id);

const els = {
  dot: $('dot'), toggle: $('toggle'), status: $('status'), transcript: $('transcript'),
  lang: $('lang'),
  themSource: $('themSource'), themDevice: $('themDevice'), deviceField: $('deviceField'),
  captureMic: $('captureMic'), settings: $('settings'), sessionContext: $('sessionContext'),
  profile: $('profile'), noteAdd: $('noteAdd'), noteForm: $('noteForm'), noteTitle: $('noteTitle'), noteBody: $('noteBody'),
  coach: $('coach'), askReply: $('askReply'),
  phrases: $('phrases'), notes: $('notes'), cats: $('cats'),
  tabPhrases: $('tabPhrases'), tabNotes: $('tabNotes'),
  phrasesPane: $('phrasesPane'), notesPane: $('notesPane'), clock: $('clock'),
  replyBox: $('replyBox'), replyStatus: $('replyStatus'),
  replyAnswer: $('replyAnswer'), replyIdeas: $('replyIdeas'),
  report: $('report'), pause: $('pause'), jump: $('jump'), sticky: $('sticky'), analyze: $('analyze'), download: $('download'), clear: $('clear'),
  openWindow: $('openWindow'),
  liveNote: $('liveNote'), liveNoteText: $('liveNoteText'), liveNoteAction: $('liveNoteAction'),
};

els.noteTitle.maxLength = NOTE_TITLE_MAX;
els.noteBody.maxLength = NOTE_BODY_MAX;
els.profile.maxLength = PROFILE_MAX_CHARS;

let running = false;
let entries = [];
// See the overlay: RUNNING carries the session id, not a "clear now" flag, so
// that a view which missed the start does not wipe itself when the session ends.
let lastSession = 0;
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
// Whether translation is switched on at all. Which turns actually get translated is
// a per-turn decision now: a Spanish turn needs no Spanish line under it, and in a
// bilingual meeting both kinds arrive on the same speaker.
const traducir = () => settings.translate !== false;
// An entry stored before languages existed reads as English, which is what it was.
const langOf = (x) => (x && x.lang === 'es' ? 'es' : 'en');

// The DOM is capped, not rebuilt on every turn: rebuilding threw the scroll
// position away, so reading back through the conversation was impossible while
// the session ran. render() is the full repaint, for loading and clearing.
let atBottom = true;
let unread = 0;
let stickyKey = null;
let markEl = null;
let markCount = 0;

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;

function stickToBottom() {
  if (!atBottom) return;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// The last thing the other person said, kept on screen while the learner reads
// back. It only gives way when they speak again — and what it displaces is what
// the counter counts, so the number always means "below here, and unreadable".
const latestThem = () => sorted().reverse().find((e) => e.speaker !== 'me') || null;

function renderSticky() {
  const t = atBottom ? null : latestThem();
  els.sticky.textContent = '';
  els.sticky.hidden = !t;
  stickyKey = t ? t.speaker + ':' + t.t : null;
  if (!t) return;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = 'Interlocutor · lo último';
  const p = document.createElement('div');
  p.textContent = t.text;
  els.sticky.append(who, p);
  if (t.es && langOf(t) !== 'es') {
    const es = document.createElement('span');
    es.className = 'es';
    es.textContent = t.es;
    els.sticky.append(es);
  }
}

function clearMark() {
  markEl?.remove();
  markEl = null;
  markCount = 0;
}

// Half a millisecond before the turn it heads, so insertByTime keeps sorting the
// list by dataset.t without having to know the divider exists.
function placeMark(t) {
  markEl = document.createElement('div');
  markEl.className = 'unread-mark';
  markEl.dataset.t = String(t - 0.5);
  markEl.append(document.createElement('span'));
  insertByTime(markEl, t - 0.5);
}

function paintMark() {
  if (!markEl) return;
  markEl.firstElementChild.textContent =
    markCount === 1 ? '1 mensaje sin leer' : `${markCount} mensajes sin leer`;
}

function paintJump() {
  els.jump.hidden = unread === 0;
  els.jump.textContent = unread === 1 ? '1 mensaje nuevo ↓' : `${unread} mensajes nuevos ↓`;
}

function bubbleNode(e) {
  const div = document.createElement('div');
  div.className = 'bubble ' + (e.speaker === 'me' ? 'me' : 'them');
  div.dataset.t = e.t;
  div.dataset.key = e.speaker + ':' + e.t;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${e.speaker === 'me' ? 'Yo' : 'Interlocutor'} · ${fmtTime(e.t)}`;
  const tag = document.createElement('span');
  tag.className = 'lang-tag';
  tag.textContent = langOf(e) === 'es' ? 'ES' : 'EN';
  meta.append(' ', tag);
  const p = document.createElement('span');
  p.textContent = e.text;
  div.append(meta, p);
  if (e.speaker !== 'me' && langOf(e) !== 'es' && traducir()) {
    const es = document.createElement('span');
    es.className = 'es';
    div.append(es);
    // Cached on the entry, not the node: a fold replaces the node.
    if (e.es) es.textContent = e.es;
    else toSpanish(e.text).then((txt) => {
      if (!txt) return;
      e.es = txt;
      es.textContent = txt;
      // The translation lands after the bubble was painted and makes it taller.
      // Without this the newest line sits half out of sight the moment it arrives.
      stickToBottom();
      // The sticky card is a copy of this turn: it needs the Spanish too.
      if (stickyKey === e.speaker + ':' + e.t) renderSticky();
    });
  }
  return div;
}

function render() {
  // A full repaint detaches whatever the divider was pointing at.
  clearMark();
  els.transcript.innerHTML = '';
  if (!entries.length) {
    els.transcript.innerHTML = '<p class="empty">Aquí aparecerá la conversación transcrita.</p>';
    unread = 0;
    paintJump();
    renderSticky();
    return;
  }
  for (const e of sorted()) els.transcript.append(bubbleNode(e));
  els.transcript.scrollTop = els.transcript.scrollHeight;
  atBottom = true;
  unread = 0;
  paintJump();
  renderSticky();
}

// Turns are folded and a 'them' segment can overtake the queue, so the newest is
// not always the latest: walk back from the end instead of always appending.
function insertByTime(node, t) {
  let ref = null;
  for (let el = els.transcript.lastElementChild; el; el = el.previousElementSibling) {
    if (Number(el.dataset.t) <= t) break;
    ref = el;
  }
  els.transcript.insertBefore(node, ref);
}

function addEntry(entry) {
  const i = entries.findIndex((e) => e.t === entry.t && e.speaker === entry.speaker);
  const isNew = i < 0;
  if (isNew) entries.push(entry); else entries[i] = entry;

  const empty = els.transcript.querySelector('.empty');
  if (empty) empty.remove();

  const node = bubbleNode(entry);
  const old = els.transcript.querySelector(`[data-key="${entry.speaker}:${entry.t}"]`);
  if (old) old.replaceWith(node);
  else insertByTime(node, entry.t);

  if (atBottom) {
    // Watching it happen live: any bookmark left over from an earlier run points at
    // something already read, so it goes rather than growing stale.
    if (isNew) clearMark();
    stickToBottom();
  } else if (isNew) {
    // Answering is what spends the bookmark, exactly as it does in a chat app.
    if (entry.speaker === 'me') clearMark();
    else {
      if (!markEl) placeMark(entry.t);
      markCount++;
      paintMark();
    }
    // A new 'them' turn takes the card over, so what it displaces is what becomes
    // unreadable. A turn that merely grew by folding displaces nothing.
    if (entry.speaker === 'me' || stickyKey) unread++;
    renderSticky();
    paintJump();
  } else if (stickyKey === entry.speaker + ':' + entry.t) renderSticky();
}

els.transcript.addEventListener('scroll', () => {
  const was = atBottom;
  atBottom = nearBottom(els.transcript);
  if (atBottom !== was) { if (atBottom) { unread = 0; paintJump(); } renderSticky(); }
});

els.jump.addEventListener('click', () => {
  unread = 0;
  paintJump();
  // To the divider, not to the foot: the useful place is where the unread run
  // starts. Without one there is nothing to land on, so the foot it is.
  if (markEl?.isConnected) {
    const box = els.transcript;
    const top = markEl.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, top - 8);
    return;
  }
  atBottom = true;
  renderSticky();
  stickToBottom();
});

const toMarkdown = () => sorted()
  .map((e) => `**${e.speaker === 'me' ? 'Yo' : 'Interlocutor'}** (${fmtTime(e.t)}): ${e.text}`)
  .join('\n\n');

function setStatus(text, kind = 'info') {
  els.status.textContent = text;
  els.status.className = 'status ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
}

function setPaused(v) {
  els.dot.classList.toggle('paused', v);
  els.pause.textContent = v ? '▶ Reanudar' : '⏸ Pausar';
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
  els.pause.hidden = !v;
  if (!v) setPaused(false);
  syncCoach();
}

// The two halves of the coach answer to different things. The lanes are settings,
// so they show with no session at all; resolveChips already empties them when
// liveCoach is off, which is why their visibility is read off their own content
// instead of a second copy of that rule. The reply needs a running session —
// exactly how the overlay gates it on .card.idle — so the panel, the floating
// window and the page overlay agree about what is on screen when.
function syncCoach() {
  const lanes = coachData.phrases.length || coachData.notes.length;
  els.askReply.hidden = !running;
  if (!running) { els.replyBox.hidden = true; els.coach.classList.remove('replying'); }
  els.coach.hidden = !(lanes || running);
}

// ------------------------------------------------------------------- coach

// Phrases need no interaction: they are there to be glanced at mid-sentence.
// Notes are collapsed but remember their state, so the learner opens "Mi daily"
// before the meeting and never has to click while the other person waits.
// Which tab is open and which category is filtered are view state only.
let coachData = { phrases: [], notes: [] };
let tab = 'phrases';
let cat = null;

function showChips({ phrases = [], notes = [] } = {}) {
  coachData = { phrases, notes };
  const cats = phraseCategories(phrases);
  if (!cats.includes(cat)) cat = cats[0] || null;
  renderCoach();
}

function renderCoach() {
  const { phrases, notes } = coachData;
  const cats = phraseCategories(phrases);

  // A tab with nothing behind it is a dead end: hide it and, if it was the open
  // one, fall through to the tab that does have something.
  els.tabPhrases.hidden = !phrases.length;
  els.tabNotes.hidden = false;
  els.tabPhrases.querySelector('.count').textContent = phrases.length;
  els.tabNotes.querySelector('.count').textContent = notes.length;
  if (tab === 'phrases' && !phrases.length) tab = 'notes';
  els.tabPhrases.classList.toggle('on', tab === 'phrases');
  els.tabNotes.classList.toggle('on', tab === 'notes');
  els.phrasesPane.hidden = tab !== 'phrases';
  els.notesPane.hidden = tab !== 'notes';

  // One category is no choice, so the row only earns its space from two up.
  els.cats.textContent = '';
  if (cats.length > 1) {
    for (const c of cats) {
      const btn = document.createElement('button');
      btn.className = 'cat' + (c === cat ? ' on' : '');
      btn.type = 'button';
      btn.textContent = c;
      btn.addEventListener('click', () => { cat = c; renderCoach(); });
      els.cats.append(btn);
    }
  }

  els.phrases.textContent = '';
  for (const p of phrases.filter((x) => cats.length < 2 || x.cat === cat)) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    const en = document.createElement('b');
    en.textContent = p.en;
    chip.append(en);
    if (p.es) {
      const es = document.createElement('span');
      es.textContent = p.es;
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

els.tabPhrases.addEventListener('click', () => { tab = 'phrases'; renderCoach(); });
els.tabNotes.addEventListener('click', () => { tab = 'notes'; renderCoach(); });

async function toggleNote(id) {
  await chrome.runtime.sendMessage({ type: 'TOGGLE_NOTE', id }).catch(() => {});
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

// Provisional text, one line per voice. Only the other speaker's line translates —
// the learner needs no Spanish for what they just said themselves. A debounce
// would reset on every interim word and never fire while the speaker keeps
// talking, so the translation throttles: one per second at most, always of the
// latest text, applied in order.
const partials = {
  them: { box: $('partialThem'), en: $('partialThemEn'), tail: $('partialThemTail'), es: $('partialThemEs') },
  me: { box: $('partialMe'), en: $('partialMeEn'), tail: $('partialMeTail'), es: null },
};
let partialTimer = null;
let partialTrAt = 0;
let partialTrSeq = 0;
let partialTrShown = 0;
const PARTIAL_TR_MS = 1000;

function showPartial(speaker, text, committed = '', lang = 'en') {
  const p = partials[speaker] || partials.them;
  if (p.es) clearTimeout(partialTimer);
  if (!text) {
    if (p.es) {
      // A late toSpanish resolution must not paint the previous phrase's Spanish
      // under the next phrase's English: invalidate everything in flight.
      partialTrShown = ++partialTrSeq;
      p.es.textContent = '';
    }
    p.box.hidden = true;
    p.en.textContent = '';
    p.tail.textContent = '';
    return;
  }
  p.box.hidden = false;
  // committed is always a prefix of text; verify it rather than trust it, so a
  // malformed message degrades to the old behaviour instead of losing words.
  const settled = committed && text.startsWith(committed) ? committed : '';
  p.en.textContent = settled;
  p.tail.textContent = text.slice(settled.length);
  if (!p.es || !traducir() || lang === 'es') return;
  const wait = Math.max(0, PARTIAL_TR_MS - (Date.now() - partialTrAt));
  partialTimer = setTimeout(() => {
    partialTrAt = Date.now();
    const id = ++partialTrSeq;
    toSpanish(text).then((txt) => {
      if (txt && id > partialTrShown) { partialTrShown = id; p.es.textContent = txt; }
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
  els.coach.classList.add('replying');
  // syncCoach has the last word: a reply that lands after the session ended must
  // not reopen the section, or the panel would show what the overlay hides.
  syncCoach();
}

// The dot says a session is live; the clock says how long. Between them the status
// line is free for what only it can say — errors, the transcription queue.
let clockTimer = null;
const clockText = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  const hh = Math.floor(total / 3600);
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

function startClock(startedAt) {
  stopClock();
  if (!startedAt) return;
  const tick = () => { els.clock.textContent = clockText(Date.now() - startedAt); };
  tick();
  els.clock.hidden = false;
  clockTimer = setInterval(tick, 1000);
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  els.clock.hidden = true;
}

els.pause.addEventListener('click', () => {
  const type = els.dot.classList.contains('paused') ? 'RESUME' : 'PAUSE';
  chrome.runtime.sendMessage({ type }).catch(() => {});
});

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

// One field per call: the side panel and the floating window are the same page
// open twice, and a six-field patch from either one overwrites whatever the
// other just changed with its own stale copy of the other five.
async function saveUi(patch) {
  const res = await chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch }).catch(() => null);
  settings = { ...DEFAULT_COACH, ...((res && res.settings) || { ...settings, ...patch }) };
}

async function init() {
  // In the floating window there is no point offering to open another.
  const isWindow = new URLSearchParams(location.search).get('window') === '1';
  if (els.openWindow) els.openWindow.hidden = isWindow;
  document.body.classList.toggle('as-window', isWindow);

  const { settings: stored = {}, transcript = [], lastError, startedAt = 0 } =
    await chrome.storage.local.get(['settings', 'transcript', 'lastError', 'startedAt']);
  settings = { ...DEFAULT_COACH, ...stored };
  // First paint without waiting for a broadcast; COACH_CHIPS keeps it live afterwards.
  showChips(resolveChips(settings));
  els.lang.value = settings.lang || 'en';
  els.themSource.value = settings.themSource || 'tab';
  els.captureMic.checked = settings.captureMic !== false;
  els.sessionContext.value = settings.sessionContext || '';
  els.profile.value = settings.profile || '';
  entries = transcript;
  render();
  await loadDevices();
  if (settings.themDeviceId) els.themDevice.value = settings.themDeviceId;
  els.deviceField.hidden = els.themSource.value !== 'device';

  const st = await chrome.runtime.sendMessage({ type: 'PING_STATE' }).catch(() => null);
  setRunning(!!(st && st.running));
  // A panel opened mid-session missed the RUNNING broadcast. It has chrome.storage
  // of its own, so it reads the session start rather than growing the protocol.
  if (st && st.running) { startClock(startedAt); setPaused(!!st.paused); setStatus(''); }
  // If the session failed while this view was closed, the error is still here.
  else if (lastError && Date.now() - lastError.at < 10 * 60 * 1000) setStatus(lastError.text, 'error');
  else if ((settings.themSource || 'tab') === 'tab') {
    const atajo = navigator.platform.includes('Mac') ? '⌘⇧S' : 'Ctrl+Shift+S';
    setStatus(`Para el audio de la pestaña: ve a ella y pulsa ${atajo}, o clic derecho → English Coach.`);
  }
}

// ------------------------------------------------------------------ events

els.lang.addEventListener('change', () => saveUi({ lang: els.lang.value }));
els.themSource.addEventListener('change', async () => {
  els.deviceField.hidden = els.themSource.value !== 'device';
  await saveUi({ themSource: els.themSource.value });
});
els.themDevice.addEventListener('change', () => saveUi({ themDeviceId: els.themDevice.value || null }));
els.captureMic.addEventListener('change', () => saveUi({ captureMic: els.captureMic.checked }));
// Unlike the source controls, the context stays enabled during a session on
// purpose: the offscreen document re-reads settings on every coach call, so
// notes edited mid-interview reach the very next suggested reply.
els.sessionContext.addEventListener('change', () =>
  saveUi({ sessionContext: els.sessionContext.value.trim().slice(0, CONTEXT_MAX_CHARS) }));
els.profile.addEventListener('change', () =>
  saveUi({ profile: els.profile.value.trim().slice(0, PROFILE_MAX_CHARS) }));

els.noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = els.noteTitle.value;
  const body = els.noteBody.value;
  if (!title.trim() && !body.trim()) return;
  await chrome.runtime.sendMessage({ type: 'ADD_NOTE', title, body }).catch(() => {});
  els.noteForm.reset();
  els.noteAdd.open = false;
  // No re-render here: the write trips storage.onChanged in background.js, which
  // re-broadcasts COACH_CHIPS to every view, this one included.
});

els.toggle.addEventListener('click', async () => {
  if (running) {
    setStatus('Deteniendo…');
    await chrome.runtime.sendMessage({ type: 'STOP' });
    setRunning(false);
    return;   // the offscreen document fires the automatic report on stop
  }
  // Every field already persisted on its own change, which fires on blur before
  // this click lands — no patch to send here.
  setStatus('Iniciando captura…');
  // Before START, never after: the offscreen document broadcasts LIVE_STATE from
  // inside start(), so it lands while this await is still pending.
  showLiveNote(null);
  const res = await chrome.runtime.sendMessage({ type: 'START' });
  if (res && res.ok) {
    setRunning(true);
    setStatus('Grabando…', 'ok');
    els.replyBox.hidden = true;
  els.coach.classList.remove('replying');
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
  els.coach.classList.remove('replying');
  setStatus('Transcripción borrada.');
});

// The profile and context fields are a copy of a value Options can also write:
// without this, saveUi() would read the fresh value out of storage only to
// overwrite it with whatever this page loaded last.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue || {};
  for (const [field, key] of [[els.profile, 'profile'], [els.sessionContext, 'sessionContext']]) {
    const value = next[key] || '';
    if (document.activeElement === field || field.value === value) continue;
    field.value = value;
    settings[key] = value;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'ui') return;
  // A repeated (speaker, t) is a turn extended by folding: addEntry replaces it,
  // which also drops the cached translation so the merged text retranslates whole.
  if (msg.type === 'SEGMENT') addEntry(msg.entry);
  else if (msg.type === 'PARTIAL') showPartial(msg.speaker === 'me' ? 'me' : 'them', msg.text, msg.committed, msg.lang);
  else if (msg.type === 'LIVE_STATE') {
    if (msg.state !== 'available') showPartial('them', '');
    showLiveNote(msg);
  }
  else if (msg.type === 'PAUSED') setPaused(msg.paused);
  else if (msg.type === 'COACH_CHIPS') showChips(msg);
  else if (msg.type === 'REPLY') showReply(msg);
  else if (msg.type === 'STATUS') setStatus(msg.text, msg.kind);
  else if (msg.type === 'RUNNING') {
    if (msg.running && msg.session && msg.session !== lastSession) { entries = []; render(); }
    if (msg.session) lastSession = msg.session;
    setRunning(msg.running);
    if (msg.running) startClock(msg.session);
    else { stopClock(); showPartial('them', ''); showPartial('me', ''); }
  }
  else if (msg.type === 'QUEUE' && msg.pending > 0) setStatus(`Transcribiendo… (${msg.pending} en cola)`);
});

init();
