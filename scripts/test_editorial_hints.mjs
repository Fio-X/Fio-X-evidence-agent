// NEWSROOM_SPEED_EDITORIAL_HINTS=1: wording only. Field descriptions, one guideline line and two refusal suffixes tell
// the model what the editorial tools need. No schema constraint, fill, default or accept/refuse condition changes.
//
// Everything runs the real newsroom.ts (type-stripped) three ways: the pre-change file (a4d4cb0), this tree with the
// switch unset, and this tree with it "1".
//   Part 1  tool definitions: off == a4d4cb0 for every tool in every profile/phase; on changes exactly the four
//           editorial tools, only by field descriptions and one guideline line (the schema is equal once descriptions
//           are dropped, so Pi's validation cannot differ).
//   Part 2  the real handlers on synthetic artifact roots: the same accept/refuse decision in all three, a refusal
//           writes nothing, off == a4d4cb0 (result text, refusal text, files written), and on = the old refusal
//           text + one suffix.
//   Part 3  end to end with the real duckdb_query, record_claim and newsroom_visual_concepts (duckdb needed).
//   Part 4  the same checks fail on six deliberately broken copies of the on path (a relaxed gate, a leaking schema,
//           a suffix on every error, an offered forged claim, a file left behind, a refusal turned into an acceptance).
// No provider, relay or network call. Run: node scripts/test_editorial_hints.mjs
// BASELINE_NEWSROOM_TS=<file> replaces `git show <ref>:runtime/pi/newsroom.ts`; EDITORIAL_HINTS_BASELINE_REF changes
// the ref (default a4d4cb0); REQUIRE_BASELINE=1 makes a missing baseline fatal instead of a printed skip; KEEP_TMP=1 keeps
// the temp dirs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { revertNameLocalization } from "./lib_name_localization_baseline.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SWITCH = "NEWSROOM_SPEED_EDITORIAL_HINTS";
const BASELINE_REF = process.env.EDITORIAL_HINTS_BASELINE_REF || "a4d4cb0";
const { deriveClaimVerification } = await import(join(ROOT, "runtime/pi/evidence_gate.mjs"));
const { TOOL_REGISTRY } = await import(join(ROOT, "runtime/pi/tool_registry.mjs"));
const { VALID_TOOL_PHASES } = await import(join(ROOT, "runtime/pi/tool_phase_policy.mjs"));

let checks = 0;
const check = (name) => { checks += 1; console.log(`  ok  ${name}`); };

// ---- the exact wording the switch adds (pinned here: a wording change must change this file too) -------------------
const WORDING = {
  claimIds: "Only claim_ids whose record_claim result read \"VERIFIED by system replay\". A claim recorded without computation_refs never verifies, and citing it refuses the whole graph.",
  conceptRef: "Artifact path printed by newsroom_visual_concepts (editorial/concepts/...), not the discovery or story-graph path. Run that tool first.",
  conceptsGuideline: "Send all 8-20 concepts in ONE call; fewer than 8 is refused before the tool runs and nothing is saved.",
  conceptRefRefusal: "concept_ref is the Artifact line of newsroom_visual_concepts; run it first if you have none.",
  rule: "Rule: a story node may cite only a claim whose record_claim result read \"VERIFIED by system replay\"; a claim recorded as \"NOT VERIFIED / draft only\" (for example with no computation_refs) cannot be cited.",
  next: "Next step, either: (1) run duckdb_query on the data, then record_claim with computation_refs set to that query's artifact path, and cite the new claim_id; or (2) cite an already verified claim that states what the node says.",
};
const FOUR = { story: "newsroom_story_graph", concepts: "newsroom_visual_concepts", novelty: "newsroom_semantic_novelty", assets: "newsroom_asset_requirements" };

// ---- temp dirs: removed when the process exits (KEEP_TMP=1 keeps them for debugging) ------------------------------------
const TEMP_DIRS = [];
const tempDir = (label) => { const dir = mkdtempSync(join(tmpdir(), `editorial-hints-${label}-`)); TEMP_DIRS.push(dir); return dir; };
process.on("exit", () => { if (process.env.KEEP_TMP !== "1") for (const dir of TEMP_DIRS) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } });

// ---- loader: one type-stripped copy of the runtime per newsroom.ts source -------------------------------------------
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
// Every variant gets its own copy of the code (runtime/pi/*.mjs, so no module instance is shared between variants). The big
// read-only data (the skill bundle, vendored libraries, images, web assets: about 36 of the 39 MB) is linked, not copied.
const LINKED_IN_PI = new Set(["visual_skill_bundle.mjs", "vendor", "assets"]);
const loadTree = (label, source) => {
  const dir = tempDir(`tree-${label}`);
  mkdirSync(join(dir, "runtime/pi"), { recursive: true });
  for (const entry of readdirSync(join(ROOT, "runtime"))) if (entry !== "pi") symlinkSync(join(ROOT, "runtime", entry), join(dir, "runtime", entry));
  for (const entry of readdirSync(join(ROOT, "runtime/pi"))) {
    const [from, to] = [join(ROOT, "runtime/pi", entry), join(dir, "runtime/pi", entry)];
    if (LINKED_IN_PI.has(entry)) symlinkSync(from, to); else cpSync(from, to, { recursive: true });
  }
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const copy = join(dir, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(source ?? readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return import(copy);
};
function baselineSource() {
  if (process.env.BASELINE_NEWSROOM_TS) return { source: readFileSync(process.env.BASELINE_NEWSROOM_TS, "utf8"), from: process.env.BASELINE_NEWSROOM_TS };
  const shown = spawnSync("git", ["show", `${BASELINE_REF}:runtime/pi/newsroom.ts`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return shown.status === 0 && shown.stdout ? { source: shown.stdout, from: `git ${BASELINE_REF}` } : null;
}
const baselineFile = baselineSource();
if (!baselineFile && process.env.REQUIRE_BASELINE === "1") throw new Error(`baseline newsroom.ts (${BASELINE_REF}) is not available`);
if (!baselineFile) console.log(`SKIP baseline comparison: ${BASELINE_REF} is not in this repository (set BASELINE_NEWSROOM_TS to a pre-change newsroom.ts)`);
const baseMod = baselineFile ? await loadTree("baseline", baselineFile.source) : null;
const mainMod = await loadTree("main");

// Every other speed switch is unset so the only difference between two runs is the one under test.
const OTHER_SWITCHES = Object.fromEntries(Object.keys(process.env).filter((k) => /^NEWSROOM_(SPEED_|SHADOW_|HIDE_)/.test(k) && k !== SWITCH).map((k) => [k, undefined]));
const BASE_ENV = { ...OTHER_SWITCHES, [SWITCH]: undefined, NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_PHASE_METRICS: undefined, NEWSROOM_MOBILE_PAGES: undefined };
const setEnv = (env) => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
function register(mod, env) {
  setEnv({ ...BASE_ENV, ...env });
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const slim = (tool) => JSON.stringify({ parameters: tool.parameters, description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });
const dropDescriptions = (schema) => JSON.stringify(schema, (k, v) => (k === "description" && typeof v === "string" ? undefined : v));
function descriptionPaths(node, path = "", out = {}) {
  if (Array.isArray(node)) node.forEach((v, i) => descriptionPaths(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { if (k === "description" && typeof v === "string") out[path] = v; else descriptionPaths(v, path ? `${path}.${k}` : k, out); }
  return out;
}

// ---- Part 1: tool definitions ---------------------------------------------------------------------------------------
const PROFILES = Array.isArray(TOOL_REGISTRY.profiles) ? TOOL_REGISTRY.profiles : Object.keys(TOOL_REGISTRY.profiles);
const PHASES = [undefined, "core", "design", "publish", "verify", "core,design"].filter((p) => !p || p.split(",").every((x) => VALID_TOOL_PHASES.includes(x)));
const EXPECTED_DESCRIPTIONS = {
  [FOUR.story]: { "properties.nodes.items.properties.claim_ids": WORDING.claimIds },
  [FOUR.novelty]: { "properties.concept_ref": WORDING.conceptRef },
  [FOUR.assets]: { "properties.concept_ref": WORDING.conceptRef },
  [FOUR.concepts]: {},
};
// Default-on tool changes approved after a4d4cb0. For a listed tool the switch-off definition may differ from the baseline
// only at the listed property path of its parameters; everything else (description, snippet, guidelines, every other
// property) must still equal a4d4cb0. The path must really differ, so a reverted change fails here too.
const APPROVED_LATER = {
  newsroom_viz_plan: { commit: "b38a345", path: ["properties", "measure_semantics"], added: [["properties", "rank_cutoff"], ["properties", "index_base"], ["properties", "map_extent"]], addedWhy: "round-3 opt-in chart fields and the opt-in world choropleth mode" },
};
// Properties an approved later change added: they must be absent from the baseline and present in the switch-off
// definition, and are then removed from the switch-off copy before the comparison with a4d4cb0.
const withAddedRemoved = (tool, paths) => {
  const parameters = JSON.parse(JSON.stringify(tool.parameters));
  const present = paths.map((path) => {
    let node = parameters;
    for (const key of path.slice(0, -1)) node = node?.[key];
    const had = !!node && path[path.length - 1] in node;
    if (had) delete node[path[path.length - 1]];
    return had;
  });
  return { tool: { ...tool, parameters }, present };
};
const withPathCleared = (tool, path) => {
  const parameters = JSON.parse(JSON.stringify(tool.parameters));
  let node = parameters;
  for (const key of path.slice(0, -1)) node = node?.[key];
  const had = node && path[path.length - 1] in node;
  if (had) node[path[path.length - 1]] = null;
  return { had, slim: slim({ ...tool, parameters }) };
};
function checkDefinitions(mod, { quiet = false } = {}) {
  let pairs = 0, delta = 0;
  for (const profile of PROFILES) for (const phase of PHASES) {
    const env = { NEWSROOM_TOOL_PROFILE: profile, NEWSROOM_PHASE: phase };
    const off = register(mod, { ...env, [SWITCH]: undefined });
    const on = register(mod, { ...env, [SWITCH]: "1" });
    const base = baseMod ? register(baseMod, { ...env, [SWITCH]: undefined }) : null;
    const where = `profile=${profile} phase=${phase ?? "-"}`;
    pairs += 1;
    assert.deepEqual([...on.keys()], [...off.keys()], `${where}: the switch adds or removes no tool`);
    if (base) {
      assert.deepEqual([...off.keys()], [...base.keys()], `${where}: switch off registers the tools a4d4cb0 registers`);
      for (const name of base.keys()) {
        const approved = APPROVED_LATER[name];
        // The category_names wording and enum (zh-names-1003) are a second declared difference from a4d4cb0, for the two
        // tools that carry them; revertNameLocalization puts the old wording back and refuses a surface that lacks exactly
        // those edits. It is the identity for every other tool.
        const current = revertNameLocalization(off.get(name));
        if (!approved) { assert.equal(slim(current), slim(base.get(name)), `${where}: switch off == baseline for ${name}`); continue; }
        const added = approved.added ?? [];
        const offTool = withAddedRemoved(current, added), baseTool = withAddedRemoved(base.get(name), added);
        assert.ok(offTool.present.every(Boolean), `${where}: ${name} has the added properties ${added.map((p) => p.join(".")).join(", ")} (${approved.addedWhy})`);
        assert.ok(baseTool.present.every((x) => !x), `${where}: a4d4cb0 has none of the added properties`);
        const [o, b] = [withPathCleared(offTool.tool, approved.path), withPathCleared(base.get(name), approved.path)];
        assert.ok(o.had && b.had, `${where}: ${name} still has ${approved.path.join(".")} (approved change ${approved.commit})`);
        assert.equal(o.slim, b.slim, `${where}: switch off == baseline for ${name} outside ${approved.path.join(".")} (approved change ${approved.commit})`);
        assert.notEqual(slim(current), slim(base.get(name)), `${where}: ${name} differs from the baseline at ${approved.path.join(".")} (approved change ${approved.commit}); drop the entry if it is reverted`);
      }
    }
    const changed = [...off.keys()].filter((name) => slim(on.get(name)) !== slim(off.get(name)));
    assert.ok(changed.every((name) => Object.values(FOUR).includes(name)), `${where}: only editorial tools may differ, got ${changed.join(", ")}`);
    for (const name of changed) {
      const [o, n] = [off.get(name), on.get(name)];
      assert.equal(n.description, o.description, `${name}: tool description unchanged`);
      assert.equal(n.promptSnippet, o.promptSnippet, `${name}: prompt snippet unchanged`);
      assert.equal(dropDescriptions(n.parameters), dropDescriptions(o.parameters), `${name}: schema (types, required, min/max, enums, order) equal once field descriptions are dropped`);
      const [dOff, dOn] = [descriptionPaths(o.parameters), descriptionPaths(n.parameters)];
      const added = Object.fromEntries(Object.entries(dOn).filter(([p, t]) => dOff[p] !== t));
      assert.deepEqual(added, EXPECTED_DESCRIPTIONS[name], `${name}: the only field descriptions added`);
      assert.deepEqual(Object.keys(dOff).filter((p) => !(p in dOn)), [], `${name}: no existing description removed`);
      const [gOff, gOn] = [o.promptGuidelines ?? [], n.promptGuidelines ?? []];
      assert.deepEqual(gOn.slice(0, gOff.length), gOff, `${name}: existing guidelines untouched and first`);
      assert.deepEqual(gOn.slice(gOff.length), name === FOUR.concepts ? [WORDING.conceptsGuideline] : [], `${name}: the only guideline added`);
    }
    if (profile === "full" && !phase) {
      assert.deepEqual(changed.sort(), Object.values(FOUR).sort(), "full profile: exactly the four editorial tools differ");
      delta = changed.reduce((sum, name) => sum + Buffer.byteLength(slim(on.get(name))) - Buffer.byteLength(slim(off.get(name))), 0);
      assert.ok(delta > 0 && delta < 1000, `the switch adds under 1 KB to the tool surface (${delta} B)`);
      // the guideline quotes the schema's own bounds, so a changed bound makes this fail instead of leaving a stale hint
      const bounds = off.get(FOUR.concepts).parameters.properties.concepts;
      assert.ok(Number.isInteger(bounds.minItems) && Number.isInteger(bounds.maxItems), "concepts keeps its minItems/maxItems");
      assert.ok(WORDING.conceptsGuideline.includes(`${bounds.minItems}-${bounds.maxItems} concepts`) && WORDING.conceptsGuideline.includes(`fewer than ${bounds.minItems} is refused`), `the guideline quotes the schema bounds ${bounds.minItems}..${bounds.maxItems}`);
    }
    for (const value of ["true", "0", "", "yes", " 1", "1 ", "01"]) {
      const odd = register(mod, { ...env, [SWITCH]: value });
      for (const name of off.keys()) assert.equal(slim(odd.get(name)), slim(off.get(name)), `${where}: ${SWITCH}=${JSON.stringify(value)} must not switch anything on (${name})`);
    }
  }
  assert.ok(pairs >= 6, "profile/phase pairs ran");
  if (!quiet) check(`definitions: ${pairs} profile/phase pairs; off == ${baseMod ? "a4d4cb0" : "(baseline skipped)"} for every tool; on differs only in three field descriptions and one guideline line (+${delta} B of tool surface, full profile); only exactly "1" switches it on`);
}

// ---- fixtures: neutral synthetic artifact roots --------------------------------------------------------------------
const WORK = tempDir("work");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const listing = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).filter((f) => !f.startsWith("config/")).sort().map((f) => [f, sha(readFileSync(join(art, f)))]));
// The same path for every variant of a case, so absolute paths inside results and artifacts agree.
function freshRoot(id) {
  const base = join(WORK, id);
  rmSync(base, { recursive: true, force: true });
  const art = join(base, "run");
  for (const d of ["data", "sources", "computations", "runtime/query-rows", "editorial/story-graphs", "editorial/discovery", "editorial/concepts", "editorial/novelty", "editorial/assets"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}
const claimRecord = (id, claim, { replayed = true, status, verification } = {}) => {
  const v = verification ?? deriveClaimVerification({ source_resolved: true, extraction_passed: true, computation_replayed: replayed, claim_supported: true });
  return { schema_version: "0.8.0", claim_id: id, claim, claim_kind: "descriptive", requested_status: "supported", status: status ?? (v.publishable ? "verified" : "supported"), verification: v, source_refs: ["data/fixture.csv"], computation_refs: replayed ? ["computations/fixture.json"] : [], caveat: null };
};
const writeClaims = (art, records) => writeFileSync(join(art, "claims.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
const LONG = "Region S holds the largest share of the total in the last period, well above every other region in the fixture";
const STD_CLAIMS = () => [
  claimRecord("c-ok-1", "Region N amounts rose between the first and last periods"),
  claimRecord("c-ok-2", LONG),
  claimRecord("c-draft-1", "Amounts differ by region", { replayed: false }),
  // forged: the model's own say-so, or flags without the replay, is never a verification
  claimRecord("c-forged-model", "Every region doubled", { status: "verified", verification: { authority: "model", publishable: true } }),
  claimRecord("c-forged-flags", "Region E is the smallest", { status: "verified", verification: { ...deriveClaimVerification({ source_resolved: true, extraction_passed: true, computation_replayed: false, claim_supported: true }), publishable: true } }),
];
const story = (a, b, c) => ({
  story_id: "s1", reader_question: "What changed between the first and the last period?", visual_thesis: "A before and after view shows where the totals moved.",
  nodes: [
    { id: "n1", kind: "evidence", summary: "The first period sets the starting totals.", explanatory_dimension: "spatial", ...(a ? { claim_ids: a } : {}) },
    { id: "n2", kind: "evidence", summary: "The last period shows the new split between regions.", explanatory_dimension: "distribution", ...(b ? { claim_ids: b } : {}) },
    { id: "n3", kind: "outcome", summary: "The totals moved toward one region.", explanatory_dimension: "trend", ...(c ? { claim_ids: c } : {}) },
  ],
  edges: [{ from: "n1", to: "n2", relation: "explains" }, { from: "n2", to: "n3", relation: "precedes" }],
  entry_node_ids: ["n1"], answer_node_ids: ["n3"],
});
const FRAMINGS = ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal"];
const concepts = (n, framings = FRAMINGS) => Array.from({ length: n }, (_, i) => ({
  concept_id: `k${i + 1}`, reader_question: `What does view ${i + 1} show?`, editorial_premise: `Premise ${i + 1}: a distinct way to open the page with this evidence.`,
  visual_metaphor: `Metaphor ${i + 1}`, hero_scene: `Hero scene ${i + 1}`, framing: framings[i % framings.length], hero_evidence_refs: ["c-ok-1"], supporting_evidence_refs: [],
  asset_requirements: [], media_mix: ["map"], risk_flags: [], reporting_gaps: [], why_memorable: `Reason ${i + 1} that readers would remember this opening scene.`,
}));
const noveltyModules = [
  { id: "m1", reader_question_id: "q1", claim_set: ["c-ok-1"], new_information: "The starting totals by region.", explanatory_dimension: "spatial" },
  { id: "m2", reader_question_id: "q2", claim_set: ["c-ok-2"], new_information: "The final split between regions.", explanatory_dimension: "distribution" },
];
const assetReqs = [{ asset_class: "geographic_coordinates", status: "required", available: false, purpose: "Place each region on a base map." }];
// editorial inputs a call may point at: a discovery, a concept set with two finalists, a story graph
function editorialRoot(art) {
  writeClaims(art, STD_CLAIMS());
  writeFileSync(join(art, "editorial/discovery/d1.json"), JSON.stringify({ decision: "CONTINUE" }));
  writeFileSync(join(art, "editorial/concepts/k1.json"), JSON.stringify({ finalists: ["f1", "f2"], discovery_ref: "editorial/discovery/d1.json" }));
  writeFileSync(join(art, "editorial/story-graphs/g1.json"), JSON.stringify({ passed: true }));
  return art;
}

// ---- Part 2: the case table ------------------------------------------------------------------------------------------
// expect: "accept" | "refuse"; reason: what the OLD (a4d4cb0) refusal text must match exactly, so a case cannot refuse
// for another reason than the one it names; suffix: "story" | "concept_ref" | "none" (on text must equal off text).
const refuse = (id, tool, setup, reason, suffix, extra = {}) => ({ id, tool, setup, expect: "refuse", reason, suffix, ...extra });
const accept = (id, tool, setup) => ({ id, tool, setup, expect: "accept" });
const withClaims = (records, params) => (art) => { writeClaims(art, records); return params; };
const novelty = (ref) => (art) => { editorialRoot(art); return { concept_ref: typeof ref === "function" ? ref(art) : ref, modules: noveltyModules }; };
const assets = (ref, id = "f1") => (art) => { editorialRoot(art); return { concept_ref: typeof ref === "function" ? ref(art) : ref, concept_id: id, requirements: assetReqs }; };
const VERIFIED_15 = Array.from({ length: 15 }, (_, i) => claimRecord(`v${String(i + 1).padStart(2, "0")}`, `Verified fixture claim number ${i + 1} with a long statement that runs past sixty characters`));
const WRONG_PREFIX = /^Artifact path must be under editorial\/concepts\/: editorial\/(discovery\/d1|story-graphs\/g1)\.json$/;
const CASES = [
  // newsroom_story_graph: R1 / R2 shape (a node cites a claim the system did not verify)
  accept("story: every cited claim verified", "story", withClaims(STD_CLAIMS(), story(["c-ok-1"], ["c-ok-2"], ["c-ok-1", "c-ok-2"]))),
  accept("story: nodes without claim_ids", "story", withClaims(STD_CLAIMS(), story())),
  refuse("story: draft claim (recorded without a computation)", "story", withClaims(STD_CLAIMS(), story(["c-ok-1"], ["c-draft-1"], ["c-ok-1"])), /^Story node 'n2' references unverified claim 'c-draft-1'$/, "story",
    { pairs: "Unverified node/claim pairs (1): n2: c-draft-1.", verified: ["c-ok-1", "c-ok-2"], notOffered: ["c-draft-1", "c-forged-model", "c-forged-flags"] }),
  refuse("story: claim id that was never recorded", "story", withClaims(STD_CLAIMS(), story(["c-ok-1"], ["c-ok-2"], ["never-recorded"])), /^Story node 'n3' references unverified claim 'never-recorded'$/, "story",
    { pairs: "Unverified node/claim pairs (1): n3: never-recorded.", verified: ["c-ok-1", "c-ok-2"], notOffered: ["c-draft-1", "c-forged-model", "c-forged-flags"] }),
  refuse("story: claim whose status says verified but the author is the model", "story", withClaims(STD_CLAIMS(), story(["c-forged-model"], null, null)), /^Story node 'n1' references unverified claim 'c-forged-model'$/, "story",
    { pairs: "Unverified node/claim pairs (1): n1: c-forged-model.", verified: ["c-ok-1", "c-ok-2"], notOffered: ["c-draft-1", "c-forged-model", "c-forged-flags"] }),
  refuse("story: verified flags without the computation replay", "story", withClaims(STD_CLAIMS(), story(null, ["c-forged-flags"], null)), /^Story node 'n2' references unverified claim 'c-forged-flags'$/, "story",
    { pairs: "Unverified node/claim pairs (1): n2: c-forged-flags.", verified: ["c-ok-1", "c-ok-2"], notOffered: ["c-draft-1", "c-forged-model", "c-forged-flags"] }),
  refuse("story: several nodes, repeated and mixed claims (every pair listed once)", "story", withClaims(STD_CLAIMS(), story(["c-draft-1", "c-draft-1"], ["c-ok-1", "never-recorded"], ["c-forged-model", "c-draft-1"])), /^Story node 'n1' references unverified claim 'c-draft-1'$/, "story",
    { pairs: "Unverified node/claim pairs (4): n1: c-draft-1; n2: never-recorded; n3: c-forged-model, c-draft-1.", verified: ["c-ok-1", "c-ok-2"], notOffered: ["c-draft-1", "c-forged-model", "c-forged-flags", "never-recorded"] }),
  refuse("story: fifteen verified claims (twelve most recent offered, text cut)", "story", withClaims([...VERIFIED_15, claimRecord("c-draft-1", "Amounts differ by region", { replayed: false })], story(["v01"], ["c-draft-1"], ["v02"])), /^Story node 'n2' references unverified claim 'c-draft-1'$/, "story",
    { pairs: "Unverified node/claim pairs (1): n2: c-draft-1.", verified: VERIFIED_15.slice(3).map((r) => r.claim_id), header: "Verified claims (12 most recent of 15):", notOffered: ["c-draft-1", "v01", "v02", "v03"] }),
  refuse("story: no claims recorded at all", "story", (art) => story(["c-ok-1"], null, null), /^Story node 'n1' references unverified claim 'c-ok-1'$/, "story",
    { pairs: "Unverified node/claim pairs (1): n1: c-ok-1.", verified: [], none: true }),
  // newsroom_visual_concepts: R4 shape (the count rule). The wording is a guideline, so every validator is unchanged.
  accept("concepts: 8 concepts, 7 framings", "concepts", (art) => { editorialRoot(art); return { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(8) }; }),
  accept("concepts: 20 concepts", "concepts", (art) => { editorialRoot(art); return { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(20) }; }),
  refuse("concepts: 7 concepts (the handler's own range check)", "concepts", (art) => { editorialRoot(art); return { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(7) }; }, /award-mode concepts must contain 8\.\.20 candidates/, "none"),
  refuse("concepts: 21 concepts", "concepts", (art) => { editorialRoot(art); return { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(21) }; }, /award-mode concepts must contain 8\.\.20 candidates/, "none"),
  refuse("concepts: 8 concepts, two framings", "concepts", (art) => { editorialRoot(art); return { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(8, ["spatial", "temporal"]) }; }, /at least three distinct framings/, "none"),
  refuse("concepts: discovery_ref in the wrong folder (no concept_ref hint here)", "concepts", (art) => { editorialRoot(art); return { discovery_ref: "editorial/concepts/k1.json", concepts: concepts(8) }; }, /^Artifact path must be under editorial\/discovery\/: editorial\/concepts\/k1\.json$/, "none"),
  refuse("concepts: discovery did not say CONTINUE", "concepts", (art) => { editorialRoot(art); writeFileSync(join(art, "editorial/discovery/d1.json"), JSON.stringify({ decision: "RESEARCH_MORE" })); return { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(8) }; }, /^Editorial discovery is 'RESEARCH_MORE', so concept selection cannot proceed$/, "none"),
  // newsroom_semantic_novelty: R3 shape (concept_ref is not the path newsroom_visual_concepts printed)
  accept("novelty: concept set path", "novelty", novelty("editorial/concepts/k1.json")),
  accept("novelty: ./ spelling of the same path (accepted today, so no schema pattern may reject it)", "novelty", novelty("./editorial/concepts/k1.json")),
  accept("novelty: absolute path inside the artifact root", "novelty", novelty((art) => join(art, "editorial/concepts/k1.json"))),
  refuse("novelty: the discovery path", "novelty", novelty("editorial/discovery/d1.json"), WRONG_PREFIX, "concept_ref"),
  refuse("novelty: the story-graph path", "novelty", novelty("editorial/story-graphs/g1.json"), WRONG_PREFIX, "concept_ref"),
  refuse("novelty: right folder, no such file (not a prefix error: no hint)", "novelty", novelty("editorial/concepts/nope.json"), /ENOENT/, "none"),
  refuse("novelty: path outside the artifact root (no hint)", "novelty", novelty("../outside.json"), /^Artifact path escapes investigation: \.\.\/outside\.json$/, "none"),
  refuse("novelty: right concept set, one module", "novelty", (art) => { editorialRoot(art); return { concept_ref: "editorial/concepts/k1.json", modules: noveltyModules.slice(0, 1) }; }, /semantic novelty requires 2\.\.30 modules/, "none"),
  // newsroom_asset_requirements: the same ref, plus the finalist rule
  accept("assets: concept set path, finalist", "assets", assets("editorial/concepts/k1.json")),
  accept("assets: ./ spelling", "assets", assets("./editorial/concepts/k1.json", "f2")),
  refuse("assets: the discovery path", "assets", assets("editorial/discovery/d1.json"), WRONG_PREFIX, "concept_ref"),
  refuse("assets: the story-graph path", "assets", assets("editorial/story-graphs/g1.json"), WRONG_PREFIX, "concept_ref"),
  refuse("assets: concept_id is not a finalist (no hint)", "assets", assets("editorial/concepts/k1.json", "zz"), /^concept_id 'zz' is not a finalist in the supplied concept set$/, "none"),
  refuse("assets: right folder, no such file (no hint)", "assets", assets("editorial/concepts/nope.json"), /ENOENT/, "none"),
  refuse("assets: path outside the artifact root (no hint)", "assets", assets("../outside.json"), /^Artifact path escapes investigation: \.\.\/outside\.json$/, "none"),
];

async function runCases(variant, tools) {
  const out = {};
  for (const c of CASES) {
    const art = freshRoot(c.id.replace(/[^a-z0-9]+/gi, "-").slice(0, 60));
    const params = c.setup(art);
    const before = listing(art);
    let result;
    try { const r = await tools.get(FOUR[c.tool]).execute("t", params); result = { accepted: true, text: r.content[0].text, details: r.details }; }
    catch (e) { result = { accepted: false, text: String(e?.message ?? e) }; }
    out[c.id] = { ...result, before, after: listing(art) };
  }
  return out;
}

function checkStorySuffix(c, offText, onText) {
  const suffix = onText.slice(offText.length);
  const lines = suffix.split("\n");
  assert.equal(lines[0], "", `${c.id}: the suffix starts on a new line`);
  assert.equal(lines[1], `${c.pairs} Nothing was saved; send the whole graph again.`, `${c.id}: every unverified node/claim pair, once`);
  assert.equal(lines[2], WORDING.rule, `${c.id}: the rule`);
  assert.equal(lines[3], WORDING.next, `${c.id}: the two legal next steps`);
  if (c.none) { assert.equal(lines[4], "Verified claims: none recorded yet, so take step (1)."); assert.equal(lines.length, 5); return; }
  assert.equal(lines[4], c.header ?? `Verified claims (${c.verified.length}):`, `${c.id}: verified list header`);
  const entries = lines.slice(5);
  assert.deepEqual(entries.map((l) => l.match(/^ {2}(\S+) /)?.[1]), c.verified, `${c.id}: verified ids offered (at most 12, most recent, file order)`);
  assert.ok(entries.length <= 12, `${c.id}: at most 12 verified claims`);
  const stored = Object.fromEntries([...STD_CLAIMS(), ...VERIFIED_15].map((r) => [r.claim_id, r.claim]));
  for (const line of entries) {
    const [, id, quoted] = line.match(/^ {2}(\S+) (".*")$/);
    const shown = JSON.parse(quoted);
    assert.ok(shown.length <= 60, `${c.id}: ${id} text is cut to about 60 characters (${shown.length})`);
    assert.ok(stored[id].length <= 60 ? shown === stored[id] : shown.endsWith("...") && stored[id].startsWith(shown.slice(0, -3)), `${c.id}: ${id} shows its stored claim text`);
  }
  for (const id of c.notOffered) assert.ok(!entries.join("\n").includes(id) || c.verified.includes(id), `${c.id}: ${id} is not offered as verified`);
  for (const id of c.notOffered) assert.ok(!c.verified.includes(id), `${c.id}: fixture sanity`);
}

function compareCases(base, off, on) {
  for (const c of CASES) {
    const [b, o, n] = [base?.[c.id], off[c.id], on[c.id]];
    for (const [name, r] of [["a4d4cb0", b], ["off", o], ["on", n]]) {
      if (!r) continue;
      assert.equal(r.accepted, c.expect === "accept", `${c.id} [${name}]: ${r.accepted ? "was accepted" : `was refused: ${r.text.slice(0, 200)}`}`);
      if (c.expect === "refuse") assert.deepEqual(r.after, r.before, `${c.id} [${name}]: a refusal must write nothing`);
    }
    if (b) assert.deepEqual(o, b, `${c.id}: switch off == a4d4cb0 (result or refusal text, details and files written)`);
    if (c.expect === "accept") {
      assert.ok(Object.keys(o.after).length > Object.keys(o.before).length, `${c.id}: an accepted call writes its artifact`);
      assert.deepEqual(n, o, `${c.id}: switch on accepts the same call with the same text, details and artifact bytes`);
      continue;
    }
    assert.match(o.text, c.reason, `${c.id}: refused for the named reason`);
    assert.ok(n.text.startsWith(o.text), `${c.id}: on text starts with the old refusal text`);
    if (c.suffix === "none") assert.equal(n.text, o.text, `${c.id}: no suffix on this refusal`);
    else if (c.suffix === "concept_ref") assert.equal(n.text, `${o.text}\n${WORDING.conceptRefRefusal}`, `${c.id}: old text + one line`);
    else checkStorySuffix(c, o.text, n.text);
  }
}

async function checkHandlers(mod, { quiet = false } = {}) {
  const run = async (m, on) => { const tools = register(m, { [SWITCH]: on ? "1" : undefined }); return runCases(on, tools); };
  const base = baseMod ? await run(baseMod, false) : null;
  const off = await run(mod, false);
  const on = await run(mod, true);
  compareCases(base, off, on);
  if (!quiet) {
    const n = (k) => CASES.filter((c) => c.expect === k).length;
    check(`handlers: ${CASES.length} cases (${n("accept")} accepted, ${n("refuse")} refused) give the same decision off, on${base ? " and on a4d4cb0" : ""}; refusals write nothing; off == a4d4cb0; on = old text + suffix`);
  }
}

// ---- Part 3: end to end with the real tools --------------------------------------------------------------------------
const duckdbMissing = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT";
const addData = (art, csv) => {
  const bytes = Buffer.from(csv), ref = `data/${sha(bytes)}.csv`;
  writeFileSync(join(art, ref), bytes);
  writeFileSync(join(art, `${ref}.meta.json`), JSON.stringify({ file: ref, sha256: sha(bytes), bytes: bytes.length, label: "fixture" }));
  return ref;
};
const step = async (log, name, tool, params) => {
  try { const r = await tool.execute("t", params); log.push({ name, accepted: true, text: r.content[0].text }); return r; }
  catch (e) { log.push({ name, accepted: false, text: String(e?.message ?? e) }); return null; }
};
async function e2eClaims(tools) {
  const log = [], art = freshRoot("e2e-claims");
  const data = addData(art, "region,amount\nn,4\ns,9\nn,6\n");
  const q = await tools.get("duckdb_query").execute("q", { sql: `SELECT region, amount FROM read_csv_auto('${data}')` });
  const computation = relative(art, q.details.path);
  const record = (claim, refs) => tools.get("record_claim").execute("c", { claim, claim_kind: "descriptive", status: "supported", source_refs: [data], computation_refs: refs });
  const good = await record("Total amount by region is computed from the fixture rows", [computation]);
  const draft = await record("Amounts differ between regions", []);
  assert.match(good.content[0].text, /VERIFIED by system replay/);
  assert.match(draft.content[0].text, /NOT VERIFIED \/ draft only/);
  const [goodId, draftId] = [good.details.claimId, draft.details.claimId];
  const graph = tools.get(FOUR.story);
  await step(log, "graph citing the draft claim", graph, story([goodId], [draftId], [goodId]));
  await step(log, "step (2): cite the verified claim", graph, story([goodId], [goodId], [goodId]));
  const fixed = await record("Amounts differ between regions, computed from the fixture rows", [computation]);
  assert.match(fixed.content[0].text, /VERIFIED by system replay/);
  await step(log, "step (1): new claim with computation_refs", graph, story([goodId], [fixed.details.claimId], [goodId]));
  return { log, files: Object.fromEntries(Object.entries(listing(art)).filter(([f]) => f.startsWith("editorial/"))), ids: { goodId, draftId, fixedId: fixed.details.claimId } };
}
async function e2eEditorial(tools) {
  const log = [], art = freshRoot("e2e-editorial");
  editorialRoot(art);
  const made = await step(log, "visual concepts", tools.get(FOUR.concepts), { discovery_ref: "editorial/discovery/d1.json", concepts: concepts(8) });
  const conceptRef = made.details.conceptRef;
  assert.match(made.content[0].text, new RegExp(`Artifact: ${conceptRef.replace(/[.]/g, "\\.")}`), "the Artifact line is the concept_ref the hints talk about");
  await step(log, "novelty with the printed Artifact path", tools.get(FOUR.novelty), { concept_ref: conceptRef, modules: noveltyModules });
  await step(log, "assets with the printed Artifact path", tools.get(FOUR.assets), { concept_ref: conceptRef, concept_id: made.details.finalists[0], requirements: assetReqs });
  await step(log, "novelty with the discovery path", tools.get(FOUR.novelty), { concept_ref: "editorial/discovery/d1.json", modules: noveltyModules });
  await step(log, "assets with the discovery path", tools.get(FOUR.assets), { concept_ref: "editorial/discovery/d1.json", concept_id: made.details.finalists[0], requirements: assetReqs });
  return { log, files: Object.fromEntries(Object.entries(listing(art)).filter(([f]) => f.startsWith("editorial/") && !f.startsWith("editorial/discovery/") && !f.startsWith("editorial/story-graphs/g1"))) };
}
function compareLogs(label, base, off, on) {
  for (const [i, o] of off.log.entries()) {
    const n = on.log[i];
    if (base) assert.deepEqual(base.log[i], o, `${label} step ${i + 1} (${o.name}): off == a4d4cb0`);
    assert.equal(n.accepted, o.accepted, `${label} step ${i + 1} (${o.name}): same decision`);
    if (o.accepted) assert.equal(n.text, o.text, `${label} step ${i + 1} (${o.name}): same result text`);
    else assert.ok(n.text.startsWith(o.text) && n.text.length > o.text.length, `${label} step ${i + 1} (${o.name}): old text + suffix`);
  }
  if (base) assert.deepEqual(off.files, base.files, `${label}: off writes what a4d4cb0 writes`);
  assert.deepEqual(on.files, off.files, `${label}: on writes byte-identical artifacts`);
}
async function checkEndToEnd(mod) {
  const variants = async (fn) => {
    const one = async (m, on) => { const tools = register(m, { [SWITCH]: on ? "1" : undefined }); return fn(tools); };
    return [baseMod ? await one(baseMod, false) : null, await one(mod, false), await one(mod, true)];
  };
  if (duckdbMissing) console.log("SKIP end-to-end claim flow: duckdb binary not found");
  else {
    const [base, off, on] = await variants(e2eClaims);
    compareLogs("claims", base, off, on);
    assert.deepEqual(off.log.map((s) => s.accepted), [false, true, true], "draft refused; both legal next steps accepted");
    const suffix = on.log[0].text.slice(off.log[0].text.length);
    assert.ok(suffix.includes(on.ids.goodId) && suffix.includes("\"Total amount by region is computed from the fixture rows\""), "the real verified claim is offered with its stored text");
    assert.ok(!suffix.slice(suffix.indexOf("Verified claims")).includes(on.ids.draftId), "the draft claim is not offered as verified");
    assert.match(suffix, new RegExp(`n2: ${on.ids.draftId}\\.`), "the real draft claim is the listed pair");
    check("end to end: real duckdb_query + record_claim: draft claim refused with the hint; step (2) and step (1) are both accepted; same artifacts as off and a4d4cb0");
  }
  const [base, off, on] = await variants(e2eEditorial);
  compareLogs("editorial", base, off, on);
  assert.deepEqual(off.log.map((s) => s.accepted), [true, true, true, false, false], "printed Artifact path accepted by both; discovery path refused by both");
  for (const i of [3, 4]) assert.equal(on.log[i].text, `${off.log[i].text}\n${WORDING.conceptRefRefusal}`);
  check("end to end: real newsroom_visual_concepts prints the path novelty and assets accept; the discovery path is refused with the one-line hint");
}

// ---- Part 4: the checks above must fail on a broken on path -----------------------------------------------------------
const MUTANTS = [
  ["the switch relaxes the story gate", "if (!verified.has(String(claimId))) throw new Error(`Story node", "if (!verified.has(String(claimId)) && !editorialHintsEnabled()) throw new Error(`Story node"],
  ["the hint descriptions reach the off schema", "(editorialHintsEnabled() ? { ...(base ?? {}), description } : base)", "({ ...(base ?? {}), description })"],
  ["the concept_ref suffix reaches every error", "if (editorialHintsEnabled() && String(error?.message ?? \"\").startsWith(\"Artifact path must be under editorial/concepts/:\"))", "if (editorialHintsEnabled())"],
  ["the story hint offers claims the model marked verified", "const records = [...(await verifiedClaimRecords())];", "const records = [...(await verifiedClaimRecords())].concat([[\"c-draft-1\", { claim: \"x\" }]]);"],
  ["a refused story graph leaves a file behind", "const unverified = new Map<string, string[]>();", "const unverified = new Map<string, string[]>(); await writeArtifactIfAbsent(\"editorial/story-graphs/leak.json\", { leak: true });"],
  ["the concept_ref hint turns a refusal into an acceptance", "    throw error;\n  }\n}\n\n// NEWSROOM_SPEED_PREFLIGHT=1", "    if (editorialHintsEnabled()) return { finalists: [\"f1\", \"f2\"] };\n    throw error;\n  }\n}\n\n// NEWSROOM_SPEED_PREFLIGHT=1"],
];
async function checkMutants() {
  const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  for (const [name, from, to] of MUTANTS) {
    assert.ok(source.includes(from), `mutant "${name}" no longer applies: update MUTANTS`);
    const mod = await loadTree("mutant", source.replace(from, to));
    let caught = null;
    try { checkDefinitions(mod, { quiet: true }); await checkHandlers(mod, { quiet: true }); } catch (e) { caught = e; }
    assert.ok(caught, `the checks did not notice: ${name}`);
    check(`negative control: noticed "${name}" (${String(caught.message).split("\n")[0].slice(0, 90)})`);
  }
}

checkDefinitions(mainMod);
await checkHandlers(mainMod);
await checkEndToEnd(mainMod);
await checkMutants();
console.log(`\neditorial hints: ${checks} checks -- PASS${baseMod ? "" : " (baseline comparison skipped)"}`);
