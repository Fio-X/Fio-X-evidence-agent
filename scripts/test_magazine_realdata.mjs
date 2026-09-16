#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { lintInfographicSpec, composeInfographicBundle, critiqueInfographic } from '../runtime/pi/infographic.mjs';
import { lintExplanatorySpec, renderExplanatoryBundle, critiqueExplanatory } from '../runtime/pi/explanatory.mjs';

function csv(text){
  const [head,...lines]=text.trim().split(/\r?\n/); const keys=head.split(',');
  return lines.map(line=>{const vals=line.split(',');return Object.fromEntries(keys.map((k,i)=>[k,/^-?\d+(?:\.\d+)?$/.test(vals[i])?Number(vals[i]):vals[i]]));});
}
const flowRows=csv(await readFile(new URL('../fixtures/realdata/eia-us-energy-flow-2024.csv',import.meta.url),'utf8'));
const importRows=csv(await readFile(new URL('../fixtures/v09-realdata/eia-us-crude-imports-2024.csv',import.meta.url),'utf8'));
const sourceRows=flowRows.filter(r=>r.target==='U.S. primary energy').map(r=>({source:r.source,value:r.quadrillion_btu})).sort((a,b)=>b.value-a.value);
const total=sourceRows.reduce((s,r)=>s+r.value,0);
const fossilTop=sourceRows.filter(r=>['Petroleum','Natural gas'].includes(r.source)).reduce((s,r)=>s+r.value,0);
const fossilShare=fossilTop/total*100;
const losses=flowRows.find(r=>r.target==='Electrical system energy losses')?.quadrillion_btu;
assert.ok(Math.abs(total-94.2)<1e-9);
assert.ok(Math.abs(fossilTop-69.5)<1e-9);
assert.ok(Math.abs(losses-19.3)<1e-9);

const claim='claim-eia-magazine-2024';
const context={verified_claim_ids:[claim]};
function makeAsset(ref,spec,rows){
  const lint=lintVizSpec(spec,rows,context); assert.equal(lint.passed,true,`${ref}: ${lint.blockers.join(' | ')}`);
  const bundle=renderVizBundle(spec,rows);
  const desktop=critiqueViz(spec,rows,lint,bundle.desktop), mobile=critiqueViz(spec,rows,lint,bundle.mobile);
  assert.equal(desktop.passed,true,JSON.stringify(desktop)); assert.equal(mobile.passed,true,JSON.stringify(mobile));
  return {desktopSvg:bundle.desktop,mobileSvg:bundle.mobile,manifest:{claim_id:claim,source_note:spec.source_note,chart_type:spec.chart_type,alt:spec.alt,data_hash:lint.data_hash},critic:{passed:true,score:Math.min(desktop.score,mobile.score)},spec,lint};
}

const barSpec={schema_version:'0.9.0',reader_task:'ranking',takeaway:'Petroleum and natural gas dominated U.S. primary energy consumption in 2024.',chart_type:'horizontal_bar',title:'Oil and gas still dominate the starting mix',subtitle:'U.S. primary energy consumption by source, 2024',alt:'Horizontal bars show petroleum at 35.3 quadrillion Btu and natural gas at 34.2, well ahead of renewables, nuclear and coal.',source_note:'U.S. Energy Information Administration, Monthly Energy Review, 2024 energy flow',note:'Primary energy consumption totals 94.2 quadrillion Btu.',claim_id:claim,sql:'SELECT source, quadrillion_btu AS value FROM eia_flow WHERE target = \'U.S. primary energy\'',unit:'quadrillion Btu',category_field:'source',value_field:'value',sort:'desc',highlight_values:['Petroleum','Natural gas'],annotations:[]};
const flowSpec={schema_version:'0.9.0',reader_task:'flow',visual_family:'flow',data_topology:'flow_edges',complexity_budget:'medium',chart_type:'sankey',flow_conservation:'strict',flow_tolerance:0.001,takeaway:'U.S. primary energy totaled 94.2 quadrillion Btu in 2024, with 19.3 represented as electrical-system energy losses.',title:'Follow 94.2 quads from source to use',subtitle:'Primary energy, end-use sectors and electrical-system losses, 2024',alt:'A Sankey diagram shows five primary energy sources flowing into U.S. primary energy, then to end-use sectors and electrical-system energy losses.',source_note:'U.S. Energy Information Administration, Monthly Energy Review, 2024 energy flow',note:'Published aggregate source, sector and loss totals; the diagram does not imply source-specific allocation to each end-use sector.',claim_id:claim,sql:'SELECT source,target,quadrillion_btu FROM eia_flow',unit:'quadrillion Btu',source_field:'source',target_field:'target',value_field:'quadrillion_btu',highlight_values:['Electrical system energy losses'],annotations:[]};
const geoSpec={schema_version:'0.9.0',reader_task:'spatial',visual_family:'spatial',data_topology:'geo_edges',complexity_budget:'medium',chart_type:'geo_flow_map',takeaway:'Canada dominated selected U.S. crude-oil import flows in 2024.',title:'The oil system also reaches far beyond U.S. borders',subtitle:'Selected crude-oil import origins, average thousand barrels per day, 2024',alt:'A schematic geographic flow map shows selected countries supplying crude oil to the United States, with Canada by far the thickest route.',source_note:'U.S. Energy Information Administration, Petroleum & Other Liquids, 2024 monthly crude-oil imports',note:'Country coordinates are representative; curves show country-to-country relationships, not physical pipelines or tanker routes.',claim_id:claim,sql:'SELECT * FROM eia_imports',unit:'thousand b/d',source_field:'country',target_field:'target',source_lat_field:'source_lat',source_lon_field:'source_lon',target_lat_field:'target_lat',target_lon_field:'target_lon',value_field:'thousand_bpd',highlight_values:['Canada'],annotations:[]};

