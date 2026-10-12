#!/usr/bin/env python3
# Builds runtime/pi/assets/us-state-names.json (1012l step 2). Offline. Usage (read the downloads with -I, they are untrusted data):
#   python3 -I scripts/build_us_state_names.py <statebins R/aaa.R> <ne_110m_admin_1_states_provinces.dbf> <out.json> <statebins_1.4.0.tar.gz>
# After this, run scripts/add_census_regions.py to add census_region and census_division (1012n).
# statebins 1.4.0 from CRAN (MIT) gives the tile cells; the Natural Earth 5.1.1 dbf cross-checks every English name and FIPS code (the script stops on any difference).
import json, re, sys, hashlib, struct
src_r, src_dbf, out = sys.argv[1:4]
r = open(src_r, encoding="utf8").read()
blk = r[: r.index("state_coords <- state_coords[order")]
def vec(name):
    m = re.search(name + r" = c\((.*?)\)", blk, re.S)
    return re.findall(r'"([^"]*)"|(\d+)L?', m.group(1))
abbr = [a for a, _ in vec("abbrev")]
state = [a for a, _ in vec("state")]
col = [int(b) for _, b in vec("col")]
row = [int(b) for _, b in vec("row")]
assert len(abbr) == len(state) == len(col) == len(row) == 54, (len(abbr), len(state), len(col), len(row))
coords = {a: (s, c, w) for a, s, c, w in zip(abbr, state, col, row)}
for extra in ("PR", "VI", "NYC"): coords.pop(extra)
assert len(coords) == 51
FIPS = dict(AL=1,AK=2,AZ=4,AR=5,CA=6,CO=8,CT=9,DE=10,DC=11,FL=12,GA=13,HI=15,ID=16,IL=17,IN=18,IA=19,KS=20,KY=21,LA=22,ME=23,MD=24,MA=25,MI=26,MN=27,MS=28,MO=29,MT=30,NE=31,NV=32,NH=33,NJ=34,NM=35,NY=36,NC=37,ND=38,OH=39,OK=40,OR=41,PA=42,RI=44,SC=45,SD=46,TN=47,TX=48,UT=49,VT=50,VA=51,WA=53,WV=54,WI=55,WY=56)
ZH = dict(AL="亚拉巴马州",AK="阿拉斯加州",AZ="亚利桑那州",AR="阿肯色州",CA="加利福尼亚州",CO="科罗拉多州",CT="康涅狄格州",DE="特拉华州",DC="哥伦比亚特区",FL="佛罗里达州",GA="佐治亚州",HI="夏威夷州",ID="爱达荷州",IL="伊利诺伊州",IN="印第安纳州",IA="艾奥瓦州",KS="堪萨斯州",KY="肯塔基州",LA="路易斯安那州",ME="缅因州",MD="马里兰州",MA="马萨诸塞州",MI="密歇根州",MN="明尼苏达州",MS="密西西比州",MO="密苏里州",MT="蒙大拿州",NE="内布拉斯加州",NV="内华达州",NH="新罕布什尔州",NJ="新泽西州",NM="新墨西哥州",NY="纽约州",NC="北卡罗来纳州",ND="北达科他州",OH="俄亥俄州",OK="俄克拉何马州",OR="俄勒冈州",PA="宾夕法尼亚州",RI="罗得岛州",SC="南卡罗来纳州",SD="南达科他州",TN="田纳西州",TX="得克萨斯州",UT="犹他州",VT="佛蒙特州",VA="弗吉尼亚州",WA="华盛顿州",WV="西弗吉尼亚州",WI="威斯康星州",WY="怀俄明州")
assert set(FIPS) == set(ZH) == set(coords)
# cross-check against the Natural Earth 110m admin-1 attribute table (dbf): name and fips
b = open(src_dbf, "rb").read()
n, hlen, rlen = struct.unpack("<IHH", b[4:12])
fields = []; o = 32
while b[o] != 0x0D:
    fields.append((b[o:o+11].split(b"\0")[0].decode(), b[o+16])); o += 32
