#!/usr/bin/env node
// #232: with NEWSROOM_EMBED_MIN_TEXT=1 and NEWSROOM_QA_TICK_READBACK=1, a horizontal bar chart drawn again at its slot width is tick-read-back before the
// page may use it. The page's chart check is embeddedChartCheck in newsroom.ts (render QA with the chart's own options, then the critic); this test runs that
// real function (newsroom.ts loaded as a type-stripped copy with one test-only export appended to the copy) and the real page composer.
// Tests only: no runtime source is changed. Every edit is made on a copy of the redrawn picture's text; the mutants are made in a copy of the runtime tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";
import { stub, TYPEBOX, ROOT } from "./lib_page_chain_fixture.mjs";

const EMBED = "NEWSROOM_EMBED_MIN_TEXT";
const TICK = "NEWSROOM_QA_TICK_READBACK";
const saved = { [EMBED]: process.env[EMBED], [TICK]: process.env[TICK] };
const setEnv = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

// a copy of the runtime tree (with the two stubs newsroom.ts needs), optionally patched file by file; returns the real embeddedChartCheck and page composer
async function loadTree(label, patches = {}) {
  const dir = makeTestTmp(`embed-tick-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  for (const [file, patch] of Object.entries(patches)) {
    if (file === "newsroom.ts") continue;
    writeFileSync(join(pi, file), patch(readFileSync(join(pi, file), "utf8")));
  }
  let news = readFileSync(join(pi, "newsroom.ts"), "utf8");
  if (patches["newsroom.ts"]) news = patches["newsroom.ts"](news);
  news += "\nexport const __embeddedChartCheckForTest = embeddedChartCheck;\n";
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(news, { mode: "strip" }));
  const mod = await import(pathToFileURL(join(pi, "newsroom.test-copy.mjs")).href);
  const viz = await import(pathToFileURL(join(pi, "viz.mjs")).href);
  const info = await import(pathToFileURL(join(pi, "infographic.mjs")).href);
  return { check: mod.__embeddedChartCheckForTest, viz, info };
}
const swap = (s, a, b) => { assert.ok(s.includes(a), `mutant target not found: ${a}`); return s.replace(a, () => b); };

const claimId = "claim-redraw-tick";
const spec = {
  schema_version: "0.7.0", reader_task: "ranking", takeaway: "Synthetic redraw takeaway.", title: "Synthetic redraw fixture", subtitle: "In-memory rendering only",
  alt: "Synthetic chart used to check the read-back of a chart drawn again at its slot width.", source_note: "Synthetic redraw fixture", claim_id: claimId, sql: "SELECT 1",
  unit: "%", sort: "desc", highlight_values: ["A"], direct_labels: true, annotations: [], chart_type: "horizontal_bar", category_field: "category", value_field: "value",
};
const rows = Array.from({ length: 8 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3 }));
const inputs = { spec, rows };
const sha = (text) => createHash("sha256").update(text).digest("hex");

function page(info, ref, asset, check) {
  const pageSpec = {
    schema_version: "1.0.0", kicker: "TEST", title: "A narrow slot keeps the type size", dek: "Redraw at slot width fixture.",
    alt: "A page with one narrow chart and two text blocks, used to check chart redraw at slot width.", byline: "Newsroom Agent", date_label: "Test", layout: "feature", complexity_budget: "low", source_note: "Synthetic",
    modules: [
      { id: "v", type: "visual", span: "third", label: "Chart", manifest_ref: ref },
      { id: "t0", type: "text", span: "third", label: "Note", heading: "A note", body: "A second short block that fills the row beside the narrow chart.", claim_ids: [claimId] },
      { id: "t", type: "text", span: "third", label: "Why", heading: "Why it matters", body: "A chart drawn for a wide slot and squeezed into a narrow one shrinks its labels; drawing it again at the narrow width keeps them readable.", claim_ids: [claimId] },
    ],
  };
  return info.composeInfographicBundle(pageSpec, { [ref]: asset }, { mobilePages: false, chartCheck: check });
}

// the edits, each changing one field of the redrawn picture
const edit = (svg, find, replace) => { assert.ok(svg.includes(find), `edit target not found: ${find}`); return svg.replace(find, () => replace); };
const edits = {
  "tick text": (svg) => { const m = [...svg.matchAll(/(<text [^>]*data-role="axis-tick-label"[^>]*>)([^<]*)(<\/text>)/g)][1]; return edit(svg, m[0], `${m[1]}999${m[3]}`); },
  "tick position": (svg) => { const t = [...svg.matchAll(/<text [^>]*data-role="axis-tick-label"[^>]*>/g)][1][0]; const x = /\bx="([\d.]+)"/.exec(t)[1]; return edit(svg, t, t.replace(`x="${x}"`, `x="${Number(x) + 6}"`)); },
  "bar value": (svg) => { const m = /data-role="data-bar"[^>]*data-value="(\d+)"/.exec(svg); return edit(svg, m[0], m[0].replace(`data-value="${m[1]}"`, `data-value="${Number(m[1]) * 3}"`)); },
  "value label": (svg) => { const m = /(<text [^>]*data-role="value-label"[^>]*>)([^<]*)(<\/text>)/.exec(svg); return edit(svg, m[0], `${m[1]}9${m[2].slice(1)}${m[3]}`); },
};

// everything the suite asserts; returns the list of failed expectations so a mutant can be required to produce some
async function suite(tree, label) {
  const fails = [];
  const { check, viz, info } = tree;
  const ref = "visualizations/redraw-tick.json";
  const wide = viz.renderVizSvg(spec, rows);
  const asset = { desktopSvg: wide, mobileSvg: wide, manifest: { claim_id: claimId, chart_type: spec.chart_type }, critic: { passed: true, score: 90 }, inputs, inputsSha256: sha(JSON.stringify(inputs)) };
  const expect = (cond, msg) => { if (!cond) fails.push(`${label}: ${msg}`); };

  setEnv(EMBED, "1");
  setEnv(TICK, "1");
  // case 1: a good redraw is used, and it carries a passing read-back
  const good = page(info, ref, asset, check);
  expect(good.embedded_variants?.length === 1, "a redraw whose ticks read back is used");
  const width = good.embedded_variants?.[0]?.width;
  const redraw = width ? viz.renderVizSvgAtWidth(spec, rows, width) : null;
  expect(redraw !== null && check(inputs, redraw) === true, "the real chart check accepts the good redraw");
  const fallback = page(info, ref, { ...asset, inputs: undefined, inputsSha256: undefined }, check);

  for (const [field, fn] of Object.entries(edits)) {
    const bad = redraw === null ? null : fn(redraw);
    // case 2: the same redraw with one field changed is refused by the real check, and through the page the normal variant is kept
    expect(bad !== null && check(inputs, bad) === false, `${field}: the real chart check refuses the edited redraw`);
    const viaPage = page(info, ref, asset, (inp, svg) => check(inp, fn(svg)));
    expect(viaPage.embedded_variants === undefined, `${field}: the page does not adopt the edited redraw`);
    expect(viaPage.desktop.svg === fallback.desktop.svg, `${field}: the page keeps the normal variant`);
    // the read-back is the reason: with the tick switch off the same edited picture is accepted by the real check (the critic and render QA alone do not see it)
    setEnv(TICK, undefined);
    expect(bad !== null && check(inputs, bad) === true, `${field}: without the tick switch the edit is not what refuses it`);
    setEnv(TICK, "1");
  }

  // case 3: switch matrix: only the exact "1" turns the read-back on
  const bad = redraw === null ? null : edits["tick text"](redraw);
  for (const value of [undefined, "0", "", "yes", " 1", "true"]) {
    setEnv(TICK, value);
    expect(bad !== null && check(inputs, bad) === true, `switch ${JSON.stringify(value)}: no read-back, the edited redraw is not refused for ticks`);
  }
  setEnv(TICK, "1");
  expect(bad !== null && check(inputs, bad) === false, "switch \"1\": the edited redraw is refused");
  return fails;
}

try {
  const real = await loadTree("real");
  const bad = await suite(real, "real");
  assert.deepEqual(bad, [], bad.join("\n"));

  // case 4: mutants, each turning at least one case red
  const mutants = {
    "options-dropped": { "newsroom.ts": (s) => swap(s, "runRenderQa({ desktop: svg }, chartRenderQaOptions(inputs.spec, inputs.rows))", "runRenderQa({ desktop: svg })") },
    "read-back-ignored": { "newsroom.ts": (s) => swap(s, "return qa.passed === true && critiqueViz(", "return critiqueViz(") },
    "check-bypassed": { "infographic.mjs": (s) => swap(s, "if (!(activeChartCheck && activeChartCheck(inputs, svg) === true && textInkInsideEmbedBox(svg)))", "if (!(textInkInsideEmbedBox(svg)))") },
    "tolerance-wide": { "render_qa_ticks.mjs": (s) => swap(s, "export const TICK_POSITION_TOLERANCE = 1.0;", "export const TICK_POSITION_TOLERANCE = 50;") },
  };
  for (const [name, patches] of Object.entries(mutants)) {
    const failures = await suite(await loadTree(`mut-${name}`, patches), `mutant ${name}`);
    assert.ok(failures.length > 0, `mutant must turn a case red: ${name}`);
  }
  console.log(`ok test_embed_redraw_tick: good redraw, ${Object.keys(edits).length} edits (check and page), switch matrix, ${Object.keys(mutants).length} mutants red`);
} finally {
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
}
