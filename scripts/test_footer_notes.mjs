// The note block under a chart (Eurostat style): one "注：" / "Note: " for the block, later entries start where the first
// entry's text starts and carry no prefix, every entry ends with a full stop. Covers the program's data-flag line
// (data_note), the model's note and the extreme-value line (extreme_note), desktop, compact and mobile.
// One entry: the line is the old line plus the full stop (checked byte for byte against the old renderer at review time).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { renderVizBundle, textUnits } from "../runtime/pi/viz.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rows = JSON.parse(readFileSync(join(ROOT, "fixtures/extreme_probe/t8_life.json"), "utf8")).rows;
const spec = {
  schema_version: "0.9.0", reader_task: "ranking", data_topology: "tabular", verification_mode: "draft", source_note: "公开统计",
  sql: "SELECT k, v FROM t", alt: "测试图测试图测试图测试图测试图测试图", chart_type: "horizontal_bar", category_field: "iso3",
  value_field: "life", unit: "岁", title: "预期寿命",
};
const notesOf = (svg, left) => [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="12"[^>]*>([^<]*)<\/text>/g)]
  .map((m) => ({ x: Number(m[1]), y: Number(m[2]), t: m[3] }))
  .filter((l) => l.x >= left && l.x < left + 60 && !/^(数据来源|Source)/.test(l.t))
  .slice(-3);
const views = (bundle) => [["desktop", bundle.desktop, 54], ...(bundle.compact ? [["compact", bundle.compact, 54]] : []), ...(bundle.mobile ? [["mobile", Array.isArray(bundle.mobile) ? bundle.mobile.at(-1) : bundle.mobile, 32]] : [])];

const DATA = "乍得 2024 年为估计值", NOTE = "模型写的说明", EXTREME = "利比里亚 92.8%，远高于其余数据。";
for (const [lang, prefix, end] of [["zh", "注：", "。"], ["en", "Note: ", "."]]) {
  const indent = Math.round(textUnits(prefix) * 12 * 0.56);
  for (const opts of [{ mobilePages: false }, { mobilePages: false, compact: true }, { mobilePages: true }]) {
    // three entries: one prefix, the later two line up with the first entry's text, each ends with a full stop
    for (const [view, svg, left] of views(renderVizBundle({ ...spec, language: lang, data_note: DATA, note: NOTE, extreme_note: EXTREME }, rows, opts))) {
      const want = view === "mobile" ? [`${prefix}${NOTE}${end}`, EXTREME] : [`${prefix}${DATA}${end}`, `${NOTE}${end}`, EXTREME];
      const got = notesOf(svg, left).slice(-want.length);
      assert.deepEqual(got.map((l) => l.t), want, `${lang} ${view}: one prefix for the block, full stops`);
      assert.equal(got[0].x, left, `${lang} ${view}: the first entry starts at the margin`);
      for (const l of got.slice(1)) assert.equal(l.x, left + indent, `${lang} ${view}: a later entry starts where the first entry's text starts`);
      for (const [i, l] of got.entries()) if (i) assert.equal(l.y - got[i - 1].y, 16, `${lang} ${view}: one entry per line`);
    }
    // one entry: prefix at the margin, full stop added; already ended: no second full stop
    for (const [field, text, printed] of [["note", NOTE, `${NOTE}${end}`], ["note", `${NOTE}${end}`, `${NOTE}${end}`], ["extreme_note", EXTREME, EXTREME]]) {
      for (const [view, svg, left] of views(renderVizBundle({ ...spec, language: lang, [field]: text }, rows, opts))) {
        const got = notesOf(svg, left).slice(-1);
        assert.deepEqual(got.map((l) => [l.x, l.t]), [[left, `${prefix}${printed}`]], `${lang} ${view} ${field}: one entry keeps its line`);
      }
    }
  }
}
// mutation guard: the block rule must not turn on for a chart with no notes
const plain = renderVizBundle({ ...spec, language: "zh" }, rows, { mobilePages: false }).desktop;
assert.ok(!plain.includes("注："), "no note, no prefix");
console.log("footer notes: PASS");
