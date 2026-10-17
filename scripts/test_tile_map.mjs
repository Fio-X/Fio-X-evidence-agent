#!/usr/bin/env node
// chart_type tile_map (NEWSROOM_TILE_MAP=1, exact "1", default off): one tile per US state (table position), a small line (or a strip
// of cells) per tile, background class and corner number from color_field. Off: the type does not exist. On: lint blocks bad rows,
// the render passes the (hard-failing) heatmap value-label proof plus the tile proof, and a wrong picture is caught.
import assert from "node:assert/strict";
import { renderVizBundle, lintVizSpec, validateVizSpec, tileMapQaOptions } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { usStates } from "../runtime/pi/us_states.mjs";

const env = (vars, fn) => { const old = {}; for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const ON = { NEWSROOM_TILE_MAP: "1" };
const years = [2021, 2022, 2023, 2024];
const mk = (ys = years) => usStates().flatMap((s, i) => { const drop = -(5 + ((i * 7) % 40)); return ys.map((y, j) => ({ state: s.usps, year: y, deaths: 10 + (i % 9) + (j === 1 ? 6 : j * -1), drop })); });
const base = { schema_version: "0.9.0", language: "zh", chart_type: "tile_map", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各州药物过量死亡", subtitle: "每州一格", alt: "美国各州药物过量死亡率的格子地图，每格一条逐年折线", source_note: "测试数据", unit: "每10万人", sql: "select 1", category_field: "state", x_field: "year", value_field: "deaths", color_field: "drop", color_unit: "%", color_label: "比峰值降了多少", color_dark: "low", highlight_values: ["WV"], claim_id: "c1" };
const blockers = (spec, rows) => env(ON, () => lintVizSpec(spec, rows).blockers.join(" | "));
const render = (spec, rows) => env(ON, () => renderVizBundle(spec, rows, { mobilePages: false }).desktop);
const qa = (spec, rows, svg) => env(ON, () => runRenderQa({ desktop: svg }, tileMapQaOptions(spec, rows)));

// off: the type does not exist
{
  const off = env({ NEWSROOM_TILE_MAP: undefined }, () => validateVizSpec(base));
  assert.ok(off.includes("Unsupported chart_type 'tile_map'"), JSON.stringify(off));
  assert.ok(!env(ON, () => validateVizSpec(base)).some((e) => /chart_type/.test(e)));
}

// on, line mark: 51 states x 4 years
const rows = mk();
{
  assert.equal(blockers(base, rows).match(/tile_map/g)?.length ?? 0, 0, blockers(base, rows));
  const svg = render(base, rows);
  assert.equal((svg.match(/data-tile-state="/g) ?? []).length, 51);
  assert.equal((svg.match(/data-role="tile-map-name"/g) ?? []).length, 51);
  assert.equal((svg.match(/data-role="tile-map-line"/g) ?? []).length, 51);
  const hl = svg.match(/<rect[^>]*data-role="tile-map-highlight"[^>]*>/g) ?? [];
  assert.equal(hl.length, 1);
  assert.match(hl[0], /data-state="WV"/);
  assert.match(hl[0], /stroke="#[0-9a-fA-F]{6}"/);
  assert.match(hl[0], /fill="none"/);
  const report = qa(base, rows, svg);
  const d = report.viewports.desktop;
  assert.equal(d.value_labels.passed, true, JSON.stringify(d.value_labels.failures.slice(0, 3)));
  assert.equal(report.failure_count, d.geometry.failures.length + d.contrast.failures.length, "value-label failures count (hard fail)");
  // a wrong picture is caught: move one vertex, drop a name, add a second highlight
  const bent = svg.replace(/(data-role="tile-map-line"[^>]*points="[^ ]+ [^ ]+ )([\d.]+),([\d.]+)/, (_m, a, x, y) => `${a}${x},${Number(y) + 3}`);
  assert.notEqual(bent, svg);
  assert.equal(qa(base, rows, bent).viewports.desktop.value_labels.passed, false);
  const noName = svg.replace(/<text[^>]*data-role="tile-map-name"[^>]*>[^<]*<\/text>/, "");
  assert.equal(qa(base, rows, noName).viewports.desktop.value_labels.passed, false);
  const wrongNum = svg.replace(/(data-role="heatmap-cell-value"[^>]*>)[^<]*</, "$199999<");
  assert.equal(qa(base, rows, wrongNum).viewports.desktop.value_labels.passed, false);
  assert.equal(qa(base, rows, svg.replace('data-state="WV"', 'data-state="OH"')).viewports.desktop.value_labels.passed, false);
  // the render is deterministic
  assert.equal(render(base, rows), svg);
  // provisional years: a dashed segment and hollow dots
  const prov = render({ ...base, provisional_values: ["2024"] }, rows);
  assert.match(prov, /data-role="tile-map-line-provisional"/);
  assert.equal(qa({ ...base, provisional_values: ["2024"] }, rows, prov).viewports.desktop.value_labels.passed, true);
}

// on, strip mark: 51 states x 4 years
{
  const spec = { ...base, cell_mark: "strip" };
  delete spec.color_field;
  assert.ok(!/tile_map/.test(blockers(spec, rows)), blockers(spec, rows));
  const svg = render(spec, rows);
  const d = qa(spec, rows, svg).viewports.desktop;
  assert.equal(d.value_labels.passed, true, JSON.stringify(d.value_labels.failures.slice(0, 3)));
}

// lint blocks
{
  const hasBlock = (spec, rs, re) => { const b = blockers(spec, rs); assert.match(b, re, b); };
  hasBlock(base, rows.filter((r) => r.state !== "TX"), /no row for 'TX'/);
  hasBlock(base, [...rows, ...years.map((y) => ({ state: "PR", year: y, deaths: 1, drop: -1 }))], /not in the US state table/);
  hasBlock(base, rows.filter((r) => !(r.state === "OH" && r.year === 2022)), /OH \/ 2022/);
  hasBlock(base, [...rows, { ...rows[0] }], /more than one row/);
  hasBlock(base, mk([2021]), /time point/);
  hasBlock(base, mk(Array.from({ length: 13 }, (_, i) => 2010 + i)), /time point/);
  hasBlock({ ...base, cell_mark: "strip" }, mk(Array.from({ length: 7 }, (_, i) => 2010 + i)), /time point/);
  hasBlock({ ...base, color_field: undefined }, rows, /needs color_field/);
  hasBlock(base, rows.map((r, i) => (i === 0 ? { ...r, drop: -99 } : r)), /one numeric value per state/);
  hasBlock({ ...base, color_breaks: [3, 2, 1] }, rows, /color_breaks/);
  hasBlock({ ...base, color_dark: "mid" }, rows, /color_dark/);
  hasBlock({ ...base, provisional_values: ["1999"] }, rows, /provisional_values/);
}

// English names are accepted
{
  const named = usStates().reduce((m, s) => m.set(s.usps, s.en), new Map());
  const r2 = rows.map((r) => ({ ...r, state: named.get(r.state) }));
  assert.ok(!/tile_map/.test(blockers(base, r2)), blockers(base, r2));
}

// a tile's own name moved onto its own line or its own corner number is a geometry failure (text_crosses_data_mark / text_overlap), with and without the opt-in QA switches
{
  const svg = render(base, rows);
  const attr = (tag, re) => (svg.match(re) ?? [])[0] ?? assert.fail(`no ${tag}`);
  const line = attr("OH line", /<polyline[^>]*data-role="tile-map-line"[^>]*data-state="OH"[^>]*>/);
  const [lx, ly] = line.match(/points="([^"]+)"/)[1].split(" ")[1].split(",").map(Number);
  const num = attr("OH number", /<text[^>]*data-role="heatmap-cell-value"[^>]*data-y="OH"[^>]*>/).match(/ x="([\d.]+)" y="([\d.]+)"/);
  const nameRe = /(<text[^>]*data-role="tile-map-name"[^>]*data-state="OH"[^>]*?) x="[\d.]+" y="[\d.]+"/;
  const geometry = (s) => env(ON, () => runRenderQa({ desktop: s }, tileMapQaOptions(base, rows))).viewports.desktop.geometry.failures.map((f) => f.rule);
  for (const sw of [{ NEWSROOM_QA_NO_EMPTY_PASS: "0" }, { NEWSROOM_UNIT_AWARE_LABELS: "1" }]) {
    env(sw, () => {
      assert.deepEqual(geometry(svg), [], "the untouched picture has no geometry failure");
      const onLine = geometry(svg.replace(nameRe, `$1 x="${lx}" y="${ly + 4}"`));
      assert.ok(onLine.includes("text_crosses_data_mark"), `name on its own line: ${onLine}`);
      const onNumber = geometry(svg.replace(nameRe, `$1 x="${Number(num[1]) - 20}" y="${num[2]}"`));
      assert.ok(onNumber.includes("text_overlap"), `name on its own corner number: ${onNumber}`);
    });
  }
}
console.log("tile_map: PASS");
