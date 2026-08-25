# English Coach — conversation transcriber for Chrome

A Manifest V3 extension that records **two separate tracks** — the tab's audio (the person you
are talking to) and your microphone (you) — transcribes them, and hands you the conversation
labelled by speaker, ready to analyse your English.

The extension's interface is in **Spanish on purpose**: it is a tool for Spanish speakers
practising English, so the hints, the nudges and the report are written in the learner's
language. The codebase and its documentation are in English.

- **Free end to end**: Whisper runs inside your browser with `transformers.js` + ONNX Runtime,
  and the coach uses Groq's free tier. No credit card at any step.
- **Private by default**: audio never leaves your machine.
- **No minute limits**, no account, no subscription.
- Translates what the other speaker says into Spanish using Chrome's built-in translator, also
  without a key.
- Optional: an API engine (Groq) if you want maximum accuracy, and paid Claude for finer reports.

## Install

> Not on the Chrome Web Store yet. It installs in developer mode: about a minute, no account, and
> nothing to compile.

1. **[Download the latest version (.zip)](https://github.com/JohanHdez/english-coach/archive/refs/tags/v1.17.0.zip)**
   and unzip it wherever you want to keep it — Desktop or Documents is fine. **Do not delete the
   folder afterwards**: Chrome loads the extension from there every time it starts.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder you just unzipped (the one containing
   `manifest.json`).
5. The settings page opens. Click **Grant microphone permission**.
6. For the coach (suggestions and report), paste a free Groq API key into section 3. Create one
   at [console.groq.com/keys](https://console.groq.com/keys) with a Google or GitHub account,
   **no credit card**, in under a minute. Skip this step if you only want transcription.
7. Click **Save settings**.
8. Pin the extension to the toolbar (puzzle icon → pin).

To update later, download the new zip, and in `chrome://extensions` remove the old card before
loading the new folder. Unpacked extension IDs depend on the folder path, so leaving both loaded
gives you two copies of the extension running at once.

## Use

1. Open the tab where the conversation happens (Google Meet, Zoom web, Teams web, YouTube, a
   practice app…).
2. **From that tab, press `⌘⇧S`** (`Ctrl+Shift+S` on Windows). The extension icon and right-click
   → «English Coach: empezar / detener transcripción» work too. Any of the three starts recording.
3. The coach appears inside the page.
4. The first time, the model downloads (~90 MB with `base.en`); after that it is cached and works
   offline.
5. When you finish: **Copy**, **Download** (.md) or **✨ Analizar mi inglés**, which copies the
   transcript together with a coaching prompt ready to paste into Claude.

> You keep hearing the tab's audio normally: the extension reinjects it to the speakers.

## Why the keyboard shortcut is required

Chrome only lets an extension capture a tab's audio if the user **invoked** it from that tab, and
only three gestures count as an invocation: clicking the extension icon, using one of its
keyboard shortcuts, or picking an entry from its context menu. A button inside the side panel or
inside the page does not count, however much it looks like one: Chrome answers
`Extension has not been invoked for the current page`.

There is no way around it either. Chrome's native picker (`chrome.desktopCapture`) was tried from
both the service worker and an extension page: in both cases the resulting permission cannot open
the stream in the capture engine, and it fails with `Error starting tab capture`. The shortcut is
not a convenience, it is the only route.

The microphone has no such restriction: if you only record your own voice, or the other speaker
comes in through an input device (BlackHole), the panel button works fine.

## Where everything shows: the in-page overlay

On any page there is a **discreet pill** at the bottom right («🎙 English Coach»). Clicking it
opens the card and **tries to start the session right away**: it starts with no shortcut when
Chrome already lets the extension capture that tab (an earlier session or invocation on it), and
always when the other speaker comes from an input device or only your microphone is recorded.
Only the *first* capture of a tab's audio still needs the invocation Chrome insists on (see
above) — in that case the card shows the shortcut instead of starting.

The main interface is a **floating overlay inside the tab itself**: it appears when recording
starts filling the screen's height, drags from its header, **resizes from the bottom-right
corner**, collapses with «–» and hides with «✕». The coach stays pinned — chips and openers at
the top, the suggested reply next to its button at the bottom — and only the conversation
scrolls between them, so a long conversation never pushes the help out of sight.

The bar **follows you**: if you switch tabs during a session it reappears in the new one, and if
you reload the page it comes back with the turns and chips it already had. It only disappears
when you stop recording.

It exists because the side panel is not always available: it closes when you share the tab, it
does not appear in popup or app windows, and some windows have no extension bar. The overlay
lives in the page, so it survives all of that. The side panel is still there for the full view
(whole transcript, export, settings), but it is no longer required: **recording and the coach
work with the panel closed**.

If you prefer, Settings can also open a small **separate window** with the full coach. It is a
real Chrome window: it does not depend on the tab, the side panel or the extension bar, so
sharing your screen does not take it down.

And if something fails at startup you see it three ways: a **system notification**, the saved
error text (it shows when you reopen the panel even if it was closed when the failure happened),
and the overlay itself inside the page.

## Coach: live suggestions and a closing report

Two optional layers that need a free API key (section 3 of Settings).

**During the conversation.** Each time the other person stops talking, a bar appears with 3–4
expressions you are likely to need (`catch up on`, `off the top of my head`…), two or three
ways to open your answer («The way it works is…»), and a short nudge in Spanish about how to
frame it. They are chips, not paragraphs: readable at a glance without losing the thread. Long
monologues are split at breath dips, so the transcript, its translation and the chips keep
flowing while the other person is still talking instead of landing as one huge paragraph at
the end. On screen those pieces — and the fragments your own thinking pauses produce — **fold
back into one block per idea**: consecutive segments of the same speaker close in time extend
the previous turn instead of stacking a new one, and the translation is redone over the whole
merged thought rather than fragment by fragment.

If you get stuck, `⌘⇧E` (or `Ctrl+Shift+E`, or the «💡 Respuesta» button) gives you **one
answer, not a menu**: in a live conversation you read the first option anyway, so alternatives
are hesitation, not help. The answer is built to be read out loud — short sentences at your
level, everyday words, at most one technical term (shown **bold** so you spot it mid-sentence)
— and rendered big. Under it, two *richer versions with the precise terminology*, in small
type: those are for studying after the conversation, not for reading live. Connectors to open
your answer stay pinned above the conversation, where the live hints put them. One click copies
any phrase. It works even while focus is on the meeting tab.

**Your profile.** In Settings you can paste your experience as plain text (projects, tools,
results). Without it, the suggested reply can only be generic: when someone asks «tell me what
you actually built with them», the model has no idea what you built. With it, the reply is
grounded in what you really did, and the prompt forbids inventing employers, job titles or
figures that are not there — you are going to say this out loud as the truth. It is used for the
suggested reply and the report, **not for the chips**: those run every six seconds, and repeating
the profile in every round would exhaust the free tier's limit.

**Today's context.** Next to the profile there is a per-meeting field — «Contexto de hoy» — for
the topics of the conversation you are about to have: «entrevista técnica de Angular: signals,
standalone components, RxJS». With it, when a **knowledge question** lands and you blank on the
answer, the direct answer teaches you the right one, leaning on your notes plus the model's own
knowledge of the subject; the biography rule still holds (it never invents your experience). It
also feeds the report's meeting summary. It lives in Settings and in the side panel, and the
side panel copy can be edited **mid-session**: the next suggested reply already uses it.

The context also primes the session: when a session starts with notes in place, a one-off
**starter round** of chips appears before the other person has said anything — connectors and
phrases of that topic, and ways to open an answer. Editing the notes regenerates it, until the
first real conversation round takes over. That single extra call aside, the context is sent
only with the on-demand reply and the report, never with the periodic chips: those run every
few seconds and would burn the free tier's minute.

**Spanish sessions.** The side panel has a conversation-language selector. In Spanish mode the
extension becomes professional support in your native language — a technical interview in
Spanish, for example: transcription switches to the multilingual Whisper model (a new one-time
download; the `.en` models only understand English), the live layer listens in Spanish (it
needs Chrome's Spanish language pack), translation turns off (nothing to translate), the
suggested answer and the starter chips arrive in Spanish, and the closing report changes from
English teacher to **communication coach** — clarity, fillers, better phrasings and
professional formulas instead of grammar tables and CEFR levels. The language is fixed while a
session is running.

**When you finish.** Pressing Stop generates the report automatically and opens it in a tab. It
starts with a **meeting summary** — what was discussed and what was left pending (things agreed
to review, send or decide), so the conversation's action items are not lost — and then the
language coaching: how you did, a grammar table with the correction and the reason, calques from
Spanish, connectors and set phrases worth memorising for this kind of conversation, five
expressions that fitted and you did not use, filler words, and an approximate CEFR level with
three exercises for the week plus a coach's tip for the next conversation. It downloads as `.md`
so you can keep a history.

**One free Groq key covers everything.** Create it at
[console.groq.com/keys](https://console.groq.com/keys): no credit card. That is what ships by
default: `gpt-oss-20b` (~1 s) for the chips, and `gpt-oss-120b` for the report **and for the
on-demand suggested reply** — it is asked for once, not every few seconds, so the stronger
model's extra second is worth it, especially for technical answers.

Groq's free tier allows 30 requests per minute and 8000 tokens per minute. Comfortably enough:
suggestions have a six-second cooldown between rounds, and the report trims the transcript to fit
that budget even after a very long conversation. If you do hit the limit, the error says so and
waiting a minute is all it takes.

Claude is optional and **paid per use**. It only pays off if you want more nuanced reports; you
can use it for the report alone and leave suggestions on Groq. If you pick a provider whose key
you have not set, the extension uses the one you do have and tells you, instead of failing.

Everything points at Groq by default, but the endpoints are configurable (`groqBase` /
`anthropicBase` in the saved settings): that is enough to use an OpenAI-compatible server such as
Ollama or LM Studio without touching the code.

## Zoom / Teams / desktop FaceTime

A Chrome extension **cannot hear other applications**. On macOS the answer is a virtual audio
device:

1. Install [BlackHole 2ch](https://existential.audio/blackhole/) (free).
2. Open *Audio MIDI Setup* → **+** → *Create Multi-Output Device* → tick your speakers/headphones
   **and** BlackHole 2ch.
3. Set that multi-output device as the system output (so you keep hearing).
4. In the extension panel: **Audio del interlocutor → Dispositivo de entrada** and pick
   `BlackHole 2ch`.

Your microphone is recorded as usual, in parallel.

## License and donations

The code is under **GPL-3.0** ([LICENSE](LICENSE)): you may use, study, modify and distribute it
freely. The only condition is that if you publish a modified version, you publish its source too
under the same license — so whatever gets built on top stays free for everyone, which is the
reason this project exists.

`vendor/` contains third-party code under its own licenses, reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md): Transformers.js (Apache 2.0, Hugging Face) and
ONNX Runtime Web (MIT, Microsoft).

It is free and it will stay free. If you find it useful and want to support it, there is a
sponsor button on the repository — entirely optional, nothing in the project depends on it.

## Privacy

The full detail of what is processed, where and when is in [PRIVACY.md](PRIVACY.md). In short:
no server of our own, no analytics, no accounts. Audio never leaves your machine unless you pick
the API engine, and text only leaves if you enable the coach.

## Settings

| Option | What it does |
|---|---|
| Model | `tiny.en` (~40 MB, fast) · `base.en` (~90 MB, recommended) · `small.en` (~250 MB, more accurate) |
| Processing | GPU (WebGPU) is much faster; CPU is the compatible mode |
| Engine | Local Whisper (free, private) or the Groq API (`whisper-large-v3-turbo`, needs a key) |
| Short utterances | Discards noise and lone filler sounds («hmm», «uh», «ah») instead of transcribing them |
| Live transcription | Shows what is being said as it happens using Chrome's on-device recognition (139+); Whisper replaces it when the phrase closes |
| Translate to Spanish | A Spanish line under each of the other speaker's turns, using Chrome's built-in translator (138+). Free, no key, and the text never leaves the machine |
| Live coach | Vocabulary chips after each of the other speaker's turns + `⌘⇧E` for a full reply |
| Report | Automatic on stop, or on demand with «Informe de la sesión» |
| Separate window | Off by default: the coach lives inside the page. Turn it on if you are sharing the tab or want the coach on another monitor |
| Your profile | Plain-text experience (max 1500 characters) so the suggested reply talks about what you actually did |
| Today's context | Per-meeting notes (max 1500 characters) so the direct answer can also answer knowledge questions; editable mid-session from the side panel |
| Conversation language | English (coach + translation) or Spanish (professional support: multilingual model, Spanish suggestions, communication-coach report); in the side panel, per session |
| Coach models | Groq (`gpt-oss-20b/120b`, **free**) and Claude (`haiku-4-5`, `sonnet-5`, `opus-5`, **paid**), selectable separately |
| Shortcuts | `⌘⇧S` start/stop · `⌘⇧E` suggested reply. Change them at `chrome://extensions/shortcuts` |

## How it works

```
tab ────tabCapture───┐
                     ├─► AudioContext 16 kHz ─► AudioWorklet (100 ms blocks + RMS)
mic ──getUserMedia───┘                              │
                                                    ▼
                             energy VAD → phrases of 0.9–18 s; long utterances
                             split at breath dips (~4–6 s pieces) so text streams
                             out while the speaker is still talking
                                                    │
                                     ┌──────────────┴──────────────┐
                                Local Whisper                  Groq API
                              (worker + ONNX/WASM)          (WAV multipart)
                                     └──────────────┬──────────────┘
                                                    ▼
                              overlay + side panel + chrome.storage (Yo / Interlocutor)
```

Files: `background.js` (coordination, shortcut, message relay and storage), `offscreen.js`
(capture, queue and coach: the heart of it, alive even with no interface open), `capture.js`
(opening the stream by id type), `segmenter.js` (VAD and WAV), `worker.js` (local Whisper),
`live.js` (provisional transcription via on-device Web Speech), `translate.js` (Chrome's built-in
translator), `coach.js` (Groq and Anthropic adapters + prompts), `overlay.js` (in-page
interface), `sidepanel.*` (full view), `report.*` (report), `setup.*` (permissions and settings),
`vendor/` (transformers.js + ONNX Runtime, bundled to satisfy MV3's CSP).

One detail that shapes the design: **an offscreen document only has access to `chrome.runtime`**,
not `chrome.storage`. That is why all of its storage goes through the service worker
(`STORE_GET` / `STORE_SET`), and messages to the overlay are forwarded from there with
`chrome.tabs.sendMessage`.

## If something breaks

**«Chrome no autorizó la captura de esta pestaña» / «Extension has not been invoked».** Chrome
only allows capturing a tab where the extension was *invoked*, and that permission is lost as
soon as the page navigates. Go to the meeting tab and press `⌘⇧S`, or use the extension icon, or
the context menu. A button inside the page cannot grant it — since v1.15.0 the pill and the
overlay's start button *try* anyway (it works when the extension was already invoked on that
tab, and always when the source is not the tab) and show these instructions only when Chrome
refuses.

**The reply box showed `[object Object]` after switching back to the session tab.** Fixed in
v1.15.0: re-injecting the overlay replayed the cached reply over the box's structure instead of
through the renderer.

**One idea appeared as five tiny blocks, each translated on its own.** The recorder cuts by
silence, so thinking pauses split a thought and long monologues stream out in ~4–6 s pieces.
Since v1.15.1 consecutive segments of the same speaker close in time fold back into one turn on
screen and in the transcript, and the translation is redone over the merged thought. The
segments still arrive one by one — that is the streaming working — they just extend the same
block instead of stacking.

**`chrome://` pages, the Web Store and the extension's own pages cannot be captured.** That is a
browser-level block.

**«Error transcribiendo: Can't create a session … Missing required scale … DequantizeLinear».**
A regression in ONNX Runtime 1.25+ (the engine bundled in `vendor/`) rejects every old q8
quantized Whisper decoder, whose tied-embedding weights share their quantization scales. Since
v1.15.3 the worker skips q8 entirely and loads the q4 decoder (verified against the bundled
runtime; roughly double the q8 download, cached after the first time), falling back to fp32 if
even that fails. A failed load now shows its real cause on every segment (`[modelo] …`) instead
of «El modelo no se ha inicializado», and retries by itself once a minute. The upstream fix
ships in onnxruntime-web 1.27; when a transformers.js build bundles it, refreshing `vendor/`
restores the small q8 download.

**`RESULT_CODE_KILLED_BAD_MESSAGE` / «Aw, Snap!» when recording starts.** Fixed in v1.4.1. When
the audio comes from Chrome's native picker (`desktopCapture`), video must be requested alongside
audio: asking for audio only does not return an error, it makes the browser process kill the
renderer. A minimal video track (160×120 at 1 fps) is now always requested and discarded as soon
as the stream arrives.

**The card freezes («Iniciando captura…») or logs `Extension context invalidated` after
updating the extension.** Reloading the extension orphans the overlay already injected into
open tabs: its `chrome.runtime` is gone, so its buttons can only fail. Reload the page (or
start a session from the toolbar icon, which injects a fresh overlay). Since v1.15.4 the fresh
copy detects the dead one and replaces it, and an orphaned card's buttons say «Recarga la
página» instead of freezing.

**Two English Coach cards appear on the same page, and one does not work.** You have more than
one copy of the folder loaded in `chrome://extensions`. Unpacked extension IDs depend on the
path, so `english-coach` and `english-coach 2` are different extensions to Chrome, each with its
own overlay and toolbar icon. The old copy's pill starts nothing. Since v1.11.1 the newer version
evicts the older one from the page and each card shows its version in the header, but **the real
fix is deleting the old copies** in `chrome://extensions` and keeping one.

**`ERR_BLOCKED_BY_CLIENT` when opening an extension page.** That URL points at a copy that no
longer exists — same cause as above. Delete the stale cards, keep one, and open settings from
its **Details → Extension options** button.

**Errors carry the stage where they failed in brackets** (`[offscreen]`, `[captura]`) so you know
where to look.

**The side panel or the extension bar disappears when sharing the tab.** Normal in some Chrome
windows, and it does not matter: the in-page overlay keeps showing everything and lets you ask
for replies and stop. If you hid it with «✕», it comes back with the next transcribed turn or on
reload.

## Known limits

- The VAD is energy-based: in very noisy places it may cut too aggressively. Tune `SILENCE_MS`,
  `SOFT_CUT_MS` and the threshold in `segmenter.js`, or the «Intervenciones cortas» setting.
- Pieces of a long monologue are transcribed independently, so Whisper tends to
  capitalise and full-stop each one: a single flowing sentence may appear as two or
  three fragments in the transcript. That is the deliberate trade for seeing the text
  while the person is still talking.
- No diarisation within a single track: if three people are on the call, they all come out as
  "Interlocutor".
- Chrome's internal pages (`chrome://`, Web Store) cannot be captured.
- With `small.en` on CPU, transcription is slower than speech; use GPU or a smaller model if
  real time matters.
