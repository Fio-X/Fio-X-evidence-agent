#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle, critiqueInfographic } from '../runtime/pi/infographic.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'outputs', 'nasa-gistemp-realdata');
await mkdir(OUT, { recursive: true });

function csv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const keys = head.split(',');
  return lines.map(line => {
    const vals = line.split(',');
    return Object.fromEntries(keys.map((k, i) => {
      const raw = vals[i];
      const num = Number(raw);
      return [k, raw !== '' && Number.isFinite(num) ? num : raw];
    }));
  });
}
const annual = csv(await readFile(join(ROOT, 'fixtures', 'realdata', 'nasa-gistemp-1980-2025.csv'), 'utf8'));
const monthly = csv(await readFile(join(ROOT, 'fixtures', 'realdata', 'nasa-gistemp-monthly-2023-2025.csv'), 'utf8'));
const claim = 'claim-nasa-gistemp-2025';
const context = { verified_claim_ids: [claim] };
const source = 'NASA GISS Surface Temperature Analysis v4 (GISTEMP); global land-ocean temperature index';

const lineSpec = {
  schema_version: '0.9.0', reader_task: 'change', chart_type: 'line',
  takeaway: 'Global temperature anomalies moved from +0.26°C in 1980 to +1.19°C in 2025, with the highest annual value in this series in 2024.',
  title: 'The warming signal is now measured in whole degrees',
  subtitle: 'Global land-ocean temperature anomaly relative to the 1951–1980 mean, 1980–2025',
  alt: 'Line chart showing NASA global temperature anomaly rising from 0.26 degrees Celsius in 1980 to 1.19 degrees in 2025, peaking at 1.29 degrees in 2024.',
  source_note: source,
  note: 'Annual GISTEMP values. NASA table values divided by 100 to convert hundredths of a degree Celsius to °C.',
  claim_id: claim, sql: 'fixture:nasa-gistemp-1980-2025', unit: '°C', x_field: 'year', value_field: 'anomaly_c',
  highlight_values: ['2024', '2025'], annotations: [
    { type: 'point', text: '2024: +1.29°C, highest annual value in the series', claim_id: claim, match_field: 'year', match_value: 2024 },
    { type: 'point', text: '2025: +1.19°C', claim_id: claim, match_field: 'year', match_value: 2025 }
  ]
};

const hottest = [...annual].sort((a,b)=>b.anomaly_c-a.anomaly_c).slice(0,10).map(r=>({year:String(r.year), anomaly_c:r.anomaly_c}));
const rankSpec = {
  schema_version: '0.9.0', reader_task: 'ranking', chart_type: 'horizontal_bar',
  takeaway: 'Every one of the ten warmest years in the 1980–2025 slice occurred from 2015 onward.',
  title: 'Recent years dominate the top of the temperature ranking',
  subtitle: 'Ten highest annual anomalies in the NASA GISTEMP 1980–2025 slice',
  alt: 'Horizontal bar chart ranking the ten largest annual global temperature anomalies between 1980 and 2025. 2024 ranks first at 1.29 degrees Celsius, followed by 2025 at 1.19 and 2023 at 1.17.',
  source_note: source, note: 'Ranking is limited to the 1980–2025 slice used in this visual test.',
  claim_id: claim, sql: 'fixture:nasa-gistemp-1980-2025 top 10', unit: '°C', category_field: 'year', value_field: 'anomaly_c', sort: 'desc',
  highlight_values: ['2024', '2025', '2023'], annotations: []
};

const heatSpec = {
  schema_version: '0.9.0', reader_task: 'distribution', chart_type: 'heatmap',
  takeaway: 'Monthly anomalies stayed above +0.88°C throughout 2023–2025, with the largest monthly value in this slice in September 2023.',
  title: 'The recent heat is persistent across the calendar',
  subtitle: 'Monthly global temperature anomaly, 2023–2025, °C above the 1951–1980 mean',
  alt: 'Heatmap with months from January to December and rows for 2023, 2024 and 2025. All cells are positive; September 2023 is the largest value at 1.48 degrees Celsius.',
  source_note: source, note: 'Monthly GISTEMP global means; values converted from hundredths of a degree Celsius.',
  claim_id: claim, sql: 'fixture:nasa-gistemp-monthly-2023-2025', unit: '°C', x_field: 'month', y_field: 'year', value_field: 'anomaly_c',
  annotations: []
};

