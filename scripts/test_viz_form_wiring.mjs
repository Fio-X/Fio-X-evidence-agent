// strip_plot, stacked_bar_100 and mirrored_bar are accepted by the page-level grammar gates (runtime/pi/infographic.mjs) and by the
// strict editorial grammar map (runtime/pi/newsroom.ts) exactly where their own reader-task fit puts them, and refused everywhere
// else. The tool schema, the planner guidance and the wording of the hints are asserted in test_viz_plan_schema.mjs; this file is
// only about which grammar may use which of the three forms. FITS is the one table of record, taken from the forms' own taskFit in
// runtime/pi/viz.mjs: distribution fits strip_plot and mirrored_bar, part_to_whole (editorial grammar: composition) fits
// stacked_bar_100, comparison fits mirrored_bar. A grammar is only enforced where a list names it: the page gates know no
// 'comparison' grammar, and newsroom.ts governs no 'composition' or 'distribution' relation (nothing is refused under those), so
// of the three forms only mirrored_bar needs an entry in the strict map, under comparison. If a relation becomes strict later,
// this test fails until every form that fits it is listed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INFOGRAPHIC_VISUAL_GRAMMARS, evaluateInfographicSynthesis, lintInfographicSpec } from "../runtime/pi/infographic.mjs";
import { FORM_CHART_TYPES } from "./lib_viz_form_wiring.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FITS = { strip_plot: ["distribution"], stacked_bar_100: ["composition"], mirrored_bar: ["comparison", "distribution"] };
assert.deepEqual(Object.keys(FITS).sort(), [...FORM_CHART_TYPES].sort(), "the table covers exactly the three forms");

// ---- 1. page gates: evaluateInfographicSynthesis and lintInfographicSpec (schema 1.4.0 and 1.5.0) -------------------------------
const REFUSED = /is incompatible with chart_type|unsupported module visual_grammar/;
const story = { reader_question: "q", visual_thesis: "t", nodes: [], edges: [], entry_node_ids: [], answer_node_ids: [] };
const visualModule = (grammar) => ({ id: "v", type: "visual", manifest_ref: "m.json", visual_grammar: grammar, story_node_ids: [], span: "full" });
const sites = {
  synthesis: (grammar, chartType) => evaluateInfographicSynthesis(
    { schema_version: "1.4.0", reader_question: "q", visual_thesis: "t", modules: [visualModule(grammar)] },
    { "m.json": { manifest: { chart_type: chartType } } }, story).blockers,
  ...Object.fromEntries(["1.4.0", "1.5.0"].map((version) => [`lint ${version}`, (grammar, chartType) => lintInfographicSpec(
    { schema_version: version, language: "en", reader_question: "q", visual_thesis: "t", modules: [visualModule(grammar)] },
    { "m.json": { desktopSvg: "<svg/>", mobileSvg: "<svg/>", manifest: { chart_type: chartType, language: "en" } } },
    { mobile_pages: false }).blockers])),
};
let pageChecks = 0;
for (const [site, blockersFor] of Object.entries(sites)) {
  // Controls: the harness sees an accept (a rank chart under rank) and a refuse (a rank chart under distribution).
  assert.equal(blockersFor("rank", "horizontal_bar").some((b) => REFUSED.test(b)), false, `${site}: horizontal_bar under rank is accepted`);
  assert.equal(blockersFor("distribution", "horizontal_bar").some((b) => REFUSED.test(b)), true, `${site}: horizontal_bar under distribution is refused`);
  for (const form of FORM_CHART_TYPES) {
    for (const grammar of INFOGRAPHIC_VISUAL_GRAMMARS) {
      const accepted = !blockersFor(grammar, form).some((b) => REFUSED.test(b));
      assert.equal(accepted, FITS[form].includes(grammar), `${site}: ${form} under grammar '${grammar}' must be ${FITS[form].includes(grammar) ? "accepted" : "refused"}`);
      pageChecks++;
    }
  }
}
console.log(`PASS page gates: ${FORM_CHART_TYPES.length} forms x ${INFOGRAPHIC_VISUAL_GRAMMARS.length} grammars x ${Object.keys(sites).length} sites (${pageChecks} checks)`);

