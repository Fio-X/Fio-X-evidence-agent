#!/usr/bin/env node
// Covers the waffle chart type (task G1): a percentage waffle showing a
// share out of 100 for one to four items as a 10x10 grid of unit cells per
// row. Exercises the same surfaces every other chart-type test in this
// suite does - lintVizSpec's blocking checks, the rendered SVG's cell
// geometry/highlight/locale behaviour, and the product's own render-QA
// gates (runtime/pi/render_qa.mjs, composing render_qa_geometry.mjs and
// render_qa_contrast.mjs) - rather than approximating them.
import assert from "node:assert/strict";
import { critiqueViz, lintVizSpec, renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const claimId = "claim-waffle-fixture";

const base = {
  schema_version: "0.9.0",
  reader_task: "part_to_whole",
  takeaway: "Two of these four countries already draw most final energy consumption from renewables.",
  title: "Renewable share of final energy consumption",
  alt: "A percentage waffle chart showing four countries' renewable energy share out of 100, one 10 by 10 grid per country.",
  source_note: "World Bank fixture, indicator EG.FEC.RNEW.ZS",
  claim_id: claimId,
  sql: "SELECT country, renewable_energy_consumption_pct, year FROM fixture",
  unit: "%",
  chart_type: "waffle",
  category_field: "country",
  value_field: "renewable_energy_consumption_pct",
  reference_period_field: "year",
  highlight_values: [],
  annotations: [],
};

function rowsOf(values, year = 2022) {
  const names = ["Guinea", "Sierra Leone", "Congo, Dem. Rep.", "Liberia"];
  return values.map((v, i) => ({ country: names[i], renewable_energy_consumption_pct: v, year }));
}

// --- lint: 1 to 4 rows is fine; 5 is blocked and tells the model to filter
{
  for (const count of [1, 2, 3, 4]) {
    const rows = rowsOf(Array.from({ length: count }, (_, i) => 20 + i * 15));
    const lint = lintVizSpec(base, rows, { verified_claim_ids: [claimId] });
    assert.equal(lint.passed, true, `n=${count} rows should lint clean: ${lint.blockers.join("; ")}`);
  }
  const rows5 = rowsOf([10, 20, 30, 40, 50]);
  const lint5 = lintVizSpec(base, rows5, { verified_claim_ids: [claimId] });
  assert.equal(lint5.passed, false);
  assert.ok(lint5.blockers.some((b) => b.includes("waffle has 5 rows") && b.toLowerCase().includes("filter rows in sql")), lint5.blockers.join("; "));
}
console.log("waffle lint: 1-4 rows pass, 5 rows blocked with a filter-in-SQL message -- PASS");

// --- lint: unit must be '%'
{
  const rows = rowsOf([10, 20]);
  const lint = lintVizSpec({ ...base, unit: "count" }, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes("waffle requires unit='%'")), lint.blockers.join("; "));
}
console.log("waffle lint: non-percent unit is blocked -- PASS");

// --- lint: every value must be finite and in [0, 100]
{
  const outOfRangeHigh = lintVizSpec(base, rowsOf([50, 140]), { verified_claim_ids: [claimId] });
  assert.equal(outOfRangeHigh.passed, false);
  assert.ok(outOfRangeHigh.blockers.some((b) => b.includes("must be between 0 and 100")), outOfRangeHigh.blockers.join("; "));

  const outOfRangeNegative = lintVizSpec(base, rowsOf([-5, 50]), { verified_claim_ids: [claimId] });
  assert.equal(outOfRangeNegative.passed, false);
  assert.ok(outOfRangeNegative.blockers.some((b) => b.includes("must be between 0 and 100")), outOfRangeNegative.blockers.join("; "));

  const nonFinite = lintVizSpec(base, [{ country: "Guinea", renewable_energy_consumption_pct: "n/a", year: 2022 }], { verified_claim_ids: [claimId] });
  assert.equal(nonFinite.passed, false);
  assert.ok(nonFinite.blockers.some((b) => b.includes("non-numeric or missing values")), nonFinite.blockers.join("; "));
}
console.log("waffle lint: out-of-range and non-finite values are blocked -- PASS");

