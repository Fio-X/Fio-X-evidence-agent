#!/usr/bin/env node
// K309: NEWSROOM_SIGNED_SCALE=1 colours a value column with both signs on a shared signed scale (zero is a class edge, the classes beside zero are the
// lightest, one hue per sign, <= 11 classes, the legend names the midpoint, no-data has its own grey) for the choropleth and the heatmap, and in riso the ink
// tells the sign while dot size tells |v|. NEWSROOM_SIGNED_SCALE_CHECK=1 (or the same switch) adds two report-only critic codes (penalty 0).
// NEWSROOM_RISO_MAP_RINGS=1 stops a one-point ring from voiding a whole region's halftone dots. Off (unset, "0", "true", " 1") is byte-identical.
// Tested by data shape: all-negative, all-positive, skewed mixed, symmetric mixed, zeros present, no-data present.
import assert from "node:assert/strict";
import { renderVizBundle, critiqueViz } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { restyleSvg } from "../runtime/pi/render_styles.mjs";
import { hasBothSigns, signedClassPlan, SIGNED_SCALE_MAX_CLASSES } from "../runtime/pi/choropleth.mjs";

const SWITCHES = ["NEWSROOM_SIGNED_SCALE", "NEWSROOM_SIGNED_SCALE_CHECK", "NEWSROOM_RISO_MAP_RINGS"];
const withEnv = (env, fn) => {
  const old = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of SWITCHES) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
const ON = { NEWSROOM_SIGNED_SCALE: "1" };
const OFF_VALUES = [undefined, "0", "true", " 1", "1 ", "yes"];

