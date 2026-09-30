#!/usr/bin/env node
// Regression coverage for the source_quote extension to text modules
// (runtime/pi/infographic.mjs): a non-asserting, source-only definitional
// note that cites a saved source snapshot verbatim by page, is never a
// verified claim, and is always visibly labelled 页码/译述 on a zh page.
import assert from 'node:assert/strict';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle, critiqueInfographic } from '../runtime/pi/infographic.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';

const claim = 'claim-source-quote';
const context = { verified_claim_ids: [claim] };

// A two-page pdftotext-style extraction (runtime/pi/pdf_extract.mjs's
// [page N]\n markers), with a hyphenated line-break on page 2 so the
// hyphenation-join normalization is actually exercised.
const sourceText =
  '[page 1]\nALPHA introductory material spans several lines of running text.\n\n' +
  '[page 2]\nThis indicator counts fuel-\nwood and charcoal as renewable energy.';
const sourceRef = 'sources/deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.json';
const sourceTexts = new Map([[sourceRef, sourceText]]);
const correctQuote = 'fuelwood and charcoal as renewable energy';

function baseSpec(overrides = {}) {
  return {
    schema_version: '1.0.0', kicker: 'DATA FEATURE', title: 'A definitional caveat sits beside the finding it qualifies',
    dek: 'Regression fixture for source_quote.', alt: 'A single text module with a source quote note.',
    byline: 'Newsroom Agent', date_label: 'Regression edition', layout: 'feature', complexity_budget: 'low',
    source_note: 'Synthetic source_quote regression fixture', language: 'zh',
    modules: [
      { id: 'section-1', type: 'section_header', span: 'full', eyebrow: '背景', heading: '数据来自同一份来源文件', deck: '正文与方法学附注共享同一页面。' },
      { id: 'stat-total', type: 'hero_stat', span: 'third', tone: 'accent', value: '100', unit: 'PJ', label: '已核实的合成总量', detail: '核实声明夹具', claim_id: claim },
      {
        id: 'definition-note', type: 'text', span: 'two_thirds', label: '定义说明', heading: '一项方法学附注',
        body: '该指标的统计口径包含以下说明。',
        source_quote: { source_ref: sourceRef, page: 2, quote: correctQuote, translation: '将燃料木材和木炭计为可再生能源' },
        ...overrides,
      },
    ],
  };
}

// --- schema validation --------------------------------------------------

// Positive: valid zh source_quote passes schema validation.
assert.deepEqual(validateInfographicSpec(baseSpec()), []);

// Negative: source_quote is mutually exclusive with claim_ids - a source
// quote never counts as a verified finding.
{
  const spec = baseSpec({ claim_ids: [claim] });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('cannot combine source_quote with claim_ids')), errors.join(' | '));
}

// Negative: source_quote is only valid on a text module.
{
  const spec = baseSpec();
  spec.modules.push({ id: 'stat', type: 'hero_stat', span: 'third', value: '1', unit: 'x', label: 'x', claim_id: claim, source_quote: { source_ref: sourceRef, page: 2, quote: correctQuote } });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes("source_quote is only supported on 'text' modules")), errors.join(' | '));
}

// Negative: malformed source_ref (not a content-addressed sources/<sha256>.json path).
{
  const spec = baseSpec({ source_quote: { source_ref: 'sources/not-a-hash.json', page: 2, quote: correctQuote, translation: 'x' } });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('content-addressed sources/<sha256>.json path')), errors.join(' | '));
}

// Negative: missing/invalid page.
{
  const spec = baseSpec({ source_quote: { source_ref: sourceRef, page: 0, quote: correctQuote, translation: 'x' } });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('requires a positive integer page')), errors.join(' | '));
}

// Negative: a zh page's source_quote requires a translation (labeled 译述).
{
  const spec = baseSpec({ source_quote: { source_ref: sourceRef, page: 2, quote: correctQuote } });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('requires translation (labeled 译述) on a zh page')), errors.join(' | '));
}

