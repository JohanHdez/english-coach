// Service worker: coordinates the side panel, the in-page overlay and the
// offscreen document (which does the recording, transcribing and coaching).

import { resolveChips } from './phrasebook.js';

const OFFSCREEN_URL = 'offscreen.html';

// The tab currently showing the overlay, plus the last broadcast state, so the
// bar can be rebuilt in any tab without losing what it was showing.
let sessionTabId = null;
let running = false;
let coachWindowId = null;
const lastUi = { hints: null, chips: null, reply: null, status: null, live: null };

// When a tab is shared, Chrome can leave the user in a window with no side panel
// and no extension bar: a system notification is the only thing they are
// guaranteed to see if something fails.
async function notify(message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'English Coach',
      message: String(message).slice(0, 300),
      priority: 2,
    });
  } catch { /* sin permiso de notificaciones */ }
}

// Floating window: a real Chrome window, independent of the tab, the side panel
// and the extension bar.
async function openCoachWindow() {
  try {
    if (coachWindowId !== null) {
      const win = await chrome.windows.get(coachWindowId).catch(() => null);
      if (win) { await chrome.windows.update(coachWindowId, { focused: true }); return coachWindowId; }
    }
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html?window=1'),
      type: 'popup',
      width: 400,
      height: 660,
    });
    coachWindowId = win.id;
    return win.id;
  } catch (e) {
    await notify('No se pudo abrir la ventana flotante: ' + (e.message || e));
    return null;
  }
}

chrome.windows.onRemoved.addListener((id) => { if (id === coachWindowId) coachWindowId = null; });

// Chrome only allows capturing a tab where the user has "invoked" the extension,
// and exactly three gestures count: clicking the icon, using a keyboard shortcut,
// or picking a context-menu entry. Nothing else works — not the side panel, not a
// button inside the page. That is why all three start the session directly.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'toggle', title: 'English Coach: empezar / detener transcripción',
      contexts: ['page', 'selection', 'video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'panel', title: 'English Coach: abrir panel lateral', contexts: ['page'],
    });
  });
  const { setupDone } = await chrome.storage.local.get('setupDone');
  if (!setupDone) chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

// Starts or stops from a gesture Chrome recognises as an invocation. The capture
// id is requested FIRST, before any other await, because the permission is lost
// the moment the tab navigates.
async function toggleFromInvocation(tab) {
  try {
    if (running) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' }).catch(() => {});
      running = false;
      return;
    }

    const { settings = {} } = await chrome.storage.local.get('settings');
    let streamId = null;
    let streamKind = null;

    if ((settings.themSource || 'tab') === 'tab' && tab && !/^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        streamKind = 'tab';
      } catch { /* se intentará el selector */ }
    }

    await startCapture(settings, { tab, streamId, streamKind });
    if (settings.floatingWindow === true) await openCoachWindow();
  } catch (e) {
    const text = e.message || String(e);
    await chrome.storage.local.set({ lastError: { text, at: Date.now() } });
    await notify(text);
    await showErrorInPage(tab, text);
  }
}

// The overlay lives in the page and survives everything, so that is where the
// failure should show. The separate window only opens if the user asked for it.
async function showErrorInPage(tab, text) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  let visto = false;
  if (isWebTab(tab)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { target: 'ui', type: 'STATUS', text, kind: 'error', show: true });
      visto = true;
    } catch { /* chrome://, Web Store o pestaña sin permiso */ }
  }
  if (settings.floatingWindow === true || !visto) await openCoachWindow();
}

chrome.action.onClicked.addListener((tab) => { toggleFromInvocation(tab); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'toggle') return toggleFromInvocation(tab);
  if (info.menuItemId === 'panel' && tab) {
    try { await chrome.sidePanel.open({ tabId: tab.id }); } catch { /* ventana sin panel */ }
  }
});

// Global shortcut: works with focus on the meeting, with no panel or overlay.
if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === 'toggle-capture') return toggleFromInvocation(tab);
    if (command !== 'suggest-reply') return;
    try {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'SUGGEST_REPLY' });
    } catch { /* sin sesión activa */ }
  });
}

// Chips come from settings, so any edit to them — Settings page, side panel, or a
// note toggled open during a session — has to reach the three views.
const CHIP_KEYS = ['phraseIds', 'customPhrases', 'notes', 'liveCoach'];

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = changes.settings.oldValue || {};
  const after = changes.settings.newValue || {};
  const touched = CHIP_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (touched) broadcastChips();
});

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capturar el audio de la pestaña y del micrófono para transcribirlo localmente.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// Note: Chrome's native picker (chrome.desktopCapture) was tried from both the
// service worker and an extension page. In both cases the resulting stream fails
// to open in the offscreen document ("Error starting tab capture"), so that route
// was dropped: for a tab's audio, user invocation is the only mechanism that works.

