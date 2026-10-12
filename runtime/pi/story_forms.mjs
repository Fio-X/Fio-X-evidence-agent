import { PALETTE_FAMILIES } from "./palette_theme.mjs";
import { numberWordIn } from "./number_words.mjs";
// NEWSROOM_STORY_FORMS=1 (exact "1", default off): the story forms of the third-question page - a wave (multi_line with a filled
// area under one series, a dashed provisional tail and numbered notes), a person dot matrix and a clock. With the switch off none of
// the fields below is accepted and nothing here changes a rendered byte.
//
// Pure helpers, no imports: viz.mjs calls them for validation, lint and drawing; the render checks re-derive every drawn number
// from the rows with the same functions, so a hand-typed value cannot reach the picture.

export function storyFormsEnabled() {
  return process.env.NEWSROOM_STORY_FORMS === "1";
}

/** NEWSROOM_CHART_TEXT_WORDS=1 (exact "1", default off, ledger K245): the same number-word refusal of a chart's title, subtitle, alt and source line for every other chart type. */
export function chartTextWordsEnabled() {
  return process.env.NEWSROOM_CHART_TEXT_WORDS === "1";
}

const TRUE_WORDS = new Set(["1", "true", "t", "yes", "y", "是"]);
const FALSE_WORDS = new Set(["0", "false", "f", "no", "n", "否"]);

/** true / false for a flag cell (a SQL boolean column or 0/1), null for anything else, so lint can name the bad value. */
export function parseFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value ?? "").trim().toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return null;
}

/** The wave fields a spec carries (only these three; everything else is the ordinary multi_line spec). */
export const WAVE_FIELDS = ["area_series", "provisional_field", "numbered_notes"];

export function hasWaveFields(spec) {
  return WAVE_FIELDS.some((key) => spec?.[key] !== undefined);
}

/** Schema errors for the wave fields (shape only; the data rules are waveBlockers). */
export function waveFieldErrors(spec) {
  const errors = [];
  if (!hasWaveFields(spec)) return errors;
  if (!storyFormsEnabled()) {
    errors.push(`STORY_FORMS_DISABLED: ${WAVE_FIELDS.filter((key) => spec[key] !== undefined).join(", ")} (story forms) is switched off; draw the chart without it`);
    return errors;
  }
  const flagOnly = Object.keys(spec).filter((k) => WAVE_FIELDS.includes(k) && spec[k] !== undefined).every((k) => k === "provisional_field");
  if (spec.chart_type !== "multi_line" && !(flagOnly && (spec.chart_type === "people_dots" || spec.chart_type === "clock_dial"))) errors.push("area_series and numbered_notes are multi_line-only fields; provisional_field is for multi_line, people_dots and clock_dial");
  if (spec.area_series !== undefined && (typeof spec.area_series !== "string" || !spec.area_series.trim())) errors.push("area_series must be the name of one series");
  if (spec.provisional_field !== undefined && (typeof spec.provisional_field !== "string" || !spec.provisional_field.trim())) errors.push("provisional_field must be the name of a column");
  if (spec.numbered_notes !== undefined && typeof spec.numbered_notes !== "boolean") errors.push("numbered_notes must be true or false");
  return errors;
}

/**
 * Per series, the x values (as strings, in drawn order) whose row is flagged provisional. `order` is the drawn x order.
 * Returns { flagged: Map<series, Set<x>>, invalid: [..] } - invalid names cells that are neither true nor false.
 */
export function provisionalMap(spec, rows, order) {
  const flagged = new Map();
  const invalid = [];
  if (!spec?.provisional_field) return { flagged, invalid };
  const rank = new Map(order.map((x, i) => [String(x), i]));
  for (const row of rows) {
    const series = spec.series_field ? String(row[spec.series_field]) : "series";
    const flag = parseFlag(row[spec.provisional_field]);
    if (flag === null) { invalid.push(`${series} ${row[spec.x_field]}: ${JSON.stringify(row[spec.provisional_field])}`); continue; }
    if (!flagged.has(series)) flagged.set(series, new Set());
    if (flag) flagged.get(series).add(String(row[spec.x_field]));
  }
  // a flagged x must be in the drawn order, nothing else to do here
  for (const set of flagged.values()) for (const x of [...set]) if (!rank.has(x)) set.delete(x);
  return { flagged, invalid };
}

