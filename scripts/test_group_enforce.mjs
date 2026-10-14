#!/usr/bin/env node
// NEWSROOM_GROUP_ENFORCE=1 (K211): a write made by a tool outside the owning group is refused before it reaches the disk. A write nobody owns (待查)
// is refused too, and so is a check that fails (fail-closed). The hand-offs (knowledge_writer, decision_writer, shadow_writer, agent_record_writer)
// are not refused. Off (anything but the exact value 1) nothing changes. Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
// Usage: node scripts/test_group_enforce.mjs   (PRINT_OFF_DIGEST=1 only prints the off-state file digest and exits; used to pin it on the base commit)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = process.env.ENFORCE_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("group-enforce-");
const results = [];
const check = (name) => results.push(name);
const clearEnv = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name]; };
clearEnv();
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN", "NEWSROOM_HIDE_LIEFLAT", "NEWSROOM_SHADOW_CHECKS"]) delete process.env[name];

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
const sha = (value) => createHash("sha256").update(value).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const urlOf = (path) => pathToFileURL(path).href;

let treeSeq = 0;
async function loadTree(rootDir) {
  const tree = join(scratch, `tree-${++treeSeq}`);
  cpSync(join(rootDir, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(rootDir, "config"), join(tree, "config"), { recursive: true });
  stub(tree, "typebox", TYPEBOX);
  stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  writeFileSync(join(tree, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return {
    tree,
    mod: await import(urlOf(join(tree, "runtime/pi/newsroom.test-copy.mjs"))),
    groups: await import(urlOf(join(tree, "runtime/pi/groups.mjs"))),
    shadow: await import(urlOf(join(tree, "runtime/pi/shadow.mjs"))),
  };
}

let dirSeq = 0;
const freshDir = () => { const dir = join(scratch, `art-${++dirSeq}`); mkdirSync(dir, { recursive: true }); return dir; };
const treeDigest = (dir) => sha(walk(dir).map((f) => `${relative(dir, f)}:${sha(readFileSync(f))}`).sort().join("\n"));

// ---- the off-state digest: the same writes, every opt-in switch unset and the two default-on switches (HANDOFF, CALL_REPORT) set to "0", must leave the same files as the base commit (89e591e) ----
async function offDigest(loaded, enforceValue) {
  clearEnv();
  process.env.NEWSROOM_GROUP_HANDOFF = "0";
  process.env.NEWSROOM_GROUP_CALL_REPORT = "0";
  if (enforceValue !== undefined) process.env.NEWSROOM_GROUP_ENFORCE = enforceValue;
  const dir = freshDir();
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  const { mod, groups, shadow } = loaded;
  await groups.runInTool("newsroom_viz_lint", () => mod.__writeArtifactIfAbsentForTest("computations/x.json", { a: 1 }));
  await groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactIfAbsentForTest("computations/y.json", { a: 2 }));
  await groups.runInTool("newsroom_infographic_vision_critic", () => mod.__saveDecisionForTest("infographics/vision-critics/k.json", { passed: true, score: 80 }));
  await groups.runInTool("newsroom_viz_render", () => mod.__saveQueryRowsForTest("runtime/query-rows/abc.json", [{ a: 1 }]));
  await groups.runInTool("newsroom_infographic_lint", () => shadow.writeShadowRecord(dir, "prose_numbers", { k: 1 }, { v: 1 }));
  await mod.__writeArtifactIfAbsentForTest("plan2.json", { p: 1 });
  return treeDigest(dir);
}
const loadedNew = await loadTree(ROOT);
const digestNew = await offDigest(loadedNew);
if (process.env.PRINT_OFF_DIGEST === "1") { console.log(digestNew); process.exit(0); }
const OFF_DIGEST_AT_BASE = "e5cf8e7418e13b6c43057d7a6ecb06d7fd31460145cd235400fc38bb650e3588";
assert.equal(digestNew, OFF_DIGEST_AT_BASE, "off: the files left by the same writes are byte-identical to the base commit");
for (const value of ["0", "", "yes", " 1", "on", "true", "11"]) assert.equal(await offDigest(loadedNew, value), OFF_DIGEST_AT_BASE, `off: ENFORCE=${JSON.stringify(value)} behaves as unset`);
check("off: unset and every near-miss value (0, empty, yes, ' 1', on, true, 11) leave byte-identical files to the base commit, and no refusal log");

// ---- A. the decision itself, checked on any copy of groups.mjs (the real one and the mutated ones) ---------------------------------------------------
const leaks = (text) => /NEWSROOM_/.test(text) || /开关|\b(switch|set|unset|disable|disabled)\b/i.test(text); // tool names are lower-case newsroom_*, switch names upper-case
function probe(g) {
  clearEnv();
  const bad = [];
  const dir = freshDir();
  process.env.NEWSROOM_GROUP_ENFORCE = "1";
  const refuse = (name, fn) => {
    try { fn(); bad.push(`${name}: not refused`); return null; } catch (error) {
      if (error?.code !== "BOUNDARY_REFUSED" || error?.name !== "BoundaryRefusal") { bad.push(`${name}: not a BoundaryRefusal (${error?.message})`); return null; }
      return String(error.message);
    }
  };
  const allow = (name, fn) => { try { fn(); } catch (error) { bad.push(`${name}: refused though it is the owner's write (${error?.message})`); } };
  const write = (tool, path, root = dir) => g.runInTool(tool, () => g.recordBoundaryWrite(root, path, "write_if_absent"));
  const wants = (name, text, parts) => { for (const part of parts) if (!String(text).includes(part)) bad.push(`${name}: the refusal does not name ${JSON.stringify(part)}: ${text}`); if (leaks(String(text))) bad.push(`${name}: the refusal leaks a switch or a way round: ${text}`); };

  // owner's own write and a group writer's write pass
  allow("owner", () => write("duckdb_query", "computations/x.json"));
  allow("knowledge writer", () => g.runInTool("newsroom_viz_lint", () => g.asHandoffWriter("knowledge_writer", () => g.recordBoundaryWrite(dir, "computations/x.json", "write_if_absent"))));
  allow("decision writer", () => g.runInTool("newsroom_infographic_vision_critic", () => g.asHandoffWriter("decision_writer", () => g.recordBoundaryWrite(dir, "infographics/vision-critics/k.json", "write_if_absent"))));
  allow("visual spec by a visual tool", () => write("newsroom_viz_plan", "visualizations/v.json"));

  // 1. a visual tool writing a knowledge path
  wants("cross-group", refuse("cross-group", () => write("newsroom_viz_plan", "computations/x.json")), ["newsroom_viz_plan", "visual", "computations/x.json", "evidence", "knowledge", "knowledge_writer"]);
  // 4. 待查: no kind, unknown tool, no tool
  wants("待查 path", refuse("待查 path", () => write("newsroom_viz_plan", "nowhere/x.json")), ["newsroom_viz_plan", "visual", "nowhere/x.json", "owner none"]);
  wants("待查 tool", refuse("待查 tool", () => write("tool_that_is_not_listed", "computations/x.json")), ["tool_that_is_not_listed", "computations/x.json"]);
  wants("待查 no tool", refuse("待查 no tool", () => g.recordBoundaryWrite(dir, "plan.json", "write")), ["plan.json", "unknown tool"]);
  // an agent tool may not write the evidence either, and a knowledge tool may not write the decision
  wants("agent tool", refuse("agent tool", () => write("newsroom_update_plan", "claims.jsonl")), ["newsroom_update_plan", "agent", "claims.jsonl", "knowledge_writer"]);
  wants("decision", refuse("decision", () => write("newsroom_viz_plan", "infographics/vision-critics/k.json")), ["newsroom_viz_plan", "infographics/vision-critics/k.json", "agent", "decision_writer"]);
  wants("shadow", refuse("shadow", () => write("newsroom_infographic_lint", "shadow/prose_numbers-1.json")), ["newsroom_infographic_lint", "shadow/prose_numbers-1.json", "observation", "knowledge", "shadow_writer"]);
  wants("run record", refuse("run record", () => write("newsroom_visual_concepts", "runtime/tool-chain-events.jsonl")), ["newsroom_visual_concepts", "runtime/tool-chain-events.jsonl", "agent", "agent_record_writer"]);

  // 1b. fail-closed, each on a write the owner is entitled to, so only a failure of the check itself can make it refuse
  let restore = g.__setEnforceHooksForTest({ groups: () => { throw new Error("cannot read the group list"); } });
  wants("table read fails", refuse("table read fails", () => write("duckdb_query", "computations/x.json")), ["computations/x.json", "unknown"]);
  restore();
  restore = g.__setEnforceHooksForTest({ groups: () => ({ nothing: true }) });
  refuse("table without tools", () => write("duckdb_query", "computations/x.json"));
  restore();
  restore = g.__setEnforceHooksForTest({ decide: () => { throw new Error("the check itself failed"); } });
  wants("check throws", refuse("check throws", () => write("duckdb_query", "computations/x.json")), ["computations/x.json", "unknown"]);
  restore();
  let clock = 0;
  restore = g.__setEnforceHooksForTest({ now: () => (clock += 10_000) });
  wants("check too slow", refuse("check too slow", () => write("duckdb_query", "computations/x.json")), ["computations/x.json", "unknown"]);
  restore();
  restore = g.__setEnforceHooksForTest({ classify: () => { throw new Error("classifier broke"); } });
  refuse("classifier throws", () => write("duckdb_query", "computations/x.json"));
  restore();
  refuse("no artifact root", () => write("duckdb_query", "computations/x.json", ""));
  allow("recovered", () => write("duckdb_query", "computations/x.json"));

  // the refusal log
  const log = existsSync(join(dir, g.REFUSAL_LOG_PATH)) ? readFileSync(join(dir, g.REFUSAL_LOG_PATH), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const statuses = new Set(log.map((entry) => entry.status));
  for (const status of ["cross_group", "待查", "check_failed"]) if (!statuses.has(status)) bad.push(`the refusal log has no ${status} entry`);
  if (log.some((entry) => /NEWSROOM_/.test(JSON.stringify(entry)))) bad.push("the refusal log names a switch");

  // 3. the report still tags the vision critic's record as the model's quality verdict after the hand-off, and keeps it out of ok
  clearEnv();
  process.env.NEWSROOM_GROUP_BOUNDARY = "1";
  process.env.NEWSROOM_GROUP_ENFORCE = "1";
  const rdir = freshDir();
  g.resetBoundaryReport();
  g.runInTool("newsroom_infographic_vision_critic", () => g.asHandoffWriter("decision_writer", () => g.recordBoundaryWrite(rdir, "infographics/vision-critics/k.json", "write_if_absent")));
  g.runInTool("newsroom_viz_lint", () => g.asHandoffWriter("knowledge_writer", () => g.recordBoundaryWrite(rdir, "computations/x.json", "write_if_absent")));
  const report = JSON.parse(readFileSync(join(rdir, g.BOUNDARY_REPORT_PATH), "utf8"));
  const verdict = report.records.find((r) => r.requested_by === "newsroom_infographic_vision_critic");
  if (verdict?.status !== "model_quality_verdict" || verdict?.tool !== "decision_writer") bad.push(`the handed-over vision critic record is not listed as model_quality_verdict: ${JSON.stringify(verdict)}`);
  if (report.totals.model_quality_verdict !== 1 || report.totals.ok !== 1) bad.push(`totals: the critic record must be counted apart, not as ok: ${JSON.stringify(report.totals)}`);
  g.resetBoundaryReport();
  clearEnv();
  return bad;
}
assert.deepEqual(probe(loadedNew.groups), [], "the real decision passes every check");
check("refuses a cross-group write, a 待查 path, an unlisted tool and a missing tool; lets the owner and the group writers through");
check("fail-closed: a group list that cannot be read, a group list without tools, a check that throws, a classifier that throws, a check past the hard limit and a missing root all refuse");
check("every refusal names the tool, its group, the path, the kind, the owning group and the writer, and never a switch, 'set', 'unset' or 'disable'");
check("the refusal log has a cross_group, a 待查 and a check_failed entry, and no switch name");
check("a handed-over vision critic record stays model_quality_verdict (listed apart, never ok)");

// mutations of groups.mjs: each variant must make the same checks fail
const groupsSource = readFileSync(join(loadedNew.tree, "runtime/pi/groups.mjs"), "utf8");
const MUTANTS = {
  "the catch lets the write through": ['    info.status = "check_failed";\n  }\n  if (root) noteRefusal', '    return;\n  }\n  if (root) noteRefusal'],
  "待查 counts as allowed": ["    if (verdict.allowed === true) return;", '    if (verdict.allowed === true || verdict.status === "待查") return;'],
  "nothing is refused": ["    if (verdict.allowed === true) return;", "    return;"],
  "the refusal text names a switch": ['Use ${writer || "no writer: the path has no owning group yet"}.`', 'Use ${writer || "no writer: the path has no owning group yet"}. Unset NEWSROOM_GROUP_ENFORCE to skip.`'],
  "the hard limit is gone": ['    if (!(hooks.now() - started <= ENFORCE_LIMIT_MS)) throw new Error("check too slow");\n', ""],
  "the verdict tag is dropped after a hand-off": ['(status === "cross_group" || status === "ok") && classified?.kind === "pass_decision" && list.tools?.[requester]?.model_quality_verdict', 'status === "cross_group" && classified?.kind === "pass_decision" && list.tools?.[requester]?.model_quality_verdict'],
};
let mutantSeq = 0;
for (const [name, [from, to]] of Object.entries(MUTANTS)) {
  assert.equal(groupsSource.split(from).length - 1, 1, `mutant "${name}" does not apply to groups.mjs`);
  const file = join(loadedNew.tree, "runtime/pi", `groups.mutant${++mutantSeq}.mjs`);
  writeFileSync(file, groupsSource.replace(from, to));
  const problems = probe(await import(urlOf(file)));
  assert.ok(problems.length > 0, `mutant "${name}" stays green`);
}
check(`${Object.keys(MUTANTS).length} mutants of the decision (catch lets through, 待查 allowed, nothing refused, switch name in the text, no hard limit, verdict tag dropped) each turn the checks red`);

// a group list that is really missing from the disk (no hook): the owner's own write is refused
{
  const lone = join(scratch, "no-group-list");
  mkdirSync(lone, { recursive: true });
  writeFileSync(join(lone, "groups.mjs"), groupsSource);
  const g = await import(urlOf(join(lone, "groups.mjs")));
  clearEnv();
  process.env.NEWSROOM_GROUP_ENFORCE = "1";
  assert.throws(() => g.runInTool("duckdb_query", () => g.recordBoundaryWrite(freshDir(), "computations/x.json", "write")), (e) => e.code === "BOUNDARY_REFUSED" && !/NEWSROOM_/.test(e.message));
  clearEnv();
}
check("a groups.json that is missing from the disk refuses the owner's own write");

// ---- B. through newsroom.ts -------------------------------------------------------------------------------------------------------------------------
const { mod, groups, shadow, tree } = loadedNew;
const BASE_ENV = { NEWSROOM_HERO_VALUE_GATE: "0", NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1" };
function register(env = {}) {
  clearEnv();
  Object.assign(process.env, BASE_ENV, env);
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
function artifactDir(env) {
  const dir = freshDir();
  clearEnv();
  Object.assign(process.env, BASE_ENV, env, { NEWSROOM_ARTIFACT_DIR: dir });
  groups.resetBoundaryReport();
  return dir;
}
const rejects = async (fn) => { try { await fn(); } catch (error) { return error; } assert.fail("expected a refusal"); };

// 2. enforce needs the hand-off
// #64 step 1: the hand-off is on unless exactly "0", so ENFORCE alone starts; only HANDOFF=0 with ENFORCE=1 stops
assert.throws(() => register({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "0" }), /GROUP_ENFORCE_NEEDS_HANDOFF/);
assert.doesNotThrow(() => register({ NEWSROOM_GROUP_ENFORCE: "1" }), "ENFORCE with the hand-off unset: the default is on");
for (const value of ["", "yes", " 0", "00", "false", "true"]) assert.doesNotThrow(() => register({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: value }), `HANDOFF=${JSON.stringify(value)} is not the exact "0"`);
assert.doesNotThrow(() => register({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1" }));
for (const value of ["0", "", "yes", " 1", "on"]) assert.doesNotThrow(() => register({ NEWSROOM_GROUP_ENFORCE: value }), `ENFORCE=${JSON.stringify(value)} is off`);
check("start-up: ENFORCE with HANDOFF=0 stops with an error; with the hand-off unset (the default) or any other value, the extension registers");

// every registered tool has the initiating-tool context when only ENFORCE is on (no BOUNDARY report)
{
  const dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1" });
  const tools = register({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_ARTIFACT_DIR: dir });
  assert.ok(tools.size > 10, "tools are registered");
  assert.ok(!existsSync(join(dir, groups.BOUNDARY_REPORT_PATH)), "ENFORCE alone writes no report");
}
check("ENFORCE alone wraps the tools' context and writes no boundary report");

// refused writes leave nothing on the disk
{
  const dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_CALL_REPORT: "0" });
  const error = await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactIfAbsentForTest("computations/x.json", { a: 1 })));
  assert.equal(error.code, "BOUNDARY_REFUSED");
  assert.match(error.message, /newsroom_viz_plan.*computations\/x\.json.*knowledge/);
  await rejects(() => mod.__writeArtifactIfAbsentForTest("plan2.json", {}));                                            // no initiating tool: 待查
  await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactIfAbsentForTest("nowhere/z.json", {}))); // no kind: 待查
  await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactBytesIfAbsentForTest("data/b.bin", new Uint8Array([1]))));
  assert.deepEqual(walk(dir).map((f) => relative(dir, f)).filter((f) => !f.startsWith("runtime/boundary-refusals")), [], "nothing was written");
  assert.ok(existsSync(join(dir, groups.REFUSAL_LOG_PATH)), "the refusals are logged");
}
check("a refused write leaves no file on the disk (immutable write, bytes write, no tool, unclassified path) and is logged");

