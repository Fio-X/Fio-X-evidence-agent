// NEWSROOM_SPEED_CONTRACT_TEXT=1: sentences for field descriptions that state rules the checks already enforce.
// Text only. Every statement is built from the check's own constant or set where one exists (passed in by the caller,
// never copied). A rule whose number is an inline literal in a check keeps its number here, and
// scripts/test_contract_text.mjs fails if the literal in the check source no longer matches.
import { readFileSync } from "node:fs";

// Inline literals of infographic.mjs / editorial_validators.mjs / newsroom.ts (checked by the drift test).
export const CONTRACT_LITERALS = Object.freeze({
  planAltMin: 30,
  illustrationAltMin: 20,
  minContentModules: 4,
  minVisualModules: 2,
  minStoryDimensions: 2,
  minNonSupportRelations: 1,
  maxSidecars: 3,
});

const list = (values) => [...values].join(", ");

export function loadGrammarRegistrySync(baseUrl) {
  // Source tree: runtime/pi/ beside config/. Materialized artifact: runtime/ beside config/.
  for (const rel of ["../../config/editorial-grammar-registry.json", "../config/editorial-grammar-registry.json"]) {
    try { return JSON.parse(readFileSync(new URL(rel, baseUrl), "utf8")); } catch { /* try the next place */ }
  }
  return null;
}

// inputs: { readerTasks: Set (SEMANTIC_REQUIRED_READER_TASKS), visualGrammarForms: map of Set (VISUAL_GRAMMAR_FORMS), registry }
export function contractStatements({ readerTasks, visualGrammarForms, registry, literals = CONTRACT_LITERALS }) {
  const out = {};
  out.planAlt = `Page alt text, at least ${literals.planAltMin} characters.`;
  out.moduleAlt = `Illustration modules only: at least ${literals.illustrationAltMin} characters.`;
  out.moduleClaimIds = "A text module (one without source_quote) needs body and at least one claim_id; an illustration module needs at least one claim_id.";
  if (readerTasks?.size) out.readerTask = `Reader tasks ${list(readerTasks)} need both measure_semantics and claim_spec; other tasks may omit them.`;
  if (visualGrammarForms) {
    const rows = Object.entries(visualGrammarForms).map(([grammar, forms]) => `${grammar}: ${list(forms)}`);
    out.visualGrammar = `Visual modules only. The module's chart_type must be one of these for its grammar (${rows.join("; ")}).`;
  }
  out.modules = `The page needs at least ${literals.minContentModules} claim-bearing content modules, at least ${literals.minVisualModules} visual or illustration modules together, modules covering at least ${literals.minStoryDimensions} story dimensions, and at least ${literals.minNonSupportRelations} story-graph edge whose relation is not 'supports'.`;
  out.sceneAnchor = `Must be a visual or illustration module; sidecar_module_ids holds 1 to ${literals.maxSidecars} unique module ids.`;
  out.deliveryRole = "infographic_module also needs story_graph_ref and story_node_ids.";
  out.heroUnit = "hero_stat only: empty, or a unit the hero's claim itself shows; the refusal lists the allowed ones.";
  out.scaleType = "log needs domain_min > 0 and domain_max > domain_min; horizontal_bar and diverging_bar need baseline_policy zero or symmetric_zero.";
  out.assetAvailable = "available=true needs at least one source_refs entry.";
  const grammars = registry?.grammars;
  if (Array.isArray(grammars) && grammars.length) {
    const rows = grammars.map((g) => `${g.id}: needs ${list(g.required_evidence ?? [])}; covers ${list(g.compatible_visual_grammars ?? [])}`);
    out.primaryGrammar = `Eligible only if every listed evidence feature is in evidence_features (${rows.join("; ")}). Primary plus supporting must cover every module visual_grammar (trend counts as change). Which grammar is eligible depends on the evidence you supply, so this cannot be fixed in advance.`;
  }
  return out;
}
