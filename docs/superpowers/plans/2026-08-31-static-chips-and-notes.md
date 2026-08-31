# Static chips and notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-turn Groq call that generates live chips with a curated phrasebook the
learner picks from in Settings, plus their own collapsible notes.

**Architecture:** A new pure module `phrasebook.js` holds a 38-phrase catalogue and resolves what
the learner selected. Chips stop being session state and become settings state, so `background.js`
(the router, the only context with both `chrome.storage` and `chrome.tabs`) broadcasts them as
`COACH_CHIPS` on start, on `UI_SYNC`, and on `storage.onChanged`. The offscreen document's
`scheduleHints` loop and `coach.js`'s `askHints` / `askStarter` are deleted.

**Tech Stack:** Chrome MV3, plain ES modules, no build step, no dependencies. Node's built-in test
runner for the pure modules.

**Spec:** `docs/superpowers/specs/2026-08-31-static-chips-and-notes-design.md`

## Global Constraints

- **No build step, no `package.json`, no dependencies, no bundler.** Every shipped file is
  hand-written. Chrome loads the folder verbatim.
- **Never edit `vendor/` or `icons/`.**
- **Minimum Chrome is 116.** Node is for tooling only; the extension never runs in Node.
- **Pure logic stays pure.** `phrasebook.js` imports no `chrome.*` and takes side effects as
  injected parameters, so it runs unmodified in Node.
- **The content script has `chrome.runtime` but not `chrome.storage`.** The overlay must receive
  chips as a message; it may never read settings directly.
- **The offscreen document has no `chrome.storage`.** All its storage goes through `STORE_GET` /
  `STORE_SET`.
- **Service worker memory is ephemeral.** `lastUi` is module-level and lost on suspension;
  `UI_SYNC` must rebuild from `chrome.storage.local`.
- **Never pass dynamic content to `innerHTML`.** Use `textContent` and `createElement`. Note
  bodies are learner-authored text and this is a security control, not formatting.
- **UI strings and user-facing errors are in Spanish.** Identifiers, comments, documentation and
  commit messages are in English. Never "fix" a Spanish UI string into English.
- **Errors are prefixed with the stage that produced them**: `[offscreen]`, `[captura]`.
- **Comments record browser-imposed behaviour only.** Do not write comments that restate the code.
- **The gate before claiming anything works:**
  ```bash
  node .claude/skills/preflight/scripts/preflight.mjs
  node --test *.test.js
  ```
  Preflight fails on a SCREAMING_SNAKE type sent with no handler and on unreachable files.
- **Commit messages end with:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: Land the production fix on its own commit

The working tree already carries the 2026-08-30 fix for `Coach: Groq cortó la respuesta a medias
(JSON inválido)`. Later tasks delete part of it, so it ships as its own isolated, deployable
commit first.

**Files:**
- Modify: `coach.js` (already changed in the working tree)
- Modify: `coach.test.js` (already changed in the working tree)

**Interfaces:**
- Consumes: nothing.
- Produces: `JSON_BUDGET = 1200` in `coach.js`; `clip(text, max)` and
  `turnsToText(turns, limit, maxChars, maxTurnChars)`.

- [ ] **Step 1: Confirm the working tree holds exactly the fix**

Run: `git diff --stat`
Expected: `coach.js` and `coach.test.js` modified, nothing else.

- [ ] **Step 2: Run the gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: preflight `0 failing, 0 warnings`; tests `pass 42  fail 0`.

- [ ] **Step 3: Commit**

```bash
git add coach.js coach.test.js
git commit -m "fix(coach): give the chips and the starter room to reason before the JSON

gpt-oss models spend reasoning tokens from max_completion_tokens before they
write the JSON, so a 700-token cap truncated the object and Groq rejected the
call with 400 json_validate_failed — surfaced to the learner as
'Coach: Groq cortó la respuesta a medias'. 0f63f92 fixed this for askReply and
left askHints and askStarter on the old cap; they now share one JSON_BUDGET so
the three cannot drift apart again.

askHints was also the only coach call with no character cap on the transcript.
A Whisper repetition loop arrives as one segment of thousands of characters
that MERGE_MAX_CHARS does not bound, and the chips prompt reached 35511 chars
(~8878 tokens) — over Groq's whole 8000/min free tier, every few seconds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The phrasebook module

**Files:**
- Create: `phrasebook.js`
- Create: `phrasebook.test.js`

**Interfaces:**
- Consumes: nothing. This module imports nothing at all.
- Produces:
  - `CATALOGUE: Array<{ cat: string, items: Array<{ id, en, es }> }>`
  - `DEFAULT_PHRASE_IDS: string[]`
  - `resolvePhrases(settings): Array<{ id, en, es }>`
  - `resolveNotes(settings): Array<{ id, title, body, open }>`
  - `NOTE_TITLE_MAX = 60`, `NOTE_BODY_MAX = 2000`, `MAX_NOTES = 20`, `MAX_CUSTOM = 40`

- [ ] **Step 1: Write the failing test**

Create `phrasebook.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE, DEFAULT_PHRASE_IDS, resolvePhrases, resolveNotes,
  NOTE_TITLE_MAX, NOTE_BODY_MAX, MAX_NOTES, MAX_CUSTOM,
} from './phrasebook.js';

