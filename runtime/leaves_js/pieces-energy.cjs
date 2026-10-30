// Energy pieces for the page-bottom illustration strip (EU renewable-energy share page): wind turbine, solar array, hydro dam, biomass.
// Same shape as pieces-v2.cjs: plain elements {t: path|line|rect|ellipse|circle, w, col: ink|acc, cls: main|mid|fine|hatch|wave};
// each piece returns {els, box:[bx, by0, bw], base, below}. No fills, hatch only as ground texture, ONE accent element group per piece.
// Closed small features (rect/circle/ellipse) stay >= 6 units; tiny chips and ears are drawn as paths (never dropped by the 3 px check).
function kit() {
  const E = [];
  const add = (o, d) => E.push({ w: 1, col: 'ink', cls: 'mid', ...d, ...o });
  return { E,
    L: (x1, y1, x2, y2, o = {}) => add(o, { t: 'line', x1, y1, x2, y2 }),
    P: (d, o = {}) => add(o, { t: 'path', d }),
    R: (x, y, w, h, o = {}) => add(o, { t: 'rect', x, y, width: w, height: h }),
    C: (cx, cy, r, o = {}) => add(o, { t: 'circle', cx, cy, r }),
    EL: (cx, cy, rx, ry, o = {}) => add(o, { t: 'ellipse', cx, cy, rx, ry }) };
}
const M = { cls: 'main' }, MID = { cls: 'mid' }, FINE = { cls: 'fine' }, HT = { cls: 'hatch' }, ACC = { cls: 'fine', col: 'acc' };
const f1 = (v) => Math.round(v * 10) / 10;
const waves = (k, x0, x1, y, amp = 3, step = 18) => { let d = `M${x0},${y}`; for (let x = x0; x < x1; x += step) d += ` q${step / 4},${-amp} ${step / 2},0 t${step / 2},0`; k.P(d, { cls: 'wave' }); };
const ground = (k, x0, x1, y, hump = 0) => { k.P(`M${x0},${y + 2} C${x0 + (x1 - x0) * 0.3},${y - hump} ${x0 + (x1 - x0) * 0.7},${y + hump / 2} ${x1},${y}`, M);
  for (let x = x0 + 6; x < x1 - 4; x += 12) k.L(x, y + 6 + (x % 3), x - 7, y + 17, HT); };
const dash = (k, x1, y1, x2, y2, seg, gap, o) => { const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  for (let s = 0; s < len - 2; s += seg + gap) { const e = Math.min(s + seg, len); k.L(f1(x1 + ux * s), f1(y1 + uy * s), f1(x1 + ux * e), f1(y1 + uy * e), o); } };

