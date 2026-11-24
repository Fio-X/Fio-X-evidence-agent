// Scene illustration node (runtime/illus_hero/scene/scene.mjs): one JSON line in, one out, for two data shapes
// x three styles. Checks the reply's lit/total against the request's flags, the svg against a JS port of the page
// gate (src/next_leaf.rs `hero_faults`), determinism, size, refusals, and that the node and its people-library
// copy read no file. Plain node, no dependencies:  node scripts/test_illus_scene.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENE_DIR = join(repo, 'runtime/illus_hero/scene');
const SCENE = join(SCENE_DIR, 'scene.mjs');
const fails = [];
const fail = (m) => fails.push(m);

// ---------- JS port of hero_faults (src/next_leaf.rs, `pub fn hero_faults`, ~line 1995; HERO_MAX_BYTES line 1907) ----------
// Mirrors the Rust rule for rule: allowed elements and their attributes, value kinds, white space only between
// tags, balanced tags, url(#id) only of defined ids, the byte cap. Kept here so the test runs without cargo.
const HERO_MAX_BYTES = 4 * 1024 * 1024;
export function heroFaults(svg) {
  // Rust `s.parse::<f64>()` then is_finite: optional sign, digits with an optional point (or a leading point), optional exponent
  const num = (s) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) && Number.isFinite(parseFloat(s));
  const hex = (s) => s.length === 7 && s[0] === '#' && /^[0-9a-fA-F]{6}$/.test(s.slice(1));
  const id = (s) => s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
  const transform = (v) => {
    let rest = v, ok = false;
    if (rest.startsWith('translate(')) {
      const r = rest.slice('translate('.length), k = r.indexOf(')');
      if (k < 0) return false;
      const at = r.slice(0, k).split(',');
      if (at.length !== 2 || !at.every(num)) return false;
      rest = r.slice(k + 1).trimStart(); ok = true;
    }
    if (rest.startsWith('scale(')) {
      const r = rest.slice('scale('.length), k = r.indexOf(')');
      if (k < 0) return false;
      return num(r.slice(0, k)) && r.slice(k + 1) === '';
    }
    return ok && rest === '';
  };
  const ALLOWED = {
    'g/0': ['fill', 'stroke', 'stroke-width', 'stroke-linejoin', 'opacity', 'transform', 'mask'],
    'path/1': ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linejoin', 'opacity', 'transform', 'mask'],
    'image/1': ['href', 'width', 'height', 'preserveAspectRatio'],
    'defs/0': [],
    'linearGradient/0': ['id', 'x1', 'y1', 'x2', 'y2'],
    'stop/1': ['offset', 'stop-color', 'stop-opacity'],
    'mask/0': ['id', 'maskUnits', 'x', 'y', 'width', 'height'],
  };
  const off = [];
  if (Buffer.byteLength(svg) > HERO_MAX_BYTES) off.push(`hero: ${Buffer.byteLength(svg)} bytes, over the ${HERO_MAX_BYTES} a hero may be`);
  const stack = [], defined = [], used = [];
  let rest = svg;
  while (rest.length && !off.length) {
    let lt = rest.indexOf('<'); if (lt < 0) lt = rest.length;
    if (rest.slice(0, lt).trim() !== '') { off.push(`hero: text ${JSON.stringify(rest.slice(0, Math.min(lt, 40)))} between the tags`); break; }
    rest = rest.slice(lt);
    if (!rest.length) break;
    const gt = rest.indexOf('>');
    if (gt < 0) { off.push('hero: a tag is not closed'); break; }
    const tag = rest.slice(1, gt);
    rest = rest.slice(gt + 1);
    if (tag.startsWith('/')) { const name = tag.slice(1); if (stack.pop() !== name) { off.push(`hero: a </${name}> closes nothing open`); break; } continue; }
    const closed = tag.endsWith('/'), body = closed ? tag.slice(0, -1) : tag;
    const name = body.split(' ')[0];
    const allowed = ALLOWED[`${name}/${closed ? 1 : 0}`];
    if (!allowed) { off.push(`hero: <${name}${closed ? '/' : ''}> is no element a hero draws`); break; }
    let a = body.slice(name.length).trim();
    while (a.length) {
      const eq = a.indexOf('="');
      if (eq < 0) { off.push(`hero: <${name}> has an attribute that is not key="value": ${JSON.stringify(a.slice(0, 40))}`); break; }
      const key = a.slice(0, eq), after0 = a.slice(eq + 2), q = after0.indexOf('"');
      if (q < 0) { off.push(`hero: <${name}> ${key} is not closed`); break; }
      const value = after0.slice(0, q), after = after0.slice(q + 1);
      const paint = (v) => {
        if (v === 'none' || hex(v)) return true;
        const m = v.startsWith('url(#') && v.endsWith(')') ? v.slice(5, -1) : null;
        if (m !== null && id(m)) { used.push(m); return true; }
        return false;
      };
      let ok = allowed.includes(key);
      if (ok) {
        switch (key) {
          case 'd': ok = [...value].every((c) => /[0-9]/.test(c) || ' ,.-eEMCLQTZHVmclqtzhv'.includes(c)); break;
          case 'fill': case 'stroke': case 'stop-color': ok = paint(value); break;
          case 'mask': ok = value.startsWith('url(#') && paint(value); break;
          case 'stroke-width': case 'x1': case 'y1': case 'x2': case 'y2': case 'x': case 'y': case 'width': case 'height':
          case 'offset': case 'opacity': case 'stop-opacity': ok = num(value); break;
          case 'stroke-linejoin': ok = value === 'round'; break;
          case 'transform': ok = transform(value); break;
          case 'id': defined.push(value); ok = id(value); break;
          case 'maskUnits': ok = value === 'userSpaceOnUse'; break;
          case 'preserveAspectRatio': ok = value === 'none'; break;
          case 'href': { const b = value.startsWith('data:image/png;base64,') ? value.slice(22) : value.startsWith('data:image/jpeg;base64,') ? value.slice(23) : null; ok = b !== null && b.length > 0 && /^[A-Za-z0-9+/=]+$/.test(b); break; }
          default: ok = false;
        }
      }
      if (!ok) { off.push(`hero: <${name} ${key}=${JSON.stringify(value.slice(0, 40))}> is not drawn by a hero`); break; }
      a = after.trimStart();
    }
    if (!closed) stack.push(name);
  }
  if (!off.length && stack.length) off.push(`hero: ${stack.length} element(s) not closed`);
  if (!off.length) { const i = used.find((u) => !defined.includes(u)); if (i) off.push(`hero: url(#${i}) names an id the picture does not define`); }
  return off;
}

