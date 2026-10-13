#!/usr/bin/env node
// K254: riso/pencil keep the story colours. A: emphasis_tone=coral is the accent ink. D: people / clock dots stay pencil grey.
// B: the people-dots render check compares with the re-inked expected colour. C: the render tool runs the story check for dots and clock too.
// Run: node scripts/test_riso_story_colours.mjs   (re-runs itself with NEWSROOM_STORY_FORMS=1 and NEWSROOM_RENDER_STYLES=1)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv[2] !== "on") {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "on"], { env: { ...process.env, NEWSROOM_STORY_FORMS: "1", NEWSROOM_RENDER_STYLES: "1" }, encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const { renderVizSvg } = await import(R + "viz.mjs");
const { specRenderAccent, recolor } = await import(R + "render_styles.mjs");
const { STORY_COLORS } = await import(R + "story_forms.mjs");
const fillsOf = (svg, role, extra = "") => [...svg.matchAll(new RegExp(`<[a-z]+\\b[^>]*data-role="${role}"[^>]*${extra}[^>]*>`, "g"))].map((m) => /\sfill="([^"]+)"/.exec(m[0])?.[1]?.toLowerCase());

// ---- A: emphasis_tone coral = accent ink ----
ok(specRenderAccent({ emphasis_tone: "coral" }) === true, "A: coral tone is the accent ink");
ok(specRenderAccent({ emphasis_tone: "slate" }) === false && specRenderAccent({}) === false, "A: slate / no tone is not");
ok(specRenderAccent({ render_accent: true }) === true && specRenderAccent({ render_accent: false, emphasis_tone: "slate" }) === false, "A: render_accent is unchanged");
const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const wrows = years.flatMap((y, i) => [["总数", 50000 + i * 6000], ["甲类", 20000 + i * 3000], ["乙类", 15000 + i * 800]].map(([kind, n]) => ({ year: y, kind, n, is_provisional: y >= 2025 })));
const wave = (over = {}) => ({ schema_version: "0.9.0", reader_task: "change", takeaway: "Wave fixture.", title: "波形示例（假数据）", subtitle: "假数据；最后一年为暂定数", alt: "总数与各个类别随年份变化的折线图，总数下方填浅色面，最后一年为暂定数。", source_note: "示例假数据", claim_id: "c1", sql: "SELECT 1", annotations: [], highlight_values: ["甲类"], chart_type: "multi_line", x_field: "year", value_field: "n", series_field: "kind", unit: "人", direct_labels: true, area_series: "总数", provisional_field: "is_provisional", ...over });
const hex = (svg) => [...new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase()))];
const coralInk = recolor(STORY_COLORS.coral, "riso", true).toLowerCase(), slateInk = recolor(STORY_COLORS.slate, "riso", false).toLowerCase();
const waveCoral = renderVizSvg(wave({ emphasis_tone: "coral", render_style: "riso" }), wrows);
const waveSlate = renderVizSvg(wave({ emphasis_tone: "slate", render_style: "riso" }), wrows);
ok(waveCoral.includes('data-render-style="riso"'), "A: styled");
ok(hex(waveCoral).some((c) => /^#(?:d|e)[0-9a-f]6[0-9a-f]{2}$/.test(c) || c === coralInk) && hex(waveCoral).join() !== hex(waveSlate).join(), "A: a coral wave prints a warm ink, a slate one does not");
const warm = (c) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); return r > b + 25; };
ok(hex(waveCoral).some(warm), "A: riso + coral tone: some ink is warm");
const PAPER_INKS = ["#f1ecdf", "#8a7f6a"]; // the paper and its grain specks are warm by design, not chart ink
ok(!hex(waveSlate).filter((c) => !PAPER_INKS.includes(c)).some(warm), "A: riso + slate tone: no warm ink (the accent is not leaked)");

// ---- D: one person = pencil grey, in riso and pencil alike ----
const common = { schema_version: "0.9.0", takeaway: "Fixture.", claim_id: "c1", language: "zh", sql: "SELECT 1", annotations: [], highlight_values: [], source_note: "示例假数据" };
const dots = (over = {}) => ({ ...common, reader_task: "part_to_whole", chart_type: "people_dots", title: "人点阵示例（假数据）", subtitle: "每个点代表一批人", alt: "总人数中有一大部分涉及某事的点阵图，每个点代表一批人。", unit: "人", value_field: "total", part_field: "involved", per_dot_field: "per_dot", part_label: "涉及", rest_label: "其他", ...over });
const drows = [{ total: 100350, involved: 68420, per_dot: 1000 }];
const PENCIL = STORY_COLORS.pencil.toLowerCase();
for (const style of ["riso", "pencil"]) {
  const svg = renderVizSvg(dots({ emphasis_tone: "coral", render_style: style }), drows);
  const wholeRest = [...svg.matchAll(/<circle\b[^>]*data-role="people-dot"[^>]*>/g)].map((m) => m[0]).filter((t) => /data-accent="0"/.test(t) && /data-rest="1"/.test(t));
  ok(wholeRest.length > 0 && wholeRest.every((t) => /\sfill="([^"]+)"/.exec(t)[1].toLowerCase() === PENCIL), `D ${style}: whole rest dots keep pencil grey ${PENCIL}`);
  const sw = [...svg.matchAll(/<circle\b[^>]*data-role="legend-swatch"[^>]*>/g)].map((m) => /\sfill="([^"]+)"/.exec(m[0])[1].toLowerCase());
  ok(sw.includes(PENCIL), `D ${style}: the legend swatch for the rest is pencil grey`);
}
{
  const r = renderVizSvg(dots({ emphasis_tone: "coral", render_style: "riso" }), drows), sl = renderVizSvg(dots({ emphasis_tone: "slate", render_style: "riso" }), drows);
  const part = (svg) => [...svg.matchAll(/<circle\b[^>]*data-role="people-dot"[^>]*>/g)].map((m) => m[0]).filter((t) => /data-accent="1"/.test(t)).map((t) => /\sfill="([^"]+)"/.exec(t)[1].toLowerCase());
  ok(new Set(part(r)).size === 1 && new Set(part(sl)).size === 1 && part(r)[0] !== part(sl)[0], `D: riso coral part dots ${part(r)[0]} and slate part dots ${part(sl)[0]} are two colours`);
  ok(part(r)[0] !== PENCIL && part(sl)[0] !== PENCIL, "D: neither part colour is the person grey");
}
// house is untouched by D (only the styled layer changes)
{
  const house = renderVizSvg(dots({ emphasis_tone: "coral" }), drows);
  ok(!house.includes("data-render-style") && house.includes(STORY_COLORS.coral) && house.includes(STORY_COLORS.pencil), "D: house render has no style layer and keeps both story colours");
}

