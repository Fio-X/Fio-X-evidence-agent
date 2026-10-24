// Page skeleton for the design pack's model path (visual group; pure: every input is passed in, nothing is read or written here).
//
// The program fills only what an existing artifact or a fixed table already says (refs, module ids, mark_semantics of four chart types). Every
// judgement field stays absent: the model fills it by choosing from the frozen lists below, or writes the text. The lists carry no status or
// source-type field, and nothing in them is preselected. All judging is done by the existing validators (validateInfographicSpec,
// visualChannelOwnerValidator, the chain's own checks); this file only decides what is offered.
import { createHash } from "node:crypto";
import { INFOGRAPHIC_MODULE_TYPES, INFOGRAPHIC_STORY_ROLES } from "./infographic.mjs";
import { COGNITIVE_GOALS } from "./editorial_validators.mjs";

// Same values as VISUAL_CHANNEL_NAMES in newsroom.ts (a test compares the two) and the accurate-quantity channels of visualChannelOwnerValidator.
export const VISUAL_CHANNELS = Object.freeze(["position", "length", "area", "size", "angle", "color", "opacity", "shape", "connection"]);
export const ACCURATE_CHANNELS = Object.freeze(["position", "length", "area", "size", "angle"]);
export const PRIORITIES = Object.freeze([1, 2, 3, 4, 5]);

// The six questions. `values` is the whole answer set in constant order; for claim_ids the values are filled per request from the verified claims.
export const CHOICE_QUESTIONS = Object.freeze([
  Object.freeze({ id: "type", path: "/modules/*/type", question: "Which module type is each module?", values: INFOGRAPHIC_MODULE_TYPES }),
  Object.freeze({ id: "story_role", path: "/modules/*/story_role", question: "Which story role does each module play?", values: INFOGRAPHIC_STORY_ROLES }),
  Object.freeze({ id: "cognitive_goals", path: "/editorial_grammar/cognitive_goals", question: "Which reader goals does the page serve? Pick one or more.", values: COGNITIVE_GOALS }),
  Object.freeze({ id: "claim_ids", path: "/modules/*/claim_ids", question: "Which verified claims does each module carry? Copy the id, never a number.", values: "per request: the verified claim ids" }),
  Object.freeze({ id: "visual_channels", path: "/modules/*/visual_channels/*/channel", question: "Which visual channel encodes each field of a visual module?", values: VISUAL_CHANNELS }),
  Object.freeze({ id: "priority", path: "/modules/*/priority", question: "How important is each module? 1 is the most important.", values: PRIORITIES }),
]);

// Two rules the lists cannot express; they go into the request as sentences.
export const RULE_SENTENCES = Object.freeze([
  "The module that answers the page's main question has story_role resolution.",
  `Every visual module declares at least one visual channel, and a field that carries a quantity needs one of ${ACCURATE_CHANNELS.join(", ")} (colour alone is refused).`,
]);

// Fields the model owns. Frozen with the choice list; `kind` says whether it is chosen from a list or written, never what the value means as evidence.
export const JUDGMENT_FIELD_PATHS = Object.freeze([
  ["/modules/*/type", "choice"], ["/modules/*/story_role", "choice"], ["/modules/*/priority", "choice"], ["/modules/*/claim_ids", "choice"],
  ["/modules/*/visual_channels", "choice"], ["/editorial_grammar/cognitive_goals", "choice"],
  ["/modules/*/visual_grammar", "judgment"], ["/modules/*/quantitative_encoding/quantity_kind", "judgment"],
  ["/modules/*/quantitative_encoding/scale_type", "judgment"], ["/modules/*/quantitative_encoding/baseline_policy", "judgment"],
  ["/modules/*/quantitative_encoding/uncertainty_disclosed", "judgment"], ["/modules/*/story_node_ids", "judgment"],
  ["/story_arc", "judgment"], ["/audience", "judgment"], ["/editorial_grammar/primary", "judgment"], ["/scene_graph", "judgment"],
  ["/title", "text"], ["/dek", "text"], ["/alt", "text"], ["/intent", "text"], ["/primary_message", "text"], ["/modules/*/body", "text"], ["/modules/*/heading", "text"],
].map(([path, kind]) => Object.freeze({ path, kind })));

// The rule codes the chain's validators answer with for these fields (editorial_validators.mjs).
export const RULE_CODES = Object.freeze(["visual_channel.owner_required", "visual_channel.single_owner", "visual_channel.color_only_quantity"]);

