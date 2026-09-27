#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { assessStoryGraph } from '../runtime/pi/story_graph.mjs';
import { evaluateVisualSemantics } from '../runtime/visual/editorial_semantics.mjs';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { lintExplanatorySpec, renderExplanatoryBundle, critiqueExplanatory } from '../runtime/pi/explanatory.mjs';
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle, critiqueInfographic } from '../runtime/pi/infographic.mjs';

const claims={acreage:'claim-acreage',rain:'claim-rain',lps:'claim-lps',spatial:'claim-spatial',mechanism:'claim-mechanism',yield:'claim-yield-risk',price:'claim-price-risk'};
const verified=Object.values(claims);
const readerQuestion='Why can food prices rise and stay elevated even when headline crop acreage looks resilient?';
const visualThesis='Monsoon instability, uneven rainfall and weakened moisture transport raise yield risk, while domestic and global pressure keep food-price risk elevated.';

const storyGraph=assessStoryGraph({
  story_id:'india-food-risk-2026-09-14',reader_question:readerQuestion,visual_thesis:visualThesis,
  nodes:[
    {id:'acreage-context',kind:'context',summary:'Kharif crop sowing area was only about 1.6% lower year on year, a headline number that can look reassuring.',explanatory_dimension:'context',claim_ids:[claims.acreage]},
    {id:'rain-whiplash',kind:'evidence',summary:'Monthly rainfall swung from 38% below normal in June to 1% above in July and 16.3% below in August.',explanatory_dimension:'trend',claim_ids:[claims.rain]},
    {id:'lps-paradox',kind:'evidence',summary:'July low-pressure systems were active 24 days versus a climatological normal of 13.56 days.',explanatory_dimension:'comparison',claim_ids:[claims.lps]},
    {id:'moisture-mechanism',kind:'mechanism',summary:'El Nino weakened the moisture-transport pathway, so more low-pressure activity did not translate into uniformly adequate rainfall.',explanatory_dimension:'mechanism',claim_ids:[claims.mechanism]},
    {id:'spatial-deficit',kind:'evidence',summary:'Twenty-four of 36 meteorological subdivisions had rainfall deficits greater than 10%.',explanatory_dimension:'spatial',claim_ids:[claims.spatial]},
    {id:'yield-risk',kind:'outcome',summary:'Uneven and deficient rainfall increases crop-yield uncertainty even when planted acreage remains large.',explanatory_dimension:'outcome',claim_ids:[claims.yield]},
    {id:'price-risk',kind:'outcome',summary:'Yield uncertainty plus wider market pressure can keep food-price risk elevated.',explanatory_dimension:'outcome',claim_ids:[claims.price]},
  ],
  edges:[
    {from:'acreage-context',to:'yield-risk',relation:'qualifies'},
    {from:'lps-paradox',to:'moisture-mechanism',relation:'contrasts_with'},
    {from:'moisture-mechanism',to:'rain-whiplash',relation:'explains'},
    {from:'rain-whiplash',to:'yield-risk',relation:'contributes_to'},
    {from:'spatial-deficit',to:'yield-risk',relation:'locates'},
    {from:'yield-risk',to:'price-risk',relation:'contributes_to'},
  ],
  entry_node_ids:['acreage-context','lps-paradox','spatial-deficit'],answer_node_ids:['price-risk'],
});
assert.equal(storyGraph.passed,true,JSON.stringify(storyGraph.issues));
assert.ok(storyGraph.metrics.explanatory_dimension_count>=4);
assert.equal(storyGraph.metrics.answer_reachable,true);

