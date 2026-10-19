#!/usr/bin/env python3
"""One measurement arm. Starts the stand-in relay (with timing) and `news investigate --tool-profile visual-story "<question>"` under env -i
with a fixed environment, waits for it (a window answers through the relay folder), counts, writes the results.

usage: python3 -I measure_arm.py --topic NAME --arm A|B|C3|R --binary NEWS --commit SHA40 --out DIR --question-file FILE --frozen DIR
          --child-path DIRS --duckdb-bin DUCKDB --canary-dir DIR --sandbox SCRIPT|none
          [--virtual-env DIR] [--dyld-fallback-dir DIR] [--relay-from FILE] [--with-recipes] [--r-list-file FILE --r-list-line N]
          [--stall-minutes N] [--attempts 2] [--max-minutes N]
Every path comes from an argument; nothing is looked up in a fixed place. A missing required argument refuses the start (exit 4,
"refused: missing required argument").
Results in DIR (must not exist): harness.json (what ran), counts.json, counts-line.txt, stops.json, status.json (live, for the stand-in window),
attempt-1/ (and attempt-2/ after a stall) each with relay/, T/out/, tm/, news.out/err. A stalled attempt keeps its folder, renamed *.STALLED.
Exit 0 finished; 2 stop rule fired or stalled twice; 4 bad input / refused to start.
Never reads a run folder except through measure_lib.py. No provider access: NEWSROOM_AGENT_REAL stays unset and a provider variable in the
environment refuses the start.

Isolation. The child gets only the variables built here (`env -i`). HOME points into the attempt folder, so the product's fallback config
(`$XDG_CONFIG_HOME` or `$HOME/.config/<name>/.env`) is not found; XDG_CONFIG_HOME and NEWSROOM_ENV_FILE are not passed and the working
folder has no `.env`. The product has no keychain access in its source. Real isolation from the network and the user's files relies on the
sandbox script; `--sandbox none` is for self-tests only and is written into harness.json as such. The connection probe polls `lsof`, so it can
miss a connection that opens and closes between two polls; if `lsof` cannot be run, the start is refused, and a probe that fails while the
run is going stops the run (fail closed).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I does not add the script folder
import measure_lib as L  # noqa: E402
import recheck_computations as RC  # noqa: E402

REPO_RELAY = os.path.join(HERE, "..", "standin_relay.py")
SWITCH_TABLE = os.path.join(HERE, "..", "..", "ci", "switch-owners.json")
# Rows 1-7 of the measured table (row 8 only with --with-recipes). Every switch is read as exactly "1".
ARM_B = ["NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_TRIM_UNREAD_FIELDS", "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED",
         "NEWSROOM_SPEED_FILL_COPIED_REFS", "NEWSROOM_SPEED_PREFLIGHT", "NEWSROOM_SPEED_COMPLETION_SAME_GAPS"]
ROW8 = "NEWSROOM_SPEED_RECIPES"
ARM_C3 = ["NEWSROOM_CONCEPT_COUNT_3"]
# Arm R's switches are one line of a list file, read by script, never typed. Every value must be "1".
PROVIDER_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|COOKIE|PROXY|ANTHROPIC|OPENAI|BASE_URL|API_URL)", re.I)
DEFAULT_STALL_MINUTES = 10.0  # a choice, not a measured number
POLL = 1.0
REQUIRED = (("topic", "--topic"), ("arm", "--arm"), ("binary", "--binary"), ("commit", "--commit"), ("out", "--out"), ("question_file", "--question-file"),
            ("frozen", "--frozen"), ("child_path", "--child-path"), ("duckdb_bin", "--duckdb-bin"), ("canary_dir", "--canary-dir"), ("sandbox", "--sandbox"))


def sha_bytes_file(path):
    return L.sha_file(path)


def provider_variables(environ):
    # CLAUDE_CODE_* belong to the session running this script; `env -i` never passes them on.
    return sorted(n for n in environ if not n.startswith("CLAUDE_CODE_") and (PROVIDER_NAME.search(n) or n == "NEWSROOM_AGENT_REAL"))


def read_arm_r(path, line_no):
    """-> (switch names, sha256 of the line, sha256 of the file). Refuses anything but NEWSROOM_X=1 tokens."""
    with open(path, "rb") as handle:
        raw = handle.read()
    line = raw.decode("utf-8").split("\n")[line_no - 1].strip()
    names = []
    for token in line.split():
        m = re.fullmatch(r"(NEWSROOM_[A-Z0-9_]+)=1", token)
        if not m:
            raise ValueError("arm R line has a token that is not NEWSROOM_<NAME>=1")
        names.append(m.group(1))
    if not names or len(set(names)) != len(names):
        raise ValueError("arm R line is empty or has a repeated name")
    return names, hashlib.sha256(line.encode()).hexdigest(), hashlib.sha256(raw).hexdigest()


def switches_for(arm, with_recipes, r_names=None):
    if arm == "A":
        return []
    if arm == "R":
        return list(r_names)
    if arm == "C3":
        return list(ARM_C3)
    return ARM_B + ([ROW8] if with_recipes else [])


def base_env(attempt_dir, port, child_path, virtual_env=None, dyld_fallback_dir=None):
    env = {"HOME": os.path.join(attempt_dir, "tm/home"), "PATH": child_path, "TMPDIR": os.path.join(attempt_dir, "tm"), "NEWSROOM_AGENT": "rust",
           "NEWSROOM_AGENT_LOCAL_URL": f"http://127.0.0.1:{port}", "NEWSROOM_RPC_IDLE_MS": "86400000",
           "NEWSROOM_ARTIFACTS_DIR": os.path.join(attempt_dir, "T/out"), "NEWSROOM_DOWNLOAD_FROZEN": "1"}
    if virtual_env:
        env["VIRTUAL_ENV"] = virtual_env
    if dyld_fallback_dir:
        env["DYLD_FALLBACK_LIBRARY_PATH"] = dyld_fallback_dir
    return env


def child_env(att_dir, port, switches, child_path, virtual_env=None, dyld_fallback_dir=None):
    """The whole environment the product gets (`env -i` below passes nothing else): the harness's own variables plus the arm's switches.
    Every NEWSROOM_* variable of the parent is dropped by construction, because the child is started under `env -i`."""
    env = base_env(att_dir, port, child_path, virtual_env, dyld_fallback_dir)
    env.update({name: "1" for name in switches})
    return env


def newsroom_names(environ):
    return sorted(n for n in environ if n.startswith("NEWSROOM_"))


def switch_table_names(path=SWITCH_TABLE):
    with open(path, encoding="utf-8") as handle:
        return {row["name"] for row in json.load(handle)}


def split_names(names, known):
    """-> (names that are rows of the switch table, number of other names). Other names are never kept: they could be anything."""
    listed = sorted(n for n in names if n in known)
    return listed, len(names) - len(listed)


def copy_relay(relay_from, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "standin_relay.py")
    shutil.copyfile(relay_from, dest)
    return dest


def newest_run(out):
    runs = [os.path.join(out, d) for d in os.listdir(out) if os.path.isdir(os.path.join(out, d))] if os.path.isdir(out) else []
    return max(runs, key=os.path.getmtime) if runs else None


def timing_state(relay):
    """Number of timing lines with response_sent in timing.jsonl; only numbers are read."""
    path = os.path.join(relay, "timing.jsonl")
    sent = 0
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and rec.get("response_sent") is not None:
                    sent += 1
    return sent


def count_requests(relay):
    return len([f for f in os.listdir(relay) if re.fullmatch(r"req-\d+\.json", f)])


def download_counts(relay, frozen):
    """Report-only: download_data calls in the relay replies, and how many name an address not listed in the frozen index."""
    try:
        with open(os.path.join(frozen, "index.json"), encoding="utf-8") as handle:
            listed = [e.get("url") for e in json.load(handle).get("entries", [])]
    except (OSError, ValueError):
        listed = []
    total = outside = 0
    for name in sorted(os.listdir(relay)):
        if not re.fullmatch(r"reply-\d+\.json", name):
            continue
        try:
            with open(os.path.join(relay, name), encoding="utf-8") as handle:
                reply = json.load(handle)
        except (OSError, ValueError):
            continue
        for call in reply.get("tool_calls") or []:
            if call.get("name") != "download_data":
                continue
            total += 1
            args = call.get("arguments") or {}
            if listed.count(args.get("url") if isinstance(args, dict) else None) != 1:
                outside += 1
    return {"downloads_total": total, "downloads_outside_frozen": outside}


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def loopback_only(pid, lsof="lsof"):
    """True when no TCP connection of the news process points outside this machine, False when one does, None when the probe could not run
    (lsof missing, not executable, or an exit code other than 0/1). Addresses are only compared, never kept."""
    try:
        done = subprocess.run([lsof, "-nP", "-a", "-g", str(pid), "-iTCP"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode not in (0, 1):
        return None
    for line in done.stdout.splitlines()[1:]:
        m = re.search(r"->(\[[^\]]+\]|[^:\s]+):\d+", line)
        if m and m.group(1) not in ("127.0.0.1", "[::1]", "localhost"):
            return False
    return True


def run_attempt(args, attempt, att_dir, switches, relay_script, question, stall_s, status_path, probe):
    relay_dir = os.path.join(att_dir, "relay")
    for d in ("relay", "T/out", "tm/home"):
        os.makedirs(os.path.join(att_dir, d), exist_ok=True)
    relay = subprocess.Popen([sys.executable, "-I", relay_script, "--workdir", relay_dir, "--port", "0", "--keepalive", "5"], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=open(os.path.join(att_dir, "relay.err"), "w"), text=True)
    line = relay.stdout.readline().strip()
    if not line.startswith("listening http://127.0.0.1:"):
        relay.terminate()
        return {"result": "relay_failed", "provider_signs": []}
    port = int(line.rsplit(":", 1)[1])
    env = child_env(att_dir, port, switches, args.child_path, args.virtual_env, args.dyld_fallback_dir)
    argv = ["env", "-i"] + [f"{k}={v}" for k, v in env.items()]
    if args.sandbox != "none":
        argv += [args.sandbox, "--write", os.path.join(att_dir, "T/out"), "--"]
    argv += [args.binary, "investigate", "--tool-profile", "visual-story", question]
    t0 = time.monotonic()
    news = subprocess.Popen(argv, cwd=os.path.join(att_dir, "T"), stdin=subprocess.DEVNULL, start_new_session=True,
                            stdout=open(os.path.join(att_dir, "news.out"), "w"), stderr=open(os.path.join(att_dir, "news.err"), "w"))
    state = {"attempt": attempt, "relay_dir": relay_dir, "relay_url": f"http://127.0.0.1:{port}", "state": "running", "requests": 0}
    frozen_done, seen_sent, t_last_sent, polls, result, provider_signs = False, 0, time.monotonic(), 0, None, []
    while True:
        time.sleep(POLL)
        polls += 1
        n_req = count_requests(relay_dir)
        if n_req >= 1 and not frozen_done:
            run = newest_run(os.path.join(att_dir, "T/out"))
            if run:  # retried every poll until the run folder exists
                if not os.path.exists(os.path.join(run, "frozen-downloads")):
                    shutil.copytree(args.frozen, os.path.join(run, "frozen-downloads"))
                frozen_done = True
                state["frozen_copied_at_request"] = n_req
        sent = timing_state(relay_dir)
        if sent > seen_sent:
            seen_sent, t_last_sent = sent, time.monotonic()
        rc = news.poll()
        state.update(requests=n_req, replies_sent=sent, news_alive=rc is None)
        with open(status_path, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        if polls % 5 == 0 and rc is None:
            seen = probe(news.pid)
            if seen is None:  # the probe itself failed: nothing can be said about connections, so the run stops
                provider_signs.append("probe_failed")
                kill_group(news)
                result = "probe_failed"
                break
            if not seen:
                provider_signs.append("non_loopback_connection")
                kill_group(news)
                result = "provider_request"
                break
        if rc is not None:
            result = "exited"
            break
        # Stall: the stand-in answered (response_sent of the newest request) and nothing new has come for stall_s.
        if sent >= n_req and sent > 0 and time.monotonic() - t_last_sent > stall_s:
            kill_group(news)
            result = "stalled"
            break
        if time.monotonic() - t0 > args.max_minutes * 60:
            kill_group(news)
            result = "wall_cap"
            break
        if sent == 0 and n_req == 0 and time.monotonic() - t0 > stall_s:
            kill_group(news)
            result = "stalled"
            break
    wall = time.monotonic() - t0
    time.sleep(1.5)  # the relay writes a timing line after the last byte
    relay.terminate()
    try:
        relay.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        relay.kill()
    return {"result": result, "wall_s": wall, "news_exit": news.returncode, "provider_signs": provider_signs, "requests": count_requests(relay_dir),
            "frozen_copied_at_request": state.get("frozen_copied_at_request")}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic")
    ap.add_argument("--arm", choices=("A", "B", "C3", "R"))
    ap.add_argument("--binary")
    ap.add_argument("--commit", help="40-hex commit the binary was built from")
    ap.add_argument("--out")
    ap.add_argument("--question-file")
    ap.add_argument("--frozen")
    ap.add_argument("--child-path", help="the PATH the product gets, a colon-separated list of folders")
    ap.add_argument("--duckdb-bin", help="DuckDB the product's recompute uses")
    ap.add_argument("--canary-dir", help="known-good archive the recheck canary runs on first (must be 100%% same)")
    ap.add_argument("--sandbox", help="path of the sandbox script, or none (self-test only)")
    ap.add_argument("--virtual-env")
    ap.add_argument("--dyld-fallback-dir")
    ap.add_argument("--relay-from", default=REPO_RELAY, help="stand-in relay script to copy (default: this repository's)")
    ap.add_argument("--with-recipes", action="store_true", help="the binary has the recipes change: add its switch to arm B")
    ap.add_argument("--r-list-file")
    ap.add_argument("--r-list-line", type=int)
    ap.add_argument("--stall-minutes", type=float, default=DEFAULT_STALL_MINUTES)
    ap.add_argument("--attempts", type=int, default=2)
    ap.add_argument("--max-minutes", type=float, default=240.0, help="wall cap of one attempt (a slow window is not a stall, but nothing may run for ever)")
    ap.add_argument("--probe", default="lsof", help=argparse.SUPPRESS)
    ap.add_argument("--lsof-bin", default="lsof", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    bad = provider_variables(os.environ)
    if bad:
        print("refused: provider/credential variable names present in the environment:", ", ".join(bad))
        return 4
    missing = [flag for attr, flag in REQUIRED if getattr(args, attr) in (None, "")]
    if missing:
        print("refused: missing required argument:", ", ".join(missing))
        return 4
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.topic):
        print("refused: --topic must be lower-case letters, digits and dashes")
        return 4
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        print("refused: --commit must be 40 hex")
        return 4
    if not os.path.isfile(args.binary) or not os.access(args.binary, os.X_OK):
        print("refused: binary missing or not executable")
        return 4
    if os.path.exists(args.out):
        print("refused: --out exists; rename it first")
        return 4
    if args.sandbox != "none" and not os.path.isfile(args.sandbox):
        print("refused: sandbox script missing")
        return 4
    if not os.path.isdir(args.frozen):
        print("refused: frozen downloads folder missing")
        return 4
    if not os.path.isfile(args.question_file) or not os.path.isfile(args.relay_from):
        print("refused: question file or relay script missing")
        return 4
    if args.probe == "lsof" and loopback_only(os.getpid(), args.lsof_bin) is None:
        print("refused: the connection probe (lsof) cannot run")
        return 4
    with open(args.question_file, encoding="utf-8") as handle:
        question = handle.read()
    r_names, r_line_sha, r_file_sha = (None, None, None)
    if args.arm == "R":
        if not args.r_list_file or not args.r_list_line:
            print("refused: missing required argument: --r-list-file, --r-list-line (arm R)")
            return 4
        try:
            r_names, r_line_sha, r_file_sha = read_arm_r(args.r_list_file, args.r_list_line)
        except (OSError, ValueError, IndexError) as error:
            print("refused: arm R list unreadable or malformed:", type(error).__name__)
            return 4
    switches = switches_for(args.arm, args.with_recipes, r_names)
    os.makedirs(args.out)
    relay_script = copy_relay(args.relay_from, os.path.join(args.out, "relay-script"))
    known = switch_table_names()
    in_parent, unlisted_in_parent = split_names(newsroom_names(os.environ), known)
    harness = {"topic": args.topic, "arm": args.arm, "binary_sha256": sha_bytes_file(args.binary), "built_from_commit": args.commit,
               "contains_recipes_change": args.with_recipes, "switches_set_to_1": switches,
               "relay_copy_is_repo_default": os.path.abspath(args.relay_from) == os.path.abspath(REPO_RELAY), "relay_copy_sha256": sha_bytes_file(relay_script),
               "question_file_sha256": hashlib.sha256(open(args.question_file, "rb").read()).hexdigest(),
               "frozen_downloads": os.path.basename(args.frozen),
               "sandbox": "none" if args.sandbox == "none" else "script", "sandbox_sha256": None if args.sandbox == "none" else sha_bytes_file(args.sandbox),
               "self_test_only": args.sandbox == "none",
               "stall_minutes": args.stall_minutes, "stall_minutes_is_a_choice": True,
               "fixed_settings": ["NEWSROOM_AGENT=rust", "NEWSROOM_AGENT_LOCAL_URL=<loopback>", "NEWSROOM_RPC_IDLE_MS=86400000",
                                  "NEWSROOM_ARTIFACTS_DIR=<attempt>/T/out", "NEWSROOM_DOWNLOAD_FROZEN=1", "HOME", "PATH", "TMPDIR"]
               + (["VIRTUAL_ENV"] if args.virtual_env else []) + (["DYLD_FALLBACK_LIBRARY_PATH"] if args.dyld_fallback_dir else []),
               "NEWSROOM_AGENT_REAL": "unset", "attempts": [],
               # names only, never values; only names that are rows of the switch table are kept, the rest are counted
               "newsroom_names_in_parent_not_passed": in_parent, "newsroom_unlisted_names_in_parent_count": unlisted_in_parent,
               "newsroom_names_child_receives": newsroom_names(child_env("<attempt>", 0, switches, args.child_path)),
               "arm_r_line_sha256": r_line_sha, "arm_r_list_file_sha256": r_file_sha}
    status_path = os.path.join(args.out, "status.json")
    probe = (lambda pid: loopback_only(pid, args.lsof_bin)) if args.probe == "lsof" else (lambda pid: {"ok": True, "fail": False, "error": None}[args.probe])  # self-test stubs
    final, final_dir = None, None
    for attempt in range(1, args.attempts + 1):
        att_dir = os.path.join(args.out, f"attempt-{attempt}")
        res = run_attempt(args, attempt, att_dir, switches, relay_script, question, args.stall_minutes * 60, status_path, probe)
        harness["attempts"].append({"attempt": attempt, **{k: res[k] for k in res if k != "provider_signs"}})
        if res["result"] == "stalled":
            os.rename(att_dir, att_dir + ".STALLED")
            continue
        final, final_dir = res, att_dir
        break
    harness["final_result"] = final["result"] if final else "stalled_twice"
    harness["provider_signs"] = final["provider_signs"] if final else []
    with open(os.path.join(args.out, "harness.json"), "w", encoding="utf-8") as handle:
        json.dump(harness, handle, indent=1)
    if final is None or final["result"] in ("relay_failed", "wall_cap", "probe_failed"):
        print("STOP: stalled on every attempt" if final is None else f"STOP: {final['result']}")
        return 2
    # the final attempt folder is the arm folder for counting and comparison
    for name in ("relay", "T", "tm", "news.out", "news.err", "relay.err"):
        os.rename(os.path.join(final_dir, name), os.path.join(args.out, name))
    os.rmdir(final_dir)
    counts = L.build_counts(args.out, relay_script, final["wall_s"])
    counts.update({"attempt": len(harness["attempts"]), "news_exit": final["news_exit"], "final_result": final["result"]})
    counts.update(download_counts(os.path.join(args.out, "relay"), args.frozen))
    with open(os.path.join(args.out, "counts.json"), "w", encoding="utf-8") as handle:
        json.dump(counts, handle, indent=1)
    line = L.table_line(f"{args.topic} {args.arm}", counts)
    with open(os.path.join(args.out, "counts-line.txt"), "w", encoding="utf-8") as handle:
        handle.write(line + "\n")
    stops = [{"rule": "provider_request", "detail": "non-loopback connection"}] if final["result"] == "provider_request" else []
    # Every computation file of every run is rechecked by the product (news verify --recompute) on a copy; any different/could-not-run stops.
    recheck_tmp = os.path.join(args.out, "recheck-tmp")
    os.makedirs(recheck_tmp)
    run_root = L.find_run(args.out)
    rec = RC.recheck_run(run_root, args.binary, args.duckdb_bin, recheck_tmp, args.canary_dir) if run_root else {"files": {}, "counts": {"files": 0, "same": 0, "different": 0, "could-not-run": 0}, "note": "no run folder", "reasons": {}, "env_problem": False}
    shutil.rmtree(recheck_tmp, ignore_errors=True)
    rec["built_from_commit"] = args.commit
    with open(os.path.join(args.out, "recheck.json"), "w", encoding="utf-8") as handle:
        json.dump(rec, handle, indent=1)
    c = rec["counts"]
    if rec.get("env_problem"):  # pre-flight/canary failed or every file failed to execute: an environment problem, not a bad file
        stops.append({"rule": "environment_problem", "detail": rec["note"]})
    elif c["different"] or c["could-not-run"] or rec["note"]:
        stops.append({"rule": "computation_recheck_not_same", "detail": f"different {c['different']}, could-not-run {c['could-not-run']}" + (f", note: {rec['note']}" if rec["note"] else "")})
    with open(os.path.join(args.out, "stops.json"), "w", encoding="utf-8") as handle:
        json.dump(stops, handle)
    print(line)
    if rec.get("env_problem"):
        print("ENV-PROBLEM: " + rec["note"])
        return RC.ENV_PROBLEM_EXIT
    return 2 if stops else 0


if __name__ == "__main__":
    sys.exit(main())
