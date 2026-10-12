#!/usr/bin/env node
// 1012n people dots + clock: off/on switch behaviour, lint blockers, render QA and tamper detection.
// Run: node scripts/test_story_dots_clock.mjs   (re-runs itself with NEWSROOM_STORY_FORMS=1 for the "on" half)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const mode = process.argv[2];
const { validateVizSpec, lintVizSpec, renderVizBundle } = await import(R + "viz.mjs");
const { runRenderQa } = await import(R + "render_qa.mjs");
const common = { schema_version: "0.9.0", takeaway: "Fixture.", claim_id: "c1", language: "zh", sql: "SELECT 1", annotations: [], highlight_values: [], source_note: "示例假数据" };
const dotsSpec = (over = {}) => ({ ...common, reader_task: "part_to_whole", chart_type: "people_dots", title: "人点阵示例（假数据）", subtitle: "每个点代表一批人", alt: "总人数中有一大部分涉及某事的点阵图，每个点代表一批人。", unit: "人", value_field: "total", part_field: "involved", per_dot_field: "per_dot", part_label: "涉及某事", rest_label: "其余", ...over });
const dotsRows = [{ total: 100350, involved: 68420, per_dot: 1000 }];
const clockSpec = (over = {}) => ({ ...common, reader_task: "comparison", chart_type: "clock_dial", title: "钟面示例（假数据）", subtitle: "每个点是一个人，一圈 60 分钟", alt: "多个钟面，点数是每小时经过的人数，扇形是第一个人经过的时间。", unit: "分钟", category_field: "name", minutes_field: "minutes", annotations: [{ type: "point", text: "扇形是第一个人走过的时间", claim_id: "c1", match_field: "name", match_value: "甲类" }], ...over });
const clockRows = [{ name: "甲类", minutes: 7.5 }, { name: "乙类", minutes: 12 }, { name: "丙类", minutes: 20 }, { name: "丁类", minutes: 30 }];
const lint = (s, r) => lintVizSpec(s, r, { verified_claim_ids: ["c1"] }).blockers;

if (mode !== "on") {
  ok(validateVizSpec(dotsSpec()).some((e) => /Unsupported chart_type/.test(e)), "off: people_dots is an unsupported chart type");
  ok(validateVizSpec(clockSpec()).some((e) => /Unsupported chart_type/.test(e)), "off: clock_dial is an unsupported chart type");
  const stray = validateVizSpec({ ...common, reader_task: "comparison", chart_type: "bar", title: "t", subtitle: "s", alt: "x".repeat(30), unit: "人", category_field: "a", value_field: "b", part_field: "p" });
  ok(stray.some((e) => /STORY_FORMS_DISABLED/.test(e)), `off: stray part_field is refused ${stray}`);
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "on"], { env: { ...process.env, NEWSROOM_STORY_FORMS: "1" }, encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status, 0, "on half failed");
  console.log(`story dots+clock (off half) PASS checks=${checks}`);
  process.exit(0);
}

