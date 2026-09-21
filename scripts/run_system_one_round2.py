#!/usr/bin/env python3
"""Run isolated System One round-2 A/B experiments with Luna."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "experiments" / "system-one" / "round2-manifest.json"


def run(cmd, *, cwd=ROOT, check=True):
    return subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=check)


def one(exp, baseline, model, tmp_root):
    exp_id = exp["id"]
    branch = f"exp/system-one-{exp_id}"
    worktree = tmp_root / exp_id
    log = tmp_root / f"{exp_id}.log"
    result_rel = Path("experiments/system-one/results") / f"{exp_id}.md"
    allowed = set(exp["allowed_files"]) | {str(result_rel)}
    state = {"id": exp_id, "branch": branch, "state": "STARTED", "log": str(log)}
    try:
        run(["git", "worktree", "add", "-b", branch, str(worktree), baseline])
        prompt = (
            "Read AGENTS.md, experiments/system-one/README.md, experiments/system-one/round1-summary.md, "
            "and experiments/system-one/round2-manifest.json. Execute exactly experiment "
            f"{exp_id}. You may modify only its allowed_files and {result_rel}. "
            "Preserve all evidence/provenance/verification/publication gates. "
            "Implement the smallest bounded A/B prototype, run the required common checks plus focused tests, "
            "measure baseline versus variant where possible, and write a concise result with observed values, "
            "diff scope, limitations, and exactly one final classification: PROMOTE, HOLD, REJECT, or INCONCLUSIVE."
        )
        with log.open("w", encoding="utf-8") as handle:
            proc = subprocess.run(["codex", "exec", "-m", model, prompt], cwd=worktree, text=True, stdout=handle, stderr=subprocess.STDOUT)
        if proc.returncode:
            state["state"] = "CODEX_FAILED"; state["returncode"] = proc.returncode; return state
        if not (worktree / result_rel).is_file():
            state["state"] = "NO_RESULT"; return state
        changed = run(["git","status","--porcelain","--untracked-files=all"],cwd=worktree).stdout.splitlines()
        paths=[]
        for line in changed:
            raw=line[3:]
            if " -> " in raw: raw=raw.split(" -> ",1)[1]
            paths.append(raw)
        unexpected=sorted(set(paths)-allowed)
        if unexpected:
            state["state"]="UNEXPECTED_CHANGES"; state["unexpected"]=unexpected; return state
        run(["git","add","--",*sorted(allowed)],cwd=worktree)
        run(["git","commit","-m",f"experiment: {exp_id}"],cwd=worktree)
        run(["git","push","-u","origin",branch],cwd=worktree)
        state["state"]="PUSHED"; state["commit"]=run(["git","rev-parse","HEAD"],cwd=worktree).stdout.strip()
        return state
    except subprocess.CalledProcessError as exc:
        state["state"]="ERROR"; state["error"]=(exc.stdout or str(exc))[-2000:]; return state
    finally:
        run(["git","worktree","remove","--force",str(worktree)],check=False)


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--jobs",type=int,default=3)
    p.add_argument("--model",default="gpt-5.6-luna")
    p.add_argument("--only",nargs="*")
    args=p.parse_args()
    if not 1 <= args.jobs <= 5: raise SystemExit("--jobs must be between 1 and 5")
    if shutil.which("codex") is None: raise SystemExit("codex is not on PATH")
    if run(["git","status","--porcelain"]).stdout.strip(): raise SystemExit("main worktree must be clean")
    manifest=json.loads(MANIFEST.read_text())
    exps=manifest["experiments"]
    if args.only:
        wanted=set(args.only); exps=[e for e in exps if e["id"] in wanted]
        missing=wanted-{e["id"] for e in exps}
        if missing: raise SystemExit(f"unknown IDs: {sorted(missing)}")
    baseline=run(["git","rev-parse","HEAD"]).stdout.strip()
    run(["git","fetch","origin"])
    tmp=Path(tempfile.mkdtemp(prefix="fiox-system-one-r2-"))
    print(f"baseline={baseline}")
    print(f"experiments={len(exps)} jobs={args.jobs} model={args.model}")
    print(f"logs={tmp}")
    results=[]
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures={pool.submit(one,e,baseline,args.model,tmp):e["id"] for e in exps}
        for f in as_completed(futures):
            r=f.result(); results.append(r); print(f"{r['id']}: {r['state']}")
    out=tmp/"summary.json"; out.write_text(json.dumps(sorted(results,key=lambda x:x["id"]),indent=2)+"\n")
    pushed=sum(r["state"]=="PUSHED" for r in results)
    print(f"pushed={pushed}/{len(results)}"); print(f"summary={out}")
    return 0 if pushed==len(results) else 2


if __name__=="__main__":
    sys.exit(main())
