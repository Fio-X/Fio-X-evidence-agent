#!/usr/bin/env node
// NEWSROOM_NEXT=1 (exact "1", default off): the entity column of the candidate SQL is named country_iso2 (Eurostat geo, every code an ISO 3166-1
// alpha-2 economy) or country_iso3 (World Bank, no aggregate row); everything else keeps `name`. With the switch off, or with no alias passed, the
// candidate specs are byte-identical to the base commit's. The design pack's sheet then names the codes on every chart of that column, and the
// chart checks (iso2 column name, zh name column) do not stop it. Offline: no network, no provider; DuckDB is not run.
// Usage: node scripts/test_next_entity_alias.mjs
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidates, ENTITY_ALIASES } from "../runtime/pi/claim_candidates.mjs";
import { runDesignPack } from "../runtime/pi/design_pack.mjs";
import { lintVizSpec } from "../runtime/pi/viz.mjs";

// The last commit that changed the no-alias specs on purpose: a ratio over a lowest at or below zero gives no ratio (on both routes).
const BASE = "d6488752d91bff966b205623da07e0471c7f10c4";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("next-entity-alias-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { nextEntityAlias } = mod.__dataPrepareForTest;
const base = spawnSync("git", ["show", `${BASE}:runtime/pi/claim_candidates.mjs`], { cwd: ROOT, encoding: "utf8" });
assert.equal(base.status, 0, `git show of the base claim_candidates.mjs failed: ${base.stderr}`);
writeFileSync(join(pi, "claim_candidates.base.mjs"), base.stdout);
const baseMod = await import(join(pi, "claim_candidates.base.mjs"));

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok ${name}`); };
const checkAsync = async (name, fn) => { await fn(); passed += 1; console.log(`ok ${name}`); };
const withNext = (on, fn) => {
  const before = process.env.NEWSROOM_NEXT;
  if (on) process.env.NEWSROOM_NEXT = "1"; else delete process.env.NEWSROOM_NEXT;
  try { return fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_NEXT; else process.env.NEWSROOM_NEXT = before; }
};

// ---- candidate SQL ----
const SPECS = [
  { ref: "data/a.csv", dimensions: ["geo"], measure: "OBS_VALUE", time: "TIME_PERIOD" },
  { ref: "data/a.csv", dimensions: ["geo"], measure: "OBS_VALUE" },
  { ref: "data/a.csv", dimensions: ["geo", "siec"], measure: "OBS_VALUE", time: "TIME_PERIOD" },
  { ref: "data/b.csv", dimensions: ["country"], measure: "value", time: "date" },
];
check("no alias: specs byte-identical to the base commit", () => {
  for (const spec of SPECS) assert.equal(JSON.stringify(buildCandidates(spec)), JSON.stringify(baseMod.buildCandidates(spec)), JSON.stringify(spec));
});
check("alias names the entity column in every slice, operator and template", () => {
  for (const alias of ENTITY_ALIASES) {
    const specs = buildCandidates({ ...SPECS[0], entity: alias });
    const text = JSON.stringify(specs);
    assert.ok(!/\bname\b/.test(text.replace(/"(kind|claim_kind)"/g, "")), `a 'name' is left: ${text.slice(0, 200)}`);
    for (const kind of ["rank_top", "rank_bottom", "share_of_total", "change_largest_rise", "change_largest_fall"]) assert.ok(specs.find((item) => item.kind === kind).template.startsWith(`{first.${alias}} `), kind);
    assert.ok(specs.find((item) => item.kind === "rank_top").sql.includes(`ORDER BY value DESC, ${alias} LIMIT 1`));
    assert.ok(specs.find((item) => item.kind === "share_of_total").sql.endsWith(`ORDER BY value DESC, ${alias} LIMIT 1`));
  }
});
check("an alias outside the list is refused", () => {
  assert.throws(() => buildCandidates({ ...SPECS[0], entity: "geo" }), /entity column must be one of country_iso2, country_iso3/);
  assert.throws(() => buildCandidates({ ...SPECS[0], entity: "name; DROP" }), /entity column must be one of/);
});
check("the claim filler takes a placeholder whose column name holds a digit", () => {
  const spec = buildCandidates({ ...SPECS[0], entity: "country_iso2" }).find((item) => item.kind === "rank_top");
  const out = mod.fillClaimTemplate(spec.template, [{ country_iso2: "DE", value: 12.5, year: 2023 }], ["value"]);
  assert.match(out.text, /^DE has the highest/);
});

// ---- the alias decision (interim evidence; classify replaces nextEntityAlias) ----
const wbHeader = ["country", "country_name", "region", "date", "value"];
const wb = (rows) => ({ provider: "worldbank", header: wbHeader, rows });
const es = (codes, header = ["DATAFLOW", "freq", "unit", "geo", "TIME_PERIOD", "OBS_VALUE"]) => ({ provider: "eurostat", header, rows: codes.map((code) => ["X", "A", "PC", code, "2023", "1"]) });
const EU = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];
check("switch off: always name", () => withNext(false, () => {
  assert.equal(nextEntityAlias(wb([["IND", "India", "South Asia", "2020", "1"]]), ["country"]), undefined);
  assert.equal(nextEntityAlias(es(EU), ["geo"]), undefined);
}));
check("World Bank countries -> country_iso3; any Aggregates row -> name", () => withNext(true, () => {
  assert.equal(nextEntityAlias(wb([["IND", "India", "South Asia", "2020", "1"], ["CHN", "China", "East Asia & Pacific", "2020", "2"]]), ["country"]), "country_iso3");
  assert.equal(nextEntityAlias(wb([["IND", "India", "South Asia", "2020", "1"], ["HIC", "High income", "Aggregates", "2020", "2"]]), ["country"]), undefined);
}));
check("Eurostat EU27 members, EL and all -> country_iso2", () => withNext(true, () => {
  assert.equal(nextEntityAlias(es(EU), ["geo"]), "country_iso2");
  assert.equal(nextEntityAlias(es(["UK", "NO", "CH"]), ["geo"]), "country_iso2");
}));
check("Eurostat NUTS regions, EU or euro-area aggregates -> name", () => withNext(true, () => {
  assert.equal(nextEntityAlias(es(["DE1", "DE2", "FR1"]), ["geo"]), undefined, "NUTS 1");
  assert.equal(nextEntityAlias(es(["DE11", "FR10"]), ["geo"]), undefined, "NUTS 2");
  assert.equal(nextEntityAlias(es([...EU, "EU27_2020"]), ["geo"]), undefined, "EU aggregate");
  assert.equal(nextEntityAlias(es(["EA20", "DE"]), ["geo"]), undefined, "euro area");
}));
check("two varying dimensions, or a dimension that is not the place one -> name", () => withNext(true, () => {
  assert.equal(nextEntityAlias(es(EU), ["geo", "siec"]), undefined);
  assert.equal(nextEntityAlias({ ...es(EU), header: ["DATAFLOW", "freq", "unit", "citizen", "TIME_PERIOD", "OBS_VALUE"] }, ["citizen"]), undefined);
  assert.equal(nextEntityAlias({ ...wb([["IND", "India", "South Asia", "2020", "1"]]), provider: "eurostat" }, ["country"]), undefined);
}));

// ---- design pack sheet and chart checks ----
const sheetOf = async (columns, rows, chartType) => {
  const deps = {
    pageBuild: true,
    sheetData: async () => [{ claim_id: "c1", verified: true, claim: "x", series: { sql: "SELECT 1", columns, rows } }],
    chartForm: async (need) => ({ ok: true, chart_type: chartType, relations: need.relations }),
    codeScheme: async () => "iso2",
  };
  const out = await runDesignPack(deps, { part: "sheet" }, {});
  assert.equal(out.status, "SHEET", JSON.stringify(out.problems));
  return out.sheet.charts[0];
};
const isoRows = EU.slice(0, 6).map((code, i) => ({ country_iso2: code, value: i + 1, year: 2023 }));
await checkAsync("sheet: country_iso2 column is the category and names the codes on a bar and on a map", async () => {
  for (const chartType of ["horizontal_bar", "choropleth"]) {
    const chart = await sheetOf(["country_iso2", "value", "year"], isoRows, chartType);
    assert.equal(chart.category_field, "country_iso2");
    assert.equal(chart.category_names, "iso2");
  }
  const wbChart = await sheetOf(["country_iso3", "value", "year"], [{ country_iso3: "IND", value: 1, year: 2020 }, { country_iso3: "CHN", value: 2, year: 2020 }], "horizontal_bar");
  assert.equal(wbChart.category_names, "iso3");
});
await checkAsync("sheet: a name column behaves as before (no names on a bar, codeScheme on a map)", async () => {
  const nameRows = isoRows.map(({ country_iso2, ...rest }) => ({ name: country_iso2, ...rest }));
  const bar = await sheetOf(["name", "value", "year"], nameRows, "horizontal_bar");
  assert.equal(bar.category_field, "name");
  assert.equal(bar.category_names, undefined);
  const map = await sheetOf(["name", "value", "year"], nameRows, "choropleth");
  assert.equal(map.category_names, "iso2");
});
const blockersOf = (field, language) => lintVizSpec({ chart_type: "horizontal_bar", claim_id: "c1", title: "t", category_field: field, value_field: "value", category_names: "iso2", language, data: { inline: [] } }, isoRows.map((row) => ({ [field]: row.country_iso2, value: row.value })), {}).blockers;
check("viz checks: country_iso2 passes the iso2 column-name and zh name checks; name is still stopped", () => {
  for (const language of ["en", "zh"]) {
    const named = blockersOf("country_iso2", language).filter((text) => /column name must say|rename the column|cannot resolve/.test(text));
    assert.deepEqual(named, [], `${language}: ${named.join(" | ")}`);
  }
  assert.ok(blockersOf("name", "en").some((text) => /column name must say/.test(text)), "the iso2 column-name check no longer stops `name`");
});

console.log(`PASS test_next_entity_alias: ${passed} checks`);
