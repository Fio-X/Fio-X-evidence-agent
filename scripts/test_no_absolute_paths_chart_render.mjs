// #198, the real viz_plan -> viz_lint -> viz_render path (needs duckdb; newsroom_chart is retired and registered in no profile, so it cannot be driven): under a long and a short run root the text shows run-relative paths,
// the details still carry what the code needs, and the files exist where the text says.
// Run: node scripts/test_no_absolute_paths_chart_render.mjs
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
if (probe.error?.code === "ENOENT") { console.log("duckdb binary not found; skipping the chart render path checks"); process.exit(0); }

const dir = makeTestTmp("paths-chart-render-");
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

// TEST FIXTURE (hand-written numbers, not real data)
const CSV = ["country,year,part,whole", "Chad,2022,70.0,100", "Guinea,2022,66.6,100", "Liberia,2022,92.8,100", "Niger,2021,79.6,100", "Nigeria,2021,80.3,100", "Zambia,2021,83.0,100", "Atlantis,2022,50.0,100"].join("\n") + "\n";
const SQL = "SELECT country, year, part * 100.0 / whole AS share FROM 'data/africa.csv' WHERE country <> 'Atlantis' ORDER BY country";
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin0_50m");
const planParams = (claim_id) => ({
  reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries.",
  takeaway: "Several African countries differ widely in renewable share.", source_note: "fixture", sql: SQL, unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share",
  category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "explicit",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [], claim_id,
});
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const ABSOLUTE = /(?:\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/;

async function drive(label, rootParts) {
  const art = join(makeTestTmp(`paths-chart-${label}-`), ...rootParts, "run");
  for (const d of ["visualizations", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
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
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "claim-1", status: "verified", source_refs: ["data/africa.csv"], computation_refs: [rel], verification })}\n`);
  const plan = await tools.get("newsroom_viz_plan").execute("p", planParams("claim-1"));
  const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
  const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  return { art, text: render.content.map((c) => c.text ?? "").join("\n") };
}

const long = ["a-deliberately-long-project-directory-name-for-this-check", "another-long-folder-below-it"];
for (const [label, parts] of [["long", long], ["short", []]]) {
  const { art, text } = await drive(label, parts);
  assert.ok(!ABSOLUTE.test(text) && !text.includes(art), `${label}: the chart text shows no absolute path: ${text.slice(0, 300)}`);
  const svg = /^Desktop SVG: (.+)$/m.exec(text)?.[1], manifest = /^Manifest: (.+)$/m.exec(text)?.[1];
  assert.match(svg ?? "", /^visualizations\/.+\.svg$/, `${label}: Desktop SVG line is run-relative`);
  assert.match(manifest ?? "", /^visualizations\/.+\.json$/, `${label}: Manifest line is run-relative`);
  assert.ok(existsSync(join(art, svg)) && existsSync(join(art, manifest)), `${label}: the files are where the text says`);
}
console.log("test_no_absolute_paths_chart_render: SVG and Manifest lines are run-relative under a long and a short root -- PASS");
