// Composes the two pure, deterministic render-QA checks (render_qa_geometry.mjs,
// render_qa_contrast.mjs) into one report per rendered visual, across both
// responsive viewports (desktop, mobile), and binds each viewport to the
// sha256 of its own rendered SVG bytes so a downstream verifier (src/verify.rs)
// can re-hash the actual file on disk and refuse to trust a report that does
// not match it.
//
// Pure: this module performs no file I/O, no network access and no model or
// provider calls. It takes rendered SVG *text* in, and returns a plain report
// object; the caller (runtime/pi/newsroom.ts tool handlers) is responsible
// for reading the rendered SVGs and for writing the returned report to an
// artifact path.
//
// Unmeasured-element policy (documented once here; both underlying checks
// already follow it internally): an element a check could not resolve
// unambiguously - an unresolved transform, an unrecognised colour format, a
// missing viewBox - is recorded (geometry.notes, contrast.unmeasured) and
// counted in geometry.summary, but never by itself fails a viewport or the
// report. Only an explicit rule failure (text_outside_viewbox, text_overlap,
// font_below_floor, indistinct_adjacent_marks, text_contrast) can fail this
// report. This mirrors the "report what we don't know, never guess a pass or
// a failure" design already documented in render_qa_geometry.mjs and
// render_qa_contrast.mjs.

import { checkSvgGeometry, estimateTextWidth, sharedWidthEnabled, RENDER_QA_GEOMETRY_VERSION } from "./render_qa_geometry.mjs";
import { checkSvgContrast, RENDER_QA_CONTRAST_VERSION } from "./render_qa_contrast.mjs";
import { parseXml } from "./render_qa_svg.mjs";
import { checkChoroplethValueLabels, checkHeatmapValueLabels, checkHeatmapFillMonotone, RENDER_QA_LABELS_VERSION } from "./render_qa_labels.mjs";
import { joinChoroplethRows, worldLabelIso3s } from "./choropleth.mjs";
import { choroplethValueText, heatmapCellText, PALETTE } from "./viz.mjs";
import { sha256Hex } from "./provenance.mjs";

export const RENDER_QA_REPORT_SCHEMA_VERSION = "render-qa/1.0.0";

// Only run when the caller (runtime/pi/newsroom.ts, at choropleth
// visualization-render time) supplies options.choropleth - the rows and
// field names the chart was built from. Anything else (bar/line/etc. charts,
// or a choropleth render call that omits it) gets exactly the pre-existing
// geometry+contrast report, unchanged.
// NEWSROOM_QA_NO_EMPTY_PASS=1: a rule that had nothing to look at is not a pass. Each entry names the population a rule runs over, taken from
// the counters the geometry and contrast checks already report. Rules that only apply when a chart has that kind of element (rect adjacency,
// leaders, stroke order, the value-axis bracket) are left out on purpose: a chart without them is not an empty pass.
const EMPTY_PASS_RULES = [
  ["text_outside_viewbox", "texts"], ["text_outside_panel", "texts"], ["text_outside_nested_svg", "texts"], ["text_overlap", "texts"],
  ["font_below_floor", "texts"], ["text_crosses_data_mark", "texts"], ["text_crosses_data_mark", "marks"], ["text_contrast", "contrast_texts"],
];
export function checkEmptyPasses(geometry, contrast) {
  const s = geometry?.summary ?? {};
  const texts = (s.texts_checked ?? 0) - (s.texts_unmeasured ?? 0);
  const population = { texts, marks: s.marks_checked ?? 0, contrast_texts: (s.texts_checked ?? 0) - (contrast?.unmeasured?.length ?? 0) };
  const failures = [];
  for (const [rule, kind] of EMPTY_PASS_RULES) {
    if (population[kind] <= 0) failures.push({ rule: "qa_rule_matched_nothing", message: `${rule} matched no ${kind.replace("_", " ")}, so its pass proves nothing`, checked_rule: rule });
  }
  return { passed: failures.length === 0, failures, population };
}

