#!/usr/bin/env node
// Tests for runtime/pi/render_qa_contrast.mjs: a deterministic WCAG
// text-contrast check over rendered SVG (no browser). Three parts:
//
//   1. UNIT FIXTURES -- small synthetic SVG strings built by hand in this
//      file. They exercise one mechanism each (blending, halo, large-text
//      threshold, unresolved backgrounds, WCAG reference greys). These are
//      NOT evidence of any real chart's quality; they are regression
//      fixtures for the contrast-checking code itself.
//   2. An INFORMATIONAL pass over one instance of every chart type the
//      existing viz/infographic test and benchmark suites render, printing
//      failure/unmeasured counts per chart type. Not asserted.
//   3. An INFORMATIONAL replay over a real run's rendered SVGs, if present
//      locally. Not asserted.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSvgContrast } from "../runtime/pi/render_qa_contrast.mjs";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";
import { composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from "../runtime/pi/cartography.mjs";

// =============================================================================
// 1. UNIT FIXTURES (synthetic SVG strings, not evidence of any real chart)
// =============================================================================

const page = (bodyMarkup) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${bodyMarkup}</svg>`;
const labelOnWhite = (fg, fontAttrs = 'font-size="16"') =>
  page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" ${fontAttrs} fill="${fg}">Reference pair</text>`);

// --- pass and fail on a plain white page background ------------------------
{
  const passResult = checkSvgContrast(page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="16" fill="#111111">Readable label</text>`));
  assert.equal(passResult.passed, true, JSON.stringify(passResult));
  assert.equal(passResult.failures.length, 0);
  assert.equal(passResult.unmeasured.length, 0);

  const failResult = checkSvgContrast(page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="16" fill="#dddddd">Low contrast label</text>`));
  assert.equal(failResult.passed, false, JSON.stringify(failResult));
  assert.equal(failResult.failures.length, 1);
  assert.equal(failResult.failures[0].rule, "text_contrast");
  assert.equal(failResult.failures[0].background, "#ffffff");
  assert.equal(failResult.failures[0].required, 4.5);
}
console.log("unit: pass/fail on white background -- PASS");

// --- text sitting over a dark rect (not the page background) ---------------
{
  const svg = page(`<rect x="0" y="0" width="200" height="100" fill="#0a0a0a"/><text x="20" y="50" font-size="16" fill="#ffffff">On dark</text>`);
  const result = checkSvgContrast(svg);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.unmeasured.length, 0);
}
console.log("unit: text over a dark rect (not the page default) -- PASS");

// --- a semi-transparent rect must be alpha-blended over the page, not
//     treated as fully opaque or ignored ------------------------------------
{
  // 50% black over a white page composites to rgb(127.5,127.5,127.5) --
  // "#808080" after display rounding. Foreground is set to the same grey so
  // an incorrect blend (opaque black background, or ignoring the rect
  // entirely) would change both the reported background hex and the ratio.
  // The raw composite (127.5) differs from the integer foreground (128) by
  // half a level, so the ratio is 1.01, not exactly 1 -- still pins the
  // blend to 2 decimal places.
  const svg = page(`<rect x="0" y="0" width="200" height="100" fill="#000000" fill-opacity="0.5"/><text x="20" y="50" font-size="16" fill="#808080">Blend check</text>`);
  const result = checkSvgContrast(svg);
  assert.equal(result.passed, false, JSON.stringify(result));
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].background, "#808080");
  assert.equal(result.failures[0].foreground, "#808080");
  assert.equal(result.failures[0].ratio, 1.01);
}
console.log("unit: semi-transparent background rect is alpha-blended -- PASS");

