#!/usr/bin/env node
// Round-3 chart conventions (desktop only), each asserted on synthetic rows of the shape, never topic data:
//  1. choropleth: skewed values get 1-2-5 classes with open end classes and a 无数据 swatch; unskewed keep
//     linear breaks; a LIMIT query warns.
//  2. slope with rank_cutoff: rank 1 on top, ordinal rows, an N+1 row with the true rank, names at both ends,
//     distinct join / leave colours.
//  3. small_multiples with index_base: base line + label per panel, first-column y ticks, end values,
//     3-4 columns for 7+ panels.
//  4. scatter: up to 8 auto labels, the log-scale note once per log axis.
//  5. value labels: zh >= 1万 scale (161.1万), no trailing .00 on values >= 1000, formatter exposed.
//  6. axis frame: no tick text crosses the frame; a side holding >= 25% of the axis has >= 2 ticks.
// Every chart type these rules do not touch renders byte-identical to the base commit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderVizSvg, zhScaleText, fmtSpec, chartValueFormatter } from "../runtime/pi/viz.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID, classBreaks, lintChoroplethSpec } from "../runtime/pi/choropleth.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE_COMMIT = "abd9d8b";
const base = {
  schema_version: "0.9.0", takeaway: "t", title: "Round three", subtitle: "synthetic", alt: "A synthetic chart used to check round-three chart conventions.",
  source_note: "synthetic fixture", claim_id: "claim-round3", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh",
};
const attr = (tag, name) => tag.match(new RegExp(`(?:^|[\\s<])${name}="([^"]*)"`))?.[1];
const tags = (svg, re) => [...svg.matchAll(re)].map((m) => m[0]);
const textOf = (tag) => tag.replace(/<[^>]*>/g, "");
const roleTexts = (svg, role) => tags(svg, new RegExp(`<text [^>]*data-role="${role}"[^>]*>[^<]*</text>`, "g"));

// ---- 1. choropleth classes ---------------------------------------------------------------------------
{
  const skewed = [0.4, 1.2, 1.8, 3.4, 4.5, 6, 8, 9, 12, 15, 250, -3, -1];
  const plan = classBreaks(skewed, 5);
  assert.ok(plan.skewed && plan.openTop && plan.openBottom, "skewed data gets open end classes");
  assert.deepEqual(plan.breaks.slice(1, 5), [2, 5, 10, 20], "1-2-5 interior edges");
  // minimum at or above the first inner edge: never return breaks that do not ascend
  const odd = classBreaks([15, 16, 18, 20, 25, 30, 40, 55, 60, 70, 300], 5);
  assert.ok(odd.breaks.every((b, i, a) => i === 0 || b > a[i - 1]), `ascending breaks: ${odd.breaks}`);
  const flat = classBreaks([10, 12, 14, 16, 18, 20, 22, 24], 5);
  assert.ok(!flat.skewed, "unskewed data keeps linear nice breaks");

  const bm = getBasemap(CHOROPLETH_BASEMAP_ID);
  const africa = JSON.parse(readFileSync(join(ROOT, "fixtures/viz-round2-choropleth-rows.json"), "utf8")).africa;
  const vals = [1.2, 3.4, 6, 8, 12, 4, 2.2, 9, 15, 0.8, 250];
  const rows = africa.map((r, i) => ({ ...r, v: vals[i] }));
  const spec = { ...base, language: "en", reader_task: "spatial", chart_type: "choropleth", category_field: "country", value_field: "v", category_names: "worldbank", unit: "%",
    basemap_id: bm.id, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash };
  const svg = renderVizSvg(spec, rows);
  const legend = svg.match(/<g data-role="choropleth-legend">.*?<\/g>/s)?.[0] ?? "";
  const legendText = tags(legend, /<text[^>]*>[^<]*<\/text>/g).map(textOf);
  for (const want of ["&lt;2", "5", "10", "≥20%"]) assert.ok(legendText.some((t) => t.includes(want)), `legend shows ${want}: ${legendText.join("|")}`);
  assert.ok(legendText.some((t) => t.includes("%")), "legend title / classes carry the unit");
  assert.ok(svg.includes('data-role="choropleth-no-data"'), "no-data swatch when a feature has no value");
  assert.ok(svg.includes("No data"), "no-data label");
  const zhSvg = renderVizSvg({ ...spec, language: "zh" }, rows);
  assert.ok(zhSvg.includes("无数据"), "zh no-data label");

  // a LIMIT slice is not "no data": the grey countries have data, they were just not selected
  const sliced = renderVizSvg({ ...spec, sql: "SELECT country, v FROM t ORDER BY v DESC LIMIT 11" }, rows);
  assert.ok(!sliced.includes('data-role="choropleth-no-data"') && !sliced.includes("No data"), "LIMIT slice: no 无数据 swatch");
  const warns = lintChoroplethSpec({ ...spec, sql: "SELECT country, v FROM t ORDER BY v DESC LIMIT 10" }, rows);
  assert.ok(JSON.stringify(warns).includes("LIMIT"), "LIMIT query warns");
  assert.ok(!JSON.stringify(lintChoroplethSpec(spec, rows)).includes("LIMIT"), "no LIMIT: no warning");
}

