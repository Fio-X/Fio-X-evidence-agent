#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { critiqueViz, lintVizSpec, renderVizBundle, renderVizMobileSvg, renderVizSvg, hashRows } from "../runtime/pi/viz.mjs";

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
const directLabelYs = [...directLabelMobile.matchAll(/data-role="direct-label"[^>]* y="([0-9.]+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
assert.equal(directLabelYs.length, 3);
for (let i = 1; i < directLabelYs.length; i++) assert.ok(directLabelYs[i] - directLabelYs[i - 1] >= 14, `direct labels collided: ${directLabelYs}`);

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
