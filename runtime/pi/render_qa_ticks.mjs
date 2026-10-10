// Tick and value-label read-back for bar charts (K198, K200, K202). Only runs behind
// NEWSROOM_QA_TICK_READBACK=1 (exact "1"); render_qa.mjs decides that, this module is pure.
//
// The rendered SVG carries its own claims (data attributes); this check re-derives every claim:
//   T1  an axis tick's text, read back through the suffix (万/亿/万亿, en k/m/bn) or the unit line's
//       data-scale, equals its data-tick-value to within half of the last displayed digit;
//   T2  the tick's position equals where its data-tick-value falls on the scale fitted from the bars;
//   V1  a value label's text, read the same way, equals its data-value;
//   V2  a value label's category key names a bar and carries that bar's data-value;
//   anchor  every bar's data-value equals the data row for the same category key.
// Covered chart types: horizontal_bar, mirrored_bar. Anything else is reported "uncovered", never passed.
// Written independently of scripts/verify_artifact.py and src/verify.rs (no shared code).

export const RENDER_QA_TICKS_VERSION = "tick-readback/1.0.0";
export const TICK_READBACK_COVERED = ["horizontal_bar", "mirrored_bar"];

// Tolerance for T2 / bar-length fit, in SVG user units. The renderer writes coordinates with a few
// decimals (error < 0.02), the narrowest tick spacing in a covered chart is ~80 units, so 1.0 is
// 50x the rounding noise and 1/80 of a single grid step: a tick moved by one grid misses by ~80x.
export const TICK_POSITION_TOLERANCE = 1.0;
// A label may be slid sideways to stay inside the frame; data-tick-x holds the true tick position.
const LABEL_SLIDE_MAX = 40;
const REL = 1e-9;

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

function attrsOf(tag) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return attrs;
}

function bodyText(body) {
  return body.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (e) => ENTITIES[e]).trim();
}

function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function collect(svg) {
  const out = { ticks: [], units: [], bars: [], labels: [] };
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = attrsOf(m[1]);
    const item = { attrs, text: bodyText(m[2]) };
    if (attrs["data-role"] === "axis-tick-label") out.ticks.push(item);
    else if (attrs["data-role"] === "axis-unit-line") out.units.push(item);
    else if (attrs["data-role"] === "value-label") out.labels.push(item);
  }
  for (const m of svg.matchAll(/<rect\b([^>]*?)\/?>/g)) {
    const attrs = attrsOf(m[1]);
    if (attrs["data-role"] === "data-bar") out.bars.push({ attrs });
  }
  return out;
}

