// K99 stage 1: a report-only planner for splitting one slow download into smaller requests.
// It sends nothing. A diagnostic says how a request COULD be split and what the family budget would be; the real
// download_data path is unchanged. Everything here is pure: the single-request function and the clock are injected,
// so the plan, the budgets and the timing can be replayed offline with a virtual clock.
// Switch NEWSROOM_FETCH_SPLIT_PROBE opens only on exactly "1".

export const FETCH_SPLIT_PROBE_VERSION = 1;

export function fetchSplitProbeEnabled(env = process.env) {
  return env?.NEWSROOM_FETCH_SPLIT_PROBE === "1";
}

// One budget for the whole family, keyed to the parent request. Child keys never get their own allowance.
export const FAMILY_LIMITS = Object.freeze({
  childTimeoutMs: 30_000,
  maxSeriesPerChunk: 4, // a house guess (a 4-series ECB piece took about 11-13 s), not an official API limit
  maxChunks: 6, // depth 1 does not bound many series, so the family has a total-piece cap
  maxSends: 6, // sends in the family; there is no retry inside the family
  concurrency: 1, // SDMX and the unlisted API types: serial
  maxFamilyBytes: 25_000_000, // the per-download 25 MB cap, applied to the parent total
  parentDeadlineMs: 150_000,
});

// The failure types a split record keeps apart. Stop-type failures are never flattened into retryable ones.
export const FAILURE_TYPES = Object.freeze(["timeout", "http", "body", "no_http", "cancelled", "circuit_blocked", "too_large", "budget"]);

function parseUrl(text) {
  try { return new URL(String(text)); } catch { return null; }
}

// Only known key grammars are split; every other URL goes the old path (kind "none").
export function classifyRequest(urlText) {
  const url = parseUrl(urlText);
  if (!url || !/^https?:$/.test(url.protocol)) return { kind: "none", reason: "not_http" };
  const host = url.hostname.toLowerCase();
  const sdmx = url.pathname.match(/^(.*\/data\/[^/]+\/)([^/]+)$/);
  if (sdmx && /^[^/]+$/.test(sdmx[2])) {
    const dims = sdmx[2].split(".");
    const listIndexes = dims.map((value, index) => (value.includes("+") ? index : -1)).filter((index) => index >= 0);
    if (listIndexes.length === 1) {
      const index = listIndexes[0];
      return { kind: "sdmx_key", host, prefix: sdmx[1], dims, index, series: dims[index].split("+").filter(Boolean) };
    }
    if (listIndexes.length > 1) return { kind: "none", reason: "several_series_lists", host };
  }
  const date = url.searchParams.get("date");
  const range = date?.match(/^(\d{4}):(\d{4})$/);
  if (/\/country\/[^/]+\/indicator\/[^/]+$/.test(url.pathname) && range && Number(range[1]) < Number(range[2])) {
    return { kind: "wb_date_range", host, from: Number(range[1]), to: Number(range[2]) };
  }
  return { kind: "none", reason: "unknown_grammar", host };
}

function intervalOf(info, chunk) {
  if (info.kind === "sdmx_key") return `series ${chunk.join("+")}`;
  return `${chunk[0]}:${chunk[1]}`;
}

function withQuery(url, edit) {
  const copy = new URL(url.toString());
  edit(copy);
  return copy.toString();
}

// Depth 1 only. SDMX: series groups of at most maxSeriesPerChunk, parent order, never above maxChunks (the
// remainder is reported as uncovered, not silently dropped). World Bank: the year range cut in two at the midpoint.
export function planSplit(urlText, limits = FAMILY_LIMITS) {
  const info = classifyRequest(urlText);
  const url = parseUrl(urlText);
  const base = { version: FETCH_SPLIT_PROBE_VERSION, kind: info.kind, host: info.host ?? url?.hostname?.toLowerCase() ?? null, path: url?.pathname ?? null, chunks: [], uncovered: [], capped: false };
  if (info.kind === "none") return { ...base, splittable: false, reason: info.reason };
  let groups;
  if (info.kind === "sdmx_key") {
    if (info.series.length <= limits.maxSeriesPerChunk) return { ...base, splittable: false, reason: "already_small", series_count: info.series.length };
    groups = [];
    for (let i = 0; i < info.series.length; i += limits.maxSeriesPerChunk) groups.push(info.series.slice(i, i + limits.maxSeriesPerChunk));
  } else {
    const mid = info.from + Math.floor((info.to - info.from + 1) / 2) - 1;
    groups = [[info.from, mid], [mid + 1, info.to]];
  }
  const kept = groups.slice(0, limits.maxChunks);
  const dropped = groups.slice(limits.maxChunks);
  const chunks = kept.map((group) => ({
    interval: intervalOf(info, group),
    url: info.kind === "sdmx_key"
      ? withQuery(url, (u) => { const dims = info.dims.slice(); dims[info.index] = group.join("+"); u.pathname = info.prefix + dims.join("."); })
      : withQuery(url, (u) => { u.search = u.search.replace(/([?&]date=)[^&]*/, `$1${group[0]}:${group[1]}`); }),
  }));
  return {
    ...base,
    splittable: true,
    ...(info.kind === "sdmx_key" ? { series_count: info.series.length } : { year_from: info.from, year_to: info.to }),
    chunks,
    uncovered: dropped.map((group) => intervalOf(info, group)),
    capped: dropped.length > 0,
  };
}

