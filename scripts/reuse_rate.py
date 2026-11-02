"""Reuse rate per layout step (v3): the check kinds a step uses, registered before it ("existing") or added by it ("new"),
and the unregistered checks at its head, which must be none.

The kinds are the core's registry (src/next_ledger.rs CHECK_REGISTRY: a kind's name, the vocabulary it is read by, its
functions): a kind is a registry entry, and each item of a vocabulary a kind names (the strings of next_tree.rs
CHECK_KINDS, FIELD_KINDS, FOR_EACH, SCALE_KINDS, SHAPES, its CHANNELS, the op arms of its Compute; next_ledger.rs
RELATIONS, CLAIM_WORDS; the rule arms of next_tree_gen.rs leaf_stops, which node-bindings.json's leaf_stops name) is a
kind of its own. A kind is present at a commit when one of its fns is a non-test fn there
(a vocabulary item: when that commit's vocabulary holds it). A step uses a present kind its added lines call a function
of, or name a vocabulary item of (a string literal). Unregistered checks: the non-test fns of the three core files
(next_ledger.rs, next_facts.rs, next_tree.rs) in no kind and not in CHECK_HELPERS (next_ledger.rs's test
every_check_is_a_registered_kind holds that at 0).

A step whose head has no registry is marked pre-registry and classified by the registry at --registry (default: the
working tree): each non-test fn at its base and head maps to the kind that lists it, so every step counts in the same unit;
fns at its head that registry no longer lists are reported as unmapped. Such a step also prints v2 (vocabulary plus every
non-test fn as a kind, #[cfg(test)] items skipped) for comparison.
Read-only: git show and git diff only; a commit named WORKTREE reads the working tree.
Usage: python3 -I scripts/reuse_rate.py [--repo DIR] [--registry COMMIT] [BASE HEAD NAME]...  (no steps: the steps below)"""
import os
import re
import subprocess
import sys

CORE = ("src/next_ledger.rs", "src/next_tree.rs", "src/next_facts.rs")
SHORT = {"src/next_ledger.rs": "ledger", "src/next_facts.rs": "facts", "src/next_tree.rs": "tree"}
DIFFED = ("runtime/page_tree/node-bindings.json", "src/next_tree_gen.rs", *CORE, "src/next_leaf.rs", "src/next_visual.rs",
          "runtime/leaves_py")
STEPS = [("P4a-1 bars", "9e7dbc20", "2b069404"), ("P4a-2 map circles and change bars", "3316afa1", "144054b8"),
         ("P4b composition", "144054b8", "ee1cffe4"), ("P4b-5 share comparison and scope", "c72a2d74", "99b701b9")]
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_shown = {}


def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True).stdout


def show(c, f):
    if (c, f) not in _shown:
        if c == "WORKTREE":
            p = os.path.join(REPO, f)
            _shown[c, f] = open(p, encoding="utf8").read() if os.path.exists(p) else ""
        else:
            _shown[c, f] = git("show", f"{c}:{f}")
    return _shown[c, f]


# ---- reading Rust source (as the registry test reads it)

def code_only(t):
    """t with the insides of comments, string and char literals blanked (lengths kept)."""
    out, i, n = [], 0, len(t)
    while i < n:
        c = t[i]
        ident = i > 0 and (t[i - 1].isalnum() or t[i - 1] == "_")
        if t.startswith("//", i):
            j = t.find("\n", i); j = n if j < 0 else j
        elif t.startswith("/*", i):
            j = t.find("*/", i + 2); j = n if j < 0 else j + 2
        elif c == "r" and not ident and re.match(r'r#*"', t[i:i + 40]):
            h = re.match(r'r(#*)"', t[i:]).group(1); j = t.find('"' + h, i + len(h) + 2); j = n if j < 0 else j + 1 + len(h)
        elif c == '"':
            j = i + 1
            while j < n and t[j] != '"': j += 2 if t[j] == "\\" else 1
            j += 1
        elif c == "'" and (t[i + 1:i + 2] == "\\" or t[i + 2:i + 3] == "'"):
            j = t.find("'", i + 1)
            if t[i + 1:i + 3] == "\\'": j = t.find("'", i + 3)
            j = n if j < 0 else j + 1
        else:
            out.append(c); i += 1; continue
        out.append(re.sub(r"[^\n]", " ", t[i:j])); i = j
    return "".join(out)


