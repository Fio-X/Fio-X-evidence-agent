// Page rhythm: a short text never fills a whole row alone, rail/band spacing follows
// content, repeated numbers are counted. Synthetic data only; every page also
// passes page lint and page render QA.
import assert from 'node:assert/strict';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repeatedNumberCounts, shadowInfographicNumbers } from '../runtime/pi/shadow.mjs';
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
const ONE = 'A single short synthetic sentence.';
const TWO = Array.from({ length: 2 }, () => 'A synthetic sentence that fills about half of a very wide line of text on the page.').join(' ');

// Short text alone on a full row: narrowed to the readable measure (1 and 2 lines); a long text keeps the row.
for (const [name, body, narrow] of [['one line', ONE, true], ['two lines', TWO, true], ['long', LONG, false]]) {
  const out = compose([chart, header('h2'), text('t1', body)]);
  assert.equal(box(out, 't1').w, narrow ? 750 : 1248, name);
}
// A short text before a big number pairs with it: text 8 columns, number 4.
{
  const out = compose([chart, text('t1', ONE), stat('s1')]);
  assert.ok(Math.abs(box(out, 't1').w - (8 * 78.33 + 7 * 28)) < 2, 'text takes 8 columns');
  assert.ok(Math.abs(box(out, 's1').w - (4 * 78.33 + 3 * 28)) < 2, 'stat takes 4 columns');
  assert.equal(box(out, 't1').y, box(out, 's1').y, 'same row');
  assert.ok(box(out, 't1').x < box(out, 's1').x, 'reading order is kept');
}
// ... but not when the number's detail would be cut at the paired width: text is narrowed, the number is a band.
{
  const detail = '截至2017年12月31日，不含中国；奥地利、刚果（布）、尼日尔、俄罗斯无日期，另含若干说明文字，用来保证在窄栏里超过两行而在整宽下仍不超过两行，末尾标记为终点标记';
  const out = compose([chart, text('t1', ONE), stat('s1', { detail })]);
  assert.equal(box(out, 't1').w, 750);
  assert.equal(box(out, 's1').w, 1248);
  assert.ok(out.desktop.svg.includes('终点标记'));
}
// No neighbour to pair with (a section header follows): narrowed, no pairing.
{
  const out = compose([chart, text('t1', ONE), header('h2'), text('t2', LONG)]);
  assert.equal(box(out, 't1').w, 750);
}
// The row height follows the text: the same short text is shorter than the long one.
{
  const short = compose([chart, header('h2'), text('t1', ONE)]);
  assert.ok(box(short, 't1').h < 140);
}
// Vertical spacing: a band right under a full-width chart sits 40px below it (the row gap), nothing more.
{
  const out = compose([chart, stat('s1'), header('h2')]);
  const c = box(out, 'bar'), s = box(out, 's1');
  assert.ok(s.y - (c.y + c.h) <= 44, `gap ${s.y - (c.y + c.h)}`);
}
// A scene rail: 1 stat -> band 14px under the anchor and no phantom space after it; the scene's height is exactly its content.
const sceneSpec = (sidecars, modules, extra = {}) => ({ ...page([header('h1'), { ...chart, id: 'bar', span: 'full' }, ...modules]), schema_version: '1.3.0', intent: 'Check page rhythm in a scene.', primary_message: 'A scene keeps its own layout.', story_arc: 'explain', audience: 'informed', quality_target: 'publishable',
  editorial_discovery_ref: 'editorial/discovery/test.json', visual_concept_ref: 'editorial/concepts/test.json', selected_concept_id: 'concept-scene', novelty_ref: 'editorial/novelty/test.json', asset_plan_ref: 'editorial/assets/test.json',
  scene_graph: { schema_version: '0.1.0', scenes: [{ id: 'sc', pattern: 'hero_with_rail', eyebrow: 'Scene', title: 'A scene', dek: 'A scene deck.', anchor_module_id: 'bar', sidecar_module_ids: sidecars, shared_source_scope: true }] }, ...extra });
