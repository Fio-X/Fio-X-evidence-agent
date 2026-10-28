"""Second-layer leaf child for the ring hero panel (src/next_leaf.rs runs it, one child per panel, one JSON line per layer).

In, per line: {"phase": "reserve"|absent, "node", "layer", "panel": {"w", "h", "frame"}, "rows", "knobs", "occ"}.
Out, per line: {"svg"} for the picture's layers or {"html"} for the ones laid out in the browser (legend, callouts). The
ring frame and the occupancy table stay in this child across the panel's lines.
Last, the page: {"phase": "page", "layers": {layer: what it drew}} -> {"html"}, the whole page (header, the ring hero
around the given layers, each tagged data-layer, footer) in the frame the layers were drawn in; a section no leaf layer
draws yet (top, band, strip, row, big numbers) refuses the page instead of being drawn here. A page line before any
layer line refuses, and so does a page that still holds a {placeholder} outside its style and script. The hero
carries the hooks the browser check reads (runtime/pi/browser_qa.py): HOOKS.

rows: one row shape, the one next_facts::recheck reads, so every src a leaf prints is one the recheck can recompute:
  {"src": "series:<table>/<codes>:<time>:OBS_VALUE", "table", "dims": {...}, "time", "value"}  a cell of a data table;
  {"src": "fact:<key>[.n|.t|.tick<i>]", "text"}                                                 a ledger entry to print;
  {"src": "period:<table>:<year>", "text"}, {"src": "record:<table>/<row>:<column>.y|.m|.d", "text"}  the same, for a
  year the table covers and the parts of a record's date. A family member's key is <family>.<code>.
Records of a sourced list (routes, terminals, cities, events) use the same shape with every column in dims, time and
value empty, src "record:<table>/<row>". Raw values drive geometry only; a digit printed from them is the page number
check's to refuse.
knobs: {"spec": the page config the prototype reads (tables, fmts, facts, hero), "shapes": the Natural Earth file}.

A layer prints a ledger entry as given, marked with its src (facts.entry); a src the request lacks refuses the layer
({"refused": [...]}). Printing sites moved so far: the fact placeholders of every text ({key}, {key.n}, {key.t}), the
ring's marks and years, the map's short labels (the family the map's label_fact names) and the callouts' dates; the
others still format their own numbers until the next commits move them."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts as FX
import geo
import prod
import scmp
from words import word


def tables(rows):
    """The prototype's tables (csv-shaped dicts, file order) rebuilt from the request's rows."""
    T = {}; FX.SRCS = {}
    for r in rows:
        if "table" not in r: continue
        cell = dict(r["dims"])
        if r["src"].startswith("series:"): cell.update(TIME_PERIOD=r["time"], OBS_VALUE=r["value"])
        T.setdefault(r["table"], []).append(cell); FX.SRCS[id(cell)] = r["src"]
    return T


def fact_times(spec):
    """With a ledger the map's legend prints its t0 year beside the legend_fact family's value and its short labels print the
    label_fact family: each family's declared time must be that year, or a right number prints under the wrong year."""
    d = spec["hero"]["data"]
    for fam, t in (("legend_fact", "t0"), ("label_fact", "t1")):
        if not d.get(fam): continue
        got = spec["facts"].get(d[fam], {}).get("time")
        if str(got) != str(d[t]): raise FX.Refused(f"map: the {fam} family {d[fam]} is at {got}, the map's {t} is {d[t]}")


class Panel:
    """What one panel's lines share: the context, the ring frame and the occupancy table, built on the first line."""
    def __init__(p, req):
        k = req["knobs"]; spec = k["spec"]; FX.TABLES = tables(req["rows"]); geo.NE = k["shapes"]; prod.NAMES = k.get("labels") or {}
        FX.MEMBERS = list(k["members"]) if k.get("members") else None
        FX.LEDGER = {r["src"]: r["text"] for r in req["rows"] if "text" in r} or None
        if FX.LEDGER is not None: fact_times(spec)
        spec["fmts"]["bcm0"] = {"scale": 0.01, "dec": 0}  # as scmp.page sets it
        c = prod.Ctx(spec); h = spec["hero"]
        if prod.knob(h, "frame", "gap_dir") == "auto": h = {**h, "_gapdir": scmp.empty_corner(c, h)}
        if scmp.title_in(h): h = {**h, "_title": scmp.page_head(c, spec)}
        p.c, p.spec = c, spec
        p.f = scmp.RingFrame(c, h); p.f.wrap, p.f.mapout, p.f.ret = k.get("wrap", False), {}, {}
        p.occ = prod.Occ()


NOT_LEAF = ("top", "band", "strip", "row", "bignums")


