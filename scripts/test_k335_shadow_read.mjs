#!/usr/bin/env node
// K335: the shadow checks read computation rows through queryDuckDbShadowRead, which projects a row table that is not in the run folder into a per-call temp
// folder outside the run (removed in finally) and never reaches a query-rows writer. duckDbRun is the one DuckDB sandbox configuration, module-local, with
// exactly two callers. Checks:
//   1. duckDbRun: only queryDuckDb and queryDuckDbShadowRead reach it (mutation: a third caller / a bare reference is red); no direct write in its body (mutation);
//   2. real DuckDB: the shadow read returns the rows queryDuckDb returns, whether the row table is on disk or not; with the table not on disk the run folder gets no
//      file; the SQL cannot read outside the allowed directories (the temp folder is the only addition); the temp folder is gone after success and after failure;
//   3. an unavailable temp folder is a shadowSkip error (reason + table ref), and the probe turns it into file.skipped, never a missing record;
//   4. byte parity: the shadow records and every other artifact of the infographic lint with NEWSROOM_SHADOW_CHECKS=1 equal the recorded output of the previous
//      runtime; the direct read with the table not on disk returns the same rows as that runtime's queryDuckDb (which, unlike the new path, wrote runtime/query-rows).
//      The previous runtime is not in the pushed history: its output is the committed record scripts/fixtures/base-output/k335_shadow_read.json, made by
//      scripts/gen_base_output_fixtures.mjs from that runtime's own tree and named by a content hash. A missing record, another source, an unrecorded input or an
//      edited record fails; there is no skip path (the mutation check at the end flips one byte of a copy).
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeAsOf } from "../runtime/pi/asof_probe.mjs";
import { baseOutputs, sha256 } from "./fixtures/base-output/recorder.mjs";
import { loadNewsroom } from "./precision_harness.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// content hash of the previous runtime (see recorder.mjs); the record must have been made from exactly this tree
const BASE_SOURCE = "7f4b4c6517b4342917700627ef03c1d00495f39bf33db6ed511ad9db962e5a85";
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const { blank, topLevel, DIRECT_WRITE } = await import(pathToFileURL(join(ROOT, "scripts/test_group_cross_calls.mjs")).href);
const groupsJson = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");