// leading number + optional attached suffix; the unit after a space is ignored
function readShown(text) {
  const m = /^([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/.exec(text.trim());
  if (!m) return null;
  const mantissa = Number(`${m[1] ? "-" : ""}${m[2].replace(/,/g, "")}${m[3] ? "." + m[3] : ""}`);
  const rest = text.trim().slice(m[0].length);
  let suffix = null;
  if (rest.startsWith("万亿")) suffix = 1e12;
  else if (rest.startsWith("亿")) suffix = 1e8;
  else if (rest.startsWith("万")) suffix = 1e4;
  else {
    const en = /^(bn|m|k)(?![A-Za-z])/.exec(rest);
    if (en) suffix = { bn: 1e9, m: 1e6, k: 1e3 }[en[1]];
  }
  return { mantissa, decimals: m[3] ? m[3].length : 0, suffix };
}

// the multiplier a unit line's own words state (单位：万人 -> 1e4); no word -> 1
function unitLineWordScale(text) {
  if (text.includes("万亿")) return 1e12;
  if (text.includes("亿")) return 1e8;
  if (text.includes("万")) return 1e4;
  const en = /\b(thousands?|millions?|billions?|trillions?)\b/i.exec(text);
  if (en) return { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }[en[1].toLowerCase().replace(/s$/, "")];
  return 1;
}

function close(a, b, slack = 0) {
  return Math.abs(a - b) <= slack + REL * Math.max(1, Math.abs(a), Math.abs(b));
}

// value the text shows, and half a unit of its last displayed digit, both in data units
function shownValue(text, unitScale) {
  const shown = readShown(text);
  if (!shown) return null;
  const mult = shown.suffix ?? unitScale;
  return { value: shown.mantissa * mult, half: 0.5 * 10 ** -shown.decimals * mult };
}

function keyOf(category, series, period) {
  return JSON.stringify([String(category ?? ""), String(series ?? ""), String(period ?? "")]);
}

function keyFromAttrs(attrs) {
  if (attrs["data-category"] === undefined) return null;
  return keyOf(attrs["data-category"], attrs["data-series"], attrs["data-period"]);
}

/**
 * @param {string} svgText
 * @param {{chart_type: string, rows?: object[], category_field?: string, value_field?: string,
 *          series_field?: string, period_field?: string}} ctx
 * @returns {{status: "covered"|"uncovered", passed: boolean, failures: {rule: string, message: string}[]}}
 */
export function checkTickReadback(svgText, ctx) {
  const chartType = ctx?.chart_type;
  if (!TICK_READBACK_COVERED.includes(chartType)) {
    return { version: RENDER_QA_TICKS_VERSION, status: "uncovered", chart_type: chartType ?? null, passed: false, failures: [] };
  }
  const failures = [];
  const fail = (rule, message) => failures.push({ rule, message });
  const mirrored = chartType === "mirrored_bar";
  const { ticks, units, bars, labels } = collect(svgText);

  // unit line: its data-scale must equal what its own words say
  let unitScale = 1;
  if (units.length > 1) fail("unit_line", `${units.length} axis unit lines (expected at most 1)`);
  for (const unit of units.slice(0, 1)) {
    const scale = num(unit.attrs["data-scale"]);
    if (scale === null || scale <= 0) fail("unit_line", `axis unit line '${unit.text}' has no readable positive data-scale`);
    else if (!close(scale, unitLineWordScale(unit.text))) fail("unit_line", `axis unit line '${unit.text}' says scale ${unitLineWordScale(unit.text)} but data-scale is ${scale}`);
    else unitScale = scale;
  }

  // bars
  const barByKey = new Map();
  const barGeo = [];
  if (bars.length === 0) fail("bar_attrs", "the chart has no data-bar to read back against");
  for (const { attrs } of bars) {
    const key = keyFromAttrs(attrs);
    const value = num(attrs["data-value"]);
    const x = num(attrs.x);
    const width = num(attrs.width);
    if (key === null) { fail("bar_attrs", "a data-bar has no data-category"); continue; }
    const name = JSON.parse(key).filter(Boolean).join(" / ");
    if (value === null) { fail("bar_attrs", `bar ${name} has no readable data-value`); continue; }
    if (x === null || width === null) { fail("bar_attrs", `bar ${name} has no numeric x/width`); continue; }
    const side = attrs["data-side"];
    if (mirrored && side !== "left" && side !== "right") { fail("bar_attrs", `bar ${name} has no data-side left/right`); continue; }
    if (barByKey.has(key)) { fail("bar_attrs", `bar ${name} appears twice`); continue; }
    barByKey.set(key, value);
    barGeo.push({ name, value, x, width, side });
  }

  // data anchor: bars against the data rows, same key set, same values
  const rows = ctx.rows;
  if (!Array.isArray(rows) || !ctx.category_field || !ctx.value_field) {
    fail("data_anchor", "no data rows or field names to anchor the bars to");
  } else {
    const rowByKey = new Map();
    for (const row of rows) {
      const key = keyOf(row?.[ctx.category_field], ctx.series_field ? row?.[ctx.series_field] : "", ctx.period_field ? row?.[ctx.period_field] : "");
      const value = num(row?.[ctx.value_field]);
      if (value === null) { fail("data_anchor", `data row ${key} has no numeric ${ctx.value_field}`); continue; }
      if (rowByKey.has(key)) { fail("data_anchor", `data row key ${key} is not unique`); continue; }
      rowByKey.set(key, value);
    }
    for (const [key, value] of barByKey) {
      if (!rowByKey.has(key)) fail("data_anchor", `bar ${key} has no data row`);
      else if (!close(value, rowByKey.get(key))) fail("data_anchor", `bar ${key} data-value ${value} differs from its data row ${rowByKey.get(key)}`);
    }
    for (const key of rowByKey.keys()) if (!barByKey.has(key)) fail("data_anchor", `data row ${key} has no bar`);
  }

  // bar length fit: width = k * |value|, one k for the whole chart; origins agree per side
  let k = null;
  const origin = {};
  const usable = barGeo.filter((b) => b.value !== 0);
  if (usable.length === 0) fail("tick_position", "no non-zero bar to fit the scale from");
  else {
    const ref = usable.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
    k = ref.width / Math.abs(ref.value);
    for (const bar of barGeo) {
      if (Math.abs(bar.width - k * Math.abs(bar.value)) > TICK_POSITION_TOLERANCE) fail("tick_position", `bar ${bar.name} is ${bar.width} wide but its data-value ${bar.value} implies ${(k * Math.abs(bar.value)).toFixed(2)}`);
      const zero = mirrored ? (bar.side === "left" ? bar.x + bar.width : bar.x) : (bar.value < 0 ? bar.x + bar.width : bar.x);
      const side = mirrored ? bar.side : "bar";
      if (bar.value === 0 && !mirrored) continue;
      if (origin[side] === undefined) origin[side] = zero;
      else if (Math.abs(origin[side] - zero) > TICK_POSITION_TOLERANCE) fail("tick_position", `bar ${bar.name} starts at ${zero}, the others at ${origin[side]}`);
    }
  }

  // ticks
  if (ticks.length === 0) fail("tick_attrs", "the chart has no axis-tick-label to read back");
  for (const tick of ticks) {
    const a = tick.attrs;
    const tv = num(a["data-tick-value"]);
    if (tv === null) { fail("tick_attrs", `tick '${tick.text}' has no readable data-tick-value`); continue; }
    const shown = shownValue(tick.text, unitScale);
    if (shown === null) { fail("tick_text", `tick '${tick.text}' has no readable number`); continue; }
    if (Math.abs(shown.value - tv) > shown.half * (1 + REL) + REL * Math.abs(tv)) fail("tick_text", `tick '${tick.text}' reads ${shown.value} but data-tick-value is ${tv}`);
    const x = num(a.x);
    const tickX = a["data-tick-x"] === undefined ? x : num(a["data-tick-x"]);
    if (x === null || tickX === null) { fail("tick_position", `tick '${tick.text}' has no numeric position`); continue; }
    if (Math.abs(x - tickX) > LABEL_SLIDE_MAX) fail("tick_position", `tick '${tick.text}' text sits ${Math.abs(x - tickX).toFixed(1)} from its tick`);
    const side = a["data-side"];
    if (mirrored && side !== "left" && side !== "right") { fail("tick_attrs", `tick '${tick.text}' has no data-side left/right`); continue; }
    const zero = origin[mirrored ? side : "bar"];
    if (k === null || zero === undefined) { fail("tick_position", `tick '${tick.text}' position cannot be computed (no bar scale)`); continue; }
    const expected = mirrored && side === "left" ? zero - k * tv : zero + k * tv;
    if (Math.abs(tickX - expected) > TICK_POSITION_TOLERANCE) fail("tick_position", `tick '${tick.text}' is at ${tickX} but its data-tick-value ${tv} belongs at ${expected.toFixed(2)}`);
  }

  // value labels (K200 / K202)
  for (const label of labels) {
    const a = label.attrs;
    const key = keyFromAttrs(a);
    const value = num(a["data-value"]);
    if (key === null) { fail("value_label_attrs", `value label '${label.text}' has no data-category`); continue; }
    if (value === null) { fail("value_label_attrs", `value label '${label.text}' has no readable data-value`); continue; }
    const shown = shownValue(label.text, unitScale);
    if (shown === null) fail("value_label_text", `value label '${label.text}' has no readable number`);
    else if (Math.abs(shown.value - value) > shown.half * (1 + REL) + REL * Math.abs(value)) fail("value_label_text", `value label '${label.text}' reads ${shown.value} but data-value is ${value}`);
    if (!barByKey.has(key)) fail("value_label_key", `value label '${label.text}' names ${key}, which is not a bar`);
    else if (!close(value, barByKey.get(key))) fail("value_label_key", `value label '${label.text}' carries ${value} but its bar ${key} is ${barByKey.get(key)}`);
  }

  return { version: RENDER_QA_TICKS_VERSION, status: "covered", chart_type: chartType, passed: failures.length === 0, failures };
}
