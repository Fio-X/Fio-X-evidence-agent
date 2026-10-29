"""Facts from declared queries: every number on the page is a key here, computed from a table row set.
Ops are generic (value, sum, share, change, times, peak, last, count); nothing names a topic.
Each fact keeps its provenance (table, filter, time) for the completion check."""
import csv, html, json, os, re, sys, unicodedata
from words import Refused, word

D = os.path.dirname(os.path.abspath(__file__))
MEMBERS = None  # the aggregate's member codes, from the request (run.py sets them; layer 1 has them from the knowledge group)

TABLES = None  # the request's rows as tables, set by run.py; None reads the csv files as before
LEDGER = None  # the request's ledger entries {src: text}, set by run.py; None formats the numbers here as before
SRCS = {}  # id of each request row's cell -> its src, set by run.py, so an entry read from a record's cell can name it
SEGS = None  # layer 1's segments of the drafted wordings {"dek", "unit"} (knobs.segs, next_facts::wording_segs), set by run.py

def text(src):
    """A ledger entry's text as the request gives it (for sizing a label); a src the request lacks refuses the layer."""
    if src not in LEDGER: raise Refused(f"{src} is not in the request's ledger")
    return LEDGER[src]

def entry(src, tag="b", cls="n"):
    """A ledger entry printed as the request gives it, marked with its src; a src the request lacks refuses the layer."""
    c = f' class="{cls}"' if cls else ""
    return f'<{tag}{c} data-src="{html.escape(src)}">{html.escape(text(src), quote=False)}</{tag}>'

def name_mark(r):
    """A record's name printed whole (a route's, which may hold a digit): with a ledger the attribute marking it with its row's name_zh
    entry, which must print as given; without one nothing."""
    if LEDGER is None: return ""
    src = f"{cell_src(r)}:name_zh"
    if text(src) != r["name_zh"]: raise Refused(f"{src}: the ledger gives {text(src)!r}, the row {r['name_zh']!r}")
    return f' data-src="{html.escape(src)}"'

def digit(text):
    """Whether a text holds a digit (any numeric character, as layer 1 counts one) outside its {key} placeholders."""
    return any(unicodedata.category(ch) in ("Nd", "Nl", "No") for ch in re.sub(r"\{[A-Za-z_][\w.]*\}", "", text))

def worded(spec, F, which, wording):
    """A drafted wording (which: "dek", "unit" or "notes.<i>", the hero's i-th note) filled like any text. With a ledger it prints from layer 1's segments:
    {"w": words} filled, {"src": entry} the date entry marked; segments that do not spell the wording, or leave a digit
    in their words, refuse, and so does a wording with a digit and no segments (layer 1's error, when it sent one)."""
    if LEDGER is None: return fill(spec, F, wording)
    segs = (SEGS or {}).get(which)
    if isinstance(segs, dict): raise Refused(f"{which}: {segs.get('error') or segs}")
    if segs is None:
        if digit(wording): raise Refused(f"{which}: {wording!r} holds a digit and the request gives no segments for it")
        return fill(spec, F, wording)
    if "".join(s["w"] if "w" in s else text(s["src"]) for s in segs) != wording:
        raise Refused(f"{which}: the request's segments do not spell {wording!r}")
    if any(digit(s["w"]) for s in segs if "w" in s): raise Refused(f"{which}: a segment's words hold a digit")
    return "".join(fill(spec, F, s["w"]) if "w" in s else entry(s["src"], "span", None) for s in segs)

def members():
    """The aggregate's member codes the request gives; a query that leaves the members out refuses without them."""
    if MEMBERS is None: raise Refused("the request gives no members")
    return MEMBERS

def cell_src(cell):
    """The src of the request row a record's cell dict was built from (record:<table>/<i>); a cell no request row built
    (a copy, or a row read from a file) refuses the layer."""
    src = SRCS.get(id(cell))
    if src is None: raise Refused("a record cell that no request row built")
    return src

def records(path):
    """A sourced list's rows: from the request when run.py set them, else from the csv file."""
    if TABLES is not None: return TABLES[path]
    return list(csv.DictReader(open(os.path.join(D, path), encoding="utf-8")))

def load(spec):
    if TABLES is not None: return {name: [r for r in TABLES[name] if r.get("OBS_VALUE") not in ("", None)] for name in spec["tables"]}
    T = {}
    for name, t in spec["tables"].items():
        rows = [r for r in csv.DictReader(open(os.path.join(D, t["csv"]))) if r.get("OBS_VALUE") not in ("", None)]
        T[name] = rows
    return T

def _rows(T, q):
    out = T[q["table"]]
    for k, v in q.get("filter", {}).items():
        vs = set(v) if isinstance(v, list) else {v}
        out = [r for r in out if r[k] in vs]
    return out

def _sel(rows, time):
    return [r for r in rows if r["TIME_PERIOD"] == time]

DERIVED = ("share", "change", "times", "minus", "plus")


def ordered(facts):
    """The fact keys with each derived fact after the two it reads, the given order kept where it already is (a layer 1
    spec is keyed, not ordered); one that reads a key no fact has keeps its place and fails where it reads it."""
    out, done, left = [], set(), list(facts)
    while left:
        for k in left:
            q = facts[k]
            if q.get("op", "value") not in DERIVED or {q["a"], q["b"]} <= done:
                out.append(k); done.add(k)
        rest = [k for k in left if k not in done]
        if len(rest) == len(left): return out + rest
        left = rest
    return out


