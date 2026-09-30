// Ledger item R8: newsroom_viz_plan's TypeBox parameters gain an optional
// `inset` field so a normal tool call can request the choropleth zoom inset
// that runtime/pi/viz.mjs has fully implemented since 247d83b (validator
// around line 1427, renderer around line 5021) but that newsroom_viz_plan
// had no way to pass through - only the unrelated `locator_inset: boolean`
// was declared.
//
// This drives the real newsroom_viz_plan (and, for the render assertion,
// newsroom_viz_lint/newsroom_viz_render) tool handlers exactly the way
// scripts/test_render_qa_tool_path.mjs does: runtime/pi/newsroom.ts is
// loaded from a temporary copy with its TypeScript types stripped and its
// two Pi package imports replaced by inert stubs, so this exercises the
// tool path, not just viz.mjs's validator/renderer directly.
//
// Three properties are checked:
//   1. `inset` reaches the written plan spec unchanged and the resulting
//      render contains the inset panel (`data-role="choropleth-inset"`).
//   2. An invalid inset shape is rejected by viz.mjs's own validator - this
//      test declares no shape rules of its own, so it must see viz.mjs's
//      exact error text, not some other message.
//   3. Omitting `inset` produces a plan byte-identical to the one the
//      pre-change newsroom.ts (read from git HEAD) would have produced for
//      the same call - i.e. existing plans/plan hashes are unaffected.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function stub(dir, name, source) {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
}

