// Compact page setup (NEWSROOM_SPEED_COMPACT_SETUP=1, default off). Pure logic
// over an injected artifact reader:
//
//  - expandSharedConcepts: `shared` is a shallow default for the concepts. The
//    expanded array is exactly what sending every concept in full would have
//    carried, so the tournament, the validators and the stored artifact do not
//    change. The fields that make a concept a different concept are never taken
//    from `shared`.
//  - fillSetupRefs: copies discovery_ref / concept_ref only when exactly one
//    existing artifact is bound to what the call already names (the rule and
//    wording of preflight.mjs). A value the model supplies is never replaced;
//    concept_id is never filled.

import { candidates, preflightError, settle } from "./preflight.mjs";

export const SHARED_CONCEPT_KEYS = [
  "reader_question", "editorial_premise", "surprise", "hero_evidence_refs", "supporting_evidence_refs", "asset_requirements",
  "media_mix", "information_hierarchy", "mobile_treatment", "risk_flags", "reporting_gaps", "why_reject",
];
export const CREATIVE_CONCEPT_KEYS = ["concept_id", "framing", "visual_metaphor", "hero_scene", "why_memorable"];

export function expandSharedConcepts(shared, concepts) {
  if (shared === undefined) return concepts;
  if (!shared || typeof shared !== "object" || Array.isArray(shared)) throw new Error("shared must be an object of concept defaults");
  const issues = [];
  for (const key of Object.keys(shared)) {
    if (CREATIVE_CONCEPT_KEYS.includes(key)) issues.push(`shared.${key} is refused: ${key} must come from each concept`);
    else if (!SHARED_CONCEPT_KEYS.includes(key)) issues.push(`shared.${key} is not a concept field that may be shared (allowed: ${SHARED_CONCEPT_KEYS.join(", ")})`);
  }
  if (issues.length) throw new Error(`newsroom_visual_concepts: ${issues.join("; ")}`);
  return (Array.isArray(concepts) ? concepts : []).map((concept) => ({ ...shared, ...concept }));
}

const REFS = {
  newsroom_visual_concepts: "discovery_ref",
  newsroom_semantic_novelty: "concept_ref",
  newsroom_asset_requirements: "concept_ref",
};

export async function fillSetupRefs(tool, params, io) {
  const state = { params: { ...params }, filled: [], unresolved: {} };
  const field = REFS[tool];
  if (!field || params[field] !== undefined) return state;
  if (field === "discovery_ref") {
    settle(state, field, await candidates(io, "editorial/discovery/", (d) => d?.decision === "CONTINUE"), "no CONTINUE editorial/discovery artifact exists; call newsroom_editorial_discovery first");
  } else {
    const conceptId = params.concept_id;
    settle(state, field, await candidates(io, "editorial/concepts/", (c) => conceptId === undefined || (c?.finalists ?? []).includes(conceptId)), conceptId === undefined ? "no editorial/concepts artifact exists; call newsroom_visual_concepts first" : `no editorial/concepts artifact lists '${conceptId}' as a finalist; call newsroom_visual_concepts first`);
  }
  return state;
}

export function setupRefError(tool, state) {
  return preflightError(tool, Object.entries(state.unresolved).map(([field, reason]) => `${field} is missing and could not be derived: ${reason}`));
}
