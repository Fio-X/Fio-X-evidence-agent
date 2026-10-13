#!/usr/bin/env node
// K293: THEMATIC_MAP may take FLOW_LEDGER as a supporting grammar (NEWSROOM_MAP_FLOW_SUPPORT=exactly "1", default off), applied in code where the registry is read; the registry file is unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lintEditorialGrammarSelection, grammarCoverPreflightIssues, leanGrammarCoverRefusal, materializeLeanEditorialGrammarSelection } from "../runtime/pi/editorial_grammar.mjs";
const registry = JSON.parse(readFileSync(new URL("../config/editorial-grammar-registry.json", import.meta.url), "utf8"));
const before = JSON.stringify(registry);
const SW = "NEWSROOM_MAP_FLOW_SUPPORT";
const run = (on, fn) => { if (on === "1") process.env[SW] = "1"; else if (on) process.env[SW] = on; else delete process.env[SW]; try { return fn(); } finally { delete process.env[SW]; } };
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const vis = (...modes) => modes.map((m, i) => ({ id: `v${i}`, type: "visual", visual_grammar: m }));
const scene_graph = { scenes: [{ id: "s1", primary_cognitive_goal: "MEASURE" }, { id: "s2", primary_cognitive_goal: "COMPARE" }, { id: "s3", primary_cognitive_goal: "CONSEQUENCE" }] };
const page = (modes) => ({ modules: vis(...modes), scene_graph, chartTypes: {}, story_graph_ref: "editorial/story-graphs/x.json" });
const FULL = page(["flow", "spatial", "trend"]);        // sankey + choropleth + multi_line (run12c)
const NOFLOW = page(["spatial", "trend", "rank"]);       // no origin->destination evidence

// lean pick on the full page: off finds no legal set; on finds THEMATIC_MAP with FLOW_LEDGER, the evidence all derived by the program
const pick = (spec, input) => materializeLeanEditorialGrammarSelection(input, spec, registry);
const refusal = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };
ok(/NO_LEGAL_COMBINATION/.test(refusal(() => run(false, () => pick(FULL, {})))), "pin: off, the full page has no legal combination");
const sel = run("1", () => pick(FULL, {}));
ok(sel.primary === "THEMATIC_MAP" && [...sel.supporting].sort().join() === "FLOW_LEDGER,THEN_NOW", `on: picks THEMATIC_MAP + FLOW_LEDGER + THEN_NOW (${sel.primary} + ${sel.supporting})`);
ok(!sel.evidence_features.includes("verified_locations"), "no self-reported evidence was needed");
ok(sel.decision_log.every((r) => !/模型自报/.test(r.reason_code ?? "")), "nothing is marked self-reported");
// the model naming it explicitly: off the lint refuses the pair; on it passes the lint and the cover preflight
const named = { ...sel, supporting: ["FLOW_LEDGER", "THEN_NOW"] };
const lintOff = run(false, () => lintEditorialGrammarSelection(named, registry));
ok(!lintOff.passed && lintOff.issues.some((i) => i.rule_id === "grammar.incompatible_supporting" && /FLOW_LEDGER is incompatible with primary THEMATIC_MAP/.test(i.message)), "pin: off, the lint refuses FLOW_LEDGER under THEMATIC_MAP");
ok(run("1", () => lintEditorialGrammarSelection(named, registry)).passed, "on: the lint accepts it");
const planSpec = { schema_version: "1.5.0", modules: FULL.modules, scene_graph, editorial_grammar: named };
ok(run("1", () => grammarCoverPreflightIssues(planSpec, registry)).length === 0 && run("1", () => leanGrammarCoverRefusal(planSpec, registry)) === null, "on: the cover preflight and the lean refusal accept it");
ok(run(false, () => grammarCoverPreflightIssues(planSpec, registry)).length > 0, "off: refused as today");
// only the exact value 1
ok(!run("2", () => lintEditorialGrammarSelection(named, registry)).passed, "only the exact value 1 turns it on");
// no other relation: FLOW_LEDGER is not allowed under other primaries, THEMATIC_MAP still refuses the others it refused
for (const [primary, sup] of [["MECHANISM_FLOW", "FLOW_LEDGER"], ["CUTAWAY", "FLOW_LEDGER"], ["THEMATIC_MAP", "MECHANISM_FLOW"], ["THEMATIC_MAP", "ROUTE_SPINE"], ["FLOW_LEDGER", "THEMATIC_MAP"]]) {
  const s = { ...sel, primary, selected: primary, supporting: [sup] };
  ok(run("1", () => lintEditorialGrammarSelection(s, registry)).issues.some((i) => i.rule_id === "grammar.incompatible_supporting"), `on: ${primary} + ${sup} is still incompatible`);
}
// FLOW_LEDGER keeps its own evidence: a page without a flow chart cannot use it, switch on, and the program never derives or accepts the missing feature
const e1 = refusal(() => run("1", () => pick(NOFLOW, { primary: "THEMATIC_MAP", supporting: ["FLOW_LEDGER", "THEN_NOW"] })));
ok(/SUPPORTING_INELIGIBLE/.test(e1) && /FLOW_LEDGER/.test(e1), `on: a plan without origin->destination is refused: ${e1}`);
const e2 = refusal(() => run("1", () => pick(NOFLOW, { primary: "THEMATIC_MAP", supporting: ["FLOW_LEDGER", "THEN_NOW"], reported_evidence_features: ["origin_destination_relation"] })));
ok(/REPORTED_EVIDENCE/.test(e2), "on: origin_destination_relation cannot be self-reported");
// the registry object is never modified and the file is unchanged
ok(JSON.stringify(registry) === before, "the registry object is not modified");
ok(!/FLOW_LEDGER/.test(JSON.stringify(registry.grammars.find((g) => g.id === "THEMATIC_MAP").compatible_supporting)), "THEMATIC_MAP in the registry still does not list FLOW_LEDGER");
console.log(`ok: K293 map pages may take FLOW_LEDGER as supporting (${checks} checks)`);
