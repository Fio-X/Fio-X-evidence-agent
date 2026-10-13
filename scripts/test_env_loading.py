#!/usr/bin/env python3
"""Exercise the one-command project .env workflow without contacting a provider."""
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


def run_env_case(cwd: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    # Make the test independent of the developer shell and of the repository .env.
    for key in (
        "NEWSROOM_ENV_FILE",
        "NEWSROOM_PI_PROVIDER",
        "NEWSROOM_PI_MODEL",
        "NEWSROOM_PI_THINKING",
        "OPENAI_BASE_URL",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "KIMI_API_KEY",
        "MOONSHOT_API_KEY",
        "ZAI_API_KEY",
        "ZHIPUAI_API_KEY",
        "DRAGONCODE_API_KEY",
        "DRAGONCODE_MODEL",
    ):
        env.pop(key, None)
    env.update(
        {
            "NEWSROOM_AGENT": "pi",
            # Same sizing as test_output_location.py: the scripted mock needs about 0.4-0.7 s end to end, the old
            # 300/300/500/2000 ms were sized for perf_mock_pi.py.
            "NEWSROOM_RPC_STARTUP_MS": "2000",
            "NEWSROOM_RPC_IDLE_MS": "2000",
            "NEWSROOM_RPC_FINISH_MS": "2000",
            "NEWSROOM_RPC_TOTAL_MS": "8000",
        }
    )
    return subprocess.run(
        [str(BINARY), "investigate", "--pi-bin", str(MOCK), "env loading"],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )


with tempfile.TemporaryDirectory(prefix="news-env-cwd-") as cwd_name, tempfile.TemporaryDirectory(
    prefix="news-env-external-"
) as external_name:
    cwd = Path(cwd_name).resolve()
    external = Path(external_name) / "credentials.env"
    external.write_text(
        "# A project-managed external file; this test value is not a real key.\n"
        "NEWSROOM_PI_PROVIDER=openai\n"
        "NEWSROOM_PI_MODEL='claude-sonnet-4-6'\n"
        "OPENAI_BASE_URL=https://dragoncode.codes\n"
        "OPENAI_API_KEY=test-only-openai-value\n"
        "ANTHROPIC_API_KEY=test-only-anthropic-value\n"
        "DEEPSEEK_API_KEY=test-only-deepseek-value\n"
        "KIMI_API_KEY=test-only-kimi-value\n"
        "MOONSHOT_API_KEY=test-only-moonshot-value\n"
        "ZAI_API_KEY=test-only-zai-value\n"
        "ZHIPUAI_API_KEY=test-only-zhipu-value\n"
        "DRAGONCODE_MODEL=claude-sonnet-4-6\n"
        "UNRELATED_ENV=must-not-be-imported\n",
        encoding="utf-8",
    )
    (cwd / ".env").symlink_to(external)
    before = external.read_bytes()
    result = run_env_case(cwd)
    if result.returncode != 0:
        raise SystemExit(f".env workflow failed: {result.stderr}")
    if "provider=dragoncode model=claude-sonnet-4-6" not in result.stderr:
        raise SystemExit(".env provider/model did not reach the Pi runtime")
    for marker in (
        "test-only-openai-value",
        "test-only-anthropic-value",
        "test-only-deepseek-value",
        "test-only-kimi-value",
        "test-only-moonshot-value",
        "test-only-zai-value",
        "test-only-zhipu-value",
    ):
        if marker in result.stdout or marker in result.stderr:
            raise SystemExit("test key leaked into CLI output")
    if external.read_bytes() != before:
        raise SystemExit("external .env was modified")
    runs = list((cwd / ".newsroom" / "artifacts").glob("*/story.json"))
    if len(runs) != 1:
        raise SystemExit("default output was not written below the invoking cwd")

print("project .env loading: PASS (symlink preserved, shell-safe, cwd output)")
