// symbol_map and the grammar tables (K1055): unless NEWSROOM_SYMBOL_MAP is exactly 0 the chart form symbol_map is allowed under visual_grammar 'spatial' (page lint, both
// sites of infographic.mjs) and under the strict claim relation 'geography' (newsroom.ts STRICT_GRAMMAR_FORMS), from ONE gate read at module load (on unless exactly "0"; tile_map stays exact "1",
// SYMBOL_MAP_GRAMMAR_ON, the same moment as tile_map): the page table, the strict table and the chart_type enum cannot be on while another is off.
// Nothing else widens. The expected sets below are written by hand, they are not read from the source. TEST FIXTURE data.
// Run: node scripts/test_symbol_map_grammar.mjs   (the worker mode is internal)
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const GRAMMARS = ["rank", "change", "trend", "anomaly", "benchmark", "composition", "distribution", "relationship", "uncertainty", "flow", "spatial", "network", "mechanism", "sequence"];
const FORMS = ["symbol_map", "choropleth", "tile_map", "horizontal_bar"];
// every relation the strict table governs, plus ones it does not (a relation it does not govern accepts any form, as before)
const RELATIONS = ["rank", "comparison", "change", "trend", "anomaly", "benchmark", "relationship", "flow", "geography", "network", "composition", "distribution", "correlation", "uncertainty"];

// ---------------------------------------------------------------------------------------------------- hand-written expectations
// page table: the grammars each form is accepted under, per switch state
const PAGE_BASE = { symbol_map: [], choropleth: ["spatial"], tile_map: [], horizontal_bar: ["rank", "benchmark", "composition"] };
const pageExpected = ({ symbol, tile }) => ({ ...PAGE_BASE, symbol_map: symbol ? ["spatial"] : [], tile_map: tile ? ["spatial"] : [] });
// strict table: the relations each form is accepted under (a form is accepted under every ungoverned relation too)
const UNGOVERNED = ["composition", "distribution", "correlation", "uncertainty"];
const STRICT_BASE = {
  symbol_map: [],
  choropleth: ["geography"],
  tile_map: [],
  horizontal_bar: ["rank", "comparison"],
};
const strictExpected = ({ symbol, tile }) => {
  const table = { ...STRICT_BASE, symbol_map: symbol ? ["geography"] : [], tile_map: tile ? ["comparison", "change", "trend", "geography"] : [] };
  return Object.fromEntries(Object.entries(table).map(([form, rel]) => [form, [...rel, ...UNGOVERNED].sort()]));
};

// ---------------------------------------------------------------------------------------------------- worker
// env is set by the driver before the process starts ("early"), or by the worker after infographic.mjs is imported ("late": the gate must not move)
if (process.argv[2] === "worker") {
  await worker(process.argv[3]);
  process.exit(0);
}

