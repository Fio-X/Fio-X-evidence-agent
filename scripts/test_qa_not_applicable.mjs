#!/usr/bin/env node
// NEWSROOM_QA_NO_EMPTY_PASS=1: "not applicable" for a viewport with no chart shapes at all (page text, hero numbers, structure), and
// waffle cells, treemap tiles and 100% stacked segments counted as data marks (they carry a role of their own, not "data-...").
//  - a viewport whose only shapes are untagged or page-structure roles records text_crosses_data_mark under no_empty_pass.not_applicable:
//    neither a pass nor a finding. The condition is read from the SVG, never from a fixture name or chart type.
//  - anything that has marks, or shapes the check cannot place (unknown roles, gridlines and a legend, polygons), is never "not applicable".
//  - a label over a waffle cell, or across a treemap tile's edge, is reported; a tile's own label inside it is not.
//  - off (unset/0/true/""): the report is byte-identical to the one d36d7ff writes (compared through git archive when history exists).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const withSwitch = (v, fn) => {
  const old = process.env.NEWSROOM_QA_NO_EMPTY_PASS;
  if (v === undefined) delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; else process.env.NEWSROOM_QA_NO_EMPTY_PASS = v;
  try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; else process.env.NEWSROOM_QA_NO_EMPTY_PASS = old; }
};
const qa = (svg, v, run = runRenderQa) => withSwitch(v, () => run({ desktop: svg }));
const view = (svg, v = "1") => qa(svg, v).viewports.desktop;
const nep = (svg) => view(svg).extra_checks.no_empty_pass;
const crosses = (svg, v = "1") => view(svg, v).geometry.failures.filter((f) => f.rule === "text_crosses_data_mark");

const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">';
const text = (x, y, s, role = "") => `<text ${role ? `data-role="${role}" ` : ""}x="${x}" y="${y}" font-size="14" fill="#111">${s}</text>`;
// kind 1: pages with no chart shapes
const heroPage = `${head}<rect x="0" y="0" width="400" height="200" fill="#fff"/><rect data-role="module-boundary" x="10" y="10" width="380" height="80" fill="none" stroke="#ccc"/><rect data-role="hero-stat" x="20" y="20" width="120" height="60" fill="#eee"/><line x1="10" y1="100" x2="390" y2="100" stroke="#ccc"/>${text(30, 50, "42%")}${text(30, 130, "一句说明")}</svg>`;
const textOnly = `${head}${text(20, 40, "标题")}</svg>`;
// not applicable must never reach these
const mystery = `${head}<rect data-role="mystery-bar" x="20" y="20" width="40" height="60" fill="#345"/><rect data-role="mystery-bar" x="80" y="40" width="40" height="40" fill="#345"/>${text(20, 150, "说明")}</svg>`;
const gridOnly = `${head}<line data-role="grid-line" x1="10" y1="50" x2="390" y2="50" stroke="#ddd"/><rect data-role="legend-swatch" x="20" y="170" width="10" height="10" fill="#345"/>${text(40, 180, "系列")}</svg>`;
const polygon = `${head}<polygon points="20,20 120,20 70,90" fill="#345"/>${text(20, 150, "说明")}</svg>`;

// cd's probes (1010e F4): charts the renderer forgot to tag. None of them may be "not applicable".
const rolelessBars = `${head}<rect width="400" height="200" fill="#fff"/>${[0, 1, 2, 3].map((i) => `<rect x="${40 + i * 80}" y="${150 - (i + 1) * 30}" width="50" height="${(i + 1) * 30}" fill="#345"/>`).join("")}${text(20, 190, "说明")}</svg>`;
const rolelessLines = `${head}<line x1="20" y1="150" x2="120" y2="100" stroke="#345"/><line x1="120" y1="100" x2="220" y2="120" stroke="#345"/><line x1="220" y1="120" x2="320" y2="40" stroke="#345"/>${text(20, 190, "说明")}</svg>`;
const useOnly = `${head}<defs><path id="m" d="M0 0 L40 0 L40 -60 L0 -60 Z" fill="#345"/></defs><use href="#m" x="40" y="150"/><use href="#m" x="120" y="150"/>${text(20, 190, "说明")}</svg>`;
const singleQuoted = `${head}<rect data-role='mystery-bar' x='20' y='20' width='40' height='60' fill='#345'/>${text(20, 150, "说明")}</svg>`;
const dataAttrOnly = `${head}<rect data-value="3" x="20" y="20" width="40" height="6" fill="#345"/><rect data-series='甲' x="80" y="20" width="40" height="6" fill="#345"/>${text(20, 150, "说明")}</svg>`;
const quotedPage = `${head}<rect width='400' height='200' fill='#fff'/><rect data-role='hero-stat' x='20' y='20' width='120' height='60' fill='#eee'/><line x1='10' y1='100' x2='390' y2='100' stroke='#ccc'/>${text(30, 50, "42%")}</svg>`;

