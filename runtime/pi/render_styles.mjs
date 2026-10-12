// Render styles (NEWSROOM_RENDER_STYLES=1, exact "1", default off): the last layer of the chart renderer. A finished house-style SVG is re-drawn
// with a different pen: "riso" (two-ink risograph: grey-blue + coral, halftone dots, 2.4px coral mis-registration, paper grain) or "pencil" (graphite
// line with a light jitter and a repeated pass, hatching, one coloured pencil, paper grain, hand-lettered type).
//
// What a style may change: fill / stroke colours (luminance-preserving, so every contrast and fill-monotone proof sees the same luminance),
// the font family, small bounded offsets of text and extra decoration drawn on top. What it never changes: the data elements themselves
// (every rect / polyline / circle keeps its x, y, width, height, points and data-* attributes) and the labels' text. Decoration elements carry no
// data-* attribute, so no check counts them as data. No SVG filter is used: only paths, a pattern of path specks and attribute changes.
//
// Determinism: the jitter and the paper grain come from a seeded generator (FNV-1a of the finished SVG text and the style name); the same input
// gives the same bytes. Nothing here draws on a random source or a clock.
import { estimateTextWidth } from "./render_qa_geometry.mjs";
import { numberWordIn } from "./number_words.mjs";
import { STORY_COLORS } from "./story_forms.mjs";

export const RENDER_STYLES = Object.freeze(["house", "riso", "pencil"]);
export const JITTER_PX = 0.7; // largest offset of any jittered point or text, before the optional multiplier
export const HALFTONE_PITCH = 5; // one dot spacing for every riso halftone (tile map and state map)
export const HALFTONE_DIAMETER = [0.28, 0.64]; // dot diameter = pitch * (first + second * level): the largest dot is more than 3x the smallest
export const MISREGISTER_PX = Object.freeze([2.4, 1.6]);
export const DOT_SIZE_JITTER = 0.08; // riso: every dot's diameter varies by at most 8% around the class diameter; the mean per tile stays exact
const DOT_POS_JITTER = 0.4; // riso: a dot's centre moves by at most this many px
const LINE_CORRIDOR = 1.9; // riso: dots keep this far (edge to line centre, px) from the tile's own line; only a thin paper outline
const MARK_CORRIDOR = 1.2; // riso: dots keep this far from the peak / last-point markers of a tile

export function renderStylesEnabled() {
  return process.env.NEWSROOM_RENDER_STYLES === "1";
}

// Colours come from the house library: accent #d1493f (DEFAULT_PALETTE.accent) and the grey-blue ramp #4c647c (DEFAULT_CHOROPLETH_RAMP).
const INK_BLUE = "#4c647c";
const INK_CORAL = "#d1493f";
const GRAPHITE = "#3b3b3b";
const COLOUR_PENCIL = "#c0463e";
const PAPER = { riso: "#f1ecdf", pencil: "#efe9db" };
const SPECK = { riso: "#8a7f6a", pencil: "#8f866f" };
const INK_DEEP = "#2f4357"; // title-strip and legend ink of riso (about 8:1 on the paper)
const INK_RULE = "#9db0c2"; // the thin outline of a riso tile / legend swatch printed on the bare paper
const SONG_FONT = "'Songti SC', 'STSong', 'Songti TC', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC', SimSun, serif";
export const STYLED_FRAME_NAME = Object.freeze({ riso: "深灰蓝", pencil: "深灰" });
export const STYLED_FRAME_NAME_EN = Object.freeze({ riso: "dark grey-blue", pencil: "dark graphite" });
const HAND_FONT = "'Hannotate SC', 'Xingkai SC', 'Kaiti SC', 'STKaiti', 'Bradley Hand', 'Segoe Print', 'PingFang SC', 'Noto Sans SC', Arial, sans-serif";

