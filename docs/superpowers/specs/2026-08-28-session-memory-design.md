# Session memory: design

Status: approved through section 4; sections 5–7 written without section-by-section review
(flagged in "Decisions taken without review" at the end).

## 1. Problem

The suggested reply (`⌘⇧E` / the "💡 Respuesta" button) answers from a keyhole. `askReply` in
`coach.js` passes exactly this as conversational context:

```js
turnsToText(turns, 10, 1200)   // last 10 turns, capped at 1200 characters
```

That is roughly the last ninety seconds of a call. Everything else the model receives is static
and written before the meeting started: `profileBlock` (1500 chars) and `contextBlock` (1500
chars). The result is the two failures the user reported:

- **Answers that are too basic** — the model has no idea what has already been established, so it
  answers every question as if it were the first.
- **Answers about things nobody said** — asked to follow up on an earlier point, the model has no
  record of it and fills the gap.

The same hole exists in the closing report and is worse there because it is silent: `askReport`
trims the transcript to `REPORT_MAX_CHARS = 12000` and only whispers `(sólo la parte final de la
conversación)` inside the prompt. A one-hour call produces 30–40k characters, so **today's report
analyses the last third of the conversation and discards the rest without telling the learner.**

## 2. Goals

1. Give the reply button conversation-wide context without a latency or token blow-up.
2. Accumulate the learner's mistakes into a durable, trustworthy error lake.
3. Produce a closing feedback pass — phrases and vocabulary to learn — grounded in that lake.
4. Produce a meeting summary that covers the whole conversation, not its tail.

## 3. Non-goals

- No new runtime dependency, build step, or bundler.
- No new Chrome permission (in particular, not `unlimitedStorage`).
- No new message type in the protocol (see §11).
- No cross-device sync. Everything stays in `chrome.storage.local`.

## 4. Constraints

| Constraint | Source | Consequence |
|---|---|---|
| 8000 tokens/minute on Groq's free tier, shared across every call | `coach.js` `callGroq` 429 branch | A new periodic call must yield, and must be able to skip rounds |
| Live hints already consume ~5.3k tokens/minute | `HINT_COOLDOWN_MS = 12000`, `offscreen.js` | The distiller runs in whatever is left |
| The reply is on demand with the other person waiting | product | Extra latency is paid in the conversation |
| The offscreen document has no `chrome.storage` | `CLAUDE.md` invariant 4 | All reads/writes go through `STORE_GET` / `STORE_SET` |
| Service worker memory is ephemeral | `CLAUDE.md` invariant 5 | No session memory may live in `background.js` |
| `chrome.storage.local` is quota-bound (no `unlimitedStorage`) | `manifest.json` | The lake must be capped and pruned |
| Providers are pluggable and user-swappable | `.claude/skills/add-provider` | No Groq-shaped constant outside the `PROVIDERS` table |
| Pure logic stays pure and runs in Node | `CLAUDE.md` | All new logic lands in a dependency-free module |

## 5. Architecture

Three layers feed the reply, with different truth rules:

```
                    ┌──────────────────────────────────────────┐
  transcript ──────►│ distiller (periodic, LLM, budget-gated)   │──► memory.topics / .open / .errors
  (system of        └──────────────────────────────────────────┘        │  orientation only
   record)                                                              │
       │            ┌──────────────────────────────────────────┐        │
       ├───────────►│ retriever (on demand, pure JS, free)      │──► literal turns
       │            └──────────────────────────────────────────┘        │  quotable evidence
       │                                                                │
       └──────────────────────────────────────────────────────► raw tail (immediate thread)
                                                                        │
                                                                        ▼
                                                                   askReply
```

The distiller supplies narrative; the retriever supplies precision. The split matters because the
two named failures have different causes: "too basic" is fixed by orientation, "things nobody
said" is fixed only by literal evidence — a summary has already lost the detail that would keep
the model from inventing it.

It also splits the failure modes. On a rate-limited provider the distiller **will** skip rounds;
that is a certainty, not a risk. The retriever costs nothing, never skips, and cannot hallucinate,
so the layer that survives a full minute is also the layer that is verbatim.

**New module: `memory.js`.** Dependency-free, `now` injected, no `chrome.*` — the same contract as
`segmenter.js`. It owns chunking, the guards, the budget ledger, retrieval, routing, reply-context
assembly, and the lake merge. `offscreen.js` only orchestrates; `coach.js` only owns prompts and
providers.

