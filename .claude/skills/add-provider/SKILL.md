---
name: add-provider
description: Add a new LLM or speech-to-text provider to the coach or the transcription engine, wired through every layer it touches. Use when asked to support another API, a local server (Ollama, LM Studio, vLLM), or a self-hosted endpoint.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
---

# Adding a provider

Providers are pluggable by design. `coach.js` owns the adapters; everything else reads from the
`PROVIDERS` table, so a correct addition touches few files and a wrong one leaves the settings
page and the runtime disagreeing.

## Check first: does it need code at all?

An OpenAI-compatible server does not. `groqBase` is user-configurable and the Groq adapter speaks
the OpenAI chat-completions shape, so Ollama, LM Studio, vLLM, and most proxies work today by
pointing `groqBase` at them and using any non-empty key. Say so instead of writing an adapter.

Code is needed only for a genuinely different wire format — a different auth header, request
body, or response shape.

## Coach providers

1. **`coach.js` — register it.** Add an entry to `PROVIDERS` with `label`, `keyField`, and
   `models`. The `keyField` names the settings key holding the credential; keep the
   `<name>Key` convention.
2. **`coach.js` — write the adapter.** One `call<Name>({ key, model, system, user, maxTokens, json, base })`
   returning plain text. Mirror the existing two: throw `CoachError` with
   `` `${label} ${status}: ${body.slice(0, 180)}` `` on a non-OK response, and export a
   `<name>BaseOf(settings)` that reads a configurable base and strips a trailing slash. Then add
   the branch in `ask()`.
3. **`manifest.json` — add the host.** `host_permissions` needs the API origin. Add the specific
   origin, never a wildcard.
4. **`setup.html` — add the key field.** Copy the existing key input, matching `id` to the
   `keyField`. Do not add a model dropdown: `fillModelSelect` builds both selects from
   `PROVIDERS` automatically.
5. **`setup.js` — persist it.** Add the key to `DEFAULTS` (empty string) and read it in the save
   handler. The `provider:model` split for the live and report selects already handles the rest.

Nothing in `offscreen.js`, `sidepanel.js`, or `overlay.js` changes. If a change there seems
necessary, the abstraction was bypassed — go back and route it through `ask()`.

## Transcription engines

The speech engine is separate and not table-driven. `offscreen.js` branches on
`settings.engine` between `localTranscribe` (the Whisper worker) and `apiTranscribe`. A new
engine needs a branch there, an `<option>` in the `engine` select in `setup.html`, its own
options block, and its host in `manifest.json`. Audio reaches an API as a WAV blob from
`floatToWav` — 16 kHz mono PCM16. If the provider wants another container, convert in
`segmenter.js` so it stays testable, not in `offscreen.js`.

## Rules

- **A key never crosses providers.** Read it from its own `keyField` and send it only to that
  provider's base. Never log it, never put it in a URL.
- **Fail with a message the user can act on.** "Falta la API key de X (ábrela en Ajustes)" is the
  established shape. A raw status code is not.
- **Live hints must stay fast.** They run after every turn of the other speaker, debounced 1.2 s
  with a 6 s cooldown. A provider slower than roughly two seconds is unusable there — offer it for
  the report only, and say so.
- **Hints request JSON, and how you request it matters.** Prefer constrained decoding
  (`json_schema` with `strict: true`) over after-the-fact validation (`json_object`). Groq's
  `json_object` mode validates what the model already produced, and reasoning models such as
  `openai/gpt-oss-*` leak reasoning tokens into that output — Groq then rejects the whole call
  with `json_validate_failed` and the chips never appear. `groqResponseFormat()` in `coach.js`
  routes per model; extend it rather than making every model share one mode. `parseJsonLoose`
  is a tolerance layer for providers with no structured mode at all, not a substitute.
- **Give reasoning models room.** Reasoning tokens count against `max_completion_tokens`. A
  budget sized for the visible answer alone will truncate the response.
- **User-facing strings are Spanish**, matching `setup.html`. Prompts stay as they are.

## Verify

```bash
node .claude/skills/preflight/scripts/preflight.mjs
```

Then in Chrome: reload the extension, save a key in Options, and exercise the path you added —
a live hint for a live provider, a report for a report provider. Report which of the two you
actually ran. Static checks confirm nothing about whether the API answers.
