// NEWSROOM_CHOROPLETH_NORMALIZED (on unless exactly "0"): lintChoroplethNormalized reads DuckDB's own parse (json_serialize_sql) of the plan SQL.
// A choropleth value must be a ratio, share or per-capita figure whose divisor differs by region, or a declared mean, median or index. Each refusal below is a mutation of a passing
// shape: it must go red the moment the matching rule is removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lintChoroplethNormalized } from "../runtime/pi/choropleth.mjs";

const DUCKDB = process.env.NEWSROOM_DUCKDB_BIN || "duckdb";
const ast = (sql) => {
  const out = spawnSync(DUCKDB, ["-noheader", "-list", ":memory:", "-c", `SELECT json_serialize_sql('${sql.replace(/'/g, "''")}', skip_null := true, skip_empty := true)`], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim());
};
const spec = (extra = {}) => ({ chart_type: "choropleth", category_field: "geo", value_field: "v", ...extra });
const sem = (entry) => ({ measure_semantics: [{ field: "v", unit: "x", measure_kind: "flow", ...entry }] });
// A full ratio declaration: the refusals below must come from the SQL, not from the declared kind.
const ratioDecl = spec(sem({ measure_kind: "rate", unit: "%", denominator: "population" }));
const refused = (sql, s) => lintChoroplethNormalized(ast(sql), s);
const passes = (sql, s, why) => assert.deepEqual(refused(sql, s), [], why);
const fails = (sql, s, why, pattern) => { const got = refused(sql, s); assert.ok(got.length === 1, `${why}: expected one refusal, got ${JSON.stringify(got)}`); if (pattern) assert.match(got[0], pattern, why); };

