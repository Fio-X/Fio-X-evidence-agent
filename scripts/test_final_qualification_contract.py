#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FIXTURE_COMMIT='f'*40
OTHER_COMMIT='e'*40
BUSINESS_METRICS=[
 'time_to_first_defensible_claim_ms',
 'time_to_final_deliverable_ms',
 'source_count',
 'verified_claim_rate',
 'human_interventions',
 'editorial_corrections',
 'model_cost',
]

def write(path,payload):
 path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(payload,sort_keys=True))

def signed_manifest(*, source_commit=FIXTURE_COMMIT, tamper=False):
 payload={'schema_version':'0.2.0','release':'1.13.0-rc1','created_at_epoch':1234567890,'source_commit':source_commit,'dependency_locks':{'cargo':{'present':True},'web':{'present':True}},'source_tree':{'file_count':1,'bytes':5,'sha256':'c'*64,'files':[{'path':'fixture','sha256':'d'*64,'bytes':5}]},'runtime_manifests':[],'qualification':{}}
 stable=dict(payload); stable.pop('created_at_epoch',None)
 payload['manifest_sha256']=hashlib.sha256(json.dumps(stable,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 if tamper: payload['release']='1.13.0-rc1-tampered'
 return payload

def agentic_payload(source_commit):
 return {'qualification_type':'agentic','status':'PASS','passed':True,'provider':'fixture-provider','model':'fixture-model','source_commit':source_commit,'scenario_id':'fixture-scenario','unsupported_verified_claims':0,'checks':{
  'causal_autonomous_execution':True,'adaptive_replanning':True,'hidden_tool_failure_recovery':True,
  'same_session_follow_up':True,'contextual_follow_up_replanning':True,'unsupported_verified_claims_zero':True}}

def reliability_payload(source_commit):
 rows=[{'trial':i,'passed':True,'provider':'fixture-provider','model':'fixture-model','source_commit':source_commit,'scenario_id':'fixture-scenario'} for i in range(1,4)]
 return {'schema_version':'1.3.0','qualification_type':'agentic_reliability','batch_id':'fixture-batch','status':'PASS','provider':'fixture-provider','model':'fixture-model','source_commit':source_commit,'scenario_id':'fixture-scenario','planned_trials':3,'attempted_trials':3,'stopped_early':False,'trials':3,'minimum_trials_satisfied':True,'configuration_consistent':True,'all_pass':True,'rows':rows,'consistency':{
  'claim_correctness_rate':1.0,'provenance_integrity_rate':1.0,'recovery_success_rate':1.0,'autonomous_execution_rate':1.0,'adaptive_replanning_rate':1.0}}

def business_payload(source_commit):
 return {'status':'MEASURED','agent_runs':3,'baseline_runs':3,'matched_scenarios':True,'matched_scenario_ids':['s1'],'required_metrics':BUSINESS_METRICS,
  'agent':{},'baseline':{},'delta':{},'scenarios':{'s1':{'agent_runs':3,'baseline_runs':3}},'scenario_run_counts':{'s1':3},
  'raw_inputs':{'agent':{'sha256':'a'*64},'baseline':{'sha256':'b'*64}},'candidate_source_commit':source_commit}

def run(tmp: Path, agentic=True, reliability=True, gpu='PASS', source='PASS', source_extra=None, tamper_manifest=False, manifest_commit=FIXTURE_COMMIT, evidence_commit=FIXTURE_COMMIT, reliability_updates=None):
 for name,status in [('source',source),('cargo','PASS'),('local','PASS'),('scheduler','PASS'),('pre','PASS'),('rc','PASS'),('cold','PASS')]:
  payload={'status':status}
  if name=='source' and source_extra is not None: payload['marker']=source_extra
  write(tmp/f'{name}.json',payload)
 write(tmp/'visual.json',{'status':'PASS' if gpu=='PASS' else 'BLOCKED','cpu_browser_status':'PASS','gpu_webgl_status':gpu})
 write(tmp/'business.json',business_payload(evidence_commit))
 write(tmp/'integration.json',{'qualification_type':'integration','status':'PASS','passed':True,'source_commit':evidence_commit,'checks':{'browser_publication_passed':True}})
 write(tmp/'human.json',{'passed':True,'reviewer_qualification':'fixture','artifact_sha256':'a'*64})
 write(tmp/'manifest.json',signed_manifest(source_commit=manifest_commit,tamper=tamper_manifest))
 if agentic: write(tmp/'agentic.json',agentic_payload(evidence_commit))
 if reliability:
  rel=reliability_payload(evidence_commit)
  rel.update(reliability_updates or {})
  write(tmp/'reliability.json',rel)
 out=tmp/'final.json'
 cmd=[sys.executable,str(ROOT/'scripts/final_qualification.py'),
  '--source-integrity',str(tmp/'source.json'),'--macos-cargo',str(tmp/'cargo.json'),'--local-backend',str(tmp/'local.json'),
  '--scheduler',str(tmp/'scheduler.json'),'--preflight',str(tmp/'pre.json'),'--rc-report',str(tmp/'rc.json'),'--cold-report',str(tmp/'cold.json'),
  '--integration-qualification',str(tmp/'integration.json'),'--visual-qualification',str(tmp/'visual.json'),'--business-benchmark',str(tmp/'business.json'),
  '--human-attestation',str(tmp/'human.json'),'--release-manifest',str(tmp/'manifest.json'),'--output',str(out)]
 if agentic: cmd += ['--agentic-qualification',str(tmp/'agentic.json')]
 if reliability: cmd += ['--agentic-reliability',str(tmp/'reliability.json')]
 proc=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True)
 return proc,json.loads(out.read_text())

def assert_indexed(dossier,key,present=True):
 row=dossier['evidence_index'][key]; assert row['present'] is present
 if present:
  assert isinstance(row['size_bytes'],int) and row['size_bytes']>0
  assert isinstance(row['sha256'],str) and len(row['sha256'])==64

with tempfile.TemporaryDirectory() as td:
 base=Path(td)
 tmp=base/'pass'; tmp.mkdir(); proc,dossier=run(tmp)
 assert proc.returncode==0 and dossier['status']=='PASS',proc.stdout+proc.stderr
 assert dossier['schema_version']=='0.6.0'
 assert dossier['candidate_source_commit']==FIXTURE_COMMIT
 assert dossier['release_manifest_integrity']['valid'] is True
 assert dossier['release_manifest_integrity']['declared_sha256']==dossier['release_manifest_integrity']['computed_sha256']
 assert dossier['checks']['agentic_reliability'] is True
 assert isinstance(dossier['evidence_set_sha256'],str) and len(dossier['evidence_set_sha256'])==64
 for key in ['source_integrity','macos_cargo','local_backend','scheduler','preflight','rc_report','cold_report','agentic_qualification','agentic_reliability','integration_qualification','visual_qualification','business_benchmark','human_attestation','release_manifest']:
  assert_indexed(dossier,key)
 first_hash=dossier['evidence_set_sha256']; first_source_hash=dossier['evidence_index']['source_integrity']['sha256']

 proc2,dossier2=run(tmp); assert proc2.returncode==0
 assert dossier2['evidence_set_sha256']==first_hash
 assert dossier2['evidence_index']['source_integrity']['sha256']==first_source_hash

 changed=base/'changed'; changed.mkdir(); proc3,dossier3=run(changed,source_extra='different-bytes')
 assert proc3.returncode==0 and dossier3['status']=='PASS'
 assert dossier3['evidence_set_sha256']!=first_hash
 assert dossier3['evidence_index']['source_integrity']['sha256']!=first_source_hash

 tmp=base/'bad-manifest'; tmp.mkdir(); proc,dossier=run(tmp,tamper_manifest=True)
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['release_manifest'] is False
 assert dossier['release_manifest_integrity']['valid'] is False
 assert dossier['release_manifest_integrity']['declared_sha256']!=dossier['release_manifest_integrity']['computed_sha256']

 tmp=base/'invalid-manifest-commit'; tmp.mkdir(); proc,dossier=run(tmp,manifest_commit='fixture')
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['candidate_source_commit'] is None
 for key in ['release_manifest','agentic_provider_qualification','agentic_reliability','integration_provider_qualification','business_value_benchmark']:
  assert dossier['checks'][key] is False

 tmp=base/'mismatched-evidence'; tmp.mkdir(); proc,dossier=run(tmp,evidence_commit=OTHER_COMMIT)
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['release_manifest'] is True
 for key in ['agentic_provider_qualification','agentic_reliability','integration_provider_qualification','business_value_benchmark']:
  assert dossier['checks'][key] is False

 tmp=base/'no-agentic'; tmp.mkdir(); proc,dossier=run(tmp,agentic=False)
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['integration_provider_qualification'] is True
 assert dossier['checks']['agentic_reliability'] is True
 assert dossier['checks']['agentic_provider_qualification'] is False
 assert_indexed(dossier,'agentic_qualification',present=False)

 tmp=base/'no-reliability'; tmp.mkdir(); proc,dossier=run(tmp,reliability=False)
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['agentic_provider_qualification'] is True
 assert dossier['checks']['integration_provider_qualification'] is True
 assert dossier['checks']['agentic_reliability'] is False
 assert_indexed(dossier,'agentic_reliability',present=False)

 tmp=base/'stopped-batch'; tmp.mkdir(); proc,dossier=run(tmp,reliability_updates={'stopped_early':True})
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['agentic_reliability'] is False

 tmp=base/'partial-batch'; tmp.mkdir(); proc,dossier=run(tmp,reliability_updates={'attempted_trials':2})
 assert proc.returncode==2 and dossier['status']=='BLOCKED'
 assert dossier['checks']['agentic_reliability'] is False

 tmp=base/'no-gpu'; tmp.mkdir(); proc,dossier=run(tmp,gpu='UNAVAILABLE')
 assert proc.returncode==2 and 'visual_browser_gpu_qualification' in dossier['blockers']

 tmp=base/'bad-source'; tmp.mkdir(); proc,dossier=run(tmp,source='BLOCKED')
 assert proc.returncode==2 and 'source_integrity' in dossier['blockers']

print('final qualification conjunction + reliability + candidate binding + hashed evidence contract: PASS')
