// US composite projection for state maps (1012l): Albers equal-area conic for the lower 48 + DC, with Alaska and Hawaii
// each in their own Albers, drawn smaller (Alaska) / at true scale (Hawaii) and placed in boxes at the lower left - the
// standard layout of US state maps. Geometry stays lon/lat; the choice of piece is made per point:
//   Alaska  = lat >= 50 (no lower-48 point is that far north); lon > 0 (Aleutians west of 180) is unwrapped to lon - 360 so a
//             ring never jumps across the whole map;
//   Hawaii  = lon < -150 and lat < 30;
//   else lower 48 + DC.
// Raw units are Earth radii, y up. Pure functions only; nothing here reads a basemap.
const D2R = Math.PI / 180;

function albers(lon0, lat0, lat1, lat2) {
  const phi0 = lat0 * D2R, phi1 = lat1 * D2R, phi2 = lat2 * D2R;
  const n = (Math.sin(phi1) + Math.sin(phi2)) / 2;
  const c = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho0 = Math.sqrt(c - 2 * n * Math.sin(phi0)) / n;
  return (lon, lat) => {
    const rho = Math.sqrt(c - 2 * n * Math.sin(lat * D2R)) / n;
    const theta = n * (lon - lon0) * D2R;
    return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
  };
}

const L48 = albers(-96, 37.5, 29.5, 45.5);
const AK = albers(-154, 50, 55, 65);
const HI = albers(-157, 3, 8, 18);
export const US_ALASKA_SCALE = 0.35;
export const US_HAWAII_SCALE = 1.25;

export function usPiece(lon, lat) {
  if (lat >= 50) return "AK";
  if (lon < -150 && lat < 30) return "HI";
  return "L48";
}

function unwrap(lon) { return lon > 0 ? lon - 360 : lon; }

// Un-placed raw coordinates of each piece (before the boxes move Alaska and Hawaii).
function rawPiece(lon, lat) {
  const piece = usPiece(lon, lat);
  if (piece === "AK") { const [x, y] = AK(unwrap(lon), lat); return { piece, x: x * US_ALASKA_SCALE, y: y * US_ALASKA_SCALE }; }
  if (piece === "HI") { const [x, y] = HI(lon, lat); return { piece, x: x * US_HAWAII_SCALE, y: y * US_HAWAII_SCALE }; }
  const [x, y] = L48(lon, lat);
  return { piece, x, y };
}

let LAYOUT = null;
// Boxes are laid out once from the true extents of the three pieces' own outlines (given as the basemap's points), so
// they depend on the data actually drawn: the caller passes every ring point of the 51 states.
export function usLayout(points) {
  const ext = { L48: null, AK: null, HI: null };
  for (const [lon, lat] of points) {
    const p = rawPiece(lon, lat);
    const e = (ext[p.piece] ??= { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity });
    e.xmin = Math.min(e.xmin, p.x); e.xmax = Math.max(e.xmax, p.x); e.ymin = Math.min(e.ymin, p.y); e.ymax = Math.max(e.ymax, p.y);
  }
  const pad = 0.012, gap = 0.012;
  const l = ext.L48;
  const boxes = {};
  let left = l.xmin;
  const bottom = l.ymin - 0.045;
  for (const piece of ["AK", "HI"]) {
    const e = ext[piece];
    if (!e) continue;
    const w = e.xmax - e.xmin + 2 * pad, h = e.ymax - e.ymin + 2 * pad;
    boxes[piece] = { xmin: left, xmax: left + w, ymin: bottom, ymax: bottom + h, dx: left + pad - e.xmin, dy: bottom + pad - e.ymin };
    left += w + gap;
  }
  return { boxes, l48: l };
}

export function usForwardWith(layout) {
  return (lon, lat) => {
    const p = rawPiece(lon, lat);
    const b = layout.boxes[p.piece];
    return b ? [p.x + b.dx, p.y + b.dy] : [p.x, p.y];
  };
}

/** Fit to a pixel rect like fitAzimuthalProjection; `points` = every ring point of the states to be drawn. Includes the two boxes in the frame. */
export function fitUsProjection(points, left, right, top, bottom, paddingRatio = 0.04) {
  const layout = usLayout(points);
  const raw = usForwardWith(layout);
  const proj = (points ?? []).map(([lon, lat]) => raw(lon, lat)).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const xs = proj.map((p) => p[0]), ys = proj.map((p) => p[1]);
  for (const b of Object.values(layout.boxes)) { xs.push(b.xmin, b.xmax); ys.push(b.ymin, b.ymax); }
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const w = Math.max(1e-9, xmax - xmin), h = Math.max(1e-9, ymax - ymin);
  const pad = Math.max(0, Number(paddingRatio) || 0);
  const scale = Math.min(Math.max(1, right - left) / (w * (1 + 2 * pad)), Math.max(1, bottom - top) / (h * (1 + 2 * pad)));
  const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2, midX = (left + right) / 2, midY = (top + bottom) / 2;
  const toPx = (x, y) => ({ x: midX + (x - cx) * scale, y: midY - (y - cy) * scale });
  return {
    lon0: -96, lat0: 37.5, scale, us: true, layout,
    project(lon, lat) { const [x, y] = raw(lon, lat); return toPx(x, y); },
    boxes: Object.fromEntries(Object.entries(layout.boxes).map(([k, b]) => { const a = toPx(b.xmin, b.ymax), d = toPx(b.xmax, b.ymin); return [k, { x: a.x, y: a.y, w: d.x - a.x, h: d.y - a.y }]; })),
  };
}
