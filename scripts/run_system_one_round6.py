#!/usr/bin/env python3
"""Run the single System One round-6 combined production-candidate experiment."""

from __future__ import annotations
import json, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/"experiments"/"system-one"/"round6-manifest.json"

def run(cmd, *, cwd=ROOT, check=True):
    return subprocess.run(cmd,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,check=check)

def main():
    model="gpt-5.6-luna"
    if shutil.which("codex") is None: raise SystemExit("codex is not on PATH")
    if run(["git","status","--porcelain"]).stdout.strip(): raise SystemExit("main worktree must be clean")
    m=json.loads(MANIFEST.read_text()); exp=m["experiment"]; eid=exp["id"]
    baseline=run(["git","rev-parse","HEAD"]).stdout.strip()
    run(["git","fetch","origin"])
    tmp=Path(tempfile.mkdtemp(prefix="fiox-system-one-r6-"))
    wt=tmp/eid; log=tmp/f"{eid}.log"; result_rel=Path("experiments/system-one/results")/f"{eid}.md"
    allowed=set(exp["allowed_files"])|{str(result_rel)}
    remote_branch=f"exp/system-one-{eid}"
    print(f"baseline={baseline}")
    print(f"{eid}: STARTED")
    print(f"log={log}")
    try:
        run(["git","worktree","add","--detach",str(wt),baseline])
        prompt=(
          "Read AGENTS.md, experiments/system-one/round5-summary.md, round6-plan.md, and round6-manifest.json. "
          "Execute exactly r6-01-combined-token-curve-candidate. "
          "Inspect the three listed R5 input branches with git show/diff and manually integrate the compatible mechanisms; "
          "do not blindly merge newsroom.ts. Modify only allowed_files and the result file. "
          "Preserve all invariants, run all common/focused checks and the combined A/B harness, "
          "and write an evidence-backed result ending with exactly one classification PROMOTE, HOLD, REJECT, or INCONCLUSIVE."
        )
        with log.open("w",encoding="utf-8") as h:
            p=subprocess.run(["codex","exec","-m",model,prompt],cwd=wt,text=True,stdout=h,stderr=subprocess.STDOUT)
        if p.returncode: raise SystemExit(f"CODEX_FAILED returncode={p.returncode}; log={log}")
        if not (wt/result_rel).is_file(): raise SystemExit(f"NO_RESULT; log={log}")
        changed=run(["git","status","--porcelain","--untracked-files=all"],cwd=wt).stdout.splitlines()
        paths=[]
        for line in changed:
            raw=line[3:]
            if " -> " in raw: raw=raw.split(" -> ",1)[1]
            paths.append(raw)
        unexpected=sorted(set(paths)-allowed)
        if unexpected: raise SystemExit(f"UNEXPECTED_CHANGES={unexpected}; log={log}")
        existing=[p for p in sorted(allowed) if (wt/p).exists()]
        run(["git","add","--",*existing],cwd=wt)
        run(["git","commit","-m",f"experiment: {eid}"],cwd=wt)
        run(["git","push","origin",f"HEAD:refs/heads/{remote_branch}"],cwd=wt)
        commit=run(["git","rev-parse","HEAD"],cwd=wt).stdout.strip()
        summary=tmp/"summary.json"
        summary.write_text(json.dumps({"id":eid,"state":"PUSHED","branch":remote_branch,"commit":commit,"log":str(log)},indent=2)+"\n")
        print(f"{eid}: PUSHED")
        print("pushed=1/1")
        print(f"summary={summary}")
    finally:
        run(["git","worktree","remove","--force",str(wt)],check=False)

if __name__=="__main__":
    main()
