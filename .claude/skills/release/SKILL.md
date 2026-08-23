---
name: release
description: Cut a release — verify, bump the manifest version, update the README, and package the unpacked folder as a zip.
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# Release

Usage: `/release <major|minor|patch>`, or a literal version.

The extension ships as a folder. A release is a verified snapshot of it plus an accurate record
of what changed — there is nothing to compile.

## Steps

**1. Verify.** Preflight must exit `0`.

```bash
node .claude/skills/preflight/scripts/preflight.mjs
```

Do not proceed on a `FAIL`. Report any `WARN` to the user and let them decide.

**2. Confirm what actually changed.** Read the working tree against the last released state. If
this is not a git repository, ask the user what changed rather than guessing — do not infer a
changelog from file timestamps.

**3. Bump `manifest.json`.** Chrome requires one to four dot-separated integers, each 0–65535,
with no leading zeros and no suffixes: `1.6.1` is valid, `1.6.1-beta` is not. Chrome refuses to
install a version lower than the one already present, so the number must only ever increase.

**4. Update `README.md`.** The README is the user manual and the troubleshooting guide, and it
documents fixes by version ("Corregido en la v1.4.1"). If this release fixes a failure a user
could hit, add it to **Si algo falla** in that voice — the symptom the user sees, then what
changed. README prose is Spanish.

**5. Package.**

```bash
zip -r "english-coach-$(node -p "require('./manifest.json').version").zip" . \
  -x '.*' -x '*/.*' -x '.claude/*' -x 'CLAUDE.md' -x '*.zip' -x '*.test.js'
```

`LICENSE` and `THIRD-PARTY-NOTICES.md` stay **inside** the archive. `vendor/` redistributes
Apache-2.0 and MIT code whose licenses require their notices to travel with the binaries, so an
archive without them is a licence breach, not a tidier zip.

`vendor/` and `icons/` must be inside the zip — the extension does not load without them.
Confirm the archive's size and top-level contents before handing it over.

## Publishing to the Chrome Web Store

Only when the user asks to publish, not on every release. The zip from step 5 is the upload
artifact. Before uploading, confirm all of the following, because each one is a rejection risk:

- **Preflight is clean.** Its `permissions` and `dead-code` warnings map directly to what review
  asks about: a permission with no call site has no honest justification, and unreachable files
  still get read by reviewers.
- **Every permission has a one-sentence justification** ready for the listing form, phrased as
  what the user gains — not what the API does.
- **Broad host access is the item most likely to stall review.** Google asks why the extension
  cannot work with narrower permissions. Answer concretely (which sites, why they are not
  enumerable in advance) or narrow the permission.
- **A privacy policy is mandatory** for anything touching user data, and this extension records
  audio. It must be reachable over HTTPS with no login — GitHub Pages or a gist is enough. Keep
  `PRIVACY.md` in sync with the code: it enumerates every destination data reaches, and a policy
  that disagrees with the manifest is worse than none.
- **The data-usage disclosure in the dashboard must match the policy**, including the third-party
  APIs the coach calls.
- **No remote code.** MV3 forbids it and review enforces it; `vendor/` exists for that reason.

Registration is a one-time US$5 fee per developer account. Review normally takes days but can
take weeks, and there is no paid fast track — a version bump for a trivial fix still queues.
Never tell the user a review will land by a specific date.

## GitHub push protection and `vendor/`

Pushing `vendor/transformers.js` trips GitHub secret scanning with a false positive: the model
registry contains class names like `Mistral3ForConditionalGeneration` that are exactly 32
alphanumeric characters and carry a provider name, which matches Mistral's API key pattern.
`CohereAsrForConditionalGeneration` and `OpenAIPrivacyFilter*` are the same shape.

Verify before dismissing — print the flagged line and confirm it is a class name, never assume.
Then resolve it through the per-secret unblock URL in the rejection message, which only the
repository owner can open. Do not disable push protection for the repository to get one commit
through, and do not drop `vendor/` from the repo: MV3's CSP forbids remote code, there is no
build step to fetch it, and without it a fresh clone cannot run at all.

## Rules

- Never bump the version without running preflight first.
- Never widen `permissions` or `host_permissions` in a release without saying so explicitly in
  the handover: a permission increase disables the extension for every existing user until they
  re-approve it.
- Do not commit, tag, or publish anything unless the user asks. Stop at the zip and report the
  version, what changed, what preflight said, and what was verified in the browser versus only
  statically.
