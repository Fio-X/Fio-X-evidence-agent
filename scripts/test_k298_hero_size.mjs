#!/usr/bin/env node
// K298: NEWSROOM_HERO_SIZE_UP=1 (exact "1", default off) draws a full-width page big number larger (first-glance element) without clipping;
// off is byte-identical. Synthetic data only.
// data only; every page also passes page lint and page render QA.
import assert from 'node:assert/strict';
import { CLEAN_HERO_CHECKS } from './lib_hero_checks.mjs';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

const claim = 'claim-stat-row';
const context = { hero_checks: CLEAN_HERO_CHECKS, verified_claim_ids: [claim], mobile_pages: false };
const rows = [{ category: 'A', value: 42 }, { category: 'B', value: 31 }, { category: 'C', value: 18 }, { category: 'D', value: 9 }];
const vizSpec = { schema_version: '0.9.0', reader_task: 'ranking', takeaway: 'A leads the selected categories.', chart_type: 'horizontal_bar', title: 'A leads this selected comparison', subtitle: 'Synthetic fixture', alt: 'Horizontal bars rank four synthetic categories from A at 42 to D at 9.', source_note: 'Synthetic fixture', claim_id: claim, sql: 'SELECT * FROM synthetic_bar', unit: 'units', category_field: 'category', value_field: 'value' };
const lint = lintVizSpec(vizSpec, rows, context);
assert.equal(lint.passed, true, lint.blockers?.join(' | '));
const bundle = renderVizBundle(vizSpec, rows);
const critic = critiqueViz(vizSpec, rows, lint, bundle.desktop);
const assets = { 'visualizations/bar.json': { desktopSvg: bundle.desktop, mobileSvg: bundle.mobile, manifest: { claim_id: claim, source_note: vizSpec.source_note, chart_type: vizSpec.chart_type, alt: vizSpec.alt }, critic: { passed: true, score: critic.score } } };

const stat = (id, extra = {}) => ({ id, type: 'hero_stat', span: 'third', value: '55', unit: '个', label: 'Synthetic items counted in the sample', detail: 'Verified claim fixture', claim_id: claim, ...extra });
const chart = { id: 'bar', type: 'visual', span: 'full', label: 'The ranking', manifest_ref: 'visualizations/bar.json' };
const header = (id) => ({ id, type: 'section_header', span: 'full', eyebrow: 'Part', heading: 'A new section starts here', deck: 'A short deck for the section.' });
const text = (id, body, extra = {}) => ({ id, type: 'text', span: 'full', label: 'Context', heading: 'A short note', body, claim_ids: [claim], ...extra });
const SHORT = 'A short synthetic paragraph that explains the number above in one or two lines.';
const LONG = Array.from({ length: 14 }, (_, i) => `Sentence ${i + 1} adds more synthetic explanation about the sample and how it was counted.`).join(' ');
const page = (modules) => ({ schema_version: '1.0.0', kicker: 'SYNTHETIC', title: 'Stat row layout regression page', dek: 'A synthetic page used to check where a lone big number is placed on the desktop page.', alt: 'A synthetic page with a chart, a big number and text.', byline: 'Newsroom Agent', date_label: 'Regression', layout: 'feature', complexity_budget: 'medium', source_note: 'Synthetic fixture', modules });

