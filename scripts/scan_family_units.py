"""scan_family_units.py [--catalog DIR] [--json]: the unit codes the tables of each measure family carry, and the ones the
unit table (runtime/pi/assets/unit-short-zh.tsv) has no row for.

A family holds a table when the table id starts with one of the family's `tables` prefixes (measure-families.json; the same
rule as l5geo::family_holds). Eurostat: every code of the table's `unit` dimension in the catalogue's metabase.txt
(table<TAB>dimension<TAB>code). A table with no unit dimension carries its unit in another dimension (unit-carriers.tsv,
checked by next_pack's own test) and is only listed. World Bank: every catalogue indicator the prefixes hold, its unit code
as runtime/pi/assets/wb-units.tsv registers it; an indicator with no code there stays codeless (the page stops on it,
named) and is only listed, since the unit table is keyed by unit code, not by indicator.

The catalogue is the registry copy's l5geo/catalog folder: --catalog, else $L5GEO_DIR (the Rust replay tests' variable).
Prints one line per family (tables, unit codes, missing codes) and the missing codes with their catalogue labels; exits 0.
"""
import argparse
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO, "runtime", "pi", "assets")
FAMILIES = os.path.join(ASSETS, "measure-families.json")
UNITS = os.path.join(ASSETS, "unit-short-zh.tsv")
WB_UNITS = os.path.join(ASSETS, "wb-units.tsv")


def catalog_dir(arg=None):
    """The catalogue folder from the argument or $L5GEO_DIR, or None when neither names an existing folder."""
    d = arg or os.environ.get("L5GEO_DIR", "")
    return d if d and os.path.isdir(d) else None


def families():
    with open(FAMILIES, encoding="utf-8") as f:
        return [(fam["id"], list(fam.get("tables", []))) for fam in json.load(f)["families"]]


def unit_rows():
    """Code -> row (a dict by header) of the unit table."""
    with open(UNITS, encoding="utf-8") as f:
        head = next(f).rstrip("\n").split("\t")
        return {p[0]: dict(zip(head, p)) for p in (line.rstrip("\n").split("\t") for line in f) if p and p[0]}


def wb_units():
    """World Bank indicator -> unit code ('' when the registry gives none)."""
    with open(WB_UNITS, encoding="utf-8") as f:
        next(f)
        return {p[0]: (p[2] if len(p) > 2 else "") for p in (line.rstrip("\n").split("\t") for line in f) if p and p[0]}


def eurostat_units(catalog):
    """Table -> {dimension -> set of codes} for the unit dimension, and the set of all table ids, from metabase.txt."""
    units, tables = {}, set()
    with open(os.path.join(catalog, "metabase.txt"), encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) < 3:
                continue
            tables.add(p[0])
            if p[1] == "unit":
                units.setdefault(p[0], set()).add(p[2])
    return units, tables


def wb_indicators(catalog):
    """Every World Bank indicator id of the catalogue."""
    with open(os.path.join(catalog, "wb-indicators.json"), encoding="utf-8") as f:
        data = json.load(f)
    rows = data[1] if isinstance(data, list) and len(data) > 1 else []
    return {r["id"] for r in rows if isinstance(r, dict) and r.get("id")}


def unit_labels(catalog):
    """Eurostat unit code -> English label (cl/unit.tsv)."""
    out = {}
    path = os.path.join(catalog, "cl", "unit.tsv")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) >= 2 and p[0] != "code":
                    out[p[0]] = p[1]
    return out


def scan(catalog):
    """Per family: {"tables", "units" (code -> sorted tables using it), "missing", "carried", "wb_codeless"}."""
    have = unit_rows()
    wb = wb_units()
    estat, all_tables = eurostat_units(catalog)
    wb_ids = wb_indicators(catalog)
    out = {}
    for fam, prefixes in families():
        held = lambda t: any(t.startswith(p) for p in prefixes)
        tables = sorted(t for t in all_tables if held(t))
        indicators = sorted(i for i in wb_ids if held(i))
        units, carried, codeless = {}, [], []
        for t in tables:
            if t in estat:
                for code in estat[t]:
                    units.setdefault(code, set()).add(t)
            else:
                carried.append(t)
        for i in indicators:
            code = wb.get(i, "")
            if code:
                units.setdefault(code, set()).add(i)
            else:
                codeless.append(i)
        out[fam] = {
            "tables": tables + indicators,
            "units": {c: sorted(ts) for c, ts in sorted(units.items())},
            "missing": sorted(c for c in units if c not in have),
            "carried": carried,
            "wb_codeless": codeless,
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", help="the registry copy's l5geo/catalog folder (default $L5GEO_DIR)")
    ap.add_argument("--json", action="store_true", help="print the whole scan as JSON")
    a = ap.parse_args()
    catalog = catalog_dir(a.catalog)
    if catalog is None:
        sys.exit("scan_family_units: no catalogue folder (pass --catalog or set L5GEO_DIR)")
    res = scan(catalog)
    if a.json:
        json.dump(res, sys.stdout, ensure_ascii=False, indent=1)
        print()
        return
    labels = unit_labels(catalog)
    missing = {}
    for fam, r in res.items():
        print(f"{fam}: tables {len(r['tables'])}, units {len(r['units'])}, missing {len(r['missing'])}, "
              f"no unit dimension {len(r['carried'])}, World Bank codeless {len(r['wb_codeless'])}")
        for c in r["missing"]:
            missing.setdefault(c, []).append((fam, r["units"][c]))
    print(f"missing codes: {len(missing)}")
    for c, uses in sorted(missing.items()):
        where = "; ".join(f"{fam}: {','.join(ts)}" for fam, ts in uses)
        print(f"{c}\t{labels.get(c, '')}\t{where}")


if __name__ == "__main__":
    main()
