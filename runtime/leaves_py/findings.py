"""Story findings: the candidate findings a long page (the story recipe, story.py) can tell, worked out from the request's rows,
scored, and, for the ones the model picks, composed into the page's sections. Nothing here belongs to a topic: the measure's
name, its unit and the places' names come from the request (layer 1 writes them from the knowledge group), every number on
the page is a fact this file declares and layer 1 computes and checks again from the rows (next_facts); the values worked
out here only rank the findings, they are never printed.

Angles (data-journalism practice: change and pace, the gap to a target, scenarios, the spread between places, who rose
and who fell), each one section with one story leaf (a leaf stands at most once on a page, so each angle names its own):
  * path   (target_path):    the whole's line so far and three paces carried on to the target year (the past average,
                              the last five years', the best single year's every year): even the best is short, or which
                              pace gets there; needs a target.
  * need   (gap_axis):       where the whole stands, the target, and the pace a year the target needs over the past
                              average pace ("x times"); needs a target above or below the last value.
  * spread (winners_losers): the members that rose and those that fell between the first and the last year, and whether
                              the lowest at the start caught up with the highest (group_change), when both columns hold one.
  * ends   (pair_bars):      the highest and the lowest member at the last year side by side, the first over the second.
  * chain  (event_chain):    the companion tables' series side by side on the years they and the whole share (a panel
                              each, the page's measure not one of them), the one year the whole moved most shaded across
                              them: what moved around that year, told in order and never as a cause; needs the request's
                              "chain" (two to five tables) and a whole.
Chain rules. Years: the longest run of consecutive years, ending at the last, that every chain table and the whole have
(at least CHAIN_YEARS). A chain table is read at the dims its "filter" names (one row a year, else the angle is dropped).
Panel kind: the item's "kind" ("flow" = bars, "stock" = line) when it gives one, else bars when every value is 0 or above
and the run has at most BAR_MAX years (a few yearly amounts), else a line; a line is drawn from 0 when its values are all
0 or above and its lowest is at most half its highest (a series that swings from near nothing), else on its own range.
Band: the one year, inside the run and not its first, where the whole's step from the year before is largest in size (the
earlier year if two tie); it is shaded in every panel and named in the key. Its size is the step over the whole's range on
the run; its title prints that step (the larger of the two values less the smaller, so it is above 0). The link under each
band between two panels is one neutral word of the table ("then"), never a claim of cause.
Score = size x surprise x sturdiness, each 0..1: size how far the finding's number is from the plain reading (the gap
left, the ratio), surprise whether it goes against the obvious (even the best year falls short; the low ones did not catch
up; for the chain, how many of the companion series move most in the band year or the two after it), sturdiness how many years
and members (panels) it stands on. The page takes the model's three picks of the top five.

Request (one JSON line on stdin, one reply line on stdout; mode "candidates"):
  {"mode": "candidates",
   "rows": [{"src", "table", "dims", "time", "value"}],        # the request's rows (next_facts Row)
   "main": {"table", "by": dim, "whole": code?, "members": [code]?, "filter": {dim: code}?},
   "target": {"table", "filter": {dim: code}, "time": year}?,   # the whole's target row (knowledge group, I8)
   "fmts": {"value": fmt, "year": fmt, "times": fmt},           # the spec's format names for a value, a year, a ratio
   "fmt_defs": {fmt: {"scale", "dec", "suffix"}},               # those formats (an axis's ticks are worked out as next_facts does)
   "words": {"measure": words, "unit": words},                 # the measure's name and its unit (no digit)
   "chain": [{"table", "filter": {dim: code}, "words": {"measure", "unit"}, "fmt"?: fmt, "kind"?: "flow"|"stock"}]?,
   "zh": {code: name}?}                                          # the places' reviewed names (compose hands them on)
                                                                 # companion tables (knowledge group's chain_companions), their
                                                                 # place and years the main's; "fmt" defaults to the value format
Reply: {"candidates": [{"id", "angle", "layer", "score", "why", "summary"}...], "dropped": [{"angle", "why"}]}, best first;
"summary" is the one-line English summary the model reads (no number of its own: a finding is picked by its number in the list).

Request (mode "compose"): the same fields and "picks": [candidate id, ...] (the model's, first the answer); reply:
  {"facts": {key: query}, "sections": [section], "leaves": {layer: hero.data}} — what the flow writes into knobs.spec
  (facts into spec.facts, sections into spec.sections, leaves into hero.leaves). A section is story.py's: {"id", "layer",
  "kicker"?, "title"?, "text"?}; a title or text is a wording whose numbers are placeholders ({k}, {k.t}, {name.<code>}).
  The page opens with a thesis block (thesis_claims: the answer and each pick's number pointing to its section) and closes
  with the risk notes (risk_notes: each scenario named as one, the last year read)."""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run as a child with -I: its folder holds the word table
