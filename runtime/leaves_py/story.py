"""story page: a long page of sections, the page recipe `page_story` (run.py KINDS, knobs.py RECIPES). The opening picture, the header,
then the sections in the order the request lists them, then the end line, the unanswered lines and the sources (scmp.shell).
Nothing here belongs to a topic: the sections, the leaf each one draws, their kickers, titles and texts all come from the request
(knobs.spec.sections); this file lays them out and checks them.

spec.sections: [{"id": code, "layer": a story leaf (STORY_LAYERS), "kicker"?: words, "title"?: wording, "text"?: wording}, ...] in page
order. A section with a title is a titled section: a kicker (a pill), the title (h2), the text (p), then its picture. A section with no
title is a bare block (the thesis, the one-axis answer, the notes under the page): its picture alone. Each leaf stands at most once
(its data is hero.leaves.<layer>, its knobs hero.style.<layer>). A title or text is a wording filled like the dek:
FX.worded(spec, F, "sections.<i>.title" | "sections.<i>.text", wording), so a number in it is a ledger entry marked with its src.
The kicker holds no digit or placeholder (it labels the chart for a screen reader).
Pictures given by another child: illus_hero (the opening picture, over the header) or, when none could be made, illus_strip (the
page-bottom strip), each with its size [w, h] in `sizes`.

Page checks made here (each refuses the page naming the section):
 * the title test: every titled section's title prints at least one number from the ledger (a fact, series or record entry; a year
   or a name alone is no number), so no section is headed by words alone;
 * one fact, one writing: a ledger entry printed more than once on the page prints the same text every time;
 * every section's layer is drawn, none twice, none that is no story leaf; every picture drawn is placed.
A section that draws the header's big numbers (layer bignums, html) is a bare block placed as it is. A picture that is a chart (every leaf but the text blocks) is its own module of the browser check (pub-visual, data-module-id the
section's id, its svg the pub-chart named by the section's kicker and described by its title read aloud)."""
import html
import re

import facts as FX
import prod
import scmp
import wbkit as K
from words import word

NODE = "page_story"
# the leaves a story section may draw (run.py builds the recipe's layers from these), and those that are text blocks, not charts
STORY_LAYERS = ["bignums", "thesis_claims", "gap_axis", "event_chain", "target_path", "winners_losers", "pair_bars", "rankbar", "small_multiples", "member_map", "risk_notes"]
TEXT_BLOCKS = ("thesis_claims", "risk_notes")
# the layer that is html, not svg: the header's big numbers (column.cl_bignums), a row over the thesis
HTML_BLOCKS = ("bignums",)
SVG_LAYERS = [n for n in STORY_LAYERS if n not in HTML_BLOCKS]
CODE = re.compile(r"[a-z][a-z0-9_]{0,31}")
PAGE_W = 1140
# the two text blocks run the page's whole width (their own default is a column; the page puts them under the header and
# above the sources, where a column leaves the right of the page empty): the leaf's width knob, set here over the request's
# The page's type scale (12, 14, 16 and 24 px, the numbers 58, the page title's): its leaves' label, head and value sizes, so no leaf adds a tier of its own.
FIXED = {**{n: {"width": PAGE_W} for n in TEXT_BLOCKS}, "bignums": {"cols": 3, "width": PAGE_W, "size": 58},
         "thesis_claims": {"width": PAGE_W, "size": 14, "num_size": 24}, "risk_notes": {"width": PAGE_W, "size": 14, "title_size": 16},
         "winners_losers": {"size": 12, "value_size": 16}, "rankbar": {"size": 14}, "pair_bars": {"size": 12, "head_size": 14, "width": PAGE_W}}


def cl_bignums(f, occ):
    """The header's big numbers: column.cl_bignums over the story's leaves.bignums ({"bignums": [{fact, label}]}), three to a row in
    a box 720 px wide (FIXED over the request's style)."""
    import column
    d = (f.h.get("leaves") or {}).get("bignums")
    if d is None: raise FX.Refused("the hero names no leaves.bignums")
    st = dict(f.h.get("style") or {})
    st["bignums"] = {**st.get("bignums", {}), **FIXED["bignums"]}
    return column.cl_bignums(type("BigFrame", (), {"d": d, "c": f.c, "h": {**f.h, "style": st}})(), occ)


