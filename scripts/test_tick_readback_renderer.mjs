// Renderer side of the tick / value-label read-back (NEWSROOM_QA_TICK_READBACK=1): the attributes viz.mjs writes
// for bar and mirrored-bar charts, that they appear only on an exact "1", that nothing else in the picture moves,
// that runRenderQa reads them back, and that newsroom.ts hands the read-back its rows and field names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderVizSvg } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KEYS = ["NEWSROOM_QA_TICK_READBACK", "NEWSROOM_TYPESET_AXIS_NOTATION", "NEWSROOM_TYPESET_VALUE_LABEL_AXIS", "NEWSROOM_AXIS_NICE_MAX"];
function render(spec, rows, env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return renderVizSvg(spec, rows); } finally { for (const k of KEYS) delete process.env[k]; }
}

const base = { schema_version: "0.9.0", reader_task: "comparison", takeaway: "T.", alt: "图。", source_note: "s", claim_id: "c1", sql: "SELECT 1", unit: "人", language: "zh", highlight_values: [], title: "各城市人口", subtitle: "万人" };
const hbSpec = { ...base, chart_type: "horizontal_bar", category_field: "city", value_field: "pop" };
const mbSpec = { ...base, chart_type: "mirrored_bar", category_field: "band", series_field: "side", value_field: "pop", period_field: "year", direct_labels: true };
const hbRows = [["上海", 24870003], ["北京", 21890003], ["深圳", 17680003], ["拉萨", 705803]].map(([city, pop]) => ({ city, pop }));
const mbRows = [];
for (const year of ["2014", "2024"]) ["0-14", "15-39", "40-64"].forEach((band, i) => { mbRows.push({ band, side: "男", year, pop: (1200 + i * 310) * 10000 + 5 }); mbRows.push({ band, side: "女", year, pop: (1100 + i * 280) * 10000 + 7 }); });
const B = { NEWSROOM_TYPESET_AXIS_NOTATION: "1" };
const BK = { ...B, NEWSROOM_TYPESET_VALUE_LABEL_AXIS: "1", NEWSROOM_AXIS_NICE_MAX: "1" };

// what the read-back adds is attributes (and the role names that carry them); take them away and the picture is the one off draws
const READBACK_ATTR = / data-(?:tick-value|tick-x|scale|category|series|period|value|side)="[^"]*"/g;
const ROLE = / data-role="(?:axis-tick-label|value-label|axis-unit-line|axis-unit|bar-value-label)"/g;
const plain = (svg) => svg.replace(READBACK_ATTR, "").replace(ROLE, "");

