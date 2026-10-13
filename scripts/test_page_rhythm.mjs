// Page rhythm: a short text never fills a whole row alone, rail/band spacing follows
// content, repeated numbers are counted. Synthetic data only; every page also
// passes page lint and page render QA.
import assert from 'node:assert/strict';
import { CLEAN_HERO_CHECKS } from './lib_hero_checks.mjs';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// NEWSROOM_PAGE_POLISH=1: a short note keeps the whole column (no readable-measure cap) and a number is never paired 4/8 with it.
const POLISH = process.env.NEWSROOM_PAGE_POLISH === '1';
const SHORT_W = POLISH ? 1248 : 750;
import { repeatedNumberCounts, shadowInfographicNumbers } from '../runtime/pi/shadow.mjs';
import { runInTool } from '../runtime/pi/groups.mjs';
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
const ONE = 'A single short synthetic sentence.';
const TWO = Array.from({ length: 2 }, () => 'A synthetic sentence that fills about half of a very wide line of text on the page.').join(' ');

// Short text alone on a full row: narrowed to the readable measure (1 and 2 lines); a long text keeps the row.
for (const [name, body, narrow] of [['one line', ONE, true], ['two lines', TWO, true], ['long', LONG, false]]) {
  const out = compose([chart, header('h2'), text('t1', body)]);
  assert.equal(box(out, 't1').w, narrow ? SHORT_W : 1248, name);
}
// A short text before a big number pairs with it: text 8 columns, number 4.
{
  const out = compose([chart, text('t1', ONE), stat('s1')]);
  if (POLISH) {
    assert.equal(box(out, 't1').w, 1248, 'polish: the note keeps the column');
    assert.equal(box(out, 's1').w, 1248, 'polish: the number is a full-width bar');
    assert.ok(box(out, 't1').y < box(out, 's1').y, 'polish: reading order is kept, one row each');
  } else {
    assert.ok(Math.abs(box(out, 't1').w - (8 * 78.33 + 7 * 28)) < 2, 'text takes 8 columns');
    assert.ok(Math.abs(box(out, 's1').w - (4 * 78.33 + 3 * 28)) < 2, 'stat takes 4 columns');
    assert.equal(box(out, 't1').y, box(out, 's1').y, 'same row');
    assert.ok(box(out, 't1').x < box(out, 's1').x, 'reading order is kept');
  }
}
// ... but not when the number's detail would be cut at the paired width: text is narrowed, the number is a band.
{
  const detail = '截至2017年12月31日，不含中国；奥地利、刚果（布）、尼日尔、俄罗斯无日期，另含若干说明文字，用来保证在窄栏里超过两行而在整宽下仍不超过两行，末尾标记为终点标记';
  const out = compose([chart, text('t1', ONE), stat('s1', { detail })]);
  assert.equal(box(out, 't1').w, SHORT_W);
  assert.equal(box(out, 's1').w, 1248);
  assert.ok(out.desktop.svg.includes('终点标记'));
}
// No neighbour to pair with (a section header follows): narrowed, no pairing.
{
  const out = compose([chart, text('t1', ONE), header('h2'), text('t2', LONG)]);
  assert.equal(box(out, 't1').w, SHORT_W);
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
  assert.equal(box(out, 't1').w, SHORT_W, 'a lone short text in a rail is narrowed');
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
    assert.equal(a.mobile.svg, b.mobile.svg, 'mobile page is byte-identical'); // also with NEWSROOM_PAGE_POLISH=1: the phone page is untouched
  }
}

