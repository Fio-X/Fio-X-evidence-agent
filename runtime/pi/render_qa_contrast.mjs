// Deterministic WCAG 2.x text-contrast check over a rendered SVG string.
//
// Ports the idea behind the owner's accepted browser-based page QA
// (experiments/infographic/africa/qa.mjs, read-only reference) to a static
// SVG string: find each visible text run -- a <text> or <tspan> that
// directly contains character data, since a wrapping <text>/<tspan>'s own
// fill is never painted as glyphs when every child is a coloured <tspan> --
// resolve its foreground colour through inheritance, find the topmost
// filled shape painted under its anchor point, blend down to the page
// background, and compare against the WCAG contrast ratio required for its
// font size/weight. It is pure and deterministic: no browser, no network,
// no new dependencies -- just a small XML tokenizer, a 2D affine transform
// resolver, and the WCAG relative-luminance formula.
//
// No existing colour/contrast helper was found under runtime/pi/ to reuse
// (checked for luminance/contrast/hex-to-rgb helpers before writing this).
//
// The XML tokenizer and 2D affine transform engine below were split out
// into render_qa_svg.mjs (T6a) so render_qa_geometry.mjs's own transform
// resolution could reuse the same tested code; this file just imports them
// back unchanged.

import { parseXml, hasAncestorIn, IDENTITY, multiply, invert, apply, ownTransformMatrix } from "./render_qa_svg.mjs";

export const RENDER_QA_CONTRAST_VERSION = "1.0.0";

const NORMAL_TEXT_RATIO = 4.5;
const LARGE_TEXT_RATIO = 3;
const LARGE_TEXT_MIN_PX = 24;
const LARGE_TEXT_BOLD_MIN_PX = 18.66;
const LARGE_TEXT_BOLD_WEIGHT = 700;
const HALO_MIN_STROKE_WIDTH = 2;
const DEFAULT_PAGE_BACKGROUND = "#ffffff";

const SHAPE_TAGS = new Set(["rect", "circle", "ellipse", "polygon", "polyline", "path", "image"]);
const NON_PAINTING_CONTAINERS = new Set(["defs", "symbol", "clipPath", "mask", "pattern"]);

const NAMED_COLORS = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  maroon: [128, 0, 0], purple: [128, 0, 128], fuchsia: [255, 0, 255], lime: [0, 255, 0],
  olive: [128, 128, 0], navy: [0, 0, 128], teal: [0, 128, 128], aqua: [0, 255, 255], cyan: [0, 255, 255],
  orange: [255, 165, 0], pink: [255, 192, 203], brown: [165, 42, 42],
};

// ---------------------------------------------------------------------------
// Simple CSS: <style> blocks with tag/class/id/universal selectors only.
// Combinators, attribute selectors, pseudo-classes and at-rules are treated
// as "not simple" and silently ignored (never crash, never guess).
// ---------------------------------------------------------------------------

