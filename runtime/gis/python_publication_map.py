#!/usr/bin/env python3
"""Publication-map backend built on mature scientific Python GIS libraries.

AI/orchestrator supplies semantic inputs. GeoPandas/Shapely/PROJ own geometry.
Matplotlib owns deterministic vector composition. No hand-projected coordinates.
"""
from __future__ import annotations
import argparse, json, math, hashlib
from pathlib import Path
import geopandas as gpd
import matplotlib as mpl
mpl.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.colors import Normalize
from shapely.geometry import LineString, Point, box

mpl.rcParams['svg.fonttype'] = 'none'
mpl.rcParams['svg.hashsalt'] = 'agentic-data-newsroom-v1'
mpl.rcParams['font.family'] = ['DejaVu Sans']
mpl.rcParams['axes.unicode_minus'] = False


def duration_label(seconds):
    m = int(round(seconds/60))
    return f"{m//60}h {m%60:02d}m" if m >= 60 else f"{m}m"


def scalebar(ax, length_m=250):
    x0,x1=ax.get_xlim(); y0,y1=ax.get_ylim()
    x=x0+(x1-x0)*0.07; y=y0+(y1-y0)*0.075
    ax.plot([x,x+length_m],[y,y],lw=3,color='#141414',solid_capstyle='butt',zorder=20)
    ax.plot([x,x],[y-8,y+8],lw=1.2,color='#141414',zorder=20)
    ax.plot([x+length_m,x+length_m],[y-8,y+8],lw=1.2,color='#141414',zorder=20)
    ax.text(x+length_m/2,y+18,f'{length_m} m',ha='center',va='bottom',fontsize=8,color='#2d2d2d')


