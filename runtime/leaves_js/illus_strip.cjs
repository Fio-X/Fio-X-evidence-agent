// Second-layer leaf child for a page's illustration strip (src/next_leaf.rs strip runs it): one cell per piece of a piece
// set, every piece standing on one shared ground line, drawn in rough.js line art; each cell's circled number only with the
// marker knob on (off by default: no legend refers to the numbers yet). One JSON line in, one line out:
//   in:  {"set": the set's own description (pieces-<set>.json: module, pieces with cell weights, knobs), "width",
//         "ink", "accent": the page's colour names (var(--...)), "knobs": {name: value} (a missing one takes its default)}
//   out: {"svg": the strip's paths and groups (no outer svg, no text), "w", "h", "dropped": what was too small to draw,
//         "kept": {piece: "kept/all"}} or {"refused": [why, ...]}.
// The strip prints no number and no word: the cells' numbers are drawn with strokes. Every stroke is the ink or the accent
// the request names, so the page's palette colours it; the strip has no ground of its own.
// A set whose topic the scene renderer draws (its pieces are one topic's list in the module's strip_topics, and that topic's
// ../illus_hero/node.json topics.scenes entry has renderer "scene": people in the ink style, trade in geo, tech in iso) is
// drawn instead as a row of people by that style's skin (../illus_hero/scene/people_lib, the skins the opening picture uses),
// nobody lit, as decoration only. The ink skin's fills become line art (outlines and hatching, hidden lines removed): the two
// pens and no fill. The flat skins (geo, iso) keep their shapes, each filled with one of the page's theme colours by name
// (FILLS, the list src/next_leaf.rs STRIP_FILLS allows) and outlined in a pen. Each figure is its own group, at least GAP_MIN
// px from the next, nothing under the ground.
const path = require('path');
const readline = require('readline');
const rough = require('./roughjs-4.6.6.cjs.js');

const gen = rough.generator();
const WIDTH = [600, 2000];
const COLOUR = /^var\(--[a-z0-9-]+\)$/;
// The page theme colours a flat-skin figure is filled with, by name (src/next_leaf.rs STRIP_FILLS, the same four): the paper,
// the light grey, the second pen's grey, the ink. No other fill is written: FILL is the only way a fill reaches the svg.
const FILLS = ['--bg', '--bar', '--t-sec', '--t-title'];
const FILL = (c) => typeof c === 'string' && FILLS.some((t) => c === `var(${t})`);
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

// The pieces that stand: the set's own, or, when the request names a measure family or a member count (set.strip_topics), the
// topic's list: how many by the count (about one a `per` members, at least `min`, at most the list), which one leads by the count
// (the list turned by count mod its length) and a seed that follows the count, so two pages of different data do not share a strip.
function pieceList(set, req, off) {
  if (req.family === undefined && req.count === undefined) return { pieces: set.pieces, seed: 0 };
  const T = set.strip_topics;
  if (!T) { off.push(`set: ${set.set} has no strip_topics for family ${JSON.stringify(req.family)}`); return { pieces: set.pieces, seed: 0 }; }
  if (req.family !== undefined && typeof req.family !== 'string') off.push(`family: ${JSON.stringify(req.family)} is no measure family id; e.g. renewable_share`);
  if (req.count !== undefined && (!Number.isInteger(req.count) || req.count < 1 || req.count > 200)) off.push(`count: ${JSON.stringify(req.count)} is not a whole number on 1..200; e.g. 27`);
  if (off.length) return { pieces: set.pieces, seed: 0 };
  const topic = T.families[req.family] || T.neutral, list = T.pieces[topic], n = req.count === undefined ? list.length : req.count;
  const k = Math.min(list.length, Math.max(Math.min(T.min, list.length), Math.round(n / T.per)));
  const turn = n % list.length, rot = list.slice(turn).concat(list.slice(0, turn));
  return { pieces: rot.slice(0, k), seed: n, topic };
}

// ---------------------------------------------------------------- the people strip (a scene-renderer topic)
// The scene renderer's people library (ES modules, loaded on first use; a strip that cannot load them keeps the pieces).
const SCENE_DIR = path.join(__dirname, '..', 'illus_hero', 'scene');
let PEOPLE = null;
function people() {
  if (PEOPLE === null) {
    try {
      PEOPLE = { L: require(path.join(SCENE_DIR, 'people_lib/lib.mjs')), C: require(path.join(SCENE_DIR, 'people_lib/skins/common.mjs')),
        N: require(path.join(SCENE_DIR, 'normalize.mjs')),
        skins: Object.fromEntries(['ink', 'iso', 'geo'].map((k) => [k, require(path.join(SCENE_DIR, `people_lib/skins/${k}.mjs`))])) };
    } catch (e) { PEOPLE = false; }
  }
  return PEOPLE || null;
}

