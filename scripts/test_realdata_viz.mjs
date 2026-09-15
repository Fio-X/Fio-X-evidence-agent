#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'outputs', 'realdata');
await mkdir(OUT, { recursive: true });

function csv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const keys = head.split(',');
  return lines.map(line => {
    const vals = line.split(',');
    return Object.fromEntries(keys.map((k,i) => [k, i === 0 ? vals[i] : Number(vals[i])]));
  });
}
async function load(name) { return csv(await readFile(join(ROOT,'fixtures','realdata',name),'utf8')); }

const claim='claim-realdata-verified';
const context={verified_claim_ids:[claim]};
const cases=[];

const renew=await load('owid-renewables-2021-2025.csv');
const dumbbell={
 schema_version:'0.8.0', reader_task:'comparison', chart_type:'dumbbell',
 takeaway:'Among this selected group, Germany saw the largest increase in renewable electricity share from 2021 to 2025, while Canada edged down.',
 title:'Germany made the biggest renewable-power gain in this comparison',
 subtitle:'Share of electricity generation from renewables, selected countries, 2021 vs 2025',
 alt:'Dumbbell chart comparing renewable electricity shares in 2021 and 2025 for six countries. Germany rises from 40.17% to 59.09%; Canada falls from 66.74% to 63.90%.',
 source_note:'Our World in Data; Ember (2026) and other sources',
 note:'Values are percentage points of total electricity generation. Selected countries only.',
 claim_id:claim, sql:'fixture:owid-renewables-2021-2025', unit:'%', category_field:'country', start_field:'renewables_2021', end_field:'renewables_2025',
 start_label:'2021', end_label:'2025', highlight_values:['Germany','Canada'],
 annotations:[
  {type:'point',text:'+18.9 pp, the largest gain in this selected group',claim_id:claim,match_field:'country',match_value:'Germany'},
  {type:'point',text:'Canada was the only decline in this selected group',claim_id:claim,match_field:'country',match_value:'Canada'}
 ]
};
cases.push(['renewables-dumbbell',dumbbell,renew]);

const sr=await load('owid-solar-renewables-2025.csv');
const solarRows=[...sr].sort((a,b)=>b.solar_share-a.solar_share);
const bar={
 schema_version:'0.8.0',reader_task:'ranking',chart_type:'horizontal_bar',
 takeaway:'Luxembourg and Hungary had the highest solar shares among this selected European comparison in 2025.',
 title:'Solar supplied more than a quarter of electricity in Luxembourg and Hungary',
 subtitle:'Share of electricity generation from solar, selected European countries, 2025',
 alt:'Horizontal bar chart ranking eleven selected European countries by solar share of electricity in 2025, led by Luxembourg at 30.52% and Hungary at 27.29%.',
 source_note:'Our World in Data; Ember (2026) and other sources',
 note:'Selected countries shown; this is not a complete Europe ranking.',claim_id:claim,sql:'fixture:owid-solar-renewables-2025',unit:'%',category_field:'country',value_field:'solar_share',sort:'desc',highlight_values:['Luxembourg','Hungary'],annotations:[]
};
cases.push(['solar-ranking',bar,solarRows]);

const scatter={
 schema_version:'0.8.0',reader_task:'correlation',chart_type:'scatter',
 takeaway:'A high solar share does not by itself imply a high total renewable share; national generation mixes differ substantially.',
 title:'Solar-heavy grids still differ sharply in their overall renewable mix',
 subtitle:'Solar share versus total renewable share of electricity, selected European countries, 2025',
 alt:'Scatter plot of solar share versus total renewable electricity share for eleven selected European countries. Luxembourg combines high solar and high total renewable shares, while Hungary has high solar but a much lower total renewable share.',
 source_note:'Our World in Data; Ember (2026) and other sources',
 note:'Solar is a subset of renewables. Selected countries only.',claim_id:claim,sql:'fixture:owid-solar-renewables-2025',unit:'%',x_unit:'%',y_unit:'%',x_field:'solar_share',y_field:'renewables_share',label_field:'country',x_label:'Solar share',y_label:'All renewables',highlight_values:['Luxembourg','Hungary','Portugal'],annotations:[
  {type:'point',text:'High solar share, but a much lower total renewable share',claim_id:claim,match_field:'country',match_value:'Hungary'}
 ]
};
cases.push(['solar-vs-renewables-scatter',scatter,sr]);

