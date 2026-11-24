// Turns a skin's SVG fragment into markup the page's hero gate takes (src/next_leaf.rs hero_faults): only
// g and path (plus the defs, linearGradient, stop and mask the scene itself writes), hex colours, numbers,
// path data of M/l/Z only. Every shape becomes a flattened, simplified polyline path; inherited style is
// resolved onto runs of paths; the skins' SVG filters are baked into the coordinates (seeded, deterministic):
//   wobble -> a small smooth displacement of the pen lines; wash -> a larger, lower-frequency displacement of
//   the colour edge plus a darker rim (the filter's eroded rim) and dry-brush streaks cut as holes.
// fill-opacity becomes opacity (a path that also strokes is split in two); fill-rule evenodd becomes nonzero
// by turning every subpath so its winding follows its nesting depth. Nothing here reads a file.

const HEX = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

export function hexOk(c) { return typeof c === 'string' && HEX.test(c); }

// ---------- a tiny parser for the skins' own output (tags and attributes only; skins write no text) ----------
export function parse(src) {
  const root = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    const node = { name: m[2], attrs, kids: [] };
    stack[stack.length - 1].kids.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

// ---------- seeded smooth noise (value noise, 2 octaves) ----------
function hash2(ix, iy, s) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v; // 0..1
}
export function fbm(x, y, s) { return (vnoise(x, y, s) * 0.67 + vnoise(x * 2.03, y * 2.03, s + 17) * 0.33) * 2 - 1; } // -1..1

