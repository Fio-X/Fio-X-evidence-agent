#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSIONS = json.loads((ROOT / "versions.json").read_text(encoding="utf-8"))

def parse_version(text, lead=None):
    """The same reading as `parse_version` in src/commands/doctor.rs: only the first line, read from one fixed word and never searched
    for further on (the first word, or, with `lead`, the second word after a first word that is exactly `lead`); at most one leading
    "v" is dropped; the word must be exactly major.minor.patch, so a suffix ("-rc.1", "-beta", "-dev", "+build"), a missing part or
    another leading word makes the line unreadable (None)."""
    lines = text.splitlines()
    words = lines[0].split() if lines else []
    if lead is not None:
        if not words or words[0] != lead:
            return None
        words = words[1:]
    if not words:
        return None
    word = words[0]
    parts = (word[1:] if word.startswith("v") else word).split(".")
    if len(parts) != 3 or not all(part.isascii() and part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)

def version_tuple(text):
    return tuple(int(part) for part in text.split("."))

def run(name, command, expected=None, minimum=None, required=True, lead=None):
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
            found = parse_version(text, lead)
            out["ok"] = found is not None and found >= tuple(minimum)
        else:
            out["ok"] = True
    except Exception as exc:
        out["error"] = str(exc)
    return out

def main():
    # Pi is only a fallback runtime (NEWSROOM_AGENT=pi), as in `news doctor`: listed, and required, only when it is the selected one.
    pi_runtime = os.environ.get("NEWSROOM_AGENT") == "pi"
    checks = [
        run("node", ["node", "--version"], minimum=(22, 19, 0)),
        *([run("pi", [os.environ.get("NEWSROOM_PI_BIN", "pi"), "--version"], expected=VERSIONS["pi_coding_agent"])] if pi_runtime else []),
        # DuckDB and rustc need at least the pinned version (as `news doctor` does); rust-toolchain.toml still pins the build's Rust.
        run("duckdb", [os.environ.get("NEWSROOM_DUCKDB_BIN", "duckdb"), "--version"], minimum=version_tuple(VERSIONS["duckdb"])),
        run("rustc", ["rustc", "--version"], minimum=version_tuple(VERSIONS["rust"]), lead="rustc"),
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

if __name__ == "__main__":
    main()
