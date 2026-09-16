#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {validateModelSpec} from '../runtime/visual/model_spec.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const model=JSON.parse(fs.readFileSync(path.join(ROOT,'outputs/v19-browser/energy-model.json'),'utf8'));
const pass=validateModelSpec(model);assert.equal(pass.status,'PASS');assert.ok(pass.residuals.every(r=>r.residual===0));
const bad=structuredClone(model);const edge=bad.flows.find(x=>x.source==='U.S. primary energy'&&x.target==='End-use sectors');edge.value-=1;
const blocked=validateModelSpec(bad);assert.equal(blocked.status,'BLOCK');assert.ok(blocked.errors.some(x=>x.includes('flow conservation failed')));
const mixed=structuredClone(model);mixed.flows[0].unit='percent';const mixedGate=validateModelSpec(mixed);assert.equal(mixedGate.status,'BLOCK');assert.ok(mixedGate.errors.some(x=>x.includes('units must match')));
console.log(JSON.stringify({status:'PASS',valid_residuals:pass.residuals,blocked_errors:blocked.errors,mixed_unit_errors:mixedGate.errors},null,2));
