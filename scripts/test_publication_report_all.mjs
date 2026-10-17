#!/usr/bin/env node
// NEWSROOM_SPEED_PUBLICATION_REPORT_ALL: the real newsroom_publication_plan handler (a type-stripped copy of newsroom.ts, lineage gate replaced by a stub as in
// test_publication_embed_page.mjs). Off (unset, "0", "true", "11"): the first failing check throws with its old text and nothing else. Exactly "1": the checks that
// read only the call, the bound plan, the story graph and the recorded claims are all run and one refusal lists every problem found, the first problem's text first;
// a check that needs an earlier one is skipped when that one failed; the checks that read artifacts still stop at the first failure and run only when the list is empty.
// K776_MUTANT=1 restores first-error behaviour under the switch in the copy: this test must then fail.
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
  if (process.env.K776_MUTANT === "1") {
    const from = "problems.push(error); return false;";
    assert.ok(source.includes(from), "the mutation target moved: update this test");
    source = source.replace(from, "throw error;");
  }
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

  const THESIS = "Publication visual_thesis must exactly match the bound InfographicSpec";
  const modOk = (id, extra = {}) => visual(id, chartRef, { title: "A single chart", ...extra });
  const good = [modOk("chart"), text("t1", "n2", "context")];
  const withSwitch = async (value, fn) => {
    if (value === undefined) delete process.env.NEWSROOM_SPEED_PUBLICATION_REPORT_ALL; else process.env.NEWSROOM_SPEED_PUBLICATION_REPORT_ALL = value;
    try { return await fn(); } finally { delete process.env.NEWSROOM_SPEED_PUBLICATION_REPORT_ALL; }
  };
  // breakpoints can only be passed with the program-set limits turned off ("0"): the check is reachable in that mode only
  const withLimitsOff = async (fn) => { process.env.NEWSROOM_QA_LIMITS_PROGRAM = "0"; try { return await fn(); } finally { delete process.env.NEWSROOM_QA_LIMITS_PROGRAM; } };
  const noAccess = { accessibility_summary: "", accessibility_long_description: "" };
  const unknownNode = (id) => ({ ...modOk(id), story_node_ids: ["n-missing"] });
  const badThesis = { visual_thesis: "Something else entirely." };

  // ---- Off: first-error behaviour and texts unchanged, one test per message the change touches.
  for (const value of [undefined, "0", "true", "11", ""]) await withSwitch(value, async () => {
    const tag = JSON.stringify(value);
    const first = await errorOf(run({ ...badThesis, modules: [unknownNode("a"), text("t1", "n2", "context")] }));
    assert.ok(first.startsWith(THESIS), `${tag}: the first failing check is the one reported (${first.slice(0, 80)})`);
    assert.equal(first.includes("Also refused"), false, `${tag}: nothing else is listed`);
    assert.equal(first.includes("unknown StoryGraph node"), false, `${tag}: the later problem is not reported`);
    assert.equal(await errorOf(run({ story_graph_ref: "editorial/story-graphs/g.json", modules: good, reader_question: "Another question?" })), "Publication reader_question must exactly match the bound InfographicSpec", `${tag}: reader_question text`);
    assert.equal(await errorOf(run({ modules: [unknownNode("a"), text("t1", "n2", "context")] })), "Publication module 'a' references unknown StoryGraph node 'n-missing'", `${tag}: unknown node text`);
    assert.equal(await errorOf(run({ modules: [modOk("a", { claim_ids: [] }), text("t1", "n2", "context")] })), "Publication module 'a' requires verified claim_ids", `${tag}: claim_ids text`);
    assert.equal(await errorOf(run({ modules: [modOk("a", { claim_ids: ["claim-nope"] }), text("t1", "n2", "context")] })), "Publication module 'a' references unverified claim 'claim-nope'", `${tag}: unverified claim text`);
    assert.equal(await errorOf(run({ modules: [modOk("a", { view_spec_json: "{nope" }), text("t1", "n2", "context")] })), "Publication module 'a' view_spec_json is not valid JSON", `${tag}: view_spec_json text`);
    assert.equal(await errorOf(run({ modules: [modOk("a", { field_mapping_json: "[1]" }), text("t1", "n2", "context")] })), "Publication module 'a' field_mapping_json must be an object", `${tag}: field_mapping_json text`);
    assert.match(await errorOf(run({ modules: [modOk("a", noAccess), text("t1", "n2", "context")] })), /^Publication module 'a' requires accessibility_summary and accessibility_long_description/, `${tag}: accessibility text`);
    assert.equal(await withLimitsOff(() => errorOf(run({ breakpoints: [1440, 768], modules: good }))), "with mobile pages off, web publications use exactly one width: 1440", `${tag}: breakpoints text`);
  });
  const offKey = (await withSwitch(undefined, () => run({ modules: good }))).details.planRef;

  // ---- On: independent problems are all listed, the first one's text first.
  await withSwitch("1", async () => {
    // a valid call and every single-problem call behave as with the switch off
    assert.equal((await run({ modules: good })).details.planRef, offKey, "on: a valid call records the same plan");
    assert.equal(await errorOf(run({ modules: [unknownNode("a"), text("t1", "n2", "context")] })), "Publication module 'a' references unknown StoryGraph node 'n-missing'", "on: one problem, same text");
    assert.match(await errorOf(run({ modules: [modOk("a", noAccess), text("t1", "n2", "context")] })), /^Publication module 'a' requires accessibility_summary and accessibility_long_description$/, "on: one problem, same text (no list)");

    // two independent problems: one refusal naming both
    const two = await errorOf(run({ ...badThesis, modules: [unknownNode("a"), text("t1", "n2", "context")] }));
    assert.ok(two.startsWith(THESIS), "on: the first problem keeps its text first");
    assert.match(two, /Also refused in this call \(1 more independent problem; nothing was recorded\)/);
    assert.ok(two.includes("(2) Publication module 'a' references unknown StoryGraph node 'n-missing'"), "on: the second problem is named");

    // three problems across the call, the plan match, two modules, accessibility and breakpoints
    const many = await withLimitsOff(() => errorOf(run({ ...badThesis, reader_question: "Another question?", breakpoints: [1440, 768], modules: [unknownNode("a"), modOk("b", { ...noAccess, claim_ids: ["claim-nope"] }), text("t1", "n2", "context")] })));
    assert.match(many, /\(5 more independent problems/);
    for (const part of ["reader_question must exactly match", THESIS, "module 'a' references unknown StoryGraph node", "module 'b' references unverified claim 'claim-nope'", "module 'b' requires accessibility_summary", "exactly one width: 1440"]) assert.ok(many.includes(part), `on: names ${part}`);
    assert.ok(many.startsWith("Publication reader_question must exactly match"), "on: the old first check is still the first problem");

    // dependent checks: a module without claim_ids does not also report an unverified claim; bad JSON does not also report the inline-data or object check
    const dep = await errorOf(run({ modules: [modOk("a", { claim_ids: [] }), modOk("b", { view_spec_json: "{nope", field_mapping_json: "{nope" }), text("t1", "n2", "context")] }));
    assert.match(dep, /module 'a' requires verified claim_ids/);
    assert.match(dep, /module 'b' view_spec_json is not valid JSON/);
    assert.match(dep, /module 'b' field_mapping_json is not valid JSON/);
    assert.equal(dep.includes("unverified claim"), false, "on: the claim compare is skipped when claim_ids failed");
    assert.equal(dep.includes("must be an object"), false, "on: the object check is skipped when the JSON failed");
    // inline data in a parsed view_spec is an independent problem and is listed beside others
    const inline = await errorOf(run({ modules: [modOk("a", { view_spec_json: JSON.stringify({ values: [1, 2] }) }), unknownNode("b"), text("t1", "n2", "context")] }));
    assert.match(inline, /module 'b' references unknown StoryGraph node/);
    assert.ok(inline.split("\n").length >= 3, "on: inline data in the view_spec is listed with the other problem");

    // artifact checks stay first-error and stop first: a missing computation is reported by itself when nothing independent failed,
    // and is never listed beside independent problems (they stop the call before the artifact read)
    const artifactOnly = await errorOf(run({ modules: [modOk("a", { computation_ref: "computations/missing.json", result_hash: "x" }), text("t1", "n2", "context")] }));
    assert.equal(artifactOnly.includes("Also refused"), false, "on: an artifact check alone is a single refusal");
    const both = await errorOf(run({ modules: [modOk("a", { computation_ref: "computations/missing.json", result_hash: "x" }), unknownNode("b"), text("t1", "n2", "context")] }));
    assert.match(both, /module 'b' references unknown StoryGraph node/, "on: the independent problem is reported");
    assert.equal(both.includes("missing.json"), false, "on: the dependent artifact check has not run yet");
    assert.equal(artifactOnly.includes("module 'b'"), false);
  });
  console.log("test_publication_report_all: ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