/** True when the subtitle or source line names provisional data ("暂定" / "provisional"). */
export const provisionalNoted = (spec) => (spec?.language === "en" ? /provisional/i : /暂定/).test(`${spec?.subtitle ?? ""} ${spec?.source_note ?? ""}`);
export const provisionalNoteMessage = (spec) => `the data has provisional years; the subtitle or source_note must say so (${spec?.language === "en" ? "'provisional'" : "'暂定'"})`;

/** people_dots / clock_dial: an optional provisional_field (a true/false column of the rows, computed in SQL) with the same rule as the wave. */
export function flagBlockers(spec, rows) {
  if (spec?.provisional_field === undefined || !Array.isArray(rows)) return [];
  const key = spec.provisional_field;
  if (typeof key !== "string" || !key.trim()) return ["provisional_field must be the name of a column"];
  if (!rows.length || !rows.every((r) => Object.prototype.hasOwnProperty.call(r, key))) return [`provisional_field '${key}' is not a column of every result row; compute it in the SQL (for example is_provisional)`];
  const flags = rows.map((r) => parseFlag(r[key]));
  if (flags.includes(null)) return [`provisional_field '${key}' must hold true/false (or 1/0)`];
  return flags.some(Boolean) && !provisionalNoted(spec) ? [provisionalNoteMessage(spec)] : [];
}

/** A number written as a word in a story chart's own text (title, subtitle, alt, source line) is a number no row backs; refused like a claim's. */
export function storyTextBlockers(spec) {
  const out = [];
  for (const field of ["title", "subtitle", "alt", "source_note"]) {
    // alt is the title plus the claim (inlineAltText in newsroom.ts): the title is checked on its own, so a word in it is not reported again as an alt error the model cannot fix.
    const text = typeof spec?.[field] === "string" ? (field === "alt" && typeof spec.title === "string" && spec.title && spec.alt.startsWith(spec.title) ? spec.alt.slice(spec.title.length) : spec[field]) : null;
    const near = text !== null ? numberWordIn(text) : null;
    if (near !== null) out.push(`${field} has a number word (near "${near}"); a number written in words is still a number no row backs. Say it without a number, or let the picture show it`);
  }
  return out;
}

/** Lint blockers for the wave fields against the rows. */
export function waveBlockers(spec, rows, order) {
  const blockers = [];
  if (!storyFormsEnabled() || !hasWaveFields(spec) || spec.chart_type !== "multi_line") return blockers;
  blockers.push(...storyTextBlockers(spec));
  const seriesNames = new Set(rows.map((r) => String(r[spec.series_field])));
  if (spec.area_series !== undefined && !seriesNames.has(String(spec.area_series))) {
    blockers.push(`area_series '${spec.area_series}' is not a value of series_field '${spec.series_field}' (${[...seriesNames].slice(0, 8).join(", ")})`);
  }
  if (spec.provisional_field !== undefined) {
    if (!rows.length || !rows.every((r) => Object.prototype.hasOwnProperty.call(r, spec.provisional_field))) {
      blockers.push(`provisional_field '${spec.provisional_field}' is not a column of every result row; compute it in the SQL (for example is_provisional)`);
    } else {
      const { flagged, invalid } = provisionalMap(spec, rows, order);
      if (invalid.length) blockers.push(`provisional_field '${spec.provisional_field}' must hold true/false (or 1/0); got ${invalid.slice(0, 3).join("; ")}`);
      else {
        const rank = new Map(order.map((x, i) => [String(x), i]));
        // provisional years must be named as such in the subtitle or the source line, never only by the dashed tail
        if ([...flagged.values()].some((set) => set.size) && !provisionalNoted(spec)) blockers.push(provisionalNoteMessage(spec));
        for (const [series, set] of flagged) {
          const mine = rows.filter((r) => String(r[spec.series_field]) === series).map((r) => String(r[spec.x_field])).sort((a, b) => rank.get(a) - rank.get(b));
          const firstFlag = mine.findIndex((x) => set.has(x));
          if (firstFlag >= 0 && !mine.slice(firstFlag).every((x) => set.has(x))) blockers.push(`provisional rows of '${series}' must be the last years in a row (a dashed tail); ${mine.slice(firstFlag).filter((x) => !set.has(x)).slice(0, 3).join(", ")} follows a provisional year but is not flagged`);
          if (firstFlag === 0) blockers.push(`every row of '${series}' is provisional; a dashed tail needs at least one settled year before it`);
        }
      }
    }
  }
  return blockers;
}

