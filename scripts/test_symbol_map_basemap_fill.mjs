// symbol_map basemap provenance: the model names basemap_id, the program fills the other three fields from that
// registry entry (newsroom.ts symbolMapProvenanceFill). Not a relaxation: only undefined fields are filled, at call
// time, only for a registered id and unless NEWSROOM_SYMBOL_MAP is exactly 0; a value the model wrote (wrong ones included) is
// never replaced and is still checked by validateVizSpec. The check of the filled hash against the registry is a
// transcription check (registry against registry), see plan-1052. TEST FIXTURE data.
// Run: node scripts/test_symbol_map_basemap_fill.mjs   (the worker mode is internal)
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const ID50 = "naturalearth_admin0_50m";
const IDUS = "naturalearth_admin1_us_110m";
const KEYS = ["basemap_source_url", "basemap_license", "basemap_content_hash"];

if (process.argv[2] === "worker") {
  await worker(process.argv[3]);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------- worker
async function worker(scenario) {
  const dir = makeTestTmp("symbol-map-fill-");
  const stub = (name, source) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(dir, "node_modules", name, "index.js"), source);
  };
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(dir, "runtime", "pi");
  for (const m of JSON.parse(process.env.FILL_MUTATE ?? "[]")) { // mutation proofs: an exact one-time text replacement in the copy
    const file = join(pi, m.file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.split(m.from).length - 1, 1, `mutation anchor must occur once in ${m.file}`);
    writeFileSync(file, text.replace(m.from, () => m.to));
  }
  if (scenario === "helper") { // a stubbed registry: the 50m bytes differ from the real ones, so the registry hash differs
    const asset = join(pi, "assets", "naturalearth-admin0-50m.geojson");
    writeFileSync(asset, `${readFileSync(asset, "utf8")}\n`);
  }
  const source = stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" });
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), `${source}\nexport { symbolMapProvenanceFill };\n`);
  const mod = await import(join(pi, "newsroom.test-copy.mjs"));
  const reg = await import(join(pi, "basemap_registry.mjs"));
  const real = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
  const B50 = reg.getBasemap(ID50);
  const BUS = reg.getBasemap(IDUS);
  const triple = (e) => ({ basemap_source_url: e.source_url, basemap_license: e.license, basemap_content_hash: e.content_hash });

  if (scenario === "helper") {
    process.env.NEWSROOM_SYMBOL_MAP = "1";
    const fill = (p) => mod.symbolMapProvenanceFill({ chart_type: "symbol_map", ...p });
    // 1 both registered basemaps, each from its own entry (nothing hard-coded to one id)
    assert.deepEqual(fill({ basemap_id: ID50 }), triple(B50), "50m filled from its entry");
    assert.deepEqual(fill({ basemap_id: IDUS }), triple(BUS), "us 110m filled from its entry");
    assert.notEqual(B50.content_hash, BUS.content_hash);
    for (const id of [ID50, IDUS]) assert.ok(!("basemap_id" in fill({ basemap_id: id })), "the id is never filled or changed");
    // 7 the hash is read from the registry at call time: this copy's 50m bytes differ from the real ones
    assert.notEqual(B50.content_hash, real.getBasemap(ID50).content_hash, "the stubbed registry really differs");
    assert.equal(fill({ basemap_id: ID50 }).basemap_content_hash, B50.content_hash, "hash follows the registry in this copy");
    assert.notEqual(fill({ basemap_id: ID50 }).basemap_content_hash, real.getBasemap(ID50).content_hash, "not a constant");
    // 2 a value the model wrote is never replaced (wrong ones, empty and null included); only undefined is filled
    const wrong = { basemap_id: ID50, basemap_content_hash: "0".repeat(64), basemap_license: "x", basemap_source_url: "https://example.invalid" };
    assert.deepEqual(fill(wrong), {}, "all three written: nothing returned");
    assert.deepEqual(fill({ basemap_id: ID50, basemap_content_hash: "0".repeat(64) }), { basemap_source_url: B50.source_url, basemap_license: B50.license });
    for (const v of ["", null]) assert.deepEqual(fill({ basemap_id: ID50, basemap_license: v }), { basemap_source_url: B50.source_url, basemap_content_hash: B50.content_hash }, `${JSON.stringify(v)} is a written value, not filled`);
    // 3 no fill when the id is missing, null, empty, blank, not a string or not registered; the id is not corrected
    for (const id of [undefined, null, "", "  ", 50, {}, "not_a_basemap", "naturalearth_admin0_110m ", ` ${ID50}`, ID50.toUpperCase()]) {
      assert.deepEqual(fill({ basemap_id: id }), {}, `no fill for id ${JSON.stringify(id)}`);
    }
    assert.deepEqual(fill({}), {}, "no id at all");
    // id only: category_names does not change what is filled (a mismatched pair is refused later by the original check)
    assert.deepEqual(fill({ basemap_id: ID50, category_names: "us_state" }), triple(B50));
    assert.deepEqual(fill({ basemap_id: IDUS, category_names: "worldbank" }), triple(BUS));
    // 5 switch off (exactly "0"): nothing; every other value, unset included, is on and fills; other chart types: nothing
    process.env.NEWSROOM_SYMBOL_MAP = "0";
    assert.deepEqual(fill({ basemap_id: ID50 }), {}, 'switch "0" fills nothing');
    for (const v of [undefined, "", "true", "yes", "2", " 0", "00"]) {
      if (v === undefined) delete process.env.NEWSROOM_SYMBOL_MAP; else process.env.NEWSROOM_SYMBOL_MAP = v;
      assert.deepEqual(fill({ basemap_id: ID50 }), triple(B50), `switch ${JSON.stringify(v)} is on: filled`);
    }
    process.env.NEWSROOM_SYMBOL_MAP = "1";
    for (const chart_type of ["choropleth", "cartographic_flow_map", "horizontal_bar"]) assert.deepEqual(mod.symbolMapProvenanceFill({ chart_type, basemap_id: ID50 }), {}, chart_type);
    return;
  }

  // plan-level scenarios: the real plan tool, then validateVizSpec in this copy
  const art = join(makeTestTmp("symbol-map-fill-run-"), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
    claim_id: "claim-fixture", status: "verified", source_refs: ["data/africa.csv"],
    verification: { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true },
  })}\n`);
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const params = (extra = {}) => ({
    reader_task: "spatial", title: "Totals", alt: "Circles sized by a total for a few places on a map.", takeaway: "Places differ.",
    source_note: "fixture", claim_id: "claim-fixture", sql: "SELECT 'Chad' AS country, 2022 AS year, 70.0 AS total",
    unit: "GWh", chart_type: "symbol_map", category_field: "country", value_field: "total", category_names: "worldbank",
    reference_period_field: "year", mixed_period_strategy: "explicit", highlight_values: [], annotations: [], ...extra,
  });
  const plan = async (p) => {
    const res = await tools.get("newsroom_viz_plan").execute("p", p);
    return JSON.parse(readFileSync(join(art, res.details.planRef), "utf8"));
  };
  const spec = (stored) => stored.spec ?? stored;
  const same = (stored, entry) => assert.deepEqual([stored.basemap_id, ...KEYS.map((k) => stored[k])], [entry.id, entry.source_url, entry.license, entry.content_hash]);
  const refused = (p, pattern, why) => assert.rejects(() => plan(p), pattern, why);
  const zeros = "0".repeat(64);

  if (scenario === "on") { // NEWSROOM_SYMBOL_MAP=1, NEWSROOM_US_STATES unset
    // 4 the fill happens before the check: an id-only plan passes and stores what the model would have written
    const fromFill = spec(await plan(params({ basemap_id: ID50 })));
    same(fromFill, B50);
    const written = spec(await plan(params({ basemap_id: ID50, ...triple(B50) })));
    assert.deepEqual(fromFill, written, "filled plan equals the plan with the same three values written");
    // 2 + 6 written wrong values are refused by the original equality check, not replaced
    await refused(params({ basemap_id: ID50, basemap_content_hash: zeros }), /basemap_content_hash does not match/, "wrong hash");
    await refused(params({ basemap_id: ID50, basemap_license: "edited" }), /basemap_license does not match/, "wrong license");
    await refused(params({ basemap_id: ID50, basemap_source_url: "https://example.invalid" }), /basemap_source_url does not match/, "wrong url");
    // 3 no fill without a usable id: the original refusal stands, the id is not supplied
    for (const id of [undefined, null, "", "  ", "not_a_basemap", "naturalearth_admin0_110m"]) {
      await refused(params({ basemap_id: id }), /requires basemap_id|Unknown basemap_id|basemap_id/, `id ${JSON.stringify(id)} is still refused`);
    }
    // US_STATES unset: the US-state id is still refused by the original check; the fill must not get it through
    await refused(params({ basemap_id: IDUS }), new RegExp(`requires basemap_id '${ID50}'`), "us id with world names");
    await refused(params({ basemap_id: IDUS, category_names: "us_state" }), new RegExp(`category_names must be one of worldbank, iso3, iso2, iso4217; choropleth requires basemap_id '${ID50}'`), "us id with us_state names, US_STATES unset: both original refusals, the fill gets neither past");
    return;
  }
  if (scenario === "us") { // NEWSROOM_SYMBOL_MAP=1, NEWSROOM_US_STATES=1
    same(spec(await plan(params({ basemap_id: IDUS, category_names: "us_state" }))), BUS);
    // a mismatched pair is filled by id only, then refused; the program does not correct the id
    await refused(params({ basemap_id: ID50, category_names: "us_state" }), new RegExp(`requires basemap_id '${IDUS}'`), "50m id with us_state names");
    await refused(params({ basemap_id: IDUS, category_names: "worldbank" }), new RegExp(`requires basemap_id '${ID50}'`), "us id with world names");
    await refused(params({ basemap_id: IDUS, category_names: "us_state", basemap_content_hash: zeros }), /basemap_content_hash does not match/, "wrong hash, us");
    return;
  }
  if (scenario === "off") { // NEWSROOM_SYMBOL_MAP=0: an id-only symbol_map plan is refused as before
    await refused(params({ basemap_id: ID50 }), /./, "switch off, id only");
    await refused(params({ basemap_id: ID50, ...triple(B50) }), /./, "switch off, all written: symbol_map is not offered");
    return;
  }
  throw new Error(`unknown scenario ${scenario}`);
}

// ---------------------------------------------------------------------------------------------------- driver
function run(scenario, env = {}, mutate = []) {
  const clean = { ...process.env };
  for (const k of ["NEWSROOM_SYMBOL_MAP", "NEWSROOM_US_STATES", "FILL_MUTATE"]) delete clean[k];
  const tmp = makeTestTmp("symbol-map-fill-proc-");
  return spawnSync(process.execPath, ["--no-warnings", SELF, "worker", scenario], {
    env: { ...clean, TMPDIR: tmp, ...env, ...(mutate.length ? { FILL_MUTATE: JSON.stringify(mutate) } : {}) }, encoding: "utf8",
  });
}
const SCENARIOS = [["helper", {}], ["on", { NEWSROOM_SYMBOL_MAP: "1" }], ["us", { NEWSROOM_SYMBOL_MAP: "1", NEWSROOM_US_STATES: "1" }], ["off", { NEWSROOM_SYMBOL_MAP: "0" }]];
const failure = (r) => `${r.stderr || r.stdout}`.split("\n").filter(Boolean).slice(0, 6).join(" | ").slice(0, 600);
for (const [name, env] of SCENARIOS) {
  const r = run(name, env);
  assert.equal(r.status, 0, `scenario ${name} must pass: ${failure(r)}`);
}
console.log("symbol_map basemap fill: helper, on, us and off scenarios -- PASS");

// mutants: each one must turn at least one scenario red
const NEWS = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const realHash = (await import(join(ROOT, "runtime/pi/basemap_registry.mjs"))).getBasemap(ID50).content_hash;
const MUTANTS = [
  ["ignore the id: always fill from 50m", [{ file: "newsroom.ts", from: "const entry = getBasemap(id);\n  if (!entry) return {};\n  return {", to: `const entry = getBasemap("${ID50}");\n  if (!entry) return {};\n  return {` }]],
  ["overwrite what the model wrote", [{ file: "newsroom.ts", from: "params.basemap_content_hash === undefined ? { basemap_content_hash", to: "true ? { basemap_content_hash" }]],
  ["fill the id when it is missing (program picks the basemap)", [{ file: "newsroom.ts", from: `if (typeof id !== "string" || !id.trim()) return {};\n  const entry = getBasemap(id);`, to: `const entry = getBasemap(typeof id === "string" && id.trim() ? id : "${ID50}");` }, { file: "newsroom.ts", from: "return {\n    ...(params.basemap_source_url === undefined", to: `return {\n    ...(typeof id === "string" && id.trim() ? {} : { basemap_id: "${ID50}" }),\n    ...(params.basemap_source_url === undefined` }]],
  ["program corrects the id to match category_names", [{ file: "newsroom.ts", from: "...symbolMapProvenanceFill(params),\n      } : params;", to: `...symbolMapProvenanceFill(params),\n        ...(params.category_names === "us_state" ? { basemap_id: "${IDUS}" } : {}),\n      } : params;` }]],
  ["fill not gated by the switch", [{ file: "newsroom.ts", from: `if (!symbolMapEnabled() || params.chart_type !== "symbol_map") return {};`, to: `if (params.chart_type !== "symbol_map") return {};` }]],
  // goes red at helper level only: the plan branch only calls the fill for symbol_map, so no plan-level scenario can see it
  ["fill not gated by chart_type", [{ file: "newsroom.ts", from: `if (!symbolMapEnabled() || params.chart_type !== "symbol_map") return {};`, to: `if (!symbolMapEnabled()) return {};` }]],
  ["fill removed from the plan (nothing fills before the check)", [{ file: "newsroom.ts", from: "...symbolMapProvenanceFill(params),\n      } : params;", to: "} : params;" }]],
  ["hash hard-coded instead of read from the registry", [{ file: "newsroom.ts", from: "{ basemap_content_hash: entry.content_hash }", to: `{ basemap_content_hash: "${realHash}" }` }]],
  ["empty string counts as missing", [{ file: "newsroom.ts", from: "params.basemap_license === undefined ?", to: `(params.basemap_license === undefined || params.basemap_license === "") ?` }]],
  ["equality check on the hash deleted in viz.mjs", [{ file: "viz.mjs", from: "if (spec.basemap_content_hash !== basemap.content_hash) errors.push('basemap_content_hash does not match the registered basemap geometry');\n      }\n    }\n    // map_extent", to: "}\n    }\n    // map_extent" }]],
];
assert.ok(NEWS.includes("symbolMapProvenanceFill"), "the helper exists");
for (const [name, mutate] of MUTANTS) {
  const results = SCENARIOS.map(([s, env]) => run(s, env, mutate));
  const red = results.some((r) => r.status !== 0);
  assert.ok(red, `mutant must turn a scenario red: ${name}`);
  const anchorBroken = results.some((r) => /mutation anchor must occur once/.test(`${r.stderr}`));
  assert.ok(!anchorBroken, `mutant anchor no longer matches the source: ${name}`);
}
console.log(`symbol_map basemap fill: ${MUTANTS.length} mutants all turn a scenario red -- PASS`);
