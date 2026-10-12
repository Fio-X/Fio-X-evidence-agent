#!/usr/bin/env node
// K267 page polish (NEWSROOM_PAGE_POLISH=1, exact, default off): a chart title that repeats its section title is not drawn, a big number takes the
// page's first color_legend colour and the full-width bar (no narrow 4/8 pair), and a chart held narrower than its box sits centred on a full-width
// backing. Off: every one of these is exactly as before. Run: node scripts/test_page_polish.mjs   (re-runs itself for the off and on halves)
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const R = fileURLToPath(new URL("../runtime/pi/", import.meta.url));
const mode = process.argv[2] ?? "all";
if (mode === "all") {
  const { spawnSync } = await import("node:child_process");
  for (const m of ["off", "on", "off-1"]) {
    const env = { ...process.env, NEWSROOM_STORYBOARD: "1" }; delete env.NEWSROOM_PAGE_POLISH;
    if (m === "on") env.NEWSROOM_PAGE_POLISH = "1";
    if (m === "off-1") env.NEWSROOM_PAGE_POLISH = "true";
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m === "on" ? "on" : "off"], { env, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    assert.equal(r.status, 0, `${m} half failed`);
  }
  console.log("page polish PASS");
  process.exit(0);
}
const { composeInfographicBundle, titlesNearlySame, withoutChartTitle, pagePolishEnabled } = await import(R + "infographic.mjs");

