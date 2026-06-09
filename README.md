# CircleCI YAML Language Server Protocol (LSP) for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin that wires up CircleCI's
official [`circleci-yaml-language-server`](https://github.com/CircleCI-Public/circleci-yaml-language-server)
as a language server, so Claude gets **real CircleCI config diagnostics** — undefined
job references, invalid/deprecated keys, unused jobs, orb problems, and more — directly
in your editing loop on `.circleci/config.yml`.

It is zero-setup: the plugin downloads the right prebuilt server binary for your platform
on first use (no Go toolchain required) and verifies it before running.

> **Scope:** this is a **CircleCI config** language server, *not* a general-purpose YAML
> server. It only understands CircleCI's schema, so the plugin deliberately limits it to
> CircleCI config files (see [Scope & limitations](#scope--limitations)). For everyday YAML,
> use a general YAML server such as [Red Hat's `yaml-language-server`](https://github.com/redhat-developer/yaml-language-server).

---

## Requirements

- **Claude Code** with plugin LSP support — v2.1.50 or newer recommended.
- **Node.js** on `PATH` — used to scope analysis to CircleCI config files. Claude Code
  installed via npm already has it. Without Node the plugin fails closed (see
  [`CIRCLECI_YAML_LSP_SCOPE`](#environment-variables)).
- **`curl` or `wget`**, and network access on first run (to download the server binary).
- **macOS or Linux** (x86-64 or arm64). Windows works via WSL/Git Bash — see
  [Windows](#windows).

## Install

```text
/plugin marketplace add rogerwintercircleci/circleci-yaml-lsp-for-claude
/plugin install circleci-yaml-lsp@circleci-lsp
/reload-plugins
```

That's it. The first time you edit a `.circleci/config.yml`, the plugin downloads the
pinned CircleCI language-server binary (~13–20 MB, once per version) into a cache and
starts validating.

## Usage

Open a project that has a `.circleci/config.yml` and work as usual. Diagnostics surface
**when Claude edits the file** (the server is push-based; a plain read does not trigger
validation — make a trivial edit to force a check). The very first edit also downloads and
starts the server (a few seconds), so diagnostics may land a moment later or on your next
edit; once the server is warm, subsequent edits are instant. Claude sees the same
diagnostics your editor would:

```text
✘ [Line 12:7] Cannot find declaration for job "nonexistent-job"
⚠ [Line 4:3]  Job is unused
```

Beyond diagnostics, the server also provides go-to-definition / find-references across
jobs, executors, commands and orbs, autocompletion, document symbols, and quick-fix code
actions — Claude can use these through its LSP tooling. The plugin additionally serves
**hover documentation** for CircleCI config keys (e.g. `executor`, `store_artifacts`,
`working_directory`), sourced from CircleCI's published config schema — see
[How it works](#how-it-works).

## How it works

Claude Code routes files to a language server purely by **file extension**, and the
CircleCI server treats *every* document it receives as a CircleCI config. A naïve
`.yml → yaml` mapping would therefore make it mis-validate every unrelated YAML file
(docker-compose, Kubernetes, Helm …). To avoid that, the plugin ships a
tiny launcher and a stdio proxy:

1. **`bin/circleci-yaml-lsp`** (launcher) detects your OS/arch, downloads the pinned
   server binary from CircleCI's GitHub Releases into a persistent cache, verifies its
   **SHA-256 and byte size**, and starts it.
2. **`bin/lsp-proxy.mjs`** (Node) sits between Claude Code and the server and only forwards
   document-sync messages for files that look like CircleCI configs — config-named
   `*.yml`/`*.yaml` under a `.circleci/` directory. Everything else is left untouched, so
   unrelated YAML is never analyzed.
3. The proxy also answers **`textDocument/hover`** itself: the upstream server advertises
   the capability but returns nothing, so the proxy looks up the key under the cursor in
   a table of descriptions extracted from CircleCI's config schema
   (`bin/lsp-hover.mjs`). Out-of-scope files get an empty hover, same as document sync.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full architecture and rationale.

## Environment variables

All are optional. Set them in the environment Claude Code runs in (e.g. your shell
profile).

| Variable | Purpose |
|---|---|
| `CIRCLECI_YAML_LSP_BINARY` | Absolute path to a server binary to use instead of downloading. Use this for offline/air-gapped machines, corporate proxies, Windows, or a self-built binary. |
| `CIRCLECI_YAML_LSP_NODE` | Path to a `node` executable for the scoping proxy, if `node` isn't on `PATH`. |
| `CIRCLECI_YAML_LSP_SCOPE` | Set to `off` to disable scoping and validate **all** `.yml`/`.yaml` as CircleCI config (only useful if your repo is CircleCI-only). |
| `CIRCLECI_YAML_LSP_SCOPE_PATTERN` | Case-insensitive **regex** (matched against the file URI) overriding which files are in scope. Default matches config-named YAML under `.circleci/`. |
| `CIRCLECI_YAML_LSP_TOKEN` | A [CircleCI API token](https://app.circleci.com/settings/user/tokens). Enables resolution of **private orbs**, contexts, and self-hosted runners. |
| `CIRCLECI_YAML_LSP_SELF_HOSTED_URL` | Base URL of your CircleCI Server (self-hosted) installation. |
| `CIRCLECI_YAML_LSP_DEBUG` | Path to a file; logs proxy ⇄ server traffic for troubleshooting. |

Example (offline / pre-provisioned binary):

```bash
export CIRCLECI_YAML_LSP_BINARY="$HOME/bin/linux-amd64-lsp"
```

## Scope & limitations

- **CircleCI configs only.** This server validates against CircleCI's schema; it is not a
  general YAML server and provides nothing useful for other YAML. By default the plugin
  only engages on config-named YAML under `.circleci/` (e.g. `config.yml`,
  `continue_config.yml`). Other YAML — including non-config files you keep under
  `.circleci/`, like `test-suites.yml` — is ignored. If your config lives elsewhere or
  uses a non-standard name, set `CIRCLECI_YAML_LSP_SCOPE_PATTERN`.
- **Diagnostics appear on edit.** The server pushes diagnostics; it does not implement
  pull diagnostics. A plain read won't validate — make a trivial edit to trigger it.
- **Private orbs / contexts / self-hosted runners** need authentication. Without a token
  you'll see false `Orb … does not exist or is private` errors on valid private orbs. Set
  [`CIRCLECI_YAML_LSP_TOKEN`](#environment-variables) (and `CIRCLECI_YAML_LSP_SELF_HOSTED_URL`
  for CircleCI Server) to fix this.
- **Hover** is not implemented by the upstream server (it advertises the capability but
  returns nothing). The plugin fills this in proxy-side using CircleCI's config schema,
  matching on the key name under the cursor. Lookup is by key name rather than full schema
  position, so a key used in multiple contexts resolves to its first schema definition.
  The descriptions are generated from the `schema.json` of the server version pinned in the
  launcher and are regenerated whenever that pin is bumped, so they track the pinned version
  rather than upstream "latest".

## Windows

The launcher is a POSIX shell script, so on native Windows run Claude Code under **WSL** or
**Git Bash**. Then download `windows-amd64-lsp.exe` from the
[0.35.0 release](https://github.com/CircleCI-Public/circleci-yaml-language-server/releases/tag/0.35.0)
and point the plugin at it:

```bash
export CIRCLECI_YAML_LSP_BINARY="/c/Users/you/bin/windows-amd64-lsp.exe"
```

(There is no `windows-arm64` build upstream.)

## Troubleshooting

- **No diagnostics?** Make sure you *edited* the config (a read alone won't trigger it),
  and that the file is a config-named YAML under `.circleci/`.
- **Check `/plugin` → Errors tab** for launcher/server errors.
- **First run hangs or fails** — it's downloading the binary; you need network access. On
  an air-gapped/proxied machine, pre-provision the binary with `CIRCLECI_YAML_LSP_BINARY`.
- **"Node.js is required …"** — install Node, set `CIRCLECI_YAML_LSP_NODE`, or set
  `CIRCLECI_YAML_LSP_SCOPE=off` (validates all YAML — only for CircleCI-only repos).
- After installing/updating, run `/reload-plugins` (or restart Claude Code).

## Security & provenance

The plugin (MIT) does **not** bundle or redistribute the language server. On first use it
downloads the pinned release binary from CircleCI's official GitHub Releases over HTTPS and
verifies it against a **SHA-256 and byte-size pinned in the launcher** before executing it —
and **refuses to run** if the checksum doesn't match or no SHA-256 tool is available.
The downloaded binary is CircleCI's
[`circleci-yaml-language-server`](https://github.com/CircleCI-Public/circleci-yaml-language-server),
licensed under Apache-2.0. To audit or replace it, use `CIRCLECI_YAML_LSP_BINARY`.

## Uninstall

```text
/plugin uninstall circleci-yaml-lsp@circleci-lsp
/plugin marketplace remove circleci-lsp
```

The cached binary lives under Claude Code's plugin data directory and can be deleted safely.

## Credits & license

- Language server: [CircleCI-Public/circleci-yaml-language-server](https://github.com/CircleCI-Public/circleci-yaml-language-server) (Apache-2.0), by CircleCI.
- This plugin: MIT — see [LICENSE](LICENSE).
