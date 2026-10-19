// Fixture for test_ordinal_reading_order.mjs: the page fixture of test_infographic.mjs up to its scene spec
// (copied from it so the mutant runs can load the same page against a mutated runtime copy). Set ORDINAL_RUNTIME_DIR to a
// directory holding a copy of runtime/pi (and ../config); it defaults to the tree's own runtime/pi.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { CLEAN_HERO_CHECKS } from './lib_hero_checks.mjs';
const RT = process.env.ORDINAL_RUNTIME_DIR ? pathToFileURL(process.env.ORDINAL_RUNTIME_DIR + '/').href : new URL('../runtime/pi/', import.meta.url).href;
const { lintVizSpec, renderVizBundle, critiqueViz } = await import(RT + 'viz.mjs');
const { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle, critiqueInfographic } = await import(RT + 'infographic.mjs');
const { runRenderQa } = await import(RT + 'render_qa.mjs');

const claim='claim-infographic';
const context={hero_checks:CLEAN_HERO_CHECKS,verified_claim_ids:[claim]};

const barRows=[
  {category:'A',value:42},{category:'B',value:31},{category:'C',value:18},{category:'D',value:9}
];
const barSpec={schema_version:'0.9.0',reader_task:'ranking',takeaway:'A leads the selected categories.',chart_type:'horizontal_bar',title:'A leads this selected comparison',subtitle:'Synthetic regression fixture',alt:'Horizontal bars rank four synthetic categories from A at 42 to D at 9.',source_note:'Synthetic fixture',claim_id:claim,sql:'SELECT * FROM synthetic_bar',unit:'units',category_field:'category',value_field:'value',sort:'desc',highlight_values:['A'],annotations:[]};
const barLint=lintVizSpec(barSpec,barRows,context);assert.equal(barLint.passed,true);
const barBundle=renderVizBundle(barSpec,barRows);const barCritic=critiqueViz(barSpec,barRows,barLint,barBundle.desktop);assert.equal(barCritic.passed,true);

const flowRows=[
  {source:'Solar',target:'System',value:20},{source:'Wind',target:'System',value:30},{source:'Gas',target:'System',value:50},
  {source:'System',target:'Homes',value:35},{source:'System',target:'Industry',value:45},{source:'System',target:'Losses',value:20},
];
const flowSpec={schema_version:'0.9.0',reader_task:'flow',visual_family:'flow',data_topology:'flow_edges',complexity_budget:'medium',takeaway:'Three sources feed the system before energy reaches users and losses.',chart_type:'sankey',title:'Energy moves through one system',subtitle:'Synthetic flow fixture',alt:'A Sankey diagram shows solar, wind and gas feeding a system that supplies homes and industry while some energy is lost.',source_note:'Synthetic fixture',claim_id:claim,sql:'SELECT * FROM synthetic_flow',unit:'PJ',source_field:'source',target_field:'target',value_field:'value',flow_conservation:'strict',flow_tolerance:0.001,highlight_values:['Losses'],annotations:[]};
const flowLint=lintVizSpec(flowSpec,flowRows,context);assert.equal(flowLint.passed,true,flowLint.blockers.join(' | '));
const flowBundle=renderVizBundle(flowSpec,flowRows);const flowCritic=critiqueViz(flowSpec,flowRows,flowLint,flowBundle.desktop);assert.equal(flowCritic.passed,true);

const assets={
  'visualizations/bar.json':{desktopSvg:barBundle.desktop,mobileSvg:barBundle.mobile,...(process.env.NEWSROOM_EMBED_MIN_TEXT==='1'?{compactSvg:renderVizBundle(barSpec,barRows,{compact:true}).compact}:{}),manifest:{claim_id:claim,source_note:barSpec.source_note,chart_type:barSpec.chart_type,alt:barSpec.alt},critic:{passed:true,score:barCritic.score}},
  'visualizations/flow.json':{desktopSvg:flowBundle.desktop,mobileSvg:flowBundle.mobile,manifest:{claim_id:claim,source_note:flowSpec.source_note,chart_type:flowSpec.chart_type,alt:flowSpec.alt},critic:{passed:true,score:flowCritic.score}},
};

