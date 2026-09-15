#!/usr/bin/env python3
from __future__ import annotations
import struct, subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
FLIGHT=ROOT/'outputs'/'v16-flight'
AIS=ROOT/'outputs'/'v16-ais'

def png_size(path: Path):
    b=path.read_bytes()
    if b[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'not png: {path}')
    return struct.unpack('>II',b[16:24])

def raster(svg: Path,png: Path,width: int,min_bytes: int=12000):
    subprocess.run(['python3',str(ROOT/'runtime/pi/rasterize_svg.py'),'--width',str(width),str(svg),str(png)],check=True)
    w,h=png_size(png)
    if w != width: raise SystemExit(f'{png.name}: width {w} != {width}')
    if png.stat().st_size < min_bytes: raise SystemExit(f'{png.name}: raster unexpectedly small ({png.stat().st_size})')
    return w,h

for stem,width in [('dal1812-observed-map',1040),('dal1812-observed-map.mobile',640)]:
    svg=FLIGHT/f'{stem}.svg'; png=FLIGHT/f'{stem}.png'; raster(svg,png,width)
    text=svg.read_text(encoding='utf-8')
    for token in ('data-role="trajectory-marker"','data-role="cartographic-reference"','data-role="cartographic-locator"','coverage resumes','data-fitted extent'):
        if token not in text: raise SystemExit(f'{stem}: missing {token}')

for stem,width,max_h in [('dal1812-feature',1440,3400),('dal1812-feature.mobile',720,4200)]:
    svg=FLIGHT/f'{stem}.svg'; png=FLIGHT/f'{stem}.png'; w,h=raster(svg,png,width,18000)
    if h >= max_h: raise SystemExit(f'{stem}: height {h} exceeds {max_h}')
    text=svg.read_text(encoding='utf-8')
    for token in ('Inside an observed flight path','48-minute gap','The route has a vertical and kinetic shape'):
        if token not in text: raise SystemExit(f'{stem}: missing {token}')
    if '>-19 min</text>' in text or '>-1 min</text>' in text:
        raise SystemExit(f'{stem}: trajectory elapsed-time axis leaked a negative tick')

# Deliberate local-scale failure diagnostic: the trajectory is real-movement-based,
# but the 1:110m basemap is intentionally too coarse. The visual remains release evidence.
for stem,width in [('syros-local-trajectory',1040),('syros-local-trajectory.mobile',640)]:
    svg=AIS/f'{stem}.svg'; png=AIS/f'{stem}.png'; raster(svg,png,width,9000)
    text=svg.read_text(encoding='utf-8')
    for token in ('harbour scale','1:110m'):
        if token not in text: raise SystemExit(f'{stem}: missing local-scale caveat {token}')

print('trajectory/cartography raster v1.6 PASS')
print('flight map',png_size(FLIGHT/'dal1812-observed-map.png'))
print('flight feature',png_size(FLIGHT/'dal1812-feature.png'))
print('flight mobile',png_size(FLIGHT/'dal1812-feature.mobile.png'))
print('AIS diagnostic',png_size(AIS/'syros-local-trajectory.png'))
