// NEWSROOM_TOOL_ERROR_HINTS (default off, only "1" turns it on), second batch: three rules that were stated too late or twice say more.
//  1. The render's style refusal names the words the page's own profile accepts, the profiles that fit, and where the profile is set (the render has
//     no style_profile parameter; it is a field of newsroom_publication_plan).
//  2. The story_node_ids field of an infographic module says before the call when it is required.
//  3. While d3 cannot draw, the publication plan's visual_type text no longer offers the d3 types (sankey among them) next to "use plotly instead".
// Only text changes: the inputs refused are the same on and off, and off the refusal text and the tool schema are what they were. Words and versions in the
// text are read back against the resolver and the validator, not against a copy. Each mutant changes one line of product code in a temporary copy of
// runtime/pi; the run of this same file against it must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOT = process.env.K_ROOT ?? REPO;

const MUTANTS = {
  "render-hint-always": ["runtime/pi/publication.mjs", "process.env.NEWSROOM_TOOL_ERROR_HINTS==='1'?renderStyleRefusalNote", "true?renderStyleRefusalNote"],
  "render-hint-never": ["runtime/pi/publication.mjs", "process.env.NEWSROOM_TOOL_ERROR_HINTS==='1'?renderStyleRefusalNote", "false?renderStyleRefusalNote"],
  "render-check-relaxed": ["runtime/pi/publication.mjs", "if(style.status!=='PASS') {", "if(false) {"],
  "render-words-hand-copied": ["runtime/pi/style_mapping.mjs", "Allowed for ${requested}: dimensions ${own.dimensions.join(', ')}; topologies ${own.topologies.join(', ')}.", "Allowed for ${requested}: dimensions trend, rank; topologies tabular."],
  "render-fitting-hand-copied": ["runtime/pi/style_mapping.mjs", "export function renderStyleRefusalNote(profile,dimensions,topologies){const fitting=fittingProfileNames(dimensions,topologies);", "export function renderStyleRefusalNote(profile,dimensions,topologies){const fitting=['japanese_editorial'];"],
  "render-names-wrong-field": ["runtime/pi/style_mapping.mjs", "the render takes no style_profile of its own: plan again with newsroom_publication_plan and set its style_profile to one of them.", "pass style_profile as one of them."],
  "render-off-text-changed": ["runtime/pi/style_mapping.mjs", "; pass ${field} as one of them.`;}", "; use ${field} as one of them.`;}"],
  "d3-offer-always-dropped": ["runtime/pi/newsroom.ts", 'return D3_CANNOT_DRAW && process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ?', 'return D3_CANNOT_DRAW ?'],
  "d3-offer-never-dropped": ["runtime/pi/newsroom.ts", 'return D3_CANNOT_DRAW && process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ?', 'return false ?'],
  "d3-plotly-list-hand-copied": ["runtime/pi/newsroom.ts", "A plotly module takes one of: ${types.plotly.join(', ')}", "A plotly module takes one of: statistical"],
  "story-hint-always": ["runtime/pi/newsroom.ts", '...(process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? { description: storyNodeIdsRequiredText() } : {})', "...({ description: storyNodeIdsRequiredText() })"],
  "story-hint-never": ["runtime/pi/newsroom.ts", '...(process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? { description: storyNodeIdsRequiredText() } : {})', "...({})"],
  "story-versions-diverge": ["runtime/pi/infographic.mjs", 'export const STORY_NODE_IDS_REQUIRED_VERSIONS = ["1.4.0", "1.5.0"];', 'export const STORY_NODE_IDS_REQUIRED_VERSIONS = ["1.4.0", "1.5.0", "1.6.0"];'],
  "story-types-diverge": ["runtime/pi/infographic.mjs", 'export const STORY_NODE_IDS_REQUIRED_TYPES = ["visual", "illustration", "hero_stat", "text"];', 'export const STORY_NODE_IDS_REQUIRED_TYPES = ["visual", "illustration", "hero_stat", "text", "pull_quote"];'],
  "story-check-relaxed": ["runtime/pi/infographic.mjs", 'STORY_NODE_IDS_REQUIRED_TYPES.includes(module?.type) && (!Array.isArray(module.story_node_ids) || module.story_node_ids.length === 0)', "false"],
  "story-check-narrowed": ["runtime/pi/infographic.mjs", 'STORY_NODE_IDS_REQUIRED_TYPES.includes(module?.type)', '["visual","illustration","hero_stat"].includes(module?.type)'],
  "story-validator-versions-hand-copied": ["runtime/pi/infographic.mjs", "if (STORY_NODE_IDS_REQUIRED_VERSIONS.includes(spec.schema_version) && STORY_NODE_IDS_REQUIRED_TYPES", 'if (["1.4.0"].includes(spec.schema_version) && STORY_NODE_IDS_REQUIRED_TYPES'],
  "story-text-says-when": ["runtime/pi/infographic.mjs", "`Always required (at least 1 id)", "`Required (at least 1 id)"],
  "text-body-check-relaxed": ["runtime/pi/infographic.mjs", "if (!String(module.body ?? \"\").trim()) errors.push(`text module '${module.id}' requires body`);", ""],
};

