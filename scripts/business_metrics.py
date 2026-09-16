#!/usr/bin/env python3
"""Derive product/agent KPIs from one investigation artifact.

Latency metrics use wrapper-recorded event timestamps. Quality metrics use immutable
artifact outputs and the causal audit summary, so they can be compared across models.
"""
from __future__ import annotations
import argparse, json
from datetime import datetime
from pathlib import Path

def parse_ts(value):
    if not value: return None
    try: return datetime.fromisoformat(str(value).replace('Z','+00:00'))
    except ValueError: return None

def jsonl(path):
    rows=[]
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip(): rows.append(json.loads(line))
    except Exception: pass
    return rows

def elapsed_ms(start, value):
    t=parse_ts(value)
    return None if start is None or t is None else max(0, round((t-start).total_seconds()*1000))

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('artifact',type=Path); ap.add_argument('--output',type=Path); a=ap.parse_args(); root=a.artifact
    events=jsonl(root/'events.jsonl'); metrics=jsonl(root/'run-metrics.jsonl'); claims=jsonl(root/'claims.jsonl')
    tools={}; starts={}; goal_start=None; milestones={}
    for e in events:
        stamp=e.get('_newsroom_recorded_at') or e.get('recordedAt')
        if goal_start is None and e.get('type')=='newsroom_user_goal': goal_start=parse_ts(stamp)
        if e.get('type')=='tool_execution_start': starts[e.get('toolCallId')]=(e.get('toolName'),stamp)
        if e.get('type')=='tool_execution_end':
            cid=e.get('toolCallId'); tool=e.get('toolName') or starts.get(cid,(None,None))[0]
            if not tool or e.get('isError') is True: continue
            tools[tool]=tools.get(tool,0)+1
            ms=elapsed_ms(goal_start,stamp)
            if tool in {'fetch_url','download_data'} and 'first_source_ms' not in milestones: milestones['first_source_ms']=ms
            if tool=='duckdb_query' and 'first_computation_ms' not in milestones: milestones['first_computation_ms']=ms
            if tool=='record_claim' and 'first_claim_record_ms' not in milestones: milestones['first_claim_record_ms']=ms
            if tool in {'newsroom_viz_critic','newsroom_infographic_critic'} and 'first_visual_review_ms' not in milestones: milestones['first_visual_review_ms']=ms
    verified=[c for c in claims if c.get('status')=='verified']
    with_compute=[c for c in verified if c.get('source_refs') and c.get('computation_refs')]
    latest=metrics[-1] if metrics else {}
    failed=int(latest.get('failed_tool_calls') or 0)
    recovered=1 if latest.get('tool_failure_recovery_observed') is True else 0
    payload={
      'schema_version':'1.0.0',
      'artifact_id':root.name,
      'latency_ms':milestones,
      'outcome':{
        'verified_claims':len(verified),
        'verified_claims_with_computation':len(with_compute),
        'provenance_complete_rate': (len(with_compute)/len(verified)) if verified else None,
        'source_snapshots': latest.get('source_snapshots'),
        'computations': latest.get('computations'),
        'distinct_capability_classes': latest.get('distinct_capability_classes'),
        'failed_tool_calls':failed,
        'recovery_rate': (recovered/failed) if failed else None,
        'autonomous_execution_observed':latest.get('autonomous_execution_observed'),
        'adaptive_replanning_observed':latest.get('adaptive_replanning_observed'),
        'follow_up_replanning_observed':latest.get('follow_up_replanning_observed'),
      },
      'run_metrics':metrics,
    }
    out=a.output or root/'business-metrics.json'; out.write_text(json.dumps(payload,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(payload,indent=2)); return 0
if __name__=='__main__': raise SystemExit(main())
