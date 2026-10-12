#!/usr/bin/env python3
"""Fake-Rust version of the conversation-mode test: `news` without a subcommand, NEWSROOM_AGENT=rust, a real pseudo-terminal, local stand-in relay.

One topic, one follow-up, :path, exit. The first round and the follow-up both go through the Rust agent child (the stand-in relay
receives their requests; the Pi binary is pointed at a path that does not exist, so a Pi child could not start), the run folder holds
agent-session/, the follow-up resumes that session (the first answer is in the history sent ahead of the question), and the process exits 0.
Default-Pi conversation mode is covered by test_interactive_cli.py. No provider, no network beyond 127.0.0.1.
"""
import json
import os
import pty
import select
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_rust_agent import BINARY, FakeRust, inventory_reply, plan_reply  # noqa: E402

FIRST = "First answer text of the conversation run."
FOLLOW = "Follow-up answer text of the conversation run."
QUESTION = "and what about the year 2020?"


def script(n, body):
    return {1: plan_reply(), 2: inventory_reply(), 3: {"text": FIRST}}.get(n, {"text": FOLLOW})


def read_until(fd, output, marker, start=0, timeout=60.0):
    deadline = time.monotonic() + timeout
    while marker not in output[start:]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"timed out waiting for {marker!r}; output={output[-1500:]!r}")
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        try:
            output.extend(os.read(fd, 8192))
        except OSError:
            break
    return output.find(marker, start) + len(marker)


with FakeRust(script) as fake:
    arts = fake.work / "arts"
    env = fake.env(NEWSROOM_ARTIFACTS_DIR=str(arts), NEWSROOM_PI_BIN=str(fake.work / "no-such-pi"))
    binary = str(BINARY)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(fake.work)
        os.execve(binary, [binary], env)

    output = bytearray()
    asked = 0
    try:
        cursor = read_until(fd, output, b"news> ")
        os.write(fd, b"make a data report\n")
        cursor = read_until(fd, output, b"news> ", cursor)
        asked = len(fake.requests())
        os.write(fd, (QUESTION + "\n").encode())
        cursor = read_until(fd, output, b"news> ", cursor)
        os.write(fd, b":path\n")
        cursor = read_until(fd, output, b"news> ", cursor)
        os.write(fd, b"exit\n")
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                break
            ready, _, _ = select.select([fd], [], [], 0.1)
            if ready:
                try:
                    output.extend(os.read(fd, 8192))
                except OSError:
                    pass
        else:
            raise AssertionError(f"conversation mode did not exit after `exit`; output={output[-1500:]!r}")
    except Exception:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        raise
    finally:
        os.close(fd)

    text = output.decode("utf-8", errors="replace")
    assert os.waitstatus_to_exitcode(status) == 0, text[-2000:]
    assert asked == 3, (asked, text[-2000:])
    requests = fake.requests()
    assert len(requests) > asked, "the follow-up asked the model nothing"
    runs = [p for p in arts.iterdir() if p.is_dir() and p.name != "runtime"]
    assert len(runs) == 1, runs
    session = runs[0] / "agent-session" / "session.jsonl"
    assert session.is_file(), "the run has no agent-session/"
    assert FIRST in session.read_text() and FOLLOW in session.read_text()
    messages = requests[asked]["messages"]
    assert FIRST in json.dumps(messages, ensure_ascii=False), "the history of the first round was not sent"
    assert messages[-1]["role"] == "user" and QUESTION in json.dumps(messages[-1], ensure_ascii=False)
    assert "当前 artifact:" in text and str(runs[0]) in text, text[-1500:]

print("rust conversation mode: PASS")
