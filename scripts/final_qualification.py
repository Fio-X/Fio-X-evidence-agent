#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def load(path: Path|None):
    if not path: return None
    try: return json.loads(path.read_text(encoding='utf-8'))
    except Exception: return None

def passed_report(value): return bool(value and value.get('status') == 'PASS')

def resolve_path(value: str|None) -> Path|None:
    if not value: return None
    p=Path(value)
    return p if p.is_absolute() else ROOT/p

def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def evidence_entry(value: str|None):
    p=resolve_path(value)
    if p is None: return {'path':None,'present':False,'size_bytes':None,'sha256':None}
    present=p.is_file()
    return {'path':value,'present':present,'size_bytes':p.stat().st_size if present else None,'sha256':sha256_file(p) if present else None}

def evidence_set_hash(entries: dict) -> str:
    h=hashlib.sha256()
    for key in sorted(entries):
        row=entries[key]
        h.update(key.encode()); h.update(b'\0')
        h.update(str(row.get('path')).encode()); h.update(b'\0')
        h.update(str(row.get('sha256')).encode()); h.update(b'\n')
    return h.hexdigest()

def release_manifest_hash(manifest: dict) -> str|None:
    expected=manifest.get('manifest_sha256')
    if not isinstance(expected,str) or len(expected)!=64: return None
    stable=dict(manifest)
    stable.pop('manifest_sha256',None)
    stable.pop('created_at_epoch',None)
    canonical=json.dumps(stable,sort_keys=True,separators=(',',':')).encode()
    return hashlib.sha256(canonical).hexdigest()

def main() -> None:
    ap=argparse.ArgumentParser()
    ap.add_argument('--source-integrity',default='outputs/source-integrity.json')
    ap.add_argument('--macos-cargo',default='outputs/macos-cargo-qualification.json')
    ap.add_argument('--local-backend',default='outputs/local-backend-qualification.json')
    ap.add_argument('--scheduler',default='outputs/scheduler-qualification.json')
    ap.add_argument('--preflight',default='outputs/v113-production-preflight.json')
    ap.add_argument('--rc-report',default='outputs/v113-release-check-rc.json')
    ap.add_argument('--cold-report',default='outputs/v113-cold-story-gate.json')
    ap.add_argument('--agentic-qualification',default='')
    ap.add_argument('--integration-qualification',default='')
    ap.add_argument('--live-qualification',default='')
    ap.add_argument('--visual-qualification',default='outputs/visual-browser-qualification.json')
    ap.add_argument('--business-benchmark',default='outputs/business-value-benchmark.json')
    ap.add_argument('--human-attestation',default='')
    ap.add_argument('--release-manifest',default='release-manifest.json')
    ap.add_argument('--output',default='outputs/v113-final-qualification.json')
    args=ap.parse_args()

    source=load(resolve_path(args.source_integrity)); cargo=load(resolve_path(args.macos_cargo)); local_backend=load(resolve_path(args.local_backend)); scheduler=load(resolve_path(args.scheduler)); pre=load(resolve_path(args.preflight)); rc=load(resolve_path(args.rc_report)); cold=load(resolve_path(args.cold_report))
    agentic=load(resolve_path(args.agentic_qualification)) if args.agentic_qualification else None
    integration_path=args.integration_qualification or args.live_qualification
    integration=load(resolve_path(integration_path)) if integration_path else None
    visual=load(resolve_path(args.visual_qualification)); business=load(resolve_path(args.business_benchmark)); human=load(resolve_path(args.human_attestation)) if args.human_attestation else None
    manifest=load(resolve_path(args.release_manifest)) or {}; locks=manifest.get('dependency_locks',{})
    computed_manifest_hash=release_manifest_hash(manifest)
    manifest_hash_valid=bool(computed_manifest_hash and computed_manifest_hash==manifest.get('manifest_sha256'))

    agentic_checks=(agentic or {}).get('checks') or {}
    agentic_pass=bool(agentic and agentic.get('qualification_type')=='agentic' and agentic.get('passed') is True and agentic_checks.get('causal_autonomous_execution') is True and agentic_checks.get('adaptive_replanning') is True and agentic_checks.get('hidden_tool_failure_recovery') is True and agentic_checks.get('same_session_follow_up') is True and agentic_checks.get('contextual_follow_up_replanning') is True and agentic_checks.get('unsupported_verified_claims_zero') is True and int(agentic.get('unsupported_verified_claims',0) or 0)==0)
    integration_checks=(integration or {}).get('checks') or {}
    integration_pass=bool(integration and integration.get('qualification_type')=='integration' and integration.get('passed') is True and integration_checks.get('browser_publication_passed') is True)
    visual_pass=bool(visual and visual.get('status')=='PASS' and visual.get('cpu_browser_status')=='PASS' and visual.get('gpu_webgl_status')=='PASS')
    business_pass=bool(business and business.get('status')=='MEASURED' and int(business.get('agent_runs',0) or 0)>=3 and int(business.get('baseline_runs',0) or 0)>=3)
    checks={
        'source_integrity':passed_report(source), 'dependency_locks':bool(locks and all(v.get('present') is True for v in locks.values())), 'macos_cargo_locked':passed_report(cargo), 'local_first_backend':passed_report(local_backend), 'scheduler_hardening':passed_report(scheduler), 'production_preflight':passed_report(pre), 'rc_release_gate':passed_report(rc), 'cold_story_gate':passed_report(cold), 'agentic_provider_qualification':agentic_pass, 'integration_provider_qualification':integration_pass, 'visual_browser_gpu_qualification':visual_pass, 'business_value_benchmark':business_pass, 'qualified_human_review':bool(human and human.get('passed') is True and human.get('reviewer_qualification') and human.get('artifact_sha256')), 'release_manifest':manifest_hash_valid,
    }
    blockers=[key for key,value in checks.items() if not value]
    evidence_paths={
        'source_integrity':args.source_integrity,'macos_cargo':args.macos_cargo,'local_backend':args.local_backend,'scheduler':args.scheduler,'preflight':args.preflight,'rc_report':args.rc_report,'cold_report':args.cold_report,'agentic_qualification':args.agentic_qualification or None,'integration_qualification':integration_path or None,'visual_qualification':args.visual_qualification,'business_benchmark':args.business_benchmark,'human_attestation':args.human_attestation or None,'release_manifest':args.release_manifest,
    }
    evidence_index={key:evidence_entry(value) for key,value in evidence_paths.items()}
    out={'schema_version':'0.5.0','release':'1.13.0-rc1','status':'PASS' if not blockers else 'BLOCKED','checks':checks,'blockers':blockers,'release_manifest_integrity':{'declared_sha256':manifest.get('manifest_sha256'),'computed_sha256':computed_manifest_hash,'valid':manifest_hash_valid},'evidence':evidence_paths,'evidence_index':evidence_index,'evidence_set_sha256':evidence_set_hash(evidence_index)}
    path=resolve_path(args.output); assert path is not None
    path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(out,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    print(json.dumps(out,indent=2,sort_keys=True)); raise SystemExit(0 if out['status']=='PASS' else 2)
if __name__=='__main__': main()