def non_test_fns(t):
    """Every `fn` name outside an item marked #[cfg(test)] (that item skipped to its closing brace or `;`)."""
    c, out, i = code_only(t), [], 0
    for m in re.finditer(r"#\[cfg\(test\)\]|(?<![\w])fn\s+(\w+)", c):
        if m.start() < i: continue
        if m.group(0).startswith("#"):
            j, depth = m.end(), 0
            while j < len(c):
                if c[j] == ";" and depth == 0: break
                if c[j] == "{": depth += 1
                elif c[j] == "}":
                    depth -= 1
                    if depth == 0: break
                j += 1
            i = j
        else:
            out.append(m.group(1))
    return out


def fns_at(c):
    """{"ledger::name", ...}: the non-test fns of the core files at c."""
    return {f"{SHORT[f]}::{n}" for f in CORE for n in non_test_fns(show(c, f))}


# ---- the registry

def registry(c):
    """(kinds {name: (vocab, [fn])}, helpers [fn]) of next_ledger.rs at c, or None when it has no registry."""
    led = show(c, "src/next_ledger.rs")
    if "pub const CHECK_REGISTRY" not in led: return None
    reg = led[led.index("pub const CHECK_REGISTRY"):]
    reg = reg[:reg.index("\n];")]
    kinds = {}
    for name, vocab, fns in re.findall(r'^\s*\("([\w.]+)", "([^"]*)", &\[([^\]]*)\]\),', reg, re.M):
        kinds[name] = (vocab, re.findall(r'"(\w+::\w+)"', fns))
    hel = led[led.index("pub const CHECK_HELPERS"):]
    return kinds, re.findall(r'"(\w+::\w+)"', hel[:hel.index("\n];")])


def vocab_items(c, ref):
    """The items at c of a vocabulary a kind names (`next_tree::CHECK_KINDS`, `next_tree::Compute ops`, ...)."""
    file, _, name = ref.partition("::")
    name = name.split(" ")[0]
    t = show(c, f"src/{file}.rs")
    if name == "CHANNELS":
        m = re.search(r"const CHANNELS: \[Channel; \d+\] = \[(.*?)\n\];", t, re.S)
        return [f"{s[0]}/{s[2]}/{s[4]}" for s in re.findall(r'^\s*\("([a-z_]+)",.*?"(\w+)", "(\w+)", "(\w+)", "([\w.]+)"\),', m.group(1), re.M)] if m else []
    if name == "leaf_stops":  # the rule arms of next_tree_gen.rs fn leaf_stops
        i = t.find("\nfn leaf_stops(")
        if i < 0: return []
        body = t[i:]; j = body.find("\nfn ", 1); body = body if j < 0 else body[:j]
        return [m for m in re.findall(r'^\s*"(\w+)" =>', body, re.M)]
    if name == "Compute":
        seg = t[t.find('let op = q.g("op")'):t.find('not ported in this checker')]
        return sorted({o for arm in re.findall(r'^\s*((?:"\w+"\s*\|\s*)*"\w+")\s*=>', seg, re.M) for o in re.findall(r'"(\w+)"', arm)})
    m = re.search(rf"const {name}: [^=]*=\s*\[(.*?)\];", t, re.S)
    if not m: return []
    if name in ("RELATIONS", "CLAIM_WORDS", "SHAPES"):  # a table of (word, ...): its first strings
        return re.findall(r'\(\s*"(\w+)"', m.group(1))
    return re.findall(r'"([^"]+)"', m.group(1))


def kinds_at(c, reg):
    """{kind: (fn names, vocabulary items)} present at c, classified by the registry reg (from registry())."""
    have = fns_at(c) | {f"tree_gen::{n}" for n in non_test_fns(show(c, "src/next_tree_gen.rs"))}
    out = {}
    for name, (vocab, fns) in reg[0].items():
        if any(f in have for f in fns): out[f"kind:{name}"] = ([f.split("::")[1] for f in fns if f in have], [])
        if vocab:
            for item in vocab_items(c, vocab): out[f"{name}:{item}"] = ([], [item])
    return out


def unlisted(c, reg):
    """The non-test fns at c the registry reg holds in no kind and not as a helper."""
    listed = {f for _, fns in reg[0].values() for f in fns} | set(reg[1])
    return sorted(fns_at(c) - listed)


