#!/usr/bin/env python3
"""Conversation-mode tool profile (NEWSROOM_INTERACTIVE_STORY): `news` without a subcommand, NEWSROOM_AGENT=rust, a real pseudo-terminal, the local
stand-in relay. No provider, no network beyond 127.0.0.1, no key.

The profile of each run is read from the run folder's events.jsonl (the `newsroom_rpc_metrics` rows record `tool_profile`).
  ON  : an ordinary chart topic runs as `visual` and its follow-up keeps it; a complex infographic topic runs as `visual-story` without any command;
        `:story` forces the next `:new` topic to `visual-story`, `:quick` forces it to `visual`; `:path` prints the current profile; `:help` lists both.
  OFF : the old rule is unchanged: every topic runs as `visual` (no upgrade), `:path` has no profile line, `:help` does not mention `:story`.
A visual-story run cannot complete under the stand-in (the completion gate wants the infographic chain), so those runs end in a reported failure;
the test only needs the recorded profile and, for `:new` topics, that the conversation goes on.
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

SIMPLE = "make a chart of the population of Norway"
COMPLEX = "做一张复杂的信息图"
PLAIN = "summarize the source"
QUESTION = "and what about the year 2020?"


def script(n, body):
    return {1: plan_reply(), 2: inventory_reply()}.get(n, {"text": f"stand-in answer {n}"})


def pump(fd, output, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                output.extend(os.read(fd, 8192))
            except OSError:
                return


def wait_for(fd, output, marker, start, timeout=120.0):
    deadline = time.monotonic() + timeout
    while marker not in bytes(output[start:]):
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {marker!r}; output={bytes(output[-1500:])!r}")
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                output.extend(os.read(fd, 8192))
            except OSError:
                break
    return bytes(output).find(marker, start) + len(marker)


def session(fake, steps, **env_extra):
    """steps: input lines. After each one wait for the next `news> ` (or `new topic> ` after :new). Returns (text, exit code or None, runs)."""
    arts = fake.work / f"arts-{len(list(fake.work.glob('arts-*')))}"
    env = fake.env(NEWSROOM_ARTIFACTS_DIR=str(arts), NEWSROOM_PI_BIN=str(fake.work / "no-such-pi"), **env_extra)
    binary = str(BINARY)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(fake.work)
        os.execve(binary, [binary], env)
    output = bytearray()
    status = None
    try:
        cursor = wait_for(fd, output, b"news> ", 0)
        for line in steps:
            os.write(fd, (line + "\n").encode())
            if line.startswith(":new"):
                cursor = wait_for(fd, output, b"new topic> ", cursor)
                continue
            try:
                cursor = wait_for(fd, output, b"news> ", cursor, timeout=60.0 if line != steps[-1] else 5.0)
            except AssertionError:
                if b"investigation failed" in bytes(output):
                    break  # the first round failed and the program ended (a visual-story run cannot complete under the stand-in)
                raise
        try:
            os.write(fd, b"exit\n")
        except OSError:
            pass  # the program had already ended
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            waited, st = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = os.waitstatus_to_exitcode(st)
                break
            pump(fd, output, 0.2)
        else:
            raise AssertionError(f"did not exit; output={bytes(output[-1500:])!r}")
    except Exception:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)
    runs = sorted((p for p in arts.iterdir() if p.is_dir() and p.name != "runtime"), key=lambda p: p.stat().st_mtime) if arts.exists() else []
    return output.decode("utf-8", errors="replace"), status, runs


def profiles(run):
    """Every tool profile the run's events recorded, in order."""
    found = []
    path = run / "events.jsonl"
    for line in path.read_text().splitlines() if path.exists() else []:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "newsroom_rpc_metrics" and event.get("tool_profile"):
            found.append(event["tool_profile"])
    return found


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        check.failed.append(what)


check.failed = []

with FakeRust(script) as fake:
    # ON, ordinary topic + follow-up + :path + :help
    text, status, runs = session(fake, [SIMPLE, QUESTION, ":path", ":help"], NEWSROOM_INTERACTIVE_STORY="1")
    check(status == 0 and len(runs) == 1, f"on: an ordinary topic and its follow-up run and exit 0 (status {status}, runs {len(runs)})")
    p = profiles(runs[0]) if runs else []
    check(p and set(p) == {"visual"}, f"on: ordinary topic and its follow-up both ran as visual ({p})")
    check("当前档: visual" in text, "on: :path shows the current profile")
    check(":story" in text and ":quick" in text, "on: :help lists :story and :quick")

    # ON, complex topic goes to visual-story with no command
    text, status, runs = session(fake, [COMPLEX], NEWSROOM_INTERACTIVE_STORY="1")
    p = profiles(runs[0]) if runs else []
    check("visual-story" in p, f"on: a complex infographic topic runs as visual-story by itself ({p})")

    # ON, :story and :quick force the next :new topic
    text, status, runs = session(fake, [SIMPLE, ":story", ":new", PLAIN, ":quick", ":new", COMPLEX, ":path"], NEWSROOM_INTERACTIVE_STORY="1")
    check(len(runs) == 3, f"on: three runs were created ({len(runs)})")
    if len(runs) == 3:
        p = [profiles(r) for r in runs]
        check("visual" in p[0] and "visual-story" not in p[0], f"on: first topic ran as visual ({p[0]})")
        check("visual-story" in p[1], f":story forced the next topic to visual-story though it is plain text ({p[1]})")
        check("visual-story" not in p[2] and "visual" in p[2], f":quick forced a complex topic to visual ({p[2]})")
    check("当前档: " in text, "on: :path after :quick shows a profile line")

    # OFF: the old rule, byte-for-byte in what the conversation shows
    text, status, runs = session(fake, [COMPLEX, ":help"])
    p = profiles(runs[0]) if runs else []
    check(p and set(p) == {"visual"}, f"off: a complex topic still runs as visual, no upgrade ({p})")
    text2, status2, runs2 = session(fake, [SIMPLE, ":path", ":help"])
    check("当前档" not in text2 and ":story" not in text2 and ":quick" not in text2, "off: :path and :help show nothing about profiles")
    check(status2 == 0, f"off: ordinary conversation exits 0 ({status2})")

if check.failed:
    sys.exit(1)
print("interactive story profile: PASS")
