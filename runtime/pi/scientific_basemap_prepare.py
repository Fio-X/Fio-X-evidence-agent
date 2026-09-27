#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
from mpl_toolkits.basemap import Basemap

def stable_hash(obj):return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def seg_features(segments,kind):
    out=[]
    for i,seg in enumerate(segments):
        coords=[[round(float(x),6),round(float(y),6)] for x,y in seg if -180<=float(x)<=180 and -90<=float(y)<=90]
        if len(coords)>=2:out.append({'type':'Feature','properties':{'kind':kind,'index':i},'geometry':{'type':'LineString','coordinates':coords}})
    return out

def prepare(spec):
    e=spec['extent'];res=spec.get('resolution') or ('i' if spec.get('task') in {'local','site'} else 'l')
    m=Basemap(projection='cyl',llcrnrlon=e['west'],urcrnrlon=e['east'],llcrnrlat=e['south'],urcrnrlat=e['north'],resolution=res)
    features=[];features+=seg_features(m.drawcoastlines().get_segments(),'coastline')
    if spec.get('include_rivers',True):features+=seg_features(m.drawrivers().get_segments(),'river')
    if spec.get('include_boundaries',True):features+=seg_features(m.drawcountries().get_segments(),'admin0')
    detail={'c':'coarse','l':'low','i':'intermediate','h':'high','f':'full'}.get(res,res)
    asset={'schema_version':'0.2.0','id':None,'extent':e,'task':spec.get('task','regional'),'detail_class':detail,'resolution_code':res,'nominal_scale':spec.get('nominal_scale') or ('1:1,000,000' if res in {'i','h','f'} else '1:50,000,000'),'source_url':'https://www.soest.hawaii.edu/pwessel/gshhg/','license':'GSHHG public data; see upstream license','features':features,'relief':None}
    asset['content_hash']=stable_hash(asset);asset['id']='gshhg_'+res+'_'+asset['content_hash'][:12];return asset

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--request',required=True);ap.add_argument('--output',required=True);args=ap.parse_args();spec=json.loads(Path(args.request).read_text());asset=prepare(spec);p=Path(args.output);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(asset,indent=2)+'\n');print(json.dumps({'status':'PASS','id':asset['id'],'content_hash':asset['content_hash'],'features':len(asset['features'])}))
if __name__=='__main__':main()
