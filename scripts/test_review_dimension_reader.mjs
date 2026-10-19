#!/usr/bin/env node
// JS side of the same rule: a record with a dimension key is not a vote on the total preference.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artDirectionHash, programReviewFromRecord } from "../runtime/pi/art_direction.mjs";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/review_record_golden.json", import.meta.url)), "utf8"));
const refs = { baselineRef: golden.baseline_ref, candidateRef: golden.candidate_ref };
const { content_hash: _drop, ...body } = golden;
const withHash = (extra) => { const b = { ...body, ...extra }; return { ...b, content_hash: artDirectionHash(b) }; };
assert.ok(programReviewFromRecord(withHash({}), refs), "a total record counts");
assert.equal(programReviewFromRecord(withHash({ dimension: "chart_choice" }), refs), null, "a dimension record is not a total vote");
assert.equal(programReviewFromRecord(withHash({ dimension: null }), refs), null, "a null dimension key is not the same as no key: refused");
console.log("review dimension reader (JS): ok");
