#!/usr/bin/env node
// Covers the strip_plot chart type: a dot strip plot with one row per group on
// one shared value axis and one dot per unit, showing the spread of each group
// and the extremes of the whole chart. Exercises the surfaces every other
// chart-type test in this suite does - validateVizSpec / lintVizSpec (each
// blocker refused and accepted at its boundary), the rendered SVG's geometry
// (read back from the markup, not from the renderer's internals), and the
// product's own render-QA gates (runtime/pi/render_qa.mjs) - on deterministic
// synthetic data. The dots of a row are laid out as a beeswarm unless point_layout asks for "jitter"; both layouts are tested, and
// the default is pinned. Also keeps an SVG hash snapshot of four typical charts in
// fixtures/viz-strip-plot-snapshots.json, rewritten only by `--update`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { CHART_TYPES, critiqueViz, fmtSpec, lintVizSpec, renderVizBundle, renderVizSvg, validateVizSpec } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { parseXml } from "../runtime/pi/render_qa_svg.mjs";
import { numericFieldsOfSpec } from "../runtime/pi/claim_binding.mjs";

const claimId = "claim-strip-fixture";

const base = {
  schema_version: "0.9.0",
  reader_task: "distribution",
  takeaway: "Unit spread by group",
  title: "Unit spread by group",
  alt: "A dot strip plot with one row per group and one dot per unit on one shared value axis.",
  source_note: "Synthetic strip plot fixture",
  claim_id: claimId,
  sql: "SELECT g, u, v FROM fixture",
  unit: "pts",
  decimals: 1,
  chart_type: "strip_plot",
  category_field: "g",
  value_field: "v",
  label_field: "u",
  direct_labels: true,
  annotations: [],
  highlight_values: [],
};

const lint = (spec, rows) => lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });

// ---------------------------------------------------------------------------
// Deterministic synthetic data. mulberry32 with a fixed seed: no Math.random.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEMS = "甲乙丙丁戊己庚辛壬癸".split("");
const BRANCHES = "子丑寅卯辰巳午未申酉戌亥".split("");
function groupName(i) {
  if (i < 10) return `${STEMS[i]}国`;
  if (i < 22) return `${BRANCHES[i - 10]}国`;
  const k = i - 22;
  return `${k < 10 ? STEMS[k] : BRANCHES[k - 10]}邦`;
}

// 35 groups, 286 units: most groups hold 2-15 units, three hold 21-38, four
// hold exactly one; values 2-30 (%), skewed right, with two very wide groups.
const MID_SIZES = [9, 12, 6, 10, 3, 8, 11, 5, 2, 10, 7, 9, 4, 9, 6, 8, 7, 5, 9, 3, 7, 9, 2, 9, 5, 10, 7, 4];
const SPECIAL_SIZES = { 4: 38, 2: 1, 13: 1, 15: 27, 20: 1, 23: 21, 30: 1 };
function typicalRows(seed = 42, wideGroups = [1, 17]) {
  const rnd = mulberry32(seed);
  const gauss = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return (s - 3) / 0.7071; };
  const mid = [...MID_SIZES];
  const raw = [];
  for (let g = 0; g < 35; g++) {
    const size = SPECIAL_SIZES[g] ?? mid.shift();
    const center = 4 + 11 * Math.pow(rnd(), 1.8);
    const sigma = wideGroups.includes(g) ? 0.75 : 0.12 + 0.2 * rnd();
    for (let k = 1; k <= size; k++) raw.push({ group: groupName(g), unit: `${groupName(g)}-${k}`, v: center * Math.exp(sigma * gauss()) });
  }
  const lo = Math.min(...raw.map((row) => row.v));
  const hi = Math.max(...raw.map((row) => row.v));
  return raw.map((row) => ({ ...row, v: Math.round((2 + ((row.v - lo) / (hi - lo)) * 28) * 10) / 10 }));
}

const typical = typicalRows();
const typicalSpec = {
  schema_version: "0.9.0",
  reader_task: "distribution",
  takeaway: "示例数据：各国各地区失业率的离散程度",
  title: "示例数据：各国地区失业率",
  subtitle: "示例数据，非真实统计",
  alt: "示例数据的点阵条形图：每个国家一行，每个地区一个点，共用一条横轴。",
  source_note: "示例数据",
  claim_id: claimId,
  sql: "SELECT group, unit, v FROM fixture",
  unit: "%",
  chart_type: "strip_plot",
  category_field: "group",
  value_field: "v",
  label_field: "unit",
  language: "zh",
  direct_labels: true,
  annotations: [],
  highlight_values: [],
};

// Small, exactly known data: three groups, nine units, all values distinct.
const smallRows = [
  { g: "Alpha", u: "A1", v: 10 }, { g: "Alpha", u: "A2", v: 14 }, { g: "Alpha", u: "A3", v: 18.5 },
  { g: "Beta", u: "B1", v: 22 }, { g: "Beta", u: "B2", v: 30 },
  { g: "Gamma", u: "G1", v: 3 }, { g: "Gamma", u: "G2", v: 9 }, { g: "Gamma", u: "G3", v: 12 }, { g: "Gamma", u: "G4", v: 25 },
];

// groups x per units, integer values 1-29, every name distinct.
function lattice(groups, per) {
  const rows = [];
  for (let g = 0; g < groups; g++) {
    for (let k = 0; k < per; k++) rows.push({ g: `Group ${String(g + 1).padStart(2, "0")}`, u: `Unit ${g + 1}-${k + 1}`, v: 1 + ((g * 7 + k * 3) % 29) });
  }
  return rows;
}

