// leader_notes: short notes set in a side column with a thin leader line to their point on the map. Each note is one row: key {src,text,lonlat}
// is the note and its anchor; value_text {src,text}, when the row has one, is set on a second line. Nothing else is printed.
import { COLORS, occLines, boxOf, esc, label, lineHitsBox, overlap, inside, r1, readKnobs, refusal, textEl, MAX_ROWS } from "./common.mjs";
import { fitProjection } from "./base_map.mjs";

export const manifest = {
  name: "leader_notes",
  needs: { shape: "notes", rows: "key {src,text,lonlat} the note and the point it points at; value_text {src,text} optional second line", frame: "panel.frame as the base map returned it" },
  knobs: {
    palette: { default: "grey_accent", values: ["grey_accent", "mono"] },
    label_count: { default: 6, min: 0, max: 12 },
    note_size: { default: 12, min: 10, max: 16 },
    side: { default: "auto", values: ["auto", "left", "right"] },
  },
};

export function draw(request) {
  const { panel, rows = [] } = request, { values: k, refused } = readKnobs(manifest, request.knobs);
  if (!panel?.frame || !Number.isFinite(panel.frame.scale)) refused.push("panel.frame: the frame the base map returned (with scale and translate) is needed");
  if (rows.length > MAX_ROWS) refused.push(`rows: at most ${MAX_ROWS}, got ${rows.length}`);
  for (const [i, r] of rows.entries()) if (!label(r.key) || !Array.isArray(r.key.lonlat)) { refused.push(`rows[${i}]: needs key {src,text,lonlat}, for example {"key":{"src":"claim-2/text","text":"Ban takes effect","lonlat":[10,50]}}`); break; }
  if (refused.length) return refusal(manifest, refused);
  const { w, h } = panel, proj = fitProjection(panel.frame, w, h), c = COLORS[k.palette], size = k.note_size, lead = size * 1.4, margin = 8;
  const items = rows.slice(0, k.label_count).map((r) => ({ r, pt: proj(r.key.lonlat) })).filter((i) => i.pt)
    .sort((a, b) => a.pt[1] - b.pt[1] || (a.r.key.src < b.r.key.src ? -1 : 1));
  const taken = [...(request.occ?.boxes ?? [])].map((b) => b.slice(0, 4)), others = occLines(request);
  const out = [`<g data-layer="${esc(request.layer ?? "notes")}">`], texts = [], lines = [], dropped = [];
  for (const { r, pt } of items) {
    const side = k.side === "auto" ? (pt[0] < w / 2 ? "left" : "right") : k.side, anchor = side === "left" ? "start" : "end", x = side === "left" ? margin : w - margin;
    const val = label(r.value_text), height = val ? lead * 2 : lead;
    let y = Math.max(size + 2, Math.min(h - height, pt[1])), spot = null;
    for (let step = 0; step < 40 && !spot; step++, y += lead / 2) {
      const nameBox = boxOf(r.key.text, x, y, size, anchor), valBox = val ? boxOf(val.text, x, y + lead, size, anchor) : null, whole = valBox ? [Math.min(nameBox[0], valBox[0]), nameBox[1], Math.max(nameBox[2], valBox[2]), valBox[3]] : nameBox;
      if (!inside(whole, w, h)) break;
      const edge = [side === "left" ? whole[2] + 3 : whole[0] - 3, (nameBox[1] + nameBox[3]) / 2], seg = [edge, pt];
      if (!taken.some((b) => overlap(whole, b)) && !others.some((l) => lineHitsBox(l, whole)) && !taken.some((b) => lineHitsBox(seg, b, 0))) spot = { y, nameBox, valBox, edge };
    }
    if (!spot) { dropped.push({ src: r.key.src, why: "no free spot for the note" }); continue; }
    const t = textEl(r.key, x, spot.y, size, anchor, c.text, ' font-weight="600"');
    out.push(`<line x1="${r1(spot.edge[0])}" y1="${r1(spot.edge[1])}" x2="${r1(pt[0])}" y2="${r1(pt[1])}" stroke="${c.muted}" stroke-width="0.8"/><circle cx="${r1(pt[0])}" cy="${r1(pt[1])}" r="2.5" fill="${c.text}"/>`, t.svg);
    texts.push(t.entry); taken.push(t.entry.box); lines.push([spot.edge.map((v) => Math.round(v * 10) / 10), pt.map((v) => Math.round(v * 10) / 10), request.layer ?? "notes"]);
    if (val) { const v = textEl(val, x, spot.y + lead, size, anchor, c.muted); out.push(v.svg); texts.push(v.entry); taken.push(v.entry.box); }
  }
  out.push("</g>");
  return { svg: out.join(""), texts, lines, frame: panel.frame, refused: [], dropped };
}
