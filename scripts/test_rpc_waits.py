#!/usr/bin/env python3
"""External watchdog bounds every regression, including the unfixed baseline."""
import json, os, re, signal, subprocess, sys, threading, time, tempfile
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
  leaks=sum(canary.encode() in f.read_bytes() for f in artifact.rglob('*') if f.is_file())+int(canary.encode() in p.stdout+p.stderr)
  assert p.returncode!=0 and status=='failed' and leaks==0
  results.append({'mode':'failure_persistence_redaction','returncode':p.returncode,'status':status,'secret_hits':leaks,'mock':True})
if not baseline:
 # The first chart is named as soon as a chain's critic passes, while the run goes on. Only the
 # inline-claim switch (which needs the chart chain and atomic writes) turns the notice on, and
 # the notice is progress only: exit status, story status, answer and recorded events stay equal.
 chain_on={'NEWSROOM_SPEED_CHAIN_VIZ':'1','NEWSROOM_SPEED_ATOMIC_ARTIFACT':'1','NEWSROOM_SPEED_INLINE_CLAIM':'1'}
 def chain_run(extra,case='ok',after=0.0,topic='fixed chart'):
  with tempfile.TemporaryDirectory() as tmp:
   env={**{k:v for k,v in os.environ.items() if not k.startswith('NEWSROOM_SPEED_')},'PERF_MOCK_MODE':'chain_chart','PERF_MOCK_CHAIN_CASE':case,'PERF_MOCK_AFTER_CHART':str(after),'NEWSROOM_RPC_TOTAL_MS':'8000','NEWSROOM_RPC_IDLE_MS':'5000','NEWSROOM_RPC_FINISH_MS':'3000',**extra}
   p=subprocess.Popen([binary,'investigate','--pi-bin',str(root/'scripts/perf_mock_pi.py'),'--out',tmp,topic],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
   dog=threading.Timer(20,lambda: os.killpg(p.pid,signal.SIGKILL));dog.start()
   notices=[];err=[]
   try:
    for raw in iter(p.stderr.readline,b''):
     err.append(raw)
     if b'[agent] chart_ready ' in raw:
      path=re.search(rb'desktop=(\S+)',raw).group(1).decode()
      notices.append({'line':raw.decode(),'path':path,'exists':Path(path).is_file(),'at':time.monotonic()})
    out=p.stdout.read();p.wait();ended=time.monotonic()
   finally: dog.cancel()
   for note in notices: note['lead_s']=ended-note.pop('at')
   artifact=next(Path(tmp).iterdir())
   events=[(e.get('type'),e.get('toolName')) for e in map(json.loads,filter(None,(artifact/'events.jsonl').read_text(encoding='utf-8').splitlines()))]
   return {'returncode':p.returncode,'notices':notices,'runs':b''.join(err).count(b'[agent] startup_ms='),'status':json.loads((artifact/'story.json').read_text())['status'],'answer':(artifact/'answer.md').read_text(encoding='utf-8'),'events':events}
 no_notice={k:v for k,v in chain_on.items() if k!='NEWSROOM_SPEED_INLINE_CLAIM'}
 off=chain_run(no_notice,after=2.0);on=chain_run(chain_on,after=2.0)
 assert off['returncode']!=-9 and off['notices']==[] and len(on['notices'])==1,(off,on)
 note=on['notices'][0]
 # The model works for 2 s after the chart; the notice must have come well before that ended.
 assert note['lead_s']>1.5 and note['exists'] and note['path'].endswith('/visualizations/b.svg') and ' compact=' in note['line'] and note['line'].rstrip().endswith('(critic passed; progress only, the run continues)'),note
 for key in ('returncode','status','answer','events'): assert on[key]==off[key],(key,on[key],off[key])
 results.append({'mode':'chart_notice_on_vs_off','notices':[len(off['notices']),len(on['notices'])],'returncode':on['returncode'],'status':on['status'],'mock':True})
 for name,extra,case,topic,count,tail in [
  ('without_chain',{'NEWSROOM_SPEED_ATOMIC_ARTIFACT':'1','NEWSROOM_SPEED_INLINE_CLAIM':'1'},'ok','fixed chart',0,None),
  ('without_atomic_writes',{'NEWSROOM_SPEED_CHAIN_VIZ':'1','NEWSROOM_SPEED_INLINE_CLAIM':'1'},'ok','fixed chart',0,None),
  ('switch_not_exactly_one',{**chain_on,'NEWSROOM_SPEED_INLINE_CLAIM':'true'},'ok','fixed chart',0,None),
  ('two_charts',chain_on,'two','fixed chart',1,'/b.svg'),
  ('revision_then_retry',chain_on,'revise','fixed chart',1,'/b.svg'),
  ('revision_only',chain_on,'revise_only','fixed chart',0,None),
  ('desktop_ref_outside_visualizations',chain_on,'unsafe_ref','fixed chart',0,None),
  ('separate_render_and_critic',chain_on,'separate','fixed chart',1,'/e.svg'),
  ('repair_prompts_name_it_once',chain_on,'ok','complex visual essay chart',1,'/b.svg')]:
  r=chain_run(extra,case,topic=topic)
  results.append({'mode':'chart_notice_'+name,'notices':len(r['notices']),'runs':r['runs'],'returncode':r['returncode'],'mock':True})
  assert r['returncode']!=-9 and len(r['notices'])==count,(name,r)
  if tail: assert r['notices'][0]['path'].endswith(tail) and r['notices'][0]['exists'],(name,r)
  if name.startswith('repair'): assert r['runs']>=2,('the repair prompts did not run, so this proves nothing',r)
print(json.dumps(results,indent=2))