// Tags the error with the stage it happened in: without this, Chrome's own
// messages ("Invalid state") identify nothing.
async function stage(name, fn) {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`[${name}] ${e.message || e}`);
  }
}

// Forwards whatever the offscreen document broadcasts into the session tab, so
// the overlay hears it even with the side panel closed.
function relayToTab(msg) {
  if (sessionTabId === null) return;
  chrome.tabs.sendMessage(sessionTabId, msg).catch(() => {});
}

// Chips are settings state, not session state: they no longer come from a model,
// so the service worker owns them. It is the only context with both chrome.storage
// and chrome.tabs — the offscreen document has neither, and the overlay has no
// storage. Broadcast whether or not a session is running.
async function broadcastChips() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const msg = { target: 'ui', type: 'COACH_CHIPS', ...resolveChips(settings) };
  lastUi.chips = msg;
  chrome.runtime.sendMessage(msg).catch(() => {});
  relayToTab(msg);
}

// Injects the overlay into a tab and brings it up to date. Called on start, on
// tab switch and after every reload, so the bar is never lost.
async function attachOverlay(tabId) {
  // Re-injecting can fail (chrome://, Web Store, or no host permission) without
  // that preventing us from talking to the content script the manifest already
  // injected. With both in one try, an injection failure leaves the bar mute.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
  } catch { /* la declaración de content_scripts ya lo habrá puesto */ }
  try {
    await chrome.tabs.sendMessage(tabId, { target: 'ui', type: 'RUNNING', running: true });
    if (lastUi.live) await chrome.tabs.sendMessage(tabId, lastUi.live);
    if (lastUi.chips) await chrome.tabs.sendMessage(tabId, lastUi.chips);
    if (lastUi.hints) await chrome.tabs.sendMessage(tabId, lastUi.hints);
    if (lastUi.reply) await chrome.tabs.sendMessage(tabId, lastUi.reply);
  } catch { /* la pestaña no admite overlay */ }
}

// Only real web pages can host the overlay: the extension's own pages (including
// the floating coach window) do not count, or the bar would stop following the
// meeting as soon as that window opens.
const isWebTab = (tab) => !!tab && /^https?:/.test(tab.url || '');

// The bar follows the user: if they switch tabs mid-session, it reappears.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!running) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isWebTab(tab)) return;
  sessionTabId = tabId;
  attachOverlay(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (running && info.status === 'complete' && tabId === sessionTabId && isWebTab(tab)) attachOverlay(tabId);
});

// Sends START to the offscreen document and translates its failures. If Chrome
// killed the document (RESULT_CODE_KILLED_BAD_MESSAGE) the message reaches nobody:
// it is recreated and retried once.
async function sendStart(streamId, streamKind, settings) {
  const send = () => chrome.runtime.sendMessage({
    target: 'offscreen', type: 'START', streamId, streamKind, settings,
  });

  let res;
  try {
    res = await send();
  } catch (e) {
    if (!/Receiving end|Could not establish/i.test(e.message || '')) {
      throw new Error(`[captura] ${e.message || e}`);
    }
    await closeOffscreen();
    await ensureOffscreen();
    res = await send().catch(() => null);
    if (!res) {
      throw new Error('Chrome cerró el motor de captura al abrir el audio. Vuelve a intentarlo; si se repite, reinicia Chrome.');
    }
  }
  if (res && res.error) throw new Error(`[captura] ${res.error}`);
  return res;
}

