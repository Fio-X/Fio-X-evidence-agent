// Emphasis hint: a title/takeaway that names a plotted category or series
// while highlight_values is empty gets a lint warning and a critic warning
// (-12, replacing the generic no_visual_focus info). Synthetic data only.
import assert from "node:assert/strict";
import { critiqueViz, lintVizSpec, titleNamedHighlightValues } from "../runtime/pi/viz.mjs";

const base = {
  schema_version: "0.9.0", reader_task: "comparison", title: "T", alt: "A synthetic chart of one measure across several named items.",
  source_note: "synthetic", verification_mode: "draft", unit: "n", sql: "SELECT 1", annotations: [],
};
const bar = (title, rows, over = {}) => ({ ...base, chart_type: "horizontal_bar", category_field: "name", value_field: "v", sort: "desc", title, ...over });
const countries = ["新加坡", "哈萨克斯坦", "马来西亚", "印度尼西亚", "印度", "俄罗斯"].map((name, i) => ({ name, v: 60 - i * 7 }));
const years = [2013, 2014, 2015, 2016, 2017].map((name, i) => ({ name, v: 3 + i * 4 }));
const manyYears = Array.from({ length: 8 }, (_, i) => ({ name: 2010 + i, v: i + 1 }));

const hint = (spec, rows) => lintVizSpec(spec, rows).warnings.filter((w) => w.includes("highlight_values") && !w.includes("match no"));
const critic = (spec, rows) => critiqueViz(spec, rows, lintVizSpec(spec, rows));
const codes = (c) => c.issues.map((i) => i.code);

// --- positives -----------------------------------------------------------
{
  const spec = bar("新加坡一国吸走了最多的投资", countries, { language: "zh" });
  assert.deepEqual(hint(spec, countries), ['标题点名了『新加坡』，但 highlight_values 为空；建议填 ["新加坡"]']);
  const c = critic(spec, countries);
  assert.ok(codes(c).includes("title_names_unhighlighted"));
  assert.ok(!codes(c).includes("no_visual_focus"), "the generic info is not double counted");
  assert.equal(c.issues.find((i) => i.code === "title_names_unhighlighted").severity, "warning");
  assert.ok(c.suggestions.includes('标题点名了『新加坡』，但 highlight_values 为空；建议填 ["新加坡"]'));
  const plain = critic(bar("投资排名", countries), countries);
  assert.equal(plain.score - c.score, 12 - 6, "-12 replaces -6");
}
{
  const spec = bar("伙伴圈在2015年和2017年扩得最快", years, { language: "zh" });
  assert.deepEqual(hint(spec, years), ['标题点名了『2015』『2017』，但 highlight_values 为空；建议填 ["2015","2017"]']);
  assert.deepEqual(titleNamedHighlightValues(spec, years).map((n) => n.raw), ["2015", "2017"]);
}
{
  const rows = ["Alpha", "Beta", "Gamma"].flatMap((series, s) => [1, 2, 3].map((x) => ({ series, x, v: x * (s + 1) })));
  const spec = { ...base, chart_type: "multi_line", x_field: "x", value_field: "v", series_field: "series", title: "Beta pulls ahead of the rest" };
  assert.deepEqual(hint(spec, rows), ['The title names "Beta" but highlight_values is empty; suggest ["Beta"]']);
  assert.ok(codes(critic(spec, rows)).includes("title_names_unhighlighted"));
  // takeaway counts too; subtitle and note do not
  assert.equal(hint({ ...spec, title: "Pulling ahead", takeaway: "Gamma wins" }, rows).length, 1);
  assert.equal(hint({ ...spec, title: "Pulling ahead", subtitle: "Gamma wins", note: "Gamma", source_note: "Gamma" }, rows).length, 0);
}
{
  // displayed (category_names) name matches, hint carries the raw value
  const rows = [{ name: "SGP", v: 5 }, { name: "KAZ", v: 3 }, { name: "MYS", v: 2 }];
  const spec = bar("新加坡领先", rows, { language: "zh", category_names: "iso3" });
  assert.deepEqual(hint(spec, rows), ['标题点名了『新加坡』，但 highlight_values 为空；建议填 ["SGP"]']);
}
{
  // strip_plot and mirrored_bar paint highlight_values on their category_field (a group; a band), so the hint reaches them too
  const groups = ["Group Alpha", "Group Beta", "Group Gamma"];
  const strip = groups.flatMap((g, gi) => [1, 2, 3, 4].map((k) => ({ g, u: `${g} unit ${k}`, v: 2 + gi * 3 + k })));
  const stripSpec = { ...base, chart_type: "strip_plot", reader_task: "distribution", category_field: "g", value_field: "v", label_field: "u", title: "Group Beta spreads the widest" };
  assert.deepEqual(hint(stripSpec, strip), ['The title names "Group Beta" but highlight_values is empty; suggest ["Group Beta"]']);
  assert.ok(codes(critic(stripSpec, strip)).includes("title_names_unhighlighted"));
  assert.equal(hint({ ...stripSpec, highlight_values: ["Group Beta"] }, strip).length, 0, "a declared highlight silences the strip_plot hint");
  assert.equal(hint({ ...stripSpec, title: "Spread by group" }, strip).length, 0, "an unnamed group raises nothing");

  const bands = ["Under 20", "20 to 39", "40 to 64", "65 and over"];
  const pyramid = ["Side A", "Side B"].flatMap((side, s) => bands.map((band, b) => ({ band, side, share: 10 + b * 4 + s * 2 })));
  const mirroredSpec = { ...base, chart_type: "mirrored_bar", category_field: "band", series_field: "side", value_field: "share", title: "65 and over is the fastest growing band" };
  assert.deepEqual(hint(mirroredSpec, pyramid), ['The title names "65 and over" but highlight_values is empty; suggest ["65 and over"]']);
  assert.ok(codes(critic(mirroredSpec, pyramid)).includes("title_names_unhighlighted"));
  assert.equal(hint({ ...mirroredSpec, highlight_values: ["65 and over"] }, pyramid).length, 0, "a declared highlight silences the mirrored_bar hint");
  assert.equal(hint({ ...mirroredSpec, title: "Share of each band" }, pyramid).length, 0, "an unnamed band raises nothing");
}

