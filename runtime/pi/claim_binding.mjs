// Does a verified claim really belong to the chart it is hung on?
//
// `record_claim` proves a claim against ITS OWN computation. A chart (or an
// annotation on it) only ever named a claim_id, so any verified claim could be
// hung on any chart, and a chart whose SQL was a pure literal table could carry
// one too. This module is the single decision both lints use (newsroom_viz_lint
// and newsroom_infographic_lint), kept pure and dependency-injected.
//
// Sharing an input FILE is necessary but never sufficient: a chart may read the
// claim's file and chart another column, or read an unrelated file and bridge to
// the claim's file with a one-row join. A claim binds to a chart only when its
// numbers provably come out of the chart's own computation:
//   (a) the chart's own computation is source_bound (reads a data/ or sources/
//       file; literals and unresolved reads can never carry a verified claim);
//   (b) one of the claim's source_bound computations reads a data/ or sources/
//       file the chart also reads, with the same content hash on both sides
//       (hashes come from the records' own input fingerprints; the
//       content-addressed computation PATH is never compared, because it hashes
//       the whole evidence snapshot and drifts when any other file is added);
//   (c) and one relation holds between that computation and the chart:
//       same_sql      the two statements are the same after comments,
//                     whitespace, case and a trailing ';' are normalized;
//       values_in_rows every chart column exists in the claim's result under the
//                     same name and every chart row, taken on those columns,
//                     is a row of the claim's result (a subset, projection or
//                     reordering of the claim's own numbers);
//       reads_claim_computation  the chart is a plain SELECT (WHERE / GROUP BY /
//                     ORDER BY / LIMIT) over the claim's stored computation and
//                     nothing else, whose numeric encoding columns are root
//                     columns or COUNT/SUM/AVG/MIN/MAX of them (see
//                     chartRootedInComputation); merely reading it somewhere in
//                     the SQL proves nothing.
// Anything else fails closed: record the claim from the chart's own computation. Strict
// row-set equality (result_hash) is not a lint input; it is reported through
// `strictResultHashMatches` for the shadow record only.
import { evidenceRefFromFingerprint } from "./evidence_gate.mjs";
import { INPUT_BINDING_SOURCE_BOUND, recordedInputState } from "./computation_rows.mjs";

export const CLAIM_BINDING_OK = "ok";
export const CLAIM_BINDING_CHART_NOT_SOURCE_BOUND = "chart_not_source_bound";
export const CLAIM_BINDING_CLAIM_HAS_NO_COMPUTATION = "claim_has_no_computation";
export const CLAIM_BINDING_CLAIM_NOT_SOURCE_BOUND = "claim_computation_not_source_bound";
export const CLAIM_BINDING_NO_SHARED_INPUT = "no_shared_input";
export const CLAIM_BINDING_NO_RELATION = "no_computation_relation";
export const MAX_COMPARED_ROWS = 100000;

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
 * SQL text with comments, whitespace, keyword case and a trailing ';' removed.
 * Only text OUTSIDE quotes is normalized: string literals and quoted
 * identifiers are carried through byte for byte (so 'a - b' and 'a-b' stay
 * different statements).
 */
export function normalizeSql(sql) {
  const text = String(sql ?? "");
  const quoted = [];
  let out = "";
  let i = 0;
  const pushSpace = () => { if (out && !out.endsWith(" ")) out += " "; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "-" && text[i + 1] === "-") { while (i < text.length && text[i] !== "\n") i += 1; pushSpace(); continue; }
    if (ch === "/" && text[i + 1] === "*") { const close = text.indexOf("*/", i + 2); i = close < 0 ? text.length : close + 2; pushSpace(); continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) { if (text[j] === ch) { if (text[j + 1] === ch) { j += 2; continue; } break; } j += 1; }
      quoted.push(text.slice(i, j + 1));
      out += `\u0000${quoted.length - 1}\u0000`;
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) { pushSpace(); i += 1; continue; }
    out += ch.toLowerCase();
    i += 1;
  }
  const squeezed = out.trim().replace(/[;\s]+$/, "").replace(/\s*([(),=<>+\-*\/])\s*/g, "$1");
  return squeezed.replace(/\u0000(\d+)\u0000/g, (_, index) => quoted[Number(index)]);
}

function cellKey(value) {
  if (value === null || value === undefined) return "z:";
  if (typeof value === "number" || typeof value === "bigint") return `n:${Number(value)}`;
  if (typeof value === "boolean") return `b:${value}`;
  if (typeof value === "string") return /^-?\d+(\.\d+)?$/.test(value.trim()) ? `n:${Number(value)}` : `s:${value}`;
  return `j:${JSON.stringify(value)}`;
}

