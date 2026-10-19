#!/usr/bin/env python3
"""Compare two arm folders made by measure_arm.py (same topic): audit text, sha256 lists, stop rules, rule-5 verdict for 8 vs 3.

usage: python3 -I compare_runs.py --a ARM_A_DIR --b OTHER_DIR --arm B|C3|R [--check-rule literal|coverage]
       python3 -I compare_runs.py --single ARM_DIR     (right after a run ends; prints news_exit, final_result, profile yes/no;
                                                         exit 0 only if completion reached and the visual-story profile is recorded, else 1 with the rule name)
--check-rule (default literal, kept as the default): literal = a check tool with fewer total calls than in A stops; coverage = only a check tool that never ran
in the other run, or completion not reached, stops (completion reached = the product exited 0 on the final attempt: gate without gaps and VERIFIED).
The per-kind refusal rise is report-only in both modes. The C3 verdict rule: completion reached, no correctness stop (provider, data, recheck, pairing,
environment), turns <= A, total refusals <= A; every other signal is printed beside it.
Writes OTHER_DIR/compare-vs-A.json and OTHER_DIR/compare-vs-A.audit.txt; prints one status line and the stop rules (counts and names only).
Exit 0: no stop rule fired; 2: at least one fired. Reads only what measure_lib.py allows."""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I does not add the script folder
import measure_lib as L
import recheck_computations as R


PREVIEW_LINE = "preview and page images: report-only (each stand-in page differs; there is no same-page reference in a live run)"


def single(folder):
    c = json.load(open(os.path.join(folder, "counts.json")))
    run = L.find_run(folder)
    profile = L.profile_recorded(run)
    print(f"news_exit {c.get('news_exit')}, final_result {c.get('final_result')}, visual-story profile recorded: {'yes' if profile else 'no'}")
    print(f"downloads_total {c.get('downloads_total', 'not recorded')}, downloads_outside_frozen {c.get('downloads_outside_frozen', 'not recorded')} (report-only)")
    if not L.completion_reached(c):
        print("STOP: completion_not_reached")
        return 1
    if not profile:
        print("STOP: profile_not_recorded")
        return 1
    print("completion reached, profile recorded")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--single")
    ap.add_argument("--a")
    ap.add_argument("--b")
    ap.add_argument("--arm", choices=("B", "C3", "R"))
    ap.add_argument("--check-rule", choices=("literal", "coverage"), default="literal")
    args = ap.parse_args(argv)
    if args.single:
        return single(args.single)
    if not (args.a and args.b and args.arm):
        ap.error("--a, --b and --arm are required without --single")
    ca, cb = (json.load(open(os.path.join(d, "counts.json"))) for d in (args.a, args.b))
    ra, rb = L.find_run(args.a), L.find_run(args.b)
    if not ra or not rb:
        print("STOP: a run folder is missing")
        return 2
    audit = L.run_audit(os.path.basename(args.b.rstrip("/")), ra, rb)
    shas = L.sha_compare(ra, rb)
    ka = L.request_key_names(os.path.join(args.a, "relay"), 1, "tools")
    kb = L.request_key_names(os.path.join(args.b, "relay"), 1, "tools")
    trim_evidence = all(f in ka and f not in kb for f in L.TRIM_FIELDS)
    harness_a = json.load(open(os.path.join(args.a, "harness.json"))) if os.path.isfile(os.path.join(args.a, "harness.json")) else {}
    harness_b = json.load(open(os.path.join(args.b, "harness.json")))
    # an arm run without the sandbox is a self-test of the tooling: its numbers are never evidence
    counts_as_evidence = not (harness_a.get("self_test_only") or harness_b.get("self_test_only"))
    provider_seen = bool(harness_b.get("provider_signs"))
    recheck = {"pairing": R.pairing(ra, rb)}
    for side, folder in (("a", args.a), ("b", args.b)):
        path = os.path.join(folder, "recheck.json")
        if os.path.isfile(path):
            recheck[side] = json.load(open(path))
    stops, reported = L.evaluate(ca, cb, shas, trim_evidence, provider_seen, args.arm, recheck, args.check_rule)
    refusals = lambda c: sum((c.get("boundary_refusals_by_kind") or {}).values())
    verdict = {"turns_a": ca["turns"], "turns_other": cb["turns"], "refusals_a": refusals(ca), "refusals_other": refusals(cb),
               "no_more_turns": cb["turns"] <= ca["turns"], "no_more_refusals": refusals(cb) <= refusals(ca)}
    verdict["completion_reached_a"], verdict["completion_reached_other"] = L.completion_reached(ca), L.completion_reached(cb)
    # a comparison against an A that did not complete is not valid; the verdict also needs A's completion
    correctness = [s for s in stops if s["rule"] in L.CORRECTNESS_RULES]
    if args.arm == "C3":
        verdict["fix_at_3_candidate"] = verdict["completion_reached_a"] and verdict["completion_reached_other"] and not correctness and verdict["no_more_turns"] and verdict["no_more_refusals"]
        verdict["note"] = "both pages go to a human reviewer either way; the reviewer's eye decides"
        verdict["other_signals"] = [s for s in stops if s["rule"] not in L.CORRECTNESS_RULES] + reported  # shown beside the verdict, never inside it
    if not counts_as_evidence:
        verdict["fix_at_3_candidate"] = False
    table = L.check_table(ca, cb, L.refused_by_tool(os.path.join(args.a, "relay")), L.refused_by_tool(os.path.join(args.b, "relay")))
    out = {"counts_as_evidence": counts_as_evidence, "arm": args.arm, "check_rule": args.check_rule, "stops": stops, "reported": reported, "check_table": table,
           "preview_and_page_images": PREVIEW_LINE, "sha_compare": shas, "computation_sha_is_report_only": True,
           "recheck": {s: recheck[s]["counts"] for s in ("a", "b") if s in recheck}, "pairing": recheck["pairing"], "trim_field_evidence": trim_evidence, "verdict": verdict}
    with open(os.path.join(args.b, "compare-vs-A.json"), "w", encoding="utf-8") as h:
        json.dump(out, h, indent=1, ensure_ascii=False)
    with open(os.path.join(args.b, "compare-vs-A.audit.txt"), "w", encoding="utf-8") as h:
        h.write(audit)
    print(("STOP: " + "; ".join(f"{s['rule']} ({s['detail']})" for s in stops)) if stops else "no stop rule fired")
    print(PREVIEW_LINE)
    if not counts_as_evidence:
        print("DOES NOT COUNT: an arm was run without the sandbox (self-test only)")
    for r in reported:
        print(f"reported: {r['rule']} ({r['detail']})")
    if args.check_rule == "coverage":
        for name, t in table.items():
            print(f"check {name}: calls A {t['calls_a']} / other {t['calls_b']}; refused A {t['refused_a']} / other {t['refused_b']}")
    if args.arm == "C3":
        print("C3 verdict: " + ("candidate: fix at 3" if verdict["fix_at_3_candidate"] else "not a candidate") + "; completion reached "
              f"A {verdict['completion_reached_a']} / other {verdict['completion_reached_other']}"
              + ("" if verdict["completion_reached_a"] else " (A did not complete: comparison not valid)") + f", turns {verdict['turns_other']} vs {verdict['turns_a']}, refusals {verdict['refusals_other']} vs {verdict['refusals_a']}")
    return 2 if stops else 0


if __name__ == "__main__":
    sys.exit(main())
