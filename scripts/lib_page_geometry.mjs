// Independent page geometry for the desktop layout tests.
//
// Everything here is measured from the SVG text a composer produced: elements are parsed with the
// render-QA tokenizer and affine maths, and text widths come from render_qa_geometry's advance
// tables. It never imports runtime/pi/infographic.mjs and uses none of its layout helpers (no
// _rhythmDebug, no ink model), so a test built on it does not use the layout code as its own oracle.
//
// "Ink" is what is painted: text, filled rects, stroked lines and shapes. Not ink: the page or chart
// background plate (a rect covering its whole viewBox), invisible rects (fill none) and the module and
// scene boundary rects. Text is boxed by its glyphs: from 0.75em above the baseline (0.86em for CJK) down
// to the lowest descender it really has (0.21em for g j p q y , ; ( ) and so on, 0.10em for CJK, none for
// digits and capitals). A line is measured along its path and a stroke adds no width, so a hairline
// sitting on a box edge is on that edge. Top-level elements that paint nothing are still recorded, as
// page.quiet (boundary rects, the plate, invisible shapes), so pageFingerprint can place and compare them.
//
// Limits: text/tspan, rect, line, circle, ellipse, polyline, polygon, image, g and nested svg with a
// "meet" aspect ratio; fill, font and opacity are read from the element itself only. Anything else
// throws, so ink is never silently missed.
import assert from 'node:assert/strict';
import { parseXml, multiply, translate, scaleFn, ownTransformMatrix, apply } from '../runtime/pi/render_qa_svg.mjs';
import { TEXT_WIDTH_FACTORS, LATIN_ADVANCE_WIDTHS, LATIN_BOLD_ADVANCE_WIDTHS, BOLD_WEIGHT_THRESHOLD } from '../runtime/pi/render_qa_geometry.mjs';

const EPS = 0.01;
export const INK_TOLERANCE = 0.5; // sub-pixel slack for "ink inside box"
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const r1 = (n) => Math.round(n * 10) / 10;
const CJK = /[⺀-鿿가-퟿豈-﫿＀-￯]/;
const DESCENDER = /[gjpqy,;()[\]{}|@Q_]/;
const SKIP = new Set(['title', 'desc', 'defs', 'style', 'metadata']);
const INHERITED = ['font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'opacity', 'fill', 'stroke', 'display', 'visibility'];
const painted = (v) => v !== undefined && v !== 'none' && v !== 'transparent';

function glyphBox(text, fs) {
  let up = 0, down = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (CJK.test(ch)) { up = Math.max(up, 0.86); down = Math.max(down, 0.1); } else { up = Math.max(up, 0.75); if (DESCENDER.test(ch)) down = Math.max(down, 0.21); }
  }
  return { up: up * fs, down: down * fs };
}
function advance(text, fs, weight, ls) {
  const table = weight === 'bold' || num(weight) >= BOLD_WEIGHT_THRESHOLD ? LATIN_BOLD_ADVANCE_WIDTHS : LATIN_ADVANCE_WIDTHS;
  let em = 0, n = 0;
  for (const ch of text) { n += 1; em += table[ch] ?? (CJK.test(ch) ? TEXT_WIDTH_FACTORS.cjk : /\s/.test(ch) ? TEXT_WIDTH_FACTORS.space : 1.02); }
  return em * fs + n * ls;
}
function visible(a, strokeOnly = false) {
  if (num(a.opacity, 1) <= 0.05) return false;
  const stroke = painted(a.stroke) && num(a['stroke-width'], 1) > 0;
  return strokeOnly ? stroke : (painted(a.fill ?? 'black') && num(a['fill-opacity'], 1) > 0.05) || stroke;
}
const boundsOf = (pts) => ({ x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) });
const corners = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }];
const toPage = (m, pts) => boundsOf(pts.map((p) => apply(m, p.x, p.y)));
const clipTo = (b, clip) => {
  if (!clip) return b;
  const c = { x0: Math.max(b.x0, clip.x0), y0: Math.max(b.y0, clip.y0), x1: Math.min(b.x1, clip.x1), y1: Math.min(b.y1, clip.y1) };
  return c.x0 > c.x1 + EPS || c.y0 > c.y1 + EPS ? null : c;
};
const covers = (a, b) => a.x0 <= b.x0 + EPS && a.y0 <= b.y0 + EPS && a.x1 >= b.x1 - EPS && a.y1 >= b.y1 - EPS;