const lpsSemantics=evaluateVisualSemantics({
  measure_semantics:[
    {id:'actual',phenomenon:'lps_active_days',unit:'days',measure_kind:'duration',temporal_basis:{type:'period',start:'2026-07-01',end:'2026-07-31'},observation_status:'observed',aggregation:'monthly_active_days',scope:'India',value:24},
    {id:'normal',phenomenon:'lps_active_days',unit:'days',measure_kind:'duration',temporal_basis:{type:'structural'},observation_status:'reference',aggregation:'monthly_active_days',scope:'India',value:13.56},
  ],
  claim_spec:{claim_id:claims.lps,relation:'benchmark',reader_task:'compare July activity with climatological normal',target_measure:'actual',baseline_measure:'normal',derived_metric:'absolute_change'}
});
assert.equal(lpsSemantics.status,'CONTEXTUAL',JSON.stringify(lpsSemantics));
assert.equal(lpsSemantics.derived_metric.status,'COMPUTED');
assert.ok(Math.abs(lpsSemantics.derived_metric.value-10.44)<1e-9);

function makeVizAsset(spec,rows){
  const lint=lintVizSpec(spec,rows,{verified_claim_ids:verified});
  assert.equal(lint.passed,true,lint.blockers.join(' | '));
  const bundle=renderVizBundle(spec,rows);
  const critic=critiqueViz(spec,rows,lint,bundle.desktop);
  assert.equal(critic.passed,true,JSON.stringify(critic));
  return {desktopSvg:bundle.desktop,mobileSvg:bundle.mobile,manifest:{claim_id:spec.claim_id,source_note:spec.source_note,chart_type:spec.chart_type,alt:spec.alt},critic};
}

const rainRows=[{month:'June',value:-38},{month:'July',value:1},{month:'August',value:-16.3}];
const rainSpec={schema_version:'0.9.0',reader_task:'comparison',takeaway:'The monsoon did not follow a steady recovery: July briefly returned to normal before August fell sharply below it again.',chart_type:'diverging_bar',title:'The monsoon kept snapping across the normal line',subtitle:'All-India rainfall deviation from each month’s long-period average, 2026',alt:'Three zero-centered bars show June rainfall 38% below normal, July 1% above normal, and August 16.3% below normal.',source_note:'Indian Express, Sept. 14, 2026, citing India Meteorological Department',claim_id:claims.rain,sql:'SELECT month,value FROM rainfall',unit:'%',category_field:'month',value_field:'value',sort:'none',highlight_values:['June','August'],annotations:[]};
const lpsRows=[{category:'July 2026',value:24},{category:'Climatological normal',value:13.56}];
const lpsSpec={schema_version:'0.9.0',reader_task:'comparison',takeaway:'Low-pressure systems were active roughly ten and a half days longer than the climatological July normal.',chart_type:'horizontal_bar',title:'Low-pressure systems were active far longer than normal',subtitle:'Active days in July',alt:'Two horizontal bars compare 24 active low-pressure-system days in July 2026 with a climatological normal of 13.56 days.',source_note:'Indian Express, Sept. 14, 2026, citing India Meteorological Department',claim_id:claims.lps,sql:'SELECT category,value FROM lps',unit:'days',category_field:'category',value_field:'value',sort:'desc',highlight_values:['July 2026'],annotations:[]};
const assets={
  'visualizations/rain.json':makeVizAsset(rainSpec,rainRows),
  'visualizations/lps.json':makeVizAsset(lpsSpec,lpsRows),
};
const desktopJuneLabel=assets['visualizations/rain.json'].desktopSvg.match(/data-role="bar-value-label" x="([^"]+)"[^>]*>-38%<\/text>/);
const mobileJuneLabel=assets['visualizations/rain.json'].mobileSvg.match(/data-role="bar-value-label" x="([^"]+)"[^>]*>-38%<\/text>/);
assert.ok(desktopJuneLabel,'desktop June value label missing');
assert.ok(mobileJuneLabel,'mobile June value label missing');
assert.ok(Number(desktopJuneLabel[1])>=250,'desktop negative-edge label must move inside plot to avoid category collision');
assert.ok(Number(mobileJuneLabel[1])>=178,'mobile negative-edge label must move inside plot to avoid category collision');

