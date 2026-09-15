export function summarizeVisualQa(reports=[]){
  const rows=reports.filter(Boolean); const counts={PASS:0,ADVISORY:0,BLOCK:0}; const issues={};
  for(const r of rows){ counts[r.status]=(counts[r.status]??0)+1; for(const x of r.issues??[])issues[x]=(issues[x]??0)+1; for(const x of r.hard_failures??[])issues[x]=(issues[x]??0)+1; }
  const status=counts.BLOCK?'BLOCK':counts.ADVISORY?'ADVISORY':'PASS';
  return {schema_version:'2.0.0',status,machine_role:'diagnostic_only',competition_readiness:'UNASSESSED',artifacts:rows.length,counts,issues:Object.fromEntries(Object.entries(issues).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])))};
}
export function assertMachineQaCannotQualify(report){ if(report?.competition_readiness&&report.competition_readiness!=='UNASSESSED') throw new Error('machine visual QA cannot set competition readiness'); return true; }
