#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { critiqueViz, lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";

const claimId = "claim-complex-v08";
const base = {
  schema_version: "0.8.0",
  takeaway: "Complex relationship fixture.",
  title: "Complex visual journalism regression fixture",
  subtitle: "Synthetic topology fixture used to exercise deterministic complex-visual rules",
  alt: "A complex relationship visualization used to test flow, network, hierarchy and temporal rendering.",
  source_note: "Synthetic topology regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
  unit: "units",
  complexity_budget: "medium",
  annotations: [],
  highlight_values: [],
};

const flowRows = [
  { source: "Domestic production", target: "Available energy", value: 72 },
  { source: "Imports", target: "Available energy", value: 48 },
  { source: "Available energy", target: "Transformation", value: 70 },
  { source: "Available energy", target: "Direct use", value: 35 },
  { source: "Available energy", target: "Losses", value: 15 },
  { source: "Transformation", target: "Industry", value: 22 },
  { source: "Transformation", target: "Transport", value: 18 },
  { source: "Transformation", target: "Households", value: 25 },
  { source: "Transformation", target: "Transformation losses", value: 5 },
  { source: "Direct use", target: "Industry", value: 12 },
  { source: "Direct use", target: "Transport", value: 8 },
  { source: "Direct use", target: "Households", value: 15 },
];
const sankey = {
  ...base,
  reader_task: "flow",
  visual_family: "flow",
  data_topology: "flow_edges",
  chart_type: "sankey",
  source_field: "source",
  target_field: "target",
  value_field: "value",
  title: "Energy moves from supply through transformation to end use",
  alt: "A Sankey diagram traces energy from domestic production and imports through available energy, transformation and final users.",
  highlight_values: ["Transformation"],
  annotations: [{ type: "node", text: "Transformation is the main conversion stage", claim_id: claimId, match_field: "target", match_value: "Transformation" }],
};
assert.deepEqual(validateVizSpec(sankey), []);
let lint = lintVizSpec(sankey, flowRows, { verified_claim_ids: [claimId] });
assert.equal(lint.passed, true, lint.blockers.join(" | "));
let bundle = renderVizBundle(sankey, flowRows);
assert.match(bundle.desktop, /data-role="flow-link"/);
assert.match(bundle.desktop, /data-role="flow-node"/);
assert.match(bundle.mobile, /data-viewport="mobile"/);
let critic = critiqueViz(sankey, flowRows, lint, bundle.desktop);
assert.equal(critic.passed, true, JSON.stringify(critic));

const negativeFlow = flowRows.map((row, i) => i === 0 ? { ...row, value: -1 } : row);
lint = lintVizSpec(sankey, negativeFlow, { verified_claim_ids: [claimId] });
assert.equal(lint.passed, false);
assert.ok(lint.blockers.some((x) => x.includes("negative flows")));

const cyclicFlow = [...flowRows, { source: "Industry", target: "Available energy", value: 1 }];
lint = lintVizSpec(sankey, cyclicFlow, { verified_claim_ids: [claimId] });
assert.equal(lint.passed, false);
assert.ok(lint.blockers.some((x) => x.includes("acyclic")));
assert.throws(() => renderVizBundle(sankey, cyclicFlow), /acyclic flow graph/);

const strictSankey = { ...sankey, flow_conservation: "strict", flow_tolerance: 0.001 };
const imbalancedFlow = flowRows.map((row) => row.source === "Available energy" && row.target === "Transformation" ? { ...row, value: row.value - 7 } : row);
lint = lintVizSpec(strictSankey, imbalancedFlow, { verified_claim_ids: [claimId] });
assert.equal(lint.passed, false);
assert.ok(lint.blockers.some((x) => x.includes("Flow conservation failed")));