function parseSimpleSelector(sel) {
  if (sel === "*") return { kind: "all", value: null, specificity: 0 };
  if (/^[a-zA-Z][\w-]*$/.test(sel)) return { kind: "tag", value: sel, specificity: 1 };
  if (/^\.[\w-]+$/.test(sel)) return { kind: "class", value: sel.slice(1), specificity: 2 };
  if (/^#[\w-]+$/.test(sel)) return { kind: "id", value: sel.slice(1), specificity: 3 };
  return null;
}

function parseStylesheet(cssText) {
  const rules = [];
  const body = String(cssText ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m, order = 0;
  while ((m = ruleRe.exec(body))) {
    const decls = {};
    for (const part of m[2].split(";")) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      const prop = part.slice(0, idx).trim().toLowerCase();
      if (prop) decls[prop] = part.slice(idx + 1).trim();
    }
    for (const rawSel of m[1].split(",")) {
      const parsed = parseSimpleSelector(rawSel.trim());
      if (parsed) rules.push({ ...parsed, decls, order: order++ });
    }
  }
  return rules;
}

function collectStyleRules(root) {
  const styleNodes = [];
  (function walk(n) { if (n.tag === "style") styleNodes.push(n); for (const c of n.children) walk(c); })(root);
  let rules = [];
  for (const node of styleNodes) rules = rules.concat(parseStylesheet(node.text));
  return rules;
}

function selectorMatches(rule, node) {
  if (rule.kind === "all") return true;
  if (rule.kind === "tag") return node.tag === rule.value;
  if (rule.kind === "id") return node.attrs.id === rule.value;
  if (rule.kind === "class") return (node.attrs.class || "").split(/\s+/).includes(rule.value);
  return false;
}

function parseInlineStyle(str) {
  if (!str) return null;
  const out = {};
  for (const part of str.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    if (prop) out[prop] = part.slice(idx + 1).trim();
  }
  return out;
}

function specifiedValue(node, prop, styleRules) {
  const inline = parseInlineStyle(node.attrs.style);
  if (inline && Object.prototype.hasOwnProperty.call(inline, prop)) return inline[prop];
  let best;
  for (const rule of styleRules) {
    if (!Object.prototype.hasOwnProperty.call(rule.decls, prop)) continue;
    if (!selectorMatches(rule, node)) continue;
    if (!best || rule.specificity > best.specificity || (rule.specificity === best.specificity && rule.order > best.order)) best = rule;
  }
  if (best) return best.decls[prop];
  if (Object.prototype.hasOwnProperty.call(node.attrs, prop)) return node.attrs[prop];
  return undefined;
}

function resolveInherited(node, prop, styleRules, fallback) {
  for (let n = node; n; n = n.parent) {
    const v = specifiedValue(n, prop, styleRules);
    if (v !== undefined) return v;
  }
  return fallback;
}

function parseAlphaValue(v) {
  const s = String(v ?? "").trim();
  if (s.endsWith("%")) return parseFloat(s) / 100;
  return parseFloat(s);
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

function cumulativeOpacity(node, styleRules) {
  let product = 1;
  for (let n = node; n; n = n.parent) {
    const v = specifiedValue(n, "opacity", styleRules);
    if (v === undefined) continue;
    const num = parseAlphaValue(v);
    if (Number.isFinite(num)) product *= clamp01(num);
  }
  return product;
}

function isHidden(node, styleRules) {
  for (let n = node; n; n = n.parent) {
    const d = specifiedValue(n, "display", styleRules);
    if (d !== undefined && d.trim().toLowerCase() === "none") return true;
  }
  const vis = resolveInherited(node, "visibility", styleRules, "visible");
  return String(vis).trim().toLowerCase() === "hidden";
}

// ---------------------------------------------------------------------------
// Colour parsing. Returns { none: true } for "none"/"transparent", or
// { unresolved: true } for gradients/patterns/currentColor/anything we don't
// recognise (callers must not silently treat this as a solid colour), or a
// resolved { r, g, b, a }.
// ---------------------------------------------------------------------------

function parseColor(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "" || v === "none" || v === "transparent") return { none: true };
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(v))) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  if ((m = /^#([0-9a-f]{4})$/i.exec(v))) {
    const c = m[1];
    return { r: parseInt(c[0] + c[0], 16), g: parseInt(c[1] + c[1], 16), b: parseInt(c[2] + c[2], 16), a: parseInt(c[3] + c[3], 16) / 255 };
  }
  if ((m = /^#([0-9a-f]{6})$/i.exec(v))) {
    const c = m[1];
    return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: 1 };
  }
  if ((m = /^#([0-9a-f]{8})$/i.exec(v))) {
    const c = m[1];
    return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16), a: parseInt(c.slice(6, 8), 16) / 255 };
  }
  if ((m = /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(v))) {
    const chan = (s) => (s.endsWith("%") ? Math.round((parseFloat(s) * 255) / 100) : Math.round(parseFloat(s)));
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: chan(m[1]), g: chan(m[2]), b: chan(m[3]), a };
  }
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, v)) {
    const [r, g, b] = NAMED_COLORS[v];
    return { r, g, b, a: 1 };
  }
  return { unresolved: true };
}

