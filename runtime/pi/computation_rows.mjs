import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

const COMPUTATION_REF = /(["'])(computations\/[0-9a-f]{64}\.json)\1/gi;

/**
 * Turn content-addressed computation envelopes into immutable row-table
 * sidecars for DuckDB. The original SQL remains the audited contract; only
 * execution uses the deterministic `.rows.json` projection.
 */
export async function materializeComputationRowTables(sql, { readComputation, writeRows }) {
  const refs = [...String(sql ?? "").matchAll(COMPUTATION_REF)].map((match) => match[2]);
  const uniqueRefs = [...new Set(refs)];
  let rewritten = String(sql ?? "");
  const rowRefs = [];
  for (const ref of uniqueRefs) {
    const computation = await readComputation(ref);
    if (!Array.isArray(computation?.rows)) {
      throw new Error(`COMPUTATION_ROWS_REQUIRED: ${ref} does not contain a rows array`);
    }
    const rowsRef = `runtime/query-rows/${ref.split('/').pop()}`;
    await writeRows(rowsRef, computation.rows);
    rewritten = rewritten
      .split(`'${ref}'`).join(`'${rowsRef}'`)
      .split(`"${ref}"`).join(`"${rowsRef}"`);
    rowRefs.push(rowsRef);
  }
  return { sql: rewritten, row_refs: rowRefs };
}

export function safeDuckDbDiagnostic(stderr, artifactRoot = '') {
  let value = String(stderr ?? '');
  if (artifactRoot) value = value.split(String(artifactRoot)).join('$ARTIFACT');
  value = value
    .replace(/(api[_-]?key|authorization|token|password)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return value ? value.slice(0, 800) : 'query process exited without a diagnostic';
}

// ---------------------------------------------------------------------------
// Read-input binding (issue #36).
//
// A computation record used to fingerprint the whole evidence directory, so a
// model-typed `VALUES` table looked "bound" to any cited source. The helpers
// below derive which artifact files a SQL statement really reads, from the
// DuckDB `json_serialize_sql` AST, and classify the computation:
//   source_bound  reads at least one data/ or sources/ file (transitively
//                 through computations/<hash>.json row tables);
//   literal_only  reads no evidence file at all (VALUES, constants, ranges);
//   unresolved    reads something that cannot be resolved statically (glob,
//                 computed path, unknown table function, unserializable SQL,
//                 missing file, or a legacy chained computation).
// Anything but source_bound can never make a claim verified.
// ---------------------------------------------------------------------------

export const INPUT_BINDING_SOURCE_BOUND = "source_bound";
export const INPUT_BINDING_LITERAL_ONLY = "literal_only";
export const INPUT_BINDING_UNRESOLVED = "unresolved";
export const INPUT_BINDINGS = [INPUT_BINDING_SOURCE_BOUND, INPUT_BINDING_LITERAL_ONLY, INPUT_BINDING_UNRESOLVED];

const FILE_READER_FUNCTIONS = new Set([
  "read_csv", "read_csv_auto", "read_json", "read_json_auto", "read_ndjson", "read_ndjson_auto",
  "read_json_objects", "read_json_objects_auto", "read_ndjson_objects", "read_parquet", "parquet_scan",
  "read_text", "read_blob", "parquet_metadata", "parquet_schema", "parquet_file_metadata",
  "parquet_kv_metadata", "sniff_csv",
]);
const LITERAL_TABLE_FUNCTIONS = new Set([
  "range", "generate_series", "unnest", "repeat_row", "generate_subscripts", "json_each", "json_tree",
]);
const COMPUTATION_PATH = /^computations\/[0-9a-f]{64}\.json$/;
const MAX_CHAIN_DEPTH = 16;

/** Canonical artifact-relative input path, or null when it is not one. */
export function canonicalInputPath(raw) {
  const value = String(raw ?? "");
  if (!value || value.length > 512 || !/^[A-Za-z0-9._\/-]+$/.test(value)) return null;
  if (value.startsWith("/") || value.includes("//") || value.endsWith("/")) return null;
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (value.startsWith("data/") || value.startsWith("sources/") || COMPUTATION_PATH.test(value)) return value;
  return null;
}

function constantStrings(expr) {
  if (!expr || typeof expr !== "object") return null;
  if (expr.class === "CONSTANT") {
    const v = expr.value;
    return v && v.is_null === false && v.type?.id === "VARCHAR" && typeof v.value === "string" ? [v.value] : null;
  }
  if (expr.class === "FUNCTION" && expr.function_name === "list_value" && Array.isArray(expr.children) && expr.children.length) {
    const out = [];
    for (const child of expr.children) {
      const inner = constantStrings(child);
      if (!inner || inner.length !== 1) return null;
      out.push(inner[0]);
    }
    return out;
  }
  return null;
}

/**
 * Pure walk of a json_serialize_sql AST. Returns the constant file paths the
 * statement reads and the reasons it could not be fully resolved.
 */
export function collectSqlReads(ast) {
  const paths = new Set();
  const unresolved = [];
  if (!ast || ast.error !== false || !Array.isArray(ast.statements) || ast.statements.length !== 1) {
    return { paths: [], unresolved: ["SQL is not a single serializable SELECT statement"] };
  }
  const ctes = new Set();
  (function findCtes(node) {
    if (Array.isArray(node)) return node.forEach(findCtes);
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.cte_map?.map)) for (const entry of node.cte_map.map) if (typeof entry?.key === "string") ctes.add(entry.key);
    for (const value of Object.values(node)) findCtes(value);
  })(ast);
  (function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.type === "BASE_TABLE") {
      const table = String(node.table_name ?? "");
      const qualified = Boolean(node.schema_name) || Boolean(node.catalog_name);
      if (!qualified && !ctes.has(table) && /[\/.*\\:]/.test(table)) {
        const path = canonicalInputPath(table);
        if (path) paths.add(path); else unresolved.push("table reference is not a plain data/, sources/ or computations/ path");
      }
    } else if (node.type === "TABLE_FUNCTION") {
      const fn = node.function ?? {};
      const name = String(fn.function_name ?? "").toLowerCase();
      if (FILE_READER_FUNCTIONS.has(name)) {
        const positional = (Array.isArray(fn.children) ? fn.children : []).filter((child) => !child?.alias);
        const listed = positional.length === 1 ? constantStrings(positional[0]) : null;
        if (!listed) unresolved.push(`${name}: path is not a single constant string or list`);
        else for (const raw of listed) {
          const path = canonicalInputPath(raw);
          if (path) paths.add(path); else unresolved.push(`${name}: path is not a plain data/, sources/ or computations/ path`);
        }
      } else if (!LITERAL_TABLE_FUNCTIONS.has(name)) {
        unresolved.push(`table function ${name || "<unknown>"} is not recognized`);
      }
    }
    for (const value of Object.values(node)) visit(value);
  })(ast);
  return { paths: [...paths].sort(), unresolved: [...new Set(unresolved)] };
}

