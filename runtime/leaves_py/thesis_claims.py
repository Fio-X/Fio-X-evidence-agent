"""thesis_claims layer: the page's answer first, then the claims that carry it, each with its number and the section that shows
it: the answer in the serif, bold, across the picture; under it one block per claim, a hairline over each, its number at
the left in the serif and the accent (the one accent of the picture), its lead in bold beside the number with the section
it points to at the right of that line in the secondary ink, its body under the lead. Every printed number is a ledger
entry printed with FX.entry; every word comes in the request as segs (the leaf holds no word of its own).

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.thesis_claims, run.py leaf): {
  "answer": segs?,                                  # the page's answer, one or two lines (knob answer_lines); none when the page's headline says it
  "claims": [{"num": ledger src,                    # the claim's number, printed big (layer 1's fact)
              "num_unit": segs?,                    # the words after the number (a times word after a ratio), no digit
              "head": segs,                         # its lead, bold, one line (two with knob head_lines)
              "body": segs?,                        # what it says, up to knob body_lines lines; its numbers ledger srcs
              "section": segs}],                    # the section it points to (a see-word and the section's kicker)
  "unit_line": segs?,                               # one small line over the claims: the unit every claim's number of a unit is in
  "footnote": segs?}                                # a line under the claims
segs: as wbkit.segs reads them; ledger src: a row {"src", "text"}.
needs I4 facts: each claim's number is a fact of its own (in the sample: the electricity share's rise, the yearly pace of
the slow uses rate_<code>, the best-year scenario's end value proj_<code>_<year>); the leaf computes none.
needs new wording: the see-word before a section's kicker and the kickers themselves come from the request (section).
Placement stacks by construction: the answer, then each claim's block under the one before (the number's column at the
left, the lead and the body in a column right of it, the section at the right of the lead's line), each block as tall as
its taller side; every text box is checked in wbkit.Boxes (outside the picture or over another refuses).
Refuses: fewer than two or more than four claims, a claim with no number, lead or section, a number the
ledger lacks or that holds no digit, a digit in a literal word, an answer, lead or body longer than its knob's lines, a
text that leaves the picture or overlaps another, a board too narrow (the text column under 240 px)."""

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "thesis_claims"
prod.KNOBS[NODE] = dict(
    size=(15, (11, 20, 0.5), "lead and body size px (11 is the page floor)"),
    answer_size=(24, (16, 36, 1), "the answer's size px"), num_size=(30, (18, 48, 1), "a claim's number size px"),
    section_size=(12, (11, 16, 0.5), "the section pointer's size px"),
    width=(760, (400, 1400, 10), "picture width in px"),
    answer_lines=(2, (1, 3, 1), "lines the answer may take; more refuses"),
    head_lines=(1, (1, 2, 1), "lines a lead may take; more refuses"),
    body_lines=(3, (1, 5, 1), "lines a body may take; more refuses"),
    pad=(14, (6, 28, 1), "space above and below a claim's texts, inside its block, in px"),
    accent_n=(1, (0, 4, 1), "how many claims, from the first, have their number in the accent; the others are in ink (one focal point)"))


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        if d.get("answer"): K.segs(d["answer"], "answer")
        if d.get("unit_line"): K.segs(d["unit_line"], "unit_line")   # a page whose headline is its answer (the story) gives none
        claims = d.get("claims")
        if not isinstance(claims, list) or not 2 <= len(claims) <= 4:
            raise Refused(f"thesis_claims: {len(claims) if isinstance(claims, list) else claims!r} claims; two to four are drawn")
        f.claims = []
        for i, c in enumerate(claims):
            if not isinstance(c, dict): raise Refused(f"thesis_claims: claim {i + 1} is no object")
            for key in ("num", "head", "section"):
                if not c.get(key): raise Refused(f"thesis_claims: claim {i + 1} has no {key}")
            num = K.ent(c["num"])
            if not FX.digit(num[1]): raise Refused(f"thesis_claims: claim {i + 1}'s number {num[1]!r} ({c['num']}) holds no digit")
            for key in ("head", "section") + (("body",) if c.get("body") else ()): K.segs(c[key], f"claim {i + 1} {key}")
            if c.get("num_unit"):  # a ratio's times word after its number, in the number's size and ink
                unit = K.plain(c["num_unit"], f"claim {i + 1} num_unit")
                if FX.digit(unit): raise Refused(f"thesis_claims: claim {i + 1}'s num_unit holds a digit")
                num = (num[0] + esc(unit), num[1] + unit)
            f.claims.append(dict(num=num, head=c["head"], body=c.get("body"), section=c["section"]))
        f.num_w = max(tw(c["num"][1], k("num_size")) for c in f.claims) + 16
        f.x1 = 8 + f.num_w
        if f.W - 8 - f.x1 < 240: raise Refused("thesis_claims: the board is too narrow for the numbers' column and the text (under 240 px)")
        f.H = 0


