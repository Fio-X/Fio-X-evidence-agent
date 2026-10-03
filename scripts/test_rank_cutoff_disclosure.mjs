#!/usr/bin/env node
// rank_cutoff says what it cut and never fixes a value: ranks are positive integers (RANK_NOT_INTEGER names the
// rows, nothing is rounded), a missing end means "outside the ranking", the chart carries a note with the shown
// and hidden counts, and rank_cutoff is refused unless the chart is a slope. Synthetic data only.
import assert from "node:assert/strict";
import { lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";

const base = {
  schema_version: "0.9.0", takeaway: "t", title: "Ranks", subtitle: "synthetic", alt: "A synthetic rank slope chart used to check the rank cut note.",
  source_note: "synthetic fixture", claim_id: "claim-rank", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh",
  verification_mode: "draft", reader_task: "change", chart_type: "slope", category_field: "c", start_field: "a", end_field: "b", start_label: "2000", end_label: "2024", unit: "名", rank_cutoff: 10,
};
// 15 rows, cutoff 10: rows 1-7 stay, rows 8-10 drop out, rows 11-13 enter, rows 14-15 are outside at both ends
const names = "ABCDEFGHIJKLMNO".split("");
const ends = [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 8, 9, 10, 14, 15];
const fifteen = names.map((c, i) => ({ c: `项${c}`, a: i + 1, b: ends[i] }));
// the footer wraps long notes over several lines, so compare with every space removed
const text = (svg) => svg.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
const sq = (t) => t.replace(/\s+/g, "");
const svgOf = (spec, rows) => renderVizBundle(spec, rows, { mobilePages: false }).desktop;
const lintCodes = (spec, rows) => lintVizSpec(spec, rows, {}).blockers.filter((b) => b.startsWith("RANK_"));

// the note shows the right K and M
assert.ok(text(svgOf(base, fifteen)).includes(sq("只显示任一期进入前 10 名的 13 项；另有 2 项两期都不在前 10 名，未画出。")), "zh note with K=13, M=2");
assert.ok(text(svgOf({ ...base, language: "en" }, fifteen)).includes(sq("Showing only the 13 items that ranked in the top 10 in either period; another 2 were outside the top 10 in both periods and are not drawn.")), "en note");
// M = 0 leaves out the second clause
{
  const rows = fifteen.slice(0, 13);
  const zh = text(svgOf(base, rows));
  assert.ok(zh.includes(sq("只显示任一期进入前 10 名的 13 项。")), "zh note without the second clause");
  assert.ok(!zh.includes(sq("另有")), "no hidden clause when M is 0");
  assert.ok(text(svgOf({ ...base, language: "en" }, rows)).includes(sq("in either period.")), "en note without the second clause");
}
// 20 rows, 5 per side cut: K and M follow the rows, not a fixed number
{
  const rows = [...fifteen, ...["P", "Q", "R", "S", "T"].map((c, i) => ({ c: `项${c}`, a: 16 + i, b: 16 + i }))];
  assert.ok(text(svgOf(base, rows)).includes(sq("13 项；另有 7 项两期都不在前 10 名")), "K=13, M=7 for 20 rows");
}
// a missing end is outside the ranking: drawn as dropping out / entering when the other end is within the cut, else left out
{
  const rows = [{ c: "甲", a: 3, b: null }, { c: "乙", a: undefined, b: 2 }, { c: "丙", a: "", b: "" }, { c: "丁", a: 1, b: 1 }];
  assert.deepEqual(lintCodes(base, rows), [], "a missing end is allowed");
  const svg = svgOf(base, rows);
  assert.ok(text(svg).includes(sq("只显示任一期进入前 10 名的 3 项；另有 1 项两期都不在前 10 名，未画出。")), "missing ends: 3 shown, 1 hidden");
  assert.equal([...svg.matchAll(/data-role="rank-leave"/g)].length, 1, "甲 drops out");
  assert.equal([...svg.matchAll(/data-role="rank-join"/g)].length, 1, "乙 enters");
  assert.ok(!text(svg).includes(sq("丙  ")), "丙 is not drawn");
}
// ranks are positive integers: refused, never rounded, rows named
for (const [bad, field] of [[3.5, "a"], [0, "b"], [-2, "a"], ["abc", "b"], [10.0000001, "a"]]) {
  const rows = fifteen.map((r, i) => (i === 4 ? { ...r, [field]: bad } : r));
  const found = lintCodes(base, rows);
  assert.equal(found.length, 1, `rank ${bad} refused`);
  assert.match(found[0], /^RANK_NOT_INTEGER/);
  assert.ok(found[0].includes(sq("项E")) && found[0].includes(`${field}=${bad}`), `the row is named: ${found[0]}`);
}
assert.deepEqual(lintCodes(base, fifteen), [], "integer ranks pass");
// applicability: slope only
for (const chart_type of ["horizontal_bar", "dumbbell", "line"]) {
  const found = validateVizSpec({ ...base, chart_type }).filter((e) => e.startsWith("RANK_CUTOFF_NOT_APPLICABLE"));
  assert.equal(found.length, 1, `rank_cutoff refused on ${chart_type}`);
}
assert.deepEqual(validateVizSpec(base).filter((e) => e.includes(sq("rank_cutoff"))), []);
// without rank_cutoff the slope is the ordinary value slope, and a fractional value is fine there
assert.deepEqual(lintVizSpec({ ...base, rank_cutoff: undefined }, fifteen.map((r) => ({ ...r, a: r.a + 0.5 })), {}).blockers.filter((b) => b.startsWith("RANK_")), []);
console.log("rank_cutoff disclosure: all checks passed");
