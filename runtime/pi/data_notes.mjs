// NEWSROOM_DATA_NOTES=1 (exact "1", default off): the status flags a data source carries (estimated, provisional, break in series,
// different definition, forecast) become one plain Chinese line under the chart, written by the program from the file and never by the model.
// Pure: no imports besides number_words.mjs, no file access (newsroom.ts reads the data files and hands the text in).
//
//   flagCellsFromJsonStat(text)   / flagCellsFromCsv(text)   -> { cells, diagnostics }   flagged cells that hold a value
//   drawnFlagCells(cells, rows)                              -> the flagged cells some drawn row can be tied to
//   composeDataNote(drawn, { lineMax })                      -> { text, full, truncated, diagnostics } or null
//
// A flagged cell is tied to a drawn row only when the row names the cell's period AND every other dimension that has more than one
// category (by code or by label). A row that lacks one of them cannot be tied, so no note is written: leaving a flag out is allowed,
// stating one about a number the chart does not draw is not.
import { numberWordIn } from "./number_words.mjs";

export const DATA_NOTE_LINE_MAX = 40; // the whole drawn line, label included (research R6)
export const DATA_NOTE_LABEL = "注："; // what viz.mjs prints before the note (VIZ_STRINGS.zh.note)
export const DATA_NOTE_POINTER = "详见数据说明";

// The reviewed word table. A code outside it is never translated: it is left out of the note and listed in the diagnostics.
// Source: Eurostat flag list (e estimated, p provisional, b break in time series, d definition differs, f forecast).
export const FLAG_CODES = Object.freeze({ e: "estimated", p: "provisional", b: "break", d: "definition", f: "forecast" });
// Multi-letter codes are split only when named here (a combination the source publishes); every letter must be in FLAG_CODES.
export const FLAG_COMBOS = Object.freeze({ ep: ["e", "p"], bp: ["b", "p"], bd: ["b", "d"], dp: ["d", "p"] });

const ORDER = ["e", "p", "f", "b", "d"];
const clean = (value) => String(value ?? "").trim();
const isNumberLike = (value) => /^[-+]?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?%?$/i.test(clean(value));

/** The letters a flag stands for, or null when the code is not in the reviewed table. Case does not matter. */
export function splitFlag(code) {
  const raw = clean(code).toLowerCase();
  if (!raw) return null;
  if (raw.length === 1) return FLAG_CODES[raw] ? [raw] : null;
  return FLAG_COMBOS[raw] ?? null;
}

// ---- reading the flags out of a source file -----------------------------------------------------------------------------------------

const PERIOD_DIMENSIONS = /^(?:time|time_period|timeperiod|year|period|date|年份|年度|时期|时间)$/i;

/** JSON-stat 2.0 (Eurostat): `status` keys a flat position to a code (object, array, or one string for every cell). */
export function flagCellsFromJsonStat(text) {
  const diagnostics = [];
  let doc;
  try { doc = JSON.parse(text); } catch { return { cells: [], diagnostics: [{ rule: "unreadable", message: "not JSON" }] }; }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.id) || !Array.isArray(doc.size) || !doc.dimension || doc.status === undefined) return { cells: [], diagnostics };
  const ids = doc.id.map(String);
  const size = doc.size.map(Number);
  const total = size.reduce((a, b) => a * b, 1);
  if (!(total > 0) || ids.length !== size.length) return { cells: [], diagnostics: [{ rule: "unreadable", message: "id and size do not agree" }] };
  const categories = ids.map((id, d) => {
    const category = doc.dimension?.[id]?.category ?? {};
    const index = category.index;
    const codes = Array.isArray(index) ? index.map(String) : index && typeof index === "object" ? Object.entries(index).sort((a, b) => a[1] - b[1]).map(([code]) => code) : [];
    return { id, codes, labels: category.label ?? {}, size: size[d] };
  });
  const periodDim = ids.findIndex((id) => PERIOD_DIMENSIONS.test(id) || (Array.isArray(doc.role?.time) && doc.role.time.includes(id)));
  if (periodDim < 0) return { cells: [], diagnostics: [{ rule: "no_period", message: "no time dimension" }] };
  const positionsOf = (status) => {
    if (typeof status === "string") return Array.from({ length: total }, (_, i) => [i, status]);
    if (Array.isArray(status)) return status.map((code, i) => [i, code]).filter(([, code]) => typeof code === "string" && code !== "");
    return Object.entries(status).map(([key, code]) => [Number(key), code]);
  };
  const values = doc.value;
  const hasValue = (i) => {
    const v = Array.isArray(values) ? values[i] : values?.[String(i)];
    return v !== null && v !== undefined && v !== "";
  };
  const cells = [];
  for (const [position, code] of positionsOf(doc.status)) {
    if (!Number.isInteger(position) || position < 0 || position >= total || !hasValue(position)) continue; // a flag on a missing value draws nothing
    let rest = position;
    const coordinates = new Array(ids.length);
    for (let d = ids.length - 1; d >= 0; d--) { coordinates[d] = rest % size[d]; rest = Math.floor(rest / size[d]); }
    const dims = coordinates.map((at, d) => {
      const code2 = categories[d].codes[at];
      return { id: categories[d].id, size: categories[d].size, code: code2 ?? String(at), label: clean(categories[d].labels?.[code2]) };
    });
    cells.push({ code: clean(code), period: dims[periodDim], dims: dims.filter((_, d) => d !== periodDim && dims[d].size > 1) });
  }
  return { cells, diagnostics };
}

