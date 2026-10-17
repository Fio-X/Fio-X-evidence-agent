#!/usr/bin/env node
// The whole run folder is watched on every runDeclared call (runtime/pi/groups.mjs). This test starts each real Python child that the program runs in a run folder
// (rasterize_svg.py, networkx_analyze.py, networkx_reduce.py, scientific_basemap_prepare.py) and the real duckdb child, through runDeclared and runProcess, exactly as
// newsroom.ts does: python3 / duckdb found on PATH, the run folder as working folder, the script copied into <run>/runtime/, a made-up request written first.
// For every child: the call is not refused, runtime/boundary-refusals.jsonl has no row, the files before and after differ only by the declared outputs, and no
// .group-restore-* copy folder is left. Needs the packages CI installs (CairoSVG, networkx, scipy, matplotlib + basemap, duckdb); on a machine without them the test
// fails at the first child that needs one, like the existing raster and network tests. No provider, no network, synthetic run folders only.
// group_env_pin.mjs keeps NEWSROOM_GROUP_CALL_REPORT and NEWSROOM_GROUP_CALL_REFUSE at 0, so the call-report and refuse-all paths are not covered here.
import "./group_env_pin.mjs";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("group-real-children-");
const results = [];
const check = (name) => results.push(name);

// the program's own environment for a child; the test's environment must not do the work of PYTHONDONTWRITEBYTECODE (runProcess sets it)
delete process.env.PYTHONDONTWRITEBYTECODE;
Object.assign(process.env, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1" });
// a child's home, caches and temp files are somewhere else, never inside a run folder
const away = (name) => { const dir = join(scratch, `away-${name}`); mkdirSync(dir, { recursive: true }); return dir; };
Object.assign(process.env, { HOME: away("home"), XDG_CACHE_HOME: away("cache"), XDG_CONFIG_HOME: away("config"), MPLCONFIGDIR: away("mpl"), TMPDIR: away("tmp") });

const g = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const { runProcess } = await import(pathToFileURL(join(ROOT, "runtime/pi/process.mjs")).href);

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const walk = (dir, prefix = "") => readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
  const name = prefix ? `${prefix}/${entry.name}` : entry.name;
  return entry.isDirectory() ? walk(dir, name) : [name];
});
let seq = 0;
/** A synthetic run folder with the given scripts copied into runtime/, as the program does. */
const newRun = (scripts) => {
  const dir = join(scratch, `run-${++seq}`);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  for (const script of scripts) cpSync(join(ROOT, "runtime/pi", script), join(dir, "runtime", script));
  return dir;
};
const writeJson = (dir, ref, value) => { mkdirSync(join(dir, ref, ".."), { recursive: true }); writeFileSync(join(dir, ref), `${JSON.stringify(value)}\n`); };

/** Run one child the way newsroom.ts does and report what the guard saw. */
async function runChild({ tool, dir, declared, bin = "python3", args, stdoutLimit = 2_000_000, timeoutMs = 120_000 }) {
  const before = walk(dir).sort();
  let result = null, refusal = null;
  try {
    result = await g.runInTool(tool, () => g.runDeclared(dir, declared, () => runProcess(bin, args, undefined, dir, undefined, stdoutLimit, timeoutMs, true)));
  } catch (error) { refusal = error; }
  return { before, after: walk(dir).sort(), result, refusal };
}
/** Not refused, no row, only the declared outputs are new (or, when `missingOk`, a subset of them), nothing removed, no copy folder left. */
function assertQuiet(label, dir, declared, c, { missingOk = false } = {}) {
  assert.equal(c.refusal, null, `${label}: the call must not be refused (${c.refusal?.message ?? ""})`);
  const rows = existsSync(join(dir, "runtime/boundary-refusals.jsonl")) ? readFileSync(join(dir, "runtime/boundary-refusals.jsonl"), "utf8").split("\n").filter(Boolean) : [];
  assert.equal(rows.length, 0, `${label}: no row in runtime/boundary-refusals.jsonl (${rows.length})`);
  const added = c.after.filter((f) => !c.before.includes(f)).sort();
  const removed = c.before.filter((f) => !c.after.includes(f));
  assert.deepEqual(removed, [], `${label}: nothing removed`);
  if (missingOk) assert.ok(added.every((f) => declared.includes(f)), `${label}: only declared outputs are new (got ${JSON.stringify(added)})`);
  else assert.deepEqual(added, [...declared].sort(), `${label}: the declared outputs are the only new files`);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".group-restore-")), [], `${label}: no copy folder left`);
  assert.ok(!c.after.some((f) => f.split("/").includes("__pycache__")), `${label}: no bytecode cache`);
}

