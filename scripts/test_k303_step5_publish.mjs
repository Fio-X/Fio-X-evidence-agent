#!/usr/bin/env node
// K303 step 5: NEWSROOM_FIRST_TRY_PUBLISH=1 (exact "1", default off) adds text to two publication refusals: the bound visual_thesis, and every module that lacks
// accessibility fields. Driven through the real newsroom_publication_plan (setup as in test_publication_embed_page.mjs). Off: the refusals are byte for byte.
// Run: node scripts/test_k303_step5_publish.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "k303-publish-"));
try {
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
  assert.ok(source.includes(header), "the lineage gate moved: update this test");
  source = source.replace(header, `${header} (globalThis.__LINEAGE_CALLS__ ??= []).push(infographicPlanRef); if (globalThis.__LINEAGE_FAIL__) throw new Error("lineage forced fail"); return; }\nasync function __lineageUnused(infographicPlanRef: string): Promise<void> {`);
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(source, { mode: "strip" }));

  const art = join(tmp, "artifact");
  for (const dir of ["infographics/plans", "visualizations", "editorial/story-graphs", "config"]) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  for (const name of ["NEWSROOM_PUBLICATION_EMBED_PAGE", "NEWSROOM_PUBLICATION_STYLE_COMPAT", "NEWSROOM_FIRST_TRY_PUBLISH", "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED"]) delete process.env[name];

  const readerQuestion = "What does the fixture show?";
  const visualThesis = "The fixture shows one bound page.";
  const storyGraphRef = "editorial/story-graphs/g.json";
  writeFileSync(join(art, storyGraphRef), JSON.stringify({ passed: true, reader_question: readerQuestion, visual_thesis: visualThesis, nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }] }));
  const planRef = "infographics/plans/p.json";
  const otherPlanRef = "infographics/plans/q.json";
  for (const ref of [planRef, otherPlanRef]) writeFileSync(join(art, ref), JSON.stringify({ story_graph_ref: storyGraphRef, reader_question: readerQuestion, visual_thesis: visualThesis, modules: [] }));

  const verification = { authority: "system", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true, rule_id: "verification.source+extraction+computation+claim.v1" };
  const claims = ["claim-a", "claim-b", "claim-typed"];
  writeFileSync(join(art, "claims.jsonl"), claims.map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: [], computation_refs: [], verification })).join("\n") + "\n");

  const svgText = (title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 600" width="1440" height="600"><title>${title}</title><rect width="1440" height="600" fill="#fffdf9"/><text x="40" y="60" font-size="28" fill="#1d2329">${title}</text></svg>\n`;
  const pageTitle = "Composed page title";
  const pageSvg = svgText(pageTitle);
  const pageKey = sha256("page");
  const pageRef = `infographics/${pageKey}.svg`;
  writeFileSync(join(art, pageRef), pageSvg);
  const writeManifest = (key, plan_ref, svgRef, extra = {}) => writeFileSync(join(art, `infographics/${key}.json`), JSON.stringify({ plan_ref, variants: { desktop: svgRef }, claim_ids: ["claim-a", "claim-b"], title: pageTitle, visual_review_required: true, ...extra }));
  writeManifest(pageKey, planRef, pageRef);
  // a second page rendered from another plan, and one whose manifest names a different svg
  const otherKey = sha256("other");
  writeFileSync(join(art, `infographics/${otherKey}.svg`), svgText("Other"));
  writeManifest(otherKey, otherPlanRef, `infographics/${otherKey}.svg`);
  const strayKey = sha256("stray");
  writeFileSync(join(art, `infographics/${strayKey}.svg`), svgText("Stray"));
  const chartSvg = svgText("A single chart");
  const chartRef = `visualizations/${sha256("chart")}.svg`;
  writeFileSync(join(art, chartRef), chartSvg);

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  const plan = tools.get("newsroom_publication_plan");
  const render = tools.get("newsroom_publication_render");
  assert.ok(plan && render, "publication tools must register");

  const base = { story_graph_ref: storyGraphRef, reader_question: readerQuestion, visual_thesis: visualThesis, title: "Fixture page", dek: "A fixture." };
  const text = (id, node, dimension) => ({ id, type: "text", story_node_ids: [node], explanatory_dimension: dimension, text: `Body ${id}.` });
  const visual = (id, asset_ref, extra = {}) => ({ id, type: "static_svg", story_node_ids: ["n1"], explanatory_dimension: "trend", asset_ref, claim_ids: ["claim-a"], accessibility_summary: "A chart.", accessibility_long_description: "A chart of the fixture.", ...extra });
  const pageModule = (extra = {}) => visual("page", pageRef, { title: pageTitle, claim_ids: ["claim-typed"], width: "half", ...extra });
  const run = (params) => plan.execute("t", { infographic_plan_ref: planRef, ...base, ...params });
  const readPlan = (result) => JSON.parse(readFileSync(join(art, result.details.planRef), "utf8"));
  const errorOf = (promise) => promise.then(() => assert.fail("expected a refusal"), (error) => String(error.message));
  let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
  const bare = (id) => ({ id, type: "static_svg", story_node_ids: ["n1"], explanatory_dimension: "trend", asset_ref: chartRef, claim_ids: ["claim-a"], title: "A chart" });
  const modules = [bare("c1"), bare("c2")];
  const THESIS_OFF = "Publication visual_thesis must exactly match the bound InfographicSpec";
  const ACCESS_OFF = "Publication module 'c1' requires accessibility_summary and accessibility_long_description";
  for (const off of [undefined, "0", "true", " 1"]) {
    if (off === undefined) delete process.env.NEWSROOM_FIRST_TRY_PUBLISH; else process.env.NEWSROOM_FIRST_TRY_PUBLISH = off;
    ok(await errorOf(run({ visual_thesis: "wrong", modules })) === THESIS_OFF, `off (${JSON.stringify(off)}): thesis refusal byte for byte`);
    ok(await errorOf(run({ modules })) === ACCESS_OFF, `off (${JSON.stringify(off)}): accessibility refusal byte for byte`);
  }
  process.env.NEWSROOM_FIRST_TRY_PUBLISH = "1";
  const thesisOn = await errorOf(run({ visual_thesis: "wrong", modules }));
  ok(thesisOn === `${THESIS_OFF}; the bound value is: ${JSON.stringify(visualThesis)}`, "on: the thesis refusal also gives the bound value, verbatim");
  const accessOn = await errorOf(run({ modules }));
  ok(accessOn === `${ACCESS_OFF}; modules missing them: c1, c2`, "on: the accessibility refusal lists every module that lacks them");
  // one module lacking: nothing to add
  const one = [{ ...bare("c1") }, { ...bare("c2"), accessibility_summary: "A chart.", accessibility_long_description: "A chart of one series." }];
  ok(await errorOf(run({ modules: one })) === ACCESS_OFF, "on: one module lacking gives the legacy text");
  // a passing plan is unaffected by the switch
  const good = modules.map((m, i) => ({ ...m, explanatory_dimension: i ? "context" : "trend", accessibility_summary: "A chart.", accessibility_long_description: "A chart of one series." }));
  const planOn = await run({ modules: good });
  delete process.env.NEWSROOM_FIRST_TRY_PUBLISH;
  const planOff = await run({ modules: good });
  ok(planOn.details.planRef === planOff.details.planRef, "a passing plan is byte-identical with the switch on");
  console.log(`K303 step 5 publish: PASS (${checks} checks)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