// 1. wind turbine: tapered tower in segments with flanges, door and platform, nacelle with vents and anemometer, hub with accent spinner, three blades with root rings and chord lines, small far turbine
function turbine() {
  const k = kit(), { L, P, R, C, EL } = k;
  const H = [150, 52];
  ground(k, 30, 300, 190, 3);
  P('M163,191 L203,191 L201,184 L165,184 Z', MID); L(170, 184, 170, 191, FINE); L(196, 184, 196, 191, FINE);   // foundation collar
  const TX = 183;
  const hw = (y) => 7 - (y - 62) * 3 / 128;          // tower half width: 7 at the base, 4 at the top
  L(TX - hw(190), 184, TX - hw(62), 62, M); L(TX + hw(190), 184, TX + hw(62), 62, M);
  for (const y of [152, 120, 90]) { L(TX - hw(y) - 2, y, TX + hw(y) + 2, y, MID); L(TX - hw(y), y + 3.5, TX + hw(y), y + 3.5, FINE); }  // flange pairs between segments
  P('M179,184 L179,168 Q183,164 187,168 L187,184', FINE); L(185, 176, 185, 177.5, FINE);                      // service door
  L(TX, 100, TX, 140, FINE); for (const y of [104, 112, 120, 128]) L(TX - 2.5, y, TX + 2.5, y, HT);  // ladder hint
  EL(TX, 63, 9, 3, FINE);                                                                                    // yaw platform ring
  P('M158,41 L198,41 Q206,41 210,46 L212,56 Q206,60 198,60 L158,60', M);                                      // nacelle housing
  L(168, 41, 168, 60, FINE); L(190, 41, 190, 60, FINE); for (const x of [174, 180, 185]) L(x, 44, x, 51, HT);  // seams and cooling slots
  P('M200,41 L200,36 L206,36 L206,41', FINE);
  L(180, 41, 180, 31, MID); L(176, 31, 184, 31, FINE); P('M172,27 L176,29 M188,27 L184,29', FINE); C(180, 25, 4, FINE);      // anemometer mast with cups
  L(204, 36, 204, 28, FINE);                                                                                   // lightning rod
  for (const a of [-80, 40, 160]) {                                                                          // blades
    const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), T = (u, v) => `${f1(H[0] + u * c - v * s)},${f1(H[1] + u * s + v * c)}`, XY = (u, v) => [f1(H[0] + u * c - v * s), f1(H[1] + u * s + v * c)];
    P(`M${T(14, 3)} C${T(26, 11)} ${T(34, 10)} ${T(52, 7)} S${T(86, 2.4)} ${T(96, 0.6)} C${T(88, -0.6)} ${T(66, -2.2)} ${T(52, -3)} S${T(26, -3.4)} ${T(14, -3)} Z`, M);
    let [x1, y1] = XY(16, 0.4), [x2, y2] = XY(90, 0.2); L(x1, y1, x2, y2, FINE);                               // chord line
    for (const u of [38, 58, 76]) { [x1, y1] = XY(u, 5.5 - (u - 38) * 0.08); [x2, y2] = XY(u, -2.2); L(x1, y1, x2, y2, HT); }
    [x1, y1] = XY(16, 0); C(x1, y1, 4.2, FINE);                                                                // blade root ring
  }
  EL(H[0], H[1], 9, 11, { ...ACC }); EL(H[0], H[1], 4.2, 5.6, ACC);                                           // hub spinner (accent)
  // far turbine
  L(268, 96, 268, 188, FINE); L(272, 96, 272, 188, FINE); L(266, 188, 274, 188, FINE);
  for (const a of [-60, 60, 180]) { const r = a * Math.PI / 180; const x = 270 + 40 * Math.cos(r), y = 94 + 40 * Math.sin(r); L(270, 94, f1(x), f1(y), FINE); L(272, 94, f1(x + 2), f1(y + 2), FINE); }
  EL(270, 94, 3.4, 3.4, FINE);
  return { els: k.E, box: [30, -46, 270], base: 188, below: 17 };
}

