// NEWSROOM_READ_INPUT_NAMED_HINT (default off, exact "1"): when the SQL gives a file reader a `name = value` argument, the two read-input
// refusals (the inline-rows gate and the claim provenance gate) add one sentence saying to write `name := value`. Off, or for SQL
// without such an argument, both refusal texts are byte-identical to the previous ones (written out below). Drives the real
// duckdb_query and record_claim handlers against real DuckDB. Mutations (each red): hint only at the claim gate with the switch off,
// hint missing at the inline gate, hint on SQL without a named argument, switch reversed.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readerNamedEqualsParam } from "../runtime/pi/computation_rows.mjs";

process.setMaxListeners(40);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HINT = "A file reader option written as `name = value` makes the path unresolvable; write it as `name := value` (for example `header := true`) and keep the path the only positional argument.";
const INLINE_OLD = "SYNTHETIC_DATA_BLOCKED: EVIDENCE_REQUIRED before inline VALUES or generated rows can be analyzed; the query must read a data/ or sources/ input";
const claimOld = (ref, binding) => `COMPUTATION_PROVENANCE_REQUIRED: ${ref} reads no resolvable data/ or sources/ input (binding: ${binding}); literal-only or unresolved computations cannot support a claim`;
const SWITCH = "NEWSROOM_READ_INPUT_NAMED_HINT";

const swap = (from, to) => (s) => { assert.ok(s.includes(from), `fixture text missing: ${from}`); return s.replace(from, to); };

async function scenario(label, edit) {
  const tmp = makeTestTmp(`named-hint-${label}-`);
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
  let ts = readFileSync(join(pi, "newsroom.ts"), "utf8");
  if (edit) ts = edit(ts);
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(ts, { mode: "strip" }));
  const art = join(tmp, "artifact");
  for (const dir of ["data", "sources", "computations", "runtime/query-rows"]) mkdirSync(join(art, dir), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  const csv = Buffer.from("country,value\nA,1\nB,2\n");
  const dataRef = `data/${sha(csv)}.csv`;
  writeFileSync(join(art, dataRef), csv);
  writeFileSync(join(art, `${dataRef}.meta.json`), JSON.stringify({ file: dataRef, sha256: sha(csv), bytes: csv.length }));
  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  (await import(`${pathToFileURL(join(pi, "newsroom.test-copy.mjs")).href}?t=${Math.random()}`)).default(piApi);
  const query = tools.get("duckdb_query");
  const claim = tools.get("record_claim");
  const runQuery = async (sql) => relative(art, (await query.execute("q", { sql })).details.path);
  const recordClaim = (ref) => claim.execute("c", { claim: "A is 1", claim_kind: "quantitative", status: "supported", source_refs: [dataRef], computation_refs: [ref] });
  const refused = async (promise) => { try { await promise; } catch (error) { return String(error.message); } return null; };

  const named = [
    `SELECT country, value FROM read_csv('${dataRef}', header = true) ORDER BY country`,
    `SELECT country, value FROM read_csv('${dataRef}', header=true, delim = ',') ORDER BY country`,
  ];
  const resolved = `SELECT country, value FROM read_csv('${dataRef}', header := true) ORDER BY country`;
  const inlineNamed = (sql) => `${sql.replace(" ORDER BY country", "")} UNION ALL SELECT * FROM (VALUES ('Z', 9)) t(country, value)`;
  const inlinePlain = "SELECT * FROM (VALUES ('A', 1), ('B', 2)) t(country, value)";
  const literalPlain = ["SELECT 'A' AS country, 1 AS value", "SELECT 7 AS n"];

  const texts = {};
  // The inline-rows gate (duckdb_query) and the claim provenance gate (record_claim) for each SQL, under the current switch value.
  texts.inline = [];
  for (const sql of named) texts.inline.push(await refused(query.execute("q", { sql: inlineNamed(sql) })));
  texts.inlinePlain = await refused(query.execute("q", { sql: inlinePlain }));
  texts.claim = [];
  for (const sql of named) { const ref = await runQuery(sql); texts.claim.push({ ref, message: await refused(recordClaim(ref)) }); }
  texts.claimPlain = [];
  for (const sql of literalPlain) { const ref = await runQuery(sql); texts.claimPlain.push({ ref, message: await refused(recordClaim(ref)) }); }
  texts.resolved = await refused((async () => recordClaim(await runQuery(resolved)))());
  return texts;
}

function expectOff(texts) {
  for (const message of texts.inline) assert.equal(message, INLINE_OLD);
  assert.equal(texts.inlinePlain, INLINE_OLD);
  for (const { ref, message } of texts.claim) assert.equal(message, claimOld(ref, "unresolved"));
  for (const { ref, message } of texts.claimPlain) assert.equal(message, claimOld(ref, "literal_only"));
  assert.equal(texts.resolved, null, "a `:=` argument resolves and the claim goes through");
}
function expectOn(texts) {
  for (const message of texts.inline) assert.equal(message, `${INLINE_OLD} ${HINT}`);
  assert.equal(texts.inlinePlain, INLINE_OLD, "no hint without a named argument");
  for (const { ref, message } of texts.claim) assert.equal(message, `${claimOld(ref, "unresolved")} ${HINT}`);
  for (const { ref, message } of texts.claimPlain) assert.equal(message, claimOld(ref, "literal_only"), "no hint without a named argument");
  assert.equal(texts.resolved, null);
}

