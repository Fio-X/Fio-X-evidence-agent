// New route (NEWSROOM_NEXT=1) chart rules that apply to every chart of their kind, not one page: a percent bar chart prints
// the unit and the same decimals on every value label; a choropleth legend is fitted to the data's own range when the
// linear nice edges would span far more (0-100 for 14.9-65.4); the map frame drops a far territory up to a quarter of
// its country's mainland. Off the new route each stays as before. Synthetic rows (the q1 values: EU renewable shares, 2025).
import assert from "node:assert/strict";
import { renderVizSvg } from "../runtime/pi/viz.mjs";
import { classBreaks, nextFramingOptions } from "../runtime/pi/choropleth.mjs";

let checks = 0;
const check = (name, fn) => { try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; } checks += 1; };
const withNext = (on, fn) => {
  const before = process.env.NEWSROOM_NEXT;
  if (on) process.env.NEWSROOM_NEXT = "1"; else delete process.env.NEWSROOM_NEXT;
  try { return fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_NEXT; else process.env.NEWSROOM_NEXT = before; }
};

const BAR = { schema_version: "0.7.0", reader_task: "ranking", takeaway: "t", title: "t", subtitle: "s", alt: "a", source_note: "s", claim_id: "c", sql: "SELECT 1",
  unit: "%", highlight_values: [], direct_labels: true, annotations: [], language: "zh", chart_type: "horizontal_bar", category_field: "c", value_field: "v", sort: "desc" };
const BAR_ROWS = [["甲", 65.4], ["乙", 53], ["丙", 26], ["丁", 14.9]].map(([c, v]) => ({ c, v }));
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);
check("percent bar: every value label has the unit and one decimal on the new route; off, only the first", () => {
  const labels = (on) => texts(withNext(on, () => renderVizSvg(BAR, BAR_ROWS))).filter((t) => /^\d/.test(t) && !/^(0|20|40|60%)$/.test(t));
  assert.deepEqual(labels(true), ["65.4%", "53.0%", "26.0%", "14.9%"]);
  assert.deepEqual(labels(false), ["65.4%", "53", "26", "14.9"]);
});

const Q1 = [14.9, 16.3, 17.2, 18.7, 18.8, 19.1, 19.6, 20.2, 20.5, 21.5, 22.7, 22.7, 23.9, 23.9, 25.4, 25.6, 26, 26.9, 28.5, 36.7, 38.5, 42.3, 44.2, 46.3, 48.2, 53, 65.4];
check("legend: fitted to the data's range on the new route, open at both ends; off, the linear nice edges", () => {
  const on = withNext(true, () => classBreaks(Q1));
  assert.deepEqual(on, { breaks: [14.9, 20, 30, 40, 50, 65.4], skewed: true, openBottom: true, openTop: true });
  const off = withNext(false, () => classBreaks(Q1));
  assert.equal(off.skewed, false);
  assert.ok(off.breaks[off.breaks.length - 1] - off.breaks[0] > 1.5 * (65.4 - 14.9), JSON.stringify(off.breaks));
  // Already tight linear edges are kept as they are on the new route too.
  const tight = [10, 22, 35, 48, 61, 74, 90];
  assert.deepEqual(withNext(true, () => classBreaks(tight)), withNext(false, () => classBreaks(tight)));
});
const EU = ["MT", "IE", "BE", "LU", "NL", "PL", "BG", "SK", "CZ", "HU", "CY", "FR", "DE", "IT", "EL", "SI", "RO", "ES", "HR", "LT", "PT", "AT", "EE", "LV", "DK", "FI", "SE"];
const MAP = { schema_version: "0.7.0", reader_task: "spatial", takeaway: "t", title: "t", subtitle: "s", alt: "a", source_note: "s", claim_id: "c", sql: "SELECT 1",
  unit: "%", language: "zh", chart_type: "choropleth", category_field: "geo", value_field: "v", category_names: "iso2", annotations: [],
  basemap_id: "naturalearth_admin0_50m", basemap_source_url: "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/",
  basemap_license: "Public domain (Natural Earth terms of use)", basemap_content_hash: "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e" };
check("legend: on the new route every class is labelled with its own bounds; off, the open ends and edge ticks", () => {
  const legend = (on) => texts(withNext(on, () => renderVizSvg(MAP, EU.map((geo, i) => ({ geo, v: Q1[i] }))))).filter((t) => /^(&lt;|<|\u2265)?\d/.test(t) && !/^\d+\.$/.test(t));
  const on = legend(true);
  for (const label of ["&lt;20", "20\u201330", "30\u201340", "40\u201350", "\u226550%"]) assert.ok(on.includes(label), `${label} in ${JSON.stringify(on)}`);
  assert.ok(!legend(false).includes("20\u201330"), JSON.stringify(legend(false)));
});
check("map key: on the new route the legend is titled with the measure and unit, and the numbered key sits beside it at 16px; off, a bare unit and any key under it", () => {
  const spec = { ...MAP, measure_semantics: [{ field: "v", phenomenon: "可再生能源占比", unit: "%" }] };
  const svg = (on) => withNext(on, () => renderVizSvg(spec, EU.map((geo, i) => ({ geo, v: Q1[i] }))));
  const title = (s) => s.match(/data-role="choropleth-legend-title"[^>]*>([^<]*)</)?.[1];
  const key = (s) => [...s.matchAll(/data-role="choropleth-footnote-number" x="([\d.]+)" y="([\d.]+)"[^>]*font-size="(\d+)"/g)].map((m) => m.slice(1).map(Number));
  const swatchY = (s) => Number(s.match(/data-role="choropleth-no-data-swatch" x="([\d.]+)" y="([\d.]+)"/)[2]);
  const ndRight = (s) => { const m = s.match(/data-role="choropleth-no-data-swatch" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/); return Number(m[1]) + Number(m[2]); };
  const on = svg(true), off = svg(false);
  assert.equal(title(on), "可再生能源占比（%）");
  assert.equal(title(off), "%");
  const onKey = key(on), offKey = key(off);
  assert.ok(onKey.length > 0, "the new route numbers the small countries");
  assert.ok(onKey.every(([x, , size]) => x > ndRight(on) && size === 16), JSON.stringify(onKey));
  assert.ok(Math.min(...onKey.map(([, y]) => y)) < swatchY(on) + 30, "the key starts on the legend's row");
  assert.ok(offKey.every(([x, y, size]) => y > swatchY(off) + 30 && size !== 16), JSON.stringify(offKey));
});
check("map frame: a far territory up to a quarter of its mainland is left out on the new route; off, the old default", () => {
  assert.deepEqual(withNext(true, () => nextFramingOptions()), { tinyShare: 0.25 });
  assert.equal(withNext(false, () => nextFramingOptions()), undefined);
});

console.log(`next chart rules: ${checks} checks -- PASS`);
