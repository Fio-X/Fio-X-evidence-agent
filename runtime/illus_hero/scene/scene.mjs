// Scene illustration node: `node scene.mjs` reads ONE JSON line on stdin and writes ONE JSON line on stdout.
//   request {"scene":"queue","style":"ink"|"iso"|"geo","seed":int,"figures":[{"lit":bool},...] (1..60),
//            "box":{"w":px,"h":px},"palette":{"ink","paper","accent", optional "skin","hair","top","bottom","outer","shade"}}
//   reply   {"svg","w","h","lit","total","dropped":[]}  or  {"refused":"<why>"}
// The node never decides who is lit: the i-th figure drawn carries figures[i].lit, and lit/total are counted
// from the figures actually drawn. The svg is the picture's inner markup (no outer <svg>), made only of what
// the page's hero gate takes (src/next_leaf.rs hero_faults): g, path, defs, linearGradient, stop, mask; hex
// colours; no text. No file read, no process, no network, no environment: only sibling modules.
import { makeCrowd, resampleHeight } from './people_lib/lib.mjs';
import { turnToFace, posedJoints } from './people_lib/skins/common.mjs';
import * as inkSkin from './people_lib/skins/ink.mjs';
import * as isoSkin from './people_lib/skins/iso.mjs';
import * as geoSkin from './people_lib/skins/geo.mjs';
import { normalizeFragment, writeItems, writeD, hexOk, mix, fbm } from './normalize.mjs';

const SKINS = { ink: inkSkin, iso: isoSkin, geo: geoSkin };
const MIN_W = 160, MIN_H = 100, MAX_SIDE = 4000, MIN_FIG_PX = 36, MAX_FIGS = 60;
const PALETTE_KEYS = ['ink', 'paper', 'accent', 'skin', 'hair', 'top', 'bottom', 'outer', 'shade'];
const REQUEST_KEYS = ['scene', 'style', 'seed', 'figures', 'box', 'palette'];

// ---------- seeded helpers ----------
function rng(seed) {
  let a = (seed >>> 0) || 0x2545f491;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const f1 = (v) => Math.round(v * 10) / 10;

// ---------- request check ----------
export function check(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return 'the request is not a JSON object';
  for (const k of Object.keys(req)) if (!REQUEST_KEYS.includes(k)) return `unknown request key ${JSON.stringify(k)}; allowed: ${REQUEST_KEYS.join(', ')}`;
  if (!Object.prototype.hasOwnProperty.call(SCENES, req.scene)) return `unknown scene ${JSON.stringify(req.scene)}; allowed: ${Object.keys(SCENES).join(', ')} (e.g. "queue")`;
  if (!Object.prototype.hasOwnProperty.call(SKINS, req.style)) return `unknown style ${JSON.stringify(req.style)}; allowed: ink, iso, geo (e.g. "ink")`;
  if (!Number.isSafeInteger(req.seed)) return 'seed must be an integer (e.g. 7)';
  const F = req.figures;
  if (!Array.isArray(F) || F.length < 1 || F.length > MAX_FIGS) return `figures must be a list of 1..${MAX_FIGS} {"lit":bool} (got ${Array.isArray(F) ? F.length : typeof F})`;
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.lit !== 'boolean' || Object.keys(f).some((k) => k !== 'lit')) return `figures[${i}] must be {"lit":true} or {"lit":false}`;
  }
  const b = req.box;
  if (!b || typeof b !== 'object' || !Number.isFinite(b.w) || !Number.isFinite(b.h) || Object.keys(b).some((k) => k !== 'w' && k !== 'h')) return 'box must be {"w":number,"h":number}';
  if (b.w < MIN_W || b.h < MIN_H) return `box ${b.w}x${b.h} is too small; at least ${MIN_W}x${MIN_H}`;
  if (b.w > MAX_SIDE || b.h > MAX_SIDE) return `box ${b.w}x${b.h} is too large; at most ${MAX_SIDE} a side`;
  const p = req.palette;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'palette must be an object of #rrggbb colours';
  for (const k of Object.keys(p)) if (!PALETTE_KEYS.includes(k)) return `unknown palette key ${JSON.stringify(k)}; allowed: ${PALETTE_KEYS.join(', ')}`;
  for (const k of ['ink', 'paper', 'accent']) if (!(k in p)) return `palette.${k} is missing (e.g. "#1b1b1b")`;
  for (const [k, v] of Object.entries(p)) if (!hexOk(v)) return `palette.${k} ${JSON.stringify(v)} is not a #rrggbb colour (e.g. "#1b1b1b")`;
  return null;
}

