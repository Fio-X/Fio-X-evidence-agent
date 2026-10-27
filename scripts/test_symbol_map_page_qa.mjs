// K1056: a page that carries a symbol map used to fail its own render QA (render_qa.mjs fails closed when a page has symbol circles and
// no options.symbol_map). With NEWSROOM_SYMBOL_MAP=1 the page render and the page critic split now pass the options, read from the chart's
// own render-time manifest refs (plan_ref, computation_ref) with the rows checked against the manifest's data_hash - never from the page plan.
// More than one symbol map on a page: page lint blocker (symbol_map_limit) and, if lint is bypassed, no options and the named reason
// multiple_symbol_maps. Switch off: page QA is the same call as before. TEST FIXTURE data (synthetic world map).
// Run: node scripts/test_symbol_map_page_qa.mjs   (the worker mode is internal)
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
const SITE = "runPageRenderQa(bundle.desktop.svg, await pageSymbolMapQa(spec, assets))";

if (process.argv[2] === "worker") {
  await worker(process.argv[3]);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------- worker
async function worker(scenario) {
  const dir = makeTestTmp("symbol-map-page-qa-");
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
  for (const m of JSON.parse(process.env.PAGEQA_MUTATE ?? "[]")) { // mutation proofs: an exact one-time text replacement in the copy
    const file = join(pi, m.file);
    const text = readFileSync(file, "utf8");
    assert.equal(text.split(m.from).length - 1, 1, `mutation anchor must occur once in ${m.file}`);
    writeFileSync(file, text.replace(m.from, () => m.to));
  }
  const art = join(dir, "artifacts");
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_MAP_WORLD = "1";
  const newsroomText = readFileSync(join(pi, "newsroom.ts"), "utf8");
  const source = stripTypeScriptTypes(newsroomText, { mode: "strip" });
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), `${source}\nexport { pageSymbolMapQa, runPageRenderQa };\n`);
  const mod = await import(join(pi, "newsroom.test-copy.mjs"));
  const viz = await import(join(pi, "viz.mjs"));
  const qaMod = await import(join(pi, "render_qa.mjs"));
  const info = await import(join(pi, "infographic.mjs"));

  // ---- fixtures: one world symbol map, its artifacts on disk, a page SVG that carries its circles
  const spec = { schema_version: "0.9.0", chart_type: "symbol_map", title: "World", takeaway: "t", subtitle: "synthetic", alt: "A synthetic symbol map.", source_note: "synthetic fixture", source: "synthetic", claim_id: "c1", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh", verification_mode: "draft", reader_task: "spatial", unit: "PJ", category_field: "c", value_field: "v", measure_kind: "count", category_names: "iso3", map_extent: "world", basemap_id: "naturalearth_admin0_50m", basemap_source_url: "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", basemap_license: "Public domain (Natural Earth terms of use)", basemap_content_hash: "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e" };
  const rows = [["USA", 32000], ["RUS", 14000], ["CHN", 13000], ["DEU", 3100], ["BRA", 1300], ["AUS", 1600], ["NGA", 40], ["ISL", 0.3], ["ZAF", 0], ["JPN", null]].map(([c, v]) => ({ c, v }));
  // the renderer reads the switch per call; the page-side gates above were fixed when the copies loaded, so the fixture is drawn with it on
  const driverSwitch = process.env.NEWSROOM_SYMBOL_MAP;
  process.env.NEWSROOM_SYMBOL_MAP = "1";
  const svg = viz.renderVizBundle(spec, rows, { mobilePages: false }).desktop;
  if (driverSwitch === undefined) delete process.env.NEWSROOM_SYMBOL_MAP; else process.env.NEWSROOM_SYMBOL_MAP = driverSwitch;
  assert.ok(svg.includes('data-role="symbol-circle"'), "fixture carries circles");
  const write = (rel, value) => { mkdirSync(join(art, rel, ".."), { recursive: true }); writeFileSync(join(art, rel), JSON.stringify(value)); };
  const dataHash = viz.hashRows(rows);
  write("visualizations/plans/p1.json", spec);
  write("computations/c1.json", { rows });
  const manifest = { chart_type: "symbol_map", plan_ref: "visualizations/plans/p1.json", computation_ref: "computations/c1.json", data_hash: dataHash };
  const pageOf = (...refs) => ({ modules: refs.map((r, i) => ({ id: `v${i}`, type: "visual", manifest_ref: r })) });
  const assetsOf = (map) => Object.fromEntries(Object.entries(map).map(([ref, m]) => [ref, { manifest: m }]));
  const plain = qaMod.runRenderQa({ desktop: svg });
  const rules = (report) => (report.viewports.desktop.extra_checks?.symbol_map_list?.failures ?? []).map((f) => f.rule);
  const run = async (pageSpec, assets) => mod.runPageRenderQa(svg, await mod.pageSymbolMapQa(pageSpec, assets));

  if (scenario === "off") {
    // switch off: nothing is built, page QA is the very same call as before (red, generic rule, byte-identical report)
    assert.deepEqual(await mod.pageSymbolMapQa(pageOf("m1"), assetsOf({ m1: manifest })), {}, "off: no options, no reason");
    assert.deepEqual(await run(pageOf("m1"), assetsOf({ m1: manifest })), plain, "off: report identical to the plain call");
    assert.deepEqual(rules(plain), ["symbol-qa-options-missing"], "off: the fail-closed rule is unchanged");
    const lint = info.lintInfographicSpec(pageOf("m1", "m2"), assetsOf({ m1: manifest, m2: manifest }));
    assert.ok(!lint.blockers.some((b) => /symbol_map_limit/.test(b)), "off: no symbol_map_limit blocker");
    return console.log("worker off ok");
  }

  assert.equal(scenario, "on");
  assert.equal(process.env.NEWSROOM_SYMBOL_MAP, "1", "the driver sets the switch before the copy loads (it is read once at load)");
  // 1 the sites: both page paths build their QA through the helper, and no bare page call is left
  assert.equal(newsroomText.split(SITE).length - 1, 2, "both page sites pass the symbol-map options");
  assert.equal(newsroomText.split("runRenderQa({ desktop: bundle.desktop.svg })").length - 1, 0, "no bare page QA call remains");
  // 2 one map: options come from the manifest refs, the page passes
  const one = await mod.pageSymbolMapQa(pageOf("m1"), assetsOf({ m1: manifest }));
  assert.deepEqual(Object.keys(one), ["options"], "one map: options only");
  assert.deepEqual(one.options.symbol_map.spec, spec);
  assert.deepEqual(one.options.symbol_map.rows, rows);
  const passed = await run(pageOf("m1"), assetsOf({ m1: manifest }));
  assert.equal(passed.passed, true, `one map: page QA passes (${JSON.stringify(rules(passed))})`);
  // 3 the rows are the manifest's, not the page plan's: a page plan that carries other rows changes nothing
  const tamperedPage = { ...pageOf("m1"), rows: rows.filter((r) => r.c !== "USA"), modules: [{ id: "v0", type: "visual", manifest_ref: "m1", rows: rows.filter((r) => r.c !== "USA"), spec: { ...spec, value_field: "x" } }] };
  assert.deepEqual((await mod.pageSymbolMapQa(tamperedPage, assetsOf({ m1: manifest }))).options.symbol_map.rows, rows, "page-plan rows are ignored");
  assert.equal((await run(tamperedPage, assetsOf({ m1: manifest }))).passed, true, "page-plan rows cannot turn the page red");
  // 4 fail closed: unreadable inputs, rows that do not hash to the manifest, a plan that is not a symbol map: no options, a named reason, QA red
  const bad = async (m, reason, why) => {
    const r = await mod.pageSymbolMapQa(pageOf("m1"), assetsOf({ m1: m }));
    assert.deepEqual(r, { reason }, why);
    const report = await run(pageOf("m1"), assetsOf({ m1: m }));
    assert.equal(report.passed, false, `${why}: QA red`);
    assert.deepEqual(rules(report), [reason], `${why}: the named reason replaces the generic rule`);
  };
  await bad({ ...manifest, computation_ref: "computations/missing.json" }, "symbol_map_inputs_unreadable", "rows file missing");
  await bad({ ...manifest, plan_ref: "visualizations/plans/missing.json" }, "symbol_map_inputs_unreadable", "plan file missing");
  await bad({ ...manifest, data_hash: "0".repeat(64) }, "symbol_map_rows_hash_mismatch", "rows hash differs from data_hash");
  write("visualizations/plans/p2.json", { ...spec, chart_type: "choropleth" });
  await bad({ ...manifest, plan_ref: "visualizations/plans/p2.json" }, "symbol_map_spec_mismatch", "plan is not a symbol map");
  // 5 more than one map: no options, the explicit reason, QA red with that rule (lint bypassed)
  const two = await mod.pageSymbolMapQa(pageOf("m1", "m2"), assetsOf({ m1: manifest, m2: manifest }));
  assert.deepEqual(two, { reason: "multiple_symbol_maps" });
  const twoReport = await run(pageOf("m1", "m2"), assetsOf({ m1: manifest, m2: manifest }));
  assert.equal(twoReport.passed, false);
  assert.deepEqual(rules(twoReport), ["multiple_symbol_maps"], "not the generic rule name");
  assert.deepEqual(await mod.pageSymbolMapQa(pageOf("m1", "m2", "m3"), assetsOf({ m1: manifest, m2: manifest, m3: manifest })), { reason: "multiple_symbol_maps" }, "three maps too");
  // 6 a page without a symbol map: nothing built, report identical to the plain call
  const noMap = { ...manifest, chart_type: "horizontal_bar" };
  assert.deepEqual(await mod.pageSymbolMapQa(pageOf("m1"), assetsOf({ m1: noMap })), {});
  assert.deepEqual(await mod.pageSymbolMapQa({ modules: [{ id: "t", type: "text" }] }, {}), {});
  const barSvg = svg.replaceAll('data-role="symbol-circle"', 'data-role="other"');
  assert.deepEqual(mod.runPageRenderQa(barSvg, {}), qaMod.runRenderQa({ desktop: barSvg }), "no symbol map: same report as the plain call");
  // 7 the page lint: two maps are blocked, one is not, other chart types do not count
  const lintBlockers = (...ms) => info.lintInfographicSpec(pageOf(...ms.map((_, i) => `m${i}`)), assetsOf(Object.fromEntries(ms.map((m, i) => [`m${i}`, m])))).blockers.filter((b) => /symbol_map_limit/.test(b));
  assert.equal(lintBlockers(manifest).length, 0, "one map: no blocker");
  assert.equal(lintBlockers(manifest, manifest).length, 1, "two maps: blocker");
  assert.match(lintBlockers(manifest, manifest)[0], /at most 1 symbol_map, found 2/);
  assert.equal(lintBlockers(manifest, manifest, manifest).length, 1, "three maps: one blocker");
  assert.equal(lintBlockers(manifest, noMap, noMap).length, 0, "one map and other charts: no blocker");
  console.log("worker on ok");
}

