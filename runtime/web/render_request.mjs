#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { compileWebGeoScene } from './maplibre_deckgl.mjs';
import { compileEchartsEditorialScene } from './echarts_editorial.mjs';
import { compileD3EditorialScene } from './d3_editorial.mjs';

function arg(name){ const i=process.argv.indexOf(name); return i>=0?process.argv[i+1]:null; }
function sha(buf){ return crypto.createHash('sha256').update(buf).digest('hex'); }
const reqPath=arg('--request'); if(!reqPath) throw new Error('usage: render_request.mjs --request REQUEST_JSON');
const req=JSON.parse(fs.readFileSync(reqPath,'utf8')); const outdir=req.output_dir; fs.mkdirSync(outdir,{recursive:true});
let manifest;
if(req.backend==='echarts_editorial'){
  const scene=compileEchartsEditorialScene({dataPath:req.inputs?.table,options:req.options??{},designSystem:req.design_system??{}});
  const echarts=await import('echarts');
  const width=Number(req.options?.width||1280),height=Number(req.options?.height||760);
  const option=structuredClone(scene.option);
  if(scene.source_note){
    option.graphic=[...(option.graphic||[]),{type:'text',left:0,bottom:0,style:{text:scene.source_note,font:'11px Arial',fill:'#666'}}];
  }
  const chart=echarts.init(null,null,{renderer:'svg',ssr:true,width,height});
  chart.setOption(option);
  const svg=chart.renderToSVGString(); chart.dispose();
  const svgPath=path.join(outdir,'figure.svg'); fs.writeFileSync(svgPath,svg,'utf8');
  const scenePayload=JSON.stringify(scene,null,2)+'\n'; const scenePath=path.join(outdir,'scene.json'); fs.writeFileSync(scenePath,scenePayload);
  manifest={schema_version:'1.1.0',backend:req.backend,artifact_status:'FINAL',story_id:req.story_id,semantic_fingerprint:req.semantic_fingerprint,evidence_hashes:req.evidence_hashes??{},claim_ids:req.claim_ids??[],renderer:'echarts_ssr_svg',design_system_id:req.design_system?.id??null,design_system_hash:req.design_system?.content_hash??null,width,height,svg:'figure.svg',svg_sha256:sha(Buffer.from(svg)),scene:'scene.json',scene_sha256:sha(Buffer.from(scenePayload))};
}else{
  let scene;
  if(req.backend==='maplibre_deckgl') scene=compileWebGeoScene(req.options?.scene??{});
  else if(req.backend==='sigma_graph') scene={schema_version:'1.0.0',renderer:'sigma_graph',graph_ref:req.inputs?.graph??null,options:req.options??{}};
  else if(req.backend==='canvas_network') scene={schema_version:'1.0.0',renderer:'canvas_network',graph_ref:req.inputs?.graph??null,options:req.options??{}};
  else if(req.backend==='d3_editorial') scene=compileD3EditorialScene({...(req.options??{}),story_node_ids:req.options?.story_node_ids??[],claim_ids:req.claim_ids??[]});
  else throw new Error(`unsupported web backend: ${req.backend}`);
  const payload=JSON.stringify(scene,null,2)+'\n'; const scenePath=path.join(outdir,'scene.json'); fs.writeFileSync(scenePath,payload);
  manifest={schema_version:'1.1.0',backend:req.backend,artifact_status:'SCENE_READY_BROWSER_RENDER_REQUIRED',story_id:req.story_id,semantic_fingerprint:req.semantic_fingerprint,evidence_hashes:req.evidence_hashes??{},claim_ids:req.claim_ids??[],scene:'scene.json',scene_sha256:sha(Buffer.from(payload))};
}
fs.writeFileSync(path.join(outdir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest));