async function run(label, switchValue, edit) {
  if (switchValue === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = switchValue;
  try { return await scenario(label, edit); } finally { delete process.env[SWITCH]; }
}

// The AST rule over DuckDB's own parse: which spellings count as `name = value`.
const parse = (sql) => JSON.parse(execFileSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["-noheader", "-list", ":memory:", "-c", `SELECT json_serialize_sql('${sql.replace(/'/g, "''")}', skip_null := true, skip_empty := true)`], { encoding: "utf8" }).trim());
for (const fn of ["read_csv", "read_csv_auto", "read_json", "read_parquet"]) {
  const q = (arg) => `SELECT * FROM ${fn}('data/x.csv'${arg ? `, ${arg}` : ""})`;
  for (const arg of ["header = true", "header=true", "header == true", "x = 1, header = true"]) assert.equal(readerNamedEqualsParam(parse(q(arg))), true, `${fn} ${arg}`);
  for (const arg of ["header = (SELECT true)", "delim = ';' || ''"]) assert.equal(readerNamedEqualsParam(parse(q(arg))), true, `${fn} ${arg}: still an unresolved \`name = value\` argument`);
  for (const arg of ["", "header := true", "header => true", "t.header = true"]) assert.equal(readerNamedEqualsParam(parse(q(arg))), false, `${fn} ${arg}`);
}
assert.equal(readerNamedEqualsParam(parse("SELECT * FROM (SELECT 1 AS a) t WHERE a = 1")), false, "a WHERE comparison is not a reader argument");
assert.equal(readerNamedEqualsParam(parse("SELECT * FROM generate_series(1, 3) g")), false);
assert.equal(readerNamedEqualsParam(parse("WITH c AS (SELECT * FROM read_csv('data/x.csv', header = true)) SELECT * FROM c")), true, "found inside a CTE");
assert.equal(readerNamedEqualsParam({ error: true }), false);
console.log("reader named-argument rule: real DuckDB parses");

// 1 and 2: switch unset, and values that are not exactly "1": the previous texts, byte for byte.
for (const [label, value] of [["unset", undefined], ["true", "true"], ["zero", "0"], ["empty", ""], ["yes", "yes"], ["padded", "1 "]]) {
  expectOff(await run(`off-${label}`, value));
  console.log(`switch ${label}: previous texts`);
}
// 3: switch exactly "1": both gates add the sentence for named arguments only.
expectOn(await run("on", "1"));
console.log("switch 1: sentence at both gates, named arguments only");

// The inline-claim entry point (NEWSROOM_SPEED_INLINE_CLAIM, record_claim's own gates behind a viz chain) calls the same gate: its call site
// is checked in the source rather than driven here.
const SRC = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
assert.ok(SRC.includes('assertInlineRowsHaveEvidence(safeSql, derived.input_binding === "source_bound", derived.input_binding === "source_bound" ? "" : await namedReadParamHint(safeSql, signal));'), "inline-claim site passes the hint");

// 4: mutations.
const INLINE_SITE = 'assertInlineRowsHaveEvidence(safeSql, derivedInputs.input_binding === "source_bound", derived';
const mutants = [
  ["hint at the claim gate with the switch off", "off", undefined, swap('recorded.binding === "source_bound" ? "" : await namedReadParamHint(sql, signal)', "NAMED_READ_PARAM_HINT")],
  ["hint missing at the inline gate", "on", "1", swap('assertInlineRowsHaveEvidence(safeSql, derivedInputs.input_binding === "source_bound", derivedInputs.input_binding === "source_bound" ? "" : await namedReadParamHint(safeSql, signal));', 'assertInlineRowsHaveEvidence(safeSql, derivedInputs.input_binding === "source_bound");')],
  ["hint missing at the claim gate", "on", "1", swap('afterInputs: (recorded, hint) => assertComputationBoundToSources(ref, recorded.binding, recorded.effective, sourceRefs, hint),', 'afterInputs: (recorded, hint) => assertComputationBoundToSources(ref, recorded.binding, recorded.effective, sourceRefs),')],
  ["hint on SQL without a named argument", "on", "1", swap("return readerNamedEqualsParam(await serializeSqlAst(sql, signal)) ? NAMED_READ_PARAM_HINT : \"\";", "await serializeSqlAst(sql, signal); return NAMED_READ_PARAM_HINT;")],
  ["switch reversed", "on", "1", swap('process.env.NEWSROOM_READ_INPUT_NAMED_HINT !== "1") return "";', 'process.env.NEWSROOM_READ_INPUT_NAMED_HINT === "1") return "";')],
];
for (const [label, mode, value, edit] of mutants) {
  let red = false;
  try {
    const texts = await run(`mut-${mutants.findIndex((m) => m[0] === label)}`, value, edit);
    (mode === "on" ? expectOn : expectOff)(texts);
  } catch { red = true; }
  assert.ok(red, `mutant stayed green: ${label}`);
  console.log(`mutant red: ${label}`);
}
console.log("read input named hint: PASS");
