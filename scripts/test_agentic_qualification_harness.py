#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

harness=(ROOT/'scripts'/'agentic_qualification.sh').read_text()
investigate_prompt=(ROOT/'prompts'/'investigate.md').read_text()
assert 'change the editorial objective from identifying the strongest story angle to stress-testing' in harness
assert 'NEWSROOM_RPC_HEARTBEAT_MS="${NEWSROOM_RPC_HEARTBEAT_MS:-60000}"' in harness
assert 'explicitly changes the editorial objective' in investigate_prompt
assert 'trigger=user_followup before substantive follow-up work' in investigate_prompt

def write_artifact(root: Path, unsupported: bool=False):
    (root/'story.json').write_text(json.dumps({'id':root.name,'autonomy':{
      'persistent_session':True,'multi_turn_context':True,'session_resumed':True,
      'follow_up_replanning_observed':True,'observable_planning':True,
      'autonomous_execution_observed':True,'agent_loop_observed':True,
      'adaptive_replanning_observed':True,'tool_failure_recovery_observed':True,
      'user_messages':2,'turns':2,'tool_calls':4,'capability_tool_calls':3,
      'successful_capability_tool_calls':3,'distinct_capability_classes':2,
      'distinct_tools':3,'plan_revisions':2,'failed_tool_calls':1,'automatic_retries':1,
    }}))
    (root/'tools.json').write_text(json.dumps({'tools':{'fetch_url':1,'duckdb_query':2},'failed_tool_calls':1}))
    (root/'plan.json').write_text(json.dumps({'steps':[{'id':'p1'}]}))
    verification={'authority':'system','source_resolved':True,'extraction_passed':True,'computation_replayed':True,'claim_supported':True,'publishable':True,'rule_id':'verification.source+extraction+computation+claim.v1'}
    good={'status':'verified','verification':verification,'source_refs':['sources/a'],'computation_refs':['computations/a']}
    claims=[good]
    if unsupported: claims.append({'status':'verified','verification':verification,'source_refs':[],'computation_refs':['computations/b']})
    (root/'claims.jsonl').write_text(''.join(json.dumps(c)+'\n' for c in claims))
    (root/'run-metrics.jsonl').write_text(json.dumps({'duration_ms':123})+'\n')
    (root/'session-stats.json').write_text(json.dumps({'usage':{'input_tokens':100,'output_tokens':50,'total_tokens':150,'cost':0.01}}))

def evaluate(artifact: Path):
    proc=subprocess.run([sys.executable,str(ROOT/'scripts/evaluate_agentic_artifact.py'),str(artifact),'--provider','test-provider','--model','test-model'],cwd=ROOT,capture_output=True,text=True)
    q=json.loads((artifact/'agentic-qualification.json').read_text())
    return proc,q

with tempfile.TemporaryDirectory() as td:
    td=Path(td)
    good=td/'good'; good.mkdir(); write_artifact(good,False)
    bad=td/'bad'; bad.mkdir(); write_artifact(bad,True)
    good_proc,good_q=evaluate(good)
    assert good_proc.returncode==0,good_proc.stdout+good_proc.stderr
    assert good_q['status']=='PASS'
    assert good_q['unsupported_verified_claims']==0
    bad_proc,bad_q=evaluate(bad)
    assert bad_proc.returncode==2,bad_proc.stdout+bad_proc.stderr
    assert bad_q['status']=='FAIL'
    assert bad_q['unsupported_verified_claims']==1
    assert bad_q['checks']['unsupported_verified_claims_zero'] is False

    q1=td/'q1.json'; q1.write_text(json.dumps(good_q))
    q2=td/'q2.json'; q2.write_text(json.dumps(good_q))
    q3=td/'q3.json'; q3.write_text(json.dumps(bad_q))
    out=td/'trials'
    proc=subprocess.run([sys.executable,str(ROOT/'scripts/agentic_trials.py'),'--out',str(out),'--qualification-files',str(q1),str(q2),str(q3)],cwd=ROOT,capture_output=True,text=True)
    assert proc.returncode==2,proc.stdout+proc.stderr
    summary=json.loads((out/'summary.json').read_text())
    assert summary['trials']==3 and summary['passed']==2
    assert abs(summary['pass_rate']-(2/3))<1e-12
    assert set(summary['pass_at_k'])=={'1','2','3'}
    assert set(summary['pass_pow_k'])=={'1','2','3'}
    assert summary['pass_at_k']['3']==1.0
    assert summary['pass_pow_k']['3'] < summary['pass_rate']
    assert summary['consistency']['provenance_integrity_rate']==2/3
print('agentic qualification harness: PASS')
