#!/usr/bin/env node
// newsroom_publication_render drops a module's top-level resolved_svg and embedded_page before it resolves the bindings; only the asset and page
// branches put them back, from the bytes whose hash they checked. Driven through the real plan and render tools (setup as in test_k303_step5_publish.mjs);
// the plan files with the extra keys are written by hand, as a model or a person could. No model, no browser.
// The PINS are the sha256 of the pages these plans render to on main 7ea386d9, before the change. Run: node scripts/test_publication_render_drops_model_svg.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const PINS = { assets: "c4a484e495109df8ea29fd0bc8475ecb2b15fd561065c430245806d96791684c", assetsText: "2154229a11c2069b5d6783ea5e9cc40ccd24914749ec7293b84fe408b4c9eb25", page: "ce262b5342c89dde80ec8d6fc09fb5eee82282bd0e15268ae1185c624e761f10" };
const tmp = mkdtempSync(join(tmpdir(), "drops-model-svg-"));
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
  source = source.replace(header, `${header} return; }\nasync function __lineageUnused(infographicPlanRef: string): Promise<void> {`);
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(source, { mode: "strip" }));

  const art = join(tmp, "artifact");
  for (const dir of ["infographics/plans", "visualizations", "editorial/story-graphs", "config", "computations", "publications/plans"]) mkdirSync(join(art, dir), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  for (const name of ["NEWSROOM_PUBLICATION_EMBED_PAGE", "NEWSROOM_PUBLICATION_STYLE_COMPAT", "NEWSROOM_FIRST_TRY_PUBLISH", "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED"]) delete process.env[name];

  const readerQuestion = "What does the fixture show?";
  const visualThesis = "The fixture shows one bound page.";
  const storyGraphRef = "editorial/story-graphs/g.json";
  writeFileSync(join(art, storyGraphRef), JSON.stringify({ passed: true, reader_question: readerQuestion, visual_thesis: visualThesis, nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }] }));
  const planRef = "infographics/plans/p.json";
  writeFileSync(join(art, planRef), JSON.stringify({ story_graph_ref: storyGraphRef, reader_question: readerQuestion, visual_thesis: visualThesis, modules: [] }));
  const verification = { authority: "system", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true, rule_id: "verification.source+extraction+computation+claim.v1" };
  writeFileSync(join(art, "claims.jsonl"), ["claim-a", "claim-b", "claim-typed"].map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: [], computation_refs: [], verification })).join("\n") + "\n");

  const svgText = (title, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 600" width="1440" height="600"><title>${title}</title><rect width="1440" height="600" fill="#fffdf9"/><text x="40" y="60" font-size="28" fill="#1d2329">${title}${extra}</text></svg>\n`;
  const pageTitle = "Composed page title";
  const pageKey = sha256("page");
  const pageRef = `infographics/${pageKey}.svg`;
  writeFileSync(join(art, pageRef), svgText(pageTitle));
  writeFileSync(join(art, `infographics/${pageKey}.json`), JSON.stringify({ plan_ref: planRef, variants: { desktop: pageRef }, claim_ids: ["claim-a", "claim-b"], title: pageTitle, visual_review_required: true }));
  const chartRef = `visualizations/${sha256("chart")}.svg`;
  writeFileSync(join(art, chartRef), svgText("A single chart", " 13.5"));

  const { hashRows } = await import(join(pi, "viz.mjs"));
  const rows = [{ year: 2020, value: 1 }, { year: 2021, value: 2 }];
  const compRef = "computations/c.json";
  writeFileSync(join(art, compRef), JSON.stringify({ rows, result_hash: hashRows(rows) }));

  const tools = new Map();
  const piApi = new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) });
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));
  newsroomExtension(piApi);
  const plan = tools.get("newsroom_publication_plan");
  const render = tools.get("newsroom_publication_render");
  assert.ok(plan && render, "publication tools must register");

  const base = { story_graph_ref: storyGraphRef, reader_question: readerQuestion, visual_thesis: visualThesis, title: "Fixture page", dek: "A fixture." };
  const access = { accessibility_summary: "A chart.", accessibility_long_description: "A chart of the fixture." };
  const chart = (id, dimension) => ({ id, type: "static_svg", story_node_ids: ["n1"], explanatory_dimension: dimension, asset_ref: chartRef, claim_ids: ["claim-a"], title: "A chart", ...access });
  const text = (id) => ({ id, type: "text", story_node_ids: ["n2"], explanatory_dimension: "context", text: `Body ${id}.` });
  const pageModule = { id: "page", type: "static_svg", story_node_ids: ["n1"], explanatory_dimension: "trend", asset_ref: pageRef, claim_ids: ["claim-typed"], title: pageTitle, width: "half", ...access };
  const makePlan = async (modules) => JSON.parse(readFileSync(join(art, (await plan.execute("t", { infographic_plan_ref: planRef, ...base, modules })).details.planRef), "utf8"));
  // one plan path for every variant: the manifest names it, and two pages with the same bytes must also have the same manifest
  const renderPlan = async (spec) => {
    const ref = "publications/plans/hand.json";
    writeFileSync(join(art, ref), JSON.stringify(spec));
    try {
      const result = await render.execute("t", { plan_ref: ref });
      return { html: readFileSync(join(art, result.details.htmlRef), "utf8") };
    } catch (error) { return { error: String(error.message) }; }
  };
  const edit = (spec, index, extra) => ({ ...spec, modules: spec.modules.map((m, i) => (i === index ? { ...m, ...extra } : m)) });
  // every check runs, so a broken drop shows all the cases it breaks, not just the first
  let checks = 0; const failures = []; const ok = (c, m) => { if (c) checks++; else failures.push(m); };
  const same = (page, other) => typeof page === "string" && page === other; // two pages that failed to render are not the same page
  const pin = (name, html) => { if (typeof html !== "string") return; if (PINS[name]) ok(sha256(html) === PINS[name], `${name}: the page is the one main renders (${sha256(html)})`); else console.log(`PIN ${name} ${sha256(html)}`); };
  const injected = svgText("Injected", " INJECTED-7Q3Z");

  // ordinary plans, no such keys: the pages are what main renders
  const assets = await makePlan([chart("c1", "trend"), chart("c2", "context")]);
  const assetsText = await makePlan([chart("c1", "trend"), text("t1")]);
  const assetsHtml = (await renderPlan(assets)).html;
  ok(typeof assetsHtml === "string", "an ordinary two-chart plan renders");
  pin("assets", assetsHtml);
  const assetsTextHtml = (await renderPlan(assetsText)).html;
  ok(typeof assetsTextHtml === "string", "an ordinary chart-and-text plan renders");
  pin("assetsText", assetsTextHtml);

  // b: an asset binding plus a different resolved_svg: the page is the asset's, byte for byte
  const b = await renderPlan(edit(assets, 0, { resolved_svg: injected }));
  ok(same(b.html, assetsHtml), `b: a resolved_svg beside an asset binding changes nothing (${b.error ?? "differs"})`);
  ok(typeof b.html === "string" && !b.html.includes("INJECTED-7Q3Z"), "b: the INJECTED-7Q3Z marker is not in the page");

  // a: computation and asset refs together, with a resolved_svg that no claim covers: refused exactly as without it
  const bound = { computation_ref: compRef, evidence_binding: { kind: "computation", ref: compRef, result_hash: hashRows(rows), row_count: rows.length, field_mapping: {}, claim_computation_refs: [] } };
  const aWith = await renderPlan(edit(assets, 0, { ...bound, resolved_svg: injected }));
  const aWithout = await renderPlan(edit(assets, 0, bound));
  ok(aWithout.error?.includes("is not SVG"), `a: without the key the module is refused (${aWithout.error ?? "rendered"})`);
  ok(aWith.html === undefined && aWith.error === aWithout.error, `a: with the key the refusal is the same text (${aWith.error ?? "rendered the injected SVG"})`);

  // the same drop for a module with no binding at all
  const noBinding = await renderPlan(edit(assets, 0, { evidence_binding: undefined, resolved_svg: injected }));
  ok(noBinding.html === undefined, "no binding: a resolved_svg alone does not reach a page");

  // page binding: the embedded page is unchanged; keys the model adds on top of it change nothing
  process.env.NEWSROOM_PUBLICATION_EMBED_PAGE = "1";
  const pagePlan = await makePlan([pageModule, text("t1")]);
  const pageHtml = (await renderPlan(pagePlan)).html;
  ok(typeof pageHtml === "string" && pageHtml.includes(pageTitle), "page: the bound page renders");
  pin("page", pageHtml);
  const pageNoise = await renderPlan(edit(pagePlan, 0, { resolved_svg: injected, embedded_page: false }));
  ok(same(pageNoise.html, pageHtml), "page: a resolved_svg and embedded_page beside a page binding change nothing");
  delete process.env.NEWSROOM_PUBLICATION_EMBED_PAGE;

  // a text module claiming to be an embedded page, with an SVG whose title is the page title: the h1 keeps its look
  const titled = svgText(base.title);
  const textClaim = await renderPlan(edit(assetsText, 1, { embedded_page: true, resolved_svg: titled }));
  ok(same(textClaim.html, assetsTextHtml) && !textClaim.html.includes("pub-title-sr"), "text: embedded_page and resolved_svg on a text module change nothing; the h1 is not hidden");
  assert.equal(failures.length, 0, `${failures.length} checks failed:\n- ${failures.join("\n- ")}`);
  console.log(`publication render drops model svg: PASS (${checks} checks)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
