#!/usr/bin/env node
import assert from 'node:assert/strict';
import { materializeComputationRowTables, safeDuckDbDiagnostic } from '../runtime/pi/computation_rows.mjs';

const hash = 'a'.repeat(64);
const ref = `computations/${hash}.json`;
const written = new Map();
const result = await materializeComputationRowTables(
  `SELECT source, target, value FROM '${ref}' ORDER BY value DESC`,
  {
    readComputation: async (requested) => {
      assert.equal(requested, ref);
      return { schema_version: '0.7.0', rows: [{ source: 'origin:Asia', target: 'destination:Asia', value: 10 }] };
    },
    writeRows: async (rowsRef, rows) => written.set(rowsRef, rows),
  },
);
assert.equal(result.sql, `SELECT source, target, value FROM 'runtime/query-rows/${hash}.json' ORDER BY value DESC`);
assert.deepEqual(result.row_refs, [`runtime/query-rows/${hash}.json`]);
assert.deepEqual(written.get(`runtime/query-rows/${hash}.json`), [{ source: 'origin:Asia', target: 'destination:Asia', value: 10 }]);
await assert.rejects(
  materializeComputationRowTables(`SELECT * FROM '${ref}'`, { readComputation: async () => ({}), writeRows: async () => {} }),
  /COMPUTATION_ROWS_REQUIRED/,
);
assert.equal(
  safeDuckDbDiagnostic('Binder Error: /tmp/story/data.csv token=secret\nmissing column', '/tmp/story'),
  'Binder Error: $ARTIFACT/data.csv token=<redacted> missing column',
);
console.log('computation row-table materialization: PASS');
