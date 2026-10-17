// Text for the publication tools: which visual_type values a module may carry and how the page style is resolved.
// Every value is read from the module that checks it; nothing is listed here. scripts/test_publication_render_rules_text.mjs ties each
// sentence to its check.
import { D3_EDITORIAL_CAPABILITIES } from './d3_editorial.mjs';
import { PLOTLY_EDITORIAL_CAPABILITIES } from './plotly_editorial.mjs';
import { EVIDENCE_BOUND_PLOTLY_TYPES } from './publication_binding.mjs';
import { inferPublicationStyleTopologies } from './publication.mjs';
import { PUBLICATION_DIMENSIONS } from './story_graph.mjs';

// The values a module's visual_type may take for the two engines the renderer compiles itself.
export function publicationVisualTypes() {
  const plotly = [...PLOTLY_EDITORIAL_CAPABILITIES];
  return { d3: [...D3_EDITORIAL_CAPABILITIES], plotly, plotlyBound: EVIDENCE_BOUND_PLOTLY_TYPES.filter((type) => plotly.includes(type)) };
}

export function visualTypeText() {
  const types = publicationVisualTypes();
  return `Chart kind of the module. A d3 module needs one of: ${types.d3.join(', ')}. A plotly module takes one of: ${types.plotly.join(', ')} (statistical when omitted); when it is bound by computation_ref only ${types.plotlyBound.join(', ')} are built. geo_linked is the point map (lon/lat or ISO-3 location fields). Any other value on a d3 or plotly module is refused when the page is rendered.`;
}

// dimension -> topology, asked of the same function the render check uses (stat and text modules are skipped by it).
export function styleTopologyByDimension() {
  const byTopology = {};
  for (const dimension of PUBLICATION_DIMENSIONS) {
    const [topology] = inferPublicationStyleTopologies({ modules: [{ type: 'plotly', explanatory_dimension: dimension }] });
    (byTopology[topology] ??= []).push(dimension);
  }
  return byTopology;
}

export function styleRuleText() {
  const byTopology = styleTopologyByDimension();
  const named = Object.entries(byTopology).filter(([topology]) => topology !== 'tabular').map(([topology, dimensions]) => `${dimensions.join('/')} -> ${topology}`);
  return `The page style is resolved here from the modules' explanatory_dimension (${named.join('; ')}; every other dimension -> tabular; stat and text modules are skipped). The render is refused with "Style mapping blocked" when the style profile (the style_profile given to newsroom_publication_plan, or the automatic choice) does not list every dimension and topology on the page. newsroom_style_map checks the same rule; it is not a required step, but call it before the plan when the page mixes several of these dimensions.`;
}
