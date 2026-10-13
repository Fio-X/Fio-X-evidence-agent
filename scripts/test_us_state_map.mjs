#!/usr/bin/env node
// 1012l step 3: choropleth with category_names 'us_state' behind NEWSROOM_US_STATES=1.
// Run: node scripts/test_us_state_map.mjs   (re-runs itself with the switch on for the "on" half)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, '..', 'runtime/pi/');
const names = JSON.parse(readFileSync(R + 'assets/us-state-names.json', 'utf8')).states;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const mode = process.argv[2];

const { getBasemap } = await import(R + 'basemap_registry.mjs');
const { lintVizSpec, renderVizBundle } = await import(R + 'viz.mjs');
const bm = getBasemap('naturalearth_admin1_us_110m');
const world = getBasemap('naturalearth_admin0_50m') ?? null;
const baseSpec = (over = {}) => ({ schema_version: '0.9.0', reader_task: 'spatial', title: '美国各州示例（假数据）', alt: '美国各州某指标的面积地图，颜色越深数值越高。', source_note: '示例假数据', claim_id: 'c1', sql: 'SELECT state, rate, year FROM t', unit: '%', chart_type: 'choropleth', language: 'zh', category_field: 'state', value_field: 'rate', category_names: 'us_state', reference_period_field: 'year', mixed_period_strategy: 'acknowledge', basemap_id: bm.id, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash, highlight_values: [], annotations: [], ...over });
const fakeRows = () => names.map((s, i) => ({ state: s.usps, rate: 5 + ((i * 37) % 60) + (i % 7) / 10, year: 2023 }));
const lint = (spec, rows) => lintVizSpec(spec, rows, { verified_claim_ids: ['c1'] });
const text = (l) => JSON.stringify(l.blockers);

if (mode !== 'on') {
  // switch off: the state mode does not exist
  const en = await import(R + 'economy_names.mjs');
  ok(!en.ECONOMY_NAME_MODES.includes('us_state'), 'off: us_state is not a name mode');
  const l = lint(baseSpec(), fakeRows());
  ok(l.blockers.length > 0, 'off: a us_state spec is blocked');
  const ch = await import(R + 'choropleth.mjs');
  ok(ch.isUsStateMap(baseSpec()) === false, 'off: isUsStateMap is false');
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'on'], { env: { ...process.env, NEWSROOM_US_STATES: '1' }, encoding: 'utf8' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status, 0, 'on half failed');
  console.log(`us state map (off half) PASS checks=${checks}`);
  process.exit(0);
}

const { runRenderQa } = await import(R + 'render_qa.mjs');
const { fitUsProjection, usPiece } = await import(R + 'us_projection.mjs');
const en = await import(R + 'economy_names.mjs');
ok(en.ECONOMY_NAME_MODES.includes('us_state'), 'on: us_state is a name mode');

// 51-row fake data: lint clean, renders, desktop QA passes
const rows = fakeRows();
const spec = baseSpec();
const l = lint(spec, rows);
ok(l.blockers.length === 0, `on: 51 rows lint clean ${text(l)}`);
// full state names also join
ok(lint(baseSpec(), names.map((s, i) => ({ state: s.en, rate: 10 + i, year: 2023 }))).blockers.length === 0, 'on: English full names join');
const { desktop, mobile } = renderVizBundle(spec, rows);
const qa = runRenderQa({ desktop, mobile });
ok(qa.viewports.desktop.passed === true, `on: desktop render QA passes ${JSON.stringify(qa.viewports.desktop.geometry.failures.map((f) => f.message))}`);
// Chinese names that are in the table join (lookup, not translation); ones that are not in it are blocked
ok(lint(baseSpec(), names.map((s, i) => ({ state: s.zh, rate: 10 + i, year: 2023 }))).blockers.length === 0, 'on: table Chinese names join');
const zhOff = lint(baseSpec(), [...names.slice(1).map((s, i) => ({ state: s.zh, rate: 10 + i, year: 2023 })), { state: '阿拉巴马州', rate: 3, year: 2023 }]);
ok(zhOff.blockers.length > 0 && /阿拉巴马州/.test(text(zhOff)), `on: a Chinese name not in the table is blocked ${text(zhOff)}`);
// Chinese names from the table
ok(desktop.includes('亚拉巴马州') || desktop.includes('亚拉巴马'), 'on: Alabama name from the table');
ok(desktop.includes('哥伦比亚特区'), 'on: DC name from the table');
ok(!desktop.includes('Alabama'), 'on: no English name leaks into a zh chart');
// Alaska and Hawaii in bordered boxes with the note
for (const k of ['US-AK', 'US-HI']) {
  ok(new RegExp(`data-role="choropleth-us-box"[^>]*data-box="${k}"|data-box="${k}"[^>]*data-role="choropleth-us-box"`).test(desktop), `on: ${k} box drawn`);
  ok(new RegExp(`data-iso3="${k}"`).test(desktop), `on: ${k} region present`);
}
ok(desktop.includes('阿拉斯加') && desktop.includes('夏威夷'), 'on: both boxed states labelled by name');
ok(desktop.includes('阿拉斯加、夏威夷不按比例、不按实际位置'), 'on: the not-to-scale note is on the chart');
// 51 data regions, each with a value
ok((desktop.match(/data-role="choropleth-data"/g) ?? []).length >= 51, 'on: 51 data regions');

