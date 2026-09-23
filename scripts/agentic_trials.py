#!/usr/bin/env python3
"""Run repeated live agentic qualifications and summarize cross-run reliability."""
from __future__ import annotations
import argparse, json, math, os, statistics, subprocess, time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MIN_TRIALS=3

def newest_artifact(root: Path):
    dirs=[p for p in root.iterdir() if p.is_dir()] if root.is_dir() else []
    return max(dirs,key=lambda p:p.stat().st_mtime) if dirs else None

def first_numeric(metrics: dict, needles: tuple[str,...]):
    for key,value in metrics.items():
        if isinstance(value,(int,float)) and not isinstance(value,bool) and all(token in key.lower() for token in needles):
            return value
    return None

def trial_row(index: int, exit_code: int, artifact: Path|None, qual: dict, wall_ms: int):
    checks=qual.get('checks') or {}
    usage=qual.get('usage_metrics') or {}
    passed=exit_code==0 and qual.get('qualification_type')=='agentic' and qual.get('status')=='PASS' and qual.get('passed') is True
    return {
        'trial': index,
        'exit_code': exit_code,
        'passed': passed,
        'task_success': passed,
        'claim_correctness': qual.get('unsupported_verified_claims',1)==0 and qual.get('verified_source_and_computation_claims',0)>=1,
        'provenance_integrity': checks.get('verified_source_and_computation_claim') is True and checks.get('unsupported_verified_claims_zero') is True,
        'recovery_success': checks.get('hidden_tool_failure_recovery') is True,
        'autonomous_execution': checks.get('causal_autonomous_execution') is True,
        'adaptive_replanning': checks.get('adaptive_replanning') is True,
        'provider': qual.get('provider'),
        'model': qual.get('model'),
        'source_commit': qual.get('source_commit'),
        'scenario_id': qual.get('scenario_id'),
        'artifact': str(artifact) if artifact else None,
        'wall_ms': wall_ms,
        'input_tokens': first_numeric(usage,('input','token')),
        'output_tokens': first_numeric(usage,('output','token')),
        'total_tokens': first_numeric(usage,('total','token')),
        'cost': first_numeric(usage,('cost',)),
        'qualification': qual,
    }

def reliability_summary(rows: list[dict]):
    n=len(rows)
    passed=sum(1 for row in rows if row['passed'])
    rate=passed/n if n else 0.0
    pass_at_k={}
    pass_pow_k={}
    for k in range(1,n+1):
        misses=n-passed
        miss_combo=math.comb(misses,k) if misses>=k else 0
        total_combo=math.comb(n,k)
        pass_at_k[str(k)]=1.0-(miss_combo/total_combo if total_combo else 1.0)
        pass_pow_k[str(k)]=rate**k

    configs=[(row.get('provider'),row.get('model'),row.get('source_commit'),row.get('scenario_id')) for row in rows]
    configuration_complete=bool(configs) and all(all(isinstance(v,str) and v.strip() for v in cfg) for cfg in configs)
    configuration_consistent=configuration_complete and len(set(configs))==1
    minimum_trials_satisfied=n>=MIN_TRIALS

    numeric=lambda key:[row[key] for row in rows if isinstance(row.get(key),(int,float)) and not isinstance(row.get(key),bool)]
    def stats(key):
        vals=numeric(key)
        if not vals:
            return {'count':0,'total':None,'mean':None,'median':None,'min':None,'max':None,'mad':None}
        median=statistics.median(vals)
        return {
            'count':len(vals),
            'total':sum(vals),
            'mean':sum(vals)/len(vals),
            'median':median,
            'min':min(vals),
            'max':max(vals),
            'mad':statistics.median([abs(value-median) for value in vals]),
        }

    consistency={
        'claim_correctness_rate':sum(bool(r['claim_correctness']) for r in rows)/n if n else 0.0,
        'provenance_integrity_rate':sum(bool(r['provenance_integrity']) for r in rows)/n if n else 0.0,
        'recovery_success_rate':sum(bool(r['recovery_success']) for r in rows)/n if n else 0.0,
        'autonomous_execution_rate':sum(bool(r['autonomous_execution']) for r in rows)/n if n else 0.0,
        'adaptive_replanning_rate':sum(bool(r['adaptive_replanning']) for r in rows)/n if n else 0.0,
    }
    all_pass=minimum_trials_satisfied and configuration_consistent and passed==n and n>0
    cfg=configs[0] if configuration_consistent else (None,None,None,None)
    return {
        'schema_version':'1.2.0',
        'qualification_type':'agentic_reliability',
        'status':'PASS' if all_pass else 'FAIL',
        'minimum_trials':MIN_TRIALS,
        'minimum_trials_satisfied':minimum_trials_satisfied,
        'configuration_consistent':configuration_consistent,
        'provider':cfg[0],
        'model':cfg[1],
        'source_commit':cfg[2],
        'scenario_id':cfg[3],
        'trials':n,
        'passed':passed,
        'pass_rate':rate,
        'all_pass':all_pass,
        'pass_at_k':pass_at_k,
        'pass_pow_k':pass_pow_k,
        'consistency':consistency,
        'wall_ms':stats('wall_ms'),
        'input_tokens':stats('input_tokens'),
        'output_tokens':stats('output_tokens'),
        'total_tokens':stats('total_tokens'),
        'cost':stats('cost'),
        'rows':rows,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--trials',type=int,default=MIN_TRIALS)
    ap.add_argument('--out',type=Path,default=ROOT/'.newsroom'/'agentic-trials')
    ap.add_argument('--qualification-files',type=Path,nargs='*',help='summarize existing qualification JSON files instead of running live trials')
    a=ap.parse_args()
    a.out.mkdir(parents=True,exist_ok=True)
    rows=[]
    if a.qualification_files is not None:
        if len(a.qualification_files)<MIN_TRIALS:
            print(f'at least {MIN_TRIALS} qualification files are required for repeated reliability evidence')
            return 2
        for i,path in enumerate(a.qualification_files,1):
            qual=json.loads(path.read_text())
            rows.append(trial_row(i,0 if qual.get('status')=='PASS' else 2,path.parent,qual,int(qual.get('agent_wall_ms_total',0) or 0)))
    else:
        if a.trials<MIN_TRIALS:
            print(f'--trials must be >= {MIN_TRIALS}')
            return 2
        for i in range(1,a.trials+1):
            trial=a.out/f'trial-{i:02d}'
            env=os.environ.copy(); env['NEWSROOM_AGENTIC_OUT']=str(trial)
            started=time.time(); proc=subprocess.run([str(ROOT/'scripts'/'agentic_qualification.sh')],cwd=ROOT,env=env,check=False)
            artifact=newest_artifact(trial)
            qual={}
            if artifact and (artifact/'agentic-qualification.json').is_file():
                qual=json.loads((artifact/'agentic-qualification.json').read_text())
            rows.append(trial_row(i,proc.returncode,artifact,qual,round((time.time()-started)*1000)))
    out=reliability_summary(rows)
    (a.out/'summary.json').write_text(json.dumps(out,indent=2)+'\n')
    representative=a.out/'agentic-qualification.json'
    if representative.exists():
        representative.unlink()
    if out['all_pass'] and rows and isinstance(rows[0].get('qualification'),dict):
        representative.write_text(json.dumps(rows[0]['qualification'],indent=2)+'\n')
    print(json.dumps(out,indent=2))
    return 0 if out['all_pass'] else 2
if __name__=='__main__': raise SystemExit(main())
