#!/usr/bin/env node
// K261: with lean gates a supporting grammar must be eligible too (its own required evidence and renderer), whether the program picks it or the
// model gives it. A run-7-shaped page (trend, composition people dots, state map, day clock; goals COMPARE/MEASURE) gets
// THEMATIC_MAP + SCALE_TRANSLATOR + THEN_NOW, and ROUTE_SPINE as supporting (no verified locations) is refused with the legal list.
// Run: node scripts/test_lean_supporting_eligibility.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
const { materializeLeanEditorialGrammarSelection } = await import(R + "editorial_grammar.mjs");
const registry = JSON.parse(readFileSync(new URL("../config/editorial-grammar-registry.json", import.meta.url), "utf8"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const vis = (id, g) => ({ id, type: "visual", visual_grammar: g });
const spec = {
  modules: [vis("m_wave", "trend"), vis("m_dots", "composition"), vis("m_tile", "spatial"), vis("m_day", "sequence"), { id: "m_hero", type: "hero_stat" }],
  scene_graph: { scenes: ["MEASURE", "COMPARE", "COMPARE", "MEASURE"].map((g, i) => ({ id: `s${i}`, primary_cognitive_goal: g })) },
  chartTypes: { m_dots: "people_dots", m_day: "clock_dial" }, story_graph_ref: "editorial/story-graphs/x.json",
};
const pick = (input) => { const s = materializeLeanEditorialGrammarSelection(input, spec, registry); return [s.primary, ...s.supporting].join(" + "); };
ok(pick({}) === "THEMATIC_MAP + SCALE_TRANSLATOR + THEN_NOW", `auto pick: ${pick({})}`);
let err = null;
try { pick({ primary: "SCALE_TRANSLATOR", supporting: ["THEN_NOW", "ROUTE_SPINE"] }); } catch (e) { err = e.message; }
ok(err && /EDITORIAL_GRAMMAR_SUPPORTING_INELIGIBLE: ROUTE_SPINE/.test(err) && /legal combinations: THEMATIC_MAP \+ SCALE_TRANSLATOR \+ THEN_NOW/.test(err), `model-given ineligible supporting is refused with the legal list: ${err}`);
ok(pick({ primary: "THEMATIC_MAP", supporting: ["SCALE_TRANSLATOR", "THEN_NOW"] }) === "THEMATIC_MAP + SCALE_TRANSLATOR + THEN_NOW", "an eligible given set is accepted unchanged");
console.log(`lean supporting eligibility PASS checks=${n}`);
