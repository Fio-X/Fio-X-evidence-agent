#!/usr/bin/env node
// NEWSROOM_GROUP_TOOLS (K213; on unless exactly "0" since #64 step 4): every tool goes through one wrapper at the registration point, and a tool that starts a child process declares what it
// writes. Checks: the switch (exactly "0" off, exactly "1" on, other values follow the refusal), every tool registered as group.action, off-state tool list unchanged, mutants (wrapper removed,
// a table row deleted or without registered_as, a tool outside its group declaring evidence, a child process writing one more file) all fail closed,
// the fixed E1 lists. Loads type-stripped copies of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("group-tools-");
const results = [];
const check = (name) => results.push(name);
const clearEnv = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name]; process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; /* the off-table call refusal is on by default; this test is about something else, so both are pinned off */ };
clearEnv();
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "STUB_EXTRA"]) delete process.env[name];
const ON = { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1" };

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

// 1. switch: exactly "0" off, exactly "1" on, other values follow the refusal
{
  // #64 step 3: the refusal is on by default, so TOOLS=1 needs ENFORCE only to be not "0"
  throwsWith(() => register(base, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "0" }), "GROUP_TOOLS_NEEDS_ENFORCE", 'TOOLS=1 with ENFORCE="0" stops the start-up');
  // the hand-off switch is removed: a leftover HANDOFF=0 neither stops TOOLS=1 nor changes the checked state
  for (const env of [{ NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_HANDOFF: "0" }, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "0" }]) {
    const left = register(base, env);
    assert.ok(left.length > 50 && left.every((t) => base.groups.isGroupChecked(t)), `a leftover HANDOFF=0 does not stop TOOLS=1: ${JSON.stringify(env)}`);
  }
  // #64 step 4 default change: only the exact "0" is off; every other value follows the refusal (on with nothing else set, off with ENFORCE "0")
  const zero = register(base, { NEWSROOM_GROUP_TOOLS: "0" });
  assert.ok(zero.length > 50 && zero.every((t) => !base.groups.isGroupChecked(t)), 'value "0" leaves the switch off');
  for (const value of ["true", "yes", "on", "", " 1"]) {
    const follows = register(base, { NEWSROOM_GROUP_TOOLS: value });
    assert.ok(follows.length > 50 && follows.every((t) => base.groups.isGroupChecked(t)), `value ${JSON.stringify(value)} follows the refusal: on with nothing else set`);
    const offWithRefusalOff = register(base, { NEWSROOM_GROUP_TOOLS: value, NEWSROOM_GROUP_ENFORCE: "0" });
    assert.ok(offWithRefusalOff.length > 50 && offWithRefusalOff.every((t) => !base.groups.isGroupChecked(t)), `value ${JSON.stringify(value)} follows the refusal: off with ENFORCE="0"`);
  }
  check('switch: exactly "0" turns it off, exactly "1" on (needs ENFORCE); a leftover HANDOFF=0 is ignored; any other value follows the refusal switch');
}

