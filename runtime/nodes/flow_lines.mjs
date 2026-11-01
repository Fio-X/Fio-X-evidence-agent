// flow_lines: one curved line per flow row, from key.lonlat to to.lonlat, as wide as its value (square-root scale, widest = width_max).
// Rows of the same key and destination at an earlier time are drawn over the later one as a thin grey outline of their width (so an earlier value
// narrower than the later one still shows). Labels: name, its printed value (value_text) and, when the row has one, its unit (unit_text).
import { geoMercator } from "d3";
import { COLORS, occLines, boxOf, curvePoints, esc, label, lineHitsBox, offsetEdges, overlap, inside, r1, r3, readKnobs, refusal, textEl, MAX_ROWS } from "./common.mjs";
import { fitProjection } from "./base_map.mjs";

export const manifest = {
  name: "flow_lines",
  needs: { shape: "flows", rows: "key {src,text}+key.lonlat the start, to {src,text}+to.lonlat the end, value (width only), value_text {src,text} the printed number, unit_text {src,text} its unit (optional; the raw row.unit is never printed), time", frame: "panel.frame as the base map returned it" },
  knobs: {
    width_max: { default: 18, min: 4, max: 40 },
    highlight: { default: "", type: "string" },
    palette: { default: "grey_accent", values: ["grey_accent", "mono"] },
    label_count: { default: 6, min: 0, max: 12 },
  },
};

