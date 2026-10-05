// What wiring strip_plot, stacked_bar_100 and mirrored_bar into the plan path adds to newsroom_viz_plan and newsroom_viz_chain.
//
// Several tests compare today's tool definitions with an older newsroom.ts (a4d4cb0, bc1ccfd, 42a5e77). The wiring is an approved
// difference there. formWiringMask() is a JSON.stringify replacer that removes exactly that difference from a viz tool's
// definition: the three chart_type values, the fourteen form fields, the three form names in the category_names description
// and the three guideline sentences. Everything else must still equal the baseline, and a half-applied wiring (one chart_type
// value missing, a guideline not starting with its pattern) is not masked, so it fails the comparison.
// test_viz_plan_schema.mjs asserts the wiring itself against schemas/newsroom-viz-spec.schema.json; it is not asserted here.
export const FORM_CHART_TYPES = ["strip_plot", "stacked_bar_100", "mirrored_bar"];

export const FORM_FIELDS = [
  "group_order", "point_layout", "show_median", "label_extremes",                      // strip_plot
  "segment_order", "sort_segment", "highlight_segment", "segment_values", "decimals",  // stacked_bar_100 (decimals: 0 or 1 there)
  "first_row", "compare_layout", "left_series", "current_period", "period_field",      // mirrored_bar
];

export const FORM_GUIDELINE = /^Use chart_type='(strip_plot|stacked_bar_100|mirrored_bar)'/;

export const VIZ_TOOL_NAMES = new Set(["newsroom_viz_plan", "newsroom_viz_chain"]);

const FIELD_SET = new Set(FORM_FIELDS);
const CATEGORY_NAMES_NEW = "waffle/strip_plot/stacked_bar_100/choropleth";
const CATEGORY_NAMES_OLD = "waffle/choropleth";

// A form field is only removed from the object that lists the plan's properties (the holder has chart_type next to it), so a
// nested key that happens to share a name is never touched. A regular function: JSON.stringify passes the holder as `this`.
export function formWiringMask(key, value) {
  if (FIELD_SET.has(key) && this && typeof this === "object" && "chart_type" in this) return undefined;
  if (key === "enum" && Array.isArray(value) && FORM_CHART_TYPES.every((type) => value.includes(type))) return value.filter((entry) => !FORM_CHART_TYPES.includes(entry));
  if (key === "promptGuidelines" && Array.isArray(value)) return value.filter((line) => !FORM_GUIDELINE.test(line));
  if (key === "description" && typeof value === "string") return value.replace(CATEGORY_NAMES_NEW, CATEGORY_NAMES_OLD);
  return value;
}

// The replacer for a tool by name: only the two viz tools carry the wiring.
export const maskFor = (toolName) => (VIZ_TOOL_NAMES.has(toolName) ? formWiringMask : undefined);
