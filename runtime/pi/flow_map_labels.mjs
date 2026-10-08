// Default-off label layer for cartographic_flow_map (spec.flow_map_labels =
// "leader" | "ledger", abstract_od only, desktop only). Absent flag: viz.mjs
// does not call into this file, so output is byte-identical.
//
// The placement tests here are stricter than render QA on purpose. QA only
// sees unfilled <path> centre-lines and circles, so a plate drawn over a thick
// arc would pass QA and still hide data. Every disc, plate and name box is
// therefore tested against each arc's stroke (centre-line +/- half width + 2px)
// and against every node dot and arrowhead. Filled plates and leader lines are
// never used to cover data.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// The plan tool only offers the field when NEWSROOM_FLOW_MAP_LABELS=1, so the tool
// definitions the model sees stay byte-identical while the switch is off.
export function flowMapLabelsEnabled() {
  return process.env.NEWSROOM_FLOW_MAP_LABELS === "1";
}
export const FLOW_MAP_LABEL_STYLES = ["leader", "ledger"];
export const LEDGER_MAP_RIGHT = 700;
export const LEDGER_PANEL_X = 724;
const BADGE_R = 8.5;
const STROKE_PAD = 2;

export function flowWidth(value, max) {
  return Math.max(2, (value / Math.max(max, 1e-9)) * 18);
}
export function arrowSize(sw) {
  return Math.min(20, Math.max(9, sw * 1.2 + 5));
}
// 1-2-5 floor samples at about 90%, 30% and 10% of the maximum, de-duplicated.
export function widthSamples(max) {
  const nice = (v) => {
    if (!(v > 0)) return 0;
    const e = Math.pow(10, Math.floor(Math.log10(v))), m = v / e;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e;
  };
  return [...new Set([max * 0.9, max * 0.3, max * 0.1].map(nice).filter((v) => v > 0))].sort((a, b) => b - a);
}

// Which label style a map gets, from its data. A star (every flow shares one origin or one destination) of at most
// 8 flows reads best with names beside the dots; everything else gets the numbered ledger. A requested style is kept
// when it fits; a "leader" that does not fit falls back to the ledger with a reason (a lint warning, never an error).
export function flowMapStyleFor(pairs, requested) {
  const n = pairs.length, srcs = new Set(pairs.map((p) => p[0])), tgts = new Set(pairs.map((p) => p[1]));
  const star = n >= 1 && (srcs.size === 1 || tgts.size === 1), fits = star && n <= 8, auto = fits ? "leader" : "ledger";
  if (!FLOW_MAP_LABEL_STYLES.includes(requested)) return { style: auto, reason: null };
  if (requested === "leader" && !fits) return { style: "ledger", reason: `flow_map_labels 'leader' fits only a star of at most 8 flows (every flow shares one origin or one destination); this map has ${n} flows${star ? "" : " with no shared end"}, so the ledger style is used` };
  return { style: requested, reason: null };
}
// The end every flow shares, when there are at least two flows and one end is common to all of them.
export function sharedEnd(routes) {
  if (routes.length < 2) return null;
  const tgts = new Set(routes.map((r) => r.targetName)), srcs = new Set(routes.map((r) => r.sourceName));
  if (tgts.size === 1) return { side: "target", name: routes[0].targetName };
  if (srcs.size === 1) return { side: "source", name: routes[0].sourceName };
  return null;
}
// Numbers for rows in rank order (values descending). Adjacent rows with different values never print the same text:
// when two would, every row gains one decimal, then at most one more. The unit is not part of the text.
export function flowNumberTexts(spec, values, fmtSpec) {
  const texts = (d) => values.map((v) => fmtSpec(spec, v, "", d));
  const collide = (t) => t.some((x, i) => i > 0 && values[i] !== values[i - 1] && x === t[i - 1]);
  let t = texts(null);
  if (!collide(t)) return t;
  const n0 = Math.max(0, ...t.map((x) => (/\.(\d+)/.exec(x)?.[1].length ?? 0)));
  for (let d = n0 + 1; d <= n0 + 2; d++) { t = texts(d); if (!collide(t)) break; }
  return t;
}
// Wrap a name onto lines of at most maxW, breaking after an arrow when one is near; never truncates.
function wrapName(text, maxW, wUnits) {
  const lines = []; let cur = "";
  for (const ch of [...text]) {
    if (cur && wUnits(cur + ch) > maxW) {
      const k = cur.lastIndexOf("→");
      if (k >= 0 && k < cur.length - 1) { lines.push(cur.slice(0, k + 1)); cur = cur.slice(k + 1); } else { lines.push(cur); cur = ""; }
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function sampleArc(a, c, b, step = 2.5) {
  const len = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
  const n = Math.max(12, Math.ceil(len / step)), pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y, t });
  }
  return pts;
}
function rectPointDist(r, p) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
function rectsOverlap(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
function orient(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function segCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

// Does the segment p-q touch the rectangle (with a 2px margin)? Sampled; leaders are short.
function segHitsRect(p, q, r) {
  const n = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2));
  for (let i = 0; i <= n; i++) { const t = i / n; if (rectPointDist(r, { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }) <= 2) return true; }
  return false;
}

