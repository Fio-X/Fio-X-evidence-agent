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
  if (filled.visual_channels !== undefined) check("visual_channels", filled.visual_channels.map((owner) => owner?.channel));
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
    lines.push("", "Verified claims (copy the id):", ...claims.map((claim) => `- ${claim.id}: ${claim.summary}`));
    lines.push("", "Choose each of these only from its list:");
    for (const question of CHOICE_QUESTIONS) lines.push(`- ${question.id}: ${question.question} [${offeredValues(question.id, claims.map((c) => c.id)).join(" | ")}]`);
    lines.push("", "Rules:", ...RULE_SENTENCES.map((sentence) => `- ${sentence}`));
    lines.push("", "Write the text fields (title, dek, alt, intent, primary_message, module body and heading) in the page language. Do not state a number that is not in a claim.");
    return lines.join("\n");
  }
  if (round !== "R4" && round !== "R6") throw new Error(`REQUEST_SHEET_ROUND: unknown round ${JSON.stringify(round)}`);
  if (!REJECTION_REF.test(rejectionRef)) throw new Error("REQUEST_SHEET_PATCH_OF: rejectionRef must be infographics/chain-rejections/<64 hex>.json");
  lines.push("The chain refused the call. Send only the change: call newsroom_infographic_chain_patch with the patch_of below and a JSON patch that adds the missing fields (op add, on paths that are absent).");
  lines.push(`patch_of=${rejectionRef}`);
  lines.push("", "Refusal:", String(refusal));
  return lines.join("\n");
}
