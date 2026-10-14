#!/usr/bin/env node
// K315: the K307 cross-call record (NEWSROOM_GROUP_CALL_REPORT, on unless exactly "0"; report only) also sees the exports of other modules and the five `let` functions of newsroom.ts.
// Pinned here: (1) every export listed in groups.json cross_calls.imported / cross_calls.modules is either rebound in its own module's K315 block or listed with a reason in
// cross_calls.report.not_wrapped; nothing else is rebound; the two record names are used only in that block. (2) the five newsroom.ts `let` functions are exactly the functions
// of cross_calls.functions that are not function declarations. (3) off (exactly "0" since #64 step 1; unset and every other value are on): nothing is wrapped, nothing is written, the tool context is unchanged.
// (4) on: a tool reaching a wrapped export is recorded under `module::name` with the same `declared` meaning as for newsroom.ts functions; the reply is unchanged, a failing
// record never reaches the call, a call with no tool asking is not recorded, and the checker reads the same table.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI = join(ROOT, "runtime/pi");
const scratch = makeTestTmp("k315-");
const list = JSON.parse(readFileSync(join(PI, "groups.json"), "utf8"));
const cc = list.cross_calls;
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
process.env.NEWSROOM_GROUP_CALL_CHECK = "0"; // #64 step 2: the call check is on by default; this test is about the call report without it (no requester-none rows, no per-tool fields)
const results = [];
const ok = (text) => results.push(text);

// ---- 1. static pin: the K315 block of every module --------------------------------------------------------------------------------------------
const keys = [...new Set([...Object.keys(cc.imported), ...Object.keys(cc.modules)])].sort();
const wrapped = new Map(); // key -> module
const modulesWithBlock = new Set();
for (const key of keys) modulesWithBlock.add(key.split("::")[0]);
// a module can also carry a block for an export that only newsroom.ts or another module uses and the tables list under another spelling: scan every module with a block
const blockOf = (text) => { const at = text.lastIndexOf("if (crossCallReportEnabled()) {"); if (at < 0) return null; const end = text.indexOf("\n}\n", at); return text.slice(at, end < 0 ? text.length : end + 3); };
for (const module of modulesWithBlock) {
  const text = readFileSync(join(PI, module), "utf8");
  const block = blockOf(text);
  if (!block) continue;
  const lines = block.split("\n").slice(1).filter((l) => l.trim() && l.trim() !== "}");
  for (const line of lines) {
    const m = /^ {2}(\w+) = trackExport\("([\w.]+::\w+)", \1\);$/.exec(line);
    assert.ok(m, `${module}: block line is not a plain rebind: ${line}`);
    assert.equal(m[2], `${module}::${m[1]}`, `${module}: the key names its own module and the function`);
    assert.ok(keys.includes(m[2]), `${m[2]} is rebound but listed in neither cross_calls.imported nor cross_calls.modules`);
    assert.ok(new RegExp(`^export\\s+(?:async\\s+)?(?:function\\*?|let)\\s+${m[1]}\\b`, "m").test(text), `${m[2]} is an exported function declaration or \`export let\``);
    wrapped.set(m[2], module);
  }
  assert.equal((text.match(/\btrackExport\b/g) ?? []).length, lines.length + 1, `${module}: trackExport is used only in its import (groups.mjs: its definition) and in the block`);
  if (module !== "groups.mjs") assert.equal((text.match(/\bcrossCallReportEnabled\b/g) ?? []).length, 2, `${module}: crossCallReportEnabled is used only in the import and the block's condition`);
}
const notWrapped = cc.report.not_wrapped ?? {};
for (const key of keys) {
  const w = wrapped.has(key), n = Object.prototype.hasOwnProperty.call(notWrapped, key);
  assert.ok(w !== n, `${key} is ${w ? "rebound and also listed as not wrapped" : "neither rebound nor listed in cross_calls.report.not_wrapped with a reason"}`);
  if (n) assert.ok(typeof notWrapped[key] === "string" && notWrapped[key].length > 20, `${key}: not_wrapped says why`);
}
for (const key of Object.keys(notWrapped)) assert.ok(keys.includes(key), `not_wrapped lists ${key}, which is in no table (stale)`);
assert.ok(wrapped.size >= 60, `at least 60 exports are rebound (${wrapped.size})`);
// the wrapped modules that were import-free pure modules stay untouched
for (const [key, reason] of Object.entries(notWrapped)) if (/^pure module/.test(reason)) assert.ok(!/groups\.mjs/.test(readFileSync(join(PI, key.split("::")[0]), "utf8").replace(/\/\/.*$/gm, "").match(/^import[^\n]*$/gm)?.join("\n") ?? ""), `${key}: a pure module does not import groups.mjs`);
ok(`${wrapped.size} exports are rebound in ${new Set(wrapped.values()).size} modules, ${Object.keys(notWrapped).length} are listed as not wrapped with a reason, nothing else is rebound`);