import words as WD  # noqa: E402

THESIS, NOTES = "thesis_claims", "risk_notes"
CHAIN_MIN, CHAIN_MAX = 2, 5   # the tables a chain holds
CHAIN_YEARS = 4      # years in a row every chain table and the whole share, at least
BAR_MAX = 8          # a chain table of this many years or fewer, all 0 or above, is drawn in bars
MIN_YEARS = 6        # a pace needs this many years of the whole at least
RECENT = 5           # the recent pace runs over the last five years
TOP_K = 5            # the model is shown the five best
GROUP_K = 3          # the lowest and the highest three at the start (spread)
ROWS_MAX = 5         # rows a winners/losers column shows


class Refused(Exception):
    pass


# ---------------------------------------------------------------- the rows as series

def series(rows, table, by, code, fixed):
    """{year: (value, src)} of one code of `by` in `table`, the `fixed` dims held; a period that is no year is left out."""
    out = {}
    for r in rows:
        if r.get("table") != table: continue
        d = r.get("dims") or {}
        if d.get(by) != code or any(d.get(k) != v for k, v in (fixed or {}).items()): continue
        t = str(r.get("time"))
        v = number(r.get("value"))
        if len(t) == 4 and t.isdigit() and v is not None:
            out[t] = (v, r["src"])
    return dict(sorted(out.items()))


def number(v):
    """A row's value as a float: the knowledge group gives it as the source's decimal text, a test as a number; None when
    it is neither or not finite."""
    if isinstance(v, bool): return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def codes_of(rows, table, by, fixed):
    seen = []
    for r in rows:
        d = r.get("dims") or {}
        if r.get("table") == table and by in d and all(d.get(k) == v for k, v in (fixed or {}).items()) and d[by] not in seen:
            seen.append(d[by])
    return seen


def run_years(s):
    """The longest run of consecutive years at the end of a series (a pace never spans a gap)."""
    ys = [int(y) for y in s]
    out = [ys[-1]] if ys else []
    for y in reversed(ys[:-1]):
        if y != out[0] - 1: break
        out.insert(0, y)
    return [str(y) for y in out]


# ---------------------------------------------------------------- ticks as next_facts::ticks works them out

def fixed_text(x, dec):
    return f"{x:,.{dec}f}"


def ticks(top_value, fmt_def):
    """The axis ticks of a fact (0 left out), as next_facts::ticks gives them: their count is what a leaf names."""
    scale, dec = float(fmt_def.get("scale", 1.0)), int(fmt_def.get("dec", 0))
    top = top_value * scale
    if not (math.isfinite(top) and top > 0): raise Refused("an axis needs a fact above 0")
    place = 10.0 ** -dec
    target = top / 3.0
    mag = 10.0 ** math.floor(math.log10(target))
    step = next((m * mag for m in (5.0, 2.0, 1.0) if m * mag <= target * (1 + 1e-9)), mag)
    step = max(step, place)
    out, i = [], 1
    while i * step <= top * (1 + 1e-9):
        out.append(i * step / scale); i += 1
    if not out: raise Refused("the axis is shorter than one printed place")
    return out


# ---------------------------------------------------------------- wording: one template, two spellings

def wording(parts):
    """A template as a wording (story.py's titles and texts): ("w", words), ("f", key), ("y", key), ("n", code)."""
    out = []
    for kind, v in parts:
        out.append({"w": v, "f": "{%s}" % v, "y": "{%s.t}" % v, "n": "{name.%s}" % v}[kind])
    return "".join(out)


def segs(parts):
    """The same template as a leaf's segments (wbkit.segs)."""
    out = []
    for kind, v in parts:
        out.append({"w": {"w": v}, "f": {"src": f"fact:{v}"}, "y": {"src": f"fact:{v}.t.y"}, "n": {"name": v}}[kind])
    return out


TEMPLATE = re.compile(r"\{([fynl]):(\w+)\}")


