// legend: a key to what the other layers draw. One row per entry: key {src,text} is the words, series names the swatch (line_ink, line_earlier,
// line_accent, dot, land). Placed in the first corner, from the knob's, with room; no number is printed.
import { COLORS, occLines, boxOf, esc, lineHitsBox, label, overlap, inside, r1, readKnobs, refusal, textEl, MAX_ROWS } from "./common.mjs";

const SWATCHES = ["line_ink", "line_earlier", "line_accent", "dot", "land"];
export const manifest = {
  name: "legend",
  needs: { shape: "legend_items", rows: `key {src,text} the words; series one of ${SWATCHES.join(", ")} the swatch` },
  knobs: {
    palette: { default: "grey_accent", values: ["grey_accent", "mono"] },
    position: { default: "bottom-right", values: ["top-left", "top-right", "bottom-left", "bottom-right"] },
    size: { default: 12, min: 10, max: 16 },
  },
};
const CORNERS = { "top-left": 0, "top-right": 1, "bottom-left": 2, "bottom-right": 3 };

export function draw(request) {
  const { panel, rows = [] } = request, { values: k, refused } = readKnobs(manifest, request.knobs);
  if (!panel || !Number.isFinite(panel.w) || !Number.isFinite(panel.h)) refused.push("panel: w and h are needed, for example {\"w\":900,\"h\":460}");
  if (rows.length > 12) refused.push(`rows: at most 12 legend entries, got ${rows.length}`);
  for (const [i, r] of rows.entries()) if (!label(r.key) || !SWATCHES.includes(r.series)) { refused.push(`rows[${i}]: needs key {src,text} and series one of ${SWATCHES.join(", ")}, for example {"key":{"src":"note-1/text","text":"2024"},"series":"line_ink"}`); break; }
  if (refused.length) return refusal(manifest, refused);
  const { w, h } = panel, c = COLORS[k.palette], size = k.size, rowH = size * 1.6, sw = 22, pad = 8;
  const widths = rows.map((r) => boxOf(r.key.text, 0, 0, size, "start")[2]), boxW = pad * 2 + sw + 6 + Math.max(0, ...widths), boxH = pad * 2 + rowH * rows.length - (rowH - size) ;
  const taken = [...(request.occ?.boxes ?? [])].map((b) => b.slice(0, 4)), others = occLines(request);
  const order = Object.keys(CORNERS).sort((a, b) => (a === k.position ? -1 : b === k.position ? 1 : CORNERS[a] - CORNERS[b]));
  const place = order.map((name) => { const left = name.endsWith("left"), top = name.startsWith("top"), x0 = left ? 10 : w - 10 - boxW, y0 = top ? 10 : h - 10 - boxH; return { name, box: [x0, y0, x0 + boxW, y0 + boxH] }; })
    .find((p) => inside(p.box, w, h) && !taken.some((b) => overlap(p.box, b)) && !others.some((l) => lineHitsBox(l, p.box)));
  if (!place) return { svg: "", texts: [], lines: [], frame: panel.frame ?? null, refused: [], dropped: rows.map((r) => ({ src: r.key.src, why: "no free corner for the legend" })) };
  const [x0, y0] = place.box, out = [`<g data-layer="${esc(request.layer ?? "legend")}">`, `<rect x="${r1(x0)}" y="${r1(y0)}" width="${r1(boxW)}" height="${r1(boxH)}" fill="#ffffff" fill-opacity="0.85"/>`], texts = [], lines = [];
  rows.forEach((r, i) => {
    const cy = y0 + pad + rowH * i + size * 0.45, sx = x0 + pad, ty = y0 + pad + rowH * i + size * 0.9, st = r.series;
    if (st === "dot") out.push(`<circle cx="${r1(sx + sw / 2)}" cy="${r1(cy)}" r="4" fill="${c.ink}"/>`);
    else if (st === "land") out.push(`<rect x="${r1(sx)}" y="${r1(cy - 5)}" width="${sw}" height="10" fill="${c.land}"/>`);
    else if (st === "line_earlier") { for (const dy of [-4, 4]) out.push(`<line x1="${r1(sx)}" y1="${r1(cy + dy)}" x2="${r1(sx + sw)}" y2="${r1(cy + dy)}" stroke="${c.edge}" stroke-width="1"/>`); lines.push([[r1n(sx), r1n(cy)], [r1n(sx + sw), r1n(cy)], request.layer ?? "legend"]); }
    else { const col = st === "line_accent" ? c.accent : c.ink; out.push(`<line x1="${r1(sx)}" y1="${r1(cy)}" x2="${r1(sx + sw)}" y2="${r1(cy)}" stroke="${col}" stroke-width="4" stroke-linecap="butt"/>`); lines.push([[r1n(sx), r1n(cy)], [r1n(sx + sw), r1n(cy)], request.layer ?? "legend"]); }
    const t = textEl(r.key, sx + sw + 6, ty, size, "start", c.text); out.push(t.svg); texts.push(t.entry);
  });
  out.push("</g>");
  return { svg: out.join(""), texts, lines, frame: panel.frame ?? null, refused: [], dropped: [], box: place.box.map((v) => Math.round(v * 10) / 10) };
}
const r1n = (v) => Math.round(v * 10) / 10 + 0;
