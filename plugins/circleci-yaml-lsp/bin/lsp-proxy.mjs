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
// It also works around a server bug (see below), forces full document sync, and
// can authenticate for private orbs. Pure helpers live in lsp-proxy-lib.mjs.
//
//   CIRCLECI_YAML_LSP_SCOPE_PATTERN   regex (case-insensitive) overriding the
//                                     default "in scope" test, matched against the URI.
//   CIRCLECI_YAML_LSP_TOKEN           CircleCI API token; if set, setToken is sent
//                                     after initialization (private orbs).
//   CIRCLECI_YAML_LSP_SELF_HOSTED_URL CircleCI Server base URL; sent via setSelfHostedUrl.
//   CIRCLECI_YAML_LSP_DEBUG           path to a file; logs proxy <-> server traffic.

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeInScope, applyEdits, frame, makeReader } from "./lsp-proxy-lib.mjs";
import { doHover } from "./lsp-hover.mjs";

const serverBin = process.argv[2];
if (!serverBin) {
  process.stderr.write("[lsp-proxy] usage: lsp-proxy.mjs <server-binary>\n");
  process.exit(2);
}

const inScope = makeInScope(process.env.CIRCLECI_YAML_LSP_SCOPE_PATTERN, (msg) =>
  process.stderr.write(`[lsp-proxy] ${msg}\n`));

// Document-sync NOTIFICATIONS only (no ids). Dropping these for out-of-scope
// files keeps the server from ever seeing non-CircleCI YAML.
const SYNC_METHODS = new Set([
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/didSave",
  "textDocument/willSave",
]);

// Requests (have ids) that must be scoped to CircleCI configs. Out-of-scope
// requests get a null result reply so the client receives a well-formed response
// without the server ever seeing non-CircleCI YAML.
const SCOPED_REQUEST_METHODS = new Set([
  "textDocument/hover",
]);

const TOKEN = process.env.CIRCLECI_YAML_LSP_TOKEN || "";
const SELF_HOSTED = process.env.CIRCLECI_YAML_LSP_SELF_HOSTED_URL || "";
const SENTINEL = "__cci_proxy__"; // id prefix for commands we inject; replies are swallowed

// Optional traffic log for debugging: set CIRCLECI_YAML_LSP_DEBUG=/path/to/log.
const DEBUG = process.env.CIRCLECI_YAML_LSP_DEBUG || "";
function dbg(dir, msg) {
  if (!DEBUG || !msg) return;
  let line = `${dir} ${msg.method || "resp id=" + msg.id}`;
  const uri = msg.params?.textDocument?.uri || msg.params?.uri;
  if (uri) line += ` uri=${uri.split("/").pop()}`;
  if (msg.method === "textDocument/didOpen") line += ` textLen=${(msg.params?.textDocument?.text || "").length}`;
  if (msg.method === "textDocument/didChange") line += ` v=${msg.params?.textDocument?.version} changes=${JSON.stringify((msg.params?.contentChanges || []).map((c) => ({ range: c?.range, textLen: (c?.text || "").length })))}`;
  try { appendFileSync(DEBUG, line + "\n"); } catch { /* ignore */ }
}

const server = spawn(serverBin, ["-stdio"], { stdio: ["pipe", "pipe", "pipe"] });
server.on("error", (e) => {
  process.stderr.write(`[lsp-proxy] failed to start language server: ${e.message}\n`);
  process.exit(1);
});
server.stderr.on("data", (d) => process.stderr.write(d));
server.on("exit", (code, signal) => exitAfterFlush(code == null ? (signal ? 1 : 0) : code));

function sendToServer(obj) {
  server.stdin.write(frame(Buffer.from(JSON.stringify(obj), "utf8")));
}

// Exit only after any buffered stdout (e.g. a final publishDiagnostics) has flushed.
function exitAfterFlush(code) {
  const done = () => process.exit(code);
  if (process.stdout.writableLength === 0) done();
  else process.stdout.once("drain", done);
  setTimeout(done, 1000).unref(); // safety net if drain never fires
}

// Mirror of each in-scope document's full text, so we can replay edits as opens.
const docText = new Map();

