"""Measurement harness: counting, comparison and stop rules for runs of the investigate command.

Read limits: the relay folder is read for counts only. A run folder is read in exactly these ways:
  * events.jsonl, runtime/tool-chain-events.jsonl, runtime/boundary-refusals.jsonl: one JSON field per line (`type`, `toolName`, `kind`),
    counted; nothing else of a line is kept;
  * files under infographics/ publications/ visualizations/ maps/ computations/ data/: sha256 of the bytes, never printed as text;
  * runtime run-metrics.jsonl: one JSON field per line, `tool_profile`, compared with "visual-story"; yes or no only;
  * run_audit.py (shapes, class numbers, key names, counts, cmp results), run in this process so the same guard sees it.
Everything else is never opened: session, meta, conversation, prompt, claims, story, config, auth, .env, home, xdg, private and anything under them.
Nothing here prints file contents.
"""
import builtins
import collections
import hashlib
import io
import json
import os
import re
import runpy
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HASH_DIRS = ("infographics", "publications", "visualizations", "maps", "computations", "data")
EVENT_FILES = ("events.jsonl", "runtime/tool-chain-events.jsonl")
REFUSAL_FILE = "runtime/boundary-refusals.jsonl"
# a path segment that starts with one of these names is denied (meta.json, session.json, story.md, prompt.txt too); over-denying only skips a hash
DENY = re.compile(r"(^|/)(home|xdg|config|private|session|agent-session|meta|conversation|prompt|claims|story|auth|\.env)[^/]*(/|$)")
COMPLETION_SKIP = "completion_retry_skipped"
TRIM_FIELDS = ("counterintuitive_findings", "human_scale_refs", "temporal_dimensions", "uncertainties")
CHECK_SUFFIX = ("_lint", "_critic", "_validate", "_preview", "_render", "_qa", "_preflight", "_ocr_check")
CHAIN_TOOLS = ("newsroom_infographic_chain", "newsroom_viz_chain", "newsroom_infographic_chain_patch")


def is_denied(rel):
    return bool(DENY.search(rel.replace(os.sep, "/")))


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def is_check_tool(name):
    return name.endswith(CHECK_SUFFIX) or name == "newsroom_infographic_vision_critic"


# ---------------------------------------------------------------- relay folder (counts only)
def relay_counts(relay):
    reqs = sorted(int(m.group(1)) for f in os.listdir(relay) if (m := re.fullmatch(r"req-(\d+)\.json", f)))
    tools, model_bytes, injected = collections.Counter(), 0, 0
    biggest, reply_gap = None, False
    for n in range(1, (reqs[-1] if reqs else 0) + 1):
        path = os.path.join(relay, f"reply-{n}.json")
        if not os.path.isfile(path):
            reply_gap = True
            continue
        with open(path, encoding="utf-8") as handle:
            reply = json.load(handle)
        if reply.get("error"):
            injected += 1
        calls = reply.get("tool_calls") or []
        content = {k: reply[k] for k in ("thinking", "text", "tool_calls") if k in reply}
        size = len(json.dumps(content, ensure_ascii=False).encode("utf-8"))
        model_bytes += size
        biggest = size if biggest is None else max(biggest, size)
        for call in calls:
            tools[call.get("name", "?")] += 1
    is_error = None
    if reqs:
        with open(os.path.join(relay, f"req-{reqs[-1]}.json"), encoding="utf-8") as handle:
            last = json.load(handle)
        is_error = 0
        for message in last.get("messages") or []:
            content = message.get("content")
            if isinstance(content, list):
                is_error += sum(1 for b in content if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error") is True)
    return {"turns": len(reqs) - injected, "injected_error_replies": injected, "tool_calls_by_tool": dict(sorted(tools.items())),
            "tool_calls": sum(tools.values()), "model_written_bytes": model_bytes, "is_error_last_request": is_error,
            # added for the speed estimate: the same count as turns, and the largest single reply (None, never 0, when no reply file exists or one is missing)
            "round_trips": len(reqs) - injected, "max_reply_bytes": None if (biggest is None or reply_gap) else biggest}


def request_key_names(relay, n, top):
    """Key names (never values) found under the top-level key `top` of req-<n>.json."""
    with open(os.path.join(relay, f"req-{n}.json"), encoding="utf-8") as handle:
        req = json.load(handle)
    names = set()

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                names.add(k)
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(req.get(top))
    return names


def relay_summary(relay_script, relay):
    done = subprocess.run([sys.executable, "-I", relay_script, "--summary", relay], capture_output=True, text=True, timeout=60)
    if done.returncode != 0:
        raise RuntimeError("relay --summary failed")
    return json.loads(done.stdout)


# ---------------------------------------------------------------- run folder (whitelisted fields only)
def _field_counts(run, rel, field, extra=None):
    path = os.path.join(run, rel)
    if is_denied(rel) or not os.path.isfile(path):
        return None
    by, by_tool = collections.Counter(), collections.Counter()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            by[str(record.get(field))] += 1
            if extra and record.get(field) == extra[0]:
                by_tool[str(record.get(extra[1]))] += 1
    return by, by_tool


def run_counts(run):
    out = {"events_by_type": {}, "chain_events_by_type": {}, "chain_inner_tool_runs": {}, "boundary_refusals_by_kind": None, "event_files_missing": []}
    for rel in EVENT_FILES:
        got = _field_counts(run, rel, "type", extra=("tool_execution_end", "toolName"))
        if got is None:
            out["event_files_missing"].append(rel)
            continue
        by, by_tool = got
        if rel == "events.jsonl":
            out["events_by_type"] = dict(sorted(by.items()))
        else:
            out["chain_events_by_type"] = dict(sorted(by.items()))
            out["chain_inner_tool_runs"] = dict(sorted(by_tool.items()))
    got = _field_counts(run, REFUSAL_FILE, "kind")
    out["boundary_refusals_by_kind"] = dict(sorted(got[0].items())) if got else {}  # a missing file means no refusal was recorded
    return out


def hash_lists(run):
    """{dir: sorted [ (relative shape name, sha256) ]}; names containing a 64-hex part keep it (they are content names)."""
    result = {}
    for d in HASH_DIRS:
        rows = []
        base = os.path.join(run, d)
        for root, dirs, files in os.walk(base):
            dirs[:] = [x for x in dirs if not is_denied(os.path.relpath(os.path.join(root, x), run))]
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), run)
                if is_denied(rel):
                    continue
                rows.append((rel, sha_file(os.path.join(run, rel))))
        result[d] = sorted(rows)
    return result


