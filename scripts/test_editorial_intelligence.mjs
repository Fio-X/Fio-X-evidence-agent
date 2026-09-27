#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assessEditorialDiscovery, tournamentVisualConcepts, scoreSemanticNovelty, validateVisualConcepts } from '../runtime/pi/editorial.mjs';

const thin = assessEditorialDiscovery({
  reader_problem:'Explain why a single annual temperature value matters to a general reader.',
  candidate_questions:['How warm was 2025?','Was 2025 unusual?','Where was the warming concentrated?'],
  surprises:['A global mean can hide large spatial differences.'], counterintuitive_findings:[], human_scale_refs:[], spatial_dimensions:['global spatial pattern'], temporal_dimensions:['annual trend'], mechanisms:[], uncertainties:[],
  missing_reporting:[{need:'Spatial anomaly grid or map-ready data',blocking:true,reason:'The strongest premise depends on geography.'}], kill_reasons:[]
});
assert.equal(thin.decision,'RESEARCH_MORE');
assert.equal(thin.metrics.blocking_reporting_gap_count,1);

const discovery = assessEditorialDiscovery({
  reader_problem:'Explain how the recent temperature record shifted and how NASA knows.',
  candidate_questions:['How far has the baseline shifted?','Is the recent heat persistent month to month?','How is the global anomaly constructed?','Where are observations collected?','What does the 1951-1980 baseline mean?'],
  surprises:['The recent cluster is visible across both annual and monthly scales.'], counterintuitive_findings:['A global anomaly is a comparison with a fixed reference period, not an absolute temperature.'], human_scale_refs:['one degree as a global mean is physically consequential'], spatial_dimensions:['weather stations, ships, buoys and Antarctic stations form a global observation network'], temporal_dimensions:['1980-2025 annual series','2023-2025 monthly series'], mechanisms:['observations are combined into a globally adjusted estimate'], uncertainties:['the fixture does not contain a full gridded anomaly field'],
  missing_reporting:[{need:'Global gridded anomaly map for a spatial hero',blocking:false,reason:'Would strengthen a spatial concept but is not required for the measurement-system concept.'}], kill_reasons:[]
});
assert.equal(discovery.decision,'CONTINUE');

const common = {reader_question:'What changed in the global temperature record?',editorial_premise:'Use verified evidence to explain the long-run shift and the measurement system.',surprise:'Recent heat persists across annual and monthly views.',hero_evidence_refs:['annual-series'],supporting_evidence_refs:['monthly-series','method'],mobile_treatment:'Reveal the hero evidence first, then measurement context in a short authored sequence.',risk_flags:[],reporting_gaps:[],asset_requirements:[],why_memorable:'A single visual premise ties the measured trend to the observation system rather than presenting disconnected cards.'};
const concepts = [
  {...common,concept_id:'measurement-scene',framing:'mechanism',visual_metaphor:'A global measurement instrument built from stations, ships and buoys with the warming line attached as evidence.',hero_scene:'Observation network and long-run signal share one scene.',media_mix:['line','process','object_scene'],why_reject:''},
  {...common,concept_id:'spatial-globe',framing:'spatial',visual_metaphor:'A globe becomes the scaffold for anomalies and observation coverage.',hero_scene:'Globe with spatial annotations and a compact trend rail.',media_mix:['map','line','gis'],asset_requirements:[{kind:'gridded anomaly map',available:false,blocking:true}],why_reject:'Blocked until map-ready evidence is acquired.'},
  {...common,concept_id:'baseline-machine',framing:'object_scene',visual_metaphor:'A physical baseline gauge contrasts the reference climate with recent anomalies.',hero_scene:'Baseline device with years positioned around it.',media_mix:['illustration','line','object'],why_reject:''},
  {...common,concept_id:'calendar-persistence',framing:'temporal',visual_metaphor:'A calendar wall shows persistence across months while the annual line runs as a spine.',hero_scene:'Monthly calendar heat field plus annual spine.',media_mix:['heatmap','line'],why_reject:''},
  {...common,concept_id:'human-scale',framing:'human_scale',visual_metaphor:'A human-scale thermometer analogy explains why a global mean shift matters.',hero_scene:'Human-scale reference with trend evidence.',media_mix:['illustration','line'],why_reject:''},
  {...common,concept_id:'compare-baselines',framing:'comparison',visual_metaphor:'Two baseline worlds are compared side by side.',hero_scene:'1951-1980 reference period versus recent years.',media_mix:['comparison','line'],why_reject:''},
  {...common,concept_id:'progressive-reveal',framing:'progressive_reveal',visual_metaphor:'The story progressively reveals annual, monthly and measurement evidence.',hero_scene:'A sequence of authored frames.',media_mix:['line','heatmap','process'],why_reject:''},
  {...common,concept_id:'generic-dashboard',framing:'comparison',visual_metaphor:'A clean data dashboard with standard charts.',hero_scene:'A collection of charts in a magazine layout.',media_mix:['bar','line','heatmap'],why_memorable:'Clean charts make the data easy to scan.',why_reject:'Technically adequate but generic and weakly story-specific.'}
];
assert.deepEqual(validateVisualConcepts(concepts),[]);
const tournament = tournamentVisualConcepts({discovery_ref:'editorial/discovery/test.json',concepts});
assert.equal(tournament.finalists.length,3);
assert.ok(tournament.rejected.length>=5);
assert.ok(tournament.diversity.framing_count>=3);
assert.notEqual(tournament.selected_concept_id,'generic-dashboard');