## 6. Data model and lifecycle

Two new `chrome.storage.local` keys.

`memory` — lives and dies with the conversation:

```js
{
  sessionId,        // stamped in start(); identifies a session for recurrence counting
  coveredUntil,     // `t` of the newest turn already distilled
  carry,            // one line: the thread still open when the last chunk ended
  merged,           // whether this session's errors already reached the lake
  topics: [ { text, quote, t } ],
  open:   [ { text, quote, t } ],
  errors: [ { wrong, right, kind, said, t } ],
  rounds, skipped, rejected,
}
```

`lake` — survives everything (phase B):

```js
{
  entries: [ { key, wrong, right, kind, count, lastSessionId, firstAt, lastAt, samples: [] } ],
  vetoed:  [ key… ],
}
```

### 6.1 Which turns may be distilled

`foldIntoTranscript` **mutates stored turns**: an entry already in the array grows when another
segment from the same speaker arrives within `MERGE_GAP_MS`. Distilling a turn that later grows
loses the appended text silently.

The function can only ever extend the entry with the highest `t`. Therefore:

> **A chunk is the turns with `t > coveredUntil`, always excluding the turn with the maximum `t`.**

A turn is distilled only once it can no longer grow.

Coverage is tracked by `t`, not by index, for the same class of reason: the transcription queue
lets `them` overtake `me` (`MAX_BYPASS`), so insertion order does not match capture order.

### 6.2 Lifecycle

- Memory is **not** cleared on `start()`. Stop-and-start continues the same conversation, matching
  what `transcript` already does.
- Memory is cleared **in the same gesture** as the transcript (`sidepanel.js` clear button).
- Memory **self-resets on read** when it disagrees with the transcript (transcript empty, or
  `coveredUntil` newer than every stored turn). An orphaned memory would narrate a conversation
  that no longer exists.
- `sessionId` is stamped in `start()`. Recurrence counts **distinct sessions**, never repetitions
  inside one: saying `depends of` four times in one meeting is one occurrence, not four.

### 6.3 Caps

| Store | Cap | Prune rule |
|---|---|---|
| `topics` | 60 | drop oldest |
| `open` | 12 | drop oldest |
| `errors` (session) | 40 | drop oldest |
| `lake.entries` | 200 | lowest `count`, then oldest `lastAt` |
| `lake.entries[].samples` | 3 | drop oldest |
| `lake.vetoed` | 200 | drop oldest |

At ~300 bytes per entry the lake stays around 60 KB, which is why no new permission is needed.

## 7. The distiller and its budget policy

### 7.1 One provider fact

```js
groq:      { …, tpm: 8000 },   // free plan
anthropic: { …, tpm: null },   // no window
```

`tpm` is the only provider-specific knob the memory layer has. Everything else derives from it in
`memory.js`. A new provider adds its `tpm` and inherits the policy. `PROVIDERS` is consumed
elsewhere only for `label`, `cost` and `models` (`setup.js` `fillModelSelect`), so the field is
additive and safe.

### 7.2 Constants

| Name | `tpm` set | `tpm` null |
|---|---|---|
| `CHUNK_CHARS` | 1800 | 4000 |
| `REPLY_TAIL_CHARS` | 2700 | 6000 |

```
CHUNK_BAND          = [0.8, 1.2]   // where the pause-based cut may land
OVERLAP_CHARS       = 400
CHUNK_MAX_FACTOR    = 1.5          // hard ceiling on a backlogged chunk
REPLY_TAIL_FACTOR   = 1.5          // REPLY_TAIL_CHARS = CHUNK_CHARS * 1.5
DISTILL_COOLDOWN_MS = 45000
BUDGET_WINDOW_MS    = 60000
BUDGET_SAFETY       = 0.75
DISTILL_MAX_TOKENS  = 900
```

Nominal per-call costs for the ledger (estimates, not accounting — the point is the margin):

```
{ hints: 1400, starter: 900, reply: 3400, report: 6000, distill: 1300 }
```

### 7.3 The coverage invariant

If chunks are 1800 characters and the reply looks at the last 1200, a band of conversation sits in
neither the memory nor the tail — it vanishes exactly where it matters.

> **`REPLY_TAIL_CHARS >= CHUNK_CHARS * 1.5`**