// ---- new chart types: person dot matrix (people_dots) and clock (clock_dial) -------------------------------------------------------
export const STORY_CHART_TYPES = ["people_dots", "clock_dial"];
/** Simplified-Chinese display names of the story chart types (tool text, reports); the SVG itself carries no chart-type name. */
export const STORY_CHART_ZH = { people_dots: "人点阵", clock_dial: "钟面" };
export const isStoryChart = (chartType) => STORY_CHART_TYPES.includes(chartType);
/** Fields of the two charts, so a stray one on another chart is refused with the other story fields. */
export const DOT_FIELDS = ["part_field", "per_dot_field", "part_label", "rest_label"];
export const CLOCK_FIELDS = ["minutes_field", "clock_span", "per_day_field"];
export const MAX_DAY_DOTS = 300;
/**
 * One colour, one meaning (user rule 10-12). coral = synthetic opioids only; slate (deep grey-blue) = "the places where it fell very
 * little"; pencil grey = one person. emphasis_tone picks the first two for the wave line and the dot-matrix part; it defaults to slate so
 * coral is never used unless the plan says the series is synthetic opioids. Clock dots and the rest-dots are always pencil grey.
 */
// colours come from the shared palette library (palette_theme.mjs), never hex written here
export const STORY_COLORS = { coral: PALETTE_FAMILIES.coral.ramp7[4], slate: PALETTE_FAMILIES.graphite.accent, pencil: PALETTE_FAMILIES.graphite.ramp7[4] };
export const TONES = ["coral", "slate"];
export const storyTone = (spec) => STORY_COLORS[TONES.includes(spec?.emphasis_tone) ? spec.emphasis_tone : "slate"];
/** emphasis_tone is allowed on multi_line (wave) and people_dots only. */
export function toneErrors(spec) {
  if (spec?.emphasis_tone === undefined) return [];
  if (!storyFormsEnabled()) return [`STORY_FORMS_DISABLED: emphasis_tone (story forms) is switched off; draw the chart without it`];
  const errors = [];
  if (!TONES.includes(spec.emphasis_tone)) errors.push("emphasis_tone must be 'coral' (synthetic opioids only) or 'slate' (the places where it fell very little)");
  if (spec.chart_type !== "multi_line" && spec.chart_type !== "people_dots") errors.push("emphasis_tone applies to multi_line (wave) and people_dots only");
  return errors;
}
export const MAX_DOTS = 600;
export const MAX_CLOCK_DOTS = 120;

