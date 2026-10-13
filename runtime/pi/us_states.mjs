// US state table helpers for chart_type tile_map (NEWSROOM_TILE_MAP=1). The table is runtime/pi/assets/us-state-names.json:
// 51 rows (50 states + DC), each with usps, fips, en, zh, tile_col (1..12), tile_row (1..8). A state is recognised by an exact
// USPS code or an exact English name; the Chinese name and the tile cell come only from the table, never from the model.
import { readFileSync } from "node:fs";

let cache = null;
function table() {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(new URL("./assets/us-state-names.json", import.meta.url), "utf8"));
  const states = raw.states;
  const byUsps = new Map(states.map((s) => [s.usps, s]));
  const byEn = new Map(states.map((s) => [s.en, s]));
  cache = { states, byUsps, byEn };
  return cache;
}

export const TILE_MAP_MIN_POINTS = 2;
// cell_mark "line" (default): a small line per state, 2..12 time points; "strip": a row of coloured value cells, 2..6.
export const TILE_MAP_MAX_POINTS = { line: 12, strip: 6 };
export const TILE_MAP_MAX_ROWS = 51 * TILE_MAP_MAX_POINTS.line;
export function tileMapMark(spec) {
  return spec?.cell_mark === "strip" ? "strip" : "line";
}

export function tileMapEnabled() {
  return process.env.NEWSROOM_TILE_MAP === "1";
}

export function usStates() {
  return table().states;
}

// The state a category value names, or null: exact USPS code or exact English name (no trimming, case folding or guessing).
export function resolveUsState(value) {
  if (typeof value !== "string") return null;
  const { byUsps, byEn } = table();
  return byUsps.get(value) ?? byEn.get(value) ?? null;
}

// Name printed on the tile: the table's Chinese name without its trailing 州 (the table's own spelling otherwise), or the
// USPS code on an English chart.
export function usStateShortName(state, language) {
  if (language === "zh") return state.zh.endsWith("州") ? state.zh.slice(0, -1) : state.zh;
  return state.usps;
}

// Time points in drawing order: all-numeric labels ascend, anything else keeps first-appearance order.
export function orderedPoints(rows, xField) {
  const seen = [];
  for (const row of rows) {
    const v = String(row[xField]);
    if (!seen.includes(v)) seen.push(v);
  }
  return seen.every((v) => /^-?\d+(\.\d+)?$/.test(v)) ? [...seen].sort((a, b) => Number(a) - Number(b)) : seen;
}

// Blockers for a tile_map spec over its rows: unknown states, a missing or duplicated (state, time point) row, a time-point
// count outside the mark's range, and (line mark) a colour column that is missing, non-numeric or not one value per state.
// Every one of the 51 table states must have a row for every time point.
export function lintTileMapRows(spec, rows) {
  const blockers = [];
  if (!Array.isArray(rows)) return blockers;
  const cat = spec.category_field, xf = spec.x_field;
  const shown = (values) => values.slice(0, 5).map((v) => `'${v}'`).join(", ") + (values.length > 5 ? `, … (${values.length} in all)` : "");
  const unknown = [];
  const seen = new Map();
  for (const row of rows) {
    const state = resolveUsState(row[cat]);
    if (!state) {
      if (!unknown.includes(String(row[cat]))) unknown.push(String(row[cat]));
      continue;
    }
    const key = `${state.usps}\u0000${String(row[xf])}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  if (unknown.length) blockers.push(`tile_map: ${shown(unknown)} in '${cat}' ${unknown.length === 1 ? "is" : "are"} not in the US state table (use the USPS code or the English state name; territories have no tile)`);
  const points = orderedPoints(rows, xf);
  const mark = tileMapMark(spec), maxPoints = TILE_MAP_MAX_POINTS[mark];
  if (points.length < TILE_MAP_MIN_POINTS || points.length > maxPoints) {
    blockers.push(`tile_map (cell_mark '${mark}') has ${points.length} time point(s) in '${xf}'; it draws ${TILE_MAP_MIN_POINTS} to ${maxPoints} (filter the query to fewer years or split the chart)`);
  }
  if (spec.cell_mark !== undefined && !["line", "strip"].includes(spec.cell_mark)) blockers.push("cell_mark must be 'line' or 'strip'");
  if (mark === "line") {
    const cf = spec.color_field;
    if (!cf) blockers.push("tile_map needs color_field: the column (from the query result) that sets each tile's background class and the number in its corner");
    else if (rows.length && !rows.some((r) => Object.prototype.hasOwnProperty.call(r, cf))) blockers.push(`Field '${cf}' (color_field) is absent from query output`);
    else {
      const perState = new Map();
      let bad = 0;
      for (const row of rows) {
        const state = resolveUsState(row[cat]);
        const v = row[cf] === null || row[cf] === undefined || row[cf] === "" ? NaN : Number(row[cf]);
        if (!Number.isFinite(v)) { bad += 1; continue; }
        if (!state) continue;
        if (!perState.has(state.usps)) perState.set(state.usps, v);
        else if (Math.abs(perState.get(state.usps) - v) > 1e-9) bad += 1;
      }
      if (bad) blockers.push(`tile_map: color_field '${cf}' must be one numeric value per state (the same on every row of that state); ${bad} row(s) are non-numeric or differ within a state`);
    }
    if (spec.color_breaks !== undefined) {
      const b = spec.color_breaks;
      if (!Array.isArray(b) || b.length !== 3 || b.some((v) => !Number.isFinite(Number(v))) || !(Number(b[0]) < Number(b[1]) && Number(b[1]) < Number(b[2]))) blockers.push("color_breaks must be three ascending numbers (four classes)");
    }
    if (spec.color_dark !== undefined && !["high", "low"].includes(spec.color_dark)) blockers.push("color_dark must be 'high' or 'low'");
    if (spec.provisional_values !== undefined) {
      const known = new Set(points);
      const off = (Array.isArray(spec.provisional_values) ? spec.provisional_values : []).map(String).filter((v) => !known.has(v));
      if (!Array.isArray(spec.provisional_values) || off.length) blockers.push(`provisional_values must list x_field values present in the rows${off.length ? ` (${shown(off)} are not)` : ""}`);
    }
  }
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([key]) => key.replace("\u0000", " / "));
  if (duplicated.length) blockers.push(`tile_map has more than one row for ${shown(duplicated)}; keep exactly one row per state and time point`);
  const missingStates = usStates().filter((s) => points.every((p) => !seen.has(`${s.usps}\u0000${p}`))).map((s) => s.usps);
  if (missingStates.length) blockers.push(`tile_map has no row for ${shown(missingStates)}; every state and DC needs one (51 states)`);
  const missingCells = [];
  for (const s of usStates()) {
    if (missingStates.includes(s.usps)) continue;
    for (const p of points) if (!seen.has(`${s.usps}\u0000${p}`)) missingCells.push(`${s.usps} / ${p}`);
  }
  if (missingCells.length) blockers.push(`tile_map is missing the row for ${shown(missingCells)}; every state needs a value for every time point`);
  return blockers;
}
