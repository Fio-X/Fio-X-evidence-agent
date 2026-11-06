#!/usr/bin/env python3
"""Build the generated part of runtime/pi/assets/place-names-zh.json "aliases" from three published name lists.

For every economy in the World Bank's Chinese country list (wb-countries-zh.json, not an aggregate), every Chinese name
the sources below give for its ISO 3166-1 alpha-2 code becomes an alias, unless the World Bank list or a hand-entered
alias already holds that exact name, or the name is on the EXCLUDED list (each with its reason).

Sources (read from local copies; nothing is downloaded here):
- Unicode CLDR territory names, zh, long and short form, read through the ICU in the installed Node.js.
- FAO NOCS country names export (xlsx), sheet "Chinese", columns SHORT NAME and FULL NAME, joined on sheet "Codes" ISO2.
- Chinese Wikipedia "ISO 3166-1" (zh-cn), the Chinese name column of the code table.

Hand-entered aliases (any other source url) are kept as they are. Run:
  python3 -I scripts/build_place_aliases_zh.py --wb <wb-countries-zh.json> --fao <fao export .xlsx> --wiki <wiki .html> \
      --accessed YYYY-MM-DD
"""
import argparse
import html
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "runtime" / "pi" / "assets" / "place-names-zh.json"

CLDR_URL = "https://github.com/unicode-org/cldr/blob/main/common/main/zh.xml"
FAO_URL = "https://nocs.fao.org/exportCountryData"
WIKI_URL = "https://zh.wikipedia.org/zh-cn/ISO_3166-1"
GENERATED_URLS = {CLDR_URL, FAO_URL, WIKI_URL}

# Names a source gives that must not be read as a place: each reason says what it would misread.
EXCLUDED = {
    "\u4e2d\u975e": "CF short form; also the ordinary word for China-Africa and the tail of a 'among them' split; the long form still reads",
    "\u521a\u679c": "FAO short name of CG, but in news text it stands for either Congo (CG or CD)",
    "\u6b27\u76df": "the EU, a registered word of its own, not one economy",
}
CJK = re.compile(r"[\u4e00-\u9fff\uff08\uff09()\u00b7]+")


def balanced(name):
    return name.count("（") == name.count("）") and name.count("(") == name.count(")")


def cldr_names(codes):
    script = (
        "const codes=JSON.parse(process.argv[1]);"
        "const l=new Intl.DisplayNames(['zh'],{type:'region'}),s=new Intl.DisplayNames(['zh'],{type:'region',style:'short'});"
        "const out={};for(const c of codes){try{out[c]=[l.of(c),s.of(c)].filter(n=>n&&n!==c)}catch(e){out[c]=[]}}"
        "console.log(JSON.stringify({names:out,cldr:process.versions.cldr,icu:process.versions.icu}))"
    )
    got = json.loads(subprocess.run(["node", "-e", script, json.dumps(sorted(codes))], check=True,
                                    capture_output=True, text=True).stdout)
    return got["names"], f"Unicode CLDR {got['cldr']} zh territory names, long and short (ICU {got['icu']})"


def xlsx_sheets(path):
    z = zipfile.ZipFile(path)
    strings = [re.sub(r"<[^>]+>", "", x) for x in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode(), re.S)]
    names = re.findall(r'<sheet name="([^"]+)"', z.read("xl/workbook.xml").decode())

    def rows(i):
        sheet = z.read(f"xl/worksheets/sheet{i}.xml").decode()
        out = []
        for r in re.findall(r"<row[^>]*>(.*?)</row>", sheet, re.S):
            d = {}
            for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*)>(?:<v>(.*?)</v>)?', r):
                v = c.group(3) or ""
                if 't="s"' in c.group(2) and v:
                    v = strings[int(v)]
                d[c.group(1)] = html.unescape(v)
            out.append(d)
        head = out[0]
        return [{head.get(k, k): v for k, v in row.items()} for row in out[1:]]

    return {n: rows(i + 1) for i, n in enumerate(names)}


def fao_names(path):
    sheets = xlsx_sheets(path)
    iso2 = {r.get("ID"): r.get("ISO2", "") for r in sheets["Codes"]}
    out = {}
    for r in sheets["Chinese"]:
        code = iso2.get(r.get("ID"))
        if code:
            out[code] = [r.get("SHORT NAME", ""), r.get("FULL NAME", "")]
    return out


def wiki_names(path):
    text = Path(path).read_text(encoding="utf-8")
    out = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", text, re.S):
        cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", c))).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        if len(cells) >= 6 and re.fullmatch(r"[A-Z]{2}", cells[1]):
            out[cells[1]] = [re.sub(r"\[.*?\]", "", cells[5]).strip()]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wb", required=True)
    ap.add_argument("--fao", required=True)
    ap.add_argument("--wiki", required=True)
    ap.add_argument("--accessed", required=True)
    a = ap.parse_args()
    wb = json.loads(Path(a.wb).read_text(encoding="utf-8"))
    wb = wb[1] if isinstance(wb, list) else wb
    economies = {x["iso2Code"]: x["name"] for x in wb
                 if x["region"]["value"] not in ("Aggregates", "") and re.fullmatch(r"[A-Z]{2}", x["iso2Code"])}
    data = json.loads(TARGET.read_text(encoding="utf-8"))
    kept = [x for x in data["aliases"] if x["source"]["url"] not in GENERATED_URLS]
    group_codes = {g["id"] for g in data["groups"]}
    held = set(economies.values()) | {x["name"] for x in kept} | {n for g in data["groups"] for n in g["names"]}

    cldr, cldr_title = cldr_names(economies)
    lists = [
        (cldr, {"title": cldr_title, "url": CLDR_URL}),
        (fao_names(a.fao), {"title": "FAO NOCS country names export, sheet Chinese: SHORT NAME and FULL NAME", "url": FAO_URL}),
        (wiki_names(a.wiki), {"title": "Wikipedia (zh), ISO 3166-1, Chinese name column of the code table", "url": WIKI_URL}),
    ]
    seen = {}
    for names, source in lists:
        for code in sorted(economies):
            if code in group_codes:
                continue
            for n in names.get(code, []):
                n = (n or "").strip()
                if len(n) < 2 or not CJK.fullmatch(n) or not balanced(n) or n in held or n in EXCLUDED:
                    continue
                if n in seen:
                    if seen[n]["iso2"] != code:
                        sys.exit(f"{n}: {seen[n]['iso2']} in one source, {code} in another")
                    continue
                seen[n] = {"name": n, "iso2": code, "source": dict(source, accessed=a.accessed)}
    data["aliases"] = kept + [seen[n] for n in sorted(seen)]
    TARGET.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"aliases: {len(kept)} kept by hand, {len(seen)} generated")


if __name__ == "__main__":
    main()
