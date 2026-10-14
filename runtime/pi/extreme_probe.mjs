// K117 stage 1: a report-only probe for "one value sits far away from all the others" (NEWSROOM_EXTREME_PROBE=1, default off).
//
// What it does: after a chart has been rendered, it looks at the rows the renderer drew and, for every value set it can
// identify, computes for the high end and the low end separately
//     D = (distance from the end value to the nearest other value) / (span of the other values)
// and writes the result, with a drafted candidate note, to runtime/extreme-probe/extreme_probe-<key>.json (an agent-group folder,
// written by extreme_probe_writer.mjs so the group-boundary report counts it as the owning group's write, not 待查 or cross-group). Nothing else changes: no tool
// result, no manifest, no page, no hash, no rejection. The threshold D >= 1 is only a CANDIDATE (EXTREME_PROBE_CANDIDATE_D);
// it was fixed after looking at the first topics and is to be calibrated on topics that were not used for it.
//
// Value sets (what "the drawn set" means): the rows handed to the renderer, i.e. after SQL aggregation / top-N / joins /
// grouping. Invalid values (null, empty, non-numeric, NaN, Infinity) are dropped first. One set per
//   - single-measure charts (category_field + value_field): per series_field / facet_field / reference_period_field group;
//   - dumbbell: ONE set with both endpoints merged (20 values for 10 pairs); n counts pairs;
//   - scatter: one set for x_field and one for y_field; a log axis is judged in log10 space (zero / negative values are left
//     to the existing log-axis gate and are not used here);
//   - line / multi_line / small_multiples / slope (x_field + value_field): the last x value across series (one object per
//     series / facet), because a time series is not a set of independent objects.
// Every other chart type gets one record with status "unsupported_chart" so the calibration can see what was not covered.
//
// Independence: n counts objects, not cells. An object is identified by the category (and, for facets, series) key; the
// same object listed twice with the same value counts once, with different values the set is "ambiguous_object" and no D
// is given. At least EXTREME_PROBE_MIN_OBJECTS objects are needed.
//
// Statuses: ok | tie (the nearest other value is equal: D = 0, never fires) | degenerate (the other values span 0: D is
// null, no epsilon, no Infinity) | too_few_objects | ambiguous_object | unsupported_chart.
// Both ends far: each end is computed with the other end kept among "the others"; both are reported and flagged
// `both_ends_far`, a known limitation (they inflate each other).
//
// K117 stage 2 (fe order 1010h). Two additions, both default off / record-only:
//  (a) PAIR D, written into every high/low record next to the single-value D (which is unchanged). Rule, fixed before the eight calibration
//      topics were re-run: the group is the end value together with the value next to it (the second from that end); the others are the
//      remaining n - 2 values (at least 2 of them); pair_d = (distance from the group's inner member to the nearest other value) /
//      (span of the other values). Same statuses and the same candidate threshold (D >= 1) as the single value. It exists for two far values
//      side by side, each of which hides the other as "nearest neighbour".
//  (b) NEWSROOM_EXTREME_NOTE=1: when a record fires (single D or pair D), the program adds one candidate sentence to the chart's note line
//      ("far above / below the rest of the data"), from the rows the chart is drawn from. See extremeNoteText.
import { performance } from "node:perf_hooks";
import { numberWordIn } from "./number_words.mjs";
import { chartNameDisplay, fmtSpec } from "./viz.mjs";
import { shadowKey } from "./shadow.mjs";
import { EXTREME_PROBE_FOLDER, writeExtremeProbeRecord } from "./extreme_probe_writer.mjs";

const SCHEMA_VERSION = "0.1.0";

export const EXTREME_PROBE_MIN_OBJECTS = 6;
export const EXTREME_PROBE_CANDIDATE_D = 1;

export function extremeProbeEnabled(env = process.env) {
  return String(env?.NEWSROOM_EXTREME_PROBE ?? "") === "1";
}

function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

const keyOf = (row, fields) => fields.filter(Boolean).map((f) => String(row?.[f] ?? "")).join("␟");
const labelOf = (row, fields) => fields.filter(Boolean).map((f) => String(row?.[f] ?? "")).join(" · ");

/**
 * Turn `entries` ([{ object, label, values: number[] }]) into the sorted value list and the object count.
 * Returns { values, n, ambiguous }.
 */