async function hashFileStream(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** State of an already recorded computation: {binding|legacy, effective:[paths]}. */
export async function recordedInputState(record, readComputation, depth = 0, seen = new Set()) {
  if (!record || !Array.isArray(record.read_inputs) || !INPUT_BINDINGS.includes(record.input_binding)) {
    return { binding: "legacy", effective: [] };
  }
  if (depth > MAX_CHAIN_DEPTH) return { binding: INPUT_BINDING_UNRESOLVED, effective: [] };
  return classifyInputs(record.read_inputs.map((input) => String(input?.path ?? "")), record.input_binding === INPUT_BINDING_UNRESOLVED, readComputation, depth, seen);
}

async function classifyInputs(paths, hadUnresolved, readComputation, depth, seen) {
  const effective = new Set();
  let unresolved = hadUnresolved;
  for (const path of paths) {
    if (path.startsWith("data/") || path.startsWith("sources/")) { effective.add(path); continue; }
    if (!COMPUTATION_PATH.test(path) || seen.has(path)) { unresolved = true; continue; }
    let dependency = null;
    try { dependency = await readComputation(path); } catch { dependency = null; }
    const state = await recordedInputState(dependency, readComputation, depth + 1, new Set([...seen, path]));
    if (state.binding === "legacy" || state.binding === INPUT_BINDING_UNRESOLVED) unresolved = true;
    for (const inner of state.effective) effective.add(inner);
  }
  if (unresolved) return { binding: INPUT_BINDING_UNRESOLVED, effective: [...effective].sort() };
  return { binding: effective.size ? INPUT_BINDING_SOURCE_BOUND : INPUT_BINDING_LITERAL_ONLY, effective: [...effective].sort() };
}

/**
 * Derive the read inputs of a SQL statement. `serializeSql(sql)` must return
 * the parsed json_serialize_sql document (or throw); `readComputation(ref)`
 * returns a stored computation record.
 */
export async function deriveComputationInputs(sql, { root, serializeSql, readComputation }) {
  let reads;
  try {
    reads = collectSqlReads(await serializeSql(sql));
  } catch {
    reads = { paths: [], unresolved: ["SQL could not be analyzed"] };
  }
  const unresolved = [...reads.unresolved];
  const readInputs = [];
  for (const path of reads.paths) {
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile()) throw new Error("not a regular file");
      readInputs.push({ path, sha256: await hashFileStream(join(root, path)) });
    } catch {
      unresolved.push(`input file is missing or not a regular file: ${path}`);
    }
  }
  const { binding, effective } = await classifyInputs(readInputs.map((input) => input.path), unresolved.length > 0, readComputation, 0, new Set());
  return { read_inputs: readInputs, input_binding: binding, effective_inputs: effective, reasons: unresolved };
}
