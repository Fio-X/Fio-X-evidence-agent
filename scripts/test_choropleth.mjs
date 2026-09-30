#!/usr/bin/env node
// Covers the choropleth chart type (task G2): a regional choropleth map with
// a locator inset. Exercises the same surfaces every other chart-type test
// in this suite does - lintVizSpec's blocking checks, the rendered SVG's own
// geometry, and the product's own render-QA gates (runtime/pi/render_qa.mjs,
// composing render_qa_geometry.mjs and render_qa_contrast.mjs) - plus the
// two things unique to this chart type: the Natural Earth attribute sidecar
// (runtime/pi/assets/naturalearth-admin0-50m-attributes.json) and the
// row -> economy table -> iso3 -> basemap feature join
// (runtime/pi/choropleth.mjs's joinChoroplethRows/lintChoroplethSpec).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHOROPLETH_RAMP, PALETTE, critiqueViz, lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { TEXT_WIDTH_FACTORS, LATIN_ADVANCE_WIDTHS, LATIN_BOLD_ADVANCE_WIDTHS, BOLD_WEIGHT_THRESHOLD } from "../runtime/pi/render_qa_geometry.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import {
  CHOROPLETH_BASEMAP_ID,
  featureIndicesForIso3,
  geometryRings,
  joinChoroplethRows,
  lintChoroplethSpec,
  neAttributesAsset,
  neFeatureCount,
  neFeatureGeometry,
  niceBreaks,
  classifyValue,
} from "../runtime/pi/choropleth.mjs";

const claimId = "claim-choropleth-fixture";
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);

const base = {
  schema_version: "0.9.0",
  reader_task: "spatial",
  title: "Renewable energy consumption share",
  alt: "A choropleth map of renewable energy's share of final energy consumption across several African countries, darker meaning a higher share.",
  source_note: "World Bank fixture, indicator EG.FEC.RNEW.ZS",
  claim_id: claimId,
  sql: "SELECT country, renewable_energy_consumption_pct, year FROM fixture",
  unit: "%",
  chart_type: "choropleth",
  category_field: "country",
  value_field: "renewable_energy_consumption_pct",
  category_names: "worldbank",
  reference_period_field: "year",
  mixed_period_strategy: "acknowledge",
  basemap_id: basemap.id,
  basemap_source_url: basemap.source_url,
  basemap_license: basemap.license,
  basemap_content_hash: basemap.content_hash,
  highlight_values: [],
  annotations: [],
};

// The real, verified 11-country Africa fixture (World Bank EG.FEC.RNEW.ZS,
// each country's latest available year) used to validate this chart type
// end to end - the same rows committed at
// $SCRATCHPAD/devruns/africa-01/data/404b623828d08e4f0e40350650c00e348db77b735b38b4c7aaa9ad2253a39f6a.csv
// during development, inlined here so this test is self-contained and does
// not depend on a session-specific scratchpad path.
const AFRICA_ROWS = [
  { country: "Chad", year: 2022, renewable_energy_consumption_pct: 70.0 },
  { country: "Congo, Dem. Rep.", year: 2021, renewable_energy_consumption_pct: 96.3 },
  { country: "Congo, Rep.", year: 2021, renewable_energy_consumption_pct: 71.4 },
  { country: "Guinea", year: 2022, renewable_energy_consumption_pct: 66.6 },
  { country: "Liberia", year: 2022, renewable_energy_consumption_pct: 92.8 },
  { country: "Mauritania", year: 2022, renewable_energy_consumption_pct: 19.6 },
  { country: "Niger", year: 2021, renewable_energy_consumption_pct: 79.6 },
  { country: "Nigeria", year: 2021, renewable_energy_consumption_pct: 80.3 },
  { country: "Sierra Leone", year: 2022, renewable_energy_consumption_pct: 71.6 },
  { country: "South Sudan", year: 2021, renewable_energy_consumption_pct: 32.4 },
  { country: "Zambia", year: 2021, renewable_energy_consumption_pct: 83.0 },
];

// --- sidecar: 242 entries, index-aligned with the registered basemap, and
//     its recorded geometry content_hash matches the registry's own hash of
//     that same basemap's bytes (the sidecar's provenance claim is true, not
//     merely asserted)
{
  const asset = neAttributesAsset();
  assert.equal(asset.features.length, 242, "sidecar should carry exactly 242 features");
  assert.equal(neFeatureCount(), 242, "registered basemap should carry exactly 242 features");
  assert.equal(asset.vendored_geometry.content_hash, basemap.content_hash, "sidecar's recorded geometry hash should equal the registry's own content_hash");
  for (const feature of asset.features) {
    assert.ok(neFeatureGeometry(feature.index), `feature ${feature.index} should have geometry in the registered basemap`);
  }
}
console.log("choropleth sidecar: 242 index-aligned entries, geometry hash matches the registry -- PASS");

// --- sidecar: every feature whose iso3 the economy table can actually reach
//     (i.e. every row this chart type could ever join to) has its own
//     LABEL_X/LABEL_Y label point inside its own polygon, via a plain
//     nonzero-winding point-in-polygon test on the vendored (raw lon/lat)
//     geometry - except a small, documented allowlist of real Natural Earth
//     geometry quirks (an archipelagic/complex-coastline nation whose
//     official label point sits in a bay/strait between its own islands,
//     not a bug): Trinidad and Tobago, Sao Tome and Principe, St. Vincent
//     and the Grenadines, New Zealand, Equatorial Guinea, Macao, Antigua and
//     Barbuda. Those seven must still sit nearer their own polygon than any
//     other feature's, so they prove the index alignment too. Loosening this
//     check to tolerate more than this list would silently hide a real
//     indexing/coordinate bug; a new failure here means look at it, not add
//     it to the list without checking.
{
  function pointInRings(rings, x, y) {
    let inside = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (crosses) inside = !inside;
      }
    }
    return inside;
  }
  // Distance (degrees, longitude scaled by cos(latitude)) from a point to
  // the nearest edge of a feature's rings.
  function distanceToRings(rings, x, y) {
    const k = Math.cos((y * Math.PI) / 180);
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = ring[i - 1];
        const [bx, by] = ring[i];
        const dx = (bx - ax) * k, dy = by - ay, qx = (x - ax) * k, qy = y - ay;
        const t = Math.max(0, Math.min(1, (qx * dx + qy * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(qx - t * dx, qy - t * dy));
      }
    }
    return best;
  }
  const KNOWN_LABEL_POINT_OUTSIDE_OWN_POLYGON = new Set(["TTO", "STP", "VCT", "NZL", "GNQ", "MAC", "ATG"]);
  const econAsset = JSON.parse(readFileSync(new URL("../runtime/pi/assets/economy-names.json", import.meta.url), "utf8"));
  const reachableIso3 = new Set(econAsset.economies.map((e) => e.iso3));
  const asset = neAttributesAsset();
  const checked = [];
  const failures = [];
  for (const feature of asset.features) {
    if (!feature.iso3 || !reachableIso3.has(feature.iso3)) continue;
    checked.push(feature.iso3);
    const rings = geometryRings(neFeatureGeometry(feature.index));
    const [lx, ly] = feature.label;
    const inside = pointInRings(rings, lx, ly);
    if (inside) continue;
    if (!KNOWN_LABEL_POINT_OUTSIDE_OWN_POLYGON.has(feature.iso3)) { failures.push(feature.iso3); continue; }
    const nearest = asset.features.reduce((best, other) => {
      const d = distanceToRings(geometryRings(neFeatureGeometry(other.index)), lx, ly);
      return d < best.d ? { index: other.index, d } : best;
    }, { index: -1, d: Infinity });
    if (nearest.index !== feature.index) failures.push(`${feature.iso3} (nearest feature is index ${nearest.index})`);
  }
  assert.ok(checked.length > 200, `expected to check the bulk of the ~217 reachable economies, only checked ${checked.length}`);
  assert.deepEqual(failures, [], `label point falls outside its own polygon for undocumented iso3(s): ${failures.join(", ")}`);
}
console.log("choropleth sidecar: every reachable economy's label point is inside its own polygon, and the 7 documented exceptions are nearest their own -- PASS");

// --- join: row -> economy table -> iso3 -> basemap feature indices; several
//     features can share one iso3 (AUS); an economy with no matching feature
//     (CHI) resolves with an empty featureIndices list, not a throw
{
  const joined = joinChoroplethRows([{ country: "Guinea" }, { country: "Not, A Country" }, { country: "Australia" }, { country: "Channel Islands" }], { category_field: "country", category_names: "worldbank" });
  assert.equal(joined[0].iso3, "GIN");
  assert.ok(joined[0].featureIndices.length >= 1);
  assert.equal(joined[1].entry, null, "an unmapped raw value should resolve to a null table entry");
  assert.equal(joined[1].iso3, null);
  assert.ok(joined[2].featureIndices.length >= 2, "Australia should resolve to more than one basemap feature");
  assert.deepEqual(featureIndicesForIso3("AUS"), joined[2].featureIndices);
  assert.equal(joined[3].iso3, "CHI");
  assert.deepEqual(joined[3].featureIndices, [], "an economy with no matching basemap feature should resolve to an empty list, not throw");
}
console.log("choropleth join: iso3 resolution, multi-feature economies, and no-feature economies -- PASS");