function collect(entries) {
  const byObject = new Map();
  for (const entry of entries) {
    const known = byObject.get(entry.object);
    if (!known) byObject.set(entry.object, { label: entry.label, values: [...entry.values] });
    else if (entry.values.length !== known.values.length || entry.values.some((v, i) => v !== known.values[i])) known.ambiguous = true;
  }
  const objects = [...byObject.values()];
  return { objects, n: objects.length, ambiguous: objects.some((o) => o.ambiguous) };
}

/**
 * D for one end of a value list. `points` = [{ object, label, value }] (one point per drawn value, dumbbell pairs give two).
 * The end point's own value is removed; the other values (including the other endpoint of the same pair) are "the others".
 */
export function endDistance(points, end) {
  const sorted = [...points].sort((a, b) => a.value - b.value || String(a.object).localeCompare(String(b.object), "en-US"));
  const extreme = end === "high" ? sorted[sorted.length - 1] : sorted[0];
  const rest = end === "high" ? sorted.slice(0, -1) : sorted.slice(1);
  if (!extreme || rest.length === 0) return { status: "too_few_objects", d: null, extreme, rest_min: null, rest_max: null };
  const restMin = rest[0].value;
  const restMax = rest[rest.length - 1].value;
  const nearest = end === "high" ? restMax : restMin;
  const gap = Math.abs(extreme.value - nearest);
  const span = restMax - restMin;
  if (gap === 0) return { status: "tie", d: 0, gap, extreme, rest_min: restMin, rest_max: restMax };
  if (span === 0) return { status: "degenerate", d: null, gap, extreme, rest_min: restMin, rest_max: restMax };
  return { status: "ok", d: gap / span, gap, extreme, rest_min: restMin, rest_max: restMax };
}

/**
 * Pair D for one end (rule in the header). `points` as for endDistance. The group is the extreme and the next point inward; the
 * others are everything else. Returns { status, d, gap, members, rest_min, rest_max }.
 */
export function pairDistance(points, end) {
  const sorted = [...points].sort((a, b) => a.value - b.value || String(a.object).localeCompare(String(b.object), "en-US"));
  const ordered = end === "high" ? [...sorted].reverse() : sorted;
  const members = ordered.slice(0, 2);
  const rest = ordered.slice(2);
  if (members.length < 2 || rest.length < 2) return { status: "too_few_objects", d: null, members, rest_min: null, rest_max: null };
  const values = rest.map((r) => r.value);
  const restMin = Math.min(...values);
  const restMax = Math.max(...values);
  const inner = members[1].value;
  const gap = Math.abs(inner - (end === "high" ? restMax : restMin));
  const span = restMax - restMin;
  if (gap === 0) return { status: "tie", d: 0, gap, members, rest_min: restMin, rest_max: restMax };
  if (span === 0) return { status: "degenerate", d: null, gap, members, rest_min: restMin, rest_max: restMax };
  return { status: "ok", d: gap / span, gap, members, rest_min: restMin, rest_max: restMax };
}

/**
 * Probe one value set. `set` = { metric, period, entries, log }, entries = [{ object, label, values }].
 * Returns up to two records (high, low).
 */
