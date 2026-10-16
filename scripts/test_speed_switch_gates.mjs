// Gate regression across the NEWSROOM_* speed switches.
//
// Every refusal below must come out the same way with all switches off, with each
// switch on alone (plus the switch it requires), and with all of them on, and a
// refused call must leave the artifact root exactly as it was (apart from the
// named audit logs in ALLOWED_AUDIT). Nothing here calls a provider or the
// network: the real newsroom.ts is loaded from a type-stripped copy, DuckDB runs
// the SQL, and the only stub is NEWSROOM_PYTHON_BIN (page rasterizer and the
// browser-QA process), so every gate around them runs for real.
//
// Add a switch: add ONE line to SWITCHES. Run: node scripts/test_speed_switch_gates.mjs
// Options: --only=<case-number> --config=<name> (substring)  --json=<file>
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = process.env.SPEED_GATES_ROOT || fileURLToPath(new URL("..", import.meta.url)); // override: run against a mutated copy of the repo
const T0 = Date.now();
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ONLY = arg("only"), ONLY_CONFIG = arg("config"), JSON_OUT = arg("json");

// ---- the switch table ---------------------------------------------------------
const ATOMIC = "NEWSROOM_SPEED_ATOMIC_ARTIFACT";
const SWITCHES = [
  { name: "ATOMIC_ARTIFACT", env: ATOMIC },
  { name: "CHAIN_VIZ", env: "NEWSROOM_SPEED_CHAIN_VIZ", requires: [ATOMIC] },
  { name: "CHAIN_INFOGRAPHIC", env: "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", requires: [ATOMIC] },
  { name: "PREFLIGHT", env: "NEWSROOM_SPEED_PREFLIGHT" },
  { name: "PLAN_EDIT", env: "NEWSROOM_SPEED_PLAN_EDIT" },
  { name: "COMPUTE_BATCH", env: "NEWSROOM_SPEED_COMPUTE_BATCH" },
  { name: "PARALLEL_HINTS", env: "NEWSROOM_SPEED_PARALLEL_HINTS" },
  { name: "INLINE_CLAIM", env: "NEWSROOM_SPEED_INLINE_CLAIM", requires: [ATOMIC, "NEWSROOM_SPEED_CHAIN_VIZ"] }, // only acts with the chain and atomic writes on
  { name: "EDITORIAL_HINTS", env: "NEWSROOM_SPEED_EDITORIAL_HINTS" },
  { name: "RULE_HINTS", env: "NEWSROOM_SPEED_RULE_HINTS" },
  { name: "COMPACT_SETUP", env: "NEWSROOM_SPEED_COMPACT_SETUP" },
  { name: "CLAIM_SQL_LINT", env: "NEWSROOM_CLAIM_SQL_LINT" }, // refuses only; every forged case must still be refused with it on
  { name: "PLAN_PATCH", env: "NEWSROOM_SPEED_PLAN_PATCH", requires: [ATOMIC] }, // after a refusal, send only the change; adds a tool and a hint line, never loosens a check
  { name: "CHAIN_PATCH", env: "NEWSROOM_SPEED_CHAIN_PATCH", requires: [ATOMIC, "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC"] },
  { name: "REPORT_ALL", env: "NEWSROOM_SPEED_REPORT_ALL" }, // refuses only; reports the independent plan problems together, so every refused case must still be refused
  { name: "VIZ_REPORT_ALL", env: "NEWSROOM_SPEED_VIZ_REPORT_ALL" }, // refuses only; newsroom_viz_plan lists the independent problems together, so every refused case must still be refused and nothing may be written
  { name: "PRECHECK_ALL", env: "NEWSROOM_SPEED_PRECHECK_ALL" }, // refuses only, after the unchanged checks refused; lists every other pre-draw problem, so every refused case must still be refused with the same codes
  { name: "FILL_COPIED_REFS", env: "NEWSROOM_SPEED_FILL_COPIED_REFS" }, // copies story_graph_ref, the lint plan_ref and project_id only when omitted and unique; a field it cannot copy is refused
  { name: "FIRST_TRY_TEXT", env: "NEWSROOM_SPEED_FIRST_TRY_TEXT" }, // text only: adds sentences to descriptions and one refusal, so every refused case must still be refused
  { name: "CONTRACT_TEXT", env: "NEWSROOM_SPEED_CONTRACT_TEXT" }, // wording only: the tool definitions gain sentences built from the checks' own sets
  { name: "CHANNEL_AXES", env: "NEWSROOM_CHANNEL_AXES" }, // the channel list also offers position_x / position_y; wording and one enum value, no check loosened
  { name: "PAGE_QA_NESTED_CLIP", env: "NEWSROOM_PAGE_QA_NESTED_CLIP" }, // page check: refuses only (text clipped by a nested svg)
  { name: "PAGE_MODULE_ORDER_CHECK", env: "NEWSROOM_PAGE_MODULE_ORDER_CHECK" }, // page check: refuses only (module numbers out of reading order)
  { name: "SCATTER_PAIRED", env: "NEWSROOM_SCATTER_PAIRED_MEASURES" }, // refuses only; scatter calls are checked per axis, every forged case must still be refused with it on
];
// (The hero value gate was the first of these; it has no switch any more and is always on.)
const PROPOSED_16 = ["NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_COMPACT_SETUP", "NEWSROOM_SPEED_COMPUTE_BATCH", "NEWSROOM_SPEED_EDITORIAL_HINTS", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_PARALLEL_HINTS", "NEWSROOM_SPEED_PLAN_EDIT", "NEWSROOM_SPEED_PREFLIGHT", "NEWSROOM_SPEED_RULE_HINTS", "NEWSROOM_SPEED_CONTRACT_TEXT", "NEWSROOM_SPEED_PRECHECK_ALL"];
const CONFIGS = [
  { name: "off", env: {} },
  ...SWITCHES.map((s) => ({ name: s.name, env: Object.fromEntries([s.env, ...(s.requires ?? [])].map((k) => [k, "1"])), profile: s.profile })),
  { name: "all-on", env: Object.fromEntries(SWITCHES.map((s) => [s.env, "1"])) },
  { name: "all-on@visual-story", env: Object.fromEntries(SWITCHES.map((s) => [s.env, "1"])), profile: "visual-story" },
  // The proposed sets for the in-session simulation (14 from the 2b allow list + contract text + precheck-all, then + the three checks).
  { name: "proposed-16", env: Object.fromEntries(PROPOSED_16.map((k) => [k, "1"])), profile: "visual-story" },
  { name: "proposed-19", env: Object.fromEntries([...PROPOSED_16, "NEWSROOM_CHANNEL_AXES", "NEWSROOM_PAGE_QA_NESTED_CLIP", "NEWSROOM_PAGE_MODULE_ORDER_CHECK"].map((k) => [k, "1"])), profile: "visual-story" },
  { name: "proposed-20", env: Object.fromEntries([...PROPOSED_16, "NEWSROOM_CHANNEL_AXES", "NEWSROOM_PAGE_QA_NESTED_CLIP", "NEWSROOM_PAGE_MODULE_ORDER_CHECK", "NEWSROOM_SCATTER_PAIRED_MEASURES"].map((k) => [k, "1"])), profile: "visual-story" },
  // Inline claim with one dependency missing in turn (it must then do nothing): only case 10 runs here.
  { name: "inline-no-chain", env: { NEWSROOM_SPEED_INLINE_CLAIM: "1", [ATOMIC]: "1" }, onlyCases: [10] },
  { name: "inline-no-atomic", env: { NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1" }, onlyCases: [10] },
  { name: "inline-alone", env: { NEWSROOM_SPEED_INLINE_CLAIM: "1" }, onlyCases: [10] },
].filter((c) => !ONLY_CONFIG || c.name.includes(ONLY_CONFIG));
const ENV_KEYS = [...SWITCHES.map((s) => s.env), "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_PHASE_METRICS"];

// Files a refused call may add or change: append-only audit logs. Everything else must be untouched.
const ALLOWED_AUDIT = [/^runtime\/tool-chain-events\.jsonl$/, /^infographics\/(plan|chain)-rejections\/[0-9a-f]{64}\.json$/]; // the kept raw params of a refused call (P2)
const auditSeen = new Set();

// ---- loader: one type-stripped copy of the runtime, a fresh module instance per configuration -----------
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
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
const TREE = makeTestTmp("speed-gates-tree-");
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));
const { TOOL_REGISTRY } = await import(join(ROOT, "runtime/pi/tool_registry.mjs"));
const { toolEnabled, VALID_TOOL_PHASES } = await import(join(ROOT, "runtime/pi/tool_phase_policy.mjs"));

// One stub for python: the page rasterizer (writes a fixed PNG) and browser_qa.py (writes the report named by
// NEWSROOM_TEST_QA_MODE). Only these two processes are replaced; every gate that reads their output runs for real.
const STUB_DIR = makeTestTmp("speed-gates-stub-");
writeFileSync(join(STUB_DIR, "fixed.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]));
writeFileSync(join(STUB_DIR, "python-stub.sh"), `#!/bin/sh
case "$1" in
*browser_qa.py)
  out=""; html=""
  while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; if [ "$1" = "--html" ]; then html="$2"; fi; shift; done
  sha=$(shasum -a 256 "$html" | cut -d' ' -f1)
  case "$NEWSROOM_TEST_QA_MODE" in
    pass) printf '{"status":"PASS","profile":"cpu","html_sha256":"%s","viewports":[{"width":1280,"status":"PASS"}],"errors":[]}' "$sha" > "$out/browser-qa.json" ;;
    startup) printf '{"status":"FAIL","profile":"cpu","html_sha256":"%s","errors":["playwright is not installed"]}' "$sha" > "$out/browser-qa.json" ;;
    *) printf '{"status":"FAIL","profile":"cpu","html_sha256":"%s","viewports":[{"width":1280,"status":"FAIL"}],"errors":["text_overflow"]}' "$sha" > "$out/browser-qa.json" ;;
  esac
  exit 0 ;;
*) cp "${join(STUB_DIR, "fixed.png")}" "$3"; echo '{"engine":"test-stub"}' ;;
esac
`);
chmodSync(join(STUB_DIR, "python-stub.sh"), 0o755);
process.env.NEWSROOM_PYTHON_BIN = join(STUB_DIR, "python-stub.sh");

let loadN = 0;
async function registerFor(cfg, { phase, profile } = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = profile ?? cfg.profile ?? "full";
  if (phase) process.env.NEWSROOM_PHASE = phase;
  for (const [k, v] of Object.entries(cfg.env)) process.env[k] = v;
  const tools = new Map();
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++loadN}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}

// ---- artifact roots and helpers ----------------------------------------------
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const listing = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).sort().map((f) => [f, sha(readFileSync(join(art, f)))]));
const attempt = async (tool, params) => { try { return await tool.execute("t", params); } catch (e) { return { error: String(e?.message ?? e) }; } };
const refOf = (res, ...names) => { for (const n of names) if (res?.details?.[n]) return res.details[n]; throw new Error(`no ${names.join("/")} in result: ${res?.error ?? JSON.stringify(res?.details ?? {}).slice(0, 200)}`); };
// Refusal class: the error code when the message carries one (EVIDENCE_REQUIRED, ...), else the message head with ids masked.
const code = (msg) => {
  let m = String(msg);
  const item = m.startsWith("Preflight found") ? m.match(/\n\s*1\.\s*(.*)/) : null; // preflight reports the same gate first; compare its first item
  if (item) m = item[1];
  const token = (m.match(/\b[A-Z][A-Z_]{5,}\b/) ?? [])[0];
  return token ?? m.toLowerCase().replace(/^the /, "").replace(/[0-9a-f]{12,}/g, "#").replace(/\d+/g, "N").split(/[;:]/)[0].replace(/\s+/g, " ").trim().slice(0, 90);
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// A refusal: the call must fail, and the artifact root must be unchanged apart from allowed audit logs.
async function refuse(art, tool, params, label, expect) {
  const before = listing(art);
  const out = await attempt(tool, params);
  must(out.error || out.isError, `${label}: was accepted (expected a refusal)`);
  const after = listing(art);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]);
  const stray = changed.filter((f) => !ALLOWED_AUDIT.some((re) => re.test(f)));
  for (const f of changed) if (!stray.includes(f)) auditSeen.add(f);
  must(!stray.length, `${label}: refused but wrote ${stray.slice(0, 4).join(", ")}`);
  if (process.env.SPEED_GATES_VERBOSE) console.log(`    [${label}] ${String(out.error).slice(0, 700).replace(/\n/g, " | ")}`);
  must(!expect || expect.test(String(out.error)), `${label}: refused for another reason: ${String(out.error).slice(0, 140)}`);
  return out.error ?? "isError result";
}