// Fixed table (K1599 table A): chart type -> mark_semantics. Other chart types get no entry: the model decides.
export const MARK_SEMANTICS = Object.freeze({ horizontal_bar: "length", dot: "position", line: "position", choropleth: "color" });

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// The claim_ids list is per request, so the frozen form leaves its values out.
export const frozenForm = () => ({
  choices: CHOICE_QUESTIONS.map(({ id, path, question, values }) => ({ id, path, question, values: Array.isArray(values) ? values : String(values) })),
  rule_sentences: RULE_SENTENCES,
  judgment_field_paths: JUDGMENT_FIELD_PATHS,
  rule_codes: RULE_CODES,
});
export const frozenSha256 = () => ({ choices: sha(frozenForm().choices), judgment_field_paths: sha(JUDGMENT_FIELD_PATHS), rule_codes: sha(RULE_CODES), all: sha(frozenForm()) });

const REF_FIELDS = ["story_graph_ref", "discovery_ref", "concept_ref", "novelty_ref", "asset_requirements_ref"];

// Program-owned leaves only. origin maps each leaf path to where its value came from.
// input: { refs: {story_graph_ref, ...}, charts: [{ id, chart_type, manifest_ref, critic_ref }] }
export function buildSkeleton({ refs = {}, charts = [] } = {}) {
  const params = {};
  const origin = {};
  for (const field of REF_FIELDS) {
    if (typeof refs[field] === "string" && refs[field]) { params[field] = refs[field]; origin[`/${field}`] = `artifact:${refs[field]}`; }
  }
  params.modules = [];
  charts.forEach((chart, index) => {
    const module = { id: String(chart.id) };
    origin[`/modules/${index}/id`] = "program:chart id";
    for (const field of ["manifest_ref", "critic_ref"]) {
      if (typeof chart[field] === "string" && chart[field]) { module[field] = chart[field]; origin[`/modules/${index}/${field}`] = `artifact:${chart[field]}`; }
    }
    const mark = MARK_SEMANTICS[chart.chart_type];
    if (mark) { module.quantitative_encoding = { mark_semantics: mark }; origin[`/modules/${index}/quantitative_encoding/mark_semantics`] = `table:mark_semantics[${chart.chart_type}]`; }
    module.chart = index; origin[`/modules/${index}/chart`] = "program:chart index";
    params.modules.push(module);
  });
  return { params, origin };
}