// the ink skin (v1.4) still lays any slot colour darker than luminance 0.3 as a solid ink mass before it looks at
// the highlight, so a dark page accent (e.g. #c8102e, 0.29) would turn lit people black. Lift it just over the
// line; the skin then pales it toward the paper itself for its single vermilion wash.
function lum(c) { const n = parseInt(c.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }
function washable(c, paper) { let t = 0, o = c; while (lum(o) < 0.31 && t < 0.9) { t += 0.02; o = mix(c, paper, t); } return o; }

// ---------- per-style looks: unlit people vary in value and muted tone; lit people take the accent ----------
// (slotColour in the library puts the accent on top/outer of a highlighted figure; geo turns the whole silhouette)
function looks(style, P, i, r) {
  const ink = P.ink, paper = P.paper;
  const g = (t) => mix(paper, ink, t); // a grey between paper and ink
  if (style === 'ink') {
    const washes = [P.top || mix(paper, '#6f8fa6', 0.62), mix(paper, '#d6b85e', 0.55), mix(paper, '#7f9a86', 0.5), g(0.35)];
    const darkTop = r() < 0.12, darkLegs = r() < 0.3;
    const top = darkTop ? ink : washes[(i + Math.floor(r() * 2)) % washes.length];
    return { ink, paper, skin: P.skin || mix(paper, '#d9a27a', 0.42), hair: P.hair || (r() < 0.75 ? ink : g(0.55)), top, outer: P.outer || top, bottom: P.bottom || (darkLegs ? ink : g(0.3 + r() * 0.15)), accent: washable(P.accent, paper), shade: P.shade || mix(paper, '#d6b85e', 0.5), prop: mix(paper, '#7f6a52', 0.55) };
  }
  if (style === 'iso') {
    const tops = [P.top || mix(paper, '#7d9c9a', 0.75), mix(paper, '#b8925f', 0.7), mix(paper, '#8f7f70', 0.7), mix(paper, '#6d8296', 0.75), g(0.45)];
    const pants = [mix(ink, '#3f4752', 0.6), mix(ink, '#56504a', 0.5), mix(ink, '#4b5560', 0.4), g(0.7)];
    const skins = [mix(paper, '#d8a07a', 0.6), mix(paper, '#b47a52', 0.7), mix(paper, '#e0b48e', 0.5), mix(paper, '#8f5f40', 0.65)];
    const hairs = [ink, mix(ink, '#5a4433', 0.6), mix(ink, '#7b6a5c', 0.5), g(0.55)];
    const top = tops[(i * 3 + Math.floor(r() * 3)) % tops.length];
    return { ink, paper, skin: P.skin || skins[Math.floor(r() * skins.length)], hair: P.hair || hairs[Math.floor(r() * hairs.length)], top, outer: P.outer || top, bottom: P.bottom || pants[(i + Math.floor(r() * 2)) % pants.length], accent: P.accent, prop: mix(paper, '#9a7a55', 0.7), shade: P.shade || g(0.25) };
  }
  // geo: one near-black silhouette, the paper as the light detail, the accent on lit people only
  return { ink, paper, detail: paper, hair: P.hair || ink, accent: P.accent };
}

// ---------- layout: queue ----------
// The picture prints no number, so where a lit person stands must carry the count: the flags are partitioned
// (unlit first, lit last: the lit people are the queue's tail), and the lit tail is cut into groups of at most
// five with an empty slot (one figure wide) before each group, so K reads by eye as fives. Up to 12 people
// stand in one row; more stand in a 2-3 row grid, each row behind shifted half a slot (staggered) so a front
// head falls between two back heads. The row pitch and slot width keep every head and torso at most ~10%
// hidden (scripts/test_illus_scene.mjs measures it from the drawn geometry).
// returns {H, s, pitch, rows:[{y, slots:[{q, x, y, col}]}] (rows[0] = front), hUsed}
const SLOT_K = 0.5, PITCH_K = 0.66, GROUP = 5; // slot 0.5 H = about 3.5 head widths (>= 1.6 asked)
export function queueTokens(n, K) {
  // units from the tail: [GAP, lit x<=5] per group, then unlit people one by one. The short group (K mod 5) is
  // the very tail, so the lit read left to right as 5 | 5 | 1
  const units = [];
  const groups = []; if (K % GROUP) groups.push(K % GROUP); for (let k = 0; k < Math.floor(K / GROUP); k++) groups.push(GROUP);
  for (const g of groups) units.push(['gap', ...Array(g).fill('lit')]);
  for (let k = 0; k < n - K; k++) units.push(['unlit']);
  return units;
}
function fillRows(units, R, C) {
  // front row first, filling from its right end; a unit (a whole group) never splits across rows
  const rows = [[]];
  for (const u of units) {
    if (rows[rows.length - 1].length + u.length > C) { if (rows.length === R) return null; rows.push([]); }
    rows[rows.length - 1].push(...u.slice().reverse());
  }
  return rows.map((t) => t.reverse()); // queue order, left to right
}
function layoutQueue(n, box, r, K) {
  const W = box.w, Hb = box.h, side = 0.05;
  const units = queueTokens(n, K), T = units.reduce((s, u) => s + u.length, 0);
  let best = null;
  for (const R of n <= 12 ? [1] : [2, 3]) {
    // the front row holds every lit figure and its gaps (up to 15 lit); the unlit fill the rows behind
    const litCols = K + Math.ceil(K / GROUP);
    let C = Math.max(Math.ceil(T / R), litCols <= 18 ? litCols : 0), rows = null;
    while (!(rows = fillRows(units, R, C))) C++;
    const cols = (C - 1) + (rows.length > 1 ? 0.5 : 0);
    const byW = (W * (1 - 2 * side)) / (cols * SLOT_K + 0.55);
    const byH = Hb / (1.22 + (rows.length - 1) * PITCH_K);
    const H = Math.min(byW, byH, Hb * 0.86);
    // a third row must earn its place (people >12% taller) and not be a near-empty strip at the back
    const backFill = rows[rows.length - 1].filter((t) => t !== 'gap').length / C;
    if (!best || (H > best.H * 1.12 && backFill >= 0.34)) best = { H, rows, C };
  }
  const { H, rows: toks, C } = best, R = toks.length, s = H * SLOT_K, pitch = H * PITCH_K;
  const span = (C - 1) * s + (R > 1 ? s / 2 : 0), x0 = (W - span) / 2;
  const yFront = H * 0.08 + H * 1.02 + (R - 1) * pitch;
  const rows = toks.map((t, k) => ({ y: yFront - k * pitch, toks: t, slots: [] }));
  // queue numbers: back row first, left to right, so the front row's right end is the tail
  let q = 0;
  for (let k = R - 1; k >= 0; k--) {
    const row = rows[k], t = row.toks, off = C - t.length;
    t.forEach((tok, j) => {
      if (tok === 'gap') return;
      const col = off + j;
      row.slots.push({ q: q++, col, x: x0 + col * s + (k % 2 ? s / 2 : 0), y: row.y + (r() * 2 - 1) * H * 0.008 });
    });
  }
  for (const row of rows) delete row.toks;
  return { H, s, pitch, cols: C, rows, hUsed: Math.min(Hb, yFront + H * 0.12) };
}
const SCENES = { queue: layoutQueue }; // grid (classroom rows) and door come later as more layouts

// ---------- ground and props, per style (in picture coordinates, gate-safe markup) ----------
const extent = (L, pad) => { const xs = L.rows.flatMap((row) => row.slots.map((q) => q.x)); return [Math.min(...xs) - L.H * pad, Math.max(...xs) + L.H * pad]; };
function groundInk(L, P, W, r, seed) {
  let s = '';
  for (const row of L.rows) {
    if (!row.slots.length) continue;
    const xs = row.slots.map((q) => q.x), a = Math.min(...xs) - L.H * 0.35, b = Math.max(...xs) + L.H * 0.35, y = row.y;
    // sunlit wash strip under the row, faded at both ends (gradient), offset from the pen line
    s += `<path d="${writeD([{ closed: true, pts: frayed([[a - L.H * 0.2, y + 2], [b + L.H * 0.3, y - 1], [b + L.H * 0.1, y + L.H * 0.07], [a - L.H * 0.1, y + L.H * 0.08]], 4, seed + Math.round(row.y)) }])}" fill="url(#gfade)" stroke="none"/>`;
  }
  // the kerb under the front row: a broken pen line
  const [a, b] = extent(L, 0.4), y = L.rows[0].y;
  const pts = []; for (let x = a; x <= b; x += 6) pts.push([x, y + L.H * 0.03 + fbm(x / 70, y / 50, seed & 0xffff) * 1.5]);
  const cut = Math.floor(pts.length * (0.3 + r() * 0.4));
  const w = Math.max(1, Math.min(2.6, L.H * 0.012));
  s += `<g fill="none" stroke="${P.ink}" stroke-width="${f1(w)}" stroke-linejoin="round"><path d="${writeD([{ closed: false, pts: pts.slice(0, cut) }, { closed: false, pts: pts.slice(cut + 2) }])}"/></g>`;
  return s;
}
function frayed(pts, amp, sd) {
  const out = [];
  for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; for (let t = 0; t < 1; t += 0.1) { const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t; out.push([x + amp * fbm(x / 40, y / 40, sd & 0xffff), y + amp * fbm(x / 40 + 9, y / 40, (sd + 5) & 0xffff)]); } }
  return out;
}
function shadowInk(x, y, H, P) {
  const pts = [[x - H * 0.06, y + 1], [x + H * 0.08, y - 2], [x + H * 0.36, y + H * 0.05], [x + H * 0.18, y + H * 0.08]];
  return { d: writeD([{ closed: true, pts: frayed(pts, 1.5, Math.round(x * 7 + y)) }]), fill: mix(P.paper, '#5f7f99', 0.45), op: 0.55 };
}
function groundIso(L, P, W) {
  // one oblique floor slab under every row: the top face recedes up-right, a darker front face and side edge
  const top = mix(P.paper, P.ink, 0.07), front = mix(P.paper, P.ink, 0.18), edge = mix(P.paper, P.ink, 0.12);
  const [a, b] = extent(L, 0.45), yF = L.rows[0].y + L.H * 0.05, yB = L.rows[L.rows.length - 1].y - L.H * 0.05;
  const dx = L.H * 0.16 + (yF - yB) * 0.3, th = L.H * 0.035;
  let s = `<path d="${writeD([{ closed: true, pts: [[a, yF], [b, yF], [b + dx, yB], [a + dx, yB]] }])}" fill="${top}" stroke="none"/>`;
  s += `<path d="${writeD([{ closed: true, pts: [[a, yF], [b, yF], [b, yF + th], [a, yF + th]] }])}" fill="${front}" stroke="none"/>`;
  s += `<path d="${writeD([{ closed: true, pts: [[b, yF], [b + dx, yB], [b + dx, yB + th], [b, yF + th]] }])}" fill="${edge}" stroke="none"/>`;
  return s;
}
function shadowIso(x, y, H, P) {
  const pts = []; for (let k = 0; k < 16; k++) { const t = k / 16 * Math.PI * 2; pts.push([x + H * 0.05 + Math.cos(t) * H * 0.12, y + Math.sin(t) * H * 0.035]); }
  return { d: writeD([{ closed: true, pts }]), fill: mix(P.paper, P.ink, 0.4), op: 0.35 };
}
function groundGeo(L, P, W, hUsed) {
  // one flat greyish base (the wall), a lighter floor band under each row, and a tall light doorway at the
  // head of the queue cropped by the top edge: the big shape the eye meets first
  const wall = mix(P.paper, P.ink, 0.2), floor = mix(P.paper, P.ink, 0.06), light = P.paper;
  let s = `<path d="M0 0H${f1(W)}V${f1(hUsed)}H0Z" fill="${wall}" stroke="none"/>`;
  const [ea, eb] = extent(L, 0.5), yB = L.rows[L.rows.length - 1].y - L.H * 0.035, yF = L.rows[0].y + L.H * 0.075;
  s += `<path d="${writeD([{ closed: true, pts: [[ea, yB], [eb, yB], [eb - L.H * 0.12, yF], [ea + L.H * 0.04, yF]] }])}" fill="${floor}" stroke="none"/>`;
  const front = L.rows[0], hx = extent(L, 0)[0] - L.H * 0.2;
  const dw = Math.min(L.H * 0.42, Math.max(L.H * 0.2, hx)), y = yB, x0 = Math.max(-dw * 0.4, hx - dw);
  s += `<path d="${writeD([{ closed: true, pts: [[x0 - L.H * 0.04, 0], [x0 + dw + L.H * 0.04, 0], [x0 + dw + L.H * 0.04, y], [x0 - L.H * 0.04, y]] }])}" fill="${P.ink}" stroke="none"/>`;
  s += `<path d="${writeD([{ closed: true, pts: [[x0, 0], [x0 + dw, 0], [x0 + dw, y], [x0, y]] }])}" fill="${light}" stroke="none"/>`;
  // the light spills out of the door onto the floor toward the queue
  s += `<path d="${writeD([{ closed: true, pts: [[x0, y], [x0 + dw, y], [x0 + dw + L.H * 0.9, y + L.H * 0.075], [x0 + L.H * 0.1, y + L.H * 0.075]] }])}" fill="${light}" stroke="none"/>`;
  return s;
}
function shadowGeo(x, y, H, P) {
  // a long flat shadow toward the viewer's right, part of the floor's shape language
  const pts = [[x - H * 0.06, y], [x + H * 0.07, y], [x + H * 0.42, y + H * 0.06], [x + H * 0.3, y + H * 0.07]];
  return { d: writeD([{ closed: true, pts }]), fill: mix(P.paper, P.ink, 0.3), op: 1 };
}

