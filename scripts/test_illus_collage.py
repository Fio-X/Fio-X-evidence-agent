"""The collage version of the story hero (runtime/illus_hero/collage, run_hero.py build_collage; node.json topics.collage_renderer): engraving
cut-outs in one perspective queue whose front figure is the hero, K of N in the accent. Data shapes: 27 members lit by a rule (the people-style
request of test_illus_scene_wiring), the em_tally and pop_tally fixtures under the unemployment family, 3 members with 1 lit, 30 with 12 lit,
12 with 5 lit, and proportions of 30 figures (shares 0.105, 0.3, 0.43). Checked: the unemployment family's tally and proportion are the collage
and its other requests keep the people topic's routing; N outside 3..30 and a layout other than the tally are `unavailable`; a missing or wrong
declared count or total is refused (a proportion's exactly as proportion_flags refuses it); the hero stands at the queue's near end and the
queue recedes from right behind it in one sweep on the depth rule, on a whole sheet of paper (no ground band); only the hand-masked figures wear
the accent and come round again, never twice in one group, when K is more; the same request gives the same bytes (through the real child, with the
image packages blocked: the run needs the standard library only) and another member list another picture; the reply is in the hero grammar
(a Python mirror of next_leaf.rs hero_faults: g, path, image, defs, mask, linearGradient, stop; hex colours; png/jpeg data URLs), holds no text,
and its accent figures (accent blocks under a clothing mask) are the declared count, its figures (outline masks) the member count; the svg is at
most 3 MB, the pack at most 6 MB and each piece at most 150 KB; every piece's sha256 is the pack's, every figure has a CC0/PDM licence row; at least 25 figures wear
the accent, each with a clothing mask in every tier whose edge inside the figure has no straight run over 32 px at the largest tier.
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


def zero_req(n=10):
    ms = [{"code": f"Z{i:02d}", "value": float(i)} for i in range(n)]
    return {"family": "unemployment", "lead": "members", "width": 1140, "accent": ACCENT, "subject": {"members": ms, "rule": {"op": "gt", "ref": 99.0}, "declared": {"count": 0, "total": n}}}


def prop_req(share, n=30, count=None, total=None, width=1140, **extra):
    dec = {"count": count, "total": n if total is None else total}
    return {"family": "unemployment", "width": width, "accent": ACCENT, "subject": {"proportion": {"share": share, "figures": n, "declared": dec}}, **extra}


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


def flat_cut(tops, h):
    """Whether a mask's top edge (its first set row per column) is one horizontal line: over half the columns within 1.5% of the height of
    the commonest start row, or the middle 80% of the start rows within 5% of the height."""
    mode = max(set(tops), key=tops.count); st = sorted(tops)
    return sum(1 for y in tops if abs(y - mode) <= 0.015 * h) / len(tops) > 0.5 or (st[len(st) * 9 // 10] - st[len(st) // 10]) / h < 0.05


def accent_figures(svg, accent):
    """(accent figures, figures) read off the svg's structure: an accent figure is a path in the accent under a clothing mask (clg-c<j>) whose
    mask is defined with an image; a figure is a block under an outline mask (clg-s<j>); the hero's are clg-ch and clg-sh."""
    reds = re.findall(r'<path d="[^"]*" fill="' + re.escape(accent) + r'" mask="url\(#(clg-c(?:\d+|h))\)"(?: opacity="[0-9.]+")?/>', svg)
    for m in reds: assert re.search(r'<mask id="' + m + r'"><image href="data:image/png;base64,', svg), m
    figs = re.findall(r'<path d="[^"]*" fill="#[0-9a-f]{6}" mask="url\(#(clg-s(?:\d+|h))\)"/>', svg)
    return len(set(reds)), len(set(figs))


STRAIGHT_PX = 32        # the longest straight run allowed on a clothing mask's edge inside the figure, at the largest tier (480 px high)
STRAIGHT_TOL = 0.6      # px off the chord that still counts as straight (a rasterised polygon side stays within about half a pixel)
NB8 = [(0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1)]


