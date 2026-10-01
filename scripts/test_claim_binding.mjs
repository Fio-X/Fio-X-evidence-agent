// A verified claim may hang on a chart (or one of its annotations, or an
// infographic visual) only when it belongs to that chart's own computation:
// the chart's SQL must be source_bound and share at least one data/ or
// sources/ input with one of the claim's computations. The decision is
// runtime/pi/claim_binding.mjs; this drives it as the lints use it.
//
// Part 1 is the pure decision and the pure lint contexts. Part 2 drives the
// real newsroom_viz_lint / newsroom_viz_render / newsroom_infographic_lint
// handlers against real DuckDB (no model, no Pi process).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimBindsComputation, strictResultHashMatches } from "../runtime/pi/claim_binding.mjs";
import { lintInfographicSpec } from "../runtime/pi/infographic.mjs";
import { lintVizSpec } from "../runtime/pi/viz.mjs";
import { loadNewsroom, REPO } from "./precision_harness.mjs";

// ---- Part 1: pure decision ------------------------------------------------
const H = (c) => c.repeat(64);
const ROWS = [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "c", v: 3 }];
const state = (inputs, extra = {}) => ({
  ref: "computations/c.json", result_hash: "h1", input_binding: "source_bound", effective_inputs: inputs,
  sql: "SELECT k, v FROM read_csv_auto('data/a.csv')", rows: ROWS, read_inputs: inputs.map((path) => ({ path, sha256: H("1") })),
  ...extra,
});
const bound = (...inputs) => state(inputs, { ref: undefined });
const claimC = (...inputs) => state(inputs);
assert.equal(claimBindsComputation(bound("data/a.csv"), [claimC("data/a.csv")]).relation, "same_sql", "same statement");
assert.equal(claimBindsComputation(bound("data/a.csv"), [claimC("data/a.csv")]).ok, true);
assert.equal(claimBindsComputation(bound("data/a.csv", "data/b.csv"), [claimC("data/b.csv", "data/a.csv")]).ok, true, "a join that reads one more file than the claim");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "select k,v from read_csv_auto('data/a.csv') -- c\nORDER BY k;" }), [claimC("data/a.csv")]).relation, "values_in_rows", "ORDER BY is a different statement; the rows decide");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "select k,v from read_csv_auto('data/a.csv') -- c\n;" }), [claimC("data/a.csv")]).relation, "same_sql", "comments, case, whitespace and ';' are normalized");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT v, k FROM x WHERE v>1", rows: [{ v: 3, k: "c" }, { v: 2, k: "b" }] }), [claimC("data/a.csv")]).relation, "values_in_rows", "subset and reorder of the claim's rows");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT k FROM x", rows: [{ k: "a" }, { k: "c" }] }), [claimC("data/a.csv")]).relation, "values_in_rows", "projection");
assert.equal(claimBindsComputation(bound("data/a.csv"), [claimC("data/z.csv"), claimC("data/a.csv")]).ok, true, "any of the claim's computations");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT x FROM read_json('computations/c.json')", rows: [{ x: 9 }], read_inputs: [{ path: "computations/c.json", sha256: H("2") }] }), [claimC("data/a.csv")]).relation, "reads_claim_computation", "a chart that reads the claim's stored computation");
for (const [name, chart] of [
  ["literal_only", { input_binding: "literal_only", effective_inputs: [] }],
  ["unresolved", { input_binding: "unresolved", effective_inputs: [] }],
  ["legacy", { input_binding: "legacy", effective_inputs: [] }],
  ["missing", undefined],
  ["bound but empty", { input_binding: "source_bound", effective_inputs: [] }],
]) {
  const verdict = claimBindsComputation(chart, [claimC("data/a.csv")]);
  assert.equal(verdict.ok, false, `chart ${name} must not carry a verified claim`);
  assert.equal(verdict.code, "chart_not_source_bound");
}
// Must fail: a shared FILE is not enough.
const sameFileOtherMetric = claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT k, w FROM x", rows: [{ k: "a", w: 10 }, { k: "b", w: 20 }] }), [claimC("data/a.csv")]);
assert.equal(sameFileOtherMetric.code, "no_computation_relation", "same file, different metric");
assert.match(sameFileOtherMetric.message, /make the chart read the claim's stored computation directly/, "the first remedy offered is to read the claim computation");
assert.ok(sameFileOtherMetric.message.indexOf("read the claim") < sameFileOtherMetric.message.indexOf("record the claim from that result"), "reading the claim computation is the preferred remedy");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT k, v FROM x", rows: [{ k: "a", v: 99 }] }), [claimC("data/a.csv")]).code, "no_computation_relation", "same columns, a value the claim never computed");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT k, v FROM x", rows: [{ k: "a", v: 3 }] }), [claimC("data/a.csv")]).code, "no_computation_relation", "labels paired with another row's value");
assert.equal(claimBindsComputation(state(["data/b.csv", "data/a.csv"], { ref: undefined, sql: "SELECT w FROM read_csv_auto('data/b.csv') CROSS JOIN (SELECT 1 FROM read_csv_auto('data/a.csv') LIMIT 1)", rows: [{ w: 7 }] }), [claimC("data/a.csv")]).code, "no_computation_relation", "unrelated file bridged to the claim's file by a one-row join");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT 'a' AS k, 63 AS v FROM read_csv_auto('data/a.csv') LIMIT 1", rows: [{ k: "a", v: 63 }] }), [claimC("data/a.csv")]).code, "no_computation_relation", "constant output from a real file");
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT k, count(*) AS n FROM x GROUP BY k", rows: [{ k: "a", n: 1 }] }), [claimC("data/a.csv")]).code, "no_computation_relation", "an aggregate over the claim's rows is not shown to come from it (fails closed)");
assert.equal(claimBindsComputation(bound("data/a.csv"), [claimC("data/y.csv")]).code, "no_shared_input");
assert.equal(claimBindsComputation(bound("data/a.csv"), []).code, "claim_has_no_computation");
assert.equal(claimBindsComputation(bound("data/a.csv"), [{ ...claimC("data/a.csv"), input_binding: "literal_only" }]).code, "claim_computation_not_source_bound");
// Same path, different content hash (fingerprints): not the same input.
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, read_inputs: [{ path: "data/a.csv", sha256: H("2") }] }), [claimC("data/a.csv")]).code, "no_shared_input", "same path, different content hash");
assert.deepEqual(claimBindsComputation(bound("data/a.csv"), [claimC("data/a.csv")]).shared_inputs, ["data/a.csv"]);
// computations/ paths (they embed the directory snapshot hash) are never compared.
assert.equal(claimBindsComputation(bound("computations/old.json"), [claimC("computations/old.json")]).ok, false, "only data/ and sources/ count");
assert.deepEqual(strictResultHashMatches("h1", [claimC("data/a.csv")]), { equal: true, refs: ["computations/c.json"] });
assert.equal(strictResultHashMatches("h2", [claimC("data/a.csv")]).equal, false);