// ---- 1. static ------------------------------------------------------------
const OWNERS = ["queryDuckDb", "queryDuckDbShadowRead"];
function duckDbRunProblems(text) {
  const clean = blank(text);
  const decls = topLevel(clean);
  const red = [];
  const own = decls.find((d) => d.name === "duckDbRun");
  if (!own) return ["duckDbRun is not a top-level function"];
  if (/^\s*export\b/.test(clean.slice(Math.max(0, clean.lastIndexOf("\n", own.start)), own.start + 20))) red.push("duckDbRun is exported");
  let rest = clean;
  for (const d of [...decls.filter((x) => x.name === "duckDbRun" || OWNERS.includes(x.name))].sort((a, b) => b.start - a.start)) {
    const body = clean.slice(d.start, d.end);
    if (d.name === "duckDbRun") { const hit = body.replace(/\bduckDbRun\b/, "").match(DIRECT_WRITE); if (hit) red.push(`duckDbRun gained a direct write (${hit[0]})`); }
    else if (!/\bduckDbRun\s*\(/.test(body)) red.push(`${d.name} no longer calls duckDbRun`);
    rest = rest.slice(0, d.start) + " ".repeat(d.end - d.start) + rest.slice(d.end);
  }
  for (const line of rest.split("\n")) {
    if (!/\bduckDbRun\b/.test(line)) continue;
    if (/^\s*duckDbRun = trackCrossCall\("\s*", duckDbRun, rootBeforeRebind\);\s*$/.test(line)) continue;
    red.push(`duckDbRun is reached outside its two callers: ${line.trim().slice(0, 80)}`);
  }
  return red;
}
assert.deepEqual(duckDbRunProblems(src), [], "duckDbRun: two callers only, no direct write");
const mutated = (text) => duckDbRunProblems(text);
assert.ok(mutated(`${src}\nasync function thirdCaller(root: string) { return duckDbRun(root, "SELECT 1", []); }\n`).some((m) => /outside its two callers/.test(m)), "a third caller is red");
assert.ok(mutated(`${src}\nconst leak = duckDbRun;\n`).some((m) => /outside its two callers/.test(m)), "a bare reference is red");
{
  const at = src.indexOf("async function duckDbRun(");
  const open = src.indexOf("{", src.indexOf(")", src.indexOf("signal?: AbortSignal", at)));
  for (const write of ['writeFileSync(join(root, "x"), "y");', 'mkdirSync(join(root, "x"));', 'await saveQueryRows([]);', 'rmSync(root);']) {
    const red = mutated(`${src.slice(0, open + 1)}\n  ${write}${src.slice(open + 1)}`);
    assert.ok(red.some((m) => /direct write/.test(m)), `a direct write in duckDbRun is red: ${write}`);
  }
}
const row = groupsJson.cross_calls.functions.queryDuckDbShadowRead, run = groupsJson.cross_calls.functions.duckDbRun;
assert.ok(row && run, "both rows exist in groups.json");
assert.ok(groupsJson.cross_calls.gated.includes("queryDuckDbShadowRead"), "queryDuckDbShadowRead is gated");
assert.ok(/outside the run|without writing query-rows/.test(row.why) && /single DuckDB sandbox|only through/.test(run.why + " " + JSON.stringify(groupsJson.cross_calls.tool_pin.duckDbRun.why)), "the two rows say why");
assert.equal(groupsJson.cross_calls.tool_pin.duckDbRun.owner, "knowledge", "duckDbRun is pinned to the knowledge owner");
assert.ok(!groupsJson.cross_calls.tool_allow.queryDuckDb.tools.includes("newsroom_infographic_lint"), "queryDuckDb is no longer reached by the infographic tools");
console.log("duckDbRun callers / direct writes (+ mutations) -- PASS");

// ---- 2. real DuckDB -------------------------------------------------------
const scratch = makeTestTmp("k335-");
const tmpFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith("news-shadow-rows-")).sort();
async function withHarness(opts, fn) {
  const h = await loadNewsroom({ prefix: "k335-", ...opts });
  try {
    const copy = join(h.pi, "newsroom.test-copy.mjs");
    appendFileSync(copy, opts.baselineRev ? "\nexport const __k335 = { queryDuckDb };\n" : "\nexport const __k335 = { queryDuckDb, queryDuckDbShadowRead };\n");
    const mod = await import(`${pathToFileURL(copy).href}?v=${Math.random()}`);
    return await fn(h, mod.__k335);
  } finally { rmSync(h.tmp, { recursive: true, force: true }); }
}
const walk = (dir, root = dir, out = new Map()) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out); else out.set(relative(root, path), readFileSync(path));
  }
  return out;
};
const DATA = "a,b\n1,2\n3,4\n5,6\n";
const before = tmpFolders();
const sameRows = await withHarness({ env: { NEWSROOM_SHADOW_CHECKS: "1" } }, async (h, fns) => {
  const f = h.addData("t", DATA);
  const comp = await h.query(`SELECT a, b FROM read_csv_auto('${f}') ORDER BY a`);
  const sql = `SELECT sum(a) AS s, count(*) AS n FROM '${comp}'`;
  const filesBefore = walk(h.art);
  // table NOT on disk
  assert.deepEqual(readdirSync(join(h.art, "runtime/query-rows")), [], "precondition: no row table on disk");
  const shadow = await fns.queryDuckDbShadowRead(sql);
  assert.deepEqual(readdirSync(join(h.art, "runtime/query-rows")), [], "the shadow read wrote nothing into runtime/query-rows");
  assert.deepEqual([...walk(h.art).keys()], [...filesBefore.keys()], "the shadow read added no file to the run folder");
  assert.deepEqual(tmpFolders(), before, "temp folder removed after success");
  assert.deepEqual(shadow, [{ s: "9", n: 3 }]);
  // outside access: the temp folder is the only addition; nothing else is readable
  const outside = join(scratch, "outside.csv");
  writeFileSync(outside, "x\n1\n");
  await assert.rejects(fns.queryDuckDbShadowRead(`SELECT * FROM '${comp}', read_csv_auto('${outside}')`), /DUCKDB_QUERY_FAILED/, "a file outside the allowed folders is refused (table not on disk)");
  assert.deepEqual(tmpFolders(), before, "temp folder removed after a failed query");
  assert.deepEqual(readdirSync(join(h.art, "runtime/query-rows")), [], "failure also leaves the run folder alone");
  await assert.rejects(fns.queryDuckDbShadowRead(`SELECT * FROM read_csv_auto('${outside}')`), /DUCKDB_QUERY_FAILED/, "a file outside is refused without any projection too");
  for (const own of ["claims.jsonl", "config/x.csv"]) { mkdirSync(join(h.art, "config"), { recursive: true }); writeFileSync(join(h.art, own), "x\n1\n"); await assert.rejects(fns.queryDuckDbShadowRead(`SELECT * FROM read_csv_auto('${join(h.art, own)}')`), /DUCKDB_QUERY_FAILED/, `${own} in the run folder is outside the allowed folders`); }
  assert.deepEqual(tmpFolders(), before);
  // a failure while projected (bad column) still removes the folder
  await assert.rejects(fns.queryDuckDbShadowRead(`SELECT nope FROM '${comp}'`), /DUCKDB_QUERY_FAILED/);
  assert.deepEqual(tmpFolders(), before, "temp folder removed after a binder error with a projected table");
  // the same query through queryDuckDb returns the same rows (and, unlike the shadow read, writes the table)
  const real = await fns.queryDuckDb(sql);
  assert.deepEqual(real, shadow, "queryDuckDb and the shadow read return the same rows");
  assert.equal(readdirSync(join(h.art, "runtime/query-rows")).length, 1, "queryDuckDb writes the row table (the old shadow path did too)");
  // table ON disk now: the shadow read uses it, no projection
  assert.deepEqual(await fns.queryDuckDbShadowRead(sql), shadow);
  assert.deepEqual(tmpFolders(), before);
  const tableDir = join(h.art, "runtime/query-rows");
  return { shadow, real, table: readFileSync(join(tableDir, readdirSync(tableDir)[0])), tableName: readdirSync(tableDir)[0] };
});

