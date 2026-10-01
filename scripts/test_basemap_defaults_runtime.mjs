// Basemap provenance defaults follow the selected basemap_id. A usability fix,
// not a relaxation: an omitted field is filled from the registry entry of the
// chosen basemap; a value the caller wrote is never replaced and is still
// checked by validateVizSpec against the registry.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "basemap-defaults-"));
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));

const art = join(mkdtempSync(join(tmpdir(), "basemap-run-")), "run");
for (const d of ["visualizations/plans", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
  claim_id: "claim-fixture", status: "verified", source_refs: ["data/africa.csv"],
  verification: { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true },
})}\n`);
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));

const B50 = getBasemap("naturalearth_admin0_50m");
const B110 = getBasemap("naturalearth_admin0_110m");
assert.ok(B50 && B110 && B50.content_hash !== B110.content_hash);

const flow = (extra = {}) => ({
  reader_task: "spatial", title: "Flows", alt: "Arcs between a few origin and destination points on a world map.",
  source_note: "fixture", claim_id: "claim-fixture", sql: "SELECT 1 AS source_lat, 2 AS source_lon, 3 AS target_lat, 4 AS target_lon, 5 AS value",
  unit: "units", chart_type: "cartographic_flow_map", geometry_semantics: "abstract_od", value_field: "value",
  source_lat_field: "source_lat", source_lon_field: "source_lon", target_lat_field: "target_lat", target_lon_field: "target_lon",
  highlight_values: [], annotations: [], ...extra,
});
const plan = async (params) => {
  const res = await tools.get("newsroom_viz_plan").execute("p", params);
  return JSON.parse(readFileSync(join(art, res.details.planRef), "utf8"));
};
const keys = ["basemap_source_url", "basemap_license", "basemap_content_hash"];
const provenance = (spec, entry) => [spec.basemap_id, ...keys.map((k) => spec[k])].join("|") === [entry.id, entry.source_url, entry.license, entry.content_hash].join("|");

{ // omitted basemap_id: the 50m default, exactly as before
  const spec = await plan(flow());
  assert.ok(provenance(spec, B50));
}
{ // non-default id, provenance omitted: filled from THAT basemap (used to be rejected)
  const spec = await plan(flow({ basemap_id: B110.id }));
  assert.ok(provenance(spec, B110), "110m selected -> 110m url/license/hash");
}
{ // partial: the caller's correct url is kept, the rest follows the selected id
  const spec = await plan(flow({ basemap_id: B110.id, basemap_source_url: B110.source_url }));
  assert.ok(provenance(spec, B110));
}
// Must fail: values the model wrote are never overridden by the registry.
const zeros = "0".repeat(64);
await assert.rejects(() => plan(flow({ basemap_content_hash: zeros })), /basemap_content_hash does not match/, "wrong hash, default id");
await assert.rejects(() => plan(flow({ basemap_id: B110.id, basemap_content_hash: zeros })), /basemap_content_hash does not match/, "wrong hash, selected id");
await assert.rejects(() => plan(flow({ basemap_id: B110.id, basemap_content_hash: B50.content_hash })), /basemap_content_hash does not match/, "another basemap's hash");
await assert.rejects(() => plan(flow({ basemap_id: B110.id, basemap_license: "Public domain (edited)" })), /basemap_license does not match/, "rewritten license");
await assert.rejects(() => plan(flow({ basemap_id: B110.id, basemap_source_url: B50.source_url })), /basemap_source_url does not match/, "another basemap's url");
// Must fail: an unknown id gets no defaults at all.
await assert.rejects(() => plan(flow({ basemap_id: "not_a_basemap" })), /Unknown basemap_id/, "unknown id");
// choropleth stays bound to the 50m basemap, whatever the caller selects.
await assert.rejects(() => plan({ ...flow(), chart_type: "choropleth", category_field: "c", value_field: "v", category_names: "worldbank", basemap_id: B110.id }), /choropleth requires basemap_id/, "choropleth + 110m");
console.log("basemap defaults follow basemap_id; wrong, rewritten or unknown values are still rejected -- PASS");