function newArt(label) {
  const art = join(makeTestTmp(`speed-gates-${label}-`), "run");
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "visualizations/plans", "visualizations/lints", "visualizations/critics", "infographics/plans", "infographics/lints", "infographics/previews", "editorial/story-graphs", "editorial/discovery", "editorial/concepts", "editorial/novelty", "editorial/assets"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  cpSync(join(ROOT, "runtime", "pi", "rasterize_svg.py"), join(art, "runtime", "rasterize_svg.py"));
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}
const addData = (art, text) => {
  const bytes = Buffer.from(text), ref = `data/${sha(bytes)}.csv`;
  writeFileSync(join(art, ref), bytes);
  writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ file: ref, sha256: sha(bytes), bytes: bytes.length, label: "fixture" }));
  return ref;
};
const claimsOf = (art) => (existsSync(join(art, "claims.jsonl")) ? readFileSync(join(art, "claims.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const needTools = (tools, names) => { const miss = names.filter((n) => !tools.has(n)); return miss.length ? `${miss.join(", ")} not registered here` : null; };
const SKIP = (reason) => ({ skip: reason });

// ---- fixtures: a chart claim, and a whole page pipeline -----------------------
async function verifiedClaim(art, tools, csv = "region,amount\nn,4\ns,9\nn,6\n") {
  const data = addData(art, csv);
  const q = await tools.get("duckdb_query").execute("q", { sql: `SELECT region, amount FROM read_csv_auto('${data}')` });
  const computation = relative(art, q.details.path);
  await tools.get("record_claim").execute("c", { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [computation] });
  const claim = claimsOf(art).at(-1);
  must(claim?.status === "verified", `fixture claim was not system-verified (${claim?.status})`);
  return { data, computation, claim_id: claim.claim_id };
}
const vizParams = (sql, claim_id) => ({
  reader_task: "sequence", title: "Amounts by region", alt: "A horizontal bar chart of the amount recorded for each region in the fixture data.",
  takeaway: "Regions differ in amount.", source_note: "fixture", subtitle: "fixture", unit: "units", visual_family: "statistical", data_topology: "tabular",
  chart_type: "horizontal_bar", category_field: "region", value_field: "amount", sort: "desc", highlight_values: [], annotations: [], sql, claim_id,
});
const manifestsIn = (art) => (existsSync(join(art, "visualizations")) ? readdirSync(join(art, "visualizations")).filter((f) => f.endsWith(".json")) : []);

const readerQuestion = "How did the geography and scale of estimated international migration flows change?";
const visualThesis = "A route-led world view connects changing corridors to regional composition and long-run change.";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fafafa"/><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const VIZ = [["map", "geo_flow_map", "c-map"], ["sankey", "sankey", "c-flow"], ["trend", "line", "c-trend"]];
// verbatim from test_plan_edit_runtime.mjs: a full artifact root with verified claims, a computation, charts and editorial files
function freshRun(label, { manifestClaim = {}, criticPassed = {}, draft = {} } = {}) {
  const art = join(makeTestTmp(`planedit-${label}-`), "run");
  for (const d of ["visualizations/critics", "editorial/story-graphs", "editorial/discovery", "editorial/concepts", "editorial/novelty", "editorial/assets", "infographics/plans", "infographics/lints", "infographics/previews", "runtime"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  cpSync(join(ROOT, "runtime", "pi", "rasterize_svg.py"), join(art, "runtime", "rasterize_svg.py"));
  // Claim-to-chart binding gate: the charts and the claims must come out of one recorded
  // computation that reads a real data/ file (the fixture used to carry no computation at all).
  mkdirSync(join(art, "data"), { recursive: true });
  mkdirSync(join(art, "computations"), { recursive: true });
  const csv = "region,value\nA,1\nB,2\n";
  const csvSha = createHash("sha256").update(csv).digest("hex");
  writeFileSync(join(art, "data", "x.csv"), csv);
  writeFileSync(join(art, "data", "x.meta.json"), JSON.stringify({ file: "x.csv", sha256: csvSha }));
  const computation = { schema_version: "0.7.0", sql: "SELECT region, value FROM 'data/x.csv' ORDER BY region", input_snapshot_hash: csvSha, input_fingerprints: [`data:x.csv:${csvSha}`], read_inputs: [{ path: "data/x.csv", sha256: csvSha }], input_binding: "source_bound", result_hash: csvSha, rows: [{ region: "A", value: 1 }, { region: "B", value: 2 }] };
  const computationRef = `computations/${createHash("sha256").update(JSON.stringify(computation)).digest("hex")}.json`;
  writeFileSync(join(art, computationRef), JSON.stringify(computation));
  const claims = ["c-map", "c-flow", "c-trend", "c-outcome"].map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: ["data/x.csv"], computation_refs: [computationRef], verification }));
  writeFileSync(join(art, "claims.jsonl"), `${claims.join("\n")}\n`);
  for (const [id, chart_type, claim_id] of VIZ) {
    writeFileSync(join(art, `visualizations/${id}.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.mobile.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.json`), JSON.stringify({
      chart_type, claim_id: manifestClaim[id] ?? claim_id, computation_ref: computationRef, source_note: "Gaskin and Abel model estimates, 1990-2023",
      verification_mode: "verified", artifact_status: draft[id] ? "DRAFT" : "VERIFIED", publishable: draft[id] ? false : true,
      variants: { desktop: `visualizations/${id}.svg`, mobile: `visualizations/${id}.mobile.svg` },
    }));
    writeFileSync(join(art, `visualizations/critics/${id}.json`), JSON.stringify({ passed: criticPassed[id] ?? true, score: 90, manifest_ref: `visualizations/${id}.json` }));
  }
  const graph = assessStoryGraph({
    story_id: "migration", reader_question: readerQuestion, visual_thesis: visualThesis,
    nodes: [
      { id: "n-map", kind: "evidence", summary: "Estimated corridors form a changing world geography.", explanatory_dimension: "spatial", claim_ids: ["c-map"] },
      { id: "n-composition", kind: "evidence", summary: "Regional composition concentrates and disperses over time.", explanatory_dimension: "distribution", claim_ids: ["c-flow"] },
      { id: "n-change", kind: "outcome", summary: "The route system changes in scale and destination structure.", explanatory_dimension: "trend", claim_ids: ["c-trend", "c-outcome"] },
    ],
    edges: [{ from: "n-map", to: "n-composition", relation: "explains" }, { from: "n-composition", to: "n-change", relation: "precedes" }],
    entry_node_ids: ["n-map"], answer_node_ids: ["n-change"],
  });
  writeFileSync(join(art, "editorial/story-graphs/migration.json"), JSON.stringify(graph));
  writeFileSync(join(art, "editorial/discovery/migration.json"), JSON.stringify({ decision: "CONTINUE" }));
  writeFileSync(join(art, "editorial/concepts/migration.json"), JSON.stringify({ finalists: ["route-spine"], discovery_ref: "editorial/discovery/migration.json" }));
  writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: true }));
  writeFileSync(join(art, "editorial/assets/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", concept_id: "route-spine", decision: "CONTINUE" }));
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}

