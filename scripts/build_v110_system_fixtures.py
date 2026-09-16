#!/usr/bin/env python3
from pathlib import Path
import json, math, random
import networkx as nx
import shapefile
ROOT=Path(__file__).resolve().parents[1]
out=ROOT/'fixtures'/'v110-systems';out.mkdir(parents=True,exist_ok=True)
# NHC 2026 operational two-thirds probability circle radii, Atlantic basin.
horiz=[12,24,36,48,60,72,96,120]
radii=[25,39,49,62,77,95,134,200]
nhc={"source":"NHC 2026 operational track forecast cone","coverage":2/3,"coverage_semantics":"empirical_historical_error","series":[{"horizon":h,"lower":-r,"central":0,"upper":r,"unit":"nautical miles"} for h,r in zip(horiz,radii)]}
(out/'nhc-cone-2026.json').write_text(json.dumps(nhc,indent=2)+"\n")
# Current USGS past-day sample visible from the official feed at qualification time.
rows=[
(0.52,-116.902333333333,33.3253333333333,18.74,'5 km SW of Palomar Observatory, CA'),
(2.32,-155.502334594727,19.1371669769287,31.08,'7 km SSW of Pahala, Hawaii'),
(5.5,105.8726,-8.5419,10,'187 km SSW of Pelabuhanratu, Indonesia'),
(1.8,-151.437,63.113,5,'49 km SSE of Denali National Park, Alaska'),
(1.3,-148.752,63.615,5,'15 km SSE of Denali Park, Alaska'),
(1.57,-122.791999816895,38.8125,3.32,'5 km NW of The Geysers, CA'),
(1.07,-122.794166564941,38.8120002746582,3.49,'5 km NW of The Geysers, CA'),
(1.25,-122.810165405273,38.8211669921875,2.58,'7 km NW of The Geysers, CA'),
(2.28,-112.903,38.5188333333333,3.02,'16 km NE of Milford, Utah'),
(1.5,-98.078,28.882,10.0889,'12 km SSW of Falls City, Texas'),
(1.9,-107.2136,40.0871,5,'26 km WSW of Yampa, Colorado'),
(1.81,-124.549835205078,40.2890014648438,24.35,'23 km W of Petrolia, CA'),
(1.85,-118.934166666667,35.3218333333333,20.64,'7 km NNW of Lamont, CA'),
(2.0,-107.2425,40.0775,5,'29 km WSW of Yampa, Colorado'),
(1.8,-148.428,62.902,60,'60 km SSE of Cantwell, Alaska')]
quakes=[{"id":f"q{i+1}","mag":mag,"lon":lon,"lat":lat,"depth_km":depth,"place":place} for i,(mag,lon,lat,depth,place) in enumerate(rows)]
(out/'usgs-past-day-sample.json').write_text(json.dumps({"sample_count":len(quakes),"events":quakes},indent=2)+"\n")
# Local Natural Earth world outline as equirectangular line arrays, avoids external map requests.
shp=str(ROOT/'fixtures'/'external'/'naturalearth_lowres'/'naturalearth_lowres.shp')
r=shapefile.Reader(shp)
lon=[];lat=[]
for shape in r.shapes():
    pts=shape.points; parts=list(shape.parts)+[len(pts)]
    for a,b in zip(parts[:-1],parts[1:]):
        for x,y in pts[a:b]:lon.append(round(x,4));lat.append(round(y,4))
        lon.append(None);lat.append(None)
(out/'world-outline.json').write_text(json.dumps({"lon":lon,"lat":lat})+"\n")
# Large graph pressure fixture: deterministic 5k-node scale-free topology with circular coordinates.
G=nx.barabasi_albert_graph(5000,2,seed=42)
pos=nx.circular_layout(G,scale=1.0)
deg=dict(G.degree())
nodes=[{"id":str(n),"label":f"Node {n}","degree":deg[n],"community":n%23,"x":round(float(pos[n][0]),8),"y":round(float(pos[n][1]),8)} for n in G.nodes()]
edges=[{"source":str(u),"target":str(v)} for u,v in G.edges()]
(out/'large-network-5000.json').write_text(json.dumps({"nodes":nodes,"edges":edges,"summary":{"node_count":len(nodes),"edge_count":len(edges),"max_degree":max(deg.values())}},separators=(',',':'))+"\n")
print(json.dumps({"nhc_rows":len(horiz),"quake_sample":len(quakes),"large_nodes":len(nodes),"large_edges":len(edges),"world_points":len(lon)}))
