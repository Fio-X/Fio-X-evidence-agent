#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, os, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def make_zip(out,include_outputs=False):
    out=Path(out);out.parent.mkdir(parents=True,exist_ok=True)
    prefix=ROOT.name
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(ROOT.rglob('*')):
            if not p.is_file():continue
            rel=p.relative_to(ROOT).as_posix()
            if any(part in {'__pycache__','.git'} for part in p.parts):continue
            if rel.startswith('.newsroom/'):continue
            if not include_outputs and rel.startswith('outputs/'):continue
            z.write(p,f'{prefix}/{rel}')
    h=hashlib.sha256(out.read_bytes()).hexdigest();print(f'{out} sha256={h} bytes={out.stat().st_size}')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source',required=True);ap.add_argument('--evidence');args=ap.parse_args();make_zip(args.source,False)
    if args.evidence:make_zip(args.evidence,True)
if __name__=='__main__':main()