// Rank order of the flows: value descending, ties by "origin→destination" text, then by input position, so rank and style never depend on row order.
const nameKey = (r) => `${r.sourceName}→${r.targetName}`;
const rankCmp = (p, q) => (q.r.value - p.r.value) || (nameKey(p.r) < nameKey(q.r) ? -1 : nameKey(p.r) > nameKey(q.r) ? 1 : 0) || (p.i - q.i);
// Adjacent ranks (values descending) that still print the same text at the decimals cap: rank numbers whose order the page must not claim.
export function flowNumberTies(spec, values, fmtSpec) {
  const sorted = [...new Set(values)].sort((x, y) => y - x), t = flowNumberTexts(spec, sorted, fmtSpec);
  return sorted.map((v, k) => (k > 0 && t[k] === t[k - 1] ? [sorted[k - 1], v, t[k]] : null)).filter(Boolean);
}
// The ranked ledger beside the map: which flows get a row, in how many columns, and where. One column first, then two; when
// two columns still do not hold every flow, only the first `rows.length` flows (in rank order) are listed, and the caller
// draws only those. Names wrap, numbers never do (right-aligned on the row's first line).
export function ledgerGeometry({ spec, routes, bounds, textUnits, fmtSpec, zh, extra = new Set() }) {
  const font = 12.5, wUnits = (t) => textUnits(t) * font * 0.56, px = LEDGER_PANEL_X, pr = 980, gutter = 12;
  const order = routes.map((r, i) => ({ r, i })).sort(rankCmp);
  const sortedValues = [...new Set(routes.map((r) => r.value))].sort((x, y) => y - x), texts = flowNumberTexts(spec, sortedValues, fmtSpec);
  const numByValue = new Map(sortedValues.map((v, k) => [v, texts[k]]));
  const shared = sharedEnd(routes);
  const y0 = bounds.top + 34, yCap = bounds.bottom + 6;
  const base = order.map(({ r, i }, k) => ({ i, n: k + 1, value: r.value, num: numByValue.get(r.value), name: shared ? (shared.side === "target" ? r.sourceName : r.targetName) : nameKey(r) }));
  const numW = Math.max(...base.map((r) => wUnits(r.num)), 0);
  let best = null;
  for (const [cols, lineH, pad] of [[1, 16, 8], [1, 15, 4], [2, 16, 8], [2, 15, 4]]) {
    const colW = cols === 1 ? pr - px : (pr - px - gutter) / 2, nameW = colW - 26 - numW - (cols === 1 ? 12 : 8);
    const rows = []; const yy = [y0, y0]; let col = 0;
    for (const b of base) {
      const lines = wrapName(b.name, nameW, wUnits), h = (lines.length + (extra.has(b.n) ? 1 : 0)) * lineH + pad;
      if (yy[col] + h > yCap) { if (cols === 2 && col === 0) col = 1; else break; if (yy[col] + h > yCap) break; }
      rows.push({ ...b, lines, lineH, pad, col, colX: px + col * (colW + gutter), colW, y: yy[col] }); yy[col] += h;
    }
    best = { cols, rows, cut: base.length - rows.length, numByValue, shared, order, px, pr };
    if (!best.cut) break;
  }
  return best;
}

