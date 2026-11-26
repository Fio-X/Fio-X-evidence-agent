"""unit_grid layer: one glyph a member, every member of a group in one grid ("x of n"), each glyph's state bound to the data,
in change_dots.py's layer style. It answers "how many of them": a member the rule holds for is a lit glyph (the accent), every
other one is grey, so the count is the picture. Two glyphs: a plain rounded square ("cell") or a small turbine (a tower and
three blades at one fixed pose, "turbine"): the first illustration bound to data, its lit state the member's flag. Two modes:
"flag" (a glyph lit or grey) and "fill" (a cell filled from its foot to value / reference, at most full, so a bar in a cell
reads as the way to the reference; the cells the rule holds for are filled in the accent, the others in grey).
The leaf recomputes every flag from the member's series cell and the rule (ge / gt / le / lt a threshold that is a ledger
entry, or bottom / top k by value) and refuses a member whose flag (layer 1's fact) is not the one its cell gives, and a
printed count (a ledger entry printed with FX.entry) that is not the number of lit glyphs it recomputes: the number of lit
glyphs is filled by the program from the facts, never given. One accent: the lit glyphs (accent_when "none": in ink). Names:
under every glyph when every name fits its column (show_names "auto" or "all"), else only under the lit glyphs, a name that
would meet its neighbour's dropped to a second line on a short leader. Every printed number is a ledger entry printed with
FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a story page, the hero's leaves.unit_grid, run.py leaf): {
  "title": segs, "unit": segs,                      # what is counted, once, in the head
  "lead": segs?,                                    # one line under the head
  "name_kind": "place" | <kind>?,                   # how a member's name is looked up (default place)
  "mode": "flag" | "fill",
  "members": [{"code": code,                        # a member; its name is the request's label for the code
               "value": series src,                 # its cell (geometry only: the rule and the fill)
               "flag": bool?}],                     # layer 1's fact: the rule holds for it (needed in flag mode; checked when given)
  "rule": {"op": "ge"|"gt"|"le"|"lt", "ref": ledger src}   # a member is lit when its value op the threshold the entry prints
        | {"op": "bottom"|"top", "k": int},         # ... or when it is among the k lowest / highest by value
  "scale": number?,                                 # the ledger's format scale over the series' unit (default 1)
  "count": {"src": ledger src, "words": segs}?,     # the number of lit members as printed (big, in the accent) and what it counts
  "total": ledger src?,                             # the number of members as printed, when the words print it
  "fill_ref": ledger src?,                          # fill mode: the reference a full cell stands for (default the rule's ref)
  "key": {"lit": segs, "unlit": segs?, "fill": segs?},   # the key's words: a lit glyph, a grey one, a full cell (fill mode)
  "accent_only": [code, ...]?,                      # of the lit members, the ones in the accent; the other lit glyphs, and the
                                                    # key's lit glyph when any is, in ink (wbkit.accent_only)
  "omit": segs?, "footnote": segs?}                 # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): the count of members the rule holds
for (op n over the members with the rule as its filter), the threshold (the reference) as an entry, the total when printed; each
member's flag (the rule over its cell) is a fact the leaf recomputes.
needs new wording: none fixed; the key's, the count's and the lines' words come from the data as segments.
Refuses: fewer than eight members, a member twice, a code that is no code, a value that is no series cell, a rule that is none
of its ops or a threshold that is no number, bottom / top k off 1..members - 1 or cut inside a tie, a member's flag that is not
the rule over its cell (or none in flag mode), a printed count or total that is no whole number or not the number the cells
give, the turbine in fill mode, a fill reference at or under 0, a digit in a literal word, names that do not fit under
show_names "all", a text that leaves the picture or overlaps another, a grid wider than the board."""
import math
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "unit_grid"
MEMBERS_MIN = 8
MIN_COLS = 4   # the fewest glyphs in a row when show_names auto spreads the grid to name them all
OPS = {"ge": lambda v, t: v >= t, "gt": lambda v, t: v > t, "le": lambda v, t: v <= t, "lt": lambda v, t: v < t}
RANKED = ("bottom", "top")
NUM = re.compile(r"[-−]?[0-9][0-9,]*(?:\.[0-9]+)?%?")
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    count_size=(24, (16, 40, 1), "the count's size px"),
    width=(1140, (300, 1400, 10), "picture width in px"), cols=(9, (3, 30, 1), "glyphs in a row"),
    glyph=("cell", ("cell", "turbine"), "a member's glyph: a rounded square, or a small turbine, a tower and three blades (flag mode only)"),
    sort=("given", ("given", "value", "flag_first"), "glyph order: as given, by value highest first, or the lit ones first (then by value)"),
    accent_when=("flag", ("flag", "none"), "the lit glyphs in the accent, or in ink (no accent in the picture)"),
    cell=(40, (16, 80, 2), "a glyph's size in px"), gap=(16, (2, 48, 1), "space between two glyphs in px"),
    show_names=("auto", ("auto", "all", "lit"), "names under every glyph when they all fit (auto; all refuses when not), or only under the lit ones"))