def T(key, **bind):
    """A word-table template (words.zh.json story.*) as parts: {f:k} a fact's number, {y:k} its year, {n:v} a place's name,
    {l:v} a list of places' names joined by the table's join word; a slot's name is looked up in `bind` first (a place's
    code, a list of codes, or another fact key), else it is the fact key itself. The file holds no word of its own."""
    text, out, at = WD.WORDS[key], [], 0
    for mo in TEMPLATE.finditer(text):
        if mo.start() > at: out.append(("w", text[at:mo.start()]))
        kind, name = mo.groups()
        v = bind.get(name, name)
        if kind == "l":
            for i, c in enumerate(v):
                if i: out.append(("w", WD.WORDS["story.join"]))
                out.append(("n", c))
        else:
            out.append((kind, v))
        at = mo.end()
    if at < len(text): out.append(("w", text[at:]))
    return out


def W(t):
    return [("w", t)]


def SW(t):
    """Plain words as a leaf's segments."""
    return [{"w": t}]


def ST(key, **bind):
    """A word-table template as a leaf's segments."""
    return segs(T(key, **bind))


def clamp(x):
    return max(0.0, min(1.0, x))


# ---------------------------------------------------------------- the request

class Req:
    def __init__(q, r):
        q.rows = r.get("rows") or []
        m = r.get("main") or {}
        q.table, q.by, q.fixed = m.get("table"), m.get("by"), dict(m.get("filter") or {})
        if not q.table or not q.by: raise Refused("findings: the request names no main table or place dimension")
        q.whole = m.get("whole")
        q.members = [c for c in (m.get("members") or codes_of(q.rows, q.table, q.by, q.fixed)) if c != q.whole]
        q.target = r.get("target")
        q.fmts = r.get("fmts") or {}
        q.defs = r.get("fmt_defs") or {}
        for k in ("value", "year", "times"):
            if not q.fmts.get(k): raise Refused(f"findings: the request gives no {k} format")
        q.words = r.get("words") or {}
        for k in ("measure", "unit"):
            if not q.words.get(k): raise Refused(f"findings: the request gives no {k} words")
            if any(ch.isdigit() for ch in q.words[k]): raise Refused(f"findings: the {k} words hold a digit")
        q.chain = r.get("chain")
        q.panel = {c: series(q.rows, q.table, q.by, c, q.fixed) for c in q.members}
        q.panel = {c: s for c, s in q.panel.items() if s}
        q.wseries = series(q.rows, q.table, q.by, q.whole, q.fixed) if q.whole else {}

    def filt(q, code):
        return {**q.fixed, q.by: code}

    def value(q, code, year, fmt=None):
        return {"table": q.table, "filter": q.filt(code), "time": year, "fmt": fmt or q.fmts["value"]}

    def goal(q):
        """(value, year, query) of the target row, or None."""
        t = q.target
        if not t: return None
        hits = [r for r in q.rows if r.get("table") == t.get("table") and str(r.get("time")) == str(t.get("time"))
                and all((r.get("dims") or {}).get(k) == v for k, v in (t.get("filter") or {}).items())]
        if len(hits) != 1 or number(hits[0].get("value")) is None: return None
        return number(hits[0]["value"]), str(t["time"]), {"table": t["table"], "filter": dict(t.get("filter") or {}),
                                                          "time": str(t["time"]), "fmt": q.fmts["value"]}


# ---------------------------------------------------------------- the angles

def paces(s):
    """(years in the end run, past avg, recent, best step and its year) of a {year: (v, src)} series."""
    ys = run_years(s)
    v = {y: s[y][0] for y in ys}
    first, last = ys[0], ys[-1]
    span = int(last) - int(first)
    past = (v[last] - v[first]) / span
    r0 = str(int(last) - RECENT)
    recent = (v[last] - v[r0]) / RECENT
    steps = {ys[i]: v[ys[i]] - v[ys[i - 1]] for i in range(1, len(ys))}
    best_y = max(steps, key=lambda y: (steps[y], -int(y)))
    return ys, past, recent, steps[best_y], best_y