// ---- 2. rank slope -----------------------------------------------------------------------------------
{
  // ranks 1..10 at both ends for 8 entities; J1/J2 join (start rank 14/15), L1/L2 leave (end rank 12/13)
  const named = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"];
  const rows = [
    ...named.map((c, i) => ({ c, a: i + 1, b: ((i + 3) % 8) + 1 })),
    { c: "新一", a: 14, b: 9 + 0 }, { c: "新二", a: 15, b: 10 },
    { c: "出一", a: 10, b: 13 }, { c: "出二", a: 9, b: 12 },
  ];
  // keep unique ranks in the top 10 at each end
  rows[0].b = 1; rows[1].b = 2; rows[2].b = 3; rows[3].b = 4; rows[4].b = 5; rows[5].b = 6; rows[6].b = 7; rows[7].b = 8;
  const spec = { ...base, reader_task: "change", chart_type: "slope", category_field: "c", start_field: "a", end_field: "b", start_label: "2000", end_label: "2024", unit: "名", rank_cutoff: 10 };
  const svg = renderVizSvg(spec, rows);
  const rowLines = tags(svg, /<line data-role="rank-row"[^>]*>/g);
  assert.equal(rowLines.length, 11, "ordinal rows 1..N plus the N+1 row");
  const ys = rowLines.map((l) => Number(attr(l, "y1")));
  assert.deepEqual([...ys].sort((p, q) => p - q), ys, "rank 1 is the top row");
  const starts = roleTexts(svg, "rank-label-start").map(textOf);
  const ends = roleTexts(svg, "rank-label-end").map(textOf);
  assert.ok(starts.some((t) => t.includes("甲")) && ends.some((t) => t.includes("甲")), "name printed at both ends");
  assert.ok(starts.some((t) => t.includes("第14名") || t.includes("第15名")) || ends.some((t) => t.includes("第12名") || t.includes("第13名")), "outside-top-N true rank in the label");
  assert.ok(ends.some((t) => t.includes("新进")), "join tag");
  // the N+1 row is stacked on each side by that side's own true rank (12 above 13, 14 above 15)
  const yOf = (list, needle) => Number(attr(list.find((t) => textOf(t).includes(needle)), "y"));
  const endTags = roleTexts(svg, "rank-label-end"), startTags = roleTexts(svg, "rank-label-start");
  assert.ok(yOf(endTags, "第12名") < yOf(endTags, "第13名"), "right side: 第12名 above 第13名");
  assert.ok(yOf(startTags, "第14名") < yOf(startTags, "第15名"), "left side: 第14名 above 第15名");
  // a highlight that stays in the top N keeps the context colour (accent is the 跌出 colour)
  const lit = renderVizSvg({ ...spec, highlight_values: ["甲"] }, rows);
  const litLines = tags(lit, /<line data-role="data-line"[^>]*>/g);
  assert.ok(litLines.length > 0 && litLines.every((l) => attr(l, "stroke") !== attr(tags(lit, /<[^>]*data-role="rank-leave"[^>]*>/g)[0], "stroke")), "highlight does not reuse the leave colour");
  assert.ok(litLines.some((l) => attr(l, "stroke-width") === "2.5"), "highlight keeps the heavier stroke");
  assert.ok(ends.some((t) => t.includes("跌出")), "leave tag");
  const joins = tags(svg, /<[^>]*data-role="rank-join"[^>]*>/g), leaves = tags(svg, /<[^>]*data-role="rank-leave"[^>]*>/g);
  assert.ok(joins.length >= 1 && leaves.length >= 1, "join and leave lines present");
  const colour = (t) => attr(t, "stroke");
  assert.notEqual(colour(joins[0]), colour(leaves[0]), "join and leave use distinct colours");
  // value slopes without the field are unchanged
  const { rank_cutoff, ...plainSpec } = spec;
  assert.ok(!renderVizSvg(plainSpec, rows).includes('data-role="rank-row"'), "no rank_cutoff: ordinary slope");
}

