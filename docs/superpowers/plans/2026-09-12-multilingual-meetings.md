# Multilingual meetings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe a meeting that mixes English and Spanish so each turn appears in the language it was spoken, labelled, with the Spanish translation only under the turns that are not already Spanish.

**Architecture:** The engine setting is split so the provisional live line is always transcribed locally while authoritative turns follow the engine — which both fixes today's dead live line on the API engine and lets Groq's own language detection label the archived transcript for free. A new pure module tells English from Spanish in a string; language becomes a property of a turn rather than of the session; and each speaker carries a sticky language that Groq's answer corrects (API engine) or that a bounded re-transcription corrects (local engine).

**Tech Stack:** Chrome MV3 extension, plain ES modules, no build step and no dependencies. Local Whisper via the vendored transformers.js + ONNX Runtime Web; Groq's OpenAI-compatible audio endpoint; Chrome's built-in `Translator`. Node's built-in test runner for the pure modules.

**Spec:** `docs/superpowers/specs/2026-09-12-multilingual-meetings-design.md`

## Global Constraints

- **No build step, no `package.json`, no dependencies, no bundler.** Chrome loads the folder verbatim. Every file that ships is a file that was written.
- **Never edit `vendor/` or `icons/`.** Replace them wholesale from upstream instead.
- Minimum Chrome is 116. Node is for tooling only; the extension never runs in Node.
- **The offscreen document has no `chrome.storage`** — every read and write goes through the service worker as `STORE_GET` / `STORE_SET`. It also outlives the session, so never cache settings for the document's lifetime.
- **No remote code**: `script-src 'self' 'wasm-unsafe-eval'`. No CDN, no inline `<script>`, no inline event handlers.
- **Never pass dynamic content to `innerHTML`.** Use `textContent` and `createElement`.
- **Pure logic stays pure.** `segmenter.js`, `capture.js`, `coach.js`, `phrasebook.js`, `stitch.js`, `queue.js`, `report.js` and the new `langid.js` import no `chrome.*` and take side effects as injected parameters.
- **Language of the repository is English** (identifiers, comments, commit messages). **The product is Spanish** — UI strings and user-facing errors stay Spanish. Never "fix" a Spanish UI string into English.
- **Adding or changing a message type or payload field means documenting it in `.claude/skills/message-contract/SKILL.md` first**, then sending it, then handling it. Preflight fails the build on a SCREAMING_SNAKE type sent with no handler.
- Languages in scope: **English and Spanish only**.
- On the Claude path: default model `claude-opus-5`; model ids are complete as-is with **no date suffix appended**; **never send `temperature`/`top_p`/`top_k`** (rejected with a 400 on Opus 5 and Sonnet 5).
- **The verification gate for every task:**
  ```bash
  node .claude/skills/preflight/scripts/preflight.mjs   # expect: 0 failing, 0 warnings
  node --test *.test.js                                 # expect: 0 fail
  ```
  Static checks cannot verify capture, permissions, WebGPU or transcription quality. Never claim they were tested; say what was checked.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `langid.js` | **create** | Tell English from Spanish in a string. Pure, no `chrome.*`, no DOM. One export: `detect`. |
| `langid.test.js` | **create** | Its corpus and threshold tests. |
| `segmenter.js` | modify | `foldIntoTranscript` stops merging turns of different languages. |
| `segmenter.test.js` | modify | Fold-across-languages tests. |
| `worker.js` | modify | Load the multilingual model for a bilingual session; take the language per `transcribe` request instead of per session. |
| `worker.test.js` | modify | `modelForLang` tests for the new value. |
| `offscreen.js` | modify | Split engine routing; the per-speaker sticky language; `lang` on `PARTIAL` and on stored entries; the API and local detection paths. |
| `coach.js` | modify | Per-provider token ceiling so a thinking model is not truncated. |
| `coach.test.js` | modify | A stub for the Anthropic endpoint, and the ceiling assertions. |
| `sidepanel.html` `sidepanel.css` `sidepanel.js` | modify | The bilingual session option; the per-turn language tag; translate only non-Spanish turns. |
| `overlay.js` | modify | The same two rendering rules, in its own copy (a content script cannot import). |
| `setup.js` | modify | Say that word-by-word recognition is off in a bilingual session. |
| `.claude/skills/message-contract/SKILL.md` | modify | Document `PARTIAL.lang` before it is sent. |
| `CLAUDE.md` | modify | Add `langid.js` to the pure-logic list. |

Phase 1 is tasks 1–6, phase 2 is tasks 7–9, phase 3 is task 10.

---

## Task 1: Stop a thinking model from being truncated

The report ceiling is 2800 tokens and the JSON ceiling is 1200. Both were measured against models that do not think. `coach.js` already records the mechanism for Groq — the gpt-oss models spend reasoning tokens from the same ceiling *before* they write the JSON, which is why 1200 exists — and Claude Opus 5 thinks by default. Left alone, a learner who selects Claude gets a truncated report or an empty suggestion, and it reads as "Claude is broken".

The ceiling cannot simply be raised for everyone: Groq's free tier allows 8000 tokens a minute, and `callGroq` already translates that limit into a user-facing 429 message. So the floor is per provider.

**Files:**
- Modify: `coach.js` (the `ask` function, around line 150)
- Test: `coach.test.js`

**Interfaces:**
- Produces: `ask({ provider, model, keys, system, user, maxTokens, schema })` keeps its signature. Its internal ceiling is now `Math.max(maxTokens, THINKING_FLOOR[resolved provider] ?? 0)`.

- [ ] **Step 1: Write the failing tests**

Add to `coach.test.js`, after the existing `stubGroq` helper:

```js
// Stub for the Anthropic endpoint: captures the request body instead of hitting
// the network. Shaped like the Messages API response, which nests text blocks
// under `content` rather than Groq's `choices`.
function stubAnthropic(capture, text) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capture.url = url;
    capture.body = JSON.parse(init.body);
    capture.headers = init.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
    };
  };
  return () => { globalThis.fetch = original; };
}

const CLAUDE_SETTINGS = {
  reportProvider: 'anthropic',
  reportModel: 'claude-opus-5',
  anthropicKey: 'sk-ant-test-key-for-unit-tests',
  level: 'B1-B2',
  situation: 'conversación de trabajo en inglés',
  lang: 'en',
};

const TURNS = [
  { speaker: 'me', text: 'I think we should ship it.', t: 1000, dur: 2 },
  { speaker: 'them', text: 'Why this week?', t: 4000, dur: 1 },
];

test('the Claude report is given room to think before it answers', async () => {
  // A thinking model spends its reasoning from max_tokens before writing a token
  // of the answer, so a ceiling measured on a non-thinking model truncates it.
  const seen = {};
  const restore = stubAnthropic(seen, '# Informe\n\nTodo bien.');
  try {
    await askReport({ turns: TURNS, settings: CLAUDE_SETTINGS });
  } finally {
    restore();
  }
  assert.ok(seen.body.max_tokens >= 16000,
    `Claude got max_tokens ${seen.body.max_tokens}; a thinking model needs room for reasoning plus the answer`);
});

test('Groq keeps its measured ceiling, which its free tier can pay for', async () => {
  // Raising Groq's would trade a truncation for a rate-limit failure: the free
  // tier allows 8000 tokens a minute.
  const seen = {};
  const restore = stubGroq(seen, '# Informe\n\nTodo bien.');
  try {
    await askReport({ turns: TURNS, settings: { ...REPLY_SETTINGS, reportProvider: 'groq' } });
  } finally {
    restore();
  }
  assert.equal(seen.body.max_completion_tokens, 2800);
});

test('never send a sampling parameter to Claude', async () => {
  // temperature / top_p / top_k are rejected with a 400 on Opus 5 and Sonnet 5.
  const seen = {};
  const restore = stubAnthropic(seen, 'ok');
  try {
    await askReport({ turns: TURNS, settings: CLAUDE_SETTINGS });
  } finally {
    restore();
  }
  assert.ok(!('temperature' in seen.body));
  assert.ok(!('top_p' in seen.body));
  assert.ok(!('top_k' in seen.body));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test coach.test.js`
Expected: FAIL on the first test — `Claude got max_tokens 2800`. (The Groq and sampling tests pass already; they are regression guards.)

- [ ] **Step 3: Add the per-provider floor**

In `coach.js`, immediately above `export function resolveProvider`:

```js
// A thinking model spends its reasoning from the same ceiling before it writes any
// of the answer — the note on JSON_BUDGET records this for Groq's gpt-oss models,
// and Claude Opus 5 thinks by default, so every ceiling measured against a
// non-thinking model is too low for it. Groq keeps its measured figures: its free
// tier allows 8000 tokens a minute, so raising them there would trade a truncated
// answer for a rate-limit error. A ceiling is not a target — nothing is spent on
// headroom that goes unused.
const THINKING_FLOOR = { anthropic: 16000 };
```

Then inside `ask`, after `const usado = ...` and before the provider branch, raise the ceiling:

```js
  const techo = Math.max(maxTokens, THINKING_FLOOR[elegido.provider] || 0);
```

and pass `techo` instead of `maxTokens` to both `callGroq` and `callAnthropic`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test coach.test.js`
Expected: PASS, all three.

- [ ] **Step 5: Run the full gate**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

- [ ] **Step 6: Commit**

```bash
git add coach.js coach.test.js
git commit -m "$(cat <<'EOF'
fix(coach): give a thinking model room before it answers

The report ceiling of 2800 and the JSON ceiling of 1200 were measured
against models that do not think. Claude Opus 5 thinks by default and
spends that reasoning from the same max_tokens, so both ceilings
truncated it — the same mechanism coach.js already documents for Groq's
gpt-oss models. The floor is per provider because Groq's free tier only
allows 8000 tokens a minute.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `langid.js` — tell English from Spanish

**Files:**
- Create: `langid.js`
- Create: `langid.test.js`
- Modify: `CLAUDE.md` (the "Pure logic stays pure" list)

**Interfaces:**
- Produces: `detect(text) → { lang: 'en' | 'es' | null, confidence: number }`. `lang` is `null` when the text carries no evidence either way; `confidence` is 0–1 and is 0 exactly when `lang` is `null`. Tasks 9 and 10 consume it.

- [ ] **Step 1: Write the failing tests**

Create `langid.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from './langid.js';

// Utterances shaped like the ones a real bilingual meeting produces.
const CASES = [
  ['en', 'So I think we should move the deadline to next Friday, if that works for everyone.'],
  ['es', 'Yo creo que deberíamos mover la fecha para el viernes, si les parece bien.'],
  ['en', 'Can you share the document with the team before the call?'],
  ['es', '¿Puedes compartir el documento con el equipo antes de la llamada?'],
  ['es', 'Perdón, se me cortó el audio. ¿Me escuchan ahora?'],
  ['en', 'Yeah, no worries, we can hear you now.'],
  ['es', 'Necesito más tiempo para hacer el reporte de ventas.'],
  ['en', 'Let me check the numbers and get back to you tomorrow.'],
];

test('it reads ordinary meeting sentences in both languages', () => {
  for (const [expected, text] of CASES) {
    assert.equal(detect(text).lang, expected, text);
  }
});

test('a bare acknowledgement is still readable', () => {
  // These are most of what a meeting transcript is made of, and a wrong guess on
  // one of them switches a speaker's language for the turns that follow.
  for (const [expected, text] of [['en', 'Okay.'], ['en', 'Thanks.'], ['es', 'Sí.'], ['es', 'Gracias.']]) {
    assert.equal(detect(text).lang, expected, text);
  }
});

test('shared jargon with no evidence returns no answer rather than a guess', () => {
  // Naming a language here would flip a speaker on the strength of nothing.
  for (const text of ['Marketing, software, cloud, dashboard, feedback.', '', '   ', '...']) {
    const out = detect(text);
    assert.equal(out.lang, null, JSON.stringify(text));
    assert.equal(out.confidence, 0);
  }
});

test('an English sentence keeps its language when a Spanish name appears in it', () => {
  // The reason accent weight is scaled by length instead of being a flat bonus:
  // one accented proper noun used to outvote four English function words.
  assert.equal(detect('We visited España last year and it was great.').lang, 'en');
  assert.equal(detect('The client is José and he works with the team.').lang, 'en');
});

test('Spanish survives English loanwords in the middle of it', () => {
  assert.equal(detect('El dashboard de marketing no carga el feedback.').lang, 'es');
});

test('confidence is high when the evidence is one-sided and low when it is mixed', () => {
  assert.equal(detect('Yo creo que la fecha es el viernes.').confidence, 1);
  const mixto = detect('We visited España last year and it was great.');
  assert.ok(mixto.confidence > 0 && mixto.confidence < 1,
    `mixed evidence should not read as certain, got ${mixto.confidence}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test langid.test.js`
Expected: FAIL — `Cannot find module './langid.js'`.

- [ ] **Step 3: Write `langid.js`**

```js
// Tells English from Spanish in a transcribed turn. Pure: no chrome.*, no DOM, no
// network — it runs in the offscreen document, in both interfaces, and in Node.
//
// It reads text, never audio, so it cannot tell Whisper which language to decode
// before the fact. What it is for is labelling a turn once the text exists, and
// deciding whether a turn was decoded in the wrong language and is worth one more
// pass.

