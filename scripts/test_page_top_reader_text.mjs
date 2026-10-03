#!/usr/bin/env node
// The first module of a page, the words readers see, and the hero gate default. Offline, synthetic data only: no
// network, model or key.
//   A  page top      the first content module is a hero_stat, a chart or a real illustration; a decorative cover under the
//                    title is skipped; the lint only warns
//   B  reader text   process terms, field names, placeholder words and template braces block; broader review words warn;
//                    ordinary words pass; the fields read are exactly the documented ones
//   C  wording       an unsupported quantifier or a vague time in running copy warns (copy fields only)
//   D  hero gate     on unless NEWSROOM_HERO_VALUE_GATE=0, seen through the real tool definitions and the real lint tool
//   E  guidance      the new one-sentence guidance reaches the model
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { PAGE_TOP_GUIDANCE, checkReaderText, checkReaderWording, chartSvgText, lintInfographicSpec, pageTopWarning, readerTextEntries } from '../runtime/pi/infographic.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let n = 0;
const eq = (actual, expected, name) => { assert.deepEqual(actual, expected, name); n += 1; };
const yes = (cond, name) => { assert.ok(cond, name); n += 1; };

// ---- fixtures -----------------------------------------------------------------------------------------------------
const claim = 'claim-top';
const context = { verified_claim_ids: [claim] };
// a real chart asset, built the way test_infographic.mjs builds it
const barRows = [{ category: 'A', value: 42 }, { category: 'B', value: 31 }, { category: 'C', value: 18 }, { category: 'D', value: 9 }];
const barSpec = { schema_version: '0.9.0', reader_task: 'ranking', takeaway: 'A leads the selected categories.', chart_type: 'horizontal_bar', title: 'A leads this selected comparison', subtitle: 'Synthetic regression fixture', alt: 'Horizontal bars rank four synthetic categories from A at 42 to D at 9.', source_note: 'Synthetic fixture', claim_id: claim, sql: 'SELECT * FROM synthetic_bar', unit: 'units', category_field: 'category', value_field: 'value', sort: 'desc', highlight_values: ['A'], annotations: [] };
const barLint = lintVizSpec(barSpec, barRows, context);
assert.equal(barLint.passed, true, barLint.blockers.join(' | '));
const barBundle = renderVizBundle(barSpec, barRows);
const barCritic = critiqueViz(barSpec, barRows, barLint, barBundle.desktop);
assert.equal(barCritic.passed, true);
const coverSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect width="100" height="40" fill="#dfe7ee"/></svg>';
const illustration = (decorative, extra = {}) => ({ desktopSvg: coverSvg, mobileSvg: coverSvg, manifest: { kind: 'illustration', source_note: 'Synthetic illustration', metadata: decorative ? { decorative: true } : {}, ...extra }, critic: { passed: true, score: 90 } });
const assets = {
  'visualizations/bar.json': { desktopSvg: barBundle.desktop, mobileSvg: barBundle.mobile, manifest: { claim_id: claim, source_note: barSpec.source_note, chart_type: barSpec.chart_type, alt: barSpec.alt }, critic: { passed: true, score: barCritic.score } },
  'illustrations/cover.json': illustration(true),
  'illustrations/scene.json': illustration(false),
};
const M = {
  head: { id: 'head', type: 'section_header', span: 'full', eyebrow: 'The premise', heading: 'Numbers gain meaning from hierarchy', deck: 'The composer controls reading order.' },
  hero: { id: 'hero', type: 'hero_stat', span: 'third', value: '100', unit: 'PJ', label: 'Total energy entering the synthetic system', detail: 'Verified claim fixture', claim_id: claim },
  bar: { id: 'bar', type: 'visual', span: 'two_thirds', label: 'The ranking', manifest_ref: 'visualizations/bar.json' },
  text: { id: 'text', type: 'text', span: 'two_thirds', label: 'Why it matters', heading: 'One feature, several reading speeds', body: 'Numbers reward scanning, and charts support comparison.', claim_ids: [claim] },
  quote: { id: 'quote', type: 'pull_quote', span: 'full', text: 'A synthetic pull quote.' },
  cover: { id: 'cover', type: 'illustration', span: 'full', asset_ref: 'illustrations/cover.json', alt: 'A decorative synthetic page cover.', credit: 'Synthetic', claim_ids: [claim] },
  scene: { id: 'scene', type: 'illustration', span: 'full', asset_ref: 'illustrations/scene.json', alt: 'A synthetic explanatory illustration.', credit: 'Synthetic', claim_ids: [claim] },
};
const base = { schema_version: '1.0.0', kicker: 'SYNTHETIC', title: 'A synthetic page shows where the first module goes', dek: 'A synthetic dek for the page-top check.', alt: 'A synthetic magazine page with a headline and a few modules.', layout: 'feature', source_note: 'Synthetic fixture' };
const page = (keys, extra = {}) => ({ ...base, ...extra, modules: keys.map((key) => (typeof key === 'string' ? M[key] : key)) });
const GUIDANCE = 'The first content module after the title and dek is a hero_stat bound with value_from when the story has one prominent verified number; otherwise it is the lead visual. Never open with a text module or a pull quote.';
const TOP = 'page_top_not_hero_or_lead_visual';
const topWarnings = (lint) => lint.warnings.filter((warning) => warning.startsWith(`${TOP}:`));

