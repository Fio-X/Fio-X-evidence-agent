"""One accent on the opening picture (runtime/illus_hero/one_accent.py, run_hero.py accent_of): the page judge's item 'single accent colour'
counts each painted colour whose chroma (max - min of r, g, b, over 255) is at least 0.30, and passes a page with one, the page accent
(tokens.css --accent). Checked: the saturated colours of the reply's svg (every '#rrggbb' in it, so also gradient stops, masks and style
attributes, a stricter reading than the judge's painted shapes) are only the page accent, for the collage (a tally of 10 with 3 lit and a
proportion of 30 figures with 7 lit), the scene renderer (people topic: a tally of 27 lit by a rule, a proportion of 10), the people
renderer (energy topic: a path and a tally), and the line renderer (energy topic, wind, a tally); the piece sets send the accent by the
page colour name and no topic keeps an accent of its own; the pass greys a green inside a gradient and in a style attribute, snaps a lifted
copy of the accent to the accent, keeps a darker shade of it under the line, and leaves greys as they are.
Run: python3 -I -B scripts/test_illus_one_accent.py"""
import io
import json
import os
import re
import shutil
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
import run_hero as R  # noqa: E402
import one_accent as OA  # noqa: E402

STRONG = 0.30      # the judge's line (chroma(c) < 0.30 is not counted)
RATES = [5.9, 4.4, 4.3, 5.1, 3.0, 6.4, 4.4, 11.1, 12.2, 7.4, 6.1, 7.6, 6.1, 6.5, 6.9, 5.2, 4.1, 3.5, 3.6, 5.1, 2.8, 6.5, 5.6, 3.7, 3.5, 7.2, 7.7]
CODES = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]
MEAN = round(sum(RATES) / len(RATES), 9)
ABOVE = sum(1 for v in RATES if v > MEAN)
SPECS = json.load(open(os.path.join(ROOT, "fixtures", "illus-vary-specs.json"), encoding="utf-8"))


def saturated(svg):
    """The distinct colours of the svg at or over the judge's line: every #rrggbb (attributes, stops, style) and every rgb()."""
    out = set()
    for h in re.findall(r"#[0-9a-fA-F]{6}(?![0-9a-fA-F])", svg):
        c = [int(h[i:i + 2], 16) for i in (1, 3, 5)]
        if (max(c) - min(c)) / 255 >= STRONG: out.add(h.lower())
    for m in re.findall(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)", svg):
        c = [float(x) for x in m]
        if (max(c) - min(c)) / 255 >= STRONG: out.add("rgb(%s)" % ",".join(m))
    return out


def rule_sub():
    return {"members": [{"code": c, "value": v} for c, v in zip(CODES, RATES)], "rule": {"op": "gt", "ref": MEAN}, "declared": {"count": ABOVE, "total": 27}}


def top_sub(n, k):
    return {"members": [{"code": f"M{i:02d}", "value": float(i)} for i in range(n)], "rule": {"op": "top", "k": k}, "declared": {"count": k, "total": n}}


def prop_sub(share, n, k):
    return {"proportion": {"share": share, "figures": n, "declared": {"count": k, "total": n}}}


def serve(inp):
    old = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(json.dumps(inp) + "\n"), io.StringIO()
    try: return json.loads((R.serve(), sys.stdout.getvalue())[1])
    finally: sys.stdin, sys.stdout = old


def fresh_draw():
    """line/draw.py and people/draw.py are both imported as `draw`: forget the other one before a build that imports its own."""
    sys.modules.pop("draw", None); sys.path[:] = [p for p in sys.path if not p.endswith((os.sep + "line", os.sep + "people"))]


