#!/usr/bin/env node
//
// lsp-proxy.mjs — scoping proxy for circleci-yaml-language-server.
//
// Claude Code routes files to LSP servers by file extension only, but the
// CircleCI language server treats EVERY document it receives as a CircleCI
// config (so it mis-validates docker-compose, Kubernetes, GitHub Actions,
// Helm, etc.). This proxy sits between Claude Code (stdio) and the server
// (stdio) and only forwards document-sync notifications for files whose URI
// looks like a CircleCI config (a config-named *.yml/*.yaml under a .circleci/
// directory). All other JSON-RPC traffic is forwarded untouched, so requests
// still work and non-CircleCI YAML is simply never analyzed.
//
//   CIRCLECI_YAML_LSP_SCOPE_PATTERN   regex (case-insensitive) overriding the
//                                     default "in scope" test, matched against the URI.
//   CIRCLECI_YAML_LSP_TOKEN           CircleCI API token; if set, a setToken
//                                     command is sent after initialization (private orbs).
//   CIRCLECI_YAML_LSP_SELF_HOSTED_URL CircleCI Server base URL; sent via setSelfHostedUrl.

import { spawn } from "node:child_process";

const serverBin = process.argv[2];
if (!serverBin) {
  process.stderr.write("[lsp-proxy] usage: lsp-proxy.mjs <server-binary>\n");
  process.exit(2);
}

// In scope = a config-named YAML directly inside a .circleci/ directory
// (e.g. .circleci/config.yml, .circleci/continue_config.yml). Excludes other
// YAML kept under .circleci/ (e.g. test-suites.yml, helper scripts).
const DEFAULT_SCOPE = /(^|\/)\.circleci\/[^/]*config[^/]*\.ya?ml$/i;
let scopeRe = DEFAULT_SCOPE;
if (process.env.CIRCLECI_YAML_LSP_SCOPE_PATTERN) {
  try { scopeRe = new RegExp(process.env.CIRCLECI_YAML_LSP_SCOPE_PATTERN, "i"); }
  catch (e) { process.stderr.write(`[lsp-proxy] invalid CIRCLECI_YAML_LSP_SCOPE_PATTERN, using default: ${e.message}\n`); }
}
const inScope = (uri) => typeof uri === "string" && scopeRe.test(uri);

// Document-sync NOTIFICATIONS only (no ids). Dropping these for out-of-scope
// files keeps the server from ever seeing non-CircleCI YAML. (didSave/willSave/
// willSaveWaitUntil are intentionally omitted: the server doesn't advertise them,
// and willSaveWaitUntil is a request whose id must not be swallowed.)
const SYNC_METHODS = new Set([
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
]);

const TOKEN = process.env.CIRCLECI_YAML_LSP_TOKEN || "";
const SELF_HOSTED = process.env.CIRCLECI_YAML_LSP_SELF_HOSTED_URL || "";
const SENTINEL = "__cci_proxy__"; // id prefix for commands we inject; their replies are swallowed

const server = spawn(serverBin, ["-stdio"], { stdio: ["pipe", "pipe", "pipe"] });
server.on("error", (e) => {
  process.stderr.write(`[lsp-proxy] failed to start language server: ${e.message}\n`);
  process.exit(1);
});
server.stderr.on("data", (d) => process.stderr.write(d));
server.on("exit", (code, signal) => process.exit(code == null ? (signal ? 1 : 0) : code));

// Re-attach LSP framing to an already-serialized JSON-RPC body (Buffer).
function withHeader(body) {
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}
function sendToServer(obj) {
  server.stdin.write(withHeader(Buffer.from(JSON.stringify(obj), "utf8")));
}

// Streaming reader for Content-Length-framed LSP messages. Feed it chunks; it
// invokes onMessage(parsedOrNull, rawBodyBuffer) for each complete message.
function makeReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.toString("ascii", 0, sep));
      if (!m) { buf = buf.subarray(sep + 4); continue; } // malformed; resync
      const len = parseInt(m[1], 10);
      const start = sep + 4;
      if (buf.length < start + len) return; // body not fully arrived yet
      const body = buf.subarray(start, start + len);
      buf = buf.subarray(start + len);
      let msg = null;
      try { msg = JSON.parse(body.toString("utf8")); } catch { /* pass raw */ }
      onMessage(msg, body);
    }
  };
}

// Client (Claude Code) -> server: drop out-of-scope document-sync notifications.
const fromClient = makeReader((msg, body) => {
  if (msg && SYNC_METHODS.has(msg.method) && !inScope(msg?.params?.textDocument?.uri)) {
    return; // keep this file away from the CircleCI server
  }
  server.stdin.write(withHeader(body));
  // After the client signals initialization is complete, optionally authenticate
  // so the server can resolve private orbs / contexts / self-hosted runners.
  if (msg && msg.method === "initialized") {
    if (SELF_HOSTED) sendToServer({ jsonrpc: "2.0", id: SENTINEL + "url", method: "workspace/executeCommand", params: { command: "setSelfHostedUrl", arguments: [SELF_HOSTED] } });
    if (TOKEN) sendToServer({ jsonrpc: "2.0", id: SENTINEL + "token", method: "workspace/executeCommand", params: { command: "setToken", arguments: [TOKEN] } });
  }
});

// Server -> client: swallow replies to our injected commands; defensively
// suppress diagnostics for out-of-scope files.
const fromServer = makeReader((msg, body) => {
  if (msg && typeof msg.id === "string" && msg.id.startsWith(SENTINEL)) return;
  if (msg && msg.method === "textDocument/publishDiagnostics" && !inScope(msg?.params?.uri)) return;
  process.stdout.write(withHeader(body));
});

process.stdin.on("data", fromClient);
server.stdout.on("data", fromServer);

process.stdin.on("end", () => { try { server.stdin.end(); } catch { /* ignore */ } });
process.stdin.on("error", () => {});
process.stdout.on("error", () => {}); // clean EPIPE when the client goes away
server.stdin.on("error", () => {});

// Don't leave an orphaned server behind.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { try { server.kill(sig); } catch { /* ignore */ } process.exit(0); });
}
process.on("exit", () => { try { server.kill(); } catch { /* ignore */ } });
