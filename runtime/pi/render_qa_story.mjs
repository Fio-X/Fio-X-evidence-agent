// NEWSROOM_STORY_FORMS=1 render checks. Each check re-derives what must be on the page from the rows (and the spec's field names)
// and compares it with what the SVG actually draws; nothing is read from a number the renderer wrote only as text.
// Run only when the caller passes options.story_form = { spec, rows } (render_qa.mjs), so a render without it is unchanged.
import { provisionalMap, storyFormsEnabled, plainNum, dotAlgorithmText, clockCaptionLines, dayClockNote, dayClockPlan, STORY_COLORS, storyTone } from "./story_forms.mjs";
import { recolor, specRenderAccent } from "./render_styles.mjs";

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
function sortXValues(values) {
  const numeric = values.every((v) => num(v) !== null);
  return [...values].sort((a, b) => numeric ? num(a) - num(b) : String(a).localeCompare(String(b), undefined, { numeric: true }));
}
const unique = (values) => [...new Set(values)];

/** Every `<tag ...>` start tag of one element name, as an attribute map. */
function tagsOf(svgText, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*?)/?>`, "g");
  let m;
  while ((m = re.exec(svgText))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    out.push(attrs);
  }
  return out;
}
function textsOf(svgText) {
  const out = [];
  for (const m of svgText.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ attrs, text: m[2].replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim() });
  }
  return out;
}
const pointsOf = (raw) => String(raw ?? "").trim().split(/\s+/).filter(Boolean).map((p) => { const [x, y] = p.split(",").map(Number); return { x, y }; });
/** Anchor points of a path d made of M / L / C commands (the line renderer's own monotone path): the last pair of each command. */
function anchorsOfPath(d) {
  const out = [];
  for (const seg of String(d ?? "").match(/[MLC][^MLC]*/g) ?? []) {
    const nums = seg.slice(1).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? [];
    if (nums.length >= 2) out.push({ x: nums[nums.length - 2], y: nums[nums.length - 1] });
  }
  return out;
}
const same = (a, b) => Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02;

/**
 * The wave: filled area, dashed provisional tail, starred x labels, the footnote, numbered notes.
 * @param {string} svgText one viewport
 * @param {{spec: object, rows: object[]}} options
 */
export function checkWave(svgText, { spec, rows }) {
  const failures = [];
  const fail = (rule, message) => failures.push({ rule, message });
  if (!storyFormsEnabled() || !spec || spec.chart_type !== "multi_line") return { passed: true, failures, checked: 0 };
  const order = sortXValues(unique(rows.map((r) => r[spec.x_field])));
  const seriesNames = unique(rows.map((r) => String(r[spec.series_field])));
  const { flagged } = provisionalMap(spec, rows, order);
  const rank = new Map(order.map((x, i) => [String(x), i]));
  const rowsOf = (series) => rows.filter((r) => String(r[spec.series_field]) === series).sort((a, b) => rank.get(String(a[spec.x_field])) - rank.get(String(b[spec.x_field])));
  const solids = tagsOf(svgText, "polyline").filter((t) => t["data-role"] === "line-path");
  const solidPaths = tagsOf(svgText, "path").filter((t) => t["data-role"] === "line-path");
  const dashed = tagsOf(svgText, "polyline").filter((t) => t["data-role"] === "line-path-provisional");
  const areas = tagsOf(svgText, "polygon").filter((t) => t["data-role"] === "line-area");
  let checked = 0;

  // the drawn vertices of one series: settled line, then the dashed tail without its repeated first point
  const solidOf = (series) => {
    const poly = solids.find((t) => t["data-series"] === series);
    if (poly) return pointsOf(poly.points);
    const path = solidPaths.find((t) => t["data-series"] === series);
    return path ? anchorsOfPath(path.d) : null;
  };
  const dashedOf = (series) => { const d = dashed.find((t) => t["data-series"] === series); return d ? pointsOf(d.points) : null; };

  // provisional tail: only on years the SQL flagged, one dashed polyline per series that has any
  for (const series of seriesNames) {
    const mine = rowsOf(series);
    const flaggedXs = mine.filter((r) => flagged.get(series)?.has(String(r[spec.x_field])));
    const solid = solidOf(series);
    const tail = dashedOf(series);
    checked++;
    if (!solid) { fail("wave_line_missing", `series ${series} has no line-path tagged with its name`); continue; }
    if (flaggedXs.length === 0) {
      if (tail) fail("wave_dash_on_settled_series", `series ${series} has no provisional row but a dashed segment is drawn`);
      if (solid.length !== mine.length) fail("wave_point_count", `series ${series} draws ${solid.length} points for ${mine.length} rows`);
      continue;
    }
    if (!tail) { fail("wave_dash_missing", `series ${series} has ${flaggedXs.length} provisional row(s) but no dashed segment`); continue; }
    if (solid.length !== mine.length - flaggedXs.length) fail("wave_solid_count", `series ${series}: the settled line has ${solid.length} points; ${mine.length - flaggedXs.length} rows are settled`);
    if (tail.length !== flaggedXs.length + 1) fail("wave_dash_count", `series ${series}: the dashed segment has ${tail.length} points; ${flaggedXs.length} provisional rows need ${flaggedXs.length + 1}`);
    else if (solid.length && !same(tail[0], solid[solid.length - 1])) fail("wave_dash_start", `series ${series}: the dashed segment does not start at the last settled point`);
    if (tail.length >= 2 && tail.slice(1).some((p, i) => !(p.x > tail[i].x))) fail("wave_dash_order", `series ${series}: the dashed segment does not run forward in time`);
  }
  for (const t of dashed) if (!flagged.has(t["data-series"]) || !flagged.get(t["data-series"]).size) fail("wave_dash_unknown", `a dashed segment is drawn for series ${t["data-series"]}, which has no provisional row`);

  // the filled area: one polygon, its top edge on every plotted point of that series
  if (spec.area_series === undefined) {
    if (areas.length) fail("wave_area_unrequested", "a filled area is drawn but the plan names no area_series");
  } else {
    checked++;
    const series = String(spec.area_series);
    const mine = rowsOf(series);
    const mineAreas = areas.filter((t) => t["data-series"] === series);
    if (areas.length !== 1 || mineAreas.length !== 1) fail("wave_area_count", `expected one filled area for ${series}, found ${areas.length}`);
    else if (mine.length >= 2) {
      const poly = pointsOf(mineAreas[0].points);
      const top = poly.slice(0, mine.length);
      const base = poly.slice(mine.length);
      const line = [...(solidOf(series) ?? []), ...(dashedOf(series)?.slice(1) ?? [])];
      if (poly.length !== mine.length + 2) fail("wave_area_vertices", `the area has ${poly.length} vertices; ${mine.length} points plus two baseline corners = ${mine.length + 2}`);
      else {
        top.forEach((p, i) => { if (!line[i] || !same(p, line[i])) fail("wave_area_edge", `area vertex ${i + 1} (${p.x},${p.y}) is not on the line's point ${i + 1}`); });
        if (!(Math.abs(base[0].y - base[1].y) < 0.02 && same({ x: base[0].x, y: 0 }, { x: top[top.length - 1].x, y: 0 }) && same({ x: base[1].x, y: 0 }, { x: top[0].x, y: 0 }))) fail("wave_area_base", "the area's baseline corners do not sit under its first and last point");
        if (top.some((p) => p.y > base[0].y + 0.02)) fail("wave_area_below_base", "a point of the area lies below its baseline");
      }
    }
  }

  // starred x labels: exactly the provisional years that have a tick label, and the footnote that explains the star
  const provisionalXs = new Set([...flagged.values()].flatMap((set) => [...set]));
  const texts = textsOf(svgText);
  const starred = texts.filter((t) => /^[^\s*]+\*$/.test(t.text) && t.attrs["text-anchor"] === "middle").map((t) => t.text.slice(0, -1));
  checked++;
  for (const x of starred) if (!provisionalXs.has(x)) fail("wave_star_unflagged", `x label ${x}* carries a star but no row of that year is provisional`);
  if (provisionalXs.size) {
    const lastProvisional = [...provisionalXs].sort((a, b) => rank.get(a) - rank.get(b)).pop();
    if (rank.get(lastProvisional) === order.length - 1 && !starred.includes(lastProvisional)) fail("wave_star_missing", `the last year ${lastProvisional} is provisional but its tick label has no star`);
    if (!texts.some((t) => /^\*\s*(为暂定数|provisional)/.test(t.text) || /(；|; )\* ?(为暂定数|provisional)/.test(t.text))) fail("wave_star_note", "provisional years are drawn but no footnote explains the star");
  } else if (starred.length) fail("wave_star_unrequested", "x labels carry stars but no row is provisional");

  // numbered notes: a badge at each point plus a badge in the caption list, one pair per point annotation
  if (spec.numbered_notes === true) {
    checked++;
    const notes = (spec.annotations ?? []).filter((a) => a?.type === "point").length;
    const badges = tagsOf(svgText, "circle").filter((t) => t["data-role"] === "annotation-marker").length;
    if (notes === 0) fail("wave_notes_none", "numbered_notes is on but the plan has no point annotation");
    else if (badges !== notes * 2) fail("wave_notes_badges", `${notes} annotation(s) need ${notes * 2} numbered badges (on the point and in the list); found ${badges}`);
  }
  return { passed: failures.length === 0, failures, checked };
}

