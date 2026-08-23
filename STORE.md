# Chrome Web Store submission

Everything the listing form asks for, ready to paste. Keep this in sync with `manifest.json` and
`PRIVACY.md` — a listing that disagrees with the manifest is a rejection.

## Before uploading

- [ ] `node .claude/skills/preflight/scripts/preflight.mjs` exits 0
- [ ] Version bumped in `manifest.json`
- [ ] `PRIVACY.md` published over HTTPS with no login (GitHub Pages or a gist) and its URL pasted
      into the listing
- [ ] Package built with the `release` skill, so `LICENSE` and `THIRD-PARTY-NOTICES.md` travel
      inside the zip and `.claude/` does not
- [ ] Screenshots produced (see Assets)

## Single purpose

Required field. One sentence, and every permission must serve it.

> Transcribe the two sides of a spoken English conversation separately and coach the user's
> English, live and in a report afterwards.

## Short description (132 characters max)

> Transcribes your English conversations by speaker with on-device Whisper and coaches you live.
> Free, private, no account.

## Detailed description

> **English Coach turns any conversation into English practice.**
>
> It records two separate tracks — the tab's audio (the person you are talking to) and your
> microphone (you) — transcribes each one, and labels the conversation by speaker. Works with
> Google Meet, Zoom on the web, Teams, YouTube, or any practice app.
>
> **Private by default.** Speech recognition runs inside your browser with Whisper. Your audio
> never leaves your machine. Translation and live transcription use Chrome's on-device APIs, so
> they do not send anything either.
>
> **Free end to end.** No account, no subscription, no minute limits. The optional coach runs on
> a free API key you create in under a minute, with no credit card.
>
> WHAT IT DOES
>
> • Two-speaker transcription: your turns and theirs, separated and timestamped
> • Spanish translation under each of the other speaker's turns, on-device
> • Live transcription that shows what is being said as it happens
> • Vocabulary chips after each turn: expressions you are likely to need right now
> • Suggested replies in two groups — phrases to get started, and complete sentences carrying
>   your idea, grounded in a profile you write
> • A closing report: grammar corrections with the reason, calques from Spanish, expressions you
>   could have used, filler words, and an approximate CEFR level with exercises
>
> Interface in Spanish: this is a tool for Spanish speakers practising English, so the hints and
> the report are written in the learner's language.
>
> Open source under GPL-3.0.

## Permission justifications

One field per permission. Say what the user gains, not what the API does.

| Permission | Justification to paste |
|---|---|
| `tabCapture` | Records the audio of the tab the user selects, which is the other side of the conversation being transcribed. Without it only the user's own microphone could be captured, and the extension's whole purpose is separating the two speakers. |
| `offscreen` | Audio capture and speech recognition need DOM and media APIs, which a service worker does not have. The offscreen document is where recording and transcription run, and it keeps the session alive when no interface is open. |
| `storage` | Saves the user's settings and the transcript locally so a session survives closing the panel or reloading the page. Nothing is synced or sent anywhere. |
| `activeTab` | Grants access to the tab the user invoked the extension from, so capture can start there. |
| `tabs` | Detects when the user switches tabs during a session, so the coach interface follows them to the new tab instead of disappearing mid-conversation. |
| `scripting` | Injects the coach interface into the conversation page when it is not already present, for example a tab opened before the extension was installed. |
| `sidePanel` | Provides the full transcript view with export and settings. |
| `notifications` | Reports a capture failure when no interface is visible. Sharing a tab can leave the user in a Chrome window with no side panel and no extension bar, and a system notification is then the only way they learn recording did not start. |
| `contextMenus` | Lets the user start and stop transcription by right-clicking the page, one of the three gestures Chrome accepts as an invocation for tab capture. |
| Host access to `huggingface.co`, `api.groq.com`, `api.anthropic.com` | Downloads the speech recognition model once, and calls the language model provider the user configured for coaching. These are the only three hosts the extension contacts. |
| Content script on all sites | The coach renders inside the page where the conversation happens, and there is no way to know in advance which site the user will be talking on — Meet, Zoom, Teams, YouTube, or any practice app. It mounts a single element in a Shadow DOM and reads nothing from the page. |

Broad host permissions were deliberately moved to `optional_host_permissions`: they are only
needed if the user points the engine at their own OpenAI-compatible server. The extension does
not request them at install.

## Data usage disclosure

Match `PRIVACY.md` exactly.

- **Personally identifiable information**: no
- **Health, financial, authentication, personal communications, location, web history**: no
- **User activity**: no
- **Website content**: **yes** — the conversation transcript, and the optional profile the user
  writes, are sent to the language model provider the user configured (Groq or Anthropic) when
  the coach is enabled. Audio is sent only if the user explicitly picks the API transcription
  engine instead of the local one.

Certify all three: not sold to third parties, not used for anything unrelated to the single
purpose, not used to determine creditworthiness or for lending.

## Assets to produce

- [ ] 1–5 screenshots at 1280×800 or 640×400
- [ ] 128×128 store icon (`icons/icon128.png` already exists)
- [ ] Optional: 440×280 small promo tile

## Expectations

Registration is a one-time US$5 fee per developer account. Review usually takes days but can take
weeks, and there is no paid fast track — a trivial fix still queues. Do not promise a date.