const chart = (title, { w = 1040, h = 600, sub = true, extra = "" } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="viz-title"><title id="viz-title">${title}</title><rect width="${w}" height="${h}" fill="#f1ecdf"/><text x="54" y="38" font-size="28" font-weight="700" fill="#2f4357">${title}</text>${sub ? `<text x="54" y="74" font-size="15" fill="#516880">副标题说明文字</text>` : ""}${extra}<line x1="60" y1="300" x2="900" y2="300" stroke="#999"/><text x="60" y="${h - 20}" font-size="12">来源</text></svg>`;
const spec = (heading, title, { tall = false } = {}) => ({
  schema_version: "1.0.0", language: "zh", title: "页面标题", dek: "副题副题副题", alt: "一张用来测试版面的页面示意图，不含任何数据，只检查标题与版面。", complexity_budget: "low",
  color_legend: [{ color: "#d0746f", meaning_id: "main" }, { color: "#3a5f7e", meaning_id: "other" }],
  modules: [
    { id: "h1", type: "section_header", span: "full", heading },
    { id: "v1", type: "visual", span: "full", manifest_ref: "vz1", claim_ids: ["c1"] },
    { id: "s1", type: "hero_stat", span: "full", value: "70646", label: "2025 年全美（暂定）", unit: "人", claim_id: "c1" },
    { id: "t1", type: "text", span: "full", body: "短注一句。", claim_ids: ["c1"] },
  ],
  _assets: { vz1: { manifest: { kind: "chart" }, desktopSvg: chart(title, tall ? { h: 1300 } : {}), mobileSvg: chart(title) } },
});
const compose = (s) => { const { _assets, ...rest } = s; return composeInfographicBundle(rest, _assets, { mobilePages: false }).desktop; };
const SAME = ["西部几个州几乎没从高峰退下来", "西部好几个州几乎没从高峰退下来"];

// the pure helpers do not depend on the switch
ok(titlesNearlySame(SAME[0], SAME[1]), "the two sentences from the rejected page count as nearly the same");
ok(titlesNearlySame("先猛涨，再回落", "先猛涨再回落！"), "punctuation does not matter");
ok(!titlesNearlySame("合成阿片类占了大头", "致死的主要是合成阿片类"), "a different sentence about the same thing is not the same");
ok(!titlesNearlySame("美国的一天", "摊到每天是这样一圈人"), "unrelated titles differ");
ok(!titlesNearlySame("", "西部"), "empty or very short titles never match a different one");
ok(titlesNearlySame("一天", "一天"), "identical short titles match");

const cut = withoutChartTitle(chart(SAME[1]), SAME[0]);
ok(cut !== chart(SAME[1]) && !/<text[^>]*font-size="28"/.test(cut), "helper: the title line is removed");
ok(/viewBox="0 \d+ 1040 \d+"/.test(cut) && !/viewBox="0 0 1040 600"/.test(cut), "helper: the blank above the next line is cropped from the viewBox");
ok(cut.includes("副标题说明文字") && cut.includes(`<title id="viz-title">${SAME[1]}</title>`), "helper: the subtitle and the accessible title stay");
ok(withoutChartTitle(chart("完全不同的标题内容"), SAME[0]) === chart("完全不同的标题内容"), "helper: a different title is untouched");
const guarded = chart(SAME[1], { extra: `<circle cx="500" cy="20" r="6" fill="#f00"/>` });
ok(withoutChartTitle(guarded, SAME[0]) === guarded, "helper: other ink above the crop line keeps the SVG as it was");

const dup = spec(SAME[0], SAME[1]);
const page = compose(dup);
const titleDrawn = (svg) => svg.includes(`>${SAME[1]}</text>`);
const hero = (svg) => svg.match(/<text[^>]*font-size="58"[^>]*fill="(#[0-9a-fA-F]{6})"/)?.[1];
const heroBox = (p) => p.boxes.find((b) => b.id === "s1");
const visualTag = (svg) => svg.match(/<svg data-role="infographic-visual"[^>]*>/)?.[0] ?? "";
if (mode === "off") {
  ok(pagePolishEnabled() === false, "off: switch is off");
  ok(titleDrawn(page.svg), "off: the chart still prints its own title");
  ok(hero(page.svg) !== undefined && hero(page.svg).toLowerCase() !== "#d0746f", `off: the big number keeps the house accent (${hero(page.svg)})`);
  ok(!/infographic-visual-backing/.test(compose(spec(SAME[0], "别的标题", { tall: true })).svg), "off: no backing rect");
  ok([...page.svg.matchAll(/<line x1="([\d.]+)" y1="[\d.]+" x2="(\d+)" [^>]*stroke="#E5E5E5"/g)].some((m) => Number(m[1]) > 96 || Number(m[2]) < 1344), "off: the note rule still sits in its narrow paired cell");
  console.log(`page polish (off) PASS checks=${checks}`);
} else {
  ok(pagePolishEnabled() === true, "on: switch is on");
  ok(!titleDrawn(page.svg), "on: the chart does not print a title that repeats its section title");
  ok(page.svg.includes("副标题说明文字"), "on: the chart's subtitle is still there");
  const other = compose(spec(SAME[0], "合成阿片类占了大头"));
  ok(titleDrawn(other.svg) === false && other.svg.includes("合成阿片类占了大头</text>"), "on: a different chart title is still printed");
  ok(hero(page.svg)?.toLowerCase() === "#1a1a1a", `on: a big number that names no meaning is plain ink, not a legend colour and not the house red (${hero(page.svg)})`);
  const withMeaning = (id) => { const s2 = spec(SAME[0], SAME[1]); s2.modules.find((m) => m.id === "s1").meaning_id = id; return compose(s2).svg; };
  ok(hero(withMeaning("other"))?.toLowerCase() === "#3a5f7e", "on: a big number whose meaning_id is in color_legend takes that entry's colour");
  ok(hero(withMeaning("main"))?.toLowerCase() === "#d0746f", "on: the first legend entry is used only when the number names that meaning");
  ok(hero(withMeaning("not_registered"))?.toLowerCase() === "#1a1a1a", "on: a meaning_id the legend does not register gives plain ink");
  const noLegend = spec(SAME[0], SAME[1]); delete noLegend.color_legend;
  ok(hero(compose(noLegend).svg)?.toLowerCase() === "#1a1a1a", "on: without a color_legend the number is plain ink");
  const bar = page.svg.match(/<rect data-role="hero-stat"[^>]*width="(\d+)" height="3"/);
  const labelY = Number(page.svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="15.5"[^>]*>2025/)?.[1]);
  const numY = Number(page.svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="58"/)?.[1]);
  ok(bar && Number(bar[1]) === 1248 && labelY === numY, `on: the stat bar spans the column and its label sits on the numeral's baseline (${labelY} vs ${numY})`);
  const rule = [...page.svg.matchAll(/<line x1="96" y1="[\d.]+" x2="(\d+)" y2="[\d.]+" stroke="#E5E5E5"/g)].map((m) => Number(m[1]));
  ok(rule.length > 0 && rule.every((x2) => x2 === 1344), `on: the rule above a short note runs the full column (${rule})`);
  ok(heroBox(page).w === 1248, `on: the big number takes the full content width (${heroBox(page).w})`);
  const tall = compose(spec(SAME[0], "别的标题", { tall: true }));
  ok(/infographic-visual-backing/.test(tall.svg) && /xMidYMin/.test(visualTag(tall.svg)), "on: a chart narrower than its box is centred on a full-width backing of its own paper colour");
  const phone = (on) => { if (on) process.env.NEWSROOM_PAGE_POLISH = "1"; else delete process.env.NEWSROOM_PAGE_POLISH; try { const { _assets, ...rest } = spec(SAME[0], SAME[1]); return composeInfographicBundle(rest, _assets, { mobilePages: true }).mobile.svg; } finally { process.env.NEWSROOM_PAGE_POLISH = "1"; } };
  ok(phone(true) === phone(false), "on: the phone page is byte-identical to the switch-off phone page (desktop only)");
  console.log(`page polish (on) PASS checks=${checks}`);
}
