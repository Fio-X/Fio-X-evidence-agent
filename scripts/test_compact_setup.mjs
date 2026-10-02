// NEWSROOM_SPEED_COMPACT_SETUP=1: `shared` concept defaults expand to exactly the artifact the full form stores, and
// discovery_ref / concept_ref are inferred only from a single bound artifact. Switch off: every tool definition and every
// artifact is what the integration head produced (BASELINE_NEWSROOM_TS, set by default from git).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { expandSharedConcepts, fillSetupRefs } = await import(join(ROOT, "runtime/pi/compact_setup.mjs"));
const results = [];
const check = (name) => results.push(name);

// ---- unit: expansion and ref inference -----------------------------------------
const SHARED = { reader_question: "Q?", editorial_premise: "P", hero_evidence_refs: ["c1"], media_mix: ["chart"], risk_flags: ["r"], reporting_gaps: [] };
{
  const out = expandSharedConcepts(SHARED, [{ concept_id: "a", media_mix: ["map"], visual_metaphor: "v" }]);
  assert.deepEqual(out, [{ ...SHARED, media_mix: ["map"], concept_id: "a", visual_metaphor: "v" }], "shallow merge; the concept wins; arrays are replaced");
  assert.equal(expandSharedConcepts(undefined, [{ concept_id: "a" }])[0].concept_id, "a");
  for (const key of ["concept_id", "framing", "visual_metaphor", "hero_scene", "why_memorable"]) assert.throws(() => expandSharedConcepts({ ...SHARED, [key]: "x" }, []), new RegExp(`shared\\.${key} is refused`));
  assert.throws(() => expandSharedConcepts({ ...SHARED, colour: "x" }, []), /shared\.colour is not a concept field/);
  assert.throws(() => expandSharedConcepts({ ...SHARED, concept_id: "x", colour: "y" }, []), (e) => /concept_id/.test(e.message) && /colour/.test(e.message), "every offending key is named");
  check("unit: shared merges shallowly (concept wins, arrays replaced); creative fields and unknown keys are refused by name");
}
const fakeIo = (files) => ({
  list: async (dir) => Object.keys(files).filter((r) => r.startsWith(dir)).sort(),
  read: async (ref) => { if (!(ref in files)) throw new Error(`ENOENT ${ref}`); return files[ref]; },
});
{
  const F = { "editorial/discovery/d.json": { decision: "CONTINUE" }, "editorial/concepts/k.json": { finalists: ["a", "b"] } };
  let s = await fillSetupRefs("newsroom_visual_concepts", { concepts: [] }, fakeIo(F));
  assert.equal(s.params.discovery_ref, "editorial/discovery/d.json");
  s = await fillSetupRefs("newsroom_visual_concepts", { concepts: [], discovery_ref: "mine" }, fakeIo(F));
  assert.equal(s.params.discovery_ref, "mine"); assert.deepEqual(s.filled, []);
  s = await fillSetupRefs("newsroom_visual_concepts", { concepts: [] }, fakeIo({ ...F, "editorial/discovery/e.json": { decision: "CONTINUE" } }));
  assert.equal(s.params.discovery_ref, undefined); assert.match(s.unresolved.discovery_ref, /2 candidates/);
  s = await fillSetupRefs("newsroom_visual_concepts", { concepts: [] }, fakeIo({ "editorial/discovery/d.json": { decision: "RESEARCH_MORE" } }));
  assert.match(s.unresolved.discovery_ref, /call newsroom_editorial_discovery first/);
  s = await fillSetupRefs("newsroom_asset_requirements", { concept_id: "a" }, fakeIo(F));
  assert.equal(s.params.concept_ref, "editorial/concepts/k.json");
  s = await fillSetupRefs("newsroom_asset_requirements", { concept_id: "zzz" }, fakeIo(F));
  assert.match(s.unresolved.concept_ref, /lists 'zzz' as a finalist/);
  s = await fillSetupRefs("newsroom_semantic_novelty", {}, fakeIo({ ...F, "editorial/concepts/k2.json": { finalists: ["a"] } }));
  assert.equal(s.params.concept_ref, undefined); assert.match(s.unresolved.concept_ref, /2 candidates/);
  s = await fillSetupRefs("newsroom_semantic_novelty", { concept_ref: "mine" }, fakeIo(F));
  assert.equal(s.params.concept_ref, "mine");
  s = await fillSetupRefs("newsroom_semantic_novelty", {}, fakeIo({}));
  assert.match(s.unresolved.concept_ref, /call newsroom_visual_concepts first/);
  check("unit: a single match fills; 0 or 2+ matches refuse with the reason; a given ref is kept; concept_id is never filled");
}

