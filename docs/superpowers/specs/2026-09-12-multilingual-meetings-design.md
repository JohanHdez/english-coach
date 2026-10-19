# Multilingual meetings: English and Spanish in one conversation

A meeting with Canadians and Latinos has two languages in it. Today the extension can only
follow one of them, and mangles the other.

## The defect

`settings.lang` is a single value for the whole session, and it silently decides six
independent things: which Whisper model is loaded, which language is forced on every
transcription, which language Web Speech listens for, which mode the coach runs in, which
system prompt the report uses, and whether anything is translated.

So when a Latino speaks Spanish in a session configured for English, one of two things happens:
the loaded model is `whisper-base.en`, which only understands English, or the model is
multilingual and the language token is pinned to English anyway. Either way the turn comes out
as English that was never said. Half the meeting is unreadable, and the report grades the
learner on a conversation it misheard.

## What the learner gets

Each turn transcribed in the language it was actually spoken, labelled with that language, and
the Spanish translation under the turns that are not already Spanish. An English turn from a
Canadian reads as it does today, with its Spanish line. A Spanish turn from a colleague reads
as Spanish, untranslated, because translating it would be noise.

Scope is English and Spanish. Not French, not open detection.

## Decisions this design rests on

| Decision | Chosen | Consequence |
|---|---|---|
| Languages | English + Spanish | The multilingual `base` model covers both; `translate.js` needs **no change**, because the only pair required is the en→es it already has |
| Display | Each turn in its own language, Spanish translation only for non-Spanish | Translation becomes a per-turn decision instead of a per-session setting |
| Engine | **Split**: previews always local, authoritative turns follow the engine setting | Spanish quality comes from `whisper-large-v3` instead of local `base`; real audio leaves the machine; the live line stays local, free and fast |
| Coach provider | **Claude first**, after transcription is stable | Transcription is untouched by it (Claude has no speech-to-text); one existing setting flips both the reply and the report; the token ceilings must move first, §7(a) |

### Measured facts behind the engine choice

- Groq `whisper-large-v3-turbo` costs **$0.04 per hour of audio**; `large-v3`, $0.111. Billing is
  per audio hour, never per token.
- **Minimum billed length is 10 seconds per request.** This extension sends one request per
  segment, and segments typically run 4–6 s, so the effective rate is roughly 2–2.5× the raw
  audio time. A one-hour meeting with ~40 minutes of speech is about 480 requests ≈ **5 US
  cents**, at ~10–15 requests per minute of speech.
- **Language detection costs nothing in either engine.** With Groq it is intrinsic to Whisper's
  decoding and arrives inside the same request that returns the text — omitting the `language`
  parameter is all it takes, and the price does not change. Locally it is text analysis
  (§3): about 2 microseconds, no network. No design here ever asks a language model what
  language something is in.

## Architecture

### 1. Split the engine — ship first, valuable on its own

This is a defect fix independent of multilingual support. Today choosing the Groq engine
disables the live line completely: `previewEligible` refuses when `engine === 'api'`, `drain()`
discards any preview queued before the engine flipped, and `start()` skips loading the local
model. On a machine where Chrome's on-device Web Speech never emits — the reference machine —
that leaves the learner with no live text at all.

The engine setting governs **authoritative turns only**:

- `previewEligible` stops testing `s.engine !== 'api'`.
- `drain()` routes by `seg.preview`: a preview always goes to `localTranscribe`, a real segment
  follows the engine.
- The local model is initialised whenever previews are wanted, not only when the engine is local.

Two consequences to state rather than discover. On the API engine the local model is now
downloaded as well (~90 MB) — that is the price of a live line, and it is paid once. And
provisional audio still never leaves the machine, which becomes a guarantee worth stating
positively: only speech that has finished being spoken is ever sent anywhere.

### 2. Language becomes a property of a turn

- Every transcript entry carries `lang` (`'en'` or `'es'`). Entries written by earlier versions
  have none; they are read as the session language.
