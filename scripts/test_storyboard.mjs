#!/usr/bin/env node
// 1012r storyboard page rules (NEWSROOM_STORYBOARD) and form-selection step (NEWSROOM_FORM_SKILL): off/on behaviour.
// Run: node scripts/test_storyboard.mjs   (re-runs itself with both switches set for the "on" half)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const mode = process.argv[2];
const sb = await import(R + "storyboard.mjs");
const fs = await import(R + "form_selection.mjs");
const { validateInfographicSpec, lintInfographicSpec } = await import(R + "infographic.mjs");

const KINDS = ["lead_in", "scale", "cause", "space", "compare", "basis"];
const board = (over = {}) => {
  const modules = [];
  KINDS.forEach((kind, i) => {
    const n = i + 1;
    modules.push({ id: `p${n}`, type: "panel", panel_no: n, panel_kind: kind, heading: "这一格只说一件事", body_module_id: `b${n}`, note_module_id: `n${n}`, story_node_ids: [`s${n}`], color_use: ["#d0746f", "ink"] });
    modules.push({ id: `b${n}`, type: i === 0 ? "hero_stat" : "visual", story_node_ids: [`s${n}`], manifest_ref: `m${n}`, visual_grammar: "trend", value: 1, label: "x", claim_id: "c1" });
    modules.push({ id: `n${n}`, type: "text", story_node_ids: [`s${n}`], body: "短注", claim_ids: ["c1"] });
  });
  return { schema_version: "1.5.0", language: "zh", color_legend: [{ color: "#d0746f", meaning_id: "synthetic" }], modules, ...over };
};
const panel = (spec, n) => spec.modules.find((m) => m.id === `p${n}`);
const blockers = (spec, graph = null) => sb.storyboardBlockers(spec, graph);
const has = (list, key) => list.some((b) => b.startsWith(key));

if (mode !== "on") {
  // off: a panel is an unsupported type and the page fields are refused; the form fields do not exist
  ok(validateInfographicSpec(board()).some((e) => /STORYBOARD_DISABLED/.test(e)), "off: panel refused");
  ok(validateInfographicSpec({ ...board({ color_legend: undefined }), modules: [], render_style: "pencil" }).some((e) => /STORYBOARD_DISABLED/.test(e)), "off: render_style refused");
  ok(sb.expandPanels(board()) === board() || JSON.stringify(sb.expandPanels(board())) === JSON.stringify(board()), "off: expandPanels returns the spec unchanged");
  ok(fs.formSkillEnabled() === false && sb.storyboardEnabled() === false, "off: both switches off");
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "on"], { env: { ...process.env, NEWSROOM_STORYBOARD: "1", NEWSROOM_FORM_SKILL: "1" }, encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status, 0, "on half failed");
  console.log(`storyboard (off half) PASS checks=${checks}`);
  process.exit(0);
}

