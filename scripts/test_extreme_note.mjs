#!/usr/bin/env node
// K117 stage 2 (fe order 1010h): pair D in the diagnosis record, and the program-written note under the chart (NEWSROOM_EXTREME_NOTE=1, default off).
//  1. pair D: the end value and the value next to it are one group; two far values side by side fire it, the single-value D is untouched;
//  2. the note text: "far above / below the rest of the data", three wordings (source value / rounded for display / computed), never "abnormal";
//     nothing written when nothing fires, when an object is listed twice with different values (ambiguous_object), without a source note,
//     for charts with several value sets, or when the text holds a number word;
//  3. end to end through the render tool: off states are byte-identical to unset (also with the probe on), on adds the note and nothing else.
import "./group_env_pin.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extremeNoteEnabled, extremeNoteText, pairDistance, probeExtremes } from "../runtime/pi/extreme_probe.mjs";
import { loadNewsroom, sha256 } from "./precision_harness.mjs";
import { REPORT as CALL_REPORT, expectRowsDelta, reportRows, callRows } from "./call_report_expect.mjs";

// Exact call-report rows (the report is always written now).
const PROBE_ONLY_ONLY_ON = callRows([
  "newsroom_viz_render visual extreme_probe_writer.mjs::writeExtremeProbeRecord agent t",
  "newsroom_viz_render visual groups.mjs::asHandoffWriter system t",
  "newsroom_viz_render visual shadow.mjs::runShadow knowledge t tool_allowed=true",
  "newsroom_viz_render visual shadow.mjs::shadowKey knowledge t",
]);

const bar = (extra = {}) => ({ chart_type: "horizontal_bar", category_field: "k", value_field: "v", unit: "", language: "zh", source_note: "公开统计", sql: "SELECT k, v FROM read_csv_auto('/x/a.csv')", ...extra });
const rowsOf = (values) => values.map((v, i) => ({ k: `国${i + 1}`, v }));
const pick = (probe, end) => probe.records.find((r) => r.end === end);
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 5e-7, `${label}: ${a} vs ${b}`);

// ---- 1. pair D -----------------------------------------------------------------------------------------------------
{
  // two far values side by side: the single D of each is tiny (the other one is its nearest neighbour), the pair D is 3.26-like
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 60, 62];
  const probe = probeExtremes(bar(), rowsOf(values));
  const high = pick(probe, "high");
  assert.ok(high.d < 0.05, `single D hidden by the neighbour: ${high.d}`);
  assert.equal(high.candidate_trigger, false, "the single-value rule is unchanged");
  assert.equal(high.pair_status, "ok");
  near(high.pair_d, (60 - 8) / (8 - 1), "pair D");
  assert.equal(high.pair_candidate_trigger, true);
  assert.deepEqual(high.pair_members, ["国10", "国9"]);
  assert.deepEqual(high.pair_values, [62, 60]);
  assert.equal(high.pair_rest_max, 8);
  assert.equal(pick(probe, "low").pair_candidate_trigger, false);
  // the single D value itself is the same number as before pair D existed
  near(high.d, (62 - 60) / (60 - 1), "single D value (62 vs 60, others 1..60)");
  // a single far value: both rules say what they said (the pair then includes the next value, which is in the crowd, and stays quiet)
  const one = pick(probeExtremes(bar(), rowsOf([10, 12, 14, 15, 17, 19, 21, 500])), "high");
  assert.equal(one.candidate_trigger, true);
  assert.equal(one.pair_candidate_trigger, false, "500 + 21 vs the rest 10..19: gap 2 / span 9");
  // pairDistance edges: fewer than two others, a tie, a flat rest
  const pts = (vs) => vs.map((v, i) => ({ object: `p${i}`, label: `p${i}`, value: v, raw: v }));
  assert.equal(pairDistance(pts([1, 2, 3]), "high").status, "too_few_objects");
  assert.equal(pairDistance(pts([1, 2, 9, 9, 40, 41]), "high").status, "ok");
  assert.equal(pairDistance(pts([5, 5, 5, 5, 40, 41]), "high").status, "degenerate");
  assert.equal(pairDistance(pts([1, 2, 3, 40, 40.5, 41]), "low").members.length, 2);
  assert.ok(!/Infinity|NaN/.test(JSON.stringify(probeExtremes(bar(), rowsOf([5, 5, 5, 5, 5, 5, 5, 5, 99, 100])))));
}