// --- halo text (paint-order stroke, >=2px) counts the stroke as background --
{
  const base = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="16" fill="#ffffff" stroke="#000000" stroke-width="3" paint-order="stroke fill">Halo label</text>`);
  const haloResult = checkSvgContrast(base);
  assert.equal(haloResult.passed, true, JSON.stringify(haloResult));

  const noHalo = base.replace(' paint-order="stroke fill"', "");
  const noHaloResult = checkSvgContrast(noHalo);
  assert.equal(noHaloResult.passed, false, "sanity check: without paint-order this is white-on-white and must fail");

  const thinStroke = base.replace('stroke-width="3"', 'stroke-width="1"');
  const thinStrokeResult = checkSvgContrast(thinStroke);
  assert.equal(thinStrokeResult.passed, false, "a <2px stroke must not be treated as a halo background");
}
console.log("unit: halo stroke (paint-order, >=2px) used as background -- PASS");

// --- large text passes at 3:1 where the same colours fail 4.5:1 ------------
{
  // #949494 on white ~= 3.03:1 (fails 4.5:1, passes 3:1).
  const large = checkSvgContrast(labelOnWhite("#949494", 'font-size="24"'));
  assert.equal(large.passed, true, JSON.stringify(large));

  const normalSize = checkSvgContrast(labelOnWhite("#949494", 'font-size="16"'));
  assert.equal(normalSize.passed, false, "the same colours at normal size must fail the stricter 4.5:1 threshold");

  const boldLarge = checkSvgContrast(labelOnWhite("#949494", 'font-size="19" font-weight="700"'));
  assert.equal(boldLarge.passed, true, "bold text counts as large from 18.66px");

  const boldTooSmall = checkSvgContrast(labelOnWhite("#949494", 'font-size="18" font-weight="700"'));
  assert.equal(boldTooSmall.passed, false, "bold text below 18.66px is still normal text");
}
console.log("unit: large-text 3:1 threshold (size and bold-size) -- PASS");

// --- an unresolved (gradient) background must be reported, not guessed -----
{
  const svg = page(`<defs><linearGradient id="g1"><stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect x="0" y="0" width="200" height="100" fill="url(#g1)"/><text x="20" y="50" font-size="16" fill="#333333">Over a gradient</text>`);
  const result = checkSvgContrast(svg);
  assert.equal(result.failures.length, 0, "must not silently fail an unresolved background");
  assert.equal(result.unmeasured.length, 1);
  assert.equal(result.unmeasured[0].rule, "text_contrast");
  assert.match(result.unmeasured[0].reason, /gradient/);
}
console.log("unit: gradient background is reported as unmeasured, not guessed -- PASS");

// --- known WCAG reference pairs ---------------------------------------------
{
  // #777777 on #ffffff ~= 4.4787:1 -> fails 4.5:1.
  const failPair = checkSvgContrast(labelOnWhite("#777777"));
  assert.equal(failPair.passed, false, JSON.stringify(failPair));
  assert.equal(failPair.failures[0].ratio, 4.48);

  // #767676 on #ffffff ~= 4.5424:1 -> passes 4.5:1 by a small margin.
  const passPair = checkSvgContrast(labelOnWhite("#767676"));
  assert.equal(passPair.passed, true, JSON.stringify(passPair));
  assert.equal(passPair.unmeasured.length, 0);
  // Confirm the exact ratio via a deliberately stricter threshold (still a
  // documented option, not a change to the module's real default), which
  // turns this same pair into a failure and exposes its numeric ratio.
  const strict = checkSvgContrast(labelOnWhite("#767676"), { normalRatio: 4.6 });
  assert.equal(strict.passed, false);
  assert.equal(strict.failures[0].ratio, 4.54);
}
console.log("unit: WCAG reference pairs #777777/#767676 on white -- PASS");

// --- bonus: rotation about the text's own anchor point resolves exactly,
//     and an ordinary complex (curved) path is reported as unmeasured ------
{
  const rotated = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="16" fill="#111111" transform="rotate(-55 20 50)">Rotated about self</text>`);
  const rotatedResult = checkSvgContrast(rotated);
  assert.equal(rotatedResult.passed, true, JSON.stringify(rotatedResult));
  assert.equal(rotatedResult.unmeasured.length, 0, "rotation about the text's own anchor keeps the anchor point fixed and resolvable");

  const curved = page(`<path d="M0,0 C0,100 200,0 200,100 L0,100 Z" fill="#222222"/><text x="20" y="50" font-size="16" fill="#ffffff">Over a curve</text>`);
  const curvedResult = checkSvgContrast(curved);
  assert.equal(curvedResult.failures.length, 0);
  assert.equal(curvedResult.unmeasured.length, 1);
  assert.match(curvedResult.unmeasured[0].reason, /complex/);
}
console.log("unit: rotation-about-own-anchor and complex-path bonus cases -- PASS");