const spec={
  schema_version:'1.0.0',kicker:'SYSTEMS / DATA FEATURE',title:'A system is easier to understand when the parts share one page',
  dek:'This regression feature combines verified numbers, explanatory copy and two upstream newsroom visuals into a single responsive editorial composition.',
  alt:'A magazine-style data feature with a large headline, two hero statistics, a ranking chart, a Sankey diagram and explanatory text.',
  byline:'Newsroom Agent',date_label:'Regression edition',layout:'feature',complexity_budget:'medium',source_note:'Synthetic infographic regression fixture',
  modules:[
    {id:'section-1',type:'section_header',span:'full',eyebrow:'The premise',heading:'Numbers gain meaning from hierarchy',deck:'The composer controls reading order while preserving upstream data provenance.'},
    {id:'stat-total',type:'hero_stat',span:'third',tone:'accent',value:'100',unit:'PJ',label:'Total energy entering the synthetic system',detail:'Verified claim fixture',claim_id:claim,label_short:'Total'},
    {id:'bar',type:'visual',span:'two_thirds',label:'The ranking',manifest_ref:'visualizations/bar.json'},
    {id:'flow',type:'visual',span:'full',label:'The system',manifest_ref:'visualizations/flow.json'},
    {id:'stat-loss',type:'hero_stat',span:'third',tone:'dark',value:'20',unit:'PJ',label:'Energy represented as losses',detail:'One fifth of the synthetic total',claim_id:claim},
    {id:'text',type:'text',span:'two_thirds',label:'Why it matters',heading:'One feature, several reading speeds',body:'The headline provides the argument, hero numbers reward scanning, charts support comparison, and explanatory prose gives the reader enough context to interpret the structure without detaching the visuals from their verified claims.',claim_ids:[claim]},
  ],
};

assert.deepEqual(validateInfographicSpec(spec),[]);
const lint=lintInfographicSpec(spec,assets,context);assert.equal(lint.passed,true,lint.blockers.join(' | '));
const bundle=composeInfographicBundle(spec,assets);
assert.match(bundle.desktop.svg,/data-infographic-version="1.0.0"/);
assert.match(bundle.desktop.svg,/data-role="hero-stat"/);
assert.equal((bundle.desktop.svg.match(/data-role="infographic-visual"/g)??[]).length,2);
assert.equal((bundle.mobile.svg.match(/data-role="infographic-visual"/g)??[]).length,2);
const critic=critiqueInfographic(spec,bundle);assert.equal(critic.passed,true,JSON.stringify(critic));
assert.ok(bundle.desktop.height>1400);
assert.ok(bundle.mobile.height>1800);

const missingAsset=lintInfographicSpec(spec,{'visualizations/bar.json':assets['visualizations/bar.json']},context);
assert.equal(missingAsset.passed,false);
assert.ok(missingAsset.blockers.some(x=>x.includes('missing asset')));
const failedAssets=structuredClone(assets);failedAssets['visualizations/flow.json']={...assets['visualizations/flow.json'],critic:{passed:false,score:60}};
assert.equal(lintInfographicSpec(spec,failedAssets,context).passed,false);

const cluttered={...spec,title:'An intentionally overlong magazine headline that keeps adding clauses and context until the display hierarchy becomes much too dense for the intended page',dek:'This intentionally verbose deck repeats context and keeps extending the explanatory setup so the deterministic critic has a realistic density signal to penalize even though the underlying modules remain geometrically valid. '.repeat(2)};
const clutterBundle=composeInfographicBundle(cluttered,assets);
const clutterCritic=critiqueInfographic(cluttered,clutterBundle);
assert.ok(clutterCritic.score<critic.score);
assert.equal(clutterCritic.passed,false,'over-dense magazine page should trigger REVISE');


