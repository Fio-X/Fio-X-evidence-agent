// NEWSROOM_SPEED_ATOMIC_ARTIFACT=1: (a) the immutable artifact writers publish a
// complete file with link(2), so a concurrent writer never reads a half-written
// target; (b) duckdb_query and viz_lint write one shared computation record, so
// the same SQL/snapshot/rows never collide. Switch off keeps the old bytes.
//
// Loads runtime/pi/newsroom.ts from a type-stripped temporary copy (same
// approach as test_viz_plan_inset_param.mjs). Needs the duckdb binary.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { link, unlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { withoutRunTraces } from "./lib_run_traces.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("atomic-artifact-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { computationRelativePath } = await import(join(pi, "provenance.mjs"));

const SWITCH = "NEWSROOM_SPEED_ATOMIC_ARTIFACT";
const setSwitch = (on) => { if (on) process.env[SWITCH] = "1"; else delete process.env[SWITCH]; };

function freshRoot(label) {
  const outer = makeTestTmp(`atomic-${label}-`);
  const art = join(outer, "run");
  mkdirSync(join(art, "computations"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}
const tmpDirOf = (art) => join(dirname(art), `.${basename(art)}.write-tmp`);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const leftovers = (art) => (existsSync(tmpDirOf(art)) ? readdirSync(tmpDirOf(art)) : []);
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

// A computation record is the knowledge group's: in production only a registered tool's execute reaches these writers, and its context names the tool.
// The test names a real knowledge-group tool as the initiator, so the writes also pass NEWSROOM_GROUP_ENFORCE=1 without loosening any rule.
const { runInTool } = await import(join(pi, "groups.mjs"));
const writeText = (...args) => runInTool("duckdb_query", () => mod.__writeArtifactIfAbsentForTest(...args));
const writeBytes = (...args) => runInTool("duckdb_query", () => mod.__writeArtifactBytesIfAbsentForTest(...args));
const TEXT = JSON.stringify({ a: 1 }, null, 2) + "\n";

// --- (a) Defect reproduction, switch off ------------------------------------
{
  setSwitch(false);
  const art = freshRoot("off");
  const target = join(art, "computations", "x.json");
  const created = gate();
  const release = gate();
  mod.__setArtifactFsForTest({
    // A: exclusive-create the empty target, stall, then fill it in.
    async writeFile(path, data, options) {
      if (path !== target) return writeFile(path, data, options);
      await writeFile(path, "", { flag: "wx" });
      created.open();
      await release.p;
      await writeFile(path, data, { encoding: "utf8" });
    },
  });
  const a = writeText("computations/x.json", { a: 1 });
  await created.p;
  mod.__setArtifactFsForTest(null);
  await assert.rejects(() => writeText("computations/x.json", { a: 1 }), /Immutable artifact collision/, "switch off: B reads the empty target and reports a collision (the known defect)");
  release.open();
  await a;
  assert.equal(readFileSync(target, "utf8"), TEXT);
  assert.deepEqual(leftovers(art), [], "switch off never creates a temp dir");
  console.log("switch off reproduces the half-written-target collision -- PASS");
}

// --- (a) Switch on: three cut points ----------------------------------------
for (const cut of ["before-link", "after-link"]) {
  setSwitch(true);
  const art = freshRoot(cut);
  const target = join(art, "computations", "x.json");
  const paused = gate();
  const release = gate();
  const seenInsideRoot = [];
  const hooks = {};
  if (cut === "before-link") {
    hooks.link = async (from, to) => { paused.open(); await release.p; return link(from, to); };
  } else {
    let first = true;
    hooks.unlink = async (path) => { if (first && path.endsWith(".tmp")) { first = false; seenInsideRoot.push(...walk(art)); paused.open(); await release.p; } return unlink(path); };
  }
  mod.__setArtifactFsForTest(hooks);
  const a = writeText("computations/x.json", { a: 1 });
  await paused.p;
  // While A is stopped, nothing under the root is a temp file and the target is either absent or complete.
  const inRoot = walk(art);
  assert.ok(inRoot.every((p) => !p.endsWith(".tmp")), `${cut}: no temp file inside the artifact root`);
  assert.ok(leftovers(art).every((n) => n.endsWith(".tmp")), `${cut}: temp files end in .tmp`);
  assert.ok(tmpDirOf(art).startsWith(dirname(art)) && !tmpDirOf(art).startsWith(art + "/"), `${cut}: temp dir is outside the artifact root`);
  if (cut === "before-link") assert.ok(!existsSync(target), "before link the target does not exist yet");
  else assert.equal(readFileSync(target, "utf8"), TEXT, "after link the target is already complete");
  mod.__setArtifactFsForTest(null);
  await writeText("computations/x.json", { a: 1 }); // B races A and wins or loses without error
  release.open();
  await a;
  assert.equal(readFileSync(target, "utf8"), TEXT);
  assert.deepEqual(walk(art).filter((p) => p.endsWith(".tmp")), []);
  assert.deepEqual(leftovers(art), [], `${cut}: temp files removed once both writers finish`);
  console.log(`switch on, ${cut}: concurrent writer sees no partial target and no temp file in the root -- PASS`);
}

{ // killed mid-write: the temp file stays behind, but outside the root
  setSwitch(true);
  const art = freshRoot("killed");
  mod.__setArtifactFsForTest({
    async writeFile(path, data, options) {
      if (!String(path).endsWith(".tmp")) return writeFile(path, data, options);
      await writeFile(path, Buffer.from(data).subarray(0, 3), options); // half the bytes
      throw Object.assign(new Error("simulated kill"), { code: "SIMULATED_KILL" });
    },
    async unlink() { /* the process is gone: no cleanup runs */ },
  });
  await assert.rejects(() => writeText("computations/x.json", { a: 1 }), /simulated kill/);
  mod.__setArtifactFsForTest(null);
  assert.ok(!existsSync(join(art, "computations", "x.json")), "target never appears");
  assert.deepEqual(withoutRunTraces(art, walk(art), { label: "killed" }), [], "nothing at all is left inside the artifact root");
  assert.equal(leftovers(art).length, 1);
  // Rename the orphan to a pid that cannot be alive, then start-up cleanup removes it; a live pid's file is kept.
  const orphan = leftovers(art)[0];
  const dir = tmpDirOf(art);
  const dead = "2147483646-" + orphan.split("-")[1];
  const live = `${process.ppid}-deadbeefdeadbeef.tmp`;
  writeFileSync(join(dir, live), "x");
  await import("node:fs/promises").then(({ rename }) => rename(join(dir, orphan), join(dir, dead)));
  const removed = await mod.cleanupStaleArtifactTmp(art);
  assert.equal(removed, 1);
  assert.deepEqual(leftovers(art), [live], "only the dead writer's temp file is removed");
  // Retry after the "crash" succeeds from scratch.
  await writeText("computations/x.json", { a: 1 });
  assert.equal(readFileSync(join(art, "computations", "x.json"), "utf8"), TEXT);
  console.log("switch on, killed mid-write: orphan stays outside the root and is cleaned at start-up -- PASS");
}

// --- (a) Other write semantics, switch on -----------------------------------
{
  setSwitch(true);
  const art = freshRoot("semantics");
  // same content, two concurrent writers
  await Promise.all([writeText("computations/y.json", { b: 2 }), writeText("computations/y.json", { b: 2 })]);
  assert.equal(readFileSync(join(art, "computations", "y.json"), "utf8"), JSON.stringify({ b: 2 }, null, 2) + "\n");
  // different content: still a collision, target untouched
  const before = readFileSync(join(art, "computations", "y.json"), "utf8");
  await assert.rejects(() => writeText("computations/y.json", { b: 3 }), /Immutable artifact collision: existing bytes differ at computations\/y\.json/);
  assert.equal(readFileSync(join(art, "computations", "y.json"), "utf8"), before, "EEXIST never rewrites the target");
  // directory in the way
  mkdirSync(join(art, "computations", "dir.json"));
  await assert.rejects(() => writeText("computations/dir.json", { c: 1 }), /not a file/);
  // bytes variant
  const bytes = Uint8Array.from([0, 1, 2, 255, 254]);
  await Promise.all([writeBytes("computations/z.bin", bytes), writeBytes("computations/z.bin", bytes)]);
  assert.deepEqual([...readFileSync(join(art, "computations", "z.bin"))], [...bytes]);
  await assert.rejects(() => writeBytes("computations/z.bin", Uint8Array.from([9])), /Immutable artifact collision/);
  assert.deepEqual(leftovers(art), []);
  // link not supported on this volume: fall back to exclusive create
  for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
    let linkCalls = 0;
    mod.__setArtifactFsForTest({ async link() { linkCalls++; throw Object.assign(new Error(code), { code }); } });
    await writeText(`computations/fallback-${code}.json`, { f: code });
    assert.ok(linkCalls >= 1, `${code}: the link seam fired, so the fallback really ran`);
    assert.equal(readFileSync(join(art, "computations", `fallback-${code}.json`), "utf8"), JSON.stringify({ f: code }, null, 2) + "\n");
    await assert.rejects(() => writeText(`computations/fallback-${code}.json`, { f: "other" }), /Immutable artifact collision/);
  }
  // unrelated link errors are not swallowed
  mod.__setArtifactFsForTest({ async link() { throw Object.assign(new Error("disk"), { code: "EIO" }); } });
  await assert.rejects(() => writeText("computations/io.json", { i: 1 }), /disk/);
  mod.__setArtifactFsForTest(null);
  assert.deepEqual(leftovers(art), []);
  console.log("switch on: same-content ok, different-content collides, directory rejected, EPERM/ENOTSUP/EXDEV fall back -- PASS");
}

// --- (b) duckdb_query and viz_lint share one computation record -------------
const tools = new Map();
const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
process.env.NEWSROOM_TOOL_PROFILE = "full";
mod.default(piApi);
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const { CHOROPLETH_BASEMAP_ID } = await import(join(ROOT, "runtime/pi/choropleth.mjs"));
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const CSV = ["country,year,share",
  "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0"].join("\n") + "\n";

function fixtureRun(label) {
  const art = freshRoot(label);
  for (const d of ["visualizations/plans", "visualizations/lints", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  writeFileSync(join(art, "data", "africa.csv"), CSV);
  const sha256 = createHash("sha256").update(CSV).digest("hex");
  writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256 }));
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
    claim_id: "claim-fixture", status: "verified", source_refs: ["data/africa.csv"],
    verification: { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true },
  })}\n`);
  return art;
}
const planParams = (sql) => ({
  reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries.",
  source_note: "fixture", claim_id: "claim-fixture", sql, unit: "%", chart_type: "choropleth", category_field: "country",
  value_field: "share", category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "acknowledge",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [],
});
const compFiles = (art) => readdirSync(join(art, "computations")).filter((n) => n.endsWith(".json"));
async function lintAndQuery(sql, order) {
  const plan = await tools.get("newsroom_viz_plan").execute("p", planParams(sql));
  const run = {
    query: () => tools.get("duckdb_query").execute("q", { sql }),
    lint: () => tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef }),
  };
  const out = {};
  for (const step of order) out[step] = await run[step]();
  return out;
}
const SQL = "SELECT country, year, share FROM 'data/africa.csv' ORDER BY country";

for (const order of [["query", "lint"], ["lint", "query"]]) {
  setSwitch(true);
  const art = fixtureRun(`b-${order.join("")}`);
  const out = await lintAndQuery(SQL, order); // neither call may throw
  const files = compFiles(art);
  assert.equal(files.length, 1, `${order.join("→")}: one computation file`);
  const text = readFileSync(join(art, "computations", files[0]), "utf8");
  const record = JSON.parse(text);
  assert.ok(!("data_hash" in record), "shared record has no data_hash");
  assert.deepEqual(Object.keys(record), ["schema_version", "sql", "input_snapshot_hash", "input_fingerprints", "read_inputs", "input_binding", "result_hash", "rows"]);
  assert.equal(`computations/${files[0]}`, computationRelativePath(record.sql, record.input_snapshot_hash, record.result_hash));
  assert.equal(out.lint.details.computationRef, `computations/${files[0]}`);
  assert.ok(text.includes('"year": 2022') && !text.includes("2022.0"), "year stays an INTEGER in the record");
  assert.deepEqual(readdirSync(dirname(art)).filter((n) => n.endsWith(".tmp")), []);
  console.log(`switch on, ${order.join(" then ")}: one byte-identical computation record, no collision -- PASS`);
}

{ // trailing semicolon/whitespace: the plan keeps the raw SQL, duckdb_query normalizes it
  setSwitch(true);
  const art = fixtureRun("b-semicolon");
  await lintAndQuery(`${SQL} ;\n`, ["query", "lint"]);
  assert.equal(compFiles(art).length, 1, "normalized SQL gives one file even when the plan SQL has a trailing semicolon");
  console.log("switch on, trailing semicolon: still one computation record -- PASS");
}

{ // switch off: legacy shapes, including the extra data_hash, byte for byte
  setSwitch(false);
  const art = fixtureRun("b-off");
  await assert.rejects(() => lintAndQuery(SQL, ["query", "lint"]), /Immutable artifact collision/, "switch off keeps the known same-SQL collision");
  const files = compFiles(art);
  assert.equal(files.length, 1);
  const query = JSON.parse(readFileSync(join(art, "computations", files[0]), "utf8"));
  assert.deepEqual(Object.keys(query), ["schema_version", "sql", "input_snapshot_hash", "input_fingerprints", "read_inputs", "input_binding", "result_hash", "rows"]);
  assert.equal(`computations/${files[0]}`, computationRelativePath(query.sql, query.input_snapshot_hash, query.result_hash));

  const art2 = fixtureRun("b-off-lint");
  await lintAndQuery(SQL, ["lint"]);
  const lintFile = compFiles(art2)[0];
  const lintText = readFileSync(join(art2, "computations", lintFile), "utf8");
  const lintRecord = JSON.parse(lintText);
  assert.deepEqual(Object.keys(lintRecord), ["schema_version", "sql", "input_snapshot_hash", "input_fingerprints", "read_inputs", "input_binding", "result_hash", "data_hash", "rows"]);
  assert.equal(lintRecord.data_hash, lintRecord.result_hash);
  assert.equal(lintText, JSON.stringify(lintRecord, null, 2) + "\n");
  assert.equal(`computations/${lintFile}`, computationRelativePath(lintRecord.sql, lintRecord.input_snapshot_hash, lintRecord.result_hash));
  assert.equal(readdirSync(dirname(art2)).filter((n) => n.startsWith(".")).length, 0, "switch off never creates a temp dir");
  console.log("switch off: legacy record shapes unchanged, collision unchanged -- PASS");
}

{ // regression guard: a viz_lint record that carries data_hash again collides with duckdb_query's
  setSwitch(true);
  const art = fixtureRun("b-guard");
  const first = await lintAndQuery(SQL, ["query"]);
  const file = compFiles(art)[0];
  const record = JSON.parse(readFileSync(join(art, "computations", file), "utf8"));
  const { rows, ...rest } = record;
  await assert.rejects(
    () => writeText(`computations/${file}`, { ...rest, data_hash: record.result_hash, rows }),
    /Immutable artifact collision/,
  );
  void first;
  console.log("regression guard: adding data_hash back to the record collides -- PASS");
}

// --- trailing " ;" through the claim and chart tools ------------------------
// Baseline bug (switch off): duckdb_query stores "x " for "x ;", record_claim's
// replay normalizes the stored SQL to "x" and rejects the path. Documented here,
// not fixed on the off path. Switch on: record_claim replays the same record.
{
  const SPACED = `${SQL} ;`;
  const claimParams = (ref) => ({
    claim: "Chad had the lowest listed share in the fixture.",
    claim_kind: "descriptive", status: "supported",
    source_refs: ["data/africa.csv"], computation_refs: [ref],
  });
  setSwitch(false);
  {
    const art = fixtureRun("claim-off");
    const q = await tools.get("duckdb_query").execute("q", { sql: SPACED });
    const ref = q.details?.artifact ? q.details.artifact.slice(art.length + 1) : compFiles(art).map((n) => `computations/${n}`)[0];
    const stored = JSON.parse(readFileSync(join(art, ref), "utf8"));
    assert.equal(stored.sql, `${SQL} `, "switch off stores the SQL with the trailing space (baseline behaviour)");
    await assert.rejects(() => tools.get("record_claim").execute("c", claimParams(ref)), /content-addressed path does not match/, "baseline bug: replay rejects the record");
  }
  setSwitch(true);
  {
    const art = fixtureRun("claim-on");
    const q = await tools.get("duckdb_query").execute("q", { sql: SPACED });
    const ref = compFiles(art).map((n) => `computations/${n}`)[0];
    assert.equal(JSON.parse(readFileSync(join(art, ref), "utf8")).sql, SQL);
    const claim = await tools.get("record_claim").execute("c", claimParams(ref));
    assert.match(claim.content[0].text, /VERIFIED by system replay/);
    // newsroom_chart (which also takes computationSql now) is retired and never registered, so it cannot be driven here.
    void q;
  }
  setSwitch(false);
  console.log("trailing ' ;': baseline replay bug recorded; switch on, record_claim replays the same record -- PASS");
}
console.log("PASS");
