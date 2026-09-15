#!/usr/bin/env python3
import json,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(dir=ROOT/'outputs') as td:
 d=Path(td); (d/'review').mkdir(); (d/'private').mkdir()
 (d/'review/blind-manifest.json').write_text(json.dumps({'schema_version':'1.2.0','story_id':'x','story_family':'test','semantic_fingerprint':'a'*64,'candidates':[{'candidate':'A','artifacts':[]},{'candidate':'B','artifacts':[]}],'pairwise':[['A','B']],'review_status':'READY'}))
 (d/'private/backend-key.json').write_text(json.dumps({'key':[{'candidate':'A','backend':'python_publication'},{'candidate':'B','backend':'r_editorial'}]}))
 subprocess.run(['node','scripts/build_blind_review.mjs',str(d)],cwd=ROOT,check=True,capture_output=True,text=True); html=(d/'review/index.html').read_text(); assert 'Reviewer ID / pseudonym' in html and 'editorial distinctiveness' in html
 blind={'candidate_gates':{'A':'PASS','B':'PASS'},'records':[{'story_id':'x','story_family':'test','candidate_a':'A','candidate_b':'B','winner':'A','confidence':.8,'reason_tags':['clarity'],'reviewer_class':'editor','reviewer_id':'ed1'}]}; bp=d/'blind.json'; bp.write_text(json.dumps(blind)); out=d/'resolved.jsonl'
 subprocess.run(['python3','scripts/resolve_blind_preference.py',str(bp),str(d/'private/backend-key.json'),'--output',str(out)],cwd=ROOT,check=True,capture_output=True,text=True); row=json.loads(out.read_text()); assert row['backend_a']=='python_publication' and row['reviewer_id']=='ed1'
print('blind review v1.29: PASS')