async function startCapture(settings, invocation = {}) {
  await stage('offscreen', ensureOffscreen);
  // A half-finished previous session leaves the tab's audio busy and the next one
  // fails with "Error starting tab capture".
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' }).catch(() => {});

  let tab = invocation.tab;
  if (!tab) [tab] = await stage('tabs.query', () => chrome.tabs.query({ active: true, currentWindow: true }));
  if (!tab) throw new Error('No hay ninguna pestaña activa.');
  sessionTabId = tab.id;

  let res = null;
  // Cleared before the start, not after: the offscreen document broadcasts
  // LIVE_STATE from inside its own start(), so by the time sendStart resolves the
  // cache already holds this session's value and wiping it would lose the notice.
  lastUi.hints = null;
  lastUi.reply = null;
  lastUi.live = null;

  if (settings.themSource === 'tab') {
    if (/^(chrome|edge|about|chrome-extension|devtools):/.test(tab.url || '')) {
      throw new Error('No se puede capturar audio de una página interna de Chrome. Abre la reunión o el video en una pestaña normal.');
    }

    // 1) Id obtained during the invocation (icon, shortcut or context menu). It is
    //    the only route Chrome genuinely accepts for a tab's audio; requesting it
    //    from the panel or from the page always fails.
    let fastId = invocation.streamId || null;
    let fastError = null;
    if (!fastId) {
      try {
        fastId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      } catch (e) {
        fastError = e;
      }
    }

    if (fastId) {
      try {
        res = await sendStart(fastId, 'tab', settings);
      } catch (e) {
        fastError = e;
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' }).catch(() => {});
      }
    }

    // 2) Without an invocation there is nothing to do: not even the native picker
    //    helps, because the capture engine cannot use the permission it grants.
    //    This is a Chrome restriction, not a recoverable failure.
    if (!res) {
      const detalle = fastError ? ` [detalle: ${fastError.message || fastError}]` : '';
      throw new Error(
        'Chrome sólo permite capturar el audio de una pestaña cuando la extensión se invoca ' +
        'desde ella. Ve a la pestaña de la reunión y pulsa ⌘⇧S (Ctrl+Shift+S en Windows), ' +
        'o haz clic derecho → «English Coach: empezar / detener transcripción», ' +
        'o pulsa el icono de la extensión. Desde este panel no se puede.' + detalle
      );
    }
  } else {
    res = await sendStart(null, null, settings);
  }

  running = true;
  await chrome.storage.local.set({ lastError: null });
  // The tab may have been open since before the extension was installed.
  attachOverlay(tab.id);
  return res;
}

async function forwardToOffscreen(type) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Everything the offscreen document broadcasts for the UIs is mirrored into the tab.
  if (msg.target === 'ui') {
    if (msg.type === 'RUNNING') running = msg.running;
    if (msg.type === 'HINTS') lastUi.hints = msg;
    if (msg.type === 'REPLY' && !msg.pending) lastUi.reply = msg;
    if (msg.type === 'STATUS') lastUi.status = msg;
    // Not a delta but a condition of the session: an overlay injected after a
    // reload must come back knowing the live layer is off, or it silently
    // promises word-by-word text that is never coming.
    if (msg.type === 'LIVE_STATE') lastUi.live = msg;
    relayToTab(msg);
    return;
  }
  if (msg.target && msg.target !== 'background') return;

  (async () => {
    try {
      switch (msg.type) {
        case 'START': {
          const { settings } = await chrome.storage.local.get('settings');
          const merged = { ...(settings || {}), ...(msg.settings || {}) };
          try {
            await startCapture(merged);
          } catch (e) {
            // The panel may have vanished when sharing: leave a visible trace.
            // quiet comes from the overlay, which paints the error itself — a
            // notification and a popup window on top of it would be noise.
            const text = e.message || String(e);
            await chrome.storage.local.set({ lastError: { text, at: Date.now() } });
            if (!msg.quiet) {
              await notify(text);
              if (merged.floatingWindow === true) await openCoachWindow();
            }
            throw e;
          }
          broadcastChips();
          if (merged.floatingWindow === true) await openCoachWindow();
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_WINDOW': {
          sendResponse({ ok: (await openCoachWindow()) !== null });
          break;
        }
        case 'STOP': {
          if (await hasOffscreen()) {
            await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP' });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'SUGGEST_REPLY':
        case 'REPORT': {
          sendResponse(await forwardToOffscreen(msg.type));
          break;
        }
        // The offscreen document has no chrome.storage: we serve it from here.
        // A freshly injected overlay asks for state so it can paint itself fully.
        case 'UI_SYNC': {
          const { transcript = [] } = await chrome.storage.local.get('transcript');
          const { settings = {} } = await chrome.storage.local.get('settings');
          sendResponse({
            running,
            turns: transcript.slice(-12),
            hints: lastUi.hints,
            chips: lastUi.chips,
            reply: lastUi.reply,
            status: lastUi.status,
            live: lastUi.live,
            translate: settings.translate !== false && settings.lang !== 'es',
          });
          break;
        }
        case 'STORE_GET': {
          sendResponse(await chrome.storage.local.get(msg.keys));
          break;
        }
        case 'STORE_SET': {
          await chrome.storage.local.set(msg.items);
          sendResponse({ ok: true });
          break;
        }
        case 'OPEN_REPORT': {
          await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
          sendResponse({ ok: true });
          break;
        }
        case 'SHUTDOWN': {
          await closeOffscreen();
          sessionTabId = null;
          sendResponse({ ok: true });
          break;
        }
        case 'PING_STATE': {
          if (await hasOffscreen()) {
            const st = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STATE' });
            sendResponse(st || { running: false });
          } else {
            sendResponse({ running: false });
          }
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Mensaje desconocido: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: `(${msg.type}) ${e.message || String(e)}` });
    }
  })();

  return true; // asynchronous response
});
