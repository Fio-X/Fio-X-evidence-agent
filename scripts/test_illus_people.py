"""The people version of the story hero (runtime/illus_hero/people): the same composition the 3D and line paths resolve (run_hero.resolve, renderer
'people'), drawn with baked flat-colour people figures. For the story questions st1..st4 (fixtures/illus-vary-specs.json): the lit figures are the lit
count the rows give; every unit is one figure; `omitted` is the members the request had minus the units drawn; the figures fill at least the registered
share of the picture height; the reply is only <g> and <path> with hex colours, translate/scale transforms and path data of M L C Z (the grammar
next_leaf.rs hero_faults accepts, mirrored here); the baked registry holds no arcs, no fill-rule and no text, and carries the figure credit; the
groups layout is `unavailable`; and only the people topic takes this renderer (for the layouts the scene renderer does not draw). Colour: every baked
piece has a role; drawn with no recolouring pass (one_accent is never called), the picture's only strong colour is the page
accent, every colour beyond the neutrals is the accent's hue or one of the registered skin tones, and the accent's hue lands only on the whole outer
garment (top, top_back) of the lit figures, never on trousers, legs or anything else.
Run: python3 -I -B scripts/test_illus_people.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero", "people"))
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
import draw as PD  # noqa: E402
import run_hero as R  # noqa: E402
import one_accent as OA  # noqa: E402

SPECS = json.load(open(os.path.join(ROOT, "fixtures", "illus-vary-specs.json")))
NAMES = ["st1", "st2", "st3", "st4"]
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def req(name):
    sp = SPECS[name]
    return {"family": sp["family"], "lead": sp["lead"], "width": 1140, "ground": "warm", "subject": sp["subject"]}


def members_of(sub):
    return len(sub["members"]) if "members" in sub else sum(len(g["members"]) for g in sub["groups"]) if "groups" in sub else None


def cols(): return R.page_colours(["--accent", "--bar", "--t-title"])


def hero_grammar_faults(svg):
    """a Python mirror of the grammar next_leaf.rs hero_faults accepts for <g> and <path>."""
    off = []
    if len(svg) > 4 * 1024 * 1024: off.append("too many bytes")
    for m in re.finditer(r"<([^>]*)>", svg):
        tag = m.group(1)
        if tag.startswith("/"): continue
        body = tag[:-1] if tag.endswith("/") else tag; name = body.split(" ")[0]
        if name not in ("g", "path", "svg"): off.append(f"element {name}"); continue
        if name == "svg": continue
        for k, v in re.findall(r'([\w-]+)="([^"]*)"', body[len(name):]):
            if k == "d" and not re.fullmatch(r"[0-9 ,.\-eEMCLQTZHVmclqtzhv]*", v): off.append("d chars")
            elif k in ("fill", "stroke") and v != "none" and not HEX.match(v): off.append(f"{k}={v}")
            elif k == "transform" and not re.fullmatch(r"(translate\(-?[\d.]+,-?[\d.]+\)( scale\([\d.]+\))?|scale\([\d.]+\))", v): off.append(f"transform={v}")
            elif k not in ("d", "fill", "stroke", "stroke-width", "stroke-linejoin", "opacity", "transform", "mask"): off.append(f"attribute {k}")
    if re.search(r">[^<\s]", svg): off.append("text between tags")
    return off


class PeopleHero(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = {n: R.resolve(req(n), renderer="people") for n in NAMES}
        cls.out = {n: PD.draw(cls.res[n], cols()) for n in NAMES}

    def test_lit_figures_are_the_resolved_lit_count(self):
        for n in NAMES:
            want = self.res[n][0]["composition"]["lit"]
            self.assertEqual(sum(1 for u in self.out[n]["units"] if u["lit"]), want, n)
            self.assertEqual(self.out[n]["composition"]["lit"], want, n)

    def test_one_figure_per_unit_and_the_omitted_count(self):
        for n in NAMES:
            sp = SPECS[n]["subject"]; total = members_of(sp)
            drawn = len(self.out[n]["units"]); self.assertEqual(drawn, self.res[n][0]["composition"]["objects"], n)
            if total is not None: self.assertEqual(self.out[n]["omitted"], max(0, total - drawn), n)

    def test_figures_fill_the_registered_share_of_the_height(self):
        lo = PD.REG["min_unit_fraction"]
        for n in NAMES: self.assertGreaterEqual(self.out[n]["unit_fraction"], lo, n)

    def test_reply_is_only_g_and_path_in_the_hero_grammar(self):
        for n in NAMES: self.assertEqual(hero_grammar_faults(self.out[n]["inner"]), [], n)

    def test_lit_are_coloured_unlit_are_grey(self):
        from re import findall
        for n in NAMES:
            svg = self.out[n]["inner"]
            sat = lambda h: max(int(h[i:i + 2], 16) for i in (1, 3, 5)) - min(int(h[i:i + 2], 16) for i in (1, 3, 5))
            # every figure group is one <g transform=...>; the unlit ones hold only pale greys
            groups = re.findall(r'<g transform="translate[^"]*">(.*?)</g>', svg)
            self.assertEqual(len(groups), len(self.out[n]["units"]), n)
            lit_flags = [u["lit"] for u in sorted(self.out[n]["units"], key=lambda u: (-u["row"], u["bbox"][0] + u["bbox"][2]))]
            for g, lit in zip(groups, sorted(self.out[n]["units"], key=lambda u: (-u["row"], u["bbox"][0] + u["bbox"][2]))):
                fills = findall(r'fill="(#[0-9a-f]{6})"', g); top = max(sat(f) for f in fills)
                if lit["lit"]: self.assertGreater(top, 60, n)
                else: self.assertLess(top, 30, n)

    def test_every_piece_has_a_role_and_every_role_a_paint(self):
        P = PD.REG["paint"]
        for name, f in PD.FIG.items():
            roles = PD.ROLES[name]; self.assertEqual(len(roles), len(f["pieces"]), name)
            self.assertIn("top", roles, name); self.assertTrue(set(roles) <= set(P["roles"]), name)
        for h in [t[k] for t in P["skin"]["tones"] for k in ("base", "shade")] + [v for k, v in P["greys"].items() if k != "doc"]: self.assertRegex(h, r"^#[0-9a-f]{6}$")
        self.assertLessEqual(max(OA.chroma(v) for k, v in P["greys"].items() if k != "doc"), 0.03)
        for t in P["skin"]["tones"]:
            for k in ("base", "shade"):
                hh, _l, ss = OA.hls(t[k]); self.assertTrue(15 <= hh <= 32 and ss <= 0.45 and OA.chroma(t[k]) < OA.STRONG, t[k])   # warm, low saturation, under the line

    def test_one_accent_as_drawn_without_the_recolouring_pass(self):
        acc = cols()["--accent"]; ha = OA.hls(acc)[0]; skins = {t[k] for t in PD.REG["paint"]["skin"]["tones"] for k in ("base", "shade")}
        for n in NAMES:
            svg = self.out[n]["inner"]; painted = {h.lower() for h in OA.HEX.findall(svg)}
            self.assertEqual(OA.strong_colours(svg), [acc], n)
            off = [h for h in painted if OA.chroma(h) > OA.GREY_CHROMA and h not in skins and abs((OA.hls(h)[0] - ha + 180) % 360 - 180) > OA.ACCENT_HUE]
            self.assertEqual(off, [], n)                                              # one hue family beyond the neutrals and the skin

    def test_the_accent_is_on_the_lit_figures_outer_garment_only(self):
        acc = cols()["--accent"]; ha = OA.hls(acc)[0]
        red = lambda h: OA.chroma(h) > OA.GREY_CHROMA and abs((OA.hls(h)[0] - ha + 180) % 360 - 180) <= OA.ACCENT_HUE
        for n in NAMES:
            groups = re.findall(r'<g transform="translate[^"]*">(.*?)</g>', self.out[n]["inner"]); units = self.out[n]["units"]
            self.assertEqual(len(groups), len(units), n); lit_tops = 0
            for g, u in zip(groups, units):
                fills = re.findall(r'fill="(#[0-9a-f]{6})"', g); roles = PD.ROLES[u["figure"]]; self.assertEqual(len(fills), len(roles), n)
                for f, r in zip(fills, roles):
                    garment = r in ("top", "top_back")
                    self.assertEqual(red(f), u["lit"] and garment, (n, u["figure"], r, f))
                    if u["lit"] and r == "top": self.assertEqual(f, acc, n); lit_tops += 1
            self.assertGreaterEqual(lit_tops, self.res[n][0]["composition"]["lit"], n)

    def test_build_people_runs_no_recolouring_pass(self):
        real = R.one_accent
        def refuse(*_a): raise AssertionError("build_people called one_accent")
        R.one_accent = refuse
        try:
            for n in ("st1", "st4"):
                sys.modules.pop("draw", None); svg = R.build_people(req(n))[0]
                self.assertEqual(OA.strong_colours(svg), [R.page_accent()], n)
        finally:
            R.one_accent = real; sys.modules["draw"] = PD

    def test_the_baked_registry_is_in_the_grammar(self):
        reg = PD.REG; self.assertIn("Pablo Stanley", reg["credit"]); self.assertTrue(PD.ORDER)
        for name, f in reg["figures"].items():
            for p in f["pieces"]:
                self.assertRegex(p["d"], r"^[MLCZ0-9 .\-]*$", name); self.assertRegex(p["fill"], r"^#[0-9a-f]{6}$", name)
        self.assertNotIn("fill-rule", json.dumps(reg)); self.assertNotIn("<", json.dumps(reg["figures"]))

    def test_groups_layout_is_unavailable_and_only_the_people_topic_defaults_to_people(self):
        r = req("st4"); sp = dict(SPECS["st5"]); r = {"family": sp["family"], "lead": sp["lead"], "width": 1140, "ground": "warm", "subject": sp["subject"]}
        with self.assertRaises(R.Unavailable): R.build_people(r)
        self.assertEqual([t for t, s in R.TOPICS["scenes"].items() if "people" in (s["renderer"], s.get("renderer_else"))], ["people"])   # the people topic: scene for a tally, people for the rest

    def test_the_reply_has_the_line_paths_shape(self):
        svg, w, h, secs, name, comp = R.build_people(req("st1"))
        self.assertTrue(svg.startswith('<g transform="scale(')); self.assertEqual(w, 1140.0)
        self.assertEqual(hero_grammar_faults(svg), []); self.assertEqual(name, "energy.path"); self.assertEqual(comp["lit"], 3)
        self.assertAlmostEqual(h, PD.REG["kinds"]["path"]["canvas_h"] * 1140 / PD.CW, places=1)


if __name__ == "__main__":
    unittest.main()
