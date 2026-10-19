// symbol_map through the real plan tool: an omitted visual_family is stored as spatial and the lint lets it through (the inline default map once lacked symbol_map).
// TEST FIXTURE data. Run: node scripts/test_symbol_map_plan_family.mjs

import "./group_env_pin.mjs";
process.env.NEWSROOM_SYMBOL_MAP = "1"; // read when viz.mjs loads (its name-field table), so set before the runtime is imported
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
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin0_50m");

const dir = makeTestTmp("symbol-map-family-");
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

// TEST FIXTURE (hand-written numbers, not real data): a symbol_map of totals, rendered through the real tools.
const CSV = ["country,year,part,whole", "Chad,2022,70.0,100", "Guinea,2022,66.6,100", "Liberia,2022,92.8,100", "Niger,2021,79.6,100", "Nigeria,2021,80.3,100", "Zambia,2021,83.0,100", "Atlantis,2022,50.0,100"].join("\n") + "\n";
const SQL = "SELECT country, year, part AS total FROM 'data/africa.csv' WHERE country <> 'Atlantis' ORDER BY country";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const planParams = (claim_id) => ({
  reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries.",
  takeaway: "Several African countries differ widely in renewable share.", source_note: "fixture", sql: SQL, unit: "GWh", chart_type: "symbol_map", category_field: "country", value_field: "total",
  category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "explicit",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [], claim_id,
});


const art = join(makeTestTmp("symbol-map-family-run-"), "run");
for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
writeFileSync(join(art, "data", "africa.csv"), CSV);
writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256: "a".repeat(64) }));
writeFileSync(join(art, "claims.jsonl"), "");
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1";
delete process.env.NEWSROOM_PHASE;
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const query = await tools.get("duckdb_query").execute("q", { sql: SQL });
const rel = query.details.path.startsWith("/") ? relative(art, query.details.path) : query.details.path;
writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "claim-fam", status: "verified", source_refs: ["data/africa.csv"], computation_refs: [rel], verification })}\n`);
const params = planParams("claim-fam");
assert.ok(!("visual_family" in params), "the plan params leave visual_family out");
const plan = await tools.get("newsroom_viz_plan").execute("p", params);
const stored = JSON.parse(readFileSync(join(art, plan.details.planRef), "utf8"));
assert.equal(stored.visual_family ?? stored.spec?.visual_family, "spatial", "an omitted visual_family is stored as spatial for symbol_map");
const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
assert.ok(lint.details.lintRef, "the lint lets the symbol_map plan through");
console.log("symbol_map plan family checks passed");
