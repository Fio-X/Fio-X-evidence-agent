// NEWSROOM_DATA_NOTES=1 (exact "1", default off): the status flags a data source carries (estimated, provisional, break in series,
// different definition, forecast) become one plain Chinese line under the chart, written by the program from the file and never by the model.
// Pure: no imports besides number_words.mjs, no file access (newsroom.ts reads the data files and hands the text in).
//
//   flagCellsFromFile(ref, text)        -> { cells, dimensions, diagnostics }   every cell that holds a value, with its flag
//   composeDataNote(read, rows, opts)   -> { text, full, truncated, diagnostics } or null
//
// A cell is tied to a drawn row only when the row names the cell's period and every other multi-category dimension (by code or by label),
// or the plan's SQL sums that dimension away. A row that cannot be tied carries no flag: leaving a flag out is allowed, stating one about
// a number the chart does not draw is not. When only some drawn rows carry a flag the sentence names them; when only some of a row's
// cells do it says 含, never 为.
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

// ---- reading a source file ------------------------------------------------------------------------------------------------------------
// A cell is one number of the file: { code, period: {code, label}, dims: [{id, code, label}] }. `code` is its flag ("" when unflagged).
// `dims` holds only the dimensions with more than one category; `dimensions` lists their categories so a drawn row can be asked
// whether it names that dimension at all.

const PERIOD_DIMENSIONS = /^(?:time|time_period|timeperiod|year|period|date|年份|年度|时期|时间)$/i;
const MAX_CELLS = 1_000_000;

/** JSON-stat 2.0 (Eurostat): `status` keys a flat position to a code (object, array, or one string for every cell). */
export function flagCellsFromJsonStat(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return { cells: [], dimensions: [], diagnostics: [{ rule: "unreadable", message: "not JSON" }] }; }
  const none = (diagnostics = []) => ({ cells: [], dimensions: [], diagnostics });
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.id) || !Array.isArray(doc.size) || !doc.dimension || doc.status === undefined) return none();
  const ids = doc.id.map(String);
  const size = doc.size.map(Number);
  const total = size.reduce((a, b) => a * b, 1);
  if (!(total > 0) || ids.length !== size.length) return none([{ rule: "unreadable", message: "id and size do not agree" }]);
  if (total > MAX_CELLS) return none([{ rule: "too_large", message: "more cells than the reader takes" }]);
  const categories = ids.map((id, d) => {
    const category = doc.dimension?.[id]?.category ?? {};
    const index = category.index;
    const codes = Array.isArray(index) ? index.map(String) : index && typeof index === "object" ? Object.entries(index).sort((a, b) => a[1] - b[1]).map(([code]) => code) : [];
    return { id, codes, labels: category.label ?? {}, size: size[d] };
  });
  const periodDim = ids.findIndex((id) => PERIOD_DIMENSIONS.test(id) || (Array.isArray(doc.role?.time) && doc.role.time.includes(id)));
  if (periodDim < 0) return none([{ rule: "no_period", message: "no time dimension" }]);
  const flagAt = new Map();
  const status = doc.status;
  if (typeof status === "string") { for (let i = 0; i < total; i++) flagAt.set(i, status); }
  else if (Array.isArray(status)) status.forEach((code, i) => { if (typeof code === "string" && code !== "") flagAt.set(i, code); });
  else for (const [key, code] of Object.entries(status)) flagAt.set(Number(key), code);
  const values = doc.value;
  const hasValue = (i) => {
    const v = Array.isArray(values) ? values[i] : values?.[String(i)];
    return v !== null && v !== undefined && v !== "";
  };
  const dimensions = categories.flatMap((c, d) => (d === periodDim || c.size <= 1 ? [] : [{ id: c.id, categories: c.codes.map((code) => ({ code, label: clean(c.labels?.[code]) })) }]));
  const cells = [];
  for (let position = 0; position < total; position++) {
    if (!hasValue(position)) continue; // a missing value draws nothing, flagged or not
    let rest = position;
    const coordinates = new Array(ids.length);
    for (let d = ids.length - 1; d >= 0; d--) { coordinates[d] = rest % size[d]; rest = Math.floor(rest / size[d]); }
    const dims = coordinates.map((at, d) => {
      const code = categories[d].codes[at];
      return { id: categories[d].id, code: code ?? String(at), label: clean(categories[d].labels?.[code]) };
    });
    cells.push({ code: clean(flagAt.get(position)), period: dims[periodDim], dims: dims.filter((_, d) => d !== periodDim && categories[d].size > 1) });
  }
  return { cells, dimensions, diagnostics: [] };
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

