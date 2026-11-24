// Scene illustration node: `node scene.mjs` reads ONE JSON line on stdin and writes ONE JSON line on stdout.
//   request {"scene":"queue","style":"ink"|"iso"|"geo","seed":int,"figures":[{"lit":bool},...] (1..60),
//            "box":{"w":px,"h":px},"palette":{"ink","paper","accent", optional "skin","hair","top","bottom","outer","shade"}}
//   reply   {"svg","w","h","lit","total","dropped":[]}  or  {"refused":"<why>"}
// The node never decides who is lit: the i-th figure drawn carries figures[i].lit, and lit/total are counted
// from the figures actually drawn. The svg is the picture's inner markup (no outer <svg>), made only of what
// the page's hero gate takes (src/next_leaf.rs hero_faults): g, path, defs, linearGradient, stop, mask; hex
// colours; no text. No file read, no process, no network, no environment: only sibling modules.
import { makeCrowd, makeFigure, resampleHeight, _internal as LIBI } from './people_lib/lib.mjs';
import { turnToFace, posedJoints } from './people_lib/skins/common.mjs';
import * as inkSkin from './people_lib/skins/ink.mjs';
import * as isoSkin from './people_lib/skins/iso.mjs';
import * as geoSkin from './people_lib/skins/geo.mjs';
import { normalizeFragment, writeItems, writeD, hexOk, mix, fbm, cutBelow } from './normalize.mjs';