// Legitimate shapes the first draft could have refused.
passes("SELECT geo, deaths / (deaths + births) AS v FROM t", spec(sem({ measure_kind: "share", unit: "%" })), "share of a sum that includes the numerator");
passes("SELECT geo, SUM(deaths) / SUM(pop) AS v FROM t GROUP BY geo", spec(sem({ measure_kind: "rate", unit: "%" })), "grouped ratio of sums");
passes("SELECT geo, x / SUM(pop) OVER (PARTITION BY geo) AS v FROM t", spec(sem({ measure_kind: "share", unit: "%" })), "window partitioned by the region");
passes("SELECT geo, (a - b) / (a + b) AS v FROM t", spec(sem({ measure_kind: "share", unit: "%" })), "normalized difference");
passes("SELECT geo, 1000 / pop * deaths AS v FROM t", spec(sem({ measure_kind: "rate", unit: "per 1,000" })), "constant on top, data divisor");
// Legitimate: a division by a data column that differs by region.
passes("SELECT geo, deaths / population * 100000 AS v FROM t", spec(sem({ measure_kind: "rate", unit: "per 100,000" })), "same-row ratio");
passes("SELECT geo, round(deaths * 1.0 / population, 4) AS v FROM t", spec(sem({ measure_kind: "rate", unit: "%" })), "ratio inside round");
passes("SELECT t.geo, t.deaths / p.pop AS v FROM t JOIN p ON t.geo = p.geo", spec(sem({ measure_kind: "rate", unit: "per capita" })), "divisor from a joined table");
passes("SELECT t.geo, t.x / (SELECT p.pop FROM p WHERE p.geo = t.geo) AS v FROM t", spec(sem({ measure_kind: "rate", unit: "per capita" })), "correlated subquery follows the region");
passes("WITH s AS (SELECT geo, x, pop FROM t) SELECT geo, x / pop AS v FROM s", spec(sem({ measure_kind: "rate", unit: "%" })), "divisor reached through a CTE");
// A pass-through column is accepted only with all three: kind, denominator, ratio unit (the inflation case).
passes("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit: "%", denominator: "price level a year earlier" })), "inflation rate with a denominator passes");
passes("SELECT geo, v FROM t", spec({ unit: "per 100,000", ...sem({ measure_kind: "share", denominator: "population" }) }), "spec.unit counts when the entry has none that names a ratio");

// K985 (review K983): real ratios the first draft refused. Each has a mutation in the notes of the report (rule removed -> red).
const share = spec(sem({ measure_kind: "share", unit: "%", denominator: "total" }));
passes("SELECT geo, (a - b) / b * 100 AS v FROM t", ratioDecl, "inflation (a - b) / b: the divisor column is also in the numerator");
passes("SELECT geo, 100.0 * SUM(CASE WHEN fuel = 'renew' THEN gwh END) / SUM(gwh) AS v FROM t GROUP BY geo", share, "share by CASE over the same column");
passes("SELECT geo, v FROM (SELECT geo, fuel, gwh / SUM(gwh) OVER (PARTITION BY geo) AS v FROM t) WHERE fuel = 'renew'", share, "share inside the region (window by region on its own column)");
passes("SELECT geo, x / LAG(x) OVER (PARTITION BY geo ORDER BY yr) AS v FROM t", ratioDecl, "change against the previous row (LAG reads another row)");
passes("SELECT geo, x / LAG(x) OVER (PARTITION BY yr ORDER BY geo) AS v FROM t", ratioDecl, "LAG partitioned by something else still reads another row");
passes("SELECT a.geo, a.cpi / b.cpi AS v FROM t a JOIN t b ON a.geo = b.geo AND a.yr = b.yr + 1", ratioDecl, "self-join a.cpi / b.cpi are two columns");
passes("SELECT geo, v FROM t WHERE pop / 1000 > 5", ratioDecl, "a constant division in WHERE does not touch a column read as it is");
fails("SELECT geo, x / x AS v FROM t t1 JOIN t t2 USING (geo)", ratioDecl, "same bare column on both sides is still a / a");
fails("SELECT geo, SUM(x) / SUM(x) AS v FROM t GROUP BY geo", ratioDecl, "SUM(x) / SUM(x)");
// A declaration does not override the SQL: a sum or a count that is not divided per region is a total.
fails("SELECT geo, SUM(x) AS v FROM t GROUP BY geo", ratioDecl, "grouped SUM with a full ratio declaration", /sum or a count/);
fails("SELECT geo, COUNT(*) AS v FROM t GROUP BY geo", ratioDecl, "grouped COUNT with a full ratio declaration", /sum or a count/);
fails("SELECT geo, v FROM (SELECT geo, SUM(x) AS v FROM t GROUP BY geo)", ratioDecl, "SUM inside a FROM subquery", /sum or a count/);
fails("SELECT geo, CASE WHEN SUM(x) > 0 THEN SUM(x) END AS v FROM t GROUP BY geo", ratioDecl, "SUM inside a CASE branch", /sum or a count/);
fails("WITH s AS (SELECT geo, SUM(x) AS v FROM t GROUP BY geo) SELECT geo, v FROM s", ratioDecl, "SUM through a CTE", /sum or a count/);
fails("SELECT geo, SUM(gwh) + SUM(renew) / SUM(pop) AS v FROM t GROUP BY geo", ratioDecl, "a total added to a real ratio", /sum or a count/);
fails("SELECT geo, SUM(gwh) OVER (PARTITION BY geo) AS v FROM t", ratioDecl, "window total per region", /sum or a count/);
fails("SELECT geo, COUNT(*) OVER () AS v FROM t", ratioDecl, "window count over everything", /sum or a count/);
fails("SELECT geo, count_if(gwh > 0) AS v FROM t GROUP BY geo", ratioDecl, "count_if is a count", /sum or a count/);
passes("WITH r AS (SELECT geo, SUM(x) AS pop FROM t GROUP BY geo) SELECT t.geo, t.x / t.pop AS v FROM t JOIN r USING (geo)", ratioDecl, "a qualified base column is not shadowed by a CTE alias");
passes("SELECT geo, x / FIRST_VALUE(x) OVER (PARTITION BY yr ORDER BY geo) AS v FROM t", ratioDecl, "FIRST_VALUE reads another row");
// K987: averages, medians and indexes are legitimate choropleth values, not totals.
const meanDecl = (extra = {}) => spec(sem({ measure_kind: "mean", unit: "°C", denominator: "observations", ...extra }));
passes("SELECT geo, AVG(temp) AS v FROM t GROUP BY geo", meanDecl(), "AVG of a column declared mean");
passes("SELECT geo, SUM(x) / COUNT(*) AS v FROM t GROUP BY geo", meanDecl(), "grouped SUM / COUNT(*) declared mean");
passes("SELECT geo, SUM(x) / COUNT(y) AS v FROM t GROUP BY geo", meanDecl(), "grouped SUM / COUNT(y) declared mean");
passes("SELECT geo, median(mag) AS v FROM t GROUP BY geo", meanDecl({ measure_kind: "median" }), "median declared median");
passes("SELECT geo, quantile_cont(mag, 0.5) AS v FROM t GROUP BY geo", meanDecl({ measure_kind: "median" }), "quantile_cont declared median");
passes("SELECT geo, temp AS v FROM t", meanDecl(), "a plain column declared mean");
for (const unit of ["价格指数", "CPI index", "2015=100", "score", "评分"]) passes("SELECT geo, v FROM t", spec(sem({ measure_kind: "index", unit, denominator: "2015 = 100" })), `index unit ${unit}`);
fails("SELECT geo, AVG(temp) AS v FROM t GROUP BY geo", meanDecl({ measure_kind: "flow" }), "AVG declared a flow", /not shown to be a ratio/);
fails("SELECT geo, AVG(temp) AS v FROM t GROUP BY geo", meanDecl({ denominator: "" }), "mean without what it is averaged over", /naming what the value is averaged over/);
fails("SELECT geo, AVG(temp) AS v FROM t GROUP BY geo", spec({ measure_semantics: [{ field: "v", measure_kind: "mean", denominator: "observations", unit: "" }] }), "mean without a unit", /unit/);
fails("SELECT geo, median(mag) AS v FROM t GROUP BY geo", meanDecl({ measure_kind: "median", denominator: "" }), "median without what it is averaged over", /naming what the value is averaged over/);
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "index", unit: "指数", denominator: "" })), "index without a base", /base of the index/);
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "index", unit: "PJ", denominator: "2015 = 100" })), "index with a unit that is not an index word", /index or a score/);
fails("SELECT geo, SUM(x) / COUNT(*) AS v FROM t GROUP BY geo", ratioDecl, "grouped SUM / COUNT declared rate", /average per region/);
fails("SELECT geo, SUM(x) / COUNT(*) AS v FROM t GROUP BY geo", spec(sem({ measure_kind: "count", unit: "x" })), "grouped SUM / COUNT declared a count", /average per region/);
fails("SELECT geo, AVG(temp) AS v FROM t GROUP BY geo", meanDecl({ measure_kind: "median" }), "AVG declared median", /computed as a mean/);
fails("SELECT geo, median(mag) AS v FROM t GROUP BY geo", meanDecl(), "median declared mean", /computed as a median/);
// What a mean declaration never rescues: a total, a constant divisor, a total over the whole table, the column divided by itself, a window.
fails("SELECT geo, SUM(x) AS v FROM t GROUP BY geo", meanDecl(), "SUM declared mean", /sum or a count/);
fails("SELECT geo, x / 1000.0 AS v FROM t", meanDecl(), "constant divisor declared mean", /does not differ by region/);
fails("SELECT geo, x / x AS v FROM t", spec(sem({ measure_kind: "index", unit: "指数", denominator: "2015 = 100" })), "self-division declared index", /does not differ by region/);
fails("SELECT geo, SUM(x) / COUNT(*) AS v FROM t", meanDecl(), "SUM / COUNT over the whole table (no GROUP BY)", /does not differ by region/);
fails("WITH tot AS (SELECT SUM(x) AS s FROM t) SELECT geo, tot.s / COUNT(*) AS v FROM t CROSS JOIN tot GROUP BY geo, tot.s", meanDecl(), "a whole-table total over a group count", /does not differ by region|sum or a count/);
fails("SELECT geo, SUM(x) OVER () / COUNT(*) AS v FROM t GROUP BY geo, x", meanDecl(), "a window total over a group count", /does not differ by region|sum or a count/);
fails("SELECT geo, SUM(x) / COUNT(*) OVER () AS v FROM t GROUP BY geo, x", meanDecl(), "a group sum over a window count", /does not differ by region|sum or a count/);
fails("SELECT geo, SUM(x) / COUNT(y) AS v FROM t GROUP BY geo", ratioDecl, "grouped SUM / COUNT(y) declared rate", /average per region/);
fails("SELECT geo, quantile_cont(mag, 0.5) AS v FROM t GROUP BY geo", meanDecl(), "quantile_cont declared mean", /computed as a median/);
fails("SELECT geo, (SUM(x) + SUM(y) OVER ()) / COUNT(*) AS v FROM t GROUP BY geo, y", meanDecl(), "a window total inside the numerator of a group mean", /does not differ by region|sum or a count/);
fails("WITH n AS (SELECT COUNT(*) AS c FROM t) SELECT geo, SUM(x) / c AS v FROM t, n GROUP BY geo, c", meanDecl(), "a whole-table COUNT(*) as divisor", /does not differ by region/);
fails("SELECT geo, deaths / population + gwh / 1000 AS v FROM t", ratioDecl, "a constant divisor next to a data division", /does not differ by region/);
passes("SELECT geo, SUM(x) / NULLIF(COUNT(*), 0) AS v FROM t GROUP BY geo", meanDecl(), "mean with NULLIF around the count");
fails("SELECT geo, favg(x) AS v FROM t GROUP BY geo", meanDecl({ measure_kind: "median" }), "favg declared median", /computed as a mean/);
fails("SELECT geo, approx_quantile(x, 0.5) AS v FROM t GROUP BY geo", meanDecl(), "approx_quantile declared mean", /computed as a median/);
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "index", unit: "PJ=100", denominator: "2015 = 100" })), "PJ=100 names no index", /index or a score/);
passes("SELECT geo, v FROM t", spec(sem({ measure_kind: "index", unit: "2015=100", denominator: "2015" })), "2015=100 names an index base");
passes("SELECT geo, v FROM t", spec(sem({ measure_kind: "index", unit: "價格指數", denominator: "2015 = 100" })), "traditional 指數");
fails("SELECT geo, SUM(x) / COUNT(*) + SUM(y) AS v FROM t GROUP BY geo", meanDecl(), "a mean plus a total", /sum or a count/);
// AVG, MEDIAN, MIN, MAX of a column are read as that column passing through: the three-part declaration decides.
passes("SELECT geo, AVG(rate) AS v FROM t GROUP BY geo", ratioDecl, "AVG of a rate column with the full declaration");
passes("SELECT geo, MAX(rate) AS v FROM t GROUP BY geo", ratioDecl, "MAX of a rate column with the full declaration");
fails("SELECT geo, AVG(rate) AS v FROM t GROUP BY geo", spec(sem({ measure_kind: "rate", unit: "%" })), "AVG without a denominator", /denominator/);
fails("SELECT geo, MEDIAN(x) AS v FROM t GROUP BY geo", spec(sem({ measure_kind: "count", unit: "deaths" })), "MEDIAN of a total", /not shown to be a ratio/);

