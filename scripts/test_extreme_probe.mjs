#!/usr/bin/env node
// K117 stage 1: the report-only extreme-value probe (NEWSROOM_EXTREME_PROBE=1, default off).
//  1. the D values quoted in the plan (v295 r2) are reproduced on copies of the real drawn sets;
//  2. the edge cases: remaining span 0, fewer than 6 objects, a tie at one end, both ends far, a log axis, invalid values;
//  3. off state: every non-"1" value gives byte-identical output; on: only runtime/extreme-probe/extreme_probe-*.json is added.
//  4. NEWSROOM_GROUP_BOUNDARY=1: the diagnosis file is one ok write by the agent group's writer (requested_by the render tool); no new cross-group or 待查.
import "./group_env_pin.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTREME_PROBE_CANDIDATE_D, extremeProbeEnabled, probeExtremes } from "../runtime/pi/extreme_probe.mjs";
import { loadNewsroom, REPO, sha256 } from "./precision_harness.mjs";

const fixture = (name) => JSON.parse(readFileSync(join(REPO, "fixtures", "extreme_probe", `${name}.json`), "utf8")).rows;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 5e-7, `${label}: ${actual} vs ${expected}`);
const pick = (probe, end) => probe.records.find((r) => r.end === end);
const bar = (extra = {}) => ({ chart_type: "horizontal_bar", category_field: "k", value_field: "v", unit: "", language: "zh", ...extra });
const rowsOf = (values) => values.map((v, i) => ({ k: `o${i + 1}`, v }));

// ---- 1. the numbers in the plan -----------------------------------------------------------------------------------
{
  const map = probeExtremes({ chart_type: "choropleth", category_field: "iso3", value_field: "infl", unit: "%", language: "zh" }, fixture("q5_map"));
  const high = pick(map, "high");
  assert.equal(map.records.length, 2);
  assert.equal(high.object, "ARG");
  assert.equal(high.n, 174);
  near(high.d, 1.310078, "q5 map high");
  assert.equal(high.value, 219.88);
  assert.equal(high.rest_max, 91.44);
  assert.equal(high.candidate_trigger, true);
  assert.equal(high.candidate_notes.display_rounded, "ARG 220%，远高于其余数据（其余都不超过 91.4%）");  // the chart's own display rule: whole numbers from 100 up
  assert.equal(high.candidate_notes.source_value, "ARG 219.88%，远高于其余数据（其余都不超过 91.44%）");
  assert.match(high.candidate_notes.computed, /^根据……数据计算，ARG 220%/);
  for (const text of Object.values(high.candidate_notes)) assert.ok(!/异常|错误|因为|由于/.test(text), text);

  const dumb = probeExtremes({ chart_type: "dumbbell", category_field: "iso3", start_field: "infl_start", end_field: "infl_end", unit: "%", language: "zh" }, fixture("q5_dumbbell"));
  near(pick(dumb, "high").d, 1.393361, "q5 dumbbell high");
  assert.equal(pick(dumb, "high").n, 10, "10 pairs, not 20 endpoints");
  assert.equal(pick(dumb, "high").object, "ARG");

  const fx = probeExtremes(bar({ chart_type: "diverging_bar", category_field: "currency", value_field: "pct_change", unit: "%" }), fixture("t13_fx"));
  near(pick(fx, "high").d, 2.495412, "T13 high");
  assert.equal(pick(fx, "high").object, "TRY");
  assert.equal(pick(fx, "high").n, 12);
  assert.equal(pick(fx, "high").value, 89.97466757621153);

  const life = probeExtremes(bar({ category_field: "iso3", value_field: "life", unit: "岁" }), fixture("t8_life"));
  near(pick(life, "low").d, 1.176353, "T8 low");
  assert.equal(pick(life, "low").object, "CAF");
  assert.equal(pick(life, "low").value, 18.8177);
  assert.ok(pick(life, "low").candidate_notes.display_rounded.includes("远低于其余数据（其余都不低于"), pick(life, "low").candidate_notes.display_rounded);
  assert.ok(pick(life, "high").d < EXTREME_PROBE_CANDIDATE_D, "the high end of life expectancy is not far");

  const forest = probeExtremes(bar({ chart_type: "diverging_bar", category_field: "iso3", value_field: "change", unit: "公顷" }), fixture("t12_forest"));
  near(pick(forest, "low").d, 1.294664, "T12 Brazil low");
  assert.equal(pick(forest, "low").object, "BRA");
}