# ---- v2, kept for comparison (it now skips #[cfg(test)] items instead of cutting the file at the first one)

def vocab_v2(c):
    t = show(c, "src/next_tree.rs"); led = show(c, "src/next_ledger.rs")
    v = {}
    for name in ("CHECK_KINDS", "FIELD_KINDS", "SCALE_KINDS", "FOR_EACH"):
        m = re.search(rf"const {name}: \[&str; \d+\] =\s*\[(.*?)\];", t, re.S)
        if m:
            for s in re.findall(r'"([^"]+)"', m.group(1)): v[s] = name
    for s in vocab_items(c, "next_tree::CHANNELS"): v[f"channel:{s}"] = "CHANNELS"
    for o in vocab_items(c, "next_tree::Compute ops"): v[f"op:{o}"] = "OPS"
    for f in re.findall(r"pub fn (check_\w+)\(", led): v[f"ledger:{f}"] = "LEDGER"
    b = show(c, "runtime/page_tree/node-bindings.json")
    for m in re.findall(r'"leaf_stops":\s*\[([^\]]*)\]', b):
        for s in re.findall(r'"(\w+)"', m): v[f"stop:{s}"] = "STOP"
    for f in sorted(fns_at(c)): v.setdefault(f"fn:{f.split('::')[1]}", "FN")
    return v


def v2(b, h, a):
    vb, vh = vocab_v2(b), vocab_v2(h)
    new = [k for k in vh if k not in vb]
    def named(k):
        t = re.escape(k.split(":", 1)[1].split("/")[0] if ":" in k else k)
        return bool(re.search(rf"\b{t}\(", a)) if k.startswith("fn:") else bool(re.search(rf'"{t}"|\b{t}\(', a))
    old = [k for k in vb if k in vh and named(k)]
    return len(old), len(new)


# ---- a step

def added(b, h):
    d = git("diff", "-U0", b, "--", *DIFFED) if h == "WORKTREE" else git("diff", "-U0", b, h, "--", *DIFFED)
    return "\n".join(x[1:] for x in d.splitlines() if x.startswith("+") and not x.startswith("+++"))


def pct(o, n):
    return f"{o / (o + n):.0%}" if o or n else "n/a"


def step(name, b, h, ref):
    """Kinds classified by the head's registry, or (pre-registry) by the registry at ref."""
    a = added(b, h)
    reg, tag = registry(h), ""
    if reg is None: reg, tag = registry(ref), f" [pre-registry: classified by the registry at {ref}]"
    kb, kh = kinds_at(b, reg), kinds_at(h, reg)
    def used(k):
        fns, items = kh[k]
        return any(re.search(rf"\b{re.escape(f)}\(", a) for f in fns) or any(re.search(rf'"{re.escape(i)}"', a) for i in items)
    new = sorted(k for k in kh if k not in kb)
    old = sorted(k for k in kh if k in kb and used(k))
    un = unlisted(h, reg)
    print(f"{name} ({b}..{h}){tag}: registered kinds used: existing {len(old)}, new {len(new)}; reuse {pct(len(old), len(new))}")
    print(f"   existing: {', '.join(old)}")
    print(f"   new: {', '.join(new)}")
    if tag:
        print(f"   unmapped (fns at the head the registry no longer lists): {len(un)}" + (f" {', '.join(un)}" if un else ""))
        o2, n2 = v2(b, h, a)
        print(f"   v2 with the cfg(test) parse fixed, for comparison: existing {o2}, new {n2}; reuse {pct(o2, n2)}")
    else:
        print(f"   unregistered checks: {len(un)}" + (f" {', '.join(un)}" if un else ""))


def main(argv):
    global REPO
    ref = "WORKTREE"
    while argv[:1] in (["--repo"], ["--registry"]):
        if argv[0] == "--repo": REPO = argv[1]
        else: ref = argv[1]
        argv = argv[2:]
    if registry(ref) is None: sys.exit(f"no CHECK_REGISTRY at {ref}; pass --registry COMMIT")
    steps = [(argv[i + 2], argv[i], argv[i + 1]) for i in range(0, len(argv), 3)] if argv else STEPS
    for s in steps: step(*s, ref)


if __name__ == "__main__":
    main(sys.argv[1:])