/**
 * values_in_rows relation: every chart column is a column of the claim's
 * result (same name) and every chart row, taken on those columns, is a row of
 * the claim's result. Returns {ok, reason}.
 */
export function chartValuesInRows(chartRows, claimRows) {
  if (!Array.isArray(chartRows) || !Array.isArray(claimRows) || chartRows.length === 0 || claimRows.length === 0) return { ok: false, reason: "a result has no rows to compare" };
  if (chartRows.length > MAX_COMPARED_ROWS || claimRows.length > MAX_COMPARED_ROWS) return { ok: false, reason: "result too large to compare" };
  const chartColumns = Object.keys(chartRows[0] ?? {});
  const claimColumns = new Set(Object.keys(claimRows[0] ?? {}));
  if (chartColumns.length === 0) return { ok: false, reason: "the chart result has no columns" };
  const missing = chartColumns.filter((column) => !claimColumns.has(column));
  if (missing.length) return { ok: false, reason: `chart column(s) ${missing.slice(0, 3).map((name) => `'${name}'`).join(", ")} are not in the claim's result` };
  // Multiset containment: a row may appear in the chart no more often than it
  // does in the claim's result (a JOIN that duplicates rows is not a subset).
  const tupleKey = (row) => chartColumns.map((column) => cellKey(row?.[column])).join("\u0001");
  const available = new Map();
  for (const row of claimRows) { const key = tupleKey(row); available.set(key, (available.get(key) ?? 0) + 1); }
  for (const row of chartRows) {
    const key = tupleKey(row);
    const left = available.get(key) ?? 0;
    if (left === 0) return { ok: false, reason: (available.has(key) ? "a chart row appears more often than in the claim's result" : "a chart row is not a row of the claim's result") };
    available.set(key, left - 1);
  }
  return { ok: true, reason: "" };
}

function hashMap(state) {
  const map = new Map();
  for (const fingerprint of Array.isArray(state?.fingerprints) ? state.fingerprints : []) {
    const text = String(fingerprint ?? "");
    const path = evidenceRefFromFingerprint(text);
    const hash = text.slice(text.lastIndexOf(":") + 1);
    if (path && /^[0-9a-f]{64}$/.test(hash)) map.set(path, hash);
  }
  for (const input of Array.isArray(state?.read_inputs) ? state.read_inputs : []) {
    if (isEvidencePath(input?.path) && /^[0-9a-f]{64}$/.test(String(input?.sha256 ?? ""))) map.set(input.path, input.sha256);
  }
  return map;
}

const COMPUTATION_REF_PATTERN = /^computations\/[0-9a-f]{64}\.json$/;
const ROOT_READERS = new Set(["read_json", "read_json_auto"]);
const NUMERIC_AGGREGATES = new Set(["count_star", "count", "sum", "avg", "min", "max"]);
// Encoding fields whose values are drawn as numbers. A label, category or
// series column may be any expression; these may only be the root table's own
// numbers (or a plain aggregate of them).
const NUMERIC_FIELD_KEYS = ["value_field", "start_field", "end_field", "y_field", "size_field", "altitude_field", "speed_field", "source_lat_field", "source_lon_field", "target_lat_field", "target_lon_field"];

/** The spec's numeric encoding fields (x_field only for a scatter, where it is a measure). */
export function numericFieldsOfSpec(spec) {
  const fields = NUMERIC_FIELD_KEYS.map((key) => spec?.[key]).filter((value) => typeof value === "string" && value);
  if (spec?.chart_type === "scatter" && typeof spec?.x_field === "string" && spec.x_field) fields.push(spec.x_field);
  return [...new Set(fields)];
}

function anyNode(node, test) {
  if (Array.isArray(node)) return node.some((item) => anyNode(item, test));
  if (!node || typeof node !== "object") return false;
  if (test(node)) return true;
  return Object.values(node).some((value) => anyNode(value, test));
}

/**
 * reads_claim_computation, proven and not merely observed. The chart's whole
 * read set must be exactly the one claim computation, and the statement must
 * be a plain SELECT over that table: WHERE / GROUP BY / ORDER BY / LIMIT only
 * (no CTE, JOIN, UNION, subquery, window, HAVING, DISTINCT, SAMPLE). Every
 * output column drawn as a number must be a column of the root table or
 * COUNT(*) / COUNT / SUM / AVG / MIN / MAX of such columns; no literal, no
 * arithmetic, no other function. Anything unparsed or doubtful fails closed.
 * Returns {ok, reason}.
 */
