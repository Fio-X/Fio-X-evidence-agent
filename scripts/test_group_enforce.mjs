#!/usr/bin/env node
// NEWSROOM_GROUP_ENFORCE=1 (K211): a write made by a tool outside the owning group is refused before it reaches the disk. A write nobody owns (待查)
// is refused too, and so is a check that fails (fail-closed). The hand-offs (knowledge_writer, decision_writer, shadow_writer, agent_record_writer)
// are not refused (the hand-off and the call report are always on; a leftover NEWSROOM_GROUP_HANDOFF or NEWSROOM_GROUP_CALL_REPORT value is ignored). Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
// Usage: node scripts/test_group_enforce.mjs
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
const clearEnv = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name]; process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; /* the off-table call refusal is on by default; this test is about something else, so both are pinned off */ };
clearEnv();
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN"]) delete process.env[name];

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

const loadedNew = await loadTree(ROOT);

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
  "the refusal text names a switch": ["continue with your own group's tools.`", "continue with your own group's tools. Unset NEWSROOM_GROUP_ENFORCE to skip.`"],
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

// 2. the hand-off switch is removed: a leftover NEWSROOM_GROUP_HANDOFF value, "0" included, is ignored. It neither stops start-up nor turns the refusal off.
for (const value of [undefined, "0", "", "yes", " 0", "00", "false", "true", "1"]) assert.doesNotThrow(() => register({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: value }), `ENFORCE=1 with HANDOFF=${JSON.stringify(value)} starts`);
for (const value of ["0", "", "yes", " 1", "on"]) assert.doesNotThrow(() => register({ NEWSROOM_GROUP_ENFORCE: value }), `ENFORCE=${JSON.stringify(value)} registers`);
{
  // a leftover HANDOFF=0 with ENFORCE unset still refuses a direct write by a tool outside the owning group, and the hand-off still writes
  const dir = artifactDir({ NEWSROOM_GROUP_HANDOFF: "0" });
  assert.equal(groups.groupEnforceEnabled(), true, "a leftover HANDOFF=0 does not turn the refusal off");
  const error = await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactIfAbsentForTest("computations/x.json", { a: 1 })));
  assert.equal(error.code, "BOUNDARY_REFUSED");
  await groups.runInTool("newsroom_infographic_vision_critic", () => mod.__saveDecisionForTest("infographics/vision-critics/k.json", { passed: true, score: 80 }));
  assert.ok(existsSync(join(dir, "infographics/vision-critics/k.json")), "the hand-off still writes the record with a leftover HANDOFF=0");
  // the other hand-offs too: a query-rows table, a refused-call record and a chain event are each written by the group writer, not by the asking tool (which the refusal would stop)
  const { hashRows } = await import(urlOf(join(ROOT, "runtime/pi/viz.mjs")));
  mkdirSync(join(dir, "computations"), { recursive: true });
  writeFileSync(join(dir, "computations/abc.json"), JSON.stringify({ rows: [{ a: 1 }], result_hash: hashRows([{ a: 1 }]) }));
  await groups.runInTool("newsroom_viz_render", () => mod.__saveQueryRowsForTest("runtime/query-rows/abc.json", [{ a: 1 }]));
  assert.ok(existsSync(join(dir, "runtime/query-rows/abc.json")), "the query-rows table is still handed to the knowledge writer with a leftover HANDOFF=0");
  const rejectionRef = `infographics/plan-rejections/${"b".repeat(64)}.json`;
  await groups.runInTool("newsroom_infographic_plan", () => mod.__saveRejectionForTest(rejectionRef, { schema_version: "0.1.0", kind: "rejected_call", tool: "newsroom_infographic_plan", params: {} }));
  assert.ok(existsSync(join(dir, rejectionRef)), "the refused-call record is still handed to the agent writer with a leftover HANDOFF=0");
  await groups.runInTool("newsroom_visual_concepts", () => mod.__saveChainEventForTest({ type: "tool_execution_start" }));
  assert.ok(existsSync(join(dir, "runtime/tool-chain-events.jsonl")), "the chain event is still handed to the agent writer with a leftover HANDOFF=0");
}
check("a leftover HANDOFF=0 is ignored: the extension starts with ENFORCE=1, the refusal stays on, the hand-off still writes");

// every registered tool has the initiating-tool context when only ENFORCE is on (no BOUNDARY report)
{
  const dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1" });
  const tools = register({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_ARTIFACT_DIR: dir });
  assert.ok(tools.size > 10, "tools are registered");
  assert.ok(!existsSync(join(dir, groups.BOUNDARY_REPORT_PATH)), "ENFORCE alone writes no report");
}
check("ENFORCE alone wraps the tools' context and writes no boundary report");

