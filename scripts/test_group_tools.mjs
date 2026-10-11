#!/usr/bin/env node
// NEWSROOM_GROUP_TOOLS=1 (K213): every tool goes through one wrapper at the registration point, and a tool that starts a child process declares what it
// writes. Checks: the switch (exact value, needs ENFORCE), every tool registered as group.action, off-state tool list unchanged, mutants (wrapper removed,
// a table row deleted or without registered_as, a tool outside its group declaring evidence, a child process writing one more file) all fail closed,
// the fixed E1 lists. Loads type-stripped copies of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("group-tools-");
const results = [];
const check = (name) => results.push(name);
const clearEnv = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name]; };
clearEnv();
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_HIDE_LIEFLAT", "STUB_EXTRA"]) delete process.env[name];
const ON = { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1" };

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
let treeSeq = 0;
/** A type-stripped copy of the runtime; `mutate(tree)` may edit the copied files first (the mutants). */
async function loadTree(mutate) {
  const tree = join(scratch, `tree-${++treeSeq}`);
  cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
  stub(tree, "typebox", TYPEBOX);
  stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  if (mutate) mutate(tree);
  const copy = join(tree, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return { tree, mod: await import(pathToFileURL(copy).href), groups: await import(pathToFileURL(join(tree, "runtime/pi/groups.mjs")).href) };
}
const edit = (tree, rel, fn) => { const path = join(tree, rel); writeFileSync(path, fn(readFileSync(path, "utf8"))); };
const register = (loaded, env, profile = "full") => {
  clearEnv();
  process.env.NEWSROOM_TOOL_PROFILE = profile;
  process.env.NEWSROOM_PHASE = "all";
  Object.assign(process.env, env);
  const tools = [];
  loaded.mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.push(tool) : () => {}) }));
  return tools;
};
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const throwsWith = (fn, code, msg) => assert.throws(fn, (e) => String(e.message).includes(code), msg);
const rejectsWith = async (promise, code, msg) => { try { await promise; } catch (e) { assert.ok(String(e.message).includes(code) || e.code === code, `${msg}: ${e.message}`); return e; } assert.fail(`${msg}: nothing was thrown`); };

const base = await loadTree();

