#!/usr/bin/env node
// NEWSROOM_ZH_ROUTE_DISCLOSURE=1 (exact "1", default off): a negated Chinese route statement is the abstract-OD disclosure the critic asks for.
// Passes: the sentence the remittance page prints, 并非 / 不代表 forms, 路径. Still warns: an affirmative route statement, 关系 alone, no note.
// English is unchanged and off is byte-identical to 1296164 (the critic report for every note below).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from "../runtime/pi/cartography.mjs";
import { critiqueViz } from "../runtime/pi/viz.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rows = Array.from({ length: 15 }, (_, i) => ({ source: `来源${String.fromCharCode(65 + i)}`, target: "德国", source_lat: -40 + ((i * 11) % 90), source_lon: -150 + i * 20, target_lat: 51, target_lon: 10, value: Math.round(1000 / (1 + i)) }));
const spec = { schema_version: "1.0.0", chart_type: "cartographic_flow_map", reader_task: "flow", visual_family: "spatial", data_topology: "geo_edges", language: "zh", title: "德国原油来源", subtitle: "测试数据", unit: "万吨", alt: "德国原油来源的流向弧线，测试数据。", source_note: "测试数据。", note: "弧线表示关系，不是实际路线。", claim_id: "claim-carto-v15", sql: "SELECT 1", value_field: "value", source_field: "source", target_field: "target", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: "none", geometry_semantics: "abstract_od", source_lat_field: "source_lat", source_lon_field: "source_lon", target_lat_field: "target_lat", target_lon_field: "target_lon", flow_map_labels: "ledger", extent_mode: "data", direct_labels: true, annotations: [], highlight_values: [] };
const warns = (note, mod = { critiqueViz }) => mod.critiqueViz({ ...spec, note }, rows, { score: 100, blockers: [], warnings: [] }, "").issues.some((i) => (i.code ?? i.rule) === "od_route_disclosure");
const withSwitch = (value, fn) => { const saved = process.env.NEWSROOM_ZH_ROUTE_DISCLOSURE; if (value === undefined) delete process.env.NEWSROOM_ZH_ROUTE_DISCLOSURE; else process.env.NEWSROOM_ZH_ROUTE_DISCLOSURE = value; try { return fn(); } finally { if (saved === undefined) delete process.env.NEWSROOM_ZH_ROUTE_DISCLOSURE; else process.env.NEWSROOM_ZH_ROUTE_DISCLOSURE = saved; } };

const PASS = ["弧线表示估算的双边侨汇关系，不是实际资金路线。", "弧线并非实际运输路线。", "箭头不代表真实航运路径，只表示来源与去向。", "这些线不是实际路线。", "Arcs show a relationship, not shipping routes."];
const WARN = ["弧线表示估算的双边侨汇关系。", "弧线是实际运输路线。", "这是实际的运输路线，不是估算。", "弧线表示双边关系", "", "不是。路线很长。", "弧线表示数据。不是很多。路径是实际的。", "弧线不是示意而是实际路线。", "弧线不是估算而是真实运输路径。", "不是每条线都是实际路线。", "不等于零的路线很多。", "弧线不是示意路线，而是实际运输路线。", "这些线不是估算路径，而是真实航线。", "弧线不是实际路线，而是更快的捷径路线。"];
withSwitch("1", () => {
  for (const n of PASS) assert.equal(warns(n), false, `on: ${n} counts as the disclosure`);
  for (const n of WARN) assert.equal(warns(n), true, `on: ${JSON.stringify(n)} still warns`);
});
// off (and every near miss): only the English words count, as before
for (const v of [undefined, "0", "true", "yes", "", " 1", "11"]) withSwitch(v, () => {
  assert.equal(warns(PASS[0]), true, `switch ${JSON.stringify(v)}: the Chinese sentence still warns`);
  assert.equal(warns(PASS[4]), false, "English unchanged");
});
// off: the whole critic report is byte-identical to 1296164
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", "17740c7", "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) { console.log("SKIP 1296164 history unavailable; the byte comparison is skipped"); if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") throw new Error("1296164 history is missing and the run requires none to be skipped"); }
else {
  const dir = mkdtempSync(join(tmpdir(), "zh-route-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "b.tar"), archive.stdout);
  assert.equal(spawnSync("tar", ["-xf", join(dir, "b.tar"), "-C", dir]).status, 0);
  const base = await import(pathToFileURL(join(dir, "runtime/pi/viz.mjs")).href);
  const report = (m, note) => JSON.stringify(m.critiqueViz({ ...spec, note }, rows, { score: 100, blockers: [], warnings: [] }, ""));
  for (const n of [...PASS, ...WARN]) withSwitch(undefined, () => assert.equal(report({ critiqueViz }, n), report(base, n), `off: ${JSON.stringify(n)} identical to 1296164`));
}
console.log("zh route disclosure: ok");