const finite = (value) => { const x = typeof value === "string" && value.trim() === "" ? NaN : Number(value); return Number.isFinite(x) ? x : null; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const cell = (row, field) => finite(row?.[field]);

/** Whole numbers with thousands separators; other numbers to at most `dp` decimals without trailing zeros. Used by the drawing and the checks alike. */
export function plainNum(value, dp = 2) {
  const x = Number(value);
  if (!Number.isFinite(x)) return String(value);
  const text = Number.isInteger(x) ? String(x) : x.toFixed(dp).replace(/\.?0+$/, "");
  const [int, frac] = text.split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
}

/** Schema errors for the story chart types and their fields. */
export function storyChartErrors(spec) {
  const errors = [];
  const isDots = spec?.chart_type === "people_dots", isClock = spec?.chart_type === "clock_dial";
  const dotKeys = DOT_FIELDS.filter((key) => spec?.[key] !== undefined), clockKeys = CLOCK_FIELDS.filter((key) => spec?.[key] !== undefined);
  if (!storyFormsEnabled()) {
    // the chart type itself is already refused as "Unsupported chart_type" while the switch is off, so that message stays the only one
    if (!isDots && !isClock && (dotKeys.length || clockKeys.length)) errors.push(`STORY_FORMS_DISABLED: ${[...dotKeys, ...clockKeys].join(", ")} (story forms) is switched off; draw the chart without it`);
    return errors;
  }
  if (!isDots && dotKeys.length) errors.push(`${dotKeys.join(", ")} apply to chart_type people_dots only`);
  if (!isClock && clockKeys.length) errors.push(`${clockKeys.join(", ")} apply to chart_type clock_dial only`);
  const text = (key) => typeof spec[key] === "string" && spec[key].trim() !== "";
  if (isDots) {
    for (const key of ["value_field", "part_field", "per_dot_field"]) if (!text(key)) errors.push(`people_dots requires ${key} (a column of the query output)`);
    for (const key of ["part_label", "rest_label"]) if (!text(key)) errors.push(`people_dots requires ${key} (the legend name of that colour)`);
    const fields = ["value_field", "part_field", "per_dot_field"].map((key) => spec[key]);
    if (new Set(fields).size !== fields.length) errors.push("people_dots: value_field, part_field and per_dot_field must be three different columns");
  }
  if (isClock) {
    if (!text("category_field")) errors.push("clock_dial requires category_field (one clock per row, the name under it)");
    if (spec.clock_span !== undefined && spec.clock_span !== "hour" && spec.clock_span !== "day") errors.push("clock_span must be 'hour' (default) or 'day'");
    if (spec.clock_span === "day") {
      if (!text("per_day_field")) errors.push("clock_dial with clock_span 'day' requires per_day_field (a column holding the people per day, computed in SQL as the annual total divided by the days of the year)");
      if (spec.minutes_field !== undefined) errors.push("clock_dial with clock_span 'day' takes per_day_field, not minutes_field");
      if (text("category_field") && text("per_day_field") && spec.category_field === spec.per_day_field) errors.push("clock_dial: category_field and per_day_field must be different columns");
    } else {
      if (spec.per_day_field !== undefined) errors.push("per_day_field applies to clock_span 'day' only");
      if (!text("minutes_field")) errors.push("clock_dial requires minutes_field (a column holding the minutes per person, computed in SQL)");
      if (text("category_field") && text("minutes_field") && spec.category_field === spec.minutes_field) errors.push("clock_dial: category_field and minutes_field must be different columns");
    }
  }
  return errors;
}

/** Data rules of the dot matrix; every blocker names the column. One row: the total, the part and the people per dot, all from SQL. */
export function dotBlockers(spec, rows) {
  const out = [...storyTextBlockers(spec), ...flagBlockers(spec, rows)];
  if (!Array.isArray(rows) || rows.length !== 1) return [`people_dots draws one row (total, part, people per dot); the query returned ${Array.isArray(rows) ? rows.length : 0}`];
  const row = rows[0];
  for (const key of ["value_field", "part_field", "per_dot_field"]) {
    if (!(spec[key] in row)) out.push(`Field '${spec[key]}' (${key}) is absent from query output`);
    else if (cell(row, spec[key]) === null) out.push(`people_dots: '${spec[key]}' (${key}) is not a number`);
  }
  if (out.length) return out;
  const total = cell(row, spec.value_field), part = cell(row, spec.part_field), per = cell(row, spec.per_dot_field);
  if (!(total > 0)) out.push(`people_dots: total '${spec.value_field}' must be above 0`);
  if (!(per > 0)) out.push(`people_dots: people per dot '${spec.per_dot_field}' must be above 0 (compute it in SQL)`);
  if (!(part >= 0 && part <= total)) out.push(`people_dots: part '${spec.part_field}' (${part}) must lie between 0 and the total (${total}); the two colours may not overlap`);
  if (!out.length) {
    const units = total / per;
    if (units < 2) out.push(`people_dots: ${plainNum(total)} people at ${plainNum(per)} per dot is ${plainNum(units)} dots; choose a smaller per-dot number so at least 2 dots are drawn`);
    if (units > MAX_DOTS) out.push(`people_dots: ${plainNum(total)} people at ${plainNum(per)} per dot is ${plainNum(units, 0)} dots; at most ${MAX_DOTS} can be drawn, raise the per-dot number`);
  }
  return out;
}

/**
 * The drawing plan of the dot matrix, from the row alone. Dot i covers the span [i, i+1] of "dots" (the last one only up to `units`);
 * the first `part/per` of the span is the part colour, the rest the rest colour, so the two never overlap and one boundary dot may be
 * split. Fractions are of one whole dot.
 */
export function dotPlan(spec, rows) {
  const row = rows[0];
  const total = cell(row, spec.value_field), part = cell(row, spec.part_field), per = cell(row, spec.per_dot_field);
  const units = total / per, partUnits = part / per;
  const drawn = Math.ceil(units - 1e-9);
  const dots = [];
  for (let i = 0; i < drawn; i++) {
    const hi = Math.min(i + 1, units);
    const accent = clamp01(Math.min(hi, partUnits) - i);
    const rest = clamp01(hi - Math.max(i, partUnits));
    dots.push({ accent, rest });
  }
  const whole = Math.floor(units + 1e-9);
  return { total, part, rest: total - part, per, units, partUnits, drawn, whole, frac: units - whole, remainder: total - whole * per, dots };
}

/** The algorithm sentence the renderer writes beside the dots; the checks expect exactly this text. */
export function dotAlgorithmText(spec, plan, lang = "zh") {
  const last = plan.frac > 1e-9 ? plan.frac : 0;
  if (lang === "en") {
    return `One dot = ${plainNum(plan.per)} people. ${plainNum(plan.total)} ÷ ${plainNum(plan.per)} = ${plainNum(plan.units)} dots, so ${plan.drawn} dots are drawn${last ? `; the last dot is filled ${plainNum(last * 100, 0)}% (the remainder of ${plainNum(plan.remainder)} people)` : ""}.`;
  }
  return `每个点代表 ${plainNum(plan.per)} 人。${plainNum(plan.total)} ÷ ${plainNum(plan.per)} = ${plainNum(plan.units)} 个点，共画 ${plan.drawn} 个${last ? `，最后一个点只画 ${plainNum(last * 100, 0)}%（余数 ${plainNum(plan.remainder)} 人）` : ""}。`;
}

/** Data rules of the clock: one big clock (the first row) and up to three smaller comparison clocks, each a name and minutes per person from SQL. */
export function clockBlockers(spec, rows) {
  const out = [...storyTextBlockers(spec), ...flagBlockers(spec, rows)];
  if (spec.clock_span === "day") return [...out, ...dayClockBlockers(spec, rows)];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4) return [`clock_dial draws 1 to 4 clocks (the first is the big one); the query returned ${Array.isArray(rows) ? rows.length : 0}`];
  const names = new Set();
  rows.forEach((row, i) => {
    for (const key of ["category_field", "minutes_field"]) if (!(spec[key] in row)) { if (i === 0) out.push(`Field '${spec[key]}' (${key}) is absent from query output`); }
    if (!(spec.category_field in row) || !(spec.minutes_field in row)) return;
    const name = String(row[spec.category_field] ?? "").trim(), minutes = cell(row, spec.minutes_field);
    if (!name) out.push(`clock_dial: row ${i + 1} has an empty '${spec.category_field}'`);
    else if (names.has(name)) out.push(`clock_dial: '${name}' appears twice; one clock per name`);
    names.add(name);
    if (minutes === null) out.push(`clock_dial: row ${i + 1} '${spec.minutes_field}' is not a number`);
    else if (!(minutes >= 60 / MAX_CLOCK_DOTS && minutes <= 60)) out.push(`clock_dial: '${name}' has ${plainNum(minutes)} minutes per person; it must lie between ${plainNum(60 / MAX_CLOCK_DOTS)} and 60 so that 1 to ${MAX_CLOCK_DOTS} dots fit on one circle`);
  });
  return out;
}