def find_run(arm_dir):
    out = os.path.join(arm_dir, "T", "out")
    runs = [os.path.join(out, d) for d in os.listdir(out) if os.path.isdir(os.path.join(out, d))]
    return max(runs, key=os.path.getmtime) if runs else None


def build_counts(arm_dir, relay_script, wall_s):
    relay = os.path.join(arm_dir, "relay")
    counts = relay_counts(relay)
    summary = relay_summary(relay_script, relay)
    counts.update(summary)
    counts["wall_s"] = round(wall_s, 3)
    wait = summary.get("standin_wait_s")
    if isinstance(wait, bool) or not isinstance(wait, (int, float)) or wait != wait or wait < 0:
        # no usable stand-in wait: the program share cannot be told, so the measurement is INCOMPLETE (never counted as 0, never a crash)
        counts["program_s"] = None
        counts["measurement_status"] = "INCOMPLETE"
        counts["incomplete_reason"] = "standin_wait_s missing or not a number"
    else:
        counts["program_s"] = round(wall_s - wait, 3)
        counts["measurement_status"] = "COMPLETE"
    run = find_run(arm_dir)
    counts["run_folder_found"] = bool(run)
    if run:
        counts.update(run_counts(run))
    return counts


def table_line(label, c):
    skip = (c.get("events_by_type") or {}).get(COMPLETION_SKIP, 0)
    refusals = sum((c.get("boundary_refusals_by_kind") or {}).values())
    return (f"{label} | turns {c['turns']} | tool calls {c['tool_calls']} | model-written bytes {c['model_written_bytes']} | is_error(last) {c['is_error_last_request']} | "
            f"boundary refusals {refusals} | completion skips {skip} | wall {c['wall_s']}s | stand-in wait {c.get('standin_wait_s')}s | "
            f"between turns {c.get('between_turns_s')}s | relay overhead {c.get('relay_overhead_s')}s | "
            + ("program INCOMPLETE" if c.get("program_s") is None else f"program {c['program_s']}s"))


# ---------------------------------------------------------------- comparison of two runs
def run_audit(label, saved, replay):
    """run_audit.py in this process, behind a guard: os.walk skips deny-listed names under the two run folders and open() refuses them.
    Returns its printed text: shapes, class numbers, key names, counts, cmp."""
    roots = tuple(os.path.abspath(r) for r in (saved, replay))

    def denied(path):
        p = os.path.abspath(path) if isinstance(path, (str, os.PathLike)) else None
        for root in roots:
            if p and (p == root or p.startswith(root + os.sep)):
                return is_denied(os.path.relpath(p, root))
        return False

    real_open, real_walk = builtins.open, os.walk

    def guarded_open(file, *a, **k):
        if denied(file):
            raise PermissionError("deny-listed name")
        return real_open(file, *a, **k)

    def guarded_walk(top, *a, **k):
        for root, dirs, files in real_walk(top, *a, **k):
            dirs[:] = [d for d in dirs if not denied(os.path.join(root, d))]
            yield root, dirs, [f for f in files if not denied(os.path.join(root, f))]

    buf, old_argv, old_out = io.StringIO(), sys.argv, sys.stdout
    sys.argv = [os.path.join(HERE, "run_audit.py"), label, saved, replay]
    sys.stdout = buf
    builtins.open, os.walk = guarded_open, guarded_walk
    try:
        runpy.run_path(os.path.join(HERE, "run_audit.py"), run_name="__main__")
    except SystemExit:
        pass
    except Exception as error:  # a file the audit cannot parse must not hide the stop rules; its text says so
        buf.write(f"AUDIT FAILED: {error.__class__.__name__}\n")
    finally:
        builtins.open, os.walk = real_open, real_walk
        sys.argv, sys.stdout = old_argv, old_out
    return buf.getvalue()