export function chartRootedInComputation(chart, computation) {
  const no = (reason) => ({ ok: false, reason });
  const ref = String(computation?.ref ?? "");
  if (!COMPUTATION_REF_PATTERN.test(ref)) return no("the claim's computation has no canonical computations/<hash>.json path");
  const reads = (Array.isArray(chart?.read_inputs) ? chart.read_inputs : []).map((input) => String(input?.path ?? ""));
  if (reads.length !== 1 || reads[0] !== ref) return no("the chart also reads files other than the claim's computation");
  const numericFields = chart?.numeric_fields;
  if (!Array.isArray(numericFields)) return no("the chart's numeric fields are unknown");
  const ast = chart?.ast;
  const statements = ast && ast.error === false ? ast.statements : null;
  if (!Array.isArray(statements) || statements.length !== 1) return no("the chart SQL could not be parsed");
  const node = statements[0]?.node;
  if (node?.type !== "SELECT_NODE") return no("the chart SQL is not a plain SELECT");
  if (Array.isArray(node.cte_map?.map) && node.cte_map.map.length) return no("the chart SQL uses a CTE");
  for (const key of ["having", "qualify", "sample"]) if (node[key]) return no(`the chart SQL uses ${key.toUpperCase()}`);
  if (node.aggregate_handling && !["STANDARD_HANDLING", "FORCE_AGGREGATES"].includes(node.aggregate_handling)) return no("the chart SQL groups in an unsupported way");
  for (const modifier of Array.isArray(node.modifiers) ? node.modifiers : []) {
    if (modifier?.type !== "ORDER_MODIFIER" && modifier?.type !== "LIMIT_MODIFIER") return no("the chart SQL uses a modifier other than ORDER BY / LIMIT");
  }
  if (anyNode(ast, (item) => item.class === "SUBQUERY" || item.class === "WINDOW" || item.class === "LAMBDA" || item.type === "SUBQUERY")) return no("the chart SQL uses a subquery, window or lambda");
  const from = node.from_table;
  const fn = from?.function;
  if (from?.type !== "TABLE_FUNCTION" || !ROOT_READERS.has(String(fn?.function_name ?? "").toLowerCase())) return no("the chart does not select directly from the claim's computation");
  const args = Array.isArray(fn.children) ? fn.children : [];
  if (args.length !== 1 || args[0]?.class !== "CONSTANT" || args[0]?.value?.value !== ref) return no("the chart's table is not the claim's computation");

  const rootColumns = new Set(Object.keys(computation?.rows?.[0] ?? {}));
  const chartColumns = Object.keys(chart?.rows?.[0] ?? {});
  const select = Array.isArray(node.select_list) ? node.select_list : [];
  if (select.some((expr) => expr?.class === "STAR")) return no("the chart SQL selects * from the claim's computation");
  if (rootColumns.size === 0 || select.length === 0 || select.length !== chartColumns.length) return no("the chart's output columns cannot be matched to its SELECT list");
  const alias = from.alias ? String(from.alias) : "";
  const isRootColumn = (expr) => {
    if (expr?.class !== "COLUMN_REF" || !Array.isArray(expr.column_names)) return false;
    const names = expr.column_names.map(String);
    if (names.length === 2 && names[0] !== alias) return false;
    if (names.length > 2) return false;
    return rootColumns.has(names[names.length - 1]);
  };
  const plainAggregate = (expr) => {
    if (expr?.class !== "FUNCTION") return false;
    const name = String(expr.function_name ?? "").toLowerCase();
    if (!NUMERIC_AGGREGATES.has(name) || expr.filter || (Array.isArray(expr.order_bys?.orders) && expr.order_bys.orders.length)) return false;
    const children = Array.isArray(expr.children) ? expr.children : [];
    return name === "count_star" ? children.length === 0 : children.length === 1 && isRootColumn(children[0]);
  };
  const numeric = new Set(numericFields.map(String));
  for (let index = 0; index < select.length; index += 1) {
    const expr = select[index];
    if (expr?.class === "STAR") return no("the chart SQL selects * from the claim's computation");
    const outName = chartColumns[index];
    if (expr?.alias && String(expr.alias) !== outName) return no("the chart's output columns cannot be matched to its SELECT list");
    if (!numeric.has(outName)) continue;
    if (!isRootColumn(expr) && !plainAggregate(expr)) return no(`numeric field '${outName}' is not a column of the claim's computation or a plain COUNT/SUM/AVG/MIN/MAX of one`);
  }
  return { ok: true, reason: "" };
}

