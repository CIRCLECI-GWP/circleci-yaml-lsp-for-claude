# Design

How this plugin turns CircleCI's `circleci-yaml-language-server` into a well-behaved
Claude Code LSP, and why it's built the way it is.

## The problem

Two facts collide:

1. **Claude Code selects an LSP server by file extension only.** A plugin's `.lsp.json`
   maps extensions to a language id (`".yml" → "yaml"`); there is no path/glob filter. Any
   file with a mapped extension is eligible to be sent to that server.
2. **The CircleCI server validates *every* document it receives as a CircleCI config.** It
   has no notion of "is this actually a CircleCI file?" — the official VS Code extension
   restricts itself to `.circleci/**` on the *client* side. Hand it a `docker-compose.yml`
   and it reports `version must be one of "2.1"`; hand it a Helm `values.yaml` and it
   reports `version is required`.

So mapping `.yml`/`.yaml` to this server naïvely would spray false CircleCI errors across
every unrelated YAML file in a repo. The plugin's job is to give Claude Code the extension
mapping it needs while constraining the server to files it actually understands.

## Architecture

```
Claude Code ⇄ (stdio)  bin/circleci-yaml-lsp        # launcher: provision + verify binary
                         └─ exec ─▶ bin/lsp-proxy.mjs  # scope to .circleci config files
                                     └─ spawn ─▶ <cached server binary> -stdio
```

### 1. Launcher — `bin/circleci-yaml-lsp`

A POSIX shell script set as the LSP `command` (via `${CLAUDE_PLUGIN_ROOT}/bin/...`). On
first use it:

- Detects OS/arch and picks the release asset (`darwin-arm64-lsp`, `linux-amd64-lsp`, …).
- Downloads it from CircleCI's GitHub Releases for the pinned `VERSION` into a persistent,
  version-keyed cache (`${CLAUDE_PLUGIN_DATA}`, falling back to `$XDG_CACHE_HOME`/`$HOME`).
- **Verifies SHA-256 and byte size** against pins baked into the script, writing to a
  temp file and atomically `mv`-ing into place only after verification (a cleanup trap
  removes the temp on any interruption).
- `exec`s the proxy (or, with `CIRCLECI_YAML_LSP_SCOPE=off`, the server directly).

No Go toolchain is needed — CircleCI publishes prebuilt binaries and embeds the JSON schema
in them (`go:embed`), so a single binary is self-contained. The binary is **not** vendored
into this repo; it's fetched at runtime and verified, keeping the repo tiny and the server
updatable independently. `CIRCLECI_YAML_LSP_BINARY` overrides the whole download path for
offline/air-gapped/Windows/self-built use.

### 2. Scoping proxy — `bin/lsp-proxy.mjs`

A small Node program that relays Content-Length-framed JSON-RPC between Claude Code (its
stdio) and the server (a child it spawns with `-stdio`). It forwards everything verbatim
**except**:

- **Document-sync notifications** (`didOpen`/`didChange`/`didClose`) for files **not** in
  scope are dropped, so the server never sees — and never diagnoses — non-CircleCI YAML.
