// Chart-form registry and matcher (runtime/pi/page_skeleton.mjs). Offline, node only.
// 1. the built table is exactly STRICT_GRAMMAR_FORMS (read from newsroom.ts) ∩ TEMPLATE_CHART_TYPES ∩ PUBLICATION_TYPES ∩ MARK_SEMANTICS ∩ shape rows;
// 2. the shape rows' row caps equal MAX_CHART_ROWS and the choropleth cap written in newsroom.ts;
// 3. the matcher picks the first satisfying row, with no branch per chart type: a fake row added to the shape table and the four tables is selected;
// 4. an empty intersection reports which table or row is missing, with no fallback;
// 5. mutation: a chart type dropped from one table leaves the table without that row and the report names that table.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PUBLICATION_TYPES, TEMPLATE_CHART_TYPES } from "../runtime/pi/design_pack.mjs";
import { MARK_SEMANTICS, CHART_FORM_SHAPES, buildChartFormTable, chartFormTable, matchChartForm } from "../runtime/pi/page_skeleton.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TS = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const strictLiteral = /const STRICT_GRAMMAR_FORMS: Record<string, string\[\]> = (\{[\s\S]*?\n\});/.exec(TS)[1];
const STRICT = Function(`return (${strictLiteral})`)();
const inputs = { strict: STRICT, templates: TEMPLATE_CHART_TYPES, publication: PUBLICATION_TYPES, marks: MARK_SEMANTICS };
const results = [];
const ok = (name, f) => { f(); results.push(name); console.log(`  ok  ${name}`); };

ok("1 the table is the intersection of the four tables and the shape rows", () => {
  const table = buildChartFormTable(inputs);
  const expected = CHART_FORM_SHAPES.map((s) => s.chart_type).filter((type) => Object.values(STRICT).some((forms) => forms.includes(type)) && TEMPLATE_CHART_TYPES.includes(type) && type in PUBLICATION_TYPES && type in MARK_SEMANTICS);
  assert.deepEqual(table.rows.map((row) => row.chart_type), expected);
  assert.deepEqual(expected, ["choropleth", "horizontal_bar", "dot", "line"]);
  for (const row of table.rows) assert.equal(row.mark, MARK_SEMANTICS[row.chart_type]);
});

ok("2 row caps equal the caps in newsroom.ts", () => {
  const max = Number(/const MAX_CHART_ROWS = (\d+);/.exec(TS)[1]);
  const choro = Number(/supports at most (\d+) rows/.exec(TS)[1]);
  for (const shape of CHART_FORM_SHAPES) assert.equal(shape.max_rows, shape.chart_type === "choropleth" ? choro : max, shape.chart_type);
});

ok("3a the matcher picks the first satisfying row", () => {
  const table = chartFormTable(inputs);
  const pick = (need) => matchChartForm(table, need);
  assert.equal(pick({ relations: ["rank"], kind: "category", rows: 10, resolvable: false }).form.chart_type, "horizontal_bar");
  assert.equal(pick({ relations: ["rank", "geography"], kind: "geo_code", rows: 40, resolvable: true }).form.chart_type, "choropleth");
  assert.equal(pick({ relations: ["rank", "geography"], kind: "geo_code", rows: 40, resolvable: false }).form.chart_type, "horizontal_bar");
  assert.equal(pick({ relations: ["rank", "geography"], kind: "geo_code", rows: 70, resolvable: true }).form.chart_type, "horizontal_bar");
  assert.equal(pick({ relations: ["trend"], kind: "time", rows: 30, resolvable: false }).form.chart_type, "line");
});

ok("3b adding one row makes the matcher select it (no per-chart branch)", () => {
  const fake = Object.freeze({ chart_type: "fake_chart", accepts: Object.freeze(["category"]), max_rows: 5, needs_resolvable_codes: false });
  const wide = {
    strict: { ...STRICT, rank: ["fake_chart", ...STRICT.rank] },
    templates: [...TEMPLATE_CHART_TYPES, "fake_chart"],
    publication: { ...PUBLICATION_TYPES, fake_chart: { publication: "static_svg" } },
    marks: { ...MARK_SEMANTICS, fake_chart: "length" },
    shapes: [fake, ...CHART_FORM_SHAPES],
  };
  const table = chartFormTable(wide);
  assert.equal(matchChartForm(table, { relations: ["rank"], kind: "category", rows: 4, resolvable: false }).form.chart_type, "fake_chart");
  assert.equal(matchChartForm(table, { relations: ["rank"], kind: "category", rows: 6, resolvable: false }).form.chart_type, "horizontal_bar");
});

ok("4 an empty intersection names the missing table or row and does not fall back", () => {
  const table = chartFormTable(inputs);
  const none = matchChartForm(table, { relations: ["change"], kind: "category", rows: 12, resolvable: false });
  assert.equal(none.ok, false);
  assert.equal(none.code, "CHART_FORM_NONE");
  assert.match(none.message, /dumbbell \(change\) lacks shape table \(CHART_FORM_SHAPES\)/);
  assert.match(none.message, /slope \(change\) lacks shape table/);
  assert.equal(matchChartForm(table, { relations: [], kind: "category", rows: 1 }).ok, false);
});

ok("5 mutation: a chart type missing from one table loses its row and the report says which table", () => {
  for (const [name, mutate, table] of [
    ["templates", (i) => ({ ...i, templates: i.templates.filter((t) => t !== "dot") }), "drafting templates"],
    ["publication", (i) => ({ ...i, publication: Object.fromEntries(Object.entries(i.publication).filter(([k]) => k !== "dot")) }), "publication map"],
    ["marks", (i) => ({ ...i, marks: Object.fromEntries(Object.entries(i.marks).filter(([k]) => k !== "dot")) }), "mark semantics"],
    ["strict", (i) => ({ ...i, strict: Object.fromEntries(Object.entries(i.strict).map(([k, v]) => [k, v.filter((t) => t !== "dot")])) }), "strict grammar"],
  ]) {
    const built = buildChartFormTable(mutate(inputs));
    assert.ok(!built.rows.some((row) => row.chart_type === "dot"), name);
    const gap = built.gaps.find((g) => g.chart_type === "dot");
    assert.ok(gap?.missing.some((m) => m.includes(table)), name);
    assert.ok(built.rows.some((row) => row.chart_type === "horizontal_bar"), name);
  }
});

console.log(`chart forms: ${results.length} checks -- PASS`);