// ---------------------------------------------------------------------------------------------------- driver
const runWorker = (scenario, env = {}, mutate = []) => spawnSync(process.execPath, ["--no-warnings", SELF, "worker", scenario], {
  encoding: "utf8", timeout: 240000,
  env: { ...process.env, NEWSROOM_SYMBOL_MAP: "0", ...env, PAGEQA_MUTATE: JSON.stringify(mutate) },
});
const on = { NEWSROOM_SYMBOL_MAP: "1" };
for (const [scenario, env] of [["on", on], ["off", {}]]) {
  const r = runWorker(scenario, env);
  assert.equal(r.status, 0, `${scenario} worker failed:\n${r.stdout}\n${r.stderr}`);
}
console.log("symbol_map page QA: on and off ok");

// mutation proofs: each broken copy must turn its scenario red
const NR = "newsroom.ts", IN = "infographic.mjs";
const mutants = [
  // The anchor starts at the line break and the 4-space indent of pageSymbolMapQa's read: the page ledger's read of the same
  // computation_ref (NEWSROOM_NEXT) sits deeper and must not be the one replaced.
  ["rows read from the page plan", "on", NR, "\n    const computation = await readArtifactJson(String(manifest.computation_ref), \"computations/\")", "\n    const computation = { rows: (spec.modules.find((m: any) => m.manifest_ref) ?? {}).rows ?? [] }"],
  ["rows hash not checked", "on", NR, "if (hashRows(rows) !== manifest.data_hash) return { reason: \"symbol_map_rows_hash_mismatch\" };", ""],
  ["plan type not checked", "on", NR, "if (chartSpec?.chart_type !== \"symbol_map\") return { reason: \"symbol_map_spec_mismatch\" };", ""],
  ["unreadable inputs fall back to defaults", "on", NR, "return { reason: \"symbol_map_inputs_unreadable\" };", "return { options: symbolMapQaOptions({ chart_type: \"symbol_map\" }, []) };"],
  ["multiple-maps reason deleted", "on", NR, "return { reason: \"multiple_symbol_maps\" };", "return {};"],
  ["multiple-maps threshold relaxed", "on", NR, "if (manifests.length > 1) return", "if (manifests.length > 2) return"],
  ["named reason not applied", "on", NR, "failure.rule = qa.reason;", ""],
  ["site 1 loses the options", "on", NR, `const renderQa = ${SITE};`, "const renderQa = runRenderQa({ desktop: bundle.desktop.svg });"],
  ["site 2 loses the options", "on", NR, `const renderQaReport = ${SITE};`, "const renderQaReport = runRenderQa({ desktop: bundle.desktop.svg });"],
  ["helper not gated by the switch", "off", NR, "if (!SYMBOL_MAP_GRAMMAR_ON) return {};", ""],
  ["lint blocker removed", "on", IN, "if (symbolMaps > 1) blockers.push(", "if (false) blockers.push("],
  ["lint limit relaxed to 2", "on", IN, "if (symbolMaps > 1) blockers.push(", "if (symbolMaps > 2) blockers.push("],
  ["lint not gated by the switch", "off", IN, "if (SYMBOL_MAP_GRAMMAR_ON) {\n    const symbolMaps", "if (true) {\n    const symbolMaps"],
];
for (const [name, scenario, file, from, to] of mutants) {
  const r = runWorker(scenario, scenario === "on" ? on : {}, [{ file, from, to }]);
  assert.notEqual(r.status, 0, `mutant must go red: ${name}`);
  assert.doesNotMatch(r.stderr, /mutation anchor must occur once/, `mutant anchor is stale: ${name}`);
}
console.log(`symbol_map page QA mutants: ${mutants.length} red`);

