// Shadow check A: "as-of leaks" in subject-set SQL.
//
// A page declares subject_set { computation_ref, key_field, cutoff_date }. The
// set is whatever the declared SQL returned. If that SQL filters on an END
// date column (WHERE end_date IS NULL) it silently drops subjects that were
// valid at the cutoff and only ended afterwards: the set describes today, not
// the cutoff. The counterfactual probe asks the source files directly: which
// keys were valid at the cutoff (start <= C and end > C), and are they all in
// the set the page uses?
//
// Contract (shadow only, see shadow.mjs):
// - pure: every read (DESCRIBE, the probe SELECTs, the SQL AST) is injected, so
//   the module needs no DuckDB to be tested;
// - the reference date R comes ONLY from the data (a snapshot/as-of column in
//   the file) or the source registry; with none, no R condition is added. The
//   wall clock is never read, so replaying a run gives the same answer;
// - the probe reads source files only and creates no computation artifacts;
// - output is deterministic: no timestamps in the result.
// It also records coverage: which module types the page's cutoff check never
// looks at, counted by type.

const WORDS = {
  start: ["start", "begin", "join", "enter", "accession", "from", "valid_from", "effective", "since", "open", "加入", "开始", "生效"],
  end: ["end", "exit", "leave", "left", "quit", "withdraw", "terminat", "expire", "expiry", "close", "dissolv", "until", "thru", "valid_to", "to_date", "depart", "退出", "终止", "结束", "离开", "失效", "截止"],
  snapshot: ["snapshot", "as_of", "asof", "updated", "retrieved", "version_date", "快照", "更新"],
};
export const ASOF_WORDS = WORDS;
// Source-registry fields (data/origins/*.json) that carry a retrieval date.
export const REGISTRY_DATE_FIELDS = ["retrieved_at", "fetched_at", "downloaded_at", "as_of", "snapshot_date", "last_modified"];

const tokens = (name) => String(name).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export function columnHasWord(name, kind) {
  const lower = String(name).toLowerCase();
  const parts = tokens(name);
  return WORDS[kind].some((word) => (/^[\x00-\x7f]+$/.test(word) ? (word.includes("_") ? lower.includes(word) : parts.some((part) => part === word || (word.length >= 5 && part.startsWith(word)))) : lower.includes(word)));
}

/** Columns of a described file by role. start/end exclude each other; "from" in "valid_from" is start, "to_date" is end. */
export function classifyColumns(columns) {
  const names = (columns ?? []).map((column) => column.name);
  const end = names.filter((name) => columnHasWord(name, "end"));
  const start = names.filter((name) => columnHasWord(name, "start") && !end.includes(name));
  const snapshot = names.filter((name) => columnHasWord(name, "snapshot") && !end.includes(name) && !start.includes(name));
  return { start, end, snapshot };
}

/** 'YYYY' -> YYYY-12-31, 'YYYY-MM' -> last day of month, 'YYYY-MM-DD' as is; anything else null. */
export function normalizeCutoff(value) {
  const text = String(value ?? "").trim();
  let match = /^(\d{4})$/.exec(text);
  if (match) return `${match[1]}-12-31`;
  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match) {
    const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
    return Number(match[2]) >= 1 && Number(match[2]) <= 12 ? `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}` : null;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match && !Number.isNaN(Date.parse(`${text}T00:00:00Z`))) return text;
  return null;
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const dateOf = (column, kind) => {
  const text = `CAST(${quoteIdent(column)} AS VARCHAR)`;
  const year = kind === "start" ? "-01-01" : "-12-31";
  return `COALESCE(TRY_CAST(${text} AS DATE), TRY_CAST(CAST(TRY_CAST(${text} AS TIMESTAMP) AS VARCHAR) AS DATE), TRY_CAST(${text} || '${year}' AS DATE))`;
};
const blank = (column) => `NULLIF(trim(CAST(${quoteIdent(column)} AS VARCHAR)), '') IS NULL`;

/** SQL the probe runs. `source` is the exact reader call the set SQL used. */
export function probeSql(kind, { source, key, start, end, cutoff, reference, snapshot }) {
  const k = `trim(CAST(${quoteIdent(key)} AS VARCHAR))`;
  const s = dateOf(start, "start");
  const e = dateOf(end, "end");
  const refCondition = reference ? ` AND ${e} <= DATE '${reference}'` : "";
  switch (kind) {
    case "parse":
      return `SELECT count(*) AS total, count(${s}) AS start_ok, count(*) FILTER (WHERE NOT (${blank(start)})) AS start_present, count(${e}) AS end_ok, count(*) FILTER (WHERE NOT (${blank(end)})) AS end_present FROM ${source}`;
    case "crossers":
      return `SELECT DISTINCT ${k} AS k FROM ${source} WHERE ${s} <= DATE '${cutoff}' AND ${e} > DATE '${cutoff}'${refCondition} AND ${k} <> '' ORDER BY k LIMIT 200000`;
    case "open":
      return `SELECT DISTINCT ${k} AS k FROM ${source} WHERE ${s} <= DATE '${cutoff}' AND (${blank(end)}) AND ${k} <> '' ORDER BY k LIMIT 200000`;
    case "future":
      return `SELECT ${k} AS k FROM ${source} WHERE ${k} <> '' GROUP BY 1 HAVING min(${s}) > DATE '${cutoff}' ORDER BY k LIMIT 200000`;
    case "snapshot":
      return `SELECT CAST(max(${dateOf(snapshot, "end")}) AS VARCHAR) AS d FROM ${source}`;
    default:
      throw new Error(`unknown probe ${kind}`);
  }
}