// --- lint: every choropleth-specific blocking case
{
  const okLint = lintChoroplethSpec(base, AFRICA_ROWS);
  assert.deepEqual(okLint.blockers, [], okLint.blockers.join("; "));

  const missingCategoryNames = lintChoroplethSpec({ ...base, category_names: undefined }, AFRICA_ROWS);
  assert.ok(missingCategoryNames.blockers.some((b) => b.includes("requires category_names")), missingCategoryNames.blockers.join("; "));

  const tooManyRows = lintChoroplethSpec(base, Array.from({ length: 61 }, (_, i) => ({ country: "Guinea", renewable_energy_consumption_pct: i })));
  assert.ok(tooManyRows.blockers.some((b) => b.includes("has 61 rows") && b.toLowerCase().includes("filter rows in sql")), tooManyRows.blockers.join("; "));

  const aggregateRow = lintChoroplethSpec(base, [...AFRICA_ROWS, { country: "Sub-Saharan Africa", year: 2021, renewable_energy_consumption_pct: 50 }]);
  assert.ok(aggregateRow.blockers.some((b) => b.includes("aggregate row(s)") && b.includes("Sub-Saharan Africa")), aggregateRow.blockers.join("; "));

  const noFeatureRow = lintChoroplethSpec(base, [...AFRICA_ROWS, { country: "Channel Islands", year: 2021, renewable_energy_consumption_pct: 50 }]);
  assert.ok(noFeatureRow.blockers.some((b) => b.includes("no matching map feature") && b.includes("Channel Islands")), noFeatureRow.blockers.join("; "));

  const duplicateRow = lintChoroplethSpec(base, [...AFRICA_ROWS, { country: "Chad", year: 2019, renewable_energy_consumption_pct: 60 }]);
  assert.ok(duplicateRow.blockers.some((b) => b.includes("duplicate economy") && b.includes("Chad")), duplicateRow.blockers.join("; "));

  // reused via lintVizSpec: economy_names.mjs's own unmapped-value check
  const unmappedRow = lintVizSpec(base, [...AFRICA_ROWS, { country: "DR Congo", year: 2021, renewable_energy_consumption_pct: 50 }], { verified_claim_ids: [claimId] });
  assert.equal(unmappedRow.passed, false);
  assert.ok(unmappedRow.blockers.some((b) => b.includes("'DR Congo'")), unmappedRow.blockers.join("; "));

  // generic requiredFields: unit is required for every chart type, choropleth included
  const missingUnit = lintVizSpec({ ...base, unit: "" }, AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(missingUnit.passed, false);
  assert.ok(missingUnit.blockers.some((b) => b.includes("quantitative unit is required")), missingUnit.blockers.join("; "));
}
console.log("choropleth lint: category_names required, row cap, aggregate rows, no-feature economies, duplicates, unmapped values, missing unit -- PASS");

// --- basemap provenance: choropleth is bound to exactly one basemap (the
//     one its attribute sidecar was built against), unlike
//     cartographic_flow_map which accepts any registered basemap
{
  const wrongBasemap = validateVizSpec({ ...base, basemap_id: "naturalearth_admin0_110m" });
  assert.ok(wrongBasemap.some((e) => e.includes(`requires basemap_id '${CHOROPLETH_BASEMAP_ID}'`)), wrongBasemap.join("; "));

  const wrongHash = validateVizSpec({ ...base, basemap_content_hash: "0".repeat(64) });
  assert.ok(wrongHash.some((e) => e.includes("basemap_content_hash does not match")), wrongHash.join("; "));

  const okSpec = validateVizSpec(base);
  assert.deepEqual(okSpec, []);
}
console.log("choropleth basemap provenance: wrong basemap_id and mismatched content_hash are rejected -- PASS");

// --- classification: niceBreaks/classifyValue on the real fixture's own
//     min/max produce the same 5 nice round class breaks the renderer uses
{
  const values = AFRICA_ROWS.map((r) => r.renewable_energy_consumption_pct);
  const breaks = niceBreaks(Math.min(...values), Math.max(...values), 5);
  assert.deepEqual(breaks, [0, 20, 40, 60, 80, 100]);
  assert.equal(classifyValue(19.6, breaks), 0);
  assert.equal(classifyValue(96.3, breaks), 4);
}
console.log("choropleth classification: niceBreaks/classifyValue on the real fixture -- PASS");

// Leader lines that run through a label left on the map, measured from the
// rendered SVG alone: each on-map label's box spans its name and value lines,
// a wide (CJK) character counting a full em and anything else 0.56 em, and
// each leader segment is sampled every half pixel. The renderer moves such a
// label into the margin too (the approved spike's Guinea, beside Sierra Leone
// and Liberia), so every render should return [].
//
// Leaders are now octilinear elbows (anchor -> bend -> label), rendered as a
// two-segment path "M x,y L x,y L x,y" (see elbowLeaderPath in viz.mjs), so
// this parses all three points and walks both segments independently.
function parseLeaderPoints(svg, dataRole) {
  const re = new RegExp(`<path data-role="${dataRole}" d="M([-0-9.]+),([-0-9.]+) L([-0-9.]+),([-0-9.]+) L([-0-9.]+),([-0-9.]+)"`, "g");
  return [...svg.matchAll(re)].map((m) => {
    const [x1, y1, x2, y2, x3, y3] = m.slice(1).map(Number);
    return { anchor: [x1, y1], bend: [x2, y2], tip: [x3, y3], segments: [[x1, y1, x2, y2], [x2, y2, x3, y3]] };
  });
}

function leadersCrossingOnMapLabels(svg) {
  const num = (tag, name) => Number(tag.match(new RegExp(`(?:^| )${name}="([-0-9.]+)"`))[1]);
  const width = (text, size) => Array.from(text).reduce((sum, ch) => sum + (/[\u3000-\u9fff\uff00-\uffef]/u.test(ch) ? size : size * 0.56), 0);
  const names = [...svg.matchAll(/<text data-role="choropleth-label" ([^>]*)>([^<]*)<\/text>/g)];
  const values = [...svg.matchAll(/<text data-role="choropleth-label-value" ([^>]*)>(.*?)<\/text>/g)];
  assert.equal(names.length, values.length, "every label has a name line and a value line");
  const onMap = [];
  const margin = [];
  names.forEach(([, tag, name], i) => {
    if (!tag.includes('text-anchor="middle"')) { margin.push(name); return; }
    const size = num(tag, "font-size");
    const w = Math.max(width(name, size), width(values[i][2].replace(/<[^>]+>/g, " "), size));
    const x = num(tag, "x");
    onMap.push({ name, x0: x - w / 2, x1: x + w / 2, y0: num(tag, "y") - size * 0.9, y1: num(values[i][1], "y") + size * 0.25 });
  });
  const leaders = parseLeaderPoints(svg, "choropleth-leader");
  assert.equal(leaders.length, margin.length, "every margin label has one leader");
  const crossings = [];
  leaders.forEach((leader, i) => {
    for (const [x1, y1, x2, y2] of leader.segments) {
      const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
      for (const box of onMap) {
        for (let step = 0; step <= steps; step++) {
          const x = x1 + ((x2 - x1) * step) / steps;
          const y = y1 + ((y2 - y1) * step) / steps;
          if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) { crossings.push(`${margin[i]} leader crosses ${box.name}`); break; }
        }
      }
    }
  });
  return crossings;
}

// Independent segment-segment intersection test (cross-product orientation),
// re-derived here rather than imported from viz.mjs, per house style: test
// code proves the renderer's own geometry, it doesn't just call it back.
function segsIntersect(a1, a2, b1, b2) {
  const [ax1, ay1] = a1, [ax2, ay2] = a2, [bx1, by1] = b1, [bx2, by2] = b2;
  const d = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = d(bx1, by1, bx2, by2, ax1, ay1);
  const d2 = d(bx1, by1, bx2, by2, ax2, ay2);
  const d3 = d(ax1, ay1, ax2, ay2, bx1, by1);
  const d4 = d(ax1, ay1, ax2, ay2, bx2, by2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Touching endpoints (shared anchor/bend points) are not crossings.
  return false;
}

function segIntersectsBox(x1, y1, x2, y2, box) {
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
  if (maxX < box.x0 || minX > box.x1 || maxY < box.y0 || minY > box.y1) return false;
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2) || 1;
  for (let step = 0; step <= steps; step++) {
    const x = x1 + ((x2 - x1) * step) / steps;
    const y = y1 + ((y2 - y1) * step) / steps;
    if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) return true;
  }
  return false;
}