def compute(spec, T):
    F = {}
    for key in ordered(spec["facts"]):
        q = spec["facts"][key]
        op = q.get("op", "value")
        if op in DERIVED:
            a, b = F[q["a"]]["v"], F[q["b"]]["v"]
            v = {"share": a / b, "change": a / b - 1, "times": a / b, "minus": a - b, "plus": a + b}[op]
            F[key] = {"v": v, "fmt": q.get("fmt", "pct"), "src": f'{op}({q["a"]},{q["b"]})'}; continue
        rows = _rows(T, q) if "table" in q else []
        if op == "mean":  # average over the periods that start with a prefix, e.g. the 12 months of one year
            vs = [float(r["OBS_VALUE"]) for r in rows if r["TIME_PERIOD"].startswith(q["within"])]
            F[key] = {"v": sum(vs) / len(vs), "n": len(vs), "fmt": q["fmt"], "src": q}; continue
        if op in ("peak", "low", "last"):
            ser = {}
            for r in rows: ser[r["TIME_PERIOD"]] = ser.get(r["TIME_PERIOD"], 0) + float(r["OBS_VALUE"])
            if q.get("from"): ser = {t: v for t, v in ser.items() if t >= q["from"]}
            if q.get("to"): ser = {t: v for t, v in ser.items() if t <= q["to"]}
            t = max(ser, key=ser.get) if op == "peak" else min(ser, key=ser.get) if op == "low" else max(ser)
            F[key] = {"v": ser[t], "t": t, "fmt": q["fmt"], "src": q}; continue
        if op == "count":  # members whose a-share of b is above a threshold, at one time
            num = {r["geo"]: float(r["OBS_VALUE"]) for r in _sel(_rows(T, q["a"]), q["time"])}
            den = {r["geo"]: float(r["OBS_VALUE"]) for r in _sel(_rows(T, q["b"]), q["time"])}
            hit = sorted(g for g in members() if den.get(g) and num.get(g, 0) / den[g] > q["above"])
            F[key] = {"v": len(hit), "fmt": "n", "who": hit, "src": q}; continue
        if op == "rest":  # sum of the by-values outside the top `skip`, at one time
            tot = {}
            for r in _sel(rows, q["time"]):
                k = r[q["by"]]
                if q.get("not_eu") and (k in members() or k == "TOTAL"): continue
                tot[k] = tot.get(k, 0) + float(r["OBS_VALUE"])
            keep = sorted(tot, key=tot.get, reverse=True)[q["skip"]:]
            F[key] = {"v": sum(tot[k] for k in keep), "n": len([k for k in keep if tot[k] > 0]), "fmt": q["fmt"], "src": q}; continue
        rows = _sel(rows, q["time"])
        if q.get("not_eu"): rows = [r for r in rows if r[q["not_eu"]] not in members() + ["TOTAL"]]
        v = sum(float(r["OBS_VALUE"]) for r in rows)
        F[key] = {"v": v, "fmt": q["fmt"], "src": q}
    return F

def fmt(spec, f, bare=False):
    """bare: the number without its unit suffix, for layouts that state the unit once."""
    m = spec["fmts"].get(f["fmt"], {})
    if f["fmt"] == "pct": return f'{abs(f["v"]) * 100:.0f}' + ("" if bare else "%")
    if f["fmt"] == "n": return f'{f["v"]:.0f}'
    if f["fmt"] == "x": return f'{f["v"]:.1f}'
    s = f'{f["v"] * m.get("scale", 1):,.{m.get("dec", 0)}f}'
    return s if bare else s + m.get("suffix", "")

def unit(spec, f):
    """What fmt writes after the bare number: "%" for a share, a scaled format's suffix, nothing for a count."""
    if f["fmt"] == "pct": return "%"
    if f["fmt"] in ("n", "x"): return ""
    return spec["fmts"].get(f["fmt"], {}).get("suffix", "")

def period(spec, k):
    """A fact's period from the ledger's parts (fact:<k>.t.y, .t.m, .t.h): the digits marked, the words written here."""
    y = entry(f"fact:{k}.t.y", "span", None)
    if f"fact:{k}.t.m" in LEDGER: words = word("date.ym", y=y, m=entry(f"fact:{k}.t.m", "span", None))
    elif f"fact:{k}.t.h" in LEDGER: words = word("date.half", y=y, h=word("half.1" if text(f"fact:{k}.t.h") == "1" else "half.2"))
    else: words = word("date.y", y=y)
    return spec["fmts"]["time"].get("prefix", "") + words

def fill(spec, F, text):
    """{key} -> formatted number in <b>; {key.t} -> its time label; {key.n} -> the number without its unit. With a ledger
    only bare numbers are entries: {key} prints fact:<key>.n with its unit written after it, {key.t} the period's parts."""
    import re
    def sub(mo):
        k, _, part = mo.group(1).partition(".")
        if LEDGER is not None:
            if part == "t": return period(spec, k)
            if part == "n": return entry(f"fact:{k}.n")
            return f'<b class="n">{entry(f"fact:{k}.n", "span", None)}{html.escape(unit(spec, F[k]), quote=False)}</b>'
        if part == "t": return spec["fmts"]["time"].get("prefix", "") + tlabel(F[k]["t"])
        return f'<b class="n">{fmt(spec, F[k], bare=part == "n")}</b>'
    return re.sub(r"\{([a-z0-9_.]+)\}", sub, text)

def tlabel(t):
    if "-S" in t: y, h = t.split("-S"); return word("date.half", y=y, h=word("half.1" if h == "1" else "half.2"))
    if "-" in t: y, m = t.split("-"); return word("date.ym", y=y, m=int(m))
    return word("date.y", y=t)

if __name__ == "__main__":
    spec = json.load(open(os.path.join(D, sys.argv[1])))
    F = compute(spec, load(spec))
    for k, f in F.items(): print(k, fmt(spec, f), f.get("t", ""), f.get("who", ""))
