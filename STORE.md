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

One field per permission, in the order the dashboard shows them (the order of `permissions` in
`manifest.json`). Limit is 1000 characters each; the current lengths are in brackets. Say what
the user gains, not what the API does — a justification that only restates the API is the most
common reason a version is rejected.

### tabCapture  [421 chars]

> The extension records the audio of the tab the user selects, which is the other side of the conversation being transcribed. Separating that audio from the user's own microphone is the core of the single purpose: the transcript is labelled by speaker, and the coaching only analyses the learner's own turns. Without tabCapture only the microphone could be recorded, and the extension could not tell the two speakers apart.

### offscreen  [409 chars]

> Audio capture and speech recognition need DOM, media and WebAssembly APIs that a Manifest V3 service worker does not have. The offscreen document is where the microphone and tab streams are opened, segmented, and transcribed with a local Whisper model. It also keeps the session alive when the user closes the side panel or switches tabs, so a long conversation is not cut short by the interface being hidden.

### sidePanel  [309 chars]

> Provides the full view of the conversation: the complete transcript labelled by speaker, with buttons to copy it, download it as Markdown, or generate the coaching report. The in-page overlay only shows the most recent turns, so the side panel is where the user reviews and exports everything after a session.

### storage  [361 chars]

> Saves the user's settings (speech model, audio source, coaching preferences) and the transcript of the current session locally, so closing the panel or reloading the page does not lose the conversation. It also lets the offscreen document read settings, since offscreen documents cannot access storage directly. Nothing is synced to an account or sent anywhere.

### activeTab  [239 chars]

> Grants access to the tab the user invoked the extension from, so tab audio capture can start there. Chrome only allows capturing a tab's audio when the user invokes the extension from it, and activeTab is what makes that invocation usable.

### tabs  [346 chars]

> Detects when the user switches tabs during a recording session, so the coaching interface follows them to the new tab instead of disappearing mid-conversation. It is also used to open the report in a new tab when a session ends. The extension reads only the tab id and whether the URL is an http(s) page, to know where the interface can be shown.

### scripting  [294 chars]

> Injects the coaching interface into the conversation page when it is not already present, for example a tab that was open before the extension was installed or updated. The interface is a single element inside a Shadow DOM; it reads nothing from the page and does not modify the site's content.

### notifications  [319 chars]

> Reports a capture failure when no interface is visible. Sharing a tab can leave the user in a Chrome window with no side panel and no extension bar, and in that situation a system notification is the only way they learn that recording did not start and why. Notifications are only shown for errors, never for promotion.

### contextMenus  [349 chars]

> Lets the user start and stop transcription by right-clicking the page. Chrome accepts only three gestures as an invocation for tab audio capture — the toolbar icon, a keyboard shortcut, or a context menu entry — so this is one of the three supported ways to begin a session, and the most discoverable one for users who have not pinned the extension.

### Permisos de host  [688 chars]

> The extension contacts exactly three hosts, all of them essential to the single purpose. huggingface.co serves the Whisper speech recognition model, downloaded once and cached so transcription then works offline and on-device. api.groq.com and api.anthropic.com are the language model providers the user configures for coaching; only the conversation text is sent, and only when the user enables the coach and provides their own API key. No broad host access is requested: the http/https patterns are declared as optional_host_permissions and are not granted at install, since they are only needed if the user chooses to point the engine at their own self-hosted OpenAI-compatible server.

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
