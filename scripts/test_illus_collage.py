"""The collage version of the story hero (runtime/illus_hero/collage, run_hero.py build_collage; node.json topics.collage_renderer): engraving
cut-outs in a perspective queue, K of N in the accent. Data shapes: 27 members lit by a rule (the people-style request of test_illus_scene_wiring),
the em_tally and pop_tally fixtures under the unemployment family, 3 members with 1 lit, 30 with 12 lit, 12 with 5 lit. Checked: the unemployment
family's tally is the collage and its other requests keep the people topic's routing; N outside 3..30 and a layout other than the tally are
`unavailable`; a missing or wrong declared count or total is refused; the same request gives the same bytes (through the real child, with the
image packages blocked: the run needs the standard library only) and another member list another picture; the reply is in the hero grammar
(a Python mirror of next_leaf.rs hero_faults: g, path, image, defs, mask, linearGradient, stop; hex colours; png/jpeg data URLs), holds no text,
and its accent figures (accent blocks under a clothing mask) are the declared count, its figures (outline masks) the member count; the svg is at
most 3 MB, the pack at most 6 MB and each piece at most 150 KB; every piece's sha256 is the pack's, every figure has a CC0/PDM licence row.
Run: python3 -I -B scripts/test_illus_collage.py"""
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
COLLAGE = os.path.join(ROOT, "runtime", "illus_hero", "collage")
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
import run_hero as R  # noqa: E402

with open(os.path.join(ROOT, "fixtures", "illus-vary-specs.json"), encoding="utf-8") as _f: SPECS = json.load(_f)
RATES = [5.9, 4.4, 4.3, 5.1, 3.0, 6.4, 4.4, 11.1, 12.2, 7.4, 6.1, 7.6, 6.1, 6.5, 6.9, 5.2, 4.1, 3.5, 3.6, 5.1, 2.8, 6.5, 5.6, 3.7, 3.5, 7.2, 7.7]
CODES = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]
MEAN = round(sum(RATES) / len(RATES), 9)
ABOVE = sum(1 for v in RATES if v > MEAN)
ACCENT = "#b8433a"
MB = 1024 * 1024
LICENCES = ("https://creativecommons.org/publicdomain/zero/1.0/", "https://creativecommons.org/publicdomain/mark/1.0/")


def people_req(**extra):
    sub = {"members": [{"code": c, "value": v} for c, v in zip(CODES, RATES)], "rule": {"op": "gt", "ref": MEAN}, "declared": {"count": ABOVE, "total": 27}}
    return {"family": "unemployment", "lead": "members", "width": 1140, "ground": "warm", "accent": ACCENT, "tags": [], "hero": "figures", "subject": sub, **extra}


def top_req(n, k, width=1140, pre="M", **extra):
    ms = [{"code": f"{pre}{i:02d}", "value": float(i)} for i in range(n)]
    return {"family": "unemployment", "lead": "members", "width": width, "accent": ACCENT, "subject": {"members": ms, "rule": {"op": "top", "k": k}, "declared": {"count": k, "total": n}}, **extra}


def spec_req(name):
    return {"family": "unemployment", "lead": SPECS[name]["lead"], "width": 1140, "accent": ACCENT, "subject": SPECS[name]["subject"]}


SHAPES = {"people27": people_req(), "em_tally": spec_req("em_tally"), "pop_tally": spec_req("pop_tally"), "n3k1": top_req(3, 1), "n30k12": top_req(30, 12),
          "n12k5_wide": top_req(12, 5, width=2000)}


def text(path):
    with open(path, encoding="utf-8") as f: return f.read()