def angle_path(q):
    g = q.goal()
    if not g: return None, "no target row"
    if not q.whole or len(run_years(q.wseries)) < MIN_YEARS: return None, f"the whole has fewer than {MIN_YEARS} years in a row"
    gv, gy, gq = g
    ys, past, recent, best, best_y = paces(q.wseries)
    first, last = ys[0], ys[-1]
    now = q.wseries[last][0]
    if int(gy) <= int(last): return None, "the target year is not after the last year"
    up = gv > now
    if not up: return None, "the target is not above the last value (a falling path draws on another angle)"
    if min(past, recent, best) <= 0: return None, "a pace is not above 0"
    n = int(gy) - int(last)
    runs = {"p_best": now + best * n, "p_recent": now + recent * n, "p_past": now + past * n}
    top = max([gv] + list(runs.values()))
    f = {"now": q.value(q.whole, last), "first": q.value(q.whole, first), "rec0": q.value(q.whole, str(int(last) - RECENT)),
         "goal": gq,
         "past": {"op": "per_year", "a": "now", "b": "first", "fmt": q.fmts["value"]},
         "recent": {"op": "per_year", "a": "now", "b": "rec0", "fmt": q.fmts["value"]},
         "best": {"op": "step_max", "table": q.table, "filter": q.filt(q.whole), "from": first, "to": last, "fmt": q.fmts["value"]},
         "p_past": {"op": "line_at", "start": "now", "rate": "past", "at": gy, "fmt": q.fmts["value"]},
         "p_recent": {"op": "line_at", "start": "now", "rate": "recent", "at": gy, "fmt": q.fmts["value"]},
         "p_best": {"op": "line_at", "start": "now", "rate": "best", "at": gy, "fmt": q.fmts["value"]}}
    # the axis runs to the highest value drawn: a fact of its own key (another finding may declare the same fact with no axis)
    top_key = max(["goal", "p_best", "p_recent", "p_past"], key=lambda k: gv if k == "goal" else runs[k])
    f["path_top"] = {**f[top_key], "axis": True}
    short = runs["p_best"] < gv
    if short:
        title = T("story.path.short")
        surprise, size = 1.0, clamp((gv - runs["p_best"]) / max(gv - now, 1e-9))
    else:
        f["when"] = {"op": "reach_year", "start": "now", "rate": "best", "target": "goal", "fmt": q.fmts["year"]}
        reached = [k for k in ("p_past", "p_recent") if runs[k] >= gv]
        if reached:
            k = reached[0]
            title = T("story.path.reach_past" if k == "p_past" else "story.path.reach_recent")
            surprise, size = 0.3, clamp((runs[k] - gv) / max(gv - now, 1e-9))
        else:
            title = T("story.path.when")
            surprise, size = 0.7, clamp((gv - runs["p_recent"]) / max(gv - now, 1e-9))
    text = T("story.path.text")
    s = q.wseries
    tk = ticks(top, q.defs.get(q.fmts["value"], {}))
    data = {"title": SW(q.words["measure"]), "unit": SW(q.words["unit"]),
            "series": {"code": q.whole, "points": [s[y][1] for y in ys], "start_text": "fact:first", "end_text": "fact:now"},
            "target": {"year": "fact:goal.t.y", "text": "fact:goal", "label": ST("story.target")},
            "runs": [{"text": "fact:p_best", "label": ST("story.run.best")},
                     {"text": "fact:p_recent", "label": ST("story.run.recent")},
                     {"text": "fact:p_past", "label": ST("story.run.past")}],
            "axis": {"ticks": [f"fact:path_top.tick{i}" for i in range(1, len(tk) + 1)], "scale": float(q.defs.get(q.fmts["value"], {}).get("scale", 1))},
            "periods": [f"period:{q.table}:{y}" for y in ys],
            "footnote": ST("story.path.foot")}
    if short:
        f["gap"] = {"op": "minus", "a": "goal", "b": "p_best", "fmt": q.fmts["value"]}
        data["gap_label"] = ST("story.gap", g="gap")
    sturdy = clamp(len(ys) / 15)
    return {"angle": "path", "layer": "target_path", "kicker": T("story.path.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": {"num": "fact:p_best", "head": title}, "notes": ["scenario"], "last": "now",
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3)},
            "summary": "even the best single year's rise repeated every year falls short of the target" if short else
                    "the target year under three paces: which pace gets there"}, None