// --- per-run evaluation: a wrapping <text>/<tspan>'s own fill is never
//     painted as glyphs when every child is a coloured <tspan>. Modelled on
//     a real false positive from the owner's accepted Africa map spike:
//     "#000000 on #1d3557" was reported for a <text fill="#000"> whose only
//     visible glyphs are white <tspan>s -- the black parent fill never
//     renders. Each fixture below is a labelled unit fixture, not evidence
//     of any real chart. --------------------------------------------------
{
  // The reported pattern: a black-fill parent <text> with no direct text of
  // its own, wrapping two white-fill runs (one a nested tspan positioned by
  // dy). This must pass: the actual rendered glyphs are white-on-navy.
  const reportedPattern = page(
    `<rect x="0" y="0" width="200" height="100" fill="#1d3557"/>` +
      `<text x="20" y="40" fill="#000000" font-size="16">` +
      `<tspan fill="#ffffff" font-size="13" font-weight="600">Name label</tspan>` +
      `<tspan dy="16" fill="#000000"><tspan fill="#ffffff" font-weight="700" font-size="13">96.3%</tspan></tspan>` +
      `</text>`
  );
  const passResult = checkSvgContrast(reportedPattern);
  assert.equal(passResult.passed, true, JSON.stringify(passResult));
  assert.equal(passResult.failures.length, 0);
  assert.equal(passResult.unmeasured.length, 0);

  // Same shape, but the innermost run's own fill (#2a3a55, not the black
  // parent's) is too close to the #1d3557 background: this run must fail,
  // and the reported foreground must be the tspan's own colour.
  const failingRun = page(
    `<rect x="0" y="0" width="200" height="100" fill="#1d3557"/>` +
      `<text x="20" y="40" fill="#000000" font-size="16">` +
      `<tspan fill="#ffffff" font-size="13" font-weight="600">Name label</tspan>` +
      `<tspan dy="16" fill="#000000"><tspan fill="#2a3a55" font-weight="700" font-size="13">96.3%</tspan></tspan>` +
      `</text>`
  );
  const failResult = checkSvgContrast(failingRun);
  assert.equal(failResult.passed, false, JSON.stringify(failResult));
  assert.equal(failResult.failures.length, 1);
  assert.equal(failResult.failures[0].foreground, "#2a3a55");
  assert.equal(failResult.failures[0].background, "#1d3557");
  assert.match(failResult.failures[0].element, /96\.3%/);

  // A parent with direct text of its own PLUS a differently-coloured child
  // tspan must yield two independently-evaluated runs, not one merged run
  // that only sees the parent's colour. Both colours are deliberately
  // distinguishable failures against the white page so both must surface.
  const twoRuns = page(`<text x="20" y="50" font-size="16" fill="#dddddd">Prefix <tspan fill="#eeeeee">Suffix</tspan></text>`);
  const twoRunsResult = checkSvgContrast(twoRuns);
  assert.equal(twoRunsResult.failures.length, 2, "a parent with direct text plus a differently coloured tspan must yield two runs");
  assert.deepEqual(twoRunsResult.failures.map((f) => f.foreground).sort(), ["#dddddd", "#eeeeee"]);
  assert.ok(twoRunsResult.failures.some((f) => f.element.startsWith("text[") && /Prefix/.test(f.element)), "the parent's own direct text must be its own run");
  assert.ok(twoRunsResult.failures.some((f) => f.element.startsWith("tspan[") && /Suffix/.test(f.element)), "the child tspan must be its own run");
}
console.log("unit: per-run evaluation fixes the wrapping-text-fill false positive -- PASS");