def hero_faults(svg):
    """A Python mirror of next_leaf.rs hero_faults (the page's own check of a hero), element by element and attribute by attribute."""
    num = lambda s: re.fullmatch(r"\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*", s) is not None and s == s.strip()
    hexc = lambda s: re.fullmatch(r"#[0-9a-fA-F]{6}", s) is not None
    ident = lambda s: re.fullmatch(r"[A-Za-z0-9_-]+", s) is not None

    def transform(v):
        m = re.fullmatch(r"(?:translate\(([^,()]*),([^,()]*)\)\s*)?(?:scale\(([^()]*)\))?", v)
        if not m or v == "": return False
        if m.group(1) is not None and not (num(m.group(1)) and num(m.group(2))): return False
        if m.group(3) is not None and not num(m.group(3)): return False
        return True
    allowed = {("g", False): ["fill", "stroke", "stroke-width", "stroke-linejoin", "opacity", "transform", "mask"],
               ("path", True): ["d", "fill", "stroke", "stroke-width", "stroke-linejoin", "opacity", "transform", "mask"],
               ("image", True): ["href", "width", "height", "preserveAspectRatio"], ("defs", False): [],
               ("linearGradient", False): ["id", "x1", "y1", "x2", "y2"], ("stop", True): ["offset", "stop-color", "stop-opacity"],
               ("mask", False): ["id", "maskUnits", "x", "y", "width", "height"]}
    off = []
    if len(svg) > 4 * MB: off.append("too many bytes")
    stack, defined, used, rest = [], [], [], svg
    while rest and not off:
        lt = rest.find("<"); lt = len(rest) if lt < 0 else lt
        if rest[:lt].strip(): off.append(f"text between the tags: {rest[:40]!r}"); break
        rest = rest[lt:]
        if not rest: break
        gt = rest.find(">")
        if gt < 0: off.append("a tag is not closed"); break
        tag, rest = rest[1:gt], rest[gt + 1:]
        if tag.startswith("/"):
            if not stack or stack.pop() != tag[1:]: off.append(f"</{tag[1:]}> closes nothing open"); break
            continue
        closed = tag.endswith("/"); body = tag[:-1] if closed else tag; name = body.split(" ")[0]
        keys = allowed.get((name, closed))
        if keys is None: off.append(f"element <{name}{'/' if closed else ''}>"); break
        a = body[len(name):].strip()
        while a:
            if '="' not in a: off.append(f"<{name}> attribute not key=value"); break
            key, after = a.split('="', 1)
            if '"' not in after: off.append(f"<{name}> {key} not closed"); break
            value, after = after.split('"', 1)

            def paint(v):
                if v == "none" or hexc(v): return True
                m = re.fullmatch(r"url\(#(.*)\)", v)
                if m and ident(m.group(1)): used.append(m.group(1)); return True
                return False
            if key == "d": ok = re.fullmatch(r"[0-9 ,.\-eEMCLQTZHVmclqtzhv]*", value) is not None
            elif key in ("fill", "stroke", "stop-color"): ok = paint(value)
            elif key == "mask": ok = value.startswith("url(#") and paint(value)
            elif key in ("stroke-width", "x1", "y1", "x2", "y2", "x", "y", "width", "height", "offset", "opacity", "stop-opacity"): ok = num(value)
            elif key == "stroke-linejoin": ok = value == "round"
            elif key == "transform": ok = transform(value)
            elif key == "id": defined.append(value); ok = ident(value)
            elif key == "maskUnits": ok = value == "userSpaceOnUse"
            elif key == "preserveAspectRatio": ok = value == "none"
            elif key == "href":
                m = re.fullmatch(r"data:image/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)", value); ok = m is not None
            else: ok = False
            if not (ok and key in keys): off.append(f"<{name} {key}={value[:40]!r}>"); break
            a = after.lstrip()
        if not closed: stack.append(name)
    if not off and stack: off.append(f"{len(stack)} element(s) not closed")
    if not off:
        miss = [i for i in used if i not in defined]
        if miss: off.append(f"url(#{miss[0]}) undefined")
    return off


def accent_figures(svg, accent):
    """(accent figures, figures) read off the svg's structure: an accent figure is a path in the accent under a clothing mask (clg-c<j>) whose
    mask is defined with an image; a figure is a paper block under an outline mask (clg-s<j>)."""
    reds = re.findall(r'<path d="[^"]*" fill="' + re.escape(accent) + r'" mask="url\(#(clg-c\d+)\)"/>', svg)
    for m in reds: assert re.search(r'<mask id="' + m + r'"><image href="data:image/png;base64,', svg), m
    figs = re.findall(r'<path d="[^"]*" fill="#[0-9a-f]{6}" mask="url\(#(clg-s\d+)\)"/>', svg)
    return len(set(reds)), len(set(figs))


BLOCKED = "import sys\nclass B:\n    def find_spec(self, name, path=None, target=None):\n        if name.split('.')[0] in ('PIL', 'numpy', 'scipy', 'cairosvg'): raise ImportError('blocked: ' + name)\nsys.meta_path.insert(0, B())\nsys.argv = [sys.argv[1]]\nimport runpy\nrunpy.run_path(sys.argv[0], run_name='__main__')\n"


def child(req):
    """The real child's reply, with the image packages blocked (the run's python may have none of them)."""
    p = subprocess.run([sys.executable, "-I", "-B", "-c", BLOCKED, os.path.join(ROOT, "runtime", "illus_hero", "run_hero.py")], input=json.dumps(req) + "\n",
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-500:]
    return json.loads(p.stdout)


