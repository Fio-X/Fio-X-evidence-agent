#!/usr/bin/env python3
"""Low-cost provider route health probe. This is never qualification evidence."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def git_commit() -> str | None:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:
        return None

def token_metric(stderr: str, name: str):
    m = re.search(rf"\b{name}=([0-9]+|N/A)\b", stderr)
    if not m or m.group(1) == "N/A":
        return None
    return int(m.group(1))

def provider_response_observed(returncode: int, stdout: str) -> bool:
    return returncode == 0 and bool(stdout.strip())

def failure_kind(returncode: int, stderr: str, stdout: str) -> str | None:
    if provider_response_observed(returncode, stdout):
        return None
    lower = stderr.lower()
    if "pi provider failed after internal retries" in lower or "pi rejected the prompt: provider_" in lower:
        return "PROVIDER_RUNTIME_FAILURE"
    if returncode == 64:
        return "CONFIGURATION_FAILURE"
    return "INFRASTRUCTURE_FAILURE"

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT/".newsroom"/"provider-preflight.json")
    ap.add_argument("--provider", default=os.environ.get("NEWSROOM_PROVIDER") or os.environ.get("NEWSROOM_PI_PROVIDER"))
    ap.add_argument("--model", default=os.environ.get("NEWSROOM_MODEL") or os.environ.get("NEWSROOM_PI_MODEL"))
    ap.add_argument("--news-bin", default=os.environ.get("NEWSROOM_NEWS_BIN") or str(ROOT/"target"/"release"/"news"))
    ap.add_argument("--timeout-seconds", type=int, default=int(os.environ.get("NEWSROOM_PREFLIGHT_TIMEOUT_SECONDS","90")))
    a = ap.parse_args()
    if not a.provider or not a.model:
        raise SystemExit("provider and model are required")
    started=time.monotonic()
    command=[
        a.news_bin,"ask","--provider",a.provider,"--model",a.model,
        "--thinking","off","--tool-profile","investigate","Reply exactly READY."
    ]
    try:
        proc=subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=a.timeout_seconds,check=False)
        stdout=proc.stdout.strip()
        stderr=proc.stderr
        code=proc.returncode
        timeout=False
    except subprocess.TimeoutExpired as exc:
        stdout=(exc.stdout or "") if isinstance(exc.stdout,str) else ""
        stderr=(exc.stderr or "") if isinstance(exc.stderr,str) else ""
        code=124
        timeout=True
    kind=failure_kind(code,stderr,stdout)
    passed=provider_response_observed(code,stdout)
    response_bytes=len(stdout.encode("utf-8"))
    response_sha256=hashlib.sha256(stdout.encode("utf-8")).hexdigest() if stdout else None
    input_tokens=token_metric(stderr,"tokens_input")
    output_tokens=token_metric(stderr,"tokens_output")
    payload={
        "schema_version":"1.0.0",
        "qualification_evidence":False,
        "status":"PASS" if passed else "FAIL",
        "failure_kind":kind,
        "source_commit":git_commit(),
        "provider":a.provider,
        "model":a.model,
        "thinking":"off",
        "prompt":"Reply exactly READY.",
        "response_observed":bool(stdout),
        "response_bytes":response_bytes,
        "response_sha256":response_sha256,
        "returncode":code,
        "timeout":timeout,
        "wall_ms":round((time.monotonic()-started)*1000),
        "fresh_input_tokens":input_tokens,
        "output_tokens":output_tokens,
        "fresh_tokens":(input_tokens+output_tokens) if input_tokens is not None and output_tokens is not None else None,
        "cache_read_tokens":token_metric(stderr,"tokens_cache_read"),
        "cache_write_tokens":token_metric(stderr,"tokens_cache_write"),
        "recorded_at":dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(payload,indent=2))
    return 0 if passed else 2

if __name__=="__main__":
    raise SystemExit(main())
