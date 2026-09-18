import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDatasetPayload,
  assertEvidenceBackedStatus,
  assertInlineRowsHaveEvidence,
  assertUsableSourceRecord,
  createSourceAccessCircuit,
  evidenceRefFromFingerprint,
  requireVerifiedClaim,
} from "../runtime/pi/evidence_gate.mjs";

assert.doesNotThrow(() => assertEvidenceBackedStatus("hypothesis", []));
assert.throws(() => assertEvidenceBackedStatus("supported", []), /EVIDENCE_REQUIRED/);
assert.throws(() => assertEvidenceBackedStatus("verified", []), /EVIDENCE_REQUIRED/);
assert.throws(() => assertEvidenceBackedStatus("verified", ["sources/good.json"], []), /COMPUTATION_REQUIRED/);
assert.doesNotThrow(() => assertEvidenceBackedStatus("verified", ["sources/good.json"], ["computations/good.json"]));

const claims = new Map([
  ["verified", {
    claim_id: "verified",
    status: "verified",
    claim: "Evidence-backed fixture claim",
    source_refs: ["data/fixture.csv"],
    computation_refs: ["computations/exact.json"],
  }],
  ["unsupported", { claim_id: "unsupported", status: "supported", source_refs: ["data/fixture.csv"] }],
]);

assert.equal(requireVerifiedClaim(claims, "verified", "computations/exact.json").claim_id, "verified");
assert.throws(() => requireVerifiedClaim(claims, "missing"), /VERIFIED_CLAIM_REQUIRED/);
assert.throws(() => requireVerifiedClaim(claims, "unsupported"), /VERIFIED_CLAIM_REQUIRED/);
assert.throws(() => requireVerifiedClaim(claims, "verified", "computations/synthetic.json"), /COMPUTATION_PROVENANCE_REQUIRED/);

const source = { status: 200, text: "usable evidence", content_hash: "expected" };
assert.doesNotThrow(() => assertUsableSourceRecord(source, "sources/good.json", "expected"));
assert.throws(() => assertUsableSourceRecord({ ...source, status: 503 }, "sources/error.json", "expected"), /HTTP 2xx/);
assert.throws(() => assertUsableSourceRecord({ ...source, text: "" }, "sources/empty.json", "expected"), /no usable text/);
assert.throws(() => assertUsableSourceRecord(source, "sources/tampered.json", "different"), /content hash does not match/);
assert.doesNotThrow(() => assertDatasetPayload("data/fixture.csv", 10));
assert.throws(() => assertDatasetPayload("data/fixture.csv.meta.json", 10), /not a data payload/);
assert.throws(() => assertDatasetPayload("data/fixture.csv", 0), /dataset is empty/);
assert.throws(() => assertInlineRowsHaveEvidence("SELECT * FROM (VALUES (1, 'invented'))", false), /SYNTHETIC_DATA_BLOCKED: EVIDENCE_REQUIRED/);
assert.doesNotThrow(() => assertInlineRowsHaveEvidence("SELECT * FROM (VALUES (1, 'fixture'))", true));
assert.doesNotThrow(() => assertInlineRowsHaveEvidence("SELECT * FROM read_csv_auto('data/fixture.csv')", false));

const fixtureRoot = await mkdtemp(join(tmpdir(), "newsroom-evidence-gate-"));
try {
  const fixture = join(fixtureRoot, "local.csv");
  await writeFile(fixture, "route,value\nA-B,12\n", "utf8");
  const fixtureInfo = await stat(fixture);
  const importedRef = evidenceRefFromFingerprint("data:data/fixture.csv:fixture-sha256");
  assert.equal(importedRef, "data/fixture.csv");
  assert.doesNotThrow(() => assertDatasetPayload(importedRef, fixtureInfo.size));
  assert.doesNotThrow(() => assertInlineRowsHaveEvidence("SELECT * FROM (VALUES ('fixture', 12))", true));
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

const circuit = createSourceAccessCircuit(3);
circuit.assertAvailable();
const firstFailure = circuit.recordFailure("news_search", new Error("secret-token-must-not-leak"));
assert.match(firstFailure.message, /SOURCE_ACCESS_FAILED/);
assert.doesNotMatch(firstFailure.message, /secret-token-must-not-leak/);
circuit.recordSuccess();
assert.equal(circuit.failureCount(), 0);
circuit.recordFailure("fetch_url", new Error("HTTP 503"));
const secondFailure = circuit.recordFailure("fetch_url", new Error("network"));
assert.match(secondFailure.message, /SOURCE_ACCESS_FAILED/);
const terminalFailure = circuit.recordFailure("fetch_url", new Error("network"));
assert.match(terminalFailure.message, /SOURCE_ACCESS_BLOCKED/);
assert.throws(() => circuit.assertAvailable(), /SOURCE_ACCESS_BLOCKED/);
assert.equal(circuit.failureCount(), 3);

const extension = await readFile(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
assert.match(extension, /assertEvidenceBackedStatus\(params\.status, params\.source_refs, params\.computation_refs\)/);
assert.match(extension, /requireVerifiedClaim\(await verifiedClaimRecords\(\), params\.claim_id, computationRef\)/);
assert.match(extension, /await validateSourceEvidence\(claim\.source_refs\)/);
assert.match(extension, /assertInlineRowsHaveEvidence\(safeSql, await hasUsableEvidenceInput\(inputSnapshot\)\)/);
assert.match(extension, /claim_id: Type\.String\(\{ description: "Verified claim_id whose cited computation exactly matches this chart query" \}\)/);

const prompt = await readFile(new URL("../prompts/investigate.md", import.meta.url), "utf8");
assert.match(prompt, /never substitute synthetic, representative, illustrative, remembered, or model-generated values/i);
assert.match(prompt, /do not generate a factual chart or infographic/i);
assert.match(prompt, /respond in Simplified Chinese/i);

console.log("evidence gate: PASS (unsupported claims and synthetic chart bypass blocked)");
