#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path


def load(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def first_metric(metrics: dict, needles: tuple[str, ...]):
    matches=[(k,v) for k,v in metrics.items() if all(n in k.lower() for n in needles) and isinstance(v,(int,float))]
    return matches[0][1] if matches else None

p=argparse.ArgumentParser(description='Compare provider qualification artifacts')
p.add_argument('qualifications', nargs='+', type=Path)
p.add_argument('--json-out', type=Path)
p.add_argument('--markdown-out', type=Path)
a=p.parse_args()
rows=[]
for path in a.qualifications:
    q=load(path)
    usage=q.get('usage_metrics') or {}
    rows.append({
        'provider':q.get('provider'), 'model':q.get('model'), 'passed':bool(q.get('passed')),
        'wall_ms':q.get('agent_wall_ms_total'), 'tool_calls':q.get('tool_calls'),
        'failed_tool_calls':q.get('failed_tool_calls'), 'automatic_retries':q.get('automatic_retries'),
        'plan_revisions':q.get('plan_revisions'), 'distinct_tools':q.get('distinct_tools'),
        'input_tokens': first_metric(usage, ('input','token')), 'output_tokens': first_metric(usage, ('output','token')),
        'total_tokens': first_metric(usage, ('total','token')), 'cost': first_metric(usage, ('cost',)),
        'illustration_adapter_kind': (q.get('illustration_adapter') or {}).get('kind'),
        'competition_profiles': ','.join(q.get('competition_profiles') or []),
        'artifact_id':q.get('artifact_id'), 'source':str(path),
    })
rows.sort(key=lambda r: (not r['passed'], r['wall_ms'] if isinstance(r['wall_ms'],(int,float)) else 10**18))
payload={'schema_version':'1.3.0','providers':rows}
if a.json_out:
    a.json_out.parent.mkdir(parents=True, exist_ok=True); a.json_out.write_text(json.dumps(payload,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
header='| Provider | Model | Pass | Wall ms | Tool calls | Failed | Retries | Plan revs | Input tok | Output tok | Cost | Illustration adapter | Competition profiles |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|\n'
body=''.join(f"| {r['provider']} | {r['model']} | {'yes' if r['passed'] else 'no'} | {r['wall_ms'] if r['wall_ms'] is not None else ''} | {r['tool_calls'] if r['tool_calls'] is not None else ''} | {r['failed_tool_calls'] if r['failed_tool_calls'] is not None else ''} | {r['automatic_retries'] if r['automatic_retries'] is not None else ''} | {r['plan_revisions'] if r['plan_revisions'] is not None else ''} | {r['input_tokens'] if r['input_tokens'] is not None else ''} | {r['output_tokens'] if r['output_tokens'] is not None else ''} | {r['cost'] if r['cost'] is not None else ''} | {r['illustration_adapter_kind'] or ''} | {r['competition_profiles'] or ''} |\n" for r in rows)
md='# Provider qualification comparison\n\n'+header+body
if a.markdown_out:
    a.markdown_out.parent.mkdir(parents=True, exist_ok=True); a.markdown_out.write_text(md,encoding='utf-8')
print(md,end='')
raise SystemExit(0 if rows and all(r['passed'] for r in rows) else 2)
