// Gate fixes from the close-round review (K37-K41), through the real tool path. The harness is copied from
// test_hero_value_tool_path.mjs (same fixtures, same loader). Offline.
// (copied header follows) H1b: the hero value gate through the real tool path. With the gate on (the default; NEWSROOM_HERO_VALUE_GATE=0 turns it
// off) the newsroom_infographic_lint tool must read each hero_stat's claim computation (refs are written as "computations/<hash>.json") and block a
// value that is not in those rows. test_hero_value_gate.mjs covers the pure lint; this covers the newsroom.ts wiring,
// on a temp artifact root with a system-verified claim whose computation record has real rows. Offline.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chartSvgText, checkReaderText } from "../runtime/pi/infographic.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_HERO_VALUE_GATE", "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT"];
const INVIS = [["zwsp", "\u200b", "亿美元"], ["wj", "\u2060", "亿美元"], ["shy", "\u00ad", "亿美元"], ["bom", "\ufeff", "亿美元"], ["mvs", "\u180e", "亿美元"], ["nel", "\u0085", "亿美元"],
    ["mixed", "\u200b\u2060\u00ad\ufeff\u180e", "亿美元"], ["spmixed", " \u200b \u2060", "亿美元"], ["en-zwsp", "\u200b", "million tonnes"], ["inword", " ", "mil\u00adlion tonnes"], ["inword2", " ", "mil\u200blion tonnes"], ["pct", "\u200b", "%"]];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
// ---- loader: one type-stripped copy of the runtime, a fresh module instance per configuration -----------
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
const TREE = mkdtempSync(join(tmpdir(), "speed-gates-tree-"));
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));


