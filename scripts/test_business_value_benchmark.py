#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
metrics={
 'time_to_first_defensible_claim_ms':[1000,1200,1100],
 'time_to_final_deliverable_ms':[3000,3300,3100],
 'source_count':[5,6,5],
 'verified_claim_rate':[1.0,0.9,1.0],
 'human_interventions':[1,1,0],
 'editorial_corrections':[0,1,0],
 'model_cost':[0.20,0.25,0.22],
}
baseline={
 'time_to_first_defensible_claim_ms':[4000,4500,4200],
 'time_to_final_deliverable_ms':[9000,9500,9200],
 'source_count':[4,4,5],
 'verified_claim_rate':[0.8,0.9,0.8],
 'human_interventions':[3,4,3],
 'editorial_corrections':[2,1,2],
 'model_cost':[0,0,0],
}
def rows(mode, data):
 return {'runs':[{'run_id':f'{mode}-{i+1}','mode':mode,**{key:values[i] for key,values in data.items()}} for i in range(3)]}
with tempfile.TemporaryDirectory() as td:
 td=Path(td); a=td/'agent.json'; b=td/'baseline.json'; out=td/'out.json'
 a.write_text(json.dumps(rows('agent',metrics))); b.write_text(json.dumps(rows('baseline',baseline)))
 proc=subprocess.run([sys.executable,str(ROOT/'scripts/business_value_benchmark.py'),'--agent',str(a),'--baseline',str(b),'--output',str(out)],capture_output=True,text=True)
 assert proc.returncode==0,proc.stdout+proc.stderr
 result=json.loads(out.read_text())
 assert result['agent_runs']==3 and result['baseline_runs']==3
 assert result['agent']['time_to_first_defensible_claim_ms']['median']==1100
 assert result['baseline']['time_to_first_defensible_claim_ms']['median']==4200
 assert result['delta']['time_to_first_defensible_claim_ms']['agent_minus_baseline_median']==-3100
 assert result['agent']['model_cost']['mad']>0
 bad=td/'bad.json'; bad.write_text(json.dumps({'runs':[{'mode':'agent'}]*3}))
 bad_proc=subprocess.run([sys.executable,str(ROOT/'scripts/business_value_benchmark.py'),'--agent',str(bad),'--baseline',str(b),'--output',str(td/'bad-out.json')],capture_output=True,text=True)
 assert bad_proc.returncode!=0
print('business value benchmark contract: PASS')
