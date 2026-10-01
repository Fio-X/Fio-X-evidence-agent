// Regression tests for issue #36: a computation over a model-typed literal
// table (VALUES, constants, generate_series) must never make a claim verified,
// and a computation's binding to cited sources must come from the files its SQL
// actually reads, not from the directory-wide evidence snapshot.
//
// Drives the real duckdb_query and record_claim tool handlers (runtime/pi/
// newsroom.ts with types stripped, Pi packages stubbed) against real DuckDB.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSqlReads } from "../runtime/pi/computation_rows.mjs";
import { computationRelativePath } from "../runtime/pi/provenance.mjs";
import { hashRows } from "../runtime/pi/viz.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "computation-binding-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));

  const art = join(tmp, "artifact");
  for (const dir of ["data", "sources", "computations", "runtime/query-rows"]) mkdirSync(join(art, dir), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";

  const csv = Buffer.from("country,value\nA,1\nB,2\n");
  const dataRef = `data/${sha(csv)}.csv`;
  writeFileSync(join(art, dataRef), csv);
  const other = Buffer.from("country,value\nC,3\n");
  const otherRef = `data/${sha(other)}.csv`;
  writeFileSync(join(art, otherRef), other);
  for (const [ref, bytes] of [[dataRef, csv], [otherRef, other]]) {
    writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ file: ref, sha256: sha(bytes), bytes: bytes.length }));
  }

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  const query = tools.get("duckdb_query");
  const claim = tools.get("record_claim");
  assert.ok(query && claim, "duckdb_query and record_claim must register");
  const computationFiles = () => readdirSync(join(art, "computations")).filter((name) => name.endsWith(".json"));
  const readRecord = (ref) => JSON.parse(readFileSync(join(art, ref), "utf8"));
  const runQuery = async (sql) => relative(art, (await query.execute("q", { sql })).details.path);
  const recordClaim = (status, sourceRefs, computationRefs) => claim.execute("c", {
    claim: "A is 1", claim_kind: "quantitative", status, source_refs: sourceRefs, computation_refs: computationRefs,
  });
  const claimsOnDisk = () => {
    try { return readFileSync(join(art, "claims.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
  };

  // (b) A computation that reads the cited data file is bound and verifies.
  const boundRef = await runQuery(`SELECT country, value FROM read_csv_auto('${dataRef}') ORDER BY country`);
  const bound = readRecord(boundRef);
  assert.equal(bound.input_binding, "source_bound");
  assert.deepEqual(bound.read_inputs, [{ path: dataRef, sha256: sha(csv) }], "only the file the SQL read is recorded");
  assert.ok(bound.input_fingerprints.length >= 2, "legacy input_fingerprints stay (directory-wide)");
  await recordClaim("supported", [dataRef], [boundRef]);
  let claims = claimsOnDisk();
  assert.equal(claims.at(-1).status, "verified");
  assert.equal(claims.at(-1).verification.computation_replayed, true);

  // A claim citing a data file the SQL did not read is refused, although that
  // file exists in the artifact (the old directory-wide binding accepted it).
  await assert.rejects(recordClaim("supported", [otherRef], [boundRef]), /COMPUTATION_PROVENANCE_REQUIRED/);

  // (a) A VALUES-only query is blocked at query time while inline rows have no input.
  await assert.rejects(query.execute("q", { sql: "SELECT * FROM (VALUES ('A', 1), ('B', 2)) t(country, value)" }), /SYNTHETIC_DATA_BLOCKED/);
  assert.equal(computationFiles().length, 1, "a blocked query must not write a computation record");

  // (a) A literal-only computation record (as written by an older build that
  // had no binding) plus an unrelated cited source never ends verified.
  const literalSql = "SELECT 'A' AS country, 1 AS value";
  const literalRows = [{ country: "A", value: 1 }];
  const literalHash = hashRows(literalRows);
  const snapshotHash = bound.input_snapshot_hash;
  const literalRef = computationRelativePath(literalSql, snapshotHash, literalHash);
  const legacyRecord = { schema_version: "0.7.0", sql: literalSql, input_snapshot_hash: snapshotHash, input_fingerprints: bound.input_fingerprints, result_hash: literalHash, rows: literalRows };
  writeFileSync(join(art, literalRef), JSON.stringify(legacyRecord));
  const before = claimsOnDisk().length;
  await assert.rejects(recordClaim("supported", [dataRef], [literalRef]), /COMPUTATION_PROVENANCE_REQUIRED/);
  // Same record with an honest literal_only binding is refused too.
  writeFileSync(join(art, literalRef), JSON.stringify({ ...legacyRecord, read_inputs: [], input_binding: "literal_only" }));
  await assert.rejects(recordClaim("supported", [dataRef], [literalRef]), /COMPUTATION_PROVENANCE_REQUIRED/);
  // A forged source_bound label is caught by re-deriving the inputs from the SQL.
  writeFileSync(join(art, literalRef), JSON.stringify({ ...legacyRecord, read_inputs: [{ path: dataRef, sha256: sha(csv) }], input_binding: "source_bound" }));
  await assert.rejects(recordClaim("supported", [dataRef], [literalRef]), /COMPUTATION_PROVENANCE_REQUIRED/);
  assert.equal(claimsOnDisk().length, before, "no claim may be recorded over a literal-only computation");
  // A non-supported status never claims computation_replayed.
  await recordClaim("hypothesis", [dataRef], [literalRef]);
  const hypothesis = claimsOnDisk().at(-1);
  assert.notEqual(hypothesis.status, "verified");
  assert.equal(hypothesis.verification.computation_replayed, false);

  // Chained computation: bound when it reads a bound computation, refused when
  // the upstream computation is literal-only.
  const chainRef = await runQuery(`SELECT sum(value) AS total FROM read_json('${boundRef}')`);
  assert.equal(readRecord(chainRef).input_binding, "source_bound");
  assert.deepEqual(readRecord(chainRef).read_inputs.map((i) => i.path), [boundRef]);
  await recordClaim("supported", [dataRef], [chainRef]);
  assert.equal(claimsOnDisk().at(-1).status, "verified");
  writeFileSync(join(art, literalRef), JSON.stringify({ ...legacyRecord, read_inputs: [], input_binding: "literal_only" }));
  const literalChainRef = await runQuery(`SELECT count(*) AS n FROM read_json('${literalRef}')`);
  assert.equal(readRecord(literalChainRef).input_binding, "literal_only");
  await assert.rejects(recordClaim("supported", [dataRef], [literalChainRef]), /COMPUTATION_PROVENANCE_REQUIRED/);

  // Pure AST classification.
  const ast = (tables) => ({ error: false, statements: [{ node: { from_table: tables } }] });
  const reader = (name, path) => ({ type: "TABLE_FUNCTION", function: { function_name: name, children: [{ class: "CONSTANT", value: { is_null: false, type: { id: "VARCHAR" }, value: path } }] } });
  assert.deepEqual(collectSqlReads(ast(reader("read_csv_auto", "data/x.csv"))).paths, ["data/x.csv"]);
  assert.equal(collectSqlReads(ast(reader("read_csv_auto", "data/*.csv"))).unresolved.length, 1, "globs are unresolved");
  assert.equal(collectSqlReads(ast(reader("read_csv_auto", "../etc/passwd"))).unresolved.length, 1);
  assert.equal(collectSqlReads(ast(reader("mystery_fn", "data/x.csv"))).unresolved.length, 1);
  assert.equal(collectSqlReads({ error: true }).unresolved.length, 1);
  assert.deepEqual(collectSqlReads(ast({ type: "TABLE_FUNCTION", function: { function_name: "generate_series", children: [] } })), { paths: [], unresolved: [] });
  console.log("test_computation_binding.mjs ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
