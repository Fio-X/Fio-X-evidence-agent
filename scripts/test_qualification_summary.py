#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
from selftest_evaluator import build_valid
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='newsroom-qualification-summary-') as tmp:
    root=Path(tmp)
    build_valid(root)
    # The integration qualification contract includes StoryGraph and trusted
    # browser publication. Extend the generic evaluator fixture with those
    # subsystem observations instead of weakening write_qualification.py.
    tools_path=root/'tools.json'
    tools=json.loads(tools_path.read_text())
    for name in ('newsroom_story_graph','newsroom_publication_plan','newsroom_publication_render','newsroom_publication_qa'):
        tools.setdefault('tools',{})[name]=1
    tools_path.write_text(json.dumps(tools,indent=2)+'\n')
    publication=root/'publications'/'fixture'
    publication.mkdir(parents=True,exist_ok=True)
    (publication/'manifest.json').write_text(json.dumps({
        'schema_version':'0.3.0',
        'evidence_bound':True,
        'plan_ref':'publications/fixture/plan.json',
        'html_ref':'publications/fixture/index.html',
    },indent=2)+'\n')
    qa=root/'publications'/'qa'/'fixture'
    qa.mkdir(parents=True,exist_ok=True)
    (qa/'browser-qa.json').write_text(json.dumps({
        'status':'PASS',
        'profile':'cpu',
        'security':{'sandbox':True},
        'external_requests':[],
        'accessibility_errors':[],
    },indent=2)+'\n')
    (root/'verification.json').write_text(json.dumps({'schema_version':'0.7.0','passed':True,'checks':80})+'\n')
    cp=subprocess.run([sys.executable,str(ROOT/'scripts/write_qualification.py'),str(root),'--provider','mock-provider','--model','mock-model'],capture_output=True,text=True)
    if cp.returncode != 0:
        print(cp.stdout); print(cp.stderr,file=sys.stderr); raise SystemExit('qualification summary should pass valid synthetic artifact')
    q=json.loads((root/'qualification.json').read_text())
    if not q.get('passed') or q.get('agent_wall_ms_total') != 2100:
        raise SystemExit(f'qualification summary mismatch: {q}')
print('qualification summary contract: PASS')
