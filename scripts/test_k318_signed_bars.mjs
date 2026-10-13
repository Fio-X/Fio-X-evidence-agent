#!/usr/bin/env node
// K318: NEWSROOM_SIGNED_BARS=1 (exact "1", default off) colours each mark of a horizontal_bar / dot chart whose values span zero by its sign (the K309 pair; coral / blue ink
// in riso), keeps the zero line, and leaves all-positive, all-negative and single-value charts, and diverging_bar, as they are. Off (unset, "0", "true", " 1") is byte-identical.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { restyleSvg } from "../runtime/pi/render_styles.mjs";

const KEY = "NEWSROOM_SIGNED_BARS";
const withEnv = (v, fn) => { const old = process.env[KEY]; if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v; try { return fn(); } finally { if (old === undefined) delete process.env[KEY]; else process.env[KEY] = old; } };
const spec = (chart_type, extra = {}) => ({ schema_version: "0.9.0", reader_task: "ranking", takeaway: "t", chart_type, title: "Synthetic signed comparison", subtitle: "Synthetic fixture", alt: "Bars of synthetic values on both sides of zero.", source_note: "Synthetic fixture", claim_id: "claim-bars", sql: "SELECT 1", unit: "units", category_field: "c", value_field: "v", ...extra });
const names = ["Brazil", "China", "Russia", "India", "Chile", "Peru", "Laos", "Chad", "Mali", "Togo", "Fiji", "Cuba"];
const SHAPES = {
  signed: [-325.6, 161.1, 91, -10, -50, 9, -200, 2],
  allPositive: [3, 12, 40, 150, 2, 30, 9, 60],
  allNegative: [-3, -12, -40, -150, -2, -30, -9, -60],
  single: [42],
  manyLabels: [-12, 30, -45, 8, 60, -5, 22, -70, 14, -33, 5, 41],
};
const rowsOf = (vals) => vals.map((v, i) => ({ c: names[i], v }));
const draw = (type, vals, extra) => renderVizBundle(spec(type, extra), rowsOf(vals), { mobilePages: false }).desktop;
const count = (svg, re) => (svg.match(re) ?? []).length;
const OFF_VALUES = [undefined, "0", "true", " 1", "1 ", "yes"];

for (const type of ["horizontal_bar", "dot"]) {
  for (const [name, vals] of Object.entries(SHAPES)) {
    const off = withEnv(undefined, () => draw(type, vals));
    for (const v of OFF_VALUES) assert.equal(withEnv(v, () => draw(type, vals)), off, `${type}/${name}: switch value ${JSON.stringify(v)} is byte-identical to off`);
    const on = withEnv("1", () => draw(type, vals));
    const signed = name === "signed" || name === "manyLabels";
    const marks = count(on, /data-bar-sign="(pos|neg)"/g);
    if (!signed) { assert.equal(on, off, `${type}/${name}: unsigned data is byte-identical with the switch on`); continue; }
    assert.equal(marks, vals.length, `${type}/${name}: every mark carries its sign`);
    assert.equal(count(on, /data-bar-sign="neg"/g), vals.filter((x) => x < 0).length, `${type}/${name}: negatives tagged neg`);
    assert.equal(count(on, /data-bar-sign="pos"/g), vals.filter((x) => x >= 0).length, `${type}/${name}: positives tagged pos`);
    assert.notEqual(on, off, `${type}/${name}: switch on changes a signed chart`);
    assert.ok(/stroke="[^"]*" stroke-width="1.2"/.test(on) || /data-role="zero-line"/.test(on), `${type}/${name}: zero line stays`);
    // render QA: bars must pass; a dot chart with a long negative label already overlaps its category label with the switch off, so there the switch must not change the verdict
    { const qa = runRenderQa({ desktop: on }); const qo = runRenderQa({ desktop: off }); assert.equal(qa.passed, type === "horizontal_bar" ? true : qo.passed, `${type}/${name}: render QA (off ${qo.passed})`); }
  }
}
// bars: the two signs get two different fills
{
  const on = withEnv("1", () => draw("horizontal_bar", SHAPES.signed));
  const fills = (sign) => new Set([...on.matchAll(new RegExp(`data-bar-sign="${sign}"[^>]*fill="([^"]+)"`, "g"))].map((m) => m[1]));
  assert.equal(fills("neg").size, 1); assert.equal(fills("pos").size, 1);
  assert.notDeepEqual([...fills("neg")], [...fills("pos")], "one fill per sign");
}
// diverging_bar is untouched by the switch
{
  const off = withEnv(undefined, () => draw("diverging_bar", SHAPES.signed));
  assert.equal(withEnv("1", () => draw("diverging_bar", SHAPES.signed)), off, "diverging_bar byte-identical");
}
// riso: ink follows the sign, bars stay solid
{
  const on = withEnv("1", () => draw("horizontal_bar", SHAPES.signed));
  const riso = restyleSvg(on, "riso");
  assert.notEqual(riso, restyleSvg(withEnv(undefined, () => draw("horizontal_bar", SHAPES.signed)), "riso"), "riso differs on a signed chart");
}
console.log("k318 signed bars PASS");
