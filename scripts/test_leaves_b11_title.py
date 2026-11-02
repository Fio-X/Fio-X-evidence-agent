#!/usr/bin/env python3
"""B11: the flow page's title, as the leaf child (runtime/leaves_py/run.py) makes it from the text step's title and the page
line's claim_words (the visual group's check vocabulary, src/next_ledger.rs CLAIM_WORDS, read here from that file):
  - a title that names one node of the picture (a node claim, max over its fact's family) or one source and one target (a
    flow claim, its row the max of every row of its table and time) and whose other words hold a max word, a verb of a
    conclusion and no off word is the h1, marked data-claim, each name marked by its name row; the finding with its numbers
    (display part, fact:<k>.r, where the ledger holds one) goes to the dek;
  - any other title (a false claim, a wrong set, two names of one side, a merged node or member, a negation, a trend, an
    off word, no max word, a label, a placeholder) falls back to the finding's headline, exactly as with no claim_words.
Two data shapes: q2's (Eurostat nrg_bal_s, DE 2024, KTOE, scripts/fixtures/data_prepare/nrg_bal_s_DE_2024.tsv: fuels to
sectors, both sides merged) and a small test-only one (fuel groups to three countries, GWH, no merged node, no display part).
24 titles, each drawn (never refused), with the verdict it must get."""
import json, os, re, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUN = os.path.join(ROOT, "runtime", "leaves_py", "run.py")
FIX = os.path.join(HERE, "fixtures", "data_prepare", "nrg_bal_s_DE_2024.tsv")


def claim_words():
    """CLAIM_WORDS as next_ledger.rs declares them (the one source both the check and the leaf read)."""
    with open(os.path.join(ROOT, "src", "next_ledger.rs"), encoding="utf-8") as f:
        src = f.read()
    block = src[src.index("pub const CLAIM_WORDS"):]
    block = block[:block.index("];") + 2]
    out = {}
    for kind, body in re.findall(r'\(\s*"(\w+)",\s*&\[(.*?)\],?\s*\)', block, re.S):
        out[kind] = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
    assert set(out) == {"max", "off", "verb"} and all(out.values()), out
    return out


def display(x, dec):
    """The display part's text (next_facts.rs display): three significant digits, never more places than the format's;
    None when that is the format's own places."""
    whole = len(str(int(abs(x)))) if abs(x) >= 1 else 0
    p = min(dec, max(0, 3 - whole))
    return f"{x:,.{p}f}" if p < dec else None


NAMES_Q2 = {"siec": {"O4000XBIO": "石油", "G3000": "天然气", "E7000": "电力", "RA000": "可再生能源", "H8000": "热力",
                     "C0000X0350-0370": "固体燃料", "C0350-0370": "人造气", "W6100_6220": "不可再生废物", "P1000": "泥炭",
                     "S2000": "油页岩"},
            "nrg_bal": {"FC_IND_E": "工业", "FC_TRA_E": "交通运输", "FC_OTH_CP_E": "商业公服", "FC_OTH_HH_E": "家庭",
                        "FC_OTH_AF_E": "农林业", "FC_OTH_FISH_E": "渔业", "FC_OTH_NSP_E": "其他未列明"}}
OTHER = {"siec": ["C0000X0350-0370", "C0350-0370", "W6100_6220"], "nrg_bal": ["FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"]}


