// Test-only helper (not a test: the name does not start with test_). The call report runtime/cross-call-report.jsonl is always written now,
// so a test that compares or lists run folders states the report's exact rows; the report is never skipped and never matched loosely.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPORT = "runtime/cross-call-report.jsonl";

// Default-on rows (#64: NEWSROOM_SPEED_ATOMIC_ARTIFACT is on unless exactly "0"). A test that states exact rows for the legacy writer runs a second time with
// CALL_ROWS_MODE=default and the switch unset; its rows then come from scripts/fixtures/call_rows_default_on/<test file>.json, written only by the recorder
// (CALL_ROWS_MODE=record: nothing is compared, every checked row list is stored under "<label>#<nth use of that label>"). Never hand-edit the fixtures.
// Remove the "0" case (and the hand-typed legacy rows) when the "0" off value is removed; then these fixtures become the only rows.
const MODE = process.env.CALL_ROWS_MODE;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "call_rows_default_on", `${basename(process.argv[1] ?? "test", ".mjs")}.json`);
const recorded = {};
const uses = new Map();
if (MODE === "record") process.on("exit", () => { mkdirSync(dirname(FIXTURE), { recursive: true }); writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + "\n"); });
const fixture = MODE === "default" ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
// Returns the expected rows to compare with (null = record mode: store the actual rows and skip the comparison).
function expectedFor(label, rows, actual) {
  if (!MODE) return rows;
  const nth = uses.get(label) ?? 0;
  uses.set(label, nth + 1);
  const key = `${label}#${nth}`;
  if (MODE === "record") { recorded[key] = JSON.parse(JSON.stringify(actual)); return null; }
  assert.ok(fixture && key in fixture, `no recorded default-on rows for ${key}: run the test once with CALL_ROWS_MODE=record`);
  return fixture[key];
}

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
  const want = expectedFor(label, reportRows_, reportRows(dir));
  if (want) assert.deepEqual(canon(reportRows(dir)), canon(want), `${label}: the call report holds exactly the stated rows`);
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
  const want = expectedFor(label, rows, reportRows(dir));
  if (want) assert.deepEqual(canon(reportRows(dir)), canon(want), `${label}: the call report holds exactly the stated rows`);
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
  const want = expectedFor(label, expectedRows, actualRows);
  if (want) assert.deepEqual(canon(actualRows), canon(want), `${label}: the call report holds exactly the stated rows`);
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
