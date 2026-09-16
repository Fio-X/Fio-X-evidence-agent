export const QUALITY_EVIDENCE_VERSION='0.1.0';

export function evaluateQualityEvidence({hard_gates=[],diagnostics=[],human_evidence=[]}={}){
  const blockers=hard_gates.filter(g=>g?.passed===false);
  const publication_pass=blockers.length===0;
  const qualifiedHuman=human_evidence.filter(e=>e?.qualified===true&&['preferred','tie','not_preferred'].includes(e?.result));
  const human_ready=qualifiedHuman.length>0;
  return {
    schema_version:QUALITY_EVIDENCE_VERSION,
    publication:{status:publication_pass?'PASS':'BLOCKED',blockers:blockers.map(x=>x.id)},
    diagnostics:{status:'ADVISORY',count:diagnostics.length,items:diagnostics},
    competition_readiness:{status:publication_pass&&human_ready?'REVIEWABLE':'PENDING',reason:publication_pass?(human_ready?'qualified_human_evidence_present':'qualified_human_evidence_required'):'hard_gate_failure'},
    human_evidence_count:qualifiedHuman.length,
  };
}

export function assertNoAutonomousAwardPass(result){
  if(result?.competition_readiness?.status==='PASS')throw new Error('Machine-only quality path may not emit autonomous award PASS');
  return true;
}