Distilled memory covers `[start → coveredUntil]`, the raw tail covers `[coveredUntil → now]`, and
they overlap rather than leaving a gap.

### 7.4 Cutting on a pause, not on a counter

Cutting every 1800 characters splits ideas. Instead, within `CHUNK_BAND` (80%–120% of the target),
the chunk ends at the **largest inter-turn silence**, falling back to a speaker change, falling
back to the target size. This is what `segmenter.js` already does with audio — silence as an idea
boundary — applied to text.

### 7.5 Overlap and `carry`

- Each chunk carries the previous chunk's last `OVERLAP_CHARS` characters, labelled *already
  processed, context only — do not extract from it*.
- The schema has a `carry` field: one line describing the thread still open when the chunk ended,
  empty if it closed cleanly. The next round receives it as a preamble.

`carry` replaces the rejected design of a second "is this complete?" call. That call cannot work:
at the live edge, the rest of the idea **has not been spoken yet** — the only text available to
add is backwards, which is already distilled. It would also double the round's cost and rely on a
small model's self-assessment of completeness, which is a surface cue (does the text end mid
sentence) computable in JS for free.

`carry` orients what to look for. It never authorises an assertion: everything extracted still has
to pass the anchoring guard against the **current** chunk, so a drifting `carry` cannot produce an
invented topic.

Near-duplicate topics from consecutive rounds are merged in JS by normalised key.

### 7.6 When a round runs

Triggered when undistilled text reaches `CHUNK_CHARS`. It yields to:

1. **A reply in flight** — always, on every provider. The user asked for that; nothing background
   competes with it.
2. **A busy transcription queue** — never delay a real turn.
3. **A hints round** — only when `tpm` is set; there is no contention to avoid on a paid provider.
4. **The minute's budget** — the rolling ledger must show room for `distill` within
   `tpm * BUDGET_SAFETY`.

Plus a `DISTILL_COOLDOWN_MS` floor, and a hard ceiling: even after five skipped rounds the chunk
never exceeds `CHUNK_CHARS * CHUNK_MAX_FACTOR`. The backlog waits rather than sending the one
oversized block that would cause the 429 this is avoiding.

### 7.7 Final flush and honest coverage

`stop()` runs a final distillation after `waitForQueue()` and before the report, so the report is
not handed an undistilled tail.

`rounds` and `skipped` produce a coverage figure the report states out loud. Today's silent 12k
truncation is replaced by a visible number.

### 7.8 Degradation

No API key, a 429, or a full minute: the round does not happen, `skipped` increments, and **the
reply still works** on the raw tail plus the retriever, which spends no tokens.

## 8. Anti-hallucination guards

Ordered strongest to weakest. **Anything verifiable in JS is not asked of the model.**

**Layer 0 — the schema.** `json_schema` with `strict: true` where the model supports it, routed by
`groqResponseFormat`; `parseJsonLoose` remains the tolerance layer for providers with no
structured mode.

**Layer 1 — literal anchoring.** Every extracted item travels with a verbatim quote from the chunk:

| Field | Anchored value |
|---|---|
| `errors[].wrong` | the minimal wrong pair, verbatim |
| `topics[].quote` | a sentence supporting the topic |
| `open[].quote` | the sentence where the commitment was made |

The check normalises (lowercase, collapsed whitespace, punctuation stripped) and requires the
quote to appear inside the chunk (overlap included). A failing item is discarded silently.

A topic is a summary, so the **summary** is free and its **evidence** is not. The stored quote also
gives the report something to show.

`open` requires a quote because it is the most dangerous field in the system: an invented topic is
noise, an invented commitment is actionable.

`errors[].said` and every `t` are **derived in JS**, not requested — `said` is the LEARNER turn
whose text contains `wrong`. One less field is one less hallucination surface.

**Layer 2 — shape rules on the minimal pair.**

- `wrong` must come from a **LEARNER** line. A mistake quoted from the other speaker is a
  misattribution by definition.
- `normalize(wrong) !== normalize(right)` — models "correct" to the same string often.
- `wrong` is capped at 60 characters. A paragraph is not a minimal pair, and without the cap the
  lake key never dedupes.

**Layer 3 — no self-feeding.** The distiller reads raw transcript plus the one-line `carry`. Never
`topics`, never `open`, never the lake. No chain, no drift compounding.

**Layer 4 — the prompt.** Reuses the ASR-noise instruction already proven in `REPORT_SYSTEM` (the
«request quid» rule) plus the bias rule: **when in doubt, do not record it.**

