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

## Title and summary — taken from `manifest.json`

The dashboard fills "Título del paquete" from `name` and "Resumen del paquete" from
`description`. Both are already Spanish and the description is 124 of the 132 characters
allowed. Do not retype them in the form; change `manifest.json` and re-upload instead, or the
listing and the package will disagree.

## Detailed description

**Paste as plain text.** The Store field renders nothing: Markdown `>` quotes, `**bold**` and
`#` headings would appear literally in the published listing. The block below is stored fenced
precisely so it is copied verbatim without picking up quote markers.

**Write it in Spanish.** The listing is what a prospective user reads, and the audience is
Spanish speakers looking for a tool to practise English — they search in Spanish. The repository
is English; the storefront is not the repository.

```
English Coach convierte cualquier conversación en práctica de inglés.

Graba dos pistas separadas —el audio de la pestaña (la persona con la que hablas) y tu micrófono (tú)—, transcribe cada una y te deja la conversación etiquetada por hablante. Funciona con Google Meet, Zoom web, Teams, YouTube o cualquier app de práctica.

PRIVADO POR DEFECTO

El reconocimiento de voz corre dentro de tu navegador con Whisper. Tu audio no sale del equipo. La traducción y la transcripción en vivo usan las APIs integradas de Chrome, así que tampoco envían nada.

GRATIS DE PRINCIPIO A FIN

Sin cuenta, sin suscripción y sin límite de minutos. Los chips de frases y las notas no necesitan API key ni conexión. La respuesta sugerida y el informe son opcionales y funcionan con una API key gratuita que creas en menos de un minuto, sin tarjeta.

CÓMO PRACTICAR SIN REUNIONES

¿No tienes con quién hablar? Abre en una pestaña cualquier IA de voz que converse contigo —por ejemplo Sesame (app.sesame.com), gratis y sin instalación— y practica:

1. Abre la conversación en una pestaña normal de Chrome.
2. Pulsa el icono de la extensión (o Cmd/Ctrl+Shift+S): empieza a grabar y el coach aparece dentro de la página.
3. Habla. Verás la transcripción de ambos, la traducción, y podrás pedir una respuesta sugerida cuando te trabes.
4. Al terminar, pulsa Detener: el informe te dice qué corregir y qué estudiar para la próxima.

El mismo flujo sirve para YouTube (escucha), Google Meet, Zoom web, Teams o una entrevista real. English Coach no está afiliado a Sesame: es solo un buen sitio para practicar.

QUÉ HACE

• Transcripción de dos hablantes: tus intervenciones y las suyas, separadas y agrupadas por idea
• Traducción al español bajo cada turno del interlocutor, hecha en tu dispositivo
• Transcripción en vivo que muestra lo que se está diciendo mientras se dice
• Chips de frases que eliges (o añades tú mismo) y notas propias, visibles desde antes de empezar a hablar — no usan API ni conexión
• Respuesta sugerida hecha para decirse en voz alta: una sola frase clara con el término clave resaltado, y dos versiones más ricas para estudiar después. Se apoya en tu perfil y en las notas que escribas sobre la conversación de hoy — ideal para entrevistas técnicas
• Informe final: resumen de la reunión con lo que quedó pendiente, errores de gramática con la corrección y el porqué, calcos del español, conectores y frases para memorizar, muletillas y un nivel CEFR aproximado con ejercicios para la semana
• Modo español: la misma asistencia —transcripción, respuesta sugerida e informe de coach de comunicación— para tus entrevistas y reuniones en tu propio idioma

PARA QUIÉN ES

Para hispanohablantes que ya se defienden en inglés pero se traban en conversaciones reales: entrevistas, reuniones de trabajo, llamadas con clientes. La interfaz está en español a propósito, porque las pistas y el informe se leen mejor en tu idioma. Y cuando la conversación importante es en español —una entrevista técnica, por ejemplo—, el modo español te acompaña igual.

Código abierto bajo GPL-3.0: github.com/JohanHdez/english-coach
```

Category: **Educación**. Default language: **Spanish**. English can be added later as a
translation without touching the default.

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

> The extension contacts exactly three hosts, all of them essential to the single purpose. huggingface.co serves the Whisper speech recognition model, downloaded once and cached so transcription then works offline and on-device. api.groq.com and api.anthropic.com are the language model providers the user configures for coaching; only the conversation text is sent, and only when the user enables the coach and provides their own API key. No broad host permission is requested. The extension does declare a content script on all http(s) sites, because the coaching interface renders inside the page where the conversation happens and there is no way to enumerate in advance which site that will be: Meet, Zoom, Teams, YouTube, or any practice app. That content script mounts a single element inside a Shadow DOM, reads nothing from the page, and sends nothing anywhere.

## Remote code

**Answer: No.** Verified, not assumed — the CSP is `script-src 'self' 'wasm-unsafe-eval'`, no HTML
loads a remote `<script src>`, there is no dynamic `import()` of a URL, no `eval` and no
`new Function`, and both ONNX Runtime `.wasm` binaries ship inside `vendor/` with
`env.backends.onnx.wasm.wasmPaths` pointed at `chrome.runtime.getURL('vendor/')`.

What is downloaded from `huggingface.co` is the Whisper model's `.onnx` weights: data consumed by
the bundled runtime, not JS or Wasm that executes. Google's definition covers "JS or Wasm not
included in the extension package", and the Wasm is included — that is why `vendor/` is 37 MB.

Answering "yes" would declare an MV3 violation the extension does not commit and would send it to
deep review for nothing. Re-verify this answer whenever `vendor/` or `worker.js` changes.

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