const allItems = () => CATALOGUE.flatMap((c) => c.items);

test('every catalogue id is unique', () => {
  const ids = allItems().map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every catalogue entry carries English and a Spanish gloss', () => {
  for (const item of allItems()) {
    assert.ok(item.en && item.en.trim(), `${item.id} has no en`);
    assert.ok(item.es && item.es.trim(), `${item.id} has no es`);
  }
});

test('every seeded default exists in the catalogue', () => {
  const ids = new Set(allItems().map((i) => i.id));
  for (const id of DEFAULT_PHRASE_IDS) assert.ok(ids.has(id), `${id} is not in the catalogue`);
});

test('resolvePhrases returns built-ins in catalogue order, then customs', () => {
  const out = resolvePhrases({
    phraseIds: ['close.sum-up', 'time.second'],
    customPhrases: [{ id: 'u.1', en: 'Ship it,', es: 'a producción' }],
  });
  assert.deepEqual(out.map((p) => p.id), ['time.second', 'close.sum-up', 'u.1']);
});

test('resolvePhrases drops ids no longer in the catalogue instead of throwing', () => {
  const out = resolvePhrases({ phraseIds: ['time.second', 'gone.forever'] });
  assert.deepEqual(out.map((p) => p.id), ['time.second']);
});

test('resolvePhrases on empty settings returns the seeded defaults, not nothing', () => {
  const out = resolvePhrases({});
  assert.equal(out.length, DEFAULT_PHRASE_IDS.length);
  assert.ok(out.length > 0);
});

test('an explicitly empty selection stays empty', () => {
  assert.deepEqual(resolvePhrases({ phraseIds: [] }), []);
});

test('resolvePhrases caps the learner custom phrases', () => {
  const customPhrases = Array.from({ length: MAX_CUSTOM + 10 }, (_, i) => ({
    id: `u.${i}`, en: `phrase ${i}`, es: `frase ${i}`,
  }));
  const out = resolvePhrases({ phraseIds: [], customPhrases });
  assert.equal(out.length, MAX_CUSTOM);
});

test('resolvePhrases discards custom phrases with no English', () => {
  const out = resolvePhrases({ phraseIds: [], customPhrases: [{ id: 'u.1', en: '  ', es: 'x' }] });
  assert.deepEqual(out, []);
});

test('a custom phrase id cannot collide with a catalogue id', () => {
  // Settings writes them as 'u.' + timestamp; no catalogue id may start with 'u.'
  for (const item of allItems()) assert.ok(!item.id.startsWith('u.'), `${item.id} collides`);
});

test('resolveNotes clamps title, body and count', () => {
  const notes = Array.from({ length: MAX_NOTES + 5 }, (_, i) => ({
    id: `n.${i}`, title: 'T'.repeat(NOTE_TITLE_MAX + 20), body: 'B'.repeat(NOTE_BODY_MAX + 500),
  }));
  const out = resolveNotes({ notes });
  assert.equal(out.length, MAX_NOTES);
  assert.equal(out[0].title.length, NOTE_TITLE_MAX);
  assert.equal(out[0].body.length, NOTE_BODY_MAX);
});

test('resolveNotes preserves the open state through a round trip', () => {
  const out = resolveNotes({ notes: [{ id: 'n.1', title: 'Mi daily', body: 'x', open: true }] });
  assert.equal(out[0].open, true);
  assert.equal(resolveNotes({ notes: out })[0].open, true);
});

test('resolveNotes defaults a note to closed and never returns undefined fields', () => {
  const [note] = resolveNotes({ notes: [{ id: 'n.1', title: 'Sin cuerpo' }] });
  assert.equal(note.open, false);
  assert.equal(note.body, '');
});

