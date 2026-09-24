#!/usr/bin/env python3
from __future__ import annotations
import importlib.util, json, os, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

spec=importlib.util.spec_from_file_location("agentic_trials",ROOT/"scripts"/"agentic_trials.py")
mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory(prefix="agentic-batch-test-") as tmp:
    root=Path(tmp)
    artifact=root/"artifact"; artifact.mkdir()
    (artifact/"events.jsonl").write_text("\n".join([
        json.dumps({"type":"turn_end","message":{"stopReason":"error","errorMessage":"diagnostic suppressed"}}),
        json.dumps({"type":"auto_retry_start","attempt":1,"delayMs":2000}),
        json.dumps({"type":"turn_end","message":{"stopReason":"error","errorMessage":"diagnostic suppressed"}}),
    ])+"\n")
    (artifact/"story.json").write_text(json.dumps({"autonomy":{
        "provider_failed_turns":2,"provider_auto_retries":1,"provider_retry_max_attempt":1,
        "provider_retry_delay_ms_total":2000,"provider_failure_observed":True,
        "provider_error_classes":{}
    }}))
    assert mod.classify_failure(1,artifact,{})=="PROVIDER_RUNTIME_FAILURE"

    expected={"provider":"p","model":"m","source_commit":"a"*40,"scenario_id":"s"}
    good={"qualification_type":"agentic","status":"PASS","passed":True,"provider":"p","model":"m",
          "source_commit":"a"*40,"scenario_id":"s","unsupported_verified_claims":0,
          "verified_source_and_computation_claims":1,
          "checks":{"verified_source_and_computation_claim":True,"unsupported_verified_claims_zero":True,
                    "hidden_tool_failure_recovery":True,"causal_autonomous_execution":True,"adaptive_replanning":True},
          "usage_accounting":{"fresh_input_tokens":10,"output_tokens":2,"fresh_tokens":12,
                              "cache_read_tokens":20,"cache_write_tokens":3,"reported_cost":None,"cost_available":False}}
    rows=[mod.trial_row(1,0,None,good,100,expected),mod.trial_row(2,1,artifact,{},200,expected)]
    summary=mod.reliability_summary(rows,planned_trials=3,batch_id="batch-x",stopped_early=True)
    assert summary["status"]=="FAIL"
    assert summary["attempted_trials"]==2 and summary["planned_trials"]==3
    assert summary["stopped_early"] is True
    assert summary["failure_kinds"]==["PROVIDER_RUNTIME_FAILURE"]
    assert summary["fresh_tokens"]["total"]==12

    fake=root/"fake-news"
    fake.write_text("#!/bin/sh\nprintf 'READY.\\n'\nprintf '[agent] tokens_input=3 tokens_output=1 tokens_cache_read=5 tokens_cache_write=2\\n' >&2\n")
    fake.chmod(0o755)
    out=root/"preflight.json"
    proc=subprocess.run([sys.executable,str(ROOT/"scripts"/"provider_preflight.py"),"--out",str(out),
                         "--provider","p","--model","m","--news-bin",str(fake)],cwd=ROOT,text=True,capture_output=True)
    assert proc.returncode==0,proc.stdout+proc.stderr
    payload=json.loads(out.read_text())
    assert payload["status"]=="PASS" and payload["qualification_evidence"] is False
    assert payload["response_observed"] is True and payload["response_bytes"]>0
    assert isinstance(payload["response_sha256"],str) and len(payload["response_sha256"])==64
    assert payload["fresh_tokens"]==4 and payload["cache_read_tokens"]==5

    empty=root/"empty-news"
    empty.write_text("#!/bin/sh\nprintf '[agent] tokens_input=3 tokens_output=0 tokens_cache_read=0 tokens_cache_write=0\\n' >&2\n")
    empty.chmod(0o755)
    empty_out=root/"empty-preflight.json"
    empty_proc=subprocess.run([sys.executable,str(ROOT/"scripts"/"provider_preflight.py"),"--out",str(empty_out),
                               "--provider","p","--model","m","--news-bin",str(empty)],cwd=ROOT,text=True,capture_output=True)
    assert empty_proc.returncode==2
    empty_payload=json.loads(empty_out.read_text())
    assert empty_payload["status"]=="FAIL"
    assert empty_payload["response_observed"] is False
    assert empty_payload["response_sha256"] is None

print("agentic batch and provider preflight contracts: PASS")
