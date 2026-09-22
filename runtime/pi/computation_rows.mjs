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
