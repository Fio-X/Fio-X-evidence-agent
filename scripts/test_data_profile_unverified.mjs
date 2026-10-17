// NEWSROOM_SPEED_DATA_PROFILE puts a program-measured profile (columns, ranges, first rows) in the
// prompt. The profile is not a recorded query, source or claim, so a claim whose number appears only
// in the data file (what the profile shows) and in no recorded query row must stay unverified or be
// refused, with the switch on or off. Loads runtime/pi/newsroom.ts from a type-stripped copy; DuckDB
// runs the SQL; no network, no provider.
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
import { REPORT as CALL_REPORT, expectReportGrew, reportRows, callRows } from "./call_report_expect.mjs";

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

async function refuses(label, s, pattern, { extra, signal, before = tree(s.art) } = {}) {
  await assert.rejects(() => record(s, extra, signal), pattern, label);
  assert.deepEqual(tree(s.art), before, `${label}: the artifact tree is unchanged`);
  assert.deepEqual(claims(s.art), [], `${label}: no claim line`);
}

delete process.env.NEWSROOM_CLAIM_SQL_LINT;

const { fillClaimTemplate } = mod;
// The claim resolver never reads the switch or the profile, so there is one pass, not an on/off loop.
process.env.NEWSROOM_SPEED_DATA_PROFILE = "1";
{
  // The recorded query returns Chad only; 92.8 and Liberia are in the data file and so in the profile, in no query row.
  const s = await story((ref) => `SELECT country, year, share FROM '${ref}' WHERE country = 'Chad'`);
  const before = tree(s.art), rowsBefore = reportRows(s.art);
  const rows = [{ country: "Chad", year: 2022, share: 70 }];
  const cols = ["country", "year", "share"];
  // A profile number typed into the claim is refused as a typed number.
  assert.throws(() => fillClaimTemplate("Liberia's share was 92.8 percent, the highest listed.", rows, cols), /^Error: CLAIM_TEMPLATE_ERROR: the claim has a typed number/, "typed profile number refused");
  // A placeholder that reaches for a row the recorded query does not hold is refused too.
  assert.throws(() => fillClaimTemplate("Liberia's share was {share@country=Liberia} percent.", rows, cols), /^Error: CLAIM_TEMPLATE_ERROR: \{share@country=Liberia\}: no result row has country = Liberia/, "placeholder outside the recorded rows refused");
  assert.deepEqual(tree(s.art), before, "nothing was written");
  expectReportGrew(s.art, rowsBefore, callRows([
    "- - literalNumberIn - n requester=\"none\"",
  ]), "data_profile: the two refused template fills");
  assert.equal(claims(s.art).length, 0, "no claim line");
  check("a number that is only in the data profile cannot be typed or looked up into a claim");
}
console.log(`data profile stays unverified: ${passed} checks PASS`);
