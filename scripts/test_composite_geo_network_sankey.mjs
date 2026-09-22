#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPublication, validatePublicationSpec } from '../runtime/pi/publication.mjs';

const OUT = path.join(os.tmpdir(), 'japanese-composite-demo');
fs.mkdirSync(OUT, { recursive: true });

// Capability fixture: values are drawn from the verified OWID energy run, while
// the small coordinate table is an explicit presentation fixture. This test
// exercises composition and layout, not a new published claim.
const bubbles = [
  { name: 'Paraguay', lon: -58.4, lat: -23.4, clean: 100, carbon: 24.5, size: 42 },
  { name: 'Norway', lon: 8.5, lat: 61.0, clean: 98.5, carbon: 30.5, size: 38 },
  { name: 'France', lon: 2.2, lat: 46.2, clean: 89.0, carbon: 53.3, size: 34 },
  { name: 'Denmark', lon: 9.5, lat: 56.0, clean: 88.0, carbon: 102.0, size: 31 },
  { name: 'China', lon: 104.2, lat: 35.9, clean: 29.5, carbon: 555.0, size: 58 },
  { name: 'Kazakhstan', lon: 67.3, lat: 48.0, clean: 14.0, carbon: 826.7, size: 28 },
];
const sourceLabels = ['Coal', 'Gas', 'Wind', 'Solar'];
const sourceValues = [10367.93, 6691.34, 2317.84, 1658.42];

const spec = {
  schema_version: '0.2.0',
  title: 'Energy transition, seen three ways',
  dek: 'A composed visual argument: place, flow and relationship share one restrained editorial system.',
  reader_question: 'Where does the energy transition move, and how do its parts connect?',
  visual_thesis: 'Geography shows the contrast, Sankey exposes the selected-source balance, and the network makes the relationships inspectable.',
  story_graph_ref: 'fixtures/japanese-composite/story.json',
  infographic_plan_ref: 'fixtures/japanese-composite/plan.json',
  style_profile: 'japanese_editorial',
  source_note: 'Capability fixture based on the OWID Energy dataset; values are selected 2023 fields and the coordinates are an explicit demo table.',
  delivery: { mode: 'html', self_contained: true, static_fallback: 'svg', breakpoints: [390, 768, 1024, 1440], max_initial_bytes: 8000000 },
  interaction: { allowed: ['hover', 'focus', 'select', 'linked_view'], replay: [] },
  modules: [
    {
      id: 'geo-bubbles', type: 'plotly', engine: 'plotly', visual_type: 'geo_linked',
      title: 'The geography of contrast',
      dek: 'Bubble area indicates selected-country scale; colour encodes clean-electricity share.',
      story_node_ids: ['place'], claim_ids: ['fixture-place'], explanatory_dimension: 'spatial', width: 'wide',
      spec: { visual_type: 'geo_linked', figure: { data: [{ type: 'scattergeo', lon: bubbles.map(d => d.lon), lat: bubbles.map(d => d.lat), text: bubbles.map(d => `${d.name} · ${d.clean}% clean`), mode: 'markers+text', textposition: 'top center', marker: { size: bubbles.map(d => d.size), color: bubbles.map(d => d.clean), cmin: 0, cmax: 100, colorscale: [[0, '#d5c7b8'], [0.55, '#6d8f88'], [1, '#b64032']], colorbar: { title: 'Clean %', thickness: 12 } } }], layout: { margin: { l: 8, r: 8, t: 20, b: 8 }, geo: { projection: { type: 'natural earth' }, showland: true, landcolor: '#e8e4da', showocean: true, oceancolor: '#e8eeee', showcountries: true, countrycolor: '#c7c0b5', coastlinecolor: '#aaa39a', lataxis: { showgrid: false }, lonaxis: { showgrid: false } } } } }
    },
    {
      id: 'energy-sankey', type: 'plotly', engine: 'plotly', visual_type: 'sankey',
      title: 'A selected-source energy balance',
      dek: 'Only the four named sources are shown, keeping the flow legible instead of pretending this is a complete system balance.',
      story_node_ids: ['flow'], claim_ids: ['fixture-flow'], explanatory_dimension: 'flow', width: 'half',
      spec: { visual_type: 'sankey', figure: { data: [{ type: 'sankey', arrangement: 'snap', node: { label: [...sourceLabels, 'Fossil', 'Renewable'], color: ['#4f5960', '#77848b', '#6d8f88', '#b64032', '#52585b', '#879f93'], pad: 18, thickness: 18 }, link: { source: [0, 1, 2, 3], target: [4, 4, 5, 5], value: sourceValues, color: ['rgba(79,89,96,.42)', 'rgba(119,132,139,.42)', 'rgba(109,143,136,.50)', 'rgba(182,64,50,.50)'] } }], layout: { margin: { l: 8, r: 8, t: 20, b: 8 }, font: { size: 11 } } } }
    },
    {
      id: 'relationship-network', type: 'model', engine: 'native_canvas', visual_type: 'network',
      title: 'The relationship layer',
      dek: 'A compact, deterministic network exposes the bridge between place, source and outcome; select a node to inspect its local role.',
      story_node_ids: ['network'], claim_ids: ['fixture-network'], explanatory_dimension: 'network', width: 'half',
      spec: {
        label_policy: 'key',
        nodes: [
          { id: 'place', label: 'Place', x: -1.0, y: 0.0, degree: 3, community: 1 },
          { id: 'clean', label: 'Clean share', x: 0.0, y: 0.8, degree: 3, community: 2 },
          { id: 'carbon', label: 'Carbon intensity', x: 1.0, y: 0.0, degree: 2, community: 3 },
          { id: 'flow', label: 'Selected flows', x: 0.0, y: -0.9, degree: 3, community: 4 },
          { id: 'wind', label: 'Wind', x: -0.5, y: -1.8, degree: 1, community: 4 },
          { id: 'solar', label: 'Solar', x: 0.5, y: -1.8, degree: 1, community: 4 },
        ],
        edges: [
          { source: 'place', target: 'clean' }, { source: 'place', target: 'carbon' }, { source: 'clean', target: 'carbon' },
          { source: 'clean', target: 'flow' }, { source: 'flow', target: 'wind' }, { source: 'flow', target: 'solar' },
        ],
        controls: [{ id: 'reset', label: 'Reset focus', action: 'reset', state: 'network' }],
      }
    },
  ],
};

const errors = validatePublicationSpec(spec);
if (errors.length) throw new Error(`fixture validation failed: ${errors.join(' | ')}`);
const rendered = renderPublication(spec, { includePlotly: true, includeD3: false });
fs.writeFileSync(path.join(OUT, 'index.html'), rendered.html);
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(rendered.manifest, null, 2)}\n`);
console.log(JSON.stringify({
  status: 'PASS',
  output: path.join(OUT, 'index.html'),
  style_profile: rendered.manifest.style_profile,
  modules: spec.modules.map(m => ({ id: m.id, visual_type: m.visual_type, dimension: m.explanatory_dimension })),
  self_contained: rendered.manifest.self_contained,
  bytes: rendered.manifest.initial_bytes,
  embedded_plotly: rendered.manifest.runtime_assets.plotly.embedded,
  layout_markers: ['asymmetric_editorial', '--section-rule', 'Hiragino Mincho ProN'].map(x => ({ marker: x, present: rendered.html.includes(x) })),
}, null, 2));