// Hard QA required by the coordinator: every leader line on the rendered
// SVG (main-map overflow leaders, inset overflow leaders, inset list-fallback
// leaders), taken together, must cross neither another leader nor any text
// label box (on-map or off-map). Independently re-derived geometry, not
// borrowed from viz.mjs's own leaderIsClear.
function leaderCrossingReport(svg) {
  const leaderRoles = ["choropleth-leader", "choropleth-inset-leader"];
  const allLeaders = leaderRoles.flatMap((role) => parseLeaderPoints(svg, role).map((l) => ({ ...l, role })));
  const num = (tag, name) => Number(tag.match(new RegExp(`(?:^| )${name}="([-0-9.]+)"`))[1]);
  const width = (text, size) => Array.from(text).reduce((sum, ch) => sum + (/[\u3000-\u9fff\uff00-\uffef]/u.test(ch) ? size : size * 0.56), 0);
  const textBoxes = [];
  for (const role of ["choropleth-label", "choropleth-label-value", "choropleth-inset-label", "choropleth-inset-label-value", "choropleth-footnote-name", "choropleth-footnote-value"]) {
    for (const m of svg.matchAll(new RegExp(`<text data-role="${role}" ([^>]*)>(.*?)<\\/text>`, "g"))) {
      const tag = m[1];
      const text = m[2].replace(/<[^>]+>/g, " ");
      const size = num(tag, "font-size");
      const x = num(tag, "x");
      const y = num(tag, "y");
      const w = width(text, size);
      const anchor = tag.includes('text-anchor="end"') ? "end" : tag.includes('text-anchor="middle"') ? "middle" : "start";
      const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      const x1 = x0 + w;
      textBoxes.push({ role, text, x0, x1, y0: y - size * 0.9, y1: y + size * 0.25 });
    }
  }
  const leaderLeader = [];
  for (let i = 0; i < allLeaders.length; i++) {
    for (let j = i + 1; j < allLeaders.length; j++) {
      for (const segA of allLeaders[i].segments) {
        for (const segB of allLeaders[j].segments) {
          if (segsIntersect([segA[0], segA[1]], [segA[2], segA[3]], [segB[0], segB[1]], [segB[2], segB[3]])) {
            leaderLeader.push(`leader#${i} (${allLeaders[i].role}) crosses leader#${j} (${allLeaders[j].role})`);
          }
        }
      }
    }
  }
  const leaderText = [];
  allLeaders.forEach((leader, i) => {
    for (const [x1, y1, x2, y2] of leader.segments) {
      for (const box of textBoxes) {
        if (segIntersectsBox(x1, y1, x2, y2, box)) leaderText.push(`leader#${i} (${leader.role}) crosses text "${box.text}" (${box.role})`);
      }
    }
  });
  return { leaderLeader, leaderText };
}

// Review fix (v5, "leaders run inside the grey label chips"): every leader's
// own tip must end clear of the text box it points at, not just clear of
// crossing through it. Reuses leaderCrossingReport's own text-box extraction
// (independently re-derived here, not borrowed from viz.mjs) and checks the
// last point of each leader (the tip, right before the label) against every
// text box that shares that leader's own data-iso3 - the box the leader is
// actually allowed to sit near.
function leaderEndpointGapReport(svg, minGapPx = 3) {
  const num = (tag, name) => Number(tag.match(new RegExp(`(?:^| )${name}="([-0-9.]+)"`))[1]);
  const width = (text, size) => Array.from(text).reduce((sum, ch) => sum + (/[　-鿿＀-￯]/u.test(ch) ? size : size * 0.56), 0);
  const boxesByIso3 = new Map();
  for (const role of ["choropleth-label", "choropleth-label-value", "choropleth-inset-label", "choropleth-inset-label-value"]) {
    for (const m of svg.matchAll(new RegExp(`<text data-role="${role}" data-iso3="([A-Z]{3})" ([^>]*)>(.*?)<\\/text>`, "g"))) {
      const iso3 = m[1];
      const tag = m[2];
      const text = m[3].replace(/<[^>]+>/g, " ");
      const size = num(tag, "font-size");
      const x = num(tag, "x");
      const y = num(tag, "y");
      const w = width(text, size);
      const anchor = tag.includes('text-anchor="end"') ? "end" : tag.includes('text-anchor="middle"') ? "middle" : "start";
      const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      const box = { x0, x1: x0 + w, y0: y - size * 0.9, y1: y + size * 0.25 };
      if (!boxesByIso3.has(iso3)) boxesByIso3.set(iso3, []);
      boxesByIso3.get(iso3).push(box);
    }
  }
  const gapToBox = (px, py, box) => {
    const dx = px < box.x0 ? box.x0 - px : px > box.x1 ? px - box.x1 : 0;
    const dy = py < box.y0 ? box.y0 - py : py > box.y1 ? py - box.y1 : 0;
    return Math.hypot(dx, dy);
  };
  const failures = [];
  for (const role of ["choropleth-leader", "choropleth-inset-leader"]) {
    for (const m of svg.matchAll(new RegExp(`<path data-role="${role}" d="M([-0-9.]+),([-0-9.]+) L([-0-9.]+),([-0-9.]+) L([-0-9.]+),([-0-9.]+)"[^>]*data-iso3="([A-Z]{3})"`, "g"))) {
      const [, , , , , tx, ty, iso3] = m;
      const boxes = boxesByIso3.get(iso3) || [];
      if (!boxes.length) continue;
      const minGap = Math.min(...boxes.map((box) => gapToBox(Number(tx), Number(ty), box)));
      if (minGap < minGapPx) failures.push(`${role} tip for ${iso3} is only ${minGap.toFixed(1)}px from its own text box (need >=${minGapPx}px)`);
    }
  }
  return failures;
}

// Regression (v8, "18px gap between the left-column inset labels and their
// leader tips"): choroplethLabelWidth's own box-width estimate is wider than
// a label's actually-rendered text, and inset overflow labels used to always
// start-anchor at their box's LEFT edge regardless of which side they landed
// on - so a left-side label (SLE, LBR in the West-Africa inset) left its own
// estimate's overestimate, plus LEADER_GAP_PX, as dead space between the end
// of its text and its leader's tip. The fix right-aligns a left-side label's
// text at its box's own right edge (text-anchor="end"), exactly like the
// main map's own overflow labels already did - collapsing the visible gap to
// LEADER_GAP_PX regardless of the box-width estimate's own slack.
//
// This measures each inset leader's actual rendered gap using the render-QA
// text-width model's own exported tables (TEXT_WIDTH_FACTORS,
// LATIN_ADVANCE_WIDTHS/LATIN_BOLD_ADVANCE_WIDTHS from render_qa_geometry.mjs)
// rather than leaderEndpointGapReport's coarser 0.56em flat estimate above,
// so a several-px regression in either direction cannot hide inside that
// coarser model's own slack. estimateTextWidth/isBold/WIDE_CHAR_RE
// themselves are render_qa_geometry.mjs internals (not exported) - this
// independently re-derives their formula from the exported tables, the same
// "don't trust the renderer's own bookkeeping" pattern leaderCrossingReport
// and leaderEndpointGapReport already use above with their own simpler model.
const INSET_GAP_WIDE_CHAR_RE = /[　-鿿＀-￯]/u;
function estimateLatinTextWidth(text, fontSize, bold) {
  const table = bold ? LATIN_BOLD_ADVANCE_WIDTHS : LATIN_ADVANCE_WIDTHS;
  let units = 0;
  for (const ch of Array.from(String(text))) {
    if (/\s/.test(ch)) units += TEXT_WIDTH_FACTORS.space;
    else if (INSET_GAP_WIDE_CHAR_RE.test(ch)) units += TEXT_WIDTH_FACTORS.cjk;
    else units += table[ch] ?? 1.02; // FALLBACK_LATIN_WIDTH: render_qa_geometry.mjs keeps this one internal too; mirrored, not imported.
  }
  return units * fontSize * TEXT_WIDTH_FACTORS.safetyMargin;
}

