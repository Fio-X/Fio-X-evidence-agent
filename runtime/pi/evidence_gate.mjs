import { trackExport } from "./groups.mjs";
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
const UNSUPPORTED_INFERENCE_LANGUAGE = /\b(caus(?:e|ed|al)|driv(?:e|en)|because|labou?r|war|conflict)\b|驱动|导致|因为|劳动力|战争|冲突|反映.{0,12}(原因|危机|政策)|造成|引起|由于(?!统计口径|口径|四舍五入|舍入|取整|数据缺失|缺测|数据修订|统计修订|数据调整|统计调整|季节调整)|归因|致使|促使|所致|(?<!(?:数据|资料|信息)来?)源于|\b(?:(?:due to|owing to)(?!\s+(?:rounding|round-off|data revisions?|missing data|missing values|changes? in (?:definition|methodology)|methodology))|thanks to|led to|leads? to|result(?:s|ed|ing)? in)\b/iu;

// extra_causal_phrases_en (callers pass NEWSROOM_CAUSAL_PHRASES_EN === "1", default off; this helper stays pure and reads no environment): also refuse "as a result of" (a causal phrase the rule above does not name). Only ever adds a refusal; "due to", "owing to", "thanks to" and "because (of)" are already refused by the rule above.
const EXTRA_CAUSAL_PHRASES_EN = /\bas\s+a\s+result\s+of\b/iu;

export function evaluateClaimSupport({ requested_status, claim_kind, claim, extra_causal_phrases_en } = {}) {
  const reasons = [];
  if (requested_status !== "supported") reasons.push("claim_not_requested_as_supported");
  if (!AUTO_VERIFIABLE_CLAIM_KINDS.has(String(claim_kind ?? ""))) reasons.push("claim_kind_requires_external_support_review");
  if (UNSUPPORTED_INFERENCE_LANGUAGE.test(String(claim ?? "")) || (extra_causal_phrases_en === true && EXTRA_CAUSAL_PHRASES_EN.test(String(claim ?? "")))) reasons.push("claim_contains_unbound_causal_or_motive_language");
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

// Added to the refusals of both gates by newsroom.ts (to the one below through its hint argument, to the one above after the gate has thrown) only when NEWSROOM_READ_INPUT_NAMED_HINT is exactly "1" and the SQL gives a file reader a
// `name = value` argument, which DuckDB runs but the read-input analysis cannot resolve (`name := value` it can).
export const NAMED_READ_PARAM_HINT = "A file reader option written as `name = value` makes the path unresolvable; write it as `name := value` (for example `header := true`) and keep the path the only positional argument.";

// A computation may support a claim only when it reads at least one of the
// cited data/ or sources/ artifacts. `effectiveInputs` are the files the SQL
// really reads (transitively), never the directory-wide snapshot.
export function assertComputationBoundToSources(ref, binding, effectiveInputs, sourceRefs, hint = "") {
  if (binding !== "source_bound") {
    throw new Error(`COMPUTATION_PROVENANCE_REQUIRED: ${ref} reads no resolvable data/ or sources/ input (binding: ${binding || "legacy"}); literal-only or unresolved computations cannot support a claim${hint ? ` ${hint}` : ""}`);
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

// True when the error, or an error it wraps, is an AbortError. Only the circuit calls this, on the raw error, and
// keeps nothing but the boolean.
function abortInChain(error) {
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (current.name === "AbortError") return true;
  }
  return false;
}

// NEWSROOM_FAST_FAIL=1: the closed list of codes that mean the host could not be reached at all, so no HTTP answer can have
// come from it: the connect timeout, a name that does not resolve, a refused connection, no route. A code outside the list,
// no code, an HTTP status, or an abort anywhere in the chain gets no label and is handled as it always was. ECONNRESET is
// outside the list on purpose: it usually comes back quickly, so recording the host would save little time, and a proxy blip
// would also hit a host that works.
const UNREACHABLE_CATEGORY_BY_CODE = new Map([
  ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "refused"],
  ["EHOSTUNREACH", "no_route"],
  ["ENETUNREACH", "no_route"],
]);
// What the model reads: the reason in the first failure and the short label in the later refusal. Fixed text per category,
// nothing of the raw error.
const UNREACHABLE_TEXT = {
  connect_timeout: { reason: "hit the connect timeout: the host did not accept a connection in time", label: "connect timeout" },
  dns: { reason: "could not resolve the host name", label: "host name did not resolve" },
  refused: { reason: "was refused: the host refused the connection", label: "connection refused" },
  no_route: { reason: "found no route to the host", label: "no route to the host" },
};
// Said in each failure that marks the host, so the model does not spend a turn on a second try.
const UNREACHABLE_NOTE = "This host will not be tried again in this run.";

// The category of a failure that never got an HTTP answer, or null. Reads only `.code` along the cause chain (the
// AggregateError of a multi-address connect carries its own code), at most four levels, and keeps nothing else. The first
// code found decides, so a code that is not on the list is no label; an abort anywhere in the chain wins over every code.
function unreachableCategory(error) {
  if (abortInChain(error)) return null;
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth += 1) {
    if (typeof current.code === "string") return UNREACHABLE_CATEGORY_BY_CODE.get(current.code) ?? null;
  }
  return null;
}