def png_bits(data):
    """A non-interlaced 1-bit or 8-bit grey PNG as rows of 0/1, decoded with the standard library (zlib) so the check runs without Pillow."""
    import struct
    import zlib
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    i = 8; idat = b""; w = h = depth = None
    while i < len(data):
        n, = struct.unpack(">I", data[i:i + 4]); kind = data[i + 4:i + 8]; c = data[i + 8:i + 8 + n]; i += 12 + n
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, il = struct.unpack(">IIBBBBB", c); assert ctype == 0 and il == 0 and depth in (1, 8)
        elif kind == b"IDAT": idat += c
    raw = zlib.decompress(idat); stride = (w * depth + 7) // 8; prev = bytearray(stride); rows = []; p = 0
    for _ in range(h):
        f = raw[p]; line = bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for x in range(stride):
            a = line[x - 1] if x else 0; b = prev[x]; c = prev[x - 1] if x else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        rows.append([(line[x >> 3] >> (7 - (x & 7))) & 1 for x in range(w)] if depth == 1 else [1 if v > 127 else 0 for v in line[:w]])
    return rows


def filled(m):
    """A 0/1 mask with its holes filled (everything not reachable from the border through unset pixels)."""
    from collections import deque
    h, w = len(m), len(m[0]); out = [[1] * w for _ in range(h)]; q = deque()
    for y in range(h):
        for x in range(w):
            if (y in (0, h - 1) or x in (0, w - 1)) and not m[y][x]: out[y][x] = 0; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < h and 0 <= xx < w and out[yy][xx] and not m[yy][xx]: out[yy][xx] = 0; q.append((yy, xx))
    return out


def contours(m):
    """The outer contour of every part of a 0/1 mask, as ordered (y, x) lists (Moore neighbour tracing)."""
    h, w = len(m), len(m[0]); at = lambda y, x: 0 <= y < h and 0 <= x < w and m[y][x]
    seen = set(); out = []
    for y in range(h):
        for x in range(w):
            if m[y][x] and not at(y, x - 1) and (y, x) not in seen:
                start = cur = (y, x); pts = [start]; back = 4
                for _ in range(8 * h * w):
                    for k in range(8):
                        d = (back + 1 + k) % 8; ny, nx = cur[0] + NB8[d][0], cur[1] + NB8[d][1]
                        if at(ny, nx): break
                    else: break
                    cur = (ny, nx); back = (d + 4) % 8
                    if cur == start: break
                    pts.append(cur)
                seen.update(pts); out.append(pts)
    return out


def straight_runs(run, tol):
    """Douglas-Peucker split of an ordered run of edge pixels: the chord lengths of the pieces whose pixels all lie within tol px of their
    chord. Unlike growing a chord until the first pixel strays (which a pixel staircase stops early), the split finds every straight piece."""
    import math
    out = []; stack = [(0, len(run) - 1)]
    while stack:
        a, b = stack.pop()
        (y0, x0), (y1, x1) = run[a], run[b]; L = math.hypot(y1 - y0, x1 - x0)
        if b - a < 2: out.append(L); continue
        if L == 0: dev = [math.hypot(y - y0, x - x0) for y, x in run[a + 1:b]]
        else: dev = [abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / L for y, x in run[a + 1:b]]
        k = max(range(len(dev)), key=dev.__getitem__)
        if dev[k] <= tol: out.append(L)
        else: stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return out