// --- exact polygon/path containment, not bbox-only. Modelled on a second
//     false positive from the owner's accepted Africa map spike: labels sat
//     over a navy country fill, but a later cream land path (painted after
//     the country) had a bounding box that happened to contain the label
//     anchor even though its actual (concave, multi-ring) shape did not.
//     Each fixture below is a labelled unit fixture, not evidence of any
//     real chart. --------------------------------------------------------
{
  // An L-shaped (concave) polygon: bbox is the full [0,100]x[0,100] square,
  // but the bottom-right quadrant is a notch that is NOT part of the shape.
  const svg = page(
    `<rect x="0" y="0" width="200" height="200" fill="#1d3557"/>` +
      `<polygon points="0,0 100,0 100,50 50,50 50,100 0,100" fill="#f8f6f1"/>` +
      `<text x="75" y="75" fill="#ffffff" font-size="16">Notch label</text>` +
      `<text x="25" y="25" fill="#ffffff" font-size="16">Inside label</text>`
  );
  const result = checkSvgContrast(svg);
  // The notch label's anchor sits inside the polygon's bbox but outside its
  // true (concave) shape: it must resolve to the navy rect underneath and
  // pass, not the bbox-matched cream.
  assert.ok(!result.failures.some((f) => /Notch label/.test(f.element)), "a point in the bbox but outside the concave shape must not be treated as covered by it");
  // The second label's anchor genuinely is inside the L-shape's filled area
  // and must resolve to cream and fail.
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].element, /Inside label/);
  assert.equal(result.failures[0].background, "#f8f6f1");
}
console.log("unit: concave polygon uses exact containment, not its bounding box -- PASS");

{
  // A path with two subpaths (outer square + inner square) and an explicit,
  // inherited fill-rule="evenodd": the inner ring is a hole. A point in the
  // hole must fall through to what is painted underneath.
  const svg = page(
    `<rect x="0" y="0" width="200" height="200" fill="#1d3557"/>` +
      `<path d="M0,0 L100,0 L100,100 L0,100 Z M25,25 L75,25 L75,75 L25,75 Z" fill="#f8f6f1" fill-rule="evenodd"/>` +
      `<text x="10" y="10" fill="#ffffff" font-size="16">Annulus label</text>` +
      `<text x="50" y="50" fill="#ffffff" font-size="16">Hole label</text>`
  );
  const result = checkSvgContrast(svg);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].element, /Annulus label/);
  assert.equal(result.failures[0].background, "#f8f6f1");
  assert.ok(!result.failures.some((f) => /Hole label/.test(f.element)), "a point in an evenodd hole must not be covered by the shape");
}
console.log("unit: evenodd hole across two subpaths -- PASS");

{
  // A path with two disjoint subpaths ("islands", as d3-geo emits for a
  // country with an offshore territory), default (nonzero) fill-rule. Both
  // islands must be resolved independently, and the gap between them must
  // not be treated as covered by either.
  const svg = page(
    `<rect x="0" y="0" width="200" height="200" fill="#1d3557"/>` +
      `<path d="M0,0 L40,0 L40,40 L0,40 Z M60,0 L100,0 L100,40 L60,40 Z" fill="#f8f6f1"/>` +
      `<text x="20" y="20" fill="#ffffff" font-size="16">Island one</text>` +
      `<text x="80" y="20" fill="#ffffff" font-size="16">Island two</text>` +
      `<text x="50" y="20" fill="#ffffff" font-size="16">Gap label</text>`
  );
  const result = checkSvgContrast(svg);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.some((f) => /Island one/.test(f.element)));
  assert.ok(result.failures.some((f) => /Island two/.test(f.element)));
  assert.ok(!result.failures.some((f) => /Gap label/.test(f.element)), "the gap between two subpaths must not be covered by either");
}
console.log("unit: a path with 2 subpaths resolves each independently -- PASS");

// =============================================================================
// 2. INFORMATIONAL: one instance of every chart type (not asserted)
// =============================================================================

// Fixtures below are lifted near-verbatim from the existing regression
// suites that already render and validate them (scripts/benchmark_viz.mjs,
// scripts/benchmark_complex_viz.mjs, scripts/test_spatial_explanatory_viz.mjs,
// scripts/benchmark_trajectory_v16.mjs), so this exercises the same entry
// points (renderVizSvg / renderVizMobileSvg) on specs already known-valid.