def rank_style(h):
    """The rank bar's knob the data names: leaves.rankbar.highlight is the code of the row drawn in the accent (the whole's, or
    the highest member's when the page has no whole); the leaf's own data shape has no such key and ignores it."""
    code = ((h.get("leaves") or {}).get("rankbar") or {}).get("highlight")
    return {"rankbar": {"highlight_row": code}} if isinstance(code, str) and code else {}


# How the titled sections sit on the page (the node story_layout's knobs, read from hero.style.story_layout): "side" puts a section's words in
# a column beside its picture (text_share of the page's width, the picture the rest less the gutter), "stack" puts the words over a picture
# as wide as the page; with pair on, two titled sections that follow each other and whose leaves PLACE calls "pair" share one row, each
# the words over its picture, half the page less half the gutter wide.
LAYOUT = "story_layout"
prod.KNOBS[LAYOUT] = dict(
    layout=("side", ("side", "stack"), "titled sections: words beside the picture, or over it"),
    text_share=(0.34, (0.25, 0.5, 0.01), "share of the page's width the words' column takes beside a picture"),
    gutter=(36, (16, 64, 2), "space between the words and the picture, or between two paired pictures, in px"),
    pair=("on", ("on", "off"), "two narrow pictures in a row"),
    notes=(2, (0, 3, 1), "short notes beside a chart's words: a bold number and what it is, a leader towards the picture"),
    note_size=(14, (12, 16, 2), "a note's words in px (its number 2 px larger)"),
    lead=(28, (12, 80, 4), "a note's leader towards the picture, in px"),
    legend=("on", ("on", "off"), "the 'how to read this page' block under the thesis"))
# What each leaf's picture takes when it sits on a titled section: beside its words ("side"), paired with a neighbour that is also
# "pair" ("pair"), or across the page ("stack": the picture needs the page's width, e.g. panels linked left to right).
PLACE = {"target_path": "side", "small_multiples": "side", "member_map": "side", "gap_axis": "stack", "event_chain": "stack",
         "winners_losers": "side", "pair_bars": "pair", "rankbar": "pair"}


# The narrowest picture (px) each leaf draws without refusing; a place that would be narrower falls back (pair to side, side to stack).
NEEDS = {"winners_losers": 680, "target_path": 560, "small_multiples": 520, "member_map": 480, "pair_bars": 500, "rankbar": 480}


def layout_knobs(h):
    k = lambda n: K.knob(h, LAYOUT, n)
    return dict(layout=k("layout"), share=k("text_share"), gutter=k("gutter"), pair=k("pair") == "on", notes=k("notes"), note_size=k("note_size"),
                lead=k("lead"), legend=k("legend") == "on")


def plan(spec):
    """The rows of the page: [("bare", [index]), ("side"|"stack", [index]), ("pair", [index, index])] in order, and each titled
    section's picture width in px: ({index: width}, rows). A bare block (no title) is its own row at the page's width."""
    secs = sections(spec); kn = layout_knobs(spec["hero"])
    text_w = round(PAGE_W * kn["share"]); side_w = PAGE_W - text_w - kn["gutter"]; half_w = (PAGE_W - kn["gutter"]) // 2
    rows, width, i = [], {}, 0
    def mode(s):
        m = "stack" if kn["layout"] == "stack" else PLACE.get(s[2], "stack")
        if m == "pair" and half_w < NEEDS.get(s[2], 0): m = "side"
        if m == "side" and side_w < NEEDS.get(s[2], 0): m = "stack"
        return m
    while i < len(secs):
        s = secs[i]
        if s[4] is None: rows.append(("bare", [s[0]])); width[s[0]] = PAGE_W; i += 1; continue
        m = mode(s)
        nxt = secs[i + 1] if i + 1 < len(secs) else None
        if m == "pair" and kn["pair"] and nxt is not None and nxt[4] is not None and mode(nxt) == "pair":
            rows.append(("pair", [s[0], nxt[0]])); width[s[0]] = width[nxt[0]] = half_w; i += 2; continue
        if m == "pair": m = "side" if side_w >= NEEDS.get(s[2], 0) else "stack"
        rows.append((m, [s[0]])); width[s[0]] = side_w if m == "side" else PAGE_W; i += 1
    return width, rows, dict(kn, text_w=text_w)


def width_of(f):
    """The picture width each titled section's leaf draws at, as a style over the leaf's width knob ({layer: {"width": px}}); run.leaf's by_page."""
    width, _, _ = plan(f.spec)
    return {s[2]: {"width": width[s[0]]} for s in sections(f.spec) if s[4] is not None}


