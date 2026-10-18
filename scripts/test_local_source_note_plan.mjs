// NEWSROOM_LOCAL_SOURCE_NOTE=1, behaviour through the real tool path: a model-written source_note cannot replace an accepted note
// (chart plan, chart manifest, rendered SVG), the page footer and the reader-text entries use one function, and two noted origins
// for one data file never pick by file-name order. Loads runtime/pi/newsroom.ts from a type-stripped copy (as
// test_viz_chain_runtime.mjs does). Needs the duckdb binary; skips the real-chart part without it. Offline, no provider.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// This fixture maps a plain column without a ratio declaration and tests something else; the default-on check is proved in the real tool path by
// scripts/test_viz_plan_inset_param.mjs and in full by scripts/test_choropleth_normalized.mjs.
process.env.NEWSROOM_CHOROPLETH_NORMALIZED = "0";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const MODEL_TEXT = "Totally Different Agency";
const NOTE = { publisher: "Our World in Data", dataset: "Energy mix", license: "CC BY 4.0" };
const ACCEPTED_EN = 'Our World in Data, "Energy mix", CC BY 4.0';

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
const tree = makeTestTmp("local-note-tree-");
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
stub(tree, "typebox", TYPEBOX);
stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
writeFileSync(join(tree, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(tree, "runtime/pi/newsroom.test-copy.mjs"));
const { effectivePageSourceNote, pageSourceNoteReplaced, readerTextEntries, composeInfographicBundle } = await import(join(ROOT, "runtime/pi/infographic.mjs"));
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin0_50m");

const ENV_KEYS = ["NEWSROOM_LOCAL_SOURCE_NOTE", "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_FAULT_INJECT_TOOL_ONCE"];
function setEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1";
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
function register(env) {
  setEnv(env);
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}

const CSV = ["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0"].join("\n") + "\n";
const SQL = "SELECT country, year, share FROM 'data/africa.csv' ORDER BY country";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const dataSha = sha256(CSV);

function freshRun(label) {
  const art = join(makeTestTmp(`local-note-${label}-`), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data/origins", "sources"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "data", "africa.csv"), CSV);
  writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256: dataSha }));
  writeFileSync(join(art, "claims.jsonl"), "");
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}
// An origin record as artifact.rs writes it; `note` null = a record without a note.
function writeOrigin(art, { note = NOTE, noteSha = dataSha, tag = "a" } = {}) {
  const origin = { schema_version: "0.7.0", origin: "local_file", original_filename: "africa.csv", sha256: dataSha, file: "data/africa.csv" };
  if (note) origin.source_note_file = { ...note, sha256: noteSha, note_sha256: sha256(JSON.stringify(note) + tag) };
  writeFileSync(join(art, "data", "origins", `${sha256(JSON.stringify(origin))}.json`), `${JSON.stringify(origin, null, 2)}\n`);
}
const planParams = (claim_id, extra = {}) => ({
  reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries.",
  takeaway: "Several African countries differ widely in renewable share.", source_note: MODEL_TEXT, sql: SQL, unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share",
  category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "explicit",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [], claim_id, ...extra,
});
async function bindClaim(tools, art, claimId) {
  const query = await tools.get("duckdb_query").execute("q", { sql: SQL });
  const ref = query.details.path.startsWith("/") ? query.details.path.slice(art.length + 1) : query.details.path;
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: claimId, status: "verified", source_refs: ["data/africa.csv"], computation_refs: [ref], verification })}\n`, { flag: "a" });
}
// plan -> lint -> render through the registered tools; returns the saved plan, the chart manifest and the SVG text.
async function planRender(tools, art, label, extra = {}) {
  const claimId = `claim-${label}`;
  await bindClaim(tools, art, claimId);
  const plan = await tools.get("newsroom_viz_plan").execute("p", planParams(claimId, extra));
  const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
  const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  const planJson = JSON.parse(readFileSync(join(art, plan.details.planRef), "utf8"));
  const manifestText = readFileSync(join(art, render.details.manifestRef), "utf8");
  const manifest = JSON.parse(manifestText);
  const svg = readFileSync(join(art, manifest.variants?.desktop ?? manifest.svg), "utf8");
  return { planText: readFileSync(join(art, plan.details.planRef), "utf8"), planJson, manifestText, manifest, svg };
}

const probe = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" });
const haveDuckdb = probe.error?.code !== "ENOENT";
if (!haveDuckdb) console.log("duckdb binary not found; skipping the real-chart checks");
const results = [];
const ok = (name) => { results.push(name); console.log(`${name} -- PASS`); };

if (haveDuckdb) {
  { // switch on + accepted note: the program text decides; the model text is nowhere
    const tools = register({ NEWSROOM_LOCAL_SOURCE_NOTE: "1" });
    const art = freshRun("on");
    writeOrigin(art);
    const out = await planRender(tools, art, "on");
    assert.equal(out.planJson.source_note, ACCEPTED_EN);
    assert.equal(out.planJson.source_note_program, true);
    assert.equal(out.manifest.source_note, ACCEPTED_EN);
    assert.equal(out.manifest.source_note_program, true);
    for (const [name, text] of [["plan", out.planText], ["manifest", out.manifestText], ["svg", out.svg]]) assert.ok(!text.includes(MODEL_TEXT), `${name} must not hold the model text`);
    assert.ok(out.svg.includes("Our World in Data") && out.svg.includes("CC BY 4.0"), "the SVG shows the accepted note");
    ok("on + accepted note: saved plan, manifest and SVG show the program text, never the model text");
  }
  const keeps = async (label, env, prepare, extra = {}) => {
    const tools = register(env);
    const art = freshRun(label);
    prepare(art);
    const out = await planRender(tools, art, label, extra);
    assert.equal(out.planJson.source_note, MODEL_TEXT, label);
    assert.ok(!("source_note_program" in out.planJson) && !("source_note_program" in out.manifest), `${label}: no flag`);
    assert.ok(out.svg.includes(MODEL_TEXT), `${label}: the model text is shown as today`);
  };
  await keeps("off", {}, (art) => writeOrigin(art));
  await keeps("off-zero", { NEWSROOM_LOCAL_SOURCE_NOTE: "0" }, (art) => writeOrigin(art));
  ok("switch off or not exactly 1: the model's text is kept, no flag");
  await keeps("no-note", { NEWSROOM_LOCAL_SOURCE_NOTE: "1" }, (art) => writeOrigin(art, { note: null }));
  ok("switch on, origin without a note: the model's text is kept");
  await keeps("bad-sha", { NEWSROOM_LOCAL_SOURCE_NOTE: "1" }, (art) => writeOrigin(art, { noteSha: "0".repeat(64) }));
  ok("switch on, note hash differs from the data file: the model's text is kept");
  await keeps("two-different", { NEWSROOM_LOCAL_SOURCE_NOTE: "1" }, (art) => { writeOrigin(art); writeOrigin(art, { note: { ...NOTE, license: "CC0" } }); });
  ok("two noted origins with different notes: today's line, no pick by file-name order");
  await keeps("note-then-plain", { NEWSROOM_LOCAL_SOURCE_NOTE: "1" }, (art) => { writeOrigin(art); writeOrigin(art, { note: null }); });
  ok("a noted origin and a later origin without a note for one data file: today's line (K177 part 2)");
  await keeps("plain-then-note", { NEWSROOM_LOCAL_SOURCE_NOTE: "1" }, (art) => { writeOrigin(art, { note: null }); writeOrigin(art); });
  ok("an origin without a note and a noted one, either order: today's line");
  await keeps("model-flag-no-note", { NEWSROOM_LOCAL_SOURCE_NOTE: "1" }, (art) => writeOrigin(art, { note: null }), { source_note_program: true });
  ok("switch on, the model passes source_note_program with no accepted note: no flag in plan or manifest, its line stays (K177 part 1)");
  {
    const tools = register({ NEWSROOM_LOCAL_SOURCE_NOTE: "1" });
    const art = freshRun("two-same");
    writeOrigin(art, { tag: "a" });
    writeOrigin(art, { tag: "b" });
    const out = await planRender(tools, art, "two-same");
    assert.equal(out.planJson.source_note, ACCEPTED_EN);
    ok("two noted origins with identical notes: the note is used");
  }
}

{ // the accepted-note function itself: control, bidirectional and zero-width characters are refused, in step with the Rust reader
  const tools = register({ NEWSROOM_LOCAL_SOURCE_NOTE: "1" });
  void tools;
  for (const [label, publisher] of [["C1 control", "Our\u0085World"], ["zero-width space", "Our​World"], ["left-to-right mark", "Our‎World"], ["bidi override", "Our‮World"], ["bidi isolate", "Our⁦World"], ["byte-order mark", "Our﻿World"], ["C0 control", "Our\u0007World"]]) {
    const art = freshRun("chars");
    writeOrigin(art, { note: { ...NOTE, publisher } });
    assert.equal(await mod.acceptedLocalSourceNote(["data/africa.csv"], "en"), null, label);
  }
  const art = freshRun("chars-ok");
  writeOrigin(art);
  assert.equal(await mod.acceptedLocalSourceNote(["data/africa.csv"], "en"), ACCEPTED_EN);
  assert.equal(await mod.acceptedLocalSourceNote(["data/africa.csv"], "zh"), "Our World in Data《Energy mix》，CC BY 4.0");
  ok("refused characters (C0, C1, zero-width, bidi, BOM) give no note; a clean note gives zh and en lines");
}

{ // page footer: one function for the printed footer and the reader-text entries
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#ccc"/></svg>';
  const visual = (id, ref) => ({ id, type: "visual", span: "full", manifest_ref: ref, label: id });
  const asset = (manifest) => ({ manifest, critic: null, renderQa: null, desktopSvg: svg, mobileSvg: svg });
  const spec = (modules) => ({ schema_version: "1.0.0", kicker: "DATA", title: "A page", dek: "d", alt: "A synthetic page used to test the source line in the footer.", byline: "b", date_label: "d", layout: "feature", complexity_budget: "low", language: "en", source_note: MODEL_TEXT, modules: [{ id: "section-1", type: "section_header", span: "full", eyebrow: "Background", heading: "Where the data comes from", deck: "A short deck." }, ...modules, { id: "section-2", type: "section_header", span: "full", eyebrow: "Closing", heading: "What to read next", deck: "Another short deck." }] });
  const flagged = { source_note: ACCEPTED_EN, source_note_program: true };
  const plain = { source_note: "Some other chart note" };
  const footerText = (s, assets) => [...composeInfographicBundle(s, assets, { mobilePages: false }).desktop.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join("\n");
  process.env.NEWSROOM_LOCAL_SOURCE_NOTE = "1";
  { // every visual flagged: the model's line is not printed and not read; the saved spec still has it
    const s = spec([visual("v1", "m1"), visual("v2", "m2")]);
    const assets = { m1: asset(flagged), m2: asset(flagged) };
    assert.equal(pageSourceNoteReplaced(s, assets), true);
    assert.equal(effectivePageSourceNote(s, assets), undefined);
    assert.equal(s.source_note, MODEL_TEXT, "the saved plan keeps the model's text");
    const text = footerText(s, assets);
    assert.ok(text.includes("Our World in Data") && !text.includes(MODEL_TEXT), "footer shows the accepted note only");
    const entries = readerTextEntries(s, assets);
    assert.ok(!entries.some((e) => e.text.includes(MODEL_TEXT)) && entries.some((e) => e.text.includes("Our World in Data")), "reader text equals what is printed");
    ok("page, every visual flagged: footer and reader-text entries show the accepted note only; the plan keeps the model text");
  }
  { // mixed page: one visual unflagged -> today's behaviour
    const s = spec([visual("v1", "m1"), visual("v2", "m2")]);
    const assets = { m1: asset(flagged), m2: asset(plain) };
    assert.equal(pageSourceNoteReplaced(s, assets), false);
    assert.equal(effectivePageSourceNote(s, assets), MODEL_TEXT);
    assert.ok(footerText(s, assets).includes(MODEL_TEXT));
    assert.ok(readerTextEntries(s, assets).some((e) => e.field === "source_note" && e.text === MODEL_TEXT));
    ok("page, mixed visuals: the model's line is kept and nothing changes");
  }
  { // no visuals / no model line
    assert.equal(pageSourceNoteReplaced({ modules: [] }, {}), false);
    const s = { ...spec([visual("v1", "m1")]), source_note: undefined };
    assert.equal(pageSourceNoteReplaced(s, { m1: asset(flagged) }), false, "nothing to replace, so no warning");
    ok("page without visuals or without a model line: no replacement, no warning");
  }
  { // switch off: the flag in a manifest has no effect
    process.env.NEWSROOM_LOCAL_SOURCE_NOTE = "0";
    const s = spec([visual("v1", "m1")]);
    const assets = { m1: asset(flagged) };
    assert.equal(pageSourceNoteReplaced(s, assets), false);
    assert.equal(effectivePageSourceNote(s, assets), MODEL_TEXT);
    assert.ok(footerText(s, assets).includes(MODEL_TEXT));
    ok("switch off: a flagged manifest changes nothing on the page");
  }
}
setEnv({});
console.log(`${results.length} checks -- PASS`);