const vizBase = {
  schema_version: "0.7.0", reader_task: "comparison", takeaway: "Synthetic informational fixture.",
  title: "Synthetic newsroom visualization fixture", subtitle: "In-memory rendering only",
  alt: "Synthetic chart used to exercise the contrast checker across chart types.",
  source_note: "Synthetic informational fixture", claim_id: "claim-informational", sql: "SELECT 1", unit: "%",
  sort: "desc", highlight_values: ["A"], direct_labels: true, annotations: [],
};
const categories = Array.from({ length: 16 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3, start: 18 + i * 2, end: 23 + i * 3 }));
const timeRows = Array.from({ length: 24 }, (_, i) => ({ year: 2001 + i, value: 30 + i * 1.1 }));
const multiRows = ["A", "B", "C", "D"].flatMap((series, s) => Array.from({ length: 18 }, (_, i) => ({ year: 2007 + i, series, value: 20 + s * 8 + i * (1 + s * 0.12) })));
const facetRows = ["North", "South", "East", "West"].flatMap((facet, f) => Array.from({ length: 10 }, (_, i) => ({ facet, year: 2015 + i, value: 20 + f * 8 + i * 2 })));
const scatterRows = Array.from({ length: 80 }, (_, i) => ({ x: i + 1, y: 20 + i * 0.8 + (i % 5) * 2, label: `P${i + 1}` }));
const heatRows = ["A", "B", "C", "D", "E", "F"].flatMap((y, yi) => ["2019", "2020", "2021", "2022", "2023", "2024"].map((x, xi) => ({ x, y, value: 10 + yi * 7 + xi * 4 })));

const complexBase = { schema_version: "0.8.0", takeaway: "Complex informational fixture", title: "Complex visual journalism fixture", alt: "Complex visual journalism fixture with topology-aware rendering.", source_note: "Synthetic informational fixture", claim_id: "claim-informational", sql: "SELECT * FROM synthetic", unit: "units", complexity_budget: "medium", annotations: [], highlight_values: [] };
const flowRows = []; for (let i = 0; i < 6; i++) flowRows.push({ source: `Source ${i + 1}`, target: "Hub", value: 20 + i * 4 }); for (let i = 0; i < 10; i++) flowRows.push({ source: "Hub", target: `Sector ${i + 1}`, value: 8 + i });
const networkRows = []; for (let i = 0; i < 28; i++) { networkRows.push({ source: `N${i}`, target: `N${(i + 3) % 28}`, value: 1 + (i % 5) }); networkRows.push({ source: `N${i}`, target: `N${(i + 7) % 28}`, value: 1 + (i % 3) }); }
const hierarchyRows = [{ node: "Root", parent: null }]; for (let i = 0; i < 5; i++) { hierarchyRows.push({ node: `L1-${i}`, parent: "Root" }); for (let j = 0; j < 5; j++) hierarchyRows.push({ node: `L2-${i}-${j}`, parent: `L1-${i}` }); }
const timelineRows = Array.from({ length: 28 }, (_, i) => ({ date: `202${Math.floor(i / 12) + 2}-${String((i % 12) + 1).padStart(2, "0")}-01`, event: `Milestone ${i + 1}` }));
const streamRows = ["A", "B", "C", "D", "E", "F"].flatMap((series, si) => Array.from({ length: 20 }, (_, i) => ({ year: 2005 + i, series, value: 10 + si * 4 + (i % 4) * 2 + i * (si % 2 ? 0.4 : 0.2) })));

