"""The line version of the story hero (runtime/illus_hero/line): the same composition as the 3D path resolves (run_hero.resolve), drawn as hand-style
line pictograms in pure SVG. For the five story questions st1..st5 (fixtures/illus-vary-specs.json): the lit units in the picture are the lit count the
rows give; the units fill at least the registered share of the picture height, measured on the drawn geometry; the units of one row do not overlap;
`omitted` is the members the request had minus the units drawn; the picture holds no digit-bearing text; the SVG is well-formed XML and
the default 3D path is not imported or changed. Also the DEFAULT path (the registry's topics.scenes.<topic>.renderer = line, through the real child run_hero.py): the reply has the 3D path's shape, only g and path, colours only the page variables (ink, accent, paper), lit units alone hold the accent.
Run: python3 -I -B scripts/test_illus_line.py"""
import json
import os
import re
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero", "line"))
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
import draw as D  # noqa: E402
import run_hero as R  # noqa: E402

SPECS = json.load(open(os.path.join(ROOT, "fixtures", "illus-vary-specs.json")))
REG = D.REG
NAMES = ["st1", "st2", "st3", "st4", "st5"]


def req(name):
    sp = SPECS[name]
    return {"family": sp["family"], "lead": sp["lead"], "width": 1140, "ground": "warm", "subject": sp["subject"]}


def members_of(sub):
    return len(sub["members"]) if "members" in sub else sum(len(g["members"]) for g in sub["groups"]) if "groups" in sub else None