// ---------- path data -> polylines ----------
function tokens(d) { return d.match(/[MmLlHhVvCcSsQqTtZzAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []; }
function cubicPts(p0, p1, p2, p3, out, step) {
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const n = Math.max(1, Math.min(24, Math.ceil(L / step)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
}
export function flatten(d, step = 1.5) {
  const t = tokens(d), subs = [];
  let i = 0, cmd = '', cur = [0, 0], start = [0, 0], sub = null, lastC = null, lastQ = null;
  const num = () => parseFloat(t[i++]);
  const begin = (p) => { sub = { pts: [p], closed: false }; subs.push(sub); };
  while (i < t.length) {
    if (/[a-zA-Z]/.test(t[i])) cmd = t[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const pt = () => { const x = num(), y = num(); return rel ? [cur[0] + x, cur[1] + y] : [x, y]; };
    if (C === 'Z') { if (sub) { sub.closed = true; cur = start; } sub = null; lastC = lastQ = null; continue; }
    if (C === 'M') { cur = pt(); start = cur; begin(cur); cmd = rel ? 'l' : 'L'; lastC = lastQ = null; continue; }
    if (!sub) begin(cur);
    if (C === 'L') { cur = pt(); sub.pts.push(cur); lastC = lastQ = null; }
    else if (C === 'H') { const x = num(); cur = [rel ? cur[0] + x : x, cur[1]]; sub.pts.push(cur); lastC = lastQ = null; }
    else if (C === 'V') { const y = num(); cur = [cur[0], rel ? cur[1] + y : y]; sub.pts.push(cur); lastC = lastQ = null; }
    else if (C === 'C') { const a = pt(), b = pt(), e = pt(); cubicPts(cur, a, b, e, sub.pts, step); lastC = b; cur = e; lastQ = null; }
    else if (C === 'S') { const a = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur; const b = pt(), e = pt(); cubicPts(cur, a, b, e, sub.pts, step); lastC = b; cur = e; lastQ = null; }
    else if (C === 'Q' || C === 'T') {
      const q = C === 'Q' ? pt() : (lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur); const e = pt();
      cubicPts(cur, [cur[0] + 2 / 3 * (q[0] - cur[0]), cur[1] + 2 / 3 * (q[1] - cur[1])], [e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1])], e, sub.pts, step);
      lastQ = q; cur = e; lastC = null;
    } else if (C === 'A') { // not written by the skins; a chord keeps the shape closed rather than failing
      num(); num(); num(); num(); num(); cur = pt(); sub.pts.push(cur); lastC = lastQ = null;
    } else { i++; }
  }
  return subs.filter((s) => s.pts.length >= 2);
}
function ellipsePts(cx, cy, rx, ry) {
  const n = Math.max(12, Math.min(40, Math.ceil((rx + ry) * 1.2))), pts = [];
  for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return [{ pts, closed: true }];
}
function shapeSubs(n) {
  const a = n.attrs, f = (k, v = 0) => (a[k] == null ? v : parseFloat(a[k]));
  switch (n.name) {
    case 'path': return flatten(a.d || '');
    case 'circle': return ellipsePts(f('cx'), f('cy'), f('r'), f('r'));
    case 'ellipse': return ellipsePts(f('cx'), f('cy'), f('rx'), f('ry'));
    case 'rect': { const x = f('x'), y = f('y'), w = f('width'), h = f('height'); return w > 0 && h > 0 ? [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }] : []; }
    case 'line': return [{ pts: [[f('x1'), f('y1')], [f('x2'), f('y2')]], closed: false }];
    case 'polyline': case 'polygon': {
      const v = (a.points || '').trim().split(/[\s,]+/).map(parseFloat); const pts = [];
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
      return pts.length >= 2 ? [{ pts, closed: n.name === 'polygon' }] : [];
    }
    default: return [];
  }
}
const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);

// translate / scale / matrix transforms written by a skin are applied to the points (none are emitted)
function applyTransform(subs, tr) {
  if (!tr) return subs;
  let M = [1, 0, 0, 1, 0, 0];
  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  for (const m of tr.matchAll(/(translate|scale|rotate|matrix)\(([^)]*)\)/g)) {
    const v = m[2].trim().split(/[\s,]+/).map(parseFloat);
    if (m[1] === 'translate') M = mul(M, [1, 0, 0, 1, v[0] || 0, v[1] || 0]);
    else if (m[1] === 'scale') M = mul(M, [v[0], 0, 0, v[1] ?? v[0], 0, 0]);
    else if (m[1] === 'matrix') M = mul(M, v);
    else { const r = (v[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), cx = v[1] || 0, cy = v[2] || 0; M = mul(M, [1, 0, 0, 1, cx, cy]); M = mul(M, [c, s, -s, c, 0, 0]); M = mul(M, [1, 0, 0, 1, -cx, -cy]); }
  }
  return subs.map((s) => ({ closed: s.closed, pts: s.pts.map(([x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]) }));
}

// ---------- geometry helpers ----------
function resample(pts, closed, step) {
  const P = closed ? [...pts, pts[0]] : pts, out = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  if (closed) out.pop();
  return out;
}
function rdp(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); const A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// a closed ring is split at the point farthest from its start, so both halves have distinct ends
function simplify(u, tol) {
  if (!u.closed) return { closed: false, pts: rdp(u.pts, tol) };
  const P = u.pts; if (P.length < 4) return u;
  let far = 1, fd = -1; for (let i = 1; i < P.length; i++) { const d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = rdp(P.slice(0, far + 1), tol), b = rdp([...P.slice(far), P[0]], tol);
  return { closed: true, pts: [...a, ...b.slice(1, -1)] };
}
function area(pts) { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
// evenodd -> nonzero: a subpath nested at an even depth winds one way, at an odd depth the other
function evenOddToNonzero(subs) {
  const closed = subs.filter((s) => s.closed && s.pts.length >= 3);
  for (const s of closed) {
    const depth = closed.filter((o) => o !== s && inside(s.pts[0], o.pts)).length;
    const want = depth % 2 === 0 ? 1 : -1;
    if (Math.sign(area(s.pts)) !== want) s.pts.reverse();
  }
  return subs;
}

// the wash filter's dry-brush streaks, baked as holes: a few thin horizontal slivers wound against the wash's
// largest ring, each kept only when its corners all lie inside that ring (so a hole never fills outside it).
// Holes instead of a mask: hundreds of mask uses made Chrome drop raster tiles on a 27-person page.
function dryStreaks(fs, seed) {
  let ring = null, ra = 0; for (const u of fs) { const a = Math.abs(area(u.pts)); if (a > ra) { ra = a; ring = u; } }
  if (!ring || ra < 60) return fs;
  const xs = ring.pts.map((p) => p[0]), ys = ring.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), w = x1 - x0, sign = Math.sign(area(ring.pts));
  let a = seed || 1; const r = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const out = fs.slice(), want = Math.min(4, Math.max(1, Math.round(ra / 900)));
  for (let t = 0, got = 0; t < want * 4 && got < want; t++) {
    const len = w * (0.25 + r() * 0.35), h = 0.7 + r() * 0.9, x = x0 + r() * (w - len), y = y0 + (y1 - y0) * (0.1 + r() * 0.8);
    const q = [[x, y], [x + len, y + (r() - 0.5)], [x + len - 1.5, y + h], [x + 1, y + h * 0.9]];
    if (!q.every((p) => inside(p, ring.pts)) || !inside([x + len / 2, y + h / 2], ring.pts)) continue;
    if (Math.sign(area(q)) === sign) q.reverse();
    out.push({ closed: true, pts: q }); got++;
  }
  return out;
}

// ---------- path data writer: absolute start, then relative l in tenths of a pixel ----------
function fmt10(t) { // t: integer tenths
  const neg = t < 0, a = Math.abs(t), i = Math.floor(a / 10), f = a % 10;
  const s = f ? (i ? `${i}.${f}` : `.${f}`) : `${i}`;
  return neg ? `-${s}` : s;
}
function join(nums) { let s = ''; for (const n of nums) { if (s && n[0] !== '-' && !(n[0] === '.' && /\.\d*$/.test(s))) s += ' '; s += n; } return s; }
export function writeD(subs) {
  let d = '';
  for (const s of subs) {
    const P = s.pts.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]);
    const Q = [P[0]]; for (let i = 1; i < P.length; i++) if (P[i][0] !== Q[Q.length - 1][0] || P[i][1] !== Q[Q.length - 1][1]) Q.push(P[i]);
    if (Q.length < 2 && !s.closed) continue;
    const nums = [];
    for (let i = 1; i < Q.length; i++) nums.push(fmt10(Q[i][0] - Q[i - 1][0]), fmt10(Q[i][1] - Q[i - 1][1]));
    d += `M${join([fmt10(Q[0][0]), fmt10(Q[0][1])])}${nums.length ? 'l' + join(nums) : ''}${s.closed ? 'Z' : ''}`;
  }
  return d;
}

// ---------- colour ----------
export function rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
export function toHex([r, g, b]) { return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
export function mix(a, b, t) { const A = rgb(a), B = rgb(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); }
function colour(v, palette) {
  if (v == null) return null;
  v = String(v).trim();
  if (v === 'none' || v === 'transparent') return 'none';
  if (HEX.test(v)) return v.toLowerCase();
  if (HEX3.test(v)) return ('#' + v.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  const m = v.match(/^rgba?\(([^)]*)\)$/);
  if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return toHex(p); }
  if (v === 'currentColor') return palette.ink;
  return palette.ink; // a named colour or var(): the pen's colour, never passed through
}
function rgbaAlpha(v) { const m = String(v || '').match(/^rgba\(([^)]*)\)$/); if (!m) return 1; const a = parseFloat(m[1].split(',')[3]); return Number.isFinite(a) ? a : 1; }