const spatialBase = { schema_version: "0.9.0", takeaway: "Topology-aware informational fixture", title: "Spatial and explanatory visual journalism fixture", alt: "A responsive editorial visualization exercises a topology-aware renderer with synthetic data.", source_note: "Synthetic informational fixture", claim_id: "claim-informational", sql: "SELECT * FROM synthetic", unit: "units", complexity_budget: "medium", annotations: [], highlight_values: [] };
const parallelRows = [{ origin: "Urban", mode: "Rail", outcome: "On time", value: 32 }, { origin: "Urban", mode: "Rail", outcome: "Delayed", value: 8 }, { origin: "Urban", mode: "Road", outcome: "On time", value: 18 }, { origin: "Urban", mode: "Road", outcome: "Delayed", value: 12 }, { origin: "Rural", mode: "Rail", outcome: "On time", value: 10 }, { origin: "Rural", mode: "Rail", outcome: "Delayed", value: 5 }, { origin: "Rural", mode: "Road", outcome: "On time", value: 16 }, { origin: "Rural", mode: "Road", outcome: "Delayed", value: 19 }];
const chordRows = [{ source: "Asia", target: "Europe", value: 42 }, { source: "Asia", target: "North America", value: 36 }, { source: "Europe", target: "North America", value: 24 }, { source: "Europe", target: "Africa", value: 17 }, { source: "Africa", target: "Asia", value: 15 }, { source: "North America", target: "Latin America", value: 21 }, { source: "Latin America", target: "Europe", value: 12 }, { source: "Latin America", target: "Asia", value: 9 }];
const geoRows = [{ source: "Singapore", slat: 1.3521, slon: 103.8198, target: "Rotterdam", tlat: 51.9244, tlon: 4.4777, value: 18 }, { source: "Shanghai", slat: 31.2304, slon: 121.4737, target: "Los Angeles", tlat: 34.0522, tlon: -118.2437, value: 15 }, { source: "Busan", slat: 35.1796, slon: 129.0756, target: "Long Beach", tlat: 33.7701, tlon: -118.1937, value: 11 }, { source: "Dubai", slat: 25.2048, slon: 55.2708, target: "Hamburg", tlat: 53.5511, tlon: 9.9937, value: 8 }, { source: "Santos", slat: -23.9608, slon: -46.3336, target: "Antwerp", tlat: 51.2194, tlon: 4.4025, value: 7 }];
const processRows = [{ source: "Report arrives", target: "Extract facts", edge: "ingest" }, { source: "Extract facts", target: "Verify sources", edge: "evidence" }, { source: "Verify sources", target: "Compute metrics", edge: "validated data" }, { source: "Compute metrics", target: "Draft finding", edge: "result" }, { source: "Draft finding", target: "Visual review", edge: "story claim" }, { source: "Visual review", target: "Publish", edge: "approved" }];

let trajectoryFixturesAvailable = true;
let mapSpec, mapRows, profileSpec, profileRows;
try {
  const record = JSON.parse(readFileSync(new URL("../fixtures/v16-movement/adsb-dal1812-sampled.json", import.meta.url), "utf8"));
  const points = record.points;
  mapRows = [{ source: "Observed coverage begins", target: "MSP / ground", value: 1, trajectory_points: JSON.stringify(points) }];
  mapSpec = { schema_version: "1.1.0", reader_task: "spatial", visual_family: "spatial", data_topology: "geo_edges", chart_type: "cartographic_flow_map", title: "Trajectory informational fixture", subtitle: "Observed path with a preserved gap", alt: "Informational fixture, observed trajectory.", source_note: "xoolive/traffic readsb fixture.", note: "Observed geometry with source gap.", claim_id: "claim-informational", sql: "fixture", unit: "trajectory", source_field: "source", target_field: "target", value_field: "value", geometry_semantics: "observed_trajectory", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, route_provenance_note: "xoolive/traffic readsb public sample", trajectory_points_field: "trajectory_points", extent_mode: "data", extent_padding_ratio: 0.16, reference_path: "great_circle", locator_inset: true, aggregation_policy: "none", direct_labels: true, annotations: [] };
  profileRows = points.map((p) => ({ elapsed_min: p.elapsed_s / 60, altitude_ft: p.altitude_ft, ground_speed_kt: p.ground_speed_kt, segment: p.segment }));
  profileSpec = { schema_version: "1.1.0", reader_task: "change", visual_family: "temporal", data_topology: "tabular", chart_type: "trajectory_profile", title: "Profile informational fixture", subtitle: "Altitude and speed share elapsed time", alt: "Informational fixture, trajectory profile.", source_note: "xoolive/traffic readsb public sample.", note: "Observed samples.", claim_id: "claim-informational", sql: "fixture", unit: "trajectory state", x_field: "elapsed_min", altitude_field: "altitude_ft", speed_field: "ground_speed_kt", segment_field: "segment", altitude_unit: "ft", speed_unit: "kt", annotations: [] };
} catch (err) {
  trajectoryFixturesAvailable = false;
  console.log(`informational: v16-movement fixture unavailable (${err.message}); skipping cartographic_flow_map/trajectory_profile`);
}