const novelty = scoreSemanticNovelty({concept_ref:'editorial/concepts/test.json',modules:[
  {id:'warming-line',reader_question_id:'recent-warming',claim_set:['claim-temp'],new_information:'The long-run series shows recent annual anomalies far above the 1980s range.',explanatory_dimension:'trend',dependency_on:[]},
  {id:'hottest-ranking',reader_question_id:'recent-warming',claim_set:['claim-temp'],new_information:'The top-ranked annual anomalies are concentrated in recent years.',explanatory_dimension:'rank',dependency_on:[]},
  {id:'monthly-heatmap',reader_question_id:'monthly-persistence',claim_set:['claim-temp'],new_information:'Monthly anomalies remain elevated across the calendar in 2023 through 2025.',explanatory_dimension:'distribution',dependency_on:['warming-line']},
  {id:'method',reader_question_id:'measurement-method',claim_set:['claim-method'],new_information:'Land ocean and Antarctic observations feed the global estimate.',explanatory_dimension:'mechanism',dependency_on:[]}
]});
const rankingDecision = novelty.decisions.find((item)=>item.module_id==='hottest-ranking');
assert.equal(rankingDecision.redundancy,'high');
assert.equal(rankingDecision.action,'REMOVE_OR_JUSTIFY');
assert.equal(novelty.decisions.find((item)=>item.module_id==='method').redundancy,'low');
assert.equal(novelty.passed,false);

const revised = scoreSemanticNovelty({concept_ref:'editorial/concepts/test.json',modules:[
  novelty.modules[0], novelty.modules[2], novelty.modules[3],
  {id:'baseline',reader_question_id:'baseline-meaning',claim_set:['claim-baseline'],new_information:'The anomaly compares each year with the fixed 1951-1980 mean.',explanatory_dimension:'context',dependency_on:['warming-line']}
]});
assert.equal(revised.passed,true,JSON.stringify(revised.decisions));

// Repetition can be editorially valid when an overview/detail pair is intentionally linked and justified.
const overviewDetail = scoreSemanticNovelty({concept_ref:'editorial/concepts/test.json',modules:[
  {id:'overview',reader_question_id:'recent-warming',claim_set:['claim-temp'],new_information:'Recent annual temperature anomalies remain at record-high levels.',explanatory_dimension:'trend',dependency_on:[]},
  {id:'detail',reader_question_id:'recent-warming',claim_set:['claim-temp'],new_information:'Recent annual temperature anomalies remain at record-high levels, with the detail panel preserving exact yearly values.',explanatory_dimension:'trend',dependency_on:[],justification:'The detail is intentionally retained as a precise lookup layer beneath the fast-scan overview.'}
]});
const detailDecision=overviewDetail.decisions.find((item)=>item.module_id==='detail');
assert.equal(detailDecision.redundancy,'high');
assert.equal(detailDecision.action,'KEEP_WITH_JUSTIFICATION');
assert.equal(overviewDetail.passed,true);
console.log('editorial intelligence tests: PASS');
console.log(`decision=${discovery.decision} concepts=${concepts.length} finalists=${tournament.finalists.join(',')} rejected=${tournament.rejected.length}`);
console.log(`ranking_overlap=${rankingDecision.max_overlap} revised_average_novelty=${revised.average_novelty}`);
