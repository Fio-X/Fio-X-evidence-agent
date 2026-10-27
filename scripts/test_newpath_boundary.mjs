#!/usr/bin/env node
// New-route step 1 (K1680): what the four-group tables say today about the two places the new route would write or call, with the refusals on.
//  1. A claim registered from the agent group's design pack is refused (recordClaimArtifact is gated, and the agent group is on no line of it), while the
//     knowledge group's data_prepare passes: so `picks` lives on data_prepare, one request more, and no cross_calls line is added.
//  2. The candidate sheet cannot live in a new top-level folder: candidates/ matches no artifact kind (待查), so the write would be refused. shadow/ is the
//     observation kind the knowledge group owns, so a knowledge tool writes there with no new row (that the files cannot be cited as evidence is
//     judged on the real reference gate in test_claim_candidates.mjs).
// Usage: node scripts/test_newpath_boundary.mjs
import assert from "node:assert/strict";
import { classifyArtifact, crossCallProblem, loadGroups } from "../runtime/pi/groups.mjs";

for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const list = loadGroups();
const results = [];
const check = (name) => results.push(name);

// 1. who may register a claim
assert.ok(list.cross_calls.gated.includes("recordClaimArtifact"), "recordClaimArtifact is gated");
assert.equal(list.tools.newsroom_design_pack.group, "agent");
assert.equal(list.tools.newsroom_data_prepare.group, "knowledge");
assert.match(crossCallProblem(list, "recordClaimArtifact", "newsroom_design_pack", true) ?? "", /not listed in cross_calls/, "design pack (agent) is refused");
assert.equal(crossCallProblem(list, "recordClaimArtifact", "newsroom_data_prepare", true), null, "data_prepare (knowledge) passes");
assert.ok(!list.cross_calls.functions.recordClaimArtifact.groups.includes("agent"), "the agent group is on no line of it");
check("claim registration: design_pack refused, data_prepare passes (picks go on data_prepare)");

// 2. where the candidate sheet may be written
assert.equal(classifyArtifact("candidates/a.json"), null, "candidates/ matches no kind today");
assert.deepEqual(classifyArtifact("shadow/candidate_sheet-abc.json"), { kind: "observation", owner: "knowledge" });
assert.equal(list.artifact_kinds.ownership.observation.owner, "knowledge");
check("candidates/ is unclassified; shadow/ is knowledge-owned observation");

// A file under shadow/ cannot be a source or computation reference: judged on the real normalizeArtifactRefs in test_claim_candidates.mjs.

console.log(`ok: ${results.length} checks\n- ${results.join("\n- ")}`);
