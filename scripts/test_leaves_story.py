#!/usr/bin/env python3
"""Self-test of the story page (runtime/leaves_py/story.py, the page recipe `page_story`): a long page of sections, built from the
seven page-story leaves' own test shapes (test values, ledger texts and words; layer 1 writes the real ones).
  - a story request of an EU energy shape: the thesis (a bare block), the one-axis answer (bare), four titled sections (the event
    chain, the path to the target, winners and losers, the pair bars) and the notes (bare), one drawn page: every digit sits in a
    marked ledger run, each chart a pub-visual module named and described, the sections in the request's order;
  - the page checks: a title with no ledger number refuses naming its section; one fact printed two ways refuses; a section
    naming no story leaf, a leaf drawn twice, a layer the page does not place, a kicker with a digit all refuse;
  - the recipe: story is bound to the has_target shape condition and eats an annual series with a target and an event chain; a
    World Bank one-economy multi-year shape has neither, so the recipe's table must not admit it (knobs.json read as data);
    its layers are the seven leaves and the page's layout holds no topic word.
With STORY_DIR set the page's html is kept there (for a screenshot).
Run: python3 -I -B scripts/test_leaves_story.py"""
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
RUN = os.path.join(LEAVES, "run.py")
sys.path.insert(0, HERE)
sys.path.insert(0, LEAVES)
import test_leaves_event_chain as EC  # noqa: E402
import test_leaves_gap_axis as GA  # noqa: E402
import test_leaves_pair_bars as PB  # noqa: E402
import test_leaves_risk_notes as RN  # noqa: E402
import test_leaves_target_path as TP  # noqa: E402
import test_leaves_thesis_claims as TC  # noqa: E402
import test_leaves_winners_losers as WL  # noqa: E402
import story  # noqa: E402

W = lambda t: [{"w": t}]


def merged():
    """Every leaf's ledger rows and names in one request (one src, one text: a clash is a test bug, raised)."""
    parts = [EC.SHAPES["eu"], GA.SHAPES["eu"], TP.SHAPES["eu"], WL.SHAPES["eu"]]
    rows = [r for p in parts for r in p[0]] + list(PB.EU_REQ) + RN.rows_of(RN.EU_LEDGER) + TC.rows_of(TC.EU_LEDGER)
    names = {}
    for p in (EC.SHAPES["eu"], GA.SHAPES["eu"], WL.SHAPES["eu"]): names.update(p[2])
    names.update(PB.EU_NAMES)
    seen, out = {}, []
    for r in rows:
        if r["src"] in seen:
            if seen[r["src"]] != r: raise AssertionError(f"two rows for {r['src']}: {seen[r['src']]} / {r}")
            continue
        seen[r["src"]] = r; out.append(r)
    return out, names


LEAVES_DATA = {"event_chain": EC.SHAPES["eu"][1], "gap_axis": GA.SHAPES["eu"][1], "target_path": TP.SHAPES["eu"][1],
               "winners_losers": WL.SHAPES["eu"][1], "pair_bars": PB.EU_DATA, "risk_notes": RN.EU_DATA, "thesis_claims": TC.EU_DATA}


def first_number(rows, *prefer):
    """A ledger fact with a digit the request holds (the first of `prefer`)."""
    have = {r["src"]: r["text"] for r in rows if "text" in r}
    for p in prefer:
        if p in have and re.search(r"\d", have[p]): return p
    raise AssertionError(f"none of {prefer} in the ledger")


def fresh():
    """The story's sections as a request lists them (titles are words; request() appends each one's ledger number)."""
    return [
        {"id": "thesis", "layer": "thesis_claims"},
        {"id": "axis", "layer": "gap_axis"},
        {"id": "chain", "layer": "event_chain", "kicker": "起因", "title": "俄气进口少了", "text": "先是气断了，价格跟着动。"},
        {"id": "path", "layer": "target_path", "kicker": "目标", "title": "离目标还差", "text": "照现在的速度走不到。"},
        {"id": "shift", "layer": "winners_losers", "kicker": "输赢", "title": "光伏装机涨到", "text": "有人快有人慢。"},
        {"id": "pairs", "layer": "pair_bars", "kicker": "差距", "title": "最好和最差的国家差", "text": "同一年的两端。"},
        {"id": "notes", "layer": "risk_notes"}]