// 2. every tool registered as group.action; off-state tool list unchanged
{
  const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8")).tools;
  const seen = new Set();
  for (const profile of ["investigate", "visual", "publication", "visual-story", "competition", "full"]) {
    const off = register(base, { NEWSROOM_GROUP_TOOLS: "0" }, profile); // #64 step 4 default change: "0" is the off state
    const on = register(base, ON, profile);
    assert.deepEqual(on.map((t) => [t.name, t.description, JSON.stringify(t.parameters), t.label, JSON.stringify(t.promptGuidelines ?? null)]), off.map((t) => [t.name, t.description, JSON.stringify(t.parameters), t.label, JSON.stringify(t.promptGuidelines ?? null)]), `${profile}: with the switch on the tool list, descriptions and schemas are unchanged`);
    for (const tool of on) { assert.ok(base.groups.isGroupChecked(tool), `${tool.name} went through the wrapper`); assert.ok(table[tool.name]?.registered_as, `${tool.name} has a group.action name`); seen.add(tool.name); }
  }
  assert.ok(seen.size >= 50, `tools seen: ${seen.size}`);
  // the 7 tools that no profile registers under the default conditions (6 conditional, 1 hidden) still pass the same registration check
  for (const name of Object.keys(table)) base.groups.assertToolRegistered(name);
  assert.equal(Object.keys(table).length, 59);
  check(`registration: ${seen.size} tools in six profiles all pass the wrapper (the other 7 of the 59 pass the same registration check), list, descriptions, schemas equal the off state`);
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
  assert.ok(register(noRow, { NEWSROOM_GROUP_TOOLS: "0" }).length > 50, "off: a missing row stops nothing"); // #64 step 4 default change: "0" is the off state
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
  // a child process writing into a SUB-folder is seen too (mutant: first-level-only comparison -> this goes red)
  const deep = await g.runInTool("newsroom_viz_render", () => g.runDeclared(dir, [], async () => { mkdirSync(join(dir, "data/deep/er"), { recursive: true }); writeFileSync(join(dir, "data/deep/er/x.csv"), "x"); }).catch((e) => e));
  assert.equal(deep.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(deep.detail.extra, ["data/deep/er/x.csv"]); assert.ok(!existsSync(join(dir, "data/deep/er/x.csv")), "sub-folder file rolled back");
  const deepDeclared = await g.runInTool("newsroom_network_reduce", () => g.runDeclared(dir, [out], async () => { writeFileSync(join(dir, out), "{}"); mkdirSync(join(dir, "visualizations/graph-reduction/sub"), { recursive: true }); writeFileSync(join(dir, "visualizations/graph-reduction/sub/y.json"), "x"); }).catch((e) => e));
  assert.equal(deepDeclared.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(deepDeclared.detail.extra, ["visualizations/graph-reduction/sub/y.json"]);
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
  clearEnv(); process.env.NEWSROOM_GROUP_TOOLS = "0"; // #64 step 4 default change: "0" is the off state
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
  for (const [label, env] of [["on", ON], ["off", { NEWSROOM_GROUP_TOOLS: "0" }]]) {
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

// 7. the before/after comparison: sibling attribution, rewritten and removed files, the bookkeeping list, off state (件 D)
{
  Object.assign(process.env, ON);
  const T = "newsroom_network_reduce";
  const GR = "visualizations/graph-reduction";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tool = (dir, fn) => g.withGroupTools({ name: T, execute: () => g.runDeclared(dir, [], fn) });
  const siblingWith = (dir, rel, { judged = true, ms = 5 } = {}) => g.withGroupTools({ name: T, execute: async () => { await sleep(ms); if (judged) g.recordBoundaryWrite(dir, rel, "write"); writeFileSync(join(dir, rel), "{}"); } });

  // 7a. a file a call running at the same time wrote (its judged write was noted before the file) is not this child process's: 20 runs, no refusal
  let refused = 0;
  for (let i = 0; i < 20; i++) {
    const dir = dirFor();
    const sib = siblingWith(dir, `${GR}/sibling.json`);
    const r = await tool(dir, async () => { const p = sib.execute(); await sleep(30); await p; }).execute().catch((e) => e);
    if (r?.code === "GROUP_TOOLS_REFUSED") refused += 1;
  }
  assert.equal(refused, 0, "a sibling's judged write is not blamed on this call's child process");
  // mutants: the sibling's write was never judged / is a different path / the child wrote its own extra file next to it -> still refused
  const dirU = dirFor(); const sibU = siblingWith(dirU, `${GR}/sibling.json`, { judged: false });
  const unjudged = await tool(dirU, async () => { const p = sibU.execute(); await sleep(30); await p; }).execute().catch((e) => e);
  assert.equal(unjudged.code, "GROUP_TOOLS_REFUSED"); assert.equal(unjudged.detail.overlapped, true);
  assert.ok(existsSync(join(dirU, `${GR}/sibling.json`)), "overlapping calls: still nothing is deleted");
  const dirD = dirFor();
  const sibD = g.withGroupTools({ name: T, execute: async () => { await sleep(5); g.recordBoundaryWrite(dirD, `${GR}/other.json`, "write"); writeFileSync(join(dirD, `${GR}/other.json`), "{}"); writeFileSync(join(dirD, `${GR}/not-judged.json`), "{}"); } });
  const diff = await tool(dirD, async () => { const p = sibD.execute(); await sleep(30); await p; }).execute().catch((e) => e);
  assert.deepEqual(diff.detail.extra, [`${GR}/not-judged.json`], "only the file nobody judged is left over");
  const dirC = dirFor(); const sibC = siblingWith(dirC, `${GR}/sibling.json`);
  const mine = await tool(dirC, async () => { const p = sibC.execute(); writeFileSync(join(dirC, `${GR}/child-extra.json`), "x"); await sleep(30); await p; }).execute().catch((e) => e);
  assert.equal(mine.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(mine.detail.extra, [`${GR}/child-extra.json`]);
  // a call that ended before this one started is not a sibling: its note does not excuse a file
  const dirE = dirFor();
  await siblingWith(dirE, `${GR}/early.json`).execute();
  rmSync(join(dirE, `${GR}/early.json`));
  const lateFile = await tool(dirE, async () => { writeFileSync(join(dirE, `${GR}/early.json`), "x"); }).execute().catch((e) => e);
  assert.equal(lateFile.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(lateFile.detail.rolled_back, [`${GR}/early.json`]);
  // the sibling's note only counts while the file still holds what the sibling left: when it has ended and the child process then rewrites that file, the
  // rewrite is this call's (refused; the overlap means nothing is deleted)
  const dirR = dirFor(); const rel = `${GR}/sibling.json`;
  const sibR = siblingWith(dirR, rel);
  const rewritten = await tool(dirR, async () => { await sibR.execute(); writeFileSync(join(dirR, rel), '{"by":"child"}'); }).execute().catch((e) => e);
  assert.equal(rewritten.code, "GROUP_TOOLS_REFUSED", "a sibling's file the child process rewrote afterwards is refused");
  assert.deepEqual(rewritten.detail.extra, [rel]);
  // an existing file: the sibling updates it, then the child process rewrites it again
  const dirR2 = dirFor(); writeFileSync(join(dirR2, rel), "before");
  const sibR2 = g.withGroupTools({ name: T, execute: async () => { g.recordBoundaryWrite(dirR2, rel, "write"); writeFileSync(join(dirR2, rel), "sibling"); } });
  const rewritten2 = await tool(dirR2, async () => { await sibR2.execute(); await sleep(15); writeFileSync(join(dirR2, rel), "child!!"); }).execute().catch((e) => e);
  assert.deepEqual(rewritten2.detail.changed, [rel], "an existing file the sibling updated and the child process rewrote again is the child's change");
  // known gap, pinned: a sibling that has not ended yet cannot be compared, its note is accepted as it is
  const dirG = dirFor(); const sibG = g.withGroupTools({ name: T, execute: async () => { await sleep(5); g.recordBoundaryWrite(dirG, rel, "write"); writeFileSync(join(dirG, rel), "{}"); await sleep(80); } });
  let sibGDone;
  const open = await tool(dirG, async () => { sibGDone = sibG.execute(); await sleep(40); }).execute().catch((e) => e);
  await sibGDone;
  assert.equal(open, undefined, "a sibling still running at the end: its note is accepted (gap)");
  check("child process: a file a call running at the same time wrote (judged before it was written) is that call's, 20 runs without a refusal; unjudged, other-path and own extra files are still refused");

  // 7b. an existing file rewritten or removed by a child process: refused and put back from the copy taken before it started (K636; before: reported as not restored)
  const dir = dirFor();
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, `${GR}/old.json`), "old"); writeFileSync(join(dir, `${GR}/gone.json`), "gone");
  writeFileSync(join(dir, "data/ev.csv"), "a,b\n1,2\n");
  const rewrite = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { writeFileSync(join(dir, `${GR}/old.json`), "new content"); })).catch((e) => e);
  assert.equal(rewrite.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(rewrite.detail.changed, [`${GR}/old.json`]); assert.equal(rewrite.detail.restored, true);
  assert.equal(readFileSync(join(dir, `${GR}/old.json`), "utf8"), "old", "a rewrite is put back");
  const removal = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { rmSync(join(dir, `${GR}/gone.json`)); })).catch((e) => e);
  assert.equal(removal.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(removal.detail.deleted, [`${GR}/gone.json`]); assert.equal(removal.detail.restored, true);
  assert.equal(readFileSync(join(dir, `${GR}/gone.json`), "utf8"), "gone", "a removal is put back");
  assert.match(removal.message, /removed 1 existing file\(s\).*; restored\)/); assert.doesNotMatch(removal.message, /NEWSROOM_|GROUP_TOOLS=|ENFORCE/, "the refusal names no switch");
  assert.ok(readFileSync(join(dir, "runtime/boundary-refusals.jsonl"), "utf8").includes('"deleted":["visualizations/graph-reduction/gone.json"]'), "the refusal log has the removal");
  // evidence is judged by content: the same bytes written again pass, other bytes are refused
  const same = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { await sleep(15); writeFileSync(join(dir, "data/ev.csv"), "a,b\n1,2\n"); }, { watch: ["data"] })).catch((e) => e);
  assert.equal(same, undefined, "evidence rewritten with the same bytes is not a change");
  const other = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { writeFileSync(join(dir, "data/ev.csv"), "a,b\n9,9\n"); }, { watch: ["data"] })).catch((e) => e);
  assert.deepEqual(other.detail.changed, ["data/ev.csv"]);
  // a declared output that already existed may be rewritten (that is what declaring it means)
  const declaredRewrite = await g.runInTool(T, () => g.runDeclared(dir, [`${GR}/old.json`], async () => { writeFileSync(join(dir, `${GR}/old.json`), "newer"); })).catch((e) => e);
  assert.equal(declaredRewrite, undefined);
  // 7c. K381 NEWSROOM_GROUP_TOOLS_HASH_ALL=1: a non-evidence file rewritten with other bytes but the same size and time is seen; off (or any value but "1") it is not
  const dirH = dirFor();
  // whole-second times so "the same time" is exact (a Date loses the sub-millisecond part)
  const FIXED = 1_700_000_000;
  const setFile = (file, bytes) => { writeFileSync(file, bytes); utimesSync(file, FIXED, FIXED); };
  const sameStat = (name, bytes) => setFile(join(dirH, name), bytes);
  setFile(join(dirH, `${GR}/quiet.json`), "AAAA");
  const sneaky = () => g.runInTool(T, () => g.runDeclared(dirH, [], async () => { sameStat(`${GR}/quiet.json`, "BBBB"); }, { watch: [GR] })).catch((e) => e);
  for (const v of [undefined, "", "0", "true", " 1", "11"]) {
    if (v === undefined) delete process.env.NEWSROOM_GROUP_TOOLS_HASH_ALL; else process.env.NEWSROOM_GROUP_TOOLS_HASH_ALL = v;
    setFile(join(dirH, `${GR}/quiet.json`), "AAAA");
    assert.equal(await sneaky(), undefined, `HASH_ALL=${JSON.stringify(v)}: a same-size same-time rewrite is not seen (as today)`);
  }
  process.env.NEWSROOM_GROUP_TOOLS_HASH_ALL = "1";
  setFile(join(dirH, `${GR}/quiet.json`), "AAAA");
  const seen = await sneaky();
  assert.equal(seen.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(seen.detail.changed, [`${GR}/quiet.json`]); assert.equal(seen.detail.restored, true);
  // it only adds: the same bytes written again (a touch) is still judged by size/time as before, a declared output may still be rewritten, an untouched run passes
  setFile(join(dirH, `${GR}/quiet.json`), "AAAA");
  assert.equal(await g.runInTool(T, () => g.runDeclared(dirH, [], async () => {}, { watch: [GR] })).catch((e) => e), undefined, "nothing changed: passes");
  assert.equal(await g.runInTool(T, () => g.runDeclared(dirH, [`${GR}/quiet.json`], async () => { sameStat(`${GR}/quiet.json`, "CCCC"); }, { watch: [GR] })).catch((e) => e), undefined, "a declared output may be rewritten");
  const sizeMoved = await g.runInTool(T, () => g.runDeclared(dirH, [], async () => { writeFileSync(join(dirH, `${GR}/quiet.json`), "longer than before"); }, { watch: [GR] })).catch((e) => e);
  assert.deepEqual(sizeMoved.detail.changed, [`${GR}/quiet.json`], "a size change is still seen with the switch on");
  // a file over the cap is not read: size and time rule only
  const big = join(dirH, `${GR}/big.bin`);
  setFile(big, Buffer.alloc(g.HASH_ALL_MAX_BYTES + 1, 1));
  const capped = await g.runInTool(T, () => g.runDeclared(dirH, [], async () => { setFile(big, Buffer.alloc(g.HASH_ALL_MAX_BYTES + 1, 2)); }, { watch: [GR] })).catch((e) => e);
  assert.equal(capped, undefined, "over the size cap: not hashed (size/time only)");
  // the chain: HASH_ALL needs TOOLS
  // #64 step 4 default change: unset TOOLS is on with the refusal on, so the stop needs TOOLS "0"
  delete process.env.NEWSROOM_GROUP_TOOLS;
  assert.doesNotThrow(() => g.assertGroupToolsSwitches());
  process.env.NEWSROOM_GROUP_TOOLS = "0";
  assert.throws(() => g.assertGroupToolsSwitches(), /GROUP_TOOLS_HASH_ALL_NEEDS_TOOLS/);
  process.env.NEWSROOM_GROUP_TOOLS = "1";
  g.assertGroupToolsSwitches();
  delete process.env.NEWSROOM_GROUP_TOOLS_HASH_ALL;
  check("child process: with HASH_ALL=1 (needs TOOLS) a non-evidence file rewritten with other bytes but the same size and time is refused (and put back); any other value, off, a declared output, and a file over the size cap behave as before");
  check("child process: rewriting an existing file (evidence by content hash, others by size/time) or removing one is refused and put back from the copy; a declared output may be rewritten");

  // 7c. the bookkeeping list is fixed; appending to its files passes, a NEW file of that name and any file outside it do not
  assert.deepEqual([...g.BOOKKEEPING_FILES], ["events.jsonl", "run-metrics.jsonl", "conversation.md", "plan-progress.json", "runtime/group-boundary-report.json", "runtime/boundary-refusals.jsonl", "runtime/tool-chain-events.jsonl", "runtime/cross-call-report.jsonl"]);
  assert.deepEqual([...g.BOOKKEEPING_FOLDERS], ["session/"]);
  const dirB = dirFor();
  mkdirSync(join(dirB, "runtime"), { recursive: true }); mkdirSync(join(dirB, "session"), { recursive: true });
  for (const f of g.BOOKKEEPING_FILES) writeFileSync(join(dirB, f), "x\n");
  writeFileSync(join(dirB, "session/a.jsonl"), "x\n"); writeFileSync(join(dirB, "notes.md"), "x\n");
  const appended = await g.runInTool(T, () => g.runDeclared(dirB, [], async () => {
    await sleep(15);
    for (const f of [...g.BOOKKEEPING_FILES, "session/a.jsonl"]) appendFileSync(join(dirB, f), "more\n");
    rmSync(join(dirB, "session/a.jsonl"));
  })).catch((e) => e);
  assert.equal(appended, undefined, "appending to (or removing) the program's own bookkeeping files is not judged");
  const notBook = await g.runInTool(T, () => g.runDeclared(dirB, [], async () => { await sleep(15); appendFileSync(join(dirB, "notes.md"), "more\n"); })).catch((e) => e);
  assert.deepEqual(notBook.detail.changed, ["notes.md"], "a file outside the list is judged");
  const dirN = dirFor();
  const newBook = await g.runInTool(T, () => g.runDeclared(dirN, [], async () => { writeFileSync(join(dirN, "events.jsonl"), "x"); })).catch((e) => e);
  assert.deepEqual(newBook.detail.extra, ["events.jsonl"], "a NEW file with a bookkeeping name is still judged");
  check("bookkeeping list pinned (7 files + session/): appended or removed -> not judged; a file outside it, or a new one of that name -> judged");

  // 7d. off: nothing is compared, whatever the child process does
  clearEnv(); process.env.NEWSROOM_GROUP_TOOLS = "0"; // #64 step 4 default change: "0" is the off state
  const dirO = dirFor(); writeFileSync(join(dirO, `${GR}/old.json`), "old");
  const off = await g.runInTool(T, () => g.runDeclared(dirO, [], async () => { writeFileSync(join(dirO, `${GR}/old.json`), "changed"); rmSync(join(dirO, `${GR}/old.json`)); return 3; }));
  assert.equal(off, 3); assert.ok(!existsSync(join(dirO, "runtime/boundary-refusals.jsonl")));
  check("off: rewrite and removal pass untouched, no log");

  // 7e. cost of one runDeclared around a no-op child (fixture: 400 plain files, 80 evidence files of 20 KB); printed, not asserted
  Object.assign(process.env, ON);
  const dirM = dirFor();
  mkdirSync(join(dirM, "data"), { recursive: true });
  for (let i = 0; i < 400; i++) writeFileSync(join(dirM, `${GR}/f${i}.json`), "{}");
  for (let i = 0; i < 80; i++) writeFileSync(join(dirM, `data/e${i}.csv`), "x".repeat(20_000));
  const timeIt = async (wrap) => { const runs = []; for (let i = 0; i < 9; i++) { const t0 = performance.now(); await wrap(); runs.push(performance.now() - t0); } return runs.sort((a, b) => a - b)[4]; };
  const bare = await timeIt(async () => { await sleep(0); });
  const wrapped = await timeIt(() => g.runInTool(T, () => g.runDeclared(dirM, [], async () => { await sleep(0); }, { watch: [GR, "data"] })));
  console.log(`  cost: runDeclared around a no-op child, median of 9: bare ${bare.toFixed(2)} ms, wrapped ${wrapped.toFixed(2)} ms (+${(wrapped - bare).toFixed(2)} ms; 480 files, 80 hashed)`);
  check("cost of the before/after comparison measured on a fixture");
  clearEnv();
}

