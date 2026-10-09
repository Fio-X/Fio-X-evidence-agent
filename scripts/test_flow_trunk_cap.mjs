#!/usr/bin/env node
// NEWSROOM_FLOW_TRUNK_MAX_W=12 (default unset = 14): picture knob for the D trunk (V568's open question; V528's cap is 12 px). Only the exact value 12 changes
// anything. Unset and every other value render byte-identical to the commit before the knob (7a88ecb); 12 keeps the widest trunk <= 12 and the one width
// scale (trunk = sum of its branches) intact. The cap itself is not checked here: that waits for the user's pick.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from "../runtime/pi/cartography.mjs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
Object.assign(process.env, { NEWSROOM_FLOW_MAP_LABELS: "1", NEWSROOM_FLOW_STYLE_TRUNK: "1" });
delete process.env.NEWSROOM_FLOW_STYLE_CIRCLES;
const rows = Array.from({ length: 15 }, (_, i) => ({ source: `来源${String.fromCharCode(65 + i)}`, target: "德国", source_lat: -40 + ((i * 11) % 90), source_lon: -150 + i * 20, target_lat: 51, target_lon: 10, value: Math.round(1000 / (1 + i)) }));
const spec = { schema_version: "1.0.0", chart_type: "cartographic_flow_map", reader_task: "flow", visual_family: "spatial", data_topology: "geo_edges", language: "zh", title: "德国原油来源", subtitle: "测试数据", unit: "万吨", alt: "德国原油来源的流向弧线，测试数据。", source_note: "测试数据。", note: "弧线表示关系，不是实际路线。", claim_id: "claim-carto-v15", sql: "SELECT 1", value_field: "value", source_field: "source", target_field: "target", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: "none", geometry_semantics: "abstract_od", source_lat_field: "source_lat", source_lon_field: "source_lon", target_lat_field: "target_lat", target_lon_field: "target_lon", flow_map_labels: "ledger", extent_mode: "data", direct_labels: true, annotations: [], highlight_values: [] };
const render = (value, mod = { renderVizBundle }) => { if (value === undefined) delete process.env.NEWSROOM_FLOW_TRUNK_MAX_W; else process.env.NEWSROOM_FLOW_TRUNK_MAX_W = value; return mod.renderVizBundle(spec, rows).desktop; };
const trunkWidths = (svg) => [...svg.matchAll(/<path data-role="cartographic-flow-trunk" [^>]*stroke-width="([\d.]+)"/g)].map((m) => +m[1]);

const at14 = render(undefined), at12 = render("12");
assert.ok(trunkWidths(at14).length >= 1, "the fixture draws trunks");
const w14 = Math.max(...trunkWidths(at14)), w12 = Math.max(...trunkWidths(at12));
assert.ok(w14 > 12 && w14 <= 14.01, `unset: the widest trunk is the 14 px one (${w14})`);
assert.ok(w12 <= 12.01 && w12 > 11, `12: the widest trunk is capped at 12 (${w12})`);
assert.notEqual(at12, at14, "12 changes the picture");
for (const other of ["0", "true", "yes", "", " 12", "12 ", "012", "14", "13"]) assert.equal(render(other), at14, `value ${JSON.stringify(other)} is off`);
// byte-identical to before the knob
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", "7a88ecb", "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) console.log("7a88ecb history unavailable; skipped the byte comparison with it");
else {
  const dir = mkdtempSync(join(tmpdir(), "trunk-cap-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "b.tar"), archive.stdout);
  assert.equal(spawnSync("tar", ["-xf", join(dir, "b.tar"), "-C", dir]).status, 0);
  const base = await import(pathToFileURL(join(dir, "runtime/pi/viz.mjs")).href);
  assert.equal(render(undefined), render(undefined, base), "unset is byte-identical to 7a88ecb");
  assert.equal(render("0"), render(undefined, base), "0 is byte-identical to 7a88ecb");
}
console.log("flow trunk cap: ok", { w14, w12 });
