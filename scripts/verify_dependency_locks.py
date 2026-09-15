#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,subprocess,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',default='');args=ap.parse_args()
    lock_pairs=[('runtime/web/package.json','runtime/web/package-lock.json'),('runtime/sigma/package.json','runtime/sigma/package-lock.json'),('runtime/map/package.json','runtime/map/package-lock.json'),('runtime/d3/package.json','runtime/d3/package-lock.json')]
    errors=[];details=[]
    cargo=(ROOT/'Cargo.lock');details.append({'path':'Cargo.lock','present':cargo.is_file(),'bytes':cargo.stat().st_size if cargo.is_file() else 0})
    if not cargo.is_file(): errors.append('missing Cargo.lock')
    for manifest_rel,lock_rel in lock_pairs:
        mp,lp=ROOT/manifest_rel,ROOT/lock_rel
        rec={'path':lock_rel,'present':lp.is_file(),'bytes':lp.stat().st_size if lp.is_file() else 0};details.append(rec)
        if not lp.is_file(): errors.append(f'missing {lock_rel}'); continue
        manifest=json.loads(mp.read_text()); lock=json.loads(lp.read_text())
        rootpkg=(lock.get('packages') or {}).get('',{})
        if rootpkg.get('version') != manifest.get('version'): errors.append(f'{lock_rel}: root version mismatch')
        if (rootpkg.get('dependencies') or {}) != (manifest.get('dependencies') or {}): errors.append(f'{lock_rel}: root dependencies do not exactly match package.json')
    if cargo.is_file() and shutil.which('cargo'):
        cp=subprocess.run(['cargo','metadata','--locked','--no-deps','--format-version','1'],cwd=ROOT,capture_output=True,text=True)
        if cp.returncode!=0: errors.append('Cargo.lock rejected by cargo metadata --locked: '+cp.stderr[-500:])
    out={'schema_version':'0.1.0','release':'1.13.0-rc1','status':'PASS' if not errors else 'BLOCKED','errors':errors,'lockfiles':details}
    if args.output:
        p=ROOT/args.output;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(out,indent=2)+'\n')
    print(json.dumps(out,indent=2));raise SystemExit(0 if not errors else 2)
if __name__=='__main__':main()
