#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, os, re, stat, subprocess, sys, tempfile
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
# the version reading is the one in src/commands/doctor.rs (same cases as its unit tests)
spec=importlib.util.spec_from_file_location('live_readiness',ROOT/'scripts/live_readiness.py')
lr=importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
NODE,DUCK,RUST=(22,19,0),(1,5,5),(1,98,1)
def ok(text,minimum,lead=None):
    found=lr.parse_version(text,lead)
    return found is not None and found>=minimum
def old_node_ok(text):
    # the reading this script used for node before: a search anywhere in the first line
    lines=text.splitlines()
    match=re.search(r'v?(\d+)\.(\d+)\.(\d+)',lines[0] if lines else '')
    return bool(match and tuple(map(int,match.groups()))>=NODE)
passing=[('v22.19.0',NODE,None),('v22.20.0',NODE,None),('22.20.1',NODE,None),('v1.5.5 (Variegata) 08a1d3a',DUCK,None),
 ('v2.0.0',DUCK,None),('rustc 1.98.1 (5f4bd0ee6 2026-06-25)',RUST,'rustc'),('rustc 1.100.0 (abc 2026-09-01)',RUST,'rustc')]
failing=[('v22.18.9',NODE,None),('v22.19.0-rc.1',NODE,None),('v22.19.0-nightly20260101abc',NODE,None),('node 22.19.0',NODE,None),
 ('Node.js v22.20.0',NODE,None),('WARNING: using 22.19.0',NODE,None),('',NODE,None),('v22.19',NODE,None),('v22.19.0.1',NODE,None),
 ('vv22.19.0',NODE,None),('v1.5.4 (Variegata) 0000000',DUCK,None),('v1.5.5-dev',DUCK,None),('v1.5.5+build7 (Variegata) 08a1d3a',DUCK,None),
 ('Warning: config 2.0.0',DUCK,None),('Warning: x\nv2.0.0',DUCK,None),('rustc 1.98.0 (abc 2026-05-14)',RUST,'rustc'),
 ('rustc 1.98.1-beta (abc 2026-07-01)',RUST,'rustc'),('rustc 1.99.0-nightly (abc 2026-07-01)',RUST,'rustc'),('1.98.1',RUST,'rustc'),
 ('cargo 1.98.1 (abc 2026-06-25)',RUST,'rustc'),('rustc',RUST,'rustc'),('1.98.1 rustc',RUST,'rustc'),('rustc unknown',RUST,'rustc'),('rustc 1.x.1',RUST,'rustc')]
for text,minimum,lead in passing:
    if not ok(text,minimum,lead): raise SystemExit(f'version reading should pass: {text!r}')
for text,minimum,lead in failing:
    if ok(text,minimum,lead): raise SystemExit(f'version reading should fail: {text!r}')
# node is never looser than before: whatever passes now passed with the old search
for text,minimum,lead in passing+failing:
    if minimum==NODE and ok(text,minimum) and not old_node_ok(text): raise SystemExit(f'node got looser on {text!r}')
# `--meets <name>` (what bootstrap_live_env.sh asks before it installs anything): fake tools on a PATH of their own, no network
def meets(tools,name):
    with tempfile.TemporaryDirectory(prefix='meets-') as folder:
        for tool,line in tools.items():
            path=Path(folder)/tool
            path.write_text(f"#!/bin/sh\necho '{line}'\n")
            path.chmod(path.stat().st_mode|stat.S_IXUSR)
        env={'PATH':folder,'HOME':folder}
        return subprocess.run([sys.executable,str(ROOT/'scripts/live_readiness.py'),'--meets',name],capture_output=True,text=True,env=env).returncode
cases=[
 ('node','v22.19.0',0),('node','v24.14.1',0),('node','v22.18.9',1),('node','v22.19.0-rc.1',1),('node','v22.19',1),('node','node 22.19.0',1),
 ('duckdb','v1.5.5 (Variegata) 08a1d3a',0),('duckdb','v1.6.0 (Next) 0000000',0),('duckdb','v1.5.4 (Variegata) 0000000',1),
 ('duckdb','v1.5.5-dev',1),('duckdb','v1.5',1),('duckdb','Warning: config 2.0.0',1),
 ('rustc','rustc 1.98.1 (abc 2026-06-25)',0),('rustc','rustc 1.100.0 (abc 2026-09-01)',0),('rustc','rustc 1.98.0 (abc 2026-05-14)',1),
 ('rustc','rustc 1.99.0-nightly (abc 2026-07-01)',1),('rustc','rustc 1.98',1),('rustc','cargo 1.98.1 (abc 2026-06-25)',1),
 ('cargo','cargo 1.98.1 (abc 2026-06-25)',0)]
for tool,line,want in cases:
    got=meets({tool:line},tool)
    if got!=want: raise SystemExit(f'--meets {tool} on {line!r}: exit {got}, wanted {want}')
if meets({},'node')!=1: raise SystemExit('--meets node with no node should exit 1')
if meets({'node':'v22.19.0'},'bogus')!=64: raise SystemExit('--meets with an unknown name should exit 64')
print(f"live readiness contract: PASS (live_ready={str(report['live_ready']).lower()})")
