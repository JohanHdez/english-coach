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
  const sessionLang = settings.lang === 'es' ? 'es' : 'en';
  state.lang = { them: sessionLang, me: sessionLang };
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
  state.stitchLang = { them: sessionLang, me: sessionLang };
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

and inside `checkLive`, **after** its existing `const el = $('liveStatus');` and
`const boton = $('installLive');` lines and **before** `const estado = …` — both names are
used by the guard, so placing it above their declarations would throw:

```js
  if ((await sessionLang()) === 'multi') {
    el.textContent = 'En una reunión bilingüe la transcripción en vivo la hace Whisper, no el reconocimiento del navegador: un reconocedor sólo escucha un idioma.';
    el.className = 'hint';
    boton.hidden = true;
    return;
  }
```

- [ ] **Step 3b: The overlay's session-wide translation flag stops encoding the session language**

Task 6 made translation a per-turn decision in both views (`langOf(turn) !== 'es'`), but a freshly injected overlay still learns whether translation is on at all from `UI_SYNC`, and `background.js` computes that as `settings.translate !== false && settings.lang !== 'es'`. In a bilingual session the clause is harmless (`'multi' !== 'es'`), but once a turn can carry a language of its own (Task 9), an English turn in a Spanish-configured session would be translated by the side panel and not by the overlay. One definition of "translation is on": in `background.js`, in the `UI_SYNC` reply, replace

```js
            translate: settings.translate !== false && settings.lang !== 'es',
```
with
```js
            // Whether translation is on at all; which turns get one is decided per
            // turn by the views (a Spanish turn never does), not by the session.
            translate: settings.translate !== false,
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
git add sidepanel.html offscreen.js setup.js background.js
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
  const reported = typeof data.language === 'string' ? data.language.toLowerCase() : '';
  // Whisper names languages in English words ("spanish"), not codes.
  const detected = /^(es|spa|spanish|castilian|español)$/.test(reported) ? 'es'
    : /^(en|eng|english|inglés)$/.test(reported) ? 'en'
    : null;
  return { text: data.text || '', lang: detected };
}
```

- [ ] **Step 2: Normalise both engines to one shape**

In `drain`, replace the transcription call and the `clean` line:

```js
    const result = (!seg.preview && state.settings.engine === 'api')
      ? await apiTranscribe(seg.audio)
      : { text: await localTranscribe(seg.audio, state.lang[seg.speaker]), lang: null };
    const clean = (result.text || '').trim();
```

- [ ] **Step 3: Let an authoritative turn set the speaker's language**

Still in `drain`, in the authoritative branch, immediately before `appendTranscript` is
called:

```js
      // What the engine detected outranks what langid.js reads off the text, and both
      // outrank the sticky value. This is also what the next preview is decoded with,
      // so the live line follows a speaker's switch within one turn.
      const read = detect(clean);
      const turnLang = result.lang
        || (read.confidence >= LANG_CONFIDENCE ? read.lang : null);
      if (turnLang) state.lang[seg.speaker] = turnLang;
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
  const backup = seg.preview ? null : seg.audio.slice();
```

- [ ] **Step 3: Re-transcribe a turn that reads as the other language**

In `drain`'s authoritative branch, replace the detection block from task 9 with the
full rule:

```js
      // What the engine detected outranks everything; on the local engine there is
      // none, so the text decides.
      let turnText = clean;
      let turnLang = result.lang;
      if (!turnLang) {
        const read = detect(clean);
        const other = state.lang[seg.speaker] === 'es' ? 'en' : 'es';
        if (read.lang === other && read.confidence >= LANG_CONFIDENCE) {
          state.langVotes[seg.speaker]++;
          // One pass, never a loop: if the re-read still disagrees, the first text
          // stands. Losing a turn is worse than labelling one wrongly.
          try {
            const second = ((await localTranscribe(backup, other)) || '').trim();
            if (second && !isJunk(second)) { turnText = second; turnLang = other; }
          } catch {
            // A failed re-read must not cost the turn: the first pass still stands.
          }
          // Two agreements in a row, and the speaker moves.
          if (state.langVotes[seg.speaker] >= 2) state.lang[seg.speaker] = other;
        } else {
          state.langVotes[seg.speaker] = 0;
          if (read.lang && read.confidence >= LANG_CONFIDENCE) turnLang = read.lang;
        }
      } else {
        state.langVotes[seg.speaker] = 0;
        state.lang[seg.speaker] = turnLang;
      }
```

and make the stored entry use the pair this produced:

```js
      await appendTranscript({
        speaker: seg.speaker,
        text: turnText,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
        lang: turnLang || state.lang[seg.speaker],
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

## Task 11: Two lanes, two resources — the network never waits for the GPU

Measured on 2026-09-19 with the end-to-end harness (`node e2e/run.mjs english --engine=api`, Groq stand-in at 900 ms per request, this Mac's Intel GPU): a preview pass costs about 1 s, and in two of three turns the authoritative segment waited ~0.9 s for the preview in flight before its request even left. The queue is serial — one `busy` flag — although a Whisper pass on the GPU and an HTTP request to Groq are independent resources. On the API engine that coupling is pure loss in both directions: turns wait for previews, and previews (the live line) wait for the network. This task gives each resource its own lane. The local engine keeps one lane, because there the model is the only resource.

A second defect the coupling hid: once the two run concurrently, a preview that was in flight when its turn landed can finish after it and repaint the line the turn just replaced. Each speaker remembers the last authoritative piece, and a preview of that piece or an older one is dropped.

**Files:**
- Modify: `queue.js` (a `takeNext` helper), `queue.test.js`
- Modify: `offscreen.js` (`state`, `pendingCount`, `queueIdle`, `drain`, the model init in `start`)

**Interfaces:**
- Produces: `takeNext(queue, wants)` in `queue.js` — removes and returns the first segment `wants` accepts, or `null`. `state.inFlight = { local, api }`, the segment each lane is working on. `state.realDone = { them, me }`, the `startedAt` of the last authoritative segment finished per speaker.
- Consumes: `insertPreview` / `insertReal` unchanged — ordering policy stays in `queue.js`; this task only changes who takes from the queue.

- [ ] **Step 1: Write the failing tests**

Append to `queue.test.js`:

```js
import { takeNext } from './queue.js';