const explainerSpec={
  schema_version:'0.1.0',view:'cutaway',not_to_scale:true,title:'Four layers of the energy balance',subject:'U.S. energy accounting',
  subtitle:'A schematic reading aid for the EIA flow balance, not an engineering diagram.',
  alt:'A schematic cutaway labels primary supply, conversion, end-use demand and electrical-system losses as conceptual layers of U.S. energy accounting.',
  source_note:'U.S. Energy Information Administration, 2024 energy-flow accounting',
  parts:[
    {id:'primary',label:'Primary supply',detail:`${total.toFixed(1)} quads enter the balance`,weight:1.2,claim_ids:[claim]},
    {id:'conversion',label:'Conversion',detail:'Electricity generation changes the form of part of the energy supply',weight:1,claim_ids:[claim]},
    {id:'end-use',label:'End-use sectors',detail:'Transportation, industrial, residential and commercial demand',weight:1.2,claim_ids:[claim]},
    {id:'losses',label:'Electrical-system losses',detail:`${losses.toFixed(1)} quads in the published balance`,weight:.7,claim_ids:[claim]},
  ],relationships:[]
};
const explainerLint=lintExplanatorySpec(explainerSpec,context);assert.equal(explainerLint.passed,true,explainerLint.blockers.join(' | '));
const explainerBundle=renderExplanatoryBundle(explainerSpec);const explainerCritic=critiqueExplanatory(explainerSpec,explainerBundle);assert.equal(explainerCritic.passed,true,JSON.stringify(explainerCritic));
const assets={
  'visualizations/eia-source-mix.json':makeAsset('source mix',barSpec,sourceRows),
  'visualizations/eia-energy-flow.json':makeAsset('energy flow',flowSpec,flowRows),
  'visualizations/eia-crude-map.json':makeAsset('crude map',geoSpec,importRows),
  'visualizations/illustrations/eia-energy-balance.json':{desktopSvg:explainerBundle.desktop,mobileSvg:explainerBundle.mobile,manifest:{view:explainerSpec.view,source_note:explainerSpec.source_note,claim_ids:[claim],alt:explainerSpec.alt},critic:explainerCritic},
};