// Pure lint contexts: absent context skips, a failing verdict blocks.
const spec = { claim_id: "k1", annotations: [{ type: "reference_line", text: "x", value: 1, claim_id: "k2" }] };
const hasBindingBlocker = (result) => result.blockers.filter((blocker) => /not bound to this chart/.test(blocker));
const vizRows = [{ date: "2024-01-01", event: "a" }];
const vizSpec = { schema_version: "0.8.0", takeaway: "t", title: "Policy implementation timeline", subtitle: "s", alt: "A timeline shows one dated milestone from announcement.", source_note: "src", claim_id: "k1", sql: "select 1", unit: "u", complexity_budget: "medium", annotations: [], highlight_values: [], reader_task: "sequence", visual_family: "temporal", data_topology: "events", chart_type: "timeline", x_field: "date", label_field: "event" };
assert.equal(hasBindingBlocker(lintVizSpec(vizSpec, vizRows, { verified_claim_ids: ["k1"] })).length, 0, "no claim_bindings in context: skipped");
const bad = { ok: false, message: "no overlap" };
assert.equal(hasBindingBlocker(lintVizSpec(vizSpec, vizRows, { verified_claim_ids: ["k1"], claim_bindings: { k1: bad } })).length, 1);
assert.equal(hasBindingBlocker(lintVizSpec(vizSpec, vizRows, { verified_claim_ids: ["k1"], claim_bindings: { k1: { ok: true } } })).length, 0);
const ig = (bindings) => lintInfographicSpec(
  { schema_version: "1.0.0", title: "T", dek: "d", alt: "a", modules: [{ id: "v1", type: "visual", span: "full", manifest_ref: "visualizations/m.json" }] },
  { "visualizations/m.json": { manifest: { claim_id: "k1", verification_mode: "verified", publishable: true }, desktopSvg: "<svg/>", mobileSvg: "<svg/>" } },
  { verified_claim_ids: ["k1"], mobile_pages: true, ...(bindings ? { visual_claim_bindings: bindings } : {}) },
).blockers.filter((blocker) => /not bound to the visual's own computation/.test(blocker));
assert.equal(ig(undefined).length, 0, "infographic: absent context skipped");
assert.equal(ig({ v1: { k1: bad } }).length, 1, "infographic visual whose claim does not intersect its computation");
assert.equal(ig({ v1: { k1: { ok: true } } }).length, 0);

// Tripwire: every production call of the two lints must pass the binding
// context, or the check would silently skip in the real tool path.
const newsroom = readFileSync(join(REPO, "runtime/pi/newsroom.ts"), "utf8");
assert.match(newsroom, /lintVizSpec\(spec, rows, \{[^}]*claim_bindings/, "newsroom_viz_lint must pass claim_bindings");
assert.match(newsroom, /lintInfographicSpec\(spec, assets, \{[^}]*visual_claim_bindings/, "newsroom_infographic_lint must pass visual_claim_bindings");
console.log("claim binding: pure decision and lint contexts -- PASS");

// ---- Part 2: the real tool path ------------------------------------------
const h = await loadNewsroom({ prefix: "claim-binding-" });
try {
  const { art, tools, addData, query, recordClaim } = h;
  const timeline = JSON.parse(readFileSync(join(REPO, "fixtures", "complex", "timeline.json"), "utf8"));
  const csvA = ["date,event", ...timeline.rows.map((row) => `${row.date},${row.event}`)].join("\n") + "\n";
  const fileA = addData("A", csvA);
  const fileY = addData("Y", "region,count\nnorth,4\nsouth,9\n");
  const qa = await query(`SELECT date, event FROM read_csv_auto('${fileA}')`);
  const qy = await query(`SELECT region, count FROM read_csv_auto('${fileY}') ORDER BY region`);
  const claimA = (await recordClaim("The timeline has dated milestones", [fileA], [qa])).claim_id;
  const claimY = (await recordClaim("The regions have counts", [fileY], [qy])).claim_id;
  assert.equal(h.claimsOnDisk().every((claim) => claim.status === "verified"), true);

  const lintTool = tools.get("newsroom_viz_lint");
  let planN = 0;
  const lint = async (patch) => {
    const planRef = `visualizations/plans/plan-${++planN}.json`;
    writeFileSync(join(art, planRef), JSON.stringify({ ...timeline.spec, sql: `SELECT date, event FROM read_csv_auto('${fileA}') ORDER BY date`, claim_id: claimA, ...patch }));
    const result = await lintTool.execute("l", { plan_ref: planRef });
    const artifact = JSON.parse(readFileSync(join(art, result.details.lintRef), "utf8"));
    return { result, artifact, planRef, binding: result.details.blockers.filter((blocker) => /not bound to this chart/.test(blocker)) };
  };

  // Must pass: the chart is the claim's own computation, a subset of it, a
  // pivot-like projection of the same file, and many charts share one.
  const same = await lint({});
  assert.equal(same.binding.length, 0, same.result.details.blockers.join(" | "));
  assert.equal(same.artifact.publishable, true);
  const subset = await lint({ sql: `SELECT date, event FROM read_csv_auto('${fileA}') WHERE event LIKE 'P%' ORDER BY date` });
  assert.equal(subset.binding.length, 0, "a subset of the claim's file passes");
  assert.equal(subset.artifact.publishable, true);
  const projection = await lint({ sql: `SELECT event, date FROM read_csv_auto('${fileA}') ORDER BY event` });
  assert.equal(projection.binding.length, 0, "a reshaped projection of the claim's file passes");
  const sharedOne = await lint({ title: "Second chart on the same computation" });
  const sharedTwo = await lint({ title: "Third chart on the same computation" });
  assert.equal(sharedOne.binding.length + sharedTwo.binding.length, 0, "several charts sharing one computation pass");
  // A chart chained on the claim's stored computation reads the same file transitively.
  const chained = await lint({ sql: `SELECT date, event FROM read_json('${qa}') ORDER BY date` });
  assert.equal(chained.binding.length, 0, "a chart chained on the claim's computation passes");

  // Must pass: a data file added after record_claim changes the directory
  // snapshot hash (so every computation path differs) but not the binding.
  const added = addData("late", "late,value\nx,1\n");
  const afterAdd = await lint({});
  assert.notEqual(afterAdd.result.details.computationRef, same.result.details.computationRef, "the snapshot hash moved, so the computation path moved");
  assert.equal(afterAdd.binding.length, 0, "paths are not compared: a file added after record_claim must not break the binding");
  assert.equal(afterAdd.artifact.publishable, true);
  assert.ok(added);

  // Must fail: a constant-SQL chart cannot hang on a verified claim.
  const constant = await lint({ sql: "SELECT '2024-01-01' AS date, 'Policy announced' AS event" });
  assert.equal(constant.binding.length, 1, "constant SQL on a verified claim");
  assert.equal(constant.result.details.passed, false);
  assert.equal(constant.artifact.publishable, false);
  assert.match(constant.binding[0], /literal_only/);

  // Must fail: the chart reads X while the claim reads only unrelated Y.
  const unrelated = await lint({ claim_id: claimY });
  assert.equal(unrelated.binding.length, 1, "chart on file A, claim on unrelated file Y");
  assert.equal(unrelated.result.details.passed, false);
  assert.equal(unrelated.artifact.publishable, false);

  // Must fail: an annotation citing an unrelated claim (spec.claim_id is fine).
  const annotated = await lint({ annotations: [{ type: "point", match_field: "event", match_value: timeline.rows[0].event, text: "Announced", claim_id: claimY }] });
  assert.equal(annotated.binding.length, 1);
  assert.match(annotated.binding[0], /annotations\[0\]\.claim_id/);
  assert.equal(annotated.result.details.passed, false);
  // ...and the same annotation on the right claim passes.
  const annotatedOk = await lint({ annotations: [{ type: "point", match_field: "event", match_value: timeline.rows[0].event, text: "Announced", claim_id: claimA }] });
  assert.equal(annotatedOk.binding.length, 0);

  // The render path stays closed behind a failed lint.
  await assert.rejects(tools.get("newsroom_viz_render").execute("r", { plan_ref: unrelated.planRef, lint_ref: unrelated.result.details.lintRef }), /lint|block|passed/i);

  // Must fail: an infographic visual whose claim has no intersection with its computation.
  process.env.NEWSROOM_MOBILE_PAGES = "1";
  const renderViz = async (patch) => {
    const planned = await lint(patch);
    const rendered = await tools.get("newsroom_viz_render").execute("r", { plan_ref: planned.planRef, lint_ref: planned.result.details.lintRef });
    return rendered.details.manifestRef;
  };
  const goodManifest = await renderViz({});
  const manifestPath = join(art, goodManifest);
  // A manifest forged to carry the unrelated claim (render itself is behind
  // lint, so this stands in for a stale/edited manifest) must fail the page lint.
  const forgedRef = goodManifest.replace(/\.json$/, "-forged.json");
  writeFileSync(join(art, forgedRef), JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), claim_id: claimY }));
  const igLint = async (manifestRef) => {
    const planRef = `infographics/plans/plan-${++planN}.json`;
    writeFileSync(join(art, planRef), JSON.stringify({
      schema_version: "1.0.0", title: "Test infographic", dek: "A minimal deterministic fixture.",
      alt: "A section header and a chart in a single-column feature layout.",
      modules: [{ id: "m1", type: "section_header", span: "full", heading: "Overview" }, { id: "m3", type: "visual", span: "full", manifest_ref: manifestRef }],
    }));
    const result = await tools.get("newsroom_infographic_lint").execute("i", { plan_ref: planRef });
    return result.details.blockers.filter((blocker) => /not bound to the visual's own computation/.test(blocker));
  };
  // Page-level: extra claims (claim_set, module claim_id/claim_ids, annotations)
  // are bound per visual, not only the manifest's main claim.
  const claimA2 = (await recordClaim("The same timeline, second claim", [fileA], [qa])).claim_id;
  const igExtra = async (moduleExtra) => {
    const planRef = `infographics/plans/plan-${++planN}.json`;
    writeFileSync(join(art, planRef), JSON.stringify({
      schema_version: "1.0.0", title: "Test infographic", dek: "A minimal deterministic fixture.",
      alt: "A section header and a chart in a single-column feature layout.",
      modules: [{ id: "m1", type: "section_header", span: "full", heading: "Overview" }, { id: "m3", type: "visual", span: "full", manifest_ref: goodManifest, ...moduleExtra }],
    }));
    const result = await tools.get("newsroom_infographic_lint").execute("i", { plan_ref: planRef });
    return result.details.blockers.filter((blocker) => /not bound to the visual's own computation/.test(blocker));
  };
  const annotation = (claim) => ({ id: "n1", type: "callout", text: "note", target_object_id: "m3", claim_id: claim });
  assert.equal((await igExtra({ claim_set: [claimA2] })).length, 0, "an extra claim recorded from the visual's own computation passes");
  assert.equal((await igExtra({ claim_id: claimA2, annotations: [annotation(claimA2)] })).length, 0, "module claim and annotation on the visual's own computation pass");
  const extraBad = await igExtra({ claim_set: [claimY] });
  assert.equal(extraBad.length, 1, "an unrelated claim in claim_set is refused");
  const annBad = await igExtra({ claim_set: [claimA2, claimY], annotations: [annotation(claimY)] });
  assert.equal(annBad.length >= 1 && annBad.some((blocker) => /annotation 'n1'/.test(blocker)), true, "an annotation citing an unrelated claim is refused");
  assert.equal((await igExtra({ claim_ids: [claimY] })).length, 1, "claim_ids is checked too");
  assert.equal((await igExtra({ claim_id: claimY })).length, 1, "module claim_id is checked too");

  // Real tool path: a shared file is not enough (the Codex bypasses).
  const fileB = addData("B", "item,price\nbread,3\nmilk,4\n");
  const bridge = await lint({ claim_id: claimA, sql: `SELECT b.item, b.price FROM read_csv_auto('${fileB}') b CROSS JOIN (SELECT 1 FROM read_csv_auto('${fileA}') LIMIT 1)` });
  assert.equal(bridge.binding.length, 1, "unrelated file bridged to the claim's file by a one-row join");
  assert.match(bridge.binding[0], /no_computation_relation|not shown to come from that computation/);
  const fileM = addData("M", "k,pop,price\nx,10,100\ny,20,200\n");
  const qm = await query(`SELECT k, pop FROM read_csv_auto('${fileM}') ORDER BY k`);
  const claimPop = (await recordClaim("Population by key", [fileM], [qm])).claim_id;
  const otherMetric = await lint({ claim_id: claimPop, sql: `SELECT k, price FROM read_csv_auto('${fileM}') ORDER BY k`, ...{ x_field: undefined } });
  assert.equal(otherMetric.binding.length, 1, "same file, the claim is about pop while the chart shows price");
  const sameMetric = await lint({ claim_id: claimPop, sql: `SELECT k, pop FROM read_csv_auto('${fileM}') WHERE pop > 10 ORDER BY k` });
  assert.equal(sameMetric.binding.length, 0, "same file, same metric, a subset of the claim's rows");
  const fileConst = await lint({ claim_id: claimPop, sql: `SELECT 'x' AS k, 99 AS pop FROM read_csv_auto('${fileM}') LIMIT 1` });
  assert.equal(fileConst.binding.length, 1, "a constant output that reads the file");
  const joined = await lint({ claim_id: claimA, sql: `SELECT a.date, a.event FROM read_csv_auto('${fileA}') a JOIN read_csv_auto('${fileY}') y ON length(a.event) > y.count ORDER BY a.date` });
  assert.equal(joined.binding.length, 0, "a join that keeps the claim's own rows passes");

  assert.equal((await igLint(goodManifest)).length, 0, "visual on its own claim passes");
  assert.equal((await igLint(forgedRef)).length, 1, "visual whose claim shares no input with its computation");
  console.log("claim binding: real viz lint / infographic lint tool path -- PASS");
} finally {
  rmSync(h.tmp, { recursive: true, force: true });
}
console.log("test_claim_binding.mjs ok");