def request(title_of=None, sections=None, kickers=None):
    """The story request's lines (size, each layer) and the page line's pieces; `title_of` overrides a section's title."""
    rows, names = merged()
    f = lambda *p: first_number(rows, *p)
    nums = {"event_chain": f("fact:cut_ru"), "target_path": f("fact:target_eu", "fact:gap_eu"), "winners_losers": f("fact:ratio_solar_add", "fact:cut_ru_gas"),
            "pair_bars": f("fact:ratio_ren_elc_se_mt.n")}
    spec_sections = fresh() if sections is None else sections
    segs = {"dek": [{"w": "可再生能源占比 "}, {"src": f("fact:ren_eu_2024")}]}
    for i, s in enumerate(spec_sections):
        if "title" not in s: continue
        src = title_of[s["id"]] if title_of and s["id"] in title_of else nums.get(s["layer"])
        if src is None: continue  # a title of words alone
        txt = rows_text(rows, src)
        s["title"] += txt
        segs[f"sections.{i}.title"] = [{"w": s["title"][:-len(txt)]}, {"src": src}]
    dek = "可再生能源占比 " + rows_text(rows, f("fact:ren_eu_2024"))
    spec = {"title": "新能源在顶替旧能源，但还差很远", "kicker": "能源观察", "dek": dek, "source": "欧盟统计局", "refs": [],
            "tables": {}, "facts": {}, "fmts": {"time": {}}, "sections": spec_sections,
            "hero": {"data": {}, "leaves": json.loads(json.dumps(LEAVES_DATA)), "style": {}}}
    knobs = {"spec": spec, "labels": names, "segs": segs}
    line = lambda **kv: json.dumps({"node": "page_story", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv}, ensure_ascii=False)
    return [line(phase="size")] + [line(layer=n) for n in story.STORY_LAYERS], spec_sections


def rows_text(rows, src):
    return next(r["text"] for r in rows if r["src"] == src)


def child(lines):
    out = subprocess.run([sys.executable, "-B", RUN], input="\n".join(lines) + "\n", capture_output=True, text=True, check=True, cwd=ROOT).stdout
    return [json.loads(l) for l in out.splitlines()]


def page(**kw):
    """(html or None, refusals) of the story page; `edit(layers)` may change the drawn layers before the page line."""
    edit = kw.pop("edit", None)
    lines, secs = request(**kw)
    got = child(lines)
    size, pics = got[0], got[1:]
    bad = [p for p in [size] + pics if "refused" in p or "error" in p]
    if bad: return None, [bad[0].get("refused") or bad[0]]
    layers = {n: p.get("svg") or p.get("html") for n, p in zip(story.STORY_LAYERS, pics)}
    if edit: edit(layers)
    last = child(lines + [json.dumps({"phase": "page", "layers": layers, "sizes": {}}, ensure_ascii=False)])[-1]
    return last.get("html"), last.get("refused")