// ---- 2. newsroom.ts: the five `let` functions --------------------------------------------------------------------------------------------------
{
  const src = readFileSync(join(PI, "newsroom.ts"), "utf8");
  const at = src.indexOf("// K315 (NEWSROOM_GROUP_CALL_REPORT=1");
  assert.ok(at > 0, "newsroom.ts has the K315 block");
  const block = src.slice(src.indexOf("if (crossCallReportEnabled()) {", at), src.indexOf("\n}\n", at));
  const listed = [...block.matchAll(/^ {2}(\w+) = trackExport\("(\w+)", \1\);$/gm)].map((m) => { assert.equal(m[1], m[2]); return m[1]; });
  const expected = Object.keys(cc.functions).filter((n) => !new RegExp(`^(async\\s+)?function\\*?\\s+${n}\\b`, "m").test(src) && !cc.gated.includes(n));
  assert.deepEqual([...listed].sort(), [...expected].sort(), "the K315 list = the functions of cross_calls.functions that are not function declarations and not gated");
  for (const n of listed) assert.match(src, new RegExp(`^let ${n} = `, "m"), `${n} is declared with let so the block can rebind it`);
  assert.equal(listed.length, 5);
  ok("newsroom.ts: the 5 `let` functions (const before K315) are rebound after their definitions");
}

