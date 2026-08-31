// In-page overlay: the interface that survives everything — it depends on neither
// the side panel, nor the extension bar, nor the window type. It lives in a Shadow
// DOM so the host site's CSS cannot touch it.

(() => {
  const HOST_ID = 'english-coach-overlay';
  const VERSION = chrome.runtime.getManifest().version;

  // Re-injection guard. Only a LIVE copy of this same extension may keep the
  // page: it proves itself by answering the ping with the current runtime id.
  // A copy left behind by an extension reload still has its DOM and globals,
  // but its chrome.runtime is dead — every button throws "Extension context
  // invalidated" — so it must be replaced, not deferred to.
  try {
    const prev = window.__englishCoachOverlay;
    if (typeof prev?.ping === 'function' && prev.ping() === chrome.runtime.id) {
      prev.evict?.();
      return;
    }
  } catch { /* a dead copy throws on ping: replace it below */ }

  const cmpVersion = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  };

  // An unpacked copy is a different extension to Chrome, with its own isolated
  // world: the ping above cannot see those. The DOM is shared, though, so copies
  // recognise each other by the host id and the newest one wins. Same-or-older
  // hosts are removed — after a reload the previous card is dead DOM that no
  // script will drive again.
  const cedeAnte = (rival) => rival && rival !== host && cmpVersion(rival.dataset.version || '0', VERSION) > 0;
  for (const otro of document.querySelectorAll('#' + HOST_ID)) {
    if (cmpVersion(otro.dataset.version || '0', VERSION) <= 0) otro.remove();
  }
  if (document.getElementById(HOST_ID)) return; // a strictly newer copy owns the page

  window.__englishCoachOverlay = { version: VERSION, ping: () => chrome.runtime.id };

  const CSS = `
    :host { all: initial; }
    .card {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      width: 380px; height: calc(100vh - 32px); max-height: calc(100vh - 32px); max-width: 92vw;
      min-width: 280px; min-height: 220px; resize: both;
      display: none; flex-direction: column;
      background: #16181c; color: #e8eaed; border: 1px solid #2c3038;
      border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.45);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      overflow: hidden;
    }
    .card.show { display: flex; }
    /* Idle shows only status and the start button: full height is for sessions. */
    .card.idle { height: auto; }

    /* Discreet pill when no session is running: the way to start without
       depender de la barra de extensiones ni del panel lateral. */
    .pill {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      display: flex; align-items: center; gap: 7px;
      background: #16181c; color: #e8eaed; border: 1px solid #2c3038;
      border-radius: 999px; padding: 7px 13px; cursor: pointer; opacity: .55;
      box-shadow: 0 4px 14px rgba(0,0,0,.35);
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      transition: opacity .15s;
    }
    .pill:hover { opacity: 1; }
    .pill.hide { display: none; }
    .pill .mic { font-size: 13px; }
    .card.min { height: auto; max-height: none; min-height: 0; resize: none; }
    .card.min .body, .card.min .foot { display: none; }

    .head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #1e2126; border-bottom: 1px solid #2c3038; cursor: grab;
      user-select: none;
    }
    .head:active { cursor: grabbing; }
    .ver { font-size: 10px; color: #6b7280; flex: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #e03131; flex: none; }
    .dot.off { background: #6b7280; animation: none; }
    .dot { animation: pulse 1.4s infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .title { font-weight: 600; font-size: 12px; flex: 1; }
    .head button {
      background: transparent; border: 1px solid #2c3038; color: #9aa0a6;
      border-radius: 6px; font-size: 11px; padding: 2px 6px; cursor: pointer;
      font-family: inherit;
    }
    .head button:hover { color: #e8eaed; }

    /* Only the turns scroll: the coach (chips, openers, reply) stays pinned, or
       a growing conversation pushes the help out of sight — exactly when the
       learner needs it. */
    .body { padding: 9px 10px; flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .status { color: #9aa0a6; font-size: 11px; margin: 0 0 7px; }
    .status.error { color: #ef6a5c; }
    .status.ok { color: #51cf66; }
    .live-note { color: #d9a441; font-size: 10.5px; margin: -4px 0 7px; line-height: 1.35; }
    .card.idle .live-note { display: none; }

    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip {
      background: #22262c; border: 1px solid #2c3038; border-radius: 999px;
      padding: 3px 9px; font-size: 12px;
    }
    .chip b { font-weight: 600; }
    .chip i { color: #9aa0a6; font-style: normal; font-size: 11px; }

    .phrases { display: flex; flex-wrap: wrap; gap: 5px; }
    .notes { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
    .note-head {
      width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
      color: #e8eaed; font: inherit; font-size: 12px; padding: 2px 0;
    }
    .note-body { margin: 2px 0 5px 14px; white-space: pre-wrap; font-size: 11.5px; color: #bdc1c6; }
    .notes:empty, .phrases:empty { display: none; }
    .card.idle .phrases, .card.idle .notes { display: none; }

    /* Hidden by a class, not :empty — the box always holds its status and group
       skeleton, so :empty never matches and an idle blue strip would show. */
    .reply {
      margin-top: 9px; padding: 8px 9px; border-radius: 8px;
      background: #1e3a5f; border: 1px solid #2b5288; font-size: 13px;
      display: none; max-height: 40%; flex: none; position: relative;
    }
    .reply.show { display: flex; flex-direction: column; }
    .reply-scroll { overflow-y: auto; min-height: 0; padding-right: 14px; }
    .reply-close {
      position: absolute; top: 4px; right: 5px; z-index: 1;
      background: transparent; border: none; color: #9aa0a6;
      font-size: 11px; cursor: pointer; padding: 2px 4px;
    }
    .reply-close:hover { color: #e8eaed; }
    .reply-status { color: #9aa0a6; font-size: 12px; }
    .reply-group { margin-top: 7px; }
    .reply-label { display: block; font-size: 10px; color: #9aa0a6;
      text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
    .reply-list { display: flex; flex-direction: column; gap: 4px; }
    .reply-item {
      text-align: left; width: 100%; padding: 6px 8px; border-radius: 8px;
      background: #22262c; border: 1px solid #2c3038; color: #e8eaed;
      font: inherit; font-size: 12.5px; line-height: 1.4; cursor: pointer;
    }
    .reply-item:hover { border-color: #3a4048; }
    .reply-item.copied { border-color: #4c8bf5; }
    .reply-item b { font-weight: 600; }
    .reply-item i { display: block; color: #9aa0a6; font-size: 11px; margin-top: 2px; }

    /* One answer, read out loud at a glance: big and calm, only the key term
       bold. The study ideas stay small — they are for after the conversation. */
    .reply-group.answer .reply-item { font-size: 15px; line-height: 1.5; }
    .reply-group.answer .reply-item .rich b { font-weight: 700; }
    .reply-group.ideas .reply-item { font-size: 11.5px; opacity: .9; }
    .reply-group.ideas .reply-item b { font-weight: 400; }

    .turns { margin-top: 10px; display: flex; flex-direction: column; gap: 5px;
      flex: 1; min-height: 0; overflow-y: auto; }
    .turn { font-size: 12px; padding: 5px 8px; border-radius: 8px; background: #24272d; }
    .turn.me { background: #1e3a5f; }
    .turn span { display: block; font-size: 10px; color: #9aa0a6; }
    .turn .es { display: block; color: #9aa0a6; font-size: 11px; font-style: italic; margin-top: 3px; }
    .partial { margin-top: 5px; font-size: 12px; padding: 5px 8px; border-radius: 8px;
      background: #24272d; border: 1px dashed #3a3f47; opacity: .75; }
    .partial .es { display: block; color: #9aa0a6; font-size: 11px; font-style: italic; margin-top: 3px; }
    .card.idle .partial { display: none; }

    .foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #2c3038; }
    .foot button {
      flex: 1; background: #2f6fed; color: #fff; border: none; border-radius: 8px;
      padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: inherit; font-weight: 600;
    }
    .foot button.ghost { background: #22262c; color: #e8eaed; border: 1px solid #2c3038; font-weight: 400; }
    .card.idle .reply-btn, .card.idle .stop-btn { display: none; }
    .card:not(.idle) .start-btn { display: none; }
    .card.idle .turns, .card.idle .chips, .card.idle .reply { display: none; }
  `;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.version = VERSION;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="pill" title="English Coach"><span class="mic">🎙</span><span>English Coach</span></div>
    <div class="card" part="card">
      <div class="head">
        <span class="dot"></span>
        <span class="title">English Coach</span>
        <span class="ver"></span>
        <button class="min-btn" title="Plegar">–</button>
        <button class="close-btn" title="Ocultar">✕</button>
      </div>
      <div class="body">
        <p class="status">Grabando…</p>
        <p class="live-note" hidden></p>
        <div class="chips"></div>
        <div class="phrases"></div>
        <div class="notes"></div>
        <div class="turns"></div>
        <div class="partial" hidden><span class="partial-en"></span><span class="es"></span></div>
        <div class="reply">
          <button class="reply-close" title="Cerrar sugerencia">✕</button>
          <div class="reply-scroll">
            <p class="reply-status"></p>
            <div class="reply-group answer" hidden>
              <span class="reply-label">Di esto</span><div class="reply-list"></div>
            </div>
            <div class="reply-group ideas" hidden>
              <span class="reply-label">Para estudiar después</span><div class="reply-list"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="foot">
        <button class="start-btn">● Empezar a transcribir</button>
        <button class="reply-btn">💡 Respuesta</button>
        <button class="stop-btn ghost">■ Detener</button>
      </div>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  root.querySelector('.ver').textContent = 'v' + VERSION;
  const card = $('.card');
  const turns = [];

  const pill = $('.pill');

  let translateOn = true;

  // Local copy of translate.js: a content script cannot import modules.
  let translator = null;
  let translatorState = 'idle';

  async function ensureTranslator() {
    if (translatorState === 'ready') return translator;
    if (translatorState === 'unavailable') return null;
    if (typeof Translator === 'undefined') { translatorState = 'unavailable'; return null; }
    try {
      const opts = { sourceLanguage: 'en', targetLanguage: 'es' };
      if ((await Translator.availability(opts)) === 'unavailable') {
        translatorState = 'unavailable';
        return null;
      }
      translator = await Translator.create(opts);
      translatorState = 'ready';
      return translator;
    } catch {
      translatorState = 'unavailable';
      return null;
    }
  }

  async function toSpanish(text) {
    if (!text) return '';
    const t = await ensureTranslator();
    if (!t) return '';
    try {
      return (await t.translate(text)).trim();
    } catch {
      return '';
    }
  }

  // idle: just the pill (or the collapsed card, to start).
  // running: the full card with chips, turns and reply.
  function setMode(mode) {
    const running = mode === 'running';
    card.classList.toggle('idle', !running);
    $('.dot').classList.toggle('off', !running);
    if (running) { card.classList.add('show'); pill.classList.add('hide'); }
  }

  function show(v) {
    card.classList.toggle('show', v);
    pill.classList.toggle('hide', v);
  }

  function setStatus(text, kind = '') {
    const el = $('.status');
    el.textContent = text;
    el.className = 'status ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
  }

  function addTurn(entry) {
    // A repeated (speaker, t) is a turn that grew by folding: replace it. The
    // fresh object has no cached `es`, so the merged text is retranslated whole.
    const i = turns.findIndex((x) => x.t === entry.t && x.speaker === entry.speaker);
    if (i >= 0) turns[i] = entry;
    else turns.push(entry);
    const box = $('.turns');
    box.innerHTML = '';
    for (const t of [...turns].sort((a, b) => a.t - b.t).slice(-12)) {
      const div = document.createElement('div');
      div.className = 'turn ' + (t.speaker === 'me' ? 'me' : 'them');
      const who = document.createElement('span');
      who.textContent = t.speaker === 'me' ? 'Yo' : 'Interlocutor';
      const p = document.createElement('div');
      p.textContent = t.text;
      div.append(who, p);
      if (t.speaker !== 'me' && translateOn) {
        const es = document.createElement('span');
        es.className = 'es';
        div.append(es);
        // Same as in the panel: addTurn rebuilds the list on every turn, so the
        // translation lives on the turn, not on the node.
        if (t.es) es.textContent = t.es;
        else toSpanish(t.text).then((txt) => { if (txt) { t.es = txt; es.textContent = txt; } });
      }
      box.append(div);
    }
    box.scrollTop = box.scrollHeight;
  }

  // What the learner loses when Chrome's on-device recognition is missing depends
  // on whether the Whisper preview lane can stand in: with it there is still live
  // English, in ~1 s pieces instead of word by word. Saying "sin transcripción en
  // vivo" when text is in fact appearing would just read as a broken extension.
  function liveNotice({ state: st, detail, fallback }) {
    if (!st || st === 'available' || st === 'unknown') return '';
    if (st === 'downloading') return 'Descargando el paquete de idioma…';
    const porque = {
      unsupported: 'este Chrome no lo expone donde grabamos',
      unavailable: 'el reconocimiento local no está disponible aquí',
      downloadable: 'falta el paquete de idioma',
      slow: 'este equipo transcribe demasiado despacio',
      error: detail ? 'falló el reconocimiento local (' + detail + ')' : 'falló el reconocimiento local',
    }[st] || 'el reconocimiento local no está disponible aquí';
    return fallback
      ? 'En vivo con Whisper, no palabra por palabra: ' + porque + '.'
      : 'Sin transcripción en vivo: ' + porque + '.';
  }

  function showLiveNote(msg) {
    const el = $('.live-note');
    const texto = msg ? liveNotice(msg) : '';
    el.textContent = texto;
    el.hidden = !texto;
  }

  // Interim results arrive word by word. A debounce would reset on every word and
  // never fire while the speaker keeps talking — exactly when the translation is
  // needed — so this throttles instead: at most one translation per second, always
  // of the latest text, applied in order so a slow response cannot overwrite a
  // newer one.
  let partialTimer = null;
  let partialTrAt = 0;
  let partialTrSeq = 0;
  let partialTrShown = 0;
  const PARTIAL_TR_MS = 1000;

  function showPartial(text) {
    const box = $('.partial');
    const en = $('.partial-en');
    const es = $('.partial .es');
    clearTimeout(partialTimer);
    if (!text) {
      // Invalidate any in-flight translation too: clearTimeout cannot cancel a
      // promise, and a late resolution would paint the previous phrase's
      // Spanish under the next phrase's English.
      partialTrShown = ++partialTrSeq;
      box.hidden = true;
      en.textContent = '';
      es.textContent = '';
      return;
    }
    box.hidden = false;
    en.textContent = text;
    if (!translateOn) return;
    const wait = Math.max(0, PARTIAL_TR_MS - (Date.now() - partialTrAt));
    partialTimer = setTimeout(() => {
      partialTrAt = Date.now();
      const id = ++partialTrSeq;
      toSpanish(en.textContent).then((txt) => {
        if (txt && id > partialTrShown) { partialTrShown = id; es.textContent = txt; }
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

  function fillGroup(box, items, rich = false) {
    const list = box.querySelector('.reply-list');
    list.innerHTML = '';
    box.hidden = !items.length;
    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = 'reply-item';
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
      // One click copies: mid-conversation there is no time to select text.
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(item.en.replace(/\*\*/g, '')).catch(() => {});
        btn.classList.add('copied');
      });
      list.append(btn);
    }
  }

  function showReply({ answer = [], ideas = [], pending = false, error = '' } = {}) {
    const aviso = pending ? 'Pensando…' : error;
    $('.reply-status').textContent = aviso;
    fillGroup($('.reply-group.answer'), pending || error ? [] : answer, true);
    fillGroup($('.reply-group.ideas'), pending || error ? [] : ideas);
    $('.reply').classList.toggle('show', !!(aviso || answer.length || ideas.length));
  }

  function showChips({ phrases = [], notes = [] }) {
    const lane = $('.phrases');
    lane.textContent = '';
    for (const p of phrases) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const en = document.createElement('b');
      en.textContent = p.en;
      chip.append(en);
      if (p.es) {
        const es = document.createElement('i');
        es.textContent = ' · ' + p.es;
        chip.append(es);
      }
      lane.append(chip);
    }

    const list = $('.notes');
    list.textContent = '';
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
      // The content script has no chrome.storage: the toggle goes through the router.
      head.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_NOTE', id: n.id }).catch(() => {});
      });
      item.append(head, body);
      list.append(item);
    }
  }

  // --- dragging the card ---------------------------------------------------
  let drag = null;
  $('.head').addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const r = card.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - drag.dx));
    const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    card.style.right = 'auto';
    card.style.bottom = 'auto';
  });
  window.addEventListener('mouseup', () => { drag = null; });

  const HINT_ATAJO = navigator.platform.includes('Mac')
    ? 'Para el audio de esta pestaña, pulsa ⌘⇧S (Chrome sólo lo permite así).'
    : 'Para el audio de esta pestaña, pulsa Ctrl+Shift+S (Chrome sólo lo permite así).';

  // After an extension reload, this copy's chrome.runtime dies and sendMessage
  // throws SYNCHRONOUSLY — a .catch on its promise never sees it. Route every
  // send through here so an orphaned card says what to do instead of freezing.
  const MSG_RECARGA = 'La extensión se actualizó. Recarga la página para reconectar el coach.';
  const invalidated = (e) => /context invalidated/i.test(String(e?.message || e));

  // Chrome only grants tab-audio capture to an extension invocation (icon,
  // shortcut, context menu); a click inside the page does not count. The click
  // still tries START: if the extension was already invoked on this tab (an
  // earlier session, the icon) the pill starts the session by itself, and any
  // non-tab source starts unconditionally. Only when Chrome refuses does the
  // card fall back to the shortcut instructions. quiet: the error is painted
  // here, so the service worker must not also fire a system notification.
  let starting = false;
  async function tryStart() {
    if (starting) return;
    starting = true;
    show(true);
    setStatus('Iniciando captura…');
    try {
      ensureTranslator();
      const res = await chrome.runtime.sendMessage({ type: 'START', quiet: true });
      if (res && res.ok) { setMode('running'); setStatus('Grabando…', 'ok'); }
      else setStatus(res?.error || HINT_ATAJO, 'error');
    } catch (e) {
      setStatus(invalidated(e) ? MSG_RECARGA : String(e?.message || e), 'error');
    } finally {
      starting = false;
    }
  }

  pill.addEventListener('click', tryStart);
  $('.min-btn').addEventListener('click', () => card.classList.toggle('min'));
  $('.close-btn').addEventListener('click', () => {
    card.classList.remove('show');
    // Closing mid-session leaves the pill available to come back.
    pill.classList.remove('hide');
  });

  $('.start-btn').addEventListener('click', tryStart);
  // Done reading the suggestion: give its space back to the conversation.
  $('.reply-close').addEventListener('click', () => showReply({}));
  $('.reply-btn').addEventListener('click', () => {
    try {
      showReply({ pending: true });
      chrome.runtime.sendMessage({ type: 'SUGGEST_REPLY' }).catch(() => {});
    } catch (e) {
      if (invalidated(e)) { showReply({}); setStatus(MSG_RECARGA, 'error'); }
    }
  });
  $('.stop-btn').addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {});
    } catch (e) {
      if (invalidated(e)) setStatus(MSG_RECARGA, 'error');
    }
  });

  // --- messages from the rest of the extension -----------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'ui') return;
    switch (msg.type) {
      case 'RUNNING':
        setMode(msg.running ? 'running' : 'idle');
        if (msg.running) { show(true); setStatus('Grabando…', 'ok'); }
        else { showPartial(''); showLiveNote(null); setStatus('Sesión terminada. El informe se está generando.'); }
        break;
      case 'STATUS': if (msg.show) show(true); setStatus(msg.text, msg.kind); break;
      case 'SEGMENT': show(true); addTurn(msg.entry); break;
      case 'COACH_CHIPS': showChips(msg); break;
      case 'REPLY': show(true); showReply(msg); break;
      case 'QUEUE': if (msg.pending > 0) setStatus(`Transcribiendo… (${msg.pending})`); break;
      case 'PARTIAL': if (msg.text) show(true); showPartial(msg.text); break;
      case 'LIVE_STATE': if (msg.state !== 'available') showPartial(''); showLiveNote(msg); break;
      default: break;
    }
  });

  setMode('idle');

  // Evicts overlays from same-or-older copies. getElementById returns only the
  // first, so we walk them all in case duplicate ids ended up in the DOM.
  const evict = () => {
    for (const otro of document.querySelectorAll('#' + HOST_ID)) {
      if (otro === host) continue;
      if (cmpVersion(otro.dataset.version || '0', VERSION) <= 0) otro.remove();
    }
  };
  window.__englishCoachOverlay.evict = evict;

  const mount = () => {
    // The check is repeated: the other copy may have mounted its overlay between
    // this script being evaluated and DOMContentLoaded.
    const rival = document.getElementById(HOST_ID);
    if (cedeAnte(rival)) return;
    evict();
    (document.body || document.documentElement).append(host);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  // If a session was already running (page reload or tab switch), the bar comes
  // back with the last known state: turns, chips and reply.
  chrome.runtime.sendMessage({ type: 'UI_SYNC' })
    .then((st) => {
      if (!st) return;
      translateOn = st.translate !== false;
      if (st.reply) showReply(st.reply);
      if (!st.running) return;
      setMode('running');
      show(true);
      setStatus('Grabando…', 'ok');
      showLiveNote(st.live);
      for (const t of st.turns || []) addTurn(t);
      if (st.chips) showChips(st.chips);
    })
    .catch(() => {});
})();