const SKINS = { ink: inkSkin, iso: isoSkin, geo: geoSkin };
const MIN_W = 160, MIN_H = 100, MAX_SIDE = 4000, MIN_FIG_PX = 36, MAX_FIGS = 60;
const PALETTE_KEYS = ['ink', 'paper', 'accent', 'skin', 'hair', 'top', 'bottom', 'outer', 'shade'];
const REQUEST_KEYS = ['scene', 'style', 'seed', 'figures', 'box', 'palette', 'order'];
const MAX_ITEMS = 80; // real figures (<= 60) plus gap markers

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
  const spec = SCENES[req.scene];
  if (spec.styles && !spec.styles.includes(req.style)) return `scene ${JSON.stringify(req.scene)} is drawn only in style ${spec.styles.join(', ')} (got ${JSON.stringify(req.style)})`;
  if (!Number.isSafeInteger(req.seed)) return 'seed must be an integer (e.g. 7)';
  if ('order' in req && !spec.given) return `order is only for scene "queue" (rank order); scene ${JSON.stringify(req.scene)} takes tally flags`;
  if ('order' in req && req.order !== 'given') return `order ${JSON.stringify(req.order)} is not known; allowed: "given" (rank order, first = front of the queue), or leave it out (lit at the tail in fives)`;
  const given = req.order === 'given';
  const F = req.figures;
  if (!Array.isArray(F) || F.length > MAX_ITEMS) return `figures must be a list of 1..${MAX_FIGS} {"lit":bool} (got ${Array.isArray(F) ? F.length : typeof F})`;
  const isGap = (f) => f && typeof f === 'object' && !Array.isArray(f) && f.gap === true && Object.keys(f).length === 1;
  for (let i = 0; i < F.length; i++) {
    const f = F[i];
    if (given && isGap(f)) {
      if (i === 0 || i === F.length - 1) return `figures[${i}]: a gap marker stands between figures, never at the start or the end`;
      if (isGap(F[i - 1])) return `figures[${i}]: two gap markers side by side (one marker stands for all the members left out)`;
      continue;
    }
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.lit !== 'boolean' || Object.keys(f).some((k) => k !== 'lit')) return given ? `figures[${i}] must be {"lit":true}, {"lit":false} or {"gap":true}` : `figures[${i}] must be {"lit":true} or {"lit":false} (gap markers only with "order":"given")`;
  }
  const real = F.filter((f) => !isGap(f)).length;
  if (real < 1 || real > MAX_FIGS) return `figures must hold 1..${MAX_FIGS} people (got ${real})`;
  if (spec.maxN && real > spec.maxN) return `scene ${JSON.stringify(req.scene)} holds at most ${spec.maxN} people (got ${real})`;
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
// ---------- layout: queue in a given order (rank: position = rank, first = the front of the queue) ----------
// Each figure keeps its own flag at its own place; nothing moves to the tail and no groups of five are cut. A gap
// marker is one empty slot (the caller's "members left out"), drawn with a small three-dot ellipsis. Up to 12
// stand in one row; more fill the front row from the head (left), then the rows behind, staggered half a slot.
function layoutGiven(items, box, r) {
  const W = box.w, Hb = box.h, side = 0.05;
  const toks = items.map((f) => (f.gap ? 'gap' : 'fig')), T = toks.length, n = toks.filter((t) => t === 'fig').length;
  let best = null;
  for (const R of n <= 12 ? [1] : [2, 3]) {
    const C = Math.ceil(T / R), rows = Math.ceil(T / C);
    const cols = (C - 1) + (rows > 1 ? 0.5 : 0);
    const H = Math.min((W * (1 - 2 * side)) / (cols * SLOT_K + 0.55), Hb / (1.22 + (rows - 1) * PITCH_K), Hb * 0.86);
    if (!best || H > best.H * 1.12) best = { H, C, R: rows };
  }
  const { H, C, R } = best, s = H * SLOT_K, pitch = H * PITCH_K;
  const span = (Math.min(C, T) - 1) * s + (R > 1 ? s / 2 : 0), x0 = (W - span) / 2;
  const yFront = H * 0.08 + H * 1.02 + (R - 1) * pitch;
  const rows = Array.from({ length: R }, (_, k) => ({ y: yFront - k * pitch, slots: [], gaps: [] }));
  let q = 0;
  toks.forEach((t, i) => {
    const k = Math.floor(i / C), col = i % C, row = rows[k], x = x0 + col * s + (k % 2 ? s / 2 : 0);
    if (t === 'gap') row.gaps.push({ col, x, y: row.y });
    else row.slots.push({ q: q++, col, x, y: row.y + (r() * 2 - 1) * H * 0.008 });
  });
  return { H, s, pitch, cols: C, rows, hUsed: Math.min(Hb, yFront + H * 0.12) };
}
// three dots at chest height in an empty slot: the members left out
function ellipsis(L, P) {
  const rad = Math.max(1.6, L.H * 0.022), step = rad * 3.2, pts = [];
  for (const row of L.rows) for (const g of row.gaps || []) for (const k of [-1, 0, 1]) {
    const cx = g.x + k * step, cy = g.y - L.H * 0.5, ring = [];
    for (let a = 0; a < 12; a++) ring.push([cx + rad * Math.cos(a / 12 * Math.PI * 2), cy + rad * Math.sin(a / 12 * Math.PI * 2)]);
    pts.push({ closed: true, pts: ring });
  }
  return pts.length ? `<g fill="${P.ink}" stroke="none"><path d="${writeD(pts)}"/></g>` : '';
}
// ---------- layout: grid (a classroom: one person standing behind each desk) ----------
// columns = round(sqrt(N * A)), A = box aspect x 0.39 (the drawn grid's row pitch over its column step), so 30
// people in a 1200x560 box sit 5 x 6, 20 sit 4 x 5, 12 sit 3 x 4, 8 sit 3 x 3, 60 sit 7 x 9; desks past N stay
// empty at the back right. Rows recede up and to the right (oblique, no perspective). Desk q runs row-major from
// the front-left, and the lit are the first K desks: one contiguous block counted by rows.
const GRID_COL = 0.95, GRID_PITCH = 0.82, GRID_DX = 0.22, DESK_TOP = 0.43; // a seated class: desk top above the lap
// Seated poses for the class, as scene data: the library's one chair-height sit (sit_bench: thigh 85, knee 85)
// with the arms (and head, and hand-held prop) of standing poses, so the hands show above the desk. Registered in
// the copy's pose table at load (no file is changed); sit_bench's own bench prop is dropped (this scene draws a chair).
const SEATED = (() => {
  const P = LIBI.DATA.poses, base = P.sit_bench;
  if (!base) return [];
  const desk = { pitch: 30, roll: 4, elbow: 95, twist: 30 };
  const mk = (id, extra) => { P[id] = { ...base, needs: null, props: [], tags: ['sit'], ...extra }; return id; };
  const from = (k) => (P[k] ? { head: P[k].head, armL: P[k].armL, armR: P[k].armR, props: (P[k].props || []).filter((x) => /phone|folder/.test(x.type)) } : {});
  return {
    rest: mk('sit_desk_rest', { armL: desk, armR: { ...desk, elbow: 84 }, head: { pitch: 8, yaw: 6, roll: 0 } }),
    phone: mk('sit_desk_phone', from('phone_look')),
    cross: mk('sit_desk_cross', from('arms_crossed')),
    chin: mk('sit_desk_chin', { armL: desk, armR: { pitch: 34, roll: 10, elbow: 140, twist: 40 }, head: { pitch: 4, yaw: 10, roll: 6 } }),
  };
})();
function layoutGrid(n, box, r, K, style) {
  return style === 'iso' ? layoutGridIso(n, box, r) : layoutGridFlat(n, box, r);
}
// flat styles (geo, ink): a frontal, eye-level class. Rows stack up the picture (further = higher, each step 6.5%
// smaller); each row sits behind one long desk board that hides its laps and legs, so only head, shoulders and
// upper torso show above it. Rows and people never overlap; desk q runs row-major from the front-left (bottom row).
const FLAT_STEP = 0.935, BOARD_TOP = 0.36, BOARD_BOTTOM = 0.17, CUT_AT = 0.2, HEAD_TOP = 0.84, ROW_GAP = 0.06, FLAT_COL = 0.78;
function layoutGridFlat(n, box, r) {
  const W = box.w, Hb = box.h;
  const A = (W / Hb) * 0.39, c = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * A)))), R = Math.ceil(n / c);
  // feet lines in units of H (front row at 0, rows behind higher), then H from the box
  const sc = Array.from({ length: R }, (_, k) => Math.pow(FLAT_STEP, k)), yu = [0];
  // a row's band runs from its head tops (HEAD_TOP above the feet) to its board's bottom (BOARD_BOTTOM above the feet)
  for (let k = 1; k < R; k++) yu.push(yu[k - 1] - (HEAD_TOP - BOARD_BOTTOM + ROW_GAP) * sc[k - 1]);
  const topU = yu[R - 1] - HEAD_TOP * sc[R - 1], hU = 0.04 - BOARD_BOTTOM - topU + 0.04;
  const H = Math.min((Hb * 0.98) / hU, (W * 0.92) / ((c - 1) * FLAT_COL + 1.0), Hb * 0.9);
  // the class fills the width: seats spread up to 1.7 H apart (never closer than FLAT_COL)
  const fc = c > 1 ? Math.max(FLAT_COL, Math.min(1.7, ((W * 0.9) / H - 1.0) / (c - 1))) : FLAT_COL;
  const y0 = H * (0.04 - topU), boards = [];
  const rows = yu.map((u, k) => ({ y: y0 + u * H, k: sc[k], slots: [], empty: [] }));
  for (let d = 0; d < c * R; d++) {
    const k = Math.floor(d / c), col = d % c, row = rows[k], step = fc * H * row.k, x = W / 2 + (col - (c - 1) / 2) * step;
    if (d < n) row.slots.push({ q: d, col, x, y: row.y, k: row.k });
  }
  rows.forEach((row, k) => { const half = ((c - 1) / 2) * fc * H * row.k + 0.62 * FLAT_COL * H * row.k; boards.push({ row: k, x0: W / 2 - half, x1: W / 2 + half, top: row.y - BOARD_TOP * H * row.k, bottom: row.y - BOARD_BOTTOM * H * row.k, k: row.k }); });
  const hUsed = Math.min(Hb, y0 + (0.04 - BOARD_BOTTOM) * H);
  return {
    H, s: fc * H, cols: c, rows, boards, hUsed, noDoor: true,
    litOf: (q, K) => q < K, seated: true, poses: [SEATED.rest, SEATED.chin, SEATED.cross, SEATED.phone],
    // facing the class front (the viewer), turned a little either way, never square on
    face: (sl, fr) => (fr() < 0.5 ? -1 : 1) * (24 + fr() * 18),
    clipY: (sl) => sl.y - BOARD_TOP * H * sl.k,
    // everything below the board's bottom edge is cut from the figure (the board hides the rest of the lap)
    cutY: (sl) => sl.y - CUT_AT * H * sl.k, // a little above the board's bottom edge, so nothing peeks below it
    shadow: () => null,
    ground: (P, style) => (style === 'geo' ? `<path d="M0 0H${f1(W)}V${f1(hUsed)}H0Z" fill="${mix(P.paper, P.ink, 0.2)}" stroke="none"/>` : ''),
    board: (k, style, P) => boardSvg(boards[k], style, P, H),
  };
}
function boardSvg(b, style, P, H) {
  const lip = H * b.k * 0.05, ring = (y0, y1) => writeD([{ closed: true, pts: [[b.x0, y0], [b.x1, y0], [b.x1, y1], [b.x0, y1]] }]);
  if (style === 'geo') return `<g stroke="none"><path d="${ring(b.top, b.bottom)}" fill="${mix(P.paper, P.ink, 0.07)}"/><path d="${ring(b.top, b.top + lip)}" fill="${P.paper}"/><path d="${ring(b.top + lip, b.top + lip * 1.6)}" fill="${mix(P.paper, P.ink, 0.28)}"/></g>`;
  // ink: a paper board with a light wash, a heavy broken pen line along the top and a lighter one under the lip
  const w = Math.max(1, Math.min(2.6, H * b.k * 0.014)), line = (y, x0, x1, sd) => { const pts = []; for (let x = x0; x <= x1 + 0.01; x += 8) pts.push([x, y + fbm(x / 60, y / 40, sd) * 1.2]); return { closed: false, pts }; };
  const cut = b.x0 + (b.x1 - b.x0) * 0.62;
  return `<g stroke="none"><path d="${ring(b.top, b.bottom)}" fill="${P.paper}"/><path d="${ring(b.top + lip * 0.4, b.top + lip * 2.4)}" fill="${mix(P.paper, '#d6b85e', 0.5)}" opacity="0.55"/></g>`
    + `<g fill="none" stroke="${P.ink}" stroke-width="${f1(w)}" stroke-linejoin="round"><path d="${writeD([line(b.top, b.x0 - 4, cut, 11), line(b.top + 0.5, cut + 6, b.x1 + 4, 12)])}"/></g>`
    + `<g fill="none" stroke="${P.ink}" stroke-width="${f1(w * 0.45)}" stroke-linejoin="round"><path d="${writeD([line(b.top + lip, b.x0, b.x1, 13), { closed: false, pts: [[b.x0, b.top], [b.x0 + 1, b.bottom]] }, { closed: false, pts: [[b.x1, b.top], [b.x1 - 1, b.bottom]] }])}"/></g>`;
}
// iso: the oblique class with a desk and a chair per person; rows 0.82 H apart so a head never meets the legs of
// the desk behind; only poses whose arms stay over the desk (forearms on the desk, hand to chin, arms crossed)
function layoutGridIso(n, box, r) {
  const W = box.w, Hb = box.h, side = 0.04;
  const A = (W / Hb) * 0.39, c = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * A)))), R = Math.ceil(n / c);
  // H is a standing person's height; seated, the head tops out near 0.78 H
  const H = Math.min((W * (1 - 2 * side)) / ((c - 1) * GRID_COL + (R - 1) * GRID_DX + 0.9), Hb / (0.9 + (R - 1) * GRID_PITCH + 0.12), Hb * 1.1);
  const colStep = H * GRID_COL, pitch = H * GRID_PITCH, dx = H * GRID_DX;
  const span = (c - 1) * colStep + (R - 1) * dx, x0 = (W - span) / 2;
  const yFront = H * 0.86 + (R - 1) * pitch;
  const rows = Array.from({ length: R }, (_, k) => ({ y: yFront - k * pitch, slots: [], empty: [] }));
  for (let d = 0; d < c * R; d++) {
    const k = Math.floor(d / c), col = d % c, x = x0 + col * colStep + k * dx, y = rows[k].y;
    if (d < n) rows[k].slots.push({ q: d, col, x, y: y + (r() * 2 - 1) * H * 0.006 }); else rows[k].empty.push({ col, x, y });
  }
  return {
    H, s: colStep, pitch, cols: c, rows, hUsed: Math.min(Hb, yFront + H * 0.14), noDoor: true,
    litOf: (q, K) => q < K,
    // facing the front of the class (the viewer's left), three-quarter, never square on
    face: (sl, fr) => -(32 + fr() * 28),
    desk: true, seated: true, chair: true, poses: [SEATED.rest, SEATED.chin, SEATED.cross],
    // the level of the desk top's back edge: above it a seated person must stay in view
    clipY: (sl) => sl.y - H * (DESK_TOP + 0.03),
  };
}
// a desk in front of the person standing at (x, y): an oblique top, a front panel, a side and legs, per style
function deskPaths(x, y, H) {
  const a = [x - H * 0.33, y - H * DESK_TOP + H * 0.04], b = [x + H * 0.29, a[1]], o = [H * 0.1, -H * 0.07], th = H * 0.1;
  const c = [b[0] + o[0], b[1] + o[1]], d = [a[0] + o[0], a[1] + o[1]], leg = H * 0.025, foot = y + H * 0.05;
  return {
    top: [a, b, c, d], front: [a, b, [b[0], b[1] + th], [a[0], a[1] + th]], side: [b, c, [c[0], c[1] + th], [b[0], b[1] + th]],
    legs: [[a[0] + leg * 0.5, a[1] + th], [b[0] - leg * 1.5, b[1] + th], [c[0] - leg * 1.5, c[1] + th]].map(([lx, ly], i) => [[lx, ly], [lx + leg, ly], [lx + leg, i === 2 ? foot - H * 0.07 : foot], [lx, i === 2 ? foot - H * 0.07 : foot]]),
  };
}
function deskSvg(style, x, y, H, P, seed) {
  const D = deskPaths(x, y, H), poly = (pts) => writeD([{ closed: true, pts }]);
  if (style === 'iso') {
    const wood = mix(P.paper, '#b8925f', 0.5);
    return `<g stroke="none"><path d="${poly(D.legs[2])}" fill="${mix(P.ink, P.paper, 0.35)}"/><path d="${poly(D.top)}" fill="${mix(wood, P.paper, 0.35)}"/><path d="${poly(D.front)}" fill="${wood}"/><path d="${poly(D.side)}" fill="${mix(wood, P.ink, 0.3)}"/><path d="${writeD(D.legs.slice(0, 2).map((pts) => ({ closed: true, pts })))}" fill="${mix(P.ink, P.paper, 0.35)}"/></g>`;
  }
  if (style === 'geo') {
    // flat planes: a light top, a mid front, a darker side; thin legs
    return `<g stroke="none"><path d="${writeD(D.legs.map((pts) => ({ closed: true, pts })))}" fill="${mix(P.paper, P.ink, 0.45)}"/><path d="${poly(D.top)}" fill="${mix(P.paper, P.ink, 0.03)}"/><path d="${poly(D.front)}" fill="${mix(P.paper, P.ink, 0.16)}"/><path d="${poly(D.side)}" fill="${mix(P.paper, P.ink, 0.3)}"/></g>`;
  }
  // ink: paper planes, a light wash on the top, broken pen lines with a little wobble
  const w = Math.max(0.9, Math.min(2.2, H * 0.011)), wob = (pts) => pts.map(([px, py]) => [px + fbm(px / 30, py / 30, seed & 0xffff) * 0.8, py + fbm(px / 30 + 7, py / 30, (seed + 3) & 0xffff) * 0.8]);
  const line = (p, q) => { const pts = []; for (let t = 0; t <= 1.0001; t += 0.125) pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); return { closed: false, pts: wob(pts) }; };
  const [a, b, c, d] = D.top, fa = D.front[3], fb = D.front[2], sc = D.side[2];
  const edges = [line(a, b), line(b, c), line(c, [d[0] + (c[0] - d[0]) * 0.35, d[1] + (c[1] - d[1]) * 0.35]), line(d, a), line(fa, fb), line(b, fb), line(c, sc), line(sc, fb)];
  const legs = D.legs.map((L) => line([(L[0][0] + L[1][0]) / 2, L[0][1]], [(L[2][0] + L[3][0]) / 2, L[2][1]]));
  return `<g stroke="none"><path d="${poly([a, b, c, sc, fb, fa])}" fill="${P.paper}"/><path d="${poly(D.top)}" fill="${mix(P.paper, '#d6b85e', 0.5)}" opacity="0.7"/></g><g fill="none" stroke="${P.ink}" stroke-width="${f1(w)}" stroke-linejoin="round"><path d="${writeD([...edges, ...legs])}"/></g>`;
}