export function probeValueSet(spec, set) {
  const base = { metric: set.metric, period: set.period ?? null };
  const { n, ambiguous } = collect(set.entries);
  const record = (end, fields) => ({ ...base, end, n, ...fields });
  if (ambiguous) return ["high", "low"].map((end) => record(end, { object: null, d: null, status: "ambiguous_object" }));
  if (n < EXTREME_PROBE_MIN_OBJECTS) return ["high", "low"].map((end) => record(end, { object: null, d: null, status: "too_few_objects" }));
  const points = [];
  const seen = new Set();
  for (const entry of set.entries) {
    if (seen.has(entry.object)) continue;
    seen.add(entry.object);
    for (const value of entry.values) {
      const usable = set.log ? (value > 0 ? Math.log10(value) : null) : value;
      if (usable !== null) points.push({ object: entry.object, label: entry.label, value: usable, raw: value });
    }
  }
  const results = ["high", "low"].map((end) => ({ end, ...endDistance(points, end) }));
  // Both ends far: each end alone is judged with the other end among the others, so they inflate each other's span. When the
  // span of the middle (both extremes removed) would make both ends cross the candidate threshold, say so (a limitation).
  const middle = [...points].sort((a, b) => a.value - b.value).slice(1, -1);
  const middleSpan = middle.length ? middle[middle.length - 1].value - middle[0].value : 0;
  const withoutOther = (r) => (r.status === "ok" && middleSpan > 0 ? r.gap / middleSpan : null);
  const bothFar = results.every((r) => withoutOther(r) !== null && withoutOther(r) >= EXTREME_PROBE_CANDIDATE_D);
  return results.map((r) => {
    const extreme = r.extreme;
    const out = record(r.end, {
      object: extreme ? extreme.label : null,
      d: r.d === null ? null : Number(r.d.toFixed(6)),
      status: r.status,
    });
    if (extreme) {
      const rawOf = (v) => (set.log ? 10 ** v : v);
      out.value = extreme.raw;
      out.rest_min = rawOf(r.rest_min);
      out.rest_max = rawOf(r.rest_max);
      out.candidate_trigger = r.status === "ok" && r.d >= EXTREME_PROBE_CANDIDATE_D;
      if (set.log) out.log_space = true;
      if (withoutOther(r) !== null) out.d_without_other_end = Number(withoutOther(r).toFixed(6));
      if (bothFar) out.limitation = "both_ends_far";
      if (r.status === "ok") out.candidate_notes = candidateNotes(spec, out);
      const pair = pairDistance(points, r.end);
      const rawOf2 = (v) => (set.log ? 10 ** v : v);
      out.pair_status = pair.status;
      out.pair_d = pair.d === null ? null : Number(pair.d.toFixed(6));
      out.pair_members = pair.members.map((m) => m.label);
      if (pair.members.length === 2) out.pair_values = pair.members.map((m) => m.raw);
      if (pair.status !== "too_few_objects") { out.pair_rest_min = rawOf2(pair.rest_min); out.pair_rest_max = rawOf2(pair.rest_max); }
      out.pair_candidate_trigger = pair.status === "ok" && pair.d >= EXTREME_PROBE_CANDIDATE_D;
    }
    return out;
  });
}

/**
 * Three wordings, kept apart (source original value / display-rounded / computed). Only "far from the other data",
 * never "error" or "abnormal", no cause. X is the real min / max of the drawn other objects of the same metric and period.
 */
export function candidateNotes(spec, rec) {
  const raw = (v) => `${String(Number(v.toPrecision(15)))}${spec?.unit === "%" ? "%" : spec?.unit ? ` ${spec.unit}` : ""}`;
  const shown = (v) => fmtSpec(spec, v);
  const high = rec.end === "high";
  const word = high ? "远高于" : "远低于";
  const bound = high ? "其余都不超过" : "其余都不低于";
  const x = high ? rec.rest_max : rec.rest_min;
  const text = (f) => `${rec.object} ${f(rec.value)}，${word}其余数据（${bound} ${f(x)}）`;
  return {
    source_value: text(raw),
    display_rounded: text(shown),
    computed: `根据……数据计算，${text(shown)}`,
  };
}

const SINGLE_MEASURE = new Set([
  "horizontal_bar", "dot", "diverging_bar", "choropleth", "strip_plot", "waffle", "treemap", "stacked_bar_100", "mirrored_bar",
]);
const TIME_SERIES = new Set(["line", "multi_line", "small_multiples", "slope"]);

