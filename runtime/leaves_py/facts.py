"""Facts from declared queries: every number on the page is a key here, computed from a table row set.
Ops are generic (value, sum, share, change, times, peak, last, count); nothing names a topic.
Each fact keeps its provenance (table, filter, time) for the completion check."""
import csv, html, json, os, re, sys, unicodedata
from words import Refused, word

D = os.path.dirname(os.path.abspath(__file__))
MEMBERS = None  # the aggregate's member codes, from the request (run.py sets them; layer 1 has them from the knowledge group)

TABLES = None  # the request's rows as tables, set by run.py; None reads the csv files as before
LEDGER = None  # the request's ledger entries {src: text}, set by run.py; None formats the numbers here as before
NAME = None  # a place code's name from the request's labels without a ledger: prod.NAME, which prod sets when imported (no import of prod here)
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

def long_unit(u):
    """Whether a number's unit is words (a unit name), not nothing or the percent sign that is the number's own mark."""
    return u.strip() not in ("", "%")


def unit_runs(spec, F, text):
    """For each number placeholder {key} of text in order (no part: {key.n} and {key.t} are no such number): True when its unit is left
    off. In a run of numbers of one unit that is words (two or more in a sentence, nothing between them but words, names, years and
    numbers with no unit), the unit follows only the last; a number of another unit (a ratio, a percent) or a sentence's end ends a run."""
    flags, prev = [], None
    for mo in re.finditer(r"\{([a-z0-9_.]+)\}|[" + re.escape(word("sentence.end")) + "]", text):   # the marks that end a sentence
        if mo.group(1) is None: prev = None; continue
        k, _, part = mo.group(1).partition(".")
        if part: continue
        u = unit(spec, F[k]).strip() if k in F else ""
        if prev is not None and prev[1] == u and long_unit(u): flags[prev[0]] = True
        flags.append(False); prev = (len(flags) - 1, u)
    return flags


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
    flags = iter(unit_runs(spec, F, wording))   # the runs of one unit over the whole wording, whichever segment each number is in
    return "".join(fill(spec, F, s["w"], flags) if "w" in s else entry(s["src"], "span", None) for s in segs)

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
    # a spec table the request holds no row of is a reference only (a law's clause the footer names): nothing to load; a fact
    # that reads it still stops, at T[q["table"]]
    if TABLES is not None: return {name: [r for r in TABLES[name] if r.get("OBS_VALUE") not in ("", None)] for name in spec["tables"] if name in TABLES}
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


# Operators the program's layer 1 alone works out (next_facts): a leaf page's request carries each one's text in its ledger
# (fact:<k>, its bare number fact:<k>.n and, where it has a period, fact:<k>.t.y), and this child reads them from there. With no
# ledger (a page made from files) the child has no way to work them out and refuses, naming the operator.
PROGRAM_OPS = ("per_year", "cagr", "line_at", "reach_year", "step_max", "first_above", "spread", "group_change")


def from_ledger(key, q):
    """A fact of an operator the program alone works out, as the ledger holds it: its format, its bare number as a float
    (the printed one, rounded as printed) and its period; a ledger without its number refuses."""
    if LEDGER is None:
        raise Refused(f"fact {key}: the operator {q.get('op')} is worked out by the program, and this request has no ledger to read it from")
    n = text(f"fact:{key}.n")
    try:
        v = float(n.replace(",", ""))
    except ValueError:
        raise Refused(f"fact {key}: the ledger's number {n!r} is no number")
    out = {"v": v, "fmt": q.get("fmt", "pct"), "src": f"ledger({key})"}
    if f"fact:{key}.t.y" in LEDGER: out["t"] = text(f"fact:{key}.t.y")
    return out


