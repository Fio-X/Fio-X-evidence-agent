#!/usr/bin/env python3
"""Exercise user-facing output placement without contacting a provider."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "target/release/news").resolve()
# The scripted mock records a claim and the files a verified run needs, so `investigate` ends VERIFIED (exit 0, the
# rule since 51685e9). perf_mock_pi.py's normal mode records no claim and ends NOT VERIFIED (exit 1).
MOCK = ROOT / "scripts/mock_pi.py"


def env_for() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "NEWSROOM_AGENT": "pi",
            "NEWSROOM_REVIEW_SPLIT": "0",  # this test builds the old layout (the draw step writes the render-QA record); the review split is on by default
            # The scripted mock writes its artifact tree before answering (about 0.4-0.7 s end to end). 100/120/400/1200 ms
            # (sized for perf_mock_pi.py) fail with "Pi RPC startup timeout"; 500/500/500/3000 ms passed 5 of 5 runs, so
            # these are about 4x that.
            "NEWSROOM_RPC_STARTUP_MS": "2000",
            "NEWSROOM_RPC_IDLE_MS": "2000",
            "NEWSROOM_RPC_FINISH_MS": "2000",
            "NEWSROOM_RPC_TOTAL_MS": "8000",
        }
    )
    return env


with tempfile.TemporaryDirectory(prefix="news-output-cwd-") as temp:
    # macOS exposes /var as a symlink to /private/var; compare the same
    # canonical spelling Rust obtains from current_dir().
    cwd = Path(temp).resolve()
    result = subprocess.run(
        [str(BINARY), "investigate", "--pi-bin", str(MOCK), "current directory output"],
        cwd=cwd,
        env=env_for(),
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"default output run failed: {result.stderr}")
    default_root = cwd / ".newsroom" / "artifacts"
    runs = [path for path in default_root.iterdir() if path.is_dir()]
    if len(runs) != 1 or not (runs[0] / "story.json").is_file():
        raise SystemExit(f"default output was not rooted in cwd: {default_root}")
    if f"output_root={default_root}" not in result.stderr:
        raise SystemExit("effective output root was not reported")

    cancelled = subprocess.run(
        [
            str(BINARY),
            "investigate",
            "--confirm-output",
            "--pi-bin",
            str(MOCK),
            "confirmation should fail closed",
        ],
        cwd=cwd,
        env=env_for(),
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        timeout=2,
        check=False,
    )
    if cancelled.returncode == 0 or "requires an interactive terminal" not in cancelled.stderr:
        raise SystemExit("non-interactive --confirm-output did not fail closed")

print("output location: PASS (cwd-relative default and bounded non-interactive confirmation)")