// ---- 3. unavailable temp folder -> skipped, not missing ------------------------
await withHarness({ env: { NEWSROOM_SHADOW_CHECKS: "1" } }, async (h, fns) => {
  const f = h.addData("t", DATA);
  const comp = await h.query(`SELECT a, b FROM read_csv_auto('${f}') ORDER BY a`);
  const realTmp = process.env.TMPDIR;
  process.env.TMPDIR = join(scratch, "does-not-exist");
  try {
    const error = await fns.queryDuckDbShadowRead(`SELECT count(*) AS n FROM '${comp}'`).then(() => null, (e) => e);
    assert.ok(error?.shadowSkip, "an unavailable temp folder is a shadowSkip error");
    assert.match(error.shadowSkip.reason, /temp folder is unavailable/);
    assert.equal(error.shadowSkip.table_ref, `runtime/query-rows/${comp.split("/").pop()}`, "the skip names the table ref");
    assert.deepEqual(readdirSync(join(h.art, "runtime/query-rows")), [], "nothing written to the run folder");
  } finally { process.env.TMPDIR = realTmp; }
});
{
  const skip = { reason: "rows table not on disk and the temp folder is unavailable (ENOENT)", table_ref: "runtime/query-rows/x.json" };
  const make = (describeFails) => ({
    subjectSet: { key_field: "id", cutoff_date: "2017" }, members: new Set(["Y"]), ast: null, sql: "SELECT id FROM read_csv_auto('data/t.csv')", inputs: ["data/t.csv"],
    describe: async () => { if (describeFails) throw Object.assign(new Error("skipped"), { shadowSkip: skip }); return [{ name: "id" }, { name: "start" }, { name: "end_d" }]; },
    query: async () => { throw Object.assign(new Error("skipped"), { shadowSkip: skip }); },
  });
  const a = await probeAsOf(make(true));
  assert.deepEqual(a.files[0].skipped, skip, "describe skip is recorded on the file");
  assert.equal(a.files[0].reason, "describe_failed");
  const b = await probeAsOf(make(false));
  assert.deepEqual(b.files[0].skipped, skip, "query skip is recorded on the file");
  assert.equal(b.files[0].status, "skipped");
  const plain = await probeAsOf({ ...make(true), describe: async () => { throw new Error("boom"); } });
  assert.ok(!("skipped" in plain.files[0]), "an ordinary failure keeps the old record shape");
}
console.log("shadow read: rows, outside access, cleanup, skip record -- PASS");

