// DuckDB out-of-memory diagnostic: the SET suggestions DuckDB prints cannot be followed under the locked sandbox configuration, so
// they are replaced by one sentence saying the limit is fixed; the MAP/read_text sentence is added only when the query uses json_each.
// Non-OOM diagnostics stay byte-identical to the previous behavior. Mutations: the json_each test dropped, the SET list kept, the limit
// sentence removed, the hint placed where the 800-character cut can remove it (each red). Offline; no DuckDB process.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PI = join(ROOT, "runtime/pi");
const SRC = readFileSync(join(PI, "computation_rows.mjs"), "utf8");

const OOM = `Out of Memory Error: could not allocate block of size 256.0 KiB (45.7 MiB/45.7 MiB used)

Possible solutions:
* Reducing the number of threads (SET threads=X)
* Disabling insertion-order preservation (SET preserve_insertion_order=false)
* Increasing the memory limit (SET memory_limit='...GB')

See also https://duckdb.org/docs/stable/guides/performance/how_to_tune_workloads
`;
const FIRST = "Out of Memory Error: could not allocate block of size 256.0 KiB (45.7 MiB/45.7 MiB used)";
const LIMIT = "The memory limit is fixed and cannot be changed from the query.";
const MAP = "Read the file with read_text from a constant data/ path, cast the JSON object with CAST(d->'value' AS MAP(VARCHAR, DOUBLE)) and expand it with unnest(map_entries(...)) instead of json_each.";
const JSON_EACH_SQL = "SELECT count(*) AS n, sum(CAST(je.value AS DOUBLE)) AS s FROM (SELECT content::JSON AS d FROM read_text('data/js.json')) j, json_each(j.d->'value') je";
const JOIN_SQL = "SELECT a.k, count(*) FROM big a JOIN big b ON a.k = b.k GROUP BY a.k";

let counter = 0;
async function load(edit) {
  if (!edit) return import(pathToFileURL(join(PI, "computation_rows.mjs")).href);
  const name = `computation_rows.k1499mut${process.pid}x${counter++}.mjs`;
  const path = join(PI, name);
  const text = edit(SRC);
  assert.notEqual(text, SRC, "mutation did not change the source");
  writeFileSync(path, text);
  try { return await import(pathToFileURL(path).href); } finally { rmSync(path, { force: true }); }
}
const swap = (from, to) => (s) => { assert.ok(s.includes(from), `fixture text missing: ${from}`); return s.replace(from, to); };

function cells(diag) {
  // 1. OOM with json_each (any case): first line kept, SET list and See-also line gone, both sentences present.
  assert.equal(diag(OOM, "", JSON_EACH_SQL), `${FIRST} ${LIMIT} ${MAP}`);
  assert.equal(diag(OOM, "", "select * from x, JSON_EACH (y)"), `${FIRST} ${LIMIT} ${MAP}`);
  assert.equal(diag(OOM, "", "select * from read_json_each(y)"), `${FIRST} ${LIMIT}`);
  // 2. OOM without json_each: only the fixed-limit sentence.
  assert.equal(diag(OOM, "", JOIN_SQL), `${FIRST} ${LIMIT}`);
  assert.equal(diag(OOM, "", ""), `${FIRST} ${LIMIT}`);
  assert.equal(diag(OOM), `${FIRST} ${LIMIT}`);
  for (const sql of [JSON_EACH_SQL, JOIN_SQL]) {
    const out = diag(OOM, "", sql);
    for (const gone of ["Possible solutions", "SET threads", "SET memory_limit", "preserve_insertion_order", "See also", "how_to_tune"]) assert.ok(!out.includes(gone), `${gone} must be gone`);
  }
  assert.ok(!diag(OOM, "", JOIN_SQL).includes("MAP("), "no MAP sentence without json_each");
  // 3. Local path in an OOM text: redacted as before, the hint complete inside 800 characters, long first part cut instead.
  const withPath = `Out of Memory Error: could not allocate block while reading /tmp/run1/data/js.json (45.7 MiB/45.7 MiB used)\n\nPossible solutions:\n* Reducing the number of threads (SET threads=X)\n`;
  const redacted = diag(withPath, "/tmp/run1", JSON_EACH_SQL);
  assert.equal(redacted, `Out of Memory Error: could not allocate block while reading $ARTIFACT/data/js.json (45.7 MiB/45.7 MiB used) ${LIMIT} ${MAP}`);
  assert.ok(!redacted.includes("/tmp/run1"));
  const long = `Out of Memory Error: ${"x".repeat(2000)} (1 MiB/1 MiB used)\n\nPossible solutions:\n* a\n`;
  const cut = diag(long, "", JSON_EACH_SQL);
  assert.ok(cut.length <= 800, `length ${cut.length}`);
  assert.ok(cut.endsWith(`${LIMIT} ${MAP}`), "hint must survive the 800-character cut");
  const cutNoMap = diag(long, "", JOIN_SQL);
  assert.ok(cutNoMap.length <= 800 && cutNoMap.endsWith(LIMIT));
  // OOM text with a secret before it keeps the redaction.
  assert.ok(diag(`token=abc123 ${OOM}`, "", JOIN_SQL).startsWith("token=<redacted> Out of Memory Error"));
}

