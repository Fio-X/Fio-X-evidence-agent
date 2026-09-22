const EVIDENCE_BACKED_STATUSES = new Set(["supported", "verified"]);
const INLINE_ROW_SQL = /\b(values|unnest|generate_series)\s*\(/i;
export const SYSTEM_VERIFICATION_RULE_ID = "verification.source+extraction+computation+claim.v1";

export function deriveClaimVerification(gates = {}) {
  const verification = {
    authority: "system",
    source_resolved: gates.source_resolved === true,
    extraction_passed: gates.extraction_passed === true,
    computation_replayed: gates.computation_replayed === true,
    claim_supported: gates.claim_supported === true,
    publishable: false,
    rule_id: SYSTEM_VERIFICATION_RULE_ID,
  };
  verification.publishable = verification.source_resolved
    && verification.extraction_passed
    && verification.computation_replayed
    && verification.claim_supported;
  return verification;
}

export function isSystemVerifiedClaim(claim) {
  const verification = claim?.verification;
  return claim?.status === "verified"
    && verification?.authority === "system"
    && verification?.rule_id === SYSTEM_VERIFICATION_RULE_ID
    && verification?.source_resolved === true
    && verification?.extraction_passed === true
    && verification?.computation_replayed === true
    && verification?.claim_supported === true
    && verification?.publishable === true;
}

const AUTO_VERIFIABLE_CLAIM_KINDS = new Set(["descriptive", "quantitative", "comparative", "uncertainty"]);
const UNSUPPORTED_INFERENCE_LANGUAGE = /\b(caus(?:e|ed|al)|driv(?:e|en)|because|labou?r|war|conflict)\b|驱动|导致|因为|劳动力|战争|冲突|反映.{0,12}(原因|危机|政策)/iu;

export function evaluateClaimSupport({ requested_status, claim_kind, claim } = {}) {
  const reasons = [];
  if (requested_status !== "supported") reasons.push("claim_not_requested_as_supported");
  if (!AUTO_VERIFIABLE_CLAIM_KINDS.has(String(claim_kind ?? ""))) reasons.push("claim_kind_requires_external_support_review");
  if (UNSUPPORTED_INFERENCE_LANGUAGE.test(String(claim ?? ""))) reasons.push("claim_contains_unbound_causal_or_motive_language");
  return { passed: reasons.length === 0, authority: "system", rule_id: "claim_support.provenance_bound_noncausal.v1", reasons };
}

export function assertEvidenceBackedStatus(status, sourceRefs, computationRefs = []) {
  const normalizedStatus = String(status ?? "");
  const refs = Array.isArray(sourceRefs) ? sourceRefs.filter((ref) => String(ref).trim()) : [];
  if (EVIDENCE_BACKED_STATUSES.has(normalizedStatus) && refs.length === 0) {
    throw new Error(`EVIDENCE_REQUIRED: a ${normalizedStatus} claim requires at least one source artifact reference`);
  }
  const computations = Array.isArray(computationRefs)
    ? computationRefs.filter((ref) => String(ref).trim())
    : [];
  if (normalizedStatus === "verified" && computations.length === 0) {
    throw new Error("COMPUTATION_REQUIRED: a verified claim requires at least one deterministic computation artifact");
  }
}

export function requireVerifiedClaim(claimRecords, claimId, computationRef = null) {
  const normalizedId = String(claimId ?? "").trim();
  const claim = claimRecords?.get?.(normalizedId);
  if (!isSystemVerifiedClaim(claim)) {
    throw new Error(`VERIFIED_CLAIM_REQUIRED: claim_id '${normalizedId}' is not a verified recorded claim`);
  }
  if (!Array.isArray(claim.source_refs) || claim.source_refs.length === 0) {
    throw new Error(`EVIDENCE_REQUIRED: verified claim '${normalizedId}' has no source artifacts`);
  }
  if (computationRef && (!Array.isArray(claim.computation_refs) || !claim.computation_refs.includes(computationRef))) {
    throw new Error(`COMPUTATION_PROVENANCE_REQUIRED: verified claim '${normalizedId}' does not reference ${computationRef}`);
  }
  return claim;
}

export function assertUsableSourceRecord(source, ref, expectedHash) {
  const status = Number(source?.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new Error(`INVALID_SOURCE_EVIDENCE: source snapshot did not return HTTP 2xx: ${ref}`);
  }
  if (typeof source?.text !== "string" || !source.text.trim()) {
    throw new Error(`INVALID_SOURCE_EVIDENCE: source snapshot has no usable text: ${ref}`);
  }
  if (source?.content_hash !== expectedHash) {
    throw new Error(`INVALID_SOURCE_EVIDENCE: source snapshot content hash does not match: ${ref}`);
  }
}

export function assertDatasetPayload(ref, size) {
  const normalizedRef = String(ref ?? "");
  if (normalizedRef.includes("/origins/") || normalizedRef.endsWith(".meta.json")) {
    throw new Error(`INVALID_SOURCE_EVIDENCE: dataset metadata is not a data payload: ${normalizedRef}`);
  }
  if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
    throw new Error(`INVALID_SOURCE_EVIDENCE: dataset is empty: ${normalizedRef}`);
  }
}

export function assertInlineRowsHaveEvidence(sql, hasUsableEvidence) {
  if (INLINE_ROW_SQL.test(String(sql ?? "")) && !hasUsableEvidence) {
    throw new Error("SYNTHETIC_DATA_BLOCKED: EVIDENCE_REQUIRED before inline VALUES or generated rows can be analyzed");
  }
}

export function evidenceRefFromFingerprint(fingerprint) {
  const value = String(fingerprint ?? "");
  const first = value.indexOf(":");
  const last = value.lastIndexOf(":");
  if (first < 0 || last <= first) return null;
  const kind = value.slice(0, first);
  const stored = value.slice(first + 1, last);
  if (kind === "source" && stored) return `sources/${stored}`;
  if (kind === "data" && stored.startsWith("data/")) return stored;
  return null;
}

export function createSourceAccessCircuit(limit = 3) {
  const failuresByKey = new Map();
  const boundedLimit = Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 3);
  const keyOf = (key) => String(key ?? "global");
  const countFor = (key) => failuresByKey.get(keyOf(key)) ?? 0;
  const blocked = (key) => new Error(
    `SOURCE_ACCESS_BLOCKED: ${countFor(key)} consecutive source-access attempts failed. Stop source-dependent reporting; do not substitute synthetic data. Report the access blocker or use a user-supplied local dataset.`,
  );
  return {
    assertAvailable(key) {
      if (countFor(key) >= boundedLimit) throw blocked(key);
    },
    recordFailure(tool, error, key) {
      const normalizedKey = keyOf(key);
      const failures = countFor(normalizedKey) + 1;
      failuresByKey.set(normalizedKey, failures);
      if (failures >= boundedLimit) return blocked(normalizedKey);
      const message = String(error?.message ?? error ?? "");
      const http = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
      const reason = error?.name === "AbortError" ? "timed out or was cancelled" : http ? `returned HTTP ${http}` : "could not reach a public source";
      return new Error(
        `SOURCE_ACCESS_FAILED: ${String(tool ?? "source tool")} ${reason} (${failures}/${boundedLimit}). Do not substitute synthetic data; try a bounded alternative source.`,
      );
    },
    // A successful source proves that the route is usable. Keep the circuit
    // focused on consecutive failures so one rate-limited discovery endpoint
    // cannot suppress later primary-source fetches that work.
    recordSuccess(key) {
      failuresByKey.delete(keyOf(key));
    },
    failureCount(key) {
      return countFor(key);
    },
  };
}
