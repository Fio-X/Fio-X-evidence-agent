#!/usr/bin/env python3
"""Run a fail-fast live agentic qualification batch and summarize reliability."""
from __future__ import annotations
import argparse, datetime as dt, json, math, os, statistics, subprocess, sys, time
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MIN_TRIALS=3
CONSISTENCY_KEYS=(
    "claim_correctness_rate","provenance_integrity_rate","recovery_success_rate",
    "autonomous_execution_rate","adaptive_replanning_rate",
)

def git_commit():
    try:
        return subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
    except Exception:
        return None

def newest_artifact(root: Path):
    dirs=[p for p in root.iterdir() if p.is_dir()] if root.is_dir() else []
    return max(dirs,key=lambda p:(p.stat().st_mtime_ns,p.name)) if dirs else None

def load_json(path: Path, default=None):
    try: return json.loads(path.read_text())
    except Exception: return {} if default is None else default

def jsonl(path: Path):
    rows=[]
    try:
        for line in path.read_text(errors="replace").splitlines():
            if line.strip(): rows.append(json.loads(line))
    except Exception: pass
    return rows

def provider_telemetry(artifact: Path|None):
    if artifact is None: return {}
    story=load_json(artifact/"story.json")
    autonomy=story.get("autonomy") or {}
    metrics=jsonl(artifact/"run-metrics.jsonl")
    latest=metrics[-1] if metrics else {}
    return {
        "provider_failed_turns":autonomy.get("provider_failed_turns",latest.get("provider_failed_turns",0)),
        "provider_auto_retries":autonomy.get("provider_auto_retries",latest.get("provider_auto_retries",0)),
        "provider_retry_max_attempt":autonomy.get("provider_retry_max_attempt",latest.get("provider_retry_max_attempt",0)),
        "provider_retry_delay_ms_total":autonomy.get("provider_retry_delay_ms_total",latest.get("provider_retry_delay_ms_total",0)),
        "provider_failure_observed":autonomy.get("provider_failure_observed",latest.get("provider_failure_observed",False)),
        "provider_error_classes":autonomy.get("provider_error_classes",latest.get("provider_error_classes",{})) or {},
    }

def observed_provider_failure(artifact: Path|None):
    if artifact is None: return False
    telemetry=provider_telemetry(artifact)
    if telemetry.get("provider_failure_observed"): return True
    for event in jsonl(artifact/"events.jsonl"):
        message=event.get("message") if isinstance(event.get("message"),dict) else {}
        if message.get("stopReason")=="error": return True
        if event.get("provider_error_class"): return True
    return False

def classify_failure(exit_code: int, artifact: Path|None, qual: dict):
    if exit_code==0 and qual.get("status")=="PASS" and qual.get("passed") is True:
        return None
    if qual and (qual.get("status")=="FAIL" or qual.get("passed") is False):
        return "AGENTIC_GATE_FAILURE"
    if observed_provider_failure(artifact):
        return "PROVIDER_RUNTIME_FAILURE"
    if exit_code==64:
        return "CONFIGURATION_FAILURE"
    return "INFRASTRUCTURE_FAILURE"

def usage_accounting(qual: dict):
    ua=qual.get("usage_accounting") or {}
    legacy=qual.get("usage_metrics") or {}
    def legacy_find(*needles):
        for key,value in legacy.items():
            if isinstance(value,(int,float)) and not isinstance(value,bool) and all(n in key.lower() for n in needles):
                return value
        return None
    fresh_input=ua.get("fresh_input_tokens",legacy_find("input","token"))
    output=ua.get("output_tokens",legacy_find("output","token"))
    fresh=ua.get("fresh_tokens")
    if fresh is None and isinstance(fresh_input,(int,float)) and isinstance(output,(int,float)):
        fresh=fresh_input+output
    return {
        "fresh_input_tokens":fresh_input,
        "output_tokens":output,
        "fresh_tokens":fresh,
        "cache_read_tokens":ua.get("cache_read_tokens",legacy_find("cache","read")),
        "cache_write_tokens":ua.get("cache_write_tokens",legacy_find("cache","write")),
        "reported_cost":ua.get("reported_cost",legacy_find("cost")),
        "cost_available":bool(ua.get("cost_available",legacy_find("cost") is not None)),
    }

