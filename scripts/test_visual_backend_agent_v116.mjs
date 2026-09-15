#!/usr/bin/env node
import assert from 'node:assert/strict';
import { planVisualBackend, visualSkillForBackend, visualSkill, detectGraphExtractionRuntimeHealth, VISUAL_BACKEND_PROFILES } from '../runtime/pi/visual_backends.mjs';
const availability=Object.fromEntries(Object.keys(VISUAL_BACKEND_PROFILES).map(k=>[k,true]));
let p=planVisualBackend({story_family:'maritime_trajectory',mark_count:15,label_count:80,geographic:true,geographic_scale:'local',print:true},{availability});
assert.equal(p.primary_backend,'qgis_cartography');
assert.equal(visualSkillForBackend(p.primary_backend).name,'qgis-cartography');
assert.equal(p.design_system.id,'movement');
p=planVisualBackend({story_family:'knowledge_graph',mark_count:12000,network:true,interactive:true},{availability});
assert.equal(p.primary_backend,'sigma_graph');
assert.equal(visualSkillForBackend(p.primary_backend).name,'sigma-network');
assert.equal(p.design_system.id,'network');
p=planVisualBackend({story_family:'ais_density',mark_count:2_000_000,geographic:true,geographic_scale:'regional',print:true},{availability});
assert.equal(p.primary_backend,'datashader_density');
assert.equal(p.design_system.id,'scientific');
p=planVisualBackend({story_family:'general',design_context:'investigative'},{availability}); assert.equal(p.design_system.id,'investigative');
assert.equal(visualSkill('graph-extraction').name,'graph-extraction');
assert.equal(typeof detectGraphExtractionRuntimeHealth().graphrag,'boolean');
console.log('visual backend agent v1.16 PASS');
