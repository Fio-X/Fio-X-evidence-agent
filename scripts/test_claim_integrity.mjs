// Forged inputs to claim recording. Every case must be refused with the whole
// artifact tree byte-identical before and after. Loads runtime/pi/newsroom.ts
// from a type-stripped copy; DuckDB runs the SQL; no network, no provider.
//   - data bytes vs their sidecar (default on): payload changed, sidecar missing,
//     sidecar hash wrong, payload swapped for another valid file, wrong byte count
//   - constants in claim SQL (NEWSROOM_CLAIM_SQL_LINT=1): typed number, joined,
//     in a CTE, as a string, amount*0+999, generated rows, VALUES
//   - claim templates: direction words, plus the placeholder shapes fillClaimTemplate refuses
//   - a cancel after the replay query and before the claim is written
//   - legitimate SQL (ROUND, power-of-ten factors) still records
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT as CALL_REPORT, reportRows, expectReportGrew } from "./call_report_expect.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("claim-integrity-");
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
const { lintClaimTemplate } = await import(join(pi, "claim_lint.mjs"));
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
process.env.NEWSROOM_TOOL_PROFILE = "full";

let passed = 0;
const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CSV = (rows) => ["country,year,share", ...rows].join("\n") + "\n";
const CSV_A = CSV(["Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6"]);
const CSV_A_SAME_LENGTH = CSV_A.replace("70.0", "99.0");
const CSV_B = CSV(["Chad,2022,11.0", "Guinea,2022,22.2", "Liberia,2022,33.3", "Niger,2021,44.4"]);

const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const tree = (dir) => Object.fromEntries(walk(dir).filter((f) => relative(dir, f) !== CALL_REPORT).map((f) => [relative(dir, f), sha(readFileSync(f))]).sort());

function putData(art, csv, { sidecar = {} } = {}) {
  const hash = sha(csv);
  const ref = `data/${hash}.csv`;
  mkdirSync(join(art, "data"), { recursive: true });
  writeFileSync(join(art, ref), csv);
  writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ schema_version: "0.7.0", bytes: Buffer.byteLength(csv), sha256: hash, file: ref, ...sidecar }, null, 2) + "\n");
  return ref;
}
let runs = 0;
// A fresh artifact root with one data file and a computation recorded for `sql`.
async function story(sql = (ref) => `SELECT country, year, share FROM '${ref}' ORDER BY country`) {
  runs += 1;
  const art = join(makeTestTmp(`claim-integrity-run${runs}-`), "run");
  mkdirSync(join(art, "computations"), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const ref = putData(art, CSV_A);
  const q = await tools.get("duckdb_query").execute("q", { sql: sql(ref) });
  const comp = relative(art, q.details.path ?? q.details.artifact);
  return { art, ref, comp };
}
const claimOf = (s, extra = {}) => ({ claim: "Chad had the lowest listed share in the fixture.", claim_kind: "descriptive", status: "supported", source_refs: [s.ref], computation_refs: [s.comp], ...extra });
const record = (s, extra, signal) => tools.get("record_claim").execute("c", claimOf(s, extra), signal);
const claims = (art) => (existsSync(join(art, "claims.jsonl")) ? readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean) : []);

