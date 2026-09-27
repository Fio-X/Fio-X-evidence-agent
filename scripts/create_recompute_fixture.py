#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, shutil
from pathlib import Path

def canonical(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha_bytes(b: bytes): return hashlib.sha256(b).hexdigest()
def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')

def build(root: Path):
    if root.exists(): shutil.rmtree(root)
    for d in ['data','sources','computations','session']:
        (root/d).mkdir(parents=True,exist_ok=True)
    for name,text in {'prompt.md':'fixture\n','answer.md':'fixture\n','conversation.md':'fixture\n','events.jsonl':'{}\n','claims.jsonl':'','run-metrics.jsonl':json.dumps({'schema_version':'0.7.0','operation':'investigate','status':'draft','duration_ms':1})+'\n'}.items():
        (root/name).write_text(text,encoding='utf-8')
    write_json(root/'tools.json',{'tools':{},'failed_tool_calls':0})
    write_json(root/'session-stats.json',{'userMessages':1})
    write_json(root/'plan.json',{'revision':1,'steps':[{'id':'1','action':'query','status':'completed'}]})
    data=b'country,value\nA,1\nB,2\n'
    data_hash=sha_bytes(data)
    data_ref=f'data/{data_hash}.csv'
    (root/data_ref).write_bytes(data)
    write_json(root/f'{data_ref}.meta.json',{'schema_version':'0.7.0','file':data_ref,'sha256':data_hash,'bytes':len(data)})
    rows=[{'country':'A','value':1},{'country':'B','value':2}]
    result_hash=sha_bytes(canonical(rows).encode())
    fingerprints=[f'data:{data_ref}:{data_hash}']
    input_hash=sha_bytes('\n'.join(fingerprints).encode())
    sql=f"SELECT country, value FROM read_csv_auto('data/{data_hash}.csv') ORDER BY country"
    key=sha_bytes(f'{sql}\n{input_hash}\n{result_hash}'.encode())
    comp_ref=f'computations/{key}.json'
    write_json(root/comp_ref,{'schema_version':'0.7.0','sql':sql,'input_snapshot_hash':input_hash,'input_fingerprints':fingerprints,'result_hash':result_hash,'rows':rows})
    write_json(root/'story.json',{
        'schema_version':'0.7.0','id':'recompute-real','kind':'investigation','created_at':'2026-09-12T00:00:00Z','updated_at':'2026-09-12T00:00:00Z','topic':'fixture','status':'draft',
        'runtime':{'backend':'pi-rpc','provider':None,'model':None,'session_dir':'session/'},
        'files':{'prompt':'prompt.md','latest_answer':'answer.md','conversation':'conversation.md','events':'events.jsonl','tool_audit':'tools.json','session_stats':'session-stats.json','run_metrics':'run-metrics.jsonl','plan':'plan.json','claims':'claims.jsonl'},
        'autonomy':{'persistent_session':True,'multi_turn_context':False,'observable_planning':True,'agent_loop_observed':False,'user_messages':1,'turns':0,'tool_calls':0,'capability_tool_calls':0,'distinct_tools':0,'plan_revisions':1,'failed_tool_calls':0,'automatic_retries':0},
        'evidence':{'searches':[],'sources':[],'datasets':[data_ref,f'{data_ref}.meta.json'],'computations':[comp_ref],'claims':[],'visualizations':[]}
    })

p=argparse.ArgumentParser(); p.add_argument('output',type=Path); a=p.parse_args(); build(a.output); print(a.output)
