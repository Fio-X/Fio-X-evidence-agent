#!/usr/bin/env python3
import json, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
for p in (ROOT/'runtimes').glob('*/manifest.json'):
    m=json.loads(p.read_text()); assert m['capabilities'] and m['probes']
out=subprocess.check_output([sys.executable,str(ROOT/'scripts/runtime_health.py')],text=True)
health=json.loads(out)
assert health['runtimes']['viz-python']['status']=='AVAILABLE', health['runtimes']['viz-python']
for rid,row in health['runtimes'].items(): assert row['status'] in {'AVAILABLE','UNAVAILABLE'}
print('runtime foundation v1.16 PASS')
