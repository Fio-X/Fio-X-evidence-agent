#!/usr/bin/env node
import {EDITORIAL_DESIGN_SYSTEMS,resolveEditorialDesignSystem} from '../runtime/pi/editorial_design_system_bundle.mjs';
if(Object.keys(EDITORIAL_DESIGN_SYSTEMS).length<6)throw new Error('bundled design system catalog incomplete');
if(resolveEditorialDesignSystem({story_family:'knowledge_graph'}).id!=='network')throw new Error('graph design routing failed');
if(resolveEditorialDesignSystem({story_family:'maritime_trajectory'}).id!=='movement')throw new Error('movement design routing failed');
if(resolveEditorialDesignSystem({story_family:'general',design_context:'economic'}).id!=='economic')throw new Error('explicit design context failed');
for(const v of Object.values(EDITORIAL_DESIGN_SYSTEMS))if(!/^[a-f0-9]{64}$/.test(v.content_hash))throw new Error('design system hash missing');
console.log('editorial design bundle v1.32: PASS');
