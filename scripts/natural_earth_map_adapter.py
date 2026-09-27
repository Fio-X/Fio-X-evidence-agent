#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, math, sys
from pathlib import Path
import shapefile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'fixtures' / 'external' / 'naturalearth_lowres' / 'naturalearth_lowres'
SOURCE_URL = 'https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/'
LICENSE = 'Public domain (Natural Earth terms of use)'

def source_hash():
    h = hashlib.sha256()
    for suffix in ('.shp', '.shx', '.dbf', '.prj', '.cpg'):
        p = BASE.with_suffix(suffix)
        h.update(suffix.encode())
        h.update(p.read_bytes())
    return h.hexdigest()

def project(lon, lat, width, height, pad=20):
    x = pad + (lon + 180.0) / 360.0 * (width - 2 * pad)
    y = pad + (90.0 - lat) / 180.0 * (height - 2 * pad)
    return x, y

def world_svg(width, height, mobile=False):
    r = shapefile.Reader(str(BASE.with_suffix('.shp')))
    paths=[]
    for shape in r.shapes():
        parts=list(shape.parts)+[len(shape.points)]
        for i in range(len(parts)-1):
            pts=shape.points[parts[i]:parts[i+1]]
            if len(pts)<3: continue
            coords=[project(float(lon), float(lat), width, height-64 if not mobile else height-82, 18) for lon,lat in pts]
            d='M '+' L '.join(f'{x:.2f},{y:.2f}' for x,y in coords)+' Z'
            paths.append(f'<path d="{d}"/>')
    title='Global observation context'
    desc='World geographic context derived from Natural Earth 1:110m Admin 0 country polygons, used only as a spatial scaffold for NASA GISTEMP observation-source categories; it does not show station locations, station density or anomaly intensity.'
    footer_y=height-42
    font=14 if mobile else 13
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="{desc}"><title>{title}</title><desc>{desc}</desc><rect width="{width}" height="{height}" fill="#f7f4ee"/><g fill="#d8ddd7" stroke="#ffffff" stroke-width="0.8">{''.join(paths)}</g><line x1="18" x2="{width-18}" y1="{footer_y-22}" y2="{footer_y-22}" stroke="#c8cdc8"/><text x="18" y="{footer_y}" font-family="Arial, sans-serif" font-size="{font}" font-weight="700" fill="#24313a">LAND WEATHER STATIONS · SHIPS &amp; BUOYS · ANTARCTIC STATIONS</text><text x="18" y="{footer_y+19}" font-family="Arial, sans-serif" font-size="{font-2}" fill="#69727a">Geographic context only. Observation locations and density are not encoded.</text></svg>'''

def main():
    request=json.load(sys.stdin)
    request_hash=request.get('request_hash')
    sh=source_hash()
    response={
      'origin':'software',
      'digital_source_type':'algorithmicMedia',
      'adapter_id':'natural-earth-gis-v1',
      'version':'1.0.0',
      'license':LICENSE,
      'disclosure':'Software-rendered geographic context from public-domain Natural Earth 1:110m Admin 0 country polygons; observation positions, station density and anomaly intensity are not encoded.',
      'variants':{
        'desktop':world_svg(900,520,False),
        'mobile':world_svg(640,540,True),
      },
      'metadata':{
        'asset_class':'published_gis',
        'production_lane':'gis_render',
        'source_url':SOURCE_URL,
        'source_sha256':sh,
        'credit':'Made with Natural Earth',
        'request_hash':request_hash,
      }
    }
    json.dump(response,sys.stdout,separators=(',',':'))

if __name__=='__main__': main()
