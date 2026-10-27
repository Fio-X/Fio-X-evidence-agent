// NEWSROOM_SPEED_DESIGN_PACK=1 (default off): newsroom_asset_requirements also requires every resolved source_refs file to be a source this run
// can recognise for the requirement's asset_class, judged by the file's real path: a prepared basemap (published_gis, geographic_coordinates
// only) or a rendered explanatory-graphic manifest (verified_diagram, vector_illustration, human_scale_reference only). Nothing else is a source,
// whatever fields it carries; the page's own charts, plans, maps, computations and data files are refused as circular references. Switch off:
// the old rule (ordinary file of the run) is unchanged. Offline, no provider; the basemap tool runs the real script with a stand-in geometry library.
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

const PACK = "NEWSROOM_SPEED_DESIGN_PACK";
const mod = await loadTree("head");
const hex = "a".repeat(64);
const { existsSync, copyFileSync } = await import("node:fs");
const FILES = {
  "visualizations/chart.json": { kind: "chart manifest", source_url: "https://example.org", license: "x", credit: "y" },
  "infographics/page.json": { source_url: "https://example.org", license: "x" },
  "editorial/assets/plan.json": { source_url: "https://example.org", license: "x" },
  "maps/spec.json": { source_url: "https://example.org", license: "x" },
  "computations/c.json": {}, "data/d.json": {},
  "maps/basemaps/requests/r.json": { source_url: "https://example.org/b", license: "x" },
  "maps/basemaps/nolicense.json": { id: "b", source_url: "https://example.org/b" },
  "maps/basemaps/nosource.json": { id: "b", license: "Public domain" },
  "visualizations/illustrations/m.json": { plan_ref: "visualizations/illustrations/plans/p.json", variants: { desktop: "visualizations/illustrations/m.svg" } },
  "visualizations/illustrations/notmanifest.json": { title: "x" },
  "notes/external.json": null, // a complete external asset manifest: no program writes one, so it is no source
};
const EXTERNAL = { asset_id: "a1", asset_class: "published_gis", production_lane: "gis_render", source_url: "https://example.org/a", license: "CC-BY-4.0", credit: "Someone", origin: "software", source_sha256: hex, output_sha256: hex };
// A stand-in for matplotlib's Basemap so the real scripts/ preparation program runs here: it returns one short line for every layer.
const STAND_IN = join(makeTestTmp("basemap-stand-in-"), "py");
mkdirSync(join(STAND_IN, "mpl_toolkits"), { recursive: true });
writeFileSync(join(STAND_IN, "mpl_toolkits", "__init__.py"), "");
writeFileSync(join(STAND_IN, "mpl_toolkits", "basemap.py"), "class _L:\n    def get_segments(self): return [[(0.0, 0.0), (1.0, 1.0)]]\nclass Basemap:\n    def __init__(self, **kw): pass\n    def drawcoastlines(self): return _L()\n    def drawrivers(self): return _L()\n    def drawcountries(self): return _L()\n");
const setup = async (env, label) => {
  const tools = register(mod, { ...env, PYTHONPATH: STAND_IN });
  const art = freshArt(label);
  for (const [f, v] of Object.entries(FILES)) { mkdirSync(join(art, f, ".."), { recursive: true }); writeFileSync(join(art, f), JSON.stringify(v ?? EXTERNAL)); }
  writeFileSync(join(art, "data", "plain.csv"), "a\n1\n");
  copyFileSync(join(ROOT, "runtime", "pi", "scientific_basemap_prepare.py"), join(art, "runtime", "scientific_basemap_prepare.py"));
  const d = await tools.get("newsroom_editorial_discovery").execute("t", DISCOVERY);
  const c = await attempt(tools.get("newsroom_visual_concepts"), { discovery_ref: ref(d), concepts: full() });
  assert.ok(ref(c), JSON.stringify(c).slice(0, 300));
  const finalist = JSON.parse(readFileSync(join(art, ref(c)), "utf8")).finalists[0];
  const askRows = (rows) => attempt(tools.get("newsroom_asset_requirements"), { concept_id: finalist, concept_ref: ref(c), requirements: rows });
  const row = (asset_class, refs, available = true) => ({ asset_class, status: "required", available, purpose: "series", source_refs: refs });
  const ask = (asset_class, refs) => askRows([row(asset_class, refs)]);
  return { ask, askRows, row, tools, art };
};
const refused = (r, pattern, why) => assert.match(r.error ?? "", pattern, `${why}: ${r.error ?? "accepted"}`);
const CIRCULAR = /available requirement 1: source_refs entry .* of this run, not an asset manifest.*circular reference.*available:false/s;
const NO_SOURCE = /available requirement 1: source_refs entry .*(not a source this run can recognise|can only be the source of|is a basemap file without)/s;