function resolveFillInfo(node, styleRules) {
  if (node.tag === "image") {
    return { color: { unresolved: true }, alpha: cumulativeOpacity(node, styleRules) };
  }
  const rawFill = resolveInherited(node, "fill", styleRules, "#000000");
  const color = parseColor(rawFill);
  if (color.none) return { color, alpha: 0 };
  if (color.unresolved) return { color, alpha: 1 };
  const fillOpacity = clamp01(parseAlphaValue(resolveInherited(node, "fill-opacity", styleRules, "1")));
  const alpha = clamp01(fillOpacity * (color.a ?? 1)) * cumulativeOpacity(node, styleRules);
  return { color, alpha };
}

// ---------------------------------------------------------------------------
// Per-document transform annotation: walk the tree once, giving every node
// an `accumMatrix` (root-to-node composition of `ownTransformMatrix`, or
// `null` if anything in the chain is unresolved). The primitives themselves
// (multiply/invert/apply/ownTransformMatrix/...) now live in render_qa_svg.mjs.
// ---------------------------------------------------------------------------

function annotateTransforms(root) {
  const walk = (node, parentAccum) => {
    const own = ownTransformMatrix(node);
    node.accumMatrix = own === null || parentAccum === null ? null : multiply(own, parentAccum);
    for (const child of node.children) walk(child, node.accumMatrix);
  };
  walk(root, IDENTITY);
}

// ---------------------------------------------------------------------------
// Shape geometry, resolved in the shape's own local coordinate space so that
// containment testing after an inverse-transform is exact. rect/circle/
// ellipse use their analytic formulas. polygon, polyline (filled as if
// closed, per SVG) and paths made only of straight-line commands (M/L/H/V/Z,
// any number of subpaths -- d3-geo emits one M...Z run per island/ring) use
// an exact point-in-polygon test under the shape's own fill-rule (nonzero by
// default, evenodd when specified, inherited). Curved paths (C/S/Q/T/A) --
// or path data we cannot parse -- fall back to a safe superset bounding box
// (a Bezier curve always lies within the convex hull, hence the bbox, of its
// control points) that can only rule a candidate OUT, never IN: when the
// anchor falls inside that superset box we cannot tell if the true curve
// covers it, so it is reported as unmeasured rather than guessed.
// ---------------------------------------------------------------------------

function parsePoints(str) {
  const nums = (String(str ?? "").match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) || []).map(Number);
  if (nums.length < 4 || nums.length % 2 !== 0) return null;
  const pts = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

