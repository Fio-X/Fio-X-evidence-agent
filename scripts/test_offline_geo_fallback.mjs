#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildEvidenceBoundModule } from '../runtime/pi/publication_binding.mjs';
import { renderPublication } from '../runtime/pi/publication.mjs';
import { hashRows } from '../runtime/pi/viz.mjs';

const rows = {
  geo: [{ iso_code: 'CHN', country: 'China', low_carbon_pct: 29.5, total_generation_twh: 9456 }],
  flow: [{ source: 'coal', target: 'fossil', value: 10 }],
  network: [{ source: 'China', target: 'carbon', similarity_score: 1 }],
};
const binding = (key, field_mapping) => ({
  kind: 'computation', ref: `computations/${key}.json`, result_hash: hashRows(rows[key]), field_mapping,
});
const base = {
  schema_version: '0.3.0', style_profile: 'japanese_editorial', title: 'Offline geo fallback', dek: 'Smoke test',
  reader_question: 'Does one renderer failure blank the page?', visual_thesis: 'It must not.',
  story_graph_ref: 'fixture/story.json', infographic_plan_ref: 'fixture/plan.json',
  delivery: { mode: 'html', packaging: 'archive', self_contained: true, breakpoints: [390, 768] },
  interaction: { allowed: ['select'], replay: [] },
};
const raw = [
  { id: 'geo', type: 'plotly', visual_type: 'geo_linked', title: 'Map', story_node_ids: ['geo'], claim_ids: ['geo'], explanatory_dimension: 'spatial', width: 'wide', accessibility: { summary: 'Map', long_description: 'Map' }, evidence_binding: binding('geo', { location_field: 'iso_code', country_field: 'country', value_field: 'low_carbon_pct', size_field: 'total_generation_twh' }), view_spec: {} },
  { id: 'flow', type: 'plotly', visual_type: 'sankey', title: 'Flow', story_node_ids: ['flow'], claim_ids: ['flow'], explanatory_dimension: 'flow', width: 'half', accessibility: { summary: 'Flow', long_description: 'Flow' }, evidence_binding: binding('flow', { source_field: 'source', target_field: 'target', value_field: 'value' }), view_spec: {} },
  { id: 'network', type: 'model', visual_type: 'network', title: 'Network', story_node_ids: ['network'], claim_ids: ['network'], explanatory_dimension: 'network', width: 'half', accessibility: { summary: 'Network', long_description: 'Network' }, evidence_binding: binding('network', { source_field: 'source', target_field: 'target', weight_field: 'similarity_score' }), view_spec: {} },
];
const modules = raw.map((module) => buildEvidenceBoundModule(module, rows[module.id === 'geo' ? 'geo' : module.id === 'flow' ? 'flow' : 'network']));
const rendered = renderPublication({ ...base, modules }, { includePlotly: true, includeD3: false });

const scripts = [];
let cursor = 0;
while ((cursor = rendered.html.indexOf('<script', cursor)) >= 0) {
  const start = rendered.html.indexOf('>', cursor) + 1;
  const end = rendered.html.indexOf('</script>', start);
  if (start <= 0 || end < 0) break;
  scripts.push(rendered.html.slice(start, end));
  cursor = end + 9;
}
assert.equal(scripts.length, 2);

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; this.listeners = {}; this._innerHTML = ''; }
  appendChild(child) { this.children.push(child); return child; }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }
  setAttribute() {}
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  getBoundingClientRect() { return { width: 900, height: 500, left: 0, top: 0 }; }
  getContext() { return new Proxy({}, { get: () => () => {} }); }
}
const ids = new Map();
const body = new Element('body');
const document = {
  body,
  createElement: (tag) => new Element(tag),
  getElementById: (id) => {
    if (!ids.has(id)) { const el = new Element(); el.id = id; ids.set(id, el); body.appendChild(el); }
    return ids.get(id);
  },
};
for (const id of ['geo', 'flow', 'network']) for (const prefix of ['chart-', 'fallback-', 'detail-', 'controls-']) document.getElementById(prefix + id);
const plotCalls = [];
const Plotly = {
  async newPlot(element, data) {
    plotCalls.push({ id: element.id, type: data?.[0]?.type });
    if (data?.[0]?.type === 'scattergeo') throw new Error('simulated offline topojson failure');
    return element;
  },
  restyle() {}, relayout() {},
};
const context = {
  document, Plotly, devicePixelRatio: 1, Map, Set, Math, Number, String, Array, Object, JSON, Error, console,
  setTimeout, clearTimeout, ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
};
context.window = context;
vm.createContext(context);
vm.runInContext(scripts[1], context, { timeout: 10000 });
await new Promise((resolve) => setTimeout(resolve, 20));

assert.equal(context.__ADN_READY, true);
assert.equal(body.dataset.publicationState, 'ready');
assert.deepEqual(plotCalls.map((call) => call.type), ['scattergeo', 'sankey']);
assert.match(ids.get('detail-geo').textContent, /Offline map fallback/);
assert.equal(ids.get('chart-network').children.length, 1);
console.log(JSON.stringify({ status: 'PASS', ready: context.__ADN_READY, plot_calls: plotCalls, geo_fallback: true, network_rendered: true }, null, 2));
