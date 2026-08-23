# English Coach

Chrome Manifest V3 extension that records two separate audio tracks — the tab (the other
speaker) and the microphone (the learner) — transcribes each one, labels the conversation by
speaker, and coaches the learner's English live and in a closing report.

## Constraints that define the project

**No build step. No package.json. No dependencies. No bundler.** Chrome loads this folder
verbatim via `chrome://extensions` → *Load unpacked*. Every file that ships is a file that was
written. Do not introduce a toolchain, a framework, or an npm install without being asked —
the absence of one is the design.

`vendor/` holds checked-in third-party code (transformers.js + ONNX Runtime Web) because MV3's
CSP forbids remote script. **Never edit `vendor/` or `icons/`**; replace them wholesale from
upstream instead.

Node is available for tooling only — validation and unit tests. The extension itself never runs
in Node. Minimum Chrome is 116.

## Runtime contexts

Six isolated contexts. Each has a different subset of the platform; most bugs in this codebase
came from forgetting which one the code is running in.

| Context | File | Has | Lacks |
|---|---|---|---|
| Service worker | `background.js` | all `chrome.*`, ephemeral | DOM, `getUserMedia`, durable memory |
| Offscreen document | `offscreen.js` | DOM, media, workers | **all of `chrome.*` except `runtime`** |
| Dedicated worker | `worker.js` | WASM/WebGPU, ONNX | DOM, `chrome.*` |
| Audio worklet | `recorder-worklet.js` | realtime audio thread | everything else |
| Content script | `overlay.js` | page DOM, `chrome.runtime` | most `chrome.*`, page JS scope |
| Extension pages | `sidepanel.js` `setup.js` `report.js` | DOM + all `chrome.*` | may not exist at any moment |

The **offscreen document owns the session**. It captures, segments, transcribes, and calls the
coach, and it keeps running with no UI open. The side panel, the floating window, and the page
overlay are interchangeable views onto it — none may hold state the session depends on.

## Invariants

These are load-bearing. Each one cost a debugging session; breaking one reintroduces a bug that
Chrome reports with an unrelated error message.

1. **Tab audio requires a user *invocation*.** Chrome accepts exactly three gestures: the action
   icon, an extension keyboard command, and an extension context-menu entry. A button in the side
   panel or in the page does not count and fails with `Extension has not been invoked for the
   current page`. There is no workaround — `chrome.desktopCapture` was tried from both the
   service worker and an extension page and the resulting stream will not open.
2. **Call `chrome.tabCapture.getMediaStreamId()` before any other `await`.** The invocation
   permission is lost the moment the tab navigates.
3. **A `desktopCapture` stream must request video alongside audio.** Audio-only is not an error
   Chrome returns — the browser process kills the renderer with
   `RESULT_CODE_KILLED_BAD_MESSAGE` and no exception is thrown. `capture.js` requests a
   throwaway 160×120@1fps track and stops it immediately. See `attemptsFor()`.
4. **The offscreen document has no `chrome.storage`.** All of its reads and writes go through the
   service worker as `STORE_GET` / `STORE_SET`. Adding a direct `chrome.storage` call there
   throws at runtime, not at load. It also **outlives the session** — it is only torn down by an
   explicit `SHUTDOWN` — so never cache settings there for the document's lifetime. A key saved
   in Options after the document started would never arrive, and the coach would keep reporting
   a missing API key that is in fact configured. `ensureSettings()` re-reads on every coach call
   for exactly this reason; the round-trip is cheaper than the bug.
5. **Service worker memory is ephemeral.** `running`, `sessionTabId`, `lastUi` and
   `coachWindowId` in `background.js` are module-level and are lost when Chrome suspends the
   worker (~30 s idle). Anything that must survive a suspension belongs in
   `chrome.storage.local`. Treat any new module-level state there as a bug in waiting.
6. **The content script runs on every http(s) page.** It stays inside a Shadow DOM, touches
   exactly one global (`window.__englishCoachOverlay`), and must never become expensive to load.
7. **No remote code, ever.** `script-src 'self' 'wasm-unsafe-eval'`. No CDN, no inline `<script>`,
   no inline event-handler attributes, no remote fonts or stylesheets. `web_accessible_resources`
   stays empty for the same reason it stays small elsewhere: anything listed there is fetchable by
   every site the user visits and lets any page fingerprint the extension. The extension's own
   pages and workers read their files same-origin and need no such entry — only a content script
   or the host page does.
