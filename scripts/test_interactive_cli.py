#!/usr/bin/env python3
"""Exercise `news` without a subcommand through a real pseudo-terminal."""
import os
import pty
import select
import signal
import subprocess
import sys
import tempfile
from pathlib import Path


root = Path(__file__).resolve().parents[1]
binary = Path(sys.argv[1] if len(sys.argv) > 1 else root / "target/release/news").resolve()
mock = (root / "scripts/perf_mock_pi.py").resolve()


# Each prompt starts with the bracketed-paste switch-on; the line editor redraws "news> " while it echoes long input,
# so waiting on the prompt text alone gets ahead of the program and the next line is typed while it still runs.
PROMPT = b"\x1b[?2004h"


def read_until(
    fd: int, output: bytearray, marker: bytes, start: int = 0, timeout: float = 12.0
) -> int:
    deadline = __import__("time").monotonic() + timeout
    while marker not in output[start:]:
        remaining = deadline - __import__("time").monotonic()
        if remaining <= 0:
            raise AssertionError(f"timed out waiting for {marker!r}; output={output[-1000:]!r}")
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        try:
            output.extend(os.read(fd, 8192))
        except OSError:
            break
    return output.find(marker, start) + len(marker)


with tempfile.TemporaryDirectory(prefix="news-interactive-") as temp:
    workdir = Path(temp)
    data_file = workdir / "sample.csv"
    data_file.write_text("source,target,value\nA,B,1\n")
    env_file = workdir / "settings.env"
    env_file.write_text(
        "NEWSROOM_PI_PROVIDER=dragoncode\nNEWSROOM_PI_MODEL=claude-sonnet-4-6\n"
    )
    env = {
        **os.environ,
        "NEWSROOM_AGENT": "pi",
        "NEWSROOM_ENV_FILE": str(env_file),
        "NEWSROOM_PI_BIN": str(mock),
        "PERF_MOCK_MODE": "normal",
        "NEWSROOM_RPC_STARTUP_MS": "500",
        "NEWSROOM_RPC_IDLE_MS": "500",
        "NEWSROOM_RPC_FINISH_MS": "500",
        "NEWSROOM_RPC_HEARTBEAT_MS": "50",
        "NEWSROOM_RPC_TOTAL_MS": "3000",
    }
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.execve(str(binary), [str(binary)], env)

    output = bytearray()
    try:
        cursor = read_until(fd, output, PROMPT)
        os.write(fd, b":help\n")
        cursor = read_until(fd, output, PROMPT, cursor)
        # Neither request may read as a visual one (src/prompt.rs is_visual_request): since 45ab05d (2026-09-22) a visual
        # request must finish through the infographic and publication gates, which the mock cannot do, so the loop
        # under test would never return to the prompt.
        os.write(fd, f"整理这份测试数据 {data_file}\n".encode())
        cursor = read_until(fd, output, PROMPT, cursor)
        os.write(fd, "把结果按来源再分一组，并保留来源说明\n".encode())
        cursor = read_until(fd, output, PROMPT, cursor)
        os.write(fd, b":path\n")
        cursor = read_until(fd, output, PROMPT, cursor)
        os.write(fd, b":quit\n")
        deadline = __import__("time").monotonic() + 12.0
        while __import__("time").monotonic() < deadline:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                break
            # Drain the terminal so the child is never blocked writing its remaining output.
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

    text = output.decode("utf-8", errors="replace")
    if os.environ.get("INTERACTIVE_TRANSCRIPT"):  # test_interactive_groups_on.py reads the session text to count refusals
        Path(os.environ["INTERACTIVE_TRANSCRIPT"]).write_text(text, encoding="utf-8")
    assert os.waitstatus_to_exitcode(status) == 0, text[-2000:]
    assert "Fio-X data newsroom" in text
    assert "显示帮助" in text
    assert "mock answer" in text
    assert "当前 artifact:" in text, text
    artifacts = list((workdir / ".newsroom" / "artifacts").glob("*/story.json"))
    assert len(artifacts) == 1, artifacts
    artifact_dir = artifacts[0].parent
    assert list((artifact_dir / "data").glob("*.csv")), artifact_dir
    # The follow-up announces itself with "continuing:" (src/commands/continue_investigation.rs:373); "updated:" is no longer printed.
    assert "continuing:" in text

    # The completion gate stays covered: a first-turn visual request under the mock is still stopped by it.
    gate = subprocess.run(
        [str(binary), "investigate", "--pi-bin", str(mock), "制作一张复杂的测试信息图"],
        cwd=workdir,
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    assert "required complex-visual gate did not pass" in gate.stdout + gate.stderr, (gate.stdout + gate.stderr)[-2000:]
    assert gate.returncode != 0, gate.returncode
    print("interactive CLI: PASS (auto-config, data import, follow-up, :path, :quit, visual gate)")