// ---- A: does the SQL filter on an end column? ------------------------------
const FILTER_KEYS = new Set(["where_clause", "having", "qualify", "condition"]);
const COMPARES = new Set(["COMPARE_EQUAL", "COMPARE_NOTEQUAL", "COMPARE_LESSTHAN", "COMPARE_GREATERTHAN", "COMPARE_LESSTHANOREQUALTO", "COMPARE_GREATERTHANOREQUALTO", "COMPARE_DISTINCT_FROM", "COMPARE_NOT_DISTINCT_FROM"]);
function columnsIn(node, out = []) {
  if (Array.isArray(node)) { for (const item of node) columnsIn(item, out); return out; }
  if (!node || typeof node !== "object") return out;
  if (node.class === "COLUMN_REF" && Array.isArray(node.column_names)) out.push(String(node.column_names.at(-1)));
  for (const value of Object.values(node)) if (value && typeof value === "object") columnsIn(value, out);
  return out;
}
const hasConstant = (node) => {
  if (Array.isArray(node)) return node.some(hasConstant);
  if (!node || typeof node !== "object") return false;
  if (node.class === "CONSTANT") return true;
  return Object.values(node).some((value) => value && typeof value === "object" && hasConstant(value));
};

/**
 * Walks every where/having/join-condition in the AST (CTEs and subqueries
 * included). Returns { end_filters: [column], start_filters: [column],
 * windowed: boolean }: end columns compared with a constant or tested for
 * NULL; start columns filtered at all; whether date arithmetic (a rolling
 * window) is present.
 */
export function inspectFilters(ast) {
  const endFilters = new Set();
  const startFilters = new Set();
  let windowed = false;
  const visitFilter = (node) => {
    if (Array.isArray(node)) { node.forEach(visitFilter); return; }
    if (!node || typeof node !== "object") return;
    const isCompare = node.class === "COMPARISON" && COMPARES.has(node.type);
    const isNullTest = node.class === "OPERATOR" && /^OPERATOR_IS_(NOT_)?NULL$/.test(String(node.type));
    if (isCompare || isNullTest) {
      const columns = columnsIn(node);
      const constant = isNullTest || hasConstant(node);
      for (const column of columns) {
        if (columnHasWord(column, "end") && constant) endFilters.add(column);
        else if (columnHasWord(column, "start")) startFilters.add(column);
      }
    }
    if (node.class === "FUNCTION" && /^(date_add|date_sub|date_diff|datediff|date_trunc|age|year|make_interval|to_years|to_days)$/i.test(String(node.function_name))) windowed = true;
    if (node.class === "CONSTANT" && /INTERVAL/i.test(String(node.value?.type?.id ?? ""))) windowed = true;
    for (const value of Object.values(node)) if (value && typeof value === "object") visitFilter(value);
  };
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (FILTER_KEYS.has(key)) visitFilter(value);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(ast);
  return { end_filters: [...endFilters].sort(), start_filters: [...startFilters].sort(), windowed };
}

/** Reader calls in the set SQL by path: `read_csv_auto('data/x.csv', header=true)` -> that exact text. */
export function readerCalls(sql) {
  const calls = new Map();
  for (const match of String(sql ?? "").matchAll(/\b(read_[a-z_0-9]+)\s*\(\s*'([^']+)'((?:[^()']|'[^']*')*)\)/gi)) {
    if (!calls.has(match[2])) calls.set(match[2], match[0]);
  }
  return calls;
}

/**
 * The probe. Dependencies (all injected):
 *   subjectSet   { key_field, cutoff_date }
 *   members      Set of the page subject-set keys the runtime read
 *   sql          the set computation's SQL
 *   inputs       data/ + sources/ files the set computation reads (transitively)
 *   ast          json_serialize_sql output of that SQL (or null)
 *   describe(source) -> [{ name, type }]
 *   query(sql)   -> rows
 *   registryDate(path) -> 'YYYY-MM-DD' | null   (source registry, never the clock)
 */
