#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {validateModelSpec} from '../runtime/visual/model_spec.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The model is built here by test_browser_publication_v19.mjs, not read from outputs/ (git-ignored, and written there
// by that test only if it happened to run first).
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'newsroom-model-gate-'));process.on('exit',()=>fs.rmSync(tmp,{recursive:true,force:true}));
const built=spawnSync('node',[path.join(ROOT,'scripts','test_browser_publication_v19.mjs'),'--out',path.join(tmp,'v19-browser')],{cwd:ROOT,encoding:'utf8'});
assert.equal(built.status,0,`building the energy model failed:\n${built.stdout}${built.stderr}`);
const model=JSON.parse(fs.readFileSync(path.join(tmp,'v19-browser','energy-model.json'),'utf8'));
const pass=validateModelSpec(model);assert.equal(pass.status,'PASS');assert.ok(pass.residuals.every(r=>r.residual===0));
const bad=structuredClone(model);const edge=bad.flows.find(x=>x.source==='U.S. primary energy'&&x.target==='End-use sectors');edge.value-=1;
const blocked=validateModelSpec(bad);assert.equal(blocked.status,'BLOCK');assert.ok(blocked.errors.some(x=>x.includes('flow conservation failed')));
const mixed=structuredClone(model);mixed.flows[0].unit='percent';const mixedGate=validateModelSpec(mixed);assert.equal(mixedGate.status,'BLOCK');assert.ok(mixedGate.errors.some(x=>x.includes('units must match')));
console.log(JSON.stringify({status:'PASS',valid_residuals:pass.residuals,blocked_errors:blocked.errors,mixed_unit_errors:mixedGate.errors},null,2));
