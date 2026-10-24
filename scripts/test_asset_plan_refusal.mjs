#!/usr/bin/env node
// A page plan that points at an asset plan whose decision is not CONTINUE (REVISE: a required asset the run cannot supply; RESEARCH_MORE: a blocking one) is refused.
// Two places read that decision and this test walks the real plan tool into each:
//   1. the plan tool's own check (newsroom_infographic_plan): the call throws "Award infographic asset plan is '<decision>'" and writes nothing to infographics/plans;
//   2. the plan check view that NEWSROOM_SPEED_PRECHECK_ALL=1 builds after a refusal: its report carries an "asset plan" line for the same decision.
// A CONTINUE plan is accepted by the same call (the control), so the refusals are the decision's and nothing else's. The asset plans are written by hand with the fields the
// checks read (concept_ref, concept_id, decision); no model, no network.
// Mutations are in scripts/test_asset_plan_refusal_mutants.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ENV, freshRun, loadTree, omittedPlan, register, schemaOrdered, setupRasterStub } from "./lib_page_chain_fixture.mjs";

if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") { console.log("SKIP: duckdb binary not found"); process.exit(77); }
for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_") && key !== "NEWSROOM_DUCKDB_BIN") delete process.env[key];
setupRasterStub();

const treeSource = process.env.ASSET_PLAN_REFUSAL_SRC ? readFileSync(process.env.ASSET_PLAN_REFUSAL_SRC, "utf8") : undefined; // the mutants test points this at a mutated copy of newsroom.ts
const { mod } = await loadTree("asset-plan-refusal", undefined, treeSource);
let checks = 0;
const check = (text) => { checks++; console.log(`  PASS ${text}`); };

const run = async (decision, extraEnv, { novelty = true } = {}) => {
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: "0", NEWSROOM_SPEED_PRECHECK_ALL: undefined, ...extraEnv });
  const art = freshRun(`asset-plan-${decision}`);
  writeFileSync(join(art, "editorial/assets/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", concept_id: "route-spine", decision }));
  // a failing novelty record is an earlier problem: the plan tool stops on it, so the asset plan line can only come from the check view
  if (!novelty) writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: false }));
  // the full plan (the six derivable fields are given), so the ordinary required-field check is not what refuses it
  const plan = schemaOrdered(tools, (await import("./lib_page_chain_fixture.mjs")).pagePlan({ withQuestion: true }));
  let error = null, result = null;
  try { result = await tools.get("newsroom_infographic_plan").execute("p", plan); } catch (e) { error = String(e?.message ?? e); }
  return { art, error, result, written: readdirSync(join(art, "infographics/plans")) };
};

{ // control: CONTINUE is accepted
  const ok = await run("CONTINUE", {});
  assert.equal(ok.error, null, `a CONTINUE asset plan is accepted: ${ok.error}`);
  assert.equal(ok.written.length, 1, "the plan was written");
  check("control: the same page plan with a CONTINUE asset plan is accepted and written");
}
for (const decision of ["REVISE", "RESEARCH_MORE"]) {
  { // 1: the plan tool's own check
    const r = await run(decision, {});
    assert.ok(r.error, `a ${decision} asset plan is refused`);
    assert.match(r.error, new RegExp(`Award infographic asset plan is '${decision}'`), r.error.slice(0, 300));
    assert.deepEqual(r.written, [], "nothing written to infographics/plans");
    check(`1: the plan tool refuses a ${decision} asset plan and writes nothing`);
  }
  { // 2: the plan check view of the all-checks precheck. The asset plan problem is not the first one (a failing novelty record is), or the view would
    // skip it as already said.
    const r = await run(decision, { NEWSROOM_SPEED_PRECHECK_ALL: "1" }, { novelty: false });
    assert.ok(r.error, `refused with PRECHECK_ALL on (${decision})`);
    assert.match(r.error, /^Award infographic contains unresolved high semantic redundancy/, `the first refusal is the novelty one: ${r.error.slice(0, 200)}`);
    assert.match(r.error, new RegExp(`\\d+\\. .*Award infographic asset plan is '${decision}'`), `the view lists the asset plan problem:\n${r.error.slice(0, 700)}`);
    const plain = await run(decision, {}, { novelty: false });
    assert.doesNotMatch(plain.error, /asset plan/i, "without PRECHECK_ALL the call stops at the first refusal, so the line is the view's");
    check(`2: with PRECHECK_ALL on, the check view lists the ${decision} asset plan behind an earlier refusal; with it off the call stops at the first`);
  }
}
console.log(`asset plan refusal: ${checks} checks -- PASS`);
