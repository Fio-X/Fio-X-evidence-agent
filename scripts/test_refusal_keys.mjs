#!/usr/bin/env node
// NEWSROOM_SPEED_REFUSAL_KEYS: the real newsroom_publication_plan handler (a type-stripped copy of newsroom.ts, lineage gate replaced by a stub as in
// test_publication_report_all.mjs). A data-bearing module with no evidence binding is refused with "... requires an immutable evidence binding".
// Off (unset, "0", "true", "11", ""): that text is exactly as before, and the tool definition is the same string either way. Exactly "1": the same
// refusal also names the keys a module binds evidence with. The check itself never changes: a module with a binding still passes, one without is still refused.
// K1053_MUTANT=1 adds the key names whatever the switch says (the off test must fail); =2 drops the key names under the switch (the on test must fail);
// =3 reads the switch as "anything but 0" (the "true"/"11"/"" off cases must fail); =4 lets the refusal go under the switch (the still-refused test must fail);
// =5 ignores NEWSROOM_PUBLICATION_EMBED_PAGE and always names a visualizations/ path (the embed-page test must fail).
// With EMBED_PAGE=1 the hint also names the composed page infographics/<64 hex>.svg a page module takes (resolveEmbeddedPage); with it off that path is not accepted, so the hint stays as it was.
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
  const mutate = (from, to) => {
    assert.ok(source.includes(from), "the mutation target moved: update this test");
    source = source.replace(from, to);
  };
  if (process.env.K1053_MUTANT === "1") mutate("${refusalKeysEnabled() ? evidenceBindingKeysText() : \"\"}", "${evidenceBindingKeysText()}");
  if (process.env.K1053_MUTANT === "2") mutate("${refusalKeysEnabled() ? evidenceBindingKeysText() : \"\"}", "");
  if (process.env.K1053_MUTANT === "3") mutate('process.env.NEWSROOM_SPEED_REFUSAL_KEYS === "1"', 'process.env.NEWSROOM_SPEED_REFUSAL_KEYS !== undefined && process.env.NEWSROOM_SPEED_REFUSAL_KEYS !== "0"');
  if (process.env.K1053_MUTANT === "4") mutate("if (dataBearing && !binding) throw", "if (dataBearing && !binding && !refusalKeysEnabled()) throw");
  if (process.env.K1053_MUTANT === "5") mutate('return process.env.NEWSROOM_PUBLICATION_EMBED_PAGE === "1" ? EVIDENCE_BINDING_KEYS_PAGE_TEXT : EVIDENCE_BINDING_KEYS_TEXT;', "return EVIDENCE_BINDING_KEYS_TEXT;");
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

  const OLD = (id) => `Publication module '${id}' requires an immutable evidence binding`;
  // a data-bearing module that binds nothing: no computation_ref, analysis_ref, map_ref, model_ref or asset_ref
  const unbound = (id, extra = {}) => ({ id, type: "stat", story_node_ids: ["n1"], explanatory_dimension: "trend", claim_ids: ["claim-a"], accessibility_summary: "A number.", accessibility_long_description: "A number of the fixture.", ...extra });
  const withSwitch = async (value, fn) => {
    const before = process.env.NEWSROOM_SPEED_REFUSAL_KEYS;
    if (value === undefined) delete process.env.NEWSROOM_SPEED_REFUSAL_KEYS; else process.env.NEWSROOM_SPEED_REFUSAL_KEYS = value;
    try { return await fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_SPEED_REFUSAL_KEYS; else process.env.NEWSROOM_SPEED_REFUSAL_KEYS = before; }
  };
  const good = [visual("chart", chartRef, { title: "A single chart" }), text("t1", "n2", "context")];
  const KEYS = ": give one of computation_ref (a computations/ path, with result_hash and field_mapping_json), analysis_ref, map_ref, model_ref or asset_ref (a visualizations/ SVG path); any other key name is not read";
  const KEYS_PAGE = KEYS.replace("(a visualizations/ SVG path)", "(a visualizations/ SVG path, or for a page module the composed page infographics/<64 hex>.svg)");
  const withEmbed = async (value, fn) => {
    const before = process.env.NEWSROOM_PUBLICATION_EMBED_PAGE;
    if (value === undefined) delete process.env.NEWSROOM_PUBLICATION_EMBED_PAGE; else process.env.NEWSROOM_PUBLICATION_EMBED_PAGE = value;
    try { return await fn(); } finally { if (before === undefined) delete process.env.NEWSROOM_PUBLICATION_EMBED_PAGE; else process.env.NEWSROOM_PUBLICATION_EMBED_PAGE = before; }
  };
  const PAGE_EXTRA = 66;
  const defOff = JSON.stringify([plan.description, plan.promptGuidelines, plan.parameters]);

  // ---- Off: the old words, exactly.
  for (const value of [undefined, "0", "true", "11", ""]) await withSwitch(value, async () => {
    const tag = JSON.stringify(value);
    assert.equal(await errorOf(run({ modules: [unbound("a"), text("t1", "n2", "context")] })), OLD("a"), `${tag}: the refusal is the old text`);
  });
  // ---- On: the same first sentence, then the keys; the refusal stays a refusal.
  await withSwitch("1", async () => {
    const refused = await errorOf(run({ modules: [unbound("a"), text("t1", "n2", "context")] }));
    assert.equal(refused, OLD("a") + KEYS, "on: the old sentence, then the key names");
    assert.ok(refused.startsWith(OLD("a")), "on: the first sentence is unchanged");
    for (const key of ["computation_ref", "analysis_ref", "map_ref", "model_ref", "asset_ref", "result_hash", "field_mapping_json"]) assert.ok(refused.includes(key), `on: names ${key}`);
    assert.equal(Buffer.byteLength(KEYS), 201, "on: the added bytes");
    // the check did not move: a module that binds evidence still passes, with the same plan as with the switch off
    const onKey = (await run({ modules: good })).details.planRef;
    const offKey = (await withSwitch(undefined, () => run({ modules: good }))).details.planRef;
    assert.equal(onKey, offKey, "on: a bound call records the same plan as off");
    // a wrong alias is still not read: the model must still name the key itself
    assert.equal(await errorOf(run({ modules: [unbound("a", { computation_refs: ["x"], evidence_ref: "y" }), text("t1", "n2", "context")] })), OLD("a") + KEYS, "on: an alias is still refused");
    // the program fills nothing in
    assert.equal(await errorOf(run({ modules: [unbound("b"), text("t1", "n2", "context")] })), OLD("b") + KEYS, "on: names the module that was refused");
  });
  // ---- On with NEWSROOM_PUBLICATION_EMBED_PAGE=1: the hint is also right for a page module, whose asset_ref is infographics/<64 hex>.svg, not a visualizations/ path.
  await withSwitch("1", () => withEmbed("1", async () => {
    const refused = await errorOf(run({ modules: [unbound("a"), text("t1", "n2", "context")] }));
    assert.equal(refused, OLD("a") + KEYS_PAGE, "embed page: the old sentence, then the keys with the page path");
    assert.ok(refused.includes("infographics/<64 hex>.svg") && refused.includes("a visualizations/ SVG path"), "embed page: names both asset paths");
    assert.notEqual(KEYS_PAGE, KEYS, "embed page: the hint is not the plain one");
    // what the hint says is true: a page module with that kind of asset_ref is accepted under EMBED_PAGE=1, and a chart module with a visualizations/ path still is
    const planKey = (await run({ modules: [pageModule(), text("t1", "n2", "context")] })).details.planRef;
    assert.ok(planKey, "embed page: a page module bound by infographics/<64 hex>.svg passes");
    assert.ok((await run({ modules: good })).details.planRef, "embed page: a chart module bound by a visualizations/ path still passes");
    assert.equal(Buffer.byteLength(KEYS_PAGE) - Buffer.byteLength(KEYS), PAGE_EXTRA, "embed page: the extra bytes");
    assert.equal(Buffer.byteLength(KEYS_PAGE), 267, "embed page: the added bytes in all");
  }));
  // the switch off: EMBED_PAGE on makes no difference, the refusal is the old text
  await withSwitch(undefined, () => withEmbed("1", async () => assert.equal(await errorOf(run({ modules: [unbound("a"), text("t1", "n2", "context")] })), OLD("a"), "switch off, embed page on: the old text")));
  // EMBED_PAGE off: the page path is not accepted, so the hint must not name it
  await withSwitch("1", () => withEmbed(undefined, async () => {
    const refused = await errorOf(run({ modules: [unbound("a"), text("t1", "n2", "context")] }));
    assert.ok(!refused.includes("infographics/"), "embed page off: the hint does not name a path that would be refused");
    assert.ok((await errorOf(run({ modules: [pageModule(), text("t1", "n2", "context")] }))).length > 0, "embed page off: a page module is refused");
  }));
  // the tool definition is the same string whatever the switch says (the keys are only in the refusal)
  await withSwitch("1", async () => assert.equal(JSON.stringify([plan.description, plan.promptGuidelines, plan.parameters]), defOff, "the tool definition is unchanged"));
  console.log("test_refusal_keys: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
