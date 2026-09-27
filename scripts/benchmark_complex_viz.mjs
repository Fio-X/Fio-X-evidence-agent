#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { lintVizSpec, renderVizBundle, critiqueViz } from "../runtime/pi/viz.mjs";

const claimId="claim-bench-complex";
const base={schema_version:"0.8.0",takeaway:"Complex benchmark",title:"Complex visual journalism benchmark",alt:"Complex visual journalism benchmark fixture with topology-aware rendering.",source_note:"Synthetic benchmark data",claim_id:claimId,sql:"SELECT * FROM synthetic",unit:"units",complexity_budget:"medium",annotations:[],highlight_values:[]};

const flowRows=[];
for(let i=0;i<6;i++)flowRows.push({source:`Source ${i+1}`,target:"Hub",value:20+i*4});
for(let i=0;i<10;i++)flowRows.push({source:"Hub",target:`Sector ${i+1}`,value:8+i});
const networkRows=[];
for(let i=0;i<28;i++){networkRows.push({source:`N${i}`,target:`N${(i+3)%28}`,value:1+(i%5)});networkRows.push({source:`N${i}`,target:`N${(i+7)%28}`,value:1+(i%3)});}
const hierarchyRows=[{node:"Root",parent:null}];
for(let i=0;i<5;i++){hierarchyRows.push({node:`L1-${i}`,parent:"Root"});for(let j=0;j<5;j++)hierarchyRows.push({node:`L2-${i}-${j}`,parent:`L1-${i}`});}
const timelineRows=Array.from({length:28},(_,i)=>({date:`202${Math.floor(i/12)+2}-${String(i%12+1).padStart(2,"0")}-01`,event:`Milestone ${i+1}`}));
const streamRows=["A","B","C","D","E","F"].flatMap((series,si)=>Array.from({length:20},(_,i)=>({year:2005+i,series,value:10+si*4+(i%4)*2+i*(si%2?.4:.2)})));
const logScatter=Array.from({length:80},(_,i)=>({label:`P${i+1}`,x:1000*Math.pow(1.07,i),y:55+Math.log(i+1)*5+(i%4)}));
const cases=[
 ["sankey",{...base,reader_task:"flow",visual_family:"flow",data_topology:"flow_edges",chart_type:"sankey",source_field:"source",target_field:"target",value_field:"value"},flowRows],
 ["alluvial",{...base,reader_task:"flow",visual_family:"flow",data_topology:"flow_edges",chart_type:"alluvial",source_field:"source",target_field:"target",value_field:"value"},flowRows],
 ["node_link",{...base,reader_task:"relationship",visual_family:"relationship",data_topology:"graph_edges",chart_type:"node_link",source_field:"source",target_field:"target",value_field:"value"},networkRows],
 ["adjacency_matrix",{...base,reader_task:"relationship",visual_family:"relationship",data_topology:"graph_edges",chart_type:"adjacency_matrix",source_field:"source",target_field:"target",value_field:"value"},networkRows],
 ["hierarchy_tree",{...base,reader_task:"hierarchy",visual_family:"hierarchy",data_topology:"hierarchy",chart_type:"hierarchy_tree",node_field:"node",parent_field:"parent"},hierarchyRows],
 ["timeline",{...base,reader_task:"sequence",visual_family:"temporal",data_topology:"events",chart_type:"timeline",x_field:"date",label_field:"event"},timelineRows],
 ["streamgraph",{...base,reader_task:"change",visual_family:"temporal",data_topology:"tabular",chart_type:"streamgraph",x_field:"year",series_field:"series",value_field:"value"},streamRows],
 ["log_scatter",{...base,reader_task:"correlation",visual_family:"statistical",data_topology:"tabular",chart_type:"scatter",x_field:"x",y_field:"y",label_field:"label",x_scale:"log",x_unit:"$",y_unit:"years",unit:"years"},logScatter],
];
const iterations=Number(process.env.NEWSROOM_COMPLEX_BENCH_ITERATIONS||100),budget=Number(process.env.NEWSROOM_COMPLEX_VIZ_P95_MS||18),all=[];
console.log(`complex viz benchmark: ${cases.length} families x ${iterations} iterations`);
for(const [name,spec,rows] of cases){const lint=lintVizSpec(spec,rows,{verified_claim_ids:[claimId]});if(!lint.passed)throw new Error(`${name}: ${lint.blockers.join(" | ")}`);renderVizBundle(spec,rows);const local=[];for(let i=0;i<iterations;i++){const t=performance.now();const l=lintVizSpec(spec,rows,{verified_claim_ids:[claimId]});const bundle=renderVizBundle(spec,rows);critiqueViz(spec,rows,l,bundle.desktop);critiqueViz(spec,rows,l,bundle.mobile);const ms=performance.now()-t;local.push(ms);all.push(ms);}local.sort((a,b)=>a-b);console.log(`${name.padEnd(18)} p50=${local[Math.floor(local.length*.5)].toFixed(3)}ms p95=${local[Math.min(local.length-1,Math.floor(local.length*.95))].toFixed(3)}ms`);}
all.sort((a,b)=>a-b);const p50=all[Math.floor(all.length*.5)],p95=all[Math.min(all.length-1,Math.floor(all.length*.95))],max=all.at(-1);console.log(`overall p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms budget=${budget.toFixed(1)}ms`);if(p95>budget){console.error("complex performance budget: FAIL");process.exit(2);}console.log("complex performance budget: PASS");