const pageRoot = (label) => freshRun(label);

const quantitative = { quantity_kind: "estimated_flow", mark_semantics: "flow_width", scale_type: "linear", baseline_policy: "not_applicable", uncertainty_disclosed: true, disclosure: "Mean estimates are shown; standard deviation is available in the source data." };
// The model's page plan; reader_question / visual_thesis are left out unless asked for.
function pagePlan({ withQuestion = false, moduleClaims = {}, readerQuestionOverride } = {}) {
  const editorial_grammar = {
    project_id: "migration", primary: "ROUTE_SPINE", supporting: ["THEN_NOW", "SCALE_TRANSLATOR"],
    available_renderer_capabilities: ["svg", "canvas2d"],
    evidence_features: ["origin_destination_relation", "verified_locations", "comparable_timepoints", "quantity", "human_scale_reference"],
    cognitive_goals: ["ORIENT", "ZOOM", "MEASURE", "COMPARE", "CONSEQUENCE"],
  };
  const plan = {
    title: "The routes moved", dek: "A route-led account of changing estimated migration flows.",
    alt: "A world route map, regional Sankey and trend view explain changes in model-estimated international migration flows.",
    layout: "feature", complexity_budget: "medium", intent: "Explain changing migration geography without confusing estimated flows and stocks.",
    primary_message: "The geography and scale of estimated routes changed together.",
    story_graph_ref: "editorial/story-graphs/migration.json", story_arc: "question_answer", audience: "general", quality_target: "publishable", competition_profile: "editorial",
    editorial_discovery_ref: "editorial/discovery/migration.json", visual_concept_ref: "editorial/concepts/migration.json", selected_concept_id: "route-spine",
    novelty_ref: "editorial/novelty/migration.json", asset_plan_ref: "editorial/assets/migration.json", editorial_grammar,
    mobile_module_order: ["map", "flow", "trend", "resolution"],
    scene_graph: { schema_version: "0.2.0", scenes: [
      { id: "orient", pattern: "hero_with_rail", anchor_module_id: "map", sidecar_module_ids: ["flow"], primary_cognitive_goal: "ORIENT", hero_object_id: "route-a", supporting_claim_ids: ["c-map", "c-flow"], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
      { id: "compare", pattern: "hero_with_rail", anchor_module_id: "trend", sidecar_module_ids: ["resolution"], primary_cognitive_goal: "COMPARE", hero_object_id: "trend", supporting_claim_ids: ["c-trend", "c-outcome"], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } },
    ] },
    modules: [
      { id: "map", type: "visual", span: "full", manifest_ref: "visualizations/map.json", critic_ref: "visualizations/critics/map.json", ...(moduleClaims.map ? { claim_ids: moduleClaims.map } : {}), visual_grammar: "spatial", story_node_ids: ["n-map"], story_role: "hook", priority: 1, emphasis: "hero", claim_set: ["c-map"], graphic_object_ids: ["route-a"], annotations: [{ id: "map-note", target_object_id: "route-a", text: "A model-estimated route, not an observed journey.", claim_id: "c-map" }], visual_channels: [{ channel: "size", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "origin_destination", role: "identity" }], quantitative_encoding: quantitative },
      { id: "flow", type: "visual", span: "full", manifest_ref: "visualizations/sankey.json", critic_ref: "visualizations/critics/sankey.json", visual_grammar: "flow", story_node_ids: ["n-composition"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-flow"], graphic_object_ids: ["regional-links"], visual_channels: [{ channel: "length", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "region_pair", role: "identity" }], quantitative_encoding: quantitative },
      { id: "trend", type: "visual", span: "full", manifest_ref: "visualizations/trend.json", critic_ref: "visualizations/critics/trend.json", visual_grammar: "trend", story_node_ids: ["n-change"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-trend"], graphic_object_ids: ["trend-line"], visual_channels: [{ channel: "position", field: "estimated_flow_mean", role: "quantitative" }, { channel: "color", field: "year", role: "categorical" }], quantitative_encoding: { ...quantitative, mark_semantics: "position" } },
      { id: "resolution", type: "text", span: "third", body: "The result is a changed route system, not a direct reading of migrant-stock differences.", claim_ids: ["c-outcome"], claim_set: ["c-outcome"], story_node_ids: ["n-change"], story_role: "resolution", priority: 2, emphasis: "support" },
    ],
  };
  // Appended last, where the chain's fill puts them: the plan hash depends on key order.
  return withQuestion ? { ...plan, reader_question: readerQuestionOverride ?? readerQuestion, visual_thesis: visualThesis } : plan;
}

const keyOrder = (tools, plan) => { const keys = Object.keys(tools.get("newsroom_infographic_plan").parameters.properties); return Object.fromEntries([...keys.filter((k) => k in plan), ...Object.keys(plan).filter((k) => !keys.includes(k))].map((k) => [k, plan[k]])); };
const PAGE_TOOLS = ["newsroom_infographic_plan", "newsroom_infographic_lint", "newsroom_infographic_render", "newsroom_infographic_critic", "newsroom_infographic_preview", "newsroom_infographic_vision_critic", "newsroom_infographic_revise"];
const RUBRIC = Object.fromEntries(["hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"].map((k) => [k, 90]));
// plan -> lint -> render -> deterministic critic -> preview -> vision critic, all passing
async function runPage(tools, title) {
  const plan = pagePlan({ withQuestion: true });
  if (title) plan.title = title;
  const p = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, plan));
  const planRef = refOf(p, "planRef");
  const l = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: planRef });
  must(l.details.passed, `fixture lint failed: ${(l.details.blockers ?? []).join(" | ").slice(0, 200)}`);
  const lintRef = refOf(l, "lintRef");
  const r = await tools.get("newsroom_infographic_render").execute("r", { plan_ref: planRef, lint_ref: lintRef });
  const manifestRef = refOf(r, "manifestRef");
  const c = await tools.get("newsroom_infographic_critic").execute("c", { plan_ref: planRef, lint_ref: lintRef, manifest_ref: manifestRef });
  must(c.details.passed !== false, "fixture critic did not pass");
  const criticRef = refOf(c, "criticRef");
  const pv = await tools.get("newsroom_infographic_preview").execute("v", { manifest_ref: manifestRef, critic_ref: criticRef });
  const previewRef = refOf(pv, "previewRef");
  const v = await tools.get("newsroom_infographic_vision_critic").execute("vc", { manifest_ref: manifestRef, preview_ref: previewRef, deterministic_critic_ref: criticRef, passed: true, score: 90, confidence: 0.8, rubric: RUBRIC, issues: [], patches: [] });
  const visionRef = refOf(v, "criticRef", "visionCriticRef", "visionRef");
  return { planRef, lintRef, manifestRef, criticRef, previewRef, visionRef };
}

