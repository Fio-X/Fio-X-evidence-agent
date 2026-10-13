#!/usr/bin/env node
// K259: a non-compact chart whose module has no label (or is hero) must not be drawn below scale 1. moduleHeight reserved 12px above/below such a
// chart while embedVisual spends topPad + 6 (20/32/30 + 6), so the box came out 14px short and the meet scale fell below 1 (state-tile map:
// box 949 for a 963px chart, 12px text drawn at 11.83px, 111 font_below_floor). The slot must hold the chart at scale >= 1 and render QA must pass.
// Run: node scripts/test_unlabeled_chart_scale.mjs
import assert from 'node:assert/strict';
import { composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';
import { measurePage, embeddedChart, nativeInk } from './lib_page_geometry.mjs';

// The state-tile map of the 10-12 stand-in run is 1248x963 with 12px text; the others cover ordinary heights.
const chart = (w, h) => {
  const texts = Array.from({ length: 12 }, (_, i) => `<text x="${20 + i * 90}" y="${40 + (i % 5) * 150}" font-size="12" fill="#333333">Label ${i}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img"><rect x="0" y="0" width="${w}" height="${h}" fill="#f1ecdf"/>${texts}<rect x="20" y="${h - 60}" width="${w - 40}" height="40" fill="#3a5f7e"/></svg>`;
};
const base = {
  schema_version: '1.0.0', kicker: 'DATA', title: 'A tall chart keeps its text size', dek: 'The slot for a chart without a label holds the chart at its native size.',
  alt: 'A synthetic page with one full-width chart.',
};
let checks = 0;
const cases = [
  { name: 'unlabeled primary, tile-map size', w: 1248, h: 963, mod: {} },
  { name: 'unlabeled primary, ordinary', w: 1248, h: 700, mod: {} },
  { name: 'labeled primary', w: 1248, h: 963, mod: { label: 'The map' } },
  { name: 'unlabeled hero', w: 1248, h: 963, mod: { emphasis: 'hero' } },
  { name: 'labeled hero', w: 1248, h: 963, mod: { emphasis: 'hero', label: 'The map' } },
];
for (const c of cases) {
  const svg = chart(c.w, c.h);
  const assets = { 'visualizations/c.json': { desktopSvg: svg, manifest: { chart_type: 'tile_map' } } };
  const spec = { ...base, modules: [
    { id: 'section-1', type: 'section_header', span: 'full', eyebrow: 'Map', heading: 'One chart carries the page', deck: 'Its slot holds it at native size.' },
    { id: 'm', type: 'visual', span: 'full', manifest_ref: 'visualizations/c.json', emphasis: 'primary', ...c.mod },
    { id: 'text', type: 'text', span: 'two_thirds', label: 'Note', heading: 'Reading it', body: 'A short note under the chart.', claim_ids: ['claim-k259'] },
  ] };
  const bundle = composeInfographicBundle(spec, assets, { mobilePages: false });
  const v = embeddedChart(measurePage(bundle.desktop.svg), 'm');
  const n = nativeInk(svg);
  assert.ok(v.scale >= 1 - 0.001, `${c.name}: chart drawn at scale ${v.scale}, below 1 (box height ${v.h} for a ${n.height ?? c.h}px chart)`);
  const qa = runRenderQa({ desktop: bundle.desktop.svg });
  const floor = (qa.viewports.desktop.geometry?.failures ?? []).filter((f) => f.rule === 'font_below_floor');
  assert.equal(floor.length, 0, `${c.name}: ${floor.length} font_below_floor, first: ${floor[0]?.message}`);
  checks += 2;
  console.log(`PASS ${c.name}: scale=${v.scale.toFixed(4)} box h=${v.h}`);
}
console.log(`unlabeled chart scale PASS checks=${checks}`);