def load_track(path):
    obj=json.loads(Path(path).read_text())
    pts=obj['points']
    g=gpd.GeoDataFrame(pts, geometry=[Point(p['lon'],p['lat']) for p in pts], crs='EPSG:4326')
    return obj,g


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--track', required=True)
    ap.add_argument('--shoreline', required=True)
    ap.add_argument('--island', required=True)
    ap.add_argument('--output-svg', required=True)
    ap.add_argument('--output-png', required=True)
    ap.add_argument('--manifest', required=True)
    args=ap.parse_args()

    track_meta, pts_ll=load_track(args.track)
    shore_ll=gpd.read_file(args.shoreline)
    island_ll=gpd.read_file(args.island)
    # Syros falls in UTM 35N; all metric layout and scale calculations happen here.
    crs='EPSG:32635'
    pts=pts_ll.to_crs(crs); shore=shore_ll.to_crs(crs); island=island_ll.to_crs(crs)
    line=LineString(pts.geometry.tolist())
    line_gdf=gpd.GeoDataFrame([{'geometry':line}],crs=crs)

    minx,miny,maxx,maxy=line.bounds
    pad=420
    extent=(minx-pad,miny-pad,maxx+pad,maxy+pad)
    clip_box=box(*extent)
    shore_clip=gpd.clip(shore,clip_box)

    fig=plt.figure(figsize=(14.8,8.6),dpi=180,facecolor='#f7f6f2')
    gs=fig.add_gridspec(12,18,left=.045,right=.975,top=.94,bottom=.075,wspace=.55,hspace=.35)
    ax=fig.add_subplot(gs[2:12,:12])
    side=fig.add_subplot(gs[2:12,12:18]); side.axis('off')
    fig.text(.05,.93,'A slow harbour manoeuvre, reconstructed from AIS fixes',fontsize=24,weight='bold',color='#111111',va='top')
    fig.text(.05,.885,'Syros, Greece · 2 Aug 2024 · observed positions only',fontsize=11.5,color='#565656',va='top')

    # Map substrate
    ax.set_facecolor('#e9f0f1')
    # Full island silhouette is deliberately quiet context; detailed upstream shoreline owns local edge fidelity.
    if len(shore_clip): shore_clip.plot(ax=ax,color='#333333',linewidth=1.65,zorder=5)
    ax.set_xlim(extent[0],extent[2]); ax.set_ylim(extent[1],extent[3]); ax.set_aspect('equal'); ax.axis('off')

    xy=[(p.x,p.y) for p in pts.geometry]
    segs=[xy[i:i+2] for i in range(len(xy)-1)]
    speeds=[(pts.iloc[i].ground_speed_kt+pts.iloc[i+1].ground_speed_kt)/2 for i in range(len(pts)-1)]
    lc=LineCollection(segs,cmap='viridis',norm=Normalize(vmin=0,vmax=max(1.3,max(speeds))),linewidths=3.2,zorder=10,capstyle='round')
    lc.set_array(speeds); ax.add_collection(lc)
    ax.scatter([x for x,y in xy],[y for x,y in xy],s=18,c=pts['ground_speed_kt'],cmap='viridis',vmin=0,vmax=1.3,edgecolors='white',linewidths=.6,zorder=11)

    loc=ax.inset_axes([.78,.72,.19,.22])
    island.boundary.plot(ax=loc,color='#a8a39c',linewidth=.65)
    loc.set_aspect('equal'); loc.axis('off')
    loc.scatter([line.centroid.x],[line.centroid.y],s=12,color='#111',zorder=4)
    loc.set_title('SYROS',fontsize=6.5,loc='left',pad=1,color='#555',weight='bold')

    # Start/end direct labels
    for idx,label,dx,dy,ha in [(0,'07:51  START',-40,65,'right'),(len(pts)-1,'10:27  END',45,55,'left')]:
        x,y=xy[idx]
        ax.annotate(label,(x,y),xytext=(x+dx,y+dy),textcoords='data',ha=ha,va='bottom',fontsize=8.5,weight='bold',color='#111',
                    arrowprops=dict(arrowstyle='-',lw=.8,color='#5d5d5d'),zorder=30)
    # Mark long observation gaps rather than visually implying continuous observation.
    gaps=[]
    for i in range(len(pts)-1):
        gap=pts.iloc[i+1].elapsed_s-pts.iloc[i].elapsed_s
        if gap>=1800:
            mx=(xy[i][0]+xy[i+1][0])/2; my=(xy[i][1]+xy[i+1][1])/2
            ax.plot([xy[i][0],xy[i+1][0]],[xy[i][1],xy[i+1][1]],lw=1.0,ls=(0,(2,3)),color='#555',zorder=12)
            gaps.append((gap,mx,my))
    if gaps:
        gap,mx,my=max(gaps)
        ax.annotate(f'{int(gap/60)} min observation gap',(mx,my),xytext=(mx+160,my-90),fontsize=7.5,color='#555',
                    arrowprops=dict(arrowstyle='-',lw=.7,color='#777'))
    scalebar(ax,250)
    cbax=ax.inset_axes([.63,.055,.27,.018])
    cb=fig.colorbar(lc,cax=cbax,orientation='horizontal'); cb.outline.set_visible(False); cb.ax.tick_params(labelsize=6.5,length=2,pad=2); cb.set_label('sampled speed · knots',fontsize=6.5,labelpad=1,color='#555')
    ax.text(.985,.02,'UTM 35N · EPSG:32635',transform=ax.transAxes,ha='right',va='bottom',fontsize=7.2,color='#6b6b6b')

    # Sidecar editorial hierarchy
    duration=pts.iloc[-1].elapsed_s-pts.iloc[0].elapsed_s
    side.text(0,1.0,duration_label(duration),fontsize=31,weight='bold',va='top',color='#111')
    side.text(0,.925,'elapsed time between first and last retained fix',fontsize=9.2,color='#666',va='top',wrap=True)
    side.text(0,.825,f"{len(pts)} fixes",fontsize=21,weight='bold',color='#111')
    side.text(.52,.825,f"{pts['ground_speed_kt'].max():.1f} kn",fontsize=21,weight='bold',color='#111')
    side.text(0,.775,'selected observations',fontsize=8.5,color='#666')
    side.text(.52,.775,'peak sampled speed',fontsize=8.5,color='#666')
    side.text(0,.68,'SPEED THROUGH THE SAMPLE',fontsize=8,weight='bold',color='#444')
    sp=side.inset_axes([0,.43,.98,.22])
    t=pts['elapsed_s']/60
    sp.plot(t,pts['ground_speed_kt'],lw=1.6,color='#155f63')
    sp.scatter(t,pts['ground_speed_kt'],s=12,color='#155f63')
    sp.set_xlim(0,t.max()); sp.set_ylim(0,max(1.45,pts['ground_speed_kt'].max()*1.12))
    sp.set_xlabel('minutes from first fix',fontsize=7,color='#666'); sp.set_ylabel('knots',fontsize=7,color='#666')
    sp.tick_params(labelsize=7,length=2,color='#aaa');
    for s in ['top','right']: sp.spines[s].set_visible(False)
    sp.spines['left'].set_color('#c6c2bb'); sp.spines['bottom'].set_color('#c6c2bb')
    side.text(0,.34,'HOW TO READ IT',fontsize=8,weight='bold',color='#444')
    side.text(0,.29,'The coloured path follows retained AIS positions.\nColour encodes sampled speed; dotted connectors flag\nlong gaps where no intermediate position is asserted.',fontsize=9.2,color='#333',va='top',linespacing=1.45)
    side.text(0,.11,'COASTLINE',fontsize=8,weight='bold',color='#444')
    side.text(0,.065,'Detailed local shoreline is taken directly from the\nupstream Syros geometry used by the AIS toolbox.',fontsize=8.7,color='#555',va='top',linespacing=1.4)

    fig.text(.05,.026,'Sources: ITSLab-UAegean/vesseltrack-tools AIS testing sample and syros.json geometry. Projection: EPSG:32635. Geometry shown is observational; gaps are disclosed.',fontsize=7.7,color='#666')
    fig.savefig(args.output_svg,facecolor=fig.get_facecolor(),bbox_inches='tight',pad_inches=.08,metadata={'Date': None, 'Creator': 'Agentic Data Newsroom'})
    fig.savefig(args.output_png,facecolor=fig.get_facecolor(),bbox_inches='tight',pad_inches=.08,dpi=200)
    plt.close(fig)

    manifest={
      'schema_version':'1.0.0','backend':'python_geopandas_matplotlib','geometry_engine':'Shapely/GEOS','projection_engine':'pyproj/PROJ','crs':crs,
      'track_source':track_meta.get('source'),'track_points':len(pts),'shoreline_source_blob_sha':'004c1c32410a5f50ed96d44b0d75027805dd1a58',
      'duration_s':int(duration),'max_sampled_speed_kt':float(pts['ground_speed_kt'].max()),
      'svg_sha256':hashlib.sha256(Path(args.output_svg).read_bytes()).hexdigest(),'png_sha256':hashlib.sha256(Path(args.output_png).read_bytes()).hexdigest()
    }
    Path(args.manifest).write_text(json.dumps(manifest,indent=2)+'\n')

if __name__=='__main__': main()
