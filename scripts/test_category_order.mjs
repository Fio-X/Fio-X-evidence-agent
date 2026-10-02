#!/usr/bin/env node
// Category order: small_multiples panels, hierarchy_tree siblings, adjacency_matrix
// and chord nodes and streamgraph series used to be re-sorted by name (UTF-16
// code-unit order), which is no reading order: 甲乙丙丁 came out 丁丙乙甲, 第一至第四
// 季度 came out 一三二四, "Retail, Online, Wholesale, Export" came out alphabetical.
// A text category now keeps the order its rows first mention it in; keys that are
// all numbers (years, also of different widths) or all ISO dates are a sequence and
// sort ascending whatever order the rows came in. The x axis is a sequence too and
// still sorts. Chinese and English names, years, ISO months and dates, numbers
// glued to text, on the desktop and the mobile page. Synthetic data only.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

const common = {
  language: "zh", claim_id: "claim-category-order", sql: "SELECT 1", source_note: "synthetic fixture",
  direct_labels: true, annotations: [], highlight_values: [], title: "Category order", subtitle: "synthetic", takeaway: "t",
  alt: "A synthetic chart whose categories must keep the order the data gives them.", unit: "个",
};
const specs = {
  small_line: { ...common, schema_version: "0.7.0", reader_task: "change", chart_type: "small_multiples", panel_mark: "line", x_field: "x", value_field: "v", facet_field: "f" },
  small_dot: { ...common, schema_version: "0.7.0", reader_task: "comparison", chart_type: "small_multiples", panel_mark: "dot", x_field: "x", value_field: "v", facet_field: "f" },
  hierarchy: { ...common, schema_version: "0.8.0", reader_task: "hierarchy", visual_family: "hierarchy", data_topology: "hierarchy", complexity_budget: "medium", chart_type: "hierarchy_tree", node_field: "node", parent_field: "parent" },
  matrix: { ...common, schema_version: "0.8.0", reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", complexity_budget: "medium", chart_type: "adjacency_matrix", source_field: "s", target_field: "t", value_field: "v" },
  chord: { ...common, schema_version: "0.9.0", reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", complexity_budget: "medium", chart_type: "chord", source_field: "s", target_field: "t", value_field: "v" },
  stream: { ...common, schema_version: "0.8.0", reader_task: "change", visual_family: "temporal", data_topology: "tabular", complexity_budget: "medium", chart_type: "streamgraph", x_field: "x", series_field: "series", value_field: "v" },
};

// [name, category names in the order the rows give them, the order the page must draw them in]
const scenarios = [
  ["Chinese 甲乙丙丁", ["甲部", "乙部", "丙部", "丁部"], ["甲部", "乙部", "丙部", "丁部"]],
  ["Chinese 第一至第四季度", ["第一季度", "第二季度", "第三季度", "第四季度"], ["第一季度", "第二季度", "第三季度", "第四季度"]],
  ["English", ["Retail", "Online", "Wholesale", "Export"], ["Retail", "Online", "Wholesale", "Export"]],
  ["Chinese, already sorted by name", ["丁部", "丙部", "乙部", "甲部"], ["丁部", "丙部", "乙部", "甲部"]],
  ["text with numbers in it", ["Zone 10", "Zone 2", "Zone 1", "Zone 20"], ["Zone 10", "Zone 2", "Zone 1", "Zone 20"]],
  ["numbers and a text key are no sequence", ["2020", "合计", "2019", "2021"], ["2020", "合计", "2019", "2021"]],
  ["years, newest first", ["2022", "2020", "2021", "2019"], ["2019", "2020", "2021", "2022"]],
  ["numbers of different widths", ["100", "9", "10", "-2.5"], ["-2.5", "9", "10", "100"]],
  ["ISO months", ["2024-03", "2023-12", "2024-01", "2023-11"], ["2023-11", "2023-12", "2024-01", "2024-03"]],
  ["ISO dates", ["2024-03-15", "2024-01-02", "2024-02-20", "2023-12-31"], ["2023-12-31", "2024-01-02", "2024-02-20", "2024-03-15"]],
];

const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const byNumber = (key) => (a, b) => a[key] - b[key];

// small_multiples: the title of each panel is the first text of its data-panel-box group.
function panelTitles(svg) {
  const seen = new Set(), titles = [];
  for (const m of svg.matchAll(/<text data-panel-box="([^"]*)"[^>]*>([^<]*)<\/text>/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); titles.push(m[2]); }
  }
  return titles;
}

// hierarchy_tree: node dots with their labels, grouped by level (dot y) and read left to right.
function hierarchyLevels(svg) {
  const nodes = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="[^"]*"\/>\s*<text [^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));
  const levels = new Map();
  for (const node of nodes) levels.set(node.y, [...(levels.get(node.y) ?? []), node]);
  return [...levels.entries()].sort(byNumber(0)).map(([, list]) => list.sort(byNumber("x")).map((node) => node.text));
}

