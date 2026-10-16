#!/usr/bin/env node
// K275 / K273: NEWSROOM_PUBLICATION_EMBED_PAGE and NEWSROOM_PUBLICATION_STYLE_COMPAT, driven through the real newsroom_publication_plan and
// newsroom_publication_render handlers (no model, no browser). The infographic lineage gate has its own coverage in test_render_qa_tool_path.mjs;
// here it is replaced by a recording stub so this file tests only what the two switches add: the page binding, the claim copy, the hash re-check,
// and that with both switches off the plan and the page bytes are exactly what they were before.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "publication-embed-page-"));
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
  for (const name of ["NEWSROOM_PUBLICATION_EMBED_PAGE", "NEWSROOM_PUBLICATION_STYLE_COMPAT"]) delete process.env[name];

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

  // ---- Off: the plan and the page bytes are what they always were (golden keys recorded from the commit before this change).
  const offModules = [visual("chart", chartRef, { title: "A single chart" }), text("t1", "n2", "context")];
  const offPlan = await run({ modules: offModules });
  assert.equal(offPlan.details.planRef, "publications/plans/cb26610106552950ef8f2a0dced5b16ba926b1abc028fe5ca0b35af8d56cd00d.json", "switch off: the recorded plan changed");
  const offRendered = await render.execute("t", { plan_ref: offPlan.details.planRef });
  assert.equal(offRendered.details.htmlRef, "publications/a7aa05e55460ca800ff9bcd3a9acdd151deacd2af07ed58960a9dc27513fa5c5/index.html", "switch off: the rendered page bytes changed");
  assert.equal(readFileSync(join(art, offRendered.details.htmlRef), "utf8").includes("pub-title-sr"), false, "switch off: the header is never hidden");
  assert.equal(await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] })), `Artifact path must be under visualizations/: ${pageRef}`, "switch off: the refusal for an infographics/ asset changed");
  const forgedPlan = readPlan(offPlan); forgedPlan.modules[0].evidence_binding = { kind: "page", ref: pageRef, result_hash: sha256(pageSvg), manifest_ref: `infographics/${pageKey}.json` };
  mkdirSync(join(art, "publications/plans"), { recursive: true });
  writeFileSync(join(art, "publications/plans/forged.json"), JSON.stringify(forgedPlan));
  assert.match(await errorOf(render.execute("t", { plan_ref: "publications/plans/forged.json" })), /Unknown publication evidence binding 'page'/, "switch off: a page binding is not read");
  console.log("off: plan key, page key and refusals unchanged -- PASS");

  // ---- On: the page module.
  process.env.NEWSROOM_PUBLICATION_EMBED_PAGE = "1";
  globalThis.__LINEAGE_CALLS__ = [];
  const onPlan = await run({ modules: [pageModule(), text("t1", "n2", "context")] });
  const spec = readPlan(onPlan);
  const page = spec.modules[0];
  assert.deepEqual(page.claim_ids, ["claim-a", "claim-b"], "claim ids come from the render manifest, not the model");
  assert.equal(page.width, "full");
  assert.deepEqual({ ...page.evidence_binding, field_mapping: undefined }, { kind: "page", ref: pageRef, result_hash: sha256(pageSvg), manifest_ref: `infographics/${pageKey}.json`, field_mapping: undefined });
  assert.ok(globalThis.__LINEAGE_CALLS__.length >= 1, "the lineage gate ran");
  const onRendered = await render.execute("t", { plan_ref: onPlan.details.planRef });
  const html = readFileSync(join(art, onRendered.details.htmlRef), "utf8");
  assert.ok(html.includes(`<title>${pageTitle}</title>`), "the composed page is in the publication");
  assert.equal(html.includes(`<h2>${pageTitle}</h2>`), false, "no second heading when the module title is the page's own title");
  assert.match(html, /pub-full/);
  assert.equal(html.includes("pub-title-sr"), false, "a different publication title keeps the visible header");
  // the publication title equals the embedded page's own title: the h1 stays (reading order) but is not shown twice
  const sameTitle = await run({ title: pageTitle, modules: [pageModule(), text("t1", "n2", "context")] });
  const sameHtml = readFileSync(join(art, (await render.execute("t", { plan_ref: sameTitle.details.planRef })).details.htmlRef), "utf8");
  assert.match(sameHtml, /<h1 class="pub-title pub-title-sr">/);
  assert.ok(sameHtml.includes(".pub-title-sr{"));
  console.log("on: page accepted, claims copied, page rendered full width without a second heading -- PASS");

  // chart modules (visualizations/) still bind as before with the switch on
  assert.equal((await run({ modules: offModules })).details.planRef, offPlan.details.planRef, "a visualizations/ asset binds the same with the switch on");

  // ---- On: refusals.
  assert.match(await errorOf(run({ modules: [visual("page", `infographics/${otherKey}.svg`, { title: "Other" }), text("t1", "n2", "context")] })), /is not the render of infographic_plan_ref/);
  assert.match(await errorOf(run({ modules: [visual("page", `infographics/${strayKey}.svg`), text("t1", "n2", "context")] })), /is not the render of infographic_plan_ref/);
  assert.match(await errorOf(run({ modules: [visual("page", "infographics/not-a-page.svg"), text("t1", "n2", "context")] })), /must be infographics\/<key>\.svg/);
  writeManifest(pageKey, planRef, `infographics/${strayKey}.svg`);
  assert.match(await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] })), /is not the desktop page recorded/);
  writeManifest(pageKey, planRef, pageRef, { claim_ids: [] });
  assert.match(await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] })), /records no claim_ids/);
  writeManifest(pageKey, planRef, pageRef, { claim_ids: ["claim-a", "claim-missing"] });
  assert.match(await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] })), /unverified claim 'claim-missing'/, "a manifest claim that is not system-verified still blocks");
  writeManifest(pageKey, planRef, pageRef);
  globalThis.__LINEAGE_FAIL__ = true;
  assert.match(await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] })), /lineage forced fail/, "the lineage gate still decides");
  globalThis.__LINEAGE_FAIL__ = false;
  assert.match(await errorOf(run({ modules: [pageModule({ type: "text" }), text("t1", "n2", "context")] })), /must be type static_svg/);
  // the page changed after planning: the render refuses
  writeFileSync(join(art, pageRef), svgText("Tampered"));
  assert.match(await errorOf(render.execute("t", { plan_ref: onPlan.details.planRef })), /Publication page changed for module 'page'/);
  writeFileSync(join(art, pageRef), pageSvg);
  // an unsafe page is refused by the same sanitizer
  writeFileSync(join(art, pageRef), pageSvg.replace("</svg>", "<script>alert(1)</script></svg>"));
  assert.match(await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] })), /script|unsafe|blocked/i);
  writeFileSync(join(art, pageRef), pageSvg);
  console.log("on: wrong render, wrong plan, tampered or unsafe page, unverified claim, failed lineage all refused -- PASS");
  delete process.env.NEWSROOM_PUBLICATION_EMBED_PAGE;

  // ---- K273: the style profile the plan records is one its own render accepts.
  const mixed = [visual("a", chartRef, { explanatory_dimension: "spatial", title: "Map" }), visual("b", chartRef, { explanatory_dimension: "human_scale", title: "People" }), text("t1", "n2", "mechanism"), text("t2", "n3", "method")];
  const offStyle = await run({ modules: mixed });
  const offProfile = readPlan(offStyle).style_profile;
  assert.equal(offProfile, "spatial_monitor", "off: the old dimension rule is unchanged");
  assert.match(await errorOf(render.execute("t", { plan_ref: offStyle.details.planRef })), /Style mapping blocked/, "off: this page records a profile its render blocks (the run9 shape)");
  process.env.NEWSROOM_PUBLICATION_STYLE_COMPAT = "1";
  const onStyle = await run({ modules: mixed });
  const onProfile = readPlan(onStyle).style_profile;
  assert.equal(onProfile, "japanese_editorial", "the first profile that covers every dimension of the page");
  await render.execute("t", { plan_ref: onStyle.details.planRef });
  assert.equal(readPlan(await run({ modules: mixed, style_profile: "systems_explainer" })).style_profile, "systems_explainer", "a given style_profile is kept");
  assert.equal(readPlan(await run({ modules: offModules.concat(text("t2", "n3", "outcome")) })).style_profile, "analytical_precision");
  console.log(`style compat: off records ${offProfile} (render blocks), on records ${onProfile} (render passes) -- PASS`);
  delete process.env.NEWSROOM_PUBLICATION_STYLE_COMPAT;
  console.log("test_publication_embed_page: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
