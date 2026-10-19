# Phrasal verbs and the practice loop: design

Status: sections 1–7 approved section by section in conversation. Sections 8–13 written from
decisions taken in that conversation but not reviewed section by section — see §14.

## 1. Problem

Two holes, and they are the same hole seen from both ends.

**What the other person says is thrown away.** `makeReport` analyses only the learner's own
turns — `offscreen.js` says so outright:

```js
// The report only analyses the learner's own turns, which are exactly the ones
// the queue defers.
```

The interlocutor's half is where the natural English lives: the phrasal verbs a Spanish speaker
has no intuition for, and the idioms that cannot be deduced from their words. It is transcribed,
translated, shown once and discarded.

**What the report advises is never checked.** The report already produces
`## Conectores y frases para aprender` and `## Vocabulario para subir de nivel`. That advice is
write-only: generated, read once, and gone. Nothing ever establishes whether the learner used any
of it. That makes the report a school report, not a coach.

## 2. Goals

1. Recognise phrasal verbs and idioms in the interlocutor's turns, with no model call.
2. Accumulate them across sessions so that recurrence — the strongest "learn this" signal there
   is — becomes visible.
3. Measure the passive/active gap: heard versus actually used.
4. Turn the report's suggestions into a short backlog whose progress is verified automatically.
5. Give the learner a paste-ready opening instruction for a third-party practice partner.

## 3. Non-goals

- **No model call anywhere in detection.** The set is closed; it is curated and checked in.
- No spaced repetition, streaks, levels or points. Three states, and that is all.
- No new screen. The report page and the Settings page absorb everything.
- No new runtime dependency, build step or bundler.
- No new Chrome permission. `chrome.storage.local`'s default quota is enough (§7).
- Nothing new in the live layer: none of this appears during a session except §11.

## 4. Constraints

| Constraint | Source | Consequence |
|---|---|---|
| A content script cannot import modules | invariant 9 / `overlay.js` | Detection runs in the offscreen document and in extension pages only. The overlay never loads the dictionary. |
| The content script must stay cheap to load | invariant 6 | A ~100 KB dictionary must never reach `overlay.js`. |
| The offscreen document has no `chrome.storage` | invariant 4 | Every read and write goes through `STORE_GET` / `STORE_SET`. |
| Pure logic stays pure | CLAUDE.md | The dictionary, the matcher and the store transforms import no `chrome.*` and run in Node. |
| No remote code | invariant 7 | The dictionary is authored and checked in. No download, no licence question. |

## 5. The dictionary — `phrasal-data.js`

Data only, no logic. Split from the matcher on purpose: it grows to ~700 entries, and adding
entries must never touch the file where the recognition logic lives.

```js
{ id: 'pv.figure-out', kind: 'phrasal',
  lemma: 'figure', particle: 'out', sep: true,
  en: 'figure out',
  es: ['averiguar', 'resolver', 'entender'] }

{ id: 'id.hit-ground-running', kind: 'idiom',
  en: 'hit the ground running',
  es: ['arrancar a pleno rendimiento'] }
```

- `id` is stable and is the key of the accumulated store. Renaming one orphans a learner's history.
- `es` is an **array**. *take off* is despegar, quitarse and irse; without a model those cannot be
  disambiguated, so all senses are shown. Choosing one would be guessing.
- `sep: true` means the particle may be separated from the verb.
- `not: ['at']` (optional) discards the match when that token follows the particle. It is the
  targeted guard for *look up the answer* versus *look up at the sky*, and it lives in the **data**,
  not in the code.
- **No CEFR level.** Tagging 700 entries by hand is a lot of curation for a filter that the
  learner's own "ya la sé" does better and with real evidence.

First tranche: ~150 phrasal verbs and ~60 idioms. The rest is data addition with no code change.

## 6. The matcher — `phrasal.js`

Pure. Imports the data, exports `findExpressions(text, entries)`.

1. **Lemmatisation.** Whisper emits *figured*, *figures*, *figuring*. Regular rules (`-s`, `-ed`,
   `-ied`, `-ing`, doubled consonant) plus a checked-in irregular table (~180 verbs). No library —
   none would be allowed anyway.
2. **Index by lemma.** `Map<lemma, entry[]>`: one lookup per token, not a sweep of the dictionary.
3. **Separability window.** With `sep: true` the particle counts up to 3 tokens after the verb,
   which covers *pick it up* and *pick the red phone up*. With `sep: false` (*run into*) adjacency
   is required.
4. **Longest match wins**, so *come up with* is never recorded as *come up*.

Idioms take a second path: normalised n-gram against a `Set`. They barely inflect and never
separate, which is why they ride almost free on machinery built for the hard case.

**False positives cannot be eliminated without a model.** Three layers, cheapest first:

- Exclude entries whose literal reading is as common as the idiomatic one (*get up*, *come in*,
  *sit down*). They are also the ones a B1 already owns, so nothing is lost.
