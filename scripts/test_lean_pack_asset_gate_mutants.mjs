#!/usr/bin/env node
// Mutations of leanAssetPlanSkipEnabled in runtime/pi/newsroom.ts (see test_lean_pack_asset_gate.mjs). The mutated copy goes to a scratch folder; the matrix test run against it
// must go red with the expected text. Nothing in the repository is edited.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const scratch = makeTestTmp("lean-pack-asset-gate-mutants-");
const BODY = 'return leanGatesEnabled() && process.env.NEWSROOM_SPEED_DESIGN_PACK !== "1";';
const mutants = [
  ["L1: the new judgement is removed (lean skip applies with the pack on)", BODY, "return leanGatesEnabled();", /LEAN on, PACK on: an omitted asset_plan_ref is refused/],
  ["L2: the comparison is written the wrong way round (skip only when the pack is on)", BODY, 'return leanGatesEnabled() && process.env.NEWSROOM_SPEED_DESIGN_PACK === "1";', /LEAN on, PACK off: the lean-gates answer is unchanged/],
  ["L6: the pack switch turns the skip on by itself (red at LEAN on, PACK on; LEAN off, PACK on stays refused by the required-field rule, which does not read this helper)", BODY, 'return leanGatesEnabled() || process.env.NEWSROOM_SPEED_DESIGN_PACK === "1";', /LEAN on, PACK on: an omitted asset_plan_ref is refused/],
  ["L3: the pack switch is read with the lean one dropped (skip whenever the pack is off)", BODY, 'return process.env.NEWSROOM_SPEED_DESIGN_PACK !== "1";', /the check view (skips|lists) the missing asset plan/],
  ["L4: the skip is taken away with the pack off as well (lean-only answer changed)", BODY, "return false;", /LEAN on, PACK off: the lean-gates answer is unchanged/],
  ["L7: the plan gate does not name the missing field (the old read of an undefined path comes back)", "if (leanGatesEnabled() && specCore.asset_plan_ref === undefined) throw new Error(ASSET_PLAN_REF_NEEDED);", "", /refused with the sentence naming the field and the switches/],
  ["L8: the text no longer says which two switches ask for it", "asset_plan_ref is required when lean gates and the design pack are both on:", "asset_plan_ref is required:", /refused with the sentence naming the field and the switches/],
  ["L9: the check view keeps the old 'undefined' path text", "const assetPlanNeeded = leanGatesEnabled() && view.asset_plan_ref === undefined && !leanAssetPlanSkipEnabled();", "const assetPlanNeeded = false;", /the check view lists the whole sentence under the same stage/],
  ["L10: the schema keeps the old lean-only optional (the pack no longer makes it required)", "asset_plan_ref: leanAssetPlanSkipEnabled() ? Type.Optional(Type.String())", "asset_plan_ref: leanGatesEnabled() ? Type.Optional(Type.String())", /the page plan tool's schema asks for asset_plan_ref|asset_plan_ref is optional in the schema/],
  ["L11: the view no longer says the asset plan checks did not run", 'unchecked.push("asset plan checks: its artifact could not be read"); }\n  const assetPlan =', '}\n  const assetPlan =', /the view says the asset plan checks did not run/],
];
// Two mutations that were looked at and are left out because they cannot go red (the page plan schema stops the input first, so the change is unreachable):
//   - the plan gate without its `leanGatesEnabled() &&`: with lean gates off, asset_plan_ref is required by the schema or derived by preflight, so the throw is never reached with it undefined.
//   - the view's `=== undefined` written `== null`: null does not pass the schema, so only undefined arrives.
let caught = 0;
for (const [name, from, to, mustSay] of mutants) {
  assert.equal(source.split(from).length, 2, `${name}: the anchor occurs exactly once`);
  const file = join(scratch, `${caught}.ts`);
  writeFileSync(file, source.replace(from, to));
  const run = spawnSync(process.execPath, [join(ROOT, "scripts/test_lean_pack_asset_gate.mjs")], { encoding: "utf8", env: { ...process.env, LEAN_PACK_ASSET_GATE_SRC: file } });
  assert.notEqual(run.status, 0, `${name}: SURVIVED`);
  assert.match(`${run.stdout}${run.stderr}`, mustSay, `${name}: red for another reason:\n${(run.stderr || run.stdout).slice(0, 600)}`);
  console.log(`  red  ${name}`);
  caught++;
}
const control = spawnSync(process.execPath, [join(ROOT, "scripts/test_lean_pack_asset_gate.mjs")], { encoding: "utf8", env: { ...process.env, LEAN_PACK_ASSET_GATE_SRC: join(ROOT, "runtime/pi/newsroom.ts") } });
assert.equal(control.status, 0, `control run is green: ${(control.stderr || control.stdout).slice(0, 400)}`);
console.log(`lean x pack asset gate mutations: ${caught}/${mutants.length} caught -- PASS`);
