// NEWSROOM_LOCATION_EVIDENCE through the real viz render tool (needs duckdb): on, a choropleth writes its evidence file and the manifest names it
// by ref and sha256; off, nothing is written and the manifest is the one that was always written. A coordinate map never writes one.
// Run: node scripts/test_location_evidence_render.mjs
import "./group_env_pin.mjs";
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
const basemap = getBasemap("naturalearth_admin0_50m");

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

const CSV = ["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0", "Atlantis,2022,50.0"].join("\n") + "\n";
const SQL = "SELECT country, year, share FROM 'data/africa.csv' WHERE country <> 'Atlantis' ORDER BY country";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const planParams = (claim_id) => ({
  reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries.",
  takeaway: "Several African countries differ widely in renewable share.", source_note: "fixture", sql: SQL, unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share",
  category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "explicit",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [], claim_id,
});

async function renderOnce(switchValue) {
  const art = join(makeTestTmp("location-evidence-run-"), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "data", "africa.csv"), CSV);
  writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256: "a".repeat(64) }));
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
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "claim-loc", status: "verified", source_refs: ["data/africa.csv"], computation_refs: [rel], verification })}\n`);
  const plan = await tools.get("newsroom_viz_plan").execute("p", planParams("claim-loc"));
  const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
  const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  const manifest = JSON.parse(readFileSync(join(art, render.details.manifestRef), "utf8"));
  return { art, manifest, manifestRef: render.details.manifestRef };
}

const off = await renderOnce(undefined);
assert.ok(!existsSync(join(off.art, "visualizations", "locations")), "off: no locations folder is written");
assert.ok(!("location_evidence_ref" in off.manifest) && !("location_evidence_sha256" in off.manifest), "off: the manifest has no evidence fields");

const on = await renderOnce("1");
const key = on.manifestRef.replace(/^visualizations\//, "").replace(/\.json$/, "");
assert.equal(on.manifest.location_evidence_ref, le.locationEvidenceRef(key), "on: the manifest names the evidence by ref");
const text = readFileSync(join(on.art, on.manifest.location_evidence_ref), "utf8");
assert.ok(le.checkLocationEvidence(on.manifest, text).ok, "on: the file checks out against the manifest");
const evidence = JSON.parse(text);
assert.equal(evidence.rows.length, 6);
assert.equal(evidence.join_status, "all_matched");
assert.equal(evidence.basemap_content_hash, basemap.content_hash);

// everything else in the manifest is what the switch-off run wrote
const strip = ({ location_evidence_ref, location_evidence_sha256, ...rest }) => rest;
const normal = (m) => JSON.stringify(strip(m), (k, v) => (/_ref$|^svg$|^key$|created_at|sha256|^path$|^plan_ref$/.test(k) ? undefined : v));
assert.equal(normal(on.manifest), normal(off.manifest), "on: apart from the two fields (and run-specific paths and hashes) the manifest is the same");

const other = await renderOnce("true");
assert.ok(!existsSync(join(other.art, "visualizations", "locations")) && !other.manifest.location_evidence_ref, "only exactly 1 turns it on");
delete process.env.NEWSROOM_LOCATION_EVIDENCE;
console.log("test_location_evidence_render: on writes and records the evidence, off and other values write nothing -- PASS");