/**
 * The drawing plan of the clock, from the rows alone. One circle is 60 minutes (6 degrees a minute, 0 at 12 o'clock, clockwise).
 * Person k passes at minute k*N, so floor(60/N) dots sit at 6*k*N degrees; the sector is the first person's N minutes.
 */
export function clockPlan(spec, rows) {
  if (spec.clock_span === "day") return dayClockPlan(spec, rows);
  return rows.map((row, i) => {
    const minutes = cell(row, spec.minutes_field);
    const count = Math.floor(60 / minutes + 1e-9);
    return {
      name: String(row[spec.category_field]), big: i === 0, minutes,
      perHour: 60 / minutes, count, leftover: 60 - count * minutes, sectorDeg: minutes * 6,
      angles: Array.from({ length: count }, (_, k) => (k + 1) * minutes * 6),
    };
  });
}

/** The two lines under a clock, written by the renderer; the checks expect exactly this text. */
export const fixed1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
export function clockCaptionLines(plan, lang = "zh") {
  if (plan.day) return dayClockCaptionLines(plan, lang);
  return lang === "en"
    ? [`1 person every ${fixed1(plan.minutes)} min`, `${fixed1(plan.perHour)} an hour`]
    : [`每 ${fixed1(plan.minutes)} 分钟 1 人`, `每小时 ${fixed1(plan.perHour)} 人`];
}

