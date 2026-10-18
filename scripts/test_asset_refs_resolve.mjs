// NEWSROOM_ASSET_REFS_RESOLVE (on unless exactly "0"): newsroom_asset_requirements counts an available:true row only when every source_refs
// entry names an ordinary file of this run (any folder but staging/; not out of the run folder, not through a link out of it). Nothing here
// says the file is the asset's source, only that it exists in the run. available:false rows are not looked at. Offline, no provider.
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { stripTypeScriptTypes, createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const results = [];
const check = (name) => results.push(name);
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
  const dir = makeTestTmp(`compact-tree-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  writeFileSync(join(dir, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
  writeFileSync(join(dir, "node_modules", "typebox", "compile.js"), `export * from ${JSON.stringify(pathToFileURL(REAL_COMPILE).href)};\n`);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  // The older newsroom.ts imports the shadow-check exports that were since removed; give the baseline tree the shadow.mjs of the same baseline ref.
 
  return import(join(pi, "newsroom.test-copy.mjs"));
}
// The stub Type builds plain JSON-schema objects; the Compile validator Pi applies to tool arguments is the real one, found in
// the installed Pi (the stub package re-exports typebox/compile from there).
const PI_DIR = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim() + "/@earendil-works/pi-coding-agent";
const REAL_COMPILE = createRequire(join(PI_DIR, "package.json")).resolve("typebox/compile");
const { Compile } = await import(pathToFileURL(REAL_COMPILE).href);
const SWITCH = "NEWSROOM_ASSET_REFS_RESOLVE";
const BASE_ENV = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_SPEED_COMPACT_SETUP: undefined, NEWSROOM_ASSET_REFS_RESOLVE: undefined };
function register(mod, env) {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const freshArt = (label) => { const art = join(makeTestTmp(`compact-${label}-`), "run"); mkdirSync(join(art, "editorial"), { recursive: true }); mkdirSync(join(art, "runtime"), { recursive: true }); mkdirSync(join(art, "data"), { recursive: true }); writeFileSync(join(art, "data", "x.csv"), "region,value\nA,1\n"); process.env.NEWSROOM_ARTIFACT_DIR = art; return art; };
const attempt = async (tool, params) => { try { return await tool.execute("t", params); } catch (error) { return { error: String(error?.message ?? error) }; } };
const ref = (result) => String(result.text ?? result.content?.[0]?.text ?? "").match(/Artifact: (\S+)/)?.[1];
const DISCOVERY = { reader_problem: "p", candidate_questions: ["q1", "q2", "q3"], surprises: ["s"], counterintuitive_findings: [], human_scale_refs: [], spatial_dimensions: [], temporal_dimensions: ["t"], mechanisms: [], uncertainties: ["u"], missing_reporting: [], kill_reasons: [] };
const FRAMES = ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal", "spatial"];
const METAPHORS = ["a river map", "a clock face", "a pipe network", "a seesaw", "a village of 100", "a market stall", "a staircase", "a compass"];
const COMMON = { reader_question: "Where do the rates stand?", editorial_premise: "Most rates are above the 2019 start.", surprise: "Only one is lower.", hero_evidence_refs: ["claim-1"], supporting_evidence_refs: ["claim-2"], asset_requirements: [{ kind: "verified_series", available: true, blocking: false }], media_mix: ["chart"], risk_flags: ["rate definitions differ"], reporting_gaps: [] };
const own = (i) => ({ concept_id: `c${i + 1}`, framing: FRAMES[i], visual_metaphor: METAPHORS[i], hero_scene: `${METAPHORS[i]} carrying the seven rates`, why_memorable: `The reader sees ${METAPHORS[i]} and remembers the one rate that fell.` });
const full = (n = 8) => Array.from({ length: n }, (_, i) => ({ ...COMMON, ...own(i) }));
const compact = (n = 8) => Array.from({ length: n }, (_, i) => own(i));

const mod = await loadTree("head");
const outside = join(makeTestTmp("asset-refs-outside-"), "secret.csv");
writeFileSync(outside, "a\n1\n");
// A run with files in several folders, a directory, a link to a file outside the run, and a staged file.
const setup = async (env, label) => {
  const tools = register(mod, env);
  const art = freshArt(label);
  for (const d of ["computations", "maps", "visualizations", "data/dir", "staging/c1"]) mkdirSync(join(art, d), { recursive: true });
  for (const f of ["computations/c.json", "maps/m.json", "visualizations/v.json", "staging/c1/f.csv"]) writeFileSync(join(art, f), "{}");
  symlinkSync(outside, join(art, "data", "link.csv"));
  symlinkSync(join(art, "staging", "c1", "f.csv"), join(art, "data", "staged-link.csv"));
  symlinkSync(join(art, "data", "dir"), join(art, "data", "dir-link"));
  const d = await tools.get("newsroom_editorial_discovery").execute("t", DISCOVERY);
  const c = await attempt(tools.get("newsroom_visual_concepts"), { discovery_ref: ref(d), concepts: full() });
  assert.ok(ref(c), JSON.stringify(c).slice(0, 300));
  const finalist = JSON.parse(readFileSync(join(art, ref(c)), "utf8")).finalists[0];
  const ask = (rows) => attempt(tools.get("newsroom_asset_requirements"), { concept_id: finalist, concept_ref: ref(c), requirements: rows });
  return { ask, art };
};
const row = (source_refs, available = true) => ({ asset_class: "historical_series", status: "required", available, purpose: "series", source_refs });
const stored = (r, art) => JSON.parse(readFileSync(join(art, ref(r)), "utf8"));

{ // on (the default): files of this run in any folder but staging/ are accepted
  const { ask, art } = await setup({}, "on");
  for (const good of ["data/x.csv", "computations/c.json", "maps/m.json", "visualizations/v.json"]) {
    const r = await ask([row([good])]);
    assert.ok(ref(r), `${good}: ${r.error}`);
  }
  const two = await ask([row(["data/x.csv", "maps/m.json"])]);
  assert.deepEqual(stored(two, art).requirements[0].source_refs, ["data/x.csv", "maps/m.json"], "the stored plan holds the resolved paths");
  check("on: data/, computations/, maps/ and visualizations/ files of the run are accepted, several refs in one row too");
  const bad = [
    ["x", "a name the model typed (A1)"], ["../outside.csv", "out of the run folder (A2)"], [outside, "an absolute path outside the run (A2)"],
    ["data/missing.csv", "a file that does not exist (A3)"], ["data/dir", "a directory (A4)"], ["data", "a directory (A4)"], ["staging/c1/f.csv", "a staged file (A5)"],
    ["data/link.csv", "a link out of the run"], ["data/staged-link.csv", "a link into staging/"], ["data/dir-link", "a link to a directory"], ["Staging/c1/f.csv", "a staged file, other letter case"], ["", "an empty string only"],
  ];
  for (const [ref_, why] of bad) {
    const r = await ask([row([ref_])]);
    assert.ok(r.error, `${why} was accepted`);
    assert.match(r.error, /available requirement 1: (could not find this artifact in the run|source_refs entry is not an artifact of this run|available requirement 1 requires source_refs)|requires source_refs/, why);
    assert.doesNotMatch(r.error, /verified|checked/i, "the refusal does not claim the source was checked");
  }
  check("on: a typed name, a path out of the run, a missing file, a directory, a staged file (any letter case) and a link out of the run, into staging/ or to a directory are each refused, saying the artifact was not found");
  const one = await ask([row(["data/x.csv", "nope"])]);
  assert.ok(one.error && /nope/.test(one.error), "one bad ref refuses the whole row (A8)");
  const second = await ask([row(["data/x.csv"]), row(["nope"])]);
  assert.match(second.error ?? "", /available requirement 2/, "the refusal names the row");
  check("on: one bad ref among good ones refuses the row, and the refusal names the row");
  const unavailable = await ask([row(["nope"], false)]);
  assert.ok(ref(unavailable), `available:false is not looked at: ${unavailable.error}`);
  check("on: an available:false row is not looked at (A7)");
}
{ // off: only exactly "0" turns it off
  const { ask } = await setup({ [SWITCH]: "0" }, "off");
  assert.ok(ref(await ask([row(["x"])])), "off: the old rule (any non-empty string)");
  const noRefs = await ask([row([])]);
  assert.match(noRefs.error ?? "", /requires source_refs/, "off: no refs is still refused");
  for (const v of ["", "false", "off", "1"]) {
    const { ask: askV } = await setup({ [SWITCH]: v }, `v${v}`);
    assert.ok((await askV([row(["x"])])).error, `"${v}" does not turn it off`);
  }
  check('off: exactly "0" restores the old rule; "", "false", "off", "1" keep the check on (A6)');
}
console.log(results.map((r) => `  PASS ${r}`).join("\n"));
console.log(`asset refs resolve: ${results.length} checks -- PASS`);