def compute(spec, T):
    F = {}
    for key in ordered(spec["facts"]):
        q = spec["facts"][key]
        op = q.get("op", "value")
        if op in PROGRAM_OPS:
            F[key] = from_ledger(key, q); continue
        if op in DERIVED:
            a, b = F[q["a"]]["v"], F[q["b"]]["v"]
            # only the fact's own op is worked out: a difference whose second number is 0 divides nothing
            v = {"share": lambda: a / b, "change": lambda: a / b - 1, "times": lambda: a / b, "minus": lambda: a - b, "plus": lambda: a + b}[op]()
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
        if op == "count":  # members whose a-share of b is above a threshold, or (below, no b) whose own value is under a line, at one time
            by = q.get("by") or "geo"
            num = {r[by]: float(r["OBS_VALUE"]) for r in _sel(_rows(T, q["a"]), q["time"])}
            if "below" in q and "b" not in q:
                gone = [g for g in members() if g not in num]
                if gone: raise Refused(f"{key}: count has no row of a at {q['time']} for {', '.join(gone)}")
                hit = sorted(g for g in members() if num[g] < q["below"])
            else:
                den = {r[by]: float(r["OBS_VALUE"]) for r in _sel(_rows(T, q["b"]), q["time"])}
                hit = sorted(g for g in members() if den.get(g) and num.get(g, 0) / den[g] > q["above"])
            F[key] = {"v": len(hit), "fmt": "n", "who": hit, "src": q}; continue
        if op == "n":  # how many codes of `by` the rows hold at one time (the places a chart draws)
            F[key] = {"v": len({r[q["by"]] for r in _sel(rows, q["time"])}), "fmt": q["fmt"], "src": q}; continue
        if op == "position":  # where `code` stands among the codes of `by` at one time, highest first (1 and those above it)
            tot = {}
            for r in _sel(rows, q["time"]): tot[r[q["by"]]] = tot.get(r[q["by"]], 0) + float(r["OBS_VALUE"])
            own = tot[q["code"]]
            F[key] = {"v": 1 + sum(1 for v in tot.values() if v > own), "fmt": q["fmt"], "src": q}; continue
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

def unsigned_zero(s):
    """A number that rounded to 0 prints without its minus ("-0.0" is "0.0"), as next_facts::fixed prints it."""
    return s[1:] if s.startswith("-") and not any(c in "123456789" for c in s) else s

def fmt(spec, f, bare=False):
    """bare: the number without its unit suffix, for layouts that state the unit once."""
    m = spec["fmts"].get(f["fmt"], {})
    if f["fmt"] == "pct": return f'{abs(f["v"]) * 100:.0f}' + ("" if bare else "%")
    if f["fmt"] == "n": return unsigned_zero(f'{f["v"]:.0f}')
    if f["fmt"] == "x": return unsigned_zero(f'{f["v"]:.1f}')
    s = unsigned_zero(f'{f["v"] * m.get("scale", 1):,.{m.get("dec", 0)}f}')
    return s if bare else s + m.get("suffix", "")

def unit(spec, f):
    """What fmt writes after the bare number: "%" for a share, a scaled format's suffix, nothing for a count."""
    if f["fmt"] == "pct": return "%"
    if f["fmt"] in ("n", "x"): return ""
    return spec["fmts"].get(f["fmt"], {}).get("suffix", "")

def period(spec, k):
    """A fact's period from the ledger's parts (fact:<k>.t.y, .t.m, .t.h): the digits and the half's word marked, the rest
    written here."""
    return spec["fmts"]["time"].get("prefix", "") + period_words(f"fact:{k}.t")

def period_words(stem):
    """A period printed from its ledger parts <stem>.y with <stem>.m (a month) or <stem>.h (a half year, its word as
    entered: half.1 or half.2), else <stem>.y alone (a year)."""
    y = entry(f"{stem}.y", "span", None)
    if f"{stem}.m" in LEDGER: return word("date.ym", y=y, m=entry(f"{stem}.m", "span", None))
    if f"{stem}.h" in LEDGER:
        if text(f"{stem}.h") not in (word("half.1"), word("half.2")): raise Refused(f"{stem}.h: {text(stem + '.h')!r} is no half's word")
        return word("date.half", y=y, h=entry(f"{stem}.h", "span", None))
    return word("date.y", y=y)

