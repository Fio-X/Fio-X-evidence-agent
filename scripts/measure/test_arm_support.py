#!/usr/bin/env python3
"""Shared helpers for the measure_arm tests: a fake `news`, a stand-in window thread, and a base class that runs one arm on synthetic folders."""
import builtins
import contextlib
import glob
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import measure_arm as MA  # noqa: E402
import measure_lib as L  # noqa: E402

MARK = "SECRET-MARKER-DO-NOT-READ"
PLANTED = {"session/s.jsonl": MARK, "meta/m.json": MARK, "claims.jsonl": MARK, "story.json": MARK, "conversation.md": MARK, "prompt.md": MARK,
           "config.toml": MARK, "config/c.json": MARK, ".env": MARK, "auth.json": MARK, "home/x.txt": MARK, "xdg-state/y": MARK, "private/p": MARK,
           "agent-session/a": MARK, "data/session/inner.json": MARK, "infographics/home/h.txt": MARK}
FAKE_NEWS = '''#!%(py)s
import http.client, json, os, sys, time
if len(sys.argv) > 2 and sys.argv[1] == "verify":  # the recheck calls `news verify <copy> --recompute`; the run may carry fake-verify.txt
    root = sys.argv[2]
    fv = [os.path.join(r, "fake-verify.txt") for r, d, f in os.walk(root) if "fake-verify.txt" in f]
    print(open(fv[0]).read() if fv else "artifact integrity: PASS\\nSQL recompute: PASS\\nrecompute checks: %%d" %% (1 + 2 * (len([f for f in os.listdir(os.path.join(root, "computations")) if f.endswith(".json")]) if os.path.isdir(os.path.join(root, "computations")) else 0)))
    sys.exit(0)
plan = json.loads(sys.argv[-1])
out = os.environ["NEWSROOM_ARTIFACTS_DIR"]
run = os.path.join(out, "run-1")
os.makedirs(run, exist_ok=True)
json.dump({"names": sorted(os.environ), "newsroom": {k: v for k, v in sorted(os.environ.items()) if k.startswith("NEWSROOM_") and k != "NEWSROOM_AGENT_LOCAL_URL" and k != "NEWSROOM_ARTIFACTS_DIR"}},
          open("env-seen.json", "w"))
def write(rel, text):
    p = os.path.join(run, rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(text)
for rel, text in plan.get("files", {}).items():
    write(rel, text)
def lines(rel, rows):
    write(rel, "".join(json.dumps(r) + "\\n" for r in rows))
lines("events.jsonl", plan.get("events", []))
lines("runtime/tool-chain-events.jsonl", plan.get("chain", []))
if plan.get("refusals") is not None:
    lines("runtime/boundary-refusals.jsonl", plan["refusals"])
url = os.environ["NEWSROOM_AGENT_LOCAL_URL"].split("//")[1]
host, port = url.split(":")
messages = [{"role": "user", "content": "q"}]
tools = [{"name": "t", "input_schema": {"type": "object", "properties": {f: {} for f in plan.get("tool_fields", [])}}}]
for n in range(1, plan["requests"] + 1):
    conn = http.client.HTTPConnection(host, int(port), timeout=600)
    conn.request("POST", "/v1/messages", json.dumps({"system": "s", "tools": tools, "messages": messages, "stream": True}), {"content-type": "application/json", "x-api-key": "fake"})
    data = conn.getresponse().read().decode(); conn.close()
    assert "message_stop" in data
    messages = messages + [{"role": "assistant", "content": "a"}, {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": "r",
                            **({"is_error": True} if (n == plan["requests"] - 1 and plan.get("last_is_error")) else {})}]}]
    marker = plan.get("stall_marker")
    if marker and n == plan["stall_after"] and (marker == "always" or not os.path.exists(marker)):
        if marker != "always":
            open(marker, "w").write("x")
        time.sleep(600)
time.sleep(plan.get("sleep_s", 0))
'''


def answer_all(out_root, replies, stop_evt):
    """The stand-in window: answers req-N of every live attempt-N/relay folder with replies[N-1] (last one is text)."""
    while not stop_evt.is_set():
        for view in glob.glob(os.path.join(out_root, "attempt-[0-9]", "relay", "req-*.view.md")):
            rel = os.path.dirname(view)
            n = int(os.path.basename(view).split("-")[1].split(".")[0])
            path = os.path.join(rel, f"reply-{n}.json")
            if os.path.exists(path):
                continue
            reply = replies[min(n, len(replies)) - 1]
            tmp = path + ".tmp"
            json.dump(reply, open(tmp, "w"))
            os.rename(tmp, path)
        time.sleep(0.1)


