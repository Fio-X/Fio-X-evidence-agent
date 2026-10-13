// NEWSROOM_LEAN_GATES=1 (K258, exact "1", default off): the lean legacy-gate path. One file for the whole series; each item adds its checks.
// Item 1: the concept tournament (visual_concept_ref, selected_concept_id, the newsroom_visual_concepts tool) is gone on a lean page.
// Item 2: so is the asset plan (asset_plan_ref, the newsroom_asset_requirements tool).
// Item 3: the semantic-novelty check is a lint warning (never a blocker); novelty_ref and newsroom_semantic_novelty are gone.
// Item 4: the two coverage thresholds (0.65 closure coverage in the story graph, 0.6 module coverage on the page) are dropped; entry and answer coverage stay.
// Item 5: on a storyboard page the scene graph is derived from the panels; one the model writes is refused ("由格子生成").
// Item 6: the editorial grammar set is derived by the program; the model gives only primary / supporting (both optional).
// (d) With the switch on no prompt text, tool description or hint names a removed tool.
// Off (unset, "0", "true", " 1", ""): nothing changes; test_tool_defs_unchanged.mjs pins the tool definitions byte for byte.
//
// Run: node scripts/test_lean_gates.mjs
import { makeTestTmp } from "./tmp_helper.mjs";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));
let failed = 0;
let passed = 0;
const check = (label, ok, detail = "") => {
  if (ok) passed += 1; else { failed += 1; console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`); }
};

// ---- tool definitions, on and off (same plain-JSON typebox stand-in as test_tool_defs_unchanged.mjs) ----
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
const TREE = makeTestTmp("lean-gates-tree-");
cpSync(join(HERE, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(HERE, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

let loads = 0;
async function toolsWith(value, profile = "full", storyboard = false) {
  delete process.env.NEWSROOM_LEAN_GATES; delete process.env.NEWSROOM_STORYBOARD;
  if (storyboard) process.env.NEWSROOM_STORYBOARD = "1";
  if (value !== undefined) process.env.NEWSROOM_LEAN_GATES = value;
  process.env.NEWSROOM_TOOL_PROFILE = profile;
  const tools = {};
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++loads}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => { tools[tool.name] = tool; } : () => {}) }));
  delete process.env.NEWSROOM_LEAN_GATES; delete process.env.NEWSROOM_STORYBOARD;
  return tools;
}
const off = await toolsWith(undefined);
check("off: the concept tournament and asset plan tools are offered", !!off.newsroom_visual_concepts && !!off.newsroom_asset_requirements && !!off.newsroom_semantic_novelty);
check("off: asset_plan_ref is required by the plan tool", off.newsroom_infographic_plan.parameters.required.includes("asset_plan_ref"));
check("off: visual_concept_ref and selected_concept_id are required by the plan tool", off.newsroom_infographic_plan.parameters.required.includes("selected_concept_id") && off.newsroom_infographic_plan.parameters.required.includes("visual_concept_ref"));
check("off: the plan guideline still names the tournament", off.newsroom_infographic_plan.promptGuidelines.some((g) => g.includes("visual concept tournament")));
for (const value of ["0", "true", " 1", ""]) {
  const t = await toolsWith(value);
  check(`switch value ${JSON.stringify(value)} equals unset`, JSON.stringify(Object.keys(t)) === JSON.stringify(Object.keys(off)) && JSON.stringify(t.newsroom_infographic_plan.parameters) === JSON.stringify(off.newsroom_infographic_plan.parameters));
}
const on = await toolsWith("1");
check("on: the concept tournament, asset plan and novelty tools are not offered", !on.newsroom_visual_concepts && !on.newsroom_asset_requirements && !on.newsroom_semantic_novelty);
check("on: every other tool is still offered", Object.keys(off).filter((n) => !["newsroom_visual_concepts", "newsroom_asset_requirements", "newsroom_semantic_novelty"].includes(n)).every((n) => on[n]));
const onPlan = on.newsroom_infographic_plan.parameters;
check("on: visual_concept_ref, selected_concept_id, asset_plan_ref and novelty_ref are optional", !["visual_concept_ref", "selected_concept_id", "asset_plan_ref", "novelty_ref"].some((f) => onPlan.required.includes(f)));
check("on: the discovery ref is still required", onPlan.required.includes("editorial_discovery_ref"));
check("on: the plan guideline no longer names the tournament", !on.newsroom_infographic_plan.promptGuidelines.some((g) => g.includes("concept tournament")));

// ---- spec validation ----
process.env.NEWSROOM_LEAN_GATES = "1";
const infographicOn = await import(`${pathToFileURL(join(HERE, "runtime/pi/infographic.mjs")).href}?on`);
delete process.env.NEWSROOM_LEAN_GATES;
const infographicOff = await import(`${pathToFileURL(join(HERE, "runtime/pi/infographic.mjs")).href}?off`);
const bare = { schema_version: "1.5.0", title: "t", reader_question: "q", visual_thesis: "v", story_graph_ref: "editorial/story-graphs/a.json", editorial_discovery_ref: "editorial/discovery/a.json", novelty_ref: "editorial/novelty/a.json", asset_plan_ref: "editorial/assets/a.json", modules: [] };
const missingRefErrors = (mod, value, spec) => {
  if (value === undefined) delete process.env.NEWSROOM_LEAN_GATES; else process.env.NEWSROOM_LEAN_GATES = value;
  try { return mod.validateInfographicSpec(spec).filter((e) => /_ref is required|selected_concept_id is required/.test(e)); } finally { delete process.env.NEWSROOM_LEAN_GATES; }
};
check("leanGatesEnabled: only exactly 1", infographicOff.leanGatesEnabled({ NEWSROOM_LEAN_GATES: "1" }) === true && [undefined, "0", "true", " 1", "", "yes"].every((v) => infographicOff.leanGatesEnabled({ NEWSROOM_LEAN_GATES: v }) === false));
const offErrors = missingRefErrors(infographicOff, undefined, bare);
check("off: a page without a concept ref, selected concept or asset plan is refused for each", ["visual_concept_ref", "selected_concept_id", "asset_plan_ref"].every((f) => missingRefErrors(infographicOff, undefined, { ...bare, asset_plan_ref: undefined })?.some((e) => e.startsWith(`${f} is required`))), offErrors.join(" | "));
const onErrors = missingRefErrors(infographicOn, "1", bare);
check("on: no concept field, asset plan or novelty report is required", !onErrors.some((e) => e.includes("visual_concept_ref") || e.includes("selected_concept_id") || e.includes("asset_plan_ref") || e.includes("novelty_ref")), onErrors.join(" | "));
check("on: the other refs are still required", ["story_graph_ref", "editorial_discovery_ref"].every((f) => missingRefErrors(infographicOn, "1", { ...bare, [f]: "" }).some((e) => e.startsWith(`${f} is required`))));

// ---- preflight fill and prerequisite check ----
const preflight = await import(`${pathToFileURL(join(HERE, "runtime/pi/preflight.mjs")).href}`);
const io = (lean, files = {}) => ({ lean, list: async (dir) => Object.keys(files).filter((k) => k.startsWith(dir)), read: async (ref) => { if (!files[ref]) throw new Error(`no ${ref}`); return files[ref]; }, verified: async () => new Set(), manifest: async () => { throw new Error("none"); } });
const filledOff = await preflight.fillPlanRefs({ story_graph_ref: "editorial/story-graphs/a.json" }, io(false));
check("off: a plan with no concept is told it needs the selected concept", /selected_concept_id/.test(filledOff.unresolved.visual_concept_ref ?? ""));
const filledOn = await preflight.fillPlanRefs({ story_graph_ref: "editorial/story-graphs/a.json" }, io(true));
check("on: no concept lookup is attempted or reported", filledOn.unresolved.visual_concept_ref === undefined);
check("on: the discovery ref is asked for by name; no asset plan or novelty report is asked for", /supply editorial_discovery_ref/.test(filledOn.unresolved.editorial_discovery_ref ?? "") && filledOn.unresolved.novelty_ref === undefined && filledOn.unresolved.asset_plan_ref === undefined);
check("off: an asset plan with no concept is still reported", /needs visual_concept_ref/.test(filledOff.unresolved.asset_plan_ref ?? ""));
const files = { "editorial/novelty/a.json": { concept_ref: "editorial/concepts/gone.json", passed: true }, "editorial/assets/a.json": { concept_ref: "editorial/concepts/gone.json", concept_id: "c1", decision: "CONTINUE" } };
const base = { story_graph_ref: "editorial/story-graphs/a.json", novelty_ref: "editorial/novelty/a.json", asset_plan_ref: "editorial/assets/a.json", modules: [] };
const issuesOff = await preflight.planPrerequisiteIssues(base, io(false, files));
check("off: a novelty report and asset plan bound to a concept the page does not name are refused", issuesOff.some((i) => /novelty report does not belong/.test(i)) && issuesOff.some((i) => /asset plan does not belong/.test(i)), issuesOff.join(" | "));
const issuesOn = await preflight.planPrerequisiteIssues(base, io(true, files));
check("on: with no concept named there is no concept binding to refuse", !issuesOn.some((i) => /does not belong to the selected/.test(i)), issuesOn.join(" | "));
const issuesOnNamed = await preflight.planPrerequisiteIssues({ ...base, visual_concept_ref: "editorial/concepts/other.json" }, io(true, { ...files, "editorial/concepts/other.json": { finalists: ["c1"] } }));
check("on: a concept ref the model does give is still checked", issuesOnNamed.some((i) => /novelty report does not belong/.test(i)), issuesOnNamed.join(" | "));

// ---- item 3: novelty is a lint warning ----
const mod = (id, q, claim, info, dim) => ({ id, type: "chart", reader_question_id: q, claim_set: [claim], new_information: info, explanatory_dimension: dim, dependency_on: [] });
const twins = [mod("m1", "q1", "c1", "gdp doubled since 2000", "trend"), mod("m2", "q1", "c1", "gdp doubled since 2000", "trend"), mod("m3", "q2", "c2", "exports fell in 2020", "comparison")];
const nov = infographicOn.semanticNoveltyFindings(twins);
check("novelty: duplicated modules give a warning that names both", nov.warnings.some((w) => /m2|m1/.test(w) && /overlaps/.test(w)), JSON.stringify(nov));
const novDistinct = infographicOn.semanticNoveltyFindings([twins[0], twins[2]]);
check("novelty: distinct modules give no warning", novDistinct.warnings.length === 0, JSON.stringify(novDistinct));
const novNone = infographicOn.semanticNoveltyFindings([{ id: "a", type: "chart" }, { id: "b", type: "chart" }]);
check("novelty: modules without the fields are not compared and a note says so", novNone.warnings.length === 0 && novNone.notes.some((n) => /not compared/.test(n)), JSON.stringify(novNone));
const lintSpec = { ...bare, modules: twins };
const lintWith = (mod2, value) => { if (value === undefined) delete process.env.NEWSROOM_LEAN_GATES; else process.env.NEWSROOM_LEAN_GATES = value; try { return mod2.lintInfographicSpec(lintSpec); } finally { delete process.env.NEWSROOM_LEAN_GATES; } };
const lintOn = lintWith(infographicOn, "1");
const lintOff = lintWith(infographicOff, undefined);
check("lint on: the novelty warning is in warnings, never in errors", lintOn.warnings?.some((w) => /semantic_novelty/.test(w)) && !(lintOn.blockers ?? []).some((e) => /semantic_novelty/.test(e)), JSON.stringify(lintOn).slice(0, 300));
check("lint off: no novelty warning is added", !lintOff.warnings?.some((w) => /semantic_novelty/.test(w)));

// ---- item 4: coverage thresholds ----
const story = await import(`${pathToFileURL(join(HERE, "runtime/pi/story_graph.mjs")).href}`);
const sg = (extra = []) => ({
  reader_question: "why?", visual_thesis: "because",
  nodes: [["n1", "context", "trend"], ["n2", "mechanism", "mechanism"], ["n3", "outcome", "comparison"], ...extra].map(([id, kind, explanatory_dimension]) => ({ id, kind, summary: id, explanatory_dimension, claim_ids: [] })),
  edges: [{ from: "n1", to: "n2", relation: "causes" }, { from: "n2", to: "n3", relation: "explains" }],
  entry_node_ids: ["n1"], answer_node_ids: ["n3"],
});
const wide = sg([["n4", "context", "rank"], ["n5", "context", "rank"], ["n6", "context", "rank"]]);
const aOff = story.assessStoryGraph(wide);
const aOn = story.assessStoryGraph(wide, { lean: true });
check("story graph off: closure coverage 0.5 is a blocker", !aOff.passed && aOff.issues.some((i) => i.code === "story_graph_low_closure_coverage"), JSON.stringify(aOff.issues));
check("story graph lean: the same graph passes and the number is still reported", aOn.passed && aOn.metrics.closure_coverage === 0.5 && !aOn.issues.some((i) => i.code === "story_graph_low_closure_coverage"), JSON.stringify(aOn.issues));
const unreachable = sg([["n4", "context", "rank"]]); unreachable.edges = [{ from: "n1", to: "n2", relation: "causes" }, { from: "n4", to: "n3", relation: "explains" }];
check("story graph lean: an answer unreachable from the entry is still a blocker", !story.assessStoryGraph(unreachable, { lean: true }).passed && story.assessStoryGraph(unreachable, { lean: true }).issues.some((i) => i.code === "reader_question_not_closed"));
const qOff = story.evaluateQuestionClosure(wide, ["n1", "n3"], ["n3"]);
const qOn = story.evaluateQuestionClosure(wide, ["n1", "n3"], ["n3"], { lean: true });
check("closure off: 2 of 6 nodes mapped fails on coverage", qOff.passed === false && qOff.node_coverage < 0.6);
check("closure lean: entry and answer covered passes; coverage still reported", qOn.passed === true && qOn.node_coverage === qOff.node_coverage);
check("closure lean: missing entry is still refused", story.evaluateQuestionClosure(wide, ["n3"], ["n3"], { lean: true }).passed === false);
check("closure lean: missing answer coverage is still refused", story.evaluateQuestionClosure(wide, ["n1"], [], { lean: true }).passed === false);
check("closure lean: answer covered but not resolved is still refused", story.evaluateQuestionClosure(wide, ["n1", "n3"], [], { lean: true }).passed === false);
const contract = await import(`${pathToFileURL(join(HERE, "runtime/pi/contract_text.mjs")).href}`);
const cArgs = { readerTasks: new Set(), visualGrammarForms: undefined, registry: null };
check("contract text off: still states the 60% coverage", contract.contractStatements(cArgs).modules.includes("at least 60% of the story-graph nodes"));
const leanText = contract.contractStatements({ ...cArgs, lean: true }).modules;
check("contract text lean: no coverage percentage, sentence still well formed", !/%/.test(leanText) && /resolution or explanation\.$/.test(leanText), leanText.slice(-120));

// ---- item 5: scene graph from panels ----
const sb = await import(`${pathToFileURL(join(HERE, "runtime/pi/storyboard.mjs")).href}`);
const board = JSON.parse(readFileSync(join(HERE, "fixtures/lean-gates/storyboard-4-panel-plan.json"), "utf8"));
const { scene_graph: modelGraph, content_hash: _h, ...boardNoGraph } = board;
const derived = sb.deriveSceneGraphFromPanels(boardNoGraph);
check("scene graph: the 4-panel stand-in page derives two scenes (the two panels with a chart body)", derived.scene_graph?.scenes.length === 2 && derived.scene_graph.scenes.map((x) => x.anchor_module_id).join() === "m_wave,m_tile", JSON.stringify(derived).slice(0, 300));
check("scene graph: sidecar is the panel's note, goal follows the panel kind", derived.scene_graph.scenes.map((x) => `${x.sidecar_module_ids}:${x.primary_cognitive_goal}`).join() === "t2:MEASURE,t4:COMPARE");
const shuffled = { ...boardNoGraph, modules: [...boardNoGraph.modules].reverse() };
check("scene graph: same page, same graph, whatever the module order", JSON.stringify(sb.deriveSceneGraphFromPanels(shuffled).scene_graph) === JSON.stringify(derived.scene_graph));
process.env.NEWSROOM_LEAN_GATES = "1"; process.env.NEWSROOM_STORYBOARD = "1";
const filledBoard = sb.withDerivedSceneGraph(boardNoGraph);
const boardErrors = infographicOn.validateInfographicSpec({ ...filledBoard, schema_version: "1.5.0" }).filter((e) => /scene/i.test(e));
delete process.env.NEWSROOM_LEAN_GATES; delete process.env.NEWSROOM_STORYBOARD;
check("scene graph: the derived graph passes the page's scene checks", boardErrors.length === 0, boardErrors.join(" | "));
const editorialValidators = await import(`${pathToFileURL(join(HERE, "runtime/pi/editorial_validators.mjs")).href}`);
const budgetIssues = editorialValidators.sceneCognitiveBudgetValidator(filledBoard).filter((i) => i.severity === "ERROR" || i.severity === "FATAL");
check("scene graph: the derived graph passes the scene budget validator", budgetIssues.length === 0, JSON.stringify(budgetIssues).slice(0, 300));
let refusal = "";
try { sb.withDerivedSceneGraph(board); } catch (e) { refusal = String(e.message); }
check("scene graph: one the model wrote is refused with 由格子生成", /由格子生成/.test(refusal), refusal);
let none = "";
try { sb.withDerivedSceneGraph({ ...boardNoGraph, modules: boardNoGraph.modules.map((m) => (m.type === "visual" ? { ...m, type: "hero_stat" } : m)) }); } catch (e) { none = String(e.message); }
check("scene graph: no chart body, no scene, a clear refusal", /no panel has a visual or illustration body/.test(none), none);
const manyPanels = (n) => { const modules = []; for (let i = 1; i <= n; i += 1) modules.push({ id: `p${i}`, type: "panel", panel_no: i, body_module_id: `b${i}`, note_module_id: `t${i}` }, { id: `b${i}`, type: "visual", claim_ids: [`c${i}`] }, { id: `t${i}`, type: "text" }); return { modules }; };
check("scene graph: seven chart panels are refused (a graph holds six scenes)", sb.deriveSceneGraphFromPanels(manyPanels(7)).errors.some((e) => /at most 6/.test(e)) && sb.deriveSceneGraphFromPanels(manyPanels(6)).scene_graph?.scenes.length === 6);
const sbOn = await toolsWith("1", "full", true), sbOff = await toolsWith(undefined, "full", true), plainOn = await toolsWith("1", "full", false);
check("scene graph tool def: optional only with lean AND storyboard", !sbOn.newsroom_infographic_plan.parameters.required.includes("scene_graph") && sbOff.newsroom_infographic_plan.parameters.required.includes("scene_graph") && plainOn.newsroom_infographic_plan.parameters.required.includes("scene_graph"));
check("scene graph guideline: lean storyboard says to leave it out", sbOn.newsroom_infographic_plan.promptGuidelines.some((g) => /leave scene_graph out/.test(g)) && !sbOff.newsroom_infographic_plan.promptGuidelines.some((g) => /leave scene_graph out/.test(g)));

// ---- item 6: editorial grammar derived from the page ----
const eg = await import(`${pathToFileURL(join(HERE, "runtime/pi/editorial_grammar.mjs")).href}`);
const registry = JSON.parse(readFileSync(join(HERE, "config/editorial-grammar-registry.json"), "utf8"));
const lean = (input, spec, reg = registry) => eg.materializeLeanEditorialGrammarSelection(input, spec, reg);
const refusalOf = (fn) => { try { fn(); return ""; } catch (e) { return String(e.message); } };
const gSpec = { modules: board.modules, scene_graph: derived.scene_graph, chartTypes: {}, story_graph_ref: board.story_graph_ref };
const facts = eg.deriveEditorialGrammarFacts(gSpec);
check("grammar facts: goals come from the derived scene graph (MEASURE, COMPARE)", facts.cognitive_goals.join() === "COMPARE,MEASURE", facts.cognitive_goals.join());
check("grammar facts: evidence from the modules (a trend chart, a spatial chart, numbers)", facts.evidence_features.join() === "comparable_timepoints,quantity,spatial_structure", facts.evidence_features.join());
check("grammar facts: a spatial chart adds webgl_map", facts.available_renderer_capabilities.join() === "canvas2d,svg,webgl_map", facts.available_renderer_capabilities.join());
check("grammar facts: project_id is the story graph file name", facts.project_id === board.story_graph_ref.split("/").pop().replace(/\.json$/, ""), facts.project_id);
const noMap = eg.deriveEditorialGrammarFacts({ ...gSpec, modules: gSpec.modules.map((m) => (m.id === "m_tile" ? { ...m, visual_grammar: "rank" } : m)) });
check("grammar facts: no map chart, no webgl_map", noMap.available_renderer_capabilities.join() === "canvas2d,svg");
check("grammar facts: a chart type that is a map adds webgl_map even if the form says otherwise", eg.deriveEditorialGrammarFacts({ ...gSpec, modules: gSpec.modules.map((m) => (m.id === "m_tile" ? { ...m, visual_grammar: "rank" } : m)), chartTypes: { m_tile: "choropleth" } }).available_renderer_capabilities.includes("webgl_map"));
check("grammar facts: people_dots / clock_dial give human_scale_reference, other charts do not", eg.deriveEditorialGrammarFacts({ ...gSpec, chartTypes: { m_wave: "clock_dial" } }).evidence_features.includes("human_scale_reference") && eg.deriveEditorialGrammarFacts({ ...gSpec, chartTypes: { m_wave: "people_dots" } }).evidence_features.includes("human_scale_reference") && !facts.evidence_features.includes("human_scale_reference"));
const auto = lean({}, gSpec);
check("grammar: with no input the program picks a legal primary and the result lints clean", !!auto.primary && eg.lintEditorialGrammarSelection(auto, registry).passed === true, JSON.stringify(eg.lintEditorialGrammarSelection(auto, registry)));
check("grammar: the stored selection is the full object (project_id, 3 candidates, decision log)", auto.project_id === facts.project_id && auto.candidates?.length === 3 && Array.isArray(auto.decision_log), Object.keys(auto).join());
check("grammar: the stand-in page's own pick (THEMATIC_MAP) is accepted and its supporting set is derived", lean({ primary: "THEMATIC_MAP" }, gSpec).primary === "THEMATIC_MAP");
// tie: trend + rank under ORIENT is covered by SPECIMEN_GRID + one supporting and by THEN_NOW + one supporting
const tieSpec = (order = 1) => { const mods = [{ id: "v0", type: "visual", visual_grammar: "trend" }, { id: "v1", type: "visual", visual_grammar: "rank" }, { id: "h", type: "hero_stat" }]; return { modules: order > 0 ? mods : [...mods].reverse(), scene_graph: { scenes: [{ primary_cognitive_goal: "ORIENT" }] }, chartTypes: {}, story_graph_ref: "editorial/story-graphs/x.json" }; };
const tieSizes = Object.fromEntries(eg.EDITORIAL_GRAMMARS.map((g) => { try { return [g, lean({ primary: g }, tieSpec()).supporting.length]; } catch { return [g, null]; } }).filter(([, n]) => n !== null));
check("grammar tie: two primaries are legal with the same (smallest) number of supporting grammars", tieSizes.SPECIMEN_GRID === 1 && tieSizes.THEN_NOW === 1 && Math.min(...Object.values(tieSizes)) === 1, JSON.stringify(tieSizes));
const tieRuns = [lean({}, tieSpec(1)), lean({}, tieSpec(-1)), lean({}, tieSpec(1), { ...registry, grammars: [...registry.grammars].reverse() })];
check("grammar tie: same page, same pick whatever the module or registry order", new Set(tieRuns.map((r) => `${r.primary}|${r.supporting}`)).size === 1, tieRuns.map((r) => `${r.primary}|${r.supporting}`).join(" ; "));
const tieRank = eg.rankEditorialGrammarCandidates({ evidence_features: ["comparable_timepoints", "comparable_entities", "quantity"], cognitive_goals: ["ORIENT"], available_renderer_capabilities: ["canvas2d", "svg"] }, registry).map((c) => c.grammar);
check("grammar tie: the tie goes to the existing rank order", tieRuns[0].primary === (tieRank.indexOf("SPECIMEN_GRID") < tieRank.indexOf("THEN_NOW") ? "SPECIMEN_GRID" : "THEN_NOW"), `${tieRuns[0].primary} / ${tieRank.join()}`);
check("grammar: a primary the model names is checked as before (an ineligible one is refused)", /PRIMARY_INELIGIBLE/.test(refusalOf(() => lean({ primary: "SCALE_TRANSLATOR" }, gSpec))));
// derived fields: equal is accepted, different is refused with 由程序推出
check("grammar derived field: the same value is accepted", !refusalOf(() => lean({ project_id: facts.project_id, cognitive_goals: ["MEASURE", "COMPARE"], evidence_features: [...facts.evidence_features].reverse(), available_renderer_capabilities: facts.available_renderer_capabilities }, gSpec)));
for (const [field, value] of [["project_id", "other"], ["cognitive_goals", ["EXPLAIN"]], ["evidence_features", ["quantity"]], ["available_renderer_capabilities", ["svg"]]]) {
  check(`grammar derived field: a different ${field} is refused with 由程序推出`, /由程序推出/.test(refusalOf(() => lean({ [field]: value }, gSpec))));
}
check("grammar: no scene, no goals, a clear refusal", /GOALS_UNDERIVABLE/.test(refusalOf(() => lean({}, { ...gSpec, scene_graph: { scenes: [] } }))));
// the two model-reported features
const scaleSpec = { ...gSpec, scene_graph: { scenes: [{ primary_cognitive_goal: "MEASURE" }] }, modules: [{ id: "v0", type: "visual", visual_grammar: "change" }, { id: "h", type: "hero_stat" }] };
const scaleOk = lean({ primary: "SCALE_TRANSLATOR" }, { ...scaleSpec, chartTypes: { v0: "clock_dial" } });
check("grammar: SCALE_TRANSLATOR is eligible when a clock_dial chart gives human_scale_reference", scaleOk.primary === "SCALE_TRANSLATOR");
check("grammar: SCALE_TRANSLATOR is refused when human_scale_reference is missing", /PRIMARY_INELIGIBLE/.test(refusalOf(() => lean({ primary: "SCALE_TRANSLATOR" }, scaleSpec))));
check("grammar: self-reported human_scale_reference is accepted, recorded 模型自报 and lints clean", (() => { const r = lean({ primary: "SCALE_TRANSLATOR", reported_evidence_features: ["human_scale_reference"] }, scaleSpec); return r.primary === "SCALE_TRANSLATOR" && r.decision_log.some((d) => /模型自报:human_scale_reference/.test(d.reason_code)) && eg.lintEditorialGrammarSelection(r, registry).passed; })());
const solo = (feature, primary, modules) => refusalOf(() => lean({ primary, reported_evidence_features: [feature] }, { ...gSpec, scene_graph: { scenes: [{ primary_cognitive_goal: "MEASURE" }] }, modules }));
check("grammar: human_scale_reference alone does not make SCALE_TRANSLATOR eligible (no quantity)", /PRIMARY_INELIGIBLE/.test(solo("human_scale_reference", "SCALE_TRANSLATOR", [{ id: "t", type: "text" }])));
const routeNeeds = registry.grammars.find((g) => g.id === "ROUTE_SPINE")?.required_evidence ?? [];
check("grammar: ROUTE_SPINE needs more than verified_locations", routeNeeds.length > 1 && routeNeeds.includes("verified_locations"), routeNeeds.join());
check("grammar: verified_locations alone does not make ROUTE_SPINE eligible", /PRIMARY_INELIGIBLE/.test(solo("verified_locations", "ROUTE_SPINE", [{ id: "v0", type: "visual", visual_grammar: "trend" }])));
check("grammar: a derived feature cannot be 'reported'", /REPORTED_EVIDENCE/.test(refusalOf(() => lean({ reported_evidence_features: ["quantity"] }, gSpec))));
// the tool definition, on and off
const gOn = on.newsroom_infographic_plan.parameters.properties.editorial_grammar, gOff = off.newsroom_infographic_plan.parameters.properties.editorial_grammar;
check("grammar tool def off: editorial_grammar and its six fields are required, no reported_evidence_features", off.newsroom_infographic_plan.parameters.required.includes("editorial_grammar") && gOff.required.length === 6 && !gOff.properties.reported_evidence_features);
check("grammar tool def on: editorial_grammar and every field in it are optional", !on.newsroom_infographic_plan.parameters.required.includes("editorial_grammar") && gOn.required.length === 0, JSON.stringify(gOn.required));
check("grammar tool def on: only the two reportable features are offered", JSON.stringify(gOn.properties.reported_evidence_features.items.enum) === JSON.stringify(["human_scale_reference", "verified_locations"]));
check("grammar guideline: off keeps the old text, on says the system derives the rest", off.newsroom_infographic_plan.promptGuidelines.some((g) => /Supply only evidence features, cognitive goals and renderer capabilities/.test(g)) && on.newsroom_infographic_plan.promptGuidelines.some((g) => /derives project_id/.test(g)) && !on.newsroom_infographic_plan.promptGuidelines.some((g) => /Supply only evidence features/.test(g)));

// ---- (d) no text names a removed tool when lean ----
const SPEED_ENV = ["NEWSROOM_SPEED_PREFLIGHT", "NEWSROOM_SPEED_COMPACT_SETUP", "NEWSROOM_SPEED_EDITORIAL_HINTS", "NEWSROOM_CONCEPT_COUNT_3"];
const withSpeed = async (value, storyboard) => { for (const k of SPEED_ENV) process.env[k] = "1"; try { return await toolsWith(value, "full", storyboard); } finally { for (const k of SPEED_ENV) delete process.env[k]; } };
const textsOf = (tools) => Object.values(tools).flatMap((t) => [t.name, t.description ?? "", t.promptSnippet ?? "", ...(t.promptGuidelines ?? [])].map((x) => `${t.name}: ${x}`));
const REMOVED = /newsroom_visual_concepts|newsroom_semantic_novelty|newsroom_asset_requirements|concept tournament|visual concept tournament/;
const leanSpeed = await withSpeed("1", false), offSpeed = await withSpeed(undefined, false);
const leanHits = textsOf(leanSpeed).filter((x) => REMOVED.test(x.slice(x.indexOf(": ") + 2)) && !/^newsroom_award_mode_status/.test(x));
check("lean text: no tool description or guideline names a removed tool (speed hints on)", leanHits.length === 0, leanHits.map((x) => x.slice(0, 160)).join(" || "));
const leanRefHits = textsOf(leanSpeed).filter((x) => /visual_concept_ref|novelty_ref|asset_plan_ref/.test(x) && !/^newsroom_award_mode_status/.test(x));
check("lean text: no guideline tells the model to supply the concept, novelty or asset-plan ref", leanRefHits.length === 0, leanRefHits.map((x) => x.slice(0, 160)).join(" || "));
check("lean text: the plan speed hint still says what may be omitted, and the discovery turn plan stays", leanSpeed.newsroom_infographic_plan.promptGuidelines.some((g) => /You may omit reader_question, visual_thesis, editorial_discovery_ref and a visual module's critic_ref/.test(g)) && leanSpeed.newsroom_editorial_discovery.promptGuidelines.some((g) => /Page setup turn plan/.test(g)));
check("off text: the speed hints are the old ones, word for word", offSpeed.newsroom_infographic_plan.promptGuidelines.some((g) => /visual_concept_ref, novelty_ref, asset_plan_ref and a visual module's critic_ref/.test(g)) && offSpeed.newsroom_editorial_discovery.promptGuidelines.some((g) => /newsroom_visual_concepts needs the discovery artifact/.test(g)) && !!offSpeed.newsroom_visual_concepts);
check("lean text: the viz plan no longer says 'concept selection'", !leanSpeed.newsroom_viz_plan.promptGuidelines.some((g) => /concept selection/.test(g)) && offSpeed.newsroom_viz_plan.promptGuidelines.some((g) => /concept selection/.test(g)));
const preflightLean = await preflight.fillPlanRefs({ story_graph_ref: "editorial/story-graphs/a.json", selected_concept_id: "c1" }, io(true));
check("lean text: a given selected_concept_id with no concept set is told to leave it out, not to call the removed tool", !/newsroom_visual_concepts/.test(preflightLean.unresolved.visual_concept_ref ?? "") && /leave selected_concept_id out/.test(preflightLean.unresolved.visual_concept_ref ?? ""), JSON.stringify(preflightLean.unresolved));

console.log(`${passed} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