export function draw(request) {
  const { panel, rows = [] } = request, refused = [], k = {};
  for (const name of ["width_max", "palette", "label_count"]) { const { values, refused: bad } = readKnobs({ knobs: { [name]: manifest.knobs[name] } }, request.knobs); Object.assign(k, values); refused.push(...bad); }
  k.highlight = request.knobs && "highlight" in request.knobs ? request.knobs.highlight : manifest.knobs.highlight.default;
  if (typeof k.highlight !== "string") refused.push("knob highlight: must be a key src, or \"\" for none, for example \"name:RU\"");
  if (!panel?.frame || !Number.isFinite(panel.frame.scale)) refused.push("panel.frame: the frame the base map returned (with scale and translate) is needed");
  if (rows.length > MAX_ROWS) refused.push(`rows: at most ${MAX_ROWS}, got ${rows.length}`);
  for (const [i, r] of rows.entries()) if (!label(r.key) || !Array.isArray(r.key.lonlat) || !Array.isArray(r.to?.lonlat) || !Number.isFinite(r.value)) { refused.push(`rows[${i}]: needs key {src,text,lonlat}, to {lonlat} and a numeric value, for example {"key":{"src":"name:RU","text":"Russia","lonlat":[40,56]},"to":{"lonlat":[10,50]},"value":378,"value_text":{"src":"claim-1/value","text":"378"},"time":"2024"}`); break; }
  if (refused.length) return refusal(manifest, refused);
  const { w, h } = panel, proj = fitProjection(panel.frame, w, h), c = COLORS[k.palette];
  const maxV = Math.max(...rows.map((r) => r.value), 1e-9), width = (v) => k.width_max * Math.sqrt(Math.max(v, 0) / maxV);
  const latest = new Map();
  for (const r of rows) { const id = r.key.src + "|" + (r.to.src ?? ""); if (!latest.has(id) || String(r.time ?? "") > String(latest.get(id).time ?? "")) latest.set(id, r); }
  const sorted = [...rows].sort((a, b) => (String(a.time ?? "") < String(b.time ?? "") ? -1 : String(a.time ?? "") > String(b.time ?? "") ? 1 : b.value - a.value || (a.key.src < b.key.src ? -1 : 1)));
  const out = [`<g data-layer="${esc(request.layer ?? "flows")}">`], lines = [], geom = new Map(), drawn = [], earlier = [];
  for (const r of sorted) {
    const p0 = proj(r.key.lonlat), p1 = proj(r.to.lonlat); if (!p0 || !p1) continue;
    const mx = (p0[0] + p1[0]) / 2 + (p1[1] - p0[1]) * 0.18, my = (p0[1] + p1[1]) / 2 - (p1[0] - p0[0]) * 0.18, id = r.key.src + "|" + (r.to.src ?? "");
    const now = latest.get(id) === r, hot = k.highlight !== "" && r.key.src === k.highlight;
    const stroke = hot ? c.accent : c.ink, pts = curvePoints(p0, [mx, my], p1);
    if (now) out.push(`<path d="M${r1(p0[0])},${r1(p0[1])} Q${r1(mx)},${r1(my)} ${r1(p1[0])},${r1(p1[1])}" fill="none" stroke="${stroke}" stroke-width="${r1(width(r.value))}" stroke-linecap="round" stroke-opacity="0.9"/>`);
    else earlier.push({ pts, half: width(r.value) / 2 }); lines.push([...pts, request.layer ?? "flows"]); drawn.push({ pts, half: width(r.value) / 2 }); if (now) geom.set(id, { r, p0, pts, hot, half: width(r.value) / 2 });
  }
  for (const e of earlier) for (const edge of offsetEdges(e.pts, e.half)) out.push(`<path data-role="earlier-edge" d="M${edge.map((p) => r1(p[0]) + "," + r1(p[1])).join(" L")}" fill="none" stroke="${c.edge}" stroke-width="1" stroke-linecap="round"/>`);
  const texts = [], dropped = [], taken = [...(request.occ?.boxes ?? [])].map((b) => b.slice(0, 4)), others = occLines(request);
  const own = drawn; // every drawn flow, ghosts included, with its half width
  const top = [...geom.values()].sort((a, b) => b.r.value - a.r.value || (a.r.key.src < b.r.key.src ? -1 : 1)).slice(0, k.label_count);
  const size = 12;
  for (const g of top) {
    const name = g.r.key, val = label(g.r.value_text), unit = val ? label(g.r.unit_text) : null;
    const hf = g.half, tries = [];
    for (const ring of [0, 14, 28]) for (const [dx, dy, anchor] of [[0, -(hf + 5), "middle"], [0, hf + 15, "middle"], [hf + 8, 4, "start"], [-(hf + 8), 4, "end"], [hf + 8, -(hf + 5), "start"], [-(hf + 8), -(hf + 5), "end"], [hf + 8, hf + 15, "start"], [-(hf + 8), hf + 15, "end"]]) tries.push([dx + Math.sign(dx) * ring, dy + Math.sign(dy) * ring, anchor]);
    const spot = tries.map(([dx, dy, anchor]) => {
      const x = g.p0[0] + dx, y = g.p0[1] + dy, nameBox = boxOf(name.text, x, y, size, anchor);
      const total = val ? [nameBox[0], nameBox[1], nameBox[2] + 4 + boxOf(val.text, 0, y, size, "start")[2] + (unit ? 2 + boxOf(unit.text, 0, y, size, "start")[2] : 0), nameBox[3]] : nameBox;
      return { x, y, anchor, nameBox, total };
    }).find((s) => inside(s.total, w, h) && !taken.some((b) => overlap(s.total, b)) && !own.some((l) => lineHitsBox(l.pts, s.total, l.half + 1)) && !others.some((l) => lineHitsBox(l, s.total)));
    if (!spot) { dropped.push({ src: name.src, why: "no free spot for the label" }); continue; }
    const t = textEl(name, spot.x, spot.y, size, spot.anchor, g.hot ? c.accent : c.text, ' font-weight="600"');
    out.push(t.svg); texts.push(t.entry); taken.push(t.entry.box);
    if (val) { const vx = spot.nameBox[2] + 4, v = textEl(val, vx, spot.y, size, "start", g.hot ? c.accent : c.text, ' font-weight="600"'); out.push(v.svg); texts.push(v.entry); taken.push(v.entry.box); if (unit) { const u = textEl(unit, v.entry.box[2] + 2, spot.y, size, "start", c.muted); out.push(u.svg); texts.push(u.entry); taken.push(u.entry.box); } }
  }
  out.push("</g>");
  return { svg: out.join(""), texts, lines, frame: panel.frame, refused: [], dropped };
}
