#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path
import pandas as pd
import matplotlib as mpl
mpl.use('Agg')
import matplotlib.pyplot as plt
try:
    from runtime.gis.style_tokens import design,tok
except ModuleNotFoundError:
    import sys
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
    from runtime.gis.style_tokens import design,tok

mpl.rcParams['svg.fonttype']='none'
mpl.rcParams['svg.hashsalt']='agentic-data-newsroom-editorial-v1'
mpl.rcParams['font.family']=['DejaVu Sans']
mpl.rcParams['axes.unicode_minus']=False

def load_table(path):
    p=Path(path)
    if p.suffix.lower()=='.csv': return pd.read_csv(p)
    obj=json.loads(p.read_text())
    if isinstance(obj,list): return pd.DataFrame(obj)
    if isinstance(obj,dict) and isinstance(obj.get('rows'),list): return pd.DataFrame(obj['rows'])
    raise SystemExit('unsupported table input')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--request',required=True); args=ap.parse_args()
    req=json.loads(Path(args.request).read_text()); ds,t=design(req)
    if req.get('backend')!='python_publication': raise SystemExit('request backend must be python_publication')
    src=req.get('inputs',{}).get('table');
    if not src: raise SystemExit('editorial chart requires inputs.table')
    opt=req.get('options',{}); chart=opt.get('chart_type','line'); df=load_table(src)
    outdir=Path(req['output_dir']); outdir.mkdir(parents=True,exist_ok=True); svg=outdir/opt.get('svg_filename','figure.svg'); png=outdir/opt.get('png_filename','figure.png')
    bg=tok(t,'background','#fbfaf7'); primary=tok(t,'primary','#155f63'); secondary=tok(t,'secondary','#708b8c'); textc=tok(t,'text','#111111'); muted=tok(t,'muted','#555555'); gridc=tok(t,'grid','#ddd9d1'); accent=tok(t,'accent','#a84a32')
    fig,ax=plt.subplots(figsize=(11.5,7),dpi=180,facecolor=bg); ax.set_facecolor(bg)
    title=opt.get('title','Editorial chart'); subtitle=opt.get('subtitle'); source=opt.get('source_note','')
    fig.text(float(tok(t,'outer_left',.08)),.94,title,fontsize=float(opt.get('title_size',tok(t,'title_size',22))),fontweight=tok(t,'title_weight','bold'),ha='left',va='top',color=textc)
    if subtitle: fig.text(float(tok(t,'outer_left',.08)),.895,subtitle,fontsize=float(tok(t,'subtitle_size',10.5)),ha='left',va='top',color=muted)
    if chart=='line':
        x=opt.get('x_field'); y=opt.get('y_field');
        if not x or not y: raise SystemExit('line chart requires x_field and y_field')
        d=df[[x,y]].dropna().sort_values(x); ax.plot(d[x],d[y],lw=float(tok(t,'line_width',2.1)),color=primary); ax.scatter(d[x],d[y],s=float(tok(t,'point_size',16)),color=primary,zorder=3)
        ax.axhline(0,lw=.7,color='#b8b5ae',zorder=0); ax.set_xlabel(opt.get('x_label',x)); ax.set_ylabel(opt.get('y_label',y))
        if len(d): ax.annotate(f"{d.iloc[-1][y]:.2f}",(d.iloc[-1][x],d.iloc[-1][y]),xytext=(8,0),textcoords='offset points',va='center',fontsize=9,fontweight='bold')
    elif chart=='bar':
        cat=opt.get('category_field'); val=opt.get('value_field');
        if not cat or not val: raise SystemExit('bar chart requires category_field and value_field')
        cols=[cat,val]+([opt['label_field']] if opt.get('label_field') else []); d=df[cols].dropna(subset=[cat,val]).copy(); d=d.sort_values(val,ascending=True)
        colors=[accent if bool(opt.get('highlight_max',True)) and float(v)==float(d[val].max()) else secondary for v in d[val]]; bar_mode=tok(t,'bar_mode','bar')
        if bar_mode=='lollipop':
            ypos=list(range(len(d))); ax.hlines(ypos,[0]*len(d),d[val].astype(float),color=gridc,linewidth=2.0,zorder=1); ax.scatter(d[val].astype(float),ypos,c=colors,s=max(34,float(tok(t,'point_size',32))),zorder=3,edgecolors=bg,linewidths=.7); ax.set_yticks(ypos,d[cat].astype(str))
        else:
            ax.barh(d[cat].astype(str),d[val],height=float(tok(t,'bar_height',.62)),color=colors)
        ax.set_xlabel(opt.get('x_label',val)); ax.set_ylabel('')
        for i,(_,r) in enumerate(d.iterrows()):
            label=f"{r[val]:.1f}"; label+=f" · {r[opt['label_field']]}" if opt.get('label_field') else ''
            ax.text(float(r[val])+max(float(d[val].max()),1)*.012,i,label,va='center',fontsize=float(tok(t,'label_size',8.0)),color=textc)
        ax.set_xlim(left=min(0,float(d[val].min())))
    elif chart=='scatter':
        x=opt.get('x_field'); y=opt.get('y_field')
        if not x or not y: raise SystemExit('scatter chart requires x_field and y_field')
        cols=[x,y]+([opt['label_field']] if opt.get('label_field') else []); d=df[cols].dropna(subset=[x,y]).copy()
        ax.scatter(d[x],d[y],s=float(tok(t,'point_size',38)),color=primary,alpha=.82,edgecolors=bg,linewidths=.5,zorder=3)
        if opt.get('x_scale')=='log': ax.set_xscale('log')
        if opt.get('label_field'):
            for _,r in d.iterrows(): ax.annotate(str(r[opt['label_field']]),(r[x],r[y]),xytext=(4,4),textcoords='offset points',fontsize=max(6.5,float(tok(t,'label_size',8.0))-.7),color=textc)
        ax.set_xlabel(opt.get('x_label',x)); ax.set_ylabel(opt.get('y_label',y))
    else: raise SystemExit(f'unsupported chart_type: {chart}')
    ax.grid(axis='both' if chart=='scatter' else ('y' if chart=='line' else 'x'),color=gridc,lw=.6,alpha=float(tok(t,'grid_alpha',.7))); ax.set_axisbelow(True)
    for s in ['top','right','left']: ax.spines[s].set_visible(False)
    ax.spines['bottom'].set_color('#aaa69f'); ax.tick_params(labelsize=8.5,length=0)
    fig.subplots_adjust(left=max(.10,float(tok(t,'outer_left',.08))+.04),right=float(tok(t,'outer_right',.91)),top=float(tok(t,'plot_top',.80)),bottom=float(tok(t,'plot_bottom',.15)))
    if source: fig.text(float(tok(t,'outer_left',.08)),.035,source,fontsize=float(tok(t,'source_size',7.5)),color=muted,ha='left')
    fig.savefig(svg,bbox_inches='tight',pad_inches=.08,metadata={'Date':None,'Creator':'Agentic Data Newsroom'}); fig.savefig(png,bbox_inches='tight',pad_inches=.08,dpi=180); plt.close(fig)
    manifest={'schema_version':'1.1.0','design_system_id':ds.get('id'),'design_system_hash':ds.get('content_hash'),'backend':'python_publication','renderer':'editorial_chart','chart_type':chart,'rows':len(df),'svg_sha256':hashlib.sha256(svg.read_bytes()).hexdigest(),'png_sha256':hashlib.sha256(png.read_bytes()).hexdigest()}
    (outdir/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if __name__=='__main__': main()
