#!/usr/bin/env node
// 1012n wave: multi_line area fill, dashed provisional tail + star, numbered notes, behind NEWSROOM_STORY_FORMS=1.
// Run: node scripts/test_story_wave.mjs   (re-runs itself with the switch on for the "on" half)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const mode = process.argv[2];
const { validateVizSpec, lintVizSpec, renderVizBundle } = await import(R + "viz.mjs");
const { runRenderQa } = await import(R + "render_qa.mjs");
const { checkSvgGeometry } = await import(R + "render_qa_geometry.mjs");
const base = {
  schema_version: "0.9.0", reader_task: "change", takeaway: "Wave fixture.", title: "波形示例（假数据）", subtitle: "假数据；最后一年为暂定数", alt: "总数与各个类别随年份变化的折线图，总数下方填浅色面，最后一年为暂定数。",
  source_note: "示例假数据", claim_id: "c1", sql: "SELECT 1", annotations: [], highlight_values: ["总数"], chart_type: "multi_line",
  x_field: "year", value_field: "n", series_field: "kind", unit: "人", direct_labels: true,
};
const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const mk = (provisionalFrom = 2025) => years.flatMap((y, i) => [["总数", 50000 + i * 6000 - (i > 6 ? 9000 : 0)], ["甲类", 20000 + i * 3000], ["乙类", 15000 + i * 800], ["丙类", 6000 + i * 400]].map(([kind, n]) => ({ year: y, kind, n, is_provisional: y >= provisionalFrom })));
const wave = (over = {}) => ({ ...base, area_series: "总数", provisional_field: "is_provisional", ...over });
const lint = (spec, rows) => lintVizSpec(spec, rows, { verified_claim_ids: ["c1"] });
const text = (l) => JSON.stringify(l.blockers);

if (mode !== "on") {
  const errs = validateVizSpec(wave());
  ok(errs.some((e) => /STORY_FORMS_DISABLED/.test(e)), `off: wave fields are refused ${errs}`);
  ok(validateVizSpec(base).every((e) => !/STORY_FORMS/.test(e)), "off: a plain multi_line is untouched");
  ok(validateVizSpec({ ...base, emphasis_tone: "coral" }).some((e) => /STORY_FORMS_DISABLED/.test(e)), "off: emphasis_tone is refused");
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "on"], { env: { ...process.env, NEWSROOM_STORY_FORMS: "1" }, encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status, 0, "on half failed");
  console.log(`story wave (off half) PASS checks=${checks}`);
  process.exit(0);
}

const rows = mk();
const spec = wave();
ok(validateVizSpec(spec).length === 0, `on: spec valid ${validateVizSpec(spec)}`);
ok(lint(spec, rows).blockers.length === 0, `on: lint clean ${text(lint(spec, rows))}`);
const bundle = renderVizBundle(spec, rows, { compact: true });
ok(bundle.compact === undefined || bundle.compact === null, "on: no compact variant is registered for a wave");
const qa = runRenderQa({ desktop: bundle.desktop }, { story_form: { spec, rows } });
ok(qa.viewports.desktop.passed === true, `on: desktop QA passes ${JSON.stringify(qa.viewports.desktop)}`.slice(0, 600));
ok(qa.viewports.desktop.extra_checks?.story_form?.passed === true, "on: wave checks ran and passed");
const svg = bundle.desktop;
ok((svg.match(/data-role="line-area"/g) ?? []).length === 1, "on: one filled area");
ok((svg.match(/data-role="line-path-provisional"/g) ?? []).length === 4, "on: one dashed segment per series with provisional rows");
ok(/stroke-dasharray/.test(svg) && />2025\*</.test(svg), "on: dash and starred 2025 tick");
ok(/为暂定数/.test(svg), "on: footnote for the star");

// only the flagged year is dashed: flag nothing → no dashed segment, no star
const none = mk(9999);
const svgNone = renderVizBundle(wave(), none).desktop;
ok(!/line-path-provisional/.test(svgNone) && !/>2025\*</.test(svgNone), "on: no provisional rows → no dash, no star");
ok(runRenderQa({ desktop: svgNone }, { story_form: { spec: wave(), rows: none } }).viewports.desktop.extra_checks.story_form.passed, "on: none-flagged QA passes");

