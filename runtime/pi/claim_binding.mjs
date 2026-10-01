// Does a verified claim really belong to the chart it is hung on?
//
// `record_claim` proves a claim against ITS OWN computation. A chart (or an
// annotation on it) only ever named a claim_id, so any verified claim could be
// hung on any chart, and a chart whose SQL was a pure literal table could carry
// one too. This module is the single decision both lints use (newsroom_viz_lint
// and newsroom_infographic_lint), kept pure and dependency-injected so a later
// stage can reuse it unchanged.
//
// The rule, over what each SQL statement really reads (never over the
// content-addressed computation path: that path hashes the whole data/ and
// sources/ directory snapshot, so it drifts as soon as any other file is
// added after the claim was recorded):
//   (a) the chart's own computation is source_bound; a chart built from
//       literals, or from something that cannot be resolved, can never carry a
//       verified claim;
//   (b) at least one of the claim's source_bound computations reads a data/ or
//       sources/ file the chart's computation also reads. Reads are the
//       transitive `effective` inputs, so a chart chained on a stored
//       computation still lines up with a claim recorded from the raw file.
// A chart that is a subset or a pivot of the claim's computation reads the same
// file and passes; several charts sharing one computation pass.
//
// Strict row-set equality (result_hash) is deliberately NOT part of the
// decision: it rejects legitimate subsets and pivots. It is reported through
// `strictResultHashMatches` for the shadow record only.
import { INPUT_BINDING_SOURCE_BOUND, recordedInputState } from "./computation_rows.mjs";

export const CLAIM_BINDING_OK = "ok";
export const CLAIM_BINDING_CHART_NOT_SOURCE_BOUND = "chart_not_source_bound";
export const CLAIM_BINDING_CLAIM_HAS_NO_COMPUTATION = "claim_has_no_computation";
export const CLAIM_BINDING_CLAIM_NOT_SOURCE_BOUND = "claim_computation_not_source_bound";
export const CLAIM_BINDING_NO_SHARED_INPUT = "no_shared_input";

const isEvidencePath = (value) => typeof value === "string" && (value.startsWith("data/") || value.startsWith("sources/"));
const evidencePaths = (values) => [...new Set((Array.isArray(values) ? values : []).filter(isEvidencePath))].sort();

// data/<64 hex>.csv style names are unreadable in a lint message; keep enough
// of the name to tell files apart.
function shortPath(path) {
  const text = String(path);
  if (text.length <= 34) return text;
  const slash = text.lastIndexOf("/");
  const base = text.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${text.slice(0, slash + 1)}${stem.slice(0, 10)}...${ext}`;
}

function listPaths(paths, limit = 3) {
  if (!paths.length) return "nothing";
  const shown = paths.slice(0, limit).map(shortPath).join(", ");
  return paths.length > limit ? `${shown}, +${paths.length - limit} more` : shown;
}

/**
 * chart:             { input_binding, effective_inputs }  the chart's own computation
 * claimComputations: [{ ref, input_binding, effective_inputs }]  the claim's computations
 * Returns { ok, code, message, shared_inputs, chart_inputs, claim_inputs }.
 */
export function claimBindsComputation(chart, claimComputations) {
  const chartInputs = evidencePaths(chart?.effective_inputs);
  const computations = Array.isArray(claimComputations) ? claimComputations : [];
  const claimInputs = evidencePaths(computations.flatMap((computation) => computation?.effective_inputs ?? []));
  const verdict = (ok, code, message, shared = []) => ({ ok, code, message, shared_inputs: shared, chart_inputs: chartInputs, claim_inputs: claimInputs });

  const chartBinding = String(chart?.input_binding ?? "missing");
  if (chartBinding !== INPUT_BINDING_SOURCE_BOUND || chartInputs.length === 0) {
    return verdict(false, CLAIM_BINDING_CHART_NOT_SOURCE_BOUND, `the chart's own SQL is ${chartBinding === INPUT_BINDING_SOURCE_BOUND ? "bound to no data/ or sources/ file" : chartBinding}, so it reads no resolvable data/ or sources/ evidence and cannot carry a verified claim; build the chart from the recorded data/ or sources/ files`);
  }
  if (computations.length === 0) {
    return verdict(false, CLAIM_BINDING_CLAIM_HAS_NO_COMPUTATION, "the claim records no computation to bind the chart against");
  }
  const usable = computations.filter((computation) => computation?.input_binding === INPUT_BINDING_SOURCE_BOUND);
  if (usable.length === 0) {
    return verdict(false, CLAIM_BINDING_CLAIM_NOT_SOURCE_BOUND, "none of the claim's computations is source_bound, so the claim has no evidence input to compare the chart with");
  }
  const chartSet = new Set(chartInputs);
  const shared = evidencePaths(usable.flatMap((computation) => evidencePaths(computation.effective_inputs).filter((path) => chartSet.has(path))));
  if (shared.length === 0) {
    return verdict(false, CLAIM_BINDING_NO_SHARED_INPUT, `none of the claim's computations reads a data/ or sources/ file that this chart's SQL reads (chart reads ${listPaths(chartInputs)}; claim reads ${listPaths(evidencePaths(usable.flatMap((computation) => computation.effective_inputs ?? [])))}); hang the chart on a claim recorded from the same data, or record a claim from this chart's data`);
  }
  return verdict(true, CLAIM_BINDING_OK, "", shared);
}

/**
 * Shadow-only: does any of the claim's computations produce exactly the chart's
 * row set (same canonical result_hash)? Never a lint input.
 */
export function strictResultHashMatches(chartResultHash, claimComputations) {
  const hash = String(chartResultHash ?? "");
  if (!hash) return { equal: false, refs: [] };
  const refs = (Array.isArray(claimComputations) ? claimComputations : [])
    .filter((computation) => String(computation?.result_hash ?? "") === hash)
    .map((computation) => String(computation.ref ?? ""));
  return { equal: refs.length > 0, refs };
}

/**
 * State of one stored computation record: its binding and its transitive
 * data/ and sources/ reads. `readComputation(ref)` returns the stored record
 * (and may throw); a missing, unreadable or legacy record has binding
 * "legacy" and reads nothing, so it never binds anything.
 */
export async function computationInputState(ref, { readComputation, root }) {
  let record = null;
  try { record = await readComputation(String(ref)); } catch { record = null; }
  const state = await recordedInputState(record, readComputation, 0, new Set(), { root });
  return {
    ref: String(ref),
    input_binding: state.binding,
    effective_inputs: state.effective,
    result_hash: typeof record?.result_hash === "string" ? record.result_hash : "",
  };
}

/** States of every computation a claim record cites, in cited order. */
export async function claimComputationStates(claim, deps) {
  const states = [];
  for (const ref of Array.isArray(claim?.computation_refs) ? claim.computation_refs : []) {
    states.push(await computationInputState(ref, deps));
  }
  return states;
}

/**
 * Verdict per claim id for one chart. `claimRecords` is a Map of the system
 * verified claim records; an id with no record is left out, so the existing
 * "not a verified recorded claim" blocker stays the only message for it.
 */
export async function bindClaimsToChart(chartState, claimIds, claimRecords, deps) {
  const verdicts = {};
  for (const claimId of [...new Set((claimIds ?? []).map(String).filter(Boolean))]) {
    const claim = claimRecords?.get?.(claimId);
    if (!claim) continue;
    verdicts[claimId] = claimBindsComputation(chartState, await claimComputationStates(claim, deps));
  }
  return verdicts;
}
