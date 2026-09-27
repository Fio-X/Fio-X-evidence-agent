#!/usr/bin/env python3
"""Datashader aggregation backend. It owns aggregation pixels, not editorial labels/layout."""
from __future__ import annotations
import argparse,json
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args()
    req=json.loads(Path(args.request).read_text())
    if req.get('backend')!='datashader_density': raise SystemExit('request backend must be datashader_density')
    try:
        import datashader as ds, datashader.transfer_functions as tf, pandas as pd
    except Exception as e: raise SystemExit(f'Datashader runtime unavailable: {e}')
    src=req.get('inputs',{}).get('table')
    if not src: raise SystemExit('datashader_density requires inputs.table')
    p=Path(src); df=pd.read_parquet(p) if p.suffix.lower() in {'.parquet','.geoparquet'} else pd.read_csv(p)
    opt=req.get('options',{}); x=opt.get('x','x'); y=opt.get('y','y'); width=int(opt.get('width',1600)); height=int(opt.get('height',900))
    cvs=ds.Canvas(plot_width=width,plot_height=height,x_range=opt.get('x_range'),y_range=opt.get('y_range'))
    agg=cvs.points(df,x,y,agg=ds.count())
    img=tf.shade(agg,how=opt.get('how','eq_hist'))
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True); out=outdir/(opt.get('filename') or 'density.png')
    img.to_pil().save(out)
    (outdir/'manifest.json').write_text(json.dumps({'schema_version':'1.0.0','backend':'datashader_density','artifact_status':'AGGREGATION_STAGE','story_id':req.get('story_id'),'semantic_fingerprint':req.get('semantic_fingerprint'),'evidence_hashes':req.get('evidence_hashes',{}),'claim_ids':req.get('claim_ids',[]),'output':str(out),'rows':len(df),'canvas':[width,height],'x':x,'y':y},indent=2)+'\n')
if __name__=='__main__': main()
