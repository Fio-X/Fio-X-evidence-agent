#!/usr/bin/env python3
from __future__ import annotations
import struct, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
MAP=ROOT/'outputs'/'v15-carto'
MAG=ROOT/'outputs'/'v15-carto-magazine'

def png_size(path: Path):
    b=path.read_bytes()
    if b[:8] != b'\x89PNG\r\n\x1a\n': raise SystemExit(f'not png: {path}')
    return struct.unpack('>II',b[16:24])

def raster(svg: Path, png: Path, width: int):
    subprocess.run(['python3',str(ROOT/'runtime/pi/rasterize_svg.py'),'--width',str(width),str(svg),str(png)],check=True)
    w,h=png_size(png)
    if w != width: raise SystemExit(f'{png.name}: width {w} != {width}')
    if png.stat().st_size < 15000: raise SystemExit(f'{png.name}: raster unexpectedly small')
    return w,h

for stem,width in [('eia-abstract',1040),('eia-abstract.mobile',640),('world-bank-remittance-2021',1040),('world-bank-remittance-2021.mobile',640),('contract-great-circle',1040)]:
    svg=MAP/f'{stem}.svg'; png=MAP/f'{stem}.png'
    if not svg.is_file(): raise SystemExit(f'missing cartographic svg: {svg}')
    raster(svg,png,width)
    text=svg.read_text(encoding='utf-8')
    for token in ('data-role="cartographic-basemap"','data-role="cartographic-disclosure"','data-role="cartographic-direction-key"','data-geometry-semantics='):
        if token not in text: raise SystemExit(f'{stem}: missing {token}')

for stem,width,max_h in [('eia-cartographic-flow-feature',1440,3400),('eia-cartographic-flow-feature.mobile',720,4200)]:
    svg=MAG/f'{stem}.svg'; png=MAG/f'{stem}.png'
    if not svg.is_file(): raise SystemExit(f'missing magazine svg: {svg}')
    w,h=raster(svg,png,width)
    if h >= max_h: raise SystemExit(f'{stem}: height {h} exceeds {max_h}')
    text=svg.read_text(encoding='utf-8')
    tokens=['different factual meanings']
    if width == 1440: tokens += ['data-role="scene-boundary"','A relationship map with a hard factual boundary']
    for token in tokens:
        if token not in text: raise SystemExit(f'{stem}: missing {token}')
print('cartographic raster v1.5 PASS')
print('map',png_size(MAP/'eia-abstract.png'),'magazine',png_size(MAG/'eia-cartographic-flow-feature.png'),'mobile',png_size(MAG/'eia-cartographic-flow-feature.mobile.png'))
