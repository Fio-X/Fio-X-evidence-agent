"""Facts from declared queries: every number on the page is a key here, computed from a table row set.
Ops are generic (value, sum, share, change, times, peak, last, count); nothing names a topic.
Each fact keeps its provenance (table, filter, time) for the completion check."""
import csv, json, os, sys

D = os.path.dirname(os.path.abspath(__file__))
EU27 = "AT BE BG HR CY CZ DK EE FI FR DE EL HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split()

def load(spec):
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

def compute(spec, T):
    F = {}
    for key, q in spec["facts"].items():
        op = q.get("op", "value")
        if op in ("share", "change", "times", "minus", "plus"):
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
            t = max(ser, key=ser.get) if op == "peak" else min(ser, key=ser.get) if op == "low" else max(ser)
            F[key] = {"v": ser[t], "t": t, "fmt": q["fmt"], "src": q}; continue
        if op == "count":  # members whose a-share of b is above a threshold, at one time
            num = {r["geo"]: float(r["OBS_VALUE"]) for r in _sel(_rows(T, q["a"]), q["time"])}
            den = {r["geo"]: float(r["OBS_VALUE"]) for r in _sel(_rows(T, q["b"]), q["time"])}
            hit = sorted(g for g in EU27 if den.get(g) and num.get(g, 0) / den[g] > q["above"])
            F[key] = {"v": len(hit), "fmt": "n", "who": hit, "src": q}; continue
        if op == "rest":  # sum of the by-values outside the top `skip`, at one time
            tot = {}
            for r in _sel(rows, q["time"]):
                k = r[q["by"]]
                if q.get("not_eu") and (k in EU27 or k == "TOTAL"): continue
                tot[k] = tot.get(k, 0) + float(r["OBS_VALUE"])
            keep = sorted(tot, key=tot.get, reverse=True)[q["skip"]:]
            F[key] = {"v": sum(tot[k] for k in keep), "n": len([k for k in keep if tot[k] > 0]), "fmt": q["fmt"], "src": q}; continue
        rows = _sel(rows, q["time"])
        if q.get("not_eu"): rows = [r for r in rows if r[q["not_eu"]] not in EU27 + ["TOTAL"]]
        v = sum(float(r["OBS_VALUE"]) for r in rows)
        F[key] = {"v": v, "fmt": q["fmt"], "src": q}
    return F

def fmt(spec, f, bare=False):
    """bare: the number without its unit suffix, for layouts that state the unit once."""
    m = spec["fmts"].get(f["fmt"], {})
    if f["fmt"] == "pct": return f'{abs(f["v"]) * 100:.0f}%'
    if f["fmt"] == "n": return f'{f["v"]:.0f}'
    if f["fmt"] == "x": return f'{f["v"]:.1f}'
    s = f'{f["v"] * m.get("scale", 1):,.{m.get("dec", 0)}f}'
    return s if bare else s + m.get("suffix", "")

def fill(spec, F, text):
    """{key} -> formatted number in <b>; {key.t} -> its time label; {key.n} -> the number without its unit."""
    import re
    def sub(mo):
        k, _, part = mo.group(1).partition(".")
        if part == "t": return spec["fmts"]["time"].get("prefix", "") + tlabel(F[k]["t"])
        return f'<b class="n">{fmt(spec, F[k], bare=part == "n")}</b>'
    return re.sub(r"\{([a-z0-9_.]+)\}", sub, text)

def tlabel(t):
    if "-S" in t: y, h = t.split("-S"); return f"{y} 年{'上' if h == '1' else '下'}半年"
    if "-" in t: y, m = t.split("-"); return f"{y} 年 {int(m)} 月"
    return f"{t} 年"

if __name__ == "__main__":
    spec = json.load(open(os.path.join(D, sys.argv[1])))
    F = compute(spec, load(spec))
    for k, f in F.items(): print(k, fmt(spec, f), f.get("t", ""), f.get("who", ""))