def fill(spec, F, text, flags=None):
    """{key} -> formatted number in <b>; {key.t} -> its time label; {key.n} -> the number without its unit. With a ledger
    only bare numbers are entries: {key} prints fact:<key>.n with its unit written after it, {key.t} the period's parts.
    In a run of numbers of one unit that is words, only the run's last {key} writes its unit (unit_runs; `flags`, an iterator
    over a whole wording's, when text is one segment of it)."""
    import re
    if flags is None: flags = iter(unit_runs(spec, F, text))
    def name(mo):
        # {name.<code>}: a place's (or a part's) name as layer 1 names it (next_run NAME_PLACEHOLDER), marked with its name row
        # so the page checks read which place the words name: with a ledger the one name row of the code (a src ending
        # ":<code>"), none or two refusing; without one the request's label, bare
        code = mo.group(1)
        if LEDGER is None:
            return html.escape(NAME(code), quote=False)
        rows = [s for s in LEDGER if s.startswith("name:") and s.rsplit(":", 1)[-1] == code]
        if len(rows) > 1:  # a place code's row is the place table's (iso2, iso3), a part's (fossil) the other one
            place = re.fullmatch(r"[A-Z][A-Z0-9_]+", code) is not None
            rows = [s for s in rows if (s.split(":")[2:3] in (["iso2"], ["iso3"])) == place] or rows
        if len(rows) != 1: raise Refused(f"the words name {code}, and the ledger holds {len(rows)} name rows of it, not one")
        return entry(rows[0], "span", None)
    text = re.sub(r"\{name\.([A-Za-z0-9_]+)\}", name, text)
    def sub(mo):
        k, _, part = mo.group(1).partition(".")
        off = not part and next(flags, False)   # a number before the last of its run of one unit: the number alone
        if LEDGER is not None:
            if part == "t": return period(spec, k)
            if part == "n": return entry(f"fact:{k}.n")
            return f'<b class="n">{entry(f"fact:{k}.n", "span", None)}{"" if off else html.escape(unit(spec, F[k]), quote=False)}</b>'
        if part == "t": return spec["fmts"]["time"].get("prefix", "") + tlabel(F[k]["t"])
        return f'<b class="n">{fmt(spec, F[k], bare=part == "n" or off)}</b>'
    return re.sub(r"\{([a-z0-9_.]+)\}", sub, text)

def placed(text):
    """The headline's or the dek's filled text with each place name it prints bare marked by its ledger row (a place row,
    name:<table>:iso2|iso3:<code>; the longest name first), so the page checks read which place the words name (next_ledger
    names_drawn): a worded title or dek is the text step's words, and may name the page's place. Words inside a tag or a
    marked element are left as they are; without a ledger the text is returned unchanged."""
    if LEDGER is None: return text
    import re
    rows = sorted(((t, s) for s, t in LEDGER.items() if s.startswith("name:") and s.split(":")[2:3] in (["iso2"], ["iso3"]) and t),
                  key=lambda r: -len(r[0]))
    if not rows: return text
    by = dict(rows); find = re.compile("|".join(re.escape(t) for t, _ in rows))
    parts = re.split(r"(<span[^>]*>[^<]*</span>|<[^>]*>)", text)
    return "".join(p if i % 2 else find.sub(lambda m: entry(by[m.group(0)], "span", None), p) for i, p in enumerate(parts))

def tlabel(t):
    if "-S" in t: y, h = t.split("-S"); return word("date.half", y=y, h=word("half.1" if h == "1" else "half.2"))
    if "-" in t: y, m = t.split("-"); return word("date.ym", y=y, m=int(m))
    return word("date.y", y=t)

if __name__ == "__main__":
    spec = json.load(open(os.path.join(D, sys.argv[1])))
    F = compute(spec, load(spec))
    for k, f in F.items(): print(k, fmt(spec, f), f.get("t", ""), f.get("who", ""))
