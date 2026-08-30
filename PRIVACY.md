# Privacy Policy — English Coach

Last updated: 22 August 2026

English Coach is a Chrome extension with no server of its own. **We do not collect, store or
transmit any data to infrastructure controlled by the authors.** There is no analytics, no
telemetry, no remote crash reporting, and no user accounts.

Everything below describes exactly what the code does. The code is public and auditable.

## What is processed, and where

### Audio

The extension captures the audio of the tab you choose and, if you enable it, your microphone.

- **With the local Whisper engine (the default):** audio is transcribed inside your browser using
  `transformers.js` and ONNX Runtime. **It never leaves your machine.**
- **If you pick the «Groq API» engine:** audio fragments are sent as WAV files to `api.groq.com`
  to be transcribed. This is an option you turn on explicitly in Settings.

Audio is never written to disk. It is processed in memory and discarded.

### Conversation text

Transcripts are stored **in your own browser** (`chrome.storage.local`). They are not synced to
any account and do not leave your machine on their own. You can delete them at any time with the
«Limpiar» button, and they disappear when you uninstall the extension.

If you enable the coach, the conversation text is sent to the provider you configured —
`api.groq.com` or `api.anthropic.com` — to generate the suggestions and the report. With the
coach disabled, nothing is sent.

**Histórico de errores.** La extensión guarda en `chrome.storage.local` los errores de inglés
detectados en tus conversaciones: la expresión incorrecta, su corrección y hasta tres frases
tuyas como evidencia. A diferencia de la transcripción, **este histórico sobrevive a las
sesiones**, porque su valor es detectar lo que repites. Nunca sale de tu equipo y nunca se envía
a ningún proveedor salvo como parte del informe que tú pides. Puedes borrar una entrada desde el
informe («Esto no era un error») o vaciarlo entero desde Ajustes.

### Your profile

The «Tu perfil» field in Settings is optional and empty by default. If you fill it in, its
contents are sent alongside the conversation to the coach provider when you request a suggested
reply or a report. We recommend including professional experience only, not contact details.

### API keys

Your Groq and Anthropic keys are stored **only** in `chrome.storage.local`, on your machine. They
are sent exclusively to the provider they belong to, as an authentication header. They are never
logged, never included in error messages, and never sent to third parties. Error messages redact
any credential-shaped string before displaying it.

### Translation and live transcription

Both use Chrome's built-in APIs, which run **on your device**: the built-in translator and local
speech recognition (`processLocally`). No text or audio from these two features leaves your
machine. If the local mode is unavailable, the feature turns itself off rather than falling back
to a cloud service.

### Model download

The first time you use the local engine, the extension downloads the Whisper model from
`huggingface.co`. It is a static file download; none of your content is sent. It is cached by the
browser and works offline afterwards.

## Data destinations

| Destination | What it receives | When |
|---|---|---|
| `huggingface.co` | Nothing of yours (model download only) | First run with the local engine |
| `api.groq.com` | Conversation text and your profile | Only with the coach enabled |
| `api.groq.com` | WAV audio | Only with the «Groq API» engine |
| `api.anthropic.com` | Conversation text and your profile | Only if you choose Claude for the coach |

Endpoints are configurable (`groqBase` / `anthropicBase`) to allow OpenAI-compatible servers such
as Ollama or LM Studio on your own machine. If you change them, data goes to the destination you
specified.

## Permissions and why

| Permission | What it is for |
|---|---|
| `tabCapture` | Capturing the audio of the tab you want transcribed |
| `offscreen` | The background document where capture and transcription happen |
| `storage` | Saving your settings and the transcript on your machine |
| `activeTab`, `tabs`, `scripting` | Showing the coach inside the conversation tab, and following you if you switch tabs |
| `sidePanel` | Full transcript view |
| `notifications` | Telling you when recording fails while no interface is visible |
| `contextMenus` | Starting and stopping from the right-click menu |
| Host access to `huggingface.co`, `api.groq.com`, `api.anthropic.com` | Downloading the speech model, and calling the coach provider you configured |
| Content script on all sites | The coach renders inside the page where the conversation happens, and we cannot know in advance which site you will be talking on (Meet, Zoom, Teams, YouTube, a practice app…). It mounts one element in a Shadow DOM and reads nothing from the page |
| Optional host access (not granted at install) | Only requested if you point the engine at your own server (Ollama, LM Studio) or need the coach re-injected into a tab opened before installing |

## What we do not do

- We do not sell or share data with third parties.
- We do not use your data for advertising, profiling, or training models.
- We do not transfer data outside the uses described here.
- We do not track your browsing: the extension only acts on the tab you choose to record.

## Your control

You can clear the transcript with «Limpiar», disable the coach and the report in Settings so that
nothing goes to the cloud, empty the API key fields, or uninstall the extension — which removes
everything stored.

## Contact

This project is open source. For privacy questions or concerns, open an issue on the GitHub
repository.
