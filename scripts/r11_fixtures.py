#!/usr/bin/env python3
"""The R11 colour cases (scripts/fixtures/r11): base pages plus change descriptions.

Three base pages are stored whole (P1.json and P3.json, heat grids at k=5 and k=9, and P2.json, an area map); every
other case is a change
description in derived.json: {"base": <base id>, "sha256": <hash of the case file's bytes>, "ops": [...]}.

Change rules (applied in order to a copy of the base, each path a JSON pointer, RFC 6901):
  {"op": "replace", "path": p, "value": v}  the member or element at p must exist; it takes v, key order kept.
  {"op": "add", "path": p, "value": v}      object: p's last key must be new and goes last; array: insert at the
                                            index, or append for "-".
  {"op": "remove", "path": p}               the member or element at p must exist.
  {"op": "edit", "path": p, "at": s, "to": t}  the string at p must hold s exactly once; that s becomes t.
  {"op": "swap", "path": p, "map": {s: t}}  every occurrence of each key s in the string at p becomes its t, all in one
                                            pass (no t is rewritten again); each key must occur at least once.
A case's file text is json.dumps(case, indent=0, ensure_ascii=False) with no newline at the end, and its sha256 must
equal the recorded one, so every generated case is byte for byte the file it replaced.

  r11_fixtures.py dump           print {id: case file text} for all cases (the Rust tests read this)
  r11_fixtures.py write DIR      write each case as DIR/<id>.json
  r11_fixtures.py check DIR      compare each generated case with DIR/<id>.json byte for byte
  r11_fixtures.py derive F BASE  print the change description of case file F against base BASE (replace, add, remove
                                 and line-level edit ops; a swap is written by hand, as N1c's recolouring is)
"""
import copy
import difflib
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent / "fixtures" / "r11"
BASES = ("P1", "P2", "P3")


def text_of(case):
    return json.dumps(case, indent=0, ensure_ascii=False)


def _keys(path):
    if path == "":
        return []
    if not path.startswith("/"):
        raise ValueError(f"bad pointer {path!r}")
    return [k.replace("~1", "/").replace("~0", "~") for k in path[1:].split("/")]


def _parent(doc, path):
    keys = _keys(path)
    if not keys:
        raise ValueError("an op may not touch the whole page")
    node = doc
    for k in keys[:-1]:
        node = node[int(k)] if isinstance(node, list) else node[k]
    return node, keys[-1]


def apply(doc, ops):
    for op in ops:
        parent, k = _parent(doc, op["path"])
        kind = op["op"]
        if isinstance(parent, list):
            if kind == "add":
                parent.append(op["value"]) if k == "-" else parent.insert(int(k), op["value"])
                continue
            i = int(k)
            if not 0 <= i < len(parent):
                raise ValueError(f"{op['path']}: no element")
        elif kind == "add":
            if k in parent:
                raise ValueError(f"{op['path']}: add of a key already there")
            parent[k] = op["value"]
            continue
        else:
            i = k
            if k not in parent:
                raise ValueError(f"{op['path']}: no member")
        if kind == "replace":
            parent[i] = op["value"]
        elif kind == "remove":
            del parent[i]
        elif kind == "edit":
            s = parent[i]
            if not isinstance(s, str) or s.count(op["at"]) != 1:
                raise ValueError(f"{op['path']}: 'at' must occur exactly once")
            parent[i] = s.replace(op["at"], op["to"])
        elif kind == "swap":
            s, m = parent[i], op["map"]
            if not isinstance(s, str) or not m or any(k not in s for k in m):
                raise ValueError(f"{op['path']}: each 'map' key must occur in the string")
            parent[i] = re.sub("|".join(map(re.escape, sorted(m, key=len, reverse=True))), lambda x: m[x.group(0)], s)
        else:
            raise ValueError(f"unknown op {kind!r}")
    return doc


def cases():
    """Every case in id order as (id, file text); raises when a generated text's hash is not the recorded one."""
    out = {b: (HERE / f"{b}.json").read_text(encoding="utf-8") for b in BASES}
    derived = json.loads((HERE / "derived.json").read_text(encoding="utf-8"))
    for cid, d in derived["cases"].items():
        base = json.loads(out[d["base"]])
        text = text_of(apply(base, d["ops"]))
        got = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if got != d["sha256"]:
            raise SystemExit(f"r11_fixtures: {cid} generates sha256 {got}, recorded {d['sha256']}")
        out[cid] = text
    return dict(sorted(out.items()))


