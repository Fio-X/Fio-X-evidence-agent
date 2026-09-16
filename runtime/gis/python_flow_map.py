#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json,math
from pathlib import Path
import pandas as pd
import geopandas as gpd
from shapely.geometry import LineString,Point
from pyproj import Geod
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

mpl.rcParams['svg.fonttype']='none'; mpl.rcParams['svg.hashsalt']='agentic-data-newsroom-flow-v1'; mpl.rcParams['font.family']=['DejaVu Sans']
GEOD=Geod(ellps='WGS84')

def geodesic(lon1,lat1,lon2,lat2,n=32):
    mid=GEOD.npts(float(lon1),float(lat1),float(lon2),float(lat2),max(0,n-2))
    return LineString([(float(lon1),float(lat1)),*mid,(float(lon2),float(lat2))])

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args(); req=json.loads(Path(args.request).read_text()); ds,t=design(req)
    if req.get('backend')!='python_publication': raise SystemExit('request backend must be python_publication')
    src=req.get('inputs',{}).get('table'); base=req.get('inputs',{}).get('basemap'); opt=req.get('options',{})
    if not src or not base: raise SystemExit('flow_map requires inputs.table and inputs.basemap')
    d=pd.read_csv(src); sf=opt.get('source_field','source'); tf=opt.get('target_field','target'); vf=opt.get('value_field','value')
    slon=opt.get('source_lon_field','source_lon'); slat=opt.get('source_lat_field','source_lat'); tlon=opt.get('target_lon_field','target_lon'); tlat=opt.get('target_lat_field','target_lat')
    need=[sf,tf,vf,slon,slat,tlon,tlat]; missing=[x for x in need if x not in d.columns]
    if missing: raise SystemExit('flow_map missing fields: '+', '.join(missing))
    crs=opt.get('crs','EPSG:8857')
    flows=gpd.GeoDataFrame(d.copy(),geometry=[geodesic(r[slon],r[slat],r[tlon],r[tlat]) for _,r in d.iterrows()],crs='EPSG:4326').to_crs(crs)
    basemap=gpd.read_file(base).to_crs(crs)
    bg=tok(t,'background','#faf9f6'); primary=tok(t,'primary','#17656a'); accent=tok(t,'accent','#123d40'); land=tok(t,'land','#ebe8e1'); border=tok(t,'border','#c3beb4'); textc=tok(t,'text','#111111'); muted=tok(t,'muted','#555555')
    fig,ax=plt.subplots(figsize=(13.5,7.6),dpi=180,facecolor=bg); ax.set_facecolor(bg)
    basemap.plot(ax=ax,color=land,edgecolor=border,linewidth=.28,zorder=0)
    vals=d[vf].astype(float); vmax=max(float(vals.max()),1e-9)
    for (_,row),geom in zip(d.iterrows(),flows.geometry):
        xy=list(geom.coords); lw=.55+4.2*math.sqrt(max(float(row[vf]),0)/vmax); ax.plot([x for x,y in xy],[y for x,y in xy],color=primary,alpha=.45,lw=lw,zorder=3,solid_capstyle='round')
        x,y=xy[-1]; ax.scatter([x],[y],s=10+18*math.sqrt(max(float(row[vf]),0)/vmax),color=accent,zorder=5)
    # Label only the largest flows to keep the map editorially legible.
    top=d.sort_values(vf,ascending=False).head(int(opt.get('label_top_n',6)))
    pts=[]
    for _,r in top.iterrows(): pts.append({'label':str(r[sf]),'geometry':Point(float(r[slon]),float(r[slat]))})
    if pts:
        pg=gpd.GeoDataFrame(pts,crs='EPSG:4326').to_crs(crs)
        for _,r in pg.iterrows(): ax.annotate(r['label'],(r.geometry.x,r.geometry.y),xytext=(4,4),textcoords='offset points',fontsize=float(tok(t,'label_size',7.5)),color=textc)
    # Target labels are unique and usually few.
    trows=d.drop_duplicates(tf)
    tg=gpd.GeoDataFrame([{**r.to_dict(),'geometry':Point(float(r[tlon]),float(r[tlat]))} for _,r in trows.iterrows()],crs='EPSG:4326').to_crs(crs)
    for _,r in tg.iterrows(): ax.annotate(str(r[tf]),(r.geometry.x,r.geometry.y),xytext=(5,-10),textcoords='offset points',fontsize=max(8,float(tok(t,'label_size',8.5))),fontweight='bold',color=textc)
    ax.set_axis_off(); ax.set_aspect('equal',adjustable='datalim')
    fig.text(float(tok(t,'outer_left',.055)),.94,opt.get('title','Flow map'),fontsize=float(opt.get('title_size',tok(t,'title_size',22))),fontweight='bold',ha='left',va='top',color=textc)
    if opt.get('subtitle'): fig.text(float(tok(t,'outer_left',.055)),.895,opt['subtitle'],fontsize=float(tok(t,'subtitle_size',10.5)),ha='left',va='top',color=muted)
    if opt.get('source_note'): fig.text(float(tok(t,'outer_left',.055)),.035,opt['source_note'],fontsize=float(tok(t,'source_size',7.5)),color=muted,ha='left')
    fig.subplots_adjust(left=.035,right=.98,top=.84,bottom=.075)
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True); svg=outdir/opt.get('svg_filename','figure.svg'); png=outdir/opt.get('png_filename','figure.png')
    fig.savefig(svg,bbox_inches='tight',pad_inches=.08,metadata={'Date':None,'Creator':'Agentic Data Newsroom'}); fig.savefig(png,bbox_inches='tight',pad_inches=.08,dpi=180); plt.close(fig)
    m={'schema_version':'1.1.0','design_system_id':ds.get('id'),'design_system_hash':ds.get('content_hash'),'backend':'python_publication','renderer':'flow_map','artifact_status':'FINAL','crs':crs,'rows':len(d),'svg_sha256':hashlib.sha256(svg.read_bytes()).hexdigest(),'png_sha256':hashlib.sha256(png.read_bytes()).hexdigest()}
    (outdir/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
if __name__=='__main__': main()
