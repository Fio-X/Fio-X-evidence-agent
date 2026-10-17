// The publication tools state the visual_type values the renderer accepts and how the page style is resolved (K797).
// Alignment: every value a check accepts appears in the stated list and nothing else does; each sentence is tied to its check.
// Mutations: a check that changes while the text stays, and a text that changes while the checks stay, both fail the alignment;
// text and checks changed together (the text is read from the registry) pass. Offline; no model, no network.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DECOYS = ["choropleth_map", "geo_choropleth", "world_map", "heatmap", "zz_new_value"];

function tree(label, edit) {
  const dir = makeTestTmp(`render-rules-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, "src/runtime.rs"), join(dir, "src/runtime.rs"));
  if (edit) edit((name, fn) => { const path = join(dir, "runtime/pi", name); writeFileSync(path, fn(readFileSync(path, "utf8"))); });
  return dir;
}
const editRs = (dir, fn) => { const path = join(dir, "src/runtime.rs"); writeFileSync(path, fn(readFileSync(path, "utf8"))); };
const mod = (dir, name) => import(`${pathToFileURL(join(dir, "runtime/pi", name)).href}?t=${Math.random()}`);
const message = async (fn) => { try { await fn(); } catch (error) { return String(error.message); } return null; };
const swap = (source, from, to) => { assert.ok(source.includes(from), `fixture text missing: ${from}`); return source.replace(from, to); };


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
const RENDER_PREFIX = "Resolve immutable publication bindings, reverify row hashes and sanitized assets, then render the PublicationSpec. The renderer never accepts fresh inline data. ";
const textsOf = async (dir) => {
  const tools = await toolsOf(dir);
  const render = tools.get("newsroom_publication_render");
  assert.ok(render.description.startsWith(RENDER_PREFIX), "render description keeps its first two sentences");
  return { visual: tools.get("newsroom_publication_plan").parameters.properties.modules.items.properties.visual_type.description, style: render.description.slice(RENDER_PREFIX.length) };
};
// A D3 library is embedded when runtime.rs includes a d3*.js file (d3_editorial.mjs is the editorial compiler, not a runtime).
const embedsD3Library = (rs) => /include_(?:str|bytes)!\("[^"]*\/d3[^"\/]*\.js"\)/.test(rs);
const D3_SENTENCE = "Modules of type d3 cannot draw in this build because no D3 runtime ships; use type plotly instead (sankey is available as plotly).";

// Text from textDir, checks from checkDir. Returns the list of misalignments (empty = aligned).
async function misalignments(textDir, checkDir) {
  const out = [];
  const texts = await textsOf(textDir);
  const text = texts.visual;
  const d3 = await mod(checkDir, "d3_editorial.mjs");
  const plotly = await mod(checkDir, "plotly_editorial.mjs");
  const binding = await mod(checkDir, "publication_binding.mjs");
  const publication = await mod(checkDir, "publication.mjs");
  const story = await mod(checkDir, "story_graph.mjs");

  const universe = [...new Set([...DECOYS, ...d3.D3_EDITORIAL_CAPABILITIES, ...plotly.PLOTLY_EDITORIAL_CAPABILITIES, ...binding.EVIDENCE_BOUND_PLOTLY_TYPES])];
  const acceptsD3 = async (v) => !String(await message(() => d3.compileD3EditorialScene({ visual_type: v, story_node_ids: ["n"] })) ?? "").startsWith("unsupported D3 visual_type");
  const acceptsPlotly = async (v) => !String(await message(() => plotly.compilePlotlyEditorialScene({ visual_type: v })) ?? "").startsWith("unsupported Plotly visual_type");
  const acceptsBound = async (v) => !String(await message(() => binding.buildEvidenceBoundModule({ id: "m1", type: "plotly", visual_type: v, evidence_binding: { field_mapping: {} }, view_spec: {} }, []))).includes("is unsupported");
  const accepted = async (fn, wantBoth) => { const r = []; for (const v of universe) if ((await fn(v)) && (!wantBoth || (await acceptsPlotly(v)))) r.push(v); return r; };
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const list = (re) => { const m = text.match(re); return m ? m.slice(1).map((s) => s.split(", ")) : null; };

  const stated = list(/A d3 module needs one of: ([^.]+)\. A plotly module takes one of: ([^(]+) \(statistical when omitted\); when it is bound by computation_ref only ([^.]+) are built\./);
  if (!stated) return ["the visual_type sentence has an unexpected shape"];
  const [statedD3, statedPlotly, statedBound] = stated;
  if (!same(statedD3, await accepted(acceptsD3))) out.push("d3 list != values the d3 check accepts");
  if (!same(statedPlotly, await accepted(acceptsPlotly))) out.push("plotly list != values the plotly check accepts");
  if (!same(statedBound, await accepted(acceptsBound, true))) out.push("computation-bound plotly list != values the binding builds and the plotly check accepts");
  const rs = readFileSync(join(checkDir, "src/runtime.rs"), "utf8");
  if (!rs.includes("plotly-3.3.1.min.js") || !/include_str!\("[^"]*d3_editorial\.mjs"\)/.test(rs)) out.push("runtime.rs no longer has the plotly vendor / d3_editorial embeds the D3 detection is read against");
  if (text.includes(D3_SENTENCE) === embedsD3Library(rs)) out.push(embedsD3Library(rs) ? "runtime.rs embeds a D3 library but the text still says d3 cannot draw" : "runtime.rs embeds no D3 library but the text does not say d3 cannot draw");
  if (await acceptsD3("")) out.push("a d3 module without visual_type is accepted, the text says it needs one");
  if (!(await acceptsPlotly(""))) out.push("a plotly module without visual_type is refused, the text says statistical when omitted");
  if (!statedPlotly.includes("geo_linked")) out.push("geo_linked missing from the plotly list");
  const bindingSource = readFileSync(join(checkDir, "runtime/pi/publication_binding.mjs"), "utf8");
  if (!bindingSource.includes("geo_linked requires lon/lat fields or a location_field with ISO-3 codes")) out.push("the geo_linked field sentence no longer matches the binding check");

  // Style sentence: each dimension's topology is asked of the render check's own function.
  const styleText = texts.style;
  const named = styleText.match(/explanatory_dimension \(([^)]*); every other dimension -> tabular; stat and text modules are skipped\)/);
  if (!named) return [...out, "the style sentence has an unexpected shape"];
  const claimed = new Map();
  for (const part of named[1].split("; ")) { const [dims, topology] = part.split(" -> "); for (const d of dims.split("/")) claimed.set(d, topology); }
  for (const dimension of story.PUBLICATION_DIMENSIONS) {
    const [actual] = publication.inferPublicationStyleTopologies({ modules: [{ type: "plotly", explanatory_dimension: dimension }] });
    if ((claimed.get(dimension) ?? "tabular") !== actual) out.push(`dimension ${dimension}: text says ${claimed.get(dimension) ?? "tabular"}, check gives ${actual}`);
  }
  for (const d of claimed.keys()) if (!story.PUBLICATION_DIMENSIONS.includes(d)) out.push(`dimension ${d} is not a publication dimension`);
  for (const type of ["stat", "text"]) {
    if (publication.inferPublicationStyleTopologies({ modules: [{ type, explanatory_dimension: "flow" }] }).join() !== "tabular") out.push(`a ${type} module is not skipped`);
  }
  const publicationSource = readFileSync(join(checkDir, "runtime/pi/publication.mjs"), "utf8");
  if (!publicationSource.includes("Style mapping blocked")) out.push('the refusal "Style mapping blocked" is gone from the render check');
  if (!styleText.includes('"Style mapping blocked"')) out.push("the style sentence does not name the refusal");
  return out;
}

const base = tree("base");
// 1. Alignment on the real code.
assert.deepEqual(await misalignments(base, base), [], "real code is aligned");
console.log("alignment: PASS (d3, plotly, computation-bound plotly, geo_linked, omitted visual_type, dimension -> topology, refusal name)");

// 2. Mutations. Each must be caught.
const caught = [];
const expectRed = async (label, textDir, checkDir, needle) => {
  const found = await misalignments(textDir, checkDir);
  assert.ok(found.some((m) => m.includes(needle)), `mutation not caught: ${label} (got: ${found.join(" | ") || "aligned"})`);
  caught.push(label);
};
// 2a. A value is added to the d3 registry (the check accepts it) while the text stays as it was.
const d3Added = tree("d3-added", (edit) => edit("d3_editorial.mjs", (s) => swap(s, "const TYPES=new Set(['radial_network'", "const TYPES=new Set(['zz_new_value','radial_network'")));
await expectRed("d3 value added to the registry, text unchanged", base, d3Added, "d3 list");
// 2b. The same registry change with the text read from the same tree: the text follows, aligned.
assert.deepEqual(await misalignments(d3Added, d3Added), [], "text follows the registry");
assert.match((await textsOf(d3Added)).visual, /zz_new_value/);
caught.push("d3 value added to the registry, text read from it: stays aligned and shows the value");
// 2c. A value is removed from the text only.
const d3Dropped = tree("d3-dropped", (edit) => edit("newsroom.ts", (s) => swap(s, "d3: [...D3_EDITORIAL_CAPABILITIES]", "d3: [...D3_EDITORIAL_CAPABILITIES].slice(1)")));
await expectRed("d3 value deleted from the text only", d3Dropped, base, "d3 list");
// 2d. Plotly registry gains a value; text unchanged.
const plotlyAdded = tree("plotly-added", (edit) => edit("plotly_editorial.mjs", (s) => swap(s, "const TYPES=new Set(['statistical'", "const TYPES=new Set(['zz_new_value','statistical'")));
await expectRed("plotly value added to the registry, text unchanged", base, plotlyAdded, "plotly list");
// 2e. The binding stops building a type that the text lists (branch for treemap/sunburst/icicle removed from the accepted set).
const boundDropped = tree("bound-dropped", (edit) => edit("publication_binding.mjs", (s) => swap(s, "else if(['treemap','sunburst','icicle'].includes(type))", "else if(['treemap','sunburst'].includes(type))")));
await expectRed("binding stops building icicle, text unchanged", base, boundDropped, "computation-bound");
// 2f. The binding gains a type; the exported list is not updated (the list the text reads is stale).
const boundAdded = tree("bound-added", (edit) => edit("publication_binding.mjs", (s) => swap(s, "else if(['treemap','sunburst','icicle'].includes(type))", "else if(['treemap','sunburst','icicle','scattergl'].includes(type))")));
await expectRed("binding builds scattergl, exported list stale", boundAdded, boundAdded, "computation-bound");
// 2g. A dimension changes topology in the render check; the text stays.
const topologyChanged = tree("topology", (edit) => edit("publication.mjs", (s) => swap(s, "else if(d==='flow')out.add('flow_edges')", "else if(d==='flow')out.add('graph_edges')")));
await expectRed("flow dimension mapped to another topology, text unchanged", base, topologyChanged, "dimension flow");
// 2i. The refusal name disappears from the render check.
const refusalGone = tree("refusal", (edit) => edit("publication.mjs", (s) => swap(s, "Style mapping blocked", "Style mapping stopped")));
await expectRed("refusal renamed in the render check", base, refusalGone, "Style mapping blocked");
// 2j. K821: a D3 library is added to the embed list while the text still says d3 cannot draw.
const D3_EMBED = 'const D3_VENDOR_RUNTIME: &str = include_str!("../runtime/pi/vendor/d3-7.9.0.min.js");\n';
const embedAdded = tree("d3-embed", () => {});
editRs(embedAdded, (rs) => swap(rs, "const PLOTLY_VENDOR_RUNTIME", D3_EMBED + "const PLOTLY_VENDOR_RUNTIME"));
await expectRed("D3 library embed added, text still says d3 cannot draw", base, embedAdded, "embeds a D3 library but the text still says");
// 2k. The sentence is removed from the text while no D3 library is embedded.
const sentenceGone = tree("sentence-gone", (edit) => edit("newsroom.ts", (s) => swap(s, "Modules of type d3 cannot draw in this build because no D3 runtime ships; use type plotly instead (sankey is available as plotly). ", "")));
await expectRed("sentence removed while no D3 library is embedded", sentenceGone, base, "does not say d3 cannot draw");
// 2l. Embed added and the sentence removed together: aligned (the test demands the sentence be removed, and it is).
const embedAndSentence = tree("d3-embed-sentence", (edit) => edit("newsroom.ts", (s) => swap(s, "Modules of type d3 cannot draw in this build because no D3 runtime ships; use type plotly instead (sankey is available as plotly). ", "")));
editRs(embedAndSentence, (rs) => swap(rs, "const PLOTLY_VENDOR_RUNTIME", D3_EMBED + "const PLOTLY_VENDOR_RUNTIME"));
assert.deepEqual(await misalignments(embedAndSentence, embedAndSentence), [], "embed + sentence removed is aligned");
caught.push("D3 library embed added and sentence removed together: aligned");
console.log(`mutations: PASS (${caught.length} caught)`);
for (const label of caught) console.log(`  caught: ${label}`);

// 3. The tools carry exactly these sentences and nothing else changed in the two descriptions / the visual_type field.
const tools = await toolsOf(tree("wired"));
const texts = await textsOf(tree("wired2"));
const plan = tools.get("newsroom_publication_plan"), render = tools.get("newsroom_publication_render");
const moduleProps = plan.parameters.properties.modules.items.properties;
assert.equal(moduleProps.visual_type.description, texts.visual);
assert.equal(moduleProps.visual_type.type, "string", "visual_type stays a plain string (no enum)");
assert.ok(moduleProps.visual_type.__optional, "visual_type stays optional");
assert.equal(render.description, RENDER_PREFIX + texts.style);
assert.deepEqual(render.parameters, { type: "object", properties: { plan_ref: { type: "string" } }, required: ["plan_ref"] }, "render parameters unchanged");
console.log("tool wiring: PASS (visual_type description and render description carry the sentences; schema shape unchanged)");
