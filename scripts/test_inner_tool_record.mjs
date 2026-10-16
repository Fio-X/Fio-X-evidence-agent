// Pins today's behaviour for a tool that runs other page tools inside its own execute (a chain, the plan edit). Two questions, one answer each, both observed:
//   T1  Which tool name is a write recorded under? A write made by an inner page tool carries the INNER tool's name (withBoundaryContext wraps the
//       registered tool the chain calls through registeredTools). The chain's own name appears only on what the chain itself writes (its event log,
//       where it is the requester) and on the chain's own cross-call rows. The plan edit: the revised plan is the inner plan tool's write, the revision
//       record is the edit's own.
//   T2  With NEWSROOM_GROUP_TOOLS=1, which call owns the inner writes and the child-process checks? One call, the outer chain's: a chain starts exactly one call,
//       its inner tools start none (the inner tools are the registered ones, which carry the boundary context but not withGroupTools), and the child-process
//       checks the inner tools make (runDeclared) join that one call. The same five tools called one by one start five. The wording of the comment at
//       "A wrapped tool call always starts a new call" holds only for tools called through Pi, not for a chain's inner calls.
// Test only: nothing in the product changes. The call count is read through a one-line probe appended to the COPY of groups.mjs this test loads.
// Needs the duckdb binary (exit 77, SKIP, without it); no model, no network.
// Mutations (scratch tree, keep nothing): drop the withBoundaryContext line in registerScopedTool (newsroom.ts) and T1 goes red; swapping registeredTools.get for
// wrappedTools.get at the chain's inner call leaves T1 and T2 green (they hold the same tool); registering withGroupTools(tool) in registeredTools makes the chain start more
// than one call and T2 goes red.
import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { BASE_ENV, ROOT, TYPEBOX, explicitPlan, freshRun, pagePlan, pipeline, register, setupRasterStub, stub } from "./lib_page_chain_fixture.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") { console.log("SKIP: duckdb binary not found"); process.exit(77); }
for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_") && key !== "NEWSROOM_DUCKDB_BIN") delete process.env[key];
process.env.NEWSROOM_REVIEW_SPLIT = "0"; // this test builds the old layout (the draw step writes the render-QA record); the split is on by default
setupRasterStub();

const dir = makeTestTmp("inner-tool-tree-");
cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
stub(dir, "typebox", TYPEBOX);
stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const pi = join(dir, "runtime", "pi");
writeFileSync(join(pi, "groups.mjs"), `${readFileSync(join(pi, "groups.mjs"), "utf8")}\nexport const __probe = () => ({ calls: callSeq, overlaps, inFlight });\n`);
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(pathToFileURL(join(pi, "newsroom.test-copy.mjs")).href);
const groups = await import(pathToFileURL(join(pi, "groups.mjs")).href);


const PAGE = [["newsroom_infographic_plan", "infographics/plans/"], ["newsroom_infographic_lint", "infographics/lints/"], ["newsroom_infographic_render", "infographics/qa/"],
  ["newsroom_infographic_critic", "infographics/critics/"], ["newsroom_infographic_preview", "infographics/previews/"]];
const CHAIN = "newsroom_infographic_chain";
const reportOf = (art) => JSON.parse(readFileSync(join(art, "runtime/group-boundary-report.json"), "utf8"));
const callRowsOf = (art) => readFileSync(join(art, "runtime/cross-call-report.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const wroteUnder = (report, tool, prefix) => report.records.some((r) => r.tool === tool && (r.examples ?? []).some((p) => p.startsWith(prefix)));
const RECORD = { NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_ENFORCE: "0" };
const TOOLS = { NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_TOOLS: "1" };
const checks = [];

{ // T1: the chain
  const art = freshRun("inner-chain");
  groups.resetBoundaryReport();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", ...RECORD });
  const out = await tools.get(CHAIN).execute("chain-0", pagePlan());
  assert.equal(out.details.chainStatus, "COMPLETE");
  const report = reportOf(art);
  for (const [tool, prefix] of PAGE) assert.ok(wroteUnder(report, tool, prefix), `T1 chain: the ${prefix} write is recorded under ${tool}`);
  assert.ok(!report.records.some((r) => r.tool === CHAIN), "T1 chain: no write is recorded under the chain's own name");
  const chainOwn = report.records.filter((r) => r.requested_by === CHAIN);
  assert.ok(chainOwn.length >= 1 && chainOwn.every((r) => (r.examples ?? []).every((p) => p === "runtime/tool-chain-events.jsonl")), "T1 chain: the chain's name appears only as the requester of its own event log");
  const callRows = callRowsOf(art);
  for (const [tool] of PAGE) assert.ok(callRows.some((r) => r.tool === tool), `T1 chain: the call report has rows for ${tool}`);
  assert.ok(callRows.some((r) => r.tool === CHAIN), "T1 chain: the call report also has the chain's own rows");
  checks.push("T1 chain: inner writes under the inner names, chain name only on its own event log");
}
{ // T1: the plan edit
  const art = freshRun("inner-edit");
  groups.resetBoundaryReport();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PLAN_EDIT: "1", ...RECORD });
  const plan = await tools.get("newsroom_infographic_plan").execute("p", explicitPlan(tools));
  const out = await tools.get("newsroom_infographic_edit").execute("e", { plan_ref: plan.details.planRef, ops: [{ scope: "module", id: "resolution", field: "span", value: "half" }] });
  const report = reportOf(art);
  const rows = (tool) => report.records.filter((r) => r.tool === tool).flatMap((r) => r.examples ?? []);
  assert.ok(rows("newsroom_infographic_plan").includes(out.details.planRef), "T1 edit: the revised plan is recorded under the inner plan tool");
  assert.deepEqual(rows("newsroom_infographic_edit"), [out.details.revisionRef], "T1 edit: only the revision record is recorded under the edit's own name");
  checks.push("T1 edit: revised plan under the inner plan tool, revision record under the edit");
}
{ // T2: which call owns the inner writes
  const art = freshRun("inner-tools-chain");
  groups.resetBoundaryReport();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", ...TOOLS });
  const before = groups.__probe();
  const out = await tools.get(CHAIN).execute("chain-0", pagePlan());
  const after = groups.__probe();
  assert.equal(out.details.chainStatus, "COMPLETE");
  assert.equal(after.calls - before.calls, 1, "T2: a chain of five inner tools starts exactly one call");
  assert.equal(after.overlaps - before.overlaps, 0, "T2: and no overlap");
  assert.ok(readdirSync(join(art, "infographics/previews")).some((f) => f.endsWith(".png")), "T2: the preview's child process (runDeclared) ran inside that one call and was not refused");
  const report = reportOf(art);
  for (const [tool, prefix] of PAGE) assert.ok(wroteUnder(report, tool, prefix), `T2: still recorded under ${tool}`);
  checks.push("T2 chain: one call for five inner tools, no overlap, the child process joined it");
}
{ // T2 contrast: the same five tools called one by one start one call each
  const art = freshRun("inner-tools-manual");
  groups.resetBoundaryReport();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", ...TOOLS });
  const before = groups.__probe();
  await pipeline(tools, explicitPlan(tools));
  const after = groups.__probe();
  assert.equal(after.calls - before.calls, 5, "T2 contrast: five direct calls start five calls");
  assert.equal(after.overlaps - before.overlaps, 0);
  checks.push("T2 contrast: five direct calls start five calls");
}
for (const line of checks) console.log(line);
console.log(`inner tool record: ${checks.length} cases -- PASS`);