test('takeNext removes and returns the first segment the lane wants, leaving the rest in order', () => {
  const queue = [
    { speaker: 'them', preview: true, id: 1 },
    { speaker: 'me', id: 2 },
    { speaker: 'them', preview: true, id: 3 },
    { speaker: 'them', id: 4 },
  ];
  const real = takeNext(queue, (s) => !s.preview);
  assert.equal(real.id, 2);
  assert.deepEqual(queue.map((s) => s.id), [1, 3, 4]);
  const preview = takeNext(queue, (s) => s.preview);
  assert.equal(preview.id, 1);
  assert.deepEqual(queue.map((s) => s.id), [3, 4]);
});

test('takeNext returns null when nothing in the queue is for that lane', () => {
  const queue = [{ speaker: 'them', preview: true, id: 1 }];
  assert.equal(takeNext(queue, (s) => !s.preview), null);
  assert.equal(queue.length, 1);
});
```

(`queue.test.js` already imports `test` and `assert`; merge the `takeNext` import into its existing `./queue.js` import line.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test queue.test.js`
Expected: FAIL — `takeNext` is not exported.

- [ ] **Step 3: The helper**

Append to `queue.js`:

```js
// Each lane takes the first segment that is its to transcribe and leaves the
// others where they are, so two lanes draining the same queue never reorder it.
export function takeNext(queue, wants) {
  const i = queue.findIndex(wants);
  return i < 0 ? null : queue.splice(i, 1)[0];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test queue.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Two lanes in the offscreen document**

In `offscreen.js`, import the helper:

```js
import { insertPreview, insertReal, takeNext } from './queue.js';
```

In `state`, replace `busy: false,` and `busyPreview: false,` with:

```js
  // One segment in flight per resource. A Whisper pass on the GPU and a request to
  // Groq do not wait on each other, so on the API engine the archive and the live
  // line each get their own lane; on the local engine both are the same lane.
  inFlight: { local: null, api: null },
  // The startedAt of the last authoritative piece finished per speaker. With two
  // lanes a preview of that piece can land after its turn did, and it would repaint
  // the line the turn just cleared.
  realDone: { them: 0, me: 0 },
```

Reset both in `start()` beside the other per-session resets:

```js
  state.inFlight = { local: null, api: null };
  state.realDone = { them: 0, me: 0 };
```

Replace `pendingCount`, `queueIdle` and `drain` (the whole function, from `async function drain()` to its closing brace) with:

```js
// Previews are invisible work: counting them would flash "Transcribiendo…" in
// both interfaces every second while the other person is still speaking.
const pendingCount = () =>
  state.queue.filter((s) => !s.preview).length
  + Object.values(state.inFlight).filter((s) => s && !s.preview).length;

const queueIdle = () => state.queue.length === 0 && !state.inFlight.local && !state.inFlight.api;

// Which resource transcribes a segment: previews are local on every engine, and
// authoritative turns go to the network on the API engine.
const laneOf = (seg) => (!seg.preview && (state.settings || {}).engine === 'api' ? 'api' : 'local');

function drain() {
  for (const lane of ['local', 'api']) {
    if (state.inFlight[lane]) continue;
    const seg = takeNext(state.queue, (s) => laneOf(s) === lane);
    if (!seg) continue;
    state.inFlight[lane] = seg;
    transcribe(seg, lane);
  }
}

async function transcribe(seg, lane) {
  const startedAt = Date.now();
  try {
    const text = lane === 'api' ? await apiTranscribe(seg.audio) : await localTranscribe(seg.audio);
    const clean = (text || '').trim();
    if (seg.preview) {
      // Consecutive rounds, which is what the constant has always claimed. Counting
      // cumulatively meant two slow passes twenty minutes apart retired the lane.
      if (Date.now() - startedAt > PREVIEW_MAX_MS) {
        if (++state.previewSlow[seg.speaker] >= PREVIEW_SLOW_ROUNDS) {
          state.previewOff[seg.speaker] = true;
          if (!anyLiveLaneLeft()) broadcast({ type: 'LIVE_STATE', state: 'slow', fallback: false });
        }
      } else {
        state.previewSlow[seg.speaker] = 0;
      }
      // Provisional only: displayed, never stored, never given to the coach.
      // Successive passes are overlapping re-transcriptions of the same speech, not
      // pieces to swap in. Stitched, the line grows and only its tail can change.
      // Not while paused: a pass that was in flight when the pause landed would
      // otherwise repaint the line pause() just blanked. Not for a piece whose turn
      // already landed: the other lane got there first.
      if (state.running && !state.paused && !isJunk(clean)
        && seg.startedAt > state.realDone[seg.speaker]) {
        if (state.pieceStart[seg.speaker] !== seg.startedAt) {
          // First preview of a new piece: start from nothing, or it inherits the
          // previous piece's committed prefix.
          state.stitch[seg.speaker] = STITCH_EMPTY;
          state.pieceStart[seg.speaker] = seg.startedAt;
        }
        const out = stitch(state.stitch[seg.speaker], clean);
        state.stitch[seg.speaker] = out.state;
        broadcast({
          type: 'PARTIAL',
          speaker: seg.speaker,
          text: `${out.committed} ${out.tail}`.trim(),
          committed: out.committed,
        });
      }
    } else if (!isJunk(clean)) {
      if (seg.speaker === 'them' && state.live && !state.liveHeard) {
        state.liveSilentMs += seg.durationMs || 0;
        if (state.liveSilentMs >= LIVE_PROOF_MS) retireSilentLiveLayer();
      }
      await appendTranscript({
        speaker: seg.speaker,
        text: clean,
        t: seg.startedAt,
        dur: Math.round(seg.durationMs / 100) / 10,
      });
      // An open cut means the speaker never paused: their line stays on screen and
      // the next piece's preview replaces it. Web Speech is the exception — its
      // accumulated results now live in the bubble, and without a reset the line
      // would repeat them and keep growing for the rest of the monologue.
      if (!seg.open || (seg.speaker === 'them' && state.live)) clearPartial(seg.speaker);
    } else if (!seg.open) {
      // A discarded closing turn also clears the provisional line: otherwise it
      // stays frozen on screen until that speaker talks again.
      clearPartial(seg.speaker);
    }
    if (!seg.preview) state.realDone[seg.speaker] = Math.max(state.realDone[seg.speaker], seg.startedAt);
  } catch (e) {
    // A failed preview stays silent: the real segment reports the same problem
    // a moment later, and one toast per second would bury it.
    if (!seg.preview) status('Error transcribiendo: ' + (e.message || e), 'error');
  } finally {
    state.inFlight[lane] = null;
    broadcast({ type: 'QUEUE', pending: pendingCount() });
    drain();
  }
}
```

If Task 4's fix round or Tasks 5–10 have already changed lines inside this function (the `lang` field on `PARTIAL` and on the stored entry, `localTranscribe(seg.audio, state.lang[seg.speaker])`, the detection block before `appendTranscript`), keep those changes: this task moves the body into `transcribe(seg, lane)` and adds the `realDone` guard and assignment; it does not undo anything the other tasks put there. State so in the report.

- [ ] **Step 6: The live line is the only reason the API engine loads a model**

In `start()`, the model init block runs on both engines since Task 4. Wrap it so the API engine skips the download when the live line is switched off — that setting is the one way a learner says they do not want the lane, and the model would only ever draw it:

```js
  if (settings.engine !== 'api' || settings.liveTranscript !== false) {
    // …the existing status(...) and ensureWorker().postMessage({ type: 'init', … }) block, unchanged…
  }