const check = (name) => console.log(`  ok  ${name}`);
const withHints = (value, fn) => {
  const before = process.env.NEWSROOM_TOOL_ERROR_HINTS;
  if (value === undefined) delete process.env.NEWSROOM_TOOL_ERROR_HINTS; else process.env.NEWSROOM_TOOL_ERROR_HINTS = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_TOOL_ERROR_HINTS; else process.env.NEWSROOM_TOOL_ERROR_HINTS = before; }
};

async function main() {
  const base = pathToFileURL(join(ROOT, "runtime/pi")).href;
  const { renderPublication, inferPublicationStyleTopologies } = await import(`${base}/publication.mjs`);
  const { renderStyleRefusalNote, resolveEditorialStyle, styleVocabulary } = await import(`${base}/style_mapping.mjs`);
  const { validateInfographicSpec } = await import(`${base}/infographic.mjs`);

  // ---- 1. render style refusal ---------------------------------------------------------------------------------------------------
  const text = (id, dimension) => ({ id, type: "text", title: id, body: id, explanatory_dimension: dimension, story_node_ids: ["n1"] });
  const publication = (styleProfile, dimensions) => ({
    schema_version: "0.3.0", dek: "d", reader_question: "q", visual_thesis: "t", story_graph_ref: "x", infographic_plan_ref: "y", title: "T", language: "en",
    delivery: { mode: "html", self_contained: true, breakpoints: [1440, 390] },
    ...(styleProfile ? { style_profile: styleProfile } : {}),
    modules: dimensions.map((dimension, index) => text(`m${index + 1}`, dimension)),
  });
  const outcome = (spec, setting) => withHints(setting, () => { try { renderPublication(spec); return { ok: true }; } catch (error) { return { ok: false, message: String(error.message) }; } });
  const vocabulary = styleVocabulary();
  const profiles = Object.keys(vocabulary.profiles);
  const pool = [];
  for (const profile of profiles) for (const dimensions of [["flow", "spatial"], ["trend"], ["flow"], ["spatial", "human_scale"], ["trend", "rank"]]) pool.push([profile, dimensions]);
  const refusedSet = (setting) => pool.filter(([profile, dimensions]) => { const r = outcome(publication(profile, dimensions), setting); return !r.ok && r.message.startsWith("Style mapping blocked"); }).map(([p, d]) => `${p}|${d}`);
  const offRefused = refusedSet(undefined);
  assert.ok(offRefused.length >= 5 && offRefused.length < pool.length, "the pool has refused and accepted shapes");
  assert.deepEqual(refusedSet("1"), offRefused, "on: the same inputs are refused");
  for (const off of ["0", "", "true", "2", " 1"]) assert.deepEqual(refusedSet(off), offRefused, `switch value ${JSON.stringify(off)}: same refused set`);
  check("render style refusal: the refused set is the same on and off");

  const fitting = (dimensions, topologies) => profiles.filter((name) => resolveEditorialStyle({ requested: name, dimensions, topologies }).status === "PASS");
  const blocked = publication("analytical_precision", ["flow", "spatial"]);
  const offMessage = outcome(blocked, undefined).message;
  assert.equal(offMessage, "Style mapping blocked: dimension:flow; dimension:spatial. Profiles that fit these dimensions and topologies: japanese_editorial; pass style_profile as one of them.", "off: the text is what it was, byte for byte");
  for (const off of ["0", "", "true", "2", " 1"]) assert.equal(outcome(blocked, off).message, offMessage, `switch value ${JSON.stringify(off)} keeps the old text`);
  check("render style refusal: off text unchanged; only the exact value 1 turns the hint on");

  const onMessage = outcome(blocked, "1").message;
  const own = vocabulary.profiles.analytical_precision;
  assert.ok(onMessage.startsWith("Style mapping blocked: dimension:flow; dimension:spatial. "), onMessage);
  assert.ok(onMessage.includes(`Allowed for analytical_precision: dimensions ${own.dimensions.join(", ")}; topologies ${own.topologies.join(", ")}.`), "the words of the page's own profile, read from the registry");
  const names = /fit these dimensions and topologies: ([^;]*);/.exec(onMessage)[1].split(", ");
  assert.deepEqual(names, fitting(["flow", "spatial"], inferPublicationStyleTopologies(blocked)), "the profiles named are the ones the resolver accepts for these dimensions and topologies");
  assert.ok(names.length >= 1 && names.every((name) => profiles.includes(name)), "only registry profiles are named");
  assert.ok(onMessage.includes("the render takes no style_profile of its own: plan again with newsroom_publication_plan and set its style_profile to one of them."), "says where the profile is set");
  assert.ok(!onMessage.includes("pass style_profile as one of them"), "no longer sends the model to a parameter the render does not have");
  // Over every refused shape in the pool the profiles named are the resolver's, so a copied list that happens to match one shape is caught by another.
  const seen = new Set();
  for (const [profile, dimensions] of pool) {
    const spec = publication(profile, dimensions);
    const refusal = outcome(spec, "1");
    if (refusal.ok || !refusal.message.startsWith("Style mapping blocked")) continue;
    const listedNames = /fit these dimensions and topologies: ([^;]*);/.exec(refusal.message)[1];
    const expected = fitting(dimensions, inferPublicationStyleTopologies(spec));
    assert.equal(listedNames, expected.length ? expected.join(", ") : "none", `${profile}|${dimensions}`);
    seen.add(listedNames);
  }
  assert.ok(seen.size >= 2, "the pool reaches more than one list of fitting profiles");
  // The profile the hint recommends really renders: the render accepts it, so the advice and the check agree.
  for (const name of names) { const r = outcome(publication(name, ["flow", "spatial"]), "1"); assert.ok(r.ok || !r.message.startsWith("Style mapping blocked"), `recommended profile ${name} passes the style check`); }
  // A spec carries its profile from 0.2.0 on, so the note for no profile is read from the function: the whole vocabulary is listed.
  const bare = renderStyleRefusalNote(null, ["flow", "spatial"], inferPublicationStyleTopologies(blocked));
  assert.ok(bare.includes(`Allowed words: dimensions ${vocabulary.dimensions.join(", ")}; topologies ${vocabulary.topologies.join(", ")}.`), bare);
  assert.ok(/dimensions [^;]*\bflow\b/.test(bare) && /dimensions [^;]*\bspatial\b/.test(bare), "the words the model used are in the list");
  check("render style refusal: the hint gives the allowed words and fitting profiles (read from the registry), says where the profile is set, and the profile it recommends passes");

  // ---- 2. story_node_ids ---------------------------------------------------------------------------------------------------------
  const { storyNodeIdsRequiredText, STORY_NODE_IDS_REQUIRED_VERSIONS, STORY_NODE_IDS_REQUIRED_TYPES } = await import(`${base}/infographic.mjs`);
  const needsIds = (version, type) => {
    const spec = { schema_version: version, modules: [{ id: "m1", type }] };
    return validateInfographicSpec(spec).some((e) => e.includes("requires story_node_ids in InfographicSpec 1.4+"));
  };
  const versions = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"];
  const types = ["hero_stat", "visual", "illustration", "text", "section_header", "pull_quote"];
  const required = [];
  for (const version of versions) for (const type of types) if (needsIds(version, type)) required.push(`${version}|${type}`);
  const claimed = [];
  for (const version of STORY_NODE_IDS_REQUIRED_VERSIONS) for (const type of STORY_NODE_IDS_REQUIRED_TYPES) claimed.push(`${version}|${type}`);
  assert.deepEqual(required.sort(), claimed.sort(), "the versions and module types in the text are exactly the ones the validator requires story_node_ids for");
  assert.ok(required.length >= 4, "the validator requires it somewhere");
  assert.deepEqual(STORY_NODE_IDS_REQUIRED_VERSIONS, ["1.4.0", "1.5.0"], "the versions are pinned here on purpose: widening them is a decision, not a side effect");
  assert.deepEqual(STORY_NODE_IDS_REQUIRED_TYPES, ["visual", "illustration", "hero_stat", "text"], "the module types are pinned here on purpose");
  const sentence = storyNodeIdsRequiredText();
  assert.ok(sentence.startsWith("Always required"), "the plan tool always writes a version that requires it, so the text says always");
  for (const word of [...STORY_NODE_IDS_REQUIRED_VERSIONS, ...STORY_NODE_IDS_REQUIRED_TYPES]) assert.ok(sentence.includes(word), `the sentence names ${word}`);
  check("story_node_ids: the text names exactly the versions and module types the validator requires it for");

  // r29 of the k1568 run: the same refusal also said a text module needs body. The validator refuses it with the same words on and off.
  const noBody = { schema_version: "1.5.0", modules: [{ id: "m1", type: "text", story_node_ids: ["n1"], claim_ids: ["c1"] }] };
  for (const value of [undefined, "1"]) {
    const errors = withHints(value, () => validateInfographicSpec(noBody));
    assert.ok(errors.includes("text module 'm1' requires body"), `a text module without body is refused (hints ${value ?? "off"}): ${errors.join(" | ")}`);
  }
  check("text module without body: refused with the same words on and off");

  // The schema the tool host gets: a recording stub of typebox keeps every option object, so the description is found in the real tool definition.
  const tmp = mkdtempSync(join(tmpdir(), "k1574-"));
  try {
    cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
    cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
    const stub = (name, source) => { mkdirSync(join(tmp, "node_modules", name), { recursive: true }); writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" })); writeFileSync(join(tmp, "node_modules", name, "index.js"), source); };
    stub("typebox", "const builder = (kind) => (...args) => ({ kind, args });\nexport const Type = new Proxy({}, { get: (_, kind) => builder(kind) });\n");
    stub("@earendil-works/pi-ai", "export const StringEnum = (values, options) => ({ kind: 'enum', values, options });\n");
    const pi = join(tmp, "runtime", "pi");
    writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
    const mod = await import(pathToFileURL(join(pi, "newsroom.test-copy.mjs")).href);
    const toolsFor = (setting) => withHints(setting, () => {
      process.env.NEWSROOM_TOOL_PROFILE = "full";
      const tools = new Map();
      mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
      return tools;
    });
    const schemaOf = (setting) => { const tool = toolsFor(setting).get("newsroom_infographic_plan"); return JSON.stringify({ description: tool.description, parameters: tool.parameters }); };
    const publicationOf = (setting) => { const tool = toolsFor(setting).get("newsroom_publication_plan"); return JSON.stringify({ description: tool.description, parameters: tool.parameters }); };
    const off = schemaOf(undefined);
    const on = schemaOf("1");
    assert.ok(!off.includes(sentence), "off: the schema does not carry the sentence");
    assert.ok(on.includes(JSON.stringify(sentence).slice(1, -1)), "on: the story_node_ids field carries the sentence");
    for (const value of ["0", "", "true", "2", " 1"]) assert.equal(schemaOf(value), off, `switch value ${JSON.stringify(value)}: the schema is byte for byte the off schema`);
    assert.equal(on.split(JSON.stringify(sentence).slice(1, -1)).length - 1, 1, "once, on the module field");
    check("story_node_ids: off schema is byte-identical for every other switch value; on adds the sentence once, to the module field");

    // ---- 3. d3: the plan tool's descriptions must not offer d3 types (sankey among them) beside the sentence that says to use plotly ----
    const pubOff = publicationOf(undefined), pubOn = publicationOf("1");
    const d3Offer = /A d3 module needs one of: ([^.]*)\./;
    assert.ok(d3Offer.test(pubOff.replace(/\\"/g, '"')), "off: the visual_type description still carries the d3 offer, byte for byte as before");
    assert.ok(!d3Offer.test(pubOn), "on: no d3 offer");
    assert.ok(pubOn.includes("use type plotly instead (sankey is available as plotly)"), "on: the instruction stays");
    const plotlyList = /A plotly module takes one of: ([^;(]*?)(?: \(| ;|;)/.exec(pubOn)[1].split(", ");
    assert.ok(plotlyList.includes("sankey") && plotlyList.length >= 5, "on: the plotly list, sankey included, is still given");
    for (const value of ["0", "", "true", "2", " 1"]) assert.equal(publicationOf(value), pubOff, `switch value ${JSON.stringify(value)}: the publication plan schema is the off schema`);
    // the only difference on vs off is the d3 offer
    assert.equal(pubOn.replace(/\{"description":"Required \(non-empty\)[^"]*"\}/g, ""), pubOff.replace(/A d3 module needs one of: [^.]*\. /, ""), "on differs from off by the d3 offer only (and the accessibility sentences, tested in the nested-hints test)");
    check("d3: on drops the d3 offer from visual_type (it named sankey beside 'use plotly'); everything else, and every other switch value, is the off text");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

await main();
if (!process.env.K_MUTANT) {
  const names = Object.keys(MUTANTS);
  const results = [];
  for (const name of names) {
    const [file, from, to] = MUTANTS[name];
    const dir = mkdtempSync(join(tmpdir(), "k1574m-"));
    try {
      cpSync(join(REPO, "runtime/pi"), join(dir, "runtime/pi"), { recursive: true });
      cpSync(join(REPO, "config"), join(dir, "config"), { recursive: true });
      const path = join(dir, file);
      const source = readFileSync(path, "utf8");
      if (source.split(from).length !== 2) { console.error(`could not apply mutant ${name}: anchor occurs ${source.split(from).length - 1} times`); process.exit(2); }
      writeFileSync(path, source.replace(from, () => to));
      const run = spawnSync(process.execPath, [SELF], { env: { ...process.env, K_ROOT: dir, K_MUTANT: name }, encoding: "utf8" });
      results.push([name, run.status !== 0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  for (const [name, red] of results) console.log(`  ${red ? "red " : "GREEN"} ${name}`);
  assert.ok(results.every(([, red]) => red), "every mutant must turn the test red");
  console.log(`tool error hints (render style refusal, story_node_ids, d3 offer): PASS (${names.length} mutants red)`);
}
