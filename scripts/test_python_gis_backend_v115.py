from pathlib import Path
import json, subprocess, sys, hashlib
root=Path(__file__).resolve().parents[1]
out=root/'outputs/gis-python'; out.mkdir(parents=True,exist_ok=True)
cmd=[sys.executable,str(root/'runtime/gis/python_publication_map.py'),
 '--track',str(root/'fixtures/v16-movement/ais-syros-sampled.json'),
 '--shoreline',str(root/'runtime/gis/assets/syros-upstream-shoreline-excerpt.geojson'),
 '--island',str(root/'runtime/pi/assets/gshhs-i-syros-local.geojson'),
 '--output-svg',str(out/'syros-python-gis.svg'),'--output-png',str(out/'syros-python-gis.png'),'--manifest',str(out/'syros-python-gis.manifest.json')]
subprocess.run(cmd,check=True)
svg=out/'syros-python-gis.svg'; png=out/'syros-python-gis.png'
m=json.loads((out/'syros-python-gis.manifest.json').read_text())
assert m['crs']=='EPSG:32635' and m['track_points']==15 and m['duration_s']==9360
assert svg.stat().st_size>10000
assert png.stat().st_size>50000
first_svg=hashlib.sha256(svg.read_bytes()).hexdigest()
first_png=hashlib.sha256(png.read_bytes()).hexdigest()
subprocess.run(cmd,check=True)
second_svg=hashlib.sha256(svg.read_bytes()).hexdigest()
second_png=hashlib.sha256(png.read_bytes()).hexdigest()
assert first_svg == second_svg, (first_svg, second_svg)
assert first_png == second_png, (first_png, second_png)
m2=json.loads((out/'syros-python-gis.manifest.json').read_text())
assert m2['svg_sha256']==second_svg and m2['png_sha256']==second_png
print('Python GIS publication backend v1.15 PASS deterministic',second_svg[:12],second_png[:12])
