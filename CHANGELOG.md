# Changelog

All notable changes to this plugin are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.1.3 — 2026-06-08

- Launcher: shellcheck-clean `CDPATH` handling when resolving the script directory
  (behavior unchanged).
- Repo: add CircleCI CI (`lint` + `test`, no build); the `test` job emits a JUnit report
  via Node's test runner and stores it with `store_test_results`. The config was written and
  validated with this plugin's own LSP.

## 0.1.2 — 2026-06-08

- Internal: extract the proxy's pure helpers into `lsp-proxy-lib.mjs` and add a test suite
  (Node's built-in runner + a mock LSP server; unit + integration). No behavior change.

## 0.1.1 — 2026-06-08

- **Fix document duplication.** The server duplicates a document's content on
  `textDocument/didChange` (both full and incremental), producing spurious
  `… already defined` errors after an edit. The proxy now advertises full
  document sync and replays every change as a `didOpen`, which the server applies
  correctly. Diagnostics stay accurate across edits.
- Add `CIRCLECI_YAML_LSP_DEBUG=/path` to log proxy ⇄ server traffic for
  troubleshooting.

## 0.1.0 — 2026-06-08

Initial release.

- Wires CircleCI's `circleci-yaml-language-server` (pinned to upstream **0.35.0**) into
  Claude Code as an LSP server for `.circleci/config.yml`.
- **Zero-setup provisioning:** the launcher downloads the platform-appropriate prebuilt
  binary on first use and verifies it by **SHA-256 and byte size** before running. No Go
  toolchain required.
- **Scoping proxy:** a Node stdio proxy limits analysis to config-named YAML under
  `.circleci/`, so unrelated YAML (docker-compose, Kubernetes, Helm, …) is never
  mis-validated as a CircleCI config. Override with `CIRCLECI_YAML_LSP_SCOPE_PATTERN`.
- **Fail-closed without Node:** if Node is unavailable the plugin reports an actionable
  error rather than silently mis-flagging all YAML; broad mode is an explicit opt-in
  (`CIRCLECI_YAML_LSP_SCOPE=off`).
- **Optional authentication:** `CIRCLECI_YAML_LSP_TOKEN` /
  `CIRCLECI_YAML_LSP_SELF_HOSTED_URL` enable private-orb, context, and self-hosted
  resolution by injecting `setToken` / `setSelfHostedUrl` after initialization.
- Distributed as a single-plugin marketplace; `bin/`, `.lsp.json`, and `plugin.json`
  included so the LSP server registers correctly on install.