### 8.1 The limit, stated plainly

**There is no reliable way to detect in JS that Whisper mangled a technical term.** It needs a
dictionary, and this project has no dependencies. So ASR noise is stopped by neither anchoring nor
the shape rules — it is stopped by the lake's **recurrence gate** and the **human veto**, both in
phase B.

Consequence: during phase A the distiller **will** record some mistake the learner never made.
That is acceptable while those entries live only in session memory and that session's report. It
would not be acceptable if they went straight into a permanent history — which is why the phases
are ordered A then B.

A `rejected` counter records items dropped by the guards. It is displayed nowhere, and it is the
only signal that would tell us the filters are eating good extractions.

## 9. How the reply consumes it

### 9.1 Retrieval

- **Corpus**: every turn except the raw tail already in the prompt.
- **Query**: the last consecutive `them` turns, up to `QUERY_MAX_CHARS = 400` — not just the last
  entry, because soft cuts split one question into several segments.
- **Scoring**: IDF-weighted term overlap over the transcript's own turns, with a short English +
  Spanish stopword list. `idf(t) = ln(1 + N / (1 + df(t)))`. IDF makes rare terms — names, jargon —
  dominate, which is exactly the signal wanted.
- **Normalised score**: matched IDF mass divided by the query's total content IDF mass, in `[0,1]`.

### 9.2 Routing — three cases, not two

```
if (contentTerms.length < MIN_CONTENT_TERMS)   → 'continuation'
else if (bestScore < SCORE_FLOOR)              → 'new'
else                                           → 'anchored'
```

`MIN_CONTENT_TERMS = 2`, `SCORE_FLOOR = 0.35`, `EVIDENCE_TURNS = 3`.

- **continuation** — *"¿y eso cómo lo harías?"*. Almost no content words. A naive threshold would
  call this a new topic, which is the worst possible answer: it is the most anchored question
  there is. Detected by absence of content terms, not by similarity. No evidence injected; the raw
  tail already carries it.
- **anchored** — content terms that match earlier turns. The top `EVIDENCE_TURNS` turns go in
  verbatim.
- **new** — clear content terms, no match. No turns injected, and the prompt switches mode.

**Bias: when in doubt, treat it as new.** The costs are asymmetric — an anchored question demoted
to new costs a slightly generic answer; a new question promoted to anchored makes the learner say
out loud, in an interview, that something was discussed when it was not.

### 9.3 The prompt's three labelled blocks

```
SITUATION (background — orients you, NOT quotable as fact)
  · <distilled topics>

LITERAL RECORD (exact words spoken earlier — you may rely on these)
  · OTHER: "…"
  · LEARNER: "…"

RECENT (the immediate thread)
  <raw tail>
```

In the **new** case the literal-record block is not omitted. It is replaced by a stated absence:

```
NOTHING earlier in this conversation covers this question. Do not imply it was discussed.
```

An absent block is ambiguous to a model and invites filling; a declared absence is not.

`REPLY_SYSTEM` gains the third truth rule it lacks today. It already separates two sources
correctly — biography must not be invented, technical knowledge is fair game. The missing one:
**facts about the conversation may come only from the literal-record block.**

### 9.4 Budget degradation

If the minute is full when the button is pressed, the reply is **never cancelled** — the user asked
for it. The optional blocks shrink instead: evidence first, then topics, worst case falling back
to today's behaviour.

### 9.5 Cost

~2175 input tokens against today's ~1450. The increase is deliberate: it is the on-demand call,
paid once, and the only one someone is waiting on.

### 9.6 Boundaries

`memory.js` decides **what** goes in (selection, routing, budget trimming). `coach.js` decides
**how it is asked** (prompts, providers). `askReply` receives a prepared `context` object. Both
halves are pure and tested separately in Node.

## 10. Report and closing feedback

`askReport` stops being handed only a truncated transcript. It receives:

- `memory.topics` with their quotes — covering the **whole** conversation
- `memory.open` — the commitments
- `memory.errors` — pre-extracted and already anchored
- the transcript tail, still capped
- the coverage figure

Prompt changes to `REPORT_SYSTEM` / `REPORT_SYSTEM_ES`:

- **`## Resumen de la reunión`** is built from the recorded topics. The model may not add a topic
  that is not in the list. `**Pendientes:**` comes from `open` only.