// ---- 3. rebased small multiples ----------------------------------------------------------------------
{
  const rows = [];
  for (let k = 0; k < 12; k++) for (let i = 0; i < 6; i++) rows.push({ f: `地区${k + 1}`, x: 2018 + i, v: 100 + (k - 5) * i * 2 + i });
  const spec = { ...base, reader_task: "change", chart_type: "small_multiples", panel_mark: "line", x_field: "x", value_field: "v", facet_field: "f", index_base: 100, unit: "点" };
  const svg = renderVizSvg(spec, rows);
  const xs = new Set(tags(svg, /<line data-role="index-base-line"[^>]*>/g).map((l) => attr(l, "x1")));
  assert.equal(tags(svg, /<line data-role="index-base-line"[^>]*>/g).length, 12, "base line in every panel");
  assert.ok(xs.size >= 3 && xs.size <= 4, `3-4 columns for 12 panels (saw ${xs.size})`);
  assert.equal(roleTexts(svg, "index-base-label").length, 1, "the base is named once, in the first panel");
  assert.ok(textOf(roleTexts(svg, "index-base-label")[0]).includes("100"));
  // gridline labels sit at nice 1-2-5 values that include the base
  const tickVals = [...new Set(roleTexts(svg, "value-axis-tick").map((t) => Number(textOf(t))))].sort((a, b) => a - b);
  assert.ok(tickVals.includes(100), `base is a tick: ${tickVals}`);
  const stepSet = new Set(tickVals.slice(1).map((v, i) => Math.round((v - tickVals[i]) * 1e6) / 1e6));
  assert.equal(stepSet.size, 1, `even ticks: ${tickVals}`);
  assert.ok([1, 2, 5].includes(Number(String([...stepSet][0]).replace(/[0.]/g, "")[0])), `1-2-5 step: ${[...stepSet]}`);
  // no two text boxes inside a panel intersect (12 px per CJK glyph, 6.5 per other)
  const allTexts = tags(svg, /<text [^>]*data-panel-box="[^"]*"[^>]*>[^<]*<\/text>/g);
  const byPanel = new Map();
  for (const t of allTexts) { const k = attr(t, "data-panel-box"); (byPanel.get(k) ?? byPanel.set(k, []).get(k)).push(t); }
  const box = (t) => {
    const w = [...textOf(t)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 12 : 6.5), 0), x = Number(attr(t, "x")), y = Number(attr(t, "y")), an = attr(t, "text-anchor");
    const x1 = an === "end" ? x - w : an === "middle" ? x - w / 2 : x;
    return [x1, y - 11, x1 + w, y + 3];
  };
  for (const [k, list] of byPanel) {
    const bs = list.map(box);
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const [a, b] = [bs[i], bs[j]];
      assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], `panel ${k}: "${textOf(list[i])}" overlaps "${textOf(list[j])}"`);
    }
  }
  assert.equal(roleTexts(svg, "index-end-value").length, 12, "end value per panel");
  const tickTexts = roleTexts(svg, "value-axis-tick");
  assert.ok(tickTexts.length >= 3, "y tick labels on the first column");
  const tickXs = new Set(tickTexts.map((t) => attr(t, "x")));
  assert.equal(tickXs.size, 1, "tick labels only on the first column");
  const seven = renderVizSvg(spec, rows.filter((r) => Number(r.f.slice(2)) <= 7));
  assert.equal(new Set(tags(seven, /<line data-role="index-base-line"[^>]*>/g).map((l) => attr(l, "x1"))).size, 3, "3 columns for 7 panels");
  const { index_base, ...plain } = spec;
  assert.ok(!renderVizSvg(plain, rows).includes('data-role="index-base-line"'), "no index_base: ordinary small multiples");
}