class LineHero(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {n: D.draw(R.resolve(req(n), renderer="line"), annotate=True) for n in NAMES}
        cls.root = {n: ET.fromstring(cls.out[n]["svg"]) for n in NAMES}

    def test_lit_units_are_the_resolved_lit_count(self):
        for n in NAMES:
            want = R.resolve(req(n), renderer="line")[0]["composition"]["lit"]
            drawn = [g for g in self.root[n].iter("{http://www.w3.org/2000/svg}g") if "lit" in g.get("class", "").split()]
            self.assertEqual(len(drawn), want, n)
            self.assertEqual(sum(1 for u in self.out[n]["units"] if u["lit"]), want, n)
            self.assertEqual(self.out[n]["composition"]["lit"], want, n)

    def test_units_fill_the_share_of_the_height(self):
        for n in NAMES:
            us = self.out[n]["units"]; top = min(u["bbox"][1] for u in us); bot = max(u["bbox"][3] for u in us)
            self.assertGreaterEqual((bot - top) / D.CH, REG["min_unit_fraction"], n)
            self.assertGreaterEqual(min(u["bbox"][1] for u in us), 0); self.assertLessEqual(bot, D.CH)

    def test_units_of_a_row_do_not_overlap(self):
        for n in NAMES:
            rows = {}
            for u in self.out[n]["units"]: rows.setdefault((u["row"], u["ground"]), []).append(u["bbox"])
            for key, bs in rows.items():
                bs.sort()
                for a, b in zip(bs, bs[1:]): self.assertLessEqual(a[2], b[0] + 0.5, f"{n} row {key}: {a} touches {b}")
            for u in self.out[n]["units"]:
                b = u["bbox"]; self.assertGreaterEqual(b[0], 0); self.assertLessEqual(b[2], D.CW)

    def test_omitted_is_members_minus_drawn(self):
        for n in NAMES:
            sub = SPECS[n]["subject"]; m = members_of(sub)
            if m is None: self.assertEqual(self.out[n]["omitted"], 0); continue
            self.assertEqual(self.out[n]["omitted"], m - len(self.out[n]["units"]), n)
        self.assertEqual(self.out["st2"]["omitted"], len(SPECS["st2"]["subject"]["members"]) - 10)

    def test_the_ranking_draws_the_top_five_and_the_bottom_five_with_the_mark_between(self):
        us = sorted(self.out["st2"]["units"], key=lambda u: u["bbox"][0])
        self.assertEqual(len(us), 10)
        gap = us[5]["bbox"][0] - us[4]["bbox"][2]; gaps = [b["bbox"][0] - a["bbox"][2] for a, b in zip(us, us[1:])]
        self.assertEqual(max(gaps), gap, "the widest gap is the one the omission mark stands in")
        hs = [u["h"] for u in us]; self.assertEqual(hs[0], max(hs), "the highest value is the tallest")
        self.assertTrue(all(a >= b for a, b in zip(hs[:5], hs[1:5])) and all(a >= b for a, b in zip(hs[5:], hs[6:])), "heights follow the ranking at each end")

    def test_no_text_and_no_digits_in_the_picture(self):
        for n in NAMES:
            for el in self.root[n].iter():
                tag = el.tag.split("}")[-1]
                self.assertNotIn(tag, ("text", "tspan", "textPath"), n)
                self.assertFalse(any(ch.isdigit() for ch in (el.text or "")), n)
                self.assertFalse(any(ch.isdigit() for ch in (el.tail or "")), n)

    def test_the_svg_parses_and_is_deterministic(self):
        for n in NAMES:
            self.assertEqual(self.root[n].tag, "{http://www.w3.org/2000/svg}svg")
            self.assertEqual(D.draw(R.resolve(req(n), renderer="line"), annotate=True)["svg"], self.out[n]["svg"], n)

    def test_the_registry_holds_the_units_of_the_topic(self):
        used = {u["fn"] for n in NAMES for u in self.out[n]["units"]}
        self.assertEqual(used, {"turbine_unit", "dam_unit", "solar_unit", "pylon_unit", "biomass_unit"})
        for fn in used: self.assertIn("w_over_h", REG["units"][fn])


ALLOWED_PAINT = {"var(--t-title)", "var(--accent)", "var(--bg)", "none"}


def page_hex():
    """The page palette's own colours the child resolves its variables to (runtime/leaves_py/tokens.css): hex, 6 digits."""
    css = open(os.path.join(ROOT, "runtime", "leaves_py", "tokens.css"), encoding="utf-8").read(); out = {"none"}
    for n in ("--t-title", "--accent", "--bg"):
        h = re.search(re.escape(n) + r":#([0-9a-fA-F]{3,6})", css).group(1).lower(); out.add("#" + (h if len(h) == 6 else "".join(c * 2 for c in h)))
    return out


def page_faults(svg, allowed=None):
    """The shape next_leaf::hero_faults takes (elements g and path only, the attributes it lists, d of path characters, numbers); a colour is
    one of `allowed` (the page's variables for the drawing itself, their hex values for what the child sends)."""
    allowed = ALLOWED_PAINT if allowed is None else allowed
    off = []
    ok_g = {"fill", "stroke", "stroke-width", "stroke-linejoin", "opacity", "transform", "mask"}
    ok_path = ok_g | {"d"}
    num = lambda s: s.replace(".", "", 1).lstrip("-").isdigit()
    root = ET.fromstring(f"<root xmlns='http://www.w3.org/2000/svg'>{svg}</root>")
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag == "root": continue
        if tag not in ("g", "path"): off.append(f"element {tag}"); continue
        for k, v in el.attrib.items():
            if k not in (ok_path if tag == "path" else ok_g): off.append(f"{tag} {k}")
            elif k in ("fill", "stroke") and v not in allowed: off.append(f"{tag} {k}={v}")
            elif k == "opacity" and not num(v): off.append(f"opacity {v}")
            elif k == "d" and not all(c.isdigit() or c in " ,.-eEMCLQTZHVmclqtzhv" for c in v): off.append("d chars")
            elif k == "transform" and not (v.startswith("scale(") and v.endswith(")") and num(v[6:-1])): off.append(f"transform {v}")
        if (el.text or "").strip() or (el.tail or "").strip(): off.append("text between tags")
    return off


def child(r):
    """The real child, as the Rust visual group runs it: one JSON line on stdin, one JSON line out."""
    o = subprocess.run([sys.executable, "-I", "-B", os.path.join(ROOT, "runtime", "illus_hero", "run_hero.py")], input=json.dumps(r) + "\n", capture_output=True, text=True, timeout=60)
    return json.loads(o.stdout)


class DefaultPath(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.rep = {n: child(req(n)) for n in NAMES}

    def test_the_registry_names_the_renderer_of_every_topic(self):
        sc = R.TOPICS["scenes"]
        self.assertEqual({k: v["renderer"] for k, v in sc.items()}, {"energy": "line", "emissions": "3d", "people": "people", "trade": "3d", "migration": "3d", "neutral": "3d"})
        for n in NAMES: self.assertEqual(R.renderer_of(req(n)), "line", n)
        self.assertEqual(R.renderer_of({"family": "pop65", "subject": {}}), "people"); self.assertEqual(R.renderer_of({"tags": ["wind"]}), "3d")

    def test_the_reply_has_the_shape_the_3d_path_has(self):
        for n, rep in self.rep.items():
            self.assertEqual({"svg", "w", "h", "dropped", "scene", "seconds", "composition", "omitted", "omitted_label_key"}, set(rep), n)
            self.assertEqual((rep["w"], rep["dropped"], rep["omitted_label_key"]), (1140.0, [], "rank_omitted_middle"), n)
            self.assertAlmostEqual(rep["h"], 560 * 1140 / 1440, places=2); self.assertEqual(rep["omitted"], rep["composition"]["omitted"], n)
            self.assertTrue(rep["svg"].startswith('<g transform="scale(') and rep["svg"].endswith("</g>") and "<svg" not in rep["svg"], n)
            self.assertIsInstance(rep["seconds"]["total"], float)
        self.assertEqual(self.rep["st2"]["omitted"], len(SPECS["st2"]["subject"]["members"]) - 10)

    def test_what_the_child_sends_is_only_g_and_path_in_the_page_palette_s_own_hex(self):
        # the page's hero check takes hex only: the child resolves the drawing's variables from the page palette (tokens.css)
        hexes = page_hex()
        for n, rep in self.rep.items():
            self.assertEqual(page_faults(rep["svg"], hexes), [], n)
            self.assertNotIn("var(", rep["svg"], n)
            used = set(re.findall(r'(?:fill|stroke)="([^"]*)"', rep["svg"])); self.assertTrue(used <= hexes, f"{n}: {used - hexes}")
            self.assertIn("#c93f2b", rep["svg"], n)     # the accent: every story picture lights something
            self.assertNotIn("<rect", rep["svg"]); self.assertNotIn("fill-opacity", rep["svg"]); self.assertNotIn("class=", rep["svg"])

    def test_the_accent_is_the_lit_units_alone_and_the_mark(self):
        for n in NAMES:
            d = D.draw(R.resolve(req(n), renderer="line"), annotate=True); root = ET.fromstring(d["svg"]); ns = "{http://www.w3.org/2000/svg}"
            for g in root.iter(ns + "g"):
                cls = g.get("class", "").split()
                if "plain" in cls: self.assertNotIn("var(--accent)", ET.tostring(g, encoding="unicode"), f"{n}: an unlit unit holds the accent")
                if "lit" in cls: self.assertIn("var(--accent)", ET.tostring(g, encoding="unicode"), f"{n}: a lit unit lacks the accent")
            n_acc = d["svg"].count('fill="var(--accent)"'); lit = sum(1 for u in d["units"] if u["lit"])
            self.assertGreaterEqual(n_acc, lit, n)

    def test_a_3d_topic_is_not_drawn_by_the_line_child(self):
        rep = child({"family": "pop65", "lead": "rank", "width": 1140, "subject": SPECS["pop_rank"]["subject"]})
        self.assertNotIn("line", rep.get("seconds", {})); self.assertTrue("unavailable" in rep or "svg" in rep)     # Blender may be missing here; never the line drawing

    def test_what_the_line_drawing_cannot_draw_is_refused_in_the_refused_shape(self):
        bad = req("st2"); bad["width"] = 100
        self.assertEqual(set(child(bad)), {"refused"}); self.assertIn("width", child(bad)["refused"][0])
        bad = req("st2"); bad["subject"] = {"members": [{"code": "A", "value": 1}]}
        self.assertEqual(list(child(bad)), ["refused"])
        bad = req("st4"); bad["subject"] = {**bad["subject"], "measure": "tidal"}
        self.assertEqual(list(child(bad)), ["refused"])

    def test_a_layout_the_line_drawing_does_not_draw_is_unavailable_so_the_page_keeps_its_strip(self):
        # an energy page led by ends or spread (the pair layout): not refused (that stops the page) but unavailable (the strip stands in)
        pair = {"family": "renewable_share", "lead": "ends", "width": 1140, "subject": {"members": SPECS["st2"]["subject"]["members"]}}
        rep = child(pair); self.assertEqual(list(rep), ["unavailable"]); self.assertIn("pair", rep["unavailable"])

    def test_people_rank_keeps_ten_figures_in_3d(self):
        s = R.resolve(req_pop())[0]; self.assertEqual((sum(1 for i in s["items"] if i["fn"] == "figure_unit"), s["composition"]["omitted"]), (10, len(SPECS["pop_rank"]["subject"]["members"]) - 10))


def req_pop():
    sp = SPECS["pop_rank"]; return {"family": sp["family"], "lead": sp["lead"], "width": 1140, "ground": "warm", "subject": sp["subject"]}


if __name__ == "__main__":
    unittest.main(verbosity=1)
