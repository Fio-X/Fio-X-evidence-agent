// K882b: a plan or portable page whose modules carry type d3 is refused at the plan step while no D3 runtime ships (owner approved 10-18 morning).
// The refusal is built from D3_CANNOT_DRAW and the registered plotly list, names every d3 module at once, looks only at `type`, writes nothing, ends with the
// NEWSROOM_D3_PLAN_REFUSAL=0 switch and with the sentence itself (tied to src/runtime.rs). Mutations: each edit of the product tree must turn a check red. Offline; no model, no network.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const D3_SENTENCE = "Modules of type d3 cannot draw in this build because no D3 runtime ships; use type plotly instead (sankey is available as plotly).";
const swap = (source, from, to) => { assert.ok(source.includes(from), `fixture text missing: ${from}`); return source.replace(from, to); };
const mod = (dir, name) => import(`${pathToFileURL(join(dir, "runtime/pi", name)).href}?t=${Math.random()}`);
const embedsD3Library = (rs) => /include_(?:str|bytes)!\("[^"]*\/d3[^"\/]*\.js"\)/.test(rs);

function tree(label, edit) {
  const dir = makeTestTmp(`d3-plan-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "src/runtime.rs"), join(dir, "src/runtime.rs"));
  if (edit) edit((name, fn) => { const path = join(dir, "runtime/pi", name); writeFileSync(path, fn(readFileSync(path, "utf8"))); }, (fn) => { const path = join(dir, "src/runtime.rs"); writeFileSync(path, fn(readFileSync(path, "utf8"))); });
  return dir;
}
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

const toolOf = async (dir, name) => (await toolsOf(dir)).get(name);
const ARTIFACTS = makeTestTmp("d3-plan-artifacts-");
const run = async (tool, modules, env = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries({ NEWSROOM_ARTIFACT_DIR: ARTIFACTS, ...env })) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await tool.execute("t", { story_graph_ref: "editorial/story-graphs/none.json", infographic_plan_ref: "infographics/plans/none.json", modules }); return null; }
  catch (error) { return String(error.message); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const listing = () => JSON.stringify(readdirSync(ARTIFACTS, { recursive: true }).sort());
const mkModule = (id, type, extra = {}) => ({ id, type, ...extra });
const NAMES = ["newsroom_publication_plan", "newsroom_portable_publication"];

// Returns the list of problems of a tree (empty = every check holds).
async function problems(dir) {
  const out = [];
  const tools = await toolsOf(dir);
  const plotly = await mod(dir, "plotly_editorial.mjs");
  const d3 = await mod(dir, "d3_editorial.mjs");
  const rs = readFileSync(join(dir, "src/runtime.rs"), "utf8");
  const embeds = embedsD3Library(rs);
  for (const name of NAMES) {
    const tool = tools.get(name);
    const before = listing();
    const refused = await run(tool, [mkModule("a", "plotly"), mkModule("b", "d3"), mkModule("c", "text"), mkModule("e", "d3")]);
    const has = (needle) => String(refused ?? "").includes(needle);
    if (embeds) { if (has("type d3")) out.push(`${name}: refuses d3 although runtime.rs embeds a D3 library`); }
    else {
      // 1. refused, with the sentence, every d3 id, every plotly value
      if (!has(D3_SENTENCE)) out.push(`${name}: refusal lacks the D3_CANNOT_DRAW sentence`);
      if (!has("'b'") || !has("'e'")) out.push(`${name}: refusal does not name every d3 module`);
      if (!has("Modules to change: b, e.")) out.push(`${name}: refusal does not end with the id list`);
      // 6b. mixed plans name only the d3 modules
      if (has("'a'") || has("'c'") || /Modules to change:[^.]*\b[ac]\b/.test(String(refused))) out.push(`${name}: refusal names a module that is not d3`);
      for (const value of plotly.PLOTLY_EDITORIAL_CAPABILITIES) if (!has(value)) out.push(`${name}: refusal lacks the registered plotly value ${value}`);
      const listed = String(refused ?? "").match(/Plotly visual types you can use: ([^.]+)\./)?.[1]?.split(", ");
      if (!listed || JSON.stringify([...listed].sort()) !== JSON.stringify([...plotly.PLOTLY_EDITORIAL_CAPABILITIES].sort())) out.push(`${name}: the plotly list in the refusal != the registry`);
      // 6e. no d3 capability list
      for (const value of d3.D3_EDITORIAL_CAPABILITIES) if (!plotly.PLOTLY_EDITORIAL_CAPABILITIES.includes(value) && has(value)) out.push(`${name}: refusal lists the d3 value ${value}`);
      // 6c. nothing written
      if (listing() !== before) out.push(`${name}: the refusal left files behind`);
      // one module: singular wording still names it
      const one = await run(tool, [mkModule("only", "d3"), mkModule("t", "text")]);
      if (!String(one ?? "").includes("Modules to change: only.")) out.push(`${name}: single d3 module not named`);
    }
    // 6a. engine "d3" on a plotly module is not refused; 2. non-d3 types are not touched: same outcome as with the switch off
    for (const [label, modules] of [["plotly with engine d3", [mkModule("p", "plotly", { engine: "d3" }), mkModule("q", "text")]], ["all non-d3 types", ["plotly", "sigma", "static_svg", "stat", "text", "model"].map((t, i) => mkModule(`m${i}`, t))]]) {
      const on = await run(tool, modules), off = await run(tool, modules, { NEWSROOM_D3_PLAN_REFUSAL: "0" });
      if (on !== off) out.push(`${name}: ${label} gives another outcome with the rule on than off`);
      if (String(on ?? "").includes("type d3")) out.push(`${name}: ${label} is refused as d3`);
    }
    // 6d. switch off: the d3 input is not refused
    const off = await run(tool, [mkModule("b", "d3"), mkModule("t", "text")], { NEWSROOM_D3_PLAN_REFUSAL: "0" });
    if (String(off ?? "").includes("type d3")) out.push(`${name}: switch at 0 still refuses d3`);
    const other = await run(tool, [mkModule("b", "d3"), mkModule("t", "text")], { NEWSROOM_D3_PLAN_REFUSAL: "1" });
    if (!embeds && !String(other ?? "").includes("type d3")) out.push(`${name}: switch at 1 does not refuse d3`);
  }
  // 4. the type enum still holds d3, so old plans validate
  const planTool = tools.get(NAMES[0]);
  if (!planTool.parameters.properties.modules.items.properties.type.enum.includes("d3")) out.push("the type enum lost d3");
  // 5. tied to the embedded-library table: the refusal exists exactly while the sentence does
  const sentenceThere = String(planTool.parameters.properties.modules.items.properties.type.description ?? "").includes(D3_SENTENCE);
  if (sentenceThere === embeds) out.push("the type text and runtime.rs disagree about d3");
  return out;
}

// 7. the switch table row (checked on rows read from the table; `rows` is replaced in the mutation)
function tableProblems(rows) {
  const row = rows.find((r) => r.name === "NEWSROOM_D3_PLAN_REFUSAL");
  if (!row) return ["NEWSROOM_D3_PLAN_REFUSAL has no row in ci/switch-owners.json"];
  const out = [];
  if (row.default !== "on") out.push(`row default is ${row.default}, not on`);
  if (row.status !== "approved") out.push(`row status is ${row.status}`);
  if (!/owner approved 10-18 morning/.test(row.purpose)) out.push("row purpose lacks the approval reason");
  return out;
}

const real = await problems(tree("real"));
assert.deepEqual(real, [], `the product tree fails:\n${real.join("\n")}`);
const rows = JSON.parse(readFileSync(join(ROOT, "ci/switch-owners.json"), "utf8"));
assert.deepEqual(tableProblems(rows), []);
console.log("d3 plan refusal: real tree PASS");

const mutations = [
  ["M1 plan call removed", tree("m1", (e) => e("newsroom.ts", (s) => swap(s, "      const d3Refusal = d3RefusalFor((givenParams as any).modules);\n      if (d3Refusal) throw new Error(d3Refusal);\n", "")))],
  ["M2 portable call removed", tree("m2", (e) => e("newsroom.ts", (s) => swap(s, "      const d3Refusal = d3RefusalFor((params as any).modules);\n      if (d3Refusal) throw new Error(d3Refusal);\n", "")))],
  ["M3 condition type sigma", tree("m3", (e) => e("newsroom.ts", (s) => swap(s, 'module?.type === "d3"', 'module?.type === "sigma"')))],
  ["M4 hand-copied plotly list", tree("m4", (e) => e("newsroom.ts", (s) => swap(s, "${publicationVisualTypes().plotly.join(\", \")}", "statistical, sankey")))],
  ["M5 D3 library embedded, refusal stays", tree("m5", (e, rs) => rs((s) => `${s}\nconst _D3: &str = include_str!("../runtime/pi/d3-7.min.js");\n`))],
  ["M6 only the first d3 module is named", tree("m6", (e) => e("newsroom.ts", (s) => swap(s, '.filter((module) => module?.type === "d3").map((module) => String(module.id));', '.filter((module) => module?.type === "d3").map((module) => String(module.id)).slice(0, 1);')))],
  ["M8 engine looked at instead of type", tree("m8", (e) => e("newsroom.ts", (s) => swap(s, 'module?.type === "d3"', 'module?.type === "d3" || module?.engine === "d3"')))],
  ["M9 switch ignored", tree("m9", (e) => e("newsroom.ts", (s) => swap(s, '|| !d3PlanRefusalEnabled()', '')))],
  ["M10 switch read as opt-in", tree("m10", (e) => e("newsroom.ts", (s) => swap(s, 'NEWSROOM_D3_PLAN_REFUSAL !== "0"', 'NEWSROOM_D3_PLAN_REFUSAL === "1"')))],
  ["M11 d3 values listed", tree("m11", (e) => e("newsroom.ts", (s) => swap(s, "Plotly visual types you can use:", "Plotly visual types you can use (d3: ${[...D3_EDITORIAL_CAPABILITIES].join(', ')}):")))],
  ["M12 enum loses d3", tree("m12", (e) => e("newsroom.ts", (s) => swap(s, 'StringEnum(["plotly", "d3", "sigma", "static_svg", "stat", "text", "model"] as const', 'StringEnum(["plotly", "sigma", "static_svg", "stat", "text", "model"] as const')))],
];
for (const [label, dir] of mutations) {
  const found = await problems(dir).catch((error) => [`threw: ${error.message}`]);
  assert.ok(found.length > 0, `mutation stays green: ${label}`);
  console.log(`  red: ${label} (${found.length})`);
}
const m7 = tableProblems(rows.filter((r) => r.name !== "NEWSROOM_D3_PLAN_REFUSAL"));
assert.ok(m7.length > 0, "mutation stays green: M7 table row removed");
console.log("  red: M7 table row removed");
console.log(`d3 plan refusal: PASS (${mutations.length + 1} mutations red)`);
