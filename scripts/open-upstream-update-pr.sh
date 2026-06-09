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
# The tag is interpolated into a branch name, a git ref, and shell commands — refuse
# anything that isn't a plain version token before using it.
if ! printf '%s' "$latest" | grep -qE '^v?[0-9][0-9A-Za-z.+_-]*$'; then
  echo "refusing to act on unexpected upstream tag: '$latest'" >&2; exit 1
fi

current="$(grep -E '^VERSION=' "$launcher" | head -1 | cut -d'"' -f2)"
branch="chore/bump-language-server-$latest"

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "branch $branch already exists on origin; assuming PR is open" >&2; exit 0
fi

git checkout -b "$branch"

# 1) bump pinned server version in the launcher
node - "$launcher" "$current" "$latest" <<'NODE'
const fs=require("fs");const[f,cur,next]=process.argv.slice(2);
const before=fs.readFileSync(f,"utf8");
const after=before.replace(`VERSION="${cur}"`,`VERSION="${next}"`);
if(after===before){console.error(`could not find VERSION="${cur}" in ${f}`);process.exit(1);}
fs.writeFileSync(f,after);
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

# Open the PR. A non-existent --label makes `gh pr create` exit non-zero WITHOUT
# creating the PR, which would leave the branch pushed but PR-less and wedge every
# future run on the branch-exists guard above. So create first (no --label), and only
# then add the label best-effort. If creation itself fails, delete the pushed branch
# and fail the job so the next scheduled run retries from a clean slate.
if ! gh pr create \
  --title "chore: bump language server $current -> $latest" \
  --body "Automated upstream bump. Refreshes pinned binary size/SHA-256, regenerates \`HOVER_DOCS\` from the new \`schema.json\`, and patch-bumps the plugin version. **Review the hover-doc and pin diffs before merging.** Do not auto-merge."; then
  echo "gh pr create failed; deleting pushed branch so a later run can retry" >&2
  git push origin --delete "$branch" || true
  exit 1
fi

# Best-effort label — never fatal (the label, or the token's issues:write scope, may be absent).
gh label create automated --color ededed --description "Opened by the scheduled upstream-update job" >/dev/null 2>&1 || true
gh pr edit "$branch" --add-label automated >/dev/null 2>&1 || true