// One chunk per run of text on one baseline (a tspan with its own x/y/dy starts the next chunk).
function textChunks(node) {
  const a = node.attrs;
  const base = { fs: num(a['font-size'], 16), weight: a['font-weight'] ?? 'normal', ls: num(a['letter-spacing']) };
  const anchor = a['text-anchor'] ?? 'start';
  const done = [];
  let chunk = { x: num(a.x), y: num(a.y), anchor, runs: [] };
  const width = (c) => c.runs.reduce((sum, run) => sum + run.w, 0);
  const add = (text, st) => { if (text.trim() !== '') chunk.runs.push({ text, fs: st.fs, w: advance(text, st.fs, st.weight, st.ls), ...glyphBox(text, st.fs) }); };
  add(node.text.replace(/\s+/g, ' '), base);
  for (const child of node.children) {
    if (child.tag !== 'tspan') continue;
    const t = child.attrs;
    const st = { fs: num(t['font-size'], base.fs), weight: t['font-weight'] ?? base.weight, ls: num(t['letter-spacing'], base.ls) };
    if (t.x !== undefined || t.y !== undefined || num(t.dy) !== 0) {
      const cursor = chunk.x + width(chunk);
      done.push(chunk);
      chunk = { x: t.x !== undefined ? num(t.x) : cursor, y: (t.y !== undefined ? num(t.y) : chunk.y) + num(t.dy), anchor, runs: [] };
    }
    if (num(t.dx) !== 0) chunk.runs.push({ text: '', fs: st.fs, w: num(t.dx), up: 0, down: 0 });
    add(child.text.replace(/\s+/g, ' '), st);
  }
  done.push(chunk);
  return done.filter((c) => c.runs.some((run) => run.text !== ''));
}