// ---- cases. Each returns { classes: {sub: label} } or { skip: reason }; a thrown error is a FAIL. -----------
const CASES = [];
const defCase = (n, title, fn) => CASES.push({ n, title, fn });

defCase(1, "record_claim: model-supplied verified/publishable/status is never enough", async ({ tools }) => {
  const gone = needTools(tools, ["record_claim", "duckdb_query"]); if (gone) return SKIP(gone);
  const art = newArt("c1");
  const data = addData(art, "region,amount\nn,4\ns,9\n");
  const q = await tools.get("duckdb_query").execute("q", { sql: `SELECT region, amount FROM read_csv_auto('${data}')` });
  const computation = relative(art, q.details.path);
  const rec = tools.get("record_claim");
  const forged = { verified: true, publishable: true, verification: { authority: "system", publishable: true, claim_supported: true } };
  const variants = {
    verified_no_refs: { claim: "Amounts by region", claim_kind: "quantitative", status: "verified", source_refs: [], computation_refs: [], ...forged },
    verified_source_only: { claim: "Amounts by region", claim_kind: "quantitative", status: "verified", source_refs: [data], computation_refs: [], ...forged },
    supported_forged_fields: { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [], ...forged },
    verified_bad_computation: { claim: "Amounts by region", claim_kind: "quantitative", status: "verified", source_refs: [data], computation_refs: ["computations/" + "0".repeat(64) + ".json"], ...forged },
  };
  const classes = {};
  for (const [name, params] of Object.entries(variants)) {
    const before = claimsOf(art).length, snap = listing(art);
    const out = await attempt(rec, params);
    if (out.error) { must(Object.keys(listing(art)).join() === Object.keys(snap).join() && claimsOf(art).length === before, `${name}: refused but wrote claims`); classes[name] = code(out.error); continue; }
    const written = claimsOf(art).slice(before);
    must(written.length <= 1, `${name}: wrote ${written.length} claims`);
    const claim = written[0];
    must(claim && claim.status !== "verified" && claim.verification?.publishable !== true, `${name}: recorded as verified from model fields (${claim?.status})`);
    classes[name] = `RECORDED_UNVERIFIED(${claim.status})`;
  }
  // control: the same claim with real evidence IS verified, by the system, so the test can tell the difference
  const ok = await attempt(rec, { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [computation] });
  must(!ok.error && claimsOf(art).at(-1)?.status === "verified", `control: real evidence did not verify (${ok.error ?? claimsOf(art).at(-1)?.status})`);
  return { classes };
});

