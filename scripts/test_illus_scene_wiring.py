"""The scene renderer's wiring in the opening picture's child (runtime/illus_hero/run_hero.py build_scene, node.json topics.scene_renderer): the child,
not the node, decides who is lit. Two subject shapes: a rule (27 members, those above the mean lit: the tally's own recount, a declared count that
is not the rows' refused) and a proportion (N figures, K = N x share half to even: 8 x 0.284 -> 2, 10 x 0.25 -> 2, 10 x 0.35 -> 4; a declared count or
total that is not the recomputed one refused); each in the three styles; an unknown style or scene refused; the style and scene knobs refused on another
renderer; a node reply whose lit or total is not the asked one refused; no node on PATH, a node that fails or one that is too slow `unavailable`; the reply
has the other paths' shape and passes the hero grammar (a mirror of next_leaf.rs hero_faults). The node is a stub with the same contract
(scripts/fixtures/illus_scene/scene_stub.mjs); when runtime/illus_hero/scene/scene.mjs exists, RealNode runs the same requests through it.
Run: python3 -I -B scripts/test_illus_scene_wiring.py"""
import io
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
sys.path.insert(0, HERE)
import run_hero as R  # noqa: E402
from test_illus_people import hero_grammar_faults  # noqa: E402

STUB = os.path.join(HERE, "fixtures", "illus_scene", "scene_stub.mjs")
REAL = os.path.join(ROOT, "runtime", "illus_hero", "scene", "scene.mjs")
STYLES = ["ink", "iso", "geo"]
# 27 EU-like unemployment rates (made-up values in the range of the 2023 figures), the mean the line, those above it lit
RATES = [5.9, 4.4, 4.3, 5.1, 3.0, 6.4, 4.4, 11.1, 12.2, 7.4, 6.1, 7.6, 6.1, 6.5, 6.9, 5.2, 4.1, 3.5, 3.6, 5.1, 2.8, 6.5, 5.6, 3.7, 3.5, 7.2, 7.7]
CODES = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]
MEAN = round(sum(RATES) / len(RATES), 9)
ABOVE = sum(1 for v in RATES if v > MEAN)


def rule_req(**extra):
    sub = {"members": [{"code": c, "value": v} for c, v in zip(CODES, RATES)], "rule": {"op": "gt", "ref": MEAN}, "declared": {"count": ABOVE, "total": 27}}
    return {"family": "unemployment", "lead": "members", "width": 1140, "ground": "warm", "accent": "#b8433a", "subject": sub, **extra}


def prop_req(share, n, count, total=None, **extra):
    return {"family": "unemployment", "width": 1140, "subject": {"proportion": {"share": share, "figures": n}, "declared": {"count": count, "total": n if total is None else total}}, **extra}


def styled(r, style): return {**r, "composition": {**r.get("composition", {}), "style": style}}


class Script:
    """Point the child at another node script (the stub or the real one) for the duration."""
    def __init__(self, path): self.path = path
    def __enter__(self): self.was = R.SR["script"]; R.SR["script"] = self.path     # an absolute path: os.path.join keeps it
    def __exit__(self, *a): R.SR["script"] = self.was


def serve(inp):
    old = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(json.dumps(inp) + "\n"), io.StringIO()
    try: R.serve(); return json.loads(sys.stdout.getvalue())
    finally: sys.stdin, sys.stdout = old


def lit_in(svg, accent):
    return len(re.findall(rf'fill="{accent}"', svg))


