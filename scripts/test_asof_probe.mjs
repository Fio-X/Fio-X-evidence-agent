// Shadow check A: as-of leaks in subject-set SQL (runtime/pi/asof_probe.mjs and
// its glue on resolveSubjectSets). Part 1 is the pure module with fake
// describe/query; part 2 drives the real newsroom_infographic_lint handler and
// real DuckDB over a source table
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
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { classifyColumns, columnHasWord, cutoffCoverage, inspectFilters, normalizeCutoff, probeAsOf, readerCalls } from "../runtime/pi/asof_probe.mjs";
import { loadNewsroom, REPO } from "./precision_harness.mjs";

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

// ---- Part 2: real tool path ------------------------------------------------
const timeline = JSON.parse(readFileSync(join(REPO, "fixtures", "complex", "timeline.json"), "utf8"));
const walk = (dir, root = dir, out = new Map()) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out); else out.set(relative(root, path), readFileSync(path));
  }
  return out;
};
const SOURCE = "id,start_d,end_d,snapshot_date\nX,2015-03-01,2019-05-01,2020-01-01\nY,2016-01-01,,2020-01-01\nZ,2020-02-01,,2020-01-01\nW,2014-01-01,2030-01-01,2020-01-01\n";

async function scenario({ shadow, setWhere, subjectSet = true, source = SOURCE, origin = null }) {
  const h = await loadNewsroom({ prefix: "asof-", env: { NEWSROOM_SHADOW_CHECKS: shadow ? "1" : undefined, NEWSROOM_MOBILE_PAGES: "1" } });
  try {
    const fileSrc = h.addData("members", source);
    if (origin) { mkdirSync(join(h.art, "data", "origins"), { recursive: true }); writeFileSync(join(h.art, "data", "origins", "src.json"), JSON.stringify({ file: fileSrc, retrieved_at: origin })); }
    const fileA = h.addData("timeline", ["date,event", ...timeline.rows.map((row) => `${row.date},${row.event}`)].join("\n") + "\n");
    const qa = await h.query(`SELECT date, event FROM read_csv_auto('${fileA}')`);
    const claim = await h.recordClaim("The timeline has 4 dated milestones", [fileA], [qa]);
    const setRef = await h.query(`SELECT id FROM read_csv_auto('${fileSrc}') ${setWhere} ORDER BY id`);
    const planRef = "visualizations/plans/plan.json";
    writeFileSync(join(h.art, planRef), JSON.stringify({ ...timeline.spec, sql: `SELECT date, event FROM read_csv_auto('${fileA}') ORDER BY date`, claim_id: claim.claim_id }));
    const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
    const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lint.details.lintRef });
    const igRef = "infographics/plans/plan.json";
    writeFileSync(join(h.art, igRef), JSON.stringify({
      schema_version: "1.0.0", title: "Members", dek: "d", alt: "A header, a statistic and a chart.",
      ...(subjectSet ? { subject_set: { computation_ref: setRef, key_field: "id", cutoff_date: "2017-12-31" } } : {}),
      modules: [
        { id: "m1", type: "section_header", span: "full", heading: "Overview" },
        { id: "m2", type: "hero_stat", span: "full", value: "2", label: "Members", claim_id: claim.claim_id },
        { id: "m3", type: "visual", span: "full", manifest_ref: render.details.manifestRef },
      ],
    }));
    const before = walk(h.art);
    const result = await h.tools.get("newsroom_infographic_lint").execute("i", { plan_ref: igRef });
    const after = walk(h.art);
    const listing = (files, prefix) => [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
    const shadowFiles = listing(after, "shadow/");
    return {
      text: result.content[0].text,
      details: JSON.parse(JSON.stringify(result.details)),
      files: new Map([...after].filter(([path]) => !path.startsWith("shadow/") && path !== "claims.jsonl")),
      shadowFiles,
      record: result.details.shadow_asof ? JSON.parse(readFileSync(join(h.art, result.details.shadow_asof.path), "utf8")) : null,
      newComputations: listing(after, "computations/").filter((path) => !before.has(path)).concat(listing(after, "runtime/").filter((path) => !before.has(path))),
    };
  } finally {
    rmSync(h.tmp, { recursive: true, force: true });
  }
}