def number(src, scale, what):
    """The raw value a ledger entry prints (its number over the format's scale); a text that is no number refuses."""
    t = FX.text(src).strip()
    if not NUM.fullmatch(t): raise Refused(f"unit_grid: {what} {t!r} ({src}) is no number")
    return float(t.replace(",", "").replace("−", "-").rstrip("%")) / scale


def whole(src, what):
    t = FX.text(src).strip()
    if not t.isdigit(): raise Refused(f"unit_grid: the printed {what} {t!r} ({src}) is no whole number")
    return int(t)


def lit_set(vals, rule, scale):
    """The codes the rule holds for, over {code: value}: a threshold op, or the k lowest / highest (a cut inside a tie refuses)."""
    if not isinstance(rule, dict) or rule.get("op") not in (*OPS, *RANKED): raise Refused(f"unit_grid: the rule {rule!r} is none of {'|'.join((*OPS, *RANKED))}")
    op = rule["op"]
    if op in OPS:
        if not isinstance(rule.get("ref"), str): raise Refused(f"unit_grid: the rule {op} names no threshold entry (ref)")
        t = number(rule["ref"], scale, "the threshold")
        return {c for c, v in vals.items() if OPS[op](v, t)}
    k = rule.get("k")
    if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k < len(vals): raise Refused(f"unit_grid: the rule {op} k {k!r} is off 1..{len(vals) - 1}")
    order = sorted(vals.values(), reverse=op == "top")
    edge, nxt = order[k - 1], order[k]
    if edge == nxt: raise Refused(f"unit_grid: the {op} {k} cut inside a tie (members {k} and {k + 1} hold one value)")
    return {c for c, v in vals.items() if (v <= edge if op == "bottom" else v >= edge)}


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        if d.get("lead") is not None: K.segs(d["lead"], "lead")
        kind = d.get("name_kind", "place")
        f.mode = d.get("mode")
        if f.mode not in ("flag", "fill"): raise Refused(f"unit_grid: mode {f.mode!r} is not flag or fill")
        if f.mode == "fill" and k("glyph") == "turbine": raise Refused("unit_grid: the turbine draws in flag mode only; fill mode draws cells")
        mem = d.get("members")
        if not isinstance(mem, list) or len(mem) < MEMBERS_MIN: raise Refused(f"unit_grid: the spec holds fewer than {MEMBERS_MIN} members")
        codes = [m.get("code") if isinstance(m, dict) else None for m in mem]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"unit_grid: the members' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"unit_grid: the members {twice} come twice")
        scale = d.get("scale", 1)
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or scale <= 0: raise Refused(f"unit_grid: scale {scale!r} is no number above 0")
        vals = {m["code"]: K.val(m.get("value")) for m in mem}
        rule = d.get("rule")
        if rule is None and f.mode == "flag": raise Refused("unit_grid: flag mode needs a rule")
        f.lit = lit_set(vals, rule, scale) if rule is not None else set()
        for m in mem:
            fl = m.get("flag")
            if fl is None:
                if f.mode == "flag": raise Refused(f"unit_grid: member {m['code']} carries no flag (flag mode)")
                continue
            if not isinstance(fl, bool): raise Refused(f"unit_grid: member {m['code']}'s flag {fl!r} is no true or false")
            if fl != (m["code"] in f.lit): raise Refused(f"unit_grid: member {m['code']}'s flag {fl} is not the rule over its cell ({m['code'] in f.lit})")
        cnt = d.get("count")
        # a rule may go without its count (a page that prints no number layer 1 cannot recompute); the flags are checked either way
        f.count = None
        if cnt is not None:
            if not isinstance(cnt, dict) or not isinstance(cnt.get("src"), str): raise Refused("unit_grid: count is {src, words}")
            n = whole(cnt["src"], "count")
            if n != len(f.lit): raise Refused(f"unit_grid: the printed count {n} ({cnt['src']}) is not the number of lit cells the values give ({len(f.lit)})")
            K.segs(cnt.get("words"), "count words")
            f.count = K.ent(cnt["src"])
        if d.get("total") is not None:
            n = whole(d["total"], "total")
            if n != len(mem): raise Refused(f"unit_grid: the printed total {n} ({d['total']}) is not the number of members ({len(mem)})")
        f.ref = None
        if f.mode == "fill":
            src = d.get("fill_ref") or (rule or {}).get("ref")
            if not isinstance(src, str): raise Refused("unit_grid: fill mode needs a reference entry (fill_ref or the rule's ref)")
            f.ref = number(src, scale, "the fill reference")
            if f.ref <= 0: raise Refused(f"unit_grid: the fill reference {f.ref} is at or under 0")
        key = d.get("key")
        if not isinstance(key, dict) or (f.lit and key.get("lit") is None): raise Refused("unit_grid: the key needs the lit glyph's words (key.lit)")
        for n in ("lit", "unlit", "fill"):
            if key.get(n) is not None: K.segs(key[n], f"key {n}")
        f.hot = K.accent_only("unit_grid", d, f.lit)   # the lit glyphs in the accent (accent_when flag); the other lit ones in ink
        f.rows = [dict(code=m["code"], v=vals[m["code"]], lit=m["code"] in f.lit, name=K.named(m["code"], kind), i=i) for i, m in enumerate(mem)]
        if k("sort") == "value": f.rows.sort(key=lambda r: (-r["v"], r["code"]))
        elif k("sort") == "flag_first": f.rows.sort(key=lambda r: (not r["lit"], -r["v"], r["code"]))
        f.cols = min(k("cols"), len(f.rows))
        gap, sn = k("gap"), k("show_names")
        widths = [tw(r["name"][1], f.size) for r in f.rows]

        def stand(cols, pitch):
            """Every name under its glyph, in the row, clear of the one before it as it is drawn (a name keeps inside the board: the first
            column's is shifted right, so a long name in the first two columns can meet its neighbour)."""
            for i, w in enumerate(widths):
                if w > pitch - 4: return False
                if i % cols and i:
                    x0 = lambda j: min(max(8 + (j % cols) * pitch + k("cell") / 2 - widths[j] / 2, 0.0), f.W - widths[j])
                    if x0(i) < x0(i - 1) + widths[i - 1] + 2: return False
            return True
        if sn == "auto" and f.cols * k("cell") + (f.cols - 1) * gap + 16 <= f.W and not stand(f.cols, k("cell") + gap):   # a grid that fits as given
            # every name under its glyph is worth a wider gap (a question that asks which ones is answered by the grey names too): the gap grows to the
            # widest name, and while the grid then leaves the board the row holds one glyph fewer (at least MIN_COLS); else only the lit ones are named
            want = math.ceil(max(widths) + 4 - k("cell"))
            for cols in range(f.cols, MIN_COLS - 1, -1):
                room = (f.W - 16 - cols * k("cell")) // (cols - 1)   # the widest gap the board allows at this many columns
                g = next((g for g in range(want, room + 1) if stand(cols, k("cell") + g)), None)
                if g is not None: f.cols, gap = cols, g; break
        f.pitch = k("cell") + gap
        f.grid_w = f.cols * k("cell") + (f.cols - 1) * gap
        if f.grid_w + 16 > f.W: raise Refused(f"unit_grid: the grid ({f.grid_w} px) is wider than the board ({f.W} px less its margins)")
        # names: under every glyph when each fits its column, else only under the lit ones
        fits = stand(f.cols, f.pitch)
        if sn == "all" and not fits: raise Refused(f"unit_grid: a name is wider than its column ({f.pitch - 4} px); fewer columns, a larger gap, or show_names lit")
        f.names = "all" if sn != "lit" and fits else "lit"
        f.H = 0