class Wiring(unittest.TestCase):
    def setUp(self): self.s = Script(STUB); self.s.__enter__()
    def tearDown(self): self.s.__exit__()

    def test_the_rule_shape_lights_the_members_above_the_mean_in_each_style(self):
        self.assertEqual((ABOVE, len(RATES)), (13, 27))
        self.assertEqual(R.renderer_of(rule_req()), "scene")
        for st in STYLES:
            svg, w, h, secs, name, comp = R.build_scene(styled(rule_req(), st))
            self.assertEqual((comp["lit"], comp["objects"], comp["style"], name), (ABOVE, 27, st, "people.tally"), st)
            self.assertEqual(lit_in(svg, "#b8433a"), ABOVE, st); self.assertEqual(w, 1140.0); self.assertEqual(hero_grammar_faults(svg), [], st)
        self.assertEqual(R.build_scene(rule_req())[5]["style"], "ink")      # the people topic's own style

    def test_the_rule_shapes_declared_count_must_be_the_rows(self):
        bad = rule_req(); bad["subject"]["declared"]["count"] = ABOVE + 1
        with self.assertRaisesRegex(R.Refused, f"declared.count {ABOVE + 1} is not the {ABOVE}"): R.build_scene(bad)
        self.assertIn("refused", serve(bad))

    def test_the_proportion_shape_rounds_half_to_even(self):
        for share, n, k in ((0.284, 8, 2), (0.25, 10, 2), (0.35, 10, 4), (0.15, 10, 2), (0.5, 1, 0), (1, 6, 6)):
            self.assertEqual(sum(R.proportion_flags({"proportion": {"share": share, "figures": n}, "declared": {"count": k, "total": n}})), k, (share, n))
        for st in STYLES:
            for share, n, k in ((0.284, 8, 2), (0.25, 10, 2)):
                svg, w, h, secs, name, comp = R.build_scene(styled(prop_req(share, n, k), st))
                self.assertEqual((comp["lit"], comp["objects"], comp["style"], name), (k, n, st, "people.proportion"), (st, share))
                self.assertEqual(lit_in(svg, "#b8433a"), k); self.assertEqual(hero_grammar_faults(svg), [])

    def test_a_proportion_whose_declared_count_or_total_is_not_recomputed_is_refused(self):
        with self.assertRaisesRegex(R.Refused, "declared.count 3 is not the 2 of 10"): R.build_scene(prop_req(0.25, 10, 3))
        with self.assertRaisesRegex(R.Refused, "declared.total 9 is not the 10"): R.build_scene(prop_req(0.25, 10, 2, total=9))
        with self.assertRaisesRegex(R.Refused, "declared count and total"): R.build_scene({**prop_req(0.25, 10, 2), "subject": {"proportion": {"share": 0.25, "figures": 10}}})
        for share, n in ((1.2, 10), (-0.1, 10), ("0.3", 10), (0.3, 0), (0.3, 61), (0.3, 2.5), (0.3, True)):
            with self.assertRaises(R.Refused, msg=(share, n)): R.build_scene(prop_req(share, n, 0))
        self.assertEqual(list(serve(prop_req(0.25, 10, 3))), ["refused"])
        self.assertEqual(R.renderer_of(prop_req(0.25, 10, 2, family="co2")), "scene")    # no other renderer draws a proportion

    def test_unknown_style_or_scene_is_refused_and_the_knobs_are_the_scene_renderers_only(self):
        with self.assertRaisesRegex(R.Refused, "style 'pastel'"): R.build_scene(styled(rule_req(), "pastel"))
        with self.assertRaisesRegex(R.Refused, "scene 'door'"): R.build_scene({**rule_req(), "composition": {"scene": "door"}})
        with self.assertRaisesRegex(R.Refused, "unknown composition knob mood"): R.build_scene({**rule_req(), "composition": {"mood": 1}})
        energy = {"family": "renewable_share", "lead": "members", "width": 1140, "subject": rule_req()["subject"], "composition": {"style": "ink"}}
        with self.assertRaisesRegex(R.Refused, "only the scene renderer has it"): R.resolve(energy, renderer="line")
        with self.assertRaisesRegex(R.Refused, "only the scene renderer has it"): R.validate({"tags": ["wind"], "hero": "wind", "composition": {"scene": "queue"}})

    def test_a_node_that_miscounts_or_refuses_is_refused(self):
        with self.assertRaisesRegex(R.Refused, "drew 14 lit of 27, asked 13 of 27"): R.build_scene({**rule_req(), "composition": {"seed": 666}})
        with self.assertRaisesRegex(R.Refused, "seed"): R.build_scene({**rule_req(), "composition": {"seed": 1.5}})

    def test_no_node_a_failing_node_or_a_slow_one_is_unavailable(self):
        path = os.environ.get("PATH", "")
        os.environ["PATH"] = "/nonexistent"
        try:
            with self.assertRaisesRegex(R.Unavailable, "node is not installed"): R.build_scene(rule_req())
            self.assertEqual(list(serve(rule_req())), ["unavailable"])
        finally: os.environ["PATH"] = path
        with Script("/nonexistent/scene.mjs"), self.assertRaisesRegex(R.Unavailable, "failed"): R.build_scene(rule_req())
        was = R.SR["deadline"]; R.SR["deadline"] = 0.001
        try:
            with self.assertRaisesRegex(R.Unavailable, "took longer"): R.build_scene(rule_req())
        finally: R.SR["deadline"] = was

    def test_the_reply_has_the_other_paths_shape(self):
        r = serve(rule_req())
        self.assertEqual(sorted(r), ["composition", "dropped", "h", "omitted", "omitted_label_key", "scene", "seconds", "svg", "w"])
        self.assertTrue(r["svg"].startswith('<g transform="scale(0.79167)">')); self.assertEqual((r["w"], r["h"], r["dropped"], r["omitted"]), (1140.0, 443.33, [], 0))
        self.assertEqual(hero_grammar_faults(r["svg"]), [])

    def test_the_people_topics_other_layouts_keep_the_people_renderer_and_other_topics_their_own(self):
        ms = rule_req()["subject"]["members"]
        for lead in ("rank", "ends", "spread"): self.assertEqual(R.renderer_of({"family": "unemployment", "lead": lead, "subject": {"members": ms}}), "scene", lead)
        self.assertEqual(R.renderer_of({"family": "unemployment", "lead": "path", "subject": {"path": {}}}), "people")
        self.assertEqual(R.renderer_of({"family": "unemployment", "lead": "pace", "subject": {"series": []}}), "people")
        self.assertEqual(R.renderer_of({"family": "unemployment", "lead": "groups", "subject": {"groups": []}}), "people")
        self.assertEqual(R.renderer_of({"family": "renewable_share", "lead": "members", "subject": rule_req()["subject"]}), "line")
        self.assertEqual(R.renderer_of({"family": "co2", "lead": "members", "subject": rule_req()["subject"]}), "3d")
        self.assertEqual(R.renderer_of({"family": "asylum", "lead": "members", "subject": rule_req()["subject"]}), "3d")
        with self.assertRaises(R.Unavailable): R.build_scene({**rule_req(), "lead": "path"})
        self.assertEqual({t: s["style"] for t, s in R.TOPICS["scenes"].items()}, {"energy": "iso", "emissions": "iso", "people": "ink", "trade": "geo", "migration": "ink", "tech": "iso", "neutral": "ink"})

    def test_economy_tallies_and_rankings_are_geo_scenes_and_their_paths_keep_3d(self):
        sub = rule_req()["subject"]
        for fam, style in (("gdp_pc", "geo"), ("gdp", "geo"), ("energy_imports", "geo")):
            r = {**rule_req(), "family": fam}
            self.assertEqual(R.renderer_of(r), "scene", fam)
            svg, w, h, secs, name, comp = R.build_scene(r)
            self.assertEqual((comp["style"], comp["lit"], comp["objects"]), (style, ABOVE, 27), fam)
            self.assertEqual(R.renderer_of({"family": fam, "lead": "rank", "subject": {"members": sub["members"]}}), "scene", fam)
            self.assertEqual(R.renderer_of({"family": fam, "lead": "path", "subject": {"path": {}}}), "3d", fam)     # path, series, groups: renderer_else
        self.assertNotIn("tech", R.TOPICS["families"].values()); self.assertEqual(R.TOPICS["scenes"]["tech"]["renderer"], "scene"); self.assertEqual(R.topic_of(None), "neutral")   # tech: inert until a family maps to it
        self.assertEqual(R.TOPICS["scenes"]["neutral"]["style"], "ink")


