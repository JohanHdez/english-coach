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
    .pill.dragging { opacity: 1; cursor: grabbing; transition: none; }
    .pill .mic { font-size: 13px; }
    .pill-x {
      display: none; background: transparent; border: 0; color: #9aa0a6;
      font: inherit; font-size: 12px; line-height: 1; cursor: pointer; padding: 0;
    }
    .pill:hover .pill-x { display: block; }
    .pill-x:hover { color: #e8eaed; }
    .card.min { height: auto; max-height: none; min-height: 0; resize: none; }
    .card.min .body, .card.min .foot { display: none; }

    .head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #1e2126; border-bottom: 1px solid #2c3038; cursor: grab;
      user-select: none;
    }
    .head:active { cursor: grabbing; }
    .ver { font-size: 10px; color: #6b7280; flex: none; }
    .clock { font-size: 11px; color: #9aa0a6; flex: none; font-variant-numeric: tabular-nums; }
    .clock[hidden] { display: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #e03131; flex: none; }
    .dot.off { background: #6b7280; animation: none; }
    .dot.paused { background: #d9a441; animation: none; }
    .dot { animation: pulse 1.4s infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .title { font-weight: 600; font-size: 12px; flex: 1; }
    .head button {
      background: transparent; border: 1px solid #2c3038; color: #9aa0a6;
      border-radius: 6px; font-size: 11px; padding: 2px 6px; cursor: pointer;
      font-family: inherit;
    }
    .head button:hover { color: #e8eaed; }

    /* Only the turns scroll: the coach (phrases, notes, reply) stays pinned, or
       a growing conversation pushes the help out of sight — exactly when the
       learner needs it. */
    .body { position: relative; padding: 9px 10px; flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    /* Silent while all is well: the pulsing dot and the clock already say the
       session is running, so the line is spent on what they cannot say. */
    .status { color: #9aa0a6; font-size: 11px; margin: 0 0 7px; }
    .status:empty { display: none; }
    .status.error { color: #ef6a5c; }
    .status.ok { color: #51cf66; }
    .live-note { color: #d9a441; font-size: 10.5px; margin: -4px 0 7px; line-height: 1.35; }
    .card.idle .live-note { display: none; }

    /* The coach is a ceiling, not a floor: half the card at most, and less when
       the phrases fit in less. And only one pane is mounted at a time, so phrases
       and notes no longer both take room the way the two pinned lanes did. */
    .coach {
      flex: none; display: flex; flex-direction: column; max-height: 50%; min-height: 0;
      overflow: hidden; margin: 0 -10px 9px; padding: 0 10px 9px;
      border-bottom: 1px solid #2c3038;
    }
    .coach[hidden] { display: none; }
    .card.idle .coach { display: none; }

    .tabs { display: flex; gap: 18px; align-items: center; flex: none;
      margin: 0 -10px 9px; padding: 0 10px; border-bottom: 1px solid #2c3038; }
    .tab {
      background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px;
      color: #9aa0a6; font: inherit; font-size: 12.5px; padding: 7px 0 8px; cursor: pointer;
      display: flex; gap: 6px; align-items: center;
    }
    .tab.on { color: #e8eaed; font-weight: 600; border-bottom-color: #2f6fed; }
    .tab[hidden] { display: none; }
    .count {
      font-size: 10.5px; color: #9aa0a6; background: #22262c; border: 1px solid #2c3038;
      border-radius: 999px; padding: 0 5px; font-weight: 400;
    }

    .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .pane[hidden] { display: none; }

    .cats { display: flex; gap: 5px; flex: none; overflow-x: auto; padding-bottom: 9px; }
    .cats:empty { display: none; }
    .cat {
      flex: none; background: #22262c; border: 1px solid #2c3038; color: #9aa0a6;
      border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 11.5px; cursor: pointer;
    }
    .cat.on { background: #2f6fed; border-color: #2f6fed; color: #fff; font-weight: 600; }

    .chip-list, .note-list { flex: 1; min-height: 0; overflow-y: auto;
      display: flex; flex-direction: column; gap: 6px; }
    /* The default bar paints a pale slab down a dark card. Thumb only, in the
       accent, so a scrollable region reads as one without costing a column. */
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb {
      background: rgba(47,111,237,.55); border-radius: 999px;
      border: 3px solid transparent; background-clip: padding-box;
    }
    *::-webkit-scrollbar-thumb:hover { background: #2f6fed; background-clip: padding-box; }
    *::-webkit-scrollbar-corner { background: transparent; }

    .chip { background: #22262c; border: 1px solid #2c3038; border-radius: 10px;
      padding: 7px 10px; font-size: 13px; }
    .chip b { font-weight: 600; }
    .chip i { display: block; color: #9aa0a6; font-style: normal; font-size: 11.5px; margin-top: 2px; }

    .note { background: #1a1d21; border: 1px solid #2c3038; border-radius: 10px; padding: 8px 11px; }
    .note-head {
      width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
      color: #d9a441; font: inherit; font-size: 12.5px; padding: 0;
    }
    .note-body { margin: 6px 0 0; white-space: pre-wrap; font-size: 12px; color: #bdc1c6; line-height: 1.6; }
    .note-add { margin-top: 8px; }
    .note-add > summary { cursor: pointer; font-size: 12px; color: #9aa0a6; list-style: none; }
    .note-add > summary::-webkit-details-marker { display: none; }
    .note-form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .note-form input, .note-form textarea { width: 100%; box-sizing: border-box; background: #1a1d21; color: #e8eaed; border: 1px solid #2c3038; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; }
    .note-save { align-self: flex-start; }

    /* Hidden by a class, not :empty — the box always holds its status and group
       skeleton, so :empty never matches and an idle blue strip would show. */
    /* The reply takes the coach panel over instead of opening a third band. A band
       of its own is what drove the conversation down to its 72px floor exactly when
       the learner needed to see what was being answered. */
    .reply {
      padding: 8px 9px; border-radius: 10px;
      background: #1e3a5f; border: 1px solid #2b5288; font-size: 13px;
      display: none; flex: 1; min-height: 0; position: relative;
    }
    .coach.replying .reply { display: flex; flex-direction: column; }
    .coach.replying .tabs, .coach.replying .pane { display: none; }
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

    /* A floor, not just a scrollbar: without it the lanes and the reply would take
       everything and the conversation would be laid out at zero height. */
    .turns-wrap { position: relative; flex: 1; min-height: 72px; display: flex; }
    .turns { display: flex; flex-direction: column; gap: 5px;
      flex: 1; min-height: 0; overflow-y: auto; }

    /* Scrolling up is reading, not a mistake to correct: the conversation stays put
       and this says how much arrived meanwhile. */
    .jump {
      pointer-events: auto; z-index: 2;
      background: #2f6fed; color: #fff; border: none; border-radius: 999px;
      padding: 5px 12px; font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.45);
    }
    .jump[hidden] { display: none; }

    /* Stacked over the foot of the conversation: the counter on top, and under it
       the last thing the other person said, so a question stays readable while the
       learner scrolls back for something else. */
    .overlays {
      position: absolute; left: 0; right: 0; bottom: 0; padding-bottom: 4px;
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      pointer-events: none;
    }
    .sticky {
      pointer-events: auto; align-self: stretch; max-height: 46%; overflow-y: auto;
      font-size: 12px; padding: 6px 8px; border-radius: 8px;
      background: #24272d; border: 1px solid #3a4048;
      box-shadow: 0 6px 20px rgba(0,0,0,.5);
    }
    .sticky[hidden] { display: none; }

    /* Where the learner left off. Placed at the head of the unread run and spent
       the moment they answer — a bookmark, not a second counter. */
    .unread-mark { display: flex; align-items: center; gap: 8px; margin: 1px 0; }
    .unread-mark::before, .unread-mark::after {
      content: ''; flex: 1; height: 1px; background: rgba(47,111,237,.45);
    }
    .unread-mark span {
      font-size: 9.5px; color: #6ea8fe; letter-spacing: .05em; text-transform: uppercase;
      white-space: nowrap;
    }
    .sticky .who { display: block; font-size: 10px; color: #d9a441; margin-bottom: 2px; }
    .sticky .es { display: block; color: #9aa0a6; font-size: 11px; font-style: italic; margin-top: 3px; }
    .turn { font-size: 12px; padding: 5px 8px; border-radius: 8px; background: #24272d; }
    .turn.me { background: #1e3a5f; }
    .turn span { display: block; font-size: 10px; color: #9aa0a6; }
    /* Which language the turn was spoken in. Small and quiet: it matters when scanning
       a bilingual meeting and must not compete with the words. Overriding .turn span's
       block display keeps it inline next to the speaker label. */
    .turn .lang-tag {
      display: inline-block; font-size: 9px; letter-spacing: .06em; padding: 0 3px;
      border-radius: 3px; border: 1px solid #3a4048; color: #9aa0a6;
    }
    .turn .es { display: block; color: #9aa0a6; font-size: 11px; font-style: italic; margin-top: 3px; }
    .turn .es.stale { opacity: .6; }
    /* No blanket opacity: the dashed border already says provisional, and dimming
       the box on top of dimming the unsettled tail left a fresh phrase — which has
       nothing settled yet — barely readable. */
    .partial { margin-top: 5px; font-size: 12px; padding: 5px 8px; border-radius: 8px;
      background: #24272d; border: 1px dashed #3a3f47; }
    /* The learner's own line wears their bubble colour, so the two voices read
       apart at a glance even while both are provisional. */
    .partial.me { background: #1e3a5f; }
    .partial .who { display: block; font-size: 10px; color: #9aa0a6; }
    /* Settled text reads like the conversation; the tail is still a guess and says
       so, so nothing appears to mutate behind whoever is reading. */
    .partial-tail { color: #c3c7cd; }
    .partial .es { display: block; color: #9aa0a6; font-size: 11px; font-style: italic; margin-top: 3px; }
    .card.idle .partial { display: none; }

    .foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #2c3038; }
    .foot button {
      flex: 1; background: #2f6fed; color: #fff; border: none; border-radius: 8px;
      padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: inherit; font-weight: 600;
    }
    .foot button.ghost { background: #22262c; color: #e8eaed; border: 1px solid #2c3038; font-weight: 400; }
    .card.idle .reply-btn, .card.idle .pause-btn, .card.idle .stop-btn { display: none; }
    .card:not(.idle) .start-btn { display: none; }
    .card.idle .turns-wrap { display: none; }
  `;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.version = VERSION;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="pill hide" title="English Coach — arrástrame para moverme"><span class="mic">🎙</span><span>English Coach</span><button class="pill-x" type="button" title="No mostrar en este sitio">✕</button></div>
    <div class="card" part="card">
      <div class="head">
        <span class="dot"></span>
        <span class="title">English Coach</span>
        <span class="clock" hidden></span>
        <span class="ver"></span>
        <button class="min-btn" title="Plegar">–</button>
        <button class="close-btn" title="Ocultar">✕</button>
      </div>
      <div class="body">
        <p class="status"></p>
        <p class="live-note" hidden></p>
        <div class="coach" hidden>
          <div class="tabs">
            <button class="tab tab-phrases" type="button">Frases <span class="count"></span></button>
            <button class="tab tab-notes" type="button">Notas <span class="count"></span></button>
          </div>
          <div class="pane phrases-pane">
            <div class="cats"></div>
            <div class="chip-list"></div>
          </div>
          <div class="pane notes-pane" hidden>
            <div class="note-list"></div>
            <details class="note-add">
              <summary>＋ Añadir nota</summary>
              <form class="note-form">
                <input class="note-title" type="text" placeholder="Título corto" />
                <textarea class="note-body-input" rows="3" placeholder="Lo que quieras tener a mano ahora mismo"></textarea>
                <button class="note-save" type="submit">Guardar nota</button>
              </form>
            </details>
          </div>
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
        <div class="turns-wrap">
          <div class="turns"></div>
          <div class="overlays">
            <button class="jump" type="button" hidden></button>
            <div class="sticky" hidden></div>
          </div>
        </div>
        <div class="partial them" hidden><span class="who">Interlocutor · hablando ahora</span><span class="partial-en"></span><span class="partial-tail"></span><span class="es"></span></div>
        <div class="partial me" hidden><span class="who">Yo · hablando ahora</span><span class="partial-en"></span><span class="partial-tail"></span></div>
      </div>
      <div class="foot">
        <button class="start-btn">● Empezar a transcribir</button>
        <button class="reply-btn">💡 Respuesta</button>
        <button class="pause-btn ghost">⏸ Pausar</button>
        <button class="stop-btn ghost">■ Finalizar</button>
      </div>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  root.querySelector('.ver').textContent = 'v' + VERSION;
  const card = $('.card');
  const turns = [];
  // The turns a view holds belong to one session. RUNNING carries the session id
  // rather than a "clear now" flag so that replaying it is a no-op: the overlay is
  // re-injected on every tab switch and page reload.
  let lastSession = 0;

  const pill = $('.pill');
  // The pill starts hidden and only appears once UI_SYNC answers. Painting it first
  // and hiding it a moment later would flash it on every load of a site the learner
  // already told us to stay off.
  let pillAllowed = true;

  // Anchored to the bottom-right corner rather than to x/y: the page can be resized
  // or zoomed between sessions and a stored viewport coordinate would drift off screen.
  function applyPillPos(pos) {
    if (!pos) return;
    const w = pill.offsetWidth || 140;
    const h = pill.offsetHeight || 32;
    const right = Math.min(Math.max(pos.right, 0), Math.max(0, window.innerWidth - w));
    const bottom = Math.min(Math.max(pos.bottom, 0), Math.max(0, window.innerHeight - h));
    pill.style.right = right + 'px';
    pill.style.bottom = bottom + 'px';
  }

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
  // running: the full card with phrases, turns and reply.
  // The dot says a session is live; the clock says how long. Between them the
  // status line is free for what only it can say — errors, the transcription queue.
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
    const el = $('.clock');
    const tick = () => { el.textContent = clockText(Date.now() - startedAt); };
    tick();
    el.hidden = false;
    clockTimer = setInterval(tick, 1000);
  }

  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    $('.clock').hidden = true;
  }

  function setMode(mode) {
    const running = mode === 'running';
    card.classList.toggle('idle', !running);
    $('.dot').classList.toggle('off', !running);
    if (running) { card.classList.add('show'); pill.classList.add('hide'); }
  }

  function setPaused(v) {
    card.classList.toggle('paused', v);
    $('.dot').classList.toggle('paused', v);
    $('.pause-btn').textContent = v ? '▶ Reanudar' : '⏸ Pausar';
  }

  function show(v) {
    card.classList.toggle('show', v);
    // Hiding the pill on a site never disables the extension there: the card still
    // opens from the icon, the shortcut or the context menu.
    if (!pillAllowed) { pill.classList.add('hide'); return; }
    pill.classList.toggle('hide', v);
  }

  function setStatus(text, kind = '') {
    const el = $('.status');
    el.textContent = text;
    el.className = 'status ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
  }

  // The DOM is capped, not rebuilt. Rebuilding threw the scroll position away on
  // every turn, which is why reading back was impossible while the session ran.
  const MAX_TURNS = 60;
  let atBottom = true;
  let stickyKey = null;
  let markEl = null;
  let markCount = 0;
  let unread = 0;

  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;

  function stickToBottom() {
    if (!atBottom) return;
    const box = $('.turns');
    box.scrollTop = box.scrollHeight;
  }

  // The last thing the other person said, kept on screen while the learner reads
  // back. It only gives way when they speak again — and what it displaces is what
  // the counter counts, so the number always means "below here, and unreadable".
  const latestThem = () => [...turns].reverse().find((t) => t.speaker !== 'me') || null;
  // An entry stored before languages existed reads as English, which is what it was.
  const langOf = (x) => (x && x.lang === 'es' ? 'es' : 'en');

  function renderSticky() {
    const box = $('.sticky');
    const t = atBottom ? null : latestThem();
    box.textContent = '';
    box.hidden = !t;
    stickyKey = t ? t.speaker + ':' + t.t : null;
    if (!t) return;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = 'Interlocutor · lo último';
    const p = document.createElement('div');
    p.textContent = t.text;
    box.append(who, p);
    if (t.es) {
      const es = document.createElement('span');
      es.className = 'es';
      es.textContent = t.es;
      box.append(es);
    }
  }

  function clearMark() {
    markEl?.remove();
    markEl = null;
    markCount = 0;
  }

  // Half a millisecond before the turn it heads, so insertByTime keeps sorting the
  // list by dataset.t without having to know the divider exists.
  function placeMark(box, t) {
    markEl = document.createElement('div');
    markEl.className = 'unread-mark';
    markEl.dataset.t = String(t - 0.5);
    markEl.append(document.createElement('span'));
    insertByTime(box, markEl, t - 0.5);
  }

  function paintMark() {
    if (!markEl) return;
    markEl.firstElementChild.textContent =
      markCount === 1 ? '1 mensaje sin leer' : `${markCount} mensajes sin leer`;
  }

  function paintJump() {
    const btn = $('.jump');
    btn.hidden = unread === 0;
    btn.textContent = unread === 1 ? '1 mensaje nuevo ↓' : `${unread} mensajes nuevos ↓`;
  }

  function resetTurns() {
    turns.length = 0;
    $('.turns').textContent = '';
    atBottom = true;
    unread = 0;
    clearMark();
    paintJump();
    renderSticky();
  }

  function turnNode(t) {
    const div = document.createElement('div');
    div.className = 'turn ' + (t.speaker === 'me' ? 'me' : 'them');
    div.dataset.t = t.t;
    div.dataset.key = t.speaker + ':' + t.t;
    const who = document.createElement('span');
    who.textContent = t.speaker === 'me' ? 'Yo' : 'Interlocutor';
    const tag = document.createElement('span');
    tag.className = 'lang-tag';
    tag.textContent = langOf(t) === 'es' ? 'ES' : 'EN';
    who.append(' · ', tag);
    const p = document.createElement('div');
    p.textContent = t.text;
    div.append(who, p);
    if (t.speaker !== 'me' && langOf(t) !== 'es' && translateOn) {
      const es = document.createElement('span');
      es.className = 'es';
      div.append(es);
      if (t.es) es.textContent = t.es;
      else {
        if (t.esStale) { es.textContent = t.esStale; es.classList.add('stale'); }
        toSpanish(t.text).then((txt) => {
          if (!txt) return;
          // Cached on the turn, not the node: the node can be replaced by a fold.
          t.es = txt;
          delete t.esStale;
          es.textContent = txt;
          es.classList.remove('stale');
          // The translation lands after the turn was painted and makes it taller. Without
          // this the newest line is left scrolled half out of sight the moment it arrives.
          stickToBottom();
          // The sticky card is a copy of this turn: it needs the Spanish too.
          if (stickyKey === t.speaker + ':' + t.t) renderSticky();
        });
      }
    }
    return div;
  }

  // Turns are folded and a 'them' segment can overtake the queue, so the newest is
  // not always the latest: walk back from the end instead of always appending.
  function insertByTime(box, node, t) {
    let ref = null;
    for (let el = box.lastElementChild; el; el = el.previousElementSibling) {
      if (Number(el.dataset.t) <= t) break;
      ref = el;
    }
    box.insertBefore(node, ref);
  }

  function addTurn(entry) {
    const i = turns.findIndex((x) => x.t === entry.t && x.speaker === entry.speaker);
    const isNew = i < 0;
    // A turn re-sent with the same words keeps its translation; one whose words
    // changed is retranslated and shows the old Spanish until the new one lands.
    const prev = isNew ? null : turns[i];
    if (prev && prev.text === entry.text) entry.es = prev.es;
    else if (prev && prev.es) entry.esStale = prev.es;
    if (isNew) turns.push(entry); else turns[i] = entry;

    const box = $('.turns');
    const node = turnNode(entry);
    const old = box.querySelector(`[data-key="${entry.speaker}:${entry.t}"]`);
    if (old) old.replaceWith(node);
    else insertByTime(box, node, entry.t);

    if (atBottom) {
      // Watching it happen live: any bookmark left over from an earlier run points
      // at something already read, so it goes rather than growing stale.
      if (isNew) clearMark();
      // Only trim while the learner is at the bottom: dropping a turn off the top
      // while they are reading history would yank the view out from under them.
      while (box.children.length > MAX_TURNS) box.firstElementChild.remove();
      stickToBottom();
    } else if (isNew) {
      // Answering is what spends the bookmark, exactly as it does in a chat app.
      if (entry.speaker === 'me') clearMark();
      else {
        if (!markEl) placeMark(box, entry.t);
        markCount++;
        paintMark();
      }
      // A new 'them' turn takes the card over, so what it displaces is what becomes
      // unreadable. A turn that merely grew by folding displaces nothing.
      if (entry.speaker === 'me' || stickyKey) unread++;
      renderSticky();
      paintJump();
    } else if (stickyKey === entry.speaker + ':' + entry.t) {
      renderSticky();
    }
  }

  $('.turns').addEventListener('scroll', () => {
    const was = atBottom;
    atBottom = nearBottom($('.turns'));
    if (atBottom !== was) { if (atBottom) { unread = 0; paintJump(); } renderSticky(); }
  });

  $('.jump').addEventListener('click', () => {
    unread = 0;
    paintJump();
    // To the divider, not to the foot: the useful place is where the unread run
    // starts. Without one there is nothing to land on, so the foot it is.
    if (markEl?.isConnected) {
      const box = $('.turns');
      const top = markEl.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTop = Math.max(0, top - 8);
      return;
    }
    atBottom = true;
    renderSticky();
    stickToBottom();
  });

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

  // Provisional text, one line per voice; only the other speaker's translates —
  // the learner needs no Spanish for what they just said themselves. Interim
  // results arrive word by word. A debounce would reset on every word and never
  // fire while the speaker keeps talking — exactly when the translation is
  // needed — so this throttles instead: at most one translation per second, always
  // of the latest text, applied in order so a slow response cannot overwrite a
  // newer one.
  let partialTimer = null;
  let partialTrAt = 0;
  let partialTrSeq = 0;
  let partialTrShown = 0;
  const PARTIAL_TR_MS = 1000;

  function showPartial(speaker, text, committed = '', lang = 'en') {
    const box = $(speaker === 'me' ? '.partial.me' : '.partial.them');
    const en = box.querySelector('.partial-en');
    const tail = box.querySelector('.partial-tail');
    const es = box.querySelector('.es');
    if (es) clearTimeout(partialTimer);
    if (!text) {
      if (es) {
        // Invalidate any in-flight translation too: clearTimeout cannot cancel a
        // promise, and a late resolution would paint the previous phrase's
        // Spanish under the next phrase's English.
        partialTrShown = ++partialTrSeq;
        es.textContent = '';
      }
      box.hidden = true;
      en.textContent = '';
      tail.textContent = '';
      return;
    }
    box.hidden = false;
    // committed is always a prefix of text; verify it rather than trust it, so a
    // malformed message degrades to the old behaviour instead of losing words.
    const settled = committed && text.startsWith(committed) ? committed : '';
    en.textContent = settled;
    tail.textContent = text.slice(settled.length);
    if (!es || !translateOn || lang === 'es') return;
    const wait = Math.max(0, PARTIAL_TR_MS - (Date.now() - partialTrAt));
    partialTimer = setTimeout(() => {
      partialTrAt = Date.now();
      const id = ++partialTrSeq;
      toSpanish(text).then((txt) => {
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
    $('.coach').classList.toggle('replying', !!(aviso || answer.length || ideas.length));
    syncCoach();
  }

  // Which pane is open and which category is filtered are view state, not session
  // state: they survive a re-render but nothing else depends on them.
  let coachData = { phrases: [], notes: [] };
  let tab = 'phrases';
  let cat = null;

  function showChips({ phrases = [], notes = [] } = {}) {
    coachData = { phrases, notes };
    const cats = [...new Set(phrases.map((p) => p.cat))];
    if (!cats.includes(cat)) cat = cats[0] || null;
    renderCoach();
  }

  function renderCoach() {
    const { phrases, notes } = coachData;
    const cats = [...new Set(phrases.map((p) => p.cat))];

    // A tab with nothing behind it is a dead end: hide it and, if it was the open
    // one, fall through to the tab that does have something.
    $('.tab-phrases').hidden = !phrases.length;
    $('.tab-notes').hidden = false;
    $('.tab-phrases .count').textContent = phrases.length;
    $('.tab-notes .count').textContent = notes.length;
    if (tab === 'phrases' && !phrases.length) tab = 'notes';
    $('.tab-phrases').classList.toggle('on', tab === 'phrases');
    $('.tab-notes').classList.toggle('on', tab === 'notes');
    $('.phrases-pane').hidden = tab !== 'phrases';
    $('.notes-pane').hidden = tab !== 'notes';

    // One category is no choice, so the row only earns its space from two up.
    const catRow = $('.cats');
    catRow.textContent = '';
    if (cats.length > 1) {
      for (const c of cats) {
        const btn = document.createElement('button');
        btn.className = 'cat' + (c === cat ? ' on' : '');
        btn.type = 'button';
        btn.textContent = c;
        btn.addEventListener('click', () => { cat = c; renderCoach(); });
        catRow.append(btn);
      }
    }

    const list = $('.chip-list');
    list.textContent = '';
    for (const p of phrases.filter((x) => cats.length < 2 || x.cat === cat)) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      const en = document.createElement('b');
      en.textContent = p.en;
      chip.append(en);
      if (p.es) {
        const es = document.createElement('i');
        es.textContent = p.es;
        chip.append(es);
      }
      list.append(chip);
    }

    const noteList = $('.note-list');
    noteList.textContent = '';
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
      noteList.append(item);
    }

    syncCoach();
  }

  // The panel is worth its border only when it has something behind it.
  function syncCoach() {
    const has = coachData.phrases.length || coachData.notes.length;
    $('.coach').hidden = !(has || $('.coach').classList.contains('replying'));
  }

  $('.tab-phrases').addEventListener('click', () => { tab = 'phrases'; renderCoach(); });
  $('.tab-notes').addEventListener('click', () => { tab = 'notes'; renderCoach(); });

  $('.note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('.note-title').value;
    const body = $('.note-body-input').value;
    if (!title.trim() && !body.trim()) return;
    // The content script has no chrome.storage: the note goes through the router,
    // and COACH_CHIPS brings it back to every view.
    chrome.runtime.sendMessage({ type: 'ADD_NOTE', title, body }).catch(() => {});
    $('.note-form').reset();
    $('.note-add').open = false;
  });

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

  // Drag and click share one gesture, so a few pixels of travel decide which it was:
  // below the threshold the pointer sequence is treated as the click it looks like.
  const DRAG_SLOP = 4;
  let pillDrag = null;

  pill.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pill-x')) return;
    const r = pill.getBoundingClientRect();
    pillDrag = {
      x: e.clientX, y: e.clientY, moved: false,
      right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom,
    };
    pill.setPointerCapture(e.pointerId);
  });

  pill.addEventListener('pointermove', (e) => {
    if (!pillDrag) return;
    const dx = e.clientX - pillDrag.x;
    const dy = e.clientY - pillDrag.y;
    if (!pillDrag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    pillDrag.moved = true;
    pill.classList.add('dragging');
    applyPillPos({ right: pillDrag.right - dx, bottom: pillDrag.bottom - dy });
  });

  pill.addEventListener('pointerup', () => {
    const drag = pillDrag;
    pillDrag = null;
    pill.classList.remove('dragging');
    if (!drag) return;
    if (!drag.moved) { tryStart(); return; }
    const r = pill.getBoundingClientRect();
    // The content script has no chrome.storage: the write goes through the router.
    chrome.runtime.sendMessage({
      type: 'PILL_POS',
      pos: {
        right: Math.round(window.innerWidth - r.right),
        bottom: Math.round(window.innerHeight - r.bottom),
      },
    }).catch(() => {});
  });

  $('.pill-x').addEventListener('click', (e) => {
    e.stopPropagation();
    pillAllowed = false;
    pill.classList.add('hide');
    chrome.runtime.sendMessage({ type: 'PILL_HIDE', host: location.hostname }).catch(() => {});
  });

  // A window narrowed since the position was stored would leave the pill off screen.
  window.addEventListener('resize', () => {
    if (!pill.style.right) return;
    applyPillPos({ right: parseInt(pill.style.right, 10), bottom: parseInt(pill.style.bottom, 10) });
  });
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
  $('.pause-btn').addEventListener('click', () => {
    try {
      const type = card.classList.contains('paused') ? 'RESUME' : 'PAUSE';
      chrome.runtime.sendMessage({ type }).catch(() => {});
    } catch (e) {
      if (invalidated(e)) setStatus(MSG_RECARGA, 'error');
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
        // Only on the way up: a view injected mid-session first hears RUNNING when
        // the session stops, and must not wipe the turns it just painted.
        if (msg.running && msg.session && msg.session !== lastSession) resetTurns();
        if (msg.running) setPaused(false);
        if (msg.session) lastSession = msg.session;
        setMode(msg.running ? 'running' : 'idle');
        if (msg.running) { show(true); setStatus(''); startClock(msg.session); }
        else { showPartial('them', ''); showPartial('me', ''); showLiveNote(null); stopClock(); setStatus('Sesión terminada. El informe se está generando.'); }
        break;
      case 'STATUS': if (msg.show) show(true); setStatus(msg.text, msg.kind); break;
      case 'SEGMENT': show(true); addTurn(msg.entry); break;
      case 'PAUSED': setPaused(msg.paused); break;
      case 'COACH_CHIPS': showChips(msg); break;
      case 'REPLY': show(true); showReply(msg); break;
      case 'QUEUE': if (msg.pending > 0) setStatus(`Transcribiendo… (${msg.pending})`); break;
      case 'PARTIAL': if (msg.text) show(true); showPartial(msg.speaker === 'me' ? 'me' : 'them', msg.text, msg.committed, msg.lang); break;
      case 'LIVE_STATE': if (msg.state !== 'available') showPartial('them', ''); showLiveNote(msg); break;
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
      // A failed sync must fall back to the pill as it always was, in its default
      // corner. Leaving it hidden would turn a dropped message into a missing button.
      if (!st) { show(false); return; }
      pillAllowed = !st.pillHidden;
      applyPillPos(st.pillPos);
      if (!st.running) show(false);
      translateOn = st.translate !== false;
      if (st.reply) showReply(st.reply);
      if (!st.running) return;
      setMode('running');
      show(true);
      setStatus('');
      startClock(st.startedAt);
      setPaused(!!(st.paused && st.paused.paused));
      showLiveNote(st.live);
      for (const t of st.turns || []) addTurn(t);
      if (st.chips) showChips(st.chips);
    })
    .catch(() => { show(false); });
})();
