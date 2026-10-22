// NEWSROOM_STATIC_SVG_REF_CHECK (default off, exact "1"): newsroom_publication_plan refuses a static_svg module that carries both computation_ref and
// asset_ref. Off, the plan accepts it (the computation branch wins and never sets resolved_svg) and newsroom_publication_render refuses it later with
// "is not SVG"; both are driven through the real tools and the off texts are written out below. On: the plan refuses with the new text; with
// NEWSROOM_SPEED_PUBLICATION_REPORT_ALL=1 the refusal sits in the same batch as other plan problems, off it is the first module's refusal.
// Modules with only asset_ref, or with only computation_ref, are unchanged by the switch. Mutations (each red): switch reversed, the check also
// refuses asset_ref alone, it ignores asset_ref, it leaves the report-all batch. Offline; no model, no network.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashRows } from "../runtime/pi/viz.mjs";

process.setMaxListeners(60);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const SWITCH = "NEWSROOM_STATIC_SVG_REF_CHECK";
const REPORT_ALL = "NEWSROOM_SPEED_PUBLICATION_REPORT_ALL";
const RENDER_OFF = "static SVG c1 is not SVG";
const NEW_C1 = "Publication module 'c1' is a static_svg module with both computation_ref and asset_ref; a static_svg module takes only asset_ref (the SVG file itself). Put the numbers the picture shows into verified claims and list them in claim_ids. Do not keep only computation_ref instead: a static_svg module requires asset_ref.";
const swap = (from, to) => (s) => { assert.ok(s.includes(from), `fixture text missing: ${from}`); return s.replace(from, to); };