// Mutation 1: a total with no division (the US state map, the old Germany crude pages).
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "count", unit: "deaths" })), "plain total", /not shown to be a ratio/);
// Mutation 2 (92 a): only a rate is reported, no denominator, unit names a ratio -> still refused; each of the three is needed alone.
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit: "%" })), "rate and unit but no denominator", /denominator/);
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "flow", unit: "%", denominator: "population" })), "denominator and unit but kind flow", /measure_kind/);
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit: "PJ", denominator: "population" })), "kind and denominator but a unit that is a total", /unit/);
fails("SELECT geo, v FROM t", spec(), "no measure_semantics at all");
// Mutation 3 (92 b): a constant divisor is a unit change, not normalization (the Germany gas world map: OBS_VALUE / 1000.0).
fails("SELECT geo, round(OBS_VALUE / 1000.0, 1) AS v FROM t", ratioDecl, "constant divisor");
fails("SELECT geo, x / (10000) AS v FROM t", ratioDecl, "constant divisor in parentheses");
fails("WITH k AS (SELECT geo, x, 1000.0 AS div FROM t) SELECT geo, x / div AS v FROM k", ratioDecl, "constant hidden in a CTE");
// Mutation 4 (92 b): the numerator column divided by itself, however it is dressed.
fails("SELECT geo, x / x AS v FROM t", ratioDecl, "a / a");
fails("SELECT geo, x / (1.0 * x) AS v FROM t", ratioDecl, "a / (1.0 * a) self-made divisor");
fails("SELECT geo, x / (x * 1) AS v FROM t", ratioDecl, "a / (a * 1)");
// Mutation 5 (92 round 2): a scalar total is one number for every region, so a share of the total still follows region size.
fails("SELECT geo, x / (SELECT SUM(x) FROM t) AS v FROM t", spec(sem({ measure_kind: "share", unit: "%", denominator: "total" })), "uncorrelated scalar subquery", /not shown to be a ratio|total/);
fails("WITH tot AS (SELECT SUM(x) AS total FROM t) SELECT geo, x / total AS v FROM t, tot", spec(sem({ measure_kind: "share", unit: "%", denominator: "total" })), "scalar total through a CTE");
fails("SELECT geo, x / SUM(x) OVER () AS v FROM t", spec(sem({ measure_kind: "share", unit: "%", denominator: "total" })), "window total over everything");
// A window or correlation keyed by something other than the region is still one number for every region of the map.
fails("SELECT geo, x / SUM(x) OVER (PARTITION BY yr) AS v FROM t", ratioDecl, "window partitioned by year");
fails("SELECT o.geo, o.x / (SELECT SUM(i.x) FROM t i WHERE i.yr = o.yr) AS v FROM t o", ratioDecl, "subquery correlated on year only");
fails("WITH k AS (SELECT geo, x, 1000.0 AS div FROM t) SELECT geo, x / CAST(div AS DOUBLE) AS v FROM k", ratioDecl, "constant under a CAST");
// Totals hidden in a derived table, a UNION, a grouped select, or the window of the value's own column.
fails("SELECT geo, v FROM (SELECT geo, x / 1000.0 AS v FROM t)", ratioDecl, "constant divisor inside a FROM subquery");
fails("SELECT geo, x / s.total AS v FROM t CROSS JOIN (SELECT SUM(x) AS total FROM t) s", ratioDecl, "scalar total from a FROM subquery");
fails("WITH tot AS (SELECT SUM(pop) AS p FROM t) SELECT t.geo, SUM(x) / tot.p AS v FROM t CROSS JOIN tot GROUP BY t.geo, tot.p", ratioDecl, "scalar CTE total under GROUP BY");
fails("SELECT o.geo, o.x / (SELECT SUM(i.x) FROM t i WHERE i.geo IS NOT NULL) AS v FROM t o", ratioDecl, "subquery with no link to the outer row");
fails("SELECT geo, x / 1000.0 AS v FROM t UNION ALL SELECT geo, x / 1000.0 AS v FROM u", ratioDecl, "constant divisor in a UNION (no single final SELECT)");
fails("SELECT geo, x // 1000 AS v FROM t", ratioDecl, "integer division by a constant");
for (const unit of ["人均", "占比", "‰", "元/人", "per capita", "%"]) passes("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit, denominator: "population" })), `unit ${unit}`);
// A unit with a bare 'per' or 每 is not a ratio to a population.
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit: "deaths per year", denominator: "years" })), "per year", /unit/);
fails("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit: "每年死亡人数", denominator: "年" })), "每年", /unit/);
passes("SELECT geo, v FROM t", spec(sem({ measure_kind: "rate", unit: "每10万人", denominator: "人口" })), "每10万人");
// A division is read from the SQL, and a declared total can only tighten.
fails("SELECT geo, x / pop AS v FROM t", spec(sem({ measure_kind: "count", unit: "people" })), "divides by data but declares a count", /declares measure_kind 'count'/);
// An unparsable statement falls back to the pass-through rule.
assert.equal(lintChoroplethNormalized(null, spec(sem({ measure_kind: "rate", unit: "%", denominator: "population" }))).length, 0, "no AST, full declaration passes");
assert.equal(lintChoroplethNormalized(null, spec(sem({ measure_kind: "count", unit: "deaths" }))).length, 1, "no AST, a total is refused");
// The value column that is not in the final SELECT is named in the refusal.
assert.match(refused("SELECT geo, w FROM t", spec(sem({ measure_kind: "count" })))[0], /was not found in the final SELECT/);
assert.match(refused("SELECT geo, v FROM t", spec(sem({ measure_kind: "count" })))[0], /derived tables in FROM/);
// With no value column found, a constant division anywhere in the statement is still refused.
fails("SELECT geo, w FROM t WHERE pop / 1000 > 5", ratioDecl, "no value expression and a constant division", /does not differ by region/);
// The refusal teaches both ways out.
const text = refused("SELECT geo, v FROM t", spec(sem({ measure_kind: "count" })))[0];
assert.match(text, /divisor is a data column that differs by region/);
assert.match(text, /horizontal_bar/);
console.log("test_choropleth_normalized: ok");