const leafPaths = (value, base = "") => {
  if (Array.isArray(value)) return value.flatMap((item, i) => leafPaths(item, `${base}/${i}`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => leafPaths(v, `${base}/${k}`));
  return [base];
};
export const skeletonLeafPaths = (params) => leafPaths(params);
const asPattern = (path) => path.replace(/\/\d+(?=\/|$)/g, "/*");
export const isJudgmentPath = (path) => JUDGMENT_FIELD_PATHS.some((field) => field.path === asPattern(path));

// The list of values offered for one question, for these verified claim ids.
export function offeredValues(questionId, claimIds = []) {
  const question = CHOICE_QUESTIONS.find((q) => q.id === questionId);
  if (!question) return [];
  return questionId === "claim_ids" ? [...new Set(claimIds.map(String))] : [...question.values];
}

// Not-listed values: returns the problems in a model-filled value set { type, story_role, cognitive_goals, claim_ids, visual_channels, priority } (all optional).
export function choiceProblems(filled = {}, claimIds = []) {
  const problems = [];
  const check = (id, value) => {
    const offered = offeredValues(id, claimIds);
    for (const item of Array.isArray(value) ? value : [value]) if (!offered.includes(item)) problems.push(`${id}: ${JSON.stringify(item)} is not in the list`);
  };
  for (const id of ["type", "story_role", "cognitive_goals", "claim_ids", "priority"]) if (filled[id] !== undefined) check(id, filled[id]);
  if (filled.visual_channels !== undefined) {
    if (!Array.isArray(filled.visual_channels)) problems.push(`visual_channels: ${JSON.stringify(filled.visual_channels)} is not a list of {field, channel} entries`);
    else check("visual_channels", filled.visual_channels.map((owner) => owner?.channel));
  }
  return problems;
}

const REJECTION_REF = /^infographics\/chain-rejections\/[0-9a-f]{64}\.json$/;

// The request the model gets. round: "R3" (first fill) | "R4" | "R6" (patch after a refusal: patch_of is written here by the program).
// claims: [{ id, summary }]; refusal: the chain's refusal text; rejectionRef: where the refused call was stored.
export function requestSheet({ round = "R3", skeleton, claims = [], refusal = "", rejectionRef = "" } = {}) {
  const lines = [];
  if (round === "R3") {
    lines.push("Fill the page skeleton below and call newsroom_design_pack. Program-filled fields are final; write every other field yourself.");
    lines.push("", "Skeleton (JSON):", JSON.stringify(skeleton?.params ?? {}));
    if ((skeleton?.params?.modules ?? []).length) lines.push("A visual module in the skeleton already names its chart (chart: i); keep it and add the module's other fields.");
    lines.push("", "Verified claims (copy the id):", ...claims.map((claim) => `- ${claim.id}: ${claim.summary}`));
    lines.push("", "Choose each of these only from its list:");
    for (const question of CHOICE_QUESTIONS) lines.push(`- ${question.id}: ${question.question} [${offeredValues(question.id, claims.map((c) => c.id)).join(" | ")}]`);
    lines.push("", "Rules:", ...RULE_SENTENCES.map((sentence) => `- ${sentence}`));
    lines.push("", "Write the text fields (title, dek, alt, intent, primary_message, module body and heading) in the page language. Do not state a number that is not in a claim.");
    return lines.join("\n");
  }
  if (round !== "R4" && round !== "R6") throw new Error(`REQUEST_SHEET_ROUND: unknown round ${JSON.stringify(round)}`);
  if (!REJECTION_REF.test(rejectionRef)) throw new Error("REQUEST_SHEET_PATCH_OF: rejectionRef must be infographics/chain-rejections/<64 hex>.json");
  lines.push("The chain refused the call. Send only the change: call newsroom_design_pack with the patch_of below and ops (JSON patch ops) that add the missing fields (op add, on paths that are absent), nothing else.");
  lines.push(`patch_of=${rejectionRef}`);
  lines.push("", "Refusal:", String(refusal));
  return lines.join("\n");
}

// ---- Chart-form registry and its one matcher (same group, same file: a new runtime file would need its own table rows) ----
// One table, one matcher. A chart type is a row of CHART_FORM_SHAPES (the data shape it needs: which kind of dimension varies, how many rows it takes, whether
// every code must resolve). buildChartFormTable joins that table with the four tables that already decide what a chart type may be: the strict grammar
// (relation -> forms), the drafting templates, the publication map and the mark semantics. A chart type that is missing from any of them has no row in the
// built table and is reported as a gap, never silently dropped or replaced. matchChartForm takes a description of the data (relations that fit what the
// reader asks, kind of the varying dimension, row count, whether the codes resolve) and returns the first row in table order that satisfies it.
// Adding a chart is adding one row to CHART_FORM_SHAPES (and its entries in the four tables); the matcher has no branch for any chart type.

/** The kind of varying dimension a form accepts; `time` is a period axis, `geo_code` is a country or region code, `category` is anything else. */
export const DIMENSION_KINDS = Object.freeze(["category", "geo_code", "time"]);

/** Preference order: the first row that fits wins. max_rows mirrors MAX_CHART_ROWS and the choropleth row limit in newsroom.ts (a test compares them). */
export const CHART_FORM_SHAPES = Object.freeze([
  Object.freeze({ chart_type: "choropleth", accepts: Object.freeze(["geo_code"]), max_rows: 60, needs_resolvable_codes: true }),
  Object.freeze({ chart_type: "horizontal_bar", accepts: Object.freeze(["category", "geo_code"]), max_rows: 80, needs_resolvable_codes: false }),
  Object.freeze({ chart_type: "dot", accepts: Object.freeze(["category", "geo_code"]), max_rows: 80, needs_resolvable_codes: false }),
  Object.freeze({ chart_type: "line", accepts: Object.freeze(["time"]), max_rows: 80, needs_resolvable_codes: false }),
]);

const TABLE_NAMES = Object.freeze(["strict grammar (STRICT_GRAMMAR_FORMS)", "drafting templates (TEMPLATE_CHART_TYPES)", "publication map (PUBLICATION_TYPES)", "mark semantics (MARK_SEMANTICS)"]);

/**
 * strict: { relation: [chart types] }; templates: [chart types]; publication: { chart type: entry }; marks: { chart type: mark }.
 * Returns { rows, gaps }: rows are the chart types that are in the shape table and in all four tables, in shape-table order; gaps list, for every
 * chart type the shape table or the strict grammar names, the tables that lack it.
 */
export function buildChartFormTable({ strict, templates, publication, marks, shapes = CHART_FORM_SHAPES }) {
  const inStrict = (type) => Object.keys(strict).filter((relation) => strict[relation].includes(type));
  const has = (type) => [inStrict(type).length > 0, templates.includes(type), Object.hasOwn(publication, type), Object.hasOwn(marks, type)];
  const rows = [];
  const gaps = [];
  for (const shape of shapes) {
    const present = has(shape.chart_type);
    if (present.every(Boolean)) rows.push({ ...shape, relations: inStrict(shape.chart_type), publication: publication[shape.chart_type], mark: marks[shape.chart_type] });
    else gaps.push({ chart_type: shape.chart_type, missing: TABLE_NAMES.filter((_, i) => !present[i]) });
  }
  // A chart type the strict grammar offers for some relation that has no shape row: the registry lacks it.
  for (const type of new Set(Object.values(strict).flat())) {
    if (shapes.some((shape) => shape.chart_type === type)) continue;
    gaps.push({ chart_type: type, missing: ["shape table (CHART_FORM_SHAPES)", ...TABLE_NAMES.filter((_, i) => !has(type)[i])] });
  }
  return { rows, gaps };
}

/**
 * need: { relations: [the relations that fit the reader's question], kind: one of DIMENSION_KINDS, rows: number, resolvable: boolean }.
 * Returns { ok: true, form, skipped } with the first satisfying row (skipped: the earlier rows and why they did not fit), or { ok: false, code, message, absent }
 * where absent names, per requested relation, the chart types the strict grammar offers that the table cannot use and which table or row is missing.
 */
export function matchChartForm(table, need) {
  const relations = Array.isArray(need?.relations) ? need.relations : [];
  const skipped = [];
  for (const row of table.rows) {
    const why = [];
    if (!relations.some((relation) => row.relations.includes(relation))) why.push(`its relations (${row.relations.join(", ")}) do not include ${relations.join(" or ")}`);
    if (!row.accepts.includes(need?.kind)) why.push(`it takes ${row.accepts.join(" or ")}, the varying dimension is ${need?.kind}`);
    if (Number(need?.rows) > row.max_rows) why.push(`it takes at most ${row.max_rows} rows, the data has ${need.rows}`);
    if (row.needs_resolvable_codes && need?.resolvable !== true) why.push("it needs every code to resolve to a known place, and they do not");
    if (!why.length) return { ok: true, form: row, skipped };
    skipped.push({ chart_type: row.chart_type, why });
  }
  const absent = relations.flatMap((relation) => (table.strictForms?.[relation] ?? []).filter((type) => !table.rows.some((row) => row.chart_type === type)).map((type) => ({ relation, chart_type: type, missing: table.gaps.find((gap) => gap.chart_type === type)?.missing ?? ["shape table (CHART_FORM_SHAPES)"] })));
  const detail = skipped.map((item) => `${item.chart_type}: ${item.why.join("; ")}`).join(" | ");
  const lacking = absent.map((item) => `${item.chart_type} (${item.relation}) lacks ${item.missing.join(", ")}`).join("; ");
  return { ok: false, code: "CHART_FORM_NONE", message: `no chart form fits relation ${relations.join(" or ") || "(none given)"}, ${need?.kind} dimension, ${need?.rows} rows${detail ? `. Rows tried: ${detail}` : ""}${lacking ? `. Forms the grammar offers that the table cannot use: ${lacking}` : ""}`, absent, skipped };
}

/** buildChartFormTable plus the strict grammar kept on the table, so the matcher can say what is missing without being handed the tables again. */
export function chartFormTable(inputs) {
  return { ...buildChartFormTable(inputs), strictForms: inputs.strict };
}

// P / C / J of every leaf of a tool schema, derived from the schema alone: a leaf with a closed list (enum or const) is C, a leaf the program fills
// (`program`: path patterns like "/modules/*/manifest_ref", sourced from an existing artifact or a table) is P, every other leaf is J. Nothing here is
// hand-labelled per field; a field added to a schema is classified the day it is added.
export function classifyFields(schema, { program = [] } = {}) {
  const out = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    const options = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
    if (options && !options.every((option) => option && (option.const !== undefined || Array.isArray(option.enum)))) { options.forEach((option) => walk(option, path)); return; }
    if (node.properties && typeof node.properties === "object") { for (const [key, child] of Object.entries(node.properties)) walk(child, `${path}/${key}`); return; }
    if (node.type === "array" && node.items) { walk(node.items, `${path}/*`); return; }
    const closed = node.const !== undefined || Array.isArray(node.enum) || (options && options.length);
    out.push({ path, kind: program.includes(path) ? "P" : closed ? "C" : "J" });
  };
  walk(schema, "");
  const seen = new Set();
  return out.filter((field) => !seen.has(field.path) && seen.add(field.path));
}
