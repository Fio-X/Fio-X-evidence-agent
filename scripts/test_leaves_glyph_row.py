"""Self-test of the glyph-row leaf (runtime/leaves_py/glyph_row.py) on two data shapes, from fetched rows (Eurostat nrg_ind_ren,
nrg_bal REN, unit PC, the 27 members at 2025 as a stand-in run fetched them; the ledger texts and words are test-only, layer 1
writes the real ones):
  - group means: the members grouped by their UN M49 sub-region (runtime/pi/assets/m49-regions.json; Eurostat's EL is ISO GR;
    Cyprus is in Western Asia there and is left out), each group's value the unweighted mean of its members worked out HERE (a
    derived fact the leaf is given as its bare number fact:<k>.n), four circles, the south in the accent;
  - single members: the twelve lowest members as series cells, half discs ordered by value, the lowest in the accent, the
    highest member as the reference ghost.
Checks: every glyph's area over the largest's is its value over the largest value (the diameter scales with the square root);
one glyph in the accent; a value inside its glyph only where it fits, else under it; the ghost outlined at its own area; every
digit inside a marked ledger run; the refusals keep the leaf's rules; the file holds no topic word. With LEAF_SVG_DIR set, the
themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_glyph_row.py"""
import json
import math
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import glyph_row  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
TABLE, YEAR = "nrg_ind_ren", "2025"
# The fetched rows' values at 2025 (OBS_VALUE as the csv holds them, flag p), one per member.
Y2025 = {"AT": 44.2, "BE": 14.9, "BG": 22.7, "CY": 21.5, "CZ": 19.1, "DE": 23.9, "DK": 48.2, "EE": 42.3, "EL": 26.9, "ES": 26.0,
         "FI": 53.0, "FR": 23.9, "HR": 28.5, "HU": 19.6, "IE": 17.2, "IT": 20.5, "LT": 38.5, "LU": 20.2, "LV": 46.3, "MT": 18.8,
         "NL": 22.7, "PL": 18.7, "PT": 36.7, "RO": 25.6, "SE": 65.4, "SI": 25.4, "SK": 16.3}
NAMES = {"AT": "奥地利", "BE": "比利时", "BG": "保加利亚", "CY": "塞浦路斯", "CZ": "捷克", "DE": "德国", "DK": "丹麦", "EE": "爱沙尼亚", "EL": "希腊",
         "ES": "西班牙", "FI": "芬兰", "FR": "法国", "HR": "克罗地亚", "HU": "匈牙利", "IE": "爱尔兰", "IT": "意大利", "LT": "立陶宛", "LU": "卢森堡",
         "LV": "拉脱维亚", "MT": "马耳他", "NL": "荷兰", "PL": "波兰", "PT": "葡萄牙", "RO": "罗马尼亚", "SE": "瑞典", "SI": "斯洛文尼亚", "SK": "斯洛伐克"}
EUROPE_SUB = ("154", "039", "151", "155")   # north, south, east, west
M49 = json.load(open(os.path.join(ROOT, "runtime", "pi", "assets", "m49-regions.json"), encoding="utf-8"))


def groups():
    """{sub-region code: [members]} by M49 (EL is GR there); a member outside the four European sub-regions (Cyprus) is left out."""
    sub = {c["iso2"]: c["sub_region"] for c in M49["countries"]}
    out = {g: [] for g in EUROPE_SUB}
    for m in Y2025:
        g = sub.get({"EL": "GR"}.get(m, m))
        if g in out: out[g].append(m)
    return out


def series(c, v):
    return {"src": f"series:{TABLE}/{c}:{YEAR}:OBS_VALUE", "table": TABLE, "dims": {"geo": c}, "time": YEAR, "value": v}


def means():
    return {g: sum(Y2025[m] for m in ms) / len(ms) for g, ms in groups().items()}


def group_shape():
    """The four sub-regions' unweighted member means at 2025, each a derived fact (its bare number and its printed text)."""
    rows = [series(c, v) for c, v in Y2025.items()]
    items = []
    for g, v in means().items():
        rows += [{"src": f"fact:grp_{g}.n", "text": f"{v:.4f}"}, {"src": f"fact:grp_{g}", "text": f"{v:.1f}"}]
        items.append({"code": g, "value": f"fact:grp_{g}.n", "text": f"fact:grp_{g}"})
    labels = {g: M49["regions"][g]["name_zh"] for g in EUROPE_SUB}
    rows += [{"src": K.name_row(g, "m49"), "text": n} for g, n in labels.items()]
    data = {"title": W("各次区域的可再生能源占比"), "unit": W("百分比"), "name_kind": "m49", "items": items, "accent": "039",
            "footnote": W("成员国简单平均，不按能源消费加权；塞浦路斯按联合国划分属西亚，未计入")}
    return rows, data, labels


