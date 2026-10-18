// Field descriptions (K869, infographic half; kept as a patch, not committed): quality_target, modules[].emphasis, explanatory_dimension, reader_question_id.
// Each description gives the allowed values and what an omitted field does; the text is read against the constants and functions the
// code itself uses. Mutations: a default changed while the text stays (red), a text changed while the code stays (red), a handler that
// bypasses the constant (red). Offline; no model, no network.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function tree(label, edit) {
  const dir = makeTestTmp(`field-defaults-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "src/runtime.rs"), join(dir, "src/runtime.rs"));
  if (edit) edit((name, fn) => { const path = join(dir, "runtime/pi", name); writeFileSync(path, fn(readFileSync(path, "utf8"))); });
  return dir;
}
const mod = (dir, name) => import(`${pathToFileURL(join(dir, "runtime/pi", name)).href}?t=${Math.random()}`);
const swap = (source, from, to) => { assert.ok(source.includes(from), `fixture text missing: ${from}`); return source.replace(from, to); };
const read = (dir, name) => readFileSync(join(dir, "runtime/pi", name), "utf8");

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
// The tool definitions newsroom.ts registers in a tree (the text builders live in newsroom.ts, so the text is read from the tools).
async function toolsOf(dir) {
  const stub = (name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  stub("typebox", TYPEBOX);
  stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  writeFileSync(join(dir, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  const tools = new Map();
  (await mod(dir, "newsroom.test-copy.mjs")).default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}


const textsOf = async (dir) => {
  const plan = (await toolsOf(dir)).get("newsroom_infographic_plan").parameters.properties;
  const mod0 = plan.modules.items.properties;
  return { quality: plan.quality_target.description ?? "", qualityEnum: plan.quality_target.enum, emphasis: mod0.emphasis.description ?? "", emphasisEnum: mod0.emphasis.enum,
    dim: mod0.explanatory_dimension.description ?? "", rq: mod0.reader_question_id.description ?? "" };
};
async function misalignments(textDir, checkDir) {
  const out = [];
  const t = await textsOf(textDir);
  const ig = await mod(checkDir, "infographic.mjs");
  const igSource = read(checkDir, "infographic.mjs");
  const newsroomSource = read(checkDir, "newsroom.ts");

  // quality_target: both thresholds from the table the critic reads; default from the constant
  const q = t.quality.match(/^Quality bar \((.+); award also adds further checks\); when omitted: (\w+)\.$/);
  if (!q) out.push("the quality_target sentence has an unexpected shape");
  else {
    const stated = Object.fromEntries(q[1].split("; ").map((r) => { const m = r.match(/^(\w+): critic score at least (\d+) and every rubric dimension at least (\d+)$/); return m ? [m[1], { pass: +m[2], dimension_floor: +m[3] }] : ["?", {}]; }));
    if (JSON.stringify(stated) !== JSON.stringify(ig.INFOGRAPHIC_QUALITY_THRESHOLDS)) out.push("quality_target thresholds in the text != the table");
    if (JSON.stringify(Object.keys(ig.INFOGRAPHIC_QUALITY_THRESHOLDS)) !== JSON.stringify(t.qualityEnum)) out.push("quality_target enum != the threshold table keys");
    if (q[2] !== ig.INFOGRAPHIC_DEFAULT_QUALITY_TARGET) out.push(`quality_target default: text says ${q[2]}, constant is ${ig.INFOGRAPHIC_DEFAULT_QUALITY_TARGET}`);
    if (!t.qualityEnum.includes(q[2])) out.push("quality_target default is not an allowed value");
  }
  if (!igSource.includes('INFOGRAPHIC_QUALITY_THRESHOLDS[spec.quality_target === "award" ? "award" : INFOGRAPHIC_DEFAULT_QUALITY_TARGET]')) out.push("the critic no longer reads its bar from the threshold table");
  if (!/pass\)?\s*[<>]=?|bar\.pass/.test(igSource) || !igSource.includes("bar.dimension_floor")) out.push("the critic no longer uses bar.pass and bar.dimension_floor");
  if (newsroomSource.split("params.quality_target ?? INFOGRAPHIC_DEFAULT_QUALITY_TARGET").length < 2 || newsroomSource.split("params?.quality_target ?? INFOGRAPHIC_DEFAULT_QUALITY_TARGET").length < 2) out.push("a plan handler no longer defaults quality_target to the constant");

  // emphasis: default from the constant; only hero is read by the runtime
  const e = t.emphasis.match(/^Layout and checks look only at whether the value is hero\. When omitted, the step that fills hero stats treats the module as (\w+); elsewhere an omitted value just means not hero\.$/);
  if (!e) out.push("the emphasis sentence has an unexpected shape");
  else {
    if (e[1] !== ig.INFOGRAPHIC_DEFAULT_EMPHASIS) out.push(`emphasis default: text says ${e[1]}, constant is ${ig.INFOGRAPHIC_DEFAULT_EMPHASIS}`);
    if (!t.emphasisEnum.includes(e[1])) out.push("emphasis default is not an allowed value");
  }
  for (const [name, src] of [["infographic.mjs", igSource], ["newsroom.ts", newsroomSource], ["editorial_validators.mjs", read(checkDir, "editorial_validators.mjs")]]) {
    const other = src.match(/emphasis\s*[!=]==?\s*["'](primary|secondary|support)["']/);
    if (other) out.push(`emphasis: ${name} reads a value other than hero (${other[0]}), the text says only hero matters`);
  }
  const emphasisHandlers = newsroomSource.split("emphasis: module.emphasis ?? INFOGRAPHIC_DEFAULT_EMPHASIS").length - 1;
  if (emphasisHandlers < 3) out.push(`emphasis: ${emphasisHandlers} of 3 handlers default to the constant`);

  // explanatory_dimension / reader_question_id: the comparison inputs and the skip behaviour
  const n = (txt) => txt.match(/^Used only when the lean gate is on \(NEWSROOM_LEAN_GATES=1\) and schema_version is 1\.4\.0 or 1\.5\.0: a module without (.+) is left out of the semantic-novelty comparison and counted in a note\.$/);
  for (const [label, txt] of [["explanatory_dimension", t.dim], ["reader_question_id", t.rq]]) {
    const m = n(txt);
    if (!m) { out.push(`the ${label} sentence has an unexpected shape`); continue; }
    if (m[1] !== ig.SEMANTIC_NOVELTY_INPUTS.join(", ")) out.push(`${label}: inputs in the text != SEMANTIC_NOVELTY_INPUTS`);
  }
  if (!igSource.includes('if (leanGatesEnabled() && ["1.4.0", "1.5.0"].includes(spec.schema_version)) {\n    const novelty = semanticNoveltyFindings(spec.modules);')) out.push("novelty: the call is no longer limited to the lean gate and schema 1.4.0/1.5.0, the text says it is");
  if (ig.leanGatesEnabled({ NEWSROOM_LEAN_GATES: "1" }) !== true || ig.leanGatesEnabled({}) !== false) out.push("novelty: the lean gate is no longer NEWSROOM_LEAN_GATES=1");
  if (!newsroomSource.split("fillHeroModules(").slice(1).length) out.push("emphasis: the hero-fill step is gone");
  const full = { id: "m1", type: "visual", reader_question_id: "q1", claim_id: "c1", new_information: "x", explanatory_dimension: "flow" };
  const probe = (m2) => ig.semanticNoveltyFindings([m2, { ...m2, id: "m2" }]).notes.join(" ");
  if (probe(full).includes("were not compared")) out.push("novelty: a module with all the inputs is skipped");
  for (const [field, drop] of [["reader_question_id", { reader_question_id: undefined }], ["claim set", { claim_id: undefined }], ["new_information", { new_information: undefined }], ["explanatory_dimension", { explanatory_dimension: undefined }]]) {
    if (!ig.SEMANTIC_NOVELTY_INPUTS.includes(field)) out.push(`novelty: ${field} is not in SEMANTIC_NOVELTY_INPUTS`);
    if (!probe({ ...full, ...drop }).includes("were not compared")) out.push(`novelty: a module without ${field} is no longer left out and noted`);
  }
  return out;
}

const base = tree("base");
assert.deepEqual(await misalignments(base, base), [], "real code is aligned");
console.log("alignment: PASS (quality_target, emphasis, explanatory_dimension, reader_question_id)");
const caught = [];
const expectRed = async (label, textDir, checkDir, needle) => {
  const found = await misalignments(textDir, checkDir);
  assert.ok(found.some((m) => m.includes(needle)), `mutation not caught: ${label} (got: ${found.join(" | ") || "aligned"})`);
  caught.push(label);
};
const edit = (label, name, from, to) => tree(label, (e) => e(name, (s) => swap(s, from, to)));
await expectRed("award threshold changed, text unchanged", base, edit("q-award", "infographic.mjs", "award: { pass: 92,", "award: { pass: 90,"), "thresholds");
await expectRed("publishable floor changed, text unchanged", base, edit("q-floor", "infographic.mjs", "dimension_floor: 72", "dimension_floor: 70"), "thresholds");
await expectRed("quality default changed, text unchanged", base, edit("q-default", "infographic.mjs", 'INFOGRAPHIC_DEFAULT_QUALITY_TARGET = "publishable"', 'INFOGRAPHIC_DEFAULT_QUALITY_TARGET = "award"'), "quality_target default");
await expectRed("quality text changed, code unchanged", edit("q-text", "newsroom.ts", "; award also adds further checks);", "; award adds nothing);"), base, "unexpected shape");
await expectRed("critic bypasses the table", base, edit("q-bypass", "infographic.mjs", 'INFOGRAPHIC_QUALITY_THRESHOLDS[spec.quality_target === "award" ? "award" : INFOGRAPHIC_DEFAULT_QUALITY_TARGET]', '({ pass: 88, dimension_floor: 72 })'), "no longer reads its bar");
await expectRed("quality handler hard-codes the default", base, edit("q-hard", "newsroom.ts", "quality_target: params.quality_target ?? INFOGRAPHIC_DEFAULT_QUALITY_TARGET,", 'quality_target: params.quality_target ?? "publishable",'), "no longer defaults quality_target");
await expectRed("emphasis default changed, text unchanged", base, edit("e-default", "infographic.mjs", 'INFOGRAPHIC_DEFAULT_EMPHASIS = "secondary"', 'INFOGRAPHIC_DEFAULT_EMPHASIS = "support"'), "emphasis default");
await expectRed("runtime starts reading another emphasis value", base, edit("e-other", "infographic.mjs", 'module.emphasis === "hero" ? 0.42 : 0.52', 'module.emphasis === "support" ? 0.3 : 0.52'), "other than hero");
await expectRed("emphasis handler hard-codes the default", base, edit("e-hard", "newsroom.ts", "emphasis: module.emphasis ?? INFOGRAPHIC_DEFAULT_EMPHASIS", 'emphasis: module.emphasis ?? "secondary"'), "handlers default");
await expectRed("novelty call no longer gated on schema 1.4.0/1.5.0", base, edit("n-gate", "infographic.mjs", 'if (leanGatesEnabled() && ["1.4.0", "1.5.0"].includes(spec.schema_version)) {\n    const novelty', 'if (leanGatesEnabled() && ["1.4.0", "1.5.0", "1.6.0"].includes(spec.schema_version)) {\n    const novelty'), "no longer limited");
await expectRed("novelty input list changed, text unchanged", base, edit("n-list", "infographic.mjs", 'SEMANTIC_NOVELTY_INPUTS = ["reader_question_id", "claim set", "new_information", "explanatory_dimension"]', 'SEMANTIC_NOVELTY_INPUTS = ["reader_question_id", "claim set", "new_information"]'), "SEMANTIC_NOVELTY_INPUTS");
await expectRed("novelty check stops requiring explanatory_dimension", base, edit("n-skip", "infographic.mjs", " || !m.explanatory_dimension) continue;", ") continue;"), "without explanatory_dimension");
console.log(`mutations: PASS (${caught.length} caught)`);
for (const label of caught) console.log(`  caught: ${label}`);