// --- negatives -----------------------------------------------------------
{
  const declared = bar("新加坡一国吸走了最多的投资", countries, { highlight_values: ["新加坡"] });
  assert.equal(hint(declared, countries).length, 0);
  assert.ok(!codes(critic(declared, countries)).includes("title_names_unhighlighted"));
  const unnamed = bar("投资高度集中在少数目的地", countries);
  assert.equal(hint(unnamed, countries).length, 0);
  assert.ok(!codes(critic(unnamed, countries)).includes("title_names_unhighlighted"));
  assert.ok(codes(critic(unnamed, countries)).includes("no_visual_focus"), "generic info is kept when nothing is named");
  assert.equal(hint(bar("新加坡", countries, { chart_type: "heatmap", x_field: "name", y_field: "name" }), countries).length, 0, "chart types that never paint highlights are ignored");
  // stacked_bar_100 highlights one segment (highlight_segment), never highlight_values, so naming an entity in its title is not an emphasis gap
  const stacked = ["Entity Alpha", "Entity Beta", "Entity Gamma"].flatMap((e, i) => [["Low", 30 - i * 5], ["Mid", 40], ["High", 30 + i * 5]].map(([seg, v]) => ({ e, seg, v })));
  const stackedSpec = { ...base, reader_task: "part_to_whole", chart_type: "stacked_bar_100", unit: "%", category_field: "e", series_field: "seg", value_field: "v", highlight_segment: "Low", title: "Entity Beta has the smallest Low share" };
  assert.equal(titleNamedHighlightValues(stackedSpec, stacked).length, 0);
  assert.equal(hint(stackedSpec, stacked).length, 0);
  assert.ok(!codes(critic(stackedSpec, stacked)).includes("title_names_unhighlighted"));
}
{
  // longest name first: 印度尼西亚 must not also count 印度 (and vice versa when only 印度 is named)
  const hits = (title) => titleNamedHighlightValues(bar(title, countries), countries).map((n) => n.raw);
  assert.deepEqual(hits("印度尼西亚的投资增速最快"), ["印度尼西亚"]);
  assert.deepEqual(hits("印度的投资增速最快"), ["印度"]);
  assert.deepEqual(hits("印度与印度尼西亚并列"), ["印度尼西亚", "印度"]);
}
{
  // numeric categories never match inside a longer number; 1-char names are not compared
  const rows = [{ name: 2015, v: 1 }, { name: 2016, v: 2 }, { name: 5, v: 3 }];
  assert.deepEqual(titleNamedHighlightValues(bar("在20150家企业中", rows), rows), []);
  assert.deepEqual(titleNamedHighlightValues(bar("共5个国家", rows), rows), [], "single-character names are skipped");
  assert.deepEqual(titleNamedHighlightValues(bar("2015年最高", rows), rows).map((n) => n.raw), ["2015"]);
  assert.deepEqual(titleNamedHighlightValues(bar("Q2015X", rows), rows), [], "no digit or letter neighbours");
}
{
  // more than four distinct hits is a list, not a focus
  const spec = bar("2010、2011、2012、2013、2014年逐年上升", manyYears);
  assert.deepEqual(titleNamedHighlightValues(spec, manyYears), []);
  assert.equal(hint(spec, manyYears).length, 0);
  assert.ok(!codes(critic(spec, manyYears)).includes("title_names_unhighlighted"));
  const four = bar("2010、2011、2012、2013年逐年上升", manyYears);
  assert.equal(titleNamedHighlightValues(four, manyYears).length, 4, "exactly four still reports");
}
{
  // no hit => lint and critic outputs carry nothing new
  const spec = bar("投资高度集中在少数目的地", countries);
  const lint = lintVizSpec(spec, countries);
  assert.ok(lint.warnings.every((w) => !w.includes("highlight_values")));
  assert.deepEqual(codes(critic(spec, countries)), ["no_visual_focus"]);
}
console.log("emphasis hint: ok");