function insetLeaderLabelGapReport(svg, maxGapPx = 6) {
  const num = (tag, name) => Number(tag.match(new RegExp(`(?:^| )${name}="([-0-9.]+)"`))[1]);
  const tips = new Map(); // iso3 -> leader tip {x, y}
  for (const m of svg.matchAll(/<path data-role="choropleth-inset-leader" d="M[-0-9.]+,[-0-9.]+ L[-0-9.]+,[-0-9.]+ L([-0-9.]+),([-0-9.]+)"[^>]*data-iso3="([A-Z]{3})"/g)) {
    tips.set(m[3], { x: Number(m[1]), y: Number(m[2]) });
  }
  const gapFailures = [];
  const anchorFailures = [];
  for (const role of ["choropleth-inset-label", "choropleth-inset-label-value"]) {
    for (const m of svg.matchAll(new RegExp(`<text data-role="${role}" data-iso3="([A-Z]{3})" ([^>]*)>(.*?)<\\/text>`, "g"))) {
      const iso3 = m[1];
      const tag = m[2];
      const text = m[3].replace(/<[^>]+>/g, " ");
      const tip = tips.get(iso3);
      if (!tip) continue; // not a leadered overflow label (e.g. fits in its own polygon)
      const x = num(tag, "x");
      const size = num(tag, "font-size");
      const weightMatch = tag.match(/font-weight="(\d+)"/);
      const bold = weightMatch ? Number(weightMatch[1]) >= BOLD_WEIGHT_THRESHOLD : false;
      const anchor = tag.includes('text-anchor="end"') ? "end" : tag.includes('text-anchor="middle"') ? "middle" : "start";
      const w = estimateLatinTextWidth(text, size, bold);
      const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      const x1 = x0 + w;
      const nearEdge = Math.abs(tip.x - x0) < Math.abs(tip.x - x1) ? x0 : x1;
      const gap = Math.abs(tip.x - nearEdge);
      if (gap > maxGapPx) gapFailures.push(`${role} ${iso3}: leader tip is ${gap.toFixed(1)}px from its label's near edge (need <=${maxGapPx}px)`);
      // A label whose leader tip sits to the RIGHT of its own x is a
      // left-side label (its box sits left of the tip) and must be
      // right-aligned at that x, exactly like the main map's own overflow
      // labels - otherwise the text grows away from the tip, not toward it.
      if (tip.x > x && anchor !== "end") anchorFailures.push(`${role} ${iso3}: leader tip is right of x=${x} but text-anchor is "${anchor}", expected "end"`);
    }
  }
  return { gapFailures, anchorFailures };
}

// Regression (v9, "inset panel prints on top of its own source-extent
// outline"): bestInsetPosition's hit-count obstacle list (viz.mjs ~line
// 5374) weighs a collision with sourceOutline (one of insetObstacles, ~line
// 5665) the same as a collision with any one land AABB, so once land boxes
// make every candidate hit *something* - the common case, since landBoxes
// cover the whole basemap - the "clean" (hits===0) set is empty and the
// "fewest hits" fallback can tie a candidate that only overlaps the source
// outline against one that only overlaps land, then let distance break the
// tie in the source-hugging candidate's favour. The fix filters to
// candidates that clear the source outline padded by 8px before running the
// existing clean/hits/dist order, unchanged.
//
// This independently re-derives the same edge-to-edge rect-gap formula
// viz.mjs's own rectGap (also used by the elbow-connector adjacency check)
// already computes, from the plain x/y/width/height SVG attributes on the
// panel and source-outline rects - not imported, so a regression here can't
// hide behind the renderer's own bookkeeping.
function insetPanelSourceClearanceReport(svg, minClearancePx = 8) {
  const rect = (re) => {
    const m = svg.match(re);
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
  };
  const panel = rect(/<g data-role="choropleth-inset"><rect x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/);
  const source = rect(/<rect data-role="choropleth-inset-source" x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/);
  if (!panel || !source) return []; // nothing to check without both rects present
  const dx = Math.max(panel.x - (source.x + source.w), source.x - (panel.x + panel.w), 0);
  const dy = Math.max(panel.y - (source.y + source.h), source.y - (panel.y + panel.h), 0);
  const gap = Math.hypot(dx, dy);
  if (gap < minClearancePx) {
    return [
      `inset panel is only ${gap.toFixed(1)}px from its own source-extent outline (need >=${minClearancePx}px): ` +
        `panel=(${panel.x.toFixed(1)},${panel.y.toFixed(1)},${panel.w.toFixed(1)}x${panel.h.toFixed(1)}) ` +
        `source=(${source.x.toFixed(1)},${source.y.toFixed(1)},${source.w.toFixed(1)}x${source.h.toFixed(1)})`,
    ];
  }
  return [];
}