/** Build the value sets of a chart; each set = { metric, period, entries, log }. Returns [] for an unsupported chart. */
export function valueSets(spec, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const type = spec?.chart_type;
  if (type === "dumbbell" && spec.start_field && spec.end_field) {
    const entries = [];
    for (const row of list) {
      const a = num(row?.[spec.start_field]);
      const b = num(row?.[spec.end_field]);
      const values = [a, b].filter((v) => v !== null);
      if (values.length) entries.push({ object: keyOf(row, [spec.category_field]), label: labelOf(row, [spec.category_field]), values });
    }
    return [{ metric: `${spec.start_field}+${spec.end_field}`, period: null, entries, log: false }];
  }
  if (type === "scatter" && spec.x_field && spec.y_field) {
    const idFields = [spec.label_field ?? spec.category_field];
    return [["x", spec.x_field, spec.x_scale], ["y", spec.y_field, spec.y_scale]].map(([, field, scale]) => {
      const entries = [];
      list.forEach((row, i) => {
        const v = num(row?.[field]);
        const id = idFields[0] ? keyOf(row, idFields) : `#${i}`;
        if (v !== null) entries.push({ object: id, label: idFields[0] ? labelOf(row, idFields) : `#${i}`, values: [v] });
      });
      return { metric: field, period: null, entries, log: scale === "log" };
    });
  }
  if (SINGLE_MEASURE.has(type) && spec.value_field && spec.category_field) {
    const groupFields = [spec.series_field, spec.facet_field, spec.reference_period_field].filter(Boolean);
    const groups = new Map();
    for (const row of list) {
      const v = num(row?.[spec.value_field]);
      if (v === null) continue;
      const g = keyOf(row, groupFields);
      if (!groups.has(g)) groups.set(g, { row, entries: [] });
      groups.get(g).entries.push({ object: keyOf(row, [spec.category_field]), label: labelOf(row, [spec.category_field]), values: [v] });
    }
    return [...groups.values()].map(({ row, entries }) => ({
      metric: spec.value_field + (spec.series_field && row?.[spec.series_field] !== undefined ? `[${row[spec.series_field]}]` : ""),
      period: spec.reference_period_field && row?.[spec.reference_period_field] !== undefined ? String(row[spec.reference_period_field]) : null,
      entries,
      log: false,
    }));
  }
  if (TIME_SERIES.has(type) && spec.x_field && spec.value_field) {
    const idFields = [spec.facet_field, spec.series_field, spec.category_field].filter(Boolean);
    const xs = list.filter((row) => num(row?.[spec.value_field]) !== null && row?.[spec.x_field] !== null && row?.[spec.x_field] !== undefined);
    if (!xs.length) return [];
    const sortable = (row) => { const v = row[spec.x_field]; const x = num(v); return x !== null ? x : String(v); };
    const last = xs.map(sortable).reduce((a, b) => (b > a ? b : a));
    const entries = xs.filter((row) => sortable(row) === last).map((row) => ({
      object: keyOf(row, idFields), label: labelOf(row, idFields), values: [num(row[spec.value_field])],
    }));
    return [{ metric: spec.value_field, period: String(last), entries, log: false }];
  }
  return [];
}

/** The pure probe: { chart_type, records: [...] }. Never throws on odd data; an unsupported chart gets one record. */
export function probeExtremes(spec, rows) {
  const sets = valueSets(spec, rows);
  const chart = spec?.chart_type ?? null;
  if (!sets.length) {
    return { chart_type: chart, records: [{ metric: null, period: null, object: null, end: null, d: null, n: 0, status: "unsupported_chart" }] };
  }
  return { chart_type: chart, records: sets.flatMap((set) => probeValueSet(spec, set)) };
}

export function extremeNoteEnabled(env = process.env) {
  return String(env?.NEWSROOM_EXTREME_NOTE ?? "") === "1";
}

// How the numbers in the note were obtained, from the chart's own SQL: "computed" when the query aggregates or does arithmetic (the number
// does not exist in the source as printed); otherwise "source" when the chart prints the value as it is, "rounded" when the chart's display
// rule rounds it. The wording differs: computed gets a "calculated from the data" lead, rounded says the display is rounded.
const COMPUTED_SQL = /\b(?:sum|avg|count|min|max|median|stddev|round|ln|log|exp)\s*\(|\bgroup\s+by\b|\bover\s*\(|[\w)"\]]\s*[*/]\s*[\w("]|[\w)"\]]\s+-\s+[\w("]/i;
const computedSql = (sql) => COMPUTED_SQL.test(String(sql ?? "").replace(/'(?:[^']|'')*'/g, "''").replace(/\bselect\s+(?:distinct\s+)?\*|[\w"]+\.\*|\(\s*\*\s*\)/gi, (m) => (m.startsWith("(") ? "(x)" : "select_all")));
const rawText = (spec, v) => `${String(Number(Number(v).toPrecision(15)))}${spec?.unit === "%" ? "%" : spec?.unit ? ` ${spec.unit}` : ""}`;

/**
 * The note for the chart caption, or null. Written only from a firing record (single D or pair D, status ok) of a chart with exactly one
 * value set (several series / facets / axes would need a per-set label, which is left out), a source note, and no number word in the text.
 * Wording is only "far above / below the rest of the data" with the bound of the rest; no cause, never "abnormal" or "error".
 * Numbers are the chart's own displayed values (fmtSpec); the model writes none of them.
 */
