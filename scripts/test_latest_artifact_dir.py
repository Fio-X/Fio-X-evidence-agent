#!/usr/bin/env python3
"""Regression coverage for the portable qualification artifact selector."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "latest_artifact_dir.py"

with tempfile.TemporaryDirectory(prefix="latest-artifact-") as name:
    root = Path(name)
    empty = subprocess.run(
        [sys.executable, str(HELPER), str(root)],
        text=True,
        capture_output=True,
        check=True,
    )
    assert empty.stdout == ""

    older = root / "older artifact"
    newer = root / "newer artifact with spaces"
    older.mkdir()
    newer.mkdir()
    os.utime(older, ns=(1_000_000_000, 1_000_000_000))
    os.utime(newer, ns=(2_000_000_000, 2_000_000_000))

    chosen = subprocess.run(
        [sys.executable, str(HELPER), str(root)],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    assert chosen == str(newer), (chosen, newer)

print("portable qualification artifact selector: PASS")