def rank_req(lead="rank", n=27, **extra):
    return {"family": "unemployment", "lead": lead, "width": 1140, "accent": "#b8433a", "subject": {"members": [{"code": c, "value": v} for c, v in zip(CODES[:n], RATES[:n])]}, **extra}


def sequence(svg):
    """The stub's figures in drawing order: L lit, u unlit, G the gap marker."""
    return "".join("G" if 'stroke-width="1"' in p else "L" if 'fill="#b8433a"' in p else "u" for p in re.findall(r"<path [^>]*>", svg))


class Captured:
    """Keep the requests the child sends to the node."""
    def __enter__(self):
        self.sent = []; self.was = R.ask_child
        def ask(cmd, request, deadline): self.sent.append(request); return self.was(cmd, request, deadline)
        R.ask_child = ask; return self
    def __exit__(self, *a): R.ask_child = self.was


class RankAndEnds(unittest.TestCase):
    """Rank and ends leads on the scene renderer (stub node): the members highest first, rank lighting the highest, ends the highest and the
    lowest, each at its own place; 27 members fold to 6 + a gap + 6 with 15 omitted; 8 members fold nothing."""
    def setUp(self): self.s = Script(STUB); self.s.__enter__()
    def tearDown(self): self.s.__exit__()

    def test_rank_lights_the_highest_at_the_head_and_folds_the_middle_in_each_style(self):
        top = max(zip(RATES, CODES))[1]
        for st in STYLES:
            with Captured() as cap: svg, w, h, secs, name, comp = R.build_scene(styled(rank_req(), st))
            self.assertEqual(sequence(svg), "L" + "u" * 5 + "G" + "u" * 6, st)
            self.assertEqual((name, comp["lit"], comp["objects"], comp["omitted"], comp["style"]), ("people.rank", 1, 12, 15, st))
            self.assertEqual(cap.sent[0]["order"], "given"); self.assertEqual(sum(1 for f in cap.sent[0]["figures"] if f.get("gap")), 1)
        self.assertEqual(top, "EL")
        three = {"members": [{"code": "A", "value": 1.0}, {"code": "B", "value": 5.0}, {"code": "C", "value": 3.0}, {"code": "D", "value": 3.0}]}
        self.assertEqual(R.ranked_items(three, "rank"), ([{"lit": True}, {"lit": False}, {"lit": False}, {"lit": False}], 0))     # B first, C before D (ties by code)
        self.assertEqual(R.ranked_items({**three, "members": three["members"] + [{"code": "E", "value": 5.0, "flag": False}]}, "rank")[0][0], {"lit": True})   # B and E tie: B (by code) is lit
        svg = R.build_scene(rank_req(n=8))[0]; self.assertEqual(sequence(svg), "L" + "u" * 7)
        self.assertEqual(R.build_scene(rank_req(n=8))[5]["omitted"], 0)

    def test_ends_light_both_ends_in_each_style(self):
        for lead in ("ends", "spread"):
            for st in STYLES:
                svg, w, h, secs, name, comp = R.build_scene(styled(rank_req(lead), st))
                self.assertEqual(sequence(svg), "L" + "u" * 5 + "G" + "u" * 5 + "L", (lead, st))
                self.assertEqual((name, comp["lit"], comp["objects"], comp["omitted"]), ("people.pair", 2, 12, 15))
        self.assertEqual(sequence(R.build_scene(rank_req("ends", n=8))[0]), "L" + "u" * 6 + "L")
        self.assertEqual(sequence(R.build_scene({**rank_req(), "composition": {"reading_order": "right_to_left"}})[0]), "u" * 6 + "G" + "u" * 5 + "L")

    def test_a_declared_count_total_or_flag_that_is_not_the_rows_is_refused(self):
        bad = rank_req(); bad["subject"]["declared"] = {"count": 2}
        with self.assertRaisesRegex(R.Refused, "declared.count 2 is not the 1"): R.build_scene(bad)
        bad = rank_req("ends"); bad["subject"]["declared"] = {"count": 2, "total": 26}
        with self.assertRaisesRegex(R.Refused, "declared.total 26 is not the 27"): R.build_scene(bad)
        bad = rank_req(); bad["subject"]["members"][0]["flag"] = True      # AT is not the highest
        with self.assertRaisesRegex(R.Refused, "flag of AT"): R.build_scene(bad)
        flat = rank_req("ends", n=4); [m.update(value=1.0) for m in flat["subject"]["members"]]
        with self.assertRaisesRegex(R.Refused, "highest above the lowest"): R.build_scene(flat)
        self.assertEqual(list(serve({**bad})), ["refused"])

    def test_the_reply_carries_omitted_as_the_rank_layout_does_and_a_wrong_gap_count_is_refused(self):
        r = serve(rank_req())
        self.assertEqual((r["omitted"], r["omitted_label_key"], r["composition"]["omitted"]), (15, R.TOPICS["omitted"]["label_key"], 15))
        was = R.ask_child
        def lying(cmd, request, deadline): rep, s_ = was(cmd, request, deadline); rep["gaps"] = 0; return rep, s_
        R.ask_child = lying
        try:
            with self.assertRaisesRegex(R.Refused, "0 gaps, asked 1"): R.build_scene(rank_req())
        finally: R.ask_child = was

    def test_the_tally_request_is_unchanged(self):
        with Captured() as cap: R.build_scene(rule_req())
        self.assertNotIn("order", cap.sent[0]); self.assertEqual(sorted(cap.sent[0]), ["box", "figures", "palette", "scene", "seed", "style"])
        self.assertTrue(all(set(f) == {"lit"} for f in cap.sent[0]["figures"])); self.assertEqual(len(cap.sent[0]["figures"]), 27)


