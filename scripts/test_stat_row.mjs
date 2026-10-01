#!/usr/bin/env node
// E2: a big number that would sit alone on a desktop row either pairs with a
// short text module (4/8 columns) or is drawn as a full-width bar. Synthetic
// data only; every page also passes page lint and page render QA.
import assert from 'node:assert/strict';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

const claim = 'claim-stat-row';
const context = { verified_claim_ids: [claim], mobile_pages: false };
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
const statBox = (svg, id) => {
  const m = svg.match(new RegExp(`<rect data-role="hero-stat" data-module-id="${id}" x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="(\\d+)"`));
  assert.ok(m, `stat ${id} not drawn`);
  return { x: +m[1], y: +m[2], w: +m[3] };
};
const textX = (svg, needle) => +svg.match(new RegExp(`<text x="([\\d.]+)"[^>]*>[^<]*${needle}`))[1];

// (a) after a full-width chart, followed by a section header -> full-row bar
{
  const out = compose([chart, stat('s1'), header('h2'), text('t2', SHORT)]);
  const box = statBox(out.desktop.svg, 's1');
  assert.equal(box.w, 1248, 'bar spans the full content width');
  assert.ok(textX(out.desktop.svg, 'Synthetic items counted') > 96 + 120, 'label sits right of the numeral');
  const flat = compose([chart, header('h2'), text('t2', SHORT)]);
  assert.ok(out.desktop.height - flat.desktop.height < 200, 'bar is a reduced-height row');
}
// (b) followed by a short text -> side by side, 1/3 + 2/3, order unchanged
{
  const out = compose([chart, stat('s1'), text('t1', SHORT)]);
  const box = statBox(out.desktop.svg, 's1');
  assert.ok(Math.abs(box.w - (4 * 78.33 + 3 * 28)) < 2, `stat is 4 columns, got ${box.w}`);
  const tx = textX(out.desktop.svg, 'A short note');
  assert.ok(tx > box.x + box.w, 'text sits to the right of the stat');
  assert.ok(out.desktop.svg.indexOf('data-module-id="s1"') < out.desktop.svg.indexOf('A short note'));
}
// (b2) text already 2/3 beside the stat: the existing pairing is untouched
{
  const out = compose([chart, stat('s1'), text('t1', LONG, { span: 'two_thirds' })]);
  assert.ok(statBox(out.desktop.svg, 's1').w < 500);
}
// (l) a detail that fits 2 lines at 12 columns but not at 4 draws the band, in full
{
  const detail = '截至2017年12月31日，不含中国；奥地利、刚果（布）、尼日尔、俄罗斯无日期，另含若干说明文字，用来保证在窄栏里超过两行而在整宽下仍不超过两行，末尾标记为终点标记';
  const out = compose([chart, stat('s1', { detail }), text('t1', SHORT)]);
  assert.equal(statBox(out.desktop.svg, 's1').w, 1248, 'long detail: band, not a 4-column pair');
  assert.ok(out.desktop.svg.includes('终点标记'), 'detail text is not cut');
  assert.ok(!/…/.test(out.desktop.svg.slice(out.desktop.svg.indexOf('data-module-id="s1"'))), 'no ellipsis in the band');
}
// (c) followed by a long (>4 lines) text -> bar, not paired
{
  const out = compose([chart, stat('s1'), text('t1', LONG)]);
  assert.equal(statBox(out.desktop.svg, 's1').w, 1248);
}
// (d) two stats already share a row -> unchanged (both stay third width)
{
  const out = compose([chart, stat('s1'), stat('s2', { value: '20', label: 'Another synthetic count' })]);
  assert.ok(statBox(out.desktop.svg, 's1').w < 500);
  assert.ok(statBox(out.desktop.svg, 's2').w < 500);
}
// Scene helper: a 1.3.0 page with a hero_with_rail scene over the full-width chart.
const scenePage = (sidecars, modules, pattern = 'hero_with_rail') => ({ ...page([header('h1'), { ...chart, id: 'bar', span: 'full' }, ...modules]), schema_version: '1.3.0', intent: 'Check where a lone big number sits inside a scene.', primary_message: 'A scene keeps its own layout.', story_arc: 'explain', audience: 'informed', quality_target: 'publishable',
  editorial_discovery_ref: 'editorial/discovery/test.json', visual_concept_ref: 'editorial/concepts/test.json', selected_concept_id: 'concept-scene', novelty_ref: 'editorial/novelty/test.json', asset_plan_ref: 'editorial/assets/test.json',
  scene_graph: { schema_version: '0.1.0', scenes: [{ id: 'sc', pattern, eyebrow: 'Scene', title: 'A scene', dek: 'A scene deck.', anchor_module_id: 'bar', sidecar_module_ids: sidecars, shared_source_scope: true }] } });
