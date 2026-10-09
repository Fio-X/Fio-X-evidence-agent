#!/usr/bin/env node
// Typesetting batch 1: every item is behind its own default-off switch that only the exact value "1" turns on.
// Each section proves (a) the defect is real with the switch off, (b) the switch removes it, (c) a near-miss value of the
// switch ("true", "0", "") does nothing. The off-state byte identity of every shipped fixture is the job of the existing
// snapshot tests (they run with all switches unset).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { axisTickTexts, fmt, halfUpFixed, renderVizBundle, tickLabel } from "../runtime/pi/viz.mjs";
import { composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SWITCHES = ["HALF_UP", "TREEMAP_ZH", "CHOROPLETH_ZH", "AXIS_NOTATION", "TABULAR_DIGITS", "FOOTER"].map((s) => `NEWSROOM_TYPESET_${s}`);
function withSwitch(name, value, fn) {
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  if (value !== undefined) process.env[name] = value;
  try { return fn(); } finally {
    for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const NEAR_MISSES = ["true", "0", "", "yes", "11"];
function onOffNear(name, run) {
  const off = withSwitch(name, undefined, run);
  const on = withSwitch(name, "1", run);
  for (const v of NEAR_MISSES) assert.deepEqual(withSwitch(name, v, run), off, `${name}=${JSON.stringify(v)} must behave as off`);
  return { off, on };
}

// ---- K87: round half up on the exact decimal value -------------------------------------------------------------
{
  const run = () => [11500, 12500, 10800, 11000, 15000, -11500].map((v) => [fmt(v, "", null, "zh"), fmt(v)]);
  const { off, on } = onOffNear("NEWSROOM_TYPESET_HALF_UP", run);
  assert.deepEqual(off[0], ["1.1万", "12k"], "defect: 11500 prints 1.1万 in zh and 12k in en");
  assert.deepEqual(on.map((x) => x[0]), ["1.2万", "1.3万", "1.1万", "1.1万", "1.5万", "-1.2万"]);
  assert.deepEqual(on.map((x) => x[1]), ["12k", "13k", "11k", "11k", "15k", "-12k"], "zh and en agree on every half");
  // the exact-decimal helper, away from the float traps
  withSwitch("NEWSROOM_TYPESET_HALF_UP", "1", () => {
    assert.equal(halfUpFixed(11500, 4, 1), "1.2");
    assert.equal(halfUpFixed(1.005, 0, 2), "1.01"); // toFixed(2) gives 1.00
    assert.equal(halfUpFixed(0.125, 0, 2), "0.13");
    assert.equal(halfUpFixed(-0.125, 0, 2), "-0.13");
    assert.equal(halfUpFixed(1e21, 4, 1), "100000000000000000.0");
    assert.equal(halfUpFixed(1.5e-7, 6, 3), "0.000");
    assert.equal(halfUpFixed(0, 0, 1), "0.0");
    assert.equal(halfUpFixed(99950, 3, 0), "100");
  });
  assert.equal(withSwitch(undefined, undefined, () => halfUpFixed(1.005, 0, 2)), "1.00", "off: exactly toFixed");
}

// ---- K95: Chinese treemap labels use 万 / 亿 ---------------------------------------------------------------------
{
  const claim = "claim-treemap-typeset";
  const spec = (unit) => ({
    schema_version: "0.9.0", reader_task: "part_to_whole", language: "zh", title: "预算构成", takeaway: "甲占大头。",
    alt: "预算构成的树图，面积与金额成正比。", source_note: "示例数据", claim_id: claim, sql: "SELECT 1", unit,
    chart_type: "treemap", category_field: "项目", value_field: "金额", highlight_values: [], annotations: [],
  });
  const rows = [{ 项目: "甲", 金额: 10800 }, { 项目: "乙", 金额: 6200 }, { 项目: "丙", 金额: 3100 }];
  for (const [unit, offText, onText] of [["$", "$10.8k".replace("$10.8k", "11k美元"), "1.1万美元"], ["$M", "11k百万美元", "10,800百万美元"]]) {
    const run = () => renderVizBundle(spec(unit), rows, { mobilePages: false }).desktop;
    const { off, on } = onOffNear("NEWSROOM_TYPESET_TREEMAP_ZH", run);
    assert.ok(off.includes(offText), `defect with the switch off: ${offText}`);
    assert.ok(on.includes(onText), `switch on: ${onText}`);
    assert.ok(!/\d(k|m|bn)[^a-z]/.test(on.replace(/<[^>]*>/g, "")), "no k / m / bn left in the visible text");
  }
}

// ---- K96: Chinese choropleth labels, read back exactly by both verifiers ------------------------------------------
{
  const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
  const claim = "claim-choropleth-typeset";
  const spec = {
    schema_version: "0.9.0", reader_task: "spatial", language: "zh", title: "各国人口", alt: "非洲多国人口的分级设色地图，颜色越深人口越多。",
    source_note: "示例数据", claim_id: claim, sql: "SELECT 1", unit: "人", chart_type: "choropleth", category_field: "country", value_field: "pop",
    category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "acknowledge", basemap_id: basemap.id,
    basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [],
  };
  const rows = [
    { country: "Chad", year: 2022, pop: 11500.5 }, { country: "Guinea", year: 2022, pop: 12500.5 }, { country: "Niger", year: 2022, pop: 123456789.5 },
    { country: "Liberia", year: 2022, pop: 8765.5 }, { country: "Mauritania", year: 2022, pop: 15000.5 },
  ];
  const choropleth = { rows, category_field: "country", value_field: "pop", category_names: "worldbank", unit: "人", language: "zh" };
  const render = () => renderVizBundle(spec, rows, { mobilePages: false }).desktop;
  const valueTexts = (svg) => [...svg.matchAll(/data-role="choropleth-(?:label|inset-label|footnote)-value"[^>]*>(?:<tspan[^>]*>)?([^<]*)/g)].map((m) => m[1]);
  const { off, on } = onOffNear("NEWSROOM_TYPESET_CHOROPLETH_ZH", render);
  assert.ok(valueTexts(off).some((t) => /\d(k|m)/.test(t)), `defect: k / m labels on a zh map: ${valueTexts(off)}`);
  const onTexts = valueTexts(on);
  assert.ok(onTexts.length >= 4, onTexts.join("|"));
  assert.ok(onTexts.every((t) => !/\d(k|m|bn)\b/.test(t)), onTexts.join("|"));
  assert.ok(onTexts.some((t) => t.includes("万")) && onTexts.some((t) => t.includes("亿")), onTexts.join("|"));
  assert.ok(onTexts.includes("8766 人"), `below 1万 among 万 values the number is an integer: ${onTexts}`);
  assert.ok(onTexts.includes("1.2万 人") && onTexts.includes("1.3万 人"), onTexts.join("|")); // 11500.5 -> 1.2万, 12500.5 -> 1.3万
  // render QA (the JS reader) re-derives the exact text; the switch must reach it through the options
  withSwitch("NEWSROOM_TYPESET_CHOROPLETH_ZH", "1", () => {
    const qa = runRenderQa({ desktop: on, mobile: on }, { choropleth });
    assert.equal(qa.value_labels?.passed ?? qa.viewports?.desktop?.value_labels?.passed, true, JSON.stringify(qa).slice(0, 800));
    const tampered = on.replace(">1.2万 人<", ">1.1万 人<");
    assert.notEqual(tampered, on, "fixture has the 1.2万 label");
    const bad = runRenderQa({ desktop: tampered, mobile: tampered }, { choropleth });
    assert.notEqual(bad.passed, true, "a label one tenth off must fail render QA");
  });
  // the Python verifier reads the same SVG back exactly; the Rust one has unit tests on the same table
  const py = (svg) => spawnSync("python3", ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import verify_artifact as va; import json; print(json.dumps(va.verify_choropleth_labels_from_svg(sys.stdin.read())))", here], { input: svg, encoding: "utf8" });
  const good = py(on);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), [], good.stdout);
  const tampered = on.replace(">1.2万 人<", ">1.1万 人<");
  const bad = py(tampered);
  assert.ok(JSON.parse(bad.stdout).some((m) => m.includes("does not match")), bad.stdout);
  // the integer below 1万 is read back exactly too: a label one off, or a decimal label where the integer rule applies, fails
  const wrongInt = py(on.replace(">8766 人<", ">8765 人<"));
  assert.ok(JSON.parse(wrongInt.stdout).some((m) => m.includes("does not match")), wrongInt.stdout);
  const decimalAmongWan = py(on.replace(">8766 人<", ">8765.5 人<"));
  assert.deepEqual(JSON.parse(decimalAmongWan.stdout), [], "a decimal label stays on the ordinary reader (tolerance)");
  // every value under 1万: the one-decimal label is unchanged by the integer rule
  const smallRows = rows.map((r, i) => ({ ...r, pop: 1000.5 + i * 100 }));
  const small = valueTexts(withSwitch("NEWSROOM_TYPESET_CHOROPLETH_ZH", "1", () => renderVizBundle(spec, smallRows, { mobilePages: false }).desktop));
  assert.ok(small.length >= 4 && small.every((t) => /^\d+\.\d 人$/.test(t)), small.join("|"));
  // a unit that already says 万: no second 万, plain one-decimal number, read back exactly
  const wanSpec = { ...spec, unit: "万人" };
  const wanSvg = withSwitch("NEWSROOM_TYPESET_CHOROPLETH_ZH", "1", () => renderVizBundle(wanSpec, rows, { mobilePages: false }).desktop);
  const wanTexts = valueTexts(wanSvg);
  assert.ok(wanTexts.length >= 4 && wanTexts.every((t) => /^\d+\.\d 万人$/.test(t)), wanTexts.join("|"));
  assert.ok(wanTexts.includes("11500.5 万人"), wanTexts.join("|"));
  assert.deepEqual(JSON.parse(py(wanSvg).stdout), [], "plain label with a 万 unit reads back");
  const wanBad = py(wanSvg.replace(">11500.5 万人<", ">11500.6 万人<"));
  assert.ok(JSON.parse(wanBad.stdout).some((m) => m.includes("does not match")), wanBad.stdout);
}

// ---- K84: one notation per axis ------------------------------------------------------------------------------------
{
  const zh = { language: "zh", unit: "个", chart_type: "bar" };
  const zhUnitWithScale = { language: "zh", unit: "万吨", chart_type: "bar" };
  const en = { language: "en", unit: "", chart_type: "bar" };
  const texts = (spec, ticks, unit, decimals) => axisTickTexts(spec, ticks, unit, decimals);
  const mixed = [0, 2000, 4000, 6000, 8000, 10000, 12000];
  const a = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => texts(zh, mixed, ""));
  assert.deepEqual(a.off, ["0", "2000", "4000", "6000", "8000", "1万", "1.2万"], "defect: plain numbers next to 万");
  assert.deepEqual(a.on, ["0", "0.2万", "0.4万", "0.6万", "0.8万", "1万", "1.2万"]);
  const bare = (list) => list.map((t) => t.replace(/ 万吨$/, ""));
  const b = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => bare(texts(zhUnitWithScale, [0, 5000, 10000, 15000], "万吨")));
  assert.deepEqual(b.off, ["0", "5000", "1万", "1.5万"]);
  assert.deepEqual(b.on, ["0", "5000", "10000", "15000"], "a unit that already says 万 never gets a second one");
  const c = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => texts(zh, [0, 5e7, 1e8, 1.5e8], ""));
  assert.deepEqual(c.on, ["0", "0.5亿", "1亿", "1.5亿"], "万 and 亿 never share an axis");
  const d = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => texts(en, [0, 5e8, 1e9, 1.5e9], ""));
  assert.deepEqual(d.off, ["0", "500m", "1bn", "1.5bn"]);
  assert.deepEqual(d.on, ["0", "0.5bn", "1bn", "1.5bn"]);
  const e = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => texts(en, [0, 2000, 4000, 6000], "", 0));
  assert.deepEqual(e.off, ["0", "2k", "4k", "6k"], "defect: the axis says 2k where the value labels say 2000");
  assert.deepEqual(e.on, ["0", "2000", "4000", "6000"], "the axis spells ticks the way the value labels do");
  // an axis that already uses one notation is unchanged with the switch on
  for (const ticks of [[0, 10000, 20000, 30000], [0, 2000, 4000, 6000], [0, 15000, 20000, 25000], [0, 0.2, 0.4]]) {
    const same = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => texts(zh, ticks, ""));
    assert.deepEqual(same.on, same.off, `single-notation axis ${ticks} must not change`);
  }
  assert.deepEqual(withSwitch("NEWSROOM_TYPESET_AXIS_NOTATION", "1", () => tickLabel(1.2e4, "", "zh")), "1.2万", "per-value tick spelling itself is untouched");
  // end to end: a rendered Chinese bar chart whose axis used to mix notations
  const barSpec = { schema_version: "0.9.0", reader_task: "ranking", language: "zh", title: "各区数量", takeaway: "甲最多。", alt: "各区数量的条形图。", source_note: "示例", claim_id: "claim-axis-typeset", sql: "SELECT 1", unit: "个", chart_type: "horizontal_bar", category_field: "区", value_field: "数量", highlight_values: [], annotations: [] };
  const barRows = [{ 区: "甲", 数量: 11800 }, { 区: "乙", 数量: 7300 }, { 区: "丙", 数量: 2100 }];
  const axisOf = (svg) => [...svg.matchAll(/y="[\d.]+" text-anchor="middle"[^>]*fill="[^"]*">([^<]*)<\/text>/g)].map((m) => m[1]);
  const bar = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => axisOf(renderVizBundle(barSpec, barRows, { mobilePages: false }).desktop));
  const classes = (list) => new Set(list.filter((t) => !/^0\b/.test(t)).map((t) => (/万|亿/.exec(t) ?? [""])[0]));
  assert.ok(classes(bar.off).size >= 2, `defect on the rendered chart: ${bar.off}`);
  assert.equal(classes(bar.on).size, 1, `one notation on the rendered chart: ${bar.on}`);
}