def page(panel, got):
    """The whole page around the layers the panel drew (`got`, layer -> svg or html), as scmp.page lays it out."""
    f, spec = panel.f, panel.spec; tin = bool(f.h.get("_title"))
    pic = [n for n in scmp.RING_SVG if not (n == "inset" and tin)]
    need = pic + ["legend", "callouts"] + (["inset"] if tin else [])
    off = [f"page: {k} is not drawn by a leaf layer yet" for k in NOT_LEAF if spec.get(k)]
    off += [f"page: no layer {n}" for n in need if not isinstance(got.get(n), str)]
    off += [f"page: {n} is no layer the page places" for n in got if n not in need]
    if not f.wrap: off.append("page: the layers were drawn without data-layer (knobs.wrap)")
    if off: return {"refused": off}
    tag = lambda el, n: f'<{el} data-layer="{n}">{got[n]}</{el}>' if got[n] else ""  # as prod.layered wraps a drawn layer
    ins = got["inset"] if tin else ""  # the title-in inset is placed bare in the title column; it is tagged on its own root element
    if ins and not re.match(r"<\w", ins): return {"refused": ["page: the inset has no root element to tag"]}
    ins = re.sub(r"^<(\w+)", r'<\1 data-layer="inset"', ins, count=1)
    hero = hooked(scmp.ring_shell(f, "".join(tag("g", n) for n in pic), tag("div", "legend"), tag("div", "callouts"), ins, True), panel.c, spec)
    if isinstance(hero, list): return {"refused": hero}
    html = scmp.shell(panel.c, spec, ("" if tin else scmp.page_head(panel.c, spec)) + hero)
    left = sorted(set(re.findall(r"\{[A-Za-z_][\w.]*\}", re.sub(r"<(script|style)\b.*?</\1>", "", html, flags=re.S))))
    return {"refused": [f"page: the page still holds the placeholder {k}" for k in left]} if left else {"html": html}


# The browser check's module and accessibility hooks (browser_qa.py inspect_page): the ring hero is the page's one module
# (.pub-visual with a data-module-id), its picture svg the module's chart (.pub-chart: role img, an aria-label, a long
# description by aria-describedby, focusable). Each is added at one place and nowhere else, so the parity check can drop
# exactly these and compare the rest with the prototype byte for byte. The long description is the title filled through
# the ledger (c.t, its numbers marked like the h1's); an attribute cannot carry a mark, so the label is words only
# (chart.label around the kicker) and refuses a digit or a "{".
HOOKS = (('<div class="hero ring"', '<div class="hero ring pub-visual" data-module-id="ring"'),
         ('<svg class="leads"', '<svg class="leads pub-chart" role="img" aria-label="{label}" aria-describedby="desc-ring" tabindex="0"'),
         ('</div><script>', '<p id="desc-ring" hidden>{desc}</p></div><script>'))


def hooked(hero, c, spec):
    off = [f"page: the hero has {hero.count(a)} of {a!r}, not one" for a, _ in HOOKS if hero.count(a) != 1]
    if not re.sub(r"<[^>]*>", "", str(spec.get("title") or "")).strip(): off.append("page: the page has no title to name its chart")
    kick = str(spec.get("kicker") or "").strip()
    label = prod.esc(word("chart.label", v=kick)) if kick else ""
    if not kick: off.append("page: the page has no kicker to label its chart")
    elif re.search(r"[{}0-9\uff10-\uff19]", kick): off.append(f"page: the chart label holds a digit or a placeholder: {kick!r}")
    if off: return off
    for a, b in HOOKS: hero = hero.replace(a, b.replace("{label}", label).replace("{desc}", c.t(spec["title"])), 1)
    return hero


def main():
    panel, off = None, None
    for line in sys.stdin:
        req = json.loads(line)
        if req.get("phase") == "page" and not (panel or off):
            print(json.dumps({"refused": ["page: the page line came before any layer line"]}), flush=True); continue
        if not (panel or off):
            try: panel = Panel(req)
            except FX.Refused as e: off = e  # the frame lays the map out to find its empty corner: every layer of the panel refuses
        name = req.get("layer")
        if req.get("phase") == "page":
            if off: out = {"refused": [f"page: {off}"]}
            else:
                try: out = page(panel, req.get("layers") or {})
                except FX.Refused as e: out = {"refused": [f"page: {e}"]}
        elif name not in scmp.RING_LAYERS: out = {"error": f"no ring layer {name}"}
        elif off: out = {"refused": [f"{name}: {off}"]}
        elif req.get("phase") == "reserve":
            fn = scmp.RING_LAYERS[name][1]
            try:
                if fn: fn(panel.f, panel.occ)
                out = {}
            except FX.Refused as e: out = {"refused": [f"{name}: {e}"]}
        else:
            try:
                s = scmp.RING_LAYERS[name][0](panel.f, panel.occ)
                out = {"svg" if name in scmp.RING_SVG else "html": s}
                if name == "map": out["sub"] = panel.f.mapout  # the map's own layers, for the layer-by-layer parity check
            except FX.Refused as e: out = {"refused": [f"{name}: {e}"]}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
