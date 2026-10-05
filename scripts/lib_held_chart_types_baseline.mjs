// The edits that took four chart types (hierarchy_tree, geo_flow_map, cartographic_flow_map, trajectory_profile) off the
// model's list: the `chart_type` enum of newsroom_viz_plan (and, because the chain takes the plan's properties, of
// newsroom_viz_chain), the plan tool's description, one plan guideline, and the two fragments of the relation rule hint
// that name them (the hint is on only when NEWSROOM_SPEED_RULE_HINTS=1).
//
// Several suites assert that a tool surface is byte-identical to an older git baseline, and those baselines carry the
// old wording. The change is intended, so each of those suites compares the baseline with the CURRENT surface after
// revertHeldChartTypes() has put the old wording back, next to revertNameLocalization(). Everything else must still match
// byte for byte. The revert is strict, the way revertNameLocalization is: every declared edit has to be present the
// expected number of times in the expected tool, so a reverted change, or one that spreads to another tool, fails here.
//
// The edits are data below, not a regex over "anything that mentions a held type".
import assert from "node:assert/strict";

const BEFORE_ENUM = Object.freeze(["horizontal_bar", "dot", "dumbbell", "slope", "line", "multi_line", "small_multiples", "scatter", "diverging_bar", "heatmap", "sankey", "alluvial", "node_link", "adjacency_matrix", "hierarchy_tree", "timeline", "streamgraph", "parallel_sets", "chord", "geo_flow_map", "cartographic_flow_map", "trajectory_profile", "process_schematic", "waffle", "choropleth"]);
export const HELD_CHART_TYPES = Object.freeze(["hierarchy_tree", "geo_flow_map", "cartographic_flow_map", "trajectory_profile"]);
const ENUM = Object.freeze({ before: BEFORE_ENUM, after: Object.freeze(BEFORE_ENUM.filter((type) => !HELD_CHART_TYPES.includes(type))) });

// The plan tool's own description (a string on the tool, not on a property).
const DESCRIPTION_EDITS = Object.freeze([
  {
    id: "description: plan tool",
    before: "Supports statistical charts plus flows, networks, hierarchies, temporal structures, spatial flows and explanatory process graphics.",
    after: "Supports statistical charts plus flows, networks, temporal structures, choropleth maps and explanatory process graphics.",
  },
]);

// The plan prompt guideline that names topology-aware forms.
const GUIDELINE_EDITS = Object.freeze([
  {
    id: "guideline: topology-aware forms",
    before: "such as Sankey, parallel sets, chord, geographic flow map, adjacency matrix, hierarchy tree, timeline, or process schematic.",
    after: "such as Sankey, parallel sets, chord, adjacency matrix, timeline, or process schematic.",
  },
]);

// Fragments of the relation field's rule hint. Present in newsroom_viz_plan and newsroom_viz_chain only when the hints are on.
const RULE_HINT_EDITS = Object.freeze([
  { id: "rule hint: flow", before: "flow sankey/alluvial/parallel_sets/geo_flow_map/cartographic_flow_map;", after: "flow sankey/alluvial/parallel_sets;" },
  { id: "rule hint: geography", before: "geography geo_flow_map/cartographic_flow_map/choropleth;", after: "geography choropleth;" },
]);

// Which tool carries which edit. Any other tool must carry none (its surface is compared unchanged).
const TOOLS = Object.freeze({
  newsroom_viz_plan: { description: true, guidelines: true, hints: true },
  newsroom_viz_chain: { description: false, guidelines: false, hints: true },
});

export const HELD_CHART_TYPE_EDITS = Object.freeze({ enum: ENUM, description: DESCRIPTION_EDITS, guidelines: GUIDELINE_EDITS, ruleHints: RULE_HINT_EDITS, tools: Object.keys(TOOLS) });

const sameArray = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * A copy of `tool` as it was before the held-chart-type edits. Other tools are returned as they are.
 *
 * `descriptions: false` is for a suite whose StringEnum stand-in drops the options object (property descriptions, so the
 * rule hint, are gone there; only the enum values, the tool description and the prompt guidelines survive).
 * `enumValues: false` is for a suite whose stand-ins drop the enum values as well; the enum edit is then expected absent.
 * The rule hint edits are expected both present (once) or both absent in a tool, so the helper works with the hints on or off.
 *
 * Throws when a declared edit is not found the expected number of times, so a reverted change cannot pass quietly.
 */
export function revertHeldChartTypes(tool, { descriptions = true, enumValues = true } = {}) {
  const scope = TOOLS[tool?.name];
  if (!scope) return tool;
  const found = new Map();
  const bump = (id, count) => found.set(id, (found.get(id) ?? 0) + count);
  const replaceIn = (text, edits) => {
    let out = text;
    for (const edit of edits) {
      const parts = out.split(edit.after);
      if (parts.length > 1) {
        bump(edit.id, parts.length - 1);
        out = parts.join(edit.before);
      }
    }
    return out;
  };
  const walk = (node, edits) => {
    if (typeof node === "string") return replaceIn(node, edits);
    if (Array.isArray(node)) {
      if (sameArray(node, ENUM.after)) {
        bump("enum", 1);
        return [...ENUM.before];
      }
      return node.map((item) => walk(item, edits));
    }
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, edits)]));
    return node;
  };
  const reverted = { ...tool, parameters: walk(tool.parameters, RULE_HINT_EDITS) };
  if (typeof tool.description === "string") reverted.description = replaceIn(tool.description, DESCRIPTION_EDITS);
  if (tool.promptGuidelines !== undefined) reverted.promptGuidelines = walk(tool.promptGuidelines, GUIDELINE_EDITS);
  const expected = new Map([["enum", enumValues ? 1 : 0]]);
  for (const edit of DESCRIPTION_EDITS) expected.set(edit.id, scope.description ? 1 : 0);
  for (const edit of GUIDELINE_EDITS) expected.set(edit.id, scope.guidelines ? 1 : 0);
  // The rule hint is one string: its two fragments appear together, or (hints off) not at all.
  const hintCount = found.get(RULE_HINT_EDITS[0].id) ?? 0;
  for (const edit of RULE_HINT_EDITS) expected.set(edit.id, scope.hints && descriptions ? hintCount : 0);
  assert.ok(hintCount === 0 || (scope.hints && descriptions && hintCount === 1), `held chart types: ${tool.name} carries the rule hint edit ${hintCount} time(s), expected 0 or 1 (see scripts/lib_held_chart_types_baseline.mjs)`);
  for (const [id, count] of expected) {
    assert.equal(found.get(id) ?? 0, count, `held chart types: ${tool.name} carries the declared edit '${id}' ${found.get(id) ?? 0} time(s), expected ${count} (see scripts/lib_held_chart_types_baseline.mjs)`);
  }
  return reverted;
}