// refused writes leave nothing on the disk
{
  const dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1" });
  const error = await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactIfAbsentForTest("computations/x.json", { a: 1 })));
  assert.equal(error.code, "BOUNDARY_REFUSED");
  assert.match(error.message, /newsroom_viz_plan.*computations\/x\.json.*knowledge/);
  await rejects(() => mod.__writeArtifactIfAbsentForTest("plan2.json", {}));                                            // no initiating tool: 待查
  await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactIfAbsentForTest("nowhere/z.json", {}))); // no kind: 待查
  await rejects(() => groups.runInTool("newsroom_viz_plan", () => mod.__writeArtifactBytesIfAbsentForTest("data/b.bin", new Uint8Array([1]))));
  // the call report is always written (no switch turns it off): it is the only file a refused write leaves, and its rows are exactly the calls made up to the refusal
  const REPORT_ROWS = "runtime/cross-call-report.jsonl";
  assert.deepEqual(walk(dir).map((f) => relative(dir, f)).filter((f) => !f.startsWith("runtime/boundary-refusals")), [REPORT_ROWS], "nothing was written but the call report");
  const rows = readFileSync(join(dir, REPORT_ROWS), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const viz = { tool: "newsroom_viz_plan", tool_group: "visual" }, none = { tool: null, tool_group: null, requester: "none" };
  assert.deepEqual(rows, [
    { ...viz, function: "writeArtifactIfAbsent", callee_owner: null, declared: true },
    { ...viz, function: "artifactRoot", callee_owner: null, declared: true },
    { ...viz, function: "groups.mjs::recordBoundaryWrite", callee_owner: "system", declared: true },
    { ...none, function: "writeArtifactIfAbsent", callee_owner: null, declared: null },
    { ...none, function: "artifactRoot", callee_owner: null, declared: null },
    { ...none, function: "groups.mjs::recordBoundaryWrite", callee_owner: "system", declared: null },
  ], "the call report holds exactly the calls up to the refusals");
  for (const refused of ["computations/x.json", "plan2.json", "nowhere/z.json", "data/b.bin"]) assert.ok(!JSON.stringify(rows).includes(refused), `no report row names the refused path ${refused}`);
  assert.ok(existsSync(join(dir, groups.REFUSAL_LOG_PATH)), "the refusals are logged");
}
check("a refused write leaves no file on the disk but the call report with its exact rows (immutable write, bytes write, no tool, unclassified path) and is logged");

// the hand-offs pass
{
  const dir = artifactDir({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_BOUNDARY: "1" });
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
}
check("the plan-rejection, tool-chain-event, vision-critic, query-rows records are written by their group's writer (requested_by kept; the critic stays model_quality_verdict; 0 cross-group, 0 待查)");

// 6b. shadow: written by shadow_writer; removing the wrapper is caught
async function shadowChecks(shadowModule, handoff = "1") {
  const bad = [];
  const writeOne = (dir) => groups.runInTool("newsroom_infographic_lint", () => shadowModule.writeShadowRecord(dir, "prose_numbers", { k: 1 }, { v: 1 }));
  let dir = artifactDir({ NEWSROOM_GROUP_HANDOFF: handoff, NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_ENFORCE: "1" });
  try {
    const path = await writeOne(dir);
    if (!existsSync(join(dir, path))) bad.push("the shadow file was not written");
  } catch (error) { bad.push(`the shadow write was refused (${error?.code})`); }
  const rec = existsSync(join(dir, groups.BOUNDARY_REPORT_PATH)) ? JSON.parse(readFileSync(join(dir, groups.BOUNDARY_REPORT_PATH), "utf8")).records.find((r) => r.kind === "observation") : undefined;
  if (![rec?.tool, rec?.tool_group, rec?.status, rec?.requested_by].every((v, i) => v === ["shadow_writer", "knowledge", "ok", "newsroom_infographic_lint"][i])) bad.push(`${JSON.stringify(rec)}`);
  return bad;
}
assert.deepEqual(await shadowChecks(shadow), []);
assert.deepEqual(await shadowChecks(shadow, "0"), [], "a leftover HANDOFF=0: the shadow record is still written by the shadow writer");
const shadowSource = readFileSync(join(tree, "runtime/pi/shadow.mjs"), "utf8");
const unwrapped = "  return asShadowWriter(() => saveShadowRecord(root, kind, keyInputs, record));";
assert.equal(shadowSource.split(unwrapped).length - 1, 1, "the shadow_writer wrapper is where the mutant expects it");
writeFileSync(join(tree, "runtime/pi/shadow.mutant.mjs"), shadowSource.replace(unwrapped, "  return saveShadowRecord(root, kind, keyInputs, record);"));
assert.ok((await shadowChecks(await import(urlOf(join(tree, "runtime/pi/shadow.mutant.mjs"))))).length > 0, "without the shadow_writer wrapper the checks must turn red");
check("shadow: shadow_writer, knowledge, ok, requested_by kept; dropping the wrapper turns the check red");

clearEnv();
console.log(`group enforce: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
