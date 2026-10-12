"""Shared harness of the fake-Rust tests (1012zi step 2): `news` with NEWSROOM_AGENT=rust against the local stand-in relay, no key, no network
beyond 127.0.0.1. Same approach as scripts/smoke_rust_agent.py. Test tool only, standard library only.

    with FakeRust(script) as fake:
        result = fake.news(["investigate-v2", ...])

`script` is a function (request number, request body) -> reply dict of scripts/standin_relay.py; every request is answered the moment it arrives.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FAKE_KEY = "standin-local-key"
BINARY = Path(os.environ.get("NEWS_BIN") or ROOT / "target" / "debug" / "news")


def plan_reply(goal="fake-Rust test"):
    return {"tool_calls": [{"name": "newsroom_update_plan", "arguments": {
        "goal": goal, "steps": [{"id": "s1", "action": "list the artifacts", "status": "in_progress"}],
        "trigger": "initial_goal"}}]}


def inventory_reply():
    return {"tool_calls": [{"name": "artifact_inventory", "arguments": {}}]}


class FakeRust:
    def __init__(self, script):
        if not BINARY.is_file():
            raise SystemExit("build target/debug/news (or set NEWS_BIN) before running this check")
        self.script = script
        self.work = None

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fake-rust-")
        self.work = Path(self._tmp.name).resolve()
        self.relay_dir = self.work / "relay"
        self.relay = subprocess.Popen(
            [sys.executable, str(HERE / "standin_relay.py"), "--workdir", str(self.relay_dir), "--port", "0"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.url = self.relay.stdout.readline().split()[-1]
        self.stop = threading.Event()
        threading.Thread(target=self._answer, daemon=True).start()
        (self.work / "home").mkdir()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.relay.terminate()
        self.relay.wait(timeout=10)
        self._tmp.cleanup()

    def _answer(self):
        n = 1
        while not self.stop.is_set():
            request = self.relay_dir / f"req-{n}.json"
            if request.exists():
                try:
                    body = json.loads(request.read_text())
                except ValueError:
                    time.sleep(0.02)
                    continue
                tmp = self.relay_dir / f"reply-{n}.json.tmp"
                tmp.write_text(json.dumps(self.script(n, body)))
                tmp.rename(self.relay_dir / f"reply-{n}.json")
                n += 1
            else:
                time.sleep(0.02)

    def requests(self):
        return [json.loads(p.read_text()) for p in sorted(self.relay_dir.glob("req-*.json"),
                key=lambda p: int(p.stem.split("-")[1]))]

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items()
               if not (k.startswith("NEWSROOM_") or k.endswith(("_API_KEY", "_BASE_URL", "_TOKEN")))}
        env.update({
            "NEWSROOM_AGENT": "rust",
            "NEWSROOM_AGENT_LOCAL_URL": self.url,
            "NEWSROOM_RPC_IDLE_MS": "60000",
            "NEWSROOM_RPC_TOTAL_MS": "120000",
            "NEWSROOM_RPC_FINISH_MS": "60000",
            "HOME": str(self.work / "home"),
        })
        env.update(extra)
        return env

    def news(self, args, cwd=None, stdin=None, timeout=180, **env_extra):
        return subprocess.run([str(BINARY), *args], cwd=cwd or self.work, env=self.env(**env_extra), text=True,
                              capture_output=True, timeout=timeout, stdin=stdin)


def run_folder(out_dir: Path) -> Path:
    runs = sorted(p for p in out_dir.glob("*") if p.is_dir() and p.name != "runtime")
    assert len(runs) == 1, runs
    return runs[0]


def last_line(result) -> str:
    lines = [x for x in (result.stdout + "\n" + result.stderr).splitlines() if x.strip()]
    return lines[-1] if lines else ""