- The per-entry `not:` guard.
- The learner's own "ya la sé", which prunes the rest permanently.

The same matcher runs over **both speakers**. The interlocutor's turns give what was heard; the
learner's give what was used. That is where the passive/active gap comes from, at no extra cost.

## 7. The store — `vocabulary`

One new key in `chrome.storage.local`, indexed by dictionary `id`:

```js
vocabulary: {
  'pv.figure-out': {
    count: 7, sessions: 3, lastAt: 1735689600000,
    example: 'we need to figure out how to ship this',
    used: 2, state: 'pending',
  },
}
```

- `sessions` is the load-bearing number. Hearing *pull off* five times in one call means a topic
  came up; hearing it in five separate meetings means it must be learned.
- `used` counts appearances in the **learner's own** turns.
- `state` is `pending` | `practised` | `archived`. `practised` is set automatically the first time
  `used` goes above zero; `archived` is only ever set by the learner.

Size: a few hundred entries at ~200 bytes is ~100 KB, well inside the default 10 MB quota. What
grows in this extension is the transcript, not this.

**Three contexts write here** — the offscreen document when a session ends, the report page when
the learner archives an entry, and Settings when they prune. To stop three copies of the merge
rule drifting apart, the transforms are pure functions in `phrasal.js`:

```js
tallyVocabulary(store, hits, { at, speaker })   // merge one session's hits
markState(store, id, state)                     // pending | practised | archived
```

Each caller only reads, calls, writes. It is the shape `toggleNoteOpen` already uses for the same
reason.

**What that does not solve, stated plainly:** `chrome.storage` is last-writer-wins. Archiving an
entry in an open report page at the same instant another session ends will lose one of the two
writes. It is improbable, and building locking for it is not worth the complexity. It is recorded
here rather than hidden.

## 8. The report

Two changes in `makeReport()`, both about ordering and both load-bearing.

**Count first, ask the model second.** Detection is local, synchronous and free; the model is
slow, remote and fallible. Today a failure in `askReport` (no API key, no network, Groq's rate
limit) stores nothing at all. Inverting the order means the vocabulary survives that failure, and
the report opens with the list plus one line saying the analysis could not be generated.

**The "you did not speak" guard moves.** Today:

```js
if (!transcript.some((t) => t.speaker === 'me')) return { ok: false, error: 'sin intervenciones' };
```

That aborts everything. It must instead skip only the model pass: an hour spent listening without
speaking is precisely when the heard vocabulary is worth the most.

The section is not written by the model. It is a data block in `report.html`:

> **Oíste 47 expresiones** · 40 phrasal verbs, 7 modismos — **usaste 3**
>
> | Expresión | Hoy | Sesiones | En la conversación |
> |---|---|---|---|
> | **figure out** · averiguar, resolver | 4 | 3 | *"we need to figure out how to…"* |

Each row carries one control: *ya la sé*. It sits after the model's report and before the raw
transcript — it is study material, worked through last. When the model fails it becomes the only
content, which is the whole reason it is independent of it.

## 9. The practice loop

The report already proposes phrases. Today they die on the page. They become a short backlog
instead.

**They are proposed, not imposed.** Each suggestion gets a checkbox in the report; only what the
learner ticks enters the store. This is deliberately the opposite of §7, where heard vocabulary is
captured automatically — and the asymmetry is the point. Heard vocabulary is dozens of items and
the learner cannot know what they do not know. Suggestions are five, drawn from their own
conversation, read with attention at that moment. Auto-adding five per session produces fifty
pending entries in ten sessions, a graveyard nobody opens, and the loop dies with it.

**Corrections of the learner's own sentences are the third source, and the most valuable.** The
report already produces `## Errores de gramática` (| Dijiste | Correcto | Por qué |) and
`## Traducciones literales del español`. Those come from the learner's own mistake in their own
conversation, which makes them worth more than any generic suggestion — and today they die on the
page like the rest.

They break the progress signal, though, and the fix has to be designed in rather than discovered
later. A whole sentence — *"I'll head to the gym and then take my dog for a walk"* — is never
repeated verbatim, so normalised matching would never fire and the entry would sit at `pending`
forever however well the learner had learned it.

What is learnable and matchable is not the sentence but the **chunk that carries the correction**:

| Said | Correct | Stored as the chunk |
|---|---|---|
| *go **into** the gym* | *go **to** the gym* | `go to the gym` |
| *take a walk **with my dog*** | *take **my dog for a walk*** | `take for a walk` |

So a correction stores both: the full sentence as context, so the learner remembers where it came
from, and a 2–5 word chunk which is what the matcher looks for in later turns. The chunk is
**requested from the model in the same JSON**, never guessed by splitting the sentence.

Two guards, because the model will sometimes return a useless chunk: reject anything under two
tokens, and reject chunks made only of function words (*go to the*), which would match constantly
and mark everything practised on the first sentence the learner utters.