// ---- 2. the note text ----------------------------------------------------------------------------------------------
{
  const far = rowsOf([10, 12, 14, 15, 17, 19, 21, 500]);
  const zhNote = extremeNoteText(bar(), far);
  assert.equal(zhNote, "国8 500，远高于其余数据（其余都不超过 21）。");
  assert.equal(extremeNoteText(bar({ language: "en", unit: "units" }), far), "国8 500 units, far above the rest of the data (all others no higher than 21 units).");
  // low end, zh
  assert.equal(extremeNoteText(bar(), rowsOf([-400, 10, 12, 14, 15, 17, 19, 21])), "国1 -400，远低于其余数据（其余都不低于 10）。");
  // pair
  assert.equal(extremeNoteText(bar(), rowsOf([1, 2, 3, 4, 5, 6, 7, 8, 60, 62])), "国10 62、国9 60，远高于其余数据（其余都不超过 8）。");
  // wordings: source (as printed), rounded for display, computed from the query
  const dec = rowsOf([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 40.123456]);
  const rounded = extremeNoteText(bar(), dec);
  assert.match(rounded, /数值按图上取整显示。$/, rounded);
  assert.equal(rounded, "国8 40.1，远高于其余数据（其余都不超过 1.7）。数值按图上取整显示。", "the numbers are the chart's own rounding, not the raw 40.123456");
  assert.equal(extremeNoteText(bar(), rowsOf([1100.4, 1200.4, 1300.4, 1400.4, 1500.4, 1600.4, 1700.4, 90000.4])), "国8 9.0万，远高于其余数据（其余都不超过 1700）。数值按图上取整显示。");
  assert.ok(!/^按所给数据计算/.test(rounded));
  const computed = extremeNoteText(bar({ sql: "SELECT k, SUM(v) AS v FROM t GROUP BY k" }), far);
  assert.equal(computed, "按所给数据计算：国8 500，远高于其余数据（其余都不超过 21）。");
  assert.match(extremeNoteText(bar({ language: "en", sql: "SELECT k, a / b AS v FROM t" }), far), /^Calculated from the data: /);
  assert.ok(!/^按所给数据计算/.test(extremeNoteText(bar({ sql: "SELECT * FROM t" }), far)), "SELECT * is not arithmetic");
  assert.ok(!/^按所给数据计算/.test(extremeNoteText(bar({ sql: "SELECT k, v FROM read_csv_auto('/x/y.csv')" }), far)), "a path is not arithmetic");
  for (const note of [zhNote, rounded, computed]) assert.ok(!/异常|错误|因为|由于|离群|outlier|abnormal|error/i.test(note), note);
  // the displayed numbers are the chart's own (a value under 100 keeps its decimals in the chart's rule: take the formatter's answer)

  // nothing to say
  assert.equal(extremeNoteText(bar(), rowsOf([10, 12, 14, 15, 17, 19, 21, 25])), null, "nothing fires: no note");
  assert.equal(extremeNoteText(bar(), rowsOf([1, 2, 3, 4, 5])), null, "too few objects");
  assert.equal(extremeNoteText(bar({ source_note: "" }), far), null, "no source note: no note");
  assert.equal(extremeNoteText(bar({ source_note: "  " }), far), null);
  assert.equal(extremeNoteText({ chart_type: "sankey" }, far), null, "unsupported chart");
  // ambiguous: the same object registered twice with different values
  assert.equal(extremeNoteText(bar(), [...far, { k: "国3", v: 99 }]), null, "ambiguous_object: no note");
  assert.equal(pick(probeExtremes(bar(), [...far, { k: "国3", v: 99 }]), "high").status, "ambiguous_object");
  assert.equal(extremeNoteText(bar(), [...far, { k: "国3", v: 14 }]), zhNote, "the same value twice is one object");
  // several value sets (series / facets) and scatter: not written
  assert.equal(extremeNoteText(bar({ series_field: "s" }), [...far.map((r) => ({ ...r, s: "A" })), ...rowsOf([1, 2, 3, 4, 5, 6, 7, 8]).map((r) => ({ ...r, s: "B" }))]), null);
  assert.equal(extremeNoteText({ chart_type: "scatter", label_field: "k", x_field: "v", y_field: "w", unit: "", language: "zh", source_note: "公开统计" }, far.map((r, i) => ({ ...r, w: i }))), null);
  // a number word in the text (here in an object name) keeps the note out: the number-word check is not bypassed
  const worded = far.map((r) => (r.k === "国8" ? { ...r, k: "第三大国" } : r));
  assert.equal(extremeNoteText(bar(), worded), null, "number word: no note");
  assert.ok(extremeNoteText(bar(), far.map((r) => (r.k === "国8" ? { ...r, k: "乍得" } : r))));
}