const on = await setup({ [PACK]: "1" }, "on");
{ // 1: the real basemap tool
  const made = await attempt(on.tools.get("newsroom_basemap_prepare"), { west: 0, east: 10, south: 0, north: 10 });
  assert.ok(!made.error, `the basemap tool did not run: ${made.error}`);
  const baseRef = String(made.text ?? made.content?.[0]?.text ?? "").match(/Asset: (\S+)/)?.[1];
  assert.match(baseRef, /^maps\/basemaps\/[a-f0-9]+\.json$/);
  const written = JSON.parse(readFileSync(join(on.art, baseRef), "utf8"));
  assert.ok(written.source_url && written.license, "the program wrote source_url and license itself");
  for (const klass of ["published_gis", "geographic_coordinates"]) assert.ok(ref(await on.ask(klass, [baseRef])), `${klass} refused the real basemap`);
  for (const klass of ["archival_photo", "historical_series", "portrait_or_object_photo", "expert_explanation", "verified_3d", "vector_illustration"]) refused(await on.ask(klass, [baseRef]), /is a basemap; it can only be the source of a published_gis or geographic_coordinates asset/, `a basemap as the source of ${klass}`);
  check("1: the real basemap tool's file is accepted for published_gis and geographic_coordinates only");
  refused(await on.ask("published_gis", ["maps/basemaps/nolicense.json"]), /basemap file without source_url and license/, "no license");
  refused(await on.ask("published_gis", ["maps/basemaps/nosource.json"]), /basemap file without source_url and license/, "no source_url");
  refused(await on.ask("published_gis", ["maps/basemaps/requests/r.json"]), CIRCULAR, "a basemap request");
  check("1: a basemap file without source_url or license and a basemap request are refused");
}
{ // 2: an illustration manifest is the source of a drawn asset only
  for (const klass of ["published_gis", "geographic_coordinates", "archival_photo", "portrait_or_object_photo", "historical_series", "expert_explanation", "verified_3d"]) refused(await on.ask(klass, ["visualizations/illustrations/m.json"]), /is a graphic this run drew itself; it can only be the source of a verified_diagram, vector_illustration, human_scale_reference asset/, `an illustration manifest as the source of ${klass}`);
  for (const klass of ["verified_diagram", "vector_illustration", "human_scale_reference"]) assert.ok(ref(await on.ask(klass, ["visualizations/illustrations/m.json"])), `${klass} refused its own drawing`);
  refused(await on.ask("verified_diagram", ["visualizations/illustrations/notmanifest.json"]), /not a rendered illustration manifest/, "not a manifest");
  check("2: an illustration manifest is refused for map, photo, series, expert and 3D assets and accepted for the three drawn classes");
}
{ // 3: no other file is a source, however complete its fields
  for (const klass of ["published_gis", "archival_photo", "historical_series", "verified_diagram"]) {
    for (const f of ["notes/external.json", "data/plain.csv", "data/d.json"]) refused(await on.ask(klass, [f]), /(not a source this run can recognise|circular reference)/s, `${f} for ${klass}`);
  }
  refused(await on.ask("archival_photo", ["notes/external.json"]), /Mark the requirement available:false/, "the text says what to do");
  assert.ok(ref(await on.askRows([on.row("archival_photo", ["notes/external.json"], false)])), "available:false is not looked at");
  check("3: a complete external asset manifest, a csv and a data file are no source for any class; the refusal says to mark available:false");
}
{ // 4: model-shaped plan files
  const planParams = { title: "Pump", subject: "A pump", alt: "A schematic cutaway of a pump showing the inlet and outlet", view: "cutaway", source_note: "schematic", parts: [{ id: "p1", label: "Inlet" }, { id: "p2", label: "Outlet" }] };
  const extra = { asset_id: "a1", asset_class: "published_gis", production_lane: "gis_render", source_url: "https://example.org/a", license: "CC-BY-4.0", credit: "Someone", origin: "software", source_sha256: hex, output_sha256: hex };
  const made = await attempt(on.tools.get("newsroom_explainer_plan"), { ...planParams, ...extra });
  const planRef = String(made.text ?? made.content?.[0]?.text ?? "").match(/Plan: (\S+)/)?.[1];
  assert.ok(planRef, `the explainer plan tool did not run: ${made.error}`);
  const stored = JSON.parse(readFileSync(join(on.art, planRef), "utf8"));
  const kept = Object.keys(extra).filter((k) => k in stored);
  for (const klass of ["published_gis", "archival_photo", "historical_series", "verified_diagram", "vector_illustration"]) refused(await on.ask(klass, [planRef]), /(not a source this run can recognise|circular reference)/s, `a plan with extra fields as the source of ${klass}`);
  check(`4: the real explainer plan tool wrote ${planRef.split("/").slice(0, -1).join("/")}/<key>.json with ${kept.length}/${Object.keys(extra).length} of the extra top-level fields kept; it is refused for every class`);
}
{ // 5: real path and letter case
  const art = on.art;
  const insensitive = existsSync(join(art, "Visualizations", "chart.json"));
  symlinkSync(join(art, "visualizations", "chart.json"), join(art, "maps", "basemaps", "link-to-chart.json"));
  writeFileSync(join(art, "maps", "basemaps", "good.json"), JSON.stringify({ id: "b", source_url: "https://example.org/b", license: "Public domain" }));
  symlinkSync(join(art, "maps", "basemaps", "good.json"), join(art, "data", "link-to-good.json"));
  refused(await on.ask("published_gis", ["maps/basemaps/link-to-chart.json"]), CIRCULAR, "a basemap-named link to a chart manifest is judged by its target");
  assert.ok(ref(await on.ask("published_gis", ["data/link-to-good.json"])), "a data/ link to a real basemap is judged by its target");
  check("5: a link is judged by the file it points to, not by the name the model typed");
  if (insensitive) {
    for (const v of ["Visualizations/chart.json", "INFOGRAPHICS/page.json", "Editorial/assets/plan.json", "Maps/spec.json"]) refused(await on.ask("published_gis", [v]), CIRCULAR, `letter-case variant ${v}`);
    const canon = await on.ask("published_gis", ["Maps/Basemaps/good.json"]);
    assert.ok(ref(canon), `a letter-case variant of a real basemap is the same file: ${canon.error}`);
    check("5: letter-case variants of the page's own files are refused by their real name; a variant of a real basemap is the same file and is accepted");
  } else {
    check("5: SKIP letter-case variants (this file system is case-sensitive: a variant is a missing file)");
  }
}
{ // 6: scope, and off
  const direct = await on.ask("published_gis", ["visualizations/chart.json"]);
  refused(direct, CIRCULAR, "a direct call");
  const mixed = await on.askRows([on.row("published_gis", ["maps/basemaps/good.json", "visualizations/chart.json"])]);
  refused(mixed, CIRCULAR, "one bad ref among good ones refuses the row");
  const missing = await on.ask("published_gis", ["nope"]);
  assert.match(missing.error ?? "", /could not find this artifact in the run/, "the old existence check still runs first: the earlier error is the existence one");
  for (const v of [undefined, "0", "", "true"]) {
    const off = await setup({ [PACK]: v }, `off${v}`);
    for (const f of ["visualizations/chart.json", "infographics/page.json", "data/plain.csv", "notes/external.json", "visualizations/illustrations/m.json"]) assert.ok(ref(await off.ask("published_gis", [f])), `${JSON.stringify(v)}: ${f} was refused with the switch off`);
  }
  const src = readFileSync(join(ROOT, "runtime", "pi", "newsroom.ts"), "utf8");
  assert.equal(src.split('process.env.NEWSROOM_SPEED_DESIGN_PACK === "1") {\n              for (const typed of requirement.source_refs)').length, 2, "the check sits in the asset tool's execute, which the pack calls through the tool registry");
  check("6: a direct call is refused like a pack call (one tool, one check); with the switch unset, 0, empty or true the old rule holds");
}
{ // 7: the k1568 r24 asset plan
  const rows = (o) => [o.row("published_gis", ["visualizations/chart.json"]), o.row("geographic_coordinates", ["visualizations/chart.json"])];
  const on7 = await setup({ [PACK]: "1" }, "r24on"); // the switch is process-wide: set it again after the loop above
  const onR = await on7.askRows(rows(on7));
  refused(onR, CIRCULAR, "the k1568 plan on");
  const off = await setup({ [PACK]: undefined }, "r24off");
  const offR = await off.askRows(rows(off));
  assert.ok(ref(offR), `the k1568 plan off: ${offR.error}`);
  assert.equal(JSON.parse(readFileSync(join(off.art, ref(offR)), "utf8")).decision, "CONTINUE", "off: the old plan is CONTINUE, as in the archive");
  check("7: the k1568 r24 asset plan (a map and place coordinates sourced from the chart's own manifest) is refused with the switch on and still CONTINUE with it off");
}
console.log(results.map((r) => `  PASS ${r}`).join("\n"));
console.log(`asset source kind: ${results.length} checks -- PASS`);
