#!/usr/bin/env python3
# Adds census_region and census_division to runtime/pi/assets/us-state-names.json (1012n). Offline, stdlib only. Usage (read the
# download with -I, it is untrusted data):
#   python3 -I scripts/add_census_regions.py <state-geocodes-v2023.xlsx> runtime/pi/assets/us-state-names.json
# Source: U.S. Census Bureau, Population Division, "Census Bureau Region and Division Codes and FIPS Codes for States" (release May 2024),
# https://www2.census.gov/programs-surveys/popest/geographies/2023/state-geocodes-v2023.xlsx . The states are matched by FIPS code;
# the script stops if any of the 51 rows has no match or the names disagree. Run it after scripts/build_us_state_names.py (which
# writes the table without these two columns).
import sys, zipfile, json
import xml.etree.ElementTree as ET
src, out = sys.argv[1:3]
M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
z = zipfile.ZipFile(src)
ss = ["".join(t.text or "" for t in si.iter(M + "t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(M + "si")]
rows = []
for r in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(M + "row"):
    vals = []
    for c in r.findall(M + "c"):
        v = c.find(M + "v")
        vals.append("" if v is None else (ss[int(v.text)] if c.get("t") == "s" else v.text))
    rows.append(vals)
head = next(i for i, r in enumerate(rows) if r[:4] == ["Region", "Division", "State (FIPS)", "Name"])
region, division, state = {}, {}, {}
for r in rows[head + 1:]:
    if len(r) < 4 or not r[0]: continue
    reg, div, fips, name = r[:4]
    if fips == "00" and div == "0": region[reg] = name.removesuffix(" Region")
    elif fips == "00": division[div] = name.removesuffix(" Division")
    else: state[fips] = (reg, div, name)
assert len(region) == 4 and len(division) == 9 and len(state) == 51, (len(region), len(division), len(state))
asset = json.load(open(out, encoding="utf8"))
for row in asset["states"]:
    reg, div, name = state[row["fips"]]
    assert name == row["en"], (row["usps"], name, row["en"])
    row.pop("census_region", None); row.pop("census_division", None)
    row["census_region"], row["census_division"] = region[reg], division[div]
asset["rules"] = [x for x in asset["rules"] if not x.startswith("census_region")]
rule = "census_region, census_division = the U.S. Census Bureau's four regions (Northeast, Midwest, South, West) and nine divisions, copied by FIPS code from the Population Division file 'Census Bureau Region and Division Codes and FIPS Codes for States' (release May 2024); DC is in the South region, South Atlantic division."
asset["rules"].insert(-1, rule)
asset["sources"]["census_regions"] = {"name": "U.S. Census Bureau, Population Division: Census Bureau Region and Division Codes and FIPS Codes for States (Internet release May 2024)", "url": "https://www2.census.gov/programs-surveys/popest/geographies/2023/state-geocodes-v2023.xlsx", "license": "U.S. Government work, public domain", "checked": "2026-10-12", "result": "51 rows matched by FIPS code, English names equal"}
open(out, "w", encoding="utf8").write(json.dumps(asset, ensure_ascii=False, indent=1) + "\n")
print("wrote", len(asset["states"]), sorted(set(region.values())), len(set(division.values())))
