#!/usr/bin/env node
// NEWSROOM_GROUP_TOOLS=1 (K213), offline replay of two real chart paths with synthetic data (no provider, no network, real DuckDB):
// a Sankey (fixtures/complex/sankey.json rows) and a choropleth map (11-row Africa table), each through
// record_claim -> duckdb_query -> newsroom_viz_lint -> newsroom_viz_render on the real, type-stripped runtime/pi/newsroom.ts.
// The same steps run with the switches off and with NEWSROOM_GROUP_TOOLS=1 + ENFORCE=1 + HANDOFF=1. Required: every SVG and the whole artifact tree are
// byte-identical between the two runs, and nothing is refused (no boundary-refusals.jsonl, no GROUP_TOOLS_REFUSED).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadNewsroom, REPO } from "./precision_harness.mjs";

const { getBasemap } = await import(join(REPO, "runtime/pi/basemap_registry.mjs"));
const { CHOROPLETH_BASEMAP_ID } = await import(join(REPO, "runtime/pi/choropleth.mjs"));
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const sankey = JSON.parse(readFileSync(join(REPO, "fixtures/complex/sankey.json"), "utf8"));
const SANKEY_CSV = `source,target,value\n${sankey.rows.map((row) => `${row.source},${row.target},${row.value}`).join("\n")}\n`;
const AFRICA_CSV = ["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0"].join("\n") + "\n";

const OFF = { NEWSROOM_GROUP_TOOLS: undefined, NEWSROOM_GROUP_ENFORCE: undefined, NEWSROOM_GROUP_HANDOFF: undefined, NEWSROOM_MOBILE_PAGES: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };
const ON = { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_MOBILE_PAGES: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };

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

const off = await replay("off", OFF);
const on = await replay("on", ON);

// The only normalization: record_claim stamps the wall clock into claims.jsonl (`recorded_at`); that field is dropped, every other byte is compared.
const byRel = (r) => new Map([...r.files].map(([path, bytes]) => {
  const name = relative(r.art, path);
  return [name, name === "claims.jsonl" ? Buffer.from(bytes.toString().replace(/"recorded_at":"[^"]*",?/g, "")) : bytes];
}));
const offTree = byRel(off), onTree = byRel(on);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const svgNames = [...offTree.keys()].filter((name) => name.endsWith(".svg"));
assert.ok(svgNames.some((name) => /sankey|visualizations\//.test(name)) && svgNames.length >= 4, `SVGs rendered: ${svgNames.length}`);
assert.deepEqual([...onTree.keys()], [...offTree.keys()], "same artifact tree (file names)");
const different = [...offTree].filter(([name, bytes]) => !Buffer.from(bytes).equals(onTree.get(name))).map(([name]) => name);
assert.deepEqual(different, [], `every file byte-identical between off and on: ${different.join(", ")}`);
for (const name of svgNames) assert.equal(sha(offTree.get(name)), sha(onTree.get(name)), `${name} byte-identical`);
assert.deepEqual(on.refused, [], "no refusal thrown with the switch on");
assert.equal(on.refusalLog, "", "boundary-refusals.jsonl is empty or absent with the switch on");
assert.equal(off.refusalLog, "", "and with it off");
console.log(`group tools replay: sankey + choropleth, ${offTree.size} files, ${svgNames.length} SVG, off == on byte for byte, 0 refused -- PASS`);