const heatRows=sr.flatMap(r=>[
 {country:r.country,metric:'Solar',value:r.solar_share},
 {country:r.country,metric:'All renewables',value:r.renewables_share}
]);
const heat={
 schema_version:'0.8.0',reader_task:'distribution',chart_type:'heatmap',
 takeaway:'Countries with similar solar penetration can have very different overall renewable electricity shares.',
 title:'Solar is only one piece of Europe’s renewable-electricity mix',
 subtitle:'Solar and total renewable shares of electricity, selected European countries, 2025',
 alt:'Heatmap comparing solar and total renewable electricity shares for eleven selected European countries in 2025.',
 source_note:'Our World in Data; Ember (2026) and other sources',note:'Selected countries only; both metrics are shares of total electricity generation.',claim_id:claim,sql:'fixture:owid-solar-renewables-2025-long',unit:'%',x_field:'metric',y_field:'country',value_field:'value',annotations:[]
};
cases.push(['solar-renewables-heatmap',heat,heatRows]);

const wb=await load('worldbank-gdp-life-2024.csv');
const wbScatter={
 schema_version:'0.8.0',reader_task:'correlation',chart_type:'scatter',
 takeaway:'Within this selected 2024 sample, higher GDP per capita is associated with higher life expectancy, but gains flatten at high income levels.',
 title:'Higher income coincides with longer lives, with diminishing separation at the top',
 subtitle:'GDP per capita and life expectancy, selected economies, 2024',
 alt:'Scatter plot comparing GDP per capita in current US dollars with life expectancy in years for twelve selected economies in 2024. India and Indonesia are lower-income with lower life expectancy; Japan and Italy have among the highest life expectancy.',
 source_note:'World Bank, World Development Indicators',note:'GDP per capita uses current US dollars. Selected economies only; association is descriptive and not causal.',claim_id:claim,sql:'fixture:worldbank-gdp-life-2024',unit:'years',x_unit:'$',y_unit:'years',x_field:'gdp_per_capita_usd',y_field:'life_expectancy_years',label_field:'country',x_scale:'log',x_label:'GDP per capita',y_label:'Life expectancy',highlight_values:['India','China','United States','Japan'],annotations:[
  {type:'point',text:'Japan combines high life expectancy with mid-range income in this selected sample',claim_id:claim,match_field:'country',match_value:'Japan'}
 ]
};
// World Bank source row labels use United States only in broader page; use Ireland as top-income highlight to keep fixture self-contained.
wbScatter.highlight_values=['India','China','Japan','Ireland'];
cases.push(['gdp-life-scatter',wbScatter,wb]);

const summary=[];
for (const [name,spec,rows] of cases) {
  const lint=lintVizSpec(spec,rows,context);
  if (!lint.passed) throw new Error(`${name} lint failed: ${lint.blockers.join(' | ')}`);
  const bundle=renderVizBundle(spec,rows);
  const desktopCritic=critiqueViz(spec,rows,lint,bundle.desktop);
  const mobileCritic=critiqueViz(spec,rows,lint,bundle.mobile);
  await writeFile(join(OUT,`${name}.svg`),bundle.desktop,'utf8');
  await writeFile(join(OUT,`${name}.mobile.svg`),bundle.mobile,'utf8');
  await writeFile(join(OUT,`${name}.json`),JSON.stringify({spec,lint,desktopCritic,mobileCritic},null,2)+'\n','utf8');
  summary.push({name,rows:rows.length,lintWarnings:lint.warnings,desktopScore:desktopCritic.score,mobileScore:mobileCritic.score,passed:desktopCritic.passed&&mobileCritic.passed});
}
await writeFile(join(OUT,'summary.json'),JSON.stringify(summary,null,2)+'\n','utf8');
console.table(summary.map(x=>({name:x.name,rows:x.rows,desktop:x.desktopScore,mobile:x.mobileScore,passed:x.passed,warnings:x.lintWarnings.length})));