def seg_html(sg, what):
    """A note's segments as html: words escaped, a number a ledger entry marked with its src, a name marked with its name row, a word of the table."""
    out = []
    for x in sg:
        if not isinstance(x, dict) or sum(k in x for k in ("w", "src", "word", "name")) != 1: raise FX.Refused(f"page: {what} holds a segment that is not one of w, src, word, name")
        if "w" in x:
            if FX.digit(x["w"]): raise FX.Refused(f"page: {what}: the words {x['w']!r} hold a digit; a number must come as a ledger entry")
            out.append(html.escape(x["w"], quote=False))
        elif "src" in x: out.append(FX.entry(x["src"], "span", None))
        elif "name" in x: out.append(f'<span data-src="{html.escape(K.name_row(x["name"], x.get("kind", "place")))}">{html.escape(prod.NAME(x["name"]))}</span>')
        else: out.append(html.escape(word(x["word"]), quote=False))
    return "".join(out)


def notes_items(spec, layer, kn):
    """The short notes of a section (hero.leaves.<layer>.notes: [{"num": ledger src, "text": segs}], the first knob `notes` of them), checked:
    [(num src, segs)]. The number is a ledger entry holding a digit."""
    got = ((spec["hero"].get("leaves") or {}).get(layer) or {}).get("notes") or []
    if not isinstance(got, list): raise FX.Refused(f"page: {layer}'s notes are no list")
    items = []
    for j, n in enumerate(got[:int(kn["notes"])]):
        if not isinstance(n, dict) or not isinstance(n.get("num"), str) or not isinstance(n.get("text"), list): raise FX.Refused(f"page: {layer}'s note {j + 1} is no {{num, text}}")
        if not FX.digit(FX.text(n["num"])): raise FX.Refused(f"page: {layer}'s note {j + 1} number {n['num']} prints no digit")
        items.append((n["num"], n["text"]))
    return items


def notes_html(spec, layer, kn):
    """The notes of a section as a list: a bold number and the words that say what it is."""
    items = [f'<li class="note"><b class="n">{FX.entry(num, "span", None)}</b><span class="nt">{seg_html(sg, f"{layer}'s note {j + 1}")}</span></li>'
             for j, (num, sg) in enumerate(notes_items(spec, layer, kn))]
    return f'<ul class="notes" style="--lead:{kn["lead"]}px;--ns:{kn["note_size"]}px">{"".join(items)}</ul>' if items else ""


# What the page's picture kinds need explained: (swatch, word) a layer adds to the legend block under the thesis; the accent line is always there.
LEGEND = {"target_path": ("dash", "story.legend.path"), "event_chain": ("band", "story.legend.chain"), "small_multiples": ("pale", "story.legend.members"),
          "member_map": ("ramp", "story.legend.map"), "rankbar": ("accent", "story.legend.rank")}


def legend_rows(layers):
    return [("accent", "story.legend.accent")] + [LEGEND[n] for n in layers if n in LEGEND]


def legend_html(layers, box=None):
    """The 'how to read this page' block: the accent line, then a line for each picture kind on the page that needs one (no number in it);
    `box` is the layout's (x, y, w, h) of it."""
    items = "".join(f'<li><span class="sw {sw}"></span><span>{html.escape(word(w), quote=False)}</span></li>' for sw, w in legend_rows(layers))
    return f'<section class="sec" data-id="legend" data-layout="bare"{place(box)}><div class="legend"><b>{html.escape(word("story.legend.title"), quote=False)}</b><ul>{items}</ul></div></section>'


def place(box):
    """The absolute place of a box (x, y, w, h) as a style attribute; every block of a story page stands where the layout put it."""
    return f' style="left:{box[0]:g}px;top:{box[1]:g}px;width:{box[2]:g}px;height:{box[3]:g}px"' if box else ""


# ---------------------------------------------------------------------------------------------------------------------------------
# The page's layout, made once at the size phase (run.py) and kept for the page phase: every section's box on the page (x, y, w, h), where
# its words and its picture stand inside the box, and the page's whole height. The panel layer 1 is told is the page itself, so each story
# layer reports its texts at the place its picture has on the page, and layer 1's rules (out of the panel, over another text, on a line)
# run over the real page. The words are html, whose height the browser settles: each block's height is counted here by the same text
# widths as the pictures' words (wbkit.tw), kept a little on the generous side (a line is counted when it is 3 % short of full), and the
# page puts the pictures at the counted places, so the pictures stand where the layout says whatever the words come to.
TOP_GAP, SEC_GAP, KICK_H, KICK_GAP = 20, 54, 38, 22     # px: the first row's top, between two rows, a kicker pill with its margin, the words over a picture
H2_LH, P_LH, H2_MB, NOTES_MT, NOTE_PAD, NOTE_GAP = 33.6, 28.8, 8, 20, 20, 12   # h2 24px/1.4, p 16px/1.8, its margin, the notes' top margin, a card's padding, between two cards
LEGEND_PAD, LEGEND_GAP = 28, 26