// 1. rasterize_svg.py, cairosvg path (a page without CJK text): the PNG goes to runtime/preview-tmp/ (declared, the program's temp folder)
{
  const dir = newRun(["rasterize_svg.py", "browser_qa.py"]);
  const svg = "infographics/real-child.svg";
  mkdirSync(join(dir, "infographics"), { recursive: true });
  writeFileSync(join(dir, svg), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><rect width="400" height="200" fill="#eef"/><circle cx="120" cy="100" r="60" fill="#369"/><text x="220" y="110" font-size="24">Made-up page</text></svg>\n');
  const temp = `runtime/preview-tmp/${sha("real-child-1").slice(0, 24)}.png`;
  const c = await runChild({ tool: "newsroom_infographic_preview", dir, declared: [temp], args: [join(dir, "runtime/rasterize_svg.py"), join(dir, svg), join(dir, temp), "--width", "400"], stdoutLimit: 2_000_000, timeoutMs: 30_000 });
  assertQuiet("rasterize_svg.py (cairosvg)", dir, [temp], c);
  assert.equal(c.result.code, 0, `the rasterizer exits 0 (${c.result.stderr.slice(0, 300)})`);
  assert.equal(JSON.parse(c.result.stdout.trim().split("\n").pop()).engine, "cairosvg");
  assert.equal(readFileSync(join(dir, temp)).subarray(1, 4).toString("ascii"), "PNG");
  check("1 rasterize_svg.py (cairosvg path) through runDeclared: PNG written, not refused, no row, only the declared file is new, no copy folder, no __pycache__");
}

// 2. rasterize_svg.py, CJK path: it imports the sibling browser_qa.py from <run>/runtime/ (which is where a bytecode cache would be written) before it needs Chrome.
//    Where Chrome is missing it stops with its own message (and writes no PNG), where Chrome is there it renders the PNG; either way the guard must see nothing but the declared file.
{
  const dir = newRun(["rasterize_svg.py", "browser_qa.py"]);
  const svg = "infographics/real-child-cjk.svg";
  mkdirSync(join(dir, "infographics"), { recursive: true });
  writeFileSync(join(dir, svg), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><rect width="400" height="200" fill="#eef"/><text x="40" y="110" font-size="24">中文标题</text></svg>\n');
  const temp = `runtime/preview-tmp/${sha("real-child-2").slice(0, 24)}.png`;
  const c = await runChild({ tool: "newsroom_infographic_preview", dir, declared: [temp], args: [join(dir, "runtime/rasterize_svg.py"), join(dir, svg), join(dir, temp), "--width", "400"], timeoutMs: 90_000 });
  assertQuiet("rasterize_svg.py (CJK path, imports browser_qa)", dir, [temp], c, { missingOk: true });
  if (c.result.code === 0) assert.equal(readFileSync(join(dir, temp)).subarray(1, 4).toString("ascii"), "PNG");
  else {
    assert.match(c.result.stderr, /preview needs Chrome for [^\n]*: (playwright_dependency_unavailable|chromium_executable_unavailable)/, `it stops only with its own Chrome-missing message (${c.result.stderr.slice(0, 300)})`);
    assert.ok(!existsSync(join(dir, temp)), "no PNG when it stops");
  }
  check("2 rasterize_svg.py (CJK path, imports browser_qa from <run>/runtime/) through runDeclared: not refused, no row, no __pycache__, no copy folder, nothing new but the declared PNG");
}

// 3. networkx_analyze.py
{
  const dir = newRun(["networkx_analyze.py"]);
  const request = {
    directed: false, multigraph: false, seed: 7, community: true, layout: { name: "spring" },
    nodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, label: id.toUpperCase() })),
    edges: [["a", "b"], ["b", "c"], ["a", "c"], ["d", "e"], ["e", "f"], ["d", "f"], ["c", "d"]].map(([source, target]) => ({ source, target, weight: 1 })),
  };
  const key = sha(request);
  writeJson(dir, `visualizations/graph-analysis/requests/${key}.json`, request);
  const out = `visualizations/graph-analysis/${key}.json`;
  const c = await runChild({ tool: "newsroom_network_analyze", dir, declared: [out], args: [join(dir, "runtime/networkx_analyze.py"), "--request", join(dir, `visualizations/graph-analysis/requests/${key}.json`), "--output", join(dir, out)] });
  assertQuiet("networkx_analyze.py", dir, [out], c);
  assert.equal(c.result.code, 0, `exit 0 (${c.result.stderr.slice(0, 300)})`);
  const analysis = JSON.parse(readFileSync(join(dir, out), "utf8"));
  assert.equal(analysis.engine, "networkx"); assert.equal(analysis.summary.node_count, 6); assert.equal(analysis.summary.edge_count, 7);
  check("3 networkx_analyze.py through runDeclared: analysis written, not refused, no row, only the declared file is new, no copy folder, no __pycache__");
}

