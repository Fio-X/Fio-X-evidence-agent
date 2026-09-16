#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessEditorialDiscovery, scoreSemanticNovelty } from '../runtime/pi/editorial.mjs';

function csv(text) {
  const [head,...rows]=text.trim().split(/\r?\n/).map((line)=>line.split(','));
  return rows.map((row)=>Object.fromEntries(head.map((key,i)=>[key,row[i]])));
}

// Flow/system archetype: real EIA 2024 energy-flow fixture.
const eia=csv(await readFile(new URL('../fixtures/realdata/eia-us-energy-flow-2024.csv',import.meta.url),'utf8'));
const primary=eia.filter((row)=>row.target==='U.S. primary energy');
const primaryTotal=primary.reduce((sum,row)=>sum+Number(row.quadrillion_btu),0);
assert.ok(Math.abs(primaryTotal-94.2)<1e-9);
const eiaDiscovery=assessEditorialDiscovery({
  reader_problem:'Explain where U.S. primary energy enters the system and where useful energy and losses diverge.',
  candidate_questions:['Which sources dominate primary energy?','Where does primary energy go?','How large are electrical-system losses?','Which end-use sectors receive the most energy?'],
  surprises:['Electrical-system losses form a large explicit branch of the national energy balance.'],counterintuitive_findings:[],human_scale_refs:[],spatial_dimensions:[],temporal_dimensions:['2024 annual balance'],mechanisms:['primary energy flows into end-use sectors and electrical-system losses'],uncertainties:['aggregate totals do not support source-specific allocation to sectors'],missing_reporting:[],kill_reasons:[]
});
assert.equal(eiaDiscovery.decision,'CONTINUE');
const eiaRedundant=scoreSemanticNovelty({concept_ref:'editorial/concepts/eia.json',modules:[
  {id:'source-bars',reader_question_id:'source-dominance',claim_set:['eia-primary'],new_information:'Petroleum and natural gas dominate U.S. primary energy consumption.',explanatory_dimension:'rank',dependency_on:[]},
  {id:'source-ranking',reader_question_id:'source-dominance',claim_set:['eia-primary'],new_information:'Petroleum and natural gas are the two largest U.S. primary energy sources.',explanatory_dimension:'rank',dependency_on:[]},
  {id:'system-flow',reader_question_id:'system-destination',claim_set:['eia-balance'],new_information:'Primary energy branches toward end-use sectors and electrical-system losses.',explanatory_dimension:'mechanism',dependency_on:[]}
]});
const eiaDup=eiaRedundant.decisions.find((item)=>item.module_id==='source-ranking');
assert.equal(eiaDup.redundancy,'high');
assert.equal(eiaRedundant.passed,false);
const eiaRevised=scoreSemanticNovelty({concept_ref:'editorial/concepts/eia.json',modules:[eiaRedundant.modules[0],eiaRedundant.modules[2],
  {id:'human-scale-loss',reader_question_id:'loss-scale',claim_set:['eia-balance'],new_information:'The loss branch can be compared with end-use demand to give the aggregate system balance a human-scale interpretation.',explanatory_dimension:'human_scale',dependency_on:['system-flow']}
]});
assert.equal(eiaRevised.passed,true);
assert.ok(eiaRevised.average_novelty>eiaRedundant.average_novelty);

// People/object archetype: real R datasets::Titanic contingency fixture.
const titanic=csv(await readFile(new URL('../fixtures/v09-realdata/titanic-r-datasets.csv',import.meta.url),'utf8'));
const people=titanic.reduce((sum,row)=>sum+Number(row.Freq),0);
assert.equal(people,2201);
const survived=titanic.filter((row)=>row.Survived==='Yes').reduce((sum,row)=>sum+Number(row.Freq),0);
assert.ok(survived>0 && survived<people);
const titanicDiscovery=assessEditorialDiscovery({
  reader_problem:'Explain how class, sex and age shaped survival outcomes for the 2,201 people represented in the historical contingency table.',
  candidate_questions:['How did survival differ by sex?','How did class alter survival?','Did children follow the same pattern?','How can individual people remain visible inside aggregate flows?'],
  surprises:['The contingency table supports intersecting class, sex and age stories rather than one overall survival rate.'],counterintuitive_findings:[],human_scale_refs:['2,201 represented people can be shown as a population rather than an abstract percentage'],spatial_dimensions:[],temporal_dimensions:[],mechanisms:['class, sex and age intersect with survival outcome'],uncertainties:['historical sources do not completely agree on exact totals aboard, rescued or lost'],missing_reporting:[],kill_reasons:[]
});
assert.equal(titanicDiscovery.decision,'CONTINUE');
const titanicRedundant=scoreSemanticNovelty({concept_ref:'editorial/concepts/titanic.json',modules:[
  {id:'overall-rate',reader_question_id:'overall-survival',claim_set:['titanic-survival'],new_information:'The contingency table has one aggregate survival rate across all represented people.',explanatory_dimension:'comparison',dependency_on:[]},
  {id:'overall-donut',reader_question_id:'overall-survival',claim_set:['titanic-survival'],new_information:'The aggregate survival share separates survivors from non-survivors.',explanatory_dimension:'comparison',dependency_on:[]},
  {id:'intersection-flow',reader_question_id:'intersection',claim_set:['titanic-survival','titanic-class-sex-age'],new_information:'Class, sex and age split into sharply different survival paths.',explanatory_dimension:'mechanism',dependency_on:[]}
]});
const titanicDup=titanicRedundant.decisions.find((item)=>item.module_id==='overall-donut');
assert.equal(titanicDup.redundancy,'high');
assert.equal(titanicRedundant.passed,false);
const titanicRevised=scoreSemanticNovelty({concept_ref:'editorial/concepts/titanic.json',modules:[titanicRedundant.modules[0],titanicRedundant.modules[2],
  {id:'people-scale',reader_question_id:'human-scale',claim_set:['titanic-survival'],new_information:'A human-scale population view preserves the fact that each ribbon count represents people, not only a rate.',explanatory_dimension:'human_scale',dependency_on:['intersection-flow']}
]});
assert.equal(titanicRevised.passed,true);
assert.ok(titanicRevised.average_novelty>titanicRedundant.average_novelty);

console.log('v1.4 editorial archetype benchmarks: PASS');
console.log(`EIA total=${primaryTotal.toFixed(1)} quads novelty ${eiaRedundant.average_novelty}->${eiaRevised.average_novelty}`);
console.log(`Titanic total=${people} survived=${survived} novelty ${titanicRedundant.average_novelty}->${titanicRevised.average_novelty}`);
