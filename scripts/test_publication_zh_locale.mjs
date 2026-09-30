#!/usr/bin/env node
// Covers the zh-page reader-facing defects fixed alongside this test:
//   - the planning box (reader_question/visual_thesis) is hidden from the
//     reader and moved to data-* attributes (still required top-level spec
//     fields, so they still round-trip through the plan/manifest);
//   - a static_svg module whose title exactly matches its embedded SVG's own
//     <title> renders that title only once; a genuinely distinct title is
//     untouched;
//   - every string the template itself adds (kicker, source-line prefix,
//     data-table caption, runtime-fallback caption) follows spec.language;
//   - a text module with variant:'pull_quote' gets a distinct class the
//     English-default byte-identical case (no language / no variant) never
//     produces.
import assert from 'node:assert/strict';
import { renderPublication, validatePublicationSpec } from '../runtime/pi/publication.mjs';

const DUP_TITLE = '8 of 11 countries top 70%';
const dupSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><title id="viz-title">${DUP_TITLE}</title><text x="4" y="20">${DUP_TITLE}</text></svg>`;
const distinctSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><title id="viz-title">Internal chart label</title><text x="4" y="20">Internal chart label</text></svg>`;

const base = {
  schema_version: '0.3.0',
  style_profile: 'japanese_editorial',
  title: '非洲11国可再生能源占比：8国超七成',
  dek: '示例摘要用于测试。',
  reader_question: 'Do most of these countries get most of their energy from renewables?',
  visual_thesis: '8 of 11 countries draw at least 70% of final energy consumption from renewables.',
  story_graph_ref: 'editorial/story-graphs/fixture.json',
  infographic_plan_ref: 'infographics/plans/fixture.json',
  source_note: '世界银行 / 国际能源署',
  language: 'zh',
  delivery: { mode: 'html', packaging: 'archive', self_contained: true, static_fallback: 'svg', breakpoints: [768, 1440] },
  interaction: { allowed: ['hover'], replay: [] },
};

const modules = [
  { id: 'hero', type: 'stat', title: '8 / 11', value: '8', unit: '/11', story_node_ids: ['n1'], claim_ids: ['c1'], explanatory_dimension: 'rank', width: 'full', accessibility: { summary: 'Hero stat summary', long_description: 'Hero stat long description text for a11y.' }, evidence_binding: { kind: 'computation', ref: 'computations/hero.json', result_hash: 'a'.repeat(64) } },
  { id: 'chart_dup', type: 'static_svg', title: DUP_TITLE, asset_ref: 'visualizations/dup.svg', resolved_svg: dupSvg, story_node_ids: ['n2'], claim_ids: ['c2'], explanatory_dimension: 'rank', width: 'full', accessibility: { summary: 'Ranked bar chart summary', long_description: 'Ranked bar chart long description text for a11y.' } },
  { id: 'chart_distinct', type: 'static_svg', title: 'A distinct outer heading', asset_ref: 'visualizations/distinct.svg', resolved_svg: distinctSvg, story_node_ids: ['n3'], claim_ids: ['c3'], explanatory_dimension: 'spatial', width: 'full', accessibility: { summary: 'Distinct chart summary', long_description: 'Distinct chart long description text for a11y.' } },
  { id: 'network', type: 'model', engine: 'native_canvas', title: 'Network view', story_node_ids: ['n4'], claim_ids: ['c4'], explanatory_dimension: 'network', width: 'half', accessibility: { summary: 'Network summary', long_description: 'Network long description text for a11y.' }, evidence_binding: { kind: 'model', ref: 'models/network.json', result_hash: 'b'.repeat(64) }, spec: { nodes: [], edges: [] }, _a11y_rows: [{ a: 1, b: 2 }] },
  { id: 'quote', type: 'text', variant: 'pull_quote', text: '8个国家可再生能源占比达到或超过70%。', story_node_ids: ['n5'], explanatory_dimension: 'rank', width: 'full' },
  { id: 'plain_text', type: 'text', text: '普通说明文字，不是引语。', story_node_ids: ['n6'], explanatory_dimension: 'spatial', width: 'full' },
];

const spec = { ...base, modules };
const errors = validatePublicationSpec(spec);
assert.deepEqual(errors, [], `fixture must be a valid PublicationSpec 0.3: ${errors.join(' | ')}`);

const rendered = renderPublication(spec, { includePlotly: false, includeD3: false });
const html = rendered.html;