def sha_compare(a_run, b_run):
    a, b = hash_lists(a_run), hash_lists(b_run)
    out = {}
    for d in HASH_DIRS:
        sa, sb = {s for _, s in a[d]}, {s for _, s in b[d]}
        out[d] = {"a_files": len(a[d]), "b_files": len(b[d]), "a_only_sha": len(sa - sb), "b_only_sha": len(sb - sa), "equal": sa == sb}
    return out


def completion_reached(counts):
    """The product's own completion, from what the harness records. `news investigate` exits 0 only when the completion gate left no gaps
    (src/commands/investigate.rs: `bail!("visual delivery incomplete: ...")` ends in exit 2 through verify.rs `exit_on_error`) AND the post-run check
    printed VERIFIED (verify.rs `announce_verdict` / `exit_if_not_verified`: not verified = exit 1). So reached = exit 0 on the final attempt that ended
    by itself. Exit 1 (gate passed, not verified) and exit 2 (gate gaps, or an error) are both "not reached"; the records alone cannot tell the
    latter two apart, and this function does not try."""
    return counts.get("news_exit") == 0 and counts.get("final_result") == "exited"


def profile_recorded(run, profile="visual-story"):
    """Does the run's events.jsonl carry a `newsroom_rpc_metrics` event whose `tool_profile` equals the profile? (run-metrics.jsonl
    never has the key, so it is not read for this.) Reads those two fields per line; returns True/False only."""
    path = os.path.join(run, "events.jsonl") if run else ""
    if not path or not os.path.isfile(path):
        return False
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get("type") == "newsroom_rpc_metrics" and row.get("tool_profile") == profile:
                return True
    return False


def refused_by_tool(relay):
    """{tool name: refused calls} from the relay structure only: tool_result blocks with is_error true in the LAST request (it carries the whole
    history), named through the tool_use ids of the assistant turns. Reads req-N.json only, prints nothing."""
    reqs = sorted(int(m.group(1)) for f in os.listdir(relay) if (m := re.fullmatch(r"req-(\d+)\.json", f)))
    if not reqs:
        return {}
    with open(os.path.join(relay, f"req-{reqs[-1]}.json"), encoding="utf-8") as handle:
        last = json.load(handle)
    names, out = {}, collections.Counter()
    for message in last.get("messages") or []:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                names[b.get("id")] = b.get("name", "?")
            elif isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error") is True:
                out[names.get(b.get("tool_use_id"), "?")] += 1
    return dict(sorted(out.items()))


def check_table(a, b, refused_a, refused_b):
    """Per check tool: total calls (direct + chain-inner + completion events, as check_runs counts them) and refused calls in A and in the other run."""
    ra, rb = check_runs(a), check_runs(b)
    return {name: {"calls_a": ra.get(name, 0), "calls_b": rb.get(name, 0), "refused_a": refused_a.get(name, 0), "refused_b": refused_b.get(name, 0)}
            for name in sorted(set(ra) | set(rb) | {n for n in set(refused_a) | set(refused_b) if is_check_tool(n)})}


# Stops that say the run's numbers or results are wrong (a verdict needs "no correctness stop"); every other stop is a signal shown beside a verdict.
CORRECTNESS_RULES = ("provider_request", "data_sha_differs", "computation_recheck_missing", "computation_recheck_not_same", "computation_paired_different",
                     "environment_problem")


def check_runs(counts):
    """{name: times it ran}: direct calls of a check tool plus the chain's inner runs of it."""
    ran = collections.Counter()
    for name, n in counts["tool_calls_by_tool"].items():
        if is_check_tool(name):
            ran[name] += n
    for name, n in (counts.get("chain_inner_tool_runs") or {}).items():
        if is_check_tool(name):
            ran[name] += n
    for typ, n in (counts.get("events_by_type") or {}).items():
        if "completion" in typ and typ != COMPLETION_SKIP:
            ran["event:" + typ] += n
    return ran


def evaluate_stops(a, b, shas, trim_evidence, provider_seen=False, arm="B", recheck=None, check_rule="literal"):
    return evaluate(a, b, shas, trim_evidence, provider_seen, arm, recheck, check_rule)[0]