def count_lines(text, size, w):
    """How many lines the words take in a column w px wide at this size (at least one for words)."""
    return max(1, len(K.lay([(text, None)], size, w * 0.97))) if text else 0


def pieces(spec, c, secs, kn):
    """What each titled section prints around its picture, {index: dict(kicker, t_html, x_html, head, notes: [(num src, segs)], note_list,
    title, text, items)}: the markup, and its plain words for the layout to count."""
    out = {}
    for i, sid, layer, kicker, title, text in secs:
        if title is None: continue
        t_html = FX.worded(spec, c.F, f"sections.{i}.title", title)
        x_html = FX.worded(spec, c.F, f"sections.{i}.text", text) if text is not None else ""
        head = (f'{f"<div class=kick>{prod.esc(kicker)}</div>" if kicker else ""}<h2 data-section="{sid}">{t_html}</h2>'
                f'{f"<p>{x_html}</p>" if x_html else ""}')
        items = [(FX.text(num), plain(seg_html(sg, "a note"))) for num, sg in notes_items(spec, layer, kn)]
        out[i] = dict(kicker=kicker, t_html=t_html, x_html=x_html, head=head, note_list=notes_html(spec, layer, kn), title=plain(t_html), text=plain(x_html), items=items)
    return out


def col_height(pc, w, kn, with_notes):
    """The words' column of a titled section w px wide: the kicker, the title, the text, and (with_notes) the notes under them."""
    h = (KICK_H if pc["kicker"] else 0) + count_lines(pc["title"], 24, w) * H2_LH + H2_MB + count_lines(pc["text"], 16, w) * P_LH
    return h + (NOTES_MT + notes_height(pc, w, kn) if with_notes and pc["items"] else 0)


def notes_height(pc, w, kn):
    """The notes list of a section w px wide: a card each, its number then its words (a card has 14 px padding each side, a 3 px rule, a 12 px gap)."""
    ns, tot = kn["note_size"], 0.0
    for num, txt in pc["items"]:
        tot += NOTE_PAD + 4 + count_lines(txt, ns, w - 28 - 3 - 12 - K.tw(num, ns + 2)) * ns * 1.5
    return tot + NOTE_GAP * max(0, len(pc["items"]) - 1)


def legend_height(layers):
    """The legend block (padding 14 px a side): its title's line, 20 px, and its items' lines. With the title the items fill one line when they fit
    beside it; otherwise they take the lines under it, each (a row of items that wraps) 40 px high but the last, 20, a 26 px gap between two."""
    title = K.tw(word("story.legend.title"), 14)
    items = [26 + 8 + K.tw(word(w), 12) for _, w in legend_rows(layers)]
    if title + 28 + sum(items) + LEGEND_GAP * (len(items) - 1) <= PAGE_W - 36: return LEGEND_PAD + 20
    rows, cur = 1, 0.0
    for w in items:
        if cur and cur + LEGEND_GAP + w > PAGE_W - 36: rows += 1; cur = 0.0
        cur += w + (LEGEND_GAP if cur else 0)
    return LEGEND_PAD + 20 + 28 + (rows - 1) * (40 + LEGEND_GAP) + 20


def bignums_height(markup):
    """The header's big numbers (column.cl_bignums' html): a row of cells, each its number's line at the size it was fitted to and its label's lines."""
    w = int(re.search(r"width:(\d+)px", markup)[1]); cols = int(re.search(r"repeat\((\d+),1fr\)", markup)[1]); cell = (w - 22 - (cols - 1) * 24) / cols
    heights = []
    for m in re.finditer(r'<div class="bn"><div class="bv" style="font-size:(\d+)px[^"]*">.*?</div><div class="bl">(.*?)</div></div>', markup):
        heights.append(int(m[1]) * 1.2 + count_lines(plain(m[2]), 12, cell) * 17)
    rows = [heights[i:i + cols] for i in range(0, len(heights), cols)]
    return sum(max(r) for r in rows) + 18 * (len(rows) - 1)


