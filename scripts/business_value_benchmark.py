#!/usr/bin/env python3
"""Aggregate measured human-vs-agent newsroom business-value benchmark runs.

This script never invents benchmark measurements. It consumes externally recorded
run rows and fails closed when required metrics, repeated observations, scenario
matching, or candidate binding are absent.
"""
from __future__ import annotations
import argparse, hashlib, json, statistics
from collections import Counter
from pathlib import Path

REQUIRED = (
    'time_to_first_defensible_claim_ms',
    'time_to_final_deliverable_ms',
    'source_count',
    'verified_claim_rate',
    'human_interventions',
    'editorial_corrections',
    'model_cost',
)

def sha256_file(path: Path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):
            h.update(chunk)
    return h.hexdigest()

def load_rows(path: Path, expected_mode: str, require_source_commit: bool=False):
    payload=json.loads(path.read_text())
    rows=payload.get('runs') if isinstance(payload,dict) else payload
    if not isinstance(rows,list) or len(rows)<3:
        raise SystemExit(f'{path}: at least 3 measured runs are required')
    out=[]; seen_run_ids=set()
    for index,row in enumerate(rows,1):
        if not isinstance(row,dict):
            raise SystemExit(f'{path}: run {index} is not an object')
        mode=row.get('mode',expected_mode)
        if mode != expected_mode:
            raise SystemExit(f'{path}: run {index} mode {mode!r} != {expected_mode!r}')
        scenario_id=row.get('scenario_id')
        if not isinstance(scenario_id,str) or not scenario_id.strip():
            raise SystemExit(f'{path}: run {index} requires non-empty scenario_id')
        run_id=row.get('run_id') or f'{expected_mode}-{index}'
        if run_id in seen_run_ids:
            raise SystemExit(f'{path}: duplicate run_id {run_id!r}')
        seen_run_ids.add(run_id)
        source_commit=row.get('source_commit')
        if require_source_commit and (not isinstance(source_commit,str) or not source_commit.strip()):
            raise SystemExit(f'{path}: agent run {index} requires non-empty source_commit')
        model_cost_source=row.get('model_cost_source')
        if not isinstance(model_cost_source,str) or not model_cost_source.strip():
            raise SystemExit(f'{path}: run {index} requires non-empty model_cost_source')
        normalized_cost_source=model_cost_source.strip().lower()
        if expected_mode=='agent' and normalized_cost_source in {'unknown','unavailable','assumed_zero','missing'}:
            raise SystemExit(f'{path}: agent run {index} model_cost_source is not measured or attributable')
        missing=[key for key in REQUIRED if key not in row or row[key] is None]
        if missing:
            raise SystemExit(f'{path}: run {index} missing metrics: {", ".join(missing)}')
        clean={
            'mode':mode,
            'run_id':str(run_id),
            'scenario_id':scenario_id.strip(),
            'source_commit':source_commit.strip() if isinstance(source_commit,str) and source_commit.strip() else None,
            'model_cost_source':model_cost_source.strip(),
        }
        for key in REQUIRED:
            value=row[key]
            if not isinstance(value,(int,float)) or isinstance(value,bool):
                raise SystemExit(f'{path}: run {index} metric {key} must be numeric')
            if value < 0:
                raise SystemExit(f'{path}: run {index} metric {key} must be >= 0')
            clean[key]=float(value)
        if not 0 <= clean['verified_claim_rate'] <= 1:
            raise SystemExit(f'{path}: run {index} verified_claim_rate must be in [0,1]')
        out.append(clean)
    return out

def summarize(rows):
    summary={}
    for key in REQUIRED:
        values=[row[key] for row in rows]
        median=statistics.median(values)
        summary[key]={
            'count':len(values),
            'median':median,
            'min':min(values),
            'max':max(values),
            'mad':statistics.median([abs(value-median) for value in values]),
        }
    return summary

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--agent',type=Path,required=True)
    ap.add_argument('--baseline',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args()
    agent=load_rows(args.agent,'agent',require_source_commit=True)
    baseline=load_rows(args.baseline,'baseline')
    agent_scenarios={row['scenario_id'] for row in agent}
    baseline_scenarios={row['scenario_id'] for row in baseline}
    if agent_scenarios != baseline_scenarios:
        raise SystemExit(f'scenario mismatch: agent={sorted(agent_scenarios)} baseline={sorted(baseline_scenarios)}')
    agent_counts=Counter(row['scenario_id'] for row in agent)
    baseline_counts=Counter(row['scenario_id'] for row in baseline)
    if agent_counts != baseline_counts:
        raise SystemExit(f'scenario run-count mismatch: agent={dict(agent_counts)} baseline={dict(baseline_counts)}')
    commits={row['source_commit'] for row in agent}
    if len(commits)!=1:
        raise SystemExit(f'agent runs must share one source_commit, got {sorted(commits)}')
    candidate_source_commit=next(iter(commits))

    a=summarize(agent); b=summarize(baseline)
    deltas={key:{
        'agent_minus_baseline_median':a[key]['median']-b[key]['median'],
        'ratio_agent_to_baseline': (a[key]['median']/b[key]['median']) if b[key]['median'] != 0 else None,
    } for key in REQUIRED}
    per_scenario={}
    for scenario_id in sorted(agent_scenarios):
        ar=[row for row in agent if row['scenario_id']==scenario_id]
        br=[row for row in baseline if row['scenario_id']==scenario_id]
        sa=summarize(ar); sb=summarize(br)
        per_scenario[scenario_id]={
            'agent_runs':len(ar),
            'baseline_runs':len(br),
            'agent':sa,
            'baseline':sb,
            'delta':{key:{
                'agent_minus_baseline_median':sa[key]['median']-sb[key]['median'],
                'ratio_agent_to_baseline':(sa[key]['median']/sb[key]['median']) if sb[key]['median'] != 0 else None,
            } for key in REQUIRED},
        }
    payload={
        'schema_version':'1.1.0',
        'status':'MEASURED',
        'required_metrics':list(REQUIRED),
        'agent_runs':len(agent),
        'baseline_runs':len(baseline),
        'matched_scenarios':True,
        'matched_scenario_ids':sorted(agent_scenarios),
        'scenario_run_counts':dict(sorted(agent_counts.items())),
        'candidate_source_commit':candidate_source_commit,
        'raw_inputs':{
            'agent':{'path':str(args.agent),'sha256':sha256_file(args.agent)},
            'baseline':{'path':str(args.baseline),'sha256':sha256_file(args.baseline)},
        },
        'model_cost_policy':'every run requires explicit cost provenance; agent cost may not use unknown, unavailable, assumed_zero, or missing provenance',
        'agent':a,
        'baseline':b,
        'delta':deltas,
        'scenarios':per_scenario,
        'interpretation_policy':'report measured medians and variation; no productivity threshold or unmeasured value is inferred',
    }
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(payload,indent=2)+'\n')
    print(json.dumps(payload,indent=2))
    return 0
if __name__=='__main__': raise SystemExit(main())
