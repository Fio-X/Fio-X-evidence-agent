// P4: text_outside_panel (add-only render QA rule) + the choropleth renderer
// keeping its labels inside their panels. Synthetic data, several shapes.
import assert from "node:assert/strict";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";

const rules = (svg) => checkSvgGeometry(svg).failures.map((f) => f.rule);
const svgOf = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">${inner}</svg>`;

// must-fail: label ends at x=150 and starts near x=20 but its panel starts at x=80
{
  const svg = svgOf(`<text x="150" y="50" text-anchor="end" font-family="sans-serif" font-size="14" data-panel-box="80,10,390,190">Wide label text here</text>`);
  assert.ok(rules(svg).includes("text_outside_panel"), `must fail: ${rules(svg)}`);
  assert.ok(!rules(svg).includes("text_outside_viewbox"), "the label is inside the viewBox; only the panel rule can catch it");
}
// must-pass: same label, panel wide enough (or no panel declared at all)
{
  const ok = svgOf(`<text x="300" y="50" text-anchor="end" font-family="sans-serif" font-size="14" data-panel-box="80,10,390,190">Wide label text here</text>`);
  assert.ok(!rules(ok).includes("text_outside_panel"), `must pass: ${rules(ok)}`);
  const none = svgOf(`<text x="150" y="50" text-anchor="end" font-family="sans-serif" font-size="14">Wide label text here</text>`);
  assert.ok(!rules(none).includes("text_outside_panel"), "texts without data-panel-box are unaffected");
}
// vertical overflow and a transformed group are checked too
{
  const low = svgOf(`<text x="20" y="195" font-family="sans-serif" font-size="14" data-panel-box="0,0,300,150">x</text>`);
  assert.ok(rules(low).includes("text_outside_panel"));
  const moved = svgOf(`<g transform="translate(100,0)"><text x="10" y="50" font-family="sans-serif" font-size="14" data-panel-box="0,0,200,100">ok</text></g>`);
  assert.ok(!rules(moved).includes("text_outside_panel"));
}

// renderer: every label that declares a panel stays in it, whatever the data shape
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const chBase = {
  schema_version: "0.9.0", reader_task: "spatial", title: "T", alt: "A synthetic choropleth of one measure across a handful of named economies.",
  source_note: "synthetic", claim_id: "c1", sql: "SELECT 1", chart_type: "choropleth", category_field: "c", value_field: "v",
  category_names: "worldbank", basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license,
  basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], unit: "%", language: "zh",
};
const shapes = {
  east_africa: ["Ethiopia", "Kenya", "Tanzania", "Uganda", "Somalia", "Djibouti", "Eritrea", "Rwanda", "Burundi"],
  west_africa: ["Senegal", "Gambia, The", "Guinea-Bissau", "Guinea", "Sierra Leone", "Liberia", "Cote d'Ivoire", "Ghana", "Togo", "Benin"],
  south_america: ["Brazil", "Argentina", "Chile", "Peru", "Colombia", "Uruguay", "Paraguay", "Bolivia", "Ecuador", "Venezuela, RB"],
  europe: ["France", "Germany", "Italy", "Spain", "Poland", "Portugal", "Greece", "Serbia", "Austria", "Belgium"],
};
let checkedLabels = 0;
for (const [shape, names] of Object.entries(shapes)) {
  for (const inset of [undefined, { auto: true }]) {
    const rows = names.map((c, i) => ({ c, v: 10 + ((i * 37) % 80) }));
    const spec = { ...chBase, ...(inset ? { inset } : {}) };
    for (const lang of ["zh", "en"]) {
      const { desktop } = renderVizBundle({ ...spec, language: lang }, rows, { mobilePages: false });
      const failing = checkSvgGeometry(desktop).failures.filter((f) => f.rule === "text_outside_panel");
      assert.deepEqual(failing.map((f) => f.message), [], `${shape}/${lang}/${inset ? "inset" : "no-inset"}`);
      checkedLabels += (desktop.match(/data-panel-box=/g) ?? []).length;
    }
  }
}

