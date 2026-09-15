#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { lintVizSpec, renderVizBundle, critiqueViz } from "../runtime/pi/viz.mjs";

const text=await readFile(new URL("../fixtures/realdata/eia-us-energy-flow-2024.csv",import.meta.url),"utf8");
const [head,...lines]=text.trim().split(/\r?\n/);const cols=head.split(",");const rows=lines.map((line)=>{const vals=line.split(",");return {source:vals[0],target:vals[1],quadrillion_btu:Number(vals[2])};});
const claimId="claim-eia-energy-flow-2024";
const spec={
  schema_version:"0.8.0",reader_task:"flow",visual_family:"flow",data_topology:"flow_edges",complexity_budget:"medium",chart_type:"sankey",flow_conservation:"strict",flow_tolerance:0.001,
  takeaway:"U.S. energy consumption in 2024 totaled about 94.2 quadrillion Btu, with 19.3 quads represented as electrical-system losses.",
  title:"How U.S. energy moved from sources to end use in 2024",
  subtitle:"Primary energy consumption and end-use totals, quadrillion Btu",
  alt:"A Sankey diagram shows petroleum, natural gas, renewable energy, nuclear and coal flowing into U.S. primary energy, then to end-use sectors and electrical system energy losses. End-use energy is split among transportation, industrial, residential and commercial sectors.",
  source_note:"U.S. Energy Information Administration, Monthly Energy Review (April 2025), 2024 energy flow",
  note:"This test uses published aggregate source, sector and electrical-loss totals. It does not imply source-specific allocation to each end-use sector.",
  claim_id:claimId,sql:"SELECT source, target, quadrillion_btu FROM read_csv_auto('data/eia-us-energy-flow-2024.csv')",unit:"quadrillion Btu",source_field:"source",target_field:"target",value_field:"quadrillion_btu",highlight_values:["Electrical system energy losses"],annotations:[]
};
const lint=lintVizSpec(spec,rows,{verified_claim_ids:[claimId]});assert.equal(lint.passed,true,lint.blockers.join(" | "));
const sourceTotal=rows.filter((r)=>r.target==="U.S. primary energy").reduce((s,r)=>s+r.quadrillion_btu,0);const outgoing=rows.filter((r)=>r.source==="U.S. primary energy").reduce((s,r)=>s+r.quadrillion_btu,0);const enduse=rows.filter((r)=>r.source==="End-use sectors").reduce((s,r)=>s+r.quadrillion_btu,0);
assert.ok(Math.abs(sourceTotal-94.2)<1e-9);assert.ok(Math.abs(outgoing-94.2)<1e-9);assert.ok(Math.abs(enduse-74.9)<1e-9);
const bundle=renderVizBundle(spec,rows);const desktopCritic=critiqueViz(spec,rows,lint,bundle.desktop),mobileCritic=critiqueViz(spec,rows,lint,bundle.mobile);assert.equal(desktopCritic.passed,true,JSON.stringify(desktopCritic));assert.equal(mobileCritic.passed,true,JSON.stringify(mobileCritic));
await mkdir(new URL("../outputs/complex-realdata/",import.meta.url),{recursive:true});await writeFile(new URL("../outputs/complex-realdata/eia-us-energy-flow-2024.svg",import.meta.url),bundle.desktop);await writeFile(new URL("../outputs/complex-realdata/eia-us-energy-flow-2024.mobile.svg",import.meta.url),bundle.mobile);await writeFile(new URL("../outputs/complex-realdata/eia-us-energy-flow-2024.json",import.meta.url),JSON.stringify({spec,rows,lint,desktop_critic:desktopCritic,mobile_critic:mobileCritic,conservation:{source_total:sourceTotal,primary_outgoing:outgoing,end_use_total:enduse}},null,2)+"\n");
console.log("complex real-data viz: PASS");console.log(`EIA source total=${sourceTotal.toFixed(1)} primary outgoing=${outgoing.toFixed(1)} end-use total=${enduse.toFixed(1)} quads`);console.log(`critic desktop=${desktopCritic.score} mobile=${mobileCritic.score}`);
