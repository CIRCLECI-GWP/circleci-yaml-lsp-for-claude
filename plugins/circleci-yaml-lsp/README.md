# circleci-yaml-lsp

A Claude Code plugin that runs CircleCI's
[`circleci-yaml-language-server`](https://github.com/CircleCI-Public/circleci-yaml-language-server)
to give Claude real diagnostics, navigation, and validation for `.circleci/config.yml`.

```text
/plugin marketplace add rogerwintercircleci/circleci-yaml-lsp-for-claude
/plugin install circleci-yaml-lsp@circleci-lsp
/reload-plugins
```

On first edit of a CircleCI config the plugin downloads the pinned server binary for your
platform (no Go required), verifies its SHA-256, and starts validating. A Node-based proxy
limits analysis to CircleCI config files so unrelated YAML is never touched.

- **Requirements:** recent Claude Code (v2.1.50+), Node.js, `curl`/`wget`, macOS/Linux
  (Windows via WSL/Git Bash).
- **Full docs, env vars, scope & limitations, troubleshooting:** see the
  [repository README](https://github.com/rogerwintercircleci/circleci-yaml-lsp-for-claude#readme)
  and [`docs/DESIGN.md`](https://github.com/rogerwintercircleci/circleci-yaml-lsp-for-claude/blob/main/docs/DESIGN.md).

This plugin is MIT-licensed; the downloaded server is CircleCI's, under Apache-2.0, fetched
at runtime and not redistributed here.