// ---- A. page top --------------------------------------------------------------------------------------------------
eq(PAGE_TOP_GUIDANCE, GUIDANCE, 'the exported guidance is the work order sentence, word for word');
const fine = {
  'hero, chart, text': ['hero', 'bar', 'text'],
  'chart, hero, text': ['bar', 'hero', 'text'],
  'real illustration, text, chart': ['scene', 'text', 'bar'],
  'header, hero, text': ['head', 'hero', 'text'],
  'decorative cover, hero, text': ['cover', 'hero', 'text'],
  'decorative cover, chart, text': ['cover', 'bar', 'text'],
  'header, decorative cover, hero, text': ['head', 'cover', 'hero', 'text'],
  'header, decorative cover, chart, text': ['head', 'cover', 'bar', 'text'],
};
for (const [name, keys] of Object.entries(fine)) {
  const spec = page(keys);
  eq(pageTopWarning(spec, assets), null, `no page-top warning: ${name}`);
  const lint = lintInfographicSpec(spec, assets, context);
  eq(lint.blockers, [], `fixture page is clean: ${name}`);
  eq(topWarnings(lint), [], `no page-top warning in the lint: ${name}`);
}
const opening = {
  'text, hero, chart': [['text', 'hero', 'bar'], 'text', 'text'],
  'pull quote, chart, text': [['quote', 'bar', 'text'], 'quote', 'pull_quote'],
  'header, text, chart': [['head', 'text', 'bar'], 'text', 'text'],
  'decorative cover, text, chart': [['cover', 'text', 'bar'], 'text', 'text'],
  'header, decorative cover, text, chart': [['head', 'cover', 'text', 'bar'], 'text', 'text'],
  'decorative cover, pull quote, chart': [['cover', 'quote', 'bar'], 'quote', 'pull_quote'],
};
for (const [name, [keys, firstId, firstType]] of Object.entries(opening)) {
  const spec = page(keys);
  const expected = `${TOP}: the first content module '${firstId}' is a ${firstType} module. ${GUIDANCE}`;
  eq(pageTopWarning(spec, assets), expected, `page-top warning text: ${name}`);
  const lint = lintInfographicSpec(spec, assets, context);
  eq(topWarnings(lint), [expected], `exactly one page-top warning in the lint: ${name}`);
  // warning only: the page that opens with prose passes lint exactly as the same page in a good order does
  eq(lint.blockers, [], `the warning never blocks: ${name}`);
  yes(lint.passed === true, `passed stays true: ${name}`);
  yes(!lint.blockers.some((blocker) => blocker.includes('page_top')), `no page-top blocker: ${name}`);
}
// edges: nothing to warn about when there is no content module yet
eq(pageTopWarning({}, assets), null, 'no modules key');
eq(pageTopWarning({ modules: [] }, assets), null, 'no modules');
eq(pageTopWarning(undefined), null, 'no spec');
eq(pageTopWarning(page(['head']), assets), null, 'only a section header');
eq(pageTopWarning(page(['cover']), assets), null, 'only a decorative cover');
eq(pageTopWarning(page(['head', 'cover']), assets), null, 'a header and a decorative cover');
// "decorative" is read from the stored manifest, never from the page plan or from a module of another type
eq(pageTopWarning(page([{ ...M.scene, metadata: { decorative: true }, decorative: true }, 'text', 'bar']), assets), null, 'a plan-side decorative flag on an illustration changes nothing: it is content either way');
yes(pageTopWarning(page([{ ...M.text, decorative: true, metadata: { decorative: true } }, 'hero', 'bar']), assets)?.startsWith(`${TOP}: the first content module 'text' is a text module.`), 'a plan cannot mark a text module decorative');
yes(pageTopWarning(page([{ ...M.text, asset_ref: 'illustrations/cover.json' }, 'hero', 'bar']), assets)?.startsWith(`${TOP}:`), 'a text module that points at the cover asset is still prose');
eq(pageTopWarning(page(['cover', 'text', 'bar']), {}), null, 'without the stored manifest the cover is an illustration: no warning');

