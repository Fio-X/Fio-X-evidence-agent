#!/usr/bin/env python3
"""Checks runtime/pi/assets/m49-regions.json against the stored UNSD M49 CSVs it was read from.

Run: python3 -I -B scripts/test_m49_regions.py   (offline)
The CSVs are not in the repository (the UN terms of use allow personal use without redistribution): the file is checked for self-consistency
always, and against the two CSVs (hash, row by row) when their folder is given: M49_SOURCE_DIR=<folder with m49-overview-en.csv and -zh.csv>.
"""
import os
import re
import csv
import hashlib
import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSET = ROOT / "runtime/pi/assets/m49-regions.json"
EUROPE = "150"
# The 27 EU member states as Eurostat writes them (EL is Greece in ISO 3166, GR); the UK is not a member.
EU27_EUROSTAT = "AT BE BG HR CY CZ DK EE FI FR DE EL HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split()
EUROSTAT_TO_ISO = {"EL": "GR"}


def read_csv(path, sep):
    with io.open(path, encoding="utf-8-sig", newline="") as f:
        table = list(csv.reader(f, delimiter=sep))
    head, body = table[0], table[1:]
    return [dict(zip(head, row)) for row in body]


def check_against_originals(asset, folder):
    """Row by row against the two UN CSVs (hash first); only when the folder with the originals is given."""
    src = asset["source"]
    en_path, zh_path = Path(folder) / src["file"], Path(folder) / src["zh_file"]
    assert hashlib.sha256(en_path.read_bytes()).hexdigest() == src["document_sha256"], "English CSV hash"
    assert hashlib.sha256(zh_path.read_bytes()).hexdigest() == src["zh_document_sha256"], "Chinese CSV hash"
    en, zh = read_csv(en_path, ";"), read_csv(zh_path, ",")
    assert len(en) == len(zh) > 200
    for a, b in zip(en, zh):
        assert (a["M49 Code"], a["ISO-alpha2 Code"]) == (b["M49 Code"], b["ISO-alpha2 Code"]), a
    want = {}
    for a in en:
        if a["ISO-alpha2 Code"] and a["ISO-alpha3 Code"]:
            want[a["ISO-alpha2 Code"]] = {
                "iso2": a["ISO-alpha2 Code"], "iso3": a["ISO-alpha3 Code"], "m49": a["M49 Code"], "name_en": a["Country or Area"],
                "region": a["Region Code"] or None, "sub_region": a["Sub-region Code"] or None,
                "intermediate": a["Intermediate Region Code"] or None,
            }
    have = {c["iso2"]: c for c in asset["countries"]}
    assert set(have) == set(want), sorted(set(have) ^ set(want))
    for iso2, row in want.items():
        assert have[iso2] == row, (have[iso2], row)
    names = {}
    for a, b in zip(en, zh):
        for code_col, name_col in (("Region Code", "Region Name"), ("Sub-region Code", "Sub-region Name"), ("Intermediate Region Code", "Intermediate Region Name")):
            if a[code_col]:
                names[a[code_col]] = (a[name_col], b[name_col])
    regions = asset["regions"]
    assert set(regions) == set(names), sorted(set(regions) ^ set(names))
    for code, (name_en, name_zh) in names.items():
        assert (regions[code]["name_en"], regions[code]["name_zh"]) == (name_en, name_zh), code
    return True


def main():
    asset = json.loads(ASSET.read_text(encoding="utf-8"))
    assert asset["schema_version"] == 1
    src = asset["source"]
    for key in ("document_sha256", "zh_document_sha256"):
        assert re.fullmatch(r"[0-9a-f]{64}", src[key]), key
    assert src["file"].endswith(".csv") and "/" not in src["file"] and src["zh_file"].endswith(".csv") and "/" not in src["zh_file"]
    assert src["url"].startswith("https://unstats.un.org/unsd/methodology/m49/")
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", src["fetched_at"]), src["fetched_at"]
    assert src["licence_note"]["quote"] and src["licence_note"]["url"].startswith("https://")
    folder = os.environ.get("M49_SOURCE_DIR")
    checked = check_against_originals(asset, folder) if folder else False

    regions = asset["regions"]
    have = {c["iso2"]: c for c in asset["countries"]}
    assert len(have) == len(asset["countries"]) > 200, "an iso2 listed twice, or too few rows"
    for c in asset["countries"]:
        assert c["name_en"] and c["iso3"] and c["m49"], c
        assert c["region"] is not None or c["iso2"] in ("AQ", "BV", "TF", "HM", "GS", "UM"), c
        for key in ("region", "sub_region", "intermediate"):
            assert c[key] is None or c[key] in regions, (c["iso2"], key)
    for code, r in regions.items():
        assert r["name_en"] and r["name_zh"] and r["level"] in ("region", "sub_region", "intermediate"), code
    sub_regions = {c["sub_region"] for c in asset["countries"] if c["sub_region"]}
    for code in sub_regions:
        assert regions[code]["level"] == "sub_region", code

    # The EU27: each has a country row and sits in a European sub-region, except Cyprus (Western Asia in M49).
    by_sub = {}
    for code in EU27_EUROSTAT:
        iso2 = EUROSTAT_TO_ISO.get(code, code)
        assert iso2 in have, f"EU member without a row: {code}"
        row = have[iso2]
        if iso2 == "CY":
            assert row["region"] == "142" and regions[row["sub_region"]]["name_en"] == "Western Asia", row
            continue
        assert row["region"] == EUROPE, row
        by_sub.setdefault(row["sub_region"], []).append(code)
    assert sum(len(v) for v in by_sub.values()) == 26 and len(by_sub) == 4, by_sub
    for code, members in sorted(by_sub.items()):
        print(f"{regions[code]['name_en']} ({code}, {regions[code]['name_zh']}): {len(members)} - {' '.join(members)}")
    print(f"m49 regions PASS: {len(asset['countries'])} countries, {len(sub_regions)} sub-regions, {len(regions)} group codes" + (", checked against the originals" if checked else ", originals not given (M49_SOURCE_DIR)"))


if __name__ == "__main__":
    main()