// 8. K635: a REAL child process (the duckdb binary of duckdb_query, replaced by a wrapper around the real duckdb) writes into another group's folder
//    duckdb_query belongs to the knowledge group and declares no output, so runDeclared watches the whole run folder. maps/ belongs to the visual group (groups.json, kind visual_spec).
{
  const duck = join(scratch, "stub-duckdb.sh");
  // the wrapper acts on the run folder (the child's cwd), then runs the real duckdb with the same arguments
  writeFileSync(duck, `#!/bin/sh
if [ "$1" = "-json" ]; then  # only the query call (the tool also starts a parse call with -noheader, which stays quiet)
[ -n "$STUB_WRITE" ] && { mkdir -p "$(dirname "$STUB_WRITE")"; printf x > "$STUB_WRITE"; }
[ -n "$STUB_REWRITE" ] && printf changed > "$STUB_REWRITE"
[ -n "$STUB_REMOVE" ] && rm -f "$STUB_REMOVE"
fi
exec "\${STUB_REAL_DUCKDB:-duckdb}" "$@"
`);
  chmodSync(duck, 0o755);
  const which = spawnSync("duckdb", ["--version"]);
  assert.equal(which.status, 0, "section 8 needs the real duckdb binary on PATH (CI installs duckdb-cli)");
  const owner = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8")).tools.duckdb_query.group;
  assert.equal(owner, "knowledge");
  const foreign = "maps/stray.json";
  const rows = (dir) => (existsSync(join(dir, "runtime/boundary-refusals.jsonl")) ? readFileSync(join(dir, "runtime/boundary-refusals.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const fresh = (env) => {
    const dir = dirFor();
    mkdirSync(join(dir, "maps"), { recursive: true });
    const tools = register(base, { ...env, NEWSROOM_ARTIFACT_DIR: dir, NEWSROOM_DUCKDB_BIN: duck });
    return { dir, query: tools.find((t) => t.name === "duckdb_query") };
  };
  const setStub = (vars) => { for (const k of ["STUB_WRITE", "STUB_REWRITE", "STUB_REMOVE"]) delete process.env[k]; Object.assign(process.env, vars); };
  const sql = { sql: "SELECT 1 AS n" };

  // 8a. a child that writes only what it may (nothing): accepted, no row
  {
    const { dir, query } = fresh(ON);
    setStub({});
    const ok = await query.execute("1", sql, undefined);
    assert.match(JSON.stringify(ok), /row_count/, "a quiet real child is accepted");
    assert.equal(rows(dir).length, 0, "and writes no refusal row");
    check("8a real child (duckdb_query, real duckdb behind a wrapper) that writes nothing: accepted, no row");
  }
  // 8b. a child that writes one file into another group's folder: refused, file gone, one row
  {
    const { dir, query } = fresh(ON);
    setStub({ STUB_WRITE: foreign });
    const err = await query.execute("1", sql, undefined).catch((e) => e);
    assert.equal(err.code, "GROUP_TOOLS_REFUSED", "a real child writing into another group's folder is refused");
    assert.ok(!existsSync(join(dir, foreign)), "the file is rolled back");
    const log = rows(dir);
    assert.equal(log.length, 1, "exactly one new row");
    assert.equal(log[0].tool, "duckdb_query");
    assert.equal(log[0].group, "knowledge");
    assert.equal(log[0].status, "undeclared_output");
    assert.equal(log[0].path, foreign);
    assert.deepEqual(log[0].rolled_back, [foreign]);
    check("8b real child writes maps/stray.json (visual group's folder): GROUP_TOOLS_REFUSED, file gone, one row (tool, group, undeclared_output, path, rolled_back)");
  }
  // 8c. a child that rewrites one existing file and removes another: refused and recorded; K636: both are put back, byte-identical to the bytes this test kept
  {
    const { dir, query } = fresh(ON);
    writeFileSync(join(dir, "maps/old.json"), "old"); writeFileSync(join(dir, "maps/gone.json"), "gone");
    setStub({ STUB_REWRITE: "maps/old.json", STUB_REMOVE: "maps/gone.json" });
    const err = await query.execute("1", sql, undefined).catch((e) => e);
    assert.equal(err.code, "GROUP_TOOLS_REFUSED", "a real child that rewrites and removes files is refused");
    const log = rows(dir);
    assert.equal(log.length, 1);
    assert.equal(log[0].status, "undeclared_change");
    assert.deepEqual(log[0].changed, ["maps/old.json"]);
    assert.deepEqual(log[0].deleted, ["maps/gone.json"]);
    assert.equal(log[0].restored, true, "restored is true");
    assert.deepEqual(readFileSync(join(dir, "maps/old.json")), Buffer.from("old"), "the rewrite is back, byte-identical to the bytes kept here");
    assert.deepEqual(readFileSync(join(dir, "maps/gone.json")), Buffer.from("gone"), "the removed file is back, byte-identical");
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".group-restore-")), [], "the copy folder is gone after the call");
    check("8c real child rewrites maps/old.json and removes maps/gone.json: refused, recorded with changed, deleted, restored true; both files are back byte-identical, no copy folder left");
  }
  // 8d. off: the same children run as before, no row, nothing deleted
  {
    const { dir, query } = fresh({ NEWSROOM_GROUP_TOOLS: "0" });
    writeFileSync(join(dir, "maps/old.json"), "old"); writeFileSync(join(dir, "maps/gone.json"), "gone");
    setStub({ STUB_WRITE: foreign, STUB_REWRITE: "maps/old.json", STUB_REMOVE: "maps/gone.json" });
    const ok = await query.execute("1", sql, undefined);
    assert.match(JSON.stringify(ok), /row_count/, "off: the same child is accepted");
    assert.equal(rows(dir).length, 0, "off: no row");
    assert.ok(existsSync(join(dir, foreign)), "off: the new file stays");
    assert.equal(readFileSync(join(dir, "maps/old.json"), "utf8"), "changed");
    assert.ok(!existsSync(join(dir, "maps/gone.json")));
    check("8d off (NEWSROOM_GROUP_TOOLS=0): the same real children run as before, no row, the new file, the rewrite and the removal all stay");
  }
  setStub({});
  clearEnv();
  delete process.env.NEWSROOM_ARTIFACT_DIR; delete process.env.NEWSROOM_DUCKDB_BIN;
}

