#!/usr/bin/env python3
"""Local stand-in relay for the Messages API: a person (or a session) writes the model's replies by hand.

Test tool only. Python standard library only. It is not part of any product path.

Usage
    python3 scripts/standin_relay.py --workdir DIR [--host 127.0.0.1] [--port 0] [--keepalive SECONDS]
    python3 scripts/standin_relay.py --summary DIR

    The host must be 127.0.0.1 or localhost (the same rule as is_loopback in src/anthropic_model.rs); anything else
    is refused at start-up with exit code 2. Port 0 picks a free port. The first stdout line is
    `listening http://127.0.0.1:<port>`; point the model's base URL there (the path /v1/messages is served).

What it does for each POST /v1/messages request, numbered 1, 2, 3, ... in arrival order
    1. writes DIR/req-<n>.json       the full request body, pretty-printed. Headers are never stored or printed.
    2. writes DIR/req-<n>.view.md    a short view for the person answering:
                                     request 1: the full system text, the tool list (name and one-line description), all messages;
                                     later ones: only the messages added since the previous request (the assistant message that
                                     is our own previous reply is left out and noted). If the history is no longer an append of
                                     the previous one, the view says so and shows every message.
    3. waits, with no upper limit, for DIR/reply-<n>.json to appear and parse (a file that is still being written is retried).
       Every 30 seconds it prints `waiting for reply-<n>` to stderr.
    4. renders the reply as a streaming Messages response (server-sent events, official event order) and sends it.
    With --keepalive N (default 0, off) the 200 status, the headers and message_start go out as soon as the request
    arrives, and a `ping` event follows every N seconds until the reply file appears, as a real provider streams while
    the model thinks; the client's idle timer then never fires on a slow person. An "error" reply is then sent as an
    in-stream `error` event, since the status line is already out. Off, nothing changes.
    The reply file is left in place. A relay started again in the same directory continues after the highest existing req-<n>.json.

Reply file (JSON object, every key optional)
    {
      "thinking": "text",                          a thinking block first (a placeholder signature is added)
      "text": "text",                              a text block, sent in several chunks
      "tool_calls": [                              zero or more tool_use blocks, in order, after the text
        {"name": "tool_name", "arguments": {...}, "id": "optional"}
      ],
      "stop": "tool_use" | "end_turn" | "max_tokens" | ...,
                                                   stop_reason; default is tool_use when there are tool_calls, else end_turn
      "error": {"status": 429, "type": "rate_limit_error", "message": "text"}
                                                   instead of a stream: answer with that HTTP status and an error body
    }
    Usage numbers in the stream are placeholders (request bytes // 4 for input, reply bytes // 4 for output; cache fields are 0)
    and are not measurements.

Timing (DIR/timing.jsonl)
    Each relay start appends one header line {"relay_started_at": "<UTC ISO>"}. For every numbered request it then appends one line
    {"n": 1, "received": s, "request_written": s, "reply_read": s, "response_sent": s}, written when the response is finished
    (also on the --keepalive path and for an injected "error" reply). Every time is seconds since that relay start, monotonic,
    3 decimals. A time that was never reached (the client went away first) is null. Only these numbers are stored, never headers.
      received         the POST body was read
      request_written  req-<n>.json and req-<n>.view.md are on disk
      reply_read       reply-<n>.json was read and parsed
      response_sent    the last byte was sent
    A restarted relay keeps appending to the same file; times are only compared inside one relay start (between a header line and
    the next one), because each start has its own zero.

    --summary DIR prints one JSON object and exits (no server is started):
      requests          number of timing lines
      standin_wait_s    sum of reply_read - request_written: how long the stand-in (the person or session) took to answer
      between_turns_s   sum of received(n+1) - response_sent(n): the program's own time between two model turns
      relay_overhead_s  sum of (request_written - received) + (response_sent - reply_read): the relay's own work
    Not measured here: the program time before request 1 and after the last reply. Take that from the harness's own wall clock:
    program seconds = harness wall seconds - standin_wait_s - relay_overhead_s, and per turn between_turns_s / (requests - 1).

Authentication headers (x-api-key, authorization, ...) are dropped before anything is written; only the JSON body is kept.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCAL_HOSTS = {"127.0.0.1": "127.0.0.1", "localhost": "127.0.0.1"}
CHUNK = 24  # characters per text / tool-argument fragment
WAIT_NOTE_SECONDS = 30
POLL_SECONDS = 0.1
TIMING_KEYS = ("received", "request_written", "reply_read", "response_sent")


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def chunks(text, size=CHUNK):
    return [text[i:i + size] for i in range(0, len(text), size)] or [""]


def render_stream(reply, request_bytes, n):
    """The Messages-API event sequence for one reply, as a list of encoded events."""
    blocks = []
    if reply.get("thinking"):
        blocks.append(("thinking", reply["thinking"]))
    if reply.get("text"):
        blocks.append(("text", reply["text"]))
    calls = reply.get("tool_calls") or []
    for i, call in enumerate(calls):
        blocks.append(("tool_use", (call.get("id") or f"toolu_standin_{n}_{i + 1}", call["name"], call.get("arguments", {}))))
    stop = reply.get("stop") or ("tool_use" if calls else "end_turn")
    out_bytes = len(json.dumps(reply, ensure_ascii=False).encode())
    events = [sse("message_start", {"type": "message_start", "message": {
        "id": f"msg_standin_{n}", "type": "message", "role": "assistant", "content": [], "model": "standin",
        "stop_reason": None, "stop_sequence": None,
        "usage": {"input_tokens": request_bytes // 4, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}})]
    for index, (kind, body) in enumerate(blocks):
        if kind == "thinking":
            events.append(sse("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "thinking", "thinking": ""}}))
            for part in chunks(body):
                events.append(sse("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "thinking_delta", "thinking": part}}))
            events.append(sse("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "signature_delta", "signature": "standin-placeholder-signature"}}))
        elif kind == "text":
            events.append(sse("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}))
            for part in chunks(body):
                events.append(sse("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": part}}))
        else:
            call_id, name, arguments = body
            events.append(sse("content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": call_id, "name": name, "input": {}}}))
            for part in chunks(json.dumps(arguments, ensure_ascii=False)):
                events.append(sse("content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": part}}))
        events.append(sse("content_block_stop", {"type": "content_block_stop", "index": index}))
    events.append(sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": max(1, out_bytes // 4)}}))
    events.append(sse("message_stop", {"type": "message_stop"}))
    return events


def text_of(content):
    if isinstance(content, str):
        return content
    return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


def render_block(block):
    kind = block.get("type")
    if kind == "text":
        return block.get("text", "")
    if kind == "thinking":
        return "[thinking] " + block.get("thinking", "")
    if kind == "tool_use":
        return f"[tool_use {block.get('name')} id={block.get('id')}] " + json.dumps(block.get("input", {}), ensure_ascii=False)
    if kind == "tool_result":
        inner = block.get("content")
        flag = " ERROR" if block.get("is_error") else ""
        return f"[tool_result{flag} for {block.get('tool_use_id')}]\n" + (inner if isinstance(inner, str) else text_of(inner or []))
    return json.dumps(block, ensure_ascii=False)


def render_message(index, message):
    content = message.get("content")
    body = content if isinstance(content, str) else "\n".join(render_block(b) for b in content or [])
    return f"### message {index} ({message.get('role')})\n\n{body}\n"


def system_text(request):
    system = request.get("system")
    return system if isinstance(system, str) else text_of(system or [])


def tool_list(request):
    lines = []
    for tool in request.get("tools") or []:
        first = (tool.get("description") or "").strip().splitlines()
        lines.append(f"- {tool.get('name')}: {(first[0] if first else '')[:200]}")
    return lines


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def stripped(value):
    """A message without cache markers, so that moving a marker does not look like a changed history."""
    if isinstance(value, dict):
        return {k: stripped(v) for k, v in value.items() if k != "cache_control"}
    if isinstance(value, list):
        return [stripped(v) for v in value]
    return value


def build_view(n, request, previous):
    messages = request.get("messages") or []
    head = [f"# request {n}", "",
            f"model: {request.get('model')}  max_tokens: {request.get('max_tokens')}  thinking: {json.dumps(request.get('thinking'))}",
            f"system hash: {digest(system_text(request))}  tools hash: {digest(request.get('tools'))}  messages: {len(messages)}", ""]
    if previous is None:
        head += ["## system", "", system_text(request), "", "## tools", ""] + tool_list(request) + ["", "## messages", ""]
        shown = list(enumerate(messages))
    else:
        notes = []
        if digest(system_text(request)) != previous["system"]:
            notes.append("system text CHANGED since the previous request")
        if digest(request.get("tools")) != previous["tools"]:
            notes.append("tool list CHANGED since the previous request")
        prior = previous["messages"]
        appended = len(messages) >= len(prior) and [digest(stripped(m)) for m in messages[:len(prior)]] == prior
        if appended:
            start = len(prior)
            if start < len(messages) and messages[start].get("role") == "assistant":
                notes.append("message %d is your previous reply, omitted" % start)
                start += 1
        else:
            start = 0
            notes.append("history is NOT an append of the previous request; every message is shown")
        shown = list(enumerate(messages))[start:]
        head += [f"(only what is new since request {previous['n']})"] + [f"note: {x}" for x in notes] + ["", "## new messages", ""]
    return "\n".join(head) + "\n".join(render_message(i, m) for i, m in shown) + "\n"


class Relay:
    def __init__(self, workdir):
        self.workdir = workdir
        self.lock = threading.Lock()
        existing = [int(m.group(1)) for f in os.listdir(workdir) if (m := re.fullmatch(r"req-(\d+)\.json", f))]
        self.counter = max(existing, default=0)
        self.previous = None
        self.t0 = time.monotonic()
        self.timing_path = os.path.join(workdir, "timing.jsonl")
        self.append_timing({"relay_started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    def now(self):
        return round(time.monotonic() - self.t0, 3)

    def append_timing(self, record):
        line = (json.dumps(record) + "\n").encode()
        with self.lock:
            fd = os.open(self.timing_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            try:
                os.write(fd, line)
            finally:
                os.close(fd)

    def record_timing(self, n, marks):
        self.append_timing({"n": n, **{k: marks.get(k) for k in TIMING_KEYS}})

    def take(self, request):
        with self.lock:
            self.counter += 1
            n = self.counter
            previous = self.previous
            self.previous = {"n": n, "system": digest(system_text(request)), "tools": digest(request.get("tools")),
                             "messages": [digest(stripped(m)) for m in request.get("messages") or []]}
            return n, previous

    def wait_reply(self, n, tick=None, every=0):
        path = os.path.join(self.workdir, f"reply-{n}.json")
        last_note = last_tick = time.monotonic()
        while True:
            if os.path.exists(path):
                try:
                    with open(path, encoding="utf-8") as handle:
                        reply = json.load(handle)
                    if isinstance(reply, dict):
                        return reply
                except (ValueError, OSError):
                    pass  # still being written
            if time.monotonic() - last_note >= WAIT_NOTE_SECONDS:
                print(f"waiting for reply-{n}", file=sys.stderr, flush=True)
                last_note = time.monotonic()
            if tick and time.monotonic() - last_tick >= every:
                tick()
                last_tick = time.monotonic()
            time.sleep(POLL_SECONDS)


def make_handler(relay, keepalive=0):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, format, *args):
            pass  # no request line, no headers

        def send_json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path.split("?")[0] != "/v1/messages":
                return self.send_json(404, {"type": "error", "error": {"type": "not_found_error", "message": "only /v1/messages is served"}})
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            received = relay.now()
            try:
                request = json.loads(raw)
            except ValueError:
                return self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "body is not JSON"}})
            n, previous = relay.take(request)
            marks = {"received": received}
            try:
                return self.serve_request(n, previous, request, raw, marks)
            finally:  # response_sent is only set where the last byte went out; a missing time stays null
                try:
                    relay.record_timing(n, marks)
                except OSError as error:
                    print(f"timing line for request {n} not written: {error.__class__.__name__}", file=sys.stderr, flush=True)

        def serve_request(self, n, previous, request, raw, marks):
            with open(os.path.join(relay.workdir, f"req-{n}.json"), "w", encoding="utf-8") as handle:
                json.dump(request, handle, ensure_ascii=False, indent=2)
            with open(os.path.join(relay.workdir, f"req-{n}.view.md"), "w", encoding="utf-8") as handle:
                handle.write(build_view(n, request, previous))
            marks["request_written"] = relay.now()
            print(f"request {n} written ({len(raw)} bytes)", file=sys.stderr, flush=True)
            if keepalive > 0:
                return self.stream_kept_alive(n, len(raw), marks)
            reply = relay.wait_reply(n)
            marks["reply_read"] = relay.now()
            failure = reply.get("error")
            if failure:
                self.send_json(int(failure.get("status", 500)), {"type": "error", "error": {
                    "type": failure.get("type", "api_error"), "message": failure.get("message", "injected by the stand-in relay")}})
                marks["response_sent"] = relay.now()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                for event in render_stream(reply, len(raw), n):
                    self.wfile.write(event)
                    self.wfile.flush()
                marks["response_sent"] = relay.now()
            except (BrokenPipeError, ConnectionResetError):
                print(f"client went away during reply-{n}", file=sys.stderr, flush=True)

        def stream_kept_alive(self, n, request_bytes, marks):
            def send(event):
                self.wfile.write(event)
                self.wfile.flush()
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                send(render_stream({}, request_bytes, n)[0])
                reply = relay.wait_reply(n, tick=lambda: send(sse("ping", {"type": "ping"})), every=keepalive)
                marks["reply_read"] = relay.now()
                failure = reply.get("error")
                if failure:
                    send(sse("error", {"type": "error", "error": {
                        "type": failure.get("type", "api_error"), "message": failure.get("message", "injected by the stand-in relay")}}))
                else:
                    for event in render_stream(reply, request_bytes, n)[1:]:
                        send(event)
                marks["response_sent"] = relay.now()
            except (BrokenPipeError, ConnectionResetError):
                print(f"client went away during reply-{n}", file=sys.stderr, flush=True)

    return Handler


def summarize(workdir):
    """Sums over DIR/timing.jsonl; between-turn gaps are only taken inside one relay start (one clock)."""
    rows, segment = [], 0
    with open(os.path.join(workdir, "timing.jsonl"), encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue  # a blank line or a last line cut off by a killed relay
            if "relay_started_at" in record:
                segment += 1
            elif "n" in record:
                rows.append((segment, record))
    rows.sort(key=lambda item: (item[0], item[1]["n"]))
    wait = overhead = between = 0.0
    for index, (seg, row) in enumerate(rows):
        if row["reply_read"] is not None and row["request_written"] is not None:
            wait += row["reply_read"] - row["request_written"]
        if None not in (row["request_written"], row["received"]):
            overhead += row["request_written"] - row["received"]
        if None not in (row["response_sent"], row["reply_read"]):
            overhead += row["response_sent"] - row["reply_read"]
        if index + 1 < len(rows) and rows[index + 1][0] == seg and row["response_sent"] is not None \
                and rows[index + 1][1]["received"] is not None:
            between += rows[index + 1][1]["received"] - row["response_sent"]
    return {"requests": len(rows), "standin_wait_s": round(wait, 3), "between_turns_s": round(between, 3), "relay_overhead_s": round(overhead, 3)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="stand-in relay for the Messages API (local only)")
    parser.add_argument("--workdir")
    parser.add_argument("--summary", metavar="DIR", help="print the timing sums of DIR/timing.jsonl as one JSON object and exit")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--keepalive", type=float, default=0, help="seconds between ping events while waiting; 0 is off")
    args = parser.parse_args(argv)
    if args.summary:
        try:
            print(json.dumps(summarize(args.summary)))
        except OSError as error:
            print(f"cannot read timing.jsonl in {args.summary}: {error.__class__.__name__}", file=sys.stderr)
            return 1
        return 0
    if not args.workdir:
        parser.error("--workdir is required unless --summary is given")
    if args.host not in LOCAL_HOSTS:
        print(f"refused: the relay only listens on this machine (127.0.0.1 or localhost), not {args.host!r}", file=sys.stderr)
        return 2
    os.makedirs(args.workdir, exist_ok=True)
    server = ThreadingHTTPServer((LOCAL_HOSTS[args.host], args.port), make_handler(Relay(args.workdir), args.keepalive))
    server.daemon_threads = True
    print(f"listening http://{LOCAL_HOSTS[args.host]}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
