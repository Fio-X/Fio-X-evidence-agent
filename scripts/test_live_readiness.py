#!/usr/bin/env python3
from __future__ import annotations
import json, os, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def readiness(agent):
    env={k:v for k,v in os.environ.items() if k!='NEWSROOM_AGENT'}
    if agent is not None:
        env['NEWSROOM_AGENT']=agent
    cp=subprocess.run([sys.executable,str(ROOT/'scripts/live_readiness.py')],capture_output=True,text=True,env=env)
    if cp.returncode not in (0,2):
        print(cp.stdout); print(cp.stderr,file=sys.stderr); raise SystemExit(f'unexpected readiness exit {cp.returncode}')
    report=json.loads(cp.stdout)
    if report.get('schema_version')!='0.7.0':
        raise SystemExit('readiness schema version mismatch')
    return report

# Pi is required only when it is the selected runtime (the same rule as `news doctor`)
base={'node','duckdb','rustc','cargo'}
for agent,required in ((None,base),('rust',base),('pi',base|{'pi'})):
    report=readiness(agent)
    names={row['name'] for row in report['checks'] if row.get('required')}
    if names != required:
        raise SystemExit(f'readiness required check set mismatch with NEWSROOM_AGENT={agent}: {names}')
    listed={row['name'] for row in report['checks']}
    if ('pi' in listed) != ('pi' in required):
        raise SystemExit(f'pi listed wrongly with NEWSROOM_AGENT={agent}: {listed}')
print(f"live readiness contract: PASS (live_ready={str(report['live_ready']).lower()})")