- **`publishDiagnostics`** for out-of-scope URIs are dropped defensively.
- **`textDocument/hover`** is answered by the proxy itself (see [Hover](#hover) below)
  rather than forwarded; out-of-scope hover requests get an empty result.

"In scope" defaults to the regex `(^|/)\.circleci/([^/]*_)?config\.ya?ml$` — a CircleCI config
file directly under a `.circleci/` directory: `config.yml`/`.yaml`, or a `<prefix>_config.yml`
continuation config (e.g. `continue_config.yml`, `setup_config.yml`). It excludes non-config
YAML kept beside them (`test-suites.yml`, `eslint.config.yml`, `db-config.yml`) and helper
files in subdirectories. Override with `CIRCLECI_YAML_LSP_SCOPE_PATTERN`.

Forwarding other requests (completion, definition, …) unchanged is safe: for a document the
server never opened it simply replies empty, so there's no hang or hard error.

### Hover

The server advertises `hoverProvider` but its implementation returns `null` for every
position (a stub as of 0.35.x), so forwarding hover would always yield nothing. Instead the
proxy answers `textDocument/hover` itself from `bin/lsp-hover.mjs`: it finds the key token
under the cursor and looks it up in a table of descriptions extracted from CircleCI's
published config schema (`schema.json`). The extraction takes each property's
`markdownDescription`, falling back one level into `oneOf`/`anyOf`/`allOf`/`items`/`then`/
`else`/`$ref` so keys whose docs live on a schema branch (e.g. `executor`) are still
covered. Lookup is by key **name**, not full schema position — a deliberate simplification,
so a name used in multiple contexts resolves to its first schema definition. In-scope text
comes from the proxy's document mirror, falling back to reading the file from disk when the
proxy started after the document was already open (e.g. a plugin reload).

**Why Node, and why fail closed without it.** The proxy needs a runtime; Node is the
pragmatic choice because Claude Code itself is a Node application, so it's almost always
present. Scoping is the whole point, so if Node is genuinely missing the launcher **fails
closed** with an actionable message rather than silently running in broad mode and feeding
the model wrong diagnostics. Broad mode remains available as an explicit opt-in
(`CIRCLECI_YAML_LSP_SCOPE=off`).

### Optional authentication

If `CIRCLECI_YAML_LSP_TOKEN` (and optionally `CIRCLECI_YAML_LSP_SELF_HOSTED_URL`) is set,
the proxy injects the server's `setToken` / `setSelfHostedUrl` `workspace/executeCommand`
right after the client's `initialized` notification, then swallows the replies (they carry
a sentinel string id, so Claude Code never sees them). This unlocks private-orb / context /
self-hosted resolution, which Claude Code's LSP client otherwise has no way to trigger.

### Working around the server's didChange bug

Server 0.35.0 **duplicates a document's content when it receives a
`textDocument/didChange`** (verified for both full-replace and incremental changes),
producing spurious `… already defined` diagnostics. The server handles `didOpen`
correctly, though. So the proxy:

- rewrites the `initialize` response to advertise **full document sync**, and
- mirrors each in-scope document's text and **replays every change as a `didOpen`**
  (applying incremental edits to the mirror when needed), so the server only ever
  sees opens.

Set `CIRCLECI_YAML_LSP_DEBUG=/path/to/log` to record proxy ⇄ server traffic when
diagnosing issues. If upstream fixes the `didChange` handling, this workaround can be
removed.

## Diagnostics model

The server is **push-only** (`textDocument/publishDiagnostics`); it does not implement pull
diagnostics (`textDocument/diagnostic`). In practice Claude Code spawns the server lazily
and attaches diagnostics when a matching file is **edited** — a plain read does not trigger
validation.

## Plugin packaging

- The real `.lsp.json` ships in the plugin directory (not only referenced from
  `marketplace.json`). Relying on `marketplace.json` alone is a known failure mode where
  zero servers get registered.
- The repository doubles as a single-plugin **marketplace**: `.claude-plugin/marketplace.json`
  at the root points at `./plugins/circleci-yaml-lsp` via a relative source (which resolves
  when the marketplace is added from git).
- `command`/`args` use `${CLAUDE_PLUGIN_ROOT}` so they resolve against the installed copy;
  the persistent cache uses `${CLAUDE_PLUGIN_DATA}` so the downloaded binary survives plugin
  updates.

## Verification performed

The pipeline was validated end-to-end, including inside a real Claude Code session:

- The pinned binary runs natively and speaks LSP over stdio (`initialize` → capabilities;
  `didOpen` → `publishDiagnostics`).
- Installed via marketplace, Claude Code registers the server (`LSP servers (1)`), and an
  edit to `.circleci/config.yml` triggers the lazy spawn: the launcher downloads/verifies
  the binary into `${CLAUDE_PLUGIN_DATA}` and the verbatim CircleCI diagnostics reach the
  model.
- Scoping: `.circleci/config.yml` and `.circleci/continue_config.yml` are diagnosed;
  `.circleci/test-suites.yml` and `docker-compose.yml` receive **zero** diagnostics.
- Token injection reaches the server and its replies are swallowed (no sentinel id leaks to
  the client).

## Maintenance

- **Pinned to a specific upstream release** (`VERSION` in the launcher) for reproducible,
  verifiable installs.
- Bumping the server version is a two-step change: update `VERSION` **and** the size/SHA
  pins (run [`scripts/update-pins.sh`](../scripts/update-pins.sh)), then bump
  `plugin.json` `version`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
