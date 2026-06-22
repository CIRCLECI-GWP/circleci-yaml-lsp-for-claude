#!/usr/bin/env node
// check-upstream-release.mjs — compare the latest upstream STABLE release to the
// version pinned in the launcher. Prints "current=<v> latest=<v>" to stderr and the
// latest tag to stdout. Exit 0 if an update is available (and its assets are fully
// published), 3 if already current or the latest release isn't ready yet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "CircleCI-Public/circleci-yaml-language-server";
const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp");

// Assets the downstream automation downloads for a release: the platform binaries
// (update-pins.sh) and schema.json (gen-hover-docs.mjs). Upstream sometimes publishes
// the release tag before its CI finishes uploading these — consuming such a release
// 404s mid-bump. Treat a release as actionable only once ALL of these are present AND
// fully uploaded: GitHub lists an asset's name as soon as the upload is *initiated*
// (state "starter"/"open"), but downloads 404 until state flips to "uploaded".
const REQUIRED_ASSETS = [
  "darwin-arm64-lsp",
  "darwin-amd64-lsp",
  "linux-amd64-lsp",
  "linux-arm64-lsp",
  "schema.json",
];

const current = /^VERSION="([^"]+)"/m.exec(readFileSync(launcher, "utf8"))?.[1];
if (!current) throw new Error("could not read pinned VERSION");

// /releases/latest excludes prereleases.
const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
  headers: { "accept": "application/vnd.github+json", "user-agent": "cci-lsp-plugin" },
});
if (!res.ok) throw new Error(`GitHub API ${res.status}`);
const release = await res.json();
const latest = release.tag_name;

process.stderr.write(`current=${current} latest=${latest}\n`);

if (!latest || latest === current) process.exit(3);

// Guard against acting on a freshly-tagged release whose binaries/schema haven't
// been uploaded yet: report "not ready" (exit 3, like "already current") so the PR
// job does nothing and a later scheduled run retries once assets land.
const names = new Set(
  (release.assets ?? []).filter((a) => a.state === "uploaded").map((a) => a.name),
);
const missing = REQUIRED_ASSETS.filter((a) => !names.has(a));
if (missing.length) {
  process.stderr.write(`latest ${latest} not ready: missing assets ${missing.join(", ")}\n`);
  process.exit(3);
}

process.stdout.write(latest + "\n");
process.exit(0);