// the port itself refuses what the Rust tests refuse (a few of next_leaf.rs's own hero cases)
for (const [svg, bad] of [
  ['<g fill="#112233"><path d="M0 0l1 1Z"/></g>', false],
  ['<circle r="3"/>', true], ['<text>8</text>', true], ['<g><path d="M0 0" fill="red"/></g>', true],
  ['<path d="M0 0A1 1 0 0 1 2 2"/>', true], ['<path d="M0 0" fill="url(#nope)"/>', true],
  ['<g transform="rotate(3)"></g>', true], ['<g transform="translate(1,2) scale(2)"></g>', false],
  ['<g>x</g>', true], ['<path d="M0 0" fill-opacity="0.5"/>', true], ['<g class="a"></g>', true],
]) if ((heroFaults(svg).length > 0) !== bad) fail(`gate port: ${svg} should ${bad ? 'fail' : 'pass'}: ${heroFaults(svg)}`);

// ---------- the node ----------
function ask(req, raw = null) {
  const out = execFileSync(process.execPath, [SCENE], { input: (raw ?? JSON.stringify(req)) + '\n', timeout: 30000 }).toString();
  const lines = out.split('\n').filter((l) => l.length);
  if (lines.length !== 1 || !out.endsWith('\n')) fail(`scene wrote ${lines.length} lines, not one`);
  return { reply: JSON.parse(lines[0]), bytes: out.length };
}
const PAL = {
  ink: { ink: '#1b1b1b', paper: '#fbf8f1', accent: '#c8102e' },
  iso: { ink: '#2b2b2b', paper: '#f3eee4', accent: '#d2412f' },
  geo: { ink: '#1a2124', paper: '#efe6d2', accent: '#d8452b' },
};
const base = (style, figures, box = { w: 1200, h: 560 }) => ({ scene: 'queue', style, seed: 11, figures, box, palette: PAL[style] });