// ---------- draw ----------
export function draw(req, opts = {}) {
  const why = check(req);
  if (why) return { refused: why };
  const { style, seed, figures, box } = req;
  const P = req.palette;
  const n = figures.length;
  const K = figures.filter((f) => f.lit).length;
  const r = rng((seed >>> 0) ^ 0x9e3779b9);
  const L = SCENES[req.scene](n, box, r, K);
  if (L.H < MIN_FIG_PX) return { refused: `box ${box.w}x${box.h} is too small for ${n} figures (each would be ${Math.floor(L.H)} px tall; at least ${MIN_FIG_PX})` };
  const skin = SKINS[style];
  const crowd = makeCrowd({ n, seed: seed >>> 0, scene: 'queue', highlightK: K, highlightRule: 'queue_tail', layout: { type: 'queue', w: box.w, h: L.H } });
  if (crowd.items.length !== n) return { refused: `the people library made ${crowd.items.length} figures for ${n}` };
  // the caller's flags, stably partitioned: queue place q carries a lit flag exactly when q >= n - K (the caller's
  // K lit flags, all at the tail); the library's own pick is discarded. lit/total below count what is drawn.
  crowd.items.forEach((it, q) => { it.figure.highlight = q >= n - K; });

  const W = box.w, Hpic = Math.round(L.hUsed);
  const shadows = [], people = [], geometry = [];
  let lit = 0, total = 0;
  const slots = [];
  L.rows.forEach((row, k) => { for (const sl of row.slots) slots.push({ ...sl, row: k }); });
  const byQ = new Map(slots.map((sl) => [sl.q, sl]));
  // back rows first; within a row the lower (nearer) foot line later, then left to right
  slots.sort((a, b) => b.row - a.row || a.y - b.y || a.x - b.x);
  for (const sl of slots) {
    let fig = crowd.items[sl.q].figure;
    if (style === 'iso') fig = resampleHeight(fig, 6);
    else if (fig.height < skin.info.headRatio) fig = resampleHeight(fig, skin.info.headRatio);
    const fr = rng((fig.seed ^ (sl.q * 7919)) >>> 0);
    // everyone faces the head of the queue (screen left), 3/4 to profile; a talking pair turn to each other
    let target = -(62 + fr() * 40);
    const pi = fig.partner;
    if (pi !== null && pi !== undefined && byQ.has(pi)) target = (byQ.get(pi).x > sl.x ? 1 : -1) * (60 + fr() * 20);
    const turn = turnToFace(fig, target);
    const px = (L.H / fig.height) * (fig.scale || 1);
    const pal = looks(style, P, sl.q, fr);
    const frag = skin.drawFigure(fig, { x: sl.x, y: sl.y, px, palette: pal, seed: fig.seed, turn });
    const items = normalizeFragment(frag, { px, seed: (fig.seed ^ seed) >>> 0, palette: pal });
    if (!items.length) continue;
    const hh = L.H * (fig.scale || 1);
    const sh = style === 'ink' ? shadowInk(sl.x, sl.y, hh, P) : style === 'iso' ? shadowIso(sl.x, sl.y, hh, P) : (fig.highlight ? null : shadowGeo(sl.x, sl.y, hh, P));
    if (sh) shadows.push(sh);
    people.push(`<g>${writeItems(items, null)}</g>`);
    total++; if (fig.highlight) lit++;
    if (opts.geometry) {
      // for the test only (never in the reply): the head disc and torso core in picture pixels, and the fills drawn
      const J = posedJoints(fig, turn), S = (p) => [sl.x + p[0] * px, sl.y - p[1] * px];
      geometry.push({ q: sl.q, row: sl.row, col: sl.col, x: sl.x, lit: fig.highlight, head: [...S(J.head), (fig.thick.headR || 0.5) * px],
        torso: ['shL', 'shR', 'hipR', 'hipL', 'neck'].map((k) => S(J[k])), shW: (Math.max(fig.thick.upperArm || 0.4, fig.thick.torsoDepth || 0.9) / 2) * px, hipW: (Math.max(fig.thick.thigh || 0.6, (fig.thick.torsoDepth || 0.9) * 0.8) / 2) * px, fills: items.filter((it) => it.fill !== 'none').map((it) => it.d) });
    }
  }
  const ground = style === 'ink' ? groundInk(L, P, W, r, seed >>> 0) : style === 'iso' ? groundIso(L, P, W) : groundGeo(L, P, W, Hpic);
  const shadowSvg = writeItems(shadows.map((x) => ({ d: x.d, fill: x.fill, stroke: 'none', sw: 0, op: x.op, wash: style === 'ink' })), null);
  let defs = '';
  if (style === 'ink') defs = `<defs><linearGradient id="gfade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0"/><stop offset="0.25" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0.75"/><stop offset="0.8" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0.6"/><stop offset="1" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0"/></linearGradient></defs>`;
  const svg = `${defs}<g>${ground}</g><g>${shadowSvg}</g>${people.join('')}`;
  const reply = { svg, w: W, h: Hpic, lit, total, dropped: [] };
  if (opts.geometry) Object.defineProperty(reply, 'geometry', { value: { figures: geometry, H: L.H, slot: L.s, cols: L.cols }, enumerable: false });
  return reply;
}

// ---------- one line in, one line out ----------
function answer(line) {
  let reply;
  try { reply = draw(JSON.parse(line)); } catch (e) { reply = { refused: `scene: ${e && e.message ? e.message : String(e)}`.slice(0, 300) }; }
  process.stdout.write(JSON.stringify(reply) + '\n');
}
const isMain = !!process.argv[1] && /(^|[\/\\])scene\.mjs$/.test(process.argv[1]);
if (isMain) {
  let buf = '', done = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { if (done) return; buf += c; const k = buf.indexOf('\n'); if (k >= 0) { done = true; answer(buf.slice(0, k)); process.stdin.pause(); process.stdin.destroy(); } });
  process.stdin.on('end', () => { if (!done) { done = true; answer(buf); } });
}
