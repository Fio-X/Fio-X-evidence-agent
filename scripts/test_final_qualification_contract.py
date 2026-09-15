#!/usr/bin/env python3
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def write(path,payload):
 path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(payload,sort_keys=True))

def run(tmp: Path, agentic=True, gpu='PASS', source='PASS', source_extra=None):
 for name,status in [('source',source),('cargo','PASS'),('local','PASS'),('scheduler','PASS'),('pre','PASS'),('rc','PASS'),('cold','PASS')]:
  payload={'status':status}
  if name=='source' and source_extra is not None: payload['marker']=source_extra
  write(tmp/f'{name}.json',payload)
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

def assert_indexed(dossier, key, present=True):
 row=dossier['evidence_index'][key]
 assert row['present'] is present
 if present:
  assert isinstance(row['size_bytes'],int) and row['size_bytes']>0
  assert isinstance(row['sha256'],str) and len(row['sha256'])==64

with tempfile.TemporaryDirectory() as td:
 base=Path(td)
 tmp=base/'pass'; tmp.mkdir(); proc,dossier=run(tmp)
 assert proc.returncode==0 and dossier['status']=='PASS',proc.stdout+proc.stderr
 assert dossier['schema_version']=='0.4.0'
 assert isinstance(dossier['evidence_set_sha256'],str) and len(dossier['evidence_set_sha256'])==64
 for key in ['source_integrity','macos_cargo','local_backend','scheduler','preflight','rc_report','cold_report','agentic_qualification','integration_qualification','visual_qualification','business_benchmark','human_attestation','release_manifest']:
  assert_indexed(dossier,key)
 first_hash=dossier['evidence_set_sha256']
 first_source_hash=dossier['evidence_index']['source_integrity']['sha256']

 # Re-running over byte-identical evidence must produce the same evidence-set digest.
 proc2,dossier2=run(tmp)
 assert proc2.returncode==0
 assert dossier2['evidence_set_sha256']==first_hash
 assert dossier2['evidence_index']['source_integrity']['sha256']==first_source_hash

 # A content-only evidence change keeps the synthetic PASS semantics but must change the cryptographic dossier identity.
 changed=base/'changed'; changed.mkdir(); proc3,dossier3=run(changed,source_extra='different-bytes')
 assert proc3.returncode==0 and dossier3['status']=='PASS'
 assert dossier3['evidence_set_sha256']!=first_hash
 assert dossier3['evidence_index']['source_integrity']['sha256']!=first_source_hash

 tmp=base/'no-agentic'; tmp.mkdir(); proc,dossier=run(tmp,agentic=False)
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['integration_provider_qualification'] is True
 assert dossier['checks']['agentic_provider_qualification'] is False
 assert_indexed(dossier,'agentic_qualification',present=False)

 tmp=base/'no-gpu'; tmp.mkdir(); proc,dossier=run(tmp,gpu='UNAVAILABLE')
 assert proc.returncode==2 and 'visual_browser_gpu_qualification' in dossier['blockers']

 tmp=base/'bad-source'; tmp.mkdir(); proc,dossier=run(tmp,source='BLOCKED')
 assert proc.returncode==2 and 'source_integrity' in dossier['blockers']

print('final qualification conjunction + hashed evidence dossier contract: PASS')