def angle_need(q):
    g = q.goal()
    if not g: return None, "no target row"
    if not q.whole or len(run_years(q.wseries)) < MIN_YEARS: return None, f"the whole has fewer than {MIN_YEARS} years in a row"
    gv, gy, gq = g
    ys, past, recent, best, best_y = paces(q.wseries)
    first, last = ys[0], ys[-1]
    now = q.wseries[last][0]
    if int(gy) <= int(last) or gv <= now: return None, "the target is not above the last value after the last year"
    if past <= 0: return None, "the past pace is not above 0"
    need = (gv - now) / (int(gy) - int(last))
    ratio = need / past
    f = {"now": q.value(q.whole, last), "first": q.value(q.whole, first), "goal": gq, "need_top": {**gq, "axis": True},
         "past": {"op": "per_year", "a": "now", "b": "first", "fmt": q.fmts["value"]},
         "need": {"op": "per_year", "a": "goal", "b": "now", "fmt": q.fmts["value"]},
         "need_x": {"op": "times", "a": "need", "b": "past", "fmt": q.fmts["times"]},
         "p_past": {"op": "line_at", "start": "now", "rate": "past", "at": gy, "fmt": q.fmts["value"]},
         "gap_now": {"op": "minus", "a": "goal", "b": "now", "fmt": q.fmts["value"]}}
    title, text = T("story.need.title"), T("story.need.text")
    tk = ticks(gv, q.defs.get(q.fmts["value"], {}))
    data = {"title": SW(q.words["measure"]), "unit": SW(q.words["unit"]),
            "axis": {"ticks": [f"fact:need_top.tick{i}" for i in range(1, len(tk) + 1)], "scale": float(q.defs.get(q.fmts["value"], {}).get("scale", 1)), "from_zero": True},
            "now": {"text": "fact:now", "at": q.wseries[last][1], "label": ST("story.now")},
            "marks": [{"text": "fact:p_past", "label": ST("story.run.past")}],
            "target": {"text": "fact:goal", "label": ST("story.target_year")},
            }
    if now + past * (int(gy) - int(last)) < gv:  # the leaf takes a gap's words only when no mark reaches the target
        data["gap_label"] = ST("story.gap", g="gap_now")
    size = clamp((ratio - 1) / 3)
    surprise = 1.0 if need > best else 0.6
    sturdy = clamp(len(ys) / 15)
    return {"angle": "need", "layer": "gap_axis", "kicker": T("story.need.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": {"num": "fact:need_x", "head": title}, "notes": ["scenario"], "last": "now",
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "ratio": round(ratio, 3)},
            "summary": "the pace a year the target needs, against the past average pace"}, None


def common_ends(q):
    """The first and last year every member has (the panel's span), or None."""
    if len(q.panel) < 2: return None
    years = set.intersection(*(set(s) for s in q.panel.values()))
    if len(years) < 2: return None
    ys = sorted(years)
    return ys[0], ys[-1]


def angle_spread(q):
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y0, y1 = ends
    if len(q.panel) < 2 * GROUP_K: return None, f"fewer than {2 * GROUP_K} members"
    ch = {c: s[y1][0] - s[y0][0] for c, s in q.panel.items()}
    up = sorted([c for c in ch if ch[c] > 0], key=lambda c: -ch[c])[:ROWS_MAX]
    down = sorted([c for c in ch if ch[c] < 0], key=lambda c: ch[c])[:ROWS_MAX]
    start = sorted(q.panel, key=lambda c: -q.panel[c][y0][0])
    top, low = start[:GROUP_K], start[-GROUP_K:]
    top_ch = sum(ch[c] for c in top) / GROUP_K
    low_ch = sum(ch[c] for c in low) / GROUP_K
    caught = low_ch > top_ch
    members = sorted(q.panel)
    f = {"lowg": {"op": "group_change", "table": q.table, "filter": q.fixed, "by": q.by, "from": y0, "to": y1, "part": "bottom",
                  "k": GROUP_K, "fmt": q.fmts["value"]},
         "topg": {"op": "group_change", "table": q.table, "filter": q.fixed, "by": q.by, "from": y0, "to": y1, "part": "top",
                  "k": GROUP_K, "fmt": q.fmts["value"]},
         "y0": q.value(members[0], y0), "y1": q.value(members[0], y1)}
    rows = {}
    for side, cs in (("up", up), ("down", down)):
        rows[side] = []
        for c in cs:
            a, b, d = f"a_{c.lower()}", f"b_{c.lower()}", f"d_{c.lower()}"
            f[a], f[b] = q.value(c, y0), q.value(c, y1)
            f[d] = {"op": "minus", "a": b, "b": a, "fmt": q.fmts["value"]}
            rows[side].append({"label": [{"name": c}], "a": f"fact:{a}", "b": f"fact:{b}", "change": [{"src": f"fact:{d}"}]})
    # the groups are named, never counted in words: a count would be a number no fact prints
    title = T("story.spread.caught" if caught else "story.spread.not")
    text = T("story.spread.text", low=sorted(low), top=sorted(top))
    if not up or not down:
        # a column with no rows is refused by the leaf: one side only is a page of the ends instead
        return None, "every member moved the same way (one column would be empty)"
    data = {"up": {"title": ST("story.up"), "rows": rows["up"]}, "down": {"title": ST("story.down"), "rows": rows["down"]},
            "footnote": ST("story.span")}
    size = clamp(abs(low_ch - top_ch) / max(abs(top_ch), abs(low_ch), 1e-9))
    surprise = 0.9 if not caught else 0.5
    sturdy = clamp(len(q.panel) / 20) * clamp((int(y1) - int(y0)) / 10)
    key = "lowg" if caught else "topg"
    return {"angle": "spread", "layer": "winners_losers", "kicker": T("story.spread.kicker"), "title": title, "text": text, "facts": f,
            "data": data, "claim": {"num": f"fact:{key}", "head": title}, "notes": [], "members": True, "last": "y1",
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "caught_up": caught},
            "summary": "the lowest at the start caught up with the highest" if caught else "the lowest at the start did not catch up"}, None