def evaluate(a, b, shas, trim_evidence, provider_seen=False, arm="B", recheck=None, check_rule="literal"):
    """Stop rules for arm B (or C3 or R) against arm A of the same topic. Returns (stops, reported): lists of {rule, detail}.
    check_rule "literal" (default): a check tool with fewer total calls than in A stops (as before). "coverage": stops only for a check tool that ran in A and never
    ran in the other run (the same exceptions), and for completion not reached (only that; the is_error rise is reported). The per-kind refusal rise is in `reported`
    in both modes; row3_evidence_missing stays a stop in both."""
    assert check_rule in ("literal", "coverage")
    stops, reported = [], []
    if provider_seen:
        stops.append({"rule": "provider_request", "detail": "a non-loopback connection or provider variable was seen"})
    rise = (b.get("is_error_last_request") or 0) > (a.get("is_error_last_request") or 0)
    if check_rule == "literal":
        if rise:
            stops.append({"rule": "is_error_without_counterpart", "detail": f"B {b['is_error_last_request']} > A {a['is_error_last_request']}"})
    else:  # coverage: completion_not_reached = the run did not complete; the is_error rise is only reported (it counts the whole history)
        if not completion_reached(b):
            stops.append({"rule": "completion_not_reached", "detail": f"news_exit {b.get('news_exit')}, final_result {b.get('final_result')}"})
        if rise:
            reported.append({"rule": "is_error_rise", "detail": f"B {b.get('is_error_last_request')} > A {a.get('is_error_last_request')} (report-only under coverage)"})
    ak, bk = a.get("boundary_refusals_by_kind") or {}, b.get("boundary_refusals_by_kind") or {}
    for kind, n in sorted(bk.items()):
        if n > ak.get(kind, 0):
            reported.append({"rule": "refusal_without_counterpart", "detail": f"kind {kind}: B {n} > A {ak.get(kind, 0)} (report-only)"})
    # Data sha sets must match exactly. The whole-file computation sha comparison is report-only (it stays in
    # sha_compare); computations stop through the product's own recheck of every file and through the pairing, below.
    if not shas["data"]["equal"]:
        stops.append({"rule": "data_sha_differs", "detail": f"data: A-only {shas['data']['a_only_sha']}, B-only {shas['data']['b_only_sha']}"})
    if recheck is None:  # never a gap: no recheck evidence is itself a stop
        stops.append({"rule": "computation_recheck_missing", "detail": "no recheck result was given"})
    else:
        for side in ("a", "b"):
            r = recheck.get(side)
            if not isinstance(r, dict) or "counts" not in r:
                stops.append({"rule": "computation_recheck_missing", "detail": f"no recheck.json for side {side.upper()}"})
                continue
            c = r["counts"]
            if r.get("env_problem"):  # an environment problem is its own outcome, never "stop on a bad file"
                stops.append({"rule": "environment_problem", "detail": f"{side.upper()}: {r.get('note') or 'recheck environment problem'}"})
            elif c.get("different", 0) or c.get("could-not-run", 0) or r.get("note"):
                stops.append({"rule": "computation_recheck_not_same", "detail": f"{side.upper()}: different {c.get('different', 0)}, could-not-run {c.get('could-not-run', 0)}" + (f", note: {r['note']}" if r.get("note") else "")})
        p = recheck.get("pairing")
        if not isinstance(p, dict):
            stops.append({"rule": "computation_recheck_missing", "detail": "no pairing result"})
        elif p.get("paired_different", 0) > 0:
            stops.append({"rule": "computation_paired_different", "detail": f"paired-different {p['paired_different']} keys (paired-same {p.get('paired_same', 0)}, unpaired A {p.get('unpaired_a', 0)} / B {p.get('unpaired_b', 0)}: reported, not a stop)"})
    ra, rb = check_runs(a), check_runs(b)
    skips = (b.get("events_by_type") or {}).get(COMPLETION_SKIP, 0) if arm == "B" else 0  # each skip event covers one missing run, once
    for name in sorted(ra):
        lack = ra[name] - rb.get(name, 0)
        if check_rule == "coverage":
            lack = ra[name] if rb.get(name, 0) == 0 else 0  # only a check that never ran in the other run
        if lack <= 0:
            continue
        if name.startswith("event:") and skips >= lack:  # row 7: the skipped repeat, shown by its own events
            skips -= lack
            continue
        stops.append({"rule": "check_ran_fewer" if check_rule == "literal" else "check_never_ran", "detail": f"{name}: A {ra[name]}, B {rb.get(name, 0)}"})
    if arm == "B" and not trim_evidence:
        stops.append({"rule": "row3_evidence_missing", "detail": "the four trimmed field names are still in arm B's request-1 tools, or were never in arm A's"})
    return stops, reported