// Parse a composed page (or one chart svg) into ink marks, module and scene boxes and embedded charts,
// all in root user units.
export function measurePage(svgText) {
  const doc = parseXml(svgText);
  const root = doc.children.find((n) => n.tag === 'svg');
  assert.ok(root, 'an <svg> root is required');
  const vb = String(root.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  assert.ok(vb.length === 4 && vb.every(Number.isFinite), 'root svg needs a numeric viewBox');
  const page = { width: vb[2], height: vb[3], modules: [], scenes: [], visuals: [], marks: [], quiet: [], root };
  const unsupported = (node, why = '') => { throw new Error(`lib_page_geometry: unsupported <${node.tag}>${why}`); };
  const push = (kind, node, ctx, b, extra = {}) => {
    const clipped = clipTo(b, ctx.clip);
    if (clipped) page.marks.push({ kind, ...clipped, order: node.docIndex, visual: ctx.visual, top: ctx.top ?? node, ...extra });
  };
  // A top-level element that paints nothing (a module or scene boundary, the page plate, an invisible shape)
  // is not ink, but it still has a place on the page; pageFingerprint needs it.
  const quiet = (kind, node, ctx, b, extra = {}) => {
    if (ctx.top === null) page.quiet.push({ kind, ...b, top: node, ...extra });
  };
  const visit = (node, ctx) => {
    for (const child of node.children) {
      const a = child.attrs;
      if (SKIP.has(child.tag)) continue;
      const own = ownTransformMatrix(child);
      if (own === null) unsupported(child, ' (unparseable transform)');
      const m = multiply(own, ctx.m);
      const here = { ...ctx, m, top: ctx.top ?? child };
      if (child.tag === 'g') {
        if (INHERITED.some((k) => a[k] !== undefined)) unsupported(child, ' (inherited presentation attributes)');
        visit(child, here);
      } else if (child.tag === 'svg') {
        const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
        assert.ok(w > 0 && h > 0, 'a nested <svg> needs a width and a height');
        const box = String(a.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
        const [minX, minY, vbW, vbH] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, w, h];
        const par = String(a.preserveAspectRatio ?? 'xMidYMid meet').trim().split(/\s+/);
        if (par[0] === 'none' || par[1] === 'slice') unsupported(child, ' (aspect ratio)');
        const s = Math.min(w / vbW, h / vbH);
        const ox = (w - vbW * s) * (par[0].includes('xMin') ? 0 : par[0].includes('xMax') ? 1 : 0.5);
        const oy = (h - vbH * s) * (par[0].includes('YMin') ? 0 : par[0].includes('YMax') ? 1 : 0.5);
        const inner = multiply(multiply(multiply(translate(-minX, -minY), scaleFn(s, s)), translate(x + ox, y + oy)), m);
        const viewport = toPage(m, corners(x, y, w, h));
        const isChart = a['data-role'] === 'infographic-visual';
        if (isChart) page.visuals.push({ id: a['data-module-id'], x: viewport.x0, y: viewport.y0, w: viewport.x1 - viewport.x0, h: viewport.y1 - viewport.y0, vb: { minX, minY, w: vbW, h: vbH }, scale: s * Math.abs(m.a), originX: apply(inner, minX, minY).x, originY: apply(inner, minX, minY).y });
        visit(child, { ...here, m: inner, clip: clipTo(viewport, ctx.clip) ?? { x0: 0, y0: 0, x1: -1, y1: -1 }, plate: toPage(inner, corners(minX, minY, vbW, vbH)), visual: isChart ? a['data-module-id'] : ctx.visual });
      } else if (child.tag === 'rect') {
        const b = toPage(m, corners(num(a.x), num(a.y), num(a.width), num(a.height)));
        const role = a['data-role'];
        if (role === 'module-boundary') {
          page.modules.push({ id: a['data-module-id'], x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
          quiet('module-boundary', child, ctx, b, { id: a['data-module-id'] });
        } else if (role === 'scene-boundary') {
          page.scenes.push({ id: a['data-scene-id'], x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
          quiet('scene-boundary', child, ctx, b, { id: a['data-scene-id'] });
        } else if (visible(a) && b.x1 - b.x0 > 0 && b.y1 - b.y0 > 0 && !covers(b, ctx.plate)) push('rect', child, here, b, { role });
        else quiet(visible(a) && covers(b, ctx.plate) ? 'plate' : 'ghost', child, ctx, b);
      } else if (child.tag === 'line') {
        const b = toPage(m, [{ x: num(a.x1), y: num(a.y1) }, { x: num(a.x2), y: num(a.y2) }]);
        if (visible(a, true)) push('line', child, here, b); else quiet('ghost', child, ctx, b);
      } else if (child.tag === 'circle' || child.tag === 'ellipse') {
        const rx = num(a.r ?? a.rx), ry = num(a.r ?? a.ry);
        const b = toPage(m, corners(num(a.cx) - rx, num(a.cy) - ry, 2 * rx, 2 * ry));
        if (visible(a)) push(child.tag, child, here, b); else quiet('ghost', child, ctx, b);
      } else if (child.tag === 'polyline' || child.tag === 'polygon') {
        const n = String(a.points ?? '').trim().split(/[\s,]+/).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
        if (pts.length) { const b = toPage(m, pts); if (visible(a)) push(child.tag, child, here, b); else quiet('ghost', child, ctx, b); }
      } else if (child.tag === 'image') {
        push('image', child, here, toPage(m, corners(num(a.x), num(a.y), num(a.width), num(a.height))));
      } else if (child.tag === 'text') {
        const shownText = visible(a);
        for (const c of textChunks(child)) {
          const w = c.runs.reduce((sum, run) => sum + run.w, 0);
          const x0 = c.anchor === 'middle' ? c.x - w / 2 : c.anchor === 'end' ? c.x - w : c.x;
          const up = Math.max(...c.runs.map((run) => run.up)), down = Math.max(...c.runs.map((run) => run.down));
          const shown = c.runs.filter((run) => run.text !== '');
          const b = toPage(m, corners(x0, c.y - up, w, up + down));
          if (shownText) push('text', child, here, b, { text: shown.map((run) => run.text).join(''), first: shown[0].text, fs: Math.max(...shown.map((run) => run.fs)) * Math.abs(m.a) });
          else quiet('ghost', child, ctx, b);
        }
      } else unsupported(child);
    }
  };
  visit(root, { m: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, clip: null, plate: { x0: vb[0], y0: vb[1], x1: vb[0] + vb[2], y1: vb[1] + vb[3] }, visual: null, top: null });
  return page;
}

export const inkBounds = (marks) => (marks.length ? {
  x0: Math.min(...marks.map((m) => m.x0)), y0: Math.min(...marks.map((m) => m.y0)),
  x1: Math.max(...marks.map((m) => m.x1)), y1: Math.max(...marks.map((m) => m.y1)),
} : null);
const describe = (m) => `${m.kind}${m.text ? ` "${m.text.slice(0, 24)}"` : ''} [${r1(m.x0)},${r1(m.y0)} - ${r1(m.x1)},${r1(m.y1)}]`;
const boxText = (b) => `[${r1(b.x)},${r1(b.y)} - ${r1(b.x + b.w)},${r1(b.y + b.h)}]`;
const insideBox = (m, b, tol) => m.x0 >= b.x - tol && m.y0 >= b.y - tol && m.x1 <= b.x + b.w + tol && m.y1 <= b.y + b.h + tol;
// A box is hit by ink that overlaps it; a hairline belongs to the box whose top edge it sits on.
const hitsBox = (m, b) => {
  const ox = Math.min(m.x1, b.x + b.w) - Math.max(m.x0, b.x);
  const oy = Math.min(m.y1, b.y + b.h) - Math.max(m.y0, b.y);
  if (m.y1 - m.y0 < EPS) return ox > EPS && m.y0 >= b.y - EPS && m.y0 < b.y + b.h - EPS;
  if (m.x1 - m.x0 < EPS) return oy > EPS && m.x0 >= b.x - EPS && m.x0 < b.x + b.w - EPS;
  return ox > EPS && oy > EPS;
};
const pageSpan = (page) => ({
  top: Math.min(...page.modules.map((b) => b.y), ...page.scenes.map((s) => s.y)),
  bottom: Math.max(...page.modules.map((b) => b.y + b.h), ...page.scenes.map((s) => s.y + s.h)),
});

// Module boxes: no two overlap, and a later module is below or to the right of an earlier one.
export function boxProblems(boxes) {
  const problems = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > EPS && oy > EPS) problems.push(`boxes ${a.id} ${boxText(a)} and ${b.id} ${boxText(b)} overlap by ${r1(ox)} x ${r1(oy)} px`);
      else if (!(b.y >= a.y + a.h - EPS || b.x >= a.x + a.w - EPS)) problems.push(`${b.id} follows ${a.id} in the module order but is neither below nor right of it`);
    }
  }
  return problems;
}
export const assertBoxesInOrder = (boxes, label) => assert.deepEqual(boxProblems(boxes), [], `${label}: module boxes keep their order and do not overlap`);
// The boxes a composer reports are the module-boundary rects in its own svg.
export function assertBoxesMatchSvg(page, boxes, label) {
  const round = (b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) });
  assert.deepEqual(page.modules.map(round), boxes.map(round), `${label}: reported boxes equal the module-boundary rects drawn in the svg`);
}

