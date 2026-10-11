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
const REQUIRED = { newsroom_viz_plan: ["verifiedClaimFor(", "chartPlanStamp("], newsroom_viz_lint: ["chartLintStatus("], newsroom_viz_render: ["chartRenderStatus("] };

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
const lint = toolBody(src, "newsroom_viz_lint");
const lintBad = src.replace(lint, lint.replace("...lintStamp,", "artifact_status: systemVerified ? \"VERIFIED\" : \"DRAFT\","));
assert.ok(problems(lintBad).some((m) => /newsroom_viz_lint calls/.test(m)), "viz_lint stamping itself is red");
const lintBad2 = src.replace(lint, lint.replace("await chartLintStatus(spec.claim_id, claimBindings)", "{ systemVerified: Boolean((await verifiedClaimIds()).length), stamp: {} }"));
assert.ok(problems(lintBad2).length, "viz_lint reading the registry itself is red");
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

// The gate functions labelled "only the knowledge group calls it directly" (groups.json cross_calls.imported, why starts with KNOWLEDGE_ONLY) have
// no direct caller in newsroom.ts outside the knowledge-side functions listed here; a visual tool or helper calling one directly is red.
const KNOWLEDGE_ONLY = "只有知识组直接调用";
const KNOWLEDGE_SIDE = new Set(["chartVerificationStamp", "recordClaimArtifact", "validateSourceEvidence", "replayComputationEvidence"]);
const groupsList = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
export function directCallers(text, name) {
  const lines = text.split("\n");
  const out = new Set();
  let current = null;
  for (const line of lines) {
    const decl = line.match(/^(?:export )?(?:async )?function (\w+)/) ?? line.match(/^    name: "(\w+)"/);
    if (decl) current = decl[1];
    if (new RegExp(`\\b${name}\\b`).test(line) && !/^\s*(\/\/|import)/.test(line) && !new RegExp(`function ${name}\\b`).test(line) && !line.includes('from "./evidence_gate')) out.add(current);
  }
  return [...out];
}
const labelled = Object.entries(groupsList.cross_calls.imported).filter(([, v]) => String(v.why).startsWith(KNOWLEDGE_ONLY)).map(([k]) => k.split("::")[1]);
assert.ok(labelled.length >= 4, "the knowledge-only label is on the gate functions");
for (const name of labelled) {
  const outside = directCallers(src, name).filter((c) => !KNOWLEDGE_SIDE.has(c));
  assert.deepEqual(outside, [], `${name} is labelled knowledge-only but is called directly by ${outside}`);
}
assert.deepEqual(directCallers(`${src}\nfunction vizHelper() { return deriveClaimVerification({}); }`, "deriveClaimVerification").filter((c) => !KNOWLEDGE_SIDE.has(c)), ["vizHelper"], "a visual helper calling a knowledge-only function directly is seen");

// isSystemVerifiedClaim is called only by the two gated read-only entries; a visual tool or helper calling it directly is red.
const ENTRIES = new Set(["verifiedClaimIds", "verifiedClaimRecords"]);
for (const name of ENTRIES) assert.ok(groupsList.cross_calls.gated.includes(name), `${name} is a gated entry`);
assert.deepEqual(directCallers(src, "isSystemVerifiedClaim").filter((c) => !ENTRIES.has(c)), [], "isSystemVerifiedClaim is reached only through the gated entries");
assert.deepEqual(directCallers(`${src}\nasync function vizHelper(c) { return isSystemVerifiedClaim(c); }`, "isSystemVerifiedClaim").filter((c) => !ENTRIES.has(c)), ["vizHelper"], "bypassing the entries is seen");
assert.deepEqual(directCallers(src.replace('name: "newsroom_story_graph"', 'name: "newsroom_story_graph"\n    x: isSystemVerifiedClaim(1),'), "isSystemVerifiedClaim").filter((c) => !ENTRIES.has(c)), ["newsroom_story_graph"], "a visual tool calling it directly is seen");
console.log("gate stamp callers -- PASS");