// ---- 3. off: nothing wrapped, nothing written --------------------------------------------------------------------------------------------------
const groups = await import(pathToFileURL(join(PI, "groups.mjs")).href);
let seq = 0;
const load = async (module, value) => {
  if (value === undefined) delete process.env.NEWSROOM_GROUP_CALL_REPORT; else process.env.NEWSROOM_GROUP_CALL_REPORT = value;
  return import(`${pathToFileURL(join(PI, module)).href}?k315=${++seq}`);
};
const newRun = (name) => { const dir = join(scratch, name); mkdirSync(dir, { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = dir; return dir; };
const reportOf = (dir) => { const p = join(dir, "runtime/cross-call-report.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const toolOf = (group) => Object.keys(list.tools).find((t) => list.tools[t].group === group);
const modulesWrapped = [...new Set(wrapped.values())];
for (const value of ["0"]) {
  delete process.env.NEWSROOM_GROUP_CALL_REPORT; if (value !== undefined) process.env.NEWSROOM_GROUP_CALL_REPORT = value;
  const probe = () => 42;
  assert.equal(groups.trackExport("x.mjs::probe", probe), probe, `value ${JSON.stringify(value)}: trackExport returns the function itself`);
  for (const module of modulesWrapped) {
    const mod = await load(module, value);
    for (const key of [...wrapped.keys()].filter((k) => wrapped.get(k) === module)) {
      const fn = mod[key.split("::")[1]];
      assert.equal(typeof fn, "function", `${key} is still a function`);
      assert.notEqual(fn.name, "tracked", `value ${JSON.stringify(value)}: ${key} is not wrapped`);
    }
  }
  const dir = newRun(`off-${seq}`);
  groups.runInTool(toolOf("visual"), () => (value === undefined ? null : null));
  assert.deepEqual(reportOf(dir), [], "off writes no record");
}
ok('off (exactly "0"): no export is wrapped, trackExport returns the function itself, nothing is written');

// 3b. #64 step 1: unset and every other value is on: trackExport wraps, and an exported function of a wrapped module is rebound
for (const value of [undefined, "1", "", "true", " 0", "00", "false"]) {
  delete process.env.NEWSROOM_GROUP_CALL_REPORT; if (value !== undefined) process.env.NEWSROOM_GROUP_CALL_REPORT = value;
  const probe = () => 42;
  assert.notEqual(groups.trackExport("x.mjs::probe", probe), probe, `value ${JSON.stringify(value)}: trackExport wraps`);
  const mod = await load("evidence_gate.mjs", value);
  assert.equal(mod.isSystemVerifiedClaim.name, "tracked", `value ${JSON.stringify(value)}: the export is wrapped`);
}
ok('default on (unset and every value but exactly "0"): trackExport wraps and the module export is rebound');

// ---- 4. on --------------------------------------------------------------------------------------------------------------------------------------
const evidence = await load("evidence_gate.mjs", "1");
const checker = (target) => spawnSync(process.execPath, [join(ROOT, "scripts/check_cross_call_report.mjs"), target, "--groups", join(PI, "groups.json")], { encoding: "utf8" });
{
  const key = "evidence_gate.mjs::isSystemVerifiedClaim";
  assert.ok(wrapped.has(key) && evidence.isSystemVerifiedClaim.name === "tracked", "evidence_gate's export is wrapped when the switch is on");
  const entry = { owner: cc.imported[key]?.owner ?? cc.modules[key]?.owner, groups: [...new Set([...(cc.imported[key]?.groups ?? []), ...(cc.modules[key]?.groups ?? [])])] };
  assert.equal(entry.owner, "knowledge");
  const declaredGroup = entry.groups[0], knowledgeTool = toolOf("knowledge"), declaredTool = toolOf(declaredGroup);
  const undeclaredGroup = ["agent", "knowledge", "visual", "system"].find((g) => g !== entry.owner && !entry.groups.includes(g));
  const dir = newRun("on-1");
  const plain = evidence.isSystemVerifiedClaim({});
  assert.equal(reportOf(dir).length, 0, "a call with no tool asking is not recorded");
  const reply = groups.runInTool(declaredTool, () => evidence.isSystemVerifiedClaim({}));
  assert.equal(reply, plain, "the reply is the same");
  groups.runInTool(declaredTool, () => evidence.isSystemVerifiedClaim({}));
  groups.runInTool(knowledgeTool, () => evidence.isSystemVerifiedClaim({}));
  let rows = reportOf(dir);
  assert.equal(rows.length, 2, "one line per (tool, function), a repeat is not written again");
  assert.deepEqual(rows[0], { tool: declaredTool, tool_group: declaredGroup, function: key, callee_owner: "knowledge", declared: true });
  assert.equal(rows[1].declared, true, "the owner's own group is declared");
  assert.equal(checker(dir).status, 0, "checker: declared only -> exit 0");
  if (undeclaredGroup) {
    const bad = toolOf(undeclaredGroup);
    groups.runInTool(bad, () => evidence.isSystemVerifiedClaim({}));
    rows = reportOf(dir);
    assert.equal(rows.at(-1).declared, false, `${undeclaredGroup} is not listed for ${key}`);
    const run = checker(dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, new RegExp(`UNDECLARED ${undeclaredGroup} -> ${key.replace(".", "\\.")}`));
  }
  ok("on: a tool reaching an exported function is recorded as module::name with declared = owner group or a listed group; repeat calls not repeated; no tool, no record; the checker agrees");
}
{
  // a module-to-module key (cross_calls.modules) and an imported key both resolve
  const mk = Object.keys(cc.modules).find((k) => wrapped.has(k) && !cc.imported[k]);
  assert.ok(mk, "a wrapped export is reached only through cross_calls.modules");
  const [module, name] = mk.split("::");
  const mod = await load(module, "1");
  const dir = newRun("on-2");
  const e = cc.modules[mk];
  const tool = toolOf(e.groups[0]);
  try { groups.runInTool(tool, () => mod[name]()); } catch { /* the call may throw on empty arguments: the record is what matters */ }
  const rows = reportOf(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].declared, true, "a group that imports it through cross_calls.modules is declared");
  assert.equal(rows[0].callee_owner, e.owner);
  ok(`on: a modules-only key (${mk}) is recorded with the owner from cross_calls.modules`);
}
{
  // a failing record write never reaches the call; the record's own lookups are not recorded
  const blocker = join(scratch, "blocker"); writeFileSync(blocker, "x");
  process.env.NEWSROOM_ARTIFACT_DIR = join(blocker, "inside");
  const reply = groups.runInTool(toolOf("visual"), () => evidence.isSystemVerifiedClaim({}));
  assert.equal(reply, evidence.isSystemVerifiedClaim({}), "the call still returns its reply when the record cannot be written");
  const dir = newRun("on-3");
  const writer = Object.keys(list.handoffs.writers)[0];
  const ranFn = groups.runInTool(toolOf("agent"), () => groups.asHandoffWriter(writer, () => "ran"));
  assert.equal(ranFn, "ran", "a wrapped groups.mjs export runs its function (the record does not recurse into itself)");
  assert.ok(reportOf(dir).length <= 1, "the lookups inside the record add no lines of their own");
  ok("on: a failing record write never reaches the call; a wrapped groups.mjs export does not recurse into the record");
}

{
  // the checker reads a modules-only key from cross_calls.modules (a hand-written record file, so no run is needed)
  const mk = Object.keys(cc.modules).find((k) => !cc.imported[k]);
  const e = cc.modules[mk];
  const goodTool = toolOf(e.groups[0]);
  const badGroup = ["agent", "knowledge", "visual", "system"].find((g) => g !== e.owner && !e.groups.includes(g));
  const line = (tool, fn) => JSON.stringify({ tool, tool_group: list.tools[tool].group, function: fn, callee_owner: e.owner, declared: true }) + "\n";
  const good = join(scratch, "chk-good.jsonl"); writeFileSync(good, line(goodTool, mk));
  assert.equal(checker(good).status, 0, "a group listed in cross_calls.modules is declared for the checker");
  if (badGroup) { const bad = join(scratch, "chk-bad.jsonl"); writeFileSync(bad, line(toolOf(badGroup), mk)); assert.equal(checker(bad).status, 1, "an unlisted group is undeclared"); }
  const unknown = join(scratch, "chk-unknown.jsonl"); writeFileSync(unknown, line(goodTool, "nowhere.mjs::nothing"));
  assert.equal(checker(unknown).status, 1, "an unknown module key is undeclared");
  ok(`the checker reads a modules-only key (${mk}): listed group exit 0, unlisted group and unknown key exit 1`);
}

rmSync(scratch, { recursive: true, force: true });
console.log(results.map((r) => `ok - ${r}`).join("\n"));
