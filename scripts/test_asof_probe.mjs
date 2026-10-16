// As-of leaks in subject-set SQL (runtime/pi/asof_probe.mjs), the pure module
// with fake describe/query, over a source table
//
//   id  start       end         (cutoff 2017-12-31)
//   X   2015-03-01  2019-05-01   valid at the cutoff, ended later
//   Y   2016-01-01  (open)       valid at the cutoff, still open
//   Z   2020-02-01  (open)       joined after the cutoff
//
// MUST FAIL (probe reports a leak): the set SQL `WHERE end IS NULL` returns
// {Y, Z}: X, valid at the cutoff, is missing.
// MUST PASS (clean): `WHERE start <= C AND (end IS NULL OR end > C)` returns
// {X, Y}; no subject_set at all; a rolling-window filter is only a window.
import "./group_env_pin.mjs";
import assert from "node:assert/strict";
import { classifyColumns, columnHasWord, cutoffCoverage, inspectFilters, normalizeCutoff, probeAsOf, readerCalls } from "../runtime/pi/asof_probe.mjs";

// ---- Part 1: pure ----------------------------------------------------------
{
assert.equal(normalizeCutoff("2017"), "2017-12-31");
assert.equal(normalizeCutoff("2016-02"), "2016-02-29");
assert.equal(normalizeCutoff("2017-12-31"), "2017-12-31");
assert.equal(normalizeCutoff("latest"), null, "no wall clock: 'latest' is not resolved");
assert.equal(normalizeCutoff("2017-13"), null);
assert.equal(columnHasWord("end_date", "end"), true);
assert.equal(columnHasWord("Withdrawal_Date", "end"), true);
assert.equal(columnHasWord("weekend_hours", "end"), false, "'end' only as a word, not inside weekend");
assert.equal(columnHasWord("退出日期", "end"), true);
assert.deepEqual(classifyColumns([{ name: "id" }, { name: "join_year" }, { name: "exit_year" }, { name: "snapshot_date" }]), { start: ["join_year"], end: ["exit_year"], snapshot: ["snapshot_date"] });
assert.deepEqual([...readerCalls("SELECT id FROM read_csv_auto('data/a.csv', header=true) a JOIN read_json('data/b.json') b").keys()], ["data/a.csv", "data/b.json"]);
const col = (name) => ({ class: "COLUMN_REF", column_names: [name] });
const constant = { class: "CONSTANT", value: { type: { id: "VARCHAR" }, value: "" } };
const where = (node) => ({ statements: [{ node: { where_clause: node } }] });
assert.deepEqual(inspectFilters(where({ class: "COMPARISON", type: "COMPARE_EQUAL", left: col("end_d"), right: constant })).end_filters, ["end_d"]);
assert.deepEqual(inspectFilters(where({ class: "OPERATOR", type: "OPERATOR_IS_NULL", children: [col("end_d")] })).end_filters, ["end_d"]);
assert.deepEqual(inspectFilters(where({ class: "COMPARISON", type: "COMPARE_LESSTHANOREQUALTO", left: col("start"), right: constant })).end_filters, []);
assert.deepEqual(inspectFilters({ statements: [{ node: { select_list: [{ class: "COMPARISON", type: "COMPARE_EQUAL", left: col("end_d"), right: constant }] } }] }).end_filters, [], "only filters count, not the select list");
assert.equal(inspectFilters(where({ class: "FUNCTION", function_name: "date_diff", children: [] })).windowed, true);

// A scripted source: describe says what the columns are; query answers by probe kind.
const fake = ({ crossers = [], open = [], future = [], snapshot = null, columns }) => ({
  describe: async () => columns ?? [{ name: "id", type: "VARCHAR" }, { name: "start", type: "DATE" }, { name: "end_d", type: "DATE" }],
  query: async (sql) => {
    if (/AS total/.test(sql)) return [{ total: 3, start_ok: 3, start_present: 3, end_ok: 1, end_present: 1 }];
    if (/AS d FROM/.test(sql)) return [{ d: snapshot }];
    if (/HAVING min/.test(sql)) return future.map((k) => ({ k }));
    if (/IS NULL AND/.test(sql) || /\) IS NULL\)/.test(sql)) return open.map((k) => ({ k }));
    return crossers.map((k) => ({ k }));
  },
});
const base = { subjectSet: { key_field: "id", cutoff_date: "2017" }, sql: "SELECT id FROM read_csv_auto('data/t.csv')", inputs: ["data/t.csv"] };
const leak = await probeAsOf({ ...base, members: new Set(["Y", "Z"]), ast: where({ class: "OPERATOR", type: "OPERATOR_IS_NULL", children: [col("end_d")] }), ...fake({ crossers: ["X"], open: ["Y"], future: ["Z"] }) });
assert.equal(leak.status, "probed");
assert.equal(leak.classification, "would_block", "MUST FAIL: end-column filter and a valid-at-cutoff subject missing");
assert.deepEqual(leak.files[0].crossers_missing_sample, ["X"]);
assert.equal(leak.files[0].future_members, 1);
const clean = await probeAsOf({ ...base, members: new Set(["X", "Y"]), ast: where({}), ...fake({ crossers: ["X"], open: ["Y"] }) });
assert.equal(clean.classification, "clean", "MUST PASS: nothing valid at the cutoff is missing");
const windowed = await probeAsOf({ ...base, members: new Set(["Y"]), ast: where({ class: "FUNCTION", function_name: "date_diff", children: [] }), ...fake({ crossers: ["X"], open: ["Y"] }) });
assert.equal(windowed.classification, "would_warn_window", "a rolling window is a warning, never a block");
const quiet = await probeAsOf({ ...base, members: new Set(["Y"]), ast: where({}), ...fake({ crossers: ["X"], open: ["Y"] }) });
assert.equal(quiet.classification, "would_warn", "missing without an end-column filter: warn only");
// Reference date: from the data column, else the registry, else none; the clock is never read.
let clockRead = false;
const realNow = Date.now;
Date.now = () => { clockRead = true; return realNow(); };
const fromColumn = await probeAsOf({ ...base, members: new Set(), ast: null, ...fake({ crossers: [], snapshot: "2020-01-01", columns: [{ name: "id" }, { name: "start" }, { name: "end_d" }, { name: "snapshot_date" }] }) });
assert.deepEqual([fromColumn.reference_date, fromColumn.reference_source], ["2020-01-01", "column:snapshot_date"]);
const fromRegistry = await probeAsOf({ ...base, members: new Set(), ast: null, ...fake({}), registryDate: async () => "2019-06-30" });
assert.deepEqual([fromRegistry.reference_date, fromRegistry.reference_source], ["2019-06-30", "source_registry"]);
const none = await probeAsOf({ ...base, members: new Set(), ast: null, ...fake({}), registryDate: async () => null });
assert.deepEqual([none.reference_date, none.reference_source], [null, "none"]);
Date.now = realNow;
assert.equal(clockRead, false, "the probe never reads the wall clock");
// Skips are explicit, never silent.
assert.equal((await probeAsOf({ ...base, subjectSet: { key_field: "id", cutoff_date: "latest" }, members: new Set(), ast: null, ...fake({}) })).reason, "cutoff_unparseable");
assert.equal((await probeAsOf({ ...base, inputs: [], members: new Set(), ast: null, ...fake({}) })).reason, "no_source_input");
assert.equal((await probeAsOf({ ...base, members: new Set(), ast: null, ...fake({ columns: [{ name: "id" }, { name: "start" }] }) })).files[0].reason, "no_end_column");
assert.equal((await probeAsOf({ ...base, subjectSet: { key_field: "iso3", cutoff_date: "2017" }, members: new Set(), ast: null, ...fake({}) })).files[0].reason, "no_key_column");
// Coverage by module type.
const spec = { subject_set: { key_field: "id" }, modules: [{ type: "visual", manifest_ref: "m1" }, { type: "visual", manifest_ref: "m2" }, { type: "hero_stat" }, { type: "text" }, { type: "text" }, { type: "pull_quote" }, { type: "illustration" }] };
const coverage = cutoffCoverage(spec, { m1: { subjects: ["a"] }, m2: {} });
assert.deepEqual(coverage.skipped_by_type, { hero_stat: 1, illustration: 1, pull_quote: 1, text: 2 });
assert.deepEqual(coverage.by_type.visual, { modules: 2, cutoff_checked: 2, subjects_checked: 1, skipped: 0 });
assert.deepEqual(cutoffCoverage({ modules: [{ type: "visual" }, { type: "text" }] }, {}).skipped_by_type, { text: 1, visual: 1 }, "no subject_set: nothing is cutoff-checked");
console.log("asof probe: pure module -- PASS");
}
console.log("test_asof_probe.mjs ok");