// What a refused record_claim adds to the call report: the calls it made before it stopped, by the rule that stopped it. Every row is tool record_claim, group knowledge;
// "owner" is the callee's group ("-" = none), "A" = tool_allowed true. One list per shape of refusal; no case is left unchecked.
const callRows = (lines) => lines.map((line) => { const [fn, owner, allowed] = line.split(" "); return { tool: "record_claim", tool_group: "knowledge", function: fn, callee_owner: owner === "-" ? null : owner, declared: true, ...(allowed ? { tool_allowed: true } : {}) }; });
const RC_BYTES = callRows([
  "artifactRoot -",
  "assertDataBytesMatchRecord -",
  "evidence_gate.mjs::assertDatasetPayload knowledge A",
  "evidence_gate.mjs::assertEvidenceBackedStatus knowledge A",
  "groups.mjs::readThroughStaging system",
  "normalizeArtifactRefs -",
  "provenance.mjs::sha256Hex knowledge",
  "readRunFile -",
  "recordClaimArtifact knowledge A",
  "statRunFile -",
  "validateSourceEvidence knowledge A",
]);
const RC_SIDECAR_CITED = callRows([
  "artifactRoot -",
  "evidence_gate.mjs::assertDatasetPayload knowledge A",
  "evidence_gate.mjs::assertEvidenceBackedStatus knowledge A",
  "groups.mjs::readThroughStaging system",
  "normalizeArtifactRefs -",
  "recordClaimArtifact knowledge A",
  "statRunFile -",
  "validateSourceEvidence knowledge A",
]);
const RC_CANCEL = callRows([
  "artifactRoot -",
  "assertDataBytesMatchRecord -",
  "claimIdFor -",
  "claimSqlLintEnabled -",
  "computation_rows.mjs::deriveComputationInputs knowledge A",
  "computation_rows.mjs::duckdbBundledExtensionArgs knowledge",
  "computation_rows.mjs::materializeComputationRowTables knowledge A",
  "computation_rows.mjs::recordedInputState knowledge A",
  "deriveInputsForSql -",
  "duckDbRun - A",
  "evidence_gate.mjs::assertComputationBoundToSources knowledge A",
  "evidence_gate.mjs::assertDatasetPayload knowledge A",
  "evidence_gate.mjs::assertEvidenceBackedStatus knowledge A",
  "evidence_gate.mjs::deriveClaimVerification knowledge A",
  "evidence_gate.mjs::evaluateClaimSupport knowledge",
  "groups.mjs::readThroughStaging system",
  "groups.mjs::runDeclared system",
  "lintClaimSql -",
  "normalizeArtifactRefs -",
  "process.mjs::runProcess system",
  "provenance.mjs::computationRelativePath knowledge",
  "provenance.mjs::sha256Hex knowledge",
  "queryDuckDb knowledge A",
  "readArtifactJson -",
  "readRunFile -",
  "recordClaimArtifact knowledge A",
  "replayComputationEvidence knowledge A",
  "replayRecordedComputation -",
  "serializeSqlAst -",
  "stableId -",
  "statRunFile -",
  "validateReadOnlySql -",
  "validateSourceEvidence knowledge A",
  "viz.mjs::hashRows visual",
]);
const RC_REPLAY = callRows([
  "artifactRoot -",
  "assertDataBytesMatchRecord -",
  "claimSqlLintEnabled -",
  "computation_rows.mjs::deriveComputationInputs knowledge A",
  "computation_rows.mjs::duckdbBundledExtensionArgs knowledge",
  "computation_rows.mjs::materializeComputationRowTables knowledge A",
  "computation_rows.mjs::recordedInputState knowledge A",
  "deriveInputsForSql -",
  "duckDbRun - A",
  "evidence_gate.mjs::assertComputationBoundToSources knowledge A",
  "evidence_gate.mjs::assertDatasetPayload knowledge A",
  "evidence_gate.mjs::assertEvidenceBackedStatus knowledge A",
  "groups.mjs::readThroughStaging system",
  "groups.mjs::runDeclared system",
  "lintClaimSql -",
  "normalizeArtifactRefs -",
  "process.mjs::runProcess system",
  "provenance.mjs::computationRelativePath knowledge",
  "provenance.mjs::sha256Hex knowledge",
  "queryDuckDb knowledge A",
  "readArtifactJson -",
  "readRunFile -",
  "recordClaimArtifact knowledge A",
  "replayComputationEvidence knowledge A",
  "replayRecordedComputation -",
  "serializeSqlAst -",
  "statRunFile -",
  "validateReadOnlySql -",
  "validateSourceEvidence knowledge A",
  "viz.mjs::hashRows visual",
]);
const RC_LINT = callRows([
  "artifactRoot -",
  "assertDataBytesMatchRecord -",
  "claimSqlLintEnabled -",
  "claim_lint.mjs::lintClaimSqlAst knowledge",
  "evidence_gate.mjs::assertDatasetPayload knowledge A",
  "evidence_gate.mjs::assertEvidenceBackedStatus knowledge A",
  "groups.mjs::readThroughStaging system",
  "groups.mjs::runDeclared system",
  "lintClaimSql -",
  "normalizeArtifactRefs -",
  "process.mjs::runProcess system",
  "provenance.mjs::sha256Hex knowledge",
  "readArtifactJson -",
  "readRunFile -",
  "recordClaimArtifact knowledge A",
  "replayComputationEvidence knowledge A",
  "replayRecordedComputation -",
  "serializeSqlAst -",
  "statRunFile -",
  "validateReadOnlySql -",
  "validateSourceEvidence knowledge A",
]);
// each refusal case by its label; a case missing here fails the test
const RC_FOR = new Map([
  ["payload changed, sidecar did not", RC_BYTES],
  ["sidecar missing", RC_BYTES],
  ["sidecar unreadable", RC_BYTES],
  ["sidecar hash wrong", RC_BYTES],
  ["sidecar without sha256", RC_BYTES],
  ["sidecar byte count wrong", RC_BYTES],
  ["sidecar names another file", RC_BYTES],
  ["payload swapped, own sidecar kept", RC_BYTES],
  ["payload and sidecar both swapped", []],
  ["sidecar cited as the source", RC_SIDECAR_CITED],
  ["cancel after the replay query", RC_CANCEL],
  ["reordered rows", RC_REPLAY],
  ["a changed result", RC_REPLAY],
  ["lint on: a typed number", RC_LINT],
  ["lint on: a constant joined in", RC_LINT],
  ["lint on: a constant inside a CTE", RC_LINT],
  ["lint on: a constant in a subquery", RC_LINT],
  ["lint on: a number as a string", RC_LINT],
  ["lint on: a string with a digit among text", RC_LINT],
  ["lint on: amount*0+999", RC_LINT],
  ["lint on: a constant in a set operation", RC_LINT],
  ["lint on: generate_series", RC_LINT],
  ["lint on: range", RC_LINT],
  ["lint on: a VALUES list", RC_LINT],
  ["regexp_replace replacement", RC_LINT],
  ["lint on: a CASE result number", RC_LINT],
  ["lint on: SUM over a CASE of numbers", RC_LINT],
  ["lint on: the LAG default", RC_LINT],
  ["lint on: a COALESCE fallback", RC_LINT],
  ["lint on: an IFNULL fallback", RC_LINT],
  ["lint on: two constants compared", RC_LINT],
  ["lint on: a constant BETWEEN constants", RC_LINT],
  ["lint on: a constant IN constants", RC_LINT],
  ["lint on: a constant LIKE a constant", RC_LINT],
  ["lint on: a GREATEST floor", RC_LINT],
  ["lint on: a LEAST cap", RC_LINT],
  ["lint on: a number beside a comparison", RC_LINT],
  ["lint on: a typed number in a comparison's arithmetic", RC_LINT],
  ["lint on: the NULLIF first argument", RC_LINT],
  ["lint on: a substr input", RC_LINT],
]);
async function refuses(label, s, pattern, { extra, signal, before = tree(s.art) } = {}) {
  const rowsBefore = reportRows(s.art);
  await assert.rejects(() => record(s, extra, signal), pattern, label);
  assert.deepEqual(tree(s.art), before, `${label}: the artifact tree is unchanged`);
  assert.ok(RC_FOR.has(label), `${label}: the rows its refusal adds to the call report are stated`);
  expectReportGrew(s.art, rowsBefore, RC_FOR.get(label), label);
  assert.deepEqual(claims(s.art), [], `${label}: no claim line`);
}