// ---------- the walk ----------
// ctx: {px, seed, palette, washMask: id|null}. Returns a list of draw items {d, fill, stroke, sw, op, wash}.
export function normalizeFragment(src, ctx) {
  const items = [];
  const S0 = { fill: '#000000', stroke: 'none', sw: 1, op: 1, fop: 1, sop: 1, rule: 'nonzero', filter: null, tr: '' };
  const walk = (n, st) => {
    const a = n.attrs, s = { ...st };
    if (a.fill != null) { s.fill = colour(a.fill, ctx.palette); s.fop = rgbaAlpha(a.fill); }
    if (a.stroke != null) { s.stroke = colour(a.stroke, ctx.palette); s.sop = rgbaAlpha(a.stroke); }
    if (a['stroke-width'] != null) s.sw = parseFloat(a['stroke-width']);
    if (a['fill-opacity'] != null) s.fop *= parseFloat(a['fill-opacity']);
    if (a['stroke-opacity'] != null) s.sop *= parseFloat(a['stroke-opacity']);
    if (a.opacity != null) s.op *= parseFloat(a.opacity);
    if (a['fill-rule'] != null) s.rule = a['fill-rule'];
    if (a.filter != null) s.filter = /wash/.test(a.filter) ? 'wash' : /wobble/.test(a.filter) ? 'wobble' : s.filter;
    if (a.transform) s.tr = s.tr + ' ' + a.transform; // parent first: SVG applies the rightmost (innermost) first
    if (a.display === 'none' || a.visibility === 'hidden') return;
    if (SHAPES.has(n.name)) { emit(n, s); return; }
    if (n.name === 'g' || n.name === 'svg' || n.name === '#root') for (const k of n.kids) walk(k, s);
    // defs, filter, clipPath, title, text...: not drawn
  };
  let serial = 0;
  const emit = (n, s) => {
    let subs = applyTransform(shapeSubs(n), s.tr.trim());
    if (!subs.length) return;
    const k = serial++;
    const px = ctx.px;
    // small people (a long queue) carry less detail than a pixel shows: a looser simplification keeps 60 under ~550 KB
    const lineTol = px < 26 ? 0.45 : 0.34;
    if (s.filter === 'wash') {
      // the wash filter's edge: displacement ~0.1 head (<= 4.5 px), period ~33 px; dense points so the edge frays
      const amp = Math.min(4.5, px * 0.1), f = 1 / Math.max(10, Math.min(33, px * 0.8)), sd = (ctx.seed ^ (k * 2654435761)) >>> 0;
      subs = subs.map((u) => ({ closed: u.closed, pts: resample(u.pts, u.closed, Math.max(1.6, amp * 0.8)).map(([x, y]) => [x + amp * fbm(x * f, y * f, sd & 0xffff), y + amp * fbm(x * f + 31.7, y * f - 12.3, (sd >>> 16) + 7)]) }));
      subs = subs.map((u) => simplify(u, 0.45));
    } else if (s.filter === 'wobble') {
      const amp = Math.min(0.9, px * 0.022), f = 1 / 25, sd = (ctx.seed * 31 + 7) >>> 0;
      subs = subs.map((u) => ({ closed: u.closed, pts: resample(u.pts, u.closed, 3).map(([x, y]) => [x + amp * fbm(x * f, y * f, sd & 0xffff), y + amp * fbm(x * f - 9.1, y * f + 4.4, (sd >>> 8) + 3)]) }));
      subs = subs.map((u) => simplify(u, lineTol));
    } else {
      subs = subs.map((u) => simplify(u, lineTol));
    }
    subs = subs.filter((u) => u.pts.length >= 2);
    if (!subs.length) return;
    const fill = s.fill || 'none', stroke = s.stroke || 'none';
    const hasFill = fill !== 'none', hasStroke = stroke !== 'none' && s.sw > 0;
    if (hasFill) {
      let fs = subs.filter((u) => u.closed || u.pts.length >= 3).map((u) => ({ ...u, closed: true }));
      if (s.rule === 'evenodd' && fs.length > 1) fs = evenOddToNonzero(fs);
      if (s.filter === 'wash') fs = dryStreaks(fs, (ctx.seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0);
      const op = s.op * s.fop;
      if (fs.length && op > 0.004) {
        const item = { d: writeD(fs), fill, stroke: 'none', sw: 0, op, wash: s.filter === 'wash' };
        if (item.wash) { item.stroke = mix(fill, ctx.palette.ink, 0.25); item.sw = Math.max(0.5, Math.min(1, px * 0.03)); }
        items.push(item);
      }
    }
    if (hasStroke) {
      const op = s.op * s.sop;
      if (op > 0.004) items.push({ d: writeD(subs), fill: 'none', stroke, sw: s.sw, op, wash: s.filter === 'wash' });
    }
  };
  walk(parse(src), S0);
  return items;
}

// ---------- writer: runs of equal style share one <g>; strokes of one style share one path ----------
const num = (v, p = 2) => { const s = (+v).toFixed(p).replace(/\.?0+$/, ''); return s === '-0' || s === '' ? '0' : s; };
export function writeItems(items, washMask) {
  let out = '', i = 0;
  while (i < items.length) {
    const a = items[i];
    const key = (x) => `${x.fill}|${x.stroke}|${num(x.sw)}|${num(x.op)}|${x.wash ? 1 : 0}`;
    let j = i; const ds = [];
    while (j < items.length && key(items[j]) === key(a)) { ds.push(items[j].d); j++; }
    const attrs = [`fill="${a.fill}"`];
    if (a.stroke !== 'none') attrs.push(`stroke="${a.stroke}"`, `stroke-width="${num(a.sw)}"`, 'stroke-linejoin="round"');
    else attrs.push('stroke="none"');
    // opacity on each path (not the group) so overlapping washes still darken where they cross
    const op = a.op < 0.999 ? ` opacity="${num(a.op)}"` : '';
    const paths = a.fill === 'none' ? `<path d="${ds.join('')}"${op}/>` : ds.map((d) => `<path d="${d}"${op}/>`).join('');
    const body = `<g ${attrs.join(' ')}>${paths}</g>`;
    out += a.wash && washMask ? `<g mask="url(#${washMask})">${body}</g>` : body;
    i = j;
  }
  return out;
}
