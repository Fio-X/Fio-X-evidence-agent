// Test-only helper (not a test: the name does not start with test_). The call report runtime/cross-call-report.jsonl is always written now,
// so a test that compares or lists run folders states the report's exact rows; the report is never skipped and never matched loosely.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const REPORT = "runtime/cross-call-report.jsonl";

const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
// a multiset: sorted canonical lines, so a duplicated row is a difference
const canon = (rows) => rows.map((row) => JSON.stringify(sortKeys(row))).sort();

export function reportRows(dir) {
  const file = join(dir, REPORT);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const files = (dir) => new Map(walk(dir).map((f) => [relative(dir, f), f]).filter(([name]) => name !== REPORT));

// The folder holds exactly allowedFiles plus the call report, and the report's rows equal reportRows exactly.
export function expectWrittenOnly(dir, allowedFiles, reportRows_, label = "folder") {
  const names = [...files(dir).keys()].sort();
  assert.deepEqual(names, [...allowedFiles].sort(), `${label}: exactly the allowed files, besides the call report`);
  assert.ok(existsSync(join(dir, REPORT)), `${label}: the call report is written`);
  assert.deepEqual(canon(reportRows(dir)), canon(reportRows_), `${label}: the call report holds exactly the stated rows`);
}

// The report of A = the report of B minus onlyInB plus onlyInA, as multisets (a test that already compares the other files its own way uses this alone).
export function expectSameReports(dirA, dirB, { onlyInA = [], onlyInB = [] } = {}, label = "runs") {
  const rowsB = canon(reportRows(dirB));
  for (const gone of canon(onlyInB)) {
    const at = rowsB.indexOf(gone);
    assert.ok(at >= 0, `${label}: the row stated as only in B is there: ${gone}`);
    rowsB.splice(at, 1);
  }
  const expected = [...rowsB, ...canon(onlyInA)].sort();
  assert.deepEqual(canon(reportRows(dirA)), expected, `${label}: the call report of A is the report of B minus the rows only in B plus the rows only in A`);
}

// For a test that lists or counts a folder its own way: checks the report's exact rows, then returns the file list (relative or absolute paths) without the report.
export function takeCallReport(dir, fileList, rows, label = "folder") {
  assert.ok(existsSync(join(dir, REPORT)), `${label}: the call report is written`);
  assert.deepEqual(canon(reportRows(dir)), canon(rows), `${label}: the call report holds exactly the stated rows`);
  return fileList.filter((file) => (isAbsolute(file) ? relative(dir, file) : file) !== REPORT);
}

// A step that must leave every other file alone: the report now holds exactly the rows it held before plus the stated rows (a multiset, so a duplicate is caught).
export function expectReportGrew(dir, rowsBefore, addedRows, label = "step") {
  assert.deepEqual(canon(reportRows(dir)), canon([...rowsBefore, ...addedRows]), `${label}: the call report holds the earlier rows plus exactly the stated new rows`);
}

// Rows in one short line each: "<tool> <group> <function> <callee owner> <declared> [key=json ...]", "-" for null, declared t|f|n (n = null);
// further fields are key=json (requester="none", tool_allowed=true). The parsed object is exactly the row the report holds.
export function callRows(lines) {
  const nil = (v) => (v === "-" ? null : v);
  return lines.map((line) => {
    const [tool, group, fn, owner, declared, ...extra] = line.split(" ");
    return { tool: nil(tool), tool_group: nil(group), function: fn, callee_owner: nil(owner), declared: declared === "t" ? true : declared === "f" ? false : null, ...Object.fromEntries(extra.map((kv) => { const at = kv.indexOf("="); return [kv.slice(0, at), JSON.parse(kv.slice(at + 1))]; })) };
  });
}

// Rows a test already holds in memory (one case of a table): the same multiset comparison, no folder.
export function expectRows(actualRows, expectedRows, label = "rows") {
  assert.deepEqual(canon(actualRows), canon(expectedRows), `${label}: the call report holds exactly the stated rows`);
}

// Two in-memory row lists: A = B minus onlyInB plus onlyInA, as multisets. Empty delta: they are the same rows.
export function expectRowsDelta(rowsA, rowsB, { onlyInA = [], onlyInB = [] } = {}, label = "rows") {
  const rest = canon(rowsB);
  for (const gone of canon(onlyInB)) {
    const at = rest.indexOf(gone);
    assert.ok(at >= 0, `${label}: the row stated as only in B is there: ${gone}`);
    rest.splice(at, 1);
  }
  assert.deepEqual(canon(rowsA), [...rest, ...canon(onlyInA)].sort(), `${label}: A = B minus the rows only in B plus the rows only in A`);
}