// 2. solar array: three ground-mount racks receding up the page (front row biggest), each a tilted panel with frame, cell grid and busbars on short front legs and taller rear legs (rear legs seen at the right end), rail, footings, inverter cabinet with cable run, sun (accent)
function solar() {
  const k = kit(), { L, P, R, C, EL } = k;
  ground(k, 0, 420, 190, 2);
  const row = (x0, yg, w, th, sk, cols, rows) => {
    const yf = yg - th * 0.3;                                                                                  // front edge height above the ground: 0.3 of the rise
    const p = (i, j) => [f1(x0 + i * w + (1 - j) * sk), f1(yf - (1 - j) * th)];                                // i along the row, j 1 = front edge, 0 = rear edge
    const poly = (a) => 'M' + a.map((q) => q.join(',')).join(' L') + ' Z';
    P(poly([p(0, 0), p(1, 0), p(1, 1), p(0, 1)]), M);
    const o = Math.max(2, th * 0.1), q = (i, j, ox, oy) => { const [x, y] = p(i, j); return [f1(x + ox), f1(y + oy)]; };
    P(poly([q(0, 0, o, o), q(1, 0, -o, o), q(1, 1, -o, -o), q(0, 1, o, -o)]), FINE);                         // inner frame lip
    for (let c = 1; c < cols; c++) { const a = p(c / cols, 0), b = p(c / cols, 1); L(a[0], a[1] + o, b[0], b[1] - o, FINE); }
    for (let r = 1; r < rows; r++) { const a = p(0, r / rows), b = p(1, r / rows); L(a[0] + o, a[1], b[0] - o, b[1], FINE); }
    for (let c = 0; c < cols; c++) for (const t of [0.34, 0.66]) { const a = p((c + t) / cols, 0), b = p((c + t) / cols, 1); L(a[0], a[1] + o + 1, b[0], b[1] - o - 1, HT); }   // busbars
    for (const i of [0.04, 0.5, 0.96]) { const [x, y] = p(i, 1); L(x, y, x, yg, MID); L(x - 6, yg, x + 6, yg, FINE); }   // short front legs with footings
    const [rx, ry] = p(1, 0), [fx, fy] = p(1, 1);                                                             // end elevation: taller rear leg behind, brace to the front leg
    L(rx, ry, rx, yg - 5, MID); L(rx - 5, yg - 5, rx + 5, yg - 5, FINE); L(rx, ry + (yg - 5 - ry) * 0.55, fx, fy + (yg - fy) * 0.5, FINE);
    if (yg < 188) { P(`M${f1(x0 - 4)},${yg} L${f1(x0 + w + sk + 8)},${yg}`, FINE); for (let x = x0 + 6; x < x0 + w; x += 14) L(x, yg + 2, x - 4, yg + 6, HT); }   // ground line under a rear row
  };
  row(180, 128, 128, 20, 10, 6, 3);
  row(110, 154, 156, 25, 12, 8, 3);
  row(12, 188, 196, 32, 16, 10, 3);
  R(364, 136, 34, 50, MID); L(362, 136, 400, 136, FINE); L(381, 140, 381, 184, FINE); for (const y of [146, 152, 158]) L(368, y, 377, y, FINE); R(385, 160, 8, 12, FINE); R(368, 170, 8, 8, FINE);  // inverter cabinet
  P('M60,189 Q120,194 190,189 T300,190 T360,189', FINE); L(360, 180, 364, 189, FINE);                      // cable run into the cabinet
  C(330, 50, 12, { ...ACC, cls: 'main', col: 'acc' });                                                       // sun (accent)
  for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 + 0.2, c = Math.cos(a), s = Math.sin(a); L(f1(330 + c * 17), f1(50 + s * 17), f1(330 + c * (i % 2 ? 22 : 26)), f1(50 + s * (i % 2 ? 22 : 26)), ACC); }
  return { els: k.E, box: [0, 20, 420], base: 190, below: 17 };
}

