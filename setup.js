import { PROVIDERS, DEFAULT_COACH } from './coach.js';
import { liveAvailability, installLive } from './live.js';
import { resolveProvider, PROFILE_MAX_CHARS, CONTEXT_MAX_CHARS } from './coach.js';
import { CATALOGUE, DEFAULT_PHRASE_IDS, MAX_NOTES, MAX_CUSTOM, NOTE_TITLE_MAX, NOTE_BODY_MAX,
  pickEnglishVoice } from './phrasebook.js';

const $ = (id) => document.getElementById(id);

let customPhrases = [];
let notes = [];
let pillHiddenHosts = [];

const DEFAULTS = {
  engine: 'local',
  model: 'onnx-community/whisper-base.en',
  device: 'webgpu',
  groqKey: '',
  anthropicKey: '',
  groqModel: 'whisper-large-v3-turbo',
  micDeviceId: null,
  themSource: 'tab',
  captureMic: true,
  floatingWindow: false,
  minSegMs: 900,
  translate: true,
  liveTranscript: true,
  ...DEFAULT_COACH,
};

// Each option carries "provider:model": one select spans both providers, so the value
// has to name which one. It is the model the suggested reply and the report both use.
function fillModelSelect(sel, selected) {
  sel.innerHTML = '';
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    const group = document.createElement('optgroup');
    group.label = spec.cost ? `${spec.label} — ${spec.cost}` : spec.label;
    for (const m of spec.models) {
      const opt = document.createElement('option');
      opt.value = `${id}:${m}`;
      opt.textContent = m;
      group.append(opt);
    }
    sel.append(group);
  }
  sel.value = selected;
  if (!sel.value) sel.selectedIndex = 0;
}

async function listMics(selected) {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = $('micDevice');
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Predeterminado del sistema';
  sel.append(auto);
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Entrada de audio';
    sel.append(opt);
  }
  sel.value = selected || '';
  return inputs;
}

// --- pronunciation ------------------------------------------------------------
// speechSynthesis needs no permission and no host: the voices belong to the
// operating system, so the phrasebook keeps working with no key and no connection.
// getVoices() is empty until the engine has finished loading them, which is the
// only thing voiceschanged announces.
let enVoice = null;

const checkedIds = () => [...document.querySelectorAll('.phrase-cb:checked')].map((cb) => cb.value);

function loadVoices() {
  const synth = globalThis.speechSynthesis;
  if (!synth) return;
  const found = pickEnglishVoice(synth.getVoices());
  if (found === enVoice) return;
  const appeared = !enVoice && !!found;
  enVoice = found;
  // Buttons are only built when a voice exists, so a list drawn before the engine
  // answered has to be rebuilt once it does.
  if (appeared && $('catalogue').childElementCount) {
    renderCatalogue(checkedIds());
    renderCustom();
  }
}

function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !enVoice) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = enVoice;
  // Always English, never settings.lang: the catalogue is English whatever the
  // session language is, and reading it with a Spanish voice would teach the wrong
  // pronunciation — worse than offering nothing.
  u.lang = enVoice.lang || 'en-US';
  u.rate = 0.9;
  synth.speak(u);
}

// Null when no English voice is installed: the row then renders without a button.
function sayButton(text) {
  if (!enVoice) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'say';
  b.textContent = '\u{1F50A}';
  b.title = 'Escuchar la pronunciación';
  b.addEventListener('click', (e) => {
    // A catalogue row is a <label> wrapping the checkbox, so without this the
    // speaker would also tick or untick the phrase.
    e.preventDefault();
    e.stopPropagation();
    speak(text);
  });
  return b;
}

function renderCatalogue(chosen) {
  const box = $('catalogue');
  box.textContent = '';
  const picked = new Set(chosen);
  for (const group of CATALOGUE) {
    const title = document.createElement('h3');
    title.textContent = group.cat;
    box.append(title);
    for (const item of group.items) {
      const label = document.createElement('label');
      label.className = 'phrase-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = item.id;
      cb.checked = picked.has(item.id);
      cb.className = 'phrase-cb';
      const en = document.createElement('b');
      en.textContent = item.en;
      const es = document.createElement('span');
      es.className = 'hint';
      es.textContent = ' · ' + item.es;
      label.append(cb, en, es);
      const say = sayButton(item.en);
      if (say) label.append(say);
      box.append(label);
    }
  }
}

function renderPillHosts() {
  const box = $('pillHosts');
  box.textContent = '';
  if (!pillHiddenHosts.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No has ocultado el botón en ningún sitio.';
    box.append(empty);
    return;
  }
  pillHiddenHosts.forEach((host, i) => {
    const row = document.createElement('div');
    row.className = 'phrase-row';
    const name = document.createElement('b');
    name.textContent = host;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small';
    del.textContent = 'Volver a mostrar';
    del.addEventListener('click', () => { pillHiddenHosts.splice(i, 1); renderPillHosts(); });
    row.append(name, del);
    box.append(row);
  });
}

