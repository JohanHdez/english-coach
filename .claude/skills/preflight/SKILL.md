---
name: preflight
description: Validate the extension before loading it into Chrome — syntax, manifest integrity, CSP violations, message-protocol gaps, unreachable files, unused permissions, and unit tests. Use before claiming a change works, before a release, and whenever something behaves as if the code never ran.
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# Preflight

This project has no build step and no CI, so nothing catches a broken file until Chrome fails to
load it — often with an error naming neither the file nor the cause. Preflight is the gate.

```bash
node .claude/skills/preflight/scripts/preflight.mjs
```

Exit code is `1` if anything failed, `0` otherwise. Warnings never fail the run.

## What it checks

| Check | Catches |
|---|---|
| `syntax` | any `.js` that does not parse, parsed as a module |
| `manifest` | invalid JSON, entry points pointing at missing files, MV2, weakened CSP |
| `csp` | remote scripts or stylesheets, inline `<script>`, inline `on*=` handlers |
| `assets` | HTML referencing a script or stylesheet that does not exist |
| `imports` | a relative `import` resolving to nothing |
| `dead-code` | files unreachable from any manifest entry point |
| `protocol` | a message `type` that is sent but that no context handles |
| `permissions` | permissions declared but never used, over-broad `host_permissions` |
| `tests` | runs every `*.test.js` if any exist |

Reachability follows manifest entry points through HTML `src`/`href`, ES imports, and
string-referenced assets (`new Worker('worker.js')`, `getURL('recorder-worklet.js')`,
`files: ['overlay.js']`), so worklets and workers are tracked even though nothing imports them.

## Reading the output

`FAIL` means the extension is broken or will be rejected by Chrome. Fix it before continuing.

`WARN` means it will load and run. Do not silence a warning by deleting the check; either fix the
underlying issue or, if it is a deliberate trade-off, record it under **Known debt** in
`CLAUDE.md` so it stops being re-litigated.

A `protocol` failure is the one most worth pausing on. Sending a message no one handles fails
silently at runtime — the feature simply does nothing, with no error anywhere.

## Limits

Preflight is static. It cannot verify that capture starts, that a permission is granted, that
WebGPU initialises, that a model downloads, or that a provider's API answers. After it passes,
reload the extension at `chrome://extensions` — a suspended service worker serves stale code —
and exercise the change by hand. When reporting, say which parts were verified statically and
which were exercised in the browser. Never imply the browser path was tested when it was not.

## Extending it

The script is dependency-free Node in `scripts/preflight.mjs`. Add a check when a class of bug
recurs, in the same shape as the existing ones: push to `problems` for anything that breaks the
extension, `warnings` for anything that merely should not be there. Verify a new check by
breaking a copy of the project in the scratchpad and confirming it fires — a check that has never
failed has never been tested.