// the hand-offs pass
{
  const dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_BOUNDARY: "1" });
  await groups.runInTool("newsroom_viz_lint", () => mod.__writeArtifactIfAbsentForTest("computations/x.json", { a: 1 })).then(() => assert.fail("a direct write must be refused"), (e) => assert.equal(e.code, "BOUNDARY_REFUSED"));
  // K214 part B: the knowledge writer takes a query-rows table only when the computation record of the same name has those rows
  const { hashRows } = await import(urlOf(join(ROOT, "runtime/pi/viz.mjs")));
  mkdirSync(join(dir, "computations"), { recursive: true });
  writeFileSync(join(dir, "computations/abc.json"), JSON.stringify({ rows: [{ a: 1 }], result_hash: hashRows([{ a: 1 }]) }));
  await groups.runInTool("newsroom_viz_render", () => mod.__saveQueryRowsForTest("runtime/query-rows/abc.json", [{ a: 1 }]));
  await groups.runInTool("newsroom_infographic_vision_critic", () => mod.__saveDecisionForTest("infographics/vision-critics/k.json", { passed: false, score: 12 }));
  const rejectionRef = `infographics/plan-rejections/${"a".repeat(64)}.json`;
  await groups.runInTool("newsroom_infographic_plan", () => mod.__saveRejectionForTest(rejectionRef, { schema_version: "0.1.0", kind: "rejected_call", tool: "newsroom_infographic_plan", params: {} }));
  await groups.runInTool("newsroom_visual_concepts", () => mod.__saveChainEventForTest({ type: "setup_input_form" }));
  await groups.runInTool("newsroom_infographic_chain", () => mod.__saveChainEventForTest({ type: "tool_execution_start" }));
  for (const f of ["runtime/query-rows/abc.json", "infographics/vision-critics/k.json", rejectionRef]) assert.ok(existsSync(join(dir, f)), `${f} was written through its group's writer`);
  assert.equal(readFileSync(join(dir, "runtime/tool-chain-events.jsonl"), "utf8").trim().split("\n").length, 2);
  const report = JSON.parse(readFileSync(join(dir, groups.BOUNDARY_REPORT_PATH), "utf8"));
  const by = (requested) => report.records.find((r) => r.requested_by === requested);
  assert.deepEqual([by("newsroom_infographic_plan").tool, by("newsroom_infographic_plan").status], ["agent_record_writer", "ok"]);
  assert.deepEqual([by("newsroom_visual_concepts").tool, by("newsroom_visual_concepts").status], ["agent_record_writer", "ok"]);
  assert.deepEqual([by("newsroom_infographic_vision_critic").tool, by("newsroom_infographic_vision_critic").status], ["decision_writer", "model_quality_verdict"]);
  assert.equal(report.totals.cross_group, 0, "no cross-group write is left");
  assert.equal(report.totals.to_check, 0);
  // the same helpers without the hand-off: the writes are cross-group and refused
  const dir2 = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "0", NEWSROOM_GROUP_CALL_REPORT: "0" });
  for (const [tool, run] of [
    ["newsroom_infographic_plan", () => mod.__saveRejectionForTest("infographics/plan-rejections/x.json", {})],
    ["newsroom_visual_concepts", () => mod.__saveChainEventForTest({ type: "x" })],
    ["newsroom_infographic_vision_critic", () => mod.__saveDecisionForTest("infographics/vision-critics/k.json", {})],
  ]) await rejects(() => groups.runInTool(tool, run));
  assert.deepEqual(walk(dir2).map((f) => relative(dir2, f)).filter((f) => !f.includes("boundary-refusals")), []);
}
check("with the hand-off the plan-rejection, tool-chain-event, vision-critic, query-rows records are written by their group's writer (requested_by kept; the critic stays model_quality_verdict; 0 cross-group, 0 待查); without it the same writes are refused");