function checkViewport(svgText, options) {
  const geometry = checkSvgGeometry(svgText, options?.geometry);
  const contrast = checkSvgContrast(svgText, options?.contrast);
  const sharedWidth = sharedWidthEnabled() ? { textWidth: estimateTextWidth } : {};
  let valueLabels = null;
  let proofOnly = false;
  if (options?.choropleth) {
    valueLabels = checkChoroplethValueLabels(svgText, options.choropleth, { parseXml, joinChoroplethRows, fmt: choroplethValueText, noDataFill: PALETTE.grid, worldLabelIso3s, ...sharedWidth });
  }
  if (options?.heatmap) {
    // proof only: a heatmap whose cells cannot all be labelled still renders as before; the report just does not prove the labels
    proofOnly = true;
    const spec = options.heatmap;
    valueLabels = checkHeatmapValueLabels(svgText, spec, { parseXml, cellText: (value) => heatmapCellText(spec.spec, spec.rows, value), ...sharedWidth });
    // proof needs passing contrast too: any contrast failure in the viewport fails the labels
    if (!contrast.passed) valueLabels = { passed: false, failures: [...valueLabels.failures, { rule: "value_label_contrast", message: "the viewport has a text contrast failure" }] };
  }
  // Default-off extra checks (exact "1"): findings only; with every switch unset the report is byte-identical
  const extra = {};
  if (options?.heatmap && process.env.NEWSROOM_QA_HEATMAP_MONOTONE === "1") extra.heatmap_monotone = checkHeatmapFillMonotone(svgText, options.heatmap, { parseXml });
  if (process.env.NEWSROOM_QA_NO_EMPTY_PASS === "1") extra.no_empty_pass = checkEmptyPasses(geometry, contrast);
  const extraChecks = Object.keys(extra).length ? { passed: Object.values(extra).every((c) => c.passed), checks: extra } : null;
  return {
    svg_sha256: sha256Hex(svgText),
    passed: geometry.passed && contrast.passed && (valueLabels && !proofOnly ? valueLabels.passed : true) && (extraChecks ? extraChecks.passed : true),
    geometry: {
      passed: geometry.passed,
      failures: geometry.failures,
      notes: geometry.notes,
      summary: geometry.summary,
    },
    contrast: {
      passed: contrast.passed,
      failures: contrast.failures,
      unmeasured: contrast.unmeasured,
    },
    ...(valueLabels ? { value_labels: valueLabels } : {}),
    ...(extraChecks ? { extra_checks: extra } : {}),
  };
}

/**
 * Run both render-QA checks over a rendered desktop/mobile SVG pair, or over
 * desktop alone when the caller has no mobile viewport to check (for example
 * an infographic page rendered with phone-facing pages off).
 *
 * @param {{desktop: string, mobile?: string, compact?: string}} svgByViewport - full rendered
 *   `<svg ...>...</svg>` document text for each responsive viewport. `mobile`
 *   is optional; when omitted, the report covers desktop only.
 * @param {object} [options]
 * @param {object} [options.geometry] - forwarded to checkSvgGeometry.
 * @param {object} [options.contrast] - forwarded to checkSvgContrast.
 * @param {object} [options.choropleth] - when present, also runs
 *   checkChoroplethValueLabels over each viewport and folds its `passed`
 *   into the viewport/report `passed`. Forwarded as-is to that check as its
 *   `options` (rows, category_field, value_field, category_names, unit).
 * @returns {{
 *   schema_version: string,
 *   geometry_check_version: string,
 *   contrast_check_version: string,
 *   value_labels_check_version?: string,
 *   passed: boolean,
 *   failure_count: number,
 *   viewports: {desktop: object, mobile?: object, compact?: object},
 * }}
 */
export function runRenderQa({ desktop, mobile, compact } = {}, options = {}) {
  if (typeof desktop !== "string") {
    throw new Error("runRenderQa: desktop SVG text is required");
  }
  if (mobile !== undefined && typeof mobile !== "string") {
    throw new Error("runRenderQa: mobile SVG text must be a string when present");
  }
  if (compact !== undefined && typeof compact !== "string") {
    throw new Error("runRenderQa: compact SVG text must be a string when present");
  }
  const viewports = { desktop: checkViewport(desktop, options) };
  // the heatmap label proof is desktop-only; other viewports keep the plain report (and so never prove it)
  const { heatmap: _heatmap, ...otherOptions } = options ?? {};
  if (mobile !== undefined) viewports.mobile = checkViewport(mobile, otherOptions);
  // The 8-column chart variant is checked exactly like the others, in full.
  if (compact !== undefined) viewports.compact = checkViewport(compact, otherOptions);
  const viewportNames = Object.keys(viewports);
  const failureCount = viewportNames.reduce(
    (total, viewport) =>
      total +
      viewports[viewport].geometry.failures.length +
      viewports[viewport].contrast.failures.length +
      (viewports[viewport].value_labels?.failures.length ?? 0) * (options?.heatmap ? 0 : 1) +
      (viewports[viewport].extra_checks ? Object.values(viewports[viewport].extra_checks).reduce((n, c) => n + c.failures.length, 0) : 0),
    0,
  );
  return {
    schema_version: RENDER_QA_REPORT_SCHEMA_VERSION,
    geometry_check_version: RENDER_QA_GEOMETRY_VERSION,
    contrast_check_version: RENDER_QA_CONTRAST_VERSION,
    ...(options?.choropleth || options?.heatmap ? { value_labels_check_version: RENDER_QA_LABELS_VERSION } : {}),
    passed: viewportNames.every((viewport) => viewports[viewport].passed),
    failure_count: failureCount,
    viewports,
  };
}