// Parses path data into per-subpath point rings (one ring per M...Z run) plus
// an overall bounding box, and flags whether any curve command was used.
// Rings are treated as implicitly closed by the caller (ray casting wraps
// the last point back to the first), matching how SVG always closes a
// subpath for fill purposes even without an explicit Z.
function parsePathGeometry(d) {
  const tokens = String(d ?? "").match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
  if (!tokens) return null;
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = null, hasCurve = false;
  const subpaths = [];
  let current = null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const pushBBox = (x, y) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  const startSubpath = (x, y) => { current = [{ x, y }]; subpaths.push(current); pushBBox(x, y); };
  const pushPoint = (x, y) => { pushBBox(x, y); if (current) current.push({ x, y }); };
  const num = () => { if (i >= tokens.length) return NaN; const v = Number(tokens[i++]); return Number.isFinite(v) ? v : NaN; };
  const isCmd = (t) => /^[A-Za-z]$/.test(t);
  while (i < tokens.length) {
    if (isCmd(tokens[i])) { cmd = tokens[i]; i++; }
    if (!cmd) return null;
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": { const x = num(), y = num(); if (!Number.isFinite(x) || !Number.isFinite(y)) return null; cx = rel ? cx + x : x; cy = rel ? cy + y : y; sx = cx; sy = cy; startSubpath(cx, cy); cmd = rel ? "l" : "L"; break; }
      case "L": { const x = num(), y = num(); if (!Number.isFinite(x) || !Number.isFinite(y)) return null; cx = rel ? cx + x : x; cy = rel ? cy + y : y; pushPoint(cx, cy); break; }
      case "H": { const x = num(); if (!Number.isFinite(x)) return null; cx = rel ? cx + x : x; pushPoint(cx, cy); break; }
      case "V": { const y = num(); if (!Number.isFinite(y)) return null; cy = rel ? cy + y : y; pushPoint(cx, cy); break; }
      case "C": { hasCurve = true; const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num(); if ([x1, y1, x2, y2, x, y].some((n) => !Number.isFinite(n))) return null; const X1 = rel ? cx + x1 : x1, Y1 = rel ? cy + y1 : y1, X2 = rel ? cx + x2 : x2, Y2 = rel ? cy + y2 : y2, X = rel ? cx + x : x, Y = rel ? cy + y : y; pushBBox(X1, Y1); pushBBox(X2, Y2); pushPoint(X, Y); cx = X; cy = Y; break; }
      case "S": { hasCurve = true; const x2 = num(), y2 = num(), x = num(), y = num(); if ([x2, y2, x, y].some((n) => !Number.isFinite(n))) return null; const X2 = rel ? cx + x2 : x2, Y2 = rel ? cy + y2 : y2, X = rel ? cx + x : x, Y = rel ? cy + y : y; pushBBox(X2, Y2); pushPoint(X, Y); cx = X; cy = Y; break; }
      case "Q": { hasCurve = true; const x1 = num(), y1 = num(), x = num(), y = num(); if ([x1, y1, x, y].some((n) => !Number.isFinite(n))) return null; const X1 = rel ? cx + x1 : x1, Y1 = rel ? cy + y1 : y1, X = rel ? cx + x : x, Y = rel ? cy + y : y; pushBBox(X1, Y1); pushPoint(X, Y); cx = X; cy = Y; break; }
      case "T": { hasCurve = true; const x = num(), y = num(); if (!Number.isFinite(x) || !Number.isFinite(y)) return null; cx = rel ? cx + x : x; cy = rel ? cy + y : y; pushPoint(cx, cy); break; }
      case "A": { hasCurve = true; const rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), x = num(), y = num(); if ([rx, ry, rot, laf, sf, x, y].some((n) => !Number.isFinite(n))) return null; const X = rel ? cx + x : x, Y = rel ? cy + y : y; pushBBox(X - Math.abs(rx), Y - Math.abs(ry)); pushBBox(X + Math.abs(rx), Y + Math.abs(ry)); pushPoint(X, Y); cx = X; cy = Y; break; }
      case "Z": cx = sx; cy = sy; cmd = null; break;
      default: return null;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { subpaths, hasCurve, minX, maxX, minY, maxY };
}

// Ray-casting point-in-polygon across every subpath combined, so a hole ring
// correctly cancels its enclosing ring and an island ring correctly adds
// another filled region, under the given fill-rule. Each ring is treated as
// implicitly closed (wraps its last point back to its first).
function pointInSubpaths(p, subpaths, fillRule) {
  let winding = 0, crossings = 0;
  for (const ring of subpaths) {
    const n = ring.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      if (a.y === b.y) continue;
      const upward = b.y > a.y;
      const y1 = upward ? a.y : b.y, y2 = upward ? b.y : a.y;
      if (p.y < y1 || p.y >= y2) continue; // half-open interval: no double-counting shared vertices
      const xCross = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (xCross > p.x) { crossings++; winding += upward ? 1 : -1; }
    }
  }
  return fillRule === "evenodd" ? crossings % 2 !== 0 : winding !== 0;
}

