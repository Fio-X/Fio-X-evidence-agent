"""Shared bits of the chart leaves (section_head.py, rankbar.py, bubbles.py), written in column.py's layer style: a Frame
reads the layer's hero.data and the request's tables; a layer function cl_<name>(frame, occ) returns the picture's svg inner
string; knobs are registered in prod.KNOBS (default, range or options, what); every printed number is a ledger entry printed
with FX.entry (marked with its src); a place or category name is the request's label marked with its name row; anything the
leaf cannot print refuses (FX.Refused). Colours are the page's CSS variables (--accent, --bar, --empty, --t-title, --t-body,
--t-sec): the page's theme decides, a leaf names no colour. A leaf holds no topic word: every name, unit and title comes in
with the request."""
import html
import re

import facts as FX
import prod

Refused = FX.Refused
esc = lambda s: html.escape(str(s), quote=True)
tw = prod.tw
CODE = re.compile(r"[A-Za-z0-9_.\-]+")


VAL = {}  # {series src: value} read back from the request's own tables (FX.SRCS names each cell's row): geometry only, never printed


def val(src):
    """The value of a series src the request holds (a bar's length, a circle's area); a src it lacks refuses."""
    if not isinstance(src, str) or src not in VAL: raise Refused(f"{src} is not a series of the request")
    return VAL[src]


def setup(rows, labels, run_tables):
    """What run.Panel sets from a request: the tables, the ledger texts, the names; then the series values (read_values)."""
    FX.TABLES = run_tables(rows)
    FX.LEDGER = {r["src"]: r["text"] for r in rows if "text" in r} or None
    prod.NAMES = dict(labels or {})
    read_values()


def read_values():
    """VAL from the request's tables as run.tables built them (FX.SRCS names each cell's row); a request without a ledger
    refuses."""
    if FX.LEDGER is None:
        raise Refused("this leaf prints from a ledger only")
    VAL.clear()
    for t in FX.TABLES.values():
        for c in t:
            src = FX.SRCS.get(id(c), "")
            if src.startswith("series:"): VAL[src] = float(c["OBS_VALUE"])


def knob(h, node, k):
    """The knob's value (the page's style first, else the default), checked against what prod.KNOBS says: a number inside its
    range, a word one of its options; anything else refuses."""
    spec = prod.KNOBS[node]
    st = h.get("style", {}).get(node, {})
    bad = sorted(set(st) - set(spec))
    if bad:
        raise Refused(f"{node}: no knob {bad}")
    v = st[k] if k in st else spec[k][0]
    d, ch, _ = spec[k]
    if ch is None:  # a free word list of codes: the frame checks them against what it draws
        if not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9_.,:\-]*", v): raise Refused(f"{node}: knob {k} {v!r} is not a comma list of codes")
    elif isinstance(d, str):
        if v not in ch:
            raise Refused(f"{node}: knob {k} {v!r} is not one of {list(ch)}")
    elif isinstance(d, (int, float)) and not isinstance(d, bool):
        lo, hi = ch[0], ch[1]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
            raise Refused(f"{node}: knob {k} {v!r} is off its range {lo}..{hi}")
    return v


def need(d, k):
    if k not in d or d[k] in (None, "", []):
        raise Refused(f"the module names no {k}")
    return d[k]


def codes_list(d, k, kind="codes"):
    v = need(d, k)
    if not isinstance(v, list) or not all(isinstance(c, str) and CODE.fullmatch(c) for c in v) or len(set(v)) != len(v):
        raise Refused(f"{k}: not a list of distinct {kind}")
    return v


def cells(table, fixed, dims, year, tbl):
    """{(code of dim 0, code of dim 1): value} of the one table at `year`, `fixed` dims held; the time axis is TIME_PERIOD."""
    if table not in tbl:
        raise Refused(f"the request holds no table {table}")
    out = {}
    for r in tbl[table]:
        if year is not None and str(r.get("TIME_PERIOD")) != str(year):
            continue
        if any(r.get(k) != v for k, v in fixed.items()):
            continue
        key = tuple(r.get(dm) if dm != "TIME_PERIOD" else str(r.get("TIME_PERIOD")) for dm in dims)
        if None in key:
            continue
        out[key] = float(r["OBS_VALUE"])
    return out


def name_row(code, kind):
    """The name row a label is read from: a place by its iso code length (prod.name_src), a category by its kind."""
    return prod.name_src(code) if kind == "place" else f"name:zh_names:{kind}:{code}"


def named(code, kind):
    """(escaped name in a tspan marked with its name row, plain name)."""
    nm = prod.NAME(code)
    return f'<tspan data-src="{esc(name_row(code, kind))}">{esc(nm)}</tspan>', nm


