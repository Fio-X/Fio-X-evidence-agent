#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { lintVizSpec, renderVizBundle, critiqueViz } from "../runtime/pi/viz.mjs";
const names=["parallel-sets","chord","geo-flow-map","process-schematic"];
const cases=[];
for(const name of names){const f=JSON.parse(await readFile(new URL(`../fixtures/spatial-explanatory/${name}.json`,import.meta.url),"utf8"));cases.push([name,f.spec,f.rows]);}
const iterations=Number(process.env.NEWSROOM_SPATIAL_BENCH_ITERATIONS||140),budget=Number(process.env.NEWSROOM_SPATIAL_VIZ_P95_MS||22),all=[];
console.log(`spatial/explanatory viz benchmark: ${cases.length} families x ${iterations} iterations`);
for(const [name,spec,rows] of cases){const ctx={verified_claim_ids:[spec.claim_id]};const base=lintVizSpec(spec,rows,ctx);if(!base.passed)throw new Error(`${name}: ${base.blockers.join(" | ")}`);renderVizBundle(spec,rows);const local=[];for(let i=0;i<iterations;i++){const t=performance.now();const lint=lintVizSpec(spec,rows,ctx);const bundle=renderVizBundle(spec,rows);critiqueViz(spec,rows,lint,bundle.desktop);critiqueViz(spec,rows,lint,bundle.mobile);const ms=performance.now()-t;local.push(ms);all.push(ms);}local.sort((a,b)=>a-b);console.log(`${name.padEnd(20)} p50=${local[Math.floor(local.length*.5)].toFixed(3)}ms p95=${local[Math.min(local.length-1,Math.floor(local.length*.95))].toFixed(3)}ms`);}
all.sort((a,b)=>a-b);const p50=all[Math.floor(all.length*.5)],p95=all[Math.min(all.length-1,Math.floor(all.length*.95))],max=all.at(-1);console.log(`overall p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms budget=${budget.toFixed(1)}ms`);if(p95>budget){console.error("spatial/explanatory performance budget: FAIL");process.exit(2);}console.log("spatial/explanatory performance budget: PASS");
