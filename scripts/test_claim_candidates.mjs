#!/usr/bin/env node
// Candidate conclusions of the new route (runtime/pi/claim_candidates.mjs), driven through the runtime's own claim path: templates filled by the real
// fillClaimTemplate from rows DuckDB returned, registered by the real duckdb_query -> record_claim, "a candidate is not a source" judged by the real
// normalizeArtifactRefs. Loads newsroom.ts from a type-stripped copy; DuckDB runs the SQL; no network, no provider.
// Usage: node scripts/test_claim_candidates.mjs
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyArtifact } from "../runtime/pi/groups.mjs";
import * as cand from "../runtime/pi/claim_candidates.mjs";

const { buildCandidates, materializeCandidates, sheetRecord, writeSheet, pickCandidates, stoppedState, dataStop, SHEET_PREFIX } = cand;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = readFileSync(join(ROOT, "runtime/pi/claim_candidates.mjs"), "utf8");
const tmp = makeTestTmp("claim-candidates-");
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
const { runInTool } = await import(join(pi, "groups.mjs"));
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
process.env.NEWSROOM_TOOL_PROFILE = "full";
process.env.NEWSROOM_CLAIM_SQL_LINT = "1"; // the stricter claim path: no constant typed into a select list, no generated rows

let passed = 0;
const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const tree = (dir) => Object.fromEntries(walk(dir).filter((f) => relative(dir, f) !== "runtime/cross-call-report.jsonl").map((f) => [relative(dir, f), sha(readFileSync(f))]).sort());

// A fixed table with a time column and a tie at the top of the latest year (the tied name that sorts first is listed second).
const CSV = ["geo,year,val",
  "ZZ,2015,30", "AA,2015,25", "FR,2015,20", "DE,2015,10.5", "PL,2015,5",
  "ZZ,2023,40", "AA,2023,40", "FR,2023,24", "DE,2023,21", "PL,2023,10"].join("\n") + "\n";