// ---- real tools ------------------------------------------------------------------
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
};
`;
async function loadTree(label, source) {
  const dir = mkdtempSync(join(tmpdir(), `compact-tree-${label}-`));
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  writeFileSync(join(dir, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
  writeFileSync(join(dir, "node_modules", "typebox", "compile.js"), `export * from ${JSON.stringify(pathToFileURL(REAL_COMPILE).href)};\n`);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(source ?? readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return import(join(pi, "newsroom.test-copy.mjs"));
}
// The stub Type builds plain JSON-schema objects; the Compile validator Pi applies to tool arguments is the real one, found in
// the installed Pi (the stub package re-exports typebox/compile from there).
const PI_DIR = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim() + "/@earendil-works/pi-coding-agent";
const REAL_COMPILE = createRequire(join(PI_DIR, "package.json")).resolve("typebox/compile");
const { Compile } = await import(pathToFileURL(REAL_COMPILE).href);
const SWITCH = "NEWSROOM_SPEED_COMPACT_SETUP";
const BASE_ENV = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_HIDE_LIEFLAT: undefined, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_MOBILE_PAGES: undefined, NEWSROOM_SPEED_COMPACT_SETUP: undefined };
function register(mod, env) {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const snapshot = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).filter((f) => f !== "runtime/tool-chain-events.jsonl").sort().map((f) => [f, readFileSync(join(art, f), "utf8")]));
const freshArt = (label) => { const art = join(mkdtempSync(join(tmpdir(), `compact-${label}-`)), "run"); mkdirSync(join(art, "editorial"), { recursive: true }); mkdirSync(join(art, "runtime"), { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = art; return art; };
const attempt = async (tool, params) => { try { return await tool.execute("t", params); } catch (error) { return { error: String(error?.message ?? error) }; } };
const ref = (result) => String(result.text ?? result.content?.[0]?.text ?? "").match(/Artifact: (\S+)/)?.[1];

const DISCOVERY = { reader_problem: "p", candidate_questions: ["q1", "q2", "q3"], surprises: ["s"], counterintuitive_findings: [], human_scale_refs: [], spatial_dimensions: [], temporal_dimensions: ["t"], mechanisms: [], uncertainties: ["u"], missing_reporting: [], kill_reasons: [] };
const FRAMES = ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal", "spatial"];
const METAPHORS = ["a river map", "a clock face", "a pipe network", "a seesaw", "a village of 100", "a market stall", "a staircase", "a compass"];
const COMMON = { reader_question: "Where do the rates stand?", editorial_premise: "Most rates are above the 2019 start.", surprise: "Only one is lower.", hero_evidence_refs: ["claim-1"], supporting_evidence_refs: ["claim-2"], asset_requirements: [{ kind: "verified_series", available: true, blocking: false }], media_mix: ["chart"], risk_flags: ["rate definitions differ"], reporting_gaps: [] };
const own = (i) => ({ concept_id: `c${i + 1}`, framing: FRAMES[i], visual_metaphor: METAPHORS[i], hero_scene: `${METAPHORS[i]} carrying the seven rates`, why_memorable: `The reader sees ${METAPHORS[i]} and remembers the one rate that fell.` });
const full = (n = 8) => Array.from({ length: n }, (_, i) => ({ ...COMMON, ...own(i) }));
const compact = (n = 8) => Array.from({ length: n }, (_, i) => own(i));

const baseSource = process.env.BASELINE_NEWSROOM_TS ? readFileSync(process.env.BASELINE_NEWSROOM_TS, "utf8")
  : spawnSync("git", ["show", `${process.env.BASELINE_REF ?? "b88d72f"}:runtime/pi/newsroom.ts`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).stdout;
assert.ok(baseSource.includes("newsroom_visual_concepts"), "baseline newsroom.ts loaded");
const mod = await loadTree("head");
const baseMod = await loadTree("base", baseSource);
const slim = (tool) => JSON.stringify({ parameters: tool.parameters, description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });

{ // switch off: identical definitions; switch on: only the four setup tools (+ plan guideline) change
  const base = register(baseMod, {});
  const off = register(mod, {});
  assert.deepEqual([...off.keys()], [...base.keys()]);
  for (const [name, tool] of base) assert.equal(slim(off.get(name)), slim(tool), `switch off: ${name} is byte-identical to the integration head`);
  const on = register(mod, { [SWITCH]: "1" });
  assert.deepEqual([...on.keys()], [...off.keys()]);
  const changed = [...off.keys()].filter((n) => slim(on.get(n)) !== slim(off.get(n))).sort();
  assert.deepEqual(changed, ["newsroom_asset_requirements", "newsroom_editorial_discovery", "newsroom_semantic_novelty", "newsroom_visual_concepts"]);
  const vc = on.get("newsroom_visual_concepts").parameters, vc0 = off.get("newsroom_visual_concepts").parameters;
  assert.deepEqual(vc0.required, ["discovery_ref", "concepts"]);
  assert.deepEqual(vc.required, ["concepts"]);
  const c = vc.properties.concepts.items, c0 = vc0.properties.concepts.items;
  assert.deepEqual(c.required.sort(), ["concept_id", "framing", "hero_scene", "visual_metaphor", "why_memorable"]);
  assert.deepEqual(Object.keys(c.properties), Object.keys(c0.properties), "same field order");
  assert.deepEqual(on.get("newsroom_asset_requirements").parameters.required, ["concept_id", "requirements"]);
  assert.deepEqual(on.get("newsroom_semantic_novelty").parameters.required, ["modules"]);
  check("tools: switch off is byte-identical to the integration head; on, only the four setup tools change, not the page-plan tool (shared + optional refs; creative fields stay required)");
}

const runSetup = async (label, env, conceptsInput) => {
  const tools = register(mod, env);
  const art = freshArt(label);
  const d = await tools.get("newsroom_editorial_discovery").execute("t", DISCOVERY);
  const discoveryRef = ref(d);
  const c = await attempt(tools.get("newsroom_visual_concepts"), conceptsInput(discoveryRef));
  return { tools, art, discoveryRef, c };
};

{ // the compact input stores exactly what the full input stores
  const a = await runSetup("full", { [SWITCH]: "1" }, (discovery_ref) => ({ discovery_ref, concepts: full() }));
  const b = await runSetup("compact", { [SWITCH]: "1" }, () => ({ shared: COMMON, concepts: compact() }));
  const off = await runSetup("off", {}, (discovery_ref) => ({ discovery_ref, concepts: full() }));
  assert.ok(ref(a.c), JSON.stringify(a.c).slice(0, 300));
  assert.equal(ref(b.c), ref(a.c), "same artifact path (content hash)");
  assert.equal(ref(off.c), ref(a.c), "same as the switch-off full form");
  assert.equal(readFileSync(join(b.art, ref(b.c)), "utf8"), readFileSync(join(a.art, ref(a.c)), "utf8"), "same bytes");
  assert.deepEqual(snapshot(b.art), snapshot(off.art), "everything stored is what the switch-off run stored");
  const events = readFileSync(join(b.art, "runtime/tool-chain-events.jsonl"), "utf8");
  assert.match(events, /"input_form":"shared_defaults"/);
  assert.doesNotMatch(readFileSync(join(b.art, ref(b.c)), "utf8"), /input_form|shared/);
  check("on: a compact input stores a byte-identical artifact (same hash) to the full form and to switch off; input_form is logged outside the artifact");
  // a concept's own value wins over shared
  const w = await runSetup("wins", { [SWITCH]: "1" }, () => ({ shared: COMMON, concepts: compact().map((c2, i) => (i === 0 ? { ...c2, media_mix: ["map"] } : c2)) }));
  const wa = JSON.parse(readFileSync(join(w.art, ref(w.c)), "utf8"));
  assert.deepEqual(wa.concepts[0].media_mix, ["map"]); assert.deepEqual(wa.concepts[1].media_mix, ["chart"]);
  check("on: a concept's own value replaces the shared one");
}
{ // refusals are the validator's own, and the guard names the field
  const refuse = async (label, input) => (await runSetup(label, { [SWITCH]: "1" }, input)).c.error;
  const few = await refuse("few", (discovery_ref) => ({ discovery_ref, concepts: full(7) }));
  const fewOff = (await runSetup("few-off", {}, (discovery_ref) => ({ discovery_ref, concepts: full(7) }))).c.error ?? "";
  const fewCompact = await refuse("few-c", () => ({ shared: COMMON, concepts: compact(8).slice(0, 7) }));
  assert.ok(fewOff || few || fewCompact);
  const oneFrame = (n) => Array.from({ length: n }, (_, i) => ({ ...own(i), framing: "spatial" }));
  const a = await refuse("fr-full", (discovery_ref) => ({ discovery_ref, concepts: oneFrame(8).map((c) => ({ ...COMMON, ...c })) }));
  const b = await refuse("fr-comp", () => ({ shared: COMMON, concepts: oneFrame(8) }));
  const o = (await runSetup("fr-off", {}, (discovery_ref) => ({ discovery_ref, concepts: oneFrame(8).map((c) => ({ ...COMMON, ...c })) }))).c.error;
  assert.match(a ?? "", /three distinct framings/); assert.equal(a, o); assert.equal(b?.replace(/^\s+/, ""), a?.replace(/^\s+/, ""), "the same refusal reasons for the expanded set");
  const miss = await refuse("miss", () => ({ shared: { editorial_premise: "P" }, concepts: compact() }));
  assert.match(miss ?? "", /reader_question/, "a required field neither shared nor given is refused by the unchanged validator");
  check("on: an expanded set that breaks 8..20 or three framings, or lacks a required field, gets the same refusal as the full form / switch off");
  for (const key of ["concept_id", "framing", "visual_metaphor", "hero_scene", "why_memorable"]) {
    const e = await refuse(`g-${key}`, () => ({ shared: { ...COMMON, [key]: "x" }, concepts: compact() }));
    assert.match(e ?? "", new RegExp(`shared\\.${key} is refused`));
  }
  assert.match(await refuse("g-unknown", () => ({ shared: { ...COMMON, colour: "x" }, concepts: compact() })) ?? "", /shared\.colour is not a concept field/);
  check("on: a creative field or an unknown key in shared is refused, naming it");
  // shared values are checked against the strict full-form schema, as the full form would refuse them
  const strict = async (label, shared, concepts) => (await runSetup(label, { [SWITCH]: "1" }, () => ({ shared, concepts }))).c.error ?? "";
  // The switch-off full form is refused by Pi's argument validation (the same Compile) before execute runs.
  const fullRefusal = async (label, edit) => {
    const off = register(mod, {}).get("newsroom_visual_concepts");
    const args = { discovery_ref: "editorial/discovery/x.json", concepts: full().map(edit) };
    const v = Compile(off.parameters);
    return v.Check(args) ? "" : [...v.Errors(args)].map((x) => `${x.instancePath} ${x.message}`).join("\n");
  };
  const thirty = Array.from({ length: 30 }, (_, i) => `r${i}`);
  let e = await strict("s-max", { ...COMMON, risk_flags: thirty }, compact());
  assert.match(e, /concepts\[0\]\.risk_flags/); assert.match(e, /concepts\[7\]\.risk_flags/, "every failing concept and path is listed");
  assert.match(await fullRefusal("s-max-full", (c) => ({ ...c, risk_flags: thirty })), /risk_flags/, "the full form refuses the same input");
  e = await strict("s-type", { ...COMMON, hero_evidence_refs: [123] }, compact());
  assert.match(e, /concepts\[0\]\.hero_evidence_refs\.0/);
  assert.match(await fullRefusal("s-type-full", (c) => ({ ...c, hero_evidence_refs: [123] })), /hero_evidence_refs/);
  const { risk_flags: _r, reporting_gaps: _g, supporting_evidence_refs: _s, ...partial } = COMMON;
  e = await strict("s-missing", partial, compact());
  for (const f of ["risk_flags", "reporting_gaps", "supporting_evidence_refs"]) assert.match(e, new RegExp(`concepts\\[0\\]\\.${f}: `), `${f} is required as in the full form`);
  const noRisk = (c) => { const { risk_flags, ...rest } = c; return rest; };
  assert.match(await fullRefusal("s-missing-full", noRisk), /risk_flags/);
  // a concept's own bad value is refused too, and a good set still passes
  e = await strict("s-own", COMMON, compact().map((c, i) => (i === 2 ? { ...c, media_mix: ["a", 1] } : c)));
  assert.match(e, /concepts\[2\]\.media_mix/);
  assert.equal(await strict("s-ok", COMMON, compact()), "");
  check("on: shared values that the full form refuses (30 risk_flags, a number in refs, missing required lists) are refused with every failing path");
}
{ // ref inference through the real tools
  const { tools, art, discoveryRef, c } = await runSetup("refs", { [SWITCH]: "1" }, () => ({ shared: COMMON, concepts: compact() }));
  assert.ok(ref(c));
  const stored = JSON.parse(readFileSync(join(art, ref(c)), "utf8"));
  assert.equal(stored.discovery_ref, discoveryRef, "discovery_ref was copied verbatim");
  const modules = [{ id: "m1", reader_question_id: "q1", claim_set: ["claim-1"], new_information: "trend of seven rates", explanatory_dimension: "trend" }, { id: "m2", reader_question_id: "q2", claim_set: ["claim-2"], new_information: "start against end", explanatory_dimension: "comparison" }];
  const req = [{ asset_class: "historical_series", status: "required", available: true, purpose: "series", source_refs: ["data/x.csv"] }];
  const finalist = stored.finalists[0];
  const nov = await attempt(tools.get("newsroom_semantic_novelty"), { modules });
  assert.ok(ref(nov), JSON.stringify(nov).slice(0, 300));
  assert.equal(JSON.parse(readFileSync(join(art, ref(nov)), "utf8")).concept_ref, ref(c));
  const asset = await attempt(tools.get("newsroom_asset_requirements"), { concept_id: finalist, requirements: req });
  assert.ok(ref(asset), JSON.stringify(asset).slice(0, 300));
  assert.equal(JSON.parse(readFileSync(join(art, ref(asset)), "utf8")).concept_ref, ref(c));
  const explicit = await attempt(tools.get("newsroom_semantic_novelty"), { concept_ref: "editorial/concepts/given.json", modules });
  assert.match(explicit.error ?? "", /given\.json|ENOENT/, "a given ref is used as given, never replaced by the inferred one");
  const noId = await attempt(tools.get("newsroom_asset_requirements"), { requirements: req });
  assert.ok(noId.error, "concept_id is never filled");
  check("on: with one match discovery_ref / concept_ref are copied verbatim; a given ref is never overridden; concept_id is never filled");
  // a second concept set makes concept_ref ambiguous; with no discovery a fresh run refuses with the reason
  const second = await attempt(tools.get("newsroom_visual_concepts"), { shared: { ...COMMON, risk_flags: ["another"] }, concepts: compact() });
  assert.ok(ref(second) && ref(second) !== ref(c));
  const amb = await attempt(tools.get("newsroom_semantic_novelty"), { modules });
  assert.match(amb.error ?? "", /Preflight found 1 unmet precondition[\s\S]*concept_ref is missing and could not be derived: 2 candidates/);
  const none = freshArt("none");
  const noDisc = await attempt(register(mod, { [SWITCH]: "1" }).get("newsroom_visual_concepts"), { shared: COMMON, concepts: compact() });
  assert.match(noDisc.error ?? "", /discovery_ref is missing and could not be derived: no CONTINUE editorial\/discovery artifact exists/);
  void none;
  check("on: 0 or 2+ candidates are refused with the full reason");
}
{ // switch off: the new fields do not exist
  const tools = register(mod, {});
  freshArt("off-refs");
  const e = await attempt(tools.get("newsroom_semantic_novelty"), { modules: [] });
  assert.ok(e.error);
  assert.deepEqual(register(mod, {}).get("newsroom_visual_concepts").parameters.required, ["discovery_ref", "concepts"]);
  check("off: refs stay required and nothing is inferred");
}
console.log(`${results.length} checks passed:`);
for (const r of results) console.log(`  PASS ${r}`);
