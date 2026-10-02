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

// `readsEvidence` must be true only when the statement itself reads at least
// one data/ or sources/ file (derived from the SQL, never from what happens to
// exist in the artifact directory).
export function assertInlineRowsHaveEvidence(sql, readsEvidence) {
  if (INLINE_ROW_SQL.test(String(sql ?? "")) && !readsEvidence) {
    throw new Error("SYNTHETIC_DATA_BLOCKED: EVIDENCE_REQUIRED before inline VALUES or generated rows can be analyzed; the query must read a data/ or sources/ input");
  }
}

// A computation may support a claim only when it reads at least one of the
// cited data/ or sources/ artifacts. `effectiveInputs` are the files the SQL
// really reads (transitively), never the directory-wide snapshot.
export function assertComputationBoundToSources(ref, binding, effectiveInputs, sourceRefs) {
  if (binding !== "source_bound") {
    throw new Error(`COMPUTATION_PROVENANCE_REQUIRED: ${ref} reads no resolvable data/ or sources/ input (binding: ${binding || "legacy"}); literal-only or unresolved computations cannot support a claim`);
  }
  const inputs = new Set(effectiveInputs ?? []);
  if (!(sourceRefs ?? []).some((sourceRef) => inputs.has(sourceRef))) {
    throw new Error(`COMPUTATION_PROVENANCE_REQUIRED: ${ref} does not read any cited source artifact`);
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
        { cause: error },
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
    // Read-only twin of assertAvailable, for callers that must let the stronger
    // SOURCE_ACCESS_BLOCKED stop instruction win over a softer refusal.
    isBlocked(key) {
      return countFor(key) >= boundedLimit;
    },
  };
}

// download_data aborts a request after 30 s. A bare AbortError told the model
// nothing and four identical retries cost two minutes, so the abort becomes a
// structured error and an identical retry is refused at once. The request key
// lives in this process's memory only; it is never written to disk.
export const DOWNLOAD_TIMEOUT_HINT = "Retrying the same URL rarely helps. Make the request lighter: fewer series or a shorter period; for SDMX APIs (ECB, Eurostat, OECD, IMF, BIS) add `detail=dataonly`; or use another source.";

function downloadRequestKey({ method, url, body } = {}) {
  let href = String(url ?? "");
  // The fragment never reaches the server, so it does not make a request different.
  try { const parsed = new URL(href); parsed.hash = ""; href = parsed.href; } catch { /* keep the raw text */ }
  const payload = body === undefined || body === null ? ""
    : typeof body === "string" ? body
    : ArrayBuffer.isView(body) ? Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)).join(",")
    : JSON.stringify(body);
  return `${String(method || "GET").toUpperCase()} ${href}\n${payload}`;
}

function downloadAbortSurfaced(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (current.name === "AbortError") return true;
  }
  return false;
}

export function createDownloadTimeoutGuard(limitMs = 30_000) {
  const timedOut = new Map();
  const limitSeconds = Math.round(limitMs / 1000);
  const seconds = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
  const hostOf = (url) => {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch { return undefined; }
  };
  const structured = (code, message, fields) => Object.assign(new Error(`${code}: ${message} ${DOWNLOAD_TIMEOUT_HINT}`), { code, hint: DOWNLOAD_TIMEOUT_HINT, ...fields });
  return {
    hostOf,
    // Refuses a request that already timed out in this process. Any change to
    // the URL, method or body is a different key and passes.
    assertNotRepeat(request) {
      const earlier = timedOut.get(downloadRequestKey(request));
      if (earlier === undefined) return;
      const host = hostOf(request?.url) ?? "unknown host";
      throw structured(
        "DOWNLOAD_TIMEOUT_REPEAT",
        `this exact request to ${host} already timed out after ${seconds(earlier)} s in this session, so it was not sent again.`,
        { host, elapsed_seconds: Number(seconds(earlier)) },
      );
    },
    // Called when the tool's own timer fired. Returns the error to throw: the
    // structured DOWNLOAD_TIMEOUT when the failure is the abort surfacing, and
    // the original error otherwise. SOURCE_ACCESS_BLOCKED is a stop instruction
    // and passes through unchanged.
    recordTimeout(request, elapsedMs, error) {
      if (!downloadAbortSurfaced(error) || /^SOURCE_ACCESS_BLOCKED:/.test(String(error?.message ?? ""))) return error;
      timedOut.set(downloadRequestKey(request), elapsedMs);
      const host = hostOf(request?.url) ?? "unknown host";
      return structured(
        "DOWNLOAD_TIMEOUT",
        `${host} did not finish the download in ${seconds(elapsedMs)} s (limit ${limitSeconds} s).`,
        { host, elapsed_seconds: Number(seconds(elapsedMs)) },
      );
    },
  };
}
