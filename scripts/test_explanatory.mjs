#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { validateExplanatorySpec, lintExplanatorySpec, renderExplanatoryBundle, critiqueExplanatory } from '../runtime/pi/explanatory.mjs';

const claim='claim-explainer';
const base={
 schema_version:'0.1.0',title:'How the system is layered',subject:'Synthetic system',subtitle:'Semantic explanatory-graphic regression fixture',
 alt:'A schematic explanatory graphic labels the major layers of a synthetic system and explicitly states that geometry is not to scale.',
 source_note:'Synthetic regression fixture',not_to_scale:true,
 parts:[
  {id:'supply',label:'Primary supply',detail:'Inputs enter the system',weight:1,claim_ids:[claim]},
  {id:'conversion',label:'Conversion',detail:'Some inputs change form',weight:1.2,claim_ids:[claim]},
  {id:'use',label:'End use',detail:'Useful output reaches users',weight:1.1,claim_ids:[claim]},
  {id:'loss',label:'Losses',detail:'Some energy exits as losses',weight:.6,claim_ids:[claim]},
 ],
 relationships:[{source:'supply',target:'conversion',label:'feeds'},{source:'conversion',target:'use',label:'serves'},{source:'conversion',target:'loss',label:'loses'}]
};

const snapshots={};
for(const view of ['cutaway','exploded','anatomy','system']){
 const spec={...base,view};
 assert.deepEqual(validateExplanatorySpec(spec),[]);
 const lint=lintExplanatorySpec(spec,{verified_claim_ids:[claim]});assert.equal(lint.passed,true,lint.blockers.join(' | '));
 const bundle=renderExplanatoryBundle(spec);const critic=critiqueExplanatory(spec,bundle);assert.equal(critic.passed,true,JSON.stringify(critic));
 assert.match(bundle.desktop,/SCHEMATIC \/ NOT TO SCALE/);assert.match(bundle.mobile,/SCHEMATIC \/ NOT TO SCALE/);
 snapshots[view]={desktop:createHash('sha256').update(bundle.desktop).digest('hex'),mobile:createHash('sha256').update(bundle.mobile).digest('hex')};
 if(process.argv.includes('--write-fixtures')){
  await mkdir(new URL('../fixtures/explanatory/',import.meta.url),{recursive:true});
  await writeFile(new URL(`../fixtures/explanatory/${view}.svg`,import.meta.url),bundle.desktop);
  await writeFile(new URL(`../fixtures/explanatory/${view}.mobile.svg`,import.meta.url),bundle.mobile);
 }
}
const badScale={...base,view:'cutaway',not_to_scale:false};assert.ok(validateExplanatorySpec(badScale).some(x=>x.includes('not_to_scale')));
const badRel={...base,view:'system',relationships:[{source:'missing',target:'use'}]};assert.equal(lintExplanatorySpec(badRel,{verified_claim_ids:[claim]}).passed,false);
const badClaim={...base,view:'cutaway',parts:base.parts.map((p,i)=>i===0?{...p,claim_ids:['missing-claim']}:p)};assert.equal(lintExplanatorySpec(badClaim,{verified_claim_ids:[claim]}).passed,false);
if(process.argv.includes('--write-fixtures'))await writeFile(new URL('../fixtures/explanatory-snapshots.json',import.meta.url),JSON.stringify(snapshots,null,2)+'\n');
else assert.deepEqual(snapshots,JSON.parse(await readFile(new URL('../fixtures/explanatory-snapshots.json',import.meta.url),'utf8')),'explanatory SVG snapshots changed; review intentionally');
console.log('explanatory graphic tests: PASS');
console.log('views=cutaway,exploded,anatomy,system');
console.log('schematic disclosure + claim gate: PASS');