8. **Speech recognition never falls back to the cloud.** `live.js` requests Web Speech with
   `processLocally: true`. If the on-device path is unavailable — no language pack, unsupported
   Chrome, the open macOS bug — the live layer stays off and says so. Silently retrying without
   `processLocally` would ship the other speaker's audio off the machine while the UI still
   claims local transcription. Whisper is the authoritative transcript; Web Speech output is
   provisional display only and is never persisted.
9. **Unpacked extension IDs are derived from the folder path.** `english-coach` and
   `english-coach 2` are different extensions with different storage, different toolbar icons,
   and **separate isolated worlds** — so `window.__englishCoachOverlay` in one copy cannot see
   the other, and both inject an overlay into the same page. The DOM is the only thing they
   share, which is why `overlay.js` resolves duplicates by stamping `data-version` on the host
   and letting the newest copy evict the rest. Duplicated folders are also the usual cause of
   `ERR_BLOCKED_BY_CLIENT`. Never assume one copy is installed.

## Message protocol

Every message carries a `target` (`background` | `offscreen` | `ui`) and a SCREAMING_SNAKE
`type`. The service worker is the only router: the offscreen document broadcasts to `ui`, and
`background.js` mirrors that into the session tab with `chrome.tabs.sendMessage` so the overlay
sees it whether or not a panel is open. Handlers that reply asynchronously must `return true`.

Full inventory and the rules for extending it: `.claude/skills/message-contract/SKILL.md`.
A message type sent with no handler is a silent no-op at runtime and a preflight failure.

## Standards

**Comments.** Do not write comments that restate the code. The only comments worth keeping
record browser-imposed behaviour that the code cannot express — why video is requested with
audio, why storage is proxied, why an invocation is required. Comments are in English, like the
rest of the repository.

**DOM.** Never pass dynamic content to `innerHTML`. Use `textContent` and `createElement`.
`report.js` renders LLM output and escapes every value on the way in — that escaping is a
security control, not formatting.

**Errors.** Prefix user-visible failures with the stage that produced them: `[offscreen]`,
`[captura]`, `[tabs.query]`. Chrome's own messages ("Invalid state") identify nothing.

**Pure logic stays pure.** `segmenter.js`, `capture.js`, `coach.js` and `report.js` import no
`chrome.*` and take their side effects as injected parameters (`Segmenter(…, now)`,
`openCaptureStream(…, gum)`). That is deliberate: they import and run unmodified in Node, which
is the only way any of this is testable. Keep new logic on that side of the line.

**Secrets.** API keys live in `chrome.storage.local` and nowhere else. Never log them, never put
one in a URL or a query string, never send one to a host the user did not configure.

**Language.** The repository is English: identifiers, comments, documentation, commit messages
and everything under `.claude/`.

The **product** is Spanish, and that is not an inconsistency to clean up. UI strings and
user-facing errors are Spanish because the extension teaches English *to Spanish speakers* — the
nudges, the chips and the report are read in the learner's language, and that is the feature.
Coach prompts follow the same rule by output: English system prompts for the live hints (the
model reasons in English about English), Spanish for the report (the learner reads it). Never
"fix" a Spanish UI string into English.

## Verification

There is no CI and no test runner config. This is the whole gate:

```bash
node .claude/skills/preflight/scripts/preflight.mjs   # syntax, manifest, CSP, protocol, dead code, tests
node --test *.test.js                                 # unit tests, once any exist
```

Run preflight before claiming any change works, and reload the extension in
`chrome://extensions` afterwards — a stale service worker will happily serve the old code.
Static checks cannot verify capture, permissions, or WebGPU; say so rather than implying they
were tested.

## Specialists

Delegate to these rather than reasoning about their domain inline:

- `mv3-runtime-reviewer` — context boundaries, message routing, service worker lifecycle
- `audio-pipeline-reviewer` — capture, VAD, segmentation, transcription queue, latency, and the
  provisional live layer in `live.js`
- `extension-security-auditor` — permissions, CSP, key handling, DOM injection, data egress
- `test-author` — Node unit tests for the dependency-free modules

Skills: `/preflight`, `/add-provider`, `/release`.

## Known debt

- `picker.js` and `picker.html` are unreachable and the `desktopCapture` permission they needed
  is still requested. Preflight reports both.
- `host_permissions` covers every site; only `huggingface.co`, `api.groq.com` and
  `api.anthropic.com` are actually fetched.
- No unit tests exist yet, despite four modules being written to be testable.