// (a) rule shape: a made-up EU-27-like list; lit = members below the list mean (11 of 27)
const VALS = [7.4, 3.3, 9.9, 2.6, 6.8, 4.4, 11.6, 6.7, 3.9, 8.2, 2.1, 7.1, 5.0, 12.1, 6.6, 4.7, 8.8, 3.5, 10.3, 6.9, 2.9, 7.7, 5.2, 9.1, 4.0, 7.3, 8.0];
const MEAN = VALS.reduce((a, b) => a + b, 0) / VALS.length;
const RULE = VALS.map((v) => ({ lit: v < MEAN }));
// (b) proportion shape: 28.4% of 8 rounds to 2 lit
const K8 = Math.round(8 * 0.284);
const PROP = Array.from({ length: 8 }, (_, i) => ({ lit: i >= 8 - K8 }));
if (RULE.filter((f) => f.lit).length !== 11 || K8 !== 2) fail('fixture: the rule shape should light 11 of 27 and the proportion shape 2 of 8');

const sizes = [];
for (const [shape, figs] of [['rule27', RULE], ['prop8of2', PROP]]) {
  for (const style of ['ink', 'iso', 'geo']) {
    const tag = `${shape}/${style}`;
    const req = base(style, figs, shape === 'rule27' ? { w: 1200, h: 560 } : { w: 1200, h: 460 });
    const { reply } = ask(req);
    if (reply.refused) { fail(`${tag}: refused: ${reply.refused}`); continue; }
    const want = figs.filter((f) => f.lit).length;
    if (reply.lit !== want || reply.total !== figs.length) fail(`${tag}: lit/total ${reply.lit}/${reply.total}, asked ${want}/${figs.length}`);
    if (reply.w !== req.box.w || !(reply.h > 0 && reply.h <= req.box.h)) fail(`${tag}: drawn ${reply.w}x${reply.h} in a ${req.box.w}x${req.box.h} box`);
    if (!Array.isArray(reply.dropped) || reply.dropped.length) fail(`${tag}: dropped ${JSON.stringify(reply.dropped)}`);
    const off = heroFaults(reply.svg);
    if (off.length) fail(`${tag}: gate: ${off[0]}`);
    if (/<text/i.test(reply.svg)) fail(`${tag}: holds <text`);
    if (/>[^<]*\d[^<]*</.test(reply.svg)) fail(`${tag}: a digit between tags`);
    if (/<svg/i.test(reply.svg)) fail(`${tag}: the reply holds an outer <svg> (the page wraps it)`);
    if (Buffer.byteLength(reply.svg) >= HERO_MAX_BYTES) fail(`${tag}: ${reply.svg.length} bytes`);
    const again = ask(req).reply;
    if (again.svg !== reply.svg) fail(`${tag}: not deterministic (two runs differ)`);
    const other = ask({ ...req, seed: 12 }).reply;
    if (other.svg === reply.svg) fail(`${tag}: the seed changes nothing`);
  }
}

// byte size per style at 8, 27 and 60 figures (a quarter lit)
for (const style of ['ink', 'iso', 'geo']) {
  const row = [style];
  for (const n of [8, 27, 60]) {
    const figs = Array.from({ length: n }, (_, i) => ({ lit: i % 4 === 1 }));
    const { reply } = ask(base(style, figs, { w: 1200, h: 560 }));
    if (reply.refused) { fail(`size ${style}/${n}: refused: ${reply.refused}`); continue; }
    const b = Buffer.byteLength(reply.svg);
    row.push(`${n}:${(b / 1024).toFixed(0)}KB`);
    if (heroFaults(reply.svg).length) fail(`size ${style}/${n}: gate: ${heroFaults(reply.svg)[0]}`);
    if (reply.lit !== figs.filter((f) => f.lit).length || reply.total !== n) fail(`size ${style}/${n}: lit/total ${reply.lit}/${reply.total}`);
    if (n === 60 && b > 600 * 1024) fail(`size ${style}/60: ${b} bytes, over the 600 KB target`);
  }
  sizes.push(row.join(' '));
}
console.log('sizes (svg bytes, box 1200x560): ' + sizes.join(' | '));

