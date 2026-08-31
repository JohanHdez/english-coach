# Static chips and notes: design

Status: approved in chat (2026-08-31) as a whole, not section by section — see §14.

## 1. Problem

The live coach layer calls a model every time the other person finishes a turn
(`offscreen.js`, `scheduleHints`), debounced 1.2 s and rate-limited to one round per 12 s. Each
round asks Groq for three fields (`HINT_SYSTEM` in `coach.js`):

| Field | What the prompt asks for | Depends on the conversation? |
|---|---|---|
| `openers` | 2–3 ways to *begin* an answer, 2–6 words | **No.** A closed set. |
| `words` | 3–4 collocations the learner needs "right now" | Only via `sessionContext`, which never changes mid-session. |
| `nudge` | one short hint in Spanish | Yes. |

Two of the three fields do not depend on the conversation, and the evidence is in the product's
own output. The closing report of 2026-08-30 produced this connector section:

> **"In addition,"** · **"On the other hand,"** · **"Could you clarify that?"** · **"To sum up,"** ·
> **"That makes sense."**

Every one is generic. Nothing there required knowing what was said. The extension is paying a
model, every twelve seconds, to re-derive a list that never changes.

That machinery has a cost beyond tokens:

- **It can fail, visibly, mid-conversation.** `Coach: Groq cortó la respuesta a medias (JSON
  inválido)` was reported in production on 2026-08-30. Root cause: gpt-oss models spend reasoning
  tokens from `max_completion_tokens` before writing the JSON, so a tight cap truncates the object
  and Groq rejects the call with 400 `json_validate_failed`. Fixed for `askReply` in `0f63f92`;
  `askHints` and `askStarter` kept the old cap and hit the same 400.
- **It eats the free tier.** The cooldown comment budgets ~5.3k of Groq's 8000 tokens/minute for
  hints alone, leaving the reply, the report and the session distiller to share the rest.
- **It requires a key and a network.** With no API key configured, the live layer shows nothing.
- **The learner cannot curate it.** The chips are whatever the model returns that round.

## 2. Goals

1. Replace the per-turn model call with a curated phrasebook the learner chooses from.
2. Let the learner add their own phrases, and their own titled notes ("Mi daily") that expand in
   place.
3. Make the live layer work with no API key and no network.
4. Remove the failure mode above by construction, not by tuning a token budget.

## 3. Non-goals

- No new runtime dependency, build step, or bundler.
- No new Chrome permission. `manifest.json` is untouched.
- No change to how `askReply` or `askReport` use the model: same prompts, same provider, same
  budget. They gain a per-turn character cap only because deleting `askHints` would otherwise
  orphan the code that enforces it (§9).
- No cross-device sync. Everything stays in `chrome.storage.local`.
- No per-situation phrasebooks (one general catalogue; the learner curates).

## 4. Constraints

| Constraint | Source | Consequence |
|---|---|---|
| The content script has `chrome.runtime` but not `chrome.storage` | `CLAUDE.md` runtime table | The overlay cannot read the phrasebook itself; it must arrive as a message |
| The offscreen document has no `chrome.storage` | `CLAUDE.md` invariant 4 | It is the wrong context to own settings-derived chips |
| A `ui` broadcast must be idempotent and self-contained | message-contract rule 4 | `COACH_CHIPS` carries the full list, never a delta, and is cached in `lastUi` |
| The overlay is re-injected on tab switch and reload | message-contract rule 4 | Chips must replay from `UI_SYNC` |
| A renamed type must change in every context at once | message-contract rule 6 | `HINTS` → `COACH_CHIPS` lands as one change across offscreen, background, sidepanel, overlay |
| Preflight fails on a SCREAMING_SNAKE type sent with no handler | `CLAUDE.md` verification | A half-removed `HINTS` fails the gate rather than going silent |
| No remote code, no CDN | `CLAUDE.md` invariant 7 | The catalogue ships as a checked-in JS module |

## 5. Architecture

The load-bearing change: **chips stop being session state and become settings state.**

