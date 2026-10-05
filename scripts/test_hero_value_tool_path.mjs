// H1b: the hero value gate through the real tool path. With the gate on (the default; NEWSROOM_HERO_VALUE_GATE=0 turns it
// off) the newsroom_infographic_lint tool must read each hero_stat's claim computation (refs are written as "computations/<hash>.json") and block a
// value that is not in those rows. test_hero_value_gate.mjs covers the pure lint; this covers the newsroom.ts wiring,
// on a temp artifact root with a system-verified claim whose computation record has real rows. Offline.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_HERO_VALUE_GATE", "NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT"];
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
    "c-yi-sp": inlineClaim("Reserves reached {max.value} 亿美元 in total.", "Reserves reached 2 亿美元 in total."),
  };
  const inlineTemplate = "The top value is {max.value}% in {max.value.region} in {max.value.year}.";
  const inline = { claim: "The top value is 2% in B in 2018.", claim_template: inlineTemplate, claim_bindings: [
    { placeholder: "{max.value}", column: "value", row_index: 1, value: 2, text: "2" },
    { placeholder: "{max.value.region}", column: "region", row_index: 1, value: "B", text: "B" },
    { placeholder: "{max.value.year}", column: "year", row_index: 1, value: 2018, text: "2018" }], recorded_by: "newsroom_viz_plan" };
  const claims = ["c-map", "c-flow", "c-trend", "c-outcome", "c-inline", "c-rose", "c-thou", "c-million", "c-times", "c-bound", "c-yi", "c-pct", "c-pct-sp", "c-pct-sp2", "c-pct-nbsp", "c-pct-nl", "c-mil-sp2", "c-yi-sp", "c-tie"].filter((id) => !verifiedOnly || verifiedOnly.includes(id)).map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: ["data/x.csv"], computation_refs: [computationRef], verification, ...(texts[claim_id] ? { claim: texts[claim_id] } : {}), ...(claim_id === "c-tie" ? { claim: "Region A has 9 and region B has 9.", computation_refs: [tieRef] } : {}), ...(claim_id === "c-inline" ? inline : {}), ...(inlines[claim_id] ?? {}) }));
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
const heroRun = async (gate, hero, { verifiedOnly = null, claim_id = "c-bound", emptyAfterPlan = false, dropRows = false, manifestClaim = {}, inline = false, mutateRows = null } = {}) => {
  const art = freshRun("hero", { verifiedOnly, manifestClaim });
  const claimRecord = () => readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((c) => c.claim_id === claim_id);
  if (dropRows) rmSync(join(art, claimRecord().computation_refs[0]));
  if (mutateRows) { const file = join(art, claimRecord().computation_refs[0]); const computation = JSON.parse(readFileSync(file, "utf8")); writeFileSync(file, JSON.stringify({ ...computation, rows: mutateRows(computation.rows) })); }
  const plan = pagePlan({ withQuestion: true });
  plan.modules.push({ id: "hero", type: "hero_stat", span: "third", label: "Largest regional value", claim_id, story_node_ids: ["n-change"], story_role: "evidence", ...hero });
  plan.mobile_module_order = [...plan.mobile_module_order, "hero"];
  // Gate on is the default: no switch is set. The old path (typed hero values) is asked for with NEWSROOM_HERO_VALUE_GATE=0.
  const tools = await registerFor({ env: { ...(gate ? { NEWSROOM_MOBILE_PAGES: "0" } : { NEWSROOM_HERO_VALUE_GATE: "0" }), ...(inline ? { NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" } : {}) } });
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

// ---- Codex counterexamples, gate on, one each ----
await refused("another column (a column the claim does not state)", { value_from: "{max.delta}" }, /HERO_PLACEHOLDER_UNBOUND.*\{max\.value\} \{max\.value\.region\}/);
await refused("another row (first row's value)", { value_from: "{first.value}" }, /HERO_PLACEHOLDER_UNBOUND/);
await refused("a year cell", { value_from: "{max.value.year}" }, /HERO_PLACEHOLDER_UNBOUND/);
await refused("-9 where the claim says +9", { value_from: "{min.delta}" }, /HERO_PLACEHOLDER_UNBOUND/);
await refused("a typed value, with value_from", { value_from: "{max.value}", value: "9" }, /HERO_VALUE_TYPED.*value_from \{max\.value\}/);
await refused("a typed value, without value_from", { value: "9" }, /HERO_VALUE_FROM_REQUIRED.*do not type the number/);
await refused("a typed '9 (77)'", { value: "9 (77)" }, /HERO_VALUE_FROM_REQUIRED/);
await refused("2099 typed in the detail", { value_from: "{max.value}", detail: "Forecast for 2099" }, /HERO_TYPED_NUMBER.*detail/);
await refused("a number word in the label", { value_from: "{max.value}", label: "Two-thirds of output" }, /HERO_TYPED_NUMBER.*label.*number word/);
await refused("a number word in the detail", { value_from: "{max.value}", detail: "Top five regions" }, /HERO_TYPED_NUMBER.*detail.*number word/);
await refused("unit 万 the claim does not show", { value_from: "{max.value}", unit: "万" }, /HERO_UNIT_NOT_ALLOWED/);
await refused("unit kg on a measure with no unit", { value_from: "{max.value}", unit: "kg" }, /HERO_UNIT_NOT_ALLOWED.*allowed: empty/);
await refused("a claim that is not verified", { value_from: "{max.value}" }, /HERO_CLAIM_NOT_VERIFIED/, { claim_id: "c-nope" });
await ok("accepted: unit t on a tonnes measure (the claim's own chart declares it)", async () => {
  const r = await heroRun(true, { value_from: "{max.value}", unit: "t" }, { claim_id: "c-trend" });
  must(!r.refused, r.refused);
  must(r.stored.value === "2" && r.stored.unit === "t" && r.stored.value_from === "{max.value}", JSON.stringify(r.stored));
  must(r.blockers.length === 0, r.blockers.join(" | "));
});
await refused("unit t when the claim has no chart declaring it", { value_from: "{max.value}", unit: "t" }, /HERO_UNIT_NOT_ALLOWED/, { claim_id: "c-bound" });

await refused("an unbound claim whose computation file is also missing", { value_from: "{max.value}" }, /HERO_CLAIM_UNBOUND/, { claim_id: "c-outcome", dropRows: true });
// C6: a hero on a bound claim must not pass when the claim's computation no longer holds the binding
await refused("a bound claim whose computation file is missing", { value_from: "{max.value}" }, /HERO_BINDING_STALE.*not readable/, { claim_id: "c-bound", dropRows: true });
await refused("a bound claim whose bound row now has another value", { value_from: "{max.value}" }, /HERO_BINDING_STALE.*no longer in the rows/, { claim_id: "c-bound", mutateRows: (rows) => rows.map((row) => (row.region === "B" ? { ...row, value: 7 } : row)) });
await refused("a bound claim whose bound row is gone", { value_from: "{max.value}" }, /HERO_BINDING_STALE/, { claim_id: "c-bound", mutateRows: (rows) => rows.slice(0, 1) });
await ok("a bound claim whose rows still hold the binding passes", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-bound", mutateRows: (rows) => [...rows] });
  must(!r.refused && r.stored.value === "2", JSON.stringify(r.refused ?? r.stored));
});

// ---- units: a scale word after one space, and its limits ----
const unitOk = (name, claim_id, unit) => ok(`unit allowed: ${name}`, async () => {
  const r = await heroRun(true, { value_from: "{max.value}", unit }, { claim_id });
  must(!r.refused && r.stored.unit === unit && r.blockers.length === 0, JSON.stringify(r.refused ?? r.blockers));
});
await unitOk("{max.value} million tonnes allows 'million'", "c-million", "million");
await refused("record_claim text 'rose to 2 million' (no bindings) cannot fill a hero", { value_from: "{max.value}", unit: "million" }, /HERO_CLAIM_UNBOUND/, { claim_id: "c-rose" });
await refused("{max.value} 3 times does not allow '3'", { value_from: "{max.value}", unit: "3" }, /HERO_UNIT_NOT_ALLOWED/, { claim_id: "c-times" });
await refused("a scale word the claim does not show", { value_from: "{max.value}", unit: "billion" }, /HERO_UNIT_NOT_ALLOWED/, { claim_id: "c-million" });
await refused("record_claim text '1,2 units' (no bindings) cannot fill a hero", { value_from: "{max.value}" }, /HERO_CLAIM_UNBOUND/, { claim_id: "c-thou" });

// ---- render re-checks every cited claim, including claim_set and annotation claim ids ----
for (const [name, edit] of [["claim_set", (m) => { m.claim_set = [...m.claim_set, "c-ghost"]; }], ["annotation claim_id", (m) => { m.annotations = [...m.annotations, { id: "ghost-note", target_object_id: "route-a", text: "A note.", claim_id: "c-ghost" }]; }]]) {
  await ok(`render refuses an unverified id only in a visual module's ${name}`, async () => {
    const r = await heroRun(false, { value: "2", unit: "" });
    const spec = JSON.parse(readFileSync(join(r.art, r.planRef), "utf8"));
    edit(spec.modules.find((m) => m.id === "map"));
    const { content_hash, ...core } = spec;
    const key = createHash("sha256").update(JSON.stringify(core)).digest("hex");
    const planRef = `infographics/plans/${key}.json`;
    writeFileSync(join(r.art, planRef), JSON.stringify({ ...core, content_hash: key }));
    const lintRef = `infographics/lints/${"e".repeat(64)}.json`;
    writeFileSync(join(r.art, lintRef), JSON.stringify({ passed: true, blockers: [], warnings: [], plan_ref: planRef, asset_hashes: {} }));
    let msg = "";
    try { await r.tools.get("newsroom_infographic_render").execute("r", { plan_ref: planRef, lint_ref: lintRef }); } catch (error) { msg = String(error.message); }
    must(/not system-verified: c-ghost/.test(msg), `render said: ${msg}`);
  });
}

// ---- legitimate cases ----
await ok("inline claim: max binding shown with %, and a detail placeholder among the bindings", async () => {
  const r = await heroRun(true, { value_from: "{max.value}", unit: "%", detail: "Reached in {max.value.year}" }, { claim_id: "c-inline" });
  must(!r.refused, r.refused);
  must(r.stored.value === "2" && r.stored.unit === "%" && r.stored.detail === "Reached in 2018" && r.stored.detail_template === "Reached in {max.value.year}", JSON.stringify(r.stored));
  must(r.blockers.length === 0, r.blockers.join(" | "));
});
await refused("inline claim: a placeholder that is not among its bindings", { value_from: "{first.value}" }, /HERO_PLACEHOLDER_UNBOUND.*\{max\.value\} \{max\.value\.region\} \{max\.value\.year\}/, { claim_id: "c-inline" });
await refused("inline claim: a detail placeholder not among its bindings", { value_from: "{max.value}", unit: "%", detail: "Beyond {first.value.year}" }, /HERO_PLACEHOLDER_UNBOUND/, { claim_id: "c-inline" });
await ok("bound claim: the value and a detail placeholder are filled from its bindings", async () => {
  const r = await heroRun(true, { value_from: "{max.value}", detail: "Rows say {max.value.region}" });
  must(!r.refused, r.refused);
  must(r.stored.value === "2" && r.stored.detail === "Rows say B", JSON.stringify(r.stored));
  must(r.blockers.length === 0, r.blockers.join(" | "));
});
await ok("a stored plan edited after the fill is caught by lint", async () => {
  const r = await heroRun(true, { value_from: "{max.value}", unit: "%" }, { claim_id: "c-inline" });
  const spec = JSON.parse(readFileSync(join(r.art, r.planRef), "utf8"));
  spec.modules.find((m) => m.id === "hero").value = "9";
  const { content_hash, ...core } = spec;
  const key = createHash("sha256").update(JSON.stringify(core)).digest("hex");
  writeFileSync(join(r.art, `infographics/plans/${key}.json`), JSON.stringify({ ...core, content_hash: key }));
  const l = await r.tools.get("newsroom_infographic_lint").execute("l2", { plan_ref: `infographics/plans/${key}.json` });
  must((l.details.blockers ?? []).some((b) => /HERO_(EDITED_AFTER_FILL|VALUE_TYPED)/.test(b)), JSON.stringify(l.details.blockers));
});

// ---- a hero needs a system binding (P2) ----
await refused("A=9, B=9: a claim that says both without bindings cannot pick B", { value_from: "{last.value}" }, /HERO_CLAIM_UNBOUND.*no system bindings/, { claim_id: "c-tie" });
await refused("an unbound claim (record_claim) cannot fill a hero", { value_from: "{max.value}" }, /HERO_CLAIM_UNBOUND.*lead visual/, { claim_id: "c-outcome" });
await ok("a bound claim is still filled", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-bound" });
  must(!r.refused && r.stored.value === "2" && r.blockers.length === 0, JSON.stringify(r.refused ?? r.blockers));
});
await ok("the unbound-hero hint follows what this run can do (C5)", async () => {
  const off = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-outcome" });
  must(/HERO_CLAIM_UNBOUND/.test(off.refused) && /records no claim templates/.test(off.refused) && /lead visual/.test(off.refused), off.refused);
  must(!/point the hero at a claim|claim_kind|claim_template/.test(off.refused), `the off hint offers nothing this run lacks: ${off.refused}`);
  const on = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-outcome", inline: true });
  must(/HERO_CLAIM_UNBOUND/.test(on.refused) && /Use the lead visual for the page top, or point the hero at a claim that the plan tool recorded from a claim template/.test(on.refused) && !/records no claim templates/.test(on.refused), on.refused);
});
await ok("lint: a stored hero on an unbound claim is blocked, not passed", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" });
  const spec = JSON.parse(readFileSync(join(r.art, r.planRef), "utf8"));
  spec.modules.find((m) => m.id === "hero").claim_id = "c-outcome";
  const { content_hash, ...core } = spec;
  const key = createHash("sha256").update(JSON.stringify(core)).digest("hex");
  writeFileSync(join(r.art, `infographics/plans/${key}.json`), JSON.stringify({ ...core, content_hash: key }));
  const l = await r.tools.get("newsroom_infographic_lint").execute("lu", { plan_ref: `infographics/plans/${key}.json` });
  must(l.details.passed === false && (l.details.blockers ?? []).some((b) => /HERO_CLAIM_UNBOUND/.test(b)), JSON.stringify(l.details.blockers));
});

// ---- unit and multiplier (P3): the formatter writes a bare number; the magnitude is a literal after it ----
await ok("formatter: a bound claim's placeholder text is the bare number, the magnitude word stays in the template", async () => {
  const r = await heroRun(true, { value_from: "{max.value}", unit: "亿美元" }, { claim_id: "c-yi" });
  must(!r.refused && r.stored.value === "2" && r.stored.unit === "亿美元", JSON.stringify(r.refused ?? r.stored));
});
await refused("亿美元 claim, unit dropped", { value_from: "{max.value}" }, /HERO_UNIT_DROPPED.*'亿'.*empty/, { claim_id: "c-yi" });
await refused("亿美元 claim, plan unit 't' without 亿", { value_from: "{max.value}", unit: "t" }, /HERO_UNIT_DROPPED.*'亿'/, { claim_id: "c-yi", manifestClaim: { trend: "c-yi" } });
await refused("亿美元 claim, 美元 alone is not shown by the claim", { value_from: "{max.value}", unit: "美元" }, /HERO_UNIT_NOT_ALLOWED/, { claim_id: "c-yi" });
await refused("% claim, unit dropped", { value_from: "{max.value}" }, /HERO_UNIT_DROPPED.*'%'/, { claim_id: "c-pct" });
await refused("% claim, plan unit 't' without %", { value_from: "{max.value}", unit: "t" }, /HERO_UNIT_DROPPED.*'%'/, { claim_id: "c-pct", manifestClaim: { trend: "c-pct" } });
for (const id of ["c-pct-sp", "c-pct-sp2", "c-pct-nbsp", "c-pct-nl"]) {
  await refused(`${id}: whitespace between the number and %, unit dropped`, { value_from: "{max.value}" }, /HERO_UNIT_DROPPED.*'%'/, { claim_id: id });
  await ok(`${id}: unit % kept`, async () => {
    const r = await heroRun(true, { value_from: "{max.value}", unit: "%" }, { claim_id: id });
    must(!r.refused && r.stored.unit === "%", JSON.stringify(r.refused ?? r.stored));
  });
}
await refused("two spaces before million, unit dropped", { value_from: "{max.value}" }, /HERO_UNIT_DROPPED.*'million'/, { claim_id: "c-mil-sp2" });
await refused("space before 亿美元, unit dropped", { value_from: "{max.value}" }, /HERO_UNIT_DROPPED.*'亿'/, { claim_id: "c-yi-sp" });
await ok("% claim, unit % kept", async () => {
  const r = await heroRun(true, { value_from: "{max.value}", unit: "%" }, { claim_id: "c-pct" });
  must(!r.refused && r.stored.unit === "%" && r.blockers.length === 0, JSON.stringify(r.refused ?? r.blockers));
});
await refused("million claim, unit dropped", { value_from: "{max.value}" }, /HERO_UNIT_DROPPED.*'million'/, { claim_id: "c-million" });
await refused("million claim, plan unit 't' without million", { value_from: "{max.value}", unit: "t" }, /HERO_UNIT_DROPPED.*'million'/, { claim_id: "c-million", manifestClaim: { trend: "c-million" } });
await ok("a claim with no magnitude keeps today's rule: empty unit is accepted", async () => {
  const r = await heroRun(true, { value_from: "{max.value}" }, { claim_id: "c-bound" });
  must(!r.refused && r.stored.unit === undefined || r.stored.unit === "", JSON.stringify(r.refused ?? r.stored));
});
await ok("magnitude detection: listed words and signs only", async () => {
  const src = readFileSync(join(TREE, "runtime/pi/newsroom.test-copy.mjs"), "utf8");
  must(/const HERO_MAGNITUDES = \["万亿", "千亿", "亿", "千万", "百万", "万", "%", "％", "‰", "个百分点", "百分点"\]/.test(src), "magnitude list changed");
  must(/thousand\|million\|billion\|trillion/.test(src), "magnitude word list changed");
  must(!/"千"[,\]]/.test(src.match(/const HERO_MAGNITUDES = [^\n]*/)[0]), "a lone 千 must not be a magnitude");
});

// ---- the stored lint must be current (P1) ----
// Plan + lint under one gate state, render under another. The page has no hero, so the plan itself is gate-independent.
// typed: the plan is made with the gate off and its hero carries a typed value (the old path); otherwise the gate is on and the hero is filled from its claim.
const pageRun = async (lintGateOff, typed = false) => {
  const art = freshRun("p1");
  const plan = pagePlan({ withQuestion: true });
  plan.modules.push({ id: "hero", type: "hero_stat", span: "third", label: "Largest regional value", claim_id: "c-bound", ...(typed ? { value: "2", unit: "" } : { value_from: "{max.value}" }), story_node_ids: ["n-change"], story_role: "evidence", priority: 2, emphasis: "support" });
  plan.mobile_module_order = [...plan.mobile_module_order, "hero"];
  const setGate = (off) => { if (off) process.env.NEWSROOM_HERO_VALUE_GATE = "0"; else delete process.env.NEWSROOM_HERO_VALUE_GATE; };
  const tools = await registerFor({ env: {} });
  setGate(typed);
  const planned = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, plan));
  const planRef = refOf(planned, "planRef");
  setGate(lintGateOff);
  const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: planRef });
  return { art, tools, planRef, lint, setGate };
};
const renderMsg = async (r, lintRef) => { try { const out = await r.tools.get("newsroom_infographic_render").execute("r", { plan_ref: r.planRef, lint_ref: lintRef }); return { ok: true, out }; } catch (error) { return { ok: false, msg: String(error.message) }; } };
await ok("lint with the gate off, render with the gate on: LINT_STALE", async () => {
  const r = await pageRun(true, true);
  must(r.lint.details.passed === true, `lint with the gate off should pass: ${JSON.stringify(r.lint.details.blockers)}`);
  r.setGate(false);
  const out = await renderMsg(r, r.lint.details.lintRef);
  must(!out.ok && /LINT_STALE.*run newsroom_infographic_lint again/.test(out.msg), JSON.stringify(out.msg ?? "rendered"));
  const stored = JSON.parse(readFileSync(join(r.art, r.lint.details.lintRef), "utf8"));
  must(stored.hero_value_gate === false && typeof stored.lint_policy_version === "string", JSON.stringify([stored.hero_value_gate, stored.lint_policy_version]));
});
await ok("a stored lint with an older policy version is refused", async () => {
  const r = await pageRun(false);
  must(r.lint.details.passed === true, JSON.stringify(r.lint.details.blockers));
  const stored = JSON.parse(readFileSync(join(r.art, r.lint.details.lintRef), "utf8"));
  const oldRef = `infographics/lints/${"a".repeat(64)}.json`;
  writeFileSync(join(r.art, oldRef), JSON.stringify({ ...stored, lint_policy_version: "1" }));
  const out = await renderMsg(r, oldRef);
  must(!out.ok && /LINT_STALE.*version 1/.test(out.msg), JSON.stringify(out.msg ?? "rendered"));
  const bare = { ...stored }; delete bare.lint_policy_version; delete bare.hero_value_gate;
  const bareRef = `infographics/lints/${"b".repeat(64)}.json`;
  writeFileSync(join(r.art, bareRef), JSON.stringify(bare));
  const out2 = await renderMsg(r, bareRef);
  must(!out2.ok && /LINT_STALE/.test(out2.msg), `a lint with no policy fields: ${JSON.stringify(out2.msg ?? "rendered")}`);
});
await ok("the same plan and assets under two gate states give two lint refs", async () => {
  const r = await pageRun(true);
  r.setGate(false);
  const again = await r.tools.get("newsroom_infographic_lint").execute("l2", { plan_ref: r.planRef });
  must(again.details.lintRef !== r.lint.details.lintRef, "one lint ref for two gate states");
  const same = await r.tools.get("newsroom_infographic_lint").execute("l3", { plan_ref: r.planRef });
  must(same.details.lintRef === again.details.lintRef, "the same gate state must give the same lint ref");
});
await ok("a lint record relabelled as current is not trusted: render lints again under today's settings", async () => {
  const r = await pageRun(true, true); // typed hero value "2": the gate on gives the plan a HERO_VALUE_FROM_REQUIRED blocker
  must(r.lint.details.passed === true, JSON.stringify(r.lint.details.blockers));
  const stored = JSON.parse(readFileSync(join(r.art, r.lint.details.lintRef), "utf8"));
  const forgedRef = `infographics/lints/${"c".repeat(64)}.json`;
  writeFileSync(join(r.art, forgedRef), JSON.stringify({ ...stored, hero_value_gate: true }));
  r.setGate(false);
  const out = await renderMsg(r, forgedRef);
  must(!out.ok && /blocking failures under the current settings/.test(out.msg), JSON.stringify(out.msg ?? "rendered"));
});
await ok("the normal path (lint and render under the same settings): lint passes and render is not refused by the lint checks", async () => {
  const r = await pageRun(false);
  must(r.lint.details.passed === true, JSON.stringify(r.lint.details.blockers));
  const out = await renderMsg(r, r.lint.details.lintRef);
  const msg = out.ok ? "rendered" : out.msg;
  must(!/LINT_STALE|blocking failures|not system-verified|changed after infographic lint/.test(msg), msg);
});