// ---------- layout: door (geometric only): the light out of a tall doorway, people in a line facing it ----------
// The composition of taste/geo/plate.html in picture units: a dark wall and floor, a tall doorway cropped by the
// top edge, its light spilling across the floor; the line runs from the door toward the viewer, nearer people
// larger. The light's left edge runs through the gap between the last person inside it and the first left out:
// the K flagged people stand outside the light (in the accent), the others inside it (dark on the light).
function layoutDoor(n, box, r, K) {
  const W = box.w, Hpic = Math.min(box.h, Math.round(W * 0.667)), u = Hpic / 800, v = W / 1200;
  const HW = 520 * u, DL = 880 * v, DR = 975 * v;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0.5, y = (548 + 232 * Math.pow(t, 0.9)) * u, x = (960 - 700 * t) * v;
    pts.push({ q: i, col: i, x, y, k: 0.55 + ((y / u - 520) / 280) * 0.95 });
  }
  const inside = n - K;
  let mid;
  if (inside > 0 && K > 0) { const a = pts[inside - 1], b = pts[inside]; mid = { x: (a.x + b.x) / 2 - 4 * v, y: (a.y + b.y) / 2 }; }
  else if (K === 0) { const a = pts[n - 1]; mid = { x: a.x - 90 * v, y: a.y }; }
  else { const a = pts[0]; mid = { x: a.x + 60 * v, y: a.y }; }
  const edgeAt = (y) => DL + (mid.x - DL) * (y - HW) / (mid.y - HW);
  const spill = [[DL, HW], [DR, HW], [W, Hpic], [edgeAt(Hpic), Hpic]];
  return {
    H: 150 * u, s: 0, cols: n, rows: [{ y: 0, slots: pts }], hUsed: Hpic, spill,
    litOf: (q, K2) => q >= n - K2,
    face: (sl, fr) => 35 + fr() * 30 - 15,
    ground: (P) => {
      const wall = mix(P.ink, P.paper, 0.12), floor = mix(P.ink, P.paper, 0.2), light = P.paper, leaf = mix(P.ink, P.paper, 0.25);
      const poly = (p) => writeD([{ closed: true, pts: p }]);
      const LY = 640 * u, lx = edgeAt(LY);
      return `<g stroke="none"><path d="${poly([[0, 0], [W, 0], [W, HW], [0, HW]])}" fill="${wall}"/><path d="${poly([[0, HW], [W, HW], [W, Hpic], [0, Hpic]])}" fill="${floor}"/>`
        + `<path d="${poly(spill)}" fill="${light}"/><path d="${poly([[DL - 14 * v, 0], [DR + 14 * v, 0], [DR + 14 * v, HW], [DL - 14 * v, HW]])}" fill="${P.ink}"/>`
        + `<path d="${poly([[DL, 0], [DR, 0], [DR, HW], [DL, HW]])}" fill="${light}"/><path d="${poly([[DL, 0], [lx, 0], [lx, LY], [DL, HW]])}" fill="${leaf}"/>`
        + `<path d="${poly([[lx + 18 * v, 318 * u], [lx + 44 * v, 318 * u], [lx + 44 * v, 325 * u], [lx + 18 * v, 325 * u]])}" fill="${P.ink}"/></g>`
        + `<g fill="none" stroke="${light}" stroke-width="${f1(Math.max(1, 2 * u))}" opacity="0.55"><path d="${writeD([{ closed: false, pts: [[lx, 0], [lx, LY]] }])}"/></g>`;
    },
    // a long shadow toward the viewer for the people in the light, cut to the light's shape
    shadow: (sl, hh, fig, P) => {
      if (fig.highlight) return null;
      const s = sl.k, x = sl.x, y = sl.y, h = hh;
      const shp = [[x - 13 * s * u, y - 1], [x + 13 * s * u, y - 1], [x - 0.5 * h + 9 * s * u, y + 0.55 * h], [x - 0.5 * h - 4 * s * u, y + 0.6 * h], [x - 0.5 * h - 15 * s * u, y + 0.53 * h]];
      const cut = clipConvex(shp, spill);
      return cut.length >= 3 ? { d: writeD([{ closed: true, pts: cut }]), fill: mix(P.paper, P.ink, 0.17), op: 1 } : null;
    },
  };
}
// a chair under a seated person: a seat at the pelvis and a low back on the side away from the face
function chairPaths(pv, faceX, H) {
  const back = -faceX, sy = pv[1] + H * 0.035, x0 = pv[0] - H * 0.15, x1 = pv[0] + H * 0.15;
  const bx = pv[0] + back * H * 0.13, top = sy - H * 0.2, w = H * 0.035;
  return [[[x0, sy], [x1, sy], [x1 + H * 0.05, sy - H * 0.035], [x0 + H * 0.05, sy - H * 0.035]], [[bx - w, top], [bx + w, top], [bx + w, sy], [bx - w, sy]], [[x0 + H * 0.02, sy], [x0 + H * 0.04, sy], [x0 + H * 0.04, sy + H * 0.27], [x0 + H * 0.02, sy + H * 0.27]]];
}
function chairSvg(style, ch, P) {
  const d = (k) => writeD([{ closed: true, pts: ch[k] }]);
  if (style === 'iso') return `<g stroke="none"><path d="${d(2)}" fill="${mix(P.ink, P.paper, 0.35)}"/><path d="${d(1)}" fill="${mix(P.paper, '#7d6a55', 0.6)}"/><path d="${d(0)}" fill="${mix(P.paper, '#7d6a55', 0.45)}"/></g>`;
  if (style === 'geo') return `<g stroke="none"><path d="${d(2)}" fill="${mix(P.paper, P.ink, 0.45)}"/><path d="${d(1)}" fill="${mix(P.paper, P.ink, 0.38)}"/><path d="${d(0)}" fill="${mix(P.paper, P.ink, 0.3)}"/></g>`;
  return `<g fill="${P.paper}" stroke="${P.ink}" stroke-width="${f1(Math.max(0.8, Math.min(1.8, ch[0][1][0] - ch[0][0][0]) * 0.02))}" stroke-linejoin="round"><path d="${d(2)}"/><path d="${d(1)}"/><path d="${d(0)}"/></g>`;
}
// the desk's outline (top, front and side as one ring) for the test's occlusion count
function deskGeom(x, y, H) { const D = deskPaths(x, y, H); return { d: writeD([{ closed: true, pts: [D.top[0], D.top[1], D.top[2], D.side[2], D.front[2], D.front[3]] }, ...D.legs.map((pts) => ({ closed: true, pts }))]) }; }
// Sutherland-Hodgman: polygon `p` cut to the convex polygon `c` (either winding)
function clipConvex(p, c) {
  let out = p;
  const sgn = Math.sign(c.reduce((s, a, i) => { const b = c[(i + 1) % c.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) || 1;
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length], inn = (q) => sgn * ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) >= 0;
    const src = out; out = [];
    for (let j = 0; j < src.length; j++) {
      const P1 = src[j], P0 = src[(j + src.length - 1) % src.length];
      const cross = () => { const d1 = [P1[0] - P0[0], P1[1] - P0[1]], d2 = [b[0] - a[0], b[1] - a[1]], den = d1[0] * d2[1] - d1[1] * d2[0]; const t = den ? ((a[0] - P0[0]) * d2[1] - (a[1] - P0[1]) * d2[0]) / den : 0; return [P0[0] + d1[0] * t, P0[1] + d1[1] * t]; };
      if (inn(P1)) { if (!inn(P0)) out.push(cross()); out.push(P1); } else if (inn(P0)) out.push(cross());
    }
  }
  return out;
}
const SCENES = {
  queue: { tally: layoutQueue, given: layoutGiven },
  grid: { tally: layoutGrid },
  door: { tally: layoutDoor, styles: ['geo'], maxN: 10 },
};

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
function groundGeo(L, P, W, hUsed, door = true) {
  // one flat greyish base (the wall), a lighter floor band under each row, and a tall light doorway at the
  // head of the queue cropped by the top edge: the big shape the eye meets first
  const wall = mix(P.paper, P.ink, 0.2), floor = mix(P.paper, P.ink, 0.06), light = P.paper;
  let s = `<path d="M0 0H${f1(W)}V${f1(hUsed)}H0Z" fill="${wall}" stroke="none"/>`;
  const [ea, eb] = extent(L, 0.5), yB = L.rows[L.rows.length - 1].y - L.H * 0.035, yF = L.rows[0].y + L.H * 0.075;
  s += `<path d="${writeD([{ closed: true, pts: [[ea, yB], [eb, yB], [eb - L.H * 0.12, yF], [ea + L.H * 0.04, yF]] }])}" fill="${floor}" stroke="none"/>`;
  if (!door) return s;
  const front = L.rows[0], hx = extent(L, 0)[0] - L.H * 0.34; // clear of the first person and their arms
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
  const given = req.order === 'given';
  const people0 = figures.filter((f) => !f.gap), nGaps = figures.length - people0.length;
  const n = people0.length;
  const K = people0.filter((f) => f.lit).length;
  const r = rng((seed >>> 0) ^ 0x9e3779b9);
  const L = given ? SCENES[req.scene].given(figures, box, r) : SCENES[req.scene].tally(n, box, r, K, style);
  const litOf = L.litOf || ((q) => q >= n - K);
  if (L.H < MIN_FIG_PX) return { refused: `box ${box.w}x${box.h} is too small for ${n} figures (each would be ${Math.floor(L.H)} px tall; at least ${MIN_FIG_PX})` };
  const skin = SKINS[style];
  const crowd = makeCrowd({ n, seed: seed >>> 0, scene: 'queue', highlightK: K, highlightRule: 'queue_tail', layout: { type: 'queue', w: box.w, h: L.H } });
  if (crowd.items.length !== n) return { refused: `the people library made ${crowd.items.length} figures for ${n}` };
  // the caller's flags, stably partitioned: queue place q carries a lit flag exactly when q >= n - K (the caller's
  // K lit flags, all at the tail); the library's own pick is discarded. lit/total below count what is drawn.
  // order "given": queue place q (0 = the front) is the q-th real figure and carries its own flag, unmoved
  // grid: the first K desks (row-major from the front-left); door: the last K in the line (outside the light)
  crowd.items.forEach((it, q) => { it.figure.highlight = given ? people0[q].lit : litOf(q, K); });
  // a seated scene keeps each person's body, hair and outfit and seats them (a seeded spread of the seated poses)
  if (L.seated && L.poses && L.poses.length) {
    const order = L.poses.map((p, i) => [p, rng((seed ^ (i * 2654435761)) >>> 0)()]).sort((a, b) => a[1] - b[1]).map((a) => a[0]);
    crowd.items.forEach((it, q) => { const f = it.figure; it.figure = makeFigure({ pose: order[q % order.length], body: f.body, hair: f.hair, outfit: f.outfit, seed: f.seed, facing: f.facing, highlight: f.highlight }); });
  }

  const W = box.w, Hpic = Math.round(L.hUsed);
  const shadows = [], people = [], geometry = [], occluders = [];
  let lit = 0, total = 0;
  const slots = [];
  L.rows.forEach((row, k) => { for (const sl of row.slots) slots.push({ ...sl, row: k }); });
  const byQ = new Map(slots.map((sl) => [sl.q, sl]));
  // back rows first; within a row the lower (nearer) foot line later, then left to right
  slots.sort((a, b) => b.row - a.row || a.y - b.y || a.x - b.x);
  slots.forEach((sl, si) => {
    let fig = crowd.items[sl.q].figure;
    if (style === 'iso') fig = resampleHeight(fig, 6);
    else if (fig.height < skin.info.headRatio) fig = resampleHeight(fig, skin.info.headRatio);
    const fr = rng((fig.seed ^ (sl.q * 7919)) >>> 0);
    // everyone faces the head of the queue (screen left), 3/4 to profile; a talking pair turn to each other
    let target = L.face ? L.face(sl, fr) : -(62 + fr() * 40);
    const pi = fig.partner;
    if (!L.face && pi !== null && pi !== undefined && byQ.has(pi)) target = (byQ.get(pi).x > sl.x ? 1 : -1) * (60 + fr() * 20);
    const turn = turnToFace(fig, target);
    const px = ((L.H * (sl.k || 1)) / fig.height) * (fig.scale || 1);
    const pal = looks(style, P, sl.q, fr);
    const frag = skin.drawFigure(fig, { x: sl.x, y: sl.y, px, palette: pal, seed: fig.seed, turn });
    let items = normalizeFragment(frag, { px, seed: (fig.seed ^ seed) >>> 0, palette: pal });
    if (L.cutY) items = cutBelow(items, L.cutY(sl));
    if (!items.length) return;
    const hh = L.H * (sl.k || 1) * (fig.scale || 1);
    const sh = L.shadow ? L.shadow(sl, hh, fig, P) : style === 'ink' ? shadowInk(sl.x, sl.y, hh, P) : style === 'iso' ? shadowIso(sl.x, sl.y, hh, P) : (fig.highlight ? null : shadowGeo(sl.x, sl.y, hh, P));
    if (sh) shadows.push(sh);
    // seated: a chair behind the person (drawn first), then the person, then the desk in front of them
    let chair = '';
    if (L.chair) {
      const J0 = posedJoints(fig, turn), pv = [sl.x + J0.pelvis[0] * px, sl.y - J0.pelvis[1] * px];
      const fx = (fig.dirs && fig.dirs.face) ? Math.sign(Math.cos(turn * Math.PI / 180) * fig.dirs.face[0] + Math.sin(turn * Math.PI / 180) * fig.dirs.face[2]) || -1 : -1;
      const ch = chairPaths(pv, fx, L.H);
      chair = chairSvg(style, ch, P);
      if (opts.geometry) occluders.push({ after: geometry.length - 1, d: writeD(ch.map((pts) => ({ closed: true, pts }))) });
    }
    const desk = L.desk ? deskSvg(style, sl.x, sl.y, L.H, P, (seed + sl.q * 131) >>> 0) : '';
    // a row's long desk board goes in right after the row's last person (flat grid)
    const lastOfRow = L.board && (si === slots.length - 1 || slots[si + 1].row !== sl.row);
    const board = lastOfRow ? L.board(sl.row, style, P) : '';
    people.push(`${chair}<g>${writeItems(items, null)}</g>${desk}${board}`);
    if (desk && opts.geometry) occluders.push({ after: geometry.length, ...deskGeom(sl.x, sl.y, L.H) });
    total++; if (fig.highlight) lit++;
    if (opts.geometry) {
      // for the test only (never in the reply): the head disc and torso core in picture pixels, and the fills drawn
      const J = posedJoints(fig, turn), S = (p) => [sl.x + p[0] * px, sl.y - p[1] * px];
      geometry.push({ q: sl.q, row: sl.row, col: sl.col, x: sl.x, footY: sl.y, clipY: L.clipY ? L.clipY(sl) : null, lit: fig.highlight, head: [...S(J.head), (fig.thick.headR || 0.5) * px],
        arms: ['elL', 'wrL', 'fingL', 'elR', 'wrR', 'fingR'].map((k) => S(J[k])), legs: ['hipL', 'knL', 'anL', 'hipR', 'knR', 'anR'].map((k) => S(J[k])),
        deskX: L.desk ? [sl.x - L.H * 0.33, sl.x + L.H * 0.39] : null,
        torso: ['shL', 'shR', 'hipR', 'hipL', 'neck'].map((k) => S(J[k])), shW: (Math.max(fig.thick.upperArm || 0.4, fig.thick.torsoDepth || 0.9) / 2) * px, hipW: (Math.max(fig.thick.thigh || 0.6, (fig.thick.torsoDepth || 0.9) * 0.8) / 2) * px, fills: items.filter((it) => it.fill !== 'none').map((it) => it.d) });
    }
    if (board && opts.geometry) { const bd = L.boards[sl.row]; occluders.push({ after: geometry.length - 1, row: sl.row, d: writeD([{ closed: true, pts: [[bd.x0, bd.top], [bd.x1, bd.top], [bd.x1, bd.bottom], [bd.x0, bd.bottom]] }]) }); }
  });
  const empty = L.desk ? L.rows.flatMap((row) => row.empty || []).map((e) => deskSvg(style, e.x, e.y, L.H, P, (seed + e.col * 977) >>> 0)).join('') : '';
  const ground = L.ground ? L.ground(P, style) : style === 'ink' ? groundInk(L, P, W, r, seed >>> 0) : style === 'iso' ? groundIso(L, P, W) : groundGeo(L, P, W, Hpic, !L.noDoor);
  const shadowSvg = writeItems(shadows.map((x) => ({ d: x.d, fill: x.fill, stroke: 'none', sw: 0, op: x.op, wash: style === 'ink' })), null);
  let defs = '';
  if (style === 'ink') defs = `<defs><linearGradient id="gfade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0"/><stop offset="0.25" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0.75"/><stop offset="0.8" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0.6"/><stop offset="1" stop-color="${P.shade || mix(P.paper, '#d6b85e', 0.5)}" stop-opacity="0"/></linearGradient></defs>`;
  const dots = given ? ellipsis(L, P) : '';
  const svg = `${defs}<g>${ground}</g><g>${shadowSvg}</g>${dots}${empty}${people.join('')}`;
  const reply = { svg, w: W, h: Hpic, lit, total, dropped: [] };
  if (given) reply.gaps = L.rows.reduce((s, row) => s + row.gaps.length, 0);
  if (given && reply.gaps !== nGaps) return { refused: `drew ${reply.gaps} gap markers for ${nGaps}` };
  if (opts.geometry) Object.defineProperty(reply, 'geometry', { value: { figures: geometry, H: L.H, slot: L.s, cols: L.cols, gaps: L.rows.flatMap((row, k) => (row.gaps || []).map((g) => ({ row: k, col: g.col }))), occluders, spill: L.spill || null, boards: L.boards || null, desks: L.desk ? L.rows.flatMap((row, k) => row.slots.map((sl) => ({ row: k, legs: deskPaths(sl.x, sl.y, L.H).legs }))) : null }, enumerable: false });
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
