// flow_map_labels (leader | ledger): default-off, Chinese strings, passes render QA with names on,
// and every name box / badge sits clear of every arc stroke and dot (stricter than render QA).
// Optional: BASE_WT=<worktree without the flag> checks flag-off output is byte-identical.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from '../runtime/pi/cartography.mjs';
import { renderVizBundle, validateVizSpec } from '../runtime/pi/viz.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const assert = (c, m) => { if (!c) throw new Error(m); };
const csv = (p) => { const [h, ...ls] = readFileSync(p, 'utf8').trim().split(/\r?\n/); const f = h.split(','); return ls.map((l) => { const v = l.split(','); return Object.fromEntries(f.map((k, i) => [k, /^-?\d+(\.\d+)?$/.test(v[i]) ? Number(v[i]) : v[i]])); }); };
const base = (title, unit) => ({ schema_version: '1.0.0', chart_type: 'cartographic_flow_map', reader_task: 'flow', visual_family: 'spatial', data_topology: 'geo_edges', language: 'zh', title, subtitle: '测试数据', unit, claim_id: 'claim-carto-v15', sql: 'SELECT * FROM cartographic_flow_fixture', alt: `${title}。地图上的流向弧线。`, source_note: '测试数据。', note: '弧线表示关系，不是路线。', value_field: 'value', source_field: 'source', target_field: 'target', geometry_crs: 'EPSG:4326', projection: 'natural_earth_1', basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: 'none', geometry_semantics: 'abstract_od', source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon', extent_mode: 'data' });
const ZH = { 'United States': '美国', Canada: '加拿大', Mexico: '墨西哥', 'Saudi Arabia': '沙特阿拉伯', Iraq: '伊拉克', Brazil: '巴西', Colombia: '哥伦比亚', India: '印度', 'United Arab Emirates': '阿联酋' };
const zh = (n) => ZH[n] ?? n;
const eia = csv(join(ROOT, 'fixtures/v09-realdata/eia-us-crude-imports-2024.csv')).map((r) => ({ source: zh(r.country), target: zh(r.target), source_lat: r.source_lat, source_lon: r.source_lon, target_lat: r.target_lat, target_lon: r.target_lon, value: r.thousand_bpd }));
const rem = csv(join(ROOT, 'fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.csv')).map((r) => ({ source: zh(r.source), target: zh(r.target), source_lat: r.source_lat, source_lon: r.source_lon, target_lat: r.target_lat, target_lon: r.target_lon, value: r.usd_billion }));
// 12 synthetic corridors between named capitals (names and coordinates are test data only)
const cities = [['甲', 10, 50], ['乙', 30, 40], ['丙', 70, 30], ['丁', 100, 10], ['戊', -60, -10], ['己', -100, 40], ['庚', 20, -20], ['辛', 120, 35], ['壬', 40, 10], ['癸', -10, 15], ['子', 80, 55], ['丑', 150, -25]];
const syn = Array.from({ length: 12 }, (_, i) => { const a = cities[i], b = cities[(i * 5 + 3) % 12 === i ? (i + 1) % 12 : (i * 5 + 3) % 12]; return { source: a[0], target: b[0], source_lat: a[2], source_lon: a[1], target_lat: b[2], target_lon: b[1], value: (12 - i) * 1000 + 17 }; });
const cases = { eia6: [base('美国原油进口', '千桶／日'), eia], remittance4: [base('侨汇走廊', '十亿美元'), rem], synthetic12: [base('十二条走廊', '人'), syn] };

function arcsOf(svg) {
  return [...svg.matchAll(/<path data-role="cartographic-flow"[^>]* d="M([\d.-]+),([\d.-]+) Q([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)"[^>]* stroke-width="([\d.]+)"/g)].map((m) => {
    const [a, c, b] = [{ x: +m[1], y: +m[2] }, { x: +m[3], y: +m[4] }, { x: +m[5], y: +m[6] }], pts = [];
    for (let i = 0; i <= 200; i++) { const t = i / 200, u = 1 - t; pts.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }); }
    return { pts, hw: +m[7] / 2 };
  });
}
const rectDist = (r, p) => Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.w), Math.max(r.y - p.y, 0, p.y - r.y - r.h));

