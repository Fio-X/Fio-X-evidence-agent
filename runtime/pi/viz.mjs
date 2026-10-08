import { createHash } from "node:crypto";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL, GEOMETRY_SEMANTICS, basemapAdequacy, getBasemap, MAP_PROJECTIONS, coordinateExtent, createProjection, createProjectionForExtent, geometryDisclosure, greatCirclePoints, optimizeAbstractOdRoutes, parseRouteGeometry, parseTrajectoryPoints, projectedPolylinePath, renderBasemapPaths, selectRoutes, trajectoryLines, validRouteGeometry } from "./cartography.mjs";
import { CATEGORY_NAME_MODES, CURRENCY_NAME_MODES, ECONOMY_NAME_MODES, economyEntryFor, resolveEconomyDisplayName, unmappedEconomyNameValues } from "./economy_names.mjs";
import { ASCENT_RATIO, ASCENT_RATIO as QA_ASCENT_RATIO, BOLD_WEIGHT_THRESHOLD as QA_BOLD_WEIGHT_THRESHOLD, DESCENT_RATIO, DESCENT_RATIO as QA_DESCENT_RATIO, LATIN_ADVANCE_WIDTHS as QA_LATIN_ADVANCE_WIDTHS, LATIN_BOLD_ADVANCE_WIDTHS as QA_LATIN_BOLD_ADVANCE_WIDTHS, TEXT_WIDTH_FACTORS as QA_TEXT_WIDTH_FACTORS, checkSvgGeometry, estimateTextWidth } from "./render_qa_geometry.mjs";
import { checkSvgContrast } from "./render_qa_contrast.mjs";
import { checkChoroplethValueLabels } from "./render_qa_labels.mjs";
import { parseXml } from "./render_qa_svg.mjs";
import { CHOROPLETH_BASEMAP_ID, bboxCenter, chooseMapProjection, enclosingCap, classBreaks, isRowSlice, classifyValue, featurePath, fitAzimuthalProjection, fitMapProjection, framingRings, geometryRings, clippedFramingRings, joinChoroplethRows, lintChoroplethSpec, isAntarcticaFeature, isWorldExtent, mapWorldEnabled, WORLD_FRAME_POINTS, worldLabelIso3s, neFeatureAttributes, neFeatureCount, neFeatureGeometry, niceBreaks, projectedFeatureBBox, ringWithinHorizon } from "./choropleth.mjs";

export const CHART_TYPES = [
  "horizontal_bar",
  "dot",
  "dumbbell",
  "mirrored_bar",
  "slope",
  "line",
  "multi_line",
  "small_multiples",
  "scatter",
  "strip_plot",
  "diverging_bar",
  "heatmap",
  "sankey",
  "alluvial",
  "node_link",
  "adjacency_matrix",
  "hierarchy_tree",
  "timeline",
  "streamgraph",
  "parallel_sets",
  "chord",
  "geo_flow_map",
  "cartographic_flow_map",
  "trajectory_profile",
  "process_schematic",
  "waffle",
  "choropleth",
  "treemap",
  "stacked_bar_100",
];

export const VISUAL_FAMILIES = [
  "statistical",
  "flow",
  "relationship",
  "hierarchy",
  "temporal",
  "spatial",
  "explanatory",
];

export const READER_TASKS = [
  "ranking",
  "comparison",
  "change",
  "distribution",
  "correlation",
  "part_to_whole",
  "spatial",
  "flow",
  "relationship",
  "hierarchy",
  "sequence",
  "process",
];

const DEFAULT_PALETTE = {
  ink: "#202124",
  muted: "#687076",
  grid: "#d9dde1",
  faint: "#f2f3f4",
  accent: "#d1493f",
  accent2: "#2f6f8f",
  context: "#a9afb5",
  positive: "#3c7d5a",
  negative: "#a8443e",
  series3: "#7b6ba8",
  series4: "#b7843e",
  series5: "#4c8a83",
  series6: "#8c6c59",
  // waffle only: a filled cell (navy) and an empty cell (track), matching
  // the user-approved spike (experiments/infographic/africa) rather than
  // the cooler ink/context pairing the rest of the palette uses, since a
  // waffle grid reads as one filled/unfilled substance, not a categorical
  // series.
  navy: "#1d3557",
  track: "#efece6",
  // Single-grid waffle's non-highlighted/"Other" grey-blue ramp (see
  // WAFFLE_GREYS below): kept as its own palette field, byte-identical to
  // the pre-house-style hardcoded WAFFLE_GREY_STEPS array, so legacy-style
  // waffle output is untouched by the house-style live-binding switch.
  waffleGreySteps: ["#3a4552", "#5c6773", "#828d99", "#aab4c0", "#d3d9e0"],
};

const DEFAULT_PAPER = "#ffffff";
// Neutral light-grey -> deep grey-blue ramp (house style decision; same
// values as feat/map-inset's CHOROPLETH_RAMP, reused here rather than
// redone - see that branch's 9e80c46 for the OKLab-monotone derivation).
const DEFAULT_CHOROPLETH_RAMP = ["#a9b4bf", "#8999a8", "#65788c", "#4c647c", "#2f4b66"];
const DEFAULT_FONT_SANS = "Arial, Helvetica, sans-serif";
// Fix 12 (font unification): house style used to put chart titles on a
// separate serif stack (a since-removed HOUSE_FONT_TITLE) so the serif/sans
// pairing read as a hierarchy on its own, independent of weight. User
// decision: all sans - one CJK sans stack for every house-style face (page
// title, section heads, chart titles, hero numerals, body text and chart
// labels alike); weight (700 vs 400) carries the hierarchy instead. FONT_TITLE
// now resolves to this same stack under house style too (see applyStyle
// below) - exported so runtime/pi/infographic.mjs's own page chrome can reuse
// this exact stack rather than declaring a second, duplicate constant.
// Single-quoted font names (not double-quoted): every renderer embeds this
// raw inside a double-quoted SVG attribute (font-family="${FONT_SANS}"), so
// a double-quoted font name here would terminate that attribute early and
// produce invalid SVG - CSS accepts either quote style for a font-family
// name, so single quotes sidestep the clash without touching every call site.
export const HOUSE_FONT_SANS = "'PingFang SC', 'Heiti SC', 'Noto Sans SC', 'Microsoft YaHei', Arial, Helvetica, sans-serif";

// House style (now the DEFAULT - see styleFor/applyStyle below; "legacy" is
// the only opt-out): one white paper, one reserved accent red, and the rest
// grey. Replaces the earlier three beige/mustard house_a/b/c candidates
// (rejected) with the single palette the user actually picked:
//   - paper #FFFFFF; ink #1A1A1A (titles/axis text only - never a mark);
//     muted #666666 (secondary text, 5.74:1 on white); grid #E5E5E5.
//   - accent #D0021B - the one reserved highlight colour (the story's single
//     called-out series/flow/category/tile), 5.67:1 on white so it is safe
//     as *either* a mark or running text; never a routine Nth series colour.
//   - three context greys #BDBDBD / #9E9E9E / #757575 cover every other
//     role: fill/mark work for the two lighter ones (1.88:1 / 2.68:1 on
//     white - fine for a shape, never for text), #757575 clears 4.5:1
//     (4.61:1) so it doubles as the one text-safe grey besides muted/ink.
// Every renderer still only ever reads PALETTE.<role> / FONT_SANS/
// FONT_TITLE/PAPER by property access, so this swap needed no renderer
// changes. accent is deliberately excluded from SERIES_COLORS ("one
// reserved accent, never a 3rd routine series colour"); a multi-series
// chart (sankey/streamgraph/chord/parallel_sets/grouped dot) tells its
// categories apart by the four grey steps instead.
export const HOUSE_PALETTES = {
  house: {
    paper: "#FFFFFF",
    ink: "#1A1A1A",
    muted: "#666666",
    grid: "#E5E5E5",
    faint: "#F2F2F2", // light panel/background tint between grid and paper
    accent: "#D0021B", // the one reserved accent - fill/mark AND text-safe
    accent2: "#757575", // "the metric"/default-mark grey - text-safe (4.61:1)
    context: "#9E9E9E", // fill/mark-only mid grey - never text (2.68:1)
    positive: "#757575", // no separate positive hue in house style - accent2's grey
    negative: "#D0021B", // no separate negative hue in house style - the one accent
    series3: "#BDBDBD",
    series4: "#9E9E9E",
    series5: "#757575",
    series6: "#666666",
    navy: "#D0021B", // waffle filled cell -> the one accent (never near-black: ink is reserved for titles/axis text)
    track: "#E5E5E5", // waffle empty cell -> grid grey
    choroplethRamp: DEFAULT_CHOROPLETH_RAMP,
    // Single-grid waffle's non-highlighted/"Other" ramp, house version:
    // darkest-to-lightest through the same four context greys SERIES_COLORS'
    // house set already uses for multi-category work (series6/5/4/3), plus
    // one lighter tint (faint) reserved for "Other" - mirrors the "one
    // accent, everything else grey steps" house rule instead of reusing the
    // legacy blue-grey ramp's own hex values.
    waffleGreySteps: ["#404040", "#646464", "#8B8B8B", "#B9B9B9", "#F2F2F2"],
  },
};

// Mutable "current style" bindings. Every renderer reads PALETTE.<role> /
// FONT_SANS/PAPER by property access rather than destructuring at module
// load, so reassigning these bindings before a render call changes every
// downstream reference without touching the ~100 call sites below. Safe
// because every render entry point (renderVizSvg/renderVizMobileSvg) is
// synchronous end-to-end: no other render call can interleave between
// applyStyle(spec) and this call's own return.
// Exported (live, like CHOROPLETH_RAMP below) so an independent from-the-
// rendered-artifact checker - e.g. render_qa_labels.mjs's no-data-fill rule -
// can cross-reference the *current* role colour instead of keeping its own
// hardcoded copy that silently drifts the moment a renderer literal here is
// swapped for a live binding.
export let PALETTE = DEFAULT_PALETTE;
let PAPER = DEFAULT_PAPER;
let FONT_SANS = DEFAULT_FONT_SANS;
let FONT_TITLE = DEFAULT_FONT_SANS;
// Exported as a live `let` binding (not a snapshot) so scripts/test_choropleth.mjs's
// own import of CHOROPLETH_RAMP always sees whichever ramp applyStyle(spec)
// most recently selected, the same live-binding contract PALETTE/FONT_SANS/
// LAYERING_FIX already use.
export let CHOROPLETH_RAMP = DEFAULT_CHOROPLETH_RAMP;
// Single-grid waffle's grey/grey-blue ramp (see DEFAULT_PALETTE.waffleGreySteps
// / HOUSE_PALETTES.house.waffleGreySteps above): same mutable-binding pattern
// as CHOROPLETH_RAMP, reassigned per-style in applyStyle.
let WAFFLE_GREYS = DEFAULT_PALETTE.waffleGreySteps;
let SERIES_COLORS = seriesColorsFor(DEFAULT_PALETTE, "legacy");
let DECIMAL_MODE = "default";
// Fix 2 (value-label precision): whether the *resolved* style is anything
// other than "legacy". Deliberately separate from DECIMAL_MODE above (an
// older, narrower opt-in gated on an explicit style_id==="house" request,
// kept exactly as-is for its one existing use, the "%"-unit one-decimal
// rule) - this new flag mirrors PALETTE/FONT_SANS/etc and simply follows
// whichever style applyStyle(spec) actually resolved, so the shared
// per-chart decimals mechanism below applies to every house-style chart by
// default (house already is the default), while "legacy" stays a complete
// no-op for it and therefore byte-identical.
let HOUSE_STYLE_ACTIVE = false;
let TEXT_SAFE_ON_WHITE = { [DEFAULT_PALETTE.accent]: DEFAULT_PALETTE.negative };
// Mark/annotation layering fix (on by default with house style): reference
// lines and value-axis gridlines paint *before* data marks (so a
// bar/dot/connector visually covers them where they cross) instead of the
// old draw order, which painted them last and let a reference_line's dashed
// rule or the zero baseline slice across bars. Off only under the "legacy"
// escape hatch, which reproduces the pre-house draw order byte-for-byte.
let LAYERING_FIX = true;

function seriesColorsFor(p, style) {
  // "legacy" keeps its original 8-entry order/values so any existing
  // multi-series render (grouped dots, sankey, streamgraph, ...) that opts
  // back into the old look stays byte-identical. House (the default) caps
  // at 4 grey steps (accent2/series3/series4/series5) plus muted, cycling
  // for more categories - the user's "one accent, everything else grey"
  // rule applies to *every* chart, not just the ones with an explicit
  // highlight, so no house series colour is ever the reserved accent.
  if (style === "legacy") return [p.accent2, p.accent, p.positive, p.series3, p.series4, p.series5, p.series6, p.context];
  return [p.series3, p.series4, p.series5, p.series6];
}

// House style is the default for every chart; "legacy" is the only opt-out
// (kept for tests/back-compat with the old palette+draw order), settable
// per-chart via spec.style_id/spec.style, or process-wide via
// NEWSROOM_HOUSE_STYLE=legacy.
function styleFor(spec) {
  const requested = spec?.style_id ?? spec?.style;
  if (requested === "legacy" || requested === "default") return "legacy";
  if (requested === "house") return "house";
  if (process.env.NEWSROOM_HOUSE_STYLE === "legacy") return "legacy";
  return "house";
}

function applyStyle(spec) {
  const style = styleFor(spec);
  if (style === "legacy") {
    PALETTE = DEFAULT_PALETTE;
    PAPER = DEFAULT_PAPER;
    FONT_SANS = DEFAULT_FONT_SANS;
    FONT_TITLE = DEFAULT_FONT_SANS;
    CHOROPLETH_RAMP = DEFAULT_CHOROPLETH_RAMP;
    WAFFLE_GREYS = DEFAULT_PALETTE.waffleGreySteps;
    TEXT_SAFE_ON_WHITE = { [DEFAULT_PALETTE.accent]: DEFAULT_PALETTE.negative };
    TREEMAP_GROUP_HUES = LEGACY_TREEMAP_GROUP_HUES;
  } else {
    const house = HOUSE_PALETTES.house;
    PALETTE = house;
    PAPER = house.paper;
    FONT_SANS = HOUSE_FONT_SANS;
    // Fix 12: all sans - the title face collapses onto the same stack as
    // everything else under house style (was HOUSE_FONT_TITLE, a Songti-led
    // serif stack, now removed). Legacy is unaffected: its FONT_TITLE already
    // equalled FONT_SANS (both DEFAULT_FONT_SANS) before this fix, and still
    // does - see the "legacy" branch above, untouched.
    FONT_TITLE = HOUSE_FONT_SANS;
    CHOROPLETH_RAMP = house.choroplethRamp;
    WAFFLE_GREYS = house.waffleGreySteps;
    // accent and accent2 are both already >=4.5:1 on white (see the palette
    // comment above), so each maps to itself - no swap needed.
    TEXT_SAFE_ON_WHITE = { [house.accent]: house.accent, [house.accent2]: house.accent2 };
    TREEMAP_GROUP_HUES = HOUSE_TREEMAP_GROUP_HUES;
  }
  SERIES_COLORS = seriesColorsFor(PALETTE, style);
  // Decimal formatting (fmt()'s one-decimal "%"" mode) stays an explicit,
  // separate opt-in from the palette/layering default: it is a *text
  // content* change, not colour/layering, so flipping the default style to
  // house must never silently reformat every existing "%"-unit label.
  // Nothing currently requests style_id/style: "house" explicitly (house is
  // already the default), so DECIMAL_MODE stays "default" - i.e. byte-
  // identical fmt() output - until some caller opts in on purpose.
  const requested = spec?.style_id ?? spec?.style;
  DECIMAL_MODE = requested === "house" ? "house" : "default";
  LAYERING_FIX = style !== "legacy";
  HOUSE_STYLE_ACTIVE = style !== "legacy";
  return style;
}

// Treemap fill scheme: composition/part-to-whole reads as one substance, not
// a categorical rainbow, so a tile's hue must never imply a distinct
// category unless spec.group_field says so. Every unlabelled/ungrouped tile
// gets the same neutral; only highlight_values gets the one accent; a
// group_field gets at most 3 muted hues (one per group), never SERIES_COLORS'
// full 8-colour cycle. Each entry here is numerically verified (see the
// contrast check beside planTreemapTileLabel below) to clear 4.5:1 against
// its labelStyleOnFill-chosen text colour, so no tile ever needs a halo.
// Read live off the mutable PALETTE binding (not captured as a const at
// module load) so a tile's neutral/accent fill actually follows whichever
// style applyStyle(spec) most recently selected, instead of freezing to
// whatever PALETTE happened to be bound to when this module first
// evaluated (always DEFAULT_PALETTE, since applyStyle only ever runs later,
// per render call).
function treemapNeutralFill() { return PALETTE.context; }
function treemapAccentFill() { return PALETTE.accent; }
// Legacy group hues (pre-house palette): a faint blue/green/tan triad. Kept
// byte-identical so NEWSROOM_HOUSE_STYLE=legacy renders are unaffected.
const LEGACY_TREEMAP_GROUP_HUES = ["#aebdd1", "#b9c9b0", "#d0bfa8"];
// House group hues: the "one accent, everything else grey" rule applies to
// group_field tiles too, so a group's hue is one of three grey steps (not a
// categorical blue/green/tan) - the same BDBDBD/9E9E9E context greys
// SERIES_COLORS' house set already uses, plus one lighter D6D6D6 step so a
// 3-group treemap still reads as 3 distinguishable tiles. Each step clears
// 4.5:1 against PALETTE.ink (labelStyleOnFill's ink branch), so every tile
// still needs no halo (see the contrast note beside labelStyleOnFill).
const HOUSE_TREEMAP_GROUP_HUES = ["#D6D6D6", "#BDBDBD", "#9E9E9E"];
// Mutable "current" binding (same pattern as PALETTE/CHOROPLETH_RAMP above):
// read live off this binding rather than a module-load-time const, so a
// tile's group hue actually follows whichever style applyStyle(spec) most
// recently selected.
let TREEMAP_GROUP_HUES = LEGACY_TREEMAP_GROUP_HUES;

// zh unit localisation for treemap value labels only: the shared fmt()
// helper (and every other chart type's snapshot) is left untouched. Most
// entries here only swap the *unit token* fmt() appended (or reposition it,
// per zh convention of number-then-unit with no space) once fmt() has
// already run - the numeric text itself is never recomputed. "$B" is the one
// deliberate exception: 十亿 (billion) has no idiomatic zh reading, so a zh
// page instead uses 亿 (hundred-million) - an *exact* x10 unit conversion
// (see treemapZhOkuFromBillions), not a silent rescale, since 1 billion is
// exactly 10 亿 by definition. Extend this table rather than fmt() itself if
// a new unit token shows up.
const TREEMAP_ZH_UNIT = { "$M": "百万美元", "$": "美元" };

// Converts a $B (billion-denominated) value to its 亿 (hundred-million)
// reading: an exact x10 multiplication, then the same magnitude-based
// decimal-precision rule fmt() itself uses (0 decimals >=100, 1 decimal
// >=10, 2 decimals below that - each trimmed of trailing zeros), plus
// thousands separators on the integer part, since a converted value crosses
// the 1,000 mark far more often than the raw $B figure did. Returns the
// number only (no unit suffix) - the caller appends "亿美元".
function treemapZhOkuFromBillions(value) {
  const converted = value * 10;
  const abs = Math.abs(converted);
  let numText;
  if (abs >= 100) numText = converted.toFixed(0);
  else if (abs >= 10) numText = converted.toFixed(1).replace(/\.0$/, "");
  else numText = converted.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  const [intPart, fracPart] = numText.split(".");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${withCommas}.${fracPart}` : withCommas;
}

function treemapValueLabel(value, unit, lang) {
  const raw = fmt(value, unit);
  if (lang !== "zh" || !unit || unit === "%") return raw;
  if (unit === "$B") return `${treemapZhOkuFromBillions(value)}亿美元`;
  const zhUnit = TREEMAP_ZH_UNIT[unit];
  if (!zhUnit) return raw;
  if (/^[£$€¥]$/.test(unit) && raw.startsWith(unit)) return `${raw.slice(unit.length)}${zhUnit}`;
  if (raw.endsWith(` ${unit}`)) return `${raw.slice(0, raw.length - unit.length - 1)}${zhUnit}`;
  return raw;
}

// A treemap tile's share-of-total is always shown at exactly one decimal
// place (64.6%, 7.3%, 4.7%, 0.9%), never fmt()'s usual magnitude-based
// precision (fmt(pct, "%") would print "7.29%" and "0.94%" alongside
// "64.6%" - a two-decimal/one-decimal mismatch across tiles on the same
// chart). A share percentage is always small-magnitude and comparative, so
// one fixed decimal reads as one consistent scale down the whole treemap;
// the underlying share value itself is computed the same way either way
// (tileValue / datasetTotal * 100), only the display precision is fixed.
function treemapSharePercent(pct) {
  return `${pct.toFixed(1)}%`;
}

// A few PALETTE entries read fine as a mark (a stroke/point at typical mark
// sizes) but fall a hair short of the 4.5:1 floor once the same colour is
// used as small (12/12.5px, normal-weight) *text* on white - PALETTE.accent
// is 4.43:1 on white, just under 4.5:1. Route text fills through this map so
// a label swaps to a WCAG-safe sibling colour while the mark it annotates
// (line/point) keeps the original palette entry unchanged.
function textSafeColor(color) {
  return TEXT_SAFE_ON_WHITE[color] ?? color;
}

// WCAG 2.x relative luminance / contrast ratio (same public formula
// render_qa_contrast.mjs checks against), used to pick a text label's colour
// against the shape it sits on (a heatmap cell's interpolated fill, a sankey
// node's own fill) rather than a single fixed luminance threshold (a
// threshold like "t>0.58" necessarily picks the wrong, failing colour
// somewhere along a continuous colour ramp or fill).
function srgbToLinearChannel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function relativeLuminanceRgb([r, g, b]) {
  return 0.2126 * srgbToLinearChannel(r) + 0.7152 * srgbToLinearChannel(g) + 0.0722 * srgbToLinearChannel(b);
}
function contrastRatioRgb(rgbA, rgbB) {
  const a = relativeLuminanceRgb(rgbA), b = relativeLuminanceRgb(rgbB);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
function hexToRgb(hex) {
  const v = parseInt(String(hex).replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
// Composite a fill colour that itself uses SVG fill-opacity over the page's
// white background, so contrast is measured against what a reader actually
// sees rather than the shape's own (undiluted) fill value.
function compositeOverWhite(rgb, alpha) {
  return rgb.map((c) => Math.round(c * alpha + 255 * (1 - alpha)));
}
const LABEL_ON_FILL_WHITE = [255, 255, 255];
const LABEL_ON_FILL_REQUIRED_RATIO = 4.5; // normal-weight 12/12.5px text

// Choose a label's colour by whichever of white/ink has the higher contrast
// against the fill it sits on, instead of a fixed luminance threshold or an
// always-white assumption that both fail on some fills a reader genuinely
// cannot read (e.g. white on rgb(222,141,135) is 2.54:1; white on
// PALETTE.accent #d1493f is 4.43:1). When neither candidate reaches the
// 4.5:1 floor, add a halo: an opaque, >=2px contrasting stroke
// (render_qa_contrast.mjs's own recognised halo pattern) so the label reads
// against its own outline rather than the fill directly. Shared by the
// heatmap (cell fill) and sankey (node fill) renderers below.
function labelStyleOnFill(fillRgb) {
  const contrastWhite = contrastRatioRgb(LABEL_ON_FILL_WHITE, fillRgb);
  const contrastInk = contrastRatioRgb(hexToRgb(PALETTE.ink), fillRgb);
  const useWhite = contrastWhite >= contrastInk;
  const fill = useWhite ? "#ffffff" : PALETTE.ink;
  const best = useWhite ? contrastWhite : contrastInk;
  if (best >= LABEL_ON_FILL_REQUIRED_RATIO) return { fill, halo: null };
  return { fill, halo: useWhite ? PALETTE.ink : "#ffffff" };
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function n(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values.map((v) => String(v)))];
}

function annotations(spec) {
  return Array.isArray(spec.annotations) ? spec.annotations : [];
}

function pointAnnotations(spec, row) {
  return annotations(spec).filter((annotation) =>
    annotation?.type === "point" &&
    annotation.match_field &&
    String(row?.[annotation.match_field]) === String(annotation.match_value)
  );
}

// B2: reference_line annotations, in declared order. Callers on the four
// REFERENCE_LINE_CHART_TYPES chart types stack one label row per entry (see
// referenceLineMargin/referenceLineRowY below); any other chart type never
// reaches render with one, since lintVizSpec blocks it first.
function referenceLineAnnotations(spec) {
  return annotations(spec).filter((annotation) => annotation?.type === "reference_line");
}

// Extra space (in px) a renderer reserves for a stack of reference_line
// labels, one 16px row per line plus a fixed pad so the first row clears
// whatever sits directly above it (title/subtitle gap, legend, facet title).
function referenceLineMargin(refLines) {
  return refLines.length ? refLines.length * 16 + 14 : 0;
}

// Baseline y for reference_line row `index`, stacked downward from `base`
// (the top of the reserved band - i.e. the plot's pre-reservation edge).
function referenceLineRowY(base, index) {
  return base + index * 16 + 11;
}

function annotationLabel(annotation, maxChars = 58) {
  const text = String(annotation?.text ?? "").trim();
  const maxTotal = Math.max(maxChars * 3, maxChars);
  return textUnits(text) <= maxTotal ? text : sliceUnits(text, Math.max(1, maxTotal - 1)).trimEnd() + "…";
}

// Point-annotation placement: for each label, try candidate positions to
// the right/left/above/below of its own data point (a short leader in every
// case) and keep the first one that clears the plot bounds, every
// previously-placed annotation's box, and every registered data-mark
// obstacle (addObstaclePath - a chart's own line/curve, sampled as
// segments). This is what stops an annotation's text from landing on top of
// the very line it annotates, or on top of a neighbouring annotation's text
// (round-2 house-style fix: the fertility-chart case where "...三孩政策"
// sat on the falling line and "...1.795" ran into "二孩政策"). When none of
// the four sides clears everything, this does NOT hide the label or force
// an artificial-looking placement no matter the cost - it places the
// annotation at its preferred side anyway (best-effort, still visible) so
// render QA's text_overlap / text_crosses_data_mark rule is the thing that
// fails a genuinely impossible layout, not this function quietly hiding it.
function createAnnotationLayout(bounds = {}) {
  const top = bounds.top ?? 18;
  const bottom = bounds.bottom ?? 10_000;
  const left = bounds.left ?? 18;
  const right = bounds.right ?? 10_000;
  const placed = [];
  const obstacleSegments = [];
  const SIDES = ["right", "left", "above", "below"];
  const GAP = 12;

  function boxForSide(x, y, w, h, side, gap = GAP) {
    if (side === "right") return { x: x + gap, y: y - h / 2, w, h };
    if (side === "left") return { x: x - gap - w, y: y - h / 2, w, h };
    if (side === "above") return { x: x - w / 2, y: y - gap - h, w, h };
    return { x: x - w / 2, y: y + gap, w, h }; // below
  }
  // Candidate leader lengths to try, nearest first: a label that can't clear
  // its obstacles at the standard gap (e.g. a data line passing close behind
  // the point on every side) gets pushed progressively further out before
  // this falls back to a forced, possibly-overlapping placement. This is what
  // lets the fertility-chart annotations clear the line they sit beside
  // instead of only ever trying one fixed distance.
  const GAP_STEPS = [GAP, GAP * 2, GAP * 3.5, GAP * 5.5, GAP * 8.5];
  function anchorFor(side, box) {
    const baseline = box.y + 11; // ~ascent for a 12px label, first line
    if (side === "right") return { anchor: "start", tx: box.x, ty: baseline, leaderX: box.x, leaderY: box.y + box.h / 2 };
    if (side === "left") return { anchor: "end", tx: box.x + box.w, ty: baseline, leaderX: box.x + box.w, leaderY: box.y + box.h / 2 };
    if (side === "above") return { anchor: "middle", tx: box.x + box.w / 2, ty: baseline, leaderX: box.x + box.w / 2, leaderY: box.y + box.h };
    return { anchor: "middle", tx: box.x + box.w / 2, ty: baseline, leaderX: box.x + box.w / 2, leaderY: box.y }; // below
  }
  // Minimum vertical distance (px) between the centre of any two placed
  // labels, regardless of which side of their point each one sits on. Two
  // texts that flank the same (or neighbouring) point at the same height
  // read as one confusing row even when their boxes don't literally
  // overlap in x (e.g. a direct-label to the right and that same point's
  // annotation to the left) - so this is checked independently of the
  // boxesOverlap 2D test, not instead of it.
  const MIN_VERTICAL_GAP = 15;
  function centerY(box) { return box.y + box.h / 2; }
  function boxIsClear(box) {
    if (box.x < left - 0.01 || box.x + box.w > right + 0.01 || box.y < top - 0.01 || box.y + box.h > bottom + 0.01) return false;
    for (const item of placed) {
      if (boxesOverlap(box, item.box)) return false;
      if (Math.abs(centerY(box) - centerY(item.box)) < MIN_VERTICAL_GAP) return false;
    }
    for (const seg of obstacleSegments) if (segmentHitsBox(seg.x1, seg.y1, seg.x2, seg.y2, box)) return false;
    return true;
  }

  return {
    place(x, y, text, preferredSide = "right", lineCount = 1) {
      const estimatedWidth = Math.max(42, Math.min(280, Math.min(textUnits(String(text ?? "")), 46) * 6.9));
      const h = lineCount * 15 + 2;
      const px = clamp(x, left, right);
      const py = clamp(y, top, bottom);
      const order = [preferredSide, ...SIDES.filter((s) => s !== preferredSide)];
      let chosenSide = null;
      let chosenBox = null;
      outer:
      for (const gap of GAP_STEPS) {
        for (const side of order) {
          const box = boxForSide(px, py, estimatedWidth, h, side, gap);
          if (boxIsClear(box)) { chosenSide = side; chosenBox = box; break outer; }
        }
      }
      if (!chosenSide) { chosenSide = preferredSide; chosenBox = boxForSide(px, py, estimatedWidth, h, chosenSide); }
      const { anchor, tx, ty, leaderX, leaderY } = anchorFor(chosenSide, chosenBox);
      placed.push({ box: chosenBox, side: chosenSide });
      return { side: chosenSide, anchor, tx, ty, leaderX, leaderY };
    },
    // Registers a data mark's own geometry (e.g. a rendered line's points,
    // in the same absolute plot coordinates annotations are placed in) as an
    // obstacle every subsequent place() call must clear. Callers add a
    // series' polyline points right after drawing it and before placing
    // that series' annotations, so a later annotation never lands on an
    // earlier-drawn line.
    addObstaclePath(points) {
      for (let i = 0; i + 1 < points.length; i++) {
        obstacleSegments.push({ x1: points[i].x, y1: points[i].y, x2: points[i + 1].x, y2: points[i + 1].y });
      }
    },
    placed,
  };
}

function addPointAnnotation(parts, annotation, x, y, opts = {}) {
  const maxChars = opts.maxChars ?? 46;
  const text = annotationLabel(annotation, maxChars);
  const lines = wrapText(text, maxChars).slice(0, opts.maxLines ?? 3);
  if (lines.length === (opts.maxLines ?? 3) && lines.join("").length < text.replace(/\s/g, "").length) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace(/…?$/, "…");
  }
  let side = opts.side ?? "right";
  if (!opts.layout) {
    const estimated = Math.max(...lines.map((line) => textUnits(line)), 1) * 6.9;
    if (x + 18 + estimated > (opts.right ?? 820)) side = "left";
    if (x - 18 - estimated < (opts.left ?? 180)) side = "right";
  }
  const placed = opts.layout
    ? opts.layout.place(x, y, text, side, lines.length)
    : (() => {
        const dx = side === "left" ? -12 : 12;
        const tx = x + dx, ty = Math.max(18, y - 13);
        return { side, anchor: side === "left" ? "end" : "start", tx, ty, leaderX: x + dx * 0.75, leaderY: ty + 4 };
      })();
  parts.push(`<line data-role="annotation-leader" x1="${x}" y1="${y}" x2="${placed.leaderX}" y2="${placed.leaderY}" stroke="${PALETTE.muted}" stroke-width="1"/>`);
  parts.push(`<text data-role="annotation" x="${placed.tx}" y="${placed.ty}" text-anchor="${placed.anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${lines.map((line, index) => `<tspan x="${placed.tx}" dy="${index === 0 ? 0 : 15}">${esc(line)}</tspan>`).join("")}</text>`);
}

// Endpoint of the leader that joins a data point (x, y) to its placed label
// (createAnnotationLayout.place() -> leaderX/leaderY). It stops `gap` px short
// of the label's near edge: leaderX/leaderY sit exactly on the edge of the
// label's text box, and render QA counts a leader that touches any text box as
// crossing it (leader_crosses_text).
function leaderEndShortOfLabel(x, y, placed, gap = 2) {
  const dx = placed.leaderX - x, dy = placed.leaderY - y, len = Math.hypot(dx, dy);
  if (!(len > gap)) return { x2: placed.leaderX, y2: placed.leaderY };
  return { x2: placed.leaderX - (dx / len) * gap, y2: placed.leaderY - (dy / len) * gap };
}

// ---------------------------------------------------------------------------
// Event-annotation lane for line charts (round-3 house-style, replaces the
// free 4-side repel above for line/multi_line point annotations only - the
// slope/dumbbell end-label repel and scatter/small-multiples point
// annotations are unaffected). A dedicated top lane holds every label so
// none can ever sit over the data area or the line it annotates; a thin
// vertical guide runs from the x-axis up to the label with a dot marking
// where it crosses the event's own data point. When the lane genuinely
// cannot hold every label without collisions, or two events sit too close
// together to read as separate guides, every point annotation on the chart
// switches to a small numbered marker at its data point plus an ordered
// caption list - never a forced overlapping placement, never a silently
// dropped label.
const LANE_ROW_FONT_SIZE = 12;
const LANE_ROW_HEIGHT = Math.round(LANE_ROW_FONT_SIZE * 1.4); // ~17px, per house style
const LANE_LABEL_PAD = 6; // half of the required 12px horizontal clearance
// Fix 4 (header/top-tick collision, house style only): renderLine's topmost
// y-axis tick draws its gridline at exactly `top`, but the tick's own label
// text (font-size 12, baseline 4px below the gridline) extends upward past
// that gridline by roughly the font's ascent - close enough to bodyTop that
// on a two-line title or with a subtitle present, render-QA finds it
// overlapping the header. Reserve half the tick-label's font size as extra
// clearance between the header and laneTop/top, on top of the existing gap.
const Y_AXIS_TICK_FONT_SIZE = 12; // matches the axis-tick text nodes below
const TOP_TICK_CLEARANCE = Y_AXIS_TICK_FONT_SIZE / 2;
// Candidate space for the per-label search below: two rows (0 = nearest the
// title, 1 = nearest the plot) x three text-anchors. Tried in this fixed
// order so the search is deterministic - the same input always finds the
// same placement.
const LANE_ROWS = [0, 1];
const LANE_ANCHORS = ["start", "end", "middle"];
// Backtracking is exponential in the worst case (branches^events); this
// caps total candidate checks so a pathological input degrades to the
// numbered-marker fallback instead of hanging. Real editorial annotation
// counts (a handful per chart) never come close to it.
const LANE_SEARCH_BUDGET = 200000;

// A label's candidate box in padded coordinate space for a given
// text-anchor: PAD on both sides encodes half of the house style's required
// 12px horizontal clearance, so two same-row boxes that merely touch
// (rather than overlap) already have a full 12px of clear space between
// their actual text.
function laneCandidateBox(e, anchor) {
  const w = e.width;
  const x0 = anchor === "end" ? e.x - w : anchor === "middle" ? e.x - w / 2 : e.x;
  return { x0: x0 - LANE_LABEL_PAD, x1: x0 + w + LANE_LABEL_PAD };
}

// Every row/anchor combination for one event whose box stays on-canvas
// (never past plotLeft, where the value-axis tick labels live, and never
// past labelRight, the frame's own established safe margin for text - not
// the tighter plot edge, which leaves real, otherwise-empty margin unused).
function laneCandidatesFor(e, plotLeft, labelRight) {
  const list = [];
  for (const row of LANE_ROWS) {
    for (const anchor of LANE_ANCHORS) {
      const box = laneCandidateBox(e, anchor);
      if (box.x0 < plotLeft || box.x1 > labelRight) continue;
      list.push({ row, anchor, box });
    }
  }
  return list;
}

// Whether candidate `candI` (for event `eventI`) can coexist with every
// already-placed candidate. Two constraints, both geometric, neither a
// proxy: (1) two labels sharing a row must clear the house style's 12px
// minimum (their padded boxes must not overlap); (2) a label's vertical
// guide runs from the x-axis up to just below its own box, so it always
// passes through every row *below* its own (row 0 sits nearest the title,
// row 1 nearest the plot, so row 0's guide is the long one) - it must
// therefore never fall inside a lower row's box. A lower row's own guide is
// too short to ever reach a higher row's box, so that direction never needs
// checking.
function laneCandidatesCompatible(eventI, candI, placed) {
  for (const other of placed) {
    if (!other) continue;
    const { event: eventJ, cand: candJ } = other;
    if (candI.row === candJ.row) {
      if (candI.box.x0 < candJ.box.x1 && candI.box.x1 > candJ.box.x0) return false;
    } else {
      const iIsUpper = candI.row < candJ.row;
      const upperX = iIsUpper ? eventI.x : eventJ.x;
      const lowerBox = iIsUpper ? candJ.box : candI.box;
      if (upperX >= lowerBox.x0 && upperX <= lowerBox.x1) return false;
    }
  }
  return true;
}

// Exhaustive (backtracking) search over every event's {row, anchor}
// candidates for a placement satisfying laneCandidatesCompatible for every
// pair. Candidates are generated and tried in the fixed LANE_ROWS x
// LANE_ANCHORS order and the search commits to the first complete
// assignment it finds - depth-first, earlier (leftmost) events keep their
// most-preferred candidate unless the remainder of the chart genuinely
// cannot be completed without changing it - so the result is deterministic
// for a given input. Returns null, never a partial placement, when no
// assignment exists; the caller then falls back to numbered markers.
function solveLaneAssignment(events, plotLeft, labelRight) {
  const perEvent = events.map((e) => laneCandidatesFor(e, plotLeft, labelRight));
  if (perEvent.some((list) => list.length === 0)) return null;
  const placed = new Array(events.length).fill(null);
  let budget = LANE_SEARCH_BUDGET;
  const solve = (i) => {
    if (i === events.length) return true;
    for (const cand of perEvent[i]) {
      if (--budget < 0) return false;
      if (laneCandidatesCompatible(events[i], cand, placed)) {
        placed[i] = { event: events[i], cand };
        if (solve(i + 1)) return true;
        placed[i] = null;
      }
    }
    return false;
  };
  return solve(0) ? placed.map((p) => p.cand) : null;
}

// Collects every point annotation across all rows in x order and finds a
// placement - a {row, text-anchor} pair per label - where no two labels
// ever crowd each other or cross each other's guide wire (see
// solveLaneAssignment). This can run before a frame height is chosen: it
// only needs x positions (via xScale) and estimated text width, not the
// final pixel row baselines. The whole chart falls back to numbered
// markers, plus an ordered caption list, only when the search proves no
// such placement exists - never a forced overlapping placement, never a
// silently dropped label.
function layoutEventAnnotations(spec, rows, xScale, plotLeft, plotRight, maxChars = 16, labelRight = plotRight) {
  const events = [];
  // A multi-series line shares one x axis across every series, so a point
  // annotation's match_field/match_value can match one row per series at
  // the same x (e.g. both "Brazil" and "US" rows at yr=2018). Rendering an
  // event per matching row would then draw the same annotation text twice.
  // assignPointAnnotations already resolves each annotation to exactly one
  // row (nearest by value when several rows match, else the first), so
  // reusing it here keeps the lane/fallback layout to one event per
  // annotation regardless of how many series share its x.
  const assignment = assignPointAnnotations(spec, rows, spec.value_field);
  for (const [annotation, dataRow] of assignment) {
    events.push({ x: xScale(dataRow[spec.x_field]), text: annotationLabel(annotation, maxChars), dataRow, annotation });
  }
  events.sort((a, b) => a.x - b.x);
  if (!events.length) return { events, fallback: false };
  // A label whose full text would need annotationLabel()'s own "…" ellipsis
  // to fit the lane's per-row budget reads better as a caption - the
  // fallback path shows every annotation's complete text, via its own more
  // generous budget (annotationLabel(a, 60), in drawEventAnnotationFallback)
  // - than as a lane label missing its own ending. So any event this long
  // forces the whole chart to the fallback, the same way a genuine
  // geometric collision does, instead of silently truncating a label the
  // fallback would have shown in full.
  const maxTotal = Math.max(maxChars * 3, maxChars);
  if (events.some((e) => textUnits(String(e.annotation?.text ?? "").trim()) > maxTotal)) {
    return { events, fallback: true };
  }
  for (const e of events) {
    e.width = Math.max(24, Math.min(180, textUnits(e.text) * 6.9));
  }
  const solved = solveLaneAssignment(events, plotLeft, labelRight);
  if (!solved) return { events, fallback: true };
  events.forEach((e, i) => {
    e.laneRow = solved[i].row;
    e.anchor = solved[i].anchor;
  });
  return { events, fallback: false };
}

// Draws the lane: each label sits at rowY[e.laneRow], a thin grey guide runs
// from the x-axis (`bottom`) up to 4px below the label's own estimated bbox
// bottom - never into or through the label itself - and a small dot marks
// the event's own plotted (x, y), where the guide crosses its series.
function drawEventAnnotationLane(parts, events, rowY, bottom) {
  for (const e of events) {
    const labelBaseline = rowY[e.laneRow];
    const labelBboxBottom = labelBaseline + 4; // ~ descender clearance at 12px
    const guideTop = labelBboxBottom + 4; // required 4px gap below the label
    parts.push(`<line data-role="annotation-leader" x1="${e.x}" y1="${bottom}" x2="${e.x}" y2="${guideTop}" stroke="#BDBDBD" stroke-width="1"/>`);
    parts.push(`<circle cx="${e.x}" cy="${e.eventY}" r="3" fill="${PALETTE.accent2}"/>`);
    parts.push(`<text data-role="annotation" x="${e.x}" y="${labelBaseline}" text-anchor="${e.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${LANE_ROW_FONT_SIZE}" font-weight="600" fill="${PALETTE.ink}">${esc(e.text)}</text>`);
  }
}

// A numbered marker badge: a plain digit inside a single drawn circle (not
// a circled-digit glyph character drawn inside its own circle too, which
// reads as a redundant double ring). Used both at an event's own data point
// and, smaller, inline in the caption list, so the two always match.
function drawMarkerBadge(parts, cx, cy, r, digit, fontSize) {
  parts.push(`<circle data-role="annotation-marker" cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  parts.push(`<text data-role="annotation-marker-label" x="${cx}" y="${cy + fontSize * 0.35}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" fill="${PALETTE.ink}">${digit}</text>`);
}

// Draws the crowding fallback: a numbered marker (>=12px) at each event's
// own data point, plus an ordered caption list underneath the chart in the
// same x order and the same marker style, so a reader can always find
// every annotation even when the chart could not fit its label next to the
// point.
function drawEventAnnotationFallback(parts, events, captionLeft, captionTop) {
  // Two or more events can legitimately share one data point (e.g. several
  // things happened "in 2016"). Their markers keep that exact x - the
  // invariant a caller/test can check - but stack vertically above the
  // point so the badges never draw on top of each other or the point's own
  // data-mark circle; the first (closest to the point) still sits exactly
  // on it.
  const groups = new Map();
  events.forEach((e, i) => {
    const key = `${Math.round(e.x * 2)}:${Math.round(e.eventY * 2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  // Every badge sits at least one slot above the plotted data point - never
  // exactly on it - so its white fill and digit never geometrically cross
  // the data point's own small circle mark, even for a single, ungrouped
  // event (a badge is a distinct annotation marker next to its point, not a
  // replacement for the point itself).
  const markerY = events.map((e) => e.eventY - 19);
  for (const idxs of groups.values()) {
    idxs.forEach((idx, j) => { markerY[idx] = events[idx].eventY - (j + 1) * 19; });
  }
  events.forEach((e, i) => {
    parts.push(`<line data-role="annotation-leader" x1="${e.x}" y1="${e.eventY}" x2="${e.x}" y2="${markerY[i] + 9}" stroke="#BDBDBD" stroke-width="1"/>`);
    drawMarkerBadge(parts, e.x, markerY[i], 9, String(i + 1), 12);
  });
  events.forEach((e, i) => {
    const fullText = annotationLabel(e.annotation, 60);
    const badgeCy = captionTop + i * 16;
    drawMarkerBadge(parts, captionLeft + 7, badgeCy, 7, String(i + 1), 12);
    parts.push(`<text data-role="annotation" x="${captionLeft + 20}" y="${badgeCy + 4}" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="${PALETTE.ink}">${esc(fullText)}</text>`);
  });
}

// B2: a reference_line's thin rule plus its label. The rule is a plain
// <line> spanning the plot area at the annotation's value (x1/y1 to x2/y2
// come from the caller, already in the value axis's own orientation - a
// vertical rule for a horizontal value axis, horizontal for a vertical
// one). render QA's text_overlap rule only tracks <text> boxes, so the rule
// itself may freely cross bars/dots/dumbbells; only labelX/labelY - which
// every call site places in a margin it reserved via referenceLineMargin,
// never over the marks - needs to stay clear of other text.
function addReferenceLine(parts, { x1, y1, x2, y2, labelX, labelY, anchor }, text) {
  // LAYERING_FIX: thinner than a data mark's own stroke/fill weight, round
  // caps, same dash rhythm everywhere. Call sites also draw this line
  // *before* the marks it crosses when LAYERING_FIX is on (see
  // renderHorizontal/renderDumbbell), so the mark paints over it instead of
  // the old order, which let the rule slice visibly across bars.
  const strokeWidth = LAYERING_FIX ? 1 : 1.5;
  const cap = LAYERING_FIX ? ` stroke-linecap="round"` : "";
  parts.push(`<line data-role="reference-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${PALETTE.muted}" stroke-width="${strokeWidth}" stroke-dasharray="4 3"${cap}/>`);
  parts.push(`<text data-role="reference-line-label" x="${labelX}" y="${labelY}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(text)}</text>`);
}

// Draws every reference_line for a chart whose value axis is horizontal
// (horizontal_bar, dot, dumbbell): one vertical rule per line from `top` to
// `bottom`, label stacked in the band above `top` anchored away from the
// canvas edge so it never runs outside the viewBox.
function drawHorizontalValueReferenceLines(parts, refLines, { scale, top, base, bottom, left, right }) {
  refLines.forEach((line, i) => {
    const x = scale(line.value);
    const anchor = x > (left + right) / 2 ? "end" : "start";
    addReferenceLine(parts, { x1: x, y1: top, x2: x, y2: bottom, labelX: x + (anchor === "end" ? -5 : 5), labelY: referenceLineRowY(base, i), anchor }, annotationLabel(line, 42));
  });
}

// E: range_bracket annotations, in declared order. Only horizontal_bar and
// plain (ungrouped) dot draw one - lintVizSpec blocks every other chart_type
// (and a grouped dot, series_field set, before render ever sees it here).
function rangeBracketAnnotations(spec) {
  return RANGE_BRACKET_CHART_TYPES.has(spec.chart_type) ? annotations(spec).filter((annotation) => annotation?.type === "range_bracket") : [];
}

// Fixed right-margin width (px) reserved for the bracket stem/text column,
// same whenever at least one range_bracket exists regardless of count: two
// brackets never overlap in y (lintVizSpec's own rule), so they can share
// one column without their labels colliding. Zero - and therefore an
// unchanged plot right edge and byte-identical output - whenever there is
// no range_bracket, matching referenceLineMargin's own "only when present"
// convention for reference_line's vertical margin.
const RANGE_BRACKET_MARGIN = 170;
function rangeBracketMargin(rangeBrackets) {
  return rangeBrackets.length ? RANGE_BRACKET_MARGIN : 0;
}

// Draws every range_bracket for a horizontal_bar/dot chart: a bracket path
// from the first to the last row it spans (in rendered order), plus its
// text, both within the right margin rangeBracketMargin reserved. `right`
// here is the plot's own (already-shrunk-by-the-margin) right edge, so bx
// sits inside the reserved band, never over a bar/dot/value-label.
function drawRangeBrackets(parts, rangeBrackets, sortedRows, spec, { top, bottom, right }) {
  if (!rangeBrackets.length) return;
  const step = (bottom - top) / sortedRows.length;
  const categories = sortedRows.map((row) => String(row[spec.category_field]));
  const bx = right + 60;
  const textX = bx + 14;
  const maxChars = Math.max(8, Math.floor((1040 - textX - 12) / 7.5));
  const lineHeight = 16;
  for (const bracket of rangeBrackets) {
    const i1 = categories.indexOf(String(bracket.match_value));
    const i2 = categories.indexOf(String(bracket.end_match_value));
    if (i1 === -1 || i2 === -1) continue; // defensive; lintVizSpec already blocks this
    const firstIdx = Math.min(i1, i2), lastIdx = Math.max(i1, i2);
    const y0 = top + step * firstIdx + 8;
    const y1 = top + step * (lastIdx + 1) - 8;
    const accent = bracket.tone === "accent";
    const lineColor = accent ? PALETTE.accent : PALETTE.muted;
    // PALETTE.accent itself is 4.43:1 on white as text - just under the
    // 4.5:1 floor render_qa_contrast.mjs enforces (see textSafeColor's own
    // definition above) - so route the label fill through the same
    // WCAG-safe sibling every other accent-coloured label in this file
    // uses; the bracket's line/mark keeps the true accent colour unchanged.
    const textColor = accent ? textSafeColor(PALETTE.accent) : PALETTE.ink;
    parts.push(`<path data-role="range-bracket" d="M${bx},${y0} h6 V${y1} h-6" fill="none" stroke="${lineColor}" stroke-width="1.5"/>`);
    const lines = wrapText(annotationLabel(bracket, maxChars), maxChars);
    const centerY = (y0 + y1) / 2;
    const startY = centerY - ((lines.length - 1) * lineHeight) / 2 + 4;
    lines.forEach((line, i) => {
      parts.push(`<text data-role="range-bracket-label" x="${textX}" y="${startY + i * lineHeight}" text-anchor="start" font-family="${FONT_SANS}" font-size="12.5" font-weight="700" fill="${textColor}">${esc(line)}</text>`);
    });
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function separateLabelBaselines(items, top, bottom, minGap = 14) {
  const placed = items
    .map((item) => ({ ...item, labelY: clamp(item.y, top, bottom) }))
    .sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].labelY - placed[i - 1].labelY < minGap) placed[i].labelY = placed[i - 1].labelY + minGap;
  }
  if (placed.length && placed[placed.length - 1].labelY > bottom) {
    const overflow = placed[placed.length - 1].labelY - bottom;
    for (const item of placed) item.labelY -= overflow;
    for (let i = placed.length - 2; i >= 0; i--) {
      if (placed[i + 1].labelY - placed[i].labelY < minGap) placed[i].labelY = placed[i + 1].labelY - minGap;
    }
  }
  for (const item of placed) item.labelY = clamp(item.labelY, top, bottom);
  return placed;
}

// Shared end-label de-collision pass for slope/dumbbell/line-style charts:
// a column of labels that all sit at the same x (one per data row/series,
// anchored at the row's own point) gets pushed apart to `minGap` px, exactly
// like separateLabelBaselines, but this wrapper also reports whether each
// label ended up far enough from its own point (>3px) that a leader line is
// needed to keep it legible which point it belongs to. Values themselves
// are never touched here - only the label's y position moves - and when
// there isn't enough vertical room for every label at minGap, the labels
// are still returned (moved as far as this pass can manage), not dropped:
// a genuinely impossible case renders with real overlapping text, and
// render QA's text_overlap rule is the thing that is supposed to catch
// that, not this layout pass silently hiding it.
function repelEndLabels(items, top, bottom, minGap = 18) {
  return separateLabelBaselines(items, top, bottom, minGap).map((item) => ({
    ...item,
    needsLeader: Math.abs(item.labelY - item.y) > 3,
  }));
}

// Thin, neutral-grey leader from a data point to its (repelled) label,
// drawn with house-style stroke (<=1px, PALETTE.muted). Callers must push
// this into the SVG parts array *before* the data marks it points at, so it
// paints behind them (see the callers' own `leaderParts`/splice pattern).
function endLabelLeader(x1, y1, x2, y2) {
  return `<line data-role="label-leader" x1="${fmt2(x1)}" y1="${fmt2(y1)}" x2="${fmt2(x2)}" y2="${fmt2(y2)}" stroke="${PALETTE.muted}" stroke-width="0.75"/>`;
}
function fmt2(v) {
  return Math.round(v * 100) / 100;
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Whether the segment (x1,y1)-(x2,y2) passes through box b (Liang-Barsky).
function segmentHitsBox(x1, y1, x2, y2, b) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - b.x], [dx, b.x + b.w - x1], [-dy, y1 - b.y], [dy, b.y + b.h - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

// Nudges a value label's vertical anchor away from already-placed obstacle
// boxes (other value labels, point/city labels) so the two never overlap,
// trying progressively larger offsets alternating up (matching the caller's
// existing upward "lift" bias) then down, and finally clamping into
// [minY, maxY]. Horizontal position stays at the flow's own midpoint - only
// placement (here, vertical offset) changes, never the underlying value.
function resolveLabelCollisionY(cx, preferredY, w, font, obstacles, minY, maxY) {
  const h = font + 7;
  const boxAt = (y) => ({ x: cx - w / 2, y: y - font - 3, w, h });
  const collides = (y) => obstacles.some((o) => boxesOverlap(boxAt(y), o));
  if (!collides(preferredY)) return preferredY;
  const step = h + 4;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const direction = attempt % 2 === 1 ? -1 : 1;
    const distance = Math.ceil(attempt / 2) * step;
    const candidate = clamp(preferredY + direction * distance, minY, maxY);
    if (!collides(candidate)) return candidate;
  }
  return preferredY;
}

// Fix 2 (value-label precision): picks the one shared decimal count every
// value label in a chart must use, when no explicit spec.decimals is set.
// Tried counts run 0..3 (3 is the hard cap - see schema/validateVizSpec);
// the first count that (a) keeps every displayed value distinguishable from
// its neighbours and (b) never rounds a non-integer value into a whole
// number is used. (b) is the concrete reported bug: China's 2023 rate 0.999
// must never display as "1" - at 0 or 1 or even 2 decimals, 0.999 itself
// still rounds to a whole "1"/"1.0"/"1.00", so this dataset always resolves
// to 3, matching the fertility page's approved decimals=3.
function autoValueDecimals(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return null;
  for (let d = 0; d <= 3; d++) {
    const strs = finite.map((v) => v.toFixed(d));
    const crossesIntegerBoundary = finite.some((v, i) => !Number.isInteger(v) && Number.isInteger(Number(strs[i])));
    // Fix 2 follow-up (a): compare the count of distinct *strings* to the
    // count of distinct *values*, not to the raw (duplicate-inclusive) array
    // length. Two categories that are genuinely, exactly equal (e.g. [5, 5,
    // 3]) can never be told apart by adding more decimals - `new
    // Set(strs).size === strs.length` demanded exactly that, so a real tie
    // always failed the check and drove the loop to the 3-decimal cap
    // ("5.000"/"5.000"/"3.000") instead of stopping at the correct, simplest
    // "5"/"5"/"3" at d=0. Comparing against the distinct-value count instead
    // lets a genuine tie collapse onto one shared string while still forcing
    // escalation when distinct values merely look the same at a low decimal
    // count (e.g. 5.01 vs 5.02 at d=0, both "5" - a real, fixable collision).
    const distinguishable = new Set(strs).size === new Set(finite).size;
    if (!crossesIntegerBoundary && distinguishable) return d;
  }
  return 3;
}

// Resolves the shared decimal count a chart's value labels (end labels,
// dot/bar direct labels) should format with, or null to keep fmt()'s old
// per-value magnitude-branching + trailing-zero stripping untouched (legacy
// style, or a house chart this mechanism has not been wired into). An
// explicit, schema-validated spec.decimals (0-3) always wins; otherwise the
// count is auto-picked from every value this chart will actually display -
// callers pass that full set once, up front, so every label in the chart
// (not just one value in isolation) agrees on the same precision. Axis tick
// labels are never part of that set - they go through the separate
// tickLabel()/nice-number path and keep their own formatting regardless.
// "%" units are always left alone: fmt() already has its own, older,
// narrower percent rule (DECIMAL_MODE !== "default" -> always one decimal),
// and outside that rule a bare percent has long printed via the plain
// magnitude branches below (e.g. 12 -> "12%", no decimal at all). This
// mechanism was scoped to non-percent value labels (the fertility page's
// "个孩子" unit); overriding "%" here regressed that pre-existing, unrelated
// behaviour (e.g. "12%" turning into "12.0%") for every chart that doesn't
// literally set style_id:"house", which is most of them now that "house" is
// the default resolved style. Returning null here defers 100% to that
// untouched mechanism, exactly as before fix 2.
//
// Shared-scale guarantees (what a reader may rely on, whatever the unit or sign):
//   1. a non-zero value never prints as zero (0, 0.00亿, -0.00亿);
//   2. no value loses or flips its sign;
//   3. two different values print differently, whenever 3 decimals in the printed unit can show the difference;
//   4. to meet 1-3 the shared decimal count is raised, up to 3;
//   5. a value that 3 decimals still cannot show (it would print as zero) prints in its own unit (zh: its own
//      万/亿/万亿, below 1万 a plain number; en: significant digits) - the one case where a chart mixes units.
// `decimals` (spec.decimals or the auto count) is the count in the PRINTED unit: zh 10000.123 with decimals 3
// prints 1.000万, not 10000.123. The count is a floor that rules 1-4 may raise; it is never lowered.
function resolveChartDecimals(spec, values) {
  if (!HOUSE_STYLE_ACTIVE || spec?.unit === "%") return null;
  const explicit = spec?.decimals;
  const finite = (values ?? []).filter((v) => Number.isFinite(v));
  const hasExplicit = Number.isInteger(explicit) && explicit >= 0 && explicit <= 3;
  // zh chart with a label at or above 1万: one unit (from the largest |value|)
  // and one shared decimal count for every label, so 8.6万 never sits beside 8.757万.
  if (vizLang(spec) === "zh" && finite.some((v) => Math.abs(v) >= 10_000)) {
    const top = Math.max(...finite.map((v) => Math.abs(v)));
    const [div, suffix] = top >= 1e12 ? [1e12, "万亿"] : top >= 1e8 ? [1e8, "亿"] : [1e4, "万"];
    const smallest = Math.min(...finite.map((v) => Math.abs(v) / div).filter((v) => v > 0), Infinity);
    const auto = Number.isFinite(smallest) ? Math.min(2, Math.max(0, 1 - Math.floor(Math.log10(smallest)))) : 1;
    return { zhScale: { div, suffix }, decimals: raiseSharedDecimals(finite, hasExplicit ? explicit : auto, div) };
  }
  if (hasExplicit) return raiseSharedDecimals(finite, explicit, 1);
  const auto = autoValueDecimals(finite);
  // every labelled value in the thousands: no decimals at all, decided per chart - unless that would print two
  // different values the same (1000.1 and 1000.2), which rule 3 forbids
  if (finite.length && finite.every((v) => Math.abs(v) >= 1000) && auto !== null && auto > 0 && raiseSharedDecimals(finite, 0, 1) === 0) return 0;
  return auto === null ? auto : raiseSharedDecimals(finite, auto, 1);
}

// The smallest count in [start, 3] at which no non-zero value prints as zero and no two values that 3 decimals
// can tell apart print the same; 3 when nothing smaller does (see the guarantees above).
function raiseSharedDecimals(values, start, div) {
  const finite = values.filter((v) => Number.isFinite(v));
  const at = (v, d) => (v / div).toFixed(d);
  for (let d = Math.min(3, Math.max(0, start)); d < 3; d++) {
    const seen = new Map();
    let ok = true;
    for (const v of finite) {
      const short = at(v, d);
      const full = at(v, 3);
      if (v !== 0 && Number(short) === 0 && Number(full) !== 0) { ok = false; break; }
      if (!seen.has(short)) seen.set(short, full);
      else if (seen.get(short) !== full) { ok = false; break; }
    }
    if (ok) return d;
  }
  return 3;
}

// A value that the shared count cannot show without printing zero: significant digits, never zero, sign kept.
function tinyValueText(value) {
  const abs = Math.abs(value);
  if (abs >= 1) return String(Number(value.toPrecision(4)));
  const decimals = Math.min(20, 1 - Math.floor(Math.log10(abs)));
  const text = value.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return Number(text) === 0 ? value.toExponential(1) : text;
}

// Chart-level formatter: resolves the shared unit / decimal count once from all
// the chart's values and returns a (value, unit) => text function.
export function chartValueFormatter(spec, values) {
  const decimals = resolveChartDecimals(spec, values);
  return (value, unit = spec?.unit) => fmtSpec(spec, value, unit, decimals);
}

// zh value labels at or above 1万 use 万 / 亿 / 万亿 like the axis does, with
// four significant digits (161.1万, -325.6万, 1.611亿, 1611万), never a trailing
// zero. Exported so a hero number can print through the same formatter.
// minDecimals keeps an explicit shared count: the result never shows fewer decimals than that.
export function zhScaleText(value, minDecimals = 0) {
  const abs = Math.abs(value);
  const [div, suffix] = abs >= 1e12 ? [1e12, "万亿"] : abs >= 1e8 ? [1e8, "亿"] : [1e4, "万"];
  const v = abs / div;
  const d = v >= 1000 ? 0 : v >= 100 ? 1 : v >= 10 ? 2 : 3;
  let digits = String(Number(v.toFixed(d)));
  const have = digits.includes(".") ? digits.split(".")[1].length : 0;
  const want = Math.min(3, Math.max(0, minDecimals));
  if (have < want) digits = v.toFixed(want); // from the value: never pad a rounded string
  const text = (value < 0 ? "-" : "") + digits;
  return `${text}${suffix}`;
}

export function fmt(value, unit = "", decimals = null, lang = "en") {
  if (!Number.isFinite(value)) return "";
  // House style only: a percent value always prints one decimal (83.0%,
  // not 83%) so every value label in a chart shares the same decimal
  // count - the default style's own trailing-zero-stripping behaviour
  // below is untouched so its output stays byte-identical.
  if (DECIMAL_MODE !== "default" && unit === "%") return value !== 0 && Number(value.toFixed(1)) === 0 ? `${tinyValueText(value)}%` : `${value.toFixed(1)}%`;
  const abs = Math.abs(value);
  let text;
  if (decimals && typeof decimals === "object" && decimals.zhScale) {
    text = (value / decimals.zhScale.div).toFixed(decimals.decimals);
    // rule 5: a value the shared unit cannot show at 3 decimals prints in its own unit
    if (value !== 0 && Number(text) === 0) text = abs >= 10_000 ? zhScaleText(value) : tinyValueText(value);
    else text += decimals.zhScale.suffix;
    if (unit === "%") return `${text}%`;
    return unit && !/^[£$€¥]$/.test(unit) ? `${text} ${unit}` : unit ? `${unit}${text}` : text;
  }
  if (Number.isInteger(decimals)) {
    // Fix 2: a resolved shared decimal count (explicit spec.decimals, or
    // resolveChartDecimals()'s auto-picked default) always wins over the
    // magnitude-branch guess below, and - unlike every branch below - never
    // strips trailing zeros: every label in the chart must show exactly the
    // same number of decimal places (0.720 must stay "0.720", not "0.72").
    text = value.toFixed(decimals);
    if (lang === "zh" && abs >= 10_000) {
      text = zhScaleText(value, decimals);
    } else if (value !== 0 && Number(text) === 0) {
      text = tinyValueText(value);
    }
    // Fix 2 follow-up (b): toFixed() never groups the integer part, and a
    // resolved decimals count takes this branch instead of the magnitude
    // branches below (whose own abbreviations - "k"/"m"/"bn" - never need
    // comma-grouping): 67500 printed as the bare, typo-looking "67500"
    // instead of "67,500". Group only the integer part, only for |value| >=
    // 10,000 (the reported threshold), so a value below it (e.g. 9999) is
    // unaffected and stays byte-identical to before this fix.
    if (abs >= 10_000 && !(lang === "zh")) {
      const [intPart, fracPart] = text.replace("-", "").split(".");
      const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      text = (value < 0 ? "-" : "") + grouped + (fracPart !== undefined ? `.${fracPart}` : "");
    }
  }
  else if (lang === "zh" && abs >= 1_000) {
    // zh readers count in 万 and 亿, not k/m/bn: same one-decimal-below-10 rule per unit;
    // 1,000-9,999 is the plain integer. Only a zh caller (fmtSpec, tick sites) passes lang.
    if (abs >= 1_000_000_000_000) text = `${(value / 1_000_000_000_000).toFixed(abs >= 10_000_000_000_000 ? 0 : 1)}万亿`;
    else if (abs >= 100_000_000) text = `${(value / 100_000_000).toFixed(abs >= 1_000_000_000 ? 0 : 1)}亿`;
    else if (abs >= 10_000) text = `${(value / 10_000).toFixed(abs >= 100_000 ? 0 : 1)}万`;
    else text = value.toFixed(0);
  }
  else if (abs >= 1_000_000_000) text = `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}bn`;
  else if (abs >= 1_000_000) text = `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  else if (abs >= 1_000) text = `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  else if (abs >= 100) text = value.toFixed(0);
  else if (abs >= 10) text = value.toFixed(1).replace(/\.0$/, "");
  else text = value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  if (unit === "%") return `${text}%`;
  if (unit && /^[£$€¥]$/.test(unit)) return `${unit}${text}`;
  return unit ? `${text} ${unit}` : text;
}

// Choropleth per-region value labels always show exactly one decimal place
// ("70.0%", "83.0%" - the house decimal rule), never the shared fmt()'s own
// `abs>=10` stripping of a trailing ".0"/".00". Only choropleth per-region
// labels (on-map, overflow and inset) use this; fmt() itself is untouched so
// every other chart type's own formatting/snapshot tests are unaffected.
export function choroplethValueText(value, unit = "", spec = null) {
  if (!Number.isFinite(value)) return "";
  // P2: a calendar year or an integer count is spelled as the integer it is
  // ("2017", "3"), never "2.0k" / "3.0". No thousands separator and no zh
  // unit conversion here on purpose: the Python/Rust label verifiers read the
  // leading number back out of this text and compare it to data-value.
  const kind = spec ? specValueKind(spec) : null;
  if (kind && Number.isInteger(value)) {
    if (kind === "year" || !unit) return String(value);
    return `${value} ${unit}`;
  }
  const abs = Math.abs(value);
  let text;
  if (abs >= 1_000_000_000) text = `${(value / 1_000_000_000).toFixed(1)}bn`;
  else if (abs >= 1_000_000) text = `${(value / 1_000_000).toFixed(1)}m`;
  else if (abs >= 1_000) text = `${(value / 1_000).toFixed(1)}k`;
  else text = value.toFixed(1);
  if (unit === "%") return `${text}%`;
  if (unit && /^[£$€¥]$/.test(unit)) return `${unit}${text}`;
  return unit ? `${text} ${unit}` : text;
}

// Follow-up fix (4): a zh-language page must never print the raw English
// unit code "Mt" (million tonnes) - it must use the data's own unit family,
// converted exactly (never approximated) into 万吨 (ten-thousand tonnes),
// with thousands separators. 1 Mt = 1,000,000 t = 100万吨, so the factor is
// an exact integer multiplication (×100), not a rounded approximation - the
// same "exact conversion driven by the unit field" contract used elsewhere
// for zh unit families. Only "Mt" is recognised for now (the only unit code
// this pipeline's flow/sankey charts currently emit); any other unit falls
// through to the ordinary fmt() above unchanged.
const ZH_EXACT_UNIT_CONVERSIONS = {
  Mt: { factor: 100, label: "万吨" }, // million tonnes -> ten-thousand tonnes
};

function fmtZhUnit(value, unit) {
  const conv = ZH_EXACT_UNIT_CONVERSIONS[unit];
  if (!conv || !Number.isFinite(value)) return null;
  const converted = value * conv.factor;
  // Guard against binary float noise (e.g. 26.6*100 -> 2660.0000000000005)
  // without rounding away real precision: values in this pipeline never
  // carry more than one decimal place pre-conversion, so one decimal place
  // post-conversion is always enough to represent them exactly.
  const rounded = Math.round(converted * 10) / 10;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${text}${conv.label}`;
}

// Shared entry point for any renderer that wants zh-aware unit formatting:
// on a zh page, prefer the exact zh conversion when the unit is recognised;
// everywhere else (including en pages), fall back to the ordinary fmt().
function fmtLocalizedUnit(spec, value, unit = spec?.unit) {
  if (vizLang(spec) === "zh") {
    const zh = fmtZhUnit(value, unit);
    if (zh) return zh;
  }
  return fmtSpec(spec, value, unit);
}

// P2: one place that decides how a spec's numbers are *spelled*, so every
// chart type agrees. fmt() only ever sees a unit string; it cannot tell a
// calendar year or a count from a quantity, so 2017 became "2.0k" and 3
// became "3.0". The kind comes from spec.measure_kind, or from a
// spec.measure_semantics entry (same shape as measure_semantics.mjs: field,
// unit, measure_kind) matching spec.value_field (or the only entry).
// Returns "year" | "count" | null. Never guesses from the unit alone except
// that a year-ish unit on an `index` measure is a calendar year (a year unit
// on a `duration` is an elapsed span, e.g. 72.4 years, and stays a number).
const YEAR_UNITS = new Set(["year", "years", "yr", "yrs", "年", "年份"]);
export function specValueKind(spec) {
  let kind = typeof spec?.measure_kind === "string" ? spec.measure_kind : null;
  let unit = spec?.unit;
  if (!kind && Array.isArray(spec?.measure_semantics)) {
    const list = spec.measure_semantics.filter((m) => m && typeof m === "object");
    const entry = list.find((m) => m.field && m.field === spec.value_field) ?? (list.length === 1 ? list[0] : null);
    if (entry) {
      kind = entry.measure_kind ?? null;
      unit = unit ?? entry.unit;
    }
  }
  if (kind === "year") return "year";
  if (kind === "count") return "count";
  if (kind === "index" && YEAR_UNITS.has(String(unit ?? "").trim().toLowerCase())) return "year";
  return null;
}

function zhBillionsActive(spec, unit) {
  return vizLang(spec) === "zh" && spec?.unit === "$B" && (unit === "$B" || unit === "");
}

// Value-label formatter shared by every chart type that has a spec.
// `unit` is what this particular label should carry ("" for a bare number
// on a house-style row that shows the unit once elsewhere).
export function fmtSpec(spec, value, unit = spec?.unit, decimals = null) {
  if (!Number.isFinite(value)) return "";
  const kind = specValueKind(spec);
  if (kind && Number.isInteger(value)) {
    if (kind === "year") return String(value);
    const text = Math.abs(value) >= 10_000 ? value.toLocaleString("en-US") : String(value);
    return unit ? `${text} ${unit}` : text;
  }
  if (zhBillionsActive(spec, unit)) {
    const num = treemapZhOkuFromBillions(value);
    return unit ? `${num}亿美元` : num;
  }
  return fmt(value, unit, decimals, vizLang(spec));
}

export function tickLabelSpec(spec, value, unit = "") {
  if (!spec) return tickLabel(value, unit);
  const kind = specValueKind(spec);
  if (kind && Number.isInteger(value)) return fmtSpec(spec, value, unit);
  if (zhBillionsActive(spec, unit)) return fmtSpec(spec, value, unit);
  return tickLabel(value, unit, vizLang(spec));
}

// JSON number parsing is not bit-for-bit identical across V8, serde_json and
// Python.  Hashing the shortest spelling emitted by each runtime therefore
// made valid DuckDB results fail verification (typically by one ULP).  Row
// hashes use an explicit, loss-bounded wire form: integers stay numeric and
// Non-integral values become six-decimal strings. Use explicit half-away-from-
// zero rounding instead of each runtime's formatter (Python/Rust and V8 differ
// on binary halfway values such as 23747.0703125).
function fixedSix(value) {
  const magnitude = Math.floor(Math.abs(value) * 1_000_000 + 0.5);
  if (Number.isSafeInteger(magnitude)) {
    const whole = Math.floor(magnitude / 1_000_000);
    const fraction = String(magnitude % 1_000_000).padStart(6, "0");
    return `${value < 0 ? "-" : ""}${whole}.${fraction}`;
  }
  return value.toFixed(6);
}

function canonicalizeRows(value) {
  if (Array.isArray(value)) return value.map(canonicalizeRows);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeRows(value[key])]));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : fixedSix(value);
  }
  return value;
}

export function hashRows(rows) {
  return createHash("sha256").update(JSON.stringify(canonicalizeRows(rows))).digest("hex");
}

function inferVisualFamily(chartType) {
  if (["sankey", "alluvial", "parallel_sets"].includes(chartType)) return "flow";
  if (["node_link", "adjacency_matrix", "chord"].includes(chartType)) return "relationship";
  if (chartType === "hierarchy_tree") return "hierarchy";
  if (["timeline", "streamgraph", "trajectory_profile"].includes(chartType)) return "temporal";
  if (["geo_flow_map", "cartographic_flow_map", "choropleth"].includes(chartType)) return "spatial";
  if (chartType === "process_schematic") return "explanatory";
  return "statistical";
}

function inferDataTopology(chartType) {
  if (["sankey", "alluvial"].includes(chartType)) return "flow_edges";
  if (chartType === "parallel_sets") return "categorical_flow";
  if (["node_link", "adjacency_matrix", "chord"].includes(chartType)) return "graph_edges";
  if (chartType === "hierarchy_tree") return "hierarchy";
  if (chartType === "timeline") return "events";
  if (["geo_flow_map", "cartographic_flow_map"].includes(chartType)) return "geo_edges";
  if (chartType === "process_schematic") return "process_graph";
  return "tabular";
}

function topologyStats(rows, sourceField, targetField) {
  const nodes = unique(rows.flatMap((row) => [row[sourceField], row[targetField]]).filter((v) => v !== null && v !== undefined && String(v) !== ""));
  const edges = rows.filter((row) => String(row[sourceField] ?? "") && String(row[targetField] ?? ""));
  const selfLoops = edges.filter((row) => String(row[sourceField]) === String(row[targetField])).length;
  const density = nodes.length > 1 ? edges.length / (nodes.length * (nodes.length - 1)) : 0;
  return { nodes, edges, selfLoops, density };
}

function flowImbalances(rows, sourceField, targetField, valueField) {
  const totals = new Map();
  const ensure = (id) => { if (!totals.has(id)) totals.set(id, { in: 0, out: 0 }); return totals.get(id); };
  for (const row of rows) {
    const source = String(row[sourceField] ?? ""), target = String(row[targetField] ?? ""), value = n(row[valueField]) ?? 0;
    if (!source || !target || value < 0) continue;
    ensure(source).out += value; ensure(target).in += value;
  }
  return [...totals.entries()].flatMap(([node, t]) => {
    if (t.in <= 0 || t.out <= 0) return [];
    const base = Math.max(t.in, t.out, 1);
    return [{ node, in: t.in, out: t.out, relative: Math.abs(t.in - t.out) / base }];
  });
}

function countFlowCrossings(rows, spec) {
  const layout = flowLayout(rows, spec);
  const orderByLevel = new Map();
  layout.levels.forEach((level, li) => level.forEach((node, i) => orderByLevel.set(`${li}\0${node.id}`, i)));
  const edges = rows.map((row) => {
    const source = String(row[spec.source_field] ?? ""), target = String(row[spec.target_field] ?? "");
    const a = layout.nodes.get(source), b = layout.nodes.get(target);
    return a && b ? { sl: a.level, tl: b.level, si: orderByLevel.get(`${a.level}\0${source}`), ti: orderByLevel.get(`${b.level}\0${target}`) } : null;
  }).filter(Boolean);
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.sl !== b.sl || a.tl !== b.tl || a.si === b.si || a.ti === b.ti) continue;
    if ((a.si - b.si) * (a.ti - b.ti) < 0) crossings++;
  }
  return crossings;
}

function hasDirectedCycle(rows, sourceField, targetField) {
  const adj = new Map();
  for (const row of rows) {
    const a = String(row[sourceField] ?? ""), b = String(row[targetField] ?? "");
    if (!a || !b) continue;
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
    if (!adj.has(b)) adj.set(b, []);
  }
  const state = new Map();
  const visit = (node) => {
    const mark = state.get(node) ?? 0;
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(node, 1);
    for (const next of adj.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 2);
    return false;
  };
  return [...adj.keys()].some(visit);
}

function hierarchyStats(rows, nodeField, parentField) {
  const ids = rows.map((row) => String(row[nodeField] ?? "")).filter(Boolean);
  const idSet = new Set(ids);
  const duplicateIds = ids.length - idSet.size;
  const roots = rows.filter((row) => row[parentField] === null || row[parentField] === undefined || String(row[parentField]) === "");
  const missingParents = rows.filter((row) => {
    const p = row[parentField];
    return p !== null && p !== undefined && String(p) !== "" && !idSet.has(String(p));
  });
  const edges = rows.filter((row) => row[parentField] !== null && row[parentField] !== undefined && String(row[parentField]) !== "").map((row) => ({ source: row[parentField], target: row[nodeField] }));
  return { ids, duplicateIds, roots, missingParents, cycle: hasDirectedCycle(edges, "source", "target") };
}

function makeScale(values, left, right, scaleType = "linear") {
  const finite = values.filter((value) => Number.isFinite(value));
  if (scaleType === "log") {
    const positive = finite.filter((value) => value > 0);
    const domain = extent(positive.map(Math.log10), false);
    const linear = horizontalScale(domain, left, right);
    return { domain: [10 ** domain[0], 10 ** domain[1]], scale: (value) => linear(Math.log10(value)), ticks: logTickValues(domain) };
  }
  const domain = extent(finite, false);
  return { domain, scale: horizontalScale(domain, left, right), ticks: tickValues(domain, 4) };
}

function requiredFields(spec) {
  const common = ["title", "alt", "source_note", "unit", "sql", "reader_task", "chart_type"];
  // A draft visualization is useful while exploring a dataset or testing a
  // visual grammar. It is deliberately not publishable and therefore does
  // not need a verified claim_id. The default remains the strict, verified
  // contract for backwards compatibility.
  if (spec.verification_mode !== "draft") common.push("claim_id");
  const byType = {
    horizontal_bar: ["category_field", "value_field"],
    dot: ["category_field", "value_field"],
    dumbbell: ["category_field", "start_field", "end_field"],
    mirrored_bar: ["category_field", "series_field", "value_field"],
    slope: ["category_field", "start_field", "end_field"],
    line: ["x_field", "value_field"],
    multi_line: ["x_field", "value_field", "series_field"],
    small_multiples: ["x_field", "value_field", "facet_field"],
    scatter: ["x_field", "y_field"],
    strip_plot: ["category_field", "value_field"],
    diverging_bar: ["category_field", "value_field"],
    heatmap: ["x_field", "y_field", "value_field"],
    waffle: ["category_field", "value_field"],
    sankey: ["source_field", "target_field", "value_field"],
    alluvial: ["source_field", "target_field", "value_field"],
    node_link: ["source_field", "target_field"],
    adjacency_matrix: ["source_field", "target_field"],
    hierarchy_tree: ["node_field", "parent_field"],
    timeline: ["x_field", "label_field"],
    streamgraph: ["x_field", "value_field", "series_field"],
    parallel_sets: ["value_field"],
    chord: ["source_field", "target_field", "value_field"],
    geo_flow_map: ["source_lat_field", "source_lon_field", "target_lat_field", "target_lon_field", "value_field"],
    cartographic_flow_map: ["value_field", "geometry_semantics", "geometry_crs", "projection", "basemap_id", "basemap_source_url", "basemap_license", "basemap_content_hash"],
    trajectory_profile: ["x_field", "altitude_field", "speed_field", "segment_field"],
    process_schematic: ["source_field", "target_field"],
    choropleth: ["category_field", "value_field", "category_names", "basemap_id", "basemap_source_url", "basemap_license", "basemap_content_hash"],
    treemap: ["category_field", "value_field"],
    stacked_bar_100: ["category_field", "series_field", "value_field"],
  };
  return [...common, ...(byType[spec.chart_type] ?? [])];
}

// K110: checks on the chart's own rows for a scatter whose two axes were paired at plan time (spec.semantic_gate.scatter_pair, only
// present when NEWSROOM_SCATTER_PAIRED_MEASURES=1 made the plan). One point per object, one period for every row.
// Limit: a join that put two sources' different years under one period column cannot be seen here; the recorded query shows it.
const SCATTER_PERIOD_JOINERS = ["-", "–", "—", "/", " to ", "~"];
function scatterPeriodMatches(declared, rowPeriod) {
  const row = String(rowPeriod).trim();
  const tokens = [declared.date, declared.start, declared.end].filter((v) => v != null && String(v).trim()).map((v) => String(v).trim());
  const forms = new Set(tokens);
  if (declared.start && declared.end) for (const j of SCATTER_PERIOD_JOINERS) forms.add(`${String(declared.start).trim()}${j}${String(declared.end).trim()}`);
  if (forms.has(row)) return true;
  return tokens.some((token) => /^\d{4}$/.test(row) && (token.startsWith(`${row}-`) || token.startsWith(`${row}/`)));
}
export function scatterPairBlockers(spec, rows) {
  const out = [];
  const entityField = String(spec.entity_field ?? "").trim();
  const periodField = String(spec.period_field ?? "").trim();
  const shown = (values) => values.slice(0, 5).map((v) => `'${v}'`).join(", ") + (values.length > 5 ? `, … (${values.length} in all)` : "");
  if (!entityField) out.push("Scatter pairing requires entity_field (the field naming the object of each point)");
  if (!periodField) out.push("Scatter pairing requires period_field (the field holding the single period every row covers)");
  if (entityField && entityField === periodField) out.push("Scatter pairing: entity_field and period_field must be two different fields");
  if (entityField && !fieldExists(rows, entityField)) out.push(`Field '${entityField}' (entity_field) is absent from query output`);
  if (periodField && !fieldExists(rows, periodField)) out.push(`Field '${periodField}' (period_field) is absent from query output`);
  const blank = (v) => v === null || v === undefined || String(v).trim() === "";
  if (entityField && fieldExists(rows, entityField)) {
    const empty = rows.filter((row) => blank(row[entityField])).length;
    if (empty) out.push(`Scatter pairing: entity_field '${entityField}' is empty in ${empty} of ${rows.length} rows; every point must name its object`);
    const seen = new Map();
    for (const row of rows) if (!blank(row[entityField])) seen.set(String(row[entityField]).trim(), (seen.get(String(row[entityField]).trim()) ?? 0) + 1);
    const repeated = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
    if (repeated.length) out.push(`Scatter pairing: entity_field '${entityField}' repeats ${shown(repeated)}; one point per object, so keep one row each (one period, no duplicate join rows)`);
  }
  if (periodField && fieldExists(rows, periodField)) {
    const empty = rows.filter((row) => blank(row[periodField])).length;
    if (empty) out.push(`Scatter pairing: period_field '${periodField}' is empty in ${empty} of ${rows.length} rows`);
    const periods = [...new Set(rows.filter((row) => !blank(row[periodField])).map((row) => String(row[periodField]).trim()))];
    if (periods.length > 1) out.push(`Scatter pairing: period_field '${periodField}' holds ${periods.length} periods (${shown(periods)}); every row must cover the same single period`);
    if (periods.length === 1 && !empty) {
      const pair = spec.semantic_gate.scatter_pair;
      for (const [axis, id] of [["x", pair.x_measure], ["y", pair.y_measure]]) {
        const measure = (spec.semantic_gate.measures ?? []).find((m) => m.id === id);
        const declared = measure?.temporal_basis ?? {};
        const isoLike = (v) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(v ?? "").trim());
        if (declared.start && declared.end && isoLike(declared.start) && isoLike(declared.end) && String(declared.start).trim() > String(declared.end).trim()) {
          out.push(`Scatter pairing: the ${axis} axis (measure '${id}') declares a period that starts after it ends (${declared.start} to ${declared.end}); swap start and end`);
        } else if ((declared.date || declared.start || declared.end) && !scatterPeriodMatches(declared, periods[0])) {
          out.push(`Scatter pairing: the ${axis} axis (measure '${id}') declares ${[declared.date, declared.start && declared.end ? `${declared.start} to ${declared.end}` : declared.start ?? declared.end].filter(Boolean).join(" / ")} but the rows' period is '${periods[0]}'; make the declaration and the rows state the same period`);
        }
      }
    }
  }
  return out;
}

export function validateVizSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") return ["Visualization spec must be an object"];
  if (spec.verification_mode !== undefined && !["verified", "draft"].includes(spec.verification_mode)) errors.push("verification_mode must be 'verified' or 'draft'");
  if (spec.language !== undefined && !["en", "zh"].includes(spec.language)) errors.push("language must be 'en' or 'zh'");
  if (spec.category_names !== undefined && !CATEGORY_NAME_MODES.includes(spec.category_names)) errors.push(`category_names must be one of ${CATEGORY_NAME_MODES.join(", ")}`);
  if (!CHART_TYPES.includes(spec.chart_type)) errors.push(`Unsupported chart_type '${spec.chart_type}'`);
  if (!READER_TASKS.includes(spec.reader_task)) errors.push(`Unsupported reader_task '${spec.reader_task}'`);
  if (spec.visual_family !== undefined && !VISUAL_FAMILIES.includes(spec.visual_family)) errors.push(`Unsupported visual_family '${spec.visual_family}'`);
  if (spec.visual_family && spec.visual_family !== inferVisualFamily(spec.chart_type) && !(spec.visual_family === "temporal" && spec.chart_type === "line")) errors.push(`visual_family '${spec.visual_family}' does not match chart_type '${spec.chart_type}'`);
  if (spec.x_scale !== undefined && !["linear", "log"].includes(spec.x_scale)) errors.push("x_scale must be linear or log");
  if (spec.y_scale !== undefined && !["linear", "log"].includes(spec.y_scale)) errors.push("y_scale must be linear or log");
  if (spec.decimals !== undefined && (!Number.isInteger(spec.decimals) || spec.decimals < 0 || spec.decimals > 3)) errors.push("decimals must be an integer between 0 and 3");
  if (spec.data_topology !== undefined && !["tabular", "flow_edges", "graph_edges", "hierarchy", "events", "categorical_flow", "geo_edges", "process_graph"].includes(spec.data_topology)) errors.push(`Unsupported data_topology '${spec.data_topology}'`);
  if (spec.data_topology && spec.data_topology !== inferDataTopology(spec.chart_type)) errors.push(`data_topology '${spec.data_topology}' does not match chart_type '${spec.chart_type}'`);
  // world mode is behind NEWSROOM_MAP_WORLD (off by default): a spec that sets map_extent is refused on any chart
  if (spec.map_extent !== undefined && !mapWorldEnabled()) errors.push("MAP_EXTENT_DISABLED: map_extent (world mode) is switched off; draw the economies on the default map, or use a ranked bar");
  if (spec.index_base !== undefined) {
    if (spec.chart_type !== "small_multiples" || spec.panel_mark !== "line") errors.push("INDEX_BASE_NOT_APPLICABLE: index_base only applies to chart_type small_multiples with panel_mark 'line'; drop index_base for this chart");
    else if (!(Number.isFinite(spec.index_base) && spec.index_base > 0)) errors.push("INDEX_BASE_NOT_APPLICABLE: index_base must be a positive number");
  }
  if (spec.rank_cutoff !== undefined) {
    if (spec.chart_type !== "slope") errors.push("RANK_CUTOFF_NOT_APPLICABLE: rank_cutoff only applies to chart_type slope; drop rank_cutoff for this chart");
    else if (!(Number.isInteger(spec.rank_cutoff) && spec.rank_cutoff >= 2 && spec.rank_cutoff <= 30)) errors.push("RANK_CUTOFF_NOT_APPLICABLE: rank_cutoff must be an integer from 2 to 30");
  }
  if (spec.chart_type === "parallel_sets") {
    if (!Array.isArray(spec.dimension_fields) || spec.dimension_fields.length < 2 || spec.dimension_fields.length > 5) errors.push("parallel_sets requires dimension_fields with 2 to 5 field names");
    else if (spec.dimension_fields.some((field) => !String(field ?? "").trim())) errors.push("parallel_sets dimension_fields must be non-empty strings");
  }
  if (spec.chart_type === "cartographic_flow_map") {
    if (spec.flow_layer_field !== undefined && !String(spec.flow_layer_field ?? '').trim()) errors.push("flow_layer_field must be a non-empty field name when provided");
    if (spec.flow_unit_field !== undefined && !String(spec.flow_unit_field ?? '').trim()) errors.push("flow_unit_field must be a non-empty field name when provided");
    if (spec.flow_period_field !== undefined && !String(spec.flow_period_field ?? '').trim()) errors.push("flow_period_field must be a non-empty field name when provided");
    if (spec.flow_id_field !== undefined && !String(spec.flow_id_field ?? '').trim()) errors.push("flow_id_field must be a non-empty field name when provided");
    if (spec.flow_layer_field && !spec.flow_unit_field) errors.push("flow_unit_field is required when flow_layer_field is provided so layer scales cannot be confused");
    if (spec.flow_layer_order !== undefined && (!Array.isArray(spec.flow_layer_order) || spec.flow_layer_order.length < 1 || spec.flow_layer_order.length > 6 || spec.flow_layer_order.some((item) => !String(item ?? '').trim()))) errors.push("flow_layer_order must contain 1 to 6 non-empty layer names");
    if (!GEOMETRY_SEMANTICS.includes(spec.geometry_semantics)) errors.push(`geometry_semantics must be one of ${GEOMETRY_SEMANTICS.join(", ")}`);
    if (spec.geometry_crs !== 'EPSG:4326') errors.push("geometry_crs must be 'EPSG:4326' in cartography 0.1");
    if (!MAP_PROJECTIONS.includes(spec.projection)) errors.push(`projection must be one of ${MAP_PROJECTIONS.join(", ")}`);
    const basemap = getBasemap(spec.basemap_id);
    if (!basemap) errors.push(`Unknown basemap_id '${spec.basemap_id}'`);
    else {
      if (spec.basemap_source_url !== basemap.source_url) errors.push('basemap_source_url does not match the registered basemap provenance');
      if (spec.basemap_license !== basemap.license) errors.push('basemap_license does not match the registered basemap provenance');
      if (spec.basemap_content_hash !== basemap.content_hash) errors.push('basemap_content_hash does not match the registered basemap geometry');
    }
    if (["abstract_od","great_circle_reference"].includes(spec.geometry_semantics)) {
      for (const field of ["source_lat_field","source_lon_field","target_lat_field","target_lon_field"]) if (!String(spec[field] ?? '').trim()) errors.push(`${field} is required for ${spec.geometry_semantics}`);
    } else {
      if (!String(spec.route_provenance_note ?? '').trim()) errors.push(`route_provenance_note is required for ${spec.geometry_semantics}`);
      if (spec.geometry_semantics === 'observed_trajectory' && String(spec.trajectory_points_field ?? '').trim()) {
        if (spec.route_geometry_field !== undefined && String(spec.route_geometry_field).trim()) errors.push('observed_trajectory must use either trajectory_points_field or route_geometry_field, not both');
      } else {
        if (!String(spec.route_geometry_field ?? '').trim()) errors.push(`route_geometry_field is required for ${spec.geometry_semantics}`);
        if (spec.geometry_semantics === 'observed_trajectory' && !String(spec.time_field ?? '').trim()) errors.push('time_field is required for legacy observed_trajectory route geometry');
      }
    }
    if (spec.extent_mode !== undefined && !["world","data"].includes(spec.extent_mode)) errors.push('extent_mode must be world or data');
    if (spec.map_task !== undefined && !['global_context','regional_route','local_context','local_port','airport_detail','infrastructure_detail'].includes(spec.map_task)) errors.push('unsupported map_task');
    if (spec.extent_min_span_deg !== undefined && (!(Number(spec.extent_min_span_deg) >= 0) || Number(spec.extent_min_span_deg) > 60)) errors.push('extent_min_span_deg must be between 0 and 60');
    if (spec.reference_path !== undefined && !["none","great_circle"].includes(spec.reference_path)) errors.push('reference_path must be none or great_circle');
    if (spec.reference_path === 'great_circle' && spec.geometry_semantics !== 'observed_trajectory') errors.push('reference_path=great_circle is currently supported only for observed_trajectory');
    if (spec.aggregation_policy !== undefined && !["none","top_n"].includes(spec.aggregation_policy)) errors.push('aggregation_policy must be none or top_n');
    if (spec.aggregation_policy === 'top_n' && (!(Number(spec.top_n) >= 1) || Number(spec.top_n) > 80)) errors.push('top_n must be between 1 and 80 when aggregation_policy=top_n');
  }
  if (spec.chart_type === "choropleth") {
    // category_names itself is validated generically above (enum check) and
    // required generically below (requiredFields includes it for choropleth);
    // no extra check needed here.
    // choropleth's attribute sidecar (runtime/pi/assets/naturalearth-admin0-50m-attributes.json)
    // was built against, and is index-aligned with, exactly one registered
    // basemap: unlike cartographic_flow_map (any registered basemap),
    // choropleth requires that exact basemap_id, not merely a known one.
    if (spec.basemap_id !== CHOROPLETH_BASEMAP_ID) {
      errors.push(`choropleth requires basemap_id '${CHOROPLETH_BASEMAP_ID}' (the only basemap with a matching attribute sidecar)`);
    } else {
      const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
      if (!basemap) errors.push(`Unknown basemap_id '${CHOROPLETH_BASEMAP_ID}'`);
      else {
        if (spec.basemap_source_url !== basemap.source_url) errors.push('basemap_source_url does not match the registered basemap provenance');
        if (spec.basemap_license !== basemap.license) errors.push('basemap_license does not match the registered basemap provenance');
        if (spec.basemap_content_hash !== basemap.content_hash) errors.push('basemap_content_hash does not match the registered basemap geometry');
      }
    }
    // map_extent: opt-in whole-world mode; the only accepted value is "world".
    if (spec.map_extent !== undefined && mapWorldEnabled() && spec.map_extent !== "world") errors.push("choropleth map_extent must be 'world' when provided");
    // inset (task: zoom inset for regions too small to label on the main
    // map): opt-in, so its absence changes nothing. Either an explicit ISO3
    // list (`iso3`) or automatic selection (`auto: true`), never both -
    // the renderer needs one unambiguous source of truth for which regions
    // get pulled into the inset instead of labelled on the main map.
    if (spec.inset !== undefined) {
      if (!spec.inset || typeof spec.inset !== "object" || Array.isArray(spec.inset)) {
        errors.push("choropleth inset must be an object");
      } else {
        const hasIso3 = spec.inset.iso3 !== undefined;
        const hasAuto = spec.inset.auto !== undefined;
        if (hasIso3 && hasAuto) errors.push("choropleth inset must set either iso3 or auto, not both");
        else if (!hasIso3 && !hasAuto) errors.push("choropleth inset requires either iso3 (a list of ISO3 codes) or auto: true");
        if (hasIso3) {
          if (!Array.isArray(spec.inset.iso3) || spec.inset.iso3.length === 0 || spec.inset.iso3.some((code) => !String(code ?? "").trim())) {
            errors.push("choropleth inset.iso3 must be a non-empty array of ISO3 codes");
          }
        }
        if (hasAuto && spec.inset.auto !== true) errors.push("choropleth inset.auto must be true when provided");
        if (spec.inset.title !== undefined && !String(spec.inset.title ?? "").trim()) errors.push("choropleth inset.title must be a non-empty string when provided");
      }
    }
  } else if (spec.inset !== undefined) {
    errors.push("inset is only supported on chart_type 'choropleth'");
  }
  if (spec.chart_type === "treemap") {
    if (spec.other_threshold_pct !== undefined && (!Number.isFinite(Number(spec.other_threshold_pct)) || Number(spec.other_threshold_pct) < 0 || Number(spec.other_threshold_pct) > 50)) {
      errors.push("treemap other_threshold_pct must be a number between 0 and 50");
    }
    // The "Other" bucket merges small leaves across the whole dataset; a
    // group_field partitions leaves into named groups. Combining both would
    // leave "Other" ambiguously belonging to no group (or every group), so
    // this keeps the one-level grouping this task authorizes unambiguous
    // rather than inventing a per-group Other bucket nobody asked for.
    if (spec.group_field && spec.other_threshold_pct !== undefined) errors.push("treemap other_threshold_pct is not supported together with group_field");
  }
  if (spec.chart_type === "strip_plot") {
    if (spec.group_order !== undefined && !STRIP_GROUP_ORDERS.includes(spec.group_order)) errors.push(`strip_plot group_order must be one of ${STRIP_GROUP_ORDERS.join(", ")}`);
    if (spec.point_layout !== undefined && !STRIP_POINT_LAYOUTS.includes(spec.point_layout)) errors.push(`strip_plot point_layout must be one of ${STRIP_POINT_LAYOUTS.join(", ")}`);
    if (spec.show_median !== undefined && typeof spec.show_median !== "boolean") errors.push("strip_plot show_median must be true or false");
    if (spec.label_extremes !== undefined && (typeof spec.label_extremes !== "number" || !Number.isInteger(spec.label_extremes) || spec.label_extremes < 0 || spec.label_extremes > STRIP_MAX_LABEL_EXTREMES)) errors.push(`strip_plot label_extremes must be an integer between 0 and ${STRIP_MAX_LABEL_EXTREMES}`);
  }
  if (spec.chart_type === "stacked_bar_100") {
    // All of these are optional; a malformed one is refused here so the
    // renderer (which only ever sees a validated spec) never has to guess.
    if (spec.decimals !== undefined && spec.decimals !== 0 && spec.decimals !== 1) errors.push("stacked_bar_100 decimals must be 0 or 1");
    if (spec.sort !== undefined && !["asc", "desc", "none"].includes(spec.sort)) errors.push("stacked_bar_100 sort must be asc, desc or none");
    if (spec.segment_order !== undefined) {
      if (!Array.isArray(spec.segment_order) || spec.segment_order.length < 1 || spec.segment_order.length > STACKED_MAX_SEGMENTS || spec.segment_order.some((item) => typeof item !== "string" || !item.trim())) errors.push(`stacked_bar_100 segment_order must list 1 to ${STACKED_MAX_SEGMENTS} non-empty segment names`);
      else if (new Set(spec.segment_order).size !== spec.segment_order.length) errors.push("stacked_bar_100 segment_order must not repeat a segment");
    }
    for (const key of ["sort_segment", "highlight_segment"]) {
      if (spec[key] !== undefined && (typeof spec[key] !== "string" || !spec[key].trim())) errors.push(`stacked_bar_100 ${key} must be a non-empty segment name when provided`);
    }
    if (spec.segment_values !== undefined && !STACKED_SEGMENT_VALUES.includes(spec.segment_values)) errors.push(`stacked_bar_100 segment_values must be one of ${STACKED_SEGMENT_VALUES.join(", ")}`);
  }
  if (spec.chart_type === "mirrored_bar") {
    // Optional mirrored_bar fields: reject malformed shapes here so the
    // renderer and lintVizSpec can rely on the documented values. Whether a
    // left_series / current_period value exists in the rows is a data check
    // and lives in lintVizSpec.
    if (spec.first_row !== undefined && !["bottom", "top"].includes(spec.first_row)) errors.push("mirrored_bar first_row must be 'bottom' or 'top'");
    if (spec.compare_layout !== undefined && !["overlay", "side_by_side"].includes(spec.compare_layout)) errors.push("mirrored_bar compare_layout must be 'overlay' or 'side_by_side'");
    for (const field of ["left_series", "current_period", "period_field"]) {
      const value = spec[field];
      if (value !== undefined && (value === null || typeof value === "object" || !String(value).trim())) errors.push(`mirrored_bar ${field} must be a non-empty string when provided`);
    }
    if (spec.direct_labels !== undefined && typeof spec.direct_labels !== "boolean") errors.push("mirrored_bar direct_labels must be true or false");
  }
  for (const field of requiredFields(spec)) {
    if (spec[field] === undefined || spec[field] === null || String(spec[field]).trim() === "") errors.push(`Missing required field '${field}'`);
  }
  if (spec.annotations !== undefined && !Array.isArray(spec.annotations)) errors.push("annotations must be an array");
  if (Array.isArray(spec.annotations)) {
    if (spec.annotations.length > 8) errors.push("annotations may contain at most 8 items");
    spec.annotations.forEach((annotation, index) => {
      if (!annotation || typeof annotation !== "object") { errors.push(`annotations[${index}] must be an object`); return; }
      if (!["point", "node", "reference_line", "range_bracket"].includes(annotation.type)) errors.push(`annotations[${index}].type is unsupported`);
      if (!String(annotation.text ?? "").trim()) errors.push(`annotations[${index}].text is required`);
      if (spec.verification_mode !== "draft" && !String(annotation.claim_id ?? "").trim()) errors.push(`annotations[${index}].claim_id is required`);
      if (["point", "node"].includes(annotation.type) && (!String(annotation.match_field ?? "").trim() || annotation.match_value === undefined)) errors.push(`annotations[${index}] ${annotation.type} annotations require match_field and match_value`);
      if (annotation.type === "reference_line" && (typeof annotation.value !== "number" || !Number.isFinite(annotation.value))) errors.push(`annotations[${index}] reference_line requires a finite numeric value`);
      if (annotation.type === "range_bracket") {
        if (!String(annotation.match_field ?? "").trim() || annotation.match_value === undefined || annotation.end_match_value === undefined) errors.push(`annotations[${index}] range_bracket requires match_field, match_value and end_match_value`);
        if (annotation.tone !== undefined && annotation.tone !== "accent") errors.push(`annotations[${index}] range_bracket tone must be 'accent' when set`);
      }
    });
  }
  return errors;
}

function fieldExists(rows, field) {
  return rows.length > 0 && rows.some((row) => Object.prototype.hasOwnProperty.call(row, field));
}

function numericCount(rows, field) {
  return rows.reduce((count, row) => count + (n(row[field]) === null ? 0 : 1), 0);
}

function cartographicDataExtent(spec,rows){
  const lines=[];for(const row of selectRoutes(rows,spec)){
    if(spec.geometry_semantics==='observed_trajectory'&&spec.trajectory_points_field){const pts=parseTrajectoryPoints(row[spec.trajectory_points_field]),ls=trajectoryLines(pts);if(ls)lines.push(...ls);}
    else if(['abstract_od','great_circle_reference'].includes(spec.geometry_semantics)){const vals=[n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),n(row[spec.target_lon_field]),n(row[spec.target_lat_field])];if(vals.every(v=>v!==null))lines.push([[vals[0],vals[1]],[vals[2],vals[3]]]);}
    else {const ls=parseRouteGeometry(row[spec.route_geometry_field]);if(ls)lines.push(...ls);}
  }return coordinateExtent(lines);
}

// Emphasis hint: a title/takeaway that names one of the chart's own
// categories or series while highlight_values is empty leaves the whole chart
// neutral grey. Only chart types whose renderer really paints highlight_values
// are checked, each against the field that highlight_values is matched on.
const HIGHLIGHT_NAME_FIELD = {
  horizontal_bar: "category_field",
  dot: "category_field",
  diverging_bar: "category_field",
  slope: "category_field",
  multi_line: "series_field",
  scatter: "label_field",
  strip_plot: "category_field", // paints highlight_values on a whole group (or on a unit named by label_field)
  mirrored_bar: "category_field",
};
const HIGHLIGHT_HINT_MAX_NAMES = 4;
const HIGHLIGHT_HINT_MIN_NAME_LENGTH = 2;
const HIGHLIGHT_HINT_CRITIC_PENALTY = 12;

// Raw values of the highlight field that the title or takeaway names. Names
// are compared by their displayed form (category_names applied) and by raw
// value; the longest name matches first and consumes its text so a shorter
// name inside it never counts; alphanumeric names (years included) must not
// touch other letters or digits; names under HIGHLIGHT_HINT_MIN_NAME_LENGTH are skipped; more
// than HIGHLIGHT_HINT_MAX_NAMES distinct hits is a list, not a focus.
export function titleNamedHighlightValues(spec, rows, categoryNames = spec?.category_names) {
  const field = spec?.[HIGHLIGHT_NAME_FIELD[spec?.chart_type]];
  if (!field || (spec.highlight_values ?? []).length > 0 || !Array.isArray(rows)) return [];
  const text = [spec.title, spec.takeaway].map((part) => String(part ?? "")).filter(Boolean).join("\n").toLowerCase();
  if (!text) return [];
  const lang = vizLang(spec);
  const candidates = [];
  for (const raw of unique(rows.map((row) => row?.[field]).filter((v) => v !== undefined && v !== null)).map(String)) {
    for (const name of new Set([raw, String(resolveEconomyDisplayName(raw, categoryNames, lang))])) {
      const key = name.trim().toLowerCase();
      if ([...key].length >= HIGHLIGHT_HINT_MIN_NAME_LENGTH) candidates.push({ raw, name: name.trim(), key });
    }
  }
  candidates.sort((a, b) => b.key.length - a.key.length);
  const taken = new Array(text.length).fill(false);
  const hits = new Map();
  for (const { raw, name, key } of candidates) {
    const alnum = /^[a-z0-9]+$/.test(key);
    for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
      const end = at + key.length;
      if (taken.slice(at, end).some(Boolean)) continue;
      if (alnum && (/[a-z0-9]/.test(text[at - 1] ?? "") || /[a-z0-9]/.test(text[end] ?? ""))) continue;
      for (let i = at; i < end; i += 1) taken[i] = true;
      if (!hits.has(raw)) hits.set(raw, name);
    }
  }
  if (hits.size === 0 || hits.size > HIGHLIGHT_HINT_MAX_NAMES) return [];
  return [...hits.entries()].map(([raw, name]) => ({ raw, name }));
}

// {message, suggestion} for the lint warning and the critic issue, in the chart's language.
function emphasisHint(spec, named) {
  const values = JSON.stringify(named.map((n) => n.raw));
  if (vizLang(spec) === "zh") {
    const names = named.map((n) => `\u300e${n.name}\u300f`).join("");
    return `\u6807\u9898\u70b9\u540d\u4e86${names}\uff0c\u4f46 highlight_values \u4e3a\u7a7a\uff1b\u5efa\u8bae\u586b ${values}`;
  }
  const names = named.map((n) => `"${n.name}"`).join(", ");
  return `The title names ${names} but highlight_values is empty; suggest ${values}`;
}

export function lintVizSpec(spec, rows, context = {}) {
  const autoCategoryNames = resolveAutoCategoryNames(spec, rows);
  const unsignaledWarning = autoCategoryNames ? null : unsignaledEconomyWarning(spec, rows);
  if (autoCategoryNames) spec = autoCategoryNames.spec;
  const blockers = [];
  const warnings = [];
  if (unsignaledWarning) warnings.push(unsignaledWarning);
  const notes = [];
  const verificationMode = spec?.verification_mode ?? "verified";
  if (!["verified", "draft"].includes(verificationMode)) blockers.push("verification_mode must be 'verified' or 'draft'");
  if (verificationMode === "draft") {
    warnings.push("DRAFT visualization: exploratory output only; it must not be used as a publishable factual artifact until a verified claim is bound.");
  } else if (!String(spec?.claim_id ?? "").trim()) {
    blockers.push("A verified visualization requires claim_id");
  }
  blockers.push(...validateVizSpec(spec));
  if (spec.semantic_gate?.status === "BLOCK") blockers.push("semantic_comparison_blocked");
  if (spec.semantic_gate?.status === "CONTEXTUAL") notes.push("Semantic comparison is contextual; visual roles must remain explicitly differentiated");
  if (!Array.isArray(rows) || rows.length === 0) blockers.push("Visualization query returned no rows");
  // strip_plot draws one dot per row (many units per group), so it carries its
  // own point cap (STRIP_MAX_POINTS, checked in lintStripPlotSpec) instead of
  // this general row cap; every other chart type keeps the 240-row limit.
  if (rows.length > 240 && spec.chart_type !== "strip_plot") blockers.push(`Visualization query returned ${rows.length} rows; maximum is 240`);

  const requiredDataFields = [
    spec.category_field,
    spec.x_field,
    spec.y_field,
    spec.value_field,
    spec.start_field,
    spec.end_field,
    spec.series_field,
    spec.facet_field,
    spec.reference_period_field,
    spec.source_field,
    spec.target_field,
    spec.node_field,
    spec.parent_field,
    spec.group_field,
    spec.source_lat_field,
    spec.source_lon_field,
    spec.target_lat_field,
    spec.target_lon_field,
    spec.route_geometry_field,
    spec.trajectory_points_field,
    spec.route_provenance_field,
    spec.time_field,
    spec.altitude_field,
    spec.speed_field,
    spec.segment_field,
    ...(Array.isArray(spec.dimension_fields) ? spec.dimension_fields : []),
  ].filter(Boolean);
  for (const field of unique(requiredDataFields)) {
    if (!fieldExists(rows, field)) blockers.push(`Field '${field}' is absent from query output`);
  }

  for (const field of [spec.value_field, spec.start_field, spec.end_field, spec.source_lat_field, spec.source_lon_field, spec.target_lat_field, spec.target_lon_field].filter(Boolean)) {
    if (fieldExists(rows, field) && numericCount(rows, field) !== rows.length) {
      blockers.push(`Field '${field}' contains non-numeric or missing values`);
    }
  }
  if (spec.chart_type === "trajectory_profile") {
    if (fieldExists(rows,spec.x_field) && numericCount(rows,spec.x_field)!==rows.length) blockers.push(`trajectory_profile x_field '${spec.x_field}' must be numeric`);
    if (fieldExists(rows,spec.altitude_field) && numericCount(rows,spec.altitude_field)<Math.max(2,Math.ceil(rows.length*.8))) blockers.push(`trajectory_profile altitude_field '${spec.altitude_field}' has insufficient numeric coverage`);
    if (fieldExists(rows,spec.speed_field) && numericCount(rows,spec.speed_field)<Math.max(2,Math.ceil(rows.length*.6))) blockers.push(`trajectory_profile speed_field '${spec.speed_field}' has insufficient numeric coverage`);
  }
  if (spec.chart_type === "scatter") {
    if (fieldExists(rows, spec.x_field) && numericCount(rows, spec.x_field) !== rows.length) blockers.push(`Scatter x_field '${spec.x_field}' must be numeric`);
    if (fieldExists(rows, spec.y_field) && numericCount(rows, spec.y_field) !== rows.length) blockers.push(`Scatter y_field '${spec.y_field}' must be numeric`);
  }
  if (spec.chart_type === "scatter" && spec.semantic_gate?.scatter_pair) blockers.push(...scatterPairBlockers(spec, rows));
  if (spec.x_scale === "log" && spec.x_field && rows.some((row) => (n(row[spec.x_field]) ?? 0) <= 0)) blockers.push(`Log x_scale requires positive values in '${spec.x_field}'`);
  if (spec.y_scale === "log" && spec.y_field && rows.some((row) => (n(row[spec.y_field]) ?? 0) <= 0)) blockers.push(`Log y_scale requires positive values in '${spec.y_field}'`);

  const verifiedClaimIds = new Set(context.verified_claim_ids ?? []);
  if (spec.claim_id && !verifiedClaimIds.has(spec.claim_id)) {
    blockers.push(`claim_id '${spec.claim_id}' is not a verified recorded claim`);
  }
  // Binding of each cited claim to THIS chart's own computation. The verdicts
  // come from claim_binding.mjs (computed in the async layer); absent context
  // means the caller did not compute them and the check is skipped.
  const claimBindings = context.claim_bindings && typeof context.claim_bindings === "object" ? context.claim_bindings : null;
  const bindingBlocker = (label, claimId) => {
    const verdict = claimBindings?.[claimId];
    if (verdict && verdict.ok !== true) blockers.push(`${label} '${claimId}' is not bound to this chart's computation: ${verdict.message}`);
  };
  if (spec.claim_id && verifiedClaimIds.has(spec.claim_id)) bindingBlocker("claim_id", spec.claim_id);
  for (const [index, annotation] of annotations(spec).entries()) {
    if (annotation.claim_id && !verifiedClaimIds.has(annotation.claim_id)) blockers.push(`annotations[${index}].claim_id '${annotation.claim_id}' is not a verified recorded claim`);
    else if (annotation.claim_id) bindingBlocker(`annotations[${index}].claim_id`, annotation.claim_id);
    if (["point", "node"].includes(annotation.type) && annotation.match_field) {
      if (!fieldExists(rows, annotation.match_field)) blockers.push(`annotations[${index}] match_field '${annotation.match_field}' is absent from query output`);
      else if (!rows.some((row) => String(row[annotation.match_field]) === String(annotation.match_value))) blockers.push(`annotations[${index}] target '${annotation.match_value}' was not found in '${annotation.match_field}'`);
    }
    if (["point", "node"].includes(annotation.type) && ["strip_plot", "mirrored_bar", "stacked_bar_100"].includes(spec.chart_type)) {
      blockers.push(`annotations[${index}] ${annotation.type} is not supported on chart_type '${spec.chart_type}'; ${spec.chart_type === "strip_plot" ? "it draws no annotations, so name an extreme with label_field and label_extremes instead" : "it draws no annotations and nothing needs adding"}`);
    }
    if (annotation.type === "reference_line") {
      if (!REFERENCE_LINE_CHART_TYPES.has(spec.chart_type)) {
        blockers.push(`annotations[${index}] reference_line is not supported on chart_type '${spec.chart_type}'`);
      } else {
        const domain = referenceLineDomain(spec, rows);
        if (domain && (annotation.value < domain[0] || annotation.value > domain[1])) blockers.push(`annotations[${index}] reference_line value ${annotation.value} is outside the value axis domain [${domain[0]}, ${domain[1]}]`);
      }
    }
    if (annotation.type === "range_bracket") {
      if (!RANGE_BRACKET_CHART_TYPES.has(spec.chart_type)) {
        blockers.push(`annotations[${index}] range_bracket is not supported on chart_type '${spec.chart_type}'`);
      } else if (spec.chart_type === "dot" && spec.series_field && fieldExists(rows, spec.series_field)) {
        blockers.push(`annotations[${index}] range_bracket is not supported when series_field is set (grouped dot layout)`);
      } else if (annotation.match_field !== spec.category_field) {
        blockers.push(`annotations[${index}] range_bracket match_field must equal category_field`);
      } else if (spec.category_field && fieldExists(rows, spec.category_field)) {
        const values = rows.map((row) => String(row[spec.category_field]));
        if (!values.includes(String(annotation.match_value))) blockers.push(`annotations[${index}] range_bracket match_value '${annotation.match_value}' was not found in '${spec.category_field}'`);
        if (!values.includes(String(annotation.end_match_value))) blockers.push(`annotations[${index}] range_bracket end_match_value '${annotation.end_match_value}' was not found in '${spec.category_field}'`);
      }
    }
  }
  if (annotations(spec).length > 4) warnings.push(`Visualization has ${annotations(spec).length} annotations; editorial hierarchy may become crowded`);
  if (["horizontal_bar", "bar"].includes(spec.chart_type) && (spec.highlight_values ?? []).length) {
    // A declared emphasis that matches no category would silently draw an all-grey chart.
    const categories = new Set(rows.map((row) => String(row[spec.category_field])));
    const missing = spec.highlight_values.map(String).filter((v) => !categories.has(v));
    if (missing.length) warnings.push(`highlight_values ${JSON.stringify(missing)} match no '${spec.category_field}' value, so those bars stay neutral`);
  }
  const namedForEmphasis = titleNamedHighlightValues(spec, rows);
  if (namedForEmphasis.length) warnings.push(emphasisHint(spec, namedForEmphasis));
  if ((spec.highlight_values ?? []).length > 4) warnings.push(`Visualization highlights ${(spec.highlight_values ?? []).length} values; consider one primary focus and contextual series`);

  const rangeBrackets = annotations(spec).filter((a) => a?.type === "range_bracket");
  if (rangeBrackets.length > 2) blockers.push(`Visualization has ${rangeBrackets.length} range_bracket annotations; maximum is 2`);
  if (rangeBrackets.length > 1 && spec.category_field && fieldExists(rows, spec.category_field)) {
    const categories = sortRows(rows, spec, spec.value_field).map((row) => String(row[spec.category_field]));
    const ranges = rangeBrackets
      .map((bracket) => {
        const i1 = categories.indexOf(String(bracket.match_value));
        const i2 = categories.indexOf(String(bracket.end_match_value));
        return i1 === -1 || i2 === -1 ? null : [Math.min(i1, i2), Math.max(i1, i2)];
      })
      .filter(Boolean);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        if (ranges[i][0] <= ranges[j][1] && ranges[j][0] <= ranges[i][1]) blockers.push("range_bracket annotations must not overlap");
      }
    }
  }

  if (!spec.alt || String(spec.alt).trim().length < 20) blockers.push("Alt description must be at least 20 characters");
  if (!spec.source_note || String(spec.source_note).trim().length < 3) blockers.push("Source attribution is required");
  if (!spec.unit || String(spec.unit).trim().length < 1) blockers.push("A quantitative unit is required");
  if (vizLang(spec) === "zh") {
    if (!hasCjk(spec.title)) blockers.push("zh chart title contains no CJK characters");
    if (spec.subtitle && !hasCjk(spec.subtitle)) blockers.push("zh chart subtitle contains no CJK characters");
  }

  const nameFields = categoryNameFields(spec);
  if (spec.category_names !== undefined) {
    if (!nameFields?.length) {
      blockers.push(spec.chart_type === "scatter"
        ? "category_names on chart_type 'scatter' needs label_field (the column whose values are the point names)"
        : `category_names is not supported on chart_type '${spec.chart_type}'`);
    } else if (spec.chart_type === "choropleth" && !ECONOMY_NAME_MODES.includes(spec.category_names)) {
      // lintChoroplethSpec below owns this blocker (a currency code is not a map feature).
    } else {
      const presentNameFields = nameFields.filter((candidate) => fieldExists(rows, candidate));
      for (const field of presentNameFields) {
        const unmapped = unmappedEconomyNameValues(nameFieldValues(spec, rows, field), spec.category_names);
        if (unmapped.length) {
          const shown = unmapped.slice(0, 5).map((value) => `'${value}'`).join(", ");
          blockers.push(`category_names='${spec.category_names}' cannot resolve ${unmapped.length} value(s) in '${field}' (e.g. ${shown}); use ${UNMAPPED_NAME_GUIDANCE[spec.category_names] ?? UNMAPPED_NAME_GUIDANCE.worldbank} instead of translating it yourself`);
        }
      }
      if (AGGREGATE_MIX_BLOCKED_CHART_TYPES.has(spec.chart_type)) {
        for (const field of presentNameFields) {
          const mix = aggregateMixInNameField(spec, rows, field);
          if (mix) blockers.push(aggregateMixBlocker(spec, field, mix));
        }
      }
      if (spec.category_names === "iso2") {
        const unsignalled = presentNameFields.filter((field) => !fieldNameSignalsEconomy(field));
        if (unsignalled.length) blockers.push(iso2NeedsCountryColumnBlocker(unsignalled));
      }
      if (vizLang(spec) === "zh") {
        const regions = specialRegionsInNameFields(spec, rows, presentNameFields);
        const offending = [["title", spec.title], ["subtitle", spec.subtitle]].filter(([, text]) => saysCountryWithoutRegions(text)).map(([label]) => label);
        if (regions.length && offending.length) {
          const listed = regions.map((region) => `${region.zh} (${region.iso3})`).join(", ");
          warnings.push(`zh chart lists ${listed}, but its ${offending.join(" and ")} ${offending.length > 1 ? "say" : "says"} 国家 without 和地区; write 国家和地区 (or 经济体) instead of a bare 国家 (zh naming policy rule 4)`);
        }
      }
    }
  } else if (vizLang(spec) === "zh" && nameFields?.length) {
    let fields = nameFields.filter((candidate) => fieldExists(rows, candidate));
    // A column whose name says it holds economies or currencies has to resolve in full: one value without CJK characters
    // blocks, whatever the match count (declaredNameFieldBlocker). The older rule below keeps every other column.
    // Choropleth owns its own name blockers.
    if (spec.chart_type !== "choropleth") {
      const declared = fields.filter((field) => (fieldNameSignalsEconomy(field) || fieldNameSignalsCurrency(field)) && distinctNameValues(spec, rows, field).some((value) => !hasCjk(value)));
      if (declared.length) {
        blockers.push(declaredNameFieldBlocker(spec, rows, declared));
        fields = fields.filter((field) => !declared.includes(field));
      }
    }
    const raw = fields.flatMap((field) => nameFieldValues(spec, rows, field));
    if (fields.length && raw.length && raw.every((value) => !hasCjk(value))) {
      const values = [...new Set(raw.map((value) => String(value ?? "").trim()).filter(Boolean))];
      const best = spec.chart_type === "choropleth" ? null : recognizableNameColumn(values, fields);
      if (best) {
        blockers.push(zhNameFieldBlocker(fields, values, best));
      } else {
        warnings.push(`zh chart's '${fields.join("' and '")}' values contain no CJK characters; consider setting category_names to show localized names instead of the raw World Bank English text`);
      }
    }
  }

  if (spec.chart_type === "choropleth") {
    const cl = lintChoroplethSpec(spec, rows);
    blockers.push(...cl.blockers);
    warnings.push(...cl.warnings);
  }

  if (spec.reference_period_field && fieldExists(rows, spec.reference_period_field)) {
    const periods = unique(rows.map((row) => row[spec.reference_period_field]).filter((v) => v !== null && v !== undefined));
    if (periods.length > 1) {
      const strategy = spec.mixed_period_strategy ?? "reject";
      const separatedByFacet = spec.facet_field === spec.reference_period_field && spec.chart_type === "small_multiples";
      if (strategy === "reject" && !separatedByFacet) {
        blockers.push(`Mixed reference periods detected (${periods.join(", ")}); separate them or explicitly justify the comparison`);
      } else if (strategy === "facet" && !separatedByFacet) {
        blockers.push("mixed_period_strategy='facet' requires small_multiples with facet_field equal to reference_period_field");
      } else {
        notes.push(`Reference periods explicitly handled: ${periods.join(", ")}`);
      }
    }
  }

  if (spec.chart_type === "slope" && Number.isInteger(spec.rank_cutoff) && Array.isArray(rows)) {
    const bad = nonIntegerRankRows(spec, rows);
    if (bad.length) blockers.push(`RANK_NOT_INTEGER: with rank_cutoff, ${spec.start_field} and ${spec.end_field} must hold ranks that are positive integers (or be empty for outside the ranking); not rounded; rows: ${bad.slice(0, 8).join("; ")}${bad.length > 8 ? `; and ${bad.length - 8} more` : ""}. Compute integer ranks in SQL (RANK() or ROW_NUMBER()), or drop rank_cutoff`);
  }

  if (spec.chart_type === "small_multiples") {
    if (!spec.panel_mark || !["line", "dot"].includes(spec.panel_mark)) {
      blockers.push("small_multiples requires panel_mark='line' or panel_mark='dot'");
    }
    if (spec.index_base !== undefined && spec.panel_mark === "line" && Number.isFinite(spec.index_base) && spec.index_base > 0 && Array.isArray(rows) && rows.length) {
      const period = indexBasePeriod(spec, rows);
      if (period.missing) blockers.push(`INDEX_BASE_NOT_IN_DATA: no x value equals index_base ${spec.index_base} in every panel (panels without it: ${period.missing.join(", ")}); rebase in SQL so each series equals ${spec.index_base} at the base period, or drop index_base`);
    }
  }

  if (spec.chart_type === "waffle") {
    const singleGrid = spec.waffle_layout === "single_grid";
    if (singleGrid) {
      // A single shared grid reads as a mosaic of every category at once,
      // so it can hold more categories than the one-grid-per-category
      // default mode - but below 2 there is nothing to apportion, and
      // above 5 the legend and the accent+grey palette (one highlighted
      // colour plus a short grey/grey-blue ramp) stop being legible. The
      // renderer's own merge-to-"其他" logic is a defensive second layer
      // for specs that already validate at <=5 rows post-aggregation -
      // it is not licence to submit more than 5 raw categories here; the
      // model should aggregate or filter instead.
      if (rows.length < 2 || rows.length > 5) blockers.push(`single-grid waffle has ${rows.length} rows; must be 2-5 categories - aggregate or filter rows in SQL`);
    } else if (rows.length > 4) {
      // One 10x10 grid per row: more than 4 grids cannot share an
      // editorial frame at a legible cell size, so this is a hard cap
      // rather than a shrink-to-fit warning - the model should aggregate
      // or filter instead.
      blockers.push(`waffle has ${rows.length} rows; maximum is 4 - filter rows in SQL to at most 4`);
    }
    if (spec.unit !== "%") blockers.push("waffle requires unit='%'");
    if (fieldExists(rows, spec.value_field)) {
      // numericCount above already blocks non-numeric/missing value_field
      // values; this only adds the waffle-specific 0-100 range on values
      // that did parse, so the two checks never produce overlapping/
      // confusing messages for the same row.
      const outOfRange = rows.some((row) => { const value = n(row[spec.value_field]); return value !== null && (value < 0 || value > 100); });
      if (outOfRange) blockers.push(`waffle value_field '${spec.value_field}' must be between 0 and 100`);
    }
  }

  if (spec.chart_type === "treemap") {
    // Tile area is strictly proportional to value_field, so a zero or
    // negative value cannot be represented as an area at all (not "a small
    // tile" - an undefined one). numericCount above already blocks
    // non-numeric/missing values; this only adds the positivity floor on
    // values that did parse.
    if (fieldExists(rows, spec.value_field)) {
      const nonPositive = rows.some((row) => { const value = n(row[spec.value_field]); return value !== null && value <= 0; });
      if (nonPositive) blockers.push(`treemap value_field '${spec.value_field}' must be strictly positive; area cannot represent a zero or negative value`);
    }
    // A squarified layout degrades into unreadable slivers well before it
    // runs out of room; 60 is a hard structural cap (like waffle's 4-grid
    // cap above), not a shrink-to-fit warning, so the model aggregates
    // (other_threshold_pct) or filters in SQL instead.
    if (rows.length > 60) blockers.push(`treemap has ${rows.length} rows; maximum is 60 - filter rows in SQL or set other_threshold_pct to bucket small items into an Other tile`);
    if (spec.group_field && fieldExists(rows, spec.group_field)) {
      const groups = unique(rows.map((row) => row[spec.group_field]));
      if (groups.length > 10) blockers.push(`treemap group_field has ${groups.length} groups; maximum is 10 for a legible one-level grouping`);
    }
  }

  if (spec.chart_type === "stacked_bar_100") {
    // Every bar is one entity's whole (0-100%) split into its segments. The
    // renderer never rescales a value to make a bar add up, so the data must
    // already do: each entity's values sum to 100 (+/- 1 for rounding in the
    // source), and a value cannot be drawn as a negative width. A non-numeric
    // or non-finite value is already blocked by the generic value_field check
    // above, so it is not repeated here.
    if (spec.unit !== "%") blockers.push("stacked_bar_100 requires unit='%'");
    if (fieldExists(rows, spec.category_field) && fieldExists(rows, spec.series_field)) {
      const model = stackedBarModel(spec, rows);
      if (model.entities.length > STACKED_MAX_BARS) blockers.push(`stacked_bar_100 has ${model.entities.length} bars; maximum is ${STACKED_MAX_BARS} - filter rows in SQL to at most ${STACKED_MAX_BARS} entities`);
      else if (model.entities.length > STACKED_WARN_BARS) warnings.push(`stacked_bar_100 has ${model.entities.length} bars; more than ${STACKED_WARN_BARS} bars make a long page - consider filtering to the entities the claim is about`);
      if (model.segments.length > STACKED_MAX_SEGMENTS) blockers.push(`stacked_bar_100 has ${model.segments.length} segments; maximum is ${STACKED_MAX_SEGMENTS} - merge the smallest segments into one 'Other' segment in SQL`);
      if (model.blank) blockers.push(`stacked_bar_100 has ${model.blank} row(s) with a blank category_field or series_field value`);
      if (model.duplicates) blockers.push(`stacked_bar_100 has ${model.duplicates} repeated (category, series) pair(s); each segment may appear once per bar - aggregate in SQL`);
      if (fieldExists(rows, spec.value_field)) {
        if (rows.some((row) => { const value = n(row[spec.value_field]); return value !== null && value < 0; })) blockers.push(`stacked_bar_100 value_field '${spec.value_field}' must not be negative; a share cannot be drawn as a negative width`);
        const offSum = model.entities
          .map((entity) => {
            const values = [...entity.cells.values()];
            return { entity: entity.key, complete: values.every((value) => value !== null), sum: values.reduce((total, value) => total + (value ?? 0), 0) };
          })
          .filter((item) => item.complete && Math.abs(item.sum - 100) > STACKED_SUM_TOLERANCE + 1e-9);
        if (offSum.length) blockers.push(`stacked_bar_100 bars must each sum to 100 +/- ${STACKED_SUM_TOLERANCE} (${offSum.slice(0, 3).map((item) => `${item.entity} sums to ${Number(item.sum.toFixed(4))}`).join(", ")}${offSum.length > 3 ? ", ..." : ""}); compute shares in SQL so that each row sums to 100`);
      }
      const knownSegments = new Set(model.segments);
      for (const [name, value] of [["highlight_segment", spec.highlight_segment], ["sort_segment", spec.sort_segment]]) {
        if (value !== undefined && !knownSegments.has(String(value))) blockers.push(`stacked_bar_100 ${name} '${value}' is not a value of series_field '${spec.series_field}'`);
      }
      if (Array.isArray(spec.segment_order)) {
        const unknown = spec.segment_order.filter((value) => !knownSegments.has(String(value)));
        if (unknown.length) blockers.push(`stacked_bar_100 segment_order lists ${unknown.map((value) => `'${value}'`).join(", ")}, not a value of series_field '${spec.series_field}'`);
      }
      const gaps = model.segments
        .map((segment) => ({ segment, bars: model.entities.filter((entity) => !entity.cells.has(segment)).map((entity) => entity.key) }))
        .filter((item) => item.bars.length > 0);
      if (gaps.length) blockers.push(`stacked_bar_100 ${gaps.slice(0, 3).map((item) => `segment '${item.segment}' has no row for ${item.bars.length} bar(s): ${item.bars.slice(0, 5).map((bar) => `'${bar}'`).join(", ")}${item.bars.length > 5 ? ", ..." : ""}`).join("; ")}${gaps.length > 3 ? "; ..." : ""}; if the source data records this segment as zero, select that row from the data; a zero written into the SQL (a constant, a VALUES list or a COALESCE) is a filled-in fact; otherwise fetch the missing rows (a missing segment is never filled in)`);
    }
  }
  if (spec.chart_type === "mirrored_bar" && Array.isArray(rows) && rows.length > 0) {
    // Two sides, one bar per (category, series, period): the drawing has no
    // way to show two values in one slot, so a duplicate row is a data error
    // rather than something to sum or pick from. Non-numeric, missing and
    // non-finite values are already blocked by the shared numericCount check
    // above; this adds the floor (a bar cannot be negative) and the shape
    // limits that keep the pyramid legible.
    const periodField = spec.period_field ? String(spec.period_field) : "";
    const periodPresent = Boolean(periodField) && fieldExists(rows, periodField);
    if (periodField && !periodPresent) blockers.push(`Field '${periodField}' is absent from query output`);
    if (fieldExists(rows, spec.category_field) && fieldExists(rows, spec.series_field)) {
      const categories = unique(rows.map((row) => row[spec.category_field]));
      const sides = unique(rows.map((row) => row[spec.series_field]));
      const periods = periodPresent ? unique(rows.map((row) => row[periodField])) : [];
      if (categories.length > 25) blockers.push(`mirrored_bar has ${categories.length} categories; maximum is 25 - merge bands in SQL`);
      else if (categories.length > 20) warnings.push(`mirrored_bar has ${categories.length} categories; above 20 the rows get thin and only every second label is shown - consider merging bands`);
      if (sides.length !== 2) blockers.push(`mirrored_bar series_field '${spec.series_field}' must have exactly 2 distinct values (one per side); found ${sides.length}`);
      if (periods.length > 2) blockers.push(`mirrored_bar period_field '${periodField}' has ${periods.length} distinct values; maximum is 2 (current and one comparison period)`);
      const cell = (row) => JSON.stringify([String(row[spec.category_field]), String(row[spec.series_field]), periodPresent ? String(row[periodField]) : ""]);
      const seen = new Set();
      let duplicates = 0;
      for (const row of rows) {
        const key = cell(row);
        if (seen.has(key)) duplicates += 1;
        seen.add(key);
      }
      if (duplicates) blockers.push(`mirrored_bar has ${duplicates} duplicate (category, series, period) row(s); each bar needs exactly one row`);
      if (fieldExists(rows, spec.value_field) && rows.some((row) => { const value = n(row[spec.value_field]); return value !== null && value < 0; })) {
        blockers.push(`mirrored_bar value_field '${spec.value_field}' must be >= 0; each side draws a magnitude from its own centre line`);
      }
      if (spec.left_series !== undefined && !sides.includes(String(spec.left_series))) blockers.push(`mirrored_bar left_series '${spec.left_series}' is not a value of '${spec.series_field}'`);
      if (spec.current_period !== undefined && !periods.includes(String(spec.current_period))) {
        blockers.push(periodPresent ? `mirrored_bar current_period '${spec.current_period}' is not a value of '${periodField}'` : "mirrored_bar current_period needs a period_field present in the query output");
      }
      const expected = categories.length * sides.length * Math.max(periods.length, 1);
      if (seen.size < expected) warnings.push(`mirrored_bar is missing ${expected - seen.size} (category, series, period) combination(s); those bars stay empty`);
    }
  }

  const taskFit = {
    ranking: new Set(["horizontal_bar", "dot", "diverging_bar"]),
    comparison: new Set(["horizontal_bar", "dot", "dumbbell", "slope", "diverging_bar", "small_multiples", "adjacency_matrix", "mirrored_bar"]),
    change: new Set(["line", "multi_line", "slope", "small_multiples", "streamgraph"]),
    distribution: new Set(["dot", "scatter", "heatmap", "strip_plot", "mirrored_bar"]),
    correlation: new Set(["scatter"]),
    part_to_whole: new Set(["sankey", "alluvial", "parallel_sets", "chord", "waffle", "treemap", "stacked_bar_100"]),
    spatial: new Set(["geo_flow_map", "cartographic_flow_map", "choropleth"]),
    flow: new Set(["sankey", "alluvial", "parallel_sets", "geo_flow_map", "cartographic_flow_map"]),
    relationship: new Set(["node_link", "adjacency_matrix", "chord"]),
    hierarchy: new Set(["hierarchy_tree"]),
    sequence: new Set(["timeline"]),
    process: new Set(["sankey", "alluvial", "hierarchy_tree", "timeline", "process_schematic"]),
  };
  if (taskFit[spec.reader_task] && !taskFit[spec.reader_task].has(spec.chart_type)) {
    warnings.push(`Chart type '${spec.chart_type}' is an unusual fit for reader task '${spec.reader_task}'`);
  }

  if (["sankey", "alluvial", "node_link", "adjacency_matrix", "chord"].includes(spec.chart_type)) {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.selfLoops) blockers.push(`${spec.chart_type} contains ${topo.selfLoops} self-loop edge(s)`);
    if (["sankey", "alluvial"].includes(spec.chart_type)) {
      if (topo.nodes.length > 36) blockers.push(`${spec.chart_type} has ${topo.nodes.length} nodes; maximum is 36 for an editorial frame`);
      if (topo.edges.length > 96) blockers.push(`${spec.chart_type} has ${topo.edges.length} links; maximum is 96`);
      if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push(`${spec.chart_type} does not allow negative flows`);
      const cyclicFlow = hasDirectedCycle(rows, spec.source_field, spec.target_field);
      if (cyclicFlow) blockers.push(`${spec.chart_type} requires an acyclic flow graph; for reciprocal origin-destination data, role-qualify nodes into separate source and target layers (for example origin:Asia -> destination:Asia) before considering another form`);
      const conservationMode = spec.flow_conservation ?? "warn";
      const tolerance = Number.isFinite(Number(spec.flow_tolerance)) ? Math.max(0, Number(spec.flow_tolerance)) : 0.02;
      const imbalances = flowImbalances(rows, spec.source_field, spec.target_field, spec.value_field).filter((item) => item.relative > tolerance);
      if (imbalances.length) {
        const summary = imbalances.slice(0, 4).map((item) => `${item.node} (${fmt(item.in, spec.unit)} in vs ${fmt(item.out, spec.unit)} out)`).join("; ");
        if (conservationMode === "strict") blockers.push(`Flow conservation failed beyond ${(tolerance * 100).toFixed(1)}% tolerance: ${summary}`);
        else if (conservationMode === "warn") warnings.push(`Flow conservation differs at intermediate node(s): ${summary}`);
      }
      if (!cyclicFlow) {
        const crossings = countFlowCrossings(rows, spec);
        if (crossings > 30) warnings.push(`${spec.chart_type} layout has an estimated ${crossings} link crossings; aggregate, reorder, or consider a matrix/parallel-set alternative`);
        else if (crossings > 10) notes.push(`${spec.chart_type} layout has an estimated ${crossings} link crossings`);
      }
      if (topo.edges.length > 42) warnings.push(`${spec.chart_type} has ${topo.edges.length} links; consider aggregation or an "Other" category`);
    }
    if (spec.chart_type === "node_link") {
      if (topo.nodes.length > 70) blockers.push(`node_link has ${topo.nodes.length} nodes; switch to adjacency_matrix or filter the graph`);
      if (topo.edges.length > 180) blockers.push(`node_link has ${topo.edges.length} edges; switch to adjacency_matrix or filter the graph`);
      if (topo.nodes.length > 20 && topo.density > 0.12) warnings.push(`Dense graph (${topo.nodes.length} nodes, density ${topo.density.toFixed(3)}) is likely more legible as adjacency_matrix`);
    }
    if (spec.chart_type === "adjacency_matrix") {
      if (topo.nodes.length > 80) blockers.push(`adjacency_matrix has ${topo.nodes.length} nodes; maximum is 80`);
      if (spec.value_field && numericCount(rows, spec.value_field) !== rows.length) blockers.push(`adjacency_matrix value_field '${spec.value_field}' must be numeric`);
    }
    if (spec.chart_type === "chord") {
      if (topo.nodes.length > 24) blockers.push(`chord has ${topo.nodes.length} nodes; maximum is 24 for readable labels`);
      if (topo.edges.length > 90) blockers.push(`chord has ${topo.edges.length} relationships; maximum is 90`);
      if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push("chord does not allow negative relationship weights");
      if (topo.nodes.length > 12 || topo.edges.length > 36) warnings.push(`chord is visually dense (${topo.nodes.length} nodes, ${topo.edges.length} links); consider adjacency_matrix for precise comparison`);
    }
  }
  if (spec.chart_type === "parallel_sets") {
    const dims = spec.dimension_fields ?? [];
    const totalCategories = dims.reduce((sum, field) => sum + unique(rows.map((row) => row[field])).length, 0);
    const maxCardinality = Math.max(...dims.map((field) => unique(rows.map((row) => row[field])).length), 0);
    if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push("parallel_sets does not allow negative weights");
    if (totalCategories > 42) blockers.push(`parallel_sets has ${totalCategories} category nodes across axes; maximum is 42`);
    if (maxCardinality > 14) blockers.push(`parallel_sets has an axis with ${maxCardinality} categories; maximum is 14`);
    if (rows.length > 160) blockers.push(`parallel_sets has ${rows.length} paths; aggregate identical categorical paths before rendering`);
    if (totalCategories > 28 || rows.length > 80) warnings.push("parallel_sets is dense; aggregate rare categories into a defensible Other group or split the story");
  }
  if (spec.chart_type === "geo_flow_map") {
    const coordinateFields = [spec.source_lat_field, spec.source_lon_field, spec.target_lat_field, spec.target_lon_field];
    if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push("geo_flow_map does not allow negative flow weights");
    for (const row of rows) {
      const slat=n(row[spec.source_lat_field]), slon=n(row[spec.source_lon_field]), tlat=n(row[spec.target_lat_field]), tlon=n(row[spec.target_lon_field]);
      if (slat !== null && (slat < -90 || slat > 90)) blockers.push(`geo_flow_map source latitude out of range: ${slat}`);
      if (tlat !== null && (tlat < -90 || tlat > 90)) blockers.push(`geo_flow_map target latitude out of range: ${tlat}`);
      if (slon !== null && (slon < -180 || slon > 180)) blockers.push(`geo_flow_map source longitude out of range: ${slon}`);
      if (tlon !== null && (tlon < -180 || tlon > 180)) blockers.push(`geo_flow_map target longitude out of range: ${tlon}`);
    }
    if (rows.length > 70) blockers.push(`geo_flow_map has ${rows.length} routes; maximum is 70 in one editorial frame`);
    if (rows.length > 30) warnings.push(`geo_flow_map has ${rows.length} routes; route overlap may obscure directional structure`);
    notes.push("geo_flow_map uses a schematic equirectangular coordinate frame without administrative boundary geometry; do not imply boundary precision");
  }
  if (spec.chart_type === "cartographic_flow_map") {
    if (rows.some((row) => (n(row[spec.value_field]) ?? -1) < 0)) blockers.push('cartographic_flow_map does not allow negative flow weights');
    const selected = selectRoutes(rows, spec);
    if (spec.flow_layer_field) {
      const layerValues = selected.map((row) => String(row[spec.flow_layer_field] ?? '').trim()).filter(Boolean);
      const layerSet = [...new Set(layerValues)];
      if (layerValues.length !== selected.length) blockers.push(`cartographic_flow_map flow_layer_field '${spec.flow_layer_field}' contains missing values`);
      if (layerSet.length > 6) blockers.push(`cartographic_flow_map has ${layerSet.length} flow layers; maximum is 6 in one composite`);
      if (Array.isArray(spec.flow_layer_order)) {
        const unknown = layerSet.filter((layer) => !spec.flow_layer_order.map(String).includes(layer));
        if (unknown.length) blockers.push(`flow_layer_order is missing layer(s): ${unknown.join(', ')}`);
      }
      const unitsByLayer = new Map();
      for (const row of selected) {
        const layer = String(row[spec.flow_layer_field] ?? '').trim();
        const unit = String(row[spec.flow_unit_field] ?? '').trim();
        if (!unit) blockers.push(`cartographic_flow_map layer '${layer || 'unknown'}' has no unit in '${spec.flow_unit_field}'`);
        else { if (!unitsByLayer.has(layer)) unitsByLayer.set(layer, new Set()); unitsByLayer.get(layer).add(unit); }
      }
      for (const [layer, units] of unitsByLayer) if (units.size > 1) blockers.push(`cartographic_flow_map layer '${layer}' mixes units; each layer needs one independent width scale`);
      if (spec.flow_period_field) {
        const periodsByLayer = new Map();
        for (const row of selected) {
          const layer = String(row[spec.flow_layer_field] ?? '').trim(), period = String(row[spec.flow_period_field] ?? '').trim();
          if (!period) blockers.push(`cartographic_flow_map layer '${layer || 'unknown'}' has no period in '${spec.flow_period_field}'`);
          else { if (!periodsByLayer.has(layer)) periodsByLayer.set(layer, new Set()); periodsByLayer.get(layer).add(period); }
        }
        for (const [layer, periods] of periodsByLayer) if (periods.size > 1) blockers.push(`cartographic_flow_map layer '${layer}' mixes reference periods; facet or separate the observations`);
      }
      notes.push(`layered cartographic flow: ${layerSet.length} independent layers; width scales reset within each layer and must not be compared across units`);
    }
    if (spec.aggregation_policy !== 'top_n' && rows.length > 80) blockers.push(`cartographic_flow_map has ${rows.length} routes; set aggregation_policy=top_n or split the story`);
    if (selected.length > 45) warnings.push(`cartographic_flow_map renders ${selected.length} routes; route density may exceed a static editorial frame`);
    if (["abstract_od","great_circle_reference"].includes(spec.geometry_semantics)) {
      for (const row of selected) {
        const coords=[n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),n(row[spec.target_lon_field]),n(row[spec.target_lat_field])];
        if (coords.some(v=>v===null)) blockers.push(`cartographic_flow_map ${spec.geometry_semantics} requires numeric source/target coordinates`);
        else if (coords[0] < -180 || coords[0] > 180 || coords[2] < -180 || coords[2] > 180 || coords[1] < -90 || coords[1] > 90 || coords[3] < -90 || coords[3] > 90) blockers.push('cartographic_flow_map coordinate is outside valid WGS84 longitude/latitude bounds');
      }
    } else {
      for (const row of selected) {
        if(spec.geometry_semantics==='observed_trajectory' && spec.trajectory_points_field){
          const points=parseTrajectoryPoints(row[spec.trajectory_points_field]);
          if(!points) blockers.push(`cartographic_flow_map row has invalid ${spec.trajectory_points_field} trajectory samples`);
          else {
            const lines=trajectoryLines(points); if(!validRouteGeometry(lines)) blockers.push('observed_trajectory trajectory samples do not form at least one valid line segment');
            if(points.length<4) warnings.push('observed_trajectory has fewer than four trajectory samples; route shape may be under-resolved');
          }
        } else {
          const lines=parseRouteGeometry(row[spec.route_geometry_field]);
          if (!validRouteGeometry(lines)) blockers.push(`cartographic_flow_map row has invalid ${spec.route_geometry_field} geometry for ${spec.geometry_semantics}`);
        }
      }
    }
    if (spec.geometry_semantics === 'abstract_od') notes.push('abstract_od route curves encode relationships only and must not be described as physical routes');
    if (spec.geometry_semantics === 'great_circle_reference') notes.push('great_circle_reference is a geodesic baseline, not a filed or observed route');
    const selectedBasemap = getBasemap(spec.basemap_id);
    notes.push(`cartographic basemap=${spec.basemap_id ?? BASEMAP_ID}; crs=${spec.geometry_crs}; projection=${spec.projection}; geometry_semantics=${spec.geometry_semantics}`);
    if(spec.extent_mode==='data'){const ex=cartographicDataExtent(spec,selected);if(ex){const span=Math.max(ex.east-ex.west,ex.north-ex.south);if(span<1)warnings.push(`cartographic extent spans only ${span.toFixed(3)} degrees; ${selectedBasemap?.label ?? spec.basemap_id} is too coarse for harbour/street-scale geographic context`);}}
  }
  if (spec.chart_type === "process_schematic") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.selfLoops) blockers.push(`process_schematic contains ${topo.selfLoops} self-loop edge(s)`);
    if (hasDirectedCycle(rows, spec.source_field, spec.target_field)) blockers.push("process_schematic requires an acyclic process graph");
    if (topo.nodes.length > 32) blockers.push(`process_schematic has ${topo.nodes.length} nodes; maximum is 32`);
    if (topo.edges.length > 48) blockers.push(`process_schematic has ${topo.edges.length} transitions; maximum is 48`);
    if (topo.nodes.length > 18) warnings.push("process_schematic is dense; split the mechanism into stages or separate panels");
  }
  if (spec.chart_type === "hierarchy_tree") {
    const h = hierarchyStats(rows, spec.node_field, spec.parent_field);
    if (h.duplicateIds) blockers.push(`hierarchy_tree has ${h.duplicateIds} duplicate node id(s)`);
    if (h.roots.length !== 1) blockers.push(`hierarchy_tree requires exactly one root; found ${h.roots.length}`);
    if (h.missingParents.length) blockers.push(`hierarchy_tree has ${h.missingParents.length} node(s) whose parent is absent`);
    if (h.cycle) blockers.push("hierarchy_tree contains a cycle");
    if (h.ids.length > 80) blockers.push(`hierarchy_tree has ${h.ids.length} nodes; maximum is 80`);
  }
  if (spec.chart_type === "timeline") {
    if (rows.length > 60) blockers.push("timeline has more than 60 events; aggregate or split the story");
    if (rows.some((row) => row[spec.x_field] === null || row[spec.x_field] === undefined || String(row[spec.x_field]) === "")) blockers.push(`timeline x_field '${spec.x_field}' contains missing values`);
  }
  if (spec.chart_type === "streamgraph") {
    if (rows.some((row) => (n(row[spec.value_field]) ?? 0) < 0)) blockers.push("streamgraph does not support negative values; use a diverging or baseline-aware form");
    const series = unique(rows.map((row) => row[spec.series_field]));
    if (series.length > 12) blockers.push(`streamgraph has ${series.length} series; maximum is 12`);
    if (series.length > 8) warnings.push(`streamgraph has ${series.length} series; direct interpretation may be difficult`);
  }
  if (spec.chart_type === "multi_line" && spec.series_field && fieldExists(rows, spec.series_field)) {
    const series = unique(rows.map((row) => row[spec.series_field]));
    if (series.length > 12) blockers.push(`multi_line has ${series.length} series; use small multiples or filter context`);
    else if (series.length > 6) warnings.push(`multi_line has ${series.length} series; small multiples may be more legible`);
  }
  if (["horizontal_bar", "dot", "dumbbell", "slope", "diverging_bar"].includes(spec.chart_type) && rows.length > 30) {
    warnings.push(`${spec.chart_type} has ${rows.length} rows; consider filtering to a defensible top/bottom set or small multiples`);
  }
  if (spec.chart_type === "heatmap") {
    const xs = unique(rows.map((r) => r[spec.x_field]));
    const ys = unique(rows.map((r) => r[spec.y_field]));
    if (xs.length * ys.length > 400) blockers.push("Heatmap exceeds 400 cells");
  }
  if (spec.chart_type === "strip_plot") {
    const stripLint = lintStripPlotSpec(spec, rows);
    blockers.push(...stripLint.blockers);
    warnings.push(...stripLint.warnings);
  }

  if (spec.title && /\b(latest|current|today|now)\b/i.test(spec.title) && spec.reference_period_field) {
    warnings.push("Title uses currentness language; verify the observation period is actually current");
  }

  return {
    schema_version: spec.schema_version === "1.0.0" ? "1.0.0" : "0.9.0",
    passed: blockers.length === 0,
    verification_mode: verificationMode,
    artifact_status: verificationMode === "verified" ? "VERIFIED" : "DRAFT",
    publishable: verificationMode === "verified",
    blockers,
    warnings,
    notes,
    data_hash: hashRows(rows),
    row_count: rows.length,
    ...(autoCategoryNames ? { category_names_resolution: autoCategoryNames.resolution } : {}),
  };
}

export function critiqueViz(spec, rows, lint = {}, svg = "") {
  const issues = [];
  const suggestions = [];
  let score = 100;
  const add = (severity, code, message, penalty, suggestion) => {
    issues.push({ severity, code, message });
    score -= penalty;
    if (suggestion) suggestions.push(suggestion);
  };

  if (lint.passed === false || (lint.blockers ?? []).length) add("blocker", "lint_not_passed", "Deterministic visualization lint has blocking failures.", 100, "Resolve every deterministic lint blocker before editorial review.");
  if (String(spec.title ?? "").length > 95) add("warning", "title_too_long", "Title is longer than 95 characters and may wrap heavily on mobile.", 8, "Shorten the title to one evidence-backed takeaway.");
  if (String(spec.subtitle ?? "").length > 180) add("warning", "subtitle_too_long", "Subtitle is too dense for a chart dek.", 5, "Move methodology details to the note and keep the subtitle focused on denominator and period.");
  const namedForEmphasis = titleNamedHighlightValues(spec, rows, spec.category_names ?? lint?.category_names_resolution?.mode);
  if (namedForEmphasis.length) {
    const hint = emphasisHint(spec, namedForEmphasis);
    add("warning", "title_names_unhighlighted", hint, HIGHLIGHT_HINT_CRITIC_PENALTY, hint);
  } else if ((spec.highlight_values ?? []).length === 0 && ["multi_line", "scatter", "slope", "horizontal_bar", "bar"].includes(spec.chart_type)) add("info", "no_visual_focus", "The chart has no explicit highlighted subject.", 6, "Highlight the series or entity that carries the governing claim when editorially justified.");
  if ((spec.highlight_values ?? []).length > 4) add("warning", "too_many_highlights", "Too many marks compete for attention.", 10, "Reduce highlights to one primary focus and a small number of comparisons.");
  if (spec.chart_type === "mirrored_bar" || spec.chart_type === "stacked_bar_100") {
    // mirrored_bar and stacked_bar_100 draw no annotations, so there is nothing to add.
  } else if (annotations(spec).length === 0 && rows.length >= 8 && spec.chart_type === "strip_plot") add("info", "no_annotation", "strip_plot draws no annotations; it labels its extreme points instead.", 4, "To name an outlier, set label_field and label_extremes; no annotation is needed.");
  else if (annotations(spec).length === 0 && rows.length >= 8) add("info", "no_annotation", "The visual has enough data density that a local annotation could reduce reader search cost.", 4, "Add one verified annotation to the most decision-relevant point if it improves comprehension.");
  if (annotations(spec).length > 4) add("warning", "annotation_density", "More than four annotations are likely to compete with the data.", 9, "Keep only annotations that identify, compare, summarize, or explain the governing claim.");
  if (spec.chart_type === "multi_line") {
    const count = spec.series_field ? unique(rows.map((r) => r[spec.series_field])).length : 1;
    if (count > 6) add("warning", "series_density", `${count} line series are difficult to scan even when lint permits them.`, 10, "Use small multiples or filter to defensible context series.");
    if (spec.direct_labels === false) add("info", "legend_dependency", "Direct labels are disabled for a multi-line chart.", 5, "Prefer end labels over a detached legend when space allows.");
  }
  if (spec.chart_type === "small_multiples") {
    const facets = spec.facet_field ? unique(rows.map((r) => r[spec.facet_field])).length : 0;
    if (facets > 8) add("warning", "facet_density", `${facets} facets may be too dense for one editorial frame.`, 8, "Filter or paginate facets, or group them into a defensible hierarchy.");
  }
  if (["sankey", "alluvial"].includes(spec.chart_type)) {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.edges.length > 35) add("warning", "flow_density", `${topo.edges.length} flow links create a high visual-search burden.`, 8, "Aggregate minor flows or expose a drill-down rather than showing every link.");
  }
  if (spec.chart_type === "node_link") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.nodes.length > 20 && topo.density > 0.1) add("warning", "network_density", "The node-link graph is dense enough that paths and labels may overlap.", 12, "Prefer adjacency_matrix for dense comparison tasks or filter to an ego network.");
  }
  if (spec.chart_type === "parallel_sets") {
    const axes = spec.dimension_fields ?? [];
    if (axes.length > 4) add("warning", "parallel_sets_axes", `${axes.length} categorical axes increase path tracing cost.`, 6, "Use four or fewer axes in the main frame and move extra dimensions to a follow-up view.");
  }
  if (spec.chart_type === "chord") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.nodes.length > 12 || topo.edges.length > 36) add("warning", "chord_density", "The chord diagram is dense enough that ribbon comparison becomes difficult.", 10, "Use adjacency_matrix when exact pairwise comparison matters more than cyclical structure.");
  }
  if (spec.chart_type === "treemap") {
    const groups = spec.group_field ? unique(rows.map((r) => r[spec.group_field])).length : 0;
    if (groups > 8) add("warning", "treemap_group_density", `${groups} groups is dense for a one-level treemap.`, 8, "Aggregate related groups or split into small multiples.");
    if (rows.length > 24 && !spec.other_threshold_pct) add("info", "treemap_no_other_bucket", "Many tiles with no other_threshold_pct is likely to produce many small, unlabeled slivers.", 4, "Set other_threshold_pct to bucket minor items into a single labeled Other tile.");
  }
  if (spec.chart_type === "geo_flow_map" && rows.length > 24) add("warning", "route_density", `${rows.length} routes compete on the same geographic frame.`, 8, "Aggregate minor routes or filter to the flows that carry the governing claim.");
  if (spec.chart_type === "cartographic_flow_map") {
    const selected=selectRoutes(rows,spec);
    if (selected.length > 35) add("warning","cartographic_route_density",`${selected.length} routes compete on the same cartographic frame.`,8,"Aggregate to top routes, facet by category, or separate overview from detail.");
    if (spec.geometry_semantics === "abstract_od" && !/(physical|tanker|pipeline|relationship|not\s+(?:actual\s+)?(?:ship\s+)?routes?)/i.test(String(spec.note ?? ""))) add("warning","od_route_disclosure","Abstract OD arcs require an explicit note that they are not physical routes.",8,"State that arcs encode relationships and do not trace physical movement.");
    if (["verified_route","observed_trajectory","network_constrained"].includes(spec.geometry_semantics) && !String(spec.route_provenance_note ?? "").trim()) add("blocker","route_provenance_missing","Physical or observed route geometry has no route provenance note.",100,"Bind route geometry to an explicit source and measurement description.");
    if(spec.extent_mode==="data"){const ex=cartographicDataExtent(spec,selected);if(ex){const adequacy=basemapAdequacy(spec.basemap_id,ex,spec.map_task??null);if(!adequacy.adequate)add("warning","basemap_detail_mismatch",`Basemap ${spec.basemap_id} is not qualified for ${adequacy.task}-scale interpretation (${adequacy.reason}).`,14,"Use a provenance-bound basemap whose registered detail class and extent cover this geographic task.");}}
  }
  if (spec.chart_type === "process_schematic") {
    const topo = topologyStats(rows, spec.source_field, spec.target_field);
    if (topo.nodes.length > 16) add("warning", "process_density", `${topo.nodes.length} process nodes create a high explanatory burden.`, 8, "Split the mechanism into stages or use progressive panels.");
  }
  if (spec.chart_type === "scatter" && spec.x_scale === "linear") {
    const xs = rows.map((r) => n(r[spec.x_field])).filter((v) => v !== null && v > 0);
    if (xs.length >= 6 && Math.max(...xs) / Math.min(...xs) > 30) add("warning", "heavy_tail_linear_axis", "The x variable spans more than 30x on a linear scale.", 9, "Consider x_scale='log' if ratios are meaningful for the reader task.");
  }
  if (svg && !/role="img"/.test(svg)) add("blocker", "svg_accessibility", "Rendered SVG is missing role=img.", 100, "Render accessible SVG markup.");
  if (svg && !/<desc\b/.test(svg)) add("blocker", "svg_description", "Rendered SVG is missing an accessible description.", 100, "Include a <desc> based on the verified alt text.");
  if (svg && !svg.includes(VIZ_STRINGS[vizLang(spec)].source.trim())) add("blocker", "source_missing", "Rendered SVG does not visibly include a source note.", 100, "Render the source attribution in the visual footer.");

  score = Math.max(0, Math.min(100, score));
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  return {
    schema_version: spec.schema_version === "1.0.0" ? "1.0.0" : "0.9.0",
    passed: blockers.length === 0 && score >= 75,
    score,
    issues,
    suggestions: [...new Set(suggestions)],
  };
}

// Wide-character bucket used to size text by character count: the union of
// this file's own CJK ranges and render QA's WIDE_CHAR_RE
// (runtime/pi/render_qa_geometry.mjs), which measures every character in
// this set at a full 1.0em regardless of the Latin per-glyph table it uses
// for everything else.
export function isWideChar(char) {
  return /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/u.test(char);
}

// Narrower than isWideChar: actual CJK ideograph/syllable ranges (Han,
// Hiragana/Katakana, Hangul, CJK compatibility ideographs), used only to
// decide whether a piece of agent-authored copy (title/subtitle) "looks
// Chinese" for the B1 language lint below. Deliberately excludes fullwidth
// punctuation and forms, which isWideChar counts for layout width but which
// are not evidence of CJK content on their own.
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u;
export function hasCjk(text) {
  return CJK_RE.test(String(text ?? ""));
}

// Language of a viz spec (B1): defaults to "en". Chosen by the model via the
// optional `language` viz-spec field; gates every string this renderer adds
// on its own (note/source prefixes, axis and legend words) so a zh chart
// never leaks English chrome, and an en chart never leaks Chinese chrome -
// the model's own title/subtitle copy is a separate, lint-checked concern.
export function vizLang(spec) {
  return spec?.language === "zh" ? "zh" : "en";
}

// Static strings this renderer adds on its own, one set per vizLang(spec).
// note/source are prefixes (sourceAttribution() strips any leading
// source-label prefix the input already carries before adding this one);
// logScale and group are standalone chrome words.
const VIZ_STRINGS = {
  en: {
    stripMedianKey: "Line: median",
    note: "Note: ", source: "Source: ", logScale: "log scale", indexBase: (x, b) => `${x} = ${b}`, rankOutside: (r) => `#${r}`, rankNone: "unranked", rankCutNote: (cut, shown, hidden) => `Showing only the ${shown} items that ranked in the top ${cut} in either period${hidden ? `; another ${hidden} were outside the top ${cut} in both periods and are not drawn` : ""}.`, rankEntered: "entered", rankLeft: "dropped out", noData: "No data", group: "Group: ",
    treemapOther: "Other", treemapOtherIncludes: "\u201COther\u201D includes: ", treemapUnlabeled: "Not labeled on the chart: ", treemapListSep: ", ",
    stackedRoundingNote: "Figures may not add up to 100% because of rounding",
  },
  zh: {
    stripMedianKey: "\u7AD6\u7EBF\uFF1A\u4E2D\u4F4D\u6570",
    note: "\u6CE8\uFF1A", source: "\u6570\u636E\u6765\u6E90\uFF1A", logScale: "\u5BF9\u6570\u523B\u5EA6", indexBase: (x, b) => `${x} = ${b}`, rankOutside: (r) => `\u7B2C${r}\u540D`, rankNone: "\u699C\u5916", rankCutNote: (cut, shown, hidden) => `\u53EA\u663E\u793A\u4EFB\u4E00\u671F\u8FDB\u5165\u524D ${cut} \u540D\u7684 ${shown} \u9879${hidden ? `\uFF1B\u53E6\u6709 ${hidden} \u9879\u4E24\u671F\u90FD\u4E0D\u5728\u524D ${cut} \u540D\uFF0C\u672A\u753B\u51FA` : ""}\u3002`, rankEntered: "\u65B0\u8FDB", rankLeft: "\u8DCC\u51FA", noData: "\u65E0\u6570\u636E", group: "\u5206\u7EC4\uFF1A",
    treemapOther: "\u5176\u4ED6", treemapOtherIncludes: "\u201C\u5176\u4ED6\u201D\u5305\u62EC\uFF1A", treemapUnlabeled: "\u56FE\u4E2D\u672A\u6807\u6CE8\uFF1A", treemapListSep: "\u3001",
    stackedRoundingNote: "\u56E0\u56DB\u820D\u4E94\u5165\uFF0C\u5404\u9879\u76F8\u52A0\u53EF\u80FD\u4E0D\u7B49\u4E8E100%",
  },
};

// Text "width" in fit-budget units: 1 per ordinary code point, 2 per wide
// (isWideChar) code point. For text with no wide characters this equals
// text.length exactly, so every existing Latin call site keeps its meaning.
export function textUnits(text) {
  let units = 0;
  for (const char of Array.from(String(text ?? ""))) units += isWideChar(char) ? 2 : 1;
  return units;
}

// Longest code-point prefix of `text` whose textUnits does not exceed
// maxUnits. Always keeps at least one code point when text is non-empty,
// even one whose own cost exceeds maxUnits, so a caller appending "\u2026" never
// ends up with just the ellipsis.
export function sliceUnits(text, maxUnits) {
  const chars = Array.from(String(text ?? ""));
  let units = 0;
  let count = 0;
  for (const char of chars) {
    const width = isWideChar(char) ? 2 : 1;
    if (count > 0 && units + width > maxUnits) break;
    units += width;
    count++;
  }
  return chars.slice(0, count).join("");
}

// Kinsoku shori (line-breaking punctuation rules): characters that must
// never start a line (closing brackets/quotes, sentence and list
// punctuation, small/repeat marks) and characters that must never end one
// (the matching opening brackets/quotes). Spelled out as explicit code
// points rather than the literal glyphs, since several of these have
// visually near-identical Latin/CJK/fullwidth siblings. The curly quotes
// (\u2018 \u2019 \u201C \u201D) are Latin glyphs in this codebase's
// Arial/Helvetica stack - not wide - but still take part in kinsoku.
const NO_START = new Set([
  "\uFF0C", "\u3002", "\u3001", "\uFF0E", "\uFF1A", "\uFF1B", "\uFF01", "\uFF1F",
  "\uFF09", "\uFF3D", "\uFF5D", "\u300D", "\u300F", "\u3011", "\u300B", "\u3009",
  "\u3015", "\u3017", "\u3019", "\u301B", "\u2019", "\u201D", "\u2026", "\u2025",
  "\u00B7", "\u30FB", "\uFF5E", "\u30FC", "\u3005",
]);
const NO_END = new Set([
  "\uFF08", "\uFF3B", "\uFF5B", "\u300C", "\u300E", "\u3010", "\u300A", "\u3008",
  "\u3014", "\u3016", "\u3018", "\u301A", "\u2018", "\u201C",
]);

function textTokens(text) {
  const tokens = [];
  let latin = "";
  let pendingSpace = false;
  const flush = () => {
    if (latin) { tokens.push({ text: latin, spaceBefore: pendingSpace }); latin = ""; pendingSpace = false; }
  };
  for (const char of Array.from(String(text ?? ""))) {
    if (/\s/u.test(char)) { flush(); pendingSpace = true; continue; }
    if (isWideChar(char)) {
      flush();
      tokens.push({ text: char, spaceBefore: pendingSpace });
      pendingSpace = false;
      continue;
    }
    latin += char;
  }
  flush();
  // Kinsoku merge: fold a token that must not start a line into the
  // previous token, and fold a token that follows a token that must not end
  // a line into that previous token too - in both cases only when there was
  // no real whitespace between them. This runs once over the already
  // tokenised list (rather than during tokenising) so a chain of merges can
  // see the previous token's current, possibly already-merged, last
  // character.
  const merged = [];
  for (const token of tokens) {
    const prev = merged[merged.length - 1];
    if (prev && !token.spaceBefore) {
      const firstChar = token.text[0];
      const prevLastChar = prev.text[prev.text.length - 1];
      if (NO_START.has(firstChar) || NO_END.has(prevLastChar)) {
        prev.text += token.text;
        continue;
      }
    }
    merged.push({ ...token });
  }
  return merged;
}

// CJK widow control: a wrapped block whose last line holds exactly one wide
// (CJK) character - optionally followed by trailing punctuation kinsoku
// forbids from starting a line, e.g. "字" or "字。" or "字」" - reads as an
// orphaned character. Move the previous line's last token down onto it, but
// only when that token starts with a wide character and the previous line
// keeps at least two wide characters of its own. Moving a whole token, not
// a character, keeps the kinsoku pairs textTokens glues together ("球，",
// "（金"), so the last line never starts with closing punctuation and the
// previous line never ends with an opening bracket. Only the boundary
// between the last two lines changes, and character order is preserved.
// Latin-only input has no wide character, so it is returned unchanged.
function controlWidow(lines) {
  if (lines.length < 2) return lines;
  const lastIndex = lines.length - 1;
  const last = Array.from(lines[lastIndex]);
  let coreEnd = last.length;
  while (coreEnd > 1 && NO_START.has(last[coreEnd - 1])) coreEnd--;
  if (coreEnd !== 1 || !isWideChar(last[0])) return lines; // not a widow
  const prevLine = lines[lastIndex - 1];
  const moved = textTokens(prevLine).at(-1)?.text ?? "";
  if (!moved || !prevLine.endsWith(moved) || !isWideChar(Array.from(moved)[0])) return lines;
  const rest = prevLine.slice(0, prevLine.length - moved.length).trimEnd();
  if (Array.from(rest).filter((ch) => isWideChar(ch)).length < 2) return lines; // would leave prev with < 2 wide chars
  return [...lines.slice(0, lastIndex - 1), rest, moved + lines[lastIndex]];
}

export function wrapText(text, maxChars) {
  const tokens = textTokens(text);
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const separator = token.spaceBefore && line ? " " : "";
    let candidate = line + separator + token.text;
    if (textUnits(candidate) <= maxChars) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    let remaining = token.text;
    while (textUnits(remaining) > maxChars) {
      const chunk = sliceUnits(remaining, maxChars);
      lines.push(chunk);
      remaining = remaining.slice(chunk.length);
    }
    line = remaining;
  }
  if (line) lines.push(line);
  return controlWidow(lines.length ? lines : [""]);
}

// Every character that must never *start* a line (NO_START, above) is, by
// the same kinsoku logic, always a typographically safe and natural place
// to *end* one - closing punctuation, sentence marks, closing brackets and
// quotes all read as a clause boundary. Reused as-is rather than declaring a
// second, narrower punctuation set.
function endsWithPreferredBreak(text) {
  const chars = Array.from(text);
  return chars.length > 0 && NO_START.has(chars[chars.length - 1]);
}

function joinTokenLine(tokens) {
  let out = "";
  tokens.forEach((token, i) => {
    out += (token.spaceBefore && i > 0 ? " " : "") + token.text;
  });
  return out;
}

// Recursively split `tokens` into exactly `lineCount` lines, each within
// maxChars: for the first line, scan every feasible boundary (one that
// still leaves the remainder splittable into the rest of the budget) and
// choose, in order of preference, (1) the boundary ending on a preferred
// break character closest to an even split, else (2) whichever feasible
// boundary is closest to an even split ("balanced", rather than always
// maximising the first line the way plain greedy fill does). Returns null
// if no feasible split exists, so the caller can fall back to plain greedy.
function splitHeadlineTokens(tokens, maxChars, lineCount) {
  if (lineCount <= 1) return [tokens];
  const totalUnits = tokens.reduce((sum, t, i) => sum + textUnits(t.text) + (t.spaceBefore && i > 0 ? 1 : 0), 0);
  const target = totalUnits / lineCount;
  let bestBoundary = -1;
  let bestIsPreferred = false;
  let bestBalanceDelta = Infinity;
  let acc = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const sep = token.spaceBefore && i > 0 ? 1 : 0;
    const next = acc + sep + textUnits(token.text);
    if (next > maxChars) break; // this and every later boundary overflow the line
    acc = next;
    const remainingCount = tokens.length - (i + 1);
    if (remainingCount === 0) continue; // would leave nothing for the other line(s)
    const remainingUnits = totalUnits - acc;
    if (remainingUnits / (lineCount - 1) > maxChars) continue; // rest provably can't fit
    const preferred = endsWithPreferredBreak(token.text);
    const balanceDelta = Math.abs(acc - target);
    if (preferred && !bestIsPreferred) {
      bestBoundary = i; bestIsPreferred = true; bestBalanceDelta = balanceDelta;
    } else if (preferred === bestIsPreferred && balanceDelta < bestBalanceDelta) {
      bestBoundary = i; bestBalanceDelta = balanceDelta;
    }
  }
  if (bestBoundary < 0) return null;
  const rest = splitHeadlineTokens(tokens.slice(bestBoundary + 1), maxChars, lineCount - 1);
  if (!rest) return null;
  return [tokens.slice(0, bestBoundary + 1), ...rest];
}

// Headline-only line-breaking (house style, CJK titles only - see the
// isWideChar guard below): page titles, section headers and chart titles
// reported a defect where plain greedy fill (wrapText, above) always crams
// as much as possible onto the earlier line(s), which both (a) frequently
// breaks mid-clause where a comma or full stop sits just a few characters
// earlier, and (b) can strand a very short, unbalanced remainder on the
// last line. wrapHeadline keeps wrapText's exact line *count* (so header
// heights computed from that count never change) but re-chooses *where*
// each line breaks: prefer a break right after a full-width punctuation
// mark when the remaining line(s) still fit; otherwise balance the lines'
// widths instead of maximising the first; and never leave 3 characters or
// fewer on the very last line, borrowing the previous line's last token
// down exactly the way controlWidow already borrows one for a widow.
// Legacy, and any Latin-only headline, is unaffected: returns wrapText's
// own output unchanged, byte for byte.
export function wrapHeadline(text, maxChars) {
  const plain = wrapText(text, maxChars);
  if (plain.length < 2 || !Array.from(String(text ?? "")).some(isWideChar)) return plain;
  const tokens = textTokens(text);
  const grouped = splitHeadlineTokens(tokens, maxChars, plain.length);
  const groupedLines = grouped ? grouped.map(joinTokenLine) : null;
  let result = groupedLines && groupedLines.every((l) => textUnits(l) <= maxChars) ? groupedLines : plain;
  while (result.length >= 2 && Array.from(result[result.length - 1]).length <= 3) {
    const prevIndex = result.length - 2;
    const prevTokens = textTokens(result[prevIndex]);
    if (prevTokens.length < 2) break; // nothing left to borrow without emptying the line
    const moved = prevTokens.pop();
    const newPrev = joinTokenLine(prevTokens);
    const newLast = (moved.spaceBefore ? " " : "") + moved.text + result[result.length - 1];
    if (textUnits(newLast) > maxChars) break; // would overflow - accept the short last line
    result = [...result.slice(0, prevIndex), newPrev, newLast];
  }
  return result;
}

// House-style-only wrapper shared by frame()/mobileFrame()'s own header-
// height math and by svgTextLines's `headline` option, so a title's
// reserved header space always matches what actually gets drawn. Legacy,
// and any call that never asks for headline mode, always uses plain
// wrapText - byte-for-byte today's behaviour.
function headlineWrap(text, maxChars, headline) {
  return headline && HOUSE_STYLE_ACTIVE ? wrapHeadline(text, maxChars) : wrapText(text, maxChars);
}

function svgTextLines(parts, text, x, y, opts = {}) {
  const lines = headlineWrap(text, opts.maxChars ?? 90, opts.headline ?? false);
  const size = opts.size ?? 14;
  const lineHeight = opts.lineHeight ?? Math.round(size * 1.35);
  const fill = opts.fill ?? PALETTE.ink;
  const weight = opts.weight ?? 400;
  const anchor = opts.anchor ?? "start";
  const font = opts.font ?? FONT_SANS;
  lines.forEach((line, index) => {
    parts.push(`<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(line)}</text>`);
  });
  return lines.length * lineHeight;
}

// The width the desktop-family renderers lay out in. 1040 is the desktop
// chart; renderVizCompactSvg temporarily sets it to COMPACT_VIEW_W so the
// same renderers re-lay the chart out for an 8-of-12-column slot (text keeps
// its house-style pixel size; nothing is scaled). Every width-derived value
// below equals its old literal at 1040, so desktop output is unchanged.
const DESKTOP_VIEW_W = 1040;
let LAYOUT_W = DESKTOP_VIEW_W;
// Characters per wrapped line, scaled to the plot's text width (932 at desktop).
const wrapChars = (chars) => (LAYOUT_W === DESKTOP_VIEW_W ? chars : Math.max(16, Math.floor((chars * (LAYOUT_W - 108)) / 932)));

function frame(spec, bodyHeight, minHeight = 420) {
  const width = LAYOUT_W;
  const titleLines = headlineWrap(spec.title, wrapChars(62), true).length;
  const dekLines = spec.subtitle ? wrapText(spec.subtitle, wrapChars(105)).length : 0;
  const header = 32 + titleLines * 34 + dekLines * 21 + 22;
  const footer = 70 + (spec.note ? wrapText(spec.note, wrapChars(120)).length * 16 : 0);
  const height = Math.max(minHeight, header + bodyHeight + footer);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="viz-title viz-desc" data-viewport="${width === DESKTOP_VIEW_W ? "desktop" : "compact"}">`];
  parts.push(`<title id="viz-title">${esc(spec.title)}</title>`);
  parts.push(`<desc id="viz-desc">${esc(spec.alt)}</desc>`);
  parts.push(`<rect width="${width}" height="${height}" fill="${PAPER}"/>`);
  let y = 38;
  y += svgTextLines(parts, spec.title, 54, y, { size: 28, lineHeight: 34, weight: 700, maxChars: wrapChars(62), font: FONT_TITLE, headline: true });
  if (spec.subtitle) y += svgTextLines(parts, spec.subtitle, 54, y + 2, { size: 15, lineHeight: 21, fill: PALETTE.muted, maxChars: wrapChars(105) });
  y += 14;
  const bodyTop = y;
  const bodyBottom = height - footer;
  return {
    width,
    height,
    parts,
    bodyTop,
    bodyBottom,
    footerTop: height - footer + 15,
    annotationLayout: createAnnotationLayout({ left: 54, right: width - 54, top: bodyTop + 4, bottom: bodyBottom - 8 }),
  };
}

function addFooter(parts, spec, footerTop) {
  const t = VIZ_STRINGS[vizLang(spec)];
  parts.push(`<line x1="54" y1="${footerTop - 16}" x2="${LAYOUT_W - 54}" y2="${footerTop - 16}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  let y = footerTop;
  if (spec.note) y += svgTextLines(parts, `${t.note}${spec.note}`, 54, y, { size: 12, lineHeight: 16, fill: PALETTE.muted, maxChars: wrapChars(120) });
  svgTextLines(parts, sourceAttribution(spec.source_note, vizLang(spec)), 54, y + 3, { size: 12, lineHeight: 16, fill: PALETTE.muted, maxChars: wrapChars(120) });
}

// Strips any leading source-label prefix the input data already carries
// (in either language) so we never double it up behind our own prefix,
// e.g. source_note:"来源：UN Comtrade" must not render as "数据来源：来源：UN Comtrade".
const GENERIC_SOURCE_PREFIX_RE = /^(?:数据来源|资料来源|来源|Sources?)\s*[:：]\s*/i;

function sourceAttribution(value, lang = "en") {
  const note = String(value ?? '').trim().replace(GENERIC_SOURCE_PREFIX_RE, '');
  const t = VIZ_STRINGS[lang];
  return `${t.source}${note}`;
}

function extent(values, includeZero = false) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { min -= 1; max += 1; }
  const pad = includeZero ? 0 : (max - min) * 0.08;
  return [min - pad, max + pad];
}

// B2: chart types whose renderer draws a value-axis reference_line
// annotation. Kept as a single source of truth for both lintVizSpec's
// chart_type gate and the render functions' own guards.
const REFERENCE_LINE_CHART_TYPES = new Set(["horizontal_bar", "dot", "dumbbell", "small_multiples"]);

// E: chart types whose renderer draws a category_field range_bracket
// annotation - the same single-source-of-truth role REFERENCE_LINE_CHART_TYPES
// plays for reference_line, shared by lintVizSpec's chart_type gate and
// renderHorizontal's own defensive guard.
const RANGE_BRACKET_CHART_TYPES = new Set(["horizontal_bar", "dot"]);

// What the unmapped-value blocker tells the author to use, per mode. The
// worldbank sentence is pinned byte-for-byte (scripts/test_range_bracket.mjs).
const UNMAPPED_NAME_GUIDANCE = {
  worldbank: "the exact World Bank English name",
  iso3: "the exact ISO3 economy/aggregate code (filter other aggregate rows such as OWID_* regions and income groups out in SQL)",
  iso2: "the exact ISO 3166-1 alpha-2 economy code (filter aggregate rows such as EU27_2020 or EA20 out in SQL)",
  iso4217: "the exact ISO 4217 currency code",
};

// Zh-naming-policy rule 7: the chart types whose marks are peers of one another
// (a ranking, a comparison, a share, a labelled point), so an aggregate row (the
// World, a region, an income group) among economies would be ranked, compared or
// drawn as if it were one. lintVizSpec blocks a name field that resolves to a
// mix of aggregates and economies on exactly these types, keyed on the entry's
// kind and never on a code prefix (OWID_KOS is Kosovo). One chart type per line,
// so a later form is a one-line add. multi_line, small_multiples, sankey and
// alluvial are left out on purpose: a World series, panel or node is a
// reference there. choropleth is left out because lintChoroplethSpec already
// blocks every aggregate by kind.
const AGGREGATE_MIX_BLOCKED_CHART_TYPES = new Set([
  "horizontal_bar",
  "dot",
  "dumbbell",
  "slope",
  "diverging_bar",
  "waffle",
  "treemap",
  "strip_plot",
  "stacked_bar_100",
  "scatter",
]);

// E: the viz-spec field category_names localizes, keyed by chart_type -
// category_field for the five ranking/comparison forms, waffle, strip_plot and stacked_bar_100, facet_field for
// small_multiples (each panel's title is a name), series_field for
// multi_line (each series' direct label is a name), label_field for scatter
// (each highlighted point's direct label is a name). Returns null for any
// other chart_type, which lintVizSpec turns into a blocker and the
// renderers never call for. Shared by lintVizSpec's unmapped-value check
// and every renderer's resolveEconomyDisplayName call so the two can never
// key off different fields.
const CATEGORY_NAMES_FIELD_KEY = new Map([
  ["horizontal_bar", "category_field"],
  ["dot", "category_field"],
  ["dumbbell", "category_field"],
  ["slope", "category_field"],
  ["diverging_bar", "category_field"],
  ["waffle", "category_field"],
  ["choropleth", "category_field"],
  ["treemap", "category_field"],
  ["strip_plot", "category_field"],
  ["stacked_bar_100", "category_field"],
  ["small_multiples", "facet_field"],
  ["multi_line", "series_field"],
  ["scatter", "label_field"],
]);

function categoryNamesField(spec) {
  const key = CATEGORY_NAMES_FIELD_KEY.get(spec.chart_type);
  return key ? spec[key] : null;
}

// sankey and alluvial name their nodes from TWO row fields (every node id
// comes from source_field or target_field, with the internal node-type prefix
// stripped by stripNodePrefix) and renderSankey already resolves each node
// name through category_names, so category_names is legal there too. They are
// explicit-only: no auto-resolution, because source/target field names carry no
// economy or currency token to key off.
const CATEGORY_NAMES_NODE_CHART_TYPES = new Set(["sankey", "alluvial"]);

// Every row field whose values category_names localizes on this chart type:
// the single name field of the one-field forms, source_field and target_field
// of the flow forms. null when category_names is not supported on the chart
// type; an empty list when the type supports it but the field is not set.
function categoryNameFields(spec) {
  if (CATEGORY_NAMES_NODE_CHART_TYPES.has(spec.chart_type)) return [spec.source_field, spec.target_field].filter(Boolean);
  const field = categoryNamesField(spec);
  if (field === null) return null;
  return field ? [field] : [];
}

// The raw values of one name field, as the renderer resolves them: node ids
// have their internal prefix stripped first.
function nameFieldValues(spec, rows, field) {
  const values = rows.map((row) => row[field]);
  return CATEGORY_NAMES_NODE_CHART_TYPES.has(spec.chart_type) ? values.map(stripNodePrefix) : values;
}

// The distinct values of one name field the way lint counts them: trimmed, with the empty ones dropped.
function distinctNameValues(spec, rows, field) {
  return [...new Set(nameFieldValues(spec, rows, field).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

// Diagnosis P6: category_names is optional in the spec, so a chart whose name
// column already holds exact World Bank English names (or ISO3 codes) used to
// print the raw English text on a zh page unless the author remembered to set
// it. When the field is unset, the chart type supports it and EVERY distinct
// value resolves verbatim in one vendored table, resolve it that way: returns a
// shallow-cloned spec carrying the mode plus a record of which mode was used
// (kept in the lint report for audit). Any value that does not match keeps the
// spec untouched (non-economy categories such as companies or provinces must
// never be re-labelled), and an explicitly declared category_names is never
// overridden. Choropleth is excluded: it requires an explicit declaration and
// that blocker must stay visible.
// Values alone never prove a column holds economies (Georgia, Jordan or Chad
// are also states, people and institutions), so auto-resolution additionally
// requires the FIELD NAME to carry a generic economy token (whole-token match
// after splitting on non-alphanumerics and camelCase boundaries) - or, for
// ISO 4217 currency codes, a generic currency token. iso2 is never inferred:
// two-letter values (US state codes, country-subdivision codes ...) are too
// ambiguous, so it stays explicit-only - and even declared (or suggested by the
// zh blocker) it needs the same field-name signal: CA, GA, IN and PA are Canada,
// Gabon, India and Panama as ISO 3166-1 alpha-2 codes and California, Georgia,
// Indiana and Pennsylvania as state codes, so only a column whose name says
// country, economy, iso2 or geo (Eurostat's column) may be read as countries.
const ECONOMY_FIELD_TOKENS = new Set(["country", "countries", "economy", "economies", "nation", "nations", "geo", "iso2", "iso3", "iso3c", "国家", "经济体", "国别"]);
const CURRENCY_FIELD_TOKENS = new Set(["currency", "currencies", "cur", "ccy", "货币", "币种"]);
const AUTO_ECONOMY_NAME_MODES = Object.freeze(["worldbank", "iso3"]);

function fieldNameTokens(field) {
  return String(field ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function fieldNameSignalsEconomy(field) {
  return fieldNameTokens(field).some((t) => ECONOMY_FIELD_TOKENS.has(t));
}

function fieldNameSignalsCurrency(field) {
  return fieldNameTokens(field).some((t) => CURRENCY_FIELD_TOKENS.has(t));
}

// Whether the field name carries the token family a mode belongs to.
function fieldNameSignalsMode(field, mode) {
  return CURRENCY_NAME_MODES.includes(mode) ? fieldNameSignalsCurrency(field) : fieldNameSignalsEconomy(field);
}

// `signalled`: the field name carries the token family of the chosen mode (the
// mode a signalled field resolves to wins when several tables match, e.g. the
// codes BTN/MKD/SLE are both ISO3 and ISO 4217).
function economyValueMatch(spec, rows) {
  if (!spec || spec.category_names !== undefined || spec.chart_type === "choropleth") return null;
  const field = categoryNamesField(spec);
  if (!field || !fieldExists(rows, field)) return null;
  const values = unique(rows.map((row) => row[field]));
  if (!values.length) return null;
  const matching = [...AUTO_ECONOMY_NAME_MODES, ...CURRENCY_NAME_MODES].filter((mode) => unmappedEconomyNameValues(values, mode).length === 0);
  if (!matching.length) return null;
  const signalled = matching.find((mode) => fieldNameSignalsMode(field, mode));
  return { field, mode: signalled ?? matching[0], values: values.length, signalled: signalled !== undefined };
}

// Warning text for a column whose values all match but whose name gives no
// economy (or currency) signal (so nothing was auto-resolved); null otherwise.
function unsignaledEconomyWarning(spec, rows) {
  const match = economyValueMatch(spec, rows);
  if (!match || match.signalled) return null;
  if (CURRENCY_NAME_MODES.includes(match.mode)) {
    return `category field '${match.field}' values all match ISO 4217 currency codes, but the field name does not say they are currencies, so names are not auto-resolved; if they are currencies, declare category_names explicitly`;
  }
  return `category field '${match.field}' values all match World Bank names, but the field name does not say they are economies, so names are not auto-resolved; if they are economies, declare category_names explicitly`;
}

export function resolveAutoCategoryNames(spec, rows) {
  const match = economyValueMatch(spec, rows);
  if (!match || !match.signalled) return null;
  return { spec: { ...spec, category_names: match.mode }, resolution: { field: match.field, mode: match.mode, source: "auto", values: match.values } };
}

// The localized name a zh chart prints for a name-field value, as a lookup for
// a caller that writes text about the chart outside the renderer (the inline
// claim fill in newsroom.ts). It answers with the SAME table, mode and
// fields the renderer and lint use: the mode is the spec's category_names
// (explicit, else the one resolveAutoCategoryNames picks), the fields are
// categoryNameFields(spec), and a value is localized only on an exact table
// match - never translated, guessed or matched by text. Returns null when the
// chart would print no localized name (not a zh chart, no mode, a chart type
// without name fields); otherwise { mode, fields, display(column, value) }
// where display() is the zh name for a string value of a name-field column and
// null for any other column, any non-string value and any value the table
// cannot resolve (the caller then keeps the raw value). It only reads: the
// raw value stays the evidence, the localized name is how it is shown.
export function chartNameDisplay(spec, rows) {
  if (vizLang(spec) !== "zh") return null;
  const mode = spec.category_names !== undefined ? spec.category_names : resolveAutoCategoryNames(spec, rows)?.spec.category_names;
  if (!mode) return null;
  const fields = categoryNameFields(spec);
  if (!fields?.length) return null;
  const nodeNames = CATEGORY_NAMES_NODE_CHART_TYPES.has(spec.chart_type);
  return {
    mode,
    fields,
    display(column, value) {
      if (!fields.includes(column) || typeof value !== "string") return null;
      const entry = economyEntryFor(nodeNames ? stripNodePrefix(value) : value, mode);
      return entry ? entry.zh : null;
    },
  };
}

// zh name-field lint (blocker): a zh chart none of whose name values contains a
// CJK character, while the values read as economies or currencies the vendored
// tables can name, would print English names or bare codes to a Chinese
// reader. Returns the best-matching table for the column, or null when the
// column is not recognizable: fewer than 2 distinct values match, or fewer than
// half of them do. `values` are the column's distinct trimmed non-empty
// strings. Every mode is tried (exact World Bank English names, ISO3, ISO2,
// ISO 4217); the one matching the most values wins, a tie goes to the mode
// whose token family the field name carries (currency tokens -> iso4217,
// economy tokens -> the economy modes), then to the fixed mode order. A
// two-letter value can only match iso2; a three-letter value can be an ISO3
// code or a currency code (BTN, MKD and SLE are both), which is exactly what
// the match-count comparison and the signal tie-break settle.
// Recognition only decides whether to block; it never resolves a name. So iso2
// is a candidate whatever the field name: a column of codes the table knows
// (FR, DE, PL) prints as raw codes on a Chinese page, and it must block there
// too. What the field name decides is how the column is READ: two letters match
// too many state and subdivision codes to read a bare column as countries, so
// only a column whose name carries an economy token is told to set
// category_names='iso2'; any other column is told to rename the column first
// (zhNameFieldBlocker), the same rule iso2NeedsCountryColumnBlocker applies to
// a declared category_names='iso2'.
// A column whose NAME says it holds economies or currencies (an economy or
// currency token, as for auto-resolution) is held to more than recognition: on
// a zh chart with no category_names, one value without CJK characters blocks
// (declaredNameFieldBlocker), whatever the match count. The column declared
// what it holds, so a code the tables do not know, an aggregate outside the
// policy table or a name typed by hand cannot be shown as it is; only a column
// of Chinese values from a Chinese source passes. Columns whose names say
// nothing keep the thresholds above.
const ZH_NAME_MODE_TEXT = {
  worldbank: { match: "exact World Bank English names", none: "World Bank economy name or code", readers: "English names", column: "ISO3 code column", target: "iso3", alt: " (category_names='worldbank' also resolves these exact names)" },
  iso3: { match: "ISO3 codes", none: "World Bank economy name or code", readers: "raw codes", column: "ISO3 code column", target: "iso3", alt: "" },
  iso2: { match: "ISO 3166-1 alpha-2 codes", none: "World Bank economy name or code", readers: "raw codes", column: "ISO2 code column", target: "iso2", alt: "" },
  iso4217: { match: "ISO 4217 currency codes", none: "ISO 4217 currency code", readers: "bare currency codes", column: "ISO 4217 currency code column", target: "iso4217", alt: "" },
};

function recognizableNameColumn(values, fields, { threshold = true } = {}) {
  if (threshold && values.length < 2) return null;
  const candidates = CATEGORY_NAME_MODES.map((mode, order) => ({
    mode,
    order,
    matched: values.length - unmappedEconomyNameValues(values, mode).length,
    signalled: fields.some((field) => fieldNameSignalsMode(field, mode)),
  }));
  candidates.sort((a, b) => b.matched - a.matched || Number(b.signalled) - Number(a.signalled) || a.order - b.order);
  const best = candidates[0];
  return !threshold || (best.matched >= 2 && best.matched * 2 >= values.length) ? best : null;
}

// `cjk`: the distinct values that do contain CJK characters, which only the
// declared-column rule can have (the older rule needs every value without).
function zhNameFieldBlocker(fields, values, best, { cjk = [] } = {}) {
  const text = ZH_NAME_MODE_TEXT[best.mode];
  const unmapped = new Set(unmappedEconomyNameValues(values, best.mode));
  const examples = (list) => list.slice(0, 3).map((value) => `'${value}'`).join(", ");
  const fieldText = fields.map((field) => `'${field}'`).join(" and ");
  const plural = fields.length > 1 ? "s" : "";
  // The column name says they are economies or currencies, which only stands against recognized values: when no value is
  // recognized, the hedge stays.
  const notNames = best.signalled && best.matched > 0 ? "" : "; if these values are not economies or currencies, label them in Chinese instead";
  const matches = best.matched > 0
    ? `match ${text.match} (best mode '${best.mode}': ${best.matched} of ${values.length} distinct values, e.g. ${examples(values.filter((value) => !unmapped.has(value)))})`
    : `match no ${text.none} (e.g. ${examples(values.filter((value) => !hasCjk(value)))})`;
  const chinese = cjk.length ? `${cjk.length} of them ${cjk.length > 1 ? "contain" : "contains"} CJK characters (e.g. ${examples(cjk)})` : "none contains CJK characters";
  const readers = `${best.matched > 0 ? text.readers : "the raw values"}${cjk.length ? " for the rest" : ""}`;
  const head = `zh chart's ${fieldText} values ${matches} and ${chinese}, so readers would see ${readers}`;
  // Two-letter codes are also US states and subdivisions, so a column whose name does not say countries cannot simply be
  // told to set category_names='iso2' (iso2NeedsCountryColumnBlocker would refuse it): the rename comes first.
  if (best.mode === "iso2" && !best.signalled) {
    return `${head}; two-letter codes are also US states, provinces and other subdivisions; if these values are countries, rename ${plural ? "the columns" : "the column"} in SQL so ${plural ? "each name carries" : "the name carries"} country, economy, iso2 or geo (for example 'country_iso2') and set category_names='iso2'; if they are not countries, label them in Chinese instead; never translate a name yourself`;
  }
  return `${head}; select the ${text.column}${plural} as the name field${plural} and set category_names='${text.target}'${text.alt}; filter aggregate rows (OWID_*, regions, income groups) out in SQL; never translate a name yourself${notNames}`;
}

// The blocker for name fields that say they hold economies or currencies but
// have a value without CJK characters: the recognizable-column message, with
// no match threshold (best may match one value or none, and some values may be
// Chinese). `fields` are the offending fields only.
function declaredNameFieldBlocker(spec, rows, fields) {
  const values = [...new Set(fields.flatMap((field) => distinctNameValues(spec, rows, field)))];
  const best = recognizableNameColumn(values, fields, { threshold: false });
  return zhNameFieldBlocker(fields, values, best, { cjk: values.filter((value) => hasCjk(value)) });
}

// category_names='iso2' on a column whose name does not say it holds countries
// (see the token comment above): two letters also name states and subdivisions.
function iso2NeedsCountryColumnBlocker(fields) {
  const fieldText = fields.map((field) => `'${field}'`).join(" and ");
  const plural = fields.length > 1;
  return `category_names='iso2' on ${fieldText}: two-letter codes are also US states, provinces and other subdivisions, so the column name must say these are countries; rename ${plural ? "the columns" : "the column"} in SQL so ${plural ? "each name carries" : "the name carries"} country, economy, iso2 or geo (for example 'country_iso2'), or use an ISO3 code column with category_names='iso3'`;
}

// Policy rule 4 (zh-naming-policy-1003): a list that includes Hong Kong, Macao
// or Taiwan must say 国家和地区 (or 经济体) in its title and subtitle, never a
// bare 国家.
const SPECIAL_REGION_ISO3 = Object.freeze(["HKG", "MAC", "TWN"]);

function specialRegionsInNameFields(spec, rows, fields) {
  if (!ECONOMY_NAME_MODES.includes(spec.category_names)) return [];
  const found = new Map();
  for (const field of fields) {
    for (const value of nameFieldValues(spec, rows, field)) {
      const entry = economyEntryFor(value, spec.category_names);
      if (entry && SPECIAL_REGION_ISO3.includes(entry.iso3) && !found.has(entry.iso3)) found.set(entry.iso3, entry.zh);
    }
  }
  return SPECIAL_REGION_ISO3.filter((iso3) => found.has(iso3)).map((iso3) => ({ iso3, zh: found.get(iso3) }));
}

function saysCountryWithoutRegions(text) {
  const value = String(text ?? "");
  return value.includes("国家") && !value.includes("和地区") && !value.includes("经济体");
}

// Policy rule 7: the distinct raw values of one name field that the economy
// tables resolve to an aggregate, when the same field also resolves to at least
// one economy or territory (null otherwise: an all-aggregate field is a chart
// ABOUT aggregates, and values the table cannot resolve are the unmapped-value
// blocker's business). It reads the entry's kind, so a code prefix never
// decides anything.
function aggregateMixInNameField(spec, rows, field) {
  if (!ECONOMY_NAME_MODES.includes(spec.category_names)) return null;
  const aggregates = [];
  let economies = 0;
  for (const value of unique(nameFieldValues(spec, rows, field).map((raw) => String(raw ?? "").trim()))) {
    const entry = economyEntryFor(value, spec.category_names);
    if (!entry) continue;
    if (entry.kind === "aggregate") aggregates.push(value);
    else economies += 1;
  }
  return aggregates.length && economies ? { aggregates, economies } : null;
}

function aggregateMixBlocker(spec, field, mix) {
  const shown = mix.aggregates.slice(0, 5).map((value) => `'${value}'`).join(", ");
  const more = mix.aggregates.length > 5 ? ` and ${mix.aggregates.length - 5} more` : "";
  return `'${field}' on chart_type '${spec.chart_type}' mixes ${mix.aggregates.length} aggregate row(s) (${shown}${more}) with economies; an aggregate such as the World, a region or an income group is not a peer of a country, so it would be ranked, compared or drawn as one. Filter the aggregate rows out in SQL (World Bank 'region' = 'Aggregates'; Our World in Data aggregate codes start with 'OWID_' except OWID_KOS (Kosovo), or have an empty code); to compare with the world, put its value in the subtitle or a reference annotation instead; the renderer never drops rows for you`;
}

// The value-axis domain a reference_line must fall inside, mirroring each
// renderer's own extent(...) call exactly (same field selection, same
// includeZero, same %-domain special case) so a value lint accepts is always
// inside the axis render actually draws - the two can never drift apart.
// Returns null when there are no numeric values to build a domain from (the
// row-level blockers above already cover that case).
function referenceLineDomain(spec, rows) {
  if (spec.chart_type === "dumbbell") {
    const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
    return values.length ? extent(values, false) : null;
  }
  if (spec.chart_type === "small_multiples") {
    const values = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
    if (!values.length) return null;
    if (spec.panel_mark === "dot") {
      if (spec.unit === "%" && Math.min(...values) >= 0 && Math.max(...values) <= 100) return [0, 100];
      return extent(values, true);
    }
    return extent(values, false);
  }
  // horizontal_bar, dot
  const values = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  return values.length ? extent(values, true) : null;
}

function horizontalScale(domain, left, right) {
  const [min, max] = domain;
  return (value) => left + ((value - min) / (max - min)) * (right - left);
}

function verticalScale(domain, top, bottom) {
  const [min, max] = domain;
  return (value) => bottom - ((value - min) / (max - min)) * (bottom - top);
}

// Round-number ticks: mirrors d3-array v7's ticks()/tickIncrement() step
// rule (step = span/count snapped to the nearest 1/2/5 x 10^k) so gridlines
// land on values a reader expects instead of an equal split of the data's
// own min/max. Values are built as integer*step or integer/inv (never a
// chain of float additions) so a step like 0.2 never prints as
// 0.6000000000000001.
export function tickValues(domain, count = 4) {
  const start = Math.min(domain[0], domain[1]);
  const stop = Math.max(domain[0], domain[1]);
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return [0];
  if (start === stop) return [start];
  let n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 4;
  let values = [];
  for (let attempt = 0; attempt < 8 && values.length < 2; attempt++, n *= 2) {
    const step = (stop - start) / n;
    const power = Math.floor(Math.log10(step));
    const error = step / 10 ** power;
    const factor = error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1;
    values = [];
    if (power >= 0) {
      const inc = 10 ** power * factor;
      let i1 = Math.round(start / inc);
      let i2 = Math.round(stop / inc);
      if (i1 * inc < start) i1++;
      if (i2 * inc > stop) i2--;
      for (let i = i1; i <= i2; i++) values.push(i * inc);
    } else {
      const inv = 10 ** -power / factor;
      let i1 = Math.round(start * inv);
      let i2 = Math.round(stop * inv);
      if (i1 / inv < start) i1++;
      if (i2 / inv > stop) i2--;
      for (let i = i1; i <= i2; i++) values.push(i / inv);
    }
  }
  return values.length ? values : [start, stop];
}

// Round ticks for a log10-space domain: the {1,2,5}x10^k values that fall
// inside it, thinned to bare powers of ten when there are more than 8, or
// widened to the two domain ends (rounded to 2 significant figures) when
// there are fewer than 2. Returns real (non-log) values - the units
// makeScale/renderScatter already draw in, not log10 units.
export function logTickValues(logDomain) {
  const lo = Math.min(logDomain[0], logDomain[1]);
  const hi = Math.max(logDomain[0], logDomain[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [1];
  const EPS = 1e-9;
  const candidates = [];
  if (hi > lo) {
    for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi) + 1; k++) {
      for (const m of [1, 2, 5]) {
        const logValue = k + Math.log10(m);
        if (logValue >= lo - EPS && logValue <= hi + EPS) candidates.push({ value: m * 10 ** k, isPowerOfTen: m === 1 });
      }
    }
  }
  candidates.sort((a, b) => a.value - b.value);
  let values = candidates.map((c) => c.value);
  if (values.length > 8) {
    const powersOfTen = candidates.filter((c) => c.isPowerOfTen).map((c) => c.value);
    if (powersOfTen.length >= 2) values = powersOfTen;
  }
  if (values.length < 2) {
    const loVal = Number((10 ** lo).toPrecision(2));
    const hiVal = Number((10 ** hi).toPrecision(2));
    values = loVal === hiVal ? [loVal] : [loVal, hiVal];
  }
  return values;
}

// fmt() spells 2000 as "2.0k" so a value label keeps a decimal of
// precision; a tick label reads better without the trailing ".0" ("2k", but
// "2.5k" keeps its digit). Use only at tick sites - fmt() itself is
// unchanged so data/value labels keep their precision.
export function tickLabel(value, unit = "", lang = "en") {
  if (lang === "zh") return fmt(value, unit, null, "zh").replace(/\.0(万亿|亿|万)/, "$1");
  return fmt(value, unit).replace(/\.0(k|m|bn)\b/, "$1");
}

// Fix 3 (house style only - legacy's original every-tick-has-its-unit
// output is untouched byte-for-byte): best practice (FT, Economist, SCMP)
// is bare numbers on every tick, with the unit shown once, on the extreme
// tick - the top-most for a vertical/value axis, the last for a horizontal
// one. `index`/`count` describe this tick's position in its own axis's
// already-ascending tick list (lineAxisTicks/tickValues both walk low to
// high), so the *last* index is the top-most (line/multi_line y-axis) or
// right-most (every addHorizontalAxis-drawn value axis) tick.
function axisTickUnit(unit, index, count) {
  return HOUSE_STYLE_ACTIVE && index < count - 1 ? "" : unit;
}

// Line-chart-only value-axis domain/ticks (task B: "the lowest and highest
// ticks must bracket the data"). tickValues() above rounds its step to a
// nice {1,2,5}x10^k number and then only keeps ticks that land strictly
// inside the caller's own domain - useful for a bar/dot axis that already
// pads its domain, but wrong for a line chart's honesty requirement: if the
// raw data max sits between two nice steps, the *domain itself*, not just
// the tick list, must be widened out to the next nice step so the top
// (and, for a %-share series, bottom) tick actually brackets every plotted
// value. lineAxisDomain does that widening (this is the same "nice domain"
// step d3-array's scale.nice() applies); lineAxisTicks then walks that
// already-nice domain in fixed steps, so its first/last tick are always
// exactly the domain's own min/max - never short of the data.
function niceAxisStep(rawStep) {
  if (!(rawStep > 0)) return 1;
  const power = Math.floor(Math.log10(rawStep));
  const err = rawStep / 10 ** power;
  const factor = err >= Math.sqrt(50) ? 10 : err >= Math.sqrt(10) ? 5 : err >= Math.sqrt(2) ? 2 : 1;
  return factor * 10 ** power;
}

export function lineAxisDomain(values, includeZero = false, count = 4) {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (includeZero) min = Math.min(0, min);
  if (min === max) { min -= 1; max += 1; }
  const step = niceAxisStep((max - min) / count);
  // includeZero pins the floor at 0 only when no value is below it; a series
  // with negatives needs its nice floor below zero or points leave the axis.
  const niceMin = includeZero && min >= 0 ? 0 : Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  return [niceMin, niceMax];
}

// `cover` (house style; renderLine/renderMobileLine pass HOUSE_STYLE_ACTIVE)
// walks outward to the first tick at or beyond each edge of the domain.
// lineAxisDomain widens by the step of the *data* range while this function
// re-derives the step from the already-widened span, so the two can disagree
// (data 18..64: domain [10, 70], tick step 20) and the nearest-tick rounding
// below then lands the lowest tick just inside the domain (20) - above the
// lowest plotted value, which fell off the axis. Legacy (`cover` false)
// keeps the nearest-tick rounding byte-for-byte. The nudge keeps float noise
// (an edge 3.0000000000000004 steps out) from adding a whole extra tick.
export function lineAxisTicks(domain, count = 4, cover = true) {
  const [start, stop] = domain;
  if (!Number.isFinite(start) || !Number.isFinite(stop) || start === stop) return [start ?? 0];
  const step = niceAxisStep((stop - start) / count);
  const i0 = cover ? Math.floor(start / step + 1e-9) : Math.round(start / step);
  const i1 = cover ? Math.ceil(stop / step - 1e-9) : Math.round(stop / step);
  const ticks = [];
  for (let i = i0; i <= i1; i++) ticks.push(i * step);
  return ticks.length ? ticks : [start, stop];
}

// Task A: a line/multi_line series is "regularly spaced" only when every
// consecutive gap between its sorted x values is the same (annual data with
// no missing year, monthly with no missing month, etc). Parses each x value
// as a plain number first (so "1990".."2023" compares as 1, not a Date), and
// falls back to Date.parse only when that fails (an ISO date string x
// axis). Fewer than 3 points can't demonstrate a repeating gap, so they are
// never "regular" - renderLine treats that case as sparse (straight
// segments, a marker at every point), which is also correct there.
function parseXNumeric(value) {
  const num = n(value);
  if (num !== null) return num;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function isRegularlySpaced(xValues) {
  if (xValues.length < 3) return false;
  const nums = xValues.map(parseXNumeric);
  if (nums.some((v) => v === null)) return false;
  const sorted = [...nums].sort((a, b) => a - b);
  const first = sorted[1] - sorted[0];
  if (!(first > 0)) return false;
  const tol = Math.max(1e-6, Math.abs(first) * 1e-6);
  for (let i = 2; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - sorted[i - 1] - first) > tol) return false;
  }
  return true;
}

// Task A: monotone cubic interpolation through `points` ({x,y} in ascending
// x order, as renderLine's own pixel coordinates already are), using the
// same Fritsch-Carlson construction as d3.curveMonotoneX: a one-sided
// secant slope at each interior point, replaced with 0 wherever the two
// neighbouring secants disagree in sign (a local min/max - forcing a flat
// tangent there is exactly what keeps the curve from overshooting past
// its own data points), and the slope/secant ratio limited to a circle of
// radius 3 (the Fritsch-Carlson monotonicity bound) wherever it would
// otherwise let a cubic segment bulge past either endpoint. The result
// passes through every point exactly (each segment is an ordinary cubic
// Bezier anchored at its own two data points) and never overshoots.
export function monotoneCubicPath(points) {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${points[0].x},${points[0].y}`;
  if (n === 2) return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
  const dx = new Array(n - 1), secant = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    secant[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
  }
  const tangent = new Array(n).fill(0);
  tangent[0] = secant[0];
  tangent[n - 1] = secant[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (secant[i - 1] * secant[i] <= 0) tangent[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / secant[i - 1] + w2 / secant[i]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (secant[i] === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = tangent[i] / secant[i];
    const b = tangent[i + 1] / secant[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      tangent[i] = t * a * secant[i];
      tangent[i + 1] = t * b * secant[i];
    }
  }
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const x0 = points[i].x, y0 = points[i].y, x1 = points[i + 1].x, y1 = points[i + 1].y;
    const step = dx[i] / 3;
    const cp1x = x0 + step, cp1y = y0 + tangent[i] * step;
    const cp2x = x1 - step, cp2y = y1 - tangent[i + 1] * step;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${x1},${y1}`;
  }
  return d;
}

// Task B: an annotation's match_field/match_value can match the same x
// across every series of a multi_line chart (e.g. match_field "yr",
// match_value 2018 matches both the Brazil row and the US row at 2018).
// Previously every renderer just rendered the annotation once per matching
// row, so it was drawn once per series - a visible duplicate. This assigns
// each point annotation to exactly one row: when more than one row matches
// and the annotation carries its own `value`, the row whose value is
// closest to it wins (the plan's own annotation.value already disambiguates
// which series it meant, e.g. 89.3 picks the Brazil row over the US row's
// 10.7 at the same year); otherwise the first match wins, same as before.
function assignPointAnnotations(spec, rows, valueField) {
  const assignment = new Map();
  for (const annotation of annotations(spec)) {
    if (annotation?.type !== "point" || !annotation.match_field) continue;
    const candidates = rows.filter((row) => String(row?.[annotation.match_field]) === String(annotation.match_value));
    if (!candidates.length) continue;
    let chosen = candidates[0];
    if (candidates.length > 1 && annotation.value !== undefined && annotation.value !== null) {
      let bestDiff = Infinity;
      for (const row of candidates) {
        const value = n(row[valueField]);
        if (value === null) continue;
        const diff = Math.abs(value - annotation.value);
        if (diff < bestDiff) { bestDiff = diff; chosen = row; }
      }
    }
    assignment.set(annotation, chosen);
  }
  return assignment;
}

// LAYERING_FIX drops the vertical value-axis gridline itself (every chart
// that calls this already draws a direct value label per mark, so the
// gridline is redundant) but keeps the tick label - it's what showed through
// the gaps between bars/dots looking like stray strokes crossing the marks.
function addHorizontalAxis(parts, domain, left, right, top, bottom, unit, spec = null, frameW = null) {
  let ticks = tickValues(domain, 4);
  // Desktop callers pass frameW. Two axis-frame rules then apply: a side of a
  // zero-straddling axis that holds at least a quarter of the span gets at
  // least two labelled ticks (0 counts as one), and no tick label may cross
  // the SVG frame (it is slid inside, still as close to its tick as it fits).
  if (frameW !== null && domain[0] < 0 && domain[1] > 0) {
    const span = domain[1] - domain[0];
    const nice = (extent) => {
      let best = null;
      for (let power = Math.floor(Math.log10(extent)) - 1; power <= Math.floor(Math.log10(extent)); power++) {
        for (const f of [1, 2, 5]) { const v = f * 10 ** power; if (v <= extent + 1e-9 && (best === null || v > best)) best = v; }
      }
      return best;
    };
    const have = new Set(ticks.map((t) => Math.round(t * 1e9) / 1e9));
    if (!have.has(0)) { ticks = [...ticks, 0]; have.add(0); }
    for (const sign of [-1, 1]) {
      const extent = sign < 0 ? -domain[0] : domain[1];
      if (extent / span < 0.25) continue;
      if (ticks.some((t) => t * sign > 1e-9)) continue;
      const v = nice(extent);
      if (v) ticks = [...ticks, sign * v];
    }
    ticks = [...ticks].sort((a, b) => a - b);
  }
  const scaleX = horizontalScale(domain, left, right);
  ticks.forEach((tick, i) => {
    const x = scaleX(tick);
    if (!LAYERING_FIX) {
      parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    }
    // Fix 3: the unit shows once, on the last (right-most) tick, not on
    // every one - see axisTickUnit.
    const label = tickLabelSpec(spec, tick, axisTickUnit(unit, i, ticks.length));
    let labelX = x;
    if (frameW !== null) {
      const half = (textUnits(label) * 12 * 0.56) / 2 + 2;
      labelX = Math.min(Math.max(x, 8 + half), frameW - 8 - half);
    }
    parts.push(`<text x="${labelX}" y="${bottom + 21}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(label)}</text>`);
  });
}

function sortRows(rows, spec, field) {
  const mode = spec.sort ?? "none";
  const copy = [...rows];
  if (mode === "asc") copy.sort((a, b) => (n(a[field]) ?? 0) - (n(b[field]) ?? 0));
  if (mode === "desc") copy.sort((a, b) => (n(b[field]) ?? 0) - (n(a[field]) ?? 0));
  return copy;
}

function renderGroupedDots(spec, rows) {
  const valueField = spec.value_field;
  const categoryField = spec.category_field;
  const seriesField = spec.series_field;
  const categories = unique(rows.map((row) => String(row[categoryField] ?? ""))).filter(Boolean);
  const series = unique(rows.map((row) => String(row[seriesField] ?? ""))).filter(Boolean);
  const refLines = referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const bodyHeight = Math.max(250, categories.length * 48 + 78) + refMargin;
  const f = frame(spec, bodyHeight);
  const base = f.bodyTop + 34;
  const left = 250, right = 955, top = base + refMargin, bottom = f.bodyBottom - 34;
  const values = rows.map((row) => n(row[valueField])).filter((value) => value !== null);
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  const renderedAnnotations = new Set();
  const annotationSeries = new Map(categories.map((category) => {
    const available = series.map((seriesName, index) => rows.some((row) => String(row[categoryField] ?? "") === category && String(row[seriesField] ?? "") === seriesName) ? index : -1).filter((index) => index >= 0);
    return [category, available.at(-1)];
  }));
  const legendY = f.bodyTop + 12;
  f.parts.push(`<text x="${left}" y="${legendY}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${VIZ_STRINGS[vizLang(spec)].group}</text>`);
  let legendX = left + 42;
  series.forEach((name, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    f.parts.push(`<circle data-role="legend-swatch" cx="${legendX}" cy="${legendY - 4}" r="5" fill="${color}"/>`);
    f.parts.push(`<text x="${legendX + 10}" y="${legendY}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(name)}</text>`);
    legendX += Math.max(68, String(name).length * 12 + 30);
  });
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit, spec);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  const step = (bottom - top) / Math.max(categories.length, 1);
  const offsets = series.length <= 1
    ? [0]
    : series.map((_name, index) => (index - (series.length - 1) / 2) * Math.min(16, 28 / series.length));
  categories.forEach((category, categoryIndex) => {
    const center = top + step * categoryIndex + step * 0.5;
    f.parts.push(`<text x="235" y="${center + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(resolveEconomyDisplayName(category, spec.category_names, vizLang(spec)))}</text>`);
    series.forEach((seriesName, seriesIndex) => {
      const row = rows.find((candidate) => String(candidate[categoryField] ?? "") === category && String(candidate[seriesField] ?? "") === seriesName);
      if (!row) return;
      const value = n(row[valueField]);
      if (value === null) return;
      const y = center + (offsets[seriesIndex] ?? 0);
      const x = scale(value);
      const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="5.5" fill="${color}"/>`);
      const label = fmtSpec(spec, value, spec.label_unit ?? "");
      const labelWidth = Math.max(24, textUnits(label) * 6.8);
      const canPlaceRight = x + 9 + labelWidth <= right;
      const canPlaceLeft = x - 9 - labelWidth >= left;
      const placeRight = value >= 0 ? canPlaceRight || !canPlaceLeft : !canPlaceLeft;
      const anchor = placeRight ? "start" : "end";
      const labelX = x + (placeRight ? 9 : -9);
      if (spec.direct_labels !== false) {
        f.parts.push(`<text data-role="dot-value-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);
      }
      if (seriesIndex === annotationSeries.get(category)) {
        pointAnnotations(spec, row).forEach((annotation) => {
          const key = `${annotation.claim_id ?? ""}|${annotation.match_field ?? ""}|${annotation.match_value ?? ""}|${annotation.text ?? ""}`;
          if (renderedAnnotations.has(key)) return;
          renderedAnnotations.add(key);
          addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout });
        });
      }
    });
  });
  drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  addFooter(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

// diverging_bar value labels always sit just outside their bar's end, on the
// bar's own side. This returns how many px to keep free beyond the plot's left
// (negative bars) and right (positive bars) edge for the widest such label plus
// its `gap` from the bar, measured on the label texts as they are drawn, so a
// label never has to move inside a bar that reaches the plot edge.
function divergingLabelMargins(spec, sorted, valueField, labelDecimals, gap) {
  const PX = 7.5; // per text unit; bold 12px digits and "%" run wider than the 6.4 the label column uses
  const widest = (pred) => Math.ceil(Math.max(0, ...sorted.map((row, i) => {
    const v = n(row[valueField]);
    return v === null || !pred(v) ? 0 : textUnits(fmtSpec(spec, v, HOUSE_STYLE_ACTIVE && i > 0 ? "" : spec.unit, labelDecimals)) * PX;
  })));
  const neg = widest((v) => v < 0), pos = widest((v) => v >= 0);
  return { neg: neg ? neg + gap : 0, pos: pos ? pos + gap : 0 };
}

function renderHorizontal(spec, rows, mode) {
  const valueField = spec.value_field;
  if (mode === "dot" && spec.series_field && fieldExists(rows, spec.series_field)) {
    return renderGroupedDots(spec, rows);
  }
  const sorted = sortRows(rows, spec, valueField);
  const refLines = spec.chart_type === "diverging_bar" ? [] : referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const rangeBrackets = spec.chart_type === "diverging_bar" ? [] : rangeBracketAnnotations(spec);
  const bracketMargin = rangeBracketMargin(rangeBrackets);
  // Tight layout (house style, horizontal_bar only): the label column, the
  // right edge and the blank band under the bars come from the labels'
  // actual sizes instead of the fixed 250 / 955 / 230-minimum constants.
  const tight = HOUSE_STYLE_ACTIVE && spec.chart_type === "horizontal_bar";
  // diverging_bar takes the same label column sized from the drawn names (house style); its
  // value-label room stays with divergingLabelMargins below, so negW/posW are not added for it.
  const tightColumn = tight || (HOUSE_STYLE_ACTIVE && spec.chart_type === "diverging_bar");
  const bodyHeight = Math.max(tight ? 150 : 230, sorted.length * 38 + 45) + refMargin;
  const f = frame(spec, bodyHeight, tight ? 300 : 420);
  const base = f.bodyTop + 4;
  let left = 250, right = 955 - bracketMargin, catX = 235;
  const top = base + refMargin, bottom = f.bodyBottom - 34;
  const values = sorted.map((r) => n(r[valueField])).filter((v) => v !== null);
  // Fix 2: every row's direct value label in this chart shares one decimal
  // count (see resolveChartDecimals) - resolved once, up front, from every
  // value the chart will actually display, not per-label.
  const labelDecimals = resolveChartDecimals(spec, values);
  let categoryLabels = null;
  if (tightColumn) {
    const PX = 6.4; // generous per-unit width of 12px text (Latin ~6, CJK 12 per 2 units)
    const maxCatUnits = Math.max(6, Math.floor((LAYOUT_W * 0.4 - 69) / PX));
    categoryLabels = sorted.map((row) => {
      const name = String(resolveEconomyDisplayName(row[spec.category_field], spec.category_names, vizLang(spec)));
      // Never cut a name: one that does not fit the label column is folded
      // onto a second line (a row is 38px, two 12px lines fit). If the second
      // line is still too wide the text runs past the column and render QA
      // blocks the chart; it is not shortened.
      if (textUnits(name) <= maxCatUnits) return [name];
      const head = sliceUnits(name, maxCatUnits);
      const space = head.lastIndexOf(" ");
      const cut = space > head.length * 0.4 ? space : head.length;
      return [name.slice(0, cut).trimEnd(), name.slice(cut).trimStart()];
    });
    const valueTexts = sorted.map((row, i) => { const v = n(row[valueField]); return v === null ? null : { v, text: fmtSpec(spec, v, i > 0 ? "" : spec.unit, labelDecimals) }; });
    const widest = (pred) => Math.ceil(Math.max(0, ...valueTexts.filter((t) => t && pred(t.v)).map((t) => textUnits(t.text) * PX)));
    const catW = Math.ceil(Math.min(maxCatUnits, Math.max(1, ...categoryLabels.flat().map(textUnits))) * PX);
    catX = 54 + catW;
    if (tight) {
      const negW = widest((v) => v < 0), posW = widest((v) => v >= 0);
      left = catX + 15 + (negW ? negW + 9 : 0);
      right = LAYOUT_W - 54 - bracketMargin - (posW ? posW + 9 : 0);
    } else left = catX + 15;
  }
  if (spec.chart_type === "diverging_bar") {
    const margins = divergingLabelMargins(spec, sorted, valueField, labelDecimals, 9);
    left += margins.neg; right -= margins.pos;
  }
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit, spec, LAYOUT_W);
  // LAYERING_FIX: every "bar" mode mark already starts at zero (rx below is
  // always Math.min(x, zero)), so the 0 baseline is redundant ink that only
  // showed, full weight, in the gaps between bars. Drop it for bars; "dot"
  // mode still uses it as a real reference (the stem starts here, no mark
  // covers it), so it stays there.
  // diverging_bar keeps it as the reference its two-colour sign convention reads against (drawn before the bars).
  if (!(LAYERING_FIX && mode === "bar" && spec.chart_type !== "diverging_bar")) {
    const zeroLineRole = LAYERING_FIX ? ` data-role="zero-line"` : "";
    f.parts.push(`<line${zeroLineRole} x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  }
  // LAYERING_FIX: paint reference lines *before* the marks so a bar covers
  // whatever they cross, instead of the old draw order (after all marks),
  // which painted the dashed rule on top and sliced across bars.
  if (LAYERING_FIX) drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  const step = (bottom - top) / sorted.length;
  sorted.forEach((row, i) => {
    const value = n(row[valueField]);
    if (value === null) return;
    const y = top + step * i + step * 0.5;
    const catLines = categoryLabels ? categoryLabels[i] : [resolveEconomyDisplayName(row[spec.category_field], spec.category_names, vizLang(spec))];
    catLines.forEach((line, k) => f.parts.push(`<text x="${catX}" y="${catLines.length > 1 ? y - 3 + k * 14 : y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(line)}</text>`));
    const x = scale(value);
    const highlighted = (spec.highlight_values ?? []).map(String).includes(String(row[spec.category_field]));
    const diverging = spec.chart_type === "diverging_bar";
    const anyHighlight = (spec.highlight_values ?? []).length > 0;
    // diverging_bar: two colours by sign; with a highlight the other bars are drawn lighter.
    const fill = diverging ? (value >= 0 ? PALETTE.positive : PALETTE.negative) : highlighted ? PALETTE.accent : PALETTE.context;
    const barOpacity = diverging && anyHighlight && !highlighted ? ` fill-opacity="0.45"` : "";
    // Fix 3: the unit goes on the first (top-most, as drawn) direct value
    // label only - every other row's label is a bare number, matching the
    // axis-tick convention above.
    const rowUnit = HOUSE_STYLE_ACTIVE && i > 0 ? "" : spec.unit;
    if (mode === "bar") {
      const rx = Math.min(x, zero), width = Math.max(1, Math.abs(x - zero));
      f.parts.push(`<rect data-role="data-bar" x="${rx}" y="${y - 8}" width="${width}" height="16" fill="${fill}"${barOpacity}/>`);
    } else {
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="5" fill="${fill}"/>`);
    }
    if (spec.chart_type === "diverging_bar") {
      // Always outside the bar's end, on the bar's own side (divergingLabelMargins keeps room for it).
      const anchor = value >= 0 ? "start" : "end";
      const labelX = x + (value >= 0 ? 9 : -9);
      f.parts.push(`<text data-role="bar-value-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="${anyHighlight && highlighted ? 700 : 600}" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value, rowUnit, labelDecimals))}</text>`);
    } else {
      const anchor = value >= 0 ? "start" : "end";
      const labelX = x + (value >= 0 ? 9 : -9);
      f.parts.push(`<text x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value, rowUnit, labelDecimals))}</text>`);
    }
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout }));
  });
  if (!LAYERING_FIX) drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  drawRangeBrackets(f.parts, rangeBrackets, sorted, spec, { top, bottom, right });
  addFooter(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

// Value labels for one dumbbell row, in the standard order: the lower value's
// label sits beyond the lower end of the span and the higher value's beyond the
// higher end, so the two labels always point away from each other. A reversed
// pair (start above end) used to print each label on the inside of the span,
// where close values stacked "18%" over "17%". Identical displayed values get
// one label (beyond the right-hand dot) instead of the same text on both sides.
function dumbbellValueLabels(x1, x2, a, b, startText, endText, pad) {
  const start = { value: a, edge: x1, text: startText, fill: PALETTE.muted };
  const end = { value: b, edge: x2, text: endText, fill: PALETTE.ink };
  if (a === b || startText === endText) return [{ ...end, x: Math.max(x1, x2) + pad, anchor: "start" }];
  const [low, high] = a < b ? [start, end] : [end, start];
  return [{ ...low, x: low.edge - pad, anchor: "end" }, { ...high, x: high.edge + pad, anchor: "start" }];
}

function renderDumbbell(spec, rows) {
  const sorted = [...rows];
  const refLines = referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const DUMBBELL_KEY_H = 22; // one key line above the plot, above the reference-line band
  const bodyHeight = Math.max(230, sorted.length * 42 + 40) + refMargin + DUMBBELL_KEY_H;
  const f = frame(spec, bodyHeight);
  const base = f.bodyTop + 4 + DUMBBELL_KEY_H;
  const left = 250, right = 945, top = base + refMargin, bottom = f.bodyBottom - 34;
  const values = sorted.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false);
  const scale = horizontalScale(domain, left, right);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit, spec, LAYOUT_W);
  {
    // Key: which dot is which period (start colour first, then end colour).
    const keyY = f.bodyTop + 4 + 12, KEY_PX = 6.4;
    const startName = String(spec.start_label ?? spec.start_field), endName = String(spec.end_label ?? spec.end_field);
    const endDotX = left + 22 + Math.ceil(textUnits(startName) * KEY_PX) + 24;
    f.parts.push(`<g data-role="dumbbell-key"><circle cx="${left + 5}" cy="${keyY - 4}" r="5" fill="${PALETTE.accent2}"/><text x="${left + 15}" y="${keyY}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(startName)}</text>`
      + `<circle cx="${endDotX}" cy="${keyY - 4}" r="5" fill="${PALETTE.accent}"/><text x="${endDotX + 10}" y="${keyY}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(endName)}</text></g>`);
  }
  // LAYERING_FIX: draw reference lines before the connectors so a
  // connector/dot covers whatever it crosses (see renderHorizontal for the
  // same treatment on bars).
  if (LAYERING_FIX) drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  const step = (bottom - top) / sorted.length;
  sorted.forEach((row, i) => {
    const a = n(row[spec.start_field]), b = n(row[spec.end_field]);
    if (a === null || b === null) return;
    const y = top + step * i + step * 0.5;
    const x1 = scale(a), x2 = scale(b);
    f.parts.push(`<text x="235" y="${y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(resolveEconomyDisplayName(row[spec.category_field], spec.category_names, vizLang(spec)))}</text>`);
    f.parts.push(`<line data-role="data-bar" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${PALETTE.context}" stroke-width="3"/>`);
    f.parts.push(`<circle cx="${x1}" cy="${y}" r="5" fill="${PALETTE.accent2}"/><circle cx="${x2}" cy="${y}" r="5" fill="${PALETTE.accent}"/>`);
    dumbbellValueLabels(x1, x2, a, b, fmtSpec(spec, a, spec.unit), fmtSpec(spec, b, spec.unit), 7).forEach((label) => f.parts.push(`<text x="${label.x}" y="${y - 9}" text-anchor="${label.anchor}" font-family="${FONT_SANS}" font-size="12" fill="${label.fill}">${esc(label.text)}</text>`));
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x2, y, { side: "right", layout: f.annotationLayout }));
  });
  if (!LAYERING_FIX) drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// mirrored_bar: two sides back to back, e.g. a population pyramid.
//
// Ordered categories run up a centre gutter that also holds their labels. The
// first series' bars grow left from the gutter's left edge and the second
// series' bars grow right from its right edge, both on ONE symmetric axis, so
// two bars of equal length are two equal values. The spec chooses which series
// goes left (left_series) and where the first category sits (first_row); the
// renderer assumes nothing about the topic. An optional second period
// (period_field) is drawn either as an outline over the same rows
// (compare_layout "overlay", the default) or as a second pyramid beside the
// first on the same axis maximum ("side_by_side"). Every printed number is a
// value_field value formatted by fmtSpec, or an axis tick: nothing is summed,
// differenced or rescaled.
// ---------------------------------------------------------------------------
const MIRRORED_ROW_GAP = 2; // px between neighbouring rows (house rule: 1-2px)

// Width of a text in px, for fitting only (the gutter, the series names, the
// room a value label needs). Per-glyph classes charged at least what render
// QA's own advance table charges that class, in either weight, times QA's
// 1.05 margin: narrow letters and punctuation, capitals (and &), the wide m w
// M W @ % and dashes, one em for CJK, and a full em for any other character
// outside the ASCII range (QA's fallback for a glyph its table lacks). A
// layout fitted to this never trips the text-outside-viewbox or
// text-crosses-mark checks on its own labels, whatever the label's letters.
const MIRRORED_NARROW_GLYPHS = new Set(Array.from("ijlI.,:;'|! "));
const MIRRORED_WIDE_GLYPHS = new Set(Array.from("mwMW@%\u2026\u2014\u2192"));
const MIRRORED_MEASURED_SYMBOLS = new Set(Array.from("\u00B7\u00A3\u20AC\u00A5\u201C\u201D\u2018\u2019\u2013\u00B0\u00B1\u00D7\u00F7\u2022"));
function mirroredTextPx(text, fontSize = 12) {
  let em = 0;
  for (const ch of Array.from(String(text ?? ""))) {
    if (isWideChar(ch)) em += 1;
    else if (MIRRORED_NARROW_GLYPHS.has(ch)) em += 0.3;
    else if (MIRRORED_WIDE_GLYPHS.has(ch)) em += 1.02;
    else if (ch > "~" && !MIRRORED_MEASURED_SYMBOLS.has(ch)) em += 1.02;
    else if ((ch >= "A" && ch <= "Z") || ch === "&") em += 0.78;
    else em += 0.62;
  }
  return Math.ceil(em * fontSize * 1.05);
}

// The text itself if it fits capPx, else its longest prefix that fits with an
// ellipsis appended (at least one character is always kept).
function mirroredFit(text, fontSize, capPx) {
  const chars = Array.from(String(text ?? ""));
  if (mirroredTextPx(text, fontSize) <= capPx) return String(text ?? "");
  let keep = chars.length - 1;
  while (keep > 1 && mirroredTextPx(`${chars.slice(0, keep).join("")}\u2026`, fontSize) > capPx) keep -= 1;
  return `${chars.slice(0, Math.max(keep, 1)).join("")}\u2026`;
}

// Rows -> the pieces the drawing needs. Category order is row order (first
// appearance). Lint requires exactly 2 series, at most 2 periods and a
// left_series / current_period that exist; a spec that skipped lint still
// renders instead of throwing (extra series are ignored, a missing right side
// stays empty).
function mirroredModel(spec, rows) {
  const periodField = spec.period_field ? String(spec.period_field) : "";
  const categories = unique(rows.map((row) => row[spec.category_field]));
  const seriesValues = unique(rows.map((row) => row[spec.series_field]));
  const leftSeries = spec.left_series !== undefined && seriesValues.includes(String(spec.left_series)) ? String(spec.left_series) : (seriesValues[0] ?? "");
  const rightSeries = seriesValues.find((series) => series !== leftSeries) ?? null;
  const periodValues = periodField ? unique(rows.map((row) => row[periodField])) : [];
  const numericPeriods = periodValues.length > 0 && periodValues.every((period) => period.trim() !== "" && Number.isFinite(Number(period)));
  const periods = [...periodValues].sort((a, b) => (numericPeriods ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
  const current = periods.length ? (spec.current_period !== undefined && periods.includes(String(spec.current_period)) ? String(spec.current_period) : periods.at(-1)) : "";
  const other = periods.find((period) => period !== current) ?? null;
  const cells = new Map();
  for (const row of rows) {
    const value = n(row[spec.value_field]);
    if (value === null) continue;
    const key = JSON.stringify([String(row[spec.category_field]), String(row[spec.series_field]), periodField ? String(row[periodField]) : ""]);
    if (!cells.has(key)) cells.set(key, value);
  }
  const valueAt = (category, series, period) => (series === null || period === null ? null : (cells.get(JSON.stringify([category, series, period])) ?? null));
  let maxValue = 0;
  for (const category of categories) {
    for (const series of [leftSeries, rightSeries]) {
      for (const period of [current, other]) {
        const value = valueAt(category, series, period);
        if (value !== null && value > maxValue) maxValue = value;
      }
    }
  }
  return { categories, leftSeries, rightSeries, periods, current, other, valueAt, maxValue };
}

// One half's axis, mirrored onto the other: ticks 0, step, 2*step ... up to
// the nice ceiling of the largest value (over both sides and both periods).
// The step is a 1/2/5 x 10^k number aiming at 4 intervals, then thinned (at
// the limit down to just 0 and the maximum) while two neighbouring tick labels
// would crowd: ticks are evenly spaced, so each pair needs the average of its
// two label widths plus 14px between centres, and never less than 30px.
// labelWidths(ticks) is the width in px of every label of a candidate tick list.
function mirroredAxis(maxValue, halfLen, labelWidths) {
  const peak = maxValue > 0 ? maxValue : 1;
  const build = (step) => {
    const count = Math.max(1, Math.ceil(peak / step - 1e-9));
    return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  };
  const crowded = (list) => {
    if (!Number.isFinite(halfLen)) return false;
    const spacing = halfLen / (list.length - 1);
    const widths = labelWidths(list);
    return widths.some((width, i) => i + 1 < widths.length && spacing < Math.max(30, (width + widths[i + 1]) / 2 + 14));
  };
  let step = niceAxisStep(peak / 4);
  let ticks = build(step);
  for (let guard = 0; guard < 16 && ticks.length > 2 && crowded(ticks); guard++) {
    step = niceAxisStep(step * 1.6);
    ticks = build(step);
  }
  return { max: ticks.at(-1), ticks };
}

function renderMirroredBar(spec, rows) {
  const m = mirroredModel(spec, rows);
  const total = m.categories.length;
  const highlights = new Set((spec.highlight_values ?? []).map(String));
  const sideBySide = spec.compare_layout === "side_by_side" && m.other !== null;
  const overlay = !sideBySide && m.other !== null;
  // side_by_side: the earlier period (sorted order) on the left.
  const panelPeriods = sideBySide ? [m.current, m.other].sort((a, b) => m.periods.indexOf(a) - m.periods.indexOf(b)) : [m.current];
  const sideSeries = [m.leftSeries, m.rightSeries];
  const rowFromTop = (i) => (spec.first_row === "top" ? i : total - 1 - i);
  const px = (value) => String(Math.round(value * 100) / 100);
  const textPx = (text) => mirroredTextPx(text, 12);
  const OUTLINE = `stroke="${PALETTE.ink}" stroke-opacity="0.8" stroke-width="1.5"`;

  // Value labels: direct_labels prints each bar's own value at its end, for
  // every row when there are 12 or fewer, else only for highlight_values rows.
  // Overlay prints the current period only (the outline is context); in
  // side_by_side each panel prints its own period.
  const labelled = (category) => spec.direct_labels === true && (total <= 12 || highlights.has(category));
  const printed = [];
  for (const period of panelPeriods) {
    for (const category of m.categories) {
      if (!labelled(category)) continue;
      for (const series of sideSeries) {
        const value = m.valueAt(category, series, period);
        if (value !== null) printed.push(value);
      }
    }
  }
  const decimals = resolveChartDecimals(spec, printed);
  // House style states the unit once per half, on its top-most printed label.
  const unitHolders = new Set();
  panelPeriods.forEach((period, pk) => sideSeries.forEach((series, sk) => {
    for (let d = 0; d < total; d++) {
      const i = spec.first_row === "top" ? d : total - 1 - d;
      if (labelled(m.categories[i]) && m.valueAt(m.categories[i], series, period) !== null) { unitHolders.add(`${pk}:${sk}:${i}`); break; }
    }
  }));
  const labelUnit = (pk, sk, i) => (!HOUSE_STYLE_ACTIVE || unitHolders.has(`${pk}:${sk}:${i}`) ? spec.unit : "");

  // Vertical layout: [panel titles | period key] row, series names, rows, ticks.
  const pitch = Math.max(17, Math.min(32, Math.round(440 / Math.max(total, 1))));
  const headRow = overlay || sideBySide;
  const headerH = (headRow ? 24 : 0) + 28;
  const f = frame(spec, headerH + total * pitch + 32);
  const rowY = f.bodyTop + 16;
  const namesY = rowY + (headRow ? 24 : 0);
  const plotTop = namesY + 12;
  const plotBottom = plotTop + total * pitch;
  const tickY = plotBottom + 18;

  // Horizontal layout: one pyramid, or two with a gap. The centre gutter fits
  // the widest label that is shown; each half then spans the room between the
  // gutter and the panel edge, less half the outermost tick label. A value
  // label sits just past its bar, so the scale is shortened only as far as
  // needed to keep the labels of the bars that carry one inside the panel.
  const panelGap = 36;
  const panelW = sideBySide ? (f.width - 108 - panelGap) / 2 : f.width - 108;
  const categoryText = m.categories.map(String);
  const gutterShown = (i) => total <= 12 || i % 2 === 0 || i === total - 1;
  const widestCategory = Math.max(0, ...categoryText.map((text, i) => (gutterShown(i) ? textPx(text) : 0)));
  // [value the label sits beyond, its width, its width without the unit]
  const labelBars = [];
  panelPeriods.forEach((period, pk) => {
    m.categories.forEach((category, i) => {
      if (!labelled(category)) return;
      sideSeries.forEach((series, sk) => {
        const value = m.valueAt(category, series, period);
        if (value === null) return;
        const otherValue = overlay ? m.valueAt(category, series, m.other) : null;
        labelBars.push([Math.max(value, otherValue ?? 0), textPx(fmtSpec(spec, value, labelUnit(pk, sk, i), decimals)), textPx(fmtSpec(spec, value, "", decimals))]);
      });
    });
  });
  const tickLabelWidths = (ticks) => ticks.map((tick, ti) => textPx(tickLabelSpec(spec, tick, axisTickUnit(spec.unit, ti, ticks.length))));
  const fullTicks = mirroredAxis(m.maxValue, Infinity, () => []).ticks; // before any thinning
  // Room a half needs past its axis end: the widest tick label is centred on it.
  const tickRoom = Math.ceil((Math.max(...tickLabelWidths(fullTicks)) + 8) / 2);
  // The gutter may take whatever leaves each half 80px plus that room. The room
  // is measured without the unit, so a long unit shortens bars (below), never
  // the category labels.
  const tickRoomBare = Math.ceil((Math.max(...fullTicks.map((tick) => textPx(tickLabelSpec(spec, tick, "")))) + 8) / 2);
  const labelRoomBare = labelBars.length ? Math.max(...labelBars.map(([, , bare]) => bare)) + 9 : 0;
  // The two "0" labels sit on the gutter's two edges; where the style puts the
  // unit on every tick (legacy) the gutter must hold both side by side.
  const zeroLabelPx = textPx(tickLabelSpec(spec, 0, axisTickUnit(spec.unit, 0, fullTicks.length)));
  let gutterW = Math.max(56, widestCategory + 24, zeroLabelPx + 8);
  let gutterText = categoryText;
  const gutterCap = Math.max(56, panelW - 2 * (80 + Math.max(labelRoomBare, tickRoomBare)));
  if (gutterW > gutterCap) {
    // Only a label too long for any sensible gutter is shortened (with an ellipsis).
    gutterW = gutterCap;
    gutterText = categoryText.map((text) => mirroredFit(text, 12, gutterW - 24));
  }
  const halfFull = (panelW - gutterW) / 2;
  const fitAxis = (halfLen) => {
    const fitted = mirroredAxis(m.maxValue, halfLen, tickLabelWidths);
    let scale = halfLen / fitted.max;
    for (const [value, width] of labelBars) if (value > 0) scale = Math.min(scale, (halfFull - 9 - width) / value);
    // A label too wide to sit beside even a short bar must not flip or erase
    // the bars: the longest one keeps at least 40px (render QA then reports
    // the label that no longer fits).
    return { axis: fitted, k: Math.max(scale, 40 / fitted.max) };
  };
  let fit = fitAxis(Math.max(40, halfFull - tickRoom));
  fit = fitAxis(fit.axis.max * fit.k); // shortened by a label: re-thin the ticks for the shorter axis
  const { axis, k } = fit;
  const halfLen = axis.max * k;
  // A series name is centred over its half: it may reach toward the other name
  // (up to 8px short of it) and out to its panel's edge, no further.
  const nameCap = Math.min(halfLen + gutterW - 16, 2 * halfFull - halfLen);

  // Layers are collected, then painted: gridlines under bars, outlines over
  // bars, text last (text never sits on a bar: labels go beyond the bar ends).
  const heads = [], grid = [], bars = [], outlines = [], valueTexts = [], gutterLabels = [], tickLabels = [];
  panelPeriods.forEach((period, pk) => {
    const cx = 54 + pk * (panelW + panelGap) + panelW / 2;
    const gl = cx - gutterW / 2, gr = cx + gutterW / 2;
    if (sideBySide) heads.push(`<text data-role="panel-title" x="${px(cx)}" y="${px(rowY)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="15" font-weight="700" fill="${PALETTE.ink}">${esc(mirroredFit(period, 15, panelW - 16))}</text>`);
    sideSeries.forEach((series, sk) => {
      if (series === null) return;
      const mid = sk === 0 ? gl - halfLen / 2 : gr + halfLen / 2;
      heads.push(`<text data-role="series-name" x="${px(mid)}" y="${px(namesY)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="13" font-weight="700" fill="${PALETTE.ink}">${esc(mirroredFit(series, 13, nameCap))}</text>`);
    });
    axis.ticks.forEach((tick, ti) => {
      for (const sk of [0, 1]) {
        const x = sk === 0 ? gl - tick * k : gr + tick * k;
        grid.push(`<line data-role="grid-line" x1="${px(x)}" y1="${px(plotTop)}" x2="${px(x)}" y2="${px(plotBottom)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
        tickLabels.push(`<text data-role="axis-tick-label" x="${px(x)}" y="${px(tickY)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick, axisTickUnit(spec.unit, ti, axis.ticks.length)))}</text>`);
      }
    });
    m.categories.forEach((category, i) => {
      const highlighted = highlights.has(category);
      const rowTop = plotTop + rowFromTop(i) * pitch;
      const barY = rowTop + MIRRORED_ROW_GAP / 2, barH = pitch - MIRRORED_ROW_GAP;
      const baseline = rowTop + pitch / 2 + 4;
      if (gutterShown(i)) gutterLabels.push(`<text data-role="category-label" x="${px(cx)}" y="${px(baseline)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="${highlighted ? 700 : 400}" fill="${PALETTE.ink}">${esc(gutterText[i])}</text>`);
      sideSeries.forEach((series, sk) => {
        const value = m.valueAt(category, series, period);
        const otherValue = overlay ? m.valueAt(category, series, m.other) : null;
        const length = value === null ? 0 : value * k;
        const otherLength = otherValue === null || otherValue <= 0 ? 0 : Math.max(2, otherValue * k);
        const fill = highlighted ? PALETTE.accent : sk === 0 ? PALETTE.accent2 : PALETTE.series3;
        if (length > 0) {
          const w = Math.max(1, length);
          bars.push(`<rect data-role="data-bar" x="${px(sk === 0 ? gl - w : gr)}" y="${px(barY)}" width="${px(w)}" height="${px(barH)}" fill="${fill}"/>`);
        }
        // The other period: a stroke with no fill, inset so its outer edge
        // lands on the value and neighbouring rows' strokes keep a gap.
        if (otherLength > 0) {
          outlines.push(`<rect data-role="data-bar-outline" x="${px(sk === 0 ? gl - otherLength + 0.75 : gr + 0.75)}" y="${px(barY + 0.75)}" width="${px(otherLength - 1.5)}" height="${px(barH - 1.5)}" fill="none" ${OUTLINE}/>`);
        }
        if (value !== null && labelled(category)) {
          const reach = Math.max(length, otherLength);
          valueTexts.push(`<text data-role="bar-value-label" x="${px(sk === 0 ? gl - reach - 5 : gr + reach + 5)}" y="${px(baseline)}" text-anchor="${sk === 0 ? "end" : "start"}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value, labelUnit(pk, sk, i), decimals))}</text>`);
        }
      });
    });
  });

  // Period key (overlay only): a filled swatch and an outline swatch, each
  // with its period value from the rows.
  if (overlay) {
    // Each period value gets at most half the room left by the two swatches,
    // so even an absurdly long period label stays on the page.
    const keyCap = Math.floor((f.width - 108 - 66) / 2);
    const keyCurrent = mirroredFit(m.current, 12, keyCap), keyOther = mirroredFit(m.other, 12, keyCap);
    const w1 = textPx(keyCurrent), w2 = textPx(keyOther);
    let x = f.width / 2 - (14 + 5 + w1 + 28 + 14 + 5 + w2) / 2;
    heads.push(`<rect data-role="legend-swatch" x="${px(x)}" y="${px(rowY - 9)}" width="14" height="10" fill="${PALETTE.context}"/>`);
    heads.push(`<text data-role="period-key-label" x="${px(x + 19)}" y="${px(rowY)}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(keyCurrent)}</text>`);
    x += 19 + w1 + 28;
    heads.push(`<rect data-role="legend-swatch" x="${px(x)}" y="${px(rowY - 9)}" width="14" height="10" fill="none" ${OUTLINE}/>`);
    heads.push(`<text data-role="period-key-label" x="${px(x + 19)}" y="${px(rowY)}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(keyOther)}</text>`);
  }
  f.parts.push(...heads, ...grid, ...bars, ...outlines, ...valueTexts, ...gutterLabels, ...tickLabels);
  addFooter(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

// End-label height (12px font, single line, house-style-approved ascent/
// descent) plus 4px, per the label-repel contract: the minimum vertical gap
// between two end labels sharing the same x column.
const END_LABEL_MIN_GAP = 18;

const UNRANKED = 1e9;
const isMissingRank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
// the rows whose start or end field holds a rank that is not a positive integer (a missing end is allowed)
export function nonIntegerRankRows(spec, rows) {
  const bad = [];
  rows.forEach((row, i) => {
    const fields = [spec.start_field, spec.end_field].filter((field) => {
      const v = row[field];
      if (isMissingRank(v)) return false;
      const x = typeof v === "number" ? v : Number(v);
      return !(Number.isInteger(x) && x >= 1);
    });
    if (fields.length) bad.push(`${String(row[spec.category_field] ?? `row ${i + 1}`)} (${fields.map((field) => `${field}=${String(row[field])}`).join(", ")})`);
  });
  return bad;
}

// Rank slope (bump chart). Opt-in through spec.rank_cutoff = N: the start and
// end fields hold ranks (1 = best). Axis inverted so rank 1 is on top; one
// ordinal row per rank 1..N, and an entity outside the top N at one end sits on
// the shared "N+1" row with its true rank in the label (第13名). The name is
// printed at both ends; an entity that enters the top N is coloured and tagged
// 新进, one that drops out 跌出. An entity outside the top N at both ends is not
// drawn (it is in neither list).
function renderRankSlope(spec, rows, cutoff) {
  // Lint refuses these ranks (RANK_NOT_INTEGER), but render only checks that some lint passed for this plan and data, so a PASS
  // recorded before the rule existed must not draw them: refuse here too, on the same rows, and never round or drop.
  const notRanks = nonIntegerRankRows(spec, rows);
  if (notRanks.length) throw new Error(`RANK_NOT_INTEGER: with rank_cutoff, ${spec.start_field} and ${spec.end_field} must hold ranks that are positive integers (or be empty for outside the ranking); not rounded; rows: ${notRanks.slice(0, 8).join("; ")}${notRanks.length > 8 ? `; and ${notRanks.length - 8} more` : ""}`);
  const lang = vizLang(spec);
  const T = VIZ_STRINGS[lang];
  // Ranks are positive integers (lint refuses anything else, RANK_NOT_INTEGER); a missing end means "outside the
  // ranking" and sorts after every real rank on the N+1 row.
  const rankOf = (v) => (isMissingRank(v) ? UNRANKED : Number(v));
  const all = rows.map((row, i) => ({ row, i, a: rankOf(row[spec.start_field]), b: rankOf(row[spec.end_field]) }));
  const entries = all.filter((e) => e.a <= cutoff || e.b <= cutoff);
  const hiddenCount = all.length - entries.length;
  // the chart says what it cut
  spec = { ...spec, note: [spec.note, T.rankCutNote(cutoff, entries.length, hiddenCount)].filter(Boolean).join(" ") };
  const outsideCount = (key) => entries.filter((e) => e[key] > cutoff).length;
  const stack = Math.max(1, outsideCount("a"), outsideCount("b"));
  const ROW = 30, STACK = 17;
  const f = frame(spec, Math.max(300, (cutoff + 1) * ROW + (stack - 1) * STACK + 70));
  const left = 250, right = 790, top = f.bodyTop + 24;
  const rowY = (rank) => top + (Math.min(rank, cutoff + 1) - 1) * ROW;
  const name = (e) => resolveEconomyDisplayName(String(e.row[spec.category_field] ?? ""), spec.category_names, lang);
  const joinColor = HOUSE_STYLE_ACTIVE ? PALETTE.ink : PALETTE.accent2;
  const leaveColor = PALETTE.accent;
  const rankText = (r) => (r === UNRANKED ? T.rankNone : r > cutoff ? T.rankOutside(r) : String(r));
  f.parts.push(`<text x="${left}" y="${top - 18}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.start_label ?? spec.start_field)}</text>`);
  f.parts.push(`<text x="${right}" y="${top - 18}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.end_label ?? spec.end_field)}</text>`);
  // faint ordinal row guides: one per rank, the last one is the "N+1" row
  for (let r = 1; r <= cutoff + 1; r++) f.parts.push(`<line data-role="rank-row" x1="${left}" y1="${rowY(r)}" x2="${right}" y2="${rowY(r)}" stroke="${PALETTE.grid}" stroke-width="0.5" stroke-dasharray="${r > cutoff ? "3 3" : "none"}"/>`);
  // the N+1 row is stacked on each side by that side's own true rank
  const slotOf = { a: new Map(), b: new Map() };
  for (const key of ["a", "b"]) entries.filter((e) => e[key] > cutoff).sort((p, q) => p[key] - q[key] || p.i - q.i).forEach((e, k) => slotOf[key].set(e, k));
  const placed = entries
    .slice().sort((p, q) => (p.a - q.a) || (p.b - q.b))
    .map((e) => ({ ...e, y1: rowY(e.a) + (slotOf.a.get(e) ?? 0) * STACK, y2: rowY(e.b) + (slotOf.b.get(e) ?? 0) * STACK }));
  const marks = [];
  placed.forEach((e) => {
    const category = String(e.row[spec.category_field] ?? "");
    const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
    const entered = e.a > cutoff, dropped = e.b > cutoff;
    // a highlight that stays in the top N keeps the context colour (the accent is the 跌出 colour here)
    const stroke = entered ? joinColor : dropped ? leaveColor : PALETTE.context;
    const width = highlighted || entered || dropped ? 2.5 : 1.5;
    const role = entered ? "rank-join" : dropped ? "rank-leave" : "data-line";
    marks.push(`<line data-role="${role}" x1="${left}" y1="${e.y1}" x2="${right}" y2="${e.y2}" stroke="${stroke}" stroke-width="${width}"/>`);
    marks.push(`<circle cx="${left}" cy="${e.y1}" r="4" fill="${stroke}"/><circle cx="${right}" cy="${e.y2}" r="4" fill="${stroke}"/>`);
    const weight = entered || dropped || highlighted ? 700 : 400;
    marks.push(`<text data-role="rank-label-start" x="${left - 10}" y="${e.y1 + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${PALETTE.ink}">${esc(`${name(e)}  ${rankText(e.a)}`)}</text>`);
    const tag = entered ? `  ${T.rankEntered}` : dropped ? `  ${T.rankLeft}` : "";
    marks.push(`<text data-role="rank-label-end" x="${right + 10}" y="${e.y2 + 4}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${entered || dropped ? stroke : PALETTE.ink}">${esc(`${rankText(e.b)}  ${name(e)}${tag}`)}</text>`);
  });
  f.parts.push(...marks);
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderSlope(spec, rows) {
  const rankCutoff = Number(spec.rank_cutoff);
  if (Number.isInteger(rankCutoff) && rankCutoff >= 2 && rankCutoff <= 30) return renderRankSlope(spec, rows, rankCutoff);
  const f = frame(spec, Math.max(300, rows.length * 26));
  const left = 250, right = 790, top = f.bodyTop + 10, bottom = f.bodyBottom - 25;
  const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false);
  const scaleY = verticalScale(domain, top, bottom);
  // Fix 13: one shared decimals count per chart, through the same
  // resolveChartDecimals() path renderHorizontal/renderLine already use, so
  // a value >= 1000 never falls back to fmt()'s k/m/bn abbreviation
  // branches below it - a 亿-scale slope (e.g. 3756 rising to 8817) needs
  // its four digits shown in full, not "8.8k". null (legacy, or "%") defers
  // to fmt()'s untouched old per-value behaviour, same as every other chart.
  const labelDecimals = resolveChartDecimals(spec, values);
  f.parts.push(`<text x="${left}" y="${top - 10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.start_label ?? spec.start_field)}</text>`);
  f.parts.push(`<text x="${right}" y="${top - 10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.end_label ?? spec.end_field)}</text>`);

  const entries = rows
    .map((row, i) => ({ row, i, a: n(row[spec.start_field]), b: n(row[spec.end_field]) }))
    .filter((e) => e.a !== null && e.b !== null)
    .map((e) => ({ ...e, y1: scaleY(e.a), y2: scaleY(e.b) }));

  // Fix 13: apply d7c8e27's dot/bar rule here too - the unit goes on the
  // first label actually drawn (row 0's left label) only; every other label
  // (that same row's right label, and every other row's both labels) is a
  // bare number. `idx` is an entry's own position in the already-filtered
  // `entries` array (what is actually drawn, in draw order - left before
  // right within a row), not `e.i` (the pre-filter row index used only as
  // repelEndLabels' identity key). Legacy is untouched: HOUSE_STYLE_ACTIVE
  // false keeps every label showing its unit, byte-for-byte.
  const leftLabelText = (e, idx) => `${resolveEconomyDisplayName(String(e.row[spec.category_field] ?? ""), spec.category_names, vizLang(spec))} ${fmtSpec(spec, e.a, HOUSE_STYLE_ACTIVE && idx > 0 ? "" : spec.unit, labelDecimals)}`;
  const rightLabelText = (e) => fmtSpec(spec, e.b, HOUSE_STYLE_ACTIVE ? "" : spec.unit, labelDecimals);
  const leftPlaced = repelEndLabels(entries.map((e, idx) => ({ id: e.i, y: e.y1, text: leftLabelText(e, idx) })), top, bottom, END_LABEL_MIN_GAP);
  const rightPlaced = repelEndLabels(entries.map((e) => ({ id: e.i, y: e.y2, text: rightLabelText(e) })), top, bottom, END_LABEL_MIN_GAP);
  const leftById = new Map(leftPlaced.map((p) => [p.id, p]));
  const rightById = new Map(rightPlaced.map((p) => [p.id, p]));

  // Leaders must paint behind every data mark (house style): stash them
  // here and splice them into `f.parts` right before the marks loop below
  // adds anything, so paint order stays leader-first regardless of how
  // many rows there are.
  const marksStart = f.parts.length;
  const leaderParts = [];

  entries.forEach((e, idx) => {
    const { row, a, b, y1, y2 } = e;
    const category = String(row[spec.category_field] ?? "");
    const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
    const stroke = highlighted ? PALETTE.accent : PALETTE.context;
    const width = highlighted ? 3 : 1.5;
    const leftLabel = leftById.get(e.i);
    const rightLabel = rightById.get(e.i);
    if (leftLabel.needsLeader) leaderParts.push(endLabelLeader(left, y1, left - 8, leftLabel.labelY));
    if (rightLabel.needsLeader) leaderParts.push(endLabelLeader(right, y2, right + 8, rightLabel.labelY));
    f.parts.push(`<line data-role="data-line" x1="${left}" y1="${y1}" x2="${right}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`);
    f.parts.push(`<circle cx="${left}" cy="${y1}" r="4" fill="${stroke}"/><circle cx="${right}" cy="${y2}" r="4" fill="${stroke}"/>`);
    f.parts.push(`<text x="${left - 10}" y="${leftLabel.labelY + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(leftLabelText(e, idx))}</text>`);
    f.parts.push(`<text x="${right + 10}" y="${rightLabel.labelY + 4}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(rightLabelText(e))}</text>`);
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, right, y2, { side: "right", layout: f.annotationLayout }));
  });
  f.parts.splice(marksStart, 0, ...leaderParts);
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function sortX(values) {
  const numeric = values.every((v) => n(v) !== null);
  return [...values].sort((a, b) => numeric ? n(a) - n(b) : String(a).localeCompare(String(b), undefined, { numeric: true }));
}

// Category order (small_multiples panels, chord / adjacency_matrix nodes,
// hierarchy_tree siblings, streamgraph series): a text category keeps the
// order its rows first mention it in - the author's or the query's order, a
// rank or a story - and is never re-sorted by name, because name order is
// no reading order: UTF-16 code-unit order turns 甲乙丙丁 into 丁丙乙甲.
// Keys that are all numbers (years) or all ISO dates (2024-03, 2024-03-15)
// are a sequence, so facetOrder sorts those ascending whatever order the
// rows came in. Takes and returns unique() strings.
const ISO_DATE_KEY = /^\d{4}-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/;
function facetOrder(keys) {
  if (keys.every((key) => n(key) !== null)) return [...keys].sort((a, b) => n(a) - n(b));
  const times = keys.map((key) => (ISO_DATE_KEY.test(key) ? Date.parse(key) : NaN));
  if (times.every(Number.isFinite)) return keys.map((key, i) => ({ key, time: times[i] })).sort((a, b) => a.time - b.time).map((entry) => entry.key);
  return keys;
}

// Fix 5 (end label crosses its own series' line, house style only): a
// multi_line end label carries its series name AND its exact value+unit
// (Task B), which for a CJK name plus a decimal value plus a CJK unit can be
// wider than the margin between the chart's last plotted point and the
// canvas's own right edge - on viz-world.json's World series, ~116px of
// label against ~92px of margin. The existing right-edge clamp
// (`safeEdge - textUnits(text) * pxPerUnit`) only ever pulls an over-wide
// label further LEFT to keep it inside the canvas; it has no floor, so a
// label this wide gets pulled left of the point itself, and render QA
// correctly flags the label's own text as crossing the line/marker it names
// (text_crosses_data_mark). Splitting the label onto two lines - the name,
// then the value+unit - halves what has to fit, but `pxPerUnit` is only a
// per-character approximation (there is no real font-metrics measurement
// available at this layer) and on mobile's narrower canvas it can still
// overestimate a short line's width past what the point-to-edge gap allows.
// Once split, keeping the label off the data mark it names is the hard
// requirement; anchor each split line against the canvas's own true right
// edge instead of sliding it from the point, the same way a y-axis tick
// label anchors against the plot's own left edge - a short, right-aligned
// pair just inside the edge, which for these label lengths lands to the
// right of the point with room to spare, and can never slide backward onto
// it the way a point-anchored-then-clamped line could. A label that already
// fits on one line gets exactly the same single line and x position this
// returned before (verified by the regression test), so this only ever
// changes the specific labels that were crossing their own mark.
function layoutLineEndLabel(name, valueText, pointX, trueEdge, gap, pxPerUnit) {
  const naturalX = pointX + gap;
  const combined = `${name} ${valueText}`;
  const safeEdge = trueEdge - 8; // matches the pre-existing single-line convention
  if (naturalX + textUnits(combined) * pxPerUnit <= safeEdge) {
    return [{ text: combined, x: Math.min(safeEdge - textUnits(combined) * pxPerUnit, naturalX) }];
  }
  const rightAnchorX = trueEdge - 2;
  return [
    { text: name, x: rightAnchorX, anchor: "end" },
    { text: valueText, x: rightAnchorX, anchor: "end" },
  ];
}

// NEWSROOM_LINE_END_LABEL_FIT (default off): lines for a single-series end label
// that would cross the canvas's right edge, or null when the label already
// fits (the caller then draws exactly what it always drew). Same 8 px margin
// as the multi-series label (layoutLineEndLabel); the text is only broken,
// never edited. Break before an opening bracket first, else at a space, and
// never so that a line starts with a unit sign that belongs to the number
// before it (% per-mille ° etc.); with no usable break, or a first line that
// is still too wide, every line is right-aligned to the edge.
const LINE_END_LABEL_NO_LINE_START = /^[%\u2030\u2031\u00B0\u2103\u2109\u2032\u2033]/u;
function lineEndLabelBreak(text) {
  const ok = (i) => i > 0 && !LINE_END_LABEL_NO_LINE_START.test(text.slice(i).trimStart());
  const bracket = text.search(/[\uFF08(]/u);
  if (ok(bracket)) return bracket;
  for (let i = text.indexOf(" "); i > 0; i = text.indexOf(" ", i + 1)) if (ok(i)) return i;
  return -1;
}
function fitLineEndLabel(text, x, trueEdge) {
  const safeEdge = trueEdge - 8;
  const width = (t) => estimateTextWidth(t, 12, true);
  if (x + width(text) <= safeEdge) return null;
  const cut = lineEndLabelBreak(text);
  const parts = cut > 0 ? [text.slice(0, cut).trimEnd(), text.slice(cut).trimStart()] : [text];
  if (parts.every((t) => x + width(t) <= safeEdge)) return parts.map((t) => ({ text: t, x }));
  return parts.map((t) => ({ text: t, x: safeEdge, anchor: "end" }));
}

function renderLine(spec, rows, multi = false) {
  let left = 100, right = LAYOUT_W - 100;
  const seriesField = multi ? spec.series_field : null;
  const seriesNames = seriesField ? unique(rows.map((r) => r[seriesField])) : ["series"];
  const xValues = sortX(unique(rows.map((r) => r[spec.x_field])));
  const xIndex = new Map(xValues.map((v, i) => [String(v), i]));
  // Tight layout (house style): the y-tick column on the left and the
  // end-label band on the right are sized from the real label text instead
  // of the fixed 100 / (width - 100) constants. A label too wide for its
  // band still wraps onto two lines (layoutLineEndLabel), so the band is
  // capped at a share of the width.
  const tight = HOUSE_STYLE_ACTIVE;
  const lineSeriesGroup = (series) => rows.filter((r) => !seriesField || String(r[seriesField]) === series).sort((a, b) => xIndex.get(String(a[spec.x_field])) - xIndex.get(String(b[spec.x_field])));
  const lineEndValues = seriesNames.map((series) => { const g = lineSeriesGroup(series); const last = g[g.length - 1]; return last ? n(last[spec.value_field]) : null; }).filter((v) => v !== null);
  const labelDecimals = resolveChartDecimals(spec, lineEndValues);
  if (tight) {
    const PX = 6.8;
    const earlyValues = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
    const earlyTicks = lineAxisTicks(lineAxisDomain(earlyValues, spec.unit === "%", 4), 4);
    const tickPx = Math.max(0, ...earlyTicks.map((tick, i) => textUnits(tickLabelSpec(spec, tick, axisTickUnit(spec.unit, i, earlyTicks.length))) * PX));
    left = Math.ceil(54 + tickPx + 12);
    let band = 46;
    if (multi && spec.direct_labels !== false) {
      // A label that fits the 30% share sits on one line; a wider one splits
      // (layoutLineEndLabel) and then needs the width of its longer line, up
      // to 45% of the chart. Beyond that the text still crosses the line and
      // render QA blocks the chart.
      const oneLineCap = Math.floor(LAYOUT_W * 0.3);
      const widest = Math.max(0, ...seriesNames.map((series) => {
        const g = lineSeriesGroup(series); const last = g[g.length - 1];
        const value = last ? n(last[spec.value_field]) : null;
        const name = resolveEconomyDisplayName(series, spec.category_names, vizLang(spec));
        const valueText = value === null ? "" : fmtSpec(spec, value, spec.unit, labelDecimals);
        const oneLine = textUnits(value === null ? name : `${name} ${valueText}`) * PX + 14;
        return oneLine <= oneLineCap ? oneLine : Math.max(textUnits(name), textUnits(valueText)) * PX + 14;
      }));
      band = Math.min(Math.max(band, Math.ceil(widest)), Math.floor(LAYOUT_W * 0.45));
    }
    right = LAYOUT_W - 54 - band;
  }
  const xScale = (value) => xValues.length <= 1 ? (left + right) / 2 : left + (xIndex.get(String(value)) / (xValues.length - 1)) * (right - left);
  // Decide the event-annotation layout (lane vs. numbered-marker fallback)
  // before choosing a frame height: it only needs x positions and text
  // width, and the fallback's caption list needs extra body height the
  // in-lane layout does not.
  // 986 is the frame's own established safe-text right margin (see frame()'s
  // annotationLayout/footer rule) - wider than the plot's own right edge
  // (`right`, 940), which otherwise-empty margin a lane label may use.
  const eventLayout = layoutEventAnnotations(spec, rows, xScale, left, right, 16, LAYOUT_W - 54);
  const captionExtra = eventLayout.fallback && eventLayout.events.length ? eventLayout.events.length * 16 + 22 : 0;
  const f = frame(spec, 380 + captionExtra);
  const bottom = f.bodyBottom - (tight ? 40 : 48) - captionExtra;
  const hasLane = eventLayout.events.length > 0 && !eventLayout.fallback;
  const laneTop = f.bodyTop + 15 + (HOUSE_STYLE_ACTIVE ? TOP_TICK_CLEARANCE : 0);
  const rowsUsed = hasLane ? (eventLayout.events.some((e) => e.laneRow === 1) ? 2 : 1) : 0;
  const rowY = hasLane ? Array.from({ length: rowsUsed }, (_, i) => laneTop + LANE_ROW_HEIGHT * (i + 1)) : [];
  const top = hasLane ? rowY[rowsUsed - 1] + 8 : laneTop;
  const yValues = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  // Task B: the axis must literally bracket every plotted value (no data point
  // below the lowest tick / above the highest), so a percentage-share series
  // always gets a 0 baseline and the domain itself - not just the tick list -
  // is widened to the next "nice" step past the real min/max.
  const includeZero = spec.unit === "%";
  const yDomain = lineAxisDomain(yValues, includeZero, 4);
  // Fix 4 (header/top-tick collision, house style only): lineAxisTicks
  // re-derives its own "nice" step from yDomain's already-rounded span, which
  // can land its top (or bottom) tick a half-step past yDomain itself - e.g.
  // a [0.5, 3.5] domain rounds to ticks [1, 2, 3, 4], and 4 > 3.5. Scaling
  // against yDomain alone then lets verticalScale extrapolate that tick's
  // gridline/label above `top` by construction - on viz-world.json, straight
  // into the header. Position the scale on whichever is wider, the nice
  // domain or the tick list's own extremes, so every drawn tick - not just
  // the plotted data - is guaranteed to land inside [top, bottom]. Legacy
  // keeps the old, narrower yDomain-only scale, byte-identical.
  const yTicks = lineAxisTicks(yDomain, 4, HOUSE_STYLE_ACTIVE);
  const yScaleDomain = HOUSE_STYLE_ACTIVE ? [Math.min(yDomain[0], yTicks[0]), Math.max(yDomain[1], yTicks[yTicks.length - 1])] : yDomain;
  const yScale = verticalScale(yScaleDomain, top, bottom);
  // Task A: monotone interpolation is only ever applied to a dense, regularly
  // spaced series (annual with no gaps, etc); a sparse/irregular series (e.g.
  // 2016/2018/2020/2023) always stays straight-segment with a marker at every
  // observation, regardless of spec.interpolation. Kept opt-in (not the
  // default) for now: see the task report for why.
  const regular = isRegularlySpaced(xValues);
  const useMonotone = regular && spec.interpolation === "monotone";
  const pointAnnotationAssignment = assignPointAnnotations(spec, rows, spec.value_field);
  const annotationsByRow = new Map();
  for (const [annotation, row] of pointAnnotationAssignment) {
    if (!annotationsByRow.has(row)) annotationsByRow.set(row, []);
    annotationsByRow.get(row).push(annotation);
  }
  // Fix 3: the unit shows once, on the top-most tick, not on every one -
  // see axisTickUnit.
  yTicks.forEach((tick, i) => {
    const y = yScale(tick);
    f.parts.push(`<line data-role="value-axis-tick" x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    f.parts.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick, axisTickUnit(spec.unit, i, yTicks.length)))}</text>`);
  });
  const labelEvery = Math.max(1, Math.ceil(xValues.length / 8));
  const directLabels = [];
  // Opt-in (NEWSROOM_LINE_TICK_AVOID_OVERLAP=1): the first and last labels
  // are kept; a label between them is dropped when its box would touch one
  // already kept. Every data point is still drawn; only labels are dropped.
  const avoidTickOverlap = process.env.NEWSROOM_LINE_TICK_AVOID_OVERLAP === "1";
  const tickLabelKept = new Set();
  if (avoidTickOverlap && xValues.length > 0) {
    const gap = 4;
    const boxOf = (i) => { const w = estimateTextWidth(String(xValues[i]), 12, false), c = xScale(xValues[i]); return [c - w / 2 - gap / 2, c + w / 2 + gap / 2]; };
    const placed = [0, xValues.length - 1].map((i) => boxOf(i));
    tickLabelKept.add(0); tickLabelKept.add(xValues.length - 1);
    for (let i = 1; i < xValues.length - 1; i++) {
      if (i % labelEvery !== 0) continue;
      const [a, b] = boxOf(i);
      if (placed.some(([pa, pb]) => a < pb && pa < b)) continue;
      placed.push([a, b]); tickLabelKept.add(i);
    }
  }
  xValues.forEach((xv, i) => {
    if (avoidTickOverlap ? !tickLabelKept.has(i) : (i % labelEvery !== 0 && i !== xValues.length - 1)) return;
    f.parts.push(`<text x="${xScale(xv)}" y="${bottom + 24}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xv)}</text>`);
  });
  // Fix 2: every end label in this chart (one per series) shares one
  // decimal count - resolved once, up front, from every series' final
  // value, not per-label. Axis ticks above already went through tickLabel()'s
  // own separate nice-number formatting and are unaffected by this.
  seriesNames.forEach((series, seriesIndex) => {
    const group = lineSeriesGroup(series);
    const highlighted = !multi || (spec.highlight_values ?? []).map(String).includes(String(series));
    // Fix 6 (house style only - legacy keeps its old accent2 stroke,
    // byte-identical): `highlighted` above stays true for a single-series
    // line by design (it's the only metric on the chart - full stroke
    // width, full marker opacity, unchanged) but that is not a signal to
    // color it with the accent: this line's *color* needs its own,
    // narrower check, the same one every non-line chart type already uses
    // for highlight_values (matching a plotted x-value/category, not a
    // series identity, which a lone series doesn't meaningfully have).
    // Absent that explicit signal (e.g. calling out the endpoint's
    // x-value), a single series reads as ink (#1A1A1A), not the mid-grey
    // "de-emphasised context series" colour (accent2) it used to hardcode
    // regardless of highlight_values.
    const singleSeriesHasAccent = HOUSE_STYLE_ACTIVE && !multi && (spec.highlight_values ?? []).map(String).some((v) => group.some((r) => String(r[spec.x_field]) === v));
    const stroke = multi ? (highlighted ? PALETTE.accent : PALETTE.context) : (HOUSE_STYLE_ACTIVE ? (singleSeriesHasAccent ? PALETTE.accent : PALETTE.ink) : PALETTE.accent2);
    const width = highlighted ? 2.5 : 1.5;
    const points = group.map((r) => ({ x: xScale(r[spec.x_field]), y: yScale(n(r[spec.value_field])) }));
    if (useMonotone) {
      f.parts.push(`<path data-role="line-path" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" d="${monotoneCubicPath(points)}" opacity="${highlighted ? 1 : 0.72}"/>`);
    } else {
      const coords = points.map((p) => `${p.x},${p.y}`).join(" ");
      f.parts.push(`<polyline data-role="line-path" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" points="${coords}" opacity="${highlighted ? 1 : 0.72}"/>`);
    }
    {
      // Marker restriction (Task A, extended by follow-up fix 5): a
      // sparse/irregular series always keeps a marker at every observation -
      // on EVERY series, including a grey non-highlighted context series,
      // not just the highlighted one - since a sparse series has too few
      // points for the line itself to read as a trend without them. A
      // dense regular series only marks its annotated points and its two
      // endpoints, so the smoothed line carries the eye instead of a row of
      // dots; that restriction still only applies to the highlighted (or
      // single) series - a dense grey context series stays markerless.
      const markerEvery = (!regular) || highlighted || !multi;
      group.forEach((r) => {
        const showMarker = markerEvery ? (!regular || r === group[0] || r === group[group.length - 1] || annotationsByRow.has(r)) : false;
        if (!showMarker) return;
        f.parts.push(`<circle data-role="line-point" cx="${xScale(r[spec.x_field])}" cy="${yScale(n(r[spec.value_field]))}" r="${highlighted || !multi ? 2.8 : 2}" fill="${stroke}" opacity="${highlighted || !multi ? 1 : 0.72}"/>`);
      });
    }
    // Point annotations for this chart type render once, via the
    // event-annotation lane/fallback below (eventLayout), not here - see
    // layoutEventAnnotations, which already dedups by annotation (not by
    // row) so a value shared across series at the same x cannot draw twice.
    const last = group[group.length - 1];
    if (last && multi && spec.direct_labels !== false) {
      // Task B: every series - including grey context series - gets its
      // exact value appended to its end label, not just its name.
      const name = resolveEconomyDisplayName(series, spec.category_names, vizLang(spec));
      const value = n(last[spec.value_field]);
      const valueText = value === null ? null : fmtSpec(spec, value, spec.unit, labelDecimals);
      const text = valueText === null ? name : `${name} ${valueText}`;
      const pointX = xScale(last[spec.x_field]);
      // The label now always carries its value appended (task B), which can
      // make it noticeably longer than the bare series name the 1032px cap
      // was tuned for, so the right-edge clamp shrinks with the label's own
      // estimated width - see layoutLineEndLabel (fix 5, house style only)
      // for what happens when even that clamp would push the label behind
      // its own point. Legacy, and the value === null case common to both
      // styles, keep this single clamped line exactly as before.
      const lines = HOUSE_STYLE_ACTIVE && valueText !== null
        ? layoutLineEndLabel(name, valueText, pointX, LAYOUT_W, 7, 6.8)
        : [{ text, x: Math.min(LAYOUT_W - 8 - textUnits(text) * 6.8, pointX + 7) }];
      directLabels.push({ lines, y: yScale(value) + 4, highlighted });
    }
    if (last && !multi && spec.direct_labels === true) {
      const endText = fmtSpec(spec, n(last[spec.value_field]), spec.unit, labelDecimals);
      const endX = Math.min(LAYOUT_W - 68, xScale(last[spec.x_field]) + 8), endY = yScale(n(last[spec.value_field])) - 8;
      const endAttrs = `font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.ink}"`;
      // Opt-in (NEWSROOM_LINE_END_LABEL_FIT=1): a single-line end label whose
      // estimated box would cross the right edge is split at its first space
      // (value above, unit below; no text is dropped or changed) and, when a
      // line still would not fit, both lines are right-aligned to the edge.
      const fit = process.env.NEWSROOM_LINE_END_LABEL_FIT === "1" ? fitLineEndLabel(endText, endX, LAYOUT_W) : null;
      if (fit) {
        fit.forEach((line, k) => f.parts.push(`<text data-role="direct-label" x="${line.x}" y="${endY - 14 * (fit.length - 1 - k)}"${line.anchor ? ` text-anchor="${line.anchor}"` : ""} ${endAttrs}>${esc(line.text)}</text>`));
      } else {
        f.parts.push(`<text data-role="direct-label" x="${endX}" y="${endY}" ${endAttrs}>${esc(endText)}</text>`);
      }
    }
  });
  if (multi && spec.direct_labels !== false) {
    // Fix 5: a label split across two lines (see layoutLineEndLabel) needs
    // more vertical room than a single line, both from the plot's own top
    // edge (its first line sits 14px above the anchor the de-collision pass
    // resolves) and from its neighbours - widen both only when this chart
    // actually has one, so every chart with no overflowing label keeps
    // exactly its old spacing.
    const anyTwoLine = directLabels.some((d) => d.lines.length > 1);
    const placed = separateLabelBaselines(directLabels, top + (anyTwoLine ? 21 : 7), bottom - 7, anyTwoLine ? 30 : 16);
    for (const label of placed) {
      const weight = label.highlighted ? 700 : 400, fill = label.highlighted ? PALETTE.ink : PALETTE.muted;
      if (label.lines.length === 1) {
        f.parts.push(`<text data-role="direct-label" x="${label.lines[0].x}" y="${label.labelY}" font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${fill}">${esc(label.lines[0].text)}</text>`);
      } else {
        // Name above, value+unit at the position a single-line label would
        // have used - the value is the more load-bearing half, so it keeps
        // lining up with the point the way every other end label's text does.
        // Each line may carry its own right-edge anchor (see
        // layoutLineEndLabel) instead of the shared start-anchored x.
        const anchor1 = label.lines[0].anchor === "end" ? ` text-anchor="end"` : "";
        const anchor2 = label.lines[1].anchor === "end" ? ` text-anchor="end"` : "";
        f.parts.push(`<text data-role="direct-label" x="${label.lines[0].x}" y="${label.labelY - 14}"${anchor1} font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${fill}">${esc(label.lines[0].text)}</text>`);
        f.parts.push(`<text data-role="direct-label" x="${label.lines[1].x}" y="${label.labelY}"${anchor2} font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${fill}">${esc(label.lines[1].text)}</text>`);
      }
    }
  }
  if (eventLayout.events.length) {
    eventLayout.events.forEach((e) => { e.eventY = yScale(n(e.dataRow[spec.value_field])); });
    if (hasLane) drawEventAnnotationLane(f.parts, eventLayout.events, rowY, bottom);
    else drawEventAnnotationFallback(f.parts, eventLayout.events, left, bottom + 44);
  }
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

// P4: stamp every <text> pushed to `parts` since `startIdx` with the box of the
// panel (its facet cell, out to the gutter that separates it from the next panel) it belongs to, so render QA's text_outside_panel can prove
// no label spills into a neighbouring panel. Pure attribute addition.
function tagPanelTexts(parts, startIdx, box) {
  const attr = ` data-panel-box="${box.map((v) => Number(v).toFixed(1)).join(",")}"`;
  for (let i = startIdx; i < parts.length; i++) {
    if (typeof parts[i] === "string" && parts[i].includes("<text ")) parts[i] = parts[i].replace(/<text (?![^>]*data-panel-box)/g, `<text${attr} `);
  }
}

// Index-panel labels (end value, 「基期 = 100」) go only where render QA's own estimate finds no data mark: the first
// candidate whose estimated box (padded 2 px) clears every polyline segment and point circle of the panel, the panel
// edges and the panel's other texts wins; no clear spot means no label, never one drawn over a mark.
function indexLabelBox(x, y, text, anchor, bold) {
  const w = estimateTextWidth(text, 12, bold), x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
  return { x: x0 - 2, y: y - 12 * ASCENT_RATIO - 2, w: w + 4, h: 12 * (ASCENT_RATIO + DESCENT_RATIO) + 4 };
}
function indexBoxClear(box, marks, bounds, others) {
  if (box.x < bounds[0] || box.x + box.w > bounds[2] || box.y < bounds[1] || box.y + box.h > bounds[3]) return false;
  if (others.some((o) => box.x < o.x + o.w && box.x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y)) return false;
  for (const c of marks.circles) {
    const nx = Math.min(Math.max(c.x, box.x), box.x + box.w), ny = Math.min(Math.max(c.y, box.y), box.y + box.h);
    if ((c.x - nx) ** 2 + (c.y - ny) ** 2 <= (c.r + 1) ** 2) return false;
  }
  for (const [a, b] of marks.segments) {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y, p = [-dx, dx, -dy, dy], q = [a.x - box.x, box.x + box.w - a.x, a.y - box.y, box.y + box.h - a.y];
    let hit = true;
    for (let k = 0; k < 4 && hit; k++) {
      if (p[k] === 0) { if (q[k] < 0) hit = false; continue; }
      const r = q[k] / p[k];
      if (p[k] < 0) { if (r > t1) hit = false; else if (r > t0) t0 = r; } else if (r < t0) hit = false; else if (r < t1) t1 = r;
    }
    if (hit) return false;
  }
  return true;
}
function placeIndexLabel(candidates, text, anchor, bold, marks, bounds, others) {
  for (const c of candidates) {
    const box = indexLabelBox(c.x, c.y, text, anchor, bold);
    if (indexBoxClear(box, marks, bounds, others)) return { x: c.x, y: c.y, box };
  }
  return null;
}

// The base period of a rebased index: the one x value at which every panel's value equals index_base (relative
// tolerance 1e-9). Returns { x } (first such x in axis order) or { missing: [panels...] }, naming the panels that
// do not hold the base period the most panels share (every panel when no panel holds the base at all).
const INDEX_BASE_TOLERANCE = 1e-9;
export function indexBasePeriod(spec, rows) {
  const base = n(spec.index_base);
  const facets = facetOrder(unique(rows.map((r) => r[spec.facet_field])));
  const holders = new Map();
  for (const facet of facets) {
    for (const r of rows) {
      if (String(r[spec.facet_field]) !== facet) continue;
      const v = n(r[spec.value_field]);
      if (v === null || Math.abs(v - base) > INDEX_BASE_TOLERANCE * Math.abs(base)) continue;
      const key = String(r[spec.x_field]);
      if (!holders.has(key)) holders.set(key, new Set());
      holders.get(key).add(facet);
    }
  }
  const common = [...holders.entries()].filter(([, set]) => set.size === facets.length).map(([key]) => key);
  if (common.length) {
    const order = sortX(unique(rows.map((r) => r[spec.x_field])));
    return { x: order.find((v) => common.includes(String(v))) };
  }
  const best = [...holders.values()].reduce((m, set) => (set.size > m.size ? set : m), new Set());
  return { missing: facets.filter((facet) => !best.has(facet)) };
}

function renderSmallMultiples(spec, rows, { labelRow = false } = {}) {
  const facets = facetOrder(unique(rows.map((r) => r[spec.facet_field])));
  // Rebased index panels (opt-in spec.index_base, e.g. 100): 7+ panels go 3-4
  // columns wide, every panel gets a labelled base line and an end value, and
  // the first column carries y tick labels.
  const indexBase = spec.panel_mark !== "dot" && n(spec.index_base) !== null && n(spec.index_base) > 0 ? n(spec.index_base) : null;
  const cols = facets.length === 1 ? 1 : indexBase !== null && facets.length >= 7 ? (facets.length >= 10 ? 4 : 3) : 2;
  const gapX = 34, gapY = 44;
  // a rebased index names its base period, never a bare "base": <x> = <base>, e.g. 2023-01 = 100
  let baseText = "";
  if (indexBase !== null) {
    const period = indexBasePeriod(spec, rows);
    if (period.missing) throw new Error(`INDEX_BASE_NOT_IN_DATA: no x value holds index_base ${indexBase} in every panel (panels without it: ${period.missing.join(", ")})`);
    baseText = VIZ_STRINGS[vizLang(spec)].indexBase(String(period.x), fmtSpec(spec, indexBase, "", 0));
  }
  // when no panel has a clear spot for the label it goes on its own row above the first row of panels
  const rowShift = labelRow ? 18 : 0;

  if (spec.panel_mark === "dot") {
    const groups = facets.map((facet) => rows.filter((r) => String(r[spec.facet_field]) === facet));
    const maxItems = Math.max(...groups.map((g) => g.length), 1);
    const refLines = referenceLineAnnotations(spec);
    const refMargin = referenceLineMargin(refLines);
    const panelW = 445;
    const panelH = Math.max(250, maxItems * 36 + 72) + refMargin;
    const rowsN = Math.ceil(facets.length / cols);
    const f = frame(spec, rowsN * panelH + Math.max(0, rowsN - 1) * gapY + 20);
    const allY = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
    let domain = extent(allY, true);
    if (spec.unit === "%" && Math.min(...allY) >= 0 && Math.max(...allY) <= 100) domain = [0, 100];

    facets.forEach((facet, fi) => {
      const col = fi % cols, rowN = Math.floor(fi / cols);
      const x0 = 54 + col * (panelW + gapX), y0 = f.bodyTop + rowN * (panelH + gapY);
      const facetPartStart = f.parts.length;
      const group = sortRows(rows.filter((r) => String(r[spec.facet_field]) === facet), spec, spec.value_field);
      const labelW = 150;
      const plotLeft = x0 + labelW, plotRight = x0 + panelW - 12;
      const plotBase = y0 + 38, plotTop = plotBase + refMargin, plotBottom = y0 + panelH - 34;
      const xScale = horizontalScale(domain, plotLeft, plotRight);
      f.parts.push(`<text x="${x0}" y="${y0 + 16}" font-family="${FONT_SANS}" font-size="15" font-weight="700" fill="${PALETTE.ink}">${esc(resolveEconomyDisplayName(facet, spec.category_names, vizLang(spec)))}</text>`);
      tickValues(domain, 2).forEach((tick) => {
        const x = xScale(tick);
        f.parts.push(`<line x1="${x}" y1="${plotTop - 4}" x2="${x}" y2="${plotBottom}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
        f.parts.push(`<text x="${x}" y="${plotTop - 10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick, spec.unit))}</text>`);
      });
      const step = Math.max(27, (plotBottom - plotTop) / Math.max(group.length, 1));
      group.forEach((r, i) => {
        const value = n(r[spec.value_field]); if (value === null) return;
        const y = plotTop + i * step + step * 0.48;
        const x = xScale(value);
        const category = String(r[spec.x_field] ?? "");
        const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
        f.parts.push(`<text x="${plotLeft - 9}" y="${y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(category)}</text>`);
        f.parts.push(`<line x1="${plotLeft}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1.5"/>`);
        f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted ? 6 : 4.8}" fill="${highlighted ? PALETTE.accent : PALETTE.accent2}"/>`);
        f.parts.push(`<text x="${x + 7}" y="${y + 4}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value, spec.unit))}</text>`);
        pointAnnotations(spec, r).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: "right", layout: f.annotationLayout }));
      });
      refLines.forEach((line, i) => {
        const x = xScale(line.value);
        f.parts.push(`<line data-role="reference-line" x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="${PALETTE.muted}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
        if (fi === 0) {
          const anchor = x > (plotLeft + plotRight) / 2 ? "end" : "start";
          // This layout draws its tick labels just above plotTop, inside the
          // reference-line band, so stack the labels above that tick row.
          const labelY = plotTop - 26 - (refLines.length - 1 - i) * 16;
          f.parts.push(`<text data-role="reference-line-label" x="${x + (anchor === "end" ? -5 : 5)}" y="${labelY}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(annotationLabel(line, 26))}</text>`);
        }
      });
      tagPanelTexts(f.parts, facetPartStart, [x0 - gapX + 2, y0 - gapY + 2, x0 + panelW + gapX - 2, y0 + panelH + gapY - 2]);
    });
    addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
  }

  const refLines = referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const idxLeft = indexBase !== null ? 54 + 40 : 70;
  const panelH = 230 + refMargin;
  const valuesOf = (list) => list.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  const domainOf = (values) => extent(indexBase !== null ? [...values, indexBase] : values, false);
  const allY = valuesOf(rows);
  const yDomain = domainOf(allY);
  // One facet whose range dwarfs the rest squashes every other panel on the shared scale: with at least 4 facets, no
  // reference line, and a shared span at least 3x the span without the facet that narrows it most, that facet moves to its
  // own panel under the grid (its own vertical scale, said in a note) and the rest share the narrower domain.
  // Default off (NEWSROOM_SMALL_MULTIPLES_OUTLIER_PANEL=1 turns it on): off, the SVG is byte-identical to what it was without this.
  const outlier = (() => {
    if (process.env.NEWSROOM_SMALL_MULTIPLES_OUTLIER_PANEL !== "1") return null;
    if (facets.length < 4 || refLines.length) return null;
    const span = (d) => d[1] - d[0];
    let best = null;
    for (const facet of facets) {
      const rest = valuesOf(rows.filter((r) => String(r[spec.facet_field]) !== String(facet)));
      if (!rest.length) continue;
      const domain = domainOf(rest);
      if (!best || span(domain) < span(best.domain)) best = { facet, domain };
    }
    if (!best || !(span(yDomain) >= 3 * span(best.domain))) return null;
    const own = valuesOf(rows.filter((r) => String(r[spec.facet_field]) === String(best.facet)));
    return own.length ? { ...best, ownDomain: domainOf(own) } : null;
  })();
  const gridFacets = outlier ? facets.filter((facet) => facet !== outlier.facet) : facets;
  const gridDomain = outlier ? outlier.domain : yDomain;
  // the grid's columns follow the facets that stay in it
  const gridCols = gridFacets.length === 1 ? 1 : indexBase !== null && gridFacets.length >= 7 ? (gridFacets.length >= 10 ? 4 : 3) : 2;
  const panelW = indexBase !== null && gridCols > 2 ? Math.floor((LAYOUT_W - 54 - idxLeft - (gridCols - 1) * gapX) / gridCols) : 430;
  const rowsN = Math.ceil(gridFacets.length / gridCols);
  const f = frame(spec, rowsN * panelH + Math.max(0, rowsN - 1) * gapY + (outlier ? gapY + panelH : 0) + 20 + rowShift);
  // an index panel puts its gridlines and labels at nice 1-2-5 values that include the base
  const ticksFor = (domain, nice = indexBase !== null) => {
    if (!nice) return [domain[0], (domain[0] + domain[1]) / 2, domain[1]];
    const span = domain[1] - domain[0] || 1, raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((c) => c >= raw);
    const out = [];
    for (let v = Math.ceil((domain[0] - 1e-9) / step) * step; v <= domain[1] + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
    if (indexBase !== null && !out.some((v) => Math.abs(v - indexBase) < step * 1e-6)) out.push(indexBase);
    return out.sort((a, b) => a - b);
  };
  const idxTicks = ticksFor(gridDomain);
  let indexBaseNamed = false;
  const drawFacet = (facet, fi, col, x0, y0, yDomain, idxTicks, panelW, axisLabels = false, boxLeft = x0 - gapX + 2) => {
    const facetPartStart = f.parts.length;
    const group = rows.filter((r) => String(r[spec.facet_field]) === facet);
    const xs = sortX(unique(group.map((r) => r[spec.x_field])));
    const xMap = new Map(xs.map((v, i) => [String(v), i]));
    const xScale = (value) => xs.length <= 1 ? x0 + panelW / 2 : x0 + (xMap.get(String(value)) / (xs.length - 1)) * panelW;
    const plotBase = y0 + 30;
    const yScale = verticalScale(yDomain, plotBase + refMargin, y0 + panelH - 30);
    f.parts.push(`<text x="${x0}" y="${y0 + 14}" font-family="${FONT_SANS}" font-size="14" font-weight="700" fill="${PALETTE.ink}">${esc(resolveEconomyDisplayName(facet, spec.category_names, vizLang(spec)))}</text>`);
    idxTicks.forEach((tick) => {
      const y = yScale(tick);
      f.parts.push(`<line x1="${x0}" y1="${y}" x2="${x0 + panelW}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
    });
    if (indexBase !== null) {
      const by = yScale(indexBase);
      f.parts.push(`<line data-role="index-base-line" x1="${x0}" y1="${by}" x2="${x0 + panelW}" y2="${by}" stroke="${PALETTE.muted}" stroke-width="1.2"/>`);
      if (col === 0 || axisLabels) {
        idxTicks.forEach((tick) => {
          f.parts.push(`<text data-role="value-axis-tick" x="${x0 - 6}" y="${yScale(tick) + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick, ""))}</text>`);
        });
      }
    }
    if (indexBase === null && axisLabels) {
      idxTicks.forEach((tick) => {
        f.parts.push(`<text data-role="value-axis-tick" x="${x0 - 6}" y="${yScale(tick) + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick, ""))}</text>`);
      });
    }
    const sorted = [...group].sort((a, b) => xMap.get(String(a[spec.x_field])) - xMap.get(String(b[spec.x_field])));
    if (xs.length > 1) {
      const coords = sorted.map((r) => `${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");
      f.parts.push(`<polyline fill="none" stroke="${PALETTE.accent2}" stroke-width="2.3" points="${coords}"/>`);
    }
    sorted.forEach((r) => {
      const x = xScale(r[spec.x_field]), y = yScale(n(r[spec.value_field]));
      f.parts.push(`<circle cx="${x}" cy="${y}" r="4.2" fill="${PALETTE.accent2}"/>`);
      pointAnnotations(spec, r).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: "right", layout: f.annotationLayout }));
    });
    if (indexBase !== null) {
      const pts = sorted.map((r) => ({ x: xScale(r[spec.x_field]), y: yScale(n(r[spec.value_field])) }));
      const marks = { circles: pts.map((p) => ({ x: p.x, y: p.y, r: 4.2 })), segments: xs.length > 1 ? pts.slice(1).map((p, i) => [pts[i], p]) : [] };
      const bounds = [x0, y0, x0 + panelW, y0 + panelH + 4];
      const others = [indexLabelBox(x0, y0 + 14, resolveEconomyDisplayName(facet, spec.category_names, vizLang(spec)), "start", true)];
      if (xs.length > 1) others.push(indexLabelBox(x0, y0 + panelH, String(xs[0]), "start", false), indexLabelBox(x0 + panelW, y0 + panelH, String(xs[xs.length - 1]), "end", false));
      const lv = sorted.length ? n(sorted[sorted.length - 1][spec.value_field]) : null;
      if (lv !== null) {
        const ey = yScale(lv), above = lv >= indexBase;
        const text = fmtSpec(spec, lv, "", 1), ex = x0 + panelW;
        const cands = [];
        for (const dy of above ? [-9, 17, -23, 31] : [17, -9, 31, -23]) for (const dx of [0, -14, -28, -42]) cands.push({ x: ex + dx, y: ey + dy });
        const spot = placeIndexLabel(cands, text, "end", true, marks, bounds, others);
        if (spot) {
          others.push(spot.box);
          f.parts.push(`<text data-role="index-end-value" x="${spot.x}" y="${spot.y}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.ink}">${esc(text)}</text>`);
        }
      }
      // the base is named once, in the first panel where a clear spot exists; every panel still draws the line
      if (!indexBaseNamed && !labelRow) {
        const by = yScale(indexBase), text = baseText;
        const cands = [];
        for (const fx of [0, 0.25, 0.5, 0.75]) for (const dy of [-5, 13, -19, 27]) cands.push({ x: x0 + 4 + fx * panelW, y: by + dy });
        const spot = placeIndexLabel(cands, text, "start", false, marks, bounds, others);
        if (spot) {
          indexBaseNamed = true;
          f.parts.push(`<text data-role="index-base-label" x="${spot.x}" y="${spot.y}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(text)}</text>`);
        }
      }
    }
    if (xs.length > 1) {
      f.parts.push(`<text x="${x0}" y="${y0 + panelH}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xs[0])}</text>`);
      f.parts.push(`<text x="${x0 + panelW}" y="${y0 + panelH}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xs[xs.length - 1])}</text>`);
    }
    refLines.forEach((line, i) => {
      const y = yScale(line.value);
      f.parts.push(`<line data-role="reference-line" x1="${x0}" y1="${y}" x2="${x0 + panelW}" y2="${y}" stroke="${PALETTE.muted}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
      if (fi === 0) {
        f.parts.push(`<text data-role="reference-line-label" x="${x0}" y="${referenceLineRowY(plotBase, i)}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(annotationLabel(line, 34))}</text>`);
      }
    });
    tagPanelTexts(f.parts, facetPartStart, [boxLeft, y0 - gapY + 2, x0 + panelW + gapX - 2, y0 + panelH + gapY - 2]);
  };
  gridFacets.forEach((facet, fi) => {
    const col = fi % gridCols, rowN = Math.floor(fi / gridCols);
    drawFacet(facet, fi, col, idxLeft + col * (panelW + gapX), f.bodyTop + rowShift + rowN * (panelH + gapY), gridDomain, idxTicks, panelW);
  });
  if (outlier) {
    const gridW = gridCols * panelW + (gridCols - 1) * gapX;
    const y0 = f.bodyTop + rowShift + rowsN * (panelH + gapY);
    const name = resolveEconomyDisplayName(outlier.facet, spec.category_names, vizLang(spec));
    // y labels come from tickValues on the panel's own domain: at least 3 inside it, plus the base when one is set
    let ownTicks = [];
    for (const count of [4, 6, 8, 12, 16, 24]) {
      ownTicks = tickValues(outlier.ownDomain, count).filter((v) => v >= outlier.ownDomain[0] - 1e-9 && v <= outlier.ownDomain[1] + 1e-9);
      if (ownTicks.length >= 3) break;
    }
    if (ownTicks.length < 3) ownTicks = [outlier.ownDomain[0], (outlier.ownDomain[0] + outlier.ownDomain[1]) / 2, outlier.ownDomain[1]];
    if (indexBase !== null && !ownTicks.some((v) => Math.abs(v - indexBase) < 1e-9 * Math.max(1, Math.abs(indexBase)))) ownTicks.push(indexBase);
    ownTicks.sort((a, b) => a - b);
    // keep the widest y label 2 px inside the panel box: move the panel's left edge right by any shortfall
    const boxLeft = idxLeft - gapX + 2;
    const labelW = Math.max(...ownTicks.map((tick) => estimateTextWidth(tickLabelSpec(spec, tick, ""), 12, false)));
    const shift = Math.max(0, Math.ceil(boxLeft + 2 + 6 + 2 + labelW - idxLeft));
    const x0 = idxLeft + shift;
    const noteStart = f.parts.length;
    const note = vizLang(spec) === "zh" ? `${name}与其他各项数值相差悬殊，单独成图，纵轴刻度与上面各图不同` : `${name} is far outside the others' range, so it has its own panel with a different vertical scale.`;
    f.parts.push(`<text data-role="outlier-note" x="${x0}" y="${y0 - 14}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(note)}</text>`);
    tagPanelTexts(f.parts, noteStart, [boxLeft, y0 - gapY + 2, idxLeft + gridW + gapX - 2, y0 + panelH + gapY - 2]);
    drawFacet(outlier.facet, gridFacets.length, 0, x0, y0, outlier.ownDomain, ownTicks, gridW - shift, true, boxLeft);
  }
  if (indexBase !== null && !indexBaseNamed) {
    if (!labelRow) return renderSmallMultiples(spec, rows, { labelRow: true });
    f.parts.push(`<text data-role="index-base-label" x="${idxLeft}" y="${f.bodyTop + 12}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(baseText)}</text>`);
  }
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderScatter(spec, rows) {
  const f = frame(spec, 420);
  const left = 100, right = 930, top = f.bodyTop + 10, bottom = f.bodyBottom - 66;
  const xs = rows.map((r) => n(r[spec.x_field])).filter((v) => v !== null);
  const ys = rows.map((r) => n(r[spec.y_field])).filter((v) => v !== null);
  const xInfo = makeScale(xs, left, right, spec.x_scale ?? "linear");
  const yRaw = spec.y_scale === "log" ? ys.map(Math.log10) : ys;
  const yDomainRaw = extent(yRaw, false);
  const yLinear = verticalScale(yDomainRaw, top, bottom);
  const yScale = (value) => yLinear(spec.y_scale === "log" ? Math.log10(value) : value);
  const yTicks = spec.y_scale === "log" ? logTickValues(yDomainRaw) : tickValues(yDomainRaw, 4);
  yTicks.forEach((tick) => {
    const y = yScale(tick); f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}"/>`);
    f.parts.push(`<text x="${left - 12}" y="${y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick, spec.y_unit ?? spec.unit))}</text>`);
  });
  xInfo.ticks.forEach((tick) => {
    const x = xInfo.scale(tick); f.parts.push(`<text x="${x}" y="${bottom + 24}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabel(tick, spec.x_unit ?? "", vizLang(spec)))}</text>`);
  });
  if (spec.x_label) f.parts.push(`<text x="${(left + right) / 2}" y="${bottom + 50}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.x_label)}</text>`);
  if (spec.y_label) f.parts.push(`<text x="18" y="${(top + bottom) / 2}" transform="rotate(-90 18 ${(top + bottom) / 2})" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.y_label)}</text>`);
  rows.forEach((row) => {
    const x = n(row[spec.x_field]), y = n(row[spec.y_field]); if (x === null || y === null) return;
    const label = spec.label_field ? String(row[spec.label_field] ?? "") : "";
    const highlighted = label && (spec.highlight_values ?? []).map(String).includes(label);
    const px=xInfo.scale(x), py=yScale(y);
    f.parts.push(`<circle cx="${px}" cy="${py}" r="${highlighted ? 6 : 4}" fill="${highlighted ? PALETTE.accent : PALETTE.accent2}" opacity="${highlighted ? 1 : 0.68}"/>`);
    if (highlighted) {
      const labelSide = px > right - 150 ? "left" : "right";
      // The raw value stays the point's identity (the highlight match above); what is measured, laid out and drawn is its resolved name.
      const shownLabel = resolveEconomyDisplayName(label, spec.category_names, vizLang(spec));
      const placedLabel = f.annotationLayout.place(px, py, shownLabel, labelSide, 1);
      if (Math.abs(placedLabel.ty - (py - 13)) > 10) {
        const leaderEnd = leaderEndShortOfLabel(px, py, placedLabel);
        f.parts.push(`<line data-role="direct-label-leader" x1="${px}" y1="${py}" x2="${leaderEnd.x2}" y2="${leaderEnd.y2}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);
      }
      f.parts.push(`<text data-role="direct-label" x="${placedLabel.tx}" y="${placedLabel.ty}" text-anchor="${placedLabel.anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.ink}">${esc(shownLabel)}</text>`);
    }
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, px, py, { side: px > right - 180 ? "left" : "right", layout: f.annotationLayout, maxChars: 38, maxLines: 3 }));
  });
  // Auto labels (a scatter of many points names only its outliers): the two
  // extremes on each axis (up to 8 distinct points, most extreme first), after
  // the highlighted entities, capped so labelled points total about 8. Same
  // collision-avoiding placer and leader as the highlighted labels.
  const autoLabelField = spec.label_field ?? spec.category_field;
  if (autoLabelField) {
    const lang = vizLang(spec);
    const highlightSet = new Set((spec.highlight_values ?? []).map(String));
    const pts = rows.map((row) => ({ row, x: n(row[spec.x_field]), y: n(row[spec.y_field]), label: String(row[autoLabelField] ?? "") })).filter((p) => p.x !== null && p.y !== null && p.label);
    const shown = new Set(pts.filter((p) => highlightSet.has(p.label)).map((p) => p.label));
    const byX = [...pts].sort((a, b) => b.x - a.x), byY = [...pts].sort((a, b) => b.y - a.y);
    const order = [];
    for (let k = 0; k < 2; k++) order.push(byX[k], byX[byX.length - 1 - k], byY[k], byY[byY.length - 1 - k]);
    const MAX_LABELLED = 8;
    for (const p of order) {
      if (!p || shown.size >= MAX_LABELLED) continue;
      if (shown.has(p.label)) continue;
      shown.add(p.label);
      const px = xInfo.scale(p.x), py = yScale(p.y);
      const labelSide = px > right - 150 ? "left" : "right";
      const text = resolveEconomyDisplayName(p.label, spec.category_names, lang);
      const placedLabel = f.annotationLayout.place(px, py, text, labelSide, 1);
      if (Math.hypot(placedLabel.tx - px, placedLabel.ty - py) > 28) {
        const leaderEnd = leaderEndShortOfLabel(px, py, placedLabel);
        f.parts.push(`<line data-role="direct-label-leader" x1="${px}" y1="${py}" x2="${leaderEnd.x2}" y2="${leaderEnd.y2}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);
      }
      f.parts.push(`<text data-role="auto-label" x="${placedLabel.tx}" y="${placedLabel.ty}" text-anchor="${placedLabel.anchor}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(text)}</text>`);
    }
  }
  // 对数刻度 / log scale: said once per log axis. An axis title or the subtitle
  // that already says it counts; the chart then adds nothing of its own.
  {
    const logWord = VIZ_STRINGS[vizLang(spec)].logScale;
    const said = (text) => String(text ?? "").includes(logWord);
    if (spec.x_scale === "log" && !said(spec.x_label) && !said(spec.subtitle)) f.parts.push(`<text x="${right}" y="${bottom + 50}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${logWord}</text>`);
    if (spec.y_scale === "log" && !said(spec.y_label) && !said(spec.subtitle)) f.parts.push(`<text x="${left}" y="${top - 8}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${logWord}</text>`);
  }
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

// Desktop heatmap tidy-up (exact "1", default off): the colour domain and legend ends are the data's own min and max,
// cells carry bare numbers on the shared decimal count, and the unit is said once beside the legend.
function heatmapTidyEnabled(){ return process.env.NEWSROOM_HEATMAP_TIDY==="1"; }
// Shared decimal count of the tidy heatmap (cells and legend); render QA re-derives the expected cell text from it.
function heatmapTidyDecimals(spec, vals){ return resolveChartDecimals(spec, vals) ?? (Number.isInteger(spec.decimals) ? spec.decimals : 1); }
// What a heatmap cell prints for a value, exactly as renderHeatmap spells it (render QA proves it against the SVG).
export function heatmapCellText(spec, rows, value){
  const vals=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null);
  return heatmapTidyEnabled() ? fmtSpec(spec, value, "", heatmapTidyDecimals(spec, vals)) : fmtSpec(spec, value, spec.unit);
}
// NEWSROOM_HEATMAP_VALUE_LABELS=1 (exact "1"): desktop cells carry data-role/data-x/data-y/data-value so render QA can prove
// every cell shows its value (editorial_validators.mjs heatmapValueLabelsProven).
function heatmapValueLabelsEnabled(){ return process.env.NEWSROOM_HEATMAP_VALUE_LABELS==="1"; }

function renderHeatmap(spec, rows) {
  const xs = unique(rows.map((r) => r[spec.x_field]));
  const ys = unique(rows.map((r) => r[spec.y_field]));
  const bodyHeight = Math.max(300, ys.length * 34 + 75);
  const f = frame(spec, bodyHeight);
  const left = 190, right = 950, top = f.bodyTop + 35, bottom = f.bodyBottom - 40;
  const cellW = (right - left) / Math.max(1, xs.length), cellH = (bottom - top) / Math.max(1, ys.length);
  const vals = rows.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  const tidy = heatmapTidyEnabled();
  const [min, max] = tidy ? [Math.min(...vals), Math.max(...vals)] : extent(vals, false);
  const tidyDecimals = tidy ? heatmapTidyDecimals(spec, vals) : null;
  const proofOn = heatmapValueLabelsEnabled();
  const index = new Map(rows.map((r) => [`${r[spec.x_field]}\u0000${r[spec.y_field]}`, n(r[spec.value_field])]));
  const mixChannels = (t) => {
    const a = [242, 243, 244], b = [209, 73, 63];
    return a.map((v, i) => Math.round(v + (b[i] - v) * clamp(t, 0, 1)));
  };
  const mix = (t) => {
    const c = mixChannels(t);
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  xs.forEach((xv, xi) => f.parts.push(`<text x="${left + (xi + 0.5) * cellW}" y="${top - 10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xv)}</text>`));
  ys.forEach((yv, yi) => {
    f.parts.push(`<text x="${left - 10}" y="${top + (yi + 0.5) * cellH + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(yv)}</text>`);
    xs.forEach((xv, xi) => {
      const value = index.get(`${xv}\u0000${yv}`); if (value === null || value === undefined) return;
      const t = (value - min) / (max - min || 1);
      const x = left + xi * cellW, y = top + yi * cellH;
      const cellAttrs = proofOn ? ` data-role="heatmap-cell" data-x="${esc(xv)}" data-y="${esc(yv)}" data-value="${value}"` : "";
      f.parts.push(`<rect${cellAttrs} x="${x + 1}" y="${y + 1}" width="${Math.max(1, cellW - 2)}" height="${Math.max(1, cellH - 2)}" fill="${mix(t)}"/>`);
      if (cellW > 48 && cellH > 30) {
        const style = labelStyleOnFill(mixChannels(t));
        const halo = style.halo ? ` stroke="${style.halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"` : "";
        f.parts.push(`<text${proofOn ? ` data-role="heatmap-cell-value" data-x="${esc(xv)}" data-y="${esc(yv)}"` : ""} x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${style.fill}"${halo}>${esc(tidy ? fmtSpec(spec, value, "", tidyDecimals) : fmtSpec(spec, value, spec.unit))}</text>`);
      }
    });
  });
  const legendY=bottom+13, legendW=150;
  f.parts.push(`<defs><linearGradient id="heatmap-grad-d" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="${mix(0)}"/><stop offset="100%" stop-color="${mix(1)}"/></linearGradient></defs>`);
  f.parts.push(`<rect data-role="heatmap-legend" x="${left}" y="${legendY}" width="${legendW}" height="8" fill="url(#heatmap-grad-d)"/>`);
  if (tidy) {
    const legendText = (x, anchor, v) => `<text x="${x}" y="${legendY+22}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtSpec(spec, v, "", tidyDecimals))}</text>`;
    f.parts.push(legendText(left, "start", min), legendText(left+legendW/2, "middle", (min+max)/2), legendText(left+legendW, "end", max));
    if (spec.unit) f.parts.push(`<text data-role="heatmap-unit" x="${left+legendW+16}" y="${legendY+8}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(`${vizLang(spec)==="zh"?"单位：":"Unit: "}${spec.unit}`)}</text>`);
  } else {
  f.parts.push(`<text x="${left}" y="${legendY+22}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtSpec(spec, min,spec.unit))}</text>`);
  f.parts.push(`<text x="${left+legendW}" y="${legendY+22}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtSpec(spec, max,spec.unit))}</text>`);
  }
  addFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}


// ===========================================================================
// strip_plot: a dot strip plot. One row per group on one shared linear value
// axis and one dot per unit inside the group - "how spread out is each group,
// and where are the extremes?". The FT Visual Vocabulary files it under
// Distribution and Datawrapper draws its range/strip plots the same way. The
// form is generic: groups, units and values are named by role
// (category_field / label_field / value_field), never by topic.
//
// Text the chart prints: the group names (row labels), the axis ticks, the
// median key, and at most STRIP_MAX_LABEL_EXTREMES "name value" labels whose
// value is the unit's own value_field value through fmtSpec. The per-group
// median (and the jitter offset) are derived, so they are drawn as marks only
// and never printed.
//
// Everything below is deterministic: jitter offsets come from a sha256 of the
// unit's label and row index, the beeswarm is a greedy dodge, and the extreme
// labels are placed by a fixed candidate search - no Math.random anywhere.
// The label search measures text with the same width tables the render-QA
// geometry check uses (imported, not copied), so a label it accepts is one
// that check accepts too.
// ===========================================================================
const STRIP_GROUP_ORDERS = ["median_desc", "median_asc", "data"];
const STRIP_POINT_LAYOUTS = ["jitter", "beeswarm"]; // point_layout: "beeswarm" is the default, "jitter" the opt-in
const STRIP_MAX_LABEL_EXTREMES = 6;
const STRIP_DEFAULT_LABEL_EXTREMES = 4;
const STRIP_MAX_GROUPS = 40;
const STRIP_WARN_GROUPS = 30;
const STRIP_MAX_POINTS = 600;
const STRIP_DOT_RADIUS = 3;
const STRIP_DOT_OPACITY = 0.5;
const STRIP_FONT_SIZE = 12;
const STRIP_LABEL_WEIGHT = 600;
// Row band: 480px of rows shared by the groups, never thinner than 17px (a
// 35-row chart is 17px per row) and never fatter than 28px, so a chart with
// more rows grows taller instead of squeezing its rows.
const STRIP_BAND_TARGET = 480;
const STRIP_MIN_BAND = 17;
const STRIP_MAX_BAND = 28;
const STRIP_MAX_JITTER = 9;
const STRIP_TICK_TARGET = 6;
const STRIP_MIN_PLOT_WIDTH = 360;
// Extreme-label search: the label sits STRIP_LABEL_GAP px from the dot's edge
// (no leader) or, when that spot is taken, further out along one of
// STRIP_LABEL_TURNS directions in STRIP_LABEL_STEP px steps, with a short
// leader once it no longer touches the dot.
const STRIP_LABEL_GAP = 4;
const STRIP_LABEL_STEP = 6;
const STRIP_LABEL_STEPS = 24;
const STRIP_LABEL_TURNS = 24;
// Extra px reserved right of a high label so rounding never pushes it past the limit.
const STRIP_LABEL_SLACK = 3;
// Label layout search: candidates tried per label at each level, and the total
// number of placements it may try before settling for the first-choice layout.
const STRIP_SEARCH_BREADTH = 10;
const STRIP_SEARCH_BUDGET = 20000;
// Same literal as WIDE_CHAR_RE in render_qa_geometry.mjs (not exported there):
// CJK, kana, hangul and full-width forms all measure one em wide.
const STRIP_WIDE_CHAR_RE = /[　-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿＀-￯]/;
// render_qa_geometry.mjs FALLBACK_LATIN_WIDTH (not exported there): the width
// it assumes for a character missing from both advance-width tables.
const STRIP_FALLBACK_LATIN_WIDTH = 1.02;

// Lint for the strip_plot-only rules. The generic rules (non-finite or missing
// value, unknown fields, ...) stay in lintVizSpec; the field-value rules
// (label_extremes, group_order, ...) are validateVizSpec errors, which
// lintVizSpec already turns into blockers.
function lintStripPlotSpec(spec, rows) {
  const blockers = [];
  const warnings = [];
  const list = Array.isArray(rows) ? rows : [];
  const groupCount = new Set(list.map((row) => String(row?.[spec.category_field] ?? "")).filter(Boolean)).size;
  if (groupCount > STRIP_MAX_GROUPS) blockers.push(`strip_plot has ${groupCount} groups; maximum is ${STRIP_MAX_GROUPS}`);
  else if (groupCount > STRIP_WARN_GROUPS) warnings.push(`strip_plot has ${groupCount} groups; more than ${STRIP_WARN_GROUPS} rows are hard to read`);
  if (list.length > STRIP_MAX_POINTS) blockers.push(`strip_plot has ${list.length} points; maximum is ${STRIP_MAX_POINTS}`);
  const extremes = spec.label_extremes ?? STRIP_DEFAULT_LABEL_EXTREMES;
  if (Number.isInteger(extremes) && extremes > 0) {
    if (!spec.label_field) warnings.push("strip_plot label_extremes is above 0 but no label_field is set, so no extreme labels are drawn");
    else if (!fieldExists(list, spec.label_field)) warnings.push(`strip_plot label_field '${spec.label_field}' is absent from the rows, so no extreme labels are drawn`);
  }
  return { blockers, warnings };
}

// Text size exactly as render_qa_geometry.mjs estimates it (same tables, same
// 1.05 safety margin, same bold switch), so label placement and the QA gate
// agree on every box.
function stripTextWidth(text, bold) {
  const table = bold ? QA_LATIN_BOLD_ADVANCE_WIDTHS : QA_LATIN_ADVANCE_WIDTHS;
  let units = 0;
  for (const ch of Array.from(String(text))) {
    if (/\s/.test(ch)) units += QA_TEXT_WIDTH_FACTORS.space;
    else if (STRIP_WIDE_CHAR_RE.test(ch)) units += QA_TEXT_WIDTH_FACTORS.cjk;
    else units += table[ch] ?? STRIP_FALLBACK_LATIN_WIDTH;
  }
  return units * STRIP_FONT_SIZE * QA_TEXT_WIDTH_FACTORS.safetyMargin;
}

function stripTextBox(text, x, baseline, anchor, bold) {
  const width = stripTextWidth(text, bold);
  const x0 = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
  return { x0, x1: x0 + width, y0: baseline - STRIP_FONT_SIZE * QA_ASCENT_RATIO, y1: baseline + STRIP_FONT_SIZE * QA_DESCENT_RATIO };
}

function stripBoxesOverlap(a, b, pad = 0) {
  return a.x0 - pad < b.x1 && a.x1 + pad > b.x0 && a.y0 - pad < b.y1 && a.y1 + pad > b.y0;
}

function stripCircleHitsBox(circle, box, pad = 0) {
  const nearestX = Math.max(box.x0 - pad, Math.min(circle.x, box.x1 + pad));
  const nearestY = Math.max(box.y0 - pad, Math.min(circle.y, box.y1 + pad));
  return Math.hypot(circle.x - nearestX, circle.y - nearestY) <= circle.r;
}

// Liang-Barsky clip of the segment a-b against the box grown by pad.
function stripSegmentHitsBox(a, b, box, pad = 0) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - (box.x0 - pad)) && clip(dx, box.x1 + pad - a.x) && clip(-dy, a.y - (box.y0 - pad)) && clip(dy, box.y1 + pad - a.y);
}

function stripSegmentsCross(a1, a2, b1, b2) {
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(b1, b2, a1), d2 = side(b1, b2, a2), d3 = side(a1, a2, b1), d4 = side(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function stripPointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// The median of an ascending, non-empty list. It orders the rows and places
// the median tick; it is never printed.
function stripMedian(sorted) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Value axis: starts at 0 when every value is >= 0 and the smallest is below a
// quarter of the largest (a zero baseline then costs the dots no resolution);
// otherwise at a rounded value strictly below the smallest. The top end is a
// rounded value strictly above the largest. Ticks are integer multiples of one
// {1,2,5}x10^k step, so none is float noise like 0.30000000000000004.
function stripAxis(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fromZero = min >= 0 && min < max / 4;
  const span = fromZero ? max : (max > min ? max - min : Math.max(Math.abs(max), 1));
  const step = niceAxisStep(span / STRIP_TICK_TARGET);
  let first = fromZero ? 0 : Math.floor(min / step);
  if (!fromZero && first * step >= min) first -= 1;
  let last = Math.ceil(max / step);
  if (last * step <= max) last += 1;
  const ticks = [];
  for (let k = first; k <= last; k++) ticks.push(Number((k * step).toPrecision(12)));
  return { lo: ticks[0], hi: ticks[ticks.length - 1], step, ticks };
}

// A reproducible number in [0, 1) from a seed string (jitter offsets).
function stripHashUnit(seed) {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) / 4294967296;
}

// Greedy beeswarm dodge inside one row band. Dots are placed left to right;
// each takes the lane (vertical offset, whole pixels, centre lane first and
// alternating sides) nearest the row centre where it clears every dot already
// placed, or the lane with the most clearance when the band is too tight.
function stripBeeswarmOffsets(xs, amp, minDistance) {
  const order = xs.map((_x, i) => i).sort((a, b) => xs[a] - xs[b] || a - b);
  const lanes = [0];
  for (let k = 1; k <= Math.floor(amp); k++) lanes.push(k, -k);
  const placed = [];
  const offsets = new Array(xs.length).fill(0);
  order.forEach((i, rank) => {
    let chosen = 0, chosenGap = -1;
    for (const lane of lanes) {
      const y = rank % 2 === 1 ? -lane : lane;
      let gap = Infinity;
      for (const other of placed) gap = Math.min(gap, Math.hypot(other.x - xs[i], other.y - y));
      if (gap >= minDistance) { chosen = y; chosenGap = gap; break; }
      if (gap > chosenGap) { chosen = y; chosenGap = gap; }
    }
    offsets[i] = chosen;
    placed.push({ x: xs[i], y: chosen });
  });
  return offsets;
}

// Every position an extreme label may take, cheapest first. The label is set
// at distance d from its dot's centre along one of STRIP_LABEL_TURNS evenly
// spaced directions, reading rightwards when the direction points right and
// leftwards otherwise, and always keeps STRIP_LABEL_GAP px clear of its own
// dot. Cost grows with the distance and with the turn away from "straight to
// the right"; a label that does not touch its dot gets a leader that stops 2px
// before the text.
function stripLabelCandidates(label) {
  const dot = label.dot;
  const bold = STRIP_LABEL_WEIGHT >= QA_BOLD_WEIGHT_THRESHOLD;
  const found = [];
  const round2 = (value) => Math.round(value * 100) / 100;
  for (let s = 0; s < STRIP_LABEL_STEPS; s++) {
    const d = STRIP_DOT_RADIUS + STRIP_LABEL_GAP + s * STRIP_LABEL_STEP;
    for (let k = 0; k < STRIP_LABEL_TURNS; k++) {
      const turn = (k < STRIP_LABEL_TURNS / 2 ? k : k - STRIP_LABEL_TURNS) * (360 / STRIP_LABEL_TURNS);
      const rad = (turn * Math.PI) / 180;
      const ux = Math.round(Math.cos(rad) * 1e4) / 1e4;
      const uy = Math.round(Math.sin(rad) * 1e4) / 1e4;
      const anchor = ux >= -0.01 ? "start" : "end";
      const tx = round2(dot.x + d * ux);
      const baseline = round2(dot.y + d * uy + 4);
      const box = stripTextBox(label.text, tx, baseline, anchor, bold);
      const nearX = Math.max(box.x0, Math.min(dot.x, box.x1));
      const nearY = Math.max(box.y0, Math.min(dot.y, box.y1));
      const near = Math.hypot(nearX - dot.x, nearY - dot.y);
      if (near < STRIP_DOT_RADIUS + STRIP_LABEL_GAP - 0.01) continue;
      const touching = near <= STRIP_DOT_RADIUS + STRIP_LABEL_GAP + 1;
      let leader = null;
      if (!touching) {
        const end = { x: anchor === "start" ? box.x0 - 2 : box.x1 + 2, y: baseline - 4 };
        const length = Math.hypot(end.x - dot.x, end.y - dot.y);
        const f = (STRIP_DOT_RADIUS + 0.8) / length;
        leader = { a: { x: dot.x + (end.x - dot.x) * f, y: dot.y + (end.y - dot.y) * f }, b: end };
      }
      found.push({ tx, baseline, anchor, box, leader, cost: d + 0.2 * Math.abs(turn) + (touching ? 0 : 6) + (anchor === "end" ? 1 : 0) });
    }
  }
  return found.sort((a, b) => a.cost - b.cost);
}

// Constraints that depend only on what is already on the page (dots, fixed
// text, median ticks, the label bounds). strict: a leader may not pass within a
// dot's radius (+1.5px) of any other dot or cross a median tick; the relaxed
// test drops only those two rules. A label never overlaps a dot, other text or
// a median tick, and a leader never crosses text, in either test.
function stripCandidateFitsFixed(candidate, label, ctx, strict) {
  const { box, leader } = candidate;
  const b = ctx.bounds;
  if (box.x0 < b.x0 || box.x1 > b.x1 || box.y0 < b.y0 || box.y1 > b.y1) return false;
  for (const circle of ctx.circles) if (stripCircleHitsBox(circle, box, 1.5)) return false;
  for (const other of ctx.boxes) if (stripBoxesOverlap(box, other, 2)) return false;
  for (const tick of ctx.segments) if (stripSegmentHitsBox(tick.a, tick.b, box, 1.5)) return false;
  if (!leader) return true;
  if (stripSegmentHitsBox(leader.a, leader.b, box, 1.5)) return false;
  for (const other of ctx.boxes) if (stripSegmentHitsBox(leader.a, leader.b, other, 1.5)) return false;
  if (strict) {
    for (const circle of ctx.circles) {
      if (circle === label.dot) continue;
      if (stripPointSegmentDistance(circle, leader.a, leader.b) < circle.r + 1.5) return false;
    }
    for (const tick of ctx.segments) if (stripSegmentsCross(leader.a, leader.b, tick.a, tick.b)) return false;
  }
  return true;
}

// Constraints against the labels already placed: no overlapping text, no label
// on another label's leader, no leader across another label's text or leader.
function stripCandidateFitsPlaced(candidate, placed) {
  const { box, leader } = candidate;
  for (const other of placed) {
    if (stripBoxesOverlap(box, other.box, 2)) return false;
    if (other.leader && stripSegmentHitsBox(other.leader.a, other.leader.b, box, 1.5)) return false;
    if (!leader) continue;
    if (stripSegmentHitsBox(leader.a, leader.b, other.box, 1.5)) return false;
    if (other.leader && stripSegmentsCross(leader.a, leader.b, other.leader.a, other.leader.b)) return false;
  }
  return true;
}

// Places the labels (highest values first, then lowest). Each label has its
// candidates in preference order - strict ones before relaxed ones, cheapest
// first. The labels are placed one after another at their first candidate that
// clears the labels already placed; when a later label is left with no
// position, the search backs up and gives an earlier label its next candidate
// (depth first, STRIP_SEARCH_BREADTH candidates per label, STRIP_SEARCH_BUDGET
// steps in all, so the layout is always the same for the same input). Whenever
// the first choices already work the result is exactly that first-choice
// layout. A label that still has no position is left out rather than drawn over
// something.
function stripPlaceLabels(labels, ctx) {
  const options = labels.map((label) => {
    const strict = [];
    const relaxed = [];
    for (const candidate of stripLabelCandidates(label)) {
      if (!stripCandidateFitsFixed(candidate, label, ctx, false)) continue;
      (stripCandidateFitsFixed(candidate, label, ctx, true) ? strict : relaxed).push(candidate);
    }
    return [...strict, ...relaxed];
  });
  const omitted = labels.filter((_label, i) => options[i].length === 0);
  const todo = labels.map((_label, i) => i).filter((i) => options[i].length > 0);
  const picks = [];
  let budget = STRIP_SEARCH_BUDGET;
  const search = (depth) => {
    if (depth === todo.length) return true;
    let tried = 0;
    for (const candidate of options[todo[depth]]) {
      if (budget <= 0 || tried >= STRIP_SEARCH_BREADTH) return false;
      if (!stripCandidateFitsPlaced(candidate, picks)) continue;
      tried++;
      budget--;
      picks.push(candidate);
      if (search(depth + 1)) return true;
      picks.pop();
    }
    return false;
  };
  if (search(0)) return { placed: picks.map((candidate, k) => ({ label: labels[todo[k]], ...candidate })), omitted };
  const placed = [];
  for (const i of todo) {
    const candidate = options[i].find((option) => stripCandidateFitsPlaced(option, placed));
    if (candidate) placed.push({ label: labels[i], ...candidate });
    else omitted.push(labels[i]);
  }
  return { placed, omitted };
}

function renderStripPlot(spec, rows) {
  const lang = vizLang(spec);
  const strings = VIZ_STRINGS[lang];
  const categoryField = spec.category_field;
  const valueField = spec.value_field;
  const labelField = spec.label_field && fieldExists(rows, spec.label_field) ? spec.label_field : null;
  const order = STRIP_GROUP_ORDERS.includes(spec.group_order) ? spec.group_order : "median_desc";
  const layout = spec.point_layout === "jitter" ? "jitter" : "beeswarm"; // beeswarm unless jitter is asked for
  const showMedian = spec.show_median !== false;
  const extremeCount = Number.isInteger(spec.label_extremes) ? spec.label_extremes : STRIP_DEFAULT_LABEL_EXTREMES;
  const highlight = new Set((Array.isArray(spec.highlight_values) ? spec.highlight_values : []).map(String));
  const q = (value) => Math.round(value * 100) / 100;
  const r = STRIP_DOT_RADIUS;

  // Units, then groups (rows). A unit without a group name or a finite value
  // is not drawn (lintVizSpec blocks a non-finite value before this point).
  const points = [];
  rows.forEach((row, index) => {
    const group = String(row[categoryField] ?? "");
    const value = n(row[valueField]);
    if (!group || value === null) return;
    points.push({ index, group, value, name: labelField ? String(row[labelField] ?? "").trim() : "" });
  });
  const byGroup = new Map();
  for (const point of points) {
    if (!byGroup.has(point.group)) byGroup.set(point.group, { key: point.group, first: byGroup.size, pts: [] });
    byGroup.get(point.group).pts.push(point);
  }
  const groups = [...byGroup.values()];
  for (const group of groups) group.median = stripMedian(group.pts.map((point) => point.value).sort((a, b) => a - b));
  if (order !== "data") {
    const sign = order === "median_desc" ? -1 : 1;
    groups.sort((a, b) => sign * (a.median - b.median) || a.first - b.first);
  }
  groups.forEach((group, row) => {
    group.row = row;
    group.display = String(resolveEconomyDisplayName(group.key, spec.category_names, lang));
    for (const point of group.pts) point.row = row;
  });
  const rowCount = groups.length;

  // Extreme units of the whole chart: the ceil(n/2) highest and the floor(n/2)
  // lowest, never the same unit twice. Labels read "name value"; in house style
  // only the top-most label carries the unit (the "unit once" convention).
  let highs = [];
  let lows = [];
  if (labelField && extremeCount > 0) {
    highs = [...points].sort((a, b) => b.value - a.value || a.index - b.index).slice(0, Math.ceil(extremeCount / 2));
    const taken = new Set(highs);
    lows = [...points].sort((a, b) => a.value - b.value || a.index - b.index).filter((point) => !taken.has(point)).slice(0, Math.floor(extremeCount / 2));
  }
  const labeled = [...highs.map((point) => ({ point, high: true })), ...lows.map((point) => ({ point, high: false }))];
  const labelDecimals = resolveChartDecimals(spec, labeled.map((item) => item.point.value));
  const unitOwner = labeled.reduce((best, item) => (!best || item.point.row < best.point.row ? item : best), null);
  for (const item of labeled) {
    const valueText = fmtSpec(spec, item.point.value, HOUSE_STYLE_ACTIVE && item !== unitOwner ? "" : spec.unit, labelDecimals);
    item.text = item.point.name ? `${item.point.name} ${valueText}` : valueText;
    item.width = stripTextWidth(item.text, STRIP_LABEL_WEIGHT >= QA_BOLD_WEIGHT_THRESHOLD);
  }

  // Frame and plot box. The row-label column is as wide as the widest group
  // name; the right edge leaves room for the high-side labels, which sit just
  // right of their dots.
  const axis = stripAxis(points.length ? points.map((point) => point.value) : [0, 1]);
  const catX = 54 + Math.max(24, Math.ceil(Math.max(0, ...groups.map((group) => stripTextWidth(group.display, false)))));
  const left = catX + 20;
  const band = clamp(Math.round(STRIP_BAND_TARGET / Math.max(rowCount, 1)), STRIP_MIN_BAND, STRIP_MAX_BAND);
  const amp = Math.min(STRIP_MAX_JITTER, (band - 2 * r - 1.5) / 2);
  const keyHeight = showMedian && rowCount ? 26 : 8;
  const f = frame(spec, keyHeight + rowCount * band + 34, 300);
  const top = f.bodyTop + keyHeight;
  const bottom = top + rowCount * band;
  const rowCenters = groups.map((_group, i) => top + band * (i + 0.5));
  const labelLimit = LAYOUT_W - 54;
  let right = labelLimit;
  for (const item of labeled) {
    if (!item.high) continue;
    const fraction = (item.point.value - axis.lo) / (axis.hi - axis.lo);
    if (fraction > 0) right = Math.min(right, left + (labelLimit - (r + STRIP_LABEL_GAP + item.width + STRIP_LABEL_SLACK) - left) / fraction);
  }
  right = Math.min(labelLimit, Math.max(right, left + STRIP_MIN_PLOT_WIDTH));
  const scale = (value) => left + ((value - axis.lo) / (axis.hi - axis.lo)) * (right - left);

  // Dot positions: x from the value, y offset inside the row band by the
  // chosen layout. A group with a single unit sits on its row's centre line.
  for (const group of groups) {
    const xs = group.pts.map((point) => scale(point.value));
    const offsets = group.pts.length < 2
      ? group.pts.map(() => 0)
      : layout === "beeswarm"
        ? stripBeeswarmOffsets(xs, amp, 2 * r + 0.4)
        : group.pts.map((point) => (stripHashUnit(`${point.name || group.key}|${point.index}`) * 2 - 1) * amp);
    group.pts.forEach((point, k) => {
      point.dot = { x: q(xs[k]), y: q(rowCenters[group.row] + offsets[k]), r };
    });
  }

  const parts = f.parts;
  const fixedBoxes = [];
  // Row guides and vertical gridlines come first so every mark covers them.
  for (const group of groups) {
    const y = q(rowCenters[group.row]);
    parts.push(`<line x1="${q(left)}" y1="${y}" x2="${q(right)}" y2="${y}" stroke="${PALETTE.faint}" stroke-width="1"/>`);
  }
  axis.ticks.forEach((tick) => {
    const x = q(scale(tick));
    parts.push(`<line x1="${x}" y1="${q(top)}" x2="${x}" y2="${q(bottom)}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  });
  if (axis.lo === 0) {
    parts.push(`<line data-role="zero-line" x1="${q(left)}" y1="${q(top)}" x2="${q(left)}" y2="${q(bottom)}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  }
  axis.ticks.forEach((tick, i) => {
    const x = q(scale(tick));
    const text = tickLabelSpec(spec, tick, axisTickUnit(spec.unit, i, axis.ticks.length));
    parts.push(`<text x="${x}" y="${q(bottom + 21)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(text)}</text>`);
    fixedBoxes.push(stripTextBox(text, x, q(bottom + 21), "middle", false));
  });
  for (const group of groups) {
    const y = q(rowCenters[group.row] + 4);
    parts.push(`<text x="${catX}" y="${y}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(group.display)}</text>`);
    fixedBoxes.push(stripTextBox(group.display, catX, y, "end", false));
  }
  if (showMedian && rowCount) {
    const y = q(f.bodyTop + 12);
    parts.push(`<text data-role="strip-median-key" x="${q(left)}" y="${y}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(strings.stripMedianKey)}</text>`);
    fixedBoxes.push(stripTextBox(strings.stripMedianKey, q(left), y, "start", false));
  }

  // Dots: every ordinary unit in the house data colour at half opacity (so
  // overlap darkens), highlighted units in the accent on top of them.
  const isHighlighted = (point) => highlight.has(point.group) || (point.name !== "" && highlight.has(point.name));
  const dotMarkup = (point, accent) => `<circle data-role="data-point" cx="${point.dot.x}" cy="${point.dot.y}" r="${r}" fill="${accent ? PALETTE.accent : PALETTE.accent2}"${accent ? "" : ` opacity="${STRIP_DOT_OPACITY}"`}/>`;
  for (const point of points) if (!isHighlighted(point)) parts.push(dotMarkup(point, false));
  for (const point of points) if (isHighlighted(point)) parts.push(dotMarkup(point, true));

  // Median ticks: a mark only (no number); the key above the plot names it.
  const medianTicks = [];
  if (showMedian) {
    const half = Math.min(10, band / 2 - 1.5);
    for (const group of groups) {
      const x = q(scale(group.median));
      const cy = rowCenters[group.row];
      parts.push(`<line data-role="data-median" x1="${x}" y1="${q(cy - half)}" x2="${x}" y2="${q(cy + half)}" stroke="${PALETTE.ink}" stroke-width="1.5"/>`);
      medianTicks.push({ a: { x, y: cy - half }, b: { x, y: cy + half } });
    }
  }

  // Extreme labels, highest first then lowest first, each clear of every dot,
  // text, median tick and other leader.
  const placement = stripPlaceLabels(
    labeled.map((item) => ({ text: item.text, dot: item.point.dot })),
    {
      circles: points.map((point) => point.dot),
      boxes: fixedBoxes,
      segments: medianTicks,
      bounds: { x0: left + 2, x1: labelLimit, y0: top - 1, y1: bottom + 1 },
    },
  );
  for (const item of placement.placed) {
    if (item.leader) {
      parts.push(`<line data-role="direct-label-leader" x1="${q(item.leader.a.x)}" y1="${q(item.leader.a.y)}" x2="${q(item.leader.b.x)}" y2="${q(item.leader.b.y)}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);
    }
    parts.push(`<text data-role="direct-label" x="${q(item.tx)}" y="${q(item.baseline)}" text-anchor="${item.anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="${STRIP_LABEL_WEIGHT}" fill="${PALETTE.ink}">${esc(item.label.text)}</text>`);
  }
  addFooter(parts, spec, f.footerTop);
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}

function mobileFrame(spec, bodyHeight) {
  const width = 640;
  const margin = 32;
  const titleLines = headlineWrap(spec.title, 38, true).length;
  const dekLines = spec.subtitle ? wrapText(spec.subtitle, 58).length : 0;
  const header = 26 + titleLines * 31 + dekLines * 20 + 20;
  const footer = 78 + (spec.note ? wrapText(spec.note, 70).length * 16 : 0);
  const height = Math.max(440, header + bodyHeight + footer);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="viz-title-mobile viz-desc-mobile" data-viewport="mobile">`];
  parts.push(`<title id="viz-title-mobile">${esc(spec.title)}</title>`);
  parts.push(`<desc id="viz-desc-mobile">${esc(spec.alt)}</desc>`);
  parts.push(`<rect width="${width}" height="${height}" fill="${PAPER}"/>`);
  let y = 34;
  y += svgTextLines(parts, spec.title, margin, y, { size: 25, lineHeight: 31, weight: 700, maxChars: 38, font: FONT_TITLE, headline: true });
  if (spec.subtitle) y += svgTextLines(parts, spec.subtitle, margin, y + 2, { size: 14, lineHeight: 20, fill: PALETTE.muted, maxChars: 58 });
  y += 14;
  const bodyTop = y;
  const bodyBottom = height - footer;
  return {
    width,
    margin,
    height,
    parts,
    bodyTop,
    bodyBottom,
    footerTop: height - footer + 16,
    annotationLayout: createAnnotationLayout({ left: margin, right: width - margin, top: bodyTop + 4, bottom: bodyBottom - 8, line_gap: 17 }),
  };
}

function addMobileFooter(parts, spec, footerTop) {
  const t = VIZ_STRINGS[vizLang(spec)];
  parts.push(`<line x1="32" y1="${footerTop - 16}" x2="608" y2="${footerTop - 16}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  let y = footerTop;
  if (spec.note) y += svgTextLines(parts, `${t.note}${spec.note}`, 32, y, { size: 12, lineHeight: 16, fill: PALETTE.muted, maxChars: 70 });
  svgTextLines(parts, sourceAttribution(spec.source_note, vizLang(spec)), 32, y + 3, { size: 12, lineHeight: 16, fill: PALETTE.muted, maxChars: 70 });
}

function renderMobileHorizontal(spec, rows, mode) {
  if (mode === "dot" && spec.series_field && fieldExists(rows, spec.series_field)) {
    return renderGroupedDotsMobile(spec, rows);
  }
  const sorted = sortRows(rows, spec, spec.value_field);
  const refLines = spec.chart_type === "diverging_bar" ? [] : referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const f = mobileFrame(spec, Math.max(250, sorted.length * 42 + 50) + refMargin);
  const base = f.bodyTop + 5;
  let left = 178, right = 595;
  const top = base + refMargin, bottom = f.bodyBottom - 36;
  const values = sorted.map((r) => n(r[spec.value_field])).filter((v) => v !== null);
  // Fix 2: see the matching comment in renderHorizontal - resolved once, up
  // front, from every value this chart will display as a direct label.
  const labelDecimals = resolveChartDecimals(spec, values);
  if (spec.chart_type === "diverging_bar") {
    const margins = divergingLabelMargins(spec, sorted, spec.value_field, labelDecimals, 8);
    left += margins.neg; right -= margins.pos;
  }
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit, spec);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.2"/>`);
  const step = (bottom - top) / Math.max(1, sorted.length);
  sorted.forEach((row, i) => {
    const value = n(row[spec.value_field]); if (value === null) return;
    const y = top + step * i + step * 0.5;
    const category = String(row[spec.category_field] ?? "");
    f.parts.push(`<text x="165" y="${y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(textUnits(category) > 20 ? sliceUnits(category, 19) + "…" : category)}</text>`);
    const x = scale(value);
    const highlighted = (spec.highlight_values ?? []).map(String).includes(category);
    const fill = highlighted ? PALETTE.accent : PALETTE.context;
    // Fix 3: see the matching comment in renderHorizontal - unit on the
    // first label only.
    const rowUnit = HOUSE_STYLE_ACTIVE && i > 0 ? "" : spec.unit;
    if (mode === "bar") {
      const rx = Math.min(x, zero), width = Math.max(1, Math.abs(x - zero));
      f.parts.push(`<rect data-role="data-bar" x="${rx}" y="${y - 7}" width="${width}" height="14" fill="${fill}"/>`);
    } else {
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="4.8" fill="${fill}"/>`);
    }
    if (spec.chart_type === "diverging_bar") {
      // Always outside the bar's end, on the bar's own side (divergingLabelMargins keeps room for it).
      const anchor = value >= 0 ? "start" : "end";
      const labelX = x + (value >= 0 ? 8 : -8);
      f.parts.push(`<text data-role="bar-value-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value, rowUnit, labelDecimals))}</text>`);
    } else {
      const anchor = value >= 0 ? "start" : "end";
      const labelX = x + (value >= 0 ? 8 : -8);
      f.parts.push(`<text x="${labelX}" y="${y + 4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value, rowUnit, labelDecimals))}</text>`);
    }
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout, maxChars: 30 }));
  });
  drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  addMobileFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderGroupedDotsMobile(spec, rows) {
  const valueField = spec.value_field;
  const categoryField = spec.category_field;
  const seriesField = spec.series_field;
  const categories = unique(rows.map((row) => String(row[categoryField] ?? ""))).filter(Boolean);
  const series = unique(rows.map((row) => String(row[seriesField] ?? ""))).filter(Boolean);
  const refLines = referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const bodyHeight = Math.max(280, categories.length * 48 + 92) + refMargin;
  const f = mobileFrame(spec, bodyHeight);
  const base = f.bodyTop + 48;
  const left = 178, right = 592, top = base + refMargin, bottom = f.bodyBottom - 34;
  const values = rows.map((row) => n(row[valueField])).filter((value) => value !== null);
  const domain = extent(values, true);
  const scale = horizontalScale(domain, left, right);
  const zero = scale(0);
  const renderedAnnotations = new Set();
  const annotationSeries = new Map(categories.map((category) => {
    const available = series.map((seriesName, index) => rows.some((row) => String(row[categoryField] ?? "") === category && String(row[seriesField] ?? "") === seriesName) ? index : -1).filter((index) => index >= 0);
    return [category, available.at(-1)];
  }));
  const legendY = f.bodyTop + 16;
  f.parts.push(`<text x="${left}" y="${legendY}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${VIZ_STRINGS[vizLang(spec)].group}</text>`);
  let legendX = left + 36;
  series.forEach((name, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    f.parts.push(`<circle data-role="legend-swatch" cx="${legendX}" cy="${legendY - 3}" r="4" fill="${color}"/>`);
    f.parts.push(`<text x="${legendX + 8}" y="${legendY}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(name)}</text>`);
    legendX += Math.max(56, String(name).length * 11 + 24);
  });
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit, spec);
  f.parts.push(`<line x1="${zero}" y1="${top}" x2="${zero}" y2="${bottom}" stroke="${PALETTE.ink}" stroke-width="1.1"/>`);
  const step = (bottom - top) / Math.max(categories.length, 1);
  const offsets = series.length <= 1
    ? [0]
    : series.map((_name, index) => (index - (series.length - 1) / 2) * Math.min(14, 24 / series.length));
  categories.forEach((category, categoryIndex) => {
    const center = top + step * categoryIndex + step * 0.5;
    f.parts.push(`<text x="165" y="${center + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(textUnits(category) > 20 ? sliceUnits(category, 19) + "…" : category)}</text>`);
    series.forEach((seriesName, seriesIndex) => {
      const row = rows.find((candidate) => String(candidate[categoryField] ?? "") === category && String(candidate[seriesField] ?? "") === seriesName);
      if (!row) return;
      const value = n(row[valueField]);
      if (value === null) return;
      const y = center + (offsets[seriesIndex] ?? 0);
      const x = scale(value);
      const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
      f.parts.push(`<line x1="${zero}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1.5"/>`);
      f.parts.push(`<circle cx="${x}" cy="${y}" r="4.8" fill="${color}"/>`);
      const label = fmtSpec(spec, value, spec.label_unit ?? "");
      const labelWidth = Math.max(22, textUnits(label) * 6.9);
      const canPlaceRight = x + 7 + labelWidth <= right;
      const canPlaceLeft = x - 7 - labelWidth >= left;
      const placeRight = value >= 0 ? canPlaceRight || !canPlaceLeft : !canPlaceLeft;
      const anchor = placeRight ? "start" : "end";
      const labelX = x + (placeRight ? 7 : -7);
      if (spec.direct_labels !== false) {
        f.parts.push(`<text data-role="dot-value-label" x="${labelX}" y="${y + 3.5}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);
      }
      if (seriesIndex === annotationSeries.get(category)) {
        pointAnnotations(spec, row).forEach((annotation) => {
          const key = `${annotation.claim_id ?? ""}|${annotation.match_field ?? ""}|${annotation.match_value ?? ""}|${annotation.text ?? ""}`;
          if (renderedAnnotations.has(key)) return;
          renderedAnnotations.add(key);
          addPointAnnotation(f.parts, annotation, x, y, { side: value >= 0 ? "right" : "left", layout: f.annotationLayout, maxChars: 26 });
        });
      }
    });
  });
  drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  addMobileFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderMobileDumbbell(spec, rows) {
  const refLines = referenceLineAnnotations(spec);
  const refMargin = referenceLineMargin(refLines);
  const f = mobileFrame(spec, Math.max(250, rows.length * 46 + 46) + refMargin);
  const base = f.bodyTop + 5;
  const left = 178, right = 585, top = base + refMargin, bottom = f.bodyBottom - 36;
  const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false);
  const scale = horizontalScale(domain, left, right);
  addHorizontalAxis(f.parts, domain, left, right, top, bottom, spec.unit, spec);
  const step = (bottom - top) / Math.max(1, rows.length);
  rows.forEach((row, i) => {
    const a = n(row[spec.start_field]), b = n(row[spec.end_field]); if (a === null || b === null) return;
    const y = top + step * i + step * 0.5, x1 = scale(a), x2 = scale(b);
    const category = String(row[spec.category_field] ?? "");
    f.parts.push(`<text x="165" y="${y + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(textUnits(category) > 20 ? sliceUnits(category, 19) + "…" : category)}</text>`);
    f.parts.push(`<line data-role="data-bar" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${PALETTE.context}" stroke-width="3"/>`);
    f.parts.push(`<circle cx="${x1}" cy="${y}" r="4.8" fill="${PALETTE.accent2}"/><circle cx="${x2}" cy="${y}" r="4.8" fill="${PALETTE.accent}"/>`);
    dumbbellValueLabels(x1, x2, a, b, fmtSpec(spec, a, spec.unit), fmtSpec(spec, b, spec.unit), 6).forEach((label) => f.parts.push(`<text x="${label.x}" y="${y - 9}" text-anchor="${label.anchor}" font-family="${FONT_SANS}" font-size="12" fill="${label.fill}">${esc(label.text)}</text>`));
    pointAnnotations(spec, row).forEach((annotation) => addPointAnnotation(f.parts, annotation, x2, y, { side: "right", layout: f.annotationLayout, maxChars: 30 }));
  });
  drawHorizontalValueReferenceLines(f.parts, refLines, { scale, top, base, bottom, left, right });
  addMobileFooter(f.parts, spec, f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n") + "\n";
}

function renderMobileSlope(spec, rows) {
  const f = mobileFrame(spec, Math.max(320, rows.length * 29));
  const left = 185, right = 445, top = f.bodyTop + 12, bottom = f.bodyBottom - 30;
  const values = rows.flatMap((r) => [n(r[spec.start_field]), n(r[spec.end_field])]).filter((v) => v !== null);
  const domain = extent(values, false), scaleY = verticalScale(domain, top, bottom);
  // Fix 13: see the matching comment in renderSlope - one shared decimals
  // count so a value >= 1000 never falls back to fmt()'s k/m/bn suffixes.
  const labelDecimals = resolveChartDecimals(spec, values);
  f.parts.push(`<text x="${left}" y="${top - 10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.start_label ?? spec.start_field)}</text>`);
  f.parts.push(`<text x="${right}" y="${top - 10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.end_label ?? spec.end_field)}</text>`);

  const entries = rows
    .map((row, i) => ({ row, i, a: n(row[spec.start_field]), b: n(row[spec.end_field]) }))
    .filter((e) => e.a !== null && e.b !== null)
    .map((e) => ({ ...e, y1: scaleY(e.a), y2: scaleY(e.b) }));
  // Fix 13: see the matching comment in renderSlope - unit on row 0's left
  // label only (the first label actually drawn); every other label bare.
  const leftText = (e, idx) => `${textUnits(String(e.row[spec.category_field] ?? "")) > 18 ? sliceUnits(String(e.row[spec.category_field] ?? ""), 17) + "…" : String(e.row[spec.category_field] ?? "")} ${fmtSpec(spec, e.a, HOUSE_STYLE_ACTIVE && idx > 0 ? "" : spec.unit, labelDecimals)}`;
  const rightText = (e) => fmtSpec(spec, e.b, HOUSE_STYLE_ACTIVE ? "" : spec.unit, labelDecimals);
  const leftPlaced = repelEndLabels(entries.map((e, idx) => ({ id: e.i, y: e.y1, text: leftText(e, idx) })), top, bottom, END_LABEL_MIN_GAP);
  const rightPlaced = repelEndLabels(entries.map((e) => ({ id: e.i, y: e.y2, text: rightText(e) })), top, bottom, END_LABEL_MIN_GAP);
  const leftById = new Map(leftPlaced.map((p) => [p.id, p]));
  const rightById = new Map(rightPlaced.map((p) => [p.id, p]));

  const marksStart = f.parts.length;
  const leaderParts = [];
  entries.forEach((e, idx) => {
    const { row, y1, y2 } = e;
    const category = String(row[spec.category_field] ?? "");
    const highlighted = (spec.highlight_values ?? []).map(String).includes(category), stroke = highlighted ? PALETTE.accent : PALETTE.context;
    const leftLabel = leftById.get(e.i), rightLabel = rightById.get(e.i);
    if (leftLabel.needsLeader) leaderParts.push(endLabelLeader(left, y1, left - 6, leftLabel.labelY));
    if (rightLabel.needsLeader) leaderParts.push(endLabelLeader(right, y2, right + 6, rightLabel.labelY));
    f.parts.push(`<line data-role="data-line" x1="${left}" y1="${y1}" x2="${right}" y2="${y2}" stroke="${stroke}" stroke-width="${highlighted?3:1.5}"/>`);
    f.parts.push(`<circle cx="${left}" cy="${y1}" r="4" fill="${stroke}"/><circle cx="${right}" cy="${y2}" r="4" fill="${stroke}"/>`);
    f.parts.push(`<text x="${left-8}" y="${leftLabel.labelY+4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(leftText(e, idx))}</text>`);
    f.parts.push(`<text x="${right+8}" y="${rightLabel.labelY+4}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(rightText(e))}</text>`);
    pointAnnotations(spec,row).forEach((annotation)=>addPointAnnotation(f.parts,annotation,right,y2,{side:"right",layout:f.annotationLayout,maxChars:28}));
  });
  f.parts.splice(marksStart, 0, ...leaderParts);
  addMobileFooter(f.parts,spec,f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n")+"\n";
}

function renderMobileLine(spec, rows, multi=false) {
  const left=70, right=555;
  const seriesField=multi?spec.series_field:null;
  const seriesNames=seriesField?unique(rows.map((r)=>r[seriesField])):["series"];
  const xValues=sortX(unique(rows.map((r)=>r[spec.x_field])));
  const xIndex=new Map(xValues.map((v,i)=>[String(v),i]));
  const xScale=(value)=>xValues.length<=1?(left+right)/2:left+(xIndex.get(String(value))/(xValues.length-1))*(right-left);
  // 608 is mobileFrame's own established safe-text right margin (width - its
  // margin; see addMobileFooter's rule), wider than the plot's own right
  // edge (`right`, 555).
  const eventLayout = layoutEventAnnotations(spec, rows, xScale, left, right, 16, 608);
  const captionExtra = eventLayout.fallback && eventLayout.events.length ? eventLayout.events.length * 16 + 22 : 0;
  const f=mobileFrame(spec,390+captionExtra);
  const bottom=f.bodyBottom-50-captionExtra;
  const hasLane = eventLayout.events.length > 0 && !eventLayout.fallback;
  const laneTop = f.bodyTop+16+(HOUSE_STYLE_ACTIVE?TOP_TICK_CLEARANCE:0);
  const rowsUsed = hasLane ? (eventLayout.events.some((e) => e.laneRow === 1) ? 2 : 1) : 0;
  const rowY = hasLane ? Array.from({ length: rowsUsed }, (_, i) => laneTop + LANE_ROW_HEIGHT * (i + 1)) : [];
  const top = hasLane ? rowY[rowsUsed - 1] + 8 : laneTop;
  const yValues=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null);
  // Task B (mobile scope): zero-baseline for %-share series and a tick-bracketing
  // domain, same fix as the desktop renderer, via lineAxisDomain/lineAxisTicks.
  // Monotone interpolation and the marker-restriction rule are desktop-only for
  // now (documented gap in the polish report).
  const includeZero=spec.unit==="%";
  const yDomain=lineAxisDomain(yValues,includeZero,4);
  // Fix 4 (mobile): same header/top-tick scale-overshoot fix as renderLine -
  // see the comment there.
  const yTicksMobile=lineAxisTicks(yDomain,4,HOUSE_STYLE_ACTIVE);
  const yScaleDomain=HOUSE_STYLE_ACTIVE?[Math.min(yDomain[0],yTicksMobile[0]),Math.max(yDomain[1],yTicksMobile[yTicksMobile.length-1])]:yDomain;
  const yScale=verticalScale(yScaleDomain,top,bottom);
  const pointAnnotationAssignment=assignPointAnnotations(spec,rows,spec.value_field);
  const annotationsByRow=new Map();
  for (const [annotation,row] of pointAnnotationAssignment) { if(!annotationsByRow.has(row)) annotationsByRow.set(row,[]); annotationsByRow.get(row).push(annotation); }
  // Fix 3: see the matching comment in renderLine - unit once, on the
  // top-most tick.
  yTicksMobile.forEach((tick,i)=>{ const y=yScale(tick); f.parts.push(`<line data-role="value-axis-tick" x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}"/>`); f.parts.push(`<text x="${left-9}" y="${y+4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick,axisTickUnit(spec.unit,i,yTicksMobile.length)))}</text>`); });
  const every=Math.max(1,Math.ceil(xValues.length/5)); xValues.forEach((xv,i)=>{ if(i%every!==0&&i!==xValues.length-1)return; f.parts.push(`<text x="${xScale(xv)}" y="${bottom+23}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xv)}</text>`); });
  const directLabels=[];
  // Fix 2: see the matching comment in renderLine - one decimal count per
  // chart, resolved once from every series' final value, not per-label.
  const lineSeriesGroup=(series)=>rows.filter((r)=>!seriesField||String(r[seriesField])===String(series)).sort((a,b)=>xIndex.get(String(a[spec.x_field]))-xIndex.get(String(b[spec.x_field])));
  const lineEndValues=seriesNames.map((series)=>{ const g=lineSeriesGroup(series); const last=g[g.length-1]; return last?n(last[spec.value_field]):null; }).filter((v)=>v!==null);
  const labelDecimals=resolveChartDecimals(spec,lineEndValues);
  seriesNames.forEach((series)=>{
    const group=lineSeriesGroup(series);
    // Fix 6 (house style only - legacy unchanged): see the matching comment
    // in renderLine - `highlighted` stays true for a single series by
    // design (width/opacity unchanged); its stroke *color* uses a narrower
    // check so a lone series defaults to ink, not the accent2 grey, unless
    // highlight_values names one of its own x-values (e.g. the endpoint).
    const highlighted=!multi||(spec.highlight_values??[]).map(String).includes(String(series));
    const singleSeriesHasAccent=HOUSE_STYLE_ACTIVE&&!multi&&(spec.highlight_values??[]).map(String).some((v)=>group.some((r)=>String(r[spec.x_field])===v));
    const stroke=multi?(highlighted?PALETTE.accent:PALETTE.context):(HOUSE_STYLE_ACTIVE?(singleSeriesHasAccent?PALETTE.accent:PALETTE.ink):PALETTE.accent2);
    const coords=group.map((r)=>`${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");
    f.parts.push(`<polyline data-role="line-path" fill="none" stroke="${stroke}" stroke-width="${highlighted?2.5:1.5}" stroke-linecap="round" stroke-linejoin="round" points="${coords}" opacity="${highlighted?1:.72}"/>`);
    if(highlighted||!multi) group.forEach((r)=>f.parts.push(`<circle data-role="line-point" cx="${xScale(r[spec.x_field])}" cy="${yScale(n(r[spec.value_field]))}" r="2.8" fill="${stroke}"/>`));
    // Point annotations render once, via the event-annotation lane/fallback
    // below (eventLayout) - see the matching comment in renderLine.
    const last=group[group.length-1];
    if(last&&multi&&spec.direct_labels!==false) {
      const name=String(series); const value=n(last[spec.value_field]);
      const valueText=value===null?null:fmtSpec(spec, value,spec.unit,labelDecimals);
      const text=valueText===null?name:`${name} ${valueText}`;
      const pointX=xScale(last[spec.x_field]);
      // Fix 5 (mobile): same end-label-crosses-its-own-line fix as
      // renderLine, on mobile's own (even tighter) 640-wide canvas - see
      // layoutLineEndLabel.
      const lines=HOUSE_STYLE_ACTIVE&&valueText!==null
        ? layoutLineEndLabel(name,valueText,pointX,640,6,6.8)
        : [{text,x:Math.min(632-textUnits(text)*6.8,pointX+6)}];
      directLabels.push({lines,y:yScale(value)+4,highlighted});
    }
    if(last&&!multi&&spec.direct_labels===true) f.parts.push(`<text data-role="direct-label" x="${Math.min(602,xScale(last[spec.x_field])+7)}" y="${yScale(n(last[spec.value_field]))-8}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.ink}">${esc(fmtSpec(spec, n(last[spec.value_field]),spec.unit,labelDecimals))}</text>`);
  });
  if(multi&&spec.direct_labels!==false) {
    const anyTwoLine=directLabels.some((d)=>d.lines.length>1);
    const placedMobile=separateLabelBaselines(directLabels,top+(anyTwoLine?22:7),bottom-7,anyTwoLine?31:17);
    for (const label of placedMobile) {
      const weight=label.highlighted?700:400, fill=label.highlighted?PALETTE.ink:PALETTE.muted;
      if (label.lines.length===1) {
        f.parts.push(`<text data-role="direct-label" x="${label.lines[0].x}" y="${label.labelY}" font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${fill}">${esc(label.lines[0].text)}</text>`);
      } else {
        const anchor1=label.lines[0].anchor==="end"?` text-anchor="end"`:"";
        const anchor2=label.lines[1].anchor==="end"?` text-anchor="end"`:"";
        f.parts.push(`<text data-role="direct-label" x="${label.lines[0].x}" y="${label.labelY-14}"${anchor1} font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${fill}">${esc(label.lines[0].text)}</text>`);
        f.parts.push(`<text data-role="direct-label" x="${label.lines[1].x}" y="${label.labelY}"${anchor2} font-family="${FONT_SANS}" font-size="12" font-weight="${weight}" fill="${fill}">${esc(label.lines[1].text)}</text>`);
      }
    }
  }
  if (eventLayout.events.length) {
    eventLayout.events.forEach((e) => { e.eventY = yScale(n(e.dataRow[spec.value_field])); });
    if (hasLane) drawEventAnnotationLane(f.parts, eventLayout.events, rowY, bottom);
    else drawEventAnnotationFallback(f.parts, eventLayout.events, left, bottom + 42);
  }
  addMobileFooter(f.parts,spec,f.footerTop); f.parts.push("</svg>"); return f.parts.join("\n")+"\n";
}

function renderMobileSmallMultiples(spec, rows) {
  const facets=facetOrder(unique(rows.map((r)=>r[spec.facet_field]))), gapY=34, panelW=576;
  if(spec.panel_mark==="dot") {
    const groups=facets.map((facet)=>rows.filter((r)=>String(r[spec.facet_field])===String(facet))), maxItems=Math.max(...groups.map((g)=>g.length),1);
    const refLines=referenceLineAnnotations(spec),refMargin=referenceLineMargin(refLines);
    const panelH=Math.max(245,maxItems*36+68)+refMargin, f=mobileFrame(spec,facets.length*panelH+Math.max(0,facets.length-1)*gapY+20);
    const all=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null); let domain=extent(all,true); if(spec.unit==="%"&&Math.min(...all)>=0&&Math.max(...all)<=100)domain=[0,100];
    facets.forEach((facet,fi)=>{
      const facetPartStart=f.parts.length;
      const x0=32,y0=f.bodyTop+fi*(panelH+gapY),group=sortRows(rows.filter((r)=>String(r[spec.facet_field])===String(facet)),spec,spec.value_field),labelW=138,plotLeft=x0+labelW,plotRight=x0+panelW-6,plotBase=y0+38,plotTop=plotBase+refMargin,plotBottom=y0+panelH-34,xScale=horizontalScale(domain,plotLeft,plotRight);
      f.parts.push(`<text x="${x0}" y="${y0+16}" font-family="${FONT_SANS}" font-size="14" font-weight="700" fill="${PALETTE.ink}">${esc(facet)}</text>`);
      tickValues(domain,2).forEach((tick)=>{const x=xScale(tick);f.parts.push(`<line x1="${x}" y1="${plotTop-4}" x2="${x}" y2="${plotBottom}" stroke="${PALETTE.grid}"/>`);f.parts.push(`<text x="${x}" y="${plotTop-10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick,spec.unit))}</text>`);});
      const step=Math.max(27,(plotBottom-plotTop)/Math.max(group.length,1)); group.forEach((r,i)=>{const value=n(r[spec.value_field]);if(value===null)return;const y=plotTop+i*step+step*.48,x=xScale(value),category=String(r[spec.x_field]??""),highlighted=(spec.highlight_values??[]).map(String).includes(category);f.parts.push(`<text x="${plotLeft-8}" y="${y+4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(textUnits(category)>18?sliceUnits(category,17)+"…":category)}</text>`);f.parts.push(`<line x1="${plotLeft}" y1="${y}" x2="${x}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1.4"/>`);f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted?5.7:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x+6}" y="${y+4}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(fmtSpec(spec, value,spec.unit))}</text>`);pointAnnotations(spec,r).forEach((annotation)=>addPointAnnotation(f.parts,annotation,x,y,{side:"right",layout:f.annotationLayout,maxChars:36}));});
      refLines.forEach((line,i)=>{const x=xScale(line.value);f.parts.push(`<line data-role="reference-line" x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="${PALETTE.muted}" stroke-width="1.5" stroke-dasharray="4 3"/>`);if(fi===0){const anchor=x>(plotLeft+plotRight)/2?"end":"start";f.parts.push(`<text data-role="reference-line-label" x="${x+(anchor==="end"?-5:5)}" y="${referenceLineRowY(plotBase,i)}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(annotationLabel(line,26))}</text>`);}});
      tagPanelTexts(f.parts,facetPartStart,[x0-30,y0-gapY+2,x0+panelW+30,y0+panelH+gapY-2]);
    });
    addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
  }
  const refLines=referenceLineAnnotations(spec),refMargin=referenceLineMargin(refLines);
  const panelH=220+refMargin, f=mobileFrame(spec,facets.length*panelH+Math.max(0,facets.length-1)*gapY+20), all=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null), yDomain=extent(all,false);
  facets.forEach((facet,fi)=>{const facetPartStart=f.parts.length;const x0=42,y0=f.bodyTop+fi*(panelH+gapY),group=rows.filter((r)=>String(r[spec.facet_field])===String(facet)),xs=sortX(unique(group.map((r)=>r[spec.x_field]))),xMap=new Map(xs.map((v,i)=>[String(v),i])),xScale=(value)=>xs.length<=1?x0+panelW/2:x0+(xMap.get(String(value))/(xs.length-1))*panelW,plotBase=y0+30,yScale=verticalScale(yDomain,plotBase+refMargin,y0+panelH-30);f.parts.push(`<text x="${x0}" y="${y0+14}" font-family="${FONT_SANS}" font-size="13.5" font-weight="700" fill="${PALETTE.ink}">${esc(facet)}</text>`);[yDomain[0],(yDomain[0]+yDomain[1])/2,yDomain[1]].forEach((tick)=>{const y=yScale(tick);f.parts.push(`<line x1="${x0}" y1="${y}" x2="${x0+panelW}" y2="${y}" stroke="${PALETTE.grid}"/>`);});const sorted=[...group].sort((a,b)=>xMap.get(String(a[spec.x_field]))-xMap.get(String(b[spec.x_field])));if(xs.length>1){const coords=sorted.map((r)=>`${xScale(r[spec.x_field])},${yScale(n(r[spec.value_field]))}`).join(" ");f.parts.push(`<polyline fill="none" stroke="${PALETTE.accent2}" stroke-width="2.2" points="${coords}"/>`);}sorted.forEach((r)=>{const x=xScale(r[spec.x_field]),y=yScale(n(r[spec.value_field]));f.parts.push(`<circle cx="${x}" cy="${y}" r="4" fill="${PALETTE.accent2}"/>`);pointAnnotations(spec,r).forEach((annotation)=>addPointAnnotation(f.parts,annotation,x,y,{side:"right",layout:f.annotationLayout,maxChars:28}));});if(xs.length>1){f.parts.push(`<text x="${x0}" y="${y0+panelH}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xs[0])}</text>`);f.parts.push(`<text x="${x0+panelW}" y="${y0+panelH}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xs[xs.length-1])}</text>`);}refLines.forEach((line,i)=>{const y=yScale(line.value);f.parts.push(`<line data-role="reference-line" x1="${x0}" y1="${y}" x2="${x0+panelW}" y2="${y}" stroke="${PALETTE.muted}" stroke-width="1.5" stroke-dasharray="4 3"/>`);if(fi===0){f.parts.push(`<text data-role="reference-line-label" x="${x0}" y="${referenceLineRowY(plotBase,i)}" text-anchor="start" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(annotationLabel(line,34))}</text>`);}});tagPanelTexts(f.parts,facetPartStart,[x0-30,y0-gapY+2,x0+panelW+30,y0+panelH+gapY-2]);});
  addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}

function renderMobileScatter(spec, rows) {
  const f=mobileFrame(spec,420),left=72,right=594,top=f.bodyTop+12,bottom=f.bodyBottom-64,xs=rows.map((r)=>n(r[spec.x_field])).filter((v)=>v!==null),ys=rows.map((r)=>n(r[spec.y_field])).filter((v)=>v!==null),xInfo=makeScale(xs,left,right,spec.x_scale??"linear"),yRaw=spec.y_scale==="log"?ys.map(Math.log10):ys,yDomainRaw=extent(yRaw,false),yLinear=verticalScale(yDomainRaw,top,bottom),yScale=(value)=>yLinear(spec.y_scale==="log"?Math.log10(value):value),yTicks=spec.y_scale==="log"?logTickValues(yDomainRaw):tickValues(yDomainRaw,4);
  yTicks.forEach((tick)=>{const y=yScale(tick);f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}"/>`);f.parts.push(`<text x="${left-9}" y="${y+4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabelSpec(spec, tick,spec.y_unit??spec.unit))}</text>`);});
  xInfo.ticks.forEach((tick)=>{const x=xInfo.scale(tick);f.parts.push(`<text x="${x}" y="${bottom+23}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(tickLabel(tick,spec.x_unit??"",vizLang(spec)))}</text>`);});
  if(spec.x_label)f.parts.push(`<text x="${(left+right)/2}" y="${bottom+47}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.muted}">${esc(spec.x_label)}</text>`);
  rows.forEach((row)=>{const x=n(row[spec.x_field]),y=n(row[spec.y_field]);if(x===null||y===null)return;const label=spec.label_field?String(row[spec.label_field]??""):"",highlighted=label&&(spec.highlight_values??[]).map(String).includes(label),px=xInfo.scale(x),py=yScale(y);f.parts.push(`<circle cx="${px}" cy="${py}" r="${highlighted?5.8:3.8}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}" opacity="${highlighted?1:.68}"/>`);if(highlighted){const labelSide=px>right-125?"left":"right",shownLabel=resolveEconomyDisplayName(label,spec.category_names,vizLang(spec)),placedLabel=f.annotationLayout.place(px,py,shownLabel,labelSide,1);if(Math.abs(placedLabel.ty-(py-13))>10){const leaderEnd=leaderEndShortOfLabel(px,py,placedLabel);f.parts.push(`<line data-role="direct-label-leader" x1="${px}" y1="${py}" x2="${leaderEnd.x2}" y2="${leaderEnd.y2}" stroke="${PALETTE.muted}" stroke-width=".8"/>`);}f.parts.push(`<text data-role="direct-label" x="${placedLabel.tx}" y="${placedLabel.ty}" text-anchor="${placedLabel.anchor}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.ink}">${esc(shownLabel)}</text>`);}pointAnnotations(spec,row).forEach((annotation)=>addPointAnnotation(f.parts,annotation,px,py,{side:px>right-150?"left":"right",layout:f.annotationLayout,maxChars:30,maxLines:3}));});
  if(spec.x_scale==="log")f.parts.push(`<text x="${right}" y="${bottom+47}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${VIZ_STRINGS[vizLang(spec)].logScale}</text>`);
  addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}

function renderMobileHeatmap(spec, rows) {
  const xs=unique(rows.map((r)=>r[spec.x_field])),ys=unique(rows.map((r)=>r[spec.y_field])),f=mobileFrame(spec,Math.max(330,ys.length*34+102)),left=145,right=606,top=f.bodyTop+40,bottom=f.bodyBottom-62,cellW=(right-left)/Math.max(1,xs.length),cellH=(bottom-top)/Math.max(1,ys.length),vals=rows.map((r)=>n(r[spec.value_field])).filter((v)=>v!==null),[min,max]=extent(vals,false),index=new Map(rows.map((r)=>[`${r[spec.x_field]}\u0000${r[spec.y_field]}`,n(r[spec.value_field])])),mixChannels=(t)=>{const a=[242,243,244],b=[209,73,63];return a.map((v,i)=>Math.round(v+(b[i]-v)*clamp(t,0,1)));},mix=(t)=>{const c=mixChannels(t);return `rgb(${c[0]},${c[1]},${c[2]})`;};
  xs.forEach((xv,xi)=>f.parts.push(`<text x="${left+(xi+.5)*cellW}" y="${top-10}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(textUnits(String(xv))>10?sliceUnits(String(xv),9)+"…":xv)}</text>`));
  ys.forEach((yv,yi)=>{f.parts.push(`<text x="${left-8}" y="${top+(yi+.5)*cellH+4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(textUnits(String(yv))>18?sliceUnits(String(yv),17)+"…":yv)}</text>`);xs.forEach((xv,xi)=>{const value=index.get(`${xv}\u0000${yv}`);if(value===null||value===undefined)return;const t=(value-min)/(max-min||1),x=left+xi*cellW,y=top+yi*cellH;f.parts.push(`<rect x="${x+1}" y="${y+1}" width="${Math.max(1,cellW-2)}" height="${Math.max(1,cellH-2)}" fill="${mix(t)}"/>`);if(cellW>34&&cellH>30){const style=labelStyleOnFill(mixChannels(t));const halo=style.halo?` stroke="${style.halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"`:"";f.parts.push(`<text x="${x+cellW/2}" y="${y+cellH/2+3}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${style.fill}"${halo}>${esc(fmt(value,spec.unit))}</text>`);}});});
  const legendY=bottom+13,legendW=140;
  f.parts.push(`<defs><linearGradient id="heatmap-grad-m" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="${mix(0)}"/><stop offset="100%" stop-color="${mix(1)}"/></linearGradient></defs>`);
  f.parts.push(`<rect data-role="heatmap-legend" x="${left}" y="${legendY}" width="${legendW}" height="8" fill="url(#heatmap-grad-m)"/>`);
  f.parts.push(`<text x="${left}" y="${legendY+22}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtSpec(spec, min,spec.unit))}</text>`);
  f.parts.push(`<text x="${left+legendW}" y="${legendY+22}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtSpec(spec, max,spec.unit))}</text>`);
  addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}


function flowLayout(rows, spec) {
  if (hasDirectedCycle(rows, spec.source_field, spec.target_field)) {
    throw new Error(`${spec.chart_type ?? "flow"} renderer requires an acyclic flow graph`);
  }
  const nodes = new Map();
  const incoming = new Map(), outgoing = new Map();
  const ensure = (id) => { if (!nodes.has(id)) nodes.set(id, { id, in: 0, out: 0, level: 0 }); return nodes.get(id); };
  for (const row of rows) {
    const a=String(row[spec.source_field]), b=String(row[spec.target_field]), v=n(row[spec.value_field]) ?? 0;
    ensure(a).out += v; ensure(b).in += v;
    if(!outgoing.has(a))outgoing.set(a,[]); outgoing.get(a).push(b);
    if(!incoming.has(b))incoming.set(b,[]); incoming.get(b).push(a);
  }
  const roots=[...nodes.keys()].filter((id)=>!(incoming.get(id)?.length));
  const queue=roots.map((id)=>[id,0]); const seen=new Map();
  while(queue.length){const [id,level]=queue.shift(); if((seen.get(id)??-1)>=level)continue;seen.set(id,level);nodes.get(id).level=level;for(const next of outgoing.get(id)??[])queue.push([next,level+1]);}
  const maxLevel=Math.max(...[...nodes.values()].map((node)=>node.level),0);
  const levels=Array.from({length:maxLevel+1},()=>[]);
  for(const node of nodes.values())levels[node.level].push(node);
  for(const level of levels)level.sort((a,b)=>Math.max(b.in,b.out)-Math.max(a.in,a.out)||a.id.localeCompare(b.id));
  return { nodes, levels, maxLevel };
}

function sankeyPath(x1,y1,x2,y2) { const c=(x2-x1)*0.45; return `M${x1},${y1} C${x1+c},${y1} ${x2-c},${y2} ${x2},${y2}`; }

// Point on the same cubic bezier sankeyPath() draws, at parameter t in
// [0,1] - used to place each flow's inline value label ON its own link
// (follow-up fix 3) instead of always at the fixed t=0.5 midpoint, so a
// label can slide toward whichever end (source or target) is clear of
// other links while staying mathematically on the visible curve.
function sankeyPointAt(x1,y1,x2,y2,t) {
  const c=(x2-x1)*0.45;
  const p0x=x1,p0y=y1, p1x=x1+c,p1y=y1, p2x=x2-c,p2y=y2, p3x=x2,p3y=y2;
  const mt=1-t;
  const x=mt*mt*mt*p0x + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*p3x;
  const y=mt*mt*mt*p0y + 3*mt*mt*t*p1y + 3*mt*t*t*p2y + t*t*t*p3y;
  return {x,y};
}

// Task C: an id like "origin:巴西" or "destination:中国" carries an internal
// node-type prefix the plan uses to keep source/target namespaces distinct
// when the same display name could appear on both sides; readers must never
// see it.
function stripNodePrefix(id) {
  return String(id ?? "").replace(/^[a-zA-Z_][a-zA-Z0-9_]*:/, "");
}

// User-approved Sankey redesign (round 2, on top of the follow-up fixes
// above): white background; only the highlighted flow(s) carry the project
// accent, everything else - links and node bars alike - is neutral grey;
// small (<3% of the diagram's grand total) nodes in the same column merge
// into one grey "其他"/"Other" catch-all placed last; node labels are
// two-line (bold name, grey value in the localized unit) outside the bars;
// only the single highlighted flow carries an inline value, everyone else's
// value lives in the node label. See
// scratchpad/reports/research-sankey-annotation.md for the sourcing.
// Read live off PALETTE (see treemapNeutralFill/treemapAccentFill above for
// why this can't be a const): a non-highlighted flow-link/node grey must
// follow whichever style applyStyle(spec) most recently selected, not
// freeze to whatever PALETTE was bound to at module load (DEFAULT_PALETTE).
function flowGreyLink() { return PALETTE.context; } // non-highlighted link tone
const FLOW_GREY_NODE = "#9E9E9E"; // near-neutral node bar for a non-highlighted node, per the approved redesign spec

// The flow band sankeyPath() draws, as a strip of quads: the centreline is
// sampled densely and each sample is offset by half the stroke width along
// its normal, so the edges are the band's own, not a bounding box.
function sankeyBandQuads(x1,y1,x2,y2,sw,steps=80) {
  const pts=[];
  for(let i=0;i<=steps;i++){
    const t=i/steps, a=sankeyPointAt(x1,y1,x2,y2,Math.max(0,t-0.001)), b=sankeyPointAt(x1,y1,x2,y2,Math.min(1,t+0.001)), c=sankeyPointAt(x1,y1,x2,y2,t);
    const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1, nx=-dy/len, ny=dx/len;
    pts.push([{x:c.x+nx*sw/2,y:c.y+ny*sw/2},{x:c.x-nx*sw/2,y:c.y-ny*sw/2}]);
  }
  const quads=[];
  for(let i=0;i<steps;i++) quads.push([pts[i][0],pts[i+1][0],pts[i+1][1],pts[i][1]]);
  return quads;
}

// Whether a convex quad and an axis-aligned box overlap (separating axes).
function quadHitsBox(q,b) {
  if (Math.max(...q.map((p)=>p.x))<=b.x || Math.min(...q.map((p)=>p.x))>=b.x+b.w) return false;
  if (Math.max(...q.map((p)=>p.y))<=b.y || Math.min(...q.map((p)=>p.y))>=b.y+b.h) return false;
  const corners=[{x:b.x,y:b.y},{x:b.x+b.w,y:b.y},{x:b.x+b.w,y:b.y+b.h},{x:b.x,y:b.y+b.h}];
  for (let i=0;i<4;i++) {
    const p=q[i], r=q[(i+1)%4], ax=-(r.y-p.y), ay=r.x-p.x;
    const qs=q.map((v)=>v.x*ax+v.y*ay), bs=corners.map((v)=>v.x*ax+v.y*ay);
    if (Math.max(...qs)<=Math.min(...bs) || Math.max(...bs)<=Math.min(...qs)) return false;
  }
  return true;
}

// NEWSROOM_SANKEY_OTHER_NOTE=1 (default off; off = byte-identical SVG): the merged "other" node is named
// apart from every data node in its column, the chart footer names the nodes it holds (names only), and a
// highlight that names only a target marks that target's largest incoming flow.
// Desktop-only larger Sankey: taller node bars and thicker bands. Exact "1"; anything else keeps today's output.
function biggerChartsEnabled(){ return process.env.NEWSROOM_BIGGER_CHARTS==="1"; }
function sankeyOtherNoteEnabled(){ return process.env.NEWSROOM_SANKEY_OTHER_NOTE==="1"; }
function sankeyColumnName(li,maxLevel,zh){
  if(li===0) return zh?"左列":"left column";
  if(li===maxLevel) return zh?"右列":"right column";
  return zh?`第${li+1}列`:`column ${li+1}`;
}
// One entry per merged column: {label, column, members:[names]} - names only, no values.
export function sankeyMergeSummary(spec, rows){
  return sankeyMergeNotes(spec,rows);
}
function sankeyMergeNotes(spec, rows){
  const zh=vizLang(spec)==="zh";
  const grandTotal=Math.max(rows.reduce((sum,r)=>sum+Math.max(0,n(r[spec.value_field])??0),0),1);
  const otherLabel=zh?"其他":"Other";
  const prelim=flowLayout(rows,spec), notes=[];
  prelim.levels.forEach((level,li)=>{
    const nameOf=(node)=>resolveEconomyDisplayName(stripNodePrefix(node.id), spec.category_names, vizLang(spec));
    const candidates=level.filter((node)=>Math.max(node.in,node.out)/grandTotal<0.03);
    if(candidates.length<2) return;
    const used=new Set(level.filter((node)=>!candidates.includes(node)).map((node)=>nameOf(node).trim().toLowerCase()));
    let label=otherLabel;
    for(let k=0; used.has(label.toLowerCase()); k++) label=zh?`其他（合并${k?k+1:""}）`:`Other (combined${k?` ${k+1}`:""})`;
    notes.push({label,column:sankeyColumnName(li,prelim.maxLevel,zh),members:candidates.map(nameOf)});
  });
  return notes;
}
function sankeyOtherFootnote(spec, rows){
  const zh=vizLang(spec)==="zh";
  const notes=sankeyMergeNotes(spec,rows);
  if(!notes.length) return "";
  return notes.map((m)=>{
    const head=m.label===(zh?"其他":"Other") ? (zh?`其他（${m.column}）`:`Other (${m.column})`) : (zh?m.label.replace(/）$/,`，${m.column}）`):m.label.replace(/\)$/,`, ${m.column})`));
    return `${head}${zh?"：":": "}${m.members.join(zh?"、":", ")}`;
  }).join(zh?"；":"; ");
}

function renderSankey(spec, rows, mobile=false) {
  const width=mobile?640:1040, nodeW=mobile?16:20;
  const gap=Math.max(12, mobile?20:16);
  const grandTotal=Math.max(rows.reduce((sum,r)=>sum+Math.max(0,n(r[spec.value_field])??0),0),1);
  const otherLabel = vizLang(spec)==="zh" ? "其他" : "Other";

  // Small-flow declutter: any node whose own total (in vs out, whichever is
  // larger) is under 3% of the grand total is a merge candidate; a column
  // only actually merges when it holds >=2 such candidates (merging a
  // single small node would just rename it, not declutter anything).
  const prelim=flowLayout(rows,spec);
  const noteOn=sankeyOtherNoteEnabled();
  const mergedIdFor=new Map(); // original node id -> synthetic "other" id
  const mergedMembers=new Map(); // synthetic id -> [{id,name,value}]
  const mergedLabels=new Map(); // synthetic id -> label (NEWSROOM_SANKEY_OTHER_NOTE=1 only)
  const mergedColumns=new Map(); // synthetic id -> column index (NEWSROOM_SANKEY_OTHER_NOTE=1 only)
  prelim.levels.forEach((level,li)=>{
    const nameOf=(node)=>resolveEconomyDisplayName(stripNodePrefix(node.id), spec.category_names, vizLang(spec));
    const candidates=level.filter((node)=>Math.max(node.in,node.out)/grandTotal<0.03);
    if(candidates.length<2) return;
    const syntheticId=`__other_L${li}__`;
    if(noteOn){
      const used=new Set(level.filter((node)=>!candidates.includes(node)).map((node)=>nameOf(node).trim().toLowerCase()));
      const zh=vizLang(spec)==="zh";
      let label=otherLabel;
      for(let k=0; used.has(label.toLowerCase()); k++) label=zh?`其他（合并${k?k+1:""}）`:`Other (combined${k?` ${k+1}`:""})`;
      mergedLabels.set(syntheticId,label); mergedColumns.set(syntheticId,li);
    }
    for(const node of candidates){
      mergedIdFor.set(node.id,syntheticId);
      if(!mergedMembers.has(syntheticId)) mergedMembers.set(syntheticId,[]);
      mergedMembers.get(syntheticId).push({
        id: node.id,
        name: resolveEconomyDisplayName(stripNodePrefix(node.id), spec.category_names, vizLang(spec)),
        value: Math.max(node.in,node.out),
      });
    }
  });
  let flowRows=rows;
  if(mergedIdFor.size){
    const remapped=rows.map((row)=>{
      const a=String(row[spec.source_field]), b=String(row[spec.target_field]);
      const a2=mergedIdFor.get(a), b2=mergedIdFor.get(b);
      if(!a2&&!b2) return row;
      return { ...row, [spec.source_field]: a2??a, [spec.target_field]: b2??b };
    });
    // Coalesce rows that now share the same (source,target) pair after
    // remapping, so the merge yields one flow-link per pair, not several
    // stacked on top of each other - summing keeps the merge exact (no
    // value is dropped, only regrouped).
    const combined=new Map();
    for(const row of remapped){
      const key=`${row[spec.source_field]}\u0000${row[spec.target_field]}`;
      if(!combined.has(key)) combined.set(key,{...row,[spec.value_field]:0});
      combined.get(key)[spec.value_field]=(n(combined.get(key)[spec.value_field])??0)+(n(row[spec.value_field])??0);
    }
    flowRows=[...combined.values()];
  }

  const layout=flowLayout(flowRows,spec);
  // flowLayout already sorts each column by value descending; force every
  // synthetic "other" node to the end of its column regardless of its
  // (possibly competitive) merged total, so it still reads as the
  // catch-all, not a peer.
  layout.levels.forEach((level)=>{
    for(let i=level.length-1;i>=0;i--){
      if(String(level[i].id).startsWith("__other_")){ const [node]=level.splice(i,1); level.push(node); }
    }
  });
  const displayNameOf=(id)=> String(id).startsWith("__other_") ? (mergedLabels.get(String(id))??otherLabel) : resolveEconomyDisplayName(stripNodePrefix(id), spec.category_names, vizLang(spec));

  const nodeValues=[...layout.nodes.values()].map((node)=>Math.max(node.in,node.out)); const maxNode=Math.max(...nodeValues,1);
  const bigger=!mobile&&biggerChartsEnabled();
  const barHeight=bigger?(node)=>Math.max(22,Math.min(140,(Math.max(node.in,node.out)/maxNode)*180)):(node)=>Math.max(22,Math.min(100,(Math.max(node.in,node.out)/maxNode)*130));
  const neededH=Math.max(...layout.levels.map((level)=>level.reduce((sum,node)=>sum+barHeight(node),0)+gap*Math.max(0,level.length-1)),120);
  const bodyH=neededH+(mobile?96:88)+(!mobile&&biggerChartsEnabled()?16:0); // larger bars leave a through node less room for its label above it

  // Reserve side margins for the actually measured label widths (name bold
  // 14px, value 12.5px) instead of a fixed constant, so a long country name
  // never clips against the canvas edge and a short one doesn't waste
  // margin space.
  const nameFont=mobile?13:14, valueFont=mobile?12:12.5;
  const nameCharBudget=mobile?9:14;
  let maxLeftWidth=0, maxRightWidth=0;
  layout.levels.forEach((level,li)=>{
    const side = li <= layout.maxLevel/2 ? "left" : "right";
    level.forEach((node)=>{
      const name=displayNameOf(node.id);
      const shortName=textUnits(name)>nameCharBudget?sliceUnits(name,nameCharBudget-1)+"…":name;
      const value=fmtLocalizedUnit(spec, Math.max(node.in,node.out));
      const w=Math.max(textUnits(shortName)*nameFont*0.62, textUnits(value)*valueFont*0.58)+10;
      if(side==="left") maxLeftWidth=Math.max(maxLeftWidth,w); else maxRightWidth=Math.max(maxRightWidth,w);
    });
  });
  const leftMargin=Math.max(60,maxLeftWidth+18), rightMargin=Math.max(60,maxRightWidth+18);

  // With the note on, the merged nodes' members join the chart note, so the frame grows the footer for it.
  const footnote=noteOn&&mergedIdFor.size?sankeyOtherFootnote(spec,rows):"";
  const frameSpec=footnote?{...spec,note:[spec.note,footnote].filter(Boolean).join(vizLang(spec)==="zh"?" ":" ")}:spec;
  const f=mobile?mobileFrame(frameSpec,bodyH):frame(frameSpec,bodyH), left=leftMargin, right=width-rightMargin, top=f.bodyTop+28, bottom=f.bodyBottom-28;
  const levels=Math.max(layout.maxLevel+1,2), xAt=(level)=>left+(right-left-nodeW)*(level/Math.max(1,levels-1));
  const positions=new Map();
  layout.levels.forEach((level,li)=>{const totalH=bottom-top, usable=totalH-gap*Math.max(0,level.length-1), raw=level.map(barHeight), sum=raw.reduce((a,b)=>a+b,0), scale=sum>usable?usable/sum:1;let y=top+(usable-sum*scale)/2;level.forEach((node,i)=>{const h=raw[i]*scale;positions.set(node.id,{x:xAt(li),y,h});y+=h+gap;});});

  const maxFlow=Math.max(...flowRows.map((r)=>n(r[spec.value_field])??0),1);
  const strokeWidthOf=(row)=>Math.max(1.5,(Math.max(0,n(row[spec.value_field])??0)/maxFlow)*(mobile?22:bigger?44:30));

  // Crossing minimization (Task C): order each node's outgoing links by
  // their target's own vertical order, and each node's incoming links by
  // their source's vertical order, then stack that node's link anchors
  // top-to-bottom in that order (a centered block, not the old alternating
  // +/- jitter) - the standard construction that keeps same-direction links
  // from crossing each other as they leave/arrive at a shared node.
  const bySource=new Map(), byTarget=new Map();
  for (const row of flowRows) {
    const a=String(row[spec.source_field]), b=String(row[spec.target_field]);
    if(!bySource.has(a)) bySource.set(a,[]); bySource.get(a).push(row);
    if(!byTarget.has(b)) byTarget.set(b,[]); byTarget.get(b).push(row);
  }
  const rowY1=new Map(), rowY2=new Map();
  for (const [id,list] of bySource) {
    const p=positions.get(id); if(!p) continue;
    list.sort((r1,r2)=>(positions.get(String(r1[spec.target_field]))?.y??0)-(positions.get(String(r2[spec.target_field]))?.y??0));
    const sws=list.map(strokeWidthOf), total=sws.reduce((a,b)=>a+b,0);
    let cursor=p.y+p.h/2-total/2;
    list.forEach((row,i)=>{ rowY1.set(row, cursor+sws[i]/2); cursor+=sws[i]; });
  }
  for (const [id,list] of byTarget) {
    const p=positions.get(id); if(!p) continue;
    list.sort((r1,r2)=>(positions.get(String(r1[spec.source_field]))?.y??0)-(positions.get(String(r2[spec.source_field]))?.y??0));
    const sws=list.map(strokeWidthOf), total=sws.reduce((a,b)=>a+b,0);
    let cursor=p.y+p.h/2-total/2;
    list.forEach((row,i)=>{ rowY2.set(row, cursor+sws[i]/2); cursor+=sws[i]; });
  }

  // Pre-compute node name/value label boxes as obstacles for the flow-value
  // label below (drawn from underneath the links, before the node labels
  // are actually emitted, so a value label never overlaps a node's own
  // label even though the node text itself is written to the SVG later).
  const nodeLabelBoxes=[];
  layout.levels.forEach((level,li)=>{
    const side = li <= layout.maxLevel/2 ? "left" : "right";
    level.forEach((node)=>{
      const p=positions.get(node.id); if(!p) return;
      const name=displayNameOf(node.id);
      const shortName=textUnits(name)>nameCharBudget?sliceUnits(name,nameCharBudget-1)+"…":name;
      const value=fmtLocalizedUnit(spec, Math.max(node.in,node.out));
      const labelX = side === "left" ? p.x - 8 : p.x + nodeW + 8;
      const nameY = p.y + p.h/2 - 3, valueY = p.y + p.h/2 + 13;
      const w = Math.max(textUnits(shortName)*nameFont*0.62, textUnits(value)*valueFont*0.58) + 6;
      const x = side === "left" ? labelX - w : labelX;
      nodeLabelBoxes.push({ x, y: nameY - nameFont - 3, w, h: (valueY - nameY) + valueFont + 7 });
    });
  });

  // Node annotations (addPointlessFlowAnnotations, below) render text next
  // to a node bar too, but only after the flow links are drawn - reserve
  // their boxes as obstacles here so the flow-value label (there is at most
  // one now - only the highlighted flow gets one) never lands on top of one.
  for(const annotation of annotations(spec)) {
    if(annotation.type!=="node") continue;
    const p=positions.get(String(annotation.match_value)); if(!p) continue;
    const lines=wrapText(annotationLabel(annotation,mobile?26:34),mobile?26:34).slice(0,3);
    const step=mobile?15:16, fontSize=mobile?12:12.5;
    const cx=p.x+nodeW/2, above=p.y>90;
    const anchorY=above?p.y-18:p.y+p.h+24, baseY=above?anchorY-(lines.length-1)*step:anchorY;
    const maxLineUnits=Math.max(1,...lines.map((line)=>textUnits(line)));
    const w=maxLineUnits*fontSize*0.62+8;
    nodeLabelBoxes.push({x:cx-w/2, y:baseY-fontSize-3, w, h:(lines.length-1)*step+fontSize+7});
  }

  const highlightSet=new Set((spec.highlight_values??[]).map(String));
  // An explicit (source, target) pair named together in highlight_values is
  // always the highlighted flow - that is the spec author's actual claim.
  // "Largest outgoing link from a highlighted source" is only a fallback for
  // when highlight_values names a source but no specific target, so the flow
  // to highlight is otherwise ambiguous.
  const explicitTargetsForSource=new Map();
  for (const row of flowRows) {
    const a=String(row[spec.source_field]), b=String(row[spec.target_field]);
    const aHi=highlightSet.has(a)||highlightSet.has(stripNodePrefix(a));
    const bHi=highlightSet.has(b)||highlightSet.has(stripNodePrefix(b));
    if(!aHi||!bHi) continue;
    if(!explicitTargetsForSource.has(a)) explicitTargetsForSource.set(a,new Set());
    explicitTargetsForSource.get(a).add(b);
  }
  const maxRowForSource=new Map();
  for (const row of flowRows) {
    const a=String(row[spec.source_field]);
    const v=Math.max(0,n(row[spec.value_field])??0);
    const cur=maxRowForSource.get(a);
    if(!cur||v>cur.v) maxRowForSource.set(a,{row,v});
  }
  const maxRowForTarget=new Map();
  if(noteOn) for (const row of flowRows) {
    const b=String(row[spec.target_field]);
    const v=Math.max(0,n(row[spec.value_field])??0);
    const cur=maxRowForTarget.get(b);
    if(!cur||v>cur.v) maxRowForTarget.set(b,{row,v});
  }
  const isHighlightedRow=(row)=>{
    if(highlightSet.size===0) return false;
    const a=String(row[spec.source_field]);
    const sourceHighlighted=highlightSet.has(a)||highlightSet.has(stripNodePrefix(a));
    if(!sourceHighlighted){
      // Target only (note on): mirror the source-only rule - the target's largest incoming flow.
      if(!noteOn) return false;
      const b=String(row[spec.target_field]);
      if(!(highlightSet.has(b)||highlightSet.has(stripNodePrefix(b)))) return false;
      if(bySource.has(b)) return false; // a through node keeps the source rule (its largest outgoing flow)
      return maxRowForTarget.get(b)?.row===row;
    }
    const explicitTargets=explicitTargetsForSource.get(a);
    if(explicitTargets&&explicitTargets.size>0) return explicitTargets.has(String(row[spec.target_field]));
    return maxRowForSource.get(a)?.row===row;
  };
  const highlightedNodeIds=new Set();
  for(const row of flowRows) if(isHighlightedRow(row)){ highlightedNodeIds.add(String(row[spec.source_field])); highlightedNodeIds.add(String(row[spec.target_field])); }

  const valueLabelBoxes=[...nodeLabelBoxes];
  const orderedRows=flowRows.slice().sort((a,b)=>(isHighlightedRow(a)?1:0)-(isHighlightedRow(b)?1:0)); // non-highlighted first, highlighted drawn last (on top)
  orderedRows.forEach((row)=>{
    const a=String(row[spec.source_field]), b=String(row[spec.target_field]), v=Math.max(0,n(row[spec.value_field])??0);
    const pa=positions.get(a), pb=positions.get(b);
    if(!pa||!pb) return;
    const sw=strokeWidthOf(row), y1=rowY1.get(row)??pa.y+pa.h/2, y2=rowY2.get(row)??pb.y+pb.h/2;
    const highlighted=isHighlightedRow(row);
    const color=highlighted?PALETTE.accent:flowGreyLink();
    const opacity=highlighted?0.85:0.35;
    const flowKey=spec.flow_id_field && row[spec.flow_id_field]!==undefined ? String(row[spec.flow_id_field]) : `${a}→${b}`;
    const x1=pa.x+nodeW,x2=pb.x;
    const d=sankeyPath(x1,y1,x2,y2);
    f.parts.push(`<path data-role="flow-hit" data-flow-key="${esc(flowKey)}" d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(14,sw*2.5)}" stroke-linecap="round" pointer-events="stroke"/>`);
    // A round linecap draws a half-circle protruding past the path's
    // literal endpoint. Because sankeyPath's control points make the
    // tangent perfectly horizontal at both ends, that protrusion showed up
    // as a stray semicircle "blob" sitting behind the node bar. A butt cap
    // ends exactly at (x1,y1)/(x2,y2), flush against the node's straight
    // edge, with no protrusion.
    f.parts.push(`<path data-role="flow-link" data-flow-key="${esc(flowKey)}" d="${d}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-opacity="${opacity}" stroke-linecap="butt" pointer-events="none"/>`);
    // Only the single highlighted flow gets an inline value, on paper beside
    // its own band near whichever end (source t~0.22, or target t~0.78)
    // isn't already claimed - every other flow's value lives only in its
    // node labels, so the diagram never shows an ambiguous floating number.
    if (highlighted) {
      const text=fmtLocalizedUnit(spec, v);
      const fontSize=mobile?12:12.5;
      const boxW=text.length*fontSize*0.8+8;
      // The label sits on paper beside its band, never on it, in the accent's
      // text-safe shade with no halo. A candidate is clear when its box keeps
      // 2px from every node label box, other value label, node bar and every
      // flow band (this one included), and its own band is at least 1px nearer
      // than any other (gap: text box to centreline, less half the width);
      // when no candidate qualifies, no inline label is drawn.
      const labelFill=textSafeColor(PALETTE.accent);
      const clearance=2;
      const inflate=(b)=>({x:b.x-clearance,y:b.y-clearance,w:b.w+2*clearance,h:b.h+2*clearance});
      const barBoxes=[...positions.values()].map((p)=>({x:p.x,y:p.y,w:nodeW,h:p.h}));
      const bandInfo=flowRows.map((r)=>{
        const pa2=positions.get(String(r[spec.source_field])), pb2=positions.get(String(r[spec.target_field]));
        if(!pa2||!pb2) return null;
        const bx1=pa2.x+nodeW, by1=rowY1.get(r)??pa2.y+pa2.h/2, bx2=pb2.x, by2=rowY2.get(r)??pb2.y+pb2.h/2, bsw=strokeWidthOf(r);
        return { own:r===row, sw:bsw, quads:sankeyBandQuads(bx1,by1,bx2,by2,bsw), line:Array.from({length:161},(_,i)=>sankeyPointAt(bx1,by1,bx2,by2,i/160)) };
      }).filter(Boolean);
      const bands=bandInfo.map((b)=>b.quads);
      const bandGap=(tb,b)=>Math.min(...b.line.map((p)=>Math.hypot(Math.max(tb.x-p.x,0,p.x-(tb.x+tb.w)),Math.max(tb.y-p.y,0,p.y-(tb.y+tb.h)))))-b.sw/2;
      const ownIsNearest=(cx,baseY)=>{
        const tw=estimateTextWidth(text,fontSize,true);
        const tb={x:cx-tw/2,y:baseY-fontSize*ASCENT_RATIO,w:tw,h:fontSize*(ASCENT_RATIO+DESCENT_RATIO)};
        const ownGap=bandGap(tb,bandInfo.find((b)=>b.own));
        return bandInfo.every((b)=>b.own||bandGap(tb,b)>=ownGap+1);
      };
      const isClear=(box)=>{
        const wide=inflate(box);
        if (wide.x<0||wide.x+wide.w>width) return false;
        if (valueLabelBoxes.some((o)=>boxesOverlap(wide,o))||barBoxes.some((o)=>boxesOverlap(wide,o))) return false;
        return !bands.some((quads)=>quads.some((q)=>quadHitsBox(q,wide)));
      };
      let placed=null;
      candidates: for (const t of [0.22, 0.78, 0.5, 0.35, 0.65]) {
        const pt=sankeyPointAt(x1,y1,x2,y2,t);
        const above=t<0.5;
        for (const side of [above, !above]) {
          const preferredY=side ? pt.y-sw/2-5 : pt.y+sw/2+13;
          const placedY=resolveLabelCollisionY(pt.x, preferredY, boxW+2*clearance, fontSize, valueLabelBoxes, top+10, bottom-4);
          // Today's nudge first; a band that slopes under the box needs more room than
          // a flat one, so the box then moves away from its band in 2px steps.
          for (let push=0; push<=8; push+=2) {
            const y=placedY+(side ? -push : push);
            const box={x:pt.x-boxW/2, y:y-fontSize-3, w:boxW, h:fontSize+7};
            if (y<top+10 || y>bottom-4) break;
            if (isClear(box)&&ownIsNearest(pt.x,y)) { placed={x:pt.x,y,box}; break candidates; }
          }
        }
      }
      if (placed) {
        valueLabelBoxes.push(placed.box);
        f.parts.push(`<text data-role="flow-value-label" data-flow-key="${esc(flowKey)}" x="${placed.x}" y="${placed.y}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${fontSize}" font-weight="700" fill="${labelFill}">${esc(text)}</text>`);
      }
    }
  });

  // Outside labels: a root (level 0) label sits right-aligned before its
  // bar; a sink (the deepest level) sits left-aligned after its bar -
  // name in bold ink on the first line, its value in a lighter muted tone
  // (in the localized unit) on the second, both >=12px. A merged "other"
  // node renders the same way, with its constituent members recorded in a
  // non-visual <metadata> element (an exact sum - see the merge above -
  // never a lossy approximation) so the merge can be verified from the
  // rendered SVG.
  // A label placed "above" a through-node's bar (see below) is only safe
  // when no flow-link's curve actually sweeps through that space. Most
  // links only touch the columns they connect, but a link whose two
  // endpoints straddle a middle column (the source and target aren't in
  // adjacent levels - e.g. a node reached by a shorter path elsewhere,
  // leaving a slack link that skips over it) can arc directly through the
  // space above an unrelated node in that middle column, even though there
  // is plenty of vertical headroom in that node's own column. Sampling each
  // rendered curve (same x1/y1/x2/y2 the link loop above already computed)
  // and checking for any sample landing inside the candidate label box is a
  // cheap, exact-enough stand-in for full path-vs-box intersection.
  function curveHitsBox(x1,y1,x2,y2,box){
    for(let i=0;i<=24;i++){
      const t=i/24, p=sankeyPointAt(x1,y1,x2,y2,t);
      if(p.x>=box.x&&p.x<=box.x+box.w&&p.y>=box.y&&p.y<=box.y+box.h) return true;
    }
    return false;
  }
  function anyCurveHitsBox(box){
    for(const row of flowRows){
      const a=String(row[spec.source_field]), b=String(row[spec.target_field]);
      const pa=positions.get(a), pb=positions.get(b);
      if(!pa||!pb) continue;
      const y1=rowY1.get(row)??pa.y+pa.h/2, y2=rowY2.get(row)??pb.y+pb.h/2;
      const x1=pa.x+nodeW, x2=pb.x;
      if(curveHitsBox(x1,y1,x2,y2,box)) return true;
    }
    return false;
  }
  layout.levels.forEach((level,li)=>{
    const side = li <= layout.maxLevel/2 ? "left" : "right";
    level.forEach((node)=>{
      const p=positions.get(node.id); if(!p) return;
      const isOther=String(node.id).startsWith("__other_");
      const highlighted=highlightedNodeIds.has(node.id);
      const nodeFill=highlighted?PALETTE.accent:FLOW_GREY_NODE;
      f.parts.push(`<rect data-role="flow-node" data-value="${Math.max(node.in,node.out)}" x="${p.x}" y="${p.y}" width="${nodeW}" height="${p.h}" rx="${nodeW/4}" fill="${nodeFill}"/>`);
      const name=displayNameOf(node.id);
      const value=fmtLocalizedUnit(spec, Math.max(node.in,node.out));
      // A "through" node (has both incoming and outgoing links, e.g. a hub
      // stage in a 3+ level flow) sits with converging link curves flattening
      // out right at its own edge on BOTH sides - a side-anchored label there
      // reliably lands on top of whichever link's terminal segment happens to
      // pass near the node's vertical centre, and no horizontal offset fixes
      // this in general because the curves are already flat by the time
      // they reach the node. Such a node's label instead sits directly above
      // its bar, centred, where no link ever renders. Root nodes (only
      // outgoing) and sink nodes (only incoming) keep the side placement
      // documented above - they only have one link bundle to clear.
      const isThrough = node.in>0 && node.out>0;
      const aboveHeadroom = p.y - top >= (nameFont+valueFont+12);
      const aboveBox = { x: p.x+nodeW/2-Math.max(nameFont,valueFont)*4, y: p.y-nameFont-valueFont-10, w: Math.max(nameFont,valueFont)*8, h: nameFont+valueFont+8 };
      const aboveClear = aboveHeadroom && !anyCurveHitsBox(aboveBox);
      if (isThrough && aboveClear) {
        const cx = p.x + nodeW/2;
        const nameY2 = p.y - valueFont - 8, valueY2 = p.y - 4;
        f.parts.push(`<text data-role="flow-node-label" x="${cx}" y="${nameY2}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${nameFont}" font-weight="700" fill="${PALETTE.ink}">${esc(textUnits(name)>nameCharBudget?sliceUnits(name,nameCharBudget-1)+"…":name)}</text>`);
        f.parts.push(`<text data-role="flow-node-value" x="${cx}" y="${valueY2}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${valueFont}" fill="${PALETTE.muted}">${esc(value)}</text>`);
      } else {
        const anchor = side === "left" ? "end" : "start";
        const labelX = side === "left" ? p.x - 8 : p.x + nodeW + 8;
        const nameY = p.y + p.h/2 - 3, valueY = p.y + p.h/2 + 13;
        f.parts.push(`<text data-role="flow-node-label" x="${labelX}" y="${nameY}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${nameFont}" font-weight="700" fill="${PALETTE.ink}">${esc(textUnits(name)>nameCharBudget?sliceUnits(name,nameCharBudget-1)+"…":name)}</text>`);
        f.parts.push(`<text data-role="flow-node-value" x="${labelX}" y="${valueY}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${valueFont}" fill="${PALETTE.muted}">${esc(value)}</text>`);
      }
      if(isOther){
        const members=mergedMembers.get(node.id)??[];
        f.parts.push(`<metadata data-role="flow-merge" data-node="${esc(node.id)}" data-total="${Math.max(node.in,node.out)}">${esc(JSON.stringify(members))}</metadata>`);
      }
    });
  });
  addPointlessFlowAnnotations(f.parts,spec,positions,nodeW,f.annotationLayout,mobile);
  (mobile?addMobileFooter:addFooter)(f.parts,frameSpec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";
}

function addPointlessFlowAnnotations(parts,spec,positions,nodeW,layout,mobile){for(const annotation of annotations(spec)){if(annotation.type!=="node")continue;const p=positions.get(String(annotation.match_value));if(!p)continue;const lines=wrapText(annotationLabel(annotation,mobile?26:34),mobile?26:34).slice(0,3),cx=p.x+nodeW/2,above=p.y>90,step=mobile?15:16,anchorY=above?p.y-18:p.y+p.h+24,baseY=above?anchorY-(lines.length-1)*step:anchorY;parts.push(`<line data-role="annotation-leader" x1="${cx}" y1="${above?p.y:p.y+p.h}" x2="${cx}" y2="${above?anchorY+7:anchorY-13}" stroke="${PALETTE.muted}" stroke-width="1"/>`);lines.forEach((line,i)=>parts.push(`<text data-role="annotation" x="${cx}" y="${baseY+i*step}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="600" fill="${PALETTE.ink}">${esc(line)}</text>`));}}

function networkLayout(rows,spec,width,height,left,top,right,bottom){const ids=unique(rows.flatMap((row)=>[row[spec.source_field],row[spec.target_field]])),degree=new Map(ids.map((id)=>[id,0]));for(const row of rows){degree.set(String(row[spec.source_field]),(degree.get(String(row[spec.source_field]))??0)+1);degree.set(String(row[spec.target_field]),(degree.get(String(row[spec.target_field]))??0)+1);}ids.sort((a,b)=>(degree.get(b)??0)-(degree.get(a)??0)||String(a).localeCompare(String(b)));const cx=(left+right)/2,cy=(top+bottom)/2,rx=(right-left)*.42,ry=(bottom-top)*.4,pos=new Map();ids.forEach((id,i)=>{const angle=-Math.PI/2+(i/Math.max(ids.length,1))*Math.PI*2;pos.set(String(id),{x:cx+Math.cos(angle)*rx,y:cy+Math.sin(angle)*ry,degree:degree.get(id)??0});});return {ids,pos,degree};}

function renderNodeLink(spec,rows,mobile=false){const f=mobile?mobileFrame(spec,440):frame(spec,440),left=mobile?58:110,right=mobile?582:930,top=f.bodyTop+35,bottom=f.bodyBottom-35,layout=networkLayout(rows,spec,mobile?640:1040,440,left,top,right,bottom),maxDegree=Math.max(...layout.ids.map((id)=>layout.degree.get(id)),1);for(const row of rows){const a=layout.pos.get(String(row[spec.source_field])),b=layout.pos.get(String(row[spec.target_field]));if(!a||!b)continue;const value=spec.value_field?(n(row[spec.value_field])??1):1;f.parts.push(`<line data-role="network-edge" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${PALETTE.context}" stroke-width="${Math.min(5,Math.max(.7,Math.sqrt(Math.abs(value))))}" stroke-opacity=".48"/>`);}for(const id of layout.ids){const p=layout.pos.get(id),highlighted=(spec.highlight_values??[]).includes(id),r=4.5+(p.degree/maxDegree)*8;f.parts.push(`<circle data-role="network-node" cx="${p.x}" cy="${p.y}" r="${r}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}" stroke="#fff" stroke-width="1.4"/>`);if(layout.ids.length<=24||highlighted)f.parts.push(`<text data-role="direct-label" x="${p.x+(p.x<(left+right)/2?-(r+5):(r+5))}" y="${p.y-7}" text-anchor="${p.x<(left+right)/2?"end":"start"}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="${highlighted?700:500}" fill="${PALETTE.ink}">${esc(id)}</text>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

// Nodes keep their first-appearance order (see facetOrder), not name order.
function renderAdjacencyMatrix(spec,rows,mobile=false){const ids=facetOrder(unique(rows.flatMap((row)=>[row[spec.source_field],row[spec.target_field]]))),nIds=ids.length,bodyH=Math.max(mobile?360:420,nIds*(mobile?22:25)+100),f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?130:220,top=f.bodyTop+105,size=Math.min((mobile?640:1040)-left-(mobile?38:70),f.bodyBottom-top-25),cell=Math.max(3,size/Math.max(1,nIds)),index=new Map(ids.map((id,i)=>[String(id),i])),values=rows.map((row)=>spec.value_field?(n(row[spec.value_field])??1):1),max=Math.max(...values.map(Math.abs),1),edgeMap=new Map();rows.forEach((row)=>edgeMap.set(`${row[spec.source_field]}\0${row[spec.target_field]}`,spec.value_field?(n(row[spec.value_field])??1):1));ids.forEach((id,i)=>{const y=top+(i+.5)*cell,x=left+(i+.5)*cell;f.parts.push(`<text x="${left-8}" y="${y+3}" text-anchor="end" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.ink}">${esc(textUnits(String(id))>(mobile?11:16)?sliceUnits(String(id),mobile?10:15)+"…":id)}</text>`);if(nIds<=28)f.parts.push(`<text x="${x}" y="${top-8}" transform="rotate(-90 ${x} ${top-8})" text-anchor="start" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">${esc(textUnits(String(id))>13?sliceUnits(String(id),12)+"…":id)}</text>`);});for(const [key,value] of edgeMap){const [a,b]=key.split("\0"),i=index.get(a),j=index.get(b),t=Math.sqrt(Math.abs(value)/max);f.parts.push(`<rect data-role="matrix-cell" x="${left+j*cell+1}" y="${top+i*cell+1}" width="${Math.max(1,cell-2)}" height="${Math.max(1,cell-2)}" fill="${PALETTE.accent2}" fill-opacity="${.12+.78*t}"/>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

// Siblings keep their first-appearance order (see facetOrder), not name order.
function hierarchyLayout(rows,spec){const byId=new Map(rows.map((row)=>[String(row[spec.node_field]),row])),children=new Map(),root=rows.find((row)=>row[spec.parent_field]===null||row[spec.parent_field]===undefined||String(row[spec.parent_field])==="");for(const row of rows){const p=row[spec.parent_field];if(p===null||p===undefined||String(p)==="")continue;const key=String(p);if(!children.has(key))children.set(key,[]);children.get(key).push(String(row[spec.node_field]));}for(const [key,list] of children)children.set(key,facetOrder(list));const positions=new Map(),levels=[];let leaf=0;const visit=(id,level)=>{if(!levels[level])levels[level]=[];levels[level].push(id);const kids=children.get(id)??[];if(!kids.length){positions.set(id,{leaf:leaf++,level});return positions.get(id).leaf;}const xs=kids.map((kid)=>visit(kid,level+1));const x=xs.reduce((a,b)=>a+b,0)/xs.length;positions.set(id,{leaf:x,level});return x;};if(root)visit(String(root[spec.node_field]),0);return {byId,children,positions,levels,leafCount:Math.max(leaf,1)};}

function renderHierarchyTree(spec,rows,mobile=false){const h=hierarchyLayout(rows,spec),depth=Math.max(...[...h.positions.values()].map((p)=>p.level),0),bodyH=Math.max(mobile?420:410,h.leafCount*(mobile?36:32)+80),f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?70:100,right=mobile?590:940,top=f.bodyTop+28,bottom=f.bodyBottom-28,x=(leaf)=>left+(leaf/(Math.max(1,h.leafCount-1)))*(right-left),y=(level)=>top+(level/Math.max(1,depth))*(bottom-top);for(const [parent,kids] of h.children){const pp=h.positions.get(parent);for(const kid of kids){const kp=h.positions.get(kid);f.parts.push(`<path d="M${x(pp.leaf)},${y(pp.level)} C${x(pp.leaf)},${(y(pp.level)+y(kp.level))/2} ${x(kp.leaf)},${(y(pp.level)+y(kp.level))/2} ${x(kp.leaf)},${y(kp.level)}" fill="none" stroke="${PALETTE.context}" stroke-width="1.5"/>`);}}for(const [id,p] of h.positions){const highlighted=(spec.highlight_values??[]).includes(id);f.parts.push(`<circle cx="${x(p.leaf)}" cy="${y(p.level)}" r="${highlighted?6:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x(p.leaf)}" y="${y(p.level)+(p.level===depth?16:-10)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="${highlighted?700:500}" fill="${PALETTE.ink}">${esc(textUnits(String(id))>(mobile?11:15)?sliceUnits(String(id),mobile?10:14)+"…":id)}</text>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

function timelineValues(rows,spec){const parse=(v)=>{if(typeof v==="number")return v;const d=Date.parse(String(v));return Number.isFinite(d)?d:Number(v);};return rows.map((row)=>({...row,__time:parse(row[spec.x_field])})).filter((row)=>Number.isFinite(row.__time)).sort((a,b)=>a.__time-b.__time);}

function renderTimeline(spec,rows,mobile=false){const sorted=timelineValues(rows,spec);if(mobile){const bodyH=Math.max(390,sorted.length*64+40),f=mobileFrame(spec,bodyH),x=75,top=f.bodyTop+20,bottom=f.bodyBottom-20;f.parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${PALETTE.grid}" stroke-width="2"/>`);sorted.forEach((row,i)=>{const y=top+(i/(Math.max(1,sorted.length-1)))*(bottom-top),highlighted=(spec.highlight_values??[]).includes(String(row[spec.label_field]));f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted?6:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x+18}" y="${y-5}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(String(row[spec.x_field]))}</text>`);svgTextLines(f.parts,String(row[spec.label_field]),x+18,y+10,{size:12,lineHeight:16,weight:highlighted?700:500,maxChars:50});});addMobileFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}const f=frame(spec,390),left=90,right=950,y=(f.bodyTop+f.bodyBottom)/2,min=sorted[0]?.__time??0,max=sorted.at(-1)?.__time??1,scale=(v)=>left+((v-min)/(max-min||1))*(right-left);f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="2"/>`);sorted.forEach((row,i)=>{const x=scale(row.__time),up=i%2===0,highlighted=(spec.highlight_values??[]).includes(String(row[spec.label_field])),stemEnd=y+(up?-42:42),dateY=y+(up?-49:51),eventY=y+(up?-78:72);f.parts.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${stemEnd}" stroke="${PALETTE.context}"/>`);f.parts.push(`<circle cx="${x}" cy="${y}" r="${highlighted?6:4.5}" fill="${highlighted?PALETTE.accent:PALETTE.accent2}"/>`);f.parts.push(`<text x="${x}" y="${dateY}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${esc(String(row[spec.x_field]))}</text>`);svgTextLines(f.parts,String(row[spec.label_field]),x,eventY,{size:12,lineHeight:16,weight:highlighted?700:500,maxChars:22,anchor:"middle"});});addFooter(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}

// Series keep their first-appearance order (see facetOrder), not name order;
// the x axis is a sequence and still sorts.
function renderStreamgraph(spec,rows,mobile=false){const xs=sortX(unique(rows.map((r)=>r[spec.x_field]))),series=facetOrder(unique(rows.map((r)=>r[spec.series_field]))),index=new Map(rows.map((r)=>[`${r[spec.x_field]}\0${r[spec.series_field]}`,Math.max(0,n(r[spec.value_field])??0)])),totals=xs.map((x)=>series.reduce((sum,ser)=>sum+(index.get(`${x}\0${ser}`)??0),0)),maxTotal=Math.max(...totals,1),bodyH=mobile?380:400,f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?45:85,right=mobile?600:950,top=f.bodyTop+22,bottom=f.bodyBottom-40,xScale=(i)=>xs.length<=1?(left+right)/2:left+(i/(xs.length-1))*(right-left),yScale=(v)=>((v/maxTotal)*(bottom-top)*.82),upper=new Array(xs.length).fill(0);series.forEach((ser,si)=>{const topPts=[],bottomPts=[];xs.forEach((x,xi)=>{const total=totals[xi],baseline=(bottom+top)/2+yScale(total)/2,low=baseline-yScale(upper[xi]),value=index.get(`${x}\0${ser}`)??0,high=low-yScale(value);bottomPts.push(`${xScale(xi)},${low}`);topPts.push(`${xScale(xi)},${high}`);upper[xi]+=value;});const path=[`M${topPts[0]}`,...topPts.slice(1).map((p)=>`L${p}`),...bottomPts.reverse().map((p)=>`L${p}`),"Z"].join(" ");f.parts.push(`<path data-role="stream" d="${path}" fill="${SERIES_COLORS[si%SERIES_COLORS.length]}" fill-opacity=".78" stroke="#fff" stroke-width=".8"/>`);});if(xs.length){f.parts.push(`<text x="${left}" y="${bottom+24}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xs[0])}</text>`);f.parts.push(`<text x="${right}" y="${bottom+24}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(xs.at(-1))}</text>`);}let ly=top+4;series.forEach((ser,si)=>{f.parts.push(`<rect x="${right-(mobile?145:175)}" y="${ly-9}" width="9" height="9" fill="${SERIES_COLORS[si%SERIES_COLORS.length]}"/>`);f.parts.push(`<text x="${right-(mobile?132:162)}" y="${ly}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.ink}">${esc(textUnits(String(ser))>20?sliceUnits(String(ser),19)+"…":ser)}</text>`);ly+=17;});(mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push("</svg>");return f.parts.join("\n")+"\n";}


function geoProjection(lon, lat, left, right, top, bottom) {
  const x = left + ((clamp(lon, -180, 180) + 180) / 360) * (right - left);
  const y = bottom - ((clamp(lat, -70, 85) + 70) / 155) * (bottom - top);
  return { x, y };
}

function greatCircleLikePath(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - Math.min(70, Math.hypot(b.x - a.x, b.y - a.y) * 0.16);
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
}

function renderGeoFlowMap(spec, rows, mobile=false) {
  const bodyH = mobile ? 390 : 430;
  const f = mobile ? mobileFrame(spec, bodyH) : frame(spec, bodyH);
  const left = mobile ? 42 : 72, right = mobile ? 604 : 968, top = f.bodyTop + 22, bottom = f.bodyBottom - 52;
  f.parts.push(`<rect x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" rx="3" fill="${PALETTE.faint}" stroke="${PALETTE.grid}"/>`);
  for (const lon of [-120,-60,0,60,120]) { const p=geoProjection(lon,0,left,right,top,bottom); f.parts.push(`<line x1="${p.x}" y1="${top}" x2="${p.x}" y2="${bottom}" stroke="#e2e5e8" stroke-width=".8"/>`); }
  for (const lat of [-60,-30,0,30,60]) { const p=geoProjection(0,lat,left,right,top,bottom); f.parts.push(`<line x1="${left}" y1="${p.y}" x2="${right}" y2="${p.y}" stroke="#e2e5e8" stroke-width=".8"/>`); }
  const max = Math.max(...rows.map((row)=>n(row[spec.value_field]) ?? 0), 1);
  const pointLabels = new Map();
  rows.slice().sort((a,b)=>(n(a[spec.value_field])??0)-(n(b[spec.value_field])??0)).forEach((row, i)=>{
    const a=geoProjection(n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),left,right,top,bottom);
    const b=geoProjection(n(row[spec.target_lon_field]),n(row[spec.target_lat_field]),left,right,top,bottom);
    const value=n(row[spec.value_field])??0; if(value<=0)return; const sw=Math.max(1.2,Math.sqrt(value/max)*(mobile?10:14));
    f.parts.push(`<path data-role="geo-flow" d="${greatCircleLikePath(a,b)}" fill="none" stroke="${SERIES_COLORS[i%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity=".5" stroke-linecap="round"/>`);
    f.parts.push(`<circle cx="${a.x}" cy="${a.y}" r="${mobile?3:3.5}" fill="${PALETTE.ink}"/>`);
    f.parts.push(`<circle cx="${b.x}" cy="${b.y}" r="${mobile?3:3.5}" fill="${PALETTE.accent}"/>`);
    if (spec.source_field && row[spec.source_field] !== undefined) pointLabels.set(`s:${row[spec.source_field]}`,{x:a.x,y:a.y,text:String(row[spec.source_field]),anchor:a.x>(left+right)/2?'end':'start'});
    if (spec.target_field && row[spec.target_field] !== undefined) pointLabels.set(`t:${row[spec.target_field]}`,{x:b.x,y:b.y,text:String(row[spec.target_field]),anchor:b.x>(left+right)/2?'end':'start'});
  });
  // Point (city) labels are placed first - same geometry/logic as before -
  // but only as box + deferred-markup data, not yet pushed to f.parts. Value
  // labels (below) then treat these boxes as obstacles to avoid; the actual
  // point-label markup is flushed after the value labels, preserving the
  // original paint order.
  const pointLabelBoxes = [];
  const pointLabelParts = [];
  if (pointLabels.size <= (mobile?12:18)) {
    const labels=[...pointLabels.values()].map((p)=>({...p,side:p.anchor==='end'?'left':'right'}));
    for(const side of ['left','right']){
      const items=labels.filter((p)=>p.side===side).map((p)=>({...p,y:p.y}));
      const placed=separateLabelBaselines(items,top+10,bottom-8,mobile?20:21);
      for(const p of placed){
        const label=textUnits(p.text)>(mobile?10:16)?sliceUnits(p.text,mobile?9:15)+'…':p.text,tx=p.x+(side==='left'?-7:7),anchor=side==='left'?'end':'start',font=mobile?12:12.5,w=Math.max(24,textUnits(label)*font*.56+8),rx=side==='left'?tx-w:tx-3,ry=p.labelY-font-5,h=font+7;
        pointLabelBoxes.push({x:rx,y:ry,w,h});
        if(Math.abs(p.labelY-p.y)>5)pointLabelParts.push(`<line data-role="geo-label-leader" x1="${p.x}" y1="${p.y}" x2="${tx+(side==='left'?3:-3)}" y2="${p.labelY-3}" stroke="${PALETTE.muted}" stroke-width=".7"/>`);
        pointLabelParts.push(`<rect data-role="geo-label-bg" x="${rx}" y="${ry}" width="${w}" height="${h}" rx="2" fill="#fff" fill-opacity=".86"/>`);
        pointLabelParts.push(`<text data-role="geo-label" x="${tx}" y="${p.labelY-4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);
      }
    }
  }
  if (spec.direct_labels !== false && rows.length <= 10) {
    const candidates = rows
      .filter((row)=> (n(row[spec.value_field]) ?? 0) > 0)
      .slice()
      .sort((a,b)=>(n(b[spec.value_field])??0)-(n(a[spec.value_field])??0))
      .slice(0, rows.length > 4 ? 3 : rows.length);
    const placedValueBoxes = [];
    candidates.forEach((row)=>{
      const a=geoProjection(n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),left,right,top,bottom),b=geoProjection(n(row[spec.target_lon_field]),n(row[spec.target_lat_field]),left,right,top,bottom),value=n(row[spec.value_field])??0;
      if(value<=0)return;
      const lift=Math.min(70,Math.hypot(b.x-a.x,b.y-a.y)*0.16),mx=(a.x+b.x)/2,my0=clamp((a.y+b.y)/2-Math.max(20,lift*.5),top+12,bottom-12),label=fmtSpec(spec, value,spec.unit),font=mobile?12:12.5,w=Math.max(28,textUnits(label)*font*.55+8);
      const my=resolveLabelCollisionY(mx,my0,w,font,[...pointLabelBoxes,...placedValueBoxes],top+12,bottom-12);
      placedValueBoxes.push({x:mx-w/2,y:my-font-3,w,h:font+7});
      f.parts.push(`<rect data-role="geo-value-bg" x="${mx-w/2}" y="${my-font-3}" width="${w}" height="${font+7}" rx="2" fill="#fff" fill-opacity=".8"/>`);f.parts.push(`<text data-role="geo-value" x="${mx}" y="${my}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${PALETTE.muted}">${esc(label)}</text>`);
    });
  }
  f.parts.push(...pointLabelParts);
  f.parts.push(`<text x="${right}" y="${bottom+22}" text-anchor="end" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">Schematic equirectangular projection; route geometry is approximate</text>`);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop); f.parts.push('</svg>'); return f.parts.join('\n')+'\n';
}

function parallelSetsLayout(spec, rows, mobile=false) {
  const dims=spec.dimension_fields, weight=(row)=>Math.max(0,n(row[spec.value_field])??0), total=Math.max(rows.reduce((sum,row)=>sum+weight(row),0),1);
  const axisCats=dims.map((field)=>{const totals=new Map();for(const row of rows){const key=String(row[field]);totals.set(key,(totals.get(key)??0)+weight(row));}return [...totals.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));});
  return {dims,weight,total,axisCats};
}

function renderCartographicFlowMap(spec, rows, mobile=false) {
  const bodyH = mobile ? 470 : 540;
  const f = mobile ? mobileFrame(spec, bodyH) : frame(spec, bodyH);
  const left = mobile ? 36 : 60, right = mobile ? 610 : 980, top = f.bodyTop + 20, bottom = f.bodyBottom - 74;
  const routeRows=selectRoutes(rows,spec);
  const trajectoryCache=new Map();
  const extentLines=[];
  for(const row of routeRows){
    if(spec.geometry_semantics==='observed_trajectory'&&spec.trajectory_points_field){
      const pts=parseTrajectoryPoints(row[spec.trajectory_points_field]); trajectoryCache.set(row,pts); const lines=trajectoryLines(pts); if(lines)extentLines.push(...lines);
    }else if(['abstract_od','great_circle_reference'].includes(spec.geometry_semantics)){
      const slon=n(row[spec.source_lon_field]),slat=n(row[spec.source_lat_field]),tlon=n(row[spec.target_lon_field]),tlat=n(row[spec.target_lat_field]);
      if([slon,slat,tlon,tlat].every(v=>v!==null))extentLines.push([[slon,slat],[tlon,tlat]]);
    }else{const lines=parseRouteGeometry(row[spec.route_geometry_field]);if(lines)extentLines.push(...lines);}
  }
  const dataExtent=coordinateExtent(extentLines);
  const project=spec.extent_mode==='data'&&dataExtent?createProjectionForExtent(spec.projection??'natural_earth_1',dataExtent,left,right,top,bottom,Number(spec.extent_padding_ratio??.12),Number(spec.extent_min_span_deg??0)):createProjection(spec.projection??'natural_earth_1',left,right,top,bottom);
  const mapPath=renderBasemapPaths(project,spec.basemap_id), mapMeta=getBasemap(spec.basemap_id), mapFill=mapMeta?.detail_class==='local'?'#e6e9e6':'#d9dedb', markerId=`carto-arrow-${mobile?'m':'d'}`, clipId=`carto-clip-${mobile?'m':'d'}`;
  f.parts.push(`<defs><clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" rx="3"/></clipPath><marker id="${markerId}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.5 L0,7 z" fill="${PALETTE.muted}"/></marker></defs>`);
  f.parts.push(`<rect data-role="cartographic-ocean" x="${left}" y="${top}" width="${right-left}" height="${bottom-top}" rx="3" fill="#eef2f3" stroke="${PALETTE.grid}"/>`);
  f.parts.push(`<g clip-path="url(#${clipId})"><path data-role="cartographic-basemap" d="${mapPath}" fill="${mapFill}" stroke="#ffffff" stroke-width="${mobile?.55:.7}" stroke-linejoin="round"/>`);
  const max=Math.max(...routeRows.map(row=>n(row[spec.value_field])??0),1),sourceFrequency=new Map(); for(const row of routeRows){if(spec.source_field&&row[spec.source_field]!==undefined){const k=String(row[spec.source_field]);sourceFrequency.set(k,(sourceFrequency.get(k)??0)+1);}}
  const odLayout=spec.geometry_semantics==='abstract_od'?optimizeAbstractOdRoutes(routeRows.map((row,i)=>({index:i,key:`${row[spec.source_field]??''}|${row[spec.target_field]??''}|${i}`,a:project(n(row[spec.source_lon_field]),n(row[spec.source_lat_field])),b:project(n(row[spec.target_lon_field]),n(row[spec.target_lat_field])),value:n(row[spec.value_field])??0})),{left,right,top,bottom}):null;
  const pointLabels=new Map(), categoryIndex=new Map(); let nextCategory=0; const routeInfos=[];
  routeRows.forEach((row,i)=>{
    const value=n(row[spec.value_field])??0;if(value<=0)return; const cat=spec.category_field?String(row[spec.category_field]??'Other'):'flow'; if(!categoryIndex.has(cat))categoryIndex.set(cat,nextCategory++); const color=SERIES_COLORS[categoryIndex.get(cat)%SERIES_COLORS.length];
    let sw=Math.max(1.05,Math.sqrt(value/max)*(mobile?8.5:12.5)),d='',a=null,b=null,mid=null,lines=null,points=null;
    if(spec.geometry_semantics==='abstract_od'){const layout=odLayout[i];a=layout.item.a;b=layout.item.b;d=layout.d;mid=layout.mid;}
    else if(spec.geometry_semantics==='great_circle_reference'){lines=[greatCirclePoints(n(row[spec.source_lon_field]),n(row[spec.source_lat_field]),n(row[spec.target_lon_field]),n(row[spec.target_lat_field]),mobile?20:32)];d=projectedPolylinePath(lines,project,(right-left)*.55);a=project(lines[0][0][0],lines[0][0][1]);const last=lines[0][lines[0].length-1];b=project(last[0],last[1]);const m=lines[0][Math.floor(lines[0].length/2)];mid=project(m[0],m[1]);}
    else {points=spec.geometry_semantics==='observed_trajectory'&&spec.trajectory_points_field?trajectoryCache.get(row):null;lines=points?trajectoryLines(points):parseRouteGeometry(row[spec.route_geometry_field]);if(!validRouteGeometry(lines))return;d=projectedPolylinePath(lines,project,(right-left)*.55);const first=lines[0][0],lastLine=lines[lines.length-1],last=lastLine[lastLine.length-1];a=project(first[0],first[1]);b=project(last[0],last[1]);const line=lines[Math.floor(lines.length/2)],m=line[Math.floor(line.length/2)];mid=project(m[0],m[1]);if(spec.geometry_semantics==='observed_trajectory')sw=mobile?2.8:3.4;}
    if(spec.geometry_semantics==='observed_trajectory'&&spec.reference_path==='great_circle'&&lines){const first=lines[0][0],lastLine=lines[lines.length-1],last=lastLine[lastLine.length-1],ref=[greatCirclePoints(first[0],first[1],last[0],last[1],40)],rd=projectedPolylinePath(ref,project,(right-left)*.55);f.parts.push(`<path data-role="cartographic-reference" d="${rd}" fill="none" stroke="${PALETTE.ink}" stroke-width="${mobile?1:1.25}" stroke-opacity=".42" stroke-dasharray="5 5"/>`);}
    const opacity=spec.geometry_semantics==='observed_trajectory'?.88:spec.geometry_semantics==='verified_route'?.7:.6;
    const flowKey = spec.flow_id_field && row[spec.flow_id_field] !== undefined
      ? String(row[spec.flow_id_field])
      : `${String(row[spec.source_field] ?? '')}→${String(row[spec.target_field] ?? '')}`;
    const layerKey = spec.flow_layer_field && row[spec.flow_layer_field] !== undefined ? String(row[spec.flow_layer_field]) : '';
    const flowAttrs = `data-flow-key="${esc(flowKey)}"${layerKey ? ` data-flow-layer="${esc(layerKey)}"` : ''}`;
    // Keep the visible stroke editorially thin while giving pointer/touch users
    // a generous target, following the B3 big-threads interaction contract.
    f.parts.push(`<path data-role="cartographic-flow" ${flowAttrs} data-geometry-semantics="${esc(spec.geometry_semantics)}" d="${d}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none" marker-end="url(#${markerId})"/>`);
    f.parts.push(`<path data-role="cartographic-hit" ${flowAttrs} d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(12, sw * 3).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" pointer-events="stroke"/>`);
    if(points&&points.length){const markerPoints=[{p:points[0],label:'coverage starts'},...points.filter((p,j)=>j>0&&p.segment!==points[j-1].segment).map(p=>({p,label:'coverage resumes'})),{p:points[points.length-1],label:points[points.length-1].altitude_ft===0?'ground / coverage ends':'coverage ends'}];const maxAlt=points.reduce((best,p)=>Number(p.altitude_ft)>Number(best.altitude_ft)?p:best,points[0]);if(maxAlt&&Number(maxAlt.altitude_ft)>0)markerPoints.splice(markerPoints.length-1,0,{p:maxAlt,label:`${Math.round(Number(maxAlt.altitude_ft)).toLocaleString('en-US')} ft`});for(const [mi,item] of markerPoints.entries()){const q=project(item.p.lon,item.p.lat),anchor=q.x>(left+right)/2?'end':'start',tx=q.x+(anchor==='end'?-7:7),ty=q.y+(mi%2?12:-8);f.parts.push(`<circle data-role="trajectory-marker" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${mobile?2.4:2.8}" fill="#fff" stroke="${color}" stroke-width="1.5"/><text data-role="trajectory-marker-label" x="${tx.toFixed(1)}" y="${clamp(ty,top+10,bottom-4).toFixed(1)}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="700" fill="${PALETTE.ink}">${esc(item.label)}</text>`);}}
    if(a)f.parts.push(`<circle data-role="cartographic-origin" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="${mobile?2.6:3.2}" fill="${PALETTE.ink}"/>`); if(b)f.parts.push(`<circle data-role="cartographic-destination" cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${mobile?2.9:3.5}" fill="${PALETTE.accent}"/>`);
    const routeLength=a&&b?Math.hypot(b.x-a.x,b.y-a.y):Infinity,sourceKey=spec.source_field&&row[spec.source_field]!==undefined?String(row[spec.source_field]):'',valueAtSource=routeLength<(mobile?105:145)&&sourceKey&&(sourceFrequency.get(sourceKey)??0)===1;
    if(spec.source_field&&a&&row[spec.source_field]!==undefined){const text=valueAtSource?`${sourceKey} · ${fmtSpec(spec, value,'')}`:sourceKey;pointLabels.set(`s:${sourceKey}`,{...a,text,anchor:a.x>(left+right)/2?'end':'start'});} if(spec.target_field&&b&&row[spec.target_field]!==undefined)pointLabels.set(`t:${row[spec.target_field]}`,{...b,text:String(row[spec.target_field]),anchor:b.x>(left+right)/2?'end':'start'}); routeInfos.push({row,value,color,mid,routeLength,valueAtSource});
  });
  f.parts.push('</g>');
  if(spec.direct_labels!==false&&spec.geometry_semantics!=='observed_trajectory'){routeInfos.slice().sort((a,b)=>b.value-a.value).filter(info=>!info.valueAtSource).slice(0,mobile?2:3).forEach(info=>{if(!info.mid)return;const label=fmtSpec(spec, info.value,spec.unit),font=mobile?12:12.5,w=Math.max(30,textUnits(label)*font*.56+9),x=clamp(info.mid.x,left+w/2+2,right-w/2-2),y=clamp(info.mid.y,top+font+5,bottom-4);f.parts.push(`<rect data-role="cartographic-value-bg" pointer-events="none" x="${(x-w/2).toFixed(1)}" y="${(y-font-4).toFixed(1)}" width="${w.toFixed(1)}" height="${(font+7).toFixed(1)}" rx="2" fill="#fff" fill-opacity=".88"/><text data-role="cartographic-value" pointer-events="none" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);});}
  if(pointLabels.size<= (mobile?10:16)){const labels=[...pointLabels.values()].map(p=>({...p,side:p.anchor==='end'?'left':'right'}));for(const side of ['left','right']){const placed=separateLabelBaselines(labels.filter(p=>p.side===side),top+10,bottom-8,mobile?20:21);for(const p of placed){const label=textUnits(p.text)>(mobile?11:21)?sliceUnits(p.text,mobile?10:20)+'…':p.text,tx=p.x+(side==='left'?-7:7),anchor=side==='left'?'end':'start',font=mobile?12:12.5,w=Math.max(25,textUnits(label)*font*.56+8),rx=side==='left'?tx-w:tx-3,ry=p.labelY-font-6;if(Math.abs(p.labelY-p.y)>5)f.parts.push(`<line data-role="cartographic-label-leader" pointer-events="none" x1="${p.x}" y1="${p.y}" x2="${tx+(side==='left'?3:-3)}" y2="${p.labelY-3}" stroke="${PALETTE.muted}" stroke-width=".7"/>`);f.parts.push(`<rect data-role="cartographic-label-bg" pointer-events="none" x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${w.toFixed(1)}" height="${(font+8).toFixed(1)}" rx="2" fill="#fff" fill-opacity=".82"/><text data-role="cartographic-label" pointer-events="none" x="${tx}" y="${p.labelY-4}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);}}}
  if(spec.locator_inset&&dataExtent){const iw=mobile?112:150,ih=mobile?66:88,ix=right-iw-8,iy=top+8,ip=createProjection(spec.projection??'natural_earth_1',ix+4,ix+iw-4,iy+4,iy+ih-4),world=renderBasemapPaths(ip,spec.basemap_id),nw=ip(dataExtent.west,dataExtent.north),se=ip(dataExtent.east,dataExtent.south);f.parts.push(`<g data-role="cartographic-locator"><rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" rx="3" fill="#fff" fill-opacity=".92" stroke="${PALETTE.grid}"/><path d="${world}" fill="#e3e7e5" stroke="#fff" stroke-width=".25"/><rect x="${Math.min(nw.x,se.x).toFixed(1)}" y="${Math.min(nw.y,se.y).toFixed(1)}" width="${Math.max(3,Math.abs(se.x-nw.x)).toFixed(1)}" height="${Math.max(3,Math.abs(se.y-nw.y)).toFixed(1)}" fill="none" stroke="${PALETTE.accent}" stroke-width="1.2"/></g>`);}
  const keyY=bottom+18; f.parts.push(`<g data-role="cartographic-direction-key"><circle cx="${left}" cy="${keyY-3}" r="3" fill="${PALETTE.ink}"/><text x="${left+7}" y="${keyY}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">origin / observed start</text><text x="${left+(mobile?165:170)}" y="${keyY}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">→</text><circle cx="${left+(mobile?185:190)}" cy="${keyY-3}" r="3" fill="${PALETTE.accent}"/><text x="${left+(mobile?192:197)}" y="${keyY}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">destination / observed end</text></g>`);
  const disclosure=geometryDisclosure(spec.geometry_semantics,spec.route_provenance_note??''); f.parts.push(`<text data-role="cartographic-disclosure" x="${right}" y="${bottom+40}" text-anchor="end" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="600" fill="${PALETTE.muted}">${esc(textUnits(disclosure)>(mobile?92:132)?sliceUnits(disclosure,mobile?91:131)+'…':disclosure)}</text>`);
  f.parts.push(`<text data-role="cartographic-projection" x="${left}" y="${bottom+40}" text-anchor="start" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">${esc(getBasemap(spec.basemap_id)?.label??spec.basemap_id)} · ${spec.extent_mode==='data'?'data-fitted extent':'world extent'}</text>`);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function renderTrajectoryProfile(spec,rows,mobile=false){
  const bodyH=mobile?520:500,f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH),left=mobile?64:96,right=mobile?602:950,top=f.bodyTop+24,bottom=f.bodyBottom-48,gap=mobile?54:58,panelH=(bottom-top-gap)/2;
  const sorted=rows.slice().sort((a,b)=>(n(a[spec.x_field])??0)-(n(b[spec.x_field])??0)),xs=sorted.map(r=>n(r[spec.x_field])).filter(v=>v!==null),alts=sorted.map(r=>n(r[spec.altitude_field])).filter(v=>v!==null),speeds=sorted.map(r=>n(r[spec.speed_field])).filter(v=>v!==null);
  const xMin=Math.min(0,...xs),xMax=Math.max(...xs),xDomain=xMax>xMin?[xMin,xMax]:[xMin,xMin+1],xScale=horizontalScale(xDomain,left,right),altDomain=[0,Math.max(1,...alts)*1.06],speedDomain=[0,Math.max(1,...speeds)*1.08],altY=verticalScale(altDomain,top,top+panelH),speedTop=top+panelH+gap,speedY=verticalScale(speedDomain,speedTop,speedTop+panelH);
  const transitions=[];for(let i=1;i<sorted.length;i++)if(String(sorted[i][spec.segment_field])!==String(sorted[i-1][spec.segment_field]))transitions.push({a:sorted[i-1],b:sorted[i]});
  for(const tr of transitions){const x1=xScale(n(tr.a[spec.x_field])),x2=xScale(n(tr.b[spec.x_field])),w=Math.max(2,x2-x1),mins=(n(tr.b[spec.x_field])-n(tr.a[spec.x_field]));f.parts.push(`<rect data-role="trajectory-gap" x="${x1.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${(bottom-top).toFixed(1)}" fill="#f3eee9" fill-opacity=".78"/><text data-role="trajectory-gap-label" x="${((x1+x2)/2).toFixed(1)}" y="${(top+13).toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="700" fill="${PALETTE.muted}">${esc(`${Math.round(mins)} min source gap`)}</text>`);}
  function panel(label,domain,yScale,y0,field,color,unit){for(const tick of tickValues(domain,4)){const y=yScale(tick);f.parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${PALETTE.grid}" stroke-width="1"/><text x="${left-10}" y="${y+4}" text-anchor="end" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">${esc(tickLabel(tick,unit,vizLang(spec)))}</text>`);}f.parts.push(`<text x="${left}" y="${y0-8}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="700" fill="${PALETTE.ink}">${esc(label)}</text>`);const groups=[];for(const row of sorted){let g=groups.at(-1);if(!g||String(g.segment)!==String(row[spec.segment_field])){g={segment:row[spec.segment_field],rows:[]};groups.push(g);}if(n(row[field])!==null)g.rows.push(row);}for(const g of groups){if(g.rows.length<2)continue;const coords=g.rows.map(r=>`${xScale(n(r[spec.x_field])).toFixed(1)},${yScale(n(r[field])).toFixed(1)}`).join(' ');f.parts.push(`<polyline data-role="trajectory-profile-line" fill="none" stroke="${color}" stroke-width="${mobile?2.2:2.7}" points="${coords}"/>`);g.rows.forEach(r=>f.parts.push(`<circle cx="${xScale(n(r[spec.x_field])).toFixed(1)}" cy="${yScale(n(r[field])).toFixed(1)}" r="${mobile?2:2.4}" fill="${color}"/>`));}const last=sorted.filter(r=>n(r[field])!==null).at(-1);if(last)f.parts.push(`<text data-role="direct-label" x="${(xScale(n(last[spec.x_field]))-5).toFixed(1)}" y="${(yScale(n(last[field]))-8).toFixed(1)}" text-anchor="end" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="700" fill="${textSafeColor(color)}">${esc(fmt(n(last[field]),unit))}</text>`);}
  {const ps=f.parts.length;panel('Pressure altitude',altDomain,altY,top,spec.altitude_field,PALETTE.accent2,spec.altitude_unit??'ft');tagPanelTexts(f.parts,ps,[0,top-30,right+30,top+panelH+16]);}{const ps=f.parts.length;panel('Ground speed',speedDomain,speedY,speedTop,spec.speed_field,PALETTE.accent,spec.speed_unit??'kt');tagPanelTexts(f.parts,ps,[0,speedTop-30,right+30,speedTop+panelH+16]);}
  for(const tick of tickValues(xDomain,4)){const x=xScale(tick);f.parts.push(`<line x1="${x}" y1="${speedTop+panelH}" x2="${x}" y2="${speedTop+panelH+4}" stroke="${PALETTE.muted}"/><text x="${x}" y="${speedTop+panelH+20}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">${esc(`${Math.round(tick)} min`)}</text>`);}f.parts.push(`<text x="${(left+right)/2}" y="${speedTop+panelH+37}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" fill="${PALETTE.muted}">elapsed time since observed coverage begins</text>`);
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function renderParallelSets(spec, rows, mobile=false) {
  const model=parallelSetsLayout(spec,rows,mobile), bodyH=Math.max(mobile?460:430,Math.max(...model.axisCats.map((x)=>x.length),1)*(mobile?34:31)+130),f=mobile?mobileFrame(spec,bodyH):frame(spec,bodyH);
  const width=mobile?640:1040,left=mobile?64:86,right=width-(mobile?64:86),top=f.bodyTop+48,bottom=f.bodyBottom-28,axisGap=(right-left)/Math.max(1,model.dims.length-1),gap=mobile?7:8,positions=[];
  model.axisCats.forEach((cats,axis)=>{const available=bottom-top-gap*Math.max(0,cats.length-1);let y=top;const map=new Map();for(const [cat,total] of cats){const h=Math.max(5,(total/model.total)*available);map.set(cat,{x:left+axis*axisGap,y,h,total});y+=h+gap;}positions.push(map);});
  for(let axis=0;axis<model.dims.length-1;axis++){
    const sourceOffsets=new Map(),targetOffsets=new Map();const groups=new Map();for(const row of rows){const a=String(row[model.dims[axis]]),b=String(row[model.dims[axis+1]]),key=`${a}\0${b}`,v=model.weight(row);if(v>0)groups.set(key,(groups.get(key)??0)+v);}const max=Math.max(...groups.values(),1);let ci=0;
    for(const [key,v] of [...groups.entries()].sort((a,b)=>b[1]-a[1])){const [a,b]=key.split('\0'),pa=positions[axis].get(a),pb=positions[axis+1].get(b);if(!pa||!pb)continue;const scaleA=pa.h/Math.max(pa.total,1),scaleB=pb.h/Math.max(pb.total,1),oa=sourceOffsets.get(a)??0,ob=targetOffsets.get(b)??0,hA=Math.max(1,v*scaleA),hB=Math.max(1,v*scaleB),y1=pa.y+oa+hA/2,y2=pb.y+ob+hB/2;sourceOffsets.set(a,oa+hA);targetOffsets.set(b,ob+hB);const sw=Math.max(1.2,Math.min(hA,hB));f.parts.push(`<path data-role="parallel-ribbon" d="${sankeyPath(pa.x+7,y1,pb.x-7,y2)}" fill="none" stroke="${SERIES_COLORS[ci++%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity=".42"/>`);}
  }
  model.axisCats.forEach((cats,axis)=>{const x=left+axis*axisGap;f.parts.push(`<text x="${x}" y="${top-20}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="700" fill="${PALETTE.muted}">${esc(model.dims[axis])}</text>`);for(const [cat] of cats){const p=positions[axis].get(cat);f.parts.push(`<rect data-role="parallel-node" x="${x-7}" y="${p.y}" width="14" height="${p.h}" rx="2" fill="${PALETTE.ink}" opacity=".84"/>`);const label=textUnits(cat)>(mobile?11:15)?sliceUnits(cat,mobile?10:14)+'…':cat,side=axis===model.axisCats.length-1?'left':axis===0?'right':axis%2===1?'left':'right',anchor=side==='left'?'end':'start',lx=x+(side==='left'?-11:11),font=mobile?12:12.5,w=Math.max(22,textUnits(label)*font*.56+7),rx=side==='left'?lx-w:lx-3,ry=p.y+p.h/2-font/2-3;f.parts.push(`<rect data-role="parallel-label-bg" x="${rx}" y="${ry}" width="${w}" height="${font+7}" rx="2" fill="#fff" fill-opacity=".82"/>`);f.parts.push(`<text data-role="parallel-label" x="${lx}" y="${p.y+p.h/2+3}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${PALETTE.ink}">${esc(label)}</text>`);}});
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function polar(cx,cy,r,a){return{x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r};}
function arcPath(cx,cy,r,a0,a1){const p0=polar(cx,cy,r,a0),p1=polar(cx,cy,r,a1),large=a1-a0>Math.PI?1:0;return`M${p0.x},${p0.y} A${r},${r} 0 ${large} 1 ${p1.x},${p1.y}`;}

// Nodes keep their first-appearance order (see facetOrder), not name order.
function renderChord(spec, rows, mobile=false) {
  const ids=facetOrder(unique(rows.flatMap((row)=>[row[spec.source_field],row[spec.target_field]]))), totals=new Map(ids.map((id)=>[id,0]));for(const row of rows){const v=Math.max(0,n(row[spec.value_field])??0);totals.set(String(row[spec.source_field]),(totals.get(String(row[spec.source_field]))??0)+v);totals.set(String(row[spec.target_field]),(totals.get(String(row[spec.target_field]))??0)+v);}const grand=Math.max([...totals.values()].reduce((a,b)=>a+b,0),1),f=mobile?mobileFrame(spec,470):frame(spec,470),cx=mobile?320:520,cy=(f.bodyTop+f.bodyBottom)/2+8,r=mobile?170:190,gap=.025,angles=new Map();let angle=-Math.PI/2;for(const id of ids){const span=(Math.PI*2-gap*ids.length)*(totals.get(id)/grand);angles.set(id,{a0:angle,a1:angle+span,mid:angle+span/2});angle+=span+gap;}const max=Math.max(...rows.map((row)=>n(row[spec.value_field])??0),1);let i=0;for(const row of rows){const a=angles.get(String(row[spec.source_field])),b=angles.get(String(row[spec.target_field]));if(!a||!b)continue;const p1=polar(cx,cy,r-8,a.mid),p2=polar(cx,cy,r-8,b.mid),v=n(row[spec.value_field])??0;if(v<=0)continue;const sw=Math.max(1.2,Math.sqrt(v/max)*(mobile?18:23));f.parts.push(`<path data-role="chord-ribbon" d="M${p1.x},${p1.y} Q${cx},${cy} ${p2.x},${p2.y}" fill="none" stroke="${SERIES_COLORS[i++%SERIES_COLORS.length]}" stroke-width="${sw}" stroke-opacity=".42" stroke-linecap="round"/>`);}for(let j=0;j<ids.length;j++){const id=ids[j],a=angles.get(id),highlighted=(spec.highlight_values??[]).includes(id);f.parts.push(`<path data-role="chord-arc" d="${arcPath(cx,cy,r,a.a0,a.a1)}" fill="none" stroke="${highlighted?PALETTE.accent:PALETTE.ink}" stroke-width="${mobile?12:14}"/>`);const p=polar(cx,cy,r+(mobile?22:26),a.mid),anchor=Math.cos(a.mid)>.18?'start':Math.cos(a.mid)<-.18?'end':'middle';f.parts.push(`<text x="${p.x}" y="${p.y+3}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="${highlighted?700:500}" fill="${PALETTE.ink}">${esc(textUnits(id)>(mobile?11:15)?sliceUnits(id,mobile?10:14)+'…':id)}</text>`);} (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

function processLayout(rows,spec){const pseudo=rows.map((row)=>({[spec.source_field]:row[spec.source_field],[spec.target_field]:row[spec.target_field],__value:1})),flowSpec={source_field:spec.source_field,target_field:spec.target_field,value_field:'__value',chart_type:'process_schematic'},layout=flowLayout(pseudo,flowSpec);return layout;}

function renderProcessSchematic(spec,rows,mobile=false){
  const layout=processLayout(rows,spec),maxPerLevel=Math.max(...layout.levels.map((level)=>level.length),1),desktopBody=Math.max(230,maxPerLevel*82+100),mobileBody=Math.max(430,(layout.maxLevel+1)*115),f=mobile?mobileFrame(spec,mobileBody):frame(spec,desktopBody),width=mobile?640:1040,left=mobile?60:80,right=width-(mobile?60:80),top=f.bodyTop+28,bottom=f.bodyBottom-28,positions=new Map();
  if(mobile){layout.levels.forEach((level,li)=>{const y=top+(li/Math.max(1,layout.maxLevel))*(bottom-top),gap=(right-left)/Math.max(1,level.length);level.forEach((node,i)=>positions.set(node.id,{x:left+gap*(i+.5),y}));});}
  else{layout.levels.forEach((level,li)=>{const x=left+(li/Math.max(1,layout.maxLevel))*(right-left),gap=(bottom-top)/Math.max(1,level.length);level.forEach((node,i)=>positions.set(node.id,{x,y:top+gap*(i+.5)}));});}
  const horizontalStep=(right-left)/Math.max(1,layout.maxLevel),boxW=mobile?120:Math.min(132,Math.max(94,horizontalStep*.72)),boxH=mobile?44:50;
  f.parts.push(`<defs><marker id="proc-arrow-${mobile?'m':'d'}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${PALETTE.context}"/></marker></defs>`);
  for(const row of rows){const a=positions.get(String(row[spec.source_field])),b=positions.get(String(row[spec.target_field]));if(!a||!b)continue;const x1=mobile?a.x:a.x+boxW/2,y1=mobile?a.y+boxH/2:a.y,x2=mobile?b.x:b.x-boxW/2,y2=mobile?b.y-boxH/2:b.y,mid=mobile?(y1+y2)/2:(x1+x2)/2,path=mobile?`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`:`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;f.parts.push(`<path data-role="process-edge" d="${path}" fill="none" stroke="${PALETTE.context}" stroke-width="1.8" marker-end="url(#proc-arrow-${mobile?'m':'d'})"/>`);const edgeGap=mobile?Math.abs(y2-y1)-boxH:Math.abs(x2-x1)-boxW;if(spec.edge_label_field&&row[spec.edge_label_field]&&edgeGap>(mobile?34:42)){const sourceId=String(row[spec.source_field]),sourceLevel=layout.nodes.get(sourceId)?.level??0,vertical=mobile&&Math.abs(x2-x1)<2;let lx=(x1+x2)/2,ly=(y1+y2)/2-(mobile?10:8);if(mobile&&sourceLevel===0){lx=x1+(x2-x1)*.34+(vertical?-55:0);ly=y1+(y2-y1)*.34-7;}else if(mobile&&vertical){lx=x1+58;}const text=String(row[spec.edge_label_field]),maxChars=mobile?16:18,lines=wrapText(text,maxChars).slice(0,2),startY=ly-(lines.length-1)*6.5;lines.forEach((line,i)=>f.parts.push(`<text data-role="process-edge-label" x="${lx}" y="${startY+i*13}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="600" fill="${PALETTE.muted}">${esc(line)}</text>`));}}
  for(const [id,p] of positions){const highlighted=(spec.highlight_values??[]).includes(id);f.parts.push(`<rect data-role="process-node" x="${p.x-boxW/2}" y="${p.y-boxH/2}" width="${boxW}" height="${boxH}" rx="6" fill="${highlighted?PALETTE.accent:PALETTE.faint}" stroke="${highlighted?PALETTE.accent:PALETTE.context}" stroke-width="1.3"/>`);const lines=wrapText(id,mobile?16:16).slice(0,2);lines.forEach((line,i)=>f.parts.push(`<text x="${p.x}" y="${p.y-(lines.length-1)*7.5+i*15+4}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${mobile?12:12.5}" font-weight="${highlighted?700:600}" fill="${highlighted?'#fff':PALETTE.ink}">${esc(line)}</text>`));}
  (mobile?addMobileFooter:addFooter)(f.parts,spec,f.footerTop);f.parts.push('</svg>');return f.parts.join('\n')+'\n';
}

// Largest cell size (and gap, and inter-grid spacing) that lets `n` 10x10
// waffle grids sit side by side within `width` without shrinking further
// than needed. Tries the sizing bullet's own desktop numbers (cell 22, gap
// 3) first - true for n up to 3 at the desktop frame's own plot width - and
// only backs off cell size (and, below 14px, gap) as n grows; inter-grid
// spacing shrinks in step with cell size rather than being fixed, so a
// dense (n=4) layout does not waste width on wide gutters. gap never drops
// below minGap (2px), well clear of render_qa_geometry's
// indistinct_adjacent_marks tolerance (a gap under 1px), so same-fill
// neighbours never read as one shape.
function waffleLayout(n, width, sizing) {
  const { maxCell, maxGap, minGap, maxBetween, minBetween, minCell } = sizing;
  for (let cell = maxCell; cell >= minCell; cell--) {
    const gap = cell >= 14 ? maxGap : minGap;
    const between = n <= 1 ? 0 : Math.max(minBetween, Math.round((maxBetween * cell) / maxCell));
    const grid = cell * 10 + gap * 9;
    const total = n * grid + (n - 1) * between;
    if (total <= width) return { cell, gap, between, grid };
  }
  const cell = minCell, gap = minGap, grid = cell * 10 + gap * 9;
  return { cell, gap, between: n <= 1 ? 0 : minBetween, grid };
}

// Percentage waffle: one 10x10 grid of unit cells per row (1-4 rows,
// enforced by lintVizSpec), filled row-major from the top-left up to
// Math.round(value). Above each grid: the category label, then a large
// serif value numeral (PALETTE.accent when the row is highlighted, per the
// spec), then an optional small muted reference_period_field tspan - this
// mirrors the user-approved spike (experiments/infographic/africa/page.js
// waffle(), read-only reference) but generalizes its fixed two-grid,
// fixed-size layout to 1-4 grids that shrink to fit this frame's own plot
// width (see waffleLayout above).
function renderWaffle(spec, rows, mobile = false) {
  const head = mobile ? 58 : 70;
  const sizing = mobile
    ? { maxCell: 13, maxGap: 2, minGap: 2, maxBetween: 32, minBetween: 10, minCell: 8 }
    : { maxCell: 22, maxGap: 3, minGap: 2, maxBetween: 72, minBetween: 16, minCell: 10 };
  const plotWidth = mobile ? 640 - 2 * 32 : 1040 - 2 * 54;
  const { cell, gap, between, grid } = waffleLayout(rows.length, plotWidth, sizing);
  const f = mobile ? mobileFrame(spec, head + grid + 4) : frame(spec, head + grid + 4);
  const left = mobile ? f.margin : 54;
  const labelY = f.bodyTop + (mobile ? 16 : 18);
  const valueY = f.bodyTop + (mobile ? 44 : 54);
  const gridTop = f.bodyTop + head;
  rows.forEach((row, k) => {
    const x0 = left + k * (grid + between);
    const highlighted = (spec.highlight_values ?? []).map(String).includes(String(row[spec.category_field]));
    f.parts.push(`<text x="${x0}" y="${labelY}" font-family="${FONT_SANS}" font-size="${mobile ? 14 : 15}" font-weight="700" fill="${PALETTE.ink}">${esc(resolveEconomyDisplayName(row[spec.category_field], spec.category_names, vizLang(spec)))}</text>`);
    const value = Math.max(0, Math.min(100, n(row[spec.value_field]) ?? 0));
    const period = spec.reference_period_field ? row[spec.reference_period_field] : undefined;
    const periodTspan = period !== undefined && period !== null && String(period).trim() !== ""
      ? `<tspan dx="6" font-family="${FONT_SANS}" font-weight="400" font-size="12" fill="${PALETTE.muted}">${esc(period)}</tspan>`
      : "";
    f.parts.push(`<text x="${x0}" y="${valueY}" font-family="Georgia, 'Times New Roman', serif" font-weight="900" font-size="${mobile ? 24 : 30}" fill="${highlighted ? PALETTE.accent : PALETTE.ink}"><tspan>${esc(fmtSpec(spec, value, spec.unit))}</tspan>${periodTspan}</text>`);
    const filled = Math.round(value);
    for (let i = 0; i < 100; i++) {
      const r = Math.floor(i / 10);
      const c = i % 10;
      const x = x0 + c * (cell + gap);
      const y = gridTop + r * (cell + gap);
      f.parts.push(`<rect data-role="waffle-cell" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${i < filled ? PALETTE.navy : PALETTE.track}"/>`);
    }
  });
  (mobile ? addMobileFooter : addFooter)(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

// Largest-remainder (Hamilton) apportionment: turns arbitrary non-negative
// values into integer cell counts that always sum to exactly `total`
// (100, for a 10x10 waffle grid), which floor-only rounding cannot
// guarantee (it under-allocates by the sum of the dropped fractions) and
// naive round() cannot guarantee either (it can over- or under-shoot by a
// few cells when several rows round the same way). Each value's exact
// share of `total` is floored first (guaranteeing no row is ever allocated
// more than its true share before remainders are handed out), then the
// shortfall (`total - sum of floors`) is given out one cell at a time to
// the rows with the largest fractional remainder - the standard method
// used for apportioning seats/quotas, applied here to waffle cells so the
// visual proportions never silently drift from the input values. Ties in
// the remainder are broken by original row order, so the same input
// always yields the same allocation (required for the determinism
// invariant every other chart in this file already holds to).
function largestRemainderCells(values, total = 100) {
  const positive = values.map((v) => Math.max(0, n(v) ?? 0));
  const sum = positive.reduce((a, b) => a + b, 0) || 1;
  const shares = positive.map((v) => (v / sum) * total);
  const base = shares.map((s) => Math.floor(s));
  let assigned = base.reduce((a, b) => a + b, 0);
  const remainders = shares.map((s, i) => ({ i, r: s - Math.floor(s) })).sort((a, b) => b.r - a.r || a.i - b.i);
  let k = 0;
  while (assigned < total && k < remainders.length) {
    base[remainders[k].i] += 1;
    assigned += 1;
    k += 1;
  }
  return base;
}

// Single-grid waffle's colour system, per the user's decision: white
// background, one accent colour (PALETTE.accent, for the spec's own
// highlighted categor{y,ies}) plus a small ramp of grey/grey-blue steps for
// everything else - never a full multi-hue categorical palette, which
// would compete with the accent for attention. Five steps: up to four for
// non-highlighted visible categories (matching the "2-4 grey/grey-blue
// steps" the categories cap implies once one slot is reserved for the
// accent), plus a fifth, lightest tone reserved for the merged "其他"/
// "Other" bucket so it always reads as visually distinct from any kept
// category, never a coincidental repeat. The actual five hex values live on
// PALETTE.waffleGreySteps / the mutable WAFFLE_GREYS binding (see
// DEFAULT_PALETTE / HOUSE_PALETTES.house above) so legacy vs house style
// each get their own ramp instead of one hardcoded-here constant.

// Decides which categories a single-grid waffle actually shows, per the
// user's decision to cap visible categories at 5: below or at the cap,
// every category is shown as-is; above it, every category in
// spec.highlight_values is always kept (an editorially-chosen category
// must never be silently folded into "其他"), the remaining slots go to
// the largest remaining values, and everything left over is merged into a
// single "其他"/"Other" bucket (its value is the exact sum of the merged
// rows - never a rounded or re-derived figure) that fills the cap's last
// slot. Ties are broken by original row order throughout, so the same
// input always yields the same split (the determinism invariant every
// chart in this file holds to).
function planWaffleCategories(spec, rows) {
  const CAP = 5;
  const highlightSet = new Set((spec.highlight_values ?? []).map(String));
  const indexed = rows.map((row, i) => ({
    row,
    i,
    value: Math.max(0, n(row[spec.value_field]) ?? 0),
    highlighted: highlightSet.has(String(row[spec.category_field])),
  }));
  if (indexed.length <= CAP) {
    return { visible: indexed, merged: [] };
  }
  const byValueDesc = (a, b) => b.value - a.value || a.i - b.i;
  const sorted = [...indexed].sort(byValueDesc);
  const keepSlots = CAP - 1; // last slot reserved for "其他"
  const highlighted = sorted.filter((e) => e.highlighted).slice(0, keepSlots);
  const remainingSlots = keepSlots - highlighted.length;
  const keptKeys = new Set(highlighted.map((e) => e.i));
  const rest = sorted.filter((e) => !keptKeys.has(e.i) && !e.highlighted).slice(0, Math.max(0, remainingSlots));
  const visible = [...highlighted, ...rest].sort(byValueDesc);
  const visibleKeys = new Set(visible.map((e) => e.i));
  const merged = sorted.filter((e) => !visibleKeys.has(e.i)).sort(byValueDesc);
  return { visible, merged };
}

// Percent labels always render at exactly one decimal (e.g. "8.9%",
// "34.2%", "10.0%") regardless of language, matching this codebase's other
// part-to-whole percent labelling (the treemap module) rather than the
// shared fmt()'s trailing-zero-stripping default, which would otherwise
// show "10%" for one category and "8.9%" for another in the same legend.
function fmtWafflePercent(value) {
  return `${value.toFixed(1)}%`;
}

// Outline of the lightest grey (a #F2F2F2 cell alone is 1.14:1 against white).
const WAFFLE_OUTLINE = "#8B8B8B";

// Single-grid waffle: one 10x10 grid (100 cells, largest-remainder
// apportionment above so the integer cell counts always sum to exactly
// 100 regardless of rounding) shared by all of the spec's categories,
// filled row-major in category order (highest value first; the merged
// "其他" bucket, if any, always last) - with a same-order legend (swatch +
// name + value, values right-aligned in one column) beside it (desktop) or
// beneath it (mobile), so a reader can always match a cell's colour back
// to its category and value. Cell counts are exposed only as a
// data-cell-count attribute on each legend row (for tests/tooling), never
// in the reader-facing text. This is a distinct part-to-whole reading from
// renderWaffle's default one-grid-per-category percent-filled mode
// (spec.waffle_layout === "single_grid" selects it; see lintVizSpec for
// the 2-5 category cap this mode requires instead of the default 4-grid
// cap - the renderer's own merge-into-"其他" above is a defensive second
// layer, not a licence to skip that lint cap).
function renderWaffleSingleGrid(spec, rows, mobile = false) {
  const lang = vizLang(spec);
  const { visible, merged } = planWaffleCategories(spec, rows);
  const otherValue = merged.reduce((sum, e) => sum + e.value, 0);
  const hasOther = merged.length > 0;
  // Display entries in final grid/legend order: visible categories by
  // value desc (ties by original order), then "其他" last if present.
  // `entry.row === null` marks the merged bucket.
  const entries = [
    ...visible.map((e) => ({ row: e.row, value: e.value, highlighted: e.highlighted })),
    ...(hasOther ? [{ row: null, value: otherValue, highlighted: false }] : []),
  ];
  let colors;
  let strokeIdx = -1; // the entry that takes the lightest grey also gets an outline
  if (HOUSE_STYLE_ACTIVE) {
    // A literal row named 其他/其它/Other/Others is the catch-all too (when no
    // merged bucket exists), highlighted or not: it is drawn last, takes the
    // lightest grey, or the accent when highlighted.
    // Rows keep today's order otherwise. A highlighted row keeps the accent.
    const isLiteralOther = (e) => e.row !== null && /^(其他|其它|others?)$/i.test(String(e.row[spec.category_field] ?? "").trim());
    if (!hasOther) {
      const at = entries.findIndex(isLiteralOther);
      if (at >= 0 && at < entries.length - 1) entries.push(...entries.splice(at, 1));
    }
    const catchAll = entries.findIndex((e, k) => e.row === null || (!hasOther && k === entries.length - 1 && isLiteralOther(e)));
    const named = entries.map((e, k) => (k !== catchAll && !e.highlighted ? k : -1)).filter((k) => k >= 0);
    // Exactly two plain rows read best two steps apart; otherwise darkest first.
    const stepOf = named.length === 2 ? [0, 2] : named.map((_k, i) => i);
    const lightest = WAFFLE_GREYS.length - 1;
    colors = entries.map((e, k) => {
      if (k === catchAll) {
        if (e.highlighted) return PALETTE.accent; // a highlighted catch-all keeps the accent and has no outline
        strokeIdx = k;
        return WAFFLE_GREYS[lightest];
      }
      if (e.highlighted) return PALETTE.accent;
      return WAFFLE_GREYS[Math.min(stepOf[named.indexOf(k)], lightest)];
    });
    // With no catch-all, a fifth plain row is the one that takes the lightest grey.
    if (catchAll < 0 && named.length === WAFFLE_GREYS.length) strokeIdx = named[named.length - 1];
  } else {
    let greyIdx = 0;
    colors = entries.map((e) => {
      if (e.row === null) return WAFFLE_GREYS[WAFFLE_GREYS.length - 1];
      if (e.highlighted) return PALETTE.accent;
      const color = WAFFLE_GREYS[Math.min(greyIdx, WAFFLE_GREYS.length - 2)];
      greyIdx += 1;
      return color;
    });
  }
  const outline = (k) => (k === strokeIdx ? ` stroke="${WAFFLE_OUTLINE}" stroke-width="1"` : "");
  const cellCounts = largestRemainderCells(entries.map((e) => e.value));
  const cell = mobile ? 20 : 28;
  const gap = mobile ? 2 : 3;
  const grid = cell * 10 + gap * 9;
  const legendRowHeight = mobile ? 24 : 30;
  const legendHeight = entries.length * legendRowHeight;
  const gutter = mobile ? 22 : 48;
  const otherWord = lang === "zh" ? "其他" : "Other";
  const otherNote = hasOther
    ? (lang === "zh"
        ? `${otherWord}包含：${merged.map((e) => `${resolveEconomyDisplayName(e.row[spec.category_field], spec.category_names, lang)} ${fmtWafflePercent(e.value)}`).join("、")}，合计 ${fmtWafflePercent(otherValue)}`
        : `${otherWord} includes: ${merged.map((e) => `${resolveEconomyDisplayName(e.row[spec.category_field], spec.category_names, lang)} ${fmtWafflePercent(e.value)}`).join(", ")} (exact sum ${fmtWafflePercent(otherValue)})`)
    : "";
  const noteMaxChars = mobile ? 40 : 60;
  const noteLineHeight = 16;
  const noteHeight = hasOther ? wrapText(otherNote, noteMaxChars).length * noteLineHeight + 10 : 0;
  const bodyHeight = mobile
    ? grid + gutter + legendHeight + noteHeight
    : Math.max(grid, legendHeight) + noteHeight;
  const f = mobile ? mobileFrame(spec, bodyHeight) : frame(spec, bodyHeight);
  const left = mobile ? f.margin : 54;
  const gridTop = f.bodyTop;
  let cursor = 0;
  entries.forEach((_e, k) => {
    const color = colors[k];
    for (let j = 0; j < cellCounts[k]; j++, cursor++) {
      const r = Math.floor(cursor / 10);
      const c = cursor % 10;
      const x = left + c * (cell + gap);
      const y = gridTop + r * (cell + gap);
      f.parts.push(`<rect data-role="waffle-cell" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${color}"${outline(k)}/>`);
    }
  });
  const legendLeft = mobile ? left : left + grid + gutter;
  const legendTop = mobile ? gridTop + grid + gutter : gridTop + 6;
  const nameX = legendLeft + 20;
  // One aligned value column: computed once from the widest name across
  // every legend row (not per-row), so every row's value lands at the same
  // x regardless of how long its own name is - a genuine right-aligned
  // table column, not a per-row guess that drifts row to row.
  const names = entries.map((e) => (e.row === null ? otherWord : resolveEconomyDisplayName(e.row[spec.category_field], spec.category_names, lang)));
  const maxNameWidth = Math.max(0, ...names.map((name) => textUnits(name) * 7.6));
  const valueRightX = nameX + maxNameWidth + 16 + 56; // fixed-width value column, right-aligned
  entries.forEach((e, k) => {
    const rowY = legendTop + k * legendRowHeight;
    f.parts.push(`<rect data-role="legend-swatch" x="${legendLeft}" y="${rowY}" width="12" height="12" fill="${colors[k]}"${outline(k)}/>`);
    f.parts.push(`<text x="${nameX}" y="${rowY + 10}" font-family="${FONT_SANS}" font-size="13" font-weight="600" fill="${PALETTE.ink}">${esc(names[k])}</text>`);
    f.parts.push(`<text data-cell-count="${cellCounts[k]}" x="${valueRightX}" y="${rowY + 10}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtWafflePercent(e.value))}</text>`);
  });
  if (hasOther) {
    const noteTop = mobile ? legendTop + entries.length * legendRowHeight + 10 : legendTop + entries.length * legendRowHeight + 14;
    svgTextLines(f.parts, otherNote, mobile ? left : legendLeft, noteTop, {
      size: 12,
      lineHeight: noteLineHeight,
      fill: PALETTE.muted,
      maxChars: noteMaxChars,
    });
  }
  (mobile ? addMobileFooter : addFooter)(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

// --- treemap ---------------------------------------------------------------
//
// Generic composition/part-to-whole chart: category_field + value_field,
// tile area strictly proportional to value, laid out with the squarified
// algorithm (Bruls, Huizing & van Wijk, "Squarified Treemaps", 1999) so
// tiles stay close to square instead of degenerating into thin slivers.
// Deterministic: callers always pre-sort items (value desc, ties by
// category name asc via treemapSort/treemapGroups below) before calling
// squarify, and squarify itself has no randomness or floating-point-order
// dependent branching - it only ever consumes that fixed order.

// Stable, deterministic ordering shared by the flat and grouped layouts:
// larger value first; equal values break the tie by category name so two
// renders of the same rows always produce the same tile order (and
// therefore the same layout) regardless of the input rows' own order.
function treemapSort(rows, categoryField, valueField) {
  return [...rows].sort((a, b) => {
    const va = n(a[valueField]) ?? 0, vb = n(b[valueField]) ?? 0;
    if (vb !== va) return vb - va;
    return String(a[categoryField] ?? "").localeCompare(String(b[categoryField] ?? ""));
  });
}

// Worst (largest) aspect-ratio deviation from square a row of items would
// have if laid out along a container whose shorter side is `side` - the
// squarified algorithm's own row-acceptance test (Bruls et al., section 3).
function squarifyWorst(areas, side) {
  const sum = areas.reduce((a, b) => a + b, 0);
  if (sum <= 0 || side <= 0) return Infinity;
  const max = Math.max(...areas), min = Math.min(...areas);
  const s2 = side * side;
  return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
}

// Squarified treemap layout. `items` must already be sorted by the caller
// (treemapSort/treemapGroups); this function never reorders them - it only
// ever takes a prefix run ("row") off the front of the remaining list, so
// output order always matches input order. Each returned tile's area
// (`w * h`) is exactly `item.__value * (w0 * h0 / totalValue)`: the area
// scale is fixed once up front from the full container and total value, and
// every subsequent row/column split preserves area exactly (mathematically;
// only float rounding of the coordinates themselves is inexact).
function squarify(items, x, y, w, h) {
  const total = items.reduce((sum, it) => sum + it.__value, 0);
  if (total <= 0 || w <= 0 || h <= 0 || items.length === 0) return [];
  const scale = (w * h) / total;
  let remaining = items.map((it) => ({ ...it, __area: it.__value * scale }));
  const tiles = [];
  let rx = x, ry = y, rw = w, rh = h;
  while (remaining.length) {
    const side = Math.min(rw, rh);
    let row = [remaining[0]];
    let worst = squarifyWorst(row.map((it) => it.__area), side);
    let i = 1;
    while (i < remaining.length) {
      const candidateAreas = [...row, remaining[i]].map((it) => it.__area);
      const candidateWorst = squarifyWorst(candidateAreas, side);
      if (candidateWorst <= worst) { row = [...row, remaining[i]]; worst = candidateWorst; i++; }
      else break;
    }
    const rowArea = row.reduce((sum, it) => sum + it.__area, 0);
    const rowLength = side > 0 ? rowArea / side : 0;
    if (rw >= rh) {
      // Container is wider than tall: lay this row out as a vertical strip
      // of stacked tiles on the left (width = rowLength, full height rh),
      // then recurse into the remaining rectangle to the right.
      let cy = ry;
      for (const item of row) {
        const itemH = rowLength > 0 ? item.__area / rowLength : 0;
        tiles.push({ ...item, x: rx, y: cy, w: rowLength, h: itemH });
        cy += itemH;
      }
      rx += rowLength; rw -= rowLength;
    } else {
      // Container is taller than wide: lay this row out as a horizontal
      // strip of side-by-side tiles along the top, then recurse downward.
      let cx = rx;
      for (const item of row) {
        const itemW = rowLength > 0 ? item.__area / rowLength : 0;
        tiles.push({ ...item, x: cx, y: ry, w: itemW, h: rowLength });
        cx += itemW;
      }
      ry += rowLength; rh -= rowLength;
    }
    remaining = remaining.slice(row.length);
  }
  return tiles;
}

// One-level grouping (group_field): partitions rows into groups, each
// group's total value is one item in an outer squarify pass, and every
// group's own rows are squarified again inside that group's rect. Returns
// null when group_field is not set, so callers fall back to the flat
// (ungrouped) layout - the "otherwise flat only" half of this task's spec.
function treemapGroups(rows, spec) {
  if (!spec.group_field) return null;
  const totals = new Map();
  for (const row of rows) {
    const g = String(row[spec.group_field] ?? "");
    totals.set(g, (totals.get(g) ?? 0) + Math.max(0, n(row[spec.value_field]) ?? 0));
  }
  return [...totals.entries()]
    .map(([group, value]) => ({ group, __value: value, rows: rows.filter((r) => String(r[spec.group_field] ?? "") === group) }))
    .sort((a, b) => (b.__value !== a.__value ? b.__value - a.__value : a.group.localeCompare(b.group)));
}

// Full tile layout: flat squarify over every row, or (group_field set) a
// group-level squarify pass whose rects each host their own nested
// squarify pass over that group's rows. `groupIndex`/`groupName` are
// attached to every returned tile so the renderer can colour and outline
// groups without re-deriving membership.
function layoutTreemapTiles(spec, rows, x, y, w, h) {
  const sorted = treemapSort(rows, spec.category_field, spec.value_field);
  const groups = treemapGroups(sorted, spec);
  if (!groups) {
    const items = sorted.map((row) => ({ row, __value: Math.max(0, n(row[spec.value_field]) ?? 0) }));
    return { tiles: squarify(items, x, y, w, h), groups: null };
  }
  const groupItems = groups.map((g) => ({ __value: g.__value }));
  const groupRects = squarify(groupItems, x, y, w, h);
  const tiles = [];
  groupRects.forEach((gr, gi) => {
    const groupRows = treemapSort(groups[gi].rows, spec.category_field, spec.value_field);
    const items = groupRows.map((row) => ({ row, __value: Math.max(0, n(row[spec.value_field]) ?? 0) }));
    for (const leaf of squarify(items, gr.x, gr.y, gr.w, gr.h)) tiles.push({ ...leaf, groupIndex: gi, groupName: groups[gi].group });
  });
  return { tiles, groups: groupRects.map((gr, gi) => ({ ...gr, name: groups[gi].group })) };
}

// "Other" bucket (other_threshold_pct): rows whose share of the total value
// falls below the threshold are merged into a single synthetic tile so a
// long tail of tiny items doesn't produce a wall of unreadable slivers. Only
// engages when at least two rows would actually be merged - merging one row
// into "Other" would just rename it, not simplify anything. validateVizSpec
// already rejects other_threshold_pct together with group_field, so this
// never has to decide which group an "Other" tile would belong to.
function bucketTreemapOther(spec, rows) {
  const threshold = Number(spec.other_threshold_pct);
  if (spec.group_field || !Number.isFinite(threshold) || threshold <= 0) return { rows, otherMembers: [] };
  const total = rows.reduce((sum, row) => sum + Math.max(0, n(row[spec.value_field]) ?? 0), 0);
  if (total <= 0) return { rows, otherMembers: [] };
  const kept = [], small = [];
  for (const row of rows) {
    const value = Math.max(0, n(row[spec.value_field]) ?? 0);
    ((value / total) * 100 < threshold ? small : kept).push(row);
  }
  if (small.length < 2) return { rows, otherMembers: [] };
  const otherValue = small.reduce((sum, row) => sum + Math.max(0, n(row[spec.value_field]) ?? 0), 0);
  const lang = vizLang(spec);
  const otherRow = { [spec.category_field]: VIZ_STRINGS[lang].treemapOther, [spec.value_field]: otherValue, __treemapOther: true };
  const otherMembers = small.map((row) => resolveEconomyDisplayName(row[spec.category_field], spec.category_names, lang));
  return { rows: [...kept, otherRow], otherMembers };
}

// Conservative per-character width budget for the inline tile label fit
// check below. Both constants sit above every measured advance width in
// render_qa_geometry.mjs's own bold table (max 0.9438em, "W") and its CJK
// bucket (1.0em, before that module's own 1.05x safety margin) - so this
// check only ever under-counts how much room a label needs, never
// over-counts it. Given a genuinely tight tile, the failure mode this
// biases toward is omitting a label that Chrome would actually have
// rendered without clipping, never rendering one that overflows - which is
// exactly this task's "never truncated/clipped text" requirement.
const TREEMAP_NARROW_EM = 0.95;
const TREEMAP_WIDE_EM = 1.05;
function treemapTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of Array.from(String(text ?? ""))) units += (isWideChar(ch) ? TREEMAP_WIDE_EM : TREEMAP_NARROW_EM) * fontSize;
  return units;
}

const TREEMAP_NAME_SIZE = 13; // category name - bold, sits at the "bold and >=13px" floor this task requires
const TREEMAP_SHARE_SIZE = 19; // share-of-total percent - the tile's primary, most prominent number
const TREEMAP_VALUE_SIZE = 12; // absolute value - lighter (smaller, regular weight), sits on the 12px font floor
const TREEMAP_PAD = 6; // inner padding on every side of a tile's label box

// Every treemap tile fill this renderer uses (the one neutral, the one
// accent, and the <=3 muted group hues below) was chosen so that whichever
// of white/ink wins labelStyleOnFill's contrast comparison clears the 4.5:1
// normal-text floor outright - never merely the 3:1 large-text floor. That
// means a label never needs the halo/stroke fallback labelStyleOnFill offers
// for a fill where neither candidate reaches 4.5:1: at every font size and
// weight this renderer uses, the plain contrast-chosen fill colour alone is
// enough. (Verified: ink-on-context 7.27:1, ink-on-each group hue 8.4-9.2:1,
// white-on-negative 5.90:1 - all comfortably above 4.5:1.)
// Deliberately two-valued, not three: a tile's category name is its
// identity, so a label is only ever drawn whole (name + share + value) or
// not at all. A fallback that showed the bare share percentage without its
// name would tell the reader a number with no way to know what it counts -
// worse than the existing overflow note, which at least still states the
// category next to its share and value in text form.
function planTreemapTileLabel(tile, nameLabel, shareLabel, valueLabel) {
  const usableW = tile.w - TREEMAP_PAD * 2;
  const usableH = tile.h - TREEMAP_PAD * 2;
  const nameW = treemapTextWidth(nameLabel, TREEMAP_NAME_SIZE);
  const shareW = treemapTextWidth(shareLabel, TREEMAP_SHARE_SIZE);
  const valueW = treemapTextWidth(valueLabel, TREEMAP_VALUE_SIZE);
  const fullH = TREEMAP_NAME_SIZE * 1.2 + TREEMAP_SHARE_SIZE * 1.15 + TREEMAP_VALUE_SIZE * 1.2;
  if (usableW >= Math.max(nameW, shareW, valueW) && usableH >= fullH) return { mode: "full" };
  return { mode: "none" };
}

function renderTreemap(spec, rows, mobile = false) {
  const lang = vizLang(spec);
  const t = VIZ_STRINGS[lang];
  const { rows: bucketed, otherMembers } = bucketTreemapOther(spec, rows);
  const left = mobile ? 32 : 54;
  const plotWidth = (mobile ? 640 : 1040) - left * 2;
  const plotHeight = mobile ? 320 : 420;
  const { tiles, groups } = layoutTreemapTiles(spec, bucketed, 0, 0, plotWidth, plotHeight);
  const legendH = groups ? (mobile ? 24 : 26) : 0;
  const maxChars = mobile ? 62 : 100;

  // Decide every tile's label before the frame is created: the overflow and
  // "Other" notes below the plot change the frame's total body height, so
  // both must be computed up front rather than appended after drawing.
  // Share-of-total is computed from the same bucketed rows the tiles were
  // laid out from (so an "Other" tile's share reflects its bucketed members,
  // not the un-bucketed original rows), and is the tile's primary number -
  // the reader compares tiles by share first, exact value second.
  const total = bucketed.reduce((sum, row) => sum + (n(row[spec.value_field]) ?? 0), 0);
  const overflow = [];
  for (const tile of tiles) {
    const categoryLabel = tile.row.__treemapOther ? String(tile.row[spec.category_field]) : resolveEconomyDisplayName(tile.row[spec.category_field], spec.category_names, lang);
    const rawValue = n(tile.row[spec.value_field]) ?? 0;
    const shareLabel = treemapSharePercent(total > 0 ? (rawValue / total) * 100 : 0);
    const valueLabel = specValueKind(spec) && Number.isInteger(rawValue) ? fmtSpec(spec, rawValue) : treemapValueLabel(rawValue, spec.unit, lang);
    tile.categoryLabel = categoryLabel;
    tile.shareLabel = shareLabel;
    tile.valueLabel = valueLabel;
    tile.labelPlan = planTreemapTileLabel(tile, categoryLabel, shareLabel, valueLabel);
    if (tile.labelPlan.mode === "none") overflow.push(`${categoryLabel}（${shareLabel}${t.treemapListSep}${valueLabel}）`);
  }
  const overflowLines = overflow.length ? wrapText(`${t.treemapUnlabeled}${overflow.join(t.treemapListSep)}`, maxChars) : [];
  const otherLines = otherMembers.length ? wrapText(`${t.treemapOtherIncludes}${otherMembers.join(t.treemapListSep)}`, maxChars) : [];
  const noteRowH = mobile ? 16 : 16;
  // NOTE_GAP is the distance from the plot's own bottom edge (the last
  // tile's y+h) to a note's *first baseline*, not merely to the note's
  // block top: a 12px note sits well below its baseline in the browser
  // (ascent is roughly 0.7-0.8em), so a small gap here would let the note's
  // own glyphs visually overlap the tile immediately above it. 20px clears
  // that ascent with margin at every supported font size.
  const NOTE_GAP = 20;
  const noteBlockHeight = (lines) => (lines.length ? NOTE_GAP + (lines.length - 1) * noteRowH + 6 : 0);
  const overflowH = noteBlockHeight(overflowLines);
  const otherH = noteBlockHeight(otherLines);
  const bodyHeight = legendH + plotHeight + overflowH + otherH;

  const f = mobile ? mobileFrame(spec, bodyHeight) : frame(spec, bodyHeight);
  let y = f.bodyTop;
  if (groups) {
    f.parts.push(`<text x="${left}" y="${y + 12}" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PALETTE.muted}">${t.group}</text>`);
    let lx = left + treemapTextWidth(t.group, 12) + 8;
    groups.forEach((group, gi) => {
      const swatch = TREEMAP_GROUP_HUES[gi % TREEMAP_GROUP_HUES.length];
      const label = textUnits(group.name) > (mobile ? 12 : 18) ? sliceUnits(group.name, (mobile ? 11 : 17)) + "…" : group.name;
      f.parts.push(`<rect x="${lx}" y="${y + 4}" width="9" height="9" fill="${swatch}"/>`);
      f.parts.push(`<text x="${lx + 13}" y="${y + 12}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(label)}</text>`);
      lx += 13 + treemapTextWidth(label, 12) + (mobile ? 14 : 20);
    });
    y += legendH;
  }
  const plotTop = y;

  // Group-boundary strokes are drawn first, behind every tile fill/label:
  // a stroke is decoration for the data marks, not a mark itself, so it must
  // never sit on top of a tile's fill or its label text (house-style: draw
  // any stroke behind data marks).
  if (groups) {
    for (const group of groups) {
      f.parts.push(`<rect data-role="treemap-group-boundary" x="${(left + group.x).toFixed(1)}" y="${(plotTop + group.y).toFixed(1)}" width="${group.w.toFixed(1)}" height="${group.h.toFixed(1)}" fill="none" stroke="${PALETTE.ink}" stroke-width="2"/>`);
    }
  }

  for (const tile of tiles) {
    const highlighted = (spec.highlight_values ?? []).map(String).includes(String(tile.row[spec.category_field]));
    // A tile's colour never implies a category unless group_field says so:
    // every ungrouped, unhighlighted tile shares the one neutral fill (no
    // per-tile rainbow cycling), a group_field tile takes its group's one
    // muted hue, and only an explicit highlight_values match gets the accent.
    const fill = highlighted
      ? treemapAccentFill()
      : groups
        ? TREEMAP_GROUP_HUES[(tile.groupIndex ?? 0) % TREEMAP_GROUP_HUES.length]
        : treemapNeutralFill();
    const tx = left + tile.x, ty = plotTop + tile.y;
    f.parts.push(`<rect data-role="treemap-tile" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" width="${Math.max(0, tile.w).toFixed(1)}" height="${Math.max(0, tile.h).toFixed(1)}" fill="${fill}" stroke="#ffffff" stroke-width="1.5"/>`);
    // This fill palette (one neutral, one accent, <=3 muted group hues) is
    // chosen so labelStyleOnFill's contrast winner always clears 4.5:1
    // outright (see the note beside TREEMAP_GROUP_HUES above), so a treemap
    // label never needs, and never emits, the halo/stroke fallback other
    // charts' marks sometimes require.
    const style = labelStyleOnFill(hexToRgb(fill));
    if (tile.labelPlan.mode === "full") {
      const lx2 = tx + TREEMAP_PAD;
      const nameY = ty + TREEMAP_PAD + TREEMAP_NAME_SIZE * 0.85;
      const shareY = nameY + TREEMAP_NAME_SIZE * 0.4 + TREEMAP_SHARE_SIZE * 0.85;
      const valueY = shareY + TREEMAP_SHARE_SIZE * 0.35 + TREEMAP_VALUE_SIZE * 0.85;
      f.parts.push(`<text data-role="treemap-tile-label" x="${lx2.toFixed(1)}" y="${nameY.toFixed(1)}" font-family="${FONT_SANS}" font-size="${TREEMAP_NAME_SIZE}" font-weight="700" fill="${style.fill}">${esc(tile.categoryLabel)}</text>`);
      f.parts.push(`<text data-role="treemap-tile-share" x="${lx2.toFixed(1)}" y="${shareY.toFixed(1)}" font-family="${FONT_SANS}" font-size="${TREEMAP_SHARE_SIZE}" font-weight="700" fill="${style.fill}">${esc(tile.shareLabel)}</text>`);
      f.parts.push(`<text data-role="treemap-tile-value" x="${lx2.toFixed(1)}" y="${valueY.toFixed(1)}" font-family="${FONT_SANS}" font-size="${TREEMAP_VALUE_SIZE}" font-weight="400" fill="${style.fill}">${esc(tile.valueLabel)}</text>`);
    }
  }
  y = plotTop + plotHeight;
  if (overflowLines.length) {
    overflowLines.forEach((line, i) => f.parts.push(`<text data-role="treemap-overflow-note" x="${left}" y="${(y + NOTE_GAP + i * noteRowH).toFixed(1)}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(line)}</text>`));
    y += overflowH;
  }
  if (otherLines.length) {
    otherLines.forEach((line, i) => f.parts.push(`<text data-role="treemap-other-note" x="${left}" y="${(y + NOTE_GAP + i * noteRowH).toFixed(1)}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(line)}</text>`));
  }

  (mobile ? addMobileFooter : addFooter)(f.parts, spec, f.footerTop);
  f.parts.push("</svg>");
  return f.parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// stacked_bar_100: composition across many entities. Each entity gets one
// horizontal bar running 0-100%, split into its segments (for example
// employment by sector in each country), so the reader compares how the mix
// differs from bar to bar. The bars are ordered by one named segment and that
// segment is drawn against the 0 baseline (FT Visual Vocabulary lists the
// form under part-to-whole; Datawrapper Academy: sort by one segment and keep
// it on the baseline).
//
// Every number drawn is a value_field value read from the rows and rounded
// only with fmtSpec and the spec's decimals (the axis ticks aside). A
// segment's width is its value divided by its own row's sum, so a bar always
// ends exactly at 100% and no value is ever adjusted to make a row add up;
// lintVizSpec refuses rows that do not already sum to 100 +/- 1 instead.
// ---------------------------------------------------------------------------
import { LATIN_ADVANCE_WIDTHS, LATIN_BOLD_ADVANCE_WIDTHS, TEXT_WIDTH_FACTORS } from "./render_qa_geometry.mjs";

const STACKED_MAX_BARS = 25;
const STACKED_WARN_BARS = 20;
const STACKED_MAX_SEGMENTS = 5;
const STACKED_SUM_TOLERANCE = 1;
const STACKED_SEGMENT_VALUES = ["in_bar", "highlight_column"]; // segment_values: "highlight_column" is the default, "in_bar" the opt-in
const STACKED_LABEL_PAD = 4; // px between an in-bar label and each edge of its segment
const STACKED_FALLBACK_ADVANCE = 1.02; // render QA's width for a glyph outside its tables (not exported there)

// Width of one line of text, estimated the way render QA measures it (same
// per-glyph tables and 1.05 safety margin), so "this label fits inside its
// segment" here and "this text overflows or overlaps" there cannot disagree.
function stackedTextWidth(text, fontSize = 12, bold = false) {
  const table = bold ? LATIN_BOLD_ADVANCE_WIDTHS : LATIN_ADVANCE_WIDTHS;
  let units = 0;
  for (const ch of Array.from(String(text ?? ""))) {
    if (/\s/.test(ch)) units += TEXT_WIDTH_FACTORS.space;
    else if (isWideChar(ch)) units += TEXT_WIDTH_FACTORS.cjk;
    else units += table[ch] ?? STACKED_FALLBACK_ADVANCE;
  }
  return units * fontSize * TEXT_WIDTH_FACTORS.safetyMargin;
}

// Coordinates are written to two decimals; adjacent segments share the one
// rounded boundary, so neighbours never overlap or leave a hairline gap.
function stackedPx(value) {
  return Math.round(value * 100) / 100;
}

// The rows read once into entities (bars, in first-appearance order) x
// segments. cells maps a segment to that entity's value (null when the value
// is not numeric). Shared by the renderer and by lintVizSpec so both see the
// same bars, segments and repeats.
function stackedBarModel(spec, rows) {
  const entities = [];
  const byKey = new Map();
  const segments = [];
  const seenSegment = new Set();
  let duplicates = 0;
  let blank = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.[spec.category_field] ?? "");
    const segment = String(row?.[spec.series_field] ?? "");
    if (key.trim() === "" || segment.trim() === "") blank += 1;
    if (!seenSegment.has(segment)) { seenSegment.add(segment); segments.push(segment); }
    let entity = byKey.get(key);
    if (!entity) { entity = { key, row, cells: new Map() }; byKey.set(key, entity); entities.push(entity); }
    if (entity.cells.has(segment)) { duplicates += 1; continue; }
    entity.cells.set(segment, n(row?.[spec.value_field]));
  }
  return { entities, segments, duplicates, blank };
}

// Segment order, highlight and sort segment, resolved from the spec's
// defaults: highlight_segment defaults to sort_segment, sort_segment to the
// first segment of segment_order, and segment_order to the highlight segment
// followed by the segments in the order they first appear. A segment the
// spec's segment_order does not list is appended (in first-appearance order)
// rather than dropped, so a bar can never end short of 100%.
function stackedPlan(spec, model) {
  const known = new Set(model.segments);
  const named = (value) => (value === undefined || value === null || String(value).trim() === "" ? null : String(value));
  const listed = Array.isArray(spec.segment_order) ? [...new Set(spec.segment_order.map(String))].filter((segment) => known.has(segment)) : [];
  const highlight = named(spec.highlight_segment) ?? named(spec.sort_segment) ?? listed[0] ?? model.segments[0] ?? null;
  let order;
  if (listed.length) order = [...listed, ...model.segments.filter((segment) => !listed.includes(segment))];
  else if (highlight !== null && known.has(highlight)) order = [highlight, ...model.segments.filter((segment) => segment !== highlight)];
  else order = [...model.segments];
  const sortSegment = named(spec.sort_segment) ?? order[0] ?? null;
  return { order, highlight, sortSegment };
}

// Bars ordered by the sort segment's own value (a bar without that segment
// counts as 0); "none" keeps the SQL row order. Ties keep the SQL row order.
function stackedSortedEntities(spec, model, sortSegment) {
  const entities = [...model.entities];
  const mode = spec.sort === "asc" || spec.sort === "none" ? spec.sort : "desc";
  if (mode === "none") return entities;
  const keyOf = (entity) => entity.cells.get(sortSegment) ?? 0;
  entities.sort((a, b) => (mode === "asc" ? keyOf(a) - keyOf(b) : keyOf(b) - keyOf(a)));
  return entities;
}

// 0 or 1 decimals: the spec's own choice, else one decimal when any value is
// not a whole number.
function stackedDecimals(spec, model) {
  if (spec.decimals === 0 || spec.decimals === 1) return spec.decimals;
  const fractional = model.entities.some((entity) => [...entity.cells.values()].some((value) => value !== null && Math.abs(value - Math.round(value)) > 1e-9));
  return fractional ? 1 : 0;
}

// True when some bar's values, as printed at this precision, do not add up to
// exactly 100. The printed strings are what get summed (never the raw values),
// and nothing is nudged so that they do.
function stackedNeedsRoundingNote(spec, entities, decimals) {
  const scale = 10 ** decimals;
  return entities.some((entity) => {
    let total = 0;
    for (const value of entity.cells.values()) {
      if (value !== null && value > 0) total += Math.round(Number(fmtSpec(spec, value, "", decimals)) * scale);
    }
    return total !== 100 * scale;
  });
}

// One accent for the highlight segment; every other segment takes the next of
// five distinct greys (the style's own grey steps, darkest to lightest), so
// two adjacent segments never share a fill (render QA's indistinct-adjacent-
// marks rule), even when a bar skips a segment. The steps are taken
// mid / darkest / light / dark so that neighbours differ strongly in
// lightness, which keeps the 1px gap between them easy to see.
function stackedFills(order, highlight) {
  const greys = [2, 0, 3, 1, 4].map((index) => WAFFLE_GREYS[index]);
  let next = 0;
  return new Map(order.map((segment) => [segment, segment === highlight ? PALETTE.accent : greys[next++ % greys.length]]));
}

// A name is never cut: one that is wider than its column (an entity name in
// the label column, the highlight name over the value column) is folded onto
// further lines (at a space when there is one past the first 40% of the line,
// else between characters).
function stackedFoldName(name, maxWidth, bold = false) {
  const lines = [];
  let rest = String(name);
  while (stackedTextWidth(rest, 12, bold) > maxWidth) {
    const chars = Array.from(rest);
    let cut = chars.length;
    while (cut > 1 && stackedTextWidth(chars.slice(0, cut).join(""), 12, bold) > maxWidth) cut -= 1;
    const head = chars.slice(0, cut).join("");
    const space = head.lastIndexOf(" ");
    const at = space > head.length * 0.4 ? space : head.length;
    lines.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  lines.push(rest);
  return lines;
}

function renderStackedBar100(spec, rows) {
  const lang = vizLang(spec);
  const t = VIZ_STRINGS[lang];
  const model = stackedBarModel(spec, rows);
  const { order, highlight, sortSegment } = stackedPlan(spec, model);
  const entities = stackedSortedEntities(spec, model, sortSegment);
  const decimals = stackedDecimals(spec, model);
  const valueText = (value) => fmtSpec(spec, value, "", decimals);
  const fills = stackedFills(order, highlight);
  // segment_values "highlight_column" (the default; "in_bar" is the opt-in): no
  // value inside the bars; only the highlight segment's value is printed,
  // right-aligned in a column just past the 100% end.
  const columnMode = spec.segment_values !== "in_bar" && highlight !== null && order.includes(highlight);
  const accentText = textSafeColor(PALETTE.accent);

  const left0 = 54, right0 = LAYOUT_W - 54;
  const roomy = entities.length <= 12;
  const barH = roomy ? 24 : 18;
  const nameLines = entities.map((entity) => stackedFoldName(String(resolveEconomyDisplayName(entity.row[spec.category_field], spec.category_names, lang)), Math.floor(LAYOUT_W * 0.3)));
  const nameLineCount = Math.max(1, ...nameLines.map((lines) => lines.length));
  const pitch = Math.max(roomy ? 36 : 26, nameLineCount > 1 ? 14 * nameLineCount + 6 : 0);
  const nameColW = Math.ceil(Math.min(Math.max(0, ...nameLines.flat().map((line) => stackedTextWidth(line))), LAYOUT_W * 0.4));
  const plotLeft = left0 + nameColW + 14;
  const columnTexts = columnMode ? entities.map((entity) => { const value = entity.cells.get(highlight); return value === undefined || value === null ? null : `${valueText(value)}%`; }) : [];
  const columnW = columnMode ? Math.ceil(Math.min(Math.max(stackedTextWidth(highlight, 12, true), ...columnTexts.filter((text) => text !== null).map((text) => stackedTextWidth(text))), LAYOUT_W * 0.2)) : 0;
  const plotRight = columnMode ? right0 - columnW - 14 : right0 - 16;
  const plotW = Math.max(1, plotRight - plotLeft);
  // The column header is the highlight name; a name wider than the column
  // folds onto further lines, and the rows below it move down to make room.
  const headerLines = columnMode ? stackedFoldName(highlight, columnW, true) : [];
  const headerExtra = Math.max(0, headerLines.length - 1) * 14;

  // Each bar's segments, left to right in segment order. A segment's width is
  // its value over this bar's own sum; the last segment ends exactly at the
  // 100% mark.
  const pieces = entities.map((entity) => {
    const present = order.filter((segment) => (entity.cells.get(segment) ?? 0) > 0);
    const total = present.reduce((sum, segment) => sum + entity.cells.get(segment), 0);
    let running = 0;
    return present.map((segment, index) => {
      const value = entity.cells.get(segment);
      const x0 = plotLeft + (plotW * running) / total;
      running += value;
      const x1 = index === present.length - 1 ? plotRight : plotLeft + (plotW * running) / total;
      return { segment, value, x0: stackedPx(x0), x1: stackedPx(x1) };
    });
  });

  // Segment names go once, centred on their own segment directly above the
  // first bar. If any name does not fit its segment (or direct labels are
  // switched off), one plain key line above the chart names them instead.
  const firstPieces = pieces[0] ?? [];
  const namesFit = spec.direct_labels !== false && firstPieces.length > 0 && order.every((segment) => {
    const piece = firstPieces.find((candidate) => candidate.segment === segment);
    return piece !== undefined && stackedTextWidth(segment, 12, segment === highlight) + 2 * STACKED_LABEL_PAD <= piece.x1 - piece.x0;
  });
  const keyLines = [];
  if (!namesFit && order.length) {
    const maxKeyW = (columnMode ? plotRight : right0) - plotLeft;
    let line = [], cursor = 0;
    for (const segment of order) {
      const width = 16 + stackedTextWidth(segment, 12, segment === highlight);
      if (line.length && cursor + 20 + width > maxKeyW) { keyLines.push(line); line = []; cursor = 0; }
      const x = line.length ? cursor + 20 : 0;
      line.push({ segment, x, width });
      cursor = x + width;
    }
    if (line.length) keyLines.push(line);
  }
  // The rounding note is about printed figures that a reader could add up, so
  // it is only drawn when a bar prints several of them (in-bar values); the
  // single highlight column prints one figure per bar, with nothing to add.
  const needNote = !columnMode && stackedNeedsRoundingNote(spec, entities, decimals);

  // Vertical layout, relative to the top of the chart body: key line(s), the
  // axis row, the segment-name row, then the bars and the rounding note.
  let rel = 0;
  const keyRel = [];
  if (keyLines.length) { keyLines.forEach((_, k) => keyRel.push(rel + 12 + k * 18)); rel += keyLines.length * 18 + 8 + headerExtra; }
  const axisRel = rel + 12;
  rel = axisRel + 10;
  let namesRel = null;
  if (namesFit) { namesRel = rel + 12; rel = namesRel + 9 + headerExtra; } else rel += 2;
  const barsRel = rel;
  const barsEndRel = barsRel + Math.max(0, entities.length - 1) * pitch + barH;
  const gridEndRel = barsEndRel + 6;
  const noteRel = barsEndRel + 26;
  const bodyHeight = (needNote ? noteRel + 6 : gridEndRel + 6) + 4;

  // A short chart (a handful of bars) keeps the canvas its content needs
  // instead of the 420px default, which would leave a blank band under the
  // bars; 300 is the same floor renderHorizontal's tight layout uses.
  const f = frame(spec, bodyHeight, 300);
  const o = f.bodyTop + 2;
  const parts = f.parts;
  const ticks = [0, 25, 50, 75, 100];
  const tickX = (tick) => stackedPx(plotLeft + (plotW * tick) / 100);

  // Gridlines first, so every bar and label paints over them.
  for (const tick of ticks) {
    parts.push(`<line data-role="grid-line" x1="${tickX(tick)}" y1="${o + axisRel + 5}" x2="${tickX(tick)}" y2="${o + gridEndRel}" stroke="${PALETTE.grid}" stroke-width="1"/>`);
  }
  // A paper-coloured plate behind each segment name keeps a gridline from
  // running through the text.
  if (namesFit) {
    for (const piece of firstPieces) {
      const width = stackedTextWidth(piece.segment, 12, piece.segment === highlight);
      parts.push(`<rect x="${stackedPx((piece.x0 + piece.x1) / 2 - width / 2 - 3)}" y="${o + namesRel - 11}" width="${stackedPx(width + 6)}" height="15" fill="${PAPER}"/>`);
    }
  }
  ticks.forEach((tick, i) => {
    parts.push(`<text x="${tickX(tick)}" y="${o + axisRel}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(`${tick}${axisTickUnit("%", i, ticks.length)}`)}</text>`);
  });
  if (namesFit) {
    for (const piece of firstPieces) {
      const isHighlight = piece.segment === highlight;
      parts.push(`<text data-role="stacked-segment-name" x="${stackedPx((piece.x0 + piece.x1) / 2)}" y="${o + namesRel}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="${isHighlight ? 700 : 400}" fill="${isHighlight ? accentText : PALETTE.ink}">${esc(piece.segment)}</text>`);
    }
  } else {
    keyLines.forEach((line, k) => {
      for (const item of line) {
        const isHighlight = item.segment === highlight;
        parts.push(`<rect data-role="legend-swatch" x="${stackedPx(plotLeft + item.x)}" y="${o + keyRel[k] - 9}" width="10" height="10" fill="${fills.get(item.segment)}"/>`);
        parts.push(`<text data-role="stacked-key" x="${stackedPx(plotLeft + item.x + 16)}" y="${o + keyRel[k]}" font-family="${FONT_SANS}" font-size="12" font-weight="${isHighlight ? 700 : 400}" fill="${isHighlight ? accentText : PALETTE.ink}">${esc(item.segment)}</text>`);
      }
    });
  }
  headerLines.forEach((line, k) => {
    parts.push(`<text data-role="stacked-column-header" x="${right0}" y="${o + (namesFit ? namesRel : keyRel[0]) + 14 * k}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${accentText}">${esc(line)}</text>`);
  });

  // The bars: one rect per segment, a 1px paper-coloured stroke making the gap
  // between neighbours.
  entities.forEach((entity, i) => {
    const barTop = o + barsRel + i * pitch;
    for (const piece of pieces[i]) {
      parts.push(`<rect data-role="stacked-segment" data-category="${esc(entity.key)}" data-series="${esc(piece.segment)}" data-value="${piece.value}" x="${piece.x0}" y="${barTop}" width="${stackedPx(piece.x1 - piece.x0)}" height="${barH}" fill="${fills.get(piece.segment)}" stroke="${PAPER}" stroke-width="1"/>`);
    }
  });
  // In-bar values only where the label fits inside its segment with the
  // padding on each side; white on the accent or a dark grey, ink on a light
  // grey, whichever clears the contrast floor.
  if (!columnMode) {
    entities.forEach((entity, i) => {
      const barTop = o + barsRel + i * pitch;
      for (const piece of pieces[i]) {
        const text = valueText(piece.value);
        if (stackedTextWidth(text) + 2 * STACKED_LABEL_PAD > piece.x1 - piece.x0) continue;
        const style = labelStyleOnFill(hexToRgb(fills.get(piece.segment)));
        const halo = style.halo ? ` stroke="${style.halo}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"` : "";
        parts.push(`<text data-role="stacked-value" x="${stackedPx((piece.x0 + piece.x1) / 2)}" y="${barTop + barH / 2 + 4}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${style.fill}"${halo}>${esc(text)}</text>`);
      }
    });
  }
  entities.forEach((entity, i) => {
    const centre = o + barsRel + i * pitch + barH / 2;
    const lines = nameLines[i];
    lines.forEach((line, k) => {
      parts.push(`<text data-role="stacked-entity" x="${plotLeft - 14}" y="${centre + 4 - 7 * (lines.length - 1) + 14 * k}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(line)}</text>`);
    });
    if (columnMode && columnTexts[i] !== null) {
      parts.push(`<text data-role="stacked-column-value" x="${right0}" y="${centre + 4}" text-anchor="end" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.ink}">${esc(columnTexts[i])}</text>`);
    }
  });
  if (needNote) {
    parts.push(`<text data-role="stacked-rounding-note" x="${left0}" y="${o + noteRel}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(t.stackedRoundingNote)}</text>`);
  }

  addFooter(parts, spec, f.footerTop);
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}

// Average glyph advance width (em/char) used only for this renderer's own
// label-placement math (does a label's estimated box fit on the map / does
// it collide with another placed label) - the same 0.56em/char heuristic
// renderCartographicFlowMap's own point-label placement already uses
// (`textUnits(label)*font*.56+9`). textUnits already counts a wide (CJK)
// character as 2 units, so one constant covers zh and en labels alike. This
// is a placement heuristic only, not a pass/fail floor: render_qa_geometry.mjs
// measures the actually rendered text with its own, independent per-glyph
// table, so this estimate only has to be close enough that this renderer's
// own placement rarely disagrees with it.
function choroplethLabelWidth(text, font) {
  return textUnits(text) * font * 0.56 + 8;
}

// Projected, horizon-filtered rings of one feature. The label-placement
// searches below test thousands of candidate points/boxes/segments against the
// same few features, and each test used to re-filter and re-project every ring
// vertex; the projected points depend only on (projection, feature, centre),
// so they are computed once per projection function and reused. Callers only
// read the returned arrays.
const PROJECTED_RING_CACHE = new WeakMap();
function projectedFeatureRings(index, project, lon0, lat0) {
  let byKey = PROJECTED_RING_CACHE.get(project);
  if (!byKey) PROJECTED_RING_CACHE.set(project, (byKey = new Map()));
  const key = `${index}|${lon0}|${lat0}`;
  let rings = byKey.get(key);
  if (!rings) {
    rings = geometryRings(neFeatureGeometry(index))
      .filter((ring) => ringWithinHorizon(ring, lon0, lat0, 90))
      .map((ring) => {
        const pts = ring.map(([lon, lat]) => project(lon, lat));
        // Bounding box of the finite vertices: lets the callers skip a ring
        // that provably cannot intersect the point/box/segment they test.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const q of pts) {
          if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
          if (q.x < minX) minX = q.x;
          if (q.x > maxX) maxX = q.x;
          if (q.y < minY) minY = q.y;
          if (q.y > maxY) maxY = q.y;
        }
        pts.bb = { minX, minY, maxX, maxY };
        return pts;
      });
    byKey.set(key, rings);
  }
  return rings;
}

// Nonzero-winding point-in-polygon over feature `index`'s own projected
// rings (unclipped - a query point already known to be within the map rect,
// which is every caller here, is unaffected by clipping either way). Used
// only to decide *whether a label may be placed on-map*: an on-map label's
// two text-line anchor points are centred a small distance above/below the
// feature's own sidecar label point, and on a narrow/small feature (common
// for a coastal West African country at this map's zoom) that offset alone
// can land a line's own anchor outside the feature's true shape and onto
// whatever context/neighbour polygon sits behind it - labelStyleOnFill would
// then have picked white/ink for the *wrong* fill. Requiring both anchors to
// verifiably sit on the same feature this label is naming (the same check
// render_qa_contrast.mjs's own polygon containment performs) is what makes
// this renderer's own contrast decision always agree with that gate, rather
// than relying on the halo alone to paper over a wrong colour choice.
function pointOnFeature(index, x, y, project, lon0, lat0) {
  let inside = false;
  for (const pts of projectedFeatureRings(index, project, lon0, lat0)) {
    // A crossing needs y inside the ring's y-range and x left of its far edge.
    if (y < pts.bb.minY || y > pts.bb.maxY || x >= pts.bb.maxX) continue;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      const crosses = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

/**
 * chart_type='choropleth': a regional choropleth of the joined rows
 * (runtime/pi/choropleth.mjs's joinChoroplethRows/lintChoroplethSpec/
 * niceBreaks/classifyValue do the join, lint, and class-break math; this
 * function only lays the result out as SVG), a locator inset tracing the
 * main map's own visible frame, and per-feature labels that fall back to a
 * leader-lined side margin when they collide or leave the plot. Mirrors the
 * user-approved spike's map()/locator()/legend() (experiments/infographic/
 * africa/page.js, read-only reference) translated from d3 into this file's
 * own hand-written SVG/geometry conventions (no mapping dependency added).
 */
// Adaptive zoom-inset ladder (desktop only). Rung 0 is the long-standing
// default (a third of the plot width, 25-degree cluster radius) and is what
// every render that already places its markers gets, byte for byte. Only when
// rung 0 has a zoom inset AND leaves numbered regions without a map marker are
// the later rungs tried: progressively larger frames (share of the plot width,
// fraction of the map height) and tighter cluster radii, with a strip panel
// that spans the plot width. Every candidate is scored by the same render QA
// the gate runs (geometry, contrast, value labels - no rule or threshold is
// changed). A candidate replaces the incumbent when it has fewer QA failures
// in total (every failure blocks equally, whichever rule it is), or the same
// number and strictly fewer list-only regions without any failure rule the
// incumbent lacks; remaining ties keep the earlier, less intrusive rung. A
// candidate whose QA cannot be computed is never chosen (fail closed). The
// search stops at the first rung with no list-only regions and no failures.
const INSET_LADDER = [
  { share: 0.33, heightFrac: 0.62, clusterDeg: 25 },
  { share: 0.5, heightFrac: 0.75, clusterDeg: 25, wideStrip: true },
  { share: 0.5, heightFrac: 0.75, clusterDeg: 18, wideStrip: true },
  { share: 0.7, heightFrac: 0.85, clusterDeg: 18, wideStrip: true },
  { share: 0.7, heightFrac: 0.85, clusterDeg: 12, wideStrip: true },
  { share: 0.9, heightFrac: 0.92, clusterDeg: 12, wideStrip: true },
  { share: 0.9, heightFrac: 0.92, clusterDeg: 8, wideStrip: true },
];
// Rule names of every render-QA failure in `svg`, or null when the QA itself
// could not run (never treated as "no failures").
function insetRenderQaRules(svg, spec, rows) {
  try {
    const labels = checkChoroplethValueLabels(svg, { rows, category_field: spec.category_field, value_field: spec.value_field, category_names: spec.category_names, unit: spec.unit, measure_kind: specValueKind(spec) ?? spec.measure_kind, measure_semantics: spec.measure_semantics, ...(isWorldExtent(spec) ? { map_extent: "world", highlight_values: spec.highlight_values } : {}) }, { parseXml, joinChoroplethRows, fmt: choroplethValueText, noDataFill: PALETTE.grid, worldLabelIso3s });
    return [...checkSvgGeometry(svg).failures, ...checkSvgContrast(svg).failures, ...labels.failures].map((f) => f.rule);
  } catch {
    return null;
  }
}
function renderChoropleth(spec, rows, mobile = false) {
  const meta0 = {};
  const first = renderChoroplethOnce(spec, rows, mobile, INSET_LADDER[0], meta0);
  if (mobile || !meta0.hasInset || meta0.listOnly === 0) return first;
  let best = null;
  const consider = (svg, meta) => {
    const qa = insetRenderQaRules(svg, spec, rows);
    if (!qa) return;
    const noNewRule = qa.every((rule) => best?.qa.includes(rule));
    if (!best || qa.length < best.qa.length || (qa.length === best.qa.length && noNewRule && meta.listOnly < best.meta.listOnly)) best = { svg, meta, qa };
  };
  consider(first, meta0);
  for (const tune of INSET_LADDER.slice(1)) {
    if (best && best.meta.listOnly === 0 && best.qa.length === 0) break;
    const meta = {};
    consider(renderChoroplethOnce(spec, rows, mobile, tune, meta), meta);
  }
  return best ? best.svg : first;
}
function renderChoroplethOnce(spec, rows, mobile, tune, meta) {
  const lang = vizLang(spec);
  const font = mobile ? 12 : 12.5;
  const lineH = mobile ? 14 : 15;
  // In-polygon name/value label pairs (main map and inset alike) stack two
  // lines around a shared anchor point, each offset labelLineDy from centre
  // - a baseline-to-baseline gap of 2x that, i.e. 1.2x the font size, the
  // house-style tight line-height for a two-line stacked label. This is
  // deliberately its own, smaller value rather than lineH itself: lineH
  // sizes the *box* around this pair (collision/obstacle checks, leader-
  // length caps, column layout, footnote row height - see boxH/insetBoxAt/
  // MAX_OVERFLOW_LEADER_PX below) and stays unchanged; only where these two
  // specific lines of text sit inside that unchanged box gets tighter. Using
  // lineH directly for both lines' own distance from centre (the box's
  // radius, not the tight line-height a reader expects between a name and
  // its value) used to read as almost a full extra blank line between them.
  const labelLineDy = font * 0.6;

  // Join + 5-class breaks. lintVizSpec (run by critiqueViz before any spec
  // reaches a renderer) already blocks unmapped/aggregate/no-feature/
  // duplicate/>60-row specs; this renderer still filters defensively so a
  // caller exercising the renderer directly (e.g. a unit test) never crashes
  // instead of drawing a visibly incomplete map.
  const joined = joinChoroplethRows(rows, spec).filter(
    (item) => item.entry?.kind === "economy" && item.iso3 && item.featureIndices.length && Number.isFinite(n(item.row[spec.value_field]))
  );
  const values = joined.map((item) => n(item.row[spec.value_field]));
  const classOpts = { integer: Boolean(specValueKind(spec)) && values.every(Number.isInteger) };
  const classPlan = mobile ? { breaks: niceBreaks(values.length ? Math.min(...values) : 0, values.length ? Math.max(...values) : 1, 5, classOpts), skewed: false } : classBreaks(values, 5, classOpts);
  const breaks = classPlan.breaks;
  const colorForValue = (value) => CHOROPLETH_RAMP[classifyValue(value, breaks)];

  const width = mobile ? 640 : 1040;
  // Review fix (task: crop the main map to the data extent): no fixed side
  // gutter reserved for overflow labels any more - a label that cannot sit
  // on its own feature now gets a short (<=120px) leader to a nearby empty
  // slot inside the map itself (see the overflow spiral search below), and
  // anything that cannot even find that gets pulled into the zoom inset, so
  // the map fills the whole plot width and the Atlantic strip it leaves
  // empty is only whatever the data's own geography leaves empty.
  const mapH = mobile ? 380 : 460;
  const bodyH = mapH + (mobile ? 74 : 80);
  // f is rebuilt below, once the footnote fallback's own row count is known,
  // to reserve enough extra body height for its list - bodyTop/margin (the
  // only fields read before that point) don't depend on the bodyHeight
  // argument, so this first build is safe to use for layout, then discard.
  let f = mobile ? mobileFrame(spec, bodyH) : frame(spec, bodyH);
  const plotLeft = mobile ? f.margin : 54;
  const plotRight = width - (mobile ? f.margin : 54);
  const top = f.bodyTop + 6;
  const bottom = top + mapH;
  // mapLeft moves right of plotLeft only when a zoom inset gets its own
  // reserved column (see insetColumnW below); everything the map geometry is
  // fitted/clipped/labelled against reads mapLeft, everything that belongs to
  // the whole chart body (ocean frame, legend, footnote list) reads plotLeft.
  let mapLeft = plotLeft;
  const mapRight = plotRight;

  // Project centred on the joined features' own lon/lat bbox (task 3):
  // gather every ring point of every data feature, centre on their bbox, and
  // fit an azimuthal projection to the map sub-rect (never the gutter) with
  // padding - fitAzimuthalProjection's own doc comment explains why this has
  // to fit the real projected geometry, not a resampled lon/lat bbox.
  const dataPoints = [];
  for (const item of joined) {
    for (const idx of item.featureIndices) {
      for (const ring of framingRings(geometryRings(neFeatureGeometry(idx)))) for (const pt of ring) dataPoints.push(pt);
    }
  }
  // World mode: a fixed Equal Earth frame (never the data's bbox) with no Antarctica.
  const worldMode = isWorldExtent(spec);
  if (worldMode) dataPoints.splice(0, dataPoints.length, ...WORLD_FRAME_POINTS);
  // Review fix (framing): ~6% padding around the data bbox, not the wider
  // 10% this renderer started with - a caller's data footprint (e.g. a
  // handful of West/Central African states) otherwise leaves the projection
  // free to show a third of the map as geography no plotted region actually
  // occupies (Arabia, the Indian Ocean) once fitAzimuthalProjection's own
  // uniform scale binds to the tighter of width/height.
  // Diagnosis P1: the projection follows the data's real spherical extent (see
  // chooseMapProjection), not the bbox midpoint alone - data spread over more
  // than one azimuthal hemisphere gets a world projection instead of silently
  // losing every ring beyond the horizon. horizonLat0 is lat0 for the
  // azimuthal projection and null for the world one (no horizon to filter on).
  const mapChoice = worldMode ? { kind: "world", lon0: 0, lat0: 0 } : chooseMapProjection(dataPoints);
  const { lon0, lat0 } = mapChoice;
  const horizonLat0 = mapChoice.kind === "world" ? null : lat0;
  let proj = fitMapProjection(mapChoice, dataPoints, mapLeft, mapRight, top, bottom, 0.06);
  const project = (lon, lat) => proj.project(lon, lat);

  // Coverage contract for framingRings: a region's far, tiny pieces do not
  // drive the frame, so when one lies wholly outside the map rect (and is big
  // enough to see, >= 1 deg^2) the chart note names the region instead of
  // clipping it silently.
  const clippedTerritoryItems = joined.filter((item) => item.featureIndices.some((idx) =>
    clippedFramingRings(geometryRings(neFeatureGeometry(idx)), project, { left: mapLeft, right: mapRight, top, bottom }).length));

  const dataByIndex = new Map();
  for (const item of joined) for (const idx of item.featureIndices) dataByIndex.set(idx, item);
  const featureCount = neFeatureCount();

  // Zoom inset (opt-in via spec.inset): manual (an explicit iso3 list) or
  // automatic - a region whose own projected bbox cannot fit a name line
  // plus a value line at the 12px label floor, using the same advance-width
  // heuristic (choroplethLabelWidth/lineH) this renderer's own on-map
  // placement already estimates label size with, so "too small to label"
  // means the same thing here as it does for the on-map/margin decision
  // above. A region chosen for the inset gets no main-map label at all (see
  // labelItems below) - only its colour fill and white outline stay on the
  // main map, same as any other plotted region.
  const insetSpec = !worldMode && spec.inset && typeof spec.inset === "object" ? spec.inset : null;
  const insetIso3Set = new Set();
  const INSET_CLUSTER_DEG = tune.clusterDeg;
  // Centre for a secondary view (locator, zoom inset, clustering): the same
  // rule as the main map (bbox centre when everything is within reach, else the
  // minimal enclosing cap), never the bbox midpoint alone, which lands on the
  // far side of the globe for data straddling the antimeridian.
  const viewCentre = (pts) => {
    const choice = chooseMapProjection(pts);
    if (choice.kind === "azimuthal") return [choice.lon0, choice.lat0];
    const cap = enclosingCap(pts);
    return [cap.lon, cap.lat];
  };
  const insetCentreOf = (item) => viewCentre(item.featureIndices.flatMap((idx) => geometryRings(neFeatureGeometry(idx)).flat()));
  const angDeg = (p1, p2) => {
    const r = Math.PI / 180;
    const cosd = Math.sin(p1[1] * r) * Math.sin(p2[1] * r) + Math.cos(p1[1] * r) * Math.cos(p2[1] * r) * Math.cos((p1[0] - p2[0]) * r);
    return Math.acos(Math.max(-1, Math.min(1, cosd))) / r;
  };
  // A region demoted later (its leader would be too long) may only join the
  // zoom inset when it lies near the regions already in it; otherwise the
  // panel's extent would balloon and shrink everything back to a dot.
  const farFromInset = (iso3) => {
    if (!insetIso3Set.size) return false;
    const item = joined.find((j) => j.iso3 === iso3);
    if (!item) return false;
    const c = insetCentreOf(item);
    return !joined.some((j) => insetIso3Set.has(j.iso3) && angDeg(c, insetCentreOf(j)) <= INSET_CLUSTER_DEG);
  };
  if (insetSpec) {
    if (Array.isArray(insetSpec.iso3) && insetSpec.iso3.length) {
      for (const code of insetSpec.iso3) insetIso3Set.add(String(code ?? "").trim().toUpperCase());
    } else if (insetSpec.auto) {
      const autoCandidates = [];
      for (const item of joined) {
        const bbox = projectedFeatureBBox(item.featureIndices, project);
        const value = n(item.row[spec.value_field]) ?? 0;
        const name = resolveEconomyDisplayName(item.raw, spec.category_names, lang);
        const valueText = choroplethValueText(value, spec.unit, spec);
        const neededW = Math.max(choroplethLabelWidth(name, font), choroplethLabelWidth(valueText, font));
        const neededH = lineH * 2 + 6;
        const tooSmall = !bbox || bbox.maxX - bbox.minX < neededW || bbox.maxY - bbox.minY < neededH;
        if (tooSmall) autoCandidates.push(item);
      }
      // A zoom panel only magnifies one neighbourhood: merging regions that sit
      // far apart fits a near-global extent and shrinks each back to a dot. Keep
      // the largest group of candidates that lie within INSET_CLUSTER_DEG of one
      // another (ties: tighter, then iso3); the rest keep their main-map labels.
      const centres = autoCandidates.map((item) => ({ item, c: insetCentreOf(item) }));
      let bestGroup = [];
      let bestSpread = Infinity;
      for (const seed of centres) {
        const group = centres.filter((o) => angDeg(seed.c, o.c) <= INSET_CLUSTER_DEG);
        const spread = Math.max(...group.map((o) => angDeg(seed.c, o.c)));
        const better = group.length > bestGroup.length
          || (group.length === bestGroup.length && (spread < bestSpread
            || (spread === bestSpread && group.map((o) => o.item.iso3).sort().join() < bestGroup.map((o) => o.item.iso3).sort().join())));
        if (better) { bestGroup = group; bestSpread = spread; }
      }
      for (const o of bestGroup) insetIso3Set.add(o.item.iso3);
    }
  }
  // Zoom inset natural size (magnification >=2.5x, see the layout further
  // down): fitAzimuthalProjection's own scale is linear in the target rect's
  // size (scaling the rect by k scales .scale by k too - see the function's
  // own doc comment), so probing a 1x1 target gives a scale-per-pixel
  // constant that a target linear scale (here 2.6x the main map's own
  // proj.scale, a small margin over the 2.5x floor) can be solved for
  // directly: targetSize = targetScale / probe.scale. A function of the main
  // projection's scale and the inset's feature set so the column reserved for
  // the panel (below) and the panel itself are sized by the same rule.
  const MIN_INSET_MAGNIFICATION = 2.5;
  function insetNaturalMapSize(points, mainScale) {
    const pts = points.length ? points : [[lon0, lat0]];
    const [zl0, zl1] = viewCentre(pts);
    const probe = fitAzimuthalProjection(zl0, zl1, pts, 0, 1, 0, 1, 0.12);
    const raw = probe.scale > 0 ? (mainScale * (MIN_INSET_MAGNIFICATION + 0.1)) / probe.scale : mobile ? 90 : 120;
    return Math.max(mobile ? 70 : 90, Math.min(mobile ? 170 : 230, raw));
  }
  const insetPanelWidthFor = (mapSize) => Math.max(mapSize + 12, mobile ? 140 : 170);
  // P3 (items 3 and 5): on desktop the panel is about a third as wide as the
  // main map, and its height follows the aspect of the selected extent (never
  // below the natural square size, capped so it cannot swallow the frame).
  // The map inside is then fitted to that W x H rectangle, so the extent is
  // widened to the panel's aspect and the surrounding land fills the rest.
  function insetNaturalDims(points, mainScale, widthOverride) {
    const nat = insetNaturalMapSize(points, mainScale);
    if (mobile) return { w: nat, h: nat };
    const pts = points.length ? points : [[lon0, lat0]];
    const [zl0, zl1] = viewCentre(pts);
    const probe = fitAzimuthalProjection(zl0, zl1, pts, 0, 1000, 0, 1000, 0);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const pt of pts) {
      const q = probe.project(pt[0], pt[1]);
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    }
    const aspect = x1 > x0 && y1 > y0 ? Math.min(3, Math.max(0.5, (x1 - x0) / (y1 - y0))) : 1;
    const w = widthOverride ?? Math.max(nat, Math.round((INSET_WIDTH_SHARE * (plotRight - plotLeft - INSET_COLUMN_GAP)) / (1 + INSET_WIDTH_SHARE)));
    const h = Math.max(nat, Math.min(w / aspect, tune.heightFrac * mapH));
    return { w, h };
  }

  // Task (inset outside the map): when a zoom inset is requested, the panel
  // gets its own column to the LEFT of the map instead of floating over it -
  // a panel inside the plot always covered either basemap land or a label
  // once the data's own extent filled the frame (West Africa's coast runs
  // right up to the Atlantic gutter the panel used to sit in). The column is
  // sized from the panel's natural width at the FULL-width projection, an
  // upper bound (shrinking the map can only shrink the magnified panel, and
  // its floor width is already in the bound), then the map is re-fitted into
  // what remains. Only a spec that names its inset up front reserves a
  // column: a region force-added to the inset later (leader too long) keeps
  // the old in-plot placement, and a choropleth with no inset at all is
  // untouched. When the column would leave the map narrower than
  // MIN_MAP_W_WITH_COLUMN (the mobile canvas: a 380px map pushes regions out
  // of their own labels and into the inset), the panel gets a strip BELOW the
  // map instead (insetStripH), between the map and the legend.
  const INSET_COLUMN_GAP = 14;
  const INSET_WIDTH_SHARE = tune.share;
  const MIN_MAP_W_WITH_COLUMN = 560;
  const INSET_STRIP_LEGEND_GAP = 8;
  let insetColumnW = 0;
  let insetStripH = 0;
  // Enlarged ladder rungs: a strip panel spans the whole plot width (more
  // surrounding context and label room) instead of the share-based width,
  // which would leave blank page areas on both sides of it. The default rung
  // keeps its original strip width.
  const stripPanelWidth = tune.wideStrip ? plotRight - plotLeft - 12 : undefined;
  if (insetIso3Set.size) {
    const pts = [];
    for (const item of joined) {
      if (!insetIso3Set.has(item.iso3)) continue;
      for (const idx of item.featureIndices) for (const ring of geometryRings(neFeatureGeometry(idx))) for (const pt of ring) pts.push(pt);
    }
    const reserve = insetPanelWidthFor(insetNaturalDims(pts, proj.scale).w) + INSET_COLUMN_GAP;
    if (plotRight - plotLeft - reserve >= MIN_MAP_W_WITH_COLUMN) {
      insetColumnW = reserve;
      mapLeft = plotLeft + insetColumnW;
      proj = fitMapProjection(mapChoice, dataPoints, mapLeft, mapRight, top, bottom, 0.06);
    } else {
      // Same upper-bound reasoning for the height: the title row, the
      // natural-size map and the panel's own padding (see insetPanelH).
      const mapSize = insetNaturalDims(pts, proj.scale, stripPanelWidth).h;
      insetStripH = Math.min(mapH - 2 * 8, 18 + mapSize + 8) + INSET_COLUMN_GAP + INSET_STRIP_LEGEND_GAP;
      f = mobile ? mobileFrame(spec, bodyH + insetStripH) : frame(spec, bodyH + insetStripH);
    }
  }

  // insetItems/insetFeatureIndices are finalized further down, after the
  // label-placement retry loop below has had a chance to force any
  // leader>120px region into the inset too (task: crop the extent - no
  // label may need a leader longer than the render-QA gate allows,
  // regardless of whether the caller opted into spec.inset at all).

  const clipId = `choropleth-clip-${mobile ? "m" : "d"}`;

  // Labels (task 4): try each feature's own sidecar label point first; fall
  // back to the side margin (leader line + dot) when it collides with an
  // already-placed label or falls outside the map sub-rect. Contrast is
  // never the deciding factor for *which* slot a label gets - labelStyleOnFill
  // always returns a WCAG-passable {fill, halo} pair for whichever fill sits
  // underneath - only the two geometric reasons (collision, out-of-bounds)
  // ever move a label; every label's fill/halo is still chosen this way, so
  // contrast is guaranteed regardless of which slot it lands in. A region
  // pulled into the zoom inset above is excluded here entirely - it gets no
  // main-map label at all, only its colour fill and outline (task: inset).
  // Computed before the land/legend drawing below (not just before the
  // on-map/margin text emission that used to follow it) so the inset panel's
  // own corner placement, decided next, can avoid every label box exactly as
  // the locator inset already does.
  // Review fix (clutter, then year-note clarity): the per-label year is
  // gone - when the joined rows' own reference periods differ, a footer
  // sentence says so, but naming the years alone ("年份：2022、2021") never
  // says *which* country carries which year. Group every row's own
  // resolved display name by its own reference period here (from the rows
  // themselves, never hand-typed) so the sentence built below from this map
  // can name the majority year as the default and call the rest out by
  // name, e.g. "数据为 2022 年；毛里塔尼亚、乍得为 2021 年".
  const periodGroups = new Map();
  if (spec.reference_period_field) {
    for (const item of joined) {
      const raw = item.row[spec.reference_period_field];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const period = String(raw).trim();
      const name = resolveEconomyDisplayName(item.raw, spec.category_names, lang);
      if (!periodGroups.has(period)) periodGroups.set(period, []);
      periodGroups.get(period).push(name);
    }
  }

  // A region whose largest piece projects below TINY_REGION_PX on both sides
  // is invisible as a polygon; it is also drawn as a value-coloured dot at the
  // centre of that piece, and its label/leader anchors on the dot (an
  // archipelago's label point can sit in open sea between its islands).
  const TINY_REGION_PX = mobile ? 5 : 6;
  const tinyRegionDot = (featureIndices, projectFn, lonC, latC, limit = TINY_REGION_PX) => {
    let best = null;
    for (const idx of featureIndices) {
      for (const ring of geometryRings(neFeatureGeometry(idx))) {
        if (!ringWithinHorizon(ring, lonC, latC)) continue;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [lo, la] of ring) {
          const q = projectFn(lo, la);
          if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
        }
        const size = Math.max(x1 - x0, y1 - y0);
        if (!best || size > best.size) best = { size, x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      }
    }
    return best && best.size < limit ? best : null;
  };
  const tinyDots = new Map();
  for (const item of joined) {
    const dot = tinyRegionDot(item.featureIndices, project, lon0, horizonLat0);
    if (dot) tinyDots.set(item.iso3, dot);
  }
  // World mode: only the range ends and highlight_values carry text (at most 8); every other economy is colour only.
  const worldLabelled = worldMode ? worldLabelIso3s(joined, spec) : null;
  const labelItemsAll = joined.filter((item) => !insetIso3Set.has(item.iso3) && (!worldLabelled || worldLabelled.has(item.iso3))).map((item) => {
    const idx = item.featureIndices[0];
    const point = neFeatureAttributes(idx)?.label ?? [lon0, lat0];
    const p = tinyDots.get(item.iso3) ?? project(point[0], point[1]);
    const value = n(item.row[spec.value_field]) ?? 0;
    const name = resolveEconomyDisplayName(item.raw, spec.category_names, lang);
    const valueText = choroplethValueText(value, spec.unit, spec);
    const w = Math.max(choroplethLabelWidth(name, font), choroplethLabelWidth(valueText, font));
    return { item, x: p.x, y: p.y, fill: colorForValue(value), name, valueText, w, h: lineH * 2 + 6 };
  });

  // Review fix (map extent / leader length): every label is tried on its own
  // feature first; one that collides, leaves the map, or spills onto a
  // neighbour (widened pointOnFeature sampling below - left/centre/right x
  // at both text-line y's, not just the centre column, so a box overlapping
  // a neighbour's polygon is actually caught) falls back to the *nearest*
  // empty slot within MAX_LEADER_PX, found by an expanding-radius spiral
  // search rather than a fixed side gutter - so no leader is ever longer
  // than the render-QA gate allows. A region that still cannot find a slot
  // within that radius is force-added to the zoom inset (even when the
  // caller never opted into spec.inset) and the whole layout is retried,
  // since removing it can free room for others - the same "retry until
  // stable" shape the old forcedToMargin loop used, generalized past a
  // single fixed destination.
  // Review fix (border-straddling labels): require a real 4px padding
  // margin around the label box, not a shrunk -2px one - the old margin let
  // a label pass this check while its own edge still sat right on a shared
  // border (Congo-Brazzaville's "71.4%" on the DRC boundary), because -2px
  // is stricter than the polygon's true edge, not the box's own true edge
  // plus clearance.
  const LABEL_FEATURE_PADDING = 4;
  // Review fix (border-straddling labels, CJK glyph ascent): the flat 4px
  // above only covers a small extra clearance beyond the label's own
  // already-measured footprint (halfW already includes the text's real
  // rendered width) - it has no equivalent "real size" term on the vertical
  // side, where nameY/valueY are bare point offsets from centre. A CJK
  // glyph's own ink reaches up to ~0.9x the font size above its baseline
  // (far more than a Latin x-height), so a name line whose baseline the 4px
  // margin found safely inside a polygon can still visibly run its own
  // characters across a border just above it (Liberia's "利比里亚" against
  // the Guinea boundary in the west-Africa inset). Padding the vertical
  // check by the font size itself, not a fixed 4px, clears that ascent and
  // sends a placement this cramped to the same leader-lined fallback a
  // too-small feature already uses instead - it does not change lineH, the
  // box used for collision/leader-length/column math, or anything rendered.
  const LABEL_VERTICAL_PADDING = font;

  // Review fix (containment - "Guinea clearly fits"): a single fixed anchor
  // point (a feature's own sidecar label point, or a bbox centre) can fail
  // this containment test on a feature with plenty of room, whenever that
  // one point happens to sit in a concave notch of an irregular, non-convex
  // shape (Guinea's own crescent around Guinea-Bissau/Sierra Leone is
  // exactly this - its bbox centre is not guaranteed to lie inside it at
  // all). findLabelAnchor tries the caller's preferred point first (so a
  // feature whose default point already works keeps its old placement,
  // unchanged from before this fix), then falls back to a coarse interior
  // grid search (a cheap stand-in for a true "pole of inaccessibility"/
  // polylabel search) and accepts the fit closest to the feature's own bbox
  // centre - a label "fits" the moment ANY candidate's padded box lies
  // inside the polygon, not just the one default point. `obstacleBoxes` lets
  // a caller also reject a candidate that would collide with labels already
  // placed elsewhere on the same map (main map only; the inset does not
  // cross-check between its own on-polygon labels, matching its prior
  // behaviour).
  // v7 fix (Liberia's inset label search): distance from a point to the
  // nearest edge of a feature's own boundary rings - the building block for
  // scoring "how interior" a candidate label point really is, below.
  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function interiorMargin(featureIndices, x, y, projectFn, lonC, latC) {
    let best = Infinity;
    for (const idx of featureIndices) {
      for (const pts of projectedFeatureRings(idx, projectFn, lonC, latC)) {
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[i], b = pts[j];
          if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
          const d = distToSegment(x, y, a.x, a.y, b.x, b.y);
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
  function findLabelAnchor(idx0, featureIndices, w, projectFn, lonC, latC, preferredX, preferredY, obstacleBoxes = []) {
    const boxH = lineH * 2 + 6;
    function boxAt(cx, cy) {
      return { x: cx - w / 2, y: cy - lineH - 2, w, h: boxH };
    }
    function fits(cx, cy) {
      const halfW = w / 2 + LABEL_FEATURE_PADDING;
      const nameY = cy - labelLineDy - LABEL_VERTICAL_PADDING;
      const valueY = cy + labelLineDy + LABEL_VERTICAL_PADDING;
      for (const dx of [-halfW, 0, halfW]) {
        for (const y of [nameY, valueY]) {
          if (!pointOnFeature(idx0, cx + dx, y, projectFn, lonC, latC)) return false;
        }
      }
      return true;
    }
    function ok(cx, cy) {
      return fits(cx, cy) && !obstacleBoxes.some((b) => boxesOverlap(boxAt(cx, cy), b));
    }
    if (Number.isFinite(preferredX) && Number.isFinite(preferredY) && ok(preferredX, preferredY)) {
      return { x: preferredX, y: preferredY };
    }
    const bbox = projectedFeatureBBox(featureIndices, projectFn);
    if (!bbox) return null;
    // The valid placement region can be a narrow band (irregular coastlines,
    // borders that pinch the interior) that's easy for a coarse grid to step
    // over entirely even though a fit genuinely exists nearby. Scale the grid
    // resolution to the label's own footprint so the sampling pitch is always
    // finer than the box we're trying to fit, instead of a fixed step count
    // that only worked for roughly rectangular countries.
    const halfWForSteps = w / 2 + LABEL_FEATURE_PADDING;
    const stepsX = Math.min(60, Math.max(8, Math.ceil((bbox.maxX - bbox.minX) / Math.max(3, halfWForSteps / 6))));
    const stepsY = Math.min(60, Math.max(8, Math.ceil((bbox.maxY - bbox.minY) / Math.max(3, boxH / 6))));
    const cx0 = (bbox.minX + bbox.maxX) / 2;
    const cy0 = (bbox.minY + bbox.maxY) / 2;
    let best = null;
    let bestMargin = -Infinity;
    let bestDist = Infinity;
    for (let i = 0; i <= stepsX; i++) {
      for (let j = 0; j <= stepsY; j++) {
        const cx = bbox.minX + ((bbox.maxX - bbox.minX) * i) / stepsX;
        const cy = bbox.minY + ((bbox.maxY - bbox.minY) * j) / stepsY;
        if (!pointOnFeature(idx0, cx, cy, projectFn, lonC, latC)) continue;
        if (!ok(cx, cy)) continue;
        // v7 fix (Liberia's inset label - "search the interior more
        // thoroughly... from the pole of inaccessibility outward"): the old
        // tiebreak (closest to the bbox centre) is a poor proxy for "safely
        // interior" on an irregular coastline, where the centre itself can
        // sit near a border pinch even when a genuinely roomier point exists
        // nearby. Score every valid grid candidate by its own distance to the
        // feature's nearest boundary edge instead - a cheap stand-in for a
        // true polylabel search - and keep the one with the most clearance on
        // every side; only tie (rare - typically a perfectly symmetric shape)
        // falls back to the old distance-to-centre rule.
        const dist = (cx - cx0) ** 2 + (cy - cy0) ** 2;
        const margin = interiorMargin(featureIndices, cx, cy, projectFn, lonC, latC);
        if (margin > bestMargin + 1e-6 || (Math.abs(margin - bestMargin) <= 1e-6 && dist < bestDist)) {
          bestMargin = margin;
          bestDist = dist;
          best = { x: cx, y: cy };
        }
      }
    }
    return best;
  }

  // Review fix (leaders must not cross other polygons/leaders): standard
  // segment-segment orientation test, and a "does this segment cross this
  // feature's own boundary" check built on it - shared by both the main
  // map's and the zoom inset's overflow search so a leader is only ever
  // accepted when it visibly connects its own label to its own region,
  // rather than appearing to point at whatever it happens to cross.
  function segmentsIntersect(p1, p2, p3, p4) {
    function cross(o, a, b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    }
    const d1 = cross(p3, p4, p1);
    const d2 = cross(p3, p4, p2);
    const d3 = cross(p1, p2, p3);
    const d4 = cross(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function segmentCrossesFeature(idx, p1, p2, projectFn, lonC, latC) {
    for (const pts of projectedFeatureRings(idx, projectFn, lonC, latC)) {
      const bb = pts.bb;
      if (Math.max(p1.x, p2.x) < bb.minX || Math.min(p1.x, p2.x) > bb.maxX || Math.max(p1.y, p2.y) < bb.minY || Math.min(p1.y, p2.y) > bb.maxY) continue;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
        if (segmentsIntersect(p1, p2, a, b)) return true;
      }
    }
    return false;
  }
  function segmentCrossesBox(p1, p2, box) {
    const inside = (p) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
    if (inside(p1) || inside(p2)) return true;
    const corners = [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
      { x: box.x, y: box.y + box.h },
    ];
    for (let i = 0; i < 4; i++) {
      if (segmentsIntersect(p1, p2, corners[i], corners[(i + 1) % 4])) return true;
    }
    return false;
  }
  // Two axis-aligned label boxes overlap iff they overlap on both axes -
  // the standard rectangle-intersection test (touching edges, where one
  // box's far side exactly equals the other's near side, count as clear).
  function boxesOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function leaderIsClear(p1, p2, ownIdx, otherIndices, acceptedLeaders, projectFn, lonC, latC, acceptedBoxes = [], ownBox = null) {
    for (const idx of otherIndices) {
      if (idx === ownIdx) continue;
      if (segmentCrossesFeature(idx, p1, p2, projectFn, lonC, latC)) return false;
    }
    for (const leader of acceptedLeaders) {
      if (segmentsIntersect(p1, p2, leader.a, leader.b)) return false;
      // A label may not sit on a leader accepted earlier either: boxes were
      // only ever tested against earlier boxes, so a later label could land
      // on top of another region's leader line.
      if (ownBox && segmentCrossesBox(leader.a, leader.b, ownBox)) return false;
    }
    for (const box of acceptedBoxes) {
      if (segmentCrossesBox(p1, p2, box)) return false;
      // Review fix (mobile text_overlap regression, Nigeria/Liberia): the
      // segment-crosses-box check above only catches a leader whose LINE
      // cuts through another label's box - it says nothing about whether
      // THIS candidate's own two-line text box lands on top of that other
      // box while its leader approaches from an angle that never crosses it.
      // That gap was latent (every existing fixture happened to avoid it)
      // until the stricter mobile containment check below started sending
      // more items through this same overflow path at once. ownBox is
      // optional so a caller that only wants the pre-existing leader-vs-box
      // behaviour (none currently do, but future ones might) still can.
      if (ownBox && boxesOverlap(ownBox, box)) return false;
    }
    return true;
  }

  // Numbered-marker placement (dense small regions). Markers go in order, each
  // at its own centroid if that is clear, otherwise at the nearest clear spot
  // on growing rings around it (fixed radii and angles, so the result never
  // varies): clear of every placed marker, every label box, every leader
  // segment and every rect (e.g. the inset panel), and inside the bounds. A
  // marker with no clear spot keeps the position that breaks the fewest rules
  // and the numbered list under the chart still names it.
  function placeNumberedMarkers(points, { bounds, boxes = [], segments = [], dots = [], radius = 9, nearDotTolerance = 0 } = {}) {
    const R = radius;
    const keepOut = R + 1;
    const segDist = (q, a, b) => {
      const vx = b.x - a.x, vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      const t = len2 ? Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / len2)) : 0;
      return Math.hypot(q.x - (a.x + t * vx), q.y - (a.y + t * vy));
    };
    const clampToBounds = (q) => (bounds
      ? { x: Math.min(bounds.x + bounds.w - R, Math.max(bounds.x + R, q.x)), y: Math.min(bounds.y + bounds.h - R, Math.max(bounds.y + R, q.y)) }
      : q);
    // A region's own data dot may sit under its marker only when the marker
    // is concentric with it (the default, unmoved placement).
    const violations = (q, placed, origin) => {
      let v = 0;
      for (const d of dots) {
        if (q.x === origin.x && q.y === origin.y && Math.hypot(d.x - origin.x, d.y - origin.y) < 1) continue;
        if (Math.hypot(q.x - d.x, q.y - d.y) < R + (d.r ?? 3.5) + 1) v++;
      }
      for (const o of placed) if (Math.hypot(q.x - o.x, q.y - o.y) < 2 * R + 2) v++;
      for (const b of boxes) if (q.x > b.x - keepOut && q.x < b.x + b.w + keepOut && q.y > b.y - keepOut && q.y < b.y + b.h + keepOut) v++;
      for (const sg of segments) if (segDist(q, sg.a, sg.b) < R + 2) v++;
      for (const t of tethers) if (segDist(q, t.a, t.b) < R + 1) v++;
      return v;
    };
    const placed = [];
    const out = [];
    const tethers = [];
    const RADII = [0, ...Array.from({ length: 25 }, (_, i) => 8 + i * 8)];
    const ANGLES = 24;
    const inBounds = (q) => !bounds || (q.x >= bounds.x + R && q.x <= bounds.x + bounds.w - R && q.y >= bounds.y + R && q.y <= bounds.y + bounds.h - R);
    // A marker whose circle no longer covers its true point keeps a visible
    // tether back to it (see MARKER_TETHER below); the tether, like the
    // marker, must stay clear of labels, other markers, dots and leaders.
    const tetherViolations = (q, pt, ownIndex) => {
      if (Math.hypot(q.x - pt.x, q.y - pt.y) <= R) return 0;
      const a = pt, b = markerTetherStart(q, pt, R);
      let v = 0;
      for (const bx of boxes) if (segmentCrossesBox(a, b, bx)) v++;
      for (const sg of segments) if (segmentsIntersect(a, b, sg.a, sg.b)) v++;
      placed.forEach((o, i) => { if (i !== ownIndex && segDist(o, a, b) < R + 1) v++; });
      // nearDotTolerance (world mode only): a dot this close to the true point is part of the same cluster, so its tether may graze it.
      for (const d of dots) if (Math.hypot(d.x - pt.x, d.y - pt.y) >= Math.max(1, nearDotTolerance) && segDist(d, a, b) < (d.r ?? 3.5) + 1) v++;
      for (const t of tethers) if (segmentsIntersect(a, b, t.a, t.b)) v++;
      return v;
    };
    for (const pt of points) {
      const origin = clampToBounds(pt);
      let best = { q: origin, v: Infinity };
      search:
      for (const r of RADII) {
        for (let k = 0; k < (r === 0 ? 1 : ANGLES); k++) {
          const ang = (k / ANGLES) * Math.PI * 2;
          const q = { x: origin.x + Math.cos(ang) * r, y: origin.y + Math.sin(ang) * r };
          if (!inBounds(q)) continue;
          const v = violations(q, placed, origin) * 100 + tetherViolations(q, pt, -1);
          if (v === 0) { best = { q, v }; break search; }
          if (v < best.v) best = { q, v };
        }
      }
      const displaced = Math.hypot(best.q.x - pt.x, best.q.y - pt.y) > R;
      // No clean spot that also keeps a clean tether: the region stays in the
      // numbered list only (null = no map marker, so nothing claims a position).
      if (best.v > 0) { out.push(null); continue; }
      placed.push(best.q);
      out.push(best.q);
      if (displaced) tethers.push({ a: pt, b: markerTetherStart(best.q, pt, R) });
    }
    return out;
  }
  // Where a tether leaves a displaced marker: on its circle, towards the true point.
  function markerTetherStart(marker, point, radius = 9) {
    const d = Math.hypot(point.x - marker.x, point.y - marker.y) || 1;
    return { x: marker.x + ((point.x - marker.x) / d) * radius, y: marker.y + ((point.y - marker.y) / d) * radius };
  }
  // A displaced numbered marker (its circle no longer covers its true point)
  // is joined back to that point by a hairline in the same leader style, so a
  // reader can tell which place the number stands for. render-QA rule
  // marker_displaced_without_tether fails any displaced marker without one.
  function markerTetherSvg(role, marker, point, iso3, num, radius = 9) {
    if (Math.hypot(marker.x - point.x, marker.y - point.y) <= radius) return "";
    const a = markerTetherStart(marker, point, radius);
    return `<path data-role="${role}-leader" data-iso3="${esc(iso3)}" data-number="${num}" d="M${a.x.toFixed(1)},${a.y.toFixed(1)} L${point.x.toFixed(1)},${point.y.toFixed(1)}" fill="none" stroke="${LEADER_STYLE.color}" stroke-width="${LEADER_STYLE.width}"/>`
      + `<circle data-role="${role}-leader-dot" data-iso3="${esc(iso3)}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="1" fill="${LEADER_STYLE.color}"/>`;
  }

  // Coordinator research (scratchpad/reports/research-leaders.md): every
  // leader on the map - main-map overflow, inset overflow, and the
  // zoom-inset connector - uses exactly one shape, kept in this one small
  // function so a later geometry refinement only touches one place. The
  // shape is octilinear (Bekos et al., "Boundary Labeling with Octilinear
  // Leaders"): a single 45 degree-or-vertical segment from the anchor,
  // followed by a horizontal run into the label/target - never an arbitrary
  // diagonal, never a curve. bend.y is pinned to tip.y (the whole vertical
  // delta is spent on the first segment) because the second segment is
  // horizontal-only by construction; the horizontal delta on the first
  // segment is capped at |dy| so it never exceeds a true 45 degrees, and
  // drops to a pure vertical first leg when there isn't even that much
  // horizontal room.
  // Live-bound to PALETTE.context, the role every other de-emphasized
  // connector/edge mark in this file already uses (network edges, flow
  // links, tree connectors, timeline stems), so a leader stays "one of the
  // grey marks" under both the legacy and house palettes instead of a
  // frozen literal.
  const LEADER_STYLE = { width: 1, color: PALETTE.context };
  // Review fix (leader running into the label chip): a leader used to end
  // exactly on the text box's own edge, so at render scale the line visibly
  // passed under/through the first character. Every rendered leader now
  // stops this many px short of the box edge it targets - still clearly
  // pointing at the label without ever crossing into its text.
  const LEADER_GAP_PX = 4;
  function elbowBend(anchor, tip) {
    const dx = tip.x - anchor.x;
    const dy = tip.y - anchor.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: anchor.x + Math.sign(dx || 1) * Math.abs(dy), y: tip.y };
    return { x: anchor.x, y: tip.y };
  }
  function elbowLeaderPath(anchor, tip) {
    const bend = elbowBend(anchor, tip);
    return `M${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} L${bend.x.toFixed(1)},${bend.y.toFixed(1)} L${tip.x.toFixed(1)},${tip.y.toFixed(1)}`;
  }
  function leaderSvg(dataRole, anchor, tip, extraAttrs = "") {
    return `<path data-role="${dataRole}" d="${elbowLeaderPath(anchor, tip)}" fill="none" stroke="${LEADER_STYLE.color}" stroke-width="${LEADER_STYLE.width}"${extraAttrs}/>`;
  }
  function anchorDotSvg(dataRole, anchor) {
    return `<circle data-role="${dataRole}" cx="${anchor.x.toFixed(1)}" cy="${anchor.y.toFixed(1)}" r="1" fill="${LEADER_STYLE.color}"/>`;
  }
  // The point on the label box's (gap-padded) outline nearest the anchor, so a
  // leader always ends on the edge facing its own point instead of running to
  // a fixed side and back across the text it labels.
  function nearestBoxEdgeTip(anchor, box) {
    const g = LEADER_GAP_PX;
    const x0 = box.x - g, x1 = box.x + box.w + g, y0 = box.y - g, y1 = box.y + box.h + g;
    const inside = anchor.x > x0 && anchor.x < x1 && anchor.y > y0 && anchor.y < y1;
    if (!inside) return { x: Math.min(x1, Math.max(x0, anchor.x)), y: Math.min(y1, Math.max(y0, anchor.y)) };
    const d = [anchor.x - x0, x1 - anchor.x, anchor.y - y0, y1 - anchor.y];
    const m = Math.min(...d);
    if (m === d[0]) return { x: x0, y: anchor.y };
    if (m === d[1]) return { x: x1, y: anchor.y };
    if (m === d[2]) return { x: anchor.x, y: y0 };
    return { x: anchor.x, y: y1 };
  }
  function elbowSegments(anchor, tip) {
    const bend = elbowBend(anchor, tip);
    return [[anchor, bend], [bend, tip]];
  }
  function elbowLength(anchor, tip) {
    const bend = elbowBend(anchor, tip);
    return Math.hypot(bend.x - anchor.x, bend.y - anchor.y) + Math.hypot(tip.x - bend.x, tip.y - bend.y);
  }

  // Review fix (border-straddling overflow direction): a leader that must
  // leave its own feature goes to whichever side (left/right half of the
  // map) its own anchor already sits on, so it always travels the short way
  // out rather than crossing back over the map.
  const mapCenterX = (mapLeft + mapRight) / 2;
  // P4: main-map name/value labels must stay in the main-map panel. When an
  // inset column sits to the left of the map (mapLeft > plotLeft) a left-hand
  // boundary label may not run into it; otherwise the canvas edge is the bound.
  // Every main-map label carries this box as data-panel-box so render QA can
  // prove it (text_outside_panel) instead of only comparing to the viewBox.
  const labelLeftBound = mapLeft > plotLeft ? mapLeft : 0;
  const mainPanelAttr = ` data-panel-box="${labelLeftBound.toFixed(1)},${top.toFixed(1)},${width.toFixed(1)},${bottom.toFixed(1)}"`;
  const mapCenterY = (top + bottom) / 2;
  const allDataFeatureIdxFlat = joined.flatMap((item) => item.featureIndices);

  // Deterministic, crossing-free boundary-labeling layout (task: leader
  // research, "one-sided boundary-labeling model"): every label that must
  // leave its own polygon on one side of the map is stacked in a single
  // column at that side's inner edge, in the same order as its anchor's own
  // y - because label order along the column matches anchor order, the
  // elbow leaders this produces are provably non-crossing (Bekos et al.),
  // which is exactly why this replaced the old per-label radius/angle spiral
  // search (that search could and did accept slots whose leaders crossed
  // each other in awkward configurations). `maxLeaderLen` demotes anything
  // that would need a longer leader than ~3x a label's own text height to
  // the caller's numbered-footnote fallback instead of stretching the column
  // past a legible length.
  function layoutBoundaryColumn(items, side, columnX, rangeTop, rangeBottom, maxLeaderLen) {
    if (!items.length) return { placed: [], overflow: [] };
    const sorted = [...items].sort((a, b) => a.y - b.y);
    const pitch = Math.max(...sorted.map((li) => li.h + 4));
    const n = sorted.length;
    // Classic minimal-displacement label ladder: start every row at its own
    // anchor's natural y (keeping the leader's vertical leg - and so its
    // total length - as short as the length cap allows), push a row down
    // only far enough to keep `pitch` clear of the one above it, then (if the
    // whole ladder overruns the bottom) compact backward from the bottom and
    // re-clamp the top - each pass keeps rows in the same sorted order, so
    // the column never needs to swap two rows to fit, which is exactly what
    // keeps the elbow leaders non-crossing (Bekos et al.'s order-preserving
    // property; a version of this that instead centred the whole stack
    // could displace an anchor near the map's own top/bottom edge by half
    // the map's height even when its neighbours were untouched, which blew
    // straight through the leader-length cap for a continent-wide map).
    const cy = sorted.map((li) => li.y);
    for (let i = 1; i < n; i++) cy[i] = Math.max(cy[i], cy[i - 1] + pitch);
    const bottomLimit = rangeBottom - pitch / 2;
    if (cy[n - 1] > bottomLimit) {
      cy[n - 1] = bottomLimit;
      for (let i = n - 2; i >= 0; i--) cy[i] = Math.min(cy[i], cy[i + 1] - pitch);
    }
    const topLimit = rangeTop + pitch / 2;
    if (cy[0] < topLimit) {
      cy[0] = topLimit;
      for (let i = 1; i < n; i++) cy[i] = Math.max(cy[i], cy[i - 1] + pitch);
    }
    const placed = [];
    const overflow = [];
    sorted.forEach((li, i) => {
      const boxTop = cy[i] - lineH - 2;
      const box = side === "right" ? { x: columnX, y: boxTop, w: li.w, h: li.h } : { x: columnX - li.w, y: boxTop, w: li.w, h: li.h };
      const anchor = { x: li.x, y: li.y };
      // Stop the leader LEADER_GAP_PX short of the box's own near edge
      // (never used for placement/collision math below, which still keys
      // off the true box/columnX so the column ladder itself is unaffected)
      // rather than terminating exactly on it.
      const tip = { x: side === "right" ? columnX - LEADER_GAP_PX : columnX + LEADER_GAP_PX, y: cy[i] };
      const fitsRange = boxTop >= rangeTop - 1 && boxTop + li.h <= rangeBottom + 1;
      const fitsLength = elbowLength(anchor, tip) <= maxLeaderLen;
      if (fitsRange && fitsLength) {
        placed.push({ li, box, anchor, tip, side });
      } else {
        overflow.push(li);
      }
    });
    return { placed, overflow };
  }

  const MAX_OVERFLOW_LEADER_PX = (lineH * 2 + 6) * 3;
  // v7 fix (leader research follow-up, "Liberia in the inset is not
  // acceptable yet"): layoutBoundaryColumn places every item in its column
  // purely from label widths - it has no idea where the actual polygons are
  // - so a country whose own natural anchor already sits close to the
  // column's edge could be "placed" with a leader too short to read, landing
  // a box that still overlaps a data polygon (its own included; nothing
  // upstream ever checked a leadered box against its OWN feature, only
  // against other labels' boxes and other features' line-crossings). Two
  // hard requirements, checked at every acceptance site below: the box must
  // not overlap ANY data polygon, and the leader's drawn length must be at
  // least this many px. `extendEntryOutward` is the remedy, not just the
  // detector - nudging a rejected entry further along its own column's
  // outward direction (same row, same octilinear shape) can only ever
  // lengthen its own leader and move its box away from the cluster, so it
  // never reorders it past a column neighbour or reopens a crossing that
  // column construction already ruled out.
  const MIN_LEADER_DRAWN_LENGTH = 10;
  function boxOverlapsFeature(featureIndices, box, projectFn, lonC, latC) {
    for (const idx of featureIndices) {
      for (const pts of projectedFeatureRings(idx, projectFn, lonC, latC)) {
        const bb = pts.bb;
        if (box.x + box.w < bb.minX || box.x > bb.maxX || box.y + box.h < bb.minY || box.y > bb.maxY) continue;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[i], b = pts[j];
          if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
          if (segmentCrossesBox(a, b, box)) return true;
        }
      }
      // No ring edge crosses the box - it could still sit fully inside the
      // polygon (e.g. a large country's box entirely within its own
      // coastline); its centre point resolves that case.
      if (pointOnFeature(idx, box.x + box.w / 2, box.y + box.h / 2, projectFn, lonC, latC)) return true;
    }
    return false;
  }
  function extendEntryOutward(entry, side, delta) {
    const dir = side === "right" ? 1 : -1;
    return {
      ...entry,
      box: { ...entry.box, x: entry.box.x + dir * delta },
      tip: { x: entry.tip.x + dir * delta, y: entry.tip.y },
    };
  }
  // v7 fix: an item's own preferred point can sit close enough to centre
  // that its assigned side's column has no open run before the map/panel's
  // own edge (Liberia's bbox straddles the inset's centre line, and the
  // "right" side it was assigned happens to be the side pinched by the
  // panel's own border) - the same box/tip construction layoutBoundaryColumn
  // itself uses, rebuilt at the *other* side's column so the outward-nudge
  // retry above gets a second, genuinely different direction to try before
  // giving up to the numbered-marker tier.
  function flipEntrySide(entry, altSide, altColumnX) {
    const w = entry.box.w;
    const box = altSide === "right" ? { x: altColumnX, y: entry.box.y, w, h: entry.box.h } : { x: altColumnX - w, y: entry.box.y, w, h: entry.box.h };
    const tip = { x: altSide === "right" ? altColumnX - LEADER_GAP_PX : altColumnX + LEADER_GAP_PX, y: entry.tip.y };
    return { ...entry, box, tip, side: altSide };
  }
  const forcedInsetIso3 = new Set();
  const footnoteIso3 = new Set();
  let onMap = [];
  let placedOverflow = [];
  for (let pass = 0; pass <= labelItemsAll.length; pass++) {
    const activeItems = labelItemsAll.filter((li) => !forcedInsetIso3.has(li.item.iso3) && !footnoteIso3.has(li.item.iso3));
    onMap = [];
    const overflowCandidates = [];
    for (const li of activeItems) {
      const idx0 = li.item.featureIndices[0];
      const anchor = findLabelAnchor(idx0, li.item.featureIndices, li.w, project, lon0, horizonLat0, li.x, li.y, onMap.map((p) => p.box));
      if (anchor) {
        const box = { x: anchor.x - li.w / 2, y: anchor.y - lineH - 2, w: li.w, h: li.h };
        const insideMap = box.x >= mapLeft && box.x + box.w <= mapRight && box.y >= top && box.y + box.h <= bottom;
        if (insideMap) {
          onMap.push({ li, box, cx: anchor.x, cy: anchor.y });
          continue;
        }
      }
      overflowCandidates.push(li);
    }
    const leftItems = overflowCandidates.filter((li) => li.x < mapCenterX);
    const rightItems = overflowCandidates.filter((li) => li.x >= mapCenterX);
    // Review fix (leader length cap vs. a continent-wide map): the column
    // sits just outside its own cluster of overflow anchors - not at the
    // map's own outer edge - so the leader stays short (well inside the
    // ~3x-text-height cap below) rather than crossing the whole continent's
    // width/height of other countries' land to reach a fixed page margin. A
    // single shared column per side still preserves the boundary-labeling
    // non-crossing guarantee (order-preserving stack), it is just placed
    // adjacent to the data that actually needs it.
    const columnGap = 26;
    // Review fix (labels running off the canvas edge): the column used to be
    // positioned purely from the overflow anchors' own x - never checked
    // against how wide the labels stacked in it actually are - so a column
    // pinned near the map's own edge could still push a wide label's box
    // past x=0 (or past the canvas's right edge) once its own text width was
    // subtracted/added. Widen each side's floor/ceiling by that side's own
    // widest overflow label so every box this column produces stays on the
    // canvas, whatever anchors happen to be clustered there.
    const leftMaxW = leftItems.length ? Math.max(...leftItems.map((li) => li.w)) : 0;
    const rightMaxW = rightItems.length ? Math.max(...rightItems.map((li) => li.w)) : 0;
    const leftColumnX = leftItems.length ? Math.max(mapLeft + 4, labelLeftBound + leftMaxW + 4, Math.min(...leftItems.map((li) => li.x)) - columnGap) : mapLeft + 4;
    const rightColumnX = rightItems.length ? Math.min(mapRight - 4, width - rightMaxW - 4, Math.max(...rightItems.map((li) => li.x)) + columnGap) : mapRight - 4;
    const leftLayout = layoutBoundaryColumn(leftItems, "left", leftColumnX, top + 4, bottom - 4, MAX_OVERFLOW_LEADER_PX);
    const rightLayout = layoutBoundaryColumn(rightItems, "right", rightColumnX, top + 4, bottom - 4, MAX_OVERFLOW_LEADER_PX);
    // Validate each candidate leader against the data polygons and every
    // other accepted leader (both its segments) - the column construction
    // guarantees non-crossing between items placed in the *same* column, but
    // this still confirms it empirically (belt-and-braces) and catches the
    // rarer case of a leader clipping a neighbouring polygon's own coastline.
    const acceptedLeaders = [];
    // World mode: the many unlabelled tiny-country dots are obstacles too, so a leader label never lands on one.
    const worldDotBoxes = worldMode ? [...tinyDots.entries()].filter(([iso3]) => !worldLabelled.has(iso3)).map(([, d]) => ({ x: d.x - 4, y: d.y - 4, w: 8, h: 8 })) : [];
    const acceptedBoxes = [...onMap.map((p) => p.box), ...worldDotBoxes];
    let allPlaced = true;
    placedOverflow = [];
    // Numbering is the last resort: before it, look for any open spot on the
    // map near the region where its label fits, and run a short leader to it.
    // Candidate boxes sit on rings around the anchor (16 directions, growing
    // distance), shortest leader first; each must lie inside the map frame,
    // clear every data region and every accepted label, and its leader must
    // cross nothing (same checks as the boundary column).
    const tryFreeSpot = (li) => {
      const idx0 = li.item.featureIndices[0];
      const anchor = { x: li.x, y: li.y };
      const cands = [];
      for (let dist = 14; dist <= MAX_OVERFLOW_LEADER_PX; dist += 10) {
        for (let k = 0; k < 16; k++) {
          const ang = (k / 16) * Math.PI * 2;
          const px = li.x + Math.cos(ang) * dist, py = li.y + Math.sin(ang) * dist;
          const side = Math.cos(ang) >= 0 ? "right" : "left";
          const box = side === "right" ? { x: px, y: py - lineH - 2, w: li.w, h: li.h } : { x: px - li.w, y: py - lineH - 2, w: li.w, h: li.h };
          const tip = nearestBoxEdgeTip(anchor, box);
          if (box.x < mapLeft + 2 || box.x + box.w > mapRight - 2 || box.y < top + 2 || box.y + box.h > bottom - 2) continue;
          const len = elbowLength(anchor, tip);
          if (len > MAX_OVERFLOW_LEADER_PX || len < MIN_LEADER_DRAWN_LENGTH) continue;
          cands.push({ li, box, anchor, tip, side, len });
        }
      }
      cands.sort((u, v) => u.len - v.len);
      for (const cand of cands) {
        if (acceptedBoxes.some((b) => boxesOverlap(b, cand.box))) continue;
        if (boxOverlapsFeature(allDataFeatureIdxFlat, cand.box, project, lon0, horizonLat0)) continue;
        const segs = elbowSegments(cand.anchor, cand.tip);
        if (segs.every(([p1, p2]) => leaderIsClear(p1, p2, idx0, allDataFeatureIdxFlat, acceptedLeaders, project, lon0, horizonLat0, acceptedBoxes, cand.box))) return cand;
      }
      return null;
    };
    const acceptFree = (cand) => {
      placedOverflow.push(cand);
      for (const [p1, p2] of elbowSegments(cand.anchor, cand.tip)) acceptedLeaders.push({ a: p1, b: p2 });
      acceptedBoxes.push(cand.box);
    };
    for (const entry of [...leftLayout.placed, ...rightLayout.placed]) {
      const idx0 = entry.li.item.featureIndices[0];
      // v7 fix: try the column's own slot first (step 0, unchanged for every
      // item that already clears both hard requirements there), then nudge
      // outward until the box clears every data polygon and the leader reads
      // as a real leader, or the length cap is reached.
      let accepted = null;
      for (let step = 0; step <= 24 && !accepted; step++) {
        const cand = step === 0 ? entry : extendEntryOutward(entry, entry.side, step * 8);
        const len = elbowLength(cand.anchor, cand.tip);
        if (len > MAX_OVERFLOW_LEADER_PX) break;
        if (len < MIN_LEADER_DRAWN_LENGTH) continue;
        if (cand.box.x < labelLeftBound || cand.box.x + cand.box.w > width) break;
        if (boxOverlapsFeature(allDataFeatureIdxFlat, cand.box, project, lon0, horizonLat0)) continue;
        const segs = elbowSegments(cand.anchor, cand.tip);
        if (segs.every(([p1, p2]) => leaderIsClear(p1, p2, idx0, allDataFeatureIdxFlat, acceptedLeaders, project, lon0, horizonLat0, acceptedBoxes, cand.box))) accepted = cand;
      }
      if (accepted) {
        placedOverflow.push(accepted);
        for (const [p1, p2] of elbowSegments(accepted.anchor, accepted.tip)) acceptedLeaders.push({ a: p1, b: p2 });
        acceptedBoxes.push(accepted.box);
      } else {
        const free = tryFreeSpot(entry.li);
        if (free) { acceptFree(free); continue; }
        allPlaced = false;
        // Only demote into the zoom inset when one is actually configured
        // (spec.inset) - with no inset panel to receive it, forcing this
        // iso3 into forcedInsetIso3 would materialize a one-country inset
        // panel out of nowhere. Without an inset, fall back the same way an
        // over-length column entry already does: the numbered footnote list.
        if (insetSpec && !farFromInset(entry.li.item.iso3)) forcedInsetIso3.add(entry.li.item.iso3);
        else footnoteIso3.add(entry.li.item.iso3);
      }
    }
    for (const li of [...leftLayout.overflow, ...rightLayout.overflow]) {
      // Column ran out of vertical room, or reaching the *shared* column
      // would need a longer leader than the cap allows - which happens to
      // an overflow label whose own x sits well inside the map, far from
      // either side's column (built from the whole cluster's extent, not
      // this one label). Task (leader research): before falling all the way
      // back to a numbered marker, try one cheaper option first - a short
      // personal leader straight to this label's own west or east side
      // ("a leader into the Atlantic on the left" - west tried first - though
      // it's the leaderIsClear check below, not compass direction, that
      // actually decides it: a neighbouring no-data country, e.g., isn't in
      // allDataFeatureIdxFlat at all, so a leader is free to cross it the
      // way it's already free to cross open ocean). Reuses
      // layoutBoundaryColumn as a column-of-one so the box/tip/length-cap
      // geometry matches the shared column's own exactly, then the same
      // leaderIsClear check already used above (every other data feature,
      // every leader/box accepted so far this pass) - this can therefore
      // never accept a leader the shared column's own validation would have
      // rejected for crossing something.
      const personalAttempts = [
        { side: "left", columnX: Math.max(mapLeft + 4 + li.w, li.x - columnGap) },
        { side: "right", columnX: Math.min(mapRight - 4 - li.w, li.x + columnGap) },
      ];
      let personal = null;
      for (const { side, columnX } of personalAttempts) {
        const solo = layoutBoundaryColumn([li], side, columnX, top + 4, bottom - 4, MAX_OVERFLOW_LEADER_PX);
        if (!solo.placed.length) continue;
        const candidate = solo.placed[0];
        const idx0 = candidate.li.item.featureIndices[0];
        // v7 fix: same two hard requirements as the shared column above.
        if (elbowLength(candidate.anchor, candidate.tip) < MIN_LEADER_DRAWN_LENGTH) continue;
        if (boxOverlapsFeature(allDataFeatureIdxFlat, candidate.box, project, lon0, horizonLat0)) continue;
        const segs = elbowSegments(candidate.anchor, candidate.tip);
        if (segs.every(([p1, p2]) => leaderIsClear(p1, p2, idx0, allDataFeatureIdxFlat, acceptedLeaders, project, lon0, horizonLat0, acceptedBoxes, candidate.box))) {
          personal = candidate;
          break;
        }
      }
      if (personal) {
        placedOverflow.push(personal);
        for (const [p1, p2] of elbowSegments(personal.anchor, personal.tip)) acceptedLeaders.push({ a: p1, b: p2 });
        acceptedBoxes.push(personal.box);
        continue;
      }
      // Neither side worked - task: "fall back to numbered markers + a
      // footnote list, same as the line-chart" rather than stretch a leader
      // past a legible length or through another region's own polygon.
      const free = tryFreeSpot(li);
      if (free) { acceptFree(free); continue; }
      allPlaced = false;
      footnoteIso3.add(li.item.iso3);
    }
    if (allPlaced) break;
  }
  const footnoteItems = labelItemsAll.filter((li) => footnoteIso3.has(li.item.iso3));

  // Every part below is built as strings first and pushed to f.parts in one
  // block further down (clip defs, ocean, the inset's own source
  // outline/connector, land fills, legend, then these labels) so the
  // "strokes go behind data fills and text" house-style rule for the inset's
  // outline/connector (drawn before the land group) can hold without also
  // pulling the on-map/margin labels themselves earlier in source order.
  // Review fix (label style consistency): no halo, ever - text colour is
  // whichever of white/ink labelStyleOnFill picks as the higher-contrast
  // choice against whatever it actually sits on, exactly the same rule the
  // heatmap/sankey renderers already use. The ramp above was itself
  // validated so every class's fill clears the 4.5:1 floor with this pick
  // alone (see CHOROPLETH_RAMP's own comment), so dropping the halo never
  // reintroduces the low-contrast case the halo used to paper over.
  const onMapParts = [];
  for (const { li, cx, cy } of onMap) {
    const nameAnchorY = cy - labelLineDy;
    const valueAnchorY = cy + labelLineDy;
    const style = labelStyleOnFill(hexToRgb(li.fill));
    onMapParts.push(
      `<text data-role="choropleth-label" data-iso3="${esc(li.item.iso3)}"${mainPanelAttr} x="${cx.toFixed(1)}" y="${nameAnchorY.toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${style.fill}">${esc(li.name)}</text>`,
      `<text data-role="choropleth-label-value" data-iso3="${esc(li.item.iso3)}"${mainPanelAttr} x="${cx.toFixed(1)}" y="${valueAnchorY.toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${style.fill}">${esc(li.valueText)}</text>`
    );
  }

  // Overflow: one octilinear elbow leader (elbowLeaderPath, shared with the
  // inset and the inset connector) from a 2px dot on the feature's own label
  // point to its assigned slot in the boundary column, with the name/value
  // stacked in that slot's own box (right/left-anchored toward the column so
  // the horizontal run reads naturally into the text). Review fix (leader
  // research review): a chip here used to sit behind the two text lines, but
  // the light basemap it always lands on (open ocean or a neighbour's own
  // light land tint) already gives dark ink text plenty of contrast without
  // one - and the chip was part of why the leader read as if it ran into the
  // label rather than stopping short of it. A white paint-order halo (the
  // same >=2px "recognised halo pattern" render_qa_contrast.mjs already
  // checks for) stands in for the rare case the slot happens to land over a
  // saturated fill edge, without needing an opaque box at all.
  const OVERFLOW_LABEL_HALO = ` stroke="${PAPER}" stroke-width="3" stroke-linejoin="round" paint-order="stroke fill"`;
  const overflowParts = [];
  for (const { li, box, anchor, tip, side } of placedOverflow) {
    const textX = side === "right" ? box.x : box.x + box.w;
    const textAnchor = side === "right" ? "start" : "end";
    const nameY = box.y + lineH - 2;
    const valueY = box.y + box.h - 4;
    overflowParts.push(anchorDotSvg("choropleth-leader-dot", anchor));
    overflowParts.push(leaderSvg("choropleth-leader", anchor, tip, ` data-iso3="${esc(li.item.iso3)}"`));
    overflowParts.push(
      `<text data-role="choropleth-label" data-iso3="${esc(li.item.iso3)}"${mainPanelAttr} x="${textX.toFixed(1)}" y="${nameY.toFixed(1)}" text-anchor="${textAnchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${PALETTE.ink}"${OVERFLOW_LABEL_HALO}>${esc(li.name)}</text>`,
      `<text data-role="choropleth-label-value" data-iso3="${esc(li.item.iso3)}"${mainPanelAttr} x="${textX.toFixed(1)}" y="${valueY.toFixed(1)}" text-anchor="${textAnchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}"${OVERFLOW_LABEL_HALO}>${esc(li.valueText)}</text>`
    );
  }

  // Footnote fallback (task: leader research, "if a side lane runs out of
  // room... numbered markers + a footnote list, same as the line-chart
  // fallback"): a boundary column that ran out of vertical room, or whose
  // leader would exceed the ~3x-text-height cap, demotes its remaining
  // labels here instead of stretching a leader past a legible length. Each
  // gets a small numbered dot on its own polygon; the numbers are listed
  // once, in the same order, in a compact note under the map.
  //
  // Review fix (duplicate numbering): the inset can *also* demote a region
  // to a numbered marker (listFallbackItems, below) when even a boundary
  // column inside the mini map can't clear it. Both fallbacks used to number
  // themselves independently from 1, so "1" appeared twice - once on the
  // main map, once inside the inset - each pointing at a different list. The
  // actual numbering/list construction is deferred past the inset's own
  // placement pass (further down, once listFallbackItems is known) so a
  // single sequence and a single list below the chart can cover both.
  const footnoteParts = [];
  const footnoteRowH = mobile ? 13 : 14;

  // Finalize the inset set now that placement has forced in any region a
  // short leader could not rescue, then compute the items/feature indices
  // the zoom inset panel below actually draws.
  for (const iso3 of forcedInsetIso3) insetIso3Set.add(iso3);
  const insetItems = insetIso3Set.size ? joined.filter((item) => insetIso3Set.has(item.iso3)) : [];
  const insetFeatureIndices = insetItems.flatMap((item) => item.featureIndices);

  // Every label box now placed (on-map or overflow) - the obstacle set both
  // the locator inset (below) and the zoom inset (task: inset) score their
  // own corner placement against.
  const allLabelBoxes = [...onMap.map(({ box }) => box), ...placedOverflow.map(({ box }) => box)];

  // Candidate boxes of a given size within the plot rect (never the map's
  // own clipped land, so bottom-left/top-left land inside the same
  // land-free gutter the margin labels/locator already use) - shared helper
  // for both the zoom inset panel and the locator inset below, each scored
  // against its own obstacle set. The 4 corners are tried first (ties break
  // toward bottom-left, matching the approved spike's own hand-picked
  // "empty Atlantic corner"); when a panel is wide/tall enough that every
  // corner collides with some already-placed label (a real risk once both
  // the zoom inset and a dense on-map label layout compete for the same
  // narrow mobile gutter), a slide along each of the 4 edges is tried next,
  // so a genuinely empty spot beside a corner is still found rather than
  // silently accepting a corner that overlaps text - "no other land" is a
  // placement contract, not just a preference.
  const cornerPad = 8;
  // Corner/slide candidates live in the MAP rect (mapLeft..mapRight); with a
  // reserved inset column that excludes the column, which the locator must
  // not spill into either.
  function cornerBoxes(w, h) {
    const corners = [
      { key: "bottom-left", x: mapLeft + cornerPad, y: bottom - h - cornerPad },
      { key: "bottom-right", x: mapRight - w - cornerPad, y: bottom - h - cornerPad },
      { key: "top-left", x: mapLeft + cornerPad, y: top + cornerPad },
      { key: "top-right", x: mapRight - w - cornerPad, y: top + cornerPad },
    ];
    const steps = 8;
    const slides = [];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = mapLeft + cornerPad + (mapRight - w - cornerPad - (mapLeft + cornerPad)) * t;
      const y = top + cornerPad + (bottom - h - cornerPad - (top + cornerPad)) * t;
      slides.push({ key: `top-slide-${i}`, x, y: top + cornerPad });
      slides.push({ key: `bottom-slide-${i}`, x, y: bottom - h - cornerPad });
      slides.push({ key: `left-slide-${i}`, x: mapLeft + cornerPad, y });
      slides.push({ key: `right-slide-${i}`, x: mapRight - w - cornerPad, y });
    }
    return [...corners, ...slides];
  }
  // mustAvoid (review fix, mobile inset/locator collision): rectangles a
  // candidate corner is never allowed to overlap when at least one corner
  // can avoid them - unlike the soft `obstacles` list (scored by fewest
  // hits, so a crowded map can still "win" a corner that overlaps a label
  // or land), a panel already painted opaque on top (the zoom inset) must
  // not be covered by a later panel (the locator) as long as any corner
  // exists that doesn't collide with it; only when every corner collides
  // with a mustAvoid rect does this fall back to the plain fewest-hits
  // choice (better a faint overlap somewhere than no locator at all).
  function bestCorner(w, h, obstacles, mustAvoid = []) {
    const scored = cornerBoxes(w, h).map((c) => ({
      ...c,
      w,
      h,
      hits: obstacles.filter((b) => boxesOverlap({ x: c.x, y: c.y, w, h }, b)).length,
      hitsHard: mustAvoid.filter((b) => boxesOverlap({ x: c.x, y: c.y, w, h }, b)).length,
    }));
    const safe = scored.filter((c) => c.hitsHard === 0);
    const pool = safe.length ? safe : scored;
    return pool.slice().sort((a, b) => a.hits - b.hits)[0];
  }
  function rectCorners(r) {
    return [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
      { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h },
    ];
  }
  function nearestCornerDistance(rectA, rectB) {
    let best = Infinity;
    for (const a of rectCorners(rectA)) for (const b of rectCorners(rectB)) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
    return best;
  }
  // Review fix (inset placement): candidates immediately beside the source
  // bbox (west/east/north/south, 3 alignments each, a small gap) - tried
  // ahead of the plain corners so a short, obviously-related connector wins
  // over a long one to whichever corner happens to be emptiest.
  function sourceAdjacentBoxes(w, h, source) {
    const gap = 10;
    return [
      { key: "src-w-top", x: source.x - gap - w, y: source.y },
      { key: "src-w-mid", x: source.x - gap - w, y: source.y + source.h / 2 - h / 2 },
      { key: "src-w-bot", x: source.x - gap - w, y: source.y + source.h - h },
      { key: "src-e-top", x: source.x + source.w + gap, y: source.y },
      { key: "src-e-mid", x: source.x + source.w + gap, y: source.y + source.h / 2 - h / 2 },
      { key: "src-e-bot", x: source.x + source.w + gap, y: source.y + source.h - h },
      { key: "src-n-left", x: source.x, y: source.y - gap - h },
      { key: "src-n-mid", x: source.x + source.w / 2 - w / 2, y: source.y - gap - h },
      { key: "src-n-right", x: source.x + source.w - w, y: source.y - gap - h },
      { key: "src-s-left", x: source.x, y: source.y + source.h + gap },
      { key: "src-s-mid", x: source.x + source.w / 2 - w / 2, y: source.y + source.h + gap },
      { key: "src-s-right", x: source.x + source.w - w, y: source.y + source.h + gap },
    ];
  }
  // Best inset position: zero-collision candidates (source-adjacent first,
  // then the plain corners/edge-slides) scored by shortest connector to the
  // source bbox; when every candidate collides with land or a label, fall
  // back to the old "fewest hits, first found" rule (used unconditionally
  // by the locator, which has no source bbox to score distance against).
  function bestInsetPosition(w, h, obstacles, source) {
    const candidates = source ? [...sourceAdjacentBoxes(w, h, source), ...cornerBoxes(w, h)] : cornerBoxes(w, h);
    const inPlot = (c) => c.x >= mapLeft && c.x + w <= mapRight && c.y >= top && c.y + h <= bottom;
    const scored = candidates.filter(inPlot).map((c) => ({
      ...c,
      w,
      h,
      hits: obstacles.filter((b) => boxesOverlap({ x: c.x, y: c.y, w, h }, b)).length,
      dist: source ? nearestCornerDistance({ x: c.x, y: c.y, w, h }, source) : 0,
    }));
    if (!scored.length) return bestCorner(w, h, obstacles);
    // v9 fix (panel-over-source-outline defect): hits above counts a
    // collision with sourceOutline (one of insetObstacles, ~line 5665) the
    // same as a collision with any one land AABB, so once land boxes make
    // every candidate hit *something* - the common case, since landBoxes
    // cover the whole basemap - clean below is empty and the "fewest hits"
    // fallback can tie a candidate that only overlaps the source outline
    // against one that only overlaps land, then break the tie by distance,
    // which favours the source-hugging candidate and lets the panel print
    // on top of the traced source-extent rectangle. Filtering to candidates
    // that clear the source outline padded by 8px - a hard exclusion, not
    // another point in the hit count - before running the existing
    // clean/hits/dist order fixes that without changing the order itself or
    // any obstacle set; only when nothing clears the pad do we fall back to
    // exactly the pre-fix behaviour below.
    const pick = (pool) => {
      const clean = pool.filter((c) => c.hits === 0);
      if (clean.length) return clean.slice().sort((a, b) => a.dist - b.dist)[0];
      return pool.slice().sort((a, b) => a.hits - b.hits || a.dist - b.dist)[0];
    };
    if (source) {
      const pad = 8;
      const paddedSource = { x: source.x - pad, y: source.y - pad, w: source.w + pad * 2, h: source.h + pad * 2 };
      const clearsSource = scored.filter((c) => !boxesOverlap({ x: c.x, y: c.y, w, h }, paddedSource));
      if (clearsSource.length) return pick(clearsSource);
    }
    return pick(scored);
  }

  // Zoom inset (task: inset). Its own magnified projection, colour scale
  // (the same colorForValue as the main map - task requirement: identical
  // scale/bins), name+value labels placed on the magnified polygons
  // themselves (falling back to a swatch-list row only when a polygon is
  // still too small at that magnification), a source-extent outline traced
  // on the main map, and a thin corner-to-corner link between the two - all
  // only when at least one region was actually selected into it.
  const insetLabelItems = insetItems.map((item) => {
    const value = n(item.row[spec.value_field]) ?? 0;
    return { item, name: resolveEconomyDisplayName(item.raw, spec.category_names, lang), valueText: choroplethValueText(value, spec.unit, spec), fill: colorForValue(value) };
  });
  const insetTitleH = 18;

  const insetPoints2 = [];
  for (const idx of insetFeatureIndices) for (const ring of geometryRings(neFeatureGeometry(idx))) for (const pt of ring) insetPoints2.push(pt);
  const [zLon0, zLat0] = viewCentre(insetPoints2.length ? insetPoints2 : [[lon0, lat0]]);

  // Review fix (magnification >=2.5x): see insetNaturalMapSize above. When a
  // column was reserved the size is also capped to it, so a later-forced
  // region that widens the source set can never push the panel into the map.
  // v10 (panel-over-label defect): renamed from `insetMapSize` - this is the
  // inset's natural, unshrunk size ("full size"/scale 1 in the retry ladder
  // further down). bestInsetPosition used to be handed this single fixed
  // size unconditionally; it is now tried at this size first and only
  // shrunk when nothing at full size clears every on-map label/marker too,
  // so the common case (room for the panel at its natural size) never
  // shrinks anything.
  const insetMapSizeNatural = insetNaturalMapSize(insetPoints2, proj.scale);
  const insetDimsNatural = insetNaturalDims(insetPoints2, proj.scale, insetStripH ? stripPanelWidth : undefined);
  // Wide panel only where it has its own reserved space (column / strip); a
  // floating in-plot panel stays square so it covers as little as possible.
  const insetMapSizeFull = insetColumnW
    ? Math.min(insetDimsNatural.w, insetColumnW - INSET_COLUMN_GAP - 12)
    : insetStripH
      ? Math.min(insetDimsNatural.w, plotRight - plotLeft - 12)
      : insetMapSizeNatural;
  const insetMapHFull = insetColumnW
    ? Math.min(insetDimsNatural.h, mapH - 2 * cornerPad - insetTitleH - 12)
    : insetStripH
      ? Math.min(insetDimsNatural.h, insetStripH - INSET_COLUMN_GAP - INSET_STRIP_LEGEND_GAP - insetTitleH - 8)
      : insetMapSizeNatural;

  // Probe which regions can hold both label lines on their own magnified
  // polygon at insetMapSize (bbox-based, mirroring the same "too small to
  // label" heuristic the auto-inset selection above already uses) - decided
  // before final placement since it only depends on size, not position
  // (fitAzimuthalProjection's scale is translation-invariant).
  //
  // v10: hoisted out of the size-dependent layout below (it only measures a
  // box from a centre point and lineH, an outer-scope constant - no
  // dependency on insetMapSize) since the panel-drawing step further down
  // (onPolygonLabelBoxes) still needs it once the layout function's own
  // scope has closed. The copy inside that function (identical, further
  // down) is an unavoidable shadow, not a second implementation.
  function insetBoxAt(cx, cy, w) {
    const boxH = lineH * 2 + 6;
    return { x: cx - w / 2, y: cy - boxH / 2, w, h: boxH };
  }
  // v10 (panel-over-label defect): wrapped in a function of the map size - a
  // parameter that shadows the name `insetMapSize` used throughout the body
  // below, unchanged - so the placement search further down can rerun this
  // same label layout, unmodified, at a smaller size when nothing at the
  // current size clears every on-map label/marker too. Font sizes are
  // untouched (font, lineH etc. stay outer-scope constants); only
  // insetMapSize itself, and everything measured from it, shrinks.
  // P3: when a region cannot be labelled in the panel at the default margin,
  // widen the margin (less magnification, more open space around the extent)
  // before any region is given a number.
  function layoutInsetAtSize(insetMapSize, insetMapH = insetMapSize) {
    let best = null;
    for (const pad of [0.12, 0.22, 0.34]) {
      const layout = layoutInsetAtSizePad(insetMapSize, insetMapH, pad);
      if (!best || layout.listFallbackItems.length < best.listFallbackItems.length) best = layout;
      if (!layout.listFallbackItems.length) break;
    }
    return best;
  }
  function layoutInsetAtSizePad(insetMapSize, insetMapH, insetPad) {
  const sizingProbe = fitAzimuthalProjection(zLon0, zLat0, insetPoints2.length ? insetPoints2 : [[lon0, lat0]], 0, insetMapSize, 0, insetMapH, insetPad);
  // Review fix (inset containment - "Guinea/Liberia/Sierra Leone likely
  // fit"): a single bbox-centre containment probe fails the same way the old
  // main-map labelOnFeature did - it can reject a feature with plenty of
  // room just because its bbox centre happens to sit in a concave notch
  // (Guinea's own crescent shape). Reuse the same findLabelAnchor multi-
  // candidate search the main map uses, against the inset's own sizingProbe
  // projection (0..insetMapSize square, translation-invariant with the final
  // zoomProj rect below - see that rect's own comment) instead of a single
  // fixed point. Sizing/placement here works entirely in that probe's own
  // coordinate space; the render step below adds the panel's real (mapX0,
  // mapY0) origin once it is known.
  function insetBoxAt(cx, cy, w) {
    const boxH = lineH * 2 + 6;
    return { x: cx - w / 2, y: cy - boxH / 2, w, h: boxH };
  }
  // Task (leader research, point 5): "inside the inset, labels go inside the
  // polygon when they fit; otherwise use the same boundary-labeling
  // algorithm at inset scale." A true misfit is stacked in a single column
  // along the inset's own right edge (layoutBoundaryColumn, shared with the
  // main map, reused here at the inset's own 0..insetMapSize scale), with
  // the same octilinear elbow leader and the same ~3x-text-height length
  // cap; only a region the column has no room for at all keeps the old
  // list-row fallback with a leader to its own centroid.
  const onPolygonItems = [];
  const insetOverflowCandidates = [];
  for (const li of insetLabelItems) {
    const ownIndices = li.item.featureIndices;
    const idx0 = ownIndices[0];
    const bbox = projectedFeatureBBox(ownIndices, sizingProbe.project);
    const w = Math.max(choroplethLabelWidth(li.name, font), choroplethLabelWidth(li.valueText, font));
    const placedBoxes = onPolygonItems.map((p) => insetBoxAt(p.ax, p.ay, p.w));
    const tinyDot = tinyRegionDot(ownIndices, sizingProbe.project, zLon0, zLat0);
    const preferred = tinyDot ? { x: tinyDot.x, y: tinyDot.y } : bbox ? { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 } : null;
    const anchor = bbox && !tinyDot
      ? findLabelAnchor(idx0, ownIndices, w, sizingProbe.project, zLon0, zLat0, preferred.x, preferred.y, placedBoxes)
      : null;
    if (anchor) {
      onPolygonItems.push({ ...li, ax: anchor.x, ay: anchor.y, w });
      continue;
    }
    insetOverflowCandidates.push({ src: li, idx0, x: preferred ? preferred.x : 0, y: preferred ? preferred.y : 0, w, h: lineH * 2 + 6 });
  }
  // Review fix (Sierra Leone falling straight to the list): the inset used to
  // try only a single right-edge column, so any candidate whose leader to
  // that column crossed land (a near neighbour sitting between it and the
  // right edge) had nowhere else to go but the list fallback - even when
  // empty sea sat open on the *other* side of the same country. Mirror the
  // main map's own two-sided approach: split by which half of the inset a
  // candidate's own anchor sits in, and give each half a column on its own
  // near edge, so a leader only ever has to cross the short way out.
  const insetCenterX = insetMapSize / 2;
  const insetLeftCandidates = insetOverflowCandidates.filter((c) => c.x < insetCenterX);
  const insetRightCandidates = insetOverflowCandidates.filter((c) => c.x >= insetCenterX);
  // Review fix (labels running off the canvas edge, same root cause as the
  // main map's own column above): a fixed columnX of 4 / insetMapSize-4
  // doesn't know how wide the labels stacked in it are, so a wide name could
  // still push its box's far edge past the mini map's own 0..insetMapSize
  // square - which, once translated into the panel's real position on the
  // page, can land off the whole canvas. Clamp each side's column inside
  // that square by its own widest label, same as the main map.
  const insetLeftMaxW = insetLeftCandidates.length ? Math.max(...insetLeftCandidates.map((c) => c.w)) : 0;
  const insetRightMaxW = insetRightCandidates.length ? Math.max(...insetRightCandidates.map((c) => c.w)) : 0;
  const insetLeftColumnX = Math.min(insetMapSize - 4, Math.max(4, insetLeftMaxW + 4));
  const insetRightColumnX = Math.max(4, Math.min(insetMapSize - 4, insetMapSize - insetRightMaxW - 4));
  const insetLeftLayout = layoutBoundaryColumn(insetLeftCandidates, "left", insetLeftColumnX, 4, insetMapH - 4, MAX_OVERFLOW_LEADER_PX);
  const insetRightLayout = layoutBoundaryColumn(insetRightCandidates, "right", insetRightColumnX, 4, insetMapH - 4, MAX_OVERFLOW_LEADER_PX);
  const insetAcceptedLeaders = [];
  const insetOverflowItems = [];
  const listFallbackItems = [];
  // Label boxes already spoken for - on-polygon labels plus every overflow
  // label accepted so far this pass - are obstacles a later leader must also
  // clear, not just other leaders/polygons: this is what the hard "zero
  // leader-text crossings" QA (task: leader research) actually requires.
  const insetAcceptedBoxes = onPolygonItems.map((p) => insetBoxAt(p.ax, p.ay, p.w));
  // Splitting the boundary column into left/right halves (Sierra Leone's
  // empty-sea fix) means an entry from one side can now be processed before
  // an entry from the other side whose box it would have crossed - the two
  // columns' own internal orderings no longer guarantee a safe merge order.
  // Every candidate's box is therefore known upfront so a leader is checked
  // against ALL of them (own box excluded), not just the ones some
  // particular concatenation order happened to accept first.
  const insetAllEntries = [...insetLeftLayout.placed, ...insetRightLayout.placed];
  // A candidate the boundary column had no room for (or whose leader would be
  // too long) is not placed above; without this it vanished with no label at
  // all. It takes the numbered-marker fallback like any other unplaceable region.
  // Candidates the boundary column could not take still get an open-spot
  // search (below) before they fall to the numbered list.
  const insetOverflowOnly = [...insetLeftLayout.overflow, ...insetRightLayout.overflow].map((c) => ({ li: c, overflowOnly: true }));
  for (const entry of [...insetAllEntries, ...insetOverflowOnly]) {
    const candidate = entry.li;
    const ownIndices = candidate.src.item.featureIndices;
    const otherIndices = insetFeatureIndices.filter((idx) => !ownIndices.includes(idx));
    const obstacleBoxes = insetAcceptedBoxes.concat(insetAllEntries.filter((e) => e !== entry).map((e) => e.box));
    // v7 fix (Liberia's box/leader landing on its own polygon): identical
    // remedy to the main map's own boundary column above - try the column's
    // own slot first, then nudge outward along this entry's own side (same
    // row, same octilinear shape, so column ordering/non-crossing still
    // holds) until the box clears every inset polygon - its own included -
    // with a leader at least MIN_LEADER_DRAWN_LENGTH long, stays inside the
    // panel's own square, and stays under the length cap. A bbox whose
    // centre straddles the inset's centre line (Liberia's does) can be
    // assigned to the side that turns out to be the pinched one (the panel
    // border, not a polygon, is what runs out of room) - if every nudge on
    // the assigned side fails, the same search is retried once more from the
    // *other* side's column before giving up to the numbered-marker tier.
    const tryClear = (cand, strictOwn = false) => {
      const len = elbowLength(cand.anchor, cand.tip);
      if (len > MAX_OVERFLOW_LEADER_PX || len < MIN_LEADER_DRAWN_LENGTH) return false;
      if (cand.box.x < 4 || cand.box.x + cand.box.w > insetMapSize - 4 || cand.box.y < 2 || cand.box.y + cand.box.h > insetMapH - 2) return false;
      if (boxOverlapsFeature(insetFeatureIndices, cand.box, sizingProbe.project, zLon0, zLat0)) return false;
      const segs = elbowSegments(cand.anchor, cand.tip);
      // A leader never runs through its own label.
      if (strictOwn && segs.some(([p1, p2]) => segmentCrossesBox(p1, p2, cand.box))) return false;
      return (
        segs.every(([p1, p2]) => leaderIsClear(p1, p2, candidate.idx0, otherIndices, insetAcceptedLeaders, sizingProbe.project, zLon0, zLat0, obstacleBoxes, cand.box)) &&
        !otherIndices.some((idx) => pointOnFeature(idx, cand.tip.x, cand.tip.y, sizingProbe.project, zLon0, zLat0))
      );
    };
    let accepted = null;
    // Placement tiers, each tried first without any leader through its own
    // label: the boundary column (own side, then the other side). Only if that
    // fails does the column accept a leader that touches its own label, so no
    // placement is ever lost; the open-spot tier below still follows.
    const tryColumn = (strictOwn) => {
      for (let step = 0; step <= 24 && !accepted && !entry.overflowOnly; step++) {
        const cand = step === 0 ? entry : extendEntryOutward(entry, entry.side, step * 8);
        if (tryClear(cand, strictOwn)) accepted = cand;
      }
      if (!accepted && !entry.overflowOnly) {
        const altSide = entry.side === "right" ? "left" : "right";
        const altColumnX = altSide === "right" ? insetRightColumnX : insetLeftColumnX;
        const flipped = flipEntrySide(entry, altSide, altColumnX);
        for (let step = 0; step <= 24 && !accepted; step++) {
          const cand = step === 0 ? flipped : extendEntryOutward(flipped, altSide, step * 8);
          if (tryClear(cand, strictOwn)) accepted = cand;
        }
      }
    };
    tryColumn(true);
    if (!accepted) tryColumn(false);
    // P3: a short leader to an open spot beside the region, before numbering.
    if (!accepted) {
      const anchorPt = { x: candidate.x, y: candidate.y };
      const angles = [0, 180, -35, 35, 145, -145, -70, 70, 110, -110, -90, 90];
      for (const dist of [12, 20, 30, 44, 60, 80]) {
        for (const deg of angles) {
          const rad = (deg * Math.PI) / 180;
          const tip = { x: anchorPt.x + Math.cos(rad) * dist, y: anchorPt.y + Math.sin(rad) * dist };
          const side = Math.abs(Math.cos(rad)) < 0.3 ? (anchorPt.x < insetCenterX ? "right" : "left") : Math.cos(rad) >= 0 ? "right" : "left";
          const box = { x: side === "right" ? tip.x + LEADER_GAP_PX : tip.x - LEADER_GAP_PX - candidate.w, y: tip.y - candidate.h / 2, w: candidate.w, h: candidate.h };
          const cand = { anchor: anchorPt, tip, box, side };
          if (tryClear(cand, true)) { accepted = cand; break; }
        }
        if (accepted) break;
        // Label centred above or below the point, on a straight vertical leader.
        for (const dir of [1, -1]) {
          const tip = { x: anchorPt.x, y: anchorPt.y + dir * dist };
          const box = { x: Math.min(insetMapSize - 4 - candidate.w, Math.max(4, anchorPt.x - candidate.w / 2)), y: dir > 0 ? tip.y + LEADER_GAP_PX : tip.y - LEADER_GAP_PX - candidate.h, w: candidate.w, h: candidate.h };
          const cand = { anchor: anchorPt, tip, box, side: "center" };
          if (tryClear(cand, true)) { accepted = cand; break; }
        }
        if (accepted) break;
      }
    }
    if (accepted) {
      // v8 fix (18px gap between left-column inset labels and their leader
      // tips): the accepted candidate's own side - set by layoutBoundaryColumn
      // and carried through extendEntryOutward's spread, or reassigned
      // explicitly by flipEntrySide - was computed but never forwarded here,
      // so every inset overflow label rendered start-anchored at its box's
      // left edge regardless of which side it actually landed on. Threading
      // it through lets the render step below right-align a left-side label
      // exactly like the main map's own overflow labels already do.
      insetOverflowItems.push({ ...candidate.src, box: accepted.box, from: accepted.anchor, to: accepted.tip, side: accepted.side });
      for (const [p1, p2] of elbowSegments(accepted.anchor, accepted.tip)) insetAcceptedLeaders.push({ a: p1, b: p2 });
      insetAcceptedBoxes.push(accepted.box);
    } else {
      listFallbackItems.push(candidate.src);
    }
  }
  // Review fix (one global list below the chart, not two): a region the
  // inset's own boundary column can't place used to fall into a second,
  // separately-numbered list drawn inside the inset panel itself. It now
  // gets the same numbered-marker treatment as a main-map footnote (a dot at
  // its own centroid, numbered from the one shared sequence below) - so the
  // panel no longer needs to reserve its own list rows.
  const insetPanelW = insetLabelItems.length ? insetPanelWidthFor(insetMapSize) : 0;
  const insetPanelH = insetLabelItems.length ? Math.min(mapH - 2 * cornerPad, insetTitleH + insetMapH + 8) : 0;
  return { insetMapSize, insetMapH, insetPad, onPolygonItems, insetOverflowItems, listFallbackItems, insetPanelW, insetPanelH };
  }

  // Source extent: the union bbox of every inset region's own projected
  // rings on the *main* map, padded a few px - this is what the thin
  // outline traces, one end of the corner-to-corner link anchors to, and
  // what the panel is placed beside (task: "next to its source region").
  const sourceBBoxRaw = insetItems.length ? projectedFeatureBBox(insetFeatureIndices, project) : null;
  const sourcePad = 6;
  const sourceOutline = sourceBBoxRaw
    ? {
        x: Math.max(mapLeft, sourceBBoxRaw.minX - sourcePad),
        y: Math.max(top, sourceBBoxRaw.minY - sourcePad),
        w: Math.min(mapRight, sourceBBoxRaw.maxX + sourcePad) - Math.max(mapLeft, sourceBBoxRaw.minX - sourcePad),
        h: Math.min(bottom, sourceBBoxRaw.maxY + sourcePad) - Math.max(top, sourceBBoxRaw.minY - sourcePad),
      }
    : null;
  // Cheap "must not overlap land" obstacle set: every basemap feature's own
  // projected AABB, computed once - an approximation (not exact polygon
  // containment) but enough to keep the panel off the continent's landmass.
  const landBoxes = [];
  for (let index = 0; index < featureCount; index++) {
    const bbox = projectedFeatureBBox([index], project);
    if (bbox) landBoxes.push({ x: bbox.minX, y: bbox.minY, w: bbox.maxX - bbox.minX, h: bbox.maxY - bbox.minY });
  }
  const insetObstacles = sourceOutline ? [...allLabelBoxes, ...landBoxes, sourceOutline] : [...allLabelBoxes, ...landBoxes];

  // v10 fix (panel prints over an on-map label/marker): v9's bestInsetPosition
  // only ever kept the panel off its own source-extent outline; every other
  // obstacle (labels, land) was still just one point in a soft "fewest hits"
  // score, so a candidate could win while printing on top of a real on-map
  // label or footnote-marker dot (found on the Africa fixture: the v9 panel
  // covered South Sudan's and Zambia's on-map labels). Below, clearing the
  // padded source outline, every on-map label box (padded 3px), and every
  // on-map numbered-marker circle are hard exclusions, tried first; only
  // among candidates clearing all three does the existing fewest-hits/
  // distance order apply - now scored against land alone, since labels and
  // the source no longer belong in that soft count (they are gates, not
  // points). When nothing at the panel's natural size clears every hard
  // exclusion, the panel - and only the panel's own map zoom; the label
  // layout above reruns unmodified at each size, font sizes untouched -
  // shrinks through the steps below before giving up and falling back to
  // exactly the v9 behaviour (bestInsetPosition, unmodified, at full size).
  // Never below 0.85, per the round-10 mandate.
  const INSET_SCALE_STEPS = [1, 0.95, 0.9, 0.85];
  // On-map numbered-marker circles (choropleth-footnote-marker, r=9). The
  // inset's OWN list-fallback markers (choropleth-inset-footnote-marker) are
  // deliberately excluded: those are drawn inside the panel at the panel's
  // own final position, so they cannot be an obstacle to the panel's own
  // placement search.
  const insetMarkerBoxes = footnoteItems.map((li) => ({ x: li.x - 9, y: li.y - 9, w: 18, h: 18 }));
  function insetHardCandidates(w, h, source) {
    const candidates = source ? [...sourceAdjacentBoxes(w, h, source), ...cornerBoxes(w, h)] : cornerBoxes(w, h);
    const inPlot = (c) => c.x >= mapLeft && c.x + w <= mapRight && c.y >= top && c.y + h <= bottom;
    const pad = 8;
    const paddedSource = source ? { x: source.x - pad, y: source.y - pad, w: source.w + pad * 2, h: source.h + pad * 2 } : null;
    const labelPad = 3;
    const paddedLabelBoxes = allLabelBoxes.map((b) => ({ x: b.x - labelPad, y: b.y - labelPad, w: b.w + labelPad * 2, h: b.h + labelPad * 2 }));
    const clearsAll = (rect, boxes) => boxes.every((b) => !boxesOverlap(rect, b));
    return candidates
      .filter(inPlot)
      .map((c) => ({ ...c, w, h }))
      .filter((c) => !paddedSource || !boxesOverlap(c, paddedSource))
      .filter((c) => clearsAll(c, paddedLabelBoxes))
      .filter((c) => clearsAll(c, insetMarkerBoxes))
      .map((c) => ({ ...c, landHits: landBoxes.filter((b) => boxesOverlap(c, b)).length, dist: source ? nearestCornerDistance(c, source) : 0 }))
      .sort((a, b) => a.landHits - b.landHits || a.dist - b.dist);
  }
  let chosenLayout = null;
  let insetCorner = null;
  if (insetLabelItems.length && insetStripH) {
    // Reserved strip below the map (narrow canvas): the panel is centred
    // horizontally under the source extent, clamped into the plot width.
    chosenLayout = layoutInsetAtSize(insetMapSizeFull, insetMapHFull);
    const w = chosenLayout.insetPanelW, h = chosenLayout.insetPanelH;
    const srcMidX = sourceOutline ? sourceOutline.x + sourceOutline.w / 2 : (mapLeft + mapRight) / 2;
    insetCorner = { key: "strip-bottom", x: Math.min(plotRight - w, Math.max(plotLeft, srcMidX - w / 2)), y: bottom + INSET_COLUMN_GAP, w, h };
  } else if (insetLabelItems.length && insetColumnW) {
    // Reserved column (see insetColumnW): the panel sits flush against the
    // map's left edge, centred vertically on the source extent and clamped
    // into the map's own top..bottom band. Nothing in the column competes
    // with land or labels, so there is no size ladder to walk - the panel
    // keeps its natural (column-capped) size.
    chosenLayout = layoutInsetAtSize(insetMapSizeFull, insetMapHFull);
    const w = chosenLayout.insetPanelW, h = chosenLayout.insetPanelH;
    const srcMidY = sourceOutline ? sourceOutline.y + sourceOutline.h / 2 : (top + bottom) / 2;
    insetCorner = { key: "column-left", x: mapLeft - INSET_COLUMN_GAP - w, y: Math.min(bottom - h, Math.max(top, srcMidY - h / 2)), w, h };
  } else if (insetLabelItems.length) {
    let fullSizeLayout = null;
    for (const scale of INSET_SCALE_STEPS) {
      const candidateLayout = layoutInsetAtSize(insetMapSizeFull * scale, insetMapHFull * scale);
      if (scale === 1) fullSizeLayout = candidateLayout;
      const best = insetHardCandidates(candidateLayout.insetPanelW, candidateLayout.insetPanelH, sourceOutline)[0];
      if (best) {
        chosenLayout = candidateLayout;
        insetCorner = best;
        break;
      }
    }
    if (!insetCorner) {
      chosenLayout = fullSizeLayout;
      insetCorner = bestInsetPosition(chosenLayout.insetPanelW, chosenLayout.insetPanelH, insetObstacles, sourceOutline);
    }
  } else {
    chosenLayout = layoutInsetAtSize(insetMapSizeFull, insetMapHFull);
  }
  const { insetMapSize, insetMapH, insetPad, onPolygonItems, insetOverflowItems, listFallbackItems, insetPanelW, insetPanelH } = chosenLayout;

  // One global numbering sequence covers both fallback tiers (main-map
  // boundary-column overflow, then inset boundary-column overflow) so a
  // marker number is never reused for two different regions, and one list
  // below the chart - built next, once this combined set is known - is the
  // single place a reader looks up every numbered region's name/value.
  const numberedFallbackItems = [...footnoteItems, ...listFallbackItems];
  const fallbackNumberByIso3 = new Map(numberedFallbackItems.map((li, i) => [li.item.iso3, i + 1]));
  // Numbered regions that got no map marker (no clean spot plus tether): they
  // stay in the numbered list, and are counted so the chart note and render QA
  // can say so instead of letting a data point vanish silently.
  const listOnlyIso3 = [];
  let markerTotal = footnoteItems.length;
  const footnoteMarkerPositions = placeNumberedMarkers(footnoteItems.map((li) => ({ x: li.x, y: li.y })), {
    bounds: { x: mapLeft, y: top, w: mapRight - mapLeft, h: bottom - top },
    boxes: [...allLabelBoxes, ...(insetCorner ? [{ x: insetCorner.x, y: insetCorner.y, w: insetCorner.w, h: insetCorner.h }] : [])],
    segments: placedOverflow.flatMap(({ anchor, tip }) => elbowSegments(anchor, tip).map(([a, b]) => ({ a, b }))),
    dots: [...tinyDots.values()].map((d) => ({ x: d.x, y: d.y, r: mobile ? 3 : 3.5 })),
    ...(worldMode ? { nearDotTolerance: 8 } : {}),
  });
  footnoteItems.forEach((li, i) => {
    const num = fallbackNumberByIso3.get(li.item.iso3);
    const mk = footnoteMarkerPositions[i];
    if (!mk) { listOnlyIso3.push(li.item.iso3); return; }
    footnoteParts.push(
      markerTetherSvg("choropleth-footnote-marker", mk, { x: li.x, y: li.y }, li.item.iso3, num),
      `<circle data-role="choropleth-footnote-marker" data-iso3="${esc(li.item.iso3)}" data-number="${num}" data-anchor-x="${li.x.toFixed(1)}" data-anchor-y="${li.y.toFixed(1)}" cx="${mk.x.toFixed(1)}" cy="${mk.y.toFixed(1)}" r="9" fill="${PALETTE.ink}"/>`,
      `<text data-role="choropleth-footnote-marker-label" x="${mk.x.toFixed(1)}" y="${(mk.y + 4).toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PAPER}">${num}</text>`
    );
  });
  // The list starts below the legend's own tick-label row (legendY=bottom+22,
  // ticks at legendY+26, so bottom+48 is the legend's own lowest text) so it
  // never overlaps the legend - the footnote/legend collision the render-QA
  // gate caught earlier. Body height below is reserved to match.
  const footnoteListTop = bottom + insetStripH + 64;
  // Review fix (v6 polish, "large empty band between the legend and the
  // notes"): bodyH above already reserves mapH+74/80 - comfortably past the
  // legend's own lowest text at bottom+48, with its own ~26-32px trailing
  // gap before the footer - for the no-footnote-list case. footnoteH used
  // to be this same footnoteListTop-anchored block's *entire* height, added
  // on top of that already-legend-sized slot instead of replacing the part
  // of it the list doesn't need, so every render with a footnote list
  // carried a second, redundant legend-sized gap (~80px) nobody ever drew
  // into. footnoteH is now only the amount the list's own bottom edge
  // (footnoteListTop + one row per item, plus the same small +10 trailing
  // pad the list always used) reaches *past* that existing base slot -
  // zero whenever the list is short enough to already fit inside it - so
  // the frame grows by exactly what the extra rows need and no more.
  const baseSlotBottom = bottom + insetStripH + (mobile ? 74 : 80);
  // Footnote list layout: the number column is right-aligned at one fixed x
  // (so "9." and "10." share an edge and every name/value starts at the same
  // x from row 1 down), and a long list is split into side-by-side columns
  // filled top to bottom so the frame does not grow by one row per region.
  const FOOTNOTE_ROWS_PER_COLUMN = 12;
  const footnoteFieldGap = 4;
  const footnoteColumnGap = 28;
  const footnoteNumW = numberedFallbackItems.length
    ? Math.max(...numberedFallbackItems.map((_, i) => choroplethLabelWidth(`${i + 1}.`, font)))
    : 0;
  const footnoteNameW = numberedFallbackItems.length ? Math.max(...numberedFallbackItems.map((li) => choroplethLabelWidth(li.name, font))) : 0;
  const footnoteValueW = numberedFallbackItems.length ? Math.max(...numberedFallbackItems.map((li) => choroplethLabelWidth(li.valueText, font))) : 0;
  const footnoteColumnW = footnoteNumW + footnoteFieldGap + footnoteNameW + footnoteFieldGap + footnoteValueW;
  const footnoteColumnsFit = Math.max(1, Math.floor((plotRight - plotLeft + footnoteColumnGap) / (footnoteColumnW + footnoteColumnGap)));
  const footnoteColumns = Math.min(
    footnoteColumnsFit,
    Math.max(1, Math.ceil(numberedFallbackItems.length / FOOTNOTE_ROWS_PER_COLUMN)),
  );
  const footnoteRows = Math.ceil(numberedFallbackItems.length / footnoteColumns);
  const footnoteBlockBottom = footnoteListTop + footnoteRows * footnoteRowH + 10;
  const footnoteH = numberedFallbackItems.length ? Math.max(0, footnoteBlockBottom - baseSlotBottom) : 0;
  if (numberedFallbackItems.length) {
    // Split into three text runs so the name and value each land in their
    // own data-role="choropleth-label"/"choropleth-label-value" node (same
    // roles the on-map/overflow layouts use) - this is what lets
    // render_qa_labels.mjs's own independent value-labels proof recover
    // each footnoted region's exact value from markup alone, the same
    // guarantee every other plotted region gets, not a weaker one.
    footnoteParts.push(`<g data-role="choropleth-footnote-list">`);
    // P3 (item 6): values sit in one right-aligned column, so the numbers can
    // be compared down the list.
    numberedFallbackItems.forEach((li, i) => {
      const column = Math.floor(i / footnoteRows);
      const rowY = footnoteListTop + (i % footnoteRows) * footnoteRowH;
      const columnX = plotLeft + column * (footnoteColumnW + footnoteColumnGap);
      const prefix = `${i + 1}.`;
      // Review fix (footnote list "Togo" overlapping its own "—" separator
      // on mobile): each field used to start 8px BEHIND where the previous
      // field's estimated width said it ended, so a name whose true
      // rendered width came in close to (or under) that estimate collided
      // with the separator right after it. Fields are laid out as a strict
      // running total of estimated widths plus a small positive gap, so
      // every boundary has real clearance regardless of which name/value
      // ends up here.
      // Review fix (v6 polish, "normal spacing"): the dash-separator field
      // ("name — value") read as unusually wide once every boundary already
      // carries choroplethLabelWidth's own built-in trailing pad plus this
      // gap - task asked for a plain running line, "1. 刚果（布） 71.4%".
      // Dropping the separate " — " field (and its own width+gap slot)
      // leaves exactly the same proven two-field gap pattern already used
      // between the numeral prefix and the name, now reused once more
      // between name and value, instead of a third, dash-carrying field.
      const numX = columnX + footnoteNumW;
      const nameX = numX + footnoteFieldGap;
      const valueX = nameX + footnoteNameW + footnoteFieldGap + footnoteValueW;
      footnoteParts.push(
        `<text data-role="choropleth-footnote-number" x="${numX.toFixed(1)}" y="${rowY.toFixed(1)}" text-anchor="end" font-family="${FONT_SANS}" font-size="${font}" style="font-variant-numeric: tabular-nums" fill="${PALETTE.ink}">${esc(prefix)}</text>`,
        `<text data-role="choropleth-footnote-name" data-iso3="${esc(li.item.iso3)}" x="${nameX.toFixed(1)}" y="${rowY.toFixed(1)}" font-family="${FONT_SANS}" font-size="${font}" fill="${PALETTE.ink}">${esc(li.name)}</text>`,
        `<text data-role="choropleth-footnote-value" data-iso3="${esc(li.item.iso3)}" x="${valueX.toFixed(1)}" y="${rowY.toFixed(1)}" text-anchor="end" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}">${esc(li.valueText)}</text>`
      );
    });
    footnoteParts.push(`</g>`);
  }
  if (footnoteH) {
    f = mobile ? mobileFrame(spec, bodyH + insetStripH + footnoteH) : frame(spec, bodyH + insetStripH + footnoteH);
  }

  // Task (leader research, point 4): "by DEFAULT, no connector line - mark
  // the source region with a bounding-box outline in the same style as the
  // inset's frame; draw a single elbow connector only if the inset panel is
  // not adjacent to its source box (gap > ~15% of the map width)." Adjacency
  // is measured edge-to-edge (not corner-to-corner, which reads as "far"
  // even when the two rects already touch or overlap).
  function rectGap(a, b) {
    const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
    const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
    return Math.hypot(dx, dy);
  }
  let insetLinkPath = "";
  if (sourceOutline && insetCorner) {
    const insetRect = { x: insetCorner.x, y: insetCorner.y, w: insetCorner.w, h: insetCorner.h };
    const gap = rectGap(sourceOutline, insetRect);
    if (insetStripH) {
      // Reserved strip: a straight vertical run from the source outline's
      // bottom edge down to the panel's top edge, at an x both share.
      const lo = Math.max(sourceOutline.x, insetRect.x) + 4, hi = Math.min(sourceOutline.x + sourceOutline.w, insetRect.x + insetRect.w) - 4;
      const xLink = lo <= hi ? (lo + hi) / 2 : Math.min(insetRect.x + insetRect.w - 4, Math.max(insetRect.x + 4, sourceOutline.x + sourceOutline.w / 2));
      insetLinkPath = `M${xLink.toFixed(1)},${(sourceOutline.y + sourceOutline.h).toFixed(1)} L${xLink.toFixed(1)},${insetRect.y.toFixed(1)}`;
    } else if (insetColumnW) {
      // Reserved column: a straight horizontal run from the panel's right
      // edge to the source outline's left edge at a height both share (the
      // panel is centred on the source, clamped into the map band), so the
      // connector never wanders across the map's labels the way a
      // corner-to-corner elbow does.
      const lo = Math.max(sourceOutline.y, insetRect.y) + 4, hi = Math.min(sourceOutline.y + sourceOutline.h, insetRect.y + insetRect.h) - 4;
      const yLink = lo <= hi ? (lo + hi) / 2 : Math.min(insetRect.y + insetRect.h - 4, Math.max(insetRect.y + 4, sourceOutline.y + sourceOutline.h / 2));
      insetLinkPath = `M${(insetRect.x + insetRect.w).toFixed(1)},${yLink.toFixed(1)} L${sourceOutline.x.toFixed(1)},${yLink.toFixed(1)}`;
    } else if (gap > 0.15 * (mapRight - mapLeft)) {
      let best = null;
      for (const a of rectCorners(sourceOutline)) {
        for (const b of rectCorners(insetRect)) {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (!best || d < best.d) best = { a, b, d };
        }
      }
      if (best) insetLinkPath = elbowLeaderPath(best.a, best.b);
    }
  }

  // P3 (item 2): a connector longer than a quarter of the main map, or one
  // that would run across a data region, is not drawn. The source box and the
  // panel title carry the same letter instead.
  let insetLetter = "";
  if (insetLinkPath) {
    const nums = (insetLinkPath.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
    let len = 0, crosses = false;
    const insetOwn = new Set(insetFeatureIndices);
    const dataOthers = [];
    for (const it of joined) for (const idx of it.featureIndices) if (!insetOwn.has(idx)) dataOthers.push(idx);
    for (let i = 0; i + 1 < pts.length && !crosses; i++) {
      const seg = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      len += seg;
      for (let t = 0; t <= seg && !crosses; t += 5) {
        const px = pts[i].x + ((pts[i + 1].x - pts[i].x) * t) / (seg || 1), py = pts[i].y + ((pts[i + 1].y - pts[i].y) * t) / (seg || 1);
        if (dataOthers.some((idx) => pointOnFeature(idx, px, py, project, lon0, horizonLat0))) crosses = true;
      }
    }
    if (len > 0.25 * (mapRight - mapLeft) || crosses) {
      insetLinkPath = "";
      insetLetter = "A";
    }
  }
  const letterTagSvg = (role, x, y, letter) =>
    `<g data-role="${role}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="16" height="16" rx="2" fill="${PALETTE.ink}"/><text x="${(x + 8).toFixed(1)}" y="${(y + 12.4).toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="#fff">${esc(letter)}</text></g>`;

  // Locator inset (task 5): only earns its place when the main map is a
  // genuine zoom-in on a small slice of its continent - review fix: at
  // continent scale (e.g. an 11-country spread across most of Africa) a
  // locator adds nothing and, worse, ends up floating over the data with its
  // "here" rectangle covering most of the frame it is supposed to be
  // locating within. Shown only when the joined data's own projected bbox
  // covers under ~25% of the locator's own continent-bbox area, both
  // measured in the SAME (main project) pixel space so the ratio is
  // meaningful; the main map's own zoom-source rectangle (drawn below,
  // always) is what tells the reader what is magnified once this is hidden.
  const dataContinents = new Set();
  for (const item of joined) {
    for (const idx of item.featureIndices) {
      const c = neFeatureAttributes(idx)?.continent;
      if (c) dataContinents.add(c);
    }
  }
  const locatorIndices = [];
  for (let index = 0; index < featureCount; index++) {
    const c = neFeatureAttributes(index)?.continent;
    if (c && dataContinents.has(c)) locatorIndices.push(index);
  }
  const allDataFeatureIndices = joined.flatMap((item) => item.featureIndices);
  const dataBBoxArea = (() => {
    const b = projectedFeatureBBox(allDataFeatureIndices, project);
    return b ? Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY) : 0;
  })();
  const continentBBoxArea = (() => {
    const b = projectedFeatureBBox(locatorIndices, project);
    return b ? Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY) : 0;
  })();
  // A world projection already shows every region, so a locator would only repeat it
  // (and its bbox-centred azimuthal view breaks for data straddling the antimeridian).
  let showLocator = mapChoice.kind === "world" ? false : continentBBoxArea > 0 ? dataBBoxArea / continentBBoxArea < 0.25 : true;

  const locatorSize = mobile ? 104 : 150;
  // Review fix (mobile inset/locator collision): the zoom inset panel (if
  // any) is a hard mustAvoid, not just another soft obstacle to weigh
  // against land/labels - it is painted opaque on top of the main map, so
  // a later, also-opaque locator panel landing on the same corner would
  // visually bury the inset's own on-polygon labels underneath it (this is
  // exactly what happened on mobile before this fix: bestCorner's old
  // "fewest hits" tie-break could still pick a corner that overlapped the
  // already-placed inset panel whenever every corner collided with
  // *something*).
  const insetCornerRect = insetCorner ? { x: insetCorner.x, y: insetCorner.y, w: insetCorner.w, h: insetCorner.h } : null;
  // The locator sits inside the map frame, so it must never cover a region that
  // carries data: every corner/edge slot is checked against the projected boxes
  // of the data regions' pieces, and when none is free the locator is dropped
  // (it is orientation only; the map itself still shows every region).
  const dataPieceBoxes = [];
  for (const idx of allDataFeatureIndices) {
    for (const ring of geometryRings(neFeatureGeometry(idx))) {
      if (!ringWithinHorizon(ring, lon0, horizonLat0)) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [lo, la] of ring) {
        const q = project(lo, la);
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      }
      if (x1 - x0 >= 1 || y1 - y0 >= 1) dataPieceBoxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  const locatorMustAvoid = [...(insetCornerRect ? [insetCornerRect] : []), ...dataPieceBoxes];
  let corner = showLocator ? bestCorner(locatorSize, locatorSize, insetObstacles, locatorMustAvoid) : null;
  if (corner && dataPieceBoxes.some((b) => boxesOverlap({ x: corner.x, y: corner.y, w: locatorSize, h: locatorSize }, b))) {
    showLocator = false;
    corner = null;
  }

  const locatorPoints = [];
  if (showLocator) for (const index of locatorIndices) for (const ring of geometryRings(neFeatureGeometry(index))) for (const pt of ring) locatorPoints.push(pt);
  const [locatorLon0, locatorLat0] = viewCentre(locatorPoints.length ? locatorPoints : [[lon0, lat0]]);
  const locatorProj = showLocator
    ? fitAzimuthalProjection(
        locatorLon0, locatorLat0, locatorPoints.length ? locatorPoints : [[lon0, lat0]],
        corner.x + 4, corner.x + locatorSize - 4, corner.y + 4, corner.y + locatorSize - 4, 0.08
      )
    : null;

  // Review fix (locator redesign): drop the curved projection-outline frame
  // trace - inverting main-map edge points through an azimuthal projection
  // near its own edge can send them well outside the locator panel (the
  // "bleeds outside its panel, looks crude" the review flagged), and it read
  // as a globe-like curve rather than a plain located-area marker. Replaced
  // by a straight-edged, accent-outlined rect built directly from the data's
  // own lon/lat bbox corners (no invert() involved at all), and the whole
  // panel's own country paths + rect are now clipped to the panel's rect so
  // nothing can bleed past its own frame regardless of projection edge
  // behaviour.
  const locatorClipId = `choropleth-locator-clip-${mobile ? "m" : "d"}`;
  const locatorParts = [];
  if (showLocator) {
    locatorParts.push(`<g data-role="choropleth-locator"><rect x="${corner.x}" y="${corner.y}" width="${locatorSize}" height="${locatorSize}" rx="3" fill="${PAPER}" fill-opacity=".94" stroke="${PALETTE.grid}"/>`);
    locatorParts.push(`<defs><clipPath id="${locatorClipId}"><rect x="${corner.x}" y="${corner.y}" width="${locatorSize}" height="${locatorSize}" rx="3"/></clipPath></defs>`);
    locatorParts.push(`<g clip-path="url(#${locatorClipId})">`);
    for (const index of locatorIndices) {
      const d = featurePath(neFeatureGeometry(index), locatorProj.project, { lon0: locatorLon0, lat0: locatorLat0, limitDeg: 90, precision: 1, minDist: 0.6, clipRect: { left: corner.x, right: corner.x + locatorSize, top: corner.y, bottom: corner.y + locatorSize } });
      if (!d) continue;
      // Light grey for the continent's own context countries, mid grey for
      // the countries actually carrying data (task 1's own wording) -
      // PALETTE.context is already the mid-grey token used elsewhere for a
      // "this has data, but is not the focus" fill, and PALETTE.grid (the
      // same light hairline/no-data grey the main map's own colorForValue
      // fallback below now reads) is the live-bound stand-in for the old
      // literal light grey.
      const fill = dataByIndex.has(index) ? PALETTE.context : PALETTE.grid;
      locatorParts.push(`<path d="${d}" fill="${fill}" stroke="${PAPER}" stroke-width=".3"/>`);
    }
    // Zoomed-area indicator: the axis-aligned pixel bbox of the data's own
    // lon/lat bbox corners projected through the locator's own projection -
    // straight-edged by construction (four corners, one rect), not a traced
    // curve.
    const dataLons = dataPoints.map((p) => p[0]);
    const dataLats = dataPoints.map((p) => p[1]);
    if (dataLons.length) {
      const dMinLon = Math.min(...dataLons), dMaxLon = Math.max(...dataLons);
      const dMinLat = Math.min(...dataLats), dMaxLat = Math.max(...dataLats);
      // Data crossing the antimeridian has a naive lon span near 360 deg, so its
      // bbox corners project to the far side of the globe; project the data's
      // own points instead.
      const zoomCorners = dMaxLon - dMinLon > 180
        ? dataPoints.map(([flon, flat]) => locatorProj.project(flon, flat))
        : [[dMinLon, dMinLat], [dMinLon, dMaxLat], [dMaxLon, dMinLat], [dMaxLon, dMaxLat]].map(([flon, flat]) => locatorProj.project(flon, flat));
      const zx0 = Math.min(...zoomCorners.map((p) => p.x));
      const zx1 = Math.max(...zoomCorners.map((p) => p.x));
      const zy0 = Math.min(...zoomCorners.map((p) => p.y));
      const zy1 = Math.max(...zoomCorners.map((p) => p.y));
      locatorParts.push(
        `<rect data-role="choropleth-locator-area" x="${zx0.toFixed(1)}" y="${zy0.toFixed(1)}" width="${Math.max(1, zx1 - zx0).toFixed(1)}" height="${Math.max(1, zy1 - zy0).toFixed(1)}" fill="none" stroke="${PALETTE.accent}" stroke-width="1.5"/>`
      );
    }
    // A data region too small to show at locator scale gets an accent dot, so the
    // marker never frames a stretch of empty sea.
    for (const item of joined) {
      const dot = tinyRegionDot(item.featureIndices, locatorProj.project, locatorLon0, locatorLat0, 3);
      if (!dot) continue;
      if (dot.x < corner.x || dot.x > corner.x + locatorSize || dot.y < corner.y || dot.y > corner.y + locatorSize) continue;
      locatorParts.push(`<circle data-role="choropleth-locator-dot" data-iso3="${esc(item.iso3)}" cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="2.2" fill="${PALETTE.accent}"/>`);
    }
    locatorParts.push("</g>");
    locatorParts.push("</g>");
  }

  // Zoom inset panel markup (task: inset): background frame with a small
  // title (>=12px, task's own house style), the magnified colour-scale map
  // of just the selected regions (clipped to its own sub-rect, same
  // colorForValue as the main map) with name+value labels drawn straight on
  // each polygon large enough to hold them, and a compact swatch list below
  // for whichever regions are still too small even at this magnification.
  const insetPanelParts = [];
  if (insetCorner) {
    const px = insetCorner.x, py = insetCorner.y;
    const insetPanelAttr = ` data-panel-box="${px.toFixed(1)},${py.toFixed(1)},${(px + insetPanelW).toFixed(1)},${(py + insetPanelH).toFixed(1)}"`;
    const insetTitle = String(insetSpec?.title ?? (lang === "zh" ? "局部放大" : "Inset")).trim();
    const mapX0 = px + 6, mapX1 = px + insetMapSize + 6, mapY0 = py + insetTitleH + 4, mapY1 = mapY0 + insetMapH;
    const zoomProj = fitAzimuthalProjection(zLon0, zLat0, insetPoints2.length ? insetPoints2 : [[lon0, lat0]], mapX0, mapX1, mapY0, mapY1, insetPad);
    const zoomClipId = `choropleth-inset-clip-${mobile ? "m" : "d"}`;

    // Task (leader research, point 4): the panel's own frame and the
    // main-map source-extent outline share one style (1px dark grey,
    // PALETTE.muted) so the reader reads them as "the same box, drawn twice".
    insetPanelParts.push(`<g data-role="choropleth-inset"><rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${insetPanelW.toFixed(1)}" height="${insetPanelH.toFixed(1)}" rx="3" fill="${PAPER}" fill-opacity=".97" stroke="${PALETTE.muted}" stroke-width="1"/>`);
    insetPanelParts.push(`<text x="${(px + (insetLetter ? 28 : 8)).toFixed(1)}" y="${(py + 13).toFixed(1)}" font-family="${FONT_SANS}" font-size="12.5" font-weight="700" fill="${PALETTE.ink}">${esc(insetTitle)}</text>`);
    if (insetLetter) insetPanelParts.push(letterTagSvg("choropleth-inset-letter", px + 8, py + 1, insetLetter));
    insetPanelParts.push(`<defs><clipPath id="${zoomClipId}"><rect x="${mapX0.toFixed(1)}" y="${mapY0.toFixed(1)}" width="${(mapX1 - mapX0).toFixed(1)}" height="${(mapY1 - mapY0).toFixed(1)}"/></clipPath></defs>`);
    insetPanelParts.push(`<g clip-path="url(#${zoomClipId})">`);
    // Neighbouring land for orientation: every other feature whose lon/lat box
    // meets the selected regions' box widened by 35% (at least 3 deg). Drawn
    // beneath the data paths and clipped to the panel like them.
    if (insetPoints2.length) {
      const ils = insetPoints2.map((pt) => pt[0]), ibs = insetPoints2.map((pt) => pt[1]);
      const padLon = Math.max(3, (Math.max(...ils) - Math.min(...ils)) * 0.35), padLat = Math.max(3, (Math.max(...ibs) - Math.min(...ibs)) * 0.35);
      let wMinLon = Math.min(...ils) - padLon, wMaxLon = Math.max(...ils) + padLon, wMinLat = Math.min(...ibs) - padLat, wMaxLat = Math.max(...ibs) + padLat;
      // P3 (item 3): the panel is wider/taller than the extent, so the land
      // that fills it is whatever lies under the rectangle itself - widen the
      // window by the lon/lat the rectangle's own edge samples invert to.
      {
        const sl = [], sb = [];
        for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
          const q = zoomProj.invert(mapX0 + fx * (mapX1 - mapX0), mapY0 + fy * (mapY1 - mapY0));
          if (q && Number.isFinite(q[0]) && Number.isFinite(q[1])) { sl.push(q[0]); sb.push(q[1]); }
        }
        if (sl.length && Math.max(...sl) - Math.min(...sl) < 270) {
          wMinLon = Math.min(wMinLon, ...sl); wMaxLon = Math.max(wMaxLon, ...sl);
          wMinLat = Math.min(wMinLat, ...sb); wMaxLat = Math.max(wMaxLat, ...sb);
        }
      }
      const inInset = new Set(insetFeatureIndices);
      for (let idx = 0; idx < featureCount; idx++) {
        if (inInset.has(idx)) continue;
        let fMinLon = Infinity, fMaxLon = -Infinity, fMinLat = Infinity, fMaxLat = -Infinity;
        for (const ring of geometryRings(neFeatureGeometry(idx))) for (const pt of ring) {
          if (pt[0] < fMinLon) fMinLon = pt[0]; if (pt[0] > fMaxLon) fMaxLon = pt[0];
          if (pt[1] < fMinLat) fMinLat = pt[1]; if (pt[1] > fMaxLat) fMaxLat = pt[1];
        }
        if (fMaxLon < wMinLon || fMinLon > wMaxLon || fMaxLat < wMinLat || fMinLat > wMaxLat) continue;
        const d = featurePath(neFeatureGeometry(idx), zoomProj.project, { lon0: zLon0, lat0: zLat0, limitDeg: 90, precision: 1, minDist: 0.4, clipRect: { left: mapX0, right: mapX1, top: mapY0, bottom: mapY1 } });
        if (d) insetPanelParts.push(`<path data-role="choropleth-inset-context" d="${d}" fill="${PALETTE.grid}" stroke="${PAPER}" stroke-width="0.5"/>`);
      }
    }
    for (const item of insetLabelItems) {
      for (const idx of item.item.featureIndices) {
        const d = featurePath(neFeatureGeometry(idx), zoomProj.project, { lon0: zLon0, lat0: zLat0, limitDeg: 90, precision: 1, minDist: 0.4, clipRect: { left: mapX0, right: mapX1, top: mapY0, bottom: mapY1 } });
        if (!d) continue;
        insetPanelParts.push(`<path data-role="choropleth-inset-data" data-iso3="${esc(item.item.iso3)}" data-value="${n(item.item.row[spec.value_field]) ?? 0}" d="${d}" fill="${item.fill}" stroke="${PAPER}" stroke-width="0.5"/>`);
      }
    }
    for (const item of insetLabelItems) {
      const dot = tinyRegionDot(item.item.featureIndices, zoomProj.project, zLon0, zLat0);
      if (!dot) continue;
      insetPanelParts.push(`<circle data-role="choropleth-inset-dot" data-iso3="${esc(item.item.iso3)}" data-value="${n(item.item.row[spec.value_field]) ?? 0}" cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="3.2" fill="${item.fill}" stroke="${PALETTE.ink}" stroke-width=".8"/>`);
    }
    // Review fix (containment search): the anchor placement decided above
    // (onPolygonItems' own ax/ay) was found in the sizingProbe's own
    // coordinate space (origin 0,0) - translate by this panel's real origin
    // (mapX0, mapY0) here, which fitAzimuthalProjection's linear-in-target-
    // rect-position behaviour guarantees is the only difference between that
    // probe and this zoomProj (both share the same scale/centre - see the
    // sizingProbe's own comment above).
    for (const li of onPolygonItems) {
      const cx = li.ax + mapX0;
      const cy = li.ay + mapY0;
      const style = labelStyleOnFill(hexToRgb(li.fill));
      insetPanelParts.push(
        `<text data-role="choropleth-inset-label" data-iso3="${esc(li.item.iso3)}"${insetPanelAttr} x="${cx.toFixed(1)}" y="${(cy - labelLineDy).toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${style.fill}">${esc(li.name)}</text>`,
        `<text data-role="choropleth-inset-label-value" data-iso3="${esc(li.item.iso3)}"${insetPanelAttr} x="${cx.toFixed(1)}" y="${(cy + labelLineDy).toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${style.fill}">${esc(li.valueText)}</text>`
      );
    }
    insetPanelParts.push("</g>");

    // Review fix ("long crossing leaders"): a true misfit placed just off
    // its own polygon inside the mini map, with a short (<=40px, checked
    // above) leader - the same visual language as the main map's own
    // overflow labels (no chip, a white paint-order halo instead; see
    // OVERFLOW_LABEL_HALO above), drawn unclipped like the source/link lines
    // since its destination is a real point inside the panel rect regardless
    // of the map's own clip path.
    for (const item of insetOverflowItems) {
      const from = { x: item.from.x + mapX0, y: item.from.y + mapY0 };
      const boxX = item.box.x + mapX0, boxY = item.box.y + mapY0;
      const to = { x: item.to.x + mapX0, y: item.to.y + mapY0 };
      // v7 fix (Sierra Leone's name/value gap): centre the two lines on the
      // box's own vertical middle using the same labelLineDy (1.2x font) the
      // on-polygon labels above use, instead of the old lineH-derived offsets
      // that read as a visibly wider gap than an in-polygon label's.
      const boxMidY = boxY + item.box.h / 2;
      // v8 fix (18px name/value-to-leader gap): mirror the main map's own
      // overflow labels (textX/textAnchor above) instead of always
      // start-anchoring at the box's left edge. A left-side label's box sits
      // to the LEFT of its leader tip, so its near (right) edge is boxX+w,
      // not boxX; start-anchoring at boxX left about 18px of empty box
      // between the end of the text and the leader (choroplethLabelWidth's
      // own padding plus LEADER_GAP_PX) with nothing drawn in it. Right-side
      // labels are unaffected (their near edge already is boxX).
      const textX = item.side === "center" ? boxX + item.box.w / 2 : item.side === "right" ? boxX : boxX + item.box.w;
      const textAnchor = item.side === "center" ? "middle" : item.side === "right" ? "start" : "end";
      insetPanelParts.push(
        anchorDotSvg("choropleth-inset-leader-dot", from),
        leaderSvg("choropleth-inset-leader", from, to, ` data-iso3="${esc(item.item.iso3)}"`),
        `<text data-role="choropleth-inset-label" data-iso3="${esc(item.item.iso3)}"${insetPanelAttr} x="${textX.toFixed(1)}" y="${(boxMidY - labelLineDy).toFixed(1)}" text-anchor="${textAnchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="600" fill="${PALETTE.ink}"${OVERFLOW_LABEL_HALO}>${esc(item.name)}</text>`,
        `<text data-role="choropleth-inset-label-value" data-iso3="${esc(item.item.iso3)}"${insetPanelAttr} x="${textX.toFixed(1)}" y="${(boxMidY + labelLineDy).toFixed(1)}" text-anchor="${textAnchor}" font-family="${FONT_SANS}" font-size="${font}" font-weight="700" fill="${PALETTE.ink}"${OVERFLOW_LABEL_HALO}>${esc(item.valueText)}</text>`
      );
    }

    if (listFallbackItems.length) {
      // Review fix (leader research, hard "zero leader-text crossings" QA):
      // a per-row leader from a swatch back to its own centroid could, with
      // several rows stacked in the same small panel, cross another row's
      // own text - the same failure mode the main map's boundary column
      // guards against by construction. This tier has already fallen out of
      // that column (no room, or its leader would cross something), so it
      // demotes further the same way the main map does: a numbered marker
      // dot at the region's own centroid, no leader line at all. The name
      // and value live in the one combined list below the chart
      // (numberedFallbackItems) - not a second list inside the panel - so
      // this only ever needs to draw the dot, numbered from that same
      // shared sequence.
      const rawCentroids = listFallbackItems.map((li) => {
        const bbox = projectedFeatureBBox(li.item.featureIndices, zoomProj.project);
        return bbox ? { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 } : null;
      });
      // Keep markers off the inline on-polygon labels too (not just off each
      // other) - a marker centroid can otherwise land right under a
      // neighbouring region's own name/value text drawn straight onto its
      // polygon (onPolygonItems, above), which no leader/crossing check
      // catches since neither of them is a leader.
      const onPolygonLabelBoxes = onPolygonItems.map((p) => {
        const box = insetBoxAt(p.ax, p.ay, p.w);
        return { x: box.x + mapX0, y: box.y + mapY0, w: box.w, h: box.h };
      }).concat(
        insetOverflowItems.map((item) => ({ x: item.box.x + mapX0, y: item.box.y + mapY0, w: item.box.w, h: item.box.h }))
      );
      const insetLeaderSegments = insetOverflowItems.flatMap((item) =>
        elbowSegments(
          { x: item.from.x + mapX0, y: item.from.y + mapY0 },
          { x: item.to.x + mapX0, y: item.to.y + mapY0 },
        ).map(([a, b]) => ({ a, b })),
      );
      const declutteredCentroids = placeNumberedMarkers(rawCentroids.filter(Boolean), {
        bounds: { x: mapX0, y: mapY0, w: mapX1 - mapX0, h: mapY1 - mapY0 },
        boxes: onPolygonLabelBoxes,
        segments: insetLeaderSegments,
        dots: insetLabelItems.map((item) => tinyRegionDot(item.item.featureIndices, zoomProj.project, zLon0, zLat0)).filter(Boolean).map((d) => ({ x: d.x, y: d.y, r: 3.2 })),
      });
      let centroidCursor = 0;
      const markerCentroids = rawCentroids.map((c) => (c ? declutteredCentroids[centroidCursor++] ?? null : null));
      listFallbackItems.forEach((li, i) => {
        const marker = markerCentroids[i];
        const num = fallbackNumberByIso3.get(li.item.iso3);
        if (rawCentroids[i]) markerTotal++;
        if (rawCentroids[i] && !marker) listOnlyIso3.push(li.item.iso3);
        if (marker) {
          insetPanelParts.push(
            markerTetherSvg("choropleth-inset-footnote-marker", marker, rawCentroids[i], li.item.iso3, num),
            `<circle data-role="choropleth-inset-footnote-marker" data-iso3="${esc(li.item.iso3)}" data-number="${num}" data-anchor-x="${rawCentroids[i].x.toFixed(1)}" data-anchor-y="${rawCentroids[i].y.toFixed(1)}" cx="${marker.x.toFixed(1)}" cy="${marker.y.toFixed(1)}" r="9" fill="${PALETTE.ink}"/>`,
            `<text data-role="choropleth-inset-footnote-marker-label" x="${marker.x.toFixed(1)}" y="${(marker.y + 4).toFixed(1)}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${PAPER}">${num}</text>`
          );
        }
      });
    }
    insetPanelParts.push("</g>");
  }

  // Assemble in final paint order: clip defs, ocean, the inset's own source
  // outline + link (behind data fills and text - task's own house style),
  // land fills, legend, on-map labels, margin/leader labels, the zoom inset
  // panel, then the locator - each later group free to sit visually over an
  // earlier one.
  f.parts.push(`<defs><clipPath id="${clipId}"><rect x="${mapLeft}" y="${top}" width="${mapRight - mapLeft}" height="${bottom - top}"/></clipPath></defs>`);
  // Non-data sea colour used to be a literal matching renderCartographicFlowMap's
  // own hardcoded basemap ocean fill byte-for-byte; now reads PALETTE.faint (the
  // "light panel/background tint between grid and paper" role, the closest
  // live-bound match to that same shade) so it tracks the current style like
  // the rest of this renderer instead of staying frozen while everything
  // around it repaints under house/legacy.
  let noDataDrawn = false;
  f.parts.push(`<rect data-role="choropleth-ocean" x="${mapLeft}" y="${top}" width="${mapRight - mapLeft}" height="${bottom - top}" rx="3" fill="${PALETTE.faint}" stroke="${PALETTE.grid}"/>`);
  f.parts.push(`<g clip-path="url(#${clipId})">`);
  for (let index = 0; index < featureCount; index++) {
    if (worldMode && isAntarcticaFeature(index)) continue;
    const d = featurePath(neFeatureGeometry(index), project, { lon0, lat0: horizonLat0, limitDeg: 90, precision: 1, minDist: 0.5, clipRect: { left: mapLeft, right: mapRight, top, bottom } });
    if (!d) continue;
    const item = dataByIndex.get(index);
    if (!item) noDataDrawn = true;
    const value = item ? n(item.row[spec.value_field]) ?? 0 : undefined;
    const fill = item ? colorForValue(value) : PALETTE.grid;
    // data-iso3/data-value: machine-readable proof for render_qa_labels.mjs's
    // checkChoroplethValueLabels, which independently re-derives from the
    // rows what every region's label ought to say and compares it against
    // the on-map/margin/inset text below - never trusting the plan's own
    // claim that a value is shown.
    const dataAttrs = item ? ` data-iso3="${esc(item.iso3)}" data-value="${value}"` : "";
    f.parts.push(`<path data-role="${item ? "choropleth-data" : "choropleth-context"}"${dataAttrs} d="${d}" fill="${fill}" stroke="${PAPER}" stroke-width="${mobile ? 0.5 : 0.7}" stroke-linejoin="round"/>`);
  }
  // World mode: a numbered marker sitting exactly on its region's dot already marks it, and its digit would cross the dot circle.
  const dotCoveredByMarker = new Set();
  if (worldMode) footnoteItems.forEach((li, i) => { const mk = footnoteMarkerPositions[i], dot = tinyDots.get(li.item.iso3); if (mk && dot && Math.hypot(mk.x - dot.x, mk.y - dot.y) < 1) dotCoveredByMarker.add(li.item.iso3); });
  for (const item of joined) {
    const dot = tinyDots.get(item.iso3);
    if (!dot || dotCoveredByMarker.has(item.iso3)) continue;
    const value = n(item.row[spec.value_field]) ?? 0;
    f.parts.push(`<circle data-role="choropleth-data-dot" data-iso3="${esc(item.iso3)}" data-value="${value}" cx="${dot.x.toFixed(1)}" cy="${dot.y.toFixed(1)}" r="${mobile ? 3 : 3.5}" fill="${colorForValue(value)}" stroke="${PALETTE.ink}" stroke-width=".8"/>`);
  }
  // Review fix (colour ramp/highlight): spec.highlight_values is reserved
  // for an outline only, never a fill change - drawing it as a stroke over
  // the already-filled polygon (same convention every other highlight_values
  // check elsewhere in this file uses: compare against the row's own
  // category_field value, not iso3) keeps the sequential value encoding
  // honest, since a highlighted country's colour still says what its own
  // value is.
  const highlightSet = new Set((spec.highlight_values ?? []).map(String));
  for (const item of joined) {
    if (!highlightSet.has(String(item.row[spec.category_field]))) continue;
    // World mode: a numbered marker already singles the region out, and its digit would sit on the outline stroke.
    if (worldMode && footnoteIso3.has(item.iso3)) continue;
    for (const idx of item.featureIndices) {
      const d = featurePath(neFeatureGeometry(idx), project, { lon0, lat0: horizonLat0, limitDeg: 90, precision: 1, minDist: 0.5, clipRect: { left: mapLeft, right: mapRight, top, bottom } });
      if (!d) continue;
      f.parts.push(`<path data-role="choropleth-highlight-outline" data-iso3="${esc(item.iso3)}" d="${d}" fill="none" stroke="${PALETTE.accent}" stroke-width="1.5"/>`);
    }
  }
  f.parts.push("</g>");

  // Review fix (locator redesign / "make the source rectangle clearly
  // visible"): this used to be drawn before the land-fill group above, so
  // the opaque data polygons painted straight over it everywhere except the
  // sliver of open ocean it happened to cross - effectively invisible over
  // the very region it is meant to mark. Now drawn after that group (still
  // clipped to the map rect, since it sits outside the fill <g> only to
  // outlive that clip's own scope) in the same dark-grey, 1px stroke the
  // inset panel's own frame uses, so it reads as a real "this is what's
  // magnified" marker regardless of what colour class sits underneath it.
  if (sourceOutline) {
    f.parts.push(`<rect data-role="choropleth-inset-source" x="${sourceOutline.x.toFixed(1)}" y="${sourceOutline.y.toFixed(1)}" width="${sourceOutline.w.toFixed(1)}" height="${sourceOutline.h.toFixed(1)}" fill="none" stroke="${PALETTE.muted}" stroke-width="1"/>`);
  }
  if (sourceOutline && insetLetter) {
    const ly = sourceOutline.y - 17 >= top ? sourceOutline.y - 17 : sourceOutline.y + sourceOutline.h + 1;
    f.parts.push(letterTagSvg("choropleth-inset-source-letter", Math.min(mapRight - 16, Math.max(mapLeft, sourceOutline.x)), ly, insetLetter));
  }
  if (insetLinkPath) {
    f.parts.push(`<path data-role="choropleth-inset-link" d="${insetLinkPath}" fill="none" stroke="${LEADER_STYLE.color}" stroke-width="${LEADER_STYLE.width}"/>`);
  }

  // Legend (review fix): the unit now shown once, as a title above the
  // swatches, rather than only on the last tick - every tick is a plain
  // number. Falls back to spec.title when the spec carries no dedicated
  // legend_title (which alone doesn't force every future spec to define one
  // that this renderer would otherwise have no sensible content for).
  const legendY = bottom + insetStripH + 22;
  const legendW = Math.min(mobile ? 240 : 320, plotRight - plotLeft);
  const legendStep = legendW / CHOROPLETH_RAMP.length;
  // The legend names the measure being coloured, never the chart title (which
  // sits right above the map and would only repeat itself): an explicit
  // legend_title, else the measure's own label from measure_semantics, else
  // just its unit.
  const measureEntry = Array.isArray(spec.measure_semantics)
    ? spec.measure_semantics.filter((m) => m && typeof m === "object").find((m) => m.field && m.field === spec.value_field) ?? null
    : null;
  const measureName = String(measureEntry?.label ?? measureEntry?.name ?? measureEntry?.title ?? "").trim();
  const legendTitleBase = String(spec.legend_title ?? measureName ?? "").trim();
  const legendTitle = legendTitleBase
    ? spec.unit && !legendTitleBase.includes(spec.unit) ? `${legendTitleBase}（${spec.unit}）` : legendTitleBase
    : String(spec.unit ?? "").trim();
  f.parts.push('<g data-role="choropleth-legend">');
  if (legendTitle) {
    f.parts.push(`<text data-role="choropleth-legend-title" x="${plotLeft}" y="${legendY - 8}" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${PALETTE.ink}">${esc(legendTitle)}</text>`);
  }
  // Whole-number measures (years, counts): the class edges are only bin
  // bounds, so the top edge (e.g. 2018 for data ending in 2017) names a value
  // no region has. The legend therefore stops at the class holding the data
  // max: no swatch or tick is drawn for a class above it (a single value gets
  // one swatch labelled with that value, never a 5..9 scale). Swatches, ticks
  // and the displayed range all come from the same shownClasses, so they
  // cannot disagree. One value per class: each swatch is labelled with its own
  // value (centred); wider classes: the last edge is capped at the data max
  // when the max falls inside that class (classifyValue puts a value equal to
  // a lower bound in the class that starts there).
  const legendIntegerData = Boolean(specValueKind(spec)) && values.length > 0 && values.every(Number.isInteger);
  const legendDataMax = legendIntegerData ? Math.max(...values) : null;
  const legendOneValuePerClass = legendIntegerData && breaks.length > 1 && breaks.every((b, i) => i === 0 || b - breaks[i - 1] === 1);
  const legendClassCount = breaks.length - 1;
  // Every region has the same value (one region, or all equal): one swatch
  // labelled with that value, whatever the measure kind.
  const legendSingleValue = values.length > 0 && values.every((v) => v === values[0]);
  const shownClasses = legendSingleValue ? 1 : legendIntegerData ? Math.min(legendClassCount, Math.max(1, classifyValue(legendDataMax, breaks) + 1)) : legendClassCount;
  CHOROPLETH_RAMP.slice(0, shownClasses).forEach((c, i) => {
    f.parts.push(`<rect x="${(plotLeft + i * legendStep).toFixed(1)}" y="${legendY}" width="${(legendStep - 2).toFixed(1)}" height="12" fill="${c}"/>`);
  });
  const legendTick = (edgeValue, x, anchor, unit) =>
    `<text x="${x.toFixed(1)}" y="${legendY + 26}" text-anchor="${anchor}" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(fmtSpec(spec, edgeValue, unit))}</text>`;
  if (legendSingleValue) {
    f.parts.push(legendTick(values[0], plotLeft + 0.5 * legendStep, "middle", spec.unit));
  } else if (classPlan.skewed) {
    // Open-ended classes: the outer edges are only the data min/max, so they
    // are never printed; the first and last swatches say "<e1" and ">=e4".
    const e1 = breaks[1], e4 = breaks[breaks.length - 2];
    f.parts.push(legendTick(e1, plotLeft + 0.5 * legendStep, "middle", "").replace(/>([^<]*)<\/text>/, (m, t) => `>&lt;${t}</text>`));
    for (let i = 2; i < breaks.length - 2; i++) f.parts.push(legendTick(breaks[i], plotLeft + i * legendStep, "middle", ""));
    f.parts.push(legendTick(e4, plotLeft + (legendClassCount - 0.5) * legendStep, "middle", spec.unit).replace(/>([^<]*)<\/text>/, (m, t) => `>\u2265${t}</text>`));
  } else if (legendOneValuePerClass) {
    for (let i = 0; i < shownClasses; i++) {
      f.parts.push(legendTick(breaks[i], plotLeft + (i + 0.5) * legendStep, "middle", i === shownClasses - 1 ? spec.unit : ""));
    }
  } else {
    // The end-anchored last label carries the unit and can reach back over the
    // previous tick; that interior tick is left unlabelled (its swatch edge
    // stays) rather than printed on top of it.
    const tickText = (i) => {
      const isLast = i === shownClasses;
      const v = isLast && legendIntegerData && legendDataMax > breaks[i - 1] ? Math.min(breaks[i], legendDataMax) : breaks[i];
      return fmtSpec(spec, v, isLast ? spec.unit : "");
    };
    const lastLeft = plotLeft + shownClasses * legendStep - 2 - (choroplethLabelWidth(tickText(shownClasses), 12) - 8);
    for (let i = 0; i <= shownClasses; i++) {
      const isLast = i === shownClasses;
      const x = plotLeft + i * legendStep;
      if (i === shownClasses - 1 && i > 0 && x + (choroplethLabelWidth(tickText(i), 12) - 8) / 2 + 4 > lastLeft) continue;
      const shown = isLast && legendIntegerData && legendDataMax > breaks[i - 1] ? Math.min(breaks[i], legendDataMax) : breaks[i];
      f.parts.push(legendTick(shown, isLast ? x - 2 : x, isLast ? "end" : "middle", isLast ? spec.unit : ""));
    }
  }
  f.parts.push("</g>");
  if (noDataDrawn && !mobile && !isRowSlice(spec)) {
    // Regions drawn without a value are filled PALETTE.grid; name that fill.
    // Its own group, so the legend group still holds only the class swatches.
    const ndX = plotLeft + legendStep * CHOROPLETH_RAMP.length + 18;
    f.parts.push(`<g data-role="choropleth-no-data"><rect data-role="choropleth-no-data-swatch" x="${ndX.toFixed(1)}" y="${legendY}" width="${(legendStep - 2).toFixed(1)}" height="12" fill="${PALETTE.grid}"/>`);
    f.parts.push(`<text data-role="choropleth-no-data-label" x="${(ndX + (legendStep - 2) / 2).toFixed(1)}" y="${legendY + 26}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" fill="${PALETTE.muted}">${esc(VIZ_STRINGS[lang].noData)}</text></g>`);
  }

  f.parts.push(...onMapParts);
  f.parts.push(...overflowParts);
  f.parts.push(...footnoteParts);
  if (listOnlyIso3.length) {
    f.parts.push(`<g data-role="choropleth-marker-list-only" data-count="${listOnlyIso3.length}" data-total="${markerTotal}" data-iso3="${esc(listOnlyIso3.join(","))}"/>`);
  }
  f.parts.push(...insetPanelParts);
  f.parts.push(...locatorParts);

  // Review fix (year note clarity): state which countries use which year,
  // rather than an ambiguous flat list of years - the majority period (by
  // country count; ties keep the first one seen) becomes the sentence's own
  // default, and every other period is named explicitly by its own
  // countries. Built off a shallow clone so the real spec object (read
  // everywhere else) is untouched.
  let yearsNote = "";
  if (periodGroups.size > 1) {
    let majorityPeriod = null, majorityCount = -1;
    for (const [period, names] of periodGroups) {
      if (names.length > majorityCount) { majorityCount = names.length; majorityPeriod = period; }
    }
    const exceptions = [...periodGroups.entries()].filter(([period]) => period !== majorityPeriod);
    if (lang === "zh") {
      const parts = exceptions.map(([period, names]) => `${names.join("、")}为 ${period} 年`);
      yearsNote = [`数据为 ${majorityPeriod} 年`, ...parts].join("；");
    } else {
      const parts = exceptions.map(([period, names]) => `${names.join(", ")}: ${period}`);
      yearsNote = [`Data as of ${majorityPeriod}`, ...parts].join("; ");
    }
  }
  // Review fix (legend/credit placement): the basemap credit moves out from
  // under the legend into the footer's own source line, rather than sitting
  // as a second, disconnected attribution line on the map body.
  const basemapCredit = lang === "zh" ? "底图：Natural Earth" : "Basemap: Natural Earth";
  let framingNote = "";
  if (clippedTerritoryItems.length) {
    const shownNames = clippedTerritoryItems.slice(0, 3).map((item) => resolveEconomyDisplayName(item.raw, spec.category_names, lang));
    const more = clippedTerritoryItems.length > shownNames.length;
    framingNote = lang === "zh"
      ? `${shownNames.join("、")}${more ? "等" : ""}的远离本土的岛屿等领土在此范围外，未画出。`
      : `Distant territories of ${shownNames.join(", ")}${more ? " and others" : ""} lie outside this frame and are not drawn.`;
  }
  const listOnlyNote = listOnlyIso3.length
    ? (lang === "zh" ? `另有 ${listOnlyIso3.length} 个地区因位置过密未在图上标号，见下方列表。` : `${listOnlyIso3.length} more region(s) are too crowded to number on the map; see the list below.`)
    : "";
  const effectiveSpec = {
    ...spec,
    note: [spec.note, yearsNote, framingNote, listOnlyNote].filter(Boolean).join(" "),
    source_note: [spec.source_note, basemapCredit].filter(Boolean).join(" · "),
  };
  (mobile ? addMobileFooter : addFooter)(f.parts, effectiveSpec, f.footerTop);
  f.parts.push("</svg>");
  meta.listOnly = listOnlyIso3.length;
  meta.markerTotal = markerTotal;
  meta.hasInset = insetIso3Set.size > 0;
  return f.parts.join("\n") + "\n";
}

export function renderVizMobileSvg(spec, rows) {
  spec = resolveAutoCategoryNames(spec, rows)?.spec ?? spec;
  const errors=validateVizSpec(spec); if(errors.length) throw new Error(errors.join("; "));
  applyStyle(spec);
  switch(spec.chart_type){
    case "horizontal_bar": return renderMobileHorizontal(spec,rows,"bar");
    case "dot": return renderMobileHorizontal(spec,rows,"dot");
    case "diverging_bar": return renderMobileHorizontal(spec,rows,"bar");
    case "dumbbell": return renderMobileDumbbell(spec,rows);
    case "mirrored_bar": return renderMirroredBar(spec,rows);
    case "slope": return renderMobileSlope(spec,rows);
    case "line": return renderMobileLine(spec,rows,false);
    case "multi_line": return renderMobileLine(spec,rows,true);
    case "small_multiples": return renderMobileSmallMultiples(spec,rows);
    case "scatter": return renderMobileScatter(spec,rows);
    case "strip_plot": return renderStripPlot(spec,rows);
    case "heatmap": return renderMobileHeatmap(spec,rows);
    case "sankey": return renderSankey(spec,rows,true);
    case "alluvial": return renderSankey(spec,rows,true);
    case "node_link": return renderNodeLink(spec,rows,true);
    case "adjacency_matrix": return renderAdjacencyMatrix(spec,rows,true);
    case "hierarchy_tree": return renderHierarchyTree(spec,rows,true);
    case "timeline": return renderTimeline(spec,rows,true);
    case "streamgraph": return renderStreamgraph(spec,rows,true);
    case "parallel_sets": return renderParallelSets(spec,rows,true);
    case "chord": return renderChord(spec,rows,true);
    case "geo_flow_map": return renderGeoFlowMap(spec,rows,true);
    case "cartographic_flow_map": return renderCartographicFlowMap(spec,rows,true);
    case "trajectory_profile": return renderTrajectoryProfile(spec,rows,true);
    case "process_schematic": return renderProcessSchematic(spec,rows,true);
    case "waffle": return spec.waffle_layout === "single_grid" ? renderWaffleSingleGrid(spec, rows, true) : renderWaffle(spec, rows, true);
    case "choropleth": return renderChoropleth(spec, rows, true);
    case "treemap": return renderTreemap(spec, rows, true);
    case "stacked_bar_100": return renderStackedBar100(spec, rows);
    default: throw new Error(`Mobile renderer does not support '${spec.chart_type}'`);
  }
}

// The 8-of-12-column chart. 822 is the pixel width of an 8-column slot on the
// 1440px infographic page (see infographic.mjs layoutDesktop), so the page
// embeds this SVG at scale ~1.0 and the chart keeps its 12px house-style text.
export const COMPACT_VIEW_W = 822;
// Only these are re-laid out for the slot; any other chart type has no
// compact variant, so the page lint keeps blocking it in a narrow slot.
export const COMPACT_CHART_TYPES = new Set(["horizontal_bar", "line", "multi_line"]);

export function hasCompactVariant(spec) {
  return COMPACT_CHART_TYPES.has(spec?.chart_type);
}

// The same desktop renderers, re-laid out (not scaled) for COMPACT_VIEW_W.
export function renderVizCompactSvg(spec, rows) {
  if (!hasCompactVariant(spec)) throw new Error(`No compact variant for chart_type '${spec?.chart_type}'`);
  const previousLayoutW = LAYOUT_W;
  LAYOUT_W = COMPACT_VIEW_W;
  try {
    return renderVizSvg(spec, rows);
  } finally {
    LAYOUT_W = previousLayoutW;
  }
}

// compact: also render the 8-column variant (desktop-only pages; the caller
// decides). Absent unless asked for, so every existing caller is unchanged.
export function renderVizBundle(spec, rows, { mobilePages = true, compact = false } = {}) {
  const desktop = renderVizSvg(spec, rows);
  const bundle = mobilePages ? { desktop, mobile: renderVizMobileSvg(spec, rows) } : { desktop };
  if (compact && hasCompactVariant(spec)) bundle.compact = renderVizCompactSvg(spec, rows);
  return bundle;
}

export function renderVizSvg(spec, rows) {
  spec = resolveAutoCategoryNames(spec, rows)?.spec ?? spec;
  const errors = validateVizSpec(spec);
  if (errors.length) throw new Error(errors.join("; "));
  applyStyle(spec);
  switch (spec.chart_type) {
    case "horizontal_bar": return renderHorizontal(spec, rows, "bar");
    case "dot": return renderHorizontal(spec, rows, "dot");
    case "diverging_bar": return renderHorizontal(spec, rows, "bar");
    case "dumbbell": return renderDumbbell(spec, rows);
    case "mirrored_bar": return renderMirroredBar(spec, rows);
    case "slope": return renderSlope(spec, rows);
    case "line": return renderLine(spec, rows, false);
    case "multi_line": return renderLine(spec, rows, true);
    case "small_multiples": return renderSmallMultiples(spec, rows);
    case "scatter": return renderScatter(spec, rows);
    case "strip_plot": return renderStripPlot(spec, rows);
    case "heatmap": return renderHeatmap(spec, rows);
    case "sankey": return renderSankey(spec, rows, false);
    case "alluvial": return renderSankey(spec, rows, false);
    case "node_link": return renderNodeLink(spec, rows, false);
    case "adjacency_matrix": return renderAdjacencyMatrix(spec, rows, false);
    case "hierarchy_tree": return renderHierarchyTree(spec, rows, false);
    case "timeline": return renderTimeline(spec, rows, false);
    case "streamgraph": return renderStreamgraph(spec, rows, false);
    case "parallel_sets": return renderParallelSets(spec, rows, false);
    case "chord": return renderChord(spec, rows, false);
    case "geo_flow_map": return renderGeoFlowMap(spec, rows, false);
    case "cartographic_flow_map": return renderCartographicFlowMap(spec, rows, false);
    case "trajectory_profile": return renderTrajectoryProfile(spec, rows, false);
    case "process_schematic": return renderProcessSchematic(spec, rows, false);
    case "waffle": return spec.waffle_layout === "single_grid" ? renderWaffleSingleGrid(spec, rows, false) : renderWaffle(spec, rows, false);
    case "choropleth": return renderChoropleth(spec, rows, false);
    case "treemap": return renderTreemap(spec, rows, false);
    case "stacked_bar_100": return renderStackedBar100(spec, rows);
    default: throw new Error(`Renderer does not support '${spec.chart_type}'`);
  }
}