# ---- derive: the change description of a case against a base --------------------------------------------------------


def _ptr(keys):
    return "".join("/" + str(k).replace("~", "~0").replace("/", "~1") for k in keys)


def _str_edits(path, a, b):
    """Line-level edits from a to b, each 'at' widened by whole lines until it occurs once in the string it applies to."""
    al, bl = a.splitlines(keepends=True), b.splitlines(keepends=True)
    ops, cur = [], a
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, al, bl, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        # widen in the target lines the current string holds: lines before i1 are already b's, after i2 still a's
        lo, hi = i1, i2
        done = sum(len(x) for x in bl[:j1])
        while True:
            pre = "".join(bl[j1 - (i1 - lo):j1]) if lo < i1 else ""
            post = "".join(al[i2:hi])
            at = pre + "".join(al[i1:i2]) + post
            if at and cur.count(at) == 1:
                break
            if hi < len(al):
                hi += 1
            elif lo > 0:
                lo -= 1
            else:
                break
        to = pre + "".join(bl[j1:j2]) + post
        start = done - len(pre)
        assert cur[start:start + len(at)] == at
        cur = cur[:start] + to + cur[start + len(at):]
        ops.append({"op": "edit", "path": _ptr(path), "at": at, "to": to})
    assert cur == b
    return ops


def _diff(path, a, b):
    if type(a) is not type(b):
        return [{"op": "replace", "path": _ptr(path), "value": b}]
    if isinstance(a, dict):
        ka, kb = list(a), list(b)
        kept = [k for k in ka if k in b]
        if kept != [k for k in kb if k in a] or kb[:len(kept)] != kept:
            return [{"op": "replace", "path": _ptr(path), "value": b}]
        ops = [{"op": "remove", "path": _ptr(path + [k])} for k in ka if k not in b]
        for k in kept:
            ops += _diff(path + [k], a[k], b[k])
        ops += [{"op": "add", "path": _ptr(path + [k]), "value": b[k]} for k in kb[len(kept):]]
        return ops
    if isinstance(a, list) and len(a) == len(b):
        return [op for i in range(len(a)) for op in _diff(path + [i], a[i], b[i])]
    if isinstance(a, str) and a != b and len(a) > 400 and "\n" in a:
        return _str_edits(path, a, b)
    if a != b or (isinstance(a, float) and repr(a) != repr(b)):
        return [{"op": "replace", "path": _ptr(path), "value": b}]
    return []


def derive(case_text, base_text):
    case, base = json.loads(case_text), json.loads(base_text)
    ops = _diff([], base, case)
    if text_of(apply(copy.deepcopy(base), ops)) != case_text:
        raise SystemExit("r11_fixtures: the derived ops do not rebuild the case byte for byte")
    return ops


def main(argv):
    if argv[:1] == ["dump"]:
        sys.stdout.write(json.dumps(cases(), ensure_ascii=False))
    elif argv[:1] == ["write"] and len(argv) == 2:
        for cid, text in cases().items():
            (Path(argv[1]) / f"{cid}.json").write_bytes(text.encode("utf-8"))
    elif argv[:1] == ["check"] and len(argv) == 2:
        all_ = cases()
        bad = [c for c, t in all_.items() if (Path(argv[1]) / f"{c}.json").read_bytes() != t.encode("utf-8")]
        print(f"r11_fixtures: {len(all_) - len(bad)}/{len(all_)} byte for byte" + (f"; differ: {bad}" if bad else ""))
        return 1 if bad else 0
    elif argv[:1] == ["derive"] and len(argv) == 3:
        case_text = Path(argv[1]).read_text(encoding="utf-8")
        ops = derive(case_text, (HERE / f"{argv[2]}.json").read_text(encoding="utf-8"))
        sys.stdout.write(json.dumps({"base": argv[2], "sha256": hashlib.sha256(case_text.encode("utf-8")).hexdigest(), "ops": ops}, ensure_ascii=False))
    else:
        sys.stderr.write(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