// ---- B. reader text -----------------------------------------------------------------------------------------------
const hits = (result, kind = 'blockers') => result[kind].map((hit) => hit.term);
const blockerCases = [
  // the exact round-2 note, and each term of the work order on its own
  ['数值未经闸门行绑定', 'process_term', ['未经闸门', '行绑定']],
  ['未经闸门核实', 'process_term', ['未经闸门']],
  ['闸门核验', 'process_term', ['闸门']],
  ['闸门检查', 'process_term', ['闸门']],
  ['闸门校对', 'process_term', ['闸门']],
  ['闸门拦截', 'process_term', ['闸门']],
  ['闸门放行', 'process_term', ['闸门']],
  ['这个数字没有通过闸门判定', 'process_term', ['闸门']],
  ['闸门通过', 'process_term', ['闸门']],
  ['数据未绑定', 'process_term', ['未绑定']],
  ['结论未绑定', 'process_term', ['未绑定']],
  ['声明未绑定', 'process_term', ['未绑定']],
  ['数字未绑定', 'process_term', ['未绑定']],
  ['占位符未绑定', 'process_term', ['未绑定']],
  ['该数据行绑定失败', 'process_term', ['行绑定']],
  ['数据行绑定', 'process_term', ['行绑定']],
  // C4: the c449d94 pipeline phrases come back as blockers, and the subject rule catches them in either order
  ['这个数字没有通过闸门', 'process_term', ['闸门']],
  ['数值未绑定', 'process_term', ['未绑定']],
  ['未绑定的数值', 'process_term', ['未绑定']],
  ['结论绑定失败', 'process_term', ['绑定']],
  ['数据闸门核验', 'process_term', ['闸门']],
  ['字段绑定失败', 'process_term', ['绑定']],
  ['闸门检验', 'process_term', ['闸门']],
  ['闸门检测', 'process_term', ['闸门']],
  ['闸门拦下', 'process_term', ['闸门']],
  ['闸门拦住', 'process_term', ['闸门']],
  ['闸门校正', 'process_term', ['闸门']],
  ['闸门核准', 'process_term', ['闸门']],
  ['闸门核算', 'process_term', ['闸门']],
  ['闸门检查', 'process_term', ['闸门']],
  ['闸门核验', 'process_term', ['闸门']],
  ['闸门核心部件', 'process_term', ['闸门']],
  ['see value_from for the number', 'field_name', ['value_from']],
  ['Value_From is shown', 'field_name', ['Value_From']],
  ['the claim_id is claim-1', 'field_name', ['claim_id']],
  ['cites claim_ids here', 'field_name', ['claim_ids']],
  ['CLAIM_ID', 'field_name', ['CLAIM_ID']],
  ['a story_node of the graph', 'field_name', ['story_node']],
  ['story_node_id n-1', 'field_name', ['story_node_id']],
  ['story_node_ids n-1', 'field_name', ['story_node_ids']],
  ['story_nodes', 'field_name', ['story_nodes']],
  ['TODO: write this', 'placeholder_word', ['TODO']],
  ['todo', 'placeholder_word', ['todo']],
  ['ToDo list', 'placeholder_word', ['ToDo']],
  ['这里是TODO项', 'placeholder_word', ['TODO']],
  ['FIXME later', 'placeholder_word', ['FIXME']],
  ['fixme', 'placeholder_word', ['fixme']],
  ['TBD', 'placeholder_word', ['TBD']],
  ['value tbd', 'placeholder_word', ['tbd']],
  ['placeholder text', 'placeholder_word', ['placeholder']],
  ['Placeholder', 'placeholder_word', ['Placeholder']],
  ['two placeholders here', 'placeholder_word', ['placeholders']],
  ['Lorem ipsum dolor', 'placeholder_word', ['Lorem']],
  ['LOREM', 'placeholder_word', ['LOREM']],
  ['the top value is {max.value}', 'template_braces', ['{max.value}']],
  ['{first.col} to {last.col}', 'template_braces', ['{first.col}', '{last.col}']],
  ['{col@key=value}', 'template_braces', ['{col@key=value}']],
  ['{max.rate.year}年阿根廷年通胀率', 'template_braces', ['{max.rate.year}']],
];
for (const [text, rule, terms] of blockerCases) {
  const result = checkReaderText(text);
  eq(hits(result), terms, `blocks ${JSON.stringify(text)}`);
  yes(result.blockers.every((hit) => hit.rule === rule && hit.field === 'page text' && hit.excerpt && hit.message.startsWith(`reader_text_${rule}: page text shows "`)), `blocker shape for ${JSON.stringify(text)}`);
  eq(hits(result, 'warnings'), [], `no warning for ${JSON.stringify(text)}`);
}
// ordinary words are not caught: a climate 模型, a 门槛, a 测量, a running time, ordinary 进行/银行 phrases and look-alikes
for (const text of ['气候模型显示升温', '准入门槛已经降低', '测量误差很小', '检测结果正常', '运行时间约3小时', '运行时长两小时', '运行时刻表', '运行时段不同', '进行绑定操作', '银行绑定了账户', '已进行绑定', 'claim_identity', 'claimid', 'tbdx', 'atbd', 'Mastodon', 'todos', 'story node', 'storynode', 'valuefrom', 'an empty {} and { } pair', 'lintel', 'mockingbird', 'promptly', 'prompted', 'the runtimes', 'placeholdering']) {
  const result = checkReaderText(text);
  eq([...result.blockers, ...result.warnings].map((hit) => hit.term), [], `ordinary text is not caught: ${JSON.stringify(text)}`);
}
// the broader review words warn and never block
const warnCases = [['模拟结果显示上升', '模拟'], ['测试成绩提高', '测试'], ['校验和一致', '校验'], ['运行时错误', '运行时'], ['the runtime of the film', 'runtime'], ['lint rules', 'lint'], ['linting', 'linting'], ['a mock exam', 'mock'], ['mocked up', 'mocked'], ['the prompt', 'prompt'], ['two prompts', 'prompts']];
for (const [text, term] of warnCases) {
  const result = checkReaderText(text);
  eq(hits(result, 'warnings'), [term], `warns on ${JSON.stringify(text)}`);
  eq(result.blockers, [], `a review word never blocks: ${JSON.stringify(text)}`);
  yes(result.warnings[0].rule === 'review_term' && result.warnings[0].message.startsWith('reader_text_review_term: page text uses "'), `warning shape for ${JSON.stringify(text)}`);
}
// ordinary words that look like process words: a warning, never a blocker
for (const [text, term] of [['水库闸门已经关闭', '闸门'], ['账户未绑定', '未绑定'], ['资金缺口修复方案', '缺口修复'], ['闸门', '闸门'], ['水库闸门检修', '闸门'], ['船只通过闸门', '闸门'], ['数据显示，船只通过闸门', '闸门'], ['银行卡未绑定', '未绑定'], ['堤坝缺口修复', '缺口修复'], ['数据显示，账户未绑定', '未绑定']]) {
  const result = checkReaderText(text);
  eq(result.blockers, [], `an ordinary word never blocks: ${JSON.stringify(text)}`);
  eq(hits(result, 'warnings'), [term], `an ordinary word warns: ${JSON.stringify(text)}`);
  yes(result.warnings[0].rule === 'process_word' && result.warnings[0].message.startsWith('reader_text_process_word: page text uses "'), `process_word shape for ${JSON.stringify(text)}`);
}
// a pipeline phrase blocks and does not also warn for its own bare word
eq(hits(checkReaderText('未经闸门核实，结论未绑定'), 'warnings'), [], 'a blocked phrase adds no second warning for its bare word');
eq(hits(checkReaderText('未经闸门核实，水库闸门，缺口修复'), 'warnings'), ['闸门', '缺口修复'], 'a bare word beside a blocked phrase still warns');
// input forms
eq(checkReaderText(['clean', '未经闸门']).blockers.map((hit) => hit.field), ['text[1]'], 'an array of strings names the entry');
eq(checkReaderText([{ field: 'module:x:body', text: '未经闸门' }, { field: 'dek', text: 'fine' }, { field: 'bad', text: 7 }, null, '']).blockers.map((hit) => hit.field), ['module:x:body'], '{field,text} entries keep their field; other items are skipped');
for (const empty of [undefined, null, '', '   ', [], {}, 7]) eq(checkReaderText(empty), { blockers: [], warnings: [] }, `empty input: ${JSON.stringify(empty)}`);
eq(hits(checkReaderText('未经闸门 未经闸门 未经闸门')), ['未经闸门'], 'one finding per term and field, not one per occurrence');
yes(checkReaderText('x'.repeat(200) + '未经闸门' + 'y'.repeat(200)).blockers[0].excerpt.length < 60, 'the excerpt is a short window around the term');

