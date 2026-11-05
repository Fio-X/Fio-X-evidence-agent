#!/usr/bin/env python3
"""Tests for gen_unit_short_zh.py and the unit tables it reads and writes.

A rate of change gets a row only when its label states a comparison basis the script reads; the row's line form prints that
basis, every digit of it read from the label. A rate of change whose label states no basis gets no row (must-fail case), so
the page still stops on it. Every World Bank indicator registered as a change with a unit code has a row with a line form.

Run: python3 scripts/test_gen_unit_short_zh.py (needs no catalogue: the end-to-end case
builds its own small list in a temporary folder and writes nothing in the repo).
"""
import importlib.util
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("gen_unit_short_zh", os.path.join(HERE, "gen_unit_short_zh.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

FAILS = []


def check(cond, what):
    if not cond:
        FAILS.append(what)


def table_rows(path):
    with open(path, encoding="utf-8") as f:
        head = next(f).rstrip("\n").split("\t")
        return {p[0]: dict(zip(head, p)) for p in (line.rstrip("\n").split("\t") for line in f) if p and p[0]}


def digits(text):
    out, cur = [], ""
    for c in text:
        if c.isdigit():
            cur += c
        elif cur:
            out.append(cur)
            cur = ""
    return out + ([cur] if cur else [])


# 1. basis_of reads a change against one named year, the year from the label.
check(gen.basis_of("Percentage change from 1990") == "较1990年", "a change from 1990 reads its year")
check(gen.basis_of("Percentage change from 2005") == "较2005年", "the year is the label's, not a fixed one")
# the existing bases are unchanged
check(gen.basis_of("Percentage change compared to same period in previous year") == "同比", "same period in previous year")
check(gen.basis_of("Percentage change on previous period") == "较上期", "on previous period")
check(gen.basis_of("Percentage change compared to same month in 2019") == "较2019年同月", "same month in 2019")

# 2. must-fail: a rate of change whose label states no basis this script reads has none.
for label in [
    "Annual average rate of change",
    "Percentage change (t/t-12) - not seasonally adjusted data",
    "Percentage change from the base period",
    "Percentage change from previous",
    "Growth rate",
]:
    check(gen.basis_of(label) is None, f"no basis read from {label!r}")
    check(gen.is_change(label), f"{label!r} is a rate of change")
# "from <year>" outside a change label is no basis for anything (a share of an aggregate defined from a year)
check(gen.read_label("Percentage of EU27 (from 2020) total")[1] == "pct_family", "a share from 2020 stays a share")

# 3. end to end on a small copy: the no-basis change gets no row and lands on the unread list; the change from 1990 gets
# its row with the basis on its line form.
with tempfile.TemporaryDirectory(prefix="unit-short-zh-") as tmp:
    estat = os.path.join(tmp, "unit.tsv")
    with open(estat, "w", encoding="utf-8") as f:
        f.write("code\tlabel\nPCH_SM\tPercentage change compared to same period in previous year\n"
                "RCH_A_AVG\tAnnual average rate of change\n")
    wb = os.path.join(tmp, "wb-units.tsv")
    with open(wb, "w", encoding="utf-8") as f:
        f.write("indicator\tname\tunit_code\tunit_label\tmeasure_kind\trule\n"
                "X.ONE\tOne (% change from 1990)\tPCH_1990\tPercentage change from 1990\tchange\tpct_change_from\n"
                "X.TWO\tTwo (% change)\tPCH_NOBASIS\tPercentage change from the base period\tchange\tpct_change_from\n")
    table = os.path.join(tmp, "unit-short-zh.tsv")
    with open(table, "w", encoding="utf-8") as f:
        f.write("\t".join(gen.HEADER) + "\n")
    out = os.path.join(tmp, "out")
    gen.TABLE, gen.WB = table, wb
    argv = sys.argv
    sys.argv = ["gen_unit_short_zh.py", estat, "--out", out]
    try:
        gen.main()
    finally:
        sys.argv = argv
    rows = table_rows(table)
    one = rows.get("PCH_1990", {})
    check((one.get("short_zh"), one.get("line_zh"), one.get("suffix_zh"), one.get("additive")) == ("%", "%（较1990年）", "%", "no"),
          f"PCH_1990 row: {one}")
    check("PCH_NOBASIS" not in rows, "a change with no basis gets no row")
    check("RCH_A_AVG" not in rows, "an annual average rate of change gets no row")
    check(rows.get("PCH_SM", {}).get("line_zh") == "%（同比）", "PCH_SM keeps its basis")
    with open(os.path.join(out, "unread.tsv"), encoding="utf-8") as f:
        unread = {line.split("\t")[0] for line in f}
    check({"PCH_NOBASIS", "RCH_A_AVG"} <= unread, f"the no-basis changes are on the unread list: {sorted(unread)}")

# 4. the committed tables: every World Bank change row with a unit code has a unit row with a line form (its basis), each
# digit of that line the label's; a change row with no code stays codeless (the page stops on it, named).
committed = table_rows(os.path.join(REPO, "runtime", "pi", "assets", "unit-short-zh.tsv"))
with open(os.path.join(REPO, "runtime", "pi", "assets", "wb-units.tsv"), encoding="utf-8") as f:
    next(f)
    wb_rows = [line.rstrip("\n").split("\t") for line in f if line.strip()]
coded_changes = 0
for p in wb_rows:
    indicator, code, kind = p[0], p[2], p[4]
    if kind != "change" or not code:
        continue
    coded_changes += 1
    row = committed.get(code)
    check(row is not None, f"{indicator}: change code {code} has no unit row")
    if row:
        check(row["line_zh"].startswith(row["short_zh"]) and len(row["line_zh"]) > len(row["short_zh"]),
              f"{indicator}: change code {code} prints no basis")
        check(all(d in digits(row["label_en"]) for d in digits(row["line_zh"])), f"{code}: a digit of the line is not the label's")
check(coded_changes >= 30, f"World Bank change rows with a code: {coded_changes}")
wb = {p[0]: p for p in wb_rows}
for indicator in ["EN.GHG.TOT.ZG.AR5", "EN.GHG.CO2.ZG.AR5", "EN.GHG.CH4.ZG.AR5", "EN.GHG.N2O.ZG.AR5"]:
    check(wb[indicator][2] == "PCH_1990", f"{indicator} is registered as a change from 1990")
check(committed.get("PCH_1990", {}).get("line_zh") == "%（较1990年）", "PCH_1990's line prints its basis")
# growth rates whose unit text states no basis the registry reads stay codeless
for indicator in ["FM.AST.CGOV.ZG.M3", "SI.SPR.PC40.ZG", "SI.SPR.PCAP.ZG"]:
    check(wb[indicator][2] == "", f"{indicator} stays codeless")

if FAILS:
    for f in FAILS:
        print("FAIL", f)
    sys.exit(1)
print("ok test_gen_unit_short_zh")
