#!/usr/bin/env python3
"""Every unit code a measure family's tables carry has a row in runtime/pi/assets/unit-short-zh.tsv.

A page whose table step picks a family table in a unit the unit table lacks stops at the leaf's fill ("unit ... has no row in
unit-short-zh"); the family's GDP per head (nama_10_pc, chain-linked euro per head) did. Chain-linked levels are exempt by an explicit
list until the owner decides whether they are read. The scan is scan_family_units.py:
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
assert spec is not None and spec.loader is not None
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

FAILS = []


def check(cond, what):
    if not cond:
        FAILS.append(what)


rows = scan.unit_rows()
# 1. chain-linked LEVELS (volume levels in million euro, million national currency, euro per head) are deliberately read by no
# row: the design says a chain-linked level is not read (next_pack.rs unit_short test), and whether to read it is the owner's
# call (pending; the GDP-per-head page stops at CLV20_EUR_HAB until then). The list holds each such code the family tables
# carry; a code on it that gains a row must leave it, so the decision cannot slip in unseen.
EXEMPT_PENDING_OWNER = sorted(
    f"CLV{y}_{u}" for y in ("05", "10", "15", "20") for u in ("MEUR", "MNAC", "EUR_HAB") if not (y == "05" and u == "EUR_HAB")
)
for code in EXEMPT_PENDING_OWNER:
    check(code not in rows, f"{code} has a unit row but is on the exempt list: take it off the list")

# 2. on the catalogue: no family carries a unit code the unit table lacks
catalog = scan.catalog_dir()
if catalog is None:
    print("skip catalogue part: L5GEO_DIR names no folder (set it to the registry copy's l5geo/catalog)")
else:
    res = scan.scan(catalog)
    check(len(res) == len(scan.families()), "every family scanned")
    check(all(r["tables"] for r in res.values()), f"a family holds no table: {[f for f, r in res.items() if not r['tables']]}")
    check("CLV20_EUR_HAB" in res.get("gdp_pc", {}).get("units", {}), "the scan reads nama_10_pc's unit dimension")
    exempt = set(EXEMPT_PENDING_OWNER)
    missing = {f: [c for c in r["missing"] if c not in exempt] for f, r in res.items()}
    missing = {f: m for f, m in missing.items() if m}
    check(not missing, f"unit codes with no unit-short-zh row: {missing}")
    print(f"catalogue part: {len(res)} families, {sum(len(r['units']) for r in res.values())} family-unit pairs")

if FAILS:
    for f in FAILS:
        print("FAIL", f)
    sys.exit(1)
print("ok test_family_units_have_words")
