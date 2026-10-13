// A9: a dumbbell/slope draws two value columns on one axis and joins them with a line, so the semantic gate
// must compare the measures behind BOTH columns, even when claim_spec names only one of them.
// Through the real newsroom_viz_plan tool (typed-stripped copy of newsroom.ts, same harness as
// test_viz_plan_inset_param.mjs). Offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const tmp = mkdtempSync(join(tmpdir(), "chart-measures-"));
execFileSync("cp", ["-R", join(ROOT, "runtime"), join(tmp, "runtime")]);
execFileSync("cp", ["-R", join(ROOT, "config"), join(tmp, "config")]);
stub(tmp, "typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub(tmp, "@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const art = mkdtempSync(join(tmpdir(), "chart-measures-artifact-"));
for (const dir of ["visualizations/plans", "visualizations/lints", "computations"]) mkdirSync(join(art, dir), { recursive: true });
execFileSync("cp", ["-R", join(ROOT, "config"), join(art, "config")]);
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
process.env.NEWSROOM_SHARED_AXIS_SEMANTICS = "1";
writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
  claim_id: "claim-measures", status: "verified", source_refs: ["sources/fixture.json"],
  verification: { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true },
})}\n`);
const tools = new Map();
const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
(await import(join(pi, "newsroom.test-copy.mjs"))).default(piApi);
const plan = tools.get("newsroom_viz_plan");

const sql = "SELECT * FROM (VALUES ('North', 61.5, 88.0), ('South', 48.2, 91.4), ('East', 70.1, 79.9)) AS t(region, left_value, right_value)";
// Two measures that must never share an axis: different phenomenon and different denominator.
const base = { phenomenon: "share", unit: "%", measure_kind: "share", temporal_basis: { type: "point_in_time", date: "2020" } };
const unrelated = [
  { ...base, id: "a", field: "left_value", phenomenon: "adult_employment_share", denominator: "adults" },
  { ...base, id: "b", field: "right_value", phenomenon: "child_literacy_share", denominator: "children" },
];
const sameMeasureTwoYears = [
  { ...base, id: "a", field: "left_value", phenomenon: "adult_employment_share", denominator: "adults", temporal_basis: { type: "point_in_time", date: "2010" } },
  { ...base, id: "b", field: "right_value", phenomenon: "adult_employment_share", denominator: "adults", temporal_basis: { type: "point_in_time", date: "2020" } },
];
const params = (chart_type, measure_semantics, claim_spec) => ({
  reader_task: "comparison", title: "Two shares by region", alt: "A chart comparing two values per region, one dot at each end of a line.",
  source_note: "Synthetic fixture", claim_id: "claim-measures", sql, unit: "%", chart_type,
  category_field: "region", start_field: "left_value", end_field: "right_value",
  measure_semantics, claim_spec: { claim_id: "claim-measures", relation: "comparison", reader_task: "compare the two shares", ...claim_spec },
});
const blocked = (promise) => assert.rejects(() => promise, /SEMANTIC_COMPARISON_BLOCKED[\s\S]*phenomenon_mismatch[\s\S]*denominator_mismatch/);

for (const chart of ["dumbbell", "slope"]) {
  // Control: both ids declared, blocked (passes on every commit).
  await blocked(plan.execute(`control-${chart}`, params(chart, unrelated, { target_measure: "a", measure_ids: ["a", "b"] })));
  // Attack: only the target is declared, but the chart draws both columns.
  await blocked(plan.execute(`attack-${chart}`, params(chart, unrelated, { target_measure: "a" })));
  // Control: the same measure at both ends in two years is still allowed.
  const ok = await plan.execute(`same-${chart}`, params(chart, sameMeasureTwoYears, { target_measure: "a" }));
  assert.ok(ok.details.planRef, `${chart}: same measure in two years must plan`);
}
// A drawn column that no declared measure owns is an error that names the field, never a skip.
const noField = unrelated.map(({ field, ...rest }) => rest);
await assert.rejects(() => plan.execute("nofield", params("dumbbell", noField, { target_measure: "a" })), /SEMANTIC_FIELD_UNDECLARED: dumbbell start_field 'left_value'/);
const half = [unrelated[0], { ...unrelated[1], field: "other" }];
await assert.rejects(() => plan.execute("halffield", params("dumbbell", half, { target_measure: "a" })), /SEMANTIC_FIELD_UNDECLARED: dumbbell end_field 'right_value'/);
const dup = [unrelated[0], { ...unrelated[1], field: "left_value" }];
await assert.rejects(() => plan.execute("dupfield", params("dumbbell", dup, { target_measure: "a" })), /SEMANTIC_FIELD_AMBIGUOUS/);
// A shared-axis chart with no semantics at all is refused whatever the reader task.
for (const chart of ["dumbbell", "slope"]) {
  for (const task of ["relationship", "sequence", "spatial", "flow", "hierarchy", "process"]) {
    const bare = { ...params(chart, undefined, undefined), reader_task: task };
    delete bare.measure_semantics; delete bare.claim_spec;
    await assert.rejects(() => plan.execute(`bare-${chart}-${task}`, bare), new RegExp(`SEMANTIC_DECLARATION_REQUIRED: chart_type '${chart}' draws start_field and end_field on one axis`));
  }
}
// Other chart types are unchanged: a bar with no semantics under a non-required task still plans.
const bar = { ...params("horizontal_bar", undefined, undefined), reader_task: "sequence", value_field: "left_value" };
delete bar.measure_semantics; delete bar.claim_spec; delete bar.start_field; delete bar.end_field;
const barPlan = await plan.execute("bare-bar", bar);
assert.ok(barPlan.details.planRef, "horizontal_bar with no semantics under sequence must plan");
// Switch not exactly "1": the old behaviour is unchanged (a bare dumbbell under a non-required task plans, and only the declared target is compared).
for (const value of [undefined, "0", "true", ""]) {
  if (value === undefined) delete process.env.NEWSROOM_SHARED_AXIS_SEMANTICS; else process.env.NEWSROOM_SHARED_AXIS_SEMANTICS = value;
  const bare = { ...params("dumbbell", undefined, undefined), reader_task: "sequence" };
  delete bare.measure_semantics; delete bare.claim_spec;
  const planned = await plan.execute(`off-bare-${String(value)}`, bare);
  assert.ok(planned.details.planRef, `switch ${JSON.stringify(value)}: a bare dumbbell must plan as before`);
  const narrow = await plan.execute(`off-narrow-${String(value)}`, params("dumbbell", unrelated, { target_measure: "a" }));
  assert.ok(narrow.details.planRef, `switch ${JSON.stringify(value)}: only the declared target is compared as before`);
}
console.log(JSON.stringify({ status: "PASS", charts: ["dumbbell", "slope"] }));