const mechanismSpec={schema_version:'0.1.0',view:'system',not_to_scale:true,title:'Why more low-pressure activity did not guarantee enough rain',subject:'Monsoon moisture transport',subtitle:'A schematic mechanism linking circulation, rainfall distribution and crop risk.',alt:'A schematic system graphic shows El Nino weakening moisture transport, contributing to uneven rainfall and then crop-yield risk.',source_note:'Indian Express, Sept. 14, 2026, citing IMD and meteorological explanation',parts:[
  {id:'elnino',label:'El Nino influence',detail:'Circulation pattern weakens moisture transport',weight:1,claim_ids:[claims.mechanism]},
  {id:'moisture',label:'Moisture transport',detail:'Less reliable moisture reaches rainfall-producing systems',weight:1.1,claim_ids:[claims.mechanism]},
  {id:'rain',label:'Uneven rainfall',detail:'Rainfall can remain deficient despite active low-pressure systems',weight:1.2,claim_ids:[claims.rain,claims.lps]},
  {id:'yield',label:'Yield risk',detail:'Spatial and timing deficits matter for crop outcomes',weight:1,claim_ids:[claims.yield]},
],relationships:[{source:'elnino',target:'moisture',label:'weakens'},{source:'moisture',target:'rain',label:'constrains'},{source:'rain',target:'yield',label:'raises risk'}]};
const mechanismLint=lintExplanatorySpec(mechanismSpec,{verified_claim_ids:verified});
assert.equal(mechanismLint.passed,true,mechanismLint.blockers.join(' | '));
const mechanismBundle=renderExplanatoryBundle(mechanismSpec);
const mechanismCritic=critiqueExplanatory(mechanismSpec,mechanismBundle);
assert.equal(mechanismCritic.passed,true,JSON.stringify(mechanismCritic));
assets['visualizations/illustrations/mechanism.json']={desktopSvg:mechanismBundle.desktop,mobileSvg:mechanismBundle.mobile,manifest:{view:'system',source_note:mechanismSpec.source_note,claim_ids:[claims.mechanism,claims.rain,claims.lps,claims.yield],alt:mechanismSpec.alt},critic:mechanismCritic};