class SceneChoice(unittest.TestCase):
    """Which scene a request draws, by its data's shape (node.json topics.scene_renderer.scene_choice, first rule wins, default queue), and the
    scene knob's override refused where the scene cannot draw the data (scene_renderer.draws). Stub node."""
    def setUp(self): self.s = Script(STUB); self.s.__enter__()
    def tearDown(self): self.s.__exit__()

    def drawn(self, r):
        with Captured() as cap: svg, w, h, secs, name, comp = R.build_scene(r)
        self.assertEqual(comp["scene_layout"], cap.sent[0]["scene"])
        return cap.sent[0], comp

    def test_proportions_go_to_door_or_grid_and_the_rest_to_queue(self):
        for r, scene, k, n in ((prop_req(0.3, 30, 9), "grid", 9, 30), (styled(prop_req(0.284, 8, 2), "geo"), "door", 2, 8), (styled(prop_req(0.284, 8, 2), "ink"), "grid", 2, 8),
                               (styled(prop_req(0.25, 12, 3), "geo"), "grid", 3, 12), (styled(prop_req(0.5, 10, 5), "geo"), "door", 5, 10)):
            sent, comp = self.drawn(r)
            self.assertEqual((sent["scene"], comp["lit"], comp["objects"]), (scene, k, n), r["subject"])
            self.assertEqual([f["lit"] for f in sent["figures"]], [True] * k + [False] * (n - k)); self.assertNotIn("order", sent)     # the recomputed flags, lit first
        for r in (styled(rule_req(), "geo"), styled(rank_req(), "geo"), styled(rank_req("ends"), "geo"), rank_req(n=8)):
            self.assertEqual(self.drawn(r)[0]["scene"], "queue", r["lead"])

    def test_the_scene_knob_overrides_only_where_the_scene_can_draw_the_data(self):
        over = lambda r, sc: {**r, "composition": {**r.get("composition", {}), "scene": sc}}
        self.assertEqual(self.drawn(over(prop_req(0.3, 30, 9), "queue"))[0]["scene"], "queue")
        self.assertEqual(self.drawn(over(rule_req(), "grid"))[0]["scene"], "grid")
        self.assertEqual(self.drawn(over(styled(prop_req(0.25, 8, 2), "geo"), "grid"))[0]["scene"], "grid")
        for r, sc, why in ((over(prop_req(0.284, 8, 2), "door"), "door", "ink style"), (over(styled(prop_req(0.25, 12, 3), "geo"), "door"), "door", "12 figures"),
                           (over(rank_req(), "grid"), "grid", "a rank"), (over(rank_req("ends"), "door"), "door", "a pair"), (over(rule_req(), "door"), "door", "27 figures")):
            with self.assertRaisesRegex(R.Refused, f"scene '{sc}' cannot draw", msg=why): R.build_scene(r)
        with self.assertRaisesRegex(R.Refused, "scene 'stage' is none of queue|grid|door"): R.build_scene(over(rule_req(), "stage"))

    def test_a_declared_mismatch_is_refused_before_any_scene(self):
        with self.assertRaisesRegex(R.Refused, "declared.count 3 is not the 2 of 8"): R.build_scene(styled(prop_req(0.284, 8, 3), "geo"))
        with self.assertRaisesRegex(R.Refused, "declared.count 10 is not the 9 of 30"): R.build_scene(prop_req(0.3, 30, 10))

    def test_the_rule_table_is_data(self):
        self.assertEqual([(r["when"], r["scene"]) for r in R.SR["scene_choice"]], [({"form": "proportion", "style": "geo", "n_max": 10}, "door"), ({"form": "proportion"}, "grid")])
        self.assertEqual(R.SR["scene_default"], "queue"); self.assertEqual(R.REG["composition_knobs"]["scene"]["values"], ["queue", "grid", "door"])