def tc(*names):
    return {"tool_calls": [{"name": n, "arguments": {"k": "v"}} for n in names]}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="arm-test-")
        cls.fake = os.path.join(cls.tmp, "fake-news")
        with open(cls.fake, "w") as handle:
            handle.write(FAKE_NEWS % {"py": sys.executable})
        os.chmod(cls.fake, os.stat(cls.fake).st_mode | stat.S_IEXEC)
        cls.frozen = os.path.join(cls.tmp, "z", "frozen-downloads")
        os.makedirs(cls.frozen)
        open(os.path.join(cls.frozen, "d.csv"), "w").write("a,b\n1,2\n")
        cls.canary = os.path.join(cls.tmp, "canary")
        os.makedirs(os.path.join(cls.canary, "computations"))
        json.dump({"sql": "select 1", "rows": [], "result_hash": "x"}, open(os.path.join(cls.canary, "computations", "c0.json"), "w"))
        cls.duck = os.path.join(cls.tmp, "duckdb")
        with open(cls.duck, "w") as handle:
            handle.write("#!/bin/sh\necho v1.0.0 stand-in\n")
        os.chmod(cls.duck, 0o755)
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        # The runner exports names such as GITHUB_API_URL, which the credential pattern rightly refuses. Every test starts from a
        # minimal, explicit environment instead of inheriting the host's; a test that needs a name adds it on top.
        minimal = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": self.tmp, "PYTHON": sys.executable}
        patcher = mock.patch.dict(os.environ, minimal, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_arm(self, arm, plan, replies, *, commit="1" * 40, stall_minutes=1.0, probe="ok", extra=()):
        type(self).n += 1
        out = os.path.join(self.tmp, f"arm{self.n}-{arm}")
        qf = os.path.join(self.tmp, f"q{self.n}.txt")
        open(qf, "w").write(json.dumps(plan))
        stop = threading.Event()
        thread = threading.Thread(target=answer_all, args=(out, replies, stop), daemon=True)
        thread.start()
        argv = ["--topic", "demo", "--arm", arm, "--binary", self.fake, "--commit", commit, "--out", out, "--sandbox", "none", "--frozen", self.frozen,
                "--question-file", qf, "--stall-minutes", str(stall_minutes), "--probe", probe, "--canary-dir", self.canary,
                "--child-path", "/usr/bin:/bin", "--duckdb-bin", self.duck, *extra]
        opened = []
        real_open = builtins.open

        def spy(file, *a, **k):
            opened.append(os.fspath(file) if isinstance(file, (str, bytes, os.PathLike)) else file)
            return real_open(file, *a, **k)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf), mock.patch.object(builtins, "open", spy):
                rc = MA.main(argv)
        finally:
            stop.set()
            thread.join(5)
        self.opened, self.stdout = opened, buf.getvalue()
        return out, rc

    def counts(self, out):
        return json.load(open(os.path.join(out, "counts.json")))

    def no_secret_in_outputs(self, out):
        for name in ("harness.json", "counts.json", "counts-line.txt", "stops.json", "status.json", "compare-vs-A.json", "compare-vs-A.audit.txt"):
            p = os.path.join(out, name)
            if os.path.exists(p):
                self.assertNotIn(MARK, open(p).read(), name)
        self.assertNotIn(MARK, self.stdout)




RUN_A = {"requests": 4, "tool_fields": list(L.TRIM_FIELDS),
         "events": [{"type": "turn_start"}] * 4 + [{"type": "tool_execution_end", "toolName": "x"}, {"type": "completion_retry"}, {"type": "completion_retry"}],
         "chain": [{"type": "tool_execution_end", "toolName": "newsroom_infographic_lint"}] * 2 + [{"type": "tool_execution_end", "toolName": "newsroom_viz_critic"}, {"type": "chain_done"}],
         "refusals": [{"kind": "k_one", "x": MARK}], "files": {"data/d.csv": "1", "computations/c.json": "2", "infographics/i.html": "3", **PLANTED},
         "sleep_s": 0}
REPLIES_A = [tc("newsroom_infographic_lint"), tc("newsroom_infographic_lint", "write_file"), tc("newsroom_viz_critic"), {"text": "done"}]