```

Keep whatever `ok` status Task 4's fix round emits for the API engine outside that guard, so a Groq session without a live line still reports that it is listening.

- [ ] **Step 7: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing; the one `langid.js` dead-code warning if Task 9 has not landed yet, otherwise 0 warnings; 0 fail.

End to end (the controller runs these; the implementer does not launch Chrome):
`node e2e/run.mjs english --engine=api` — every turn's "bubble after end" within ~0.3 s of the stand-in's delay (900 ms) plus the closing silence, none of them waiting a full preview pass; `node e2e/run.mjs english --engine=api --delay=3000` — the live line for the next sentence keeps appearing while a request is in flight; `node e2e/run.mjs english` — the local engine unchanged.

- [ ] **Step 8: Commit**

```bash
git add queue.js queue.test.js offscreen.js
git commit -m "$(cat <<'EOF'
perf(offscreen): give the network its own lane

A Whisper pass on the GPU and a request to Groq are independent
resources, but one serial queue made each wait for the other: measured
end to end, a turn on the API engine waited a full preview pass before
its request left, and the live line stalled while the request was out.
Each lane now drains on its own, and a preview that outlives its turn is
dropped instead of repainting the line the turn just replaced.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: A monologue reaches its bubble in eight seconds, not eighteen

`MAX_SEG_MS` is 18 s. A speaker who never dips below `SOFT_SILENCE_MS` for that long — a fast reader, a noisy line — produces one 18 s segment that only starts transcribing when it ends. `foldIntoTranscript` merges consecutive pieces of one speaker into one bubble, so the cut has no visible cost: the bubble grows in pieces instead of arriving whole and late.

**Files:**
- Modify: `segmenter.js` (`MAX_SEG_MS`), `segmenter.test.js`

- [ ] **Step 1: Write the failing test**

Append to `segmenter.test.js`, using its existing `run(pattern)` helper (ambient noise first, then `[amplitude, blocks]` pairs, a closing `flush()` at the end — so the last piece is the closed one):

```js
test('a speaker who never dips streams out in pieces of at most eight seconds', () => {
  const segs = run([[VOICE, 200]]);   // 20 s without a single breath dip
  assert.ok(segs.length >= 3, `expected forced cuts every eight seconds, got ${segs.length} pieces`);
  for (const s of segs) assert.ok(s.durationMs <= 8000, `a piece lasted ${s.durationMs} ms`);
  for (const s of segs.slice(0, -1)) assert.ok(s.open, 'a forced cut is an open cut');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test segmenter.test.js`
Expected: FAIL — two pieces (18 s and 2 s), the first far over 8 000 ms.

- [ ] **Step 3: Lower the ceiling**

In `segmenter.js`:

```js
// Forced cut. A speaker who never dips below SOFT_SILENCE_MS would otherwise hold
// one segment for this long and see nothing of it until it ends. Pieces fold into
// one bubble downstream (foldIntoTranscript), so a shorter ceiling costs nothing on
// screen — it only bounds how late the first words of a monologue can be.
export const MAX_SEG_MS = 8000;
```

- [ ] **Step 4: Run the tests to verify they pass, then the full gate**

```bash
node --test segmenter.test.js
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: PASS; 0 failing; 0 fail. Check the existing segmenter tests: any that assumed an 18 s ceiling must be updated to the value's meaning, not deleted.

- [ ] **Step 5: Commit**

```bash
git add segmenter.js segmenter.test.js
git commit -m "$(cat <<'EOF'
perf(segmenter): cut a monologue every eight seconds at most

Eighteen seconds without a breath dip meant eighteen seconds without a
bubble. Pieces fold into one turn downstream, so the shorter ceiling
changes nothing on screen except how soon the first words land.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Add a note or update the profile without leaving the conversation

The user's request of 2026-09-19: notes and the personal profile "can change at any moment", so they must be addable during a session, not only in Options. "Contexto de hoy" already is: the side panel keeps its textarea enabled mid-session and the offscreen document re-reads settings on every coach call, so an edit reaches the next suggested reply with no protocol change. This task gives notes and the profile the same path in the side panel (and the floating window, which is the same page). The page overlay is Task 14.

**Files:**
- Modify: `phrasebook.js` (`addNote`), `phrasebook.test.js`
- Modify: `sidepanel.html`, `sidepanel.css`, `sidepanel.js`

**Interfaces:**
- Produces: `addNote(settings, { title, body })` in `phrasebook.js` — pure; returns the same object untouched when the note is empty or the cap is reached, otherwise a new settings object with the note appended, opened, and every other note closed. Task 14's `ADD_NOTE` handler reuses it.
- Consumes: `NOTE_TITLE_MAX`, `NOTE_BODY_MAX`, `MAX_NOTES`, `clamp` (all in `phrasebook.js`); `PROFILE_MAX_CHARS` from `coach.js`; `storage.onChanged` in `background.js`, which already re-broadcasts `COACH_CHIPS` when `settings.notes` changes.

