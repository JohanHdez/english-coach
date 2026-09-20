---
name: message-contract
description: The message protocol wiring the service worker, offscreen document, page overlay, and extension pages together, and the rules for extending it. Load before adding, renaming, or rerouting any message type.
user-invocable: false
---

# Message contract

Six isolated contexts, one router. Every message is `{ target, type, ...payload }` where `target`
is `background`, `offscreen`, or `ui`, and `type` is SCREAMING_SNAKE.

`background.js` is the only router. The offscreen document broadcasts to `ui`; the service worker
intercepts those, caches the last of each kind, and mirrors them into the session tab with
`chrome.tabs.sendMessage` so the page overlay sees them whether or not a panel is open.

```
overlay / sidepanel / setup ──► background ──► offscreen ──► worker
                                    │              │
                                    └──◄── ui ◄────┘
                                    └──► tabs.sendMessage ──► overlay
```

## Inventory

**UI → background** (`target: 'background'`, or no target)

| Type | Payload | Effect |
|---|---|---|
| `START` | `settings?`, `quiet?` | starts a session; fails for tab audio without an invocation. `quiet` (overlay) suppresses the failure notification and popup — the sender paints the error itself |
| `STOP` | — | ends the session; triggers the auto report |
| `PAUSE` | — | stops the audio reaching the segmenters. The session, the streams and the tab-capture invocation stay alive, and no report is written |
| `RESUME` | — | audio flows again and the live layer is restarted from the stream that was never released |
| `SUGGEST_REPLY` | — | forwards to offscreen; answer arrives as a `REPLY` broadcast |
| `REPORT` | — | forwards to offscreen; generates and opens the report |
| `PING_STATE` | — | `{ running, pending }`, asked from offscreen if it exists |
| `UI_SYNC` | — | full snapshot for a freshly injected overlay: `running`, `startedAt`, `turns`, `chips`, `reply`, `status`, `live`, `paused`, `translate`, `pillPos`, `pillHidden` (resolved against the *sender's* host) |
| `OPEN_WINDOW` | — | opens or focuses the floating coach window |
| `OPEN_REPORT` | — | opens `report.html` in a tab |
| `SHUTDOWN` | — | closes the offscreen document |
| `STORE_GET` | `keys` | offscreen's only route to `chrome.storage` |
| `STORE_SET` | `items` | as above |
| `TOGGLE_NOTE` | `id` | flips a note's `open` in settings; the write re-broadcasts `COACH_CHIPS` |
| `ADD_NOTE` | `title`, `body` (strings; the service worker clamps them with `addNote`) | adds a note to settings via `addNote`; reply `{ ok }`; the write re-broadcasts `COACH_CHIPS`, so no view re-renders on its own |
| `PATCH_SETTINGS` | `patch` (an object whose keys are settings fields; only `lang, themSource, themDeviceId, captureMic, sessionContext, profile` are applied — an unlisted key, such as an API key, is silently ignored) | sent by `sidepanel.js`, one field per call; reply `{ ok, settings }` with the result after the merge, `groqKey` and `anthropicKey` omitted since the side panel never reads them |
| `PILL_POS` | `pos` (`{right, bottom}` from the corner) | parks the idle pill; the overlay has no storage of its own |
| `PILL_HIDE` | `host` | adds the sender's hostname to `pillHiddenHosts`. Only the idle pill goes; the card still opens from the icon, the shortcut or the context menu |

**background → offscreen** (`target: 'offscreen'`)

`START` (`streamId`, `streamKind`, `settings`), `STOP`, `PAUSE`, `RESUME`, `SUGGEST_REPLY`, `REPORT`, `STATE`.

**offscreen / background → ui** (`target: 'ui'`, broadcast, mirrored into the tab)

| Type | Payload | Consumed by |
|---|---|---|
| `RUNNING` | `running`, `session` (the start timestamp, identifying the conversation) | overlay, sidepanel, and `background` to track session state |
| `STATUS` | `text`, `kind` (`info`/`ok`/`error`/`loading`), `show?` to force the overlay open | overlay, sidepanel |
| `SEGMENT` | `entry` (`speaker`, `text`, `t`, `dur`, `lang` — `'en'`/`'es'`, may be absent on an entry recorded before the field existed); a repeated (`speaker`, `t`) is a turn extended by folding — UIs upsert, not append | overlay, sidepanel |

A landing can produce two SEGMENTs in a row: a bubble closed at a finished sentence (its text
may be shorter than the last one sent under that key) followed by the bubble opened with the
rest. A bubble whose text did not change is not re-sent.
| `COACH_CHIPS` | `phrases[]` (`{id, en, es, cat}` — `cat` drives the category filter and comes from `CATALOGUE`; a learner's own phrase gets `CUSTOM_CAT`), `notes[]` (`{id, title, body, open}`) | overlay, sidepanel |
| `REPLY` | `answer[]` (one item; its key term wrapped in `**`), `ideas[]` (each `{en, es}`), or `pending`, or `error` | overlay, sidepanel |
| `PAUSED` | `paused` | overlay, sidepanel |
| `QUEUE` | `pending` | overlay, sidepanel |
| `PARTIAL` | `speaker` (`them` or `me` — each voice paints its own line; views treat a missing value as `them`), `text` (that speaker's whole provisional line, English), `committed` (its settled prefix — the rest may still be rewritten), `lang` (`en` or `es` — the language this speaker's line is currently being decoded in, so a view knows whether to translate it; a missing value is read as English, matching stored entries from before the field existed) | overlay, sidepanel |
| `LIVE_STATE` | `state` (`available`, `unsupported`, `unavailable`, `downloadable`, `downloading`, `error` — including the word-by-word lane reporting itself available and then never emitting a word, which the offscreen document only concludes after Whisper has transcribed `LIVE_PROOF_MS` of real speech — or `slow`, the preview lane retiring because a pass cost more than it saved), `detail?`, `fallback?` (the Whisper preview lane is standing in, so there *is* live text, just not word by word) | overlay, sidepanel |

**offscreen ↔ worker** — plain `postMessage`, lowercase types, not part of this protocol:
`init`, `transcribe` out; `progress`, `ready`, `result`, `error` back, correlated by `id`.

## Rules

1. **Route through `background`.** The offscreen document has only `chrome.runtime`; it cannot
   reach a tab or storage directly. UI pages must not message the offscreen document directly
   either — the router owns session state.
2. **Async handlers `return true`** synchronously, before any await, or the sender's promise
   resolves `undefined`.
3. **Catch every send.** `sendMessage` rejects when the receiver does not exist — a closed panel,
   a tab that navigated, a suspended context. Every call site in the codebase ends in `.catch()`
   for that reason. An uncaught rejection in the offscreen document can end the session.
4. **A `ui` broadcast must be idempotent and self-contained.** The overlay is re-injected on tab
   switch and page reload and replays from `UI_SYNC` plus the cached `lastUi` — a message that
   only makes sense as a delta will render wrong after a reload.
5. **Adding a type** means: define it here, send it, handle it, and confirm preflight passes.
   Preflight fails the build on any SCREAMING_SNAKE type sent with no handler, because at runtime
   that failure is completely silent.
6. **Renaming a type** means changing it in every context at once. There is no version
   negotiation and no fallback; a half-renamed type is a feature that stops working with no error.
7. **Never put an API key, a raw audio buffer, or a `Float32Array` in a message.** Keys stay in
   storage; audio is transferred to the worker via `postMessage` transfer lists, not broadcast.
8. **`committed` is a promise, not a hint.** A word inside `committed` will never change again:
   the preview lane's passes overlap, so `stitch.js` settles a word once two consecutive passes
   agree on it or once the window has moved past its audio. Views render it as settled and the
   rest as unstable. Splitting the payload changes nothing about rule 9 below — none of it is
   persisted — and `committed` is always a prefix of `text`.
9. **`PARTIAL` is provisional and never persisted.** It carries either live Web Speech output or
   a throwaway Whisper pass over the phrase still being spoken, and the authoritative segment
   overwrites it. It is not appended to `transcript`, never reaches the report, and is not cached
   in `lastUi` — a re-injected overlay must come back with no stale partial on screen. A
   `SEGMENT` whose phrase closed at a real pause is followed by a `PARTIAL` with empty text for
   its speaker; a mid-speech cut (soft or hard) leaves the line standing, because blanking text
   under someone who is still talking is exactly the disappearing live line the lane exists to
   prevent — the next piece's first preview replaces it instead. The one exception is the
   word-by-word Web Speech lane: while it drives the `them` line, every delivered `them` turn
   resets it, open or not, or the recognizer's accumulated results would re-append text already
   in the bubble and keep growing for the rest of the monologue.
10. **Pause is not a stop.** `PAUSE` never writes a report, never releases a stream and never
    clears the transcript — `STOP` does all three. Tearing the capture down would be
    irreversible from the UI: invariant 1 grants tab audio only on a user invocation, and no
    button inside the page or the panel is one. `PAUSED` is cached in `lastUi` alongside
    `LIVE_STATE`, for the same reason.
11. **`LIVE_STATE` is cached in `lastUi`**, unlike `PARTIAL`. It describes a condition that holds
   for the whole session, not a delta: an overlay injected after a page reload must come back
   knowing the word-by-word layer is off, or it silently promises text that is never coming.
12. **`RUNNING` identifies the session, it does not command a reset.** A view clears its
    turns when `session` changes *and* `running` is true. Sending "clear now" instead would
    break rule 4: the overlay is re-injected on every tab switch and reload, and a view that
    first hears `RUNNING` at the end of a session would wipe the turns `UI_SYNC` just gave it.
    The storage key `stoppedAt` decides on the offscreen side whether the previous transcript
    is resumed or dropped, and `startedAt` holds the same session stamp for a view that missed
    the broadcast — the side panel reads it from storage, the overlay gets it in `UI_SYNC`.
13. **`COACH_CHIPS` comes from `background`, not offscreen.** It is derived from `settings`, not
    from the session, so it is broadcast on `START` and on any `storage.onChanged` touching
    `phraseIds`, `customPhrases`, `notes` or `liveCoach` — and it is *not* cleared when a session
    ends. `UI_SYNC` does not trigger a new broadcast; it replays the cached `lastUi.chips` in its
    directed response, same as `attachOverlay` does when it re-injects the overlay.
14. **Settings are written only by the service worker, one write at a time.** Every view that
    reads the whole `settings` object, changes one field and writes it back is a race with every
    other view doing the same — a note toggled from the overlay while one is added from the panel
    silently loses whichever write lands second. `background.js` funnels every change through
    `patchSettings`, a queue of one write after another; a view that wants a field changed sends
    `TOGGLE_NOTE`, `ADD_NOTE`, `PILL_POS`, `PILL_HIDE` or `PATCH_SETTINGS` instead of calling
    `chrome.storage.local.set({ settings })` itself.
