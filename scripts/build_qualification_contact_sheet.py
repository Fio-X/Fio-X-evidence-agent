#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,math
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

def fit(im,w,h):
    c=im.copy(); c.thumbnail((w,h),Image.Resampling.LANCZOS)
    bg=Image.new('RGB',(w,h),'white'); bg.paste(c,((w-c.width)//2,(h-c.height)//2)); return bg

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--run-dir',required=True); ap.add_argument('--output',required=True); ap.add_argument('--cols',type=int,default=4); args=ap.parse_args()
    run=Path(args.run_dir); s=json.loads((run/'run-summary.json').read_text()); cards=[]
    for c in s['cases']:
        row=next((r for r in c['rows'] if r.get('status')=='RENDERED' and any(a.get('file','').endswith('.png') for a in r.get('artifacts',[]))),None)
        if not row: continue
        png=next(a['file'] for a in row['artifacts'] if a['file'].endswith('.png')); p=run/c['id']/row['backend']/png
        cards.append((c['id'],c.get('design_system_id','?'),row['backend'],Image.open(p).convert('RGB')))
    cw,ch=470,330; cap=52; gap=12; cols=max(1,args.cols); rows=math.ceil(len(cards)/cols)
    canvas=Image.new('RGB',(cols*cw+(cols+1)*gap,rows*(ch+cap)+(rows+1)*gap),'#e9e7e2'); d=ImageDraw.Draw(canvas); font=ImageFont.load_default()
    for i,(cid,ds,b,im) in enumerate(cards):
        x=gap+(i%cols)*cw; y=gap+(i//cols)*(ch+cap); canvas.paste(fit(im,cw,ch),(x,y));
        d.rectangle((x,y+ch,x+cw,y+ch+cap),fill='white'); d.text((x+8,y+ch+7),cid,fill='#111',font=font); d.text((x+8,y+ch+27),f'{ds} · {b}',fill='#555',font=font)
    Path(args.output).parent.mkdir(parents=True,exist_ok=True); canvas.save(args.output,optimize=True)
    print(json.dumps({'cards':len(cards),'output':args.output}))
if __name__=='__main__': main()
