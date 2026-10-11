// Shadow check B: do the numbers written in prose (hero_stat, text, pull_quote,
// annotation text, reference lines, titles, notes) appear in the cited claim's
// computation rows, or in a bounded set derived from them?
//
// Pure functions only; nothing here reads a file, the clock or the
// environment. The shadow use (shadow.mjs) is observational data for a side
// file and never produces a lint warning or blocker: the false positive rate
// is unknown until it has been measured on real runs. The one exception is the
// hero value gate: always on in the runtime (no switch turns it off), infographic.mjs reuses these pure matchers to block a hero_stat whose
// number is not in its own claim's rows. The pure lint itself stays opt-in.
//
// Rules fixed by the design:
// - compare at DISPLAY precision: the prose number "12.3" matches a candidate
//   that rounds to 12.3, "12" matches anything that rounds to 12;
// - scale words and percent are understood (12%, 3.4 million, 5亿, 12 pp);
// - skipped, never counted as unmatched: years, dates and times, ordinals,
//   citation numbers ([3], (3)), and numbers that are part of a proper name or
//   code (G20, COVID-19, 5G, Article 5, 第3章).

export const MAX_DERIVED_CANDIDATES = 20000;
const ALL_PAIRS_LIMIT = 30;
const ROW_PAIR_LIMIT = 200;

const SCALES = new Map([
  ["k", 1e3], ["thousand", 1e3], ["千", 1e3],
  ["m", 1e6], ["mn", 1e6], ["million", 1e6], ["百万", 1e6],
  ["b", 1e9], ["bn", 1e9], ["billion", 1e9],
  ["t", 1e12], ["tn", 1e12], ["trillion", 1e12], ["万亿", 1e12],
  ["万", 1e4], ["亿", 1e8],
]);
const PERCENT_WORDS = new Set(["%", "percent", "per cent", "pp", "percentage points", "percentage point", "percent points"]);
const NAME_LABELS = /(?:article|section|chapter|figure|fig\.?|table|phase|round|stage|tier|level|type|group|class|part|step|volume|vol\.?|no\.?|page|pages|p\.|pp\.|appendix|annex|rule|resolution|protocol|schedule)\s*$/i;

function isLetter(char) { return Boolean(char) && /\p{L}/u.test(char); }

// Mask spans that are dates and times so their digits are skipped as a whole.
const MASKS = [
  [/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "date"],
  [/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, "date"],
  [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "time"],
  [/\d{4}\s*[-–—]\s*\d{2,4}(?=\b)(?!\s*%)/g, "year_range"],
];

export function extractNumbers(input) {
  const text = String(input ?? "");
  const out = [];
  const masked = [];
  for (const [pattern, reason] of MASKS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!masked.some((span) => start < span.end && end > span.start)) masked.push({ start, end, reason, raw: match[0] });
    }
  }
  for (const span of masked) out.push({ raw: span.raw, index: span.start, skipped: span.reason });
  const inMask = (index) => masked.some((span) => index >= span.start && index < span.end);
  const pattern = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (inMask(start)) continue;
    const before = text.slice(0, start);
    const prev = before.slice(-1);
    const entry = { raw: match[0], index: start };
    const mark = (reason) => { out.push({ ...entry, skipped: reason }); };
    // A decimal point or digit group that continues from a previous token.
    if (prev === "." && /\d$/.test(before.slice(0, -1))) continue;
    // Glued to a preceding letter (G20, H5N1, Q3, FY24, A4) or "Covid-19" style.
    if (isLetter(prev) && !/[一-鿿]/u.test(prev)) { mark("name_or_code"); continue; }
    if (prev === "-" && /\p{Lu}[\p{L}]*-$/u.test(before.slice(-12))) { mark("name_or_code"); continue; }
    if (/第\s*$/u.test(before)) { mark("ordinal"); continue; }
    if (NAME_LABELS.test(before)) { mark("name_or_code"); continue; }
    if ((prev === "'" || prev === "’") && !match[2] && match[0].length === 2) { mark("year"); continue; }
    if ((prev === "[" && text[end] === "]") || (prev === "(" && text[end] === ")" && !match[2] && match[0].length <= 2)) { mark("citation"); continue; }
    const rest = text.slice(end);
    if (/^(?:st|nd|rd|th)\b/i.test(rest)) { mark("ordinal"); continue; }
    if (/^[月日号]/u.test(rest) || /^[章节条款页期届]/u.test(rest) && !match[2]) { mark(/^[月日号]/u.test(rest) ? "date" : "ordinal"); continue; }
    // Suffix: percent, scale word, or a glued letter that makes it a code.
    let percent = false;
    let scale = 1;
    let suffix = "";
    const suffixMatch = /^\s?(percentage points?|percent points?|per cent|percent|万亿|百万|million|billion|trillion|thousand|mn|bn|tn|pp|%|万|亿|千|[kKmMbBtT](?![\p{L}]))/iu.exec(rest);
    if (suffixMatch) {
      suffix = suffixMatch[1].toLowerCase();
      if (PERCENT_WORDS.has(suffix)) percent = true;
      else if (SCALES.has(suffix)) scale = SCALES.get(suffix);
      const consumed = suffixMatch[0].length;
      entry.suffix = suffixMatch[1];
      entry.end = end + consumed;
    } else if (isLetter(text[end]) && !/[一-鿿]/u.test(text[end])) {
      mark("name_or_code");
      continue;
    }
    const value = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = (match[2] ?? "").length ? match[2].length - 1 : 0;
    // A bare four digit integer in the calendar range is a year.
    if (!suffixMatch && !match[2] && !match[0].includes(",") && match[0].length === 4 && value >= 1000 && value <= 2100) { mark("year"); continue; }
    out.push({ ...entry, value, decimals, percent, scale });
  }
  return out.sort((a, b) => a.index - b.index);
}

