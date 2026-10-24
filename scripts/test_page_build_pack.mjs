#!/usr/bin/env node
// K1690 step 2: the page-build pack path (sheet part, program-owned fields, in-pack continuation, next-step sentences) driven through the runtime's own tools.
// Real DuckDB, real claim registration, real pack, draft tool, chain tools and critic; the network is a stub (toy SDMX data); no provider, no model:
// every model answer below is hard-coded. Group checks run at their strictest. Needs the duckdb binary (exit 77, SKIP, without it).
// Usage: node scripts/test_page_build_pack.mjs
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
Object.assign(process.env, { NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_DATA_PREPARE: "1", ...(process.env.K1688_RECORD_ONLY ? { NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" } : {}) });
const REAL_DUCKDB = process.env.NEWSROOM_DUCKDB_BIN || spawnSync("sh", ["-c", "command -v duckdb"], { encoding: "utf8" }).stdout.trim();

const tmp = makeTestTmp("page-build-pack-");
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
// The strict argument check Pi applies to a patched call (typebox/compile) is stubbed to accept: test_patch_retry.mjs covers it. The chain's own step schema
// checks (SCHEMA_REJECTED, seen below) are the runtime's and run for real.
writeFileSync(join(tmp, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
writeFileSync(join(tmp, "node_modules", "typebox", "compile.js"), "export const Compile = () => ({ Check: () => true, Errors: () => [] });\n");
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
const { INNER_STEP_TOOLS, PATCH_LISTED_KEYS } = await import(pathToFileURL(join(pi, "design_pack.mjs")).href);
const { readerTextEntries } = await import(pathToFileURL(join(pi, "infographic.mjs")).href);
const { VISION_RUBRIC_KEYS } = await import(pathToFileURL(join(pi, "vision.mjs")).href);
const groupsJson = JSON.parse(readFileSync(join(pi, "groups.json"), "utf8"));

let passed = 0;
const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The agent group's copies of the page-build switch and the tool-name filter equal the knowledge group's originals over the whole switch matrix and over sample texts.
{
  const twins = mod.__pageBuildTwinsForTest;
  const saved = { ...process.env };
  let rows = 0;
  for (const build of [undefined, "0", "1"]) for (const agent of [undefined, "rust", "pi"]) for (const prepare of [undefined, "0", "1"]) {
    for (const [key, value] of [["NEWSROOM_SPEED_PAGE_BUILD", build], ["NEWSROOM_AGENT", agent], ["NEWSROOM_DATA_PREPARE", prepare]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(twins.packOn(), twins.on(), `switch twin: build=${build} agent=${agent} prepare=${prepare}`);
    rows += 1;
  }
  Object.assign(process.env, saved);
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  const SAMPLES = ["", "call newsroom_data_prepare then newsroom_design_pack", "newsroom_chart_plan, duckdb_query and fetch_url fail; newsroom_infographic_vision_critic ok", "record_claim → newsroom_publication_plan (artifact_inventory)", "plain words 12 34_x"];
  for (const sample of SAMPLES) assert.equal(twins.packSafe(sample), twins.safe(sample), `filter twin: ${sample}`);
  // The chains the pack runs get the chain's boundary context only with page build on; off they run as the design pack, as before.
  {
    const { currentTool, runInTool } = await import(pathToFileURL(join(pi, "groups.mjs")).href);
    const seen = (tool) => ({ name: "newsroom_infographic_chain", execute: async () => currentTool() });
    const askerWith = async (env) => {
      const before = { ...process.env };
      for (const key of ["NEWSROOM_SPEED_PAGE_BUILD", "NEWSROOM_AGENT", "NEWSROOM_DATA_PREPARE"]) delete process.env[key];
      Object.assign(process.env, env);
      try { return await runInTool("newsroom_design_pack", () => twins.chainBoundary(seen()).execute()); } finally { Object.assign(process.env, before); for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; }
    };
    assert.equal(await askerWith({}), "newsroom_design_pack", "switch off: the chain runs as the design pack");
    assert.equal(await askerWith({ NEWSROOM_SPEED_PAGE_BUILD: "1", NEWSROOM_AGENT: "pi", NEWSROOM_DATA_PREPARE: "1" }), "newsroom_design_pack", "page build on but not the Rust agent: off");
    assert.equal(await askerWith({ NEWSROOM_SPEED_PAGE_BUILD: "1", NEWSROOM_AGENT: "rust", NEWSROOM_DATA_PREPARE: "1" }), "newsroom_infographic_chain", "switch on: the chain's own context");
  }
  console.log(`PASS twins: the agent group's switch (${rows} env rows) and tool-name filter (${SAMPLES.length} texts) equal the knowledge group's originals`);
  passed += 1;
}
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

const RASTER_STUB = `import struct, sys, zlib
dst = sys.argv[2]
w = h = 48
raw = b"".join(b"\\x00" + bytes((x * 5 + y * 3) % 256 for x in range(w * 3)) for y in range(h))
def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
open(dst, "wb").write(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
print('{"engine": "test-stand-in"}')
`;

// TEST ONLY: no Playwright or Chromium is assumed, so browser QA is a stand-in that writes a PASS report for the one width and the same small PNG for
// each screenshot. It judges nothing: this test asserts how the pack reaches and passes the step, not what a browser would measure.
const QA_STUB = `import argparse, hashlib, json, os, struct, zlib
ap = argparse.ArgumentParser()
for flag in ("--html", "--spec", "--output", "--profile"):
    ap.add_argument(flag)
a = ap.parse_args()
spec = json.load(open(a.spec))
def chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
raw = b"".join(b"\\x00" + b"\\xff\\xff\\xff" * 8 for _ in range(8))
png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
widths = sorted({int(w) for w in (spec.get("delivery", {}).get("breakpoints") or [1440])})
for w in widths:
    open(os.path.join(a.output, "publication-%d.png" % w), "wb").write(png)
open(os.path.join(a.output, "archive.png"), "wb").write(png)
html = open(a.html, "rb").read()
json.dump({"status": "PASS", "profile": a.profile, "html_sha256": hashlib.sha256(html).hexdigest(), "viewports": [{"width": w, "status": "PASS"} for w in widths], "external_requests": [], "errors": []}, open(os.path.join(a.output, "browser-qa.json"), "w"))
print("{}")
`;
let runNumber = 0;
const newRun = () => {
  const dir = join(tmp, `run-${runNumber++}`);
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "session"]) mkdirSync(join(dir, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  // TEST ONLY: no cairosvg or Chrome is assumed here, so the rasterizer is a stand-in that writes a small valid PNG (the preview image the vision critic
  // would look at is not judged in this test: the critic's answer below is hard-coded).
  writeFileSync(join(dir, "runtime", "rasterize_svg.py"), RASTER_STUB);
  writeFileSync(join(dir, "runtime", "browser_qa.py"), QA_STUB);
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


const PACK = { ...ON, NEWSROOM_SPEED_DESIGN_PACK: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" };
let art, tools, pack, prep, sh, cid;
const seen = [];
const recording = (tool) => ({ ...tool, execute: async (...args) => { const out = await tool.execute(...args); seen.push(text(out)); return out; } });
const setupRun = async () => {
  art = newRun();
  tools = register(PACK);
  pack = recording(tools.get("newsroom_design_pack"));
  prep = recording(tools.get("newsroom_data_prepare"));
  const r1 = await prep.execute("p1", ARGS);
  await prep.execute("p2", { ...ARGS, sheet: sheetKeyOf(r1), picks: ["c1", "c2", "c5"] });
  sh = await pack.execute("sh1", { part: "sheet" });
  cid = sh.details.sheet.claims.map((c) => c.id);
};
await setupRun();
const Q = "Which country has the highest value in 2023?";
const textModule = (id, role, n, node) => ({ id, type: "text", story_role: role, priority: n, claim_ids: [cid[(n - 1) % cid.length]], story_node_ids: [node], explanatory_dimension: "context", heading: `Heading ${id}`, body: `Body text for ${id}` });
const chartJudgement = (n) => ({ unit: "index", reader_task: n ? "change" : "ranking", takeaway: n ? "The aggregate rose the most" : "The aggregate leads the ranking", measure_semantics: [{ id: "m1", field: n ? "change" : "value", phenomenon: "Toy value", unit: "index", measure_kind: n ? "change" : "index", temporal_basis: n ? { type: "period", start: "2015", end: "2023" } : { type: "point_in_time", date: "2023" } }], claim_spec: { reader_task: n ? "change" : "ranking", target_measure: "m1" }, title: n ? "Change by area, 2015 to 2023" : "Value by area, 2023", alt: n ? "Chart of the change by area" : "Bar chart of the value by area in 2023", source_note: "Toy dataset" });
const judgement = (over = {}) => ({
  discovery: { reader_question: Q, reader_problem: "The reader wants the ranking", candidate_questions: [Q, "Who is lowest?", "How big is the gap?"], surprises: ["The gap is large"], counterintuitive_findings: ["The aggregate leads"], human_scale_refs: [], spatial_dimensions: ["country"], temporal_dimensions: ["2023"], mechanisms: ["Totals add up"], uncertainties: ["Toy data"], missing_reporting: [], kill_reasons: [] },
  story_graph: { reader_question: Q, visual_thesis: "Start with the leader, then the gap", nodes: [{ id: "n1", label: "Ranking", summary: "Highest and lowest value", kind: "evidence", explanatory_dimension: "comparison", claim_ids: cid.slice(0, 2) }, { id: "n2", label: "Gap", summary: "The distance between them", kind: "evidence", explanatory_dimension: "comparison", claim_ids: cid.slice(2) }, { id: "n3", label: "Caveat", summary: "Toy data only", kind: "uncertainty", explanatory_dimension: "uncertainty" }], edges: [{ from: "n1", to: "n2", relation: "locates" }, { from: "n2", to: "n3", relation: "qualifies" }], entry_node_ids: ["n1"], answer_node_ids: ["n2"] },
  charts: [chartJudgement(0), chartJudgement(1)].slice(0, sh.details.sheet.charts.length),
  visual_concepts: { concepts: ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal", "comparison"].map((framing, n) => ({ concept_id: `c${n + 1}`, reader_question: Q, editorial_premise: `Premise ${n + 1}`, visual_metaphor: `Metaphor ${n + 1}`, hero_scene: `Scene ${n + 1}`, framing, hero_evidence_refs: cid.slice(0, 1), supporting_evidence_refs: cid.slice(1), asset_requirements: [{ kind: "data", available: true, blocking: false }], media_mix: ["bar"], risk_flags: [], reporting_gaps: [], why_memorable: `Reason ${n + 1}` })) },
  semantic_novelty: { modules: [{ id: "m1", reader_question_id: "q1", claim_set: cid.slice(0, 2), new_information: "Who leads and who trails", explanatory_dimension: "comparison" }, { id: "m2", reader_question_id: "q1", claim_set: cid.slice(2), new_information: "How far apart they are", explanatory_dimension: "rank", dependency_on: ["m1"] }] },
  asset_requirements: { concept_id: "c1", requirements: [{ asset_class: "historical_series", status: "optional", available: false, purpose: "The ranked values" }] },
  page: { modules: [{ id: "chart1", chart: 0, story_role: "evidence", priority: 1, visual_grammar: "rank", explanatory_dimension: "rank", story_node_ids: ["n1"] }, { id: "chart2", chart: 1, story_role: "resolution", priority: 2, visual_grammar: "rank", explanatory_dimension: "comparison", story_node_ids: ["n2"] }, textModule("intro", "context", 2, "n2"), textModule("note", "explanation", 3, "n3"), textModule("more", "turn", 3, "n3")] },
  publication: { style_profile: "analytical_precision" },
  ...over,
});
const bytes = [];
const measure = (label, params, out) => bytes.push({ label, sent: JSON.stringify(params).length, got: text(out).length });
const refRe = /patch_of=(infographics\/chain-rejections\/[0-9a-f]{64}\.json)/;

// ---- the sheet: pure program, verified claims only, the chart reads the series computation (computation_refs[1]) ----
assert.equal(sh.details.status, "SHEET");
assert.match(text(sh), /Next:/, "the sheet result carries a next-step sentence");
const claimRecords = claimsOf(art);
assert.ok(sh.details.sheet.charts.length >= 2, "two series, two charts");
for (const chart of sh.details.sheet.charts) {
  const claim = claimRecords.find((c) => c.id === chart.claim_id || c.claim_id === chart.claim_id);
  assert.ok(claim, `claim ${chart.claim_id} is recorded`);
  const series = JSON.parse(readFileSync(join(art, claim.computation_refs[1]), "utf8"));
  assert.equal(chart.sql, series.sql, "the chart's SQL is the series computation's SQL (computation_refs[1])");
  assert.notEqual(claim.computation_refs[0], claim.computation_refs[1]);
}
check("sheet: charts carry the SQL of computation_refs[1] of verified claims, and the result names the next step");
measure("sheet", { part: "sheet" }, sh);

// ---- the full judgement: the page plan is refused once, the patch continues inside the pack ----
const j1p = judgement();
const j1 = await pack.execute("j1", j1p);
measure("judgement", j1p, j1);
assert.equal(j1.details.status, "STOPPED");
assert.equal(j1.details.steps, undefined, "a refused page carries no steps");
const ref1 = refRe.exec(text(j1))[1];
assert.match(text(j1), /Next: call newsroom_design_pack with patch_of=/);
assert.ok(!/newsroom_infographic_chain_patch/.test(text(j1)), "the refusal does not point at a fourth tool");
check("judgement: the refused page plan names patch_of for newsroom_design_pack");

// A patch whose patch_of is not the latest refusal is refused and says which one is.
const wrongBase = await pack.execute("w1", { patch_of: ref1.replace(/[0-9a-f]{4}\.json$/, "0000.json"), ops: [{ op: "add", path: "/dek", value: "x" }] });
assert.equal(wrongBase.details.status, "STOPPED");
assert.ok(text(wrongBase).includes(`patch_of must be ${ref1}`), text(wrongBase).slice(0, 400));
const noOps = await pack.execute("w2", { patch_of: ref1, ops: [] });
assert.match(text(noOps), /DESIGN_PACK_PATCH_INVALID/);
const touchProgram = await pack.execute("w3", { patch_of: ref1, ops: [{ op: "replace", path: "/story_graph_ref", value: "editorial/story-graphs/x.json" }] });
assert.match(text(touchProgram), /DESIGN_PACK_PROGRAM_FIELD[^\n]*\/story_graph_ref/);
const numbered = await pack.execute("w4", { patch_of: ref1, ops: [{ op: "add", path: "/dek", value: "Up 42 percent" }] });
assert.match(text(numbered), /DESIGN_PACK_PATCH_NUMBER/);
// A number can come in inside an object or under a key the text list does not know: all three are refused before anything reaches the chain.
for (const [label, op] of [
  ["a new module with a body", { op: "add", path: "/modules/-", value: { id: "n9", type: "text", body: "Sales rose 40%" } }],
  ["a whole module replaced", { op: "replace", path: "/modules/2", value: { id: "intro", type: "text", body: "Sales rose 40%" } }],
  ["a text field the key list does not name", { op: "add", path: "/modules/2/caption", value: "Sales rose 40%" }],
  ["a number word in a nested list", { op: "add", path: "/modules/-", value: { id: "n9", type: "text", notes: [{ body: "Sales rose forty percent" }] } }],
]) {
  const r = await pack.execute(`w5-${label}`, { patch_of: ref1, ops: [op] });
  assert.match(text(r), /DESIGN_PACK_PATCH_NUMBER/, `${label}: ${text(r).slice(0, 200)}`);
}
{
  const scenes = { schema_version: "0.2.0", scenes: [{ id: "s1", title: "Sales rose 40%", dek: "x 40%" }] };
  const r = await pack.execute("w5-scene", { patch_of: ref1, ops: [{ op: "replace", path: "/scene_graph", value: scenes }] });
  assert.match(text(r), /DESIGN_PACK_PATCH_NUMBER/, `scene title and dek are reader text: ${text(r).slice(0, 200)}`);
}
// ids, references and listed values with digits are not text
{
  const r = await pack.execute("w6", { patch_of: ref1, ops: [{ op: "add", path: "/modules/-", value: { id: "n9", type: "text", claim_ids: ["c1"], manifest_ref: "a/b1.json" } }] });
  assert.ok(!/DESIGN_PACK_PATCH_NUMBER/.test(text(r)), "ids and references are not searched for numbers");
}
check("patch guards: wrong patch_of, empty ops, a program field and a typed number are each refused by name, also inside objects and under unlisted keys");

const quant = (n) => [
  { op: "add", path: `/modules/${n}/visual_channels`, value: [{ field: "name", role: "categorical", channel: "position" }, { field: n ? "change" : "value", role: "quantitative", channel: "length" }] },
  { op: "add", path: `/modules/${n}/quantitative_encoding`, value: { channel: "bar_length", measure: n ? "change" : "value", unit: "index", quantity_kind: n ? "stock_change" : "index", mark_semantics: "length", scale_type: "linear", baseline_policy: "zero", uncertainty_disclosed: false } },
];
const OPS1 = [
  ...quant(0),
  ...quant(1),
  { op: "add", path: "/dek", value: "A short deck line" },
  { op: "add", path: "/intent", value: "Show which area leads" },
  { op: "add", path: "/primary_message", value: "The aggregate leads the ranking." },
  { op: "add", path: "/story_arc", value: "question_answer" },
  { op: "add", path: "/audience", value: "general" },
  { op: "add", path: "/editorial_grammar", value: { project_id: "toy", evidence_features: ["quantity", "comparable_entities"], cognitive_goals: ["COMPARE"], available_renderer_capabilities: ["svg"], primary: "SPECIMEN_GRID", supporting: [] } },
  { op: "add", path: "/scene_graph", value: { schema_version: "0.2.0", scenes: [{ id: "s1", pattern: "hero_with_rail", anchor_module_id: "chart1", sidecar_module_ids: ["intro"], primary_cognitive_goal: "COMPARE", hero_object_id: "chart1", supporting_claim_ids: cid.slice(0, 1), scene_budget: { max_sidecars: 2, max_annotations: 2, max_claims: 3, max_supporting_objects: 2 } }] } },
];
const j2 = await pack.execute("j2", { patch_of: ref1, ops: OPS1 });
measure("patch", { patch_of: ref1, ops: OPS1 }, j2);
const R = j2.details.refs;
assert.ok(R.infographicManifestRef && R.previewRef && R.infographicCriticRef, "the page chain went through after the patch");
assert.equal(j2.details.steps, undefined, "the pack is not RENDERED before the page has been seen");
assert.match(text(j2), /no image-aware vision critic record/);
assert.match(text(j2), /Next: fix the listed problem/);
check("continuation: the patch takes the page chain through and the pack stops where the vision critic is required");

const vc = recording(tools.get("newsroom_infographic_vision_critic"));
const rubric = Object.fromEntries(VISION_RUBRIC_KEYS.map((k) => [k, 90]));
const vParams = { manifest_ref: R.infographicManifestRef, preview_ref: R.previewRef, deterministic_critic_ref: R.infographicCriticRef, passed: true, score: 90, confidence: 0.8, rubric, issues: [] };
const v = await vc.execute("v1", vParams);
measure("vision critic", vParams, v);
assert.match(text(v), /^PASS/);
const j3p = { revise: {} };
const j3 = await pack.execute("j3", j3p);
measure("revise (publication)", j3p, j3);
assert.equal(j3.details.status, "RENDERED", text(j3).slice(-600));
assert.match(text(j3), /Next: call newsroom_infographic_vision_critic/);
assert.equal(j3.details.chart, undefined);
assert.equal(j3.details.designPack, true);
assert.equal(j3.details.chain, "newsroom_design_pack");
assert.equal(j3.details.chainStatus, "COMPLETE");
assert.deepEqual(j3.details.steps.map((step) => step.tool), INNER_STEP_TOOLS, "the record reads as the eight steps the audit expands");
assert.equal(j3.details.steps.length, 8);
assert.equal(j3.details.problems.length, 0);
check("continuation: after the patch and the vision critic the pack is RENDERED and its record is the eight inner steps");

// The same run again, and a run where the publication step never ran, do not name eight steps.
const shortRun = await pack.execute("j4", { patch_of: ref1, ops: OPS1 });
assert.match(text(shortRun), /DESIGN_PACK_NO_REJECTION/, "a page that already went through has nothing left to patch");
check("continuation: patching a page that already went through is refused");

// The page is sent again (same judgement, so the same content-addressed page): it is refused the same way, and now the vision critic record
// exists, so one continuation call takes the page chain, publication and finish through and the pack is RENDERED in that call.
const j5 = await pack.execute("j5", judgement());
assert.equal(j5.details.status, "STOPPED");
const ref5 = refRe.exec(text(j5))[1];
const j6 = await pack.execute("j6", { patch_of: ref5, ops: OPS1 });
measure("patch (record exists)", { patch_of: ref5, ops: OPS1 }, j6);
assert.equal(j6.details.status, "RENDERED", text(j6).slice(0, 700));
assert.deepEqual(j6.details.steps.map((step) => step.tool), INNER_STEP_TOOLS);
assert.equal(j6.details.steps.length, 8);
assert.equal(j6.details.problems.length, 0);
check("continuation: with a vision critic record on the page, one patch call ends RENDERED with the eight inner steps");

// The audit (src/audit.rs) knows the pack's inner steps from the pack's own record, not from the boundary report (which names the chain for writes made inside it).
{
  const audit = readFileSync(join(ROOT, "src/audit.rs"), "utf8");
  const block = audit.slice(audit.indexOf("const DESIGN_PACK_STEPS"), audit.indexOf("];", audit.indexOf("const DESIGN_PACK_STEPS")));
  const auditSteps = [...block.matchAll(/"(newsroom_[a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(auditSteps, INNER_STEP_TOOLS, "the audit's list of inner steps is the pack's");
  assert.deepEqual(j6.details.steps.map((step) => step.tool), auditSteps, "the continuation's record shows every inner step the audit looks for, in order");
  check("audit: the eight steps of a pack that was continued through a patch are read from the pack's own record (names equal src/audit.rs DESIGN_PACK_STEPS)");
}

assert.deepEqual(refusalsOf(art), [], "no boundary refusal in the whole flow");
check("groups: the whole pack flow ran under strict group checks with no refusal");

// ---- a second run: program fields and needs_compute (the judgement pack may be sent three times per run) ----
await setupRun();
// ---- a program field sent with another value is refused by name ----
const bad = judgement();
bad.charts[0] = { ...bad.charts[0], sql: "SELECT 1" };
const badOut = await pack.execute("bad1", bad);
assert.equal(badOut.details.status, "STOPPED");
assert.match(text(badOut), /DESIGN_PACK_PROGRAM_FIELD[^\n]*charts\[0\]\.sql/);
const badRef = judgement();
badRef.page.modules[0] = { ...badRef.page.modules[0], manifest_ref: "visualizations/other.json" };
const badRefOut = await pack.execute("bad2", badRef);
assert.match(text(badRefOut), /page\.modules\.chart1\.manifest_ref/);
check("program fields: a changed chart SQL or module manifest_ref is refused naming the field");

// ---- needs_compute stops the run with runStop ----
const nc = await pack.execute("nc", judgement({ needs_compute: ["a series for 2015 to 2023"] }));
assert.deepEqual(nc.details.runStop, { reason: "needs_compute", step: "design_pack" });
assert.match(text(nc), /Next: nothing/);
check("needs_compute: runStop needs_compute at step design_pack and the result says the run is over");

// ---- end

// ---- no key the patch number check skips is a field the page prints ----
// The set of printed fields is read from the renderer's own reader-text checker (readerTextEntries, infographic.mjs): each skipped key is put where that checker looks
// (the page, a module, a scene, and as a whole scene-graph-shaped object under the key) and must produce no entry. Limit: this follows readerTextEntries only; a composer
// that prints a field the checker does not list is not found here (the composers are templates, not a list of fields that can be read out).
{
  const S = "SENTINEL";
  const sceneShaped = { scenes: [{ id: "s", title: S, dek: S, eyebrow: S }], title: S, dek: S };
  const printed = (spec) => readerTextEntries(spec).filter((entry) => entry.text.includes(S)).map((entry) => entry.field);
  assert.ok(printed({ scene_graph: sceneShaped }).length > 0, "the probe finds reader text where the checker reads it");
  for (const key of PATCH_LISTED_KEYS) {
    const found = [
      ...printed({ [key]: S }),
      ...printed({ modules: [{ id: "m", [key]: S }] }),
      ...printed({ scene_graph: { scenes: [{ id: "s", [key]: S }] } }),
      ...printed({ [key]: sceneShaped }),
    ];
    assert.deepEqual(found, [], `${key} is skipped by the patch number check but the page prints ${found.join(", ")}`);
  }
}
check("patch number check: no skipped key is a field the page prints (derived from readerTextEntries)");

// ---- sentinel: the real composer prints none of the skipped keys ----
// One sentinel string per skipped key, put on the page, on a text module and as a scene-graph-shaped object; the page is composed by composeInfographicBundle and the
// text a reader sees (text nodes and aria-label / alt / title values; not data-* attributes) is searched. No field list is used. A value the page's own validator
// refuses is not composed at all and is counted as refused, never as clean.
{
  const { composeInfographicBundle } = await import(pathToFileURL(join(pi, "infographic.mjs")).href);
  const claim = "claim-sentinel";
  const base = { schema_version: "1.0.0", kicker: "SYSTEMS / DATA FEATURE", title: "A long ranking stays legible on the page", dek: "A synthetic page checks that a tall chart is not shrunk below the text floor.", alt: "A magazine-style page with a tall ranking chart.", byline: "Newsroom Agent", date_label: "Regression edition", layout: "feature", complexity_budget: "medium", source_note: "Synthetic fixture", modules: [
    { id: "section-1", type: "section_header", span: "full", eyebrow: "Ranking", heading: "Heading", deck: "Deck." },
    { id: "text", type: "text", span: "two_thirds", label: "Why it matters", heading: "Reading the tail", body: "Body text here.", claim_ids: [claim] },
    { id: "stat", type: "hero_stat", span: "third", tone: "accent", value: "200", unit: "units", label: "Top", detail: "Detail", claim_id: claim },
  ] };
  const readerText = (svg) => [
    ...String(svg).replace(/<[^>]*>/g, "\n").split("\n"),
    ...[...String(svg).matchAll(/\s(?:aria-label|alt|title)="([^"]*)"/g)].map((m) => m[1]),
  ].join("\n");
  const composed = (spec) => { try { return readerText(composeInfographicBundle(spec, {}, { mobilePages: false }).desktop.svg); } catch { return null; } };
  const S = "QZSENTINEL";
  assert.ok(composed({ ...base, modules: base.modules.map((m, i) => (i === 1 ? { ...m, body: S } : m)) })?.includes(S), "positive control: a body is found in the text a reader sees");
  assert.ok(composed(base) !== null, "the fixture page composes");
  const sceneShaped = { scenes: [{ id: "s", title: S, dek: S, eyebrow: S }], title: S, dek: S };
  let composedCount = 0;
  for (const key of PATCH_LISTED_KEYS) {
    for (const spec of [{ ...base, [key]: S }, { ...base, modules: base.modules.map((m, i) => (i === 1 ? { ...m, [key]: S } : m)) }, { ...base, [key]: sceneShaped }]) {
      const text = composed(spec);
      if (text === null) continue;
      composedCount += 1;
      assert.ok(!text.includes(S), `${key} is skipped by the patch number check but the composed page shows it to the reader`);
    }
  }
  assert.ok(composedCount >= PATCH_LISTED_KEYS.length * 2, `most probes were composed (${composedCount}), not refused`);
}
check("patch number check: the real composer shows no skipped key to the reader (sentinel per key)");

// ---- tool text: everything the model reads names only the three tools ----
const THREE = ["newsroom_data_prepare", "newsroom_design_pack", "newsroom_infographic_vision_critic"];
const SIX = ["artifact_inventory", "news_search", "fetch_url", "download_data", "duckdb_query", "record_claim"];
const namesOther = (value) => String(value).split(/[^A-Za-z0-9_]/).find((word) => (word.startsWith("newsroom_") && !THREE.includes(word)) || SIX.includes(word));
for (const name of SIX) assert.ok(Object.keys(groupsJson.tools).includes(name), `${name} is a name of the table`);
const visibleOf = (t) => JSON.stringify({ label: t.label, description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines, parameters: t.parameters });
const toolsOn = register(PACK);
for (const name of THREE) assert.equal(namesOther(visibleOf(toolsOn.get(name))), undefined, `${name} text names ${namesOther(visibleOf(toolsOn.get(name)))}`);
// The system prompt of the Rust agent is ROLE, the three tools' snippets and guidelines (in the order of PAGE_BUILD_TOOLS), then GENERAL_GUIDELINES (src/agent_prompt.rs); its text is built here the same way.
{
  const source = readFileSync(join(ROOT, "src/agent_prompt.rs"), "utf8");
  const literals = (text) => [...text.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)].map((m) => m[1].replace(/\\\n\s*/g, "").replace(/\\"/g, '"'));
  const role = literals(source.match(/const ROLE: &str =([\s\S]*?);\n/)[1]).join("");
  const general = literals(source.match(/const GENERAL_GUIDELINES[^=]*=\s*\[([\s\S]*?)\];/)[1]);
  assert.ok(role.length > 50 && general.length === 2, `ROLE and GENERAL_GUIDELINES were read from src/agent_prompt.rs (${role.length}, ${general.length})`);
  const system = [role, ...THREE.map((name) => `- ${name}: ${toolsOn.get(name).promptSnippet ?? ""}`), ...THREE.flatMap((name) => toolsOn.get(name).promptGuidelines ?? []), ...general].join("\n");
  assert.equal(namesOther(system), undefined, `the system prompt names ${namesOther(system)}`);
  assert.ok(THREE.every((name) => system.includes(name)), "the system prompt lists the three tools");
}
const hits = seen.map((out, index) => [index, namesOther(out)]).filter(([, word]) => word);
assert.deepEqual(hits, [], `results name another tool: ${hits.map(([i, w]) => `${w} in ${JSON.stringify(seen[i].slice(0, 160))}`).join(" | ")}`);
const lastLine = (out) => out.trim().split("\n").pop();
const lacking = seen.filter((out) => !(THREE.some((name) => lastLine(out).includes(name)) || /^Next: /m.test(out) || /^STOPPED (data_failed|claim_replay_failed) at /.test(lastLine(out))));
assert.deepEqual(lacking.map(lastLine), [], "every result ends with a next-step sentence");
check(`tool text: description, snippet, guidelines and parameters of the three tools, the system prompt built from them and src/agent_prompt.rs, and ${seen.length} results name only the three tools, and each result says what comes next`);

// ---- switch off: the pack, the patch tool, the chain tool and the vision critic read exactly as they did before this change (b031f179) ----
{
  const BASE_SHA = "b031f179";
  const baseText = spawnSync("git", ["-C", ROOT, "show", `${BASE_SHA}:runtime/pi/newsroom.ts`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(baseText.status, 0, "the baseline commit is readable");
  const baseMod = await load(baseText.stdout);
  const OFF = { NEWSROOM_SPEED_DESIGN_PACK: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_CHAIN_PATCH: "1", NEWSROOM_SPEED_PLAN_PATCH: "1" };
  newRun();
  const now = register(OFF);
  const before = register(OFF, baseMod);
  const names = ["newsroom_design_pack", "newsroom_infographic_chain_patch", "newsroom_infographic_chain", "newsroom_infographic_vision_critic"];
  assert.deepEqual([...now.keys()].sort(), [...before.keys()].sort(), "the same tools are registered");
  for (const name of names) {
    assert.ok(now.has(name) && before.has(name), `${name} is registered with the switch off`);
    assert.equal(visibleOf(now.get(name)), visibleOf(before.get(name)), `${name}: description, snippet, guidelines and parameters are byte for byte the baseline's`);
  }
  check(`switch off: ${names.length} tools read byte for byte as at ${BASE_SHA}, and the same ${now.size} tools are registered`);
}

console.log("bytes per step (program text in the result / what the model sent):");
for (const row of bytes) console.log(`  ${row.label.padEnd(24)} result ${String(row.got).padStart(6)}  sent ${String(row.sent).padStart(6)}`);
console.log(`model-facing calls in this flow: ${bytes.length + 2} (R1, R2, then the ${bytes.length} above)`);
console.log(`test_page_build_pack: ${passed} checks passed`);
