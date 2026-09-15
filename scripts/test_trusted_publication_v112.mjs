import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePublicationSpec, renderPublication } from '../runtime/web/publication.mjs';
import { buildEvidenceBoundModule, assertViewSpecHasNoInlineData } from '../runtime/visual/publication_binding.mjs';
import { assertSafeSvg, sha256Text } from '../runtime/visual/svg_security.mjs';
import { hashRows } from '../runtime/pi/viz.mjs';

const rows=[{category:'Food',value:13.5},{category:'Energy',value:7.3},{category:'Core',value:79.2}];
const resultHash=hashRows(rows);
const base={
  schema_version:'0.3.0',title:'Trusted publication fixture',dek:'Evidence-bound browser publication fixture for release hardening.',reader_question:'How is the basket composed?',visual_thesis:'Most weight sits in the core basket.',story_graph_ref:'editorial/story-graphs/test.json',infographic_plan_ref:'infographics/plans/test.json',style_profile:'analytical_precision',source_note:'Synthetic deterministic fixture.',
  delivery:{mode:'html',packaging:'archive',self_contained:true,static_fallback:'png',breakpoints:[390,1024],max_initial_bytes:8_000_000,max_ready_ms:8_000},interaction:{allowed:['hover','focus'],replay:[]},modules:[]
};
const chart={id:'basket',type:'plotly',engine:'plotly',visual_type:'statistical',title:'Basket weights',story_node_ids:['n1'],claim_ids:['claim-1'],explanatory_dimension:'comparison',width:'wide',view_spec:{mark:'bar',layout:{xaxis:{title:'Category'},yaxis:{title:'Weight'}}},evidence_binding:{kind:'computation',ref:'computations/x.json',result_hash:resultHash,row_count:rows.length,field_mapping:{x:'category',y:'value'}},accessibility:{summary:'Bar chart of basket weights.',long_description:'Three bars show Food, Energy and Core weights, with Core much larger than the other two.',keyboard_navigation:true}};
const text={id:'note',type:'text',title:'Interpretation',story_node_ids:['n2'],explanatory_dimension:'context',width:'third',text:'Core dominates the basket.'};
const spec={...base,modules:[chart,text]};
assert.deepEqual(validatePublicationSpec(spec),[]);
const resolved={...spec,modules:[buildEvidenceBoundModule(chart,rows),text]};
const rendered=renderPublication(resolved);
assert.equal(rendered.manifest.evidence_bound,true);
assert.ok(rendered.html.includes('View data table'));
assert.ok(rendered.html.includes('Content-Security-Policy'));

const production={...resolved,delivery:{...resolved.delivery,packaging:'production',self_contained:false,max_initial_bytes:1_500_000}};
const prod=renderPublication(production);
assert.equal(prod.manifest.self_contained,false);
assert.ok(Object.keys(prod.assets).some(x=>x.startsWith('plotly-')));
assert.ok(prod.html.includes('src="assets/plotly-'));

assert.throws(()=>assertViewSpecHasNoInlineData({figure:{data:[1,2,3]}}),/inline data/);
const raw={...base,modules:[{...chart,id:'badsvg',type:'static_svg',asset_ref:'visualizations/x.svg',fallback_svg:'<svg viewBox="0 0 1 1"></svg>'},text]};
assert.ok(validatePublicationSpec(raw).some(x=>x.includes('fallback_svg is forbidden')));
assert.throws(()=>assertSafeSvg('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'),/script/);
assert.throws(()=>assertSafeSvg('<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"></a></svg>'),/active reference/);
assert.equal(sha256Text('<svg/>').length,64);

const out='outputs/v112-trusted';fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'archive.html'),rendered.html);fs.writeFileSync(path.join(out,'archive-spec.json'),JSON.stringify(spec,null,2));
const productionPlan={...spec,delivery:{...spec.delivery,packaging:'production',self_contained:false,max_initial_bytes:1_500_000}};
fs.writeFileSync(path.join(out,'production.html'),prod.html);fs.writeFileSync(path.join(out,'production-spec.json'),JSON.stringify(productionPlan,null,2));
fs.mkdirSync(path.join(out,'assets'),{recursive:true});for(const [name,body] of Object.entries(prod.assets))fs.writeFileSync(path.join(out,'assets',name),body);
console.log(JSON.stringify({status:'PASS',result_hash:resultHash,archive_bytes:rendered.manifest.initial_bytes,production_bytes:prod.manifest.initial_bytes,production_assets:Object.keys(prod.assets)},null,2));
