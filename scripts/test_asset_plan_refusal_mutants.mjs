#!/usr/bin/env node
// Mutations of the two places that refuse an asset plan whose decision is not CONTINUE (see test_asset_plan_refusal.mjs). Each makes one refusal
// never fire (`false && ...`); the behaviour test must go red, with the text that names the missing refusal. A mutant that the test misses fails here.
// The mutated copy of newsroom.ts is written to a scratch folder; nothing in the repository is edited.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const scratch = makeTestTmp("asset-plan-refusal-mutants-");
const TOOL = 'if (assetPlan.decision !== "CONTINUE") throw new Error(';
const VIEW = 'if (assetPlan.decision !== "CONTINUE") add("asset plan"';
const mutants = [
  ["M1: the plan tool never refuses a non-CONTINUE asset plan", TOOL, 'if (false && assetPlan.decision !== "CONTINUE") throw new Error(', /a REVISE asset plan is refused/],
  ["M2: the plan check view never lists a non-CONTINUE asset plan", VIEW, 'if (false && assetPlan.decision !== "CONTINUE") add("asset plan"', /the view lists the asset plan problem/],
];
let caught = 0;
for (const [name, from, to, mustSay] of mutants) {
  assert.equal(source.split(from).length, 2, `${name}: the anchor occurs exactly once`);
  const file = join(scratch, `${caught}.ts`);
  writeFileSync(file, source.replace(from, to));
  const run = spawnSync(process.execPath, [join(ROOT, "scripts/test_asset_plan_refusal.mjs")], { encoding: "utf8", env: { ...process.env, ASSET_PLAN_REFUSAL_SRC: file } });
  assert.notEqual(run.status, 0, `${name}: SURVIVED (the test stayed green)`);
  assert.match(`${run.stdout}${run.stderr}`, mustSay, `${name}: red, but not for the expected reason:\n${(run.stderr || run.stdout).slice(0, 500)}`);
  console.log(`  red  ${name}`);
  caught++;
}
// the unmutated source passes through the same path, so a red above is the mutation's
const control = spawnSync(process.execPath, [join(ROOT, "scripts/test_asset_plan_refusal.mjs")], { encoding: "utf8", env: { ...process.env, ASSET_PLAN_REFUSAL_SRC: join(ROOT, "runtime/pi/newsroom.ts") } });
assert.equal(control.status, 0, `control run is green: ${(control.stderr || control.stdout).slice(0, 400)}`);
console.log(`asset plan refusal mutations: ${caught}/${mutants.length} caught -- PASS`);
