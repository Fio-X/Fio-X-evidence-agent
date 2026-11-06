#!/usr/bin/env python3
"""fill_wb_unit_codes.py <units-meta.tsv> (owner 11-06: fill the World Bank unit codes from the bank's own metadata).

Fills every runtime/pi/assets/wb-units.tsv row whose unit_code is empty from the World Bank's own words for the unit:
first the indicator metadata's "Unit of measure" field (units-meta.tsv: indicator<TAB>status<TAB>unit, as fetched from
the bank's indicator API), else the bracket that ends the indicator's own name ("GDP (current US$)"). A row whose words
no rule below reads stays empty, so the page stops on it as before; nothing is guessed from a translation.

Each rule holds the row's measure rule (wb-units.tsv "rule") it may fill, so a growth rate written "%" or a per-person
amount written "Current US$" never gets an amount's or a share's code. Rows that already hold a code are left as they are.
The unit's Chinese short form lives in unit-short-zh.tsv (reviewed rows), not here. Writes the table in place and prints
how many rows each code filled and how many stay empty.
"""
import argparse
import collections
import csv
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WB = os.path.join(REPO, "runtime", "pi", "assets", "wb-units.tsv")

AMOUNT = {"money"}
# (code, English label written into unit_label, rules the code may fill, metadata/name words read, case and space folded)
RULES = [
    ("USD", "US dollars, current prices", AMOUNT,
     {"current us$", "usd current [usd_cur]", "usd current", "bop, current us$", "nfl, current us$",
      "dod, current us$", "tds, current us$"}),
    ("USD_K15", "US dollars, constant 2015 prices", AMOUNT, {"constant 2015 us$"}),
    ("LCU", "Local currency unit, current prices", AMOUNT, {"current lcu"}),
    ("LCU_K", "Local currency unit, constant prices", AMOUNT, {"constant lcu"}),
    ("INTD", "International dollars (PPP), current prices", AMOUNT, {"current international $"}),
    ("INTD_K21", "International dollars (PPP), constant 2021 prices", AMOUNT,
     {"constant 2021 international $"}),
    ("SC100", "Score, 0-100 scale", {"name_score", "scale"}, {"0-100 scale", "index (0-100)", "scale 0-100"}),
    ("SCORE", "Score", {"scale"}, {"score", "score [score]"}),
    ("PC", "Percentage", {"no_unit_text"}, {"percentage"}),
    ("BIRTH_W", "Births per woman", {"per_capita_other"}, {"births per woman"}),
]


def fold(s):
    return re.sub(r"\s+", " ", s.replace(" ", " ")).strip().lower()


def name_bracket(name):
    m = re.search(r"\(([^()]*)\)\s*$", name)
    return m.group(1) if m else ""


# An amount per someone (per worker, per person employed, per capita) is no total: an amount's code would print it as one
PER_SOMEONE = re.compile(r"\bper (worker|person|capita|employed|employee|inhabitant|head)\b", re.I)


def code_for(rule, words, name=""):
    w = fold(words)
    for code, label, rules, said in RULES:
        if rules is AMOUNT and PER_SOMEONE.search(name):
            continue
        if rule in rules and w in said:
            return code, label
    return None


def fill(rows, meta):
    filled = collections.Counter()
    for r in rows:
        if r["unit_code"]:
            continue
        # the metadata's words first, the name's bracket next; a 0-100 scale either one states wins over a bare "Score"
        said = [code_for(r["rule"], w, r["name"]) for w in (meta.get(r["indicator"], ""), name_bracket(r["name"])) if w]
        said = [g for g in said if g]
        got = next((g for g in said if g[0] == "SC100"), said[0] if said else None)
        if got:
            r["unit_code"], r["unit_label"] = got
            filled[got[0]] += 1
    return filled


def read_meta(path):
    meta = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) >= 3 and p[1] == "ok":
                meta[p[0]] = p[2]
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("meta")
    a = ap.parse_args()
    with open(WB, encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE)
        header, rows = rd.fieldnames, list(rd)
    empty = sum(not r["unit_code"] for r in rows)
    filled = fill(rows, read_meta(a.meta))
    with open(WB, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, header, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar=None)
        w.writeheader()
        w.writerows(rows)
    money = sum(1 for r in rows if r["rule"] == "money" and not r["unit_code"])
    print(f"empty before {empty}, filled {sum(filled.values())}, still empty {empty - sum(filled.values())} "
          f"(money still empty {money})", file=sys.stderr)
    for code, n in filled.most_common():
        print(f"  {code}\t{n}", file=sys.stderr)


if __name__ == "__main__":
    main()
