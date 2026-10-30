// Second-layer leaf child for a page's illustration strip (src/next_leaf.rs strip runs it): one cell per piece of a piece
// set, every piece standing on one shared ground line, drawn in rough.js line art; each cell's circled number only with the
// marker knob on (off by default: no legend refers to the numbers yet). One JSON line in, one line out:
//   in:  {"set": the set's own description (pieces-<set>.json: module, pieces with cell weights, knobs), "width",
//         "ink", "accent": the page's colour names (var(--...)), "knobs": {name: value} (a missing one takes its default)}
//   out: {"svg": the strip's paths and groups (no outer svg, no text), "w", "h", "dropped": what was too small to draw,
//         "kept": {piece: "kept/all"}} or {"refused": [why, ...]}.
// The strip prints no number and no word: the cells' numbers are drawn with strokes. Every stroke is the ink or the accent
// the request names, so the page's palette colours it; the strip has no ground of its own.
const path = require('path');
const readline = require('readline');
const rough = require('./roughjs-4.6.6.cjs.js');

const gen = rough.generator();
const WIDTH = [600, 2000];
const COLOUR = /^var\(--[a-z0-9-]+\)$/;
const MODULE = /^pieces-[a-z_]+\.cjs$/;
// the pen per element class: its stroke knob, roughness factor and whether rough.js doubles the stroke
const CLASS = { main: { knob: 'stroke_main', k: 1.0, multi: true }, mid: { knob: 'stroke_mid', k: 0.8, multi: false },
  fine: { knob: 'stroke_fine', k: 0.55, multi: false }, hatch: { knob: 'stroke_hatch', k: 0.45, multi: false },
  wave: { knob: 'stroke_wave', fixed: 0.3, multi: false } };
const ACCENT_MIN_PX = 1.3;
const TOP = 10;
const GLYPH = { 1: ['M1,2.2 L3,0 L3,8'], 2: ['M0.2,2.2 Q0.5,0 2.6,0 Q5,0 5,2.3 Q5,4 0,8 L5.2,8'],
  3: ['M0.2,1 Q2.5,-0.6 4.8,1.4 Q5,3.4 1.8,3.8 Q5.2,4.2 5,6.3 Q4.4,8.6 0,7.2'], 4: ['M4,8 L4,0 L0,5.6 L5.4,5.6'] };

const f = (v, d = 2) => Number(v.toFixed(d));

// The knobs' values: each the request's or its default, on its range and step; a knob the set does not have refuses.
function knobs(set, given, off) {
  const out = {};
  for (const name of Object.keys(given || {})) if (!set.knobs.some((k) => k.name === name)) off.push(`knob ${name}: the set ${set.set} has no such knob; e.g. ${set.knobs[0].name}`);
  for (const k of set.knobs) {
    const v = given && k.name in given ? given[k.name] : k.default;
    const n = (v - k.min) / k.step;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < k.min || v > k.max || Math.abs(n - Math.round(n)) > 1e-6) off.push(`knob ${k.name}: ${JSON.stringify(v)} is not on ${k.min}..${k.max} step ${k.step}; e.g. ${k.default}`);
    out[k.name] = v;
  }
  if (!off.length && (out.baseline < 0.6 * out.height || out.baseline > 0.9 * out.height)) off.push(`knob baseline: ${out.baseline} is not within 0.6..0.9 of the height ${out.height}`);
  return out;
}

function size(e) { // smallest extent in piece units
  if (e.t === 'rect') return Math.min(e.width, e.height);
  if (e.t === 'circle') return 2 * e.r;
  if (e.t === 'ellipse') return 2 * Math.min(e.rx, e.ry);
  if (e.t === 'line') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  return Infinity;
}