// ---- 2b. the chart's own names, and the time point ----------------------------------------------------------------------
{
  // fe 1010: the sentence prints the names the chart prints (the renderer's own name table), never the data keys
  const codes = ["KOR", "CHN", "JPN", "USA", "FRA", "DEU", "SOM"];
  const vals = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1];
  const rows = codes.map((k, i) => ({ k, v: vals[i] }));
  const named = extremeNoteText(bar({ category_names: "iso3" }), rows);
  assert.equal(named, "索马里 6.1，远高于其余数据（其余都不超过 1.6）。");
  assert.ok(!/SOM/.test(named), "the data key is not printed");
  // a zh chart whose names cannot be shown in Chinese gets no sentence: it never falls back to the code
  assert.equal(extremeNoteText(bar(), rows), null, "no name table: no sentence");
  assert.equal(extremeNoteText(bar({ category_names: "iso3" }), rows.map((r) => (r.k === "SOM" ? { ...r, k: "ZZZ" } : r))), null, "unmapped code: no sentence");
  // an English chart prints the value as the chart does
  assert.equal(extremeNoteText(bar({ language: "en" }), rows), "SOM 6.1, far above the rest of the data (all others no higher than 1.6).");
  // several time points: the sentence says which one it is about
  const series = [];
  for (const year of [2000, 2023]) codes.forEach((k, i) => series.push({ k, year, v: year === 2023 ? vals[i] : (k === "KOR" ? 9 : 1) }));
  const sm = { chart_type: "small_multiples", x_field: "year", value_field: "v", facet_field: "k", category_names: "iso3", unit: "", language: "zh", source_note: "公开统计", sql: "SELECT k, year, v FROM read_csv_auto('/x/y.csv')" };
  assert.equal(extremeNoteText(sm, series), "2023 年，索马里 6.1，远高于其余数据（其余都不超过 1.6）。");
  assert.equal(extremeNoteText({ ...sm, language: "en" }, series), "2023: SOM 6.1, far above the rest of the data (all others no higher than 1.6).");
  assert.ok(!/^\d{4}/.test(extremeNoteText(bar({ category_names: "iso3" }), rows)), "a single-period chart has no time prefix");
}

// ---- 3. the switch -------------------------------------------------------------------------------------------------
for (const [value, expected] of [[undefined, false], ["0", false], ["", false], ["yes", false], [" 1", false], ["on", false], ["true", false], ["11", false], ["1", true]]) {
  assert.equal(extremeNoteEnabled({ NEWSROOM_EXTREME_NOTE: value }), expected, JSON.stringify(value));
}

// Section 4 runs the real DuckDB through the harness (NEWSROOM_DUCKDB_BIN, default `duckdb`); it is the last section, so without the binary
// it prints SKIP and stops. NEWSROOM_REQUIRE_NO_SKIP=1 (exact) turns that into a failure so a run that must skip nothing cannot pass silently.
if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") {
  console.log("SKIP: duckdb binary not found; the end-to-end render-tool checks (section 4) did not run");
  process.exit(process.env.NEWSROOM_REQUIRE_NO_SKIP === "1" ? 1 : 0);
}

// ---- 4. end to end through the render tool -------------------------------------------------------------------------
const walk = (dir, base = dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path, base) : [path.slice(base.length + 1)];
});
async function build(note, probe, values = [10, 12, 14, 15, 17, 19, 21, 500]) {
  const h = await loadNewsroom({ prefix: "extreme-note-", env: { NEWSROOM_GROUP_BOUNDARY: undefined, NEWSROOM_EXTREME_NOTE: note, NEWSROOM_EXTREME_PROBE: probe } });
  const csv = ["k,v", ...values.map((v, i) => `o${i + 1},${v}`)].join("\n") + "\n";
  const file = h.addData("A", csv);
  const sql = `SELECT k, v FROM read_csv_auto('${file}') ORDER BY v DESC`;
  const qa = await h.query(`SELECT k, v FROM read_csv_auto('${file}')`);
  const claim = await h.recordClaim("o8 is 500", [file], [qa]);
  const spec = {
    schema_version: "0.9.0", reader_task: "ranking", language: "en", title: "Values by object", takeaway: "o8 is largest at 500.", alt: "Bar chart of eight objects.",
    source_note: "Source: test data", claim_id: claim.claim_id, sql, unit: "units", note: "Prior note.", chart_type: "horizontal_bar", category_field: "k", value_field: "v", highlight_values: ["o8"], sort: "desc",
  };
  const planRef = "visualizations/plans/plan.json";
  writeFileSync(join(h.art, planRef), JSON.stringify(spec));
  const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
  const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lint.details.lintRef });
  // the draw step writes no render-QA record, the critic does; the critic runs here so the record exists to read
  const manifestRef = walk(h.art).find((p) => /^visualizations\/[0-9a-f]{64}\.json$/.test(p));
  await h.tools.get("newsroom_viz_critic").execute("k", { plan_ref: planRef, lint_ref: lint.details.lintRef, manifest_ref: manifestRef });
  const strip = (text) => text.split(h.art).join("<ART>");
  const raw = Object.fromEntries(walk(h.art).filter((p) => !p.startsWith("config/") && p !== "claims.jsonl" && p !== CALL_REPORT).sort().map((p) => [p, readFileSync(join(h.art, p), "utf8")]));
  const files = Object.fromEntries(Object.entries(raw).map(([p, t]) => [p, sha256(strip(t))]));
  const out = { text: strip(JSON.stringify(render.content ?? render)), details: strip(JSON.stringify(render.details)), files };
  const rows = reportRows(h.art); // the call report is left out of the file maps and compared by its rows below
  rmSync(h.tmp, { recursive: true, force: true });
  return { out, raw, rows };
}
const svgOf = (b) => Object.entries(b.raw).find(([p]) => /^visualizations\/[0-9a-f]{64}\.svg$/.test(p))?.[1];
const manifestOf = (b) => JSON.parse(Object.entries(b.raw).find(([p]) => /^visualizations\/[0-9a-f]{64}\.json$/.test(p))[1]);
const widths = (svg) => [...svg.matchAll(/<rect\b[^>]*\bwidth="([\d.]+)"/g)].map((m) => m[1]);