export async function probeAsOf({ subjectSet, members, sql, inputs, ast, describe, query, registryDate }) {
  const result = { status: "skipped", reason: null, cutoff: null, reference_date: null, reference_source: "none", filters: null, files: [], classification: "skipped" };
  const cutoff = normalizeCutoff(subjectSet?.cutoff_date);
  if (!cutoff) return { ...result, reason: "cutoff_unparseable" };
  result.cutoff = cutoff;
  const filters = ast ? inspectFilters(ast) : { end_filters: [], start_filters: [], windowed: false };
  result.filters = filters;
  const calls = readerCalls(sql);
  const candidates = (inputs ?? []).filter((path) => calls.has(path));
  if (!candidates.length) return { ...result, reason: (inputs ?? []).length ? "no_direct_reader_call" : "no_source_input" };
  const key = String(subjectSet?.key_field ?? "");
  let missingTotal = 0;
  let openMissingTotal = 0;
  for (const path of candidates) {
    const file = { path, status: "skipped", reason: null };
    result.files.push(file);
    const source = calls.get(path);
    let columns;
    try { columns = await describe(source); } catch (error) { file.reason = "describe_failed"; if (error?.shadowSkip) file.skipped = error.shadowSkip; continue; }
    const roles = classifyColumns(columns);
    const names = columns.map((column) => column.name);
    if (!names.includes(key)) { file.reason = "no_key_column"; continue; }
    if (!roles.start.length || !roles.end.length) { file.reason = !roles.end.length ? "no_end_column" : "no_start_column"; continue; }
    const start = roles.start[0];
    const end = roles.end[0];
    Object.assign(file, { key_column: key, start_column: start, end_column: end });
    try {
      const [parse] = await query(probeSql("parse", { source, key, start, end, cutoff }));
      const ratio = (ok, present) => (Number(present) === 0 ? 1 : Number(ok) / Number(present));
      if (Number(parse?.total) === 0) { file.reason = "empty_file"; continue; }
      if (ratio(parse.start_ok, parse.start_present) < 0.95 || ratio(parse.end_ok, parse.end_present) < 0.95) { file.reason = "columns_not_dates"; continue; }
      let reference = null;
      let referenceSource = "none";
      if (roles.snapshot.length) {
        const [row] = await query(probeSql("snapshot", { source, snapshot: roles.snapshot[0] }));
        if (row?.d && normalizeCutoff(row.d)) { reference = row.d; referenceSource = `column:${roles.snapshot[0]}`; }
      }
      if (!reference && registryDate) {
        const registered = await registryDate(path);
        if (registered && normalizeCutoff(registered)) { reference = registered; referenceSource = "source_registry"; }
      }
      if (reference) { result.reference_date = reference; result.reference_source = referenceSource; }
      const keysOf = async (kind) => (await query(probeSql(kind, { source, key, start, end, cutoff, reference }))).map((row) => String(row.k));
      const crossers = await keysOf("crossers");
      const open = await keysOf("open");
      const future = await keysOf("future");
      const missing = crossers.filter((k) => !members.has(k));
      const openMissing = open.filter((k) => !members.has(k));
      Object.assign(file, {
        status: "probed", crossers: crossers.length, crossers_missing: missing.length, crossers_missing_sample: missing.slice(0, 5),
        open_active: open.length, open_active_missing: openMissing.length, future_members: future.filter((k) => members.has(k)).length,
      });
      missingTotal += missing.length;
      openMissingTotal += openMissing.length;
    } catch (error) { file.status = "skipped"; file.reason = "probe_failed"; if (error?.shadowSkip) file.skipped = error.shadowSkip; }
  }
  const probed = result.files.filter((file) => file.status === "probed");
  if (!probed.length) return { ...result, reason: result.files.map((file) => file.reason).find(Boolean) ?? "nothing_probed" };
  result.status = "probed";
  result.reason = null;
  result.crossers_missing = missingTotal;
  result.open_active_missing = openMissingTotal;
  result.classification = missingTotal === 0 ? "clean"
    : filters.end_filters.length ? "would_block"
      : filters.windowed ? "would_warn_window" : "would_warn";
  return result;
}

/**
 * Coverage of the page's cutoff check by module type. Only visual modules are
 * compared with the page cutoff (and only those with a category field have
 * their subjects compared with the set); every other module type is never
 * looked at. Counts only: no module content.
 */
export function cutoffCoverage(spec, assets) {
  const declared = Boolean(spec?.subject_set && typeof spec.subject_set === "object");
  const byType = {};
  for (const module of Array.isArray(spec?.modules) ? spec.modules : []) {
    const type = String(module?.type ?? "unknown");
    const entry = (byType[type] ??= { modules: 0, cutoff_checked: 0, subjects_checked: 0, skipped: 0 });
    entry.modules += 1;
    if (!declared || type !== "visual") { entry.skipped += 1; continue; }
    entry.cutoff_checked += 1;
    const asset = assets?.[String(module.manifest_ref ?? "")];
    if (Array.isArray(asset?.subjects)) entry.subjects_checked += 1;
  }
  const skippedTypes = Object.fromEntries(Object.entries(byType).filter(([, entry]) => entry.skipped > 0).map(([type, entry]) => [type, entry.skipped]));
  return { subject_set_declared: declared, by_type: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => (a < b ? -1 : 1))), skipped_by_type: Object.fromEntries(Object.entries(skippedTypes).sort(([a], [b]) => (a < b ? -1 : 1))) };
}