// ---- storyboard on
ok(blockers(board()).length === 0, `clean board passes: ${blockers(board())}`);
{ // numbering broken: a gap, a repeat
  const gap = board(); panel(gap, 4).panel_no = 9;
  ok(has(blockers(gap), "storyboard_numbering"), "numbering gap blocked");
  const dup = board(); panel(dup, 3).panel_no = 2;
  ok(has(blockers(dup), "storyboard_numbering"), "numbering repeat blocked");
}
{ // numbering against story order
  const graph = { nodes: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}` })) };
  ok(blockers(board(), graph).length === 0, "story order matches");
  const swapped = board(); panel(swapped, 2).story_node_ids = ["s6"];
  ok(has(blockers(swapped, graph), "storyboard_story_order"), "numbers out of story_node order blocked");
}
{ // lead-in not first, basis not last
  const bad = board(); panel(bad, 1).panel_kind = "scale"; panel(bad, 2).panel_kind = "lead_in";
  ok(has(blockers(bad), "storyboard_lead_in"), "lead-in not first blocked");
  const bad2 = board(); panel(bad2, 6).panel_kind = "scale"; panel(bad2, 5).panel_kind = "basis";
  ok(has(blockers(bad2), "storyboard_basis"), "basis not last blocked");
}
{ // titles
  const nw = board(); panel(nw, 2).heading = "三个州占了大头";
  ok(has(blockers(nw), "storyboard_title_number_word"), "title with number word blocked");
  const two = board(); panel(two, 2).heading = "先说这个。再说那个";
  ok(has(blockers(two), "storyboard_title_sentences"), "two title sentences blocked");
  const one = board(); panel(one, 2).heading = "先说这个。";
  ok(blockers(one).length === 0, "one sentence with its full stop passes");
  const long = board(); panel(long, 2).heading = "很".repeat(30);
  ok(has(blockers(long), "storyboard_title_length"), "over-long title blocked");
  const empty = board(); panel(empty, 2).heading = "";
  ok(sb.panelFieldErrors(panel(empty, 2)).some((e) => /heading/.test(e)), "empty title is a shape error");
}
{ // one colour, one meaning
  const two = board(); two.color_legend.push({ color: "#D0746F", meaning_id: "low-fall" });
  ok(has(blockers(two), "storyboard_one_color_one_meaning"), "one colour two meanings blocked (case-insensitive hex)");
  const many = board(); many.color_legend.push({ color: "#9bb0c4", meaning_id: "synthetic" });
  ok(blockers(many).length === 0, "one meaning in two colours is allowed");
  const unreg = board(); panel(unreg, 3).color_use = ["#123456"];
  ok(has(blockers(unreg), "storyboard_color_use"), "colour not in legend blocked");
  const none = board(); delete none.color_legend;
  ok(has(blockers(none), "storyboard_color_legend"), "missing legend blocked");
}
{ // panels reference real, single-use modules
  const missing = board(); panel(missing, 2).body_module_id = "nope";
  ok(has(blockers(missing), "storyboard_panel_refs"), "unknown body blocked");
  const shared = board(); panel(shared, 3).body_module_id = "b2";
  ok(has(blockers(shared), "storyboard_panel_refs"), "body shared by two panels blocked");
  const wrong = board(); panel(wrong, 2).note_module_id = "b2";
  ok(has(blockers(wrong), "storyboard_panel_refs"), "note that is not text blocked");
  const few = board(); few.modules = few.modules.filter((m) => !["p4", "p5", "p6", "b4", "b5", "b6", "n4", "n5", "n6"].includes(m.id));
  ok(has(blockers(few), "storyboard_panel_count"), "fewer than 4 panels blocked");
}
{ // height cap
  const spec = board();
  ok(!has(sb.storyboardBlockers(spec, null, () => 100), "storyboard_page_height"), "small modules fit");
  ok(has(sb.storyboardBlockers(spec, null, () => 600), "storyboard_page_height"), "tall modules blocked");
}
{ // expansion and page style
  const spec = board({ render_style: "pencil" });
  const out = sb.expandPanels(spec);
  ok(out.modules.every((m) => m.type !== "panel"), "panels are gone after expansion");
  ok(out.modules[0].type === "section_header" && out.modules[0].eyebrow === "1", "numbered header first");
  ok(out.modules.filter((m) => m.type === "visual").every((m) => m.render_style === "pencil"), "page style reaches every chart");
  const own = board({ render_style: "pencil" }); own.modules.find((m) => m.id === "b2").render_style = "ink";
  ok(sb.expandPanels(own).modules.find((m) => m.id === "b2").render_style === "ink", "a chart's own style wins");
  ok(validateInfographicSpec(spec).every((e) => !/unsupported type 'panel'/.test(e) && !/STORYBOARD_DISABLED/.test(e)), "on: panels accepted by validate");
  const lint = lintInfographicSpec(board({ color_legend: [{ color: "#d0746f", meaning_id: "a" }, { color: "#d0746f", meaning_id: "b" }] }), {}, {});
  ok(lint.blockers.some((b) => b.startsWith("storyboard_one_color_one_meaning")), "lint carries the panel rules");
}

// ---- form selection on
const cands = () => [
  { class: "comparison", form: "horizontal_bar", one_line_reason: "排序后一眼看出高低" },
  { class: "big_number", form: "hero_stat", one_line_reason: "只有一个数时最直接" },
  { class: "table", form: "table", one_line_reason: "要查精确值时用" },
];
const plan = (over = {}) => ({ chart_type: "horizontal_bar", candidates: cands(), chosen: "horizontal_bar", rejected_by_rule: [], ...over });
const problems = (p) => fs.formSelectionBlockers(p);
ok(problems(plan()).length === 0, `clean selection passes: ${problems(plan())}`);
ok(problems(plan({ candidates: cands().slice(0, 2) })).some((m) => /at least 3 candidates/.test(m)), "fewer than 3 candidates blocked");
ok(problems(plan({ candidates: [cands()[0], { class: "change", form: "line", one_line_reason: "看变化" }, { class: "ranking", form: "dot", one_line_reason: "看排名" }] })).some((m) => /must not be a chart/.test(m)), "all-chart candidates blocked");
ok(problems(plan({ candidates: [cands()[0], { class: "comparison", form: "dot", one_line_reason: "也能比较" }, { class: "comparison", form: "dumbbell", one_line_reason: "也能比较" }] })).some((m) => /two different classes/.test(m)), "single-class candidates blocked");
ok(problems(plan({ user_named_form: "heatmap" })).some((m) => /user_named_form 'heatmap' must stay/.test(m)), "dropped user-named form blocked");
ok(problems(plan({ user_named_form: "table" })).some((m) => /say why in chosen_reason/.test(m)), "overriding the named form needs a reason");
ok(problems(plan({ user_named_form: "table", chosen_reason: "排序后更清楚" })).length === 0, "overriding the named form with a reason passes");
ok(problems(plan({ rejected_by_rule: [{ form: "table", rule_id: "pie-max-categories" }] })).some((m) => /applies to pie, donut/.test(m)), "rule that does not cover the form blocked");
ok(problems(plan({ rejected_by_rule: [{ form: "heatmap", rule_id: "heatmap-cell-numbers" }] })).some((m) => /hint only/.test(m)), "hint rule cannot drop a form");
ok(problems(plan({ rejected_by_rule: [{ form: "pie", rule_id: "nope" }] })).some((m) => /not in the rule table/.test(m)), "unknown rule blocked");
ok(problems(plan({ chosen: "table" })).some((m) => /must be the chart_type/.test(m)), "chosen must be the planned chart");
ok(problems(plan({ candidates: [{ ...cands()[0], one_line_reason: "有五个类别" }, cands()[1], cands()[2]] })).some((m) => /number word/.test(m)), "number word in a reason blocked");
ok(problems({ chart_type: "horizontal_bar" }).some((m) => /candidates is required/.test(m)), "missing candidates blocked");
const refusal = fs.formSelectionRefusal({ chart_type: "horizontal_bar" });
ok(refusal.startsWith("FORM_SELECTION:") && refusal.includes("Form selection (the runtime added this"), "refusal brings the skeleton in");
ok(fs.formSelectionRefusal(plan()) === null, "no refusal when fine");
ok(fs.formRuleHints("pie", { categories: 7 }).length === 1 && fs.formRuleHints("pie", { categories: 4 }).length === 0, "pie hint only over the limit");
ok(fs.formRuleHints("stacked_bar_100", { series: 5 }).length === 1, "stacked hint at 5 series (strictest 4)");
console.log(`storyboard + form selection (on half) PASS checks=${checks}`);