// fields: every reader-facing string of the spec, and nothing else. Each string below carries the process term 未经闸门. The
// planning fields no composer draws, the verbatim source quote and the templates carry it too (their text starts with
// UNREAD) and must stay unread.
const X = '未经闸门';
const tableAssets = {
  ...assets,
  'visualizations/bar.json': { ...assets['visualizations/bar.json'], desktopSvg: assets['visualizations/bar.json'].desktopSvg.replace(/<\/svg>\s*$/, `<text x="1" y="1">chart text ${X}</text></svg>`), manifest: { ...assets['visualizations/bar.json'].manifest, source_note: `bar source note ${X}` } },
  'illustrations/scene.json': illustration(false, { source_note: `scene source note ${X}`, credit: `scene manifest credit ${X}`, provenance: { disclosure: `scene disclosure ${X}` } }),
};
const tableSpec = {
  schema_version: '1.0.0', title: `title ${X}`, dek: `dek ${X}`, kicker: `kicker ${X}`, byline: `byline ${X}`, date_label: `date ${X}`, alt: `A page alt text that is longer than thirty characters ${X}`, source_note: `page source note ${X}`,
  intent: `UNREAD intent ${X}`, primary_message: `UNREAD primary message ${X}`, reader_question: `UNREAD reader question ${X}`, visual_thesis: `UNREAD visual thesis ${X}`, new_information: `UNREAD new information ${X}`,
  scene_graph: { schema_version: '0.1.0', scenes: [{ id: 's1', pattern: 'hero_with_rail', anchor_module_id: 'bar', sidecar_module_ids: ['hero'], eyebrow: `scene eyebrow ${X}`, title: `scene title ${X}`, dek: `scene dek ${X}` }] },
  modules: [
    { id: 'head', type: 'section_header', span: 'full', eyebrow: `head eyebrow ${X}`, heading: `head heading ${X}`, deck: `head deck ${X}` },
    { id: 'hero', type: 'hero_stat', span: 'third', value: `V${X}`, unit: `U${X}`, label: `hero label ${X}`, label_short: `hero short label ${X}`, detail: `hero detail ${X}`, claim_id: claim, label_template: `UNREAD label template ${X}`, detail_template: `UNREAD detail template ${X}`, value_from: `UNREAD value from ${X}` },
    { id: 'bar', type: 'visual', span: 'two_thirds', manifest_ref: 'visualizations/bar.json', label: `bar label ${X}`, subject_caption: `bar subject caption ${X}`, alt: `bar alt ${X}`, annotations: [{ id: 'n1', target_object_id: 'o1', text: `UNREAD annotation ${X}`, claim_id: claim }], story_node_ids: [`UNREAD-node-${X}`], graphic_object_ids: [`UNREAD-object-${X}`] },
    { id: 'text', type: 'text', span: 'two_thirds', label: `text label ${X}`, heading: `text heading ${X}`, body: `text body ${X}`, claim_ids: [claim] },
    { id: 'sq', type: 'text', span: 'full', source_quote: { source_ref: 'sources/x.json', quote: `UNREAD verbatim quote ${X}`, page: 1, translation: `quote translation ${X}` } },
    { id: 'quote', type: 'pull_quote', span: 'full', text: `quote text ${X}`, attribution: `quote attribution ${X}` },
    { id: 'scene', type: 'illustration', span: 'full', asset_ref: 'illustrations/scene.json', alt: `scene alt ${X}`, credit: `scene credit ${X}`, claim_ids: [claim] },
  ],
};
const COPY = true;
const expectedFields = [
  ['title', COPY], ['dek', COPY], ['kicker', COPY], ['byline', !COPY], ['date_label', !COPY], ['alt', !COPY], ['source_note', !COPY],
  ['scene:s1:eyebrow', !COPY], ['scene:s1:title', COPY], ['scene:s1:dek', COPY],
  ['module:head:heading', COPY], ['module:head:deck', COPY], ['module:head:eyebrow', !COPY],
  ['module:hero:label', COPY], ['module:hero:detail', COPY], ['module:hero:label_short', !COPY], ['module:hero:value', !COPY], ['module:hero:unit', !COPY],
  ['module:bar:label', COPY], ['module:bar:subject_caption', COPY], ['module:bar:alt', !COPY], ['module:bar:manifest.source_note', !COPY], ['module:bar:chart_text', !COPY],
  ['module:text:label', COPY], ['module:text:heading', COPY], ['module:text:body', COPY],
  ['module:sq:source_quote.translation', !COPY],
  ['module:quote:text', COPY], ['module:quote:attribution', !COPY],
  ['module:scene:alt', !COPY], ['module:scene:credit', !COPY], ['module:scene:manifest.source_note', !COPY], ['module:scene:manifest.credit', !COPY], ['module:scene:manifest.disclosure', !COPY],
];
const entries = readerTextEntries(tableSpec, tableAssets);
eq(entries.map((entry) => [entry.field, entry.copy]).sort(), [...expectedFields].sort(), 'the fields read, and which of them are running copy');
yes(!entries.some((entry) => entry.text.includes('UNREAD')), 'planning fields, ids, annotations, source_quote.quote and templates are not reader text');
const lintFields = lintInfographicSpec(tableSpec, tableAssets, context);
const flagged = lintFields.blockers.map((blocker) => blocker.match(/^reader_text_process_term: (.+?) shows "未经闸门"/)?.[1]).filter(Boolean);
eq([...flagged].sort(), expectedFields.map(([field]) => field).sort(), 'the lint reports the process term once in every field read, and in no other');
yes(lintFields.passed === false, 'a process term blocks the page');

