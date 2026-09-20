# Sentence Bubbles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a monologue, close a bubble at the end of a sentence and open a new one for what follows, so a finished idea stays put with its translation and only a short open bubble keeps changing.

**Architecture:** The pieces of a monologue (one per 8 s forced cut) already fold into one turn in `foldIntoTranscript()` (`segmenter.js`), and each fold re-broadcasts the whole turn as a `SEGMENT` that both views upsert by `(speaker, t)` and retranslate whole. The change is in the fold: after merging, the turn is cut at the last sentence end that leaves a tail, the head is the closed turn and the tail opens a new turn. `foldIntoTranscript()` returns every entry whose text changed, and `appendTranscript()` broadcasts one `SEGMENT` per entry — no new message type. The views keep the previous Spanish visible under a bubble until the new translation lands, and the coach counts its context window in consecutive same-speaker runs rather than bubbles, so the split does not shrink what the model sees.

**Tech Stack:** Chrome MV3 extension, no build step, no dependencies; Node 22+ (`node --test`) for the pure modules; `e2e/` harness (real Chrome over the DevTools pipe) for measurement.

**Spec:** this document, section "Spec" below — agreed in conversation on 2026-09-20; there is no separate spec file.

## Spec

What the learner reported: while the other person talks for half a minute, each new 8 s piece re-paints the whole growing bubble and its Spanish disappears until the whole block is retranslated; the block is long, the retranslation slow, and the learner loses their place. What they asked for: once a sentence has clearly ended, leave that idea complete, with its translation, in a bubble above, and start a new bubble.

Rules:

1. A bubble that **grows by folding** is cut at the **last sentence end that is followed by more text**. The head keeps the bubble's `(speaker, t)` and is closed; the tail opens a new bubble stamped with the piece that just arrived. A bubble that never folds (an ordinary turn with a pause after it) is left exactly as it is, sentence ends and all.
2. A sentence end is `.`, `!`, `?` or `…`, optionally followed by closing quotes or brackets, then whitespace, then a sentence opener: an uppercase letter (accented Spanish letters included) or `¿` / `¡`. `1.5 million` and `fine. go ahead` are not sentence ends; `Mr. Smith` is, and that costs one oddly split bubble, which is accepted.
3. A closed bubble is never folded into again: the next piece goes to the open bubble (the tail) or, if there is no open bubble, starts one as today.
4. `MERGE_GAP_MS` (7 s of silence starts a new turn) stays as it is. `MERGE_MAX_CHARS` (400) bounds only a bubble that has no finished sentence: when the merged text has a sentence end that leaves a tail, the cut happens whatever the length, because the closed head is translated once and what follows leaves it anyway. Measured on the 34 s fixture before this ruling: a fast speaker's 8 s pieces are 150–200 characters, so the cap refused every fold and the sentence cut never ran (5 bubbles, 0 of 4 closed at a sentence end).
5. The views repaint a bubble whose text changed, but the Spanish that was under it stays visible until the new translation replaces it; a bubble whose text did not change keeps its cached translation and is not retranslated.
6. The coach's "last N turns" window counts runs of consecutive turns by the same speaker in the same language as one turn, so splitting a monologue into sentence bubbles does not push earlier turns out of the prompt.
7. The harness reports, per run, how many bubbles a monologue produced, the longest bubble, the largest text a single repaint had to retranslate, and how many closed bubbles end at a sentence end.

Non-goals: translating only the new words of an open bubble (a piece cut by time, not by words, translates badly on its own — the open bubble is now short, so translating it whole is the better trade); any change to the report, the notes, or the message types.

## Global Constraints

- No build step, no package.json, no dependencies, no bundler; every file that ships is written by hand. Minimum Chrome 116.
- Never edit `vendor/` or `icons/`.
- Pure logic stays pure: `segmenter.js`, `coach.js` import no `chrome.*`; tests run with `node --test *.test.js`.
- The repository is English (identifiers, comments, docs, commit messages); UI strings and user-visible errors are Spanish and are never "fixed" into English.
- Never pass dynamic content to `innerHTML`; use `textContent` / `createElement`.
- Comments only for what the code cannot say (browser-imposed behaviour, a measured reason); never restate the code.
- Every message carries `target` and a SCREAMING_SNAKE `type`; no new type without a handler and an entry in `.claude/skills/message-contract/SKILL.md`.
- The gate before claiming anything works: `node .claude/skills/preflight/scripts/preflight.mjs` and `node --test *.test.js`; anything touching the transcript path is measured with `node e2e/run.mjs …` and the numbers are quoted, not summarised.
- The implementer never dispatches subagents.