// ---- every consumer of a rendered page re-checks its lint (C1) ----
const callPage = async (r, name, params) => { try { return { ok: true, out: await r.tools.get(name).execute("x", params) }; } catch (error) { return { ok: false, msg: String(error.message) }; } };
const renderedPage = async () => {
  const r = await pageRun(false);
  must(r.lint.details.passed === true, JSON.stringify(r.lint.details.blockers));
  const out = await renderMsg(r, r.lint.details.lintRef);
  must(out.ok, `the normal render must succeed: ${out.msg}`);
  return { ...r, manifestRef: out.out.details.manifestRef, lintRef: r.lint.details.lintRef };
};
const criticArgs = (r) => ({ plan_ref: r.planRef, lint_ref: r.lintRef, manifest_ref: r.manifestRef });
await ok("critic on a page whose lint is from an older policy: LINT_STALE", async () => {
  const r = await renderedPage();
  const fine = await callPage(r, "newsroom_infographic_critic", criticArgs(r));
  must(fine.ok, `the unmodified page's critic must run: ${fine.msg}`);
  const stored = JSON.parse(readFileSync(join(r.art, r.lintRef), "utf8"));
  writeFileSync(join(r.art, r.lintRef), JSON.stringify({ ...stored, lint_policy_version: "1" }));
  const out = await callPage(r, "newsroom_infographic_critic", criticArgs(r));
  must(!out.ok && /LINT_STALE/.test(out.msg), JSON.stringify(out.msg ?? "critic ran"));
});
await ok("preview on a page whose lint is from an older policy: LINT_STALE", async () => {
  const r = await renderedPage();
  const critic = await callPage(r, "newsroom_infographic_critic", criticArgs(r));
  must(critic.ok, critic.msg);
  const stored = JSON.parse(readFileSync(join(r.art, r.lintRef), "utf8"));
  writeFileSync(join(r.art, r.lintRef), JSON.stringify({ ...stored, lint_policy_version: "1" }));
  const out = await callPage(r, "newsroom_infographic_preview", { manifest_ref: r.manifestRef, critic_ref: critic.out.details.criticRef });
  must(!out.ok && /LINT_STALE/.test(out.msg), JSON.stringify(out.msg ?? "preview ran"));
});
await ok("a claim that lost its verified status after render: the critic refuses", async () => {
  const r = await renderedPage();
  writeFileSync(join(r.art, "claims.jsonl"), "");
  const out = await callPage(r, "newsroom_infographic_critic", criticArgs(r));
  must(!out.ok && /not system-verified/.test(out.msg), JSON.stringify(out.msg ?? "critic ran"));
});

