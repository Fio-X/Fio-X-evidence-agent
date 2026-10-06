#!/usr/bin/env node
// Covers choropleth map_extent: "world" (opt-in whole-world mode): the 60-row cap lifted only for it,
// a LIMIT in the SQL blocked, at most 8 text labels (range ends + highlight_values), the fixed
// Equal Earth frame without Antarctica, and render QA still passing. Synthetic rows only.
import assert from "node:assert/strict";
// World mode is behind NEWSROOM_MAP_WORLD (off by default); this suite covers the mode itself, so it needs the switch on:
// NEWSROOM_MAP_WORLD=1 node scripts/test_map_world.mjs (test_map_world_switch.mjs covers the off state).
assert.equal(process.env.NEWSROOM_MAP_WORLD, "1", "run test_map_world.mjs with NEWSROOM_MAP_WORLD=1");
import { lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID, joinChoroplethRows, lintChoroplethSpec, neAttributesAsset, worldLabelIso3s } from "../runtime/pi/choropleth.mjs";
import { choroplethValueText, PALETTE } from "../runtime/pi/viz.mjs";

const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const spec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Inflation by economy", alt: "A world map of inflation by economy, darker meaning higher.",
  source_note: "Synthetic fixture", claim_id: "claim-world-fixture", sql: "SELECT iso3, v FROM fixture", unit: "%", chart_type: "choropleth",
  category_field: "iso3", value_field: "v", category_names: "iso3", basemap_id: basemap.id, basemap_source_url: basemap.source_url,
  basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], map_extent: "world",
};

// ~190 distinct sovereign-economy iso3 codes from the sidecar, with a skewed (E-shaped) deterministic value.
const seen = new Set();
const ISO = neAttributesAsset().features.filter((f) => f.iso3 && f.continent !== "Antarctica" && f.continent !== "Seven seas (open ocean)" && !seen.has(f.iso3) && seen.add(f.iso3)).map((f) => f.iso3);
const skew = (i) => Math.round((0.5 + (((i * 37) % 97) / 97) ** 4 * 60 + (i % 7 === 0 ? 3 : 0)) * 10) / 10;
const ROWS = ISO.map((iso3, i) => ({ iso3, v: skew(i) }));
const economyRows = ROWS.filter((r) => joinChoroplethRows([r], spec)[0]?.entry?.kind === "economy" && joinChoroplethRows([r], spec)[0].featureIndices.length);
assert.ok(economyRows.length > 150, `enough synthetic economies (${economyRows.length})`);
const goodSpec = { ...spec, highlight_values: [economyRows[3].iso3] };
const lintOf = (s, rows = economyRows) => lintVizSpec(s, rows, { verified_claim_ids: [s.claim_id] });
const has = (list, re) => list.some((m) => re.test(String(m)));

{ // world mode: rows over the cap render, no cap blocker
  assert.deepEqual(validateVizSpec(goodSpec), []);
  const lint = lintChoroplethSpec(goodSpec, economyRows);
  assert.deepEqual(lint.blockers, [], "no blockers for complete world data");
  const { desktop } = renderVizBundle(goodSpec, economyRows);
  assert.ok((desktop.match(/data-role="choropleth-data"/g) ?? []).length >= economyRows.length * 0.9, "every economy is a data region");
  const names = [...desktop.matchAll(/data-role="choropleth-(?:label|inset-label|footnote-name)"[^>]*data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  const nameSet = new Set(names);
  assert.ok(nameSet.size >= 1 && nameSet.size <= 8, `at most 8 labelled features (${nameSet.size})`);
  assert.deepEqual(names.length, nameSet.size, "each labelled feature once");
  assert.ok(nameSet.has(economyRows[3].iso3), "highlight is labelled");
  const expected = worldLabelIso3s(economyRows.map((r) => joinChoroplethRows([r], goodSpec)[0]), goodSpec);
  assert.deepEqual([...nameSet].sort(), [...expected].sort(), "labelled set is the range ends plus highlights");
  assert.ok(!/data-iso3="ATA"/.test(desktop), "no Antarctica data region");
  const qa = runRenderQa({ desktop }, { choropleth: { rows: economyRows, category_field: "iso3", value_field: "v", category_names: "iso3", unit: "%", map_extent: "world", highlight_values: goodSpec.highlight_values } });
  assert.equal(qa.passed, true, `render QA passes: ${JSON.stringify(Object.values(qa.viewports).flatMap((v) => [...v.geometry.failures, ...(v.contrast?.failures ?? []), ...(v.value_labels?.failures ?? [])]).map((f) => f.message)).slice(0, 1500)}`);
}

{ // same rows without map_extent: still blocked by the 60-row cap, message unchanged
  const { map_extent, ...plain } = goodSpec;
  const lint = lintChoroplethSpec(plain, economyRows);
  assert.ok(lint.blockers.includes(`choropleth has ${economyRows.length} rows; maximum is 60 - filter rows in SQL`), "default cap unchanged");
}

{ // world + LIMIT blocked
  const lint = lintChoroplethSpec({ ...goodSpec, sql: "SELECT iso3, v FROM t ORDER BY v DESC LIMIT 150" }, economyRows);
  assert.ok(has(lint.blockers, /LIMIT/), "LIMIT blocked in world mode");
}

{ // more than 8 labelled features blocked
  const many = economyRows.slice(0, 9).map((r) => r.iso3);
  const lint = lintChoroplethSpec({ ...goodSpec, highlight_values: many }, economyRows);
  assert.ok(has(lint.blockers, /at most 8/), "more than 8 labelled features blocked");
  const ok = lintChoroplethSpec({ ...goodSpec, highlight_values: economyRows.slice(0, 6).map((r) => r.iso3) }, economyRows);
  assert.deepEqual(ok.blockers, [], "6 highlights + 2 range ends = 8 passes");
}

{ // aggregates, duplicates and no-feature rows stay blocked in world mode
  const agg = lintChoroplethSpec({ ...spec, category_names: "worldbank", category_field: "c" }, [{ c: "World", v: 1 }]);
  assert.ok(agg.blockers.length, "aggregate row still blocked");
  const dup = lintChoroplethSpec(goodSpec, [...economyRows, economyRows[0]]);
  assert.ok(has(dup.blockers, /duplicate/), "duplicate still blocked");
}

{ // invalid map_extent value rejected
  const bad = validateVizSpec({ ...goodSpec, map_extent: "europe" });
  assert.ok(has(bad, /map_extent/), "only 'world' accepted");
}

console.log("ok test_map_world");