// A virtual clock: nothing waits. fetchOnce advances it by the time the request would have taken.
export function createVirtualClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += Math.max(0, Number(ms) || 0); return now; } };
}

// fetchOnce(url, { timeoutMs, signal }) -> { ok, bytes, ms, failure? }  (failure is one of FAILURE_TYPES).
// The runner is serial and sends no retry. It stops on: a user cancel (kept apart from a timeout), a blocked host
// (the circuit is read, never reset or routed round), the family byte/send/deadline budget.
export async function runSplitPlan({ plan, fetchOnce, clock = createVirtualClock(), signal, isBlocked = () => false, limits = FAMILY_LIMITS }) {
  const started = clock.now();
  const results = [];
  let bytes = 0;
  let sends = 0;
  let stoppedBy = null;
  for (const chunk of plan.chunks ?? []) {
    if (signal?.aborted) { stoppedBy = "cancelled"; break; }
    if (isBlocked(plan.host)) { stoppedBy = "circuit_blocked"; break; }
    if (sends >= limits.maxSends) { stoppedBy = "budget"; break; }
    if (clock.now() - started >= limits.parentDeadlineMs) { stoppedBy = "budget"; break; }
    sends += 1;
    const before = clock.now();
    const outcome = await fetchOnce(chunk.url, { timeoutMs: limits.childTimeoutMs, signal });
    const seconds = Math.round((clock.now() - before) / 10) / 100;
    bytes += outcome?.ok ? Number(outcome.bytes) || 0 : 0;
    // A cancel raised while the request ran is a cancel, never a timeout, whatever the outcome says.
    const failure = outcome?.ok ? null : signal?.aborted ? "cancelled" : (FAILURE_TYPES.includes(outcome?.failure) ? outcome.failure : "no_http");
    results.push({ interval: chunk.interval, ok: !failure, ...(failure ? { failure } : {}), bytes: outcome?.ok ? Number(outcome.bytes) || 0 : 0, seconds });
    if (failure === "cancelled") { stoppedBy = "cancelled"; break; }
    if (failure === "circuit_blocked") { stoppedBy = "circuit_blocked"; break; }
    if (bytes > limits.maxFamilyBytes) { stoppedBy = "too_large"; break; }
  }
  return { sends, bytes, seconds: Math.round((clock.now() - started) / 10) / 100, stopped_by: stoppedBy, results };
}

// The diagnostic line for a request: type, URL path, interval, chunk count, time. Nothing else: no query string,
// no headers, no upstream error text.
export function diagnosticRecord({ plan, mode, parentSeconds, parentOutcome, run = null }) {
  return {
    schema_version: "0.1.0",
    probe_version: FETCH_SPLIT_PROBE_VERSION,
    kind: plan.kind,
    host: plan.host,
    url_path: plan.path,
    splittable: plan.splittable,
    ...(plan.reason ? { reason: plan.reason } : {}),
    chunk_count: plan.chunks.length,
    intervals: plan.chunks.map((chunk) => chunk.interval),
    ...(plan.uncovered.length ? { uncovered: plan.uncovered } : {}),
    capped: plan.capped,
    parent: { outcome: parentOutcome, seconds: parentSeconds },
    mode,
    family_budget: { child_timeout_s: FAMILY_LIMITS.childTimeoutMs / 1000, max_chunks: FAMILY_LIMITS.maxChunks, max_sends: FAMILY_LIMITS.maxSends, concurrency: FAMILY_LIMITS.concurrency },
    ...(run ? { replay: { sends: run.sends, seconds: run.seconds, stopped_by: run.stopped_by, results: run.results.map(({ interval, ok, failure, seconds }) => ({ interval, ok, ...(failure ? { failure } : {}), seconds })) } } : {}),
  };
}

// The family timeline under the serial rule. "after_timeout": the parent runs to its own timeout first, then the
// pieces one after another. "before_request": the pieces only. Both from the recorded piece times, so it is replay.
export function familyTimeline({ parentSeconds, pieceSeconds, mode }) {
  const pieces = pieceSeconds.reduce((sum, value) => sum + value, 0);
  const total = (mode === "after_timeout" ? parentSeconds : 0) + pieces;
  return Math.round(total * 100) / 100;
}

// The failure type of a recorded outcome, from the tool's own classification (no upstream text is read here).
export function failureTypeOf({ timedOut = false, cancelled = false, blocked = false, httpStatus = null, bodyPhase = false, tooLarge = false } = {}) {
  if (cancelled) return "cancelled";
  if (blocked) return "circuit_blocked";
  if (timedOut) return "timeout";
  if (tooLarge) return "too_large";
  if (httpStatus) return "http";
  return bodyPhase ? "body" : "no_http";
}