// 6b. shadow: written by shadow_writer under the hand-off; cross-group without it; removing the wrapper is caught
async function shadowChecks(shadowModule) {
  const bad = [];
  const writeOne = (dir) => groups.runInTool("newsroom_infographic_lint", () => shadowModule.writeShadowRecord(dir, "prose_numbers", { k: 1 }, { v: 1 }));
  let dir = artifactDir({ NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_ENFORCE: "1" });
  try {
    const path = await writeOne(dir);
    if (!existsSync(join(dir, path))) bad.push("hand-off on: the shadow file was not written");
  } catch (error) { bad.push(`hand-off on: the shadow write was refused (${error?.code})`); }
  const rec = existsSync(join(dir, groups.BOUNDARY_REPORT_PATH)) ? JSON.parse(readFileSync(join(dir, groups.BOUNDARY_REPORT_PATH), "utf8")).records.find((r) => r.kind === "observation") : undefined;
  if (![rec?.tool, rec?.tool_group, rec?.status, rec?.requested_by].every((v, i) => v === ["shadow_writer", "knowledge", "ok", "newsroom_infographic_lint"][i])) bad.push(`hand-off on: ${JSON.stringify(rec)}`);
  dir = artifactDir({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "0" });
  await writeOne(dir);
  const rec2 = JSON.parse(readFileSync(join(dir, groups.BOUNDARY_REPORT_PATH), "utf8")).records.find((r) => r.kind === "observation");
  if (rec2?.status !== "cross_group" || rec2?.tool !== "newsroom_infographic_lint") bad.push(`hand-off off: expected cross_group, got ${JSON.stringify(rec2)}`);
  dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "0" });
  let refused = false;
  try { await writeOne(dir); } catch (error) { refused = error?.code === "BOUNDARY_REFUSED"; }
  if (!refused || walk(dir).some((f) => f.includes("shadow"))) bad.push("hand-off off + enforce: the shadow write was not refused cleanly");
  return bad;
}
assert.deepEqual(await shadowChecks(shadow), []);
const shadowSource = readFileSync(join(tree, "runtime/pi/shadow.mjs"), "utf8");
const unwrapped = "  return asShadowWriter(() => saveShadowRecord(root, kind, keyInputs, record));";
assert.equal(shadowSource.split(unwrapped).length - 1, 1, "the shadow_writer wrapper is where the mutant expects it");
writeFileSync(join(tree, "runtime/pi/shadow.mutant.mjs"), shadowSource.replace(unwrapped, "  return saveShadowRecord(root, kind, keyInputs, record);"));
assert.ok((await shadowChecks(await import(urlOf(join(tree, "runtime/pi/shadow.mutant.mjs"))))).length > 0, "without the shadow_writer wrapper the checks must turn red");
check("shadow: hand-off on -> shadow_writer, knowledge, ok, requested_by kept; hand-off off -> cross_group (not 待查) and refused under enforce; dropping the wrapper turns the check red");

clearEnv();
console.log(`group enforce: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
