#!/usr/bin/env node
// check-upstream-release.mjs — compare the latest upstream STABLE release to the
// version pinned in the launcher. Prints "current=<v> latest=<v>" to stderr and the
// latest tag to stdout. Exit 0 if an update is available, 3 if already current.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "CircleCI-Public/circleci-yaml-language-server";
const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "plugins/circleci-yaml-lsp/bin/circleci-yaml-lsp");

const current = /^VERSION="([^"]+)"/m.exec(readFileSync(launcher, "utf8"))?.[1];
if (!current) throw new Error("could not read pinned VERSION");

// /releases/latest excludes prereleases.
const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
  headers: { "accept": "application/vnd.github+json", "user-agent": "cci-lsp-plugin" },
});
if (!res.ok) throw new Error(`GitHub API ${res.status}`);
const latest = (await res.json()).tag_name;

process.stderr.write(`current=${current} latest=${latest}\n`);
process.stdout.write(latest + "\n");
process.exit(latest && latest !== current ? 0 : 3);
