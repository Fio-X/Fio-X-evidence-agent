import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { crossCallReportEnabled, trackExport } from "./groups.mjs";

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

// NEWSROOM_DUCKDB_BUNDLED_EXT=1 (exactly; default off): extra duckdb arguments that load the allow-listed
// extensions from a bundled directory before the configuration is locked. Autoinstall and autoload stay
// off, and nothing is downloaded or written. A pure helper: the caller passes the switch and directory
// values. An unusable directory is an error, never a fallback; a missing one fails in duckdb's own LOAD.
// Off: no arguments, so the command line is unchanged. httpfs is deliberately not on the list.
export const DUCKDB_BUNDLED_EXTENSIONS = Object.freeze(["excel"]);
export function duckdbBundledExtensionArgs(flag, dir) {
  if (flag !== "1") return [];
  const path = String(dir ?? "");
  if (!path.startsWith("/") || path.includes("'") || /[\r\n]/.test(path)) throw new Error("DUCKDB_BUNDLED_EXT_MISSING: NEWSROOM_DUCKDB_EXT_DIR must be an absolute directory without quotes (fetch it with scripts/fetch_duckdb_ext.py)");
  return [
    "-cmd", `SET extension_directory = '${path}'`,
    "-cmd", "SET autoinstall_known_extensions = false",
    "-cmd", "SET autoload_known_extensions = false",
    ...DUCKDB_BUNDLED_EXTENSIONS.flatMap((name) => ["-cmd", `LOAD ${name}`]),
  ];
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

export const FILE_READER_FUNCTIONS = new Set([
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
export async function recordedInputState(record, readComputation, depth = 0, seen = new Set(), opts = {}) {
  if (!record || !Array.isArray(record.read_inputs) || !INPUT_BINDINGS.includes(record.input_binding)) {
    return { binding: "legacy", effective: [] };
  }
  if (depth > MAX_CHAIN_DEPTH) return { binding: INPUT_BINDING_UNRESOLVED, effective: [] };
  return classifyInputs(record.read_inputs.map((input) => String(input?.path ?? "")), record.input_binding === INPUT_BINDING_UNRESOLVED, readComputation, depth, seen, opts);
}

async function classifyInputs(paths, hadUnresolved, readComputation, depth, seen, opts = {}) {
  const effective = new Set();
  let unresolved = hadUnresolved;
  for (const path of paths) {
    if (path.startsWith(DERIVED_PREFIX)) {
      // A derived table is evidence only while its chain to the downloaded
      // PDF checks out; without an artifact root it cannot be checked, so it
      // fails closed.
      const chain = opts.root ? await verifyDerivedInput(opts.root, path) : { ok: false };
      if (!chain.ok) { unresolved = true; continue; }
      effective.add(path); effective.add(chain.source_file);
      continue;
    }
    if (path.startsWith("data/") || path.startsWith("sources/")) { effective.add(path); continue; }
    if (!COMPUTATION_PATH.test(path) || seen.has(path)) { unresolved = true; continue; }
    let dependency = null;
    try { dependency = await readComputation(path); } catch { dependency = null; }
    const state = await recordedInputState(dependency, readComputation, depth + 1, new Set([...seen, path]), opts);
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
  const { binding, effective } = await classifyInputs(readInputs.map((input) => input.path), unresolved.length > 0, readComputation, 0, new Set(), { root });
  return { read_inputs: readInputs, input_binding: binding, effective_inputs: effective, reasons: unresolved };
}

// ---------------------------------------------------------------------------
// Derived PDF row tables (data/derived/<sha>.pdf-rows.json).
//
// download_data extracts a downloaded PDF into a row table. The table is only
// evidence while this chain holds, recomputed from bytes on disk:
//   rows file --sha256--> meta.rows_sha256
//   meta.source_sha256 == sha256 of the PDF data file named by meta.source_file
//   a download record (data/origins) for that PDF names the same sha256 and
//   the same rows_sha256.
// Any other file under data/derived/ is not an accepted input.
// ---------------------------------------------------------------------------
export const DERIVED_PREFIX = "data/derived/";
export const DERIVED_ROWS_PATH = /^data\/derived\/([0-9a-f]{64})\.pdf-rows\.json$/;

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyDerivedInput(root, path) {
  const fail = (reason) => ({ ok: false, reason });
  const match = DERIVED_ROWS_PATH.exec(String(path ?? ""));
  if (!match) return fail("not a recognised derived table path");
  try {
    const rowsBytes = await readFile(join(root, path));
    const meta = JSON.parse(await readFile(join(root, path.replace(/\.json$/, ".meta.json")), "utf8"));
    if (meta.kind !== "pdf_row_table" || meta.rows_file !== path) return fail("derived metadata does not describe this table");
    if (sha256Of(rowsBytes) !== meta.rows_sha256) return fail("derived table bytes do not match rows_sha256");
    if (meta.source_sha256 !== match[1]) return fail("derived table is not named for its source sha256");
    const source = String(meta.source_file ?? "");
    const base = source.split("/").pop() ?? "";
    if (!/^data\/[^/]+$/.test(source) || !base.startsWith(`${meta.source_sha256}.`)) return fail("source_file is not the content-addressed PDF");
    if (sha256Of(await readFile(join(root, source))) !== meta.source_sha256) return fail("source PDF bytes do not match source_sha256");
    let linked = false;
    for (const name of await readdir(join(root, "data", "origins"))) {
      if (!name.endsWith(".json")) continue;
      let origin;
      try { origin = JSON.parse(await readFile(join(root, "data", "origins", name), "utf8")); } catch { continue; }
      if (origin?.file === source && origin?.sha256 === meta.source_sha256 && origin?.derived_text?.file === path && origin?.derived_text?.rows_sha256 === meta.rows_sha256) { linked = true; break; }
    }
    if (!linked) return fail("no download record binds this table to the PDF");
    return { ok: true, source_file: source };
  } catch (error) {
    return fail(`derived chain unreadable: ${error?.code ?? error?.message ?? "error"}`);
  }
}

// K315 (NEWSROOM_GROUP_CALL_REPORT, default on; off only when exactly "0"): report-only record of tools reaching this module's exports (key computation_rows.mjs::name). Off: nothing below runs. test_k315_export_wrap pins this list.
if (crossCallReportEnabled()) {
  deriveComputationInputs = trackExport("computation_rows.mjs::deriveComputationInputs", deriveComputationInputs);
  materializeComputationRowTables = trackExport("computation_rows.mjs::materializeComputationRowTables", materializeComputationRowTables);
  recordedInputState = trackExport("computation_rows.mjs::recordedInputState", recordedInputState);
  duckdbBundledExtensionArgs = trackExport("computation_rows.mjs::duckdbBundledExtensionArgs", duckdbBundledExtensionArgs);
  safeDuckDbDiagnostic = trackExport("computation_rows.mjs::safeDuckDbDiagnostic", safeDuckDbDiagnostic);
}
