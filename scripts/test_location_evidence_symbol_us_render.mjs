// K1017: a US-state symbol_map through the real viz tools (needs duckdb), TEST FIXTURE numbers: us_state names join to the state basemap, the evidence is written and checks out, the page-level proof accepts it.
// Run: node scripts/test_location_evidence_symbol_us_render.mjs
// Run: node scripts/test_location_evidence_symbol_render.mjs
import "./group_env_pin.mjs";
process.env.NEWSROOM_SYMBOL_MAP = "1"; process.env.NEWSROOM_US_STATES = "1"; // read when viz.mjs loads (its name-field table), so set before the runtime is imported
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const probe = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" });
if (probe.error?.code === "ENOENT") { console.log("duckdb binary not found; skipping the location evidence render checks"); process.exit(0); }
const le = await import(join(ROOT, "runtime/pi/location_evidence.mjs"));
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin1_us_110m");

const dir = makeTestTmp("location-evidence-render-");
const stub = (name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(dir, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));

// TEST FIXTURE (hand-written numbers, not real data): deaths per state, rendered through the real tools. Alaska and Hawaii stand for the inset boxes.
const CSV = ["state_name,year,deaths", "California,2022,1000", "Texas,2022,800", "New York,2022,600", "Florida,2022,700", "Alaska,2022,40", "Hawaii,2022,60", "District of Columbia,2022,30", "Puerto Rico,2022,90"].join("\n") + "\n";
const SQL = "SELECT state_name, year, deaths AS total FROM 'data/us.csv' WHERE state_name <> 'Puerto Rico' ORDER BY state_name";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const planParams = (claim_id) => ({
  reader_task: "spatial", title: "Deaths by state", alt: "A symbol map of fixture death counts in several US states.",
  takeaway: "Fixture counts differ widely between states.", source_note: "fixture", sql: SQL, unit: "deaths", chart_type: "symbol_map", category_field: "state_name", value_field: "total",
  category_names: "us_state", reference_period_field: "year", mixed_period_strategy: "explicit",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [], claim_id,
});

async function renderOnce(switchValue) {
  const art = join(makeTestTmp("location-evidence-run-"), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "data", "us.csv"), CSV);
  writeFileSync(join(art, "data", "us.meta.json"), JSON.stringify({ file: "us.csv", sha256: "a".repeat(64) }));
  writeFileSync(join(art, "claims.jsonl"), "");
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1"; // as test_viz_chain_runtime registers the tools: one computation is one file whichever tool ran first
  delete process.env.NEWSROOM_PHASE;
  if (switchValue === undefined) delete process.env.NEWSROOM_LOCATION_EVIDENCE; else process.env.NEWSROOM_LOCATION_EVIDENCE = switchValue;
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const query = await tools.get("duckdb_query").execute("q", { sql: SQL });
  const rel = query.details.path.startsWith("/") ? relative(art, query.details.path) : query.details.path;
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "claim-loc", status: "verified", source_refs: ["data/us.csv"], computation_refs: [rel], verification })}\n`);
  const plan = await tools.get("newsroom_viz_plan").execute("p", planParams("claim-loc"));
  const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
  const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  const manifest = JSON.parse(readFileSync(join(art, render.details.manifestRef), "utf8"));
  return { art, manifest, manifestRef: render.details.manifestRef };
}

const off = await renderOnce("0"); // exactly 0 is the only value that turns it off
assert.ok(!existsSync(join(off.art, "visualizations", "locations")), "off: no locations folder is written");
assert.ok(!("location_evidence_ref" in off.manifest) && !("location_evidence_sha256" in off.manifest), "off: the manifest has no evidence fields");

const on = await renderOnce("1");
const key = on.manifestRef.replace(/^visualizations\//, "").replace(/\.json$/, "");
assert.equal(on.manifest.location_evidence_ref, le.locationEvidenceRef(key), "on: the manifest names the evidence by ref");
const text = readFileSync(join(on.art, on.manifest.location_evidence_ref), "utf8");
assert.ok(le.checkLocationEvidence(on.manifest, text).ok, "on: the file checks out against the manifest");
const evidence = JSON.parse(text);
assert.equal(evidence.rows.length, 7);
assert.equal(evidence.basemap_id, "naturalearth_admin1_us_110m");
assert.deepEqual(evidence.rows.map((r) => r.raw), ["Alaska", "California", "District of Columbia", "Florida", "Hawaii", "New York", "Texas"], "rows follow the SQL order");
assert.deepEqual(evidence.rows.map((r) => r.iso3), ["US-AK", "US-CA", "US-DC", "US-FL", "US-HI", "US-NY", "US-TX"], "each state name resolves to its own state");
const { locationProofFor } = await import(join(ROOT, "runtime/pi/location_proof.mjs"));
assert.equal(locationProofFor([{ id: "m1", type: "visual" }], { m1: { chart_type: "symbol_map", ok: le.checkLocationEvidence(on.manifest, text).ok } }), true, "the page-level proof accepts the state symbol map's evidence");
const svgText = readFileSync(join(on.art, on.manifest.svg ?? on.manifest.desktop_svg ?? on.manifest.svg_ref ?? ""), "utf8");
assert.equal((svgText.match(/data-role="symbol-circle"/g) ?? []).length, 7, "seven circles, one per state row");
assert.match(svgText, /data-role="symbol-map-us-box"/, "Alaska and Hawaii are drawn in their boxes");
assert.equal(evidence.join_status, "all_matched");
assert.equal(evidence.basemap_content_hash, basemap.content_hash);

// everything else in the manifest is what the switch-off run wrote
const strip = ({ location_evidence_ref, location_evidence_sha256, ...rest }) => rest;
const normal = (m) => JSON.stringify(strip(m), (k, v) => (/_ref$|^svg$|^key$|created_at|sha256|^path$|^plan_ref$/.test(k) ? undefined : v));
assert.equal(normal(on.manifest), normal(off.manifest), "on: apart from the two fields (and run-specific paths and hashes) the manifest is the same");

for (const value of [undefined, "true", "", "false", "off"]) {
  const other = await renderOnce(value);
  assert.ok(existsSync(join(other.art, "visualizations", "locations")) && other.manifest.location_evidence_ref, `${JSON.stringify(value)} leaves it on: only an exact 0 turns it off`);
}
delete process.env.NEWSROOM_LOCATION_EVIDENCE;
console.log("test_location_evidence_symbol_us_render: on (unset or any value but 0) writes and records the evidence, exactly 0 writes nothing -- PASS");
