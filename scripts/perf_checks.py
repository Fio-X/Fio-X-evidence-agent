#!/usr/bin/env python3
"""Sequential focused checks with per-command watchdogs and retained logs."""
import json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1];out=root/'perf-results';rows=[]
commands=[['cargo','test','--all-targets','--locked'],['cargo','clippy','--all-targets','--locked','--','-D','warnings'],['cargo','fmt','--all','--','--check'],['bash','scripts/test_control_plane.sh'],['python3','scripts/selftest_evaluator.py'],['python3','scripts/test_integrity_adversarial.py'],['node','scripts/test_stream_limits.mjs'],['node','scripts/test_content_addressing.mjs'],['node','scripts/test_web_runtime_contract_v120.mjs'],['node','scripts/test_process_runner.mjs'],['python3','scripts/test_rpc_waits.py','target/release/news'],['python3','scripts/test_pi_route_alias.py']]
for i,cmd in enumerate(commands):
 with (out/f'check-{i:02}.log').open('wb') as f:
  try:r=subprocess.run(cmd,cwd=root,stdout=f,stderr=subprocess.STDOUT,timeout=120);code=r.returncode
  except subprocess.TimeoutExpired:code=124
 rows.append({'command':cmd,'code':code,'log':f'check-{i:02}.log'});print(f'check {i}: {code}',flush=True)
(out/'checks.json').write_text(json.dumps(rows,indent=2)+'\n')
assert all(r['code']==0 for r in rows)