// Function words, which is what carries the signal: they are the most frequent
// tokens in any sentence and they barely overlap between the two languages.
const ES = new Set([
  'que', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'en', 'es', 'por', 'para',
  'con', 'no', 'se', 'del', 'al', 'pero', 'porque', 'como', 'más', 'este', 'esta',
  'esto', 'hay', 'ya', 'muy', 'todo', 'cuando', 'yo', 'tengo', 'vamos', 'hacer',
  'puedo', 'creo', 'entonces', 'bien', 'si', 'sí', 'ser', 'está', 'están', 'tiene',
  'sobre', 'nosotros', 'ustedes', 'también', 'ahora', 'gracias', 'perdón', 'me', 'mi',
  'su', 'lo', 'les', 'nos', 'eso', 'ese', 'algo', 'nada', 'desde', 'hasta', 'antes',
  'después', 'aquí', 'allí', 'solo', 'sólo', 'cada', 'otro', 'otra', 'mucho', 'poco',
  'vez', 'así',
]);

const EN = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'it', 'that', 'for', 'on', 'with', 'as', 'are',
  'this', 'be', 'have', 'from', 'we', 'you', 'they', 'not', 'but', 'can', 'will',
  'would', 'i', 'my', 'our', 'your', 'so', 'what', 'when', 'there', 'think', 'about',
  'just', 'need', 'going', 'okay', 'ok', 'yes', 'thanks', 'right', 'let', 'do', 'does',
  'how', 'all', 'get', 'make', 'time', 'work', 'was', 'were', 'been', 'has', 'had',
  'at', 'by', 'if', 'or', 'then', 'them', 'these', 'those', 'should', 'could',
  'because', 'who', 'which', 'more', 'some', 'any', 'than', 'very', 'now', 'here',
  'also', 'one', 'two', 'first', 'next', 'last',
]);

// Characters English does not use in ordinary writing. Strong evidence, but scaled
// by length below rather than added flat: a single accented proper noun in an
// English sentence must not outvote its function words.
const MARKS = /[ñáéíóúü¿¡]/giu;
const MARK_WEIGHT = 0.5;