def layout(spec, c, drew, html_h):
    """The page's layout: {"boxes": {section index: dict(x, y, w, h, fx, fy, how, ...)}, "legend": (x, y, w, h) or None, "H": the page's height}.
    `drew` is {layer: (w, h)} as drawn, `html_h` {layer: height} of a layer that is html (bignums). fx, fy: where its picture stands in its box."""
    secs = sections(spec); width, rows, kn = plan(spec)
    pcs = pieces(spec, c, secs, kn)
    layer_of = {s[0]: s[2] for s in secs}
    boxes, legend, y = {}, None, TOP_GAP
    for r, (how, ids) in enumerate(rows):
        if r: y += SEC_GAP
        row_h = 0.0
        for n, i in enumerate(ids):
            layer = layer_of[i]; pc = pcs.get(i)
            fw, fh = (PAGE_W, html_h[layer]) if layer in HTML_BLOCKS else drew[layer]
            if pc is None: b = dict(x=0, w=PAGE_W, h=fh, fx=0, fy=0, how="bare")
            elif how == "side":
                col = col_height(pc, kn["text_w"], kn, True)
                b = dict(x=0, w=PAGE_W, h=max(col, fh), fx=kn["text_w"] + kn["gutter"], fy=0, how="side", cw=kn["text_w"], col=col)
            elif how == "stack":
                top = max(col_height(pc, 640, kn, False), notes_height(pc, PAGE_W - 640 - kn["gutter"], kn) if pc["items"] else 0)
                b = dict(x=0, w=PAGE_W, h=top + KICK_GAP + fh, fx=0, fy=top + KICK_GAP, how="stack", top=top, cw=640, col=col_height(pc, 640, kn, False))
            else:
                hw = width[i]; col = col_height(pc, hw, kn, True)
                b = dict(x=n * (hw + kn["gutter"]), w=hw, h=col + KICK_GAP + fh, fx=0, fy=col + KICK_GAP, how="pair", cw=hw, col=col)
            b["y"] = y; boxes[i] = b; row_h = max(row_h, b["h"])
        y += row_h
        if kn["legend"] and any(layer_of[i] == "thesis_claims" for i in ids):
            y += SEC_GAP; lh = legend_height(list(layer_of.values())); legend = (0, y, PAGE_W, lh); y += lh
    return dict(boxes=boxes, legend=legend, H=y, pieces=pcs, drew={k: tuple(v) for k, v in drew.items()})


# The page's layout the size phase made (None when it could not: a leaf that refuses at its own layer line).
PAGE_LAYOUT = None


# The panel a story page tells layer 1 at the size phase: the page's width and the page's height (the layout's); a size of 0 is no panel.
SECTION_MAX_H = 3 * PAGE_W   # the height told when a leaf refuses before the layout can be made (its own layer line then refuses it)


class Frame:
    """What a story page's layers read: the hero (leaves and styles); the page itself has no picture of its own."""
    def __init__(f, c, spec):
        f.c, f.spec, f.h, f.W, f.H = c, spec, spec["hero"], PAGE_W, SECTION_MAX_H


def sections(spec):
    """spec.sections as a checked list of (index, id, layer, kicker, title, text); refuses a list that is no story."""
    secs = spec.get("sections")
    if not isinstance(secs, list) or not secs: raise FX.Refused("story: the spec lists no sections")
    out, ids, layers = [], set(), set()
    for i, s in enumerate(secs):
        if not isinstance(s, dict): raise FX.Refused(f"story: section {i + 1} is no object")
        sid, layer = s.get("id"), s.get("layer")
        if not (isinstance(sid, str) and CODE.fullmatch(sid)): raise FX.Refused(f"story: section {i + 1}'s id {sid!r} is no code (a-z, 0-9, _)")
        if sid in ids: raise FX.Refused(f"story: the section id {sid} comes twice")
        if layer not in STORY_LAYERS: raise FX.Refused(f"story: section {sid} names the layer {layer!r}; one of {'|'.join(STORY_LAYERS)}")
        if layer in layers: raise FX.Refused(f"story: the layer {layer} is drawn by two sections (each leaf stands once on a page)")
        ids.add(sid); layers.add(layer)
        for k in ("kicker", "title", "text"):
            if s.get(k) is not None and not (isinstance(s[k], str) and s[k].strip()): raise FX.Refused(f"story: section {sid}'s {k} is no text")
        if s.get("title") is None and (s.get("kicker") is not None or s.get("text") is not None):
            raise FX.Refused(f"story: section {sid} has a kicker or text but no title (a bare block holds its picture alone)")
        out.append((i, sid, layer, s.get("kicker"), s.get("title"), s.get("text")))
    return out


