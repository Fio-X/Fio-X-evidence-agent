#!/usr/bin/env python3
"""Sequential samples, including first invocation; no best-of reruns."""
import json, os, statistics, subprocess, sys, tempfile, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import benchmark_verify as bv
import benchmark_verify_scale as bs
binary=str(Path(sys.argv[1]).resolve()); output=Path(sys.argv[2]); samples={}
def runs(name,cmd,n=30):
    vals=[]
    for i in range(n):
        t=time.perf_counter_ns(); p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        assert p.returncode==0,(name,p.returncode)
        vals.append((time.perf_counter_ns()-t)/1e6)
    samples[name]=vals
runs('help_ms',[binary,'--help']); runs('dry_run_ms',[binary,'investigate','--dry-run','fixed question'])
runs('mock_ask_ms',[binary,'ask','--pi-bin',str(ROOT/'scripts/perf_mock_pi.py'),'fixed question'])
with tempfile.TemporaryDirectory() as tmp:
    runs('mock_investigate_ms',[binary,'investigate','--out',tmp,'--pi-bin',str(ROOT/'scripts/perf_mock_pi.py'),'fixed question'])
    artifact=next(Path(tmp).iterdir())
    runs('mock_continue_ms',[binary,'continue','--pi-bin',str(ROOT/'scripts/perf_mock_pi.py'),str(artifact),'fixed follow up'])
# Hook existing fixture builders and benchmark loops, retaining every invocation.
for name,module in [('verify_ms',bv),('verify_scale_ms',bs)]:
    vals=[]; original=module.verify
    def timed(root):
        t=time.perf_counter_ns(); r=original(root); vals.append((time.perf_counter_ns()-t)/1e6); return r
    module.verify=timed
    module.main(); samples[name]=vals
summary={k:{'n':len(v),'first':v[0],'median':statistics.median(v),'min':min(v),'max':max(v),'p95':sorted(v)[round((len(v)-1)*.95)]} for k,v in samples.items()}
output.write_text(json.dumps({'kind':'offline_mock_and_local','cold_definition':'first process invocation; OS cache not purged','samples':samples,'summary':summary},indent=2)+'\n')
print(json.dumps(summary,indent=2))