// ---------- placement: the lit tail in fives, and no head or torso hidden ----------
// draw() is imported for its test-only geometry (head disc, torso core, the fills of each figure in draw order).
// Occlusion: for every figure, its head disc (head joint, radius thick.headR) and torso core (convex hull of
// shL, shR, hipR, hipL, neck) are sampled on a 1 px grid; a sample is hidden when it lies inside (nonzero
// winding) any fill path of a figure drawn after it. Strokes are left out (pen lines are 1-3 px; the ink skin's
// paper occluders, which do cover, are fills). hidden / samples must be <= 10% for every figure.
const { draw } = await import(SCENE);
const { flatten } = await import(join(SCENE_DIR, 'normalize.mjs'));
function hull(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function winding(x, y, subs) {
  let w = 0;
  for (const s of subs) { const P = s.pts; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[j], b = P[i];
    if (a[1] <= y) { if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) w++; } else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) w--; } }
  return w;
}
const inHull = (x, y, H) => { for (let i = 0; i < H.length; i++) { const a = H[i], b = H[(i + 1) % H.length]; if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false; } return true; };
function occlusion(G) {
  const figs = G.figures.map((g) => {
    const paths = g.fills.map((d) => { const subs = flatten(d).filter((u) => u.pts.length >= 3); const xs = subs.flatMap((u) => u.pts.map((p) => p[0])), ys = subs.flatMap((u) => u.pts.map((p) => p[1])); return { subs, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }; }).filter((p) => p.subs.length);
    return { ...g, core: hull(g.torso), paths };
  });
  let worst = { f: 0, q: -1 };
  figs.forEach((g, i) => {
    const [hx, hy, hr] = g.head, pts = [...g.core, [hx - hr, hy - hr], [hx + hr, hy + hr]];
    const x0 = Math.floor(Math.min(...pts.map((p) => p[0]))), x1 = Math.ceil(Math.max(...pts.map((p) => p[0]))), y0 = Math.floor(Math.min(...pts.map((p) => p[1]))), y1 = Math.ceil(Math.max(...pts.map((p) => p[1])));
    const later = figs.slice(i + 1).flatMap((o) => o.paths).filter((p) => p.bb[0] <= x1 && p.bb[2] >= x0 && p.bb[1] <= y1 && p.bb[3] >= y0);
    let n = 0, hid = 0;
    for (let y = y0 + 0.5; y < y1; y++) for (let x = x0 + 0.5; x < x1; x++) {
      if (!((x - hx) ** 2 + (y - hy) ** 2 <= hr * hr || inHull(x, y, g.core))) continue;
      n++;
      if (later.some((p) => x >= p.bb[0] && x <= p.bb[2] && y >= p.bb[1] && y <= p.bb[3] && winding(x, y, p.subs) !== 0)) hid++;
    }
    const f = n ? hid / n : 0;
    if (f > worst.f) worst = { f, q: g.q };
  });
  return worst;
}
const occ = [];
for (const style of ['ink', 'iso', 'geo']) {
  for (const [n, flags] of [[8, PROP], [27, RULE], [60, Array.from({ length: 60 }, (_, i) => ({ lit: i % 4 === 1 }))]]) {
    const req = base(style, flags, { w: 1200, h: 560 });
    const rep = draw(req, { geometry: true });
    if (rep.refused) { fail(`placement ${style}/${n}: refused: ${rep.refused}`); continue; }
    const G = rep.geometry, K = flags.filter((f) => f.lit).length;
    // the lit figures stand in the last K queue places
    const litQ = G.figures.filter((g) => g.lit).map((g) => g.q).sort((a, b) => a - b);
    if (litQ.length !== K || litQ.some((q, k) => q !== n - K + k)) fail(`placement ${style}/${n}: lit places ${litQ.join(',')}, not the last ${K}`);
    // lit groups: consecutive slots of one row; at most 5; when K > 5 an empty slot (or a row change) between groups
    const lits = G.figures.filter((g) => g.lit).sort((a, b) => a.q - b.q), groups = [];
    for (const g of lits) { const last = groups.length ? groups[groups.length - 1] : null, p = last ? last[last.length - 1] : null; if (p && p.row === g.row && g.col - p.col === 1) last.push(g); else groups.push([g]); }
    if (groups.some((g) => g.length > 5)) fail(`placement ${style}/${n}: a lit group of ${Math.max(...groups.map((g) => g.length))}`);
    if (K > 5) {
      if (groups.length !== Math.ceil(K / 5)) fail(`placement ${style}/${n}: ${groups.length} lit groups for ${K} lit (want ${Math.ceil(K / 5)})`);
      for (let k = 1; k < groups.length; k++) { const a = groups[k - 1][groups[k - 1].length - 1], b = groups[k][0]; if (a.row === b.row && b.col - a.col < 2) fail(`placement ${style}/${n}: no gap between lit groups ${k} and ${k + 1}`); }
    }
    const w = occlusion(G);
    occ.push(`${style}/${n}:${(w.f * 100).toFixed(1)}%`);
    if (w.f > 0.10) fail(`occlusion ${style}/${n}: figure q=${w.q} has ${(w.f * 100).toFixed(1)}% of its head and torso hidden (max 10%)`);
  }
}
console.log('worst head+torso hidden: ' + occ.join(' '));

