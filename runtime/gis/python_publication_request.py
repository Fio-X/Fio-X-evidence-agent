#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,subprocess,sys
from pathlib import Path


def stamp_manifest(req,outdir:Path):
    p=outdir/'manifest.json'
    if not p.exists(): return
    obj=json.loads(p.read_text())
    obj['story_id']=req.get('story_id')
    obj['semantic_fingerprint']=req.get('semantic_fingerprint')
    obj['evidence_hashes']=req.get('evidence_hashes',{})
    obj['claim_ids']=req.get('claim_ids',[])
    obj['design_system_id']=(req.get('design_system') or {}).get('id')
    obj['design_system_hash']=(req.get('design_system') or {}).get('content_hash')
    obj.setdefault('artifact_status','FINAL')
    p.write_text(json.dumps(obj,indent=2)+'\n')


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args()
    req=json.loads(Path(args.request).read_text())
    if req.get('backend')!='python_publication': raise SystemExit('request backend must be python_publication')
    inputs=req.get('inputs',{}); opt=req.get('options',{}); outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True)
    if opt.get('renderer')=='editorial_chart':
        subprocess.run([sys.executable,'runtime/gis/python_editorial_chart.py','--request',args.request],check=True); stamp_manifest(req,outdir); return
    if opt.get('renderer')=='trajectory_map':
        subprocess.run([sys.executable,'runtime/gis/python_trajectory_map.py','--request',args.request],check=True); stamp_manifest(req,outdir); return
    if opt.get('renderer')=='flow_map':
        subprocess.run([sys.executable,'runtime/gis/python_flow_map.py','--request',args.request],check=True); stamp_manifest(req,outdir); return
    missing=[k for k in ['track','shoreline','island'] if not inputs.get(k)]
    if missing: raise SystemExit(f'python_publication map requires inputs: {", ".join(missing)}')
    cmd=[sys.executable,'runtime/gis/python_publication_map.py','--track',inputs['track'],'--shoreline',inputs['shoreline'],'--island',inputs['island'],
         '--output-svg',str(outdir/opt.get('svg_filename','figure.svg')),'--output-png',str(outdir/opt.get('png_filename','figure.png')),'--manifest',str(outdir/'manifest.json')]
    subprocess.run(cmd,check=True); stamp_manifest(req,outdir)
if __name__=='__main__': main()
