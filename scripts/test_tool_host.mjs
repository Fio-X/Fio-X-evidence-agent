#!/usr/bin/env node
// 1011ab step 1: the tool host (runtime/pi/tool_host.mjs) answers the hello with the registered tools. Checks: every tool's name, group and
// schema line up with groups.json and with the existing registration (names, properties, required, descriptions); tools outside allowedTools
// are not exposed; no schema uses a keyword the host cannot check; the per-call handshake (validated/go/result, unknown tool, bad arguments,
// cancel before go); the host reports its environment variable NAMES only (the Rust client refuses key-like ones). No model, no network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";
import { convert, unsupportedKeywords, validate, validationFailure } from "../runtime/pi/tool_host_schema.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8")).tools;
const ALL = Object.keys(table);
const scratch = makeTestTmp("tool-host-");
const results = [];
const check = (text) => results.push(text);
const SWITCHES = { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_PLAN_PATCH: "1", NEWSROOM_SPEED_CHAIN_PATCH: "1", NEWSROOM_SPEED_PLAN_EDIT: "1", NEWSROOM_PAGE_OCR_CHECK: "1" };

/** One host process: send(message), next(predicate) resolves the next matching message. */
function startHost(env, hello) {
  const run = join(scratch, `run-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(run, { recursive: true });
  const child = spawn(process.execPath, [join(ROOT, "runtime/pi/tool_host.mjs")], { env: { PATH: process.env.PATH, HOME: scratch, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const inbox = [];
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      const message = JSON.parse(line);
      const waiter = waiters.findIndex((w) => w.test(message));
      if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message); else inbox.push(message);
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const next = (test) => new Promise((resolve, reject) => {
    const hit = inbox.findIndex(test);
    if (hit >= 0) return resolve(inbox.splice(hit, 1)[0]);
    const timer = setTimeout(() => reject(new Error("timed out waiting for a host message")), 20000);
    waiters.push({ test, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  send({ type: "hello", protocol: 1, cwd: ROOT, runDir: run, ...hello });
  const stop = () => new Promise((resolve) => { child.once("exit", resolve); send({ type: "shutdown" }); });
  return { child, send, next, stop, run };
}
const ready = async (env, hello) => { const host = startHost(env, hello); const message = await host.next((m) => m.type === "ready" || m.type === "error"); assert.equal(message.type, "ready", JSON.stringify(message)); return { host, message }; };

// 1. tool list: names, groups, schemas across the six profiles (union) and with every switch on
// newsroom_illustration_generate is registered only when an illustration adapter is configured (NEWSROOM_REFUSED_OPTIONS_FIX on unless exactly "0"),
// so the union is 57 tools by default and 58 with an adapter or with "0" (the host gets no environment from this process, so each arm is exact).
const ILLUSTRATION = "newsroom_illustration_generate";
async function collect(extra) {
  const found = new Map();
  for (const profile of ["investigate", "visual", "publication", "visual-story", "competition", "full"]) {
    const { host, message } = await ready({ NEWSROOM_TOOL_PROFILE: profile, NEWSROOM_PHASE: "all", ...extra }, { allowedTools: ALL });
    for (const tool of message.tools) found.set(tool.name, tool);
    await host.stop();
  }
  const withSwitches = await ready({ NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: "all", ...SWITCHES, ...extra }, { allowedTools: ALL });
  for (const tool of withSwitches.message.tools) found.set(tool.name, tool);
  await withSwitches.host.stop();
  return found;
}
const bareSeen = await collect({});
assert.equal(bareSeen.size, 57, `host tools seen without an adapter: ${bareSeen.size}`);
assert.deepEqual(ALL.filter((n) => !bareSeen.has(n)), [ILLUSTRATION, "newsroom_chart"], "default, no adapter: only the illustration tool and the retired newsroom_chart are missing");
const seen = await collect({ NEWSROOM_ILLUSTRATION_ADAPTER: "test-adapter" });
assert.equal(seen.size, 58, `host tools seen with an adapter: ${seen.size}`);
assert.deepEqual(ALL.filter((n) => !seen.has(n)), ["newsroom_chart"], "the one tool no profile or switch registers is the retired newsroom_chart");
const zeroSeen = await collect({ NEWSROOM_REFUSED_OPTIONS_FIX: "0" });
assert.equal(zeroSeen.size, 58, `host tools seen with NEWSROOM_REFUSED_OPTIONS_FIX=0: ${zeroSeen.size}`);
assert.deepEqual(ALL.filter((n) => !zeroSeen.has(n)), ["newsroom_chart"], '"0", no adapter: registered as before');
assert.equal(seen.get(ILLUSTRATION).group, table[ILLUSTRATION].group, "the illustration tool is in its group when registered");
for (const [name, tool] of seen) {
  assert.ok(table[name], `${name} is in groups.json`);
  assert.equal(tool.group, table[name].group, `${name}: group`);
  assert.ok(tool.description && tool.parameters?.type === "object", `${name}: description and object schema`);
  assert.deepEqual(unsupportedKeywords(tool.parameters, name), [], `${name}: schema keywords the host cannot check`);
}
check("57 of the 58 groups.json tools reported by default, 58 minus the retired newsroom_chart with an adapter or REFUSED_OPTIONS_FIX=0; same group; no unchecked schema keyword");

// 2. the same tools, properties, required and descriptions as the existing registration (stub Type, as the other registration tests do)
{
  const tree = join(scratch, "stub-tree");
  cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
  const stub = (name, source) => { mkdirSync(join(tree, "node_modules", name), { recursive: true }); writeFileSync(join(tree, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" })); writeFileSync(join(tree, "node_modules", name, "index.js"), source); };
  stub("typebox", `const OPT = "__optional"; const mk = (b) => (o = {}) => ({ ...b, ...(o && typeof o === "object" && !Array.isArray(o) ? o : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }), Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, o = {}) => ({ type: "array", items, ...o }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }), Object: (p = {}, o = {}) => ({ type: "object", properties: p, required: Object.keys(p).filter((k) => !p[k][OPT]), ...o }) };`);
  stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const copy = join(tree, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  const mod = await import(pathToFileURL(copy).href);
  const saved = { ...process.env };
  const registerAll = (adapter) => {
    const found = new Map();
    for (const [profile, extra] of [["investigate", {}], ["visual", {}], ["publication", {}], ["visual-story", {}], ["competition", {}], ["full", {}], ["full", SWITCHES]]) {
      for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_")) delete process.env[key];
      Object.assign(process.env, { NEWSROOM_TOOL_PROFILE: profile, NEWSROOM_PHASE: "all", ...(adapter ? { NEWSROOM_ILLUSTRATION_ADAPTER: "test-adapter" } : {}), ...extra });
      mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (t) => found.set(t.name, t) : () => {}) }));
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    return found;
  };
  assert.deepEqual([...registerAll(false).keys()].sort(), [...bareSeen.keys()].sort(), "same tool names as the existing registration, no adapter");
  const existing = registerAll(true);
  assert.deepEqual([...existing.keys()].sort(), [...seen.keys()].sort(), "same tool names as the existing registration");
  const shape = (schema) => ({ props: Object.keys(schema.properties ?? {}).sort(), required: [...(schema.required ?? [])].sort() });
  for (const [name, tool] of seen) {
    const old = existing.get(name);
    assert.equal(tool.description, old.description, `${name}: description`);
    assert.deepEqual(shape(tool.parameters), shape(old.parameters), `${name}: top-level properties and required`);
    assert.equal(tool.promptSnippet, old.promptSnippet, `${name}: promptSnippet`);
    assert.deepEqual(tool.promptGuidelines ?? null, old.promptGuidelines?.length ? old.promptGuidelines : null, `${name}: promptGuidelines`);
  }
  check("tool names, descriptions, top-level properties, required lists, prompt snippets and guidelines equal the existing registration");
}

// 3. allowedTools: a tool outside the list is not exposed
{
  const { host, message } = await ready({ NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: "all" }, { allowedTools: ["artifact_inventory", "newsroom_update_plan"] });
  assert.deepEqual(message.tools.map((t) => t.name).sort(), ["artifact_inventory", "newsroom_update_plan"]);
  host.send({ type: "call", callId: "c1", name: "duckdb_query", args: { sql: "select 1" } });
  const refused = await host.next((m) => m.callId === "c1");
  assert.deepEqual([refused.type, refused.kind], ["error", "unknown_tool"]);
  await host.stop();
  check("allowedTools limits what is exposed; a call to a tool outside it is an unknown_tool error");
}

// 4. per-call handshake
{
  const { host } = await ready({ NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: "all" }, { allowedTools: ALL });
  host.send({ type: "call", callId: "ok", name: "artifact_inventory", args: {} });
  const validated = await host.next((m) => m.callId === "ok");
  assert.equal(validated.type, "validated");
  host.send({ type: "go", callId: "ok" });
  const result = await host.next((m) => m.callId === "ok");
  assert.equal(result.type, "result");
  assert.equal(result.isError, false);
  host.send({ type: "call", callId: "bad", name: "newsroom_update_plan", args: { goal: 5, steps: "nope" } });
  const bad = await host.next((m) => m.callId === "bad");
  assert.deepEqual([bad.type, bad.kind], ["error", "invalid_args"]);
  assert.match(bad.message, /^Tool "newsroom_update_plan" rejected its arguments:\n {2}- /);
  assert.match(bad.message, /\n\nArguments as sent:\n\{/);
  host.send({ type: "call", callId: "cx", name: "artifact_inventory", args: {} });
  assert.equal((await host.next((m) => m.callId === "cx")).type, "validated");
  host.send({ type: "cancel", callId: "cx" });
  const cancelled = await host.next((m) => m.callId === "cx");
  assert.deepEqual([cancelled.type, cancelled.kind], ["error", "cancelled"]);
  await host.stop();
  check("per call: validated then go then result; unknown tool and bad arguments are errors and the tool does not run; cancel before go ends the call");
}

// 5. the host reports environment variable names (never values), so a key-like name is caught by the Rust client
{
  const clean = await ready({ NEWSROOM_TOOL_PROFILE: "full" }, { allowedTools: ["artifact_inventory"] });
  assert.ok(!clean.message.envNames.some((n) => /_API_KEY|_BASE_URL/i.test(n)));
  assert.ok(clean.message.envNames.every((n) => typeof n === "string"));
  await clean.host.stop();
  const dirty = await ready({ NEWSROOM_TOOL_PROFILE: "full", PROBE_API_KEY: "x" }, { allowedTools: ["artifact_inventory"] });
  assert.ok(dirty.message.envNames.includes("PROBE_API_KEY"), "the host reports a key-like name honestly");
  assert.ok(!JSON.stringify(dirty.message).includes('"x"'), "values are not reported");
  await dirty.host.stop();
  check("the host reports environment names only: a clean start has no key-like name, a dirty start shows its name and not its value");
}

// 6. conversion and validation (agent-spec 10.1, 10.2)
{
  const schema = { type: "object", properties: { n: { type: "number" }, i: { type: "integer", minimum: 1 }, b: { type: "boolean" }, s: { type: "string" }, o: { type: "string" }, list: { type: "array", items: { type: "number" } }, e: { type: "string", enum: ["a", "b"] } }, required: ["n", "i", "b", "s"] };
  assert.deepEqual(convert(schema, { n: "3", i: "2", b: "true", s: 7, o: null, list: ["1", 2] }), { n: 3, i: 2, b: true, s: "7", list: [1, 2] });
  assert.deepEqual(convert(schema, { n: null, i: null, b: null, s: null }), { n: 0, i: 0, b: false, s: "" });
  assert.equal(convert(schema, { n: "1e3", i: 1, b: false, s: "x" }).n, 1000);
  assert.equal(validate(schema, { n: 1, i: 0, b: true, s: "x" }).length, 1);
  assert.equal(validate(schema, { n: 1, i: 1, b: true, s: "x", e: "z" }).length, 1);
  const failure = validationFailure("t", schema, { n: "x", i: 1, b: true });
  assert.equal(failure.ok, false);
  assert.equal(failure.text, 'Tool "t" rejected its arguments:\n  - s: Expected required property (string)\n  - n: Expected number\n\nArguments as sent:\n{\n  "n": "x",\n  "i": 1,\n  "b": true\n}');
  assert.deepEqual(unsupportedKeywords({ type: "object", properties: { a: { type: "string", format: "date" } } }), ["a: format"]);
  check("conversion (strings to numbers and booleans, nulls, optional null dropped) and the fixed error text");
}

for (const text of results) console.log(`PASS ${text}`);
console.log(`${results.length} checks -- PASS`);
