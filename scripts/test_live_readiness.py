#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
cp=subprocess.run([sys.executable,str(ROOT/'scripts/live_readiness.py')],capture_output=True,text=True)
if cp.returncode not in (0,2):
    print(cp.stdout); print(cp.stderr,file=sys.stderr); raise SystemExit(f'unexpected readiness exit {cp.returncode}')
report=json.loads(cp.stdout)
required={'node','pi','duckdb','rustc','cargo'}
names={row['name'] for row in report['checks'] if row.get('required')}
if names != required:
    raise SystemExit(f'readiness required check set mismatch: {names}')
if report.get('schema_version')!='0.7.0':
    raise SystemExit('readiness schema version mismatch')
print(f"live readiness contract: PASS (live_ready={str(report['live_ready']).lower()})")
