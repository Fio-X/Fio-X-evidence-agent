#!/usr/bin/env python3
"""Edit the first character with the delete keys at the `news>` prompt through a real pseudo-terminal."""
import os
import pty
import select
import signal
import tempfile
import time
from pathlib import Path


root = Path(__file__).resolve().parents[1]
binary = Path(__import__("sys").argv[1] if len(__import__("sys").argv) > 1 else root / "target/release/news").resolve()
mock = (root / "scripts/perf_mock_pi.py").resolve()

# Each prompt starts with the bracketed-paste switch-on (see test_interactive_cli.py).
PROMPT = b"\x1b[?2004h"
DELETE = b"\x1b[3~"  # the forward-delete key
BACKSPACE = b"\x7f"  # the delete key on a Mac keyboard
HOME = b"\x01"  # Ctrl-A
RIGHT = b"\x1b[C"

# Each case types a line whose first character is a stray "x"; once the stray character is gone the line is ":help",
# which prints the help text. If the first character survives, the line is sent as a question and no help appears.
CASES = {
    "forward delete at line start": b"x:help" + HOME + DELETE,
    "backspace after the first character": b"x:help" + HOME + RIGHT + BACKSPACE,
    "backspace on a one-character line": b"x" + BACKSPACE + b":help",
    "backspace down to an empty line": b"xy" + BACKSPACE + BACKSPACE + b":help",
}


def read_until(fd: int, output: bytearray, marker: bytes, start: int = 0, timeout: float = 12.0) -> int:
    deadline = time.monotonic() + timeout
    while marker not in output[start:]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"timed out waiting for {marker!r}; output={output[-1000:]!r}")
        if not select.select([fd], [], [], remaining)[0]:
            continue
        try:
            output.extend(os.read(fd, 8192))
        except OSError:
            break
    return output.find(marker, start) + len(marker)


with tempfile.TemporaryDirectory(prefix="news-delete-key-") as temp:
    workdir = Path(temp)
    env_file = workdir / "settings.env"
    env_file.write_text("NEWSROOM_PI_PROVIDER=dragoncode\nNEWSROOM_PI_MODEL=claude-sonnet-4-6\n")
    env = {
        **os.environ,
        "NEWSROOM_AGENT": "pi",
        "NEWSROOM_ENV_FILE": str(env_file),
        "NEWSROOM_PI_BIN": str(mock),
        "PERF_MOCK_MODE": "normal",
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.execve(str(binary), [str(binary)], env)

    output = bytearray()
    failures = []
    try:
        cursor = read_until(fd, output, PROMPT)
        for name, keys in CASES.items():
            os.write(fd, keys)
            time.sleep(0.2)
            os.write(fd, b"\n")
            try:
                end = read_until(fd, output, PROMPT, cursor, timeout=6.0)
            except AssertionError:
                failures.append(f"{name}: the prompt did not come back")
                break
            if "显示帮助".encode() not in output[cursor:end]:
                failures.append(f"{name}: the first character was not deleted")
            cursor = end
        os.write(fd, b":quit\n")
        deadline = time.monotonic() + 12.0
        while time.monotonic() < deadline:
            if os.waitpid(pid, os.WNOHANG)[0] == pid:
                break
            if select.select([fd], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(fd, 8192))
                except OSError:
                    pass
        else:
            raise AssertionError("interactive CLI did not exit after :quit")
    except Exception:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        raise
    finally:
        os.close(fd)
    assert not failures, failures
    print("prompt delete key: PASS (" + ", ".join(CASES) + ")")
