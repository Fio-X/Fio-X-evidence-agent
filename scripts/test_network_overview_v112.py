#!/usr/bin/env python3
import json, random, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
r=random.Random(42);nodes=[{'id':str(i),'label':f'N{i}'} for i in range(5000)];edges=[]
for i in range(4999):edges.append({'source':str(i),'target':str(i+1),'weight':1})
for _ in range(4997):
 a=r.randrange(5000);b=(a+r.randrange(1,400))%5000;edges.append({'source':str(a),'target':str(b),'weight':1+r.random()})
spec={'seed':42,'max_meta_edges':120,'nodes':nodes,'edges':edges}
with tempfile.TemporaryDirectory() as td:
 req=Path(td)/'req.json';out=Path(td)/'out.json';req.write_text(json.dumps(spec));subprocess.run(['python3',str(ROOT/'runtime/browser/networkx_reduce.py'),'--request',str(req),'--output',str(out)],check=True,capture_output=True,text=True);d=json.loads(out.read_text());assert d['summary']['original_nodes']==5000;assert d['summary']['displayed_meta_edges']<=120;assert d['summary']['retained_cross_community_weight_fraction']>=.5;assert d['full_graph_status']=='SPECIALIST_RENDERER_REQUIRED';print(json.dumps({'status':'PASS',**d['summary']},indent=2))
