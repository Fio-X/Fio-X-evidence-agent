#!/usr/bin/env node
// NEWSROOM_LEAN_GATES x NEWSROOM_SPEED_DESIGN_PACK on the asset gate of the page plan tool. Lean gates let a plan leave out asset_plan_ref; with the design pack on that skip is
// taken away, so the gate is never looser than with the pack alone. The real newsroom_infographic_plan tool, all four combinations (LEAN, PACK), two page plans each:
//   revise:  asset_plan_ref points at a REVISE asset plan          -> refused in all four
//   omitted: asset_plan_ref left out (with NEWSROOM_SPEED_PREFLIGHT off and on: preflight makes the field optional in the schema, so LEAN off, PACK on is where a pack-only skip would show)                               -> refused, except (LEAN on, PACK off): the lean-gates answer as before (accepted)
// and the all-checks precheck view (NEWSROOM_SPEED_PRECHECK_ALL=1) behind an earlier refusal: it lists the missing asset plan unless the lean skip applies.
// Where the refusal comes from differs: the required-field rule, or (lean on) the asset gate itself finding no ref to read; both are refusals.
// Under LEAN the fixture's grammar is derived by the program, so there it uses THEN_NOW as primary grammar and gives no derived field.
// Mutations are in scripts/test_lean_pack_asset_gate_mutants.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ENV, freshRun, loadTree, pagePlan, register, schemaOrdered, setupRasterStub } from "./lib_page_chain_fixture.mjs";

if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") { console.log("SKIP: duckdb binary not found"); process.exit(77); }
for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_") && key !== "NEWSROOM_DUCKDB_BIN") delete process.env[key];
setupRasterStub();

const treeSource = process.env.LEAN_PACK_ASSET_GATE_SRC ? readFileSync(process.env.LEAN_PACK_ASSET_GATE_SRC, "utf8") : undefined; // the mutants test points this at a mutated copy
const { mod } = await loadTree("lean-pack-asset-gate", undefined, treeSource);
let checks = 0;
const check = (text) => { checks++; console.log(`  PASS ${text}`); };

const call = async ({ lean, pack, scenario, precheck = false, brokenNovelty = false, preflight = false }) => {
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: preflight ? "1" : "0", NEWSROOM_LEAN_GATES: lean ? "1" : undefined, NEWSROOM_SPEED_DESIGN_PACK: pack ? "1" : undefined, NEWSROOM_SPEED_PRECHECK_ALL: precheck ? "1" : undefined });
  const art = freshRun(`lean-pack-${scenario}-${preflight ? "pf" : "nopf"}`);
  if (scenario === "revise") writeFileSync(join(art, "editorial/assets/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", concept_id: "route-spine", decision: "REVISE" }));
  if (brokenNovelty) writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: false }));
  const plan = pagePlan({ withQuestion: true });
  if (scenario === "omitted") delete plan.asset_plan_ref;
  if (lean) { for (const k of ["available_renderer_capabilities", "evidence_features", "cognitive_goals"]) delete plan.editorial_grammar[k]; plan.editorial_grammar.primary = "THEN_NOW"; plan.editorial_grammar.supporting = []; }
  else { plan.editorial_grammar.primary = "THEN_NOW"; plan.editorial_grammar.supporting = []; }
  try { await tools.get("newsroom_infographic_plan").execute("p", schemaOrdered(tools, plan)); return { error: null, written: readdirSync(join(art, "infographics/plans")) }; } catch (e) { return { error: String(e?.message ?? e), written: readdirSync(join(art, "infographics/plans")) }; }
};

