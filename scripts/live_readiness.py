#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = json.loads((ROOT / "versions.json").read_text(encoding="utf-8"))

def run(name, command, expected=None, minimum=None, required=True):
    path = shutil.which(command[0])
    out = {"name": name, "required": required, "command": command[0], "path": path, "ok": False, "version": None}
    if not path:
        out["error"] = "not found"
        return out
    try:
        cp = subprocess.run(command, capture_output=True, text=True, timeout=8)
        text = (cp.stdout.strip() or cp.stderr.strip()).splitlines()[0] if (cp.stdout.strip() or cp.stderr.strip()) else ""
        out["version"] = text
        if cp.returncode != 0:
            out["error"] = f"exit {cp.returncode}"
            return out
        if expected:
            out["ok"] = expected in text
        elif minimum:
            match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", text)
            out["ok"] = bool(match and tuple(map(int, match.groups())) >= tuple(minimum))
        else:
            out["ok"] = True
    except Exception as exc:
        out["error"] = str(exc)
    return out

checks = [
    run("node", ["node", "--version"], minimum=(22, 19, 0)),
    run("pi", [os.environ.get("NEWSROOM_PI_BIN", "pi"), "--version"], expected=VERSIONS["pi_coding_agent"]),
    run("duckdb", [os.environ.get("NEWSROOM_DUCKDB_BIN", "duckdb"), "--version"], expected=VERSIONS["duckdb"]),
    run("rustc", ["rustc", "--version"], expected=VERSIONS["rust"]),
    run("cargo", ["cargo", "--version"]),
    run("python3", ["python3", "--version"], required=False),
]
credential_names = [name for name in [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY", "ZHIPUAI_API_KEY"
] if os.environ.get(name)]
pi_auth_present = (Path.home() / ".pi" / "agent" / "auth.json").is_file()
report = {
    "schema_version": "0.7.0",
    "release": VERSIONS.get("release"),
    "live_ready": all(c["ok"] for c in checks if c["required"]),
    "model_credential_available": bool(credential_names) or pi_auth_present,
    "api_key_env_available": bool(credential_names),
    "pi_auth_present": pi_auth_present,
    "credential_env_names": credential_names,
    "checks": checks,
}
print(json.dumps(report, indent=2))
sys.exit(0 if report["live_ready"] else 2)
