#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def write(path,payload):
 path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(payload))

def run(tmp: Path, agentic=True, gpu='PASS', source='PASS'):
 for name,status in [('source',source),('cargo','PASS'),('local','PASS'),('scheduler','PASS'),('pre','PASS'),('rc','PASS'),('cold','PASS')]:
  write(tmp/f'{name}.json',{'status':status})
 write(tmp/'visual.json',{'status':'PASS' if gpu=='PASS' else 'BLOCKED','cpu_browser_status':'PASS','gpu_webgl_status':gpu})
 write(tmp/'business.json',{'status':'MEASURED','agent_runs':3,'baseline_runs':3})
 write(tmp/'integration.json',{'qualification_type':'integration','passed':True,'checks':{'browser_publication_passed':True}})
 write(tmp/'human.json',{'passed':True,'reviewer_qualification':'fixture','artifact_sha256':'a'*64})
 write(tmp/'manifest.json',{'manifest_sha256':'b'*64,'dependency_locks':{'cargo':{'present':True},'web':{'present':True}}})
 if agentic:
  write(tmp/'agentic.json',{'qualification_type':'agentic','passed':True,'unsupported_verified_claims':0,'checks':{
   'causal_autonomous_execution':True,'adaptive_replanning':True,'hidden_tool_failure_recovery':True,
   'same_session_follow_up':True,'contextual_follow_up_replanning':True,'unsupported_verified_claims_zero':True}})
 out=tmp/'final.json'
 cmd=[sys.executable,str(ROOT/'scripts/final_qualification.py'),
  '--source-integrity',str(tmp/'source.json'),'--macos-cargo',str(tmp/'cargo.json'),'--local-backend',str(tmp/'local.json'),
  '--scheduler',str(tmp/'scheduler.json'),'--preflight',str(tmp/'pre.json'),'--rc-report',str(tmp/'rc.json'),'--cold-report',str(tmp/'cold.json'),
  '--integration-qualification',str(tmp/'integration.json'),'--visual-qualification',str(tmp/'visual.json'),'--business-benchmark',str(tmp/'business.json'),
  '--human-attestation',str(tmp/'human.json'),'--release-manifest',str(tmp/'manifest.json'),'--output',str(out)]
 if agentic: cmd += ['--agentic-qualification',str(tmp/'agentic.json')]
 proc=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True)
 return proc,json.loads(out.read_text())

with tempfile.TemporaryDirectory() as td:
 tmp=Path(td)/'pass'; tmp.mkdir(); proc,dossier=run(tmp)
 assert proc.returncode==0 and dossier['status']=='PASS',proc.stdout+proc.stderr
 tmp=Path(td)/'no-agentic'; tmp.mkdir(); proc,dossier=run(tmp,agentic=False)
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['integration_provider_qualification'] is True
 assert dossier['checks']['agentic_provider_qualification'] is False
 tmp=Path(td)/'no-gpu'; tmp.mkdir(); proc,dossier=run(tmp,gpu='UNAVAILABLE')
 assert proc.returncode==2 and 'visual_browser_gpu_qualification' in dossier['blockers']
 tmp=Path(td)/'bad-source'; tmp.mkdir(); proc,dossier=run(tmp,source='BLOCKED')
 assert proc.returncode==2 and 'source_integrity' in dossier['blockers']
print('final qualification conjunction contract: PASS')