const spec={
  schema_version:'1.4.0',kicker:'FOOD / CLIMATE',title:'Why a large crop area can still hide a fragile food outlook',
  dek:'India’s monsoon has combined sharp month-to-month swings, unusually persistent low-pressure activity and widespread regional deficits. The visual story follows how those signals travel from weather to yield risk and then to prices.',
  alt:'A multi-module visual explainer connects monthly rainfall anomalies, unusually persistent low-pressure systems, widespread regional rainfall deficits, a schematic moisture-transport mechanism and food-price risk.',
  byline:'Agentic Data Newsroom',date_label:'14 Sep 2026',layout:'feature',complexity_budget:'medium',quality_target:'publishable',competition_profile:'editorial',
  intent:'Explain why apparently resilient acreage can coexist with elevated food-price risk by linking weather instability, spatial deficits and crop-yield uncertainty.',
  primary_message:'The risk comes from where and when rain failed, not from planted area alone.',reader_question:readerQuestion,visual_thesis:visualThesis,
  story_arc:'explain',audience:'general',story_graph_ref:'editorial/story-graphs/monsoon.json',editorial_discovery_ref:'editorial/discovery/monsoon.json',visual_concept_ref:'editorial/concepts/monsoon.json',selected_concept_id:'mechanism-first',novelty_ref:'editorial/novelty/monsoon.json',asset_plan_ref:'editorial/assets/monsoon.json',source_note:'Indian Express, Sept. 14, 2026, citing India Meteorological Department',
  scene_graph:{schema_version:'0.1.0',scenes:[
    {id:'weather-system',pattern:'hero_with_rail',eyebrow:'Weather signal',title:'More weather systems did not mean reliable rain',dek:'Read the anomaly first, then compare the pressure-system benchmark, spatial deficit and apparently resilient acreage.',anchor_module_id:'rain',sidecar_module_ids:['lps','spatial','acreage'],shared_source_scope:true},
    {id:'transmission',pattern:'hero_sidecar_stack',eyebrow:'Transmission',title:'The weather signal matters because it changes yield risk',dek:'A mechanism view closes the gap between meteorology and the food-price outlook.',anchor_module_id:'mechanism',sidecar_module_ids:['resolution'],shared_source_scope:true}
  ]},
  modules:[
    {id:'opening',type:'section_header',span:'full',eyebrow:'The mechanism',heading:'The crop-risk story begins with instability, not acreage',deck:'Read the weather signal, then follow the pathway to yield and price risk.',story_role:'context',priority:2,emphasis:'secondary'},
    {id:'rain',type:'visual',span:'two_thirds',label:'Monsoon whiplash',manifest_ref:'visualizations/rain.json',visual_grammar:'anomaly',story_node_ids:['rain-whiplash'],reader_question_id:'weather-instability',claim_set:[claims.rain],new_information:'Rainfall crossed the normal line and then fell sharply below it again.',explanatory_dimension:'trend',story_role:'evidence',priority:1,emphasis:'hero'},
    {id:'lps',type:'visual',span:'third',label:'The paradox',manifest_ref:'visualizations/lps.json',visual_grammar:'benchmark',story_node_ids:['lps-paradox'],reader_question_id:'weather-instability',claim_set:[claims.lps],new_information:'Low-pressure systems stayed active much longer than climatological normal.',explanatory_dimension:'comparison',story_role:'turn',priority:2,emphasis:'primary'},
    {id:'spatial',type:'hero_stat',span:'third',tone:'dark',value:'24 of 36',unit:'subdivisions',label:'Had rainfall deficits greater than 10%',detail:'The shortfall was geographically widespread, not only a national-average problem.',claim_id:claims.spatial,story_node_ids:['spatial-deficit'],reader_question_id:'where-deficit',claim_set:[claims.spatial],new_information:'Two-thirds of meteorological subdivisions had meaningful deficits.',explanatory_dimension:'spatial',story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'mechanism',type:'illustration',span:'full',label:'Why the paradox is possible',asset_ref:'visualizations/illustrations/mechanism.json',alt:mechanismSpec.alt,credit:'Semantic schematic based on reporting and meteorological explanation; not to scale',claim_ids:[claims.mechanism,claims.rain,claims.lps,claims.yield],story_node_ids:['moisture-mechanism','yield-risk'],reader_question_id:'why-paradox',claim_set:[claims.mechanism,claims.yield],new_information:'Circulation can weaken moisture transport, so active systems do not guarantee evenly adequate rainfall.',explanatory_dimension:'mechanism',story_role:'explanation',priority:1,emphasis:'primary'},
    {id:'acreage',type:'hero_stat',span:'third',tone:'accent',value:'-1.6',unit:'%',label:'Year-on-year change in kharif sowing area',detail:'A small acreage decline can mask much larger yield risk from timing and geography.',claim_id:claims.acreage,story_node_ids:['acreage-context'],reader_question_id:'acreage-premise',claim_set:[claims.acreage],new_information:'Headline acreage looks comparatively resilient.',explanatory_dimension:'context',story_role:'context',priority:2,emphasis:'primary'},
    {id:'resolution',type:'text',span:'full',label:'What reaches the checkout line',heading:'Acreage is only the first denominator',body:'Large planted area can coexist with weak yields when rainfall arrives in the wrong places or at the wrong times. That is the bridge from monsoon instability to an elevated food-price outlook.',claim_ids:[claims.yield,claims.price],story_node_ids:['yield-risk','price-risk'],reader_question_id:'price-outlook',claim_set:[claims.yield,claims.price],new_information:'The story closes on the transmission from weather risk to prices.',explanatory_dimension:'outcome',story_role:'resolution',priority:1,emphasis:'primary'},
  ]
};