- [ ] **Step 1: Write the failing tests**

Append to `phrasebook.test.js` (add `addNote`, `MAX_NOTES`, `NOTE_TITLE_MAX`, `NOTE_BODY_MAX` to its existing `./phrasebook.js` import if they are not there yet):

```js
test('addNote appends an open note and closes the others', () => {
  const before = { notes: [{ id: 'n.1', title: 'Daily', body: 'x', open: true }] };
  const after = addNote(before, { title: 'Salary', body: 'Ask about the band.' });
  assert.equal(after.notes.length, 2);
  assert.equal(after.notes[0].open, false);
  assert.deepEqual({ title: after.notes[1].title, body: after.notes[1].body, open: after.notes[1].open },
    { title: 'Salary', body: 'Ask about the band.', open: true });
  assert.ok(after.notes[1].id.startsWith('n.'));
  assert.notEqual(after, before);
  assert.equal(before.notes.length, 1, 'the input is not mutated');
});

test('addNote ignores an empty note and returns the same settings object', () => {
  const before = { notes: [] };
  assert.equal(addNote(before, { title: '   ', body: '' }), before);
});

test('addNote respects the cap and clamps the lengths', () => {
  const full = { notes: Array.from({ length: MAX_NOTES }, (_, i) => ({ id: `n.${i}`, title: 't', body: 'b', open: false })) };
  assert.equal(addNote(full, { title: 'one more', body: '' }), full);
  const long = addNote({ notes: [] }, { title: 'x'.repeat(NOTE_TITLE_MAX + 5), body: 'y'.repeat(NOTE_BODY_MAX + 5) });
  assert.equal(long.notes[0].title.length, NOTE_TITLE_MAX);
  assert.equal(long.notes[0].body.length, NOTE_BODY_MAX);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test phrasebook.test.js`
Expected: FAIL — `addNote` is not exported.

- [ ] **Step 3: The helper**

In `phrasebook.js`, after `toggleNoteOpen`:

```js
// Adding a note mid-conversation is a settings write like toggling one, from the
// same two contexts, so it lives here for the same reason. The new note opens and
// the others close: a note written while someone waits is wanted on screen now,
// and one open note at a time is the rule toggleNoteOpen already keeps.
export function addNote(settings = {}, { title, body } = {}) {
  const notes = Array.isArray(settings.notes) ? settings.notes : [];
  const t = clamp(title, NOTE_TITLE_MAX);
  const b = clamp(body, NOTE_BODY_MAX);
  if (!t && !b) return settings;
  if (notes.length >= MAX_NOTES) return settings;
  const note = { id: 'n.' + Date.now(), title: t, body: b, open: true };
  return { ...settings, notes: [...notes.map((n) => (n ? { ...n, open: false } : n)), note] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test phrasebook.test.js`
Expected: PASS.

- [ ] **Step 5: The side panel — a note form behind the Notas tab, a profile field under the context**

In `sidepanel.html`, inside `<div id="notesPane" class="pane" hidden>` after `<div id="notes" class="note-list"></div>`:

```html
        <details id="noteAdd" class="note-add">
          <summary>＋ Añadir nota</summary>
          <form id="noteForm" class="note-form">
            <input id="noteTitle" type="text" placeholder="Título corto" />
            <textarea id="noteBody" rows="3" placeholder="Lo que quieras tener a mano ahora mismo"></textarea>
            <button id="noteSave" class="small primary" type="submit">Guardar nota</button>
          </form>
        </details>
```

and in the controls section, right after the `sessionContext` field:

```html
      <details class="field more" id="profileMore">
        <summary>Mi perfil <span class="hint">· lo que el coach sabe de ti</span></summary>
        <textarea id="profile" rows="3" placeholder="8 años con Angular. Migré la plataforma de pagos…"></textarea>
      </details>
```

In `sidepanel.css`, after the `.note-body` rule:

```css
/* Adding a note mid-conversation: folded until wanted, so the list keeps its room. */
.note-add { margin-top: 8px; }
.note-add > summary { cursor: pointer; font-size: 12px; color: var(--muted); list-style: none; }
.note-add > summary::-webkit-details-marker { display: none; }
.note-form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.note-form input, .note-form textarea { width: 100%; box-sizing: border-box; }
details.field.more > summary { cursor: pointer; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; list-style: none; }
details.field.more > summary::-webkit-details-marker { display: none; }
details.field.more[open] > summary { margin-bottom: 4px; }
```

In `sidepanel.js`:

1. Imports: add `PROFILE_MAX_CHARS` to the `./coach.js` import and `addNote, NOTE_TITLE_MAX, NOTE_BODY_MAX` to the `./phrasebook.js` import that brings `resolveChips, toggleNoteOpen`.
2. `els`: add `profile: $('profile'), noteAdd: $('noteAdd'), noteForm: $('noteForm'), noteTitle: $('noteTitle'), noteBody: $('noteBody'),`.
3. Right after the `els` declaration, the limits the HTML cannot import:

```js
els.noteTitle.maxLength = NOTE_TITLE_MAX;
els.noteBody.maxLength = NOTE_BODY_MAX;
els.profile.maxLength = PROFILE_MAX_CHARS;
```

4. In `renderCoach`, the Notas tab is no longer a dead end when empty — there is a form behind it. Replace

```js
  els.tabNotes.hidden = !notes.length;
```
with
```js
  els.tabNotes.hidden = false;
```
and delete the line `if (tab === 'notes' && !notes.length) tab = 'phrases';` (keep the phrases→notes fall-through above it). Leave `syncCoach` as it is: the coach card still needs a lane or a running session to show at all.

5. `saveUi`: add `profile: els.profile.value.trim().slice(0, PROFILE_MAX_CHARS),` beside `sessionContext`. In `init()`, after `els.sessionContext.value = …`, add `els.profile.value = settings.profile || '';`.
6. Events, beside the `sessionContext` listener (same reason it stays enabled mid-session):

