// Node-side hand-off fixture: which (writer, path) pairs a page or plan tool really reaches, and what the table says about each.
// Covers the rows of the knowledge_writer x runtime/query-rows/ and shadow_writer x shadow/ hand-off rows that no recorded run has seen:
//   A1  newsroom_viz_plan -> knowledge_writer -> runtime/query-rows/   (an inline-claim plan whose SQL reads a recorded computation)
//   B1-B3  newsroom_award_mode_status, newsroom_competition_preflight, newsroom_publication_plan: NOT reached since the as-of shadow check was removed
//   B4  newsroom_infographic_lint        -> shadow_writer -> shadow/    (NEWSROOM_RECORD_CAVEATS=1)
// Two arms per pair, both with the hand-off on and the boundary report on (NEWSROOM_GROUP_BOUNDARY=1):
//   record  (ENFORCE off): the write is made and the report row names the pair: requested_by, kind, the path. Proves the pair is reached. The row's status
//                          is the node-side listed/unlisted signal: "ok" when the table lets it through, "handoff_not_listed" when it is in not_measured.
//   enforce (ENFORCE=1):   the table decides. The expectation is computed from groups.json, never written down here: a requester kept in not_measured
//                          is refused with "not measured yet" and leaves no file (query-rows) or only a refusal line (shadow, whose writer never throws);
//                          a requester not in not_measured is let through. So the test does not pin the table: it pins that the gate does what the table says.
// B1-B3 assert the opposite of A1: with every NEWSROOM_RECORD_* switch on, the three tools add no file under shadow/ and no report row names them; the
// shadow_writer row and its three not_measured pairs are unchanged (now unreachable). The page tools themselves are not judged: they may fail later. Nothing here edits groups.json, marks anything measured or adds an exemption.
// Needs the duckdb binary (exit 77, SKIP, without it). No model, no network.
// Mutations (do them in a scratch tree, keep nothing): comment out the not_measured line in handoffProblem (runtime/pi/groups.mjs) and both enforce
// arms go red; make saveShadowRecord / writeShadowRecord skip asShadowWriter (a direct write) and the B4 row loses requested_by, so B4 goes red; make a B tool write under shadow/ again and B1-B3 go red;
// make the query-rows write in saveQueryRows skip knowledgeSide and the A1 record row goes red.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_ENV, ROOT, freshRun, loadTree, omittedPlan, pipeline, register, schemaOrdered, setupRasterStub, walk } from "./lib_page_chain_fixture.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") { console.log("SKIP: duckdb binary not found"); process.exit(77); }
for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_") && key !== "NEWSROOM_DUCKDB_BIN") delete process.env[key];
process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; // the off-table call refusal is on by default; this test is about something else, so both are pinned off
setupRasterStub();