const degOf = (cx, cy, x, y) => ((Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI + 360) % 360;
const degGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
/** "M cx,cy L x0,y0 A r,r 0 f 1 x1,y1 Z" of the renderer's sectors → the two edge angles seen from (cx, cy). */
function sectorAngles(d) {
  const m = /^M(-?[\d.]+),(-?[\d.]+) L(-?[\d.]+),(-?[\d.]+) A[\d.]+,[\d.]+ 0 [01] 1 (-?[\d.]+),(-?[\d.]+) Z$/.exec(String(d ?? "").trim());
  if (!m) return null;
  const [cx, cy, x0, y0, x1, y1] = m.slice(1).map(Number);
  return { cx, cy, from: degOf(cx, cy, x0, y0), to: degOf(cx, cy, x1, y1) };
}
const joined = (texts, role) => texts.filter((t) => t.attrs["data-role"] === role).map((t) => t.text).join("").replace(/\s+/g, "");

/**
 * The person dot matrix, re-derived from the one row: dot count, each dot's part / rest fractions, the pie sectors' angles, that the two
 * colours never overlap, the legend counts and the algorithm sentence.
 */
export function checkDots(svgText, { spec, rows }) {
  const failures = [];
  const fail = (rule, message) => failures.push({ rule, message });
  if (!storyFormsEnabled() || !spec || spec.chart_type !== "people_dots") return { passed: true, failures, checked: 0 };
  const row = rows?.[0] ?? {};
  const total = num(row[spec.value_field]), part = num(row[spec.part_field]), per = num(row[spec.per_dot_field]);
  if (rows?.length !== 1 || total === null || part === null || per === null || !(per > 0)) return { passed: false, failures: [{ rule: "dots_rows", message: "the dot matrix needs one row with a total, a part and the people per dot" }], checked: 1 };
  const units = total / per, partUnits = part / per, drawn = Math.ceil(units - 1e-9), whole = Math.floor(units + 1e-9), frac = units - whole;
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const dots = tagsOf(svgText, "circle").filter((t) => t["data-role"] === "people-dot");
  const sectors = tagsOf(svgText, "path").filter((t) => t["data-role"] === "people-dot-sector");
  let sumAccent = 0, sumRest = 0;
  if (dots.length !== drawn) fail("dots_count", `${drawn} dots are needed for ${plainNum(total)} people at ${plainNum(per)} per dot; ${dots.length} are drawn`);
  const fills = { accent: new Set(), rest: new Set(), track: new Set() };
  for (let i = 0; i < Math.min(dots.length, drawn); i++) {
    const dot = dots[i], hi = Math.min(i + 1, units);
    const accent = overlap(i, hi, 0, partUnits), rest = overlap(i, hi, partUnits, units);
    const gotAccent = num(dot["data-accent"]), gotRest = num(dot["data-rest"]);
    if (num(dot["data-index"]) !== i) fail("dots_order", `dot ${i + 1} carries index ${dot["data-index"]}`);
    if (gotAccent === null || Math.abs(gotAccent - accent) > 0.0002 || gotRest === null || Math.abs(gotRest - rest) > 0.0002) fail("dots_fraction", `dot ${i + 1}: expected part ${accent.toFixed(4)} / rest ${rest.toFixed(4)}, drawn ${dot["data-accent"]} / ${dot["data-rest"]}`);
    if (accent + rest > 1 + 1e-9) fail("dots_overlap", `dot ${i + 1}: the two colours cover more than the dot`);
    sumAccent += accent; sumRest += rest;
    const mine = sectors.filter((t) => num(t["data-index"]) === i);
    const whole1 = accent >= 1 - 1e-9, whole2 = rest >= 1 - 1e-9;
    if (whole1) fills.accent.add(dot.fill); else if (whole2) fills.rest.add(dot.fill); else fills.track.add(dot.fill);
    if (whole1 || whole2) { if (mine.length) fail("dots_sector_on_whole", `dot ${i + 1} is whole but has sectors`); continue; }
    const expected = [["accent", 0, accent], ["rest", accent, accent + rest]].filter(([, a, b]) => b - a > 1e-9);
    if (mine.length !== expected.length) { fail("dots_sector_count", `dot ${i + 1} needs ${expected.length} sector(s), has ${mine.length}`); continue; }
    for (const [kind, a, b] of expected) {
      const sec = mine.find((t) => t["data-kind"] === kind), ang = sectorAngles(sec?.d);
      if (!ang) { fail("dots_sector_shape", `dot ${i + 1} ${kind} sector is not a pie sector`); continue; }
      if (Math.abs(ang.cx - num(dot.cx)) > 0.02 || Math.abs(ang.cy - num(dot.cy)) > 0.02) fail("dots_sector_centre", `dot ${i + 1} ${kind} sector is not centred on its dot`);
      if (degGap(ang.from, a * 360) > 0.6 || degGap(ang.to, b * 360) > 0.6) fail("dots_sector_angle", `dot ${i + 1} ${kind} sector runs ${ang.from.toFixed(1)}°–${ang.to.toFixed(1)}°, expected ${(a * 360).toFixed(1)}°–${(b * 360).toFixed(1)}°`);
    }
  }
  if (Math.abs(sumAccent - partUnits) > 0.001) fail("dots_part_total", `the part dots add up to ${sumAccent.toFixed(3)} dots; ${part}/${per} = ${partUnits.toFixed(3)}`);
  if (Math.abs(sumRest - (units - partUnits)) > 0.001) fail("dots_rest_total", `the rest dots add up to ${sumRest.toFixed(3)} dots; expected ${(units - partUnits).toFixed(3)}`);
  if (fills.accent.size > 1 || fills.rest.size > 1) fail("dots_colours", "dots of one kind are not one colour");
  if (fills.accent.size && fills.rest.size && [...fills.accent][0] === [...fills.rest][0]) fail("dots_colours", "the two colours are the same");
  // K254: a riso / pencil render re-inks the part tone (same luminance, base ink or accent ink); the expected colour is that exact re-inked colour, never a looser test.
  // The rest dots are pencil grey in every style (render_styles keeps that grey as it is).
  const penStyle = /<svg\b[^>]*\sdata-render-style="(riso|pencil)"/.exec(svgText)?.[1];
  const partWant = penStyle ? recolor(storyTone(spec), penStyle, specRenderAccent(spec)) : storyTone(spec);
  if (fills.accent.size && [...fills.accent][0].toLowerCase() !== partWant.toLowerCase()) fail("dots_colours", `the part dots must use the ${spec.emphasis_tone ?? "slate"} tone ${partWant}${penStyle ? ` (${penStyle} ink of ${storyTone(spec)})` : ""}`);
  if (fills.rest.size && [...fills.rest][0].toLowerCase() !== STORY_COLORS.pencil.toLowerCase()) fail("dots_colours", `the rest dots are people and must be pencil grey ${STORY_COLORS.pencil}`);
  const texts = textsOf(svgText);
  for (const [kind, count] of [["part", part], ["rest", total - part]]) {
    const want = `${plainNum(count)} ${spec.unit}（${plainNum((count / total) * 100, 1)}%）`.replace(/\s+/g, "");
    const got = texts.filter((t) => t.attrs["data-role"] === "people-dots-legend-count" && t.attrs["data-kind"] === kind).map((t) => t.text.replace(/\s+/g, ""));
    if (got.length !== 1 || got[0] !== want) fail("dots_legend", `the ${kind} legend should read "${want}", it reads "${got.join("|")}"`);
  }
  const lang = spec.language === "en" ? "en" : "zh";
  const wantText = dotAlgorithmText(spec, { per, total, units, drawn, frac, remainder: total - whole * per }, lang).replace(/\s+/g, "");
  if (joined(texts, "people-dots-algorithm") !== wantText) fail("dots_algorithm", "the algorithm sentence does not match the numbers re-derived from the row");
  return { passed: failures.length === 0, failures, checked: drawn + 4 };
}

/**
 * The clocks, re-derived from the rows: a face and 60 ticks each, floor(60/N) dots at 6·k·N degrees on one ring, the first person's
 * sector of 6·N degrees, the caption text, and the numbered notes.
 */
export function checkClock(svgText, { spec, rows }) {
  const failures = [];
  const fail = (rule, message) => failures.push({ rule, message });
  if (!storyFormsEnabled() || !spec || spec.chart_type !== "clock_dial") return { passed: true, failures, checked: 0 };
  const faces = tagsOf(svgText, "circle").filter((t) => t["data-role"] === "clock-face");
  const dots = tagsOf(svgText, "circle").filter((t) => t["data-role"] === "clock-dot");
  const secs = tagsOf(svgText, "path").filter((t) => t["data-role"] === "clock-sector");
  const ticks = tagsOf(svgText, "line").filter((t) => t["data-role"] === "clock-tick");
  const texts = textsOf(svgText);
  let checked = 0;
  if (faces.length !== rows.length) fail("clock_faces", `${rows.length} clocks are needed, ${faces.length} drawn`);
  const day = spec.clock_span === "day", tickN = day ? 24 : 60;
  if (ticks.length !== tickN * rows.length) fail("clock_ticks", `${tickN * rows.length} ${day ? "hour" : "minute"} ticks are needed (${tickN} per clock), ${ticks.length} drawn`);
  if (day) {
    // the one-day variant: dots = round(people per day), spread evenly at 360/n degrees, all one neutral grey, no sector, the fixed sentence
    const row = rows[0], lang = spec.language === "en" ? "en" : "zh";
    const perDay = num(row?.[spec.per_day_field]);
    if (rows.length !== 1 || perDay === null) { fail("clock_rows", "the one-day clock needs one row with the people per day"); return { passed: false, failures, checked: 1 }; }
    const plan = dayClockPlan(spec, rows)[0], face = faces[0];
    const cx = num(face?.cx), cy = num(face?.cy);
    checked++;
    if (secs.length) fail("clock_sector", "the one-day clock has no first-person sector");
    if (dots.length !== plan.count) fail("clock_dot_count", `${plainNum(perDay)} people a day gives ${plan.count} dots, ${dots.length} drawn`);
    const radii = new Set(), fills = new Set();
    dots.sort((a, b) => num(a["data-k"]) - num(b["data-k"])).forEach((dot, k) => {
      const want = plan.angles[k], at = degOf(cx, cy, num(dot.cx), num(dot.cy));
      radii.add(Math.round(Math.hypot(num(dot.cx) - cx, num(dot.cy) - cy) * 10)); fills.add(String(dot.fill).toLowerCase());
      if (want === undefined || num(dot["data-k"]) !== k + 1 || degGap(at, want) > 0.5 || Math.abs(num(dot["data-angle"]) - want) > 0.01) fail("clock_dot_angle", `dot ${k + 1} sits at ${at.toFixed(1)}°, expected ${want === undefined ? "none" : want.toFixed(1) + "°"} (even spread)`);
    });
    if (radii.size > 1) fail("clock_dot_ring", "the dots are not on one ring");
    if (fills.size !== 1 || [...fills][0] !== STORY_COLORS.pencil.toLowerCase()) fail("clock_day_colour", `one-person dots must be pencil grey ${STORY_COLORS.pencil}, found ${[...fills].join(",")}`);
    const wantCaption = clockCaptionLines(plan, lang).join("").replace(/\s+/g, "");
    if (texts.filter((t) => t.attrs["data-role"] === "clock-caption").map((t) => t.text).join("").replace(/\s+/g, "") !== wantCaption) fail("clock_caption", `the caption does not match ${wantCaption}`);
    const noteTexts = texts.filter((t) => t.attrs["data-role"] === "clock-day-note").map((t) => t.text).join("");
    if (noteTexts !== dayClockNote(lang)) fail("clock_day_note", `the picture must carry "${dayClockNote(lang)}", it carries "${noteTexts}"`);
    const dayNotes = (spec.annotations ?? []).filter((a) => a?.type === "point" && String(a.match_value) === String(row[spec.category_field]));
    if (dayNotes.length) { checked++; const badges = tagsOf(svgText, "circle").filter((t) => t["data-role"] === "annotation-marker").length; if (badges !== dayNotes.length * 2) fail("clock_notes", `${dayNotes.length} note(s) need ${dayNotes.length * 2} numbered badges; found ${badges}`); }
    return { passed: failures.length === 0, failures, checked };
  }
  rows.forEach((row, i) => {
    const name = String(row[spec.category_field]), minutes = num(row[spec.minutes_field]);
    if (minutes === null || !(minutes > 0)) return;
    checked++;
    const face = faces.find((t) => t["data-name"] === name);
    if (!face) { fail("clock_missing", `no clock for ${name}`); return; }
    const cx = num(face.cx), cy = num(face.cy), R = num(face.r);
    if ((i === 0) !== (R === Math.max(...faces.map((t) => num(t.r))))) fail("clock_big", `the first clock (${name}) must be the big one, and only it`);
    const count = Math.floor(60 / minutes + 1e-9);
    const mine = dots.filter((t) => t["data-name"] === name).sort((a, b) => num(a["data-k"]) - num(b["data-k"]));
    if (mine.length !== count) fail("clock_dot_count", `${name}: 60 ÷ ${plainNum(minutes)} gives ${count} dots, ${mine.length} drawn`);
    const radii = new Set();
    mine.forEach((dot, k) => {
      const want = (k + 1) * minutes * 6, at = degOf(cx, cy, num(dot.cx), num(dot.cy)), dist = Math.hypot(num(dot.cx) - cx, num(dot.cy) - cy);
      radii.add(Math.round(dist * 10));
      if (num(dot["data-k"]) !== k + 1 || degGap(at, want) > 0.5 || Math.abs(num(dot["data-angle"]) - want) > 0.01) fail("clock_dot_angle", `${name}: dot ${k + 1} sits at ${at.toFixed(1)}°, expected ${want.toFixed(1)}°`);
    });
    if (radii.size > 1) fail("clock_dot_ring", `${name}: the dots are not on one ring`);
    if (mine.some((t) => String(t.fill).toLowerCase() !== STORY_COLORS.pencil.toLowerCase())) fail("clock_dot_colour", `${name}: one-person dots must be pencil grey ${STORY_COLORS.pencil}`);
    const sec = secs.find((t) => t["data-name"] === name), ang = sectorAngles(sec?.d);
    if (!ang) fail("clock_sector", `${name}: no sector for the first person`);
    else if (degGap(ang.from, 0) > 0.6 || degGap(ang.to, minutes * 6) > 0.6 || Math.abs(num(sec["data-deg"]) - minutes * 6) > 0.01 || Math.abs(ang.cx - cx) > 0.02) fail("clock_sector", `${name}: the sector runs ${ang.from.toFixed(1)}°–${ang.to.toFixed(1)}°, the first person's ${plainNum(minutes)} minutes are 0°–${(minutes * 6).toFixed(1)}°`);
    const lang = spec.language === "en" ? "en" : "zh";
    const want = clockCaptionLines({ minutes, perHour: 60 / minutes }, lang).join("").replace(/\s+/g, "");
    const near = texts.filter((t) => t.attrs["data-role"] === "clock-caption" && Math.abs(num(t.attrs.x) - cx) < 0.02);
    if (near.map((t) => t.text).join("").replace(/\s+/g, "") !== want) fail("clock_caption", `${name}: the caption does not match ${want}`);
  });
  const notes = (spec.annotations ?? []).filter((a) => a?.type === "point" && rows.some((r) => String(r[spec.category_field]) === String(a.match_value)));
  if (notes.length) {
    checked++;
    const badges = tagsOf(svgText, "circle").filter((t) => t["data-role"] === "annotation-marker").length;
    if (badges !== notes.length * 2) fail("clock_notes", `${notes.length} note(s) need ${notes.length * 2} numbered badges (on the clock and in the list); found ${badges}`);
  }
  return { passed: failures.length === 0, failures, checked };
}

/** Entry point for render_qa.mjs: the check of whichever story form this spec is. */
export function checkStoryForm(svgText, form) {
  switch (form?.spec?.chart_type) {
    case "people_dots": return checkDots(svgText, form);
    case "clock_dial": return checkClock(svgText, form);
    default: return checkWave(svgText, form);
  }
}