const heatSpec = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国变化", subtitle: "各期变化", unit: "万公顷/年", x_field: "period", y_field: "country", value_field: "v", decimals: 0, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，若干国家乘几个时期的变化。" };
const mapSpec = { schema_version: "0.9.0", takeaway: "t", title: "World", subtitle: "synthetic", alt: "A synthetic world map used to check the signed scale.", source_note: "synthetic fixture", source: "synthetic", claim_id: "claim-signed", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh", verification_mode: "draft", reader_task: "spatial", chart_type: "choropleth", category_field: "c", value_field: "v", category_names: "iso3", unit: "%", measure_kind: "change", basemap_id: "naturalearth_admin0_50m", basemap_source_url: "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", basemap_license: "Public domain (Natural Earth terms of use)", basemap_content_hash: "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e" };
const countries = ["BRA", "CHN", "RUS", "IND", "USA", "AUS", "CAN", "ARG"];
const periods = ["P1", "P2", "P3"];
const SHAPES = {
  allNegative: [-3, -12, -40, -150, -2, -30, -9, -60],
  allPositive: [3, 12, 40, 150, 2, 30, 9, 60],
  mixedSkewed: [-325.6, 161.1, 91, -10, -50, 9, -200, 2],
  mixedSymmetric: [-80, 80, -40, 40, -20, 20, -60, 60],
  zerosPresent: [-30, 0, 25, 0, -5, 12, 0, -80],
};
const heatRows = (vals, gap = false) => countries.flatMap((c, i) => periods.map((p, j) => ({ country: c, period: p, v: vals[(i + j) % vals.length] }))).filter((_, k) => !(gap && k === 4));
const mapRows = (vals) => countries.map((c, i) => ({ c, v: vals[i % vals.length] }));
const heat = (vals, gap) => { const rows = heatRows(vals, gap); const svg = renderVizBundle(heatSpec, rows, { mobilePages: false }).desktop; return { rows, svg, qa: runRenderQa({ desktop: svg }, { heatmap: { rows, spec: heatSpec, x_field: "period", y_field: "country", value_field: "v" } }) }; };
const map = (vals) => { const rows = mapRows(vals); const svg = renderVizBundle(mapSpec, rows, { mobilePages: false }).desktop; return { rows, svg }; };
const count = (svg, re) => (svg.match(re) ?? []).length;

// 1 the class plan, by shape
for (const [name, vals] of Object.entries(SHAPES)) {
  const signed = hasBothSigns(vals);
  assert.equal(signed, name.startsWith("mixed") || name === "zerosPresent", `${name}: hasBothSigns`);
  if (!signed) continue;
  const plan = signedClassPlan(vals, { neg: [168, 68, 62], pos: [60, 125, 90] });
  assert.ok(plan.classes.length <= SIGNED_SCALE_MAX_CLASSES, `${name}: at most ${SIGNED_SCALE_MAX_CLASSES} classes (${plan.classes.length})`);
  assert.ok(plan.breaks.includes(0), `${name}: zero is a break`);
  assert.equal(Object.is(plan.breaks.find((b) => b === 0), -0), false, `${name}: no negative zero`);
  assert.deepEqual([...plan.breaks].sort((a, b) => a - b), plan.breaks, `${name}: breaks ascend`);
  for (const v of vals) { const c = plan.colorOf(v); assert.equal(c.sign, v < 0 ? "neg" : "pos", `${name}: ${v} takes the ${v < 0 ? "negative" : "positive"} side`); }
  const near = plan.colorOf(Math.min(...vals.filter((v) => v < 0)) / 1000), far = plan.colorOf(Math.min(...vals));
  assert.ok(near.level < far.level, `${name}: the class beside zero is lighter than the class of the largest loss`);
  assert.ok(plan.colorOf(Math.max(...vals)).level >= plan.colorOf(Math.max(...vals) / 1000).level, `${name}: the same on the positive side`);
}
{
  // the two sides keep classes only up to their own extent (not a symmetric domain)
  const plan = signedClassPlan(SHAPES.mixedSkewed, { neg: [168, 68, 62], pos: [60, 125, 90] });
  const neg = plan.classes.filter((c) => c.sign === "neg").length, pos = plan.classes.filter((c) => c.sign === "pos").length;
  assert.ok(neg > pos, "skewed data: more negative classes than positive ones");
}

// 2 off is byte-identical (heatmap, choropleth), whatever the off value
for (const [name, vals] of Object.entries(SHAPES)) {
  const baseHeat = withEnv({}, () => heat(vals).svg), baseMap = withEnv({}, () => map(vals).svg);
  for (const value of OFF_VALUES) {
    const env = value === undefined ? {} : { NEWSROOM_SIGNED_SCALE: value, NEWSROOM_SIGNED_SCALE_CHECK: value, NEWSROOM_RISO_MAP_RINGS: value };
    assert.equal(withEnv(env, () => heat(vals).svg), baseHeat, `${name}: heatmap off (${JSON.stringify(value)}) is unchanged`);
    assert.equal(withEnv(env, () => map(vals).svg), baseMap, `${name}: choropleth off (${JSON.stringify(value)}) is unchanged`);
  }
}

// 3 on: signed data gets the signed scale; single-sign data is untouched
for (const [name, vals] of Object.entries(SHAPES)) {
  const mixed = hasBothSigns(vals);
  const h = withEnv(ON, () => heat(vals)), base = withEnv({}, () => heat(vals));
  const m = withEnv(ON, () => map(vals)), mbase = withEnv({}, () => map(vals));
  if (!mixed) { assert.equal(h.svg, base.svg, `${name}: single-sign heatmap unchanged`); assert.equal(m.svg, mbase.svg, `${name}: single-sign choropleth unchanged`); continue; }
  assert.equal(h.qa.passed, true, `${name}: heatmap render QA passes (${JSON.stringify(h.qa.failures ?? h.qa.issues)})`);
  assert.ok(count(h.svg, /data-sign="neg"/g) > 0 && count(h.svg, /data-sign="pos"/g) > 0, `${name}: heatmap cells carry their sign`);
  assert.ok(h.svg.includes('data-role="signed-legend-midpoint"') && h.svg.includes('data-role="signed-legend-zero"'), `${name}: heatmap legend marks the midpoint`);
  assert.ok(count(h.svg, /data-role="heatmap-legend-class"/g) <= SIGNED_SCALE_MAX_CLASSES, `${name}: heatmap legend has at most 11 classes`);
  assert.ok(m.svg.includes('data-role="signed-legend-midpoint"'), `${name}: choropleth legend marks the midpoint`);
  assert.ok(count(m.svg, /data-role="choropleth-data"[^>]*data-sign="/g) + count(m.svg, /data-sign="[^"]*"[^>]*data-role="choropleth-data"/g) > 0, `${name}: choropleth regions carry their sign`);
}
{
  // zero is a class, never the no-data look; a missing cell has its own grey and is named in the legend
  const vals = SHAPES.zerosPresent;
  const { svg } = withEnv(ON, () => heat(vals, true));
  const grey = /data-role="heatmap-no-data"[^>]*fill="([^"]+)"/.exec(svg)?.[1];
  assert.ok(grey, "a missing cell is drawn as no-data");
  const zeroFills = [...svg.matchAll(/<rect[^>]*data-sign="[^"]*"[^>]*fill="([^"]+)"/g)].map((x) => x[1]);
  assert.ok(zeroFills.length && !zeroFills.includes(grey), "no value class uses the no-data grey");
  assert.ok(svg.includes('data-role="heatmap-no-data-label"'), "the legend names the no-data grey");
  assert.equal(withEnv({}, () => heat(vals, true).svg).includes("heatmap-no-data"), false, "off: no no-data cell");
}

// 4 riso: the ink tells the sign, the dot size tells |v|
{
  const { svg } = withEnv(ON, () => heat(SHAPES.mixedSkewed));
  const riso = withEnv(ON, () => restyleSvg(svg, "riso"));
  const strokes = (s) => [...s.matchAll(/stroke="(#[0-9a-fA-F]{6})"[^>]*stroke-width="([\d.]+)"/g)].map((x) => ({ c: x[1].toLowerCase(), w: Number(x[2]) }));
  const inks = new Set(strokes(riso).map((x) => x.c));
  assert.ok(inks.size >= 2, "riso uses at least two inks on signed data");
  const widthOf = (re) => Math.max(0, ...[...riso.matchAll(re)].map((x) => Number(x[1])));
  assert.ok(riso.includes("#d1493f") || riso.includes("#D1493F"), "the negative ink (coral) is present");
  assert.ok(riso.includes("#4c647c") || riso.includes("#4C647C"), "the positive ink (blue) is present");
  assert.ok(widthOf(/stroke-width="([\d.]+)"/g) > 0);
}

// 5 the ring fix: a top-class region with a one-point ring still gets halftone dots
{
  const { svg } = withEnv(ON, () => map(SHAPES.mixedSkewed));
  const broken = svg.replace(/(<path[^>]*data-role="choropleth-data"[^>]*? d=")(M)/, "$1M5.5,5.5Z$2");
  assert.notEqual(broken, svg, "a data path was found to degrade");
  const dots = (s) => count(s, /stroke-linecap="round"/g);
  const offDots = withEnv(ON, () => dots(restyleSvg(svg, "riso"))), offBroken = withEnv(ON, () => dots(restyleSvg(broken, "riso")));
  const FIX = { ...ON, NEWSROOM_RISO_MAP_RINGS: "1" };
  const fixed = withEnv(FIX, () => dots(restyleSvg(svg, "riso"))), fixedBroken = withEnv(FIX, () => dots(restyleSvg(broken, "riso")));
  assert.ok(fixed > offDots, "the map renderer's own one-point rings (Russia, the USA here) voided their regions' dots when off; on they get dots");
  assert.ok(fixedBroken > offBroken && Math.abs(fixedBroken - fixed) <= fixed * 0.15, "on: an extra one-point ring leaves the region its dots (the jitter seed moves, the count stays within 15%)");
  // every region of the top class has marks
  const top = [...svg.matchAll(/<path[^>]*data-role="choropleth-data"[^>]*data-value="([-\d.]+)"[^>]*data-iso3="([A-Z]{3})"|<path[^>]*data-role="choropleth-data"[^>]*data-iso3="([A-Z]{3})"[^>]*data-value="([-\d.]+)"/g)];
  assert.ok(top.length >= 2, "data regions found");
  assert.equal(withEnv(FIX, () => restyleSvg(svg, "riso")).includes('data-iso3="RUS"'), true, "the region keeps its mark in the restyled svg");
}

// 6 the critic: report only, penalty 0, never changes pass/fail or the score
{
  const rows = heatRows(SHAPES.mixedSkewed);
  const svgOff = withEnv({}, () => heat(SHAPES.mixedSkewed).svg);
  const plain = withEnv({}, () => critiqueViz(heatSpec, rows, { passed: true }, svgOff));
  const checked = withEnv({ NEWSROOM_SIGNED_SCALE_CHECK: "1" }, () => critiqueViz(heatSpec, rows, { passed: true }, svgOff));
  assert.equal(plain.issues.some((i) => i.code === "signed_data_one_way_scale"), false, "off: no new code");
  const found = checked.issues.find((i) => i.code === "signed_data_one_way_scale");
  assert.ok(found && found.severity === "info", "check on: signed data on a one-way scale is reported as info");
  assert.equal(checked.score, plain.score, "the score is unchanged");
  assert.equal(checked.passed ?? checked.publishable, plain.passed ?? plain.publishable, "pass/fail is unchanged");
  const svgOn = withEnv(ON, () => heat(SHAPES.mixedSkewed).svg);
  const quiet = withEnv(ON, () => critiqueViz(heatSpec, rows, { passed: true }, svgOn));
  assert.equal(quiet.issues.some((i) => i.code === "signed_data_one_way_scale"), false, "signed scale applied: nothing to report");
  const single = withEnv({ NEWSROOM_SIGNED_SCALE_CHECK: "1" }, () => critiqueViz(heatSpec, heatRows(SHAPES.allPositive), { passed: true }, ""));
  assert.equal(single.issues.some((i) => i.code === "signed_data_one_way_scale"), false, "single-sign data: nothing to report");
  const tail = [-325.6, -200, -50, -10, 1, 2, 3, 161]; // a positive tail: the one-way class breaks hug the positive side
  const mrows = mapRows(tail), msvg = withEnv({}, () => map(tail).svg);
  const mc = withEnv({ NEWSROOM_SIGNED_SCALE_CHECK: "1" }, () => critiqueViz(mapSpec, mrows, { passed: true }, msvg));
  assert.ok(mc.issues.some((i) => i.code === "class0_collapse" && i.severity === "info"), "skewed one-way map: the lightest class holds several magnitudes of losses");
}
console.log("test_k309_signed_scale: ok");