- `PARTIAL` carries `lang`, so a view knows whether to translate the live line.
- **`foldIntoTranscript` must stop merging across languages.** It currently merges consecutive
  same-speaker turns within `MERGE_GAP_MS`. On the tab track, which carries every remote
  participant, consecutive turns routinely alternate language — merging them would put English
  and Spanish in one bubble under a single translation. Language joins the merge condition.
- A speaker's `stitch` state resets when their language changes, for the same reason it resets
  at a cut: the accumulated line would otherwise mix two languages.

### 3. `langid.js` — a new pure module

Pure logic, no `chrome.*`, testable in Node, in the same family as `segmenter.js` and
`stitch.js`.

`detect(text)` returns `{ lang, confidence }`, and `lang: null` when the text carries no
evidence either way. Two signals: characters only Spanish uses in ordinary writing (ñ, á é í ó
ú, ü, ¿, ¡) and frequent-word coverage measured against both languages.

A prototype scored **13 of 13** on realistic meeting utterances, including the cases built to
break it: bare single words (`Okay.`, `Sí.`, `Gracias.`, `Thanks.`), code-switching (`El
dashboard de marketing no carga el feedback` → Spanish), and shared jargon with no evidence
(`Marketing, software, cloud, dashboard`), where it correctly declines to guess. 100,000
detections ran in 227 ms.

It is used to label a turn when the engine supplies no label, and as the signal for the local
re-pass in §5. Chrome's built-in `LanguageDetector` is deliberately **not** the primary signal:
the project already avoids its sibling `Translator` inside the offscreen document because
availability there is undocumented, and that is exactly where this decision has to be made. It
may later refine `langid.js`; it may not replace it.

### 4. Deciding a turn's language on the API engine

Omit `language` from the Groq request so Whisper detects it, and ask for `verbose_json`. If the
response carries a `language` field, that is the label. If it does not — the documentation does
not promise it — label with `langid.js`. No extra request either way, no extra cost.

This is why the split engine improves the feature and not only the quality: with detection
happening inside the transcription, the archived transcript needs no detection machinery of its
own.

**The previews still need a language, and this is where they get it.** A preview is transcribed
locally even when the engine is Groq, so something must tell it which language to decode. On
this path nothing has to guess: **the language Groq detected for a speaker's last authoritative
turn becomes the language their next preview is decoded with.** The live line therefore converges
on the right language within one turn of a speaker switching, and no re-pass is ever needed. It
also means §5 is not a prerequisite — a learner on the API engine gets working multilingual
meetings from phase 2 alone.

### 5. Deciding a turn's language on the local engine

This path is for a learner with no API key, or who has turned the API off. There is no
authoritative detection to lean on, so the circle has to be broken after the fact. Each speaker
carries a sticky language — the same field §4 sets from Groq's answer, here inferred instead:

1. transcribe the real segment with that speaker's current language;
2. run `langid.js` on the result;
3. if it names the other language with `confidence >= 0.5`, re-transcribe **once** with that
   language, keep that text, and label the turn accordingly — 0.5 is the starting value, pinned
   by a test and calibrated against the `langid.test.js` corpus rather than chosen from memory;
4. the sticky language itself only moves after two consecutive agreements, so one bad pass
   switches a turn but never flips a speaker.

Previews never re-pass. They use the sticky language, they may be wrong, and the authoritative
bubble corrects them a moment later — which is precisely what the provisional/authoritative
split exists for. The cost of a wrong guess is one extra local pass on that segment: CPU and
latency, not money.

**The one assumption that cannot be checked without a real meeting:** whether `whisper-base`,
forced to the wrong language, produces text `langid.js` can flag. If a session shows it cannot,
the fallback is already designed — transcribe the first ~2 s twice, once per language, score
both with `langid.js`, then transcribe the segment once with the winner. It costs a probe on
every turn instead of a re-pass on the wrong ones, and it does not depend on mis-forced output
being recognisable.

### 6. `'multi'` as a session language

`settings.lang` gains a third value. Every site that reads it must handle it, or it silently
does the wrong thing in one layer:

| Site | Today | With `'multi'` |
|---|---|---|
| `worker.js` `modelForLang` | `.en` model unless `'es'` | multilingual sibling (strip `.en`) |
| `worker.js` transcribe | `opts.language` from the session | language arrives per request — the `transcribe` message carries it |
| `offscreen.js` `apiTranscribe` | forces `language`, `response_format: json` | omits `language`, asks for `verbose_json` |
| `offscreen.js` `startLiveLayer` | one recogniser, session language | no Web Speech: one recogniser serves one language, and the preview lane covers both |
| `coach.js` `langMode` | Spanish mode when `'es'` | English-teaching mode, **excluding the learner's Spanish turns from grading** — otherwise the report corrects good Spanish as bad English |
| `sidepanel.js` / `overlay.js` `traducir()` | per session | per turn, from `entry.lang` |
| `setup.js` `packFor` | picks a Web Speech pack | none needed |

Multilingual is an opt-in mode and never the default, because it forces the multilingual model,
which is **meaningfully weaker in English** than the `base.en` in use today. Setup should
recommend `small` (~250 MB) for anyone who picks it.

### 7. Claude as the primary coach provider

The learner is making Claude the priority for the two model-backed features — the suggested reply
and the closing report. This is not a transcription decision: Claude has no speech-to-text
endpoint, so transcription stays local and on Groq exactly as §1–§6 describe.

**One setting governs both features.** `reportProvider` and `reportModel` are read by `askReply`
as well as `askReport`, so the switch is single. The name says "report" and decides the reply too;
renaming it needs a stored-settings migration and is out of scope here, but it should be recorded
as debt rather than left to mislead the next reader. `resolveProvider` already falls back to the
other provider when the preferred one has no key, and a fallback runs `models[0]` of the provider
it lands on — **the order of `PROVIDERS.anthropic.models` is therefore load-bearing, not
cosmetic.**

#### What has to change before Claude can carry this

Checked against the current API reference, not from memory.

**(a) The token budgets were calibrated for models that do not think, and Claude Opus 5 thinks by
default.** This is the highest risk here, and the project has already been bitten by the identical
mechanism on the other provider: `coach.js`'s own comment records that the gpt-oss models "spend
reasoning tokens from `max_completion_tokens` BEFORE they write the JSON, so a tight cap truncates
the object mid-key", which is why the reply budget sits at 1200. On Claude Opus 5 adaptive
thinking is **on by default** and its tokens come out of `max_tokens` the same way. With the reply
at 1200 and the report at 2800, a thinking model can spend the ceiling before it writes anything
the learner sees. Current guidance for non-streaming requests is roughly 16000, and the report is
the call that most needs the room. Left unchanged, the failure presents as "Claude is broken"
rather than "the ceiling is too low", which is why it is a prerequisite and not a refinement.

**(b) The Claude path ignores the schema.** `ask()` hands `schema` to `callGroq` and never to
`callAnthropic`, which does not even accept the parameter. Groq gets constrained decoding
(`json_schema` with `strict: true`); Claude gets free-form text that `parseJson` then rescues by
slicing from the first `{` to the last `}`. Claude's equivalent is structured outputs —
`output_config: { format: … }` on the request; the older `output_format` parameter is deprecated.
This is the difference between the suggested reply being reliable and being best-effort on the
provider that is about to become primary.

**(c) A refusal arrives as HTTP 200 with no text.** Safety classifiers can decline a request with
`stop_reason: "refusal"` and a `stop_details.category`, and the status is still 200.
`callAnthropic` reads `data.content` without inspecting `stop_reason`, so a refusal reaches the
learner as an empty suggestion with no explanation. Check `stop_reason` before reading content —
and the same guard catches a `max_tokens` truncation, which (a) makes likely.

**(d) Server-side fallbacks are the documented default for Opus 5 code.** Sending
`betas: ["server-side-fallback-2026-07-01"]` with `fallbacks: "default"` routes a refused request
by category instead of failing it. Include it by default.

**(e) The model list needs current ids, with Opus 5 first.** The recommended default for new
Claude code is `claude-opus-5`, and because `models[0]` is what a fallback runs, it belongs at the
head of the list. The list also carries a date-suffixed Haiku id; model ids are complete as-is and
date suffixes are not appended, so that entry is wrong or stale — but a wrong id is a hard
failure, so **confirm it against the Models API (`GET /v1/models`) before editing it** rather than
on this document's word. Prices for budgeting, per million tokens in/out: Opus 5 $5/$25,
Sonnet 5 $2/$10, Haiku 4.5 $1/$5.