// adjacency_matrix: row labels top to bottom, column labels left to right, and the cell of every edge.
function matrixAxes(svg) {
  const rowLabels = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ y: Number(m[1]), text: m[2] }));
  const colLabels = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" transform="rotate\(-90[^"]*" text-anchor="start"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), text: m[2] }));
  const cells = [...svg.matchAll(/<rect data-role="matrix-cell"[^>]*>/g)].map((m) => attrsOf(m[0]))
    .map((a) => ({ cx: Number(a.x) + Number(a.width) / 2, cy: Number(a.y) + Number(a.height) / 2 }));
  return { rows: rowLabels.sort(byNumber("y")), cols: colLabels.sort(byNumber("x")), cells };
}

// chord: labels in arc order, and the arcs themselves must run clockwise from the top in that order.
function chordNodes(svg) {
  const arcs = [...svg.matchAll(/<path data-role="chord-arc" d="M([-\d.e+]+),([-\d.e+]+) A([\d.]+),[\d.]+ 0 [01] 1 [-\d.e+]+,[-\d.e+]+"[^>]*\/>\s*<text [^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), r: Number(m[3]), text: m[4] }));
  const first = arcs[0];
  const sweep = arcs.map((arc) => (Math.atan2(arc.y - (first.y + first.r), arc.x - first.x) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI));
  return { names: arcs.map((arc) => arc.text), sweep };
}

// streamgraph: legend names and swatches in series order, the stream fills in drawing order, the x axis ends.
function streamParts(svg) {
  const legend = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="9" height="9" fill="(#[0-9A-Fa-f]+)"\/>\s*<text [^>]*>([^<]*)<\/text>/g)].map((m) => ({ fill: m[1], text: m[2] }));
  const fills = [...svg.matchAll(/<path data-role="stream"[^>]*fill="(#[0-9A-Fa-f]+)"/g)].map((m) => m[1]);
  const ends = [...svg.matchAll(/<text x="[\d.]+" y="[\d.]+"(?: text-anchor="end")? font-family="[^"]*" font-size="12" fill="[^"]*">(199[1-4])<\/text>/g)].map((m) => m[1]);
  return { legend, fills, ends };
}

const edgeRows = (names) => names.flatMap((name, i) => [
  { s: name, t: names[(i + 1) % names.length], v: 10 + i },
  ...(i + 2 < names.length ? [{ s: name, t: names[i + 2], v: 3 + i }] : []),
]);

let renders = 0;
const view = (spec, rows) => renderVizBundle(spec, rows, { mobilePages: true });
const bothViewports = (label, bundle, check) => {
  for (const viewport of ["desktop", "mobile"]) {
    const svg = bundle[viewport];
    assert.doesNotMatch(svg, /\b(?:NaN|undefined|Infinity)\b/, `${label} ${viewport}: no NaN/undefined/Infinity token`);
    check(svg, `${label} ${viewport}`);
    renders += 1;
  }
};

