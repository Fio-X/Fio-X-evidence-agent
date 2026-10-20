#!/usr/bin/env python3
"""Report-only recheck of the stored computations of one run (or two, to pair them).

usage: python3 -I recheck_computations.py (--run RUN_ROOT | --arm-dir ARM_DIR) --news-bin NEWS --duckdb-bin DUCKDB --tmp TMPDIR --canary-dir CANARY [--other-run RUN_ROOT | --other-arm-dir ARM_DIR]

It reuses the product's own recompute: `news verify <copy> --recompute` (src/verify.rs recompute_artifact, src/commands/verify.rs), which re-runs each
computations/*.json SQL with DuckDB on the stored data/ and sources/ and compares the canonical rows and result_hash with the file's own.
The run is copied into --tmp first by `cp` (verify writes verification.json; the harness itself opens no deny-listed file), and HOME points into --tmp so no user config is read. Nothing is installed.
Prints per file only `<first 12 hex of the file name> same|different|could-not-run`, then counts; with a second run, also paired-same,
paired-different and unpaired counts per side (key = input_snapshot_hash + input_binding + the SQL text, hashed, never printed). No SQL, no rows.
The paired_*/unpaired_* numbers count KEYS (several files can share one key); files_a/files_b/keys_a/keys_b are printed beside them. A pairing field that
is missing in a file becomes the text "None" in the key; dict/list fields are written with sorted keys. Paired files must also agree on a hash of the stored rows.
Before anything runs: pre-flight (the DuckDB file exists, `duckdb -version` exits 0, its version is printed) and a canary (the product on a known-good archive,
--canary-dir, required, no default; must be 100% same; it also fixes how many checks one file adds). On failure it prints `ENV-PROBLEM <reason>` and exits 5.
"same" needs positive evidence: `SQL recompute: PASS` and the expected check count (1 + per-file checks x files). Could-not-run files are counted by reason; when every
one failed to execute or timed out, that is an environment problem (exit 5, never a bad-file stop).
Exit 0 when it ran (report only); 4 on bad input; 5 on an environment problem. It never decides a stop."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I does not add the script folder
import measure_lib as L  # noqa: E402

DIFFERENT = ("recompute rows mismatch", "recompute result_hash mismatch")
ENV_PROBLEM_EXIT = 5
ENV_REASONS = ("failed-to-execute", "timed-out")


def _text(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)


def pair_key(c):
    return hashlib.sha256("\n".join([_text(c.get("input_snapshot_hash")), _text(c.get("input_binding")), _text(c.get("sql"))]).encode()).hexdigest()


def rows_hash(c):
    return hashlib.sha256(json.dumps(c.get("rows"), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def reason_of(msg):
    if msg.startswith("failed to execute DuckDB"):
        return "failed-to-execute"
    if msg.startswith("recompute timed out"):
        return "timed-out"
    if msg.startswith("DuckDB recompute failed"):
        return "duckdb-error"
    return "other"


def preflight(duckdb):
    """-> (ok, version, note). The DuckDB must be a file and `duckdb -version` must exit 0."""
    if not os.path.isfile(duckdb):
        return False, None, "the DuckDB binary is not a file"
    try:
        r = subprocess.run([duckdb, "-version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        return False, None, f"duckdb -version did not run ({type(e).__name__})"
    if r.returncode != 0:
        return False, None, f"duckdb -version exit {r.returncode}"
    return True, r.stdout.strip().splitlines()[0] if r.stdout.strip() else "", ""


def load_files(run):
    d = os.path.join(run, "computations")
    out = {}
    for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if f.endswith(".json"):
            try:
                c = json.load(open(os.path.join(d, f)))
            except ValueError:
                c = {}
            out[f] = c if isinstance(c, dict) else {}
    return out


def run_product(run, news, duckdb, tmp, timeout_s=30, per_file=None):
    """-> {"status": {file: same|different|could-not-run}, "note", "reasons": {reason: n}, "checks": int|None, "expected_checks": int}. Product recompute on a copy."""
    files = load_files(run)
    work = os.path.join(tmp, "copy-" + hashlib.sha256(os.path.abspath(run).encode()).hexdigest()[:8])
    if os.path.exists(work):
        shutil.rmtree(work)
    # The copy is made by `cp` (an APFS clone where possible), not by this script: the bytes of deny-listed files are never opened by the harness.
    if subprocess.run(["cp", "-cR", run, work], capture_output=True).returncode != 0:
        shutil.rmtree(work, ignore_errors=True)
        subprocess.run(["cp", "-R", run, work], check=True, capture_output=True)
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home}
    r = subprocess.run([news, "verify", work, "--recompute", "--duckdb-bin", duckdb, "--recompute-timeout", str(timeout_s)],
                       capture_output=True, text=True, env=env, cwd=tmp)
    out = r.stdout
    expected = None if per_file is None else 1 + per_file * len(files)
    m = re.search(r"recompute checks: (\d+)", out)
    checks = int(m.group(1)) if m else None
    res = {"status": {f: "same" for f in files}, "note": "", "reasons": {}, "checks": checks, "expected_checks": expected}

    def all_cnr(note):
        res["status"] = {f: "could-not-run" for f in files}
        res["note"] = note
        return res

    if "artifact integrity: PASS" not in out:
        return all_cnr("integrity check failed or did not run, so the product skipped the recompute")
    if "SQL recompute:" not in out:
        return all_cnr("the product printed no recompute result")
    marked = 0
    for line in out.splitlines():
        mm = re.match(r"FAIL\s+(.*)", line)
        if not mm:
            continue
        msg = mm.group(1)
        hit = re.search(r"computations/([^/\s:]+\.json)", msg)
        if hit and hit.group(1) in res["status"]:
            different = msg.startswith(DIFFERENT)
            res["status"][hit.group(1)] = "different" if different else "could-not-run"
            marked += 1
            if not different:
                k = reason_of(msg)
                res["reasons"][k] = res["reasons"].get(k, 0) + 1
        elif "recompute" in msg:  # a recompute failure that names no file: do not call anything "same"
            return all_cnr("a recompute failure named no file")
    if "SQL recompute: PASS" in out:
        if expected is not None and checks != expected:  # positive evidence: PASS alone is not enough
            return all_cnr(f"SQL recompute PASS but the check count is {checks}, expected {expected}")
    elif marked == 0:  # FAIL shown but no file marked
        return all_cnr("SQL recompute FAIL but no file was marked")
    return res


def classify(run, news, duckdb, tmp, timeout_s=30, per_file=None):
    """-> ({file: same|different|could-not-run}, note)."""
    res = run_product(run, news, duckdb, tmp, timeout_s, per_file)
    return res["status"], res["note"]


def canary(news, duckdb, tmp, canary_dir):
    """The product on the known-good archive must give 100% same. -> (ok, per_file, note); per_file = checks one file adds (measured, not assumed)."""
    if not os.path.isdir(os.path.join(canary_dir, "computations")):
        return False, None, "the canary archive is missing"
    n = len(load_files(canary_dir))
    r = run_product(canary_dir, news, duckdb, tmp, 30, per_file=None)  # first pass learns the checks per file
    ns = sum(1 for v in r["status"].values() if v == "same")
    if not n or ns != n or r["note"]:
        return False, None, f"the canary was not 100% same ({ns} of {n})" + (f": {r['note']}" if r["note"] else "")
    c = r["checks"]
    if c is None or (c - 1) % n or (c - 1) // n < 1:
        return False, None, f"the canary check count {c} does not fit 1 + k x {n}"
    per_file = (c - 1) // n
    r2 = run_product(canary_dir, news, duckdb, tmp, 30, per_file)  # second pass: positive evidence with the learned count
    if r2["note"] or any(v != "same" for v in r2["status"].values()):
        return False, None, "the canary was not 100% same on the second pass: " + r2["note"]
    return True, per_file, ""


def recheck_run(run, news, duckdb, tmp, canary_dir):
    """-> the record measure_arm writes as recheck.json: per-file status (file names only), counts, a note, the could-not-run reasons, whether this is an
    environment problem (never a bad-file stop), the binaries and the DuckDB version."""
    rec = {"files": {}, "counts": {"files": 0, "same": 0, "different": 0, "could-not-run": 0}, "note": "", "reasons": {}, "env_problem": False,
           "news_binary_sha256": L.sha_file(news), "duckdb_binary_sha256": L.sha_file(duckdb) if os.path.isfile(duckdb) else None, "duckdb_version": None}
    ok, version, note = preflight(duckdb)
    rec["duckdb_version"] = version
    if not ok:
        rec.update(env_problem=True, note="ENV-PROBLEM pre-flight: " + note)
        return rec
    ok, per_file, note = canary(news, duckdb, tmp, canary_dir)
    if not ok:
        rec.update(env_problem=True, note="ENV-PROBLEM canary: " + note)
        return rec
    res = run_product(run, news, duckdb, tmp, 30, per_file)
    status = res["status"]
    counts = {k: sum(1 for v in status.values() if v == k) for k in ("same", "different", "could-not-run")}
    counts["files"] = len(status)
    rec.update(files=status, counts=counts, note=res["note"], reasons=res["reasons"], checks=res["checks"], expected_checks=res["expected_checks"])
    if counts["could-not-run"] and not counts["different"] and not res["note"] and set(res["reasons"]) <= set(ENV_REASONS) and sum(res["reasons"].values()) == counts["could-not-run"]:
        rec.update(env_problem=True, note="ENV-PROBLEM: every could-not-run file failed to execute or timed out")
    return rec


def report(label, status):
    for f, s in status.items():
        print(f"{label} {f[:12]} {s}")
    n = {k: sum(1 for v in status.values() if v == k) for k in ("same", "different", "could-not-run")}
    print(f"{label} counts: files {len(status)}, same {n['same']}, different {n['different']}, could-not-run {n['could-not-run']}")
    return n


def pairing(run_a, run_b):
    def keyed(run):
        k = {}
        files = load_files(run)
        for f, c in files.items():
            k.setdefault(pair_key(c), []).append((c.get("result_hash"), rows_hash(c)))
        return k, len(files)
    ka, na = keyed(run_a)
    kb, nb = keyed(run_b)
    same = diff = 0
    for k in set(ka) & set(kb):
        if set(ka[k]) == set(kb[k]):  # result_hash and the stored-rows hash both
            same += 1
        else:
            diff += 1
    return {"paired_same": same, "paired_different": diff, "unpaired_a": len(set(ka) - set(kb)), "unpaired_b": len(set(kb) - set(ka)),
            "unit": "keys", "files_a": na, "files_b": nb, "keys_a": len(ka), "keys_b": len(kb)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run")
    ap.add_argument("--arm-dir")
    ap.add_argument("--other-run")
    ap.add_argument("--other-arm-dir")
    ap.add_argument("--news-bin", required=True)
    ap.add_argument("--duckdb-bin", required=True)
    ap.add_argument("--tmp", required=True)
    ap.add_argument("--canary-dir", required=True)
    a = ap.parse_args(argv)
    run = a.run or (L.find_run(a.arm_dir) if a.arm_dir else None)
    other = a.other_run or (L.find_run(a.other_arm_dir) if a.other_arm_dir else None)
    if not run or not os.path.isdir(run) or not os.path.isfile(a.news_bin) or not os.path.isdir(a.tmp):
        print("BAD INPUT: run folder, news binary or tmp missing")
        return 4
    os.makedirs(a.tmp, exist_ok=True)
    ok, version, note = preflight(a.duckdb_bin)
    if not ok:
        print("ENV-PROBLEM pre-flight:", note)
        return ENV_PROBLEM_EXIT
    print("DuckDB version:", version)
    ok, per_file, note = canary(a.news_bin, a.duckdb_bin, a.tmp, a.canary_dir)
    if not ok:
        print("ENV-PROBLEM canary:", note)
        return ENV_PROBLEM_EXIT
    results = []
    for label, folder in (("A", run), ("B", other)):
        if not folder:
            continue
        res = run_product(folder, a.news_bin, a.duckdb_bin, a.tmp, 30, per_file)
        report(label, res["status"])
        if res["note"]:
            print(label, "note:", res["note"])
        if res["reasons"]:
            print(label, "could-not-run by reason:", json.dumps(res["reasons"], sort_keys=True))
        results.append(res)
    if any(r["reasons"] and set(r["reasons"]) <= set(ENV_REASONS) and not r["note"] and
           sum(r["reasons"].values()) == sum(1 for v in r["status"].values() if v == "could-not-run") and
           not any(v == "different" for v in r["status"].values()) for r in results):
        print("ENV-PROBLEM: every could-not-run file failed to execute or timed out")
        return ENV_PROBLEM_EXIT
    if other:
        print("pairing:", json.dumps(pairing(run, other), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