def plain(markup):
    return html.unescape(re.sub(r"<[^>]*>", "", markup))


def printed(markup):
    """The ledger entries a piece of markup prints: [(src, text)] of its data-src marks."""
    return [(html.unescape(a), html.unescape(b)) for a, b in re.findall(r'<(?:span|b|tspan)\b[^>]*data-src="([^"]*)"[^>]*>([^<]*)</', markup)]


def number_entries(markup):
    """The entries that are numbers the data give: a fact, series or record entry whose text holds a digit (a year, a name or a
    unit alone is not one)."""
    return [(s, t) for s, t in printed(markup) if s.split(":", 1)[0] in ("fact", "series", "record") and FX.digit(t)]


def root(body, layer, size, extra=""):
    """A leaf's drawn body in its own svg root (class the layer, its drawn size from the panel's record `size`, (w, h))."""
    w, h = size if isinstance(size, (tuple, list)) and len(size) == 2 else (None, None)
    if not (isinstance(w, (int, float)) and isinstance(h, (int, float)) and w > 0 and h > 0): raise FX.Refused(f"story: the layer {layer} has no drawn size")
    return f'<svg class="{layer}" viewBox="0 0 {w:g} {h:.0f}" width="{w:g}" height="{h:.0f}" role="img"{extra}>{body}</svg>'


def overlay(items, size):
    """The words a leaf drew with no ledger entry (wbkit.OVERLAY), as html over its picture: each line absolutely placed at its baseline, in the
    picture's own pixels (the picture is shown at its drawn size). Empty when the leaf drew none."""
    if not items: return ""
    w, h = size
    out = []
    for t in items:
        tf = {"start": "", "middle": "transform:translateX(-50%);", "end": "transform:translateX(-100%);"}[t["anchor"]]
        font = f'font-family:{K.SERIF};' if t["serif"] else ""
        out.append(f'<span style="left:{t["x"]:.1f}px;top:{t["y"] - t["size"] * 0.88:.1f}px;font-size:{t["size"]}px;color:{t["fill"]};font-weight:{t["weight"]};'
                   f'{"font-style:italic;" if t["italic"] else ""}{font}{tf}">{html.escape(t["text"], quote=False)}</span>')
    return f'<div class="ov" style="width:{w:g}px;height:{h:.0f}px">{"".join(out)}</div>'


def chart(body, layer, size, sid, label, desc, over="", pos=""):
    """A section's picture as its own module of the browser check: the svg named by `label`, described by the hidden `desc` (markup)."""
    svg = root(body, layer, size, f' aria-label="{html.escape(label)}" aria-describedby="desc-{sid}" tabindex="0"').replace(f'class="{layer}"', f'class="{layer} pub-chart"', 1)
    return (f'<div class="fig pub-visual" data-module-id="{sid}" data-layer="{layer}"{pos}>{svg}'
            f'{over}<p id="desc-{sid}" hidden>{desc}</p></div>')


