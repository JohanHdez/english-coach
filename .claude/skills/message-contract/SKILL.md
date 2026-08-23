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
| `START` | `settings?` | starts a session; fails for tab audio without an invocation |
| `STOP` | — | stops the session; triggers the auto report |
| `SUGGEST_REPLY` | — | forwards to offscreen; answer arrives as a `REPLY` broadcast |
| `REPORT` | — | forwards to offscreen; generates and opens the report |
| `PING_STATE` | — | `{ running, pending }`, asked from offscreen if it exists |
| `UI_SYNC` | — | full snapshot for a freshly injected overlay |
| `OPEN_WINDOW` | — | opens or focuses the floating coach window |
| `OPEN_REPORT` | — | opens `report.html` in a tab |
| `SHUTDOWN` | — | closes the offscreen document |
| `STORE_GET` | `keys` | offscreen's only route to `chrome.storage` |
| `STORE_SET` | `items` | as above |

**background → offscreen** (`target: 'offscreen'`)

`START` (`streamId`, `streamKind`, `settings`), `STOP`, `SUGGEST_REPLY`, `REPORT`, `STATE`.

**offscreen → ui** (`target: 'ui'`, broadcast, mirrored into the tab)

| Type | Payload | Consumed by |
|---|---|---|
| `RUNNING` | `running` | overlay, sidepanel, and `background` to track session state |
| `STATUS` | `text`, `kind` (`info`/`ok`/`error`/`loading`), `show?` to force the overlay open | overlay, sidepanel |
| `SEGMENT` | `entry` (`speaker`, `text`, `t`, `dur`) | overlay, sidepanel |
| `HINTS` | `words[]`, `nudge` | overlay, sidepanel |
| `REPLY` | `openers[]`, `ideas[]` (each `{en, es}`), or `pending`, or `error` | overlay, sidepanel |
| `QUEUE` | `pending` | overlay, sidepanel |
| `PARTIAL` | `text` (English, provisional) | overlay, sidepanel |
| `LIVE_STATE` | `state`, `detail?` | overlay, sidepanel |

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
8. **`PARTIAL` is provisional and never persisted.** It carries live Web Speech output that
   Whisper will overwrite. It is not appended to `transcript`, never reaches the report, and is
   not cached in `lastUi` — a re-injected overlay must come back with no stale partial on screen.
   Every `SEGMENT` for `them` is followed by a `PARTIAL` with empty text that clears it.