// ---- 4. byte parity against the recorded previous runtime -------------------------------------------
const timeline = JSON.parse(readFileSync(join(ROOT, "fixtures", "complex", "timeline.json"), "utf8"));
const SOURCE = "id,start_d,end_d,snapshot_date\nX,2015-03-01,2019-05-01,2020-01-01\nY,2016-01-01,,2020-01-01\nZ,2020-02-01,,2020-01-01\nW,2014-01-01,2030-01-01,2020-01-01\n";
async function flow(baselineRev) {
  const h = await loadNewsroom({ prefix: "k335p-", baselineRev, env: { NEWSROOM_SHADOW_CHECKS: "1", NEWSROOM_MOBILE_PAGES: "1" } });
  try {
    const fileSrc = h.addData("members", SOURCE);
    const fileA = h.addData("timeline", ["date,event", ...timeline.rows.map((r) => `${r.date},${r.event}`)].join("\n") + "\n");
    const qa = await h.query(`SELECT date, event FROM read_csv_auto('${fileA}')`);
    const claim = await h.recordClaim("The timeline has 4 dated milestones", [fileA], [qa]);
    const setRef = await h.query(`SELECT id FROM read_csv_auto('${fileSrc}') WHERE end_d IS NULL ORDER BY id`);
    const planRef = "visualizations/plans/plan.json";
    writeFileSync(join(h.art, planRef), JSON.stringify({ ...timeline.spec, sql: `SELECT date, event FROM read_csv_auto('${fileA}') ORDER BY date`, claim_id: claim.claim_id }));
    const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
    const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lint.details.lintRef });
    const igRef = "infographics/plans/plan.json";
    writeFileSync(join(h.art, igRef), JSON.stringify({
      schema_version: "1.0.0", title: "Members", dek: "d", alt: "A header, a statistic and a chart.",
      subject_set: { computation_ref: setRef, key_field: "id", cutoff_date: "2017-12-31" },
      modules: [
        { id: "m1", type: "section_header", span: "full", heading: "Overview" },
        { id: "m2", type: "hero_stat", span: "full", value: "2", label: "Members", claim_id: claim.claim_id },
        { id: "m3", type: "visual", span: "full", manifest_ref: render.details.manifestRef },
      ],
    }));
    const result = await h.tools.get("newsroom_infographic_lint").execute("i", { plan_ref: igRef });
    const files = walk(h.art);
    return { text: result.content[0].text, details: JSON.parse(JSON.stringify(result.details)), files, shadow: [...files.keys()].filter((p) => p.startsWith("shadow/")) };
  } finally { rmSync(h.tmp, { recursive: true, force: true }); }
}
const base_ = baseOutputs({ name: "k335_shadow_read", source: BASE_SOURCE });
const flowInputs = { kind: "infographic_lint_flow", env: { NEWSROOM_SHADOW_CHECKS: "1", NEWSROOM_MOBILE_PAGES: "1" }, SOURCE, timeline };
const base = JSON.parse(await base_.get(flowInputs, async () => {
  const r = await flow(base_.head);
  return JSON.stringify({ text: r.text, details: r.details, files: [...r.files].map(([path, bytes]) => [path, bytes.toString("base64")]), shadow: r.shadow });
}));
base.files = new Map(base.files.map(([path, b64]) => [path, Buffer.from(b64, "base64")]));
const head = await flow(undefined);
assert.ok(base.shadow.length > 0, "the recorded baseline run wrote shadow records (the comparison is not empty)");
assert.deepEqual(head.shadow, base.shadow, "same shadow files");
// The only field that may differ is the probe's own wall-clock timer compute_ms; it is replaced by a fixed number (and counted) before the byte comparison.
const TIMER = /"compute_ms": [0-9.]+/g;
for (const path of base.shadow) {
  const a = base.files.get(path).toString("utf8"), b = head.files.get(path).toString("utf8");
  assert.equal((a.match(TIMER) ?? []).length, (b.match(TIMER) ?? []).length, `same timer fields: ${path}`);
  assert.equal(b.replace(TIMER, '"compute_ms": 0'), a.replace(TIMER, '"compute_ms": 0'), `shadow record byte-identical apart from compute_ms: ${path}`);
}
assert.equal(head.text, base.text, "model-visible text equal");
assert.deepEqual(head.details, base.details, "details equal");
assert.deepEqual([...head.files.keys()], [...base.files.keys()], "same run-folder files");
for (const [path, bytes] of base.files) if (path !== "claims.jsonl" && !path.startsWith("shadow/")) assert.ok(bytes.equals(head.files.get(path)), `artifact byte-identical: ${path}`);