class Boxes:
    """Text boxes of one picture: a box outside the picture or over another refuses (the leaf never nudges a label)."""
    def __init__(s, w, h):
        s.w, s.h, s.b = w, h, []

    def add(s, x0, y0, x1, y1, tag):
        if x0 < -0.5 or y0 < -0.5 or x1 > s.w + 0.5 or y1 > s.h + 0.5:
            raise Refused(f"{tag}: the text leaves the {s.w:.0f}x{s.h:.0f} picture")
        for a, t in s.b:
            if x0 < a[2] - 0.5 and a[0] < x1 - 0.5 and y0 < a[3] - 0.5 and a[1] < y1 - 0.5:
                raise Refused(f"{tag} and {t}: two texts overlap; fewer items or a larger height")
        s.b.append(((x0, y0, x1, y1), tag))


def txt(boxes, x, y, size, fill, inner, width, anchor="start", weight=400, tag="text", style=""):
    """One <text> whose inner (tspans) is already marked; its box is checked."""
    x0 = x if anchor == "start" else x - width if anchor == "end" else x - width / 2
    boxes.add(x0, y - size * 0.8, x0 + width, y + size * 0.25, tag)
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" text-anchor="{anchor}" fill="{fill}" font-weight="{weight}"{style}>{inner}</text>')


def ent(src, size_w=None):
    """(tspan marked with the ledger entry, text) for a ledger src."""
    return FX.entry(src, "tspan", None), FX.text(src)


def svg(inner, W, H, cls):
    return f'<svg class="{cls}" viewBox="0 0 {W} {H:.0f}" width="{W}" height="{H:.0f}" role="img">{inner}</svg>'


# ---- the page's colour variables (the page defines them; a leaf only names them) --------------------------------------
# --accent: the one accent. --t-title/--t-body/--t-sec/--bar/--empty/--bg: ink and grey ground as before. --t-dark: the ink on a light fill.
# --cat-1 .. --cat-10: ten muted category hues; --seq-1 .. --seq-N: a sequential ramp, light -> dark, one hue.
# Derivation (page_vars below, the page shell calls it once from its own --accent and ground):
#   h0 = hue of --accent. Category i of n: hue h0 + 40 + i * 280/(n-1) degrees (so none lies within 40 degrees of the accent),
#   saturation 0.24, lightness 0.70 (muted: 'each hue lightened and greyed'). Sequential step j of N: a cool hue unrelated to the accent,
#   the accent's complement h0 + 180 (a grey-teal for a coral accent), saturation 0.12 -> 0.34, lightness 0.78 -> 0.28 (grey added at
#   the light end; never a red or brown, the accent itself marks only a highlighted row). Ink on a step: --t-dark on the lighter half, --t-title on the darker half.
import colorsys