// ---- small helpers -------------------------------------------------------------------------------------------------------------------------
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const f = (v) => String(Math.round(v * 100) / 100);
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG = /<[^<>]+>/g;
function attr(tag, name) {
  const m = new RegExp(`\\s${name.replace(/[-]/g, "\\-")}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function setAttr(tag, name, value) {
  const re = new RegExp(`(\\s${name.replace(/[-]/g, "\\-")}=)"[^"]*"`);
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  return tag.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end.trim() === "/>" ? "/>" : ">"}`);
}

// ---- colour --------------------------------------------------------------------------------------------------------------------------------
function parseColor(text) {
  if (typeof text !== "string") return null;
  const s = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}
const hex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function hueFamily(rgb) {
  const [r, g, b] = rgb, max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === 0 || (max - min) / max < 0.22) return "grey";
  let h;
  const d = max - min;
  if (max === r) h = ((g - b) / d + 6) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60;
  return h < 55 || h >= 330 ? "warm" : "cool";
}
// The colour of `base` mixed with black or white until its relative luminance is `target` (24 bisection steps: deterministic).
function withLuminance(base, target) {
  const l0 = luminance(base);
  const toward = target < l0 ? [0, 0, 0] : [255, 255, 255];
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const mixed = base.map((v, k) => v + (toward[k] - v) * mid);
    if ((luminance(mixed) < target) === (target < l0)) hi = mid; else lo = mid;
  }
  const t = (lo + hi) / 2;
  return hex(base.map((v, k) => v + (toward[k] - v) * t));
}
// Re-ink one colour. The relative luminance is kept, so contrast ratios and "larger value = darker fill" orderings are unchanged.
// riso: grey-blue (warm hues -> coral only with `accent`). pencil: graphite (warm hues -> the one coloured pencil only with `accent`).
// One colour, one meaning: the accent ink (coral / coloured pencil) is used only when `accent` is true (the spec's render_accent, set for the one
// thing the page marks with it); without it a warm house colour is re-inked in the base ink at the same luminance.
export function recolor(color, style, accent = false) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const family = hueFamily(rgb) === "warm" && accent ? "warm" : "base", L = luminance(rgb);
  const base = parseColor(style === "riso" ? (family === "warm" ? INK_CORAL : INK_BLUE) : (family === "warm" ? COLOUR_PENCIL : GRAPHITE));
  return withLuminance(base, L);
}

// ---- geometry decoration -------------------------------------------------------------------------------------------------------------------
// A wobbly copy of a polyline: every point moves by at most `amp`, long segments are split every ~16px so a straight edge wanders.
function wobble(points, amp, rnd, closed = false) {
  const out = [];
  const list = closed ? [...points, points[0]] : points;
  for (let i = 0; i < list.length; i++) {
    const [x, y] = list[i];
    if (i > 0) {
      const [px, py] = list[i - 1], len = Math.hypot(x - px, y - py), parts = Math.max(1, Math.floor(len / 16));
      for (let k = 1; k < parts; k++) out.push([px + ((x - px) * k) / parts + (rnd() * 2 - 1) * amp, py + ((y - py) * k) / parts + (rnd() * 2 - 1) * amp]);
    }
    out.push([x + (rnd() * 2 - 1) * amp, y + (rnd() * 2 - 1) * amp]);
  }
  return out;
}
const pathOf = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}`;
function rectPoints(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
function circlePoints(cx, cy, r) {
  const n = Math.max(10, Math.min(28, Math.round(r * 3)));
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
}
// 45-degree hatch lines inside a rect: line x + y = c, clipped to the rect.
// The parts of a hatch line that fall inside a masked text box are cut out (a text box is a no-draw zone for every decoration).
function hatch(x, y, w, h, spacing, amp, rnd, boxes) {
  const segs = [];
  for (let c = x + y + spacing / 2; c < x + w + y + h; c += spacing) {
    const lo = Math.max(x, c - (y + h)), hi = Math.min(x + w, c - y);
    if (!(lo < hi - 0.5)) continue;
    let pieces = [[lo, hi]];
    for (const [bx0, by0, bx1, by1] of boxes) {
      // the line y = c - x is inside the box for x in [max(bx0, c - by1), min(bx1, c - by0)]
      const a = Math.max(bx0, c - by1 - amp), b = Math.min(bx1, c - by0 + amp);
      if (a >= b) continue;
      pieces = pieces.flatMap(([p, q]) => (b <= p || a >= q ? [[p, q]] : [...(a > p ? [[p, a]] : []), ...(b < q ? [[b, q]] : [])]));
    }
    for (const [p, q] of pieces) if (q - p > 0.8) segs.push(`M${f(p + (rnd() * 2 - 1) * amp)} ${f(c - p + (rnd() * 2 - 1) * amp)}L${f(q + (rnd() * 2 - 1) * amp)} ${f(c - q + (rnd() * 2 - 1) * amp)}`);
  }
  return segs.join("");
}
function nearPolyline(pts, px, py, d) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) < d) return true;
  }
  return false;
}
// The dot centres inside a box on the pitch grid, leaving out text boxes, a thin paper corridor around the tile's own line and its two markers.
function dotPoints(x, y, w, h, pitch, radius, boxes, lines = [], marks = []) {
  const cols = Math.max(1, Math.floor((w - 2) / pitch)), rows = Math.max(1, Math.floor((h - 2) / pitch));
  const ox = x + (w - (cols - 1) * pitch) / 2, oy = y + (h - (rows - 1) * pitch) / 2, pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cx = ox + c * pitch, cy = oy + r * pitch;
    if (boxes.some(([x0, y0, x1, y1]) => cx + radius > x0 && cx - radius < x1 && cy + radius > y0 && cy - radius < y1)) continue;
    if (lines.some((pts2) => nearPolyline(pts2, cx, cy, radius + LINE_CORRIDOR))) continue;
    if (marks.some(([mx, my, mr]) => Math.hypot(cx - mx, cy - my) < radius + mr + MARK_CORRIDOR)) continue;
    pts.push([cx, cy]);
  }
  return pts;
}
// Round dots as paths (a zero-length segment with a round cap; stroke-width is the dot diameter). Printing is not perfect: each dot moves by at most
// DOT_POS_JITTER px and its diameter by at most DOT_SIZE_JITTER; the size steps come in +u / -u pairs, so the mean diameter of the dots is exactly the
// class diameter. Dots of one size step share one path.
const SIZE_STEPS = [-1, -0.5, 0, 0.5, 1];
function dotPaths(pts, diameter, colour, rnd, extra = "") {
  const bins = SIZE_STEPS.map(() => []);
  let prev = 0;
  pts.forEach(([x, y], i) => {
    let u;
    if (i % 2 === 1) u = -prev;
    else { u = i === pts.length - 1 ? 0 : SIZE_STEPS[Math.floor(rnd() * SIZE_STEPS.length)]; prev = u; }
    bins[SIZE_STEPS.indexOf(u)].push(`M${f(x + (rnd() * 2 - 1) * DOT_POS_JITTER)} ${f(y + (rnd() * 2 - 1) * DOT_POS_JITTER)}h.01`);
  });
  return bins.map((segs, k) => (segs.length ? `<path d="${segs.join("")}" fill="none" stroke="${colour}" stroke-width="${f(diameter * (1 + DOT_SIZE_JITTER * SIZE_STEPS[k]))}" stroke-linecap="round"${extra}/>` : "")).join("");
}
// Absolute M / L / Z paths (what the map renderers emit) as rings of points; null when the path uses anything else.
function ringsOf(d) {
  if (!/^[MLZ0-9.,\s-]+$/.test(d)) return null;
  const rings = [];
  let ring = null;
  for (const m of d.matchAll(/([MLZ])\s*([-\d.]+)?[,\s]*([-\d.]+)?/g)) {
    if (m[1] === "M") { ring = [[Number(m[2]), Number(m[3])]]; rings.push(ring); }
    else if (m[1] === "L" && ring) ring.push([Number(m[2]), Number(m[3])]);
  }
  return rings.every((r) => r.length >= 3 && r.every((pt) => pt.every(Number.isFinite))) && rings.length ? rings : null;
}
function inside(rings, x, y) {
  let hit = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const hitsBox = (boxes, x0, y0, x1, y1) => boxes.some(([bx0, by0, bx1, by1]) => x1 > bx0 && x0 < bx1 && y1 > by0 && y0 < by1);
// Halftone dots inside a polygon (and outside the text boxes): the dot is kept only if its centre and four edge points are inside.
function polygonDots(rings, pitch, radius, boxes) {
  const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pts = [];
  for (let y = Math.ceil(y0 / pitch) * pitch; y <= y1; y += pitch) for (let x = Math.ceil(x0 / pitch) * pitch; x <= x1; x += pitch) {
    if (!inside(rings, x, y) || !inside(rings, x + radius, y) || !inside(rings, x - radius, y) || !inside(rings, x, y + radius) || !inside(rings, x, y - radius)) continue;
    if (hitsBox(boxes, x - radius, y - radius, x + radius, y + radius)) continue;
    pts.push([x, y]);
  }
  return pts;
}
// 45-degree hatching inside a polygon: walk each line x + y = c in 1.5px steps and keep the runs that are inside and clear of the text boxes.
function polygonHatch(rings, spacing, amp, rnd, boxes) {
  const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), segs = [];
  for (let c = x0 + y0; c < x1 + y1; c += spacing) {
    let start = null, last = null;
    const flush = () => { if (start && last && Math.abs(last[0] - start[0]) > 1.2) segs.push(`M${f(start[0] + (rnd() * 2 - 1) * amp)} ${f(start[1] + (rnd() * 2 - 1) * amp)}L${f(last[0] + (rnd() * 2 - 1) * amp)} ${f(last[1] + (rnd() * 2 - 1) * amp)}`); start = last = null; };
    for (let x = Math.max(x0, c - y1); x <= Math.min(x1, c - y0); x += 1.5) {
      const y = c - x, ok = inside(rings, x, y) && !hitsBox(boxes, x - 0.5, y - 0.5, x + 0.5, y + 0.5);
      if (ok) { if (!start) start = [x, y]; last = [x, y]; } else flush();
    }
    flush();
  }
  return segs.join("");
}
function grainPattern(style, rnd) {
  const size = 160, segs = [];
  for (let i = 0; i < 90; i++) segs.push(`M${f(rnd() * size)} ${f(rnd() * size)}h.01`);
  const dark = SPECK[style];
  return `<defs><pattern id="style-paper-grain" width="${size}" height="${size}" patternUnits="userSpaceOnUse"><path d="${segs.join("")}" fill="none" stroke="${dark}" stroke-width="1.1" stroke-linecap="round" stroke-opacity="0.32"/></pattern></defs>`;
}