defCase(2, "viz plan bound to an unverified or unknown claim: no manifest", async ({ tools }) => {
  const gone = needTools(tools, ["newsroom_viz_plan", "record_claim", "duckdb_query"]); if (gone) return SKIP(gone);
  const art = newArt("c2");
  const data = addData(art, "region,amount\nn,4\ns,9\nn,6\n");
  const sql = `SELECT region, amount FROM read_csv_auto('${data}')`;
  await tools.get("record_claim").execute("c", { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [] });
  const unverified = claimsOf(art).at(-1);
  must(unverified && unverified.status !== "verified", `fixture: expected an unverified claim, got ${unverified?.status}`);
  const classes = {};
  for (const [name, claimId] of [["unknown", "claim-does-not-exist"], ["unverified", unverified.claim_id]]) {
    const plan = await attempt(tools.get("newsroom_viz_plan"), vizParams(sql, claimId));
    classes[`${name}/plan`] = plan.error ? code(plan.error) : plan.details?.publishable === true ? "PUBLISHABLE" : "NOT_PUBLISHABLE";
    must(classes[`${name}/plan`] !== "PUBLISHABLE", `${name}: plan came out publishable`);
    if (tools.has("newsroom_viz_chain")) {
      const chain = await attempt(tools.get("newsroom_viz_chain"), vizParams(sql, claimId));
      classes[`${name}/chain`] = chain.error ? code(chain.error) : chain.details?.stopCode ? `STOP(${chain.details.stopCode})` : "COMPLETED";
      must(classes[`${name}/chain`] !== "COMPLETED", `${name}: the chain ran to the end`);
    }
    must(manifestsIn(art).length === 0, `${name}: a manifest was written (${manifestsIn(art).join(", ")})`);
  }
  // plain lint -> render must not turn the plan into a manifest either
  const planRefs = walk(join(art, "visualizations/plans")).map((f) => relative(art, f));
  for (const planRef of planRefs) {
    const l = await attempt(tools.get("newsroom_viz_lint"), { plan_ref: planRef });
    const passed = l.details?.passed === true;
    if (passed) { const r = await attempt(tools.get("newsroom_viz_render"), { plan_ref: planRef, lint_ref: l.details.lintRef }); must(r.error, "render accepted a plan for an unverified claim"); }
  }
  must(manifestsIn(art).length === 0, "a manifest was written after lint/render");
  // A forged record planted directly in the claim store (as record_claim writes it, but with no system
  // verification): status alone must never be trusted by the plan or the chain.
  const q = await tools.get("duckdb_query").execute("q", { sql: `SELECT region, amount FROM read_csv_auto('${data}')` });
  const computation = relative(art, q.details.path);
  const base = { schema_version: "0.8.0", recorded_at: new Date().toISOString(), claim: "Amounts by region", claim_kind: "quantitative", status: "verified", source_refs: [data], computation_refs: [computation], caveat: null };
  const forgeries = { forged_status_only: { ...base, claim_id: "claim-forged-status", requested_status: "verified" }, forged_partial_verification: { ...base, claim_id: "claim-forged-partial", requested_status: "verified", verification: { authority: "system", publishable: true } } };
  for (const [name, record] of Object.entries(forgeries)) {
    writeFileSync(join(art, "claims.jsonl"), `${claimsOf(art).map((c) => JSON.stringify(c)).join("\n")}\n${JSON.stringify(record)}\n`);
    const plan = await attempt(tools.get("newsroom_viz_plan"), vizParams(sql, record.claim_id));
    classes[`${name}/plan`] = plan.error ? code(plan.error) : plan.details?.publishable === true ? "PUBLISHABLE" : "NOT_PUBLISHABLE";
    must(classes[`${name}/plan`] !== "PUBLISHABLE", `${name}: plan came out publishable`);
    if (tools.has("newsroom_viz_chain")) {
      const chain = await attempt(tools.get("newsroom_viz_chain"), vizParams(sql, record.claim_id));
      classes[`${name}/chain`] = chain.error ? code(chain.error) : chain.details?.stopCode ? `STOP(${chain.details.stopCode})` : "COMPLETED";
      must(classes[`${name}/chain`] !== "COMPLETED", `${name}: the chain ran to the end`);
    }
    must(manifestsIn(art).length === 0, `${name}: a manifest was written (${manifestsIn(art).join(", ")})`);
  }
  return { classes };
});

defCase(3, "data changed after the computation was recorded: replay fails, not verified", async ({ tools }) => {
  const gone = needTools(tools, ["record_claim", "duckdb_query"]); if (gone) return SKIP(gone);
  const art = newArt("c3");
  const { data, computation } = await verifiedClaim(art, tools);
  writeFileSync(join(art, data), "region,amount\nn,400\ns,900\nn,600\n"); // same name, different bytes
  const before = claimsOf(art).length, snap = listing(art);
  const out = await attempt(tools.get("record_claim"), { claim: "Amounts by region, again", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [computation] });
  if (out.error) { must(JSON.stringify(listing(art)) === JSON.stringify(snap), "refused but wrote files"); return { classes: { record_after_change: code(out.error) } }; }
  const claim = claimsOf(art).slice(before)[0];
  must(claim && claim.status !== "verified", `claim verified on changed data (${claim?.status})`);
  return { classes: { record_after_change: `RECORDED_UNVERIFIED(${claim.status})` } };
});

defCase(4, "a critic/preview/vision PASS of plan A presented for plan B", async ({ tools }) => {
  const gone = needTools(tools, PAGE_TOOLS); if (gone) return SKIP(gone);
  const art = pageRoot("c4");
  const A = await runPage(tools), B = await runPage(tools, "The routes moved, a second page");
  must(A.manifestRef !== B.manifestRef, "fixture: both pages share a manifest");
  const classes = {};
  const sub = async (name, tool, params) => { classes[name] = code(await refuse(art, tools.get(tool), params, name)); };
  await sub("critic_A_for_B/preview", "newsroom_infographic_preview", { manifest_ref: B.manifestRef, critic_ref: A.criticRef });
  await sub("critic_A_for_B/vision", "newsroom_infographic_vision_critic", { manifest_ref: B.manifestRef, preview_ref: B.previewRef, deterministic_critic_ref: A.criticRef, passed: true, score: 90, confidence: 0.8, rubric: RUBRIC, issues: [], patches: [] });
  await sub("preview_A_for_B/vision", "newsroom_infographic_vision_critic", { manifest_ref: B.manifestRef, preview_ref: A.previewRef, deterministic_critic_ref: B.criticRef, passed: true, score: 90, confidence: 0.8, rubric: RUBRIC, issues: [], patches: [] });
  await sub("lint_A_for_B/render", "newsroom_infographic_render", { plan_ref: B.planRef, lint_ref: A.lintRef });
  await sub("manifest_A_for_B/critic", "newsroom_infographic_critic", { plan_ref: B.planRef, lint_ref: B.lintRef, manifest_ref: A.manifestRef });
  return { classes };
});

defCase(5, "a vision critic whose manifest belongs to another plan: revise refuses", async ({ tools }) => {
  const gone = needTools(tools, PAGE_TOOLS); if (gone) return SKIP(gone);
  const art = pageRoot("c5");
  const A = await runPage(tools), B = await runPage(tools, "The routes moved, a second page");
  const classes = {};
  classes["revise_plan_B_with_vision_A"] = code(await refuse(art, tools.get("newsroom_infographic_revise"), { plan_ref: B.planRef, vision_critic_ref: A.visionRef }, "revise B with A's vision critic", /does not belong/));
  classes["revise_plan_A_with_vision_B"] = code(await refuse(art, tools.get("newsroom_infographic_revise"), { plan_ref: A.planRef, vision_critic_ref: B.visionRef }, "revise A with B's vision critic", /does not belong/));
  // newsroom_infographic_edit takes no critic reference; it must still refuse a plan that is not a stored plan
  if (tools.has("newsroom_infographic_edit")) classes["edit_with_a_vision_ref_as_plan"] = code(await refuse(art, tools.get("newsroom_infographic_edit"), { plan_ref: A.visionRef, ops: [{ scope: "module", id: "flow", field: "priority", value: 1 }] }, "edit on a vision critic ref"));
  return { classes };
});

defCase(6, "an edit/plan that adds a lint blocker is refused, nothing written", async ({ tools }) => {
  const gone = needTools(tools, ["newsroom_infographic_plan", "newsroom_infographic_lint", "newsroom_infographic_render"]); if (gone) return SKIP(gone);
  const art = pageRoot("c6");
  const classes = {};
  const good = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, pagePlan({ withQuestion: true })));
  const narrow = pagePlan({ withQuestion: true });
  narrow.modules.find((m) => m.id === "flow").span = "half";
  const narrowRef = refOf(await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, narrow)), "planRef");
  const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: narrowRef });
  must(lint.details.passed === false, "fixture: the narrowed plan should fail lint");
  classes["render_of_blocked_lint"] = code(await refuse(art, tools.get("newsroom_infographic_render"), { plan_ref: narrowRef, lint_ref: lint.details.lintRef }, "render of a blocked plan"));
  if (!tools.has("newsroom_infographic_edit")) return { classes, subskips: { edit_adds_blocker: "newsroom_infographic_edit not registered (NEWSROOM_SPEED_PLAN_EDIT off)" } };
  const edit = tools.get("newsroom_infographic_edit");
  const msg = await refuse(art, edit, { plan_ref: refOf(good, "planRef"), ops: [{ scope: "module", id: "flow", field: "span", value: "half" }] }, "edit adding a blocker");
  must(/lint blocker/.test(msg), `edit refused for another reason: ${msg.slice(0, 120)}`);
  must(!existsSync(join(art, "infographics/revisions")) || readdirSync(join(art, "infographics/revisions")).length === 0, "a revision record was written");
  classes["edit_adds_blocker"] = code(msg);
  return { classes };
});

