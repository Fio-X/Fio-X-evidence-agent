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
A picture that is a chart (every leaf but the two text blocks) is its own module of the browser check (pub-visual, data-module-id the
section's id, its svg the pub-chart named by the section's kicker and described by its title read aloud)."""
import html
import re

import facts as FX
import prod
import scmp
from words import word

NODE = "page_story"
# the leaves a story section may draw (run.py builds the recipe's layers from these), and those that are text blocks, not charts
STORY_LAYERS = ["thesis_claims", "gap_axis", "event_chain", "target_path", "winners_losers", "pair_bars", "risk_notes"]
TEXT_BLOCKS = ("thesis_claims", "risk_notes")
CODE = re.compile(r"[a-z][a-z0-9_]{0,31}")
PAGE_W = 1140


class Frame:
    """What a story page's layers read: the hero (leaves and styles); the page itself has no picture of its own."""
    def __init__(f, c, spec):
        f.c, f.spec, f.h, f.W, f.H = c, spec, spec["hero"], PAGE_W, 0


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


def chart(body, layer, size, sid, label, desc):
    """A section's picture as its own module of the browser check: the svg named by `label`, described by the hidden `desc` (markup)."""
    svg = root(body, layer, size, f' aria-label="{html.escape(label)}" aria-describedby="desc-{sid}" tabindex="0"').replace(f'class="{layer}"', f'class="{layer} pub-chart"', 1)
    return (f'<div class="fig pub-visual" data-module-id="{sid}" data-layer="{layer}">{svg}'
            f'<p id="desc-{sid}" hidden>{desc}</p></div>')


def story_page(panel, got, sizes, placeholders, drew):
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
    page_kick = str(spec.get("kicker") or "").strip()
    body, marks = [], []
    for i, sid, layer, kicker, title, text in secs:
        svg = got[layer]
        fig = f'<div class="blk" data-layer="{layer}">{root(svg, layer, drew.get(layer))}</div>' if layer in TEXT_BLOCKS else None
        head = ""
        if title is not None:
            t_html = FX.worded(spec, c.F, f"sections.{i}.title", title)
            if not number_entries(t_html):
                return {"refused": [f"page: the title test: section {i + 1} ({sid}) has a title that prints no number from the ledger: {plain(t_html)!r}"]}
            if kicker is not None and (re.search(r"[{}]", kicker) or FX.digit(kicker)):
                return {"refused": [f"page: section {i + 1} ({sid}) has a kicker with a digit or a placeholder: {kicker!r}"]}
            x_html = FX.worded(spec, c.F, f"sections.{i}.text", text) if text is not None else ""
            marks += printed(t_html) + printed(x_html)
            head = (f'<div class="col">{f"<div class=kick>{prod.esc(kicker)}</div>" if kicker else ""}<h2 data-section="{sid}">{t_html}</h2>'
                    f'{f"<p>{x_html}</p>" if x_html else ""}</div>')
        if fig is None:
            label = (kicker or "").strip() or page_kick
            if not label: return {"refused": [f"page: section {i + 1} ({sid}) has no kicker and the page none to name its chart"]}
            desc = re.sub(r'<span data-src="name:[^"]*">([^<]*)</span>', r"\1", t_html) if title is not None else html.escape(label)  # markup: its numbers keep their marks
            fig = chart(svg, layer, drew.get(layer), sid, label, desc)
        marks += printed(svg)
        body.append(f'<section class="sec" data-id="{sid}">{head}{fig}</section>')
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
    page = scmp.shell(c, spec, opening + head + '<div class="story">' + "".join(body) + "</div>" + strip, CSS)
    left = placeholders(page)
    return {"refused": [f"page: the page still holds the placeholder {k}" for k in left]} if left else {"html": page}


# The story's layout over the page's tokens: the opening picture and the sections 1140 wide; a titled section's words in a column
# 640 wide over its picture.
CSS = (".opening{width:1140px;margin:0 0 18px}.opening svg{display:block}"
       ".story{width:1140px}.story .sec{margin:54px 0 0}.story .col{max-width:640px;margin:0 0 22px}"
       ".story .kick{display:inline-block;min-width:30px;padding:0 10px;box-sizing:border-box;height:28px;line-height:28px;border-radius:14px;"
       "background:var(--t-title);color:#fff;font:700 13px/28px var(--sans);letter-spacing:.1em;margin-bottom:10px}"
       ".story h2{margin:0 0 8px;font:700 24px/1.4 var(--serif);color:var(--t-title)}.story .col p{margin:0;font:400 16px/1.8 var(--sans);color:var(--t-body)}"
       ".story .fig svg,.story .blk svg{display:block;max-width:100%;height:auto}.story .sec:first-child{margin-top:20px}")
