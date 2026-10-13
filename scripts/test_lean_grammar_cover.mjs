#!/usr/bin/env node
// K261: with lean gates + storyboard the plan tool refuses an editorial grammar set that leaves a derived scene goal uncovered, at plan time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { leanGrammarCoverRefusal, materializeLeanEditorialGrammarSelection } from "../runtime/pi/editorial_grammar.mjs";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const registry = JSON.parse(readFileSync(new URL("../config/editorial-grammar-registry.json", import.meta.url), "utf8"));
const before = JSON.stringify(registry);
// the page facts the plan tool puts into the materialized selection (run 7: no verified locations, no origin-destination relation)
const EVIDENCE = ["comparable_entities", "comparable_timepoints", "human_scale_reference", "quantity", "spatial_structure"];
const vis = (...modes) => modes.map((m, i) => ({ id: `v${i}`, type: "visual", visual_grammar: m }));
const page = (primary, supporting, modes, goals) => ({ schema_version: "1.5.0", editorial_grammar: { primary, supporting, evidence_features: EVIDENCE, available_renderer_capabilities: ["canvas2d", "svg", "webgl_map"], cognitive_goals: [...new Set(goals)].sort() }, modules: vis(...modes), scene_graph: { scenes: goals.map((g, i) => ({ id: `scene-p${i}`, primary_cognitive_goal: g })) } });
// run 7, first plan: THEMATIC_MAP + SCALE_TRANSLATOR + THEN_NOW on a page with trend, composition, spatial, sequence charts and MEASURE / EXPLAIN / COMPARE scenes
const first = leanGrammarCoverRefusal(page("THEMATIC_MAP", ["SCALE_TRANSLATOR", "THEN_NOW"], ["trend", "composition", "spatial", "sequence"], ["MEASURE", "EXPLAIN", "COMPARE", "MEASURE"]), registry);
ok(typeof first === "string" && /^Invalid editorial grammar selection: editorial grammar coverage:/.test(first), `refused with the coverage text: ${first}`);
ok(/scene goals EXPLAIN uncovered/.test(first) && /legal combinations: /.test(first), "names the missing goal and lists legal combinations");
ok(!/MEASURE uncovered|COMPARE uncovered/.test(first), "only the goal that is missing is named");
// a covered set passes (take the first legal combination the refusal printed)
const legal = /legal combinations: ([A-Z_]+)(?: \+ ([A-Z_ +]+?))?(?:;|$)/.exec(first);
ok(!!legal, "the refusal prints a first legal combination");
const sup = legal[2] ? legal[2].split(" + ") : [];
ok(leanGrammarCoverRefusal(page(legal[1], sup, ["trend", "composition", "spatial", "sequence"], ["MEASURE", "EXPLAIN", "COMPARE", "MEASURE"]), registry) === null, "the printed combination is accepted");
ok(leanGrammarCoverRefusal({ ...page("THEMATIC_MAP", [], ["spatial"], ["COMPARE"]), schema_version: "1.4.0" }, registry) === null, "a non-1.5 spec is not judged");
ok(JSON.stringify(registry) === before, "the registry is not modified");
// the listed combinations are only grammars the page's evidence allows, and every one fed back passes both the refusal and the lean pick (K261)
const shortSet = page("SCALE_TRANSLATOR", ["THEN_NOW"], ["trend", "composition", "spatial", "sequence"], ["MEASURE", "COMPARE"]);
const refusal = leanGrammarCoverRefusal(shortSet, registry);
ok(typeof refusal === "string" && /visual modes spatial uncovered/.test(refusal), `a set with no map grammar is refused: ${refusal}`);
ok(!/ROUTE_SPINE|MECHANISM_FLOW|FLOW_LEDGER/.test(refusal), "ineligible grammars are not listed");
const listed = /legal combinations: (.*)$/.exec(refusal)[1].split("; ").map((t) => t.split(" + "));
ok(listed.length >= 1 && listed[0].join(" + ") === "THEMATIC_MAP + SCALE_TRANSLATOR + THEN_NOW", `the first listed is the lean pick: ${listed.map((l) => l.join("+"))}`);
const leanSpec = { modules: vis("trend", "composition", "spatial", "sequence"), scene_graph: shortSet.scene_graph, chartTypes: { v1: "people_dots", v3: "clock_dial" }, story_graph_ref: "editorial/story-graphs/x.json" };
for (const [primary, ...supporting] of listed) {
  ok(leanGrammarCoverRefusal(page(primary, supporting, ["trend", "composition", "spatial", "sequence"], ["MEASURE", "COMPARE"]), registry) === null, `${primary}+${supporting} passes the refusal`);
  const sel = materializeLeanEditorialGrammarSelection({ primary, supporting }, leanSpec, registry);
  ok(sel.primary === primary && sel.supporting.join() === supporting.join(), `${primary}+${supporting} passes the lean pick`);
}
// wiring: the plan tool calls it only for lean + storyboard + panels, so off is unchanged
const src = readFileSync(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
ok(/if \(leanGatesEnabled\(\) && storyboardEnabled\(\) && hasPanels\(params\)\) \{\s*const refusal = leanGrammarCoverRefusal\(specCore, editorialGrammarRegistry\);\s*if \(refusal\) throw new Error\(refusal\);/.test(src), "the plan tool refuses only under lean + storyboard + panels");
ok(/if \(specBuilt && leanGatesEnabled\(\) && storyboardEnabled\(\) && hasPanels\(params\)\) \{\s*try \{ const refusal = leanGrammarCoverRefusal\(view, registry\); if \(refusal\) add\("preflight", refusal\);/.test(src), "the precheck-all path lists the same refusal under the same switches");
console.log(`lean grammar cover PASS checks=${checks}`);
