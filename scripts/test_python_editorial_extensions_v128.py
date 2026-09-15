#!/usr/bin/env python3
from __future__ import annotations
import hashlib,json,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def run(req):
    with tempfile.TemporaryDirectory(dir=ROOT/'outputs') as td:
        out=Path(td); req=dict(req); req['output_dir']=str(out.relative_to(ROOT)); rp=out/'request.json'; rp.write_text(json.dumps(req))
        subprocess.run(['python3','runtime/gis/python_publication_request.py','--request',str(rp.relative_to(ROOT))],cwd=ROOT,check=True,capture_output=True,text=True)
        m=json.loads((out/'manifest.json').read_text()); return m,(out/'figure.svg').read_bytes()
base={'schema_version':'1.1.0','backend':'python_publication','story_id':'test','recipe_path':'x','semantic_fingerprint':'a'*64,'evidence_hashes':{'x':'b'*64},'claim_ids':['claim:test']}
scatter={**base,'inputs':{'table':'fixtures/realdata/worldbank-gdp-life-2024.csv'},'options':{'renderer':'editorial_chart','chart_type':'scatter','x_field':'gdp_per_capita_usd','y_field':'life_expectancy_years','label_field':'country','x_scale':'log','title':'GDP and life','source_note':'fixture'}}
m1,b1=run(scatter); m2,b2=run(scatter); assert m1['renderer']=='editorial_chart' and m1['chart_type']=='scatter'; assert hashlib.sha256(b1).hexdigest()==hashlib.sha256(b2).hexdigest()
flow={**base,'story_id':'flow','inputs':{'table':'fixtures/v09-realdata/eia-us-crude-imports-2024.csv','basemap':'fixtures/external/naturalearth_lowres/naturalearth_lowres.shp'},'options':{'renderer':'flow_map','source_field':'country','target_field':'target','value_field':'thousand_bpd','source_lon_field':'source_lon','source_lat_field':'source_lat','target_lon_field':'target_lon','target_lat_field':'target_lat','title':'Crude imports','source_note':'fixture'}}
m3,b3=run(flow); assert m3['renderer']=='flow_map' and m3['rows']==6 and len(b3)>1000
print('python editorial extensions v1.28: PASS')