// ---- K85: equal-width digits ---------------------------------------------------------------------------------------
{
  const sample = { schema_version: "0.9.0", reader_task: "ranking", title: "T", takeaway: "A.", alt: "A bar chart.", source_note: "S", claim_id: "c", sql: "SELECT 1", unit: "pts", chart_type: "horizontal_bar", category_field: "k", value_field: "v", highlight_values: [], annotations: [] };
  const run = () => renderVizBundle(sample, [{ k: "a", v: 3 }, { k: "b", v: 2 }], { mobilePages: false }).desktop;
  const { off, on } = onOffNear("NEWSROOM_TYPESET_TABULAR_DIGITS", run);
  assert.ok(!off.includes("font-kerning"), "off: nothing added");
  assert.match(on.slice(0, 400), /<svg[^>]*font-kerning="none"/, "on: pair kerning is off (it narrows 11 against 66 even in tabular digits)");
  assert.ok(on.includes("'Helvetica Neue'") && !off.includes("'Helvetica Neue'"), "on: a font whose digits are all one width leads the stack");
  assert.ok(on.includes("PingFang SC"), "on: Chinese text still has its face");
}

// ---- K112: the footer ----------------------------------------------------------------------------------------------
{
  const claim = "claim-typeset-footer";
  const bar = { schema_version: "0.9.0", reader_task: "ranking", takeaway: "A leads.", chart_type: "horizontal_bar", title: "A leads", alt: "A bar chart.", source_note: "S", claim_id: claim, sql: "SELECT 1", unit: "pts", category_field: "category", value_field: "value", highlight_values: [], annotations: [] };
  const rows = [{ category: "A", value: 42 }, { category: "B", value: 31 }];
  const b = renderVizBundle(bar, rows);
  const assets = { "visualizations/bar.json": { desktopSvg: b.desktop, mobileSvg: b.mobile, manifest: { claim_id: claim, source_note: "S", chart_type: "horizontal_bar" } } };
  const page = (language) => ({
    schema_version: "1.0.0", kicker: "K", title: "Title", dek: "Dek.", alt: "A magazine page with a heading, one bar chart and a short explanation.", byline: "N", date_label: "D", source_note: "S", layout: "feature", complexity_budget: "medium", language,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "E", heading: "Heading", deck: "A short deck line." },
      { id: "bar", type: "visual", span: "full", label: "L", manifest_ref: "visualizations/bar.json" },
      { id: "text", type: "text", span: "full", label: "Why", heading: "Why it matters", body: "One short paragraph that explains the chart above in plain words.", claim_ids: [claim] },
    ],
  });
  const footer = (language) => composeInfographicBundle(page(language), assets).desktop.svg;
  for (const language of ["zh", "en"]) {
    const { off, on } = onOffNear("NEWSROOM_TYPESET_FOOTER", () => footer(language));
    assert.ok(off.includes("AGENTIC DATA NEWSROOM · VERIFIED VISUAL STORY"), `defect: ${language} page prints the fixed English line`);
    assert.ok(!on.includes("VERIFIED"), `${language}: the page is rendered before verification, so it never says VERIFIED`);
    assert.ok(off.includes("AGENTIC DATA NEWSROOM · 01"), `defect: ${language} page prints the English top-right line`);
    assert.ok(!on.includes("AGENTIC DATA NEWSROOM · 01"), `${language}: the top-right English line is gone`);
    assert.equal(on.includes(">AGENTIC DATA NEWSROOM</text>"), language === "en", `${language}: only an English page keeps the short English footer`);
  }
}

console.log("typeset batch 1 (K84, K85, K87, K95, K96, K112): PASS");
