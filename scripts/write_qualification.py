#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, subprocess
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]

def git_commit():
    try:
        return subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'],
            cwd=ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return None

REQUIRED_TOOLS = [
    'newsroom_story_graph',
    'newsroom_viz_plan', 'newsroom_viz_lint', 'newsroom_viz_render', 'newsroom_viz_critic',
    'newsroom_explainer_plan', 'newsroom_explainer_lint', 'newsroom_explainer_render', 'newsroom_explainer_critic',
    'newsroom_illustration_plan', 'newsroom_illustration_lint', 'newsroom_illustration_generate', 'newsroom_illustration_critic',
    'newsroom_infographic_plan', 'newsroom_infographic_lint', 'newsroom_infographic_render', 'newsroom_infographic_critic',
    'newsroom_infographic_preview', 'newsroom_infographic_vision_critic', 'newsroom_infographic_revise',
    'newsroom_competition_preflight',
    'newsroom_publication_plan', 'newsroom_publication_render', 'newsroom_publication_qa',
]

def load(path, default=None):
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception: return default

def jsonl(path):
    rows=[]
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            try: rows.append(json.loads(line))
            except Exception: pass
    return rows

def flatten_numeric(value, prefix=''):
    out = {}
    if isinstance(value, dict):
        for key, child in value.items():
            name = f'{prefix}.{key}' if prefix else str(key)
            out.update(flatten_numeric(child, name))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            out.update(flatten_numeric(child, f'{prefix}[{index}]'))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        out[prefix] = value
    return out

def passing_json(root: Path, child: str, predicate) -> bool:
    directory = root / child
    if not directory.is_dir(): return False
    for path in directory.glob('*.json'):
        value = load(path, {}) or {}
        if value.get('passed') is True and predicate(value):
            return True
    return False

p=argparse.ArgumentParser()
p.add_argument('artifact', type=Path)
p.add_argument('--provider', required=True)
p.add_argument('--model', required=True)
p.add_argument('--scenario', default='magazine-visual-editor-e2e')
a=p.parse_args()
root=a.artifact
story=load(root/'story.json', {}) or {}
tools=load(root/'tools.json', {}) or {}
verification=load(root/'verification.json', {}) or {}
metrics=jsonl(root/'run-metrics.jsonl')
session_stats=load(root/'session-stats.json', {}) or {}
tool_counts=tools.get('tools',{}) or {}
missing_tools=[name for name in REQUIRED_TOOLS if int(tool_counts.get(name,0)) < 1]
vision_ok=passing_json(root, 'infographics/vision-critics', lambda x: float(x.get('score') or 0) >= 80 and x.get('kind') == 'image_aware_model')
rich_ok=passing_json(root, 'visualizations/illustrations/critics', lambda x: x.get('schema_version') == '0.2.0' or x.get('origin') in {'human','generative_ai','mixed','software'})
revision_ok=False
revision_dir=root/'infographics'/'revisions'
if revision_dir.is_dir():
    for path in revision_dir.glob('*.json'):
        value=load(path,{}) or {}
        if value.get('schema_version') == '0.1.0' and value.get('applied_patches') and (value.get('safety') or {}).get('evidence_fields_preserved') is True:
            revision_ok=True; break
preflights=[]
preflight_dir=root/'infographics'/'competition-preflight'
if preflight_dir.is_dir():
    preflights=[load(path,{}) or {} for path in preflight_dir.glob('*.json')]
publication_manifests=[]
pub_root=root/'publications'
if pub_root.is_dir():
    publication_manifests=[load(path,{}) or {} for path in pub_root.glob('*/manifest.json')]
publication_manifest_ok=any(m.get('evidence_bound') is True and m.get('plan_ref') and m.get('html_ref') for m in publication_manifests)
browser_reports=[]
qa_root=pub_root/'qa'
if qa_root.is_dir():
    browser_reports=[load(path,{}) or {} for path in qa_root.rglob('browser-qa.json')]
browser_ok=any(r.get('status')=='PASS' and r.get('profile')=='cpu' and (r.get('security') or {}).get('sandbox') is True and not r.get('external_requests') and not r.get('accessibility_errors') for r in browser_reports)

