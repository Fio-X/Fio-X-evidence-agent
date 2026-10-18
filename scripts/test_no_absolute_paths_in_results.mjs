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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
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
const { runInStagedCall } = await import(join(pi, "groups.mjs"));

const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin0_50m");
const CSV = "country,share\nChad,70.0\nNiger,79.6\n";
const SQL = "SELECT country, share FROM 'data/a.csv' ORDER BY country";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const ABSOLUTE = /(?:\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)/;

async function drive(label, rootParts) {
  const art = join(makeTestTmp(`no-abs-${label}-`), ...rootParts, "run");
  for (const d of ["data", "computations", "searches", "visualizations/plans"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "data", "a.csv"), CSV);
  writeFileSync(join(art, "data", "a.meta.json"), JSON.stringify({ file: "a.csv", sha256: createHash("sha256").update(CSV).digest("hex") }));
  writeFileSync(join(art, "data", "b.json"), JSON.stringify([{ country: "Chad", share: 70 }]));
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
  const claimResult = await run("record_claim", { claim: "Chad share is 70.0.", claim_kind: "descriptive", status: "supported", source_refs: ["data/a.csv"], computation_refs: [rel] });
  // The DuckDB error the archives showed: a binder error whose LINE text is cut in the middle of the root.
  await run("newsroom_viz_plan", { reader_task: "spatial", title: "Share by country", alt: "A choropleth of share across several African countries.", takeaway: "Several countries differ in share.", source_note: "x", unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share", claim_id: /claim_id: (\S+)/.exec(claimResult.content[0].text)[1],
    category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "explicit", basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [],
    sql: `SELECT r.country AS country, r.share * 100.0 / r.whole AS share FROM (SELECT unnest(rows) AS r FROM read_json('${join(art, "data", "b.json")}'))` });
  // The line DuckDB cuts in the middle of the root (the archives showed it on viz_plan and duckdb_query alike).
  await run("duckdb_query", { sql: `SELECT '${join(art, "data", "b.json")}' AS p, a.nosuchcolumn FROM 'data/a.csv' a` });
  await run("newsroom_infographic_preview", { manifest_ref: "infographics/missing.json", critic_ref: "infographics/critics/missing.json" });
  assert.ok(plan.details.path.startsWith(art), "what a write returns for the code is still the real path");
  // K1009b: text that only looks like the start of the root stays as it is (built from this root's own first segment, so it holds for /Users, /private and /var roots alike)
  const segs = art.split("/").slice(1);
  const lookalikes = [`https://x.org/${segs[0]}-sector/data.csv`, `/${segs[0].slice(0, 3)}ces.csv`, `/${segs[0]}ish.csv`, `/${segs[0]}/${segs[1] ?? "x"}ish/y.csv`, `...${art.slice(-8)}x/y.csv`];
  const bad = (text) => `SELECT a.nosuchcolumn, '${text}' AS u FROM 'data/a.csv' a`;
  const messageOf = async (sql, wrap = (f) => f()) => { try { await wrap(() => tools.get("duckdb_query").execute("lk", { sql })); } catch (error) { return String(error.message); } return assert.fail("the query was expected to fail"); };
  const kept = [];
  for (const text of lookalikes) kept.push({ text, message: await messageOf(bad(text)) });
  // a file:// spelling of a leading piece of the root (the slash before it is part of "://", not of a longer path) is still scrubbed
  const fileForm = `file://${join("/", ...segs.slice(0, Math.max(2, segs.length - 2)))}/other/x.csv`;
  const fileText = await messageOf(`SELECT * FROM '${fileForm}'`);
  if (process.env.SHOW) console.log("FILEFORM", fileText);
  // the second root: the staging folder of a call. A long one, so DuckDB cuts the line inside it.
  // it must not share two leading segments with the run root, or the root-prefix rule would hide a missing second root; it is never created (DuckDB refuses before touching it)
  const stagingDir = join(homedir(), ".staging-folder-for-the-second-root-check", "and-a-deeper-one-below-it", "last");
  const staged = await messageOf(`SELECT * FROM '${join(stagingDir, "missing.csv")}'`, (f) => runInStagedCall("c-1", stagingDir, f));
  return { art, seen, kept, staged, stagingDir, fileText, fileForm };
}

