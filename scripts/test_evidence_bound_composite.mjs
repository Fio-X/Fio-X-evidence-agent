#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEvidenceBoundModule } from '../runtime/pi/publication_binding.mjs';
import { hashRows } from '../runtime/pi/viz.mjs';
import { renderPublication, validatePublicationSpec } from '../runtime/pi/publication.mjs';

const OUT=path.join(os.tmpdir(),'evidence-bound-composite');
fs.mkdirSync(OUT,{recursive:true});
const claims={geo:'claim-fixture-geo',flow:'claim-fixture-flow',network:'claim-fixture-network'};
const rows={
  geo:[
    {label:'Paraguay',lon:-58.4,lat:-23.4,size:42,color:100},
    {label:'Norway',lon:8.5,lat:61,size:38,color:98.5},
    {label:'France',lon:2.2,lat:46.2,size:34,color:89},
    {label:'China',lon:104.2,lat:35.9,size:58,color:29.5},
    {label:'Kazakhstan',lon:67.3,lat:48,size:28,color:14},
  ],
  flow:[
    {source:'coal',target:'fossil',value:10367.93},
    {source:'gas',target:'fossil',value:6691.34},
    {source:'wind',target:'renewable',value:2317.84},
    {source:'solar',target:'renewable',value:1658.42},
  ],
  network:[
    {source:'Paraguay',target:'clean',label:'Paraguay',weight:3},
    {source:'Norway',target:'clean',label:'Norway',weight:3},
    {source:'China',target:'carbon',label:'China',weight:2},
    {source:'clean',target:'carbon',label:'Carbon intensity',weight:1},
    {source:'clean',target:'flow',label:'Selected flows',weight:1},
    {source:'flow',target:'wind',label:'Wind',weight:1},
  ],
};

const binding=(kind,key,field_mapping)=>({kind,ref:`computations/${key}.json`,result_hash:hashRows(rows[key]),field_mapping});
const base={schema_version:'0.3.0',style_profile:'japanese_editorial',title:'能源转型：地点、流向与关系',dek:'同一组经验证据，用三种互补结构回答一个问题。',reader_question:'能源转型在哪里发生，又如何连接？',visual_thesis:'地图定位差异，Sankey 展示来源流向，网络图把国家、能源类型与结果连起来。',story_graph_ref:'editorial/story-graphs/fixture.json',infographic_plan_ref:'infographics/plans/fixture.json',source_note:'Capability fixture uses verified OWID-shaped rows; geometry is an explicit coordinate table and network positions are schematic.',delivery:{mode:'html',packaging:'archive',self_contained:true,static_fallback:'svg',breakpoints:[390,768,1024,1440],max_initial_bytes:8000000},interaction:{allowed:['hover','focus','select','linked_view'],replay:[]}};
const raw=[
  {id:'geo',type:'plotly',engine:'plotly',visual_type:'geo_linked',title:'地理差异',dek:'气泡大小代表发电量，颜色代表清洁电力占比。',story_node_ids:['place'],claim_ids:[claims.geo],explanatory_dimension:'spatial',width:'wide',accessibility:{summary:'地理气泡图比较国家清洁电力占比。',long_description:'气泡位于国家代表性经纬度，大小代表发电量，颜色代表清洁电力占比；位置是地理坐标，不是行政边界数据。'},evidence_binding:binding('computation','geo',{lon:'lon',lat:'lat',label:'label',size:'size',color:'color'}),view_spec:{projection:'natural earth',colorbar_title:'清洁电力 %'}},
  {id:'flow',type:'plotly',engine:'plotly',visual_type:'sankey',title:'能源流向',dek:'来源流向化石或可再生分类。',story_node_ids:['flow'],claim_ids:[claims.flow],explanatory_dimension:'flow',width:'half',accessibility:{summary:'Sankey 展示能源来源流向分类。',long_description:'煤炭和天然气流向化石能源，风电和太阳能流向可再生能源，宽度代表 TWh。'},evidence_binding:binding('computation','flow',{source:'source',target:'target',value:'value'}),view_spec:{node_pad:18,node_thickness:18}},
  {id:'network',type:'model',engine:'native_canvas',visual_type:'network',title:'关系层',dek:'节点位置是可复现的示意布局，不表达地理或因果。',story_node_ids:['network'],claim_ids:[claims.network],explanatory_dimension:'network',width:'half',accessibility:{summary:'网络图连接国家、清洁电力、碳强度和能源流向。',long_description:'边表示已定义的关系；节点大小按连接度变化；圆形位置是确定性示意布局，不表示地图坐标、因果或时间。'},evidence_binding:binding('computation','network',{source:'source',target:'target',label:'label',weight:'weight'}),view_spec:{label_policy:'key'}},
];
const modules=raw.map((m,i)=>buildEvidenceBoundModule(m,rows[['geo','flow','network'][i]]));
const aliasGeo=buildEvidenceBoundModule({id:'geo-alias',type:'plotly',visual_type:'geo_linked',evidence_binding:{kind:'computation',field_mapping:{country_field:'country',value_field:'clean_share',size_field:'generation'}},view_spec:{}},[
  {country:'Norway',clean_share:98.5,generation:153.6},
  {country:'China',clean_share:35.2,generation:9456.4},
]);
const aliasTrace=aliasGeo.spec.figure.data[0];
if(aliasTrace.locationmode!=='country names'||aliasTrace.locations?.length!==2||aliasTrace.marker?.color?.[0]!==98.5||aliasTrace.marker?.size?.[1]!==9456.4) throw new Error('geo country_field/value_field alias binding failed');
const spec={...base,modules};
const errors=validatePublicationSpec(spec); if(errors.length)throw new Error(errors.join(' | '));
const rendered=renderPublication(spec,{includePlotly:true,includeD3:false});
fs.writeFileSync(path.join(OUT,'index.html'),rendered.html);
fs.writeFileSync(path.join(OUT,'manifest.json'),JSON.stringify(rendered.manifest,null,2)+'\n');
console.log(JSON.stringify({status:'PASS',output:path.join(OUT,'index.html'),bytes:rendered.manifest.initial_bytes,self_contained:rendered.manifest.self_contained,evidence_bound:rendered.manifest.evidence_bound,style_profile:rendered.manifest.style_profile,markers:{geo:rendered.html.includes('scattergeo'),sankey:rendered.html.includes('sankey'),network:rendered.html.includes('renderNetwork'),japanese:rendered.html.includes('asymmetric_editorial')},modules:modules.map(m=>({id:m.id,type:m.type,visual_type:m.visual_type,row_count:m._a11y_rows.length}))},null,2));