def story_page(panel, got, sizes, placeholders, drew, over=None):
    """The page around the layers the panel drew (`got`, layer -> svg), as the module docstring says; {"html"} or {"refused": [...]}."""
    c, spec, f = panel.c, panel.spec, panel.f
    secs = sections(spec)
    off = [f"page: no layer {l}" for _, _, l, *_ in secs if not isinstance(got.get(l), str)]
    given = [n for n in ("illus_hero", "illus_strip") if n in got]
    off += [f"page: {n} is no layer the page places" for n in got if n not in STORY_LAYERS and n not in given]
    off += [f"page: {n} is no layer the story lists" for n in got if n in STORY_LAYERS and n not in {s[2] for s in secs}]
    if len(given) > 1: off.append("page: the opening picture and the strip come together; one stands in for the other")
    for n in given:
        wh = sizes.get(n)
        if not (isinstance(wh, list) and len(wh) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in wh)):
            off.append(f"page: {n} comes with no size [w, h]")
    if off: return {"refused": off}
    if PAGE_LAYOUT is None: return {"refused": ["page: the size phase made no layout (a leaf refused before it, or no size line came)"]}
    page_kick = str(spec.get("kicker") or "").strip()
    body, marks, parts = [], [], {}
    _, rows, kn = plan(spec)
    boxes = PAGE_LAYOUT["boxes"]
    for i, sid, layer, kicker, title, text in secs:
        svg, box = got[layer], boxes[i]
        if layer not in HTML_BLOCKS:  # the layer's svg stands in its box as the size phase's layout put it (run.py wraps it in that translate)
            m = re.fullmatch(r'<g transform="translate\(([-\d.]+),([-\d.]+)\)">(.*)</g>', svg, re.S)
            at = (box["x"] + box["fx"], box["y"] + box["fy"])
            if not m or (float(m[1]), float(m[2])) != (round(at[0], 1), round(at[1], 1)): return {"refused": [f"page: the layer {layer} stands at {m and m[1:3]}, not where the layout puts it {at}"]}
            if tuple(drew.get(layer) or ()) != tuple(PAGE_LAYOUT["drew"][layer]): return {"refused": [f"page: the layer {layer} drew {drew.get(layer)}, not the size the layout counted {PAGE_LAYOUT['drew'][layer]}"]}
            svg = m[3]
        pos = f' style="left:{box["fx"]:g}px;top:{box["fy"]:g}px"'
        if layer in HTML_BLOCKS:  # html, not a picture: placed as it is (a bare block; its numbers are ledger entries)
            if title is not None: return {"refused": [f"page: section {i + 1} ({sid}) draws html and cannot carry a title"]}
            marks += printed(svg)
            parts[i] = (sid, "", svg)
            continue
        words_over = overlay((over or {}).get(layer), drew.get(layer)) if (over or {}).get(layer) else ""
        fig = f'<div class="blk" data-layer="{layer}"{pos}>{root(svg, layer, drew.get(layer))}{words_over}</div>' if layer in TEXT_BLOCKS else None
        head, note_list = "", ""
        if title is not None:
            pc = PAGE_LAYOUT["pieces"][i]; t_html, x_html = pc["t_html"], pc["x_html"]
            if not number_entries(t_html):
                return {"refused": [f"page: the title test: section {i + 1} ({sid}) has a title that prints no number from the ledger: {plain(t_html)!r}"]}
            if kicker is not None and (re.search(r"[{}]", kicker) or FX.digit(kicker)):
                return {"refused": [f"page: section {i + 1} ({sid}) has a kicker with a digit or a placeholder: {kicker!r}"]}
            marks += printed(t_html) + printed(x_html)
            head, note_list = pc["head"], pc["note_list"]
            marks += printed(note_list)
        if fig is None:
            label = (kicker or "").strip() or page_kick
            if not label: return {"refused": [f"page: section {i + 1} ({sid}) has no kicker and the page none to name its chart"]}
            desc = re.sub(r'<span data-src="name:[^"]*">([^<]*)</span>', r"\1", t_html) if title is not None else html.escape(label)  # markup: its numbers keep their marks
            fig = chart(svg, layer, drew.get(layer), sid, label, desc, words_over, pos)
        marks += printed(svg)
        parts[i] = (sid, head, fig, note_list)
    def sec(i, how):
        sid, head, fig, *rest = parts[i]; note_list = rest[0] if rest else ""; b = boxes[i]
        if how == "bare" or not head: top = ""
        elif how == "stack": top = f'<div class="top" style="height:{b["top"]:g}px"><div class="col">{head}</div>{note_list}</div>'  # the words and the notes over a picture as wide as the page
        else: top = f'<div class="col" style="width:{b["cw"]:g}px">{head}{note_list}</div>'
        return f'<section class="sec" data-id="{sid}" data-layout="{how}"{place((b["x"], b["y"], b["w"], b["h"]))}>{top}{fig}</section>'
    layer_of = {s[0]: s[2] for s in secs}
    for how, ids in rows:
        for i in ids: body.append(sec(i, "pair" if how == "pair" else how))
        if kn["legend"] and any(layer_of[i] == "thesis_claims" for i in ids): body.append(legend_html([layer_of[i] for i in layer_of], PAGE_LAYOUT["legend"]))
    by = {}
    for s, t in marks: by.setdefault(s, set()).add(t)
    twice = sorted(s for s, ts in by.items() if len(ts) > 1)
    if twice: return {"refused": [f"page: one fact, one writing: {twice[0]} prints {sorted(by[twice[0]])} on this page"]}
    opening = ""
    if "illus_hero" in got:
        w, h = sizes["illus_hero"]
        opening = (f'<div class="opening" aria-hidden="true"><svg viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">'
                   f'<g data-layer="illus_hero">{got["illus_hero"]}</g></svg></div>')
    strip = ""
    if "illus_strip" in got:
        import column
        strip = column.strip_shell(got["illus_strip"], *sizes["illus_strip"])
    head = scmp.page_head(c, spec, wide=True)
    page = scmp.shell(c, spec, opening + head + f'<div class="story" style="--tw:{kn["text_w"]}px;--gut:{kn["gutter"]}px;height:{PAGE_LAYOUT["H"]:g}px">' + "".join(body) + "</div>" + strip, CSS)
    left = placeholders(page)
    return {"refused": [f"page: the page still holds the placeholder {k}" for k in left]} if left else {"html": page}