// Shadow observation: a number used more than twice in the page's own text is counted, never changed or blocked.
{
  const found = repeatedNumberCounts([['dek', '其中24个在2017年'], ['stat', '其中24个在2017年'], ['body', '新增24个'], ['x', '63.2亿美元'], ['y', '63.2 亿美元']]);
  assert.deepEqual(found.map((e) => [e.value, e.count]), [['24', 3]], 'years are not counted; three mentions are reported');
  assert.deepEqual(found[0].by_unit, { '个': 3 });
  assert.deepEqual(repeatedNumberCounts([['a', '63.2亿美元'], ['b', '63.2 亿美元']]), [], 'twice is allowed');
  // dates: followed by year/month/day, or a bare 4-digit year-like integer; a number with a thousands comma is not a year
  assert.deepEqual(repeatedNumberCounts([['a', '2017 2017 2017 5月 5月 5月 12日 12日 12日']]), []);
  assert.equal(repeatedNumberCounts([['a', '2,017人 2,017人 2,017人']]).length, 1);
  assert.equal(repeatedNumberCounts([['a', '3000 3000 3000']]).length, 1, 'outside 1800-2100 is a number');
  const svg = `<svg>${'<text>24</text>'.repeat(5)}</svg>`;
  const spec = { ...page([chart, stat('s1', { value: '24', unit: '个', detail: '其中24个在2017年' }), text('t1', '2017年新增24个，占全部。')]), dek: '其中24个在2017年' };
  const root = mkdtempSync(join(tmpdir(), 'rep-'));
  try {
    const result = await runInTool('newsroom_infographic_lint', () => shadowInfographicNumbers({ root, spec, planRef: 'p', assets: { 'visualizations/bar.json': { desktopSvg: svg, manifest: {} } }, claimRecords: new Map(), deps: {} }));
    assert.equal(result.counts.repeated_numbers, 1);
    const record = JSON.parse(readFileSync(join(root, result.path), 'utf8'));
    const entry = record.repeated_numbers.find((e) => e.value === '24');
    assert.equal(entry.count, 4, 'dek + stat value + stat detail + body; the five chart labels are not counted');
    assert.ok(!entry.fields.some((f) => f.startsWith('visual:')));
    assert.deepEqual(Object.keys(result).sort(), ['counts', 'path']);
  } finally { rmSync(root, { recursive: true, force: true }); }
  // one mention each in the dek, a stat and the body: exactly 3 -> reported
  const three = { ...page([stat('s1', { value: '7', unit: '个', detail: 'x' }), text('t1', '共7个。')]), dek: '有7个。' };
  const r2 = mkdtempSync(join(tmpdir(), 'rep-'));
  try {
    const result = await runInTool('newsroom_infographic_lint', () => shadowInfographicNumbers({ root: r2, spec: three, planRef: 'p', assets: {}, claimRecords: new Map(), deps: {} }));
    const rec = JSON.parse(readFileSync(join(r2, result.path), 'utf8'));
    assert.deepEqual(rec.repeated_numbers.map((e) => [e.value, e.count]), [['7', 3]]);
  } finally { rmSync(r2, { recursive: true, force: true }); }
}

// Vertical spacing between modules: three classes measured ink to ink (layout's own ink model).
//   a: section heading -> first module, b: module -> module in a section, c: last module -> next heading / footer.
import { _rhythmDebug } from '../runtime/pi/infographic.mjs';
const plainSceneSpec = (sidecars, modules) => ({ ...page([header('h1'), chart, ...modules]), schema_version: '1.3.0', intent: 'Check page rhythm in a scene.', primary_message: 'A scene keeps its own layout.', story_arc: 'explain', audience: 'informed', quality_target: 'publishable',
  editorial_discovery_ref: 'editorial/discovery/test.json', visual_concept_ref: 'editorial/concepts/test.json', selected_concept_id: 'concept-scene', novelty_ref: 'editorial/novelty/test.json', asset_plan_ref: 'editorial/assets/test.json',
  scene_graph: { schema_version: '0.1.0', scenes: [{ id: 'sc', pattern: 'hero_with_rail', title: 'A scene title', dek: 'A scene deck that explains the scene in one line.', anchor_module_id: 'bar', sidecar_module_ids: sidecars, shared_source_scope: true }] } });