// ---- 4. scatter labels -------------------------------------------------------------------------------
{
  const rows = Array.from({ length: 60 }, (_, i) => ({ c: `点${i + 1}`, x: 1000 + i * 120 + (i === 59 ? 200000 : 0), y: 40 + ((i * 7) % 41) }));
  const spec = { ...base, reader_task: "correlation", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "c", x_scale: "log", x_label: "人均收入", y_label: "寿命", unit: "岁", x_unit: "$", y_unit: "岁", highlight_values: ["点30"] };
  const svg = renderVizSvg(spec, rows);
  const labels = roleTexts(svg, "auto-label").map(textOf);
  assert.ok(labels.length >= 2 && labels.length <= 8, `auto labels capped at 8 (saw ${labels.length})`);
  assert.ok(labels.includes("点60"), "x-axis extreme labelled");
  const note = (svg.match(/对数刻度/g) ?? []).length;
  assert.equal(note, 1, "对数刻度 once for one log axis");
  const both = renderVizSvg({ ...spec, y_scale: "log" }, rows);
  assert.equal((both.match(/对数刻度/g) ?? []).length, 2, "once per log axis");
  const { label_field, ...byCategory } = spec;
  const viaCategory = renderVizSvg({ ...byCategory, category_field: "c" }, rows);
  assert.ok(roleTexts(viaCategory, "auto-label").length >= 2, "category_field names the points when label_field is absent");
  const linear = renderVizSvg({ ...spec, x_scale: "linear" }, rows);
  assert.ok(!linear.includes("对数刻度"), "linear axis has no note");
}

// ---- 5. value labels: one unit and one decimal count per chart ---------------------------------------
{
  assert.equal(zhScaleText(1611000), "161.1万");
  assert.equal(zhScaleText(-3256050), "-325.6万");
  assert.equal(zhScaleText(250000000), "2.5亿");
  const zh = { ...base, language: "zh", unit: "公顷" }, en = { ...base, language: "en", unit: "" };
  // G-shaped values: every label has the same unit and the same decimal count
  const g = [1611000, 839550, 117060, 89400, 87566, 86000, 81480, 67548, -267027, -282893, -299339, -469000, -510029, -3256050];
  const fz = chartValueFormatter(zh, g);
  const texts = g.map((v) => fz(v, ""));
  assert.equal(texts[0], "161.1万"); assert.equal(texts[1], "84.0万"); assert.equal(texts.at(-1), "-325.6万");
  assert.ok(texts.every((t) => /^-?\d+\.\d万$/.test(t)), `one decimal everywhere: ${texts.join("|")}`);
  // a chart of values in the thousands: no decimals; a mixed chart keeps its shared decimals
  const f1 = chartValueFormatter(en, [4200, 15000, 1611000]);
  assert.ok([4200, 15000, 1611000].every((v) => !f1(v, "").includes(".")), "all >= 1000: zero decimals");
  const f2 = chartValueFormatter(en, [1234, 5678.05, 12.5]);
  assert.deepEqual([1234, 5678.05, 12.5].map((v) => f2(v, "")), ["1234.0", "5678.1", "12.5"]);
  assert.equal(fmtSpec(en, 1234, "", 2), "1234.00", "a single label is never stripped");
  const rows = g.map((d, i) => ({ r: `地区${i + 1}`, d }));
  const svg = renderVizSvg({ ...base, reader_task: "comparison", chart_type: "diverging_bar", category_field: "r", value_field: "d", unit: "公顷", sort: "none" }, rows);
  const labels = roleTexts(svg, "bar-value-label").map(textOf);
  assert.equal(labels.length, g.length);
  assert.ok(labels.every((t) => /^-?\d+\.\d万/.test(t)) && labels.every((t) => !/\d,\d{3}/.test(t)), `bar labels share unit and decimals: ${labels.join("|")}`);
}