const charts = [["horizontal_bar", hbSpec, hbRows], ["mirrored_bar", mbSpec, mbRows]];
const writings = [["off", {}], ["B", B], ["B+K202+K203", BK]];
let n = 0;
for (const [type, spec, rows] of charts) {
  const ctx = { chart_type: type, rows, category_field: spec.category_field, value_field: spec.value_field, ...(spec.series_field ? { series_field: spec.series_field } : {}), ...(spec.period_field ? { period_field: spec.period_field } : {}), unit: spec.unit, language: spec.language };
  for (const [writing, env] of writings) {
    const off = render(spec, rows, env);
    // not exactly "1": byte for byte the picture off draws
    for (const value of ["0", "", "true", "yes", " 1", "1 ", "on"]) {
      assert.equal(render(spec, rows, { ...env, NEWSROOM_QA_TICK_READBACK: value }), off, `${type} ${writing}: switch "${value}" changed the picture`);
    }
    assert.ok(!/data-tick-value|data-scale|data-value=|axis-unit-line/.test(off), `${type} ${writing}: off carries read-back attributes`);
    const on = render(spec, rows, { ...env, NEWSROOM_QA_TICK_READBACK: "1" });
    assert.notEqual(on, off);
    assert.equal(plain(on), plain(off), `${type} ${writing}: switching on moved something besides the attributes`);
    // the attributes are there
    assert.ok(/<text data-role="axis-tick-label" data-tick-value="[^"]+"/.test(on), `${type} ${writing}: no tick attributes`);
    assert.ok((on.match(/<rect data-role="data-bar" data-category=/g) ?? []).length >= rows.length / (type === "mirrored_bar" ? 2 : 1), `${type} ${writing}: bars lack data-category`);
    assert.ok(/data-role="value-label"/.test(on), `${type} ${writing}: no value labels`);
    if (writing !== "off") assert.ok(/data-role="axis-unit-line" data-scale="\d+"/.test(on), `${type} ${writing}: no unit line scale`);
    // runRenderQa reads it back, and says so in the report
    process.env.NEWSROOM_QA_TICK_READBACK = "1";
    // the switch is read when runRenderQa runs; mobile and compact pictures (no attributes) are not read back
    const qa = runRenderQa({ desktop: on, mobile: off, compact: off }, { tick_readback: ctx });
    assert.equal(qa.viewports.desktop.tick_readback.status, "covered");
    assert.equal(qa.viewports.mobile.tick_readback, undefined);
    assert.equal(qa.viewports.compact.tick_readback, undefined);
    assert.equal(qa.passed, true, `${type} ${writing}: ${JSON.stringify(qa.viewports.desktop.tick_readback)}`);
    // a picture that lies about a tick, a bar or a label does not pass
    const tampered = [
      on.replace(/(data-role="axis-tick-label"[^>]*>)(\d)/, (_all, head, d) => `${head}${d === "9" ? "1" : Number(d) + 1}${d}`),
      on.replace(/(data-role="data-bar"[^>]*data-value=")([^"]+)"/, (_all, head, v) => `${head}${Number(v) * 2}"`),
    ];
    for (const bad of tampered) {
      assert.notEqual(bad, on, `${type} ${writing}: tamper did not change the svg`);
      assert.equal(runRenderQa({ desktop: bad }, { tick_readback: ctx }).passed, false, `${type} ${writing}: tampered picture passed`);
    }
    // switch off: the option is ignored, report unchanged
    delete process.env.NEWSROOM_QA_TICK_READBACK;
    const offQa = runRenderQa({ desktop: on }, { tick_readback: ctx });
    assert.equal(offQa.viewports.desktop.tick_readback, undefined);
    assert.equal(JSON.stringify(offQa), JSON.stringify(runRenderQa({ desktop: on })));
    n++;
  }
}

// a tick label slid sideways to stay inside the frame: the picture carries data-tick-x (where the tick really is), the read-back
// passes on it, and without that attribute the same picture fails (the label sits 40+ px from where its value belongs)
{
  const unit = "million tonnes of carbon dioxide equivalent emitted per year ".repeat(3).slice(0, 96);
  const spec = { ...hbSpec, language: "en", unit, title: "Emissions", subtitle: "" };
  const rows = [["A", 80000], ["B", 45678]].map(([city, pop]) => ({ city, pop }));
  const svg = render(spec, rows, { NEWSROOM_QA_TICK_READBACK: "1" });
  const last = svg.match(/<text data-role="axis-tick-label" data-tick-value="80000" data-tick-x="([^"]+)" x="([^"]+)"/);
  assert.ok(last, "squeezed sample: the slid tick label has no data-tick-x");
  assert.ok(Math.abs(Number(last[1]) - Number(last[2])) > 1, `squeezed sample: label not slid (tick ${last[1]}, label ${last[2]})`);
  assert.equal((svg.match(/data-tick-x=/g) ?? []).length, 1, "squeezed sample: only the slid label carries data-tick-x");
  const squeezedCtx = { chart_type: "horizontal_bar", rows, category_field: "city", value_field: "pop", unit, language: "en" };
  process.env.NEWSROOM_QA_TICK_READBACK = "1";
  const slid = runRenderQa({ desktop: svg }, { tick_readback: squeezedCtx }).viewports.desktop.tick_readback;
  assert.equal(slid.status, "covered");
  assert.deepEqual(slid.failures, [], `squeezed sample failed the read-back: ${JSON.stringify(slid.failures)}`);
  const noTickX = svg.replace(/ data-tick-x="[^"]*"/, "");
  assert.notEqual(noTickX, svg);
  assert.equal(runRenderQa({ desktop: noTickX }, { tick_readback: squeezedCtx }).viewports.desktop.tick_readback.passed, false, "squeezed sample passed without data-tick-x");
  delete process.env.NEWSROOM_QA_TICK_READBACK;
  // switch off: nothing about it is written, the slid label is the one off draws
  assert.ok(!/data-tick-x/.test(render(spec, rows, {})), "squeezed sample: off carries data-tick-x");
  n++;
}

// a picture with no bar at all (ticks and value labels only): the switch on does not let it through. Several rules stop it, and the
// data-anchor one must keep saying so even for a period chart (its "this period was not drawn" excuse needs a drawn period to compare with)
for (const [type, spec, rows] of charts) {
  const ctx = { chart_type: type, rows, category_field: spec.category_field, value_field: spec.value_field, ...(spec.series_field ? { series_field: spec.series_field } : {}), ...(spec.period_field ? { period_field: spec.period_field } : {}), unit: spec.unit, language: spec.language };
  const svg = render(spec, rows, { ...B, NEWSROOM_QA_TICK_READBACK: "1" });
  const noBars = svg.replace(/<rect data-role="data-bar(?:-outline)?"[^>]*\/>/g, "");
  assert.ok(!/data-role="data-bar/.test(noBars) && noBars !== svg, `${type}: could not take the bars out of the picture`);
  process.env.NEWSROOM_QA_TICK_READBACK = "1";
  const got = runRenderQa({ desktop: noBars }, { tick_readback: ctx });
  delete process.env.NEWSROOM_QA_TICK_READBACK;
  const rules = new Set(got.viewports.desktop.tick_readback.failures.map((x) => x.rule));
  assert.equal(got.passed, false, `${type}: a picture with no bar passed`);
  for (const rule of ["bar_attrs", "data_anchor", "tick_position"]) assert.ok(rules.has(rule), `${type}: no-bar picture not stopped by ${rule} (got ${[...rules]})`);
  n++;
}

// the scale on the unit line is the scale the unit word names (万 -> 1e4, 亿 -> 1e8), not a constant
for (const [mult, word, scale] of [[1, "万", 10000], [10000, "亿", 100000000]]) {
  const big = hbRows.map((r) => ({ ...r, pop: r.pop * mult }));
  const svg = render(hbSpec, big, { ...B, NEWSROOM_QA_TICK_READBACK: "1" });
  const m = svg.match(/data-role="axis-unit-line" data-scale="(\d+)">([^<]*)/);
  assert.ok(m && m[2].includes(word) && Number(m[1]) === scale, `unit line ${m && m[2]} carries scale ${m && m[1]}, expected ${word} = ${scale}`);
}

// newsroom.ts: only an exact "1", only the two covered chart types, rows and the field names of the plan
const ts = readFileSync(join(here, "..", "runtime", "pi", "newsroom.ts"), "utf8");
const start = ts.indexOf('process.env.NEWSROOM_QA_TICK_READBACK === "1" && (spec.chart_type === "horizontal_bar" || spec.chart_type === "mirrored_bar")');
assert.ok(start > 0, "newsroom.ts does not hand tick_readback to runRenderQa behind the exact-1 switch");
const wiring = [ts.slice(start, ts.indexOf(": {};", start))];
assert.ok(wiring[0].includes("? { tick_readback: {"), "newsroom.ts: tick_readback option missing");
for (const part of ["chart_type: spec.chart_type", "rows", "category_field: spec.category_field", "value_field: spec.value_field", "series_field", "period_field", "unit: spec.unit", "language: spec.language"]) {
  assert.ok(wiring[0].includes(part), `newsroom.ts tick_readback lacks ${part}`);
}
console.log(`ok test_tick_readback_renderer: ${n} chart/writing pairs + newsroom wiring`);