// 9. K636: the whole run folder is always watched, rewritten and removed files are put back from a copy taken before the child starts
{
  Object.assign(process.env, ON);
  const T = "newsroom_network_reduce"; const GR = "visualizations/graph-reduction";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rowsOf = (dir) => (existsSync(join(dir, "runtime/boundary-refusals.jsonl")) ? readFileSync(join(dir, "runtime/boundary-refusals.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const copyFolders = (dir) => readdirSync(dir).filter((n) => n.startsWith(".group-restore-"));
  const mk = () => { const d = dirFor(); mkdirSync(join(d, "data"), { recursive: true }); mkdirSync(join(d, "maps"), { recursive: true }); mkdirSync(join(d, "runtime"), { recursive: true }); return d; };
  const run = (dir, outputs, fn, opts) => g.runInTool(T, () => g.runDeclared(dir, outputs, fn, opts)).catch((e) => e);

  // 9a. the gap: a tool that declares visualizations/graph-reduction/out.json, its child writes into maps/ (outside the declared folder): seen, refused, deleted, recorded
  {
    const dir = mk();
    const err = await run(dir, [`${GR}/out.json`], async () => { writeFileSync(join(dir, `${GR}/out.json`), "a\n"); writeFileSync(join(dir, "maps/stray.json"), "x"); });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED", "a write outside the declared folders is refused");
    assert.deepEqual(err.detail.extra, ["maps/stray.json"]);
    assert.ok(!existsSync(join(dir, "maps/stray.json")), "and deleted");
    assert.ok(existsSync(join(dir, `${GR}/out.json`)), "the declared output stays");
    const log = rowsOf(dir);
    assert.equal(log.length, 1); assert.equal(log[0].status, "undeclared_output"); assert.deepEqual(log[0].rolled_back, ["maps/stray.json"]);
    check("9a a tool that declares visualizations/graph-reduction/out.json: its child writing maps/stray.json (outside the declared folder) is refused, the file deleted, one row recorded");
  }
  // 9b. the same, for a rewrite and a removal outside the declared folder, and a caller's watch cannot narrow the folder
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old"); writeFileSync(join(dir, "maps/gone.json"), "gone");
    const err = await run(dir, [`${GR}/out.json`], async () => { writeFileSync(join(dir, "maps/old.json"), "new content"); rmSync(join(dir, "maps/gone.json")); }, { watch: ["data"] });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(err.detail.changed, ["maps/old.json"]); assert.deepEqual(err.detail.deleted, ["maps/gone.json"]);
    assert.equal(err.detail.restored, true);
    assert.deepEqual(readFileSync(join(dir, "maps/old.json")), Buffer.from("old")); assert.deepEqual(readFileSync(join(dir, "maps/gone.json")), Buffer.from("gone"));
    assert.deepEqual(copyFolders(dir), [], "no copy folder is left");
    check("9b a rewrite and a removal outside the declared folders, with watch: [data] (a caller cannot narrow the watch): refused, both put back byte-identical, no copy folder left");
  }
  // 9c. the copy folder exists while the child runs and is not itself blamed; stale folders of a dead process are removed at the first call
  {
    const dir = mk();
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(join(dir, `.group-restore-${dead}-1`)); writeFileSync(join(dir, `.group-restore-${dead}-1/x`), "left over");
    let seenDuring = null;
    const ok = await run(dir, [], async () => { seenDuring = copyFolders(dir); });
    assert.equal(ok, undefined, "the copy folder is not a change");
    assert.equal(seenDuring.length, 1, "one copy folder while the child runs (the stale one is already gone)");
    assert.ok(!seenDuring[0].includes(`-${dead}-`));
    assert.deepEqual(copyFolders(dir), [], "none after");
    check("9c a copy folder exists while the child runs and is never blamed; a stale one of a dead process is removed; none is left after the call");
  }
  // 9d. fail closed: the copy cannot be made (run folder not writable): refused before the child starts, nothing happens, one row, folder unchanged
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old");
    const marker = join(scratch, "child-ran-9d");
    const listing = () => readdirSync(dir).sort().join(",");
    const beforeList = listing();
    chmodSync(dir, 0o555);
    let err;
    try { err = await run(dir, [], async () => { writeFileSync(marker, "ran"); }); } finally { chmodSync(dir, 0o755); }
    assert.equal(err?.code, "GROUP_TOOLS_REFUSED", "a copy that cannot be made refuses the call");
    assert.ok(!existsSync(marker), "the child never ran");
    const log = rowsOf(dir);
    assert.equal(log.length, 1); assert.equal(log[0].status, "snapshot_failed"); assert.equal(log[0].tool, T);
    assert.match(err.message, /not started/);
    assert.equal(listing(), beforeList, "the run folder is unchanged");
    assert.equal(readFileSync(join(dir, "maps/old.json"), "utf8"), "old");
    check("9d fail closed: run folder not writable -> GROUP_TOOLS_REFUSED before the child starts, the child's side effect never happens, one snapshot_failed row, folder unchanged");
  }
  // 9e. overlap: a rewrite nobody noted while another call ran at the same time is reported, not restored (reason overlapped); a sibling's noted write is not touched
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old"); writeFileSync(join(dir, `${GR}/sib.json`), "before");
    const sib = g.withGroupTools({ name: T, execute: async () => { await sleep(5); g.recordBoundaryWrite(dir, `${GR}/sib.json`, "write"); writeFileSync(join(dir, `${GR}/sib.json`), "sibling's"); } });
    const err = await g.withGroupTools({ name: T, execute: () => g.runDeclared(dir, [], async () => { const p = sib.execute(); await sleep(30); writeFileSync(join(dir, "maps/old.json"), "changed!"); await p; }) }).execute().catch((e) => e);
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.equal(err.detail.overlapped, true);
    assert.deepEqual(err.detail.changed, ["maps/old.json"], "the sibling's noted write is not this call's");
    assert.equal(err.detail.restored, false);
    assert.deepEqual(err.detail.restore_failed, [{ path: "maps/old.json", reason: "overlapped" }]);
    assert.equal(readFileSync(join(dir, "maps/old.json"), "utf8"), "changed!", "not restored: it cannot be told from the other call's unjudged write");
    assert.equal(readFileSync(join(dir, `${GR}/sib.json`), "utf8"), "sibling's", "the sibling's judged write is never put back");
    assert.deepEqual(copyFolders(dir), []);
    check("9e overlap rule: with another call running at the same time an unnoted rewrite is refused and reported restored false / overlapped, not put back; a sibling's judged write is never touched");
  }
  // 9f. the byte check: a child that damages the copy (other bytes, other size) is not reported as restored
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old content");
    const err = await run(dir, [], async () => {
      writeFileSync(join(dir, "maps/old.json"), "new");
      for (const folder of copyFolders(dir)) writeFileSync(join(dir, folder, "maps/old.json"), "tampered!!");
    });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.equal(err.detail.restored, false);
    assert.deepEqual(err.detail.restore_failed, [{ path: "maps/old.json", reason: "bytes_differ" }]);
    assert.match(err.message, /not restored/);
    assert.deepEqual(copyFolders(dir), []);
    check("9f restore check: a child that damaged the copy gets restored false / bytes_differ (never a false restored true); the copy folder is removed anyway");
  }
  // 9g. a child that throws still has its writes judged, and the copy folder is removed
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old");
    const err = await run(dir, [], async () => { writeFileSync(join(dir, "maps/old.json"), "new content"); throw new Error("child failed"); });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.equal(err.detail.restored, true);
    assert.equal(readFileSync(join(dir, "maps/old.json"), "utf8"), "old");
    assert.deepEqual(copyFolders(dir), []);
    check("9g a child that throws after rewriting a file: refused and restored, copy folder removed");
  }
  // 9i. F1: only the copy folders of calls in flight are skipped, by exact name; any other `.group-restore-*` name is a new file like any other (also one named after a live pid)
  {
    const dir = mk();
    const err = await run(dir, [], async () => {
      mkdirSync(join(dir, ".group-restore-zzz")); writeFileSync(join(dir, ".group-restore-zzz/f"), "x");
      mkdirSync(join(dir, ".group-restore-1-x")); writeFileSync(join(dir, ".group-restore-1-x/f"), "x");
    });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED");
    assert.deepEqual([...err.detail.extra].sort(), [".group-restore-1-x/f", ".group-restore-zzz/f"], "both are seen");
    assert.ok(!existsSync(join(dir, ".group-restore-zzz/f")) && !existsSync(join(dir, ".group-restore-1-x/f")), "and deleted");
    // a stale folder of a dead process is removed before the listing, so it is never reported as removed
    const dir2 = mk(); const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(join(dir2, `.group-restore-${dead}-1`)); writeFileSync(join(dir2, `.group-restore-${dead}-1/x`), "left over");
    assert.equal(await run(dir2, [], async () => {}), undefined, "a stale folder cleaned at the start is not a false refusal");
    assert.ok(!existsSync(join(dir2, `.group-restore-${dead}-1`)), "and it is gone");
    // a folder that died AFTER an earlier call in the same run folder is cleaned at the next call too
    mkdirSync(join(dir2, `.group-restore-${dead}-2`)); writeFileSync(join(dir2, `.group-restore-${dead}-2/x`), "left over");
    assert.equal(await run(dir2, [], async () => {}), undefined); assert.ok(!existsSync(join(dir2, `.group-restore-${dead}-2`)));
    check("9i a child writing .group-restore-zzz/f and .group-restore-1-x/f (not the call's own folder) is refused and both deleted; a stale folder of a dead process is cleaned before the listing, no false refusal");
  }
  // 9j. F2: a real child swaps a file for a link to a file outside the run folder: the outside file keeps its bytes, the run-folder entry is a regular file with the old bytes
  {
    const dir = mk();
    const outside = join(scratch, "outside-9j.txt"); writeFileSync(outside, "outside original");
    writeFileSync(join(dir, "data/x.csv"), "a,b\n1,2\n");
    const err = await run(dir, [], async () => {
      const r = spawnSync(process.execPath, ["-e", "const fs=require('fs');fs.rmSync(process.argv[1]);fs.symlinkSync(process.argv[2],process.argv[1]);", join(dir, "data/x.csv"), outside]);
      assert.equal(r.status, 0);
    });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(err.detail.changed, ["data/x.csv"]);
    assert.equal(readFileSync(outside, "utf8"), "outside original", "the guard never writes through the link");
    assert.ok(lstatSync(join(dir, "data/x.csv")).isFile() && !lstatSync(join(dir, "data/x.csv")).isSymbolicLink(), "a regular file is back");
    assert.equal(readFileSync(join(dir, "data/x.csv"), "utf8"), "a,b\n1,2\n"); assert.equal(err.detail.restored, true);
    // a folder swapped for a link to a folder outside: link removed, real folder back, nothing written outside
    const dir2 = mk(); const outDir = join(scratch, "outside-9j-dir"); mkdirSync(outDir, { recursive: true });
    writeFileSync(join(dir2, "maps/old.json"), "old");
    const err2 = await run(dir2, [], async () => { rmSync(join(dir2, "maps"), { recursive: true }); symlinkSync(outDir, join(dir2, "maps")); });
    assert.equal(err2.code, "GROUP_TOOLS_REFUSED");
    assert.deepEqual(readdirSync(outDir), [], "nothing was written outside the run folder");
    assert.ok(lstatSync(join(dir2, "maps")).isDirectory() && !lstatSync(join(dir2, "maps")).isSymbolicLink(), "the link is gone (deleted as a new file), a real folder is back");
    assert.equal(readFileSync(join(dir2, "maps/old.json"), "utf8"), "old");
    check("9j a real child replacing data/x.csv with a link to a file outside: the outside file is untouched, a regular file with the old bytes is back; a folder swapped for a link to a folder outside: the link is removed as a new file, the real folder and its file are back, nothing written outside");
  }
  // 9k. a python child that imports a module from the run folder leaves no __pycache__ (the program starts every child with PYTHONDONTWRITEBYTECODE=1): accepted, no row
  {
    const dir = mk();
    const savedBytecode = process.env.PYTHONDONTWRITEBYTECODE; delete process.env.PYTHONDONTWRITEBYTECODE; // the test's own environment must not do the work
    writeFileSync(join(dir, "helper_9k.py"), "VALUE = 7\n");
    const { runProcess } = await import(pathToFileURL(join(ROOT, "runtime/pi/process.mjs")).href);
    let out;
    const err = await run(dir, [], async () => { out = await runProcess("python3", ["-c", "import helper_9k; print(helper_9k.VALUE)"], undefined, dir); });
    assert.equal(err, undefined, "no refusal");
    assert.equal(out.stdout.trim(), "7");
    assert.ok(!existsSync(join(dir, "__pycache__")), "no bytecode cache");
    assert.deepEqual(rowsOf(dir), [], "no row");
    if (savedBytecode !== undefined) process.env.PYTHONDONTWRITEBYTECODE = savedBytecode;
    check("9k a real python child importing a module that sits in the run folder: no __pycache__, accepted, no row");
  }
  // 9l. M1: a file replaced by a folder (holding a file): the new file goes as an extra, the then empty folder is removed (never recursively), the file is back; a missing parent folder is made again
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/a.json"), "A-original"); utimesSync(join(dir, "maps/a.json"), 1700000000, 1700000000);
    const err = await run(dir, [], async () => { rmSync(join(dir, "maps/a.json")); mkdirSync(join(dir, "maps/a.json")); writeFileSync(join(dir, "maps/a.json/f"), "inner"); });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.equal(err.detail.restored, true); assert.deepEqual([...err.detail.changed, ...err.detail.deleted], ["maps/a.json"]);
    assert.ok(lstatSync(join(dir, "maps/a.json")).isFile(), "a file, not a folder");
    assert.equal(readFileSync(join(dir, "maps/a.json"), "utf8"), "A-original");
    assert.equal(Math.round(lstatSync(join(dir, "maps/a.json")).mtimeMs), 1700000000000, "the earlier modification time is back (to the millisecond)");
    assert.deepEqual(copyFolders(dir), []);
    // the whole folder removed: the parent is made again
    const dir2 = mk(); mkdirSync(join(dir2, "maps/deep"), { recursive: true }); writeFileSync(join(dir2, "maps/deep/b.json"), "B");
    const err2 = await run(dir2, [], async () => { rmSync(join(dir2, "maps"), { recursive: true }); });
    assert.equal(err2.code, "GROUP_TOOLS_REFUSED"); assert.equal(err2.detail.restored, true);
    assert.equal(readFileSync(join(dir2, "maps/deep/b.json"), "utf8"), "B");
    check("9l a child replacing maps/a.json by a folder with a file in it: refused, the file and its earlier time are back, no folder left (never removed recursively); a removed folder tree is made again");
  }
  // 9m. M2: a moved file is put back under its old name, never deleted as a new file; a hard link is a new name; a moved and changed file is restored from the copy and its new name goes
  {
    const dir = mk();
    writeFileSync(join(dir, "plan-progress.json"), "PLAN"); writeFileSync(join(dir, "data/x.csv"), "a,b\n1,2\n"); writeFileSync(join(dir, "events.jsonl"), "E\n");
    const err = await run(dir, [], async () => { renameSync(join(dir, "plan-progress.json"), join(dir, "maps/p.json")); });
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(err.detail.moved_back, [{ from: "maps/p.json", to: "plan-progress.json" }]);
    assert.equal(readFileSync(join(dir, "plan-progress.json"), "utf8"), "PLAN"); assert.ok(!existsSync(join(dir, "maps/p.json")));
    const err2 = await run(dir, [], async () => { renameSync(join(dir, "data/x.csv"), join(dir, "maps/x.csv")); });
    assert.deepEqual(err2.detail.moved_back, [{ from: "maps/x.csv", to: "data/x.csv" }]);
    assert.equal(readFileSync(join(dir, "data/x.csv"), "utf8"), "a,b\n1,2\n"); assert.ok(!existsSync(join(dir, "maps/x.csv")));
    // a case-only rename (same file on a case-insensitive volume): back under the old spelling
    const err3 = await run(dir, [], async () => { renameSync(join(dir, "events.jsonl"), join(dir, "Events.jsonl")); });
    assert.equal(err3.code, "GROUP_TOOLS_REFUSED");
    assert.ok(readdirSync(dir).includes("events.jsonl") && !readdirSync(dir).includes("Events.jsonl"), "the old spelling is back");
    assert.equal(readFileSync(join(dir, "events.jsonl"), "utf8"), "E\n");
    // a hard link: the new name is removed, the original stays
    const err4 = await run(dir, [], async () => { linkSync(join(dir, "data/x.csv"), join(dir, "maps/link.csv")); });
    assert.deepEqual(err4.detail.extra, ["maps/link.csv"]); assert.ok(!existsSync(join(dir, "maps/link.csv"))); assert.equal(readFileSync(join(dir, "data/x.csv"), "utf8"), "a,b\n1,2\n");
    // moved and then changed: the old name comes back from the copy, the new name goes (the old bytes are never lost)
    const err5 = await run(dir, [], async () => { renameSync(join(dir, "data/x.csv"), join(dir, "maps/y.csv")); appendFileSync(join(dir, "maps/y.csv"), "more\n"); });
    assert.equal(err5.code, "GROUP_TOOLS_REFUSED"); assert.equal(readFileSync(join(dir, "data/x.csv"), "utf8"), "a,b\n1,2\n"); assert.ok(!existsSync(join(dir, "maps/y.csv")));
    assert.deepEqual(copyFolders(dir), []);
    // a link that was there before and is moved: its only name comes back (a link is not "new" because it was moved)
    const dir6 = mk(); symlinkSync("x.csv", join(dir6, "data/lnk"));
    const err6 = await run(dir6, [], async () => { renameSync(join(dir6, "data/lnk"), join(dir6, "maps/lnk")); });
    assert.equal(err6?.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(err6.detail.moved_back, [{ from: "maps/lnk", to: "data/lnk" }]);
    assert.ok(lstatSync(join(dir6, "data/lnk")).isSymbolicLink()); assert.ok(!existsSync(join(dir6, "maps/lnk")) && !(() => { try { lstatSync(join(dir6, "maps/lnk")); return true; } catch { return false; } })());
    // the old name now holds a fresh file: the moved file keeps its only name, nothing is deleted
    const dir7 = mk(); writeFileSync(join(dir7, "events.jsonl"), "OLD\n");
    const err7 = await run(dir7, [], async () => { renameSync(join(dir7, "events.jsonl"), join(dir7, "maps/e.bak")); writeFileSync(join(dir7, "events.jsonl"), "NEW\n"); });
    assert.equal(err7?.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(err7.detail.kept_moved, ["maps/e.bak"]);
    assert.equal(readFileSync(join(dir7, "maps/e.bak"), "utf8"), "OLD\n", "the old bytes survive"); assert.equal(readFileSync(join(dir7, "events.jsonl"), "utf8"), "NEW\n");
    check("9m a moved file (plan-progress.json, data/x.csv, a case-only rename) is put back under its old name and never deleted; a hard link's new name is removed; a moved and changed file is restored from the copy");
  }
  // 9n. M3: a folder that cannot be read: refused before the child starts / refused after it, nothing deleted or restored
  if (process.getuid?.() !== 0) {
    const dir = mk(); mkdirSync(join(dir, "data/locked"));
    writeFileSync(join(dir, "data/locked/f"), "f");
    chmodSync(join(dir, "data/locked"), 0o000);
    let ran = false;
    const err = await run(dir, [], async () => { ran = true; }).finally(() => chmodSync(join(dir, "data/locked"), 0o755));
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.equal(ran, false, "the child never started");
    const rows = rowsOf(dir); assert.equal(rows.length, 1); assert.equal(rows[0].status, "snapshot_failed"); assert.match(rows[0].reason, /^listing_failed:/);
    assert.deepEqual(copyFolders(dir), []);
    // the child makes a folder unreadable: it cannot be judged, nothing is deleted, nothing restored
    const dir2 = mk(); mkdirSync(join(dir2, "data/sub")); writeFileSync(join(dir2, "data/sub/f"), "f"); writeFileSync(join(dir2, "maps/old.json"), "old");
    const err2 = await run(dir2, [], async () => { writeFileSync(join(dir2, "data/new.txt"), "n"); rmSync(join(dir2, "maps/old.json")); chmodSync(join(dir2, "data/sub"), 0o000); }).finally(() => chmodSync(join(dir2, "data/sub"), 0o755));
    assert.equal(err2.code, "GROUP_TOOLS_REFUSED");
    const rows2 = rowsOf(dir2); assert.equal(rows2.length, 1); assert.equal(rows2[0].status, "could_not_judge"); assert.match(rows2[0].reason, /^could_not_judge:/);
    assert.ok(existsSync(join(dir2, "data/new.txt")), "nothing was deleted"); assert.ok(!existsSync(join(dir2, "maps/old.json")), "nothing was restored");
    assert.deepEqual(copyFolders(dir2), []);
    check("9n a subfolder unreadable before the call: refused before the child starts (listing_failed); made unreadable by the child: refused as could_not_judge, nothing deleted, nothing restored");
  }
  // 9o. S3: a process that exits in the middle of a call leaves no copy folder
  {
    const dir = mk(); writeFileSync(join(dir, "data/x.csv"), "x");
    const url = pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href;
    const code = `import(${JSON.stringify(url)}).then(async (g) => { await g.runInTool("newsroom_network_reduce", () => g.runDeclared(${JSON.stringify(dir)}, [], async () => { require("fs").writeSync(1, "during:" + require("fs").readdirSync(${JSON.stringify(dir)}).filter((n) => n.startsWith(".group-restore-")).length); process.exit(0); })); });`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, ...ON, NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /during:1/, "the copy folder existed while the call ran");
    assert.deepEqual(copyFolders(dir), [], "the exit hook removed it");
    check("9o a process that calls process.exit() in the middle of a call leaves no copy folder behind");
  }
  // 9p. S5: a socket (never opened, never copied) that the call would have to judge fails closed before the child starts
  {
    const dir = mk(); const net = await import("node:net");
    const cwd = process.cwd(); process.chdir(dir);
    const server = net.createServer(); await new Promise((resolve, reject) => { server.once("error", reject); server.listen("s.sock", resolve); }); process.chdir(cwd);
    let ran = false;
    const err = await run(dir, [], async () => { ran = true; }).finally(() => server.close());
    assert.equal(err.code, "GROUP_TOOLS_REFUSED"); assert.equal(ran, false, "the child never started");
    const rows = rowsOf(dir); assert.equal(rows.length, 1); assert.equal(rows[0].status, "snapshot_failed"); assert.equal(rows[0].reason, "special_file");
    assert.deepEqual(copyFolders(dir), []);
    check("9p a socket in the run folder: refused before the child starts (special_file), never opened or copied, one row");
  }
  // 9q. a rewrite with the same size and a new time is a rewrite (the time is compared in ns); a move followed by a hard link to the moved file: one name back, the other removed
  {
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old"); utimesSync(join(dir, "maps/old.json"), 1700000000, 1700000000);
    const err = await run(dir, [], async () => { writeFileSync(join(dir, "maps/old.json"), "new"); utimesSync(join(dir, "maps/old.json"), 1700000500, 1700000500); });
    assert.equal(err?.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(err.detail.changed, ["maps/old.json"]);
    assert.equal(readFileSync(join(dir, "maps/old.json"), "utf8"), "old");
    const dir2 = mk(); writeFileSync(join(dir2, "data/a.csv"), "A");
    const err2 = await run(dir2, [], async () => { renameSync(join(dir2, "data/a.csv"), join(dir2, "maps/x")); linkSync(join(dir2, "maps/x"), join(dir2, "maps/y")); });
    assert.equal(err2?.code, "GROUP_TOOLS_REFUSED");
    assert.equal(readFileSync(join(dir2, "data/a.csv"), "utf8"), "A"); assert.ok(!existsSync(join(dir2, "maps/x")) && !existsSync(join(dir2, "maps/y")), "both new names are gone");
    check("9q a same-size rewrite with a new time is refused and restored; a moved file with a second (hard link) new name: put back once, the other name removed");
  }
  // 9r. every place the program starts a child process that may run python sets PYTHONDONTWRITEBYTECODE=1 (source text: a missing one would leave __pycache__ in the run folder)
  {
    for (const file of ["process.mjs", "local_backend.mjs", "page_ocr.mjs", "visual_backends.mjs"]) {
      assert.match(readFileSync(join(ROOT, "runtime/pi", file), "utf8"), /PYTHONDONTWRITEBYTECODE\s*:\s*['"]1['"]/, `${file} must pin PYTHONDONTWRITEBYTECODE to 1`);
    }
    check("9r the four child-process spawn points (process, local backend, page OCR, backend probe) each pin PYTHONDONTWRITEBYTECODE");
  }
  // 9h. off: nothing is copied, nothing watched, no row
  {
    clearEnv(); process.env.NEWSROOM_GROUP_TOOLS = "0";
    const dir = mk();
    writeFileSync(join(dir, "maps/old.json"), "old");
    let during = null;
    const out = await g.runDeclared(dir, [`${GR}/out.json`], async () => { during = copyFolders(dir); writeFileSync(join(dir, "maps/old.json"), "new content"); writeFileSync(join(dir, "maps/stray.json"), "x"); return 7; });
    assert.equal(out, 7); assert.deepEqual(during, [], "off: no copy folder");
    assert.equal(readFileSync(join(dir, "maps/old.json"), "utf8"), "new content"); assert.ok(existsSync(join(dir, "maps/stray.json")));
    assert.deepEqual(rowsOf(dir), [], "off: no row");
    check("9h off (NEWSROOM_GROUP_TOOLS=0): no copy, no watch, no row; the child's writes stay");
  }
  clearEnv();
}

for (const name of results) console.log(`  ok  ${name}`);
console.log(`group tools: PASS (${results.length} checks)`);
