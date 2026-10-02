#!/usr/bin/env node
// Round-2 chart defects (desktop only):
//  1. diverging_bar draws gains and losses in two colours by sign (PALETTE.positive / .negative), with a
//     zero line; with highlight_values the other bars are lighter (fill-opacity 0.45) and the highlighted
//     value labels are weight 700.
//  2. diverging_bar uses the tight label column (sized from the drawn names) instead of the fixed 250 px.
//  3. dumbbell has a one-line key: start-colour dot + start_label, end-colour dot + end_label.
//  4. a zh choropleth prints no Latin-letter word beyond the basemap's proper name (scan, no code change).
// Every other chart type renders byte-identical to the base commit. Synthetic data only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PALETTE, renderVizSvg } from "../runtime/pi/viz.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE_COMMIT = "b52a5d0";
const base = {
  schema_version: "0.9.0", takeaway: "t", title: "Round two", subtitle: "synthetic", alt: "A synthetic chart used to check round-two layout and colour defects.",
  source_note: "synthetic fixture", claim_id: "claim-round2", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh",
};
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const tags = (svg, re) => [...svg.matchAll(re)].map((m) => m[0]);

// ---- 1 + 2. diverging bar ----------------------------------------------------------------------
const names = ["华北", "华东", "华南", "西北", "东北", "西南", "华中", "新疆", "内蒙", "海南", "云南", "贵州"];
const rows = names.map((region, i) => ({ region, change: (i % 3 === 0 ? -1 : 1) * (4 + i * 1.5) }));
const diverging = (extra = {}) => renderVizSvg({ ...base, reader_task: "comparison", chart_type: "diverging_bar", category_field: "region", value_field: "change", unit: "%", sort: "none", ...extra }, rows);

const plain = diverging();
const bars = tags(plain, /<rect data-role="data-bar"[^>]*>/g);
assert.equal(bars.length, rows.length);
bars.forEach((bar, i) => {
  assert.equal(attr(bar, "fill"), rows[i].change < 0 ? PALETTE.negative : PALETTE.positive, `bar ${i} colour by sign`);
  assert.equal(attr(bar, "fill-opacity"), undefined, "no highlight: full opacity");
});
assert.notEqual(PALETTE.positive, PALETTE.negative);
const zeroLine = plain.indexOf('data-role="zero-line"');
assert.ok(zeroLine > 0, "zero line drawn");
assert.ok(zeroLine < plain.indexOf('data-role="data-bar"'), "zero line is drawn before the bars");
assert.ok(!/font-weight="700"[^>]*>[-\d]/.test(tags(plain, /<text data-role="bar-value-label"[^>]*>/g).join("")), "no highlight: no bold value label");

const lit = diverging({ highlight_values: ["华东", "华南"] });
tags(lit, /<rect data-role="data-bar"[^>]*>/g).forEach((bar, i) => {
  const highlighted = ["华东", "华南"].includes(rows[i].region);
  assert.equal(attr(bar, "fill-opacity"), highlighted ? undefined : "0.45", `bar ${i} opacity`);
  assert.equal(attr(bar, "fill"), rows[i].change < 0 ? PALETTE.negative : PALETTE.positive, "sign colour kept under a highlight");
});
tags(lit, /<text data-role="bar-value-label"[^>]*>/g).forEach((label, i) => {
  assert.equal(attr(label, "font-weight"), ["华东", "华南"].includes(rows[i].region) ? "700" : "600", `label ${i} weight`);
});

// tight column: short names start well inside 70 px of the left edge (they used to end at x=235)
const categoryTexts = tags(lit, /<text x="[^"]+" y="[^"]+" text-anchor="end"[^>]*>[^<]*<\/text>/g)
  .map((t) => ({ x: Number(attr(t, "x")), name: t.replace(/<[^>]*>/g, "") })).filter((t) => names.includes(t.name));
assert.equal(categoryTexts.length, names.length);
for (const t of categoryTexts) assert.ok(t.x - t.name.length * 12 <= 70, `${t.name}: name starts at ${t.x - t.name.length * 12}`);
const firstBar = Math.min(...tags(lit, /<rect data-role="data-bar"[^>]*>/g).map((b) => Number(attr(b, "x"))));
const negLabels = tags(lit, /<text data-role="bar-value-label"[^>]*text-anchor="end"[^>]*>/g).map((t) => Number(attr(t, "x")));
assert.ok(Math.min(...negLabels) - 4 * 7.5 > Math.max(...categoryTexts.map((t) => t.x)), "negative value labels stay clear of the names");
assert.ok(firstBar > 0);

