#!/usr/bin/env node
// Adaptive zoom-inset ladder: across data shapes (dense Europe, Caribbean,
// small Gulf states, mid-density Africa, a whole continent) the desktop render
// never trips markers_list_only_exceed_quarter, and no shape gains a QA failure
// rule. Synthetic rows only; no shape-specific code under test.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";

const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const spec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Units per region",
  alt: "A choropleth map of a count per small country, darker meaning a higher count.",
  source_note: "synthetic fixture", claim_id: "claim-ladder",
  sql: "SELECT country, n, year FROM fixture", unit: "n", chart_type: "choropleth",
  category_field: "country", value_field: "n", category_names: "worldbank",
  reference_period_field: "year", mixed_period_strategy: "acknowledge",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license,
  basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], inset: { auto: true },
  measure_kind: "count",
};
const shapes = {
  dense_europe: ["Albania", "Austria", "Belgium", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Czechia", "Denmark", "Estonia", "Greece", "Hungary", "Latvia", "Lithuania", "Luxembourg", "Moldova", "Montenegro", "Netherlands", "North Macedonia", "Poland", "Romania", "Serbia", "Slovak Republic", "Slovenia", "Switzerland"],
  caribbean: ["Antigua and Barbuda", "Bahamas, The", "Barbados", "Cuba", "Dominica", "Dominican Republic", "Grenada", "Haiti", "Jamaica", "St. Kitts and Nevis", "St. Lucia", "St. Vincent and the Grenadines", "Trinidad and Tobago"],
  small_gulf: ["Bahrain", "Qatar", "Kuwait", "United Arab Emirates", "Oman", "Saudi Arabia", "Iraq"],
  mid_africa: ["Ghana", "Togo", "Benin", "Nigeria", "Cote d'Ivoire", "Burkina Faso", "Senegal", "Gambia, The", "Guinea", "Sierra Leone", "Liberia", "Mali", "Guinea-Bissau"],
};
const fails = (q, vp) => ["geometry", "value_labels", "contrast"].flatMap((k) => q.viewports[vp][k]?.failures ?? []).map((f) => f.rule);
for (const [name, countries] of Object.entries(shapes)) {
  const rows = countries.map((country, i) => ({ country, n: 1 + ((i * 7) % 12), year: 2017 }));
  const bundle = renderVizBundle(spec, rows);
  const qa = runRenderQa({ desktop: bundle.desktop }, { choropleth: { rows, category_field: "country", value_field: "n", category_names: "worldbank", unit: "n", measure_kind: "count" } });
  assert.ok(!fails(qa, "desktop").includes("markers_list_only_exceed_quarter"), `${name}: desktop must not leave over a quarter of markers list-only`);
  console.log(name, "desktop QA failures:", JSON.stringify(fails(qa, "desktop")));
}
console.log("inset ladder -- PASS");