const FLAG_COLUMN = /^(?:obs_?)?(?:flags?|status)$|^(?:flag|status)_?(?:code)?$|^标[记志]$/i;
const PERIOD_COLUMN = /^(?:year|period|time|time_period|date|年份|年度|时期|时间|年)$/i;

function csvRows(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const source = String(text).replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === "\t") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && source[i + 1] === "\n") i++; row.push(field); field = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** CSV or TSV with a flag column: the rows whose flag is set and that hold a number. */
export function flagCellsFromCsv(text) {
  const table = csvRows(text);
  if (table.length < 2) return { cells: [], diagnostics: [] };
  const header = table[0].map(clean);
  const flagAt = header.findIndex((name) => FLAG_COLUMN.test(name));
  if (flagAt < 0) return { cells: [], diagnostics: [] };
  const periodAt = header.findIndex((name) => PERIOD_COLUMN.test(name));
  if (periodAt < 0) return { cells: [], diagnostics: [{ rule: "no_period", message: "flag column but no period column" }] };
  const cells = [];
  for (const row of table.slice(1)) {
    const code = clean(row[flagAt]);
    if (!code) continue;
    const numeric = row.some((value, at) => at !== flagAt && at !== periodAt && isNumberLike(value));
    if (!numeric) continue; // a flag on an empty row draws nothing
    const dims = header.flatMap((name, at) => (at === flagAt || at === periodAt || !name || !clean(row[at]) || isNumberLike(row[at]) ? [] : [{ id: name, size: 2, code: clean(row[at]), label: "" }]));
    cells.push({ code, period: { id: header[periodAt], size: 2, code: clean(row[periodAt]), label: "" }, dims });
  }
  return { cells, diagnostics: [] };
}

// ---- tying flagged cells to what is drawn ---------------------------------------------------------------------------------------------

const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

/** The flagged cells at least one drawn row names completely (period and every multi-category dimension). */
export function drawnFlagCells(cells, rows) {
  const rowValues = (Array.isArray(rows) ? rows : []).map((row) => Object.values(row ?? {}).map(clean).filter(Boolean));
  const names = (values, dim) => values.some((value) => same(value, dim.code) || (dim.label !== "" && same(value, dim.label)));
  return cells.filter((cell) => rowValues.some((values) => names(values, cell.period) && cell.dims.every((dim) => names(values, dim))));
}

// ---- the sentence ---------------------------------------------------------------------------------------------------------------------

const yearsText = (years) => `${years.join("、")} 年`;
const sentenceFor = {
  e: (y) => `${y}为估计值`,
  p: (y) => `${y}为初步数`,
  f: (y) => `${y}为预测值`,
  b: (y) => `${y}起统计口径改变，前后不宜直接比较`,
  d: (y) => `${y}口径与其余不同`,
};

/**
 * The note for the drawn flagged cells, in Chinese. Years are the period labels of those cells, as the file spells them.
 * `text` is the line to print; when the sentence would not fit one line (DATA_NOTE_LINE_MAX counting the printed label), `text` is only
 * DATA_NOTE_POINTER and `full` carries the sentence for the data-notes block of the page foot. Null when nothing is left to say.
 * `diagnostics` lists the codes the table does not know and anything the number-word check refused; none of it reaches the page.
 */
export function composeDataNote(drawn, options = {}) {
  const lineMax = options.lineMax ?? DATA_NOTE_LINE_MAX;
  const diagnostics = [];
  const periods = new Map(); // letter -> Set of period labels
  const unknown = new Map();
  for (const cell of drawn) {
    const letters = splitFlag(cell.code);
    if (!letters) { unknown.set(clean(cell.code), (unknown.get(clean(cell.code)) ?? 0) + 1); continue; }
    const label = clean(cell.period.label) || clean(cell.period.code);
    for (const letter of letters) {
      if (!periods.has(letter)) periods.set(letter, new Set());
      periods.get(letter).add(label);
    }
  }
  for (const [code, count] of [...unknown].sort()) diagnostics.push({ rule: "unknown_code", code, count });
  const sortedYears = (set) => [...set].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const parts = [];
  const ep = periods.get("e") && periods.get("p") && sortedYears(periods.get("e")).join("|") === sortedYears(periods.get("p")).join("|");
  for (const letter of ORDER) {
    if (!periods.has(letter)) continue;
    const years = yearsText(sortedYears(periods.get(letter)));
    if (ep && letter === "p") continue;
    parts.push(ep && letter === "e" ? `${years}为估计值、初步数` : sentenceFor[letter](years));
  }
  if (!parts.length) return diagnostics.length ? { text: null, full: null, truncated: false, diagnostics } : null;
  const full = parts.join("，");
  const worded = numberWordIn(full);
  if (worded !== null) return { text: null, full: null, truncated: false, diagnostics: [...diagnostics, { rule: "number_word", message: `refused near "${worded}"` }] };
  const fits = Array.from(DATA_NOTE_LABEL + full).length <= lineMax;
  return { text: fits ? full : DATA_NOTE_POINTER, full, truncated: !fits, diagnostics };
}

/** The flag cells of one data file by its extension; other formats carry none this module reads. */
export function flagCellsFromFile(ref, text) {
  if (/\.json$/i.test(ref)) return flagCellsFromJsonStat(text);
  if (/\.(?:csv|tsv|txt)$/i.test(ref)) return flagCellsFromCsv(text);
  return { cells: [], diagnostics: [] };
}
