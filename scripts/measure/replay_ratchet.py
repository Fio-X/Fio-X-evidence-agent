#!/usr/bin/env python3
"""Replay ratchet. Compares batch-end replay outputs with the baseline of the last merged batch.

Rule: per archive, model requests may only go down; runs of every check kind may only go up.
A rise in requests or a drop in any check's run count exits 1. Prints counts and check-kind names only.

  replay_ratchet.py --baseline B.json --arm forest=DIR --arm us=DIR ...        compare; exit 1 on a violation
  replay_ratchet.py --baseline B.json --arm ... --init --label TEXT            first baseline (refuses to overwrite)
  replay_ratchet.py --baseline B.json --arm ... --update --label TEXT          after a merge: compare, and only if it passes,
                                                                               write min(requests) / max(check runs) per archive
  replay_ratchet.py --baseline B.json --check-lock LOCK                        exit 1 unless sha256(B.json) is the one line in LOCK

DIR is one replay arm folder holding relay/ (req-N.json, reply-N.json) and T/out/<run>/. The counting is measure_lib's:
relay_counts for requests, check_runs for check runs. Read limits are measure_lib's. The baseline is written by this
script only (--init, --update); a hand edit is detected by the stored digest and refused.
The lock file holds the sha256 of the baseline file. Neither --init nor --update ever writes it: changing the baseline means changing the
lock too, and that is a separate, signed change. The lock guards the baseline file, not the replays; the replays only run on a machine that has them.
"""
import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I does not add the script folder
import measure_lib  # noqa: E402


def count_arm(arm_dir):
    """{"requests": n, "checks": {kind: runs}} for one replay arm folder."""
    relay = os.path.join(arm_dir, "relay")
    counts = measure_lib.relay_counts(relay)
    run = measure_lib.find_run(arm_dir)
    if run is None:
        raise SystemExit(f"no run folder under {os.path.basename(arm_dir)}/T/out")
    counts.update(measure_lib.run_counts(run))
    return {"requests": counts["turns"], "checks": dict(sorted(measure_lib.check_runs(counts).items()))}


def compare(base, now):
    """Rows per archive plus the list of violations. base/now: {archive: {"requests", "checks"}}."""
    rows, bad = [], []
    for name in sorted(set(base) | set(now)):
        if name not in now:
            bad.append((name, "archive", "missing from this replay"))
            continue
        if name not in base:
            rows.append((name, None, now[name]["requests"], {}))  # a new archive has nothing to ratchet against yet
            continue
        b, n = base[name], now[name]
        if n["requests"] > b["requests"]:
            bad.append((name, "requests", f"{b['requests']} -> {n['requests']}"))
        kinds = {}
        for kind in sorted(set(b["checks"]) | set(n["checks"])):
            was, is_ = b["checks"].get(kind, 0), n["checks"].get(kind, 0)
            kinds[kind] = (was, is_)
            if is_ < was:
                bad.append((name, kind, f"{was} -> {is_}"))
        rows.append((name, b["requests"], n["requests"], kinds))
    return rows, bad


def digest(archives):
    return hashlib.sha256(json.dumps(archives, sort_keys=True).encode()).hexdigest()


def load_baseline(path):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("digest") != digest(data.get("archives")):
        raise SystemExit("baseline digest mismatch: the file was edited by hand; refusing to use it")
    return data


def file_sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def check_lock(baseline, lock):
    """-> (ok, message). The lock is one line: the sha256 of the baseline file."""
    try:
        with open(lock, encoding="utf-8") as handle:
            locked = handle.read().strip()
    except OSError:
        return False, "the lock file cannot be read"
    if not os.path.isfile(baseline):
        return False, "the baseline file is missing"
    if file_sha256(baseline) != locked:
        return False, "the baseline file does not match its lock"
    return True, "baseline matches its lock"


def write_baseline(path, label, archives):
    data = {"label": label, "archives": archives, "digest": digest(archives)}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=1, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)


def tightened(base, now):
    """The new baseline after a passing compare: requests never up, each check's runs never down."""
    out = {}
    for name in set(base) | set(now):
        if name not in now:
            out[name] = base[name]
        elif name not in base:
            out[name] = now[name]
        else:
            kinds = set(base[name]["checks"]) | set(now[name]["checks"])
            out[name] = {"requests": min(base[name]["requests"], now[name]["requests"]),
                         "checks": {k: max(base[name]["checks"].get(k, 0), now[name]["checks"].get(k, 0)) for k in sorted(kinds)}}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--arm", action="append", default=[], metavar="ARCHIVE=DIR")
    ap.add_argument("--init", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--label", default="")
    ap.add_argument("--check-lock", metavar="LOCK")
    args = ap.parse_args(argv)
    if args.check_lock:
        ok, message = check_lock(args.baseline, args.check_lock)
        print(("LOCK OK: " if ok else "LOCK FAIL: ") + message)
        return 0 if ok else 1
    if args.init or args.update:
        if args.baseline.endswith(".lock"):
            raise SystemExit("the baseline path is a lock file; refusing")
    now = {}
    for item in args.arm:
        name, _, folder = item.partition("=")
        now[name] = count_arm(folder)
    if args.init:
        if os.path.exists(args.baseline):
            raise SystemExit("baseline exists; --init never overwrites (use --update after a passing compare)")
        write_baseline(args.baseline, args.label, now)
        for name in sorted(now):
            print(f"{name}: requests {now[name]['requests']}, check kinds {len(now[name]['checks'])}")
        print("baseline written")
        return 0
    data = load_baseline(args.baseline)
    rows, bad = compare(data["archives"], now)
    for name, b, n, kinds in rows:
        print(f"{name}: requests {b if b is not None else 'new'} -> {n}")
        for kind, (was, is_) in kinds.items():
            print(f"    {kind}: {was} -> {is_}{'  <-- FELL' if is_ < was else ''}")
    for name, what, detail in bad:
        print(f"VIOLATION {name} {what}: {detail}")
    print("RATCHET FAIL" if bad else "RATCHET OK")
    if bad:
        return 1
    if args.update:
        write_baseline(args.baseline, args.label or data.get("label", ""), tightened(data["archives"], now))
        print("baseline tightened")
    return 0


if __name__ == "__main__":
    sys.exit(main())
