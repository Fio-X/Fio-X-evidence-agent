#!/usr/bin/env python3
"""Sequential bounded real cases; load secrets in memory from the external env only."""
import datetime, json, os, selectors, signal, subprocess, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'perf-results/live';OUT.mkdir(parents=True,exist_ok=True)
env=dict(os.environ)
for line in Path('/Users/fio/code/PJ004/.env').read_text().splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.removeprefix('export ').split('=',1);env[k.strip()]=v.strip().strip('\"\'')
# DragonCode is exposed through the project's existing OpenAI-compatible env
# name. Keep the alias in memory only; never write the key to logs/artifacts.
if not env.get('DRAGONCODE_API_KEY') and env.get('OPENAI_API_KEY'):
 env['DRAGONCODE_API_KEY']=env['OPENAI_API_KEY']
assert env.get('DRAGONCODE_API_KEY'),'key not configured'
secrets=[v for k,v in env.items() if len(v)>=8 and any(w in k.upper() for w in ['API_KEY','TOKEN','SECRET','PASSWORD'])]
def safe(data):
 for secret in secrets:data=data.replace(secret,'[REDACTED]')
 return data
provider=['--provider','dragoncode','--model','claude-sonnet-4-6','--thinking','off','--tool-profile','investigate','--pi-bin','/Users/fio/.nvm/versions/node/v22.19.0/bin/pi']
env.update(NEWSROOM_RPC_STARTUP_MS='60000',NEWSROOM_RPC_IDLE_MS='120000',NEWSROOM_RPC_FINISH_MS='30000',NEWSROOM_RPC_TOTAL_MS='240000',NEWSROOM_RPC_HEARTBEAT_MS='5000',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0',NODE_OPTIONS='--import='+str(ROOT/'scripts/perf_fetch_observer.mjs'))
csv=OUT/'fixed.csv';csv.write_text('region,value\nA,10\nB,20\nA,30\n')
tasks={
 'qa':'What is 17 + 25? Reply with only the number.',
 'csv':'Analyze only the supplied fixed.csv. Report row count, sum of value, and sum by region. Correct expected results are 3 rows, total 60, A=40 and B=20. Use tools to verify rather than trusting these expectations, persist computed evidence and a concise answer. Do not create visualizations or use network. Finish the evidence trail.',
 'web':'Investigate how Singapore population changed from 2020 to 2023, using only World Bank indicator SP.POP.TOTL and source scope https://api.worldbank.org/v2/country/SG/indicator/SP.POP.TOTL?date=2020:2023&format=json . Fetch the fixed period, preserve source time and evidence, compute absolute and percentage change, and write a concise data news summary. No visualization required. Do not search outside this source scope.'}
label=sys.argv[1];binary=str(Path(sys.argv[2]).resolve());selected=sys.argv[3:] or list(tasks)
for case in selected:
 for i in range(3):
  name=f'{label}-{case}-{i+1}';dest=OUT/name;dest.mkdir(exist_ok=True)
  env['PERF_NETWORK_LOG']=str(dest/'network.jsonl')
  cmd=[binary,'ask' if case=='qa' else 'investigate',*provider]
  if case!='qa':cmd+=['--out',str(dest/'artifacts')]
  if case=='csv':cmd+=['--data',str(csv)]
  cmd+=[tasks[case]]
  started=time.perf_counter();p=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
  selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ,'stdout');selector.register(p.stderr,selectors.EVENT_READ,'stderr')
  buffers={'stdout':bytearray(),'stderr':bytearray()};first={'stdout':None,'stderr':None};watchdog=False
  while selector.get_map():
   elapsed=time.perf_counter()-started
   if elapsed>245 and p.poll() is None:
    watchdog=True;p.send_signal(signal.SIGINT)
    try:p.wait(timeout=3)
    except subprocess.TimeoutExpired:
     os.killpg(p.pid,signal.SIGKILL)
   for key,_ in selector.select(.2):
    data=os.read(key.fileobj.fileno(),65536)
    if not data:selector.unregister(key.fileobj);continue
    stream=key.data
    if first[stream] is None:first[stream]=(time.perf_counter()-started)*1000
    if len(buffers[stream])+len(data)<2_000_000:buffers[stream]+=data
   if elapsed>250:break
  p.wait(timeout=3);selector.close()
  text={k:safe(v.decode(errors='replace')) for k,v in buffers.items()}
  for k,v in text.items():(dest/f'{k}.log').write_text(v)
  result={'label':label,'case':case,'iteration':i+1,'kind':'real_model_attempt','utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'wall_ms':(time.perf_counter()-started)*1000,'first_visible_progress_ms':first['stderr'],'first_model_text_ms':first['stdout'] if text['stdout'].strip() else None,'returncode':p.returncode,'watchdog':watchdog,'provider':'dragoncode','model':'claude-sonnet-4-6','thinking':'off','tool_profile':'investigate','cost':'unavailable','qa_correct':text['stdout'].strip()=='42' if case=='qa' else None}
  (dest/'result.json').write_text(json.dumps(result,indent=2)+'\n')
  print(json.dumps({k:result[k] for k in ['label','case','iteration','wall_ms','returncode','qa_correct']}),flush=True)
