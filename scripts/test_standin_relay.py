#!/usr/bin/env python3
"""Tests for scripts/standin_relay.py (standard library only, no network beyond 127.0.0.1).

 1. a non-local host is refused at start-up and nothing listens;
 2. a text reply comes back as the official event sequence, in several chunks, and the files are written;
 3. tool_use replies: arguments arrive as partial JSON that joins to the original, ids are unique, stop_reason is tool_use;
 4. the second request's view holds only the new messages; the first holds system, tool names and messages;
 5. an error reply is an HTTP error with an error body;
 6. the fake key and the auth header names appear in no file and in neither output stream;
 7. --keepalive: headers and message_start come at once, pings keep a short read timeout from firing while the reply is late,
    the reply follows with one message_start in all, and an error reply becomes an in-stream error event.
The stream is read back with the same rules as src/anthropic_model.rs (block split on a blank line, `data:` lines, index-keyed blocks,
message_stop ends it), written here as an independent reader.
"""
import http.client
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.join(HERE, "standin_relay.py")
KEY = "test-key-not-real"


def slurp(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def start(workdir, *extra):
    proc = subprocess.Popen([sys.executable, RELAY, "--workdir", workdir, "--port", "0", *extra],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = proc.stdout.readline().strip()
    assert line.startswith("listening http://127.0.0.1:"), line
    return proc, int(line.rsplit(":", 1)[1])


def post(port, body, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request("POST", "/v1/messages", json.dumps(body), {"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    response = conn.getresponse()
    data = response.read().decode()
    conn.close()
    return response.status, response.getheader("Content-Type"), data


def events(data):
    out = []
    for block in data.split("\n\n"):
        lines = block.splitlines()
        payload = [l[5:].lstrip() for l in lines if l.startswith("data:")]
        if payload:
            out.append(json.loads("\n".join(payload)))
    return out


def read_like_agent(evs):
    """Rebuild the assistant message the way anthropic_model.rs does."""
    blocks, stop = {}, None
    for e in evs:
        kind, i = e["type"], e.get("index", 0)
        if kind == "content_block_start":
            b = e["content_block"]
            blocks[i] = {"type": b["type"], "text": "", "input": "", "id": b.get("id"), "name": b.get("name")}
        elif kind == "content_block_delta":
            d = e["delta"]
            if d["type"] == "text_delta":
                blocks[i]["text"] += d["text"]
            elif d["type"] == "thinking_delta":
                blocks[i]["text"] += d["thinking"]
            elif d["type"] == "input_json_delta":
                blocks[i]["input"] += d["partial_json"]
        elif kind == "message_delta":
            stop = e["delta"]["stop_reason"]
        elif kind == "message_stop":
            return blocks, stop
    raise AssertionError("no message_stop")


class Replier(threading.Thread):
    """Plays the person: when req-<n>.json appears, writes reply-<n>.json."""

    def __init__(self, workdir, n, reply, delay=0):
        super().__init__(daemon=True)
        self.workdir, self.n, self.reply, self.delay = workdir, n, reply, delay

    def run(self):
        path = os.path.join(self.workdir, f"req-{self.n}.view.md")
        deadline = time.time() + 20
        while not os.path.exists(path) and time.time() < deadline:
            time.sleep(0.05)
        time.sleep(self.delay)
        tmp = os.path.join(self.workdir, f"reply-{self.n}.tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(self.reply, handle)
        os.rename(tmp, os.path.join(self.workdir, f"reply-{self.n}.json"))


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="standin-relay-")
        self.proc, self.port = start(self.dir)

    def tearDown(self):
        self.proc.terminate()
        self.out, self.err = self.proc.communicate(timeout=10)
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_flow(self):
        tools = [{"name": "write_file", "description": "Write a staged file.\nSecond line.", "input_schema": {"type": "object"}, "cache_control": {"type": "ephemeral"}},
                 {"name": "read_file", "description": "Read a file.", "input_schema": {"type": "object"}}]
        first = {"model": "m", "max_tokens": 100, "stream": True, "system": [{"type": "text", "text": "You are the stand-in.", "cache_control": {"type": "ephemeral"}}],
                 "tools": tools, "messages": [{"role": "user", "content": [{"type": "text", "text": "Question one", "cache_control": {"type": "ephemeral"}}]}]}
        long_text = "Hello from the stand-in, " * 6
        Replier(self.dir, 1, {"thinking": "let me think", "text": long_text}).start()
        status, ctype, data = post(self.port, first)
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", ctype)
        evs = events(data)
        self.assertEqual([e["type"] for e in evs][:2], ["message_start", "content_block_start"])
        self.assertEqual([e["type"] for e in evs][-2:], ["message_delta", "message_stop"])
        deltas = [e for e in evs if e["type"] == "content_block_delta" and e["delta"]["type"] == "text_delta"]
        self.assertGreater(len(deltas), 1, "text goes out in several pieces")
        blocks, stop = read_like_agent(evs)
        self.assertEqual(stop, "end_turn")
        self.assertEqual([blocks[i]["type"] for i in sorted(blocks)], ["thinking", "text"])
        self.assertEqual(blocks[1]["text"], long_text)
        # every start has a stop and indexes are 0..n-1 in order
        self.assertEqual([e["index"] for e in evs if e["type"] == "content_block_start"], [0, 1])
        self.assertEqual([e["index"] for e in evs if e["type"] == "content_block_stop"], [0, 1])
        usage = evs[0]["message"]["usage"]
        self.assertEqual((usage["cache_read_input_tokens"], usage["cache_creation_input_tokens"]), (0, 0))

        # files and the first view
        full = json.loads(slurp(os.path.join(self.dir, "req-1.json")))
        self.assertEqual(full["messages"][0]["content"][0]["text"], "Question one")
        view1 = slurp(os.path.join(self.dir, "req-1.view.md"))
        for needle in ["You are the stand-in.", "- read_file: Read a file.", "- write_file: Write a staged file.", "Question one"]:
            self.assertIn(needle, view1)
        self.assertNotIn("Second line.", view1, "tool list shows only the one-line description")

        # second request: our reply echoed back, then two tool results; only the new messages are shown
        second = dict(first)
        second["messages"] = first["messages"] + [
            {"role": "assistant", "content": [{"type": "text", "text": long_text}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_x", "content": "RESULT-ALPHA", "is_error": True}]}]
        calls = [{"name": "write_file", "arguments": {"path": "a.json", "body": "x" * 70, "note": "中文"}},
                 {"name": "read_file", "arguments": {"path": "b.json"}, "id": "toolu_custom"}]
        Replier(self.dir, 2, {"tool_calls": calls}).start()
        status, _, data = post(self.port, second)
        self.assertEqual(status, 200)
        blocks, stop = read_like_agent(events(data))
        self.assertEqual(stop, "tool_use")
        got = [blocks[i] for i in sorted(blocks)]
        self.assertEqual([b["type"] for b in got], ["tool_use", "tool_use"])
        self.assertEqual([json.loads(b["input"]) for b in got], [c["arguments"] for c in calls])
        self.assertEqual(got[1]["id"], "toolu_custom")
        self.assertNotEqual(got[0]["id"], got[1]["id"])
        self.assertGreater(len([e for e in events(data) if e["type"] == "content_block_delta"]), 3, "arguments arrive in several fragments")
        view2 = slurp(os.path.join(self.dir, "req-2.view.md"))
        self.assertIn("RESULT-ALPHA", view2)
        self.assertIn("ERROR", view2)
        self.assertNotIn("Question one", view2, "old messages are not repeated")
        self.assertNotIn("You are the stand-in.", view2, "the system text is not repeated")
        self.assertIn("your previous reply, omitted", view2)
        self.assertNotIn("CHANGED", view2, "moving a cache marker is not a change")

        # a request whose history is not an append says so and shows everything
        third = dict(first)
        third["messages"] = [{"role": "user", "content": "A different start"}]
        Replier(self.dir, 3, {"text": "ok"}).start()
        post(self.port, third)
        view3 = slurp(os.path.join(self.dir, "req-3.view.md"))
        self.assertIn("NOT an append", view3)
        self.assertIn("A different start", view3)

    def test_error_reply(self):
        Replier(self.dir, 1, {"error": {"status": 429, "type": "rate_limit_error", "message": "slow down"}}).start()
        status, ctype, data = post(self.port, {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(status, 429)
        body = json.loads(data)
        self.assertEqual((body["type"], body["error"]["type"], body["error"]["message"]), ("error", "rate_limit_error", "slow down"))

    def test_no_secret_on_disk_or_in_output(self):
        Replier(self.dir, 1, {"text": "ok"}).start()
        post(self.port, {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
        self.proc.terminate()
        self.out, self.err = self.proc.communicate(timeout=10)
        self.proc.stdout = self.proc.stderr = None
        for name in os.listdir(self.dir):
            text = slurp(os.path.join(self.dir, name)).lower()
            for needle in (KEY, "x-api-key", "anthropic-version", "authorization"):
                self.assertNotIn(needle, text, f"{needle} in {name}")
        for stream in (self.out, self.err):
            for needle in (KEY, "x-api-key", "authorization"):
                self.assertNotIn(needle, stream.lower())

    def test_restart_continues_numbering(self):
        Replier(self.dir, 1, {"text": "ok"}).start()
        post(self.port, {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
        self.proc.terminate()
        self.proc.communicate(timeout=10)
        self.proc, self.port = start(self.dir)
        Replier(self.dir, 2, {"text": "second run"}).start()
        post(self.port, {"model": "m", "messages": [{"role": "user", "content": "again"}]})
        self.assertTrue(os.path.exists(os.path.join(self.dir, "req-2.json")))
        self.assertIn("again", slurp(os.path.join(self.dir, "req-2.json")))


class KeepaliveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="standin-relay-keepalive-")
        self.proc, self.port = start(self.dir, "--keepalive", "0.2")

    def tearDown(self):
        self.proc.terminate()
        self.proc.communicate(timeout=10)
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_late_reply_is_kept_alive(self):
        Replier(self.dir, 1, {"text": "late but fine"}, delay=1.5).start()
        # every read must see a byte within 0.6 s although the reply comes 1.5 s after the request
        status, ctype, data = post(self.port, {"model": "m", "messages": [{"role": "user", "content": "hi"}]}, timeout=0.6)
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", ctype)
        evs = events(data)
        kinds = [e["type"] for e in evs]
        self.assertEqual(kinds[0], "message_start")
        self.assertEqual(kinds.count("message_start"), 1)
        self.assertGreaterEqual(kinds.count("ping"), 3)
        blocks, stop = read_like_agent(evs)
        self.assertEqual((blocks[0]["text"], stop), ("late but fine", "end_turn"))

    def test_error_reply_is_an_event(self):
        Replier(self.dir, 1, {"error": {"status": 529, "type": "overloaded_error", "message": "busy"}}, delay=0.5).start()
        status, _, data = post(self.port, {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(status, 200)
        last = events(data)[-1]
        self.assertEqual((last["type"], last["error"]["type"], last["error"]["message"]), ("error", "overloaded_error", "busy"))


class RefusalTests(unittest.TestCase):
    def test_non_local_hosts_are_refused(self):
        for host in ["0.0.0.0", "192.168.1.20", "example.com", "::", ""]:
            workdir = tempfile.mkdtemp(prefix="standin-relay-refuse-")
            try:
                done = subprocess.run([sys.executable, RELAY, "--workdir", workdir, "--host", host, "--port", "0"],
                                      capture_output=True, text=True, timeout=20)
                self.assertEqual(done.returncode, 2, host)
                self.assertNotIn("listening", done.stdout)
                self.assertIn("refused", done.stderr)
            finally:
                shutil.rmtree(workdir, ignore_errors=True)

    def test_localhost_name_is_accepted(self):
        workdir = tempfile.mkdtemp(prefix="standin-relay-local-")
        try:
            proc, port = start(workdir, "--host", "localhost")
            self.assertGreater(port, 0)
            proc.terminate()
            proc.communicate(timeout=10)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
