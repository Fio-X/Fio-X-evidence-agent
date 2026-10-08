// V522 Part A: hard-off, no silent drop (two columns, then a counted cut), shared-origin star values,
// leftover-tie warning, deterministic ties, disclosure and footer count.
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from '../runtime/pi/cartography.mjs';
import { fmtSpec, lintVizSpec, renderVizBundle, validateVizSpec } from '../runtime/pi/viz.mjs';
import { LEDGER_MAP_RIGHT } from '../runtime/pi/flow_map_labels.mjs';
import { textUnits } from '../runtime/pi/viz.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

const assert = (c, m) => { if (!c) throw new Error(m); };
const ok = (m) => console.log('ok', m);
const base = (title, unit) => ({ schema_version: '1.0.0', chart_type: 'cartographic_flow_map', reader_task: 'flow', visual_family: 'spatial', data_topology: 'geo_edges', language: 'zh', title, subtitle: '测试数据', unit, claim_id: 'claim-carto-v15', sql: 'SELECT * FROM cartographic_flow_fixture', alt: `${title}。地图上的流向弧线。`, source_note: '测试数据。', note: '弧线表示关系，不是路线。', value_field: 'value', source_field: 'source', target_field: 'target', geometry_crs: 'EPSG:4326', projection: 'natural_earth_1', basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: 'none', geometry_semantics: 'abstract_od', source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon', extent_mode: 'data' });

const star = (n, nameOf = (i) => `来源${i}`, dest = '德国') => Array.from({ length: n }, (_, i) => ({ source: nameOf(i), target: dest, source_lat: -40 + (i * 11) % 90, source_lon: -150 + (i * 23) % 300, target_lat: 51, target_lon: 10, value: Math.round((n - i) ** 1.5 * 4) + 3 }));
const hl = (rows) => rows.slice().sort((a, b) => b.value - a.value)[0];
const mk = (extra, rows) => ({ ...base('测试', '万吨'), highlight_values: [hl(rows).source, hl(rows).target], ...extra });
const count = (svg, role) => (svg.match(new RegExp(`data-role="${role}"`, 'g')) ?? []).length;

// 1. hard off: the spec field alone does nothing
{
  const rows = star(10), withField = mk({ flow_map_labels: 'ledger' }, rows), without = mk({}, rows);
  delete process.env.NEWSROOM_FLOW_MAP_LABELS;
  assert(renderVizBundle(withField, rows).desktop === renderVizBundle(without, rows).desktop, 'switch off + field set must be byte-identical to no field');
  assert(JSON.stringify(validateVizSpec(withField)) === JSON.stringify(validateVizSpec(without)), 'validate differs with switch off');
  assert(JSON.stringify(lintVizSpec(withField, rows)) === JSON.stringify(lintVizSpec(without, rows)), 'lint differs with switch off');
  assert(!renderVizBundle(withField, rows).desktop.includes('flow-ledger'), 'ledger drawn with the switch off');
  ok('hard off: switch off ignores flow_map_labels');
}
process.env.NEWSROOM_FLOW_MAP_LABELS = '1';

// 2. no silent drop
const accounted = (svg, n, label) => {
  const flows = count(svg, 'cartographic-flow'), valueRows = count(svg, 'flow-ledger-value');
  assert(flows === valueRows, `${label}: ${flows} drawn flows but ${valueRows} ledger rows`);
  const m = svg.match(/另有 (\d+) 条放不下未画/);
  assert(flows + (m ? +m[1] : 0) === n, `${label}: drawn ${flows} + left out ${m ? m[1] : 0} != ${n}`);
  return { flows, left: m ? +m[1] : 0 };
};
for (const n of [30, 60, 76]) {
  const rows = star(n, (i) => `来源国${String(i).padStart(2, '0')}`), spec = mk({ flow_map_labels: 'ledger' }, rows);
  const b = renderVizBundle(spec, rows), svg = b.desktop, qa = runRenderQa({ desktop: svg });
  assert(qa.passed, `${n} flows: render QA failed ${JSON.stringify(qa.viewports.desktop.geometry.failures.slice(0, 3)).slice(0, 400)}`);
  const a = accounted(svg, n, `${n} flows`);
  const unmarked = count(svg, 'annotation-marker') / 1; // ledger discs + map badges
  assert(unmarked >= a.flows, `${n} flows: fewer badges than flows`);
  if (a.left) assert(!/合计/.test(svg), `${n} flows: the footer must not print a computed total`);
  ok(`no silent drop at ${n} flows: drawn ${a.flows}, left out ${a.left}`);
}
{
  const rows = star(30, (i) => `来源国${String(i).padStart(2, '0')}`), svg = renderVizBundle(mk({ flow_map_labels: 'ledger' }, rows), rows).desktop;
  assert(svg.includes('x="' + (724 + 12 + (980 - 724 - 12) / 2) + '"') || count(svg, 'flow-ledger-name') > 0, '30 flows: no ledger');
  const xs = new Set([...svg.matchAll(/data-role="flow-ledger-value" x="([\d.]+)"/g)].map((m) => m[1]));
  assert(xs.size === 2, `30 flows should use two columns, got ${xs.size}`);
  ok('30 flows use two ledger columns');
}

// 3. shared-origin star: one origin, many destinations, leader style: every destination prints its value
{
  const rows = Array.from({ length: 7 }, (_, i) => ({ source: '中国', target: `目的地${i + 1}`, source_lat: 35, source_lon: 105, target_lat: -30 + i * 14, target_lon: -100 + i * 40, value: (7 - i) * 31 + 2 }));
  const spec = mk({ flow_map_labels: 'leader' }, rows), svg = renderVizBundle(spec, rows).desktop;
  assert(runRenderQa({ desktop: svg }).passed, 'export star leader render QA failed');
  assert(!svg.includes('flow-ledger'), 'export star should stay in leader style');
  const text = svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const r of rows) assert(new RegExp(`${r.target} [0-9]`).test(text), `value of ${r.target} not printed`);
  ok('export-style star prints a value on every destination');
}

// 4. leftover ties warn
{
  const rows = [10.001, 10.002, 5, 4].map((v, i) => ({ source: `来源${i}`, target: '德国', source_lat: 10 + i * 8, source_lon: -60 + i * 40, target_lat: 51, target_lon: 10, value: v }));
  const warn = lintVizSpec(mk({ flow_map_labels: 'leader', aggregation_policy: 'none' }, rows), rows);
  const w = JSON.stringify(warn);
  assert(/adjacent ranks/.test(w), 'no tie warning for two ranks that print the same');
  const distinct = [10, 20, 5, 4].map((v, i) => ({ ...rows[i], value: v })); assert(!/adjacent ranks/.test(JSON.stringify(lintVizSpec(mk({ flow_map_labels: 'leader', aggregation_policy: 'none' }, distinct), distinct))), 'tie warning on distinct values');
  ok('tie warning only when adjacent ranks print the same text');
}

// 5. deterministic ties at the top_n boundary
{
  const rows = Array.from({ length: 8 }, (_, i) => ({ source: `源${'ABCDEFGH'[i]}`, target: '德国', source_lat: 10 + i * 8, source_lon: -60 + i * 25, target_lat: 51, target_lon: 10, value: i < 4 ? 50 : 9 }));
  const spec = mk({ flow_map_labels: 'ledger', aggregation_policy: 'top_n', top_n: 6 }, rows);
  const a = renderVizBundle(spec, rows).desktop, b = renderVizBundle(spec, rows.slice().reverse()).desktop, c = renderVizBundle(spec, [...rows.slice(3), ...rows.slice(0, 3)]).desktop;
  assert(a === b && a === c, 'row order changes rank, style or the top_n boundary');
  ok('ties at the top_n boundary do not depend on row order');
}

// 6. disclosure and footer count
{
  const rows = [...star(10), { source: '零来源', target: '德国', source_lat: 0, source_lon: 0, target_lat: 51, target_lon: 10, value: 0 }];
  const spec = mk({ flow_map_labels: 'ledger', route_provenance_note: '依据：演示数据。' }, rows), svg = renderVizBundle(spec, rows).desktop;
  assert(svg.includes('依据：演示数据。'), 'route_provenance_note dropped');
  assert(/data-role="cartographic-provenance-note"[^>]*>依据：演示数据。</.test(svg), 'note is not on its own line');
  assert(/图中共 10 条/.test(svg) && !/仅画/.test(svg), 'footer count includes a row removed for value <= 0');
  ok('provenance note kept; footer count excludes value <= 0 rows');
}
// 7. route_provenance_note lives in the note block under the chart: the map is as tall with a 600-character note as with none;
//    every character of it is kept; wrapping never splits digits, Latin words or a URL; render QA passes for both styles
const oceanH = (svg) => +svg.match(/data-role="cartographic-ocean"[^>]* height="([\d.]+)"/)[1];
const noteText = (svg) => [...svg.matchAll(/data-role="cartographic-provenance-note"[^>]*>([^<]*)</g)].map((m) => m[1]);
for (const style of ['ledger', 'leader']) {
  const rows = style === 'ledger' ? star(12) : star(5);
  const long = ('依据：联合国统计司 UN Comtrade 数据库 2023 年 HS 2709 双边贸易记录 1,234.5 万吨，按进口国申报口径整理 https://comtradeplus.un.org/TradeFlow?Frequency=A&Flows=X&CommodityCodes=2709 ，未含转口与未申报部分。').repeat(4).slice(0, 600);
  assert(long.length === 600, 'note length');
  const none = renderVizBundle(mk({ flow_map_labels: style }, rows), rows).desktop, withNote = renderVizBundle(mk({ flow_map_labels: style, route_provenance_note: long }, rows), rows).desktop;
  assert(oceanH(none) === oceanH(withNote), `${style}: map height ${oceanH(withNote)} with a 600-char note differs from ${oceanH(none)} with none`);
  const lines = noteText(withNote), joined = lines.join('').replace(/&amp;/g, '&');
  assert(lines.length >= 3, `${style}: note did not wrap`);
  assert(joined.replace(/\s/g, '') === long.replace(/\s/g, ''), `${style}: provenance text was cut or changed`);
  for (const tok of ['UN Comtrade', '2709', '1,234.5', 'https://comtradeplus.un.org/TradeFlow?Frequency=A&amp;Flows=X&amp;CommodityCodes=2709']) assert(lines.some((l) => l.includes(tok)), `${style}: "${tok}" was split over lines`);
  const qa = runRenderQa({ desktop: withNote });
  assert(qa.passed, `${style}: render QA ${JSON.stringify(qa.viewports.desktop.geometry.failures.slice(0, 3)).slice(0, 400)}`);
  for (const l of lines) assert(54 + textUnits(l.replace(/&amp;/g, '&')) * 12 * 0.56 <= 1040 - 54 + 0.5, `${style}: note line crosses the page edge`);
  ok(`${style}: 600-char note stays out of the map (height ${oceanH(withNote)}), ${lines.length} lines, nothing split, render QA passes`);
}

// 8. a repeated source -> target is a lint warning, never merged or dropped
{
  const rows = star(5), dup = [...rows, { ...rows[1], value: rows[1].value + 1 }];
  const w = JSON.stringify(lintVizSpec(mk({ flow_map_labels: 'leader' }, dup), dup));
  assert(/duplicate route/.test(w) && w.includes('来源1→德国'), 'duplicate source→target not named in a lint warning');
  assert(!/duplicate route/.test(JSON.stringify(lintVizSpec(mk({ flow_map_labels: 'leader' }, rows), rows))), 'duplicate warning without a duplicate');
  ok('duplicate route lint names the pair');
}
// 9. width-legend tick texts carry a legend role
{
  const rows = star(5), svg = renderVizBundle(mk({ flow_map_labels: 'leader' }, rows), rows).desktop;
  assert(count(svg, 'legend-tick') >= 2 && count(svg, 'legend-swatch') === count(svg, 'legend-tick'), 'legend ticks lack data-role="legend-tick"');
  ok('legend tick texts carry data-role="legend-tick"');
}
console.log('flow_map round 3 part A tests passed');