const long = ["a-deliberately-long-project-directory-name-for-this-check", "another-long-folder-below-it", "and-one-more-so-a-line-cut-lands-inside-the-root"];
for (const [label, parts] of [["long", long], ["short", []]]) {
  const { art, seen, kept, staged, stagingDir, fileText, fileForm } = await drive(label, parts);
  assert.ok(!fileText.includes(fileForm.slice("file://".length)), `${label}: the file:// spelling of the root prefix is scrubbed: ${fileText.slice(0, 300)}`);
  for (const { text, message } of kept) assert.ok(message.includes(text), `${label}: "${text}" was rewritten: ${message.slice(0, 300)}`);
  assert.ok(!staged.includes(stagingDir) && staged.includes("$ARTIFACT"), `${label}: the staging folder is not shown: ${staged.slice(0, 300)}`);
  for (let k = 1; k < stagingDir.length - 12; k += 1) assert.ok(!staged.includes(stagingDir.slice(k)), `${label}: the tail of the staging folder is shown`);
  if (process.env.SHOW) for (const { tool, text } of seen) console.log(label, tool, "|", text.replace(/\s+/g, " ").slice(0, 200));
  assert.ok(seen.length >= 5, `${label}: the five tools all produced a visible text (got ${seen.length})`);
  for (const { tool, text } of seen) {
    assert.ok(!ABSOLUTE.test(text), `${label}: ${tool} shows an absolute path`);
    // the tail of the root, as a DuckDB line cut at its head leaves it
    for (let k = 1; k < art.length - 12; k += 1) assert.ok(!text.includes(art.slice(k)), `${label}: ${tool} shows the tail of the root`);
    for (let n = 4; n <= art.length; n += 1) for (const start of [0, 1]) {
      const piece = art.slice(start, start + n);
      if (piece.startsWith("/") && piece.length >= 4) assert.ok(!text.includes(piece), `${label}: ${tool} shows ${piece.length} characters of the root`);
    }
  }
}
// download_data and the search tool need the network, so their two fix sites are held by the source: the text they build never interpolates the value a write returned.
const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8").split("\n");
for (const [index, line] of source.entries()) {
  if (/textResult\(/.test(line) || /^\s*(artifact|artifact_ref): path\b/.test(line)) assert.ok(!/\$\{(path|metadataPath|originPath|svgPath|manifestPath)\}|\b(artifact|artifact_ref): path\b/.test(line), `newsroom.ts:${index + 1} puts a write's absolute path in text the model sees`);
}
// The siblings: fetch_url's envelope, the Lieflat render, and the two publication renders. A returned full path must not reach their text; the two renders show refs that are run-relative by construction.
const joined = source.join("\n");
assert.ok(/snapshot_ref: runRelative\(path, /.test(joined), "fetch_url shows snapshot_ref run-relative");
assert.ok(!/snapshot_ref: path\b/.test(joined), "fetch_url no longer shows the written path");
assert.ok(/primary: \$\{runRelativeTo\(root, primaryPath\)\}/.test(joined), "lieflat primary is run-relative");
assert.ok(!/\$\{(primaryPath|result\.(report_path|file_path|manifest_path|html_path))\}/.test(joined), "lieflat text never interpolates a full path");
assert.equal((joined.match(/const htmlRef = `publications\/\$\{key\}\/index\.html`;/g) ?? []).length, 2, "both publication renders build htmlRef inside the run");
assert.equal((joined.match(/const manifestRef = `publications\/\$\{key\}\/manifest\.json`;/g) ?? []).length, 2, "both publication renders build manifestRef inside the run");
for (const [index, line] of source.entries()) {
  if (/Rendered (portable evidence-bound composite|trusted browser) publication/.test(line)) assert.ok(/HTML: \$\{htmlRef\}/.test(line) && /Manifest: \$\{manifestRef\}/.test(line), `newsroom.ts:${index + 1} shows the publication refs, not a resolved path`);
}
console.log("test_no_absolute_paths_in_results: no model-visible result shows the run root -- PASS");
