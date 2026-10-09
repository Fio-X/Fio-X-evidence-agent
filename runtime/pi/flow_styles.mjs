// Default-off flow-map styles for cartographic_flow_map (abstract_od, desktop, with the flow_map_labels layer on).
//   NEWSROOM_FLOW_STYLE_CIRCLES=1  C: a circle at each origin, area proportional to that flow's own value, 1 px lines.
//   NEWSROOM_FLOW_STYLE_TRUNK=1    D: flows into one destination merge into a trunk; trunk width = sum of the branch widths.
// Neither switch set: viz.mjs does not call into this file, so output is byte-identical.
// The renderer computes no statistics: C prints only row values; D's trunk width is the one sum, declared in the legend.
export const flowStyleCirclesOn = () => process.env.NEWSROOM_FLOW_STYLE_CIRCLES === "1";
export const flowStyleTrunkOn = () => process.env.NEWSROOM_FLOW_STYLE_TRUNK === "1";
export const CIRCLE_MAX_R = 15;
// NEWSROOM_FLOW_TRUNK_MAX_W=12 (default unset = 14): picture-only knob for V568's open question (V528's cap is 12 px). Only the exact value 12 changes anything.
export const TRUNK_MAX_W = 14, TRUNK_MIN_W = 1.2, TRUNK_CLUSTER_DEG = 28, TRUNK_JUNCTION_FRAC = 0.3, TRUNK_MIN_JUNCTION = 24;

export const circleRadius = (value, max) => CIRCLE_MAX_R * Math.sqrt(Math.max(0, value) / Math.max(max, 1e-9));
// Circle-size legend: the largest, the middle and the smallest value actually present in the drawn rows (never rounded values).
export function circleLegendValues(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => b - a);
  if (!v.length) return [];
  return [...new Set([v[0], v[Math.floor((v.length - 1) / 2)], v[v.length - 1]])];
}
// Which style a map gets. `ends` has one entry per drawn flow identifying its destination (name and coordinates).
// D needs every flow to end at one place (at least two flows); otherwise it falls back to C when C is on, else to the default.
export function resolveFlowStyle(ends, { circles = flowStyleCirclesOn(), trunk = flowStyleTrunkOn() } = {}) {
  const one = ends.length >= 2 && new Set(ends).size === 1;
  if (trunk && one) return { style: "trunk", reason: null };
  if (trunk && !one) return circles ? { style: "circles", reason: "trunk needs one shared destination; fell back to circles" } : { style: "default", reason: "trunk needs one shared destination; circles off, default style" };
  if (circles) return { style: "circles", reason: null };
  return { style: "default", reason: null };
}

const ang = (p, o) => Math.atan2(p.y - o.y, p.x - o.x);
const angDiff = (x, y) => { let d = Math.abs(x - y) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d; };
// items: [{i, a, b, value}], every b the same point. Returns the one width scale, per-flow widths and branch curves, and the trunks.
// A branch is a quadratic arc from the origin to the junction that arrives along the trunk's direction (no kink at the junction).
export function planTrunk(items) {
  const B = items[0].b, lim = (TRUNK_CLUSTER_DEG * Math.PI) / 180;
  const sorted = items.map((it) => ({ ...it, th: ang(it.a, B), dist: Math.hypot(it.a.x - B.x, it.a.y - B.y) })).sort((p, q) => p.th - q.th);
  let clusters = [];
  for (const it of sorted) { const c = clusters.at(-1); if (c && angDiff(it.th, c[0].th) < lim) c.push(it); else clusters.push([it]); }
  if (clusters.length > 1 && angDiff(clusters[0][0].th, clusters.at(-1).at(-1).th) < lim) { clusters[0] = [...clusters.pop(), ...clusters[0]]; }
  const groups = clusters.map((c) => {
    if (c.length < 2) return { members: c, J: null };
    const ux = c.reduce((s, m) => s + Math.cos(m.th), 0), uy = c.reduce((s, m) => s + Math.sin(m.th), 0), ul = Math.hypot(ux, uy) || 1, u = { x: ux / ul, y: uy / ul };
    const mean = c.reduce((s, m) => s + m.dist, 0) / c.length, dJ = Math.min(TRUNK_JUNCTION_FRAC * mean, 0.8 * Math.min(...c.map((m) => m.dist)));
    if (dJ < TRUNK_MIN_JUNCTION) return { members: c, J: null };
    return { members: c, J: { x: B.x + u.x * dJ, y: B.y + u.y * dJ }, u };
  });
  const wOf = (s) => (v) => Math.max(TRUNK_MIN_W, v * s);
  const widest = (s) => { const w = wOf(s); return Math.max(...groups.map((g) => (g.J ? g.members.reduce((t, m) => t + w(m.value), 0) : Math.max(...g.members.map((m) => w(m.value)))))); };
  const cap = process.env.NEWSROOM_FLOW_TRUNK_MAX_W === "12" ? 12 : TRUNK_MAX_W;
  let lo = 0, hi = cap / Math.min(...items.map((it) => it.value)) + 1;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (widest(mid) <= cap) lo = mid; else hi = mid; }
  const scale = lo, widthOf = wOf(scale), byIndex = new Map(), trunks = [];
  for (const g of groups) {
    for (const m of g.members) {
      const w = widthOf(m.value);
      let branch = null;
      if (g.J) { const k = 0.45 * Math.hypot(m.a.x - g.J.x, m.a.y - g.J.y); branch = { a: m.a, control: { x: g.J.x + g.u.x * k, y: g.J.y + g.u.y * k }, b: g.J }; }
      byIndex.set(m.i, { w, branch });
    }
    if (g.J) trunks.push({ a: g.J, control: { x: (g.J.x + B.x) / 2, y: (g.J.y + B.y) / 2 }, b: B, sw: g.members.reduce((t, m) => t + widthOf(m.value), 0), members: g.members.map((m) => m.i) });
  }
  return { scale, widthOf, byIndex, trunks, B };
}
