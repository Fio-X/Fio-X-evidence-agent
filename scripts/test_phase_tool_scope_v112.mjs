#!/usr/bin/env node
import {TOOL_PHASES, VALID_TOOL_PHASES, toolEnabledForPhase, toolEnabled} from '../runtime/pi/tool_phase_policy.mjs';
import {TOOL_REGISTRY} from '../runtime/pi/tool_registry.mjs';
const names=Object.keys(TOOL_PHASES);
if(names.length!==49) throw new Error(`unexpected tool count ${names.length}`);
for(const [name,phase] of Object.entries(TOOL_PHASES)) if(!VALID_TOOL_PHASES.includes(phase)) throw new Error(`invalid phase ${phase} for ${name}`);
if(!toolEnabledForPhase('news_search','discover')) throw new Error('discover should include search');
if(toolEnabledForPhase('duckdb_query','discover')) throw new Error('discover must exclude verify tools');
if(!toolEnabledForPhase('artifact_inventory','publish')) throw new Error('core must be available in every phase');
if(!toolEnabledForPhase('newsroom_publication_render','publish')) throw new Error('publish tool missing');
if(toolEnabledForPhase('newsroom_publication_render','verify_publication')) throw new Error('verify_publication must not expose render tool');
if(!toolEnabledForPhase('newsroom_publication_qa','verify_publication')) throw new Error('QA tool missing from verification phase');
if(toolEnabledForPhase('totally_unknown_tool','all')) throw new Error('unknown tools must fail closed');
if(toolEnabled('newsroom_publication_render',{profile:'investigate'})) throw new Error('investigate profile must hide publication tool');
if(!toolEnabled('duckdb_query',{profile:'investigate'})) throw new Error('investigate profile must include deterministic computation');
if(!toolEnabled('newsroom_chart',{profile:'investigate'})) throw new Error('investigate profile must include fallback chart');
const investigateCount=TOOL_REGISTRY.tools.filter(t=>t.profiles.includes('investigate')).length;
if(investigateCount>15) throw new Error(`investigate profile is too broad: ${investigateCount}`);
console.log(JSON.stringify({status:'PASS',tool_count:names.length,investigate_count:investigateCount,phases:VALID_TOOL_PHASES},null,2));