// ---- people dots ----
{
  const spec = dotsSpec(), rows = dotsRows;
  ok(validateVizSpec(spec).length === 0, `on: dots spec valid ${validateVizSpec(spec)}`);
  ok(lint(spec, rows).length === 0, `on: dots lint clean ${JSON.stringify(lint(spec, rows))}`);
  const svg = renderVizBundle(spec, rows).desktop;
  const qa = (s, sp = spec, r = rows) => runRenderQa({ desktop: s }, { story_form: { spec: sp, rows: r } }).viewports.desktop;
  ok(qa(svg).passed === true && qa(svg).extra_checks.story_form.passed === true, "on: dots desktop QA passes");
  ok((svg.match(/data-role="people-dot"/g) ?? []).length === 101, "on: ceil(100350/1000)=101 dots drawn");
  const rule = (s, name, sp, r) => qa(s, sp, r).extra_checks.story_form.failures.some((f) => f.rule === name);
  ok(rule(svg.replace(/<circle data-role="people-dot" data-index="5"[^>]*\/>/, ""), "dots_count"), "on: QA catches a missing dot");
  ok(rule(svg.replace(/data-index="3" data-accent="1"/, 'data-index="3" data-accent="0"'), "dots_fraction"), "on: QA catches a wrong dot fraction");
  const secTamper = svg.replace(/(data-role="people-dot-sector"[^>]*data-kind="accent" d="M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ A[\d.]+,[\d.]+ 0 0 1 )[\d.]+,[\d.]+/, "$1999,999");
  ok(secTamper !== svg && rule(secTamper, "dots_sector_angle"), "on: QA catches a wrong sector angle on a split dot");
  ok(rule(svg.replace("每个点代表 1,000 人", "每个点代表 2,000 人").replace("每个点代表 1000 人", "每个点代表 2000 人"), "dots_algorithm"), "on: QA catches a changed algorithm sentence");
  ok(rule(svg, "dots_count", spec, [{ total: 100350, involved: 68420, per_dot: 500 }]), "on: QA re-derives the count from the rows, not the drawing");
  const bad = (r, re) => lint(spec, r).some((b) => re.test(b));
  ok(bad(rows, /title has a number word/) === false && lint({ ...spec, title: "美国药物过量死亡：一万个点" }, rows).some((b) => /title has a number word/.test(b)), "on: a number word in a dots title is blocked");
  {
    const pv = (over, r = [{ ...rows[0], is_provisional: true }]) => lint({ ...spec, provisional_field: "is_provisional", ...over }, r).some((b) => /provisional years/.test(b));
    ok(pv({ subtitle: "假数据", source_note: "示例假数据" }), "on: dots with a provisional row and no 暂定 in subtitle or source is blocked");
    ok(!pv({ subtitle: "假数据", source_note: "示例假数据（2025 年暂定）" }), "on: dots: 暂定 in the source line is enough");
    ok(!pv({ subtitle: "假数据；暂定数", source_note: "示例假数据" }), "on: dots: 暂定 in the subtitle is enough");
    ok(!pv({ subtitle: "假数据", source_note: "示例假数据" }, [{ ...rows[0], is_provisional: false }]), "on: dots: no provisional row needs no note");
    ok(lint({ ...spec, provisional_field: "nope" }, rows).some((b) => /not a column of every result row/.test(b)), "on: dots: a provisional_field that is not a column is blocked");
    ok(validateVizSpec({ ...spec, provisional_field: "is_provisional" }).length === validateVizSpec(spec).length, "on: provisional_field is accepted on people_dots");
  }
  ok(bad([{ total: 100, involved: 120, per_dot: 10 }], /between 0 and the total/), "on: part above total is blocked");
  ok(bad([{ total: 100, involved: 10, per_dot: 100 }], /at least 2 dots/), "on: fewer than 2 dots is blocked");
  ok(bad([{ total: 100000, involved: 10, per_dot: 10 }], /at most 600/), "on: more than 600 dots is blocked");
  ok(bad([{ total: 100, involved: 10, per_dot: 0 }], /above 0/), "on: zero per-dot is blocked");
  ok(validateVizSpec(dotsSpec({ part_label: undefined })).some((e) => /part_label/.test(e)), "on: legend label is required");
  ok(validateVizSpec(dotsSpec({ minutes_field: "m" })).some((e) => /clock_dial only/.test(e)), "on: clock field on dots is refused");
  const exact = renderVizBundle(spec, [{ total: 10000, involved: 4000, per_dot: 1000 }]).desktop;
  ok((exact.match(/data-role="people-dot-sector"/g) ?? []).length === 0 && qa(exact, spec, [{ total: 10000, involved: 4000, per_dot: 1000 }]).passed, "on: whole-dot totals draw no partial dots");
}

// ---- clock ----
{
  const spec = clockSpec(), rows = clockRows;
  ok(validateVizSpec(spec).length === 0, `on: clock spec valid ${validateVizSpec(spec)}`);
  ok(lint(spec, rows).length === 0, `on: clock lint clean ${JSON.stringify(lint(spec, rows))}`);
  const svg = renderVizBundle(spec, rows).desktop;
  const qa = (s, sp = spec, r = rows) => runRenderQa({ desktop: s }, { story_form: { spec: sp, rows: r } }).viewports.desktop;
  ok(qa(svg).passed === true && qa(svg).extra_checks.story_form.passed === true, `on: clock desktop QA passes ${JSON.stringify(qa(svg).extra_checks)}`.slice(0, 400));
  ok((svg.match(/data-role="clock-dot"/g) ?? []).length === 8 + 5 + 3 + 2, "on: floor(60/N) dots per clock (8,5,3,2)");
  const rule = (s, name, sp, r) => qa(s, sp, r).extra_checks.story_form.failures.some((f) => f.rule === name);
  ok(rule(svg.replace(/(data-role="clock-dot" data-name="甲类" data-k="2" data-angle=")[\d.]+/, "$1 99"), "clock_dot_angle"), "on: QA catches a dot at the wrong angle");
  ok(rule(svg.replace(/(data-role="clock-sector" data-name="乙类" data-deg=")[\d.]+/, "$150"), "clock_sector"), "on: QA catches a wrong sector angle");
  ok(rule(svg.replace("每 7.5 分钟 1 人", "每 9 分钟 1 人"), "clock_caption"), "on: QA catches a changed caption");
  ok(rule(svg, "clock_dot_count", spec, [{ name: "甲类", minutes: 10 }, ...rows.slice(1)]), "on: QA re-derives dots from the rows");
  const bad = (r, re, sp = spec) => lint(sp, r).some((b) => re.test(b));
  ok(bad([{ name: "甲类", minutes: 7.5 }, { name: "甲类", minutes: 9 }], /twice/), "on: duplicate clock names are blocked");
  ok(bad([{ name: "甲类", minutes: 61 }], /between/), "on: minutes above 60 are blocked");
  ok(bad([{ name: "甲类", minutes: 0.2 }], /between/), "on: minutes below 0.5 are blocked");
  ok(bad([1, 2, 3, 4, 5].map((i) => ({ name: `n${i}`, minutes: 10 })), /1 to 4|at most|four|4/i, clockSpec({ annotations: [] })), "on: more than 4 clocks are blocked");
  const two = renderVizBundle(clockSpec({ annotations: [{ ...spec.annotations[0] }, { type: "point", text: "第二条", claim_id: "c1", match_field: "name", match_value: "乙类" }] }), rows).desktop;
  ok((two.match(/data-role="annotation-marker"/g) ?? []).length === 4, "on: two notes make four numbered badges");
  const noBadge = two.replace(/<circle data-role="annotation-marker"[^>]*\/>/, "");
  ok(noBadge !== two && runRenderQa({ desktop: noBadge }, { story_form: { spec: clockSpec({ annotations: [{ ...spec.annotations[0] }, { type: "point", text: "第二条", claim_id: "c1", match_field: "name", match_value: "乙类" }] }), rows } }).viewports.desktop.extra_checks.story_form.failures.some((f) => f.rule === "clock_notes"), "on: QA catches a missing note badge");
}
// ---- one colour, one meaning ----
{
  const { STORY_COLORS } = await import(R + "story_forms.mjs");
  const spec = dotsSpec(), rows = dotsRows;
  const svg = renderVizBundle(spec, rows).desktop;
  ok(svg.includes(`fill="${STORY_COLORS.slate}"`) && !svg.includes(STORY_COLORS.coral), "on: dots part defaults to slate, never coral");
  const coral = renderVizBundle(dotsSpec({ emphasis_tone: "coral" }), rows).desktop;
  ok(coral.includes(`fill="${STORY_COLORS.coral}"`) && coral.includes(`fill="${STORY_COLORS.pencil}"`), "on: emphasis_tone coral colours the part dots, the rest are pencil grey");
  ok(runRenderQa({ desktop: coral }, { story_form: { spec: dotsSpec({ emphasis_tone: "coral" }), rows } }).viewports.desktop.extra_checks.story_form.passed, "on: coral dots pass QA");
  ok(runRenderQa({ desktop: coral }, { story_form: { spec, rows } }).viewports.desktop.extra_checks.story_form.failures.some((f) => f.rule === "dots_colours"), "on: QA catches a part colour that is not the declared tone");
  ok(validateVizSpec(dotsSpec({ emphasis_tone: "red" })).some((e) => /emphasis_tone/.test(e)), "on: unknown tone is refused");
  ok(validateVizSpec(clockSpec({ emphasis_tone: "coral" })).some((e) => /emphasis_tone/.test(e)), "on: tone on a clock is refused");
  const clock = renderVizBundle(clockSpec(), clockRows).desktop;
  ok(/每 \d+\.\d 分钟 1 人/.test(clock) && /每小时 \d+\.\d 人/.test(clock) && !/每小时 \d+ 人/.test(clock), "on: clock minutes and people per hour both show 1 decimal");
  ok(!clock.includes("#D0021B") && (clock.match(new RegExp(`data-role="clock-dot"[^>]*fill="${STORY_COLORS.pencil}"`, "g")) ?? []).length === 18, "on: clock people dots are pencil grey");
  ok(runRenderQa({ desktop: clock.replace(new RegExp(`(data-role="clock-dot"[^>]*fill=")${STORY_COLORS.pencil}`), `$1${STORY_COLORS.coral}`) }, { story_form: { spec: clockSpec(), rows: clockRows } }).viewports.desktop.extra_checks.story_form.failures.some((f) => f.rule === "clock_dot_colour"), "on: QA catches a coloured person dot");
}

// ---- clock, one day ----
{
  const { STORY_COLORS, dayClockNote } = await import(R + "story_forms.mjs");
  const spec = clockSpec({ title: "一天的钟面（假数据）", subtitle: "一天里的人数", alt: "全天钟面上，每个点是一个人，点均匀排开。", clock_span: "day", minutes_field: undefined, per_day_field: "per_day", annotations: [] });
  delete spec.minutes_field;
  const rows = [{ name: "全部（假数据）", per_day: 193.55 }];
  ok(validateVizSpec(spec).length === 0, `on: day spec valid ${validateVizSpec(spec)}`);
  ok(lint(spec, rows).length === 0, `on: day lint clean ${JSON.stringify(lint(spec, rows))}`);
  const svg = renderVizBundle(spec, rows).desktop;
  const qa = (sv, r = rows, sp = spec) => runRenderQa({ desktop: sv }, { story_form: { spec: sp, rows: r } }).viewports.desktop;
  ok(qa(svg).passed && qa(svg).extra_checks.story_form.passed, `on: day desktop QA passes ${JSON.stringify(qa(svg).extra_checks)}`.slice(0, 300));
  ok((svg.match(/data-role="clock-dot"/g) ?? []).length === 194 && (svg.match(/data-role="clock-tick"/g) ?? []).length === 24, "on: round(193.55)=194 dots on 24 hour ticks");
  ok(svg.includes(dayClockNote()) && dayClockNote() === "点均匀排开，不是真实时刻", "on: the fixed sentence is in the picture");
  ok(!/data-role="clock-sector"/.test(svg), "on: no first-person sector in the day variant");
  ok(svg.includes(">约 194 人<") && !svg.includes("193.55"), "on: day caption is the renderer-rounded 约 194 人");
  const rule = (sv, name, r, sp) => qa(sv, r, sp).extra_checks.story_form.failures.some((f) => f.rule === name);
  ok(rule(svg.replace(dayClockNote(), "点按真实时刻排开"), "clock_day_note"), "on: QA catches a changed sentence");
  ok(rule(svg.replace(new RegExp(`(data-role="clock-dot"[^>]*fill=")${STORY_COLORS.pencil}`), `$1${STORY_COLORS.coral}`), "clock_day_colour"), "on: QA catches a coloured person dot");
  ok(rule(svg.replace(/(data-role="clock-dot" data-name="[^"]*" data-k="7" data-angle=")[\d.]+/, "$150"), "clock_dot_angle"), "on: QA catches an uneven dot");
  ok(rule(svg, "clock_dot_count", [{ name: "全部（假数据）", per_day: 150 }]), "on: QA re-derives the count from the row");
  const bad = (r, re, sp = spec) => lint(sp, r).some((b) => re.test(b));
  {
    const pv = (over, r = [{ ...rows[0], is_provisional: true }]) => lint({ ...spec, provisional_field: "is_provisional", ...over }, r).some((b) => /provisional years/.test(b));
    ok(pv({ subtitle: "假数据", source_note: "示例假数据" }), "on: day clock with a provisional row and no 暂定 is blocked");
    ok(!pv({ subtitle: "假数据", source_note: "示例假数据（暂定）" }), "on: day clock: 暂定 in the source line is enough");
    ok(!pv({ subtitle: "暂定数", source_note: "示例假数据" }), "on: day clock: 暂定 in the subtitle is enough");
    ok(lint({ ...clockSpec(), provisional_field: "is_provisional", subtitle: "x", source_note: "y" }, clockRows.map((r, i) => ({ ...r, is_provisional: i === 0 }))).some((b) => /provisional years/.test(b)), "on: hour clock with a provisional row and no 暂定 is blocked");
  }
  ok(bad(rows, /title has a number word/, { ...spec, title: "一万个点" }), "on: a number word in a day-clock title is blocked");
  ok(bad(rows, /subtitle has a number word/, { ...spec, subtitle: "三成的人" }), "on: a number word in a subtitle is blocked");
  ok(bad([{ name: "a", per_day: 0.2 }], /1 to 300/), "on: under one dot is blocked");
  ok(bad([{ name: "a", per_day: 5000 }], /1 to 300/), "on: over 300 dots is blocked");
  ok(bad([{ name: "a", per_day: 3 }, { name: "b", per_day: 4 }], /one clock/), "on: more than one clock is blocked");
  ok(validateVizSpec({ ...spec, minutes_field: "m" }).some((e) => /per_day_field, not minutes_field/.test(e)), "on: both fields are refused");
  ok(validateVizSpec(clockSpec({ per_day_field: "x" })).some((e) => /day' only/.test(e)), "on: per_day_field on the hour clock is refused");
  const { PALETTE_FAMILIES } = await import(R + "palette_theme.mjs");
  ok(STORY_COLORS.pencil === PALETTE_FAMILIES.graphite.ramp7[4] && STORY_COLORS.coral === PALETTE_FAMILIES.coral.ramp7[4] && STORY_COLORS.slate === PALETTE_FAMILIES.graphite.accent, "colour tokens come from the palette library");
}
{
  const { storyStrokeAttrs } = await import(R + "story_forms.mjs");
  ok(storyStrokeAttrs("clock-tick", { stroke: "#111", width: 1.4 }) === 'stroke="#111" stroke-width="1.4"', "stroke hook: house style adds nothing");
  ok(storyStrokeAttrs("wave-tail", { stroke: "#111", width: 2, cap: "butt", dash: "5 4" }) === 'stroke="#111" stroke-width="2" stroke-linecap="butt" stroke-dasharray="5 4"', "stroke hook: house attribute order");
  ok(/<line data-role="clock-tick"[^>]* stroke="#1A1A1A" stroke-width="1.4"\/>/.test(renderVizBundle(clockSpec(), clockRows).desktop), "stroke hook: clock ticks go through it");
}
console.log(`story dots+clock (on half) PASS checks=${checks}`);
