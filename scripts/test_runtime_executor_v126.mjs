#!/usr/bin/env node
import assert from 'node:assert/strict'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { backendExecutionPlan } from '../runtime/visual/runtime_executor.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); const req='outputs/x/request.json',out='outputs/x/r_editorial';
const native=backendExecutionPlan('python_publication',{requestPath:req,outputDir:out,health:{'viz-python':{status:'AVAILABLE'}}}); assert.equal(native.status,'READY_NATIVE');
const h='1'.repeat(64); const lock={source_commit:'0123456789abcdef',runtimes:{'viz-r':{image:'ghcr.io/example/adn-viz-r:v1.26.0',image_digest:'sha256:'+h,health_status:'PASS'}}};
const container=backendExecutionPlan('r_editorial',{requestPath:req,outputDir:out,health:{'viz-r':{status:'UNAVAILABLE'}},runtimeLock:lock,engine:'docker',caseDir:path.join(root,'outputs/x')}); assert.equal(container.status,'READY_CONTAINER'); assert.ok(container.args.join(' ').includes('@sha256:'+h)); assert.ok(container.args.includes('-v'));
const blocked=backendExecutionPlan('r_editorial',{requestPath:req,outputDir:out,health:{'viz-r':{status:'UNAVAILABLE'}},runtimeLock:null,engine:null,caseDir:path.join(root,'outputs/x')}); assert.equal(blocked.status,'BLOCKED_RUNTIME');
console.log('runtime executor v1.26: PASS');
