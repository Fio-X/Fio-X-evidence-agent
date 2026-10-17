#!/usr/bin/env node
// NEWSROOM_QA_HEATMAP_MONOTONE=1 (exact "1", default off): render QA also flags a heatmap whose fill does not get darker with the value,
// whose equal values differ in fill, or whose grid is incomplete. Off: the report is byte-identical to before. The empty-pass rules are set to "0" here so
// that this test measures only this switch (they are on by default and would add their own extra_checks key).
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const spec = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，若干国家乘四种燃料的占比。", };
const fuels = ["煤", "石油", "天然气", "水泥"];
const mk = (n) => Array.from({ length: n }, (_, i) => `国${i + 1}`).flatMap((c, i) => fuels.map((fu, j) => ({ country: c, fuel: fu, share: 10 + i * 3 + j * 1.5 })));
const withEnv = (vars, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const SW = "NEWSROOM_QA_HEATMAP_MONOTONE";
const rows = mk(6);
const render = (r) => withEnv({ NEWSROOM_HEATMAP_VALUE_LABELS: "1" }, () => renderVizBundle(spec, r, { mobilePages: false }).desktop);
const qa = (svg, r, sw) => withEnv({ NEWSROOM_HEATMAP_VALUE_LABELS: "1", NEWSROOM_QA_NO_EMPTY_PASS: "0", [SW]: sw }, () => runRenderQa({ desktop: svg }, { heatmap: { rows: r, spec, x_field: "fuel", y_field: "country", value_field: "share" } }));
const svg = render(rows);

// 1. off (empty-pass rules set to "0" in qa()): unset/"0"/"true" give byte-identical reports with no extra key, even on a broken fill
const lighter = svg.replace(/(data-role="heatmap-cell"[^>]*data-value="[^"]*"[^>]*fill=")rgb\([^)]*\)/, "$1rgb(250,250,250)");
assert.notEqual(lighter, svg);
const base = JSON.stringify(qa(svg, rows, undefined));
for (const v of ["0", "true", ""]) assert.equal(JSON.stringify(qa(svg, rows, v)), base);
assert.equal(JSON.stringify(qa(lighter, rows, undefined)), JSON.stringify(qa(lighter, rows, "0")));
assert.ok(!base.includes("extra_checks"));

// 2. on + a good heatmap: passes, same overall verdict
const good = qa(svg, rows, "1");
assert.equal(good.viewports.desktop.extra_checks.heatmap_monotone.passed, true, JSON.stringify(good.viewports.desktop.extra_checks));
assert.equal(good.viewports.desktop.extra_checks.heatmap_monotone.cells_checked, 24);
assert.equal(good.passed, qa(svg, rows, undefined).passed);

// 3. on + the highest-valued... first (lowest-valued) cell painted lighter than paper-near ramp start is fine; a LOW cell painted darker than a high one is not
const dark = svg.replace(/(data-role="heatmap-cell"[^>]*data-value="10"[^>]*fill=")rgb\([^)]*\)/, "$1rgb(20,20,20)");
assert.notEqual(dark, svg);
const bad = qa(dark, rows, "1");
assert.equal(bad.viewports.desktop.extra_checks.heatmap_monotone.passed, false);
assert.ok(bad.viewports.desktop.extra_checks.heatmap_monotone.failures.some((f) => f.rule === "heatmap_fill_not_monotone"));
assert.equal(bad.passed, false);
assert.ok(bad.failure_count > qa(dark, rows, undefined).failure_count);

// 4. on + equal values with different fills
const tie = mk(6); tie[1].share = tie[0].share; // same value, so the same fill
const tieSvg = render(tie);
assert.equal(qa(tieSvg, tie, "1").viewports.desktop.extra_checks.heatmap_monotone.passed, true);
const tieBad = tieSvg.replace(/(data-role="heatmap-cell"[^>]*data-value="10"[^>]*fill=")rgb\([^)]*\)/, "$1rgb(200,200,200)");
assert.ok(qa(tieBad, tie, "1").viewports.desktop.extra_checks.heatmap_monotone.failures.some((f) => f.rule === "heatmap_equal_values_different_fill" || f.rule === "heatmap_fill_not_monotone"));

// 5. on + an incomplete grid (one cell has no value)
const holey = rows.filter((r, i) => i !== 5);
const holeySvg = render(holey);
const holeyQa = qa(holeySvg, holey, "1");
assert.ok(holeyQa.viewports.desktop.extra_checks.heatmap_monotone.failures.some((f) => f.rule === "heatmap_grid_incomplete"));
assert.equal(holeyQa.passed, false);

// 6. on + an unreadable fill
const odd = svg.replace(/(data-role="heatmap-cell"[^>]*fill=")rgb\([^)]*\)/, "$1url(#x)");
assert.ok(qa(odd, rows, "1").viewports.desktop.extra_checks.heatmap_monotone.failures.some((f) => f.rule === "heatmap_fill_unreadable"));

// 7. non-heatmap reports never get the key
assert.equal(withEnv({ [SW]: "1", NEWSROOM_QA_NO_EMPTY_PASS: "0" }, () => runRenderQa({ desktop: svg })).viewports.desktop.extra_checks, undefined);
assert.equal(withEnv({ [SW]: "1", NEWSROOM_QA_NO_EMPTY_PASS: undefined }, () => runRenderQa({ desktop: svg })).viewports.desktop.extra_checks.heatmap_monotone, undefined);
console.log("PASS qa heatmap monotone");
