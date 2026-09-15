#!/usr/bin/env python3
from pathlib import Path
import json, subprocess, tempfile
from PIL import Image,ImageDraw

def run(im_path,out):
    subprocess.run(['python3','scripts/visual_qa_probe.py','--input',str(im_path),'--output',str(out)],check=True,stdout=subprocess.DEVNULL)
    return json.loads(Path(out).read_text())
with tempfile.TemporaryDirectory() as td:
    td=Path(td)
    good=Image.new('RGB',(1200,700),'#fbfaf7'); d=ImageDraw.Draw(good); d.rectangle((90,120,1110,610),outline='#222222',width=3); d.line((120,540,1050,210),fill='#235f74',width=8); good.save(td/'good.png')
    r=run(td/'good.png',td/'good.json')
    assert r['machine_role']=='diagnostic_only' and r['competition_readiness']=='UNASSESSED'
    tiny=Image.new('RGB',(320,200),'white'); tiny.save(td/'tiny.png'); r2=run(td/'tiny.png',td/'tiny.json'); assert r2['status']=='BLOCK' and 'insufficient_raster_resolution' in r2['hard_failures']
print('visual qa v1.33: PASS')