// Who owns a piece of ink: the module whose box it overlaps (the latest one if it overlaps several), else
// the scene it lies in, else the page header above the first box or the footer below the last.
function ownerOf(page, m, span = pageSpan(page), tol = INK_TOLERANCE) {
  const hits = page.modules.filter((b) => hitsBox(m, b));
  if (hits.length) return { kind: 'module', box: hits.reduce((late, b) => (b.y >= late.y ? b : late)), hits };
  const scene = page.scenes.find((s) => insideBox(m, s, tol));
  if (scene) return { kind: 'scene', box: scene, hits };
  if (m.y1 <= span.top + EPS) return { kind: 'header', hits };
  if (m.y0 >= span.bottom - EPS) return { kind: 'footer', hits };
  return { kind: 'nowhere', hits };
}
// Ink grouped by module, and the ink that is out of place: outside every box, in two boxes at once, or
// leaving its own box.
export function assignInk(page, tol = INK_TOLERANCE) {
  const owned = new Map(page.modules.map((b) => [b.id, []]));
  const problems = [];
  const span = pageSpan(page);
  for (const m of page.marks) {
    const owner = ownerOf(page, m, span, tol);
    if (owner.kind === 'nowhere') problems.push(`ink outside every module box: ${describe(m)}`);
    else if (owner.hits.length > 1) problems.push(`ink touches ${owner.hits.length} module boxes (${owner.hits.map((b) => b.id).join(', ')}): ${describe(m)}`);
    else if (owner.kind === 'module') {
      owned.get(owner.box.id).push(m);
      if (!insideBox(m, owner.box, tol)) problems.push(`${owner.box.id}: ink leaves its own box ${boxText(owner.box)}: ${describe(m)}`);
    }
  }
  return { owned, problems };
}
export const assertInkInsideBoxes = (page, label) => assert.deepEqual(assignInk(page).problems, [], `${label}: every module's ink stays inside its own box`);
export const moduleInk = (page, id) => inkBounds(assignInk(page).owned.get(id) ?? []);
export const visualInk = (page, id) => inkBounds(page.marks.filter((m) => m.visual === id));

