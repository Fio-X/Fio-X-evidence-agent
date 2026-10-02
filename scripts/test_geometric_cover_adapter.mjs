// Contract tests for the bundled geometric-cover/1 illustration adapter
// (runtime/pi/adapters/geometric_cover.mjs). The adapter is exercised the way
// newsroom_illustration_generate runs it: a child process, no shell, one JSON
// request on stdin, one JSON object on stdout, cwd somewhere unrelated.
//
// What is asserted, in order:
//   gates       - the real normalize + critic + assertSafeSvg + render-QA geometry
//                 check accept the output (nothing is mocked or loosened);
//   determinism - same request, same bytes; different request hashes, different
//                 bytes but identical element counts;
//   data-blind  - the adapter reads nothing but the hash and the motif: pinning
//                 the hash and changing every other field gives identical bytes,
//                 and request shapes with 1 or 40 refs, 1 or 20 claims, zh or en
//                 text give identical counts;
//   clean SVG   - no text, image, gradient, filter, clip, script or external
//                 reference, no background rect, only the house greys and accent,
//                 every coordinate inside the viewBox;
//   refusals    - one distinct non-zero exit code, empty stdout and exactly one
//                 stderr line for every request the adapter must not serve;
//   packaging   - works when materialized flat beside viz.mjs, exits 7 without it;
//   unset env   - the existing illustration contract test still passes with the
//                 adapter variables removed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  critiqueRichIllustration,
  illustrationAdapterRequest,
  lintIllustrationSpec,
  normalizeIllustrationAdapterResponse,
} from '../runtime/pi/illustration.mjs';
import { assertSafeSvg } from '../runtime/pi/svg_security.mjs';
import { checkSvgGeometry } from '../runtime/pi/render_qa_geometry.mjs';
import { HOUSE_PALETTES } from '../runtime/pi/viz.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = path.join(ROOT, 'runtime/pi/adapters/geometric_cover.mjs');
const PALETTE = HOUSE_PALETTES.house;
const VIEWBOX = { desktop: [1200, 320], mobile: [390, 260] };

// Independent of the adapter's own tables on purpose: changing a layout must
// be a deliberate edit here too. elements = drawn shapes per viewport.
const EXPECTED = {
  arcs: { elements: { desktop: 120, mobile: 48 }, accent: { desktop: 3, mobile: 2 } },
  concentric: { elements: { desktop: 21, mobile: 7 }, accent: { desktop: 2, mobile: 1 } },
  bands: { elements: { desktop: 50, mobile: 20 }, accent: { desktop: 2, mobile: 2 } },
};
const FAMILIES = Object.keys(EXPECTED);

const baseSpec = (overrides = {}) => ({
  schema_version: '0.2.0',
  title: '页面封面图案',
  subject: 'A decorative page cover',
  intent: 'Decorate the top of the page without depicting facts.',
  alt: '由几何图形组成的装饰性封面图案，仅作版面装饰，不表示任何数据。',
  style_direction: 'Restrained geometric pattern in the house palette.',
  aspect_ratio: 'landscape',
  origin_policy: 'software_only',
  source_note: 'Decorative; carries no data.',
  credit: 'Agentic Data Newsroom',
  claim_ids: ['claim-1'],
  evidence_refs: ['data/source.data'],
  factual_elements: [],
  constraints: ['motif=arcs'],
  ...overrides,
});
const requestFor = (family, overrides = {}, snapshot = 'snapshot-a') =>
  illustrationAdapterRequest(baseSpec({ constraints: [`motif=${family}`], ...overrides }), { evidence_snapshot_hash: snapshot });

const timings = {};
function run(request, { adapter = ADAPTER, raw, label } = {}) {
  const started = process.hrtime.bigint();
  const proc = spawnSync(process.execPath, [adapter], {
    input: raw ?? JSON.stringify(request),
    encoding: 'utf8',
    cwd: os.tmpdir(),
    timeout: 30000,
  });
  if (label) (timings[label] ??= []).push(Number(process.hrtime.bigint() - started) / 1e6);
  return proc;
}
function ok(request, options) {
  const proc = run(request, options);
  assert.equal(proc.status, 0, `adapter failed: ${proc.stderr}`);
  assert.equal(proc.stderr, '', 'adapter must be silent on success');
  assert.equal(proc.stdout.split('\n').length, 2, 'stdout is exactly one JSON line');
  assert.ok(proc.stdout.endsWith('\n'));
  return { stdout: proc.stdout, response: JSON.parse(proc.stdout) };
}