- **`## Errores de gramática`** is seeded from the extracted errors: the model explains and
  formats, it does not discover. It may add at most two more found in the tail.
- **New `## Lo que tienes que aprender`** — the phrases and vocabulary from goal 3, derived from
  the session's errors (phase A) and from the confirmed lake entries (phase B).
- A coverage line when coverage is below 100%.

Token cost stays roughly flat: distilled topics are a compressed representation of exactly the
region that used to be cut off, so the transcript tail can shrink to ~8000 characters. **The report
gains full coverage at the same price.**

## 11. Protocol, UI and files

**No new message types.** The distiller is invisible work, like the preview lane, and reports
nothing to the UIs. `sidepanel.js` clears `memory` alongside `transcript` from its own context, and
`report.js` / `setup.js` are extension pages with direct `chrome.storage` access. Preflight fails
on any SCREAMING_SNAKE type sent with no handler; adding none keeps that clean.

| File | Change |
|---|---|
| `memory.js` | **new** — chunking, guards, ledger, retrieval, routing, reply context, lake merge |
| `memory.test.js` | **new** |
| `coach.js` | `tpm` in `PROVIDERS`; `askDistill`; `askReply` takes `context`; report prompts |
| `offscreen.js` | distiller scheduler, ledger wiring, final flush, lake merge at stop |
| `sidepanel.js` | clear `memory` with `transcript` |
| `report.html` / `report.js` | phase B: "Errores que repites" with per-entry veto |
| `setup.html` / `setup.js` | phase B: clear the lake |
| `coach.test.js` | parse tests for the distiller |
| `CLAUDE.md` | `memory.js` in the pure-modules list; the fold/`coveredUntil` invariant |
| `PRIVACY.md` | phase B: what the lake stores and how to delete it |

## 12. Phase B — the accumulated lake

- Session errors are merged into the lake at `stop()`, and opportunistically at the next `start()`
  if a previous session ended without merging (`memory.merged`).
- Key: `normalize(wrong) + '→' + normalize(right)`. Vetoed keys are skipped on merge.
- `count` increments only when `lastSessionId !== sessionId`.
- `count >= RECURRENCE_MIN (2)` promotes an entry to **confirmed** — only confirmed entries drive
  cross-session feedback.

**Recurrence is the noise filter, and it is model-agnostic.** A hallucination is random: a small
model inventing a mistake today will not invent the same minimal pair next Thursday. A real mistake
is systematic and reaches the threshold quickly. A better model does not change the code — it only
confirms faster. That is why the lake accepts all three `kind` values (`grammar`, `calque`,
`register`) instead of being restricted to the categories a weak model handles.

The threshold is 2 rather than 3 precisely **because** the human veto exists: with a correction
mechanism, a false positive costs two seconds instead of months of bad teaching.

**Cleaning is two gestures, not one:**

- **Per entry** — "esto no era un error", next to the evidence sentence, in `report.html`. It must
  **veto**, not merely delete: a plain delete lets the distiller re-extract the same ASR garbage
  next week, and the button feels broken.
- **In bulk** — "vaciar el histórico", in `setup.html`, beside the existing controls.

## 13. Testing and verification

`memory.test.js` covers: the max-`t` exclusion, the pause cut inside the band, overlap, the
coverage invariant, each guard (anchoring, LEARNER-only, minimal-pair shape), the three routing
cases, ledger windowing, and lake merge / recurrence / veto / prune.

```bash
node .claude/skills/preflight/scripts/preflight.mjs
node --test *.test.js
```

Static checks confirm nothing about capture, rate limits, or model quality. Chunk sizing,
`SCORE_FLOOR` and the guards' strictness need a real call to calibrate.

## 14. Decisions taken without review

Sections 5–7 of the brainstorm (report, lake, protocol/UI/files) were approved through section 4
only. These calls were made unilaterally and are the ones to check first:

1. The report's error table is **seeded** from extracted errors rather than rediscovered, with at
   most two additions.
2. A **new** `## Lo que tienes que aprender` section rather than folding goal 3 into the existing
   vocabulary section.
3. The transcript tail in the report shrinks 12000 → 8000 characters to pay for the topics.
4. The lake surfaces inside `report.html` rather than in a page of its own.
5. Lake merge happens at `stop()`, not per round.
6. `RECURRENCE_MIN = 2`.
7. Zero new message types.