let loadN = 0;
async function registerFor(cfg, { phase, profile } = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = profile ?? cfg.profile ?? "full";
  if (phase) process.env.NEWSROOM_PHASE = phase;
  for (const [k, v] of Object.entries(cfg.env)) process.env[k] = v;
  const tools = new Map();
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++loadN}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const readerQuestion = "How did the geography and scale of estimated international migration flows change?";
const visualThesis = "A route-led world view connects changing corridors to regional composition and long-run change.";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fafafa"/><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const VIZ = [["map", "geo_flow_map", "c-map"], ["sankey", "sankey", "c-flow"], ["trend", "line", "c-trend"]];
// verbatim from test_plan_edit_runtime.mjs: a full artifact root with verified claims, a computation, charts and editorial files
function freshRun(label, { manifestClaim = {}, criticPassed = {}, draft = {}, verifiedOnly = null } = {}) {
  const art = join(mkdtempSync(join(tmpdir(), `planedit-${label}-`)), "run");
  for (const d of ["visualizations/critics", "editorial/story-graphs", "editorial/discovery", "editorial/concepts", "editorial/novelty", "editorial/assets", "infographics/plans", "infographics/lints", "infographics/previews", "runtime"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  cpSync(join(ROOT, "runtime", "pi", "rasterize_svg.py"), join(art, "runtime", "rasterize_svg.py"));
  // Claim-to-chart binding gate: the charts and the claims must come out of one recorded
  // computation that reads a real data/ file (the fixture used to carry no computation at all).
  mkdirSync(join(art, "data"), { recursive: true });
  mkdirSync(join(art, "computations"), { recursive: true });
  const csv = "region,value\nA,1\nB,2\n";
  const csvSha = createHash("sha256").update(csv).digest("hex");
  writeFileSync(join(art, "data", "x.csv"), csv);
  writeFileSync(join(art, "data", "x.meta.json"), JSON.stringify({ file: "x.csv", sha256: csvSha }));
  const computation = { schema_version: "0.7.0", sql: "SELECT region, value FROM 'data/x.csv' ORDER BY region", input_snapshot_hash: csvSha, input_fingerprints: [`data:x.csv:${csvSha}`], read_inputs: [{ path: "data/x.csv", sha256: csvSha }], input_binding: "source_bound", result_hash: csvSha, rows: [{ region: "A", value: 1, delta: 9, year: 2017 }, { region: "B", value: 2, delta: -9, year: 2018 }] };
  const computationRef = `computations/${createHash("sha256").update(JSON.stringify(computation)).digest("hex")}.json`;
  writeFileSync(join(art, computationRef), JSON.stringify(computation));
  const tie = { ...computation, rows: [{ region: "A", value: 9 }, { region: "B", value: 9 }] };
  const tieRef = `computations/${createHash("sha256").update(JSON.stringify(tie)).digest("hex")}.json`;
  writeFileSync(join(art, tieRef), JSON.stringify(tie));
  // c-outcome and c-trend are record_claim claims (no bindings) whose text states the number; c-inline is an inline claim.
  const texts = { "c-outcome": "Region B has the largest value, 2 units, and a change of +9 in the first year.", "c-trend": "Region B reached 2 on the value trend.", "c-rose": "Region B rose to 2 million.", "c-thou": "Region B holds 1,2 units." };
  const inlineClaim = (template, text) => ({ claim: text, claim_template: template, claim_bindings: [{ placeholder: "{max.value}", column: "value", row_index: 1, value: 2, text: "2" }], recorded_by: "newsroom_viz_plan" });
  const regionBinding = { placeholder: "{max.value.region}", column: "region", row_index: 1, value: "B", text: "B" };
  const withRegion = (claim) => ({ ...claim, claim_bindings: [...claim.claim_bindings, regionBinding] });
  // Claims the system bound (claim_bindings): the only ones a hero may use. c-outcome, c-rose and c-thou stay unbound (record_claim).
  const inlines = {
    "c-bound": withRegion(inlineClaim("Region {max.value.region} has the largest value, {max.value} units.", "Region B has the largest value, 2 units.")),
    "c-trend": withRegion(inlineClaim("Region {max.value.region} reached {max.value} on the value trend.", "Region B reached 2 on the value trend.")),
    "c-million": inlineClaim("Output reached {max.value} million tonnes.", "Output reached 2 million tonnes."),
    "c-times": inlineClaim("It is {max.value} 3 times larger.", "It is 2 3 times larger."),
    "c-yi": inlineClaim("Reserves reached {max.value}亿美元 in total.", "Reserves reached 2亿美元 in total."),
    "c-pct": inlineClaim("The share is {max.value}% of the total.", "The share is 2% of the total."),
    "c-pct-sp": inlineClaim("The share is {max.value} % of the total.", "The share is 2 % of the total."),
    "c-pct-sp2": inlineClaim("The share is {max.value}  % of the total.", "The share is 2  % of the total."),
    "c-pct-nbsp": inlineClaim("The share is {max.value}\u00a0% of the total.", "The share is 2\u00a0% of the total."),
    "c-pct-nl": inlineClaim("The share is {max.value}\n% of the total.", "The share is 2\n% of the total."),
    "c-mil-sp2": inlineClaim("Output reached {max.value}  million tonnes.", "Output reached 2  million tonnes."),
    ...Object.fromEntries(INVIS.map(([name, gap, word]) => [`c-inv-${name}`, inlineClaim(`Reserves reached {max.value}${gap}${word} in total.`, `Reserves reached 2${gap}${word} in total.`)])),
    "c-yi-sp": inlineClaim("Reserves reached {max.value} 亿美元 in total.", "Reserves reached 2 亿美元 in total."),
  };
  const inlineTemplate = "The top value is {max.value}% in {max.value.region} in {max.value.year}.";
  const inline = { claim: "The top value is 2% in B in 2018.", claim_template: inlineTemplate, claim_bindings: [
    { placeholder: "{max.value}", column: "value", row_index: 1, value: 2, text: "2" },
    { placeholder: "{max.value.region}", column: "region", row_index: 1, value: "B", text: "B" },
    { placeholder: "{max.value.year}", column: "year", row_index: 1, value: 2018, text: "2018" }], recorded_by: "newsroom_viz_plan" };
  const claims = ["c-map", "c-flow", "c-trend", "c-outcome", "c-inline", "c-rose", "c-thou", "c-million", "c-times", "c-bound", "c-yi", "c-pct", "c-pct-sp", "c-pct-sp2", "c-pct-nbsp", "c-pct-nl", "c-mil-sp2", "c-yi-sp", "c-tie", ...INVIS.map(([name]) => `c-inv-${name}`)].filter((id) => !verifiedOnly || verifiedOnly.includes(id)).map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: ["data/x.csv"], computation_refs: [computationRef], verification, ...(texts[claim_id] ? { claim: texts[claim_id] } : {}), ...(claim_id === "c-tie" ? { claim: "Region A has 9 and region B has 9.", computation_refs: [tieRef] } : {}), ...(claim_id === "c-inline" ? inline : {}), ...(inlines[claim_id] ?? {}) }));
  writeFileSync(join(art, "claims.jsonl"), `${claims.join("\n")}\n`);
  for (const [id, chart_type, claim_id] of VIZ) {
    writeFileSync(join(art, `visualizations/${id}.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.mobile.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.json`), JSON.stringify({
      chart_type, claim_id: manifestClaim[id] ?? claim_id, computation_ref: computationRef, ...(id === "trend" ? { plan_ref: "visualizations/plans/trend.json" } : {}), source_note: "Gaskin and Abel model estimates, 1990-2023",
      verification_mode: "verified", artifact_status: draft[id] ? "DRAFT" : "VERIFIED", publishable: draft[id] ? false : true,
      variants: { desktop: `visualizations/${id}.svg`, mobile: `visualizations/${id}.mobile.svg` },
    }));
    writeFileSync(join(art, `visualizations/critics/${id}.json`), JSON.stringify({ passed: criticPassed[id] ?? true, score: 90, manifest_ref: `visualizations/${id}.json` }));
  }
  mkdirSync(join(art, "visualizations/plans"), { recursive: true });
  writeFileSync(join(art, "visualizations/plans/trend.json"), JSON.stringify({ measure_semantics: [{ id: "m-value", field: "value", phenomenon: "volume", unit: "t", measure_kind: "mass", temporal_basis: { type: "period" } }] }));
  const graph = assessStoryGraph({
    story_id: "migration", reader_question: readerQuestion, visual_thesis: visualThesis,
    nodes: [
      { id: "n-map", kind: "evidence", summary: "Estimated corridors form a changing world geography.", explanatory_dimension: "spatial", claim_ids: ["c-map"] },
      { id: "n-composition", kind: "evidence", summary: "Regional composition concentrates and disperses over time.", explanatory_dimension: "distribution", claim_ids: ["c-flow"] },
      { id: "n-change", kind: "outcome", summary: "The route system changes in scale and destination structure.", explanatory_dimension: "trend", claim_ids: ["c-trend", "c-outcome"] },
    ],
    edges: [{ from: "n-map", to: "n-composition", relation: "explains" }, { from: "n-composition", to: "n-change", relation: "precedes" }],
    entry_node_ids: ["n-map"], answer_node_ids: ["n-change"],
  });
  writeFileSync(join(art, "editorial/story-graphs/migration.json"), JSON.stringify(graph));
  writeFileSync(join(art, "editorial/discovery/migration.json"), JSON.stringify({ decision: "CONTINUE" }));
  writeFileSync(join(art, "editorial/concepts/migration.json"), JSON.stringify({ finalists: ["route-spine"], discovery_ref: "editorial/discovery/migration.json" }));
  writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: true }));
  writeFileSync(join(art, "editorial/assets/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", concept_id: "route-spine", decision: "CONTINUE" }));
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}