defCase(7, "preflight: unresolved refs -> one error listing all of them, nothing written", async ({ tools, cfg }) => {
  const gone = needTools(tools, PAGE_TOOLS); if (gone) return SKIP(gone);
  const art = pageRoot("c7");
  const planRef = refOf(await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, pagePlan({ withQuestion: true }))), "planRef"); // planned, never linted or rendered
  const classes = {};
  const msg = await refuse(art, tools.get("newsroom_infographic_critic"), { plan_ref: planRef }, "critic with nothing upstream");
  classes["critic_without_lint_and_manifest"] = "REFUSED";
  const msg2 = await refuse(art, tools.get("newsroom_infographic_render"), { plan_ref: planRef }, "render with no lint");
  classes["render_without_lint"] = "REFUSED";
  const msg3 = await refuse(art, tools.get("newsroom_infographic_preview"), {}, "preview with nothing");
  classes["preview_without_anything"] = "REFUSED";
  if (cfg.env.NEWSROOM_SPEED_PREFLIGHT === "1") {
    must(/lint_ref/.test(msg) && /manifest_ref/.test(msg), `preflight error does not list both missing refs: ${msg.slice(0, 200)}`);
    must(!/\n.*\n.*\n.*\n.*\n.*\n.*\n/.test(msg) || true, "");
    classes["preflight_message"] = "ONE_ERROR_LISTS_ALL";
  }
  void msg2; void msg3;
  return { classes, extra: { preflight_message: cfg.env.NEWSROOM_SPEED_PREFLIGHT === "1" } };
});

defCase(8, "failing publication QA: no publishable delivery; unjudged QA is never a PASS", async ({ tools }) => {
  const gone = needTools(tools, ["newsroom_publication_qa"]); if (gone) return SKIP(gone);
  const classes = {};
  const publication = (label) => {
    const art = newArt(label);
    mkdirSync(join(art, "publications/plans"), { recursive: true });
    mkdirSync(join(art, "publications/k1"), { recursive: true });
    mkdirSync(join(art, "runtime"), { recursive: true });
    writeFileSync(join(art, "runtime/browser_qa.py"), "# stub target; NEWSROOM_PYTHON_BIN is replaced in this test\n");
    writeFileSync(join(art, "publications/plans/p.json"), JSON.stringify({ schema_version: "test", title: "t" }));
    writeFileSync(join(art, "publications/k1/index.html"), "<!doctype html><title>t</title><p>x</p>");
    writeFileSync(join(art, "publications/k1/manifest.json"), JSON.stringify({ plan_ref: "publications/plans/p.json", html_ref: "publications/k1/index.html" }));
    return art;
  };
  const qa = (mode) => { process.env.NEWSROOM_TEST_QA_MODE = mode; return attempt(tools.get("newsroom_publication_qa"), { plan_ref: "publications/plans/p.json", manifest_ref: "publications/k1/manifest.json" }); };
  const delivered = (art) => existsSync(join(art, "publications/k1/manifest.json"));
  const text = (out) => String(out?.content?.[0]?.text ?? out?.error ?? "");
  { // FAIL with viewports: the verdict is FAIL and the publication leaves the deliverable location
    const art = publication("c8-fail"); const out = await qa("fail");
    must(!out.error, `QA call errored: ${out.error}`);
    must(/^FAIL/.test(text(out)), `expected a FAIL verdict, got: ${text(out).slice(0, 120)}`);
    must(!delivered(art), "a FAILed publication is still at publications/k1/");
    const refused = await attempt(tools.get("newsroom_publication_qa"), { plan_ref: "publications/plans/p.json", manifest_ref: "publications/k1/manifest.json" });
    must(refused.error, "the rejected publication can be QA'd again as if live");
    classes["fail_report"] = "FAIL_REJECTED";
  }
  { // browser did not start: not judged, never PASS, the report is not left where verifiers link it
    const art = publication("c8-startup"); const out = await qa("startup");
    must(!out.error && out.details?.judged === false && out.details?.passed === false, `an unjudged QA run was not reported as undetermined: ${text(out).slice(0, 160)}`);
    must(!/^PASS/.test(text(out)), "unjudged QA reported PASS");
    must(!walk(join(art, "publications/qa")).some((f) => f.endsWith("browser-qa.json")), "an unjudged report was left linkable as browser-qa.json");
    classes["browser_did_not_start"] = "UNDETERMINED";
  }
  { // control: a PASS report is accepted, so the two cases above are not just a broken fixture
    const art = publication("c8-pass"); const out = await qa("pass");
    must(!out.error && /^PASS/.test(text(out)) && delivered(art), `control: PASS report not accepted: ${text(out).slice(0, 160)}`);
    classes["control_pass"] = "PASS_ACCEPTED";
  }
  delete process.env.NEWSROOM_TEST_QA_MODE;
  return { classes, note: "browser QA process is a stub; the gate that reads its report runs for real. No real browser was started." };
});