const words = (text) =>
  String(text ?? '').toLowerCase().normalize('NFC').match(/[\p{L}\p{M}']+/gu) || [];

export function detect(text) {
  const w = words(text);
  if (!w.length) return { lang: null, confidence: 0 };

  let es = 0;
  let en = 0;
  for (const word of w) {
    if (ES.has(word)) es++;
    if (EN.has(word)) en++;
  }

  const marks = (String(text ?? '').match(MARKS) || []).length;
  const esScore = es / w.length + (Math.min(marks, w.length) / w.length) * MARK_WEIGHT;
  const enScore = en / w.length;

  const total = esScore + enScore;
  // Shared jargon and proper nouns only: saying a language here would move a
  // speaker's whole conversation on the strength of nothing.
  if (total === 0) return { lang: null, confidence: 0 };

  return {
    lang: esScore > enScore ? 'es' : 'en',
    confidence: Number((Math.abs(esScore - enScore) / total).toFixed(2)),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test langid.test.js`
Expected: PASS, all six.

- [ ] **Step 5: Record the new pure module**

In `CLAUDE.md`, in the "Pure logic stays pure" paragraph, add `langid.js` to the list of modules that import no `chrome.*`.

- [ ] **Step 6: Run the full gate, then commit**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
git add langid.js langid.test.js CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(langid): tell English from Spanish in a transcribed turn

Function-word coverage plus the characters English does not use, with the
accent weight scaled by sentence length rather than flat — a single
accented proper noun ("We visited España last year") outvoted four
English function words otherwise. Returns no answer at all when the text
is only shared jargon, because naming a language there would move a
speaker's whole conversation on no evidence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Turns of different languages must not fold together

`foldIntoTranscript` merges consecutive same-speaker turns inside `MERGE_GAP_MS`. The tab track carries every remote participant, so in a bilingual meeting consecutive turns routinely alternate language — merging them would put English and Spanish in one bubble under a single translation.

**Files:**
- Modify: `segmenter.js` (`foldIntoTranscript`, around line 224)
- Test: `segmenter.test.js`

**Interfaces:**
- Consumes: entries may now carry `lang` (`'en'`, `'es'`, or absent).
- Produces: `foldIntoTranscript(transcript, entry, gapMs, maxChars)` is unchanged in signature. Two entries fold only when their `lang` matches; an absent `lang` on either side is treated as matching, so a transcript written by an earlier version still folds exactly as it did.

- [ ] **Step 1: Write the failing tests**

Add to `segmenter.test.js`, after the existing fold tests:

```js
test('consecutive turns in different languages do not fold', () => {
  // The tab track carries every remote participant, so English and Spanish
  // alternate on one speaker. Folded, they would share a bubble and a single
  // translation.
  const tr = [{ speaker: 'them', text: 'We can ship on Friday.', t: 1000, dur: 2, lang: 'en' }];
  foldIntoTranscript(tr, { speaker: 'them', text: 'Perdón, ¿el viernes?', t: 4000, dur: 1.5, lang: 'es' });
  assert.equal(tr.length, 2);
});

test('consecutive turns in the same language still fold', () => {
  const tr = [{ speaker: 'them', text: 'We can ship', t: 1000, dur: 2, lang: 'en' }];
  const shown = foldIntoTranscript(tr, { speaker: 'them', text: 'on Friday.', t: 4000, dur: 1, lang: 'en' });
  assert.equal(tr.length, 1);
  assert.equal(tr[0].text, 'We can ship on Friday.');
  assert.equal(shown, tr[0]);
});

test('a transcript written before languages existed folds exactly as it did', () => {
  // Entries stored by an earlier version carry no lang at all.
  const tr = [{ speaker: 'me', text: 'I think I need more', t: 1000, dur: 2 }];
  foldIntoTranscript(tr, { speaker: 'me', text: 'fluency in English.', t: 4500, dur: 1.5 });
  assert.equal(tr.length, 1);
  // And a labelled entry folds into an unlabelled one rather than splitting the turn.
  const mixto = [{ speaker: 'me', text: 'I think', t: 1000, dur: 2 }];
  foldIntoTranscript(mixto, { speaker: 'me', text: 'so too.', t: 4000, dur: 1, lang: 'en' });
  assert.equal(mixto.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test segmenter.test.js`
Expected: FAIL on the first test — the two turns fold into one, so `tr.length` is 1.

- [ ] **Step 3: Add language to the fold condition**

In `segmenter.js`, in `foldIntoTranscript`, extend the `fits` expression:

```js
  const fits = last && last.speaker === entry.speaker
    && entry.t >= last.t
    // One bubble carries one language, because it carries one translation. An entry
    // with no lang predates the field and matches anything, so an old transcript
    // folds exactly as it used to.
    && (!last.lang || !entry.lang || last.lang === entry.lang)
    && entry.t - (last.t + last.dur * 1000) <= gapMs
    && last.text.length + entry.text.length < maxChars;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test segmenter.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full gate, then commit**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
git add segmenter.js segmenter.test.js
git commit -m "$(cat <<'EOF'
fix(segmenter): one bubble carries one language

The tab track carries every remote participant, so consecutive turns of
one speaker alternate language in a bilingual meeting. Folded, English
and Spanish shared a bubble and a single translation. An entry with no
lang predates the field and still folds as before.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Split the engine so the live line never depends on it

Choosing the Groq engine disables the live line completely today: `previewEligible` refuses when the engine is `api`, `drain` discards any preview queued before the engine flipped, and `start` skips loading the local model. On a machine where Chrome's on-device recognition never emits, that leaves no live text at all. The engine setting should govern authoritative turns only.

**Files:**
- Modify: `offscreen.js` (`previewEligible`, `drain`, `start`, `previewFallback`)

**Interfaces:**
- Produces: previews are always transcribed by `localTranscribe`. Real segments follow `state.settings.engine`. The local model is initialised whenever the preview lane is wanted, whatever the engine. Provisional audio never leaves the machine — now a guarantee rather than a side effect.

> **No unit test exists for this file and none can be added without a `chrome.*` shim** — `offscreen.js` owns the session and is chrome-coupled throughout. Its gate is preflight plus the manual check in step 5. Say exactly that when reporting; do not imply it was tested automatically.

- [ ] **Step 1: Stop gating previews on the engine**

In `previewEligible`, delete the final clause and its comment:

```js
    // One Groq audio request per preview would exhaust the free tier in minutes.
    // On that engine Web Speech stays the only live source.
    && s.engine !== 'api';
```

so the expression now ends at `&& s.liveTranscript !== false;`. Add, above the function, a line recording why the lane is unconditional:

```js
// The lane is local whatever the engine: a preview is provisional audio, so sending
// it to Groq would both leak speech still being spoken and exhaust the free tier's
// request budget in minutes. Keeping it local is what lets the engine setting govern
// authoritative turns alone.
```

- [ ] **Step 2: Route by what the segment is, not by the setting alone**

In `drain`, delete this guard entirely:

```js
  // Settings are re-read on every coach call, so the engine can flip to the API
  // mid-session. A preview queued before that must never become a Groq request:
  // the lane is local-only, and provisional audio has no business leaving.
  if (seg.preview && state.settings.engine === 'api') return drain();
```

and change the transcription call so a preview is always local:

```js
    const text = (!seg.preview && state.settings.engine === 'api')
      ? await apiTranscribe(seg.audio)
      : await localTranscribe(seg.audio);
```

- [ ] **Step 3: Load the local model whatever the engine**

In `start`, replace the engine branch that decides whether to initialise the worker:

```js
  // The model is what draws the live line, so it loads on both engines now. On the
  // API engine it costs one download the first time and buys a live line that the
  // authoritative turns — which do go to Groq — cannot provide.
  status(settings.engine === 'api'
    ? 'Cargando modelo local para la línea en vivo…'
    : 'Cargando modelo local…', 'loading');
  ensureWorker().postMessage({
    type: 'init',
    model: settings.model || 'onnx-community/whisper-base.en',
    device: settings.device || 'webgpu',
    base: chrome.runtime.getURL('vendor/'),
    lang: settings.lang || 'en',
  });
```

- [ ] **Step 4: Tell the truth about the fallback**

`previewFallback` answers whether losing Web Speech still leaves live text. It no longer depends on the engine:

```js
// Whether losing Web Speech actually costs the learner the live line. It does not,
// unless the preview lane itself is off or retired — the lane is local on every
// engine now.
const previewFallback = () =>
  (state.settings || {}).liveTranscript !== false && !state.previewOff.them;
```

- [ ] **Step 5: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

Then in Chrome, because static checks cannot reach this:
1. `chrome://extensions` → reload the extension.
2. In Ajustes, set the engine to the Groq API and save a Groq key.
3. Open a tab with speech, invoke the extension from the toolbar icon, and start.
4. **Expect:** the status says the local model is loading for the live line; the provisional line appears while someone speaks; the authoritative bubbles still arrive (from Groq).
5. Confirm in the Network panel of `chrome://extensions` → *Inspect views: offscreen.html* that requests to Groq carry only whole finished segments — one per turn, not one per second.

- [ ] **Step 6: Commit**

```bash
git add offscreen.js
git commit -m "$(cat <<'EOF'
fix(offscreen): the live line no longer dies on the API engine

previewEligible refused on engine 'api', drain discarded queued
previews, and start skipped the local model — so choosing Groq left a
machine with no working Web Speech with no live text at all. The engine
now governs authoritative turns only; previews are always local, which
also makes "provisional audio never leaves the machine" a guarantee
rather than a side effect.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Carry the language through the protocol

Nothing detects a language yet — this task only makes the language travel, seeded from the session setting, so no behaviour changes and every later task has a field to write into.

**Files:**
- Modify: `.claude/skills/message-contract/SKILL.md` (the `PARTIAL` row) — **first**
- Modify: `offscreen.js` (state, `clearPartial`, `appendTranscript`, the `PARTIAL` broadcasts)

**Interfaces:**
- Produces: `state.lang = { them, me }`, the sticky language per speaker, seeded from `settings.lang` in `start`. Every `PARTIAL` carries `lang`. Every stored entry carries `lang`. Tasks 6, 9 and 10 consume these.

- [ ] **Step 1: Document the field before sending it**

In `.claude/skills/message-contract/SKILL.md`, extend the `PARTIAL` row's payload description with:

```
`lang` (`en` or `es` — the language this speaker's line is currently being decoded in, so a view knows whether to translate it; a missing value is read as the session language)
```

- [ ] **Step 2: Add the per-speaker language to the session state**

In `offscreen.js`, in the `state` object, after `pieceStart`:

```js
  // The language each speaker is currently being transcribed in. Whisper has to be
  // told a language before it decodes, so this is what a preview is decoded with;
  // an authoritative turn is what corrects it (Groq detects the language itself,
  // and on the local engine langid.js decides whether a re-pass is warranted).
  lang: { them: 'en', me: 'en' },
```

and in `start`, beside the other per-session resets:

```js
  const sesion = settings.lang === 'es' ? 'es' : 'en';
  state.lang = { them: sesion, me: sesion };
```

- [ ] **Step 3: Put the language on every partial and every entry**

In `clearPartial`, add the field so a cleared line is still well-formed:

```js
  else broadcast({ type: 'PARTIAL', speaker, text: '', committed: '', lang: state.lang[speaker] });
```

In `drain`'s preview branch, on the `PARTIAL` broadcast:

```js
        broadcast({
          type: 'PARTIAL',
          speaker: seg.speaker,
          text: `${out.committed} ${out.tail}`.trim(),
          committed: out.committed,
          lang: state.lang[seg.speaker],
        });
```

In `drain`'s authoritative branch, on the `appendTranscript` call:

```js
      await appendTranscript({
        speaker: seg.speaker,
        text: clean,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
        lang: state.lang[seg.speaker],
      });
```

In `startLiveLayer`'s `onText` and `onError`, and in `stopLiveLayer`, add `lang: state.lang.them` to each `PARTIAL` broadcast.

- [ ] **Step 4: A provisional line holds one language**

The stitched line already resets when the segmenter opens a new piece. A language
change has to reset it for the same reason — the accumulated words were decoded in
the old language, and appending the new ones would leave one line holding two.

In `drain`'s preview branch, widen the reset condition and record what it tracks:

```js
        if (state.pieceStart[seg.speaker] !== seg.startedAt
          || state.stitchLang[seg.speaker] !== state.lang[seg.speaker]) {
          // First preview of a new piece — or of a new language for this speaker.
          // Either way the accumulated line cannot be built on: its words were
          // decoded under a rule that no longer applies.
          state.stitch[seg.speaker] = STITCH_EMPTY;
          state.pieceStart[seg.speaker] = seg.startedAt;
          state.stitchLang[seg.speaker] = state.lang[seg.speaker];
        }
```

and declare the companion field in `state`, beside `pieceStart`:

```js
  // Which language the accumulated line was decoded in, so a switch discards it
  // rather than appending across two languages.
  stitchLang: { them: 'en', me: 'en' },
```

resetting it in `start` alongside `state.lang`:

```js
  state.stitchLang = { them: sesion, me: sesion };
```

- [ ] **Step 5: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail. Behaviour is unchanged — every language is the session language until task 9, so the new reset cannot fire yet.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/message-contract/SKILL.md offscreen.js
git commit -m "$(cat <<'EOF'
feat(offscreen): carry a language per speaker and per turn

Seeded from the session setting, so nothing changes yet. It gives the
detection paths a field to write into and the views a field to read,
and it is what lets one bubble mean one language.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Show the language, and translate only what is not Spanish

**Files:**
- Modify: `sidepanel.js` (`traducir`, `bubbleNode`, `showPartial`, `renderSticky`)
- Modify: `sidepanel.css` (the tag)
- Modify: `overlay.js` (its own `turnNode`, `showPartial`, and CSS block)

**Interfaces:**
- Consumes: `entry.lang` and `PARTIAL.lang` from task 5.
- Produces: `langOf(x)` in each view — `x.lang === 'es' ? 'es' : 'en'`, so an unlabelled entry reads as English. Translation happens when the turn is the other speaker's **and** its language is not Spanish.

- [ ] **Step 1: Change what decides a translation, in the side panel**

In `sidepanel.js`, replace `traducir` and add the per-turn helper:

```js
// Whether translation is switched on at all. Which turns actually get translated is
// a per-turn decision now: a Spanish turn needs no Spanish line under it, and in a
// bilingual meeting both kinds arrive on the same speaker.
const traducir = () => settings.translate !== false;
// An entry stored before languages existed reads as English, which is what it was.
const langOf = (x) => (x && x.lang === 'es' ? 'es' : 'en');
```

In `bubbleNode`, change the translation condition and add the tag:

```js
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
```

- [ ] **Step 2: Do the same for the live line**

In `sidepanel.js`, `showPartial` gains the language and stops translating a Spanish line:

```js
function showPartial(speaker, text, committed = '', lang = 'en') {
```

and replace the translation guard near the end of the function:

```js
  if (!p.es || !traducir() || lang === 'es') return;
```

In the message handler, pass it through:

```js
  else if (msg.type === 'PARTIAL') showPartial(msg.speaker === 'me' ? 'me' : 'them', msg.text, msg.committed, msg.lang);
```

- [ ] **Step 3: Keep the sticky card honest**

In `renderSticky`, the card is a copy of a turn, so it must not show a Spanish translation slot for a Spanish turn. Replace the `if (t.es)` block's condition:

```js
  if (t.es && langOf(t) !== 'es') {
```

- [ ] **Step 4: Style the tag**

In `sidepanel.css`, after the `.meta` rule:

```css
/* Which language the turn was spoken in. Small and quiet: it matters when scanning
   a bilingual meeting and must not compete with the words. */
.lang-tag {
  font-size: 9px; letter-spacing: .06em; padding: 0 3px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--muted);
}
```

- [ ] **Step 5: Repeat all four in the overlay**

`overlay.js` keeps its own copy because a content script cannot import. Add beside its other helpers:

```js
  const langOf = (x) => (x && x.lang === 'es' ? 'es' : 'en');
```

In `turnNode`, add the tag to the `who` line and change the condition:

```js
    const who = document.createElement('span');
    who.textContent = (t.speaker === 'me' ? 'Yo' : 'Interlocutor') + ' · ' + (langOf(t) === 'es' ? 'ES' : 'EN');
    const p = document.createElement('div');
    p.textContent = t.text;
    div.append(who, p);
    if (t.speaker !== 'me' && langOf(t) !== 'es' && translateOn) {
```

In its `showPartial`, take `lang = 'en'` as a fourth parameter and change the final guard to `if (!es || !translateOn || lang === 'es') return;`. In the `PARTIAL` case of the message handler, pass `msg.lang`.

- [ ] **Step 6: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

In Chrome, after reloading: an ordinary English session shows an `EN` tag on every bubble and the Spanish line exactly where it was before. Nothing else changes yet.

- [ ] **Step 7: Commit**

```bash
git add sidepanel.js sidepanel.css overlay.js
git commit -m "$(cat <<'EOF'
feat(ui): label a turn's language and translate only what is not Spanish

Translation was a session-wide setting; in a bilingual meeting both
languages arrive on the same speaker, so it is a per-turn decision. A
Spanish turn shows as Spanish with no translation slot under it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The worker takes a language per request

`modelForLang` loads the English-only model unless the session is Spanish, and the transcribe handler pins `opts.language` from the session. A bilingual session needs the multilingual model and a language chosen per segment.

**Files:**
- Modify: `worker.js` (`modelForLang`, the `transcribe` branch)
- Modify: `offscreen.js` (`localTranscribe`)
- Test: `worker.test.js`

**Interfaces:**
- Produces: `modelForLang(model, lang)` strips `.en` for every language except `'en'`. The `transcribe` message accepts an optional `lang`, falling back to the session language. `localTranscribe(audio, lang)` takes the language to decode in.

- [ ] **Step 1: Write the failing tests**

`worker.test.js` already asserts both existing languages — *a Spanish session swaps the
English-only model for the multilingual one* and *an English session keeps the
configured model untouched*. Step 3 inverts the condition those two describe, so they
are the regression guard for this change and must keep passing untouched. Do not
restate them; add only the case that does not exist yet:

```js
test('a bilingual session loads the multilingual model', () => {
  // The .en exports only understand English, so a bilingual meeting would transcribe
  // every Spanish turn as English that was never said.
  assert.equal(modelForLang('onnx-community/whisper-base.en', 'multi'), 'onnx-community/whisper-base');
  assert.equal(modelForLang('onnx-community/whisper-small.en', 'multi'), 'onnx-community/whisper-small');
  assert.equal(modelForLang('onnx-community/whisper-tiny.en', 'multi'), 'onnx-community/whisper-tiny');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test worker.test.js`
Expected: FAIL on the new test only — `'multi'` is not `'es'`, so the `.en` suffix
survives and the model comes back unchanged. The two existing `modelForLang` tests pass
both before and after step 3.

- [ ] **Step 3: Invert the condition**

In `worker.js`:

```js
// The .en Whisper exports only understand English: a session that is not purely
// English silently transcribing garbage would be worse than a bigger download, so
// the model is swapped for its multilingual sibling instead. Stated as "anything
// but English" rather than "Spanish", so a new session language cannot quietly
// inherit an English-only model.
export function modelForLang(model, lang) {
  return lang === 'en' ? model : String(model).replace(/\.en$/, '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test worker.test.js`
Expected: PASS.

- [ ] **Step 5: Take the language per request**

In `worker.js`, in the `transcribe` branch, replace the language block:

```js
      const opts = { chunk_length_s: 30, return_timestamps: false };
      if (!/\.en$/.test(modelId || '')) {
        // Per request, not per session: in a bilingual meeting consecutive segments
        // are in different languages, and a multilingual model decodes whichever
        // language its token names.
        const lang = msg.lang || sessionLang;
        opts.language = lang === 'es' ? 'spanish' : 'english';
        opts.task = 'transcribe';
      }
```

In `offscreen.js`, `localTranscribe` forwards it. Two lines change — the signature and
the `postMessage` — and the listener is reproduced here so the whole function is in
front of you rather than half-described:

```js
function localTranscribe(audio, lang) {
  return new Promise((resolve, reject) => {
    const id = ++state.seq;
    const worker = ensureWorker();
    const onMsg = (e) => {
      const m = e.data;
      if (m.id !== id) return;
      // Only a terminal message retires the listener. Dropping it before the type
      // is known costs nothing today — the worker sends exactly one result or one
      // error per id — but the day it also sends something non-terminal for this
      // id (a streamed partial, a per-pass progress note), that message would
      // deregister the listener and the real result would land on nobody: the
      // promise never settles, `busy` never clears, and the whole queue stops for
      // the rest of the session. A silent, total stall is too expensive to leave
      // resting on a message shape nobody has any reason to preserve.
      if (m.type !== 'result' && m.type !== 'error') return;
      worker.removeEventListener('message', onMsg);
      if (m.type === 'result') resolve(m.text);
      else reject(new Error(m.message));
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'transcribe', id, audio, lang }, [audio.buffer]);
  });
}
```

and both call sites in `drain` pass the speaker's current language:

```js
    const text = (!seg.preview && state.settings.engine === 'api')
      ? await apiTranscribe(seg.audio)
      : await localTranscribe(seg.audio, state.lang[seg.speaker]);
```

- [ ] **Step 6: Run the full gate, then commit**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
git add worker.js worker.test.js offscreen.js
git commit -m "$(cat <<'EOF'
feat(worker): decode the language the segment was spoken in

modelForLang now strips .en for anything but a purely English session, so
a new session language cannot quietly inherit an English-only model, and
the transcribe message carries the language per request — consecutive
segments of a bilingual meeting are in different languages.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Offer the bilingual session

**Files:**
- Modify: `sidepanel.html` (the `lang` select)
- Modify: `offscreen.js` (`startLiveLayer`)
- Modify: `setup.js` (`liveLang`, `checkLive`)

**Interfaces:**
- Produces: `settings.lang` may now be `'multi'`. `worker.js` (task 7) already loads the multilingual model for it; `coach.js` already treats anything that is not `'es'` as English-teaching mode, which is correct for a bilingual meeting and needs no change here.

- [ ] **Step 1: Add the option**

In `sidepanel.html`, inside `<select id="lang">`:

```html
          <option value="multi">Reunión bilingüe — inglés y español</option>
```

- [ ] **Step 2: Turn Web Speech off for a bilingual session**

One recogniser serves one language, and the preview lane covers both. In `offscreen.js`, at the top of `startLiveLayer`:

```js
async function startLiveLayer(themStream) {
  state.liveHeard = false;
  state.liveSilentMs = 0;
  // A recogniser listens for one language. In a bilingual meeting it would hear
  // half the room and mis-transcribe the other half, so the Whisper preview lane —
  // which decodes whichever language the speaker's turn is in — covers both.
  if (state.settings?.lang === 'multi') {
    broadcast({ type: 'LIVE_STATE', state: 'unavailable', fallback: previewFallback() });
    return;
  }
```

- [ ] **Step 3: Say so in Options**

In `setup.js`, replace `liveLang` and guard `checkLive`:

```js
async function sessionLang() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings.lang || 'en';
}

async function liveLang() {
  return (await sessionLang()) === 'es' ? 'es-ES' : 'en-US';
}
```

and at the top of `checkLive`, before it asks about availability:

```js
  if ((await sessionLang()) === 'multi') {
    el.textContent = 'En una reunión bilingüe la transcripción en vivo la hace Whisper, no el reconocimiento del navegador: un reconocedor sólo escucha un idioma.';
    el.className = 'hint';
    boton.hidden = true;
    return;
  }
```

- [ ] **Step 4: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

In Chrome, after reloading: selecting *Reunión bilingüe* and starting a session downloads the multilingual model (the status says so), the word-by-word notice reports that Whisper is drawing the live line, and Options explains why. Turns are still all labelled with the session default until task 9.

- [ ] **Step 5: Commit**

```bash
git add sidepanel.html offscreen.js setup.js
git commit -m "$(cat <<'EOF'
feat(session): offer a bilingual meeting

Selects the multilingual model and turns the word-by-word lane off, since
one recogniser listens for one language and would mis-transcribe half the
room. Options says why rather than reporting a pack that cannot help.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Let Groq detect the language, and feed the live line from it

Omitting `language` lets Whisper detect it, and `verbose_json` may return the label. Whichever way the label arrives, it becomes that speaker's sticky language — so the next preview, which is decoded locally, is decoded in the right language. The live line converges within one turn of a speaker switching, and no re-transcription is ever needed on this path.

**Files:**
- Modify: `offscreen.js` (`apiTranscribe`, `drain`)

**Interfaces:**
- Consumes: `detect` from `langid.js` (task 2); `state.lang` (task 5).
- Produces: `apiTranscribe(audio)` returns `{ text, lang }` — `lang` is `null` when the response carried no label. It takes no language argument: in a bilingual session the language is the question, and in a single-language session it comes from the setting. `localTranscribe` keeps returning a string; `drain` normalises both.

- [ ] **Step 1: Ask Groq to detect, and to say what it found**

In `offscreen.js`, replace the two `form.append` lines that pin the language and the response format, and the return:

```js
async function apiTranscribe(audio) {
  const key = state.settings.groqKey;
  if (!key) throw new Error('Falta la API key de Groq (ábrela en Ajustes).');
  const multi = state.settings.lang === 'multi';
  const form = new FormData();
  form.append('file', floatToWav(audio), 'audio.wav');
  form.append('model', state.settings.groqModel || 'whisper-large-v3-turbo');
  // In a bilingual meeting the language is the question, not an input: omitting it
  // is what makes Whisper detect it, and it costs nothing extra — the price is per
  // hour of audio either way. A single-language session keeps pinning it, which the
  // API documents as better for accuracy and latency.
  if (!multi) form.append('language', state.settings.lang === 'es' ? 'es' : 'en');
  // verbose_json is where a detected language can come back. It is not promised, so
  // the caller falls back to langid.js.
  form.append('response_format', multi ? 'verbose_json' : 'json');
  const res = await fetch(`${groqBaseOf(state.settings)}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${redact(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const dicho = typeof data.language === 'string' ? data.language.toLowerCase() : '';
  // Whisper names languages in English words ("spanish"), not codes.
  const detectado = /^(es|spa|spanish|castilian|español)$/.test(dicho) ? 'es'
    : /^(en|eng|english|inglés)$/.test(dicho) ? 'en'
    : null;
  return { text: data.text || '', lang: detectado };
}
```

- [ ] **Step 2: Normalise both engines to one shape**

In `drain`, replace the transcription call and the `clean` line:

```js
    const salida = (!seg.preview && state.settings.engine === 'api')
      ? await apiTranscribe(seg.audio)
      : { text: await localTranscribe(seg.audio, state.lang[seg.speaker]), lang: null };
    const clean = (salida.text || '').trim();
```

- [ ] **Step 3: Let an authoritative turn set the speaker's language**

Still in `drain`, in the authoritative branch, immediately before `appendTranscript` is
called:

```js
      // What the engine detected outranks what langid.js reads off the text, and both
      // outrank the sticky value. This is also what the next preview is decoded with,
      // so the live line follows a speaker's switch within one turn.
      const leido = detect(clean);
      const idioma = salida.lang
        || (leido.confidence >= LANG_CONFIDENCE ? leido.lang : null);
      if (idioma) state.lang[seg.speaker] = idioma;
```

The `appendTranscript` call below it already reads `lang: state.lang[seg.speaker]` from
task 5, and that value has just been corrected, so it needs no edit.

Add the import at the top of `offscreen.js`:

```js
import { detect } from './langid.js';
```

and the threshold beside the other constants:

```js
// Below this, langid.js saw mixed evidence — an English sentence carrying a Spanish
// name, say — and switching a speaker's language on that would be worse than
// keeping the one that is working.
const LANG_CONFIDENCE = 0.5;
```

- [ ] **Step 4: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

In Chrome, with the engine set to the Groq API and *Reunión bilingüe* selected: play audio where someone speaks English and someone else answers in Spanish. **Expect** each bubble to be transcribed in its own language and tagged accordingly, the Spanish line to appear only under the English ones, and the live line to be decoded in the right language from the second turn of each speaker onward. In the offscreen document's DevTools, check whether the response carried a `language` field — if it did not, the label came from `langid.js`, which is the documented fallback.

- [ ] **Step 5: Commit**

```bash
git add offscreen.js
git commit -m "$(cat <<'EOF'
feat(offscreen): detect the language of a turn on the API engine

Omitting the language parameter is what makes Whisper detect it, at no
extra cost — the price is per hour of audio either way. Whichever way the
label arrives, from verbose_json or from langid.js, it becomes that
speaker's sticky language, so the locally decoded live line follows a
speaker's switch within one turn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Detect the language locally, with one bounded re-pass

For a learner with no API key there is no authoritative detection to lean on. The turn is transcribed with the speaker's sticky language, `langid.js` reads the result, and a disagreement buys exactly one more pass. The sticky value itself only moves after two consecutive agreements, so one bad pass switches a turn but never flips a speaker.

**Files:**
- Modify: `offscreen.js` (state, `start`, `drain`)

**Interfaces:**
- Consumes: `detect` and `LANG_CONFIDENCE` (task 9); `state.lang` (task 5).
- Produces: `state.langVotes = { them: 0, me: 0 }`, consecutive agreements that the other language is right.

> This task carries the plan's only unverifiable assumption: that Whisper, forced to the wrong language, produces text `langid.js` can flag. If a real session shows it cannot, the spec's §5 names the fallback — probe the first ~2 s in both languages, score both, then transcribe once with the winner. Do not widen this task to cover both; measure first.

- [ ] **Step 1: Add the vote counter**

In `offscreen.js`, in `state`, after `lang`:

```js
  // Consecutive turns whose text disagreed with the language they were decoded in.
  // One disagreement re-transcribes that turn; two in a row move the speaker, so a
  // single bad pass cannot flip someone mid-conversation.
  langVotes: { them: 0, me: 0 },
```

and reset it in `start` beside `state.lang`:

```js
  state.langVotes = { them: 0, me: 0 };
```

- [ ] **Step 2: Keep a copy of the audio before the first pass**

`localTranscribe` transfers the audio buffer to the worker, so `seg.audio` is
neutered the moment the first pass starts. A second pass reading it would receive an
empty buffer and return nothing, silently. In `drain`, immediately after
`state.busyPreview = !!seg.preview;` and before the `try`:

```js
  // The transcription path transfers this buffer to the worker, so a possible second
  // pass needs its own copy taken before the first one leaves. Only real segments can
  // be re-read, so a preview pays nothing for this.
  const respaldo = seg.preview ? null : seg.audio.slice();
```

- [ ] **Step 3: Re-transcribe a turn that reads as the other language**

In `drain`'s authoritative branch, replace the detection block from task 9 with the
full rule:

```js
      // What the engine detected outranks everything; on the local engine there is
      // none, so the text decides.
      let texto = clean;
      let idioma = salida.lang;
      if (!idioma) {
        const leido = detect(clean);
        const otro = state.lang[seg.speaker] === 'es' ? 'en' : 'es';
        if (leido.lang === otro && leido.confidence >= LANG_CONFIDENCE) {
          state.langVotes[seg.speaker]++;
          // One pass, never a loop: if the re-read still disagrees, the first text
          // stands. Losing a turn is worse than labelling one wrongly.
          try {
            const segundo = ((await localTranscribe(respaldo, otro)) || '').trim();
            if (segundo && !isJunk(segundo)) { texto = segundo; idioma = otro; }
          } catch {
            // A failed re-read must not cost the turn: the first pass still stands.
          }
          // Two agreements in a row, and the speaker moves.
          if (state.langVotes[seg.speaker] >= 2) state.lang[seg.speaker] = otro;
        } else {
          state.langVotes[seg.speaker] = 0;
          if (leido.lang && leido.confidence >= LANG_CONFIDENCE) idioma = leido.lang;
        }
      } else {
        state.langVotes[seg.speaker] = 0;
        state.lang[seg.speaker] = idioma;
      }
```

and make the stored entry use the pair this produced:

```js
      await appendTranscript({
        speaker: seg.speaker,
        text: texto,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
        lang: idioma || state.lang[seg.speaker],
      });
```

- [ ] **Step 4: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

In Chrome, with the engine local and *Reunión bilingüe* selected: play the same bilingual audio as in task 9. **Expect** each turn to end up in its own language, at the cost of one extra local pass on the turns where the language changed. In the offscreen document's DevTools, confirm that a re-pass happens on a switch and **not** on every turn — if it fires constantly, `langid.js` is disagreeing with correctly decoded text and the threshold needs measuring, not raising by guess.

- [ ] **Step 5: Commit**

```bash
git add offscreen.js
git commit -m "$(cat <<'EOF'
feat(offscreen): detect the language locally with one bounded re-pass

Whisper needs a language before it decodes, so on the local engine the
circle is broken after the fact: langid.js reads the result and a
disagreement buys exactly one more pass. Two consecutive disagreements
move the speaker, so a single bad pass switches a turn but never flips
someone mid-conversation. The audio is copied before the first pass —
its buffer is transferred to the worker and would be empty on the second.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## What this plan does not cover

**Phase 4 of the spec — Claude as the primary coach provider (§7 b–f)** — is deliberately absent, except for §7(a), which is task 1 because without it a learner who selects Claude today gets truncated answers.

The rest of §7 gets its own plan after task 9 lands, for the reason the spec gives: the bilingual prompt work (turns reaching the model labelled with their language, the report grading only the learner's English turns, the reply answering in the language of the latest `them` turn) cannot be tuned against a conversation the extension cannot yet record. That plan will cover structured outputs on the Claude path, the `stop_reason` guards for refusal and truncation, server-side fallbacks, and the model list — with the Haiku id confirmed against the Models API rather than edited on the strength of a document.