---

### Task 1: Cut a folded turn at its last sentence end

**Files:**
- Modify: `segmenter.js` (`foldIntoTranscript`, lines 232–260; add `sentenceCut` above it)
- Modify: `offscreen.js:118-126` (`appendTranscript`)
- Test: `segmenter.test.js` (the `foldIntoTranscript` tests, lines 147–206, plus new ones)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sentenceCut(text: string): number` — the index where the tail after the last sentence end begins, or `-1` when there is no sentence end followed by text. `foldIntoTranscript(transcript, entry, gapMs?, maxChars?): Entry[]` — the entries whose text the UIs must (re)paint, in order: `[entry]` for a new turn, `[merged]` for a fold with no cut, `[closed, opened]` for a fold cut inside the new piece, `[opened]` when the previous bubble already ended at a sentence end (its text is unchanged and is not re-sent). Every returned entry is an object held in `transcript`.

- [ ] **Step 1: Write the failing tests**

In `segmenter.test.js`, add `sentenceCut` to the import from `./segmenter.js`, change the two existing assertions `assert.equal(shown, tr[0]);` (in "same-speaker entries within the merge gap fold into one turn" and "consecutive turns in the same language still fold") to `assert.deepEqual(shown, [tr[0]]);`, and append:

```js
test('sentenceCut finds the tail after the last sentence end', () => {
  assert.equal(sentenceCut('Fine. Go ahead'), 6);
  assert.equal(sentenceCut('Really? Yes. Go ahead'), 13);
  assert.equal(sentenceCut('He said "done." Then left'), 16);
  assert.equal(sentenceCut('Claro. ¿Y el viernes?'), 7);
  assert.equal(sentenceCut('Wait… Okay'), 6);
});

test('sentenceCut ignores decimals, lowercase continuations and a trailing full stop', () => {
  assert.equal(sentenceCut('it costs 1.5 million'), -1);
  assert.equal(sentenceCut('fine. go ahead'), -1);
  assert.equal(sentenceCut('That is the whole project.'), -1);
  assert.equal(sentenceCut(''), -1);
});

test('a fold with a sentence end inside the new piece closes the bubble there and opens a new one', () => {
  const tr = [{ speaker: 'them', text: 'and I love that you are treating me like a crash test dummy', t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'for your project. Go ahead and put that engine', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'and I love that you are treating me like a crash test dummy for your project.');
  assert.equal(tr[0].t, 1000);
  assert.equal(tr[0].dur, 8);
  assert.equal(tr[1].text, 'Go ahead and put that engine');
  assert.equal(tr[1].t, 9000);
  assert.equal(tr[1].dur, 8);
  assert.equal(tr[1].lang, 'en');
  assert.equal(tr[1].speaker, 'them');
  assert.deepEqual(shown, [tr[0], tr[1]]);
});

test('a bubble that already ended at a sentence end is left alone and the piece opens a new one', () => {
  const tr = [{ speaker: 'them', text: 'We can ship on Friday.', t: 1000, dur: 3, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'Let me check the calendar', t: 4500, dur: 2, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'We can ship on Friday.');
  assert.equal(tr[1].text, 'Let me check the calendar');
  assert.equal(tr[1].t, 4500);
  assert.deepEqual(shown, [tr[1]], 'unchanged text is not re-sent');
});

test('a sentence end inside the older text also cuts on the next fold', () => {
  // The first piece of a monologue arrives as a new turn and is not cut; the
  // cut happens when the next piece folds into it.
  const tr = [{ speaker: 'them', text: 'It makes me feel great. Go ahead and', t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'put that engine to work', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'It makes me feel great.');
  assert.equal(tr[1].text, 'Go ahead and put that engine to work');
  assert.equal(tr[1].t, 9000);
  assert.deepEqual(shown, [tr[0], tr[1]]);
});

test('a fold with no sentence end keeps growing one bubble', () => {
  const tr = [{ speaker: 'them', text: 'and then we moved the whole platform', t: 1000, dur: 8, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'over to the new framework while keeping', t: 9000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].text, 'and then we moved the whole platform over to the new framework while keeping');
  assert.deepEqual(shown, [tr[0]]);
});

test('the opened bubble folds the next piece, the closed one never does', () => {
  const tr = [{ speaker: 'them', text: 'First idea', t: 1000, dur: 8, lang: 'en' }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'ends here. Second idea', t: 9000, dur: 8, lang: 'en' });
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'keeps going', t: 17000, dur: 8, lang: 'en' });
  assert.equal(tr.length, 2);
  assert.equal(tr[0].text, 'First idea ends here.');
  assert.equal(tr[1].text, 'Second idea keeps going');
  assert.deepEqual(shown, [tr[1]]);
});

