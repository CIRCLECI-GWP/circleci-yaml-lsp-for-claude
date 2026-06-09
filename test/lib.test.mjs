// Unit tests for the pure helpers in lsp-proxy-lib.mjs and lsp-hover.mjs.
// Grouped under describe() so Node's JUnit reporter emits a <testsuite> (which
// CircleCI's test-results parser requires).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeInScope, posToOffset, applyEdits, frame, makeReader, DEFAULT_SCOPE } from "../plugins/circleci-yaml-lsp/bin/lsp-proxy-lib.mjs";
import { doHover } from "../plugins/circleci-yaml-lsp/bin/lsp-hover.mjs";

describe("lsp-proxy-lib (unit)", () => {
  test("makeInScope: default matches CircleCI config files under .circleci/", () => {
    const inScope = makeInScope();
    for (const uri of [
      "file:///r/.circleci/config.yml",
      "file:///r/.circleci/config.yaml",
      "file:///r/.circleci/continue_config.yml",
      "file:///r/.circleci/setup_config.yml",
      "file:///deep/path/.circleci/config.yml",
    ]) assert.equal(inScope(uri), true, uri);
  });

  test("makeInScope: default excludes non-config and non-.circleci YAML", () => {
    const inScope = makeInScope();
    for (const uri of [
      "file:///r/.circleci/test-suites.yml",     // real CircleCI artifact, not a config
      "file:///r/.circleci/scripts/deploy.yml",  // nested helper
      "file:///r/.circleci/eslint.config.yml",   // has 'config' but isn't a CircleCI config
      "file:///r/.circleci/db-config.yml",
      "file:///r/.circleci/config-backup.yml",
      "file:///r/docker-compose.yml",
      "file:///r/config.yml",                    // not under .circleci/
      "file:///r/myproject.circleci/config.yml", // no slash before .circleci
    ]) assert.equal(inScope(uri), false, uri);
    assert.equal(inScope(undefined), false);
    assert.equal(inScope(123), false);
  });

  test("makeInScope: env override regex, with fallback on invalid pattern", () => {
    const any = makeInScope("\\.ya?ml$");
    assert.equal(any("file:///x/anything.yaml"), true);
    assert.equal(any("file:///x/anything.json"), false);

    let errored = false;
    const fallback = makeInScope("(", () => { errored = true; }); // invalid regex
    assert.equal(errored, true);
    assert.equal(fallback("file:///r/.circleci/config.yml"), true); // fell back to default
  });

  test("posToOffset: maps line/character to string offset", () => {
    const t = "ab\ncd\nef";
    assert.equal(posToOffset(t, { line: 0, character: 0 }), 0);
    assert.equal(posToOffset(t, { line: 0, character: 1 }), 1);
    assert.equal(posToOffset(t, { line: 1, character: 0 }), 3);
    assert.equal(posToOffset(t, { line: 2, character: 1 }), 7);
    assert.equal(posToOffset(t, { line: 9, character: 0 }), t.length); // line past end clamps
    assert.equal(posToOffset(t, { line: 0, character: 99 }), t.length); // char past end clamps
  });

  test("applyEdits: full replace when range is absent", () => {
    assert.equal(applyEdits("old text", [{ text: "brand new" }]), "brand new");
    assert.equal(applyEdits("x", []), "x");
    assert.equal(applyEdits("x", undefined), "x");
  });

  test("applyEdits: incremental replace / insert / delete", () => {
    assert.equal(applyEdits("hello", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, text: "bye" }]), "bye");
    assert.equal(applyEdits("ac", [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "b" }]), "abc"); // insert
    assert.equal(applyEdits("abc", [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, text: "" }]), "ac"); // delete
  });

  test("applyEdits: tolerates a null change entry", () => {
    assert.equal(applyEdits("keep", [null, { text: "new" }]), "new");
  });

  test("applyEdits: multiple/incremental change reproduces a mid-line edit", () => {
    const base = "a\nb\n      - BETA\n";
    const out = applyEdits(base, [{ range: { start: { line: 2, character: 8 }, end: { line: 2, character: 12 } }, text: "DELTA" }]);
    assert.equal(out, "a\nb\n      - DELTA\n");
  });

  test("frame: Content-Length is the BYTE length (multibyte safe)", () => {
    assert.equal(frame(Buffer.from("hi", "utf8")).toString("utf8"), "Content-Length: 2\r\n\r\nhi");
    assert.equal(frame(Buffer.from("é", "utf8")).toString("utf8"), "Content-Length: 2\r\n\r\né"); // 'é' is 2 bytes
  });

  const readAll = (chunks) => {
    const out = [];
    const read = makeReader((msg, body) => out.push({ msg, body }));
    for (const c of chunks) read(Buffer.from(c));
    return out;
  };
  const framed = (obj) => { const b = Buffer.from(JSON.stringify(obj), "utf8"); return `Content-Length: ${b.length}\r\n\r\n` + JSON.stringify(obj); };

  test("makeReader: single and multiple messages in one chunk", () => {
    assert.deepEqual(readAll([framed({ a: 1 })]).map((x) => x.msg), [{ a: 1 }]);
    assert.deepEqual(readAll([framed({ a: 1 }) + framed({ b: 2 })]).map((x) => x.msg), [{ a: 1 }, { b: 2 }]);
  });

  test("makeReader: message split across chunks", () => {
    const f = framed({ hello: "world" });
    const cut = Math.floor(f.length / 2);
    assert.deepEqual(readAll([f.slice(0, cut), f.slice(cut)]).map((x) => x.msg), [{ hello: "world" }]);
  });

  test("makeReader: multibyte body length is honored", () => {
    const out = readAll([framed({ text: "héllo — 日本" })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].msg.text, "héllo — 日本");
  });

  test("makeReader: resync past a malformed header, then deliver the next message", () => {
    assert.deepEqual(readAll(["GARBAGE\r\n\r\n" + framed({ ok: true })]).map((x) => x.msg), [{ ok: true }]);
  });

  test("makeReader: unparseable body yields msg=null with raw bytes", () => {
    const out = readAll(["Content-Length: 3\r\n\r\n{ {"]);
    assert.equal(out.length, 1);
    assert.equal(out[0].msg, null);
    assert.equal(out[0].body.toString("utf8"), "{ {");
  });

  test("makeReader: a throwing handler does not tear down the stream", () => {
    let seen = 0;
    const read = makeReader((msg) => { seen++; if (msg && msg.boom) throw new Error("boom"); });
    read(Buffer.from(framed({ boom: true }) + framed({ ok: 1 })));
    assert.equal(seen, 2); // both messages delivered despite the first handler throwing
  });

  test("DEFAULT_SCOPE is exported and case-insensitive", () => {
    assert.ok(DEFAULT_SCOPE instanceof RegExp);
    assert.equal(DEFAULT_SCOPE.test("file:///R/.CIRCLECI/CONFIG.YML"), true);
  });
});