A risk specific to this source: `coach.js` already tells the model to ignore what the recogniser
mangles and not to charge it to the learner as an error. Corrections of things the learner never
said will still get through. That is one more reason the learner ticks what enters, not the model.

**Two kinds of entry now share the store.** Catalogue entries have a stable `id`, a lemma and a
particle. Suggested entries are arbitrary text with none of that. They are stored with
`kind: 'suggested'` and an `id` derived from their normalised English, and they are matched by
normalised phrase — the same path the idioms already use.

**The report must emit structure, not prose.** Recovering suggestions by regex over
`## Conectores y frases para aprender` is the kind of thing that passes every test and breaks the
day the model rephrases a heading. They are requested as JSON alongside the markdown, reusing the
machinery that already exists in `coach.js`: `REPLY_SCHEMA`'s shape, `groqResponseFormat` and
`parseJsonLoose`.

**Progress is measured, not self-reported.** The matcher runs over the learner's own turns, so a
pending phrase appearing in their speech is hard evidence:

> *Te propusimos **figure out** hace tres sesiones. Lo has usado 2 veces desde entonces.*

No model grades anything. And the measurement does not depend on any third-party tool cooperating.

## 10. Settings — the review screen

A section **"7. Mi vocabulario"**, the same list pattern the chips and notes already use.

- Sorted by `sessions`, then `count`. The most recurrent is what to study.
- Two tabs: **Pendientes** / **Ya las sé**. Without the second, archiving would be irreversible,
  and that is the failure mode that kills these lists.
- A CSV export, for Anki or anywhere else.

No new page: Settings is already where this extension's lists are curated.

## 11. The session prep button

The learner practises with a third-party voice agent. The extension cannot control it, but it can
write the opening instruction. A **Preparar sesión** button copies to the clipboard:

> Let's have a natural, everyday conversation about *{situation}*. Ask me **one short question at a
> time** — don't monologue, and don't over-explain. Steer the conversation so I have to use these
> expressions, and correct me briefly if I get one wrong: *{pending list}*.

`{situation}` comes from the `sessionContext` field that already exists in Settings.

**No model call.** The structure never varies; only the list does. It is a template with a slot —
generating it would be the closed-set mistake in a new costume. Precedent: the *Copiar prompt*
button in `sidepanel.js`.

Honest limit: nothing verifies the agent obeys. It does not need to — §9 measures the outcome, not
the instruction.

## 12. Protocol impact

**None.** Detection runs inside `makeReport()` in the offscreen document, over a transcript already
in storage, and the store is written through the existing `STORE_SET`. No message type is added,
renamed or rerouted, so `message-contract/SKILL.md` is untouched and preflight's protocol check
stays green without an edit.

`report.html` and `setup.html` are extension pages and import `phrasal.js` directly. `overlay.js`
never sees the dictionary — §4.

## 13. Testing

Everything that matters here is pure, so `phrasal.js` would be the first module in this repository
with real coverage from day one.

| What | Why it earns a test |
|---|---|
| Inflection | *figured / figures / figuring* → *figure*, plus the ~180 irregulars |
| Separability | *pick it up*, *pick the red phone up*, and *pick up at the airport* not counting |
| Longest match | *come up with* must never be recorded as *come up* |
| The `not:` guard | *look up the answer* yes, *look up at the sky* no |
| Idiom path | normalised match, and no false hit on a substring |
| `tallyVocabulary` | merges without duplicating; `sessions` rises once per session, not per hit |
| `markState` | round trip, and a missing id does not throw |
| Suggested entries | normalised id is stable across whitespace and case |
| Correction chunks | under two tokens rejected; function-word-only chunks rejected |
| Chunk matching | the chunk fires on a later turn that is not the original sentence |

`capture.js` and `report.js` remain untested. This feature does not fix that, and does not pretend
to.

## 14. Decisions taken without review

Sections 8–13 follow from decisions made in conversation but were not reviewed section by section.
Three deserve explicit attention before implementation:

1. **Where pending phrases surface during a session.** The proposal is a *Para practicar* category
   inside the existing Frases tab, reusing the category filter built for the chips. That makes
   `resolveChips` read `vocabulary` as well as `settings`, and `CHIP_KEYS` in `background.js` must
   watch that key. The alternative — a third tab — is more prominent but is often empty.
2. **The `practised` state is one-way.** Once detected in the learner's speech an entry never
   returns to `pending`, even after months without using it. Deliberate: the alternative is decay,
   which is spaced repetition through the back door (§3).
3. **A correction's `practised` state fires on the chunk, not on the sentence.** Saying *"go to
   the gym"* in any later sentence marks the correction practised. That is the intent — the chunk
   is the lesson — but it does mean the learner can be credited without ever reproducing the
   original sentence.
4. **The example sentence is stored verbatim** from the transcript. It is the learner's own
   conversation, never leaves the machine, and is subject to the same storage as the transcript.