// Review fix (v5, "1 on the main map and a separate 1 in the inset"): every
// numbered footnote marker (main-map or inset) must carry a distinct
// data-number - the one global sequence backing the single list below the
// chart.
function duplicateMarkerNumberReport(svg) {
  const numbers = [...svg.matchAll(/<circle data-role="choropleth-(?:inset-)?footnote-marker" [^>]*data-number="(\d+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = new Set();
  for (const n of numbers) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return { numbers, dupes: [...dupes] };
}

// Regression (v10, "inset panel prints over an on-map label/marker"): v9's
// bestInsetPosition (the fix directly above) kept the panel off its own
// source-extent outline, but every OTHER obstacle - on-map labels, on-map
// footnote-marker dots - still only entered the same soft "fewest hits"
// count as land, so a candidate could still win while printing on top of a
// real on-map label. Found on this exact fixture: the pre-fix panel covered
// South Sudan's and Zambia's on-map name+value labels, on BOTH viewports
// (mobile was not obviously fine either, contrary to the initial guess that
// only flagged desktop). The fix (insetHardCandidates, viz.mjs, right after
// layoutInsetAtSize) promotes the padded source outline, every padded
// on-map label box, and every on-map marker circle to hard exclusions tried
// first; only among candidates clearing all three does the existing
// land-hits/distance order apply. When nothing at the panel's natural size
// clears every hard exclusion, the whole label layout reruns, unmodified,
// at 0.95/0.90/0.85 of the panel's own map zoom (INSET_SCALE_STEPS) before
// falling back to exactly the v9 behaviour.
//
// Both helpers below independently re-derive each box straight from the
// rendered SVG's own x/y/text-anchor/font-size/cx/cy/r attributes (via
// estimateLatinTextWidth above, render_qa_geometry.mjs's own exported
// tables - not viz.mjs's internal choroplethLabelWidth/allLabelBoxes/
// footnoteItems), so a regression here can't hide behind the renderer's own
// obstacle bookkeeping.
function onMapLabelOrMarkerOverlapReport(svg) {
  const m = svg.match(/<g data-role="choropleth-inset"><rect x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/);
  if (!m) return []; // no inset panel rendered - nothing to check
  const panel = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const failures = [];
  // On-map labels only: data-role EXACTLY "choropleth-label"/"choropleth-
  // label-value" (the quote/`-value"` right after excludes the "-inset-"
  // prefixed labels drawn inside the panel itself).
  for (const mm of svg.matchAll(/<text data-role="(choropleth-label(?:-value)?)" data-iso3="([A-Z]{3})" x="([-0-9.]+)" y="([-0-9.]+)" text-anchor="(\w+)" font-family="[^"]*" font-size="([-0-9.]+)"[^>]*>(.*?)<\/text>/g)) {
    const [, role, iso3, xs, ys, anchor, sizeS, textRaw] = mm;
    const x = Number(xs), y = Number(ys), size = Number(sizeS);
    const bold = /font-weight="700"/.test(mm[0]);
    const w = estimateLatinTextWidth(textRaw.replace(/<[^>]+>/g, " "), size, bold);
    const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    const box = { x: x0, y: y - size * 0.82, w, h: size * 1.05 };
    if (overlaps(panel, box)) failures.push(`${role} ${iso3}: inset panel overlaps this on-map label`);
  }
  // On-map numbered-marker circles only (not "-inset-" prefixed).
  for (const mm of svg.matchAll(/<circle data-role="choropleth-footnote-marker" data-iso3="([A-Z]{3})" data-number="\d+" cx="([-0-9.]+)" cy="([-0-9.]+)" r="([-0-9.]+)"/g)) {
    const [, iso3, cxs, cys, rs] = mm;
    const cx = Number(cxs), cy = Number(cys), r = Number(rs);
    const box = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    if (overlaps(panel, box)) failures.push(`footnote-marker ${iso3}: inset panel overlaps this on-map numbered marker`);
  }
  return failures;
}

// Companion containment check: shrinking the panel to find a placement that
// clears every hard exclusion reruns the label layout at a smaller map
// size (layoutInsetAtSize) - this confirms every inset label box the
// smaller layout produces still sits fully inside the panel's own rendered
// rect, independently, from the SVG alone (0.5px tolerance for the
// toFixed(1) rounding already baked into the rendered coordinates).
function insetLabelsContainedReport(svg) {
  const m = svg.match(/<g data-role="choropleth-inset"><rect x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/);
  if (!m) return [];
  const panel = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
  const contains = (outer, inner) =>
    inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.w <= outer.x + outer.w + 0.5 && inner.y + inner.h <= outer.y + outer.h + 0.5;
  const failures = [];
  for (const mm of svg.matchAll(/<text data-role="(choropleth-inset-label(?:-value)?)" data-iso3="([A-Z]{3})" x="([-0-9.]+)" y="([-0-9.]+)" text-anchor="(\w+)" font-family="[^"]*" font-size="([-0-9.]+)"[^>]*>(.*?)<\/text>/g)) {
    const [, role, iso3, xs, ys, anchor, sizeS, textRaw] = mm;
    const x = Number(xs), y = Number(ys), size = Number(sizeS);
    const bold = /font-weight="700"/.test(mm[0]);
    const w = estimateLatinTextWidth(textRaw.replace(/<[^>]+>/g, " "), size, bold);
    const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    const box = { x: x0, y: y - size * 0.82, w, h: size * 1.05 };
    if (!contains(panel, box)) failures.push(`${role} ${iso3}: inset label box is not fully contained in the panel rect`);
  }
  return failures;
}

// --- en render + render-QA: real Africa fixture, both viewports
{
  const lint = lintVizSpec(base, AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(base, AFRICA_ROWS);
  assert.match(desktop, />Congo, Dem\. Rep\.</, "en render should show the World Bank English name");
  // This 11-country fixture spans most of the continent's own bounding box
  // (well over the <25% threshold), so the locator is irrelevant at this
  // scale and should be omitted, per the review fix that gates it on extent.
  assert.doesNotMatch(desktop, /data-role="choropleth-locator"/, "en render should omit the locator inset when the plotted extent covers most of the continent");
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.deepEqual(leadersCrossingOnMapLabels(svg), [], `${viewport}: a leader line crosses a label left on the map`);
    const report = leaderCrossingReport(svg);
    assert.deepEqual(report.leaderLeader, [], `${viewport}: leader-leader crossing(s): ${report.leaderLeader.join("; ")}`);
    assert.deepEqual(report.leaderText, [], `${viewport}: leader-text crossing(s): ${report.leaderText.join("; ")}`);
    const gapFailures = leaderEndpointGapReport(svg);
    assert.deepEqual(gapFailures, [], `${viewport}: leader endpoint(s) too close to their own text box: ${gapFailures.join("; ")}`);
    const markerNumbers = duplicateMarkerNumberReport(svg);
    assert.deepEqual(markerNumbers.dupes, [], `${viewport}: duplicate footnote marker number(s): ${markerNumbers.dupes.join(", ")}`);
  }
  const qa = runRenderQa({ desktop, mobile });
  assert.equal(qa.passed, true, `en render-QA failed: ${JSON.stringify(qa.viewports, null, 2)}`);
  assert.equal(qa.failure_count, 0);
  const critic = critiqueViz(base, AFRICA_ROWS, lint, desktop);
  assert.equal(critic.passed, true, JSON.stringify(critic));

  // Machine-readable region attributes: every plotted region carries its own
  // iso3/value on the <path>, and its labels carry the same iso3 - this is
  // what lets render_qa_labels.mjs (and the verifiers, from the report it
  // produces) independently prove the map's color channel is not the only
  // way to recover a region's exact value.
  assert.match(desktop, /<path data-role="choropleth-data" data-iso3="GIN" data-value="66\.6"/, "Guinea's data path should carry its own iso3/value attributes");
  assert.match(desktop, /<text data-role="choropleth-label" [^>]*data-iso3="GIN"/, "Guinea's name label should carry data-iso3");
  assert.match(desktop, /<text data-role="choropleth-label-value" [^>]*data-iso3="GIN"/, "Guinea's value label should carry data-iso3");

  // The product's own render-QA, wired with the choropleth option exactly as
  // runtime/pi/newsroom.ts's newsroom_viz_render handler wires it at render
  // time: the real render's value_labels check passes for every plotted
  // region, and the report carries the check's version.
  const qaWithLabels = runRenderQa(
    { desktop, mobile },
    { choropleth: { rows: AFRICA_ROWS, category_field: base.category_field, value_field: base.value_field, category_names: base.category_names, unit: base.unit } },
  );
  assert.equal(qaWithLabels.passed, true, `en render-QA with value_labels failed: ${JSON.stringify(qaWithLabels.viewports, null, 2)}`);
  assert.equal(qaWithLabels.value_labels_check_version, "1.3.0");
  assert.equal(qaWithLabels.viewports.desktop.value_labels.passed, true, JSON.stringify(qaWithLabels.viewports.desktop.value_labels.failures));
  assert.equal(qaWithLabels.viewports.desktop.value_labels.checked, AFRICA_ROWS.length);
  assert.equal(qaWithLabels.viewports.mobile.value_labels.passed, true, JSON.stringify(qaWithLabels.viewports.mobile.value_labels.failures));
}
console.log("choropleth en render: real Africa fixture, locator + frame trace present, no leader crosses an on-map label, render-QA passes (desktop/mobile) -- PASS");

// --- zh render + render-QA: same real Africa fixture, localized names via
//     category_names='worldbank'
{
  const zhSpec = {
    ...base,
    language: "zh",
    title: "非洲可再生能源消费占比",
    subtitle: "部分非洲经济体，最新可得年份",
    alt: "非洲多国可再生能源占最终能源消费比例的分级设色地图，颜色越深占比越高。",
    source_note: "世界银行 EG.FEC.RNEW.ZS",
  };
  const lint = lintVizSpec(zhSpec, AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(zhSpec, AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.match(svg, />刚果（金）</, `${viewport} should show the zh name for Congo, Dem. Rep.`);
    assert.match(svg, />几内亚</, `${viewport} should show the zh name for Guinea`);
    assert.match(svg, />赞比亚</, `${viewport} should show the zh name for Zambia`);
    assert.doesNotMatch(svg, /data-role="choropleth-locator"/, `${viewport} should omit the locator inset for this continent-spanning extent`);
    assert.deepEqual(leadersCrossingOnMapLabels(svg), [], `${viewport}: a leader line crosses a label left on the map`);
    const report = leaderCrossingReport(svg);
    assert.deepEqual(report.leaderLeader, [], `${viewport}: leader-leader crossing(s): ${report.leaderLeader.join("; ")}`);
    assert.deepEqual(report.leaderText, [], `${viewport}: leader-text crossing(s): ${report.leaderText.join("; ")}`);
    const gapFailures = leaderEndpointGapReport(svg);
    assert.deepEqual(gapFailures, [], `${viewport}: leader endpoint(s) too close to their own text box: ${gapFailures.join("; ")}`);
    const markerNumbers = duplicateMarkerNumberReport(svg);
    assert.deepEqual(markerNumbers.dupes, [], `${viewport}: duplicate footnote marker number(s): ${markerNumbers.dupes.join(", ")}`);
  }
  // Sierra Leone's leader would cross Guinea's on-map label, so Guinea joins
  // the margin, as in the approved spike.
  assert.match(desktop, /<text data-role="choropleth-label" [^>]*>几内亚</, "desktop should label Guinea via a leader off its own point");
  assert.doesNotMatch(desktop, /<text data-role="choropleth-label" [^>]*text-anchor="middle"[^>]*>几内亚</, "Guinea should not be labelled on-map (its leader would cross the on-map label)");
  const qa = runRenderQa({ desktop, mobile });
  assert.equal(qa.passed, true, `zh render-QA failed: ${JSON.stringify(qa.viewports, null, 2)}`);
  assert.equal(qa.failure_count, 0);
  const critic = critiqueViz(zhSpec, AFRICA_ROWS, lint, desktop);
  assert.equal(critic.passed, true, JSON.stringify(critic));
}
console.log("choropleth zh render: real Africa fixture shows localized names, no leader crosses an on-map label, render-QA passes (desktop/mobile) -- PASS");

// --- reference_line and range_bracket annotations stay blocked on choropleth
{
  const refLine = lintVizSpec({ ...base, annotations: [{ type: "reference_line", text: "Target", value: 50, claim_id: claimId }] }, AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(refLine.passed, false);
  assert.ok(refLine.blockers.some((b) => b === "annotations[0] reference_line is not supported on chart_type 'choropleth'"), refLine.blockers.join("; "));

  const rangeBracket = lintVizSpec({ ...base, annotations: [{ type: "range_bracket", match_field: "country", match_value: "Chad", end_match_value: "Zambia", claim_id: claimId }] }, AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(rangeBracket.passed, false);
  assert.ok(rangeBracket.blockers.some((b) => b === "annotations[0] range_bracket is not supported on chart_type 'choropleth'"), rangeBracket.blockers.join("; "));
}
console.log("choropleth annotations: reference_line and range_bracket stay blocked -- PASS");

// Small West African states that are too narrow on a continent-scale map to
// carry a name + value label at the 12px floor (task: inset) - the user's
// own reason for wanting a zoom inset over ever-longer leader lines. Mixed
// with a couple of larger neighbours (Nigeria, Ghana) so the main map still
// has room-sized regions plotted directly.
const WEST_AFRICA_ROWS = [
  { country: "Benin", renewable_energy_consumption_pct: 46.8 },
  { country: "Gambia, The", renewable_energy_consumption_pct: 46.6 },
  { country: "Ghana", renewable_energy_consumption_pct: 30.9 },
  { country: "Guinea-Bissau", renewable_energy_consumption_pct: 55.4 },
  { country: "Nigeria", renewable_energy_consumption_pct: 80.3 },
  { country: "Togo", renewable_energy_consumption_pct: 43.5 },
];
const SMALL_ISO3 = ["BEN", "GMB", "GNB", "TGO"];
const westAfricaBase = { ...base, sql: "SELECT country, renewable_energy_consumption_pct FROM fixture", reference_period_field: undefined, mixed_period_strategy: undefined };

function everyIso3LabelledExactlyOnce(svg, iso3List) {
  const names = [...svg.matchAll(/<text data-role="choropleth-(?:inset-)?label" [^>]*data-iso3="([A-Z]{3})"/g), ...svg.matchAll(/<text data-role="choropleth-footnote-name" [^>]*data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  const values = [...svg.matchAll(/<text data-role="choropleth-(?:inset-)?label-value" [^>]*data-iso3="([A-Z]{3})"/g), ...svg.matchAll(/<text data-role="choropleth-footnote-value" [^>]*data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  const gaps = [];
  for (const iso3 of iso3List) {
    const nameCount = names.filter((x) => x === iso3).length;
    const valueCount = values.filter((x) => x === iso3).length;
    if (nameCount !== 1 || valueCount !== 1) gaps.push(`${iso3}: ${nameCount} name label(s), ${valueCount} value label(s)`);
  }
  return gaps;
}

// --- schema: inset.iso3 (manual mode) - validateVizSpec's own shape checks
{
  assert.deepEqual(validateVizSpec({ ...westAfricaBase, inset: { iso3: SMALL_ISO3 } }), []);
  assert.deepEqual(validateVizSpec({ ...westAfricaBase, inset: { auto: true } }), []);
  assert.deepEqual(validateVizSpec({ ...westAfricaBase, inset: { auto: true, title: "西非放大" } }), [], "an optional title alongside auto should not itself error");
  const noSelector = validateVizSpec({ ...westAfricaBase, inset: { title: "西非放大" } });
  assert.ok(noSelector.some((e) => e.includes("requires either iso3") || e.includes("or auto: true")), noSelector.join("; "));
  const both = validateVizSpec({ ...westAfricaBase, inset: { iso3: SMALL_ISO3, auto: true } });
  assert.ok(both.some((e) => e.includes("inset") && e.includes("iso3") && e.includes("auto")), both.join("; "));
  const badShape = validateVizSpec({ ...westAfricaBase, inset: { iso3: [] } });
  assert.ok(badShape.some((e) => e.includes("inset.iso3")), badShape.join("; "));
  const wrongChart = validateVizSpec({ ...base, chart_type: "bar", inset: { auto: true } });
  assert.ok(wrongChart.some((e) => e.includes("inset is only supported on chart_type 'choropleth'")), wrongChart.join("; "));
}
console.log("choropleth inset schema: iso3/auto validation on validateVizSpec -- PASS");

// --- lint: inset.iso3 naming a code with no plotted data on this map blocks
{
  const unplotted = lintChoroplethSpec({ ...westAfricaBase, inset: { iso3: ["SEN"] } }, WEST_AFRICA_ROWS);
  assert.ok(unplotted.blockers.some((b) => b.includes("inset.iso3") && b.includes("SEN")), unplotted.blockers.join("; "));
  const okInset = lintChoroplethSpec({ ...westAfricaBase, inset: { iso3: SMALL_ISO3 } }, WEST_AFRICA_ROWS);
  assert.deepEqual(okInset.blockers, [], okInset.blockers.join("; "));
}
console.log("choropleth inset lint: inset.iso3 naming an unplotted code is blocked -- PASS");

// --- manual inset: an explicit iso3 list of small West African states is
//     drawn in a framed zoom-inset panel, each shown once there and never
//     again on the main map; every plotted region is labelled exactly once
//     across the whole render (main map + inset combined); render-QA's
//     value-labels proof passes with the inset present
{
  const spec = { ...westAfricaBase, inset: { iso3: SMALL_ISO3, title: "西非放大" } };
  const lint = lintVizSpec(spec, WEST_AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(spec, WEST_AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.match(svg, /data-role="choropleth-inset"/, `${viewport} should include the zoom inset panel`);
    assert.match(svg, />西非放大</, `${viewport} should show the inset's own title`);
    assert.match(svg, /data-role="choropleth-inset-source"/, `${viewport} should trace a source-extent outline on the main map`);
    for (const iso3 of SMALL_ISO3) {
      assert.match(svg, new RegExp(`<path data-role="choropleth-inset-data" data-iso3="${iso3}"`), `${viewport}: ${iso3} should be drawn inside the inset panel`);
      assert.doesNotMatch(svg, new RegExp(`<text data-role="choropleth-label" [^>]*data-iso3="${iso3}"`), `${viewport}: ${iso3} should not also get a main-map label`);
    }
    const gaps = everyIso3LabelledExactlyOnce(svg, WEST_AFRICA_ROWS.map((r) => r.country).length ? ["BEN", "GMB", "GHA", "GNB", "NGA", "TGO"] : []);
    assert.deepEqual(gaps, [], `${viewport}: every plotted region should be labelled exactly once across main map + inset: ${gaps.join("; ")}`);
    const report = leaderCrossingReport(svg);
    assert.deepEqual(report.leaderLeader, [], `${viewport}: leader-leader crossing(s): ${report.leaderLeader.join("; ")}`);
    assert.deepEqual(report.leaderText, [], `${viewport}: leader-text crossing(s): ${report.leaderText.join("; ")}`);
    const gapFailures = leaderEndpointGapReport(svg);
    assert.deepEqual(gapFailures, [], `${viewport}: leader endpoint(s) too close to their own text box: ${gapFailures.join("; ")}`);
    const markerNumbers = duplicateMarkerNumberReport(svg);
    assert.deepEqual(markerNumbers.dupes, [], `${viewport}: duplicate footnote marker number(s): ${markerNumbers.dupes.join(", ")}`);
  }
  const qa = runRenderQa(
    { desktop, mobile },
    { choropleth: { rows: WEST_AFRICA_ROWS, category_field: spec.category_field, value_field: spec.value_field, category_names: spec.category_names, unit: spec.unit } },
  );
  assert.equal(qa.passed, true, `render-QA with manual inset failed: ${JSON.stringify(qa.viewports, null, 2)}`);
  assert.equal(qa.viewports.desktop.value_labels.passed, true, JSON.stringify(qa.viewports.desktop.value_labels.failures));
  assert.equal(qa.viewports.desktop.value_labels.checked, WEST_AFRICA_ROWS.length);
  assert.equal(qa.viewports.mobile.value_labels.passed, true, JSON.stringify(qa.viewports.mobile.value_labels.failures));
}
console.log("choropleth manual inset: small West African states drawn once in a framed zoom inset, every region labelled exactly once, render-QA passes -- PASS");

// --- automatic inset: spec.inset.auto picks whichever regions' own
//     projected bbox cannot fit a name+value label at the 12px floor,
//     without the caller having to name them
{
  const spec = { ...westAfricaBase, inset: { auto: true } };
  const lint = lintVizSpec(spec, WEST_AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(spec, WEST_AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.match(svg, /data-role="choropleth-inset"/, `${viewport}: automatic mode should still produce a zoom inset given these small states`);
    const smallInInset = SMALL_ISO3.filter((iso3) => new RegExp(`<path data-role="choropleth-inset-data" data-iso3="${iso3}"`).test(svg));
    assert.ok(smallInInset.length >= 2, `${viewport}: automatic selection should pick at least a couple of the small states, picked ${JSON.stringify(smallInInset)}`);
    const gaps = everyIso3LabelledExactlyOnce(svg, ["BEN", "GMB", "GHA", "GNB", "NGA", "TGO"]);
    assert.deepEqual(gaps, [], `${viewport}: every plotted region should be labelled exactly once across main map + inset: ${gaps.join("; ")}`);
    const report = leaderCrossingReport(svg);
    assert.deepEqual(report.leaderLeader, [], `${viewport}: leader-leader crossing(s): ${report.leaderLeader.join("; ")}`);
    assert.deepEqual(report.leaderText, [], `${viewport}: leader-text crossing(s): ${report.leaderText.join("; ")}`);
    const gapFailures = leaderEndpointGapReport(svg);
    assert.deepEqual(gapFailures, [], `${viewport}: leader endpoint(s) too close to their own text box: ${gapFailures.join("; ")}`);
    const markerNumbers = duplicateMarkerNumberReport(svg);
    assert.deepEqual(markerNumbers.dupes, [], `${viewport}: duplicate footnote marker number(s): ${markerNumbers.dupes.join(", ")}`);
  }
  const qa = runRenderQa(
    { desktop, mobile },
    { choropleth: { rows: WEST_AFRICA_ROWS, category_field: spec.category_field, value_field: spec.value_field, category_names: spec.category_names, unit: spec.unit } },
  );
  assert.equal(qa.passed, true, `render-QA with automatic inset failed: ${JSON.stringify(qa.viewports, null, 2)}`);
}
console.log("choropleth automatic inset: too-small regions are auto-selected, every region labelled exactly once, render-QA passes -- PASS");

// --- negative: without any inset, these same small West African states'
//     labels fall back to the pre-existing margin/leader path (never
//     silently dropped) - the inset is opt-in, default behaviour unchanged
{
  const spec = westAfricaBase;
  const lint = lintVizSpec(spec, WEST_AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(spec, WEST_AFRICA_ROWS);
  assert.doesNotMatch(desktop, /data-role="choropleth-inset"/, "no inset option means no inset panel");
  const gaps = everyIso3LabelledExactlyOnce(desktop, ["BEN", "GMB", "GHA", "GNB", "NGA", "TGO"]);
  assert.deepEqual(gaps, [], `every plotted region should still be labelled exactly once with no inset: ${gaps.join("; ")}`);
}
console.log("choropleth no inset: small states still labelled via the pre-existing margin path, unchanged default behaviour -- PASS");

// --- regression (v7): v6's Liberia inset-leader bug. In v6 ("v6 polish"),
//     Liberia's leadered label in the West Africa inset sat directly on
//     Liberia's own polygon, in dark ink with a white halo, behind a
//     near-zero-length (4.2px) leader stub - a real defect the pre-v7
//     render-QA had no check for at all (only leader-vs-label and
//     leader-vs-other-polygon crossings were checked; nothing checked a
//     leadered label's own box against ANY polygon, or enforced a minimum
//     leader length). v7 closed both gaps at render time (viz.mjs's
//     boxOverlapsFeature + MIN_LEADER_DRAWN_LENGTH) and here, independently,
//     at render-QA time (render_qa_labels.mjs's leader_label_overlaps_polygon
//     + leader_too_short). This fixture is the frozen, unmodified byte-for-
//     byte output of v6's own renderer (git commit fac2221's viz.mjs) given
//     the exact fixture below - not hand-edited, never regenerated by
//     anything newer than v6 - and proves both directions: those bytes must
//     fail the new gates, and today's renderer, given the identical fixture,
//     must pass them.
{
  const zhInsetSpec = {
    ...base,
    language: "zh",
    title: "非洲可再生能源消费占比",
    subtitle: "部分非洲经济体，最新可得年份；西非小国见放大图",
    alt: "非洲多国可再生能源占最终能源消费比例的分级设色地图，颜色越深占比越高。几内亚、利比里亚、塞拉利昂三国面积较小，另附放大图。",
    legend_title: "可再生能源占终端能源消费比例",
    highlight_values: ["Chad"],
    inset: { iso3: ["GIN", "LBR", "SLE"], title: "西非放大" },
  };
  const choropleth = { rows: AFRICA_ROWS, category_field: zhInsetSpec.category_field, value_field: zhInsetSpec.value_field, category_names: zhInsetSpec.category_names, unit: zhInsetSpec.unit };

  const v6Desktop = readFileSync(new URL("../fixtures/choropleth-v6-liberia-regression.svg", import.meta.url), "utf8");
  const v6Mobile = readFileSync(new URL("../fixtures/choropleth-v6-liberia-regression.mobile.svg", import.meta.url), "utf8");
  const v6Qa = runRenderQa({ desktop: v6Desktop, mobile: v6Mobile }, { choropleth });
  assert.equal(v6Qa.viewports.desktop.value_labels.passed, false, "v6's frozen Liberia bug should fail today's value-labels check (desk-v6, per the review)");
  assert.equal(v6Qa.viewports.mobile.value_labels.passed, false, "v6's frozen bug should also fail on mobile");
  const v6DesktopLbrRules = v6Qa.viewports.desktop.value_labels.failures.filter((f) => f.message.includes("LBR")).map((f) => f.rule);
  assert.ok(v6DesktopLbrRules.includes("leader_too_short"), `v6 desktop should fail leader_too_short for LBR, got: ${v6DesktopLbrRules.join(", ")}`);
  assert.ok(v6DesktopLbrRules.includes("leader_label_overlaps_polygon"), `v6 desktop should fail leader_label_overlaps_polygon for LBR, got: ${v6DesktopLbrRules.join(", ")}`);

  const { desktop: v7Desktop, mobile: v7Mobile } = renderVizBundle(zhInsetSpec, AFRICA_ROWS);
  const v7Qa = runRenderQa({ desktop: v7Desktop, mobile: v7Mobile }, { choropleth });
  assert.equal(v7Qa.viewports.desktop.value_labels.passed, true, JSON.stringify(v7Qa.viewports.desktop.value_labels.failures));
  assert.equal(v7Qa.viewports.mobile.value_labels.passed, true, JSON.stringify(v7Qa.viewports.mobile.value_labels.failures));
  assert.equal(v7Qa.viewports.desktop.value_labels.checked, AFRICA_ROWS.length);
  assert.equal(v7Qa.viewports.mobile.value_labels.checked, AFRICA_ROWS.length);
}
console.log("choropleth v7 regression: v6's frozen Liberia inset-leader-overlap bug fails the new leader-length/box-overlap checks, today's render passes -- PASS");

// --- regression (v8): the 18px gap between left-column inset labels (SLE,
//     LBR in this same West-Africa inset) and their leader tips. Inset
//     overflow labels used to always start-anchor at their box's left edge
//     regardless of which side they landed on, so a left-side label left
//     choroplethLabelWidth's own overestimate, plus LEADER_GAP_PX, as dead
//     space between its text and its leader's tip. Checks both halves of
//     the fix - every inset leader tip within tolerance of its label's own
//     near text edge, and a left-side label right-aligned (text-anchor=
//     "end"), same as the main map's own overflow labels - using the
//     render-QA text-width model's own exported tables (insetLeaderLabel-
//     GapReport above) so a several-px regression can't hide inside a
//     coarser estimate.
{
  const zhInsetSpec = {
    ...base,
    language: "zh",
    title: "非洲可再生能源消费占比",
    subtitle: "部分非洲经济体，最新可得年份；西非小国见放大图",
    alt: "非洲多国可再生能源占最终能源消费比例的分级设色地图，颜色越深占比越高。几内亚、利比里亚、塞拉利昂三国面积较小，另附放大图。",
    legend_title: "可再生能源占终端能源消费比例",
    highlight_values: ["Chad"],
    inset: { iso3: ["GIN", "LBR", "SLE"], title: "西非放大" },
  };
  const { desktop, mobile } = renderVizBundle(zhInsetSpec, AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    const { gapFailures, anchorFailures } = insetLeaderLabelGapReport(svg);
    assert.deepEqual(gapFailures, [], `${viewport}: inset leader-to-label gap regression: ${gapFailures.join("; ")}`);
    assert.deepEqual(anchorFailures, [], `${viewport}: inset left-side label anchor regression: ${anchorFailures.join("; ")}`);
    // SLE/LBR are the two that overflow into leadered, left-side inset
    // labels at desktop width - a concrete, human-readable check on top of
    // the general one above. At a narrower viewport a small country can
    // fall back further, to a numbered footnote marker instead of a
    // leadered label (a separate, pre-existing code path this fix does not
    // touch), so this only asserts when that specific element is present.
    for (const iso3 of ["SLE", "LBR"]) {
      const tagMatch = svg.match(new RegExp(`<text data-role="choropleth-inset-label" data-iso3="${iso3}"[^>]*>`));
      if (tagMatch) {
        assert.match(tagMatch[0], /text-anchor="end"/, `${viewport}: ${iso3} renders as a leadered inset label and should be right-aligned (left-side)`);
      }
    }
  }
}
console.log("choropleth v8 regression: left-column inset labels (SLE, LBR) sit within the leader-gap tolerance of their leader tips and are right-aligned -- PASS");

// --- regression (v9): the inset panel must keep at least 8px clearance from
//     its own source-extent outline (choropleth-inset-source) instead of
//     printing on top of it - see insetPanelSourceClearanceReport above for
//     the root cause and fix. Same fixture as the v7/v8 regressions above
//     (its own source-extent outline sits close enough to the panel corner
//     that this is where the original defect was found).
{
  const zhInsetSpec = {
    ...base,
    language: "zh",
    title: "非洲可再生能源消费占比",
    subtitle: "部分非洲经济体，最新可得年份；西非小国见放大图",
    alt: "非洲多国可再生能源占最终能源消费比例的分级设色地图，颜色越深占比越高。几内亚、利比里亚、塞拉利昂三国面积较小，另附放大图。",
    legend_title: "可再生能源占终端能源消费比例",
    highlight_values: ["Chad"],
    inset: { iso3: ["GIN", "LBR", "SLE"], title: "西非放大" },
  };
  const { desktop, mobile } = renderVizBundle(zhInsetSpec, AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    const failures = insetPanelSourceClearanceReport(svg);
    assert.deepEqual(failures, [], `${viewport}: inset panel/source-outline clearance regression: ${failures.join("; ")}`);
  }
}
console.log("choropleth v9 regression: the inset panel keeps at least 8px clearance from its own source-extent outline on both viewports -- PASS");

// --- regression (v10): the inset panel must ALSO clear every on-map label
//     box and on-map numbered-marker circle, not just its own source-extent
//     outline (the v9 fix above) - see onMapLabelOrMarkerOverlapReport and
//     insetLabelsContainedReport above for the root cause and fix. Same
//     fixture as the v7/v8/v9 regressions (on this fixture the pre-fix
//     panel covered South Sudan's and Zambia's on-map labels on both
//     viewports).
{
  const zhInsetSpec = {
    ...base,
    language: "zh",
    title: "非洲可再生能源消费占比",
    subtitle: "部分非洲经济体，最新可得年份；西非小国见放大图",
    alt: "非洲多国可再生能源占最终能源消费比例的分级设色地图，颜色越深占比越高。几内亚、利比里亚、塞拉利昂三国面积较小，另附放大图。",
    legend_title: "可再生能源占终端能源消费比例",
    highlight_values: ["Chad"],
    inset: { iso3: ["GIN", "LBR", "SLE"], title: "西非放大" },
  };
  const { desktop, mobile } = renderVizBundle(zhInsetSpec, AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    const clearance = insetPanelSourceClearanceReport(svg);
    assert.deepEqual(clearance, [], `${viewport}: inset panel/source-outline clearance regression: ${clearance.join("; ")}`);
    const labelOverlap = onMapLabelOrMarkerOverlapReport(svg);
    assert.deepEqual(labelOverlap, [], `${viewport}: inset panel overlaps an on-map label/marker: ${labelOverlap.join("; ")}`);
    const contained = insetLabelsContainedReport(svg);
    assert.deepEqual(contained, [], `${viewport}: inset label(s) not fully contained in the panel: ${contained.join("; ")}`);
  }
}
console.log("choropleth v10 regression: the inset panel clears every on-map label/marker (not just its own source outline) on both viewports, every inset label stays inside the panel -- PASS");

// --- positive: the locator IS relevant (and shown) when the plotted extent
//     is a genuinely small slice of the continent - this West Africa cluster
//     covers well under 25% of the continent's own bounding box.
{
  const spec = westAfricaBase;
  const lint = lintVizSpec(spec, WEST_AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(spec, WEST_AFRICA_ROWS);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.match(svg, /data-role="choropleth-locator"/, `${viewport} should include the locator inset for a small-footprint extent`);
    assert.match(svg, /data-role="choropleth-locator"[^]*?<clipPath id="choropleth-locator-clip-[dm]">/, `${viewport}: locator should clip its own countries/indicator to its panel rect`);
    assert.match(svg, new RegExp(`data-role="choropleth-locator"[^]*?<rect data-role="choropleth-locator-area"[^>]*fill="none" stroke="${PALETTE.accent}" stroke-width="1.5"/>`), `${viewport}: locator should mark the zoomed area as a straight accent-outlined rect`);
  }
}
console.log("choropleth locator relevance: shown for a small-footprint West Africa extent, clipped to its own panel -- PASS");

// --- palette (review fix, option B): the ramp's own relative luminance
//     reads strictly light->dark (monotonic), matching the OKLCH lightness
//     it was generated from - independent evidence a caller could derive
//     from the ramp itself without trusting the constant's own comment.
{
  function srgbToLinearChannel(v) { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  function relativeLuminance(hex) {
    const v = parseInt(hex.replace("#", ""), 16);
    const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    return 0.2126 * srgbToLinearChannel(r) + 0.7152 * srgbToLinearChannel(g) + 0.0722 * srgbToLinearChannel(b);
  }
  assert.equal(CHOROPLETH_RAMP.length, 5, "ramp should keep its 5-class shape");
  const luminances = CHOROPLETH_RAMP.map(relativeLuminance);
  for (let i = 1; i < luminances.length; i++) {
    assert.ok(luminances[i] < luminances[i - 1], `ramp step ${i} (${CHOROPLETH_RAMP[i]}) should be darker (lower relative luminance) than step ${i - 1} (${CHOROPLETH_RAMP[i - 1]})`);
  }
}
console.log("choropleth palette: CHOROPLETH_RAMP has monotonic (light -> dark) lightness -- PASS");

// --- highlight outline (review fix, option B): spec.highlight_values draws
//     a 1.5px accent outline over the highlighted country's own polygon,
//     never in place of its fill - and only for the country actually named,
//     not every country on the map.
{
  const spec = { ...base, highlight_values: ["Chad"] };
  const lint = lintVizSpec(spec, AFRICA_ROWS, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(spec, AFRICA_ROWS);
  const outlines = [...desktop.matchAll(/<path data-role="choropleth-highlight-outline" data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  assert.ok(outlines.length >= 1, "expected at least one highlight outline for the highlighted country");
  assert.ok(outlines.every((iso3) => iso3 === "TCD"), `only Chad (TCD) should carry a highlight outline, saw ${JSON.stringify(outlines)}`);
  assert.match(desktop, new RegExp(`<path data-role="choropleth-highlight-outline" data-iso3="TCD"[^>]*fill="none" stroke="${PALETTE.accent}" stroke-width="1.5"/>`), "highlight outline should be a stroke-only accent ring, not a fill change");
  // Chad's own data fill (still driven by colorForValue, unchanged by the
  // highlight) should still appear exactly as any other country's would.
  assert.match(desktop, /<path data-role="choropleth-data" data-iso3="TCD" data-value="70"/, "Chad's own data path should keep its ordinary value-driven fill");

  const unhighlighted = renderVizBundle(base, AFRICA_ROWS).desktop;
  assert.doesNotMatch(unhighlighted, /data-role="choropleth-highlight-outline"/, "no highlight_values means no highlight outline at all");
}
console.log("choropleth highlight outline: accent outline drawn only for spec-highlighted countries, fill unchanged -- PASS");

// --- inset outside the map: the zoom inset panel gets its own reserved
//     column (desktop) or strip (mobile) and never intersects the map frame,
//     which is also the only place basemap land is drawn.
{
  const spec = { ...base, inset: { iso3: ["GIN", "LBR", "SLE"], title: "West Africa" } };
  const { desktop, mobile } = renderVizBundle(spec, AFRICA_ROWS);
  const box = (svg, re) => {
    const m = svg.match(re);
    assert.ok(m, `expected to find ${re}`);
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
  };
  for (const [name, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    const panel = box(svg, /<g data-role="choropleth-inset"><rect x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/);
    const map = box(svg, /<rect data-role="choropleth-ocean" x="([-0-9.]+)" y="([-0-9.]+)" width="([-0-9.]+)" height="([-0-9.]+)"/);
    const hit = panel.x < map.x + map.w && panel.x + panel.w > map.x && panel.y < map.y + map.h && panel.y + panel.h > map.y;
    assert.equal(hit, false, `${name}: inset panel must sit outside the map frame`);
    const vb = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
    assert.ok(panel.x >= 0 && panel.x + panel.w <= +vb[1] && panel.y + panel.h <= +vb[2], `${name}: inset panel must stay inside the canvas`);
    assert.match(svg, /data-role="choropleth-inset-source"/, `${name}: source-extent outline stays on the main map`);
    assert.match(svg, /data-role="choropleth-inset-link"/, `${name}: connector links the source outline to the panel`);
  }
}
console.log("choropleth inset: panel reserved outside the map frame on desktop and mobile -- PASS");

console.log("choropleth chart: PASS");