// Builds one temporary, importable copy of runtime/ around a given source
// text for newsroom.ts (either the working tree's or git HEAD's), wired up
// exactly like test_render_qa_tool_path.mjs's harness, and returns its
// registered tools plus the artifact root they write into.
async function harness(newsroomSource, { artifactDir } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "viz-plan-inset-"));
  execFileSync("cp", ["-R", join(ROOT, "runtime"), join(tmp, "runtime")]);
  execFileSync("cp", ["-R", join(ROOT, "config"), join(tmp, "config")]);
  stub(tmp, "typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub(tmp, "@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(newsroomSource, { mode: "strip" }));

  const art = artifactDir ?? mkdtempSync(join(tmpdir(), "viz-plan-inset-artifact-"));
  for (const dir of ["visualizations/plans", "visualizations/lints", "computations"]) mkdirSync(join(art, dir), { recursive: true });
  execFileSync("cp", ["-R", join(ROOT, "config"), join(art, "config")]);
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";

  // A fixture claim record shaped exactly like isSystemVerifiedClaim/
  // requireVerifiedClaim (runtime/pi/evidence_gate.mjs) require, so
  // newsroom_viz_plan's own requireVerifiedClaim call accepts claim_id
  // below - the same kind of fixed, hand-authored fixture input every other
  // test_*.mjs in this suite (e.g. test_render_qa_tool_path.mjs's writeLint)
  // supplies for a gate it is not itself testing.
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
    claim_id: "claim-choropleth-fixture",
    status: "verified",
    source_refs: ["sources/fixture.json"],
    verification: {
      authority: "system",
      rule_id: "verification.source+extraction+computation+claim.v1",
      source_resolved: true,
      extraction_passed: true,
      computation_replayed: true,
      claim_supported: true,
      publishable: true,
    },
  })}\n`);

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  return { tools, art };
}

const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const { CHOROPLETH_BASEMAP_ID } = await import(join(ROOT, "runtime/pi/choropleth.mjs"));
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);

// The same 11-country Africa fixture scripts/test_choropleth.mjs uses.
const AFRICA_ROWS = [
  { country: "Chad", year: 2022, renewable_energy_consumption_pct: 70.0 },
  { country: "Congo, Dem. Rep.", year: 2021, renewable_energy_consumption_pct: 96.3 },
  { country: "Congo, Rep.", year: 2021, renewable_energy_consumption_pct: 71.4 },
  { country: "Guinea", year: 2022, renewable_energy_consumption_pct: 66.6 },
  { country: "Liberia", year: 2022, renewable_energy_consumption_pct: 92.8 },
  { country: "Mauritania", year: 2022, renewable_energy_consumption_pct: 19.6 },
  { country: "Niger", year: 2021, renewable_energy_consumption_pct: 79.6 },
  { country: "Nigeria", year: 2021, renewable_energy_consumption_pct: 80.3 },
  { country: "Sierra Leone", year: 2022, renewable_energy_consumption_pct: 71.6 },
  { country: "South Sudan", year: 2021, renewable_energy_consumption_pct: 32.4 },
  { country: "Zambia", year: 2021, renewable_energy_consumption_pct: 83.0 },
];
const columns = Object.keys(AFRICA_ROWS[0]);
const literal = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sql = `SELECT * FROM (VALUES ${AFRICA_ROWS.map((r) => `(${columns.map((c) => literal(r[c])).join(", ")})`).join(", ")}) AS t(${columns.map((c) => `"${c}"`).join(", ")})`;

function planParams(extra = {}) {
  return {
    reader_task: "spatial",
    title: "Renewable energy consumption share",
    alt: "A choropleth map of renewable energy's share of final energy consumption across several African countries, darker meaning a higher share.",
    source_note: "World Bank fixture, indicator EG.FEC.RNEW.ZS",
    claim_id: "claim-choropleth-fixture",
    sql,
    unit: "%",
    chart_type: "choropleth",
    category_field: "country",
    value_field: "renewable_energy_consumption_pct",
    category_names: "worldbank",
    reference_period_field: "year",
    mixed_period_strategy: "acknowledge",
    basemap_id: basemap.id,
    basemap_source_url: basemap.source_url,
    basemap_license: basemap.license,
    basemap_content_hash: basemap.content_hash,
    highlight_values: [],
    annotations: [],
    ...extra,
  };
}

// --- 3. Omitting `inset` must not change the plan at all -------------------
// Compare the current (working-tree) newsroom.ts against the last committed
// (git HEAD) newsroom.ts for the exact same call with no `inset` field.
{
  const headSource = execFileSync("git", ["show", "HEAD:runtime/pi/newsroom.ts"], { cwd: ROOT, encoding: "utf8" });
  const currentSource = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");

  const before = await harness(headSource);
  const beforePlan = await before.tools.get("newsroom_viz_plan").execute("before", planParams());
  const beforeRef = beforePlan.details.planRef;
  const beforeSpec = readFileSync(join(before.art, beforeRef), "utf8");

  const after = await harness(currentSource);
  const afterPlan = await after.tools.get("newsroom_viz_plan").execute("after", planParams());
  const afterRef = afterPlan.details.planRef;
  const afterSpec = readFileSync(join(after.art, afterRef), "utf8");

  assert.equal(afterRef, beforeRef, "the plan path (content_hash) must be unchanged when inset is omitted");
  assert.equal(afterSpec, beforeSpec, "the plan bytes must be unchanged when inset is omitted");
  assert.ok(!afterSpec.includes('"inset"'), "no inset key should appear in a plan that never set one");
  console.log("omitting inset yields a byte-identical plan to the pre-change tool -- PASS");
}

// --- 1 & 2: use the current newsroom.ts for the rest of this file ----------
const currentSource = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const { tools, art } = await harness(currentSource);
const plan = tools.get("newsroom_viz_plan");
const lint = tools.get("newsroom_viz_lint");
const render = tools.get("newsroom_viz_render");
assert.ok(plan && lint && render, "newsroom_viz_plan/newsroom_viz_lint/newsroom_viz_render must register");

// --- 2. An invalid inset shape is rejected by viz.mjs's own validator ------
await assert.rejects(
  () => plan.execute("bad-inset", planParams({ inset: { iso3: ["TCD"], auto: true } })),
  /choropleth inset must set either iso3 or auto, not both/,
  "an inset with both iso3 and auto must be rejected with viz.mjs's own validator message",
);
console.log("an invalid inset shape is rejected by viz.mjs's existing validator -- PASS");

// --- 1. inset reaches the spec, and the render contains the inset panel ---
const withInset = await plan.execute("with-inset", planParams({ inset: { auto: true } }));
const planRef = withInset.details.planRef;
const spec = JSON.parse(readFileSync(join(art, planRef), "utf8"));
assert.deepEqual(spec.inset, { auto: true }, "the plan spec must carry inset unchanged");

const lintResult = await lint.execute("lint-inset", { plan_ref: planRef });
assert.ok(lintResult.details.passed, `lint must pass: ${lintResult.details.blockers.join(" | ")}`);
const rendered = await render.execute("render-inset", { plan_ref: planRef, lint_ref: lintResult.details.lintRef });
assert.ok(rendered.details.manifestRef, `render must pass QA: ${rendered.content[0].text}`);
const manifest = JSON.parse(readFileSync(join(art, rendered.details.manifestRef), "utf8"));
const svg = readFileSync(join(art, manifest.variants.desktop), "utf8");
assert.match(svg, /<g data-role="choropleth-inset">/, "the rendered SVG must contain the zoom inset panel");
console.log("inset reaches the plan spec and the render contains the inset panel -- PASS");
