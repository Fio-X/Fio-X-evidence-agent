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
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "claim-integrity-"));
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
const tree = (dir) => Object.fromEntries(walk(dir).map((f) => [relative(dir, f), sha(readFileSync(f))]).sort());

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
  const art = join(mkdtempSync(join(tmpdir(), `claim-integrity-run${runs}-`)), "run");
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

async function refuses(label, s, pattern, { extra, signal, before = tree(s.art) } = {}) {
  await assert.rejects(() => record(s, extra, signal), pattern, label);
  assert.deepEqual(tree(s.art), before, `${label}: the artifact tree is unchanged`);
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
  ["aggregate and GROUP BY", (r) => `SELECT year, COUNT(*) AS share FROM '${r}' GROUP BY year HAVING COUNT(*) > 0`],
];
for (const [label, sql] of LEGIT_SQL) {
  const s = await story(sql);
  process.env.NEWSROOM_CLAIM_SQL_LINT = "1";
  try { await record(s); } finally { delete process.env.NEWSROOM_CLAIM_SQL_LINT; }
  assert.equal(claims(s.art).length, 1, `lint on: ${label} records`);
}
check(`still records with the lint on: ${LEGIT_SQL.map(([l]) => l).join("; ")}`);

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
