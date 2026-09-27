#!/usr/bin/env python3
"""Deterministic screenshot diagnostics for publication artifacts.

This is a diagnostic gate, not an aesthetic judge. It never grants competition readiness.
"""
from __future__ import annotations
import argparse,json,math
from pathlib import Path
import numpy as np
from PIL import Image


def _round(v): return round(float(v),4)

def analyze(path:Path):
    im=Image.open(path).convert('RGB')
    w,h=im.size
    scale=min(1.0,1200/max(w,h))
    if scale<1:
        im=im.resize((max(1,int(w*scale)),max(1,int(h*scale))),Image.Resampling.BILINEAR)
    a=np.asarray(im,dtype=np.float32)
    hh,ww=a.shape[:2]
    corners=np.concatenate([a[:max(2,hh//25),:max(2,ww//25)].reshape(-1,3),a[:max(2,hh//25),-max(2,ww//25):].reshape(-1,3),a[-max(2,hh//25):,:max(2,ww//25)].reshape(-1,3),a[-max(2,hh//25):,-max(2,ww//25):].reshape(-1,3)])
    bg=np.median(corners,axis=0)
    dist=np.linalg.norm(a-bg[None,None,:],axis=2)
    occ=dist>18
    occ_ratio=occ.mean()
    ys,xs=np.where(occ)
    if len(xs):
        x0,x1=int(xs.min()),int(xs.max()); y0,y1=int(ys.min()),int(ys.max())
        bbox_ratio=((x1-x0+1)*(y1-y0+1))/(ww*hh)
    else:
        x0=y0=0; x1=y1=0; bbox_ratio=0
    row=occ.mean(axis=1); col=occ.mean(axis=0)
    active_rows=np.where(row>.01)[0]; active_cols=np.where(col>.01)[0]
    top_ws=(active_rows[0]/hh) if len(active_rows) else 1
    bottom_ws=((hh-1-active_rows[-1])/hh) if len(active_rows) else 1
    left_ws=(active_cols[0]/ww) if len(active_cols) else 1
    right_ws=((ww-1-active_cols[-1])/ww) if len(active_cols) else 1
    gray=a.mean(axis=2)
    gx=np.abs(np.diff(gray,axis=1)); gy=np.abs(np.diff(gray,axis=0))
    edge_density=((gx>22).mean()+(gy>22).mean())/2
    content_gray=gray[occ] if occ.any() else gray.reshape(-1)
    p5,p95=np.percentile(content_gray,[5,95]); tonal=p95-p5
    dark=(gray<85).mean(); dark_content=(content_gray<85).mean()
    # Quantized occupied colors are a coarse richness indicator only.
    q=np.clip((a//32).astype(np.int16),0,7)
    qcode=q[:,:,0]*64+q[:,:,1]*8+q[:,:,2]
    color_bins=len(np.unique(qcode[occ])) if occ.any() else 0
    issues=[]; actions=[]; hard=[]
    if w<800 or h<450:
        hard.append('insufficient_raster_resolution')
    if bbox_ratio<.46 or max(top_ws,bottom_ws,left_ws,right_ws)>.24:
        issues.append('excessive_outer_whitespace'); actions.append('expand_plot_area_or_reduce_outer_margins')
    if occ_ratio>.58 and edge_density>.12:
        issues.append('visual_overdensity'); actions.append('reduce_label_or_grid_density')
    if tonal<42 and color_bins<8:
        issues.append('low_tonal_separation'); actions.append('increase_foreground_background_contrast')
    if dark>.34:
        issues.append('heavy_dark_coverage'); actions.append('reduce_heavy_marks_or_background_density')
    status='BLOCK' if hard else ('ADVISORY' if issues else 'PASS')
    return {
      'schema_version':'2.0.0','artifact':str(path),'status':status,
      'machine_role':'diagnostic_only','competition_readiness':'UNASSESSED',
      'dimensions_px':[w,h],'background_rgb':[int(x) for x in bg],
      'metrics':{'occupied_pixel_ratio':_round(occ_ratio),'occupied_bbox_ratio':_round(bbox_ratio),'edge_density':_round(edge_density),'tonal_range':_round(tonal),'dark_pixel_ratio':_round(dark),'dark_content_ratio':_round(dark_content),'quantized_color_bins':int(color_bins),'outer_whitespace':{'top':_round(top_ws),'bottom':_round(bottom_ws),'left':_round(left_ws),'right':_round(right_ws)}},
      'hard_failures':hard,'issues':issues,'recommended_actions':sorted(set(actions))
    }

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--output'); args=ap.parse_args()
    report=analyze(Path(args.input))
    text=json.dumps(report,indent=2)+'\n'
    if args.output: Path(args.output).write_text(text)
    print(text,end='')
if __name__=='__main__': main()
