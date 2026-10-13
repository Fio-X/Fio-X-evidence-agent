#!/usr/bin/env python3
# Builds runtime/pi/assets/naturalearth-admin1-us-110m.geojson and its attributes sidecar (1012l step 1). Offline, plain Python, no dependencies.
# Usage (the downloads are untrusted data, read them with -I):
#   python3 -I scripts/build_us_state_basemap.py <ne_110m_admin_1_states_provinces.shp> <same .dbf> <zip sha256> <retrieved_at> <out dir>
# Keeps the 50 states + DC, in the row order of runtime/pi/assets/us-state-names.json. Geometry stays lon/lat, ring orientation as in the shapefile (same as the admin0 assets).
import json, sys, struct, hashlib, os
shp, dbf, zsha, when, outdir = sys.argv[1:6]
names = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime/pi/assets/us-state-names.json"), encoding="utf8"))["states"]
b = open(dbf, "rb").read()
n, hlen, rlen = struct.unpack("<IHH", b[4:12])
fields = []; o = 32
while b[o] != 0x0D:
    fields.append((b[o:o+11].split(b"\0")[0].decode(), b[o+16])); o += 32
attrs = []
for i in range(n):
    rec = b[hlen + i*rlen: hlen + (i+1)*rlen][1:]; p = 0; d = {}
    for name, ln in fields:
        d[name] = rec[p:p+ln].decode("utf8", "replace").replace("\x00", "").strip(); p += ln
    attrs.append(d)
s = open(shp, "rb").read()
assert struct.unpack(">i", s[0:4])[0] == 9994 and struct.unpack("<i", s[32:36])[0] == 5, "not a polygon shapefile"
shapes = []; o = 100
while o < len(s):
    ln = struct.unpack(">i", s[o+4:o+8])[0] * 2; c = s[o+8:o+8+ln]; o += 8 + ln
    t, = struct.unpack("<i", c[:4]); assert t == 5
    nparts, npts = struct.unpack("<ii", c[36:44])
    parts = list(struct.unpack("<%di" % nparts, c[44:44+4*nparts])) + [npts]
    pts = struct.unpack("<%dd" % (2*npts), c[44+4*nparts:44+4*nparts+16*npts])
    shapes.append([[(round(pts[2*k], 4), round(pts[2*k+1], 4)) for k in range(parts[j], parts[j+1])] for j in range(nparts)])
assert len(shapes) == len(attrs)
def area(r): return sum(r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1] for i in range(len(r)-1))/2
def geometry(rings):
    polys = []
    for r in rings:
        if area(r) <= 0 or not polys: polys.append([r])  # clockwise = outer ring (shapefile rule)
        else: polys[-1].append(r)
    cl = lambda rs: [[list(p) for p in r] for r in rs]
    return {"type": "Polygon", "coordinates": cl(polys[0])} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": [cl(p) for p in polys]}
by = {a["postal"]: i for i, a in enumerate(attrs) if a.get("iso_a2") == "US"}
assert len(by) == 51 and set(by) == {r["usps"] for r in names}, "state set differs from us-state-names.json"
feats, side = [], []
for k, r in enumerate(names):
    i = by[r["usps"]]; a = attrs[i]
    assert a["name"] == r["en"] and a["fips"] == "US" + r["fips"], r["usps"]
    feats.append({"type": "Feature", "properties": {}, "geometry": geometry(shapes[i])})
    side.append({"index": k, "usps": r["usps"], "fips": r["fips"], "name": r["en"], "label": [round(float(a["longitude"]), 6), round(float(a["latitude"]), 6)]})
gj = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")).encode()
gname = "naturalearth-admin1-us-110m.geojson"
open(os.path.join(outdir, gname), "wb").write(gj)
sidecar = {"schema_version": "0.1.0", "generated_by": "scripts/build_us_state_basemap.py",
  "source": {"url": "https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_1_states_provinces.zip", "retrieved_at": when, "sha256": zsha, "natural_earth_version": "5.1.1"},
  "vendored_geometry": {"file": "runtime/pi/assets/" + gname, "content_hash": hashlib.sha256(gj).hexdigest()},
  "rules": ["usps, fips and name come from the Natural Earth fields postal, fips (US + 2 digits) and name; each is checked against runtime/pi/assets/us-state-names.json and the build stops on any difference.",
    "label = [longitude, latitude] from the Natural Earth label point fields.",
    "Geometry is never read from this source at runtime: the registered basemap (" + "runtime/pi/assets/" + gname + ") is the sole geometry of record. This asset carries attributes only, indexed positionally - feature i here describes feature i of the vendored geometry; the order is that of us-state-names.json (sorted by English name)."],
  "features": side}
open(os.path.join(outdir, "naturalearth-admin1-us-110m-attributes.json"), "w", encoding="utf8").write(json.dumps(sidecar, ensure_ascii=False, indent=1) + "\n")
print("features", len(feats), "bytes", len(gj))
