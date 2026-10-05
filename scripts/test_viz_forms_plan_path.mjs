// Drives the real newsroom_viz_plan handler (as test_viz_plan_inset_param.mjs does: a typed-stripped temporary copy of runtime/,
// inert Pi stubs) for the strip_plot / stacked_bar_100 / mirrored_bar fields the plan path wires, then renders the recorded spec.
//
//   1. stacked_bar_100 records sort 'desc' by default (an explicit sort is kept); other types keep the row order.
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

async function harness() {
  const tmp = mkdtempSync(join(tmpdir(), "viz-forms-plan-"));
  execFileSync("cp", ["-R", join(ROOT, "runtime"), join(tmp, "runtime")]);
  execFileSync("cp", ["-R", join(ROOT, "config"), join(tmp, "config")]);
  stub(tmp, "typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub(tmp, "@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  const art = mkdtempSync(join(tmpdir(), "viz-forms-plan-artifact-"));
  for (const dir of ["visualizations/plans", "visualizations/lints", "computations"]) mkdirSync(join(art, dir), { recursive: true });
  execFileSync("cp", ["-R", join(ROOT, "config"), join(art, "config")]);
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({
    claim_id: "claim-forms-fixture", status: "verified", source_refs: ["sources/fixture.json"],
    verification: { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true },
  })}\n`);
  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  return { tools, art };
}

const { tools, art } = await harness();
const plan = tools.get("newsroom_viz_plan");
assert.ok(plan, "newsroom_viz_plan must register");
const recorded = async (params) => JSON.parse(readFileSync(join(art, (await plan.execute("t", params)).details.planRef), "utf8"));

// reader_task is one of the tasks that need no measure_semantics/claim_spec declaration (this test is about the plan fields, not that gate).
// Three entities, three segments; the highlight segment A is largest in the LAST row, so the default order is visibly not row order.
const TABLE = [["Low", { A: 10, B: 50, C: 40 }], ["Mid", { A: 40, B: 30, C: 30 }], ["High", { A: 70, B: 20, C: 10 }]];
const rows = TABLE.flatMap(([c, parts]) => Object.entries(parts).map(([s, v]) => ({ c, s, v })));
const sql = `SELECT * FROM (VALUES ${rows.map((r) => `('${r.c}', '${r.s}', ${r.v})`).join(", ")}) AS t("c", "s", "v")`;
const stacked = (extra = {}) => ({
  reader_task: "hierarchy", title: "Shares by entity", alt: "A stacked bar chart of synthetic shares by segment for each entity.",
  source_note: "Synthetic", claim_id: "claim-forms-fixture", sql, unit: "%", chart_type: "stacked_bar_100",
  category_field: "c", series_field: "s", value_field: "v", segment_order: ["A", "B", "C"], sort_segment: "A", highlight_segment: "A",
  highlight_values: [], annotations: [], ...extra,
});