const processRows = [
  {source:'Weather stations',target:'GISTEMP analysis',edge:'land air temperature'},
  {source:'Ships & buoys',target:'GISTEMP analysis',edge:'sea surface temperature'},
  {source:'Antarctic stations',target:'GISTEMP analysis',edge:'polar observations'},
  {source:'GISTEMP analysis',target:'Global anomaly',edge:'adjusted global estimate'}
];
const processSpec = {
  schema_version:'0.9.0', reader_task:'process', visual_family:'explanatory', data_topology:'process_graph', complexity_budget:'medium', chart_type:'process_schematic',
  takeaway:'NASA combines land, ocean and Antarctic observations in a globally adjusted temperature analysis.',
  title:'The headline number comes from a global observation system',
  subtitle:'Simplified provenance path described by NASA for the GISTEMP analysis',
  alt:'Process schematic showing weather-station, ship and buoy, and Antarctic observations feeding the GISTEMP analysis, which produces a global temperature anomaly.',
  source_note:'NASA, “NASA Releases Global Temperature Data,” Jan. 14, 2026; NASA GISS GISTEMP v4',
  note:'Editorial schematic of source categories; it does not represent every processing step in GISTEMP.',
  claim_id:claim, sql:'source-description:nasa-gistemp-method', unit:'stages', source_field:'source', target_field:'target', edge_label_field:'edge',
  highlight_values:['GISTEMP analysis'], annotations:[]
};

const visualCases = [
  ['warming-line', lineSpec, annual],
  ['hottest-ranking', rankSpec, hottest],
  ['monthly-heatmap', heatSpec, monthly],
  ['gistemp-process', processSpec, processRows]
];
const assets = {};
const results = [];
for (const [name, spec, rows] of visualCases) {
  const lint = lintVizSpec(spec, rows, context);
  assert.equal(lint.passed, true, `${name}: ${lint.blockers.join(' | ')}`);
  const bundle = renderVizBundle(spec, rows);
  if (name === 'monthly-heatmap') {
    assert.match(bundle.desktop, /data-role="heatmap-legend"/);
    assert.match(bundle.mobile, /data-role="heatmap-legend"/);
    assert.match(bundle.mobile, />0\.88 °C<|>0\.88°C</, 'mobile heatmap must retain exact cell values when cells are wide enough');
  }
  if (name === 'gistemp-process') {
    assert.ok((bundle.mobile.match(/data-role="process-edge-label"/g) ?? []).length >= 8, 'mobile process labels should wrap rather than truncate');
    assert.doesNotMatch(bundle.mobile, /data-role="process-edge-label"[^>]*>[^<]*…/, 'process edge labels must not use ellipsis for this fixture');
  }
  if (name === 'warming-line') {
    assert.match(bundle.mobile, /data-role="annotation"[^>]*text-anchor="end"[^>]*><tspan[^>]*>2024:/, 'right-edge annotation should flip left on mobile');
  }
  const desktopCritic = critiqueViz(spec, rows, lint, bundle.desktop);
  const mobileCritic = critiqueViz(spec, rows, lint, bundle.mobile);
  await writeFile(join(OUT, `${name}.svg`), bundle.desktop, 'utf8');
  await writeFile(join(OUT, `${name}.mobile.svg`), bundle.mobile, 'utf8');
  await writeFile(join(OUT, `${name}.json`), JSON.stringify({spec, rows, lint, desktopCritic, mobileCritic}, null, 2)+'\n');
  assets[`visualizations/${name}.json`] = {
    desktopSvg: bundle.desktop, mobileSvg: bundle.mobile,
    manifest: { claim_id: claim, source_note: spec.source_note, chart_type: spec.chart_type, alt: spec.alt },
    critic: { passed: desktopCritic.passed && mobileCritic.passed, score: Math.min(desktopCritic.score, mobileCritic.score) }
  };
  results.push({name,rows:rows.length,desktop:desktopCritic.score,mobile:mobileCritic.score,passed:desktopCritic.passed&&mobileCritic.passed,warnings:lint.warnings});
}

