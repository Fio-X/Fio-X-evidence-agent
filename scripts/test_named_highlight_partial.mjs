// K58: a title/takeaway that names a plotted value which a non-empty
// highlight_values does not carry is warned about too (lint warning + critic
// title_names_unhighlighted, -12). Synthetic data only.
import assert from "node:assert/strict";
import { critiqueViz, lintVizSpec, titleNamedHighlightValues } from "../runtime/pi/viz.mjs";

process.env.NEWSROOM_NAMED_HIGHLIGHT_PARTIAL = "1";
const base = {
  schema_version: "0.9.0", reader_task: "comparison", title: "T", alt: "A synthetic chart of one measure across several named items.",
  source_note: "synthetic", verification_mode: "draft", unit: "n", sql: "SELECT 1", annotations: [],
};
const bar = (title, over = {}) => ({ ...base, chart_type: "horizontal_bar", category_field: "name", value_field: "v", sort: "desc", title, ...over });
const rows = ["Alpha", "Bravo", "Cobalt", "Delta", "Echo", "Foxtrot"].map((name, i) => ({ name, v: 60 - i * 7 }));
const hint = (spec, r = rows) => lintVizSpec(spec, r).warnings.filter((w) => w.includes("highlight_values") && !w.includes("match no"));
const critic = (spec, r = rows) => critiqueViz(spec, r, lintVizSpec(spec, r));
const codes = (c) => c.issues.map((i) => i.code);
const raws = (spec, r = rows) => titleNamedHighlightValues(spec, r).map((n) => n.raw).sort();

// names A, highlight [B]: warn about A, in lint and critic
{
  const spec = bar("Alpha leads the field", { highlight_values: ["Bravo"] });
  assert.deepEqual(hint(spec), ['The title names "Alpha" but highlight_values ["Bravo"] does not include it; suggest adding ["Alpha"]']);
  const c = critic(spec);
  assert.ok(codes(c).includes("title_names_unhighlighted"));
  assert.equal(c.issues.find((i) => i.code === "title_names_unhighlighted").severity, "warning");
  const quiet = critic(bar("Plain ranking", { highlight_values: ["Bravo"] }));
  assert.equal(quiet.score - c.score, 12, "penalty is 12");
}
// names A and B, highlight [A]: warn about B only
{
  const spec = bar("Alpha and Bravo lead the field", { highlight_values: ["Alpha"] });
  assert.deepEqual(raws(spec), ["Bravo"]);
  assert.deepEqual(hint(spec), ['The title names "Bravo" but highlight_values ["Alpha"] does not include it; suggest adding ["Bravo"]']);
}
// names A, highlight [A]; names A and B, highlight [A, B]: silent
for (const [title, hv] of [["Alpha leads the field", ["Alpha"]], ["Alpha and Bravo lead the field", ["Alpha", "Bravo"]]]) {
  const spec = bar(title, { highlight_values: hv });
  assert.deepEqual(raws(spec), []);
  assert.equal(hint(spec).length, 0);
  assert.ok(!codes(critic(spec)).includes("title_names_unhighlighted"));
}
// five names is a list, even though only some are highlighted: silent
{
  const spec = bar("Alpha, Bravo, Cobalt, Delta and Echo", { highlight_values: ["Alpha"] });
  assert.deepEqual(raws(spec), []);
  assert.equal(hint(spec).length, 0);
}
// four names still report the missing three
assert.deepEqual(raws(bar("Alpha, Bravo, Cobalt and Delta", { highlight_values: ["Alpha"] })), ["Bravo", "Cobalt", "Delta"]);
// takeaway counts
assert.deepEqual(raws(bar("Ranking", { takeaway: "Echo is last", highlight_values: ["Alpha"] })), ["Echo"]);

// one case per chart type in HIGHLIGHT_NAME_FIELD, empty and partial highlight
{
  const items = ["Alpha", "Bravo", "Cobalt"];
  const mk = (type, field) => ({ ...base, chart_type: type, [field]: "name", title: "Bravo stands out", value_field: "v" });
  const cases = [["horizontal_bar", "category_field"], ["dot", "category_field"], ["diverging_bar", "category_field"], ["slope", "category_field"], ["multi_line", "series_field"], ["scatter", "label_field"]];
  const r = items.map((name, i) => ({ name, v: i + 1 }));
  for (const [type, field] of cases) {
    assert.deepEqual(raws(mk(type, field), r), ["Bravo"], `${type} empty highlight`);
    assert.deepEqual(raws({ ...mk(type, field), highlight_values: ["Alpha"] }, r), ["Bravo"], `${type} partial highlight`);
    assert.deepEqual(raws({ ...mk(type, field), highlight_values: ["Bravo"] }, r), [], `${type} named and highlighted`);
  }
  assert.deepEqual(raws({ ...mk("line", "series_field"), highlight_values: ["Alpha"] }, r), [], "a chart type outside the table is not checked");
}
// zh with category_names: the title names the displayed name, the hint carries the raw value
{
  const r = [{ name: "SGP", v: 5 }, { name: "KAZ", v: 3 }, { name: "MYS", v: 2 }];
  const spec = bar("新加坡领先", { language: "zh", category_names: "iso3", highlight_values: ["KAZ"] });
  assert.deepEqual(hint(spec, r), ['标题点名了『新加坡』，但 highlight_values ["KAZ"] 里没有；建议补上 ["SGP"]']);
  assert.ok(codes(critic(spec, r)).includes("title_names_unhighlighted"));
  const both = bar("新加坡领先", { language: "zh", category_names: "iso3", highlight_values: ["SGP"] });
  assert.equal(hint(both, r).length, 0);
}
// empty highlight: the wording is unchanged, byte for byte
{
  assert.deepEqual(hint(bar("Alpha leads the field")), ['The title names "Alpha" but highlight_values is empty; suggest ["Alpha"]']);
  const zh = [{ name: "新加坡", v: 5 }, { name: "印度", v: 3 }];
  assert.deepEqual(hint(bar("新加坡一国吸走了最多的投资", { language: "zh" }), zh), ['标题点名了『新加坡』，但 highlight_values 为空；建议填 ["新加坡"]']);
}
// no_visual_focus is untouched: a partial highlight never gets it, an empty unnamed one still does
assert.ok(!codes(critic(bar("Plain ranking", { highlight_values: ["Bravo"] }))).includes("no_visual_focus"));
assert.ok(codes(critic(bar("Plain ranking"))).includes("no_visual_focus"));

console.log("PASS: test_named_highlight_partial");

// Switch not exactly "1": a non-empty highlight_values ends the check, as before.
for (const value of [undefined, "0", "true", ""]) {
  if (value === undefined) delete process.env.NEWSROOM_NAMED_HIGHLIGHT_PARTIAL; else process.env.NEWSROOM_NAMED_HIGHLIGHT_PARTIAL = value;
  const spec = bar("Alpha leads the field", { highlight_values: ["Bravo"] });
  assert.deepEqual(hint(spec), [], `switch ${JSON.stringify(value)}`);
  assert.ok(!codes(critic(spec)).includes("title_names_unhighlighted"), `switch ${JSON.stringify(value)}`);
  assert.deepEqual(raws(bar("Alpha leads the field")), ["Alpha"], `switch ${JSON.stringify(value)}: the empty-highlight hint is unchanged`);
}
console.log("K58 switch off: PASS");
