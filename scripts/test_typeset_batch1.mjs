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
  // a value that sits exactly on a half (1.25 is exact in binary): the label rounds half up (1.3, not the even 1.2) and the verifier agrees
  const halfRows = rows.map((r) => (r.country === "Liberia" ? { ...r, pop: 1.25 } : r));
  const halfSvg = withSwitch("NEWSROOM_TYPESET_CHOROPLETH_ZH", "1", () => renderVizBundle(wanSpec, halfRows, { mobilePages: false }).desktop);
  const halfTexts = valueTexts(halfSvg);
  assert.ok(halfTexts.includes("1.3 万人") && !halfTexts.includes("1.2 万人"), halfTexts.join("|"));
  assert.deepEqual(JSON.parse(py(halfSvg).stdout), [], "the verifier reads 1.25 as 1.3 under a 万 unit");
  const halfBad = py(halfSvg.replace(">1.3 万人<", ">1.2 万人<"));
  assert.ok(JSON.parse(halfBad.stdout).some((m) => m.includes("does not match")), halfBad.stdout);
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

// ---- K84 B: bare tick numbers, the unit once above the axis, one scale per axis -------------------------------------
{
  const base = { schema_version: "0.9.0", reader_task: "ranking", language: "zh", takeaway: "甲最多。", alt: "条形图。", source_note: "S", claim_id: "claim-axis-b", sql: "SELECT 1" };
  const barSpec = (title, unit) => ({ ...base, title, unit, chart_type: "horizontal_bar", category_field: "k", value_field: "v", highlight_values: ["甲"], sort: "desc" });
  const rowsOf = (pairs) => pairs.map(([k, v]) => ({ k, v }));
  const ticksOf = (svg) => [...svg.matchAll(/y="[\d.]+" text-anchor="middle"[^>]*fill="[^"]*">([^<]*)<\/text>/g)].map((m) => m[1]);
  const unitOf = (svg) => [...svg.matchAll(/data-role="axis-unit"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const draw = (spec, rows) => renderVizBundle(spec, rows, { mobilePages: false }).desktop;
  const pin = (spec, rows, ticks, unitLine) => {
    const { off, on } = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => { const svg = draw(spec, rows); return { ticks: ticksOf(svg), unit: unitOf(svg) }; });
    assert.deepEqual(off.unit, [], "off: no unit line");
    assert.deepEqual(on.ticks, ticks, `on: ${on.ticks}`);
    assert.deepEqual(on.unit, [unitLine], `on: ${on.unit}`);
    return { off, on };
  };
  // chart 1: refugees hosted by Germany at the end of 2023 (UNHCR), persons -> 万人
  const refugees = rowsOf([["乌克兰", 1097503], ["叙利亚", 705812], ["阿富汗", 255077], ["伊拉克", 146481], ["厄立特里亚", 67087], ["伊朗", 48224], ["土耳其", 44263], ["索马里", 36252], ["俄罗斯", 17437], ["尼日利亚", 13083], ["巴基斯坦", 9416], ["埃塞俄比亚", 7433]]);
  const c1 = pin(barSpec("2023 年底德国收容的难民，按来源国", "人"), refugees, ["0", "20", "40", "60", "80", "100"], "单位：万人");
  assert.ok(c1.off.ticks.some((t) => /万/.test(t)), `defect: ${c1.off.ticks}`);
  // chart 3: population of ten countries, persons -> 亿人
  const people = rowsOf([["俄罗斯", 145440502], ["墨西哥", 129739761], ["埃塞俄比亚", 128691695], ["日本", 124370947], ["菲律宾", 114891199], ["埃及", 114535772], ["刚果（金）", 105789733], ["越南", 100352189], ["伊朗", 90608708], ["土耳其", 87270502]]);
  pin(barSpec("2023 年人口排第 9 到 18 位的国家", "人"), people, ["0", "0.5", "1"], "单位：亿人");
  // chart 2: the mirrored bar, 万人 already in the unit -> numbers only, no second 万
  const stock = [["美国", 2562, 2675], ["德国", 838, 838], ["沙特阿拉伯", 1064, 305], ["英国", 610, 574], ["法国", 438, 480], ["西班牙", 429, 458], ["加拿大", 417, 463], ["阿联酋", 549, 267], ["澳大利亚", 394, 417], ["俄罗斯", 374, 386]];
  const mirror = { ...base, title: "2024 年国际移民存量：男性与女性，主要目的地", unit: "万人", chart_type: "mirrored_bar", category_field: "k", series_field: "s", value_field: "v", left_series: "男性" };
  const mirrorRows = stock.flatMap(([k, m, f]) => [{ k, s: "男性", v: m }, { k, s: "女性", v: f }]);
  const mirrorTicks = (svg) => [...svg.matchAll(/data-role="axis-tick-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const m = onOffNear("NEWSROOM_TYPESET_AXIS_NOTATION", () => { const svg = draw(mirror, mirrorRows); return { ticks: mirrorTicks(svg), unit: unitOf(svg) }; });
  assert.deepEqual(m.on.ticks, ["0", "0", "500", "500", "1000", "1000", "1500", "1500", "2000", "2000", "2500", "2500", "3000", "3000"], "step 500: the bare numbers are short enough for the finer axis");
  assert.deepEqual(m.on.unit, ["单位：万人"]);
  assert.deepEqual(m.off.unit, []);
  assert.ok(!m.on.ticks.some((t) => /万/.test(t)) && !unitOf(draw(mirror, mirrorRows)).length, "no 万 on a tick, no unit line with the switch off");
  // crossings: the largest tick decides the scale of the whole axis
  const spans = (max) => rowsOf([["甲", max], ["乙", max / 2]]);
  const span = (max, unit = "人") => withSwitch("NEWSROOM_TYPESET_AXIS_NOTATION", "1", () => { const svg = draw(barSpec("T", unit), spans(max)); return [ticksOf(svg), unitOf(svg)]; });
  assert.deepEqual(span(9000)[1], ["单位：人"], "under 1万: no scale");
  assert.ok(span(9000)[0].every((t) => !/万|亿/.test(t)));
  assert.deepEqual(span(12000)[1], ["单位：万人"], "just over 1万: 万");
  assert.ok(span(12000)[0].every((t) => !/万|亿/.test(t)));
  assert.deepEqual(span(99000000)[1], ["单位：万人"], "just under 1亿: still 万");
  assert.deepEqual(span(120000000)[1], ["单位：亿人"], "just over 1亿: 亿");
  // a unit that already carries a scale is not given a second one
  assert.deepEqual(span(30000, "万吨")[1], ["单位：万吨"], "no \"万 万吨\"");
  assert.ok(span(30000, "万吨")[0].every((t) => /^[\d.]+$/.test(t)), span(30000, "万吨")[0].join("|"));
  assert.deepEqual(span(3e9, "亿元")[1], ["单位：亿元"]);
  // English pages are not touched by B
  const enSpec = { ...barSpec("Count", ""), language: "en", unit: "people" };
  assert.deepEqual(withSwitch("NEWSROOM_TYPESET_AXIS_NOTATION", "1", () => unitOf(draw(enSpec, spans(30000000)))), [], "en: no unit line");
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