const pageSpec = {
  schema_version:'1.2.0', competition_profile:'oja2026_visual',
  kicker:'CLIMATE / DATA FEATURE',
  title:'The heat stayed near record territory',
  dek:'NASA’s global temperature record shows how sharply the climate baseline has shifted: 2024 reached +1.29°C above the 1951–1980 mean, and 2025 remained at +1.19°C.',
  alt:'A magazine-style climate data feature combining a long-run temperature line, a ranking of the warmest recent years, a monthly heatmap and a schematic of NASA’s observation system.',
  byline:'Agentic Data Newsroom', date_label:'Real-data visual QA', layout:'feature', complexity_budget:'high',
  source_note:'NASA GISS Surface Temperature Analysis v4; NASA Global Temperature release, 2026',
  intent:'Show both the long-run rise and the persistence of recent global heat while making the measurement provenance visible.',
  primary_message:'Recent global temperatures sit far above the late-20th-century range, and the strongest values cluster in the past decade.',
  story_arc:'explain', audience:'general', quality_target:'award',
  mobile_module_order:['stat-2025','warming-line','hottest-ranking','section-months','monthly-heatmap','gistemp-process','context'],
  modules:[
    {id:'stat-2025',type:'hero_stat',span:'third',tone:'accent',value:'+1.19',unit:'°C',label:'2025 global annual anomaly above the 1951–1980 mean',detail:'NASA GISTEMP v4',claim_id:claim,story_role:'hook',priority:1,emphasis:'primary'},
    {id:'warming-line',type:'visual',span:'two_thirds',label:'The long signal',manifest_ref:'visualizations/warming-line.json',story_role:'evidence',priority:1,emphasis:'hero'},
    {id:'hottest-ranking',type:'visual',span:'full',label:'The recent cluster',manifest_ref:'visualizations/hottest-ranking.json',story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'section-months',type:'section_header',span:'full',eyebrow:'Inside the recent years',heading:'The warmth persists month after month',deck:'A monthly view keeps the annual average from hiding how consistently elevated the recent baseline has become.',story_role:'turn',priority:2,emphasis:'secondary'},
    {id:'monthly-heatmap',type:'visual',span:'two_thirds',label:'Monthly persistence',manifest_ref:'visualizations/monthly-heatmap.json',story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'gistemp-process',type:'visual',span:'third',label:'How the number is built',manifest_ref:'visualizations/gistemp-process.json',story_role:'context',priority:3,emphasis:'secondary'},
    {id:'context',type:'text',span:'full',label:'Reading the record',heading:'An anomaly is a comparison with a fixed climate baseline',body:'NASA reports departures from the 1951–1980 average rather than absolute global temperature. The same reference period makes years directly comparable. The page uses the complete 1980–2025 annual slice and the complete monthly values for 2023–2025 from the GISTEMP table; 2026 is excluded because the annual value is still incomplete.',claim_ids:[claim],story_role:'resolution',priority:3,emphasis:'secondary'}
  ]
};

assert.deepEqual(validateInfographicSpec(pageSpec), []);
const pageLint = lintInfographicSpec(pageSpec, assets, context);
assert.equal(pageLint.passed, true, pageLint.blockers.join(' | '));
const pageBundle = composeInfographicBundle(pageSpec, assets);
const pageCritic = critiqueInfographic(pageSpec, pageBundle);
await writeFile(join(OUT, 'nasa-gistemp-feature.svg'), pageBundle.desktop.svg, 'utf8');
await writeFile(join(OUT, 'nasa-gistemp-feature.mobile.svg'), pageBundle.mobile.svg, 'utf8');
await writeFile(join(OUT, 'nasa-gistemp-feature.json'), JSON.stringify({pageSpec,pageLint,pageCritic,layout:{desktop:pageBundle.desktop,mobile:pageBundle.mobile}}, null, 2)+'\n');
await writeFile(join(OUT, 'summary.json'), JSON.stringify({visuals:results,page:{critic:pageCritic,desktopStrategy:pageBundle.desktop.layout_strategy,desktopHeight:pageBundle.desktop.height,mobileHeight:pageBundle.mobile.height}}, null, 2)+'\n');
console.table(results.map(({name,rows,desktop,mobile,passed,warnings})=>({name,rows,desktop,mobile,passed,warnings:warnings.length})));
console.log(`page critic=${pageCritic.score}/100 passed=${pageCritic.passed} desktopStrategy=${pageBundle.desktop.layout_strategy}`);
console.log(`page size desktop=${pageBundle.desktop.width}x${pageBundle.desktop.height} mobile=${pageBundle.mobile.width}x${pageBundle.mobile.height}`);
