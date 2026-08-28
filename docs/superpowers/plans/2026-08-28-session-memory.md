# Session Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the suggested reply, the closing report and a durable error lake a memory of the whole conversation, instead of the last 1200 characters.

**Architecture:** Two new dependency-free modules. `memory.js` owns session-memory state, chunk selection, the anti-hallucination guards, the token ledger and the accumulated lake. `retrieval.js` owns tokenisation, an IDF index, question routing and reply-context assembly. `offscreen.js` orchestrates; `coach.js` keeps owning prompts and providers. Every number that reacts to a provider's rate limit derives from one new `tpm` field in the `PROVIDERS` table.

**Tech Stack:** Plain ES modules, no dependencies, no build step. Chrome MV3 (minimum 116). Tests are `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-28-session-memory-design.md`

## Global Constraints

- **No build step, no `package.json`, no dependencies, no bundler.** Every shipped file is written by hand.
- **Never edit `vendor/` or `icons/`.**
- **No new Chrome permission.** In particular not `unlimitedStorage`; the lake is capped instead.
- **No new message type.** Preflight fails on any SCREAMING_SNAKE type sent with no handler.
- **The offscreen document has no `chrome.storage`.** All of its reads/writes go through `STORE_GET` / `STORE_SET`.
- **Pure logic stays pure.** `memory.js` and `retrieval.js` import no `chrome.*` and take `now` as an injected parameter, exactly like `segmenter.js`.
- **Repository language is English** — identifiers, comments, docs, commit messages. **Product strings are Spanish** and must never be "fixed" into English.
- **Never pass dynamic content to `innerHTML`.** Use `textContent` / `createElement`.
- **User-visible errors are prefixed with the stage** that produced them (`[offscreen]`, `[captura]`).
- Constants, verbatim from the spec:
  - `CHUNK_BAND = [0.8, 1.2]`, `OVERLAP_CHARS = 400`, `CHUNK_MAX_FACTOR = 1.5`, `REPLY_TAIL_FACTOR = 1.5`
  - `CHUNK_CHARS` = 1800 when `tpm` is set, 4000 when `tpm` is null
  - `DISTILL_COOLDOWN_MS = 45000`, `BUDGET_WINDOW_MS = 60000`, `BUDGET_SAFETY = 0.75`, `DISTILL_MAX_TOKENS = 900`
  - `NOMINAL_COST = { hints: 1400, starter: 900, reply: 3400, report: 6000, distill: 1300 }`
  - `CAPS = { topics: 60, open: 12, errors: 40, lakeEntries: 200, samples: 3, vetoed: 200 }`
  - `WRONG_MAX_CHARS = 60`, `MIN_QUOTE_CHARS = 12`
  - `MIN_CONTENT_TERMS = 2`, `SCORE_FLOOR = 0.35`, `EVIDENCE_TURNS = 3`, `QUERY_MAX_CHARS = 400`
  - `RECURRENCE_MIN = 2`
- Verification gate after every task:
  ```bash
  node .claude/skills/preflight/scripts/preflight.mjs
  node --test *.test.js
  ```

## File Structure

| File | Responsibility |
|---|---|
| `memory.js` *(new)* | Session-memory state and reconciliation, chunk selection, acceptance guards, token ledger, accumulated lake. No `chrome.*`. |
| `retrieval.js` *(new)* | Tokenisation, IDF index, query extraction, scoring, three-way routing, reply-context assembly. Imports `normalizeText` from `memory.js`; nothing else. |
| `memory.test.js` *(new)* | Node tests for `memory.js`. |
| `retrieval.test.js` *(new)* | Node tests for `retrieval.js`. |
| `coach.js` | Gains `tpm` per provider, `askDistill` + `parseDistill`, a `context` parameter on `askReply`, and memory-aware report prompts. Still the only file that talks to a provider. |
| `offscreen.js` | Schedules distillation, wires the ledger, flushes at stop, merges into the lake. Holds no logic worth testing. |
| `sidepanel.js` | Clears `memory` in the same gesture that clears `transcript`. |
| `report.html` / `report.js` | Phase B: renders the lake with a per-entry veto. |
| `setup.html` / `setup.js` | Phase B: clears the lake. |
| `CLAUDE.md`, `PRIVACY.md` | Documentation of the new invariants and of what the lake stores. |

Turns are atomic everywhere: a chunk never splits one. Splitting would break the LEARNER-line attribution guard, which is the only thing preventing the other speaker's words from being recorded as the learner's mistakes.

---

# Phase A — session memory

### Task 1: `memory.js` skeleton, sizing and reconciliation

**Files:**
- Create: `memory.js`
- Create: `memory.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sizing(tpm) → { chunkChars, tailChars }`, `emptyMemory(sessionId) → memory`, `reconcile(memory, turns) → memory`, and the exported constants listed in Global Constraints.

- [ ] **Step 1: Write the failing test**

```js
// memory.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sizing, emptyMemory, reconcile } from './memory.js';

test('sizing derives the chunk and tail from the provider budget', () => {
  assert.deepEqual(sizing(8000), { chunkChars: 1800, tailChars: 2700 });
  assert.deepEqual(sizing(null), { chunkChars: 4000, tailChars: 6000 });
});

test('the reply tail always covers at least one and a half chunks', () => {
  for (const tpm of [8000, null]) {
    const { chunkChars, tailChars } = sizing(tpm);
    assert.ok(tailChars >= chunkChars * 1.5);
  }
});

test('emptyMemory starts uncovered', () => {
  const m = emptyMemory('s1');
  assert.equal(m.sessionId, 's1');
  assert.equal(m.coveredUntil, 0);
  assert.deepEqual(m.topics, []);
  assert.equal(m.merged, false);
});

test('reconcile resets a memory that outruns its transcript', () => {
  const m = { ...emptyMemory('s1'), coveredUntil: 9000, topics: [{ text: 'x', quote: 'y', t: 10 }] };
  const fresh = reconcile(m, [{ speaker: 'me', text: 'hi', t: 100, dur: 1 }]);
  assert.equal(fresh.coveredUntil, 0);
  assert.deepEqual(fresh.topics, []);
  assert.equal(fresh.sessionId, 's1');
});

test('reconcile resets when the transcript was cleared', () => {
  const m = { ...emptyMemory('s1'), coveredUntil: 50 };
  assert.equal(reconcile(m, []).coveredUntil, 0);
});

test('reconcile keeps a consistent memory untouched', () => {
  const m = { ...emptyMemory('s1'), coveredUntil: 100 };
  const turns = [{ speaker: 'me', text: 'hi', t: 100, dur: 1 }, { speaker: 'them', text: 'yo', t: 200, dur: 1 }];
  assert.equal(reconcile(m, turns), m);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test memory.test.js`
Expected: FAIL — `Cannot find module './memory.js'`

- [ ] **Step 3: Write the minimal implementation**

```js
// memory.js
// Session memory: what the coach remembers about a conversation that is longer
// than any single prompt. Pure — no chrome.*, `now` injected — so it runs in Node.

export const CHUNK_BAND = [0.8, 1.2];
export const OVERLAP_CHARS = 400;
export const CHUNK_MAX_FACTOR = 1.5;
export const REPLY_TAIL_FACTOR = 1.5;
export const DISTILL_COOLDOWN_MS = 45000;
export const BUDGET_WINDOW_MS = 60000;
export const BUDGET_SAFETY = 0.75;
export const WRONG_MAX_CHARS = 60;
export const MIN_QUOTE_CHARS = 12;
export const RECURRENCE_MIN = 2;

export const NOMINAL_COST = { hints: 1400, starter: 900, reply: 3400, report: 6000, distill: 1300 };
export const CAPS = { topics: 60, open: 12, errors: 40, lakeEntries: 200, samples: 3, vetoed: 200 };

// A rate-limited provider gets small chunks so a round fits in whatever the live
// hints leave of the minute; an unmetered one gets bigger ones, which distil better.
export function sizing(tpm) {
  const chunkChars = tpm ? 1800 : 4000;
  return { chunkChars, tailChars: chunkChars * REPLY_TAIL_FACTOR };
}

export function emptyMemory(sessionId) {
  return {
    sessionId, coveredUntil: 0, carry: '', merged: false,
    topics: [], open: [], errors: [],
    rounds: 0, skipped: 0, rejected: 0,
  };
}

// The transcript can be cleared from the side panel while the offscreen document
// is still holding a memory of it. An orphaned memory would narrate a
// conversation that no longer exists, so it resets itself on read.
export function reconcile(memory, turns) {
  if (!memory) return emptyMemory(null);
  const newest = turns.reduce((n, t) => (t.t > n ? t.t : n), 0);
  if (memory.coveredUntil > newest) return emptyMemory(memory.sessionId);
  return memory;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test memory.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add memory.js memory.test.js
git commit -m "feat(memory): session memory state, provider sizing and reconciliation"
```

---

### Task 2: Chunk selection — the fold invariant and the pause cut

**Files:**
- Modify: `memory.js`
- Modify: `memory.test.js`

**Interfaces:**
- Consumes: `sizing`, `CHUNK_BAND`, `OVERLAP_CHARS`, `CHUNK_MAX_FACTOR` from Task 1.
- Produces: `linesOf(turns) → string`, `selectChunk(turns, memory, chunkChars, { all = false } = {}) → null | { turns, text, overlapTurns, overlap, endsAt, chars }`.

`all: true` is the final flush at `stop()`. There the segmenters have been flushed and the queue drained, so nothing can fold any more and the newest turn is safe to include — which it must be, or the last thing the learner said never reaches the report.

`foldIntoTranscript` in `segmenter.js` mutates the stored turn with the highest `t` when the same speaker continues within `MERGE_GAP_MS`. Distilling that turn would silently lose whatever gets appended afterwards, so it is always excluded.

- [ ] **Step 1: Write the failing test**