// ---- empty verified set (gate off with NEWSROOM_HERO_VALUE_GATE=0) ----
await ok("no claim verified: a plan citing a claim is refused at lint and at render", async () => {
  const r = await heroRun(false, { value: "2", unit: "" }, { emptyAfterPlan: true });
  must(!r.refused, r.refused);
  const l = r.lint;
  must(l.details.passed === false && l.details.blockers.some((b) => /hero_stat 'hero' references unverified claim 'c-bound'/.test(b)), JSON.stringify(l.details.blockers));
  // render re-reads the verified set and does not trust a stored lint: forge a passing one
  const lintKey = "f".repeat(64);
  writeFileSync(join(r.art, `infographics/lints/${lintKey}.json`), JSON.stringify({ passed: true, blockers: [], warnings: [], plan_ref: r.planRef, asset_hashes: {} }));
  let msg = "";
  try { await r.tools.get("newsroom_infographic_render").execute("r", { plan_ref: r.planRef, lint_ref: `infographics/lints/${lintKey}.json` }); } catch (error) { msg = String(error.message); }
  must(/not system-verified/.test(msg), `render said: ${msg}`);
});
await ok("no claim verified: a plan that cites no claim still passes the claim checks", async () => {
  const { lintInfographicSpec } = await import(join(ROOT, "runtime/pi/infographic.mjs"));
  const r = await heroRun(false, { value: "2", unit: "" });
  const spec = JSON.parse(readFileSync(join(r.art, r.planRef), "utf8"));
  spec.modules = spec.modules.filter((m) => m.type !== "hero_stat").map(({ claim_id, claim_ids, claim_set, annotations, ...m }) => m);
  const blockers = lintInfographicSpec(spec, {}, { verified_claim_ids: [], mobile_pages: false }).blockers;
  must(!blockers.some((b) => /unverified claim/.test(b)), JSON.stringify(blockers.filter((b) => /unverified claim/.test(b))));
});
await ok("gate off: a typed hero value passes as before (no hero blocker)", async () => {
  const r = await heroRun(false, { value: "9", unit: "" });
  must(!r.refused && r.blockers.length === 0, JSON.stringify(r.refused ?? r.blockers));
});
await ok("switch =0: tool definitions carry no value_from and equal the default (gate-on) ones minus it", async () => {
  freshRun("defs");
  const off = await registerFor({ env: { NEWSROOM_HERO_VALUE_GATE: "0" } });
  const on = await registerFor({ env: {} });
  // Only the exact string "0" turns the gate off: "1", an empty value and a typo all give the default definitions.
  for (const value of ["1", "", "off", "false"]) {
    const other = await registerFor({ env: { NEWSROOM_HERO_VALUE_GATE: value } });
    must(JSON.stringify([...other.values()].map((t) => [t.name, t.description, t.promptGuidelines, t.parameters])) === JSON.stringify([...on.values()].map((t) => [t.name, t.description, t.promptGuidelines, t.parameters])), `NEWSROOM_HERO_VALUE_GATE=${JSON.stringify(value)} differs from the default`);
  }
  const defs = (tools) => JSON.stringify([...tools.values()].map((t) => [t.name, t.description, t.parameters]));
  // Every tool's name, description and parameters: on minus value_from must equal off.
  const strip = (tools) => JSON.stringify([...tools.values()].map((t) => [t.name, t.description, JSON.parse(JSON.stringify(t.parameters, (k, v) => (k === "value_from" ? undefined : v)))]));
  must(!defs(off).includes("value_from"), "value_from is visible with the gate off");
  must(defs(on).includes("value_from"), "value_from missing with the gate on");
  must(strip(on) === strip(off), "the tool list with value_from stripped differs between gate on and off");
  const keys = (tools) => Object.keys(tools.get("newsroom_infographic_plan").parameters.properties.modules.items.properties).filter((k) => k !== "value_from");
  must(JSON.stringify(keys(on)) === JSON.stringify(keys(off)), "module properties differ beyond value_from");
});
console.log(`hero value gate, tool path: ${results.length} checks -- PASS`);