def turbine(x, y, s, fill, code, lit):
    """A small turbine in an s x s box at (x, y): a tapered tower from the hub to the foot, a hub, three blades at a fixed
    pose (one straight up, the others 120 degrees round), each a slim leaf shape; all in one fill."""
    cx, hy = x + s / 2, y + s * 0.36
    blade, root, tip = s * 0.36, s * 0.085, s * 0.025
    parts = [f'<path d="M{cx - s * 0.045:.2f},{hy:.2f} L{cx + s * 0.045:.2f},{hy:.2f} L{cx + s * 0.075:.2f},{y + s:.2f} L{cx - s * 0.075:.2f},{y + s:.2f} Z"/>']
    for deg in (-90, 30, 150):
        a = math.radians(deg); ux, uy = math.cos(a), math.sin(a); px, py = -uy, ux
        bx, by = cx + ux * blade, hy + uy * blade
        mx, my = cx + ux * blade * 0.3, hy + uy * blade * 0.3   # the blade is widest a third of the way out
        parts.append(f'<path d="M{cx + px * root * 0.6:.2f},{hy + py * root * 0.6:.2f} Q{mx + px * root * 1.6:.2f},{my + py * root * 1.6:.2f} '
                     f'{bx + px * tip:.2f},{by + py * tip:.2f} L{bx - px * tip:.2f},{by - py * tip:.2f} '
                     f'Q{mx - px * root * 0.4:.2f},{my - py * root * 0.4:.2f} {cx - px * root * 0.6:.2f},{hy - py * root * 0.6:.2f} Z"/>')
    parts.append(f'<circle cx="{cx:.2f}" cy="{hy:.2f}" r="{s * 0.08:.2f}"/>')
    return f'<g class="glyph turbine" data-code="{esc(code)}" data-lit="{1 if lit else 0}" fill="{fill}">{"".join(parts)}</g>'


