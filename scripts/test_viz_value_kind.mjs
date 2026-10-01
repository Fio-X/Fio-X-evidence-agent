// P2: unit/measure formatting must be consistent across chart types.
// Synthetic offline data, several value shapes (amounts in $B on a zh page,
// whole counts, calendar years, a duration measured in years, plain share).
import assert from "node:assert/strict";
import { basename } from "node:path";
import { choroplethValueText, fmtSpec, renderVizBundle, specValueKind, tickLabelSpec } from "../runtime/pi/viz.mjs";
import { CHOROPLETH_BASEMAP_ID, niceBreaks } from "../runtime/pi/choropleth.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";

const barBase = {
  schema_version: "0.9.0", reader_task: "comparison", title: "T", alt: "A synthetic bar chart of one measure across several named items.",
  source_note: "synthetic", claim_id: "c1", sql: "SELECT 1", chart_type: "horizontal_bar",
  category_field: "name", value_field: "v", sort: "desc", annotations: [],
};
const text = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

// --- specValueKind -------------------------------------------------------
assert.equal(specValueKind({ unit: "x" }), null);
assert.equal(specValueKind({ unit: "x", measure_kind: "count" }), "count");
assert.equal(specValueKind({ unit: "year", measure_kind: "index" }), "year");
assert.equal(specValueKind({ unit: "year", measure_kind: "duration" }), null, "duration in years is a quantity");
assert.equal(specValueKind({ unit: "年", value_field: "y", measure_semantics: [{ field: "y", unit: "年", measure_kind: "index" }] }), "year");
assert.equal(specValueKind({ unit: "n", value_field: "y", measure_semantics: [{ field: "other", measure_kind: "count" }, { field: "y", measure_kind: "level" }] }), null);

// --- fmtSpec / tickLabelSpec --------------------------------------------
assert.equal(fmtSpec({ unit: "year", measure_kind: "year" }, 2017), "2017");
assert.equal(fmtSpec({ unit: "个", measure_kind: "count" }, 3), "3 个");
assert.equal(fmtSpec({ unit: "个", measure_kind: "count" }, 12345, ""), "12,345");
assert.equal(fmtSpec({ unit: "个", measure_kind: "count" }, 2.5), "2.5 个", "non-integer is never rounded to look like a count");
assert.equal(fmtSpec({ unit: "$B", language: "zh" }, 221.4), "2,214亿美元");
assert.equal(fmtSpec({ unit: "$B", language: "zh" }, 219.0), "2,190亿美元");
assert.equal(fmtSpec({ unit: "$B", language: "zh" }, 221.4, ""), "2,214");
assert.notEqual(fmtSpec({ unit: "$B", language: "zh" }, 221.4), fmtSpec({ unit: "$B", language: "zh" }, 219.0));
assert.equal(fmtSpec({ unit: "$B", language: "en" }, 221.4), "221 $B", "en page unchanged");
assert.equal(fmtSpec({ unit: "%" }, 12), "12%");
assert.equal(tickLabelSpec({ unit: "$B", language: "zh" }, 100, ""), "1,000");
assert.equal(tickLabelSpec({ unit: "%" }, 20, "%"), "20%");

// --- choropleth value text (spelled as the integer it is) ------------------
assert.equal(choroplethValueText(2017, "year", { unit: "year", measure_kind: "year" }), "2017");
assert.equal(choroplethValueText(3, "个", { unit: "个", measure_kind: "count" }), "3 个");
assert.equal(choroplethValueText(2017, "year"), "2.0k year", "no spec -> legacy spelling unchanged");
assert.equal(choroplethValueText(70, "%", { unit: "%" }), "70.0%");

// --- niceBreaks integer ----------------------------------------------------
for (const [lo, hi] of [[0, 2], [0, 3], [1, 9], [2005, 2023], [0, 47]]) {
  const b = niceBreaks(lo, hi, 5, { integer: true });
  assert.ok(b.every(Number.isInteger), `integer breaks for ${lo}-${hi}: ${b}`);
  assert.ok(b[0] <= lo && b[b.length - 1] >= hi);
}
assert.ok(!niceBreaks(0, 2, 5).every(Number.isInteger), "default breaks keep their fractional steps (unchanged)");

