#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path
import geopandas as gpd
import matplotlib as mpl
mpl.use('Agg')
import matplotlib.pyplot as plt
try:
    from runtime.gis.style_tokens import design,tok
except ModuleNotFoundError:
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
    from runtime.gis.style_tokens import design,tok
from matplotlib.collections import LineCollection
from matplotlib.colors import Normalize
from shapely.geometry import Point, box

mpl.rcParams['svg.fonttype']='none'
mpl.rcParams['svg.hashsalt']='agentic-data-newsroom-trajectory-v1'
mpl.rcParams['font.family']=['DejaVu Sans']

def load_track(path):
    obj=json.loads(Path(path).read_text()); pts=obj['points']; g=gpd.GeoDataFrame(pts,geometry=[Point(p['lon'],p['lat']) for p in pts],crs='EPSG:4326'); return obj,g

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args(); req=json.loads(Path(args.request).read_text()); ds,t=design(req)
    if req.get('backend')!='python_publication': raise SystemExit('request backend must be python_publication')
    inp=req.get('inputs',{}); track_path=inp.get('track'); basemap_path=inp.get('basemap');
    if not track_path: raise SystemExit('trajectory_map requires inputs.track')
    meta,pts_ll=load_track(track_path); opt=req.get('options',{}); lat0=float(pts_ll['lat'].mean()); lon0=float(pts_ll['lon'].mean()); crs=f'+proj=aeqd +lat_0={lat0:.8f} +lon_0={lon0:.8f} +datum=WGS84 +units=m +no_defs'; pts=pts_ll.to_crs(crs)
    xs=pts.geometry.x.to_numpy(); ys=pts.geometry.y.to_numpy(); span=max(xs.max()-xs.min(),ys.max()-ys.min()); pad=max(80_000,span*.16); extent=(xs.min()-pad,ys.min()-pad,xs.max()+pad,ys.max()+pad)
    base=None
    if basemap_path:
        base=gpd.read_file(basemap_path).to_crs(crs); base=gpd.clip(base,box(*extent))
    bg=tok(t,'background','#f7f6f2'); land=tok(t,'land','#ece8de'); border=tok(t,'border','#b7b1a8'); water=tok(t,'water','#e9f0f1'); textc=tok(t,'text','#111111'); muted=tok(t,'muted','#666666'); primary=tok(t,'primary','#155f63')
    fig=plt.figure(figsize=(14.8,8.6),dpi=180,facecolor=bg); gs=fig.add_gridspec(12,18,left=.05,right=.97,top=.93,bottom=.08,wspace=.6,hspace=.4); ax=fig.add_subplot(gs[2:12,:12]); side=fig.add_subplot(gs[2:12,12:18]); side.axis('off')
    title=opt.get('title','Observed trajectory'); subtitle=opt.get('subtitle','Observed positions only'); fig.text(.05,.93,title,fontsize=float(opt.get('title_size',tok(t,'title_size',23))),fontweight='bold',va='top',color=textc); fig.text(.05,.884,subtitle,fontsize=float(tok(t,'subtitle_size',11)),color=muted,va='top')
    ax.set_facecolor(water);
    if base is not None and len(base): base.plot(ax=ax,color=land,edgecolor=border,linewidth=.6,zorder=1)
    speed_field=opt.get('color_field','ground_speed_kt'); speeds=pts[speed_field].astype(float).to_numpy() if speed_field in pts else None; norm=Normalize(vmin=float(min(speeds)) if speeds is not None else 0,vmax=float(max(speeds)) if speeds is not None else 1)
    segments=[]; values=[]
    for i in range(len(pts)-1):
        if 'segment' in pts.columns and pts.iloc[i]['segment']!=pts.iloc[i+1]['segment']: continue
        segments.append([(xs[i],ys[i]),(xs[i+1],ys[i+1])]); values.append((speeds[i]+speeds[i+1])/2 if speeds is not None else 1)
    lc=LineCollection(segments,cmap='viridis',norm=norm,linewidths=2.7,zorder=5,capstyle='round'); lc.set_array(values); ax.add_collection(lc); ax.scatter(xs,ys,c=speeds if speeds is not None else '#155f63',cmap='viridis' if speeds is not None else None,norm=norm if speeds is not None else None,s=16,edgecolors='white',linewidths=.45,zorder=6)
    ax.set_xlim(extent[0],extent[2]); ax.set_ylim(extent[1],extent[3]); ax.set_aspect('equal'); ax.axis('off')
    ax.annotate('START',(xs[0],ys[0]),xytext=(8,8),textcoords='offset points',fontsize=8,fontweight='bold'); ax.annotate('END',(xs[-1],ys[-1]),xytext=(8,8),textcoords='offset points',fontsize=8,fontweight='bold')
    if speeds is not None:
        cbax=ax.inset_axes([.63,.045,.28,.018]); cb=fig.colorbar(lc,cax=cbax,orientation='horizontal'); cb.outline.set_visible(False); cb.ax.tick_params(labelsize=6.5,length=2); cb.set_label(opt.get('color_label','sampled speed · knots'),fontsize=6.5,labelpad=1)
    elapsed=float(pts.iloc[-1].get('elapsed_s',0)-pts.iloc[0].get('elapsed_s',0)); side.text(0,1,f'{elapsed/3600:.1f} h',fontsize=30,fontweight='bold',va='top'); side.text(0,.925,'elapsed time across retained fixes',fontsize=9,color='#666'); side.text(0,.83,f'{len(pts)} fixes',fontsize=20,fontweight='bold'); side.text(.5,.83,f'{max(speeds):.0f} kn' if speeds is not None else '',fontsize=20,fontweight='bold')
    profile=opt.get('profile_field','altitude_ft')
    if profile in pts.columns:
        sp=side.inset_axes([0,.42,.98,.27]); t=pts['elapsed_s'].astype(float)/3600; sp.plot(t,pts[profile].astype(float),lw=1.7,color=primary); sp.fill_between(t,0,pts[profile].astype(float),alpha=.12,color=primary); sp.set_xlabel('hours from first fix',fontsize=7); sp.set_ylabel(opt.get('profile_label','altitude · ft'),fontsize=7); sp.tick_params(labelsize=7,length=2); sp.spines[['top','right']].set_visible(False)
    side.text(0,.30,'HOW TO READ IT',fontsize=8,fontweight='bold',color='#444'); side.text(0,.25,'The route follows retained observations. Segment breaks\nare not joined, so a missing interval is not drawn as\nan observed path.',fontsize=9,color='#333',va='top',linespacing=1.4)
    source=opt.get('source_note',f"Source: {meta.get('source','track fixture')}"); fig.text(.05,.028,source,fontsize=float(tok(t,'source_size',7.5)),color=muted)
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True); svg=outdir/opt.get('svg_filename','figure.svg'); png=outdir/opt.get('png_filename','figure.png'); fig.savefig(svg,bbox_inches='tight',pad_inches=.08,metadata={'Date':None,'Creator':'Agentic Data Newsroom'}); fig.savefig(png,bbox_inches='tight',pad_inches=.08,dpi=180); plt.close(fig)
    manifest={'schema_version':'1.1.0','design_system_id':ds.get('id'),'design_system_hash':ds.get('content_hash'),'backend':'python_publication','renderer':'trajectory_map','crs':crs,'track_points':len(pts),'segments':int(pts['segment'].nunique()) if 'segment' in pts else 1,'svg_sha256':hashlib.sha256(svg.read_bytes()).hexdigest(),'png_sha256':hashlib.sha256(png.read_bytes()).hexdigest()}; (outdir/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if __name__=='__main__': main()