```js
// append to memory.test.js
import { selectChunk, linesOf } from './memory.js';

const turn = (speaker, text, t, dur = 1) => ({ speaker, text, t, dur });
const filler = (n) => 'word '.repeat(n).trim();

test('linesOf labels the speakers the way the coach prompts expect', () => {
  assert.equal(linesOf([turn('me', 'hi', 1), turn('them', 'yo', 2)]), 'LEARNER: hi\nOTHER: yo');
});

test('selectChunk never includes the newest turn, which folding can still grow', () => {
  const turns = [
    turn('them', filler(200), 1000),
    turn('me', filler(200), 20000),
    turn('them', filler(200), 40000),
  ];
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.ok(chunk);
  assert.ok(chunk.turns.every((t) => t.t !== 40000));
  assert.equal(chunk.endsAt, 20000);
});

test('selectChunk returns null below the chunk size', () => {
  const turns = [turn('them', 'short', 1000), turn('me', 'also short', 2000), turn('them', 'x', 3000)];
  assert.equal(selectChunk(turns, { coveredUntil: 0 }, 1800), null);
});

test('selectChunk cuts at the largest silence inside the band', () => {
  // Each turn is ~500 chars. The band for 1800 is [1440, 2160], so the cut can
  // land after turn 3 (~1500) or turn 4 (~2000). Turn 3 is followed by a 6 s
  // silence and turn 4 by 200 ms, so the cut must land after turn 3.
  // No turn sits at t=0: that is the "nothing covered yet" sentinel, and a turn
  // there would be filtered out by `t.t > covered`, shifting the whole trace.
  const turns = [
    turn('them', filler(100), 1000, 5),
    turn('me', filler(100), 6000, 5),
    turn('them', filler(100), 12000, 5),
    turn('me', filler(100), 23000, 5),   // 6 s gap before this one
    turn('them', filler(100), 28200, 5), // 200 ms gap before this one
    turn('me', filler(100), 34000, 5),
  ];
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.equal(chunk.endsAt, 12000);
});

test('selectChunk caps a backlogged chunk instead of sending one huge block', () => {
  const turns = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? 'me' : 'them', filler(100), 1000 + i * 1000, 0.5));
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.ok(chunk.chars <= 1800 * 1.5);
});

test('selectChunk takes an oversized single turn whole — turns are atomic', () => {
  const turns = [turn('me', filler(1000), 1000, 20), turn('them', 'ok', 30000)];
  const chunk = selectChunk(turns, { coveredUntil: 0 }, 1800);
  assert.equal(chunk.turns.length, 1);
  assert.ok(chunk.chars > 1800 * 1.5);
});

test('the final flush takes everything left, newest turn included', () => {
  const turns = [turn('them', 'short one', 1000), turn('me', 'short two', 2000), turn('them', 'last word', 3000)];
  assert.equal(selectChunk(turns, { coveredUntil: 0 }, 1800), null);
  const flush = selectChunk(turns, { coveredUntil: 0 }, 1800, { all: true });
  assert.equal(flush.turns.length, 3);
  assert.equal(flush.endsAt, 3000);
});

test('the final flush returns null when everything is already covered', () => {
  const turns = [turn('me', 'hi', 1000), turn('them', 'yo', 2000)];
  assert.equal(selectChunk(turns, { coveredUntil: 2000 }, 1800, { all: true }), null);
});

test('selectChunk carries the tail of what was already distilled as overlap', () => {
  const turns = [
    turn('them', 'previously agreed on the retry policy', 1000),
    turn('me', filler(200), 10000),
    turn('them', filler(200), 20000),
    turn('me', 'still talking', 30000),
  ];
  const chunk = selectChunk(turns, { coveredUntil: 1000 }, 1800);
  assert.ok(chunk.overlap.includes('retry policy'));
  assert.ok(!chunk.text.includes('retry policy'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test memory.test.js`
Expected: FAIL — `selectChunk is not a function`

- [ ] **Step 3: Write the minimal implementation**

```js
// append to memory.js
export const linesOf = (turns) =>
  turns.map((t) => `${t.speaker === 'me' ? 'LEARNER' : 'OTHER'}: ${t.text}`).join('\n');

const byTime = (turns) => [...turns].sort((a, b) => a.t - b.t);
const endOf = (t) => t.t + (t.dur || 0) * 1000;

// The VAD cuts audio on silence; this cuts text the same way. Inside the band
// around the target size, the chunk ends at the largest pause between turns, so
// an idea is far less likely to be split across two distillation rounds.
export function selectChunk(turns, memory, chunkChars, { all = false } = {}) {
  const sorted = byTime(turns);
  if (!sorted.length) return null;

  // foldIntoTranscript can only ever extend the turn with the highest `t`.
  // Distilling it would lose whatever is appended to it afterwards — silently.
  // The exception is the final flush: by then the segmenters are flushed and the
  // queue is drained, so nothing can grow and the last turn must be included.
  const newest = sorted[sorted.length - 1].t;
  const covered = memory?.coveredUntil || 0;
  const pending = sorted.filter((t) => t.t > covered && (all || t.t < newest));
  if (!pending.length) return null;

  const size = (t) => t.text.length + 1;
  const total = pending.reduce((n, t) => n + size(t), 0);
  if (!all && total < chunkChars) return null;

  if (all) {
    const overlapAll = linesOf(sorted.filter((t) => t.t <= covered)).slice(-OVERLAP_CHARS);
    const textAll = linesOf(pending);
    return {
      turns: pending, text: textAll,
      overlapTurns: sorted.filter((t) => t.t <= covered), overlap: overlapAll,
      endsAt: pending[pending.length - 1].t, chars: textAll.length,
    };
  }

  const lo = chunkChars * CHUNK_BAND[0];
  const hi = Math.min(chunkChars * CHUNK_BAND[1], chunkChars * CHUNK_MAX_FACTOR);

  let acc = 0;
  let cut = -1;
  let bestGap = -1;
  for (let i = 0; i < pending.length; i++) {
    acc += size(pending[i]);
    if (acc < lo) continue;
    const next = pending[i + 1];
    const gap = next ? Math.max(0, next.t - endOf(pending[i])) : 0;
    const bonus = next && next.speaker !== pending[i].speaker ? 1 : 0;
    if (cut === -1 || gap + bonus > bestGap) { bestGap = gap + bonus; cut = i; }
    if (acc >= hi) break;
  }
  // A single turn longer than the ceiling: taken whole. Turns are atomic because
  // splitting one would break the LEARNER-line attribution guard.
  if (cut === -1) cut = 0;

  const chunk = pending.slice(0, cut + 1);
  const overlapTurns = sorted.filter((t) => t.t <= covered);
  const overlap = linesOf(overlapTurns).slice(-OVERLAP_CHARS);
  const text = linesOf(chunk);
  return { turns: chunk, text, overlapTurns, overlap, endsAt: chunk[chunk.length - 1].t, chars: text.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test memory.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add memory.js memory.test.js
git commit -m "feat(memory): chunk selection on pauses, excluding the foldable newest turn"
```

---

### Task 3: The acceptance guards

**Files:**
- Modify: `memory.js`
- Modify: `memory.test.js`

**Interfaces:**
- Consumes: `WRONG_MAX_CHARS`, `MIN_QUOTE_CHARS`, `CAPS` from Task 1.
- Produces: `normalizeText(s) → string`, `acceptItems(raw, anchorTurns) → [{ text, quote, t }]`, `acceptErrors(raw, chunkTurns) → [{ wrong, right, kind, said, t }]`, `mergeTopics(existing, incoming, cap) → array`.

Nothing verifiable in JS is asked of the model. `said` and every `t` are derived here, never requested — one less field is one less hallucination surface.

- [ ] **Step 1: Write the failing test**

```js
// append to memory.test.js
import { normalizeText, acceptItems, acceptErrors, mergeTopics } from './memory.js';

test('normalizeText folds case, punctuation and whitespace', () => {
  assert.equal(normalizeText('  It DEPENDS, of the API!  '), 'it depends of the api');
});

test('normalizeText folds accents, so the Spanish stopword list can be plain', () => {
  assert.equal(normalizeText('¿Y qué pasa con el despliegue?'), 'y que pasa con el despliegue');
});

test('acceptItems keeps only items whose quote is verbatim in the chunk', () => {
  const chunk = [turn('them', 'We agreed to ship the retry policy on Friday', 100)];
  const out = acceptItems([
    { text: 'Retry policy ships Friday', quote: 'ship the retry policy on Friday' },
    { text: 'They approved the budget', quote: 'the budget was approved yesterday' },
  ], chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Retry policy ships Friday');
  assert.equal(out[0].t, 100);
});

test('acceptItems rejects a quote too short to prove anything', () => {
  const chunk = [turn('them', 'We agreed to ship it', 100)];
  assert.deepEqual(acceptItems([{ text: 'x', quote: 'ship' }], chunk), []);
});

test('acceptErrors anchors the wrong pair to a LEARNER line and derives said/t', () => {
  const chunk = [
    turn('them', 'It depends of the load, right?', 100),
    turn('me', 'Yes, it depends of the load in production', 200),
  ];
  const out = acceptErrors([{ wrong: 'depends of', right: 'depends on', kind: 'grammar' }], chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].said, 'Yes, it depends of the load in production');
  assert.equal(out[0].t, 200);
});

test('acceptErrors refuses to attribute the other speaker words to the learner', () => {
  const chunk = [turn('them', 'It depends of the load', 100), turn('me', 'Sure', 200)];
  assert.deepEqual(acceptErrors([{ wrong: 'depends of', right: 'depends on' }], chunk), []);
});

test('acceptErrors drops a correction that changes nothing', () => {
  const chunk = [turn('me', 'I have five years working here', 100)];
  assert.deepEqual(acceptErrors([{ wrong: 'five years', right: 'Five  years.' }], chunk), []);
});

test('acceptErrors drops a whole paragraph posing as a minimal pair', () => {
  const long = 'a'.repeat(80);
  const chunk = [turn('me', long, 100)];
  assert.deepEqual(acceptErrors([{ wrong: long, right: 'something else' }], chunk), []);
});

test('acceptErrors defaults an unknown kind to grammar', () => {
  const chunk = [turn('me', 'I am agree with that', 100)];
  assert.equal(acceptErrors([{ wrong: 'I am agree', right: 'I agree', kind: 'nonsense' }], chunk)[0].kind, 'grammar');
});

test('mergeTopics folds a topic split across two rounds', () => {
  const existing = [{ text: 'The retry policy for the payment gateway', quote: 'q1', t: 1 }];
  const out = mergeTopics(existing, [{ text: 'The retry policy for the payment gateway was discussed', quote: 'q2', t: 2 }], 60);
  assert.equal(out.length, 1);
});

test('mergeTopics caps and drops the oldest', () => {
  const existing = Array.from({ length: 60 }, (_, i) => ({ text: `topic ${i}`, quote: 'q', t: i }));
  const out = mergeTopics(existing, [{ text: 'brand new topic here', quote: 'q', t: 999 }], 60);
  assert.equal(out.length, 60);
  assert.equal(out[out.length - 1].t, 999);
  assert.ok(!out.some((x) => x.t === 0));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test memory.test.js`