delete process.env.NEWSROOM_CLAIM_SQL_LINT;

// ---- data bytes (default on) ---------------------------------------------------
{
  const intact = await story();
  const ok = await record(intact);
  assert.equal(ok.details.verification?.publishable ?? ok.details.record?.status === "verified", true);
  assert.equal(claims(intact.art).length, 1);
  check("intact data and sidecar: the claim records and verifies");
}
const BYTES = /^Error: INVALID_SOURCE_EVIDENCE: data bytes do not match their record/;
{ // payload changed, same length, sidecar not
  const s = await story();
  writeFileSync(join(s.art, s.ref), CSV_A_SAME_LENGTH);
  assert.equal(CSV_A_SAME_LENGTH.length, CSV_A.length);
  await refuses("payload changed, sidecar did not", s, new RegExp(`${BYTES.source.slice(0, -0)}`.replace(/\)$/, "") + "[^]*file name hash differs"));
  check("refused: payload changed to the same length, sidecar untouched");
}
{ // sidecar missing
  const s = await story();
  rmSync(join(s.art, `${s.ref}.meta.json`));
  await refuses("sidecar missing", s, /sidecar is missing or unreadable/);
  check("refused: sidecar missing");
}
{ // sidecar unreadable
  const s = await story();
  writeFileSync(join(s.art, `${s.ref}.meta.json`), "{not json");
  await refuses("sidecar unreadable", s, /sidecar is missing or unreadable/);
  check("refused: sidecar not valid JSON");
}
{ // sidecar hash wrong
  const s = await story();
  writeFileSync(join(s.art, `${s.ref}.meta.json`), JSON.stringify({ bytes: Buffer.byteLength(CSV_A), sha256: sha("other"), file: s.ref }));
  await refuses("sidecar hash wrong", s, /sidecar sha256 differs from the bytes/);
  check("refused: sidecar sha256 is not the file's");
}
{ // sidecar without a hash
  const s = await story();
  writeFileSync(join(s.art, `${s.ref}.meta.json`), JSON.stringify({ bytes: Buffer.byteLength(CSV_A), file: s.ref }));
  await refuses("sidecar without sha256", s, /sidecar has no sha256/);
  check("refused: sidecar without a sha256");
}
{ // sidecar byte count wrong
  const s = await story();
  writeFileSync(join(s.art, `${s.ref}.meta.json`), JSON.stringify({ bytes: 5, sha256: sha(CSV_A), file: s.ref }));
  await refuses("sidecar byte count wrong", s, /sidecar byte count differs from the file size/);
  check("refused: sidecar byte count is not the file size");
}
{ // sidecar names another file
  const s = await story();
  writeFileSync(join(s.art, `${s.ref}.meta.json`), JSON.stringify({ bytes: Buffer.byteLength(CSV_A), sha256: sha(CSV_A), file: "data/elsewhere.csv" }));
  await refuses("sidecar names another file", s, /sidecar describes a different file/);
  check("refused: sidecar describes a different file");
}
{ // payload swapped for another valid file (its own sidecar copied over, and not copied)
  const s = await story();
  const other = putData(s.art, CSV_B);
  writeFileSync(join(s.art, s.ref), readFileSync(join(s.art, other)));
  await refuses("payload swapped, own sidecar kept", s, /file name hash differs from the bytes/);
  writeFileSync(join(s.art, `${s.ref}.meta.json`), readFileSync(join(s.art, `${other}.meta.json`)));
  await refuses("payload and sidecar both swapped", s, /file name hash differs from the bytes|sidecar describes a different file/);
  check("refused: payload swapped for another valid file, with or without its sidecar");
}
{ // a ref that is itself a sidecar or an origin record is not a payload (existing rule, kept)
  const s = await story();
  await refuses("sidecar cited as the source", s, /dataset metadata is not a data payload/, { extra: { source_refs: [`${s.ref}.meta.json`] } });
  check("refused: a sidecar cited as the data (existing rule still first)");
}
{ // changed after the replay started is caught by the second check: a cancel after the query shows the same stop point
  const s = await story();
  const flag = join(s.art, "..", "query-done.flag");
  const real = process.env.NEWSROOM_DUCKDB_BIN || "duckdb";
  const wrapper = join(s.art, "..", "wrap-duckdb.sh");
  writeFileSync(wrapper, `#!/bin/sh\n${JSON.stringify(real)} "$@"\nrc=$?\ncase "$*" in *json_serialize_sql*) ;; *) touch ${JSON.stringify(flag)} ;; esac\nexit $rc\n`);
  chmodSync(wrapper, 0o755);
  process.env.NEWSROOM_DUCKDB_BIN = wrapper;
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "aborted", { get: () => existsSync(flag) });
  try {
    await refuses("cancel after the replay query", s, /CLAIM_ABORTED: the call was cancelled; no claim was recorded/, { signal: controller.signal });
  } finally { delete process.env.NEWSROOM_DUCKDB_BIN; }
  assert.ok(existsSync(flag), "the replay query really ran before the cancel");
  check("refused: cancelled after the replay query and before the claim line, nothing written");
}