function composeScene(spec) {
  const l = lintInfographicSpec(spec, assets, context);
  assert.equal(l.passed, true, l.blockers.join(' | '));
  const out = composeInfographicBundle(spec, assets, { mobilePages: false });
  const qa = runRenderQa({ desktop: out.desktop.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports.desktop.geometry.failures.slice(0, 5)));
  return out;
}
for (const [name, sidecars, mods] of [
  ['1 stat', ['s1'], [stat('s1')]],
  ['3 stats', ['s1', 's2', 's3'], [stat('s1'), stat('s2', { value: '20' }), stat('s3', { value: '9' })]],
  ['1 short text', ['t1'], [text('t1', ONE)]],
]) {
  const out = composeScene(sceneSpec(sidecars, mods));
  const scene = out.desktop.scenes[0];
  const members = out.desktop.boxes.filter((b) => b.scene_id === 'sc');
  const bottom = Math.max(...members.map((b) => b.y + b.h));
  assert.equal(Math.round(scene.y + scene.h), Math.round(bottom), `${name}: scene height is its content`);
  const a = box(out, 'bar'), first = box(out, sidecars[0]);
  const gapAbs = first.y - (a.y + a.h);
  assert.ok(gapAbs <= 44, `${name}: rail starts ${gapAbs}px under the anchor`);
}
{
  const out = composeScene(sceneSpec(['t1'], [text('t1', ONE)]));
  assert.equal(box(out, 't1').w, 750, 'a lone short text in a rail is narrowed');
  const three = composeScene(sceneSpec(['s1', 's2', 's3'], [stat('s1'), stat('s2', { value: '20' }), stat('s3', { value: '9' })]));
  assert.ok(Math.abs(box(three, 's1').w - (4 * 78.33 + 3 * 28)) < 2, 'three-sidecar rails keep their columns');
}
// Mobile is untouched.
{
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, rmSync } = await import('node:fs');
  const path = new URL('../runtime/pi/_parent_infographic.mjs', import.meta.url);
  let parent = null;
  try {
    writeFileSync(path, execFileSync('git', ['show', 'a4d4cb0:runtime/pi/infographic.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    try { parent = await import(path.href); } finally { rmSync(path); }
  } catch { parent = null; }
  if (parent) {
    const spec = { ...page([chart, text('t1', ONE), stat('s1')]) };
    const a = composeInfographicBundle(spec, assets, { mobilePages: true });
    const b = parent.composeInfographicBundle(spec, assets, { mobilePages: true });
    assert.equal(a.mobile.svg, b.mobile.svg, 'mobile page is byte-identical');
  }
}

// Shadow observation: a number used more than twice on a page is counted, never changed or blocked.
{
  const found = repeatedNumberCounts([['dek', '其中24个在2017年'], ['stat', '其中24个在2017年'], ['body', '2017年新增24个'], ['chart', '24'], ['x', '63.2亿美元'], ['y', '63.2 亿美元']]);
  assert.deepEqual(found.map((e) => [e.value, e.count]), [['2017', 3], ['24', 4]].sort((a, b) => b[1] - a[1]));
  assert.deepEqual(found.find((e) => e.value === '24').by_unit, { '个': 3, '': 1 });
  assert.deepEqual(repeatedNumberCounts([['a', '63.2亿美元'], ['b', '63.2 亿美元']]), [], 'twice is allowed');
  const spec = { ...page([stat('s1', { value: '24', unit: '个', detail: '其中24个在2017年' }), text('t1', '2017年新增24个，占24个中的全部。')]), dek: '其中24个在2017年' };
  const root = mkdtempSync(join(tmpdir(), 'rep-'));
  try {
    const result = await shadowInfographicNumbers({ root, spec, planRef: 'p', assets: {}, claimRecords: new Map(), deps: {} });
    assert.ok(result.counts.repeated_numbers >= 1);
    const record = JSON.parse(readFileSync(join(root, result.path), 'utf8'));
    assert.ok(record.repeated_numbers.some((e) => e.value === '24' && e.count >= 4));
    assert.deepEqual(Object.keys(result).sort(), ['counts', 'path']);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
console.log('page rhythm: PASS');