// lint: missing state, then unknown name, separately
const missing = lint(spec, rows.filter((r) => r.state !== 'OH'));
ok(missing.blockers.length > 0 && /50 of 51|1 of 51|every state/.test(text(missing)), `on: a missing state is blocked ${text(missing)}`);
const extra = lint(spec, [...rows, { state: 'Atlantis', rate: 1, year: 2023 }]);
ok(extra.blockers.length > 0 && /Atlantis/.test(text(extra)), `on: an unknown name is blocked ${text(extra)}`);
// basemap rule: the world basemap id is refused for a state map
if (world) {
  const wrong = lint(baseSpec({ basemap_id: world.id, basemap_source_url: world.source_url, basemap_license: world.license, basemap_content_hash: world.content_hash }), rows);
  ok(wrong.blockers.length > 0, 'on: world basemap id refused for a state map');
}
const noBm = lint(baseSpec({ basemap_id: undefined }), rows);
ok(noBm.blockers.length > 0, 'on: missing basemap id refused');

// projection: boxes and the lower 48 do not collide; no ring segment crosses the map
const geo = JSON.parse(readFileSync(R + 'assets/naturalearth-admin1-us-110m.geojson', 'utf8'));
const side = JSON.parse(readFileSync(R + 'assets/naturalearth-admin1-us-110m-attributes.json', 'utf8'));
const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const allPts = geo.features.flatMap((f) => polys(f.geometry).flat().flat());
const W = 1000, H = 640;
const P = fitUsProjection(allPts, 0, W, 0, H);
const inBox = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
let spanMax = 0, collide = 0;
geo.features.forEach((f, i) => {
  const usps = side.features[i].usps;
  for (const poly of polys(f.geometry)) for (const ring of poly) {
    let prev = null;
    for (let j = 0; j < ring.length - 1; j++) {
      const [x0, y0] = ring[j], [x1, y1] = ring[j + 1];
      const n = 8;
      for (let k = 0; k <= n; k++) {
        const lon = x0 + (x1 - x0) * k / n, lat = y0 + (y1 - y0) * k / n;
        const p = P.project(lon, lat);
        if (usps !== 'AK' && usps !== 'HI' && (inBox(p, P.boxes.AK) || inBox(p, P.boxes.HI))) collide++;
        if (prev && (usps === 'AK' || usps === 'HI') === (usPiece(lon, lat) !== 'L48')) spanMax = Math.max(spanMax, Math.abs(p.x - prev.x));
        prev = p;
      }
    }
  }
});
ok(collide === 0, 'lower 48 never enters the Alaska or Hawaii box');
ok(spanMax < W / 2, `no ring segment spans half the map (max ${spanMax.toFixed(1)})`);
// Aleutian ring that crosses the antimeridian (positive longitudes) lands beside Alaska, not across the map
const alu = [[-170, 52], [-179, 51.5], [179, 51.3], [172, 52.5], [-170, 52]];
let aluMax = 0;
for (let j = 0; j < alu.length - 1; j++) aluMax = Math.max(aluMax, Math.abs(P.project(...alu[j]).x - P.project(...alu[j + 1]).x));
ok(aluMax < W / 2, `antimeridian segments stay local (max ${aluMax.toFixed(1)})`);
for (const b of Object.values(P.boxes)) ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H, 'box inside the map frame');
console.log(`us state map (on half) PASS checks=${checks}`);