def _hex(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l, s)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def page_vars(accent, cats=10, steps=9):
    """CSS custom properties (text for a style rule) for the categories and the sequential ramp, from the page's accent hex."""
    r, g, b = (int(accent[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h0 = colorsys.rgb_to_hls(r, g, b)[0] * 360
    out = [f"--cat-{i + 1}:{_hex(h0 + 40 + i * 280 / (cats - 1), 0.24, 0.70)}" for i in range(cats)]
    out += [f"--seq-{j + 1}:{_hex(h0 + 180, 0.12 + 0.22 * j / (steps - 1), 0.78 - 0.50 * j / (steps - 1))}" for j in range(steps)]
    return ";".join(out)


# ---- words: title, unit, label as SEGMENTS (on facts.py and words.py) -----------------------------------------------------
# [{"w": literal without a digit}, {"src": a ledger entry}, {"word": a key of words.zh.json whose value holds no {placeholder}}].
# A plain source string where words belong refuses. The text prints as ONE <text>; its ledger entries are <tspan data-src>, so
# run.drawn reads back "src+src"; a text of literals only has no src and no digit. An entry is one unbreakable unit.
import unicodedata
import words as WD
SERIF = "Songti SC, Noto Serif CJK SC, Georgia, serif"


def has_digit(text):
    return any(unicodedata.category(ch) in ("Nd", "Nl", "No") for ch in text)


NO_LINE_START = WD.WORDS["line.no_start"]  # the marks the language never starts a line with


def units_of(text):
    """Break units of a literal: a CJK character alone, a latin word with its trailing space."""
    out, cur = [], ""
    for ch in text:
        if ch in NO_LINE_START and not cur and out:  # a closing mark never starts a line: it stays with the unit before it
            out[-1] += ch
        elif tw(ch, 10) >= 9.9:
            if cur: out.append(cur); cur = ""
            out.append(ch)
        else:
            cur += ch
            if ch == " ": out.append(cur); cur = ""
    if cur: out.append(cur)
    return out


def segs(v, what):
    """[(text, src or None)] of a words spec; refuses a plain source string, a digit in a literal, an unknown key."""
    if isinstance(v, str): raise Refused(f"{what} is given as a ledger source {v!r}; words come as segments [{{'w': ..}}, {{'src': ..}}]")
    if not isinstance(v, list) or not v: raise Refused(f"{what} is not a list of segments")
    out = []
    for s in v:
        if not isinstance(s, dict) or sum(x in s for x in ("w", "src", "word")) != 1: raise Refused(f"{what} holds a segment that is not one of w, src, word")
        if "w" in s:
            if has_digit(s["w"]): raise Refused(f"{what}: the words {s['w']!r} hold a digit; a number must come as a ledger entry")
            out.append((s["w"], None))
        elif "src" in s: out.append((FX.text(s["src"]), s["src"]))
        else:
            if s["word"] not in WD.WORDS: raise Refused(f"{what}: the word table has no key {s['word']!r}")
            if "{" in WD.WORDS[s["word"]] or "}" in WD.WORDS[s["word"]]: raise Refused(f"{what}: the word {s['word']!r} holds a {{placeholder}}; a word segment prints as is")
            out.append((WD.WORDS[s["word"]], None))
    return out


def plain(v, what):
    return "".join(t for t, _ in segs(v, what))


def lay(sg, size, max_w):
    """The lines of a segment list: each a list of (text, src); an entry is one unit."""
    lines, line, cur = [], [], 0.0
    for text, src in sg:
        for u in ([text] if src else units_of(text)):
            w = tw(u, size)
            if line and cur + (tw(u.rstrip(), size) if not src else w) > max_w: lines.append(line); line, cur = [], 0.0
            line.append((u, src)); cur += w
    if line: lines.append(line)
    return lines


def words(B, v, what, x, y, size, fill, anchor="start", weight=400, serif=False, italic=False, max_w=None, line_h=None, max_lines=1):
    """The words as one <text>. Returns (svg, box of the first line, line count); every line's box is checked in B; over max_lines refuses."""
    sg = segs(v, what)
    lines = lay(sg, size, max_w if max_w else 10 ** 6)
    if len(lines) > max_lines: raise Refused(f"{what} takes {len(lines)} lines at this size, {max_lines} allowed")
    lh = line_h or size * 1.3; first = None; body = []
    for i, ln in enumerate(lines):
        w = tw("".join(t for t, _ in ln).rstrip(), size)
        x0 = x if anchor == "start" else x - w if anchor == "end" else x - w / 2
        b = (x0, y + i * lh - size * 0.8, x0 + w, y + i * lh + size * 0.25)
        B.add(b[0], b[1], b[2], b[3], what + (f" line {i + 1}" if i else ""))
        first = first or b
        body.append(f'<tspan x="{x:.1f}" y="{y + i * lh:.1f}">' + "".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in ln) + "</tspan>")
    st = ' font-style="italic"' if italic else ""
    ff = f' font-family="{SERIF}"' if serif else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" text-anchor="{anchor}" fill="{fill}" font-weight="{weight}"{st}{ff}>{"".join(body)}</text>', first, len(lines))


def head(B, title, unit, size, tsize, y=22):
    """The chart name (bold) and, beside it, the unit (italic), as every chart leaf prints them."""
    a, tb, _ = words(B, title, "title", 8, y, tsize, "var(--t-title)", weight=700)
    b, _, _ = words(B, unit, "unit", tb[2] + 8, y, size, "var(--t-sec)", italic=True)
    return a + b


def line(x0, y0, x1, y1, stroke="var(--t-sec)", w=0.6, op=0.35):
    return f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="{stroke}" stroke-width="{w}" stroke-opacity="{op}"/>'


# ---- the page's finding over two-sided totals (P5 prototype) -------------------------------------------------------------
# A data shape, not a chart: a leaf whose picture has two sides of named nodes, each node's value a ledger entry (a flow's
# sources and destinations; later a composition's parts and wholes), hands its nodes to two_sided and draws what comes back:
# the subject (one node, in the accent), the headline the page prints as its title, one short note per side comparing its
# first node with its second. Program rules only, no model word, no topic word, and no word of its own: every name is the
# request's label marked with its name row, every number a ledger entry, the words the word table's (FINDING_WORDS: keys of
# words.zh.json that exist today, so the table and the flow's copy count do not grow).
#   - a side takes part when it has two or more nodes besides a merged one, its largest above its second, the two printing
#     differently (a value another node prints alike is no one's own), and no merged node at or above its largest;
#   - the subject: the largest node of the side whose largest holds the greater share of its side's sum (the first side on a
#     tie); no side taking part, no finding (the page keeps its title, no accent, no note);
#   - the headline: the subject's name, its value and the unit's first segment, then the word of FINDING_WORDS["above"];
#     it states max (data-cmp max, data-a its value); the page check derives the set it is the max of from the ledger
#     (every value fact of the same table, time, format and filter dimension), never from the leaf;
#   - a note per side taking part, at its largest node: name, value, the same word, and in FINDING_WORDS["paren"] the second's
#     name and value; it states next (data-cmp next, data-a the first, data-b the second of that derived set).
FINDING_WORDS = {"above": "column.note.vs_next", "paren": "paren"}
FINDING_RELATION = {"headline": "max", "note": "next"}


def finding_side_top(nodes):
    """(first, second) of a side that takes part, else None; nodes [(code, value, text_src)], "_other" the merged node."""
    r = sorted([n for n in nodes if n[0] != "_other"], key=lambda n: (-n[1], n[0]))
    if len(r) < 2: return None
    a, b = r[0], r[1]
    if not a[1] > b[1] or FX.text(a[2]) == FX.text(b[2]): return None
    if any(n[0] == "_other" and n[1] >= a[1] for n in nodes): return None
    return a, b


def _finding_word(key, **parts):
    """The word table's entry as segments, each {placeholder} the given segments; a digit in its words refuses."""
    t = WD.WORDS[key]; out = []; at = 0
    for m in re.finditer(r"\{(\w+)\}", t):
        if m.start() > at: out.append({"w": t[at:m.start()]})
        if m.group(1) not in parts: raise Refused(f"the word {key} is given no {m.group(1)}")
        out += parts[m.group(1)]; at = m.end()
    if at < len(t): out.append({"w": t[at:]})
    if any(FX.digit(s["w"]) for s in out if "w" in s): raise Refused(f"the word {key} holds a digit")
    return out


def two_sided(sides, unit):
    """sides: [(name kind, nodes [(code, value, text_src)], side sum)] in the picture's order; unit: the picture's unit
    segments. None, or {"side", "subject", "headline": segs, "cmp": ("max", a_src, [srcs]), "notes": [{"side", "code",
    "segs", "cmp": ("gt", a_src, b_src)}]}; segs {"w"}, {"src", "bold"}, {"name", "kind"}, and the unit's first segment."""
    tops = [finding_side_top(nodes) for _, nodes, _ in sides]
    shares = [(t[0][1] / s if t and s > 0 else -1.0) for t, (_, _, s) in zip(tops, sides)]
    if max(shares) < 0: return None
    i = shares.index(max(shares)); kind, nodes, _ = sides[i]; a = tops[i][0]
    nm = lambda code, k: {"name": code, "kind": k}
    u = list(unit[:1])
    head = [nm(a[0], kind), {"w": " "}, {"src": a[2], "bold": True}] + ([{"w": " "}] + u if u else []) + _finding_word(FINDING_WORDS["above"])
    notes = []
    for j, ((k, _, _), t) in enumerate(zip(sides, tops)):
        if not t: continue
        x, y = t
        segs = [nm(x[0], k), {"w": " "}, {"src": x[2], "bold": True}] + _finding_word(FINDING_WORDS["above"]) + \
            _finding_word(FINDING_WORDS["paren"], v=[nm(y[0], k), {"w": " "}, {"src": y[2], "bold": True}])
        notes.append({"side": j, "code": x[0], "segs": segs, "cmp": (FINDING_RELATION["note"], x[2], y[2])})
    return {"side": i, "subject": a[0], "headline": head, "cmp": (FINDING_RELATION["headline"], a[2], [n[2] for n in nodes]), "notes": notes}


def finding_plain(segs):
    """A finding's segments (wbkit.two_sided) as printed: words, a node's name as named() prints it, a src's ledger text."""
    return "".join(s["w"] if "w" in s else named(s["name"], s["kind"])[1] if "name" in s else FX.text(s["src"]) for s in segs)


def finding_html(segs, tag="tspan"):
    """A finding's segments marked: in svg (tspan) a name as named() marks it and a value bold, both by their rows; in html
    (span) the same marks on spans, a value in <b class="n"> as FX.fill prints a number."""
    out = []
    for s in segs:
        if "w" in s: out.append(html.escape(s["w"], quote=False))
        elif "name" in s:
            inner, nm = named(s["name"], s["kind"])
            out.append(inner if tag == "tspan" else f'<span data-src="{esc(name_row(s["name"], s["kind"]))}">{esc(nm)}</span>')
        elif s.get("bold"): out.append(f'<tspan font-weight="700">{FX.entry(s["src"], "tspan", None)}</tspan>' if tag == "tspan" else f'<b class="n">{FX.entry(s["src"], "span", None)}</b>')
        else: out.append(FX.entry(s["src"], tag, None))
    return "".join(out)


def check_codes(node, v, known):
    """A knob's comma list of codes must name drawn codes."""
    bad = [c for c in v.split(",") if c and c not in known]
    if bad: raise Refused(f"{node}: names {bad}, codes the request does not hold")
    return {c for c in v.split(",") if c}
