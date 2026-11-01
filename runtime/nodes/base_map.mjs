// base_map: the countries of a map panel and the place names given to it. Draws land only; no value, no number.
import { geoMercator, geoPath } from "d3";
import { COLORS, boxOf, esc, label, overlap, inside, r3, readKnobs, refusal, textEl, MAX_ROWS } from "./common.mjs";

export const manifest = {
  name: "base_map",
  needs: { shape: "places", rows: "one place per row: key {src,text} is the name, key.lonlat [lon,lat] its point (series, time, value not used)", geo: "request.geo: a GeoJSON FeatureCollection of the countries to draw", frame: "panel.frame: projection 'mercator' and extent {lon:[a,b], lat:[c,d]}; the reply's frame carries scale and translate for the layers on top" },
  knobs: {
    palette: { default: "grey_accent", values: ["grey_accent", "mono"] },
    label_count: { default: 8, min: 0, max: 30 },
    name_size: { default: 11, min: 9, max: 16 },
  },
};

export const fitProjection = (frame, w, h) => {
  const p = geoMercator();
  if (Number.isFinite(frame.scale) && Array.isArray(frame.translate)) return p.scale(frame.scale).translate(frame.translate);
  const [a, b] = frame.extent.lon, [c, d] = frame.extent.lat;
  return p.fitExtent([[10, 10], [w - 10, h - 10]], { type: "MultiPoint", coordinates: [[a, c], [b, c], [b, d], [a, d]] });
};

export function draw(request) {
  const { panel, geo, rows = [] } = request, { values: k, refused } = readKnobs(manifest, request.knobs);
  if (!panel || !Number.isFinite(panel.w) || !Number.isFinite(panel.h)) refused.push("panel: w and h are needed, for example {\"w\":900,\"h\":460,\"frame\":{\"projection\":\"mercator\",\"extent\":{\"lon\":[-25,60],\"lat\":[27,72]}}}");
  const frame = panel?.frame;
  if (frame && (frame.projection !== "mercator" || !(Number.isFinite(frame.scale) || frame.extent?.lon && frame.extent?.lat))) refused.push("panel.frame: projection must be 'mercator' with an extent {lon:[a,b], lat:[c,d]} or a scale and translate, for example {\"projection\":\"mercator\",\"extent\":{\"lon\":[-25,60],\"lat\":[27,72]}}");
  if (!frame) refused.push("panel.frame is missing");
  if (!geo || !Array.isArray(geo.features)) refused.push("geo: a GeoJSON FeatureCollection is needed, for example {\"type\":\"FeatureCollection\",\"features\":[]}");
  if (rows.length > MAX_ROWS) refused.push(`rows: at most ${MAX_ROWS}, got ${rows.length}`);
  if (refused.length) return refusal(manifest, refused);
  const { w, h } = panel, proj = fitProjection(frame, w, h), c = COLORS[k.palette], path = geoPath(proj).digits(1);
  const out = [`<g data-layer="${esc(request.layer ?? "base")}">`, `<rect width="${w}" height="${h}" fill="${c.sea}"/>`];
  for (const f of geo.features) { const d = path(f); if (d) out.push(`<path d="${d}" fill="${c.land}" stroke="${c.border}" stroke-width="0.6"/>`); }
  const texts = [], dropped = [], taken = [...(request.occ?.boxes ?? [])].map((b) => b.slice(0, 4));
  for (const row of rows.slice(0, k.label_count)) {
    const lab = label(row.key), ll = row.key?.lonlat;
    if (!lab || !Array.isArray(ll)) { dropped.push({ src: lab?.src ?? null, why: "a place row needs key {src,text} and key.lonlat" }); continue; }
    const pt = proj(ll); if (!pt) { dropped.push({ src: lab.src, why: "the point is outside the projection" }); continue; }
    const placed = [[0, -6, "middle"], [0, 14, "middle"], [8, 4, "start"], [-8, 4, "end"]].map(([dx, dy, anchor]) => ({ dx, dy, anchor }))
      .map((o) => ({ ...o, box: boxOf(lab.text, pt[0] + o.dx, pt[1] + o.dy, k.name_size, o.anchor) }))
      .find((o) => inside(o.box, w, h) && !taken.some((b) => overlap(o.box, b)));
    if (!placed) { dropped.push({ src: lab.src, why: "no free spot for the name" }); continue; }
    const t = textEl(lab, pt[0] + placed.dx, pt[1] + placed.dy, k.name_size, placed.anchor, c.muted);
    out.push(t.svg); texts.push(t.entry); taken.push(t.entry.box);
  }
  out.push("</g>");
  return { svg: out.join(""), texts, lines: [], frame: { projection: "mercator", extent: frame.extent ?? null, scale: r3(proj.scale()), translate: proj.translate().map(r3), w, h }, refused: [], dropped };
}