const toNumber = (cell) => {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell === "bigint") return Number(cell);
  if (typeof cell !== "string") return null;
  const trimmed = cell.trim().replace(/,/g, "");
  if (!/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

// A column whose NAME states its unit ("fdi_2017_bn_usd", "revenue_million",
// "营收_亿元") also yields the value in base units, so prose that spells the
// amount out ("632亿") can match it, and prose that gets the scale wrong
// ("63亿" for 63.2 bn) cannot.
const COLUMN_UNIT_HINTS = [
  [/(?:^|[^a-z])(?:tn|trillion)(?:[^a-z]|$)|万亿/i, 1e12],
  [/(?:^|[^a-z])(?:bn|billion)(?:[^a-z]|$)/i, 1e9],
  [/(?:^|[^a-z])(?:mn|million)(?:[^a-z]|$)/i, 1e6],
  [/(?:^|[^a-z])thousand(?:[^a-z]|$)/i, 1e3],
  [/亿/, 1e8],
  [/万/, 1e4],
];
const columnUnitScale = (column) => COLUMN_UNIT_HINTS.find(([pattern]) => pattern.test(String(column)))?.[1] ?? 1;

// Candidate numbers: every numeric cell ("rows"), plus a bounded set of
// aggregates, differences, ratios and shares computed from them ("derived"),
// plus numbers the spec itself declares ("spec": reference_line values and the
// like). Derived ratios are stored as fractions; a percent in prose matches
// them times 100.
export function buildCandidates(rowSets, specValues = []) {
  const rows = [];
  const derived = [];
  const push = (list, value) => { if (Number.isFinite(value)) list.push(value); };
  const room = () => derived.length < MAX_DERIVED_CANDIDATES;
  for (const rowSet of Array.isArray(rowSets) ? rowSets : []) {
    const table = Array.isArray(rowSet) ? rowSet : [];
    if (!table.length) continue;
    push(derived, table.length);
    const columns = [...new Set(table.flatMap((row) => Object.keys(row ?? {})))];
    const numericColumns = [];
    const groupColumns = [];
    for (const column of columns) {
      const values = table.map((row) => toNumber(row?.[column]));
      const present = values.filter((value) => value !== null);
      for (const value of present) push(rows, value);
      const unitScale = columnUnitScale(column);
      if (unitScale !== 1) for (const value of present) push(rows, value * unitScale);
      if (present.length && present.length === table.filter((row) => row?.[column] !== null && row?.[column] !== undefined && row?.[column] !== "").length) numericColumns.push({ column, values });
      else if (table.some((row) => typeof row?.[column] === "string")) groupColumns.push(column);
      push(derived, new Set(table.map((row) => String(row?.[column]))).size);
    }
    for (const { values } of numericColumns) {
      const present = values.filter((value) => value !== null);
      if (!present.length) continue;
      const sum = present.reduce((a, b) => a + b, 0);
      const sorted = [...present].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      push(derived, sum); push(derived, sum / present.length); push(derived, present.length);
      push(derived, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
      push(derived, sorted[0]); push(derived, sorted.at(-1)); push(derived, sorted.at(-1) - sorted[0]);
      if (sorted[0] !== 0) push(derived, sorted.at(-1) / sorted[0]);
      if (sum !== 0) for (const value of present) { if (room()) push(derived, value / sum); }
      const pairs = present.length <= ALL_PAIRS_LIMIT
        ? present.flatMap((a, i) => present.slice(i + 1).map((b) => [a, b])).concat(present.flatMap((a, i) => present.slice(i + 1).map((b) => [b, a])))
        : present.slice(1).map((value, i) => [present[i], value]).concat([[present[0], present.at(-1)]]);
      for (const [a, b] of pairs) {
        if (!room()) break;
        push(derived, b - a); push(derived, Math.abs(b - a));
        if (a !== 0) { push(derived, b / a); push(derived, (b - a) / Math.abs(a)); }
      }
    }
    // Per group totals and shares over the first text column.
    for (const group of groupColumns.slice(0, 2)) {
      for (const { values } of numericColumns) {
        const totals = new Map();
        table.forEach((row, i) => { if (values[i] !== null) totals.set(String(row?.[group]), (totals.get(String(row?.[group])) ?? 0) + values[i]); });
        if (totals.size === table.length) continue;
        const grand = [...totals.values()].reduce((a, b) => a + b, 0);
        for (const total of totals.values()) { push(derived, total); if (grand !== 0) push(derived, total / grand); }
      }
    }
    if (table.length <= ROW_PAIR_LIMIT) {
      for (let i = 0; i < numericColumns.length; i += 1) for (let j = 0; j < numericColumns.length; j += 1) {
        if (i === j) continue;
        for (let r = 0; r < table.length && room(); r += 1) {
          const a = numericColumns[i].values[r]; const b = numericColumns[j].values[r];
          if (a === null || b === null) continue;
          push(derived, a - b);
          if (b !== 0) push(derived, a / b);
        }
      }
    }
  }
  const spec = (Array.isArray(specValues) ? specValues : []).map(toNumber).filter((value) => value !== null);
  return { rows, derived: derived.slice(0, MAX_DERIVED_CANDIDATES), spec };
}

const rounds = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(Math.abs(value) * factor + 1e-9) / factor;
};

function matches(entry, candidate) {
  const target = Math.abs(entry.value);
  const closeEnough = (shown) => Math.abs(rounds(shown, entry.decimals) - target) <= 1e-9 * Math.max(1, target);
  if (closeEnough(candidate / entry.scale)) return true;
  if (entry.percent && closeEnough(candidate * 100)) return true;
  return false;
}

/** Status of one extracted number: matched_rows, matched_derived, matched_spec or unmatched. */
export function matchNumber(entry, candidates) {
  // Order is the order of trust: the claim's own rows, what derives from them,
  // the chart's own rows (a subset or pivot of the claim's data), what derives
  // from those, and finally numbers the spec declares by itself.
  for (const [list, status] of [["rows", "matched_rows"], ["derived", "matched_derived"], ["chart_rows", "matched_chart_rows"], ["chart_derived", "matched_chart_derived"], ["spec", "matched_spec"]]) {
    if ((candidates[list] ?? []).some((candidate) => matches(entry, candidate))) return status;
  }
  return "unmatched";
}

/**
 * One prose field against a candidate set. Returns one record per number found
 * (skipped ones carry the reason). `has_candidates` is false when the cited
 * claim exposes no rows at all, so "unmatched" there means "nothing to compare".
 */
export function checkField(field, text, candidates) {
  const hasCandidates = ["rows", "derived", "chart_rows", "chart_derived", "spec"].some((list) => (candidates[list] ?? []).length > 0);
  return extractNumbers(text).map((entry) => ({
    field,
    raw: entry.raw + (entry.suffix ? ` ${entry.suffix}`.replace(/^ (?=[%万亿千])/u, "") : ""),
    offset: entry.index,
    status: entry.skipped ? "skipped" : hasCandidates ? matchNumber(entry, candidates) : "no_candidates",
    ...(entry.skipped ? { skipped_reason: entry.skipped } : {}),
  }));
}

export function summarizeChecks(records) {
  const counts = { numbers: 0, matched_rows: 0, matched_derived: 0, matched_chart_rows: 0, matched_chart_derived: 0, matched_spec: 0, unmatched: 0, no_candidates: 0, skipped: 0 };
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    if (record.status !== "skipped") counts.numbers += 1;
  }
  return counts;
}
