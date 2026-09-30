#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { critiqueViz, lintVizSpec, renderVizBundle, renderVizMobileSvg, renderVizSvg, hashRows } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ""; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((v) => v !== ""));
  return body.map((values) => Object.fromEntries(head.map((key, i) => [key, key === "country" ? values[i] : Number(values[i])])));
}

const csv = await readFile(new URL("../fixtures/world-bank-renewable-latest.csv", import.meta.url), "utf8");
const rows = parseCsv(csv);
assert.equal(rows.length, 11);

const claimId = "claim-fixture-verified";
const common = {
  schema_version: "0.7.0",
  reader_task: "ranking",
  takeaway: "The fixture mixes observation years, so a single latest ranking would be misleading.",
  title: "Countries split into two observation years",
  subtitle: "Renewable energy consumption as a share of total final energy consumption",
  alt: "Two panels separate countries observed in 2021 from countries observed in 2022, preventing a misleading single ranking across mixed years.",
  source_note: "World Bank fixture, indicator EG.FEC.RNEW.ZS",
  note: "Observation years differ across countries in the fixture.",
  claim_id: claimId,
  sql: "SELECT country, year, renewable_energy_consumption_pct FROM read_csv_auto('data/world-bank-renewable-latest.csv')",
  unit: "%",
  value_field: "renewable_energy_consumption_pct",
  reference_period_field: "year",
  sort: "desc",
  direct_labels: true,
  annotations: [],
};

const bad = {
  ...common,
  chart_type: "horizontal_bar",
  category_field: "country",
  mixed_period_strategy: "reject",
};
const badLint = lintVizSpec(bad, rows, { verified_claim_ids: [claimId] });
assert.equal(badLint.passed, false);
assert.ok(badLint.blockers.some((item) => item.includes("Mixed reference periods")));