**(f) Two things must not be "harmonised" with the Groq path.** `callGroq` sends
`temperature: 0.3`; on Claude Opus 5 and Sonnet 5 sampling parameters are **rejected with a 400**,
so their absence from `callAnthropic` is correct and must stay. And the raw `fetch` is correct
too: the official SDK is the normal choice for JavaScript, but this project forbids a build step,
a bundler and dependencies, so raw HTTP is the documented exception rather than an oversight —
`anthropic-dangerous-direct-browser-access` is already set for the browser call.

#### What multilingual meetings ask of this path

Once the transcript holds two languages the coach's input changes shape, and none of it is
automatic:

- turns must reach the model **labelled with their language**, or the report will correct Spanish
  as though it were bad English;
- the report must grade **only the learner's English turns**, reading their Spanish ones as
  context;
- the suggested reply answers in **the language of the most recent `them` turn** (decided), because
  a reply in the wrong language is useless in a live meeting, and the coaching value concentrates
  on the English ones anyway. When there is no `them` turn yet, it follows the session default.

## Error handling

Every failure keeps a turn rather than losing one.

- Groq returns no `language` field → label with `langid.js`.
- `langid.js` returns `null` → keep the sticky language, do not re-pass.
- A re-pass fails → keep the text from the first pass.
- An entry has no `lang` (written by an older version) → read as the session language.
- Chrome's `Translator` unavailable → no translation, exactly as today.
- Claude returns `stop_reason: "refusal"` → say so, with the category; never render an empty
  suggestion as though the model had answered.
- Claude returns `stop_reason: "max_tokens"` → say the answer was cut off, rather than showing a
  half-written report as finished.

## Testing

- `langid.test.js`: the prototype's cases, plus no-evidence, accent-only, code-switching, and the
  confidence threshold.
- `segmenter.test.js`: folding must not merge across languages, and must still merge within one.
- `stitch`: a language change resets the accumulated line.
- Message contract: `PARTIAL`'s new `lang` field and the `transcribe` worker message's new
  language field documented before they are sent; preflight run on every step.
- `coach.test.js` reaches further than it looks: `turnsToText` is exported and pure, and the suite
  already swaps `globalThis.fetch`. So §7 is testable without a network — that each turn reaches
  the model carrying its language, that the learner's Spanish turns are framed as context rather
  than as English to correct, that the reply targets the language of the latest `them` turn, that
  the request body carries structured outputs and the fallbacks beta, that it carries **no**
  sampling parameter, and that a faked `stop_reason` of `refusal` or `max_tokens` surfaces as a
  message instead of an empty answer.

Three things static checks cannot reach, and no phase may claim otherwise: transcription quality
in either language, the shape of Groq's `verbose_json` response, and the reliability of the
local re-pass in §5.

## Order of work

Transcription is stabilised first and Claude is elaborated properly afterwards, which is the
learner's own instruction. The one exception is §7(a): it is two lines, and without it a learner
who selects Claude today gets truncated or empty answers, so it rides along with phase 1.

1. **Split engine, `langid.js`, per-turn `lang` plumbing** (including the fold change), **plus the
   Claude token ceilings from §7(a)**. No unknowns, fully testable, and this phase fixes two live
   defects by itself — the dead live line on the API engine, and the budgets that truncate a
   thinking model.
2. **API multilingual path** (§4). Small, and the best Spanish this design can produce.
3. **Local multilingual path** (§5). Carries the only genuine unknown, and can be deferred
   without blocking 1 or 2 — a learner on the local engine keeps exactly today's behaviour until
   it lands.
4. **Claude as the primary coach provider** (§7): structured outputs, the refusal and truncation
   guards, server-side fallbacks, the model list, and the bilingual prompt requirements. Last by
   instruction, and it is the phase that most benefits from a real multilingual transcript
   existing first — the prompts cannot be tuned against a conversation the extension cannot yet
   record.
