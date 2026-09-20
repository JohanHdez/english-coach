// Drives one recording session of the extension inside a real Chrome and records
// every message the offscreen document broadcasts to the UIs, with the page's
// clock. The fixture plays through Chrome's fake microphone, so each sentence has
// a known start and end and the run can say how long the live line and the
// bubble took to appear for it.
//
// The tab lane cannot be driven here: Chrome only grants tab audio on a user
// invocation (see CLAUDE.md, invariant 1). Every lane in these runs is a
// getUserMedia device, which goes through the same segmenter, queue and engines.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome } from './cdp.mjs';
import { build } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
export const PROFILE = join(HERE, '.profile');
export const RESULTS = join(HERE, 'results');
// A run loads a copy of the extension, taken at its start: the working tree stays
// free to edit while Chrome runs, and the copy's path never moves, so the
// extension id — which Chrome derives from the path — and its model cache stay put.
export const SNAPSHOT = join(HERE, '.snapshot');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE_MS = 250;

// The shipped files only, the same set the release zip takes: no dotfiles, tests,
// docs, tooling or this harness. The copy's manifest gets a fourth version
// component that grows every run, so a run can assert that Chrome loaded this
// copy and not the install from an earlier run; the origin's storage, with the
// model cache, survives the update.
export function snapshot() {
  rmSync(SNAPSHOT, { recursive: true, force: true });
  mkdirSync(SNAPSHOT, { recursive: true });
  for (const name of readdirSync(ROOT)) {
    if (name.startsWith('.') || name === 'e2e' || name === 'docs' || name === 'CLAUDE.md') continue;
    if (name.endsWith('.zip') || name.endsWith('.test.js')) continue;
    const from = join(ROOT, name);
    if (statSync(from).isDirectory()) {
      cpSync(from, join(SNAPSHOT, name), { recursive: true, filter: (p) => !/(^|\/)\./.test(p.slice(ROOT.length)) });
    } else {
      cpSync(from, join(SNAPSHOT, name));
    }
  }
  const manifestPath = join(SNAPSHOT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Monotonic, or Chrome reads a smaller number as a downgrade and keeps the old
  // worker (a clock-derived number wrapped once and did exactly that).
  mkdirSync(PROFILE, { recursive: true });
  const counter = join(PROFILE, 'build');
  let build = 0;
  try { build = Number(readFileSync(counter, 'utf8')) || 0; } catch { /* first run */ }
  build = (build % 65000) + 1;
  writeFileSync(counter, String(build));
  manifest.version = `${manifest.version.split('.').slice(0, 3).join('.')}.${build}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { path: SNAPSHOT, version: manifest.version };
}

// Settings for a run. Defaults match setup.js so a run measures what a fresh install
// does; a scenario overrides what it needs. Never persisted anywhere but the
// throwaway profile under e2e/.profile.
export function settingsFor({ engine = 'local', lanes = 1, lang = 'en', groqKey = '', model, device = 'webgpu', themDeviceId = null, onlyThem = false } = {}) {
  return {
    engine,
    model: model || (lang === 'es' ? 'onnx-community/whisper-base' : 'onnx-community/whisper-base.en'),
    device,
    groqKey,
    groqModel: 'whisper-large-v3-turbo',
    lang,
    themSource: lanes === 2 ? 'device' : 'none',
    themDeviceId,
    // The fake microphone feeds both lanes the same file, so with two lanes the
    // learner's copy of every piece lands between the other speaker's and keeps
    // them from folding — a silent learner in a real meeting does no such thing.
    captureMic: !(lanes === 2 && onlyThem),
    minSegMs: 900,
    translate: false,
    liveTranscript: true,
    liveCoach: false,
    autoReport: false,
    floatingWindow: false,
  };
}

export class Session {
  constructor(chrome, extId, pageSession) {
    this.chrome = chrome;
    this.extId = extId;
    this.page = pageSession;
    this.events = [];
    this.console = [];
  }

  static async open({ fixture, headless = false, settings, log = () => {} }) {
    const { wav, manifest } = build(fixture);
    const { path, version } = snapshot();
    const chrome = await Chrome.launch({ profile: PROFILE, audioFile: wav, headless });
    // Loaded twice on purpose. Measured: the first load of an already installed
    // extension in a fresh browser session keeps the cached service-worker
    // script even when the manifest version changed (pages saw the new version,
    // background.js answered with the old code); a second load in the same
    // session re-registers the worker.
    await chrome.loadUnpacked(path);
    await sleep(500);
    const extId = await chrome.loadUnpacked(path);
    log(`extension ${extId} ${version}`);

    // Console output of every extension context, for diagnosis: the offscreen
    // document and the worker log there and nowhere else.
    const sessions = new Map();
    const consoleLog = [];
    chrome.on(async (method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        const { sessionId: sid, targetInfo } = params;
        sessions.set(sid, targetInfo);
        if (targetInfo.url.includes(extId)) {
          chrome.send('Runtime.enable', {}, sid).catch(() => {});
          chrome.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        }
      }
      if (method === 'Runtime.consoleAPICalled' && sessions.has(sessionId)) {
        const where = sessions.get(sessionId).url.split('/').pop();
        const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        consoleLog.push({ t: Date.now(), where, level: params.type, text });
      }
      if (method === 'Runtime.exceptionThrown' && sessions.has(sessionId)) {
        const where = sessions.get(sessionId).url.split('/').pop();
        consoleLog.push({ t: Date.now(), where, level: 'exception', text: params.exceptionDetails.exception?.description || params.exceptionDetails.text });
      }
    });
    await chrome.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    // The side panel page, opened as a tab: an extension page with chrome.storage
    // and chrome.runtime, which is all the driver needs. Its own UI runs too.
    const { targetId } = await chrome.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
    const page = await chrome.attach(targetId);
    await chrome.send('Runtime.enable', {}, page);
    await chrome.send('Runtime.addBinding', { name: '__e2e' }, page);
    const session = new Session(chrome, extId, page);
    session.console = consoleLog;
    session.manifest = manifest;
    session.settings = settings;
    chrome.on((method, params, sessionId) => {
      if (method === 'Runtime.bindingCalled' && sessionId === page && params.name === '__e2e') {
        session.events.push(JSON.parse(params.payload));
      }
    });
    await sleep(500);
    // The service worker is what a stale load keeps; a page's manifest read comes
    // from the same install, so a mismatch here means the run would test old code.
    const loaded = await chrome.evaluate(page, 'chrome.runtime.getManifest().version');
    if (loaded !== version) throw new Error(`Chrome loaded ${loaded}, the snapshot is ${version}: stale install`);
    await chrome.evaluate(page, `
      chrome.runtime.onMessage.addListener((m) => {
        if (m && m.target === 'ui') __e2e(JSON.stringify({ t: Date.now(), ...m }));
      }); true`);
    await session.applySettings(settings);
    await session.prepareLive(log);
    return session;
  }

  // What a real install has and a throwaway profile does not: the on-device
  // Web Speech pack for the other speaker's word-by-word line, and the built-in
  // translator's English→Spanish model. Both are one-time downloads into
  // e2e/.profile; without them a run measures the Whisper preview lane and no
  // translation at all, which is not what the learner sees.
  async prepareLive(log = () => {}) {
    const wants = [];
    if (this.settings.themSource === 'device' && this.settings.lang !== 'multi') {
      const lang = this.settings.lang === 'es' ? 'es-ES' : 'en-US';
      wants.push(`(async () => {
        const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
        if (!SR || typeof SR.available !== 'function') return 'speech: unsupported';
        const before = await SR.available({ langs: ['${lang}'], processLocally: true });
        if (before === 'available') return 'speech: available';
        const ok = await SR.install({ langs: ['${lang}'], processLocally: true });
        return 'speech: ' + before + ' → install ' + ok + ' → ' + await SR.available({ langs: ['${lang}'], processLocally: true });
      })()`);
    }
    if (this.settings.translate) {
      wants.push(`(async () => {
        const stub = () => {
          globalThis.Translator = {
            availability: async () => 'available',
            create: async () => ({
              translate: async (text) => {
                await new Promise((r) => setTimeout(r, 40 + text.length * 8));
                return '[es] ' + text;
              },
            }),
          };
          return 'translator: stand-in (marks text, 40 ms + 8 ms per character)';
        };
        if (typeof Translator === 'undefined') return stub();
        const opts = { sourceLanguage: 'en', targetLanguage: 'es' };
        try {
          if ((await Translator.availability(opts)) === 'unavailable') return stub();
          const t = await Translator.create(opts);
          const sample = await t.translate('Give me a second.');
          return 'translator: real (' + sample + ')';
        } catch (e) {
          return stub() + ' — the real one failed: ' + e.message;
        }
      })()`);
    }
    // A pack that will not install is reported, not fatal: the run then measures
    // whichever lane is left, and the log says which.
    for (const expr of wants) {
      const outcome = await this.chrome.evaluate(this.page, expr, { userGesture: true }).catch((e) => e.message);
      log(outcome);
    }
  }

  async applySettings(settings) {
    const s = { ...settings };
    if (s.themSource === 'device' && !s.themDeviceId) {
      s.themDeviceId = await this.chrome.evaluate(this.page, `
        navigator.mediaDevices.enumerateDevices().then((ds) => {
          const d = ds.find((x) => x.kind === 'audioinput' && /Fake Audio Input 1/.test(x.label));
          return d ? d.deviceId : null;
        })`);
      if (!s.themDeviceId) throw new Error('no second fake input device for the them lane');
    }
    this.settings = s;
    await this.chrome.evaluate(this.page, `chrome.storage.local.set({ settings: ${JSON.stringify(s)}, stoppedAt: 0, transcript: [], lastError: null }).then(() => true)`);
  }

  now() { return this.chrome.evaluate(this.page, 'Date.now()'); }

  async start() {
    const sentAt = await this.now();
    const res = await this.chrome.evaluate(this.page, `chrome.runtime.sendMessage({ type: 'START' })`);
    if (!res || !res.ok) throw new Error(`START failed: ${res && res.error}`);
    const running = this.events.find((e) => e.type === 'RUNNING' && e.running && e.t >= sentAt - 5);
    return { sentAt, t0: running ? running.t : sentAt };
  }

  async stop() {
    await this.chrome.evaluate(this.page, `chrome.runtime.sendMessage({ type: 'STOP' })`);
  }

  // Waits for a STATUS whose text matches, scanning what already arrived first.
  async waitStatus(re, { timeoutMs = 30000, since = 0, onProgress } = {}) {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      const hit = this.events.find((e) => e.type === 'STATUS' && e.t >= since && re.test(e.text || ''));
      if (hit) return hit;
      const err = this.events.find((e) => e.type === 'STATUS' && e.t >= since && e.kind === 'error');
      if (err) throw new Error(`status error: ${err.text}`);
      if (onProgress && this.events.length !== seen) {
        seen = this.events.length;
        const last = this.events[seen - 1];
        if (last.type === 'STATUS') onProgress(last.text);
      }
      await sleep(100);
    }
    throw new Error(`timeout waiting for status ${re}`);
  }

  // Loads the model once so the measured session starts with a warm engine, the
  // way every session after the first does for a real user.
  async warmUp(log = () => {}) {
    const { t0 } = await this.start();
    // The model's terminal state. On the API engine a failed load is not a session
    // error — Groq keeps transcribing — so it is reported as the live line degrading.
    const settled = this.settings.engine === 'api'
      ? /^(Modelo listo|Línea en vivo lista|Sin línea en vivo)/
      : /^(Modelo listo|Línea en vivo lista)/;
    const outcome = await this.waitStatus(settled, { timeoutMs: 15 * 60 * 1000, since: t0, onProgress: (s) => log(`  ${s}`) });
    await this.stop();
    await this.waitStatus(/^Detenido\./, { timeoutMs: 120000, since: t0 });
    this.device = /\((GPU|CPU)\)/.exec(outcome.text)?.[1] || (/^Sin línea/.test(outcome.text) ? 'none (model failed)' : '?');
    this.events = [];
    await this.applySettings(this.settings);
    // Well past MERGE_GAP_MS, so nothing from the warm-up can fold into a turn.
    await sleep(1500);
  }

  // The measured session: the fixture plays from its first sample as the
  // microphone opens, so the RUNNING broadcast is t0 within a few tens of ms.
  // What the side panel paints on its live lines, sampled every SAMPLE_MS. The
  // protocol log says what the offscreen document sent; this says what the reader
  // saw, translation and all — the two can disagree, and only the second one is
  // the complaint.
  async sampleLive() {
    return this.chrome.evaluate(this.page, `(() => {
      const t = (id) => (document.getElementById(id) || {}).textContent || '';
      const hidden = (id) => !!(document.getElementById(id) || {}).hidden;
      return { t: Date.now(),
        them: { hidden: hidden('partialThem'), en: t('partialThemEn') + t('partialThemTail'), es: t('partialThemEs') },
        me: { hidden: hidden('partialMe'), en: t('partialMeEn') + t('partialMeTail') },
        bubbles: document.querySelectorAll('#transcript .bubble').length,
        bubbleList: [...document.querySelectorAll('#transcript .bubble')].map((b) => {
          const es = b.querySelector('.es');
          return { key: b.dataset.key, len: (b.querySelector('span:not(.meta):not(.es):not(.lang-tag)') || {}).textContent?.length || 0,
            es: es ? es.textContent.length : 0, stale: !!(es && es.classList.contains('stale')) };
        }) };
    })()`);
  }

  async record(log = () => {}, { onStart } = {}) {
    const samples = [];
    const { t0 } = await this.start();
    if (onStart) onStart(t0);
    const total = this.manifest.duration * 1000;
    const sampler = setInterval(() => { this.sampleLive().then((s) => samples.push(s)).catch(() => {}); }, SAMPLE_MS);
    await sleep(total + 1500);
    clearInterval(sampler);
    // Then until the queue is empty, so late turns are counted rather than lost.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const q = [...this.events].reverse().find((e) => e.type === 'QUEUE');
      const lastEvent = this.events[this.events.length - 1];
      if ((!q || q.pending === 0) && lastEvent && Date.now() - lastEvent.t > 2500) break;
      await sleep(250);
    }
    await this.stop();
    await this.waitStatus(/^Detenido\./, { timeoutMs: 120000, since: t0 }).catch((e) => log(`  ${e.message}`));
    return { t0, events: this.events.slice(), console: this.console.slice(), samples };
  }

  async close() { await this.chrome.close(); }
}

// ------------------------------------------------------------------ analysis

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);

// Fraction of the expected words that appear in the transcribed text.
export function coverage(expected, got) {
  const want = norm(expected);
  const have = new Set(norm(got));
  if (!want.length) return 0;
  return want.filter((w) => have.has(w)).length / want.length;
}

// Every SEGMENT broadcast that brought new words. Consecutive turns of one speaker
// fold into one bubble, which is re-broadcast whole with its original `t`, so the
// arrival of a sentence is the broadcast where the bubble's text grew — not the
// broadcast whose `t` falls inside the sentence.
function arrivals(events, speaker) {
  const seen = new Map();
  const out = [];
  for (const e of events) {
    if (e.type !== 'SEGMENT' || !e.entry || e.entry.speaker !== speaker) continue;
    const key = `${e.entry.speaker}@${e.entry.t}`;
    const prev = seen.get(key) || '';
    const text = e.entry.text || '';
    const delta = text.startsWith(prev) ? text.slice(prev.length).trim() : text;
    seen.set(key, text);
    if (delta) out.push({ t: e.t, delta, lang: e.entry.lang || null });
  }
  return out;
}

// Turns the raw event log into one row per fixture sentence: first live text,
// bubble arrival, what the bubble said, and whether it matches the sentence.
export function analyse({ t0, events }, manifest, { speaker = 'me' } = {}) {
  const rel = (t) => Math.round(t - t0);
  const partials = events.filter((e) => e.type === 'PARTIAL' && e.speaker === speaker);
  const landed = arrivals(events, speaker);
  const rows = manifest.cues.map((cue) => ({
    key: cue.key, lang: cue.lang, start: cue.start, end: cue.end,
    liveAfterOnsetMs: null, liveText: '', liveCoverage: 0, bubbleAfterEndMs: null, lastPieceAfterEndMs: null,
    pieces: 0, text: '', langOfBubble: null, coverage: 0,
  }));

  // Live line: the first non-empty partial after the sentence began whose text is
  // not simply the previous sentence's line still standing (an open cut leaves it).
  // liveCoverage is the best any partial painted while the sentence was being
  // spoken did against its words — a line decoded in the wrong language scores 0.
  for (const [i, cue] of manifest.cues.entries()) {
    const start = t0 + cue.start * 1000;
    const end = t0 + cue.end * 1000 + 1500;
    const before = [...partials].reverse().find((p) => p.t < start);
    const standing = before ? (before.text || '') : '';
    const first = partials.find((p) => p.t >= start && (p.text || '').trim() && p.text !== standing);
    if (first) { rows[i].liveAfterOnsetMs = rel(first.t) - cue.start * 1000; rows[i].liveText = first.text; }
    const during = partials.filter((p) => p.t >= start && p.t <= end && (p.text || '').trim());
    rows[i].liveCoverage = Math.round(Math.max(0, ...during.map((p) => coverage(cue.text, p.text))) * 100);
  }

  // Bubbles: each arrival goes to the sentence its words cover best; words that
  // match nothing (a sentence decoded in the wrong language) go to the earliest
  // sentence that had ended and has no bubble yet, so garbage is shown as garbage
  // rather than dropped.
  for (const a of landed) {
    let best = -1;
    let bestCov = 0.3;
    manifest.cues.forEach((cue, i) => {
      const c = coverage(cue.text, a.delta);
      if (c > bestCov) { bestCov = c; best = i; }
    });
    if (best < 0) {
      best = manifest.cues.findIndex((cue, i) => rows[i].pieces === 0 && a.t > t0 + cue.end * 1000 - 500);
      if (best < 0) continue;
    }
    const row = rows[best];
    const end = manifest.cues[best].end * 1000;
    if (row.pieces === 0) row.bubbleAfterEndMs = rel(a.t) - end;
    row.lastPieceAfterEndMs = rel(a.t) - end;
    row.pieces++;
    row.text = `${row.text} ${a.delta}`.trim();
    row.langOfBubble = a.lang;
    row.coverage = Math.round(coverage(manifest.cues[best].text, row.text) * 100);
  }

  const errors = events.filter((e) => e.type === 'STATUS' && e.kind === 'error').map((e) => e.text);
  const maxPending = Math.max(0, ...events.filter((e) => e.type === 'QUEUE').map((e) => e.pending || 0));

  // Bubbles of this speaker: how many, how long the longest got, the largest text
  // one repaint asked the views to retranslate, and whether every bubble that
  // was followed by another ends at a finished sentence.
  const byKey = new Map();
  let largestRepaint = 0;
  for (const e of events) {
    if (e.type !== 'SEGMENT' || !e.entry || e.entry.speaker !== speaker) continue;
    const key = `${e.entry.speaker}@${e.entry.t}`;
    const text = e.entry.text || '';
    if (byKey.has(key)) largestRepaint = Math.max(largestRepaint, text.length);
    byKey.set(key, text);
  }
  const texts = [...byKey.values()];
  const closed = texts.slice(0, -1);
  const bubbles = {
    count: texts.length,
    longestChars: Math.max(0, ...texts.map((t) => t.length)),
    largestRepaintChars: largestRepaint,
    closed: closed.length,
    closedAtSentenceEnd: closed.filter((t) => /[.!?…]["'\u201D\u2019)\]]*$/.test(t.trim())).length,
  };

  return { rows, bubbles, previews: partials.filter((p) => (p.text || '').trim()).length, maxPending, errors };
}

// Stretches, while a sentence was being spoken, during which the speaker's live
// line showed nothing. Grace is what a healthy lane needs to paint its first
// words after a cut; only longer holes count. Works on the protocol log (PARTIAL
// messages, `text`) and on the painted samples (`en`) alike: pass a reader.
export function blankSpans(points, manifest, { grace = 2500 } = {}) {
  const out = [];
  for (const cue of manifest.cues) {
    const start = cue.start * 1000;
    const end = cue.end * 1000;
    let blankSince = start;
    let shown = false;
    for (const p of points) {
      if (p.t < start) { shown = !!p.text; blankSince = start; continue; }
      if (p.t > end) break;
      if (p.text) {
        if (!shown && p.t - blankSince > grace) out.push({ key: cue.key, from: blankSince, to: p.t });
        shown = true;
      } else if (shown) {
        shown = false;
        blankSince = p.t;
      }
    }
    if (!shown && end - blankSince > grace) out.push({ key: cue.key, from: blankSince, to: end, open: true });
  }
  return out.map((s) => ({ ...s, from: Math.round(s.from), to: Math.round(s.to), ms: Math.round(s.to - s.from) }));
}

export function liveReport({ t0, events, samples = [] }, manifest, speaker) {
  const sent = events.filter((e) => e.type === 'PARTIAL' && e.speaker === speaker)
    .map((e) => ({ t: e.t - t0, text: (e.text || '').trim() }));
  const painted = samples.map((s) => ({ t: s.t - t0, text: s[speaker].hidden ? '' : s[speaker].en.trim() }));
  const translated = samples.filter((s) => speaker === 'them' && !s.them.hidden && s.them.es.trim()).length;
  const out = {
    sentBlank: blankSpans(sent, manifest),
    paintedBlank: blankSpans(painted, manifest),
    paintedSamples: painted.filter((p) => p.text).length,
    translatedSamples: translated,
  };
  if (speaker === 'them') {
    // Per bubble, across samples: did its text ever change with no Spanish under it,
    // and did it end with Spanish. The last bubble is the open one and is not judged.
    const seen = new Map();
    let repaints = 0;
    let repaintsBlankingSpanish = 0;
    let maxTranslatedChars = 0;
    for (const s of samples) {
      for (const b of s.bubbleList || []) {
        const prev = seen.get(b.key);
        if (prev && prev.len !== b.len) {
          repaints++;
          if (!b.es) repaintsBlankingSpanish++;
        }
        if (b.es && !b.stale) maxTranslatedChars = Math.max(maxTranslatedChars, b.len);
        seen.set(b.key, b);
      }
    }
    const finals = [...seen.values()];
    const closedList = finals.slice(0, -1);
    out.spanish = {
      closed: closedList.length,
      closedWithSpanish: closedList.filter((b) => b.es && !b.stale).length,
      repaints,
      repaintsBlankingSpanish,
      maxTranslatedChars,
    };
  }
  return out;
}

export function saveResult(name, data) {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}