const TIERS = { a: 28, b: 28, c: 44 };
function gapClasses(out) {
  const units = [...out.desktop.rhythm, { kind: 'footer', section_start: true, ink_top: out.desktop.footer_y, ink_bottom: out.desktop.footer_y }];
  return units.slice(0, -1).map((u, i) => {
    const n = units[i + 1];
    return { cls: u.kind === 'heading' ? 'a' : n.section_start ? 'c' : 'b', gap: n.ink_top - u.ink_bottom };
  });
}
function checkTiers(name, out) {
  const gaps = gapClasses(out);
  assert.ok(gaps.length >= 2, name);
  for (const { cls, gap } of gaps) assert.ok(Math.abs(gap - TIERS[cls]) <= 4, `${name}: class ${cls} gap ${gap} should be ${TIERS[cls]} +-4`);
  assert.ok(gaps.some((g) => g.cls === 'c'), `${name}: has a section-to-section or footer gap`);
}
{
  checkTiers('flat mix', compose([header('h1'), chart, stat('s1'), text('t1', ONE), header('h2'), text('t2', LONG), text('t3', TWO), stat('s2', { value: '9' })]));
  checkTiers('flat stats', compose([chart, stat('s1'), stat('s2', { value: '8' }), stat('s3', { value: '7' }), header('h2'), text('t1', ONE), text('t2', TWO)]));
  const scenes = [['one stat', ['s1'], [stat('s1')]], ['one text', ['t1'], [text('t1', TWO)]], ['three stats', ['s1', 's2', 's3'], [stat('s1'), stat('s2', { value: '20' }), stat('s3', { value: '9' })]], ['stat + text', ['s1', 't1'], [stat('s1'), text('t1', LONG)]]];
  for (const [name, sidecars, modules] of scenes) {
    const spec = plainSceneSpec(sidecars, modules);
    assert.equal(lintInfographicSpec(spec, assets, context).passed, true, name);
    const out = composeInfographicBundle(spec, assets, { mobilePages: false });
    assert.equal(runRenderQa({ desktop: out.desktop.svg }).passed, true, name);
    checkTiers(`scene ${name}`, out);
  }
}
// Charts are trimmed of blank bottom padding only when their ink is known for certain.
{
  const bare = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><rect width="100" height="200" fill="#fff"/><text x="1" y="60" font-size="10">x</text></svg>';
  const trimmed = _rhythmDebug.trimmedSvgInfo(bare);
  assert.ok(trimmed.height < 200 && trimmed.height >= 60, `blank bottom is trimmed, got ${trimmed.height}`);
  for (const unsafe of ['<g transform="translate(0,50)"><text x="1" y="60">x</text></g>', '<image href="data:image/png;base64,AAAA" x="0" y="0" width="10" height="190"/>', '<use href="#a" y="150"/>', '<text x="1" y="60"><tspan y="150">x</tspan></text>']) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">${unsafe}</svg>`;
    assert.equal(_rhythmDebug.trimmedSvgInfo(svg).height, 200, `not trimmed: ${unsafe.slice(0, 30)}`);
  }
}
// The mobile page does not change with desktop spacing.
{
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, rmSync: rm } = await import('node:fs');
  const parentPath = new URL('../runtime/pi/_parent_rhythm.mjs', import.meta.url);
  let parent = null;
  try {
    const src = execFileSync('git', ['show', 'a4d4cb0:runtime/pi/infographic.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    writeFileSync(parentPath, src);
    try { parent = await import(parentPath.href); } finally { rm(parentPath); }
  } catch { parent = null; }
  if (parent) {
    for (const modules of [[header('h1'), chart, stat('s1'), text('t1', ONE), header('h2'), text('t2', LONG)], [chart, stat('s1'), stat('s2', { value: '8' }), text('t1', TWO)]]) {
      const spec = page(modules);
      assert.equal(composeInfographicBundle(spec, assets, { mobilePages: true }).mobile.svg, parent.composeInfographicBundle(spec, assets, { mobilePages: true }).mobile.svg, 'mobile is byte-identical');
    }
    const sc = plainSceneSpec(['s1'], [stat('s1')]);
    assert.equal(composeInfographicBundle(sc, assets, { mobilePages: true }).mobile.svg, parent.composeInfographicBundle(sc, assets, { mobilePages: true }).mobile.svg, 'mobile scene is byte-identical');
  }
}
console.log('page rhythm: PASS');