# The story's layout over the page's tokens: the opening picture and the sections 1140 wide; a titled section's words in a column
# 640 wide over its picture.
CSS = (".opening{width:1140px;margin:0 0 18px}.opening svg{display:block}"
       # every block stands where the layout put it (story.layout): the story is a positioned box as high as the layout, each section a box in it, its words and its picture placed in that
       ".story{width:1140px;position:relative}.story .sec{position:absolute;margin:0}.story .col{position:absolute;left:0;top:0;max-width:640px;margin:0}"
       ".story .kick{display:inline-block;min-width:30px;padding:0 10px;box-sizing:border-box;height:28px;line-height:28px;border-radius:14px;"
       "background:var(--t-title);color:#fff;font:700 12px/28px var(--sans);letter-spacing:.1em;margin-bottom:10px}"
       ".story h2{margin:0 0 8px;font:700 24px/1.4 var(--serif);color:var(--t-title)}.story .col p{margin:0;font:400 16px/1.8 var(--sans);color:var(--t-body)}"
       ".story .fig svg,.story .blk svg{display:block;max-width:100%;height:auto}"
       # the words a leaf draws with no ledger entry stand over its picture as html, each at its baseline in the picture's pixels
       ".story .fig,.story .blk{position:absolute}.story .ov{position:absolute;left:0;top:0;pointer-events:none}"
       ".story .ov span{position:absolute;white-space:nowrap;line-height:1;font-family:var(--sans)}"
       # a section with its words beside its picture, and two sections in a row
       ".story .sec[data-layout=side] .col,.story .sec[data-layout=pair] .col{max-width:none}"
       # the short notes: a card with a bold number and its words; beside a picture a leader runs from the card towards it
       ".story .notes{list-style:none;margin:20px 0 0;padding:0;display:grid;gap:12px}"
       ".story .note{position:relative;display:flex;align-items:baseline;gap:12px;padding:10px 14px;background:color-mix(in srgb,var(--t-title) 6%,transparent);"
       "border-left:3px solid var(--accent);font:400 var(--ns)/1.5 var(--sans);color:var(--t-body)}"
       ".story .note .n{font:700 calc(var(--ns) + 2px)/1.2 var(--serif);color:var(--accent);flex:none}"
       ".story .sec[data-layout=side] .note::after{content:\"\";position:absolute;left:100%;top:50%;width:var(--lead);height:1px;background:var(--t-title)}"
       ".story .sec[data-layout=side] .note::before{content:\"\";position:absolute;left:calc(100% + var(--lead));top:calc(50% - 2px);width:5px;height:5px;border-radius:50%;background:var(--t-title)}"
       ".story .top{position:absolute;left:0;top:0;width:100%;display:grid;grid-template-columns:640px 1fr;column-gap:var(--gut);align-items:start}.story .top .col{position:static}.story .top .notes{margin:0}"
       # the legend block under the thesis
       ".story .legend{display:flex;align-items:baseline;gap:28px;flex-wrap:wrap;padding:14px 18px;background:color-mix(in srgb,var(--t-title) 5%,transparent);"
       "font:400 12px/1.6 var(--sans);color:var(--t-body)}.story .legend b{font:700 14px var(--sans);color:var(--t-title)}"
       ".story .legend ul{list-style:none;margin:0;padding:0;display:flex;gap:26px;flex-wrap:wrap}.story .legend li{display:flex;align-items:center;gap:8px}"
       ".story .sw{display:inline-block;width:26px;height:10px;flex:none}.story .sw.accent{background:var(--accent)}"
       ".story .sw.dash{height:0;border-top:2px dashed var(--t-sec)}.story .sw.pale{height:3px;background:var(--t-sec);opacity:.55}"
       ".story .sw.band{background:var(--empty);border:1px solid var(--t-sec)}"
       ".story .sw.ramp{background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 10%,#eeeeec),var(--accent))}")
