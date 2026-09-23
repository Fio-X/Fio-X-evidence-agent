#!/usr/bin/env python3
"""Regression tests for causal autonomy, repeated reliability, and split qualification gates."""
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from selftest_evaluator import build_valid  # noqa: E402

def run_evaluator(root: Path):
    return subprocess.run(
        [sys.executable,str(ROOT/'scripts'/'evaluate_agentic_artifact.py'),str(root),'--provider','mock-provider','--model','mock-model','--scenario','fixture-open-goal-v1'],
        capture_output=True,text=True,
    )

def write(path: Path,payload):
    path.write_text(json.dumps(payload,indent=2)+'\n',encoding='utf-8')

def run_trials(paths,out):
    return subprocess.run(
        [sys.executable,str(ROOT/'scripts'/'agentic_trials.py'),'--qualification-files',*[str(p) for p in paths],'--out',str(out)],
        capture_output=True,text=True,
    )

def main():
    with tempfile.TemporaryDirectory(prefix='newsroom-agentic-hardening-') as tmp:
        root=Path(tmp)/'artifact'
        build_valid(root)

        ok=run_evaluator(root)
        if ok.returncode!=0:
            print(ok.stdout); print(ok.stderr,file=sys.stderr)
            raise SystemExit('valid causal-autonomy fixture should pass agentic qualification')
        qualification=json.loads((root/'agentic-qualification.json').read_text())
        if qualification.get('qualification_type')!='agentic' or qualification.get('passed') is not True:
            raise SystemExit('agentic qualification metadata mismatch')
        if not qualification.get('source_commit'):
            raise SystemExit('agentic qualification must bind source_commit')
        if qualification.get('scenario_id')!='fixture-open-goal-v1':
            raise SystemExit('agentic qualification must bind scenario_id')

        story_path=root/'story.json'
        story=json.loads(story_path.read_text())
        story['autonomy']['adaptive_replanning_observed']=False
        write(story_path,story)
        bad=run_evaluator(root)
        if bad.returncode==0:
            raise SystemExit('artifact without adaptive replanning must fail agentic qualification')

        fixture_commit='f'*40
        qdir=Path(tmp)/'qualifications'; qdir.mkdir()
        base={
            'qualification_type':'agentic','status':'PASS','passed':True,
            'provider':'provider-a','model':'model-a','source_commit':fixture_commit,
            'scenario_id':'renewable-energy-open-goal-v1',
            'unsupported_verified_claims':0,'verified_source_and_computation_claims':1,
            'agent_wall_ms_total':1000,
            'usage_metrics':{'input_tokens':100,'output_tokens':50,'total_tokens':150,'cost':0.1},
            'checks':{
                'causal_autonomous_execution':True,'adaptive_replanning':True,
                'hidden_tool_failure_recovery':True,'same_session_follow_up':True,
                'contextual_follow_up_replanning':True,'unsupported_verified_claims_zero':True,
                'verified_source_and_computation_claim':True,
            },
        }
        qfiles=[]
        for i in range(3):
            p=qdir/f'q{i+1}.json'; write(p,dict(base)); qfiles.append(p)

        if run_trials(qfiles[:1],Path(tmp)/'one').returncode==0:
            raise SystemExit('one qualification file must not satisfy repeated reliability')
        three=run_trials(qfiles,Path(tmp)/'three')
        if three.returncode!=0:
            raise SystemExit(three.stderr or three.stdout)
        summary=json.loads((Path(tmp)/'three'/'summary.json').read_text())
        if summary.get('qualification_type')!='agentic_reliability' or summary.get('status')!='PASS':
            raise SystemExit('three consistent trials should produce PASS reliability evidence')
        representative=Path(tmp)/'three'/'agentic-qualification.json'
        if not representative.is_file() or json.loads(representative.read_text()).get('source_commit')!=fixture_commit:
            raise SystemExit('successful repeated trials must publish stable representative agentic evidence')

        mixed=dict(base); mixed['model']='model-b'; write(qfiles[-1],mixed)
        mixed_run=run_trials(qfiles,Path(tmp)/'mixed')
        if mixed_run.returncode==0:
            raise SystemExit('mixed provider/model/source config must fail reliability')
        mixed_summary=json.loads((Path(tmp)/'mixed'/'summary.json').read_text())
        if mixed_summary.get('configuration_consistent') is not False:
            raise SystemExit('mixed reliability config was not detected')

        write(qfiles[-1],dict(base))
        scenario_mixed=dict(base); scenario_mixed['scenario_id']='different-open-goal-v1'; write(qfiles[-1],scenario_mixed)
        scenario_run=run_trials(qfiles,Path(tmp)/'scenario-mixed')
        if scenario_run.returncode==0:
            raise SystemExit('mixed scenario_id must fail repeated reliability')
        scenario_summary=json.loads((Path(tmp)/'scenario-mixed'/'summary.json').read_text())
        if scenario_summary.get('configuration_consistent') is not False:
            raise SystemExit('mixed reliability scenario was not detected')
        write(qfiles[-1],dict(base))

        evidence=Path(tmp)/'evidence'; evidence.mkdir()
        preflight=evidence/'preflight.json'; rc=evidence/'rc.json'; cold=evidence/'cold.json'
        agentic=evidence/'agentic.json'; reliability=evidence/'reliability.json'
        integration=evidence/'integration.json'; human=evidence/'human.json'; manifest=evidence/'manifest.json'
        write(preflight,{'status':'PASS'}); write(rc,{'status':'PASS'}); write(cold,{'status':'PASS'})
        write(agentic,{
            'qualification_type':'agentic','passed':True,'source_commit':fixture_commit,
            'scenario_id':'renewable-energy-open-goal-v1','unsupported_verified_claims':0,
            'checks':{
                'causal_autonomous_execution':True,'adaptive_replanning':True,
                'hidden_tool_failure_recovery':True,'same_session_follow_up':True,
                'contextual_follow_up_replanning':True,'unsupported_verified_claims_zero':True,
            },
        })
        write(reliability,{
            'qualification_type':'agentic_reliability','status':'PASS','trials':3,
            'minimum_trials_satisfied':True,'configuration_consistent':True,'all_pass':True,
            'provider':'provider-a','model':'model-a','source_commit':fixture_commit,
            'scenario_id':'renewable-energy-open-goal-v1',
            'rows':[
                {'passed':True,'provider':'provider-a','model':'model-a','source_commit':fixture_commit,'scenario_id':'renewable-energy-open-goal-v1'},
                {'passed':True,'provider':'provider-a','model':'model-a','source_commit':fixture_commit,'scenario_id':'renewable-energy-open-goal-v1'},
                {'passed':True,'provider':'provider-a','model':'model-a','source_commit':fixture_commit,'scenario_id':'renewable-energy-open-goal-v1'},
            ],
            'consistency':{
                'claim_correctness_rate':1.0,'provenance_integrity_rate':1.0,
                'recovery_success_rate':1.0,'autonomous_execution_rate':1.0,
                'adaptive_replanning_rate':1.0,
            },
        })
        write(integration,{
            'qualification_type':'integration','passed':True,'source_commit':fixture_commit,
            'checks':{'browser_publication_passed':True},
        })
        write(human,{'passed':True,'reviewer_qualification':'fixture','artifact_sha256':'a'*64})
        write(manifest,{'source_commit':fixture_commit,'dependency_locks':{},'manifest_sha256':'0'*64})

        output=evidence/'final.json'
        common=[
            sys.executable,str(ROOT/'scripts'/'final_qualification.py'),
            '--preflight',str(preflight),'--rc-report',str(rc),'--cold-report',str(cold),
            '--agentic-qualification',str(agentic),'--integration-qualification',str(integration),
            '--human-attestation',str(human),'--release-manifest',str(manifest),
        ]
        subprocess.run(common+['--agentic-reliability',str(reliability),'--output',str(output)],capture_output=True,text=True)
        dossier=json.loads(output.read_text())
        if dossier['checks'].get('agentic_provider_qualification') is not True:
            raise SystemExit('final dossier rejected valid T15 evidence')
        if dossier['checks'].get('agentic_reliability') is not True:
            raise SystemExit('final dossier rejected valid T16 evidence')
        if dossier['checks'].get('integration_provider_qualification') is not True:
            raise SystemExit('final dossier rejected valid T17 evidence')

        output2=evidence/'final-without-reliability.json'
        subprocess.run(common+['--output',str(output2)],capture_output=True,text=True)
        dossier2=json.loads(output2.read_text())
        if dossier2['checks'].get('agentic_reliability') is not False:
            raise SystemExit('T15/T17 evidence must not substitute for T16 reliability')

        manifest_without_commit=evidence/'manifest-without-commit.json'
        write(manifest_without_commit,{'dependency_locks':{},'manifest_sha256':'0'*64})
        output3=evidence/'final-without-candidate.json'
        subprocess.run([
            *common[:-2],'--release-manifest',str(manifest_without_commit),
            '--agentic-reliability',str(reliability),'--output',str(output3)
        ],capture_output=True,text=True)
        dossier3=json.loads(output3.read_text())
        for key in ['agentic_provider_qualification','agentic_reliability','integration_provider_qualification','business_value_benchmark','release_manifest']:
            if dossier3['checks'].get(key) is not False:
                raise SystemExit('missing manifest source_commit must fail closed for '+key)

    print('agentic hardening contract: PASS')
    return 0

if __name__=='__main__': raise SystemExit(main())