def angle_ends(q):
    ends = common_ends(q)
    if not ends: return None, "fewer than two members with two common years"
    y1 = ends[1]
    at = {c: s[y1][0] for c, s in q.panel.items() if y1 in s}
    hi = max(at, key=lambda c: (at[c], c))
    lo = min(at, key=lambda c: (at[c], c))
    if at[lo] <= 0: return None, "the lowest member is not above 0 (no ratio)"
    if any(v < 0 for v in at.values()): return None, "a value below 0"
    ratio = at[hi] / at[lo]
    f = {"hi": q.value(hi, y1), "lo": q.value(lo, y1), "hi_lo": {"op": "times", "a": "hi", "b": "lo", "fmt": q.fmts["times"]}}
    title, text = T("story.ends.title", a=hi, b=lo), T("story.ends.text", a=hi, b=lo)
    data = {"title": SW(q.words["measure"]), "unit": SW(q.words["unit"]), "places": [hi, lo], "place_kind": "place",
            "rows": [{"code": "main", "label": SW(q.words["measure"]), "a": q.panel[hi][y1][1], "b": q.panel[lo][y1][1],
                      "a_text": "fact:hi", "b_text": "fact:lo", "ratio": "fact:hi_lo"}],
            "ratio_unit": ST("story.times")}
    size = clamp(math.log(ratio) / math.log(5))
    surprise = 0.5
    sturdy = clamp(len(at) / 20)
    return {"angle": "ends", "layer": "pair_bars", "kicker": T("story.ends.kicker"), "title": title, "text": text, "facts": f, "data": data,
            "claim": {"num": "fact:hi_lo", "head": title}, "notes": [], "members": True, "last": "hi",
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": surprise, "sturdy": round(sturdy, 3), "ratio": round(ratio, 3)},
            "summary": "the highest member over the lowest at the last year"}, None


def chain_series(q, item):
    """{year: (value, src)} of one chain table at the dims its filter names, one row a year; two rows at a year refuse."""
    out = {}
    for r in q.rows:
        d = r.get("dims") or {}
        if r.get("table") != item["table"] or any(d.get(k) != v for k, v in item["filter"].items()): continue
        t, v = str(r.get("time")), number(r.get("value"))
        if not (len(t) == 4 and t.isdigit() and v is not None): continue
        if t in out: raise Refused(f"the chain table {item['table']} has two rows at {t} at that filter")
        out[t] = (v, r["src"])
    return dict(sorted(out.items()))


