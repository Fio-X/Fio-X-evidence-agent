#!/usr/bin/env node
import { resolveDesignSystem } from '../runtime/visual/design_systems.mjs';
import { applyArtDirectionPatchV2 } from '../runtime/visual/art_direction_replay.mjs';
const semantic='a'.repeat(64); const ds=resolveDesignSystem({story_id:'nasa_climate_trend',story_family:'statistical_editorial'});
const req={schema_version:'1.1.0',backend:'python_publication',story_id:'nasa_climate_trend',semantic_fingerprint:semantic,evidence_hashes:{'e.csv':'b'.repeat(64)},claim_ids:['c1'],inputs:{table:'e.csv'},options:{renderer:'editorial_chart',title:'A factual title'},template:null,design_system:ds};
const patch={schema_version:'2.0.0',patch_id:'p1',story_id:req.story_id,backend:'python_publication',base_semantic_fingerprint:semantic,base_design_system_hash:ds.content_hash,operations:[{target_id:`story:${req.story_id}:title`,field:'title_size',value:26},{target_id:`story:${req.story_id}:canvas`,field:'layout_margins',value:{outer_left:.06,outer_right:.95}}]};
const a=applyArtDirectionPatchV2(req,patch); if(a.status!=='APPLIED')throw new Error(JSON.stringify(a)); if(a.request.options.title!=='A factual title')throw new Error('patch changed protected title content'); if(a.request.semantic_fingerprint!==semantic)throw new Error('semantic fingerprint changed'); if(a.request.options.title_size!==26||a.request.design_system.tokens.outer_left!==.06)throw new Error('presentation patch did not apply');
const bad={...patch,base_semantic_fingerprint:'c'.repeat(64)}; const b=applyArtDirectionPatchV2(req,bad); if(b.status!=='INVALIDATED_SEMANTICS')throw new Error('semantic invalidation failed');
console.log('art direction replay v1.34: PASS');