def trial_row(index,exit_code,artifact,qual,wall_ms,expected):
    checks=qual.get("checks") or {}
    passed=exit_code==0 and qual.get("qualification_type")=="agentic" and qual.get("status")=="PASS" and qual.get("passed") is True
    usage=usage_accounting(qual)
    telemetry=provider_telemetry(artifact)
    return {
        "trial":index,"exit_code":exit_code,"passed":passed,"task_success":passed,
        "failure_kind":classify_failure(exit_code,artifact,qual),
        "claim_correctness":qual.get("unsupported_verified_claims",1)==0 and qual.get("verified_source_and_computation_claims",0)>=1,
        "provenance_integrity":checks.get("verified_source_and_computation_claim") is True and checks.get("unsupported_verified_claims_zero") is True,
        "recovery_success":checks.get("hidden_tool_failure_recovery") is True,
        "autonomous_execution":checks.get("causal_autonomous_execution") is True,
        "adaptive_replanning":checks.get("adaptive_replanning") is True,
        "provider":qual.get("provider") or expected.get("provider"),
        "model":qual.get("model") or expected.get("model"),
        "source_commit":qual.get("source_commit") or expected.get("source_commit"),
        "scenario_id":qual.get("scenario_id") or expected.get("scenario_id"),
        "artifact":str(artifact) if artifact else None,"wall_ms":wall_ms,
        **usage,**telemetry,"qualification":qual,
    }

def stats(rows,key):
    vals=[row[key] for row in rows if isinstance(row.get(key),(int,float)) and not isinstance(row.get(key),bool)]
    if not vals: return {"count":0,"total":None,"mean":None,"median":None,"min":None,"max":None,"mad":None}
    median=statistics.median(vals)
    return {"count":len(vals),"total":sum(vals),"mean":sum(vals)/len(vals),"median":median,
            "min":min(vals),"max":max(vals),"mad":statistics.median([abs(v-median) for v in vals])}

def reliability_summary(rows,planned_trials=MIN_TRIALS,batch_id=None,preflight=None,stopped_early=False):
    n=len(rows); passed=sum(1 for row in rows if row["passed"]); rate=passed/n if n else 0.0
    pass_at_k={}; pass_pow_k={}
    for k in range(1,n+1):
        misses=n-passed; total_combo=math.comb(n,k); miss_combo=math.comb(misses,k) if misses>=k else 0
        pass_at_k[str(k)]=1.0-(miss_combo/total_combo if total_combo else 1.0); pass_pow_k[str(k)]=rate**k
    configs=[(r.get("provider"),r.get("model"),r.get("source_commit"),r.get("scenario_id")) for r in rows]
    complete=bool(configs) and all(all(isinstance(v,str) and v.strip() for v in cfg) for cfg in configs)
    consistent=complete and len(set(configs))==1
    minimum=n>=MIN_TRIALS
    consistency={
        "claim_correctness_rate":sum(bool(r["claim_correctness"]) for r in rows)/n if n else 0.0,
        "provenance_integrity_rate":sum(bool(r["provenance_integrity"]) for r in rows)/n if n else 0.0,
        "recovery_success_rate":sum(bool(r["recovery_success"]) for r in rows)/n if n else 0.0,
        "autonomous_execution_rate":sum(bool(r["autonomous_execution"]) for r in rows)/n if n else 0.0,
        "adaptive_replanning_rate":sum(bool(r["adaptive_replanning"]) for r in rows)/n if n else 0.0,
    }
    all_pass=minimum and consistent and passed==n and n==planned_trials and all(consistency[k]==1.0 for k in CONSISTENCY_KEYS)
    cfg=configs[0] if consistent else (None,None,None,None)
    return {
        "schema_version":"1.3.0","qualification_type":"agentic_reliability",
        "batch_id":batch_id,"status":"PASS" if all_pass else "FAIL",
        "planned_trials":planned_trials,"attempted_trials":n,"stopped_early":stopped_early,
        "minimum_trials":MIN_TRIALS,"minimum_trials_satisfied":minimum,
        "configuration_consistent":consistent,"provider":cfg[0],"model":cfg[1],
        "source_commit":cfg[2],"scenario_id":cfg[3],"trials":n,"passed":passed,
        "pass_rate":rate,"all_pass":all_pass,"pass_at_k":pass_at_k,"pass_pow_k":pass_pow_k,
        "failure_kinds":[r["failure_kind"] for r in rows if r.get("failure_kind")],
        "preflight":preflight,"consistency":consistency,
        "wall_ms":stats(rows,"wall_ms"),"fresh_input_tokens":stats(rows,"fresh_input_tokens"),
        "output_tokens":stats(rows,"output_tokens"),"fresh_tokens":stats(rows,"fresh_tokens"),
        "cache_read_tokens":stats(rows,"cache_read_tokens"),"cache_write_tokens":stats(rows,"cache_write_tokens"),
        "reported_cost":stats(rows,"reported_cost"),"rows":rows,
    }

