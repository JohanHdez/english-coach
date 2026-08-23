import { PROVIDERS, DEFAULT_COACH } from './coach.js';
import { liveAvailability, installLive } from './live.js';
import { resolveProvider, PROFILE_MAX_CHARS } from './coach.js';

const $ = (id) => document.getElementById(id);

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

// Each option carries "provider:model" so Groq and Claude can be mixed.
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

const LIVE_MSG = {
  unsupported: ['No disponible en este Chrome (hace falta la versión 139 o superior)', 'err'],
  unavailable: ['No disponible en este equipo', 'err'],
  downloadable: ['Falta el paquete de idioma inglés', ''],
  downloading: ['Descargando el paquete de idioma…', ''],
  available: ['✓ Reconocimiento en vivo disponible en el dispositivo', 'ok'],
  unknown: ['Chrome no informa del estado; se intentará al grabar', ''],
};

// Warn before recording: picking a model from a provider with no key is the easiest
// way to end up with no report right when the conversation finishes.
function checkKeys() {
  const el = $('keyWarn');
  const keys = { groqKey: $('groqKey').value.trim(), anthropicKey: $('anthropicKey').value.trim() };
  const avisos = [];
  for (const [sel, uso] of [['liveModel', 'las sugerencias en vivo'], ['reportModel', 'el informe']]) {
    const pedido = $(sel).value.split(':')[0];
    const elegido = resolveProvider(pedido, keys);
    const label = PROVIDERS[pedido]?.label || pedido;
    if (!elegido) avisos.push(`No hay ninguna API key: ${uso} no funcionará.`);
    else if (elegido.fallback) avisos.push(`Sin key de ${label}: ${uso} usará ${elegido.label}.`);
  }
  el.textContent = [...new Set(avisos)].join(' ');
  el.hidden = avisos.length === 0;
}

for (const id of ['groqKey', 'anthropicKey', 'liveModel', 'reportModel']) {
  $(id).addEventListener('input', checkKeys);
  $(id).addEventListener('change', checkKeys);
}

function countProfile() {
  const usado = $('profile').value.trim().length;
  const el = $('profileCount');
  el.textContent = usado ? `· ${Math.min(usado, PROFILE_MAX_CHARS)}/${PROFILE_MAX_CHARS}` : '· opcional';
  el.className = usado > PROFILE_MAX_CHARS ? 'hint err' : 'hint';
}

$('profile').addEventListener('input', countProfile);

async function checkLive() {
  const el = $('liveStatus');
  const boton = $('installLive');
  const estado = await liveAvailability();
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
  const ok = await installLive();
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
  const [liveProvider, liveModel] = $('liveModel').value.split(':');
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
    liveProvider, liveModel, reportProvider, reportModel,
    level: $('level').value,
    situation: $('situation').value.trim() || DEFAULT_COACH.situation,
    profile: $('profile').value.trim().slice(0, PROFILE_MAX_CHARS),
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
  countProfile();
  fillModelSelect($('liveModel'), `${s.liveProvider}:${s.liveModel}`);
  fillModelSelect($('reportModel'), `${s.reportProvider}:${s.reportModel}`);
  await checkMic();
  await checkTranslator();
  await checkLive();
  checkKeys();
  await listMics(s.micDeviceId);
})();