function nonOomCells(diag) {
  // 4. Non-OOM texts: expected values written out from the previous behavior (redact, collapse whitespace, trim, cut at 800).
  assert.equal(diag("Binder Error: /tmp/story/data.csv token=secret\nmissing column", "/tmp/story", JSON_EACH_SQL), "Binder Error: $ARTIFACT/data.csv token=<redacted> missing column");
  assert.equal(diag("Parser Error: syntax error at or near \"FORM\"\n\nLINE 1: SELECT 1 FORM x\n                     ^", "", JOIN_SQL), 'Parser Error: syntax error at or near "FORM" LINE 1: SELECT 1 FORM x ^');
  assert.equal(diag("Catalog Error: Table with name big does not exist!\nDid you mean \"pg_type\"?", "", JOIN_SQL), 'Catalog Error: Table with name big does not exist! Did you mean "pg_type"?');
  assert.equal(diag("Invalid Input Error: Cannot change configuration option \"threads\" - the configuration has been locked", "", JSON_EACH_SQL), 'Invalid Input Error: Cannot change configuration option "threads" - the configuration has been locked');
  assert.equal(diag("Possible solutions: increase something. See also https://example.org/x", "", JSON_EACH_SQL), "Possible solutions: increase something. See also https://example.org/x", "the cut applies to out-of-memory texts only");
  assert.equal(diag("", "", JSON_EACH_SQL), "query process exited without a diagnostic");
  assert.equal(diag(undefined), "query process exited without a diagnostic");
  const longText = `IO Error: ${"y".repeat(1000)}`;
  assert.equal(diag(longText, "", JSON_EACH_SQL), longText.slice(0, 800));
}

const real = await load();
cells(real.safeDuckDbDiagnostic);
nonOomCells(real.safeDuckDbDiagnostic);

// The one product call site hands the query to the diagnostic.
const ts = readFileSync(join(PI, "newsroom.ts"), "utf8");
assert.ok(ts.includes("DUCKDB_QUERY_FAILED: ${safeDuckDbDiagnostic(stderr, root, querySql)}"), "duckDbRun must pass the query SQL");

const mutants = {
  "json_each test dropped (every OOM gets the MAP sentence)": swap("/(?<![A-Za-z0-9_])json_each\\s*\\(/i.test(String(querySql ?? ''))", "true"),
  "SET list kept (no cut)": swap("const cut = value.search(/ Possible solutions:| See also https?:\\/\\/\\S*/);", "const cut = -1;"),
  "limit sentence removed": swap("const DUCKDB_OOM_LIMIT_SENTENCE = 'The memory limit is fixed and cannot be changed from the query.';", "const DUCKDB_OOM_LIMIT_SENTENCE = '';"),
  "hint appended before the 800-character cut": swap("return `${first.slice(0, DUCKDB_DIAGNOSTIC_LIMIT - hint.length - 1)} ${hint}`;", "return `${first} ${hint}`.slice(0, DUCKDB_DIAGNOSTIC_LIMIT);"),
  "non-OOM text changed": swap("return value.slice(0, DUCKDB_DIAGNOSTIC_LIMIT);", "return value.slice(0, DUCKDB_DIAGNOSTIC_LIMIT).replace('Error:', 'Error -');"),
};
for (const [label, edit] of Object.entries(mutants)) {
  const mutated = await load(edit);
  let red = false;
  try { cells(mutated.safeDuckDbDiagnostic); nonOomCells(mutated.safeDuckDbDiagnostic); } catch { red = true; }
  assert.ok(red, `mutant stayed green: ${label}`);
  console.log(`mutant red: ${label}`);
}
console.log("duckdb oom hint: PASS");
