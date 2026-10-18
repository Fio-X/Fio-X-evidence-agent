// #198: no model-visible tool result or error shows where the run is on this machine. The tools the five replay archives showed leaking (update_plan, record_claim,
// duckdb_query, the viz_plan DuckDB error, a preview whose file is missing) run with a deliberately long and a deliberately short artifact root; any absolute path, or any
// piece of the root (four characters or more, as a DuckDB line cut leaves it), in a result or an error fails the test. What a write returns for the code stays absolute.
// Run: node scripts/test_no_absolute_paths_in_results.mjs
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const probe = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" });
if (probe.error?.code === "ENOENT") { console.log("duckdb binary not found; skipping the absolute path checks"); process.exit(0); }

const dir = makeTestTmp("no-abs-paths-");
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

const CSV = "country,share\nChad,70.0\nNiger,79.6\n";
const SQL = "SELECT country, share FROM 'data/a.csv' ORDER BY country";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const ABSOLUTE = /(?:\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/;

async function drive(label, rootParts) {
  const art = join(makeTestTmp(`no-abs-${label}-`), ...rootParts, "run");
  for (const d of ["data", "computations", "searches", "visualizations/plans"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "data", "a.csv"), CSV);
  writeFileSync(join(art, "data", "a.meta.json"), JSON.stringify({ file: "a.csv", sha256: "a".repeat(64) }));
  writeFileSync(join(art, "claims.jsonl"), "");
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1";
  delete process.env.NEWSROOM_PHASE;
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const seen = [];
  const note = (tool, text) => seen.push({ tool, text: String(text) });
  const run = async (name, params) => {
    try { const result = await tools.get(name).execute(`id-${name}`, params); for (const block of result.content ?? []) if (block.type === "text") note(name, block.text); return result; }
    catch (error) { note(`${name} (error)`, error?.message); return null; }
  };
  const plan = await run("newsroom_update_plan", { goal: "g", steps: [{ id: "s1", title: "t", status: "pending" }] });
  const query = await run("duckdb_query", { sql: SQL });
  const rel = query.details.path.startsWith("/") ? query.details.path.slice(art.length + 1) : query.details.path;
  writeFileSync(join(art, "claims.jsonl"), "");
  await run("record_claim", { claim: "Chad share is 70.0.", claim_kind: "descriptive", status: "supported", source_refs: ["data/a.csv"], computation_refs: [rel] });
  // The DuckDB error the archives showed: a binder error whose LINE text is cut in the middle of the root.
  await run("newsroom_viz_plan", { reader_task: "spatial", title: "t", alt: "a chart of shares across countries", takeaway: "t", source_note: "x", unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share", claim_id: "none",
    sql: `SELECT r.country AS country, r.share AS share FROM (SELECT unnest(rows) AS r FROM read_json('${join(art, rel)}'))` });
  await run("newsroom_infographic_preview", { manifest_ref: "infographics/missing.json", critic_ref: "infographics/critics/missing.json" });
  assert.ok(plan.details.path.startsWith(art), "what a write returns for the code is still the real path");
  return { art, seen };
}

const long = ["a-deliberately-long-project-directory-name-for-this-check", "another-long-folder-below-it", "and-one-more-so-a-line-cut-lands-inside-the-root"];
for (const [label, parts] of [["long", long], ["short", []]]) {
  const { art, seen } = await drive(label, parts);
  assert.ok(seen.length >= 5, `${label}: the five tools all produced a visible text (got ${seen.length})`);
  for (const { tool, text } of seen) {
    assert.ok(!ABSOLUTE.test(text), `${label}: ${tool} shows an absolute path`);
    for (let n = 4; n <= art.length; n += 1) for (const start of [0, 1]) {
      const piece = art.slice(start, start + n);
      if (piece.startsWith("/") && piece.length >= 4) assert.ok(!text.includes(piece), `${label}: ${tool} shows ${piece.length} characters of the root`);
    }
  }
}
// download_data and the search tool need the network, so their two fix sites are held by the source: the text they build never interpolates the value a write returned.
const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8").split("\n");
for (const [index, line] of source.entries()) {
  if (/textResult\(/.test(line) || /^\s*(artifact|artifact_ref): path\b/.test(line)) assert.ok(!/\$\{(path|metadataPath|originPath)\}|\b(artifact|artifact_ref): path\b/.test(line), `newsroom.ts:${index + 1} puts a write's absolute path in text the model sees`);
}
console.log("test_no_absolute_paths_in_results: no model-visible result shows the run root -- PASS");
