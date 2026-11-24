"""gen_unit_short_zh.py <eurostat cl/unit.tsv> (user 11-05 10:2x (a)): the unit short-name table as data the program
makes from the catalogue's own unit labels, not a hand list grown one family at a time.

Reads the catalogue's Eurostat unit codelist (code<TAB>English label; the pinned registry copy's l5geo/catalog/cl/unit.tsv)
and runtime/pi/assets/wb-units.tsv (World Bank unit codes and labels), keeps every reviewed row of
runtime/pi/assets/unit-short-zh.tsv as it is (source "reviewed"), fills a reviewed row with no form, and adds a row for
every other code whose label one rule below reads (source "generated"). A label no rule reads gets no row: the page
stops on it as before, and the review list names it.

Columns written: code, short_zh (the unit line's form; an index keeps its base year, read from the label, never typed),
rule, additive (yes for an amount or a count, no for a share, a rate, a ratio or an index), suffix_zh (what a number
prints after it: never a digit, so an index prints none), source (reviewed or generated), label_en (the catalogue's label
the row was made from, so a test can check every digit of short_zh against it), line_zh (what the page's unit line prints
for the code when it is more than short_zh: a rate of change's comparison basis, read from its label (user 11-05 16:1x:
同比、环比、较十年前、较 2019 年同月 must be on the page and checked); empty means the line prints short_zh). A rate of
change whose label states no basis this script reads gets no row: it goes to the unread list.

Writes the table in place and two review lists: <out>/generated.tsv (each generated row) and <out>/unread.tsv (each label
no rule reads), out = works/k8-units under the docs folder unless --out is given.
"""
import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLE = os.path.join(REPO, "runtime", "pi", "assets", "unit-short-zh.tsv")
WB = os.path.join(REPO, "runtime", "pi", "assets", "wb-units.tsv")
HEADER = ["code", "short_zh", "rule", "additive", "suffix_zh", "source", "label_en", "line_zh"]

# A qualifier a label may end with that leaves the unit as it is (seasonal adjustment).
QUALIFIER = r"(?:\s*[-,]?\s*\((?:NSA|SA|SCA|SWDA|CA)\))?"
SCALE = {"thousand": "千", "thousands": "千", "million": "百万", "millions": "百万", "billion": "十亿", "billions": "十亿"}
# Units a count or an amount is read in (lower-case label words -> the Chinese form), each adding up.
NOUN = {
    "persons": "人", "person": "人", "passengers": "人次", "nights": "晚",
    "euro": "欧元", "tonnes": "吨", "tonne": "吨", "tonnes of oil equivalent": "吨油当量",
    "passenger-kilometres": "人公里", "passenger-kilometre": "人公里", "tonne-kilometres": "吨公里",
    "tonne-kilometre": "吨公里", "vehicle-kilometres": "车公里", "vehicle-kilometre": "车公里",
    "hectares": "公顷", "hectare": "公顷", "square kilometres": "平方公里", "square kilometre": "平方公里",
    "kilowatt-hours": "千瓦时", "kilowatt-hour": "千瓦时", "gigawatt-hours": "吉瓦时", "gigawatt-hour": "吉瓦时",
    "terajoules": "太焦", "terajoule": "太焦", "cubic metres": "立方米", "kilograms": "千克", "kilogram": "千克",
    # an installed electric capacity (a power, which adds across countries as an amount does)
    "kilowatt": "千瓦", "megawatt": "兆瓦", "gigawatt": "吉瓦",
    "enterprises": "家企业", "households": "户",
    # the purchasing power standard (Eurostat's artificial currency, one PPS buying the same in every country); the EU27
    # aggregate it is set against is the standard's own definition, not part of the form
    "purchasing power standard": "购买力标准", "purchasing power standards": "购买力标准",
    "purchasing power standard (pps)": "购买力标准", "purchasing power standards (pps)": "购买力标准",
    "purchasing power standard (pps, eu27 from 2020)": "购买力标准",
    "purchasing power standards (pps, eu27 from 2020)": "购买力标准",
}
PER = {"per inhabitant": "/人", "per capita": "/人", "per person": "/人"}
# The one unit of a quantity a price is given per (lower-case label words -> the Chinese form after "/").
PER_UNIT = {
    "kilowatt-hour": "千瓦时", "gigajoule": "吉焦", "tonne": "吨", "kilogram": "千克", "hectare": "公顷",
}
# A rate of change's comparison basis, read only where the label says it outright (lower-case label -> the words the unit
# line prints in brackets after "%"); a period count with no stated frequency (t/t-12, t/t-5) says no basis, so is unread.
BASIS = [
    (r"same (?:period|quarter) in previous year|q/q-4\b|m/m-12\b", "同比"),
    (r"on previous period|\(t/t-1\)|q/q-1\b|m/m-1\b", "较上期"),
    (r"same period two years ago", "较两年前同期"),
    (r"m/m-24\b", "较两年前同月"),
]
SAME_MONTH = r"same month in (\d{4})"
# A price basis a national-accounts label starts with ("Current prices, euro per capita"): current prices leave an amount
# as the amount it is; chain linked volumes (a real, not a nominal, measure) are read only for a rate of change, whose
# comparison basis the rest of the label states, since a chain-linked level does not add up and has its own reference year.
CURRENT_PRICES = "current prices, "
CHAIN_LINKED = "chain linked volumes, "
CHANGE = r"(percentage change|growth rate|annual average rate of change|rate of change)\b"
# A change against one named year (a World Bank "% change from 1990"), the year read from the label, never typed.
FROM_YEAR = r"\bchange from (\d{4})\b"