class Collage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {n: R.build_collage(r) for n, r in SHAPES.items()}

    def test_the_unemployment_tally_is_the_collage_and_its_other_requests_are_routed_as_peoples(self):
        self.assertEqual(R.topic_of("unemployment"), "labour")
        self.assertEqual(R.renderer_of(people_req()), "collage")
        ms = people_req()["subject"]["members"]
        for lead in ("rank", "ends"): self.assertEqual(R.renderer_of({"family": "unemployment", "lead": lead, "subject": {"members": ms}}), "scene", lead)
        self.assertEqual(R.renderer_of({"family": "unemployment", "lead": "path", "subject": {"path": {}}}), "people")
        self.assertEqual(R.renderer_of({"family": "unemployment", "subject": {"proportion": {}}}), "scene")
        self.assertEqual(R.renderer_of({"family": "pop65", "lead": "members", "subject": people_req()["subject"]}), "scene")
        self.assertEqual([t for t, s in R.TOPICS["scenes"].items() if s["renderer"] == "collage"], ["labour"])

    def test_the_accent_figures_are_the_declared_count_and_the_figures_the_members(self):
        for name, (svg, w, h, secs, scene, comp) in self.out.items():
            dec = SHAPES[name]["subject"]["declared"]
            self.assertEqual(accent_figures(svg, ACCENT), (dec["count"], dec["total"]), name)
            self.assertEqual((comp["lit"], comp["objects"], comp["omitted"], len(comp["red"]), len(comp["pieces"])), (dec["count"], dec["total"], 0, dec["count"], dec["total"]), name)
            self.assertEqual(scene, "labour.tally"); self.assertEqual(comp["renderer"], "collage")

    def test_the_reply_is_in_the_hero_grammar_with_no_text(self):
        for name, (svg, w, h, secs, scene, comp) in self.out.items():
            self.assertEqual(hero_faults(svg), [], name)
            self.assertNotIn("<text", svg); self.assertNotIn("<script", svg); self.assertNotIn("var(", svg)
            self.assertTrue(svg.startswith('<g transform="scale('), name)
            self.assertEqual(w, float(SHAPES[name]["width"])); self.assertAlmostEqual(h, 560 * SHAPES[name]["width"] / 1440, places=1)

    def test_the_mirror_refuses_what_the_hero_check_refuses(self):
        good = '<g transform="translate(1,2)"><defs><mask id="m"><image href="data:image/png;base64,AAAA" width="2" height="3" preserveAspectRatio="none"/></mask></defs><path d="M0 0H2V3H0Z" fill="#aabbcc" mask="url(#m)"/></g>'
        self.assertEqual(hero_faults(good), [])
        for bad in (good.replace('width="2" height', 'x="1" width="2" height'), good.replace("data:image/png", "data:image/svg+xml"), good.replace('"url(#m)"', '"url(#n)"'),
                    good.replace('transform="translate(1,2)"', 'transform="translate(1, 2)"'), good.replace("#aabbcc", "red"), good + "<text>1</text>", good.replace("<g ", "<rect/><g ")):
            self.assertNotEqual(hero_faults(bad), [], bad[:80])

    def test_the_accent_figures_stand_in_view(self):
        for name in ("people27", "em_tally", "pop_tally", "n30k12", "n12k5_wide"):
            self.assertGreaterEqual(self.out[name][5]["red_visible_min"], R.CR["red_visible"], name)

    def test_colours_are_the_request_accent_else_the_topics(self):
        svg = R.build_collage({k: v for k, v in top_req(10, 3).items() if k != "accent"})[0]
        self.assertEqual(accent_figures(svg, R.TOPICS["scenes"]["labour"]["accent"]), (3, 10))
        self.assertEqual(set(re.findall(r'fill="(#[0-9a-f]{6})"', self.out["n3k1"][0])), {ACCENT, json.loads(text(os.path.join(COLLAGE, "pack.json")))["paper"], "#000000"})

    def test_n_outside_3_to_30_or_another_layout_is_unavailable(self):
        with self.assertRaisesRegex(R.Unavailable, "31 members"): R.build_collage(top_req(31, 5))
        self.assertEqual(list(child(top_req(31, 5))), ["unavailable"])
        for lead, sub in (("rank", {"members": people_req()["subject"]["members"]}), ("path", {"path": {"from": 0, "now": 1, "goal": 2}}), ("groups", {"groups": []})):
            with self.assertRaisesRegex(R.Unavailable, "layout"): R.build_collage({**people_req(), "lead": lead, "subject": sub})

    def test_a_missing_or_wrong_declared_is_refused(self):
        base = people_req(); sub = base["subject"]
        for dec in (None, {"count": ABOVE}, {"total": 27}, {"count": ABOVE + 1, "total": 27}, {"count": ABOVE, "total": 26}):
            s = {k: v for k, v in sub.items() if k != "declared"}
            if dec is not None: s["declared"] = dec
            with self.assertRaises(R.Refused, msg=str(dec)): R.build_collage({**base, "subject": s})
            self.assertEqual(list(child({**base, "subject": s})), ["refused"], dec)
        with self.assertRaisesRegex(R.Refused, "only the scene renderer"): R.build_collage({**base, "composition": {"style": "ink"}})

    def test_same_request_same_bytes_and_another_member_list_another_picture(self):
        a, b = child(people_req()), child(people_req())
        for r in (a, b): r.pop("seconds")
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertEqual(a["svg"], self.out["people27"][0]); self.assertEqual(a["scene"], "labour.tally"); self.assertEqual(a["composition"]["lit"], ABOVE)
        moved = people_req(); moved["subject"]["members"][0]["code"] = "XX"
        c = R.build_collage(moved)
        self.assertNotEqual(c[0], a["svg"]); self.assertEqual(accent_figures(c[0], ACCENT), (ABOVE, 27))
        self.assertNotEqual(R.build_collage(top_req(27, 13, pre="N"))[0], R.build_collage(top_req(27, 13, pre="M"))[0])

    def test_the_run_reads_only_the_standard_library(self):
        import ast
        std = {"base64", "hashlib", "json", "os", "random"}
        tree = ast.parse(text(os.path.join(COLLAGE, "draw.py")))
        mods = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names} | {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        self.assertEqual(mods - std, set())
        calls = [n.func for n in ast.walk(tree) if isinstance(n, ast.Call)]
        self.assertNotIn("hash", [f.id for f in calls if isinstance(f, ast.Name)])        # no salted hash(), no clock
        self.assertEqual({f.attr for f in calls if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "random"}, {"Random"})   # only a seeded generator


class Pack(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = json.loads(text(os.path.join(COLLAGE, "pack.json")))
        with open(os.path.join(COLLAGE, "pack.bin"), "rb") as f: cls.bin = f.read()

    def test_byte_caps(self):
        total = sum(os.path.getsize(os.path.join(COLLAGE, f)) for f in os.listdir(COLLAGE) if os.path.isfile(os.path.join(COLLAGE, f)))
        self.assertLessEqual(total, 6 * MB, total); self.assertLessEqual(len(self.bin), 6 * MB)
        self.assertLessEqual(max(p["len"] for p in self.index["pieces"]), 150 * 1024)
        worst = R.build_collage(top_req(30, 29, width=2000))[0]      # the largest figures at the widest page, every one in the accent
        self.assertLessEqual(len(worst), 3 * MB, len(worst)); self.assertLessEqual(len(worst), R.CR["max_svg_bytes"])

    def test_every_piece_is_the_bytes_its_sha256_names(self):
        self.assertEqual(hashlib.sha256(self.bin).hexdigest(), self.index["bin_sha256"]); self.assertEqual(len(self.bin), self.index["bin_bytes"])
        end = 0
        for p in sorted(self.index["pieces"], key=lambda p: p["offset"]):
            self.assertEqual(p["offset"], end, p["id"]); end = p["offset"] + p["len"]
            self.assertEqual(hashlib.sha256(self.bin[p["offset"]:end]).hexdigest(), p["sha256"], p["id"])
            for k in ("id", "figure", "tier", "kind", "w", "h", "foot_y", "facing", "red_ok"): self.assertIn(k, p)
        self.assertEqual(end, len(self.bin))

    def test_every_figure_has_three_tiers_and_a_licence_row(self):
        rows = {r["id"]: r for r in csv.DictReader(text(os.path.join(COLLAGE, "LICENSES.tsv")).splitlines(), delimiter="\t")}
        for p in self.index["pieces"]:
            self.assertIn(p["figure"] or p["id"], rows, p["id"])
            self.assertIn(rows[p["figure"] or p["id"]]["licence_url"], LICENCES, p["id"])
        ids = {p["id"] for p in self.index["pieces"]}
        for f in self.index["figures"]:
            for t in ("l", "m", "s"):
                self.assertIn(f"{f['id']}.{t}.lines", ids); self.assertIn(f"{f['id']}.{t}.sil", ids)
                if f["red_ok"]: self.assertIn(f"{f['id']}.{t}.cloth", ids)
            self.assertTrue(rows[f["id"]]["source_url"].startswith("https://www.metmuseum.org/art/collection/search/"), f["id"])
        for name in ("LICENCE-met-openaccess-README.txt", "LICENSE-CC0-1.0-legalcode.txt"): self.assertTrue(os.path.getsize(os.path.join(COLLAGE, name)) > 1000, name)
        self.assertGreaterEqual(sum(f["red_ok"] for f in self.index["figures"]), 30)     # enough accent figures for 30 members

    def test_the_pack_holds_no_local_path_or_non_english_text(self):
        for name in ("pack.json", "LICENSES.tsv", "draw.py"):
            self.assertNotRegex(text(os.path.join(COLLAGE, name)), r"/Users/|/private/|[^\x00-\x7f]", name)


if __name__ == "__main__":
    unittest.main()