const fresh = (csv = CSV) => {
  const art = join(makeTestTmp("claim-candidates-run-"), "run");
  for (const dir of ["data", "computations", "sources", "runtime/query-rows", "shadow"]) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const ref = `data/${sha(csv)}.csv`;
  writeFileSync(join(art, ref), csv);
  writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ schema_version: "0.7.0", bytes: Buffer.byteLength(csv), sha256: sha(csv), file: ref }, null, 2) + "\n");
  const runSql = async (sql) => {
    const r = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["-json", ":memory:", "-c", sql], { cwd: art, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`DUCKDB_QUERY_FAILED: ${String(r.stderr).split("\n")[0]}`);
    return JSON.parse(r.stdout.trim() || "[]"); // like the runtime's queryDuckDb: output that is not JSON (NaN, inf) is an error
  };
  return { art, ref, runSql };
};
const fill = (template, rows) => mod.fillClaimTemplate(template, rows);
const run = fresh();
const specs = buildCandidates({ ref: run.ref, dimension: "geo", measure: "val", time: "year" });
const { candidates, dropped } = await materializeCandidates({ specs, runSql: run.runSql, fill });
const registerIn = (r) => async (c) => {
  const text = fill(c.template, await r.runSql(c.sql)).text; // the claim sentence is filled again from the rows, never taken from the sheet; nothing is written yet
  const q = await tools.get("duckdb_query").execute("q", { sql: c.sql });
  const comp = relative(r.art, q.details.path ?? q.details.artifact);
  const rec = await tools.get("record_claim").execute("c", { claim: text, claim_kind: c.claim_kind, status: "supported", source_refs: [r.ref], computation_refs: [comp] });
  return { claim_id: rec.details.claimId, verified: rec.details.verification?.publishable === true };
};
const claimsOf = (art) => (existsSync(join(art, "claims.jsonl")) ? readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// 1. which templates apply, and the sheet's sentences
assert.equal(candidates.length, 8, `8 candidates with a time column; dropped: ${JSON.stringify(dropped)}`);
assert.deepEqual(dropped, []);
assert.deepEqual(candidates.map((c) => c.id), ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
assert.deepEqual(candidates.map((c) => c.kind), ["rank_top", "rank_bottom", "extreme_gap", "top_to_bottom_ratio", "share_of_total", "change_largest_rise", "change_largest_fall", "change_total"]);
assert.equal(buildCandidates({ ref: run.ref, dimension: "geo", measure: "val" }).length, 5, "no time column: no change candidates, no year placeholders");
for (const s of buildCandidates({ ref: run.ref, dimension: "geo", measure: "val" })) assert.doesNotMatch(s.template, /year/);
for (const c of candidates) {
  assert.doesNotMatch(c.template, /\d/, `${c.id} template holds no digit`);
  assert.match(c.sql, new RegExp(`FROM '${run.ref}'`), `${c.id} reads the data file`);
  assert.doesNotMatch(c.sql, /\bprepared\b/);
}
check("8 templates (5 without a time column), each reads the data file and holds no typed number");

// 2. the sentences come from DuckDB's rows, through the real filler
const text = Object.fromEntries(candidates.map((c) => [c.kind, c.text]));
assert.equal(text.rank_top, "AA has the highest val in 2023: 40.", "tie broken by name in the SQL, not by file order");
assert.equal(text.rank_bottom, "PL has the lowest val in 2023: 10.");
assert.equal(text.extreme_gap, "The gap between the highest and the lowest val in 2023 is 30.");
assert.equal(text.share_of_total, "AA accounts for 29.6 percent of the total in 2023.");
assert.equal(text.change_total, "The total val changed by 49.2 percent from 2015 to 2023.");
assert.match(text.change_largest_rise, /^(AA|ZZ) changed the most upward from 2015 to 2023: from \d+ to 40\.$/);
check("sentences are filled by fillClaimTemplate from the rows DuckDB returned (ties broken by the SQL's own ORDER BY)");
{
  const signed = fresh(["geo,val", "DE,707.6", "FR,373.2", "SE,-6.7"].join("\n") + "\n");
  const out = await materializeCandidates({ specs: buildCandidates({ ref: signed.ref, dimension: "geo", measure: "val" }), runSql: signed.runSql, fill });
  assert.ok(!out.candidates.some((c) => c.kind === "top_to_bottom_ratio"), "no ratio over a lowest at or below zero");
  assert.ok(out.dropped.some((d) => d.kind === "top_to_bottom_ratio"), JSON.stringify(out.dropped));
  assert.ok(out.candidates.some((c) => c.kind === "extreme_gap"), "the gap still reads");
  process.env.NEWSROOM_ARTIFACT_DIR = run.art;
}
check("a lowest value at or below zero gives no top-to-bottom ratio; the gap stays");
const ties = await run.runSql(candidates[0].sql);
assert.deepEqual(ties.map((r) => r.name), ["AA"]);
check("a tie at the top returns the name that sorts first, whatever the file order");

// 3. the real claim path: pick, register, verify. Unselected leave nothing in computations/ or claims.
const before = tree(run.art);
assert.deepEqual(before, tree(run.art));
const beforeSheet = tree(run.art);
const sheetPath = await writeSheet(candidates, (p, record) => runInTool("newsroom_data_prepare", () => mod.__writeArtifactIfAbsentForTest(p, record)));
const afterSheet = tree(run.art);
assert.deepEqual(Object.keys(afterSheet).filter((k) => !(k in beforeSheet)), [sheetPath], "the sheet is the only new file");
assert.equal(Object.keys(afterSheet).filter((k) => k.startsWith("computations/")).length, 0);
assert.equal(claimsOf(run.art).length, 0);
check("building and writing the sheet adds one file under shadow/ and no computation, no claim");
const picks = ["c1", "c5", "c8"];
const registered = [];
const reg = registerIn(run);
const result = await pickCandidates({ candidates, picks, register: async (c) => { registered.push(c.id); return reg(c); } });
assert.equal(result.status, "ok", JSON.stringify(result));
assert.deepEqual(registered, picks);
const claims = claimsOf(run.art);
assert.equal(claims.length, 3);
assert.deepEqual(claims.map((c) => c.claim), picks.map((id) => candidates.find((c) => c.id === id).text), "the recorded claim is the sheet's sentence, word for word");
assert.ok(claims.every((c) => c.status === "supported" || c.verification?.publishable === true));
assert.equal(Object.keys(tree(run.art)).filter((k) => k.startsWith("computations/")).length, 3, "only the picked left a computation");
check("picked candidates register and verify through duckdb_query + record_claim, claim text equal to the sheet text; unselected leave nothing");

// 4. a candidate is not evidence: the real reference gate refuses the sheet whatever the spelling
const gate = (rel, kind) => mod.__normalizeArtifactRefsForTest([rel], kind);
writeFileSync(join(run.art, "shadow", "x.json"), "{}\n");
const spellings = [sheetPath, `./${sheetPath}`, "data/../shadow/x.json", "computations/../shadow/x.json", "sources/../shadow/x.json"];
for (const rel of spellings) {
  assert.ok(existsSync(join(run.art, rel)), `${rel} exists, so the refusal below is the prefix rule, not a missing file`);
  for (const kind of ["source", "computation"]) {
    await assert.rejects(() => gate(rel, kind), /must point into/, `${kind} reference ${rel}`);
  }
}
assert.deepEqual(await gate(run.ref, "source"), [run.ref], "control: a data file is a source");
const compFile = `computations/${readdirSync(join(run.art, "computations"))[0]}`;
assert.deepEqual(await gate(compFile, "computation"), [compFile], "control: a computation is a computation");
assert.deepEqual(classifyArtifact(sheetPath), { kind: "observation", owner: "knowledge" });
check("the real normalizeArtifactRefs refuses the sheet (4 spellings plus sources/..) as source and as computation");

// 5. the old shapes would stop the run at R2: each is refused by the real runtime
for (const [name, template, pattern] of [
  ["typed number", "FR has the highest val in 2023: 40.", /typed number/],
  ["number word", "The three highest in {first.year}: {first.name}.", /number word/],
]) {
  assert.throws(() => fill(template, [{ name: "FR", year: 2023 }]), pattern, name);
}
const bare = await pickCandidates({ candidates: [{ id: "c1", kind: "x", claim_kind: "comparative", sql: "SELECT geo AS name, val AS value FROM prepared ORDER BY val DESC LIMIT 1", text: "FR has the highest val: 40." }, ...candidates.slice(1, 3).map((c, i) => ({ ...c, id: `c${i + 2}` }))], picks: ["c1", "c2", "c3"], register: reg });
assert.equal(bare.reason, "claim_replay_failed");
assert.equal(bare.candidate, "c1");
check("old shapes are refused by the real runtime: typed number, number word, bare table name (STOPPED claim_replay_failed)");

// 6. two ways to break a registration: both stop the run, nothing already on disk changes
{
  const r = fresh();
  const rows = await r.runSql(buildCandidates({ ref: r.ref, dimension: "geo", measure: "val", time: "year" })[0].sql);
  const good = (await materializeCandidates({ specs: buildCandidates({ ref: r.ref, dimension: "geo", measure: "val", time: "year" }), runSql: r.runSql, fill })).candidates;
  assert.ok(rows.length === 1);
  const doRegister = registerIn(r);
  const first = await doRegister(good[0]);
  assert.equal(first.verified, true);
  const kept = tree(r.art);
  // a typed number in the template: the real filler refuses it
  const typed = { ...good[1], template: good[1].template.replace("lowest", "lowest (10)") };
  const stopTyped = await pickCandidates({ candidates: good, picks: ["c2", "c1", "c3"], register: (c) => doRegister(c.id === "c2" ? typed : c) });
  assert.deepEqual([stopTyped.status, stopTyped.reason, stopTyped.candidate], ["STOPPED", "claim_replay_failed", "c2"]);
  assert.match(stopTyped.detail, /typed number/);
  const tamperedSql = { ...good[2], sql: good[2].sql.replace(`'${r.ref}'`, "prepared") };
  const stopSql = await pickCandidates({ candidates: good, picks: ["c3", "c1", "c2"], register: (c) => doRegister(c.id === "c3" ? tamperedSql : c) });
  assert.deepEqual([stopSql.status, stopSql.reason, stopSql.candidate], ["STOPPED", "claim_replay_failed", "c3"]);
  console.log(`INFO bare table name, error seen: ${stopSql.detail}`);
  assert.deepEqual(tree(r.art), kept, "after both stops the run folder is byte-identical to before");
}
check("a sentence with a typed number and a SQL on a bare table both stop the run; files written before stay byte-identical");

// 7. a zero total drops the share candidate (listed, not silent); a failing SQL is not swallowed
{
  const zero = fresh(["geo,year,val", "AA,2015,0", "BB,2015,0", "AA,2023,0", "BB,2023,0"].join("\n") + "\n");
  const out = await materializeCandidates({ specs: buildCandidates({ ref: zero.ref, dimension: "geo", measure: "val", time: "year" }), runSql: zero.runSql, fill });
  assert.ok(out.dropped.some((d) => d.kind === "share_of_total"), JSON.stringify(out.dropped));
  assert.ok(out.candidates.length >= 3);
  for (const c of out.candidates) assert.doesNotMatch(c.text, /null|nan|undefined|infinity/i, `${c.id}: ${c.text}`);
  console.log(`INFO zero table dropped: ${out.dropped.map((d) => d.kind).join(", ")}`);
  await assert.rejects(() => materializeCandidates({ specs: [{ kind: "x", sql: "SELECT nope FROM", template: "{first.name}" }], runSql: zero.runSql, fill }));
}
check("a zero total drops the candidates it cannot fill (listed in dropped); a failing SQL is raised");

// 8. identifiers and determinism
assert.throws(() => buildCandidates({ ref: run.ref, dimension: 'geo"; DROP TABLE x; --', measure: "val" }), /plain identifier/);
assert.throws(() => buildCandidates({ ref: run.ref, dimension: "geo", measure: "val FROM y" }), /plain identifier/);
assert.throws(() => buildCandidates({ ref: "computations/x.json", dimension: "geo", measure: "val" }), /data\/ file name/);
assert.throws(() => buildCandidates({ ref: "data/../x.csv'; --", dimension: "geo", measure: "val" }), /data\/ file name/);
assert.deepEqual(buildCandidates({ ref: run.ref, dimension: "geo", measure: "val", time: "year" }), specs);
assert.equal(sheetRecord(candidates).path, sheetRecord((await materializeCandidates({ specs, runSql: run.runSql, fill })).candidates).path);
check("identifiers and the data reference are validated; same input, same specs and same sheet path");

// 9. the sheet is a record: candidate_only, under shadow/, no verification field, never read back
{
  const { path, record } = sheetRecord(candidates);
  assert.ok(path.startsWith(SHEET_PREFIX) && SHEET_PREFIX.startsWith("shadow/"));
  assert.equal(record.candidate_only, true);
  assert.deepEqual(Object.keys(record.candidates[0]).sort(), ["id", "kind", "sql", "template", "text"]);
  assert.doesNotMatch(JSON.stringify(record), /verified|publishable|claim_id/);
  assert.doesNotMatch(SOURCE, /node:fs|readFile|createReadStream|\bimport\(/);
  assert.deepEqual(Object.keys(cand).filter((k) => /read|load|open|reference/i.test(k)), []);
  let awaited = false;
  await writeSheet(candidates, async () => { await new Promise((r) => setTimeout(r, 5)); awaited = true; });
  assert.equal(awaited, true, "writeSheet waits for the write");
}
check("the sheet is candidate_only under shadow/, carries no verification field, the module has no reader and awaits its write");

// 10. picks
const spy = () => { const seen = []; return { seen, register: async (c) => { seen.push(c.id); return { claim_id: `claim-${c.id}`, verified: true }; } }; };
for (const [name, p] of [["number", [1, 2, 3]], ["numbered form", ["1", "2", "3"]], ["hash form", ["#1", "#2", "#3"]], ["unknown id", ["c1", "c2", "c99"]], ["duplicate", ["c1", "c1", "c2"]], ["too few", ["c1", "c2"]], ["too many", ["c1", "c2", "c3", "c4", "c5", "c6"]], ["not a list", "c1"]]) {
  const s = spy();
  const r = await pickCandidates({ candidates, picks: p, register: s.register });
  assert.equal(r.status, "refused", name);
  assert.deepEqual(s.seen, [], `${name}: nothing registered`);
}
{
  const s = spy();
  const r = await pickCandidates({ candidates, picks: ["c3", "c1", "c5"], register: s.register });
  assert.equal(r.status, "ok");
  assert.deepEqual(s.seen, ["c3", "c1", "c5"], "only the picked, in pick order");
  const seen = [];
  const stop = await pickCandidates({ candidates, picks: ["c1", "c2", "c3"], register: async (c) => { seen.push(c.id); return c.id === "c2" ? { claim_id: "x", verified: false } : { claim_id: `claim-${c.id}`, verified: true }; } });
  assert.deepEqual(stop, { status: "STOPPED", reason: "claim_replay_failed", step: "picks", kept_artifacts: true, candidate: "c2", claim_id: "x", registered: ["claim-c1"] });
  assert.deepEqual(seen, ["c1", "c2"], "no request after the stop");
  const thrown = await pickCandidates({ candidates, picks: ["c1", "c2", "c3"], register: async () => { throw new Error("DUCKDB_QUERY_FAILED: boom"); } });
  assert.equal(thrown.reason, "claim_replay_failed");
  assert.match(thrown.detail, /boom/);
}
check("picks: literal ids only (number, numbered, # forms, unknown, duplicate, count refused); only the picked are registered; a failed or throwing registration stops");

// 10b. a cut table (newsroom_data_prepare's narrow: the top codes of the open dimension and its total row)
{
  const head = "citizen,year,val";
  const members = ["AF,2023,50", "VE,2023,40", "SY,2023,30", "AF,2015,20", "VE,2015,25", "SY,2015,5"];
  const plain = [head, ...members, "TOTAL,2023,200", "TOTAL,2015,90"].join("\n") + "\n";
  const mixed = [head, ...members, "TOTAL,2023,200", "TOTAL,2015,90", "EU27_2020,2023,150", "EXT_EU27_2020,2023,190", "EU27_2020,2015,60"].join("\n") + "\n";
  const cut = { members: ["AF", "VE", "SY"], total: "TOTAL" };
  const made = async (csv, c) => {
    const r = fresh(csv);
    return { r, out: await cand.programCandidates({ ref: r.ref, dimensions: ["citizen"], measure: "val", time: "year", times: 2, runSql: r.runSql, fill, seriesMaxRows: 80, ...(c ? { cut: c } : {}) }) };
  };
  const a = await made(plain, cut);
  assert.deepEqual(a.out.conclusions.map((c) => c.kind), ["rank_top", "cut_top_share", "cut_members_share"]);
  assert.deepEqual(a.out.conclusions.map((c) => c.text), ["AF has the highest val in 2023: 50.", "AF accounts for 25 percent of the total in 2023.", "The top 3 by val together account for 60 percent of the total in 2023."]);
  for (const c of a.out.conclusions) assert.doesNotMatch(c.template, /\d/, `${c.kind} template holds no digit: the program fills the count`);
  assert.deepEqual(a.out.dropped.map((d) => d.kind).sort(), ["change_largest_fall", "change_largest_rise", "change_total", "extreme_gap", "rank_bottom", "share_of_total", "top_to_bottom_ratio"]);
  check("a cut table offers only the highest and two shares of its own total row, the count filled from the rows");
  const b = await made(mixed, cut);
  assert.deepEqual(b.out.conclusions.map((c) => c.text), a.out.conclusions.map((c) => c.text), "EU27_2020, EXT_EU27_2020 and TOTAL in the rows never reach the numerator or the ranking");
  assert.deepEqual(await b.r.runSql(b.out.conclusions[0].series_sql), await a.r.runSql(a.out.conclusions[0].series_sql));
  check("aggregate and total codes in the file leave the cut's slice, ranking and numerators unchanged");
  const none = await made(plain, { members: cut.members, total: null });
  assert.deepEqual(none.out.conclusions.map((c) => c.kind), ["rank_top"]);
  assert.ok(none.out.dropped.some((d) => d.kind === "cut_top_share" && /no total row/.test(d.why)));
  const absent = await made([head, ...members].join("\n") + "\n", cut);
  assert.deepEqual(absent.out.conclusions.map((c) => c.kind), ["rank_top"], "a total code the file lacks gives no share: the sum of the cut never stands in");
  assert.throws(() => buildCandidates({ ref: a.r.ref, dimensions: ["citizen"], measure: "val", time: "year", cut: { members: ["AF"], total: "AF" } }), /outside its members/);
  assert.throws(() => buildCandidates({ ref: a.r.ref, dimensions: ["citizen"], measure: "val", time: "year", cut: { members: ["A'F"], total: null } }), /member codes/);
  check("a cut with no total row, or a total the file lacks, offers no share; a bad cut is refused");
  const uncut = await made(mixed);
  assert.ok(!uncut.out.conclusions.some((c) => [...cand.SUM_KINDS, "cut_top_share", "cut_members_share"].includes(c.kind)), "an uncut table still offers no sum and no cut share");
  assert.ok(!buildCandidates({ ref: a.r.ref, dimension: "geo", measure: "val", time: "year" }).some((s) => s.kind.startsWith("cut_")));
  assert.deepEqual(buildCandidates({ ref: a.r.ref, dimension: "geo", measure: "val", time: "year" }).map((s) => s.sql), specs.map((s) => s.sql.replaceAll(run.ref, a.r.ref)), "uncut SQL is as before");
  check("the cut kinds appear only on a cut table; uncut tables offer no sum kind and keep their SQL");
  process.env.NEWSROOM_ARTIFACT_DIR = a.r.art; // the claim path writes in the run that holds the cut file
  const reg = registerIn(a.r);
  const done = await pickCandidates({ candidates: a.out.conclusions, picks: ["c1", "c2", "c3"], register: reg });
  assert.equal(done.status, "ok", JSON.stringify(done));
  assert.equal(claimsOf(a.r.art).length, 3, "ok means each of the three verified on the real claim path (a failed verification stops)");
  check("the three cut claims register and verify through duckdb_query and record_claim");
}

// 11. data stop
assert.equal(dataStop([{ ok: false, dataset: "A" }]), null);
assert.deepEqual(dataStop([{ ok: false, dataset: "A" }, { ok: false, dataset: "A" }]), { status: "STOPPED", reason: "data_failed", step: "data_prepare", kept_artifacts: true, failures: 2 });
assert.equal(dataStop([{ ok: false, dataset: "A" }, { ok: false, dataset: "B" }]), null);
assert.equal(dataStop([{ ok: false, dataset: "A" }, { ok: false, dataset: "B" }, { ok: false, dataset: "B" }])?.reason, "data_failed");
assert.equal(dataStop([{ ok: true, dataset: "A" }, { ok: false, dataset: "B" }]), null);
assert.throws(() => stoppedState("made_up", "x"), /unknown stop reason/);
check("data stop: the same data call failing twice is data_failed; a new dataset is not");

// 12. timing: all candidate SQL of one sheet, run once
{
  const started = performance.now();
  await materializeCandidates({ specs, runSql: run.runSql, fill });
  const ms = Math.round(performance.now() - started);
  console.log(`TIMING all ${specs.length} candidate SQL + fill: ${ms} ms (duckdb CLI, one process per query)`);
}
console.log(`PASS test_claim_candidates (${passed} groups)`);