class OneAccent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.page = R.page_accent()
        pieces = [json.load(open(os.path.join(ROOT, "runtime", "leaves_js", f), encoding="utf-8")) for f in ("pieces-people.json", "pieces-energy.json")]
        cls.sent = [p["hero"]["accent"] for p in pieces]       # what the visual group sends as the request's accent

    def assertOnlyAccent(self, svg, what):
        self.assertEqual(saturated(svg), {self.page}, what)

    def test_the_page_accent_is_the_palette_files(self):
        pal = json.load(open(os.path.join(ROOT, "runtime", "page_tree", "palettes.json"), encoding="utf-8"))
        self.assertEqual(self.page, pal["roles"]["accent"])

    def test_no_second_accent_in_the_data(self):
        self.assertEqual(self.sent, ["var(--accent)", "var(--accent)"])
        self.assertEqual([t for t, s in R.TOPICS["scenes"].items() if "accent" in s], [])
        self.assertEqual(R.accent_of({}), self.page); self.assertEqual(R.accent_of({"accent": "var(--accent)"}), self.page)
        with self.assertRaises(R.Refused): R.accent_of({"accent": "var(--bar)"})

    def test_collage_saturated_colours_are_only_the_page_accent(self):
        for acc in self.sent:
            for name, req in (("tally 3 of 10", {"family": "unemployment", "lead": "members", "subject": top_sub(10, 3)}),
                              ("proportion 7 of 30", {"family": "unemployment", "subject": prop_sub(0.233, 30, 7)})):
                r = serve({**req, "width": 1140, "ground": "warm", "accent": acc})
                self.assertEqual(r["composition"]["renderer"], "collage", name); self.assertOnlyAccent(r["svg"], name)

    @unittest.skipUnless(shutil.which("node") or os.path.exists("/opt/homebrew/bin/node"), "no node for the scene renderer")
    def test_scene_renderer_saturated_colours_are_only_the_page_accent(self):
        for name, req in (("people tally 27", {"family": "pop65", "lead": "members", "subject": rule_sub()}),
                          ("people proportion 4 of 10", {"family": "pop65", "subject": prop_sub(0.35, 10, 4)})):
            for style in ("ink", "iso", "geo"):
                fresh_draw(); r = serve({**req, "width": 1140, "ground": "warm", "accent": self.sent[0], "composition": {"style": style}})
                self.assertEqual(r["composition"]["renderer"], "scene", name); self.assertOnlyAccent(r["svg"], f"{name} {style}")

    def test_people_renderer_saturated_colours_are_only_the_page_accent(self):
        for nm in ("st1", "st4"):      # energy topic: a path (3 lit) and a tally of the members
            sp = SPECS[nm]; fresh_draw()
            svg = R.build_people({"family": sp["family"], "lead": sp["lead"], "width": 1140, "ground": "warm", "accent": self.sent[1], "subject": sp["subject"]})[0]
            self.assertOnlyAccent(svg, nm); self.assertIn(f'fill="{self.page}"', svg, nm)

    def test_line_renderer_saturated_colours_are_only_the_page_accent(self):
        fresh_draw()
        r = serve({"tags": [], "hero": "wind", "family": "renewable_share", "lead": "members", "width": 1140, "ground": "warm", "accent": self.sent[1],
                   "subject": {**rule_sub(), "measure": "wind"}})
        self.assertIn("svg", r, r); self.assertOnlyAccent(r["svg"], "energy wind tally")

    def test_the_pass_reads_gradients_and_styles(self):
        acc = "#c93f2b"
        svg = ('<defs><linearGradient id="g"><stop offset="0" stop-color="#1a9a6c"/></linearGradient></defs>'
               '<path style="fill:#2387d6" d="M0 0"/><path fill="#b9473e" d="M0 0"/><path fill="#954039" d="M0 0"/><path fill="#808080" d="M0 0"/>')
        out = OA.one_accent(svg, acc)
        self.assertEqual(saturated(out), {acc}); self.assertIn('fill="#808080"', out)
        self.assertIn(f'fill="{acc}"', out)                       # the lifted copy is the accent
        self.assertNotIn("#954039", out); self.assertLess(abs(OA.hls(OA.recolour("#954039", acc))[0] - OA.hls("#954039")[0]), 6.0)   # the shade keeps about its hue
        self.assertEqual(saturated(OA.one_accent(svg, acc).replace(acc, "#000000")), set())


if __name__ == "__main__":
    unittest.main()