/** CSV or TSV with a flag column: every row that holds a number; its flag is the column's value ("" when unflagged). */
export function flagCellsFromCsv(text) {
  const table = csvRows(text);
  const none = (diagnostics = []) => ({ cells: [], dimensions: [], diagnostics });
  if (table.length < 2) return none();
  const header = table[0].map(clean);
  const flagAt = header.findIndex((name) => FLAG_COLUMN.test(name));
  if (flagAt < 0) return none();
  const periodAt = header.findIndex((name) => PERIOD_COLUMN.test(name));
  if (periodAt < 0) return none([{ rule: "no_period", message: "flag column but no period column" }]);
  const raw = [];
  for (const row of table.slice(1)) {
    if (!row.some((value, at) => at !== flagAt && at !== periodAt && isNumberLike(value))) continue; // no number, nothing drawn
    raw.push(row);
  }
  const textual = header.map((name, at) => (at === flagAt || at === periodAt || !name ? false : raw.every((row) => !isNumberLike(row[at]))));
  const distinct = header.map((_, at) => new Set(raw.map((row) => clean(row[at])).filter(Boolean)));
  const dimColumns = header.flatMap((name, at) => (textual[at] && distinct[at].size > 1 ? [at] : []));
  const dimensions = dimColumns.map((at) => ({ id: header[at], categories: [...distinct[at]].map((code) => ({ code, label: "" })) }));
  const cells = raw.map((row) => ({
    code: clean(row[flagAt]),
    period: { id: header[periodAt], code: clean(row[periodAt]), label: "" },
    dims: dimColumns.filter((at) => clean(row[at]) !== "").map((at) => ({ id: header[at], code: clean(row[at]), label: "" })),
  }));
  return { cells, dimensions, diagnostics: [] };
}

/** The cells of one data file by its extension; other formats carry none this module reads. */
export function flagCellsFromFile(ref, text) {
  if (/\.json$/i.test(ref)) return flagCellsFromJsonStat(text);
  if (/\.(?:csv|tsv|txt)$/i.test(ref)) return flagCellsFromCsv(text);
  return { cells: [], dimensions: [], diagnostics: [] };
}

// ---- tying cells to the drawn rows ----------------------------------------------------------------------------------------------------

const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HAN = /\p{Script=Han}/u;

/**
 * For each drawn row, the cells it stands for and what flags they carry.
 *   - The row must name a cell's period (by code or label), and every dimension with more than one category it names must match
 *     the cell's own code or label.
 *   - A dimension the row does not name at all counts as summed away only when the plan's SQL aggregates (SUM/AVG/COUNT/MIN/MAX/GROUP BY)
 *     and does not mention any of that dimension's categories as a quoted literal (that would be a filter, not a sum); otherwise the row
 *     cannot be tied to its cells and carries no flag.
 * Result per row: { tied, period, letters: Map letter -> "all" | "some", unknown: [codes], name }.
 */
export function tieRows(read, rows, options = {}) {
  const cells = read?.cells ?? [];
  const dimensions = read?.dimensions ?? [];
  const sql = String(options.sql ?? "");
  const aggregated = /\b(?:sum|avg|count|min|max|group\s+by)\b/i.test(sql);
  const mentionedInSql = (dimension) => dimension.categories.some(({ code, label }) => [code, label].some((x) => x !== "" && new RegExp(`['"]${escapeRe(x)}['"]`, "i").test(sql)));
  const summable = new Map(dimensions.map((dimension) => [dimension.id, aggregated && !mentionedInSql(dimension)]));
  const out = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const values = Object.values(raw ?? {}).map(clean).filter(Boolean);
    const names = (dim) => values.some((value) => same(value, dim.code) || (dim.label !== "" && same(value, dim.label)));
    const namesDimension = new Map(dimensions.map((dimension) => [dimension.id, dimension.categories.some((category) => names(category))]));
    const matched = cells.filter((cell) => names(cell.period) && cell.dims.every((dim) => (namesDimension.get(dim.id) ? names(dim) : summable.get(dim.id) === true)));
    const periods = new Set(matched.map((cell) => clean(cell.period.label) || clean(cell.period.code)));
    const info = { tied: matched.length > 0 && periods.size === 1, period: [...periods][0] ?? null, letters: new Map(), unknown: [], row: raw };
    if (info.tied) {
      const carrying = new Map(); // letter -> number of matched cells carrying it
      for (const cell of matched) {
        if (!cell.code) continue;
        const letters = splitFlag(cell.code);
        if (!letters) { info.unknown.push(clean(cell.code)); continue; }
        for (const letter of letters) carrying.set(letter, (carrying.get(letter) ?? 0) + 1);
      }
      for (const [letter, count] of carrying) info.letters.set(letter, count === matched.length ? "all" : "some");
    }
    out.push(info);
  }
  return out;
}

// ---- the sentence ---------------------------------------------------------------------------------------------------------------------

