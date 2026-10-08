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

export function layoutFlowMapLabels(ctx) {
  const { spec, routes, bounds, esc, textUnits, fmtSpec, PALETTE, FONT_SANS, zh } = ctx;
  const style = spec.flow_map_labels, font = 12.5;
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

  if (style === "ledger") {
    const placedDiscs = [];
    const discFree = (c) => {
      if (c.x - BADGE_R < bounds.left + 2 || c.x + BADGE_R > bounds.right - 2 || c.y - BADGE_R < bounds.top + 2 || c.y + BADGE_R > bounds.bottom - 2) return false;
      if (arcs.some((arc) => arc.pts.some((p) => Math.hypot(p.x - c.x, p.y - c.y) <= arc.hw + STROKE_PAD + BADGE_R + 1))) return false;
      if (dots.some((d) => Math.hypot(d.x - c.x, d.y - c.y) <= d.r + BADGE_R + 2)) return false;
      return !placedDiscs.some((q) => Math.hypot(q.x - c.x, q.y - c.y) <= BADGE_R * 2 + 3);
    };
    const order = arcs.map((arc, i) => ({ arc, i })).sort((p, q) => q.arc.value - p.arc.value);
    const rank = new Map(order.map((o, k) => [o.i, k + 1]));
    for (const { arc, i } of order) {
      const side = arc.hw + STROKE_PAD + BADGE_R + 3;
      const cands = [];
      for (const p of arc.pts) {
        if (p.t < 0.02 || p.t > 0.98) continue;
        const j = Math.min(arc.pts.indexOf(p) + 1, arc.pts.length - 1), k = Math.max(arc.pts.indexOf(p) - 1, 0);
        const dx = arc.pts[j].x - arc.pts[k].x, dy = arc.pts[j].y - arc.pts[k].y, len = Math.hypot(dx, dy) || 1;
        for (const sgn of [1, -1]) cands.push({ x: p.x + (-dy / len) * side * sgn, y: p.y + (dx / len) * side * sgn, score: Math.min(p.t, 1 - p.t) + (p.t > 0.5 ? 0.05 : 0) });
      }
      cands.sort((p, q) => p.score - q.score);
      const hit = cands.find(discFree);
      if (hit) { placedDiscs.push(hit); arc.badge = { x: hit.x, y: hit.y, n: rank.get(i) }; diag.badges_placed++; }
      else diag.badges_unplaced.push(rank.get(i));
    }
    for (const arc of arcs) if (arc.badge) {
      parts.push(`<circle data-role="annotation-marker" cx="${arc.badge.x.toFixed(1)}" cy="${arc.badge.y.toFixed(1)}" r="${BADGE_R}" fill="#ffffff" stroke="${arc.highlight ? PALETTE.accent : PALETTE.ink}" stroke-width="${arc.highlight ? 2 : 1.2}"/>`);
      parts.push(`<text data-role="annotation-marker-label" x="${arc.badge.x.toFixed(1)}" y="${(arc.badge.y + 4.2).toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="${PALETTE.ink}">${arc.badge.n}</text>`);
    }
    // Ranked ledger panel to the right of the map.
    const px = LEDGER_PANEL_X, pr = 980, panelW = pr - px - 26;
    parts.push(`<text x="${px}" y="${bounds.top + 12}" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${zh ? "按数值从大到小" : "Ranked by value"}</text>`);
    let y = bounds.top + 34, shown = 0;
    for (const { arc, i } of order) {
      const label = `${arc.sourceName}→${arc.targetName}`, val = fmtSpec(spec, arc.value, spec.unit);
      const lw = textUnits(label) * font * 0.56, vw = textUnits(val) * font * 0.56;
      const two = lw + vw + 10 > panelW, h = two ? 40 : 24;
      if (y + h > bounds.bottom + 10) break;
      const n = rank.get(i), cy = y + 2;
      parts.push(`<circle data-role="annotation-marker" cx="${px + 9}" cy="${cy + 4}" r="${BADGE_R}" fill="#ffffff" stroke="${arc.highlight ? PALETTE.accent : PALETTE.ink}" stroke-width="${arc.highlight ? 2 : 1.2}"/><text data-role="annotation-marker-label" x="${px + 9}" y="${cy + 8.2}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="700" fill="${PALETTE.ink}">${n}</text>`);
      if (two) {
        parts.push(`<text x="${px + 26}" y="${cy + 8}" font-family="${FONT_SANS}" font-size="${font}" font-weight="${arc.highlight ? 800 : 600}" fill="${PALETTE.ink}">${esc(label)}</text><text x="${px + 26}" y="${cy + 24}" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.ink}">${esc(val)}</text>`);
      } else {
        parts.push(`<text x="${px + 26}" y="${cy + 8}" font-family="${FONT_SANS}" font-size="${font}" font-weight="${arc.highlight ? 800 : 600}" fill="${PALETTE.ink}">${esc(label)}</text><text x="${pr}" y="${cy + 8}" text-anchor="end" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.ink}">${esc(val)}</text>`);
      }
      y += h; shown++;
    }
    diag.ledger_rows = shown; diag.ledger_cut = order.length - shown;
    if (diag.ledger_cut > 0) parts.push(`<text x="${px}" y="${y + 12}" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.ink}">${zh ? `其余 ${diag.ledger_cut} 条未列出` : `${diag.ledger_cut} more not listed`}</text>`);
    return { parts, diag, overflow: "" };
  }

  // style "leader": names beside the dots, short leaders into free space, no truncation.
  const nodes = new Map();
  for (const arc of arcs) {
    for (const [role, p, name] of [["s", arc.a, arc.sourceName], ["t", arc.b, arc.targetName]]) {
      const key = `${name}`;
      const node = nodes.get(key) ?? { name, x: p.x, y: p.y, weight: 0, src: 0, tgt: 0, srcValue: 0 };
      node.weight += arc.value; if (role === "s") { node.src++; node.srcValue = arc.value; } else node.tgt++;
      nodes.set(key, node);
    }
  }
  const placed = [], list = [...nodes.values()].sort((p, q) => q.weight - p.weight);
  const dirs = [[1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]];
  for (const node of list) {
    const text = node.src === 1 && node.tgt === 0 ? `${node.name} ${fmtSpec(spec, node.srcValue, "")}` : node.name;
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