def longest_straight(cloth, sil, tol=STRAIGHT_TOL, margin=2):
    """The longest straight run (px, chord length) of a clothing mask's edge where the edge lies inside the figure (over `margin` px inside
    its filled outline): a polygon side cutting across the clothing shows up here, the figure's own outline does not."""
    f = filled(sil); h, w = len(f), len(f[0])
    inside = lambda y, x: all(0 <= y + dy < h and 0 <= x + dx < w and f[y + dy][x + dx] for dy in range(-margin, margin + 1) for dx in range(-margin, margin + 1))
    best = 0.0
    for pts in contours(cloth):
        flags = [inside(*q) for q in pts]; n = len(pts)
        if not all(flags):                      # start at a point on the outline, so a run inside never wraps round the start
            s = flags.index(False); pts = pts[s:] + pts[:s]; flags = flags[s:] + flags[:s]
        i = 0
        while i < n:
            if not flags[i]: i += 1; continue
            j = i
            while j + 1 < n and flags[j + 1]: j += 1
            best = max([best] + straight_runs(pts[i:j + 1], tol))
            i = j + 1
    return best


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
        self.assertEqual(R.renderer_of({"family": "unemployment", "subject": {"proportion": {}}}), "collage")
        self.assertEqual(R.renderer_of({"family": "unemployment", "lead": "rank", "subject": {"members": ms, "proportion": {}}}), "collage")
        self.assertEqual(R.renderer_of({"family": "pop65", "subject": {"proportion": {}}}), "scene")
        self.assertTrue(R.takes_proportion(prop_req(0.105, count=3)))
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

    def test_a_proportion_is_drawn_by_the_collage_with_its_k_of_n(self):
        for share, k in ((0.105, 3), (0.3, 9), (0.43, 13), (0.0, 0)):
            svg, w, h, secs, scene, comp = R.build_collage(prop_req(share, count=k))
            self.assertEqual(scene, "labour.proportion"); self.assertEqual(comp["renderer"], "collage")
            self.assertEqual(accent_figures(svg, ACCENT), (k, 30), share); self.assertEqual(hero_faults(svg), [], share)
            self.assertEqual((comp["lit"], comp["objects"], len(comp["red"])), (k, 30, k), share)
            self.assertEqual(comp["hero"] is not None, k >= 1, share)
            if k: self.assertIn(comp["hero"], comp["red"]); self.assertEqual(comp["queue_flags"].count("r"), k - 1)
        for k in (9, 13):          # one rule for every K: spread single figures, a grey figure between every two, none touching the hero
            flags = R.build_collage(prop_req(round(k / 30, 3), count=k))[5]["queue_flags"]
            self.assertEqual(flags[0] + flags[-1], "gg", k); self.assertTrue(all(len(r) == 1 for r in re.findall(r"r+", flags)), flags)
        r = child(prop_req(0.105, count=3)); self.assertEqual(r["scene"], "labour.proportion"); self.assertEqual(accent_figures(r["svg"], ACCENT), (3, 30))
        self.assertEqual(r["svg"], R.build_collage(prop_req(0.105, count=3))[0])
        self.assertNotEqual(R.build_collage(prop_req(0.43, count=13))[0], R.build_collage(prop_req(0.4333, count=13))[0])    # the share seeds it

    def test_a_proportion_with_a_wrong_or_missing_declared_is_refused_and_n_off_range_unavailable(self):
        good = prop_req(0.105, count=3)
        for dec in (None, {"count": 3}, {"total": 30}, {"count": 4, "total": 30}, {"count": 3, "total": 29}):
            req = json.loads(json.dumps(good)); p = req["subject"]["proportion"]
            if dec is None: p.pop("declared")
            else: p["declared"] = dec
            with self.assertRaises(R.Refused, msg=str(dec)): R.build_collage(req)
            self.assertEqual(list(child(req)), ["refused"], dec)
        for n, k in ((31, 16), (60, 30), (2, 1)):          # a proportion the scene renderer would draw (1..60) but off the collage's 3..30
            with self.assertRaisesRegex(R.Unavailable, f"{n} figures"): R.build_collage(prop_req(0.5, n=n, count=k))
        self.assertEqual(list(child(prop_req(0.5, n=31, count=16))), ["unavailable"])
        for n in (0, 61, 3.0):
            with self.assertRaises(R.Refused, msg=str(n)): R.build_collage(prop_req(0.5, n=n, count=0))
        with self.assertRaisesRegex(R.Refused, "only the scene renderer"): R.build_collage({**good, "composition": {"style": "ink"}})
        with self.assertRaisesRegex(R.Refused, "accent"): R.build_collage({**good, "accent": "red"})

    def test_the_accent_figures_stand_in_view(self):
        for name in ("people27", "em_tally", "pop_tally", "n30k12", "n12k5_wide"):
            self.assertGreaterEqual(self.out[name][5]["red_visible_min"], R.CR["red_visible"], name)

    def test_the_hero_is_the_front_most_accent_figure_iff_k_is_at_least_one(self):
        lo, hi = R.REG["composition_knobs"]["hero_h"]["min"], R.REG["composition_knobs"]["hero_h"]["max"]
        for name, (svg, w, h, secs, scene, comp) in list(self.out.items()) + [("k0", R.build_collage(zero_req()))]:
            k = comp["lit"]
            self.assertEqual(comp["hero"] is not None, k >= 1, name); self.assertEqual('id="clg-sh"' in svg, k >= 1, name)
            if not k:
                self.assertEqual(accent_figures(svg, ACCENT), (0, comp["objects"])); self.assertNotIn("r", comp["queue_flags"]); continue
            self.assertIn(comp["hero"], comp["red"], name); self.assertIn('id="clg-ch"', svg, name)
            self.assertTrue(lo <= comp["hero_h"] <= hi, name); self.assertAlmostEqual(comp["hero_box"][3] / 560, comp["hero_h"], places=3)
            self.assertGreater(comp["hero_foot"], max(comp["queue_feet"]), name)              # in front of every queue figure
            self.assertGreater(comp["hero_box"][3], max(comp["queue_heights"]), name)         # and the largest
            self.assertLess(comp["hero_box"][0] + comp["hero_box"][2] / 2, 1440 / 3, name)   # in the left-front third
            self.assertEqual(comp["queue_flags"].count("r"), k - 1, name); self.assertEqual(comp["queue"], comp["objects"] - 1, name)
            self.assertLess(svg.index('id="clg-sh"'), svg.index('id="clg-grain"')); self.assertGreater(svg.index('id="clg-sh"'), svg.rindex('id="clg-s', 0, svg.index('id="clg-sh"')))
            if comp["queue"] < 2: continue
            hb = comp["hero_box"]; hx = hb[0] + hb[2] / 2; qx, qy, qh = comp["queue_x"], comp["queue_feet"], comp["queue_heights"]
            kn = {n: s["default"] for n, s in R.REG["composition_knobs"].items() if s.get("renderers") == ["collage"]}
            self.assertAlmostEqual(qx[0] - hx, kn["queue_gap"] * hb[3], delta=0.6, msg=name)      # the queue's first figure right behind the hero
            self.assertLess(qx[0] - 0.5 * R.CR["queue"]["aspect"] * qh[0], hb[0] + hb[2], name)    # touching it: no gap between hero and queue
            self.assertGreater(qh[0], 0.8 * hb[3], name)                                            # the hero is the queue's front figure, enlarged
            self.assertTrue(all(a < b for a, b in zip(qx, qx[1:])) and all(a > b for a, b in zip(qh, qh[1:])) and all(a > b for a, b in zip(qy, qy[1:])), name)   # one sweep: right, smaller, higher
            line = lambda x: comp["hero_foot"] + (kn["queue_far_foot"] * 560 - comp["hero_foot"]) * (x - hx) / (kn["queue_far_x"] * 1440 - hx)
            self.assertTrue(all(abs(y - line(x)) < 0.6 for x, y in zip(qx, qy)), name)               # every foot on the line from the hero's feet to the far end
            self.assertLessEqual(qx[-1], kn["queue_far_x"] * 1440 + 0.6, name)

    def test_three_shapes_k3_k13_k29_counts_groups_and_hero(self):
        G = R.CR["group"]
        for k in (3, 13, 29):
            svg, w, h, secs, scene, comp = R.build_collage(top_req(30, k))
            self.assertEqual(accent_figures(svg, ACCENT), (k, 30), k); self.assertEqual(hero_faults(svg), [], k)
            flags = comp["queue_flags"]; self.assertEqual(len(flags), 29); self.assertEqual(flags.count("r"), k - 1)
            runs = [len(r) for r in re.findall(r"r+", flags)]
            if 2 * (k - 1) <= 27:
                self.assertEqual(flags[0] + flags[-1], "gg", k); self.assertTrue(all(r == 1 for r in runs), (k, runs))   # spread, single figures
                self.assertEqual(comp["red_adjacent"], 0, k)
            self.assertEqual(comp["red_rule"], "spread", k)
        comp = R.build_collage(top_req(30, 29))[5]; masked = sum(f["red_ok"] for f in Pack.index_of()["figures"])
        self.assertGreater(29, masked); self.assertEqual(comp["red_repeats"], 29 - len(set(comp["red"]))); self.assertGreater(comp["red_repeats"], 0)
        ids, flags = comp["queue_ids"], comp["queue_flags"]
        red = [f for f, c in zip(ids, flags) if c == "r"]   # the masked figures come round again, never twice within any `group` accent figures in a row
        for i in range(len(red) - G + 1): self.assertEqual(len(set(red[i:i + G])), G, red[i:i + G])
        self.assertNotIn(comp["hero"], ids[:R.CR["group"]])

    def test_no_knife_edge_between_k_over_n_just_under_and_over_the_old_line(self):
        """The old stretch_share (0.3) switched the accent from spread single figures to a stretch of groups between K / N = 0.29 and 0.31: one
        rule now, so the neighbours of any share give the same layout family, no adjacent accent figures, and red mass centres that differ little."""
        self.assertNotIn("stretch_share", R.CR)
        for make in (lambda k: prop_req(round(k / 30, 4), count=k), lambda k: top_req(30, k)):
            comps = {k: R.build_collage(make(k))[5] for k in (8, 9, 10, 11)}          # 8/30 = 0.27, 9/30 = 0.30, 10/30 = 0.33, 11/30 = 0.37
            for k, c in comps.items():
                self.assertEqual((c["red_rule"], c["red_adjacent"], c["layout"]), ("spread", 0, f"collage-{k}of30"), k)
                self.assertTrue(all(len(r) == 1 for r in re.findall(r"r+", c["queue_flags"])), (k, c["queue_flags"]))
            mid = lambda f: sum(i for i, ch in enumerate(f) if ch == "r") / max(1, f.count("r"))
            for a, b in ((8, 9), (9, 10), (10, 11)):
                fa, fb = comps[a]["queue_flags"], comps[b]["queue_flags"]
                self.assertLessEqual(abs(mid(fa) - mid(fb)), 1.5, (a, b))                # the accent mass does not jump along the queue
                self.assertEqual((fa[0], fb[0]), ("g", "g"), (a, b))                       # neither puts an accent figure against the hero
                ha, hb = comps[a]["hero_box"], comps[b]["hero_box"]; self.assertEqual((round(ha[0] + ha[2] / 2, 1), round(ha[1] + ha[3], 1)), (round(hb[0] + hb[2] / 2, 1), round(hb[1] + hb[3], 1)), (a, b))   # the hero in the same place
        for share, k in ((0.29, 9), (0.31, 9)):          # shares that round to the same K give the same flags
            self.assertEqual(R.build_collage(prop_req(share, count=k))[5]["queue_flags"], R.build_collage(prop_req(0.3, count=9))[5]["queue_flags"])

    def test_k13_and_k7_accent_figures_are_spaced_and_one_figure_stands_at_most_twice(self):
        masked = sum(f["red_ok"] for f in Pack.index_of()["figures"] if f["usable"])
        for req in (top_req(30, 13), top_req(30, 7), prop_req(0.43, count=13), prop_req(0.233, count=7), top_req(27, 13), top_req(30, 29)):
            svg, w, h, secs, scene, comp = R.build_collage(req)
            self.assertEqual(comp["red_ok_count"], masked); self.assertEqual(comp["max_uses"], 2)          # the pack's red_ok as it is, not a fixed number
            ids = [comp["hero"]] + comp["queue_ids"] + comp["far_ids"]
            self.assertLessEqual(max(ids.count(f) for f in set(ids)), 2, comp["layout"]); self.assertEqual(comp["uses_max"], max(ids.count(f) for f in set(ids)))
            if comp["lit"] <= 14: self.assertEqual(comp["red_adjacent"], 0, comp["layout"]); self.assertNotIn("rr", comp["queue_flags"])
            self.assertGreater(comp["far"], 0); self.assertNotIn("clg-sf", svg); self.assertEqual(accent_figures(svg, ACCENT), (comp["lit"], comp["objects"]))
        sys.path.insert(0, COLLAGE); import draw as CD          # K over max_uses x the masked figures: unavailable, never a third use
        cfg = dict(R.CR, max_uses=1); kn = R.collage_knobs(top_req(30, 3))
        with self.assertRaisesRegex(CD.PackError, "at most 1 times"): CD.draw([f"M{i}" for i in range(30)], masked + 1, 30, 1140, ACCENT, cfg, kn)

    def test_the_far_view_fills_the_top_in_layers_that_fade_with_no_pasted_block(self):
        svg, w, h, secs, scene, comp = R.build_collage(top_req(30, 3)); L = R.CR["far"]["layers"]
        self.assertLessEqual(min(r["foot"] - r["h"] for r in L), 0.15)          # the far view's tops reach the top sixth: no empty paper band above the queue
        self.assertGreaterEqual(len(L), 2); self.assertTrue(all(a["h"] < b["h"] and a["fill"] > b["fill"] and a["ink"] < b["ink"] for a, b in zip(L, L[1:])))   # each layer paler and smaller than the next
        self.assertTrue(all(c > 0 for c in comp["far_layers"]), comp["far_layers"])
        ids, at = comp["far_ids"], 0
        for c in comp["far_layers"]:
            self.assertEqual(len(set(ids[at:at + c])), c); at += c          # no figure twice within one layer
        # no opaque axis-aligned block: every rectangle path is a figure box under an outline/clothing mask, or the grain under its mask
        for m in re.finditer(r'<path d="M0 0H[0-9.]+V[0-9.]+H0Z"([^>]*)/>', svg): self.assertIn('mask="url(#clg-', m.group(1))
        ops = [float(o) for o in re.findall(r'<mask id="clg-f\d+">.*?</defs><path [^>]*/><g opacity="([0-9.]+)">', svg)]
        self.assertEqual(len(ops), comp["far"]); self.assertLess(min(ops), 0.1)          # a layer's ends fade into the paper

    def test_accent_lies_under_the_lines_and_the_hero_red_is_the_fullest(self):
        svg, w, h, secs, scene, comp = R.build_collage(top_req(30, 13))
        for m in re.finditer(r'<path d="[^"]*" fill="' + ACCENT + r'" mask="url\(#(clg-c(?:\d+|h))\)"( opacity="([0-9.]+)")?/>', svg):
            rest = svg[m.end():]; g = rest[:rest.index("</g>") + 4]
            lines = re.match(r'<g opacity="([0-9.]+)"><image href="data:image/png;base64,', g)
            self.assertIsNotNone(lines, m.group(1)); self.assertGreaterEqual(float(lines.group(1)), 0.95, m.group(1))   # the lines next, over the accent, at full ink
            self.assertEqual(g.count("<image "), 1, m.group(1))                                                       # once: no second pass darkening the red
            if m.group(1) == "clg-ch": self.assertIsNone(m.group(2))                                                  # the hero's accent at full strength
            else: self.assertLess(float(m.group(3)), 1.0)                                                             # the queue's lighter

    def test_knobs_have_ranges_and_off_range_or_unknown_knobs_are_refused(self):
        ck = R.REG["composition_knobs"]; mine = [k for k, s in ck.items() if s.get("renderers") == ["collage"]]
        self.assertEqual(set(mine), {"hero_h", "hero_x", "hero_foot", "queue_gap", "queue_far_h", "queue_far_x", "queue_far_foot", "queue_ink", "queue_fill"})
        for name in mine:
            spec = ck[name]; self.assertTrue(spec["min"] <= spec["default"] <= spec["max"], name)
            for bad in (spec["min"] - 0.01, spec["max"] + 0.01, "big", True):
                with self.assertRaises(R.Refused, msg=f"{name}={bad}"): R.build_collage({**top_req(10, 3), "composition": {name: bad}})
        with self.assertRaisesRegex(R.Refused, "unknown composition knob"): R.build_collage({**top_req(10, 3), "composition": {"hero_size": 0.5}})
        self.assertLess(ck["queue_far_h"]["max"], ck["hero_h"]["min"]); self.assertLess(ck["queue_far_foot"]["max"], ck["hero_foot"]["min"]); self.assertLess(ck["hero_x"]["max"], ck["queue_far_x"]["min"])   # the far end always smaller, higher, right
        with self.assertRaises(R.Refused): R.build_collage({**prop_req(0.105, count=3), "composition": {"queue_gap": 0.9}})
        with self.assertRaisesRegex(R.Refused, "only the collage"): R.build_scene({"family": "pop65", "lead": "members", "width": 1140, "subject": people_req()["subject"], "composition": {"hero_h": 0.55}})
        a = R.build_collage({**top_req(10, 3), "composition": {"hero_h": 0.5}}); b = R.build_collage({**top_req(10, 3), "composition": {"hero_h": 0.6}})
        self.assertEqual((a[5]["hero_h"], b[5]["hero_h"]), (0.5, 0.6)); self.assertNotEqual(a[0], b[0])

    def test_colours_are_the_request_accent_else_the_pages(self):
        svg = R.build_collage({k: v for k, v in top_req(10, 3).items() if k != "accent"})[0]
        self.assertEqual(accent_figures(svg, R.page_accent()), (3, 10))
        svg = R.build_collage({**top_req(10, 3), "accent": "#123456"})[0]; self.assertEqual(accent_figures(svg, "#123456"), (3, 10))
        paper = json.loads(text(os.path.join(COLLAGE, "pack.json")))["paper"]; ck = R.REG["composition_knobs"]
        tone = lambda f: "#" + "".join(f"{round(int(paper[i:i + 2], 16) * f):02x}" for i in (1, 3, 5))
        out = self.out["n30k12"][0]; far = set(re.findall(r'fill="(#[0-9a-f]{6})" mask="url\(#clg-f\d+\)"', out))
        fills = set(re.findall(r'fill="(#[0-9a-f]{6})" mask="url\(#clg-[sc]', out) + re.findall(r'fill="(#000000)"', out))
        for f in far:          # the backdrop's blocks: the paper darkened (one factor on all three channels), never the accent
            r = [int(f[i:i + 2], 16) / int(paper[i:i + 2], 16) for i in (1, 3, 5)]; self.assertLess(max(r) - min(r), 0.02, f); self.assertLessEqual(max(r), 1.0, f)
        self.assertEqual(fills, {ACCENT, "#000000", tone(R.CR["hero_fill"]), tone(ck["queue_fill"]["default"])})     # one accent, the rest the paper's greys
        self.assertEqual(svg.count('<path d="M0 0H'), svg.count("<path "))       # every path a figure's box
        self.assertEqual(svg.count('<path d="M0 0H1440V560H0Z"'), 1)              # the grain the only full-frame one: no ground band, one sheet of paper
        self.assertNotRegex(svg, r'<path d="M0 [1-9]')

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
    @staticmethod
    def index_of():
        return json.loads(text(os.path.join(COLLAGE, "pack.json")))

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
        hand = set(re.findall(r'^    "(\d+_\d)": dict\(poly=', text(os.path.join(ROOT, "scripts", "build_collage_pack.py")), re.M))
        self.assertGreaterEqual(len(hand), 25)
        self.assertEqual({f["id"][len("met_gam_"):] for f in self.index["figures"] if f["red_ok"]}, hand)     # only the hand-masked figures wear the accent
        self.assertEqual({p["figure"] for p in self.index["pieces"] if p["kind"] == "cloth"}, {"met_gam_" + h for h in hand})

    def test_no_accent_mask_is_a_flat_horizontal_cut(self):
        """The top edge of every red_ok figure's clothing mask follows the shoulders: its start row varies across the mask's columns (not over
        half of them within 1.5% of the height of the commonest start row), at every tier, decoded from the pack with the standard library."""
        by = {p["id"]: p for p in self.index["pieces"]}; flat = []
        for f in self.index["figures"]:
            if not f["red_ok"]: continue
            for t in ("l", "m", "s"):
                p = by[f"{f['id']}.{t}.cloth"]; m = png_bits(self.bin[p["offset"]:p["offset"] + p["len"]])
                h, w = len(m), len(m[0]); tops = []
                for x in range(w):
                    y = next((y for y in range(h) if m[y][x]), None)
                    if y is not None: tops.append(y)
                if flat_cut(tops, h): flat.append((f["id"], t))
        self.assertEqual(flat, [])
        self.assertTrue(flat_cut([20] * 40, 100)); self.assertTrue(flat_cut([20] * 30 + [40, 45, 50, 60, 22, 21, 19, 30, 35, 20], 100))   # the detector catches a flat cut
        self.assertFalse(flat_cut([40 - abs(x - 20) for x in range(41)], 100))                                                          # and passes a shoulder line

    def test_at_least_25_accent_figures_each_with_a_cloth_mask_in_every_tier(self):
        reds = [f["id"] for f in self.index["figures"] if f["red_ok"]]
        self.assertGreaterEqual(len(reds), 25)
        self.assertLess(len(reds), 29)            # fewer than the largest accent count in the k=29 shape, so the masked figures still come round again
        ids = {p["id"] for p in self.index["pieces"]}
        for f in reds:
            for t in ("l", "m", "s"): self.assertIn(f"{f}.{t}.cloth", ids)

    def test_no_accent_mask_edge_has_a_long_straight_cut(self):
        """Inside the figure, every red_ok clothing mask's edge follows the engraving: no straight run longer than STRAIGHT_PX px at the
        largest tier (480 px high), decoded from the pack with the standard library."""
        by = {p["id"]: p for p in self.index["pieces"]}
        piece = lambda k: png_bits(self.bin[by[k]["offset"]:by[k]["offset"] + by[k]["len"]])
        long = {}
        for f in self.index["figures"]:
            if not f["red_ok"]: continue
            L = longest_straight(piece(f["id"] + ".l.cloth"), piece(f["id"] + ".l.sil"))
            if L > STRAIGHT_PX: long[f["id"]] = round(L, 1)
        self.assertEqual(long, {})
        sil = [[1] * 120 for _ in range(200)]
        box = [[1 if 40 <= y < 160 and 20 <= x < 100 else 0 for x in range(120)] for y in range(200)]
        self.assertGreater(longest_straight(box, sil), 100)                            # the detector catches a polygon side across the figure
        disc = [[1 if (y - 100) ** 2 + (x - 60) ** 2 < 45 ** 2 else 0 for x in range(120)] for y in range(200)]
        self.assertLess(longest_straight(disc, sil), STRAIGHT_PX)                       # and passes a curved edge
        self.assertEqual(longest_straight(box, box), 0)                                 # and ignores the figure's own outline
        fx = os.path.join(HERE, "fixtures", "collage_masks")                          # the 856579_1 mask of an earlier pack: a straight side along the jug,
        old = [png_bits(open(os.path.join(fx, f"856579_1-d75a305f.l.{k}.png"), "rb").read()) for k in ("cloth", "sil")]   # a flat step, a straight shoulder
        self.assertGreater(longest_straight(*old), 50)

    def test_the_pack_holds_no_local_path_or_non_english_text(self):
        for name in ("pack.json", "LICENSES.tsv", "draw.py"):
            self.assertNotRegex(text(os.path.join(COLLAGE, name)), r"/Users/|/private/|[^\x00-\x7f]", name)


if __name__ == "__main__":
    unittest.main()