const pageRoot = (label) => freshRun(label);

const quantitative = { quantity_kind: "estimated_flow", mark_semantics: "flow_width", scale_type: "linear", baseline_policy: "not_applicable", uncertainty_disclosed: true, disclosure: "Mean estimates are shown; standard deviation is available in the source data." };
// The model's page plan; reader_question / visual_thesis are left out unless asked for.
function pagePlan({ withQuestion = false, moduleClaims = {}, readerQuestionOverride } = {}) {
  const editorial_grammar = {
    project_id: "migration", primary: "ROUTE_SPINE", supporting: ["THEN_NOW", "SCALE_TRANSLATOR"],
    available_renderer_capabilities: ["svg", "canvas2d"],
    evidence_features: ["origin_destination_relation", "verified_locations", "comparable_timepoints", "quantity", "human_scale_reference"],
    cognitive_goals: ["ORIENT", "ZOOM", "MEASURE", "COMPARE", "CONSEQUENCE"],
  };
  const plan = {
    title: "The routes moved", dek: "A route-led account of changing estimated migration flows.",
    alt: "A world route map, regional Sankey and trend view explain changes in model-estimated international migration flows.",
    layout: "feature", complexity_budget: "medium", intent: "Explain changing migration geography without confusing estimated flows and stocks.",
    primary_message: "The geography and scale of estimated routes changed together.",
    story_graph_ref: "editorial/story-graphs/migration.json", story_arc: "question_answer", audience: "general", quality_target: "publishable", competition_profile: "editorial",
    editorial_discovery_ref: "editorial/discovery/migration.json", visual_concept_ref: "editorial/concepts/migration.json", selected_concept_id: "route-spine",
    novelty_ref: "editorial/novelty/migration.json", asset_plan_ref: "editorial/assets/migration.json", editorial_grammar,
    mobile_module_order: ["map", "flow", "trend", "resolution"],
    scene_graph: { schema_version: "0.2.0", scenes: [
      { id: "orient", pattern: "hero_with_rail", anchor_module_id: "map", sidecar_module_ids: ["flow"], primary_cognitive_goal: "ORIENT", hero_object_id: "route-a", supporting_claim_ids: ["c-map", "c-flow"], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
      { id: "compare", pattern: "hero_with_rail", anchor_module_id: "trend", sidecar_module_ids: ["resolution"], primary_cognitive_goal: "COMPARE", hero_object_id: "trend", supporting_claim_ids: ["c-trend", "c-outcome"], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } },
    ] },
    modules: [
      { id: "map", type: "visual", span: "full", manifest_ref: "visualizations/map.json", critic_ref: "visualizations/critics/map.json", ...(moduleClaims.map ? { claim_ids: moduleClaims.map } : {}), visual_grammar: "spatial", story_node_ids: ["n-map"], story_role: "hook", priority: 1, emphasis: "hero", claim_set: ["c-map"], graphic_object_ids: ["route-a"], annotations: [{ id: "map-note", target_object_id: "route-a", text: "A model-estimated route, not an observed journey.", claim_id: "c-map" }], visual_channels: [{ channel: "size", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "origin_destination", role: "identity" }], quantitative_encoding: quantitative },
      { id: "flow", type: "visual", span: "full", manifest_ref: "visualizations/sankey.json", critic_ref: "visualizations/critics/sankey.json", visual_grammar: "flow", story_node_ids: ["n-composition"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-flow"], graphic_object_ids: ["regional-links"], visual_channels: [{ channel: "length", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "region_pair", role: "identity" }], quantitative_encoding: quantitative },
      { id: "trend", type: "visual", span: "full", manifest_ref: "visualizations/trend.json", critic_ref: "visualizations/critics/trend.json", visual_grammar: "trend", story_node_ids: ["n-change"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-trend"], graphic_object_ids: ["trend-line"], visual_channels: [{ channel: "position", field: "estimated_flow_mean", role: "quantitative" }, { channel: "color", field: "year", role: "categorical" }], quantitative_encoding: { ...quantitative, mark_semantics: "position" } },
      { id: "resolution", type: "text", span: "third", body: "The result is a changed route system, not a direct reading of migrant-stock differences.", claim_ids: ["c-outcome"], claim_set: ["c-outcome"], story_node_ids: ["n-change"], story_role: "resolution", priority: 2, emphasis: "support" },
    ],
  };
  // Appended last, where the chain's fill puts them: the plan hash depends on key order.
  return withQuestion ? { ...plan, reader_question: readerQuestionOverride ?? readerQuestion, visual_thesis: visualThesis } : plan;
}

const keyOrder = (tools, plan) => { const keys = Object.keys(tools.get("newsroom_infographic_plan").parameters.properties); return Object.fromEntries([...keys.filter((k) => k in plan), ...Object.keys(plan).filter((k) => !keys.includes(k))].map((k) => [k, plan[k]])); };

const results = [];
// Runs plan + lint with a hero module; returns what the plan tool said (or threw) and the lint's hero blockers.
const heroRun = async (gate, hero, { verifiedOnly = null, claim_id = "c-bound", emptyAfterPlan = false, dropRows = false, manifestClaim = {}, inline = false, mutateRows = null, claimsEdit = null, extraEnv = {} } = {}) => {
  const art = freshRun("hero", { verifiedOnly, manifestClaim });
  if (claimsEdit) writeFileSync(join(art, "claims.jsonl"), `${claimsEdit(readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean)).join("\n")}\n`);
  const claimRecord = () => readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((c) => c.claim_id === claim_id);
  if (dropRows) rmSync(join(art, claimRecord().computation_refs[0]));
  if (mutateRows) { const file = join(art, claimRecord().computation_refs[0]); const computation = JSON.parse(readFileSync(file, "utf8")); writeFileSync(file, JSON.stringify({ ...computation, rows: mutateRows(computation.rows) })); }
  const plan = pagePlan({ withQuestion: true });
  plan.modules.push({ id: "hero", type: "hero_stat", span: "third", label: "Largest regional value", claim_id, story_node_ids: ["n-change"], story_role: "evidence", ...hero });
  plan.mobile_module_order = [...plan.mobile_module_order, "hero"];
  // Gate on is the default: no switch is set. The old path (typed hero values) is asked for with NEWSROOM_HERO_VALUE_GATE=0.
  const tools = await registerFor({ env: { ...(gate ? { NEWSROOM_MOBILE_PAGES: "0" } : { NEWSROOM_HERO_VALUE_GATE: "0" }), ...extraEnv, ...(inline ? { NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" } : {}) } });
  let planned;
  try { planned = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, plan)); } catch (error) { return { refused: String(error.message), art, tools }; }
  const planRef = refOf(planned, "planRef");
  const stored = JSON.parse(readFileSync(join(art, planRef), "utf8")).modules.find((m) => m.id === "hero");
  if (emptyAfterPlan) writeFileSync(join(art, "claims.jsonl"), ""); // the verified set is empty from here on
  const l = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: planRef });
  return { planRef, stored, lint: l, blockers: (l.details.blockers ?? []).filter((b) => b.includes("'hero'")), art, tools };
};
const ok = async (name, f) => { await f(); results.push(name); console.log(`  ok  ${name}`); };
const refOf = (res, name) => { must(res?.details?.[name], `no ${name} in the result`); return res.details[name]; };
const refused = async (name, hero, re, opts) => ok(`refused: ${name}`, async () => {
  const r = await heroRun(true, hero, opts);
  must(r.refused && re.test(r.refused), `expected a refusal matching ${re}, got ${JSON.stringify(r.refused ?? r.blockers)}`);
});


const asRecord = (line) => JSON.parse(line);
const revoked = (id) => JSON.stringify({ claim_id: id, status: "draft", verification: { authority: "system", publishable: false } });
const verifiedLine = (lines, id) => lines.find((l) => asRecord(l).claim_id === id);

// ---- K38: the latest record per claim_id decides ----
await ok("K38 a later non-verified record revokes: a hero citing it gets HERO_CLAIM_NOT_VERIFIED", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-bound", claimsEdit: (lines) => [...lines, revoked("c-bound")] });
  must(r.refused && /HERO_CLAIM_NOT_VERIFIED/.test(r.refused), `got ${JSON.stringify(r.refused ?? r.blockers)}`);
});
await ok("K38 control: verified once, the hero passes", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-bound" });
  must(!r.refused, r.refused);
});
await ok("K38 verified then non-verified is not verified in both functions; order and duplicates", async () => {
  const art = freshRun("k38");
  const lines = readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean);
  const bound = verifiedLine(lines, "c-bound");
  writeFileSync(join(art, "claims.jsonl"), `${[...lines, revoked("c-bound")].join("\n")}\n`);
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++loadN}`);
  must(!(await mod.verifiedClaimIds()).includes("c-bound"), "ids still list a revoked claim");
  must(!(await mod.verifiedClaimRecords()).has("c-bound"), "records still hold a revoked claim");
  // non-verified, then verified: verified
  writeFileSync(join(art, "claims.jsonl"), `${[revoked("c-bound"), bound].join("\n")}\n`);
  must((await mod.verifiedClaimIds()).includes("c-bound") && (await mod.verifiedClaimRecords()).has("c-bound"), "a later verified record does not count");
  // verified twice: listed once, at the first position
  writeFileSync(join(art, "claims.jsonl"), `${[bound, verifiedLine(lines, "c-map"), bound].join("\n")}\n`);
  must(JSON.stringify(await mod.verifiedClaimIds()) === JSON.stringify(["c-bound", "c-map"]), JSON.stringify(await mod.verifiedClaimIds()));
});
await ok("K38 a plan citing a revoked claim fails the render check", async () => {
  const r = await heroRun(false, { value: "2", unit: "" });
  writeFileSync(join(r.art, "claims.jsonl"), `${readFileSync(join(r.art, "claims.jsonl"), "utf8")}${revoked("c-map")}\n`);
  const lintRef = `infographics/lints/${"e".repeat(64)}.json`;
  writeFileSync(join(r.art, lintRef), JSON.stringify({ passed: true, blockers: [], warnings: [], plan_ref: r.planRef, asset_hashes: {} }));
  let msg = "";
  try { await r.tools.get("newsroom_infographic_render").execute("r", { plan_ref: r.planRef, lint_ref: lintRef }); } catch (error) { msg = String(error.message); }
  must(/not system-verified: c-map/.test(msg), `render said: ${msg}`);
});


// ---- K39: preflight runs the render's own lint check ----
const PRE = { NEWSROOM_SPEED_PREFLIGHT: "1" };
const renderWith = async (r) => { try { return { ok: true, out: await r.tools.get("newsroom_infographic_render").execute("r", { plan_ref: r.planRef, lint_ref: r.lint.details.lintRef }) }; } catch (error) { return { ok: false, msg: String(error.message) }; } };
const k39 = async (edit) => {
  const r = await heroRun(false, { value: "2", unit: "" }, { extraEnv: PRE });
  must(!r.refused && r.lint.details.passed === true, `lint should pass: ${r.refused ?? JSON.stringify(r.lint.details.blockers)}`);
  const t0 = performance.now();
  const out = await renderWith({ ...r });
  r.ms = performance.now() - t0;
  const lines = readFileSync(join(r.art, "claims.jsonl"), "utf8").split("\n").filter(Boolean);
  edit(r.art, lines);
  return { r, out, stale: await renderWith(r) };
};
await ok("K39 a claim removed after the lint: preflight says LINT_STALE", async () => {
  const { stale } = await k39((art, lines) => writeFileSync(join(art, "claims.jsonl"), `${lines.filter((l) => asRecord(l).claim_id !== "c-map").join("\n")}\n`));
  must(!stale.ok && /LINT_STALE/.test(stale.msg), JSON.stringify(stale.msg ?? "rendered"));
});
await ok("K39 a claim revoked after the lint: preflight says LINT_STALE", async () => {
  const { stale } = await k39((art, lines) => writeFileSync(join(art, "claims.jsonl"), `${[...lines, revoked("c-map")].join("\n")}\n`));
  must(!stale.ok && /LINT_STALE/.test(stale.msg), JSON.stringify(stale.msg ?? "rendered"));
});
await ok("K39 a current lint passes preflight", async () => {
  const { out } = await k39(() => {});
  must(!(out.msg && /LINT_STALE/.test(out.msg)), JSON.stringify(out.msg));
  must(out.ok, JSON.stringify(out.msg));
});

// ---- K37: invisible characters do not hide the magnitude word ----
for (const [name, , word] of INVIS) {
  const magnitude = /亿/.test(word) ? "亿" : /%/.test(word) ? "%" : "million";
  await refused(`K37 ${name}: invisible character between the number and the magnitude, unit dropped`, { value_from: "{max.value}" }, new RegExp(`HERO_UNIT_DROPPED.*'${magnitude}'.*empty`), { claim_id: `c-inv-${name}` });
}
await ok("K37 control: a correct unit still passes with an invisible character in the claim", async () => {
  for (const [name, , word] of INVIS.filter(([n]) => ["zwsp", "mixed", "nel"].includes(n))) {
    const r = await heroRun(true, { value_from: "{max.value}", unit: "亿美元" }, { claim_id: `c-inv-${name}` });
    must(!r.refused && r.stored.unit === "亿美元", `${name}: ${JSON.stringify(r.refused ?? r.stored)}`);
  }
});

// ---- K41: every placeholder the module fills is rechecked against the computation rows ----
const regionChanged = (rows) => rows.map((row) => (row.region === "B" ? { ...row, region: "Z" } : row));
for (const field of ["label", "detail"]) {
  const hero = { value_from: "{max.value}", [field]: "Largest in B", [`${field}_template`]: "Largest in {max.value.region}" };
  await refused(`K41 ${field}_template: bound field changed, value unchanged`, hero, /HERO_BINDING_STALE.*\{max\.value\.region\}/, { claim_id: "c-bound", mutateRows: regionChanged });
  await ok(`K41 ${field}_template: unchanged rows pass`, async () => {
    const r = await heroRun(true, hero, { claim_id: "c-bound" });
    must(!r.refused && r.stored[field] === "Largest in B", JSON.stringify(r.refused ?? r.stored));
  });
}
await ok("K41 control: the value alone with a changed region still passes", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-bound", mutateRows: regionChanged });
  must(!r.refused, JSON.stringify(r.refused));
});

// ---- K40: reader text follows xlink:title, aria-labelledby and aria-describedby ----
const blocked = (svg) => checkReaderText(chartSvgText(svg)).blockers.map((b) => b.term);
await ok("K40 xlink:title on a link is read and caught", async () => {
  must(JSON.stringify(blocked('<svg><a xlink:title="未经闸门"><rect/></a></svg>')) === '["未经闸门"]', JSON.stringify(blocked('<svg><a xlink:title="未经闸门"><rect/></a></svg>')));
});
await ok("K40 aria-labelledby to a metadata and a g is read and caught", async () => {
  const svg = '<svg><rect aria-labelledby="a b"/><metadata id="a">ordinary note</metadata><g id="b"><g><rect/></g>数据行绑定 <text>x</text></g></svg>';
  must(JSON.stringify(blocked(svg)) === '["行绑定"]', JSON.stringify(blocked(svg)) + " | " + chartSvgText(svg));
  const meta = '<svg><rect aria-labelledby="a b"/><metadata id="a">未经闸门</metadata><g id="b">fine</g></svg>';
  must(JSON.stringify(blocked(meta)) === '["未经闸门"]', JSON.stringify(blocked(meta)));
});
await ok("K40 aria-describedby is read and caught", async () => {
  const svg = '<svg><circle aria-describedby="d"/><g id="d"><desc>fine</desc>结论未绑定</g></svg>';
  must(JSON.stringify(blocked(svg)) === '["未绑定"]', JSON.stringify(blocked(svg)) + " | " + chartSvgText(svg));
});
await ok("K40 a missing id adds nothing and does not throw", async () => {
  const svg = '<svg><rect aria-labelledby="nope also-missing" aria-describedby="gone"/><text>Region B</text></svg>';
  must(chartSvgText(svg) === "Region B" && blocked(svg).length === 0, chartSvgText(svg));
});
await ok("K40 ordinary text stays clean", async () => {
  const svg = '<svg><a xlink:title="Region B, 2 units"><rect aria-labelledby="t"/></a><g id="t"><text>Largest value</text></g></svg>';
  must(blocked(svg).length === 0 && /Region B, 2 units/.test(chartSvgText(svg)), chartSvgText(svg));
});

// @@NEXT@@
console.log(`gates next (K37-K41): ${results.length} checks -- PASS`);