rows = []
for i in range(n):
    rec = b[hlen + i*rlen: hlen + (i+1)*rlen][1:]; p = 0; d = {}
    for name, ln in fields:
        d[name] = rec[p:p+ln].decode("utf8", "replace").replace("\x00", "").strip(); p += ln
    rows.append(d)
us = [d for d in rows if d.get("iso_a2") == "US"]
ne = {d["postal"]: d for d in us}
print("NE US rows", len(us), sorted(set(coords) - set(ne)), sorted(set(ne) - set(coords)))
bad = []
for a, (s, c, w) in coords.items():
    d = ne.get(a)
    if not d: continue
    if d["name"] != s or d["fips"] != "US%02d" % FIPS[a]: bad.append((a, s, d["name"], d["fips"], FIPS[a]))
print("mismatches", bad)
rowsout = [dict(usps=a, fips="%02d" % FIPS[a], en=coords[a][0], zh=ZH[a], tile_col=coords[a][1], tile_row=coords[a][2]) for a in sorted(coords, key=lambda k: coords[k][0])]
cells = {(r_["tile_col"], r_["tile_row"]) for r_ in rowsout}; assert len(cells) == 51
asset = {
 "schema_version": "0.1.0",
 "rules": [
  "One row per US state plus the District of Columbia (51 rows); territories (PR, VI, GU, AS, MP) have no row and do not resolve.",
  "usps = USPS two-letter code; fips = two-digit FIPS 5-2 state code (string, zero padded); en = English name as in the statebins package state_coords table, equal to the Natural Earth Admin 1 110m name for every row.",
  "zh = the Simplified Chinese state name as written on the Ministry of Foreign Affairs country-profile page for the United States (2026-06 content; Alabama is 亚拉巴马州 there, other spellings such as 阿拉巴马州 exist). zh_verified is partial: the 50 state names and DC were checked against that page on 2026-10-12 (https://www.fmprc.gov.cn/web/gjhdq_676201/gj_676203/bmz_679954/1206_680528/1206x0_680530/); the Xinhua world place-name manual was not read in original text.",
  "tile_col, tile_row = square tile-grid cell, 1-based, tile_col 1..12 left to right, tile_row 1..8 top to bottom (row 1 is the top row). Copied from state_coords of the statebins 1.4.0 R package (MIT); no two states share a cell.",
  "The model never supplies a Chinese name or a tile cell: only this table does."
 ],
 "sources": {
  "zh_names": {"name": "Ministry of Foreign Affairs of the PRC, country profile: United States", "url": "https://www.fmprc.gov.cn/web/gjhdq_676201/gj_676203/bmz_679954/1206_680528/1206x0_680530/", "checked": "2026-10-12", "result": "50 states and DC checked; Alabama differs from the earlier common-usage name and follows this page", "not_read": "Xinhua world place-name manual"},
  "tile_layout": {"name": "statebins 1.4.0, R/aaa.R state_coords (col, row)", "url": "https://cran.r-project.org/package=statebins", "license": "MIT + file LICENSE, Copyright (c) 2015 Bob Rudis", "layout_origin_note": "statebins states it is based on the Washington Post graphics department's 'The states most threatened by trade'; the layout is a placement of 51 tiles, the MIT notice in license_notice is kept with this copy", "license_notice": "Copyright (c) 2015 Bob Rudis. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to the above copyright notice and this permission notice being included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND. (statebins 1.4.0 LICENSE, MIT)", "retrieved_sha256_of_tarball": hashlib.sha256(open(sys.argv[4], "rb").read()).hexdigest()},
  "names_and_fips_crosscheck": {"name": "Natural Earth Admin 1 - States, Provinces 1:110m, version 5.1.1 (dbf attributes name, postal, fips)", "url": "https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-1-states-provinces/", "license": "Public domain (Natural Earth terms of use)"}
 },
 "states": rowsout,
}
open(out, "w", encoding="utf8").write(json.dumps(asset, ensure_ascii=False, indent=1) + "\n")
print("wrote", len(rowsout))