def cl_thesis_claims(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = []
    asz = f.k("answer_size")
    y = asz + 4
    if d.get("answer"):
        svg, _, n = K.words(B, d["answer"], "answer", 8, y, asz, "var(--t-title)", weight=700, serif=True, max_w=W - 16,
                            line_h=asz * 1.35, max_lines=f.k("answer_lines"))
        o.append(svg)
        y += asz * 1.35 * (n - 1) + asz * 0.25
    else:
        y = 0
    pad, nsz, ssz = f.k("pad"), f.k("num_size"), f.k("section_size")
    if d.get("unit_line"):   # the claims' one unit, small, over them
        o.append(K.words(B, d["unit_line"], "unit_line", 8, y + ssz, ssz, "var(--t-sec)", max_w=W - 16)[0])
        y += ssz * 1.6
    for i, c in enumerate(f.claims):
        top = y + pad
        o.append(K.line(8, top, W - 8, top, stroke="var(--t-sec)", w=0.6, op=0.5))
        # the number at the left, its cap height in the block's first line
        n_svg, n_txt = c["num"]
        ny = top + pad + nsz * 0.8
        o.append(K.txt(B, 8, ny, nsz, "var(--accent)" if i < f.k("accent_n") else "var(--t-title)", n_svg, tw(n_txt, nsz), weight=700, tag=f"claim {i + 1} number")
                 .replace("<text ", f'<text font-family="{K.SERIF}" ', 1))
        # the section it points to, right on the lead's first line; the lead in the room left of it
        hy = top + pad + size * 0.9
        sec_w = tw(K.plain(c["section"], "section"), ssz)
        o.append(K.words(B, c["section"], f"claim {i + 1} section", W - 8, hy, ssz, "var(--t-sec)", anchor="end")[0])
        svg, _, nh = K.words(B, c["head"], f"claim {i + 1} lead", f.x1, hy, size, "var(--t-title)", weight=700,
                             max_w=W - 8 - f.x1 - sec_w - 12, line_h=size * 1.5, max_lines=f.k("head_lines"))
        o.append(svg)
        by = hy + size * 1.5 * nh
        if c["body"]:
            svg, _, nb = K.words(B, c["body"], f"claim {i + 1} body", f.x1, by, size, "var(--t-body)", max_w=W - 8 - f.x1,
                                 line_h=size * 1.5, max_lines=f.k("body_lines"))
            o.append(svg); by += size * 1.5 * nb
        y = max(by - size * 1.5 + size * 0.25, ny + nsz * 0.25)
    y += pad
    o.append(K.line(8, y, W - 8, y, stroke="var(--t-sec)", w=0.6, op=0.5))
    if d.get("footnote"):
        y += size * 1.4
        o.append(K.words(B, d["footnote"], "footnote", 8, y, f.k("section_size"), "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


THESIS_CLAIMS_LAYERS = dict(thesis_claims=(cl_thesis_claims, None))
THESIS_CLAIMS_SVG = ["thesis_claims"]


def draw(h):
    f = Frame(h)
    inner = cl_thesis_claims(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "thesis_claims"), f.W, f.H