// the table-not-on-disk case, directly: the same rows as the previous runtime's queryDuckDb (which wrote the table into runtime/query-rows; the new path does not)
const oldRows = JSON.parse(await base_.get({ kind: "table_not_on_disk_rows", env: { NEWSROOM_SHADOW_CHECKS: "1" }, DATA }, () => withHarness({ baselineRev: base_.head, env: { NEWSROOM_SHADOW_CHECKS: "1" } }, async (h, fns) => {
  const f = h.addData("t", DATA);
  const comp = await h.query(`SELECT a, b FROM read_csv_auto('${f}') ORDER BY a`);
  assert.deepEqual(readdirSync(join(h.art, "runtime/query-rows")), []);
  const rows = await fns.queryDuckDb(`SELECT sum(a) AS s, count(*) AS n FROM '${comp}'`);
  const tableDir = join(h.art, "runtime/query-rows");
  return JSON.stringify({ rows, queryRowsFiles: readdirSync(tableDir).length, table: readFileSync(join(tableDir, readdirSync(tableDir)[0])).toString("base64"), tableName: readdirSync(tableDir)[0] });
})));
oldRows.table = Buffer.from(oldRows.table, "base64");
assert.equal(oldRows.queryRowsFiles, 1, "the previous runtime wrote the row table into the run folder");
assert.equal(sameRows.tableName, oldRows.tableName, "the non-shadow path names the row table as the previous runtime does");
assert.ok(sameRows.table.equals(oldRows.table), "the non-shadow path (queryDuckDb) writes query-rows byte-identically to the previous runtime");
assert.deepEqual(sameRows.shadow, oldRows.rows, "table not on disk: the shadow read returns the rows the previous runtime returned");
assert.deepEqual(tmpFolders(), before, "no temp folder is left anywhere");
console.log("shadow-on byte parity vs the recorded previous runtime (+ table not on disk) -- PASS");

// ---- 5. mutation: the record cannot be edited, replaced or missing (not while recording: the file is written when the process exits) ----
if (!base_.recordWt) {
  const fixtureDir = join(ROOT, "scripts/fixtures/base-output");
  const copyDir = join(scratch, "record-copy");
  mkdirSync(copyDir, { recursive: true });
  const copyFile = join(copyDir, "k335_shadow_read.json");
  copyFileSync(join(fixtureDir, "k335_shadow_read.json"), copyFile);
  const original = readFileSync(copyFile, "utf8");
  const readBack = (dir = copyDir, source = BASE_SOURCE) => baseOutputs({ name: "k335_shadow_read", source, dir }).get(flowInputs);
  await readBack().then((text) => assert.ok(text.length > 0, "the unedited copy reads"));
  const flipAfter = (marker, from, skip) => { const i = original.indexOf(marker, from) + marker.length + skip; return original.slice(0, i) + (original[i] === "A" ? "B" : "A") + original.slice(i + 1); };
  const entry = original.indexOf(`"${sha256(JSON.stringify(flowInputs))}"`);
  assert.ok(entry > 0, "the record has the entry for the flow inputs");
  // one byte flipped inside the recorded output text of that entry
  const flipped = flipAfter('"text": "', entry, 40);
  assert.notEqual(flipped, original);
  writeFileSync(copyFile, flipped);
  await assert.rejects(readBack(), /does not match its own sha256/, "one flipped byte in the recorded output is red");
  // one byte flipped in the recorded sha256 of that entry
  writeFileSync(copyFile, flipAfter('"sha256": "', entry, 3));
  await assert.rejects(readBack(), /does not match its own sha256/, "one flipped byte in the recorded sha256 is red");
  // a different source is red, a changed input is red, a missing record is red
  writeFileSync(copyFile, original);
  assert.throws(() => baseOutputs({ name: "k335_shadow_read", source: "0".repeat(64), dir: copyDir }), /was made from/, "another source is red");
  await assert.rejects(baseOutputs({ name: "k335_shadow_read", source: BASE_SOURCE, dir: copyDir }).get({ ...flowInputs, SOURCE: `${SOURCE}x` }), /no recorded base output/, "an unrecorded input is red");
  assert.throws(() => baseOutputs({ name: "k335_shadow_read", source: BASE_SOURCE, dir: join(scratch, "no-such-dir") }), /ENOENT/, "a missing record is red");
}
console.log("record mutations (flipped byte, other source, other input, missing record) -- PASS");
console.log("K335 shadow read -- PASS");