async function worker(mode) {
  const rt = process.env.GRAM_RT ?? ROOT;
  const lateEnv = mode === "late" ? JSON.parse(process.env.GRAM_LATE_ENV ?? "{}") : {};
  const info = await import(join(rt, "runtime/pi/infographic.mjs"));
  // the product's own gate: newsroom.ts's ACTIVE_GRAMMAR_FORMS and SYMBOL_MAP_GRAMMAR_ON, cut out of the source and evaluated now, when the runtime loads (before any late env)
  const source = readFileSync(join(rt, "runtime/pi/newsroom.ts"), "utf8");
  const gateAt = source.indexOf("const ACTIVE_GRAMMAR_FORMS = Object.freeze(");
  const gateLine = source.indexOf("const SYMBOL_MAP_GRAMMAR_ON =", gateAt);
  assert.ok(gateAt >= 0 && gateLine > gateAt, "newsroom.ts's active grammar set and its symbol_map gate are found");
  const gateCode = stripTypeScriptTypes(source.slice(gateAt, source.indexOf("\n", gateLine) + 1), { mode: "strip" });
  const { gatedFormOn } = await import(join(rt, "runtime/pi/symbol_map_switch.mjs"));
  const newsGate = new Function("VISUAL_GRAMMAR_FORMS", "gatedFormOn", `${gateCode}\nreturn SYMBOL_MAP_GRAMMAR_ON;`)(info.VISUAL_GRAMMAR_FORMS, gatedFormOn);
  const mapAt = source.indexOf("const STRICT_GRAMMAR_FORMS");
  const endAt = source.indexOf("// With the hold on, the refusal names only the forms", mapAt);
  assert.ok(mapAt >= 0 && endAt > mapAt, "the strict table and the line that adds symbol_map are found in newsroom.ts");
  const code = stripTypeScriptTypes(source.slice(mapAt, endAt), { mode: "strip" });
  const { assertEditorialGrammar } = new Function("SYMBOL_MAP_GRAMMAR_ON", `${code}\nreturn { assertEditorialGrammar };`)(newsGate);
  Object.assign(process.env, lateEnv); // after the import and the product's own load: a load-time gate does not see it
  const REFUSED = /is incompatible with chart_type|unsupported module visual_grammar/;
  const story = { reader_question: "q", visual_thesis: "t", nodes: [], edges: [], entry_node_ids: [], answer_node_ids: [] };
  const visualModule = (grammar) => ({ id: "v", type: "visual", manifest_ref: "m.json", visual_grammar: grammar, story_node_ids: [], span: "full" });
  const sites = {
    synthesis: (grammar, chartType) => info.evaluateInfographicSynthesis(
      { schema_version: "1.4.0", reader_question: "q", visual_thesis: "t", modules: [visualModule(grammar)] },
      { "m.json": { manifest: { chart_type: chartType } } }, story).blockers,
    ...Object.fromEntries(["1.4.0", "1.5.0"].map((version) => [`lint ${version}`, (grammar, chartType) => info.lintInfographicSpec(
      { schema_version: version, language: "en", reader_question: "q", visual_thesis: "t", modules: [visualModule(grammar)] },
      { "m.json": { desktopSvg: "<svg/>", mobileSvg: "<svg/>", manifest: { chart_type: chartType, language: "en" } } },
      { mobile_pages: false }).blockers])),
  };
  const page = {};
  for (const [site, blockersFor] of Object.entries(sites)) {
    page[site] = {};
    for (const form of FORMS) page[site][form] = GRAMMARS.filter((grammar) => !blockersFor(grammar, form).some((b) => REFUSED.test(b)));
  }
  // the strict path: the real STRICT_GRAMMAR_FORMS and assertEditorialGrammar built above, driven with newsroom.ts's own gate
  const strict = {};
  for (const form of FORMS) {
    strict[form] = RELATIONS.filter((relation) => {
      try {
        assertEditorialGrammar({ enforcement: "strict", status: "PASS", claim_spec: { relation } }, form);
        return true;
      } catch (error) {
        assert.match(String(error.message), /^EDITORIAL_GRAMMAR_BLOCKED/, `${relation}/${form}: only the grammar block may refuse`);
        return false;
      }
    }).sort();
  }
  process.stdout.write(JSON.stringify({ gate: info.SYMBOL_MAP_GRAMMAR_ON, news_gate: newsGate, page, strict }));
}

// ---------------------------------------------------------------------------------------------------- driver
function run(mode, env, rt) {
  const clean = { ...process.env };
  for (const k of ["NEWSROOM_SYMBOL_MAP", "NEWSROOM_TILE_MAP", "GRAM_RT", "GRAM_LATE_ENV"]) delete clean[k];
  const tmp = makeTestTmp("symbol-map-grammar-proc-");
  const early = mode === "late" ? {} : env;
  const r = spawnSync(process.execPath, ["--no-warnings", SELF, "worker", mode], {
    env: { ...clean, TMPDIR: tmp, ...early, ...(rt ? { GRAM_RT: rt } : {}), ...(mode === "late" ? { GRAM_LATE_ENV: JSON.stringify(env) } : {}) }, encoding: "utf8",
  });
  return r;
}
const failure = (r) => `${r.stderr || r.stdout}`.split("\n").filter(Boolean).slice(0, 6).join(" | ").slice(0, 600);

// the observation of one process against the hand-written sets: returns the list of differences (empty = as expected)
function differences(observed, state, label) {
  const bad = [];
  const page = pageExpected(state);
  const strict = strictExpected(state);
  if (observed.gate !== state.symbol) bad.push(`${label}: SYMBOL_MAP_GRAMMAR_ON is ${observed.gate}, expected ${state.symbol}`);
  if (observed.news_gate !== state.symbol) bad.push(`${label}: newsroom.ts SYMBOL_MAP_GRAMMAR_ON is ${observed.news_gate}, expected ${state.symbol}`);
  if (observed.news_gate !== observed.gate) bad.push(`${label}: newsroom.ts gate ${observed.news_gate} differs from infographic.mjs gate ${observed.gate}`);
  for (const [site, forms] of Object.entries(observed.page)) for (const form of FORMS) {
    if (JSON.stringify(forms[form]) !== JSON.stringify(GRAMMARS.filter((g) => page[form].includes(g)))) bad.push(`${label}: page ${site} ${form} accepted under ${JSON.stringify(forms[form])}`);
  }
  for (const form of FORMS) if (JSON.stringify(observed.strict[form]) !== JSON.stringify(strict[form])) bad.push(`${label}: strict ${form} accepted under ${JSON.stringify(observed.strict[form])}`);
  return bad;
}

