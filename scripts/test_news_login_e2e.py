#!/usr/bin/env python3
"""End-to-end check of `news login` against a fake model endpoint on this machine (17 checks).

A throwaway HOME under TMPDIR, fake keys only, and a fake Anthropic Messages server bound to 127.0.0.1 that answers 200 for
the good fake key and 401 (echoing the key it got) for any other. Every child gets a clean environment: HOME, PATH and
NEWSROOM_AGENT_REAL=1 (login reads the configuration the real route would), with every address loopback-checked first.
Checks: a wrong key is refused and nothing is saved; a good key is saved with mode 600; --show masks the key and says
whether the saved login is in use; a key in a `.env` wins; a file others can read is refused with the chmod fix; there
is no --key option; --show with --key-stdin is a usage error; without a terminal and without --key-stdin it is refused;
inside an agent or tool process (NEWSROOM_ARTIFACT_DIR set) every mode is refused and the file is untouched; --clear removes
the file; and neither fake key appears in any output.

Run: python3 scripts/test_news_login_e2e.py   (NEWS_BIN=<path> to use a given binary; default target/debug/news)
"""
import http.server
import json
import os
import re
import stat
import subprocess
import sys
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from smoke_loopback_guard import check_env, check_env_file_text, require_loopback  # noqa: E402
from tmp_helper import make_test_tmp  # noqa: E402

ROOT = HERE.parent
GOOD = "sk-good-fake-0123456789abcdefWXYZ"
BAD = "sk-bad-fake-0123456789abcdefQQQQ"
ENV_KEY = "sk-envfile-fake-0123456789abcdef"


class FakeModel(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        key = self.headers.get("x-api-key") or (self.headers.get("authorization") or "")[7:]
        if key == GOOD:
            code, body = 200, {"content": [{"type": "text", "text": "p"}]}
        else:
            code, body = 401, {"error": {"type": "authentication_error", "message": "bad key " + key}}
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


def binary() -> str:
    path = os.environ.get("NEWS_BIN") or str(ROOT / "target" / "debug" / "news")
    if not Path(path).is_file():
        sys.exit(f"no news binary at {path}: build it (cargo build) or set NEWS_BIN")
    return path


def main() -> int:
    news = binary()
    home = Path(make_test_tmp("news-login-e2e-"))
    story = home / "story"
    story.mkdir()
    creds = home / ".config" / "fio-x" / "credentials"
    server = http.server.HTTPServer(("127.0.0.1", 0), FakeModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    require_loopback(url, "the fake model address")
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin", "NEWSROOM_AGENT_REAL": "1"}
    check_env(env)
    outputs = []

    def run(*args, stdin_text=None):
        p = subprocess.run([news, *args], cwd=story, env=env, capture_output=True, text=True, timeout=60,
                           input=stdin_text, stdin=None if stdin_text is not None else subprocess.DEVNULL)
        out = p.stdout + p.stderr
        outputs.append(out)
        return p.returncode, out

    results = []

    def check(name, ok):
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + name)

    login = ["login", "--provider", "custom", "--base-url", url, "--model", "m-1", "--key-stdin"]
    rc, out = run(*login, stdin_text=BAD + "\n")
    check("a wrong key is refused and nothing is saved", rc != 0 and not creds.exists())
    check("the wrong key is not printed", BAD not in out and BAD[:8] not in out)

    rc, out = run(*login, stdin_text=GOOD + "\n")
    check("a good key is saved", rc == 0 and creds.is_file())
    check("the file is mode 600", creds.is_file() and stat.S_IMODE(creds.stat().st_mode) == 0o600)
    check("the good key is not printed", GOOD not in out and GOOD[:12] not in out)

    rc, out = run("login", "--show")
    check("--show masks the key", "sk-good-********WXYZ" in out and GOOD not in out)
    check("--show says the saved login is in use", re.search(r"In use:\s+yes", out) is not None)
    config_lines = [line for line in out.splitlines() if "[config]" in line]
    check("the configuration note names the saved login and no part of the key",
          "using the saved login" in out and not any("sk-good" in line or "WXYZ" in line for line in config_lines))

    dot_env = f"ANTHROPIC_API_KEY={ENV_KEY}\nANTHROPIC_BASE_URL={url}\n"
    check_env_file_text(dot_env, "the test .env")
    (story / ".env").write_text(dot_env)
    rc, out = run("login", "--show")
    check("a key in .env wins over the saved login", re.search(r"In use:\s+no", out) is not None)
    (story / ".env").unlink()

    creds.chmod(0o644)
    rc, out = run("login", "--show")
    check("a file others can read is refused with the chmod fix", "chmod 600" in out and GOOD not in out)
    creds.chmod(0o600)

    rc, _ = run("login", "--key-stdin", "--show")
    check("--show with --key-stdin is a usage error", rc == 2)
    rc, _ = run("login", "--key", "sk-x")
    check("there is no --key option", rc == 2)
    rc, out = run("login")
    check("without a terminal and without --key-stdin it is refused", rc != 0 and "--key-stdin" in out)

    saved = creds.read_bytes()
    env["NEWSROOM_ARTIFACT_DIR"] = str(home / "run")
    rc_show, out_show = run("login", "--show")
    rc_clear, out_clear = run("login", "--clear")
    rc_save, out_save = run(*login, stdin_text=GOOD + "\n")
    del env["NEWSROOM_ARTIFACT_DIR"]
    check("inside an agent or tool process every mode is refused and the saved login is untouched",
          rc_show != 0 and rc_clear != 0 and rc_save != 0
          and all("agent or tool process" in out and "own terminal" in out for out in (out_show, out_clear, out_save))
          and creds.read_bytes() == saved and GOOD not in out_show + out_save)

    run("login", "--clear")
    check("--clear removes the file", not creds.exists())
    rc, out = run("login", "--show")
    check("--show after --clear says there is none", "No saved login" in out)

    every = "\n".join(outputs)
    check("neither fake key appears in any output", GOOD not in every and BAD not in every and ENV_KEY not in every)
    server.shutdown()
    print(f"news login e2e: {sum(results)}/{len(results)} passed")
    return 0 if all(results) and len(results) == 17 else 1


if __name__ == "__main__":
    sys.exit(main())