const LEAK = "WHERE end_d IS NULL";
const CORRECT = "WHERE start_d <= DATE '2017-12-31' AND (end_d IS NULL OR end_d > DATE '2017-12-31')";
const off = await scenario({ shadow: false, setWhere: LEAK });
const leak = await scenario({ shadow: true, setWhere: LEAK });
const correct = await scenario({ shadow: true, setWhere: CORRECT });
const noSet = await scenario({ shadow: true, setWhere: LEAK, subjectSet: false });
delete process.env.NEWSROOM_SHADOW_CHECKS;

// MUST FAIL: the end-column filter drops X.
assert.equal(leak.record.probe.classification, "would_block");
assert.equal(leak.record.probe.reference_source, "column:snapshot_date", "reference date comes from the data");
assert.equal(leak.record.probe.reference_date, "2020-01-01");
const file = leak.record.probe.files[0];
assert.deepEqual(file.crossers_missing_sample, ["X"], "X is valid at the cutoff and missing; W's end (2030) is after the data's reference date, so it is not a crosser");
assert.equal(file.crossers_missing, 1);
assert.equal(file.future_members, 1, "Z joined after the cutoff yet is in the set");
assert.deepEqual(leak.record.probe.filters.end_filters, ["end_d"]);
assert.equal(leak.details.shadow_asof.counts.crossers_missing, 1);
assert.deepEqual(Object.keys(leak.details.shadow_asof).sort(), ["counts", "path"]);
// MUST PASS: a correct as-of filter is clean.
assert.equal(correct.record.probe.classification, "clean");
assert.equal(correct.record.probe.files[0].crossers_missing, 0);
// MUST PASS: no subject_set -> nothing to probe, coverage still recorded.
assert.equal(noSet.record.probe.reason, "no_subject_set");
assert.equal(noSet.record.coverage.subject_set_declared, false);
// Coverage by type.
assert.deepEqual(leak.record.coverage.skipped_by_type, { hero_stat: 1, section_header: 1 });
assert.deepEqual(leak.record.coverage.by_type.visual, { modules: 1, cutoff_checked: 1, subjects_checked: 0, skipped: 0 });
// The probe only reads sources: no computation artifact, no query rows.
for (const run of [leak, correct, noSet]) assert.deepEqual(run.newComputations, [], "the probe created no computation or query-rows artifact");
// Same channel as B, and invisible: text and artifacts equal the switch-off run.
assert.equal(leak.text, off.text, "model-visible text byte-identical with the switch on");
const strip = (details) => Object.fromEntries(Object.entries(details).filter(([key]) => !key.startsWith("shadow")));
assert.deepEqual(strip(leak.details), strip(off.details), "details identical apart from the shadow keys");
assert.equal("shadow_asof" in off.details, false);
assert.deepEqual(off.shadowFiles, [], "off: nothing under shadow/");
assert.deepEqual([...leak.files.keys()], [...off.files.keys()]);
for (const [path, bytes] of off.files) assert.ok(bytes.equals(leak.files.get(path)), `artifact bytes differ with the switch on: ${path}`);
assert.ok(leak.shadowFiles.some((path) => path.startsWith("shadow/asof_probe-")) && leak.shadowFiles.some((path) => path.startsWith("shadow/prose_numbers-")));
// Warnings and blockers never carry the probe result.
assert.equal(JSON.stringify(leak.details.warnings).includes("asof"), false);
assert.equal(JSON.stringify(leak.details.blockers).includes("asof"), false);
// The registry's reference date is part of the key: same SQL, members and
// inputs but a different registered date must not reuse the old record.
const NO_SNAPSHOT = SOURCE.split("\n").map((line) => line.split(",").slice(0, 3).join(",")).join("\n");
const regA = await scenario({ shadow: true, setWhere: LEAK, source: NO_SNAPSHOT, origin: "2020-01-01" });
const regB = await scenario({ shadow: true, setWhere: LEAK, source: NO_SNAPSHOT, origin: "2024-06-30" });
delete process.env.NEWSROOM_SHADOW_CHECKS;
assert.equal(regA.record.probe.reference_source, "source_registry");
assert.equal(regA.record.probe.reference_date, "2020-01-01");
assert.equal(regB.record.probe.reference_date, "2024-06-30");
assert.notEqual(regA.details.shadow_asof.path, regB.details.shadow_asof.path, "a different registry reference date is a different side file");
console.log("asof probe: real infographic lint tool path -- PASS");
console.log("test_asof_probe.mjs ok");
