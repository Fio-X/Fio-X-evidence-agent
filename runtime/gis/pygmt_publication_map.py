#!/usr/bin/env python3
"""PyGMT specialist renderer for terrain, bathymetry and projection-heavy maps."""
from __future__ import annotations
import argparse,json
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args()
    req=json.loads(Path(args.request).read_text())
    if req.get('backend')!='pygmt_scientific': raise SystemExit('request backend must be pygmt_scientific')
    try: import pygmt
    except Exception as e: raise SystemExit(f'PyGMT runtime unavailable: {e}')
    opt=req.get('options',{}); region=opt.get('region',[-180,180,-80,80]); projection=opt.get('projection','W18c')
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True); out=outdir/(opt.get('filename') or 'figure.pdf')
    fig=pygmt.Figure()
    if opt.get('relief_grid'):
        fig.grdimage(grid=opt['relief_grid'],region=region,projection=projection,shading=True,frame=True)
    else:
        fig.coast(region=region,projection=projection,land='gray90',water='white',shorelines='0.4p,gray40',borders='1/0.25p,gray60',frame=True)
    route=req.get('inputs',{}).get('route')
    if route:
        import pandas as pd
        df=pd.read_csv(route); fig.plot(x=df[opt.get('lon_field','lon')],y=df[opt.get('lat_field','lat')],pen='1.4p,red')
    fig.savefig(str(out))
    (outdir/'manifest.json').write_text(json.dumps({'schema_version':'1.0.0','backend':'pygmt_scientific','artifact_status':'FINAL','story_id':req.get('story_id'),'semantic_fingerprint':req.get('semantic_fingerprint'),'evidence_hashes':req.get('evidence_hashes',{}),'claim_ids':req.get('claim_ids',[]),'output':str(out),'region':region,'projection':projection},indent=2)+'\n')
if __name__=='__main__': main()
