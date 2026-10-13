#!/usr/bin/env node
// K59: a stat whose view_spec.row_index is outside the bound rows is refused, never clamped.
import assert from 'node:assert/strict';
process.env.NEWSROOM_STAT_ROW_INDEX_STRICT = '1';
import { buildEvidenceBoundModule } from '../runtime/pi/publication_binding.mjs';

const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
const stat = (view) => ({ id: 's1', type: 'stat', unit: '%', evidence_binding: { kind: 'computation', field_mapping: { value: 'v' } }, view_spec: view });
const refused = (view, pattern, r = rows) => assert.throws(() => buildEvidenceBoundModule(stat(view), r), pattern);

// in range: both ends, a middle row, and the default
assert.equal(buildEvidenceBoundModule(stat({ row_index: 1 }), rows).value, 20);
assert.equal(buildEvidenceBoundModule(stat({ row_index: 0 }), rows).value, 10);
assert.equal(buildEvidenceBoundModule(stat({ row_index: 2 }), rows).value, 30);
assert.equal(buildEvidenceBoundModule(stat({}), rows).value, 10);

// out of range at each end: refused, naming the index and the row count
refused({ row_index: 3 }, /row_index 3 is outside the 3 bound rows \(valid 0\.\.2\)/);
refused({ row_index: 99 }, /row_index 99 is outside the 3 bound rows/);
refused({ row_index: -1 }, /row_index -1 is outside the 3 bound rows/);

// not a row number at all: refused, not silently turned into a row
refused({ row_index: 1.5 }, /row_index 1\.5 is outside the 3 bound rows/);
refused({ row_index: 'abc' }, /row_index "abc" is outside the 3 bound rows/);

// values Number() would have turned into a row: only a real number counts
refused({ row_index: true }, /row_index true is outside the 3 bound rows/);
refused({ row_index: [1] }, /row_index \[1\] is outside the 3 bound rows/);
refused({ row_index: '2' }, /row_index "2" is outside the 3 bound rows/);
refused({ row_index: '' }, /row_index "" is outside the 3 bound rows/);
refused({ row_index: false }, /row_index false is outside the 3 bound rows/);
// null is "absent", like undefined
assert.equal(buildEvidenceBoundModule(stat({ row_index: null }), rows).value, 10);

// no rows keeps its own refusal
refused({ row_index: 0 }, /has no bound rows/, []);

// Switch not exactly "1": the old clamp to the first or last row.
for (const value of [undefined, '0', 'true', '']) {
  if (value === undefined) delete process.env.NEWSROOM_STAT_ROW_INDEX_STRICT; else process.env.NEWSROOM_STAT_ROW_INDEX_STRICT = value;
  assert.equal(buildEvidenceBoundModule(stat({ row_index: 99 }), rows).value, 30, `switch ${JSON.stringify(value)}`);
  assert.equal(buildEvidenceBoundModule(stat({ row_index: -1 }), rows).value, 10, `switch ${JSON.stringify(value)}`);
}

console.log('PASS: test_k59_stat_row_range');