// options.fastFail: a function the caller passes for NEWSROOM_FAST_FAIL, read at every call. Without it (the default, and
// whenever it does not return true) the circuit does exactly what it did before.
export function createSourceAccessCircuit(limit = 3, options = {}) {
  const failuresByKey = new Map();
  const boundedLimit = Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 3);
  const keyOf = (key) => String(key ?? "global");
  const countFor = (key) => failuresByKey.get(keyOf(key)) ?? 0;
  const blocked = (key) => new Error(
    `SOURCE_ACCESS_BLOCKED: ${countFor(key)} consecutive source-access attempts failed. Stop source-dependent reporting; do not substitute synthetic data. Report the access blocker or use a user-supplied local dataset.`,
  );
  const fastFailOn = () => typeof options?.fastFail === "function" && options.fastFail() === true;
  // Hosts that could not be reached at all, each with the category of the failure that marked it. In memory only: one run
  // is the reset boundary, like the failure counts.
  const unreachableByKey = new Map();
  // Hosts that answered in this run. A host that answered was not unreachable at all, so a later connection failure (a
  // dropped keep-alive socket, a proxy blip) is a failure like any other and never marks it.
  const succeededKeys = new Set();
  // The refusals this circuit raised itself. A refusal sends nothing, so it is not a failure of the host; safeFetch hands
  // every error it catches back to recordFailure, which must not count these (the same reasoning as the repeat refusal of download_data).
  const ownRefusals = new WeakSet();
  const refusal = (key, category) => {
    const error = Object.assign(
      new Error(`SOURCE_HOST_UNREACHABLE: ${key} could not be reached earlier in this run (${UNREACHABLE_TEXT[category].label}), so this request was not sent. Use a different host; do not substitute synthetic data.`),
      { code: "SOURCE_HOST_UNREACHABLE", host: key },
    );
    ownRefusals.add(error);
    return error;
  };
  return {
    assertAvailable(key) {
      if (countFor(key) >= boundedLimit) throw blocked(key);
      // The stronger stop above wins; this softer refusal only tells the model to pick another host.
      const category = fastFailOn() ? unreachableByKey.get(keyOf(key)) : undefined;
      if (category) throw refusal(keyOf(key), category);
    },
    recordFailure(tool, error, key) {
      if (ownRefusals.has(error)) return error;
      const normalizedKey = keyOf(key);
      const failures = countFor(normalizedKey) + 1;
      failuresByKey.set(normalizedKey, failures);
      const fastFail = fastFailOn();
      // With the switch off the order is the one it always had: the last allowed failure is answered before the error is read.
      if (!fastFail && failures >= boundedLimit) return blocked(normalizedKey);
      const message = String(error?.message ?? error ?? "");
      const http = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
      // Only a failure with no HTTP answer marks its host for the rest of the run. An HTTP status, an abort, a timeout
      // other than the connect timeout, every code outside the closed list and a host that answered earlier in this run
      // leave the host as it was.
      const category = fastFail && !http ? unreachableCategory(error) : null;
      let marked = false;
      if (category && key != null && !succeededKeys.has(normalizedKey)) {
        unreachableByKey.set(normalizedKey, category);
        marked = true;
      }
      if (failures >= boundedLimit) return blocked(normalizedKey);
      const aborted = abortInChain(error);
      const reason = aborted ? "timed out or was cancelled" : http ? `returned HTTP ${http}` : category ? UNREACHABLE_TEXT[category].reason : "could not reach a public source";
      // The raw error can carry the request URL or provider diagnostics, so it is not attached as `cause`. The only
      // thing a caller needs from it is whether the request was aborted, and that travels as a boolean.
      return Object.assign(
        new Error(`SOURCE_ACCESS_FAILED: ${String(tool ?? "source tool")} ${reason} (${failures}/${boundedLimit}). ${marked ? `${UNREACHABLE_NOTE} ` : ""}Do not substitute synthetic data; try a bounded alternative source.`),
        aborted ? { request_aborted: true } : {},
      );
    },
    // A successful source proves that the route is usable. Keep the circuit
    // focused on consecutive failures so one rate-limited discovery endpoint
    // cannot suppress later primary-source fetches that work.
    recordSuccess(key) {
      failuresByKey.delete(keyOf(key));
      succeededKeys.add(keyOf(key));
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
// structured error. One identical retry is allowed (a slow server is sometimes
// fast the second time); after the second timeout of the same request the key is
// refused. Counts live in this process's memory only and are never written to
// disk: one CLI run is the reset boundary.
export const DOWNLOAD_TIMEOUT_HINT = "One identical retry is allowed; after a second timeout that exact request is refused for the rest of this run. Prefer splitting it into smaller requests (fewer series or a shorter period each) and combining them in SQL, but every series and period the question needs must still be fetched. Keep each series' attributes (units, multipliers, scale) and narrow the request by series or period instead; or use another source.";
export const DOWNLOAD_TIMEOUTS_ALLOWED = 2;

// The key of a request: method, scheme, host and path, the query parameters stably sorted by name only (repeated
// names keep their relative order, which a first- or last-value server can tell apart), and the body. URL parsing lowercases scheme and host and drops a default port; the fragment never
// reaches the server and is dropped.
export function downloadRequestKey({ method, url, body } = {}) {
  let target = String(url ?? "");
  try {
    const parsed = new URL(target);
    const pairs = [...parsed.searchParams.entries()].sort(([an], [bn]) => (an < bn ? -1 : an > bn ? 1 : 0));
    const query = pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
    target = `${parsed.protocol}//${parsed.host}${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch { /* keep the raw text */ }
  const payload = body === undefined || body === null ? ""
    : typeof body === "string" ? body
    : ArrayBuffer.isView(body) ? Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)).join(",")
    : JSON.stringify(body);
  return `${String(method || "GET").toUpperCase()} ${target}\n${payload}`;
}

// The circuit's error carries a boolean instead of its cause; a bare AbortError (thrown while the body is read)
// carries its name.
function downloadAbortSurfaced(error) {
  return error?.name === "AbortError" || error?.request_aborted === true;
}

export function createDownloadTimeoutGuard(limitMs = 30_000) {
  const timedOut = new Map(); // key -> { count, elapsedMs of the latest timeout }
  const limitSeconds = Math.round(limitMs / 1000);
  const seconds = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
  const hostOf = (url) => {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch { return undefined; }
  };
  const structured = (code, message, fields) => Object.assign(new Error(`${code}: ${message} ${DOWNLOAD_TIMEOUT_HINT}`), { code, hint: DOWNLOAD_TIMEOUT_HINT, ...fields });
  return {
    hostOf,
    // Refuses a request that timed out twice in this process. The first timeout
    // allows one identical retry. Any change to the URL (other than query order
    // or a fragment), method or body is a different key and passes.
    assertNotRepeat(request) {
      const earlier = timedOut.get(downloadRequestKey(request));
      if (!earlier || earlier.count < DOWNLOAD_TIMEOUTS_ALLOWED) return;
      const host = hostOf(request?.url) ?? "unknown host";
      throw structured(
        "DOWNLOAD_TIMEOUT_REPEAT",
        `this exact request to ${host} timed out ${earlier.count} times (the last after ${seconds(earlier.elapsedMs)} s), so it is refused for the rest of this run and was not sent again; the count starts over with the next CLI run.`,
        { host, elapsed_seconds: Number(seconds(earlier.elapsedMs)) },
      );
    },
    // Called when the tool's own timer fired. Returns the error to throw: the
    // structured DOWNLOAD_TIMEOUT when the failure is the abort surfacing, and
    // the original error otherwise. SOURCE_ACCESS_BLOCKED is a stop instruction
    // and passes through unchanged.
    recordTimeout(request, elapsedMs, error) {
      if (!downloadAbortSurfaced(error) || /^SOURCE_ACCESS_BLOCKED:/.test(String(error?.message ?? ""))) return error;
      const key = downloadRequestKey(request);
      timedOut.set(key, { count: (timedOut.get(key)?.count ?? 0) + 1, elapsedMs });
      const host = hostOf(request?.url) ?? "unknown host";
      return structured(
        "DOWNLOAD_TIMEOUT",
        `${host} did not finish the download in ${seconds(elapsedMs)} s (limit ${limitSeconds} s).`,
        { host, elapsed_seconds: Number(seconds(elapsedMs)) },
      );
    },
  };
}

// K315: report-only record of tools reaching this module's exports (key evidence_gate.mjs::name). test_k315_export_wrap pins this list.
{
  assertComputationBoundToSources = trackExport("evidence_gate.mjs::assertComputationBoundToSources", assertComputationBoundToSources);
  assertDatasetPayload = trackExport("evidence_gate.mjs::assertDatasetPayload", assertDatasetPayload);
  assertEvidenceBackedStatus = trackExport("evidence_gate.mjs::assertEvidenceBackedStatus", assertEvidenceBackedStatus);
  assertInlineRowsHaveEvidence = trackExport("evidence_gate.mjs::assertInlineRowsHaveEvidence", assertInlineRowsHaveEvidence);
  assertUsableSourceRecord = trackExport("evidence_gate.mjs::assertUsableSourceRecord", assertUsableSourceRecord);
  deriveClaimVerification = trackExport("evidence_gate.mjs::deriveClaimVerification", deriveClaimVerification);
  evaluateClaimSupport = trackExport("evidence_gate.mjs::evaluateClaimSupport", evaluateClaimSupport);
  isSystemVerifiedClaim = trackExport("evidence_gate.mjs::isSystemVerifiedClaim", isSystemVerifiedClaim);
  requireVerifiedClaim = trackExport("evidence_gate.mjs::requireVerifiedClaim", requireVerifiedClaim);
}
