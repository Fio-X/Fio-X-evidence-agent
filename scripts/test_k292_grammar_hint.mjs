#!/usr/bin/env node
// K292: the editorial grammar recommendation in refusal messages respects eligibility (NEWSROOM_GRAMMAR_HINT_ELIGIBLE=exactly "1", default off). Message text only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { grammarCoverPreflightIssues, leanGrammarCoverRefusal } from "../runtime/pi/editorial_grammar.mjs";
import { runEditorialValidators } from "../runtime/pi/editorial_validators.mjs";
const registry = JSON.parse(readFileSync(new URL("../config/editorial-grammar-registry.json", import.meta.url), "utf8"));
const before = JSON.stringify(registry);
const SW = "NEWSROOM_GRAMMAR_HINT_ELIGIBLE";
// run12c shape: sankey (flow) + choropleth (spatial) + multi_line (trend); evidence the program derives (no verified_locations)
const base = ["comparable_timepoints", "origin_destination_relation", "quantity", "spatial_structure"];
const modules = [{ id: "v0", type: "visual", visual_grammar: "flow" }, { id: "v1", type: "visual", visual_grammar: "spatial" }, { id: "v2", type: "visual", visual_grammar: "trend" }];
const scenes = [{ id: "s1", primary_cognitive_goal: "MEASURE" }, { id: "s2", primary_cognitive_goal: "COMPARE" }];
const spec = (primary, supporting, evidence) => ({ schema_version: "1.5.0", modules, scene_graph: { scenes }, editorial_grammar: { primary, supporting, evidence_features: evidence, cognitive_goals: ["COMPARE", "MEASURE"], available_renderer_capabilities: ["canvas2d", "svg", "webgl_map"] } });
const run = (on, fn) => { if (on) process.env[SW] = "1"; else delete process.env[SW]; try { return fn(); } finally { delete process.env[SW]; } };
const validate = (s) => runEditorialValidators(s, {}, { editorial_grammar_registry: registry });
const shape = (r) => ({ passed: r.passed, rows: r.issues.map((i) => [i.rule_id, i.severity, i.path]) });
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };

const bad = spec("THEMATIC_MAP", ["THEN_NOW"], base);
// 1 off: today's text, recommends the ineligible ROUTE_SPINE (pin the bug)
const offV = run(false, () => validate(bad));
const offText = offV.issues.map((i) => i.message).join("\n");
ok(/recommended editorial grammar: primary ROUTE_SPINE, supporting THEN_NOW/.test(offText), `pin: off recommends ROUTE_SPINE: ${offText}`);
// 2 on: no ineligible grammar is recommended, and the missing evidence is named
const onV = run(true, () => validate(bad));
const onText = onV.issues.map((i) => i.message).join("\n");
ok(!/recommended editorial grammar: primary ROUTE_SPINE/.test(onText), "on: ROUTE_SPINE is not recommended");
ok(/ROUTE_SPINE lacks verified_locations/.test(onText), `on: names what ROUTE_SPINE lacks: ${onText}`);
// 3 the decision is the same: same rules, severities, paths, pass flag
assert.deepEqual(shape(onV), shape(offV)); checks++;
// 4 with verified_locations reported ROUTE_SPINE is eligible: the recommendation is unchanged, switch on or off
const withLoc = spec("THEMATIC_MAP", ["THEN_NOW"], [...base, "verified_locations"]);
assert.equal(run(true, () => JSON.stringify(validate(withLoc))), run(false, () => JSON.stringify(validate(withLoc)))); checks++;
// 5 a covered page: identical output (no message at all)
const good = spec("ROUTE_SPINE", ["THEN_NOW"], [...base, "verified_locations"]);
assert.equal(run(true, () => JSON.stringify(validate(good))), run(false, () => JSON.stringify(validate(good)))); checks++;
// 6 only the exact value 1 turns it on
process.env[SW] = "2"; const two = JSON.stringify(validate(bad)); delete process.env[SW];
assert.equal(two, JSON.stringify(offV)); checks++;
// 7 non-lean coverage preflight (NEWSROOM_GRAMMAR_COVER_PREFLIGHT path): off lists ROUTE_SPINE sets, on lists none that are ineligible; refusal outcome is the same
const offP = run(false, () => grammarCoverPreflightIssues(bad, registry));
const onP = run(true, () => grammarCoverPreflightIssues(bad, registry));
ok(offP.length === 1 && /legal combinations: ROUTE_SPINE \+ THEN_NOW/.test(offP[0]), `pin: off lists ROUTE_SPINE: ${offP}`);
ok(onP.length === 1 && /^editorial grammar coverage: the selected set leaves /.test(onP[0]) && !/legal combinations: ROUTE_SPINE/.test(onP[0]) && /ROUTE_SPINE lacks verified_locations/.test(onP[0]), `on: ${onP}`);
ok(/this list follows the visual modes the modules declare now/.test(run(true, () => grammarCoverPreflightIssues(withLoc, registry))[0]) && !/this list follows/.test(run(false, () => grammarCoverPreflightIssues(withLoc, registry))[0]), "K308 item 6: on adds the dependence note to a legal-combinations list, off has none");
const withLocP = [run(false, () => grammarCoverPreflightIssues(withLoc, registry)), run(true, () => grammarCoverPreflightIssues(withLoc, registry))];
ok(withLocP[0].length === 1 && withLocP[1].length === 1, "an eligible set still refuses the same selection, with the same count");
ok(run(false, () => grammarCoverPreflightIssues(good, registry)).length === 0 && run(true, () => grammarCoverPreflightIssues(good, registry)).length === 0, "a covered set passes on and off");
// 8 lean refusal: same refusal with the switch on, plus the missing evidence
const offL = run(false, () => leanGrammarCoverRefusal(bad, registry)), onL = run(true, () => leanGrammarCoverRefusal(bad, registry));
ok(typeof offL === "string" && typeof onL === "string" && onL.startsWith(offL.split("; split the page")[0]) && /ROUTE_SPINE lacks verified_locations/.test(onL), `lean: ${onL}`);
ok(leanGrammarCoverRefusal(good, registry) === null && run(true, () => leanGrammarCoverRefusal(good, registry)) === null, "lean: a covered set is not refused on or off");
ok(JSON.stringify(registry) === before, "the registry is not modified");
console.log(`ok: K292 grammar hint respects eligibility (${checks} checks)`);