export function extremeNoteText(spec, rows) {
  if (String(spec?.source_note ?? "").trim().length < 3) return null;
  if (spec?.chart_type === "scatter") return null;
  const sets = valueSets(spec, rows);
  if (sets.length !== 1) return null;
  const records = probeValueSet(spec, sets[0]);
  const zh = String(spec?.language ?? "en") === "zh";
  const shown = (v) => fmtSpec(spec, v);
  let rounded = false;
  const show = (v) => { const t = shown(v); if (t !== rawText(spec, v)) rounded = true; return t; };
  // The reader sees the chart's own names (small-multiple titles, bar labels), never the data keys: the same table the renderer uses.
  // A zh chart whose name cannot be shown in CJK gets no sentence; a composite label (series · facet) is not mapped, so no sentence.
  let disp = null;
  try { disp = zh ? chartNameDisplay(spec, rows) : null; } catch { disp = null; }
  const nameOf = (label) => {
    if (!zh) return label;
    if (String(label).includes(" · ")) return null;
    let name = null;
    for (const field of disp?.fields ?? []) { name = disp.display(field, String(label)); if (name) break; }
    name = name ?? String(label);
    return /[\u3400-\u9fff]/.test(name) ? name : null;
  };
  let period = null;
  const sentences = [];
  for (const rec of records) {
    if (rec.end !== "high" && rec.end !== "low") continue;
    const high = rec.end === "high";
    const pairFires = rec.pair_candidate_trigger === true && rec.pair_status === "ok";
    const singleFires = rec.candidate_trigger === true && rec.status === "ok";
    if (!singleFires && !pairFires) continue;
    const names = singleFires ? [rec.object] : rec.pair_members;
    const values = singleFires ? [rec.value] : rec.pair_values;
    const bound = singleFires ? (high ? rec.rest_max : rec.rest_min) : (high ? rec.pair_rest_max : rec.pair_rest_min);
    if (names.some((n) => !n) || values.some((v) => !Number.isFinite(Number(v))) || !Number.isFinite(Number(bound))) continue;
    const shownNames = names.map(nameOf);
    if (shownNames.some((n) => !n)) continue;
    if (rec.period !== null && rec.period !== undefined) period = String(rec.period);
    const items = shownNames.map((n, i) => `${n} ${show(values[i])}`);
    sentences.push(zh
      ? `${items.join("、")}，${high ? "远高于" : "远低于"}其余数据（其余都${high ? "不超过" : "不低于"} ${show(bound)}）`
      : `${items.join(" and ")}, far ${high ? "above" : "below"} the rest of the data (all others ${high ? "no higher than" : "no lower than"} ${show(bound)})`);
  }
  if (!sentences.length) return null;
  const computed = computedSql(spec?.sql);
  // A chart drawn over several time points: the sentence is about the last one, and says so.
  const when = period === null ? "" : zh ? (/^\d{4}$/.test(period) ? `${period} 年，` : `${period}，`) : `${period}: `;
  let text = zh ? `${when}${sentences.join("；")}。` : `${when}${sentences.join("; ")}.`;
  if (computed) text = zh ? `按所给数据计算：${text}` : `Calculated from the data: ${text}`;
  else if (rounded) text += zh ? "数值按图上取整显示。" : " Values are rounded as on the chart.";
  return numberWordIn(text) ? null : text;
}

/** Run the probe and write runtime/extreme-probe/extreme_probe-<key>.json (once; an existing file is left alone). Returns { path }. */
export async function writeExtremeProbe({ root, spec, rows, planRef, dataHash }) {
  const started = performance.now();
  const probe = probeExtremes(spec, rows);
  const probeMs = Number((performance.now() - started).toFixed(3));
  const key = shadowKey({ kind: "extreme_probe", plan_ref: planRef, data_hash: dataHash });
  const path = await writeExtremeProbeRecord(root, `${EXTREME_PROBE_FOLDER}extreme_probe-${key}.json`, {
    schema_version: SCHEMA_VERSION,
    kind: "extreme_probe",
    key,
    chart: { plan_ref: planRef, chart_type: probe.chart_type, title: spec?.title ?? null },
    threshold_candidate: EXTREME_PROBE_CANDIDATE_D,
    min_objects: EXTREME_PROBE_MIN_OBJECTS,
    probe_ms: probeMs,
    records: probe.records,
  });
  return { path };
}
