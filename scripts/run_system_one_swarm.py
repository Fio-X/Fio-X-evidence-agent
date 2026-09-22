#!/usr/bin/env python3
"""Run the round-1 System One experiment swarm in isolated git worktrees."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "experiments" / "system-one" / "manifest.json"


def run(cmd, *, cwd=ROOT, capture=True, check=True):
    return subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        check=check,
    )


def safe_id(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in value)


def execute_experiment(exp: dict, baseline: str, model: str, tmp_root: Path) -> dict:
    exp_id = safe_id(exp["id"])
    branch = f"exp/system-one-r1-{exp_id}"
    worktree = tmp_root / exp_id
    log = tmp_root / f"{exp_id}.log"
    result_rel = Path(exp["result"])
    status = {
        "id": exp_id,
        "branch": branch,
        "result": str(result_rel),
        "state": "STARTED",
        "log": str(log),
    }

    try:
        run(["git", "worktree", "add", "-b", branch, str(worktree), baseline])
        prompt = (
            "Read AGENTS.md and experiments/system-one/README.md. "
            "Read experiments/system-one/manifest.json and execute exactly round-1 experiment "
            f"{exp_id}. Product source is read-only for this round. "
            f"Write a concise evidence-backed result to {result_rel}. "
            "The result must include: hypothesis, commands/measurements, observed values, "
            "limitations, and one final classification from PROMOTE/HOLD/REJECT/INCONCLUSIVE. "
            "Do not write anywhere else in the repository. Do not expose secrets."
        )
        with log.open("w", encoding="utf-8") as handle:
            proc = subprocess.run(
                ["codex", "exec", "-m", model, prompt],
                cwd=worktree,
                text=True,
                stdout=handle,
                stderr=subprocess.STDOUT,
            )
        if proc.returncode != 0:
            status["state"] = "CODEX_FAILED"
            status["returncode"] = proc.returncode
            return status

        result_path = worktree / result_rel
        if not result_path.is_file():
            status["state"] = "NO_RESULT"
            return status

        changed = run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=worktree).stdout.splitlines()
        allowed = {f"?? {result_rel}", f" M {result_rel}", f"M  {result_rel}", f"A  {result_rel}"}
        unexpected = [line for line in changed if line not in allowed]
        if unexpected:
            status["state"] = "UNEXPECTED_CHANGES"
            status["unexpected"] = unexpected
            return status

        run(["git", "add", str(result_rel)], cwd=worktree)
        run(["git", "commit", "-m", f"experiment: {exp_id}"], cwd=worktree)
        run(["git", "push", "-u", "origin", branch], cwd=worktree)
        status["state"] = "PUSHED"
        status["commit"] = run(["git", "rev-parse", "HEAD"], cwd=worktree).stdout.strip()
        return status
    except subprocess.CalledProcessError as exc:
        status["state"] = "ERROR"
        status["error"] = (exc.stdout or str(exc))[-2000:]
        return status
    finally:
        try:
            run(["git", "worktree", "remove", "--force", str(worktree)], capture=True, check=False)
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--only", nargs="*", help="experiment IDs to run")
    args = parser.parse_args()

    if not 1 <= args.jobs <= 8:
        raise SystemExit("--jobs must be between 1 and 8")
    if shutil.which("codex") is None:
        raise SystemExit("codex is not on PATH")
    if run(["git", "status", "--porcelain"]).stdout.strip():
        raise SystemExit("main worktree must be clean before running the swarm")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    experiments = manifest["experiments"]
    if args.only:
        wanted = set(args.only)
        experiments = [exp for exp in experiments if exp["id"] in wanted]
        missing = wanted - {exp["id"] for exp in experiments}
        if missing:
            raise SystemExit(f"unknown experiment IDs: {sorted(missing)}")

    baseline = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    run(["git", "fetch", "origin"], capture=True)
    tmp_root = Path(tempfile.mkdtemp(prefix="fiox-system-one-swarm-"))
    print(f"baseline={baseline}")
    print(f"experiments={len(experiments)} jobs={args.jobs} model={args.model}")
    print(f"logs={tmp_root}")

    results = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(execute_experiment, exp, baseline, args.model, tmp_root): exp["id"]
            for exp in experiments
        }
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(f"{result['id']}: {result['state']}")

    summary = tmp_root / "summary.json"
    summary.write_text(json.dumps(sorted(results, key=lambda r: r["id"]), indent=2) + "\n", encoding="utf-8")
    pushed = sum(result["state"] == "PUSHED" for result in results)
    print(f"pushed={pushed}/{len(results)}")
    print(f"summary={summary}")
    return 0 if pushed == len(results) else 2


if __name__ == "__main__":
    sys.exit(main())