// 3. hydro dam: gravity-dam section with lift joints, crest gantry and spillway piers, accent spillway sheet down the face, intake rack, penstock through the body to a turbine house, transformer and pylon
function dam() {
  const k = kit(), { L, P, R, C, EL } = k;
  const fx = (y) => 146 + (y - 40) * 102 / 150;                                                              // downstream face x at height y
  P('M0,134 Q50,176 100,190', M); ground(k, 100, 440, 190, 0);
  for (let x = 6; x < 96; x += 12) L(x, 160 + (x % 3) - (96 - x) * 0.2, x - 7, 172 - (96 - x) * 0.1, HT);
  P('M100,190 L100,40 L146,40 L248,190', M);
  L(100, 34, 146, 34, MID); L(100, 28, 146, 28, FINE); for (let x = 104; x <= 146; x += 8) L(x, 28, x, 34, FINE);   // parapet
  for (const x of [112, 124, 136]) { R(x - 2.5, 18, 5, 22, MID); }                                           // spillway piers
  L(102, 14, 146, 14, MID); L(112, 14, 112, 18, FINE); L(136, 14, 136, 18, FINE); L(118, 14, 118, 28, FINE); L(130, 14, 130, 28, FINE);  // gantry beam and hoist lines
  waves(k, 2, 98, 56, 2.5, 20); waves(k, 10, 90, 70, 2, 24);
  for (const y of [70, 100, 130, 160]) L(100, y, fx(y) - 0.5, y, FINE);                                      // construction lifts
  R(106, 94, 14, 8, FINE); L(108, 98, 118, 98, HT);                                                          // inspection gallery
  L(122, 40, fx(190) - 8, 190, HT);
  let d = 'M149,42'; for (let i = 1; i <= 10; i++) { const t = i / 10, y = 42 + t * 146, x = fx(y) + 2 + (i % 2 ? 2.5 : -0.5); d += ` L${f1(x)},${f1(y)}`; }
  P('M149,42 q4,10 -0,18 q5,12 1,24 q4,12 0,26 q5,14 1,30 q3,10 0,16', { ...ACC });                              // spillway sheet (accent)
  P('M156,42 q4,10 0,18 q5,12 1,24 q4,12 0,26 q5,14 1,30 q3,10 0,16', { ...ACC });
  waves(k, 244, 262, 187, 2, 12); waves(k, 262, 300, 189, 1.5, 12);
  P('M2,46 L94,46', FINE); P('M60,46 L66,38 L72,46 Z', FINE); L(66, 38, 66, 34, FINE); P('M2,48 q6,-2 12,0 t12,0 t12,0 t12,0 t12,0 t12,0', { cls: 'wave' });   // reservoir level line and gauge mark against the upstream face
  R(92, 136, 8, 26, MID); for (const y of [142, 148, 154]) L(92, y, 100, y, FINE); L(96, 136, 96, 162, FINE);       // trash rack at the intake
  dash(k, 100, 142, 236, 172, 9, 5, MID); dash(k, 100, 156, 242, 182, 9, 5, MID);                            // penstock inside the body
  for (const t of [0.25, 0.5, 0.75]) { const x = 100 + 136 * t; L(f1(x), f1(142 + 30 * t - 3), f1(x), f1(156 + 26 * t + 3), FINE); }
  L(236, 172, 262, 177.5, MID); L(242, 182, 262, 187, MID); R(255, 172, 7, 17, FINE);                        // exit and flange at the house wall
  R(262, 132, 80, 58, M); L(258, 132, 346, 132, MID); L(262, 140, 342, 140, FINE);
  P('M262,132 L270,122 L334,122 L342,132', MID); for (const y of [125, 128]) L(274, y, 330, y, FINE);        // roof and lantern
  for (const x of [272, 292, 312]) P(`M${x},164 L${x},150 A6,6 0 0 1 ${x + 12},150 L${x + 12},164 Z`, FINE);   // generator-hall windows
  R(328, 164, 10, 26, FINE);
  R(352, 160, 24, 30, MID); L(350, 160, 378, 160, FINE); for (const x of [358, 364, 370]) { L(x, 160, x, 150, FINE); }   // transformer with bushings
  for (const x of [358, 364, 370]) L(x - 2, 150, x + 2, 150, FINE);
  for (let x = 354; x < 376; x += 6) L(x, 166, x, 186, HT);                                                  // cooling fins
  const px = 408;                                                                                             // pylon
  L(px - 14, 190, px - 4, 66, MID); L(px + 14, 190, px + 4, 66, MID);
  for (const [y0, y1] of [[66, 100], [100, 140], [140, 190]]) { const w = (y) => 4 + (y - 66) * 10 / 124; L(px - w(y0), y0, px + w(y1), y1, FINE); L(px + w(y0), y0, px - w(y1), y1, FINE); L(px - w(y1), y1, px + w(y1), y1, FINE); }
  L(px - 22, 74, px + 22, 74, MID); L(px - 18, 90, px + 18, 90, MID);
  P(`M364,150 Q380,${126} ${px - 22},74`, FINE); P(`M370,150 Q388,${134} ${px - 18},90`, FINE);
  L(px - 22, 74, px - 22, 80, FINE); L(px + 22, 74, px + 22, 80, FINE); P(`M${px + 22},80 Q${px + 36},96 ${px + 38},112`, FINE);
  return { els: k.E, box: [0, 10, 440], base: 190, below: 17 };
}