for (const [name, given, expected] of scenarios) {
  // small_multiples, line and dot panels: one panel per category, rows interleaved the way a query returns them.
  const years = [2015, 2016, 2017, 2018];
  const lineRows = years.flatMap((year, yi) => given.map((facet, fi) => ({ f: facet, x: year, v: 10 + fi * 5 + yi })));
  bothViewports(`small_multiples line "${name}"`, view(specs.small_line, lineRows), (svg, tag) => {
    assert.deepEqual(panelTitles(svg), expected, `${tag}: panels in the order of the rows, years and dates ascending`);
  });
  const dotRows = given.flatMap((facet, fi) => ["a", "b", "c"].map((x, xi) => ({ f: facet, x, v: 20 + fi * 4 + xi * 7 })));
  bothViewports(`small_multiples dot "${name}"`, view(specs.small_dot, dotRows), (svg, tag) => {
    assert.deepEqual(panelTitles(svg), expected, `${tag}: panels in the order of the rows, years and dates ascending`);
  });

  // hierarchy_tree: the categories are the siblings under the root; the first two have children of their own.
  const kidsOf = new Map([[given[0], ["戊组", "己组"]], [given[1], ["丁组"]]]);
  const treeRows = [
    { node: "总部", parent: null },
    ...given.map((node) => ({ node, parent: "总部" })),
    ...[...kidsOf].flatMap(([parent, kids]) => kids.map((node) => ({ node, parent }))),
  ];
  bothViewports(`hierarchy_tree "${name}"`, view(specs.hierarchy, treeRows), (svg, tag) => {
    const levels = hierarchyLevels(svg);
    assert.deepEqual(levels[0], ["总部"], `${tag}: the root`);
    assert.deepEqual(levels[1], expected, `${tag}: siblings left to right`);
    assert.deepEqual(levels[2], expected.flatMap((key) => kidsOf.get(key) ?? []), `${tag}: children sit under their own parent, in the parents' order and each parent's rows order`);
  });

  // adjacency_matrix and chord: nodes are named by the first row that mentions them.
  const edges = edgeRows(given);
  bothViewports(`adjacency_matrix "${name}"`, view(specs.matrix, edges), (svg, tag) => {
    const { rows, cols, cells } = matrixAxes(svg);
    assert.deepEqual(rows.map((r) => r.text), expected, `${tag}: row labels top to bottom`);
    assert.deepEqual(cols.map((c) => c.text), expected, `${tag}: column labels left to right`);
    assert.equal(cells.length, edges.length, `${tag}: one cell per edge`);
    for (const edge of edges) {
      const row = rows[expected.indexOf(edge.s)], col = cols[expected.indexOf(edge.t)];
      assert.ok(cells.some((cell) => Math.abs(cell.cx - col.x) < 0.02 && Math.abs(cell.cy - (row.y - 3)) < 0.02), `${tag}: the cell for ${edge.s} -> ${edge.t} sits at its row and column`);
    }
  });
  bothViewports(`chord "${name}"`, view(specs.chord, edges), (svg, tag) => {
    const { names, sweep } = chordNodes(svg);
    assert.deepEqual(names, expected, `${tag}: arcs and labels in order`);
    assert.ok(Math.abs(sweep[0]) < 1e-6, `${tag}: the first arc starts at the top`);
    sweep.slice(1).forEach((angle, i) => assert.ok(angle > sweep[i], `${tag}: arc ${i + 2} starts clockwise after arc ${i + 1} (${sweep[i].toFixed(3)} -> ${angle.toFixed(3)})`));
  });

  // streamgraph: series in the order of the rows; the x axis (a sequence) still ascends even when the rows run newest first.
  const streamRows = [1994, 1993, 1992, 1991].flatMap((year, yi) => given.map((series, si) => ({ x: year, series, v: 5 + si * 3 + yi })));
  bothViewports(`streamgraph "${name}"`, view(specs.stream, streamRows), (svg, tag) => {
    const { legend, fills, ends } = streamParts(svg);
    assert.deepEqual(legend.map((l) => l.text), expected, `${tag}: legend in the order of the rows`);
    assert.deepEqual(fills, legend.map((l) => l.fill), `${tag}: streams are stacked in legend order, each in its swatch colour`);
    assert.deepEqual(ends, ["1991", "1994"], `${tag}: the x axis still runs oldest to newest`);
  });
}

// A fixed-order case on top of the sweep: years stay ascending whatever the order of the rows, however the facet is spelt.
{
  const rows = [2021, 2019, 2020].flatMap((year) => [1, 2, 3].map((x) => ({ f: year, x, v: year - 2000 + x })));
  const titles = panelTitles(view(specs.small_line, rows).desktop);
  assert.deepEqual(titles, ["2019", "2020", "2021"], "numeric (not string) facet keys sort ascending");
}

console.log(`category order: ${scenarios.length} orderings x 6 chart variants, ${renders} pages (desktop+mobile): text names keep the rows' order, years and ISO dates ascend, x axis still sorted: PASS`);