Today the offscreen document owns them because the model call lives there. Once the model call is
gone there is nothing session-shaped left — the chips derive purely from `settings`. So
`background.js` owns the broadcast: it is the router, it has `chrome.storage`, and it already
watches `storage.onChanged`.

```
                      settings (chrome.storage.local)
                               │
                    storage.onChanged │ START │ UI_SYNC
                               ▼
                        background.js
                    (resolvePhrases + notes)
                               │
                    COACH_CHIPS broadcast
                    ┌──────────┴──────────┐
                    ▼                     ▼
          runtime.sendMessage      tabs.sendMessage
             (sidepanel,               (overlay)
              coach window)
```

A consequence worth naming: chips render **before a session starts**, because they no longer
depend on one.

## 6. New module: `phrasebook.js`

Pure logic, no `chrome.*`, imports nothing — the same contract as `segmenter.js` and `coach.js`,
so it runs and tests unmodified in Node (`CLAUDE.md`, "Pure logic stays pure").

```js
export const CATALOGUE = [
  { cat: 'Ganar tiempo', items: [
    { id: 'time.second',   en: 'Give me a second,',          es: 'dame un segundo' },
    ...
  ] },
  ...
];

// Built-ins the learner ticked, plus their own phrases, in catalogue order then custom order.
// Unknown ids in phraseIds are dropped: the catalogue may lose an entry between versions.
export function resolvePhrases(settings) { ... }

// Notes are stored as written; this only guards the shape the UI depends on.
export function resolveNotes(settings) { ... }
```

### 6.1 Catalogue

Eight categories, thirty-eight phrases. English is the spoken register a B1–B2 professional can
say out loud; the Spanish gloss is a gloss, not a translation exercise.

**Ganar tiempo** — `time.second` "Give me a second," (dame un segundo) · `time.think` "Let me
think about that," (déjame pensarlo) · `time.good-q` "That's a good question," (buena pregunta) ·
`time.rephrase` "Let me put it another way," (déjame decirlo de otra forma) · `time.bear` "Bear
with me a moment," (dame un momento)

**Pedir aclaración** — `clarify.repeat` "Sorry, could you repeat that?" (¿puedes repetirlo?) ·
`clarify.clarify` "Could you clarify that?" (¿puedes aclararlo?) · `clarify.mean` "What do you
mean by that?" (¿a qué te refieres?) · `clarify.follow` "Just to make sure I follow," (para
asegurarme de que te sigo) · `clarify.specific` "Could you be more specific?" (¿puedes concretar?)

**Contrastar** — `contrast.other-hand` "On the other hand," (por otro lado) · `contrast.that-said`
"That said," (dicho eso) · `contrast.however` "However," (sin embargo) · `contrast.in-practice`
"Although in practice," (aunque en la práctica) · `contrast.depends` "It depends on the case,"
(depende del caso)

**Añadir** — `add.in-addition` "In addition," (además) · `add.on-top` "On top of that," (encima de
eso) · `add.worth` "It's also worth mentioning," (también vale la pena mencionar) · `add.more`
"What's more," (es más)

**Estructurar** — `structure.two-things` "There are two things here," (aquí hay dos cosas) ·
`structure.first` "First of all," (en primer lugar) · `structure.then` "And then," (y luego) ·
`structure.break-down` "Let me break that down," (déjame desglosarlo) · `structure.example` "For
example," (por ejemplo) · `structure.my-case` "In my case," (en mi caso)

**Cerrar** — `close.sum-up` "To sum up," (en resumen) · `close.in-short` "So, in short," (en
pocas palabras) · `close.thats-it` "That's basically it." (eso es básicamente todo) ·
`close.answer` "Does that answer your question?" (¿responde eso a tu pregunta?)

**Reaccionar** — `react.makes-sense` "That makes sense." (tiene sentido) · `react.fair` "Fair
enough." (me parece justo) · `react.good-point` "Good point." (buen punto) · `react.exactly`
"Exactly." (exacto) · `react.agree` "I'd agree with that." (estaría de acuerdo) · `react.unsure`
"I'm not sure about that." (no estoy seguro de eso)