```js
els.profile.addEventListener('change', saveUi);

els.noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  const next = addNote(stored, { title: els.noteTitle.value, body: els.noteBody.value });
  if (next === stored) return;
  await chrome.storage.local.set({ settings: next });
  els.noteForm.reset();
  els.noteAdd.open = false;
  // No re-render here: the write trips storage.onChanged in background.js, which
  // re-broadcasts COACH_CHIPS to every view, this one included.
});
```

- [ ] **Step 6: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing (the `langid.js` warning only if Task 9 has not landed); 0 fail.

End to end (controller): with a session running, submit the form from the side panel page and expect a `COACH_CHIPS` broadcast whose `notes` carries the new note, open, and the older ones closed; set the profile field and expect `settings.profile` in storage to change without the session stopping.

- [ ] **Step 7: Commit**

```bash
git add phrasebook.js phrasebook.test.js sidepanel.html sidepanel.css sidepanel.js
git commit -m "$(cat <<'EOF'
feat(sidepanel): add a note or edit the profile mid-conversation

Notes and the profile change while the conversation happens — an
interviewer names a topic, a fact comes back — and Options is the wrong
place to be while someone waits. Both now save from the side panel the
way the context already did; the offscreen document re-reads settings on
every coach call, so the next suggested reply sees them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: The same note form in the page overlay

The overlay is where the learner looks during a Meet call. It is a content script with no `chrome.storage`, so the note travels through the service worker, the way `TOGGLE_NOTE` does.

**Files:**
- Modify: `.claude/skills/message-contract/SKILL.md` — **first**
- Modify: `background.js` (`ADD_NOTE`), `overlay.js` (markup, CSS block, handler)

**Interfaces:**
- Produces: `ADD_NOTE` (overlay → background): `{ title, body }`; reply `{ ok }`. The write trips `storage.onChanged`, which re-broadcasts `COACH_CHIPS`; the overlay does not re-render itself.
- Consumes: `addNote` from Task 13.

- [ ] **Step 1: Document the message first**

In `.claude/skills/message-contract/SKILL.md`, beside the `TOGGLE_NOTE` row, add `ADD_NOTE`: sent by `overlay.js` to `background`, payload `title` and `body` (strings; the service worker clamps them with `addNote`), reply `{ ok }`; the storage write re-broadcasts `COACH_CHIPS`, so no view re-renders on its own.

- [ ] **Step 2: The handler**

In `background.js`, import `addNote` beside `resolveChips, toggleNoteOpen`, and after the `TOGGLE_NOTE` case:

```js
        // Same shape as TOGGLE_NOTE: only the write happens here.
        case 'ADD_NOTE': {
          const { settings = {} } = await chrome.storage.local.get('settings');
          await chrome.storage.local.set({ settings: addNote(settings, { title: msg.title, body: msg.body }) });
          sendResponse({ ok: true });
          break;
        }
```

- [ ] **Step 3: The overlay**

In `overlay.js`, in the static card markup, replace

```html
          <div class="pane notes-pane" hidden>
            <div class="note-list"></div>
          </div>