// 1. switch: exact value, needs ENFORCE
{
  throwsWith(() => register(base, { NEWSROOM_GROUP_TOOLS: "1" }), "GROUP_TOOLS_NEEDS_ENFORCE", "TOOLS=1 without ENFORCE stops the start-up");
  throwsWith(() => register(base, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1" }), "GROUP_ENFORCE_NEEDS_HANDOFF", "ENFORCE without HANDOFF still stops first");
  for (const value of ["true", "yes", "on", "0", "", " 1"]) {
    const off = register(base, { NEWSROOM_GROUP_TOOLS: value });
    assert.ok(off.length > 50 && off.every((t) => !base.groups.isGroupChecked(t)), `value ${JSON.stringify(value)} leaves the switch off`);
  }
  check("switch: only the exact value 1 turns it on; it needs ENFORCE (and ENFORCE needs HANDOFF); other values change nothing");
}

// 2. every tool registered as group.action; off-state tool list unchanged
{
  const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8")).tools;
  const seen = new Set();
  for (const profile of ["investigate", "visual", "publication", "visual-story", "competition", "full"]) {
    const off = register(base, {}, profile);
    const on = register(base, ON, profile);
    assert.deepEqual(on.map((t) => [t.name, t.description, JSON.stringify(t.parameters), t.label, JSON.stringify(t.promptGuidelines ?? null)]), off.map((t) => [t.name, t.description, JSON.stringify(t.parameters), t.label, JSON.stringify(t.promptGuidelines ?? null)]), `${profile}: with the switch on the tool list, descriptions and schemas are unchanged`);
    for (const tool of on) { assert.ok(base.groups.isGroupChecked(tool), `${tool.name} went through the wrapper`); assert.ok(table[tool.name]?.registered_as, `${tool.name} has a group.action name`); seen.add(tool.name); }
  }
  assert.ok(seen.size >= 50, `tools seen: ${seen.size}`);
  // the 6 tools that no profile registers under the default conditions (5 conditional, 1 hidden) still pass the same registration check
  for (const name of Object.keys(table)) base.groups.assertToolRegistered(name);
  assert.equal(Object.keys(table).length, 58);
  check(`registration: ${seen.size} tools in six profiles all pass the wrapper (the other 6 of the 58 pass the same registration check), list, descriptions, schemas equal the off state`);
}

// 3. mutants at the registration point
{
  const noWrapper = await loadTree((tree) => edit(tree, "runtime/pi/newsroom.ts", (s) => { const a = "groupTools ? withGroupTools(tool) :"; assert.ok(s.includes(a)); return s.replace(a, "false ? tool :"); }));
  throwsWith(() => register(noWrapper, ON), "GROUP_TOOLS_UNWRAPPED", "mutant: the wrapper removed from the registration point -> start-up stops");
  const noRow = await loadTree((tree) => edit(tree, "runtime/pi/groups.json", (s) => { const j = JSON.parse(s); delete j.tools.newsroom_viz_lint; return JSON.stringify(j); }));
  throwsWith(() => register(noRow, ON), "GROUP_TOOLS_UNREGISTERED", "mutant: a tool row deleted from the table -> never registered");
  const noName = await loadTree((tree) => edit(tree, "runtime/pi/groups.json", (s) => { const j = JSON.parse(s); delete j.tools.newsroom_viz_lint.registered_as; return JSON.stringify(j); }));
  throwsWith(() => register(noName, ON), "GROUP_TOOLS_UNREGISTERED", "mutant: a row without registered_as -> never registered");
  const wrongName = await loadTree((tree) => edit(tree, "runtime/pi/groups.json", (s) => { const j = JSON.parse(s); j.tools.newsroom_viz_lint.registered_as = "agent.viz_lint"; return JSON.stringify(j); }));
  throwsWith(() => register(wrongName, ON), "GROUP_TOOLS_UNREGISTERED", "mutant: registered_as that disagrees with the tool's group -> never registered");
  // off: the same broken tables change nothing
  assert.ok(register(noRow, {}).length > 50, "off: a missing row stops nothing");
  check("mutants: wrapper removed / row deleted / row without registered_as / registered_as disagreeing with the group -> start-up stops; off state unaffected");
}

// 4. declared outputs of a child process (groups.mjs runDeclared)
const { groups: g } = base;
const dirFor = (() => { let n = 0; return () => { const d = join(scratch, `art-${++n}`); mkdirSync(join(d, "visualizations/graph-reduction"), { recursive: true }); return d; }; })();
{
  process.env.NEWSROOM_GROUP_ENFORCE = "1"; process.env.NEWSROOM_GROUP_TOOLS = "1";
  const dir = dirFor();
  const out = "visualizations/graph-reduction/a.json";
  // declared and the owner's own: passes, nothing deleted
  let ran = 0;
  await g.runInTool("newsroom_network_reduce", () => g.runDeclared(dir, [out], async () => { ran += 1; writeFileSync(join(dir, out), "{}"); }));
  assert.equal(ran, 1); assert.ok(existsSync(join(dir, out)));
  // one more file next to it: deleted again and refused
  const refusal = await g.runInTool("newsroom_network_reduce", () => g.runDeclared(dir, [out], async () => { writeFileSync(join(dir, out), "{}"); writeFileSync(join(dir, "visualizations/graph-reduction/extra.json"), "x"); }).catch((e) => e));
  assert.equal(refusal.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(refusal.detail.extra, ["visualizations/graph-reduction/extra.json"]);
  assert.ok(!existsSync(join(dir, "visualizations/graph-reduction/extra.json")), "the undeclared file is rolled back");
  assert.ok(existsSync(join(dir, out)), "the declared file stays");
  assert.match(readFileSync(join(dir, "runtime/boundary-refusals.jsonl"), "utf8"), /undeclared_output/);
  // a process that failed AND wrote an extra file: still refused (the extra file is the finding), not swallowed
  const both = await g.runInTool("newsroom_network_reduce", () => g.runDeclared(dir, [out], async () => { writeFileSync(join(dir, "visualizations/graph-reduction/extra2.json"), "x"); throw new Error("boom"); }).catch((e) => e));
  assert.equal(both.code, "GROUP_TOOLS_REFUSED");
  // a process that fails cleanly keeps its own error
  const plain = await g.runInTool("newsroom_network_reduce", () => g.runDeclared(dir, [out], async () => { throw new Error("boom"); }).catch((e) => e));
  assert.equal(plain.message, "boom");
  // the run folder itself is watched when nothing is declared (duckdb, adapter)
  const stray = await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir, [], async () => { writeFileSync(join(dir, "stray.csv"), "x"); }).catch((e) => e));
  assert.equal(stray.code, "GROUP_TOOLS_REFUSED"); assert.ok(!existsSync(join(dir, "stray.csv")));
  check("child process: a declared own-group output passes; one more file is deleted again and refused and logged; a failing process keeps its own error; with nothing declared the run folder is watched");

  // a visual tool declaring an evidence path: refused BEFORE the process starts
  let started = 0;
  const cross = await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir, ["computations/x.json"], async () => { started += 1; }).catch((e) => e));
  assert.equal(cross.name, "BoundaryRefusal"); assert.equal(started, 0, "the process never started");
  const unknownPath = await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir, ["nowhere/odd.bin"], async () => { started += 1; }).catch((e) => e));
  assert.equal(unknownPath.name, "BoundaryRefusal"); assert.equal(started, 0);
  const noTool = await g.runDeclared(dir, [out], async () => { started += 1; }).catch((e) => e);
  assert.equal(noTool.name, "BoundaryRefusal"); assert.equal(started, 0, "no initiating tool -> 待查 -> refused");
  const noRoot = await g.runInTool("newsroom_network_reduce", () => g.runDeclared(null, [out], async () => { started += 1; }).catch((e) => e));
  assert.equal(noRoot.name, "BoundaryRefusal"); assert.equal(started, 0);
  check("child process: a declared path outside the tool's group, an unclassified path, no tool and no root are refused before the process starts");

  // overlapping tool call: the new file is reported and refused but not deleted
  const dir2 = dirFor();
  const other = g.withGroupTools({ name: "newsroom_viz_lint", execute: async () => { await new Promise((r) => setTimeout(r, 60)); } });
  const caller = g.withGroupTools({ name: "newsroom_network_reduce", execute: () => g.runDeclared(dir2, [], async () => { const parallel = other.execute(); writeFileSync(join(dir2, "theirs.json"), "x"); await parallel; }) });
  const o = await caller.execute().catch((e) => e);
  assert.equal(o.code, "GROUP_TOOLS_REFUSED"); assert.equal(o.detail.overlapped, true); assert.deepEqual(o.detail.rolled_back, []);
  assert.ok(existsSync(join(dir2, "theirs.json")), "with an overlapping call nothing is deleted");
  // the same run without an overlapping call IS rolled back
  const alone = g.withGroupTools({ name: "newsroom_network_reduce", execute: () => g.runDeclared(dir2, [], async () => { writeFileSync(join(dir2, "mine.json"), "x"); }) });
  const a1 = await alone.execute().catch((e) => e);
  assert.equal(a1.detail.overlapped, false); assert.ok(!existsSync(join(dir2, "mine.json")));
  check("child process: with another tool call running at the same time the new file is refused but not deleted");

  // E1 is fixed
  assert.deepEqual([...g.E1_TEMP_SUFFIXES], [".tmp", ".write-tmp"]); assert.deepEqual([...g.E1_TEMP_FOLDERS], ["runtime/preview-tmp/"]);
  const dir3 = dirFor();
  await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir3, [], async () => { writeFileSync(join(dir3, "x.json.tmp"), "x"); mkdirSync(join(dir3, "runtime/preview-tmp"), { recursive: true }); }));
  const e1other = await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir3, ["runtime/preview-tmp/a.png"], async () => { writeFileSync(join(dir3, "runtime/preview-tmp/a.png"), "x"); writeFileSync(join(dir3, "runtime/preview-tmp/b.png"), "x"); }).catch((e) => e));
  assert.equal(e1other, undefined, "E1: the preview temp folder is bookkeeping, not judged"); 
  check("E1 lists are pinned (.tmp, .write-tmp, runtime/preview-tmp/); temp names are skipped, nothing else");
}