/**
 * chart:             { input_binding, effective_inputs, sql, rows, fingerprints, read_inputs }
 * claimComputations: [{ ref, input_binding, effective_inputs, sql, rows, fingerprints, read_inputs }]
 * Returns { ok, code, message, relation, shared_inputs, chart_inputs, claim_inputs }.
 */
export function claimBindsComputation(chart, claimComputations) {
  const chartInputs = evidencePaths(chart?.effective_inputs);
  const computations = Array.isArray(claimComputations) ? claimComputations : [];
  const claimInputs = evidencePaths(computations.flatMap((computation) => computation?.effective_inputs ?? []));
  const verdict = (ok, code, message, shared = [], relation = "") => ({ ok, code, message, relation, shared_inputs: shared, chart_inputs: chartInputs, claim_inputs: claimInputs });

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
  const chartHashes = hashMap(chart);
  const chartReads = new Set((Array.isArray(chart?.read_inputs) ? chart.read_inputs : []).map((input) => String(input?.path ?? "")));
  const chartSql = normalizeSql(chart?.sql);
  const allShared = [];
  const reasons = [];
  let hintRef = "";
  for (const computation of usable) {
    const claimHashes = hashMap(computation);
    const shared = evidencePaths(computation.effective_inputs).filter((path) => {
      if (!chartSet.has(path)) return false;
      const a = chartHashes.get(path);
      const b = claimHashes.get(path);
      return !(a && b && a !== b);
    });
    if (shared.length === 0) continue;
    allShared.push(...shared);
    if (!hintRef && COMPUTATION_REF_PATTERN.test(String(computation.ref ?? ""))) hintRef = String(computation.ref);
    if (computation.ref && chartReads.has(String(computation.ref))) {
      const rooted = chartRootedInComputation(chart, computation);
      if (rooted.ok) return verdict(true, CLAIM_BINDING_OK, "", shared, "reads_claim_computation");
      reasons.push(`it reads the claim's computation but ${rooted.reason}`);
    }
    if (chartSql && chartSql === normalizeSql(computation.sql)) return verdict(true, CLAIM_BINDING_OK, "", shared, "same_sql");
    const contained = chartValuesInRows(chart?.rows, computation.rows);
    if (contained.ok) return verdict(true, CLAIM_BINDING_OK, "", shared, "values_in_rows");
    reasons.push(contained.reason);
  }
  if (allShared.length === 0) {
    return verdict(false, CLAIM_BINDING_NO_SHARED_INPUT, `none of the claim's computations reads a data/ or sources/ file that this chart's SQL reads (chart reads ${listPaths(chartInputs)}; claim reads ${listPaths(evidencePaths(usable.flatMap((computation) => computation.effective_inputs ?? [])))}); hang the chart on a claim recorded from the same data, or record a claim from this chart's data`);
  }
  return verdict(false, CLAIM_BINDING_NO_RELATION, `the chart reads the same data as the claim's computation (${listPaths([...new Set(allShared)])}) but its numbers are not shown to come from that computation: the SQL differs and ${reasons[0] ?? "its rows are not drawn from the claim's rows"}; make the chart read the claim's stored computation directly (FROM read_json('${hintRef || "computations/<claim computation>.json"}'), then aggregate or alias there); otherwise run duckdb_query for exactly the rows this chart shows and record the claim from that result`, [...new Set(allShared)]);
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
    sql: typeof record?.sql === "string" ? record.sql : "",
    rows: Array.isArray(record?.rows) ? record.rows : [],
    fingerprints: Array.isArray(record?.input_fingerprints) ? record.input_fingerprints : [],
    read_inputs: Array.isArray(record?.read_inputs) ? record.read_inputs : [],
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
export async function bindClaimsToChart(chartInput, claimIds, claimRecords, deps) {
  const verdicts = {};
  let chartState = chartInput;
  if (chartState && chartState.ast === undefined && chartState.sql && typeof deps?.serializeSql === "function") {
    let ast = null;
    try { ast = await deps.serializeSql(chartState.sql); } catch { ast = null; }
    chartState = { ...chartState, ast };
  }
  for (const claimId of [...new Set((claimIds ?? []).map(String).filter(Boolean))]) {
    const claim = claimRecords?.get?.(claimId);
    if (!claim) continue;
    verdicts[claimId] = claimBindsComputation(chartState, await claimComputationStates(claim, deps));
  }
  return verdicts;
}