def member_shape(n=12, edit=None):
    """The n lowest members at 2025 as series cells, the highest member as the reference."""
    vals = dict(Y2025)
    if edit: edit(vals)
    low = sorted(vals, key=lambda c: (vals[c], c))[:n]
    top = max(vals, key=lambda c: vals[c])
    rows = [series(c, v) for c, v in vals.items()]
    rows += [{"src": f"fact:v_{c.lower()}", "text": f"{v:.1f}"} for c, v in vals.items()]
    rows += [{"src": K.name_row(c, "place"), "text": NAMES[c]} for c in vals]
    items = [{"code": c, "value": f"series:{TABLE}/{c}:{YEAR}:OBS_VALUE", "text": f"fact:v_{c.lower()}"} for c in low]
    data = {"title": W("占比最低的成员国"), "unit": W("百分比"), "name_kind": "place", "items": items,
            "ref": {"value": f"series:{TABLE}/{top}:{YEAR}:OBS_VALUE", "text": f"fact:v_{top.lower()}", "label": [{"w": "最高的"}, {"name": top}]},
            "omit": W("其余成员国未画出")}
    return rows, data, dict(NAMES)


def draw(spec, **style):
    rows, data, names = spec
    K.setup(rows, names, run.tables)
    return glyph_row.draw({"data": data, "style": {"glyph_row": style}})


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def radii(svg):
    """{code: (radius, fill, cx, bottom)} of every glyph drawn."""
    out = {}
    for m in re.finditer(r'<circle cx="([0-9.]+)" cy="([0-9.]+)" r="([0-9.]+)" fill="([^"]+)"[^>]*data-code="([^"]+)" data-glyph="circle"', svg):
        cx, cy, r, fill, c = m.groups(); out[c] = (float(r), fill, float(cx), float(cy) + float(r))
    for m in re.finditer(r'<path d="M([0-9.]+),([0-9.]+) A[^"]*" fill="([^"]+)"[^>]*data-code="([^"]+)" data-glyph="semicircle" data-r="([0-9.]+)"', svg):
        x0, base, fill, c, r = m.groups(); out[c] = (float(r), fill, float(x0) + float(r), float(base))
    return out


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;--rule:#ececec;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {"groups": draw(group_shape(), width=720), "members": draw(member_shape(), shape="semicircle", sort="value", accent_one="min"),
                   # a narrower board and smaller glyphs: the small values print under their half discs and the names stagger on two lines
                   "small": draw(member_shape(), shape="semicircle", max_d=60, width=720)}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"glyph_row-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_the_group_means_are_the_members_unweighted_means(self):
        g = groups()
        self.assertEqual(sorted(sum(g.values(), [])), sorted(c for c in Y2025 if c != "CY"))
        self.assertEqual({k: round(v, 1) for k, v in means().items()}, {"154": 44.4, "039": 26.1, "151": 20.3, "155": 25.0})

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_the_area_is_the_value(self):
        low = {**{c: Y2025[c] for c in sorted(Y2025, key=lambda c: (Y2025[c], c))[:12]}, "ref": Y2025["SE"]}
        vals = {"groups": means(), "members": low, "small": low}
        for n, (svg, _, _) in self.out.items():
            got = radii(svg)
            self.assertEqual(set(got), set(vals[n]), n)
            v_max, r_max = max(vals[n].values()), max(r for r, *_ in got.values())
            for c, v in vals[n].items():
                self.assertAlmostEqual((got[c][0] / r_max) ** 2, v / v_max, places=4, msg=(n, c))
            # the glyphs stand on one base line
            self.assertEqual(len({round(b, 1) for *_, b in got.values()}), 1, n)

    def test_one_glyph_in_the_accent(self):
        for n, want in (("groups", "039"), ("members", "BE")):
            got = radii(self.out[n][0])
            self.assertEqual([c for c, (_, fill, *_) in got.items() if fill == "var(--accent)"], [want], n)
        ghost = radii(self.out["members"][0])["ref"]
        self.assertEqual(ghost[1], "none")
        self.assertRegex(self.out["members"][0], r'fill="none" stroke="var\(--t-sec\)" stroke-width="1.2" stroke-dasharray="4 3" data-code="ref"')

    def test_values_inside_where_they_fit_else_under(self):
        where = {}
        for n, (svg, _, _) in self.out.items():
            got = radii(svg)
            for m in re.finditer(r'<text x="([0-9.]+)" y="([0-9.]+)" font-size="([0-9.]+)" text-anchor="middle"[^>]*><tspan data-src="fact:([a-z0-9_]+)"[^>]*>([^<]*)</tspan>', svg):
                x, y, size, key, text = float(m[1]), float(m[2]), float(m[3]), m[4], m[5]
                code = "ref" if key == "v_se" else key.split("_", 1)[1].upper()
                r, _, cx, base = got[code]
                self.assertAlmostEqual(x, cx, places=0)
                half_w = K.tw(text, size) / 2
                where.setdefault(n, set()).add(y < base)
                if y < base:   # inside: the text's box lies in the glyph
                    top = y - size * 0.8
                    cy = base - r if n == "groups" else base
                    for px, py in ((x - half_w, top), (x + half_w, top), (x - half_w, y + size * 0.25), (x + half_w, y + size * 0.25)):
                        self.assertLessEqual(math.hypot(px - cx, py - cy), r + 0.01, (n, code, text))
                else:
                    self.assertGreater(y - size * 0.8, base, (n, code))
        self.assertEqual(where, {"groups": {True}, "members": {True}, "small": {True, False}})
        # the names on the small board stand on two lines, every other one lower; on the wide boards on one
        lines = lambda n: {m for m in re.findall(r'<text x="[0-9.]+" y="([0-9.]+)"[^>]*><tspan data-src="name:', self.out[n][0])}
        self.assertEqual((len(lines("groups")), len(lines("members")), len(lines("small"))), (1, 1, 2))
        self.assertNotRegex(self.out["groups"][0], "欧盟")

    def test_the_value_order_is_a_knob(self):
        order = re.findall(r'data-code="([A-Z]+)" data-glyph', self.out["members"][0])
        self.assertEqual(order, sorted(order, key=lambda c: (-Y2025[c], c)))
        self.assertEqual(re.findall(r'data-code="([0-9]+)" data-glyph', self.out["groups"][0]), list(EUROPE_SUB))

    def test_a_zero_draws_a_point(self):
        svg = draw(member_shape(edit=lambda v: v.__setitem__("BE", 0.0)))[0]
        self.assertRegex(svg, r'data-code="BE" data-glyph="point"')
        self.assertEqual(check_svg(svg), [])

    def test_the_picture_is_one_svg_of_its_width(self):
        for n, w in (("groups", 720), ("members", 1140)):
            svg, ww, h = self.out[n]
            self.assertEqual(ww, w); self.assertTrue(svg.startswith(f'<svg class="glyph_row" viewBox="0 0 {w} {h}"')); self.assertGreater(h, 100)

    def test_a_right_hand_set_size_passes(self):
        rows, data, names = group_shape()
        v = means(); vmax = max(v.values())
        for it in data["items"]: it["d"] = round(110 * math.sqrt(v[it["code"]] / vmax), 2)
        self.assertEqual(check_svg(draw((rows, data, names))[0]), [])


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, spec=group_shape, **style):
        rows, data, names = spec()
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            glyph_row.draw({"data": data, "style": {"glyph_row": style}})

    def test_its_refusals(self):
        self.refuse("holds 16 items; it draws 2 to 15", spec=lambda: member_shape(16))
        self.refuse("holds 1 items", lambda d, r: d.__setitem__("items", d["items"][:1]))
        self.refuse("come twice", lambda d, r: d["items"].append(dict(d["items"][0])))
        self.refuse("are not codes", lambda d, r: d["items"][0].__setitem__("code", "no good"))
        self.refuse("lacks a value", lambda d, r: d["items"][0].pop("text"))
        self.refuse("is not a series of the request", spec=member_shape, edit=lambda d, r: d["items"][0].__setitem__("value", f"series:{TABLE}/ZZ:{YEAR}:OBS_VALUE"))
        self.refuse("neither a series of the request nor a fact", lambda d, r: d["items"][0].__setitem__("value", "period:t:2025"))
        self.refuse("is negative", spec=lambda: member_shape(edit=lambda v: v.__setitem__("BE", -1.0)))
        self.refuse("prints '26.1'", lambda d, r: d["items"][0].__setitem__("text", "fact:grp_039"))
        self.refuse("too skewed for an area", spec=lambda: member_shape(edit=lambda v: v.__setitem__("BE", 0.08)))
        self.refuse("accent names more than one", lambda d, r: d.__setitem__("accent", ["039", "151"]))
        self.refuse("accent names 'ZZ', no item", lambda d, r: d.__setitem__("accent", "ZZ"))
        self.refuse("accent_one names 'ZZ', no item", accent_one="ZZ")
        self.refuse("does not fit inside", spec=member_shape, value_inside="inside", max_d=40)
        self.refuse("does not fit the 360 px board", spec=lambda: member_shape(15), width=360)
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("共 4 组")))
        self.refuse("off its range", max_d=500)
        self.refuse("no knob", dots=1)

    def test_a_hand_set_size_must_be_the_values(self):
        def hand(d, r):
            for it in d["items"]: it["d"] = 110 * (glyph_row_value(it) / 44.414)   # proportional to the value: the area would be its square
        def glyph_row_value(it): return means()[it["code"]]
        self.refuse("hand-set size .* the cited values give", hand)

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "glyph_row.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "renewab", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