export function layoutFlowMapLabels(ctx) {
  const { spec, routes, bounds, esc, textUnits, fmtSpec, PALETTE, FONT_SANS, zh } = ctx;
  const style = ctx.style ?? spec.flow_map_labels, font = 12.5;
  const arcs = routes.map((r) => ({ ...r, pts: sampleArc(r.a, r.control, r.b), hw: r.sw / 2 }));
  // Round obstacles: every node dot, and each arrowhead.
  const dots = [];
  for (const r of routes) { dots.push({ x: r.a.x, y: r.a.y, r: 3.2 }); dots.push({ x: r.b.x, y: r.b.y, r: Math.max(3.5, r.arrow * 0.6) }); }
  const inBounds = (box) => box.x >= bounds.left + 2 && box.y >= bounds.top + 2 && box.x + box.w <= bounds.right - 2 && box.y + box.h <= bounds.bottom - 2;
  const rectHitsAnyArc = (box) => arcs.some((arc) => arc.pts.some((p) => rectPointDist(box, p) <= arc.hw + STROKE_PAD));
  const rectHitsDot = (box) => dots.some((d) => rectPointDist(box, d) <= d.r + 2);
  const leaderCrossings = (p, q) => { let n = 0; for (const arc of arcs) for (let i = 1; i < arc.pts.length; i++) if (segCross(p, q, arc.pts[i - 1], arc.pts[i])) n++; return n; };
  const diag = { style, arcs: routes.length, names_placed: 0, names_overflow: [], badges_placed: 0, badges_unplaced: [], leader_crossings: 0 };
  const parts = [];

  const wUnits = (t) => textUnits(t) * font * 0.56;
  // One shared decimal count, so adjacent ranks never print the same number (values arrive in rank order).
  const numByValue = new Map();
  { const sorted = [...new Set(arcs.map((a) => a.value))].sort((x, y) => y - x); const texts = flowNumberTexts(spec, sorted, fmtSpec); sorted.forEach((v, k) => numByValue.set(v, texts[k])); }
  const shared = sharedEnd(routes);

  if (style === "ledger") {
    const placedDiscs = [], leaders = [];
    const discFree = (c) => {
      if (c.x - BADGE_R < bounds.left + 2 || c.x + BADGE_R > bounds.right - 2 || c.y - BADGE_R < bounds.top + 2 || c.y + BADGE_R > bounds.bottom - 2) return false;
      if (arcs.some((arc) => arc.pts.some((p) => Math.hypot(p.x - c.x, p.y - c.y) <= arc.hw + STROKE_PAD + BADGE_R + 1))) return false;
      if (dots.some((d) => Math.hypot(d.x - c.x, d.y - c.y) <= d.r + BADGE_R + 2)) return false;
      if (leaders.some((l) => segHitsRect({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }, { x: c.x - BADGE_R, y: c.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2 }))) return false;
      return !placedDiscs.some((q) => Math.hypot(q.x - c.x, q.y - c.y) <= BADGE_R * 2 + 3);
    };
    const geo0 = ledgerGeometry({ spec, routes, bounds, textUnits, fmtSpec, zh });
    const order = geo0.order.map(({ i }) => ({ arc: arcs[i], i })), rank = new Map(order.map((o, k) => [o.i, k + 1])), px = geo0.px, pr = geo0.pr, y0 = bounds.top + 34;
    // Badges: beside the arc first; else a short leader to the nearest free spot; else the row says it is not on the map.
    const place = ({ arc, i }) => {
      const side = arc.hw + STROKE_PAD + BADGE_R + 3, own = arcs.indexOf(arc);
      for (const [ti, dist] of [side, side + 10, side + 22, side + 36, side + 52].entries()) {
        const cands = [];
        arc.pts.forEach((p, k) => {
          if (p.t < 0.02 || p.t > 0.98 || (ti > 0 && k % 3)) return;
          const j = Math.min(k + 1, arc.pts.length - 1), kk = Math.max(k - 1, 0);
          const dx = arc.pts[j].x - arc.pts[kk].x, dy = arc.pts[j].y - arc.pts[kk].y, len = Math.hypot(dx, dy) || 1;
          for (const sgn of [1, -1]) cands.push({ x: p.x + (-dy / len) * dist * sgn, y: p.y + (dx / len) * dist * sgn, px: p.x, py: p.y, score: Math.min(p.t, 1 - p.t) + (p.t > 0.5 ? 0.05 : 0) });
        });
        let best = null;
        for (const c of cands) {
          if (!discFree(c)) continue;
          let cross = 0, leader = null;
          if (ti > 0) {
            const ux = c.px - c.x, uy = c.py - c.y, ul = Math.hypot(ux, uy) || 1;
            leader = { x1: c.x + (ux / ul) * (BADGE_R + 3), y1: c.y + (uy / ul) * (BADGE_R + 3), x2: c.px, y2: c.py };
            if (placedDiscs.some((q) => segHitsRect({ x: leader.x1, y: leader.y1 }, { x: leader.x2, y: leader.y2 }, { x: q.x - BADGE_R, y: q.y - BADGE_R, w: BADGE_R * 2, h: BADGE_R * 2 }))) continue;
            if (leaders.some((q) => segCross({ x: leader.x1, y: leader.y1 }, { x: leader.x2, y: leader.y2 }, { x: q.x1, y: q.y1 }, { x: q.x2, y: q.y2 }))) continue;
            for (const [ai, other] of arcs.entries()) if (ai !== own) for (let k = 1; k < other.pts.length; k++) if (segCross({ x: leader.x1, y: leader.y1 }, { x: leader.x2, y: leader.y2 }, other.pts[k - 1], other.pts[k])) cross++;
            if (cross > 1) continue;
          }
          const score = cross * 1000 + c.score;
          if (!best || score < best.score) best = { ...c, leader, score };
        }
        if (best) { placedDiscs.push(best); if (best.leader) { leaders.push(best.leader); diag.badge_leaders = (diag.badge_leaders ?? 0) + 1; } arc.badge = { x: best.x, y: best.y, n: rank.get(i), leader: best.leader }; diag.badges_placed++; return true; }
      }
      diag.badges_unplaced.push(rank.get(i)); return false;
    };
    for (const r of order) place(r);
    const unplaced = new Set(diag.badges_unplaced);
    // A flow with no spot on the map gets an extra 「图上未标」 line in its row, so the rows are laid out again with that line counted.
    const geo = unplaced.size ? ledgerGeometry({ spec, routes, bounds, textUnits, fmtSpec, zh, extra: unplaced }) : geo0;
    const shownRows = geo.rows.map((r) => ({ ...r, arc: arcs[r.i] }));
    for (const arc of arcs) if (arc.badge?.leader) { const l = arc.badge.leader; parts.push(`<line data-role="cartographic-label-leader" pointer-events="none" x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" stroke="${PALETTE.ink}" stroke-width=".8"/>`); }
    for (const arc of arcs) if (arc.badge) {
      parts.push(`<circle data-role="annotation-marker" cx="${arc.badge.x.toFixed(1)}" cy="${arc.badge.y.toFixed(1)}" r="${BADGE_R}" fill="#ffffff" stroke="${arc.highlight ? PALETTE.accent : PALETTE.ink}" stroke-width="${arc.highlight ? 2 : 1.2}"/>`);
      parts.push(`<text data-role="annotation-marker-label" x="${arc.badge.x.toFixed(1)}" y="${(arc.badge.y + 4.2).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="${PALETTE.ink}">${arc.badge.n}</text>`);
    }
    // Ranked ledger panel to the right of the map. The unit is given once, in the header.
    const unitTail = spec.unit ? ` · ${spec.unit}` : "";
    const header = shared ? (shared.side === "target" ? (zh ? `来源（流向${shared.name}）` : `Origin (to ${shared.name})`) : (zh ? `去向（来自${shared.name}）` : `Destination (from ${shared.name})`)) : (zh ? "按数值从大到小" : "Ranked by value");
    parts.push(`<text data-role="flow-ledger-header" x="${px}" y="${bounds.top + 12}" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(header + unitTail)}</text>`);
    let yEnd = y0;
    for (const r of shownRows) {
      const { arc, n: num } = r, b1 = r.y + 12, off = unplaced.has(num), cx = r.colX + 9, nx = r.colX + 26, vx = r.colX + r.colW;
      parts.push(`<circle data-role="annotation-marker" cx="${cx}" cy="${r.y + 8}" r="${BADGE_R}" fill="#ffffff" stroke="${arc.highlight ? PALETTE.accent : PALETTE.ink}" stroke-width="${arc.highlight ? 2 : 1.2}"/><text data-role="annotation-marker-label" x="${cx}" y="${r.y + 12.2}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="${PALETTE.ink}">${num}</text>`);
      r.lines.forEach((ln, k) => parts.push(`<text data-role="flow-ledger-name" x="${nx}" y="${b1 + k * r.lineH}" font-family="${FONT_SANS}" font-size="${font}" font-weight="${arc.highlight ? 800 : 600}" fill="${PALETTE.ink}">${esc(ln)}</text>`));
      parts.push(`<text data-role="flow-ledger-value" x="${vx}" y="${b1}" text-anchor="end" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.ink}">${esc(r.num)}</text>`);
      if (off) parts.push(`<text x="${nx}" y="${b1 + r.lines.length * r.lineH}" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.muted}">${zh ? "图上未标" : "not marked on the map"}</text>`);
      yEnd = Math.max(yEnd, r.y + (r.lines.length + (off ? 1 : 0)) * r.lineH + r.pad);
    }
    diag.ledger_rows = shownRows.length; diag.ledger_cut = geo.cut; diag.ledger_cols = geo.cols;
    // Safety net for a caller that passes more flows than fit: say so on the panel, never drop silently.
    if (geo.cut > 0) parts.push(`<text x="${px}" y="${yEnd + 12}" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.ink}">${zh ? `其余 ${geo.cut} 条未列出` : `${geo.cut} more not listed`}</text>`);
    const offList = [...unplaced].sort((a, b) => a - b);
    const overflow = offList.length ? (zh ? `图上未标：第 ${offList.join("、")} 条弧线（地图上没有空位），见右侧列表` : `Not marked on the map (no free spot): ${offList.map((k) => `#${k}`).join(", ")}; see the ledger`) : "";
    return { parts, diag, overflow };
  }

  // style "leader": names beside the dots, short leaders into free space, no truncation.
  const nodes = new Map();
  for (const arc of arcs) {
    for (const [role, p, name] of [["s", arc.a, arc.sourceName], ["t", arc.b, arc.targetName]]) {
      const key = `${name}`;
      const node = nodes.get(key) ?? { name, x: p.x, y: p.y, weight: 0, src: 0, tgt: 0, srcValue: 0 };
      node.weight += arc.value; node.srcValue = arc.value; if (role === "s") node.src++; else node.tgt++;
      nodes.set(key, node);
    }
  }
  const placed = [], list = [...nodes.values()].sort((p, q) => q.weight - p.weight);
  const dirs = [[1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]];
  for (const node of list) {
    // An end that appears in exactly one flow (an origin, or a destination of a shared-origin star) prints that flow's value; a hub prints none.
    const text = node.src + node.tgt === 1 ? `${node.name} ${numByValue.get(node.srcValue)}` : node.name;
    const w = Math.max(25, textUnits(text) * font * 0.56 + 8), h = font + 8, g = 6;
    const cands = [];
    for (const [dx, dy] of dirs) cands.push({ box: { x: dx === 0 ? node.x - w / 2 : dx > 0 ? node.x + g : node.x - g - w, y: dy === 0 ? node.y - h / 2 : dy < 0 ? node.y - g - h : node.y + g, w, h }, ring: 0 });
    for (const [ri, d] of [18, 30, 44, 60].entries()) for (const [dx, dy] of dirs) {
      const norm = Math.hypot(dx, dy), ux = dx / norm, uy = dy / norm;
      const cx = node.x + ux * (d + Math.abs(ux) * w / 2), cy = node.y + uy * (d + Math.abs(uy) * h / 2);
      cands.push({ box: { x: cx - w / 2, y: cy - h / 2, w, h }, ring: ri + 1 });
    }
    let best = null;
    for (const c of cands) {
      const b = c.box;
      if (!inBounds(b) || rectHitsAnyArc(b) || rectHitsDot(b) || placed.some((q) => rectsOverlap(b, q.box, 2))) continue;
      // render QA refuses a leader that crosses any text: keep earlier leaders off this box
      if (placed.some((q) => q.leader && segHitsRect({ x: q.leader.x1, y: q.leader.y1 }, { x: q.leader.x2, y: q.leader.y2 }, b))) continue;
      let leader = null, cross = 0;
      if (c.ring > 0) {
        const qx = clamp(node.x, b.x, b.x + b.w), qy = clamp(node.y, b.y, b.y + b.h);
        leader = { x1: node.x, y1: node.y, x2: qx, y2: qy };
        cross = leaderCrossings({ x: node.x, y: node.y }, { x: qx, y: qy });
        if (cross > 1) continue;
        if (placed.some((q) => segHitsRect({ x: node.x, y: node.y }, { x: qx, y: qy }, q.box))) continue;
      }
      const score = cross * 1000 + c.ring * 10;
      if (!best || score < best.score) best = { ...c, leader, cross, score };
    }
    if (!best) { diag.names_overflow.push(text); continue; }
    placed.push({ box: best.box, text, leader: best.leader });
    diag.names_placed++; diag.leader_crossings += best.cross;
  }
  for (const p of placed) {
    const b = p.box;
    if (p.leader) parts.push(`<line data-role="cartographic-label-leader" pointer-events="none" x1="${p.leader.x1.toFixed(1)}" y1="${p.leader.y1.toFixed(1)}" x2="${p.leader.x2.toFixed(1)}" y2="${p.leader.y2.toFixed(1)}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);
    parts.push(`<rect data-role="cartographic-label-bg" pointer-events="none" x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="2" fill="#fff" fill-opacity=".9"/><text data-role="cartographic-label" pointer-events="none" x="${(b.x + 4).toFixed(1)}" y="${(b.y + b.h - 6).toFixed(1)}" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(p.text)}</text>`);
  }
  const overflow = diag.names_overflow.length ? (zh ? `未标注（地图上没有空位）：${diag.names_overflow.join("、")}` : `Not labelled on the map: ${diag.names_overflow.join(", ")}`) : "";
  return { parts, diag, overflow };
}