// ---- 2. edge cases ------------------------------------------------------------------------------------------------
{
  // the remaining data span 0: degenerate, no epsilon, no Infinity / NaN anywhere in the JSON
  const flat = probeExtremes(bar(), rowsOf([5, 5, 5, 5, 5, 5, 100]));
  const high = pick(flat, "high");
  assert.equal(high.status, "degenerate");
  assert.equal(high.d, null);
  assert.equal(high.candidate_trigger, false);
  assert.equal(high.candidate_notes, undefined, "no note without a D");
  assert.ok(!/Infinity|NaN|e\+\d{2}/.test(JSON.stringify(flat)), JSON.stringify(flat));

  // fewer than 6 objects: no D (a dumbbell of 4 pairs has 8 cells and still counts 4)
  const few = probeExtremes(bar(), rowsOf([1, 2, 3, 4, 100]));
  assert.deepEqual(few.records.map((r) => [r.status, r.n, r.d]), [["too_few_objects", 5, null], ["too_few_objects", 5, null]]);
  const dumb4 = probeExtremes({ chart_type: "dumbbell", category_field: "k", start_field: "a", end_field: "b" }, [1, 2, 3, 4].map((i) => ({ k: `p${i}`, a: i, b: i + 100 })));
  assert.equal(pick(dumb4, "high").status, "too_few_objects");
  assert.equal(pick(dumb4, "high").n, 4);
  const dumb6 = probeExtremes({ chart_type: "dumbbell", category_field: "k", start_field: "a", end_field: "b" }, [1, 2, 3, 4, 5, 6].map((i) => ({ k: `p${i}`, a: i, b: i + 1 })));
  assert.equal(pick(dumb6, "high").n, 6);
  assert.equal(pick(dumb6, "high").status, "ok");

  // a tie at one end: the nearest value is equal, D is 0 and it never fires; the other end is still computed
  const tie = probeExtremes(bar(), rowsOf([1, 2, 3, 4, 90, 90, 6]));
  assert.equal(pick(tie, "high").status, "tie");
  assert.equal(pick(tie, "high").d, 0);
  assert.equal(pick(tie, "high").candidate_trigger, false);
  assert.equal(pick(tie, "low").status, "ok");

  // both ends far: each end is computed with the other kept among the others; both are reported and flagged
  const both = probeExtremes(bar(), rowsOf([-1000, 10, 11, 12, 13, 14, 1000]));
  near(pick(both, "high").d, 986 / 1014, "both ends, high");
  near(pick(both, "low").d, 1010 / 990, "both ends, low");
  assert.equal(pick(both, "high").limitation, "both_ends_far");
  assert.equal(pick(both, "low").limitation, "both_ends_far");
  assert.equal(pick(probeExtremes(bar(), rowsOf([10, 11, 12, 13, 14, 15, 1000])), "high").limitation, undefined, "one far end is not flagged");

  // log axis: judged in log10 space; zero and negative values are left to the old log-axis gate and not used here
  const decades = [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7].map((v, i) => ({ id: `d${i}`, x: v, y: i }));
  const scatter = (xs) => ({ chart_type: "scatter", label_field: "id", x_field: "x", y_field: "y", x_scale: xs });
  const logProbe = probeExtremes(scatter("log"), decades);
  const linProbe = probeExtremes(scatter("linear"), decades);
  const xHigh = (p) => p.records.find((r) => r.metric === "x" && r.end === "high");
  near(xHigh(logProbe).d, 0.2, "log x");
  assert.ok(xHigh(linProbe).d > 5, `linear x: ${xHigh(linProbe).d}`);
  assert.equal(xHigh(logProbe).log_space, true);
  assert.equal(xHigh(logProbe).value, 1e7, "the reported value is the real one, not its log");
  const withZero = probeExtremes(scatter("log"), [{ id: "z", x: 0, y: 1 }, { id: "n", x: -4, y: 2 }, ...decades]);
  assert.ok(!/Infinity|NaN/.test(JSON.stringify(withZero)));

  // invalid values are dropped before anything is counted
  const dirty = probeExtremes(bar(), [...rowsOf([1, 2, 3, 4, 5, 6]), { k: "n", v: null }, { k: "s", v: "n/a" }, { k: "e", v: "" }, { k: "i", v: Infinity }]);
  assert.equal(pick(dirty, "high").n, 6);

  // the same object listed twice with the same value counts once; with different values it is ambiguous
  const dup = probeExtremes(bar(), [...rowsOf([1, 2, 3, 4, 5, 6]), { k: "o2", v: 2 }]);
  assert.equal(pick(dup, "high").n, 6);
  assert.equal(pick(probeExtremes(bar(), [...rowsOf([1, 2, 3, 4, 5, 6]), { k: "o2", v: 9 }]), "high").status, "ambiguous_object");

  // groups: one set per series, each with its own D; a chart type the probe does not know gets one explicit record
  const grouped = probeExtremes(bar({ series_field: "s" }), [...rowsOf([1, 2, 3, 4, 5, 6]).map((r) => ({ ...r, s: "A" })), ...rowsOf([1, 2, 3, 4, 5, 60]).map((r) => ({ ...r, s: "B" }))]);
  assert.equal(grouped.records.length, 4);
  assert.deepEqual(grouped.records.filter((r) => r.end === "high").map((r) => r.candidate_trigger), [false, true]);
  assert.deepEqual(probeExtremes({ chart_type: "sankey" }, []).records.map((r) => r.status), ["unsupported_chart"]);
  const series = probeExtremes({ chart_type: "multi_line", x_field: "t", value_field: "v", series_field: "s" }, [1, 2, 3].flatMap((t) => [1, 2, 3, 4, 5, 6, 7].map((i) => ({ t, s: `s${i}`, v: i === 7 && t === 3 ? 500 : i + t }))));
  assert.equal(pick(series, "high").period, "3");
  assert.equal(pick(series, "high").n, 7);
  assert.equal(pick(series, "high").object, "s7");
}

