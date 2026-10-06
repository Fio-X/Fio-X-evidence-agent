// What wiring strip_plot, stacked_bar_100 and mirrored_bar into the plan path adds to newsroom_viz_plan and newsroom_viz_chain: the three
// chart_type values and the thirteen form fields below. test_viz_plan_schema.mjs and test_viz_form_wiring.mjs assert them against
// schemas/newsroom-viz-spec.schema.json. The byte-pin tests no longer mask this wiring; it is a set of entries in their exact patch lists
// (scripts/fixtures/pin_patches/, scripts/lib_pin_patch.mjs).
export const FORM_CHART_TYPES = ["strip_plot", "stacked_bar_100", "mirrored_bar"];

export const FORM_FIELDS = [
  "group_order", "point_layout", "show_median", "label_extremes",                      // strip_plot
  "segment_order", "sort_segment", "highlight_segment", "segment_values",             // stacked_bar_100
  "first_row", "compare_layout", "left_series", "current_period", "period_field",      // mirrored_bar
];
