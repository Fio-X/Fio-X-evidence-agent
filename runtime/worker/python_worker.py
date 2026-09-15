#!/usr/bin/env python3
"""Long-lived worker for Python publication backends.

Protocol: newline-delimited JSON on stdin/stdout. Heavy GIS/chart modules are imported
once at worker start. Every render request remains file-backed and content-addressable.
"""
from __future__ import annotations
import json,os,sys,time,traceback
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from runtime.gis import python_editorial_chart,python_flow_map,python_trajectory_map,python_publication_map
from runtime.graph import python_adjacency_matrix


def call_main(module,argv):
    old=sys.argv[:]
    try:
        sys.argv=[str(Path(module.__file__).name),*argv]; module.main()
    finally: sys.argv=old

def render(backend,request_path):
    rp=Path(request_path); rp=rp if rp.is_absolute() else ROOT/rp; req=json.loads(rp.read_text()); opt=req.get('options',{}); outdir=ROOT/req['output_dir']
    if backend=='python_publication':
        renderer=opt.get('renderer')
        if renderer=='editorial_chart': call_main(python_editorial_chart,['--request',str(rp)])
        elif renderer=='trajectory_map': call_main(python_trajectory_map,['--request',str(rp)])
        elif renderer=='flow_map': call_main(python_flow_map,['--request',str(rp)])
        else:
            inputs=req.get('inputs',{}); missing=[k for k in ('track','shoreline','island') if not inputs.get(k)]
            if missing: raise RuntimeError('python publication map missing '+','.join(missing))
            call_main(python_publication_map,['--track',inputs['track'],'--shoreline',inputs['shoreline'],'--island',inputs['island'],'--output-svg',str(outdir/opt.get('svg_filename','figure.svg')),'--output-png',str(outdir/opt.get('png_filename','figure.png')),'--manifest',str(outdir/'manifest.json')])
        # Stamp common audit fields after direct renderer execution.
        mp=outdir/'manifest.json'; m=json.loads(mp.read_text()); m.update({'story_id':req.get('story_id'),'semantic_fingerprint':req.get('semantic_fingerprint'),'evidence_hashes':req.get('evidence_hashes',{}),'claim_ids':req.get('claim_ids',[]),'design_system_id':(req.get('design_system') or {}).get('id'),'design_system_hash':(req.get('design_system') or {}).get('content_hash'),'artifact_status':m.get('artifact_status','FINAL')}); mp.write_text(json.dumps(m,indent=2)+'\n')
    elif backend=='adjacency_matrix': call_main(python_adjacency_matrix,['--request',str(rp)])
    else: raise RuntimeError(f'unsupported warm-worker backend: {backend}')
    return str((outdir/'manifest.json').relative_to(ROOT))

def emit(obj): print(json.dumps(obj,separators=(',',':')),flush=True)

def main():
    emit({'type':'ready','schema_version':'1.0.0','runtime':'viz-python','pid':os.getpid(),'backends':['python_publication','adjacency_matrix']})
    for line in sys.stdin:
        if not line.strip(): continue
        t0=time.perf_counter()
        try:
            msg=json.loads(line); mid=msg.get('id')
            if msg.get('op')=='shutdown': emit({'type':'shutdown','id':mid,'pid':os.getpid()}); return
            manifest=render(msg['backend'],msg['request_path']); emit({'type':'result','id':mid,'status':'PASS','pid':os.getpid(),'elapsed_ms':round((time.perf_counter()-t0)*1000,3),'manifest':manifest})
        except BaseException as e:
            emit({'type':'result','id':locals().get('mid'),'status':'ERROR','pid':os.getpid(),'elapsed_ms':round((time.perf_counter()-t0)*1000,3),'error':f'{type(e).__name__}: {e}','traceback':traceback.format_exc(limit=6)})

if __name__=='__main__': main()