def write_batch(path,payload):
    path.write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--trials",type=int,default=MIN_TRIALS)
    ap.add_argument("--out",type=Path,default=ROOT/".newsroom"/"agentic-trials")
    ap.add_argument("--qualification-files",type=Path,nargs="*",help="summarize existing qualification JSON files instead of running live trials")
    ap.add_argument("--batch-id",default=None)
    ap.add_argument("--skip-preflight",action="store_true")
    a=ap.parse_args(); a.out.mkdir(parents=True,exist_ok=True)
    if a.trials<MIN_TRIALS and a.qualification_files is None:
        print(f"--trials must be >= {MIN_TRIALS}"); return 2
    expected={
        "provider":os.environ.get("NEWSROOM_PROVIDER"),
        "model":os.environ.get("NEWSROOM_MODEL"),
        "source_commit":git_commit(),
        "scenario_id":os.environ.get("NEWSROOM_AGENTIC_SCENARIO_ID"),
    }
    batch_id=a.batch_id or f'{dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")}-{(expected["source_commit"] or "unknown")[:8]}'
    batch_path=a.out/"batch.json"; rows=[]; preflight=None; stopped_early=False
    batch={"schema_version":"1.0.0","batch_id":batch_id,"planned_trials":a.trials,
           "attempted_trials":0,"passed_trials":0,"status":"RUNNING","stopped_early":False,
           "failure_kind":None,**expected}
    write_batch(batch_path,batch)
    if a.qualification_files is not None:
        if len(a.qualification_files)<MIN_TRIALS:
            print(f"at least {MIN_TRIALS} qualification files are required for repeated reliability evidence"); return 2
        for i,path in enumerate(a.qualification_files,1):
            qual=load_json(path); rows.append(trial_row(i,0 if qual.get("status")=="PASS" else 2,path.parent,qual,int(qual.get("agent_wall_ms_total",0) or 0),expected))
        a.trials=len(rows)
    else:
        if not all(isinstance(v,str) and v.strip() for v in expected.values()):
            batch.update(status="FAIL",stopped_early=True,failure_kind="CONFIGURATION_FAILURE")
            write_batch(batch_path,batch); print(json.dumps(batch,indent=2)); return 2
        if not a.skip_preflight:
            preflight_path=a.out/"provider-preflight.json"
            proc=subprocess.run([sys.executable,str(ROOT/"scripts"/"provider_preflight.py"),"--out",str(preflight_path),
                                 "--provider",expected["provider"],"--model",expected["model"]],cwd=ROOT,env=os.environ.copy(),check=False)
            preflight=load_json(preflight_path)
            if proc.returncode!=0 or preflight.get("status")!="PASS":
                batch.update(status="FAIL",stopped_early=True,failure_kind=preflight.get("failure_kind") or "PROVIDER_RUNTIME_FAILURE",
                             preflight=str(preflight_path))
                write_batch(batch_path,batch)
                out=reliability_summary(rows,a.trials,batch_id,preflight,True)
                (a.out/"summary.json").write_text(json.dumps(out,indent=2)+"\n")
                return 2
        for i in range(1,a.trials+1):
            trial=a.out/f"trial-{i:02d}"; env=os.environ.copy(); env["NEWSROOM_AGENTIC_OUT"]=str(trial)
            started=time.time()
            proc=subprocess.run([str(ROOT/"scripts"/"agentic_qualification.sh")],cwd=ROOT,env=env,check=False)
            artifact=newest_artifact(trial); qual={}
            if artifact and (artifact/"agentic-qualification.json").is_file(): qual=load_json(artifact/"agentic-qualification.json")
            row=trial_row(i,proc.returncode,artifact,qual,round((time.time()-started)*1000),expected); rows.append(row)
            batch.update(attempted_trials=len(rows),passed_trials=sum(r["passed"] for r in rows))
            if not row["passed"]:
                stopped_early=True
                batch.update(status="FAIL",stopped_early=True,failure_kind=row["failure_kind"])
                write_batch(batch_path,batch)
                break
            write_batch(batch_path,batch)
    out=reliability_summary(rows,a.trials,batch_id,preflight,stopped_early)
    batch.update(status=out["status"],attempted_trials=len(rows),passed_trials=sum(r["passed"] for r in rows),
                 stopped_early=stopped_early,failure_kind=(out["failure_kinds"][0] if out["failure_kinds"] else None))
    write_batch(batch_path,batch)
    (a.out/"summary.json").write_text(json.dumps(out,indent=2)+"\n")
    representative=a.out/"agentic-qualification.json"
    if representative.exists(): representative.unlink()
    if out["all_pass"] and rows and isinstance(rows[0].get("qualification"),dict):
        representative.write_text(json.dumps(rows[0]["qualification"],indent=2)+"\n")
    print(json.dumps(out,indent=2))
    return 0 if out["all_pass"] else 2

if __name__=="__main__":
    raise SystemExit(main())
