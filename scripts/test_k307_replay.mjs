#!/usr/bin/env node
// K307: the offline replay of test_group_tools_replay.mjs (a Sankey and a choropleth through record_claim -> duckdb_query -> viz_lint -> viz_render on the real
// runtime/pi/newsroom.ts, synthetic data, real DuckDB, no provider, no network) with NEWSROOM_GROUP_CALL_REPORT on (the default) and, apart from it, with the group switches off.
// Required: the artifact tree is byte-identical to the off run except for runtime/cross-call-report.jsonl, which has records; the checker then lists the
// undeclared (tool group -> function) pairs this replay saw (printed, not asserted: that list is the finding, enforcement is a later step).
import "./group_env_pin.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { loadNewsroom, REPO } from "./precision_harness.mjs";
import { withoutRunTraces } from "./lib_run_traces.mjs";

const { getBasemap } = await import(join(REPO, "runtime/pi/basemap_registry.mjs"));
const { CHOROPLETH_BASEMAP_ID } = await import(join(REPO, "runtime/pi/choropleth.mjs"));
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const sankey = JSON.parse(readFileSync(join(REPO, "fixtures/complex/sankey.json"), "utf8"));
const SANKEY_CSV = `source,target,value\n${sankey.rows.map((row) => `${row.source},${row.target},${row.value}`).join("\n")}\n`;
const AFRICA_CSV = ["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0"].join("\n") + "\n";

// #64 step 1: HANDOFF and CALL_REPORT are on by default, so the "switches off" run pins both to "0"
const OFF0 = { NEWSROOM_GROUP_TOOLS: undefined, NEWSROOM_GROUP_ENFORCE: undefined, NEWSROOM_GROUP_HANDOFF: "0", NEWSROOM_GROUP_CALL_REPORT: "0", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };
const ON0 = { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_CALL_REPORT: "0", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };

const walk = (dir, out = new Map()) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out); else out.set(path, readFileSync(path));
  }
  return out;
};

async function replay(label, env) {
  const h = await loadNewsroom({ prefix: `group-replay-${label}-`, env });
  const svgs = {};
  const refused = [];
  const run = async (kind, csv, sqlColumns, spec) => {
    const data = h.addData(kind, csv);
    const sql = `SELECT ${sqlColumns} FROM read_csv_auto('${data}')`;
    const qa = await h.query(sql);
    const claim = await h.recordClaim(`${kind} replay claim`, [data], [qa]);
    const planRef = `visualizations/plans/${kind}.json`;
    writeFileSync(join(h.art, planRef), JSON.stringify({ ...spec, sql, claim_id: claim.claim_id, annotations: (spec.annotations ?? []).map((note) => ({ ...note, claim_id: claim.claim_id })) }));
    for (const step of ["lint", "render"]) {
      try {
        if (step === "lint") {
          const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
          svgs[`${kind}.lint`] = JSON.stringify(lint.details);
          h.lintRef = lint.details.lintRef;
          assert.equal(lint.details.passed, true, `${kind}: lint passed (${JSON.stringify(lint.details.blockers ?? lint.details.issues ?? "").slice(0, 200)})`);
        } else {
          const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: h.lintRef });
          svgs[`${kind}.manifest`] = render.details.manifestRef;
        }
      } catch (error) {
        if (/GROUP_TOOLS_REFUSED|boundary:/.test(String(error?.message))) refused.push(`${kind}.${step}: ${error.message}`);
        throw error;
      }
    }
  };
  await run("sankey", SANKEY_CSV, "source, target, value", { ...sankey.spec, sql: undefined });
  await run("map", AFRICA_CSV, "country, year, share", {
    schema_version: "0.9.0", reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries, darker meaning higher.",
    source_note: "synthetic fixture", unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share", category_names: "worldbank",
    reference_period_field: "year", mixed_period_strategy: "acknowledge", basemap_id: basemap.id, basemap_source_url: basemap.source_url,
    basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [],
  });
  const files = walk(h.art);
  const refusalLog = join(h.art, "runtime/boundary-refusals.jsonl");
  return { art: h.art, files, svgs, refused, refusalLog: existsSync(refusalLog) ? readFileSync(refusalLog, "utf8") : "" };
}


const OFF = { ...OFF0 };
const ON = { ...OFF0, NEWSROOM_GROUP_CALL_REPORT: "1" };
const off = await replay("off", OFF);
const on = await replay("on", ON);
const REPORT = "runtime/cross-call-report.jsonl";
const byRel = (r) => new Map([...r.files].filter(([path]) => withoutRunTraces(r.art, [path], { chain: false, label: "replay" }).length).map(([path, bytes]) => {
  const name = relative(r.art, path);
  return [name, name === "claims.jsonl" ? Buffer.from(bytes.toString().replace(/"recorded_at":"[^"]*",?/g, "")) : bytes];
}));
const offTree = byRel(off), onTree = byRel(on);
assert.ok(!offTree.has(REPORT), "off: no report file");
assert.ok(onTree.has(REPORT), "on: the report file exists");
const onRest = new Map([...onTree].filter(([name]) => name !== REPORT));
const svgNames = [...offTree.keys()].filter((name) => name.endsWith(".svg"));
assert.ok(svgNames.length >= 2, `SVGs rendered: ${svgNames.length}`);
assert.deepEqual([...onRest.keys()], [...offTree.keys()], "same artifact tree apart from the report");
const different = [...offTree].filter(([name, bytes]) => !Buffer.from(bytes).equals(onRest.get(name))).map(([name]) => name);
assert.deepEqual(different, [], `every other file byte-identical: ${different.join(", ")}`);
assert.deepEqual(on.refused, [], "nothing refused");
const records = onTree.get(REPORT).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l));
assert.ok(records.length > 0, "the replay recorded calls");
const run = spawnSync(process.execPath, [join(REPO, "scripts/check_cross_call_report.mjs"), on.art], { encoding: "utf8" });
console.log(run.stdout.trim());
assert.ok(run.status === 0 || run.status === 1, `checker ran (exit ${run.status})`);
console.log(`k307 replay: ${offTree.size} files off == on (report aside), ${records.length} record(s), checker exit ${run.status} -- PASS`);
