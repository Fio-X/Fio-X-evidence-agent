#!/usr/bin/env python3
from __future__ import annotations
import json,statistics,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
N=4

def req(out,i):
    return {'backend':'python_publication','story_id':f'bench{i}','recipe_path':'x','output_dir':str(out.relative_to(ROOT)),'semantic_fingerprint':'a'*64,'evidence_hashes':{'x':'b'*64},'claim_ids':['c'],'inputs':{'table':'fixtures/realdata/nasa-gistemp-1980-2025.csv'},'options':{'renderer':'editorial_chart','chart_type':'line','x_field':'year','y_field':'anomaly_c','title':'Warm worker benchmark','source_note':'fixture'}}
with tempfile.TemporaryDirectory(dir=ROOT/'outputs') as td:
    base=Path(td); cold=[]
    for i in range(N):
        out=base/f'cold{i}'; out.mkdir(); rp=out/'request.json'; rp.write_text(json.dumps(req(out,i))); t=time.perf_counter(); subprocess.run(['python3','runtime/gis/python_publication_request.py','--request',str(rp.relative_to(ROOT))],cwd=ROOT,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); cold.append((time.perf_counter()-t)*1000)
    t0=time.perf_counter(); proc=subprocess.Popen(['python3','runtime/worker/python_worker.py'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1); ready=json.loads(proc.stdout.readline()); startup=(time.perf_counter()-t0)*1000; warm=[]
    for i in range(N):
        out=base/f'warm{i}'; out.mkdir(); rp=out/'request.json'; rp.write_text(json.dumps(req(out,i))); proc.stdin.write(json.dumps({'id':str(i),'backend':'python_publication','request_path':str(rp.relative_to(ROOT))})+'\n'); proc.stdin.flush(); res=json.loads(proc.stdout.readline()); assert res['status']=='PASS'; warm.append(res['elapsed_ms'])
    proc.stdin.write(json.dumps({'id':'bye','op':'shutdown','backend':'python_publication','request_path':'x'})+'\n'); proc.stdin.flush(); proc.stdout.readline(); proc.wait(timeout=10)
result={'schema_version':'1.0.0','renders':N,'cold_ms':cold,'warm_startup_ms':startup,'warm_render_ms':warm,'cold_total_ms':sum(cold),'warm_total_with_startup_ms':startup+sum(warm),'cold_median_ms':statistics.median(cold),'warm_median_ms':statistics.median(warm),'steady_state_speedup':statistics.median(cold)/max(statistics.median(warm),1e-9)}
print(json.dumps(result,indent=2))