async function build(label, edit) {
  const tmp = makeTestTmp(`static-svg-check-${label}-`);
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  let source = readFileSync(join(pi, "newsroom.ts"), "utf8");
  const header = "async function assertApprovedInfographicLineage(infographicPlanRef: string): Promise<void> {";
  source = swap(header, `${header} return; }\nasync function __lineageUnused(infographicPlanRef: string): Promise<void> {`)(source);
  if (edit) source = edit(source);
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(source, { mode: "strip" }));

  const art = join(tmp, "artifact");
  for (const dir of ["infographics/plans", "visualizations", "computations", "editorial/story-graphs", "config"]) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  for (const name of ["NEWSROOM_PUBLICATION_EMBED_PAGE", "NEWSROOM_PUBLICATION_STYLE_COMPAT", "NEWSROOM_FIRST_TRY_PUBLISH", "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED"]) delete process.env[name];

  const readerQuestion = "What does the fixture show?";
  const visualThesis = "The fixture shows one bound page.";
  const storyGraphRef = "editorial/story-graphs/g.json";
  writeFileSync(join(art, storyGraphRef), JSON.stringify({ passed: true, reader_question: readerQuestion, visual_thesis: visualThesis, nodes: [{ id: "n1" }, { id: "n2" }] }));
  const planRef = "infographics/plans/p.json";
  writeFileSync(join(art, planRef), JSON.stringify({ story_graph_ref: storyGraphRef, reader_question: readerQuestion, visual_thesis: visualThesis, modules: [] }));
  const rows = [{ country: "A", value: 1 }, { country: "B", value: 2 }];
  const computationRef = "computations/c1.json";
  writeFileSync(join(art, computationRef), JSON.stringify({ rows, result_hash: hashRows(rows) }));
  const verification = { authority: "system", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true, rule_id: "verification.source+extraction+computation+claim.v1" };
  writeFileSync(join(art, "claims.jsonl"), JSON.stringify({ claim_id: "claim-a", status: "verified", source_refs: [], computation_refs: [computationRef], verification }) + "\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 600" width="1440" height="600"><title>A chart</title><rect width="1440" height="600" fill="#fffdf9"/><text x="40" y="60" font-size="28" fill="#1d2329">A chart</text></svg>\n`;
  const chartRef = `visualizations/${sha256("chart")}.svg`;
  writeFileSync(join(art, chartRef), svg);

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  (await import(`${pathToFileURL(join(pi, "newsroom.test-copy.mjs")).href}?t=${Math.random()}`)).default(piApi);
  const plan = tools.get("newsroom_publication_plan");
  const render = tools.get("newsroom_publication_render");
  const base = { story_graph_ref: storyGraphRef, reader_question: readerQuestion, visual_thesis: visualThesis, title: "Fixture page", dek: "A fixture.", infographic_plan_ref: planRef };
  const mod = (id, extra = {}) => ({ id, type: "static_svg", story_node_ids: ["n1"], explanatory_dimension: "trend", claim_ids: ["claim-a"], title: "A chart", accessibility_summary: "A chart.", accessibility_long_description: "A chart of one series.", ...extra });
  const run = (modules, extra = {}) => plan.execute("t", { ...base, ...extra, modules });
  const outcome = async (modules, extra) => {
    try { const result = await run(modules, extra); return { planned: result.details.planRef }; } catch (error) { return { refused: String(error.message) }; }
  };
  const renderOutcome = async (planRef) => { try { await render.execute("r", { plan_ref: planRef }); return { rendered: true }; } catch (error) { return { refused: String(error.message) }; } };
  return { mod, outcome, renderOutcome, chartRef, computationRef };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

// Every observation the cells below compare, under one switch / report-all setting.
async function observe(label, env, edit) {
  const t = await build(label, edit);
  return withEnv(env, async () => {
    const companion = t.mod("c0", { asset_ref: t.chartRef, story_node_ids: ["n2"], explanatory_dimension: "context" });
    const both = t.mod("c1", { asset_ref: t.chartRef, computation_ref: t.computationRef });
    const assetOnly = t.mod("c1", { asset_ref: t.chartRef });
    const computationOnly = t.mod("c1", { computation_ref: t.computationRef });
    const secondBad = t.mod("c2", { asset_ref: t.chartRef, story_node_ids: ["nX"], explanatory_dimension: "context" });
    const seen = {};
    seen.both = await t.outcome([companion, both]);
    seen.bothRender = seen.both.planned ? await t.renderOutcome(seen.both.planned) : null;
    seen.assetOnly = await t.outcome([companion, assetOnly]);
    seen.assetRender = seen.assetOnly.planned ? await t.renderOutcome(seen.assetOnly.planned) : null;
    seen.computationOnly = await t.outcome([companion, computationOnly]);
    seen.batch = await t.outcome([companion, both, secondBad]);
    seen.otherFirst = await t.outcome([companion, secondBad, both]);
    return seen;
  });
}
const OFF = { [SWITCH]: undefined, [REPORT_ALL]: undefined };
const ON = { [SWITCH]: "1", [REPORT_ALL]: undefined };
const ON_ALL = { [SWITCH]: "1", [REPORT_ALL]: "1" };
const UNKNOWN_C2 = "Publication module 'c2' references unknown StoryGraph node 'nX'";
const ASSET_REQUIRED = "PublicationSpec blocked: modules[1].asset_ref required for static_svg";
const alsoRefused = (other) => `\nAlso refused in this call (1 more independent problem; nothing was recorded):\n(2) ${other}`;

function expectOff(seen, why) {
  assert.ok(seen.both.planned, `${why}: plan accepts both references: ${JSON.stringify(seen.both)}`);
  assert.deepEqual(seen.bothRender, { refused: RENDER_OFF }, `${why}: the render refuses it later with the unchanged text`);
  assert.ok(seen.assetOnly.planned, `${why}: asset_ref alone plans`);
  assert.deepEqual(seen.assetRender, { rendered: true }, `${why}: asset_ref alone renders`);
  assert.deepEqual(seen.computationOnly, { refused: ASSET_REQUIRED }, `${why}: computation_ref alone keeps its old refusal`);
  assert.deepEqual(seen.batch, { refused: UNKNOWN_C2 }, `${why}: only the other plan problem is reported`);
  assert.deepEqual(seen.otherFirst, { refused: UNKNOWN_C2 }, `${why}: same with the order swapped`);
}
function expectOn(seen, all, why) {
  assert.deepEqual(seen.both, { refused: NEW_C1 }, `${why}: both references refused at plan time`);
  assert.equal(seen.bothRender, null, `${why}: nothing to render`);
  assert.ok(seen.assetOnly.planned, `${why}: asset_ref alone still plans`);
  assert.deepEqual(seen.assetRender, { rendered: true }, `${why}: asset_ref alone still renders`);
  assert.deepEqual(seen.computationOnly, { refused: ASSET_REQUIRED }, `${why}: computation_ref alone is not touched`);
  if (all) {
    assert.deepEqual(seen.batch, { refused: NEW_C1 + alsoRefused(UNKNOWN_C2) }, `${why}: both problems in one batch`);
    assert.deepEqual(seen.otherFirst, { refused: UNKNOWN_C2 + alsoRefused(NEW_C1) }, `${why}: both problems in one batch, order swapped`);
  } else {
    assert.deepEqual(seen.batch, { refused: NEW_C1 }, `${why}: the first failing module throws alone`);
    assert.deepEqual(seen.otherFirst, { refused: UNKNOWN_C2 }, `${why}: the first failing module throws alone, order swapped`);
  }
}

const off = await observe("off", OFF);
expectOff(off, "switch unset");
for (const value of ["true", "0", "", "yes", " 1", "1 "]) expectOff(await observe("v", { [SWITCH]: value, [REPORT_ALL]: undefined }), `switch=${JSON.stringify(value)}`);
expectOff(await observe("offall", { [SWITCH]: undefined, [REPORT_ALL]: "1" }), "switch unset, report-all on");
expectOn(await observe("on", ON), false, "switch on");
expectOn(await observe("onall", ON_ALL), true, "switch on, report-all on");
console.log("PASS cells: switch off (and true/0/empty/yes/padded) leaves plan and render texts unchanged; on refuses at plan time; report-all batches it");

const check = 'attempt(() => { if (module.type === "static_svg" && module.computation_ref && module.asset_ref) throw';
const mutants = {
  "switch reversed": [swap('process.env.NEWSROOM_STATIC_SVG_REF_CHECK === "1") attempt', 'process.env.NEWSROOM_STATIC_SVG_REF_CHECK !== "1") attempt'), OFF, expectOff],
  "refuses asset_ref alone": [swap(check, 'attempt(() => { if (module.type === "static_svg" && module.asset_ref) throw'), ON, (seen) => expectOn(seen, false, "mutant")],
  "ignores asset_ref": [swap(check, 'attempt(() => { if (module.type === "static_svg" && module.computation_ref) throw'), ON, (seen) => expectOn(seen, false, "mutant")],
  "leaves the report-all batch": [swap(check, '(() => { if (module.type === "static_svg" && module.computation_ref && module.asset_ref) throw'), ON_ALL, (seen) => expectOn(seen, true, "mutant")],
  "switch read as any value": [swap('process.env.NEWSROOM_STATIC_SVG_REF_CHECK === "1") attempt', 'process.env.NEWSROOM_STATIC_SVG_REF_CHECK) attempt'), { [SWITCH]: "0", [REPORT_ALL]: undefined }, expectOff],
};
for (const [name, [edit, env, expect]] of Object.entries(mutants)) {
  let red = false;
  try { expect(await observe("mut", env, edit)); } catch { red = true; }
  assert.ok(red, `mutant stayed green: ${name}`);
  console.log(`mutant red: ${name}`);
}
console.log("test_static_svg_plan_check PASS");
