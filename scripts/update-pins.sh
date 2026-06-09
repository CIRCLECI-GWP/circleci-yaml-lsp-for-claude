#!/usr/bin/env bash
#
# update-pins.sh — regenerate the size + SHA-256 integrity pins for a release.
#
# The launcher (plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp) pins the byte
# size and SHA-256 of each platform binary so a corrupt or tampered download is
# refused. Those pins MUST be regenerated whenever the pinned VERSION changes.
#
# Usage:
#   scripts/update-pins.sh [VERSION]    # defaults to the VERSION in the launcher
#
# It downloads each platform asset for VERSION and prints the bash `case` arms to
# paste into the launcher. Remember to ALSO bump "version" in plugin.json —
# Claude Code applies plugin updates only when that version string changes.
#
set -euo pipefail

REPO="CircleCI-Public/circleci-yaml-language-server"
launcher="$(cd "$(dirname "$0")/.." && pwd)/plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp"
VERSION="${1:-$(grep -E '^VERSION=' "$launcher" | head -1 | cut -d'"' -f2)}"

echo "# integrity pins for $REPO @ $VERSION" >&2
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

for a in darwin-arm64-lsp darwin-amd64-lsp linux-amd64-lsp linux-arm64-lsp; do
  url="https://github.com/$REPO/releases/download/$VERSION/$a"
  curl -fsSL "$url" -o "$tmp/$a"
  size="$(wc -c < "$tmp/$a" | tr -d ' ')"
  if command -v sha256sum >/dev/null 2>&1; then
    sha="$(sha256sum "$tmp/$a" | awk '{print $1}')"
  else
    sha="$(shasum -a 256 "$tmp/$a" | awk '{print $1}')"
  fi
  printf '    %-18s expected_size=%s; expected_sha="%s" ;;\n' "$a)" "$size" "$sha"
done

# Regenerate the schema-derived hover docs for this same VERSION so they stay in
# lockstep with the pinned server. (Edits lsp-hover.mjs in place; review the diff.)
echo "# regenerating hover docs for $VERSION" >&2
node "$(cd "$(dirname "$0")/.." && pwd)/scripts/gen-hover-docs.mjs"