// small_multiples facets (dot and line, desktop and mobile): must-pass on the real render,
// must-fail once a facet text is moved out of its own cell
const smBase = { ...chBase, chart_type: "small_multiples", facet_field: "f", language: "en", unit: "%" };
delete smBase.basemap_id; delete smBase.basemap_source_url; delete smBase.basemap_license; delete smBase.basemap_content_hash; delete smBase.category_names;
const smShapes = {
  dot_cities: [{ ...smBase, panel_mark: "dot", x_field: "c", value_field: "v" },
    ["North", "South", "East"].flatMap((f, i) => ["Alpha", "Beta", "Gamma", "Delta"].map((c, j) => ({ f, c, v: 20 + i * 15 + j * 9 })))],
  line_years: [{ ...smBase, x_field: "year", value_field: "v" },
    ["Firm A", "Firm B", "Firm C", "Firm D"].flatMap((f, i) => [2018, 2019, 2020, 2021, 2022].map((year, j) => ({ f, year, v: 10 + i * 7 + j * 3 })))],
};
let facetLabels = 0;
for (const [name, [spec, rows]] of Object.entries(smShapes)) {
  const out = renderVizBundle(spec, rows, { mobilePages: false });
  for (const [view, svg] of Object.entries({ desktop: out.desktop, mobile: out.mobile })) {
    if (!svg) continue;
    assert.deepEqual(checkSvgGeometry(svg).failures.filter((f) => f.rule === "text_outside_panel"), [], `${name}/${view} must pass`);
    const n = (svg.match(/data-panel-box=/g) ?? []).length;
    assert.ok(n >= rows.length / 2, `${name}/${view}: facet texts carry a panel box (${n})`);
    facetLabels += n;
    const m = svg.match(/<text ([^>]*?)data-panel-box="([\d.,-]+)"[^>]*>/);
    assert.ok(m, `${name}/${view}: a boxed text exists`);
    const left = Number(m[2].split(",")[0]);
    const moved = svg.replace(m[0], m[0].replace(/ x="[^"]*"/, ` x="${left - 80}"`).replace(/text-anchor="[^"]*"/, 'text-anchor="end"'));
    assert.ok(checkSvgGeometry(moved).failures.some((f) => f.rule === "text_outside_panel"), `${name}/${view} must fail when a facet text leaves its cell`);
  }
}

// trajectory_profile (two stacked panels), generic synthetic series
const tpSpec = { schema_version: "1.1.0", reader_task: "change", visual_family: "temporal", data_topology: "tabular", chart_type: "trajectory_profile", title: "T", alt: "Synthetic two-panel profile of two measures over shared elapsed time.", source_note: "synthetic", note: "n", claim_id: "c1", sql: "x", unit: "state", x_field: "t", altitude_field: "a", speed_field: "s", segment_field: "seg", altitude_unit: "m", speed_unit: "km/h", annotations: [] };
const tpRows = [0, 10, 20, 30, 60, 70, 80].map((t, i) => ({ t, a: 100 + i * 900, s: 40 + (i % 3) * 25, seg: t < 40 ? "one" : "two" }));
{
  const out = renderVizBundle(tpSpec, tpRows, { mobilePages: false });
  for (const [view, svg] of Object.entries({ desktop: out.desktop, mobile: out.mobile })) {
    if (!svg) continue;
    assert.deepEqual(checkSvgGeometry(svg).failures.filter((f) => f.rule === "text_outside_panel"), [], `trajectory/${view} must pass`);
    const boxed = (svg.match(/data-panel-box=/g) ?? []).length;
    assert.ok(boxed >= 6, `trajectory/${view} boxed texts ${boxed}`);
    facetLabels += boxed;
    const m = svg.match(/<text ([^>]*?)data-panel-box="([\d.,-]+)"[^>]*>/);
    const bottom = Number(m[2].split(",")[3]);
    const moved = svg.replace(m[0], m[0].replace(/ y="[^"]*"/, ` y="${bottom + 60}"`));
    assert.ok(checkSvgGeometry(moved).failures.some((f) => f.rule === "text_outside_panel"), `trajectory/${view} must fail when a panel text drops out of its panel`);
  }
}
assert.ok(checkedLabels > 50, `labels carrying a panel box: ${checkedLabels}`);
console.log(`test_render_qa_panel ok (${checkedLabels} choropleth + ${facetLabels} facet panel-boxed labels)`);