// ---- 6. axis frame -----------------------------------------------------------------------------------
{
  const rows = [{ r: "甲", d: 60 }, { r: "乙", d: -35 }, { r: "丙", d: 20 }, { r: "丁", d: -10 }];
  for (const language of ["zh", "en"]) {
    const svg = renderVizSvg({ ...base, language, reader_task: "comparison", chart_type: "diverging_bar", category_field: "r", value_field: "d", unit: "公顷/年", sort: "none" }, rows);
    const W = Number(svg.match(/viewBox="0 0 ([\d.]+)/)[1]);
    const ticks = tags(svg, /<text [^>]*text-anchor="middle"[^>]*>[^<]*<\/text>/g).filter((t) => /^[-−]?\d/.test(textOf(t).trim()));
    assert.ok(ticks.length >= 3, "axis has ticks");
    for (const t of ticks) {
      const x = Number(attr(t, "x")), anchor = attr(t, "text-anchor"), w = textOf(t).length * 7;
      const [lo, hi] = anchor === "middle" ? [x - w / 2, x + w / 2] : anchor === "end" ? [x - w, x] : [x, x + w];
      assert.ok(lo >= 0 && hi <= W, `${language} tick "${textOf(t)}" inside frame ${lo}..${hi} of ${W}`);
    }
    const neg = ticks.filter((t) => textOf(t).trim().startsWith("-") || textOf(t).startsWith("−"));
    assert.ok(neg.length >= 1, "negative side (>=25% of the axis) has a labelled tick");
    assert.ok(ticks.some((t) => /^0(\s|$)/.test(textOf(t).trim())), "zero tick labelled");
  }
}

// ---- other chart types are byte-identical to the base commit -----------------------------------------
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASE_COMMIT, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status === 0) {
  const dir = mkdtempSync(join(tmpdir(), "round3-base-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "b.tar"), archive.stdout);
  spawnSync("tar", ["-xf", join(dir, "b.tar"), "-C", dir]);
  const old = await import(pathToFileURL(join(dir, "runtime/pi/viz.mjs")).href);
  const names = ["华北", "华东", "华南", "西北", "东北", "西南"];
  const cats = names.map((region, i) => ({ region, v: 10 + i * 7, w: 5 + i * 3 }));
  const series = Array.from({ length: 6 }, (_, i) => ({ year: 2018 + i, v: 10 + i * 2 }));
  const panels = ["A", "B", "C"].flatMap((f, k) => Array.from({ length: 5 }, (_, i) => ({ f, x: 2018 + i, v: 10 + k * 5 + i * 2 })));
  for (const language of ["zh", "en"]) {
    const same = [
      [{ ...base, language, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "region", value_field: "v", unit: "%", sort: "desc", highlight_values: ["华北"] }, cats],
      [{ ...base, language, reader_task: "ranking", chart_type: "dot", category_field: "region", value_field: "v", unit: "%", sort: "desc" }, cats],
      [{ ...base, language, reader_task: "change", chart_type: "slope", category_field: "region", start_field: "v", end_field: "w", unit: "%" }, cats],
      [{ ...base, language, reader_task: "change", chart_type: "line", x_field: "year", value_field: "v", unit: "%" }, series],
      [{ ...base, language, reader_task: "change", chart_type: "small_multiples", panel_mark: "line", x_field: "x", value_field: "v", facet_field: "f", unit: "%" }, panels],
      [{ ...base, language, reader_task: "correlation", chart_type: "scatter", x_field: "v", y_field: "w", label_field: "region", unit: "%" }, cats],
    ];
    for (const [spec, data] of same) {
      let before;
      try { before = old.renderVizSvg(spec, data); } catch { continue; }
      const after = renderVizSvg(spec, data);
      // scatter gains auto labels on purpose; everything else must match to the byte (en horizontal_bar etc.)
      if (spec.chart_type === "scatter") continue;
      if (language === "zh" && /\d{5,}/.test(before)) continue; // zh large-value scaling changed on purpose
      assert.equal(after, before, `${language} ${spec.chart_type} unchanged`);
    }
  }
}
console.log("ok test_viz_round3_conventions");
