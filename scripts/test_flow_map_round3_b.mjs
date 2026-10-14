// V522 Part B: one decimal count per number set, lower width cap, auto extent (default off), URL on its own footer line (default off).
import { pathToFileURL } from 'node:url';
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from '../runtime/pi/cartography.mjs';
import { FLOW_MAX_WIDTH, flowWidth, titleDecimals, widthSamples } from '../runtime/pi/flow_map_labels.mjs';
import { lintVizSpec, renderVizBundle, textUnits } from '../runtime/pi/viz.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

const assert = (c, m) => { if (!c) throw new Error(m); };
const ok = (m) => console.log('ok', m);
const base = (title, unit) => ({ schema_version: '1.0.0', chart_type: 'cartographic_flow_map', reader_task: 'flow', visual_family: 'spatial', data_topology: 'geo_edges', language: 'zh', title, subtitle: '测试数据', unit, claim_id: 'claim-carto-v15', sql: 'SELECT * FROM cartographic_flow_fixture', alt: `${title}。地图上的流向弧线。`, source_note: '测试数据。', note: '弧线表示关系，不是路线。', value_field: 'value', source_field: 'source', target_field: 'target', geometry_crs: 'EPSG:4326', projection: 'natural_earth_1', basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: 'none', geometry_semantics: 'abstract_od', source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon', extent_mode: 'data' });
const ENV = ['NEWSROOM_FLOW_MAP_LABELS', 'NEWSROOM_FLOW_MAP_AUTO_EXTENT', 'NEWSROOM_NOTE_URL_LINE'];
const setEnv = (o) => { for (const k of ENV) delete process.env[k]; Object.assign(process.env, o); };
const star = (n, vals, dest = '德国', lon0 = -150, lonStep = 20) => Array.from({ length: n }, (_, i) => ({ source: `来源${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ''}`, target: dest, source_lat: -40 + (i * 11) % 90, source_lon: lon0 + (i * lonStep) % 300, target_lat: 51, target_lon: 10, value: vals[i] }));
const hl = (rows) => rows.slice().sort((a, b) => b.value - a.value)[0];
const mk = (extra, rows) => ({ ...base('测试', '万吨'), highlight_values: [hl(rows).source, hl(rows).target], ...extra });
const decs = (t) => /\.(\d+)/.exec(t)?.[1].length ?? 0;
const texts = (svg, role) => [...svg.matchAll(new RegExp(`data-role="${role}"[^>]*>([^<]*)<`, 'g'))].map((m) => m[1]);
setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1' });

// B1 numbers: one decimal count per set, raised to the title/subtitle decimals, capped at 2; claim and subtitle text untouched
{
  const rows = star(5, [375.2, 120.5, 98, 12, 5]), sub = '最大的一条是 375.2 万吨';
  const spec = mk({ flow_map_labels: 'ledger', subtitle: sub }, rows), svg = renderVizBundle(spec, rows).desktop, v = texts(svg, 'flow-ledger-value');
  assert(v.length === 5 && v.every((t) => decs(t) === 1), `ledger numbers should all carry 1 decimal: ${v}`);
  assert(v[0] === '375.2' && v[2] === '98.0', `ledger numbers: ${v}`);
  assert(svg.includes(sub), 'subtitle text changed');
  const lead = mk({ flow_map_labels: 'leader', subtitle: sub }, rows), ls = renderVizBundle(lead, rows).desktop.replace(/<[^>]+>/g, ' ');
  assert(/来源A 375\.2/.test(ls), 'leader label should print 375.2 like the subtitle');
  const plain = mk({ flow_map_labels: 'ledger', subtitle: '五个来源' }, rows), pv = texts(renderVizBundle(plain, rows).desktop, 'flow-ledger-value');
  assert(pv.some((t) => decs(t) === 0) || pv.every((t) => decs(t) === decs(pv[0])), `without subtitle decimals one count still holds: ${pv}`);
  assert(titleDecimals({ title: '3.14159 万', subtitle: '' }) === 2 && titleDecimals({ title: '大', subtitle: '共 12 个' }) === 0, 'titleDecimals cap/none');
  ok(`ledger and leader numbers share the subtitle's 1 decimal (${v.join(' ')}); decimals cap at 2`);
}
{
  // two columns: each column has one decimal count of its own
  const vals = Array.from({ length: 30 }, (_, i) => (i < 15 ? 2000 - i * 90 : (30 - i) * 0.35 + 0.05));
  const rows = star(30, vals), svg = renderVizBundle(mk({ flow_map_labels: 'ledger' }, rows), rows).desktop;
  const cells = [...svg.matchAll(/data-role="flow-ledger-value" x="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
  const byCol = new Map(); for (const [x, t] of cells) byCol.set(x, [...(byCol.get(x) ?? []), t]);
  assert(byCol.size === 2, `expected two columns, got ${byCol.size}`);
  for (const [x, ts] of byCol) assert(new Set(ts.map(decs)).size === 1, `column at x=${x} mixes decimal counts: ${ts.slice(0, 8)}`);
  assert(new Set([...byCol.values()].map((ts) => decs(ts[0]))).size === 2, 'the two columns should carry different decimal counts for this data');
  assert(runRenderQa({ desktop: svg }).passed, 'two-column numbers: render QA failed');
  ok(`two columns carry ${[...byCol.values()].map((ts) => `${decs(ts[0])} decimals`).join(' and ')}`);
}

// B2 line width: the widest line is no wider than a badge, and the legend swatches use the same function
{
  const rows = star(6, [900, 600, 300, 150, 60, 20]), svg = renderVizBundle(mk({ flow_map_labels: 'leader' }, rows), rows).desktop;
  const widths = [...svg.matchAll(/data-role="cartographic-flow"[^>]* stroke-width="([\d.]+)"/g)].map((m) => +m[1]);
  assert(Math.max(...widths) <= 17 && Math.abs(Math.max(...widths) - FLOW_MAX_WIDTH) < 0.01, `widest line ${Math.max(...widths)}`);
  const sw = [...svg.matchAll(/data-role="legend-swatch"[^>]* height="([\d.]+)"/g)].map((m) => +m[1]);
  assert(sw.length >= 2 && sw.every((h) => h <= FLOW_MAX_WIDTH + 0.01), `legend swatch wider than the cap: ${sw}`);
  const exp = widthSamples(900).map((v) => flowWidth(v, 900).toFixed(1));
  assert(JSON.stringify(sw.map((h) => h.toFixed(1))) === JSON.stringify(exp), `legend ${sw} not in step with ${exp}`);
  ok(`widest line ${Math.max(...widths)} px (badge is 17 px); legend swatches ${sw.map((h) => h.toFixed(1)).join(', ')} px`);
}

// B3 auto extent
const worldRows = star(5, [50, 40, 30, 20, 10]), euro = Array.from({ length: 5 }, (_, i) => ({ source: `欧${i}`, target: '德国', source_lat: 40 + i * 4, source_lon: -5 + i * 8, target_lat: 51, target_lon: 10, value: 50 - i * 5 }));
const credit = (svg) => /按数据范围/.test(svg) ? 'data' : /世界范围/.test(svg) ? 'world' : '?';
{
  setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1' });
  const noExt = (r) => { const sp = mk({ flow_map_labels: 'leader' }, r); delete sp.extent_mode; return sp; };
  const offE = renderVizBundle(noExt(euro), euro).desktop, offW = renderVizBundle(noExt(worldRows), worldRows).desktop;
  assert(credit(offE) === 'world' && credit(offW) === 'world', 'switch off: an unset extent_mode must stay world');
  const world = mk({ flow_map_labels: 'leader', extent_mode: 'world' }, euro);
  assert(renderVizBundle(noExt(euro), euro).desktop === renderVizBundle(world, euro).desktop, 'switch off: unset must equal an explicit world extent');
  setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1', NEWSROOM_FLOW_MAP_AUTO_EXTENT: '0' });
  assert(credit(renderVizBundle(noExt(euro), euro).desktop) === 'world', 'switch "0" must not turn auto extent on');
  setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1', NEWSROOM_FLOW_MAP_AUTO_EXTENT: '1' });
  const onE = renderVizBundle(noExt(euro), euro).desktop, onW = renderVizBundle(noExt(worldRows), worldRows).desktop;
  assert(credit(onE) === 'data', 'regional endpoints should auto-fit the data');
  assert(credit(onW) === 'world', 'world-wide endpoints should stay on the world extent');
  assert(runRenderQa({ desktop: onE }).passed, 'auto-extent regional map: render QA failed');
  // an explicit extent_mode is never overridden; world + regional is a lint warning only
  assert(credit(renderVizBundle(world, euro).desktop) === 'world', 'explicit world must be kept');
  const lw = lintVizSpec(world, euro), w = JSON.stringify(lw);
  assert(/every endpoint lies within one region/.test(w), 'no lint warning for explicit world with regional endpoints');
  assert(!/every endpoint lies within one region/.test(JSON.stringify(lintVizSpec(mk({ flow_map_labels: 'leader', extent_mode: 'world' }, worldRows), worldRows))), 'warning on a world-wide map');
  assert(!/every endpoint lies within one region/.test(JSON.stringify(lintVizSpec(noExt(euro), euro))), 'warning when extent_mode is unset');
  setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1' });
  assert(!/every endpoint lies within one region/.test(JSON.stringify(lintVizSpec(world, euro))), 'lint warning with the switch off');
  ok('auto extent: regional -> data, world-wide -> world, explicit kept, lint warns only for explicit world; off = unchanged');
}

// B4 URL on its own footer line
{
  const url = 'https://example.org/data/table?id=1&year=2023';
  const bar = { schema_version: '0.7.0', reader_task: 'comparison', title: '测试排名', subtitle: '测试数据', alt: '测试排名的横向条形图，用于检查页脚换行。', source_note: `某机构 ${url} 公布`, claim_id: 'c', sql: 'SELECT 1', unit: '%', sort: 'desc', highlight_values: ['A'], direct_labels: true, annotations: [], chart_type: 'horizontal_bar', category_field: 'category', value_field: 'value', language: 'zh', takeaway: '测试', note: `完整口径见 ${url} 的说明页，口径按申报国统计，更新日期以页面为准，数值四舍五入。` };
  const rowsBar = Array.from({ length: 6 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3 }));
  const flowRows = star(5, [50, 40, 30, 20, 10]), flowSpec = mk({ flow_map_labels: 'leader', note: `见 ${url} 说明。` }, flowRows);
  const cases = { bar: [bar, rowsBar], flow: [flowSpec, flowRows] };
  const render = (e, [sp, rs]) => { setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1', ...e }); return renderVizBundle(sp, rs).desktop; };
  for (const [name, c] of Object.entries(cases)) {
    const off = render({}, c);
    assert(off === render({ NEWSROOM_NOTE_URL_LINE: '0' }, c) && off === render({ NEWSROOM_NOTE_URL_LINE: 'true' }, c), `${name}: only "1" may turn the URL line on`);
    if (process.env.BASE_WT && name === 'bar') {
      const prev = process.env.NEWSROOM_FLOW_MAP_LABELS; delete process.env.NEWSROOM_FLOW_MAP_LABELS;
      const b = await import(pathToFileURL(`${process.env.BASE_WT}/runtime/pi/viz.mjs`).href);
      assert(b.renderVizBundle(bar, rowsBar).desktop === render({}, c), 'bar chart: switch off differs from the base');
      if (prev === undefined) delete process.env.NEWSROOM_FLOW_MAP_LABELS; else process.env.NEWSROOM_FLOW_MAP_LABELS = prev;
    }
    const on = render({ NEWSROOM_NOTE_URL_LINE: '1' }, c);
    const urlLines = [...on.matchAll(/<text[^>]* font-size="([\d.]+)"[^>]*>([^<]*https:\/\/[^<]*)</g)].map((m) => [+m[1], m[2].replace(/&amp;/g, '&')]);
    assert(urlLines.length >= 1 && urlLines.every(([sz, t]) => sz >= 12 && t === url), `${name}: URL not alone on its own line: ${JSON.stringify(urlLines)}`);
    const qaOn = runRenderQa({ desktop: on });
    assert(qaOn.passed, `${name}: render QA failed with the URL line: ${JSON.stringify(qaOn.viewports.desktop.geometry.failures.slice(0, 3)).slice(0, 500)}`);
  }
  // a bar chart without any URL is untouched even with the switch on
  const plain = { ...bar, note: '没有网址的普通说明。', source_note: '某机构' };
  assert(render({}, [plain, rowsBar]) === render({ NEWSROOM_NOTE_URL_LINE: '1' }, [plain, rowsBar]), 'URL-free footers must not change with the switch on');
  ok('URL line: own line (12px, the QA floor), sentence kept, off/"0"/"true" byte-identical, URL-free charts unchanged');
}

// B4b line-break punctuation rule (W3C clreq / GB/T 15834): no line starts with closing punctuation or ends with an opening bracket; nothing is dropped.
{
  const url = 'https://example.org/data/table?id=1&year=2023_latest_developments';
  const rows = star(5, [50, 40, 30, 20, 10]);
  const CLOSE = /^[）」』》】〕〉，。、；：！？…)\]!?,.;:]/u, OPEN = /[（「『《【〔〈(\[]$/u;
  const lead = '能源统计里的伙伴是「country of origin for both intra- and extra-EU imports」';
  const notes = [`${lead}（${url}）。另有 10.7% 的进口没有具体来源国（未说明 6%、其他美洲国家 3.1%、其他非洲国家 1.6%），未画在地图上。`, ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `${'说明'.repeat(k * 5 + 20)}（甲乙丙）、「丁戊」，${'己'.repeat(k + 3)}。${'庚'.repeat(31 + k)}（${url}）。${'辛'.repeat(40 - k)}《壬》；癸！`)];
  for (const [i, note] of notes.entries()) {
    const spec = mk({ flow_map_labels: 'leader', route_provenance_note: note }, rows);
    setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1', NEWSROOM_NOTE_URL_LINE: '1' });
    const svg = renderVizBundle(spec, rows).desktop, lines = texts(svg, 'cartographic-provenance-note').map((t) => t.replace(/&amp;/g, '&'));
    assert(lines.length >= 2, `note ${i}: expected a wrapped note`);
    assert(lines.join('').replace(/\s/g, '') === note.replace(/\s/g, ''), `note ${i}: characters dropped or changed: ${JSON.stringify(lines)}`);
    for (const l of lines) assert(!CLOSE.test(l) && !OPEN.test(l.trimEnd()), `note ${i}: bad line edge: ${l.slice(0, 20)}…${l.slice(-6)}`);
    assert(lines.some((l) => l.includes(url)), `note ${i}: URL split across lines`);
    const qa = runRenderQa({ desktop: svg });
    assert(qa.passed, `note ${i}: render QA failed: ${JSON.stringify(qa.viewports.desktop.geometry.failures.slice(0, 3)).slice(0, 400)}`);
    setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1' });
    const off = renderVizBundle(spec, rows).desktop;
    setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1', NEWSROOM_NOTE_URL_LINE: '0' });
    assert(off === renderVizBundle(spec, rows).desktop, `note ${i}: only "1" may turn the rule on`);
  }
  // the bracketed URL sits on one line with its bracket and full stop
  setEnv({ NEWSROOM_FLOW_MAP_LABELS: '1', NEWSROOM_NOTE_URL_LINE: '1' });
  const l0 = texts(renderVizBundle(mk({ flow_map_labels: 'leader', route_provenance_note: notes[0] }, rows), rows).desktop, 'cartographic-provenance-note').map((t) => t.replace(/&amp;/g, '&'));
  assert(l0.includes(`（${url}）。`), `bracketed URL line: ${JSON.stringify(l0)}`);
  ok('line-break rule: no line starts with closing punctuation or ends with an opening bracket, text unchanged, URL keeps its bracket and full stop, off byte-identical');
}
console.log('flow_map round 3 part B tests passed');