test('an entry pushed as a new turn is returned as the only painted entry', () => {
  const tr = [];
  const entry = { speaker: 'me', text: 'Hello. How are you', t: 0, dur: 2 };
  assert.deepEqual(foldIntoTranscript(tr, entry), [entry]);
  assert.equal(tr[0].text, 'Hello. How are you', 'a turn that never folds is not cut');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test segmenter.test.js`
Expected: FAIL — `sentenceCut` is not exported; the existing fold tests fail on `deepEqual(shown, [tr[0]])` because `shown` is still an object.

- [ ] **Step 3: Implement `sentenceCut` and the cut in `foldIntoTranscript`**

In `segmenter.js`, replace the block from the `// Consecutive entries of the same speaker…` comment through the end of `foldIntoTranscript` with:

```js
// Consecutive entries of the same speaker within MERGE_GAP_MS fold into the
// previous turn (until it reaches MERGE_MAX_CHARS). A folded turn is cut at its
// last finished sentence: the head stays as the turn it was, closed for good, and
// the tail opens a new turn that later pieces fold into. A bubble that keeps
// growing is retranslated whole every time a piece lands, so this bounds what a
// repaint costs and keeps a finished idea from moving under the reader.
export const MERGE_GAP_MS = 7000;
export const MERGE_MAX_CHARS = 400;

// A sentence end followed by more text: the terminal mark, any closing quote or
// bracket, whitespace, then a sentence opener. Whisper capitalises sentence starts,
// and requiring the opener is what keeps "1.5 million" and "fine. go ahead" whole.
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/g;

// Index where the tail after the last finished sentence begins, or -1 when the
// text has no sentence end that leaves a tail.
export function sentenceCut(text) {
  let cut = -1;
  for (const m of String(text || '').matchAll(SENTENCE_END)) cut = m.index + m[0].length;
  return cut;
}

// Compares against the chronologically latest entry, not the last appended one:
// the transcription queue lets 'them' overtake 'me', so append order can disagree
// with capture order. Returns the entries the UIs should paint, in order — only
// those whose text changed.
export function foldIntoTranscript(transcript, entry, gapMs = MERGE_GAP_MS, maxChars = MERGE_MAX_CHARS) {
  let last = null;
  for (const e of transcript) if (!last || e.t > last.t) last = e;
  const fits = last && last.speaker === entry.speaker
    && entry.t >= last.t
    // One bubble carries one language, because it carries one translation. An entry
    // with no lang predates the field and matches anything, so an old transcript
    // folds exactly as it used to.
    && (!last.lang || !entry.lang || last.lang === entry.lang)
    && entry.t - (last.t + last.dur * 1000) <= gapMs
    && last.text.length + entry.text.length < maxChars;
  if (!fits) {
    transcript.push(entry);
    return [entry];
  }
  const before = last.text;
  const merged = `${last.text} ${entry.text}`.trim();
  const cut = sentenceCut(merged);
  if (cut < 0) {
    last.text = merged;
    last.dur = Math.round((entry.t + entry.dur * 1000 - last.t) / 100) / 10;
    return [last];
  }
  const head = merged.slice(0, cut).trim();
  const opened = {
    speaker: entry.speaker,
    text: merged.slice(cut).trim(),
    t: entry.t,
    dur: entry.dur,
    lang: entry.lang ?? last.lang,
  };
  if (opened.lang === undefined) delete opened.lang;
  transcript.push(opened);
  if (head === before) return [opened];
  last.text = head;
  // The cut fell inside the piece that just arrived, so the closed turn ends
  // where that piece began; the boundary inside the piece is not known.
  last.dur = Math.round((entry.t - last.t) / 100) / 10;
  return [last, opened];
}
```

In `offscreen.js`, replace `appendTranscript`:

```js
async function appendTranscript(entry) {
  const { transcript = [] } = (await store.get('transcript')) || {};
  // The broadcast carries the folded turn: its `t` repeats when a turn was
  // extended, and the UIs upsert by (speaker, t) instead of appending. A fold
  // cut at a sentence end paints two: the closed bubble and the opened one.
  const shown = foldIntoTranscript(transcript, entry);
  state.turns = transcript;
  await store.set({ transcript });
  for (const e of shown) broadcast({ type: 'SEGMENT', entry: e });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test segmenter.test.js && node .claude/skills/preflight/scripts/preflight.mjs`
Expected: all pass; preflight `0 failing, 0 warnings`.

- [ ] **Step 5: Commit**

```bash
git add segmenter.js segmenter.test.js offscreen.js
git commit -m "feat(transcript): close a folded turn at its last finished sentence"
```

---

### Task 2: Keep the Spanish under a repainted bubble until the new translation lands

**Files:**
- Modify: `sidepanel.js` (`addEntry`, lines 191–223; `bubbleNode`, lines 126–160)
- Modify: `overlay.js` (`addTurn`, lines 630–660; `turnNode`, lines 582–612)

**Interfaces:**
- Consumes: `SEGMENT` upserts by `(speaker, t)` from Task 1 — a bubble may now be re-sent with a *shorter* text than before (closed at a sentence end) as well as a longer one.
- Produces: nothing other modules use.

- [ ] **Step 1: Side panel — carry the cached translation across an unchanged text, and show the previous Spanish while the new one is pending**

In `sidepanel.js` `addEntry`, replace:

```js
  const i = entries.findIndex((e) => e.t === entry.t && e.speaker === entry.speaker);
  const isNew = i < 0;
  if (isNew) entries.push(entry); else entries[i] = entry;
```

with:

```js
  const i = entries.findIndex((e) => e.t === entry.t && e.speaker === entry.speaker);
  const isNew = i < 0;
  // A bubble re-sent with the same words keeps its translation; one whose words
  // changed is retranslated, but shows the old Spanish until the new one lands
  // rather than a blank line under text the reader is in the middle of.
  const prev = isNew ? null : entries[i];
  if (prev && prev.text === entry.text) entry.es = prev.es;
  else if (prev && prev.es) entry.esStale = prev.es;
  if (isNew) entries.push(entry); else entries[i] = entry;
```

In `bubbleNode`, replace:

```js
    if (e.es) es.textContent = e.es;
    else toSpanish(e.text).then((txt) => {
      if (!txt) return;
      e.es = txt;
      es.textContent = txt;
```

with:

```js
    if (e.es) es.textContent = e.es;
    else {
      if (e.esStale) { es.textContent = e.esStale; es.classList.add('stale'); }
      toSpanish(e.text).then((txt) => {
        if (!txt) return;
        e.es = txt;
        delete e.esStale;
        es.textContent = txt;
        es.classList.remove('stale');
```

and close the added `else {` block after the existing `.then(...)` call (the lines `stickToBottom();` and the sticky re-render stay inside the `.then`). Add to `sidepanel.css`, next to the existing `.bubble .es` rule:

```css
.bubble .es.stale { opacity: .6; }
```

- [ ] **Step 2: Overlay — the same two changes**

In `overlay.js` `addTurn`, replace:

```js
    // A repeated (speaker, t) is a turn that grew by folding: replace it. The fresh
    // object has no cached `es`, so the merged text is retranslated whole.
    if (isNew) turns.push(entry); else turns[i] = entry;
```

with:

```js
    // A turn re-sent with the same words keeps its translation; one whose words
    // changed is retranslated and shows the old Spanish until the new one lands.
    const prev = isNew ? null : turns[i];
    if (prev && prev.text === entry.text) entry.es = prev.es;
    else if (prev && prev.es) entry.esStale = prev.es;
    if (isNew) turns.push(entry); else turns[i] = entry;
```

In `turnNode`, replace:

```js
      if (t.es) es.textContent = t.es;
      else toSpanish(t.text).then((txt) => {
        if (!txt) return;
        // Cached on the turn, not the node: the node can be replaced by a fold.
        t.es = txt;
        es.textContent = txt;
```

with:

```js
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
```

closing the added `else {` after the `.then(...)` call as in the panel. In the overlay's style block (line 282, `.turn .es { … }`), add after it:

```css
    .turn .es.stale { opacity: .6; }
```

- [ ] **Step 3: Gate**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`
Expected: `0 failing, 0 warnings`; all tests pass.

- [ ] **Step 4: Verify in Chrome (manual — the harness profile cannot create the Translator)**

Reload the unpacked extension in `chrome://extensions`, open the side panel with translation on, and play 30 s of uninterrupted English speech through the tab (any English video). Expected: the first bubble closes at a sentence end with its Spanish and never changes again; a second bubble opens and grows; while it grows, the Spanish under it stays visible (dimmed) until the new translation replaces it. Note in the report what was observed, including the count of bubbles.

- [ ] **Step 5: Commit**

```bash
git add sidepanel.js sidepanel.css overlay.js
git commit -m "feat(views): keep a bubble's Spanish on screen while it is retranslated"
```

---

### Task 3: Count the coach's context window in speaker runs, not bubbles

**Files:**
- Modify: `coach.js` (`turnsToText`, lines 201–222)
- Test: `coach.test.js`

**Interfaces:**
- Consumes: `turnsToText(turns, limit, maxChars, maxTurnChars, sessionLang)` as it is.
- Produces: the same signature; `limit` now counts runs of consecutive turns by the same speaker in the same language.

- [ ] **Step 1: Write the failing test**

Append to `coach.test.js` (it already imports `turnsToText`; if not, add it to the import from `./coach.js`):

```js
test('turnsToText counts a run of same-speaker bubbles as one turn', () => {
  // A monologue split into sentence bubbles must not push the learner's own
  // question out of the window.
  const turns = [
    { speaker: 'me', text: 'How did the rollout go?', t: 0, dur: 2, lang: 'en' },
    { speaker: 'them', text: 'It went fine.', t: 3000, dur: 3, lang: 'en' },
    { speaker: 'them', text: 'The hardest part was the timezone.', t: 6000, dur: 3, lang: 'en' },
    { speaker: 'them', text: 'We fixed it by Friday.', t: 9000, dur: 3, lang: 'en' },
  ];
  const text = turnsToText(turns, 2);
  assert.equal(text, 'LEARNER: How did the rollout go?\nOTHER: It went fine. The hardest part was the timezone. We fixed it by Friday.');
});

test('turnsToText keeps runs apart across a language change', () => {
  const turns = [
    { speaker: 'them', text: 'We can ship on Friday.', t: 0, dur: 2, lang: 'en' },
    { speaker: 'them', text: 'Perdón, ¿el viernes?', t: 3000, dur: 2, lang: 'es' },
  ];
  assert.equal(turnsToText(turns, 10, Infinity, Infinity, 'multi'), 'OTHER [en]: We can ship on Friday.\nOTHER [es]: Perdón, ¿el viernes?');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test coach.test.js`
Expected: FAIL — the first test gets only the last two `OTHER` lines.

- [ ] **Step 3: Join runs before slicing**

In `coach.js`, replace the start of `turnsToText`:

```js
export function turnsToText(turns, limit = 10, maxChars = Infinity, maxTurnChars = Infinity, sessionLang = 'en') {
  const lines = turns
    .slice(-limit)
    .map((t) => {
```

with:

```js
// Consecutive turns by one speaker in one language read as a single turn: a
// monologue arrives as several sentence bubbles, and counting each against the
// limit would push the other speaker's last words out of the window.
function runsOf(turns) {
  const runs = [];
  for (const t of turns) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === t.speaker && (last.lang || null) === (t.lang || null)) {
      last.text = `${last.text} ${t.text}`.trim();
    } else {
      runs.push({ speaker: t.speaker, lang: t.lang, text: String(t.text ?? '') });
    }
  }
  return runs;
}

export function turnsToText(turns, limit = 10, maxChars = Infinity, maxTurnChars = Infinity, sessionLang = 'en') {
  const lines = runsOf(turns)
    .slice(-limit)
    .map((t) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test coach.test.js && node .claude/skills/preflight/scripts/preflight.mjs`
Expected: all pass; `0 failing, 0 warnings`. If an existing `turnsToText` test asserted a per-bubble count for same-speaker consecutive turns, update its expectation to the joined run and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add coach.js coach.test.js
git commit -m "feat(coach): count the context window in speaker runs"
```

---

### Task 4: Measure the bubbles in the harness and document the change

**Files:**
- Modify: `e2e/harness.mjs` (`analyse`, lines 283–336)
- Modify: `e2e/run.mjs` (the text report, after the `live line of …` lines)
- Modify: `.claude/skills/message-contract/SKILL.md` (the `SEGMENT` entry)
- Modify: `CLAUDE.md` (Verification section, the paragraph after the `--lanes=2` block)

**Interfaces:**
- Consumes: `SEGMENT` events in `result.events`, each `{ t, entry: { speaker, t, text, lang } }`; `sentenceCut` from `segmenter.js` is *not* imported (the harness stays free of product code) — the check is the same regex inline.
- Produces: `report.bubbles = { count, longestChars, largestRepaintChars, closedAtSentenceEnd, closed }`.

- [ ] **Step 1: Summarise bubbles in `analyse`**

In `e2e/harness.mjs`, before the `return { rows, previews: …` line at the end of `analyse`, add:

```js
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
    closedAtSentenceEnd: closed.filter((t) => /[.!?…]["'”’)\]]*$/.test(t.trim())).length,
  };
```

and add `bubbles` to the returned object: `return { rows, bubbles, previews: …, maxPending, errors };`.

- [ ] **Step 2: Print it in `run.mjs`**

After the two `live line of …` `console.log` lines in `e2e/run.mjs`, add:

```js
  const b = report.bubbles;
  console.log(`bubbles of ${speaker}: ${b.count} · longest ${b.longestChars} chars · largest repaint ${b.largestRepaintChars} chars · closed at a sentence end ${b.closedAtSentenceEnd}/${b.closed}`);
```

- [ ] **Step 3: Run the measurements**

Run, one after the other (each takes about two minutes):

```bash
node e2e/run.mjs monologue30 --lanes=2
node e2e/run.mjs english --lanes=2
node e2e/run.mjs bilingual --lang=multi
```

Expected on the monologue: more than one bubble; `largest repaint` well under the 400-character cap (before this plan a repaint carried the whole growing bubble, up to 400); every closed bubble ends at a sentence end (`n/n`); the live line reports `blank >2.5s … none`. On `english` and `bilingual`: rows unchanged from the runs recorded before this plan (bubble 1.3–2.5 s after the sentence end, match 100 %). Paste the printed lines into the report file verbatim.

- [ ] **Step 4: Document**

In `.claude/skills/message-contract/SKILL.md`, in the `SEGMENT` entry, add after the sentence about upserting by `(speaker, t)`:

```
A landing can produce two SEGMENTs in a row: a bubble closed at a finished sentence (its text
may be shorter than the last one sent under that key) followed by the bubble opened with the
rest. A bubble whose text did not change is not re-sent.
```

In `CLAUDE.md`, at the end of the paragraph that begins `With \`--lanes=2\` the other speaker's lane runs too`, add:

```
The run also counts the speaker's bubbles: how many, the longest, the largest text a single
repaint retranslated, and whether every closed bubble ends at a finished sentence.
```

- [ ] **Step 5: Gate and commit**

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`
Expected: `0 failing, 0 warnings`; all tests pass.

```bash
git add e2e/harness.mjs e2e/run.mjs .claude/skills/message-contract/SKILL.md CLAUDE.md
git commit -m "test(e2e): count bubbles and the largest repaint per run"
```

---

### Task 5: Measure the Spanish under the bubbles with a translator stand-in

**Files:**
- Modify: `e2e/harness.mjs` (`prepareLive`, `sampleLive`, `liveReport`)
- Modify: `e2e/run.mjs` (the text report)
- Modify: `CLAUDE.md` (Known debt: the Translator entry)

**Interfaces:**
- Consumes: the side panel's DOM — bubbles are `#transcript .bubble[data-key]` with a `.es` span that carries class `stale` while the previous Spanish is shown (Task 2); `translate.js` reads `globalThis.Translator` lazily on the first `toSpanish()` call, so a stand-in defined before the session starts is what it uses.
- Produces: `report.live.spanish = { closedWithSpanish, closed, repaintsBlankingSpanish, repaints, maxTranslatedChars }`.

Rationale: `Translator.create` throws `NotSupportedError` in the harness's throwaway profile, so nothing measured what the learner actually complained about — the Spanish under a growing bubble. The stand-in does not translate; it returns the text marked `[es]` after a delay proportional to its length (40 ms + 8 ms per character, the shape of a real on-device translation), so the run can show that a closed bubble keeps its Spanish, that a repaint keeps the old Spanish on screen, and how much text one translation had to cover.

- [ ] **Step 1: Install the stand-in when the real translator cannot be created**

In `prepareLive`, replace the translator expression's body so that a failed `create` installs the stand-in instead of returning an error:

```js
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
```

- [ ] **Step 2: Sample the bubbles' Spanish**

In `sampleLive`, add to the returned object a `bubbleList` next to `bubbles`:

```js
        bubbleList: [...document.querySelectorAll('#transcript .bubble')].map((b) => {
          const es = b.querySelector('.es');
          return { key: b.dataset.key, len: (b.querySelector('span:not(.meta):not(.es):not(.lang-tag)') || {}).textContent?.length || 0,
            es: es ? es.textContent.length : 0, stale: !!(es && es.classList.contains('stale')) };
        }),
```

(The text span is the one `bubbleNode` appends after `meta`; the selector above picks it without a class of its own.)

- [ ] **Step 3: Report it**

In `liveReport`, compute from `samples` (only when `speaker === 'them'`, the translated lane):

```js
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
  const spanish = {
    closed: closedList.length,
    closedWithSpanish: closedList.filter((b) => b.es && !b.stale).length,
    repaints,
    repaintsBlankingSpanish,
    maxTranslatedChars,
  };
```

and include `spanish` in the returned object. In `run.mjs`, after the `bubbles of …` line, print:

```js
  const sp = report.live.spanish;
  if (sp) console.log(`Spanish under ${speaker}'s bubbles: closed with Spanish ${sp.closedWithSpanish}/${sp.closed} · repaints ${sp.repaints}, of which blanked the Spanish ${sp.repaintsBlankingSpanish} · longest text translated at once ${sp.maxTranslatedChars} chars`);
```

- [ ] **Step 4: Run and record**

```bash
node e2e/run.mjs talk30 --lanes=2 --only-them --translate
```

(`talk30` is the half minute spoken in sentences; `--only-them` mutes the learner's lane, whose copy of the same audio would otherwise land between the other speaker's pieces and stop them folding.) Expected: `translator: stand-in …` in the log; every closed bubble with Spanish; `blanked the Spanish 0`; `longest text translated at once` under 400. Paste the printed lines into the report verbatim.

- [ ] **Step 5: Document, gate, commit**

In `CLAUDE.md` Known debt, replace the entry that begins `The built-in Translator cannot be created in the harness's throwaway profile` with:

```
- The built-in Translator cannot be created in the harness's throwaway profile, so `--translate`
  runs a stand-in that marks text `[es]` after 40 ms + 8 ms per character: it measures when
  Spanish appears and disappears under a bubble, never what it says.
```

Also in `CLAUDE.md`, in the Verification code block, add after the `monologue30 --lanes=2` line:

```
node e2e/run.mjs talk30 --lanes=2 --only-them --translate   # the same half minute in sentences: where bubbles close
```

Run: `node .claude/skills/preflight/scripts/preflight.mjs && node --test *.test.js`, then:

```bash
git add e2e/harness.mjs e2e/run.mjs CLAUDE.md
git commit -m "test(e2e): measure the Spanish under the bubbles with a translator stand-in"
```
