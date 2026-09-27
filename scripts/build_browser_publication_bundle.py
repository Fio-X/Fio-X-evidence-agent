#!/usr/bin/env python3
from pathlib import Path
import hashlib
ROOT=Path(__file__).resolve().parents[1]
PI=ROOT/'runtime'/'pi'; (PI/'vendor').mkdir(parents=True,exist_ok=True)

def write(src,dst,replacements=()):
    data=src.read_text(encoding='utf-8') if src.suffix in {'.mjs','.py'} else None
    if data is not None:
        for a,b in replacements:data=data.replace(a,b)
        raw=data.encode('utf-8');dst.write_bytes(raw)
    else:
        raw=src.read_bytes();dst.write_bytes(raw)
    print(f'{dst.relative_to(ROOT)} sha256={hashlib.sha256(raw).hexdigest()}')

write(ROOT/'runtime/web/publication.mjs',PI/'publication.mjs',[("../visual/style_mapping.mjs","./style_mapping.mjs"),("../visual/svg_security.mjs","./svg_security.mjs")])
write(ROOT/'runtime/web/plotly_editorial.mjs',PI/'plotly_editorial.mjs')
write(ROOT/'runtime/web/d3_editorial.mjs',PI/'d3_editorial.mjs')
write(ROOT/'runtime/web/scientific_map.mjs',PI/'scientific_map.mjs',[("../pi/basemap_registry.mjs","./basemap_registry.mjs"),("../visual/map_spec.mjs","./map_spec.mjs")])
write(ROOT/'runtime/visual/style_mapping.mjs',PI/'style_mapping.mjs')
write(ROOT/'runtime/visual/map_spec.mjs',PI/'map_spec.mjs',[("../pi/basemap_registry.mjs","./basemap_registry.mjs")])
write(ROOT/'runtime/visual/publication_binding.mjs',PI/'publication_binding.mjs')
write(ROOT/'runtime/visual/svg_security.mjs',PI/'svg_security.mjs')
# basemap_registry and flow_layout are canonical Pi/cartographic modules and already live under runtime/pi.
raw=(ROOT/'runtime/web/vendor/plotly-3.3.1.min.js').read_bytes();(PI/'vendor/plotly-3.3.1.min.js').write_bytes(raw);print(f'runtime/pi/vendor/plotly-3.3.1.min.js sha256={hashlib.sha256(raw).hexdigest()}')
write(ROOT/'runtime/browser/browser_qa.py',PI/'browser_qa.py')
write(ROOT/'runtime/browser/networkx_analyze.py',PI/'networkx_analyze.py')
write(ROOT/'runtime/browser/networkx_reduce.py',PI/'networkx_reduce.py')
write(ROOT/'runtime/gis/scientific_basemap_prepare.py',PI/'scientific_basemap_prepare.py')
write(ROOT/'runtime/visual/model_spec.mjs',PI/'model_spec.mjs')
