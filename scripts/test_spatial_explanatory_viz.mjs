#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { critiqueViz, lintVizSpec, renderVizBundle } from "../runtime/pi/viz.mjs";

const claimId = "claim-v09-spatial";
const base = {
  schema_version: "0.9.0",
  takeaway: "Topology-aware visual fixture",
  title: "Spatial and explanatory visual journalism fixture",
  alt: "A responsive editorial visualization tests a topology-aware renderer with verified synthetic data.",
  source_note: "Synthetic v0.9 regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
  unit: "units",
  complexity_budget: "medium",
  annotations: [],
  highlight_values: [],
};
const context = { verified_claim_ids: [claimId] };

const parallelRows = [
  { origin: "Urban", mode: "Rail", outcome: "On time", value: 32 },
  { origin: "Urban", mode: "Rail", outcome: "Delayed", value: 8 },
  { origin: "Urban", mode: "Road", outcome: "On time", value: 18 },
  { origin: "Urban", mode: "Road", outcome: "Delayed", value: 12 },
  { origin: "Rural", mode: "Rail", outcome: "On time", value: 10 },
  { origin: "Rural", mode: "Rail", outcome: "Delayed", value: 5 },
  { origin: "Rural", mode: "Road", outcome: "On time", value: 16 },
  { origin: "Rural", mode: "Road", outcome: "Delayed", value: 19 },
];
const parallel = {
  ...base, reader_task: "flow", visual_family: "flow", data_topology: "categorical_flow",
  chart_type: "parallel_sets", dimension_fields: ["origin", "mode", "outcome"], value_field: "value",
  title: "Trips move through origin, mode and outcome",
  alt: "Parallel sets show weighted trip paths from urban and rural origins through transport mode to on-time or delayed outcomes.",
};
let lint = lintVizSpec(parallel, parallelRows, context);
assert.equal(lint.passed, true, lint.blockers.join(" | "));
let bundle = renderVizBundle(parallel, parallelRows);
assert.match(bundle.desktop, /data-role="parallel-ribbon"/);
assert.match(bundle.mobile, /data-role="parallel-node"/);
let critic = critiqueViz(parallel, parallelRows, lint, bundle.desktop);
assert.equal(critic.passed, true);
const negativeParallel = parallelRows.map((row, i) => i === 0 ? { ...row, value: -1 } : row);
assert.equal(lintVizSpec(parallel, negativeParallel, context).passed, false);

const chordRows = [
  { source: "Asia", target: "Europe", value: 42 }, { source: "Asia", target: "North America", value: 36 },
  { source: "Europe", target: "North America", value: 24 }, { source: "Europe", target: "Africa", value: 17 },
  { source: "Africa", target: "Asia", value: 15 }, { source: "North America", target: "Latin America", value: 21 },
  { source: "Latin America", target: "Europe", value: 12 }, { source: "Latin America", target: "Asia", value: 9 },
];
const chord = {
  ...base, reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges",
  chart_type: "chord", source_field: "source", target_field: "target", value_field: "value",
  title: "Regions are connected by bilateral flows",
  alt: "A chord diagram shows weighted relationships among five world regions, with thicker ribbons representing larger flows.",
  highlight_values: ["Asia"],
};
lint = lintVizSpec(chord, chordRows, context);
assert.equal(lint.passed, true, lint.blockers.join(" | "));
bundle = renderVizBundle(chord, chordRows);
assert.match(bundle.desktop, /data-role="chord-ribbon"/);
assert.match(bundle.mobile, /data-role="chord-arc"/);
assert.equal(critiqueViz(chord, chordRows, lint, bundle.desktop).passed, true);
const negativeChord = chordRows.map((row, i) => i === 0 ? { ...row, value: -2 } : row);
assert.equal(lintVizSpec(chord, negativeChord, context).passed, false);