Expected: FAIL — `normalizeText is not a function`

- [ ] **Step 3: Write the minimal implementation**

```js
// append to memory.js
const KINDS = new Set(['grammar', 'calque', 'register']);

// Accents are folded too. It makes the Spanish stopword list plain ASCII, and it
// makes anchoring survive a recogniser that drops a tilde — which it does.
export const normalizeText = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}/gu, '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// A topic is a summary, so the summary is free and its evidence is not: the quote
// has to appear verbatim in the fragment or the item is dropped without comment.
export function acceptItems(raw, anchorTurns) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = String(item?.text ?? '').trim();
    const quote = String(item?.quote ?? '').trim();
    if (!text || quote.length < MIN_QUOTE_CHARS) continue;
    const needle = normalizeText(quote);
    if (!needle) continue;
    const turn = anchorTurns.find((t) => normalizeText(t.text).includes(needle));
    if (!turn) continue;
    out.push({ text, quote, t: turn.t });
  }
  return out;
}

// One lookup enforces two guards at once: the wrong pair must exist verbatim, and
// it must exist in a LEARNER line — a mistake quoted from the other speaker is a
// misattribution by definition.
export function acceptErrors(raw, chunkTurns) {
  const learner = chunkTurns.filter((t) => t.speaker === 'me');
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const wrong = String(e?.wrong ?? '').trim();
    const right = String(e?.right ?? '').trim();
    if (!wrong || !right || wrong.length > WRONG_MAX_CHARS) continue;
    const needle = normalizeText(wrong);
    if (!needle || needle === normalizeText(right)) continue;
    const turn = learner.find((t) => normalizeText(t.text).includes(needle));
    if (!turn) continue;
    out.push({ wrong, right, kind: KINDS.has(e?.kind) ? e.kind : 'grammar', said: turn.text, t: turn.t });
  }
  return out;
}

// Cutting on a pause is not perfect: an idea can still straddle two rounds and
// arrive as two near-identical topics. Folding them is plain string work, not a
// second model call.
const topicKey = (t) => normalizeText(t.text).slice(0, 40);

export function mergeTopics(existing, incoming, cap) {
  const out = [...existing];
  const seen = new Set(out.map(topicKey));
  for (const item of incoming) {
    const key = topicKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(-cap);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test memory.test.js`
Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add memory.js memory.test.js
git commit -m "feat(memory): acceptance guards anchoring every extraction to the transcript"
```

---

### Task 4: The token ledger

**Files:**
- Modify: `memory.js`
- Modify: `memory.test.js`

**Interfaces:**
- Consumes: `NOMINAL_COST`, `BUDGET_WINDOW_MS`, `BUDGET_SAFETY` from Task 1.
- Produces: `class Ledger { constructor(now); spend(kind); spent(); room(tpm, kind) }`.

Costs are nominal estimates, not accounting. The point is the safety margin, not the number.

- [ ] **Step 1: Write the failing test**

```js
// append to memory.test.js
import { Ledger } from './memory.js';

test('the ledger only counts the last minute', () => {
  let clock = 0;
  const ledger = new Ledger(() => clock);
  ledger.spend('hints');           // 1400
  clock = 30000;
  ledger.spend('hints');           // 1400
  assert.equal(ledger.spent(), 2800);
  clock = 61000;                   // the first one has aged out
  assert.equal(ledger.spent(), 1400);
});

test('the ledger refuses a round that would breach the safety margin', () => {
  let clock = 0;
  const ledger = new Ledger(() => clock);
  for (let i = 0; i < 4; i++) ledger.spend('hints');   // 5600 of 8000
  assert.equal(ledger.room(8000, 'distill'), false);   // 5600 + 1300 > 8000 * 0.75
});

test('the ledger always has room on an unmetered provider', () => {
  const ledger = new Ledger(() => 0);
  for (let i = 0; i < 20; i++) ledger.spend('report');
  assert.equal(ledger.room(null, 'distill'), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test memory.test.js`
Expected: FAIL — `Ledger is not a constructor`

- [ ] **Step 3: Write the minimal implementation**

```js
// append to memory.js
// A rolling estimate of what the current minute has already cost, so a background
// round never spends the budget a user-requested reply is about to need. The
// figures are nominal: the margin is the mechanism, not the arithmetic.
export class Ledger {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.events = [];
  }

  spend(kind) {
    this.events.push({ at: this.now(), tokens: NOMINAL_COST[kind] || 0 });
  }

  spent() {
    const from = this.now() - BUDGET_WINDOW_MS;
    this.events = this.events.filter((e) => e.at >= from);
    return this.events.reduce((n, e) => n + e.tokens, 0);
  }

  room(tpm, kind) {
    if (!tpm) return true;
    return this.spent() + (NOMINAL_COST[kind] || 0) <= tpm * BUDGET_SAFETY;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test memory.test.js`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add memory.js memory.test.js
git commit -m "feat(memory): rolling token ledger so background work yields to the reply"
```

---

### Task 5: `coach.js` — provider budgets and the distiller call

**Files:**
- Modify: `coach.js` (`PROVIDERS` at line 4; new section after `askStarter`)
- Modify: `coach.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks — `coach.js` must not import `memory.js`.
- Produces: `PROVIDERS[p].tpm`, `tpmOf(settings) → number | null`, `parseDistill(raw) → { topics, open, errors, carry }`, `askDistill({ chunk, settings }) → same shape`.

`parseDistill` validates **shape**; `memory.js` validates **truth**. Keep them apart.

- [ ] **Step 1: Write the failing test**

```js
// append to coach.test.js
import { parseDistill, tpmOf, PROVIDERS } from './coach.js';

test('every provider declares a per-minute budget', () => {
  for (const spec of Object.values(PROVIDERS)) assert.ok('tpm' in spec);
});

test('tpmOf takes the tightest budget in play', () => {
  assert.equal(tpmOf({ liveProvider: 'groq', reportProvider: 'groq' }), 8000);
  assert.equal(tpmOf({ liveProvider: 'anthropic', reportProvider: 'anthropic' }), null);
  // Mixed: the metered half is the one that can 429, so it sets the policy.
  assert.equal(tpmOf({ liveProvider: 'groq', reportProvider: 'anthropic' }), 8000);
  assert.equal(tpmOf({ liveProvider: 'nope', reportProvider: 'nope' }), 8000);
});

test('parseDistill returns the four groups and tolerates missing ones', () => {
  const out = parseDistill(JSON.stringify({ topics: [{ text: 'a', quote: 'bbbbbbbbbbbb' }] }));
  assert.equal(out.topics.length, 1);
  assert.deepEqual(out.open, []);
  assert.deepEqual(out.errors, []);
  assert.equal(out.carry, '');
});

test('parseDistill reads a fenced JSON block', () => {
  const raw = '```json\n{"topics":[],"open":[],"errors":[],"carry":"still on pricing"}\n```';
  assert.equal(parseDistill(raw).carry, 'still on pricing');
});

test('parseDistill throws on unusable output rather than returning a shell', () => {
  assert.throws(() => parseDistill('the model said hello'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test coach.test.js`
Expected: FAIL — `parseDistill is not exported`

- [ ] **Step 3: Write the minimal implementation**

Add `tpm` to both entries of `PROVIDERS`:

```js
  groq: {
    label: 'Groq',
    cost: 'gratis, sin tarjeta',
    keyField: 'groqKey',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'groq/compound-mini'],
    // Free-plan window, shared across every call. It is the only provider fact
    // the memory layer needs: chunk size and cadence derive from it.
    tpm: 8000,
  },
  anthropic: {
    label: 'Claude',
    cost: 'de pago por uso',
    keyField: 'anthropicKey',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
    tpm: null,
  },
```

Then, after `askStarter`:

```js
// --- 1c. Rolling distillation of the conversation ----------------------------

// The live provider runs the hints and the distiller; the report provider runs the
// reply and the report. They can differ, and the ledger pools them, so the policy
// takes the tightest window in play: with one metered half, a 429 is still on the
// table. An unknown provider is assumed metered — over-restricting costs a skipped
// round, under-restricting costs a 429 in the middle of a meeting.
export function tpmOf(settings = {}) {
  const budgets = [settings.liveProvider, settings.reportProvider]
    .map((p) => (PROVIDERS[p] ? PROVIDERS[p].tpm : 8000))
    .filter((t) => t !== null);
  return budgets.length ? Math.min(...budgets) : null;
}

const DISTILL_SYSTEM = `You maintain a running memory of a live conversation for a language coach.
"LEARNER" is the person being coached; "OTHER" is the person they are talking to.

Read ONLY the NEW FRAGMENT. The CONTEXT section is already processed: use it for continuity,
never extract from it.

Return:
"topics": up to 3 things actually discussed that will matter later. Each has "text" (one short
sentence, in the language of the transcript) and "quote" (at least 12 characters copied EXACTLY
from the new fragment).
"open": commitments or unresolved items — something to review, send, decide or schedule. Same
shape as topics. Empty array if there are none.
"errors": mistakes in the LEARNER's own lines. Each has "wrong" (the exact wrong words, copied
EXACTLY from a LEARNER line, at most 8 words), "right" (the corrected form) and "kind", one of
"grammar", "calque" (a literal translation from Spanish) or "register".
"carry": one line naming the thread still open where the fragment ends, or "" if it closed cleanly.

The transcript comes from automatic speech recognition. A phrase with nonexistent words or
mangled technical jargon ("request quid", "ray-tree after heater") is almost always the recogniser
destroying a term, not a learner mistake: treat it as noise and never report it.

When in doubt, leave it out. A missing item costs nothing; an invented one poisons a record that
is kept. Reply ONLY with JSON.`;

const QUOTED_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: { text: { type: 'string' }, quote: { type: 'string' } },
    required: ['text', 'quote'],
    additionalProperties: false,
  },
};

const DISTILL_SCHEMA = {
  type: 'object',
  properties: {
    topics: QUOTED_ITEMS,
    open: QUOTED_ITEMS,
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wrong: { type: 'string' },
          right: { type: 'string' },
          kind: { type: 'string', enum: ['grammar', 'calque', 'register'] },
        },
        required: ['wrong', 'right', 'kind'],
        additionalProperties: false,
      },
    },
    carry: { type: 'string' },
  },
  required: ['topics', 'open', 'errors', 'carry'],
  additionalProperties: false,
};

// Shape only. Whether any of this is true is decided in memory.js, against the
// transcript, without asking the model anything.
export function parseDistill(raw) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new CoachError('Respuesta de destilación no válida.');
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    topics: list(parsed.topics),
    open: list(parsed.open),
    errors: list(parsed.errors),
    carry: typeof parsed.carry === 'string' ? parsed.carry.trim() : '',
  };
}

