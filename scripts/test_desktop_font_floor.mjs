#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lintVizSpec, renderVizBundle, critiqueViz } from '../runtime/pi/viz.mjs';
import { lintInfographicSpec, composeInfographicBundle } from '../runtime/pi/infographic.mjs';
import { runRenderQa } from '../runtime/pi/render_qa.mjs';
import { measurePage, embeddedChart, nativeInk, mapToPage } from './lib_page_geometry.mjs';

const claim='claim-floor';
const context={verified_claim_ids:[claim],mobile_pages:false};

function barFixture(n,id){
  const rows=Array.from({length:n},(_,i)=>({category:`Category ${String(i+1).padStart(2,'0')}`,value:200-i*(150/n)}));
  const spec={schema_version:'0.9.0',reader_task:'ranking',takeaway:'Category 01 leads the ranking.',chart_type:'horizontal_bar',title:`Category 01 leads ${n} categories`,subtitle:'Synthetic fixture',alt:`Horizontal bars rank ${n} synthetic categories from highest to lowest.`,source_note:'Synthetic fixture',claim_id:claim,sql:'SELECT * FROM synthetic_bar',unit:'units',category_field:'category',value_field:'value',sort:'desc',highlight_values:['Category 01'],annotations:[]};
  const lint=lintVizSpec(spec,rows,context);assert.equal(lint.passed,true,lint.blockers.join(' | '));
  const bundle=renderVizBundle(spec,rows,{mobilePages:false,compact:id==='compact'});
  const critic=critiqueViz(spec,rows,lint,bundle.desktop);
  return {spec,rows,bundle,critic};
}
const viewH=(svg)=>Number(svg.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/)[1]);
const asset=(f,compact)=>({desktopSvg:f.bundle.desktop,...(compact?{compactSvg:f.bundle.compact}:{}),manifest:{claim_id:claim,source_note:f.spec.source_note,chart_type:f.spec.chart_type,alt:f.spec.alt},critic:{passed:true,score:f.critic.score}});
function embeddedH(svg){
  const m=svg.match(/<svg[^>]*data-role="infographic-visual"[^>]*>/);assert.ok(m,'embedded visual svg present');
  const h=m[0].match(/\sheight="([\d.]+)"/);assert.ok(h,'embedded svg has height');return Number(h[1]);
}
function noFloorFailure(qa){
  for(const [vp,r] of Object.entries(qa.viewports)){
    for(const list of [r.geometry?.failures,r.contrast?.failures]){
      assert.ok(!(list??[]).some((x)=>x.rule==='font_below_floor'||JSON.stringify(x).includes('font_below_floor')),`font_below_floor in ${vp}`);
    }
  }
}
// The page may trim a chart's blank padding but must not shrink it or cut it off. Measured from the two svgs alone
// (scripts/lib_page_geometry.mjs; no layout helper is the oracle): the embedded svg's own width/height/viewBox give the
// scale the chart is really drawn at (the "meet" rule, so a height-capped chart counts at the scale it is drawn at), and
// the standalone chart svg gives its viewBox width, its lowest ink and its text sizes.
function assertChartKeepsNativeSize(pageSvg,id,nativeSvg,label){
  const v=embeddedChart(measurePage(pageSvg),id),n=nativeInk(nativeSvg);
  assert.ok(v.w/n.width>=1-0.001,`${label}: embedded width ${v.w} / native viewBox width ${n.width} >= 1`);
  assert.ok(v.scale>=1-0.001,`${label}: chart is drawn at scale ${v.scale} >= 1 of its native size`);
  const ink=mapToPage(v,n.ink);
  assert.ok(ink.y1<=v.y+v.h+0.01,`${label}: native ink bottom lands at ${ink.y1}, beyond the embedded height (bottom ${v.y+v.h})`);
  assert.ok(ink.x0>=v.x-0.01&&ink.x1<=v.x+v.w+0.01&&ink.y0>=v.y-0.01,`${label}: native ink [${ink.x0},${ink.y0} - ${ink.x1},${ink.y1}] is clipped by the embedded viewport [${v.x},${v.y} - ${v.x+v.w},${v.y+v.h}]`);
  const smallest=Math.min(...n.fontSizes)*v.scale;
  assert.ok(smallest>=12-0.01,`${label}: smallest chart text is drawn at ${smallest}px, below the 12px floor`);
  return {scale:v.scale,smallest};
}
const base={schema_version:'1.0.0',kicker:'SYSTEMS / DATA FEATURE',title:'A long ranking stays legible on the page',dek:'A synthetic page checks that a tall chart is not shrunk below the text floor.',alt:'A magazine-style page with a tall ranking chart.',byline:'Newsroom Agent',date_label:'Regression edition',layout:'feature',complexity_budget:'medium',source_note:'Synthetic fixture'};

