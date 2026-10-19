"""Synthetic folders for the measurement tests. Everything is built from fixed strings; nothing is read from a real run."""
import hashlib
import json
import os


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def write(root, rel, data):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    return path


def write_json(root, rel, value):
    return write(root, rel, json.dumps(value))


def make_relay(relay, requests, replies):
    """requests: list of message lists (one per req-N); replies: list of reply dicts (reply-N), None skips the file."""
    for n, messages in enumerate(requests, 1):
        write_json(relay, f"req-{n}.json", {"messages": messages, "tools": [{"name": "t", "input_schema": {"properties": {"alpha": {}, "beta": {}}}}]})
    for n, reply in enumerate(replies, 1):
        if reply is not None:
            write_json(relay, f"reply-{n}.json", reply)


def tool_use(use_id, name):
    return {"type": "tool_use", "id": use_id, "name": name, "input": {}}


def tool_result(use_id, is_error=False):
    return {"type": "tool_result", "tool_use_id": use_id, "content": "r", "is_error": is_error}


SVG = "<svg>one</svg>"
PLAN_REF = "plan-a"
HASH_A, HASH_B = "a" * 64, "b" * 64


def info_key(svg_text, plan_ref=PLAN_REF):
    return sha(compact({"plan_ref": plan_ref, "desktopSha": sha(svg_text.encode("utf-8"))}).encode("utf-8"))


def make_audit_pair(dest):
    """-> (saved, replay) folders with: an identical file, a same-name file whose only differences are a class-1 field and one other
    field, and an infographic whose content-hash name differs between the two sides (the hash-name mapping branch, with the
    name recipe recomputed on the saved side)."""
    saved, replay = os.path.join(dest, "saved"), os.path.join(dest, "replay")
    key = info_key(SVG)
    manifest = {"plan_ref": PLAN_REF, "hashes": {"desktop_sha256": sha(SVG.encode("utf-8"))}}
    for root, name in ((saved, key), (replay, HASH_B)):
        write_json(root, "maps/m.json", {"same": 1})
        write(root, f"infographics/{name}.svg", SVG)
        write_json(root, f"infographics/{name}.json", manifest)
    write_json(saved, "visualizations/v.json", {"ready_ms": 10, "x": 1})
    write_json(replay, "visualizations/v.json", {"ready_ms": 20, "x": 2})
    return saved, replay