```
with
```html
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
```

In its CSS block, after the `.note-body` rule:

```css
    .note-add { margin-top: 8px; }
    .note-add > summary { cursor: pointer; font-size: 12px; color: #9aa0a6; list-style: none; }
    .note-add > summary::-webkit-details-marker { display: none; }
    .note-form { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .note-form input, .note-form textarea { width: 100%; box-sizing: border-box; background: #1a1d21; color: #e8eaed; border: 1px solid #2c3038; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; }
    .note-save { align-self: flex-start; }
```

In `renderCoach`, the Notas tab is no longer hidden when there are no notes (there is a form behind it): replace `$('.tab-notes').hidden = !notes.length;` with `$('.tab-notes').hidden = false;` and delete the line `if (tab === 'notes' && !notes.length) tab = 'phrases';`. Leave `syncCoach` alone.

Beside the tab click handlers:

```js
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
```

The overlay's `$` helper resolves inside the shadow root, as every other selector in the file does; use it, not `document`.

- [ ] **Step 4: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing (preflight checks `ADD_NOTE` is both sent and handled); 0 fail.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/message-contract/SKILL.md background.js overlay.js
git commit -m "$(cat <<'EOF'
feat(overlay): add a note from the page during the call

The overlay is what the learner watches in a meeting, and it has no
storage of its own, so the note goes through the service worker the way
a toggle does and comes back to every view as COACH_CHIPS.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: The words after a forced cut are never thrown away

Found by Task 12's review and reproduced against the real `Segmenter`: a forced cut at `MAX_SEG_MS` closes a piece and the phrase continues into a new one. If the speaker stops within the next 100–400 ms, the remainder has fewer than `MIN_VOICED` voiced blocks, and `flush()` discards it as a lone noise blip — the last words of the sentence never reach a transcript. That rule exists for stray sounds between phrases, not for the tail of a phrase the segmenter itself cut in two. At 18 s the window was rare; at 8 s it is routine.

**Files:**
- Modify: `segmenter.js` (`flush`), `segmenter.test.js`

**Interfaces:**
- Produces: a piece that continues a cut phrase is emitted whenever it holds any voiced block at all, regardless of `minSegMs` and `minVoiced`. Pieces that begin at a real onset keep both rules.

- [ ] **Step 1: Write the failing test**

Append to `segmenter.test.js` (it has `run(pattern)`, `VOICE`, `QUIET`, `CHUNK_MS`, `MAX_SEG_MS`, `MIN_VOICED`, `PREROLL`):

```js
test('the words after a forced cut are emitted, however few', () => {
  // Enough voice for exactly one forced cut, then MIN_VOICED - 1 more blocks of
  // speech before a real pause: the tail is short, but it is the end of a phrase
  // the segmenter itself cut, not a stray sound.
  const blocks = MAX_SEG_MS / CHUNK_MS - PREROLL + (MIN_VOICED - 1);
  const segs = run([[VOICE, blocks], [QUIET, 12]]);
  assert.equal(segs.length, 2, `expected the cut piece and its tail, got ${segs.length}`);
  assert.equal(segs[0].open, true);
  assert.equal(segs[1].open, false);
  assert.ok(segs[1].durationMs > 0);
});

test('a lone blip between phrases is still discarded', () => {
  const segs = run([[VOICE, MIN_VOICED - 1], [QUIET, 12]]);
  assert.equal(segs.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test segmenter.test.js`
Expected: the first new test FAILS (one piece — the tail was discarded); the second passes already and pins the rule that must survive.

- [ ] **Step 3: Remember that a piece continues a cut phrase**

In `segmenter.js`, in the constructor beside `this.active = false;`:

```js
    // Whether the current piece continues a phrase a cut split, rather than
    // starting at a real onset. The minimum-length rules exist for stray sounds
    // between phrases; the tail of a phrase the segmenter itself cut is speech.
    this.continued = false;
```

In `push`, where a phrase starts (`this.active = true;`), add `this.continued = false;`.

In `flush`, capture the flag with the other locals and set it on the way out:

```js
    const voiced = this.voicedCount;
    const continued = this.continued;
    this.chunks = [];
    this.voicedCount = 0;
    this.lastPreviewAt = null;
    if (keepActive) {
      this.startedAt = this.now();
      this.continued = true;
    } else {
      this.active = false;
      this.pre = [];
      this.silence = 0;
      this.continued = false;
    }

    if (continued ? voiced === 0 : (durationMs < this.minSegMs || voiced < this.minVoiced)) return;
```

(the two existing comments inside `flush` stay where they are; only the lines shown change).

- [ ] **Step 4: Run the tests to verify they pass, then the full gate**

```bash
node --test segmenter.test.js
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: PASS; 0 failing; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add segmenter.js segmenter.test.js
git commit -m "$(cat <<'EOF'
fix(segmenter): keep the words after a forced cut

The minimum-length rules drop stray sounds between phrases. The tail of
a phrase the segmenter itself cut in two is not a stray sound, and at an
eight-second ceiling a speaker stops inside that window often enough
that the last words of a sentence were vanishing without a trace.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: The model names the language itself — on every local pass

Task 10's premise was measured false on 2026-09-19 (`node e2e/run.mjs bilingual --lang=multi`, local engine, whisper-base multilingual): forced to English, Whisper does not produce text `langid.js` can flag — it produces a fluent English *translation* of the Spanish sentence ("Of course, with pleasure, we migrate the platform of pay…"), so the text reads as English, no re-pass fires, and every Spanish turn lands labelled `en`. The live line has the same problem one turn earlier.

Whisper detects language natively: the first token it emits after `<|startoftranscript|>` is the language token. The vendored transformers.js does not expose that through the pipeline (with no `language` it warns and forces English), but its `generate()` takes `decoder_input_ids` and honours a precomputed `encoder_outputs`, so one encoder pass can serve both the one-step detection and the transcription. Detection therefore costs one decoder step, and it can run on **every** local pass in a bilingual session — previews included — so the live line is decoded in the right language from its first paint, with no per-speaker lag. The API engine keeps Groq's own label for turns (Task 9); its previews are local and detect the same way.

This task replaces Task 10's re-pass and vote logic, and gates the `langid.js` text fallback on bilingual sessions (Task 9's review: in a pinned session there is no question to answer, and a one-word turn scores 1.0).

**Files:**
- Modify: `worker.js` (`transcribe` handler; a `detectAndTranscribe` path), `worker.test.js` (the pure helper's tests)
- Modify: `offscreen.js` (`localTranscribe`, `transcribe`, `state`, `start`)

**Interfaces:**
- Produces: worker `transcribe` message accepts `detect: true`; the `result` message carries `lang` (`'en'` | `'es'` | `null`). `localTranscribe(audio, lang, detect)` resolves `{ text, lang }`. Pure helper `langFromToken(lang_to_id, tokenId)` in `worker.js` → `'en'`, `'es'`, or `null` for any other language (English and Spanish are the only languages in scope; another token means "no evidence", not a third language).
- Consumes: `transcriber.model`, `.processor`, `.tokenizer` (the pipeline object exposes all three); `model.generation_config` (`decoder_start_token_id`, `lang_to_id`, `is_multilingual`); `model._prepare_encoder_decoder_kwargs_for_generation(...)` (vendored, fixed version — its return is the model inputs plus `encoder_outputs`).

- [ ] **Step 1: Write the failing tests**

Append to `worker.test.js` (add `langFromToken` to its `./worker.js` import):

```js
test('langFromToken maps the two languages in scope and nothing else', () => {
  const lang_to_id = { '<|en|>': 50259, '<|es|>': 50262, '<|fr|>': 50265 };
  assert.equal(langFromToken(lang_to_id, 50259), 'en');
  assert.equal(langFromToken(lang_to_id, 50262), 'es');
  // A third language is no evidence for either of the two the product knows.
  assert.equal(langFromToken(lang_to_id, 50265), null);
  assert.equal(langFromToken(lang_to_id, 1), null);
  assert.equal(langFromToken(null, 50259), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test worker.test.js`
Expected: FAIL — `langFromToken` is not exported.

- [ ] **Step 3: The helper, then the detection path**

In `worker.js`, beside `modelForLang`:

```js
// The language token Whisper emits first, read back through the model's own table.
// Only the two languages in scope count: any other token is "no evidence", so the
// caller keeps the language it had rather than adopting one the product cannot show.
export function langFromToken(lang_to_id, tokenId) {
  if (!lang_to_id) return null;
  for (const [token, id] of Object.entries(lang_to_id)) {
    if (id === tokenId) return token === '<|en|>' ? 'en' : token === '<|es|>' ? 'es' : null;
  }
  return null;
}
```

Then, still in `worker.js`, a path the pipeline does not offer. Read the vendored `generate()` (`WhisperForConditionalGeneration.generate` and the generic `generate` above it, around the `_prepare_encoder_decoder_kwargs_for_generation` call) before writing it; the sketch below is the design, and the vendored file is the truth:

```js
const WHISPER_NAME = { en: 'english', es: 'spanish' };

// One encoder pass, two decoder runs: the first emits the language token (Whisper's
// native detection, which the pipeline never exposes — with no language it forces
// English), the second transcribes in that language. The encoder is the cost of a
// pass; the detection step is one token.
async function detectAndTranscribe(audio, fallbackLang) {
  const { model, processor, tokenizer } = transcriber;
  const gc = model.generation_config;
  const { input_features } = await processor(audio);
  const prepared = await model._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: input_features,
    model_inputs: { input_features },
    model_input_name: 'input_features',
    generation_config: gc,
  });
  const encoder_outputs = prepared.encoder_outputs;
  const probe = await model.generate({
    inputs: input_features,
    encoder_outputs,
    decoder_input_ids: [gc.decoder_start_token_id],
    max_new_tokens: 1,
  });
  const probeIds = probe.tolist()[0];
  const lang = langFromToken(gc.lang_to_id, Number(probeIds[probeIds.length - 1])) || fallbackLang;
  const ids = await model.generate({
    inputs: input_features,
    encoder_outputs,
    language: WHISPER_NAME[lang] || 'english',
    task: 'transcribe',
  });
  const text = tokenizer.decode(ids.tolist()[0], { skip_special_tokens: true });
  return { text: (text || '').trim(), lang };
}
```

In the `transcribe` branch of `self.onmessage`, after the existing `if (!transcriber) throw …` line, route detection requests to it and give every result a `lang` field:

```js
      if (msg.detect && transcriber.model.generation_config.is_multilingual) {
        const out = await detectAndTranscribe(msg.audio, msg.lang || sessionLang);
        self.postMessage({ type: 'result', id: msg.id, text: out.text, lang: out.lang });
        return;
      }
      const opts = { chunk_length_s: 30, return_timestamps: false };
      // …the existing language block, unchanged…
      const out = await transcriber(msg.audio, opts);
      self.postMessage({ type: 'result', id: msg.id, text: (out && out.text) || '', lang: null });
```

Pieces are at most `MAX_SEG_MS` (8 s) and previews carry at most `PREVIEW_TAIL_MS` (8 s) of audio, so the direct path needs no chunking; keep the pipeline path (with its `chunk_length_s: 30`) for single-language sessions, where the English-only model has no language table and nothing to detect.

If `generate` rejects `decoder_input_ids` as a flat array, `[[gc.decoder_start_token_id]]` is the other shape it accepts (`prepareTensorForDecode`); if `encoder_outputs` is not honoured and the encoder runs twice, say so in the report with the measured cost rather than papering over it — the design still works, it just costs a second encoder pass on detection.

- [ ] **Step 4: The offscreen document asks for detection in a bilingual session, on every local pass**

In `offscreen.js`:

1. `localTranscribe(audio, lang, detect = false)`: post `{ type: 'transcribe', id, audio, lang, detect }` and resolve `{ text: m.text, lang: m.lang ?? null }` instead of `m.text`.
2. In `transcribe(seg, lane)`, the normalised call becomes:

```js
    const multi = state.settings.lang === 'multi';
    const result = lane === 'api'
      ? await apiTranscribe(seg.audio)
      : await localTranscribe(seg.audio, state.lang[seg.speaker], multi);
    const clean = (result.text || '').trim();
    // What the engine heard outranks the sticky value, for previews and turns alike:
    // it is what the line is decoded in, and what the next pass starts from.
    if (result.lang) state.lang[seg.speaker] = result.lang;
```

3. In the preview branch nothing else changes: the `stitchLang` reset (Task 5) already discards a line whose language moved, and the `PARTIAL` broadcast already carries `state.lang[seg.speaker]`.
4. In the authoritative branch, replace Task 10's whole detection block (the `let turnText`/`let turnLang`/votes/re-pass logic) with:

```js
      // No label from the engine (a Groq response without one): the text decides,
      // but only in a bilingual session — a pinned session has no question to
      // answer, and a one-word turn can score 1.0 for either language.
      let turnLang = result.lang;
      if (!turnLang && multi) {
        const read = detect(clean);
        if (read.lang && read.confidence >= LANG_CONFIDENCE) {
          turnLang = read.lang;
          state.lang[seg.speaker] = turnLang;
        }
      }
```

and keep the stored entry as `text: clean, lang: turnLang || state.lang[seg.speaker]`.

5. Remove what Task 10 added and nothing now reads: `state.langVotes` (and its reset in `start()`), the `backup` slice at the top of `transcribe`. Keep `LANG_CONFIDENCE` and the `detect` import (used above).

- [ ] **Step 5: Verify — and measure**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
node e2e/run.mjs bilingual --lang=multi
node e2e/run.mjs bilingual --engine=api --lang=multi
node e2e/run.mjs english
```
Expected: 0 failing, 0 warnings; 0 fail. In the first run every Spanish row shows `bubble lang` = es with `match` ≥ 70 % and `live match` well above the 6–14 % measured before; English rows stay ≥ 90 %. In the second, the same for turns (the stand-in labels them) and the live line. The third must stay within run-to-run variance of live 1.5–2.6 s and bubble 1.2–2.5 s (an English-only session takes the pipeline path and pays nothing).

- [ ] **Step 6: Commit**

```bash
git add worker.js worker.test.js offscreen.js
git commit -m "$(cat <<'EOF'
feat(worker): let Whisper name the language on every local pass

Forced to English, the multilingual model does not produce garbage a
text classifier can flag: it produces a fluent translation, so the
re-pass never fired and every Spanish turn landed labelled English.
Whisper's own first token is the language, and one encoder pass now
serves both that step and the transcription, so a bilingual session
detects on every pass — the live line is decoded in the right language
from its first paint, and a turn never waits for a second opinion.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: One writer for settings

Tasks 13 and 14 added two more read-modify-write paths to `settings` (add a note from the side panel, add one from the overlay). Their reviews traced the pre-existing pattern: `toggleNote` in the side panel, `TOGGLE_NOTE` / `PILL_POS` / `PILL_HIDE` in the service worker and `saveUi` in the side panel each read the whole `settings` object, change one part and write it all back, with no ordering between them. Two of them in flight at once — a note toggled from the overlay while one is added from the panel, or the start button's `saveUi` while a note lands — and the second write silently discards the first: a whole note gone, not just an open flag. This task makes the service worker the only writer and queues its writes.

**Files:**
- Modify: `.claude/skills/message-contract/SKILL.md` — **first**
- Modify: `background.js` (`patchSettings`, the four note/pill cases, a `PATCH_SETTINGS` case)
- Modify: `sidepanel.js` (`saveUi`, `toggleNote`, the note form's submit)

**Interfaces:**
- Produces: `PATCH_SETTINGS` (ui → background): `{ patch }`, a shallow object merged over the stored settings; reply `{ ok, settings }` with the result. All settings writes in `background.js` go through `patchSettings(mutate)`, which runs them one after another.
- Consumes: `addNote`, `toggleNoteOpen` from `phrasebook.js` (unchanged).
- Options (`setup.js`) keeps its whole-form save: it is an explicit "Guardar" on a page nobody edits mid-call, and routing a 20-field form through a patch buys nothing here.

- [ ] **Step 1: Document the message first**

In `.claude/skills/message-contract/SKILL.md`, beside `ADD_NOTE`: `PATCH_SETTINGS`, sent by `sidepanel.js` to `background`, payload `patch` (an object whose keys are settings fields, merged over the stored object), reply `{ ok, settings }`. Note in the rules that **settings are written only by the service worker**, one write at a time, because every view that read-modify-writes the object on its own is a race with every other.

- [ ] **Step 2: The single writer**

In `background.js`, above the message listener:

```js
// Settings are one object that several views want to change one field of, at
// the same time — a note toggled from the overlay while one is added from the
// panel, the start button's save while a note lands. Read-modify-write from two
// places loses whichever write comes second. So every change funnels through here,
// queued: the worker is the only writer, and it writes one at a time. Module state
// is ephemeral, which is fine — a suspended worker has nothing in flight.
let settingsWrites = Promise.resolve();
function patchSettings(mutate) {
  const run = settingsWrites.then(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const next = mutate(settings);
    await chrome.storage.local.set({ settings: next });
    return next;
  });
  settingsWrites = run.catch(() => {});
  return run;
}
```

Then rewrite the four existing cases and add the fifth:

```js
        case 'PILL_POS': {
          await patchSettings((s) => ({ ...s, pillPos: msg.pos }));
          sendResponse({ ok: true });
          break;
        }
        case 'PILL_HIDE': {
          const host = String(msg.host || '').toLowerCase();
          await patchSettings((s) => {
            const hosts = new Set(s.pillHiddenHosts || []);
            if (host) hosts.add(host);
            return { ...s, pillHiddenHosts: [...hosts] };
          });
          sendResponse({ ok: true });
          break;
        }
        case 'TOGGLE_NOTE': {
          await patchSettings((s) => toggleNoteOpen(s, msg.id));
          sendResponse({ ok: true });
          break;
        }
        case 'ADD_NOTE': {
          await patchSettings((s) => addNote(s, { title: msg.title, body: msg.body }));
          sendResponse({ ok: true });
          break;
        }
        case 'PATCH_SETTINGS': {
          const settings = await patchSettings((s) => ({ ...s, ...(msg.patch || {}) }));
          sendResponse({ ok: true, settings });
          break;
        }
```

Keep each case's existing comment where it still says something true; drop the ones that described the read-modify-write.

- [ ] **Step 3: The side panel stops writing settings itself**

In `sidepanel.js`:

`saveUi` sends a patch of the fields the panel owns and adopts the reply:

```js
async function saveUi() {
  const patch = {
    lang: els.lang.value,
    themSource: els.themSource.value,
    themDeviceId: els.themDevice.value || null,
    captureMic: els.captureMic.checked,
    sessionContext: els.sessionContext.value.trim().slice(0, CONTEXT_MAX_CHARS),
    profile: els.profile.value.trim().slice(0, PROFILE_MAX_CHARS),
  };
  const res = await chrome.runtime.sendMessage({ type: 'PATCH_SETTINGS', patch }).catch(() => null);
  settings = { ...DEFAULT_COACH, ...((res && res.settings) || { ...settings, ...patch }) };
}
```

`toggleNote` becomes a message, as the overlay's already is:

```js
async function toggleNote(id) {
  await chrome.runtime.sendMessage({ type: 'TOGGLE_NOTE', id }).catch(() => {});
  // No re-render here: the write trips storage.onChanged in background.js, which
  // re-broadcasts COACH_CHIPS to all three views at once.
}
```

and the note form's submit handler (Task 13) sends `ADD_NOTE` instead of writing:

```js
els.noteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = els.noteTitle.value;
  const body = els.noteBody.value;
  if (!title.trim() && !body.trim()) return;
  await chrome.runtime.sendMessage({ type: 'ADD_NOTE', title, body }).catch(() => {});
  els.noteForm.reset();
  els.noteAdd.open = false;
});
```

Remove the now-unused imports (`toggleNoteOpen`, `addNote`) from `sidepanel.js` if nothing else in the file uses them; keep `resolveChips`. Grep for any other `chrome.storage.local.set({ settings` left in `sidepanel.js` — there must be none.

- [ ] **Step 4: Verify**

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```
Expected: 0 failing, 0 warnings; 0 fail.

End to end (controller): from the side panel page, send `ADD_NOTE` and `TOGGLE_NOTE` back to back without awaiting, then read `settings.notes` — both effects present (the new note exists, the toggled one flipped); a `PATCH_SETTINGS` of `profile` while a note lands keeps both.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/message-contract/SKILL.md background.js sidepanel.js
git commit -m "$(cat <<'EOF'
fix(settings): one writer, one write at a time

Every view read the whole settings object, changed one field and wrote
it back, so two changes in flight — a note added from the panel while
one is toggled from the overlay — lost whichever landed second. The
service worker is now the only writer and queues its writes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## What this plan does not cover

**Phase 4 of the spec — Claude as the primary coach provider (§7 b–f)** — is deliberately absent, except for §7(a), which is task 1 because without it a learner who selects Claude today gets truncated answers.

The rest of §7 gets its own plan after task 9 lands, for the reason the spec gives: the bilingual prompt work (turns reaching the model labelled with their language, the report grading only the learner's English turns, the reply answering in the language of the latest `them` turn) cannot be tuned against a conversation the extension cannot yet record. That plan will cover structured outputs on the Claude path, the `stop_reason` guards for refusal and truncation, server-side fallbacks, and the model list — with the Haiku id confirmed against the Models API rather than edited on the strength of a document.