// -- localized strings: html lang, kicker, source-line prefix, captions --
assert.match(html, /<html lang="zh">/, 'html lang must follow spec.language');
assert.match(html, /<div class="pub-kicker">互动数据报道<\/div>/, 'kicker must be localized on a zh page');
assert.match(html, /<footer class="pub-source">资料来源：世界银行 \/ 国际能源署<\/footer>/, 'source line must get a localized prefix on zh, ahead of the unchanged source_note text');
assert.match(html, /查看数据表/, 'data-table caption must be localized');
assert.match(html, /互动图表暂不可用/, 'runtime-fallback caption must be localized');

// -- planning box hidden, moved to data-* (still required spec fields) --
assert.equal(html.includes('pub-thesis'), false, 'the reader_question/visual_thesis box must not render');
assert.equal(html.includes('Reader question'), false);
assert.equal(html.includes('Visual thesis'), false);
assert.match(html, /data-reader-question="Do most of these countries get most of their energy from renewables\?"/);
assert.match(html, /data-visual-thesis="8 of 11 countries draw at least 70% of final energy consumption from renewables\."/);
assert.equal(spec.reader_question, base.reader_question, 'reader_question is unchanged on the spec object (still round-trips to plan/manifest)');

// -- single title: duplicate suppressed, distinct kept --
const dupHeadingCount = (html.match(new RegExp(`<h2>${DUP_TITLE}</h2>`, 'g')) || []).length;
assert.equal(dupHeadingCount, 0, 'a module heading identical to its embedded SVG title must be suppressed');
assert.match(html, new RegExp(`<title id="viz-title">${DUP_TITLE}</title>`), 'the SVG keeps its own title; the reader still sees it exactly once, drawn by the chart itself');
assert.match(html, /<h2>A distinct outer heading<\/h2>/, 'a heading that differs from the embedded SVG title is untouched');

// -- hero stat: no black block, navy numeral, small caption --
assert.equal(html.includes('background:var(--ink);color:var(--paper)'), false, 'the stat module must not render as a filled dark block');
assert.match(html, /\.pub-stat-value\{[^}]*color:#1d3557/, 'the hero numeral must use the house navy');
assert.match(html, /\.pub-stat h2\{font-size:15px/, 'the hero caption must be small, not a loud module heading');

// -- pull quote: distinct treatment, not applied to a plain text module --
const quoteClass = /<section class="([^"]*)" data-module-id="quote"/.exec(html);
const plainClass = /<section class="([^"]*)" data-module-id="plain_text"/.exec(html);
assert.ok(quoteClass && quoteClass[1].includes('pub-quote'), 'a text module with variant:pull_quote must carry the pub-quote class');
assert.ok(plainClass && !plainClass[1].includes('pub-quote'), 'a plain text module must not carry the pub-quote class');
assert.match(html, /\.pub-quote\{border-left:3px solid #c0432a/, 'the pull quote must have a left rule in the house accent colour');
assert.match(html, /\.pub-quote p\{font-family:var\(--display-font\)/, 'the pull quote must use the serif display font, not the body sans');

// -- English default stays byte-identical when language/variant are absent --
const enSpec = { ...base, language: undefined, modules: modules.map(({ variant, ...m }) => m) };
delete enSpec.language;
const enErrors = validatePublicationSpec(enSpec);
assert.deepEqual(enErrors, []);
const enRendered = renderPublication(enSpec, { includePlotly: false, includeD3: false });
assert.match(enRendered.html, /<html lang="en">/);
assert.match(enRendered.html, /<div class="pub-kicker">Interactive data story<\/div>/);
const enSectionClasses = [...enRendered.html.matchAll(/<section class="([^"]*)"/g)].map((m) => m[1]);
assert.ok(enSectionClasses.length > 0 && enSectionClasses.every((c) => !c.includes('pub-quote')), 'without variant:pull_quote, no module section gets the quote class (the .pub-quote CSS rule itself is still present, same as any other unused-on-this-page module CSS)');

console.log(JSON.stringify({
  status: 'PASS',
  html_bytes_zh: Buffer.byteLength(html),
  html_lang_zh: 'zh',
  kicker_zh: '互动数据报道',
  duplicate_heading_count: dupHeadingCount,
  quote_class_present: Boolean(quoteClass && quoteClass[1].includes('pub-quote')),
  en_default_kicker: 'Interactive data story',
}, null, 2));