for (const [name, [spec0, rows]] of Object.entries(cases)) {
  const hl = rows.slice().sort((a, b) => b.value - a.value)[0];
  for (const style of ['leader', 'ledger']) {
    const spec = { ...spec0, flow_map_labels: style, highlight_values: [hl.source, hl.target] };
    const v = validateVizSpec(spec); assert(v.length === 0, `${name}/${style} validate: ${v.join('|')}`);
    const svg = renderVizBundle(spec, rows).desktop;
    const qa = runRenderQa({ desktop: svg }); assert(qa.passed, `${name}/${style} render QA failed (${qa.failure_count})`);
    // Chinese chrome, none of the English defaults
    for (const t of ['起点', '终点', '线宽', '弧线表示起点与终点之间的关系']) assert(svg.includes(t), `${name}/${style} missing ${t}`);
    assert(!/observed start|destination \/|Arcs encode/.test(svg), `${name}/${style} English default string left`);
    assert(!svg.includes('…'), `${name}/${style} truncation mark`);
    // one accent arc only
    const accent = [...svg.matchAll(/data-role="cartographic-flow"[^>]* stroke="(#[0-9a-fA-F]{6})"/g)].filter((m) => m[1] !== '#8a9096').length; assert(accent === 1, `${name}/${style} accent arcs ${accent}`);
    // strict placement: plates and badges clear of every arc stroke (+2) and of every dot
    const arcs = arcsOf(svg), dots = [...svg.matchAll(/<circle data-role="cartographic-(?:origin|destination)" cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/g)].map((m) => ({ x: +m[1], y: +m[2], r: +m[3] }));
    assert(arcs.length === rows.length, `${name}/${style} arcs ${arcs.length}`);
    for (const m of svg.matchAll(/<rect data-role="cartographic-label-bg"[^>]* x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
      const r = { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
      for (const a of arcs) for (const p of a.pts) assert(rectDist(r, p) > a.hw + 2 - 0.01, `${name}/${style} name plate on an arc stroke`);
      for (const d of dots) assert(rectDist(r, d) > d.r + 2 - 0.01, `${name}/${style} name plate on a dot`);
    }
    for (const m of svg.matchAll(/<circle data-role="annotation-marker" cx="([\d.-]+)" cy="([\d.-]+)" r="8.5"/g)) {
      const c = { x: +m[1], y: +m[2] }; if (c.x > 724 - 12) continue; // ledger panel rows sit outside the map
      for (const a of arcs) for (const p of a.pts) assert(Math.hypot(p.x - c.x, p.y - c.y) > a.hw + 2 + 8.5 - 0.01, `${name}/${style} badge on an arc stroke`);
      for (const d of dots) assert(Math.hypot(d.x - c.x, d.y - c.y) > d.r + 8.5 + 2 - 0.01, `${name}/${style} badge on a dot`);
    }
    // linear width: widest arc is 18px, others proportional (min 2)
    const widths = [...svg.matchAll(/data-role="cartographic-flow"[^>]* stroke-width="([\d.]+)"/g)].map((m) => +m[1]);
    assert(Math.abs(Math.max(...widths) - 18) < 0.01, `${name}/${style} widest arc ${Math.max(...widths)}`);
    console.log(`ok ${name}/${style}: ${rows.length} arcs, QA pass, ${svg.length} bytes`);
  }
  // flag absent: no new chrome, and (when BASE_WT is given) identical to the code without the feature
  const off = renderVizBundle(spec0, rows).desktop; assert(!off.includes('legend-swatch') && !off.includes('annotation-marker'), `${name} flag off draws flag-only parts`);
  if (process.env.BASE_WT) {
    const old = await import(`${process.env.BASE_WT}/runtime/pi/viz.mjs`);
    assert(old.renderVizBundle(spec0, rows).desktop === off, `${name} flag-off output differs from base`); console.log(`ok ${name}: flag-off byte-identical to base`);
  }
}
const bad = validateVizSpec({ ...cases.eia6[0], flow_map_labels: 'badges', highlight_values: [] }); assert(bad.some((e) => /flow_map_labels/.test(e)), 'bad flag value not rejected');
const geo = validateVizSpec({ ...cases.eia6[0], flow_map_labels: 'leader', geometry_semantics: 'great_circle_reference' }); assert(geo.some((e) => /abstract_od/.test(e)), 'non-abstract_od not rejected');
console.log('flow_map_labels tests passed');