def real_scenes():
    try: t = open(REAL, encoding="utf-8").read()
    except OSError: return False
    return re.search(r"\bgrid\s*:", t) is not None and re.search(r"\bdoor\s*:", t) is not None


def real_given():
    try: return "given" in open(REAL, encoding="utf-8").read()
    except OSError: return False


@unittest.skipUnless(os.path.isfile(REAL), "runtime/illus_hero/scene/scene.mjs is not there yet")
class RealNode(unittest.TestCase):
    """The same requests through the real scene node: the child's recount holds and the picture holds only the elements hero_faults takes
    (the full gate runs on the real reply in src/next_leaf.rs a_scene_hero_passes_the_hero_gate)."""

    def test_both_shapes_in_each_style(self):
        gate = {"g", "path", "image", "defs", "linearGradient", "stop", "mask"}
        for st in STYLES:
            for r, k, n in ((rule_req(), ABOVE, 27), (prop_req(0.284, 8, 2), 2, 8), (prop_req(0.25, 10, 2), 2, 10)):
                if "proportion" in r["subject"] and not real_scenes(): r = {**r, "composition": {"scene": "queue"}}     # until the node has grid and door
                svg, w, h, secs, name, comp = R.build_scene(styled(r, st))
                self.assertEqual((comp["lit"], comp["objects"]), (k, n), st); self.assertEqual(w, 1140.0)
                self.assertLessEqual(set(re.findall(r"<([A-Za-z]+)", svg)), gate, (st, name)); self.assertIsNone(re.search(r">[^<\s]", svg), (st, name))
                for v in re.findall(r'(?:fill|stroke|stop-color)="([^"]*)"', svg): self.assertRegex(v, r"^(#[0-9a-fA-F]{6}|none|url\(#[\w-]+\))$", (st, name))
                self.assertLess(len(svg), 4 * 1024 * 1024)

    @unittest.skipUnless(real_scenes(), "scene.mjs has no grid and door scenes yet")
    def test_grid_and_door(self):
        for r, scene, k, n in ((prop_req(0.3, 30, 9), "grid", 9, 30), (styled(prop_req(0.284, 8, 2), "geo"), "door", 2, 8), (styled(prop_req(0.284, 8, 2), "ink"), "grid", 2, 8)):
            svg, w, h, secs, name, comp = R.build_scene(r)
            self.assertEqual((comp["scene_layout"], comp["lit"], comp["objects"]), (scene, k, n)); self.assertIsNone(re.search(r">[^<\s]", svg))

    @unittest.skipUnless(real_given(), "scene.mjs has no order: given mode yet")
    def test_rank_and_ends_in_each_style(self):
        for st in STYLES:
            for r, k, n, om in ((rank_req(), 1, 12, 15), (rank_req("ends"), 2, 12, 15), (rank_req(n=8), 1, 8, 0)):
                svg, w, h, secs, name, comp = R.build_scene(styled(r, st))
                self.assertEqual((comp["lit"], comp["objects"], comp["omitted"]), (k, n, om), (st, name)); self.assertIsNone(re.search(r">[^<\s]", svg))


if __name__ == "__main__":
    unittest.main()