const shapeTags = (svg) => [...svg.matchAll(/<([a-zA-Z][\w:-]*)\b/g)].map((m) => m[1]).filter((tag) => !['svg', 'g', 'title', 'desc'].includes(tag));
const colours = (svg) => [...svg.matchAll(/\b(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
const accentCount = (svg) => colours(svg).filter((c) => c === PALETTE.accent.toLowerCase()).length;
const numbers = (text) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

// Every coordinate a shape can reach (path/polygon vertices, circle extents
// plus half the stroke), checked against the viewBox with an optional margin.
function assertInsideViewBox(svg, [w, h], margin = 0) {
  const strokeWidth = Number(/stroke-width="([\d.]+)"/.exec(svg)?.[1] ?? 0);
  const points = [];
  for (const m of svg.matchAll(/<circle\b([^>]*)>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const reach = Number(a.r) + (a.stroke ? strokeWidth / 2 : 0);
    points.push([Number(a.cx) - reach, Number(a.cy) - reach], [Number(a.cx) + reach, Number(a.cy) + reach]);
  }
  for (const m of svg.matchAll(/<polygon\b[^>]*\bpoints="([^"]*)"/g)) {
    for (const pair of m[1].trim().split(/\s+/)) { const [x, y] = pair.split(',').map(Number); points.push([x, y]); }
  }
  for (const m of svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) {
    for (const seg of m[1].matchAll(/([MLAZ])([^MLAZ]*)/g)) {
      const n = numbers(seg[2]);
      if (seg[1] === 'M' || seg[1] === 'L') for (let i = 0; i + 1 < n.length; i += 2) points.push([n[i], n[i + 1]]);
      else if (seg[1] === 'A') points.push([n[5], n[6]]);
    }
  }
  assert.ok(points.length > 0, 'cover draws something');
  for (const [x, y] of points) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'finite coordinate');
    assert.ok(x >= margin - 1e-6 && x <= w - margin + 1e-6 && y >= margin - 1e-6 && y <= h - margin + 1e-6, `coordinate ${x},${y} outside the ${w}x${h} viewBox (margin ${margin})`);
  }
}

// ---------------------------------------------------------------------------
// gates
for (const family of FAMILIES) {
  const spec = baseSpec({ constraints: [`motif=${family}`] });
  const lint = lintIllustrationSpec(spec, { verified_claim_ids: ['claim-1'], evidence_refs: ['data/source.data'] });
  assert.equal(lint.passed, true, `${family} spec lints`);
  const { response } = ok(requestFor(family), { label: family });
  assert.equal(response.origin, 'software');
  assert.equal(response.digital_source_type, 'algorithmicMedia');
  assert.equal(response.adapter_id, 'geometric-cover/1');
  assert.equal(response.disclosure, '软件生成的装饰图，不含数据');
  assert.ok(String(response.license).length > 0);
  assert.equal(response.provider, undefined);
  assert.equal(response.model, undefined);
  assert.equal(response.metadata.decorative, true);
  assert.equal(response.metadata.motif, family);
  assert.deepEqual(response.metadata.element_counts, EXPECTED[family].elements);

  const normalized = normalizeIllustrationAdapterResponse(spec, response);
  assert.equal(normalized.provenance.origin, 'software');
  assert.equal(normalized.provenance.provider, null);
  assert.equal(normalized.provenance.model, null);
  assert.match(normalized.desktop, /data-rich-illustration-version="0\.2\.0"/);
  assert.ok(normalized.desktop.includes('<title>页面封面图案</title>') && normalized.desktop.includes('<desc>'), 'title and desc come from the spec');
  const critic = critiqueRichIllustration(spec, { provenance: normalized.provenance }, { desktop: normalized.desktop, mobile: normalized.mobile });
  assert.equal(critic.passed, true, JSON.stringify(critic.issues));
  assert.ok(critic.score >= 90, `critic score ${critic.score}`);
  for (const viewport of ['desktop', 'mobile']) {
    const svg = response.variants[viewport];
    assert.doesNotThrow(() => assertSafeSvg(normalized[viewport], { label: `${family} ${viewport}` }));
    assert.ok(svg.includes(`viewBox="0 0 ${VIEWBOX[viewport][0]} ${VIEWBOX[viewport][1]}"`), `${family} ${viewport} viewBox`);
    const geometry = checkSvgGeometry(svg);
    assert.equal(geometry.passed, true, `${family} ${viewport} render-QA geometry: ${JSON.stringify(geometry.failures)}`);
    assert.equal(geometry.summary.texts_checked, 0);
  }
}

// ---------------------------------------------------------------------------
// fixed counts, clean SVG, palette, bounds
for (const family of FAMILIES) {
  for (const snapshot of ['s1', 's2', 's3', 's4']) {
    const { response } = ok(requestFor(family, {}, snapshot));
    for (const viewport of ['desktop', 'mobile']) {
      const svg = response.variants[viewport];
      assert.equal(shapeTags(svg).length, EXPECTED[family].elements[viewport], `${family} ${viewport} element count (${snapshot})`);
      assert.equal(accentCount(svg), EXPECTED[family].accent[viewport], `${family} ${viewport} accent count (${snapshot})`);
      assert.equal(svg.match(/data-role="decorative-cover"/g)?.length, 1, 'one decorative wrapper');
      assert.doesNotMatch(svg, /<(text|tspan|image|use|style|script|foreignObject|linearGradient|radialGradient|pattern|mask|clipPath|filter|marker|symbol|a|rect|line|polyline|ellipse)\b/i, `${family} ${viewport} uses only plain shapes`);
      assert.doesNotMatch(svg, /font-|href|url\(|xlink|@import|data:|opacity|transform|<title|<desc/i, `${family} ${viewport} carries no text, reference or effect`);
      const used = [...new Set(colours(svg))];
      assert.ok(used.length <= 3, `${family} ${viewport} uses at most two greys and the accent`);
      const paletteValues = Object.values(PALETTE).map((v) => String(v).toLowerCase());
      for (const colour of used) assert.ok(paletteValues.includes(colour), `${colour} is a house palette colour`);
      const greys = used.filter((c) => c !== PALETTE.accent.toLowerCase());
      for (const grey of greys) assert.ok(grey.slice(1, 3) === grey.slice(3, 5) && grey.slice(3, 5) === grey.slice(5, 7), `${grey} is a neutral grey`);
      assert.ok(!used.includes(PALETTE.ink.toLowerCase()), 'ink is text-only, never a mark');
      assertInsideViewBox(svg, VIEWBOX[viewport], family === 'concentric' ? 16 : 0);
    }
  }
}

// ---------------------------------------------------------------------------
// determinism
for (const family of FAMILIES) {
  const first = ok(requestFor(family)).stdout;
  assert.equal(ok(requestFor(family)).stdout, first, `${family}: same request, same bytes`);
  const seen = new Set();
  for (const snapshot of ['d1', 'd2', 'd3', 'd4', 'd5']) seen.add(ok(requestFor(family, {}, snapshot)).response.variants.desktop);
  assert.equal(seen.size, 5, `${family}: different request hashes give different covers`);
}

// ---------------------------------------------------------------------------
// data-blind: only the hash and the motif matter
for (const family of FAMILIES) {
  const request = requestFor(family);
  const reference = ok(request).stdout;
  const noisy = structuredClone(request);
  noisy.spec = {
    ...noisy.spec,
    title: 'A completely different headline about something else',
    subject: 'Another subject entirely',
    intent: 'A different editorial intent with long explanatory text. '.repeat(8),
    alt: 'A different alternative text that is long enough to pass validation and says nothing about the picture.',
    style_direction: 'Bright, loud, maximalist, with golden gradients and a portrait of a head of state.',
    source_note: '另一条来源说明，内容完全不同。',
    credit: 'Someone else',
    claim_ids: Array.from({ length: 20 }, (_, i) => `claim-${i}`),
    evidence_refs: Array.from({ length: 40 }, (_, i) => `data/derived/ref-${i}.json`),
    constraints: ['No photorealistic reconstruction', `motif=${family}`, 'Use red sparingly'],
  };
  noisy.evidence = { ...noisy.evidence, claim_ids: noisy.spec.claim_ids, evidence_refs: noisy.spec.evidence_refs, source_note: noisy.spec.source_note };
  assert.equal(noisy.request_hash, request.request_hash, 'the hash is pinned');
  assert.equal(ok(noisy).stdout, reference, `${family}: every field except hash and motif is ignored`);

  const shapes = [
    {},
    { title: 'Plain headline', alt: 'A decorative geometric pattern used only as page decoration here.', claim_ids: Array.from({ length: 20 }, (_, i) => `claim-${i}`) },
    { subject: 'x'.repeat(900), evidence_refs: Array.from({ length: 40 }, (_, i) => `data/derived/ref-${i}.json`) },
    { source_note: '很长的来源说明。'.repeat(60), style_direction: 'y'.repeat(650), constraints: ['Keep it quiet', `motif=${family}`] },
  ];
  const hashes = new Set();
  for (const overrides of shapes) {
    const shaped = requestFor(family, { constraints: [`motif=${family}`], ...overrides });
    hashes.add(shaped.request_hash);
    const { response } = ok(shaped);
    assert.deepEqual(response.metadata.element_counts, EXPECTED[family].elements, `${family}: counts do not follow the request shape`);
  }
  assert.equal(hashes.size, shapes.length, 'the request shapes really do hash differently');
}

// ---------------------------------------------------------------------------
// refusals: distinct code, empty stdout, exactly one stderr line
function refused(label, code, request, options) {
  const proc = run(request, options);
  assert.equal(proc.status, code, `${label}: exit code (stderr: ${proc.stderr.trim()})`);
  assert.equal(proc.stdout, '', `${label}: nothing on stdout`);
  assert.match(proc.stderr, /^geometric-cover: [^\n]+\n$/, `${label}: one stderr line`);
}
const tamper = (family, mutate) => { const r = requestFor(family); mutate(r); return r; };
refused('origin_policy human_only', 2, requestFor('arcs', { origin_policy: 'human_only' }));
refused('origin_policy ai_disclosed', 2, requestFor('arcs', { origin_policy: 'ai_disclosed' }));
refused('policy block says otherwise', 2, tamper('arcs', (r) => { r.policy.origin_policy = 'ai_disclosed'; }));
refused('spec says otherwise', 2, tamper('arcs', (r) => { r.spec.origin_policy = 'ai_disclosed'; }));
const element = [{ id: 'flow', label: 'Flow', claim_ids: ['claim-1'] }];
refused('factual_elements in spec', 3, requestFor('arcs', { factual_elements: element }));
refused('factual_elements in evidence', 3, tamper('arcs', (r) => { r.evidence.factual_elements = element; }));
refused('digit in title (ascii)', 4, requestFor('arcs', { title: '2024 封面图案' }));
refused('digit in alt (ascii)', 4, requestFor('arcs', { alt: '装饰性封面图案，由 3 组几何图形组成，不表示任何数据。' }));
refused('digit in title (full-width)', 4, requestFor('arcs', { title: '封面图案２０２４' }));
refused('digit in alt (full-width)', 4, requestFor('arcs', { alt: '装饰性封面图案，由几何图形组成，不表示任何数据，共３组。' }));
refused('digit in alt (arabic-indic)', 4, requestFor('arcs', { alt: 'Decorative geometric cover with ٣ groups of shapes and no data at all.' }));
refused('percent in title (ascii)', 4, requestFor('arcs', { title: '封面%' }));
refused('percent in alt (full-width)', 4, requestFor('arcs', { alt: '装饰性封面图案，由几何图形组成，不表示任何数据，占比很高％。' }));
refused('percent in alt (small form)', 4, requestFor('arcs', { alt: '装饰性封面图案，由几何图形组成，不表示任何数据，占比很高﹪。' }));
refused('percent in alt (arabic)', 4, requestFor('arcs', { alt: 'Decorative geometric cover with a share of ٪ and no data at all here.' }));
refused('per-mille in alt', 4, requestFor('arcs', { alt: 'Decorative geometric cover with a share of ‰ and no data at all here.' }));
refused('unknown motif', 5, requestFor('arcs', { constraints: ['motif=flag'] }));
refused('uppercase motif', 5, requestFor('arcs', { constraints: ['motif=ARCS'] }));
refused('spaced motif token', 5, requestFor('arcs', { constraints: ['motif = arcs'] }));
// grid was removed from the closed set (a lattice of mixed filled shapes can read as a unit chart)
refused('removed motif: grid', 5, requestFor('arcs', { constraints: ['motif=grid'] }));
refused('two motifs in one constraint', 5, requestFor('arcs', { constraints: ['motif=arcs; motif=grid'] }));
refused('missing motif (other constraints)', 5, requestFor('arcs', { constraints: ['No photorealistic reconstruction'] }));
refused('missing motif (empty constraints)', 5, requestFor('arcs', { constraints: [] }));
refused('missing motif (no constraints key)', 5, tamper('arcs', (r) => { delete r.spec.constraints; }));
refused('two different motif tokens', 5, requestFor('arcs', { constraints: ['motif=arcs', 'motif=grid'] }));
refused('the same motif token twice', 5, requestFor('arcs', { constraints: ['motif=arcs', 'motif=arcs'] }));
refused('not JSON', 6, null, { raw: '{not json' });
refused('empty stdin', 6, null, { raw: '' });
refused('JSON array', 6, null, { raw: '[]' });
refused('wrong protocol', 6, tamper('arcs', (r) => { r.protocol = 'something.else.v2'; }));
refused('missing request_hash', 6, tamper('arcs', (r) => { delete r.request_hash; }));
refused('empty request_hash', 6, tamper('arcs', (r) => { r.request_hash = '  '; }));
refused('missing spec', 6, tamper('arcs', (r) => { delete r.spec; }));
// Precedence is documented: policy, then facts, then digits, then motif.
refused('everything wrong reports the policy first', 2, requestFor('arcs', { origin_policy: 'human_only', factual_elements: element, title: '2024', constraints: [] }));
refused('facts before digits', 3, requestFor('arcs', { factual_elements: element, title: '2024', constraints: [] }));
refused('digits before motif', 4, requestFor('arcs', { title: '2024', constraints: [] }));

// ---------------------------------------------------------------------------
// packaging: runtime/ is materialized flat, so viz.mjs sits beside the adapter
const scratch = mkdtempSync(path.join(os.tmpdir(), 'geometric-cover-'));
try {
  const flat = path.join(scratch, 'a', 'runtime');
  mkdirSync(flat, { recursive: true });
  copyFileSync(ADAPTER, path.join(flat, 'geometric_cover.mjs'));
  refused('palette module missing', 7, requestFor('arcs'), { adapter: path.join(flat, 'geometric_cover.mjs') });
  symlinkSync(path.join(ROOT, 'runtime/pi/viz.mjs'), path.join(flat, 'viz.mjs'));
  for (const family of FAMILIES) {
    assert.equal(ok(requestFor(family), { adapter: path.join(flat, 'geometric_cover.mjs') }).stdout, ok(requestFor(family)).stdout, `${family}: flat layout gives the same bytes`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// with the adapter variables unset, the existing illustration contract test still passes
const cleanEnv = { ...process.env };
delete cleanEnv.NEWSROOM_ILLUSTRATION_ADAPTER;
delete cleanEnv.NEWSROOM_ILLUSTRATION_ADAPTER_ARGS_JSON;
const existing = spawnSync(process.execPath, ['scripts/test_rich_illustration.mjs'], { cwd: ROOT, env: cleanEnv, encoding: 'utf8', timeout: 60000 });
assert.equal(existing.status, 0, `test_rich_illustration.mjs failed with the adapter unset: ${existing.stderr}`);
assert.match(existing.stdout, /rich illustration contract tests: PASS/);

const ms = (family) => `${family} ${Math.round(timings[family].reduce((a, b) => a + b, 0) / timings[family].length)}ms`;
console.log(`geometric cover adapter run time (informational): ${FAMILIES.map(ms).join(', ')}`);
console.log('geometric cover adapter tests: PASS');
