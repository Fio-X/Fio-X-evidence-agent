#!/usr/bin/env node
// Unit tests for runtime/pi/render_qa_labels.mjs: the independent,
// from-the-rendered-SVG proof that every plotted choropleth region's value is
// shown as complete, exact, legible text - the only thing that lets a
// choropleth's color channel pass infographic lint's color_only_quantity
// blocker (runtime/pi/editorial_validators.mjs's choroplethValueLabelsProven).
//
// These are hand-built SVG fixtures exercising checkChoroplethValueLabels in
// isolation, with the real parseXml (render_qa_svg.mjs), the real
// joinChoroplethRows (choropleth.mjs), the real fmt (viz.mjs) and the real
// live PALETTE.grid (viz.mjs) wired in as deps - exactly as render_qa.mjs
// wires them in production - so a fixture only has to get its own SVG markup
// and options right, not a fake join, formatter, or no-data fill colour that
// could drift from the renderer's own.
import assert from "node:assert/strict";
import { checkChoroplethValueLabels, RENDER_QA_LABELS_VERSION } from "../runtime/pi/render_qa_labels.mjs";
import { parseXml } from "../runtime/pi/render_qa_svg.mjs";
import { joinChoroplethRows } from "../runtime/pi/choropleth.mjs";
import { fmt, PALETTE } from "../runtime/pi/viz.mjs";

const deps = { parseXml, joinChoroplethRows, fmt, noDataFill: PALETTE.grid };

const rows = [
  { country: "Guinea", renewable_energy_consumption_pct: 66.6 },
  { country: "Zambia", renewable_energy_consumption_pct: 83.0 },
];
const options = {
  rows,
  category_field: "country",
  value_field: "renewable_energy_consumption_pct",
  category_names: "worldbank",
  unit: "%",
};

// fmt(66.6, '%') / fmt(83.0, '%') drive the expected label text below; assert
// once here so the fixtures' literal text stays honest about what they claim
// to test if fmt's own formatting ever changes.
const GIN_TEXT = fmt(66.6, "%");
const ZMB_TEXT = fmt(83.0, "%");

