#!/usr/bin/env python3
import json, subprocess, sys, tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
rows=[
 {'story_id':'a','story_family':'local_map','backend_a':'qgis_cartography','backend_b':'python_publication','winner':'a','confidence':.9,'reviewer_class':'designer','reviewer_id':'d1'},
 {'story_id':'b','story_family':'local_map','backend_a':'qgis_cartography','backend_b':'r_editorial','winner':'a','confidence':.8,'reviewer_class':'editor','reviewer_id':'e1'},
 {'story_id':'c','story_family':'local_map','backend_a':'python_publication','backend_b':'r_editorial','winner':'a','confidence':.7,'reviewer_class':'qualified_human','reviewer_id':'h1'}]
with tempfile.TemporaryDirectory() as td:
 inp=Path(td)/'p.jsonl'; out=Path(td)/'o.json'; inp.write_text('\n'.join(json.dumps(x) for x in rows)+'\n')
 subprocess.run([sys.executable,str(root/'scripts/build_backend_priors.py'),str(inp),'--output',str(out),'--min-reviewers','3','--min-comparisons','3'],check=True,capture_output=True,text=True)
 fam=json.loads(out.read_text())['story_families']['local_map']; assert fam['status']=='QUALIFIED'; p=fam['probabilities']
 assert p['qgis_cartography']>p['python_publication']>p['r_editorial']
print('backend priors v1.22 PASS')