// QA catches tampering: move one area vertex, drop the dash, add a star on a settled year
const failsOf = (s, r = rows, sp = spec) => runRenderQa({ desktop: s }, { story_form: { spec: sp, rows: r } }).viewports.desktop.extra_checks.story_form;
const tamper = svg.replace(/(data-role="line-area"[^>]*points=")(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/, (m, a, x, y) => `${a}${x},${Number(y) + 9}`);
ok(tamper !== svg && failsOf(tamper).failures.some((f) => f.rule === "wave_area_edge"), "on: QA catches an area vertex off the line");
const noDash = svg.replace(/<polyline data-role="line-path-provisional"[^>]*\/>/g, "");
ok(failsOf(noDash).failures.some((f) => f.rule === "wave_dash_missing"), "on: QA catches a missing dashed segment");
const star = svg.replace(">2019<", ">2019*<");
ok(failsOf(star).failures.some((f) => f.rule === "wave_star_unflagged"), "on: QA catches a star on a settled year");

// flag column rules
const noCol = rows.map(({ is_provisional, ...r }) => r);
ok(/is_provisional/.test(text(lint(spec, noCol))), "on: missing flag column is blocked");
const bad = rows.map((r) => ({ ...r, is_provisional: r.year === 2025 ? "maybe" : false }));
ok(lint(spec, bad).blockers.length > 0, "on: a flag that is not true/false is blocked");
const hole = rows.map((r) => ({ ...r, is_provisional: r.year === 2020 }));
ok(lint(spec, hole).blockers.length > 0, "on: a flag that is not a trailing run is blocked");
ok(lint(spec, rows.map((r) => ({ ...r, is_provisional: true }))).blockers.length > 0, "on: every row provisional is blocked");
ok(lint(wave({ area_series: "没有这类" }), rows).blockers.length > 0, "on: area_series must be a series value");
ok(validateVizSpec({ ...wave(), chart_type: "line" }).length > 0, "on: wave fields are multi_line only");

// numbered notes: badge on the point and in the list; a note text over the area fails QA
{
  const hasP = (spec) => lint(spec, rows).blockers.some((b) => /provisional years/.test(b));
  ok(hasP(wave({ subtitle: "假数据", source_note: "示例假数据" })), "on: provisional data with no 暂定 in the subtitle or source is blocked");
  ok(!hasP(wave({ subtitle: "假数据", source_note: "示例假数据（2025 年暂定）" })), "on: 暂定 in the source line is enough");
  ok(!hasP(wave({ subtitle: "假数据；最后一年为暂定数", source_note: "示例假数据" })), "on: 暂定 in the subtitle is enough");
  ok(lint(wave({ title: "一万个点" }), rows).blockers.some((b) => /title has a number word/.test(b)), "on: a number word in a wave title is blocked");
}
const noted = wave({ numbered_notes: true, annotations: [{ type: "point", text: "2021年增速最快", value: 68000, claim_id: "c1", match_field: "year", match_value: 2021, series_value: "总数", tone: "accent" }] });
const bn = renderVizBundle(noted, rows).desktop;
const valNote = wave({ numbered_notes: true, annotations: [{ type: "point", text: "2021年峰值：{value}", value: 68000, claim_id: "c1", match_field: "year", match_value: 2021, series_value: "总数", tone: "accent" }] });
const vn = renderVizBundle(valNote, rows).desktop;
ok(vn.includes("2021年峰值：68,000 人") && !vn.includes("{value}") && !vn.includes("68000"), "on: {value} in a note becomes the axis-style unit-labelled number");
const qn = runRenderQa({ desktop: bn }, { story_form: { spec: noted, rows } });
ok(qn.viewports.desktop.extra_checks.story_form.passed, `on: numbered notes badges counted ${JSON.stringify(qn.viewports.desktop.extra_checks.story_form.failures)}`);
const over = `<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg"><polygon data-role="line-area" data-series="总数" points="20,50 380,50 380,180 20,180" fill="#888" fill-opacity="0.14"/><text x="100" y="120" font-size="14">压在面上的字</text></svg>`;
ok(checkSvgGeometry(over).failures.some((f) => f.rule === "text_crosses_data_mark"), "on: text inside the area fails the shared label-overlap rule");
{
  const { STORY_COLORS } = await import(R + "story_forms.mjs");
  ok(svg.includes(`stroke="${STORY_COLORS.slate}"`) && !svg.includes("#D0021B"), "on: wave highlight defaults to slate, not the house red");
  const c = renderVizBundle(wave({ emphasis_tone: "coral" }), rows).desktop;
  ok(c.includes(`stroke="${STORY_COLORS.coral}"`) && c.includes(`fill="${STORY_COLORS.coral}"`), "on: emphasis_tone coral colours the line and its area");
  ok(validateVizSpec(wave({ emphasis_tone: "teal" })).some((e) => /emphasis_tone/.test(e)), "on: unknown tone is refused");
}
console.log(`story wave (on half) PASS checks=${checks}`);