// 4. networkx_reduce.py
{
  const dir = newRun(["networkx_reduce.py"]);
  const request = {
    directed: false, seed: 7, max_meta_edges: 20,
    nodes: ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({ id, label: id })),
    edges: [["a1", "a2"], ["a2", "a3"], ["a1", "a3"], ["b1", "b2"], ["b2", "b3"], ["b1", "b3"], ["a3", "b1"]].map(([source, target]) => ({ source, target, weight: 1 })),
  };
  const key = sha(request);
  writeJson(dir, `visualizations/graph-reduction/requests/${key}.json`, request);
  const out = `visualizations/graph-reduction/${key}.json`;
  const c = await runChild({ tool: "newsroom_network_reduce", dir, declared: [out], args: [join(dir, "runtime/networkx_reduce.py"), "--request", join(dir, `visualizations/graph-reduction/requests/${key}.json`), "--output", join(dir, out)], timeoutMs: 180_000 });
  assertQuiet("networkx_reduce.py", dir, [out], c);
  assert.equal(c.result.code, 0, `exit 0 (${c.result.stderr.slice(0, 300)})`);
  const reduction = JSON.parse(readFileSync(join(dir, out), "utf8"));
  assert.equal(reduction.engine, "networkx"); assert.equal(reduction.summary.original_nodes, 6); assert.equal(reduction.summary.original_edges, 7);
  check("4 networkx_reduce.py through runDeclared: reduction written, not refused, no row, only the declared file is new, no copy folder, no __pycache__");
}

// 5. duckdb with a memory limit so small that it spills (K643 5.3): the same arguments as queryDuckDb with a smaller limit; it declares no output.
//    The spill files (<run>/.tmp/duckdb_temp_storage-*.tmp) have the exempt `.tmp` suffix and are gone when it ends; the query reports how many temp files it held.
{
  const dir = newRun([]);
  mkdirSync(join(dir, "data"), { recursive: true });
  const sql = "CREATE TABLE t AS SELECT i, random() AS r, repeat('x', 40) AS s FROM range(3000000) t(i); SELECT count(*) AS n, (SELECT count(*) FROM duckdb_temporary_files()) AS temp_files FROM t;";
  const args = ["-json", ":memory:", "-cmd", `SET allowed_directories = ['${join(dir, "data")}']`, "-cmd", "SET enable_external_access = false", "-cmd", "SET allow_community_extensions = false", "-cmd", "SET memory_limit = '24MB'", "-cmd", "SET threads = 2", "-cmd", "SET lock_configuration = true", "-c", sql];
  const c = await runChild({ tool: "duckdb_query", dir, declared: [], bin: "duckdb", args, stdoutLimit: 1_000_000, timeoutMs: 60_000 });
  assertQuiet("duckdb (spilling)", dir, [], c);
  assert.equal(c.result.code, 0, `exit 0 (${c.result.stderr.slice(0, 300)})`);
  const row = JSON.parse(c.result.stdout.trim())[0];
  assert.equal(row.n, 3000000);
  assert.ok(row.temp_files > 0, `the query did spill (temp files held: ${row.temp_files})`);
  check("5 duckdb with memory_limit 24MB (it spills to <run>/.tmp, the query shows temp files held > 0) through runDeclared: not refused, no row, nothing new left, no copy folder");
}

// 6. scientific_basemap_prepare.py (matplotlib + basemap + the GSHHG data CI installs)
{
  const dir = newRun(["scientific_basemap_prepare.py"]);
  // the request newsroom_basemap_prepare builds for a regional extent that holds coast (the Gulf of Genoa), rivers and boundaries on, no resolution given (the script picks it)
  const request = { extent: { west: 7, east: 10, south: 43, north: 46 }, task: "regional", include_rivers: true, include_boundaries: true };
  const key = sha(request);
  writeJson(dir, `maps/basemaps/requests/${key}.json`, request);
  const out = `maps/basemaps/${key}.json`;
  const c = await runChild({ tool: "newsroom_basemap_prepare", dir, declared: [out], args: [join(dir, "runtime/scientific_basemap_prepare.py"), "--request", join(dir, `maps/basemaps/requests/${key}.json`), "--output", join(dir, out)] });
  assertQuiet("scientific_basemap_prepare.py", dir, [out], c);
  assert.equal(c.result.code, 0, `exit 0 (${c.result.stderr.slice(0, 300)})`);
  const asset = JSON.parse(readFileSync(join(dir, out), "utf8"));
  assert.ok(String(asset.id).startsWith("gshhg_"), "a basemap asset"); assert.ok(asset.features.length > 0, "it has coastline features");
  check("6 scientific_basemap_prepare.py through runDeclared: basemap written, not refused, no row, only the declared file is new, no copy folder, no __pycache__");
}

for (const name of results) console.log(`  ok  ${name}`);
console.log(`group real children: PASS (${results.length} checks)`);
