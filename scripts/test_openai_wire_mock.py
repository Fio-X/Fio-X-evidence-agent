#!/usr/bin/env python3
"""Run the direct agent against a strict OpenAI Chat Completions mock."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


FIXTURE_KEY = "local-openai-fixture-key-do-not-print"
requests_seen = []
violations = []


def resolve_news_binary(repo):
    override = os.environ.get("NEWSROOM_TEST_BINARY")
    candidates = [Path(override)] if override else []
    candidates.extend([repo / "target/release/news", repo / "target/debug/news"])
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        "news binary not found; build it or set NEWSROOM_TEST_BINARY"
    )


def violation(message):
    violations.append(message)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            violation("invalid JSON")
            self.send_error(400, "invalid JSON")
            return

        requests_seen.append(body)
        if self.path != "/v1/chat/completions":
            violation(f"path:{self.path}")
        if self.headers.get("authorization") != f"Bearer {FIXTURE_KEY}":
            violation("missing fixture bearer token")
        if self.headers.get("x-api-key"):
            violation("unexpected x-api-key header")

        tools = body.get("tools")
        if not isinstance(tools, list) or not tools:
            violation("tools is not a non-empty array")
        else:
            for tool in tools:
                if tool.get("type") != "function":
                    violation("tool envelope is not type=function")
                function = tool.get("function") or {}
                if "input_schema" in tool or "input_schema" in function:
                    violation("Anthropic input_schema leaked into OpenAI request")
                if not isinstance(function.get("parameters"), dict):
                    violation("function.parameters is not an object")

        messages = body.get("messages") or []
        roles = [message.get("role") for message in messages]
        if len(requests_seen) == 1:
            if roles != ["system", "user"]:
                violation(f"first roles:{roles}")
            response = {
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "I will render the checked fixture.",
                        "tool_calls": [{
                            "id": "call-openai-1",
                            "type": "function",
                            "function": {
                                "name": "create_modern_chart",
                                "arguments": json.dumps({
                                    "title": "Fixture comparison",
                                    "chart_type": "bar",
                                    "data": [
                                        {"label": "A", "value": 12},
                                        {"label": "B", "value": 8},
                                    ],
                                    "source_note": "local fixture",
                                }),
                            },
                        }],
                    },
                    "finish_reason": "tool_calls",
                }]
            }
        elif len(requests_seen) == 2:
            if roles != ["system", "user", "assistant", "tool"]:
                violation(f"tool roles:{roles}")
            assistant = messages[2] if len(messages) > 2 else {}
            tool_result = messages[3] if len(messages) > 3 else {}
            calls = assistant.get("tool_calls") or []
            if not calls or calls[0].get("type") != "function":
                violation("assistant function tool call missing")
            if tool_result.get("tool_call_id") != "call-openai-1":
                violation("tool_call_id was not preserved")
            response = {
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "The checked HTML chart is ready.",
                    },
                    "finish_reason": "stop",
                }]
            }
        else:
            violation("unexpected request count")
            response = {"choices": [{"message": {"role": "assistant", "content": "unexpected"}, "finish_reason": "stop"}]}

        payload = json.dumps(response).encode()
        self.send_response(200 if not violations else 400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = os.environ.copy()
    for name in ("DRAGONCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NEWSROOM_API_KEY"):
        environment.pop(name, None)

    repo = Path(sys.argv[1] if len(sys.argv) > 1 else os.getcwd()).resolve()
    news_binary = resolve_news_binary(repo)
    with tempfile.TemporaryDirectory(prefix="newsroom-openai-wire-") as output:
        process = subprocess.run(
            [
                str(news_binary),
                "investigate-v2",
                "--provider",
                "openai",
                "--api-key",
                FIXTURE_KEY,
                "--base-url",
                f"http://127.0.0.1:{server.server_port}",
                "--out",
                output,
                "Create an HTML chart for this fixture.",
            ],
            cwd=repo,
            env=environment,
            capture_output=True,
            text=True,
            timeout=20,
        )
        output_root = Path(output)
        run_dirs = [path for path in output_root.iterdir() if path.is_dir()]
        run_dir = run_dirs[0] if len(run_dirs) == 1 else None
        html_files = [path for path in run_dir.rglob("*.html") if path.is_file()] if run_dir else []
        report = run_dir / "report.md" if run_dir else None
        result = {
            "ok": process.returncode == 0 and not violations and len(requests_seen) == 2 and bool(html_files) and report and report.is_file(),
            "exit_code": process.returncode,
            "request_count": len(requests_seen),
            "request_roles": [[message.get("role") for message in body.get("messages", [])] for body in requests_seen],
            "html_artifact_count": len(html_files),
            "report_exists": bool(report and report.is_file()),
            "fixture_key_in_output": FIXTURE_KEY in process.stdout or FIXTURE_KEY in process.stderr,
            "violations": violations,
        }
    server.shutdown()
    server.server_close()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if not result["ok"] or result["fixture_key_in_output"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