// The scene style of a set's topic, or none: the topic is the module's strip_topics list holding exactly the set's pieces, its
// look the hero registry's topics.scenes.<topic> (style, when its renderer is the scene renderer). Nothing new is mapped here.
function sceneStyle(set) {
  try {
    const T = set.strip_topics || JSON.parse(require('fs').readFileSync(path.join(__dirname, set.module.replace(/\.cjs$/, '.json')), 'utf8')).strip_topics;
    if (!T) return null;
    const names = (list) => [...new Set(list.map((p) => p.name))].sort().join();
    const own = names(set.pieces), topic = Object.keys(T.pieces).find((t) => names(T.pieces[t]) === own);
    if (!topic) return null;
    const sc = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'illus_hero', 'node.json'), 'utf8')).topics.scenes[topic];
    return sc && sc.renderer === 'scene' && ['ink', 'iso', 'geo'].includes(sc.style) ? { topic, style: sc.style } : null;
  } catch (e) { return null; }
}

// The skins draw in colours; the strip has two pens. Each figure is dressed in tones (dark, mid, light, paper) and every
// colour the skin derives from them is read back as a tone: dark is the ink pen, mid the second pen, light and paper no pen.
const TONE = { dark: '#1b1b1b', mid: '#7a7a7a', mid2: '#a0a0a0', light: '#f2f2f2', paper: '#ffffff' };
const lum = (h) => { const n = parseInt(h.slice(1), 16); return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
const toneOf = (h) => (!h || h === 'none' ? null : lum(h) < 0.3 ? 'dark' : lum(h) < 0.8 ? 'mid' : 'light');
function rng(seed) {
  let a = (seed >>> 0) || 0x2545f491;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
function looks(r) {
  const T = TONE;
  const top = pick(r, [T.mid, T.mid2, T.light, T.dark, T.mid]), bottom = pick(r, [T.dark, T.mid, T.dark, T.mid2]);
  return { ink: T.dark, paper: T.paper, skin: T.light, hair: pick(r, [T.dark, T.dark, T.mid]), top, outer: top, bottom, accent: T.mid, shade: T.light, prop: T.mid, shoe: T.dark };
}

const bbox = (subs) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const s of subs) for (const [x, y] of s.pts) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } return b; };
const meets = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
function inside(x, y, o) { // nonzero winding of a point against a fill's closed subpaths (or under the ground: o.ground)
  if (o.ground !== undefined) return y > o.ground;
  if (x < o.b[0] || x > o.b[2] || y < o.b[1] || y > o.b[3]) return false;
  let w = 0;
  for (const s of o.subs) {
    const p = s.pts;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [x1, y1] = p[j], [x2, y2] = p[i];
      if (y1 <= y) { if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) w++; } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) w--;
    }
  }
  return w !== 0;
}
function simplify(pts, tol) { // Douglas-Peucker
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(), [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let m = -1, md = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; m = i; } }
    if (m > 0) { keep[m] = 1; st.push([a, m], [m, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// The runs of a polyline no later solid fill covers (the hidden-line pass that stands in for the skins' fills).
function visible(pts, closed, occ) {
  if (closed && pts.length > 1) pts = pts.concat([pts[0]]);
  const runs = []; let cur = null;
  const push = (x, y, vis) => { if (vis) { if (!cur) { cur = []; runs.push(cur); } cur.push([x, y]); } else cur = null; };
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i === 0) { push(x, y, !occ.some((o) => inside(x, y, o))); continue; }
    const [x0, y0] = pts[i - 1], near = occ.filter((o) => meets([Math.min(x, x0), Math.min(y, y0), Math.max(x, x0), Math.max(y, y0)], o.b));
    if (!near.length) { push(x, y, true); continue; }
    const n = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / 1.2));
    for (let k = 1; k <= n; k++) { const t = k / n, X = x0 + (x - x0) * t, Y = y0 + (y - y0) * t; push(X, Y, !near.some((o) => inside(X, Y, o))); }
  }
  return runs.filter((r) => r.length >= 2).map((r) => simplify(r, 0.3));
}
// Parallel hatch segments inside a fill's closed subpaths (nonzero), at angle th, sp apart: the fill's tone as strokes.
function hatch(subs, th, sp, off) {
  const c = Math.cos(th), s = Math.sin(th), rot = subs.map((u) => u.pts.map(([x, y]) => [x * c + y * s, -x * s + y * c]));
  let y0 = Infinity, y1 = -Infinity; for (const p of rot) for (const q of p) { y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  const out = [];
  for (let y = Math.floor(y0 / sp) * sp + off * sp; y < y1; y += sp) {
    const xs = [];
    for (const p of rot) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [ax, ay] = p[j], [bx, by] = p[i];
      if ((ay <= y) !== (by <= y)) xs.push([ax + (y - ay) / (by - ay) * (bx - ax), by > ay ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let w = 0, xa = 0;
    for (const [xk, dk] of xs) {
      const was = w; w += dk;
      if (was === 0 && w !== 0) xa = xk;
      if (was !== 0 && w === 0 && xk - xa > 0.8) out.push([[xa * c - y * s, xa * s + y * c], [xk * c - y * s, xk * s + y * c]]);
    }
  }
  return out;
}

// The flat skins' colours read back as the page's theme colours: each figure is dressed in the four tones (the tokens.css
// values of FILLS, as the skins compute in hex), and every colour the skin derives from them (its shades) is taken as the
// nearest tone by lightness, then written by name: dark the ink pen, mid the second pen, light --bar, paper --bg.
const FLAT = { dark: '#292928', mid: '#707070', light: '#d4d4d4', paper: '#ffffff' };
const FLAT_LUM = Object.entries(FLAT).map(([k, h]) => [k, lum(h)]);
const flatTone = (h) => FLAT_LUM.reduce((a, b) => (Math.abs(b[1] - lum(h)) < Math.abs(a[1] - lum(h)) ? b : a))[0];
function flatLooks(style, r) {
  const T = FLAT;
  if (style === 'geo') return { ink: T.dark, paper: T.paper, detail: T.paper, hair: T.dark, grey: T.mid };
  const top = pick(r, [T.mid, T.light, T.paper, T.dark, T.mid]);
  return { ink: T.dark, paper: T.paper, skin: T.light, hair: pick(r, [T.dark, T.dark, T.mid]), top, outer: top, bottom: pick(r, [T.dark, T.mid, T.dark]), shoe: T.dark, prop: T.mid };
}

// One flat-skin figure as filled shapes: (its shapes {subs, fill, stroke, sw}, in the skin's order) or none. The shapes are set
// with their lowest drawn point on the ground and fitted under the top margin, then cut at the ground line; a fill is a FILLS name
// outlined thinly in a pen (the light ones in the second pen, so a pale shirt keeps its edge on the paper), a pen line of the
// skin is the ink or the second pen; anything lighter than that, or seen through, is left out.
function flatFigure(M, style, fig, fr, seed, YG, FH, turn, fills) {
  const { N } = M, skin = M.skins[style];
  const px = (FH / fig.height) * (fig.scale || 1), pal = flatLooks(style, fr);
  const frag = skin.drawFigure(fig, { x: 0, y: YG, px, palette: pal, seed: fig.seed, turn, ...(style === 'iso' ? { dark: 0.45 } : {}) });
  let items = N.normalizeFragment(frag, { px, seed: (fig.seed ^ seed) >>> 0, palette: pal }).filter((e) => e.op >= 0.9 && !e.wash);
  if (!items.length) return null;
  const subsOf = (e) => N.flatten(e.d).filter((u) => u.pts.length >= 2);
  const move = (f) => { items = items.map((e) => ({ ...e, d: N.writeD(subsOf(e).map((u) => ({ closed: u.closed, pts: u.pts.map(f) }))) })); };
  const drawn = (e) => (e.fill !== 'none' && flatTone(e.fill) !== 'paper') || (e.stroke !== 'none' && e.sw > 0 && ['dark', 'mid'].includes(flatTone(e.stroke)));
  const low = bbox(items.filter(drawn).flatMap(subsOf))[3];
  if (low !== YG) move(([x, y]) => [x, y + YG - low]); // up or down: the iso view sets the near foot lower than the far one
  const top = bbox(items.flatMap(subsOf))[1], fit = Math.min(1, (YG - 4) / Math.max(1, YG - top));
  if (fit < 1) move(([x, y]) => [x * fit, YG + (y - YG) * fit]);
  const shapes = [];
  for (const e of N.cutBelow(items, YG)) {
    const subs = subsOf(e);
    if (!subs.length) continue;
    if (e.fill !== 'none') {
      const tone = flatTone(e.fill);
      shapes.push({ subs: subs.map((u) => ({ pts: u.pts, closed: true })), fill: fills[tone], stroke: tone === 'dark' ? fills.dark : fills.mid, sw: tone === 'dark' || tone === 'mid' ? 0.5 : 0.6 });
    }
    if (e.stroke !== 'none' && e.sw > 0) {
      const tone = flatTone(e.stroke);
      if (tone === 'dark' || tone === 'mid') shapes.push({ subs, fill: 'none', stroke: tone === 'dark' ? fills.dark : fills.mid, sw: e.sw });
    }
  }
  return shapes.length ? shapes : null;
}

// A row of people across the strip: the people library's street crowd (nobody lit: the strip has no subject), each figure drawn
// by the style's skin on its own (the ink skin's tones redrawn as line art in the two pens, a flat skin's shapes filled with the
// page's theme colours), cut at the ground line, then the figures set side by side by their boxes, GAP_MIN apart at least: one
// that does not fit is left out, never squeezed; the room left widens the gaps so the row spans the strip. A flat style whose
// pens are no FILLS names is not drawn (the caller keeps the pieces).
const GAP_MIN = 8; // px between two figures' boxes (stroke points), the 6 asked and a pen's width
function sceneStrip(style, W, H, YG, seed, pens) {
  const M = people();
  if (!M) return null;
  const fills = { dark: pens.ink, mid: pens.second, light: 'var(--bar)', paper: 'var(--bg)' };
  if (style !== 'ink' && !Object.values(fills).every(FILL)) return null;
  const { L, C, N } = M, skin = M.skins[style];
  const FH = (YG - TOP) * 0.96, slot = FH * 0.44, n = Math.max(3, Math.ceil(W / slot));
  const r = rng(Math.imul(seed, 2654435761) >>> 0);
  const crowd = L.makeCrowd({ n, seed, scene: 'street', highlightK: 0, layout: { type: 'queue', w: W, h: FH } });
  const ground = { ground: YG, b: [-Infinity, YG, Infinity, Infinity] };
  const figs = [];
  crowd.items.forEach((it, i) => {
    let fig = it.figure; fig.highlight = false;
    if (style === 'iso') fig = L.resampleHeight(fig, skin.info.headRatio); else if (fig.height < skin.info.headRatio) fig = L.resampleHeight(fig, skin.info.headRatio);
    const fr = rng((fig.seed ^ (i * 7919)) >>> 0), pi = fig.partner;
    let target = (fr() < 0.5 ? -1 : 1) * (40 + fr() * 50);
    if (pi !== null && pi !== undefined && pi < n) target = (pi > i ? 1 : -1) * (60 + fr() * 20);
    const turn = C.turnToFace(fig, target);
    if (style !== 'ink') {
      const shapes = flatFigure(M, style, fig, fr, seed, YG, FH, turn, fills);
      if (shapes) figs.push({ shapes, x: bbox(shapes.flatMap((q) => q.subs)) });
      return;
    }
    const px = (FH / fig.height) * (fig.scale || 1), pal = looks(fr);
    const items = [];
    for (const e of N.normalizeFragment(skin.drawFigure(fig, { x: 0, y: YG, px, palette: pal, seed: fig.seed, turn }), { px, seed: (fig.seed ^ seed) >>> 0, palette: pal })) {
      const subs = N.flatten(e.d).filter((u) => u.pts.length >= 2);
      if (!subs.length) continue;
      if (e.fill !== 'none') items.push({ subs: subs.map((u) => ({ pts: u.pts, closed: true })), fill: true, tone: toneOf(e.fill), op: e.op, wash: e.wash });
      if (e.stroke !== 'none' && e.sw > 0) items.push({ subs, fill: false, tone: toneOf(e.stroke), sw: e.sw, wash: e.wash });
    }
    if (!items.length) return;
    // on the ground: a pose whose lowest point stands above the foot line (a step, a lifted heel) is set down onto it
    const low = bbox(items.filter((q) => (q.tone === 'dark' || q.tone === 'mid') && !(q.wash && !q.fill)).flatMap((q) => q.subs))[3];
    if (low < YG) for (const q of items) for (const u of q.subs) u.pts = u.pts.map(([x, y]) => [x, y + YG - low]);
    // under the top margin: a hat or a raised arm past the height the figure was sized by scales it about its foot
    const top = bbox(items.flatMap((q) => q.subs))[1], fit = Math.min(1, (YG - 4) / Math.max(1, YG - top));
    if (fit < 1) for (const q of items) for (const u of q.subs) u.pts = u.pts.map(([x, y]) => [x * fit, YG + (y - YG) * fit]);
    for (const q of items) q.b = bbox(q.subs);
    const lines = new Map(); // pen|width -> polylines
    const add = (pen, w, runs) => { const key = `${pen}|${w.toFixed(2)}`; if (!lines.has(key)) lines.set(key, []); lines.get(key).push(...runs); };
    items.forEach((q, j) => {
      const occ = [ground]; // the ground, and the solid fills drawn over this one (washes are see-through)
      for (let k = j + 1; k < items.length; k++) { const o = items[k]; if (o.fill && o.op >= 0.9 && !o.wash && meets(o.b, q.b)) occ.push(o); }
      if (!q.fill) { // a pen line: the dark ones in the ink, the others in the second pen; the paper's own strokes and wash rims none
        if (q.wash || !q.tone || q.tone === 'light') return;
        for (const u of q.subs) add(q.tone === 'dark' ? pens.ink : pens.second, q.sw, visible(u.pts, u.closed, occ));
        return;
      }
      if (q.tone === 'dark' || q.tone === 'mid') {
        const dark = q.tone === 'dark';
        for (const sg of hatch(q.subs, dark ? -0.9 : 1.3, dark ? 1.5 : 3.0, (j * 0.37) % 1)) add(dark ? pens.ink : pens.second, dark ? 0.6 : 0.55, visible(sg, false, occ));
      }
      if (q.tone === 'dark') for (const u of q.subs) add(pens.ink, 0.9, visible(u.pts, true, occ)); // the skin's dark masses (its swells)
    });
    const drawn = [...lines.values()].flat();
    if (!drawn.length) return;
    figs.push({ lines, x: bbox(drawn.map((p) => ({ pts: p }))) });
  });
  // side by side: each gap GAP_MIN and a share of a slot (some wider, so the row falls in groups); the figures that fit
  const gaps = figs.map(() => (r() < 0.25 ? 0.5 : 0) + r() * 0.25);
  const side = 4, room = W - 2 * side;
  let k = figs.length;
  const need = (m) => figs.slice(0, m).reduce((a, f) => a + f.x[2] - f.x[0], 0) + (m - 1) * GAP_MIN;
  while (k > 1 && need(k) > room) k--;
  const used = figs.slice(0, k), extra = gaps.slice(0, Math.max(0, k - 1)), weight = extra.reduce((a, g) => a + g, 0) || 1;
  const spare = room - need(k);
  let x = side + (k === 1 ? spare / 2 : 0), body = '';
  used.forEach((f, i) => {
    const dx = x - f.x[0];
    let g = '';
    if (f.shapes) for (const q of f.shapes) { // a flat figure: its shapes in the skin's order, each fill a FILLS name
      const d = N.writeD(q.subs.map((u) => ({ pts: u.pts.map(([px, py]) => [px + dx, py]), closed: u.closed })));
      if (d && (q.fill === 'none' || FILL(q.fill))) g += `<path d="${d}" stroke="${q.stroke}" stroke-width="${q.sw}" fill="${q.fill}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    else for (const [key, runs] of f.lines) {
      const cut = key.lastIndexOf('|'), d = N.writeD(runs.map((p) => ({ pts: p.map(([px, py]) => [px + dx, py]), closed: false })));
      if (d) g += `<path d="${d}" stroke="${key.slice(0, cut)}" stroke-width="${+key.slice(cut + 1)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    body += `<g>${g}</g>`;
    x += f.x[2] - f.x[0] + GAP_MIN + (i < k - 1 ? spare * extra[i] / weight : 0);
  });
  const gl = []; for (let gx = 4; gx <= W - 4; gx += 8) gl.push([gx, YG + 1 + Math.sin(gx * 0.05 + seed) * 0.6]);
  body += `<path d="${N.writeD([{ pts: gl, closed: false }])}" stroke="${pens.ink}" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return { svg: `<g>${body}</g>`, figures: k, lit: 0 };
}

function strip(req, { scene = true } = {}) { // scene false: the pieces even for a scene topic (a test's byte check)
  const off = [], set = req.set || {};
  if (typeof set.module !== 'string' || !MODULE.test(set.module)) return { refused: [`set: ${JSON.stringify(set.module)} is no piece module; e.g. pieces-energy.cjs`] };
  if (!Array.isArray(set.pieces) || !set.pieces.length || !Array.isArray(set.knobs)) return { refused: ['set: no pieces or no knobs'] };
  const chosen = pieceList(set, req, off);
  const PIECES = chosen.pieces;
  const W = req.width;
  if (!Number.isInteger(W) || W < WIDTH[0] || W > WIDTH[1]) off.push(`width: ${JSON.stringify(W)} is not a whole number on ${WIDTH[0]}..${WIDTH[1]}; e.g. 1140`);
  for (const c of ['ink', 'accent']) if (typeof req[c] !== 'string' || !COLOUR.test(req[c])) off.push(`${c}: ${JSON.stringify(req[c])} is no page colour name; e.g. var(--accent)`);
  const K = knobs(set, req.knobs, off);
  let lib;
  try { lib = require(path.join(__dirname, set.module)); } catch (e) { off.push(`set: ${set.module} does not load: ${e.message}`); }
  if (lib) for (const p of PIECES) if (typeof lib[p.name] !== 'function') off.push(`piece ${p.name}: ${set.module} draws no such piece; e.g. ${Object.keys(lib)[0]}`);
  if (K.marker && PIECES.length > Object.keys(GLYPH).length) off.push(`marker: ${PIECES.length} cells, numbers are drawn up to ${Object.keys(GLYPH).length}`);
  if (off.length) return { refused: off };
  const H = K.height, YG = K.baseline, R = K.roughness, PAD = K.margin;
  // a set of a scene-renderer topic, asked with no family and no count (the page's own request): its people, if they load
  const look = req.family === undefined && req.count === undefined ? sceneStyle(set) : null;
  const crowd = look && scene && sceneStrip(look.style, W, H, YG, K.seed, { ink: req.ink, second: req.accent });
  // the strip's own check of its fills before it leaves: none, or a FILLS name; any other colour refuses the strip
  const foreign = crowd ? [...new Set([...crowd.svg.matchAll(/ fill="([^"]*)"/g)].map((m) => m[1]).filter((c) => c !== 'none' && !FILL(c)))] : [];
  if (foreign.length) return { refused: foreign.map((c) => `fill: ${JSON.stringify(c)} is no page theme colour; e.g. var(${FILLS[0]})`) };
  if (crowd) return { svg: crowd.svg, w: W, h: H, dropped: [], kept: {}, topic: look.topic, style: look.style, figures: crowd.figures, lit: crowd.lit };
  const free = W - (PIECES.length - 1) * K.gap, weight = PIECES.reduce((a, p) => a + p.cell, 0);
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
  PIECES.forEach((q, i) => {
    const w = q.cell / weight * free, p = lib[q.name](), [bx, by0, bw] = p.box, padL = q.pad_l || 0;
    const s = Math.min((w - padL - PAD) / bw, (YG - TOP) / (p.base - by0));
    const ox = x + padL + (w - padL - PAD - bw * s) / 2 + (padL ? 0 : PAD / 2), oy = YG - (p.base - by0) * s;
    const keep = p.els.filter((e) => {
      const ok = size(e) * s >= K.min_feature;
      if (!ok) dropped.push(`${q.name}: a ${e.t} ${f(size(e) * s, 1)} px`);
      return ok;
    });
    kept[q.name] = `${keep.length}/${p.els.length}`;
    body += `<g transform="translate(${(ox - bx * s).toFixed(2)},${(oy - by0 * s).toFixed(2)}) scale(${s.toFixed(4)})">${keep.map((e, j) => pen(e, K.seed + chosen.seed + i * 131 + j, s)).join('')}</g>`;
    if (K.marker) body += marker(i + 1, x + 16, 16, K.seed + 79 + i + 1);
    x += w + K.gap;
  });
  return { svg: body, w: W, h: H, dropped, kept, ...(chosen.topic ? { topic: chosen.topic, pieces: PIECES.map((q) => q.name) } : {}) };
}

if (require.main === module) readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let reply;
  try { reply = strip(JSON.parse(line)); } catch (e) { reply = { refused: [`strip: ${e.message}`] }; }
  process.stdout.write(JSON.stringify(reply) + '\n');
});

module.exports = { strip, sceneStyle, sceneStrip, FILLS };