// (a) tall full-width chart
{
  const f=barFixture(30,'full');
  const native=viewH(f.bundle.desktop);
  assert.ok(native>862,`native height ${native} should exceed 862`);
  const assets={'visualizations/tall.json':asset(f)};
  const spec={...base,modules:[
    {id:'section-1',type:'section_header',span:'full',eyebrow:'Ranking',heading:'Thirty categories side by side',deck:'One tall chart carries the page.'},
    {id:'tall',type:'visual',span:'full',label:'The ranking',manifest_ref:'visualizations/tall.json'},
    {id:'text',type:'text',span:'two_thirds',label:'Why it matters',heading:'Reading the tail',body:'The leading categories sit well above the tail, and the long list keeps every label at a readable size.',claim_ids:[claim]},
    {id:'stat',type:'hero_stat',span:'third',tone:'accent',value:'200',unit:'units',label:'Top category value',detail:'Verified claim fixture',claim_id:claim},
  ]};
  const lint=lintInfographicSpec(spec,assets,context);assert.equal(lint.passed,true,lint.blockers.join(' | '));
  const b=composeInfographicBundle(spec,assets,{mobilePages:false});
  const qa=runRenderQa({desktop:b.desktop.svg});
  assert.equal(qa.passed,true,JSON.stringify([qa.viewports.desktop.geometry.failures.slice(0,5),qa.viewports.desktop.contrast?.failures?.slice(0,3)]));
  noFloorFailure(qa);
  const eh=embeddedH(b.desktop.svg);
  const fit=assertChartKeepsNativeSize(b.desktop.svg,'tall',f.bundle.desktop,'(a)');
  console.log(`PASS (a) tall full-width chart: native=${native} embedded=${eh} scale=${fit.scale.toFixed(4)} smallest text=${fit.smallest.toFixed(2)}px, lint+render QA ok, no font_below_floor`);
}

// (b) compact 8-column anchor in hero_sidecar_stack
{
  const f=barFixture(24,'compact');
  assert.ok(f.bundle.compact,'compact bundle exists');
  const native=viewH(f.bundle.compact);
  const assets={'visualizations/compact.json':asset(f,true)};
  const spec={...base,schema_version:'1.3.0',quality_target:'award',story_arc:'explain',audience:'informed',
    intent:'Show a long ranking at a readable size.',primary_message:'A long ranking keeps every label readable.',
    editorial_discovery_ref:'editorial/discovery/test.json',visual_concept_ref:'editorial/concepts/test.json',selected_concept_id:'concept-scene',novelty_ref:'editorial/novelty/test.json',asset_plan_ref:'editorial/assets/test.json',
    modules:[
      {id:'section-1',type:'section_header',span:'full',eyebrow:'Ranking',heading:'Twenty-four categories side by side',deck:'One compact chart anchors the scene.',story_role:'context',priority:2,emphasis:'secondary'},
      {id:'anchor',type:'visual',span:'full',label:'The ranking',manifest_ref:'visualizations/compact.json',story_role:'evidence',priority:1,emphasis:'hero'},
      {id:'stat',type:'hero_stat',span:'third',tone:'accent',value:'200',unit:'units',label:'Top category value',detail:'Verified claim fixture',claim_id:claim,story_role:'hook',priority:1,emphasis:'primary'},
    ],
    scene_graph:{schema_version:'0.1.0',scenes:[{id:'hero-system',pattern:'hero_sidecar_stack',eyebrow:'Scene',title:'One chart, one number',dek:'The ranking and its headline number share a scene.',anchor_module_id:'anchor',sidecar_module_ids:['stat'],shared_source_scope:true}]}};
  const lint=lintInfographicSpec(spec,assets,context);assert.equal(lint.passed,true,lint.blockers.join(' | '));
  const b=composeInfographicBundle(spec,assets,{mobilePages:false});
  assert.match(b.desktop.svg,/data-role="scene-boundary" data-scene-id="hero-system"/);
  const qa=runRenderQa({desktop:b.desktop.svg});
  assert.equal(qa.passed,true,JSON.stringify([qa.viewports.desktop.geometry.failures.slice(0,5),qa.viewports.desktop.contrast?.failures?.slice(0,3)]));
  noFloorFailure(qa);
  const eh=embeddedH(b.desktop.svg);
  const fit=assertChartKeepsNativeSize(b.desktop.svg,'anchor',f.bundle.compact,'(b)');
  console.log(`PASS (b) compact sidecar anchor: native=${native} embedded=${eh} scale=${fit.scale.toFixed(4)} smallest text=${fit.smallest.toFixed(2)}px, lint+render QA ok, no font_below_floor`);
}