describe("lsp-hover (unit)", () => {
  const CONFIG = [
    "version: 2.1",
    "jobs:",
    "  build:",
    "    docker:",
    "      - image: cimg/node:lts",
    "    working_directory: ~/project",
    "    steps:",
    "      - checkout",
    "      - run:",
    "          name: Test",
    "          command: npm test",
    "      - store_artifacts:",
    "          path: dist",
  ].join("\n");

  test("returns markdown description for a known root key", () => {
    // 'version' starts at line 0, character 0
    const result = doHover(CONFIG, 0, 0);
    assert.ok(result !== null, "should return a result");
    assert.equal(result.contents.kind, "markdown");
    assert.ok(result.contents.value.length > 10, "description should be non-trivial");
  });

  test("returns description for a known nested key", () => {
    // 'working_directory' is on line 5, character 4
    const result = doHover(CONFIG, 5, 4);
    assert.ok(result !== null);
    assert.ok(result.contents.value.includes("working_directory") || result.contents.value.includes("~/project"));
  });

  test("returns description for a known step key", () => {
    // 'store_artifacts' is on line 11, character 8
    const result = doHover(CONFIG, 11, 8);
    assert.ok(result !== null);
    assert.ok(result.contents.value.includes("artifact"));
  });

  test("resolves a key whose schema description lives on a oneOf branch (executor)", () => {
    // Regression guard: 'executor' carries its markdownDescription on a oneOf branch,
    // not directly on the property — shallow schema extraction misses it.
    const text = "jobs:\n  build:\n    executor: my-exec\n";
    const result = doHover(text, 2, 4); // 'executor' key
    assert.ok(result !== null, "executor should resolve");
    assert.ok(result.contents.value.toLowerCase().includes("executor"));
  });

  test("returns null for a user-defined name (not a schema key)", () => {
    // 'build' (job name) is on line 2, character 2
    const result = doHover(CONFIG, 2, 2);
    assert.equal(result, null);
  });

  test("returns null for whitespace / empty position", () => {
    assert.equal(doHover(CONFIG, 3, 0), null); // leading spaces before 'docker'
  });

  test("returns null for an out-of-bounds line", () => {
    assert.equal(doHover(CONFIG, 999, 0), null);
  });

  test("returns null for empty text", () => {
    assert.equal(doHover("", 0, 0), null);
  });
});