// ---- the style pass ------------------------------------------------------------------------------------------------------------------------
// restyleSvg(svg, style, { jitter }): `jitter` scales the offsets (default 1); only the mutation test raises it past what the checks accept.
export function restyleSvg(svg, style, options = {}) {
  if (style !== "riso" && style !== "pencil") return svg;
  const jitter = Number.isFinite(options.jitter) ? options.jitter : 1;
  const amp = JITTER_PX * jitter, accent = options.accent === true;
  const rnd = mulberry32(fnv1a(`${style}|${svg}`));
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const W = viewBox ? Number(viewBox[1]) : null, H = viewBox ? Number(viewBox[2]) : null;

  // Halftone levels (riso): the distinct fills of the grid cells, darkest last, give the dot sizes the existing class steps would have.
  // The state map's legend swatches (plain rects inside the legend group) give the full class scale, so a class no region uses does not shift the others.
  const legendGroup = /<g data-role="choropleth-legend">([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? "";
  const legendFills = [...new Set([...legendGroup.matchAll(TAG)].map((m) => m[0]).filter((t) => /^<rect\b/.test(t)).map((t) => attr(t, "fill")).filter(Boolean))];
  const cellFills = [...new Set(legendFills.length >= 2 ? legendFills : [...svg.matchAll(TAG)].map((m) => m[0]).filter((t) => /data-role="(?:heatmap-cell|tile-map-legend-class|choropleth-data)"/.test(t)).map((t) => attr(t, "fill")).filter(Boolean))]
    .map((fill) => ({ fill, lum: luminance(parseColor(fill) ?? [255, 255, 255]) })).sort((a, b) => b.lum - a.lum);
  const levelOf = (fill) => { const i = cellFills.findIndex((c) => c.fill === fill); return i < 0 || cellFills.length < 2 ? 0.5 : i / (cellFills.length - 1); };

  // Title strips: a tile that carries data-header-h gets a paper-coloured strip that tall across its top; its name and number are written on the strip
  // in the dark ink, and the dots / hatching start below it (the contrast check sees the paper strip as the backdrop of that text).
  const strips = [...svg.matchAll(TAG)].map((m) => m[0]).filter((t) => /^<rect\b/.test(t) && attr(t, "data-header-h") !== null)
    .map((t) => ({ x: num(attr(t, "x")) ?? 0, y: num(attr(t, "y")) ?? 0, w: num(attr(t, "width")) ?? 0, h: num(attr(t, "data-header-h")) ?? 0 }));
  const onStrip = (x, y) => x !== null && y !== null && strips.some((s) => x >= s.x - 1 && x <= s.x + s.w + 1 && y > s.y && y <= s.y + s.h + 1);
  // riso: a value tile / legend swatch is not filled: the paper shows and only the halftone dots carry the value. Everything printed inside one is the dark ink.
  const CLEARED_ROLE = /^(heatmap-cell|tile-map-legend-class)$/;
  const cleared = style !== "riso" ? [] : [...svg.matchAll(TAG)].map((m) => m[0]).filter((t) => /^<rect\b/.test(t) && CLEARED_ROLE.test(attr(t, "data-role") ?? "") && (num(attr(t, "width")) ?? 0) > 8 && (num(attr(t, "height")) ?? 0) > 8 && attr(t, "fill") && attr(t, "fill") !== "none")
    .map((t) => ({ x: num(attr(t, "x")) ?? 0, y: num(attr(t, "y")) ?? 0, w: num(attr(t, "width")), h: num(attr(t, "height")), fill: attr(t, "fill") }));
  const tileLines = style !== "riso" ? [] : [...svg.matchAll(TAG)].map((m) => m[0]).filter((t) => /^<polyline\b/.test(t) && /data-role="tile-map-line(?:-provisional)?"/.test(t))
    .map((t) => (attr(t, "points") ?? "").trim().split(/\s+/).map((q) => q.split(",").map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite)));
  const tileMarks = style !== "riso" ? [] : [...svg.matchAll(TAG)].map((m) => m[0]).filter((t) => /^<circle\b/.test(t) && /data-role="tile-map-point"/.test(t))
    .map((t) => [num(attr(t, "cx")), num(attr(t, "cy")), num(attr(t, "r")) ?? 2.8]).filter((q) => q.every((v) => v !== null));
  const areaAt = (x, y) => (x === null || y === null ? null : cleared.filter((c) => x >= c.x - 1 && x <= c.x + c.w + 1 && y >= c.y - 1 && y <= c.y + c.h + 1).sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null);
  const stripInk = style === "riso" ? INK_DEEP : GRAPHITE;
  // Pass A: text. Colour, hand-lettered font and (pencil) the bounded offset; the final boxes are the no-draw zones of every decoration.
  const boxes = [];
  const storyDots = /data-role="(?:people-dot|clock-dot|clock-sector)"/.test(svg);
  const lettered = svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, (element) => {
    const open = /^<text\b[^>]*>/.exec(element)[0];
    let out = open;
    const fill = attr(open, "fill");
    if (fill && fill !== "none") out = setAttr(out, "fill", recolor(fill, style, accent));
    let x = num(attr(open, "x")), y = num(attr(open, "y"));
    // a text halo is printed in the paper colour (a pure white halo would show as white patches on the paper); text on a paper strip or on a cleared tile needs none
    const stroke0 = attr(open, "stroke");
    if (stroke0 && stroke0 !== "none") out = setAttr(out, "stroke", PAPER[style]);
    if (onStrip(x, y) || areaAt(x, y)) {
      out = setAttr(out, "fill", stripInk);
      for (const a of ["stroke", "stroke-width", "stroke-linejoin", "paint-order"]) out = out.replace(new RegExp(`\\s${a}="[^"]*"`), "");
    }
    const role = attr(open, "data-role") ?? "", size0 = num(attr(open, "font-size")) ?? 12;
    if (style === "riso") {
      // riso: titles and legends in the system Song (serif) face. No text is ever offset or doubled: the mis-registration lives only on accent-ink faces.
      const isTitle = size0 >= 24, isLegend = /legend|tile-map-order|tile-map-unit|highlight-key/.test(role);
      if (isTitle || isLegend) out = setAttr(out, "font-family", SONG_FONT);
      if (isTitle && x !== null && y !== null) out = setAttr(out, "fill", INK_DEEP);
      if (isLegend) out = setAttr(out, "fill", INK_DEEP);
      if (/^choropleth-label(-value)?$/.test(role)) {
        // regions are paper now, so a region label is always dark ink on paper, with no halo
        out = setAttr(out, "fill", INK_DEEP);
        for (const a of ["stroke", "stroke-width", "stroke-linejoin", "paint-order"]) out = out.replace(new RegExp(`\\s${a}="[^"]*"`), "");
      }
    }
    if (style === "pencil") {
      out = setAttr(out, "font-family", HAND_FONT);
      
    }
    if (x !== null && y !== null) {
      const size = num(attr(open, "font-size")) ?? 12, content = element.replace(/<[^>]*>/g, ""), width = estimateTextWidth(content, size, (attr(open, "font-weight") ?? "") >= "600");
      const anchor = attr(open, "text-anchor"), left = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
      const pad = 1.5 + amp;
      boxes.push([left - pad, y - 0.8 * size - pad, left + width + pad, y + 0.25 * size + pad]);
    }
    return out + element.slice(open.length);
  });

  let backgroundDone = false, inLegend = false;
  const body = lettered.replace(TAG, (tag) => {
    const name = /^<(\w+)/.exec(tag)?.[1];
    if (tag.startsWith("</")) { if (name === "g") inLegend = false; return tag; }
    if (name === "g" && /data-role="choropleth-legend"/.test(tag)) inLegend = true;
    if (!name) return tag;
    if (name === "svg") return setAttr(tag, "data-render-style", style);
    let out = tag;
    const extra = [];
    const fill = attr(tag, "fill"), stroke = attr(tag, "stroke");
    const isBackground = name === "rect" && !backgroundDone && W !== null && num(attr(tag, "width")) === W && num(attr(tag, "height")) === H && num(attr(tag, "x") ?? 0) === 0;
    if (isBackground) {
      backgroundDone = true;
      return `${setAttr(tag, "fill", PAPER[style])}${grainPattern(style, rnd)}<rect width="${W}" height="${H}" fill="url(#style-paper-grain)"/>`;
    }
    let inkFill = fill, inkStroke = stroke;
    // K254: in a people / clock dot chart the pencil-grey fill is one person; grey-blue is another meaning (riso: "fell very little"), so that grey is not re-inked.
    const personGrey = storyDots && fill && fill.toLowerCase() === STORY_COLORS.pencil.toLowerCase();
    if (fill && fill !== "none") { inkFill = personGrey ? fill : recolor(fill, style, accent); out = setAttr(out, "fill", inkFill); }
    if (stroke && stroke !== "none") { inkStroke = recolor(stroke, style, accent); out = setAttr(out, "stroke", inkStroke); }
    const roleOf = attr(tag, "data-role") ?? "";
    let clearedRect = false;
    const mapLegendSwatch = style === "riso" && inLegend && name === "rect" && fill && fill !== "none";
    if (style === "riso" && name === "rect" && roleOf === "choropleth-ocean") {
      inkFill = PAPER.riso; out = setAttr(out, "fill", PAPER.riso);
      if (stroke && stroke !== "none") { inkStroke = INK_RULE; out = setAttr(out, "stroke", INK_RULE); }
    } else if (style === "riso" && name === "path" && roleOf === "choropleth-data" && fill && fill !== "none") {
      // a state is not filled either: the boundary is an ink line and the dots carry the class
      inkFill = PAPER.riso; out = setAttr(out, "fill", PAPER.riso);
      inkStroke = INK_BLUE; out = setAttr(setAttr(out, "stroke", INK_BLUE), "stroke-width", "0.8");
    } else if (mapLegendSwatch || (style === "riso" && name === "rect" && CLEARED_ROLE.test(roleOf) && fill && fill !== "none" && (num(attr(tag, "width")) ?? 0) > 8 && (num(attr(tag, "height")) ?? 0) > 8)) {
      clearedRect = true; inkFill = PAPER.riso;
      out = setAttr(out, "fill", PAPER.riso);
      if (stroke && stroke !== "none") { inkStroke = INK_RULE; out = setAttr(out, "stroke", INK_RULE); }
      else if (mapLegendSwatch) { inkStroke = INK_RULE; out = setAttr(setAttr(out, "stroke", INK_RULE), "stroke-width", "1"); }
    } else if (style === "riso" && (name === "circle" || name === "polyline" || name === "line")) {
      const probe = name === "circle" ? [num(attr(tag, "cx")), num(attr(tag, "cy"))] : name === "line" ? [num(attr(tag, "x1")), num(attr(tag, "y1"))] : (attr(tag, "points") ?? "").trim().split(/\s+/)[0]?.split(",").map(Number) ?? [null, null];
      const area = areaAt(probe[0] ?? null, probe[1] ?? null);
      if (area) {
        if (stroke && stroke !== "none") { inkStroke = INK_BLUE; out = setAttr(out, "stroke", INK_BLUE); }
        if (fill && fill !== "none") { inkFill = fill === area.fill ? PAPER.riso : INK_BLUE; out = setAttr(out, "fill", inkFill); }
      }
    }
    if (name === "rect" && /^tile-map-highlight(-key)?$/.test(roleOf)) {
      // the thick frame: dark ink, never the accent colour (the accent belongs to one meaning only)
      inkStroke = stripInk; out = setAttr(setAttr(out, "stroke", stripInk), "stroke-width", "3.5");
    }

    if (name === "text") return tag; // done in pass A

    const warm = (c) => { const rgb = parseColor(c); return accent && rgb ? hueFamily(rgb) === "warm" : false; };
    const registered = style === "riso" && !clearedRect && !/^tile-map-highlight/.test(roleOf) && ((fill && fill !== "none" && warm(fill)) || (stroke && stroke !== "none" && !(fill && fill !== "none") && warm(stroke)));
    if (registered && ["rect", "circle", "polyline", "path", "line"].includes(name)) out = setAttr(out, "transform", `translate(${MISREGISTER_PX[0]} ${MISREGISTER_PX[1]})`);

    if (name === "rect") {
      const x = num(attr(tag, "x")) ?? 0, y = num(attr(tag, "y")) ?? 0, w = num(attr(tag, "width")), h = num(attr(tag, "height"));
      if (w === null || h === null) return out;
      const role = attr(tag, "data-role") ?? "";
      const filled = fill && fill !== "none", rgb = filled ? parseColor(fill) : null;
      const headerH = num(attr(tag, "data-header-h")) ?? 0; // > 0: a tile with a paper title strip across its top
      if (headerH > 0) extra.push(`<rect x="${f(x + 0.5)}" y="${f(y + 0.5)}" width="${f(w - 1)}" height="${f(headerH - 0.5)}" rx="1.5" fill="${PAPER[style]}"/>`);
      if (clearedRect) {
        // the halftone on bare paper: the dot size alone carries the value class (darkest class = biggest dots); the dots start under the title strip.
        // A warm (accent) class prints its dots in the accent ink with the fixed mis-registration; every other class in the grey-blue ink.
        const level = levelOf(fill), pitch = HALFTONE_PITCH, diameter = pitch * (HALFTONE_DIAMETER[0] + HALFTONE_DIAMETER[1] * level);
        const warmClass = accent && hueFamily(rgb) === "warm";
        const inTile = (q) => q[0] >= x && q[0] <= x + w && q[1] >= y && q[1] <= y + h;
        const pts = dotPoints(x + 2, y + headerH + 2, w - 4, h - headerH - 4, pitch, diameter / 2, boxes, tileLines.filter((q) => inTile(q[0])), tileMarks.filter(inTile));
        extra.push(dotPaths(pts, diameter, warmClass ? INK_CORAL : INK_BLUE, rnd, warmClass ? ` transform="translate(${MISREGISTER_PX[0]} ${MISREGISTER_PX[1]})"` : ""));
      }
      // hand-drawn rules (pencil, and the riso tile borders / thick frame): a wobbly outline drawn twice
      const handRect = style === "pencil" ? w > 3 && h > 3 && /(cell|tile|highlight|legend-class)/.test(role) : style === "riso" && (clearedRect || /^tile-map-highlight(-key)?$/.test(role)) && w > 3 && h > 3;
      if (style === "riso" && handRect) {
        const colour = /^tile-map-highlight/.test(role) ? stripInk : INK_BLUE;
        for (let pass = 0; pass < 2; pass++) extra.push(`<path d="${pathOf(wobble(rectPoints(x, y, w, h), amp, rnd, true))}" fill="none" stroke="${colour}" stroke-width="${pass ? 0.7 : 1}" stroke-opacity="${pass ? 0.4 : 0.6}" stroke-linejoin="round"/>`);
      }
      if (style === "pencil" && w > 3 && h > 3 && /(cell|tile|highlight|legend-class)/.test(role)) {
        const colour = inkStroke && inkStroke !== "none" && role.includes("highlight") ? inkStroke : GRAPHITE;
        for (let pass = 0; pass < 2; pass++) extra.push(`<path d="${pathOf(wobble(rectPoints(x, y, w, h), amp, rnd, true))}" fill="none" stroke="${colour}" stroke-width="${pass ? 0.7 : 1}" stroke-opacity="${pass ? 0.45 : 0.7}" stroke-linejoin="round"/>`);
        if (filled && rgb && w > 8 && h > 8 && !isBackground) {
          const dark = 1 - luminance(parseColor(inkFill));
          if (dark > 0.12) extra.push(`<path d="${hatch(x + 1, y + headerH + 1, w - 2, h - headerH - 2, Math.max(3, 10 - dark * 8), amp * 0.6, rnd, boxes)}" fill="none" stroke="${GRAPHITE}" stroke-width="0.8" stroke-opacity="0.45"/>`);
        }
      }
    } else if (name === "path" && /data-role="choropleth-data"/.test(tag) && fill && fill !== "none") {
      const rings = ringsOf(attr(tag, "d") ?? "");
      if (rings) {
        if (style === "riso") {
          const pitch = HALFTONE_PITCH, diameter = pitch * (HALFTONE_DIAMETER[0] + HALFTONE_DIAMETER[1] * levelOf(fill));
          extra.push(dotPaths(polygonDots(rings, pitch, diameter / 2, boxes), diameter, INK_BLUE, rnd));
          // the hand-drawn boundary: the outline wobbles and is drawn twice (kept clear of the text boxes, like the pencil one)
          for (const ring of rings) for (let pass = 0; pass < 2; pass++) {
            const pts = wobble(ring, amp * 0.7, rnd, true);
            if (!pts.some(([qx, qy]) => hitsBox(boxes, qx - 1, qy - 1, qx + 1, qy + 1))) extra.push(`<path d="${pathOf(pts)}" fill="none" stroke="${INK_BLUE}" stroke-width="${pass ? 0.6 : 0.8}" stroke-opacity="${pass ? 0.4 : 0.6}" stroke-linejoin="round"/>`);
          }
        } else {
          // the repeated outline is drawn only where it stays clear of every text box (a label sitting on a small state's edge keeps the house outline alone)
          for (const ring of rings) for (let pass = 0; pass < 2; pass++) {
            const pts = wobble(ring, amp * 0.7, rnd, true);
            if (!pts.some(([x, y]) => hitsBox(boxes, x - 1, y - 1, x + 1, y + 1))) extra.push(`<path d="${pathOf(pts)}" fill="none" stroke="${GRAPHITE}" stroke-width="${pass ? 0.6 : 0.8}" stroke-opacity="${pass ? 0.4 : 0.6}" stroke-linejoin="round"/>`);
          }
          const dark = 1 - luminance(parseColor(inkFill));
          if (dark > 0.12) { const h = polygonHatch(rings, Math.max(3, 9 - dark * 7), amp * 0.5, rnd, boxes); if (h) extra.push(`<path d="${h}" fill="none" stroke="${GRAPHITE}" stroke-width="0.7" stroke-opacity="0.45"/>`); }
        }
      }
    } else if (name === "polyline" || name === "line") {
      if ((style === "pencil" || (style === "riso" && inkStroke === INK_BLUE)) && inkStroke && inkStroke !== "none") {
        let pts = null;
        if (name === "polyline") pts = (attr(tag, "points") ?? "").trim().split(/\s+/).map((p) => p.split(",").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
        else { const a = [num(attr(tag, "x1")), num(attr(tag, "y1")), num(attr(tag, "x2")), num(attr(tag, "y2"))]; if (a.every((v) => v !== null)) pts = [[a[0], a[1]], [a[2], a[3]]]; }
        if (pts && pts.length >= 2) for (let pass = 0; pass < 2; pass++) extra.push(`<path d="${pathOf(wobble(pts, amp, rnd))}" fill="none" stroke="${inkStroke}" stroke-width="${pass ? 0.8 : 1.1}" stroke-opacity="${pass ? 0.45 : 0.6}" stroke-linecap="round" stroke-linejoin="round"${attr(tag, "stroke-dasharray") ? ` stroke-dasharray="${attr(tag, "stroke-dasharray")}"` : ""}/>`);
      }
    } else if (name === "circle") {
      const cx = num(attr(tag, "cx")), cy = num(attr(tag, "cy")), r = num(attr(tag, "r"));
      if (style === "pencil" && cx !== null && cy !== null && r !== null && r > 1.5 && !boxes.some(([x0, y0, x1, y1]) => Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy) <= r)) extra.push(`<path d="${pathOf(wobble(circlePoints(cx, cy, r), Math.min(amp, r * 0.2), rnd, true))}" fill="none" stroke="${inkStroke && inkStroke !== "none" ? inkStroke : (inkFill && inkFill !== "none" ? inkFill : GRAPHITE)}" stroke-width="0.9" stroke-opacity="0.6"/>`);
    }
    return extra.length ? out + extra.join("") : out;
  });
  return body;
}

