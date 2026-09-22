#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'scripts'/'business_value_benchmark.py'
COMMIT='f'*40

def row(mode,index,scenario,source_commit=None):
    out={
        'mode':mode,
        'run_id':f'{mode}-{index}',
        'scenario_id':scenario,
        'time_to_first_defensible_claim_ms':1000+index,
        'time_to_final_deliverable_ms':5000+index,
        'source_count':3+index,
        'verified_claim_rate':1.0,
        'human_interventions':0 if mode=='agent' else 1,
        'editorial_corrections':0,
        'model_cost':0.01*index if mode=='agent' else 0,
    }
    if source_commit is not None:
        out['source_commit']=source_commit
    return out

def write(path,rows):
    path.write_text(json.dumps({'runs':rows},indent=2)+'\n')

def invoke(agent,baseline,out):
    return subprocess.run(
        [sys.executable,str(SCRIPT),'--agent',str(agent),'--baseline',str(baseline),'--output',str(out)],
        cwd=ROOT,capture_output=True,text=True,
    )

def main():
    with tempfile.TemporaryDirectory(prefix='business-benchmark-test-') as tmp:
        root=Path(tmp); agent=root/'agent.json'; baseline=root/'baseline.json'; out=root/'out.json'
        scenarios=['s1','s2','s3']
        good_agent=[row('agent',i+1,s,COMMIT) for i,s in enumerate(scenarios)]
        good_baseline=[row('baseline',i+1,s) for i,s in enumerate(scenarios)]
        write(agent,good_agent); write(baseline,good_baseline)
        ok=invoke(agent,baseline,out)
        if ok.returncode!=0: raise SystemExit(ok.stderr or ok.stdout)
        payload=json.loads(out.read_text())
        assert payload['status']=='MEASURED'
        assert payload['matched_scenarios'] is True
        assert payload['candidate_source_commit']==COMMIT
        assert payload['matched_scenario_ids']==scenarios

        write(agent,good_agent[:2])
        assert invoke(agent,baseline,out).returncode!=0

        bad=[dict(x) for x in good_agent]; bad[0].pop('scenario_id')
        write(agent,bad)
        assert invoke(agent,baseline,out).returncode!=0

        bad=[dict(x) for x in good_baseline]; bad[-1]['scenario_id']='different'
        write(agent,good_agent); write(baseline,bad)
        assert invoke(agent,baseline,out).returncode!=0

        bad=[dict(x) for x in good_agent]; bad[1]['run_id']=bad[0]['run_id']
        write(agent,bad); write(baseline,good_baseline)
        assert invoke(agent,baseline,out).returncode!=0

        bad=[dict(x) for x in good_agent]; bad[-1]['source_commit']='e'*40
        write(agent,bad)
        assert invoke(agent,baseline,out).returncode!=0

    print('business value benchmark contract: PASS')
    return 0
if __name__=='__main__': raise SystemExit(main())