function composeScene(spec, mobilePages = false) {
  const l = lintInfographicSpec(spec, assets, { ...context, mobile_pages: mobilePages });
  assert.equal(l.passed, true, l.blockers.join(' | '));
  const out = composeInfographicBundle(spec, assets, { mobilePages });
  const qa = runRenderQa({ desktop: out.desktop.svg });
  assert.equal(qa.passed, true, JSON.stringify(Object.values(qa.viewports).flatMap((v) => v.geometry.failures).slice(0, 5)));
  return out;
}
// The previous layout (commit before the scene band), for byte-identity checks.
const parentPath = new URL('../runtime/pi/_parent_infographic.mjs', import.meta.url);
let parent = null;
try {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, rmSync } = await import('node:fs');
  const src = execFileSync('git', ['show', '0f2dbd7:runtime/pi/infographic.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  writeFileSync(parentPath, src);
  try { parent = await import(parentPath.href); } finally { rmSync(parentPath); }
} catch { parent = null; }
const sameAsParent = (spec, mobilePages = false) => {
  if (!parent) return;
  const now = composeInfographicBundle(spec, assets, { mobilePages });
  const before = parent.composeInfographicBundle(spec, assets, { mobilePages });
  assert.equal(now.desktop.svg, before.desktop.svg, 'desktop is byte-identical to the previous layout');
  if (mobilePages) assert.equal(now.mobile.svg, before.mobile.svg, 'mobile is byte-identical to the previous layout');
};

// (e)/(g) a rail holding ONE big number draws the full-width band
{
  const spec = scenePage(['s1'], [stat('s1', { span: 'third' })]);
  const out = composeScene(spec);
  assert.equal(out.desktop.scenes.length, 1);
  const box = out.desktop.boxes.find((b) => b.id === 's1');
  assert.equal(box.scene_role, 'sidecar');
  assert.equal(box.stat_bar, true);
  assert.equal(box.w, 1248);
  assert.ok(box.h < 150, `band is shorter than the stacked stat, got ${box.h}`);
  const anchor = out.desktop.boxes.find((b) => b.id === 'bar');
  assert.equal(box.y, anchor.y + anchor.h + 14, 'rail spacing unchanged');
  assert.ok(textX(out.desktop.svg, 'Synthetic items counted') > 96 + 120, 'label sits right of the numeral');
}
// (h) a rail with two big numbers is unchanged
{
  const spec = scenePage(['s1', 's2'], [stat('s1'), stat('s2', { value: '20', label: 'Another synthetic count' })]);
  const out = composeScene(spec);
  assert.ok(!out.desktop.boxes.some((b) => b.stat_bar));
  sameAsParent(spec);
}
// (i) a rail with one text sidecar is unchanged
{
  const spec = scenePage(['t1'], [text('t1', SHORT)]);
  const out = composeScene(spec);
  assert.ok(!out.desktop.boxes.some((b) => b.stat_bar));
  sameAsParent(spec);
}
// (j) mobile is unchanged (also with the one-stat rail)
{
  const spec = scenePage(['s1'], [stat('s1', { span: 'third' })]);
  const out = composeScene(spec, true);
  assert.ok(!out.mobile.boxes.some((b) => b.stat_bar));
  if (parent) assert.equal(out.mobile.svg, parent.composeInfographicBundle(spec, assets, { mobilePages: true }).mobile.svg);
}
// hero_sidecar_stack is unchanged (a lone stat sidecar stays a 4-column card)
{
  const spec = scenePage(['s1'], [stat('s1', { span: 'third' })], 'hero_sidecar_stack');
  const l = lintInfographicSpec(spec, assets, context);
  if (l.passed) { assert.ok(!composeInfographicBundle(spec, assets, { mobilePages: false }).desktop.boxes.some((b) => b.stat_bar)); sameAsParent(spec); }
}
// (k) long label + long detail in the scene band wrap with no overflow, QA passes
{
  const spec = scenePage(['s1'], [stat('s1', { span: 'third', label: LONG.slice(0, 160), detail: LONG })]);
  const out = composeScene(spec);
  const box = out.desktop.boxes.find((b) => b.id === 's1');
  assert.equal(box.stat_bar, true);
  assert.ok(/Sentence 14/.test(out.desktop.svg));
}
// (f) a very long description folds inside the bar; QA passes (font floor, bounds, overlap)
{
  const out = compose([chart, stat('s1', { detail: LONG }), header('h2'), text('t2', SHORT)]);
  assert.equal(statBox(out.desktop.svg, 's1').w, 1248);
  assert.ok(!/…/.test(out.desktop.svg.match(/<text[^>]*font-size="12"[^>]*>[^<]*Sentence 14[^<]*/)?.[0] ?? ''), 'detail is folded, not truncated');
  assert.ok(/Sentence 14/.test(out.desktop.svg));
}
console.log(`stat row layout: PASS (parent identity checks ${parent ? "ran" : "SKIPPED"})`);
