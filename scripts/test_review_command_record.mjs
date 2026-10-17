#!/usr/bin/env node
// The record `news review` writes (Rust, src/commands/review.rs) is read by the JS reader. The golden record is the one the Rust unit test
// `the_golden_record_hash_matches_the_rust_hash` pins; a record edited by hand, with a changed ref (a changed candidate file), or with another kind does not count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { programReviewFromRecord } from "../runtime/pi/art_direction.mjs";
import { classifyArtifact, loadGroups } from "../runtime/pi/groups.mjs";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/review_record_golden.json", import.meta.url)), "utf8"));
const refs = { baselineRef: golden.baseline_ref, candidateRef: golden.candidate_ref };
const review = programReviewFromRecord(golden, refs);
assert.ok(review, "a command-made record counts");
assert.equal(review.preference, "candidate");
assert.equal(programReviewFromRecord({ ...golden, preference: "baseline" }, refs), null, "a hand-edited record does not count");
assert.equal(programReviewFromRecord({ ...golden, saved_by: "model" }, refs), null);
assert.equal(programReviewFromRecord({ ...golden, kind: "model_reported_review" }, refs), null);
assert.equal(programReviewFromRecord(golden, { ...refs, candidateRef: golden.candidate_ref.replace(/b+$/, "c".repeat(64)) }), null, "a changed candidate file makes the record stale");
const { content_hash, ...rest } = golden;
assert.equal(programReviewFromRecord(rest, refs), null, "no hash, no count");
// no model tool can write the folder, by the group table: the path is human_review, owned by system, and only the two status tools are system
const klass = classifyArtifact("editorial/human-reviews/x.json");
assert.deepEqual([klass?.kind, klass?.owner], ["human_review", "system"]);
assert.equal(classifyArtifact("editorial/asset-plan.json")?.owner, "visual", "the rest of editorial/ is unchanged");
const table = loadGroups();
const systemTools = Object.entries(table.tools).filter(([, v]) => v.group === "system").map(([k]) => k).sort();
assert.deepEqual(systemTools, ["newsroom_graph_extraction_status", "newsroom_visual_backend_status"]);
assert.ok(!JSON.stringify(table.handoffs.writers).includes("human_review"));
assert.ok(table.handoffs.rows.every((row) => row.paths.every((path) => !"editorial/human-reviews/x.json".startsWith(path))), "no hand-off row reaches the folder");
console.log("review command record (JS reader): ok");