function geometryOf(node) {
  const num = (k, d = 0) => { const v = parseFloat(node.attrs[k]); return Number.isFinite(v) ? v : d; };
  switch (node.tag) {
    case "rect": case "image": return { kind: "rect", x: num("x"), y: num("y"), w: num("width"), h: num("height") };
    case "circle": return { kind: "circle", cx: num("cx"), cy: num("cy"), r: num("r") };
    case "ellipse": return { kind: "ellipse", cx: num("cx"), cy: num("cy"), rx: num("rx"), ry: num("ry") };
    case "polygon": case "polyline": {
      const pts = parsePoints(node.attrs.points);
      if (!pts) return null;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return { kind: "polygon", subpaths: [pts], minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    case "path": {
      const parsed = parsePathGeometry(node.attrs.d);
      if (!parsed) return null;
      if (parsed.hasCurve) return { kind: "bbox", minX: parsed.minX, maxX: parsed.maxX, minY: parsed.minY, maxY: parsed.maxY };
      return { kind: "polygon", subpaths: parsed.subpaths, minX: parsed.minX, maxX: parsed.maxX, minY: parsed.minY, maxY: parsed.maxY };
    }
    default: return null;
  }
}

function containment(shape, p) {
  const g = shape.__geom;
  if (!g) return "unknown";
  switch (g.kind) {
    case "rect": return p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h ? "inside" : "outside";
    case "circle": { const r2 = g.r * g.r; return r2 > 0 && (p.x - g.cx) ** 2 + (p.y - g.cy) ** 2 <= r2 ? "inside" : "outside"; }
    case "ellipse": return g.rx > 0 && g.ry > 0 && ((p.x - g.cx) / g.rx) ** 2 + ((p.y - g.cy) / g.ry) ** 2 <= 1 ? "inside" : "outside";
    case "polygon": {
      if (p.x < g.minX || p.x > g.maxX || p.y < g.minY || p.y > g.maxY) return "outside"; // cheap bbox reject before exact ray casting
      return pointInSubpaths(p, g.subpaths, shape.__fillRule) ? "inside" : "outside";
    }
    case "bbox": return p.x >= g.minX && p.x <= g.maxX && p.y >= g.minY && p.y <= g.maxY ? "maybe" : "outside";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// WCAG 2.x relative luminance / contrast ratio.
// ---------------------------------------------------------------------------

function srgbToLinear(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(c) {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1), l2 = relativeLuminance(c2);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function blend(fg, alpha, bg) {
  return { r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha) };
}

function rgbToHex(c) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function truncate(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function describeElement(node, index) {
  const parts = [`${node.tag}[${index}]`];
  if (node.attrs.id) parts.push(`#${node.attrs.id}`);
  if (node.attrs["data-role"]) parts.push(`[data-role="${node.attrs["data-role"]}"]`);
  // Quote the run's own direct text only (node.text), not text pulled in
  // from a nested run -- a <tspan> that both wraps another <tspan> and has
  // its own trailing text is two separate runs sharing one style context.
  const snippet = truncate((node.text || "").trim().replace(/\s+/g, " "), 40);
  if (snippet) parts.push(`"${snippet}"`);
  return parts.join(" ");
}

// A run's anchor is its own x/y when present. Otherwise, dx/dy on the run
// (and any ancestor tspan, up to the enclosing <text>) accumulate as an
// offset from the nearest ancestor text/tspan that does specify x/y, per
// axis independently. This is a documented approximation, not real SVG text
// layout: it does not model per-character dx/dy lists (only the first
// listed value at each level is used), line-wrapping via textLength, or
// baseline-shift. It is exact for the common "own x/y" case and for a
// single accumulated dy (e.g. one line below a positioned line), which
// covers every multi-line tspan pattern this repo's renderers emit.
function resolveRunAnchor(node) {
  let dxSum = 0, dySum = 0, foundX, foundY;
  for (let n = node; n && (n.tag === "text" || n.tag === "tspan"); n = n.parent) {
    if (foundX === undefined && n.attrs.dx !== undefined) {
      const v = parseFloat(String(n.attrs.dx).trim().split(/[\s,]+/)[0]);
      if (Number.isFinite(v)) dxSum += v;
    }
    if (foundY === undefined && n.attrs.dy !== undefined) {
      const v = parseFloat(String(n.attrs.dy).trim().split(/[\s,]+/)[0]);
      if (Number.isFinite(v)) dySum += v;
    }
    if (foundX === undefined && n.attrs.x !== undefined) {
      const v = parseFloat(String(n.attrs.x).trim().split(/[\s,]+/)[0]);
      if (Number.isFinite(v)) foundX = v;
    }
    if (foundY === undefined && n.attrs.y !== undefined) {
      const v = parseFloat(String(n.attrs.y).trim().split(/[\s,]+/)[0]);
      if (Number.isFinite(v)) foundY = v;
    }
    if (foundX !== undefined && foundY !== undefined) break;
  }
  if (foundX === undefined || foundY === undefined) return null;
  return { x: foundX + dxSum, y: foundY + dySum };
}

function resolveBackground(anchor, shapesSorted, textDocIndex, pageBg) {
  const layers = [];
  for (let i = shapesSorted.length - 1; i >= 0; i--) {
    const shape = shapesSorted[i];
    if (shape.docIndex >= textDocIndex) continue;
    if (!shape.__fill || shape.__fill.color.none || shape.__fill.alpha <= 0.001) continue;
    if (shape.accumMatrix === null) return { unresolved: true, reason: `unresolved transform on background candidate <${shape.tag}>` };
    const inv = invert(shape.accumMatrix);
    if (!inv) return { unresolved: true, reason: `singular (non-invertible) transform on background candidate <${shape.tag}>` };
    const local = apply(inv, anchor.x, anchor.y);
    const test = containment(shape, local);
    if (test === "outside" || test === "unknown") continue;
    if (shape.__fill.color.unresolved) return { unresolved: true, reason: `gradient, pattern or image fill on <${shape.tag}> may underlie the text` };
    if (test === "maybe") return { unresolved: true, reason: "a complex (curved) path near the text could not be resolved exactly" };
    layers.push({ color: shape.__fill.color, alpha: shape.__fill.alpha });
    if (shape.__fill.alpha >= 0.999) break;
  }
  let composite = { r: pageBg.r, g: pageBg.g, b: pageBg.b };
  for (let i = layers.length - 1; i >= 0; i--) composite = blend(layers[i].color, layers[i].alpha, composite);
  return { unresolved: false, color: composite };
}

/**
 * Deterministically check WCAG 2.x text contrast over a rendered SVG string.
 *
 * @param {string} svgText
 * @param {object} [options]
 * @param {string} [options.pageBackground="#ffffff"] Solid colour behind the whole SVG.
 * @param {number} [options.normalRatio=4.5]
 * @param {number} [options.largeRatio=3]
 * @param {number} [options.largeMinPx=24]
 * @param {number} [options.largeBoldMinPx=18.66]
 * @param {number} [options.boldWeight=700]
 * @param {number} [options.haloMinStrokeWidth=2]
 * @returns {{version:string, passed:boolean, failures:Array, unmeasured:Array}}
 */
export function checkSvgContrast(svgText, options = {}) {
  const opts = {
    pageBackground: options.pageBackground ?? DEFAULT_PAGE_BACKGROUND,
    normalRatio: options.normalRatio ?? NORMAL_TEXT_RATIO,
    largeRatio: options.largeRatio ?? LARGE_TEXT_RATIO,
    largeMinPx: options.largeMinPx ?? LARGE_TEXT_MIN_PX,
    largeBoldMinPx: options.largeBoldMinPx ?? LARGE_TEXT_BOLD_MIN_PX,
    boldWeight: options.boldWeight ?? LARGE_TEXT_BOLD_WEIGHT,
    haloMinStrokeWidth: options.haloMinStrokeWidth ?? HALO_MIN_STROKE_WIDTH,
  };
  const pageBg = parseColor(opts.pageBackground);
  if (!pageBg || pageBg.none || pageBg.unresolved) throw new Error("options.pageBackground must be a solid, resolvable colour");

  const root = parseXml(svgText);
  annotateTransforms(root);
  const styleRules = collectStyleRules(root);

  const all = [];
  (function flatten(n) { for (const c of n.children) { all.push(c); flatten(c); } })(root);

  const shapes = all
    .filter((n) => SHAPE_TAGS.has(n.tag) && !hasAncestorIn(n, NON_PAINTING_CONTAINERS))
    .map((n) => {
      n.__fill = resolveFillInfo(n, styleRules);
      n.__geom = geometryOf(n);
      n.__fillRule = String(resolveInherited(n, "fill-rule", styleRules, "nonzero")).trim().toLowerCase() === "evenodd" ? "evenodd" : "nonzero";
      return n;
    })
    .sort((a, b) => a.docIndex - b.docIndex);

  // A "run" is any <text> or <tspan> that directly contains non-whitespace
  // character data -- the actual unit of rendering. A <text> that only
  // wraps <tspan> children (its own fill never painted as glyphs) is not a
  // run; a <tspan> that both wraps a nested <tspan> and carries its own
  // trailing text contributes a run for that trailing text too.
  const runs = all.filter((n) => (n.tag === "text" || n.tag === "tspan") && !hasAncestorIn(n, NON_PAINTING_CONTAINERS) && (n.text || "").trim() !== "");

  const failures = [];
  const unmeasured = [];

  runs.forEach((runNode, i) => {
    const index = i + 1;
    if (isHidden(runNode, styleRules)) return;
    const label = describeElement(runNode, index);

    if (runNode.accumMatrix === null) { unmeasured.push({ rule: "text_contrast", element: label, reason: "unresolved transform on the text or an ancestor" }); return; }

    const anchorLocal = resolveRunAnchor(runNode);
    if (!anchorLocal) { unmeasured.push({ rule: "text_contrast", element: label, reason: "no resolvable x/y anchor point" }); return; }
    const anchor = apply(runNode.accumMatrix, anchorLocal.x, anchorLocal.y);

    const fillSpec = resolveFillInfo(runNode, styleRules);
    if (fillSpec.color.none) { unmeasured.push({ rule: "text_contrast", element: label, reason: "text has no solid fill to test (fill: none)" }); return; }
    if (fillSpec.color.unresolved) { unmeasured.push({ rule: "text_contrast", element: label, reason: "text fill is a gradient, pattern or unrecognised colour" }); return; }
    if (fillSpec.alpha <= 0.001) return; // fully invisible: nothing for a reader to contrast against

    const fontSize = parseFloat(resolveInherited(runNode, "font-size", styleRules, "16")) || 16;
    const fontWeightRaw = String(resolveInherited(runNode, "font-weight", styleRules, "normal")).trim().toLowerCase();
    const fontWeight = fontWeightRaw === "bold" ? 700 : fontWeightRaw === "normal" ? 400 : Number(fontWeightRaw) || 400;
    const isLarge = fontSize >= opts.largeMinPx || (fontSize >= opts.largeBoldMinPx && fontWeight >= opts.boldWeight);
    const required = isLarge ? opts.largeRatio : opts.normalRatio;

    let bg = null;
    const paintOrder = String(resolveInherited(runNode, "paint-order", styleRules, "normal")).trim().toLowerCase();
    if (paintOrder.startsWith("stroke")) {
      const strokeColor = parseColor(resolveInherited(runNode, "stroke", styleRules, "none"));
      const strokeWidth = parseFloat(resolveInherited(runNode, "stroke-width", styleRules, "1"));
      if (!strokeColor.none && strokeWidth >= opts.haloMinStrokeWidth) {
        if (strokeColor.unresolved) { unmeasured.push({ rule: "text_contrast", element: label, reason: "halo stroke is a gradient, pattern or unrecognised colour" }); return; }
        bg = { r: strokeColor.r, g: strokeColor.g, b: strokeColor.b };
      }
    }

    if (!bg) {
      const resolved = resolveBackground(anchor, shapes, runNode.docIndex, pageBg);
      if (resolved.unresolved) { unmeasured.push({ rule: "text_contrast", element: label, reason: resolved.reason }); return; }
      bg = resolved.color;
    }

    let fg = { r: fillSpec.color.r, g: fillSpec.color.g, b: fillSpec.color.b };
    if (fillSpec.alpha < 1) fg = blend(fg, fillSpec.alpha, bg);

    const ratio = contrastRatio(fg, bg);
    const rounded = Math.round(ratio * 100) / 100;
    if (ratio < required - 1e-9) {
      failures.push({
        rule: "text_contrast",
        message: `${label}: contrast ${rounded}:1 is below the required ${required}:1 for ${isLarge ? "large" : "normal"} text (${fontSize}px, weight ${fontWeight})`,
        element: label,
        ratio: rounded,
        required,
        foreground: rgbToHex(fg),
        background: rgbToHex(bg),
      });
    }
  });

  return { version: RENDER_QA_CONTRAST_VERSION, passed: failures.length === 0, failures, unmeasured };
}
