#!/usr/bin/env node
import assert from 'node:assert/strict';import {evaluateQualityEvidence,assertNoAutonomousAwardPass} from '../runtime/pi/quality.mjs';
const machine=evaluateQualityEvidence({hard_gates:[{id:'provenance',passed:true}],diagnostics:[{id:'hierarchy',score:100}],human_evidence:[]});
assert.equal(machine.publication.status,'PASS');assert.equal(machine.competition_readiness.status,'PENDING');assertNoAutonomousAwardPass(machine);
const human=evaluateQualityEvidence({hard_gates:[{id:'provenance',passed:true}],human_evidence:[{reviewer_ref:'blind-r1',qualified:true,result:'preferred'}]});
assert.equal(human.competition_readiness.status,'REVIEWABLE');assertNoAutonomousAwardPass(human);
console.log('quality evidence v1.6.1 PASS');
