#!/usr/bin/env python3
"""Exercise investigate-v2's deterministic artifact completion contract."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


FIXTURE_KEY = "local-artifact-fixture-key-do-not-print"


def resolve_news_binary(repo):
    configured = os.environ.get("NEWSROOM_TEST_BINARY")
    candidates = []
    if configured:
        candidate = Path(configured)
        candidates.append(candidate if candidate.is_absolute() else repo / candidate)
    candidates.extend((repo / "target/release/news", repo / "target/debug/news"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SystemExit(
        "news test binary is missing; set NEWSROOM_TEST_BINARY or run cargo build --bin news"
    )


def chart_tool_use(tool_id="artifact-tool-1"):
    return {
        "type": "tool_use",
        "id": tool_id,
        "name": "create_modern_chart",
        "input": {
            "title": "Deterministic artifact",
            "chart_type": "bar",
            "data": [
                {"label": "A", "value": 3},
                {"label": "B", "value": 7},
            ],
            "source_note": "local fixture",
        },
    }


def run_case(repo, news_binary, scenario):
    state = {"requests": [], "violations": []}

    def violation(message):
        state["violations"].append(message)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_POST(self):
            try:
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
            except (ValueError, json.JSONDecodeError):
                violation("invalid JSON")
                self.send_error(400, "invalid JSON")
                return

            state["requests"].append(body)
            if self.path != "/v1/messages":
                violation(f"path:{self.path}")
            if self.headers.get("x-api-key") != FIXTURE_KEY:
                violation("missing fixture key")
            if self.headers.get("authorization"):
                violation("unexpected authorization header")
            if not isinstance(body.get("system"), str) or not body["system"]:
                violation("system is not top-level text")

            messages = body.get("messages")
            if not isinstance(messages, list):
                violation("messages is not a list")
                messages = []
            roles = [message.get("role") for message in messages]
            request_number = len(state["requests"])

            if scenario == "source_then_tool":
                if request_number == 1:
                    if roles != ["user"] or not isinstance(messages[0].get("content"), str):
                        violation(f"initial message shape:{roles}")
                    response = {
                        "id": "artifact-source-1",
                        "type": "message",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": "```html\n<div id=\"source-only\">source-only</div>\n```",
                            }
                        ],
                        "stop_reason": "end_turn",
                    }
                elif request_number == 2:
                    if roles != ["user", "assistant", "user"]:
                        violation(f"correction message shape:{roles}")
                    correction = messages[-1].get("content") if messages else ""
                    if not isinstance(correction, str) or "real artifact" not in correction.lower() or "source code" not in correction.lower():
                        violation("missing explicit artifact correction")
                    response = {
                        "id": "artifact-tool-1-response",
                        "type": "message",
                        "role": "assistant",
                        "content": [chart_tool_use()],
                        "stop_reason": "tool_use",
                    }
                elif request_number == 3:
                    if roles != ["user", "assistant", "user", "assistant", "user"]:
                        violation(f"tool result message shape:{roles}")
                    assistant_content = messages[3].get("content") if len(messages) > 3 else None
                    result_content = messages[4].get("content") if len(messages) > 4 else None
                    assistant_ids = [
                        block.get("id")
                        for block in assistant_content or []
                        if block.get("type") == "tool_use"
                    ]
                    result_ids = [
                        block.get("tool_use_id")
                        for block in result_content or []
                        if block.get("type") == "tool_result"
                    ]
                    if assistant_ids != ["artifact-tool-1"] or result_ids != assistant_ids:
                        violation(f"tool/result ids:{assistant_ids}/{result_ids}")
                    response = {
                        "id": "artifact-final-1",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "The artifact is ready."}],
                        "stop_reason": "end_turn",
                    }
                else:
                    violation(f"unexpected request:{request_number}")
                    response = {
                        "id": "artifact-extra",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "unexpected"}],
                        "stop_reason": "end_turn",
                    }
            elif scenario == "source_only":
                if request_number == 1:
                    response = {
                        "id": "source-only-1",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "```svg\n<svg>source-only</svg>\n```"}],
                        "stop_reason": "end_turn",
                    }
                elif request_number == 2:
                    if roles != ["user", "assistant", "user"]:
                        violation(f"negative correction shape:{roles}")
                    response = {
                        "id": "source-only-2",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "```svg\n<svg>still source-only</svg>\n```"}],
                        "stop_reason": "end_turn",
                    }
                else:
                    violation(f"negative request:{request_number}")
                    response = {
                        "id": "source-only-extra",
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "unexpected"}],
                        "stop_reason": "end_turn",
                    }
            else:
                if request_number != 1:
                    violation(f"text-only request:{request_number}")
                if roles != ["user"]:
                    violation(f"text-only message shape:{roles}")
                response = {
                    "id": "text-only-1",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Text investigation complete."}],
                    "stop_reason": "end_turn",
                }

            payload = json.dumps(response, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    environment = os.environ.copy()
    for name in (
        "DRAGONCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "NEWSROOM_API_KEY",
    ):
        environment.pop(name, None)

    goals = {
        "source_then_tool": "Create an HTML chart for this fixture.",
        "source_only": "Create an SVG visualization for this fixture.",
        "text_only": "Summarize this fixture in plain text.",
    }
    with tempfile.TemporaryDirectory(prefix=f"newsroom-artifact-{scenario}-") as output:
        command = [
            str(news_binary),
            "investigate-v2",
            "--provider",
            "dragoncode",
            "--api-key",
            FIXTURE_KEY,
            "--base-url",
            f"http://127.0.0.1:{server.server_port}",
            "--out",
            output,
            goals[scenario],
        ]
        process = subprocess.run(
            command,
            cwd=repo,
            env=environment,
            capture_output=True,
            text=True,
            timeout=20,
        )
        output_root = Path(output)
        run_dirs = [path for path in output_root.iterdir() if path.is_dir()]
        run_dir = run_dirs[0] if len(run_dirs) == 1 else None
        html_files = (
            [path for path in run_dir.rglob("*.html") if path.is_file()]
            if run_dir is not None
            else []
        )
        report_path = run_dir / "report.md" if run_dir is not None else None
        report = report_path.read_text(encoding="utf-8") if report_path and report_path.is_file() else ""
        result = {
            "scenario": scenario,
            "exit_code": process.returncode,
            "request_count": len(state["requests"]),
            "run_dir_created": run_dir is not None,
            "html_files": [str(path) for path in html_files],
            "html_files_nonempty": bool(html_files) and all(path.stat().st_size > 0 for path in html_files),
            "report_exists": bool(report_path and report_path.is_file()),
            "artifact_path_in_report": bool(html_files) and all(str(path) in report for path in html_files),
            "source_only_not_reported": "source-only" not in report,
            "final_output_present": "complete" in process.stdout.lower() or "ready" in process.stdout.lower(),
            "error_mentions_artifact": "verified artifact" in (process.stdout + process.stderr).lower(),
            "violations": state["violations"],
        }
    server.shutdown()
    server.server_close()
    return result


def main():
    repo = Path(sys.argv[1] if len(sys.argv) > 1 else os.getcwd())
    news_binary = resolve_news_binary(repo)
    results = [
        run_case(repo, news_binary, scenario)
        for scenario in ("source_then_tool", "source_only", "text_only")
    ]

    successful = results[0]
    negative = results[1]
    text_only = results[2]
    failures = []
    if (
        successful["exit_code"] != 0
        or successful["request_count"] != 3
        or not successful["run_dir_created"]
        or not successful["html_files"]
        or not successful["html_files_nonempty"]
        or not successful["report_exists"]
        or not successful["artifact_path_in_report"]
        or not successful["source_only_not_reported"]
    ):
        failures.append("source-only response was not recovered into a reported HTML artifact")
    if negative["exit_code"] == 0 or negative["request_count"] != 2 or negative["report_exists"] or not negative["error_mentions_artifact"]:
        failures.append("second source-only completion was accepted")
    if text_only["exit_code"] != 0 or text_only["request_count"] != 1 or not text_only["report_exists"]:
        failures.append("text-only investigation changed its one-request behavior")
    if any(result["violations"] for result in results):
        failures.append("strict local Anthropic wire contract was violated")

    print(json.dumps({"ok": not failures, "cases": results, "failures": failures}, ensure_ascii=False, sort_keys=True))
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
