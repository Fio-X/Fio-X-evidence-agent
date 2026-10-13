#!/usr/bin/env node
// 1012u (K249): the page's one drawing style reaches every chart. Run: node scripts/test_page_style.mjs
// Re-runs itself with NEWSROOM_STORYBOARD=1 + NEWSROOM_RENDER_STYLES=1 for the "on" half. No compile needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const sb = await import(R + "storyboard.mjs");
const { renderVizSvg } = await import(R + "viz.mjs");
const { lintInfographicSpec } = await import(R + "infographic.mjs");
const mode = process.argv[2];

const rows = [{ k: "甲", v: 30 }, { k: "乙", v: 20 }, { k: "丙", v: 10 }];
const chart = (over = {}) => ({ schema_version: "0.9.0", language: "zh", chart_type: "horizontal_bar", reader_task: "comparison", title: "各组数值比较", subtitle: "示例", alt: "三组数值的横向条形图", source_note: "示例数据", claim_id: "c1", sql: "select k, v from t", unit: "个", category_field: "k", value_field: "v", sort: "desc", ...over });

if (mode !== "on") {
  // off: the field is dropped before rendering; the SVG is the same bytes with or without it, whatever the style switch says
  process.env.NEWSROOM_RENDER_STYLES = "1";
  const withField = chart({ page_render_style: "pencil" });
  ok(sb.withoutPageStyleWhenOff(withField).page_render_style === undefined, "off: page_render_style dropped");
  ok(renderVizSvg(sb.withoutPageStyleWhenOff(withField), rows) === renderVizSvg(chart(), rows), "off: SVG identical with the field present");
  const plain = chart(); ok(sb.withoutPageStyleWhenOff(plain) === plain, "off: a spec without the field is returned as is");
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "on"], { env: { ...process.env, NEWSROOM_STORYBOARD: "1", NEWSROOM_RENDER_STYLES: "1" }, encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status, 0, "on half failed");
  console.log(`page style (off half) PASS checks=${checks}`);
  process.exit(0);
}

// ---- on
{ // page default reaches the chart and equals writing the style in the chart
  const viaPage = renderVizSvg(sb.withoutPageStyleWhenOff(chart({ page_render_style: "pencil" })), rows);
  const direct = renderVizSvg(chart({ render_style: "pencil" }), rows);
  ok(viaPage === direct, "page pencil == chart pencil, byte for byte");
  ok(viaPage !== renderVizSvg(chart(), rows), "pencil differs from house (the style did apply)");
  const own = renderVizSvg(chart({ page_render_style: "pencil", render_style: "riso" }), rows);
  ok(own === renderVizSvg(chart({ render_style: "riso" }), rows), "a chart's own style wins over the page's");
  ok(renderVizSvg(chart({ page_render_style: "house" }), rows) === renderVizSvg(chart(), rows), "page house == no style");
}
const S = (id, style) => ({ id, style });
const has = (list) => list.some((b) => b.startsWith("storyboard_page_style"));
ok(!has(sb.pageStyleBlockers("pencil", [S("a", "pencil"), S("b", "pencil")])), "all same, page equal: ok");
ok(!has(sb.pageStyleBlockers(undefined, [S("a", undefined), S("b", undefined)])), "no style anywhere: ok");
ok(!has(sb.pageStyleBlockers("house", [S("a", undefined)])), "page house, charts silent: ok");
ok(has(sb.pageStyleBlockers("pencil", [S("a", "pencil"), S("b", "riso")])), "two charts, two styles: blocked");
ok(has(sb.pageStyleBlockers("pencil", [S("a", "riso"), S("b", "riso")])), "page differs from charts: blocked");
ok(has(sb.pageStyleBlockers(undefined, [S("a", "pencil")])), "page plan without style while charts have one: blocked");
ok(has(sb.pageStyleBlockers("pencil", [S("a", "pencil"), S("b", undefined)])), "one chart without the style: blocked");
ok(has(sb.pageStyleBlockers("pencil", [S("a", undefined), S("b", undefined)])), "page style but no chart carries it: blocked");
{ // the page lint carries it
  const spec = { schema_version: "1.5.0", language: "zh", render_style: "pencil", modules: [] };
  const bad = lintInfographicSpec(spec, {}, { chart_page_styles: [S("v1", "pencil"), S("v2", "riso")] });
  ok(bad.blockers.some((b) => b.startsWith("storyboard_page_style")), "lint blocks two chart styles");
  const good = lintInfographicSpec(spec, {}, { chart_page_styles: [S("v1", "pencil"), S("v2", "pencil")] });
  ok(!good.blockers.some((b) => b.startsWith("storyboard_page_style")), "lint passes one style");
}
console.log(`page style (on half) PASS checks=${checks}`);