def basis_of(label):
    """The comparison basis a rate of change's label states, or None."""
    low = label.lower()
    m = re.search(SAME_MONTH, low)
    if m:
        return f"较{m.group(1)}年同月"
    m = re.search(FROM_YEAR, low)
    if m:
        return f"较{m.group(1)}年"
    for pat, words in BASIS:
        if re.search(pat, low):
            return words
    return None


def is_change(label):
    """A rate of change by its label (the pct_change rule), whatever row it came from; a chain-linked one too."""
    low = label.lower()
    return re.match(CHANGE, low.removeprefix(CHAIN_LINKED)) is not None


def read_label(label):
    """(short_zh, rule, additive, suffix_zh) for an English unit label, or None when no rule reads it."""
    lab = re.sub(r"\s+", " ", label.strip())
    low = lab.lower()
    if low.startswith(CHAIN_LINKED):
        rest = low[len(CHAIN_LINKED):]
        if re.match(CHANGE, rest):
            return "%", "pct_change", "no", "%"
        # a chain-linked volume index ("Chain linked volumes, index 2020=100") is an index of its base year, written as
        # I90 is (owner 11-20 17:3x: the recommended form); a chain-linked amount still gets no row
        m = re.fullmatch(r"index,? \(?(\d{4})=100\)?" + QUALIFIER, rest)
        return (f"指数({m.group(1)}=100)", "index_base", "no", "") if m else None
    low = low.removeprefix(CURRENT_PRICES)
    m = re.fullmatch(r"(?:annual average |quarterly |monthly )?(?:volume |price |harmonized consumer price )?index,? "
                     r"\(?(\d{4})=100\)?" + QUALIFIER, low)
    if m:
        return f"指数({m.group(1)}=100)", "index_base", "no", ""
    if re.match(CHANGE, low):
        return "%", "pct_change", "no", "%"
    # a share's change ("Percentage of world total - 5-year change") is no share: "%" would misread it, so no rule reads it
    if re.fullmatch(r"percentage" + QUALIFIER, low) or (low.startswith("percentage of ") and "change" not in low):
        return "%", "pct_family", "no", "%"
    if low == "number" or re.fullmatch(r"number" + QUALIFIER, low):
        return "数量", "count", "yes", ""
    # a price: euro per one unit of a quantity ("Euro per kilowatt-hour"); a scaled quantity ("per thousand
    # kilowatt-hour") or one PER_UNIT does not name gets no row
    m = re.fullmatch(r"euro per (.+?)" + QUALIFIER, low)
    if m and m.group(1) in PER_UNIT:
        short = "欧元/" + PER_UNIT[m.group(1)]
        return short, "price", "no", short
    m = re.fullmatch(r"(?:(thousands?|millions?|billions?)(?: of)? )?(.+?)( per inhabitant| per capita| per person)?" + QUALIFIER, low)
    if m and m.group(2) in NOUN:
        noun = NOUN[m.group(2)]
        if m.group(2) == "euro" and m.group(1) is None and m.group(3) is None:
            noun = "欧元"
        short = SCALE.get(m.group(1) or "", "") + noun + (PER[m.group(3).strip()] if m.group(3) else "")
        additive = "no" if m.group(3) else "yes"
        return short, ("per_capita" if m.group(3) else "amount"), additive, short
    return None


