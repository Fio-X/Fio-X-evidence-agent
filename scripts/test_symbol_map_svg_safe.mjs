#!/usr/bin/env node
// #218 / K1061: an attribute the symbol map wrote, data-list-only="N", matched the event-handler rule of svg_security.mjs (/\bon\w+\s*=/i: "-only=" has a word
// boundary before "only"), so a page that carried a symbol map was refused at publication ("contains event handler") after every chart-level test and the visual
// review had passed. The attribute is now data-unlabelled. This test runs the product's own assertSafeSvg (the function publication calls) on
//   (1) every variant a symbol_map renders (desktop, mobile),
//   (2) the whole page that embeds it (composeInfographicBundle, the SVG publication hands to assertSafeSvg), desktop and mobile,
//   (3) the new attribute name against each SVG_FORBIDDEN rule on its own,
// and then breaks it on purpose: in a temporary copy of runtime/ the attribute name goes back to data-list-only; the fixture check and the whole-page check must each go red.
// It also records, without fixing, that the event-handler rule matches TEXT content too (sample 4: "onset=5"). TEST FIXTURE data (synthetic world rows). No browser.
// Run: node scripts/test_symbol_map_svg_safe.mjs
import "./group_env_pin.mjs";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
process.env.NEWSROOM_SYMBOL_MAP = "1";
process.env.NEWSROOM_MAP_WORLD = "1";
delete process.env.NEWSROOM_PAGE_POLISH;
const claim = "claim-symbol-safe";

