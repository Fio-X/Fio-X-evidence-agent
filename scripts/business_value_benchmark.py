#!/usr/bin/env python3
"""Aggregate measured human-vs-agent newsroom business-value benchmark runs.

This script never invents benchmark measurements. It consumes externally recorded
run rows and fails closed when required metrics or repeated observations are absent.
"""
from __future__ import annotations
import argparse, json, statistics
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

def load_rows(path: Path, expected_mode: str):
    payload=json.loads(path.read_text())
    rows=payload.get('runs') if isinstance(payload,dict) else payload
    if not isinstance(rows,list) or len(rows)<3:
        raise SystemExit(f'{path}: at least 3 measured runs are required')
    out=[]
    for index,row in enumerate(rows,1):
        if not isinstance(row,dict): raise SystemExit(f'{path}: run {index} is not an object')
        mode=row.get('mode',expected_mode)
        if mode != expected_mode: raise SystemExit(f'{path}: run {index} mode {mode!r} != {expected_mode!r}')
        missing=[key for key in REQUIRED if key not in row or row[key] is None]
        if missing: raise SystemExit(f'{path}: run {index} missing metrics: {", ".join(missing)}')
        clean={'mode':mode,'run_id':row.get('run_id') or f'{expected_mode}-{index}'}
        for key in REQUIRED:
            value=row[key]
            if not isinstance(value,(int,float)) or isinstance(value,bool): raise SystemExit(f'{path}: run {index} metric {key} must be numeric')
            if value < 0: raise SystemExit(f'{path}: run {index} metric {key} must be >= 0')
            clean[key]=float(value)
        if not 0 <= clean['verified_claim_rate'] <= 1: raise SystemExit(f'{path}: run {index} verified_claim_rate must be in [0,1]')
        out.append(clean)
    return out

def summarize(rows):
    summary={}
    for key in REQUIRED:
        values=[row[key] for row in rows]
        median=statistics.median(values)
        summary[key]={
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
    agent=load_rows(args.agent,'agent')
    baseline=load_rows(args.baseline,'baseline')
    a=summarize(agent); b=summarize(baseline)
    deltas={key:{
        'agent_minus_baseline_median':a[key]['median']-b[key]['median'],
        'ratio_agent_to_baseline': (a[key]['median']/b[key]['median']) if b[key]['median'] != 0 else None,
    } for key in REQUIRED}
    payload={
        'schema_version':'1.0.0',
        'status':'MEASURED',
        'required_metrics':list(REQUIRED),
        'agent_runs':len(agent),
        'baseline_runs':len(baseline),
        'agent':a,
        'baseline':b,
        'delta':deltas,
        'interpretation_policy':'report measured medians and variation; no productivity threshold or unmeasured value is inferred',
    }
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(payload,indent=2)+'\n')
    print(json.dumps(payload,indent=2))
    return 0
if __name__=='__main__': raise SystemExit(main())