// A hero numeral is fully visible: inside the page and its own box, with no text or later-painted ink over it.
export function assertNumeralVisible(page, moduleId, value, label) {
  const mine = (assignInk(page).owned.get(moduleId) ?? []).filter((m) => m.kind === 'text' && m.first.trim() === value);
  assert.ok(mine.length > 0, `${label}: numeral ${value} of ${moduleId} is drawn inside its box`);
  const n = mine.reduce((best, m) => (m.fs > best.fs ? m : best));
  assert.ok(n.x0 >= 0 && n.y0 >= 0 && n.x1 <= page.width && n.y1 <= page.height, `${label}: numeral ${value} is inside the page: ${describe(n)}`);
  assert.ok(insideBox(n, page.modules.find((b) => b.id === moduleId), INK_TOLERANCE), `${label}: numeral ${value} is inside its box ${moduleId}: ${describe(n)}`);
  const over = page.marks.filter((m) => m !== n && (m.kind === 'text' || m.order > n.order) && Math.min(m.x1, n.x1) - Math.max(m.x0, n.x0) > EPS && Math.min(m.y1, n.y1) - Math.max(m.y0, n.y0) > EPS);
  assert.deepEqual(over.map(describe), [], `${label}: nothing overlaps numeral ${value}`);
}

// An embedded chart as the svg renderer draws it (the "meet" rule), from the page's own attributes, and
// a standalone chart's ink in its own viewBox units.
export function embeddedChart(page, id) {
  const v = page.visuals.find((x) => x.id === id);
  assert.ok(v, `embedded chart ${id} is in the page`);
  return v;
}
export function nativeInk(svgText) {
  const chart = measurePage(svgText);
  return { width: chart.width, height: chart.height, ink: inkBounds(chart.marks), fontSizes: chart.marks.filter((m) => m.kind === 'text').map((m) => m.fs) };
}
// Where a native-unit box lands on the page once the chart is embedded.
export function mapToPage(v, box) {
  return { x0: v.originX + (box.x0 - v.vb.minX) * v.scale, y0: v.originY + (box.y0 - v.vb.minY) * v.scale, x1: v.originX + (box.x1 - v.vb.minX) * v.scale, y1: v.originY + (box.y1 - v.vb.minY) * v.scale };
}