// --- bar charts: three shapes ----------------------------------------------
{
  const rows = [{ name: "Alpha", v: 221.4 }, { name: "Beta", v: 219.0 }, { name: "Gamma", v: 48.25 }];
  const zh = renderVizBundle({ ...barBase, unit: "$B", language: "zh" }, rows).desktop;
  const labels = text(zh);
  assert.ok(labels.some((t) => t === "2,214亿美元"), `top zh bar label: ${labels}`);
  assert.ok(labels.some((t) => t === "2,190"), `second zh bar label: ${labels}`);
  assert.ok(!labels.some((t) => /\$B/.test(t)), "no raw $B token on a zh bar chart");
  assert.ok(new Set(labels.filter((t) => /^2,(214|190)/.test(t))).size === 2, "Alpha and Beta must not read the same");
  const en = renderVizBundle({ ...barBase, unit: "$B", language: "en" }, rows).desktop;
  assert.ok(text(en).some((t) => /\$B/.test(t)), "en bar chart keeps $B");
}
{
  const rows = [{ name: "Alpha", v: 3 }, { name: "Beta", v: 12 }, { name: "Gamma", v: 1500 }];
  const svg = renderVizBundle({ ...barBase, unit: "items", measure_kind: "count" }, rows).desktop;
  const labels = text(svg);
  assert.ok(labels.includes("1,500 items") || labels.includes("1500 items"), `count label: ${labels}`);
  assert.ok(labels.includes("3") && labels.includes("12"), "bare integers on the other rows");
  assert.ok(!labels.some((t) => /\d\.\dk/.test(t)), "no 1.5k style abbreviation on counts");
}
{
  const rows = [{ name: "Alpha", v: 2017 }, { name: "Beta", v: 1998 }, { name: "Gamma", v: 2024 }];
  const svg = renderVizBundle({ ...barBase, unit: "year", measure_kind: "year", sort: "none" }, rows).desktop;
  const labels = text(svg);
  for (const y of ["2017", "1998", "2024"]) assert.ok(labels.includes(y), `year ${y} in ${labels}`);
  assert.ok(!labels.some((t) => /\d\.\dk/.test(t)));
}
{
  // duration measured in years is still a quantity: decimals survive
  const rows = [{ name: "Alpha", v: 72.4 }, { name: "Beta", v: 65.1 }];
  const svg = renderVizBundle({ ...barBase, unit: "years", measure_kind: "duration" }, rows).desktop;
  assert.ok(text(svg).some((t) => t.startsWith("72.4")), text(svg).join("|"));
}

// --- choropleth: count and year shapes ------------------------------------
{
  const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
  const chBase = {
    schema_version: "0.9.0", reader_task: "spatial", title: "T", alt: "A synthetic choropleth of one measure across a handful of named economies.",
    source_note: "synthetic", claim_id: "c1", sql: "SELECT 1", chart_type: "choropleth", category_field: "c", value_field: "v",
    category_names: "worldbank", basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license,
    basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [],
  };
  const names = ["Chad", "Niger", "Nigeria", "Zambia", "Guinea"];
  const shapes = [
    { unit: "year", measure_kind: "year", vals: [2017, 2019, 2021, 2018, 2022], expect: (v) => String(v) },
    { unit: "items", measure_kind: "count", vals: [1, 3, 4, 7, 9], expect: (v) => `${v} items` },
  ];
  for (const sh of shapes) {
    const rows = names.map((c, i) => ({ c, v: sh.vals[i] }));
    const svg = renderVizBundle({ ...chBase, unit: sh.unit, measure_kind: sh.measure_kind }, rows, { mobilePages: false }).desktop;
    const t = text(svg);
    for (const v of sh.vals) assert.ok(t.includes(sh.expect(v)) || t.some((x) => x.includes(sh.expect(v))), `${sh.unit}: label for ${v} missing in ${t.join("|")}`);
    assert.ok(!t.some((x) => /\d\.\dk/.test(x)), `${sh.unit}: no k abbreviation`);
    const legend = [...svg.matchAll(/<text[^>]*y="[\d.]+" text-anchor="(?:middle|end)"[^>]*fill="[^"]*">([\d.,]+[^<]*)<\/text>/g)].map((m) => m[1]);
    assert.ok(legend.length >= 2, `legend found: ${legend}`);
    assert.ok(legend.every((x) => !/\.\d/.test(x)), `${sh.unit}: legend ticks must be whole numbers: ${legend}`);
  }
}
console.log(`${basename(import.meta.url)} ok`);
