#!/usr/bin/env node
import fs from 'node:fs';
import { loadDesignSystems, resolveDesignSystem, designDiversityDiagnostics } from '../runtime/visual/design_systems.mjs';
const c=loadDesignSystems();
if(c.systems.length<6)throw new Error('expected at least six editorial design systems');
const manifest=JSON.parse(fs.readFileSync('fixtures/benchmarks/v2/manifest.json','utf8'));
const rows=manifest.cases.map(x=>({id:x.id,design_system_id:resolveDesignSystem({story_id:x.id,story_family:x.story_family,analytical_job:x.recipe?.analytical_job}).id}));
const d=designDiversityDiagnostics(rows);
if(d.status!=='PASS')throw new Error(`design diversity failed: ${JSON.stringify(d)}`);
if(resolveDesignSystem({story_id:'syros_ais_local',story_family:'maritime_trajectory'}).id!=='movement')throw new Error('movement routing failed');
if(resolveDesignSystem({story_id:'complex_network_fixture',story_family:'static_network'}).id!=='network')throw new Error('network routing failed');
if(resolveDesignSystem({story_id:'titanic_survival_class',story_family:'statistical_editorial'}).id!=='investigative')throw new Error('investigative routing failed');
console.log('design systems v1.32: PASS',JSON.stringify(d));