const lineSpec = { schema_version: "0.7.0", reader_task: "change", takeaway: "fixture", chart_type: "multi_line", title: "三国产量", alt: "三条线", source_note: "合成数据", claim_id: "c1", sql: "SELECT 1", unit: "指数", x_field: "year", value_field: "value", series_field: "series", direct_labels: true, annotations: [] };
const lineRows = ["甲国", "乙国", "丙国"].flatMap((s, i) => [2019, 2020, 2021, 2022].map((year, j) => ({ year, series: s, value: 10 + i * 20 + j * (i + 1) * 3 })));
const line = renderVizBundle(lineSpec, lineRows, { mobilePages: false }).desktop;
const waffleSpec = { schema_version: "0.9.0", reader_task: "part_to_whole", takeaway: "Two of these four countries draw most energy from renewables.", title: "Renewable share", alt: "A percentage waffle chart showing four countries' renewable share out of 100, one 10 by 10 grid per country.", source_note: "fixture", claim_id: "cw", sql: "SELECT 1", unit: "%", chart_type: "waffle", category_field: "country", value_field: "pct", reference_period_field: "year", highlight_values: [], annotations: [] };
const waffle = renderVizBundle(waffleSpec, ["Guinea", "Sierra Leone", "Liberia"].map((country, i) => ({ country, pct: 20 + i * 25, year: 2022 })), { mobilePages: false }).desktop;
const treemapSpec = { schema_version: "0.9.0", reader_task: "part_to_whole", takeaway: "Defense and social security are over half the budget.", title: "Budget by function", alt: "A treemap of national budget spending by function, tile area proportional to spending.", source_note: "fixture", claim_id: "ct", sql: "SELECT 1", unit: "$B", chart_type: "treemap", category_field: "function", value_field: "spending_billion", highlight_values: [], annotations: [] };
const treemap = renderVizBundle(treemapSpec, [["Defense", 320], ["Social security", 260], ["Health", 180], ["Education", 90], ["Interest on debt", 60], ["Transportation", 30]].map(([f, v]) => ({ function: f, spending_billion: v })), { mobilePages: false }).desktop;
assert.ok(waffle.includes('data-role="waffle-cell"') && treemap.includes('data-role="treemap-tile"'), "the fixtures draw what they should");

// ---- kind 1: no chart shapes -> not applicable, never a pass and never a finding ----------------------------------------------
for (const [name, svg] of [["hero page", heroPage], ["text only", textOnly]]) {
  const n = nep(svg);
  assert.deepEqual(n.not_applicable.map((x) => x.checked_rule), ["text_crosses_data_mark"], name);
  assert.equal(n.passed, true, `${name}: not a finding`);
  assert.ok(!n.failures.some((f) => f.checked_rule === "text_crosses_data_mark"), `${name}: not reported as empty`);
  assert.equal(n.population.marks, 0, `${name}: and not counted as a pass either`);
  assert.equal(view(svg).passed, true, `${name}: the viewport passes on its other rules`);
}
// ---- nothing that has marks, or shapes the check cannot place, gets "not applicable" -------------------------------------------
for (const [name, svg] of [["line chart", line], ["waffle", waffle], ["treemap", treemap]]) assert.equal(nep(svg).not_applicable, undefined, `${name} has marks`);
assert.ok(nep(line).population.marks > 0);
for (const [name, svg] of [["unknown role", mystery], ["gridlines and a legend only", gridOnly], ["a polygon", polygon],
  ["roleless rect bars", rolelessBars], ["roleless diagonal lines", rolelessLines], ["a chart drawn through <use>", useOnly],
  ["single-quoted unknown role", singleQuoted], ["data attributes on thin rects", dataAttrOnly]]) {
  const n = nep(svg);
  assert.equal(n.not_applicable, undefined, `${name} must not be "not applicable"`);
  assert.ok(n.failures.some((f) => f.checked_rule === "text_crosses_data_mark"), `${name}: still reported as an empty pass`);
}

