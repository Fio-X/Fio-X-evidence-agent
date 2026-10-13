#!/usr/bin/env node
// K318: NEWSROOM_TITLE_ONE=1 (exact "1", default off): a chart under a section heading keeps its own drawn title and the SECTION HEADING is dropped only when the two are equal after
// removing whitespace, punctuation, symbols and case; a near match keeps both; neither text is rewritten; with the switch on K267 no longer cuts the chart title. Off is byte-identical.
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
const chart = { id: 'bar', type: 'visual', span: 'full', label: 'The ranking', manifest_ref: 'visualizations/bar.json' };
const text = (id, body, extra = {}) => ({ id, type: 'text', span: 'full', label: 'Context', heading: 'A short note', body, claim_ids: [claim], ...extra });
const SHORT = 'A short synthetic paragraph that explains the number above in one or two lines.';
const page = (modules) => ({ schema_version: '1.0.0', kicker: 'SYNTHETIC', title: 'Stat row layout regression page', dek: 'A synthetic page used to check where a lone big number is placed on the desktop page.', alt: 'A synthetic page with a chart, a big number and text.', byline: 'Newsroom Agent', date_label: 'Regression', layout: 'feature', complexity_budget: 'medium', source_note: 'Synthetic fixture', modules });
const KEYS = ['NEWSROOM_TITLE_ONE', 'NEWSROOM_PAGE_POLISH'];
const withEnv = (env, fn) => { const old = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); try { return fn(); } finally { for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const headerOf = (heading) => ({ id: 'h1', type: 'section_header', span: 'full', eyebrow: 'Part', heading, deck: 'A short deck for the section.' });
const compose = (heading) => {
  const spec = page([headerOf(heading), chart, { id: 'h2', type: 'section_header', span: 'full', eyebrow: 'Part', heading: 'Another section starts here', deck: 'Another deck.' }, text('t2', SHORT)]);
  assert.equal(lintInfographicSpec(spec, assets, context).passed, true);
  const out = composeInfographicBundle(spec, assets, { mobilePages: false });
  const qa = runRenderQa({ desktop: out.desktop.svg });
  return { svg: out.desktop.svg, height: out.desktop.height, qa: qa.passed };
};
const count = (svg, s) => svg.split(`>${s}</text>`).length - 1;
const TITLE = 'A leads this selected comparison';
const SAME = 'A leads this selected comparison.';
const NEAR = 'A leads this chosen comparison';
const OTHER = 'Where the money goes';
const OFF = ['0', 'true', ' 1', '1 ', 'yes'];
for (const polish of [{}, { NEWSROOM_PAGE_POLISH: '1' }]) {
  for (const heading of [SAME, NEAR, OTHER]) {
    const off = withEnv(polish, () => compose(heading));
    for (const v of OFF) assert.equal(withEnv({ ...polish, NEWSROOM_TITLE_ONE: v }, () => compose(heading)).svg, off.svg, `${heading}: ${JSON.stringify(v)} is byte-identical to off`);
    const on = withEnv({ ...polish, NEWSROOM_TITLE_ONE: '1' }, () => compose(heading));
    assert.equal(on.qa, true, `${heading}: render QA passes`);
    assert.equal(count(on.svg, TITLE), 1, `${heading}: the chart title is drawn once with the switch on`);
    if (heading === SAME) {
      assert.equal(count(on.svg, SAME), 0, 'an equal heading is dropped');
      console.log('heights', off.height, on.height); if (!polish.NEWSROOM_PAGE_POLISH) assert.ok(on.height < off.height, 'the page gets shorter by the dropped heading');
      assert.ok(on.svg.includes('A SHORT DECK') || on.svg.includes('A short deck for the section.'), 'the deck stays');
    } else {
      assert.equal(count(on.svg, heading), 1, `${heading}: a different or near heading is kept`);
    }
    if (!polish.NEWSROOM_PAGE_POLISH && heading !== SAME) assert.equal(on.svg, off.svg, `${heading}: no equal title, no change`);
  }
}
console.log('k318 title one PASS');