// The style a spec asks for under the switch: absent or unknown -> house (unknown values are a lint blocker, see renderStyleErrors).
// K254: emphasis_tone "coral" is the accent ink by itself (coral = synthetic opioids only, the same one-colour-one-meaning rule); without it
// riso/pencil would re-ink the plan's coral line or dots in the base ink and the page would lose its one flagged colour.
export const specRenderAccent = (spec) => spec?.render_accent === true || spec?.emphasis_tone === "coral";
export function specRenderStyle(spec, pageDefault) {
  const own = spec?.render_style;
  if (RENDER_STYLES.includes(own)) return own;
  return RENDER_STYLES.includes(pageDefault) ? pageDefault : "house";
}
export function renderStyleErrors(spec) {
  const errors = [];
  if (spec?.render_style !== undefined && !RENDER_STYLES.includes(spec.render_style)) errors.push(`render_style must be one of ${RENDER_STYLES.join(", ")}`);
  if (spec?.render_accent !== undefined && typeof spec.render_accent !== "boolean") errors.push("render_accent must be true or false");
  if (spec?.highlight_label !== undefined) {
    const label = spec.highlight_label;
    if (typeof label !== "string" || !label.trim() || label.length > 24) errors.push("highlight_label must be a short text (1 to 24 characters) naming what the thick frame marks");
    else {
      // model-written words go through the same number rules as a claim: no typed digit, no number word, no placeholder (the threshold lives in the SQL column; the program, not the label, prints any number)
      if (/[0-9\uFF10-\uFF19]/.test(label)) errors.push("highlight_label has a typed number; name the group in words (the SQL column decides which tiles are framed; a threshold number is never written by hand)");
      const worded = numberWordIn(label);
      if (worded !== null) errors.push(`highlight_label has a number word (near "${worded}"); name the group without a number`);
      if (/[{}]/.test(label)) errors.push("highlight_label takes no placeholder; name the group in words");
    }
  }
  return errors;
}
