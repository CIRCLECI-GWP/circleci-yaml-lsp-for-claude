# Contributing

## Local development

Test the plugin without installing it from the marketplace:

```bash
# Validate the manifests
claude plugin validate . --strict
claude plugin validate ./plugins/circleci-yaml-lsp --strict

# Load it for one session
claude --plugin-dir ./plugins/circleci-yaml-lsp

# Then, in a project with a .circleci/config.yml, make a trivial edit to the
# config and confirm diagnostics appear. /plugin → Errors shows any failures.
```

The launcher and proxy are plain Bash + Node and can be exercised directly over stdio; see
the verification approach in [`docs/DESIGN.md`](docs/DESIGN.md).

## Tests

The proxy (the logic-heavy part) has unit + integration tests using Node's built-in test
runner — no dependencies — and a mock LSP server, so they need neither the real
language-server binary nor network:

```bash
npm test        # or: node --test test/lib.test.mjs test/proxy.test.mjs
```

- `test/lib.test.mjs` — pure helpers from `lsp-proxy-lib.mjs` (scope matching, LSP framing,
  `applyEdits`, …).
- `test/proxy.test.mjs` — drives the real `lsp-proxy.mjs` against `test/mock-server.mjs`,
  asserting scope filtering, the `didChange`→`didOpen` replay (the doubling-bug regression),
  full-sync rewrite, token injection + reply-swallowing, and diagnostics scoping.

Tests live at the repo root and are **not** part of the installed plugin. Keep new tests
inside a `describe(...)` block: `npm run test:ci` (used by CI) relies on that so Node's JUnit
reporter emits a `<testsuite>` element, which CircleCI's test-results parser requires — loose
top-level `test()` calls produce output CircleCI rejects.

## Releasing a new version

Claude Code applies plugin updates **only when `plugin.json`'s `version` changes**. Any fix
that ships without a version bump will never reach already-installed users. So every shipped
change must bump the version.

To bump the pinned upstream language server:

1. Set `VERSION` in `plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp` to the new release tag.
2. Regenerate the integrity pins **and** the schema-derived hover docs for the new version.
   With `--write` the launcher's pin block is rewritten in place and the `HOVER_DOCS` table in
   `lsp-hover.mjs` is regenerated from the new release's `schema.json` (both in lockstep):
   ```bash
   scripts/update-pins.sh <version> --write
   ```
   Without `--write` the `case` arms are printed for manual pasting (the hover docs are still
   regenerated). Either way, review the launcher and `lsp-hover.mjs` diffs. (The size **and**
   SHA-256 pins must match the new release, or the launcher will refuse to run that platform's
   binary.)
3. Bump `version` in `plugins/circleci-yaml-lsp/.claude-plugin/plugin.json`.
4. Update [`CHANGELOG.md`](CHANGELOG.md).
5. Validate, commit, and (optionally) tag:
   ```bash
   claude plugin validate ./plugins/circleci-yaml-lsp --strict
   claude plugin tag ./plugins/circleci-yaml-lsp   # creates circleci-yaml-lsp--vX.Y.Z
   ```

For any other change (launcher/proxy fixes, `.lsp.json` tweaks), steps 3–5 still apply.

Most upstream bumps are opened for you: a scheduled CircleCI job runs
[`scripts/open-upstream-update-pr.sh`](scripts/open-upstream-update-pr.sh) and opens a PR
performing steps 1–3 automatically when a newer stable release ships (it never merges — you
still review the diff). See [Scheduled upstream updates](docs/DESIGN.md#scheduled-upstream-updates).

## Conventions

- Keep the launcher POSIX-friendly (`#!/usr/bin/env bash`, runs on macOS bash 3.2 and Linux).
- The proxy targets the Node that ships with / alongside Claude Code; avoid non-builtin deps.
- Don't vendor the server binary — it's downloaded and verified at runtime.