function compose(modules) {
  const spec = page(modules);
  assert.deepEqual(validateInfographicSpec(spec), []);
  const l = lintInfographicSpec(spec, assets, context);
  assert.equal(l.passed, true, l.blockers.join(' | '));
  const out = composeInfographicBundle(spec, assets, { mobilePages: false });
  const qa = runRenderQa({ desktop: out.desktop.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports.desktop.geometry.failures.slice(0, 5)));
  return out;
}
const run = (value, unit) => {
  const out = compose([chart, stat('s1', { value, unit, span: 'full' }), header('h2'), text('t2', SHORT)]);
  const svg = out.desktop.svg;
  const m = svg.match(new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)" font-family="[^"]*" font-size="(\\d+)" font-weight="700" fill="[^"]*">${value.replace(/[.,]/g, (c) => '\\' + c)}`));
  assert.ok(m, `numeral ${value} drawn`);
  const label = svg.match(/<text x="([\d.]+)"[^>]*>Synthetic items counted/);
  assert.ok(label, 'label drawn');
  return { svg, size: +m[3], numX: +m[1], labelX: +label[1], height: out.desktop.height };
};
const VALUES = [['5', '个'], ['3,096', '万人'], ['12,345,678', '亿元'], ['100', '%'], ['87.5', '%']];
const WIDE = ['\u2212325.6', '万公顷'];
const mode = process.argv[2];
if (mode === undefined) {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const hashes = {};
  for (const [v, env] of [['off', {}], ['on', { NEWSROOM_HERO_SIZE_UP: '1' }], ['two', { NEWSROOM_HERO_SIZE_UP: '2' }], ['wide', { NEWSROOM_HERO_GLYPH_WIDTH: '1' }], ['wideup', { NEWSROOM_HERO_SIZE_UP: '1', NEWSROOM_HERO_GLYPH_WIDTH: '1' }],
    ['junk0', { NEWSROOM_HERO_GLYPH_WIDTH: '0' }], ['junktrue', { NEWSROOM_HERO_GLYPH_WIDTH: 'true' }], ['junksp', { NEWSROOM_HERO_GLYPH_WIDTH: ' 1' }]]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), v], { env: { ...process.env, NEWSROOM_HERO_SIZE_UP: '', NEWSROOM_HERO_GLYPH_WIDTH: '', ...env }, encoding: 'utf8' });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    assert.equal(r.status, 0, `${v} half failed`);
    hashes[v] = (r.stdout.match(/HASH (\w+)/) || [])[1];
  }
  for (const j of ['junk0', 'junktrue', 'junksp']) assert.equal(hashes[j], hashes.off, `${j}: glyph-width switch off is byte-identical`);
  console.log('k298 hero size PASS');
  process.exit(0);
}
if (mode === 'wide' || mode === 'wideup') {
  // K318: the t14 lead number (a signed decimal with a three-character unit) only clears the detail line with the wider glyph estimate; run() asserts render QA passes
  const r = run(...WIDE);
  if (mode === 'wide') assert.equal(r.size, 58, 'wide alone keeps 58px');
  else assert.ok(r.size >= 72, `\u2212325.6 万公顷 is at least 72px (got ${r.size})`);
  console.log(`k298 ${mode} ok ${r.size}px`);
  process.exit(0);
}
const results = VALUES.map(([v, u]) => [v, run(v, u)]);
if (mode.startsWith('junk') || mode === 'off' || mode === 'two') {
  const { createHash } = await import('node:crypto');
  console.log('HASH ' + createHash('sha1').update(results.map(([, r]) => r.svg).join('|')).digest('hex').slice(0, 16));
}
if (mode === 'off' || mode === 'two' || mode.startsWith('junk')) {
  for (const [v, r] of results) assert.equal(r.size, 58, `${mode}: ${v} stays 58px`);
  console.log(`k298 ${mode} ok`);
} else {
  for (const [v, r] of results) {
    assert.ok(r.size >= 58 && r.size <= 88, `${v}: size ${r.size} in 58..88`);
    assert.ok(r.labelX > r.numX + 100, `${v}: label right of numeral`);
  }
  assert.equal(results[0][1].size, 88, 'a one-digit hero gets the full 88px (5.5x a 16px body)');
  assert.ok(results[1][1].size >= 80, '3,096 万人 is at least 80px');
  assert.ok(results[2][1].size >= 58, '10-glyph value still fits (never below 58)');
  for (const [v, r] of results) assert.ok(r.size > 58 || v === '12,345,678', `${v} is larger than today's 58px`);
  console.log('k298 on ok ' + results.map(([v, r]) => `${v}=${r.size}px/h${r.height}`).join(' '));
}