test('resolveNotes on empty settings returns an empty list', () => {
  assert.deepEqual(resolveNotes({}), []);
  assert.deepEqual(resolveNotes({ notes: null }), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test phrasebook.test.js`
Expected: FAIL — `Cannot find module './phrasebook.js'`.

- [ ] **Step 3: Write the module**

Create `phrasebook.js`:

```js
// The phrases a learner reaches for in a live conversation are a closed set: the
// same connectors, stalls and reactions work in every meeting. They are checked in
// rather than generated, so the live layer needs no API key, no network and no
// token budget — and cannot fail mid-conversation.

export const CATALOGUE = [
  { cat: 'Ganar tiempo', items: [
    { id: 'time.second',   en: 'Give me a second,',           es: 'dame un segundo' },
    { id: 'time.think',    en: 'Let me think about that,',    es: 'déjame pensarlo' },
    { id: 'time.good-q',   en: "That's a good question,",     es: 'buena pregunta' },
    { id: 'time.rephrase', en: 'Let me put it another way,',  es: 'déjame decirlo de otra forma' },
    { id: 'time.bear',     en: 'Bear with me a moment,',      es: 'dame un momento' },
  ] },
  { cat: 'Pedir aclaración', items: [
    { id: 'clarify.repeat',   en: 'Sorry, could you repeat that?', es: '¿puedes repetirlo?' },
    { id: 'clarify.clarify',  en: 'Could you clarify that?',       es: '¿puedes aclararlo?' },
    { id: 'clarify.mean',     en: 'What do you mean by that?',     es: '¿a qué te refieres?' },
    { id: 'clarify.follow',   en: 'Just to make sure I follow,',   es: 'para asegurarme de que te sigo' },
    { id: 'clarify.specific', en: 'Could you be more specific?',   es: '¿puedes concretar?' },
  ] },
  { cat: 'Contrastar', items: [
    { id: 'contrast.other-hand',  en: 'On the other hand,',    es: 'por otro lado' },
    { id: 'contrast.that-said',   en: 'That said,',            es: 'dicho eso' },
    { id: 'contrast.however',     en: 'However,',              es: 'sin embargo' },
    { id: 'contrast.in-practice', en: 'Although in practice,', es: 'aunque en la práctica' },
    { id: 'contrast.depends',     en: 'It depends on the case,', es: 'depende del caso' },
  ] },
  { cat: 'Añadir', items: [
    { id: 'add.in-addition', en: 'In addition,',                es: 'además' },
    { id: 'add.on-top',      en: 'On top of that,',             es: 'encima de eso' },
    { id: 'add.worth',       en: "It's also worth mentioning,", es: 'también vale la pena mencionar' },
    { id: 'add.more',        en: "What's more,",                es: 'es más' },
  ] },
  { cat: 'Estructurar', items: [
    { id: 'structure.two-things', en: 'There are two things here,', es: 'aquí hay dos cosas' },
    { id: 'structure.first',      en: 'First of all,',              es: 'en primer lugar' },
    { id: 'structure.then',       en: 'And then,',                  es: 'y luego' },
    { id: 'structure.break-down', en: 'Let me break that down,',    es: 'déjame desglosarlo' },
    { id: 'structure.example',    en: 'For example,',               es: 'por ejemplo' },
    { id: 'structure.my-case',    en: 'In my case,',                es: 'en mi caso' },
  ] },
  { cat: 'Cerrar', items: [
    { id: 'close.sum-up',   en: 'To sum up,',                     es: 'en resumen' },
    { id: 'close.in-short', en: 'So, in short,',                  es: 'en pocas palabras' },
    { id: 'close.thats-it', en: "That's basically it.",           es: 'eso es básicamente todo' },
    { id: 'close.answer',   en: 'Does that answer your question?', es: '¿responde eso a tu pregunta?' },
  ] },
  { cat: 'Reaccionar', items: [
    { id: 'react.makes-sense', en: 'That makes sense.',        es: 'tiene sentido' },
    { id: 'react.fair',        en: 'Fair enough.',             es: 'me parece justo' },
    { id: 'react.good-point',  en: 'Good point.',              es: 'buen punto' },
    { id: 'react.exactly',     en: 'Exactly.',                 es: 'exacto' },
    { id: 'react.agree',       en: "I'd agree with that.",     es: 'estaría de acuerdo' },
    { id: 'react.unsure',      en: "I'm not sure about that.", es: 'no estoy seguro de eso' },
  ] },
  // Saying "I don't know" well is worth more in an interview than any connector:
  // the 2026-08-30 report graded the learner partly on hesitation they had no
  // phrase to replace.
  { cat: 'Ser honesto', items: [
    { id: 'honest.not-directly', en: "I haven't worked with that directly,",  es: 'no he trabajado con eso directamente' },
    { id: 'honest.similar',      en: "but I've done something similar with,", es: 'pero he hecho algo parecido con' },
    { id: 'honest.approach',     en: "The way I'd approach it is,",           es: 'la forma en que lo enfocaría es' },
  ] },
];

// Seeded so the feature is visible the first time it runs: a learner who never
// opens the new settings section still gets the two categories that rescue a live
// conversation. An explicitly empty selection stays empty.
export const DEFAULT_PHRASE_IDS = [
  'time.second', 'time.think', 'time.good-q', 'time.rephrase', 'time.bear',
  'clarify.repeat', 'clarify.clarify', 'clarify.mean', 'clarify.follow', 'clarify.specific',
];

export const NOTE_TITLE_MAX = 60;
export const NOTE_BODY_MAX = 2000;
export const MAX_NOTES = 20;
export const MAX_CUSTOM = 40;

const FLAT = CATALOGUE.flatMap((c) => c.items);
const clamp = (value, max) => String(value ?? '').trim().slice(0, max);

export function resolvePhrases(settings = {}) {
  const chosen = Array.isArray(settings.phraseIds) ? settings.phraseIds : DEFAULT_PHRASE_IDS;
  const wanted = new Set(chosen);
  // Catalogue order, not selection order: the learner ticks boxes down a list and
  // expects to read them back in the order they saw them.
  const builtins = FLAT.filter((item) => wanted.has(item.id));
  const custom = (Array.isArray(settings.customPhrases) ? settings.customPhrases : [])
    .filter((p) => p && String(p.en ?? '').trim())
    .slice(0, MAX_CUSTOM)
    .map((p) => ({ id: p.id, en: String(p.en).trim(), es: String(p.es ?? '').trim() }));
  return [...builtins, ...custom];
}

export function resolveNotes(settings = {}) {
  const notes = Array.isArray(settings.notes) ? settings.notes : [];
  return notes
    .filter((n) => n && (String(n.title ?? '').trim() || String(n.body ?? '').trim()))
    .slice(0, MAX_NOTES)
    .map((n) => ({
      id: n.id,
      title: clamp(n.title, NOTE_TITLE_MAX),
      body: clamp(n.body, NOTE_BODY_MAX),
      open: n.open === true,
    }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test phrasebook.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run the full gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: preflight `0 failing, 0 warnings`. If preflight reports `phrasebook.js` as unreachable,
that is correct and expected — nothing imports it yet. Note it and continue; Task 4 wires it in.

- [ ] **Step 6: Commit**

```bash
git add phrasebook.js phrasebook.test.js
git commit -m "feat(phrasebook): add the curated phrase catalogue

38 phrases across 8 categories, each with a Spanish gloss. Closed set, checked
in rather than generated: the live layer stops needing a key, a network and a
token budget.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Move the per-turn cap onto the calls that survive

`clip` / `maxTurnChars` was added on 2026-08-30 but wired only into `askHints`. Task 7 deletes
`askHints`, which would orphan it — and preflight fails on dead code. It moves to the two callers
that still receive Whisper repetition loops.

**Files:**
- Modify: `coach.js` — `askReply` and `askReport`
- Modify: `coach.test.js`

**Interfaces:**
- Consumes: `turnsToText(turns, limit, maxChars, maxTurnChars)` and `clip` from Task 1.
- Produces: `TURN_MAX_CHARS = 400` in `coach.js` (module-private).

- [ ] **Step 1: Generalise the fetch stub**

Task 1 left `stubGroq` hardcoded to a hints payload. `askReply` needs a reply payload, so make the
content a parameter. In `coach.test.js`, change the helper's signature and body:

```js
function stubGroq(capture, content) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return () => { globalThis.fetch = original; };
}
```

Update the three existing call sites to pass their payload explicitly:
```js
const HINTS_JSON = JSON.stringify({ words: [{ en: 'so far', es: 'hasta ahora' }], openers: [], nudge: '' });
const restore = stubGroq(seen, HINTS_JSON);
```

- [ ] **Step 2: Write the failing test**

Testing `turnsToText(…, 400)` directly would prove nothing — Task 1 already made that work. The
real gap is that `askReply` never passes the fourth argument. Test the caller:

```js
const REPLY_SETTINGS = {
  reportProvider: 'groq',
  reportModel: 'openai/gpt-oss-120b',
  groqKey: 'gsk_test_key_for_unit_tests',
  level: 'B1-B2',
  situation: 'conversación de trabajo en inglés',
  lang: 'en',
};
const REPLY_JSON = JSON.stringify({
  answer: [{ en: 'It depends on the load.', es: 'depende de la carga' }],
  ideas: [{ en: 'idea', es: 'idea' }],
});

test('askReply clips a repetition-loop turn out of its prompt', async () => {
  const loop = { speaker: 'me', text: 'be able to '.repeat(400) };
  const seen = {};
  const restore = stubGroq(seen, REPLY_JSON);
  try {
    await askReply({
      turns: [{ speaker: 'them', text: 'How is the migration going?' }, loop],
      settings: REPLY_SETTINGS,
    });
  } finally { restore(); }
  const user = seen.body.messages.find((m) => m.role === 'user').content;
  assert.ok(!user.includes('be able to '.repeat(50)), 'the repetition loop reached the prompt whole');
  assert.ok(user.length < 2500, `reply prompt grew to ${user.length} chars`);
});
```

Add `askReply` to the import line in `coach.test.js`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test coach.test.js`
Expected: FAIL — `the repetition loop reached the prompt whole`. `turnsToText` supports the cap but
`askReply` does not pass it. Do not proceed until you have seen this failure.

- [ ] **Step 4: Wire the cap into the two surviving callers**

In `coach.js`, next to `REPORT_MAX_CHARS`:

```js
// A Whisper repetition loop is one segment of thousands of characters; MERGE_MAX_CHARS
// bounds folding, not a single transcription. Without a per-turn cap, turnsToText's
// "keep at least the last turn" rule passes the whole loop through.
const TURN_MAX_CHARS = 400;
```

In `askReply`, change:
```js
+ `\n\nConversation so far:\n${turnsToText(turns, 10, 1200)}`
```
to:
```js
+ `\n\nConversation so far:\n${turnsToText(turns, 10, 1200, TURN_MAX_CHARS)}`
```

In `askReport`, change:
```js
const texto = turnsToText(turns, 400, REPORT_MAX_CHARS);
```
to:
```js
const texto = turnsToText(turns, 400, REPORT_MAX_CHARS, TURN_MAX_CHARS);
```

- [ ] **Step 5: Run the gate**

```bash
node --test *.test.js
node .claude/skills/preflight/scripts/preflight.mjs
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add coach.js coach.test.js
git commit -m "fix(coach): cap a single turn in the reply and the report prompts

A Whisper repetition loop arrives as one segment of thousands of characters.
turnsToText keeps the last turn even when it blows the character budget, so the
loop reached both prompts whole — the 2026-08-30 report spent grammar-table rows
on \"I'm a good guy\" repeated eighty times.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Broadcast COACH_CHIPS from the service worker

Adds the new protocol path alongside the old one. `HINTS` still works after this task; Task 7
removes it. Nothing renders yet.

**Files:**
- Modify: `background.js` — import, `lastUi`, `storage.onChanged`, `attachOverlay`, `UI_SYNC`,
  session reset
- Modify: `.claude/skills/message-contract/SKILL.md`

**Interfaces:**
- Consumes: `resolvePhrases(settings)`, `resolveNotes(settings)` from Task 2.
- Produces: broadcast `{ target: 'ui', type: 'COACH_CHIPS', phrases: [{id,en,es}], notes: [{id,title,body,open}] }`,
  cached as `lastUi.chips`; `UI_SYNC` response gains a `chips` field.

- [ ] **Step 1: Import the phrasebook and add the broadcaster**

At the top of `background.js`, alongside the existing imports:

```js
import { resolvePhrases, resolveNotes } from './phrasebook.js';
```

Add near the other broadcast helpers:

```js
// Chips are settings state, not session state: they no longer come from a model,
// so the service worker owns them. It is the only context with both chrome.storage
// and chrome.tabs — the offscreen document has neither, and the overlay has no
// storage. Broadcast whether or not a session is running.
async function broadcastChips() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const msg = {
    target: 'ui',
    type: 'COACH_CHIPS',
    phrases: settings.liveCoach === false ? [] : resolvePhrases(settings),
    notes: settings.liveCoach === false ? [] : resolveNotes(settings),
  };
  lastUi.chips = msg;
  chrome.runtime.sendMessage(msg).catch(() => {});
  relayToTab(msg);
}
```

- [ ] **Step 2: Cache it and replay it**

In the `lastUi` declaration (line 11), add the key:
```js
const lastUi = { hints: null, chips: null, reply: null, status: null, live: null };
```

In `attachOverlay`, after the `lastUi.live` replay:
```js
if (lastUi.chips) await chrome.tabs.sendMessage(tabId, lastUi.chips);
```

In the `UI_SYNC` handler, add to the response object:
```js
chips: lastUi.chips,
```

Do **not** clear `lastUi.chips` in the session reset that nulls `hints` / `reply` / `live`: chips
are not session state and must survive a session ending.

- [ ] **Step 3: Rewire the storage watcher**

Replace the `chrome.storage.onChanged` listener (currently comparing `sessionContext` and sending
`CONTEXT_CHANGED`) with:

```js
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
```

Note: `CONTEXT_CHANGED` is not removed in this task — Task 7 removes its sender and its handler
together. This task only stops the watcher from being its trigger, which is safe because
`sendStarter` is idempotent and about to be deleted.

- [ ] **Step 4: Broadcast on session start**

In the `START` path, after the session is confirmed running, call:
```js
broadcastChips();
```

- [ ] **Step 5: Update the message contract**

In `.claude/skills/message-contract/SKILL.md`, add a row to the **offscreen → ui** table (retitle
that section "**offscreen / background → ui**", since the service worker now also broadcasts):

```
| `COACH_CHIPS` | `phrases[]` (`{id, en, es}`), `notes[]` (`{id, title, body, open}`) | overlay, sidepanel |
```

Add a rule after rule 9:

```
10. **`COACH_CHIPS` comes from `background`, not offscreen.** It is derived from `settings`, not
    from the session, so it is broadcast on `START`, on `UI_SYNC`, and on any `storage.onChanged`
    touching `phraseIds`, `customPhrases`, `notes` or `liveCoach` — and it is *not* cleared when a
    session ends.
```

- [ ] **Step 6: Run the gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: preflight FAILS with `COACH_CHIPS` sent with no handler. **This is the expected result**
— Tasks 5 and 6 add the handlers. Record the failure and move on; do not add a stub handler to
silence it.

- [ ] **Step 7: Commit**

```bash
git add background.js .claude/skills/message-contract/SKILL.md
git commit -m "feat(background): broadcast COACH_CHIPS from settings

Chips stop being session state. The service worker is the only context with both
chrome.storage and chrome.tabs, so it owns the broadcast: on START, on UI_SYNC,
and on any settings change touching the chip keys. Handlers land next.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Render the two lanes in the side panel

**Files:**
- Modify: `sidepanel.html` — add the two lanes next to the existing chips block
- Modify: `sidepanel.js` — `els`, a `showChips` renderer, the message handler, `UI_SYNC` replay
- Modify: `sidepanel.css`

**Interfaces:**
- Consumes: `COACH_CHIPS` from Task 4; `NOTE_*` caps are not needed here (background already
  resolved them).
- Produces: a note toggle that writes `open` back into `settings.notes` via
  `chrome.storage.local`, which re-triggers `broadcastChips` in Task 4.

- [ ] **Step 1: Add the markup**

In `sidepanel.html`, inside `<section id="coach">`, after the existing `#hintOpeners` block:

```html
<div id="phrases" class="phrases"></div>
<div id="notes" class="notes"></div>
```

- [ ] **Step 2: Register the elements**

In `sidepanel.js`, add to the `els` object:
```js
phrases: $('phrases'), notes: $('notes'),
```

- [ ] **Step 3: Write the renderer**

```js
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
}

async function toggleNote(id) {
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  const notes = (stored.notes || []).map((n) => (n.id === id ? { ...n, open: !n.open } : n));
  await chrome.storage.local.set({ settings: { ...stored, notes } });
  // No re-render here: the write trips storage.onChanged in background.js, which
  // re-broadcasts COACH_CHIPS to all three views at once.
}
```

- [ ] **Step 4: Handle the message and the sync replay**

In the message handler, next to the `HINTS` case:
```js
else if (msg.type === 'COACH_CHIPS') showChips(msg);
```

**The side panel does not use `UI_SYNC`** — that is the overlay's path (`overlay.js:586`). The
panel starts with `PING_STATE` and reads `chrome.storage.local` directly in `init()`, and it *has*
`chrome.storage`, so it resolves its first render itself rather than waiting for a broadcast. Add
to the top of `sidepanel.js`:

```js
import { resolvePhrases, resolveNotes } from './phrasebook.js';
```

and in `init()`, after `settings` is assigned:

```js
// First paint without waiting for a broadcast; COACH_CHIPS keeps it live afterwards.
showChips({ phrases: resolvePhrases(settings), notes: resolveNotes(settings) });
```

- [ ] **Step 5: Style the lanes**

In `sidepanel.css`:

```css
.phrases { display: flex; flex-wrap: wrap; gap: 6px; }
.notes { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.note-head {
  width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
  color: inherit; font: inherit; padding: 3px 0;
}
.note-body { margin: 2px 0 6px 14px; white-space: pre-wrap; font-size: 12px; }
.notes:empty, .phrases:empty { display: none; }
```

- [ ] **Step 6: Run the gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: preflight still fails on `COACH_CHIPS` (the overlay handler is missing until Task 6), or
passes if it only requires one handler. Record which.

- [ ] **Step 7: Commit**

```bash
git add sidepanel.html sidepanel.js sidepanel.css
git commit -m "feat(sidepanel): render the phrase and note lanes

Phrases need no interaction. Notes are collapsed but persist their open state
through settings, so opening one is something the learner does before the
conversation, not during it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Render the two lanes in the page overlay

Same two lanes inside the overlay's Shadow DOM. The overlay has no `chrome.storage`, so its note
toggle goes through the service worker.

**Files:**
- Modify: `overlay.js` — CSS block, card markup, `showChips`, message handler, `UI_SYNC` replay
- Modify: `background.js` — a `TOGGLE_NOTE` handler
- Modify: `.claude/skills/message-contract/SKILL.md`

**Interfaces:**
- Consumes: `COACH_CHIPS` from Task 4.
- Produces: `{ type: 'TOGGLE_NOTE', id }` UI → background.

- [ ] **Step 1: Add the markup**

In the card template, after the `.hint-openers` block:
```html
<div class="phrases"></div>
<div class="notes"></div>
```

- [ ] **Step 2: Add the styles**

In the overlay's CSS string:
```css
.phrases { display: flex; flex-wrap: wrap; gap: 5px; }
.notes { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
.note-head {
  width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
  color: #e8eaed; font: inherit; font-size: 12px; padding: 2px 0;
}
.note-body { margin: 2px 0 5px 14px; white-space: pre-wrap; font-size: 11.5px; color: #bdc1c6; }
.notes:empty, .phrases:empty { display: none; }
.card.idle .phrases, .card.idle .notes { display: none; }
```

- [ ] **Step 3: Write the renderer**

```js
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
```

- [ ] **Step 4: Handle the message and the sync replay**

In the overlay's message switch:
```js
case 'COACH_CHIPS': showChips(msg); break;
```

In the `UI_SYNC` replay, alongside the existing `hints` handling:
```js
if (sync.chips) showChips(sync.chips);
```

- [ ] **Step 5: Add the router handler**

In `background.js`'s message switch:
```js
case 'TOGGLE_NOTE': {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const notes = (settings.notes || []).map((n) => (n.id === msg.id ? { ...n, open: !n.open } : n));
  await chrome.storage.local.set({ settings: { ...settings, notes } });
  sendResponse({ ok: true });
  break;
}
```

Add to `.claude/skills/message-contract/SKILL.md`, in the **UI → background** table:
```
| `TOGGLE_NOTE` | `id` | flips a note's `open` in settings; the write re-broadcasts `COACH_CHIPS` |
```

- [ ] **Step 6: Run the gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: preflight `0 failing`. Both `COACH_CHIPS` and `TOGGLE_NOTE` now have handlers.

- [ ] **Step 7: Commit**

```bash
git add overlay.js background.js .claude/skills/message-contract/SKILL.md
git commit -m "feat(overlay): render the phrase and note lanes

The content script has no chrome.storage, so toggling a note routes through the
service worker, whose write re-broadcasts COACH_CHIPS to every view.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Delete the live model layer

**Files:**
- Modify: `coach.js` — remove `askHints`, `askStarter`, `HINT_SYSTEM`, `STARTER_SYSTEM`,
  `HINT_SCHEMA`, `parseHints`, `HINTS_MAX_CHARS`, `HINTS_MAX_TURN_CHARS`
- Modify: `coach.test.js` — remove the tests that guard them
- Modify: `offscreen.js` — remove `scheduleHints`, `sendStarter`, the two timing constants, the
  four state fields, the `scheduleHints()` call, the `CONTEXT_CHANGED` handler, and the now-unused
  imports
- Modify: `sidepanel.html`, `sidepanel.js`, `sidepanel.css`, `overlay.js` — remove `#nudge`,
  `#hintOpeners`, `showHints`, the `HINTS` cases
- Modify: `background.js` — remove `lastUi.hints` and its replay
- Modify: `.claude/skills/message-contract/SKILL.md` — remove `HINTS` and `CONTEXT_CHANGED`

**Interfaces:**
- Consumes: everything from Tasks 4–6 must be working first — this task removes the only other
  path to the chips.
- Produces: `coach.js` exporting only `askReply`, `askReport`, `parseReply`, `turnsToText`,
  `contextBlock`, `redact`, `resolveProvider`, `groqBaseOf`, `anthropicBaseOf`, `PROVIDERS`,
  `DEFAULT_COACH`, `PROFILE_MAX_CHARS`, `CONTEXT_MAX_CHARS`.

- [ ] **Step 1: Delete from `coach.js`**

Remove `HINT_SYSTEM`, `HINT_SCHEMA`, `parseHints`, `askHints`, `STARTER_SYSTEM`, `askStarter`,
`HINTS_MAX_CHARS`, `HINTS_MAX_TURN_CHARS`. Keep `JSON_BUDGET` (`askReply` uses it), `clip`,
`TURN_MAX_CHARS`, and `SPANISH_MODE` / `langMode` if `askReply` still uses them — check before
removing either.

- [ ] **Step 2: Delete from `coach.test.js`**

Remove `parseHints returns capped words…`, `parseHints rejects a reply without words`, the three
2026-08-30 regression tests (`askHints leaves gpt-oss room…`, `askStarter leaves gpt-oss room…`,
`askHints bounds the conversation…`), `LIVE_SETTINGS`, `HINTS_JSON`, and `askHints` / `askStarter`
/ `parseHints` from the import line.

**Keep `stubGroq`, `REPLY_SETTINGS` and `REPLY_JSON`** — Task 3's `askReply` test uses them.

These tests die with the code they guard. That is the point: the 400 stops being possible rather
than being correctly budgeted.

- [ ] **Step 3: Delete from `offscreen.js`**

Remove `scheduleHints`, `sendStarter`, `HINT_DEBOUNCE_MS`, `HINT_COOLDOWN_MS`, the `hintTimer` /
`hintBusy` / `lastHintAt` / `starterBusy` state fields, every `sendStarter()` call site, and the
`CONTEXT_CHANGED` branch in the message listener. On line 83 keep `clearPartial()` and drop
`scheduleHints()`:

```js
if (entry.speaker === 'them') clearPartial();
```

Update the import to drop `askHints` and `askStarter`.

- [ ] **Step 4: Delete the old UI**

`sidepanel.html`: remove `<p id="nudge">`, the `#hintOpeners` block, and `<div id="chips">` —
Task 5 already added `#phrases`, which replaces it.
`sidepanel.js`: remove `showHints`, the `HINTS` case, and `chips` / `nudge` / `hintOpeners` from
`els`. Check `els.nudge.textContent = ''` at the two reset sites and remove those lines.
`sidepanel.css`: remove `.nudge` and `#chips` rules kept only for the old block.
`overlay.js`: remove `showHints`, the `HINTS` case, the `.nudge` and `.hint-openers` markup and
CSS, and `.nudge` / `.hint-openers` from the `.card.idle` rule.
`background.js`: remove `lastUi.hints`, its `attachOverlay` replay, its `UI_SYNC` field, its
assignment in the `ui` relay, and its line in the session reset.

- [ ] **Step 5: Update the message contract**

Remove the `HINTS` row from the ui table and `CONTEXT_CHANGED` from the background → offscreen
list.

- [ ] **Step 6: Run the gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: `0 failing, 0 warnings`, and no test referencing `askHints`. If preflight reports a
`HINTS` or `CONTEXT_CHANGED` left behind, a context was missed — find it before committing. This
is exactly the failure preflight exists to catch, since at runtime it is silent.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete the per-turn coach call

askHints ran every time the other person finished a turn to re-derive a list of
connectors that never changes. Two of its three fields did not depend on the
conversation at all. The curated phrasebook replaces it, so the live layer now
works with no API key and no network, and 'Coach: Groq cortó la respuesta a
medias' becomes impossible rather than correctly budgeted.

CONTEXT_CHANGED goes with it: its only consumer was the starter kit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The Settings section

**Files:**
- Modify: `setup.html` — new section 4, renumber the capture section to 5
- Modify: `setup.js` — render the catalogue, collect the selection, custom phrases, notes
- Modify: `setup.html` `<style>` or the shared CSS

**Interfaces:**
- Consumes: `CATALOGUE`, `DEFAULT_PHRASE_IDS`, `MAX_NOTES`, `MAX_CUSTOM`, `NOTE_TITLE_MAX`,
  `NOTE_BODY_MAX` from Task 2.
- Produces: `settings.phraseIds`, `settings.customPhrases`, `settings.notes` written by the
  existing save handler.

- [ ] **Step 1: Add the markup**

In `setup.html`, before the capture section (which becomes "5. Cómo capturar cada fuente"):

```html
<section>
  <h2 style="margin-top:0">4. Chips y notas</h2>
  <p class="hint">Las frases que quieres ver durante la conversación. No usan API ni conexión.</p>
  <div id="catalogue"></div>

  <label>Añadir una frase tuya</label>
  <div class="row">
    <input type="text" id="customEn" placeholder="Let me double-check that," />
    <input type="text" id="customEs" placeholder="déjame confirmarlo" />
    <button id="addPhrase" class="small" type="button">Añadir</button>
  </div>
  <div id="customList"></div>

  <label>Notas</label>
  <p class="hint">Apuntes tuyos: un título corto y el texto que quieras tener a mano.</p>
  <div id="noteList"></div>
  <button id="addNote" class="small" type="button">Añadir nota</button>
</section>
```

- [ ] **Step 2: Import and render the catalogue**

In `setup.js`:

```js
import { CATALOGUE, DEFAULT_PHRASE_IDS, MAX_NOTES, MAX_CUSTOM, NOTE_TITLE_MAX, NOTE_BODY_MAX }
  from './phrasebook.js';

let customPhrases = [];
let notes = [];

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
      box.append(label);
    }
  }
}
```

- [ ] **Step 3: Render the custom phrases and the notes**

```js
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
    row.append(en, es, del);
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
```

- [ ] **Step 4: Wire the two add buttons**

```js
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
```

- [ ] **Step 5: Save and load**

In the save handler's `next` object, add:
```js
phraseIds: [...document.querySelectorAll('.phrase-cb:checked')].map((cb) => cb.value),
customPhrases,
notes: notes.filter((n) => (n.title || '').trim() || (n.body || '').trim()),
```

In `init()`, after the other field assignments:
```js
customPhrases = Array.isArray(s.customPhrases) ? s.customPhrases : [];
notes = Array.isArray(s.notes) ? s.notes : [];
renderCatalogue(Array.isArray(s.phraseIds) ? s.phraseIds : DEFAULT_PHRASE_IDS);
renderCustom();
renderNotes();
```

- [ ] **Step 6: Relabel `liveCoach`**

It no longer calls a model. In `setup.html`, change its label to
`Mostrar chips y notas durante la conversación` and drop any wording about the live model.

- [ ] **Step 7: Run the gate and check the CSP**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: `0 failing, 0 warnings`. Preflight also checks CSP — confirm no inline event-handler
attribute crept into the new markup (every listener above is attached in JS, which is why).

- [ ] **Step 8: Commit**

```bash
git add setup.html setup.js
git commit -m "feat(setup): let the learner curate their chips and notes

Catalogue by category with checkboxes, their own phrases, and titled notes.
liveCoach now means 'show the chips' rather than 'call the model live'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Update the project documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`, `STORE.md` where they describe the live coach

**Interfaces:**
- Consumes: the finished behaviour from Tasks 2–8.
- Produces: no code.

- [ ] **Step 1: Update `CLAUDE.md`**

- In the storage paragraph, add `phraseIds`, `customPhrases` and `notes` to the list of
  `chrome.storage.local` keys held inside `settings`.
- In "Pure logic stays pure", add `phrasebook.js` to the list of modules that import no `chrome.*`.
- In "Known debt", remove or soften the note that `coach.js` "is past 600 lines and holds five
  prompt families" — it now holds three (reply, report, and the Spanish-mode override). Check the
  real line count before rewriting the claim.

- [ ] **Step 2: Update the user-facing docs**

Search for descriptions of the live chips:
```bash
grep -n "chips\|sugerencias\|hints" README.md STORE.md
```
Rewrite them to describe a curated phrasebook that works with no API key, and note that the API
key is now needed only for the suggested reply and the closing report.

- [ ] **Step 3: Verify the claims you just wrote**

```bash
wc -l coach.js
grep -c "SYSTEM = \`" coach.js
```
Do not write a line count or a prompt-family count you have not just measured.

- [ ] **Step 4: Run the gate one final time**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```

- [ ] **Step 5: Reload and test in Chrome — this cannot be skipped**

Static checks cannot verify capture, permissions, the Shadow DOM, or that a note toggle round-trips
through three views. Reload at `chrome://extensions`, then confirm by hand:

1. Chips appear in the side panel **before** starting a session.
2. Chips appear in the page overlay, and survive a page reload (the `UI_SYNC` replay).
3. Toggling a note open in the overlay updates the side panel too.
4. With the Groq key deleted from Settings, chips still render; only the reply button reports a
   missing key.
5. A full session start → speak → stop → report still works.

Report which of these you actually ran. Do not imply the others were tested.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md STORE.md
git commit -m "docs: describe the curated phrasebook

The live layer no longer calls a model, so the API key is only needed for the
suggested reply and the closing report.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