def angle_chain(q):
    ch = q.chain
    if not isinstance(ch, list) or len(ch) < CHAIN_MIN: return None, f"the request's chain holds fewer than {CHAIN_MIN} tables"
    if len(ch) > CHAIN_MAX: raise Refused(f"the chain holds more than {CHAIN_MAX} tables")
    if not q.whole or not q.wseries: return None, "no whole to date the event by"
    items, tables = [], []
    for i, it in enumerate(ch):
        if not isinstance(it, dict) or not it.get("table") or not isinstance(it.get("filter"), dict) or not it["filter"]:
            raise Refused(f"chain table {i + 1} names no table or filter")
        w = it.get("words") or {}
        for k in ("measure", "unit"):
            if not w.get(k): raise Refused(f"chain table {i + 1} gives no {k} words")
            if any(ch_.isdigit() for ch_ in w[k]): raise Refused(f"chain table {i + 1}'s {k} words hold a digit")
        fmt = it.get("fmt") or q.fmts["value"]
        if fmt not in q.defs: raise Refused(f"chain table {i + 1} names the format {fmt}, which the request does not define")
        if it.get("kind") not in (None, "flow", "stock"): raise Refused(f"chain table {i + 1}'s kind is neither flow nor stock")
        key = (it["table"], tuple(sorted(it["filter"].items())))
        if key in tables: raise Refused(f"the chain names {it['table']} at the same filter twice")
        tables.append(key)
        items.append(dict(it, fmt=fmt, series=chain_series(q, it)))
    common = set(q.wseries)
    for it in items: common &= set(it["series"])
    ys = run_years({y: 1 for y in sorted(common)}) if common else []
    if len(ys) < CHAIN_YEARS: return None, f"the chain tables and the whole share fewer than {CHAIN_YEARS} years in a row"
    first, last = ys[0], ys[-1]
    whole = [q.wseries[y][0] for y in ys]
    steps = {ys[i]: whole[i] - whole[i - 1] for i in range(1, len(ys))}
    band = max(steps, key=lambda y: (abs(steps[y]), -int(y)))
    prev = str(int(band) - 1)
    span = max(whole) - min(whole)
    if span <= 0 or steps[band] == 0: return None, "the whole does not move over the shared years"
    # the larger of the whole's two values less the smaller, above 0 whichever way it moved
    hi_y, lo_y = (band, prev) if steps[band] > 0 else (prev, band)
    f = {"m_hi": q.value(q.whole, hi_y), "m_lo": q.value(q.whole, lo_y), "band_y": q.value(q.whole, band),
         "m_step": {"op": "minus", "a": "m_hi", "b": "m_lo", "fmt": q.fmts["value"]}}
    panels, moved = [], 0
    for i, it in enumerate(items):
        code, s = f"c{i + 1}", it["series"]
        vals = [s[y][0] for y in ys]
        k = it.get("kind")
        if k is None: k = "flow" if min(vals) >= 0 and len(ys) <= BAR_MAX else "stock"
        kind = "bar" if k == "flow" and min(vals) >= 0 else "line"
        zero = kind == "bar" or (min(vals) >= 0 and min(vals) <= max(vals) / 2)
        filt = it["filter"]
        f[f"{code}_first"] = {"table": it["table"], "filter": filt, "time": first, "fmt": it["fmt"]}
        f[f"{code}_last"] = {"table": it["table"], "filter": filt, "time": last, "fmt": it["fmt"]}
        pstep = {ys[j]: abs(vals[j] - vals[j - 1]) for j in range(1, len(ys))}
        big = max(pstep, key=lambda y: (pstep[y], -int(y)))
        moved += int(band) <= int(big) <= int(band) + 2
        p = {"code": code, "title": SW(it["words"]["measure"]), "unit": SW(it["words"]["unit"]), "kind": kind, "zero": zero,
             "points": [s[y][1] for y in ys], "first_text": f"fact:{code}_first", "last_text": f"fact:{code}_last",
             "periods": [f"period:{it['table']}:{first}", f"period:{it['table']}:{last}"]}
        if i < len(items) - 1: p["link"] = ST("story.chain.link")
        panels.append(p)
    data = {"title": SW(q.words["measure"]), "panels": panels,
            "band": {"from": band, "to": band, "label": ST("story.chain.band", y="band_y")},
            "footnote": ST("story.chain.foot")}
    title = W(q.words["measure"]) + T("story.chain.title")
    text = T("story.chain.text")
    size = clamp(abs(steps[band]) / span)
    share = moved / len(items)
    surprise = clamp(0.3 + 0.7 * share)
    sturdy = clamp(len(ys) / 10) * clamp(len(items) / 4)
    return {"angle": "chain", "layer": "event_chain", "kicker": T("story.chain.kicker"), "title": title, "text": text, "facts": f,
            "data": data, "claim": {"num": "fact:m_step", "head": title}, "notes": [], "last": "c1_last",
            "score": round(size * surprise * sturdy, 4),
            "why": {"size": round(size, 3), "surprise": round(surprise, 3), "sturdy": round(sturdy, 3), "band": band, "moved": moved},
            "summary": "companion series side by side around the one year the whole moved most"}, None


