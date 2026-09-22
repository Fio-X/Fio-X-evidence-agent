#!/usr/bin/env python3
"""Run investigate-v2 against a strict Anthropic Messages-shaped mock."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


FIXTURE_KEY = "local-fixture-key-do-not-print"
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
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            violation("invalid JSON")
            self.send_error(400, "invalid JSON")
            return

        requests_seen.append(body)
        if self.path != "/v1/messages":
            violation(f"path:{self.path}")
        if self.headers.get("x-api-key") != FIXTURE_KEY:
            violation("missing fixture key")
        if self.headers.get("authorization"):
            violation("unexpected authorization header")
        if not isinstance(body.get("system"), str) or not body["system"]:
            violation("system is not top-level text")
        messages = body.get("messages")
        roles = [message.get("role") for message in messages or []]
        if len(requests_seen) == 1:
            if roles != ["user"]:
                violation(f"first roles:{roles}")
            if not isinstance(messages[0].get("content"), str):
                violation("first user content is not text")
            response = {
                "id": "msg-local-1",
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "准备两个确定性图表。"},
                    {
                        "type": "tool_use",
                        "id": "tool-local-1",
                        "name": "create_modern_chart",
                        "input": {
                            "title": "地区销量比较",
                            "chart_type": "bar",
                            "data": [
                                {"label": "甲", "value": 12},
                                {"label": "乙", "value": 8},
                                {"label": "丙", "value": 6},
                                {"label": "丁", "value": 4},
                            ],
                            "unit": "件",
                            "source_note": "本地固定夹具",
                        },
                    },
                    {
                        "type": "tool_use",
                        "id": "tool-local-2",
                        "name": "create_modern_chart",
                        "input": {
                            "title": "季度变化",
                            "chart_type": "line",
                            "data": [
                                {"label": "Q1", "value": 3},
                                {"label": "Q2", "value": 5},
                            ],
                            "unit": "件",
                            "source_note": "本地固定夹具",
                        },
                    },
                ],
                "stop_reason": "tool_use",
            }
        elif len(requests_seen) == 2:
            if roles != ["user", "assistant", "user"]:
                violation(f"tool roles:{roles}")
            assistant_content = messages[1].get("content")
            result_content = messages[2].get("content")
            if not isinstance(assistant_content, list):
                violation("assistant content is not blocks")
            if not isinstance(result_content, list):
                violation("tool result content is not blocks")
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
            if assistant_ids != ["tool-local-1", "tool-local-2"]:
                violation(f"assistant ids:{assistant_ids}")
            if result_ids != assistant_ids:
                violation(f"result ids:{result_ids}")
            response = {
                "id": "msg-local-2",
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": "固定夹具流程完成：两个图表均已生成，工具结果按顺序回传。",
                    }
                ],
                "stop_reason": "end_turn",
            }
        else:
            violation("unexpected request count")
            response = {
                "id": "msg-local-extra",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": "unexpected"}],
                "stop_reason": "end_turn",
            }

        payload = json.dumps(response, ensure_ascii=False).encode()
        self.send_response(200 if not violations else 400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = os.environ.copy()
    for name in ("DRAGONCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NEWSROOM_API_KEY"):
        env.pop(name, None)
    env.update(
        {
            "DRAGONCODE_API_KEY": FIXTURE_KEY,
            "NEWSROOM_PROVIDER": "dragoncode",
            "NEWSROOM_MODEL": "claude-sonnet-4-6",
            "NEWSROOM_BASE_URL": f"http://127.0.0.1:{server.server_port}",
        }
    )
    repo = Path(sys.argv[1] if len(sys.argv) > 1 else os.getcwd()).resolve()
    news_binary = resolve_news_binary(repo)
    with tempfile.TemporaryDirectory(prefix="newsroom-wire-") as output:
        started = time.monotonic()
        proc = subprocess.run(
            [
                str(news_binary),
                "investigate-v2",
                "--out",
                output,
                "固定夹具：生成并核对两个小型图表",
            ],
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        output_root = Path(output)
        run_dirs = [path for path in output_root.iterdir() if path.is_dir()]
        run_dir = run_dirs[0] if len(run_dirs) == 1 else None
        artifact_files = (
            [path for path in run_dir.rglob("*.html") if path.is_file()]
            if run_dir is not None
            else []
        )
        report_path = run_dir / "report.md" if run_dir is not None else None
        report = report_path.read_text(encoding="utf-8") if report_path and report_path.is_file() else ""
        artifact_path_in_report = any(str(path) in report for path in artifact_files)
        report_exists = report_path is not None and report_path.is_file()
        artifact_files_nonempty = bool(artifact_files) and all(path.stat().st_size > 0 for path in artifact_files)
    elapsed = time.monotonic() - started
    server.shutdown()
    stdout = proc.stdout
    stderr = proc.stderr
    result = {
        "strict_ok": not violations,
        "exit_code": proc.returncode,
        "elapsed_s": round(elapsed, 3),
        "request_count": len(requests_seen),
        "request_roles": [[message.get("role") for message in body.get("messages", [])] for body in requests_seen],
        "top_level_system": all(isinstance(body.get("system"), str) for body in requests_seen),
        "tool_result_block_counts": [
            sum(block.get("type") == "tool_result" for block in body.get("messages", [{}])[-1].get("content", []) if isinstance(body.get("messages", [{}])[-1].get("content"), list))
            for body in requests_seen[1:]
        ],
        "stdout_has_conclusion": "固定夹具流程完成" in stdout,
        "run_dir_created": run_dir is not None,
        "report_exists": report_exists,
        "html_artifact_count": len(artifact_files),
        "html_artifacts_nonempty": artifact_files_nonempty,
        "artifact_path_in_report": artifact_path_in_report,
        "fixture_key_in_output": FIXTURE_KEY in stdout or FIXTURE_KEY in stderr,
        "stderr_lines": len(stderr.splitlines()),
        "violations": violations,
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if (
        proc.returncode != 0
        or violations
        or not report_exists
        or len(artifact_files) < 2
        or not artifact_files_nonempty
        or not artifact_path_in_report
        or FIXTURE_KEY in stdout
        or FIXTURE_KEY in stderr
    ):
        sys.exit(1)


if __name__ == "__main__":
    main()
