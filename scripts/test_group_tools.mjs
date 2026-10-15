#!/usr/bin/env node
// NEWSROOM_GROUP_TOOLS=1 (K213): every tool goes through one wrapper at the registration point, and a tool that starts a child process declares what it
// writes. Checks: the switch (exact value, needs ENFORCE), every tool registered as group.action, off-state tool list unchanged, mutants (wrapper removed,
// a table row deleted or without registered_as, a tool outside its group declaring evidence, a child process writing one more file) all fail closed,
// the fixed E1 lists. Loads type-stripped copies of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "STUB_EXTRA"]) delete process.env[name];
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
  // #64 step 3: the refusal is on by default, so TOOLS=1 needs ENFORCE only to be not "0" (and the hand-off on)
  throwsWith(() => register(base, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "0" }), "GROUP_TOOLS_NEEDS_ENFORCE", 'TOOLS=1 with ENFORCE="0" stops the start-up');
  throwsWith(() => register(base, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_HANDOFF: "0" }), "GROUP_TOOLS_NEEDS_ENFORCE", 'TOOLS=1 with HANDOFF="0" and ENFORCE unset stops the start-up');
  throwsWith(() => register(base, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "0" }), "GROUP_ENFORCE_NEEDS_HANDOFF", "ENFORCE with HANDOFF=0 still stops first (#64 step 1: unset hand-off is on)");
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

  // 7b. an existing file rewritten or removed by a child process: refused, reported as not restored, never rolled back
  const dir = dirFor();
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, `${GR}/old.json`), "old"); writeFileSync(join(dir, `${GR}/gone.json`), "gone");
  writeFileSync(join(dir, "data/ev.csv"), "a,b\n1,2\n");
  const rewrite = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { writeFileSync(join(dir, `${GR}/old.json`), "new content"); })).catch((e) => e);
  assert.equal(rewrite.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(rewrite.detail.changed, [`${GR}/old.json`]); assert.equal(rewrite.detail.restored, false);
  assert.equal(readFileSync(join(dir, `${GR}/old.json`), "utf8"), "new content", "a rewrite is reported, not rolled back");
  const removal = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { rmSync(join(dir, `${GR}/gone.json`)); })).catch((e) => e);
  assert.equal(removal.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(removal.detail.deleted, [`${GR}/gone.json`]); assert.equal(removal.detail.restored, false);
  assert.ok(!existsSync(join(dir, `${GR}/gone.json`)), "a removal is reported, not restored");
  assert.match(removal.message, /removed 1 existing file\(s\).*not restored/); assert.doesNotMatch(removal.message, /NEWSROOM_|GROUP_TOOLS=|ENFORCE/, "the refusal names no switch");
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
  assert.equal(seen.code, "GROUP_TOOLS_REFUSED"); assert.deepEqual(seen.detail.changed, [`${GR}/quiet.json`]); assert.equal(seen.detail.restored, false);
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
  delete process.env.NEWSROOM_GROUP_TOOLS;
  assert.throws(() => g.assertGroupToolsSwitches(), /GROUP_TOOLS_HASH_ALL_NEEDS_TOOLS/);
  process.env.NEWSROOM_GROUP_TOOLS = "1";
  g.assertGroupToolsSwitches();
  delete process.env.NEWSROOM_GROUP_TOOLS_HASH_ALL;
  check("child process: with HASH_ALL=1 (needs TOOLS) a non-evidence file rewritten with other bytes but the same size and time is refused as not restored; any other value, off, a declared output, and a file over the size cap behave as before");
  check("child process: rewriting an existing file (evidence by content hash, others by size/time) or removing one is refused as not restored and never rolled back; a declared output may be rewritten");

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
  clearEnv();
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

for (const name of results) console.log(`  ok  ${name}`);
console.log(`group tools: PASS (${results.length} checks)`);