// Canonical form of a page for comparing two renderings of one spec that may place the modules at
// different heights. Every child of the root svg is written out whole, in document order, labelled with the
// region that owns it: a module or scene (by id), the page header (above the first box), the footer (below
// the last box), the page plate, or a module/scene boundary rect. Vertical attributes are written relative
// to the owner's frame: y, y1 and y2 to the box top of the owning module or scene (the header keeps its page
// coordinates, the footer is relative to the page height), height of the plate to the page and of a
// boundary rect to its own box. So moving a whole module changes nothing, while moving anything inside it
// does. Everything else is compared exactly, every non-ink element included. A nested chart svg is written
// out whole. The root element is written with its viewBox origin and width but not its height.
export function pageFingerprint(svgText, normalize = (s) => s) {
  const page = measurePage(svgText);
  const span = pageSpan(page);
  const fmt = (n) => String(Math.round(n * 1e6) / 1e6);
  const write = (node, rel, nested) => {
    assert.equal(node.attrs.transform, undefined, 'fingerprint: transform is not supported');
    const attrs = Object.entries(node.attrs).map(([k, v]) => `${k}="${!nested && rel[k] !== undefined && Number.isFinite(Number(v)) ? fmt(Number(v) - rel[k]) : v}"`).join(' ');
    return `<${node.tag} ${attrs}>${node.text}${node.children.map((c) => write(c, rel, nested || node.tag === 'svg')).join('')}</${node.tag}>`;
  };
  const parts = new Map();
  for (const p of [...page.marks, ...page.quiet]) parts.set(p.top, [...(parts.get(p.top) ?? []), p]);
  const sequence = page.root.children.map((node) => {
    let owner = 'header', rel = {};
    if (!SKIP.has(node.tag)) {
      const mine = parts.get(node);
      assert.ok(mine, `fingerprint: <${node.tag}> paints nothing and is not a box, so it has no place on the page`);
      const edge = mine.find((p) => p.kind === 'module-boundary' || p.kind === 'scene-boundary' || p.kind === 'plate');
      if (edge?.kind === 'plate') {
        owner = 'plate';
        rel = { height: page.height };
      } else if (edge) {
        const box = (edge.kind === 'module-boundary' ? page.modules : page.scenes).find((b) => b.id === edge.id);
        owner = `${edge.kind}:${edge.id}`;
        rel = { y: box.y, y1: box.y, y2: box.y, height: box.h };
      } else {
        const where = ownerOf(page, inkBounds(mine), span);
        assert.notEqual(where.kind, 'nowhere', `fingerprint: <${node.tag}> lies outside every region: ${describe(inkBounds(mine))}`);
        const inBox = where.kind === 'module' || where.kind === 'scene';
        const dy = inBox ? where.box.y : where.kind === 'footer' ? page.height : 0;
        owner = inBox ? `${where.kind}:${where.box.id}` : where.kind;
        rel = { y: dy, y1: dy, y2: dy };
      }
    }
    return { owner, xml: normalize(write(node, rel, false)) };
  });
  const [vx, vy, vw] = String(page.root.attrs.viewBox).trim().split(/[\s,]+/);
  const rootAttrs = Object.entries(page.root.attrs).map(([k, v]) => `${k}="${k === 'viewBox' ? `${vx} ${vy} ${vw}` : v}"`).join(' ');
  return { root: normalize(`<svg ${rootAttrs}>`), sequence };
}