const awardSpec={
  ...spec,
  schema_version:'1.1.0',
  intent:'Explain how verified evidence, narrative hierarchy and multiple visual forms combine into one coherent magazine feature.',
  primary_message:'A strong infographic gives readers one fast takeaway and a deeper evidence path without breaking provenance.',
  story_arc:'explain',audience:'informed',quality_target:'award',
  modules:[
    {id:'section-1',type:'section_header',span:'full',eyebrow:'The premise',heading:'Build the reading path before decorating the page',deck:'A hook, evidence, turn and resolution create editorial rhythm.',story_role:'context',priority:2,emphasis:'secondary'},
    {id:'stat-total',type:'hero_stat',span:'third',tone:'accent',value:'100',unit:'PJ',label:'Total energy entering the synthetic system',detail:'Verified claim fixture',claim_id:claim,story_role:'hook',priority:1,emphasis:'primary'},
    {id:'bar',type:'visual',span:'two_thirds',label:'The ranking',manifest_ref:'visualizations/bar.json',story_role:'evidence',priority:2,emphasis:'primary'},
    {id:'flow',type:'visual',span:'full',label:'The system',manifest_ref:'visualizations/flow.json',story_role:'evidence',priority:1,emphasis:'hero'},
    {id:'stat-loss',type:'hero_stat',span:'third',tone:'dark',value:'20',unit:'PJ',label:'Energy represented as losses',detail:'One fifth of the synthetic total',claim_id:claim,story_role:'turn',priority:3,emphasis:'primary'},
    {id:'text',type:'text',span:'two_thirds',label:'Why it matters',heading:'One feature, two reading speeds',body:'The headline and anchor visual provide the fast reading path. Supporting statistics and explanatory prose provide the slower path for readers who want evidence and context.',claim_ids:[claim],story_role:'resolution',priority:3,emphasis:'secondary'},
  ],
};
assert.deepEqual(validateInfographicSpec(awardSpec),[]);
const awardLint=lintInfographicSpec(awardSpec,assets,context);assert.equal(awardLint.passed,true,awardLint.blockers.join(' | '));
const awardBundle=composeInfographicBundle(awardSpec,assets);
assert.match(awardBundle.desktop.svg,/data-infographic-version="1.1.0"/);
assert.ok(awardBundle.desktop.candidate_scores.length===3,'award page should evaluate three desktop candidates');
assert.ok(['balanced','anchor','rhythm'].includes(awardBundle.desktop.layout_strategy));
const awardCritic=critiqueInfographic(awardSpec,awardBundle);
assert.equal(awardCritic.passed,true,JSON.stringify(awardCritic));
assert.ok(awardCritic.score>=92,JSON.stringify(awardCritic));
assert.ok(Object.keys(awardCritic.rubric).length===10);

const mobileOrder=['stat-total','flow','bar','section-1','stat-loss','text'];
const competitionSpec={...structuredClone(awardSpec),schema_version:'1.2.0',competition_profile:'oja2026_visual',mobile_module_order:mobileOrder};
assert.deepEqual(validateInfographicSpec(competitionSpec),[]);
const competitionLint=lintInfographicSpec(competitionSpec,assets,context);assert.equal(competitionLint.passed,true,competitionLint.blockers.join(' | '));
const competitionBundle=composeInfographicBundle(competitionSpec,assets);
assert.equal(competitionBundle.desktop.candidate_scores.length,3,'1.2 page must retain three desktop layout candidates');
assert.deepEqual(competitionBundle.mobile.boxes.map((box)=>box.id),mobileOrder,'1.2 mobile composition must honor mobile-only reading order');
assert.notDeepEqual(competitionBundle.desktop.boxes.map((box)=>box.id),mobileOrder,'mobile-only reading order must not rewrite desktop sequence');
const competitionCritic=critiqueInfographic(competitionSpec,competitionBundle);
assert.equal(competitionCritic.competition_profile,'oja2026_visual');

const sceneSpec={...structuredClone(competitionSpec),schema_version:'1.3.0',
 editorial_discovery_ref:'editorial/discovery/test.json',visual_concept_ref:'editorial/concepts/test.json',selected_concept_id:'concept-scene',novelty_ref:'editorial/novelty/test.json',asset_plan_ref:'editorial/assets/test.json',
 scene_graph:{schema_version:'0.1.0',scenes:[{id:'hero-system',pattern:'hero_sidecar_stack',eyebrow:'Integrated scene',title:'One system, one visual scaffold',dek:'The dominant flow graphic and its supporting evidence share a scene instead of separate cards.',anchor_module_id:'flow',sidecar_module_ids:['stat-total','text'],shared_source_scope:true}]}};
const readingOrderOrNull = (await import(RT + "infographic.mjs")).readingOrder ?? null;

export { assets, sceneSpec, context, composeInfographicBundle, readingOrderOrNull };
