#!/usr/bin/env python3
"""Build a proposed `handoffs.rust` from observed-hand-off records (NEWSROOM_GROUP_HANDOFF_OBSERVE=1 runs).

usage: gen_handoffs_rust.py RECORD_OR_RUN_DIR [...] --out FILE [--groups runtime/pi/groups.json]

Each argument is a `runtime/handoff-observed.jsonl` file, a run folder holding one, or an out folder (its own log plus each run folder's). The union over all runs is taken: a (writer, group,
command) triple seen listed or unlisted in any run becomes a row entry. The proposal goes to FILE for a human to read; this script never
writes groups.json (it refuses that target). Rows are sorted, so the same records always give the same bytes.
`not_owned` lines are only counted: the first gate refuses them whatever the table says.
"""
import argparse
import glob
import json
import os
import sys

LOG = os.path.join("runtime", "handoff-observed.jsonl")
KEPT = ("as", "why", "remove_when")


def read_records(args):
    out = []
    paths = []
    for arg in args:
        if os.path.isdir(arg):
            # a run folder, or an out folder: its own log (the root's mkdir) and the log of each run folder under it
            paths += [p for p in [os.path.join(arg, LOG)] + sorted(glob.glob(os.path.join(arg, "*", LOG))) if os.path.exists(p)]
        else:
            paths.append(arg)
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            for number, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except ValueError:
                    raise SystemExit(f"{path}:{number}: not JSON")
    return out


def build(records, current_rows):
    seen = {}
    refused = {}
    for rec in records:
        key = (rec["writer"], rec["group"])
        if rec["decision"] == "not_owned":
            refused[key + (rec["command"],)] = refused.get(key + (rec["command"],), 0) + 1
        elif rec["decision"] in ("listed", "unlisted"):
            counts = seen.setdefault(key, {})
            counts[rec["command"]] = counts.get(rec["command"], 0) + 1
    current = {(r["writer"], r["group"]): r for r in current_rows}
    rows = []
    for (writer, group) in sorted(seen):
        row = {"writer": writer, "group": group}
        for field in KEPT:
            if field in current.get((writer, group), {}):
                row[field] = current[(writer, group)][field]
        row["commands"] = sorted(seen[(writer, group)])
        row["not_measured"] = []
        row["seen"] = {c: seen[(writer, group)][c] for c in row["commands"]}
        rows.append(row)
    not_seen = []
    not_in_current = []
    for (writer, group), row in sorted(current.items()):
        got = set(seen.get((writer, group), {}))
        for command in sorted(set(row["commands"]) - got):
            not_seen.append({"writer": writer, "group": group, "command": command})
    for (writer, group), counts in sorted(seen.items()):
        have = set(current.get((writer, group), {}).get("commands", []))
        for command in sorted(set(counts) - have):
            not_in_current.append({"writer": writer, "group": group, "command": command})
    return {
        "rust": rows,
        "not_seen": not_seen,
        "not_in_current": not_in_current,
        "refused_not_owned": [
            {"writer": w, "group": g, "command": c, "count": n} for (w, g, c), n in sorted(refused.items())
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("records", nargs="+")
    parser.add_argument("--out", required=True)
    parser.add_argument("--groups", default=os.path.join("runtime", "pi", "groups.json"))
    ns = parser.parse_args(argv)
    if os.path.basename(ns.out) == "groups.json" or os.path.realpath(ns.out) == os.path.realpath(ns.groups):
        raise SystemExit("refusing to write groups.json; the proposal is for a human to read and copy")
    with open(ns.groups, encoding="utf-8") as handle:
        current = json.load(handle)["handoffs"]["rust"]
    result = build(read_records(ns.records), current)
    with open(ns.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2, sort_keys=True, ensure_ascii=False)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