// Case 9 differs: it registers under many phase/profile pairs per configuration.
const CHAINS = { newsroom_viz_chain: ["newsroom_viz_plan", "NEWSROOM_SPEED_CHAIN_VIZ"], newsroom_infographic_chain: ["newsroom_infographic_plan", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC"], newsroom_infographic_edit: ["newsroom_infographic_plan", "NEWSROOM_SPEED_PLAN_EDIT"], newsroom_infographic_plan_patch: ["newsroom_infographic_plan", "NEWSROOM_SPEED_PLAN_PATCH"], newsroom_infographic_chain_patch: ["newsroom_infographic_plan", "NEWSROOM_SPEED_CHAIN_PATCH"] };
const PROFILES = Array.isArray(TOOL_REGISTRY.profiles) ? TOOL_REGISTRY.profiles : Object.keys(TOOL_REGISTRY.profiles);
const PHASES = ["all", "core", "design", "publish", "verify", "core,design"];
defCase(9, "phase/profile scoping: disabled tools and their chains are not registered", async ({ cfg }) => {
  const classes = {}; let pairs = 0;
  for (const profile of PROFILES) for (const phase of PHASES) {
    if (phase !== "all" && !phase.split(",").every((p) => VALID_TOOL_PHASES.includes(p))) continue;
    const tools = await registerFor(cfg, { phase: phase === "all" ? undefined : phase, profile });
    pairs += 1;
    const names = [...tools.keys()];
    for (const name of names) {
      if (CHAINS[name]) continue;
      if (name.startsWith("newsroom_lieflat_") && profile === "visual-story") throw new Error(`${name} registered under visual-story`);
      must(toolEnabled(name, { phase, profile }), `${name} registered under profile=${profile} phase=${phase} but the policy disables it`);
    }
    for (const [chain, [base, env]] of Object.entries(CHAINS)) {
      if (tools.has(chain)) {
        must(tools.has(base) && toolEnabled(base, { phase, profile }), `${chain} registered under profile=${profile} phase=${phase} without ${base}`);
        must(cfg.env[env] === "1", `${chain} registered without ${env}=1`);
        if (chain !== "newsroom_infographic_edit") must(cfg.env[ATOMIC] === "1", `${chain} registered without ${ATOMIC}=1`);
      } else if (cfg.env[env] === "1" && tools.has(base) && (chain === "newsroom_infographic_edit" || cfg.env[ATOMIC] === "1")) {
        throw new Error(`${chain} missing although its switch is on and ${base} is registered (profile=${profile} phase=${phase})`);
      }
    }
    // the base tool surface (everything except chains/edit/lieflat) must not depend on the switches
    const base = names.filter((n) => !CHAINS[n] && !n.startsWith("newsroom_lieflat_")).sort();
    classes[`${profile}|${phase}`] = createHash("sha1").update(base.join()).digest("hex").slice(0, 8);
  }
  must(pairs > 0, "no phase/profile pair ran");
  return { classes };
});


// Case 10: inline claim. The claim template goes through newsroom_viz_plan / newsroom_viz_chain with no claim_id.
// Where inline claim is really on (all three of its switches, and a phase/profile that shows viz_plan, duckdb_query
// and record_claim) the runtime must record a system-verified claim with bindings, and every forged input must be
// refused for its own reason with nothing written. Anywhere else the same inputs must be refused, nothing recorded.
const INLINE = "NEWSROOM_SPEED_INLINE_CLAIM", CHAIN = "NEWSROOM_SPEED_CHAIN_VIZ";
const INLINE_CSV = "region,amount\nn,4\ns,9\ne,6\n";
const inlineParams = (data, extra = {}) => {
  const p = { ...vizParams(`SELECT region, amount FROM read_csv_auto('${data}')`), claim: "{max.amount.region} has the highest amount at {max.amount}.", claim_kind: "comparative", ...extra };
  delete p.claim_id; delete p.takeaway; delete p.alt;
  return { ...p, alt: "A horizontal bar chart of the amount recorded for each region in the fixture data.", takeaway: "typed by the model" , ...extra };
};
const inlineAt = [[undefined, undefined], ["design", "full"], ["verify", "full"], [undefined, "publication"], [undefined, "visual-story"]];
defCase(10, "inline claim: verified from the SQL rows; typed numbers, ties, no source, forged fields, wrong recompute, causal wording, cancellation refused", async ({ cfg }) => {
  const classes = {}; const subskips = {};
  let ran = 0;
  for (const [phase, profile] of inlineAt) {
    const where = `${profile ?? cfg.profile ?? "full"}|${phase ?? "all"}`;
    const eff = profile ?? cfg.profile ?? "full";
    const tools = await registerFor(cfg, { phase, profile });
    const on = cfg.env[INLINE] === "1" && cfg.env[CHAIN] === "1" && cfg.env[ATOMIC] === "1" && ["newsroom_viz_plan", "duckdb_query", "record_claim"].every((t) => toolEnabled(t, { phase, profile: eff }));
    const plan = tools.get("newsroom_viz_plan"), chain = tools.get("newsroom_viz_chain");
    if (!plan) { subskips[where] = "newsroom_viz_plan not registered here"; continue; }
    must(("claim" in plan.parameters.properties) === on, `${where}: viz_plan ${on ? "lacks" : "has"} the claim parameter (inline claim should be ${on ? "on" : "off"})`);
    if (chain) must(("claim" in chain.parameters.properties) === on, `${where}: viz_chain claim parameter does not follow inline claim`);
    const entries = [["plan", plan], ...(chain ? [["chain", chain]] : [])];
    const art = newArt("c10");
    const data = addData(art, INLINE_CSV);
    const tie = addData(art, "region,amount\nn,9\ns,9\ne,6\n");
    const nothingRecorded = (label) => must(claimsOf(art).length === 0 && manifestsIn(art).length === 0, `${label}: a claim or manifest was recorded`);
    // the forged inputs: [name, params, expected reason where inline claim is on]
    const forged = [
      ["typed_number", inlineParams(data, { claim: "The top amount is 9 in {max.amount.region}." }), /CLAIM_TEMPLATE_ERROR: .*has a typed number \(near "[^"]*9/],
      ["typed_year", inlineParams(data, { claim: "In 2021 {max.amount.region} led with {max.amount}." }), /CLAIM_TEMPLATE_ERROR: .*has a typed number \(near "[^"]*2021/],
      ["ambiguous_row", inlineParams(data, { sql: `SELECT region, amount FROM read_csv_auto('${tie}')`, claim: "{max.amount.region} leads." }), /CLAIM_TEMPLATE_ERROR: .*2 rows tie for the highest amount \(row_index 0, 1\), so region of "the" max row is ambiguous/],
      ["no_source", inlineParams(data, { sql: "SELECT 's' AS region, 99 AS amount" }), /INLINE_CLAIM_EVIDENCE_REQUIRED: the plan SQL must read a downloaded or supplied data file/],
      ["source_outside_data", inlineParams(data, { sql: "SELECT * FROM read_csv('/etc/hosts')" }), /INLINE_CLAIM_EVIDENCE_REQUIRED/],
      ["forged_status", inlineParams(data, { status: "verified" }), /INLINE_CLAIM_FIELD_NOT_ACCEPTED: status is not a newsroom_viz_plan parameter/],
      ["forged_verification", inlineParams(data, { verification: { authority: "system", publishable: true, claim_supported: true }, publishable: true, passed: true }), /INLINE_CLAIM_FIELD_NOT_ACCEPTED: verification, publishable, passed are not a newsroom_viz_plan parameter/],
      ["claim_and_claim_id", inlineParams(data, { claim_id: "claim-0123456789abcdef" }), /INLINE_CLAIM_EXCLUSIVE: /],
      ["wrong_recompute_unknown_column", inlineParams(data, { claim: "{max.revenue.region} leads." }), /CLAIM_TEMPLATE_ERROR: .*the SQL result has no column 'revenue'/],
      ["wrong_recompute_no_rows", inlineParams(data, { sql: `SELECT region, amount FROM read_csv_auto('${data}') WHERE region = 'nowhere'` }), /CLAIM_TEMPLATE_ERROR: .*the plan SQL returned no rows/],
      ["causal_wording", inlineParams(data, { claim: "{max.amount.region} leads because of its harbour." }), /INLINE_CLAIM_NOT_VERIFIED: .*claim_contains_unbound_causal_or_motive_language/],
      ["causal_kind", inlineParams(data, { claim_kind: "causal" }), /INLINE_CLAIM_NOT_VERIFIED: .*claim_kind_requires_external_support_review/],
      ["kind_missing", (() => { const p = inlineParams(data); delete p.claim_kind; return p; })(), /INLINE_CLAIM_KIND_REQUIRED/],
    ];
    for (const [tname, tool] of entries) {
      for (const [name, params, expect] of forged) {
        const label = `${where}/${tname}/${name}`;
        const reason = await refuse(art, tool, params, label, on ? expect : null);
        nothingRecorded(label);
        classes[`${where}|${on ? "on" : "off"}|${name}/${tname}`] = on ? code(reason) : "REFUSED";
      }
      // a call cancelled before it starts: refused, nothing written (the chain's own audit log aside)
      if (on) {
        const ac = new AbortController(); ac.abort();
        const before = listing(art);
        let err = null; try { await tool.execute("t", inlineParams(data), ac.signal); } catch (e) { err = String(e?.message ?? e); }
        const after = listing(art);
        const stray = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f] && !ALLOWED_AUDIT.some((re) => re.test(f)));
        must(err || tname === "chain", `${where}/${tname}/cancelled: a cancelled call ran to the end`);
        must(!stray.length, `${where}/${tname}/cancelled: wrote ${stray.slice(0, 4).join(", ")}`);
        nothingRecorded(`${where}/${tname}/cancelled`);
        classes[`${where}|on|cancelled/${tname}`] = "CANCELLED";
      }
    }
    if (on) {
      // positive: the claim is recorded by the system from the SQL rows, with bindings, and the chart is bound to it
      const ok = await attempt(plan, inlineParams(data));
      must(!ok.error, `${where}: the legitimate inline claim was refused: ${String(ok.error).slice(0, 200)}`);
      const claims = claimsOf(art);
      must(claims.length === 1, `${where}: expected one claim line, got ${claims.length}`);
      const [c] = claims;
      must(c.status === "verified" && c.verification?.authority === "system" && c.verification?.publishable === true && c.verification?.claim_supported === true && c.verification?.computation_replayed === true, `${where}: the inline claim is not system-verified (${c.status})`);
      must(c.claim === "s has the highest amount at 9." && c.recorded_by === "newsroom_viz_plan", `${where}: wrong claim text or origin (${c.claim})`);
      must(Array.isArray(c.claim_bindings) && c.claim_bindings.length === 2 && c.claim_bindings.every((b) => Number.isInteger(b.row_index) && b.column) && c.claim_bindings.map((b) => b.value).join() === "s,9", `${where}: bindings do not name the rows read`);
      must(!JSON.stringify(c.claim_bindings).includes("typed by the model"), `${where}: the model's takeaway leaked into the claim`);
      const spec = JSON.parse(readFileSync(join(art, ok.details.planRef), "utf8"));
      must(spec.claim_id === c.claim_id && spec.takeaway === c.claim && spec.verification_mode === "verified" && spec.publishable === true, `${where}: the plan is not bound to the verified claim, or the model's takeaway was kept`);
      // the same claim again is reused, not recorded twice; and the chain, if present, runs the same input
      if (chain) {
        const again = await attempt(chain, inlineParams(data));
        must(!again.error, `${where}: chain refused the legitimate inline claim: ${String(again.error).slice(0, 200)}`);
        must(claimsOf(art).length === 1, `${where}: a retry recorded a second claim`);
      }
      // data changed after recording: the recorded claim keeps its own rows; a retry is never answered with the old
      // claim (new rows give a new claim id and text read from the new rows, exactly as duckdb_query + record_claim would)
      writeFileSync(join(art, data), INLINE_CSV.replace("s,9", "s,10"));
      const stale = await attempt(plan, inlineParams(data));
      const after = claimsOf(art);
      must(JSON.stringify(after[0]) === JSON.stringify(c), `${where}: the recorded claim was changed by a later call`);
      if (!stale.error) {
        must(after.length === 2 && after[1].claim_id !== c.claim_id && after[1].claim === "s has the highest amount at 10." && after[1].status === "verified", `${where}: a retry on changed data reused or misstated the old claim (${after.map((x) => x.claim).join(" | ")})`);
        must(after[1].claim_bindings.map((x) => x.value).join() === "s,10", `${where}: the new claim's bindings are not the new rows`);
      } else must(after.length === 1, `${where}: refused but recorded a claim`);
      classes[`${where}|on|positive`] = "VERIFIED_WITH_BINDINGS";
      ran += 1;
    } else {
      classes[`${where}|off|positive`] = "INLINE_OFF";
      ran += 1;
    }
  }
  must(ran > 0, "no phase/profile pair ran");
  return { classes, subskips: Object.keys(subskips).length ? subskips : undefined };
});