// Seeded groups x per units with varied centres and spreads (decimals).
function scattered(groups, per, seed = 7) {
  const rnd = mulberry32(seed);
  const rows = [];
  for (let g = 0; g < groups; g++) {
    const centre = 5 + 20 * rnd();
    for (let k = 0; k < per; k++) {
      const name = `G${String(g).padStart(2, "0")}`;
      rows.push({ g: name, u: `${name}-${k + 1}`, v: Math.round((centre + ((rnd() - 0.5) * 8 * ((g % 5) + 1)) / 3) * 10) / 10 });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SVG readers: everything below reads the rendered markup only.
// ---------------------------------------------------------------------------
function nodesOf(svg) {
  const out = [];
  (function walk(node) { out.push(node); node.children.forEach(walk); })(parseXml(svg));
  return out;
}

function readChart(svg) {
  const nodes = nodesOf(svg);
  const texts = nodes.filter((node) => node.tag === "text");
  const lines = nodes.filter((node) => node.tag === "line");
  const read = (node) => ({ text: node.text, x: Number(node.attrs.x), y: Number(node.attrs.y), anchor: node.attrs["text-anchor"], weight: node.attrs["font-weight"], size: node.attrs["font-size"], fill: node.attrs.fill, node });
  const dots = nodes
    .filter((node) => node.tag === "circle" && node.attrs["data-role"] === "data-point")
    .map((node) => ({ x: Number(node.attrs.cx), y: Number(node.attrs.cy), r: Number(node.attrs.r), fill: node.attrs.fill, opacity: node.attrs.opacity, stroke: node.attrs.stroke, order: node.docIndex }));
  const ticks = texts.filter((node) => node.attrs["text-anchor"] === "middle").map(read).map((tick) => ({ ...tick, value: Number.parseFloat(tick.text) }));
  const rowLabels = texts.filter((node) => node.attrs["text-anchor"] === "end" && !node.attrs["data-role"]).map(read).map((row) => ({ ...row, center: row.y - 4 }));
  const labels = texts.filter((node) => node.attrs["data-role"] === "direct-label").map(read);
  const leaders = lines.filter((node) => node.attrs["data-role"] === "direct-label-leader").map((node) => ({ x1: Number(node.attrs.x1), y1: Number(node.attrs.y1), x2: Number(node.attrs.x2), y2: Number(node.attrs.y2) }));
  const medians = lines.filter((node) => node.attrs["data-role"] === "data-median").map((node) => ({ x1: Number(node.attrs.x1), y1: Number(node.attrs.y1), x2: Number(node.attrs.x2), y2: Number(node.attrs.y2), stroke: node.attrs.stroke }));
  const gridlines = lines.filter((node) => node.attrs.stroke === "#E5E5E5" && node.attrs.x1 === node.attrs.x2).map((node) => Number(node.attrs.x1));
  const zeroLines = lines.filter((node) => node.attrs["data-role"] === "zero-line");
  const keyNode = texts.find((node) => node.attrs["data-role"] === "strip-median-key");
  const view = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  const xOf = (value) => first.x + ((value - first.value) * (last.x - first.x)) / (last.value - first.value);
  const band = rowLabels.length > 1 ? (rowLabels[rowLabels.length - 1].y - rowLabels[0].y) / (rowLabels.length - 1) : null;
  return { texts, dots, ticks, rowLabels, labels, leaders, medians, gridlines, zeroLines, key: keyNode ? read(keyNode) : null, width: Number(view[1]), height: Number(view[2]), xOf, band };
}

function fontOffenders(svg) {
  const offenders = [];
  for (const node of nodesOf(svg)) {
    if (node.tag !== "text" && node.tag !== "tspan") continue;
    let size = null;
    for (let current = node; current && size === null; current = current.parent) {
      if (current.attrs && current.attrs["font-size"] !== undefined) size = Number.parseFloat(current.attrs["font-size"]);
    }
    if (!(size >= 12)) offenders.push(`${String(node.text).trim().slice(0, 24)}@${size}`);
  }
  return offenders;
}

const badTokens = (svg) => svg.match(/NaN|undefined|Infinity|null/g) ?? [];

function isNiceStep(step) {
  const power = Math.floor(Math.log10(step));
  return [1, 2, 5].includes(Math.round((step / 10 ** power) * 1e6) / 1e6);
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The render-QA gate (geometry + contrast), the 12px font floor and the
// token scan, all on one SVG. Returns the SVG so callers can inspect it.
function renderQaClean(name, spec, rows, expectedLabels) {
  const svg = renderVizSvg(spec, rows);
  const qa = runRenderQa({ desktop: svg });
  const failures = [...qa.viewports.desktop.geometry.failures, ...qa.viewports.desktop.contrast.failures];
  assert.deepEqual(failures, [], `${name}: render QA failures ${JSON.stringify(failures).slice(0, 400)}`);
  assert.equal(qa.passed, true, `${name}: render QA did not pass`);
  assert.deepEqual(fontOffenders(svg), [], `${name}: text below the 12px floor`);
  assert.deepEqual(badTokens(svg), [], `${name}: non-finite or undefined tokens in the SVG`);
  const chart = readChart(svg);
  if (expectedLabels !== undefined) assert.equal(chart.labels.length, expectedLabels, `${name}: expected ${expectedLabels} extreme labels, drew ${chart.labels.length} (none may be omitted)`);
  return svg;
}

function withoutRandom(fn) {
  const original = Math.random;
  Math.random = () => { throw new Error("strip_plot must not call Math.random"); };
  try { return fn(); } finally { Math.random = original; }
}

// --- registry and schema
{
  assert.equal(CHART_TYPES.indexOf("strip_plot"), CHART_TYPES.indexOf("scatter") + 1, "strip_plot sits right after scatter in CHART_TYPES");
  const schema = JSON.parse(await readFile(new URL("../schemas/newsroom-viz-spec.schema.json", import.meta.url), "utf8"));
  const enumValues = schema.properties.chart_type.enum;
  assert.equal(enumValues.indexOf("strip_plot"), enumValues.indexOf("scatter") + 1, "schema enum lists strip_plot right after scatter");
  assert.deepEqual(schema.properties.group_order.enum, ["median_desc", "median_asc", "data"]);
  assert.deepEqual(schema.properties.point_layout.enum, ["jitter", "beeswarm"]);
  assert.match(schema.properties.point_layout.description, /beeswarm \(default\)/, "the schema names beeswarm as the default layout");
  assert.equal(schema.properties.show_median.type, "boolean");
  assert.deepEqual({ ...schema.properties.label_extremes }, { type: "integer", minimum: 0, maximum: 6 });
  const rule = schema.allOf.find((entry) => entry.if?.properties?.chart_type?.const === "strip_plot");
  assert.ok(rule, "schema has an if/then block for strip_plot");
  assert.deepEqual(rule.then.required, ["category_field", "value_field"]);
  // The schema is closed (additionalProperties:false), so every key a strip_plot spec uses must be declared.
  assert.equal(schema.additionalProperties, false);
  for (const key of [...Object.keys(base), ...Object.keys(typicalSpec), "group_order", "point_layout", "show_median", "label_extremes", "category_names", "language"]) {
    assert.ok(Object.hasOwn(schema.properties, key), `schema declares '${key}'`);
  }
  assert.ok(numericFieldsOfSpec(base).includes("v"), "the claim-binding gate covers strip_plot's value_field");
  assert.deepEqual(numericFieldsOfSpec(base), ["v"], "value_field is the only numeric field of a strip_plot");
}
console.log("strip_plot registry: CHART_TYPES, schema enum/properties/if-then and claim-binding coverage -- PASS");

// --- validateVizSpec: the four new options
{
  assert.deepEqual(validateVizSpec(base), []);
  for (const [key, bad] of [["group_order", "alphabetical"], ["point_layout", "swarm"], ["show_median", "yes"], ["show_median", 1]]) {
    const errors = validateVizSpec({ ...base, [key]: bad });
    assert.ok(errors.some((error) => error.includes(`strip_plot ${key}`)), `${key}=${JSON.stringify(bad)} must be refused: ${errors.join("; ")}`);
  }
  for (const good of [["group_order", "median_desc"], ["group_order", "median_asc"], ["group_order", "data"], ["point_layout", "jitter"], ["point_layout", "beeswarm"], ["show_median", true], ["show_median", false]]) {
    assert.deepEqual(validateVizSpec({ ...base, [good[0]]: good[1] }), [], `${good[0]}=${good[1]} is valid`);
  }
  for (const bad of [-1, 7, 2.5, "4", Number.NaN, null]) {
    const errors = validateVizSpec({ ...base, label_extremes: bad });
    assert.ok(errors.some((error) => error.includes("label_extremes must be an integer between 0 and 6")), `label_extremes=${String(bad)} must be refused: ${errors.join("; ")}`);
  }
  for (const good of [0, 1, 2, 3, 4, 5, 6]) assert.deepEqual(validateVizSpec({ ...base, label_extremes: good }), [], `label_extremes=${good} is valid`);
  for (const missing of ["category_field", "value_field"]) {
    const { [missing]: _gone, ...spec } = base;
    assert.ok(validateVizSpec(spec).some((error) => error.includes(missing)), `${missing} is required`);
  }
  // The strip_plot-only options do not leak into other chart types' checks.
  assert.deepEqual(validateVizSpec({ ...base, chart_type: "horizontal_bar", label_extremes: 99 }), []);
}
console.log("strip_plot validate: group_order, point_layout, show_median, label_extremes and required fields -- PASS");

// --- synthetic data shape (so the render tests below run on what they claim)
{
  const groups = new Map();
  for (const row of typical) groups.set(row.group, [...(groups.get(row.group) ?? []), row.v]);
  assert.equal(groups.size, 35);
  assert.equal(typical.length, 286);
  const sizes = [...groups.values()].map((values) => values.length);
  assert.equal(sizes.filter((size) => size === 1).length, 4, "four single-unit groups");
  assert.equal(sizes.filter((size) => size >= 20 && size <= 38).length, 3, "three groups of 20-38 units");
  assert.equal(sizes.filter((size) => size >= 2 && size <= 15).length, 28, "28 groups of 2-15 units");
  const all = typical.map((row) => row.v);
  assert.equal(Math.min(...all), 2);
  assert.equal(Math.max(...all), 30);
  assert.ok(all.reduce((sum, v) => sum + v, 0) / all.length > medianOf(all), "values are skewed right (mean above median)");
  const ranges = [...groups.values()].filter((values) => values.length > 1).map((values) => Math.max(...values) - Math.min(...values)).sort((a, b) => b - a);
  assert.ok(ranges[1] > 1.5 * ranges[2], "two groups are clearly wider than all the others");
  assert.equal(new Set(all.filter((v) => v === 30 || v === 2)).size, 2);
  assert.equal(all.filter((v) => v === 30).length, 1, "the top value is unique");
  assert.equal(all.filter((v) => v === 2).length, 1, "the bottom value is unique");
  assert.deepEqual(typicalRows(), typical, "the generator is deterministic");
}
console.log("strip_plot data: the synthetic 35-group / 286-unit set has the documented shape -- PASS");

// --- lint: group, point and value boundaries
{
  const messages = (result) => result.blockers.join("; ");
  assert.equal(lint(base, smallRows).passed, true, messages(lint(base, smallRows)));
  assert.deepEqual(lint(base, smallRows).warnings, []);

  // groups: 40 accepted (with the >30 warning), 41 refused
  const groups40 = lint(base, lattice(40, 2));
  assert.equal(groups40.passed, true, messages(groups40));
  assert.ok(groups40.warnings.some((w) => w.includes("40 groups") && w.includes("more than 30 rows are hard to read")), groups40.warnings.join("; "));
  const groups41 = lint(base, lattice(41, 2));
  assert.equal(groups41.passed, false);
  assert.ok(groups41.blockers.some((b) => b.includes("strip_plot has 41 groups; maximum is 40")), messages(groups41));
  assert.equal(groups41.warnings.some((w) => w.includes("hard to read")), false, "the warning is replaced by the blocker above 40");
  // warning boundary: 30 groups silent, 31 warns
  assert.equal(lint(base, lattice(30, 2)).warnings.some((w) => w.includes("hard to read")), false);
  assert.equal(lint(base, lattice(31, 2)).warnings.some((w) => w.includes("31 groups")), true);

  // points: 600 accepted, 601 refused
  const points600 = lint(base, lattice(20, 30));
  assert.equal(points600.passed, true, messages(points600));
  const points601 = lint(base, [...lattice(20, 30), { g: "Group 01", u: "Unit extra", v: 5 }]);
  assert.equal(points601.passed, false);
  assert.ok(points601.blockers.some((b) => b.includes("strip_plot has 601 points; maximum is 600")), messages(points601));
  assert.equal(points600.blockers.some((b) => b.includes("maximum is 240")), false, "strip_plot is exempt from the generic 240-row cap");
  // the generic cap still holds for every other chart type
  const bar241 = lint({ ...base, chart_type: "horizontal_bar" }, lattice(241, 1));
  assert.ok(bar241.blockers.some((b) => b.includes("maximum is 240")), messages(bar241));
  assert.equal(lint({ ...base, chart_type: "horizontal_bar" }, lattice(240, 1)).blockers.some((b) => b.includes("maximum is 240")), false);

  // non-finite value: refused for every kind of non-number, accepted for zero and negatives
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "n/a", null, undefined, ""]) {
    const rows = smallRows.map((row, i) => (i === 4 ? { ...row, v: bad } : row));
    const result = lint(base, rows);
    assert.equal(result.passed, false, `value ${String(bad)} must be refused`);
    assert.ok(result.blockers.some((b) => b.includes("non-numeric or missing values")), messages(result));
  }
  const missingValue = lint(base, smallRows.map(({ v: _v, ...row }, i) => (i === 0 ? row : { ...row, v: 1 })));
  assert.equal(missingValue.passed, false);
  for (const good of [0, -3.5, 1e-9, 12345.678]) {
    const result = lint(base, smallRows.map((row, i) => (i === 4 ? { ...row, v: good } : row)));
    assert.equal(result.passed, true, `value ${good} must be accepted: ${messages(result)}`);
  }

  // label_extremes: refused outside 0-6 or non-integer, accepted on every boundary and when omitted
  for (const bad of [-1, 7, 2.5, "4"]) {
    const result = lint({ ...base, label_extremes: bad }, smallRows);
    assert.equal(result.passed, false, `label_extremes=${bad} must be refused`);
    assert.ok(result.blockers.some((b) => b.includes("label_extremes")), messages(result));
  }
  for (const good of [0, 1, 3, 6]) assert.equal(lint({ ...base, label_extremes: good }, smallRows).passed, true, `label_extremes=${good}`);
  assert.equal(lint(base, smallRows).passed, true, "label_extremes omitted is fine");

  // warnings: label_extremes above 0 (default 4 included) without a label_field
  const { label_field: _label, ...noLabelField } = base;
  assert.ok(lint(noLabelField, smallRows).warnings.some((w) => w.includes("no label_field is set")), "default label_extremes needs a label_field");
  assert.ok(lint({ ...noLabelField, label_extremes: 2 }, smallRows).warnings.some((w) => w.includes("no label_field is set")));
  assert.equal(lint({ ...noLabelField, label_extremes: 0 }, smallRows).warnings.some((w) => w.includes("label_field")), false, "label_extremes 0 needs no label_field");
  assert.equal(lint({ ...noLabelField, label_extremes: 0 }, smallRows).passed, true);
  assert.equal(lint(noLabelField, smallRows).passed, true, "a missing label_field is a warning, not a blocker");
  assert.ok(lint({ ...base, label_field: "nope" }, smallRows).warnings.some((w) => w.includes("label_field 'nope' is absent from the rows")));
  assert.equal(lint({ ...base, label_field: "nope", label_extremes: 0 }, smallRows).warnings.some((w) => w.includes("absent")), false);
  const pointNote = lint({ ...base, annotations: [{ type: "point", text: "Unit A1", match_field: "u", match_value: "A1", claim_id: claimId }] }, smallRows);
  assert.equal(pointNote.passed, false, "a point annotation on strip_plot blocks");
  assert.ok(pointNote.blockers.some((m) => m.includes("point is not supported on chart_type 'strip_plot'") && m.includes("label_extremes")), pointNote.blockers.join("; "));
  assert.equal(lint({ ...base, annotations: [{ type: "reference_line", value: 1, text: "x" }] }, smallRows).passed, false, "a reference_line on strip_plot still blocks");

  // the annotation nudge names what the form does: it draws no annotations, it labels extreme points
  const denseRows = Array.from({ length: 9 }, (_, i) => ({ ...smallRows[0], v: i }));
  const nudge = JSON.stringify(critiqueViz(base, denseRows, lint(base, denseRows), ""));
  assert.ok(nudge.includes("no_annotation") && nudge.includes("label_extremes") && !nudge.includes("Add one verified annotation"), nudge);

  // reader task fit: strip_plot is a distribution form
  assert.equal(lint(base, smallRows).warnings.some((w) => w.includes("unusual fit")), false);
  assert.ok(lint({ ...base, reader_task: "comparison" }, smallRows).warnings.some((w) => w.includes("'strip_plot' is an unusual fit for reader task 'comparison'")));

  // required fields
  const { category_field: _category, ...noCategory } = base;
  const { value_field: _value, ...noValue } = base;
  assert.equal(lint(noCategory, smallRows).passed, false);
  assert.equal(lint(noValue, smallRows).passed, false);
}
console.log("strip_plot lint: 40/41 groups, 600/601 points, non-finite values, label_extremes 0-6, warnings and task fit -- PASS");

// --- value axis: where it starts, nice ticks, unit once, gridlines, dots at their values
{
  const axisCase = (values) => readChart(renderVizSvg({ ...base, label_extremes: 0 }, values.map((v, i) => ({ g: i % 2 ? "B" : "A", u: `U${i}`, v }))));
  const firstTick = (chart) => chart.ticks[0].value;
  const lastTick = (chart) => chart.ticks[chart.ticks.length - 1].value;

  // starts at 0 when every value is >= 0 and the smallest is below a quarter of the largest
  const fromZero = axisCase([3, 20, 40, 12]);
  assert.equal(firstTick(fromZero), 0);
  assert.equal(fromZero.zeroLines.length, 1, "a zero baseline is drawn when the axis starts at 0");
  assert.ok(lastTick(fromZero) > 40, "the top tick is strictly above the largest value");
  // boundary: smallest exactly a quarter of the largest does not start at 0; just under does
  const quarter = axisCase([25, 60, 100]);
  assert.ok(firstTick(quarter) > 0 && firstTick(quarter) < 25, `smallest = max/4 starts at a rounded value below it, got ${firstTick(quarter)}`);
  assert.equal(quarter.zeroLines.length, 0);
  const justUnder = axisCase([24.9, 60, 100]);
  assert.equal(firstTick(justUnder), 0, "smallest just under max/4 starts at 0");
  // values far from zero start at a rounded value below the smallest
  const high = axisCase([62, 80, 97, 100]);
  assert.ok(firstTick(high) < 62 && firstTick(high) > 0, `first tick ${firstTick(high)} is below the smallest value and not zero`);
  assert.ok(lastTick(high) > 100);
  assert.equal(high.zeroLines.length, 0);
  // negatives
  const negative = axisCase([-5, 3, 10, -2.5]);
  assert.ok(firstTick(negative) < -5 && lastTick(negative) > 10, "negative values are bracketed by the first and last tick");
  assert.equal(negative.zeroLines.length, 0);
  // degenerate data: all equal, all zero, a single value
  for (const flat of [[5, 5, 5, 5], [0, 0, 0], [7]]) {
    const chart = axisCase(flat);
    assert.ok(chart.ticks.length >= 2, `a flat data set ${flat} still gets an axis`);
    assert.ok(chart.ticks.every((tick) => Number.isFinite(tick.value) && Number.isFinite(tick.x)));
    assert.ok(firstTick(chart) < Math.min(...flat) && lastTick(chart) > Math.max(...flat), `the axis of ${flat} brackets its values`);
  }

  // ticks are evenly spaced nice numbers, one light vertical gridline per tick, the unit only on the last tick
  for (const chart of [fromZero, quarter, high, negative]) {
    const values = chart.ticks.map((tick) => tick.value);
    const step = values[1] - values[0];
    assert.ok(step > 0 && isNiceStep(step), `step ${step} is a {1,2,5}x10^k number`);
    values.forEach((value, i) => assert.ok(Math.abs(value - values[0] - step * i) < 1e-9 * Math.max(1, Math.abs(value)), `ticks ${values} are evenly spaced`));
    assert.ok(chart.ticks.length >= 4 && chart.ticks.length <= 12, `tick count ${chart.ticks.length}`);
    assert.deepEqual(chart.gridlines, chart.ticks.map((tick) => tick.x), "one vertical gridline per tick, at the tick's x");
    chart.ticks.forEach((tick, i) => {
      const last = i === chart.ticks.length - 1;
      assert.equal(tick.text.includes("pts"), last, `tick '${tick.text}' carries the unit only when it is the last one`);
      assert.equal(tick.fill, "#666666");
      assert.equal(tick.size, "12");
    });
  }
  // legacy: the unit goes on every tick
  const legacy = readChart(renderVizSvg({ ...base, style_id: "legacy", label_extremes: 0 }, smallRows));
  assert.ok(legacy.ticks.every((tick) => /pts$/.test(tick.text)), legacy.ticks.map((tick) => tick.text).join(", "));

  // every dot sits at x = scale(value) on the shared axis (no value is adjusted)
  const chart = readChart(renderVizSvg(typicalSpec, typical));
  assert.equal(chart.dots.length, typical.length);
  typical.forEach((row, i) => assert.ok(Math.abs(chart.dots[i].x - chart.xOf(row.v)) <= 0.03, `dot ${i} (${row.unit}) at x=${chart.dots[i].x}, expected ${chart.xOf(row.v)}`));
  const xs = chart.ticks.map((tick) => tick.x);
  assert.ok(Math.min(...chart.dots.map((dot) => dot.x)) >= xs[0] && Math.max(...chart.dots.map((dot) => dot.x)) <= xs[xs.length - 1], "dots stay inside the axis");
  assert.equal(chart.ticks[0].value, 0, "the typical chart (values 2-30) starts at 0");
  assert.equal(chart.zeroLines.length, 1);
}
console.log("strip_plot axis: start rule (0 vs rounded), nice evenly spaced ticks, unit once, gridlines, dots at their values -- PASS");

// --- rows: order, localization, size
{
  // medians: C = (2+30)/2 = 16 (even n), A = 12, B = 35, D = 14; E and F tie at 20
  const rows = [
    { g: "C", u: "c1", v: 1 }, { g: "A", u: "a1", v: 10 }, { g: "D", u: "d1", v: 14 }, { g: "C", u: "c2", v: 2 }, { g: "E", u: "e1", v: 20 },
    { g: "A", u: "a2", v: 12 }, { g: "B", u: "b1", v: 30 }, { g: "C", u: "c3", v: 30 }, { g: "F", u: "f1", v: 20 }, { g: "A", u: "a3", v: 20 },
    { g: "B", u: "b2", v: 40 }, { g: "C", u: "c4", v: 31 },
  ];
  const order = (extra) => readChart(renderVizSvg({ ...base, label_extremes: 0, ...extra }, rows)).rowLabels.map((row) => row.text);
  assert.deepEqual(order({}), ["B", "E", "F", "C", "D", "A"], "median_desc is the default");
  assert.deepEqual(order({ group_order: "median_desc" }), ["B", "E", "F", "C", "D", "A"]);
  assert.deepEqual(order({ group_order: "median_asc" }), ["A", "D", "C", "E", "F", "B"]);
  assert.deepEqual(order({ group_order: "data" }), ["C", "A", "D", "E", "B", "F"], "data keeps the order of first appearance");
  // an invalid option is refused by the renderer's own validation too, never silently replaced
  assert.throws(() => order({ group_order: "alphabetical" }), /group_order must be one of median_desc, median_asc, data/);
  assert.throws(() => order({ point_layout: "swarm" }), /point_layout must be one of jitter, beeswarm/);
  assert.throws(() => order({ label_extremes: 7 }), /label_extremes must be an integer between 0 and 6/);
  // the same group in non-adjacent rows still draws one row
  assert.equal(order({}).length, 6);

  // rows are as tall as the count needs: 17px at 35 rows, never above 28px, and the chart grows with the row count
  const typicalChart = readChart(renderVizSvg(typicalSpec, typical));
  assert.equal(typicalChart.rowLabels.length, 35);
  assert.ok(typicalChart.band >= 14 && typicalChart.band <= 18, `35-row band ${typicalChart.band}`);
  for (let i = 1; i < typicalChart.rowLabels.length; i++) assert.ok(Math.abs(typicalChart.rowLabels[i].y - typicalChart.rowLabels[i - 1].y - typicalChart.band) < 0.011, "rows are evenly spaced");
  const firstTwelve = Array.from({ length: 12 }, (_, i) => groupName(i));
  const twelve = readChart(renderVizSvg(typicalSpec, typical.filter((row) => firstTwelve.includes(row.group))));
  const forty = readChart(renderVizSvg(base, lattice(40, 2)));
  assert.equal(twelve.rowLabels.length, 12);
  assert.ok(twelve.band <= 28 && twelve.band > typicalChart.band, `12-row band ${twelve.band}`);
  assert.ok(forty.height > typicalChart.height && typicalChart.height > twelve.height, `heights ${twelve.height} < ${typicalChart.height} < ${forty.height}`);
  assert.equal(twelve.width, 1040);
  assert.equal(typicalChart.width, 1040);
  assert.equal(forty.width, 1040, "every strip_plot has the shared desktop chart width");

  // row labels sit left of the plot, ink on every row, 12px; dots start right of them
  assert.ok(typicalChart.rowLabels.every((row) => row.fill === "#1A1A1A" && row.size === "12"));
  assert.ok(Math.max(...typicalChart.rowLabels.map((row) => row.x)) < Math.min(...typicalChart.dots.map((dot) => dot.x - dot.r)));

  // each dot sits on its own group's row, inside the row band
  const rowOf = new Map(typicalChart.rowLabels.map((row) => [row.text, row.center]));
  typical.forEach((row, i) => {
    const dot = typicalChart.dots[i];
    assert.ok(Math.abs(dot.y - rowOf.get(row.group)) + dot.r <= typicalChart.band / 2 + 1e-9, `${row.unit} is inside its row band`);
  });
  // a single-unit group sits on its row's centre line
  const single = typical.filter((row) => typical.filter((other) => other.group === row.group).length === 1);
  assert.equal(single.length, 4);
  for (const row of single) assert.equal(typicalChart.dots[typical.indexOf(row)].y, rowOf.get(row.group));

  // category_names localizes the row labels like every other form
  const countries = ["Zambia", "Liberia", "Ghana"].flatMap((g, i) => [0, 1, 2].map((k) => ({ g, u: `${g} ${k + 1}`, v: 10 + i * 8 + k * 3 })));
  const zh = readChart(renderVizSvg({ ...base, language: "zh", category_names: "worldbank", label_extremes: 0 }, countries)).rowLabels.map((row) => row.text);
  const en = readChart(renderVizSvg({ ...base, language: "en", category_names: "worldbank", label_extremes: 0 }, countries)).rowLabels.map((row) => row.text);
  assert.ok(zh.every((name) => /[一-鿿]/.test(name)), `zh row labels are Chinese names: ${zh.join(", ")}`);
  assert.deepEqual([...en].sort(), ["Ghana", "Liberia", "Zambia"]);
}
console.log("strip_plot rows: median_desc/median_asc/data order, ties, band size, chart growth, row labels, single-unit groups, localization -- PASS");

// --- dots: one per unit, size, colour, opacity, highlight
{
  const chart = readChart(renderVizSvg(base, smallRows));
  assert.equal(chart.dots.length, smallRows.length, "one dot per unit");
  for (const dot of chart.dots) {
    assert.equal(dot.r, 3);
    assert.equal(dot.fill, "#757575", "ordinary dots take the house data colour");
    assert.equal(dot.opacity, "0.5", "ordinary dots are half transparent");
    assert.equal(dot.stroke, undefined, "dots have no stroke");
  }

  // highlight_values names groups or units; highlighted dots are accent, opaque and drawn after the others
  const byGroup = readChart(renderVizSvg({ ...base, highlight_values: ["Beta"] }, smallRows));
  const accent = byGroup.dots.filter((dot) => dot.fill === "#D0021B");
  assert.equal(accent.length, 2, "both Beta units are highlighted");
  assert.ok(accent.every((dot) => dot.opacity === undefined && dot.r === 3));
  assert.equal(byGroup.dots.filter((dot) => dot.fill === "#757575").length, 7);
  assert.ok(byGroup.dots.filter((dot) => dot.fill === "#757575").every((dot) => dot.opacity === "0.5"));
  assert.ok(Math.min(...accent.map((dot) => dot.order)) > Math.max(...byGroup.dots.filter((dot) => dot.fill === "#757575").map((dot) => dot.order)), "highlighted dots are drawn on top");
  const betaRow = byGroup.rowLabels.find((row) => row.text === "Beta").center;
  assert.ok(accent.every((dot) => Math.abs(dot.y - betaRow) <= 9), "the accent dots are the ones on Beta's row");

  const byUnit = readChart(renderVizSvg({ ...base, highlight_values: ["G2", "A1"] }, smallRows));
  assert.equal(byUnit.dots.filter((dot) => dot.fill === "#D0021B").length, 2, "units are highlighted by their label_field name");
  const none = readChart(renderVizSvg({ ...base, highlight_values: ["Nobody"] }, smallRows));
  assert.equal(none.dots.filter((dot) => dot.fill === "#D0021B").length, 0);
  // highlighted dots are plain accent dots, not extra dots
  assert.equal(byUnit.dots.length, smallRows.length);

  // only value_field is drawn: other numeric or text columns change nothing
  const decoy = smallRows.map((row, i) => ({ ...row, w: 1000 + i * 37, rank: 9 - i, note: `n${i}` }));
  assert.equal(renderVizSvg(base, decoy), renderVizSvg(base, smallRows));
}
console.log("strip_plot dots: one per unit, r=3, house colour at 0.5, no stroke, highlight by group or unit, only value_field drawn -- PASS");

// --- median ticks and their key
{
  const rows = [
    { g: "A", u: "a1", v: 1.3 }, { g: "A", u: "a2", v: 2.9 },
    { g: "B", u: "b1", v: 10 }, { g: "B", u: "b2", v: 17 }, { g: "B", u: "b3", v: 30 },
    { g: "C", u: "c1", v: 5 }, { g: "C", u: "c2", v: 6 }, { g: "C", u: "c3", v: 8 }, { g: "C", u: "c4", v: 20 },
  ];
  const expected = { A: 2.1, B: 17, C: 7 };
  const chart = readChart(renderVizSvg({ ...base, label_extremes: 0 }, rows));
  assert.equal(chart.medians.length, 3, "one median tick per group");
  for (const median of chart.medians) {
    assert.equal(median.x1, median.x2, "median ticks are vertical");
    assert.equal(median.stroke, "#1A1A1A");
    const row = chart.rowLabels.find((candidate) => Math.abs((median.y1 + median.y2) / 2 - candidate.center) < 0.02);
    assert.ok(row, "each median tick is centred on a row");
    assert.ok(Math.abs(median.x1 - chart.xOf(expected[row.text])) <= 0.03, `median of ${row.text} at ${median.x1}, expected ${chart.xOf(expected[row.text])}`);
    assert.ok(median.y2 - median.y1 > 6 && median.y2 - median.y1 < chart.band, "a short tick inside the band");
  }
  // the median is a mark only: no text carries it (with label_extremes 0 the only numbers are axis ticks)
  const numeric = chart.texts.filter((node) => /\d/.test(node.text));
  assert.ok(numeric.length > 0 && numeric.every((node) => node.attrs["text-anchor"] === "middle"), "with no extreme labels, only axis ticks carry numbers");
  assert.equal(chart.texts.some((node) => /2\.1/.test(node.text)), false, "the derived median 2.1 is never printed");

  // the key is named by VIZ_STRINGS (en and zh) and disappears with show_median:false
  assert.equal(chart.key.text, "Line: median");
  const zhKey = readChart(renderVizSvg({ ...base, language: "zh", label_extremes: 0 }, rows)).key;
  assert.equal(zhKey.text, "竖线：中位数");
  assert.equal(zhKey.size, "12");
  const off = readChart(renderVizSvg({ ...base, show_median: false, label_extremes: 0 }, rows));
  assert.equal(off.medians.length, 0, "show_median:false draws no median ticks");
  assert.equal(off.key, null, "show_median:false draws no key");
  const on = readChart(renderVizSvg({ ...base, show_median: true, label_extremes: 0 }, rows));
  assert.equal(on.medians.length, 3);
  assert.deepEqual(readChart(renderVizSvg({ ...base, label_extremes: 0 }, rows)).medians, on.medians, "show_median defaults to true");
  // the same data with show_median off orders its rows identically (the median only orders them)
  assert.deepEqual(off.rowLabels.map((row) => row.text), on.rowLabels.map((row) => row.text));
  // a median tick never sits on a printed label: the QA gate treats ticks as marks
  const qa = runRenderQa({ desktop: renderVizSvg({ ...base, label_extremes: 0 }, rows) });
  assert.equal(qa.passed, true);
}
console.log("strip_plot medians: tick positions (odd and even n), mark only, key en/zh, show_median on/off -- PASS");

// --- extreme labels: selection, text, unit once, leaders
{
  const spec = { ...base };
  const sorted = [...smallRows].sort((a, b) => b.v - a.v);
  const groupMedian = (group) => medianOf(smallRows.filter((row) => row.g === group).map((row) => row.v));
  const groupRank = (group) => ["Alpha", "Beta", "Gamma"].sort((a, b) => groupMedian(b) - groupMedian(a)).indexOf(group);
  for (let n = 0; n <= 6; n++) {
    const highs = sorted.slice(0, Math.ceil(n / 2));
    const lows = [...sorted].reverse().slice(0, Math.floor(n / 2));
    const chart = readChart(renderVizSvg({ ...spec, label_extremes: n }, smallRows));
    assert.equal(chart.labels.length, n, `label_extremes=${n} draws ${n} labels`);
    const wanted = [...highs, ...lows];
    assert.equal(new Set(wanted.map((row) => row.u)).size, n, "no unit is labelled twice");
    // the top-most label carries the unit (house unit-once convention)
    let owner = null;
    for (const row of wanted) if (owner === null || groupRank(row.g) < groupRank(owner.g)) owner = row;
    const expectedTexts = wanted.map((row) => `${row.u} ${fmtSpec(spec, row.v, row === owner ? "pts" : "", 1)}`);
    assert.deepEqual(chart.labels.map((label) => label.text).sort(), [...expectedTexts].sort(), `label_extremes=${n}: highest ceil(n/2) and lowest floor(n/2) units, "name value"`);
    for (const label of chart.labels) {
      assert.equal(label.weight, "600");
      assert.equal(label.size, "12");
      assert.equal(label.fill, "#1A1A1A");
    }
  }
  // example from the contract: n=4 labels the 2 highest and the 2 lowest
  assert.deepEqual(readChart(renderVizSvg(spec, smallRows)).labels.map((label) => label.text).sort(), ["B2 30.0 pts", "G1 3.0", "G2 9.0", "G4 25.0"]);
  // omitted label_extremes means 4; a value above the unit count never repeats a unit
  assert.deepEqual(readChart(renderVizSvg({ ...spec, label_extremes: 4 }, smallRows)).labels.map((l) => l.text), readChart(renderVizSvg(spec, smallRows)).labels.map((l) => l.text));
  const three = smallRows.slice(0, 3);
  const many = readChart(renderVizSvg({ ...spec, label_extremes: 6 }, three));
  assert.deepEqual(many.labels.map((label) => label.text).sort(), ["A1 10.0", "A2 14.0", "A3 18.5 pts"], "3 units with label_extremes 6: each labelled once, the unit once");
  // label values come from the row's own value through fmtSpec: default percent style
  const percent = readChart(renderVizSvg({ ...typicalSpec }, typical));
  const byUnit = new Map(typical.map((row) => [row.unit, row.v]));
  assert.equal(percent.labels.length, 4);
  let withUnit = 0;
  for (const label of percent.labels) {
    const name = label.text.slice(0, label.text.lastIndexOf(" "));
    assert.ok(byUnit.has(name), `label '${label.text}' names a unit of the data`);
    const shown = label.text.slice(label.text.lastIndexOf(" ") + 1);
    const bare = fmtSpec(typicalSpec, byUnit.get(name), "");
    const full = fmtSpec(typicalSpec, byUnit.get(name), "%");
    assert.ok(shown === bare || shown === full, `label '${label.text}' prints the unit's own value (${bare} / ${full})`);
    if (shown.endsWith("%")) withUnit++;
  }
  assert.equal(withUnit, 1, "exactly one label (the top-most) carries the unit");
  const expectedHigh = [...typical].sort((a, b) => b.v - a.v).slice(0, 2).map((row) => row.unit);
  const expectedLow = [...typical].sort((a, b) => a.v - b.v).slice(0, 2).map((row) => row.unit);
  assert.deepEqual(percent.labels.map((label) => label.text.slice(0, label.text.lastIndexOf(" "))).sort(), [...expectedHigh, ...expectedLow].sort());
  // legacy style prints the unit on every label
  const legacy = readChart(renderVizSvg({ ...spec, style_id: "legacy" }, smallRows));
  assert.equal(legacy.labels.length, 4);
  assert.ok(legacy.labels.every((label) => /pts$/.test(label.text)), legacy.labels.map((label) => label.text).join(" | "));
  // no label_field, or one the rows lack: no labels, no crash
  const { label_field: _label, ...noField } = spec;
  assert.equal(readChart(renderVizSvg(noField, smallRows)).labels.length, 0);
  assert.equal(readChart(renderVizSvg({ ...spec, label_field: "nope" }, smallRows)).labels.length, 0);

  // every label sits next to its own dot (a short leader at most), and every leader starts on a dot's edge
  for (const chart of ["jitter", "beeswarm"].map((layout) => readChart(renderVizSvg({ ...typicalSpec, point_layout: layout }, typical)))) {
    assert.equal(chart.labels.length, 4);
    for (const leader of chart.leaders) {
      const onEdge = chart.dots.some((dot) => Math.abs(Math.hypot(leader.x1 - dot.x, leader.y1 - dot.y) - (dot.r + 0.8)) < 0.1);
      assert.ok(onEdge, "a leader starts at the edge of a dot");
      assert.ok(Math.hypot(leader.x2 - leader.x1, leader.y2 - leader.y1) <= 80, `leader of ${Math.hypot(leader.x2 - leader.x1, leader.y2 - leader.y1).toFixed(1)}px is short`);
    }
    assert.ok(chart.leaders.length <= chart.labels.length);
  }
}
console.log("strip_plot extremes: ceil/floor selection for 0-6, name+value text via fmtSpec, unit once, no duplicates, leaders -- PASS");

// --- determinism: both layouts, no Math.random, dots inside their band
{
  for (const layout of ["jitter", "beeswarm"]) {
    const spec = { ...typicalSpec, point_layout: layout };
    const a = withoutRandom(() => renderVizSvg(spec, typical));
    const b = withoutRandom(() => renderVizSvg(spec, typical));
    assert.equal(a, b, `${layout} renders identically twice`);
    assert.equal(renderVizBundle(spec, typical).desktop, a);
    const chart = readChart(a);
    const rowOf = new Map(chart.rowLabels.map((row) => [row.text, row.center]));
    typical.forEach((row, i) => assert.ok(Math.abs(chart.dots[i].y - rowOf.get(row.group)) + chart.dots[i].r <= chart.band / 2 + 1e-9, `${layout}: ${row.unit} stays inside its row band`));
    // the layout spreads units: a group of many units does not sit on one line
    const widest = typical.filter((row) => row.group === groupName(4));
    assert.ok(new Set(widest.map((row) => chart.dots[typical.indexOf(row)].y)).size > 3, `${layout} spreads the 38-unit group over several heights`);
  }
  const jitterSpec = { ...typicalSpec, point_layout: "jitter" };
  assert.notEqual(renderVizSvg(jitterSpec, typical), renderVizSvg({ ...typicalSpec, point_layout: "beeswarm" }, typical), "the two layouts differ");
  // jitter depends on the unit's label and row index: reordering the rows moves the offsets, not the x positions
  assert.notEqual(renderVizSvg(jitterSpec, typical), renderVizSvg(jitterSpec, [...typical].reverse()));
  assert.equal(renderVizSvg(typicalSpec, typical), renderVizSvg(typicalSpec, typical.map((row) => ({ ...row }))), "equal data renders equal SVG");

  // beeswarm: dots a few pixels apart are dodged vertically so none overlaps (pin the axis with an outer group)
  const pin = [{ g: "Pin", u: "P1", v: 0 }, { g: "Pin", u: "P2", v: 40 }];
  const swarm = (values) => readChart(renderVizSvg({ ...base, point_layout: "beeswarm", label_extremes: 0 }, [...pin, ...values.map((v, i) => ({ g: "Mid", u: `M${i + 1}`, v }))]));
  const calibrate = swarm([20, 20.5, 21]);
  const pxPerUnit = (calibrate.ticks[calibrate.ticks.length - 1].x - calibrate.ticks[0].x) / (calibrate.ticks[calibrate.ticks.length - 1].value - calibrate.ticks[0].value);
  const gap = 5.5 / pxPerUnit;
  const values = [0, 1, 2, 3].map((k) => Number((20 + k * gap).toFixed(3)));
  const chart = swarm(values);
  const mid = chart.dots.slice(2);
  assert.equal(mid.length, 4);
  let closest = Infinity;
  for (let i = 0; i < mid.length; i++) for (let j = i + 1; j < mid.length; j++) closest = Math.min(closest, Math.hypot(mid[i].x - mid[j].x, mid[i].y - mid[j].y));
  assert.ok(closest >= 2 * 3 + 0.3, `beeswarm separates dots 5.5px apart horizontally (closest pair ${closest.toFixed(2)}px)`);
  assert.ok(new Set(mid.map((dot) => dot.y)).size > 1, "the dodge uses more than one height");
  // the default is the beeswarm: with no point_layout the same rows get the same dodged dots
  const omitted = readChart(renderVizSvg({ ...base, label_extremes: 0 }, [...pin, ...values.map((v, i) => ({ g: "Mid", u: `M${i + 1}`, v }))])).dots.slice(2);
  assert.deepEqual(omitted.map((dot) => [dot.x, dot.y]), mid.map((dot) => [dot.x, dot.y]), "no point_layout places the dots exactly as the beeswarm does");
}
console.log("strip_plot layouts: jitter and beeswarm are deterministic, Math.random-free, inside the band; the beeswarm dodges -- PASS");

// --- the default layout: no point_layout draws the beeswarm, byte for byte; jitter stays an explicit opt-in
{
  const sets = [
    ["typical (zh, 35 groups, 286 units)", typicalSpec, typical],
    ["three groups (en)", base, smallRows],
    ["12 groups with a highlight and 6 labels", { ...base, group_order: "median_asc", highlight_values: ["G03"], label_extremes: 6 }, scattered(12, 8)],
    ["40 groups x 15 units (600 points)", base, scattered(40, 15)],
    ["one group, one unit", base, [{ g: "Solo", u: "S1", v: 12 }]],
  ];
  for (const [name, spec, rows] of sets) {
    assert.equal(Object.hasOwn(spec, "point_layout"), false, `${name}: the spec leaves point_layout out`);
    const byDefault = renderVizBundle(spec, rows);
    const beeswarm = renderVizBundle({ ...spec, point_layout: "beeswarm" }, rows);
    assert.equal(byDefault.desktop, beeswarm.desktop, `${name}: the default desktop SVG is the beeswarm's`);
    assert.equal(byDefault.mobile, beeswarm.mobile, `${name}: the default mobile SVG is the beeswarm's`);
    assert.equal(renderVizSvg({ ...spec, point_layout: undefined }, rows), beeswarm.desktop, `${name}: point_layout undefined is the default too`);
    // jitter is still there when asked for. A single unit sits on its row's centre line in either layout, so only the others differ.
    const jitter = renderVizSvg({ ...spec, point_layout: "jitter" }, rows);
    if (rows.length > 1) assert.notEqual(jitter, byDefault.desktop, `${name}: jitter differs from the default`);
    assert.deepEqual(validateVizSpec(spec), [], `${name}: a spec without point_layout is valid`);
    assert.deepEqual(lint(spec, rows).blockers, [], `${name}: and lints clean`);
  }
}
console.log("strip_plot default layout: no point_layout is the beeswarm (byte for byte), jitter is the explicit opt-in -- PASS");

// --- legacy style and mobile
{
  const legacy = renderVizSvg({ ...base, style_id: "legacy" }, smallRows);
  assert.deepEqual(badTokens(legacy), []);
  assert.equal(readChart(legacy).dots.length, smallRows.length);
  const bundle = renderVizBundle(typicalSpec, typical);
  assert.equal(bundle.mobile, bundle.desktop, "the mobile bundle is the desktop chart (desktop-only form)");
}
console.log("strip_plot legacy style and mobile bundle -- PASS");

// --- render QA: geometry + contrast, 12px floor, no non-finite tokens, every label drawn
{
  const cases = [
    ["typical default layout (zh, 35 groups, 286 units)", typicalSpec, typical, 4],
    ["typical beeswarm (zh)", { ...typicalSpec, point_layout: "beeswarm" }, typical, 4],
    ["typical median_asc, 6 labels", { ...typicalSpec, group_order: "median_asc", label_extremes: 6 }, typical, 6],
    ["typical data order, no medians, no labels", { ...typicalSpec, group_order: "data", show_median: false, label_extremes: 0 }, typical, 0],
    ["typical highlight a group and a unit", { ...typicalSpec, highlight_values: [groupName(1), typical[3].unit] }, typical, 4],
    ["12 groups (en) with unit, decimals, highlight", { ...base, highlight_values: ["G03"], label_extremes: 4 }, scattered(12, 8), 4],
    ["12 groups, 6 labels, beeswarm", { ...base, point_layout: "beeswarm", label_extremes: 6 }, scattered(12, 8), 6],
    ["40 groups x 15 units (600 points)", { ...base, label_extremes: 6 }, scattered(40, 15), 6],
    ["40 groups x 15 units, beeswarm", { ...base, point_layout: "beeswarm" }, scattered(40, 15), 4],
    ["20 groups x 30 units, 6 labels", { ...base, label_extremes: 6 }, scattered(20, 30), 6],
    ["one group, one unit", base, [{ g: "Solo", u: "S1", v: 12 }], 1],
    ["one group, one unit, 6 labels", { ...base, label_extremes: 6 }, [{ g: "Solo", u: "S1", v: 12 }], 1],
    ["two groups, all values equal", base, [{ g: "A", u: "a1", v: 5 }, { g: "A", u: "a2", v: 5 }, { g: "B", u: "b1", v: 5 }, { g: "B", u: "b2", v: 5 }], 4],
    ["all zero", base, [{ g: "A", u: "a1", v: 0 }, { g: "A", u: "a2", v: 0 }, { g: "B", u: "b1", v: 0 }], 3],
    ["negative values", base, [{ g: "A", u: "a1", v: -5 }, { g: "A", u: "a2", v: 3 }, { g: "B", u: "b1", v: 10 }, { g: "B", u: "b2", v: -2.5 }], 4],
    ["values far from zero", base, [{ g: "A", u: "a1", v: 62 }, { g: "A", u: "a2", v: 71 }, { g: "B", u: "b1", v: 97 }, { g: "B", u: "b2", v: 100 }], 4],
    ["no label_field", (({ label_field, ...spec }) => spec)(base), smallRows, 0],
    ["label_extremes 0", { ...base, label_extremes: 0 }, smallRows, 0],
    ["label_extremes 6 on the small set", { ...base, label_extremes: 6 }, smallRows, 6],
    ["percent house style with one decimal", { ...typicalSpec, style_id: "house" }, typical, 4],
    ["localized row labels (zh)", { ...base, language: "zh", category_names: "worldbank" }, ["Zambia", "Liberia", "Ghana", "Nigeria"].flatMap((g, i) => [0, 1, 2].map((k) => ({ g, u: `${g} ${k + 1}`, v: 8 + i * 6 + k * 2.5 }))), 4],
  ];
  for (const [name, spec, rows, labels] of cases) {
    renderQaClean(name, spec, rows, labels);
    // the cases that leave the layout open use the default (beeswarm); run them under the jitter opt-in too
    if (spec.point_layout === undefined) renderQaClean(`${name} [jitter]`, { ...spec, point_layout: "jitter" }, rows, labels);
  }

  // the gate bites on this markup: a label moved onto a dot, or a font shrunk below 12px, fails
  const svg = renderVizSvg(typicalSpec, typical);
  const dot = svg.match(/<circle data-role="data-point" cx="([\d.]+)" cy="([\d.]+)"/);
  const moved = svg.replace(/(<text data-role="direct-label" x=")[\d.]+(" y=")[\d.]+(")/, `$1${dot[1]}$2${dot[2]}$3`);
  assert.equal(runRenderQa({ desktop: moved }).passed, false, "a label drawn over a dot must fail render QA");
  const shrunk = svg.replace('font-size="12"', 'font-size="11"');
  assert.equal(runRenderQa({ desktop: shrunk }).passed, false, "text below 12px must fail render QA");
  assert.notDeepEqual(fontOffenders(shrunk), []);
}
console.log("strip_plot render QA: geometry, contrast, 12px floor, tokens and a full label count on typical, dense and degenerate cases -- PASS");

// --- a plot saturated with dots (integer values in every row of 20-40 groups) has no free spot for every
// label: it stays QA-clean and leaves a label out rather than drawing it over a mark
{
  for (const layout of ["jitter", "beeswarm"]) {
    for (const [name, spec, rows] of [
      ["saturated lattice, 20 groups x 30 integer units", { ...base, point_layout: layout }, lattice(20, 30)],
      ["saturated lattice, 40 groups x 15 integer units", { ...base, point_layout: layout, decimals: 0 }, lattice(40, 15)],
    ]) {
      const svg = renderQaClean(`${name} (${layout})`, spec, rows);
      const labels = readChart(svg).labels.length;
      assert.ok(labels >= 1 && labels <= 4, `${name} (${layout}) draws ${labels} of the 4 labels`);
    }
  }
}
console.log("strip_plot saturated plot: QA-clean, a label with no free position is left out, never drawn over a mark -- PASS");

// --- seeded random charts (five value shapes, 2-40 groups, up to 600 points, both layouts, every group order,
// 1-6 labels, both languages): render QA clean and every requested label drawn. Seeds 166 and 215 are two
// charts whose extreme units cluster in one row, where placing each label at its first free position used to
// leave the last label of the cluster without a place; the layout now backs up and moves an earlier label.
{
  const shapes = ["normal", "skew", "uniform", "bimodal", "lattice"];
  const fuzzCase = (seed, layout) => {
    const rnd = mulberry32(seed * 7919);
    const groups = 2 + Math.floor(rnd() * 39);
    const maxPer = Math.max(1, Math.floor(600 / groups));
    const shape = shapes[seed % shapes.length];
    const rows = [];
    for (let g = 0; g < groups; g++) {
      const per = 1 + Math.floor(rnd() * Math.min(maxPer, 1 + Math.floor(rnd() * 30)));
      const centre = 2 + 25 * rnd();
      const spread = 0.5 + 8 * rnd();
      for (let k = 0; k < per; k++) {
        let v;
        if (shape === "normal") v = centre + (rnd() + rnd() + rnd() - 1.5) * spread;
        else if (shape === "skew") v = 1 + Math.exp(Math.log(centre) + (rnd() + rnd() + rnd() - 1.5) * 0.8);
        else if (shape === "uniform") v = 2 + rnd() * 28;
        else if (shape === "bimodal") v = (rnd() < 0.5 ? 6 : 22) + (rnd() - 0.5) * spread;
        else v = 1 + Math.floor(rnd() * 29);
        rows.push({ g: `Group ${String(g).padStart(2, "0")}`, u: `U${g}-${k}`, v: Math.round(Math.max(0.1, v) * 10) / 10 });
      }
    }
    rows.length = Math.min(rows.length, 600);
    const extremes = 1 + (seed % 6);
    const spec = { ...base, unit: "%", decimals: undefined, point_layout: layout, label_extremes: extremes, group_order: ["median_desc", "median_asc", "data"][seed % 3], language: seed % 2 ? "zh" : "en" };
    delete spec.decimals;
    return { spec, rows, extremes };
  };
  let renders = 0;
  for (let seed = 1; seed <= 240; seed++) {
    for (const layout of ["jitter", "beeswarm"]) {
      const { spec, rows, extremes } = fuzzCase(seed, layout);
      renderQaClean(`random chart seed ${seed} ${layout}`, spec, rows, Math.min(extremes, rows.length));
      renders++;
    }
  }
  assert.equal(renders, 480);
}
console.log("strip_plot random charts: 480 seeded renders are QA-clean with every requested label drawn -- PASS");

// --- numbers on the page: only axis ticks and extreme labels carry digits
{
  for (const [spec, rows] of [[typicalSpec, typical], [{ ...typicalSpec, point_layout: "jitter" }, typical], [base, smallRows], [{ ...base, point_layout: "jitter" }, scattered(12, 8)], [{ ...base, point_layout: "beeswarm" }, scattered(12, 8)]]) {
    const chart = readChart(renderVizSvg(spec, rows));
    const groupNames = new Set(rows.map((row) => row[spec.category_field]));
    for (const rowLabel of chart.rowLabels) assert.ok(groupNames.has(rowLabel.text), `row label '${rowLabel.text}' is a group name of the data`);
    const rowLabelNodes = new Set(chart.rowLabels.map((rowLabel) => rowLabel.node));
    const others = chart.texts.filter((node) => /\d/.test(node.text) && node.attrs["text-anchor"] !== "middle" && node.attrs["data-role"] !== "direct-label" && !rowLabelNodes.has(node));
    assert.deepEqual(others.map((node) => node.text), [], "no other text carries a number");
    for (const label of chart.labels) {
      // "<unit name> <value>[ unit]": the name identifies the row, the number must be that row's own value
      const row = rows.find((candidate) => label.text.startsWith(`${candidate[spec.label_field]} `));
      assert.ok(row, `label '${label.text}' starts with the name of a unit`);
      const shown = Number.parseFloat(label.text.slice(String(row[spec.label_field]).length + 1));
      assert.equal(shown, row[spec.value_field], `label '${label.text}' prints the value of its own row`);
    }
  }
}
console.log("strip_plot numbers: only ticks and extreme labels are numeric, and labels print row values -- PASS");

// --- SVG hash snapshots of typical charts (rewritten only by --update)
// The two jitter cases name their layout, so they still pin the layout that used to be the default; strip_default_* leaves
// point_layout out and pins the default (the beeswarm).
const highlightSpec = { ...base, group_order: "median_asc", highlight_values: ["G03"], label_extremes: 6 };
const snapshotCases = {
  strip_jitter_35_groups_zh: [{ ...typicalSpec, point_layout: "jitter" }, typical],
  strip_beeswarm_35_groups_zh: [{ ...typicalSpec, point_layout: "beeswarm" }, typical],
  strip_jitter_12_groups_en_highlight: [{ ...highlightSpec, point_layout: "jitter" }, scattered(12, 8)],
  strip_default_12_groups_en_highlight: [highlightSpec, scattered(12, 8)],
};
const actual = {};
for (const [name, [spec, rows]] of Object.entries(snapshotCases)) {
  // The new renderer output must pass the product's render-QA gate before it can become a snapshot.
  renderQaClean(name, spec, rows);
  const bundle = renderVizBundle(spec, rows);
  actual[name] = {
    desktop: createHash("sha256").update(bundle.desktop).digest("hex"),
    mobile: createHash("sha256").update(bundle.mobile).digest("hex"),
  };
}

const url = new URL("../fixtures/viz-strip-plot-snapshots.json", import.meta.url);
if (process.argv.includes("--update")) {
  await writeFile(url, JSON.stringify(actual, null, 2) + "\n", "utf8");
  console.log("strip_plot snapshots updated");
  console.log(actual);
  process.exit(0);
}

const expected = JSON.parse(await readFile(url, "utf8"));
assert.deepEqual(actual, expected);
console.log("strip_plot snapshots: PASS");
for (const [name, hashes] of Object.entries(actual)) console.log(`${name}: desktop=${hashes.desktop.slice(0, 12)} mobile=${hashes.mobile.slice(0, 12)}`);
