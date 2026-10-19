"""Speed estimate for measured runs. Advisory only: it prints a verdict and exits 0; nothing in the measure tools uses program_s (or this verdict) as a gate.

estimated_seconds = round(program_s + round_trips * TRIP_S + (model_written_bytes / BYTES_PER_TOKEN) / TOKENS_PER_S)   # whole seconds, Python round(), as the ledger prints
round_trips = the number of reply files (injected error replies included); a gap in the numbering or a missing req-N makes it None, so the estimate is INCOMPLETE.
These are the pre-registered figures (run_ledger.py: 6.6 s per request, 89 tokens/s fitted, 2.94 bytes per token).

The constants come from one relay, one model and one day; the sample count was not recorded, so they need recalibrating. A back-test on one earlier topic differed by
+1.9%, but the constants were fitted on it, so that is not an independent check. This tool measures itself; it is not an outside verification.

Run: python3 -I scripts/measure/estimate.py MEASURE_DIR   (every sub-folder of MEASURE_DIR is a run; there is no way to pass a subset)
"""
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import measure_lib as L  # noqa: E402

TRIP_S, TOKENS_PER_S, BYTES_PER_TOKEN, PASS_FIRST3, FAIL_ABOVE, PASS_ALL5 = 6.6, 89, 2.94, 115, 155, 135
CONSTANTS = (TRIP_S, TOKENS_PER_S, BYTES_PER_TOKEN, PASS_FIRST3, FAIL_ABOVE, PASS_ALL5)
SELF_REPORT_TOLERANCE = 0.10
ADVISORY = "advisory only: constants not recalibrated (one relay, one model, one day; sample count not recorded); no gate uses this verdict"
STAMP_KEY = "_newsroom_recorded_at"
FIELDS = ("advisory", "constants", "runs_total", "runs", "order_problem", "verdict", "self_report")


def _number(x):
    return not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x) and x >= 0


def estimated_seconds(program_s, round_trips, output_bytes):
    """None (INCOMPLETE) when any input is missing or not a non-negative number; round_trips must be a whole number."""
    if not (_number(program_s) and _number(round_trips) and _number(output_bytes)) or round_trips != int(round_trips):
        return None
    return round(unrounded_seconds(program_s, round_trips, output_bytes))


def unrounded_seconds(program_s, round_trips, output_bytes):
    return program_s + round_trips * TRIP_S + (output_bytes / BYTES_PER_TOKEN) / TOKENS_PER_S


def sequential_verdict(values):
    """values: estimates of one topic/arm in run order (None = INCOMPLETE run). First matching rule wins; there is no upper limit on the number of runs.
    1 any known value > 155 -> FAIL; 2 any None -> INCOMPLETE; 3 fewer than 3 -> INCOMPLETE; 4 first 3 all <= 115 -> PASS;
    5 otherwise any value > 135 -> FAIL; 6 at least 5 values, all <= 135 -> PASS; 7 else INCOMPLETE."""
    known = [v for v in values if _number(v)]
    if any(v > FAIL_ABOVE for v in known):
        return "FAIL"
    if len(known) != len(values) or len(values) < 3:
        return "INCOMPLETE"
    if all(v <= PASS_FIRST3 for v in values[:3]):
        return "PASS"
    if any(v > PASS_ALL5 for v in values):
        return "FAIL"
    return "PASS" if len(values) >= 5 else "INCOMPLETE"


def selfreport_check(program_s, selfreported_s):
    """The product does not write a total-time field yet, so the caller passes None and this is INCOMPLETE. With a value: RED when the two differ by more than 10%."""
    if not (_number(program_s) and _number(selfreported_s)) or selfreported_s == 0:
        return "INCOMPLETE"
    return "RED" if abs(program_s - selfreported_s) / selfreported_s > SELF_REPORT_TOLERANCE else "OK"


def max_reply_check(tested, reference):
    """Largest single reply of the tested group <= the reference group's (equal passes); a missing (None) or malformed value is INCOMPLETE."""
    if not (_number(tested) and _number(reference)):
        return "INCOMPLETE"
    return "PASS" if tested <= reference else "FAIL"


def _parse_stamp(text):
    try:
        t = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def started_at(run_folder):
    """The first recorded-at stamp the product wrote into events.jsonl, or None."""
    path = os.path.join(run_folder, "events.jsonl") if run_folder else None
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            try:
                stamp = json.loads(line).get(STAMP_KEY)
            except (ValueError, AttributeError):
                continue
            if stamp is not None:
                return _parse_stamp(stamp)
    return None


def enumerate_runs(measure_dir):
    """Every non-hidden sub-folder of measure_dir, as {id, started_at, estimated_seconds}; a folder without a usable counts.json is still a run, with no estimate."""
    runs = []
    for name in sorted(os.listdir(measure_dir)):
        folder = os.path.join(measure_dir, name)
        if name.startswith(".") or not os.path.isdir(folder):
            continue
        counts = None
        path = os.path.join(folder, "counts.json")
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as handle:
                    counts = json.load(handle)
            except ValueError:
                counts = None
        counts = counts if isinstance(counts, dict) else {}
        args = (counts.get("program_s"), counts.get("round_trips"), counts.get("model_written_bytes"))
        est = estimated_seconds(*args)
        raw = unrounded_seconds(*args) if est is not None else None
        runs.append({"id": name, "started_at": started_at(L.find_run(folder) if os.path.isdir(os.path.join(folder, "T", "out")) else None),
                     "estimated_seconds": est, "estimated_seconds_unrounded": raw})
    return runs


def build_report(runs):
    """runs: list of {id, started_at (datetime or None), estimated_seconds}. Orders them by start time; a missing or tied start time makes the verdict INCOMPLETE."""
    problem = None
    if any(r["started_at"] is None for r in runs):
        problem = "a run has no start time"
    elif len({r["started_at"] for r in runs}) != len(runs):
        problem = "two runs have the same start time"
    ordered = sorted(runs, key=lambda r: r["id"]) if problem else sorted(runs, key=lambda r: r["started_at"])
    verdict = "INCOMPLETE" if problem else sequential_verdict([r["estimated_seconds"] for r in ordered])
    rows = [{"id": r["id"], "started_at": r["started_at"].isoformat() if r["started_at"] else None, "estimated_seconds": r["estimated_seconds"],
             "estimated_seconds_unrounded": r.get("estimated_seconds_unrounded"), "extra": i >= 5}
            for i, r in enumerate(ordered)]
    return {"advisory": ADVISORY, "constants": list(CONSTANTS), "runs_total": len(rows), "runs": rows, "order_problem": problem, "verdict": verdict,
            "self_report": "INCOMPLETE (the product does not report this number yet)"}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or not os.path.isdir(argv[0]):
        print("usage: estimate.py MEASURE_DIR", file=sys.stderr)
        return 2
    report = build_report(enumerate_runs(argv[0]))
    print(f"speed estimate ({report['advisory']})")
    print(f"runs: {report['runs_total']}" + (f"; {report['order_problem']}" if report["order_problem"] else ""))
    for r in report["runs"]:
        print(f"  {r['id']} | started {r['started_at']} | estimated {r['estimated_seconds']}s" + (" | extra" if r["extra"] else ""))
    print(f"sequential verdict (advisory): {report['verdict']}; self-report check: {report['self_report']}")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