const spec={
  schema_version:'1.1.0',kicker:'ENERGY / SYSTEMS',layout:'feature',complexity_budget:'medium',quality_target:'award',
  intent:'Explain the structure of the U.S. energy system in one magazine feature, moving from national scale to energy losses and then to international crude supply.',
  primary_message:'The U.S. energy system is still dominated by petroleum and natural gas, while electrical-system losses and imported crude reveal important hidden structure.',
  story_arc:'system',audience:'informed',
  title:'The hidden shape of America’s energy machine',
  dek:`The United States consumed 94.2 quadrillion Btu of primary energy in 2024. Petroleum and natural gas supplied ${fossilTop.toFixed(1)} quads, nearly three quarters of the total. Follow the system from source mix to end use, losses and imported crude.`,
  alt:'A magazine-style infographic about the U.S. energy system in 2024, combining hero statistics, a primary-energy source ranking, a Sankey flow diagram, a geographic crude-import flow map and explanatory text.',
  byline:'Agentic Data Newsroom',date_label:'2024 energy system · EIA data',source_note:'U.S. Energy Information Administration',
  modules:[
    {id:'opening',type:'section_header',span:'full',eyebrow:'The starting point',heading:'Two fuels still set the scale',deck:'Petroleum and natural gas supplied most primary energy before electricity losses and end-use demand reshaped the flow.',story_role:'context',priority:2,emphasis:'secondary'},
    {id:'total-energy',type:'hero_stat',span:'third',tone:'accent',value:total.toFixed(1),unit:'quads',label:'Total U.S. primary energy consumption in 2024',detail:'Quadrillion British thermal units',claim_id:claim,story_role:'hook',priority:1,emphasis:'primary'},
    {id:'source-mix',type:'visual',span:'two_thirds',label:'Source mix',manifest_ref:'visualizations/eia-source-mix.json',story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'fossil-share',type:'pull_quote',span:'half',label:'The dominant pair',text:`Petroleum and natural gas together supplied ${fossilTop.toFixed(1)} quads, about ${fossilShare.toFixed(0)}% of the 2024 primary-energy total.`,attribution:'Calculated from EIA 2024 energy-flow totals',claim_ids:[claim],story_role:'turn',priority:3,emphasis:'secondary'},
    {id:'losses',type:'hero_stat',span:'half',tone:'dark',value:losses.toFixed(1),unit:'quads',label:'Electrical-system energy losses in the published flow balance',detail:`About ${(losses/total*100).toFixed(0)}% of primary energy`,claim_id:claim,story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'system-flow',type:'visual',span:'full',label:'Follow the flow',manifest_ref:'visualizations/eia-energy-flow.json',story_role:'evidence',priority:1,emphasis:'hero'},
    {id:'balance-explainer',type:'illustration',span:'full',label:'How to read the balance',asset_ref:'visualizations/illustrations/eia-energy-balance.json',alt:explainerSpec.alt,credit:'Semantic schematic based on U.S. Energy Information Administration energy-flow accounting',claim_ids:[claim],story_role:'explanation',priority:2,emphasis:'primary'},
    {id:'imports-section',type:'section_header',span:'full',eyebrow:'The geography behind the system',heading:'Domestic consumption begins with international flows',deck:'Crude imports reveal another layer of dependence that the national energy-flow diagram cannot show on its own.',story_role:'context',priority:3,emphasis:'secondary'},
    {id:'crude-map',type:'visual',span:'full',label:'Selected crude import origins',manifest_ref:'visualizations/eia-crude-map.json',story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'reading-note',type:'text',span:'full',label:'How to read this feature',heading:'One page, three different questions',body:'The source ranking answers what enters the energy system. The Sankey explains how aggregate energy moves toward end use and electrical-system losses. The map adds geography for selected crude imports. Each module retains its own verified claim, data hash and source metadata even after the composer combines them into one editorial page.',claim_ids:[claim],story_role:'resolution',priority:3,emphasis:'support'},
  ],
};

const lint=lintInfographicSpec(spec,assets,context);assert.equal(lint.passed,true,lint.blockers.join(' | '));
const bundle=composeInfographicBundle(spec,assets);const critic=critiqueInfographic(spec,bundle);assert.equal(critic.passed,true,JSON.stringify(critic));
await mkdir(new URL('../outputs/infographic/',import.meta.url),{recursive:true});
await writeFile(new URL('../outputs/infographic/eia-us-energy-feature-2024.svg',import.meta.url),bundle.desktop.svg);
await writeFile(new URL('../outputs/infographic/eia-us-energy-feature-2024.mobile.svg',import.meta.url),bundle.mobile.svg);
await writeFile(new URL('../outputs/infographic/eia-us-energy-feature-2024.json',import.meta.url),JSON.stringify({spec,lint,critic,metrics:{total_quads:total,petroleum_plus_gas_quads:fossilTop,petroleum_plus_gas_share_pct:fossilShare,electrical_losses_quads:losses},layout:{strategy:bundle.desktop.layout_strategy,candidates:bundle.desktop.candidate_scores}},null,2)+'\n');
console.log('magazine real-data feature: PASS');
console.log(`total=${total.toFixed(1)} quads oil+gas=${fossilTop.toFixed(1)} (${fossilShare.toFixed(1)}%) losses=${losses.toFixed(1)} quads`);
console.log(`page desktop=${bundle.desktop.width}x${bundle.desktop.height.toFixed(0)} mobile=${bundle.mobile.width}x${bundle.mobile.height.toFixed(0)} critic=${critic.score} strategy=${bundle.desktop.layout_strategy}`);
console.log(`rubric=${JSON.stringify(critic.rubric)}`);
