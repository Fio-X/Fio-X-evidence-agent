#!/usr/bin/env python3
from __future__ import annotations
import struct, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs'/'nasa-gistemp-v14'

def size(path):
    b=path.read_bytes();
    if b[:8] != b'\x89PNG\r\n\x1a\n': raise SystemExit(f'not png: {path}')
    return struct.unpack('>II',b[16:24])
for stem,width in [('nasa-gistemp-v14',1440),('nasa-gistemp-v14.mobile',720),('nasa-gistemp-v14.alt',1440),('nasa-gistemp-v14.alt.mobile',720)]:
    svg=OUT/f'{stem}.svg'; png=OUT/f'{stem}.png'
    subprocess.run(['python3',str(ROOT/'runtime/pi/rasterize_svg.py'),'--width',str(width),str(svg),str(png)],check=True)
    w,h=size(png)
    if w != width: raise SystemExit(f'{stem} width {w} != {width}')
    is_alt='.alt' in stem
    limit=(3000 if is_alt else 2600) if width==1440 else (5000 if is_alt else 4500)
    if h >= limit: raise SystemExit(f'{stem} height {h} exceeds {limit}')
    if png.stat().st_size < 40000: raise SystemExit(f'{stem} png suspiciously small')
text=(OUT/'nasa-gistemp-v14.svg').read_text(encoding='utf-8')
for token in ('Made with Natural Earth','One measurement, seen in place and time','data-role="scene-boundary"'):
    if token not in text: raise SystemExit(f'missing raster-evidence token: {token}')
print(f'v1.4 NASA raster: PASS desktop={size(OUT/"nasa-gistemp-v14.png")} mobile={size(OUT/"nasa-gistemp-v14.mobile.png")} alt={size(OUT/"nasa-gistemp-v14.alt.png")}')