def lines_for(table, dims, rows, defs, fmt, names, kinds, other, unit_src, unit_text, header):
    """The size and layer lines of a flow page (as the visual group sends them): rows (series rows and the ledger), the spec
    with its fact definitions and formats, the sankey's data."""
    (sd, td), dec = dims, fmt[1]["dec"]
    value = {k: sum(r["value"] for r in rows if all(r["dims"].get(d) in (c if isinstance(c, list) else [c]) for d, c in q["filter"].items()))
             for k, q in defs.items()}
    ledger = {}
    for k, v in value.items():
        ledger[f"fact:{k}.n"] = f"{v:,.{dec}f}"; ledger[f"fact:{k}"] = f"{v:,.{dec}f}{fmt[1]['suffix']}"
        r = display(v, dec)
        if r is not None: ledger[f"fact:{k}.r"] = r
    for kind, codes in names.items():
        for c, nm in codes.items(): ledger[f"name:zh_names:{kind}:{c}" if kinds.get(kind) != "place" else f"name:zh_names:iso2:{c}"] = nm
    ledger[unit_src] = unit_text
    flows = [r for r in rows if r["value"] != 0.0]
    node = {}
    for k, q in defs.items():
        code = list(q["filter"].values())[0]
        if isinstance(code, str): node[code] = f"fact:{k}.n"
    data = {"title": [{"w": "从来源到去向"}], "unit": [{"src": unit_src}], "source_kind": kinds[sd], "target_kind": kinds[td],
            "flows": [{"source": r["dims"][sd], "target": r["dims"][td], "value": r["src"]} for r in flows], "node_text": node}
    for side, dim, key in (("source", sd, "from_other"), ("target", td, "to_other")):
        if other.get(dim):
            data[f"other_{side}"] = {"name": [{"w": "其他" + ("来源" if side == "source" else "去向")}], "members": other[dim],
                                     "value_text": f"fact:{key}.n", "members_head": [{"w": "包括："}]}
    spec = {**header, "source": table, "refs": [table], "tables": {table: {"id": table}}, "facts": defs, "fmts": {fmt[0]: fmt[1], "time": {}},
            "hero": {"data": {"table": table, "year": "2024"}, "leaves": {"sankey": data}}}
    labels = {c: nm for codes in names.values() for c, nm in codes.items()}
    lrows = rows + [{"src": s, "text": t} for s, t in ledger.items()] + [{"src": f"period:{table}:2024", "text": "2024"}]
    knobs = {"spec": spec, "labels": labels}
    line = lambda **kv: json.dumps({"node": "flow", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": lrows, "knobs": knobs, **kv}, ensure_ascii=False)
    return [line(phase="size"), line(layer="sankey")], ledger


def q2(header):
    rows = []
    with open(FIX, encoding="utf-8") as f:
        text = f.read().splitlines(keepends=True)
    for l in text:
        if l.startswith("#") or l.startswith("nrg_bal\t"): continue
        bal, siec, v = l.rstrip("\n").split("\t")
        if bal in NAMES_Q2["nrg_bal"] and siec in NAMES_Q2["siec"]:
            rows.append({"src": f"series:nrg_bal_s/A.{bal}.{siec}.KTOE.DE:2024:OBS_VALUE", "table": "nrg_bal_s", "time": "2024", "value": float(v),
                         "dims": {"freq": "A", "nrg_bal": bal, "siec": siec, "unit": "KTOE", "geo": "DE"}})
    q = lambda dim, code: {"op": "value", "table": "nrg_bal_s", "time": "2024", "fmt": "ktoe", "filter": {dim: code}}
    defs = {**{f"from.{c}": q("siec", c) for c in ["E7000", "G3000", "H8000", "O4000XBIO", "RA000"]}, "from_other": q("siec", OTHER["siec"]),
            **{f"to.{c}": q("nrg_bal", c) for c in ["FC_IND_E", "FC_OTH_CP_E", "FC_OTH_HH_E", "FC_TRA_E"]}, "to_other": q("nrg_bal", OTHER["nrg_bal"])}
    return lines_for("nrg_bal_s", ("siec", "nrg_bal"), rows, defs, ("ktoe", {"dec": 2, "scale": 1, "suffix": " 千吨油当量"}),
                     {k: {c: n for c, n in v.items() if c not in ("P1000", "S2000")} for k, v in NAMES_Q2.items()},
                     {"siec": "siec", "nrg_bal": "nrg_bal"}, OTHER, "name:unit_short_zh:KTOE", "千吨油当量", header)


# test-only: fuel groups to three countries (GWH, whole numbers: no display part)
GEN = {("fossil", "DE"): 200000.0, ("fossil", "FR"): 40000.0, ("fossil", "ES"): 60000.0,
       ("nuclear", "DE"): 0.0, ("nuclear", "FR"): 320000.0, ("nuclear", "ES"): 50000.0,
       ("renewable", "DE"): 280000.0, ("renewable", "FR"): 140000.0, ("renewable", "ES"): 160000.0,
       ("other", "DE"): 20000.0, ("other", "FR"): 10000.0, ("other", "ES"): 8000.0}
NAMES_GEN = {"siec_group": {"fossil": "化石能源", "nuclear": "核能", "renewable": "可再生能源", "other": "其他能源"},
             "geo": {"DE": "德国", "FR": "法国", "ES": "西班牙"}}


def gen(header):
    rows = [{"src": f"series:gen/{g}.{c}:2024:OBS_VALUE", "table": "gen", "time": "2024", "value": v, "dims": {"siec_group": g, "geo": c}}
            for (g, c), v in GEN.items()]
    q = lambda dim, code: {"op": "value", "table": "gen", "time": "2024", "fmt": "gwh", "filter": {dim: code}}
    defs = {**{f"n.{g}": q("siec_group", g) for g in NAMES_GEN["siec_group"]}, **{f"n.{c}": q("geo", c) for c in NAMES_GEN["geo"]}}
    return lines_for("gen", ("siec_group", "geo"), rows, defs, ("gwh", {"dec": 0, "scale": 1, "suffix": " 吉瓦时"}), NAMES_GEN,
                     {"siec_group": "siec_group", "geo": "place"}, {}, "name:unit_short_zh:GWH", "吉瓦时", header)


SHAPES = {"q2": (q2, {"dek": "德国各类能源流向各用能部门", "kicker": "德国能源从来源到各部门"}),
          "gen": (gen, {"dek": "各类能源流向发电量最大的三国", "kicker": "发电流向"})}


def child(lines):
    out = subprocess.run([sys.executable, "-B", RUN], input="\n".join(lines) + "\n", capture_output=True, text=True, check=True, cwd=ROOT).stdout
    return [json.loads(l) for l in out.splitlines()]


def page(shape, title, words):
    """(html or None, refusal, ledger) of the shape's flow page with `title` as the text step's, the page line carrying
    `words` as claim_words (None: no claim_words, as before B11)."""
    build, head = SHAPES[shape]
    lines, ledger = build({**head, "title": title})
    size, pic = child(lines)
    if "refused" in size or "refused" in pic: return None, size.get("refused") or pic.get("refused"), ledger
    extra = {"claim_words": words} if words is not None else {}
    last = child(lines + [json.dumps({"phase": "page", "layers": {"sankey": pic["svg"]}, **extra}, ensure_ascii=False)])[-1]
    return last.get("html"), last.get("refused"), ledger


# (shape, title, verdict): "claim" the h1 carries the claim, "fallback" the finding's headline (as with no claim_words)
TITLES = [
    ("q2", "德国能源：石油产品最大一股流向交通", "fallback"),   # a stand-in's: no verb of a conclusion
    ("q2", "德国能源从来源流向各部门", "fallback"),             # a stand-in's: a label
    ("q2", "石油是德国最大的能源来源", "claim"),
    ("q2", "石油产品是德国最主要的能源", "claim"),
    ("q2", "家庭是德国用能最多的部门", "claim"),
    ("q2", "石油流向交通运输是最大的一股能源流", "claim"),
    ("q2", "交通最依赖石油，是最大的一股", "claim"),           # a two-character name of a target: a flow claim
    ("q2", "天然气是德国最大的能源来源", "fallback"),           # false
    ("q2", "工业是德国用能最多的部门", "fallback"),             # false
    ("q2", "石油流向家庭是最大的一股能源流", "fallback"),       # false flow
    ("q2", "天然气流向家庭是最大的一股", "fallback"),           # the max of households' column only: the wrong set
    ("q2", "石油和天然气是最大的能源来源", "fallback"),         # two of one side
    ("q2", "石油不是最大的能源来源", "fallback"),               # negation
    ("q2", "石油是最大的能源来源，但在减少", "fallback"),       # trend
    ("q2", "石油是第二大能源来源", "fallback"),                 # off word
    ("q2", "石油是德国能源的主要来源", "fallback"),             # no max word
    ("q2", "其他来源是最大的来源", "fallback"),                 # the merged node: no name row
    ("q2", "固体燃料是最大的来源", "fallback"),                 # a merged member
    ("q2", "石油是{first.year}年最大的来源", "fallback"),       # a placeholder
    ("q2", "石油占比最大", "fallback"),                        # 占比 holds an off word
    ("q2", "石油占最大份额", "claim"),
    ("gen", "可再生能源是发电大国最大的电源", "claim"),
    ("gen", "化石能源是发电大国最大的电源", "fallback"),         # false
    ("gen", "欧盟发电大国的能源构成", "fallback"),               # a label
]


def h1(html):
    return re.search(r"<h1>(.*?)</h1>", html, re.S).group(1)


def dek(html):
    return re.search(r'<p class="dek">(.*?)</p>', html, re.S).group(1)


class Titles(unittest.TestCase):
    WORDS = claim_words()

    def test_each_title_gets_its_verdict_and_a_fallback_is_the_page_as_before(self):
        self.assertEqual(len(TITLES), 24)
        for shape, title, want in TITLES:
            with self.subTest(title=title):
                html, why, ledger = page(shape, title, self.WORDS)
                old, old_why, _ = page(shape, title, None)
                if html is None:  # a refusal only where the leaf refused that title before B11 alike
                    self.assertEqual(why, old_why); continue
                head = h1(html)
                self.assertEqual("data-claim=" in head, want == "claim", head)
                if want == "fallback":
                    self.assertEqual(html, old, "a title with no claim draws the page as with no claim_words")
                    continue
                # the claim: the h1 is the title, every name marked by its row (a two-character name printed whole), no digit
                # and no number entry; the finding goes to the dek, its numbers the display part where the ledger has one
                self.assertRegex(head, r'^<span data-claim="max" data-a="(fact:[^"]+|series:[^"]+)">.*</span>$')
                self.assertNotRegex(re.sub(r"<[^>]+>", "", head), r"[0-9０-９]")
                self.assertNotIn('data-src="fact:', head)
                for src, text in re.findall(r'<span data-src="(name:[^"]+)">([^<]*)</span>', head): self.assertEqual(ledger[src], text)
                d = dek(html)
                self.assertRegex(d, r'^<span data-cmp="next" data-a="fact:[^"]+" data-b="fact:[^"]+">')
                for src, text in re.findall(r'data-src="(fact:[^"]+)">([^<]*)<', d): self.assertEqual(ledger[src], text)
                if shape == "q2": self.assertIn('data-src="fact:from.O4000XBIO.r">60,699<', d)
                said = title if "交通运输" in title or "交通" not in title else title.replace("交通", "交通运输", 1)
                self.assertEqual(re.sub(r"<[^>]+>", "", head), said)

    def test_the_verb_rule_keeps_a_true_claim_with_no_conclusion_verb_out_of_the_h1(self):
        # the Opus stand-in's title states a true flow claim but no verb of a conclusion: with the verb list emptied of
        # meaning (any title has "") it would be the h1, with the list it falls back
        title = TITLES[0][1]
        html, _, _ = page("q2", title, {**self.WORDS, "verb": [""]})
        self.assertIn("data-claim=", h1(html))
        html, _, _ = page("q2", title, self.WORDS)
        self.assertNotIn("data-claim=", h1(html))

    def test_the_picture_prints_the_display_part_and_the_leaf_code_holds_no_cjk(self):
        html, _, ledger = page("q2", "标题", self.WORDS)
        self.assertIn('data-src="fact:from.G3000.r">45,028<', html)
        self.assertNotIn('data-src="fact:from.G3000.n"', html)
        html, _, _ = page("gen", "标题", self.WORDS)
        self.assertNotIn(".r\"", html)
        for f in ("run.py", "wbkit.py", "sankey.py"):
            with open(os.path.join(ROOT, "runtime", "leaves_py", f), encoding="utf-8") as fh:
                code = fh.read()
            self.assertEqual(re.findall(r"[一-鿿]+", "\n".join(l for l in code.splitlines() if not l.lstrip().startswith("#"))), [], f)


if __name__ == "__main__":
    unittest.main()
