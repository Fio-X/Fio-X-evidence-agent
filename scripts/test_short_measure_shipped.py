"""A chart head's short measure name as the built binary ships the leaves (runtime/leaves_py/findings.py short_measure).

The binary writes each leaves_py file it lists in src/runtime.rs (include_str!) into its run folder, one by one, and writes
no runtime/pi/assets/measure-families.json beside them. So the leaf reads the families' short names from its own word table
(words.zh.json "measure.short"), and this test holds:
  - sync: the word table's "measure.short" is the families file's families, in the same order, each with the same zh and the
    same table ids and prefixes (none extra, none missing);
  - isolation: only the files src/runtime.rs ships are copied into a fresh temp folder with no pi/ folder beside them, and the
    leaf composition runs from that copy in a child process: a World Bank CO2-per-head request's chart heads read the
    family's short name and not the request's long measure words, a Eurostat share's heads read its family's short name, and
    a table no family holds keeps the request's measure words.
Run: python3 -I -B scripts/test_short_measure_shipped.py"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
FAMILIES = os.path.join(ROOT, "runtime", "pi", "assets", "measure-families.json")
RUNTIME_RS = os.path.join(ROOT, "src", "runtime.rs")
sys.path.insert(0, HERE)  # a sibling test (python -I leaves the script's folder off the path)
import test_story_findings as TSF  # noqa: E402

WORDS = json.load(open(os.path.join(LEAVES, "words.zh.json"), encoding="utf-8"))
FAMS = json.load(open(FAMILIES, encoding="utf-8"))["families"]

# layers whose "title" is no measure head (their own words)
NOT_HEADS = ("risk_notes", "winners_losers", "event_chain")

# The child: composes each pick list from the copied folder alone and prints every layer's title and the module's file.
CHILD = r"""
import json, os, sys
leaves = sys.argv[1]
sys.path.insert(0, leaves)
import findings as FN
job = json.load(sys.stdin)
out = {"file": os.path.abspath(FN.__file__), "short": FN.short_measure(job["req"]["main"]["table"]), "pages": []}
for picks in job["picks"]:
    try: composed = FN.compose({**job["req"], "picks": picks})
    except FN.Refused: continue
    out["pages"].append({k: v.get("title") for k, v in composed["leaves"].items() if isinstance(v, dict) and "title" in v})
print(json.dumps(out, ensure_ascii=False))
"""

PICKS = (["movers", "rank", "ends", "members"], ["ends", "tiles", "overtake"], ["rank", "spread", "movers"])


def shipped_leaves():
    """The leaves_py files src/runtime.rs writes into a run folder (its include_str! list)."""
    with open(RUNTIME_RS, encoding="utf-8") as fh:
        names = re.findall(r'include_str!\("\.\./runtime/leaves_py/([^"/]+)"\)', fh.read())
    return sorted(set(names))


def family_zh(table):
    """The zh of the first family in the families file that holds the table (the knowledge group's own list)."""
    tid = table.split("@")[0]
    for fam in FAMS:
        if any(tid.startswith(h) if h.endswith(("_", ".")) else tid == h for h in fam["tables"]): return fam["zh"]
    return None


class Sync(unittest.TestCase):
    def test_the_word_table_holds_every_family_s_short_name_and_tables(self):
        short = WORDS.get("measure.short")
        self.assertIsInstance(short, list)
        want = [{"zh": f["zh"], "tables": f["tables"]} for f in FAMS
                if isinstance(f.get("zh"), str) and f["zh"] and not any(ch.isdigit() for ch in f["zh"])]
        self.assertEqual(len(want), len(FAMS), "a family's zh is empty or holds a digit: decide how the word table holds it")
        self.assertEqual(short, want)
        # every other entry of the word table stays plain words
        self.assertTrue(all(isinstance(v, str) for k, v in WORDS.items() if k != "measure.short"))


class Isolated(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        scratch = tempfile.mkdtemp(prefix="short-measure-")
        leaves = os.path.join(scratch, "run", "leaves_py")
        os.makedirs(leaves)
        cls.tmp, cls.leaves = scratch, leaves
        cls.names = shipped_leaves()
        for n in cls.names: shutil.copy2(os.path.join(LEAVES, n), os.path.join(leaves, n))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def compose(self, req):
        p = subprocess.run([sys.executable, "-I", "-B", "-c", CHILD, self.leaves], input=json.dumps({"req": req, "picks": PICKS}),
                           capture_output=True, text=True, cwd=self.tmp, timeout=300)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        out = json.loads(p.stdout)
        self.assertEqual(os.path.realpath(os.path.dirname(out["file"])), os.path.realpath(self.leaves))
        self.assertTrue(out["pages"])
        return out

    def heads(self, out):
        hs = [t for page in out["pages"] for layer, t in page.items() if layer not in NOT_HEADS]
        self.assertGreaterEqual(len(hs), 4)
        return hs

    def test_the_copy_is_the_shipped_list_with_no_pi_folder_beside_it(self):
        for n in ("findings.py", "words.py", "words.zh.json"): self.assertIn(n, self.names)
        self.assertNotIn("measure-families.json", self.names)
        self.assertEqual(sorted(os.listdir(os.path.dirname(self.leaves))), ["leaves_py"])
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.leaves), "pi")))

    def test_a_world_bank_co2_per_head_head_reads_the_short_name(self):
        req, _, _, head = TSF.unit_shape("co2")
        zh = family_zh(req["main"]["table"])
        self.assertTrue(zh and zh == head)
        out = self.compose(req)
        self.assertEqual(out["short"], zh)
        for t in self.heads(out):
            self.assertEqual(t, [{"w": zh}])
            self.assertNotIn(req["words"]["measure"], json.dumps(t, ensure_ascii=False))

    def test_a_eurostat_share_head_reads_its_family_s_short_name(self):
        req, _ = TSF.eu_request()
        req = {**req, "words": {**req["words"], "measure": "renewable share of gross final energy consumption"}}
        zh = family_zh(req["main"]["table"])
        self.assertTrue(zh)
        out = self.compose(req)
        self.assertEqual(out["short"], zh)
        for t in self.heads(out): self.assertEqual(t, [{"w": zh}])

    def test_a_table_no_family_holds_keeps_the_request_s_measure_words(self):
        req, _, _, _ = TSF.unit_shape("co2")
        old, new = req["main"]["table"].split("@")[0], "zz_no_family_table"
        self.assertIsNone(family_zh(new))
        req = json.loads(json.dumps(req).replace(old, new))
        out = self.compose(req)
        self.assertIsNone(out["short"])
        for t in self.heads(out): self.assertEqual(t, [{"w": req["words"]["measure"]}])


if __name__ == "__main__":
    unittest.main()