function svg(regions) {
  const parts = regions
    .map((r) => {
      const nameRole = r.inset ? "choropleth-inset-label" : "choropleth-label";
      const valueRole = r.inset ? "choropleth-inset-label-value" : "choropleth-label-value";
      let extraName = "";
      let extraValue = "";
      if (r.extraLabelRole) extraName = `<text data-role="${r.extraLabelRole}" data-iso3="${r.iso3}">${r.extraName ?? r.name}</text>`;
      if (r.extraValueRole) extraValue = `<text data-role="${r.extraValueRole}" data-iso3="${r.iso3}"><tspan>${r.extraValueText ?? r.valueText}</tspan></text>`;
      return (
        `<path data-role="choropleth-data" data-iso3="${r.iso3}" data-value="${r.value}" d="M0,0Z"/>` +
        (r.nameLabel !== false ? `<text data-role="${nameRole}" data-iso3="${r.iso3}">${r.name}</text>` : "") +
        (r.valueLabel !== false ? `<text data-role="${valueRole}" data-iso3="${r.iso3}">${r.valueTextRaw ?? `<tspan>${r.valueText}</tspan>`}</text>` : "") +
        extraName +
        extraValue
      );
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>t</title><desc>d</desc>${parts}<path data-role="choropleth-context" fill="${PALETTE.grid}" d="M50,50Z"/></svg>`;
}

// --- version constant is stable and importable ------------------------------
{
  assert.equal(RENDER_QA_LABELS_VERSION, "1.3.0");
}
console.log("unit: RENDER_QA_LABELS_VERSION is stable -- PASS");

// --- complete, matching labels for every plotted region: passes ------------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, true, JSON.stringify(result.failures));
  assert.equal(result.checked, 2);
  assert.deepEqual(result.failures, []);
}
console.log("unit: every plotted region labelled with its exact value -- PASS");

// --- a missing name label fails with value_label_missing --------------------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT, nameLabel: false },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "value_label_missing" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: a region with no visible name label fails -- PASS");

// --- a missing value label fails with value_label_missing -------------------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT, valueLabel: false },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "value_label_missing" && f.message.includes("ZMB")), JSON.stringify(result.failures));
}
console.log("unit: a region with no visible value label fails -- PASS");

// --- a truncated/ellipsized value label fails as a mismatch -----------------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueTextRaw: "66…" },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "value_label_mismatch" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: a truncated/ellipsized value label fails as a mismatch -- PASS");

// --- a value label that shows the wrong number fails as a mismatch ----------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: fmt(12.3, "%") },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "value_label_mismatch" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: a value label showing the wrong number fails as a mismatch -- PASS");

// --- the region's own data-value not matching its row fails independently of
//     what the label text says (catches a renderer/label desync directly) --
{
  const text = svg([
    { iso3: "GIN", value: 1.0, name: "Guinea", valueText: GIN_TEXT },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "region_value_mismatch" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: a region's rendered data-value not matching its row value fails -- PASS");

// --- a plotted row with no rendered region at all fails ---------------------
{
  const text = svg([{ iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT }]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "value_label_missing_region" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: a data row with no rendered choropleth-data region fails -- PASS");

// --- a no-data region not painted the shared no-data fill fails -------------
{
  const good = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const tampered = good.replace(`fill="${PALETTE.grid}"`, 'fill="#3388ff"');
  const result = checkChoroplethValueLabels(tampered, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "no_data_style_missing"), JSON.stringify(result.failures));
}
console.log("unit: a no-data region not painted the shared no-data fill fails -- PASS");

// --- no rows / no matching entries: nothing to check, vacuously passes ------
{
  const result = checkChoroplethValueLabels(svg([]), { ...options, rows: [] }, deps);
  assert.equal(result.passed, true);
  assert.equal(result.checked, 0);
}
console.log("unit: no rows to check passes vacuously with checked=0 -- PASS");

// --- an inset-role label satisfies the proof exactly like a main-map label -
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT, inset: true },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, true, JSON.stringify(result.failures));
  assert.equal(result.checked, 2);
}
console.log("unit: a region labelled only inside the inset panel passes -- PASS");

// --- a region labelled in both the main map and the inset fails as a
//     duplicate, even though both copies agree -----------------------------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT, extraLabelRole: "choropleth-inset-label", extraValueRole: "choropleth-inset-label-value" },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "value_label_duplicate" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: a region labelled in both the main map and the inset fails as a duplicate -- PASS");

// --- a region labelled twice in the inset with different values fails as a
//     duplicate naming the distinct values shown ----------------------------
{
  const text = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT, inset: true, extraValueRole: "choropleth-inset-label-value", extraValueText: "12.3%" },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const result = checkChoroplethValueLabels(text, options, deps);
  assert.equal(result.passed, false);
  assert.ok(
    result.failures.some((f) => f.rule === "value_label_duplicate" && f.message.includes("GIN") && f.message.includes("12.3%")),
    JSON.stringify(result.failures),
  );
}
console.log("unit: a region labelled twice with different values fails as a duplicate naming both -- PASS");

// --- review fix (map extent): a leader longer than the 120px floor fails,
//     measured independently from the leader path's own d geometry --------
{
  const good = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const withLongLeader = good.replace("</svg>", `<path data-role="choropleth-leader" d="M0,0L200,0"/></svg>`);
  const result = checkChoroplethValueLabels(withLongLeader, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "leader_too_long"), JSON.stringify(result.failures));
}
console.log("unit: a choropleth leader over the 120px floor fails -- PASS");

// --- a leader at or under the 120px floor does not fail this rule ----------
{
  const good = svg([
    { iso3: "GIN", value: 66.6, name: "Guinea", valueText: GIN_TEXT },
    { iso3: "ZMB", value: 83.0, name: "Zambia", valueText: ZMB_TEXT },
  ]);
  const withShortLeader = good.replace("</svg>", `<path data-role="choropleth-leader" d="M0,0L100,0"/></svg>`);
  const result = checkChoroplethValueLabels(withShortLeader, options, deps);
  assert.ok(!result.failures.some((f) => f.rule === "leader_too_long"), JSON.stringify(result.failures));
}
console.log("unit: a choropleth leader at or under the 120px floor passes -- PASS");

// --- review fix (labels crossing borders): an on-map label sitting mostly on
//     a NEIGHBOUR's polygon fails, sampled independently from the rendered
//     choropleth-data path geometry, not the renderer's own placement math -
{
  const straddling =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>t</title><desc>d</desc>` +
    `<path data-role="choropleth-data" data-iso3="GIN" data-value="66.6" d="M0,0L30,0L30,10L0,10Z"/>` +
    `<text data-role="choropleth-label" data-iso3="GIN" text-anchor="middle" x="65" y="5" font-size="12">Guinea</text>` +
    `<text data-role="choropleth-label-value" data-iso3="GIN" text-anchor="middle" x="65" y="5" font-size="12"><tspan>${GIN_TEXT}</tspan></text>` +
    `<path data-role="choropleth-data" data-iso3="ZMB" data-value="83" d="M50,0L80,0L80,10L50,10Z"/>` +
    `<text data-role="choropleth-label" data-iso3="ZMB" text-anchor="middle" x="65" y="5" font-size="12">Zambia</text>` +
    `<text data-role="choropleth-label-value" data-iso3="ZMB" text-anchor="middle" x="65" y="5" font-size="12"><tspan>${ZMB_TEXT}</tspan></text>` +
    `<path data-role="choropleth-context" fill="${PALETTE.grid}" d="M90,90Z"/>` +
    `</svg>`;
  const result = checkChoroplethValueLabels(straddling, options, deps);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.rule === "label_straddles_neighbour" && f.message.includes("GIN")), JSON.stringify(result.failures));
}
console.log("unit: an on-map label sitting mostly on a neighbour's polygon fails -- PASS");

// --- an on-map label correctly centred on its own polygon does not straddle
{
  const clean =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>t</title><desc>d</desc>` +
    `<path data-role="choropleth-data" data-iso3="GIN" data-value="66.6" d="M0,0L30,0L30,10L0,10Z"/>` +
    `<text data-role="choropleth-label" data-iso3="GIN" text-anchor="middle" x="15" y="5" font-size="12">Guinea</text>` +
    `<text data-role="choropleth-label-value" data-iso3="GIN" text-anchor="middle" x="15" y="5" font-size="12"><tspan>${GIN_TEXT}</tspan></text>` +
    `<path data-role="choropleth-data" data-iso3="ZMB" data-value="83" d="M50,0L80,0L80,10L50,10Z"/>` +
    `<text data-role="choropleth-label" data-iso3="ZMB" text-anchor="middle" x="65" y="5" font-size="12">Zambia</text>` +
    `<text data-role="choropleth-label-value" data-iso3="ZMB" text-anchor="middle" x="65" y="5" font-size="12"><tspan>${ZMB_TEXT}</tspan></text>` +
    `<path data-role="choropleth-context" fill="${PALETTE.grid}" d="M90,90Z"/>` +
    `</svg>`;
  const result = checkChoroplethValueLabels(clean, options, deps);
  assert.ok(!result.failures.some((f) => f.rule === "label_straddles_neighbour"), JSON.stringify(result.failures));
}
console.log("unit: an on-map label centred on its own polygon does not straddle -- PASS");

console.log("render_qa_labels unit tests: PASS");
