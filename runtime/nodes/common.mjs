// Shared helpers of the second-layer leaf nodes. No node here formats a number for the reader: every printed word comes from a row's
// {src, text} label, and coordinates are rounded with Math.round only (no toFixed, no d3.format, no Intl).
export const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;
// Text width by the first layer's rule (next_flow tw): a CJK character is 1 em, any other 0.58 em.
export const tw = (text, size) => [...String(text)].reduce((w, ch) => w + (CJK.test(ch) ? 1 : 0.58), 0) * size;
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const r1 = (v) => String(Math.round(v * 10) / 10 + 0); // one decimal, "-0" never printed
export const r3 = (v) => Math.round(v * 1000) / 1000 + 0;
export const COLORS = {
  grey_accent: { land: "#e4e1da", sea: "#f7f6f2", border: "#ffffff", ink: "#333333", ghost: "#c9c9c9", edge: "#8a8a8a", accent: "#d8452f", text: "#222222", muted: "#6b6b6b" },
  mono: { land: "#e4e1da", sea: "#f7f6f2", border: "#ffffff", ink: "#333333", ghost: "#c9c9c9", edge: "#8a8a8a", accent: "#333333", text: "#222222", muted: "#6b6b6b" },
};
export const FONT = "PingFang SC, Noto Sans CJK SC, sans-serif";

// A text box by the layer's rule: baseline y, ascent 0.9 em, descent 0.25 em; the anchor decides which side of x the width runs.
export const boxOf = (text, x, y, size, anchor) => {
  const w = tw(text, size), x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
  return [r3(x0), r3(y - size * 0.9), r3(x0 + w), r3(y + size * 0.25)];
};
export const overlap = (a, b, pad = 1) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;
export const inside = (b, w, h) => b[0] >= 0 && b[1] >= 0 && b[2] <= w && b[3] <= h;
// Does a polyline (list of [x,y]) pass through a box? Points are walked at 2 px steps.
export const lineHitsBox = (pts, box, pad = 1) => {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
    for (let k = 0; k <= n; k++) { const x = x0 + ((x1 - x0) * k) / n, y = y0 + ((y1 - y0) * k) / n; if (x > box[0] - pad && x < box[2] + pad && y > box[1] - pad && y < box[3] + pad) return true; }
  }
  return false;
};
// The points of a quadratic curve at about 4 px spacing, as the reply's `lines` wants.
export const curvePoints = (p0, c, p1) => {
  const len = Math.hypot(c[0] - p0[0], c[1] - p0[1]) + Math.hypot(p1[0] - c[0], p1[1] - c[1]), n = Math.max(2, Math.ceil(len / 4)), out = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([r1n(u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0]), r1n(u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1])]); }
  return out;
};
const r1n = (v) => Math.round(v * 10) / 10 + 0;
// The two edges of a band of full width 2*half around a polyline: the outline of an earlier value drawn over the later one.
export const offsetEdges = (pts, half) => {
  const left = [], right = [];
  pts.forEach((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len; left.push([p[0] + nx * half, p[1] + ny * half]); right.push([p[0] - nx * half, p[1] - ny * half]); });
  return [left, right];
};
// The lines already on the panel, from request.occ.lines: either [{layer, pts}] (the bridge's form) or [[x,y],...,"layer"] (the contract page's form).
export const occLines = (request) => (request.occ?.lines ?? []).map((l) => (Array.isArray(l) ? l.filter((p) => Array.isArray(p)) : l.pts));
export const label = (v) => (v && typeof v === "object" && typeof v.src === "string" && typeof v.text === "string" ? v : null);
// One printed word: an SVG text with its data-src, and the entry for the reply's `texts`.
export const textEl = (lab, x, y, size, anchor, fill, extra = "") => ({
  svg: `<text data-src="${esc(lab.src)}" x="${r1(x)}" y="${r1(y)}" font-family="${esc(FONT)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${extra}>${esc(lab.text)}</text>`,
  entry: { src: lab.src, text: lab.text, x: r1n(x), y: r1n(y), size, anchor, box: boxOf(lab.text, x, y, size, anchor) },
});
// A knob value checked against its manifest entry. Returns [value, null] or [null, reason].
export const knob = (manifest, knobs, name) => {
  const k = manifest.knobs[name], v = knobs && name in knobs ? knobs[name] : k.default;
  if (k.values) return k.values.includes(v) ? [v, null] : [null, `knob ${name}: ${JSON.stringify(v)} is not allowed; use one of ${k.values.join(", ")} (for example ${k.default})`];
  return Number.isFinite(v) && v >= k.min && v <= k.max ? [v, null] : [null, `knob ${name}: ${JSON.stringify(v)} is outside ${k.min}..${k.max}; for example ${k.default}`];
};
export const readKnobs = (manifest, knobs) => { const out = {}, refused = []; for (const name of Object.keys(manifest.knobs)) { const [v, why] = knob(manifest, knobs, name); if (why) refused.push(why); else out[name] = v; } return { values: out, refused }; };
export const refusal = (manifest, why) => ({ svg: "", texts: [], lines: [], frame: null, refused: Array.isArray(why) ? why : [why] });
// Frame helpers: the projection the base map reports and the layers behind it take back unchanged.
export const MAX_ROWS = 400;
