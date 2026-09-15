#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import matplotlib as mpl
mpl.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
try:
    from runtime.gis.style_tokens import design,tok
except ModuleNotFoundError:
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
    from runtime.gis.style_tokens import design,tok
from matplotlib.colors import LinearSegmentedColormap

mpl.rcParams['svg.fonttype']='none'
mpl.rcParams['svg.hashsalt']='agentic-data-newsroom-adjacency-v1'
mpl.rcParams['font.family']=['DejaVu Sans']

def load_rows(path):
    p=Path(path); obj=json.loads(p.read_text())
    if isinstance(obj,list): return obj
    if isinstance(obj,dict) and isinstance(obj.get('rows'),list): return obj['rows']
    raise SystemExit('adjacency_matrix input must be a JSON row array or fixture object with rows')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args()
    req=json.loads(Path(args.request).read_text()); ds,t=design(req)
    if req.get('backend')!='adjacency_matrix': raise SystemExit('request backend must be adjacency_matrix')
    src=req.get('inputs',{}).get('table')
    if not src: raise SystemExit('adjacency_matrix requires inputs.table')
    opt=req.get('options',{}); sf=opt.get('source_field','source'); tf=opt.get('target_field','target'); vf=opt.get('value_field','value')
    rows=load_rows(src); nodes=sorted({str(r[sf]) for r in rows}|{str(r[tf]) for r in rows})
    idx={n:i for i,n in enumerate(nodes)}; m=np.zeros((len(nodes),len(nodes)),dtype=float)
    for r in rows: m[idx[str(r[sf])],idx[str(r[tf])]]+=float(r.get(vf,1) or 0)
    degree=m.sum(0)+m.sum(1); order=sorted(range(len(nodes)),key=lambda i:(-degree[i],nodes[i])); m=m[np.ix_(order,order)]; labels=[nodes[i] for i in order]
    bg=tok(t,'background','white'); textc=tok(t,'text','#202124'); primary=tok(t,'primary','#343a40'); size=max(6,min(14,4+len(nodes)*0.28)); fig,ax=plt.subplots(figsize=(size,size),dpi=180,facecolor=bg); ax.set_facecolor(bg)
    cmap=LinearSegmentedColormap.from_list('adn_matrix',[bg,primary]); im=ax.imshow(m,cmap=cmap,interpolation='nearest',aspect='equal')
    ax.set_xticks(range(len(labels)),labels,rotation=90,fontsize=max(5,9-len(labels)*0.05)); ax.set_yticks(range(len(labels)),labels,fontsize=max(5,9-len(labels)*0.05))
    ax.tick_params(length=0); ax.set_xlabel('Target'); ax.set_ylabel('Source')
    title=opt.get('title','Relationship matrix'); ax.set_title(title,loc='left',fontsize=16,fontweight='bold',pad=18)
    for s in ax.spines.values(): s.set_visible(False)
    fig.colorbar(im,ax=ax,fraction=.035,pad=.03,label=opt.get('unit','weight'))
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True); svg=outdir/opt.get('svg_filename','figure.svg'); png=outdir/opt.get('png_filename','figure.png')
    fig.savefig(svg,bbox_inches='tight',pad_inches=.08,metadata={'Date':None,'Creator':'Agentic Data Newsroom'}); fig.savefig(png,bbox_inches='tight',pad_inches=.08,dpi=180); plt.close(fig)
    manifest={'schema_version':'1.1.0','design_system_id':ds.get('id'),'design_system_hash':ds.get('content_hash'),'backend':'adjacency_matrix','artifact_status':'FINAL','story_id':req.get('story_id'),'semantic_fingerprint':req.get('semantic_fingerprint'),'evidence_hashes':req.get('evidence_hashes',{}),'claim_ids':req.get('claim_ids',[]),'nodes':len(nodes),'edges':len(rows),'ordering':'weighted_degree_desc_then_id','svg_sha256':hashlib.sha256(svg.read_bytes()).hexdigest(),'png_sha256':hashlib.sha256(png.read_bytes()).hexdigest()}
    (outdir/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if __name__=='__main__': main()
