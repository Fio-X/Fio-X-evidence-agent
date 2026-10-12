#!/usr/bin/env python3
"""End-to-end check of gate A: `news` parent + Rust child with NEWSROOM_AGENT=rust and NEWSROOM_AGENT_REAL=1, on this machine only.

Test tool only, standard library only, no network beyond 127.0.0.1, no real configuration or key: the configuration is a fake `.env` file written
into WORKDIR (key literal `standin-local-key`, address = the local stand-in started here), handed over with NEWSROOM_ENV_FILE; HOME is an empty folder in WORKDIR.

    NEWS_BIN=target/debug/news python3 scripts/smoke_rust_agent_real.py WORKDIR

Run it through the sandbox wrapper like scripts/smoke_rust_agent.py (NEWSROOM_AGENT=rust and NEWSROOM_AGENT_LOCAL_URL=<a local address> are required by the wrapper
and are not used by the real route). WORKDIR must be new or empty. Two runs of `news investigate-v2`:
  A  clean: the parent reads the fake configuration, the child starts without the key, the stand-in sees the key in x-api-key and the model's reply comes back.
  B  leak: the key is also planted in the child's environment under a name the parent does not strip; the child must refuse to use it, so the stand-in sees no request.
Checked on A: the stand-in got requests whose x-api-key is the fake key (the address and key can only have come from the fake file); no file under WORKDIR (run folder, events,
session, output, home; the fake `.env` itself excepted) and neither the output nor the error stream contains the key; the run's events show the model answered.
Prints PASS/FAIL lines and exits 1 on any FAIL.
"""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FAKE_KEY = "standin-local-key"
ANSWER = "Stand-in answer: nothing was investigated."


def sse(events):
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()


REPLY = sse([
    ("message_start", {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": "standin",
                                                            "stop_reason": None, "usage": {"input_tokens": 10, "output_tokens": 1}}}),
    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": ANSWER}}),
    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
    ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 8}}),
    ("message_stop", {"type": "message_stop"}),
])


class StandIn:
    """A local Messages-API stand-in: counts requests, remembers only whether each one carried the fake key, and answers with a fixed text."""

    def __init__(self):
        self.requests = 0
        self.key_ok = []
        self.body_has_key = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                outer.requests += 1
                outer.key_ok.append(self.headers.get("x-api-key") == FAKE_KEY)
                outer.body_has_key.append(FAKE_KEY.encode() in body)
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(REPLY)))
                self.end_headers()
                self.wfile.write(REPLY)

            def log_message(self, format, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def scan_tree(root: Path, skip: Path):
    """Names of files under root (except skip) whose bytes contain the key."""
    found = []
    for path in root.rglob("*"):
        if path.is_file() and path != skip:
            try:
                if FAKE_KEY.encode() in path.read_bytes():
                    found.append(str(path.relative_to(root)))
            except OSError:
                pass
    return found


def run_news(news, work, name, env_file, url, leak):
    home = work / f"home-{name}"
    home.mkdir()
    out_dir = work / f"out-{name}"
    env = {k: v for k, v in os.environ.items()
           if not (k.startswith("NEWSROOM_") or k.endswith(("_API_KEY", "_BASE_URL", "_TOKEN")) or "PROXY" in k.upper())}
    env.update({
        "NEWSROOM_AGENT": "rust",
        "NEWSROOM_AGENT_REAL": "1",
        "NEWSROOM_AGENT_LOCAL_URL": url,  # only for the sandbox wrapper's own check; the real route ignores it
        "NEWSROOM_ENV_FILE": str(env_file),
        "NEWSROOM_RPC_IDLE_MS": "120000",
        "NEWSROOM_RPC_TOTAL_MS": "300000",
        "NEWSROOM_RPC_FINISH_MS": "120000",
        "HOME": str(home),
    })
    if leak:
        env["E7_LEAKED_COPY"] = FAKE_KEY
    result = subprocess.run(
        [news, "investigate-v2", "--model", "standin", "--out", str(out_dir), "make a data report about the population of Norway"],
        cwd=work, env=env, capture_output=True, text=True, timeout=400)
    (work / f"news-{name}.stdout.txt").write_text(result.stdout)
    (work / f"news-{name}.stderr.txt").write_text(result.stderr)
    return result, out_dir


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work = Path(sys.argv[1]).resolve()
    news = os.environ.get("NEWS_BIN")
    if not news or not Path(news).exists():
        sys.exit("set NEWS_BIN to a built news binary")
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()):
        sys.exit(f"{work} is not empty")
    fails = []

    def check(ok, what):
        print(("PASS " if ok else "FAIL ") + what)
        if not ok:
            fails.append(what)

    standin = StandIn()
    env_file = work / "fake-config.env"
    env_file.write_text(f"ANTHROPIC_API_KEY={FAKE_KEY}\nNEWSROOM_BASE_URL={standin.url}\n")

    result, out_dir = run_news(news, work, "a", env_file, standin.url, leak=False)
    print(f"A: news exit code {result.returncode} (non-zero is expected: the program's own gates refuse a run with no chart)")
    check(standin.requests >= 1, f"A: the stand-in was asked {standin.requests} time(s) (address came from the fake configuration)")
    check(standin.requests >= 1 and all(standin.key_ok), "A: every request carried the fake key in x-api-key (the key came from the fake configuration)")
    check(not any(standin.body_has_key), "A: no request body contains the key")
    runs = sorted(p for p in out_dir.glob("*") if p.is_dir() and p.name != "runtime") if out_dir.exists() else []
    check(len(runs) == 1, "A: one run folder was created")
    if runs:
        events_path = runs[0] / "events.jsonl"
        text = events_path.read_text() if events_path.exists() else ""
        check(ANSWER in text, "A: the run's events hold the model's reply (the first model call returned)")
        check((runs[0] / "session" / "session.jsonl").exists() or (runs[0] / "agent-session").exists(), "A: the session record exists")
    hits = scan_tree(work, env_file)
    check(not hits, f"A: no file under the work folder holds the key (found in: {hits})")
    check(FAKE_KEY not in result.stdout + result.stderr, "A: the key is not in the output or the error stream")

    before = standin.requests
    result_b, _ = run_news(news, work, "b", env_file, standin.url, leak=True)
    print(f"B: news exit code {result_b.returncode}")
    check(standin.requests == before, "B: with the key planted in the child's environment the stand-in saw no request")
    check(FAKE_KEY not in result_b.stdout + result_b.stderr, "B: the key is not in the output or the error stream")
    check(not scan_tree(work, env_file), "B: no file under the work folder holds the key")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