class Story(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html, why = page()
        assert cls.html, why
        if os.environ.get("STORY_DIR"):
            os.makedirs(os.environ["STORY_DIR"], exist_ok=True)
            with open(os.path.join(os.environ["STORY_DIR"], "story-eu.html"), "w", encoding="utf-8") as f: f.write(cls.html)

    def test_every_digit_is_a_marked_ledger_run(self):
        body = re.sub(r"<style>.*?</style>|<title>.*?</title>", "", self.html, flags=re.S)
        body = re.sub(r"<(span|tspan)[^>]*data-src=[^>]*>[^<]*</\1>", "", body)
        text = re.sub(r"<[^>]+>", "", body)
        left = re.findall(r".{0,12}\d.{0,12}", text)
        # the one digit the titles write on their own is the year in a worded title's words ("2019 年的"): refused by worded, so none here
        self.assertEqual(left, [])

    def test_sections_in_the_requests_order(self):
        ids = re.findall(r'<section class="sec" data-id="([a-z_]+)"', self.html)
        self.assertEqual(ids, ["thesis", "axis", "chain", "path", "shift", "pairs", "notes"])
        self.assertEqual(len(re.findall(r"<h2 data-section=", self.html)), 4)

    def test_each_chart_is_a_module_named_and_described(self):
        mods = re.findall(r'<div class="fig pub-visual" data-module-id="([a-z_]+)"', self.html)
        self.assertEqual(mods, ["axis", "chain", "path", "shift", "pairs"])  # the thesis and the notes are text blocks
        for sid in mods:
            self.assertRegex(self.html, rf'<svg[^>]*pub-chart[^>]*aria-describedby="desc-{sid}"')
            self.assertIn(f'<p id="desc-{sid}" hidden>', self.html)

    def test_the_text_blocks_run_the_pages_whole_width(self):
        for layer in ("thesis_claims", "risk_notes"):
            m = re.search(rf'<svg class="{layer}" viewBox="0 0 ([0-9.]+) ', self.html)
            self.assertIsNotNone(m, layer)
            self.assertEqual(float(m.group(1)), story.PAGE_W, layer)
        # the request's own width knob does not narrow them (the page's width is set over the request's style)
        lines, _ = request()
        wide = [json.dumps({**(d := json.loads(l)), "knobs": {**d["knobs"], "spec": {**d["knobs"]["spec"], "hero": {
            **d["knobs"]["spec"]["hero"], "style": {"thesis_claims": {"width": 500}}}}}}, ensure_ascii=False) for l in lines]
        got = child(wide)
        layers = {n: g.get("svg") for n, g in zip(story.STORY_LAYERS, got[1:])}
        last = child(wide + [json.dumps({"phase": "page", "layers": layers, "sizes": {}}, ensure_ascii=False)])[-1]
        self.assertIn("html", last, last)
        self.assertRegex(last["html"], rf'<svg class="thesis_claims" viewBox="0 0 {story.PAGE_W} ')

    def test_every_titled_section_prints_a_ledger_number(self):
        for h2 in re.findall(r"<h2 data-section=\"[a-z_]+\">(.*?)</h2>", self.html):
            self.assertRegex(h2, r'data-src="(fact|series|record):')

    def test_the_title_test_refuses_a_title_of_words_alone(self):
        html, why = page(title_of={"chain": None})
        self.assertIsNone(html)
        self.assertIn("title test", why[0]); self.assertIn("chain", why[0])

    def test_one_fact_one_writing(self):
        def edit(layers):
            svg = layers["event_chain"]
            m = re.search(r'(<tspan[^>]*data-src="fact:cut_ru"[^>]*>)([^<]*)(</tspan>)', svg)
            self.assertIsNotNone(m)
            layers["event_chain"] = svg.replace(m.group(0), m.group(1) + m.group(2) + " " + m.group(3), 1)
        html, why = page(edit=edit)
        self.assertIsNone(html)
        self.assertIn("one fact, one writing", why[0]); self.assertIn("fact:cut_ru", why[0])

    def test_its_rules(self):
        cp = fresh
        def refused(secs, want, **kw):
            html, why = page(sections=secs, **kw)
            self.assertIsNone(html); self.assertIn(want, str(why))
        s = cp(); s[2]["layer"] = "bars"; refused(s, "names the layer")
        s = cp(); s[3]["layer"] = "event_chain"; refused(s, "drawn by two sections")
        s = cp(); s[2]["id"] = "Chain"; refused(s, "is no code")
        s = cp(); s[3]["id"] = "chain"; refused(s, "comes twice")
        s = cp(); s[2]["kicker"] = "第 2 步"; refused(s, "kicker with a digit")
        s = cp(); s[0]["kicker"] = "只有题"; refused(s, "no title")
        refused([], "no sections")
        s = cp()[:-1]; refused(s, "no layer the story lists")  # the notes leaf is drawn but no section places it

    def test_the_recipe_wants_a_target(self):
        with open(os.path.join(LEAVES, "knobs.json"), encoding="utf-8") as f: rec = {r["name"]: r for r in json.load(f)["recipes"]}["page_story"]
        self.assertEqual(rec["layers"], story.STORY_LAYERS)
        # the shape a World Bank one-economy multi-year request has (annual, two years or more, one place, one unit, a last year,
        # two ends) lacks a target: the recipe's last condition is the one it fails, so the recipe is not chosen for it
        self.assertEqual(rec["eats"][-1], "has_target")
        self.assertEqual(rec["relation"], "Change")
        with open(os.path.join(LEAVES, "knobs.json"), encoding="utf-8") as f: order = [r["name"] for r in json.load(f)["recipes"]]
        self.assertLess(order.index("page_story"), order.index("one_line"))  # placed before the plainer line page

    def test_story_py_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "story.py"), encoding="utf-8") as f: src = f.read()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src.lower(), w)


if __name__ == "__main__":
    unittest.main()