const SPEC = { schema_version: "0.9.0", chart_type: "symbol_map", title: "World", takeaway: "t", subtitle: "synthetic", alt: "A synthetic symbol map.", source_note: "synthetic fixture", source: "synthetic", claim_id: claim, sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh", verification_mode: "draft", reader_task: "spatial", unit: "PJ", category_field: "c", value_field: "v", measure_kind: "count", category_names: "iso3", map_extent: "world", basemap_id: "naturalearth_admin0_50m", basemap_source_url: "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", basemap_license: "Public domain (Natural Earth terms of use)", basemap_content_hash: "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e" };
const ROWS = [["USA", 32000], ["RUS", 14000], ["CHN", 13000], ["DEU", 3100], ["BRA", 1300], ["AUS", 1600], ["NGA", 40], ["ISL", 0.3], ["ZAF", 0], ["JPN", null]].map(([c, v]) => ({ c, v }));

const load = async (root) => {
  const at = (name) => import(pathToFileURL(join(root, "runtime/pi", name)).href);
  return { viz: await at("viz.mjs"), info: await at("infographic.mjs"), sec: await at("svg_security.mjs") };
};

function pageSpec(ref) {
  return {
    schema_version: "1.0.0", kicker: "TEST", title: "A page that embeds a symbol map", dek: "Symbol map publication-safety fixture.",
    alt: "A page with one symbol map and two text blocks, used to check that the page SVG passes the publication safety check.", byline: "Newsroom Agent", date_label: "Test", layout: "feature", complexity_budget: "low", source_note: "Synthetic",
    modules: [
      { id: "v", type: "visual", span: "full", label: "Chart", manifest_ref: ref },
      { id: "t0", type: "text", span: "third", label: "Note", heading: "A note", body: "A short block that fills the row beside the chart.", claim_ids: [claim] },
      { id: "t1", type: "text", span: "third", label: "Why", heading: "Why it matters", body: "A second short block that fills the row beside the chart.", claim_ids: [claim] },
    ],
  };
}

// One line per failure; [] means every SVG the publication path would see passes assertSafeSvg.
async function check(root) {
  const { viz, info, sec } = await load(root);
  const failures = [];
  const bundle = viz.renderVizBundle(SPEC, ROWS, { mobilePages: false });
  assert.ok(bundle.desktop.includes('data-role="symbol-circle"'), "the fixture carries circles");
  assert.ok(bundle.desktop.includes('data-role="symbol-labels"'), "the fixture carries the label group");
  const tryIt = (label, svg) => { try { sec.assertSafeSvg(svg, { label }); } catch (error) { failures.push(`${label}: ${error.message}`); } };
  // (1) the chart's own SVGs; the mobile variant is the desktop one when the bundle has none
  tryIt("fixture desktop", bundle.desktop);
  tryIt("fixture mobile", bundle.mobile ?? bundle.desktop);
  // (2) the whole page, as publication gets it
  const ref = "visualizations/symbol.json";
  const asset = { desktopSvg: bundle.desktop, mobileSvg: bundle.mobile ?? bundle.desktop, manifest: { claim_id: claim, chart_type: "symbol_map" }, critic: { passed: true, score: 90 } };
  const page = info.composeInfographicBundle(pageSpec(ref), { [ref]: asset }, { mobilePages: false });
  assert.ok(page.desktop.svg.includes('data-role="symbol-labels"'), "the page embeds the symbol map's label group");
  tryIt("page desktop", page.desktop.svg);
  tryIt("page mobile", (page.mobile ?? page.desktop).svg);
  return { failures, sec, bundle, page };
}

// ---- real run
const real = await check(REPO);
assert.deepEqual(real.failures, [], `the symbol map's SVGs must pass the publication safety check: ${real.failures.join(" | ")}`);
const { sec, bundle, page } = real;

// (3) the attribute name, rule by rule: none of the SVG_FORBIDDEN patterns matches it, and the old name hits exactly the event-handler rule
assert.ok(bundle.desktop.includes('data-unlabelled="'), "the label group carries data-unlabelled");
assert.ok(!bundle.desktop.includes("data-list-only"), "the old attribute name is gone from the chart");
assert.ok(!page.desktop.svg.includes("data-list-only"), "the old attribute name is gone from the page");
const probe = (attr) => `<g data-role="symbol-labels" data-labelled="3" ${attr}="2">`;
for (const [pattern, reason] of sec.SVG_FORBIDDEN) assert.ok(!pattern.test(probe("data-unlabelled")), `data-unlabelled must not hit the "${reason}" rule`);
const oldHits = sec.SVG_FORBIDDEN.filter(([pattern]) => pattern.test(probe("data-list-only"))).map(([, reason]) => reason);
assert.deepEqual(oldHits, ["event handler"], "the old name hit exactly the event-handler rule");
console.log(`all ${sec.SVG_FORBIDDEN.length} SVG_FORBIDDEN rules pass the chart, the page and the attribute name; the old name hit: ${oldHits.join(", ")}`);

// (4) RECORDED CURRENT BEHAVIOUR, not endorsed and not fixed here: the event-handler rule is a text match over the whole SVG, so ordinary label TEXT that holds a word starting with "on" directly before "=" (e.g. "onset=5") is refused too; a bare "on=" is not matched (the rule needs at least one word character after "on").
// The real cause this time was the same rule on an ATTRIBUTE NAME: a hyphenated name such as data-x-only= matches too (word boundary + "on" + a letter + optional space + "=").
const textSample = '<svg viewBox="0 0 10 10"><text x="1" y="5">Rate (onset=5)</text></svg>';
assert.throws(() => sec.assertSafeSvg(textSample, { label: "sample" }), /contains event handler/, "recorded: label text such as \"onset=5\" is refused as an event handler");
console.log('recorded: assertSafeSvg refuses a <text> whose content matches /\\bon\\w+\\s*=/i ("Rate (onset=5)"); not changed here');

// ---- mutant: the old attribute name in a temporary copy of the runtime
{
  const dir = makeTestTmp("symbol-safe-mutant-");
  cpSync(join(REPO, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(REPO, "config"), join(dir, "config"), { recursive: true });
  const file = join(dir, "runtime/pi/viz.mjs");
  const text = readFileSync(file, "utf8");
  const from = 'data-unlabelled="${labels.listOnly.length}"';
  assert.equal(text.split(from).length - 1, 1, "the mutant target must occur exactly once");
  writeFileSync(file, text.replace(from, () => 'data-list-only="${labels.listOnly.length}"'));
  const { failures } = await check(dir);
  const fixture = failures.filter((f) => f.startsWith("fixture "));
  const whole = failures.filter((f) => f.startsWith("page "));
  assert.ok(fixture.length > 0, "mutant data-list-only stayed green in the fixture check");
  assert.ok(whole.length > 0, "mutant data-list-only stayed green in the whole-page check");
  for (const f of [...fixture, ...whole]) assert.ok(f.includes("event handler"), `the mutant must fail for the event-handler rule, not another one: ${f}`);
  console.log(`mutant red: data-list-only (fixture ${fixture.length}, page ${whole.length}; first: ${failures[0]})`);
}
console.log("test_symbol_map_svg_safe: ok");