// ---- clock, "one day" variant: a 24-hour dial, one grey dot per person, the dots spread evenly (not real times) ----------------------
/** The sentence every one-day clock carries, written by the renderer; the checks expect exactly this text. */
export const dayClockNote = (lang = "zh") => (lang === "en" ? "Dots are spread evenly; they are not real times of day." : "点均匀排开，不是真实时刻");
const DAY_NOTE_DEG = 45;

export function dayClockBlockers(spec, rows) {
  const out = [];
  if (!Array.isArray(rows) || rows.length !== 1) return [`clock_dial with clock_span 'day' draws one clock; the query returned ${Array.isArray(rows) ? rows.length : 0} rows`];
  const row = rows[0];
  for (const key of ["category_field", "per_day_field"]) if (!(spec[key] in row)) out.push(`Field '${spec[key]}' (${key}) is absent from query output`);
  if (out.length) return out;
  if (!String(row[spec.category_field] ?? "").trim()) out.push(`clock_dial: the '${spec.category_field}' name is empty`);
  const perDay = cell(row, spec.per_day_field);
  if (perDay === null) out.push(`clock_dial: '${spec.per_day_field}' is not a number`);
  else if (!(Math.round(perDay) >= 1 && Math.round(perDay) <= MAX_DAY_DOTS)) out.push(`clock_dial: ${plainNum(perDay)} people a day is ${plainNum(Math.round(perDay), 0)} dots after rounding; it must be 1 to ${MAX_DAY_DOTS} so the dots fit on one circle`);
  return out;
}

/** One clock; the people per day come from the row (SQL: annual total / days), the dot count is that rounded, spread at 360/n degrees. */
export function dayClockPlan(spec, rows) {
  const row = rows[0], perDay = cell(row, spec.per_day_field), count = Math.round(perDay);
  return [{ name: String(row[spec.category_field]), big: true, day: true, perDay, perHour: perDay / 24, count, sectorDeg: null, noteDeg: DAY_NOTE_DEG, angles: Array.from({ length: count }, (_, k) => (k * 360) / count) }];
}

export function dayClockCaptionLines(plan, lang = "zh") {
  return lang === "en"
    ? [`about ${plainNum(Math.round(plan.perDay), 0)} people a day`, `${plainNum(plan.count, 0)} dots drawn (rounded)`]
    : [`约 ${plainNum(Math.round(plan.perDay), 0)} 人`, `画 ${plainNum(plan.count, 0)} 个点（四舍五入）`];
}

// ---- stroke-style hook -------------------------------------------------------------------------------------------------------------
/**
 * The one place where the lines of the three story forms (wave lines, clock face, ticks and leaders; the dots have no strokes) get their stroke
 * attributes. Today it returns the house style, character for character. A later style (stencil, pencil) swaps this function's body, or
 * sets STORY_STROKE.style, without touching the renderers or the geometry that render QA checks. role names what is drawn
 * ("wave-line", "wave-tail", "clock-face", "clock-tick", "clock-leader"); spec carries stroke, width, and optionally cap,
 * join, dash. Only attributes are returned, never coordinates.
 */
export const STORY_STROKE = { style: "house" };
export function storyStrokeAttrs(role, { stroke, width, cap, join, dash } = {}) {
  return `stroke="${stroke}" stroke-width="${width}"${cap ? ` stroke-linecap="${cap}"` : ""}${join ? ` stroke-linejoin="${join}"` : ""}${dash ? ` stroke-dasharray="${dash}"` : ""}`;
}