// page furniture stays not applicable in either quote style
assert.deepEqual(nep(quotedPage).not_applicable?.map((x) => x.checked_rule), ["text_crosses_data_mark"], "a single-quoted page is still a page");

// a chart whose data roles are stripped still has paths: it is never "not applicable" (whatever else it reports)
assert.equal(nep(line.replace(/data-role="[a-z-]*"/g, "")).not_applicable, undefined, "a chart with its roles stripped still has chart shapes");

// ---- kind 2: waffle cells and treemap tiles are marks --------------------------------------------------------------------------
const w = nep(waffle);
assert.equal(w.population.marks, (waffle.match(/data-role="waffle-cell"/g) ?? []).length, "every waffle cell counts");
assert.deepEqual(w.failures, []);
assert.equal(crosses(waffle).length, 0, "a waffle chart's own labels clear its cells");
const cell = /<rect data-role="waffle-cell" x="([\d.]+)" y="([\d.]+)"/.exec(waffle);
const labelled = waffle.replace("</svg>", `${text(Number(cell[1]) + 2, Number(cell[2]) + 12, "标签", "")}</svg>`);
assert.ok(crosses(labelled).length === 1, "a label over a waffle cell is reported");
const t = nep(treemap);
assert.equal(t.population.marks, (treemap.match(/data-role="treemap-tile"/g) ?? []).length, "every treemap tile counts");
assert.deepEqual(t.failures, []);
assert.equal(crosses(treemap).length, 0, "a tile's own name/share/value inside it is not reported");
const lab = /<text data-role="treemap-tile-label" x="([\d.]+)"/.exec(treemap);
const across = treemap.replace(lab[0], lab[0].replace(`x="${lab[1]}"`, `x="${Number(lab[1]) + 295}"`));
assert.notEqual(across, treemap);
assert.ok(crosses(across).length >= 1, "a tile label that leaves its tile is reported");

// ---- off: byte-identical to d36d7ff ---------------------------------------------------------------------------------------------
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", "d36d7ff", "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) {
  console.log("d36d7ff history unavailable; skipped the byte comparison with it");
} else {
  const dir = mkdtempSync(join(tmpdir(), "qa-na-base-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "base.tar"), archive.stdout);
  assert.equal(spawnSync("tar", ["-xf", join(dir, "base.tar"), "-C", dir]).status, 0);
  const base = await import(pathToFileURL(join(dir, "runtime/pi/render_qa.mjs")).href);
  for (const [name, svg] of [["hero page", heroPage], ["text only", textOnly], ["line", line], ["waffle", waffle], ["treemap", treemap], ["labelled waffle", labelled], ["moved treemap label", across], ["roleless bars", rolelessBars], ["roleless lines", rolelessLines], ["use only", useOnly], ["single quoted", singleQuoted], ["data attrs", dataAttrOnly], ["quoted page", quotedPage], ["mystery", mystery]]) {
    const was = JSON.stringify(qa(svg, undefined, base.runRenderQa));
    for (const v of [undefined, "0", "true", "", " 1", "01"]) assert.equal(JSON.stringify(qa(svg, v)), was, `${name}: off (${JSON.stringify(v)}) is byte-identical to d36d7ff`);
  }
  // on, a chart this change does not touch: the same report as d36d7ff with the switch on
  assert.equal(JSON.stringify(qa(line, "1")), JSON.stringify(qa(line, "1", base.runRenderQa)), "a line chart reports the same with the switch on");
  console.log("ok: off is byte-identical to d36d7ff (14 SVGs x 6 values)");
}
console.log("PASS qa not applicable");