// 4. biomass: end-on log stack (rings, cracks), wheat sheaf tied with an accent band, wood-chip pile textured with chips, inclined conveyor to a boiler house with stack and steam
function biomass() {
  const k = kit(), { L, P, R, C, EL } = k;
  ground(k, 0, 440, 190, 0);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // log stack: 5 + 4 + 3 end-on rounds
  const rows = [[5, 10], [4, 10], [3, 10]];
  rows.forEach(([n, r], ri) => { const y = 190 - r - ri * r * 1.8, x0 = 12 + r + ri * r;
    for (let i = 0; i < n; i++) { const x = x0 + i * 2 * r + (i % 2 ? 0.6 : 0), rr = r - (i % 3) * 0.6;
      C(f1(x), f1(y), f1(rr), M); C(f1(x), f1(y), f1(rr * 0.58), FINE);
      const a = rnd() * 6.28; L(f1(x + Math.cos(a) * rr * 0.58), f1(y + Math.sin(a) * rr * 0.58), f1(x + Math.cos(a) * rr * 0.96), f1(y + Math.sin(a) * rr * 0.96), FINE);
      L(f1(x - 2), f1(y + 1), f1(x + 2.5), f1(y - 1.5), HT); } });
  L(10, 190, 10, 160, FINE); L(124, 190, 118, 162, FINE);                                                    // stakes holding the stack
  // wheat sheaf
  const tx = 150, ty = 148;
  for (let i = 0; i < 9; i++) { const f = (i - 4) / 4, bx = tx + f * 15, ex = tx + f * 22, ey = 82 + Math.abs(f) * 14 + (i % 2) * 6;
    P(`M${f1(bx)},190 Q${f1(tx + f * 4)},${ty} ${f1(ex)},${f1(ey + 14)}`, i % 3 ? FINE : MID);
    P(`M${f1(ex)},${f1(ey + 14)} Q${f1(ex - 4)},${f1(ey + 5)} ${f1(ex)},${f1(ey - 6)} Q${f1(ex + 4)},${f1(ey + 5)} ${f1(ex)},${f1(ey + 14)}`, FINE);                     // ear
    L(f1(ex), f1(ey - 6), f1(ex + f * 5), f1(ey - 15), HT); }
  P(`M${tx - 11},${ty - 3} Q${tx},${ty + 3} ${tx + 12},${ty - 3}`, { cls: 'main', col: 'acc' }); P(`M${tx - 10},${ty + 6} Q${tx},${ty + 11} ${tx + 11},${ty + 5}`, ACC);   // tie band (accent)
  P(`M${tx - 18},190 L${tx + 20},190`, FINE);
  // chip pile: mound outline, strata, chips
  const prof = (x) => { const t = (x - 188) / 112; if (t < 0 || t > 1) return 190; const u = 2 * t - 1; return 190 - 104 * Math.pow(1 - u * u, 0.72); };
  P('M184,190 C196,174 206,128 226,100 C236,86 248,84 256,96 C276,126 290,170 304,190', M);
  for (let i = 0; i < 150; i++) { const x = 190 + rnd() * 112, y = 80 + rnd() * 108; if (y < prof(x) + 6 || y > 188) continue;
    const a = rnd() * Math.PI, c = Math.cos(a) * 4.2, s = Math.sin(a) * 2.2, w = 1.3;
    P(`M${f1(x - c)},${f1(y - s)} L${f1(x + c)},${f1(y + s - w)} L${f1(x + c + 1)},${f1(y + s + w)} L${f1(x - c + 1)},${f1(y - s + w)} Z`, i % 4 ? HT : FINE); }
  P('M208,150 Q232,140 262,150', FINE); P('M198,172 Q240,160 290,172', FINE);
  // conveyor to the boiler house
  L(262, 98, 336, 62, MID); L(266, 106, 340, 70, MID); L(272, 111, 272, 130, FINE);
  for (let t = 0.1; t < 1; t += 0.14) { const x = 262 + 74 * t, y = 98 + -36 * t; L(f1(x), f1(y + 3), f1(x + 2), f1(y + 10), HT); }
  for (const x of [292, 322]) { const y = 98 - 36 * ((x - 262) / 74) + 6; L(x, y + 4, x - 6, 190, FINE); L(x, y + 4, x + 6, 190, FINE); L(x - 4, 174, x + 4, 174, FINE); }
  R(336, 96, 76, 94, M); L(334, 96, 414, 96, MID); L(336, 112, 412, 112, FINE);                              // boiler house
  R(346, 124, 24, 18, MID); L(358, 124, 358, 142, FINE); R(378, 124, 26, 18, MID); R(354, 156, 20, 34, FINE); L(364, 156, 364, 190, HT);   // windows and door
  P('M342,66 L342,96 M334,62 L342,66', FINE); R(340, 58, 8, 8, FINE);                                        // feed chute
  L(390, 96, 390, 40, MID); L(402, 96, 402, 40, MID); L(388, 40, 404, 40, MID); L(388, 45, 404, 45, FINE);   // chimney
  for (const y of [56, 72, 86]) L(390, y, 402, y, FINE);
  P('M396,34 q-8,-8 0,-14 q10,-6 2,-14 M404,30 q8,-6 2,-12', { cls: 'wave' });                                // steam
  return { els: k.E, box: [0, -8, 420], base: 190, below: 17 };
}
module.exports = { turbine, solar, dam, biomass };
