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
import { execFileSync } from "node:child_process";
import { chartValuesInRows, claimBindsComputation, normalizeSql, numericFieldsOfSpec, strictResultHashMatches } from "../runtime/pi/claim_binding.mjs";
import { lintInfographicSpec } from "../runtime/pi/infographic.mjs";
import { CHART_TYPES, lintVizSpec } from "../runtime/pi/viz.mjs";
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
assert.equal(claimBindsComputation(state(["data/a.csv"], { ref: undefined, sql: "SELECT x FROM read_json('computations/c.json')", rows: [{ x: 9 }], read_inputs: [{ path: "computations/c.json", sha256: H("2") }] }), [claimC("data/a.csv")]).code, "no_computation_relation", "merely reading the claim's computation (without an AST proving the chart is a plain select over it) is not a relation");
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

// ---- Part 1b: the direct-read relation is proven, not observed -------------
const astOf = (sql) => JSON.parse(execFileSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["-noheader", "-list", ":memory:", "-c", `SELECT json_serialize_sql('${sql.replace(/'/g, "''")}', skip_null := true, skip_empty := true)`]).toString().trim());
const CA = `computations/${"a".repeat(64)}.json`;
const CB = `computations/${"b".repeat(64)}.json`;
const ROOT_ROWS = [{ region: "n", amount: 4 }, { region: "s", amount: 9 }, { region: "n", amount: 6 }];
const rootClaim = { ...claimC("data/a.csv"), ref: CA, sql: "SELECT region, amount FROM read_csv_auto('data/a.csv')", rows: ROOT_ROWS };
const direct = (sql, rows, fields, reads = [CA]) => claimBindsComputation({
  input_binding: "source_bound", effective_inputs: ["data/a.csv", "data/b.csv"].slice(0, reads.length > 1 ? 2 : 1), sql, rows, ast: astOf(sql), numeric_fields: fields,
  read_inputs: reads.map((path) => ({ path, sha256: H("1") })),
}, [rootClaim]);
const okRel = (verdict, message) => { assert.equal(verdict.relation, "reads_claim_computation", `${message}: ${verdict.message}`); };
okRel(direct(`SELECT region, count(*) AS n FROM read_json('${CA}') GROUP BY region ORDER BY region`, [{ region: "n", n: 2 }, { region: "s", n: 1 }], ["n"]), "GROUP BY COUNT");
okRel(direct(`SELECT region, sum(amount) AS total FROM read_json('${CA}') GROUP BY region`, [{ region: "n", total: 10 }, { region: "s", total: 9 }], ["total"]), "GROUP BY SUM");
okRel(direct(`SELECT region AS category, amount AS total FROM read_json('${CA}') t WHERE t.amount > 4 ORDER BY total DESC LIMIT 2`, [{ category: "s", total: 9 }, { category: "n", total: 6 }], ["total"]), "alias, filter, order and top N");
okRel(direct(`SELECT upper(region) || '-x' AS label, 2017 AS year, max(amount) AS m FROM read_json('${CA}') GROUP BY region`, [{ label: "N-x", year: 2017, m: 6 }, { label: "S-x", year: 2017, m: 9 }], ["m"]), "a label and a constant year are free; only the numeric field is constrained");
const refused = (verdict, why, message) => { assert.equal(verdict.ok, false, message); assert.match(verdict.message, why, message); };
const AGG = [{ region: "n", n: 2 }, { region: "s", n: 1 }];
refused(direct(`SELECT region, 99 AS n FROM read_json('${CA}')`, [{ region: "n", n: 99 }], ["n"]), /numeric field 'n'/, "a literal in a numeric field");
refused(direct(`SELECT region, amount * 10 AS n FROM read_json('${CA}')`, [{ region: "n", n: 40 }], ["n"]), /numeric field 'n'/, "arithmetic in a numeric field");
refused(direct(`SELECT region, (SELECT max(amount) FROM read_json('${CA}')) AS n FROM read_json('${CA}')`, [{ region: "n", n: 9 }], ["n"]), /subquery/, "a scalar subquery");
refused(direct(`SELECT region, amount AS n FROM read_json('${CA}') WHERE EXISTS (SELECT 1 FROM read_json('${CA}'))`, [{ region: "n", n: 4 }], ["n"]), /subquery/, "EXISTS in WHERE");
refused(direct(`SELECT g.region, b.price AS n FROM read_json('${CA}') g JOIN read_json('${CB}') b ON true`, [{ region: "n", n: 1 }], ["n"], [CA, CB]), /other than the claim's computation/, "a join with another file");
refused(direct(`SELECT region, amount AS n FROM read_json('${CA}') UNION ALL SELECT region, amount FROM read_json('${CA}')`, [{ region: "n", n: 4 }], ["n"]), /plain SELECT/, "UNION");
refused(direct(`SELECT region, count(*) AS n FROM read_json('${CA}') GROUP BY region HAVING count(*) > 0`, AGG, ["n"]), /HAVING/, "HAVING");
refused(direct(`WITH t AS (SELECT * FROM read_json('${CA}')) SELECT region, amount AS n FROM t`, [{ region: "n", n: 4 }], ["n"]), /CTE|directly/, "a CTE");
refused(direct(`SELECT DISTINCT region, amount AS n FROM read_json('${CA}')`, [{ region: "n", n: 4 }], ["n"]), /modifier/, "DISTINCT");
refused(direct(`SELECT * FROM read_json('${CA}')`, [{ region: "n", amount: 4 }, { region: "n", amount: 4 }], ["amount"]), /selects \*/, "SELECT *");
refused(direct(`SELECT region, abs(amount) AS n FROM read_json('${CA}')`, [{ region: "n", n: 4 }], ["n"]), /numeric field 'n'/, "a function in a numeric field");
refused(direct(`SELECT region, count(*) AS n FROM read_json('${CB}') GROUP BY region`, AGG, ["n"], [CB]), /no_shared|other than|reads/, "another claim's computation is not this claim's root");
assert.equal(claimBindsComputation({ input_binding: "source_bound", effective_inputs: ["data/a.csv"], sql: "x", rows: AGG, numeric_fields: ["n"], read_inputs: [{ path: CA, sha256: H("1") }] }, [rootClaim]).ok, false, "no AST: fail closed");
assert.equal(claimBindsComputation({ input_binding: "source_bound", effective_inputs: ["data/a.csv"], sql: `SELECT region, count(*) AS n FROM read_json('${CA}') GROUP BY region`, rows: AGG, ast: astOf(`SELECT region, count(*) AS n FROM read_json('${CA}') GROUP BY region`), read_inputs: [{ path: CA, sha256: H("1") }] }, [rootClaim]).ok, false, "numeric fields unknown: fail closed");
// Numeric encoding fields are recognized for every chart type in the registry.
const FIELDS_OF = {
  horizontal_bar: ["value_field"], dot: ["value_field"], diverging_bar: ["value_field"], waffle: ["value_field"], treemap: ["value_field"], choropleth: ["value_field"],
  stacked_bar_100: ["value_field"],
  cartographic_flow_map: ["value_field"], parallel_sets: ["value_field"], chord: ["value_field"], sankey: ["value_field"], alluvial: ["value_field"],
  line: ["value_field"], multi_line: ["value_field"], small_multiples: ["value_field"], streamgraph: ["value_field"], heatmap: ["value_field", "y_field"],
  mirrored_bar: ["value_field"],
  dumbbell: ["start_field", "end_field"], slope: ["start_field", "end_field"], scatter: ["x_field", "y_field"],
  strip_plot: ["value_field"],
  geo_flow_map: ["value_field", "source_lat_field", "source_lon_field", "target_lat_field", "target_lon_field"],
  trajectory_profile: ["x_field", "altitude_field", "speed_field"],
};
const NO_NUMERIC = ["node_link", "adjacency_matrix", "hierarchy_tree", "timeline", "process_schematic"];
assert.deepEqual([...CHART_TYPES].sort(), [...Object.keys(FIELDS_OF), ...NO_NUMERIC].sort(), "every chart type is classified here; a new chart type must be added to this table and to numericFieldsOfSpec");
for (const [type, fields] of Object.entries(FIELDS_OF)) {
  const spec = { chart_type: type, category_field: "cat", series_field: "ser", source_field: "src", target_field: "tgt", label_field: "lab", x_field: type === "scatter" || type === "trajectory_profile" ? "col_x_field" : "time", ...Object.fromEntries(fields.filter((key) => key !== "x_field").map((key) => [key, `col_${key}`])) };
  assert.deepEqual([...numericFieldsOfSpec(spec)].sort(), fields.map((key) => `col_${key}`).sort(), `${type}: numeric encoding fields`);
}
for (const type of NO_NUMERIC) assert.deepEqual(numericFieldsOfSpec({ chart_type: type, x_field: "d", label_field: "l", source_field: "a", target_field: "b" }), [], `${type} encodes no numeric column`);
refused(direct(`SELECT region, 99 AS n FROM read_json('${CA}')`, [{ region: "n", n: 99 }], []), /no numeric encoding field is known/, "numeric fields not recognized for the chart type: refused");
refused(direct(`SELECT region, 99 AS n FROM read_json('${CA}')`, [{ region: "n", n: 99 }], ["other"]), /none of the chart's numeric encoding fields/, "numeric field not among the output columns: refused");
// A refused direct read can still pass on its rows, and only on its rows.
assert.equal(direct(`SELECT g.region, g.amount FROM read_json('${CA}') g CROSS JOIN read_json('${CB}') b`, ROOT_ROWS, ["amount"], [CA, CB]).relation, "values_in_rows");
// The refusal names the canonical path only.
assert.match(direct(`SELECT region, 99 AS n FROM read_json('${CA}')`, [{ region: "n", n: 99 }], ["n"]).message, new RegExp(`read_json\\('${CA.replace(/[.]/g, "\\.")}'\\)`), "the hint carries the claim computation path");
const hostile = { ...rootClaim, ref: "/Users/someone/secret dir/computations/x.json" };
const hostileMessage = claimBindsComputation({ input_binding: "source_bound", effective_inputs: ["data/a.csv"], sql: "SELECT region FROM x", rows: [{ region: "zz" }], read_inputs: [{ path: "data/a.csv", sha256: H("1") }] }, [hostile]).message;
assert.equal(hostileMessage.includes("someone") || hostileMessage.includes("secret dir"), false, "a non-canonical ref is never echoed");
assert.match(hostileMessage, /<claim computation>/);
// Literals inside quotes are never normalized.
assert.notEqual(normalizeSql("SELECT v FROM t WHERE k = 'a - b'"), normalizeSql("SELECT v FROM t WHERE k = 'a-b'"));
assert.notEqual(normalizeSql('SELECT "a - b" FROM t'), normalizeSql('SELECT "a-b" FROM t'));
assert.equal(normalizeSql("SELECT  v FROM t WHERE k = 'a - b' ;"), normalizeSql("select v\nfrom t where k='a - b'"), "outside quotes: case, whitespace, operator spacing still normalized");
// Row containment counts duplicates.
assert.equal(chartValuesInRows([{ k: "a" }, { k: "a" }], [{ k: "a" }]).ok, false, "a row duplicated by a join is not a subset");
assert.equal(chartValuesInRows([{ k: "a" }, { k: "a" }], [{ k: "a" }, { k: "a" }, { k: "b" }]).ok, true);
console.log("claim binding: direct-read relation (AST) -- PASS");

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
  const joined = await lint({ claim_id: claimA, sql: `SELECT a.date, a.event FROM read_csv_auto('${fileA}') a JOIN read_csv_auto('${fileY}') y ON length(a.event) > y.count AND y.region = 'north' ORDER BY a.date` });
  assert.equal(joined.binding.length, 0, "a join that keeps the claim's own rows once each passes");
  const amplified = await lint({ claim_id: claimA, sql: `SELECT a.date, a.event FROM read_csv_auto('${fileA}') a JOIN read_csv_auto('${fileY}') y ON length(a.event) > y.count ORDER BY a.date` });
  assert.equal(amplified.binding.length, 1, "a join that duplicates the claim's rows is not a subset of them");
  assert.match(amplified.binding[0], /more often/);

  // Direct read of the claim's stored computation (the relation is proven on
  // the SQL's AST, not merely observed in the read set).
  const fileG = addData("G", "region,amount\nn,4\ns,9\nn,6\n");
  const qg = await query(`SELECT region, amount FROM read_csv_auto('${fileG}')`);
  const claimG = (await recordClaim("Amounts by region", [fileG], [qg])).claim_id;
  const readsRoot = (sql, extra = {}) => lint({ claim_id: claimG, value_field: "amount", sql, ...extra });
  for (const [label, sql, field] of [
    ["GROUP BY COUNT", `SELECT region, count(*) AS amount FROM read_json('${qg}') GROUP BY region ORDER BY region`, "amount"],
    ["GROUP BY SUM", `SELECT region, sum(amount) AS amount FROM read_json('${qg}') GROUP BY region ORDER BY region`, "amount"],
    ["alias and rename", `SELECT region AS area, amount AS total FROM read_json('${qg}') ORDER BY area`, "total"],
    ["ORDER BY and top N", `SELECT region, amount FROM read_json('${qg}') ORDER BY amount DESC LIMIT 2`, "amount"],
  ]) {
    const result = await readsRoot(sql, { value_field: field });
    assert.equal(result.binding.length, 0, `${label} over the claim's computation passes: ${result.binding.join(" | ")}`);
  }
  const fileOut = addData("OUT", "item,price\nbread,3\nmilk,4\n");
  for (const [label, sql] of [
    ["EXISTS bridge to an unrelated file", `SELECT b.item AS region, b.price AS amount FROM read_csv_auto('${fileOut}') b WHERE EXISTS (SELECT 1 FROM read_json('${qg}'))`],
    ["JOIN that brings in an outside number", `SELECT g.region, b.price AS amount FROM read_json('${qg}') g JOIN read_csv_auto('${fileOut}') b ON true`],
    ["UNION with an outside number", `SELECT region, amount FROM read_json('${qg}') UNION ALL SELECT item, price FROM read_csv_auto('${fileOut}')`],
    ["a literal in the numeric field", `SELECT region, 99 AS amount FROM read_json('${qg}')`],
    ["arithmetic in the numeric field", `SELECT region, amount * 10 AS amount FROM read_json('${qg}')`],
    ["another claim's computation", `SELECT region, count(*) AS amount FROM read_json('${qy}') GROUP BY region`],
  ]) {
    const result = await readsRoot(sql);
    assert.equal(result.binding.length, 1, `${label} must be refused`);
    assert.equal(result.artifact.publishable, false, `${label}: not publishable`);
  }
  // Chart type with no recognized numeric field (timeline): the direct-read relation does not apply.
  const timelineConst = await lint({ claim_id: claimG, sql: `SELECT region, 99 AS amount FROM read_json('${qg}')` });
  assert.equal(timelineConst.binding.length, 1, "no numeric field recognized for the chart type: a constant number is refused");
  const barConst = await lint({ claim_id: claimG, chart_type: "horizontal_bar", category_field: "region", value_field: "amount", sql: `SELECT region, 99 AS amount FROM read_json('${qg}')` });
  assert.equal(barConst.binding.length, 1, "horizontal_bar with a constant in its value column is refused");
  const barAgg = await lint({ claim_id: claimG, chart_type: "horizontal_bar", category_field: "region", value_field: "amount", sql: `SELECT region, sum(amount) AS amount FROM read_json('${qg}') GROUP BY region ORDER BY region` });
  assert.equal(barAgg.binding.length, 0, "horizontal_bar with SUM over the claim's computation passes");
  // A claim computation read by the claim's own chart, but the chart hung on a second claim's id.
  assert.equal((await lint({ claim_id: claimY, value_field: "amount", sql: `SELECT region, count(*) AS amount FROM read_json('${qg}') GROUP BY region` })).binding.length, 1, "chart on one claim's computation hung on another claim");
  // Quoted literals are not normalized: two different filters are two statements.
  const fileL = addData("L", "k,v\na - b,1\na-b,2\n");
  const ql = await query(`SELECT k, v FROM read_csv_auto('${fileL}') WHERE k = 'a - b'`);
  const claimL = (await recordClaim("Value of a - b", [fileL], [ql])).claim_id;
  const sameLiteral = await lint({ claim_id: claimL, sql: `SELECT k, v FROM read_csv_auto('${fileL}') WHERE k = 'a - b' ORDER BY k` });
  assert.equal(sameLiteral.binding.length, 0, "the claim's own filter passes");
  const otherLiteral = await lint({ claim_id: claimL, sql: `SELECT k, v FROM read_csv_auto('${fileL}') WHERE k = 'a-b'` });
  assert.equal(otherLiteral.binding.length, 1, "a different quoted literal selects different numbers and is refused");

  // The page lint sees the same relation: a rendered chart that reads the
  // claim's stored computation directly passes it.
  const rootedManifest = await renderViz({ sql: `SELECT date, event FROM read_json('${qa}') ORDER BY date` });
  assert.equal((await igLint(rootedManifest)).length, 0, "page lint: a chart that selects from the claim's computation passes");
  assert.equal((await igLint(goodManifest)).length, 0, "visual on its own claim passes");
  assert.equal((await igLint(forgedRef)).length, 1, "visual whose claim shares no input with its computation");
  console.log("claim binding: real viz lint / infographic lint tool path -- PASS");
} finally {
  rmSync(h.tmp, { recursive: true, force: true });
}

// ---- Part 3: the chain and the step lint give the same verdict -------------
// The chain's claim check is the lint's own claim-binding judgement, so for
// every case a lint that passes must let the chain through the lint step and
// a lint that blocks must stop the chain there - never looser, never stricter.
const hc = await loadNewsroom({ prefix: "claim-binding-chain-", env: { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1" } });
try {
  const { art, tools, addData, query, recordClaim } = hc;
  const fileG = addData("G", "region,amount\nn,4\ns,9\nn,6\n");
  const qg = await query(`SELECT region, amount FROM read_csv_auto('${fileG}')`);
  const claimG = (await recordClaim("Amounts by region", [fileG], [qg])).claim_id;
  const fileY = addData("Y", "region,count\nnorth,4\nsouth,9\n");
  const qy = await query(`SELECT region, count FROM read_csv_auto('${fileY}') ORDER BY region`);
  const claimY = (await recordClaim("The regions have counts", [fileY], [qy])).claim_id;
  const fileOut = addData("OUT", "item,price\nbread,3\nmilk,4\n");
  const params = (sql, claim_id) => ({
    reader_task: "sequence", title: "Amounts by region", alt: "A horizontal bar chart of the amount recorded for each region in the fixture data.",
    takeaway: "Regions differ in amount.", source_note: "fixture", subtitle: "fixture", unit: "units", visual_family: "statistical", data_topology: "tabular",
    chart_type: "horizontal_bar", category_field: "region", value_field: "amount", sort: "desc", highlight_values: [], annotations: [], sql, claim_id,
  });
  const cases = [
    ["GROUP BY COUNT", `SELECT region, count(*) AS amount FROM read_json('${qg}') GROUP BY region ORDER BY region`, claimG, true],
    ["GROUP BY SUM", `SELECT region, sum(amount) AS amount FROM read_json('${qg}') GROUP BY region ORDER BY region`, claimG, true],
    ["alias and rename", `SELECT region, amount AS amount FROM read_json('${qg}') ORDER BY amount`, claimG, true],
    ["ORDER BY and top N", `SELECT region, amount FROM read_json('${qg}') ORDER BY amount DESC LIMIT 2`, claimG, true],
    ["EXISTS bridge", `SELECT b.item AS region, b.price AS amount FROM read_csv_auto('${fileOut}') b WHERE EXISTS (SELECT 1 FROM read_json('${qg}'))`, claimG, false],
    ["JOIN outside number", `SELECT g.region, b.price AS amount FROM read_json('${qg}') g JOIN read_csv_auto('${fileOut}') b ON true`, claimG, false],
    ["UNION outside number", `SELECT region, amount FROM read_json('${qg}') UNION ALL SELECT item, price FROM read_csv_auto('${fileOut}')`, claimG, false],
    ["literal in the numeric field", `SELECT region, 99 AS amount FROM read_json('${qg}')`, claimG, false],
    ["another claim's computation", `SELECT region, count(*) AS amount FROM read_json('${qy}') GROUP BY region`, claimG, false],
    ["right data, wrong claim", `SELECT region, count(*) AS amount FROM read_json('${qg}') GROUP BY region`, claimY, false],
  ];
  let n = 0;
  for (const [label, sql, claim, expectPass] of cases) {
    n += 1;
    const plan = await tools.get("newsroom_viz_plan").execute(`p${n}`, params(sql, claim));
    const stepLint = await tools.get("newsroom_viz_lint").execute(`l${n}`, { plan_ref: plan.details.planRef });
    const chain = await tools.get("newsroom_viz_chain").execute(`c${n}`, params(sql, claim));
    assert.equal(stepLint.details.passed, expectPass, `${label}: step lint verdict`);
    const stoppedAtLint = chain.details.failedAt === "newsroom_viz_lint";
    assert.equal(stoppedAtLint, !expectPass, `${label}: the chain stops at the lint step exactly when the step lint blocks (${chain.details.stopCode})`);
    if (!expectPass) assert.ok(["BLOCKED", "CLAIM_COMPUTATION_MISMATCH"].includes(chain.details.stopCode), `${label}: stop code ${chain.details.stopCode}`);
  }
  console.log("claim binding: chain and step lint agree on every case -- PASS");
} finally {
  rmSync(hc.tmp, { recursive: true, force: true });
}
console.log("test_claim_binding.mjs ok");