// (state, how the env gets there). "late" = set after infographic.mjs is imported: the gate is read at load, so it stays as if unset, which is now ON (test 4, same as tile_map)
const CASES = [
  ["off: exactly 0", "early", { NEWSROOM_SYMBOL_MAP: "0" }, { symbol: false, tile: false }],
  ["on: nothing set", "early", {}, { symbol: true, tile: false }],
  ["on: not the exact off value (true)", "early", { NEWSROOM_SYMBOL_MAP: "true" }, { symbol: true, tile: false }],
  ["on: empty", "early", { NEWSROOM_SYMBOL_MAP: "" }, { symbol: true, tile: false }],
  ["on: space before the 0", "early", { NEWSROOM_SYMBOL_MAP: " 0" }, { symbol: true, tile: false }],
  ["on: 00", "early", { NEWSROOM_SYMBOL_MAP: "00" }, { symbol: true, tile: false }],
  ["on: symbol_map only", "early", { NEWSROOM_SYMBOL_MAP: "1" }, { symbol: true, tile: false }],
  ["tile_map only: tile_map unchanged (strict 1), symbol_map on by default", "early", { NEWSROOM_TILE_MAP: "1" }, { symbol: true, tile: true }],
  ["tile_map true: tile_map stays off (strict 1)", "early", { NEWSROOM_TILE_MAP: "true" }, { symbol: true, tile: false }],
  ["symbol 0, tile 1: only tile_map", "early", { NEWSROOM_SYMBOL_MAP: "0", NEWSROOM_TILE_MAP: "1" }, { symbol: false, tile: true }],
  ["both on", "early", { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_TILE_MAP: "1" }, { symbol: true, tile: true }],
  ["late: symbol switch set to 0 after import has no effect", "late", { NEWSROOM_SYMBOL_MAP: "0" }, { symbol: true, tile: false }],
];
function runAll(rt) {
  const bad = [];
  for (const [label, mode, env, state] of CASES) {
    const r = run(mode, env, rt);
    if (r.status !== 0) { bad.push(`${label}: worker failed: ${failure(r)}`); continue; }
    bad.push(...differences(JSON.parse(r.stdout), state, label));
  }
  return bad;
}

const real = runAll(null);
assert.deepEqual(real, [], `the grammar tables must match the hand-written sets:\n${real.join("\n")}`);
console.log(`symbol_map grammar: ${CASES.length} switch states x 4 forms x (3 page sites + strict table) -- PASS`);