// ---- 2. strict editorial grammar: the real assertEditorialGrammar and map, cut out of newsroom.ts -----------------------------
const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const mapAt = source.indexOf("const STRICT_GRAMMAR_FORMS");
const fnAt = source.indexOf("function assertEditorialGrammar", mapAt);
const fnEnd = source.indexOf("\n}\n", fnAt) + 3;
assert.ok(mapAt >= 0 && fnAt > mapAt && fnEnd > fnAt, "STRICT_GRAMMAR_FORMS and assertEditorialGrammar are found in newsroom.ts");
const { STRICT_GRAMMAR_FORMS, assertEditorialGrammar } = new Function(`${stripTypeScriptTypes(source.slice(mapAt, fnEnd), { mode: "strip" })}\nreturn { STRICT_GRAMMAR_FORMS, assertEditorialGrammar };`)();
const relationEnum = source.match(/relation: StringEnum\(\[([^\]]+)\] as const, ruleHint\(RULE_HINT_RELATION\)\)/);
assert.ok(relationEnum, "the claim_spec relation enum is found in newsroom.ts");
const RELATIONS = relationEnum[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
assert.ok(RELATIONS.includes("composition") && RELATIONS.includes("distribution"), "composition and distribution are claim relations");
const accepts = (relation, chartType) => {
  try {
    assertEditorialGrammar({ enforcement: "strict", status: "PASS", claim_spec: { relation } }, chartType);
    return true;
  } catch (error) {
    assert.match(String(error.message), /^EDITORIAL_GRAMMAR_BLOCKED/, `${relation}/${chartType}: only the grammar block may refuse`);
    return false;
  }
};
// Controls: a relation the map governs refuses a form it does not list and accepts one it does.
assert.equal(accepts("rank", "horizontal_bar"), true, "horizontal_bar under rank is accepted");
assert.equal(accepts("rank", "scatter"), false, "scatter under rank is refused");
let strictChecks = 0;
for (const form of FORM_CHART_TYPES) {
  for (const relation of RELATIONS) {
    const expected = relation in STRICT_GRAMMAR_FORMS ? FITS[form].includes(relation) : true;
    assert.equal(accepts(relation, form), expected, `relation '${relation}' with ${form} must be ${expected ? "accepted" : "refused"}`);
    strictChecks++;
  }
}
assert.ok(STRICT_GRAMMAR_FORMS.comparison.includes("mirrored_bar"), "mirrored_bar is listed under the strict comparison relation");
// Everything the map governs is a real claim relation, so no entry can be dead.
for (const relation of Object.keys(STRICT_GRAMMAR_FORMS)) assert.ok(RELATIONS.includes(relation), `strict relation '${relation}' is in the claim_spec relation enum`);
console.log(`PASS strict editorial grammar: ${strictChecks} form x relation checks`);

// ---- 3. the RULE_HINT_RELATION wording mirrors the strict map, relation by relation -----------------------------------------
const hint = source.match(/const RULE_HINT_RELATION = "The editorial grammar must fit chart_type: ([^"]+)\.";/);
assert.ok(hint, "RULE_HINT_RELATION is found in newsroom.ts");
const fromHint = Object.fromEntries(hint[1].split("; ").map((clause) => { const [relation, forms] = clause.split(" "); return [relation, forms.split("/")]; }));
assert.deepEqual(fromHint, STRICT_GRAMMAR_FORMS, "RULE_HINT_RELATION lists exactly what STRICT_GRAMMAR_FORMS allows");
console.log(`PASS RULE_HINT_RELATION mirrors STRICT_GRAMMAR_FORMS (${Object.keys(fromHint).length} relations)`);

console.log(JSON.stringify({ status: "PASS", page_checks: pageChecks, strict_checks: strictChecks }));