def suffix_of(short, rule):
    """What a number prints after it for a reviewed row: its form, or none when the form holds a digit (an index)."""
    if any(c.isdigit() for c in short):
        return ""
    return short


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("eurostat_units")
    ap.add_argument("--out", default=os.path.join(os.path.expanduser("~"), "code", "PJ004-local-docs", "works", "k8-units"))
    a = ap.parse_args()
    labels = {}
    with open(a.eurostat_units, encoding="utf-8") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) >= 2 and p[0] and p[0] != "code":
                labels[p[0]] = p[1]
    with open(WB, encoding="utf-8") as f:
        next(f)
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) > 3 and p[2] and p[2] not in labels:
                labels[p[2]] = p[3]
    rows, order = {}, []
    with open(TABLE, encoding="utf-8") as f:
        head = next(f).rstrip("\n").split("\t")
        for line in f:
            p = dict(zip(head, line.rstrip("\n").split("\t")))
            code = p["code"]
            # a generated row is made again from its label each run, never kept: a rule that stops reading a label drops it
            if p.get("source") == "generated":
                continue
            order.append(code)
            rows[code] = {"code": code, "short_zh": p.get("short_zh", ""), "rule": p.get("rule", ""), "additive": p.get("additive", ""),
                          "suffix_zh": p.get("suffix_zh") or suffix_of(p.get("short_zh", ""), p.get("rule", "")),
                          "source": p.get("source") or "reviewed", "label_en": p.get("label_en") or labels.get(code, ""),
                          "line_zh": p.get("line_zh", "")}
            # a reviewed rate of change prints its basis too, read from its label the same way; a reviewed line form whose
            # label no rule reads (a deflator's or a contribution's change on the previous period) is kept as it is
            if is_change(rows[code]["label_en"]) and basis_of(rows[code]["label_en"]):
                rows[code]["line_zh"] = f"{rows[code]['short_zh']}（{basis_of(rows[code]['label_en'])}）"
    generated, unread = [], []
    for code in sorted(labels):
        read = read_label(labels[code])
        have = rows.get(code)
        if have and have["source"] == "reviewed" and have["short_zh"]:
            continue
        if read is None:
            if not have:
                unread.append((code, labels[code]))
            continue
        short, rule, additive, suffix = read
        line = ""
        if rule == "pct_change":
            basis = basis_of(labels[code])
            if basis is None:
                if not have:
                    unread.append((code, labels[code]))
                continue
            line = f"{short}（{basis}）"
        row = {"code": code, "short_zh": short, "rule": rule, "additive": additive, "suffix_zh": suffix,
               "source": "generated", "label_en": labels[code], "line_zh": line}
        if code not in rows:
            order.append(code)
        rows[code] = row
        generated.append(row)
    with open(TABLE, "w", encoding="utf-8") as f:
        f.write("\t".join(HEADER) + "\n")
        for code in order:
            f.write("\t".join(rows[code][h] for h in HEADER) + "\n")
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "generated.tsv"), "w", encoding="utf-8") as f:
        f.write("code\tshort_zh\tline_zh\tsuffix_zh\trule\tlabel_en\n")
        for r in generated:
            f.write(f"{r['code']}\t{r['short_zh']}\t{r['line_zh']}\t{r['suffix_zh']}\t{r['rule']}\t{r['label_en']}\n")
    with open(os.path.join(a.out, "unread.tsv"), "w", encoding="utf-8") as f:
        f.write("code\tlabel_en\n")
        for code, lab in unread:
            f.write(f"{code}\t{lab}\n")
    print(f"rows {len(order)}: reviewed {sum(1 for c in order if rows[c]['source'] == 'reviewed')}, generated {len(generated)}; "
          f"labels no rule reads {len(unread)} of {len(labels)}", file=sys.stderr)


if __name__ == "__main__":
    main()