const yearsText = (years) => `${years.join("、")} 年`;
const WORD = { e: "估计值", p: "初步数", f: "预测值" };
// whole-row wording ("为 …") and part-of-row wording ("数据含 …")
const isText = {
  e: (y) => `${y}为估计值`, p: (y) => `${y}为初步数`, f: (y) => `${y}为预测值`,
  b: (y) => `${y}起统计口径改变，前后不宜直接比较`, d: (y) => `${y}口径与其余不同`,
};
const hasText = {
  e: (y) => `${y}数据含估计值`, p: (y) => `${y}数据含初步数`, f: (y) => `${y}数据含预测值`,
  b: (y) => `${y}数据含统计口径改变的值`, d: (y) => `${y}数据含口径不同的值`,
};

/**
 * The note for a data file's flags as they bear on the drawn rows, in Chinese. `read` is a reader result (several files: concatenate
 * cells and dimensions), `rows` the rows the chart is drawn from. Options: sql, categoryField and display(column, value) (the chart's own
 * name mapping, chartNameDisplay(...).display), lineMax.
 *   - Every drawn row of a period carries the flag: "2024 年为估计值". Only some do: the rows are named with the chart's Chinese display
 *     names, "乍得、尼日尔 2024 年为估计值"; a row without a Chinese display name leaves the sentence out (the code is never a name).
 *   - A row built from several cells of which only some carry the flag: "2024 年数据含估计值" (never "为").
 * `text` is the line to print; over the line limit (counting the printed label) it is only DATA_NOTE_POINTER and `full` keeps the
 * sentence for the page foot. Null when nothing is left to say. `diagnostics` never reaches the page.
 */
export function composeDataNote(read, rows, options = {}) {
  const lineMax = options.lineMax ?? DATA_NOTE_LINE_MAX;
  const diagnostics = [];
  const tied = tieRows(read, rows, options);
  const unknown = new Map();
  for (const info of tied) for (const code of info.unknown) unknown.set(code, (unknown.get(code) ?? 0) + 1);
  for (const [code, count] of [...unknown].sort()) diagnostics.push({ rule: "unknown_code", code, count });
  const nameOf = (info) => {
    const value = options.categoryField ? clean(info.row?.[options.categoryField]) : "";
    if (!value) return null;
    const shown = clean(typeof options.display === "function" ? (options.display(options.categoryField, value) ?? value) : value);
    return HAN.test(shown) ? shown : null;
  };
  const untied = tied.filter((info) => !info.tied).length;
  const periods = [...new Set(tied.filter((info) => info.tied).map((info) => info.period))];
  // entries: letter|mode|subject -> { letter, whole, names, years }
  const entries = new Map();
  for (const period of periods) {
    const inPeriod = tied.filter((info) => info.tied && info.period === period);
    for (const letter of ORDER) {
      const flagged = inPeriod.filter((info) => info.letters.has(letter));
      if (!flagged.length) continue;
      const whole = flagged.every((info) => info.letters.get(letter) === "all");
      const allCarry = flagged.length === inPeriod.length && untied === 0 && periods.length >= 1;
      let names = null;
      if (!allCarry) {
        names = flagged.map(nameOf);
        if (names.some((name) => name === null)) { diagnostics.push({ rule: "no_display_name", period, letter }); continue; }
        names = [...new Set(names)];
      }
      const key = `${letter}|${whole}|${names ? names.join("、") : ""}`;
      if (!entries.has(key)) entries.set(key, { letter, whole, names, years: new Set() });
      entries.get(key).years.add(period);
    }
  }
  const sortedYears = (set) => [...set].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));
  const list = [...entries.values()].map((entry) => ({ ...entry, years: sortedYears(entry.years) }));
  const parts = [];
  const used = new Set();
  const subject = (entry) => (entry.names ? `${entry.names.join("、")} ` : "");
  for (const entry of list) {
    if (used.has(entry)) continue;
    used.add(entry);
    const years = yearsText(entry.years);
    if (entry.letter === "e") { // estimated + provisional for the same years and the same rows read as one clause
      const mate = list.find((other) => !used.has(other) && other.letter === "p" && other.whole === entry.whole && subject(other) === subject(entry) && other.years.join("|") === entry.years.join("|"));
      if (mate) { used.add(mate); parts.push(`${subject(entry)}${years}${entry.whole ? "为估计值、初步数" : "数据含估计值、初步数"}`); continue; }
    }
    parts.push(`${subject(entry)}${(entry.whole ? isText : hasText)[entry.letter](years)}`);
  }
  if (!parts.length) return diagnostics.length ? { text: null, full: null, truncated: false, diagnostics } : null;
  const full = parts.join("，");
  const worded = numberWordIn(full);
  if (worded !== null) return { text: null, full: null, truncated: false, diagnostics: [...diagnostics, { rule: "number_word", message: `refused near "${worded}"` }] };
  const fits = Array.from(DATA_NOTE_LABEL + full).length <= lineMax;
  return { text: fits ? full : DATA_NOTE_POINTER, full, truncated: !fits, diagnostics };
}
