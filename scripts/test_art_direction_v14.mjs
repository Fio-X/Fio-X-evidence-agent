#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { planEditorialAssets, validateExternalAssetManifest, retrieveReferencePatterns, evaluateExpertPreference, summarizeAwardMode } from '../runtime/pi/art_direction.mjs';
import { illustrationAdapterRequest, lintIllustrationSpec, normalizeIllustrationAdapterResponse, critiqueRichIllustration } from '../runtime/pi/illustration.mjs';

const sourceMeta=JSON.parse(await readFile(new URL('../fixtures/external/naturalearth_lowres/SOURCE.json',import.meta.url),'utf8'));
assert.match(sourceMeta.official_source_url,/110m-admin-0-countries/);
assert.match(sourceMeta.upstream_lineage,/does not expose an authoritative upstream version number/);

const blocked = planEditorialAssets({concept_ref:'editorial/concepts/nasa.json',concept_id:'spatial-globe',requirements:[
  {id:'anomaly-grid',asset_class:'published_gis',status:'blocking',available:false,purpose:'Map gridded anomaly field',production_lane:'gis_render',evidence_needed:'Published gridded anomaly geometry'}
]});
assert.equal(blocked.decision,'RESEARCH_MORE');
const supported = planEditorialAssets({concept_ref:'editorial/concepts/nasa.json',concept_id:'measurement-map',requirements:[
  {id:'world-context',asset_class:'published_gis',status:'required',available:true,purpose:'World geographic context for the global measurement scene',production_lane:'gis_render',source_refs:['fixtures/external/naturalearth_lowres/naturalearth_lowres.shp']}
]});
assert.equal(supported.decision,'CONTINUE');

const spec={schema_version:'0.2.0',title:'Global observation context',subject:'World geographic context for the NASA GISTEMP measurement system',intent:'Provide a recognizable global scaffold without inventing station positions or anomaly geography.',alt:'World geographic scaffold derived from Natural Earth Admin 0 country polygons for NASA GISTEMP source categories; observation locations, station density and anomaly intensity are not encoded.',style_direction:'Restrained editorial GIS context, no invented observation points.',aspect_ratio:'landscape',origin_policy:'software_only',source_note:'Natural Earth low-resolution Admin 0 country polygons; NASA GISTEMP source-category description.',credit:'Made with Natural Earth; newsroom GIS render',claim_ids:['claim-nasa-gistemp-2025'],evidence_refs:['fixtures/external/naturalearth_lowres/naturalearth_lowres.shp'],factual_elements:[{id:'global-context',label:'Global land context',claim_ids:['claim-nasa-gistemp-2025']}],constraints:['Do not encode observation positions or density.']};
const lint=lintIllustrationSpec(spec,{verified_claim_ids:['claim-nasa-gistemp-2025'],evidence_refs:spec.evidence_refs});
assert.equal(lint.passed,true,lint.blockers.join(' | '));
const request=illustrationAdapterRequest(spec,{evidence_snapshot_hash:'nasa-fixture'});
const proc=spawnSync('python3',['scripts/natural_earth_map_adapter.py'],{input:JSON.stringify(request),encoding:'utf8'});
assert.equal(proc.status,0,proc.stderr);
const response=JSON.parse(proc.stdout);
assert.match(response.metadata.source_url,/110m-admin-0-countries/);
const normalized=normalizeIllustrationAdapterResponse(spec,response);
assert.equal(normalized.provenance.origin,'software');
assert.equal(normalized.provenance.digital_source_type,'algorithmicMedia');
const critic=critiqueRichIllustration(spec,{provenance:normalized.provenance},{desktop:normalized.desktop,mobile:normalized.mobile});
assert.equal(critic.passed,true,JSON.stringify(critic));
const sourceSha=response.metadata.source_sha256;
const outputSha=createHash('sha256').update(normalized.desktop).digest('hex');
const manifest={asset_id:'natural-earth-world-context',asset_class:'published_gis',production_lane:'gis_render',source_url:response.metadata.source_url,license:response.license,credit:response.metadata.credit,origin:'software',source_sha256:sourceSha,output_sha256:outputSha};
assert.deepEqual(validateExternalAssetManifest(manifest),[]);

const corpus=JSON.parse(await readFile(new URL('../fixtures/reference-patterns-v1.4.json',import.meta.url),'utf8')).patterns;
const refs=retrieveReferencePatterns({corpus,tags:['spatial','mechanism','scene'],limit:4});
assert.ok(refs.matches.some((item)=>item.id==='scmp-integrated-explainer'));
assert.ok(refs.matches.every((item)=>item.retrieval_score>0));

const pending=evaluateExpertPreference({baseline_ref:'outputs/nasa-gistemp-realdata/nasa-gistemp-feature.png',candidate_ref:'outputs/nasa-gistemp-v14/nasa-gistemp-v14.png',minimum_reviewers:3,candidate_threshold:0.7,reviews:[]});
assert.equal(pending.status,'PENDING');
assert.equal(pending.human_evidence_required,true);
const awardStatus=summarizeAwardMode({discovery_ref:'editorial/discovery/nasa.json',concepts_ref:'editorial/concepts/nasa.json',asset_plan_ref:'editorial/assets/nasa.json',novelty_ref:'editorial/novelty/nasa.json',page_ref:'infographics/nasa.json',preference_ref:'editorial/preferences/nasa.json',preference_status:pending.status,metrics:{concepts_generated:8,concepts_killed:5,research_gap_requests:1,prototype_count:2,raster_revision_count:1,provider_tokens:0,provider_cost_usd:0,wall_time_ms:0,human_review_count:0}});
assert.equal(awardStatus.status,'READY_FOR_HUMAN');
assert.equal(awardStatus.human_evidence_required,true);
console.log('art-direction support tests: PASS');
console.log(`asset_decision=${supported.decision} origin=${normalized.provenance.origin} reference_matches=${refs.matches.length} preference=${pending.status}`);