// Negative: a body containing a digit next to a source_quote must be
// rejected - free prose beside a source-only quote must never be able to
// look like a verified figure of its own (full-width digits are checked
// too, not just ASCII).
{
  const spec = baseSpec({ body: '本页共有 3 条来源附注。' });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('must not contain digits or a percent sign')), errors.join(' | '));
}
{
  const spec = baseSpec({ body: '含有全角数字３的说明。' });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('must not contain digits or a percent sign')), errors.join(' | '));
}

// Negative: a body over 60 characters next to a source_quote must be
// rejected, even with no digits.
{
  const spec = baseSpec({ body: '这段说明文字被故意写得' + '非常'.repeat(30) + '长，超过了六十个字符的上限。' });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes('must be at most 60 characters')), errors.join(' | '));
}

// Negative: a heading next to a source_quote follows the same rule.
{
  const spec = baseSpec({ heading: '附注 2' });
  const errors = validateInfographicSpec(spec);
  assert.ok(errors.some((e) => e.includes("source_quote heading must not contain digits or a percent sign")), errors.join(' | '));
}

// Positive: a source_quote with no body at all (the quote block itself
// carries the content) passes schema validation, lints, and renders -
// including through render QA - with no stray "undefined" text or empty
// line where the body would have gone.
{
  const spec = baseSpec({ body: undefined });
  assert.deepEqual(validateInfographicSpec(spec), []);
  const lint = lintInfographicSpec(spec, {}, { ...context, source_texts: sourceTexts });
  assert.equal(lint.passed, true, lint.blockers.join(' | '));
  const bundle = composeInfographicBundle(spec, {});
  assert.doesNotMatch(bundle.desktop.svg, /undefined/);
  assert.match(bundle.desktop.svg, /原文引述/);
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports));
}

// --- lint-time verbatim match --------------------------------------------

// Positive: verbatim quote on the right page passes lint.
{
  const lint = lintInfographicSpec(baseSpec(), {}, { ...context, source_texts: sourceTexts });
  assert.equal(lint.passed, true, lint.blockers.join(' | '));
}

// Negative: non-verbatim quote fails lint.
{
  const spec = baseSpec({ source_quote: { source_ref: sourceRef, page: 2, quote: 'fuelwood and charcoal are the main renewable source', translation: 'x' } });
  const lint = lintInfographicSpec(spec, {}, { ...context, source_texts: sourceTexts });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes('does not appear verbatim')), lint.blockers.join(' | '));
}

// Negative: correct text, wrong page, fails lint.
{
  const spec = baseSpec({ source_quote: { source_ref: sourceRef, page: 1, quote: correctQuote, translation: 'x' } });
  const lint = lintInfographicSpec(spec, {}, { ...context, source_texts: sourceTexts });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes('does not appear verbatim on page 1')), lint.blockers.join(' | '));
}

// Negative: source not supplied for lint verification at all.
{
  const lint = lintInfographicSpec(baseSpec(), {}, { ...context, source_texts: new Map() });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes('was not supplied for lint verification')), lint.blockers.join(' | '));
}

// --- compose/render + critic/render-QA -----------------------------------

const spec = baseSpec();
const bundle = composeInfographicBundle(spec, {});
assert.match(bundle.desktop.svg, /data-role="source-quote-note"/);
assert.match(bundle.desktop.svg, /原文引述/);
assert.match(bundle.desktop.svg, /页码.*2/);
assert.match(bundle.desktop.svg, /译述/);
assert.ok(bundle.desktop.svg.includes(correctQuote), 'rendered desktop SVG should include the verbatim quote text');

// critiqueInfographic's editorial rubric (visual variety, embedding, etc.)
// is orthogonal to source_quote itself, which this fixture is deliberately
// minimal for; the geometry/contrast/CJK-wrapping gate the task cares about
// here is runRenderQa, checked below. Confirm the critic run at least
// completes and raises no source_quote-specific issue.
const critic = critiqueInfographic(spec, bundle);
assert.ok(!critic.issues.some((i) => String(i.code ?? '').includes('source_quote')), JSON.stringify(critic.issues));

const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
assert.equal(qa.passed, true, JSON.stringify(qa.viewports));

console.log('test_infographic_source_quote.mjs: all checks passed');