// ---- replay row order (default on) -----------------------------------------------
{ // a replay that returns the same rows in another order says so; a changed value does not
  const rewrite = (to) => {
    const real = process.env.NEWSROOM_DUCKDB_BIN || "duckdb";
    const wrapper = join(makeTestTmp("claim-integrity-wrap-"), "wrap-duckdb.py");
    writeFileSync(wrapper, `#!/usr/bin/env python3\nimport os, sys\nargs = sys.argv[1:]\nif not any("json_serialize_sql" in a for a in args):\n    args = [a.replace("ORDER BY country", ${JSON.stringify(to)}) for a in args]\nos.execvp(${JSON.stringify(real)}, [${JSON.stringify(real)}] + args)\n`);
    chmodSync(wrapper, 0o755);
    return wrapper;
  };
  const HINT = /the same rows came back in another order: add a top-level ORDER BY over every key column so the order is total/;
  for (const [label, to, pattern] of [["reordered rows", "ORDER BY country DESC", HINT], ["a changed result", "ORDER BY country DESC LIMIT 3", /^Error: COMPUTATION_REPLAY_FAILED: deterministic result changed: computations\/[0-9a-f]{64}\.json$/]]) {
    const s = await story();
    process.env.NEWSROOM_DUCKDB_BIN = rewrite(to);
    try { await refuses(label, s, pattern); } finally { delete process.env.NEWSROOM_DUCKDB_BIN; }
  }
  check("a replay with the same rows in another order is refused with the ORDER BY hint; a replay with a changed result is refused without it");
}
{ // duckdb_query tells the model when a multi-row result has no top-level ORDER BY
  const run = async (sql) => {
    const s = await story(sql);
    return tools.get("duckdb_query").execute("q", { sql: sql(s.ref) });
  };
  const body = async (sql) => JSON.parse((await run(sql)).content[0].text);
  const NOTE = /^No top-level ORDER BY: row order is not guaranteed/;
  assert.match((await body((r) => `SELECT year, COUNT(*) AS n FROM '${r}' GROUP BY year`)).order_note, NOTE, "multi-row GROUP BY without ORDER BY");
  assert.match((await body((r) => `SELECT country FROM '${r}'`)).order_note, NOTE, "a plain multi-row scan");
  assert.equal((await body((r) => `SELECT year, COUNT(*) AS n FROM '${r}' GROUP BY year ORDER BY year`)).order_note, undefined, "ORDER BY present");
  assert.equal((await body((r) => `SELECT year FROM '${r}' ORDER BY year LIMIT 2`)).order_note, undefined, "ORDER BY with LIMIT");
  assert.equal((await body((r) => `SELECT country FROM '${r}' UNION ALL SELECT country FROM '${r}' ORDER BY 1`)).order_note, undefined, "ORDER BY over a set operation");
  assert.equal((await body((r) => `SELECT COUNT(*) AS n FROM '${r}'`)).order_note, undefined, "a 1-row result");
  assert.equal((await body((r) => `SELECT country FROM '${r}' WHERE country = 'ORDER BY'`)).order_note, undefined, "no rows, and the text 'ORDER BY' in a string is not an ORDER BY");
  const direct = await body((r) => `SELECT country, share FROM '${r}' ORDER BY country`);
  // The key list is exact in both shapes: the old one by default, the budgeted one with NEWSROOM_DEFAULT_RESULT_BUDGET=1.
  const keysWanted = process.env.NEWSROOM_DEFAULT_RESULT_BUDGET === "1" ? ["row_count", "columns", "preview_rows", "artifact_ref", "result_hash", "truncated_for_model"] : ["row_count", "rows", "artifact"];
  assert.deepEqual(Object.keys(direct), keysWanted, "the rest of the result is unchanged");
  check("duckdb_query adds order_note for a multi-row result with no top-level ORDER BY (read from the parse); absent with ORDER BY (also LIMIT, set operations), absent for 1 row; the rest of the result unchanged");
}
// ---- constants in claim SQL (opt-in) -------------------------------------------
const FORGED_SQL = [
  ["a typed number", (r) => `SELECT country, 999 AS share FROM '${r}'`],
  ["a constant joined in", (r) => `SELECT d.country, k.share FROM '${r}' d CROSS JOIN (SELECT 999 AS share) k`],
  ["a constant inside a CTE", (r) => `WITH t AS (SELECT country, 999 AS share FROM '${r}') SELECT country, share FROM t`],
  ["a constant in a subquery", (r) => `SELECT country, (SELECT 999) AS share FROM '${r}'`],
  ["a number as a string", (r) => `SELECT country, '999' AS share FROM '${r}'`],
  ["a string with a digit among text", (r) => `SELECT country, 'about 999 units' AS share FROM '${r}'`],
  ["amount*0+999", (r) => `SELECT country, share*0+999 AS share FROM '${r}'`],
  ["a constant in a set operation", (r) => `SELECT country, share FROM '${r}' UNION ALL SELECT 'Atlantis', 999`],
  ["generate_series", (r) => `SELECT d.country, g.x AS share FROM '${r}' d, generate_series(1, 3) g(x)`],
  ["range", (r) => `SELECT d.country, g.range AS share FROM '${r}' d, range(3) g`],
  ["a VALUES list", (r) => `SELECT d.country, v.share FROM '${r}' d, (VALUES (999)) v(share)`],
];
for (const [label, sql] of FORGED_SQL) {
  delete process.env.NEWSROOM_CLAIM_SQL_LINT;
  const s = await story(sql);
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  await refuses(`lint on: ${label}`, s, /^Error: CLAIM_SQL_CONSTANT: /);
  delete process.env.NEWSROOM_CLAIM_SQL_LINT;
  await record(s); // switch off: the same SQL records (default behaviour unchanged)
  assert.equal(claims(s.art).length, 1, `lint off: ${label} still records`);
}
check(`refused with NEWSROOM_CLAIM_SQL_LINT=1 and nothing written; recorded as before with it off: ${FORGED_SQL.map(([l]) => l).join("; ")}`);
{ // the message names the expression and says where the number must come from
  const s = await story((r) => `SELECT country, share*0+999 AS share FROM '${r}'`);
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  await assert.rejects(() => record(s), /CLAIM_SQL_CONSTANT: the select-list expression \(\(share \* 0\) \+ 999\) \(AS share\) holds the constant 0.*must come from the data/);
  delete process.env.NEWSROOM_CLAIM_SQL_LINT;
  check("the error names the expression and says the number must come from the data");
}
{ // regex patterns are exempt, a regexp_replace replacement is not
  const rx = (expr) => (r) => `SELECT country, ${expr} AS share FROM '${r}'`;
  const s1 = await story(rx("length(regexp_extract(country, '^(.*?)[0-9]{2,}(-?[0-9]+)$', 1))"));
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  try { await record(s1); } finally { delete process.env.NEWSROOM_CLAIM_SQL_LINT; }
  assert.equal(claims(s1.art).length, 1, "a regexp_extract pattern with digits records");
  const s2 = await story(rx("regexp_replace(country, 'x', '999')"));
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  try { await refuses("regexp_replace replacement", s2, /^Error: CLAIM_SQL_CONSTANT: /); } finally { delete process.env.NEWSROOM_CLAIM_SQL_LINT; }
  check("regexp_extract pattern with digits passes; regexp_replace(col, 'x', '999') is refused");
}
const LEGIT_SQL = [
  ["ROUND precision", (r) => `SELECT country, ROUND(share, 1) AS share FROM '${r}'`],
  ["power-of-ten factor", (r) => `SELECT country, share*100 AS share FROM '${r}'`],
  ["power-of-ten divisor", (r) => `SELECT country, share/1000 AS share FROM '${r}'`],
  ["decimal power of ten", (r) => `SELECT country, share*0.01 AS share FROM '${r}'`],
  ["ROUND over a scaled share", (r) => `SELECT country, ROUND(share*100/SUM(share) OVER (), 2) AS share FROM '${r}'`],
  ["LIMIT and OFFSET", (r) => `SELECT country, share FROM '${r}' ORDER BY share LIMIT 3 OFFSET 1`],
  ["WHERE, HAVING comparisons", (r) => `SELECT country, share FROM '${r}' WHERE share > 50 AND year = 2022`],
  ["a join condition", (r) => `SELECT a.country, b.share FROM '${r}' a JOIN '${r}' b ON a.country = b.country AND b.year > 2000`],
  ["aggregate and GROUP BY", (r) => `SELECT year, COUNT(*) AS share FROM '${r}' GROUP BY year HAVING COUNT(*) > 0 ORDER BY year`],
  ["LAG with an offset", (r) => `SELECT year, share - LAG(share, 1) OVER (ORDER BY year) AS share FROM '${r}'`],
  ["LAG without an offset", (r) => `SELECT year, share - LAG(share) OVER (ORDER BY year) AS share FROM '${r}'`],
  ["a frame bound", (r) => `SELECT year, AVG(share) OVER (ORDER BY year ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS share FROM '${r}'`],
  ["quantile_cont(v, 0.5)", (r) => `SELECT quantile_cont(share, 0.5) AS share FROM '${r}'`],
  ["a list of quantiles", (r) => `SELECT quantile_cont(share, [0.25, 0.75]) AS share FROM '${r}'`],
  ["percentile_cont WITHIN GROUP", (r) => `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY share) AS share FROM '${r}'`],
  ["median()", (r) => `SELECT median(share) AS share FROM '${r}'`],
  ["ntile(4)", (r) => `SELECT country, ntile(4) OVER (ORDER BY share) AS share FROM '${r}'`],
  ["a share over NULLIF(b, 0)", (r) => `SELECT country, 100.0 * share / NULLIF(year, 0) AS share FROM '${r}'`],
  ["COUNT(*) FILTER", (r) => `SELECT COUNT(*) FILTER (WHERE share > 0) AS share FROM '${r}'`],
  ["count_if", (r) => `SELECT count_if(share > 0) AS share FROM '${r}'`],
  ["a text CASE with a comparison", (r) => `SELECT country, CASE WHEN share > 0 THEN 'gain' ELSE 'loss' END AS share FROM '${r}'`],
  ["comparison operands in a select list", (r) => `SELECT country, share BETWEEN 1 AND 9 AS a, year IN (2019, 2020) AS b, country LIKE 'A%2' AS c, year <> 2021 AS d FROM '${r}'`],
  ["comparisons beside data", (r) => `SELECT country, share > 5 AS a, year IN (2020, 2024) AS b, CAST(year AS VARCHAR) = '2024' AS c, share BETWEEN 1 AND 10 AS d, country LIKE 'A%' AS e, 5 < share AS f FROM '${r}'`],
  ["substr positions", (r) => `SELECT CAST(substr(CAST(year AS VARCHAR), 1, 4) AS INTEGER) AS share FROM '${r}'`],
  ["bin by floor", (r) => `SELECT floor(share / 10) * 10 AS share, COUNT(*) AS n FROM '${r}' GROUP BY 1 ORDER BY 1`],
  ["rank()", (r) => `SELECT country, RANK() OVER (ORDER BY share DESC) AS share FROM '${r}'`],
];
for (const [label, sql] of LEGIT_SQL) {
  const s = await story(sql);
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  try { await record(s); } catch (e) { throw new Error(`${label}: ${e.message}`); } finally { delete process.env.NEWSROOM_CLAIM_SQL_LINT; }
  assert.equal(claims(s.art).length, 1, `lint on: ${label} records`);
}
check(`still records with the lint on: ${LEGIT_SQL.map(([l]) => l).join("; ")}`);
{ // the exemptions name comparisons, offsets, positions and probabilities only
  const STILL_REFUSED = [
    ["a CASE result number", (r) => `SELECT country, CASE WHEN share > 0 THEN 999 ELSE 0 END AS share FROM '${r}'`, /count_if\(condition\) or COUNT\(\*\) FILTER \(WHERE condition\)/],
    ["SUM over a CASE of numbers", (r) => `SELECT SUM(CASE WHEN share > 0 THEN 1 ELSE 0 END) AS share FROM '${r}'`, /count_if\(condition\)/],
    ["the LAG default", (r) => `SELECT year, LAG(share, 1, 999) OVER (ORDER BY year) AS share FROM '${r}'`, /holds the constant 999/],
    ["a COALESCE fallback", (r) => `SELECT country, COALESCE(share, 0) AS share FROM '${r}'`, /holds the constant 0/],
    ["an IFNULL fallback", (r) => `SELECT country, IFNULL(share, 7) AS share FROM '${r}'`, /holds the constant 7/],
    ["two constants compared", (r) => `SELECT country, (1 = 1)::INT + (2 = 2)::INT AS share FROM '${r}'`, /holds the constant/],
    ["a constant BETWEEN constants", (r) => `SELECT country, (5 BETWEEN 1 AND 10)::INT AS share FROM '${r}'`, /holds the constant/],
    ["a constant IN constants", (r) => `SELECT country, (3 IN (1, 2, 3))::INT AS share FROM '${r}'`, /holds the constant/],
    ["a constant LIKE a constant", (r) => `SELECT country, ('a' LIKE 'a')::INT AS share FROM '${r}'`, /holds the constant/],
    ["a GREATEST floor", (r) => `SELECT country, GREATEST(share, 999) AS share FROM '${r}'`, /holds the constant 999/],
    ["a LEAST cap", (r) => `SELECT country, LEAST(share, 999) AS share FROM '${r}'`, /holds the constant 999/],
    ["a number beside a comparison", (r) => `SELECT country, CAST(share > 1 AS INTEGER) * 999 AS share FROM '${r}'`, /holds the constant 999/],
    ["a typed number in a comparison's arithmetic", (r) => `SELECT country, share > 5 + 999 AS share FROM '${r}'`, /holds the constant/],
    ["the NULLIF first argument", (r) => `SELECT NULLIF(999, share) AS share FROM '${r}'`, /holds the constant 999/],
    ["a substr input", (r) => `SELECT substr('12345', 1, 2) AS share FROM '${r}'`, /holds the constant/],
  ];
  for (const [label, sql, pattern] of STILL_REFUSED) {
    const s = await story(sql);
    process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
    try { await refuses(`lint on: ${label}`, s, pattern); } finally { delete process.env.NEWSROOM_CLAIM_SQL_LINT; }
  }
  check(`still refused with the lint on, nothing written: ${STILL_REFUSED.map(([l]) => l).join("; ")}`);
  // DuckDB itself rejects a probability outside [-1, 1], so these are checked on the parse alone.
  const { lintClaimSqlAst } = await import(join(pi, "claim_lint.mjs"));
  const parse = (sql) => JSON.parse(spawnSync("duckdb", ["-noheader", "-list", ":memory:", "-c", `SELECT json_serialize_sql('${sql.replace(/'/g, "''")}', skip_null := true, skip_empty := true)`], { encoding: "utf8" }).stdout.trim());
  for (const [label, sql, violations] of [
    ["quantile_cont(v, 5)", "SELECT quantile_cont(v, 5) AS m FROM 'data/x.csv'", 1],
    ["quantile_cont(v, 1)", "SELECT quantile_cont(v, 1) AS m FROM 'data/x.csv'", 1],
    ["a list with 1.5", "SELECT quantile_cont(v, [0.5, 1.5]) AS m FROM 'data/x.csv'", 1],
    ["a non-integer position", "SELECT substr(c, 1.5, 4) AS m FROM 'data/x.csv'", 1],
    ["quantile_cont(v, 0.5)", "SELECT quantile_cont(v, 0.5) AS m FROM 'data/x.csv'", 0],
  ]) assert.equal(lintClaimSqlAst(parse(sql)).length, violations, label);
  check("a quantile probability must lie strictly between 0 and 1: 5, 1 and a list holding 1.5 are refused, 0.5 passes");
}