const geoRows = [
  { source: "Singapore", slat: 1.3521, slon: 103.8198, target: "Rotterdam", tlat: 51.9244, tlon: 4.4777, value: 18 },
  { source: "Shanghai", slat: 31.2304, slon: 121.4737, target: "Los Angeles", tlat: 34.0522, tlon: -118.2437, value: 15 },
  { source: "Busan", slat: 35.1796, slon: 129.0756, target: "Long Beach", tlat: 33.7701, tlon: -118.1937, value: 11 },
  { source: "Dubai", slat: 25.2048, slon: 55.2708, target: "Hamburg", tlat: 53.5511, tlon: 9.9937, value: 8 },
  { source: "Santos", slat: -23.9608, slon: -46.3336, target: "Antwerp", tlat: 51.2194, tlon: 4.4025, value: 7 },
];
const geo = {
  ...base, reader_task: "spatial", visual_family: "spatial", data_topology: "geo_edges",
  chart_type: "geo_flow_map", source_field: "source", target_field: "target",
  source_lat_field: "slat", source_lon_field: "slon", target_lat_field: "tlat", target_lon_field: "tlon", value_field: "value",
  title: "Major routes connect Asian, European and American ports",
  alt: "A schematic geographic flow map shows five weighted routes between major ports across Asia, Europe, North America and South America.",
};
lint = lintVizSpec(geo, geoRows, context);
assert.equal(lint.passed, true, lint.blockers.join(" | "));
assert.ok(lint.notes.some((note) => note.includes("schematic equirectangular")));
bundle = renderVizBundle(geo, geoRows);
assert.match(bundle.desktop, /data-role="geo-flow"/);
assert.match(bundle.desktop, /Schematic equirectangular/);
assert.equal(critiqueViz(geo, geoRows, lint, bundle.mobile).passed, true);
const badGeo = geoRows.map((row, i) => i === 0 ? { ...row, slat: 104 } : row);
const badGeoLint = lintVizSpec(geo, badGeo, context);
assert.equal(badGeoLint.passed, false);
assert.ok(badGeoLint.blockers.some((x) => x.includes("latitude out of range")));
const missingGeo = geoRows.map((row, i) => i === 0 ? { ...row, slat: null } : row);
const missingGeoLint = lintVizSpec(geo, missingGeo, context);
assert.equal(missingGeoLint.passed, false, "missing latitude must not coerce to zero");

const processRows = [
  { source: "Report arrives", target: "Extract facts", edge: "ingest" },
  { source: "Extract facts", target: "Verify sources", edge: "evidence" },
  { source: "Verify sources", target: "Compute metrics", edge: "validated data" },
  { source: "Compute metrics", target: "Draft finding", edge: "result" },
  { source: "Draft finding", target: "Visual review", edge: "story claim" },
  { source: "Visual review", target: "Publish", edge: "approved" },
];
const processSpec = {
  ...base, reader_task: "process", visual_family: "explanatory", data_topology: "process_graph",
  chart_type: "process_schematic", source_field: "source", target_field: "target", edge_label_field: "edge",
  title: "A verified newsroom claim moves through six stages",
  alt: "A process schematic shows a report moving from fact extraction and source verification through deterministic computation, drafting, visual review and publication.",
  highlight_values: ["Verify sources"],
};
lint = lintVizSpec(processSpec, processRows, context);
assert.equal(lint.passed, true, lint.blockers.join(" | "));
bundle = renderVizBundle(processSpec, processRows);
assert.match(bundle.desktop, /data-role="process-edge"/);
assert.match(bundle.mobile, /data-role="process-node"/);
assert.equal(critiqueViz(processSpec, processRows, lint, bundle.desktop).passed, true);
const cyclicProcess = [...processRows, { source: "Publish", target: "Extract facts", edge: "bad cycle" }];
const cyclicLint = lintVizSpec(processSpec, cyclicProcess, context);
assert.equal(cyclicLint.passed, false);
assert.ok(cyclicLint.blockers.some((x) => x.includes("acyclic")));

if (process.argv.includes("--write-fixtures")) {
  await mkdir(new URL("../fixtures/spatial-explanatory/", import.meta.url), { recursive: true });
  for (const [name, spec, rows] of [
    ["parallel-sets", parallel, parallelRows], ["chord", chord, chordRows], ["geo-flow-map", geo, geoRows], ["process-schematic", processSpec, processRows],
  ]) {
    const l = lintVizSpec(spec, rows, context); const b = renderVizBundle(spec, rows);
    await writeFile(new URL(`../fixtures/spatial-explanatory/${name}.svg`, import.meta.url), b.desktop);
    await writeFile(new URL(`../fixtures/spatial-explanatory/${name}.mobile.svg`, import.meta.url), b.mobile);
    await writeFile(new URL(`../fixtures/spatial-explanatory/${name}.json`, import.meta.url), JSON.stringify({spec, rows, lint:l}, null, 2)+"\n");
  }
}

console.log("spatial/explanatory viz tests: PASS");
console.log("parallel sets negative-weight blocker: PASS");
console.log("chord negative-weight blocker: PASS");
console.log("geo coordinate-range and missing-value blockers: PASS");
console.log("process cycle blocker: PASS");
