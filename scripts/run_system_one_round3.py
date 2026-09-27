#!/usr/bin/env python3
"""Run isolated System One round-3 integration/A-B experiments."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/"experiments"/"system-one"/"round3-manifest.json"

def run(cmd, *, cwd=ROOT, check=True):
    return subprocess.run(cmd,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=check)

def execute(exp, baseline, model, tmp):
    eid=exp["id"]; branch=f"exp/system-one-{eid}"; wt=tmp/eid; log=tmp/f"{eid}.log"
    result_rel=Path("experiments/system-one/results")/f"{eid}.md"
    allowed=set(exp["allowed_files"])|{str(result_rel)}
    state={"id":eid,"branch":branch,"state":"STARTED","log":str(log)}
    try:
        run(["git","worktree","add","-b",branch,str(wt),baseline])
        prompt=(
          "Read AGENTS.md, experiments/system-one/README.md, round1-summary.md, round2-summary.md, "
          "and round3-manifest.json. Execute exactly experiment "+eid+". "
          "Inspect its listed origin/exp branches with git diff/show as implementation inputs; integrate ideas, do not blindly copy conflicting files. "
          f"Modify only the allowed files and {result_rel}. "
          "Implement the smallest bounded A/B variant, preserve all stated invariants, run common and focused checks, "
          "measure the requested repeated A/B values, and write one final classification PROMOTE/HOLD/REJECT/INCONCLUSIVE."
        )
        with log.open("w",encoding="utf-8") as h:
            p=subprocess.run(["codex","exec","-m",model,prompt],cwd=wt,text=True,stdout=h,stderr=subprocess.STDOUT)
        if p.returncode:
            state["state"]="CODEX_FAILED"; state["returncode"]=p.returncode; return state
        if not (wt/result_rel).is_file():
            state["state"]="NO_RESULT"; return state
        changed=run(["git","status","--porcelain","--untracked-files=all"],cwd=wt).stdout.splitlines()
        paths=[]
        for line in changed:
            raw=line[3:]
            if " -> " in raw: raw=raw.split(" -> ",1)[1]
            paths.append(raw)
        unexpected=sorted(set(paths)-allowed)
        if unexpected:
            state["state"]="UNEXPECTED_CHANGES"; state["unexpected"]=unexpected; return state
        existing=[p for p in sorted(allowed) if (wt/p).exists()]
        run(["git","add","--",*existing],cwd=wt)
        run(["git","commit","-m",f"experiment: {eid}"],cwd=wt)
        run(["git","push","-u","origin",branch],cwd=wt)
        state["state"]="PUSHED"; state["commit"]=run(["git","rev-parse","HEAD"],cwd=wt).stdout.strip()
        return state
    except subprocess.CalledProcessError as e:
        state["state"]="ERROR"; state["error"]=(e.stdout or str(e))[-2000:]; return state
    finally:
        run(["git","worktree","remove","--force",str(wt)],check=False)

def main():
    p=argparse.ArgumentParser(); p.add_argument("--jobs",type=int,default=2); p.add_argument("--model",default="gpt-5.6-luna"); p.add_argument("--only",nargs="*")
    a=p.parse_args()
    if not 1<=a.jobs<=3: raise SystemExit("--jobs must be between 1 and 3")
    if shutil.which("codex") is None: raise SystemExit("codex is not on PATH")
    if run(["git","status","--porcelain"]).stdout.strip(): raise SystemExit("main worktree must be clean")
    m=json.loads(MANIFEST.read_text()); exps=m["experiments"]
    if a.only:
        wanted=set(a.only); exps=[e for e in exps if e["id"] in wanted]
        missing=wanted-{e["id"] for e in exps}
        if missing: raise SystemExit(f"unknown IDs: {sorted(missing)}")
    baseline=run(["git","rev-parse","HEAD"]).stdout.strip(); run(["git","fetch","origin"])
    tmp=Path(tempfile.mkdtemp(prefix="fiox-system-one-r3-"))
    print(f"baseline={baseline}"); print(f"experiments={len(exps)} jobs={a.jobs} model={a.model}"); print(f"logs={tmp}")
    results=[]
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        fs={pool.submit(execute,e,baseline,a.model,tmp):e["id"] for e in exps}
        for f in as_completed(fs):
            r=f.result(); results.append(r); print(f"{r['id']}: {r['state']}")
    summary=tmp/"summary.json"; summary.write_text(json.dumps(sorted(results,key=lambda x:x["id"]),indent=2)+"\n")
    pushed=sum(r["state"]=="PUSHED" for r in results)
    print(f"pushed={pushed}/{len(results)}"); print(f"summary={summary}")
    return 0 if pushed==len(results) else 2

if __name__=="__main__": sys.exit(main())