const off = await build(undefined, undefined);
for (const value of ["0", "", "yes", " 1", "on", "true", "11"]) {
  const other = await build(value, undefined);
  assert.deepEqual(other.out, off.out, `NEWSROOM_EXTREME_NOTE=${JSON.stringify(value)} must be byte-identical to unset`);
  expectRowsDelta(other.rows, off.rows, {}, `NEWSROOM_EXTREME_NOTE=${JSON.stringify(value)}: the same call report as unset`);
}
const probeOnly = await build(undefined, "1");
assert.equal(probeOnly.out.text, off.out.text);
assert.deepEqual(Object.fromEntries(Object.entries(probeOnly.out.files).filter(([p]) => !p.startsWith("runtime/extreme-probe/"))), off.out.files, "the probe alone changes no page, caption or manifest");
expectRowsDelta(probeOnly.rows, off.rows, { onlyInA: PROBE_ONLY_ONLY_ON }, "probe only vs off: call report");
assert.ok(!/far above the rest/.test(svgOf(off)));

const on = await build("1", undefined);
const svgOn = svgOf(on);
assert.ok(svgOn.includes("far above the rest of the data"), "the note is in the chart's note line");
assert.match(svgOn, /all others no higher than 21 units/);
const textBlocks = svgOn.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? [];
const withNote = textBlocks.filter((b) => b.includes("far above the rest"));
assert.equal(withNote.length >= 1, true);
assert.ok(withNote.every((b) => !b.includes("Prior note.")), "the extreme note is its own line, not joined to the other note");
assert.ok(textBlocks.some((b) => b.includes("Prior note.")), "the other note is still there");
assert.ok(/Note:?\s*/i.test(svgOn) || svgOn.includes("o8 500 units"), "caption text present");
assert.deepEqual(widths(svgOn), widths(svgOf(off)), "no bar changed: values and scale are untouched");
const mOn = manifestOf(on), mOff = manifestOf(off);
assert.equal(mOn.extreme_note, "o8 500 units, far above the rest of the data (all others no higher than 21 units).");
assert.equal(mOn.extreme_note_program, true);
assert.equal(mOn.data_hash, mOff.data_hash, "the data hash is the data's");
assert.equal(mOn.source_note, mOff.source_note);
assert.ok(!("render_qa" in mOn) && !("render_qa_ref" in mOn), "the manifest carries no render-QA record");
const criticRaw = Object.entries(on.raw).find(([p]) => /^visualizations\/critics\/.*\.json$/.test(p));
const qaRef = JSON.parse(criticRaw[1]).render_qa_ref;
assert.match(qaRef, /^visualizations\/qa\/[0-9a-f]{64}\.json$/, "the critic carries the render-QA ref");
assert.equal(JSON.parse(on.raw[qaRef]).passed, true, "render QA still passes (read from the critic's record)");
assert.notEqual(on.out.text, off.out.text, "the artifact key differs from the note-less one");
// every page-neutral file is the same: plan, lint, computation records
for (const p of Object.keys(off.out.files)) if (/^visualizations\/(plans|lints)\//.test(p)) assert.equal(on.out.files[p], off.out.files[p], p);
// no extreme: even with the switch on, the same bytes as off
const calm = await build("1", undefined, [10, 12, 14, 15, 17, 19, 21, 25]);
const calmOff = await build(undefined, undefined, [10, 12, 14, 15, 17, 19, 21, 25]);
assert.deepEqual(calm.out, calmOff.out, "switch on but nothing fires: byte-identical to off");
expectRowsDelta(calm.rows, calmOff.rows, {}, "calm vs off: call report");

console.log("extreme note: PASS");