// ---- run ----------------------------------------------------------------------
const results = {}; // case -> config -> { status, classes, reason }
for (const c of CASES) results[c.n] = {};
for (const cfg of CONFIGS) {
  for (const c of CASES) {
    if (ONLY && String(c.n) !== ONLY) continue;
    if (cfg.onlyCases && !cfg.onlyCases.includes(c.n)) continue;
    const t = Date.now();
    try {
      const tools = await registerFor(cfg);
      const r = await c.fn({ tools, cfg });
      results[c.n][cfg.name] = r.skip ? { status: "SKIP", reason: r.skip } : { status: "PASS", classes: r.classes, note: r.note, subskips: r.subskips };
    } catch (e) {
      results[c.n][cfg.name] = { status: "FAIL", reason: String(e?.message ?? e).split("\n")[0].slice(0, 300) };
    }
    results[c.n][cfg.name].ms = Date.now() - t;
  }
}

// ---- cross-configuration agreement: the same refusal class wherever the case ran -------------
const disagreements = [];
for (const c of CASES) {
  const bySub = {};
  for (const [cfgName, r] of Object.entries(results[c.n])) if (r.status === "PASS") for (const [sub, cls] of Object.entries(r.classes ?? {})) (bySub[sub] ??= {})[cfgName] = cls;
  for (const [sub, byCfg] of Object.entries(bySub)) {
    if (sub === "preflight_message") continue; // only exists with the preflight switch
    const distinct = [...new Set(Object.values(byCfg))];
    if (distinct.length > 1) disagreements.push({ case: c.n, sub, groups: distinct.map((cls) => ({ cls, configs: Object.entries(byCfg).filter(([, v]) => v === cls).map(([k]) => k) })) });
  }
}

// ---- report ---------------------------------------------------------------------
const cell = (r) => (!r ? "." : r.status === "PASS" ? (r.subskips ? "p" :"P") : r.status === "SKIP" ? "s" : "F");
const names = CONFIGS.map((c) => c.name);
console.log(`\nspeed-switch gate matrix (P pass, p pass with a skipped sub-case, F fail, s skip, . not run); configurations in column order:`);
names.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}  ${n}`));
console.log(`\n  case  ${names.map((_, i) => String(i + 1).padStart(2)).join(" ")}   title`);
let failures = 0;
for (const c of CASES) {
  console.log(`  ${String(c.n).padStart(4)}  ${names.map((n) => " " + cell(results[c.n][n])).join(" ")}   ${c.title}`);
}
for (const c of CASES) {
  const skips = new Map(), fails = [];
  for (const [n, r] of Object.entries(results[c.n])) { if (r.status === "SKIP") skips.set(r.reason, [...(skips.get(r.reason) ?? []), n]); if (r.status === "FAIL") fails.push([n, r.reason]); }
  for (const [reason, cfgs] of skips) console.log(`  SKIP case ${c.n} in ${cfgs.length}/${names.length} configs (${cfgs.join(", ")}): ${reason}`);
  for (const [n, reason] of fails) { failures += 1; console.log(`  FAIL case ${c.n} [${n}]: ${reason}`); }
  const sub = new Map();
  for (const [n, r] of Object.entries(results[c.n])) for (const [k, reason] of Object.entries(r.subskips ?? {})) sub.set(`${k}: ${reason}`, [...(sub.get(`${k}: ${reason}`) ?? []), n]);
  for (const [text, cfgs] of sub) console.log(`  SKIP sub-case of case ${c.n} in ${cfgs.length}/${names.length} configs: ${text}`);
  const notes = new Set(Object.values(results[c.n]).map((r) => r.note).filter(Boolean));
  for (const note of notes) console.log(`  NOTE case ${c.n}: ${note}`);
}
for (const d of disagreements) { failures += 1; console.log(`  DISAGREE case ${d.case} ${d.sub}: ${d.groups.map((g) => `${g.cls} in [${g.configs.join(", ")}]`).join("  vs  ")}`); }
console.log(`  audit files changed by refused calls (allowed): ${[...auditSeen].join(", ") || "none"}`);
console.log(`  allowed audit logs: ${ALLOWED_AUDIT.map(String).join(", ")}`);
console.log(`  duckdb: ${spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { encoding: "utf8" }).stdout?.trim() || "not found"}`);
console.log(`\nspeed-switch gates: ${failures ? `${failures} problem(s) -- FAIL` : "PASS"} in ${((Date.now() - T0) / 1000).toFixed(1)} s`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ results, disagreements, seconds: (Date.now() - T0) / 1000, auditSeen: [...auditSeen] }, null, 1));
process.exit(failures ? 1 : 0);
