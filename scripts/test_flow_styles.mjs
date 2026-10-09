// flow_styles (C circles, D trunk): default-off, red-on-defect checks. Optional: BASE_WT=<worktree before this change> proves switches-unset output is byte-identical.
// and every name box / badge sits clear of every arc stroke and dot (stricter than render QA).
// Optional: BASE_WT=<worktree without the flag> checks flag-off output is byte-identical.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from '../runtime/pi/cartography.mjs';
import { fmtSpec, lintVizSpec, renderVizBundle, validateVizSpec } from '../runtime/pi/viz.mjs';
import { flowNumberTexts } from '../runtime/pi/flow_map_labels.mjs';
import { resolveFlowStyle, circleRadius, circleLegendValues } from '../runtime/pi/flow_styles.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

process.env.NEWSROOM_FLOW_MAP_LABELS = '1';
const ROOT = new URL('..', import.meta.url).pathname;
const assert = (c, m) => { if (!c) throw new Error(m); };
const csv = (p) => { const [h, ...ls] = readFileSync(p, 'utf8').trim().split(/\r?\n/); const f = h.split(','); return ls.map((l) => { const v = l.split(','); return Object.fromEntries(f.map((k, i) => [k, /^-?\d+(\.\d+)?$/.test(v[i]) ? Number(v[i]) : v[i]])); }); };
const base = (title, unit) => ({ schema_version: '1.0.0', chart_type: 'cartographic_flow_map', reader_task: 'flow', visual_family: 'spatial', data_topology: 'geo_edges', language: 'zh', title, subtitle: '测试数据', unit, claim_id: 'claim-carto-v15', sql: 'SELECT * FROM cartographic_flow_fixture', alt: `${title}。地图上的流向弧线。`, source_note: '测试数据。', note: '弧线表示关系，不是路线。', value_field: 'value', source_field: 'source', target_field: 'target', geometry_crs: 'EPSG:4326', projection: 'natural_earth_1', basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: 'none', geometry_semantics: 'abstract_od', source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon', extent_mode: 'data' });
const ZH = { 'United States': '美国', Canada: '加拿大', Mexico: '墨西哥', 'Saudi Arabia': '沙特阿拉伯', Iraq: '伊拉克', Brazil: '巴西', Colombia: '哥伦比亚', India: '印度', 'United Arab Emirates': '阿联酋' };
const zh = (n) => ZH[n] ?? n;
const eia = csv(join(ROOT, 'fixtures/v09-realdata/eia-us-crude-imports-2024.csv')).map((r) => ({ source: zh(r.country), target: zh(r.target), source_lat: r.source_lat, source_lon: r.source_lon, target_lat: r.target_lat, target_lon: r.target_lon, value: r.thousand_bpd / 10 }));
const rem = csv(join(ROOT, 'fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.csv')).map((r) => ({ source: zh(r.source), target: zh(r.target), source_lat: r.source_lat, source_lon: r.source_lon, target_lat: r.target_lat, target_lon: r.target_lon, value: r.usd_billion * 10 }));
// 12 synthetic corridors between named capitals (names and coordinates are test data only)
const cities = [['甲', 10, 50], ['乙', 30, 40], ['丙', 70, 30], ['丁', 100, 10], ['戊', -60, -10], ['己', -100, 40], ['庚', 20, -20], ['辛', 120, 35], ['壬', 40, 10], ['癸', -10, 15], ['子', 80, 55], ['丑', 150, -25]];
const syn = Array.from({ length: 12 }, (_, i) => { const a = cities[i], b = cities[(i * 5 + 3) % 12 === i ? (i + 1) % 12 : (i * 5 + 3) % 12]; return { source: a[0], target: b[0], source_lat: a[2], source_lon: a[1], target_lat: b[2], target_lon: b[1], value: (12 - i) * 1000 + 17 }; });
// 15 origins -> one destination (a star above the 8-flow limit), stand-in for the Germany crude-oil map
const star15 = Array.from({ length: 15 }, (_, i) => ({ source: `来源${String.fromCharCode(65 + i)}`, target: '德国', source_lat: -40 + (i * 11) % 90, source_lon: -150 + i * 20, target_lat: 51, target_lon: 10, value: Math.round((15 - i) ** 1.6 * 4) + 3 }));
const cases = { star15: [base('德国原油来源', '万吨'), star15],  eia6: [base('美国原油进口', '万桶/日'), eia], remittance4: [base('侨汇走廊', '亿美元'), rem], synthetic12: [base('十二条走廊', '人'), syn] };

// ---- checkers (each goes red on its own defect; see the crafted-bad-SVG controls below) ----
const num = (s, k) => +new RegExp(`${k}="([\\d.-]+)"`).exec(s)[1];
const mapBadges = (svg) => [...svg.matchAll(/<circle data-role="annotation-marker" [^>]*>/g)].map((m) => ({ x: num(m[0], 'cx'), y: num(m[0], 'cy') })).filter((c) => c.x < 724 - 12);
const circlesOf = (svg) => [...svg.matchAll(/<circle data-role="cartographic-flow-circle" [^>]*>/g)].map((m) => ({ x: num(m[0], 'cx'), y: num(m[0], 'cy'), r: num(m[0], 'r') }));
const badgeOnCircle = (svg) => mapBadges(svg).some((b) => circlesOf(svg).some((c) => Math.hypot(b.x - c.x, b.y - c.y) < c.r + 8.5));
const trunksOf = (svg) => [...svg.matchAll(/<path data-role="cartographic-flow-trunk" [^>]* d="M([\d.-]+),([\d.-]+) Q[^"]*" [^>]*stroke-width="([\d.]+)"/g)].map((m) => ({ jx: +m[1], jy: +m[2], w: +m[3] }));
const branchWidthsInto = (svg, t) => [...svg.matchAll(/<path data-role="cartographic-flow" [^>]* d="M[^"]* ([\d.-]+),([\d.-]+)" [^>]*stroke-width="([\d.]+)"/g)].filter((m) => Math.hypot(+m[1] - t.jx, +m[2] - t.jy) < 0.2).map((m) => +m[3]);
const legendTicks = (svg) => [...svg.matchAll(/data-role="legend-tick"[^>]*>([^<]*)</g)].map((m) => m[1]);
const legendNotInData = (svg, rows, spec) => { const u = [...new Set(rows.map((r) => r.value))].sort((a, b) => b - a), tx = flowNumberTexts(spec, u, fmtSpec); return legendTicks(svg).filter((t) => !tx.includes(t)); }; // the same numbers the ledger prints
const run = (spec, rows, env) => { for (const k of ['NEWSROOM_FLOW_STYLE_CIRCLES', 'NEWSROOM_FLOW_STYLE_TRUNK']) delete process.env[k]; Object.assign(process.env, env); const svg = renderVizBundle(spec, rows).desktop; for (const k of ['NEWSROOM_FLOW_STYLE_CIRCLES', 'NEWSROOM_FLOW_STYLE_TRUNK']) delete process.env[k]; return svg; };
const C = { NEWSROOM_FLOW_STYLE_CIRCLES: '1' }, D = { NEWSROOM_FLOW_STYLE_TRUNK: '1' }, CD = { ...C, ...D };

// controls: the checkers do flag the defects
const fakeBadge = '<circle data-role="annotation-marker" cx="100" cy="100" r="8.5"/><circle data-role="cartographic-flow-circle" cx="104" cy="100" r="12"/>';
assert(badgeOnCircle(fakeBadge), 'control: badge over a circle not flagged');
assert(trunksOf('<path data-role="cartographic-flow-trunk" data-trunk-members="2" d="M1,2 Q3,4 5,6" fill="none" stroke="#8a9096" stroke-width="9"/>').length === 1, 'control: trunk parser');
assert(legendNotInData('<text data-role="legend-tick" x="1" y="1">123456</text>', [{ value: 5 }], { unit: '', language: 'zh' }).length === 1, 'control: invented legend value not flagged');

for (const [name, [spec0, rows0]] of Object.entries(cases)) {
  const hl = rows0.slice().sort((a, b) => b.value - a.value)[0];
  const spec = { ...spec0, flow_map_labels: 'ledger', highlight_values: [hl.source, hl.target] }, rows = rows0;
  const oneDest = new Set(rows.map((r) => r.target)).size === 1;
  // C
  const c = run(spec, rows, C);
  assert(runRenderQa({ desktop: c }).passed, `${name}/C render QA failed`);
  const circ = circlesOf(c); assert(circ.length === rows.length, `${name}/C circles ${circ.length} vs ${rows.length}`);
  assert(!badgeOnCircle(c), `${name}/C a badge sits on a circle`);
  // area proportional to the flow's own value: r^2 / value is one constant
  const vals = rows.map((r) => r.value).sort((a, b) => b - a), ks = circ.map((x) => x.r * x.r).sort((a, b) => b - a).map((r2, i) => r2 / vals[i]);
  assert(Math.max(...ks) / Math.min(...ks) < 1.02, `${name}/C area not proportional`);
  assert([...c.matchAll(/data-role="cartographic-flow" [^>]*stroke-width="([\d.]+)"/g)].every((m) => +m[1] === 1), `${name}/C lines not 1 px`);
  assert(legendNotInData(c, rows, spec).length === 0, `${name}/C legend value not in the data: ${legendNotInData(c, rows, spec)}`);
  assert(c.includes('圆面积') && c.includes('连线粗细不表示数值') && !c.includes('线宽（'), `${name}/C legend text`);
  assert(!c.includes('cartographic-flow-trunk'), `${name}/C drew a trunk`);
  // no circle at a shared destination: every circle centre is an origin
  const dests = [...c.matchAll(/<circle data-role="cartographic-destination" cx="([\d.-]+)" cy="([\d.-]+)"/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  if (oneDest) assert(!circ.some((x) => dests.some((d) => Math.hypot(d.x - x.x, d.y - x.y) < 1)), `${name}/C circle on the shared destination`);
  // D
  const d = run(spec, rows, D), dc = run(spec, rows, CD), tr = trunksOf(d);
  assert(runRenderQa({ desktop: d }).passed, `${name}/D render QA failed`);
  if (oneDest) {
    assert(tr.length >= 1, `${name}/D no trunk for a single destination`);
    for (const t of tr) { const bw = branchWidthsInto(d, t), s = bw.reduce((a, b) => a + b, 0); assert(bw.length >= 2 && Math.abs(s - t.w) < 0.05 * bw.length, `${name}/D trunk ${t.w} != sum of branches ${s}`); }
    assert(d.includes('干线宽度是支线之和'), `${name}/D legend sentence`);
    assert([...d.matchAll(/stroke-width="([\d.]+)"[^>]*stroke-opacity/g)].every((m) => +m[1] <= 14.01), `${name}/D width above the cap`);
    assert(!d.includes('marker-end'), `${name}/D arrowheads drawn`);
    assert(dc.includes('cartographic-flow-trunk') && !dc.includes('cartographic-flow-circle'), `${name}/CD both on, one destination: trunk wins`);
  } else {
    assert(!d.includes('cartographic-flow-trunk'), `${name}/D drew a trunk for ${new Set(rows.map((r) => r.target)).size} destinations`);
    assert(run(spec, rows, {}) === d, `${name}/D alone (circles off, 2+ destinations) differs from default`);
    assert(dc === c, `${name}/CD with 2+ destinations is not the C output`);
  }
  console.log(`ok ${name}: C ${circ.length} circles, QA pass; D ${tr.length} trunk(s)${oneDest ? '' : ' (not drawn: several destinations)'}`);
  if (process.env.BASE_WT) {
    const old = await import(`${process.env.BASE_WT}/runtime/pi/viz.mjs`);
    const o = old.renderVizBundle(spec, rows).desktop; assert(o === run(spec, rows, {}), `${name} both switches unset: differs from base`);
    delete process.env.NEWSROOM_FLOW_MAP_LABELS; // label layer off: the style switches have nothing to act on
    const o2 = old.renderVizBundle(spec0, rows).desktop; assert(o2 === run(spec0, rows, {}) && run(spec0, rows, CD) === o2, `${name} label layer off: switches changed the output`);
    process.env.NEWSROOM_FLOW_MAP_LABELS = '1';
    console.log(`ok ${name}: switches unset byte-identical to base`);
  }
}
// resolver: two destinations never get a trunk
assert(resolveFlowStyle(['a', 'b'], { circles: false, trunk: true }).style === 'default', 'trunk for two destinations (circles off)');
assert(resolveFlowStyle(['a', 'b'], { circles: true, trunk: true }).style === 'circles', 'two destinations must fall back to circles');
assert(resolveFlowStyle(['a', 'a'], { circles: true, trunk: true }).style === 'trunk', 'one destination must trunk');
assert(resolveFlowStyle(['a'], { circles: false, trunk: true }).style === 'default', 'a single flow has nothing to merge');
assert(Math.abs(circleRadius(25, 100) * 2 - circleRadius(100, 100)) < 1e-9, 'area not proportional');
assert(circleLegendValues([5, 1, 9, 3, 7]).join() === '9,5,1', 'legend picks');
console.log('ok flow_styles');
