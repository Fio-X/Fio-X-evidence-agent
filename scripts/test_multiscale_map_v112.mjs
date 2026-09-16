#!/usr/bin/env node
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateMapSpec} from '../runtime/visual/map_spec.mjs';

const ROOT=resolve(new URL('..', import.meta.url).pathname);
const dir=await mkdtemp(join(tmpdir(),'adn-map-v112-'));
try {
  const request={extent:{west:105,east:115,south:-10,north:0},task:'local',resolution:'i',include_rivers:true,include_boundaries:true};
  const req=join(dir,'request.json'), out=join(dir,'asset.json');
  await writeFile(req,JSON.stringify(request));
  const proc=spawnSync(process.env.NEWSROOM_PYTHON_BIN||'python3',[join(ROOT,'runtime/gis/scientific_basemap_prepare.py'),'--request',req,'--output',out],{encoding:'utf8'});
  if(proc.status!==0) throw new Error(`basemap preparation failed: ${proc.stderr||proc.stdout}`);
  const asset=JSON.parse(await readFile(out,'utf8'));
  if(asset.detail_class!=='intermediate'||!Array.isArray(asset.features)||asset.features.length<1) throw new Error('prepared basemap lacks intermediate physical features');
  const spec={schema_version:'0.2.0',projection:'equirectangular',crs:'EPSG:4326',task:'local',style_intent:'nature_scientific_map',extent:request.extent,basemap_asset:asset,scale:{enabled:true,unit:'km',length_km:100},layers:[{id:'observations',type:'observations',points:[{lon:110,lat:-5}],encoding:{color_scale:'scientific'}}]};
  const good=validateMapSpec(spec); if(good.status!=='PASS') throw new Error(`valid prepared map blocked: ${good.errors.join(' | ')}`);
  const low=structuredClone(spec); low.basemap_asset.detail_class='low'; const lowGate=validateMapSpec(low); if(lowGate.status!=='BLOCK'||!lowGate.errors.some(x=>x.includes('basemap_inadequate'))) throw new Error('low-detail local basemap should block');
  const rainbow=structuredClone(spec); rainbow.layers[0].encoding.color_scale='rainbow'; const rb=validateMapSpec(rainbow); if(rb.status!=='BLOCK'||!rb.errors.some(x=>x.includes('rainbow_color_scale_disallowed'))) throw new Error('rainbow encoding should block');
  console.log(JSON.stringify({status:'PASS',features:asset.features.length,detail_class:asset.detail_class,content_hash:asset.content_hash,low_detail:'BLOCK',rainbow:'BLOCK'},null,2));
} finally { await rm(dir,{recursive:true,force:true}); }