function renderCustom() {
  const box = $('customList');
  box.textContent = '';
  customPhrases.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'phrase-row';
    const en = document.createElement('b');
    en.textContent = p.en;
    const es = document.createElement('span');
    es.className = 'hint';
    es.textContent = p.es ? ' · ' + p.es : '';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small';
    del.textContent = 'Quitar';
    del.addEventListener('click', () => { customPhrases.splice(i, 1); renderCustom(); });
    row.append(en, es);
    const say = sayButton(p.en);
    if (say) row.append(say);
    row.append(del);
    box.append(row);
  });
}

function renderNotes() {
  const box = $('noteList');
  box.textContent = '';
  notes.forEach((n, i) => {
    const row = document.createElement('div');
    row.className = 'note-edit';
    const title = document.createElement('input');
    title.type = 'text';
    title.maxLength = NOTE_TITLE_MAX;
    title.placeholder = 'Mi daily';
    title.value = n.title || '';
    title.addEventListener('input', () => { n.title = title.value; });
    const body = document.createElement('textarea');
    body.rows = 4;
    body.maxLength = NOTE_BODY_MAX;
    body.placeholder = "Yesterday I finished… Today I'm picking up… No blockers.";
    body.value = n.body || '';
    body.addEventListener('input', () => { n.body = body.value; });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'small';
    del.textContent = 'Quitar nota';
    del.addEventListener('click', () => { notes.splice(i, 1); renderNotes(); });
    row.append(title, body, del);
    box.append(row);
  });
}

$('addPhrase').addEventListener('click', () => {
  const en = $('customEn').value.trim();
  if (!en || customPhrases.length >= MAX_CUSTOM) return;
  customPhrases.push({ id: 'u.' + Date.now(), en, es: $('customEs').value.trim() });
  $('customEn').value = '';
  $('customEs').value = '';
  renderCustom();
});

$('addNote').addEventListener('click', () => {
  if (notes.length >= MAX_NOTES) return;
  notes.push({ id: 'n.' + Date.now(), title: '', body: '', open: false });
  renderNotes();
});

const LIVE_MSG = {
  unsupported: ['No disponible en este Chrome (hace falta la versión 139 o superior)', 'err'],
  unavailable: ['No disponible en este equipo', 'err'],
  downloadable: ['Falta el paquete de idioma inglés', ''],
  downloading: ['Descargando el paquete de idioma…', ''],
  available: ['✓ Reconocimiento en vivo disponible en el dispositivo', 'ok'],
  unknown: ['Chrome no informa del estado; se intentará al grabar', ''],
};

// Warn before recording: picking a model from a provider with no key is the easiest
// way to end up with no suggested reply and no report right when they are needed.
function checkKeys() {
  const el = $('keyWarn');
  const keys = { groqKey: $('groqKey').value.trim(), anthropicKey: $('anthropicKey').value.trim() };
  const pedido = $('reportModel').value.split(':')[0];
  const elegido = resolveProvider(pedido, keys);
  const label = PROVIDERS[pedido]?.label || pedido;
  let aviso = '';
  if (!elegido) aviso = 'No hay ninguna API key: la respuesta sugerida y el informe no funcionarán.';
  else if (elegido.fallback) aviso = `Sin key de ${label}: la respuesta sugerida y el informe usarán ${elegido.label}.`;
  el.textContent = aviso;
  el.hidden = !aviso;
}

for (const id of ['groqKey', 'anthropicKey', 'reportModel']) {
  $(id).addEventListener('input', checkKeys);
  $(id).addEventListener('change', checkKeys);
}

function wireCounter(campo, contador, max) {
  const update = () => {
    const usado = $(campo).value.trim().length;
    const el = $(contador);
    el.textContent = usado ? `· ${Math.min(usado, max)}/${max}` : '· opcional';
    el.className = usado > max ? 'hint err' : 'hint';
  };
  $(campo).addEventListener('input', update);
  return update;
}

const countProfile = wireCounter('profile', 'profileCount', PROFILE_MAX_CHARS);
const countContext = wireCounter('sessionContext', 'contextCount', CONTEXT_MAX_CHARS);

// The session language decides which pack matters. Options has no language
// control — it lives in the side panel — so it is read from storage here;
// reporting on en-US while the learner runs Spanish sessions answers the wrong
// question.
async function liveLang() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings.lang === 'es' ? 'es-ES' : 'en-US';
}

async function checkLive() {
  const el = $('liveStatus');
  const boton = $('installLive');
  const estado = await liveAvailability(await liveLang());
  const [texto, clase] = LIVE_MSG[estado] || LIVE_MSG.unavailable;
  el.textContent = texto;
  el.className = 'hint' + (clase ? ' ' + clase : '');
  boton.hidden = estado !== 'downloadable';
}

$('installLive').addEventListener('click', async () => {
  const el = $('liveStatus');
  $('installLive').disabled = true;
  el.textContent = 'Descargando el paquete de idioma…';
  el.className = 'hint';
  const ok = await installLive(await liveLang());
  $('installLive').disabled = false;
  if (!ok) {
    el.textContent = 'No se pudo instalar el paquete de idioma';
    el.className = 'hint err';
    return;
  }
  await checkLive();
});