// --- lint: reference_line annotations are not supported on waffle
{
  const spec = { ...base, annotations: [{ type: "reference_line", text: "Target: 50", value: 50, claim_id: claimId }] };
  const lint = lintVizSpec(spec, rowsOf([30, 60]), { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b === "annotations[0] reference_line is not supported on chart_type 'waffle'"), lint.blockers.join("; "));
}
console.log("waffle lint: reference_line annotations are blocked -- PASS");

// --- cell counts: exactly 100 cells per grid, filled = Math.round(value),
//     filled row-major from the top-left (the first `filled` cells in
//     document order are navy, the rest are the track colour)
{
  const values = [36.5, 82.4]; // Math.round -> 37, 82
  const rows = rowsOf(values);
  const lint = lintVizSpec(base, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(base, rows, { mobilePages: false });
  const cells = [...desktop.matchAll(/<rect data-role="waffle-cell"[^>]*fill="(#[0-9a-fA-F]{6})"\/>/g)].map((m) => m[1]);
  assert.equal(cells.length, rows.length * 100, "expected exactly 100 cells per grid");
  // House style is now the default (see styleFor/applyStyle in viz.mjs):
  // PALETTE.navy is the single accent red "#D0021B" (was legacy navy
  // "#1d3557") and PALETTE.track is the grid grey "#E5E5E5" (was legacy
  // "#efece6") - colour-only change.
  const NAVY = "#D0021B", TRACK = "#E5E5E5";
  const expectedFilled = values.map((v) => Math.round(v));
  for (let g = 0; g < rows.length; g++) {
    const grid = cells.slice(g * 100, g * 100 + 100);
    const filled = expectedFilled[g];
    assert.deepEqual(grid.slice(0, filled), Array(filled).fill(NAVY), `grid ${g} first ${filled} cells should be navy`);
    assert.deepEqual(grid.slice(filled), Array(100 - filled).fill(TRACK), `grid ${g} remaining cells should be track`);
  }
}
console.log("waffle cells: 100 per grid, filled = Math.round(value), row-major from the top-left -- PASS");

// --- cell counts: boundary values 0 and 100
{
  const rows = rowsOf([0, 100]);
  const lint = lintVizSpec(base, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(base, rows, { mobilePages: false });
  const cells = [...desktop.matchAll(/<rect data-role="waffle-cell"[^>]*fill="(#[0-9a-fA-F]{6})"\/>/g)].map((m) => m[1]);
  assert.equal(cells.slice(0, 100).filter((c) => c === "#D0021B").length, 0, "0% should fill no cells");
  assert.equal(cells.slice(100, 200).filter((c) => c === "#D0021B").length, 100, "100% should fill every cell");
}
console.log("waffle cells: 0% and 100% boundary values -- PASS");

// --- highlight_values: the matching row's numeral uses PALETTE.accent,
//     others use PALETTE.ink
{
  const rows = rowsOf([24, 61, 45]);
  const spec = { ...base, highlight_values: ["Sierra Leone"] };
  const lint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(spec, rows, { mobilePages: false });
  // House style is now the default: PALETTE.accent is "#D0021B" (was
  // legacy "#d1493f") and PALETTE.ink is "#1A1A1A" (was legacy "#202124").
  assert.match(desktop, /font-weight="900"[^>]*fill="#D0021B"><tspan>61%<\/tspan>/, "highlighted row's numeral should use PALETTE.accent");
  assert.match(desktop, /font-weight="900"[^>]*fill="#1A1A1A"><tspan>24%<\/tspan>/, "non-highlighted row's numeral should use PALETTE.ink");
  assert.match(desktop, /font-weight="900"[^>]*fill="#1A1A1A"><tspan>45%<\/tspan>/, "non-highlighted row's numeral should use PALETTE.ink");
}
console.log("waffle highlight_values: matching row's numeral uses PALETTE.accent -- PASS");

// --- en title: category label renders the raw category_field value, and
//     the optional reference_period_field renders as a small muted tspan
{
  const rows = rowsOf([28, 73]);
  const lint = lintVizSpec(base, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(base, rows);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.match(svg, />Guinea<\/text>/, `${viewport} should render the en category label`);
    assert.match(svg, />Sierra Leone<\/text>/, `${viewport} should render the en category label`);
    assert.match(svg, /<tspan dx="6"[^>]*>2022<\/tspan>/, `${viewport} should render the optional reference_period_field tspan`);
  }
  const critic = critiqueViz(base, rows, lint, desktop);
  assert.equal(critic.passed, true, JSON.stringify(critic));
}
console.log("waffle en title/category labels and optional period tspan (desktop/mobile) -- PASS");

// --- zh title: chart title and category labels carry CJK, and lint's zh
//     check (title must contain CJK) passes
{
  const zhSpec = {
    ...base,
    language: "zh",
    title: "四国可再生能源占比",
    alt: "四个国家可再生能源占最终能源消费比例的百分比华夫饼图。",
  };
  const zhRows = [
    { country: "几内亚", renewable_energy_consumption_pct: 28, year: 2022 },
    { country: "塞拉利昂", renewable_energy_consumption_pct: 73, year: 2022 },
  ];
  const lint = lintVizSpec(zhSpec, zhRows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop, mobile } = renderVizBundle(zhSpec, zhRows);
  for (const [viewport, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.match(svg, />几内亚<\/text>/, `${viewport} should render the zh category label`);
    assert.match(svg, />塞拉利昂<\/text>/, `${viewport} should render the zh category label`);
  }
  const critic = critiqueViz(zhSpec, zhRows, lint, desktop);
  assert.equal(critic.passed, true, JSON.stringify(critic));
}
console.log("waffle zh title and category labels (desktop/mobile) -- PASS");

// --- category_names on a zh waffle: World Bank rows show the vendored zh
//     name; matching (highlight) still uses the raw value; an unmapped name
//     is blocked
{
  const zhSpec = {
    ...base,
    language: "zh",
    category_names: "worldbank",
    title: "可再生能源占比最高与最低",
    alt: "两个国家可再生能源占最终能源消费比例的百分比华夫饼图。",
    highlight_values: ["Mauritania"],
  };
  const rows = [
    { country: "Congo, Dem. Rep.", renewable_energy_consumption_pct: 96.3, year: 2021 },
    { country: "Mauritania", renewable_energy_consumption_pct: 19.6, year: 2021 },
  ];
  const lint = lintVizSpec(zhSpec, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(zhSpec, rows);
  assert.match(desktop, />刚果（金）<\/text>/);
  assert.match(desktop, />毛里塔尼亚<\/text>/);
  assert.doesNotMatch(desktop, /Congo, Dem\. Rep\./);
  const numeralFill = (value) => desktop.match(new RegExp(`fill="(#[0-9a-fA-F]{6})"[^>]*><tspan>${value.replace(".", "\\.")}%`))?.[1];
  assert.notEqual(numeralFill("19.6"), numeralFill("96.3"), "highlight still matches the raw World Bank name");
  const unmapped = lintVizSpec(zhSpec, [...rows.slice(0, 1), { ...rows[1], country: "DR Congo" }], { verified_claim_ids: [claimId] });
  assert.equal(unmapped.passed, false);
  assert.ok(unmapped.blockers.some((item) => item.includes("'DR Congo'")), unmapped.blockers.join("; "));
}
console.log("waffle category_names: zh World Bank names, raw-value highlight, unmapped blocked -- PASS");

// --- render-QA: the rendered SVG passes the product's geometry and
//     contrast gates at every supported row count (1-4), both viewports
{
  const names = ["Guinea", "Sierra Leone", "Congo, Dem. Rep.", "Liberia"];
  for (let count = 1; count <= 4; count++) {
    const values = Array.from({ length: count }, (_, i) => 18 + i * 19.3);
    const rows = values.map((v, i) => ({ country: names[i], renewable_energy_consumption_pct: v, year: 2022 }));
    const spec = { ...base, highlight_values: [names[count - 1]] };
    const lint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
    assert.equal(lint.passed, true, `n=${count}: ${lint.blockers.join("; ")}`);
    const bundle = renderVizBundle(spec, rows);
    const qa = runRenderQa({ desktop: bundle.desktop, mobile: bundle.mobile });
    assert.equal(qa.passed, true, `n=${count} render-QA failed: ${JSON.stringify(qa.viewports, null, 2)}`);
    assert.equal(qa.failure_count, 0, `n=${count}`);
  }
}
console.log("waffle render-QA: geometry and contrast gates pass at n=1..4 (desktop/mobile) -- PASS");

console.log("waffle chart: PASS");
