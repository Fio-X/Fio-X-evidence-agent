#!/usr/bin/env python3
"""Smoke test of the Rust agent path (1011ak 9a): `news` with NEWSROOM_AGENT=rust against the local stand-in relay.

Test tool only, standard library only, no network beyond 127.0.0.1, no key given (the Rust agent answers with the fixed stand-in literal FAKE_KEY, which is also what the output is checked for).

    NEWS_BIN=target/debug/news python3 scripts/smoke_rust_agent.py WORKDIR [--group-switches | --observe] [--relay-port N]

WORKDIR must be a new or empty folder (it is created when missing) outside any folder that holds a .env link. The script starts scripts/standin_relay.py, runs a small
`news investigate` question on the Rust path, and answers each model request by a fixed script (reply 1: update the plan, reply 2: list the
artifacts, reply 3: a text answer). --relay-port N fixes the relay's port (default: a free port), for sandbox wrappers that only allow named local ports. The run is expected to end with the program's own gates unhappy (there is no chart); what is checked is that the
events, the session file, the staging folder and the boundary report are all produced. Prints PASS/FAIL lines and exits 1 on any FAIL.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import smoke_loopback_guard as guard  # noqa: E402
FAKE_KEY = "standin-local-key"
SCRIPT = {
    1: {"tool_calls": [{"name": "newsroom_update_plan", "arguments": {
        "goal": "smoke test of the Rust agent path",
        "steps": [{"id": "s1", "action": "list the artifacts", "status": "in_progress"}],
        "trigger": "initial_goal"}}]},
    2: {"tool_calls": [{"name": "artifact_inventory", "arguments": {}}]},
}
FINAL = {"text": "Smoke test answer: nothing was investigated."}


def answer_requests(relay_dir: Path, stop: threading.Event):
    n = 1
    while not stop.is_set():
        if (relay_dir / f"req-{n}.json").exists():
            reply = SCRIPT.get(n, FINAL)
            tmp = relay_dir / f"reply-{n}.json.tmp"
            tmp.write_text(json.dumps(reply))
            tmp.rename(relay_dir / f"reply-{n}.json")
            n += 1
        else:
            time.sleep(0.05)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work = Path(sys.argv[1]).resolve()
    observe = "--observe" in sys.argv
    group_switches = "--group-switches" in sys.argv or observe
    relay_port = "0"
    if "--relay-port" in sys.argv:
        i = sys.argv.index("--relay-port")
        relay_port = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
        if not relay_port.isdigit():
            sys.exit("--relay-port needs a port number")
    news = os.environ.get("NEWS_BIN")
    if not news or not Path(news).exists():
        sys.exit("set NEWS_BIN to a built news binary")
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()):
        sys.exit(f"{work} is not empty")
    relay_dir = work / "relay"
    out_dir = work / "out"
    fails = []

    def check(ok, what):
        print(("PASS " if ok else "FAIL ") + what)
        if not ok:
            fails.append(what)

    relay = subprocess.Popen(
        [sys.executable, str(HERE / "standin_relay.py"), "--workdir", str(relay_dir), "--port", relay_port],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    stop = threading.Event()
    try:
        url = relay.stdout.readline().split()[-1]
        threading.Thread(target=answer_requests, args=(relay_dir, stop), daemon=True).start()
        env = {k: v for k, v in os.environ.items()
               if not (k.startswith("NEWSROOM_") or k.endswith(("_API_KEY", "_BASE_URL", "_TOKEN")))}
        guard.require_loopback(url, "the relay address")
        env.update({
            "NEWSROOM_AGENT": "rust",
            "NEWSROOM_AGENT_LOCAL_URL": url,
            "NEWSROOM_RPC_IDLE_MS": "120000",
            "NEWSROOM_RPC_TOTAL_MS": "600000",
            "NEWSROOM_RPC_FINISH_MS": "120000",
            "HOME": str(work / "home"),
        })
        guard.check_env(env)
        (work / "home").mkdir()
        if group_switches:
            # NEWSROOM_GROUP_TOOLS is left out on purpose: with it, the parent itself refuses to create the output root (also on the old Pi path before the Rust agent)
            env.update({"NEWSROOM_GROUP_HANDOFF": "1", "NEWSROOM_GROUP_ENFORCE": "1", "NEWSROOM_GROUP_BOUNDARY": "1"})
        if observe:
            # --observe: TOOLS on (the command side's second gate only runs then), its rows only recorded in runtime/handoff-observed.jsonl
            env.update({"NEWSROOM_GROUP_TOOLS": "1", "NEWSROOM_GROUP_HANDOFF_OBSERVE": "1"})
        else:
            env["NEWSROOM_GROUP_BOUNDARY"] = "1"
        result = subprocess.run(
            [news, "investigate", "--out", str(out_dir), "make a data report about the population of Norway"],
            cwd=work, env=env, capture_output=True, text=True, timeout=600)
        (work / "news.stdout.txt").write_text(result.stdout)
        (work / "news.stderr.txt").write_text(result.stderr)
        print(f"news exit code {result.returncode} (a non-zero code is expected: the program's own gates refuse a run with no chart)")
    finally:
        stop.set()
        relay.terminate()

    # the root's own folder ("runtime/") holds the observed log of the out folder's mkdir when --observe is on
    runs = sorted(p for p in out_dir.glob("*") if p.is_dir() and p.name != "runtime") if out_dir.exists() else []
    check(len(runs) == 1, "one run folder was created")
    if not runs:
        sys.exit(1)
    run = runs[0]
    requests = sorted(relay_dir.glob("req-*.json"))
    check(len(requests) >= 3, f"the model was asked {len(requests)} times (3 expected)")
    first = json.loads((relay_dir / "req-1.json").read_text()) if requests else {}
    check(bool(first.get("tools")) and "newsroom_update_plan" in [t["name"] for t in first.get("tools", [])],
          "the first request carries the tool list")
    check("record_claim" in [t["name"] for t in first.get("tools", [])], "the tool list includes record_claim")
    session = run / "agent-session" / "session.jsonl"
    check(session.exists(), "the session file exists")
    lines = [json.loads(x) for x in session.read_text().splitlines()] if session.exists() else []
    roles = [x.get("message", {}).get("role") for x in lines if x.get("type") == "message"]
    check(roles.count("assistant") >= 3 and roles.count("toolResult") == 2,
          f"session has at least 3 assistant messages (a corrective turn adds one) and 2 tool results (got {roles})")
    check((run / "plan.json").exists(), "plan.json was moved in from the call's staging")
    staging = run / "staging"
    check(not staging.exists() or not any(staging.iterdir()), "no call folder is left in staging")
    events = [json.loads(x) for x in (run / "events.jsonl").read_text().splitlines()] if (run / "events.jsonl").exists() else []
    kinds = {e.get("type") for e in events}
    check({"agent_start", "tool_execution_start", "tool_execution_end", "agent_end"} <= kinds,
          f"the event log has the run's events (types seen: {sorted(k for k in kinds if k)[:12]})")
    report = run / "runtime" / "group-boundary-report.json"
    check(report.exists(), "the boundary report was written")
    if report.exists():
        totals = json.loads(report.read_text()).get("totals", {})
        check(bool(totals), f"the report has totals ({json.dumps(totals)[:120]})")
    check(FAKE_KEY not in (work / "news.stdout.txt").read_text() + (work / "news.stderr.txt").read_text(),
          "the key literal does not appear in the output")
    if observe:
        logs = [x for x in (out_dir / "runtime" / "handoff-observed.jsonl", run / "runtime" / "handoff-observed.jsonl") if x.exists()]
        check(bool(logs) and all(x.read_text().strip() for x in logs), "the observed hand-off log has lines")
    print(f"run folder: {run}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