async function checkTranslator() {
  const el = $('translateStatus');
  const noDisponible = 'No disponible en este Chrome (hace falta la versión 138 o superior)';
  if (typeof Translator === 'undefined') {
    el.textContent = noDisponible;
    el.className = 'hint err';
    return;
  }
  try {
    const estado = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'es' });
    if (estado === 'available') {
      el.textContent = '✓ Traductor de Chrome disponible';
      el.className = 'hint ok';
    } else if (estado === 'downloadable' || estado === 'downloading') {
      el.textContent = 'Descargando modelo de idioma…';
      el.className = 'hint';
    } else {
      el.textContent = noDisponible;
      el.className = 'hint err';
    }
  } catch {
    el.textContent = noDisponible;
    el.className = 'hint err';
  }
}

async function checkMic() {
  const el = $('micStatus');
  try {
    const st = await navigator.permissions.query({ name: 'microphone' });
    if (st.state === 'granted') { el.textContent = '✓ Permiso concedido.'; el.className = 'hint ok'; return true; }
    el.textContent = 'Aún no concedido.';
    el.className = 'hint';
    return false;
  } catch {
    el.textContent = '';
    return false;
  }
}

$('grant').addEventListener('click', async () => {
  const el = $('micStatus');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    el.textContent = '✓ Permiso concedido.';
    el.className = 'hint ok';
    const { settings = {} } = await chrome.storage.local.get('settings');
    await listMics(settings.micDeviceId);
  } catch (e) {
    el.textContent = 'No se concedió el permiso: ' + (e.message || e);
    el.className = 'hint err';
  }
});

$('engine').addEventListener('change', () => {
  const api = $('engine').value === 'api';
  $('apiOpts').hidden = !api;
  $('localOpts').hidden = api;
});

$('save').addEventListener('click', async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const [reportProvider, reportModel] = $('reportModel').value.split(':');
  const next = {
    ...DEFAULTS,
    ...settings,
    engine: $('engine').value,
    model: $('model').value,
    device: $('device').value,
    micDeviceId: $('micDevice').value || null,
    groqKey: $('groqKey').value.trim(),
    anthropicKey: $('anthropicKey').value.trim(),
    minSegMs: Number($('minSegMs').value),
    translate: $('translate').checked,
    liveTranscript: $('liveTranscript').checked,
    liveCoach: $('liveCoach').checked,
    floatingWindow: $('floatingWindow').checked,
    autoReport: $('autoReport').checked,
    reportProvider, reportModel,
    level: $('level').value,
    situation: $('situation').value.trim() || DEFAULT_COACH.situation,
    profile: $('profile').value.trim().slice(0, PROFILE_MAX_CHARS),
    sessionContext: $('sessionContext').value.trim().slice(0, CONTEXT_MAX_CHARS),
    phraseIds: checkedIds(),
    customPhrases,
    notes: notes.filter((n) => (n.title || '').trim() || (n.body || '').trim()),
    pillHiddenHosts,
  };
  await chrome.storage.local.set({ settings: next, setupDone: true });
  $('saved').textContent = ' Guardado ✓';
  setTimeout(() => ($('saved').textContent = ''), 2500);
});

(async function init() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  $('engine').value = s.engine;
  $('model').value = s.model;
  $('device').value = s.device;
  $('apiOpts').hidden = s.engine !== 'api';
  $('localOpts').hidden = s.engine === 'api';
  $('groqKey').value = s.groqKey || '';
  $('anthropicKey').value = s.anthropicKey || '';
  $('minSegMs').value = String(s.minSegMs ?? 900);
  $('translate').checked = s.translate !== false;
  $('liveTranscript').checked = s.liveTranscript !== false;
  $('liveCoach').checked = s.liveCoach !== false;
  $('autoReport').checked = s.autoReport !== false;
  $('floatingWindow').checked = s.floatingWindow !== false;
  $('level').value = s.level;
  $('situation').value = s.situation;
  $('profile').value = s.profile || '';
  $('sessionContext').value = s.sessionContext || '';
  countProfile();
  countContext();
  fillModelSelect($('reportModel'), `${s.reportProvider}:${s.reportModel}`);
  customPhrases = Array.isArray(s.customPhrases) ? s.customPhrases : [];
  notes = Array.isArray(s.notes) ? s.notes : [];
  pillHiddenHosts = Array.isArray(s.pillHiddenHosts) ? s.pillHiddenHosts : [];
  if (globalThis.speechSynthesis) {
    globalThis.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    loadVoices();
  }
  renderCatalogue(Array.isArray(s.phraseIds) ? s.phraseIds : DEFAULT_PHRASE_IDS);
  renderCustom();
  renderNotes();
  renderPillHosts();
  await checkMic();
  await checkTranslator();
  await checkLive();
  checkKeys();
  await listMics(s.micDeviceId);
})();