// refusals
const one = [{ lit: true }];
for (const [why, req, raw] of [
  ['bad style', { ...base('ink', one), style: 'oil' }],
  ['unknown scene', { ...base('ink', one), scene: 'parade' }],
  ['0 figures', base('ink', [])],
  ['61 figures', base('ink', Array.from({ length: 61 }, () => ({ lit: false })))],
  ['bad hex', { ...base('ink', one), palette: { ...PAL.ink, accent: 'red' } }],
  ['short hex', { ...base('ink', one), palette: { ...PAL.ink, ink: '#123' } }],
  ['var colour', { ...base('ink', one), palette: { ...PAL.ink, paper: 'var(--paper)' } }],
  ['missing accent', { ...base('ink', one), palette: { ink: '#111111', paper: '#ffffff' } }],
  ['lit not bool', base('ink', [{ lit: 1 }])],
  ['box too small', base('ink', one, { w: 100, h: 60 })],
  ['box too small for 60', base('ink', Array.from({ length: 60 }, () => ({ lit: false })), { w: 300, h: 120 })],
  ['seed not int', { ...base('ink', one), seed: 1.5 }],
  ['unknown key', { ...base('ink', one), n: 8 }],
  ['not json', null, '{not json'],
]) {
  const { reply } = ask(req, raw);
  if (typeof reply.refused !== 'string' || reply.svg !== undefined) fail(`refusal ${why}: got ${JSON.stringify(reply).slice(0, 120)}`);
}

// the node and its library copy read nothing: no fs, fetch, import.meta, dynamic import, top-level await, process start or env
function* files(d) { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = join(d, e.name); if (e.isDirectory()) yield* files(p); else yield p; } }
for (const p of files(SCENE_DIR)) {
  if (!p.endsWith('.mjs')) { fail(`${p}: not a code file (the node folder holds only .mjs)`); continue; }
  const t = readFileSync(p, 'utf8');
  const code = t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const [re, why] of [[/\bnode:fs\b|['"]fs['"]|\brequire\(/, 'fs'], [/\bfetch\(/, 'fetch'], [/import\.meta/, 'import.meta'], [/\bimport\(/, 'dynamic import'],
    [/child_process|(?<![.\w])(?:spawn|exec|execFile|fork)\(/, 'process start'], [/process\.env/, 'env'], [/^(?!\s*(?:\/\/|\*)).*\bawait\b/m, 'await']]) if (re.test(code)) fail(`${p}: ${why}`);
  for (const m of code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) if (!m[1].startsWith('./') && !m[1].startsWith('../')) fail(`${p}: imports ${m[1]} (only sibling code files)`);
}

if (fails.length) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }
console.log('ok: test_illus_scene');