ANGLES = [angle_path, angle_need, angle_spread, angle_ends, angle_chain]


def candidates(r):
    q = Req(r)
    out, dropped = [], []
    for fn in ANGLES:
        try:
            c, why = fn(q)
        except Refused as e:
            c, why = None, str(e)
        name = fn.__name__[len("angle_"):]
        if c is None:
            dropped.append({"angle": name, "why": why}); continue
        c["id"] = name
        out.append(c)
    # one per layer by construction (each angle names its own); best first, the angle's order breaks a tie
    out.sort(key=lambda c: -c["score"])
    return q, out[:TOP_K], dropped


# ---------------------------------------------------------------- compose the picked ones into the page

def compose(r):
    q, cands, _ = candidates(r)
    picks = r.get("picks")
    by_id = {c["id"]: c for c in cands}
    if not isinstance(picks, list) or not 2 <= len(picks) <= 4:
        raise Refused(f"findings: {picks!r} picks; two to four make a story")
    if len(set(picks)) != len(picks): raise Refused("findings: a finding is picked twice")
    for p in picks:
        if p not in by_id: raise Refused(f"findings: {p!r} is not a candidate of this request")
    chosen = [by_id[p] for p in picks]
    facts, leaves, sections = {}, {}, []
    for c in chosen:
        for k, v in c["facts"].items():
            if k in facts and facts[k] != v:
                raise Refused(f"findings: the fact {k} is declared two ways by two findings")
            facts[k] = v
        leaves[c["layer"]] = c["data"]
    first = chosen[0]
    leaves[THESIS] = {"answer": segs(first["title"]),
                      "claims": [{"num": c["claim"]["num"], "head": segs(c["claim"]["head"]), "section": segs(c["kicker"])}
                                 for c in chosen]}
    sections.append({"id": "thesis", "layer": THESIS})
    for c in chosen:
        sections.append({"id": c["id"], "layer": c["layer"], "kicker": wording(c["kicker"]), "title": wording(c["title"]),
                         "text": wording(c["text"])})
    items = [ST("story.notes.scenario")] if any("scenario" in c["notes"] for c in chosen) else []
    last = max(chosen, key=lambda c: c["facts"][c["last"]]["time"])["last"]
    items.append(ST("story.notes.last", last=last))
    leaves[NOTES] = {"title": ST("story.notes.title"), "items": items}
    sections.append({"id": "notes", "layer": NOTES})
    return {"facts": facts, "sections": sections, "leaves": leaves}


def as_fill(r, page):
    """The composed page as the part of a fill it adds (the flow merges it in, a key held another way refusing): the spec's
    facts, formats, sections and leaf data, the places' names and the members, and the rows the facts read."""
    m = r.get("main") or {}
    return {"knobs": {"spec": {"facts": page["facts"], "fmts": r.get("fmt_defs") or {}, "sections": page["sections"],
                               "hero": {"leaves": page["leaves"]}},
                      "labels": r.get("zh") or {}, "members": m.get("members") or []},
            "rows": r.get("rows") or []}


def answer(r):
    """One request's reply: the candidates, or the composed page; a refusal says why."""
    try:
        if r.get("mode") == "compose":
            return as_fill(r, compose(r))
        _, cands, dropped = candidates(r)
        return {"candidates": [{k: c[k] for k in ("id", "angle", "layer", "score", "why", "summary")} for c in cands],
                "dropped": dropped}
    except Refused as e:
        return {"refused": [str(e)]}


def main():
    """One JSON request a line on stdin, one JSON reply a line on stdout (next_leaf's child protocol)."""
    for line in sys.stdin:
        if not line.strip(): continue
        try:
            r = json.loads(line)
        except ValueError as e:
            out = {"refused": [f"findings: the request is not JSON: {e}"]}
        else:
            out = answer(r) if isinstance(r, dict) else {"refused": ["findings: the request is no object"]}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    main()
