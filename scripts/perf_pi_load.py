#!/usr/bin/env python3
"""Measure real Pi startup/extension loading without a prompt or API request."""
import json, os, selectors, signal, subprocess, sys, tempfile, time
from pathlib import Path
root=Path(__file__).resolve().parents[1];binary=str(Path(sys.argv[1]).resolve());out=Path(sys.argv[2]);rows=[]
pi='/Users/fio/.nvm/versions/node/v22.19.0/bin/pi'
with tempfile.TemporaryDirectory() as tmp:
 subprocess.run([binary,'investigate','--out',tmp,'--pi-bin',str(root/'scripts/perf_mock_pi.py'),'fixed'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
 artifact=next(Path(tmp).iterdir())
 for extension in [False, True]:
  for i in range(10):
   args=[pi,'--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--provider','dragoncode','--model','claude-sonnet-4-6']
   if extension:args+=['-e',str(artifact/'runtime/newsroom.ts')]
   env={**os.environ,'NEWSROOM_ARTIFACT_DIR':str(artifact),'PI_SKIP_VERSION_CHECK':'1','PI_TELEMETRY':'0'}
   t=time.perf_counter();p=subprocess.Popen(args,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
   p.stdin.write(b'{"id":"load","type":"get_state"}\n');p.stdin.flush();sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ)
   buf=b'';ok=False;errors=0
   while time.perf_counter()-t<8:
    if not sel.select(.1):continue
    chunk=os.read(p.stdout.fileno(),65536)
    if not chunk:break
    buf+=chunk
    while b'\n' in buf:
     line,buf=buf.split(b'\n',1)
     try:v=json.loads(line)
     except ValueError:continue
     if v.get('type')=='extension_error':errors+=1
     if v.get('id')=='load':ok=v.get('success') is True
    if ok:break
   rows.append({'extension':extension,'iteration':i,'wall_ms':(time.perf_counter()-t)*1000,'state_response':ok,'extension_errors':errors})
   try: remaining,diagnostic=p.communicate(timeout=2)
   except subprocess.TimeoutExpired:
    p.kill();remaining,diagnostic=p.communicate(timeout=2)
   rows[-1]['exit_code']=p.returncode
   rows[-1]['diagnostic_categories']=[k for k in ['Cannot find module','Cannot find package','SyntaxError','apiKey','API key','ENOENT','EACCES','EPERM','not permitted','--approve','--no-approve','trust'] if k.encode() in diagnostic]
   sel.close()
out.write_text(json.dumps({'kind':'real_pi_no_model_no_api','samples':rows},indent=2)+'\n')
print(json.dumps({'runs':len(rows),'state_successes':sum(r['state_response'] for r in rows),'extension_errors':sum(r['extension_errors'] for r in rows)}))