function strokes(d, colour, width, extra = '') {
  return gen.toPaths(d).map((p) => `<path${extra} d="${p.d}" stroke="${colour}" stroke-width="${width.toFixed(3)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
}

function strip(req) {
  const off = [], set = req.set || {};
  if (typeof set.module !== 'string' || !MODULE.test(set.module)) return { refused: [`set: ${JSON.stringify(set.module)} is no piece module; e.g. pieces-energy.cjs`] };
  if (!Array.isArray(set.pieces) || !set.pieces.length || !Array.isArray(set.knobs)) return { refused: ['set: no pieces or no knobs'] };
  const W = req.width;
  if (!Number.isInteger(W) || W < WIDTH[0] || W > WIDTH[1]) off.push(`width: ${JSON.stringify(W)} is not a whole number on ${WIDTH[0]}..${WIDTH[1]}; e.g. 1140`);
  for (const c of ['ink', 'accent']) if (typeof req[c] !== 'string' || !COLOUR.test(req[c])) off.push(`${c}: ${JSON.stringify(req[c])} is no page colour name; e.g. var(--accent)`);
  const K = knobs(set, req.knobs, off);
  let lib;
  try { lib = require(path.join(__dirname, set.module)); } catch (e) { off.push(`set: ${set.module} does not load: ${e.message}`); }
  if (lib) for (const p of set.pieces) if (typeof lib[p.name] !== 'function') off.push(`piece ${p.name}: ${set.module} draws no such piece; e.g. ${Object.keys(lib)[0]}`);
  if (K.marker && set.pieces.length > Object.keys(GLYPH).length) off.push(`marker: ${set.pieces.length} cells, numbers are drawn up to ${Object.keys(GLYPH).length}`);
  if (off.length) return { refused: off };
  const H = K.height, YG = K.baseline, R = K.roughness, PAD = K.margin;
  const free = W - (set.pieces.length - 1) * K.gap, weight = set.pieces.reduce((a, p) => a + p.cell, 0);
  const pen = (e, seed, s) => {
    const c = CLASS[e.cls], acc = e.col === 'acc', px = acc ? Math.max(K[c.knob], ACCENT_MIN_PX) : K[c.knob];
    const o = { seed, stroke: acc ? req.accent : req.ink, strokeWidth: px / s, roughness: c.fixed ?? R * c.k, bowing: 0.8, disableMultiStroke: !c.multi };
    const d = e.t === 'line' ? gen.line(e.x1, e.y1, e.x2, e.y2, o) : e.t === 'path' ? gen.path(e.d, o)
      : e.t === 'rect' ? gen.rectangle(e.x, e.y, e.width, e.height, o) : e.t === 'circle' ? gen.circle(e.cx, e.cy, e.r * 2, o) : gen.ellipse(e.cx, e.cy, e.rx * 2, e.ry * 2, o);
    return strokes(d, o.stroke, o.strokeWidth);
  };
  const marker = (n, x, y, seed) => { // a circled numeral drawn with strokes: a cell's label, not a data number
    const o = { seed, stroke: req.ink, strokeWidth: 1.4, roughness: R * 0.6, disableMultiStroke: true };
    let s = gen.toPaths(gen.circle(x, y, 24, o)).map((p) => `<path d="${p.d}" stroke="${req.ink}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`).join('');
    for (const d of GLYPH[n]) s += gen.toPaths(gen.path(d, { ...o, strokeWidth: 1.3, roughness: R * 0.3 })).map((p) => `<path transform="translate(${x - 2.7 * 1.4},${y - 4 * 1.4}) scale(1.4)" d="${p.d}" stroke="${req.ink}" stroke-width="1.0" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    return s;
  };
  let x = 0, body = '';
  const dropped = [], kept = {};
  set.pieces.forEach((q, i) => {
    const w = q.cell / weight * free, p = lib[q.name](), [bx, by0, bw] = p.box, padL = q.pad_l || 0;
    const s = Math.min((w - padL - PAD) / bw, (YG - TOP) / (p.base - by0));
    const ox = x + padL + (w - padL - PAD - bw * s) / 2 + (padL ? 0 : PAD / 2), oy = YG - (p.base - by0) * s;
    const keep = p.els.filter((e) => {
      const ok = size(e) * s >= K.min_feature;
      if (!ok) dropped.push(`${q.name}: a ${e.t} ${f(size(e) * s, 1)} px`);
      return ok;
    });
    kept[q.name] = `${keep.length}/${p.els.length}`;
    body += `<g transform="translate(${(ox - bx * s).toFixed(2)},${(oy - by0 * s).toFixed(2)}) scale(${s.toFixed(4)})">${keep.map((e, j) => pen(e, K.seed + j, s)).join('')}</g>`;
    if (K.marker) body += marker(i + 1, x + 16, 16, K.seed + 79 + i + 1);
    x += w + K.gap;
  });
  return { svg: body, w: W, h: H, dropped, kept };
}

if (require.main === module) readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let reply;
  try { reply = strip(JSON.parse(line)); } catch (e) { reply = { refused: [`strip: ${e.message}`] }; }
  process.stdout.write(JSON.stringify(reply) + '\n');
});

module.exports = { strip };