// ---- 3. the switch ------------------------------------------------------------------------------------------------
for (const [value, expected] of [[undefined, false], ["0", false], ["", false], ["yes", false], [" 1", false], ["on", false], ["true", false], ["11", false], ["1", true]]) {
  assert.equal(extremeProbeEnabled({ NEWSROOM_EXTREME_PROBE: value }), expected, JSON.stringify(value));
}

// The end-to-end sections run the real DuckDB through the harness (NEWSROOM_DUCKDB_BIN, default `duckdb`). Without it they print SKIP;
// NEWSROOM_REQUIRE_NO_SKIP=1 (exact) turns that into a failure so a run that must skip nothing cannot pass silently. The pure sections above and below still run.
const duckdbMissing = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT";
if (duckdbMissing) {
  console.log("SKIP: duckdb binary not found; the end-to-end probe checks did not run");
  if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") process.exit(1);
}
const results = [];
const walk = (dir, base = dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path, base) : [path.slice(base.length + 1)];
});
async function build(value, boundary = false) {
  const h = await loadNewsroom({ prefix: "extreme-probe-", env: { NEWSROOM_MOBILE_PAGES: undefined, NEWSROOM_EXTREME_PROBE: value, NEWSROOM_GROUP_BOUNDARY: boundary ? "1" : undefined } });
  const values = [10, 12, 14, 15, 17, 19, 21, 500];
  const csv = ["k,v", ...values.map((v, i) => `o${i + 1},${v}`)].join("\n") + "\n";
  const file = h.addData("A", csv);
  const sql = `SELECT k, v FROM read_csv_auto('${file}') ORDER BY v DESC`;
  const qa = await h.query(`SELECT k, v FROM read_csv_auto('${file}')`);
  const claim = await h.recordClaim("o8 is 500", [file], [qa]);
  const spec = {
    schema_version: "0.9.0", reader_task: "ranking", language: "en", title: "Values by object", takeaway: "o8 is largest at 500.", alt: "Bar chart of eight objects.",
    source_note: "Source: test data", claim_id: claim.claim_id, sql, unit: "units", chart_type: "horizontal_bar", category_field: "k", value_field: "v", highlight_values: ["o8"], sort: "desc",
  };
  const planRef = "visualizations/plans/plan.json";
  writeFileSync(join(h.art, planRef), JSON.stringify(spec));
  const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
  const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lint.details.lintRef });
  const strip = (text) => text.split(h.art).join("<ART>");
  const files = Object.fromEntries(walk(h.art).filter((p) => !p.startsWith("config/") && p !== "claims.jsonl" /* written before the render, carries a timestamp */).sort().map((p) => [p, sha256(strip(readFileSync(join(h.art, p), "latin1")))]));
  const out = { text: strip(JSON.stringify(render.content ?? render)), details: strip(JSON.stringify(render.details)), files };
  const probePaths = Object.keys(files).filter((p) => /^runtime\/extreme-probe\/extreme_probe-.*\.json$/.test(p));
  const probe = probePaths.length ? JSON.parse(readFileSync(join(h.art, probePaths[0]), "utf8")) : null;
  const reportPath = "runtime/group-boundary-report.json";
  const report = files[reportPath] ? JSON.parse(readFileSync(join(h.art, reportPath), "utf8")) : null;
  rmSync(h.tmp, { recursive: true, force: true });
  return { out, probePaths, probe, report };
}
if (!duckdbMissing) try {
  const off = await build(undefined);
  assert.equal(off.probePaths.length, 0);
  assert.ok(!Object.keys(off.out.files).some((p) => p.startsWith("runtime/extreme-probe/") || p.startsWith("shadow/extreme")), "off: no diagnosis folder at all, no empty list, no new field");
  for (const value of ["0", "", "yes", " 1", "on", "true", "11"]) {
    const other = await build(value);
    assert.deepEqual(other.out, off.out, `NEWSROOM_EXTREME_PROBE=${JSON.stringify(value)} must be byte-identical to unset`);
  }
  const on = await build("1");
  assert.equal(on.probePaths.length, 1, "on: exactly one new file");
  assert.equal(on.out.text, off.out.text, "on: the tool result is byte-identical");
  assert.equal(on.out.details, off.out.details, "on: the tool details are byte-identical");
  const { [on.probePaths[0]]: _added, ...rest } = on.out.files;
  assert.deepEqual(rest, off.out.files, "on: every other file (manifest, svg, qa report, hashes) is byte-identical");
  assert.equal(on.probe.kind, "extreme_probe");
  assert.equal(on.probe.threshold_candidate, 1);
  assert.equal(on.probe.records.length, 2);
  const high = on.probe.records.find((r) => r.end === "high");
  assert.deepEqual([high.object, high.n, high.status, high.candidate_trigger], ["o8", 8, "ok", true]);
  near(high.d, (500 - 21) / (21 - 10), "end-to-end D");
  assert.ok(typeof on.probe.probe_ms === "number");

  // ---- 4. group-boundary report (NEWSROOM_GROUP_BOUNDARY=1): the diagnosis file is the agent group's own write ----
  const bOff = await build(undefined, true);
  const bOn = await build("1", true);
  assert.ok(bOff.report && bOn.report, "boundary report exists with the switch on");
  assert.equal(bOn.probePaths.length, 1);
  assert.equal(bOff.probePaths.length, 0);
  const rows = bOn.report.records.filter((r) => r.examples.includes(bOn.probePaths[0]));
  assert.equal(rows.length, 1, "the diagnosis file is recorded exactly once");
  assert.deepEqual(
    [rows[0].tool, rows[0].requested_by, rows[0].tool_group, rows[0].kind, rows[0].owner, rows[0].status, rows[0].count],
    ["extreme_probe_writer", "newsroom_viz_render", "agent", "project_state", "agent", "ok", 1],
    "listed as ok: written by the agent group's writer, the asking tool kept as requested_by",
  );
  assert.equal(bOn.report.totals.cross_group, bOff.report.totals.cross_group, "no new cross-group write");
  assert.equal(bOn.report.totals.to_check, bOff.report.totals.to_check, "no new 待查");
  assert.equal(bOn.report.totals.ok, bOff.report.totals.ok + 1, "exactly one more write, and it is ok");
  assert.equal(bOn.report.totals.writes, bOff.report.totals.writes + 1);
  const { [bOn.probePaths[0]]: _a, "runtime/group-boundary-report.json": _r1, ...restOn } = bOn.out.files;
  const { "runtime/group-boundary-report.json": _r2, ...restOff } = bOff.out.files;
  assert.deepEqual(restOn, restOff, "boundary on + probe on: every other file is byte-identical to probe off");
  assert.equal(bOn.out.text, bOff.out.text);
  results.push(bOn.report.totals);
} finally {
  // the harness folders are removed inside build()
}
// ---- D exactly at the candidate threshold triggers (>=, not >) ------------------------------------------------------
{
  const edge = pick(probeExtremes(bar(), rowsOf([0, 2, 4, 6, 8, 10, 20])), "high");  // gap 10, rest span 10 -> D = 1
  near(edge.d, 1, "D at threshold");
  assert.equal(edge.d, EXTREME_PROBE_CANDIDATE_D);
  assert.equal(edge.candidate_trigger, true);
}

if (results.length) console.log("boundary totals (probe on):", JSON.stringify(results[0]));
console.log("extreme probe: PASS");
