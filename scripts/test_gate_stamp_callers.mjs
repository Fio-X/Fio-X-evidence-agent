#!/usr/bin/env node
// 1011w: the chart plan and the chart render do not stamp VERIFIED themselves. The stamp (verification_mode / artifact_status / publishable /
// verification) is made by the gated knowledge-side functions verifiedClaimFor, chartPlanStamp and chartRenderStatus; the visual tool bodies
// only call them. Red when a body of newsroom_viz_plan or newsroom_viz_render reads the claim registry or builds the stamp itself again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FORBIDDEN = [/\brequireVerifiedClaim\s*\(/, /\bderiveClaimVerification\s*\(/, /\bverifiedClaimRecords\s*\(/, /\bverifiedClaimIds\s*\(/, /\bisSystemVerifiedClaim\s*\(/, /\bartifact_status\s*:/];
const REQUIRED = { newsroom_viz_plan: ["verifiedClaimFor(", "chartPlanStamp("], newsroom_viz_render: ["chartRenderStatus("] };

export function toolBody(src, tool) {
  const start = src.indexOf(`name: "${tool}"`);
  assert.ok(start >= 0, `${tool} is in newsroom.ts`);
  const next = src.indexOf('\n    name: "newsroom_', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

export function problems(src) {
  const out = [];
  for (const tool of Object.keys(REQUIRED)) {
    const body = toolBody(src, tool);
    for (const re of FORBIDDEN) if (re.test(body)) out.push(`${tool} calls ${re.source} itself; the stamp comes from the gated knowledge function`);
    for (const need of REQUIRED[tool]) if (!body.includes(need)) out.push(`${tool} does not call ${need}`);
  }
  return out;
}

const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
assert.deepEqual(problems(src), [], "the visual tools take the stamp from the gated functions");

// counter-tests: a visual tool going back to the old call is red
const plan = toolBody(src, "newsroom_viz_plan");
const render = toolBody(src, "newsroom_viz_render");
const planBad = src.replace(plan, plan.replace("await verifiedClaimFor(", "requireVerifiedClaim(await verifiedClaimRecords(), "));
assert.ok(problems(planBad).some((m) => m.startsWith("newsroom_viz_plan calls")), "viz_plan reading the registry itself is red");
const stampBad = src.replace(plan, plan.replace("...(await chartPlanStamp(", "artifact_status: \"VERIFIED\", ...(await chartPlanStamp("));
assert.ok(problems(stampBad).some((m) => /artifact_status/.test(m)), "viz_plan stamping itself is red");
const renderBad = src.replace(render, render.replace("...renderStamp,", "...renderStamp, verification: deriveClaimVerification({}),"));
assert.ok(problems(renderBad).some((m) => m.startsWith("newsroom_viz_render calls")), "viz_render building the verification itself is red");
// lieflat.mjs does not read the claim registry; the calling tool passes the verified records in
const lieflat = readFileSync(join(ROOT, "runtime/pi/lieflat.mjs"), "utf8");
export function lieflatProblems(text) {
  const out = [];
  if (/["'`]claims\.jsonl["'`]/.test(text)) out.push("lieflat.mjs reads claims.jsonl itself");
  if (/\bisSystemVerifiedClaim\b/.test(text)) out.push("lieflat.mjs decides system verification itself");
  if (!/input\??\.verified_claims/.test(text)) out.push("lieflat.mjs does not take verified_claims from its caller");
  return out;
}
assert.deepEqual(lieflatProblems(lieflat), [], "lieflat takes the verified records from the calling tool");
assert.ok(lieflatProblems(`${lieflat}\nconst p = join(root, "claims.jsonl");`).length, "lieflat reading claims.jsonl again is red");
assert.ok(lieflatProblems(`import { isSystemVerifiedClaim } from "./evidence_gate.mjs";\n${lieflat}`).length, "lieflat deciding verification again is red");
assert.match(src.match(/renderLieflatPublication\(\{[^}]*\}\)/)?.[0] ?? "", /verified_claims: await verifiedClaimRecords\(\)/, "the lieflat tool passes the records");
console.log("gate stamp callers -- PASS");