assert.deepEqual(validateInfographicSpec(spec),[]);
const context={verified_claim_ids:verified,story_graph:storyGraph};
const lint=lintInfographicSpec(spec,assets,context);
assert.equal(lint.passed,true,lint.blockers.join(' | '));
assert.equal(lint.synthesis.metrics.default_chart_equivalent,false);
assert.equal(lint.synthesis.metrics.question_closure,true);
assert.ok(lint.synthesis.metrics.mapped_dimension_count>=4);
const bundle=composeInfographicBundle(spec,assets);
const critic=critiqueInfographic(spec,bundle);
assert.equal(critic.passed,true,JSON.stringify(critic));
assert.match(bundle.desktop.svg,/data-infographic-version="1.4.0"/);
assert.equal((bundle.desktop.svg.match(/data-role="infographic-visual"/g)??[]).length,2);
assert.equal((bundle.desktop.svg.match(/data-role="infographic-illustration"/g)??[]).length,1);

const oneChartSpec=structuredClone(spec);
oneChartSpec.scene_graph={schema_version:'0.1.0',scenes:[{id:'single',pattern:'hero_with_rail',anchor_module_id:'rain',sidecar_module_ids:['spatial','resolution']}]};
oneChartSpec.modules=oneChartSpec.modules.filter((m)=>['opening','rain','spatial','resolution'].includes(m.id));
const oneChartAssets={'visualizations/rain.json':assets['visualizations/rain.json']};
const oneChartLint=lintInfographicSpec(oneChartSpec,oneChartAssets,context);
assert.equal(oneChartLint.passed,false);
assert.ok(oneChartLint.blockers.some((x)=>x.includes('default_chart_equivalence')),JSON.stringify(oneChartLint));

const noClosure=structuredClone(spec);
noClosure.modules.find((m)=>m.id==='resolution').story_node_ids=['yield-risk'];
const noClosureLint=lintInfographicSpec(noClosure,assets,context);
assert.equal(noClosureLint.passed,false);
assert.ok(noClosureLint.blockers.some((x)=>x.includes('reader_question_closure')),JSON.stringify(noClosureLint));

const wrongGrammar=structuredClone(spec);
wrongGrammar.modules.find((m)=>m.id==='rain').visual_grammar='trend';
const wrongGrammarLint=lintInfographicSpec(wrongGrammar,assets,context);
assert.equal(wrongGrammarLint.passed,false);
assert.ok(wrongGrammarLint.blockers.some((x)=>x.includes("grammar 'trend'")),JSON.stringify(wrongGrammarLint));

const outDir=new URL('../outputs/v18-monsoon/',import.meta.url);
await mkdir(outDir,{recursive:true});
await writeFile(new URL('india-food-risk-infographic.svg',outDir),bundle.desktop.svg);
await writeFile(new URL('india-food-risk-infographic.mobile.svg',outDir),bundle.mobile.svg);
await writeFile(new URL('story-graph.json',outDir),JSON.stringify(storyGraph,null,2)+'\n');
await writeFile(new URL('qualification.json',outDir),JSON.stringify({story_graph:storyGraph,climatological_benchmark:lpsSemantics,lint,critic},null,2)+'\n');
console.log('v1.8 visual synthesis qualification: PASS');
console.log(`story closure=${(storyGraph.metrics.closure_coverage*100).toFixed(1)}% dimensions=${storyGraph.metrics.explanatory_dimension_count}`);
console.log(`infographic synthesis dimensions=${lint.synthesis.metrics.mapped_dimension_count} visual_modules=${lint.synthesis.metrics.visual_module_count} illustration_modules=${lint.synthesis.metrics.illustration_module_count}`);
console.log(`critic=${critic.score} desktop=${bundle.desktop.width}x${bundle.desktop.height.toFixed(0)} mobile=${bundle.mobile.width}x${bundle.mobile.height.toFixed(0)}`);