// the three consumers take the one gate: source-level pins (the chart_type enum cannot be run without the tool host, so its read is pinned in the text)
const NEWS = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const INFO = readFileSync(join(ROOT, "runtime/pi/infographic.mjs"), "utf8");
assert.equal(NEWS.split("process.env.NEWSROOM_SYMBOL_MAP").length - 1, 0, "newsroom.ts reads the switch only through its own gate constant, never by itself");
assert.equal(NEWS.split('...(SYMBOL_MAP_GRAMMAR_ON ? ["symbol_map"] : [])').length - 1, 1, "the chart_type enum takes symbol_map from the shared gate");
assert.equal(NEWS.split('if (SYMBOL_MAP_GRAMMAR_ON) STRICT_GRAMMAR_FORMS.geography.push("symbol_map");').length - 1, 1, "the strict table takes symbol_map from the shared gate");
assert.equal(INFO.split("export const SYMBOL_MAP_GRAMMAR_ON = ACTIVE_GRAMMAR_FORMS.spatial.has(\"symbol_map\");").length - 1, 1, "the shared gate is the page table's own active set");
assert.equal(NEWS.split('const SYMBOL_MAP_GRAMMAR_ON = (ACTIVE_GRAMMAR_FORMS as any).spatial.has("symbol_map");').length - 1, 1, "newsroom.ts derives its gate from its own active set, so a fresh load of newsroom.ts re-reads the switch together with its page table");
// no code chooses a grammar from a chart type by reverse lookup in these tables: the readers are the two lint sites, the contract text and the strict checks
for (const [file, text] of [["infographic.mjs", INFO], ["newsroom.ts", NEWS]]) {
  assert.ok(!/Object\.entries\((?:ACTIVE_|STRICT_)?(?:VISUAL_|GRAMMAR_)?[A-Z_]*GRAMMAR_FORMS\)[^;\n]*\.find\(/.test(text), `${file}: no reverse lookup that picks one grammar`);
}
console.log("symbol_map grammar: one gate per file pinned equal, three readers, no reverse pick -- PASS");

// mutants: each one must turn at least one case red
const MUTANTS = [
  ["gate entry removed from the page table", [{ file: "infographic.mjs", from: ', symbol_map: "NEWSROOM_SYMBOL_MAP" })', to: " })" }]],
  ["page table gated by the wrong switch", [{ file: "infographic.mjs", from: 'symbol_map: "NEWSROOM_SYMBOL_MAP"', to: 'symbol_map: "NEWSROOM_TILE_MAP"' }]],
  ["symbol_map in the always-on spatial set (not gated)", [{ file: "infographic.mjs", from: 'spatial: new Set(["geo_flow_map", "cartographic_flow_map", "choropleth"]),', to: 'spatial: new Set(["geo_flow_map", "cartographic_flow_map", "choropleth", "symbol_map"]),' }]],
  ["spatial widened by the same switch (bar allowed)", [{ file: "infographic.mjs", from: 'symbol_map: "NEWSROOM_SYMBOL_MAP"', to: 'symbol_map: "NEWSROOM_SYMBOL_MAP", horizontal_bar: "NEWSROOM_SYMBOL_MAP"' }]],
  ["shared gate always on", [{ file: "infographic.mjs", from: 'ACTIVE_GRAMMAR_FORMS.spatial.has("symbol_map");', to: "true;" }]],
  ["shared gate never on (strict table never gets symbol_map)", [{ file: "infographic.mjs", from: 'ACTIVE_GRAMMAR_FORMS.spatial.has("symbol_map");', to: "false;" }]],
  ["newsroom.ts gate always on", [{ file: "newsroom.ts", from: 'const SYMBOL_MAP_GRAMMAR_ON = (ACTIVE_GRAMMAR_FORMS as any).spatial.has("symbol_map");', to: "const SYMBOL_MAP_GRAMMAR_ON = true;" }]],
  ["newsroom.ts gate never on", [{ file: "newsroom.ts", from: 'const SYMBOL_MAP_GRAMMAR_ON = (ACTIVE_GRAMMAR_FORMS as any).spatial.has("symbol_map");', to: "const SYMBOL_MAP_GRAMMAR_ON = false;" }]],
  ["newsroom.ts gate reads the wrong switch", [{ file: "newsroom.ts", from: '(ACTIVE_GRAMMAR_FORMS as any).spatial.has("symbol_map");', to: '(ACTIVE_GRAMMAR_FORMS as any).spatial.has("tile_map");' }]],
  ["strict table: symbol_map under comparison instead of geography", [{ file: "newsroom.ts", from: 'STRICT_GRAMMAR_FORMS.geography.push("symbol_map")', to: 'STRICT_GRAMMAR_FORMS.comparison.push("symbol_map")' }]],
  ["strict table: symbol_map pushed unconditionally", [{ file: "newsroom.ts", from: 'if (SYMBOL_MAP_GRAMMAR_ON) STRICT_GRAMMAR_FORMS.geography.push("symbol_map");', to: 'STRICT_GRAMMAR_FORMS.geography.push("symbol_map");' }]],
  ["tile_map entry removed from the page table (tile_map must stay)", [{ file: "infographic.mjs", from: 'tile_map: "NEWSROOM_TILE_MAP", ', to: "" }]],
];
for (const [name, mutate] of MUTANTS) {
  const dir = makeTestTmp("symbol-map-grammar-mut-");
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  for (const m of mutate) {
    const file = join(dir, "runtime/pi", m.file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.split(m.from).length - 1, 1, `mutation anchor must occur once in ${m.file}: ${name}`);
    writeFileSync(file, text.replace(m.from, () => m.to));
  }
  const bad = runAll(dir);
  assert.ok(bad.length > 0, `mutant must turn a case red: ${name}`);
}
console.log(`symbol_map grammar: ${MUTANTS.length} mutants all red -- PASS`);