const good = {
  ...common,
  reader_task: "comparison",
  chart_type: "small_multiples",
  x_field: "country",
  facet_field: "year",
  panel_mark: "dot",
  mixed_period_strategy: "facet",
  highlight_values: ["Congo, Dem. Rep."],
  annotations: [{
    type: "point",
    text: "Highest 2021 value in this fixture",
    claim_id: claimId,
    match_field: "country",
    match_value: "Congo, Dem. Rep.",
  }],
};
const goodLint = lintVizSpec(good, rows, { verified_claim_ids: [claimId] });
assert.equal(goodLint.passed, true, goodLint.blockers.join(" | "));
assert.equal(goodLint.data_hash, hashRows(rows));
assert.equal(hashRows([{ value: 23747.0703125 }]), hashRows([{ value: "23747.070313" }]));
const svg = renderVizSvg(good, rows);
assert.match(svg, /2021/);
assert.match(svg, /2022/);
assert.match(svg, /Source: World Bank fixture/);
assert.doesNotMatch(svg, /rotate\(/);
assert.match(svg, /role="img"/);
assert.match(svg, /Highest 2021 value in this fixture/);
const critic = critiqueViz(good, rows, goodLint, svg);
assert.equal(critic.passed, true, JSON.stringify(critic));
assert.ok(critic.score >= 90);

const responsive = renderVizBundle(good, rows);
assert.match(responsive.desktop, /viewBox="0 0 1040 /);
assert.match(responsive.desktop, /data-viewport="desktop"/);
assert.match(responsive.mobile, /viewBox="0 0 640 /);
assert.match(responsive.mobile, /data-viewport="mobile"/);
assert.match(responsive.mobile, /Source: World Bank fixture/);
assert.match(responsive.mobile, /Highest 2021 value/);
assert.ok(responsive.mobile.indexOf(">2021<") < responsive.mobile.indexOf(">2022<"), "time facets should render in chronological order");

const collisionRows = [
  { entity: "A", x: 1, y: 50.0 },
  { entity: "B", x: 2, y: 50.2 },
  { entity: "C", x: 3, y: 50.4 },
];
const collisionSpec = {
  schema_version: "0.7.0",
  reader_task: "correlation",
  takeaway: "Nearby points need readable annotation lanes.",
  chart_type: "scatter",
  title: "Collision-aware annotation test",
  alt: "Three nearby scatter points have annotations that are separated into distinct label lanes.",
  source_note: "Synthetic regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
  unit: "index",
  x_field: "x",
  y_field: "y",
  label_field: "entity",
  annotations: collisionRows.map((row) => ({ type: "point", text: `Annotation ${row.entity}`, claim_id: claimId, match_field: "entity", match_value: row.entity })),
};
const collisionMobile = renderVizMobileSvg(collisionSpec, collisionRows);
const annotationYs = [...collisionMobile.matchAll(/data-role="annotation"[^>]* y="([0-9.]+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
assert.equal(annotationYs.length, 3);
for (let i = 1; i < annotationYs.length; i++) assert.ok(annotationYs[i] - annotationYs[i - 1] >= 15, `annotation baselines collided: ${annotationYs}`);

const scatterJointSpec = { ...collisionSpec, highlight_values: ["A", "B", "C"] };
const scatterJointMobile = renderVizMobileSvg(scatterJointSpec, collisionRows);
const scatterDirectYs = [...scatterJointMobile.matchAll(/data-role="direct-label"[^>]* y="([0-9.]+)"/g)].map((m) => Number(m[1])).sort((a,b)=>a-b);
assert.equal(scatterDirectYs.length,3);
for (let i=1;i<scatterDirectYs.length;i++) assert.ok(scatterDirectYs[i]-scatterDirectYs[i-1]>=15, `scatter direct labels collided: ${scatterDirectYs}`);
const scatterAnnotationYs = [...scatterJointMobile.matchAll(/data-role="annotation"[^>]* y="([0-9.]+)"/g)].map((m)=>Number(m[1]));
for (const ay of scatterAnnotationYs) for (const dy of scatterDirectYs) assert.ok(Math.abs(ay-dy)>=15, `scatter annotation/direct label collision: annotation=${ay} direct=${dy}`);

const directLabelRows = [
  { year: 2020, series: "Alpha", value: 50.0 }, { year: 2021, series: "Alpha", value: 50.0 },
  { year: 2020, series: "Beta", value: 50.1 }, { year: 2021, series: "Beta", value: 50.1 },
  { year: 2020, series: "Gamma", value: 50.2 }, { year: 2021, series: "Gamma", value: 50.2 },
];
const directLabelSpec = {
  schema_version: "0.7.0",
  reader_task: "change",
  takeaway: "Direct labels should remain separated when line endpoints are close.",
  chart_type: "multi_line",
  title: "Collision-aware direct label test",
  alt: "Three series end at nearly identical values while their direct labels remain visually separated.",
  source_note: "Synthetic regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
  unit: "index",
  x_field: "year",
  value_field: "value",
  series_field: "series",
  direct_labels: true,
  annotations: [],
};
const directLabelMobile = renderVizMobileSvg(directLabelSpec, directLabelRows);
// Fix 5 (end label crosses its own line): an end label that doesn't fit on
// one line now splits into a name line and a value+unit line (see
// layoutLineEndLabel in viz.mjs), so a series can contribute either one or
// two data-role="direct-label" text nodes - this fixture's three values
// (50.0/50.1/50.2) are close enough that all three combined "Name NN.N
// index" labels overflow mobile's margin and split. Group nodes back into
// one entry per series - a lone name-only line (an exact match on the series
// name) is always immediately followed by its value+unit line, in the same
// order the renderer pushes them - and use the pair's value line as the
// series' canonical y, the same labelY separateLabelBaselines() spaces apart
// (a label that stays on one line already carries that same labelY).
const directLabelSeries = ["Alpha", "Beta", "Gamma"];
const directLabelNodes = [...directLabelMobile.matchAll(/<text data-role="direct-label"[^>]* y="([0-9.]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ y: Number(m[1]), text: m[2] }));
const directLabelYs = [];
for (let i = 0; i < directLabelNodes.length; i++) {
  const node = directLabelNodes[i];
  if (directLabelSeries.includes(node.text)) {
    const valueLine = directLabelNodes[i + 1];
    assert.ok(valueLine, `series name line "${node.text}" had no following value line: ${JSON.stringify(directLabelNodes)}`);
    directLabelYs.push(valueLine.y);
    i++;
  } else {
    directLabelYs.push(node.y);
  }
}
assert.equal(directLabelYs.length, 3, `expected exactly one logical label per series: ${JSON.stringify(directLabelNodes)}`);
directLabelYs.sort((a, b) => a - b);
for (let i = 1; i < directLabelYs.length; i++) assert.ok(directLabelYs[i] - directLabelYs[i - 1] >= 14, `direct labels collided: ${directLabelYs}`);
// This fixture's three close-together values already exercised the exact
// defect fix 5 resolves - two of its three end labels crossed the polyline
// they name (text_crosses_data_mark) even though their Y positions were
// already correctly de-collided; that X-axis crossing is now fixed too, so
// lock it in going forward rather than only checking Y-spacing.
const directLabelCrossings = checkSvgGeometry(directLabelMobile).failures.filter((f) => f.rule === "text_crosses_data_mark");
assert.deepEqual(directLabelCrossings, [], `direct labels must not cross their own series' line: ${JSON.stringify(directLabelCrossings)}`);

const unverifiedAnnotation = { ...good, annotations: [{ ...good.annotations[0], claim_id: "claim-not-verified" }] };
const badAnnotationLint = lintVizSpec(unverifiedAnnotation, rows, { verified_claim_ids: [claimId] });
assert.equal(badAnnotationLint.passed, false);
assert.ok(badAnnotationLint.blockers.some((item) => item.includes("annotations[0].claim_id")));

const cluttered = {
  ...good,
  title: "This deliberately overlong newsroom visualization title is designed to trigger the editorial critic because it will wrap heavily on narrow displays and dilute the hierarchy",
  highlight_values: ["Congo, Dem. Rep.", "Zambia", "Nigeria", "Niger", "Congo, Rep."],
  annotations: rows.slice(0, 5).map((row) => ({ type: "point", text: `Annotation for ${row.country}`, claim_id: claimId, match_field: "country", match_value: row.country })),
};
const clutterLint = lintVizSpec(cluttered, rows, { verified_claim_ids: [claimId] });
assert.equal(clutterLint.passed, true, clutterLint.blockers.join(" | "));
const clutterSvg = renderVizSvg(cluttered, rows);
const clutterCritic = critiqueViz(cluttered, rows, clutterLint, clutterSvg);
assert.equal(clutterCritic.passed, false);
assert.ok(clutterCritic.score < 75);
assert.ok(clutterCritic.issues.some((item) => item.code === "too_many_highlights"));

const unverified = lintVizSpec({ ...good, claim_id: "claim-not-verified" }, rows, { verified_claim_ids: [claimId] });
assert.equal(unverified.passed, false);
assert.ok(unverified.blockers.some((item) => item.includes("not a verified recorded claim")));

// Exploratory visual work may run before a factual claim is reviewed, but the
// resulting artifact must carry an explicit DRAFT/non-publishable status.
const draft = {
  ...good,
  verification_mode: "draft",
  claim_id: undefined,
  annotations: [{ ...good.annotations[0], claim_id: undefined }],
};
const draftLint = lintVizSpec(draft, rows, { verified_claim_ids: [] });
assert.equal(draftLint.passed, true, draftLint.blockers.join(" | "));
assert.equal(draftLint.artifact_status, "DRAFT");
assert.equal(draftLint.publishable, false);
assert.ok(draftLint.warnings.some((item) => item.includes("DRAFT visualization")));
const missingVerifiedClaim = lintVizSpec({ ...good, verification_mode: "verified", claim_id: undefined }, rows, { verified_claim_ids: [] });
assert.equal(missingVerifiedClaim.passed, false);
assert.ok(missingVerifiedClaim.blockers.some((item) => item.includes("requires claim_id")));

// --- B1: chart language field ----------------------------------------------
// language defaults to "en"; setting it to "zh" requires the model's own
// title/subtitle copy to actually be Chinese, and every string the renderer
// adds on its own (note/source prefixes) must switch with it.
const zhGood = {
  ...good,
  language: "zh",
  title: "各国分为两个观测年份",
  subtitle: "占最终能源消费总量的可再生能源份额",
};
const zhGoodLint = lintVizSpec(zhGood, rows, { verified_claim_ids: [claimId] });
assert.equal(zhGoodLint.passed, true, zhGoodLint.blockers.join(" | "));
const zhSvg = renderVizSvg(zhGood, rows);
assert.match(zhSvg, /注：/);
assert.match(zhSvg, /数据来源：/);
assert.doesNotMatch(zhSvg, /\bNote:\s/);
assert.doesNotMatch(zhSvg, /\bSource:\s/);
console.log("zh chart: renderer-added Note/Source strings localized: PASS");

const zhTitleOnlyEnglish = { ...zhGood, title: good.title };
const zhTitleLint = lintVizSpec(zhTitleOnlyEnglish, rows, { verified_claim_ids: [claimId] });
assert.equal(zhTitleLint.passed, false);
assert.ok(zhTitleLint.blockers.includes("zh chart title contains no CJK characters"), zhTitleLint.blockers.join(" | "));

const zhSubtitleOnlyEnglish = { ...zhGood, subtitle: good.subtitle };
const zhSubtitleLint = lintVizSpec(zhSubtitleOnlyEnglish, rows, { verified_claim_ids: [claimId] });
assert.equal(zhSubtitleLint.passed, false);
assert.ok(zhSubtitleLint.blockers.includes("zh chart subtitle contains no CJK characters"), zhSubtitleLint.blockers.join(" | "));

const badLanguageLint = lintVizSpec({ ...good, language: "fr" }, rows, { verified_claim_ids: [claimId] });
assert.equal(badLanguageLint.passed, false);
assert.ok(badLanguageLint.blockers.includes("language must be 'en' or 'zh'"), badLanguageLint.blockers.join(" | "));
console.log("zh chart CJK-title/subtitle lint and language validity: PASS");

// --- B2: reference_line annotations -----------------------------------------
// The viz annotation schema previously allowed only point/node, so a plan
// could never ask for a threshold/target rule on the value axis.
const refLineRows = [
  { category: "A", value: 42 }, { category: "B", value: 31 }, { category: "C", value: 18 }, { category: "D", value: 9 },
];
const refLineSpec = {
  schema_version: "0.7.0",
  reader_task: "ranking",
  takeaway: "Most categories sit above the fixed 30-unit threshold",
  chart_type: "horizontal_bar",
  title: "Four categories against a fixed threshold",
  alt: "Horizontal bars for four categories, each compared against a labeled 30-unit reference line.",
  source_note: "Synthetic regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic_ref_line",
  unit: "units",
  category_field: "category",
  value_field: "value",
  sort: "desc",
  direct_labels: true,
  annotations: [{ type: "reference_line", text: "Target: 30", value: 30, claim_id: claimId }],
};
const refLineLint = lintVizSpec(refLineSpec, refLineRows, { verified_claim_ids: [claimId] });
assert.equal(refLineLint.passed, true, refLineLint.blockers.join(" | "));
const refLineSvg = renderVizSvg(refLineSpec, refLineRows);
assert.match(refLineSvg, /data-role="reference-line"/);
assert.match(refLineSvg, /data-role="reference-line-label"[^>]*>Target: 30</);
const refLineBundle = renderVizBundle(refLineSpec, refLineRows);
assert.match(refLineBundle.mobile, /data-role="reference-line"/);
assert.match(refLineBundle.mobile, /data-role="reference-line-label"/);
console.log("reference_line renders on horizontal_bar (desktop+mobile): PASS");

const outOfDomain = { ...refLineSpec, annotations: [{ type: "reference_line", text: "Off scale", value: 50, claim_id: claimId }] };
const outOfDomainLint = lintVizSpec(outOfDomain, refLineRows, { verified_claim_ids: [claimId] });
assert.equal(outOfDomainLint.passed, false);
assert.ok(outOfDomainLint.blockers.includes("annotations[0] reference_line value 50 is outside the value axis domain [0, 42]"), outOfDomainLint.blockers.join(" | "));

const scatterRefLine = lintVizSpec({ ...collisionSpec, annotations: [{ type: "reference_line", text: "Target", value: 50, claim_id: claimId }] }, collisionRows, { verified_claim_ids: [claimId] });
assert.equal(scatterRefLine.passed, false);
assert.ok(scatterRefLine.blockers.some((item) => item.includes("reference_line is not supported on chart_type 'scatter'")));

const multiLineRefLine = lintVizSpec({ ...directLabelSpec, annotations: [{ type: "reference_line", text: "Target", value: 50, claim_id: claimId }] }, directLabelRows, { verified_claim_ids: [claimId] });
assert.equal(multiLineRefLine.passed, false);
assert.ok(multiLineRefLine.blockers.some((item) => item.includes("reference_line is not supported on chart_type 'multi_line'")));
console.log("reference_line lint: blocked on unsupported chart_type and out-of-domain value: PASS");

const refLineDraftMissingClaim = lintVizSpec({ ...refLineSpec, verification_mode: "draft", claim_id: undefined, annotations: [{ type: "reference_line", text: "Target: 30", value: 30 }] }, refLineRows, { verified_claim_ids: [] });
assert.equal(refLineDraftMissingClaim.passed, true, refLineDraftMissingClaim.blockers.join(" | "));
const refLineVerifiedMissingClaim = lintVizSpec({ ...refLineSpec, annotations: [{ type: "reference_line", text: "Target: 30", value: 30 }] }, refLineRows, { verified_claim_ids: [claimId] });
assert.equal(refLineVerifiedMissingClaim.passed, false);
assert.ok(refLineVerifiedMissingClaim.blockers.some((item) => item.includes("annotations[0].claim_id is required")));
console.log("reference_line claim_id required unless draft mode (same rule as other annotations): PASS");

if (process.argv.includes("--write-fixture")) {
  await writeFile(new URL("../fixtures/newsroom-viz-v0.5.svg", import.meta.url), responsive.desktop, "utf8");
  await writeFile(new URL("../fixtures/newsroom-viz-v0.5.mobile.svg", import.meta.url), responsive.mobile, "utf8");
  await writeFile(new URL("../fixtures/newsroom-viz-v0.5-lint.json", import.meta.url), JSON.stringify({ bad: badLint, good: goodLint }, null, 2) + "\n", "utf8");
}

console.log("viz tests: PASS");
console.log(`mixed-year ranking blockers: ${badLint.blockers.length}`);
console.log(`faceted newsroom viz lint: ${goodLint.passed ? "PASS" : "FAIL"}`);
console.log(`data hash: ${goodLint.data_hash}`);
console.log(`critic score: ${critic.score}/100`);
console.log("responsive desktop/mobile render: PASS");
console.log("annotation collision layout: PASS");
console.log("scatter unified label/annotation collision layout: PASS");
console.log("direct-label collision layout: PASS");
console.log(`cluttered critic score: ${clutterCritic.score}/100 (expected revise)`);
