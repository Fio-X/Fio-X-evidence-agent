#!/usr/bin/env python3
from __future__ import annotations
import json,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(dir=ROOT/'outputs') as td:
    base=Path(td); proc=subprocess.Popen(['python3','runtime/worker/python_worker.py'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
    ready=json.loads(proc.stdout.readline()); assert ready['type']=='ready'; pid=ready['pid']
    for i,case in enumerate([('fixtures/realdata/nasa-gistemp-1980-2025.csv','line'),('fixtures/realdata/worldbank-gdp-life-2024.csv','scatter')]):
        out=base/f'r{i}'; out.mkdir(); chart=case[1]; opts={'renderer':'editorial_chart','chart_type':chart,'title':'Warm worker','source_note':'fixture'}
        if chart=='line': opts.update(x_field='year',y_field='anomaly_c')
        else: opts.update(x_field='gdp_per_capita_usd',y_field='life_expectancy_years',label_field='country',x_scale='log')
        req={'backend':'python_publication','story_id':f'w{i}','recipe_path':'x','output_dir':str(out.relative_to(ROOT)),'semantic_fingerprint':'a'*64,'evidence_hashes':{'x':'b'*64},'claim_ids':['c'],'inputs':{'table':case[0]},'options':opts}
        rp=out/'request.json'; rp.write_text(json.dumps(req)); proc.stdin.write(json.dumps({'id':str(i),'backend':'python_publication','request_path':str(rp.relative_to(ROOT))})+'\n'); proc.stdin.flush(); res=json.loads(proc.stdout.readline()); assert res['status']=='PASS' and res['pid']==pid; assert (out/'figure.svg').exists()
    proc.stdin.write(json.dumps({'id':'bye','op':'shutdown','backend':'python_publication','request_path':'x'})+'\n'); proc.stdin.flush(); shut=json.loads(proc.stdout.readline()); assert shut['pid']==pid; proc.wait(timeout=10); assert proc.returncode==0
print('python warm worker v1.31: PASS')
