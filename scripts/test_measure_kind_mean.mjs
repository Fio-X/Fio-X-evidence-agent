// measure_kind "mean" and "median" (K988): both measure_semantics validators accept them, a pair of different kinds that is not a known
// benchmark pair stays a measure_kind mismatch (mean vs rate, mean vs median), and the choropleth check accepts a declared mean / median
// only with its denominator. Run: node scripts/test_measure_kind_mean.mjs (needs the duckdb CLI on PATH).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { COMPARABILITY, normalizeMeasureSemantic as normalizeVisual, compareMeasureSemantics as compareVisual } from "../runtime/visual/measure_semantics.mjs";
import { normalizeMeasureSemantic as normalizePi, compareMeasureSemantics as comparePi } from "../runtime/pi/measure_semantics.mjs";
import { lintChoroplethNormalized } from "../runtime/pi/choropleth.mjs";

const entry = (kind, extra = {}) => ({ id: "m", phenomenon: "surface_temperature", unit: "°C", measure_kind: kind, temporal_basis: { type: "period" }, ...extra });
for (const [label, normalize, compare] of [["visual", normalizeVisual, compareVisual], ["pi", normalizePi, comparePi]]) {
  for (const kind of ["mean", "median"]) assert.equal(normalize(entry(kind)).measure_kind, kind, `${label}: ${kind} is a valid measure_kind`);
  assert.throws(() => normalize(entry("average")), /measure_kind/, `${label}: an unknown kind is still refused`);
  for (const other of ["rate", "median", "level", "index"]) {
    const result = compare(entry("mean"), entry(other));
    assert.equal(result.status, COMPARABILITY.INCOMPATIBLE, `${label}: mean vs ${other}`);
    assert.ok(result.reasons.includes("measure_kind_mismatch"), `${label}: mean vs ${other} is a measure_kind mismatch, got ${JSON.stringify(result)}`);
  }
  const same = compare(entry("mean"), entry("mean"));
  assert.equal(same.status, COMPARABILITY.DIRECT, `${label}: mean vs mean is directly comparable`);
}
// The generated copy and the source list the same kinds.
const kinds = (path) => readFileSync(path, "utf8").match(/MEASURE_KINDS=new Set\(\[([^\]]*)\]/)[1].replace(/\s+/g, "");
assert.equal(kinds("runtime/pi/measure_semantics.mjs"), kinds("runtime/visual/measure_semantics.mjs"));
// The tool schema (newsroom_viz_plan measure_semantics) and the recipe schema list them too.
assert.match(readFileSync("runtime/pi/newsroom.ts", "utf8"), /"price", "mean", "median"\] as const\),\n\s+temporal_basis/);
const recipe = JSON.parse(readFileSync("runtime/gis/visual_recipe.schema.json", "utf8"));
const findKinds = (node) => Array.isArray(node) ? node.flatMap(findKinds) : node && typeof node === "object" ? [...(node.measure_kind?.enum ? [node.measure_kind.enum] : []), ...Object.values(node).flatMap(findKinds)] : [];
const recipeKinds = findKinds(recipe);
assert.ok(recipeKinds.length && recipeKinds.every((list) => list.includes("mean") && list.includes("median")), "recipe schema lists mean and median");

// The choropleth check: a declared mean or median passes with a denominator and a unit, and not without.
const ast = (sql) => {
  const out = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["-noheader", "-list", ":memory:", "-c", `SELECT json_serialize_sql('${sql.replace(/'/g, "''")}', skip_null := true, skip_empty := true)`], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim());
};
const plan = (kind, extra = {}) => ({ chart_type: "choropleth", category_field: "geo", value_field: "v", measure_semantics: [{ field: "v", unit: "°C", measure_kind: kind, denominator: "daily readings", ...extra }] });
assert.deepEqual(lintChoroplethNormalized(ast("SELECT geo, AVG(t) AS v FROM s GROUP BY geo"), plan("mean")), []);
assert.deepEqual(lintChoroplethNormalized(ast("SELECT geo, median(t) AS v FROM s GROUP BY geo"), plan("median")), []);
assert.match(lintChoroplethNormalized(ast("SELECT geo, AVG(t) AS v FROM s GROUP BY geo"), plan("mean", { denominator: "" }))[0] ?? "", /averaged over/);
assert.match(lintChoroplethNormalized(ast("SELECT geo, median(t) AS v FROM s GROUP BY geo"), plan("median", { denominator: "" }))[0] ?? "", /averaged over/);
console.log("test_measure_kind_mean: ok");
