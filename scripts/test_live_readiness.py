#!/usr/bin/env python3
from __future__ import annotations
import json, os, stat, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def readiness(agent,extra=None):
    env={k:v for k,v in os.environ.items() if k not in ('NEWSROOM_AGENT','NEWSROOM_PI_BIN')}
    env.update(extra or {})
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
# With Pi selected, the pi row follows the pinned version: a fake pi (no network) of another version fails, the pinned one passes
pinned=json.loads((ROOT/'versions.json').read_text(encoding='utf-8'))['pi_coding_agent']
def pi_row(line):
    with tempfile.TemporaryDirectory(prefix='fakepi-') as folder:
        fake=Path(folder)/'pi'
        fake.write_text(f"#!/bin/sh\necho '{line}'\n")
        fake.chmod(fake.stat().st_mode|stat.S_IXUSR)
        report=readiness('pi',{'NEWSROOM_PI_BIN':str(fake)})
    rows=[row for row in report['checks'] if row['name']=='pi']
    if len(rows)!=1 or not rows[0].get('required'): raise SystemExit(f'pi row missing or not required for {line!r}')
    return report,rows[0]
report,row=pi_row('0.86.0')
if row['ok'] or report['live_ready']: raise SystemExit('a fake pi 0.86.0 must fail the pinned check and make live_ready false')
report,row=pi_row(pinned)
if not row['ok']: raise SystemExit(f'a fake pi {pinned} must pass the pinned check')
print(f"live readiness contract: PASS (live_ready={str(report['live_ready']).lower()})")