// a filled hero label is clean; an unfilled placeholder in it is not; the template is never read
const heroLabel = (extra) => lintInfographicSpec(page(['hero', 'bar', 'text'].map((key) => (key === 'hero' ? { ...M.hero, ...extra } : key))), assets, context).blockers.filter((blocker) => blocker.startsWith('reader_text_'));
eq(heroLabel({ label: '2024年阿根廷年通胀率' }), [], 'a filled label with its year is clean');
eq(heroLabel({ label: '{max.rate.year}年阿根廷年通胀率' }).map((blocker) => blocker.split(' shows ')[0]), ['reader_text_template_braces: module:hero:label'], 'an unfilled placeholder in the label blocks');
eq(heroLabel({ label: '2024年阿根廷年通胀率', label_template: '{max.rate.year}年阿根廷年通胀率', detail_template: '{max.rate.year}' }), [], 'label_template and detail_template are templates by design and are not read');
eq(heroLabel({ detail: '{max.value}' }).map((blocker) => blocker.split(' shows ')[0]), ['reader_text_template_braces: module:hero:detail'], 'an unfilled placeholder in the detail blocks');
// a blocker is a blocker in every mode of the lint: the round-2 note, as the readers saw it
const note = lintInfographicSpec(page(['hero', 'bar', { ...M.text, body: '数值未经闸门行绑定（缺口修复中）' }]), assets, context);
eq(note.blockers.map((blocker) => blocker.match(/shows "([^"]+)"/)[1]), ['未经闸门', '行绑定'], 'the round-2 process note is blocked by its pipeline phrases');
eq(note.warnings.filter((warning) => warning.startsWith('reader_text_process_word:')).map((warning) => warning.match(/uses "([^"]+)"/)[1]), ['缺口修复'], '... and its bare 缺口修复 only warns');
yes(note.passed === false, 'the round-2 process note fails lint');
// a story word that is only a review word is a warning, not a blocker
const reviewWord = lintInfographicSpec(page(['hero', 'bar', { ...M.text, body: 'The climate 模拟 suggests warming, and the film runtime is two hours.' }]), assets, context);
eq(reviewWord.blockers, [], 'review words do not block');
eq(reviewWord.warnings.filter((warning) => warning.startsWith('reader_text_review_term:')).map((warning) => warning.match(/uses "([^"]+)"/)[1]), ['模拟', 'runtime'], 'review words warn');

// the text inside a chart is reader text too: text, tspan, title and desc of each visual's desktop SVG, entities decoded
const svgWith = (inner) => ({ ...assets, 'visualizations/bar.json': { ...assets['visualizations/bar.json'], desktopSvg: assets['visualizations/bar.json'].desktopSvg.replace(/<\/svg>\s*$/, `${inner}</svg>`) } });
const chartLint = (inner) => lintInfographicSpec(page(['hero', 'bar', 'text']), svgWith(inner), context);
const chartBlockers = (lint) => lint.blockers.filter((blocker) => blocker.includes('module:bar:chart_text'));
eq(chartBlockers(chartLint('')), [], 'the real chart carries no process word');
for (const [inner, term] of [['<text x="1" y="1">数据行绑定</text>', '行绑定'], ['<text><tspan>未经闸门</tspan></text>', '未经闸门'], ['<title>结论未绑定</title>', '未绑定'], ['<desc>闸门核验</desc>', '闸门'], ['<text>value_from</text>', 'value_from'], ['<text>{max.value}</text>', '{max.value}'], ['<text>&#x672A;&#x7ECF;&#x95F8;&#x95E8;</text>', '未经闸门'], ['<text>&lt;claim_id&gt;</text>', 'claim_id']]) {
  const lint = chartLint(inner);
  eq(chartBlockers(lint).map((blocker) => blocker.match(/shows "([^"]+)"/)[1]), [term], `a process word in chart SVG text blocks: ${inner}`);
  yes(lint.passed === false, `the page fails: ${inner}`);
}
eq(chartLint('<text>水库闸门</text>').warnings.filter((warning) => warning.includes('module:bar:chart_text')).length, 1, 'an ordinary word in chart text warns');
eq(chartBlockers(chartLint('<text>水库闸门</text>')), [], '... and does not block');
eq(chartBlockers(chartLint('<rect data-note="未经闸门" class="value_from"/>')), [], 'other attributes are not reader text');
eq(chartBlockers(chartLint('<rect aria-label="value_from"/>')).length, 1, 'aria-label is read out to readers: it blocks like text');
eq(chartBlockers(chartLint(`<g aria-description='未经闸门'/>`)).length, 1, 'aria-description blocks too');
eq(chartSvgText('<svg><rect aria-label="A &amp; B"/></svg>'), 'A & B', 'chartSvgText: aria-label value, entities decoded');
// every SVG variant the page can embed is read, and an illustration's own text
for (const key of ['mobileSvg', 'compactSvg']) {
  const withCompact = key === 'compactSvg' ? { ...assets, 'visualizations/bar.json': { ...assets['visualizations/bar.json'], compactSvg: assets['visualizations/bar.json'].desktopSvg } } : assets;
  const patched = { ...withCompact, 'visualizations/bar.json': { ...withCompact['visualizations/bar.json'], [key]: withCompact['visualizations/bar.json'][key].replace(/<\/svg>\s*$/, '<text>数据行绑定</text></svg>') } };
  const lint = lintInfographicSpec(page(['hero', 'bar', 'text']), patched, context);
  const field = `module:bar:chart_text.${key.replace('Svg', '')}`;
  eq(lint.blockers.filter((blocker) => blocker.includes(field)).length, 1, `a process word only in the ${key} blocks (${field})`);
  yes(lint.passed === false, `the page fails for ${key}`);
}
{
  const cleanMobile = lintInfographicSpec(page(['hero', 'bar', 'text']), assets, context);
  eq(cleanMobile.blockers.filter((blocker) => blocker.includes('chart_text.')), [], 'the real mobile variant adds no process word');
}
for (const key of ['desktopSvg', 'mobileSvg']) {
  const sceneModule = tableSpec.modules.find((module) => module.type === 'illustration');
  const ref = sceneModule.asset_ref;
  const patched = { ...tableAssets, [ref]: { ...tableAssets[ref], [key]: tableAssets[ref][key].replace(/<\/svg>\s*$/, '<text>未经闸门</text></svg>') } };
  const found = readerTextEntries(tableSpec, patched).filter((entry) => entry.field.startsWith(`module:${sceneModule.id}:illustration_text`) && entry.text.includes('未经闸门'));
  eq(found.length, 1, `an illustration's ${key} text is read`);
}
eq(chartBlockers(chartLint('<script>未经闸门</script><style>.x{}</style>')), [], 'other elements are not reader text');
eq(chartSvgText('<svg><text>A &amp; B</text><text>  second   line </text></svg>').split('\n'), ['A & B', 'second line'], 'chartSvgText: entities decoded, one line per element, spaces collapsed');
eq(chartSvgText('<svg><text><tspan>a</tspan><tspan>b</tspan></text><title>t</title><desc>d</desc></svg>').split('\n').sort(), ['ab', 'd', 't'], 'chartSvgText: tspan, title and desc');
eq(readerTextEntries(page(['hero', 'bar']), { ...assets, 'visualizations/bar.json': { ...assets['visualizations/bar.json'], desktopSvg: undefined } }).filter((entry) => entry.field === 'module:bar:chart_text'), [], 'a visual without a desktop SVG adds no chart entry');

// ---- C. quantifiers and vague times -------------------------------------------------------------------------------
const wording = (text, claimTexts = [], field = 'module:text:body') => checkReaderWording([{ field, text, copy: true }], { claim_texts: claimTexts }).warnings.map((warning) => `${warning.rule}:${warning.term}`);
const quantifiers = [['绝大多数国家下降', '绝大多数'], ['大多数国家下降', '大多数'], ['多数国家下降', '多数'], ['少数国家上升', '少数'], ['过半国家下降', '过半'], ['一半以上的国家下降', '一半以上'], ['几乎所有国家下降', '几乎所有'], ['更多国家在大量减少', '更多国家'], ['更少国家在增长', '更少国家']];
for (const [text, phrase] of quantifiers) {
  eq(wording(text), [`unsupported_quantifier:${phrase}`], `unsupported: ${text}`);
  eq(wording(text, [`其中${phrase}`]), [], `the claim states ${phrase}: no warning`);
}
eq(wording('更多国家在大量减少', ['12个国家上升，12个国家下降']), ['unsupported_quantifier:更多国家'], 'the round-2 case: equal counts above and below zero do not support 更多国家');
eq(wording('大多数国家下降', ['绝大多数国家下降']), [], 'a stronger claim phrase contains the weaker copy phrase');
eq(wording('绝大多数国家下降', ['大多数国家下降']), ['unsupported_quantifier:绝大多数'], 'a weaker claim phrase does not support the stronger copy phrase');
eq(wording('多数国家下降，少数国家上升', ['多数国家下降']), ['unsupported_quantifier:少数'], 'each phrase needs its own support');
eq(wording('多数国家，多数地区'), ['unsupported_quantifier:多数'], 'one warning per phrase and field');
eq(wording('过半数国家同意'), ['unsupported_quantifier:过半'], '过半数 is a quantifier');
eq(wording('超过半数国家同意'), ['unsupported_quantifier:过半'], '超过半数 is a quantifier');
eq(wording('任期已过半'), ['unsupported_quantifier:过半'], '已过半 is a quantifier');
for (const text of ['少数民族地区', '更多数据可用', '少数量级', '大多数据来自卫星', '经过半年的观察', '超过半年', '通过半导体', '过半个月', '过半天']) eq(wording(text), [], `not a quantifier: ${text}`);
// the claim text decides, not the model: only a verified claim the page cites counts, and without records there is nothing to compare with
eq(checkReaderWording([{ field: 'f', text: '多数国家下降', copy: true }]).warnings, [], 'no claim records supplied: the quantifier check is skipped');
eq(checkReaderWording([{ field: 'f', text: '多数国家下降', copy: true }], { claim_texts: null }).warnings, [], 'claim_texts null: skipped');
eq(checkReaderWording([{ field: 'f', text: '目前多数国家下降', copy: true }]).warnings.map((warning) => warning.rule), ['vague_time'], 'without records the vague-time check still runs');
const vague = [['最近一年的数据', '最近一年'], ['近年来持续下降', '近年来'], ['近几年持续下降', '近几年'], ['近期数据回落', '近期'], ['目前的水平较低', '目前'], ['如今更低', '如今'], ['最新数据显示下降', '最新']];
for (const [text, phrase] of vague) eq(wording(text), [`vague_time:${phrase}`], `vague time: ${text}`);
for (const text of ['2024年最新数据显示下降', '2022年1月至2024年12月，近期回落', 'As of 2024, 目前较低', '1998年以来如今更低']) eq(wording(text), [], `a stated year is a stated period: ${text}`);
for (const text of ['项目前期工作', '题目前面的部分', '节目前半段', '最新鲜的水果', '最新颖的设计']) eq(wording(text), [], `vague-time look-alike: ${text}`);
eq(checkReaderWording([{ field: 'alt', text: '最新数据，多数国家', copy: false }, { field: 'source_note', text: '目前', copy: false }], { claim_texts: [] }).warnings, [], 'only copy fields are read for wording: alt and source notes are not');
yes(checkReaderWording([{ field: 'module:text:body', text: '近期，多数国家', copy: true }], { claim_texts: [] }).warnings.every((warning) => warning.message.includes('module:text:body')), 'the message names the field');
eq(checkReaderWording([{ field: 'f', text: '近期，多数国家', copy: true }], { claim_texts: [] }).warnings.map((warning) => warning.message.split(':')[0]), ['unsupported_quantifier', 'vague_time_reference'], 'message prefixes');

// the lint wires the cited claims through: claim_ids, claim_id, claim_set, annotations, the chart's own claim, scene claims, pull quotes
const supportClaim = 'claim-support';
const records = [
  { claim_id: claim, claim: '12个国家上升，12个国家下降。' },
  { claim_id: supportClaim, claim: '其中多数国家的通胀率下降。' },
];
const ctxWith = (extra = {}) => ({ verified_claim_ids: [claim, supportClaim], verified_claim_records: records, ...extra });
const bodyWarnings = (spec, ctx = ctxWith(), a = assets) => lintInfographicSpec(spec, a, ctx).warnings.filter((warning) => warning.startsWith('unsupported_quantifier:'));
const quantText = { ...M.text, body: '多数国家的通胀率下降。', claim_ids: [claim] };
eq(bodyWarnings(page(['hero', 'bar', quantText])).length, 1, 'the module cites a claim that does not state 多数: warning');
eq(bodyWarnings(page(['hero', 'bar', { ...quantText, claim_ids: [claim, supportClaim] }])), [], 'the module cites a claim that states it (claim_ids): no warning');
const routes = {
  'a hero claim_id': ['hero', { ...M.hero, claim_id: supportClaim }],
  'a visual claim_set': ['bar', { ...M.bar, claim_set: [supportClaim] }],
  'a visual claim_ids': ['bar', { ...M.bar, claim_ids: [supportClaim] }],
  'an annotation claim_id': ['bar', { ...M.bar, annotations: [{ id: 'note', text: 'A note.', claim_id: supportClaim }] }],
  'a pull quote claim_ids': ['quote', { ...M.quote, claim_ids: [supportClaim] }],
};
for (const [name, [id, replacement]] of Object.entries(routes)) {
  const modules = ['hero', 'bar', 'quote', quantText].map((key) => (typeof key === 'string' ? (key === id ? replacement : M[key]) : key));
  eq(bodyWarnings(page(modules)), [], `supported through ${name}`);
}
eq(bodyWarnings(page(['hero', 'bar', 'quote', quantText])).length, 1, 'control: nothing cites the supporting claim');
const chartClaimAssets = { ...assets, 'visualizations/bar.json': { ...assets['visualizations/bar.json'], manifest: { ...assets['visualizations/bar.json'].manifest, claim_id: supportClaim } } };
eq(bodyWarnings(page(['hero', 'bar', quantText]), ctxWith(), chartClaimAssets), [], 'supported through the chart manifest claim');
eq(bodyWarnings(page(['hero', 'bar', quantText], { scene_graph: { schema_version: '0.1.0', scenes: [{ id: 's1', pattern: 'hero_with_rail', anchor_module_id: 'bar', sidecar_module_ids: ['hero'], supporting_claim_ids: [supportClaim] }] } })), [], 'supported through a scene supporting_claim_ids');
// support must come from a verified record
eq(bodyWarnings(page(['hero', 'bar', { ...quantText, claim_ids: [claim, supportClaim] }]), ctxWith({ verified_claim_ids: [claim], verified_claim_records: records })).length, 1, 'a cited claim that is not verified supports nothing');
eq(bodyWarnings(page(['hero', 'bar', { ...quantText, claim_ids: [claim, supportClaim] }]), ctxWith({ verified_claim_ids: [claim], verified_claim_records: [records[0], { ...records[1], verification: { authority: 'system', publishable: true } }] })), [], 'a record that carries the system publishable verification counts');
eq(bodyWarnings(page(['hero', 'bar', { ...quantText, claim_ids: [claim, supportClaim] }]), ctxWith({ verified_claim_ids: [claim], verified_claim_records: [records[0], { ...records[1], verification: { authority: 'model', publishable: true } }] })).length, 1, 'a verification the model could write does not count');
eq(bodyWarnings(page(['hero', 'bar', { ...quantText, claim_ids: [claim, supportClaim] }]), ctxWith({ verified_claim_ids: [claim], verified_claim_records: [records[0], { ...records[1], verification: { authority: 'system', publishable: false } }] })).length, 1, 'a record that is not publishable does not count');
eq(bodyWarnings(page(['hero', 'bar', quantText]), { verified_claim_ids: [claim, supportClaim] }), [], 'no claim records in the context: the check is skipped');
// vague time through the lint: copy fields only, and a stated year is a stated period
const timeWarnings = (spec) => lintInfographicSpec(spec, assets, ctxWith()).warnings.filter((warning) => warning.startsWith('vague_time_reference:'));
eq(timeWarnings(page(['hero', 'bar', { ...M.text, body: '目前的水平低于去年。' }])).length, 1, 'vague time in a text body warns');
eq(timeWarnings(page(['hero', 'bar', { ...M.text, body: '2024年的最新水平低于去年。' }])), [], 'a stated year in the same field clears it');
eq(timeWarnings(page(['hero', 'bar', M.text], { title: '近年来的变化', dek: '目前仍在下降。' })).map((warning) => warning.match(/^vague_time_reference: (\S+) /)[1]), ['title', 'dek'], 'the title and the dek are read');
eq(timeWarnings(page(['hero', 'bar', M.text], { alt: '最新的页面', source_note: '数据截至目前' })), [], 'alt and source_note are not copy');
eq(lintInfographicSpec(page(['hero', 'bar', { ...M.text, body: '目前多数国家下降。' }]), assets, ctxWith()).blockers, [], 'wording findings are warnings, never blockers');

// ---- D. hero gate on by default ----------------------------------------------------------------------------------
const stub = (dir, name, source) => {
  mkdirSync(join(dir, 'node_modules', name), { recursive: true });
  writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
  writeFileSync(join(dir, 'node_modules', name, 'index.js'), source);
};
// a faithful TypeBox stand-in: objects keep their properties, so the tool schemas can be read
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
const TREE = mkdtempSync(join(tmpdir(), 'page-top-tree-'));
cpSync(join(ROOT, 'runtime'), join(TREE, 'runtime'), { recursive: true });
cpSync(join(ROOT, 'config'), join(TREE, 'config'), { recursive: true });
stub(TREE, 'typebox', TYPEBOX);
stub(TREE, '@earendil-works/pi-ai', "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY_PATH = join(TREE, 'runtime/pi/newsroom.test-copy.mjs');
writeFileSync(COPY_PATH, stripTypeScriptTypes(readFileSync(join(TREE, 'runtime/pi/newsroom.ts'), 'utf8'), { mode: 'strip' }));
const ENV_KEYS = ['NEWSROOM_HERO_VALUE_GATE', 'NEWSROOM_TOOL_PROFILE', 'NEWSROOM_PHASE', 'NEWSROOM_MOBILE_PAGES'];
let loadN = 0;
async function register(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NEWSROOM_TOOL_PROFILE = 'full';
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const tools = new Map();
  const mod = await import(`${pathToFileURL(COPY_PATH).href}?v=${++loadN}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === 'registerTool' ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const moduleProps = (tools) => tools.get('newsroom_infographic_plan').parameters.properties.modules.items.properties;
const def = await register({});
yes('value_from' in moduleProps(def), 'default: the plan tool offers value_from');
const defKeys = Object.keys(moduleProps(def)).filter((key) => key !== 'value_from');
// only the exact string "0" turns the gate off; unset, "1", empty and any typo leave it on
for (const value of ['1', '', 'off', 'false', 'true', 'no', ' 0', '00']) {
  const tools = await register({ NEWSROOM_HERO_VALUE_GATE: value });
  yes('value_from' in moduleProps(tools), `NEWSROOM_HERO_VALUE_GATE=${JSON.stringify(value)} leaves the gate on`);
}
const off = await register({ NEWSROOM_HERO_VALUE_GATE: '0' });
yes(!('value_from' in moduleProps(off)), 'NEWSROOM_HERO_VALUE_GATE=0: the plan tool no longer offers value_from');
eq(Object.keys(moduleProps(off)), defKeys, '=0 changes no other module property');

// the real lint tool, on a small artifact root: system-verified claims, three hand-stored plans
const verification = { authority: 'system', rule_id: 'verification.source+extraction+computation+claim.v1', source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
function miniRoot() {
  const art = join(mkdtempSync(join(tmpdir(), 'page-top-run-')), 'run');
  for (const dir of ['infographics/plans', 'infographics/lints', 'computations']) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(ROOT, 'config'), join(art, 'config'), { recursive: true });
  const claims = [
    // c-a carries system bindings: a hero can only use a bound claim, and these tests are about the typed value, not the binding.
    { claim_id: 'c-a', status: 'verified', claim: '12个国家的通胀率上升，12个国家下降。', claim_template: '{max.n}个国家的通胀率上升，{max.n}个国家下降。', claim_bindings: [{ placeholder: '{max.n}', column: 'n', row_index: 0, value: 12, text: '12' }], recorded_by: 'newsroom_viz_plan', verification },
    { claim_id: 'c-b', status: 'verified', claim: '其中多数国家的通胀率在2024年下降。', verification },
  ];
  writeFileSync(join(art, 'claims.jsonl'), `${claims.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}
const storePlan = (art, modules) => {
  const core = { ...base, title: '一页没有图的页面', dek: '这一页只用来测试页面顶部和读者文字。', modules };
  const key = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  const ref = `infographics/plans/${key}.json`;
  writeFileSync(join(art, ref), JSON.stringify({ ...core, content_hash: key }));
  return ref;
};
const typedHero = { id: 'hero', type: 'hero_stat', span: 'third', value: '2', unit: '', label: 'Largest regional value', detail: 'Reached in the last year of the data', claim_id: 'c-a' };
const proseOf = (id, body, claimId) => ({ id, type: 'text', span: 'two_thirds', heading: 'A synthetic heading', body, claim_ids: [claimId] });
const plans = {
  clean: [typedHero, proseOf('t1', '更多国家在大量减少。', 'c-a'), proseOf('t2', '多数国家的通胀率在2024年下降。', 'c-b'), proseOf('t3', '目前的水平低于去年。', 'c-a')],
  proseFirst: [proseOf('t1', '这一页以文字开头。', 'c-a'), typedHero, proseOf('t2', '第二段文字。', 'c-b')],
  note: [typedHero, proseOf('t1', '数值未经闸门行绑定（缺口修复中）', 'c-a'), proseOf('t2', '第二段文字。', 'c-b')],
};
// Every call gets its own artifact root: a stored lint record is immutable, and one plan lints differently with the gate on and off.
const GATE_OFF = { NEWSROOM_HERO_VALUE_GATE: '0' };
const lintTool = async (env, name) => {
  const root = miniRoot();
  const planRef = storePlan(root, plans[name]);
  const tools = await register(env);
  return (await tools.get('newsroom_infographic_lint').execute('lint', { plan_ref: planRef })).details;
};
const heroBlockers = (details) => (details.blockers ?? []).filter((blocker) => blocker.includes("'hero'"));
// default: a typed hero value is refused, with no switch set
const gateOn = await lintTool({}, 'clean');
eq(heroBlockers(gateOn).map((blocker) => blocker.split(':')[0]), ['HERO_VALUE_FROM_REQUIRED'], 'default: a typed hero value is blocked by the hero value gate');
yes(gateOn.passed === false, 'default: the page does not pass');
for (const value of ['1', '', 'off']) eq(heroBlockers(await lintTool({ NEWSROOM_HERO_VALUE_GATE: value }, 'clean')).map((blocker) => blocker.split(':')[0]), ['HERO_VALUE_FROM_REQUIRED'], `NEWSROOM_HERO_VALUE_GATE=${JSON.stringify(value)}: the gate is still on`);
// =0: the old path, no hero blocker
const gateOff = await lintTool(GATE_OFF, 'clean');
eq(heroBlockers(gateOff), [], '=0: a typed hero value is no longer a hero-gate blocker');
eq(gateOff.blockers, [], '=0: nothing else blocks the clean plan');
yes(gateOff.passed === true, '=0: the clean plan passes');
// the new checks run in the real tool, whichever way the switch is set
for (const [label, env, details] of [['default', {}, gateOn], ['=0', GATE_OFF, gateOff]]) {
  eq(details.warnings.filter((warning) => warning.startsWith('unsupported_quantifier:')).map((warning) => warning.match(/^unsupported_quantifier: (\S+) says "([^"]+)"/).slice(1)), [['module:t1:body', '更多国家']], `${label}: the unsupported quantifier is found in the real tool, and the supported one (c-b states it) is not`);
  eq(details.warnings.filter((warning) => warning.startsWith('vague_time_reference:')).map((warning) => warning.match(/^vague_time_reference: (\S+) says "([^"]+)"/).slice(1)), [['module:t3:body', '目前']], `${label}: the vague time is found in the real tool; the sentence that states 2024年 is not`);
  eq(details.warnings.filter((warning) => warning.startsWith(`${TOP}:`)), [], `${label}: a page that opens with its number has no page-top warning`);
  const top = await lintTool(env, 'proseFirst');
  eq(top.warnings.filter((warning) => warning.startsWith(`${TOP}: the first content module 't1' is a text module.`)).length, 1, `${label}: the page-top warning reaches the real tool`);
  const flaggedNote = await lintTool(env, 'note');
  eq(flaggedNote.blockers.filter((blocker) => blocker.startsWith('reader_text_')).map((blocker) => blocker.match(/shows "([^"]+)"/)[1]), ['未经闸门', '行绑定'], `${label}: the process note is blocked by the real tool`);
  yes(flaggedNote.passed === false, `${label}: the process note fails the real lint`);
}
eq((await lintTool(GATE_OFF, 'proseFirst')).passed, true, '=0: a page that opens with prose still passes: the page-top check only warns');

// ---- E. the guidance reaches the model ---------------------------------------------------------------------------
const guidelines = (tools, name) => tools.get(name).promptGuidelines;
const count = (list, text) => list.filter((entry) => entry === text).length;
const HERO_PLAIN = 'A hero_stat label names the subject, the measure and the period, for example 「2024年阿根廷年通胀率」, not 「通胀率」.';
const HERO_GATED = 'A hero_stat label names the subject, the measure and the period, for example 「{max.rate.year}年阿根廷年通胀率」, not 「通胀率」; the year comes from a placeholder of the hero\'s claim (typed digits are refused), so that claim must state the period.';
const WINDOW = 'A relative window such as 近三年 means the 36 months up to the latest data point; state its start and end dates on the page.';
for (const [label, tools, heroLine, otherLine] of [['default', def, HERO_GATED, HERO_PLAIN], ['=0', off, HERO_PLAIN, HERO_GATED]]) {
  const plan = guidelines(tools, 'newsroom_infographic_plan');
  eq(count(plan, GUIDANCE), 1, `${label}: the plan tool carries the page-top sentence once, as its own guideline`);
  eq(count(plan, heroLine), 1, `${label}: the plan tool carries the hero-label sentence for this mode`);
  eq(count(plan, otherLine), 0, `${label}: and not the other mode's`);
  yes(plan.indexOf(GUIDANCE) < plan.findIndex((entry) => entry.startsWith('Prefer 4-9 modules')), `${label}: the page-top sentence comes before the module-count advice`);
  eq(count(guidelines(tools, 'duckdb_query'), WINDOW), 1, `${label}: duckdb_query carries the relative-window sentence once`);
}
// only the sentences above and the value_from schema entry differ between the two modes
const strip = (tools) => JSON.stringify([...tools.values()].map((tool) => [tool.name, tool.description, tool.promptSnippet, (tool.promptGuidelines ?? []).filter((entry) => entry !== HERO_PLAIN && entry !== HERO_GATED), JSON.parse(JSON.stringify(tool.parameters, (key, value) => (key === 'value_from' ? undefined : value)))]));
yes(strip(def) === strip(off), 'default and =0 differ only in the hero-label sentence and the value_from schema entry');
yes(![...def.values()].some((tool) => /(NEWSROOM_HERO_VALUE_GATE|=1 enables)/.test(`${tool.description}\n${(tool.promptGuidelines ?? []).join('\n')}`)), 'no tool text tells the model about the switch');

console.log(`page top / reader text / hero gate default: ${n} checks -- PASS`);