preflight_ok=any(p.get('machine_passed') is True and p.get('threshold_basis') == 'internal_operational_proxy_not_official_jury_cutoff' and isinstance(p.get('manual_requirements'),list) for p in preflights)
competition_profiles=sorted({str(p.get('profile')) for p in preflights if p.get('profile')})
failed=int(story.get('autonomy',{}).get('failed_tool_calls', tools.get('failed_tool_calls',0)) or 0)
tool_calls=int(story.get('autonomy',{}).get('tool_calls',0) or 0)
recovery_ok=story.get('autonomy',{}).get('tool_failure_recovery_observed') is True
usage_numbers=flatten_numeric(session_stats)
usage_metrics={k:v for k,v in usage_numbers.items() if any(token in k.lower() for token in ('token','cost','cache','usage'))}
adapter=os.environ.get('NEWSROOM_ILLUSTRATION_ADAPTER')
adapter_kind='contract_mock' if adapter and Path(adapter).name == 'mock_illustration_adapter.py' else ('external' if adapter else 'unconfigured')
checks={
    'artifact_verification': bool(verification.get('passed')),
    'multi_turn_context': story.get('autonomy',{}).get('multi_turn_context') is True,
    'agent_loop_observed': story.get('autonomy',{}).get('agent_loop_observed') is True,
    'autonomous_execution_observed': story.get('autonomy',{}).get('autonomous_execution_observed') is True,
    'adaptive_replanning_observed': story.get('autonomy',{}).get('adaptive_replanning_observed') is True,
    'follow_up_replanning_observed': story.get('autonomy',{}).get('follow_up_replanning_observed') is True,
    'controlled_failure_recovery': recovery_ok,
    'required_tool_chain': not missing_tools,
    'rich_illustration_passed': rich_ok,
    'image_aware_critic_passed': vision_ok,
    'bounded_visual_revision_passed': revision_ok,
    'competition_preflight_passed': preflight_ok,
    'browser_publication_passed': publication_manifest_ok and browser_ok,
}
passed=all(checks.values())
qualification={
    'schema_version':'1.4.0',
    'qualification_type':'integration',
    'qualification_status':'PASS' if passed else 'FAIL',
    'source_commit':git_commit(),
    'qualified_at': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
    'provider':a.provider,
    'model':a.model,
    'scenario':a.scenario,
    'passed': passed,
    'checks':checks,
    'missing_required_tools':missing_tools,
    'illustration_adapter':{'kind':adapter_kind,'executable':adapter},
    'competition_profiles':competition_profiles,
    'browser_publication':{'manifest_passed':publication_manifest_ok,'qa_passed':browser_ok,'qa_reports':len(browser_reports)},
    'artifact_id':story.get('id'),
    'status':story.get('status'),
    'user_messages':story.get('autonomy',{}).get('user_messages',0),
    'turns':story.get('autonomy',{}).get('turns',0),
    'tool_calls':tool_calls,
    'capability_tool_calls':story.get('autonomy',{}).get('capability_tool_calls',0),
    'successful_capability_tool_calls':story.get('autonomy',{}).get('successful_capability_tool_calls',0),
    'distinct_capability_classes':story.get('autonomy',{}).get('distinct_capability_classes',0),
    'distinct_tools':story.get('autonomy',{}).get('distinct_tools',0),
    'plan_revisions':story.get('autonomy',{}).get('plan_revisions',0),
    'failed_tool_calls':failed,
    'automatic_retries':story.get('autonomy',{}).get('automatic_retries',0),
    'run_metrics':metrics,
    'agent_wall_ms_total':sum(int(row.get('duration_ms',0)) for row in metrics),
    'session_stats':session_stats,
    'usage_metrics':usage_metrics,
    'verification':verification,
    'tools':tool_counts,
}
(root/'qualification.json').write_text(json.dumps(qualification,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps(qualification,indent=2,ensure_ascii=False))
raise SystemExit(0 if qualification['passed'] else 2)