// ---- 3. dumbbell key ----------------------------------------------------------------------------
const dumbRows = Array.from({ length: 8 }, (_, i) => ({ region: names[i], y2019: 20 + i * 4, y2024: 30 + i * 3 }));
const dumbSpec = { ...base, reader_task: "comparison", chart_type: "dumbbell", category_field: "region", start_field: "y2019", end_field: "y2024", start_label: "2019年", end_label: "2024年", unit: "%" };
const dumb = renderVizSvg(dumbSpec, dumbRows);
const key = dumb.match(/<g data-role="dumbbell-key">(.*?)<\/g>/s)?.[1];
assert.ok(key, "dumbbell key present");
const keyDots = tags(key, /<circle[^>]*>/g).map((c) => attr(c, "fill"));
assert.deepEqual(keyDots, [PALETTE.accent2, PALETTE.accent], "key dots: start colour then end colour");
assert.deepEqual([...key.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]), ["2019年", "2024年"]);
const dataDots = tags(dumb.slice(dumb.indexOf("</g>")), /<circle[^>]*>/g);
assert.ok(dataDots.some((c) => attr(c, "fill") === PALETTE.accent2) && dataDots.some((c) => attr(c, "fill") === PALETTE.accent), "the plot dots use the same two colours");
const fallback = renderVizSvg({ ...dumbSpec, start_label: undefined, end_label: undefined }, dumbRows).match(/<g data-role="dumbbell-key">(.*?)<\/g>/s)[1];
assert.deepEqual([...fallback.matchAll(/>([^<]+)<\/text>/g)].map((m) => m[1]), ["y2019", "y2024"], "labels fall back to the field names");
// with a reference line the key sits above the band, not in it
const withRef = renderVizSvg({ ...dumbSpec, annotations: [{ type: "reference_line", text: "目标", value: 35, claim_id: "claim-round2" }] }, dumbRows);
const keyY = Number(attr(withRef.match(/<g data-role="dumbbell-key">.*?<text [^>]*>/s)[0].match(/<text [^>]*>$/)[0], "y"));
const refText = tags(withRef, /<text[^>]*>目标<\/text>/g)[0];
assert.ok(refText, "reference line label drawn");
assert.ok(keyY < Number(attr(refText, "y")) - 8, `key (y=${keyY}) is above the reference-line band (label y=${attr(refText, "y")})`);

// ---- 4. zh choropleth: no English word -----------------------------------------------------------
const bm = getBasemap(CHOROPLETH_BASEMAP_ID);
const fixture = JSON.parse(readFileSync(new URL("../fixtures/viz-round2-choropleth-rows.json", import.meta.url), "utf8"));
for (const [label, set] of Object.entries(fixture)) {
  const svg = renderVizSvg({
    ...base, reader_task: "spatial", chart_type: "choropleth", category_field: "country", value_field: "v", category_names: "worldbank", unit: "%",
    title: "非洲可再生能源消费占比", subtitle: "部分非洲经济体", alt: "非洲多国分级设色地图，颜色越深占比越高。", source_note: "世界银行",
    basemap_id: bm.id, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash,
  }, set);
  const shown = [...svg.matchAll(/>([^<>]+)</g)].map((m) => m[1]).filter((t) => t !== "viz-title" && t !== "viz-desc");
  const latin = [...new Set(shown.flatMap((t) => t.replace("Natural Earth", "").match(/[A-Za-z]+/g) ?? []))];
  assert.deepEqual(latin, [], `${label}: Latin words in a zh choropleth: ${latin.join(", ")}`);
}

// ---- other chart types are byte-identical to the base commit -----------------------------------------
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASE_COMMIT, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status === 0) {
  const dir = mkdtempSync(join(tmpdir(), "round2-base-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "b.tar"), archive.stdout);
  spawnSync("tar", ["-xf", join(dir, "b.tar"), "-C", dir]);
  const old = await import(pathToFileURL(join(dir, "runtime/pi/viz.mjs")).href);
  const cats = names.slice(0, 6).map((region, i) => ({ region, v: 10 + i * 7, w: 5 + i * 3 }));
  const series = ["A", "B"].flatMap((s, k) => Array.from({ length: 6 }, (_, i) => ({ year: 2018 + i, s, v: 10 + k * 5 + i * 2 })));
  for (const language of ["zh", "en"]) {
    const same = [
      [{ ...base, language, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "region", value_field: "v", unit: "%", sort: "desc", highlight_values: ["华北"] }, cats],
      [{ ...base, language, reader_task: "ranking", chart_type: "dot", category_field: "region", value_field: "v", unit: "%", sort: "desc" }, cats],
      [{ ...base, language, reader_task: "change", chart_type: "slope", category_field: "region", start_field: "v", end_field: "w", unit: "%" }, cats],
      [{ ...base, language, reader_task: "change", chart_type: "line", x_field: "year", value_field: "v", unit: "%" }, series.filter((r) => r.s === "A")],
      [{ ...base, language, reader_task: "comparison", chart_type: "diverging_bar", category_field: "region", value_field: "change", unit: "%", sort: "none", style: "legacy" }, rows],
    ];
    for (const [spec, data] of same) {
      let before, after;
      try { before = old.renderVizSvg(spec, data); } catch { continue; }
      after = renderVizSvg(spec, data);
      if (spec.chart_type === "diverging_bar") continue; // changed on purpose
      assert.equal(after, before, `${language} ${spec.chart_type} unchanged`);
    }
  }
}
console.log("ok test_viz_round2_defects");
