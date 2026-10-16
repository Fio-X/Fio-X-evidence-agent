// Page alignment (Q1): side-by-side modules share one top-rule y; a chart's ink starts at the text column left edge;
// every page text is >= 12 px effective at its real display scale. Synthetic data only.
// passes page lint and page render QA.
import assert from 'node:assert/strict';
import { CLEAN_HERO_CHECKS } from './lib_hero_checks.mjs';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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


function compose(modules, extra = {}) {
  const spec = { ...page(modules), ...extra };
  assert.deepEqual(validateInfographicSpec(spec), []);
  const l = lintInfographicSpec(spec, assets, context);
  assert.equal(l.passed, true, l.blockers.join(' | '));
  const out = composeInfographicBundle(spec, assets, { mobilePages: false });
  const qa = runRenderQa({ desktop: out.desktop.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports.desktop.geometry.failures.slice(0, 5)));
  return out;
}
const box = (out, id) => out.desktop.boxes.find((b) => b.id === id);
import { _rhythmDebug as dbg } from '../runtime/pi/infographic.mjs';

// 1. Rule lines: a hero_stat beside a text module draws its red rule at the same y as the text module's hairline.
{
  const out = compose([chart, text('t1', SHORT), stat('s1')]);
  const t = box(out, 't1'), s = box(out, 's1');
  // NEWSROOM_PAGE_POLISH=1 drops the 4/8 pairing: the number is a full-width bar and the note sits on its own row below it.
  if (process.env.NEWSROOM_PAGE_POLISH === '1') { assert.equal(s.w, 1248, 'polish: stat bar is the full column'); assert.notEqual(t.y, s.y, 'polish: the note and the stat bar are on separate rows'); }
  else assert.equal(t.y, s.y, 'same row');
  const svg = out.desktop.svg;
  const red = [...svg.matchAll(/<rect data-role="hero-stat"[^>]* y="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(red.includes(s.y), `hero_stat rule y ${red} must equal its box y ${s.y}`);
  const hairlines = [...svg.matchAll(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1" stroke="#[0-9a-fA-F]+" stroke-width="1"/g)].map((m) => Number(m[1]));
  assert.ok(hairlines.includes(t.y), `text hairline y ${hairlines.slice(0, 8)} must equal its box y ${t.y}`);
  console.log('PASS rule lines of side-by-side modules share one y');
}

// 2. Ink-left: blank left margin of a chart (including end/middle-anchored text) is cut; ink never is.
{
  const mk = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 200">${inner}</svg>`;
  const left = (svg) => dbg.svgInkLeft(dbg.svgInfo(svg));
  assert.equal(left(mk('<text x="54" y="20" font-size="12">Title</text>')), 54, 'start text');
  assert.ok(left(mk('<text x="80" y="20" font-size="12" text-anchor="end">abcdefghij</text>')) <= 80 - 12 * 0.65 * 10 + 0.01, 'end-anchored text reaches left by its width');
  assert.ok(left(mk('<text x="200" y="20" font-size="14" text-anchor="middle">图例标题</text>')) <= 200 - 28, 'middle text');
  assert.equal(left(mk('<path d="M100 10 L300 10 L300 50 Z" fill="#999"/><rect x="60" y="0" width="5" height="9" fill="#c00"/>')), 59.5, 'path and rect');
  assert.equal(left(mk('<g transform="translate(5 5)"><text x="54" y="20" font-size="12">x</text></g>')), null, 'transform: unknown');
  const t = dbg.trimmedSvgInfo(mk('<text x="54" y="20" font-size="12">Title</text><rect x="50" y="30" width="900" height="40" fill="#999"/>'));
  assert.equal(t.minX, 49, 'viewBox starts at the ink');
  assert.equal(t.width, 991);
  console.log('PASS chart ink-left scan');
}
// 3. Composed page: every embedded chart's ink-left sits on the text column left edge (within 2 px).
{
  const out = compose([chart, text('t1', LONG), text('t2', LONG)]);
  const svg = out.desktop.svg;
  const m = svg.match(/<svg data-role="infographic-visual"[^>]* x="([\d.]+)"[^>]* viewBox="([\d.-]+) [\d.-]+ ([\d.]+) [\d.-]+" preserveAspectRatio="(\w+) meet"/);
  assert.ok(m, 'embedded chart found');
  const vis = box(out, 'bar'), txt = box(out, 't1');
  assert.equal(m[4], 'xMinYMin', 'chart is left-aligned in its box');
  const bundleAsset = assets['visualizations/bar.json'].desktopSvg;
  const raw = dbg.svgInkLeft(dbg.svgInfo(bundleAsset));
  const inkX = Number(m[1]) + (raw - Number(m[2])) * (vis.w / Number(m[3]));
  assert.ok(Math.abs(inkX - txt.x) <= 2, `chart ink-left ${inkX} vs text left ${txt.x}`);
  console.log('PASS chart ink-left == text left (offset', (inkX - txt.x).toFixed(2), 'px)');
}
// 4. Page QA checks text at the real nested scale and contrast 4.5.
{
  const mkp = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 600" width="1440" height="600"><rect width="1440" height="600" fill="#fff"/>${inner}</svg>`;
  const rules = (svg) => { const r = runRenderQa({ desktop: svg }).viewports.desktop; return [...r.geometry.failures, ...r.contrast.failures].map((x) => x.rule); };
  assert.ok(rules(mkp('<text x="20" y="40" font-size="11" fill="#1a1a1a">small</text>')).includes('font_below_floor'));
  assert.ok(rules(mkp('<svg x="20" y="60" width="400" height="200" viewBox="0 0 800 400"><text x="10" y="50" font-size="14" fill="#1a1a1a">nested</text></svg>')).includes('font_below_floor'), 'nested 14 px at 0.5x is 7 px');
  assert.ok(rules(mkp('<text x="20" y="40" font-size="13" fill="#999999">grey</text>')).includes('text_contrast'));
  assert.deepEqual(rules(mkp('<text x="20" y="40" font-size="13" fill="#666666">ok</text>')), []);
  console.log('PASS page QA: floor 12 px at real scale, contrast 4.5');
}
