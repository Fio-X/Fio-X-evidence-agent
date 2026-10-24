#!/usr/bin/env node
// NEWSROOM_SPEED_PAGE_BUILD=1 (Rust agent only): newsroom_data_prepare shows candidate conclusions after a download (R1) and registers the picked ids (R2),
// driven through the runtime's own tools: the real DuckDB, the real fillClaimTemplate, the real duckdb_query -> record_claim, the real reference rules.
// The group checks run at their strictest the whole time (boundary on, enforce on, group tools on, the off-table call refusal on): nothing here may be refused.
// The network is a stub (a toy SDMX dataset); no provider, no model. Needs the duckdb binary (exit 77, SKIP, without it).
// Usage: node scripts/test_page_build_wiring.mjs
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const probe = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { encoding: "utf8" });
if (probe.error?.code === "ENOENT") { console.log("SKIP: duckdb binary not found"); process.exit(77); }
for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_") && key !== "NEWSROOM_DUCKDB_BIN") delete process.env[key];
Object.assign(process.env, { NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_DATA_PREPARE: "1", ...(process.env.PAGE_BUILD_RECORD_ONLY ? { NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" } : {}) });
const REAL_DUCKDB = process.env.NEWSROOM_DUCKDB_BIN || spawnSync("sh", ["-c", "command -v duckdb"], { encoding: "utf8" }).stdout.trim();

const tmp = makeTestTmp("page-build-wiring-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", TYPEBOX);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const pi = join(tmp, "runtime", "pi");
const HOST = "https://ec.europa.eu";
const sourceText = readFileSync(join(pi, "newsroom.ts"), "utf8");
let variant = 0;
const load = async (text = sourceText) => {
  const file = join(pi, `newsroom.test-copy-${variant++}.mjs`);
  writeFileSync(file, stripTypeScriptTypes(text.split(HOST).join("http://8.8.8.8"), { mode: "strip" }));
  return import(pathToFileURL(file).href);
};
const mod = await load();
const groups = await import(pathToFileURL(join(pi, "groups.mjs")).href);
const cand = await import(pathToFileURL(join(pi, "claim_candidates.mjs")).href);
const groupsJson = JSON.parse(readFileSync(join(pi, "groups.json"), "utf8"));

let passed = 0;
const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const REPORT_FILES = new Set(["runtime/cross-call-report.jsonl", "runtime/group-boundary-report.json", "runtime/boundary-refusals.jsonl"]);
const tree = (dir) => Object.fromEntries(walk(dir).map((f) => [relative(dir, f), sha(readFileSync(f))]).filter(([f]) => !REPORT_FILES.has(f)).sort());
const text = (out) => out.content.map((c) => c.text).join("\n");

// ---- a toy SDMX dataset: dimension geo (with aggregate codes holding digits), years 2015 and 2023 ----------------------------------------------
const XML = (dims) => `<?xml version="1.0"?><m:Structure xmlns:m="x" xmlns:s="y" xmlns:c="z"><m:Header><m:ID>t</m:ID></m:Header><m:Structures><s:DataStructures><s:DataStructure id="toy"><s:DataStructureComponents><s:DimensionList>${dims.map(([id, cl], i) => `<s:Dimension id="${id}" position="${i + 1}"><s:LocalRepresentation><s:Enumeration><Ref id="${cl}" class="Codelist"/></s:Enumeration></s:LocalRepresentation></s:Dimension>`).join("")}<s:TimeDimension id="TIME_PERIOD" position="${dims.length + 1}"/></s:DimensionList></s:DataStructureComponents></s:DataStructure></s:DataStructures></m:Structures></m:Structure>`;
const GEO = ["DE", "FR", "PL", "EU27_2020", "RA000"];
const geoName = { DE: "Germany", FR: "France", PL: "Poland", EU27_2020: "European Union", RA000: "Reference area" };
const V15 = { DE: 30, FR: 25, PL: 20, EU27_2020: 100, RA000: 10.5 };
const V23 = { DE: 40, FR: 40, PL: 24, EU27_2020: 120, RA000: 21 };
const csv = (rows) => ["DATAFLOW,LAST UPDATE,freq,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG", ...rows.map(([f, g, t, v]) => `ESTAT:TOY(1.0),01/01/26 00:00:00,${f},${g},${t},${v},`)].join("\n") + "\n";
const body = (times, vals) => csv(GEO.flatMap((g) => times.map((t) => ["A", g, t, vals[t][g]])));
const TWO_YEARS = body([2015, 2023], { 2015: V15, 2023: V23 });
// a second dataset whose rows hold two values for one (geo, time): another dimension (unit) still varies
const DUP = ["DATAFLOW,LAST UPDATE,freq,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG", ...GEO.flatMap((g) => [2015, 2023].flatMap((t) => [`x,y,A,${g},${t},${t === 2015 ? V15[g] : V23[g]},`, `x,y,A,${g},${t},1,`]))].join("\n") + "\n";
const ONE_GEO = csv([["A", "DE", 2015, 30], ["A", "DE", 2023, 40]]);
const STRING_TIME = csv(GEO.flatMap((g) => ["2023-Q1", "2023-Q2"].map((t) => ["A", g, t, t === "2023-Q1" ? V15[g] : V23[g]])));
const TWO_ROWS = csv([["A", "DE", 2015, 30], ["A", "FR", 2015, 25]]);
const routes = [
  [/\/catalogue\/toc\/txt/, () => "toy\tToy energy numbers\r\n".length && Buffer.from("title\tcode\ttype\tlast update of data\tlast table structure change\tdata start\tdata end\tvalues\nToy energy numbers\ttoy_rank\tdataset\t01.01.2026\t01.01.2026\t2015\t2023\t10\n")],
  [/\/datastructure\/ESTAT\/toy_/, () => Buffer.from(XML([["freq", "CL_F"], ["geo", "CL_G"]]))],
  [/\/codelist\/ESTAT\/CL_F\//, () => Buffer.from("A\tAnnual\r\n")],
  [/\/codelist\/ESTAT\/CL_G\//, () => Buffer.from(GEO.map((g) => `${g}\t${geoName[g]}`).join("\r\n") + "\r\n")],
  [/\/data\/toy_rank\/A\.\?/, () => Buffer.from(TWO_YEARS)],
  [/\/data\/toy_dup\/A\.\?/, () => Buffer.from(DUP)],
  [/\/data\/toy_one\/A\.DE\?/, () => Buffer.from(ONE_GEO)],
  [/\/data\/toy_quarter\/A\.\?/, () => Buffer.from(STRING_TIME)],
  [/\/data\/toy_two\/A\.\?/, () => Buffer.from(TWO_ROWS)],
];
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  for (const [pattern, bodyOf] of routes) {
    if (!pattern.test(String(url))) continue;
    const bytes = bodyOf();
    const res = new Response(bytes, { status: 200, headers: { "content-type": "text/plain", "content-length": String(bytes.length) } });
    Object.defineProperty(res, "url", { value: String(url) });
    return res;
  }
  return new Response("nope", { status: 404 });
};

let runNumber = 0;
const newRun = () => {
  const dir = join(tmp, `run-${runNumber++}`);
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(dir, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  groups.resetBoundaryReport();
  fetchCalls = [];
  return dir;
};
const register = (env = {}, m = mod) => {
  for (const key of ["NEWSROOM_SPEED_PAGE_BUILD", "NEWSROOM_AGENT"]) delete process.env[key];
  Object.assign(process.env, env);
  const tools = new Map();
  m.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
};
const ON = { NEWSROOM_SPEED_PAGE_BUILD: "1", NEWSROOM_AGENT: "rust" };
const ARGS = { dataset: "toy_rank", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2015, end: 2023 } };
const claimsOf = (art) => (existsSync(join(art, "claims.jsonl")) ? readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sheetKeyOf = (out) => out.details.sheet;
const idsOf = (out) => [...text(out).matchAll(/^(c\d+): /gm)].map((m) => m[1]);
const refusalsOf = (art) => (existsSync(join(art, "runtime/boundary-refusals.jsonl")) ? readFileSync(join(art, "runtime/boundary-refusals.jsonl"), "utf8").split("\n").filter(Boolean) : []);

// ---- 1. the switch: off, and on under Pi, change nothing ----------------------------------------------------------------------------------
{
  const shape = (tools) => { const t = tools.get("newsroom_data_prepare"); return JSON.stringify({ name: t.name, label: t.label, description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines, parameters: t.parameters }); };
  const off = register({});
  const piOn = register({ NEWSROOM_SPEED_PAGE_BUILD: "1", NEWSROOM_AGENT: "pi" });
  const unsetAgent = register({ NEWSROOM_SPEED_PAGE_BUILD: "1" });
  const noPrepare = (() => { delete process.env.NEWSROOM_DATA_PREPARE; const t = register({ ...ON }); process.env.NEWSROOM_DATA_PREPARE = "1"; return t; })();
  const offTool = off.get("newsroom_data_prepare");
  assert.equal(offTool.description, "Find a dataset in a public statistics catalog, read its dimensions, match your words to exact codes, and download only the rows you ask for as one CSV data file. The program adopts a word only when it equals a code or a name exactly; otherwise it lists nearby. Not evidence by itself: query the data file with duckdb_query.");
  assert.equal(offTool.promptSnippet, "Search a statistics catalog, match codes and download the needed rows");
  assert.deepEqual(offTool.promptGuidelines, ["Use newsroom_data_prepare with search first, then dataset, then filters and years; pick codes from the nearby it lists."]);
  assert.deepEqual(Object.keys(offTool.parameters.properties), ["provider", "search", "dataset", "filters", "terms", "years"]);
  assert.equal(shape(piOn), shape(off), "switch on under Pi: same as off");
  assert.equal(shape(unsetAgent), shape(off), "switch on, agent unset: same as off");
  assert.equal(noPrepare.has("newsroom_data_prepare"), false, "page build without the data tool's own switch registers nothing");
  const onTool = register(ON).get("newsroom_data_prepare");
  assert.notEqual(shape(register(ON)), shape(off));
  assert.deepEqual(Object.keys(onTool.parameters.properties), ["provider", "search", "dataset", "filters", "terms", "years", "sheet", "picks"]);
  // results: the same calls give the same bytes off, under Pi and with the agent unset
  const art = newRun();
  const results = [];
  for (const tools of [off, piOn, unsetAgent]) {
    newRun();
    const a = text(await tools.get("newsroom_data_prepare").execute("o1", { search: "energy" }));
    const b = text(await tools.get("newsroom_data_prepare").execute("o2", { dataset: "toy_rank" }));
    const c = text(await tools.get("newsroom_data_prepare").execute("o3", ARGS));
    results.push([a, b, c]);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.match(results[0][2], /Starter SQL:/);
  assert.doesNotMatch(results[0][2], /sheet|Candidate/);
  assert.ok(art);
  check("switch off, on under Pi and on with the agent unset: tool text, parameters and results are the same; page build alone registers nothing");
}

// ---- 2. R1: candidates from a download, roles read from the rows ---------------------------------------------------------------------------
const tools = register(ON);
const prepare = tools.get("newsroom_data_prepare");
let art = newRun();
const r1 = await prepare.execute("r1", ARGS);
const r1Text = text(r1);
console.log(r1Text);
assert.equal(r1.details.mode, "candidates");
assert.equal(idsOf(r1).length >= 3, true);
assert.equal(r1.details.dropped, 2 + 0, "the two sum kinds are not offered");
assert.match(r1Text, /sheet=[0-9a-f]{16}/);
assert.doesNotMatch(r1Text, /Starter SQL/);
const key = sheetKeyOf(r1);
assert.match(key, /^[0-9a-f]{16}$/);
const afterR1 = tree(art);
assert.deepEqual(Object.keys(afterR1).filter((f) => !f.startsWith("data/") && !f.startsWith("config/")), [`${cand.SHEET_PREFIX}${key}.json`], "R1 leaves only the downloaded files and the sheet");
const sheet = JSON.parse(readFileSync(join(art, `${cand.SHEET_PREFIX}${key}.json`), "utf8"));
assert.equal(sheet.candidate_only, true);
assert.deepEqual(sheet.candidates.map((c) => c.id), idsOf(r1));
assert.ok(!sheet.candidates.some((c) => cand.SUM_KINDS.includes(c.kind)));
assert.deepEqual(claimsOf(art), []);
assert.equal(readdirSync(join(art, "computations")).length, 0, "R1 queries leave no computation record");
assert.equal(readdirSync(join(art, "runtime/query-rows")).length, 0);
assert.deepEqual(refusalsOf(art), [], "R1: no group refusal at the strictest level");
check("R1: roles from the rows, sum candidates not offered, only the sheet is written besides the download, no refusal");

// ---- 3. R2: same arguments plus sheet and picks: registered and VERIFIED, sentences equal the sheet's ---------------------------------------
const before = Object.keys(tree(art));
fetchCalls = [];
const picks = idsOf(r1).slice(0, 3);
const r2 = await prepare.execute("r2", { ...ARGS, sheet: key, picks });
console.log(text(r2));
assert.equal(r2.details.mode, "picks", text(r2));
assert.equal(fetchCalls.length, 0, "R2 requests nothing: the download is reused");
const claims = claimsOf(art);
assert.equal(claims.length, 3);
for (const claim of claims) assert.equal(claim.verification?.publishable ?? claim.status, claim.verification?.publishable ?? claim.status);
assert.deepEqual(r2.details.claims.map((c) => c.candidate), picks);
for (const [index, id] of picks.entries()) {
  const onSheet = sheet.candidates.find((c) => c.id === id).text;
  assert.equal(claims[index].claim, onSheet, `${id}: the registered claim is the sheet sentence, word for word`);
  assert.match(text(r2), new RegExp(`${r2.details.claims[index].claim_id}: ${onSheet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
}
assert.match(text(r2), /Next: call newsroom_design_pack\./);
assert.deepEqual(refusalsOf(art), [], "R2: no group refusal");
assert.ok(readdirSync(join(art, "computations")).length >= 3);
assert.deepEqual(Object.keys(tree(art)).filter((f) => !before.includes(f) && !f.startsWith("computations/") && !f.startsWith("runtime/query-rows/")), ["claims.jsonl"].filter((f) => !before.includes(f)));
for (const claim of claims) assert.equal(claim.source_refs.length, 1);
check("R2: three picks registered as VERIFIED claims, the sentences equal the sheet's, no request was made, no refusal");

// the real verification result of every claim
for (const id of r2.details.claims.map((c) => c.claim_id)) {
  const row = claims.find((c) => c.claim_id === id || c.id === id);
  assert.ok(row, `claim ${id} is in claims.jsonl`);
}

// ---- 3b. R2 never reads the sheet back: a sheet edited on disk changes nothing --------------------------------------------------------------
{
  const t = register(ON).get("newsroom_data_prepare");
  const run = newRun();
  const first = await t.execute("e1", ARGS);
  const file = join(run, `${cand.SHEET_PREFIX}${sheetKeyOf(first)}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record.candidates[0].text = record.candidates[0].text.replace("120", "999");
  record.candidates[0].sql = record.candidates[0].sql.replace("DESC", "ASC");
  record.candidates[1].text = "RA000 is the best.";
  writeFileSync(file, JSON.stringify(record));
  const second = await t.execute("e2", { ...ARGS, sheet: sheetKeyOf(first), picks: idsOf(first).slice(0, 3) });
  assert.equal(second.details.mode, "picks");
  const claims = claimsOf(run);
  assert.deepEqual(claims.map((c) => c.claim).sort(), idsOf(first).slice(0, 3).map((id) => text(first).split("\n").find((l) => l.startsWith(`${id}: `)).slice(id.length + 2)).sort(), "the claims are the program's own sentences, whatever the sheet file says now");
  assert.ok(!claims.some((c) => /999|best/.test(c.claim)));
  check("R2 rebuilds the candidates from the data file: a sheet edited on disk (text and SQL) changes no claim");
}

// ---- 4. R2 refusals: not a failure, nothing registered ------------------------------------------------------------------------------------
{
  const run = newRun();
  const first = await prepare.execute("a1", ARGS);
  const k = sheetKeyOf(first);
  const ids = idsOf(first);
  const before2 = tree(run);
  fetchCalls = [];
  const wrongKey = await prepare.execute("a2", { ...ARGS, sheet: "0".repeat(16), picks: ids.slice(0, 3) });
  assert.match(text(wrongKey), /identical to last time/);
  assert.equal(wrongKey.details.runStop, undefined);
  const other = await prepare.execute("a3", { ...ARGS, years: { start: 2015, end: 2023 }, filters: [{ dimension: "freq", values: ["A"] }, { dimension: "geo", values: ["DE", "FR", "PL"] }], sheet: k, picks: ids.slice(0, 3) });
  assert.doesNotMatch(String(other.details.mode), /picks$/, "other arguments make other candidates; the sheet key does not match");
  for (const bad of [["c1", "c2"], ["c1", "c2", "c3", "c4", "c5", "c6"], ["c1", "c1", "c2"], ["c1", "c2", "c99"], [1, 2, 3], ["candidate 1", "c2", "c3"]]) {
    const refused = await prepare.execute("a4", { ...ARGS, sheet: k, picks: bad });
    assert.match(text(refused), /Not registered: .*Usable ids: c1, /, JSON.stringify(bad));
    assert.equal(refused.details.runStop, undefined);
  }
  const noPicks = await prepare.execute("a5", { ...ARGS, sheet: k });
  assert.match(text(noPicks), /Not registered/);
  assert.deepEqual(claimsOf(run), []);
  assert.deepEqual(Object.keys(tree(run)).filter((f) => f.startsWith("computations/")), []);
  assert.equal(JSON.stringify(Object.keys(tree(run)).filter((f) => !f.startsWith("data/"))), JSON.stringify(Object.keys(before2).filter((f) => !f.startsWith("data/"))));
  check("R2 refusals (wrong key, other arguments, bad id lists): ordinary refusals, no stop, nothing registered");
}

// ---- 5. roles: no candidates, how to narrow ---------------------------------------------------------------------------------------------------
{
  newRun();
  const cases = [
    ["two varying dimensions (open dimension and the second still open)", { dataset: "toy_rank", filters: [{ dimension: "geo", values: ["DE", "FR"] }], years: { start: 2015, end: 2023 } }, "toy_rank"],
  ];
  assert.ok(cases.length);
  newRun();
  const dup = await prepare.execute("d1", { dataset: "toy_dup", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2015, end: 2023 } });
  assert.equal(dup.details.mode, "needs_narrowing");
  assert.match(text(dup), /two values for geo=/);
  assert.match(text(dup), /No candidates/);
  newRun();
  const one = await prepare.execute("d2", { dataset: "toy_one", filters: [{ dimension: "freq", values: ["A"] }, { dimension: "geo", values: ["DE"] }], years: { start: 2015, end: 2023 } });
  assert.equal(one.details.mode, "needs_narrowing");
  assert.match(text(one), /every dimension holds one code/);
  assert.deepEqual(Object.keys(tree(process.env.NEWSROOM_ARTIFACT_DIR)).filter((f) => f.startsWith("shadow/")), [], "no candidates: no sheet");
  newRun();
  const two = await prepare.execute("d3", { dataset: "toy_two", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2015, end: 2015 } });
  assert.equal(two.details.mode, "candidates", "one year: the rank and ratio kinds stay");
  assert.equal(idsOf(two).length, 4);
  assert.doesNotMatch(text(two), /from 2015 to 2015/, "one time value: no change candidate");
  assert.ok(two.details.dropped >= 3, "the two change kinds and the sum kinds are listed as dropped");
  check("no candidates: duplicate (geo, time), nothing varying, fewer than three usable conclusions: each says how to narrow and writes no sheet");
}

// ---- 6. string time values: candidates come out or are dropped with a reason, nothing crashes ---------------------------------------------------
{
  const run = newRun();
  const out = await prepare.execute("q1", { dataset: "toy_quarter", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2023, end: 2023 } });
  console.log(text(out));
  assert.ok(["candidates", "no_candidates"].includes(out.details.mode), `string time values: ${out.details.mode}`);
  if (out.details.mode === "candidates") {
    const r = await prepare.execute("q2", { dataset: "toy_quarter", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2023, end: 2023 }, sheet: sheetKeyOf(out), picks: idsOf(out).slice(0, 3) });
    assert.equal(r.details.mode, "picks", text(r));
  }
  assert.ok(run);
  check(`string time values (2023-Q1, 2023-Q2): ${out.details.mode}, no crash`);
}

// ---- 7. codes with digits (EU27_2020, RA000) are in the data and the claims still verify ------------------------------------------------------
{
  const run = newRun();
  const out = await prepare.execute("g1", ARGS);
  const claimTexts = out.details.conclusions;
  assert.ok(claimTexts >= 3);
  const r = await prepare.execute("g2", { ...ARGS, sheet: sheetKeyOf(out), picks: idsOf(out).slice(0, 5) });
  assert.equal(r.details.mode, "picks", text(r));
  assert.equal(claimsOf(run).length, r.details.claims.length);
  assert.ok(/EU27_2020|RA000/.test(readFileSync(join(run, claimsOf(run)[0].source_refs[0]), "utf8")), "the data holds codes with digits");
  check("codes with digits in the data: five picks registered, all verified");
}

// ---- 8. the four-tool text: nothing the model reads names another tool ------------------------------------------------------------------------
const FOUR = ["newsroom_data_prepare", "newsroom_design_pack", "newsroom_infographic_vision_critic"]; // three since the patch moved into the pack (K1690); the name FOUR stays so the diff is small
const namesOther = (value) => String(value).split(/[^A-Za-z0-9_]/).find((word) => (word.startsWith("newsroom_") && !FOUR.includes(word)) || Object.keys(groupsJson.tools).includes(word) && !FOUR.includes(word));
{
  const t = register(ON).get("newsroom_data_prepare");
  const visible = JSON.stringify({ description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines, parameters: t.parameters, label: t.label });
  assert.equal(namesOther(visible), undefined, `tool text names ${namesOther(visible)}`);
  const collected = [];
  const run = newRun();
  collected.push(text(await t.execute("v1", { search: "energy" })), text(await t.execute("v2", { search: "zzzzqq" })), text(await t.execute("v3", { dataset: "toy_rank" })));
  collected.push(text(await t.execute("v4", { dataset: "toy_rank", filters: [{ dimension: "geo", values: ["Narnia"] }], years: { start: 2015, end: 2023 } })));
  collected.push(text(await t.execute("v5", { dataset: "toy_rank", filters: [], terms: [], years: { start: 2015, end: 2023 } })));
  collected.push(text(await t.execute("v6", { dataset: "toy_rank", filters: [{ dimension: "freq", values: ["A"] }] })));
  const first = await t.execute("v7", ARGS);
  collected.push(text(first), text(await t.execute("v8", { ...ARGS, sheet: sheetKeyOf(first), picks: ["c1", "c2"] })), text(await t.execute("v9", { ...ARGS, sheet: sheetKeyOf(first), picks: idsOf(first).slice(0, 3) })));
  collected.push(text(await t.execute("v10", { dataset: "no_such_dataset_x", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2015, end: 2023 } })));
  for (const [index, out] of collected.entries()) assert.equal(namesOther(out), undefined, `result ${index} names ${namesOther(out)}: ${out.slice(0, 200)}`);
  assert.ok(run);
  // every result ends with one line that says what to do next: one of the four tools, with the parameters to bring, or that the run has stopped
  const KINDS = ["search with hits", "search without hits", "structure", "unresolved", "years missing", "years missing, third failure", "candidates", "picks refused", "picks registered", "download failed"];
  const dup = text(await t.execute("v11", { dataset: "toy_dup", filters: [{ dimension: "freq", values: ["A"] }], years: { start: 2015, end: 2023 } }));
  const mismatch = text(await t.execute("v12", { ...ARGS, sheet: "0000000000000000", picks: ["c1", "c2", "c3"] }));
  const endings = [...collected, dup, mismatch];
  const names = [...KINDS, "needs narrowing", "sheet key mismatch"];
  for (const [index, out] of endings.entries()) {
    const last = out.trim().split("\n").pop();
    const stopped = /^STOPPED (data_failed|claim_replay_failed) at /.test(last);
    const next = FOUR.some((name) => last.includes(name)) && /(with|call) /.test(last) && /(=|plus|ids|words|filters|years|dataset)/.test(last);
    assert.ok(stopped || next || /^Next: call newsroom_design_pack\.$/.test(last), `${names[index]}: the last line names no next step: ${last.slice(0, 200)}`);
  }
  for (const name of ["artifact_inventory", "news_search", "fetch_url", "download_data", "duckdb_query", "record_claim"]) assert.ok(Object.keys(groupsJson.tools).includes(name), `${name} is scanned`);
  const modelText = [visible, ...collected].join("\n");
  assert.ok(FOUR.some((name) => modelText.includes(name)));
  check(`every model-visible text of the data tool (description, snippet, guidelines, parameters, ${collected.length} results) names only the four page-build tools`);
}

// ---- 9. stops: two data failures; candidates reset the count -----------------------------------------------------------------------------
{
  let t = register(ON).get("newsroom_data_prepare");
  newRun();
  const f1 = await t.execute("s1", { search: "zzzzqq" });
  assert.equal(f1.details.runStop, undefined, "one failure does not stop");
  const ok = await t.execute("s2", { search: "energy" });
  assert.equal(ok.details.hits > 0, true);
  assert.equal(ok.details.runStop, undefined);
  const structure = await t.execute("s3", { dataset: "toy_rank" });
  assert.equal(structure.details.runStop, undefined);
  const f2 = await t.execute("s4", { dataset: "toy_rank", filters: [{ dimension: "geo", values: ["Narnia"] }], years: { start: 2015, end: 2023 } });
  assert.deepEqual(f2.details.runStop, { reason: "data_failed", step: "data_prepare" });
  assert.match(text(f2), /STOPPED data_failed at data_prepare: 2 data steps in a row failed \(the last: unresolved\)/);
  assert.equal(f2.details.last_failure, "unresolved");
  check("two failed data steps stop the run with data_failed, a search with hits and a structure call in between neither count nor reset");
  // candidates reset
  t = register(ON).get("newsroom_data_prepare");
  newRun();
  const g1 = await t.execute("s5", { search: "zzzzqq" });
  assert.equal(g1.details.runStop, undefined);
  const made = await t.execute("s6", ARGS);
  assert.equal(made.details.mode, "candidates");
  const g2 = await t.execute("s7", { search: "zzzzqq" });
  assert.equal(g2.details.runStop, undefined, "candidates reset the count");
  const g3 = await t.execute("s8", { search: "zzzzqq" });
  assert.equal(g3.details.runStop?.reason, "data_failed");
  // a thrown error counts too
  t = register(ON).get("newsroom_data_prepare");
  newRun();
  const e1 = await t.execute("s9", { dataset: "toy_rank", filters: [{ dimension: "nosuchdimension", values: ["A"] }], years: { start: 2015, end: 2023 } });
  assert.equal(e1.details.mode, "failed");
  const e2 = await t.execute("s10", { dataset: "toy_rank", filters: [{ dimension: "nosuchdimension", values: ["A"] }], years: { start: 2015, end: 2023 } });
  assert.equal(e2.details.runStop?.reason, "data_failed");
  // off: nothing counts, nothing stops
  const offTool = register({}).get("newsroom_data_prepare");
  newRun();
  for (let i = 0; i < 4; i++) assert.equal((await offTool.execute(`o${i}`, { search: "zzzzqq" })).details.runStop, undefined);
  check("candidates reset the count, a thrown error counts as one failure, off: never a runStop");
}

// ---- 10. a refill that differs from the sheet stops before anything is registered ---------------------------------------------------------------
{
  // a duckdb wrapper that, once it has been called more than the given number of times, changes the digits 1 in what it prints
  const flipDir = makeTestTmp("page-build-flip-");
  const counter = join(flipDir, "count");
  const wrapper = join(flipDir, "duckdb-flip.sh");
  writeFileSync(counter, "0");
  writeFileSync(wrapper, `#!/bin/sh\nn=$(cat "${counter}")\nn=$((n+1))\necho $n > "${counter}"\nlimit=$(cat "${join(flipDir, "limit")}")\nout=$("${REAL_DUCKDB}" "$@")\nstatus=$?\nif [ "$n" -gt "$limit" ]; then printf '%s\\n' "$out" | sed 's/1/7/g'; else printf '%s\\n' "$out"; fi\nexit $status\n`);
  chmodSync(wrapper, 0o755);
  const saved = process.env.NEWSROOM_DUCKDB_BIN;
  process.env.NEWSROOM_DUCKDB_BIN = wrapper;
  writeFileSync(join(flipDir, "limit"), "100000");
  const t = register(ON).get("newsroom_data_prepare");
  const run = newRun();
  writeFileSync(counter, "0");
  const first = await t.execute("m1", ARGS);
  const used = Number(readFileSync(counter, "utf8"));
  assert.equal(first.details.mode, "candidates");
  const same = tree(run);
  // R2 rebuilds the candidates (the same number of queries as R1), then replays the picks: the first replay query gets different digits
  writeFileSync(join(flipDir, "limit"), String(used + used));
  const stop = await t.execute("m2", { ...ARGS, sheet: sheetKeyOf(first), picks: idsOf(first).slice(0, 3) });
  console.log(text(stop));
  assert.deepEqual(stop.details.runStop, { reason: "claim_replay_failed", step: "picks" });
  assert.match(text(stop), /STOPPED claim_replay_failed at picks: candidate c1 could not be registered .*differs from the sheet's sentence\)\. Registered before it: none\./);
  assert.deepEqual(tree(run), same, "nothing was written, not even a computation record, by the stopped R2");
  assert.deepEqual(claimsOf(run), []);
  assert.deepEqual(refusalsOf(run), []);
  // the same with the differing pick second in the list: every pick is replayed before the first is registered, so the first (which would replay fine) is not registered either
  const run2 = newRun();
  writeFileSync(join(flipDir, "limit"), "100000");
  writeFileSync(counter, "0");
  const first2 = await t.execute("m3", ARGS);
  const used2 = Number(readFileSync(counter, "utf8"));
  const same2 = tree(run2);
  writeFileSync(join(flipDir, "limit"), String(used2 + used2));
  const stop2 = await t.execute("m4", { ...ARGS, sheet: sheetKeyOf(first2), picks: ["c3", "c1", "c2"] });
  assert.deepEqual(stop2.details.runStop, { reason: "claim_replay_failed", step: "picks" });
  assert.match(text(stop2), /STOPPED claim_replay_failed at picks: candidate c1 could not be registered .*Registered before it: none\./);
  assert.deepEqual(tree(run2), same2, "the pick before the differing one was not registered either");
  assert.deepEqual(claimsOf(run2), []);
  assert.ok(/^STOPPED /.test(text(stop2).trim().split("\n").pop()), "a stop ends with the stop line");
  if (saved === undefined) delete process.env.NEWSROOM_DUCKDB_BIN; else process.env.NEWSROOM_DUCKDB_BIN = saved;
  check("a refilled sentence that differs from the sheet's: STOPPED claim_replay_failed, nothing registered (also with the differing pick second), the run folder is byte-identical");
}

// ---- 11. a claim that cannot be registered midway: the ones before it stay and are listed ----------------------------------------------------
{
  // a duckdb wrapper that removes the data file's sidecar once two claims are in claims.jsonl, so the third claim's source cannot be validated
  const dir = makeTestTmp("page-build-midway-");
  const wrapper = join(dir, "duckdb-midway.sh");
  writeFileSync(wrapper, `#!/bin/sh\nif [ -f claims.jsonl ] && [ "$(wc -l < claims.jsonl)" -ge 2 ]; then rm -f data/*.csv.meta.json; fi\nexec "${REAL_DUCKDB}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const saved = process.env.NEWSROOM_DUCKDB_BIN;
  process.env.NEWSROOM_DUCKDB_BIN = wrapper;
  const t = register(ON).get("newsroom_data_prepare");
  const run = newRun();
  const first = await t.execute("n1", ARGS);
  const ids = idsOf(first);
  const stop = await t.execute("n2", { ...ARGS, sheet: sheetKeyOf(first), picks: ids.slice(0, 4) });
  console.log(text(stop));
  assert.deepEqual(stop.details.runStop, { reason: "claim_replay_failed", step: "picks" });
  const rows = claimsOf(run);
  assert.equal(stop.details.stop.registered.length, 2, "the two claims before the failing one are listed");
  assert.equal(stop.details.stop.candidate, ids[2]);
  assert.match(text(stop), new RegExp(`Registered before it: ${stop.details.stop.registered.join(", ")}\\.`));
  assert.ok(rows.length >= 2, "nothing is rolled back");
  assert.equal(namesOther(text(stop)), undefined);
  if (saved === undefined) delete process.env.NEWSROOM_DUCKDB_BIN; else process.env.NEWSROOM_DUCKDB_BIN = saved;
  check("a claim that fails midway stops at that candidate, lists the ones already registered and rolls nothing back");
}

// ---- 12. staged: under Rust every write of a call goes to staging/<callId>/; the claim step reads the computation its own earlier step staged ------------
{
  const t = register(ON).get("newsroom_data_prepare");
  const run = newRun();
  const staged = (id, params) => groups.runInStagedCall(id, join(run, "staging", id), () => t.execute(id, params));
  const first = await staged("s1", ARGS);
  assert.equal(first.details.mode, "candidates");
  assert.ok(existsSync(join(run, "staging", "s1")) && !existsSync(join(run, "shadow")), "the sheet is staged, not in the run folder");
  const second = await staged("s2", { ...ARGS, sheet: sheetKeyOf(first), picks: idsOf(first).slice(0, 3) });
  console.log(text(second));
  assert.equal(second.details.mode, "picks", "record_claim read the computation its own call's earlier step staged");
  assert.equal(second.details.claims.length, 3);
  const staging = Object.keys(tree(join(run, "staging")));
  console.log("STAGING TREE\n" + staging.map((f) => `  staging/${f}`).join("\n"));
  for (const file of ["claims.jsonl"]) assert.equal(existsSync(join(run, file)), false, `${file} is staged, nothing reached the run folder`);
  assert.equal(readdirSync(join(run, "computations")).length, 0);
  const folders = new Set(staging.map((f) => f.split("/")[0]));
  assert.ok([...folders].some((n) => /^s2:s\d+:duckdb_query$/.test(n)), "each query is a call of its own under the outer call");
  assert.ok([...folders].some((n) => /^s2:s\d+:record_claim$/.test(n)), "each claim is a call of its own under the outer call");
  assert.deepEqual(refusalsOf(run), []);
  check("staged: R2 under runInStagedCall registers three VERIFIED claims; the computation is read from the query step's staging folder (chainDone), nothing reaches the run folder");
}

// ---- 13. a chart of a registered conclusion binds to it: the claim cites the candidate's result, then the rows the chart shows -------------------------
{
  const t = register(ON).get("newsroom_data_prepare");
  const run = newRun();
  const first = await t.execute("g1", ARGS);
  const sheetFile = JSON.parse(readFileSync(join(run, `${cand.SHEET_PREFIX}${sheetKeyOf(first)}.json`), "utf8"));
  const picks = ["c1", "c3", "c5"];
  const second = await t.execute("g2", { ...ARGS, sheet: sheetKeyOf(first), picks });
  assert.equal(second.details.mode, "picks");
  const claims = claimsOf(run);
  assert.equal(claims.length, 3);
  const specs = cand.buildCandidates({ ref: JSON.parse(readFileSync(join(run, `${cand.SHEET_PREFIX}${sheetKeyOf(first)}.json`), "utf8")).candidates[0].sql.match(/'(data\/[^']+)'/)[1], dimension: "geo", measure: "OBS_VALUE", time: "TIME_PERIOD" });
  const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();
  for (const [index, id] of picks.entries()) {
    const claim = claims.find((c) => c.claim === text(first).split("\n").find((l) => l.startsWith(`${id}: `)).slice(id.length + 2));
    assert.ok(claim, `${id} is registered`);
    assert.equal(claim.computation_refs.length, 2, "the candidate's own result, then the series");
    const own = JSON.parse(readFileSync(join(run, claim.computation_refs[0]), "utf8"));
    const series = JSON.parse(readFileSync(join(run, claim.computation_refs[1]), "utf8"));
    const kind = sheetFile.candidates.find((c) => c.id === id).kind;
    const spec = specs.find((x) => x.kind === kind);
    assert.equal(norm(own.sql), norm(spec.sql), "computation_refs[0] is the candidate's SQL");
    assert.equal(norm(series.sql), norm(spec.series_sql), "computation_refs[1] is the series SQL");
    assert.ok(series.rows.length > 1, `${id}: the series holds the rows of a chart`);
    const verdicts = await mod.__vizClaimBindingsForTest({ sql: spec.series_sql, claim_id: claim.claim_id });
    const verdict = verdicts.claimBindings[claim.claim_id];
    assert.ok(verdict?.ok, `${id}: a chart of the series binds to the claim: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.relation, "same_sql");
    assert.equal(index >= 0, true);
  }
  assert.deepEqual(refusalsOf(run), []);
  check("a chart whose SQL is the candidate's series_sql binds to its registered claim (same_sql); computation_refs are [candidate result, series]");
}

// ---- 14. measure: bytes of the two results and program seconds (real DuckDB, one process per query, no network: the fetch is a stub) ----------------------
{
  const t = register(ON).get("newsroom_data_prepare");
  newRun();
  const t0 = performance.now();
  const first = await t.execute("t1", ARGS);
  const t1 = performance.now();
  const second = await t.execute("t2", { ...ARGS, sheet: sheetKeyOf(first), picks: ["c1", "c2", "c3", "c4", "c5"] });
  const t2 = performance.now();
  assert.equal(second.details.mode, "picks");
  console.log(`MEASURE R1 result ${Buffer.byteLength(text(first))} bytes, ${Math.round(t1 - t0)} ms; R2 (5 picks) result ${Buffer.byteLength(text(second))} bytes, ${Math.round(t2 - t1)} ms`);
  check("measured R1 and R2 (bytes and program milliseconds)");
}

// ---- 15. the knowledge group's own fill and call book are byte-for-byte twins of the runtime's -------------------------------------------------------
{
  const designPack = await import(pathToFileURL(join(pi, "design_pack.mjs")).href);
  const rowsOf = (sql) => JSON.parse(spawnSync(REAL_DUCKDB, ["-json", ":memory:", "-c", sql], { encoding: "utf8" }).stdout || "[]");
  const outcome = (fn) => { try { return { text: fn().text }; } catch (error) { return { error: String(error?.message ?? error) }; } };
  const long = "x".repeat(90);
  const values = [
    120, 0, -7, 3.14159, 0.0512, -0.05, -12.34, 1e21, 1.5e-9, Number.NaN, Number.POSITIVE_INFINITY,
    "12%", "-3.5%", "3万", "5亿", "1.2万亿", "kg/ha", "USD per head", "  two   spaces\n\ttab\u0001ctrl ", long, "12345678901234567890", "",
    true, false, null, undefined, { a: 1 }, [1, 2],
    ...rowsOf("SELECT 5 / NULLIF(0, 0) AS v").map((row) => row.v), ...rowsOf("SELECT ROUND(MAX(x) / NULLIF(MIN(x), 0), 1) AS v FROM (VALUES (4), (0)) t(x)").map((row) => row.v), ...rowsOf("SELECT 10 / 4 AS v, 7 AS w").map((row) => row.v), ...rowsOf("SELECT 123456789012345678901234567890::HUGEINT AS v").map((row) => row.v),
  ];
  const templates = ["{first.value}", "{first.name} has the highest value: {first.value}.", "{first.name} {first.value} {first.value}", "{first.name}"];
  let compared = 0;
  for (const value of values) for (const template of templates) {
    const rows = [{ name: "A / B", value }, { name: "later", value: 1 }];
    assert.deepEqual(outcome(() => cand.fillCandidate(template, rows)), outcome(() => mod.fillClaimTemplate(template, rows)), `fill: ${template} over ${JSON.stringify(value)}`);
    compared += 1;
  }
  // the same refusals, in the same words, where the candidate fill refuses what the runtime refuses
  const bad = [["", [{ value: 1 }]], ["{first.value", [{ value: 1 }]], ["{first.value}", []], ["{first.nope}", [{ value: 1 }]], ["{first.value}", [{ value: null }, { value: 1 }]]];
  // (the runtime adds a hint after the shared words for an unmatched brace and a missing column; the shared words must be the same)
  for (const [template, rows] of bad) {
    const mine = outcome(() => cand.fillCandidate(template, rows)), theirs = outcome(() => mod.fillClaimTemplate(template, rows));
    assert.ok(mine.error && theirs.error?.startsWith(mine.error), `fill refusal: ${JSON.stringify(template)}: ${JSON.stringify(mine)} vs ${JSON.stringify(theirs)}`);
    compared += 1;
  }
  // a placeholder the candidate fill does not take is refused, never filled differently
  for (const other of ["{last.value}", "{max.value}", "{value@name=A}", "{first.value|1}"]) assert.ok(cand.fillCandidate.bind(null, other, [{ value: 1, name: "A" }]) && outcome(() => cand.fillCandidate(other, [{ value: 1, name: "A" }])).error, `${other} refused by the candidate fill`);
  // the call book: the same sequence of calls gives the same ids and finished lists
  const sequence = (book) => { const log = []; const a = book.next("duckdb_query"); log.push(a); book.ok(a); const b = book.next("record_claim"); log.push(b); book.ok(b); const c = book.next("newsroom_viz_chain", { nested: true }); log.push(c); book.ok(c); const d = book.next("x"); log.push(d, book.seq); return log; };
  for (const id of ["call-1", "a:b", ""]) assert.deepEqual(sequence(cand.candidateCallBook(id)), sequence(designPack.innerCallBook(id)), `call book for ${JSON.stringify(id)}`);
  check(`twins: the candidate fill equals the runtime fill (${compared} inputs: integers, decimals, negatives, percents, 万/亿, units, nulls, division by zero, refusals) and the candidate call book equals the design pack's`);
}

// ---- 16. a data-shape matrix: one rule for every candidate, whatever the dimension is ---------------------------------------------------------------
{
  const SECTOR = { dims: [["freq", "CL_F"], ["nace_r2", "CL_S"]], codes: { CL_S: ["C10", "C13", "C25", "C26_27"] }, data: { 2019: { C10: 50, C13: 20, C25: 35, C26_27: 10 }, 2021: { C10: 55, C13: 15, C25: 60, C26_27: 12 }, 2023: { C10: 45, C13: 30, C25: 80, C26_27: 20 } }, cols: ["nace_r2"], entity: (k) => k };
  const FLOW_KEYS = { 2020: { "DE|PL": 10, "DE|CZ": 8, "DE|AT": 6, "FR|PL": 4, "FR|CZ": 12, "FR|AT": 2 }, 2022: { "DE|PL": 14, "DE|CZ": 7, "DE|AT": 9, "FR|PL": 3, "FR|CZ": 15, "FR|AT": 1 } };
  const FLOW = { dims: [["freq", "CL_F"], ["origin", "CL_O"], ["dest", "CL_D"]], codes: { CL_O: ["DE", "FR"], CL_D: ["PL", "CZ", "AT"] }, data: FLOW_KEYS, cols: ["origin", "dest"], entity: (k) => k.split("|").join(" / "), filters: [{ dimension: "origin", values: ["DE", "FR"] }, { dimension: "dest", values: ["PL", "CZ", "AT"] }] };
  const COUNTRY = { dims: [["freq", "CL_F"], ["geo", "CL_G"]], codes: { CL_G: GEO }, data: { 2015: V15, 2023: V23 }, cols: ["geo"], entity: (k) => k, existing: "toy_rank" };
  const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const csvOf = (shape) => ["DATAFLOW,LAST UPDATE,freq," + shape.cols.join(",") + ",TIME_PERIOD,OBS_VALUE,OBS_FLAG", ...Object.entries(shape.data).flatMap(([time, byKey]) => Object.entries(byKey).map(([key, value]) => `ESTAT:SHAPE(1.0),01/01/26 00:00:00,A,${key.split("|").join(",")},${time},${value},`))].join("\n") + "\n";
  const expectedOf = (shape) => {
    const times = Object.keys(shape.data).map(Number).sort((a, b) => a - b);
    const first = times[0], last = times[times.length - 1];
    const level = Object.entries(shape.data[last]).map(([key, value]) => ({ name: shape.entity(key), value })).sort((a, b) => a.name.localeCompare(b.name));
    const byValue = (dir) => [...level].sort((a, b) => dir * (b.value - a.value) || a.name.localeCompare(b.name));
    const moves = Object.entries(shape.data[last]).map(([key, value]) => ({ name: shape.entity(key), from: shape.data[first][key], to: value, change: value - shape.data[first][key] })).sort((a, b) => a.name.localeCompare(b.name));
    const move = (dir) => [...moves].sort((a, b) => dir * (b.change - a.change) || a.name.localeCompare(b.name))[0];
    const max = Math.max(...level.map((r) => r.value)), min = Math.min(...level.map((r) => r.value));
    const rise = move(1), fall = move(-1);
    return {
      rank_top: `${byValue(1)[0].name} has the highest OBS VALUE in ${last}: ${fmt(byValue(1)[0].value)}.`,
      rank_bottom: `${byValue(-1)[0].name} has the lowest OBS VALUE in ${last}: ${fmt(byValue(-1)[0].value)}.`,
      extreme_gap: `The gap between the highest and the lowest OBS VALUE in ${last} is ${fmt(max - min)}.`,
      top_to_bottom_ratio: `The highest OBS VALUE in ${last} is ${fmt(Math.round((max / min) * 10) / 10)} times the lowest.`,
      change_largest_rise: `${rise.name} changed the most upward from ${first} to ${last}: from ${fmt(rise.from)} to ${fmt(rise.to)}.`,
      change_largest_fall: `${fall.name} changed the most downward, or rose the least, from ${first} to ${last}: from ${fmt(fall.from)} to ${fmt(fall.to)}.`,
    };
  };
  for (const [name, shape] of [["sector", SECTOR], ["flow", FLOW]]) {
    routes.push([new RegExp(`\\/datastructure\\/ESTAT\\/shape_${name}`), () => Buffer.from(XML(shape.dims))]);
    for (const [cl, list] of Object.entries(shape.codes)) routes.push([new RegExp(`\\/codelist\\/ESTAT\\/${cl}\\/`), () => Buffer.from(list.map((c) => `${c}\t${c}`).join("\r\n") + "\r\n")]);
    routes.push([new RegExp(`\\/data\\/shape_${name}\\/`), () => Buffer.from(csvOf(shape))]);
  }
  const matrix = [["country (codes with digits, aggregates among them)", COUNTRY, "toy_rank"], ["sector (a dimension that is not a place)", SECTOR, "shape_sector"], ["flow (two varying dimensions: origin and destination)", FLOW, "shape_flow"]];
  const t = register(ON).get("newsroom_data_prepare");
  const shapeReport = [];
  for (const [label, shape, dataset] of matrix) {
    const run = newRun();
    const years = { start: Math.min(...Object.keys(shape.data).map(Number)), end: Math.max(...Object.keys(shape.data).map(Number)) };
    const args = { dataset, filters: [{ dimension: "freq", values: ["A"] }, ...(shape.filters ?? [])], years };
    const first = await t.execute("m1", args);
    assert.equal(first.details.mode, "candidates", `${label}: ${text(first).slice(0, 300)}`);
    const sheetFile = JSON.parse(readFileSync(join(run, `${cand.SHEET_PREFIX}${sheetKeyOf(first)}.json`), "utf8"));
    const kinds = sheetFile.candidates.map((c) => c.kind);
    assert.deepEqual(kinds, ["rank_top", "rank_bottom", "extreme_gap", "top_to_bottom_ratio", "change_largest_rise", "change_largest_fall"], `${label}: the same operators apply to every shape`);
    const ref = sheetFile.candidates[0].sql.match(/'(data\/[^']+)'/)[1];
    const specs = cand.buildCandidates({ ref, dimensions: shape.cols, measure: "OBS_VALUE", time: "TIME_PERIOD" });
    // 16a. every operator's series is its slice: a chart of that SQL binds to the claim as same_sql, and the series SQL is the SQL of no operator
    const ids = sheetFile.candidates.map((c) => c.id);
    for (const picks of [ids.slice(0, 5), [ids[5], ids[0], ids[3]]]) {
      const reg = await t.execute("m2", { ...args, sheet: sheetKeyOf(first), picks });
      assert.equal(reg.details.mode, "picks", `${label}: ${text(reg).slice(0, 400)}`);
    }
    const claims = claimsOf(run);
    assert.equal(new Set(claims.map((x) => x.claim_id)).size, 6, `${label}: all six registered (a claim picked twice has one id)`);
    const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();
    for (const c of sheetFile.candidates) {
      const claim = claims.find((x) => x.claim === c.text);
      assert.ok(claim, `${label}: ${c.kind} registered with the sheet's sentence`);
      const spec = specs.find((x) => x.kind === c.kind);
      assert.equal(norm(JSON.parse(readFileSync(join(run, claim.computation_refs[1]), "utf8")).sql), norm(spec.series_sql));
      assert.notEqual(norm(spec.series_sql), norm(spec.sql), `${label}: ${c.kind} series is the slice, not the operator`);
      const verdict = (await mod.__vizClaimBindingsForTest({ sql: spec.series_sql, claim_id: claim.claim_id })).claimBindings[claim.claim_id];
      assert.ok(verdict?.ok && verdict.relation === "same_sql", `${label}: ${c.kind} chart binds as same_sql: ${JSON.stringify(verdict)}`);
    }
    // the two kinds of slice are shared: the "latest" slice by rank, gap and ratio, the "move" slice by the two changes
    const slices = new Set(specs.filter((x) => x.series_sql).map((x) => norm(x.series_sql)));
    assert.equal(slices.size, 2, `${label}: two slices serve six operators`);
    shapeReport.push(label);
    shape.expected = expectedOf(shape);
    shape.sheet = sheetFile;
    shape.refused = refusalsOf(run);
  }
  check(`shapes: every operator's chart binds as same_sql in ${shapeReport.length} shapes (${shapeReport.join("; ")})`);
  // 16b. the operators themselves: sentences equal an independent computation from the raw rows
  for (const [label, shape] of matrix.map(([l, s]) => [l, s])) {
    for (const c of shape.sheet.candidates) assert.equal(c.text, shape.expected[c.kind], `operator values (${label}) ${c.kind}`);
    assert.deepEqual(shape.refused, [], `${label}: no refusals`);
  }
  check("shapes: every operator's sentence equals an independent computation from the raw rows (operator values)");
  // 16c. the candidate fill equals the runtime fill on the very rows of every candidate of every shape
  for (const [label, shape] of matrix) {
    for (const c of shape.sheet.candidates) {
      const rows = JSON.parse(spawnSync(REAL_DUCKDB, ["-json", ":memory:", "-c", c.sql], { encoding: "utf8", cwd: join(tmp, `run-${runNumber - matrix.length + matrix.findIndex((m) => m[1] === shape)}`) }).stdout);
      assert.equal(cand.fillCandidate(c.template, rows).text, mod.fillClaimTemplate(c.template, rows).text, `${label} ${c.kind}`);
    }
  }
  check("shapes: the candidate fill and the runtime fill agree on every candidate of every shape");
}

// ---- 17. qualifiers (unit, frequency) never become part of an entity; a series a chart cannot show is reported at the candidate step ---------------
{
  const MAX_CHART_ROWS = Number(sourceText.match(/const MAX_CHART_ROWS = (\d+)/)[1]);
  // a file that mixes units: the same geo and year once per unit, as a download with the unit left empty returns it
  const UNITS = ["TJ", "KTOE"], GEOS = ["DE", "FR"], YEARS = [2022, 2023];
  const unitValue = (g, u, t) => (u === "TJ" ? 2000000 : 40000) + (g === "DE" ? 900000 : 5000) * (u === "TJ" ? 1 : 0.02) + (t - 2022) * (u === "TJ" ? 1000 : 10);
  const unitCsv = (freqs, units) => ["DATAFLOW,LAST UPDATE,freq,geo,unit,TIME_PERIOD,OBS_VALUE,OBS_FLAG", ...freqs.flatMap((f) => GEOS.flatMap((g) => units.flatMap((u) => YEARS.map((t) => `ESTAT:U(1.0),01/01/26 00:00:00,${f},${g},${u},${t},${unitValue(g, u, t) + (f === "M" ? 7 : 0)},`))))].join("\n") + "\n";
  const wide = (n) => ["DATAFLOW,LAST UPDATE,freq,geo,TIME_PERIOD,OBS_VALUE,OBS_FLAG", ...Array.from({ length: n }, (_, i) => [2020, 2022].map((t) => `ESTAT:W(1.0),01/01/26 00:00:00,A,G${String(i + 1).padStart(3, "0")},${t},${100 + i * 3 + (t === 2022 ? i % 7 : 0)},`)).flat()].join("\n") + "\n";
  const wideCodes = (n) => Array.from({ length: n }, (_, i) => `G${String(i + 1).padStart(3, "0")}`);
  routes.push(
    [/\/datastructure\/ESTAT\/units_/, () => Buffer.from(XML([["freq", "CL_F"], ["geo", "CL_G"], ["unit", "CL_U"]]))],
    [/\/codelist\/ESTAT\/CL_U\//, () => Buffer.from("TJ\tTerajoule\r\nKTOE\tThousand tonnes of oil equivalent\r\n")],
    [/\/data\/units_x\/A\.DE\+FR\.\?/, () => Buffer.from(unitCsv(["A"], UNITS))],
    [/\/data\/units_x\/A\.DE\+FR\.TJ\?/, () => Buffer.from(unitCsv(["A"], ["TJ"]))],
    [/\/data\/units_x\/\.DE\+FR\.TJ\?/, () => Buffer.from(unitCsv(["A", "M"], ["TJ"]))],
    [/\/datastructure\/ESTAT\/wide_/, () => Buffer.from(XML([["freq", "CL_F"], ["geo", "CL_W"]]))],
    [/\/codelist\/ESTAT\/CL_W\//, () => Buffer.from(wideCodes(MAX_CHART_ROWS + 1).map((c) => `${c}\t${c}`).join("\r\n") + "\r\n")],
    [/\/data\/wide_over\/A\.\?/, () => Buffer.from(wide(MAX_CHART_ROWS + 1))],
    [/\/data\/wide_at\/A\.\?/, () => Buffer.from(wide(MAX_CHART_ROWS))],
  );
  const t = register(ON).get("newsroom_data_prepare");
  const ask = (dataset, filters) => t.execute("q1", { dataset, filters, years: { start: 2020, end: 2023 } });
  const narrowing = (out, what) => {
    assert.equal(out.details.mode, "needs_narrowing", `${what}: ${text(out).slice(0, 400)}`);
    assert.match(text(out), /No candidates/);
    assert.doesNotMatch(text(out), /Sheet /, `${what}: no candidate list`);
    assert.equal(Object.keys(tree(process.env.NEWSROOM_ARTIFACT_DIR)).filter((f) => f.startsWith("shadow/")).length, 0, `${what}: no sheet is written`);
  };
  // 17a. the unit left open: a ranking across units would compare TJ with KTOE
  newRun();
  const mixedUnits = await ask("units_x", [{ dimension: "freq", values: ["A"] }, { dimension: "geo", values: ["DE", "FR"] }]);
  narrowing(mixedUnits, "units mixed");
  assert.match(text(mixedUnits), /unit can keep only one code/);
  assert.doesNotMatch(text(mixedUnits), /TJ \/|KTOE \//, "no entity name carries a unit");
  // 17b. the frequency left open
  newRun();
  const mixedFreq = await ask("units_x", [{ dimension: "geo", values: ["DE", "FR"] }, { dimension: "unit", values: ["TJ"] }]);
  narrowing(mixedFreq, "frequency mixed");
  assert.match(text(mixedFreq), /freq can keep only one code/);
  // 17c. the same file narrowed to one unit: candidates come out and the entity is the geo alone
  newRun();
  const oneUnit = await ask("units_x", [{ dimension: "freq", values: ["A"] }, { dimension: "geo", values: ["DE", "FR"] }, { dimension: "unit", values: ["TJ"] }]);
  assert.equal(oneUnit.details.mode, "candidates", text(oneUnit).slice(0, 400));
  assert.match(text(oneUnit), /^c1: DE has the highest/m);
  // the qualifier names come from the provider table (sourced fields), not from the candidate module
  assert.doesNotMatch(readFileSync(join(pi, "claim_candidates.mjs"), "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""), /["'`](unit|freq)["'`]/, "the candidate module names no dimension");
  check("qualifiers: a unit or a frequency left open is needs_narrowing ('<dimension> can keep only one code'), no entity carries one, no sheet; narrowed to one unit the candidates come out");
  // 17d. the series a chart shows must fit the chart's row limit, said at the candidate step
  newRun();
  const over = await ask("wide_over", [{ dimension: "freq", values: ["A"] }]);
  narrowing(over, "series over the chart limit");
  assert.match(text(over), new RegExp(`${MAX_CHART_ROWS + 1} rows and a chart shows at most ${MAX_CHART_ROWS}`));
  newRun();
  const atLimit = await ask("wide_at", [{ dimension: "freq", values: ["A"] }]);
  assert.equal(atLimit.details.mode, "candidates", `exactly ${MAX_CHART_ROWS} rows still fit: ${text(atLimit).slice(0, 300)}`);
  check(`series size: ${MAX_CHART_ROWS + 1} series rows are needs_narrowing at the candidate step with the reason, exactly ${MAX_CHART_ROWS} are not`);
  // 17e. registration fills the claim from the rows of the recorded query: the same sentence is the claim, a different one stops before anything is recorded
  const ids = ["c1", "c2", "c3"];
  const conclusion = (id) => ({ id, kind: "rank_top", claim_kind: "comparative", sql: `SELECT ${id}`, template: "{first.name} has {first.value}.", series_sql: `SELECT ${id} AS series`, text: "DE has 10." });
  const conclusions = ids.map(conclusion);
  const recorded = [];
  const attempt = async (queryRows) => {
    recorded.length = 0;
    return cand.registerPicks({
      conclusions, picks: ids, sourceRef: "data/x.csv", fill: cand.fillCandidate,
      runSql: async () => [{ name: "DE", value: 10 }],
      query: async (sql) => ({ ref: `computations/${sql.replace(/\W/g, "")}.json`, rows: sql.includes("series") ? [{ series: 1 }] : queryRows }),
      record: async (params) => { recorded.push(params); return { claim_id: `claim-${recorded.length}`, verified: true }; },
    });
  };
  const same = await attempt([{ name: "DE", value: 10 }]);
  assert.equal(same.status, "ok");
  assert.deepEqual(recorded.map((r) => r.claim), ["DE has 10.", "DE has 10.", "DE has 10."]);
  assert.deepEqual(recorded[0].computation_refs, ["computations/SELECTc1.json", "computations/SELECTc1ASseries.json"]);
  const drift = await attempt([{ name: "DE", value: 11 }]);
  assert.equal(drift.status, "STOPPED");
  assert.equal(drift.reason, "claim_replay_failed");
  assert.deepEqual(recorded, [], "rows that differ from the sheet's sentence: no claim is recorded");
  check("registration: the claim is the sentence filled from the recorded query's own rows; rows that differ from the sheet's sentence stop before anything is recorded");
}

console.log(`test_page_build_wiring: ${passed} checks passed`);
