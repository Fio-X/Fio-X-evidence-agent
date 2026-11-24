#!/usr/bin/env python3
"""Every unit code a measure family's tables carry has a row in runtime/pi/assets/unit-short-zh.tsv.

A page whose table step picks a family table in a unit the unit table lacks stops at the leaf's fill ("unit ... has no row in
unit-short-zh"); the family's GDP per head (nama_10_pc, chain-linked euro per head) did. The scan is scan_family_units.py:
the family's table prefixes (measure-families.json) over the catalogue's Eurostat unit dimension and the World Bank units
wb-units.tsv registers.

Run: L5GEO_DIR=<registry>/l5geo/catalog python3 scripts/test_family_units_have_words.py. With no catalogue folder the
catalogue part is skipped (the reason printed); the rows the GDP-per-head page needed are checked either way.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("scan_family_units", os.path.join(HERE, "scan_family_units.py"))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

FAILS = []


def check(cond, what):
    if not cond:
        FAILS.append(what)


rows = scan.unit_rows()
# 1. the chain-linked per-head units of nama_10_pc: the reference year on the unit line, none on the number, no adding up
for code, year in [("CLV20_EUR_HAB", "2020"), ("CLV15_EUR_HAB", "2015"), ("CLV10_EUR_HAB", "2010")]:
    r = rows.get(code, {})
    check((r.get("short_zh"), r.get("suffix_zh"), r.get("additive")) == (f"欧元/人（{year}年不变价）", "欧元/人", "no"),
          f"{code} row: {r}")

# 2. on the catalogue: no family carries a unit code the unit table lacks
catalog = scan.catalog_dir()
if catalog is None:
    print("skip catalogue part: L5GEO_DIR names no folder (set it to the registry copy's l5geo/catalog)")
else:
    res = scan.scan(catalog)
    check(len(res) == len(scan.families()), "every family scanned")
    check(all(r["tables"] for r in res.values()), f"a family holds no table: {[f for f, r in res.items() if not r['tables']]}")
    check("CLV20_EUR_HAB" in res.get("gdp_pc", {}).get("units", {}), "the scan reads nama_10_pc's unit dimension")
    missing = {f: r["missing"] for f, r in res.items() if r["missing"]}
    check(not missing, f"unit codes with no unit-short-zh row: {missing}")
    print(f"catalogue part: {len(res)} families, {sum(len(r['units']) for r in res.values())} family-unit pairs")

if FAILS:
    for f in FAILS:
        print("FAIL", f)
    sys.exit(1)
print("ok test_family_units_have_words")