// Runs on the live (cheap) model: this is background work that must never
// compete with the reply the learner is waiting for.
export async function askDistill({ chunk, settings }) {
  const raw = await ask({
    provider: settings.liveProvider,
    model: settings.liveModel,
    keys: settings,
    system: DISTILL_SYSTEM,
    user: `Situation: ${settings.situation}.`
      + (chunk.carry ? `\n\nThe previous fragment ended while discussing: ${chunk.carry}` : '')
      + (chunk.overlap ? `\n\nCONTEXT (already processed, do not extract):\n${chunk.overlap}` : '')
      + `\n\nNEW FRAGMENT:\n${chunk.text}`,
    // Reasoning models spend from the same budget before writing the JSON.
    maxTokens: 900,
    schema: DISTILL_SCHEMA,
  });
  return parseDistill(raw);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test coach.test.js && node .claude/skills/preflight/scripts/preflight.mjs`
Expected: PASS, and preflight clean.

- [ ] **Step 5: Commit**

```bash
git add coach.js coach.test.js
git commit -m "feat(coach): per-provider token budget and the distiller call"
```

---

### Task 6: `retrieval.js` — tokenisation, IDF index and query

**Files:**
- Create: `retrieval.js`
- Create: `retrieval.test.js`

**Interfaces:**
- Consumes: `normalizeText` from `memory.js` (Task 3).
- Produces: `MIN_CONTENT_TERMS`, `SCORE_FLOOR`, `EVIDENCE_TURNS`, `QUERY_MAX_CHARS`, `tokenize(text) → string[]`, `buildIndex(turns) → { idf, N, floor }`, `queryFrom(turns) → string`, `scoreTurns(corpus, query, index) → { terms, scored }`.

`floor` is the IDF assigned to a query term that appears in no turn at all. Without it those terms weigh zero and a question made entirely of unseen words scores as a perfect match against anything.

- [ ] **Step 1: Write the failing test**

```js
// retrieval.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, buildIndex, queryFrom, scoreTurns } from './retrieval.js';

const turn = (speaker, text, t) => ({ speaker, text, t, dur: 1 });

test('tokenize drops stopwords in both languages and very short words', () => {
  assert.deepEqual(tokenize('And what about the deployment of the gateway?'), ['deployment', 'gateway']);
  assert.deepEqual(tokenize('¿Y qué pasa con el despliegue del gateway?'), ['pasa', 'despliegue', 'gateway']);
});

test('buildIndex gives a rare term more weight than a common one', () => {
  const turns = [
    turn('them', 'the deployment was fine', 1),
    turn('me', 'the deployment is fine', 2),
    turn('them', 'kubernetes was the problem', 3),
  ];
  const { idf } = buildIndex(turns);
  assert.ok(idf.get('kubernetes') > idf.get('deployment'));
});

test('queryFrom joins the trailing run of OTHER turns, not just the last one', () => {
  const turns = [
    turn('me', 'my answer', 1),
    turn('them', 'So going back', 2),
    turn('them', 'to the retry policy you mentioned', 3),
  ];
  assert.equal(queryFrom(turns), 'So going back to the retry policy you mentioned');
});

test('queryFrom returns empty when the learner spoke last', () => {
  assert.equal(queryFrom([turn('them', 'hi', 1), turn('me', 'hello', 2)]), '');
});

test('scoreTurns ranks the turn that shares the rare terms', () => {
  const corpus = [
    turn('me', 'I like coffee in the morning', 1),
    turn('me', 'We set the retry policy to three attempts', 2),
  ];
  const index = buildIndex(corpus);
  const { scored } = scoreTurns(corpus, 'what was the retry policy', index);
  assert.equal(scored[0].turn.t, 2);
  assert.ok(scored[0].score > scored[1].score);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test retrieval.test.js`
Expected: FAIL — `Cannot find module './retrieval.js'`

- [ ] **Step 3: Write the minimal implementation**

```js
// retrieval.js
// Literal retrieval over the transcript. Free, deterministic, and incapable of
// inventing anything: what it returns is what was actually said. Pure — it runs
// unmodified in Node.

import { normalizeText } from './memory.js';

export const MIN_CONTENT_TERMS = 2;
export const SCORE_FLOOR = 0.35;
export const EVIDENCE_TURNS = 3;
export const QUERY_MAX_CHARS = 400;

const STOP = new Set((
  'and are but for from have has had her his its not the that this was were will with you your '
  + 'about into over than then they them their there what when where which who why how would could '
  + 'can did does done just like some more most only very much any our out '
  + 'con como para pero por que del las los una unos unas est esta este esto eso ese esa '
  + 'son fue eran ser sido tiene tienen hacer hace muy mas cuando donde porque quien cual '
  + 'nos sus mi tu su ya lo le les se sobre entre desde hasta'
).split(/\s+/));

export function tokenize(text) {
  return normalizeText(text).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}

// IDF over the conversation's own turns: names and jargon outweigh filler, which
// is exactly the signal that tells "they are asking about X" from "they are
// asking something".
export function buildIndex(turns) {
  const df = new Map();
  for (const t of turns) for (const w of new Set(tokenize(t.text))) df.set(w, (df.get(w) || 0) + 1);
  const N = turns.length || 1;
  const idf = new Map();
  for (const [w, n] of df) idf.set(w, Math.log(1 + N / (1 + n)));
  return { idf, N, floor: Math.log(1 + N) };
}

// Soft cuts split one question into several segments, so the query is the whole
// trailing run of the other speaker, not the last entry.
export function queryFrom(turns) {
  const sorted = [...turns].sort((a, b) => a.t - b.t);
  const run = [];
  for (let i = sorted.length - 1; i >= 0 && sorted[i].speaker === 'them'; i--) run.unshift(sorted[i]);
  const text = run.map((t) => t.text).join(' ');
  return text.length > QUERY_MAX_CHARS ? text.slice(-QUERY_MAX_CHARS) : text;
}

// Normalised to [0,1]: the share of the question's own IDF mass a turn accounts
// for. Comparable across questions, so one threshold works for all of them.
export function scoreTurns(corpus, query, index) {
  const terms = [...new Set(tokenize(query))];
  const weight = (w) => index.idf.get(w) ?? index.floor;
  const mass = terms.reduce((n, w) => n + weight(w), 0);
  const scored = corpus.map((turn) => {
    const words = new Set(tokenize(turn.text));
    const hit = terms.filter((w) => words.has(w)).reduce((n, w) => n + weight(w), 0);
    return { turn, score: mass ? hit / mass : 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  return { terms, scored };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test retrieval.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add retrieval.js retrieval.test.js
git commit -m "feat(retrieval): IDF index and query extraction over the transcript"
```

---

### Task 7: Three-way routing

**Files:**
- Modify: `retrieval.js`
- Modify: `retrieval.test.js`

**Interfaces:**
- Consumes: `tokenize`, `buildIndex`, `queryFrom`, `scoreTurns`, `MIN_CONTENT_TERMS`, `SCORE_FLOOR` from Task 6.
- Produces: `route(terms, bestScore) → 'continuation' | 'anchored' | 'new'`.

A question with almost no content words is the *most* anchored one there is — a naive similarity threshold would call it a new topic, which is the worst possible answer. It is detected by absence of content terms, not by score.

- [ ] **Step 1: Write the failing test**

```js
// append to retrieval.test.js
import { route } from './retrieval.js';

test('a pronominal follow-up is a continuation, never a new topic', () => {
  assert.equal(route(tokenize('And how would you do that?'), 0), 'continuation');
  assert.equal(route(tokenize('¿Y eso por qué?'), 0), 'continuation');
});

test('content terms that match earlier turns are anchored', () => {
  assert.equal(route(['retry', 'policy'], 0.8), 'anchored');
});

test('content terms with no match are a new topic', () => {
  assert.equal(route(['promise', 'javascript'], 0.1), 'new');
});

test('the boundary case falls to new — the costs are asymmetric', () => {
  assert.equal(route(['retry', 'policy'], 0.34), 'new');
  assert.equal(route(['retry', 'policy'], 0.35), 'anchored');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test retrieval.test.js`
Expected: FAIL — `route is not a function`

- [ ] **Step 3: Write the minimal implementation**

```js
// append to retrieval.js
// Three cases, not two. Demoting an anchored question to "new" costs a slightly
// generic answer; promoting a new one to "anchored" makes the learner claim out
// loud that something was discussed when it was not. On doubt, "new".
export function route(terms, bestScore) {
  if (terms.length < MIN_CONTENT_TERMS) return 'continuation';
  if (bestScore < SCORE_FLOOR) return 'new';
  return 'anchored';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test retrieval.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add retrieval.js retrieval.test.js
git commit -m "feat(retrieval): three-way routing between continuation, anchored and new"
```

---

### Task 8: Reply-context assembly

**Files:**
- Modify: `retrieval.js`
- Modify: `retrieval.test.js`

**Interfaces:**
- Consumes: everything from Tasks 6–7, plus `linesOf` from `memory.js`.
- Produces: `buildReplyContext({ turns, memory, tailChars, room }) → { mode, situation: [{ text }], evidence: [turn], tail: string }`.

`room` is `{ evidence: boolean, situation: boolean }`. When the minute is full the reply is never cancelled — the optional blocks shrink instead, evidence first.

- [ ] **Step 1: Write the failing test**

```js
// append to retrieval.test.js
import { buildReplyContext } from './retrieval.js';

const long = (word, n) => `${word} `.repeat(n).trim();

test('the tail and the memory leave no gap between them', () => {
  const turns = [
    turn('me', long('alpha', 100), 1000),
    turn('them', long('beta', 100), 2000),
    turn('them', 'and what about the kubernetes migration', 3000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 2700, room: {} });
  assert.ok(ctx.tail.includes('kubernetes migration'));
});

test('an anchored question gets verbatim evidence and nothing invented', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    ...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'me' : 'them', long('filler', 40), 2000 + i * 100)),
    turn('them', 'remind me about the kubernetes migration', 9000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 800, room: {} });
  assert.equal(ctx.mode, 'anchored');
  assert.ok(ctx.evidence.some((t) => t.text.includes('second quarter')));
});

test('a new question gets no evidence at all', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    turn('them', 'what is a promise in javascript', 2000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 200, room: {} });
  assert.equal(ctx.mode, 'new');
  assert.deepEqual(ctx.evidence, []);
});

test('a squeezed budget drops evidence before topics, and never the tail', () => {
  const turns = [
    turn('me', 'We set the kubernetes migration for the second quarter', 1000),
    ...Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'me' : 'them', long('filler', 40), 2000 + i * 100)),
    turn('them', 'remind me about the kubernetes migration', 9000),
  ];
  const memory = { topics: [{ text: 'Migration planned for Q2', quote: 'q', t: 1000 }] };
  const ctx = buildReplyContext({ turns, memory, tailChars: 800, room: { evidence: false } });
  assert.deepEqual(ctx.evidence, []);
  assert.equal(ctx.situation.length, 1);
  assert.ok(ctx.tail.length > 0);
});

test('evidence never repeats what the tail already carries', () => {
  const turns = [
    turn('them', 'tell me about the kubernetes migration', 1000),
    turn('me', 'the kubernetes migration is in Q2', 2000),
    turn('them', 'and the kubernetes migration budget', 3000),
  ];
  const ctx = buildReplyContext({ turns, memory: {}, tailChars: 5000, room: {} });
  assert.deepEqual(ctx.evidence, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test retrieval.test.js`
Expected: FAIL — `buildReplyContext is not a function`

- [ ] **Step 3: Write the minimal implementation**

Extend the existing import at the top of `retrieval.js` — do not add a second import statement:

```js
import { normalizeText, linesOf } from './memory.js';
```

Then append:

```js
// append to retrieval.js
const SITUATION_MAX = 6;

// The turns the raw tail already carries, so evidence never pays twice for them.
function splitTail(sorted, tailChars) {
  const kept = [];
  let total = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    total += sorted[i].text.length + 1;
    if (total > tailChars && kept.length) break;
    kept.unshift(sorted[i]);
  }
  const from = kept.length ? kept[0].t : Infinity;
  return { tailTurns: kept, older: sorted.filter((t) => t.t < from) };
}

export function buildReplyContext({ turns, memory = {}, tailChars, room = {} }) {
  const sorted = [...turns].sort((a, b) => a.t - b.t);
  const { tailTurns, older } = splitTail(sorted, tailChars);
  const index = buildIndex(sorted);
  const query = queryFrom(sorted);
  const { terms, scored } = scoreTurns(older, query, index);
  const mode = route(terms, scored[0]?.score ?? 0);

  const evidence = mode === 'anchored' && room.evidence !== false
    ? scored.filter((s) => s.score >= SCORE_FLOOR).slice(0, EVIDENCE_TURNS).map((s) => s.turn)
    : [];

  const topics = Array.isArray(memory.topics) ? memory.topics : [];
  let situation = [];
  if (room.situation !== false && topics.length) {
    const ranked = scoreTurns(topics.map((x) => ({ ...x, text: x.text })), query, index).scored;
    const relevant = ranked.filter((s) => s.score >= SCORE_FLOOR).slice(0, 3).map((s) => s.turn);
    const recent = topics.slice(-3);
    const seen = new Set();
    situation = [...relevant, ...recent]
      .filter((x) => !seen.has(x.text) && seen.add(x.text))
      .slice(0, SITUATION_MAX);
  }

  return { mode, situation, evidence, tail: linesOf(tailTurns) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test retrieval.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add retrieval.js retrieval.test.js
git commit -m "feat(retrieval): reply context with mode-aware evidence and budget trimming"
```

---

### Task 9: `askReply` consumes the prepared context

**Files:**
- Modify: `coach.js` (`REPLY_SYSTEM` at line 331, `askReply` at line 366)
- Modify: `coach.test.js`

**Interfaces:**
- Consumes: `buildReplyContext` output shape from Task 8.
- Produces: `contextBlocks(context) → string`; `askReply({ turns, settings, context })` — `context` optional, and its absence reproduces today's behaviour.

An **absent** block is ambiguous to a model and invites filling. A **declared** absence is not. That is why the `new` mode prints a sentence instead of omitting a section.

- [ ] **Step 1: Write the failing test**

```js
// append to coach.test.js
import { contextBlocks } from './coach.js';

test('an anchored context prints the literal record', () => {
  const out = contextBlocks({
    mode: 'anchored',
    situation: [{ text: 'Migration planned for Q2' }],
    evidence: [{ speaker: 'me', text: 'the migration is in Q2' }],
    tail: 'OTHER: and the budget?',
  });
  assert.match(out, /SITUATION/);
  assert.match(out, /LITERAL RECORD/);
  assert.match(out, /the migration is in Q2/);
  assert.match(out, /OTHER: and the budget\?/);
});

test('a new question states the absence instead of omitting the block', () => {
  const out = contextBlocks({ mode: 'new', situation: [], evidence: [], tail: 'OTHER: what is a promise?' });
  assert.match(out, /NOTHING earlier in this conversation covers this question/);
  assert.ok(!out.includes('LITERAL RECORD'));
});

test('a continuation neither claims nor denies earlier coverage', () => {
  const out = contextBlocks({ mode: 'continuation', situation: [], evidence: [], tail: 'OTHER: and why?' });
  assert.ok(!out.includes('LITERAL RECORD'));
  assert.ok(!out.includes('NOTHING earlier'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test coach.test.js`
Expected: FAIL — `contextBlocks is not exported`

- [ ] **Step 3: Write the minimal implementation**

Append this rule to `REPLY_SYSTEM`, after the existing background paragraph:

```
Facts about THIS conversation may come only from the LITERAL RECORD block. The SITUATION block
orients you and is not quotable as fact. Never say or imply that something was discussed unless
it appears in the LITERAL RECORD.
```

Then:

```js
// Three sources with three different truth rules. The reply already separated two
// of them — biography is not invented, technical knowledge is fair game — and this
// adds the third: what the conversation actually contains.
export function contextBlocks(context) {
  if (!context) return '';
  const parts = [];
  if (context.situation?.length) {
    parts.push('SITUATION (background — orients you, NOT quotable as fact)\n'
      + context.situation.map((s) => `  · ${s.text}`).join('\n'));
  }
  if (context.evidence?.length) {
    parts.push('LITERAL RECORD (exact words spoken earlier — you may rely on these)\n'
      + context.evidence.map((t) => `  · ${t.speaker === 'me' ? 'LEARNER' : 'OTHER'}: "${t.text}"`).join('\n'));
  } else if (context.mode === 'new') {
    // An absent block invites the model to fill the gap; a declared absence does not.
    parts.push('NOTHING earlier in this conversation covers this question. Do not imply it was discussed.');
  }
  if (context.tail) parts.push(`RECENT (the immediate thread)\n${context.tail}`);
  return parts.join('\n\n');
}
```

And in `askReply`, replace the `Conversation so far` line:

```js
export async function askReply({ turns, settings, context = null }) {
  const conversation = context
    ? contextBlocks(context)
    // No prepared context (no memory yet, or a caller that predates it): the old
    // character-capped tail, which is still correct, just short-sighted.
    : `RECENT (the immediate thread)\n${turnsToText(turns, 10, 1200)}`;
  const raw = await ask({
    provider: settings.reportProvider,
    model: settings.reportModel,
    keys: settings,
    system: REPLY_SYSTEM + langMode(settings),
    user: `Learner level: ${settings.level}. Context: ${settings.situation}.`
      + `${profileBlock(settings)}${contextBlock(settings)}`
      + `\n\n${conversation}`
      + `\n\nAnswer the other person's last turn for the learner: one speakable answer, then two study ideas.`,
    maxTokens: 1200,
    schema: REPLY_SCHEMA,
  });
  return parseReply(raw);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test *.test.js && node .claude/skills/preflight/scripts/preflight.mjs`
Expected: PASS, preflight clean.

- [ ] **Step 5: Commit**

```bash
git add coach.js coach.test.js
git commit -m "feat(coach): reply grounded in a labelled record, with a stated absence"
```

---

### Task 10: `offscreen.js` — schedule, gate and persist the distillation

**Files:**
- Modify: `offscreen.js` (imports line 4–8; `state` line 20; `suggestReply` line 137; `appendTranscript` line 75; `start` line 419; `stop` line 495)

**Interfaces:**
- Consumes: `sizing`, `emptyMemory`, `reconcile`, `selectChunk`, `acceptItems`, `acceptErrors`, `mergeTopics`, `Ledger`, `CAPS`, `DISTILL_COOLDOWN_MS` from `memory.js`; `buildReplyContext` from `retrieval.js`; `askDistill`, `tpmOf` from `coach.js`.
- Produces: nothing consumed by later tasks except `state.memory`.

There is no test here on purpose: this file is orchestration over `chrome.*`, and everything worth asserting already lives in the pure modules.

- [ ] **Step 1: Extend the imports and the state**

```js
import { askHints, askStarter, askReply, askReport, askDistill, tpmOf, groqBaseOf, redact, resolveProvider, PROVIDERS, DEFAULT_COACH } from './coach.js';
import { sizing, emptyMemory, reconcile, selectChunk, acceptItems, acceptErrors, mergeTopics, Ledger, CAPS, DISTILL_COOLDOWN_MS } from './memory.js';
import { buildReplyContext } from './retrieval.js';
```

```js
const state = {
  // …existing fields…
  memory: null,
  ledger: new Ledger(() => Date.now()),
  distillBusy: false,
  lastDistillAt: 0,
};
```

- [ ] **Step 2: Add memory persistence and the distiller**

```js
async function loadMemory() {
  const { memory } = (await store.get('memory')) || {};
  state.memory = reconcile(memory || emptyMemory(state.memory?.sessionId || null), state.turns);
  return state.memory;
}

const saveMemory = () => store.set({ memory: state.memory });

// Background work, so it yields to everything the learner can see: an in-flight
// reply on every provider, a busy transcription queue, and — only where a
// per-minute budget exists — a hints round.
function distillEligible(settings) {
  if (state.distillBusy || state.replyBusy) return false;
  if (!queueIdle()) return false;
  if (tpmOf(settings) && state.hintBusy) return false;
  if (Date.now() - state.lastDistillAt < DISTILL_COOLDOWN_MS) return false;
  return state.ledger.room(tpmOf(settings), 'distill');
}

async function distill({ force = false } = {}) {
  const settings = await ensureSettings();
  const memory = await loadMemory();
  const { chunkChars } = sizing(tpmOf(settings));
  const chunk = selectChunk(state.turns, memory, chunkChars, { all: force });
  if (!chunk) return false;
  if (!force && !distillEligible(settings)) {
    memory.skipped++;
    await saveMemory();
    return false;
  }

  state.distillBusy = true;
  try {
    state.ledger.spend('distill');
    const raw = await askDistill({ chunk: { ...chunk, carry: memory.carry }, settings });

    const anchor = [...chunk.overlapTurns, ...chunk.turns];
    const topics = acceptItems(raw.topics, anchor);
    const open = acceptItems(raw.open, anchor);
    const errors = acceptErrors(raw.errors, chunk.turns);
    memory.rejected += (raw.topics.length - topics.length)
      + (raw.open.length - open.length)
      + (raw.errors.length - errors.length);

    memory.topics = mergeTopics(memory.topics, topics, CAPS.topics);
    memory.open = mergeTopics(memory.open, open, CAPS.open);
    memory.errors = [...memory.errors, ...errors].slice(-CAPS.errors);
    memory.carry = raw.carry;
    memory.coveredUntil = chunk.endsAt;
    memory.rounds++;
    state.lastDistillAt = Date.now();
    await saveMemory();
    return true;
  } catch {
    // Silent by design: a missing key or a 429 is already surfaced by the hints
    // round, and the reply keeps working on the tail plus literal retrieval.
    memory.skipped++;
    await saveMemory();
    return false;
  } finally {
    state.distillBusy = false;
  }
}
```

- [ ] **Step 3: Trigger it from the transcript and record every coach call**

In `appendTranscript`, after `if (entry.speaker === 'them') { … }`:

```js
  distill().catch(() => {});
```

Add `state.ledger.spend('hints')` inside `scheduleHints` before `askHints`, `state.ledger.spend('starter')` in `sendStarter`, `state.ledger.spend('reply')` in `suggestReply`, and `state.ledger.spend('report')` in `makeReport`.

- [ ] **Step 4: Feed the reply and flush at stop**

In `suggestReply`, replace the `askReply` call:

```js
    const settings = await ensureSettings();
    const memory = await loadMemory();
    const { tailChars } = sizing(tpmOf(settings));
    const room = state.ledger.room(tpmOf(settings), 'reply')
      ? {}
      : { evidence: false, situation: false };
    const context = buildReplyContext({ turns: sortedTurns(), memory, tailChars, room });
    const { answer, ideas } = await askReply({ turns: sortedTurns(), settings, context });
```

In `start`, after loading the transcript:

```js
  const stored = (await store.get('memory'))?.memory;
  state.memory = reconcile(stored || emptyMemory(String(Date.now())), state.turns);
  if (!stored) await saveMemory();
```

In `stop`, inside the `autoReport` branch and the plain branch alike, after `waitForQueue()`:

```js
    await distill({ force: true }).catch(() => {});
```

- [ ] **Step 5: Verify and commit**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`
Expected: preflight clean, tests pass.

```bash
git add offscreen.js
git commit -m "feat(offscreen): schedule distillation and ground the reply in session memory"
```

---

### Task 11: Clearing the transcript clears the memory

**Files:**
- Modify: `sidepanel.js:377-385`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

A memory that outlives its transcript would narrate a conversation that no longer exists. `reconcile` catches it on read, but the clear button is where it should actually happen.

- [ ] **Step 1: Make the change**

```js
els.clear.addEventListener('click', async () => {
  entries = [];
  // The memory is a distillation of this transcript: keeping it would leave the
  // coach narrating a conversation the learner just deleted.
  await chrome.storage.local.set({ transcript: [], memory: null });
  render();
  els.chips.innerHTML = '';
  els.nudge.textContent = '';
  els.replyBox.hidden = true;
  setStatus('Transcripción borrada.');
});
```

- [ ] **Step 2: Verify**

Run: `node .claude/skills/preflight/scripts/preflight.mjs`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add sidepanel.js
git commit -m "fix(sidepanel): clearing the transcript also clears the session memory"
```

---

### Task 12: The report reads the memory instead of a truncated tail

**Files:**
- Modify: `coach.js` (`REPORT_MAX_CHARS` line 199, `REPORT_SYSTEM` line 440, `REPORT_SYSTEM_ES` line 480, `askReport` line 469)
- Modify: `offscreen.js` (`makeReport` line 156)
- Modify: `coach.test.js`

**Interfaces:**
- Consumes: the `memory` shape from Task 1.
- Produces: `memoryBlock(memory) → string`, `coverageOf(memory) → number`; `askReport({ turns, settings, memory })` — `memory` optional.

Today the report trims to 12000 characters and only whispers `(sólo la parte final)` inside the prompt, so an hour-long call is graded on its last third without the learner knowing. Distilled topics are a compressed form of exactly the region that used to be cut, so coverage goes up while the tail comes down to 8000.

- [ ] **Step 1: Write the failing test**

```js
// append to coach.test.js
import { memoryBlock, coverageOf } from './coach.js';

test('coverageOf reports the share of rounds that actually ran', () => {
  assert.equal(coverageOf({ rounds: 8, skipped: 2 }), 80);
  assert.equal(coverageOf({ rounds: 0, skipped: 0 }), 100);
});

test('memoryBlock lists the recorded topics, commitments and mistakes', () => {
  const out = memoryBlock({
    rounds: 2, skipped: 0,
    topics: [{ text: 'Migration planned for Q2', quote: 'q', t: 1 }],
    open: [{ text: 'Send the estimate on Friday', quote: 'q', t: 2 }],
    errors: [{ wrong: 'depends of', right: 'depends on', kind: 'grammar', said: 'it depends of the load', t: 3 }],
  });
  assert.match(out, /Migration planned for Q2/);
  assert.match(out, /Send the estimate on Friday/);
  assert.match(out, /depends of → depends on/);
});

test('memoryBlock is empty when nothing was distilled', () => {
  assert.equal(memoryBlock({ rounds: 0, skipped: 0, topics: [], open: [], errors: [] }), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test coach.test.js`
Expected: FAIL — `memoryBlock is not exported`

- [ ] **Step 3: Write the minimal implementation**

Change `const REPORT_MAX_CHARS = 12000;` to `8000` with the reason in a comment, then:

```js
export const coverageOf = (m = {}) => {
  const total = (m.rounds || 0) + (m.skipped || 0);
  return total ? Math.round(((m.rounds || 0) / total) * 100) : 100;
};

// The distilled record of the whole conversation, so the summary stops being
// built from whatever fitted in the tail.
export function memoryBlock(memory) {
  if (!memory) return '';
  const { topics = [], open = [], errors = [] } = memory;
  if (!topics.length && !open.length && !errors.length) return '';
  const parts = [];
  if (topics.length) parts.push('TEMAS REGISTRADOS (cubren toda la conversación):\n'
    + topics.map((t) => `  · ${t.text}`).join('\n'));
  if (open.length) parts.push('PENDIENTES REGISTRADOS:\n' + open.map((t) => `  · ${t.text}`).join('\n'));
  if (errors.length) parts.push('ERRORES DETECTADOS (ya verificados contra la transcripción):\n'
    + errors.map((e) => `  · ${e.wrong} → ${e.right} [${e.kind}] — dijo: "${e.said}"`).join('\n'));
  const cobertura = coverageOf(memory);
  if (cobertura < 100) parts.push(`COBERTURA: la memoria cubre aproximadamente el ${cobertura}% de la conversación.`);
  return parts.join('\n\n');
}
```

Add these paragraphs to both report system prompts, after the ASR-noise note:

```
El «Resumen de la reunión» se construye A PARTIR DE LOS TEMAS REGISTRADOS que se te entregan: no
añadas ningún tema que no esté en esa lista. Los «Pendientes» salen únicamente de los PENDIENTES
REGISTRADOS. La tabla de errores parte de los ERRORES DETECTADOS: explícalos y ordénalos por
importancia; puedes añadir como máximo dos más que encuentres en la transcripción.
Si se te indica una COBERTURA por debajo del 100%, dilo en una línea al final del resumen.
```

Add a new section to both prompts, before `## Nivel y plan` / `## Plan`:

```
## Lo que tienes que aprender
Las 5 frases o palabras que más te conviene memorizar a partir de tus propios errores de hoy.
Cada una con el inglés en negrita, una glosa corta en español y la frase real donde falló.
```

Then in `askReport`:

```js
export async function askReport({ turns, settings, memory = null }) {
  const mine = turns.filter((t) => t.speaker === 'me').length;
  if (mine === 0) throw new CoachError('No hay intervenciones tuyas para analizar.');
  const texto = turnsToText(turns, 400, REPORT_MAX_CHARS);
  const recortada = texto.split('\n').length < turns.length;
  const recuerdo = memoryBlock(memory);
  return ask({
    provider: settings.reportProvider,
    model: settings.reportModel,
    keys: settings,
    system: settings.lang === 'es' ? REPORT_SYSTEM_ES : REPORT_SYSTEM,
    user: `Nivel declarado: ${settings.level}. Contexto: ${settings.situation}.`
      + `${profileBlock(settings)}${contextBlock(settings)}\n\n`
      + (recuerdo ? `${recuerdo}\n\n` : '')
      + `Transcripción${recortada ? ' (sólo la parte final de la conversación)' : ' completa'}:\n${texto}`,
    maxTokens: 2800,
  });
}
```

In `offscreen.js` `makeReport`, pass the memory:

```js
    const markdown = await askReport({ turns: sortedTurns(), settings, memory: await loadMemory() });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test *.test.js && node .claude/skills/preflight/scripts/preflight.mjs`
Expected: PASS, preflight clean.

- [ ] **Step 5: Commit**

```bash
git add coach.js coach.test.js offscreen.js
git commit -m "feat(report): summarise from the distilled record instead of a silent tail"
```

---

### Task 13: Document phase A

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Update the "Pure logic stays pure" paragraph**

Replace the module list with:

```
`segmenter.js`, `capture.js`, `coach.js`, `memory.js`, `retrieval.js` and `report.js` import no
`chrome.*` and take their side effects as injected parameters (`Segmenter(…, now)`,
`openCaptureStream(…, gum)`, `new Ledger(now)`).
```

- [ ] **Step 2: Add invariant 10**

```
10. **A turn can still grow after it is stored.** `foldIntoTranscript` extends the entry with the
    highest `t` when the same speaker continues within `MERGE_GAP_MS`. Anything that consumes
    turns as final — the distiller above all — must exclude that entry, which is why
    `selectChunk` never includes it. Distilling it loses the appended text silently: no error,
    no warning, just a hole in the memory.
```

- [ ] **Step 3: Fix the stale debt entry**

Replace `- No unit tests exist yet, despite four modules being written to be testable.` with:

```
- `coach.js` is past 500 lines and now holds four prompt families; the distiller and the report
  are candidates for their own module if it grows again.
```

- [ ] **Step 4: Verify and commit**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`

```bash
git add CLAUDE.md
git commit -m "docs: record the fold invariant and the new pure modules"
```

---

# Phase B — the accumulated lake

Do not start phase B until phase A has been exercised in a real call. Phase A **will** record some mistake the learner never made — ASR noise is stopped by recurrence and the human veto, both of which live here. Building B on an undermeasured A only accumulates noise faster.

### Task 14: Lake merge, recurrence and veto

**Files:**
- Modify: `memory.js`
- Modify: `memory.test.js`

**Interfaces:**
- Consumes: `normalizeText`, `CAPS`, `RECURRENCE_MIN` from Tasks 1 and 3.
- Produces: `emptyLake() → lake`, `lakeKey(wrong, right) → string`, `mergeLake(lake, errors, sessionId, now) → lake`, `vetoKey(lake, key) → lake`, `confirmedEntries(lake) → entries[]`.

Recurrence is the noise filter, and it is model-agnostic: a hallucination is random and will not repeat the same minimal pair next week; a real mistake is systematic and reaches the threshold fast. A better model does not change this code — it only confirms faster.

- [ ] **Step 1: Write the failing test**

```js
// append to memory.test.js
import { emptyLake, lakeKey, mergeLake, vetoKey, confirmedEntries } from './memory.js';

const err = (wrong, right) => ({ wrong, right, kind: 'grammar', said: `I ${wrong} it`, t: 1 });

test('the lake key is the minimal pair, not the sentence', () => {
  assert.equal(lakeKey('Depends  OF!', 'depends on'), 'depends of→depends on');
});

test('four repetitions inside one session count as one occurrence', () => {
  const lake = mergeLake(emptyLake(), [err('depends of', 'depends on'), err('depends of', 'depends on')], 's1', 1000);
  assert.equal(lake.entries.length, 1);
  assert.equal(lake.entries[0].count, 1);
});

test('a second session promotes the entry to confirmed', () => {
  let lake = mergeLake(emptyLake(), [err('depends of', 'depends on')], 's1', 1000);
  assert.deepEqual(confirmedEntries(lake), []);
  lake = mergeLake(lake, [err('depends of', 'depends on')], 's2', 2000);
  assert.equal(lake.entries[0].count, 2);
  assert.equal(confirmedEntries(lake).length, 1);
});

test('merging the same session twice does not double-count', () => {
  let lake = mergeLake(emptyLake(), [err('depends of', 'depends on')], 's1', 1000);
  lake = mergeLake(lake, [err('depends of', 'depends on')], 's1', 1500);
  assert.equal(lake.entries[0].count, 1);
});

test('a vetoed pair never comes back, however often it is extracted', () => {
  let lake = mergeLake(emptyLake(), [err('request quid', 'request queued')], 's1', 1000);
  lake = vetoKey(lake, lake.entries[0].key);
  assert.equal(lake.entries.length, 0);
  lake = mergeLake(lake, [err('request quid', 'request queued')], 's2', 2000);
  assert.equal(lake.entries.length, 0);
});

test('the lake keeps at most three evidence sentences per entry', () => {
  let lake = emptyLake();
  for (let i = 0; i < 5; i++) {
    lake = mergeLake(lake, [{ ...err('depends of', 'depends on'), said: `sentence ${i}` }], `s${i}`, i * 1000);
  }
  assert.equal(lake.entries[0].samples.length, 3);
  assert.equal(lake.entries[0].count, 5);
});

test('the lake stays capped and a recurrent mistake outlives a flood of one-offs', () => {
  let lake = emptyLake();
  for (const s of ['s1', 's2', 's3']) lake = mergeLake(lake, [err('depends of', 'depends on')], s, 1000);
  for (let i = 0; i < 205; i++) lake = mergeLake(lake, [err(`wrong ${i}`, `right ${i}`)], `f${i}`, 2000 + i);
  assert.equal(lake.entries.length, 200);
  assert.ok(lake.entries.some((e) => e.key === lakeKey('depends of', 'depends on')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test memory.test.js`
Expected: FAIL — `emptyLake is not a function`

- [ ] **Step 3: Write the minimal implementation**

```js
// append to memory.js
export const emptyLake = () => ({ entries: [], vetoed: [] });

export const lakeKey = (wrong, right) => `${normalizeText(wrong)}→${normalizeText(right)}`;

// `count` is sessions, not repetitions: saying the same thing four times in one
// meeting is one occurrence. It is what makes recurrence a signal about the
// learner rather than about how talkative they were that afternoon.
export function mergeLake(lake, errors, sessionId, now) {
  const entries = lake.entries.map((e) => ({ ...e, samples: [...e.samples] }));
  const vetoed = new Set(lake.vetoed);
  const index = new Map(entries.map((e) => [e.key, e]));

  for (const e of errors) {
    const key = lakeKey(e.wrong, e.right);
    if (vetoed.has(key)) continue;
    let entry = index.get(key);
    if (!entry) {
      entry = { key, wrong: e.wrong, right: e.right, kind: e.kind, count: 0, lastSessionId: null, firstAt: now, lastAt: now, samples: [] };
      entries.push(entry);
      index.set(key, entry);
    }
    if (entry.lastSessionId !== sessionId) {
      entry.count++;
      entry.lastSessionId = sessionId;
    }
    entry.lastAt = now;
    if (e.said && !entry.samples.includes(e.said)) {
      entry.samples = [...entry.samples, e.said].slice(-CAPS.samples);
    }
  }

  entries.sort((a, b) => (a.count - b.count) || (a.lastAt - b.lastAt));
  return { entries: entries.slice(-CAPS.lakeEntries), vetoed: [...vetoed].slice(-CAPS.vetoed) };
}

// A plain delete would let the distiller re-extract the same ASR garbage next
// week, and the button would feel broken. The pair is banned, not removed.
export function vetoKey(lake, key) {
  return {
    entries: lake.entries.filter((e) => e.key !== key),
    vetoed: [...new Set([...lake.vetoed, key])].slice(-CAPS.vetoed),
  };
}

export const confirmedEntries = (lake) =>
  lake.entries.filter((e) => e.count >= RECURRENCE_MIN).sort((a, b) => b.count - a.count);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test memory.test.js`
Expected: PASS, 36 tests.

- [ ] **Step 5: Commit**

```bash
git add memory.js memory.test.js
git commit -m "feat(memory): accumulated error lake with recurrence counting and veto"
```

---

### Task 15: Merge the session into the lake

**Files:**
- Modify: `offscreen.js` (`start`, `stop`)

**Interfaces:**
- Consumes: `emptyLake`, `mergeLake` from Task 14.
- Produces: nothing.

- [ ] **Step 1: Add the merge helper**

```js
// The session's errors reach the history once the session is over, so a mistake
// repeated all afternoon still counts as one occurrence.
async function mergeIntoLake() {
  const memory = state.memory;
  if (!memory || memory.merged || !memory.errors.length) return;
  const { lake } = (await store.get('lake')) || {};
  const next = mergeLake(lake || emptyLake(), memory.errors, memory.sessionId, Date.now());
  await store.set({ lake: next });
  memory.merged = true;
  await saveMemory();
}
```

- [ ] **Step 2: Call it at stop, after the final flush**

In `stop`, immediately after `await distill({ force: true }).catch(() => {})`:

```js
    await mergeIntoLake().catch(() => {});
```

- [ ] **Step 3: Recover a session that ended without stopping**

In `start`, after the memory is loaded and before stamping a new session:

```js
  // Chrome can close without a STOP. The previous session's mistakes are still
  // in memory and still unmerged: send them to the history before moving on.
  if (state.memory?.errors?.length && !state.memory.merged) await mergeIntoLake().catch(() => {});
```

- [ ] **Step 4: Verify and commit**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`

```bash
git add offscreen.js
git commit -m "feat(offscreen): merge a finished session's mistakes into the lake"
```

---

### Task 16: The lake in the report, with a per-entry veto

**Files:**
- Modify: `report.html`
- Modify: `report.js`

**Interfaces:**
- Consumes: `confirmedEntries`, `vetoKey`, `emptyLake` from Task 14.
- Produces: nothing.

Every value is written with `textContent`; the escaping in this file is a security control, not formatting.

- [ ] **Step 1: Add the section to `report.html`**

Between `</details>` (the `raw` section, `report.html:41`) and the `<script>` tag:

```html
    <section id="lake" hidden>
      <h2>Errores que repites</h2>
      <p class="hint">Aparecen aquí después de detectarse en dos conversaciones distintas.</p>
      <ul id="lakeList"></ul>
    </section>
```

- [ ] **Step 2: Render it in `report.js`**

```js
import { confirmedEntries, vetoKey, emptyLake } from './memory.js';

async function renderLake() {
  const { lake } = await chrome.storage.local.get('lake');
  const entries = confirmedEntries(lake || emptyLake());
  const section = document.getElementById('lake');
  const list = document.getElementById('lakeList');
  section.hidden = entries.length === 0;
  list.textContent = '';

  for (const entry of entries) {
    const li = document.createElement('li');

    const pair = document.createElement('p');
    const wrong = document.createElement('s');
    wrong.textContent = entry.wrong;
    const right = document.createElement('strong');
    right.textContent = entry.right;
    pair.append(wrong, ' → ', right, ` · ${entry.count} conversaciones`);

    const sample = document.createElement('p');
    sample.className = 'hint';
    sample.textContent = entry.samples[entry.samples.length - 1] || '';

    // A plain delete would let the same ASR garbage come back next week.
    const veto = document.createElement('button');
    veto.textContent = 'Esto no era un error';
    veto.addEventListener('click', async () => {
      const { lake: current } = await chrome.storage.local.get('lake');
      await chrome.storage.local.set({ lake: vetoKey(current || emptyLake(), entry.key) });
      await renderLake();
    });

    li.append(pair, sample, veto);
    list.append(li);
  }
}
```

The history is worth showing before the first report exists, so `main`'s early return must not
swallow it. Split the current `main` in two — rename the existing body to `renderReport` and leave
its contents untouched:

```js
async function main() {
  await renderReport();
  await renderLake();
}

async function renderReport() {
  const { report } = await chrome.storage.local.get('report');
  const md = document.getElementById('md');
  if (!report) {
    md.innerHTML = '<p>Todavía no hay ningún informe. Graba una conversación y pulsa «Informe de la sesión».</p>';
    return;
  }
  // …the rest of the existing main() body, unchanged…
}
```

- [ ] **Step 3: Verify**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`
Expected: clean. Then load the extension in `chrome://extensions`, open `report.html`, and confirm the section stays hidden with an empty lake.

- [ ] **Step 4: Commit**

```bash
git add report.html report.js
git commit -m "feat(report): show recurring mistakes with a per-entry veto"
```

---

### Task 17: Clearing the lake from Options

**Files:**
- Modify: `setup.html`
- Modify: `setup.js`

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Add the control to `setup.html`**

There is no maintenance card yet. Add one as the last `<div class="card">`, immediately before
`<button id="save" class="primary">`:

```html
    <div class="card">
      <h2 style="margin-top:0">5. Histórico de errores</h2>
      <p class="hint">La extensión recuerda los errores de inglés que repites entre conversaciones para poder avisarte. Se guarda solo en este equipo.</p>
      <p>
        <button type="button" id="clearLake">Vaciar el histórico de errores</button>
        <span class="hint">Borra las frases guardadas de conversaciones anteriores. No se puede deshacer.</span>
      </p>
    </div>
```

- [ ] **Step 2: Wire it in `setup.js`**

```js
$('clearLake').addEventListener('click', async () => {
  await chrome.storage.local.remove('lake');
  $('clearLake').textContent = 'Histórico borrado ✓';
});
```

- [ ] **Step 3: Verify and commit**

Run: `node .claude/skills/preflight/scripts/preflight.mjs`

```bash
git add setup.html setup.js
git commit -m "feat(setup): let the learner empty the error history"
```

---

### Task 18: Recurring mistakes in the closing feedback

**Files:**
- Modify: `coach.js` (`memoryBlock`, `askReport`)
- Modify: `offscreen.js` (`makeReport`)
- Modify: `coach.test.js`

**Interfaces:**
- Consumes: `confirmedEntries` from Task 14, `memoryBlock` from Task 12.
- Produces: `askReport({ turns, settings, memory, recurring })` — `recurring` is `confirmedEntries(lake)`.

- [ ] **Step 1: Write the failing test**

```js
// append to coach.test.js
test('memoryBlock separates today from what the learner repeats', () => {
  const out = memoryBlock(
    { rounds: 1, skipped: 0, topics: [], open: [], errors: [] },
    [{ wrong: 'depends of', right: 'depends on', kind: 'grammar', count: 4, samples: ['it depends of the load'] }],
  );
  assert.match(out, /ERRORES RECURRENTES/);
  assert.match(out, /4 conversaciones/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test coach.test.js`
Expected: FAIL — the recurring block is not rendered.

- [ ] **Step 3: Write the minimal implementation**

Extend `memoryBlock`:

```js
export function memoryBlock(memory, recurring = []) {
  // …existing body, then, before the coverage line…
  if (recurring.length) parts.push('ERRORES RECURRENTES (detectados en varias conversaciones anteriores):\n'
    + recurring.map((e) => `  · ${e.wrong} → ${e.right} — ${e.count} conversaciones`).join('\n'));
```

Guard the early return so a session with no distillation but a non-empty history still renders:

```js
  if (!topics.length && !open.length && !errors.length && !recurring.length) return '';
```

Thread it through `askReport`:

```js
export async function askReport({ turns, settings, memory = null, recurring = [] }) {
  // …
  const recuerdo = memoryBlock(memory, recurring);
```

Add to both report prompts, inside `## Lo que tienes que aprender`:

```
Si se te entregan ERRORES RECURRENTES, empieza por ellos y dilo explícitamente: son los que el
alumno repite en varias conversaciones, no fallos de hoy.
```

In `offscreen.js` `makeReport`:

```js
    const { lake } = (await store.get('lake')) || {};
    const markdown = await askReport({
      turns: sortedTurns(),
      settings,
      memory: await loadMemory(),
      recurring: confirmedEntries(lake || emptyLake()),
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test *.test.js && node .claude/skills/preflight/scripts/preflight.mjs`
Expected: PASS, preflight clean.

- [ ] **Step 5: Commit**

```bash
git add coach.js coach.test.js offscreen.js
git commit -m "feat(report): open the learning section with what the learner repeats"
```

---

### Task 19: Document phase B

**Files:**
- Modify: `PRIVACY.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Add the lake to `PRIVACY.md`**

In the section describing what is stored locally:

```
**Histórico de errores.** La extensión guarda en `chrome.storage.local` los errores de inglés
detectados en tus conversaciones: la expresión incorrecta, su corrección y hasta tres frases
tuyas como evidencia. A diferencia de la transcripción, **este histórico sobrevive a las
sesiones**, porque su valor es detectar lo que repites. Nunca sale de tu equipo y nunca se envía
a ningún proveedor salvo como parte del informe que tú pides. Puedes borrar una entrada desde el
informe («Esto no era un error») o vaciarlo entero desde Ajustes.
```

- [ ] **Step 2: Add the storage keys to `CLAUDE.md`**

After the invariants:

```
`chrome.storage.local` holds `settings`, `transcript`, `report`, `lastError`, `setupDone`,
`memory` (the distilled session memory, cleared with the transcript) and `lake` (the accumulated
error history, which deliberately survives everything and is capped at 200 entries).
```

- [ ] **Step 3: Verify and commit**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`

```bash
git add PRIVACY.md CLAUDE.md
git commit -m "docs: record what the error lake stores and how to delete it"
```

---

## What static checks cannot tell you

Preflight and `node --test` verify syntax, the manifest, CSP, the message protocol and every pure
function. They verify none of this:

- whether `SCORE_FLOOR = 0.35` actually separates an anchored question from a new one in real speech
- whether 1800 characters is the right chunk on Groq's free minute
- whether the guards are so strict that good extractions are being dropped (watch `memory.rejected`)
- whether the distiller's ASR-noise instruction survives contact with `gpt-oss-20b`

All four need a real call. Report which ones you actually exercised rather than implying the
static gate covered them.
