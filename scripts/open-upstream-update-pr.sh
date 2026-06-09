#!/usr/bin/env bash
#
# open-upstream-update-pr.sh — if upstream shipped a newer language-server release,
# bump the pin, refresh binary pins + hover docs, bump the plugin version, run tests,
# and open a PR. Intended for CI (scheduled). Never merges. Requires: node, gh
# authenticated (GH_TOKEN/GITHUB_TOKEN in CI), git identity configured.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
launcher="$root/plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp"
plugin_json="$root/plugins/circleci-yaml-lsp/.claude-plugin/plugin.json"
pkg_json="$root/package.json"

latest="$(node "$root/scripts/check-upstream-release.mjs")" || {
  echo "already current; nothing to do" >&2; exit 0;
}
current="$(grep -E '^VERSION=' "$launcher" | cut -d'"' -f2)"
branch="chore/bump-language-server-$latest"

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "branch $branch already exists on origin; assuming PR is open" >&2; exit 0
fi

git checkout -b "$branch"

# 1) bump pinned server version in the launcher
node - "$launcher" "$current" "$latest" <<'NODE'
const fs=require("fs");const[f,cur,next]=process.argv.slice(2);
const s=fs.readFileSync(f,"utf8").replace(`VERSION="${cur}"`,`VERSION="${next}"`);
fs.writeFileSync(f,s);
NODE

# 2) refresh binary pins (in place) and 3) regenerate hover docs
bash "$root/scripts/update-pins.sh" "$latest" --write

# 4) bump plugin + package versions (patch bump)
node - "$plugin_json" "$pkg_json" <<'NODE'
const fs=require("fs");
for(const f of process.argv.slice(2)){
  const j=JSON.parse(fs.readFileSync(f,"utf8"));
  const [a,b,c]=j.version.split(".").map(Number);
  j.version=`${a}.${b}.${c+1}`;
  fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");
}
NODE

# 5) tests must pass before we open anything
( cd "$root" && npm test )

git add -A
git commit -m "chore: bump language server $current -> $latest

Automated by the scheduled upstream-update job: refreshes binary pins and
regenerates schema-derived hover docs. Review the diff before merging."

git push -u origin "$branch"

gh pr create \
  --title "chore: bump language server $current -> $latest" \
  --body "Automated upstream bump. Refreshes pinned binary size/SHA-256, regenerates \`HOVER_DOCS\` from the new \`schema.json\`, and patch-bumps the plugin version. **Review the hover-doc and pin diffs before merging.** Do not auto-merge." \
  --label "automated" || echo "pr create failed (label may not exist); rerun gh pr create without --label" >&2