// 5. off: runDeclared is the bare call
{
  clearEnv();
  const dir = dirFor();
  const r = await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir, ["computations/x.json"], async () => { writeFileSync(join(dir, "stray.csv"), "x"); return 7; }));
  assert.equal(r, 7); assert.ok(existsSync(join(dir, "stray.csv")), "off: nothing is checked or removed");
  assert.ok(!existsSync(join(dir, "runtime/boundary-refusals.jsonl")));
  check("off: runDeclared runs the call as it is, writes no log, deletes nothing");
}

// 6. through a real tool: the stub child process writes one file too many
{
  const stubBin = join(scratch, "stub-python.sh");
  writeFileSync(stubBin, `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nprintf '{"summary":{"retained_cross_community_weight_fraction":1,"community_count":1,"displayed_meta_edges":0}}' > "$out"\n[ -n "$STUB_EXTRA" ] && printf x > "$(dirname "$out")/$STUB_EXTRA"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
  const params = { nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] };
  for (const [label, env] of [["on", ON], ["off", {}]]) {
    const dir = dirFor();
    const tools = register(base, { ...env, NEWSROOM_ARTIFACT_DIR: dir, NEWSROOM_PYTHON_BIN: stubBin });
    const reduce = tools.find((t) => t.name === "newsroom_network_reduce");
    process.env.STUB_EXTRA = "";
    const ok = await reduce.execute("1", params, undefined);
    assert.match(JSON.stringify(ok), /Network overview reduction complete/, `${label}: the tool works through the stub`);
    const files = walk(dir).map((f) => f.slice(dir.length)).sort();
    process.env.STUB_EXTRA = "extra.bin";
    const second = await reduce.execute("2", { ...params, seed: 7 }, undefined).catch((e) => e);
    if (label === "on") {
      assert.equal(second.code, "GROUP_TOOLS_REFUSED", "on: a child process that wrote one more file is refused");
      assert.ok(!existsSync(join(dir, "visualizations/graph-reduction/extra.bin")), "on: and the file is gone");
      assert.equal(files.length > 0, true);
    } else {
      assert.match(JSON.stringify(second), /Network overview reduction complete/, "off: the same run is accepted as before");
      assert.ok(existsSync(join(dir, "visualizations/graph-reduction/extra.bin")), "off: the extra file stays (nothing checks it)");
    }
  }
  delete process.env.STUB_EXTRA;
  check("real tool (newsroom_network_reduce with a stub child process): on -> an extra file is refused and removed; off -> accepted as before");
}

for (const name of results) console.log(`  ok  ${name}`);
console.log(`group tools: PASS (${results.length} checks)`);
