#!/usr/bin/env node
// K308 item 3: the choropleth 60-row refusal and the LIMIT warning name the same allowed path. The cap, its refusal text and the world-mode rules are unchanged (guidance only).
// Run: node scripts/test_k308_item3_choropleth_path.mjs
import assert from "node:assert/strict";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID, joinChoroplethRows, lintChoroplethSpec, neAttributesAsset } from "../runtime/pi/choropleth.mjs";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const spec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Inflation by economy", alt: "A world map of inflation by economy.",
  source_note: "Synthetic fixture", claim_id: "claim-k308", sql: "SELECT iso3, v FROM fixture", unit: "%", chart_type: "choropleth",
  category_field: "iso3", value_field: "v", category_names: "iso3", basemap_id: basemap.id, basemap_source_url: basemap.source_url,
  basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [],
};
const seen = new Set();
const ISO = neAttributesAsset().features.filter((f) => f.iso3 && f.continent !== "Antarctica" && f.continent !== "Seven seas (open ocean)" && !seen.has(f.iso3) && seen.add(f.iso3)).map((f) => f.iso3);
const rows = ISO.map((iso3, i) => ({ iso3, v: 1 + (i % 50) })).filter((r) => joinChoroplethRows([r], spec)[0]?.featureIndices.length);
ok(rows.length > 100, "enough synthetic economies");
const CAP = `choropleth has ${rows.length} rows; maximum is 60 - filter rows in SQL`;
const OLD_WARNING = "choropleth rows come from a LIMIT query, so the map covers only a top-N slice while the source has more economies; map every economy with data and use a bar chart for a top list";
for (const world of [undefined, "1"]) {
  if (world === undefined) delete process.env.NEWSROOM_MAP_WORLD; else process.env.NEWSROOM_MAP_WORLD = world;
  const label = world ? "world mode available" : "world mode off";
  // over the cap, no map_extent
  const lint = lintChoroplethSpec(spec, rows);
  ok(lint.blockers.includes(CAP), `${label}: the cap refusal text is unchanged`);
  const hint = lint.blockers.find((b) => b.startsWith("choropleth over the 60-row cap: "));
  ok(hint, `${label}: the refusal names the allowed path`);
  ok(/WHERE rule such as a value threshold, not by LIMIT/.test(hint), `${label}: names the WHERE-threshold path`);
  ok(world ? /map_extent 'world' and remove any LIMIT/.test(hint) : /map_extent 'world' is not available in this run/.test(hint), `${label}: says whether map_extent 'world' is open`);
  // a LIMIT slice under the cap: the warning names the same path
  const slice = lintChoroplethSpec({ ...spec, sql: "SELECT iso3, v FROM fixture ORDER BY v DESC LIMIT 40" }, rows.slice(0, 40));
  const warn = slice.warnings.find((w) => w.startsWith(OLD_WARNING));
  ok(warn, `${label}: the old warning text is still the start of the warning`);
  ok(warn.endsWith(hint.slice("choropleth over the 60-row cap: ".length)), `${label}: warning and refusal carry the same path text`);
  ok(slice.blockers.length === 0, `${label}: a 40-row slice is still not blocked`);
}
// world mode on and map_extent world: nothing is added
process.env.NEWSROOM_MAP_WORLD = "1";
const w = lintChoroplethSpec({ ...spec, map_extent: "world" }, rows);
ok(!w.blockers.some((b) => b.includes("60-row cap")), "world extent: no cap blocker, no hint");
const wl = lintChoroplethSpec({ ...spec, map_extent: "world", sql: "SELECT iso3, v FROM fixture LIMIT 150" }, rows);
ok(wl.warnings.includes(OLD_WARNING), "world extent with LIMIT: warning text unchanged");
console.log(`K308 item 3 choropleth path: PASS (${checks} checks)`);
