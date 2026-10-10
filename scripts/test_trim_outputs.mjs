// V580 (NEWSROOM_TRIM_UNREAD_FIELDS, NEWSROOM_CONCEPT_COUNT_3, NEWSROOM_SPEED_FILL_PUBLICATION_COPIED): offline, real tool handlers on a temp artifact root.
// P3 (NEWSROOM_SPEED_FILL_COPIED_REFS): code copies story_graph_ref and the lint's plan_ref when they are omitted and exactly one candidate exists.
// Real plan tool on a temp artifact root (fixtures from test_hero_value_tool_path.mjs). Offline.
// (the typebox/compile stub below is only used by the shared tree builder: of the real
// Compile cannot be checked here (see the report); the wiring, the order of the checks and the fail-closed path are.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_HERO_VALUE_GATE", "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_FILL_COPIED_REFS", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL"];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const { checkSchema } = await import(join(ROOT, "runtime/pi/tool_chain.mjs"));
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
// One type-stripped copy of the runtime per tree. withCompile=false leaves typebox/compile out (it can only be missing there).
function makeTree(withCompile) {
  const TREE = mkdtempSync(join(tmpdir(), "patch-tree-"));
  cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
  stub(TREE, "typebox", TYPEBOX);
  if (withCompile) {
    writeFileSync(join(TREE, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
    writeFileSync(join(TREE, "node_modules", "typebox", "compile.js"), `import { checkSchema } from ${JSON.stringify(pathToFileURL(join(ROOT, "runtime/pi/tool_chain.mjs")).href)};
export const Compile = (schema) => ({ Check: (v) => checkSchema(schema, v).length === 0, Errors: (v) => checkSchema(schema, v).map((message) => ({ instancePath: "", message })) });\n`);
  }
  stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return COPY;
}

const COPY = makeTree(true);
let loadN = 0;
const ENV = ["NEWSROOM_TRIM_UNREAD_FIELDS", "NEWSROOM_CONCEPT_COUNT_3", "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED", "NEWSROOM_SPEED_COMPACT_SETUP", "NEWSROOM_SPEED_EDITORIAL_HINTS", "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_ARTIFACT_DIR", "NEWSROOM_SPEED_ATOMIC_ARTIFACT"];
async function register(env, art) {
  for (const k of ENV) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  if (art) process.env.NEWSROOM_ARTIFACT_DIR = art;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const tools = new Map();
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++loadN}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const NAMES = ["newsroom_editorial_discovery", "newsroom_story_graph", "newsroom_visual_concepts", "newsroom_publication_plan"];
const shape = (tools) => JSON.stringify(NAMES.map((n) => { const t = tools.get(n); return [n, t.description, t.promptGuidelines, t.parameters]; }));
const keys = (tools, n) => Object.keys(tools.get(n).parameters.properties);
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; console.log(`  ok  ${msg}`); };

// 1. off states: every non-"1" value gives the same four tool definitions as no variable at all.
const base = shape(await register({}));
for (const name of ["NEWSROOM_TRIM_UNREAD_FIELDS", "NEWSROOM_CONCEPT_COUNT_3", "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED"]) {
  for (const value of ["0", "", "yes", " 1", "on", "true", "11"]) assert.equal(shape(await register({ [name]: value })), base, `${name}=${JSON.stringify(value)} must equal unset`);
  ok(true, `${name}: unset, 0, empty, yes, " 1", on, true, 11 leave the four tool definitions unchanged`);
}

// 2. trim on: the unread fields are not asked for; every field a check, the score or a later stage reads still is.
const on = await register({ NEWSROOM_TRIM_UNREAD_FIELDS: "1" });
const off = await register({});
const gone = (tools, n, fields) => fields.every((f) => !keys(tools, n).includes(f));
ok(gone(on, "newsroom_editorial_discovery", ["counterintuitive_findings", "human_scale_refs", "uncertainties", "temporal_dimensions"]), "trim on: discovery drops the four unread lists");
ok(keys(off, "newsroom_editorial_discovery").includes("uncertainties"), "trim off: discovery still asks for them");
for (const f of ["reader_problem", "candidate_questions", "surprises", "spatial_dimensions", "mechanisms", "missing_reporting", "kill_reasons"]) assert.ok(keys(on, "newsroom_editorial_discovery").includes(f), f);
ok(true, "trim on: discovery keeps every field its checks read");
const missingProps = (tools) => tools.get("newsroom_editorial_discovery").parameters.properties.missing_reporting.items.properties;
ok(!("reason" in missingProps(on)) && "need" in missingProps(on) && "blocking" in missingProps(on), "trim on: missing_reporting[].reason dropped, need and blocking kept");
const nodeProps = (tools) => tools.get("newsroom_story_graph").parameters.properties.nodes.items.properties;
ok(["evidence_refs", "module_hint"].every((f) => !(f in nodeProps(on))) && ["id", "kind", "summary", "explanatory_dimension", "claim_ids"].every((f) => f in nodeProps(on)), "trim on: story nodes drop evidence_refs and module_hint, keep the five that are read");
ok(!("story_id" in on.get("newsroom_story_graph").parameters.properties) && !("note" in on.get("newsroom_story_graph").parameters.properties.edges.items.properties), "trim on: story_id and edges[].note dropped");
const conceptProps = (tools) => tools.get("newsroom_visual_concepts").parameters.properties.concepts.items.properties;
ok(["information_hierarchy", "why_reject", "reporting_gaps"].every((f) => !(f in conceptProps(on))) && ["concept_id", "editorial_premise", "hero_evidence_refs", "media_mix", "risk_flags", "why_memorable", "framing"].every((f) => f in conceptProps(on)), "trim on: concepts drop the three unread fields and keep what the checks and the score read");
ok(!("note" in conceptProps(on).asset_requirements.items.properties) && ["kind", "available", "blocking"].every((f) => f in conceptProps(on).asset_requirements.items.properties), "trim on: asset_requirements[].note dropped, kind/available/blocking kept");

// 3. counts: concept minimum
const c3 = await register({ NEWSROOM_CONCEPT_COUNT_3: "1" });
ok(c3.get("newsroom_visual_concepts").parameters.properties.concepts.minItems === 3 && off.get("newsroom_visual_concepts").parameters.properties.concepts.minItems === 8, "count switch: minItems 3 on, 8 off");

// 4. publication plan: the three copy fields are optional only with the switch
const pub = await register({ NEWSROOM_SPEED_FILL_PUBLICATION_COPIED: "1" });
const req = (tools) => tools.get("newsroom_publication_plan").parameters.required;
ok(["story_graph_ref", "reader_question", "visual_thesis"].every((f) => req(off).includes(f) && !req(pub).includes(f)) && req(pub).includes("infographic_plan_ref"), "publication copy switch: the three fields optional on, required off; infographic_plan_ref stays required");

// 5. executes on a temp artifact root: dropped from the saved artifact, same decisions, same text, same downstream reads
const mkArt = () => { const a = join(mkdtempSync(join(tmpdir(), "trim-art-")), "run"); for (const d of ["editorial/discovery", "editorial/concepts", "editorial/story-graphs", "runtime", "infographics/plans"]) mkdirSync(join(a, d), { recursive: true }); return a; };
const DISC = { reader_problem: "p", candidate_questions: ["a", "b", "c"], surprises: ["s"], counterintuitive_findings: ["x"], human_scale_refs: ["h"], spatial_dimensions: ["sp"], temporal_dimensions: ["t"], mechanisms: ["m"], uncertainties: ["u"], missing_reporting: [{ need: "n", blocking: false, reason: "r" }], kill_reasons: [] };
const FR = ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal", "spatial"];
const CONCEPTS = (n) => FR.slice(0, n).map((framing, i) => ({ concept_id: `c${i + 1}`, reader_question: "Q?", editorial_premise: `P${i}`.padEnd(40, "x"), surprise: "s", visual_metaphor: `m${i}`, hero_scene: `h${i}`, framing, hero_evidence_refs: ["c1"], supporting_evidence_refs: [], asset_requirements: [{ kind: "map", available: true, blocking: false, note: "n" }], media_mix: ["chart"], information_hierarchy: "ih", mobile_treatment: "mt", risk_flags: [], reporting_gaps: ["g"], why_memorable: `w${i}`, why_reject: i > 2 ? "because" : undefined }));
const GRAPH = { story_id: "sid", reader_question: "Q", visual_thesis: "T", nodes: [{ id: "n1", kind: "claim", summary: "a", explanatory_dimension: "rank", claim_ids: [], evidence_refs: ["e"], module_hint: "mh" }, { id: "n2", kind: "context", summary: "b", explanatory_dimension: "spatial", claim_ids: [], evidence_refs: ["e"], module_hint: "mh" }, { id: "n3", kind: "outcome", summary: "c", explanatory_dimension: "trend", claim_ids: [] }], edges: [{ from: "n1", to: "n2", relation: "supports", note: "x" }, { from: "n2", to: "n3", relation: "explains", note: "y" }], entry_node_ids: ["n1"], answer_node_ids: ["n3"] };
const unhash = (r) => String(r.content[0].text).replace(/[0-9a-f]{64}/g, "<hash>");
const readJson = (art, rel) => JSON.parse(readFileSync(join(art, rel), "utf8"));
async function chain(env, concepts) {
  const art = mkArt(); const t = await register(env, art);
  const d = await t.get("newsroom_editorial_discovery").execute("t", structuredClone(DISC));
  const g = await t.get("newsroom_story_graph").execute("t", structuredClone(GRAPH));
  const c = await t.get("newsroom_visual_concepts").execute("t", { discovery_ref: d.details.discoveryRef, concepts });
  return { art, d, g, c };
}
const A = await chain({}, CONCEPTS(8)), B = await chain({ NEWSROOM_TRIM_UNREAD_FIELDS: "1" }, CONCEPTS(8));
const dA = readJson(A.art, A.d.details.discoveryRef), dB = readJson(B.art, B.d.details.discoveryRef);
ok(["counterintuitive_findings", "human_scale_refs", "uncertainties", "temporal_dimensions"].every((f) => f in dA && !(f in dB)) && !("reason" in dB.missing_reporting[0]) && "reason" in dA.missing_reporting[0] && !("discovery_dimension_count" in dB.metrics) && "discovery_dimension_count" in dA.metrics, "saved discovery: the model still wrote them, trim on drops them (and the unread count)");
ok(dA.decision === dB.decision && JSON.stringify(dA.decision_reasons) === JSON.stringify(dB.decision_reasons) && unhash(A.d) === unhash(B.d), "discovery: same decision, reasons and returned text");
const gA = readJson(A.art, A.g.details.storyGraphRef), gB = readJson(B.art, B.g.details.storyGraphRef);
ok(!("story_id" in gB) && gB.nodes.every((n) => !("evidence_refs" in n) && !("module_hint" in n)) && gB.edges.every((e) => !("note" in e)) && "story_id" in gA, "saved story graph: the four unread fields are dropped");
const readProj = (g) => JSON.stringify({ passed: g.passed, rq: g.reader_question, vt: g.visual_thesis, nodes: g.nodes.map((n) => [n.id, n.explanatory_dimension, n.claim_ids]), edges: g.edges.map((e) => e.relation), entry: g.entry_node_ids, answer: g.answer_node_ids, metrics: g.metrics, issues: g.issues, dims: g.explanatory_dimensions });
ok(readProj(gA) === readProj(gB) && unhash(A.g) === unhash(B.g), "story graph: everything later stages read is identical, and so is the returned text");
const cA = readJson(A.art, A.c.details.conceptRef), cB = readJson(B.art, B.c.details.conceptRef);
ok(JSON.stringify(cA.scores) === JSON.stringify(cB.scores) && JSON.stringify(cA.finalists) === JSON.stringify(cB.finalists) && cA.selected_concept_id === cB.selected_concept_id && cA.discovery_ref !== undefined, "concepts: same scores, finalists and selection");
ok(cB.concepts.every((c) => !("information_hierarchy" in c) && !("why_reject" in c) && !("reporting_gaps" in c) && c.asset_requirements.every((a) => !("note" in a))) && cA.concepts.every((c) => "information_hierarchy" in c), "saved concepts: the three unread fields and asset note dropped");
// a field a check reads is still checked with trim on
{
  const t = await register({ NEWSROOM_TRIM_UNREAD_FIELDS: "1" }, mkArt());
  const d = await t.get("newsroom_editorial_discovery").execute("t", structuredClone(DISC));
  const bad = CONCEPTS(8); delete bad[0].editorial_premise;
  await assert.rejects(() => t.get("newsroom_visual_concepts").execute("t", { discovery_ref: d.details.discoveryRef, concepts: bad }), /editorial_premise/);
  const thin = { ...DISC, candidate_questions: ["a"] };
  const r = await t.get("newsroom_editorial_discovery").execute("t", thin);
  ok(r.details.decision === "REVISE", "trim on: a required field still refused (editorial_premise), a thin question set still REVISE");
}
// 6. count switch: 3 concepts accepted only with the switch; with 3 all are finalists
{
  const a = mkArt(); const off3 = await register({}, a);
  const d = await off3.get("newsroom_editorial_discovery").execute("t", structuredClone(DISC));
  await assert.rejects(() => off3.get("newsroom_visual_concepts").execute("t", { discovery_ref: d.details.discoveryRef, concepts: CONCEPTS(3) }), /8\.\.20/);
  const a2 = mkArt(); const on3 = await register({ NEWSROOM_CONCEPT_COUNT_3: "1" }, a2);
  const d2 = await on3.get("newsroom_editorial_discovery").execute("t", structuredClone(DISC));
  const r = await on3.get("newsroom_visual_concepts").execute("t", { discovery_ref: d2.details.discoveryRef, concepts: CONCEPTS(3) });
  assert.equal(r.details.finalists.length, 3);
  await assert.rejects(() => on3.get("newsroom_visual_concepts").execute("t", { discovery_ref: d2.details.discoveryRef, concepts: CONCEPTS(2) }), /3\.\.20/);
  ok(true, "count switch: 3 concepts refused off (8..20), accepted on with all 3 as finalists, 2 refused on (3..20)");
}
// 7. publication copy: with the switch on, a plan that lacks a copied field is refused with the reason; the later checks are unchanged
{
  const a = mkArt(); const t = await register({ NEWSROOM_SPEED_FILL_PUBLICATION_COPIED: "1" }, a);
  writeFileSync(join(a, "infographics/plans/x.json"), JSON.stringify({ reader_question: "Q" }));
  await assert.rejects(() => t.get("newsroom_publication_plan").execute("t", { infographic_plan_ref: "infographics/plans/x.json", title: "t", dek: "d", modules: [] }), /story_graph_ref is missing and could not be derived[\s\S]*visual_thesis is missing/);
  ok(true, "publication copy: a plan without the field to copy is refused with the reason, nothing invented");
}
// 8. together with the existing copy switches: refs left out are copied (compact setup, fill-copied, preflight) and the trimmed chain still works
{
  const env = { NEWSROOM_TRIM_UNREAD_FIELDS: "1", NEWSROOM_SPEED_FILL_COPIED_REFS: "1", NEWSROOM_SPEED_PREFLIGHT: "1", NEWSROOM_SPEED_COMPACT_SETUP: "1", NEWSROOM_SPEED_FILL_PUBLICATION_COPIED: "1" };
  const a = mkArt(); const t = await register(env, a);
  const d = await t.get("newsroom_editorial_discovery").execute("t", structuredClone(DISC));
  const c = await t.get("newsroom_visual_concepts").execute("t", { concepts: CONCEPTS(8) }); // discovery_ref copied by code
  const saved = readJson(a, c.details.conceptRef);
  assert.equal(saved.discovery_ref, d.details.discoveryRef);
  assert.ok(saved.concepts.every((x) => !("why_reject" in x) && !("reporting_gaps" in x)));
  ok(true, "all copy switches plus trim on: discovery_ref copied verbatim, saved concepts still trimmed");
}
console.log(`trim outputs: ${passed} checks -- PASS`);