**Ser honesto** — `honest.not-directly` "I haven't worked with that directly," (no he trabajado
con eso directamente) · `honest.similar` "but I've done something similar with," (pero he hecho
algo parecido con) · `honest.approach` "The way I'd approach it is," (la forma en que lo
enfocaría es)

The last category exists because the report of 2026-08-30 graded the learner B1 partly on
hesitation. In an interview, a clean way to say "I don't know, but here's how I'd find out" is
worth more than a connector.

## 7. Storage

Three new keys inside the existing `settings` object. `transcript`, `report`, `memory`, `lake`
and `lastError` are untouched.

```js
phraseIds:     ['time.second', 'clarify.clarify'],        // ticked built-ins
customPhrases: [{ id: 'u.1', en: '…', es: '…' }],         // 'u.' prefix: cannot collide
notes:         [{ id: 'n.1', title: 'Mi daily', body: '…', open: true }],
```

Defaults for a learner who has never opened the new settings section — seeding rather than
starting empty means the feature is visible the first time it runs:

```js
phraseIds: ['time.second', 'time.think', 'time.good-q', 'time.rephrase', 'time.bear',
            'clarify.repeat', 'clarify.clarify', 'clarify.mean', 'clarify.follow', 'clarify.specific'],
customPhrases: [],
notes: [],
```

Exported from `phrasebook.js` as `DEFAULT_PHRASE_IDS` so the seed has one definition, not two.

Caps, in the spirit of `PROFILE_MAX_CHARS`: a note title of 60 characters, a note body of 2000, at
most 20 notes and 40 custom phrases. Enforced in `phrasebook.js` so Node tests cover them.

## 8. Message protocol

| | Before | After |
|---|---|---|
| Sender | offscreen | **background** |
| Type | `HINTS` `{ words[], openers[], nudge }` | `COACH_CHIPS` `{ phrases[], notes[] }` |
| Trigger | every `them` turn, debounced + cooled down | `START`, `UI_SYNC`, and `storage.onChanged` on the three keys |
| Cache | `lastUi.hints` | `lastUi.chips` |

`phrases` is `[{ en, es }]`; `notes` is `[{ id, title, body, open }]`.

**`CONTEXT_CHANGED` is deleted.** Its only consumer was `sendStarter`, which regenerated the
starter chips when `sessionContext` was edited mid-session. With `askStarter` gone it has no
purpose. The `storage.onChanged` watcher in `background.js:149-153` that fired it is rewired to
re-broadcast `COACH_CHIPS`.

Toggling a note open in the session UI writes `open` back through `STORE_SET`, which trips the
same watcher — so the three views converge without a second message type.

## 9. Deletions

`coach.js` — `askHints`, `askStarter`, `HINT_SYSTEM`, `STARTER_SYSTEM`, `HINT_SCHEMA`,
`parseHints`, `HINTS_MAX_CHARS`, `HINTS_MAX_TURN_CHARS`. About 80 lines, which pays down part of
the "coach.js is past 600 lines" debt recorded in `CLAUDE.md`.

`offscreen.js` — `scheduleHints`, `sendStarter`, `HINT_DEBOUNCE_MS`, `HINT_COOLDOWN_MS`, and the
state fields `hintTimer`, `hintBusy`, `lastHintAt`, `starterBusy`. The `scheduleHints()` call on
line 83 goes with them; `clearPartial()` stays.

`sidepanel.html` / `overlay.js` — `#nudge` and `#hintOpeners` and their CSS.

`coach.test.js` — the three regression tests added on 2026-08-30 for the 700-token cap. They die
with the functions they guard, and that is the point: **the bug stops being possible rather than
being correctly budgeted.**

**Survives, and must be rewired**: `clip` / `maxTurnChars` in `turnsToText` was added on
2026-08-30 but wired only into `askHints`. Deleting `askHints` would leave it dead — and preflight
fails on dead code. It has to move to the two callers that still need it: `askReply` and
`askReport` receive the same Whisper repetition loops (one segment of thousands of characters,
which `MERGE_MAX_CHARS` bounds for *folding* but not for a single transcription). Both gain a
shared `TURN_MAX_CHARS = 400`:

```js
turnsToText(turns, 10, 1200, TURN_MAX_CHARS)          // askReply
turnsToText(turns, 400, REPORT_MAX_CHARS, TURN_MAX_CHARS)   // askReport
```

This is a behaviour change to the report, and a deliberate one: the report of 2026-08-30 spent
grammar-table rows on `"I'm a good guy"` repeated eighty times. `JSON_BUDGET` survives as
`askReply`'s cap.

## 10. Interface

### Settings (`setup.html`)

New section "4. Chips y notas"; the existing "4. Cómo capturar cada fuente" becomes 5.

- The catalogue, grouped by category, each phrase a checkbox showing `en` and its `es` gloss.
- "Añadir frase": two inputs (English, gloss) and a list of the learner's own, each removable.
- "Notas": a list of title + body pairs, addable and removable.

### Session (`sidepanel.html`, `overlay.js`, floating window)

Two lanes, replacing the chips/nudge/openers block:

```
FRASES   Give me a second,   Could you clarify that?   On the other hand,

NOTAS    ▾ Mi daily
             Yesterday I finished the auth refactor. Today I'm picking up the
             rate-limit work. No blockers.
         ▸ Preguntas para el cliente
```

Phrases need no interaction — they are there to be glanced at. Notes are collapsed by default and
**remember their open state**, so the learner opens "Mi daily" before the meeting and it is still
open when it matters. This is the design's answer to the tester feedback recorded in
`live-english-is-the-priority`: no interaction may be required at the moment of speaking.

`liveCoach` is kept as the on/off switch but changes meaning, from "call the model live" to "show
the chips". Its label in `setup.html` changes accordingly.

All rendering goes through `textContent` / `createElement`. Note bodies are learner-authored and
still never touch `innerHTML` (`CLAUDE.md`, DOM standard).

## 11. Testing

`phrasebook.test.js`, in Node, no browser:

1. Every catalogue id is unique across all categories.
2. Every catalogue entry has a non-empty `en` and `es`.
3. `resolvePhrases` returns ticked built-ins in catalogue order, then customs in their own order.
4. `resolvePhrases` drops ids that are no longer in the catalogue instead of throwing.
5. `resolvePhrases` on empty settings returns the seeded defaults, not an empty list.
6. Custom phrase ids cannot collide with catalogue ids (the `u.` prefix).
7. `resolveNotes` clamps title, body, and count to the caps.
8. `resolveNotes` preserves `open` through a round trip.
9. `turnsToText` clips a single repetition-loop turn to `TURN_MAX_CHARS` (the surviving half of
   the 2026-08-30 fix, now guarding `askReply` and `askReport` instead of `askHints`).

Then the standard gate: `node .claude/skills/preflight/scripts/preflight.mjs` and
`node --test *.test.js`. Preflight is what catches a `HINTS` left behind in one of the four
contexts, since at runtime that failure is silent.

Static checks cannot verify capture, permissions or WebGPU, and cannot verify that the chips
render correctly in the overlay's Shadow DOM. That needs a reload in `chrome://extensions` and a
real session.

## 12. Migration

A learner upgrading has `settings` without the three new keys. `resolvePhrases` and `resolveNotes`
treat missing keys as the seeded defaults, so no migration step runs and no version field is
needed. Stale `lastUi.hints` in a suspended service worker is irrelevant: module-level state is
lost on suspension anyway (`CLAUDE.md` invariant 5), and `UI_SYNC` rebuilds from storage.

## 13. Out of scope

Notes are **composed in Settings**. In session they can only be opened and closed (and that is
persisted). Editing a note mid-conversation would mean an editor in three views; the
`sessionContext` textarea in `sidepanel.html:48` already shows the pattern if it is wanted later.

## 14. Decisions taken without section-by-section review

Approved in chat as a whole ("de una"), not section by section:

- The catalogue's exact contents (§6.1) — thirty-eight phrases chosen by me.
- The caps in §7 (60 / 2000 / 20 / 40).
- Seeding `time.*` and `clarify.*` as defaults rather than starting empty.
- Deleting `CONTEXT_CHANGED` (§8) — a protocol removal, justified by `askStarter` going away.