const NEEDED = /^asset_plan_ref is required when lean gates and the design pack are both on: give the editorial\/assets\/ reference of the newsroom_asset_requirements result$/;
const OLD_REQUIRED = "Invalid infographic plan: asset_plan_ref is required for InfographicSpec 1.4+";
const combos = [[false, false], [false, true], [true, false], [true, true]];
const name = ([lean, pack], preflight = false) => `LEAN ${lean ? "on" : "off"}, PACK ${pack ? "on" : "off"}${preflight ? ", PREFLIGHT on" : ""}`;
for (const c of combos) {
  const [lean, pack] = c;
  const r = await call({ lean, pack, scenario: "revise" });
  assert.match(r.error ?? "", /Award infographic asset plan is 'REVISE'/, `${name(c)}: a REVISE asset plan is refused: ${r.error ?? "accepted"}`);
  assert.deepEqual(r.written, [], `${name(c)}: nothing written`);
}
check("a plan that points at a REVISE asset plan is refused in all four combinations");
for (const preflight of [false, true]) for (const c of combos) {
  const [lean, pack] = c;
  const r = await call({ lean, pack, scenario: "omitted", preflight });
  // preflight derives the reference itself unless lean gates are on (lean does not derive it), so with it on only the (LEAN on, PACK on) cell refuses
  const accepted = preflight ? !(lean && pack) : lean && !pack;
  if (accepted) { assert.equal(r.error, null, `${name(c, preflight)}: ${lean && !pack ? "the lean-gates answer is unchanged (accepted)" : "accepted as before"}: ${r.error}`); assert.equal(r.written.length, 1, `${name(c, preflight)}: written`); }
  else {
    // LEAN off: the required-field rule's old text; LEAN on + PACK on: the sentence that names the field and the two switches
    if (lean) assert.match(r.error ?? "", NEEDED, `${name(c, preflight)}: an omitted asset_plan_ref is refused with the sentence naming the field and the switches: ${r.error ?? "accepted"}`);
    else assert.equal(r.error, OLD_REQUIRED, `${name(c, preflight)}: an omitted asset_plan_ref is refused by the required-field rule, old text: ${r.error ?? "accepted"}`);
    assert.deepEqual(r.written, [], `${name(c, preflight)}: nothing written`);
  }
}
check("PREFLIGHT off: an omitted asset_plan_ref is refused in three combinations and accepted only with LEAN on and PACK off (unchanged); PREFLIGHT on: accepted (derived) in three and refused with LEAN on and PACK on, so LEAN on + PACK on is never looser than PACK alone");
for (const c of combos) {
  const [lean, pack] = c;
  const r = await call({ lean, pack, scenario: "omitted", precheck: true, brokenNovelty: true });
  assert.ok(r.error, `${name(c)}: refused behind the novelty record`);
  const lists = /asset plan|asset_plan_ref/i.test(r.error.split("\n").slice(1).join("\n"));
  assert.equal(lists, !(lean && !pack), `${name(c)}: the check view ${lean && !pack ? "skips" : "lists"} the missing asset plan:\n${r.error.slice(0, 500)}`);
}
check("the all-checks view lists the missing asset plan in every combination except LEAN on, PACK off");
// The refusal text for LEAN on + PACK on says which field is missing and which two switches ask for it. The refusal itself and the check view's stage tag stay as they were,
// and the other cells keep their old text exactly.
for (const preflight of [false, true]) {
  const r = await call({ lean: true, pack: true, scenario: "omitted", preflight });
  assert.match(r.error ?? "", NEEDED, `LEAN on, PACK on${preflight ? ", PREFLIGHT on" : ""}: the refusal names the field and the two switches: ${r.error ?? "accepted"}`);
  assert.deepEqual(r.written, [], "nothing written");
  const v = await call({ lean: true, pack: true, scenario: "omitted", preflight, precheck: true, brokenNovelty: true });
  assert.match(v.error ?? "", /\[asset plan\] asset_plan_ref is required when lean gates and the design pack are both on: give the editorial\/assets\/ reference of the newsroom_asset_requirements result/, "the check view lists the whole sentence under the same stage");
  assert.match(v.error ?? "", /asset plan checks: its artifact could not be read/, "the view says the asset plan checks did not run");
  assert.doesNotMatch(v.error ?? "", /editorial\/assets\/: undefined/, "no 'undefined' path text is left in the view");
}
for (const c of [[false, false], [false, true]]) {
  const r = await call({ lean: c[0], pack: c[1], scenario: "omitted" });
  assert.equal(r.error, OLD_REQUIRED, `${name(c)}: the old text, byte for byte`);
  const v = await call({ lean: c[0], pack: c[1], scenario: "omitted", precheck: true, brokenNovelty: true });
  assert.match(v.error ?? "", /\[asset plan\] Artifact path must be under editorial\/assets\/: undefined/, `${name(c)}: the view keeps the old text`);
}
check("LEAN on + PACK on: the refusal and the view say asset_plan_ref is missing and which two switches ask for it, still refused with nothing written; LEAN off cells keep their old text byte for byte");
// The tool's parameter schema: asset_plan_ref is optional with lean gates alone (the lean skip) or with preflight on; otherwise it is required. The tests above call execute, which
// does not go through the schema, so the schema is read here.
for (const preflight of [false, true]) for (const c of combos) {
  const [lean, pack] = c;
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: preflight ? "1" : "0", NEWSROOM_LEAN_GATES: lean ? "1" : undefined, NEWSROOM_SPEED_DESIGN_PACK: pack ? "1" : undefined });
  const required = tools.get("newsroom_infographic_plan").parameters.required ?? [];
  assert.equal(required.includes("asset_plan_ref"), !(lean && !pack) && !preflight, `${name(c, preflight)}: asset_plan_ref is ${required.includes("asset_plan_ref") ? "required" : "optional"} in the schema`);
}
check("the page plan tool's schema asks for asset_plan_ref in every combination except LEAN on with PACK off, and except with PREFLIGHT on");
console.log(`lean x pack asset gate: ${checks} checks -- PASS`);