const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8")).handoffs.rows;
// How the table classifies (writer, path prefix, requester): "listed" (a row lets the requester write) and whether it is still in not_measured.
const classify = (writer, prefix, requester) => {
  const rows = table.filter((r) => r.writer === writer && r.paths.includes(prefix));
  const listed = rows.some((r) => r.requesters.includes(requester));
  return { listed, notMeasured: listed && rows.some((r) => (r.not_measured ?? []).includes(requester)) };
};
const summary = [];
const ENV_ON = { NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_BOUNDARY: "1" };
const arms = [["record", { ...ENV_ON, NEWSROOM_GROUP_ENFORCE: "0" }], ["enforce", { ...ENV_ON, NEWSROOM_GROUP_ENFORCE: "1" }], ["default", { NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: undefined, NEWSROOM_GROUP_ENFORCE: undefined }]]; // default: the report switch only, hand-off and enforcement unset (both on), must show what the enforce arm shows
const { mod, dir: treeDir } = await loadTree("node-handoff");
const groups = await import(pathToFileURL(join(treeDir, "runtime/pi/groups.mjs")).href);
const reportOf = (art) => JSON.parse(readFileSync(join(art, "runtime/group-boundary-report.json"), "utf8"));
const refusalsOf = (art) => { const f = join(art, "runtime/boundary-refusals.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const rowsFor = (report, requester, kind, tool) => report.records.filter((r) => r.requested_by === requester && r.kind === kind && r.tool === tool);

// ---- A1: newsroom_viz_plan x runtime/query-rows/ -----------------------------------------------------------------------------------------
const planParams = (ref, extra = {}) => ({
  reader_task: "ranking", chart_type: "horizontal_bar", complexity_budget: "low", title: "Renewable energy consumption share by country",
  note: "Reference years differ by country.", unit: "%", category_field: "country_with_year", value_field: "renewable_energy_consumption_pct", sort: "desc",
  measure_semantics: [{ id: "renewable_pct", field: "renewable_energy_consumption_pct", phenomenon: "renewable energy consumption share", unit: "%", measure_kind: "share", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }],
  claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "renewable_pct", measure_ids: ["renewable_pct"] },
  source_note: "来源：测试数据",
  sql: `SELECT country, year, renewable_energy_consumption_pct, country || ' (' || year || ')' AS country_with_year\nFROM '${ref}'\nORDER BY renewable_energy_consumption_pct DESC, country`,
  claim: "Among the African countries in the data, {max.renewable_energy_consumption_pct.country} has the highest renewable energy consumption share at {max.renewable_energy_consumption_pct}% ({max.renewable_energy_consumption_pct.year} data) and {min.renewable_energy_consumption_pct.country} the lowest at {min.renewable_energy_consumption_pct}% ({min.renewable_energy_consumption_pct.year} data).",
  claim_kind: "comparative", ...extra,
});
const renewable = readFileSync(join(ROOT, "fixtures/world-bank-renewable-latest.csv"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function investigation() {
  const dir = join(makeTestTmp("node-handoff-a1-"), "run");
  const sha = sha256(renewable);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", `${sha}.csv`), renewable);
  writeFileSync(join(dir, "data", `${sha}.csv.meta.json`), `${JSON.stringify({ bytes: renewable.length, file: `data/${sha}.csv`, schema_version: "0.7.0", sha256: sha }, null, 2)}\n`);
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  groups.resetBoundaryReport();
  return { dir, ref: `data/${sha}.csv` };
}
const A1 = classify("knowledge_writer", "runtime/query-rows/", "newsroom_viz_plan");
for (const [arm, env] of arms) {
  const story = investigation();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1", ...env });
  const first = await tools.get("newsroom_viz_plan").execute("c", planParams(story.ref));
  assert.ok(first.content[0].text.includes("Claim recorded: VERIFIED"), `A1 ${arm}: the first plan call works`);
  // the second call reads the first call's recorded computation: the only path that makes the runtime write a query-rows table
  const computation = walk(join(story.dir, "computations")).map((f) => relative(story.dir, f))[0];
  assert.ok(computation, "A1: the first call recorded a computation");
  const second = planParams(story.ref);
  second.sql = second.sql.replace(`'${story.ref}'`, `'${computation}'`);
  assert.ok(second.sql.includes(computation));
  const refused = await tools.get("newsroom_viz_plan").execute("c2", second).then(() => null, (error) => String(error?.message ?? error));
  const rows = walk(join(story.dir, "runtime/query-rows")).map((f) => relative(story.dir, f));
  assert.ok(A1.listed, "A1: the table lists newsroom_viz_plan for knowledge_writer on runtime/query-rows/");
  if (arm === "record") {
    assert.equal(refused, null, `A1 record: nothing is refused: ${refused}`);
    assert.equal(rows.length, 1, "A1 record: the query-rows table is written");
    const hits = rowsFor(reportOf(story.dir), "newsroom_viz_plan", "evidence", "knowledge_writer").filter((r) => r.examples.some((p) => p.startsWith("runtime/query-rows/")));
    assert.ok(hits.length >= 1 && hits.every((r) => r.status === (A1.notMeasured ? "handoff_not_listed" : "ok") && r.owner === "knowledge"), `A1 record: the report names the pair: ${JSON.stringify(hits)}`);
  } else if (A1.notMeasured) {
    assert.match(String(refused), /knowledge_writer.*may not write runtime\/query-rows\//, "A1 enforce: the write is refused (the reason is in the refusal log below)");
    assert.deepEqual(rows, [], "A1 enforce: no query-rows file");
    const lines = refusalsOf(story.dir).filter((r) => r.path.startsWith("runtime/query-rows/"));
    assert.ok(lines.length === 1 && lines[0].writer === "knowledge_writer" && lines[0].status === "handoff_not_listed" && /^newsroom_viz_plan is listed for knowledge_writer on runtime\/query-rows\/.*not measured yet \(not_measured\)/.test(lines[0].reason), JSON.stringify(lines));
  } else {
    assert.equal(refused, null, `A1 enforce: measured, so let through: ${refused}`);
    assert.equal(rows.length, 1, "A1 enforce: the query-rows table is written");
  }
}
summary.push(`A1 newsroom_viz_plan -> knowledge_writer -> runtime/query-rows/: reached (record arm: report row + file); table: ${A1.listed ? "listed" : "UNLISTED"}${A1.notMeasured ? ", still in not_measured, refused under enforce" : ", measured"}`);

// ---- B1-B3: the page tools no longer reach shadow/ ------------------------------------------------------------------------------------------
// Since the as-of shadow check was removed, these three tools reach shadow/ through nothing: the record-only writes come from the viz lint, the
// page lint tool and the critic preview/review, and none of the three B tools calls those. The shadow_writer row and its not_measured pairs are
// unchanged, so the pairs are now unreachable. If one of these tools starts writing there again, this section goes red.
const B = [["B1", "newsroom_award_mode_status"], ["B2", "newsroom_competition_preflight"], ["B3", "newsroom_publication_plan"]];
const visionCritic = (manifestRef, criticRef) => ({ kind: "image_aware_model", manifest_ref: manifestRef, deterministic_critic_ref: criticRef, passed: true, score: 92, issues: [], rubric: Object.fromEntries(["hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"].map((k) => [k, 80])) });
const RECORD_ALL = Object.fromEntries(["ASOF_LISTS", "CAVEATS", "CRITIC_VISION", "DROPPED_CONTENT", "EXTREME_WORDS", "NUMBERS", "ORIGIN_HASH", "THIN_RESULT"].map((k) => [`NEWSROOM_RECORD_${k}`, "1"]));
const shadowFiles = (art) => walk(join(art, "shadow")).map((f) => relative(art, f)).sort();
for (const [arm, env] of arms) {
  const art = freshRun(`node-handoff-b-${arm}`);
  groups.resetBoundaryReport();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: "1", ...RECORD_ALL, ...env });
  const run = await pipeline(tools, schemaOrdered(tools, omittedPlan()), { omit: true });
  const base = { plan_ref: run.p.details.planRef, manifest_ref: run.render.details.manifestRef, deterministic_critic_ref: run.critic.details.criticRef };
  mkdirSync(join(art, "infographics/vision-critics"), { recursive: true });
  writeFileSync(join(art, "infographics/vision-critics/v.json"), JSON.stringify(visionCritic(base.manifest_ref, base.deterministic_critic_ref)));
  const plan = JSON.parse(readFileSync(join(art, base.plan_ref), "utf8"));
  const calls = {
    newsroom_award_mode_status: { discovery_ref: "editorial/discovery/migration.json", concepts_ref: "editorial/concepts/migration.json", asset_plan_ref: "editorial/assets/migration.json", novelty_ref: "editorial/novelty/migration.json", page_ref: base.manifest_ref, metrics: { concepts_generated: 3, concepts_killed: 1, research_gap_requests: 0, prototype_count: 1, raster_revision_count: 0 } },
    newsroom_competition_preflight: { ...base, vision_critic_ref: "infographics/vision-critics/v.json" },
    newsroom_publication_plan: { infographic_plan_ref: base.plan_ref, story_graph_ref: plan.story_graph_ref, reader_question: plan.reader_question, visual_thesis: plan.visual_thesis },
  };
  // The pipeline's own lint/render/critic/preview calls may write shadow/ record files (every NEWSROOM_RECORD_* switch is on); the B tools must add nothing.
  const outcomes = {}, added = {};
  for (const [, tool] of B) {
    const before = shadowFiles(art);
    outcomes[tool] = await tools.get(tool).execute("x", calls[tool]).then(() => "ok", (error) => String(error?.message ?? error).slice(0, 120));
    added[tool] = shadowFiles(art).filter((f) => !before.includes(f));
  }
  const report = reportOf(art);
  const refusals = refusalsOf(art).filter((r) => r.writer === "shadow_writer");
  for (const [id, tool] of B) {
    assert.ok(classify("shadow_writer", "shadow/", tool).listed, `${id}: the table still lists ${tool} for shadow_writer on shadow/ (the row is unchanged)`);
    assert.deepEqual(rowsFor(report, tool, "observation", "shadow_writer"), [], `${id} ${arm}: no report row names (shadow_writer, ${tool}) (${outcomes[tool]})`);
    assert.deepEqual(added[tool], [], `${id} ${arm}: the call adds no file under shadow/`);
    if (arm !== "record") assert.deepEqual(refusals.filter((r) => String(r.reason ?? "").startsWith(`${tool} `)), [], `${id} ${arm}: no shadow_writer refusal from ${tool}`);
    summary.push(`${id} ${tool} (${arm}) -> shadow/: not reached; the tool then ended: ${outcomes[tool]}`);
  }
}

// ---- B4: the writer is still reached by a tool that does write there, and the hand-off names it -----------------------------------------------
// newsroom_infographic_lint with NEWSROOM_RECORD_CAVEATS=1 writes a record-only file through shadow_writer. Keeps the asShadowWriter mutation provable:
// make saveShadowRecord / writeShadowRecord skip asShadowWriter and the row loses requested_by, so this goes red.
{
  const art = freshRun("node-handoff-b4");
  groups.resetBoundaryReport();
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: "1", NEWSROOM_RECORD_CAVEATS: "1", ...arms[0][1] });
  await pipeline(tools, schemaOrdered(tools, omittedPlan()), { omit: true });
  const c = classify("shadow_writer", "shadow/", "newsroom_infographic_lint");
  assert.ok(c.listed && !c.notMeasured, "B4: the table lists newsroom_infographic_lint for shadow_writer on shadow/ and it is measured");
  const rows = rowsFor(reportOf(art), "newsroom_infographic_lint", "observation", "shadow_writer").filter((r) => r.examples.some((p) => p.startsWith("shadow/")));
  assert.ok(rows.length >= 1 && rows.every((r) => r.status === "ok" && r.owner === "knowledge"), `B4: the report names (shadow_writer, newsroom_infographic_lint) with status ok: ${JSON.stringify(rows)}`);
  assert.ok(shadowFiles(art).length >= 1, "B4: a record file is under shadow/");
  summary.push("B4 newsroom_infographic_lint (RECORD_CAVEATS=1) -> shadow_writer -> shadow/: reached, status ok, requested_by named");
}
for (const line of summary) console.log(line);
console.log("node hand-off fixture: A1, B1-B3 (not reached) and B4 -- PASS");
