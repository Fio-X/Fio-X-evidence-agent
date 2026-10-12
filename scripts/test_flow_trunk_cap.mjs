#!/usr/bin/env node
// V568: with the D (trunk) style on, the widest trunk is 12 px in every case, and render QA reports any trunk wider than that.
//  - the 15-source fixture and a 15-branch cluster whose minimum widths alone used to give an 18 px trunk both stay at <= 12 px;
//  - the one width scale (trunk width = sum of its branch widths) still holds;
//  - render QA fails a trunk path wider than 12 px (red test with an 18 px SVG) and leaves every SVG without trunks untouched;
//  - the trunk cap is fixed: no environment variable sets a trunk width or maximum;
//  - D off (default, C only, labels off): byte-identical to 46c3624.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from "../runtime/pi/cartography.mjs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
Object.assign(process.env, { NEWSROOM_FLOW_MAP_LABELS: "1", NEWSROOM_FLOW_STYLE_TRUNK: "1" });
delete process.env.NEWSROOM_FLOW_STYLE_CIRCLES;
const rows = Array.from({ length: 15 }, (_, i) => ({ source: `来源${String.fromCharCode(65 + i)}`, target: "德国", source_lat: -40 + ((i * 11) % 90), source_lon: -150 + i * 20, target_lat: 51, target_lon: 10, value: Math.round(1000 / (1 + i)) }));
const spec = { schema_version: "1.0.0", chart_type: "cartographic_flow_map", reader_task: "flow", visual_family: "spatial", data_topology: "geo_edges", language: "zh", title: "德国原油来源", subtitle: "测试数据", unit: "万吨", alt: "德国原油来源的流向弧线，测试数据。", source_note: "测试数据。", note: "弧线表示关系，不是实际路线。", claim_id: "claim-carto-v15", sql: "SELECT 1", value_field: "value", source_field: "source", target_field: "target", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: "none", geometry_semantics: "abstract_od", source_lat_field: "source_lat", source_lon_field: "source_lon", target_lat_field: "target_lat", target_lon_field: "target_lon", flow_map_labels: "ledger", extent_mode: "data", direct_labels: true, annotations: [], highlight_values: [] };
// 15 sources in one direction: their 1.2 px minimum widths alone sum to 18 px.
const clusterRows = Array.from({ length: 15 }, (_, i) => ({ source: `来源${String.fromCharCode(65 + i)}`, target: "德国", source_lat: 22 + i * 0.6, source_lon: 62 + i * 1.5, target_lat: 51, target_lon: 10, value: 10 + i }));
const render = (r = rows, mod = { renderVizBundle }) => mod.renderVizBundle(spec, r).desktop;
const trunkWidths = (svg) => [...svg.matchAll(/<path data-role="cartographic-flow-trunk" [^>]*stroke-width="([\d.]+)"/g)].map((m) => +m[1]);
const branchWidths = (svg) => [...svg.matchAll(/<path data-role="cartographic-flow" [^>]*stroke-width="([\d.]+)"/g)].map((m) => +m[1]);

const wFixture = Math.max(...trunkWidths(render()));
assert.ok(wFixture <= 12.01 && wFixture > 11, `fixture: the widest trunk is the 12 px one (${wFixture})`);
const cluster = render(clusterRows);
const clusterTrunks = trunkWidths(cluster);
assert.ok(clusterTrunks.length >= 1, "the cluster fixture draws a trunk");
const wCluster = Math.max(...clusterTrunks);
assert.ok(wCluster <= 12.01 && wCluster > 11, `cluster of 15: the widest trunk is 12, not 18 (${wCluster})`);
// the one scale: the trunk is the sum of its branches' widths (to the 1-decimal rounding of each printed width)
const sum = branchWidths(cluster).reduce((t, w) => t + w, 0);
assert.ok(Math.abs(sum - wCluster) <= 0.05 * branchWidths(cluster).length + 0.1, `trunk ${wCluster} is the sum of its branches ${sum.toFixed(2)}`);
// the cap is not tunable: the renderer reads no env var that names a trunk maximum or width
assert.doesNotMatch(readFileSync(join(ROOT, "runtime/pi/viz.mjs"), "utf8"), /process\.env\.\w*TRUNK\w*(?:MAX|WIDTH|_W)\b/);

// render QA: a trunk wider than 12 px is reported; 12 passes; an SVG with no trunk is not touched
const qa = (svg) => runRenderQa({ desktop: svg });
const withTrunk = (w) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#fff"/><path data-role="cartographic-flow-trunk" data-trunk-members="3" d="M50,100 Q100,100 150,100" fill="none" stroke="#4c647c" stroke-width="${w}"/></svg>`;
const wide = qa(withTrunk("18.0"));
assert.equal(wide.passed, false, "an 18 px trunk fails render QA");
assert.ok(wide.viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), JSON.stringify(wide.viewports.desktop.geometry.failures));
assert.equal(qa(withTrunk("12.0")).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), false, "12 px is allowed");
assert.equal(qa(withTrunk("12.01")).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), false, "rounding of the printed width is allowed");
assert.equal(qa(withTrunk("12.2")).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), true, "12.2 px fails");
assert.equal(qa(render(clusterRows)).viewports.desktop.geometry.failures.some((f) => f.rule === "flow_trunk_too_wide"), false, "the renderer's own 15-branch trunk passes");

// D off: byte-identical to 46c3624 (the default style, circles only, and the trunk fallback with one source each)
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", "46c3624", "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) { console.log("SKIP 46c3624 history unavailable; the byte comparison with it is skipped"); if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") throw new Error("46c3624 history is missing and the run requires none to be skipped"); }
else {
  const dir = mkdtempSync(join(tmpdir(), "trunk-cap-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "b.tar"), archive.stdout);
  assert.equal(spawnSync("tar", ["-xf", join(dir, "b.tar"), "-C", dir]).status, 0);
  const base = await import(pathToFileURL(join(dir, "runtime/pi/viz.mjs")).href);
  for (const env of [{}, { NEWSROOM_FLOW_STYLE_CIRCLES: "1" }, { NEWSROOM_FLOW_STYLE_TRUNK: "true" }, { NEWSROOM_FLOW_STYLE_TRUNK: "0" }]) {
    delete process.env.NEWSROOM_FLOW_STYLE_TRUNK; delete process.env.NEWSROOM_FLOW_STYLE_CIRCLES; Object.assign(process.env, env);
    for (const r of [rows, clusterRows]) assert.equal(render(r), render(r, base), `D off ${JSON.stringify(env)} is byte-identical to 46c3624`);
  }
}
console.log("flow trunk cap: ok", { wFixture, wCluster });