const networkRows = [
  ["Editor", "Data desk", 5], ["Editor", "Politics", 4], ["Data desk", "Graphics", 7], ["Data desk", "Climate", 3],
  ["Graphics", "Climate", 4], ["Politics", "Investigations", 6], ["Investigations", "Legal", 3], ["Legal", "Editor", 2],
  ["Climate", "Science", 5], ["Science", "Graphics", 3], ["Graphics", "Editor", 2], ["Politics", "Graphics", 3],
].map(([source,target,value])=>({source,target,value}));
const nodeLink = { ...base, reader_task:"relationship", visual_family:"relationship", data_topology:"graph_edges", chart_type:"node_link", source_field:"source", target_field:"target", value_field:"value", title:"A newsroom relationship network", alt:"A node-link network shows connections between desks and editorial functions.", highlight_values:["Data desk"] };
lint = lintVizSpec(nodeLink, networkRows, { verified_claim_ids:[claimId] });
assert.equal(lint.passed,true,lint.blockers.join(" | "));
bundle = renderVizBundle(nodeLink,networkRows);
assert.match(bundle.desktop,/data-role="network-node"/);
assert.match(bundle.desktop,/data-role="network-edge"/);

const matrix = { ...nodeLink, chart_type:"adjacency_matrix", title:"The same network as a matrix", alt:"An adjacency matrix encodes the same newsroom relationship network as cells." };
lint = lintVizSpec(matrix,networkRows,{verified_claim_ids:[claimId]});
assert.equal(lint.passed,true,lint.blockers.join(" | "));
bundle=renderVizBundle(matrix,networkRows);
assert.match(bundle.desktop,/data-role="matrix-cell"/);
const denseRows=[];
for(let i=0;i<21;i++) for(let k=1;k<=3;k++) denseRows.push({source:`D${i}`,target:`D${(i+k)%21}`,value:1});
const denseLint=lintVizSpec(nodeLink,denseRows,{verified_claim_ids:[claimId]});
assert.equal(denseLint.passed,true,denseLint.blockers.join(" | "));
assert.ok(denseLint.warnings.some((x)=>x.includes("adjacency_matrix")));


const hierarchyRows = [
  { node:"Company", parent:null }, { node:"Newsroom", parent:"Company" }, { node:"Commercial", parent:"Company" },
  { node:"Politics", parent:"Newsroom" }, { node:"Data", parent:"Newsroom" }, { node:"Graphics", parent:"Newsroom" },
  { node:"Sales", parent:"Commercial" }, { node:"Subscriptions", parent:"Commercial" },
];
const tree={...base,reader_task:"hierarchy",visual_family:"hierarchy",data_topology:"hierarchy",chart_type:"hierarchy_tree",node_field:"node",parent_field:"parent",title:"Organisational hierarchy",alt:"A hierarchy tree shows the company, newsroom and commercial branches."};
lint=lintVizSpec(tree,hierarchyRows,{verified_claim_ids:[claimId]});
assert.equal(lint.passed,true,lint.blockers.join(" | "));
bundle=renderVizBundle(tree,hierarchyRows);
assert.match(bundle.desktop,/>Company</);
const badTree=[...hierarchyRows.filter(r=>r.node!=="Company"),{node:"Company",parent:"Graphics"}];
lint=lintVizSpec(tree,badTree,{verified_claim_ids:[claimId]});
assert.equal(lint.passed,false);
assert.ok(lint.blockers.some((x)=>x.includes("root")||x.includes("cycle")));

const timelineRows=[
  { date:"2024-01-01", event:"Policy announced" }, { date:"2024-03-18", event:"First implementation phase" },
  { date:"2024-07-01", event:"Mid-year review" }, { date:"2025-01-01", event:"Second phase begins" },
];
const timeline={...base,reader_task:"sequence",visual_family:"temporal",data_topology:"events",chart_type:"timeline",x_field:"date",label_field:"event",title:"Policy implementation timeline",alt:"A timeline shows four dated milestones from announcement to the second implementation phase."};
lint=lintVizSpec(timeline,timelineRows,{verified_claim_ids:[claimId]});
assert.equal(lint.passed,true,lint.blockers.join(" | "));
bundle=renderVizBundle(timeline,timelineRows);
assert.match(bundle.mobile,/Policy announced/);