// Client (Claude Code) -> server.
const fromClient = makeReader((msg, body) => {
  dbg(">>", msg);
  if (msg && SYNC_METHODS.has(msg.method) && !inScope(msg?.params?.textDocument?.uri)) {
    return; // keep non-CircleCI files away from the server
  }

  // The server duplicates a document's content when it receives didChange (verified
  // against 0.35.0). Track the full text ourselves and replay every change as a
  // didOpen, which the server applies cleanly AND immediately — didChange is debounced
  // ~1s server-side, so the didOpen is what makes diagnostics attach to the edit. The
  // docText mirror also reconstructs full text from incremental changes, so this stays
  // correct even for a client that ignores the forced full sync. didOpen/didClose pass through.
  if (msg && msg.method === "textDocument/didOpen") {
    const td = msg.params?.textDocument;
    if (td?.uri) docText.set(td.uri, td.text || "");
    server.stdin.write(frame(body));
    return;
  }
  if (msg && msg.method === "textDocument/didChange") {
    const uri = msg.params.textDocument?.uri;
    const text = applyEdits(docText.get(uri) ?? "", msg.params.contentChanges);
    docText.set(uri, text);
    sendToServer({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "yaml", version: msg.params.textDocument?.version ?? 0, text } } });
    return;
  }
  if (msg && msg.method === "textDocument/didClose") {
    docText.delete(msg.params.textDocument?.uri);
    server.stdin.write(frame(body));
    return;
  }

  // Scoped requests: handle out-of-scope textDocument requests locally (null result)
  // and serve hover for in-scope files from the proxy's own schema-based provider,
  // since the upstream server advertises hoverProvider but returns null (stub, 0.35.x).
  if (msg && msg.id != null && SCOPED_REQUEST_METHODS.has(msg.method)) {
    const uri = msg?.params?.textDocument?.uri;
    if (!inScope(uri)) {
      process.stdout.write(frame(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }), "utf8")));
      return;
    }
    if (msg.method === "textDocument/hover") {
      const pos = msg.params?.position;
      let text = docText.get(uri);
      if (text == null && uri && uri.startsWith("file://")) {
        // Proxy just started (e.g. after plugin reload) and hasn't received didOpen yet.
        // Fall back to reading the file from disk so hover works immediately.
        try { text = readFileSync(fileURLToPath(uri), "utf8"); } catch { /* file unreadable */ }
      }
      const result = (pos != null && text) ? doHover(text, pos.line, pos.character) : null;
      process.stdout.write(frame(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result ?? null }), "utf8")));
      return;
    }
  }

  server.stdin.write(frame(body));
  // After initialization, optionally authenticate for private orbs / self-hosted.
  if (msg && msg.method === "initialized") {
    if (SELF_HOSTED) sendToServer({ jsonrpc: "2.0", id: SENTINEL + "url", method: "workspace/executeCommand", params: { command: "setSelfHostedUrl", arguments: [SELF_HOSTED] } });
    if (TOKEN) sendToServer({ jsonrpc: "2.0", id: SENTINEL + "token", method: "workspace/executeCommand", params: { command: "setToken", arguments: [TOKEN] } });
  }
});

// Server -> client: swallow replies to our injected commands; force full sync in
// the initialize response; defensively drop diagnostics for out-of-scope files.
const fromServer = makeReader((msg, body) => {
  dbg("<<", msg);
  if (msg && typeof msg.id === "string" && msg.id.startsWith(SENTINEL)) return;
  // Force FULL document sync. The server advertises incremental sync, but a
  // full-text change with a zero-width range makes it duplicate the document;
  // full sync makes the client send the whole document, replaced wholesale.
  if (msg && msg.result && msg.result.capabilities) {
    const sync = msg.result.capabilities.textDocumentSync;
    msg.result.capabilities.textDocumentSync =
      sync && typeof sync === "object" ? { ...sync, openClose: true, change: 1 } : { openClose: true, change: 1 };
    // The server already advertises hoverProvider but its implementation returns null
    // for all positions (stub as of 0.35.x). Preserve it so hover wires up automatically
    // once the upstream server starts returning real results.
    if (!msg.result.capabilities.hoverProvider) msg.result.capabilities.hoverProvider = true;
    process.stdout.write(frame(Buffer.from(JSON.stringify(msg), "utf8")));
    return;
  }
  if (msg && msg.method === "textDocument/publishDiagnostics" && !inScope(msg?.params?.uri)) return;
  process.stdout.write(frame(body));
});

process.stdin.on("data", fromClient);
server.stdout.on("data", fromServer);

process.stdin.on("end", () => {
  try { server.stdin.end(); } catch { /* ignore */ }
  // If the server doesn't terminate on stdin EOF, don't orphan it (or hang).
  setTimeout(() => { try { server.kill(); } catch { /* ignore */ } exitAfterFlush(0); }, 2000).unref();
});
process.stdin.on("error", () => {});
process.stdout.on("error", () => {}); // clean EPIPE when the client goes away
server.stdin.on("error", () => {});

// Don't leave an orphaned server behind.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { try { server.kill(sig); } catch { /* ignore */ } exitAfterFlush(0); });
}
process.on("exit", () => { try { server.kill(); } catch { /* ignore */ } });