const chartCases = [
  ["horizontal_bar", { ...vizBase, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "category", value_field: "value" }, categories],
  ["dot", { ...vizBase, reader_task: "ranking", chart_type: "dot", category_field: "category", value_field: "value" }, categories],
  ["dumbbell", { ...vizBase, chart_type: "dumbbell", category_field: "category", start_field: "start", end_field: "end" }, categories],
  ["slope", { ...vizBase, chart_type: "slope", category_field: "category", start_field: "start", end_field: "end" }, categories.slice(0, 10)],
  ["line", { ...vizBase, reader_task: "change", chart_type: "line", x_field: "year", value_field: "value" }, timeRows],
  ["multi_line", { ...vizBase, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", highlight_values: ["A"] }, multiRows],
  ["small_multiples", { ...vizBase, reader_task: "change", chart_type: "small_multiples", x_field: "year", value_field: "value", facet_field: "facet", panel_mark: "line" }, facetRows],
  ["scatter", { ...vizBase, reader_task: "correlation", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "label", x_unit: "index", y_unit: "%", unit: "%", highlight_values: ["P80"] }, scatterRows],
  ["diverging_bar", { ...vizBase, chart_type: "diverging_bar", category_field: "category", value_field: "value" }, categories.map((r, i) => ({ ...r, value: i % 2 ? r.value : -r.value }))],
  ["heatmap", { ...vizBase, reader_task: "distribution", chart_type: "heatmap", x_field: "x", y_field: "y", value_field: "value" }, heatRows],
  ["sankey", { ...complexBase, reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", chart_type: "sankey", source_field: "source", target_field: "target", value_field: "value" }, flowRows],
  ["alluvial", { ...complexBase, reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", chart_type: "alluvial", source_field: "source", target_field: "target", value_field: "value" }, flowRows],
  ["node_link", { ...complexBase, reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", chart_type: "node_link", source_field: "source", target_field: "target", value_field: "value" }, networkRows],
  ["adjacency_matrix", { ...complexBase, reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", chart_type: "adjacency_matrix", source_field: "source", target_field: "target", value_field: "value" }, networkRows],
  ["hierarchy_tree", { ...complexBase, reader_task: "hierarchy", visual_family: "hierarchy", data_topology: "hierarchy", chart_type: "hierarchy_tree", node_field: "node", parent_field: "parent" }, hierarchyRows],
  ["timeline", { ...complexBase, reader_task: "sequence", visual_family: "temporal", data_topology: "events", chart_type: "timeline", x_field: "date", label_field: "event" }, timelineRows],
  ["streamgraph", { ...complexBase, reader_task: "change", visual_family: "temporal", data_topology: "tabular", chart_type: "streamgraph", x_field: "year", series_field: "series", value_field: "value" }, streamRows],
  ["parallel_sets", { ...spatialBase, reader_task: "flow", visual_family: "flow", data_topology: "categorical_flow", chart_type: "parallel_sets", dimension_fields: ["origin", "mode", "outcome"], value_field: "value" }, parallelRows],
  ["chord", { ...spatialBase, reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", chart_type: "chord", source_field: "source", target_field: "target", value_field: "value" }, chordRows],
  ["geo_flow_map", { ...spatialBase, reader_task: "spatial", visual_family: "spatial", data_topology: "geo_edges", chart_type: "geo_flow_map", source_field: "source", target_field: "target", source_lat_field: "slat", source_lon_field: "slon", target_lat_field: "tlat", target_lon_field: "tlon", value_field: "value" }, geoRows],
  ["process_schematic", { ...spatialBase, reader_task: "process", visual_family: "explanatory", data_topology: "process_graph", chart_type: "process_schematic", source_field: "source", target_field: "target", edge_label_field: "edge" }, processRows],
  ...(trajectoryFixturesAvailable ? [
    ["cartographic_flow_map", mapSpec, mapRows],
    ["trajectory_profile", profileSpec, profileRows],
  ] : []),
];

console.log(`\n--- informational contrast pass across ${chartCases.length} chart types (printed, not asserted) ---`);
let totalFailures = 0, totalUnmeasured = 0;
for (const [name, spec, rows] of chartCases) {
  try {
    const desktop = checkSvgContrast(renderVizSvg(spec, rows));
    const mobile = checkSvgContrast(renderVizMobileSvg(spec, rows));
    totalFailures += desktop.failures.length + mobile.failures.length;
    totalUnmeasured += desktop.unmeasured.length + mobile.unmeasured.length;
    console.log(`${name.padEnd(22)} desktop failures=${desktop.failures.length} unmeasured=${desktop.unmeasured.length} | mobile failures=${mobile.failures.length} unmeasured=${mobile.unmeasured.length}`);
  } catch (err) {
    console.log(`${name.padEnd(22)} SKIPPED (${err.message})`);
  }
}

// Infographic compose functions (same fixture shape as scripts/test_infographic.mjs).
try {
  const claim = "claim-informational-infographic";
  const context = { verified_claim_ids: [claim] };
  const barRows = [{ category: "A", value: 42 }, { category: "B", value: 31 }, { category: "C", value: 18 }, { category: "D", value: 9 }];
  const barSpec = { schema_version: "0.9.0", reader_task: "ranking", takeaway: "A leads the selected categories.", chart_type: "horizontal_bar", title: "A leads this selected comparison", subtitle: "Informational fixture", alt: "Horizontal bars rank four synthetic categories from A at 42 to D at 9.", source_note: "Synthetic fixture", claim_id: claim, sql: "SELECT * FROM synthetic_bar", unit: "units", category_field: "category", value_field: "value", sort: "desc", highlight_values: ["A"], annotations: [] };
  const barBundleDesktop = renderVizSvg(barSpec, barRows);
  const barBundleMobile = renderVizMobileSvg(barSpec, barRows);
  const assets = { "visualizations/bar.json": { desktopSvg: barBundleDesktop, mobileSvg: barBundleMobile, manifest: { claim_id: claim, source_note: barSpec.source_note, chart_type: barSpec.chart_type, alt: barSpec.alt }, critic: { passed: true, score: 90 } } };
  const infographicSpec = {
    schema_version: "1.0.0", kicker: "SYSTEMS / DATA FEATURE", title: "A system is easier to understand when the parts share one page",
    dek: "Informational fixture combining verified numbers and one upstream newsroom visual into a single responsive editorial composition.",
    alt: "A magazine-style data feature with a headline, a hero statistic and a ranking chart.",
    byline: "Newsroom Agent", date_label: "Informational fixture", layout: "feature", complexity_budget: "medium", source_note: "Synthetic infographic informational fixture",
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "The premise", heading: "Numbers gain meaning from hierarchy", deck: "The composer controls reading order while preserving upstream data provenance." },
      { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "PJ", label: "Total energy entering the synthetic system", detail: "Verified claim fixture", claim_id: claim, label_short: "Total" },
      { id: "bar", type: "visual", span: "two_thirds", label: "The ranking", manifest_ref: "visualizations/bar.json" },
    ],
  };
  const bundle = composeInfographicBundle(infographicSpec, assets);
  const desktop = checkSvgContrast(bundle.desktop.svg);
  const mobile = checkSvgContrast(bundle.mobile.svg);
  console.log(`${"infographic_bundle".padEnd(22)} desktop failures=${desktop.failures.length} unmeasured=${desktop.unmeasured.length} | mobile failures=${mobile.failures.length} unmeasured=${mobile.unmeasured.length}`);
} catch (err) {
  console.log(`infographic_bundle     SKIPPED (${err.message})`);
}
console.log(`--- informational totals: failures=${totalFailures} unmeasured=${totalUnmeasured} across ${chartCases.length} chart types ---\n`);

// =============================================================================
// 3. INFORMATIONAL: replay over a real run's rendered SVGs, if present
// =============================================================================

const trialDir = process.env.NEWSROOM_TRIAL_REPLAY_DIR || "";
if (existsSync(trialDir)) {
  const files = readdirSync(trialDir).filter((f) => f.endsWith(".svg")).sort();
  console.log(`--- informational replay: ${files.length} SVG(s) under ${trialDir} (printed, not asserted) ---`);
  for (const file of files) {
    const svg = readFileSync(join(trialDir, file), "utf8");
    const result = checkSvgContrast(svg);
    console.log(`${file}: passed=${result.passed} failures=${result.failures.length} unmeasured=${result.unmeasured.length}`);
    for (const f of result.failures) console.log(`  FAIL ${f.element} ratio=${f.ratio}:1 required=${f.required}:1 fg=${f.foreground} bg=${f.background}`);
    for (const u of result.unmeasured) console.log(`  UNMEASURED ${u.element}: ${u.reason}`);
  }
  console.log("--- end replay ---\n");
} else {
  console.log(`informational replay: ${trialDir} not present locally; skipping (not asserted)`);
}

console.log("render_qa_contrast unit tests: PASS");