const streamRows=["Coal","Gas","Wind","Solar"].flatMap((series,si)=>Array.from({length:8},(_,i)=>({year:2018+i,series,value:Math.max(1,30-si*4+(si-1.2)*i*2+(i%2)*2)})));
const stream={...base,reader_task:"change",visual_family:"temporal",data_topology:"tabular",chart_type:"streamgraph",x_field:"year",series_field:"series",value_field:"value",title:"Energy mix changes over time",alt:"A streamgraph shows the changing relative magnitudes of four energy sources over eight years."};
lint=lintVizSpec(stream,streamRows,{verified_claim_ids:[claimId]});
assert.equal(lint.passed,true,lint.blockers.join(" | "));
bundle=renderVizBundle(stream,streamRows);
assert.match(bundle.desktop,/data-role="stream"/);
const negativeStream=streamRows.map((row,i)=>i===0?{...row,value:-2}:row);
const negativeStreamLint=lintVizSpec(stream,negativeStream,{verified_claim_ids:[claimId]});
assert.equal(negativeStreamLint.passed,false);
assert.ok(negativeStreamLint.blockers.some((x)=>x.includes("negative values")));


const scatterRows=[
  {country:"A",gdp:2500,life:68},{country:"B",gdp:5200,life:72},{country:"C",gdp:16000,life:78},{country:"D",gdp:42000,life:81},{country:"E",gdp:115000,life:84},
];
const scatter={...base,reader_task:"correlation",visual_family:"statistical",data_topology:"tabular",chart_type:"scatter",x_field:"gdp",y_field:"life",label_field:"country",x_scale:"log",x_label:"GDP per capita",y_label:"Life expectancy",x_unit:"$",y_unit:"years",unit:"years",title:"Income and longevity",alt:"A log-scale scatter plot compares GDP per capita with life expectancy across five countries."};
lint=lintVizSpec(scatter,scatterRows,{verified_claim_ids:[claimId]});
assert.equal(lint.passed,true,lint.blockers.join(" | "));
bundle=renderVizBundle(scatter,scatterRows);
assert.match(bundle.desktop,/log scale/);
assert.match(bundle.mobile,/GDP per capita/);
const badLog=lintVizSpec(scatter,[...scatterRows,{country:"Z",gdp:0,life:60}],{verified_claim_ids:[claimId]});
assert.equal(badLog.passed,false);
assert.ok(badLog.blockers.some((x)=>x.includes("positive values")));

if(process.argv.includes("--write-fixtures")){
  await mkdir(new URL("../fixtures/complex/",import.meta.url),{recursive:true});
  const cases=[['sankey',sankey,flowRows],['node-link',nodeLink,networkRows],['matrix',matrix,networkRows],['hierarchy',tree,hierarchyRows],['timeline',timeline,timelineRows],['streamgraph',stream,streamRows],['log-scatter',scatter,scatterRows]];
  for(const [name,spec,rows] of cases){const currentLint=lintVizSpec(spec,rows,{verified_claim_ids:[claimId]});const currentBundle=renderVizBundle(spec,rows);await writeFile(new URL(`../fixtures/complex/${name}.svg`,import.meta.url),currentBundle.desktop);await writeFile(new URL(`../fixtures/complex/${name}.mobile.svg`,import.meta.url),currentBundle.mobile);await writeFile(new URL(`../fixtures/complex/${name}.json`,import.meta.url),JSON.stringify({spec,rows,lint:currentLint},null,2)+"\n");}
}

console.log("complex viz tests: PASS");
console.log("sankey negative-flow blocker: PASS");
console.log("sankey cycle blocker: PASS");
console.log("sankey conservation blocker: PASS");
console.log("node-link + adjacency matrix render/density routing: PASS");
console.log("hierarchy root/cycle checks: PASS");
console.log("timeline + streamgraph render/negative blocker: PASS");
console.log("log scatter: PASS");