def cell(x, y, s, fill, code, lit, share=None, empty="var(--empty)"):
    """A rounded square; with share (fill mode) the square is the empty ground and the fill rises from its foot to share of it."""
    r = s * 0.16
    if share is None:
        return f'<rect class="glyph cell" x="{x:.1f}" y="{y:.1f}" width="{s}" height="{s}" rx="{r:.1f}" fill="{fill}" data-code="{esc(code)}" data-lit="{1 if lit else 0}"/>'
    h = s * share; top = y + s - h; bot = y + s
    if h >= s - 0.01: body = f'<rect x="{x:.1f}" y="{y:.1f}" width="{s}" height="{s}" rx="{r:.1f}"/>'
    elif h <= r: body = f'<rect x="{x:.1f}" y="{top:.2f}" width="{s}" height="{h:.2f}" rx="{h / 2:.2f}"/>' if h > 0 else ""
    else: body = (f'<path d="M{x:.1f},{top:.2f} H{x + s:.1f} V{bot - r:.2f} Q{x + s:.1f},{bot:.1f} {x + s - r:.2f},{bot:.1f} H{x + r:.2f} '
                  f'Q{x:.1f},{bot:.1f} {x:.1f},{bot - r:.2f} Z"/>')
    return (f'<g class="glyph cell fill" data-code="{esc(code)}" data-lit="{1 if lit else 0}" data-share="{share:.4f}">'
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{s}" height="{s}" rx="{r:.1f}" fill="{empty}"/><g fill="{fill}">{body}</g></g>')


def glyph(f, x, y, s, lit, code, share=None, hot=True):
    on = "var(--accent)" if f.k("accent_when") == "flag" and hot else "var(--t-title)"
    if f.k("glyph") == "turbine": return turbine(x, y, s, on if lit else "var(--bar)", code, lit)
    if f.mode == "fill": return cell(x, y, s, on if lit else "var(--t-sec)", code, lit, share)
    return cell(x, y, s, on if lit else "var(--bar)", code, lit)


def cl_unit_grid(f, occ):
    d, size, W, s, gap = f.d, f.size, f.W, f.k("cell"), f.k("gap")
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    y = 22
    if d.get("lead"):
        y += size * 1.8
        o.append(K.words(B, d["lead"], "lead", 8, y, size, "var(--t-body)", max_w=W - 16)[0])
    if f.count:
        cs = f.k("count_size"); y += size * 0.6 + cs
        c_svg, c_txt = f.count
        o.append(K.txt(B, 8, y, cs, "var(--accent)" if f.k("accent_when") == "flag" else "var(--t-title)", c_svg, tw(c_txt, cs), weight=700, tag="count"))
        o.append(K.words(B, d["count"]["words"], "count words", 8 + tw(c_txt, cs) + 8, y, size, "var(--t-body)", max_w=W - 24 - tw(c_txt, cs))[0])
    # the key: a lit glyph and its words, a grey one and its words, a full cell (fill mode) and its words
    key, ks = d["key"], max(12, round(size * 1.2))
    y += size * 1.2 + ks; kx = 8
    for part, lit, share in (("lit", True, 1.0), ("unlit", False, 1.0), ("fill", True, 0.5)):
        if key.get(part) is None or (part == "fill" and f.mode != "fill"): continue
        o.append(glyph(f, kx, y - ks * 0.85, ks, lit, f"key-{part}", share if f.mode == "fill" else None, f.hot == f.lit).replace('class="glyph', 'class="key glyph'))
        t, box, _ = K.words(B, key[part], f"key {part}", kx + ks + 6, y, size, "var(--t-sec)")
        o.append(t); kx = box[2] + 18
    top = y + size * 1.2
    name_lines = 1 if f.names == "all" else 2
    pitch_y = s + gap + (size * 1.35 * name_lines if f.names else 0)
    for i, r in enumerate(f.rows):
        col, row = i % f.cols, i // f.cols
        x, gy = 8 + col * f.pitch, top + row * pitch_y
        share = min(max(r["v"] / f.ref, 0.0), 1.0) if f.mode == "fill" else None
        o.append(glyph(f, x, gy, s, r["lit"], r["code"], share, r["code"] in f.hot))
    # names: every glyph's under it, or the lit ones' (one that would meet the name before it in its row drops to a second line on a leader)
    last, first_line = {}, {}
    for i, r in enumerate(f.rows):
        if f.names == "lit" and not r["lit"]: continue
        row = i // f.cols
        w = tw(r["name"][1], size); x0 = min(max(8 + (i % f.cols) * f.pitch + s / 2 - w / 2, 0.0), W - w)
        if f.names != "lit" or row not in last or x0 >= last[row] + 6: first_line.setdefault(row, []).append((x0, x0 + w)); last[row] = x0 + w
    last = {}
    for i, r in enumerate(f.rows):
        if f.names == "lit" and not r["lit"]: continue
        col, row = i % f.cols, i // f.cols
        cx, gy = 8 + col * f.pitch + s / 2, top + row * pitch_y
        nm_svg, nm = r["name"]; w = tw(nm, size)
        x0 = max(cx - w / 2, 0.0); x0 = min(x0, W - w); line = 0
        if f.names == "lit" and row in last and x0 < last[row] + 6: line = 1
        ny = gy + s + size * 1.1 + line * size * 1.35
        hot = r["lit"] and f.k("accent_when") == "flag" and r["code"] in f.hot
        if line:
            # the leader falls through the first line of names: it must meet none of them, and it stops clear of its own name's box
            # (a Chinese face's text box rises above the baseline by more than 0.85 of its size, so a leader to the cap line touches it)
            if any(a - 1 <= cx <= b + 1 for a, b in first_line[row]): raise Refused(f"unit_grid: the leader of {nm!r} overlaps a name on the first line of its row (text overlap); fewer columns or show_names all")
            o.append(f'<line x1="{cx:.1f}" y1="{gy + s + 2:.1f}" x2="{cx:.1f}" y2="{ny - size * 1.3:.1f}" stroke="var(--t-sec)" stroke-width="0.6"/>')
        o.append(K.txt(B, x0 + w / 2, ny, size, "var(--accent)" if hot else "var(--t-body)", nm_svg, w, anchor="middle", weight=700 if r["lit"] else 400, tag=f"name {r['code']}"))
        if not line: last[row] = x0 + w
    y = top + math.ceil(len(f.rows) / f.cols) * pitch_y - gap + size * 0.8   # the grid's foot (its last names), then a gap
    for k_, what in (("omit", "omit"), ("footnote", "footnote")):
        if d.get(k_):
            y += size * 1.5
            o.append(K.words(B, d[k_], what, 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(x for x in o if x)


UNIT_GRID_LAYERS = dict(unit_grid=(cl_unit_grid, None))
UNIT_GRID_SVG = ["unit_grid"]


def draw(h):
    f = Frame(h)
    inner = cl_unit_grid(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "unit_grid"), f.W, f.H
