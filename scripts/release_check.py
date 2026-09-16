#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def load_profile(name, cfg):
    profiles=cfg['profiles']; p=profiles[name]; chain=[]
    if p.get('extends'): chain.extend(load_profile(p['extends'],cfg))
    chain.append(p); return chain

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--profile',choices=['pr','rc','final'],default='pr');ap.add_argument('--output',default='outputs/release-check.json');args=ap.parse_args()
    cfg=json.loads((ROOT/'config/release-profiles.json').read_text());chain=load_profile(args.profile,cfg)
    commands=[];required=[];manual=[]
    for p in chain:
        commands.extend(p.get('commands',[])); required.extend(p.get('required_files',[])); manual.extend(p.get('manual_gates',[]))
    missing=sorted({x for x in required if not (ROOT/x).is_file()})
    results=[];ok=not missing
    env=os.environ.copy()
    for cmd in commands:
        # SECURITY: cmd comes from trusted config file release-profiles.json (not user input)
        # shell=True is safe here and allows for potential shell features in commands
        t=time.perf_counter();proc=subprocess.run(cmd,shell=True,cwd=ROOT,text=True,capture_output=True,env=env);dt=round((time.perf_counter()-t)*1000,1)
        results.append({'command':cmd,'status':'PASS' if proc.returncode==0 else 'FAIL','returncode':proc.returncode,'duration_ms':dt,'stdout_tail':proc.stdout[-4000:],'stderr_tail':proc.stderr[-4000:]})
        if proc.returncode!=0: ok=False
    report={'schema_version':'0.2.0','profile':args.profile,'status':'PASS' if ok else 'FAIL','missing_required_files':missing,'commands':results,'manual_gates':manual}
    out=ROOT/args.output;out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));raise SystemExit(0 if ok else 2)
if __name__=='__main__': main()
