#!/usr/bin/env python3
"""External watchdog bounds every regression, including the unfixed baseline."""
import json, os, signal, subprocess, sys, time, tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
binary=str(Path(sys.argv[1] if len(sys.argv)>1 else root/'target/release/news').resolve())
baseline='--baseline' in sys.argv
results=[]
pid_file=Path(tempfile.gettempdir())/f'perf-child-{os.getpid()}.pid'
for mode in ['normal','silent','missing_stats','cancel','tool','thinking','spawn_failure','idle','turn_idle','active_stall','fragment','provider_error','oversize','descendant']:
 env={**os.environ,'PERF_MOCK_MODE':mode,'NEWSROOM_RPC_STARTUP_MS':'600' if mode=='fragment' else '150','NEWSROOM_RPC_IDLE_MS':'150','NEWSROOM_RPC_FINISH_MS':'1200' if mode=='fragment' else '150','NEWSROOM_RPC_HEARTBEAT_MS':'50','NEWSROOM_RPC_TOTAL_MS':'1000' if mode=='active_stall' else '3000','PERF_TEST_SECRET':'test-only-'+str(time.time_ns())}
 env['PERF_CHILD_PID']=str(pid_file)
 mock=str(root/'scripts/perf_mock_pi.py') if mode!='spawn_failure' else '/nonexistent/perf-pi'
 t=time.monotonic();p=subprocess.Popen([binary,'ask','--pi-bin',mock,'fixed input'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 if mode=='cancel': time.sleep(.15);p.send_signal(signal.SIGINT)
 watchdog=False
 try: out,err=p.communicate(timeout=2.5)
 except subprocess.TimeoutExpired:
  watchdog=True;os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate(timeout=2)
 elapsed=time.monotonic()-t
 r={'mode':mode,'wall_ms':elapsed*1000,'watchdog':watchdog,'returncode':p.returncode,'progress_count':err.count(b'phase='),'mock':True}
 results.append(r)
 if not baseline:
  assert not watchdog,r
  assert (p.returncode==0)==(mode in ['normal','tool','thinking','fragment']),r
  if mode in ['silent','missing_stats','cancel','tool','thinking']: assert r['progress_count']>=2,r
  assert b'fixed input' not in err
  assert env['PERF_TEST_SECRET'].encode() not in out+err
  if mode=='descendant':
   pid=int(pid_file.read_text());pid_file.unlink()
   time.sleep(.1)
   try: os.kill(pid,0)
   except ProcessLookupError: pass
   else:
    os.kill(pid,signal.SIGKILL)
    raise AssertionError('RPC descendant survived cleanup')
if not baseline:
 with tempfile.TemporaryDirectory() as tmp:
  import secrets
  canary=secrets.token_urlsafe(32)
  env={**os.environ,'PERF_MOCK_MODE':'provider_error','PERF_TEST_SECRET':canary,'NEWSROOM_RPC_TOTAL_MS':'2000'}
  p=subprocess.run([binary,'investigate','--pi-bin',str(root/'scripts/perf_mock_pi.py'),'--out',tmp,'fixed'],env=env,capture_output=True,timeout=4)
  artifact=next(Path(tmp).iterdir())
  status=json.loads((artifact/'story.json').read_text())['status']
  rpc_events=[json.loads(line) for line in (artifact/'events.jsonl').read_text().splitlines() if json.loads(line).get('type')=='newsroom_rpc_metrics']
  assert len(rpc_events)==1 and rpc_events[0]['outcome']=='failed',rpc_events
  assert rpc_events[0]['failure_class']=='provider_error' and 'failure_phase' in rpc_events[0],rpc_events
  run_metrics=[json.loads(line) for line in (artifact/'run-metrics.jsonl').read_text().splitlines()]
  assert len(run_metrics)==1,run_metrics
  assert run_metrics[0]['pi_rpc']['failed_calls']==1,run_metrics
  assert run_metrics[0]['pi_rpc_operation']['failed_calls']==1,run_metrics
  leaks=sum(canary.encode() in f.read_bytes() for f in artifact.rglob('*') if f.is_file())+int(canary.encode() in p.stdout+p.stderr)
  assert p.returncode!=0 and status=='failed' and leaks==0
  results.append({'mode':'failure_persistence_redaction','returncode':p.returncode,'status':status,'secret_hits':leaks,'mock':True})
with tempfile.TemporaryDirectory() as tmp:
 env={**os.environ,'PERF_MOCK_MODE':'normal','NEWSROOM_RPC_STARTUP_MS':'150','NEWSROOM_RPC_IDLE_MS':'150','NEWSROOM_RPC_FINISH_MS':'150','NEWSROOM_RPC_HEARTBEAT_MS':'50','NEWSROOM_RPC_TOTAL_MS':'3000'}
 subprocess.run([binary,'investigate','--pi-bin',str(root/'scripts/perf_mock_pi.py'),'--out',tmp,'rpc metric fixture'],env=env,capture_output=True,timeout=4,check=True)
 artifact=next(Path(tmp).glob('*/story.json')).parent
 subprocess.run([binary,'continue','--pi-bin',str(root/'scripts/perf_mock_pi.py'),str(artifact),'follow up metric fixture'],env=env,capture_output=True,timeout=4,check=True)
 events=[json.loads(line) for line in (artifact/'events.jsonl').read_text().splitlines() if line.strip()]
 metrics=[json.loads(line) for line in (artifact/'run-metrics.jsonl').read_text().splitlines()]
 rpc=[event for event in events if event.get('type')=='newsroom_rpc_metrics']
 assert len(rpc)==2 and [event['continue_session'] for event in rpc]==[False,True],rpc
 assert [metric['pi_rpc_operation']['calls'] for metric in metrics]==[1,1],metrics
 assert [metric['pi_rpc']['calls'] for metric in metrics]==[1,2],metrics
 results.append({'mode':'initial_plus_continuation_metrics','rpc_calls':[metric['pi_rpc_operation']['calls'] for metric in metrics],'cumulative_calls':[metric['pi_rpc']['calls'] for metric in metrics],'mock':True})
print(json.dumps(results,indent=2))