// ---- templates -------------------------------------------------------------------
{
  const dirs = [
    ["{max.x} next to 'lowest'", "The lowest value is {max.share}.", 1],
    ["{max.x} next to 'least'", "{max.share.country} has the least share.", 1],
    ["{max.x} next to 'smallest', 'fewest'", "The smallest figure, {first.share}; {max.share} is the fewest.", 1],
    ["{max.x} next to 最低", "最低的是{max.share.country}。", 1],
    ["{max.x} next to 最少 / 最小", "{max.share}是最少的，也是最小的。", 1],
    ["{min.x} next to 'highest'", "The highest value is {min.share}.", 1],
    ["{min.x} next to 'most', 'largest', 'greatest'", "{min.share.country} has the most, the largest and the greatest.", 1],
    ["{min.x} next to 最高", "最高的是{min.share.country}。", 1],
    ["{min.x} next to 最多 / 最大", "{min.share}是最多的；最大的也是它。", 1],
  ];
  for (const [label, template, expected] of dirs) assert.equal(lintClaimTemplate(template).length >= expected, true, `refused: ${label}`);
  for (const ok of ["The highest value is {max.share}.", "The lowest value is {min.share}.", "{max.share.country} is highest, {min.share.country} is lowest.", "最高的是{max.share.country}。最低的是{min.share.country}。", "The range is {min.share} to {max.share}."]) assert.deepEqual(lintClaimTemplate(ok), [], `passes: ${ok}`);
  assert.deepEqual(lintClaimTemplate("The most recent value is {first.share}."), [], "most beside a first. placeholder is not a direction");
  for (const ok of ["{min.share.country} had the lowest share in the most recent year", "{max.growth.country} leads the least developed countries", "{min.x.country} has at most {min.x}", "{max.x.country} has the highest share, at least by this measure", "{min.x.country} was lowest most recently"]) assert.deepEqual(lintClaimTemplate(ok), [], `passes: ${ok}`);
  for (const bad of ["{max.x.country} had the lowest share in the most recent year", "{max.x.country} has at most the lowest share"]) assert.equal(lintClaimTemplate(bad).length, 1, `still refused: ${bad}`);
  check("'most recent(ly)', 'at most', 'at least', 'least developed' are not direction words; a real lowest/highest beside the wrong placeholder is still refused");
  check("lintClaimTemplate refuses max with lowest/least/smallest/fewest/最低/最少/最小 and min with highest/most/largest/greatest/最高/最多/最大 in one clause, and passes the matching pairs and split clauses");
  for (const ok of [
    "Among the African countries, {max.a.country} has the highest share at {max.a}% ({max.a.year} data) and {min.a.country} the lowest at {min.a}% ({min.a.year} data).",
    "{max.a.country} has the highest and {min.a.country} the lowest.",
    "从{min.x}升至最高的{max.x}。",
    "The highest value was {max.x}.",
  ]) assert.deepEqual(lintClaimTemplate(ok), [], `passes: ${ok}`);
  for (const bad of ["{max.x.country} has the lowest share.", "最高的是{min.x.entity}。", "The lowest value is {max.share}."]) assert.equal(lintClaimTemplate(bad).length, 1, `refused: ${bad}`);
  check("direction words pair with the nearest max/min placeholder on either side: Congo/Mauritania, 'highest and lowest', 从{min}升至最高的{max} pass; '{max} has the lowest', 最高的是{min} refused");
  const { fillClaimTemplate } = mod;
  const rows = [{ country: "A", share: 1 }, { country: "A", share: 2 }, { country: "B", share: 3 }];
  for (const [label, template, pattern] of [
    ["a duplicate key selector", "The value is {share@country=A}.", /2 result rows have country = A/],
    ["{max..x}", "The value is {max..share}.", /CLAIM_TEMPLATE_ERROR/],
    ["{max.x.}", "The value is {max.share.}.", /CLAIM_TEMPLATE_ERROR/],
    ["{@}", "The value is {@}.", /CLAIM_TEMPLATE_ERROR/],
    ["nested braces", "The value is {max.{share}}.", /CLAIM_TEMPLATE_ERROR/],
    ["an unmatched brace", "The value is {max.share.", /unmatched/],
  ]) assert.throws(() => fillClaimTemplate(template, rows, ["share"]), pattern, label);
  check("refused by the template filler: duplicate key selector, {max..x}, {max.x.}, {@}, nested braces, unmatched brace");
}
console.log(`claim integrity: ${passed} checks PASS`);