// ---- B: the dots render check compares with the re-inked colour, and stays exact ----
const { runRenderQa } = await import(R + "render_qa.mjs");
const qa = (svg, spec) => runRenderQa({ desktop: svg }, { story_form: { spec, rows: drows } }).viewports.desktop.extra_checks.story_form;
const colourFails = (r) => r.failures.filter((f) => f.rule === "dots_colours");
for (const style of ["riso", "pencil"]) for (const tone of ["coral", "slate"]) {
  const spec = dots({ emphasis_tone: tone, render_style: style });
  const r = qa(renderVizSvg(spec, drows), spec);
  ok(r.passed === true, `B ${style}/${tone}: the styled dots pass the render check (${JSON.stringify(r.failures)})`);
}
{
  const spec = dots({ emphasis_tone: "coral", render_style: "riso" }), svg = renderVizSvg(spec, drows);
  const partFill = (svg) => /<circle\b[^>]*data-role="people-dot"[^>]*data-accent="1"[^>]*>/.exec(svg)[0].match(/\sfill="([^"]+)"/)[1];
  const was = partFill(svg), other = partFill(renderVizSvg(dots({ emphasis_tone: "slate", render_style: "riso" }), drows));
  ok(was.toLowerCase() !== other.toLowerCase(), "B: riso coral and riso slate are drawn in two colours");
  // exactness: a part colour that is the house tone (not re-inked), or the other tone's ink, or one step off, is still a failure
  const swap = (to) => svg.split(`fill="${was}"`).join(`fill="${to}"`);
  ok(colourFails(qa(swap(STORY_COLORS.coral), spec)).length > 0, "B: the un-re-inked house coral in a riso render fails");
  ok(colourFails(qa(swap(other), spec)).length > 0, "B: the slate ink where coral is planned fails");
  ok(colourFails(qa(swap("#da6e67"), spec)).length > 0 || was.toLowerCase() === "#da6e67", "B: one step off the re-inked colour fails");
  // a house render still must be the house tone
  const house = renderVizSvg(dots({ emphasis_tone: "coral" }), drows);
  ok(qa(house, dots({ emphasis_tone: "coral" })).passed === true, "B: the house render passes as before");
  ok(colourFails(qa(house.split(STORY_COLORS.coral).join("#112233"), dots({ emphasis_tone: "coral" }))).length > 0, "B: a wrong part colour in a house render fails as before");
  // the rest dots stay pencil grey and are checked as before, also in riso
  ok(colourFails(qa(svg.split(`fill="${STORY_COLORS.pencil}"`).join('fill="#546b82"'), spec)).length > 0, "B: grey-blue rest dots fail");
}

// ---- C: the render tool runs the story check for dots and clock too; the clock passes it in every style ----
import { readFileSync } from "node:fs";
const tool = readFileSync(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
const line = /const storyQa = [^\n]*/.exec(tool)?.[0] ?? "";
ok(/storyFormsEnabled\(\)/.test(line) && /"multi_line"/.test(line) && /STORY_CHART_TYPES/.test(line), "C: the story render check is chosen for the wave and for STORY_CHART_TYPES (dots, clock), behind the switch");
const clock = (over = {}) => ({ ...common, reader_task: "comparison", chart_type: "clock_dial", title: "钟面示例（假数据）", subtitle: "每个点是一个人，一圈 60 分钟", alt: "多个钟面，点数是每小时经过的人数，扇形是第一个人经过的时间。", unit: "分钟", category_field: "name", minutes_field: "minutes", annotations: [{ type: "point", text: "扇形是第一个人走过的时间", claim_id: "c1", match_field: "name", match_value: "甲类" }], ...over });
const crows = [{ name: "甲类", minutes: 7.5 }, { name: "乙类", minutes: 12 }, { name: "丙类", minutes: 20 }, { name: "丁类", minutes: 30 }];
for (const style of [undefined, "riso", "pencil"]) {
  const spec = clock(style ? { render_style: style } : {});
  const r = runRenderQa({ desktop: renderVizSvg(spec, crows) }, { story_form: { spec, rows: crows } }).viewports.desktop.extra_checks.story_form;
  ok(r.passed === true, `C/D clock ${style ?? "house"}: the clock passes its render check (${JSON.stringify(r.failures)})`);
}
console.log(`riso story colours PASS checks=${checks}`);
