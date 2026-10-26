import { createHash } from "node:crypto";
import { gatedFormOn } from "./symbol_map_switch.mjs";
import { isWideChar, wrapText, wrapHeadline, HOUSE_FONT_SANS, houseFontSans, tabularRootAttrs, COMPACT_VIEW_W, hasWidthVariant, renderVizSvgAtWidth } from "./viz.mjs";
import { MIN_FONT_SIZE_FLOOR } from "./render_qa_geometry.mjs";
import { COMPETITION_PROFILE_IDS } from "./competition.mjs";
import { storyboardEnabled, isPanel, hasPanels, panelFieldErrors, storyboardPageErrors, storyboardBlockers, pageStyleBlockers, expandPanels, STORYBOARD_MODULE_CAP, PANEL_NOTE_LINES } from "./storyboard.mjs";
import { evaluateQuestionClosure, STORY_DIMENSIONS, unsupportedDimensionError } from "./story_graph.mjs";
import { COGNITIVE_GOALS, runEditorialValidators } from "./editorial_validators.mjs";
import { evaluateClaimSupport } from "./evidence_gate.mjs";
import { scoreSemanticNovelty } from "./editorial.mjs";
import { buildCandidates, extractNumbers, matchNumber } from "./number_shadow.mjs";
import { trackExport } from "./groups.mjs";

// Fix 7 (house style wiring): page chrome - header/footer rules, kickers,
// section heads, body text, pull quotes, the sources footer - now follows
// runtime/pi/viz.mjs's house palette by default, so a composed page matches
// the charts embedded in it.
//
// Fix 9 (hero_stat restyle, its own separate/droppable commit): under house
// style, hero_stat no longer draws its old solid tone-coloured card at all
// (see drawHeroStat) - the LEGACY_INK/LEGACY_MUTED/LEGACY_ACCENT/FAINT/DARK
// constants below now serve *only* hero_stat's legacy-style rendering
// (style_id/style:"legacy"), which stays byte-for-byte on these exact old
// values, tone included.
//
// Fix 12 (font unification): LEGACY_SANS/LEGACY_SERIF are the same Arial/
// Georgia stacks this file always used, renamed to match the LEGACY_* colour
// constants' own naming; style_id/style:"legacy" still resolves to exactly
// these two, byte-for-byte. House style instead collapses both to viz.mjs's
// own HOUSE_FONT_SANS (imported below, not re-declared here - "don't create a
// new constant" per the user's font decision): one CJK sans stack for page
// title, section heads, chart titles, hero numerals, body text and chart
// labels alike, weight (700/400) carrying the hierarchy a second typeface
// used to. Importing HOUSE_FONT_SANS carries none of the leakage risk the
// comment below warns about for the HOUSE_* colours: unlike viz.mjs's
// mutable PALETTE, it is a plain, never-reassigned exported const.
const LEGACY_INK = "#1d2329";
const LEGACY_MUTED = "#69727a";
const LEGACY_GRID = "#d9dde1";
const FAINT = "#f4f2ee";
const LEGACY_ACCENT = "#c9473d";
const DARK = "#24313a";
const LEGACY_PAPER = "#fffdf9";
const LEGACY_SANS = "Arial, Helvetica, sans-serif";
const LEGACY_SERIF = "Georgia, 'Times New Roman', serif";

// Same hex values as runtime/pi/viz.mjs's HOUSE_PALETTES.house (paper/ink/
// muted/grid/accent) - kept as separate constants here rather than an
// import, since importing them would need viz.mjs to export its mutable
// per-render style state too (PALETTE/applyStyle/HOUSE_STYLE_ACTIVE are not
// exported, and are reassigned by whichever chart last rendered - reading
// them from here would make a page's own chrome depend on unrelated prior
// viz.mjs calls' leftover state rather than this page's own spec).
const HOUSE_INK = "#1A1A1A";
const HOUSE_MUTED = "#666666";
const HOUSE_GRID = "#E5E5E5";
const HOUSE_ACCENT = "#D0021B";
const HOUSE_PAPER = "#FFFFFF";

// Mutable "current style" bindings, mirroring viz.mjs's own PALETTE/
// applyStyle pattern: reassigned once per render by applyInfographicStyle,
// read via plain identifier by every drawing function below. Safe for the
// same reason viz.mjs's own comment gives for PALETTE - composeOne (this
// file's only synchronous render entry point; see composeInfographicBundle)
// runs start-to-finish with no other exported function touching these
// bindings in between. "house" is the default; style_id/style: "legacy"
// restores today's exact chrome colours.
let INK = LEGACY_INK;
let MUTED = LEGACY_MUTED;
let GRID = LEGACY_GRID;
let ACCENT = LEGACY_ACCENT;
let PAPER = LEGACY_PAPER;
let SANS = LEGACY_SANS;
let SERIF = LEGACY_SERIF;
// Mirrors viz.mjs's own HOUSE_STYLE_ACTIVE: set alongside the colours above,
// read by lines()/headline-mode wrapping (fix 8) to decide whether a title
// or section heading gets the new punctuation-aware/balanced break instead
// of plain greedy wrapText. Local to this module for the same reason the
// colours above are - reading viz.mjs's own flag here would depend on
// whichever chart rendered last, not this page's own spec.
let INFOGRAPHIC_HOUSE_STYLE_ACTIVE = false;

// Mirrors viz.mjs's styleFor exactly (same precedence, same
// "legacy"/"default" trigger strings) so one style_id/style:"legacy"
// value reverts a whole page - its charts and its own chrome - together.
// style_id/style is not part of schemas/infographic-spec.schema.json (an
// additionalProperties:false schema), so a real, schema-validated spec can
// never set it - exactly the pre-existing relationship between viz.mjs's
// own styleFor and schemas/newsroom-viz-spec.schema.json, which does not
// declare style_id either. Kept here for the same reason viz.mjs keeps it:
// direct-call testability and manual override, without a schema change.
function infographicStyleFor(spec) {
  const requested = spec?.style_id ?? spec?.style;
  if (requested === "legacy" || requested === "default") return "legacy";
  if (requested === "house") return "house";
  return "house";
}

function applyInfographicStyle(spec) {
  const style = infographicStyleFor(spec);
  if (style === "legacy") {
    INK = LEGACY_INK; MUTED = LEGACY_MUTED; GRID = LEGACY_GRID; ACCENT = LEGACY_ACCENT; PAPER = LEGACY_PAPER;
    SANS = LEGACY_SANS; SERIF = LEGACY_SERIF;
  } else {
    INK = HOUSE_INK; MUTED = HOUSE_MUTED; GRID = HOUSE_GRID; ACCENT = HOUSE_ACCENT; PAPER = HOUSE_PAPER;
    // Fix 12: all sans under house style - SERIF collapses onto the same CJK
    // stack as SANS instead of keeping its own (formerly Georgia-only) face,
    // so every page-chrome text element reads one typeface family.
    SANS = houseFontSans(); SERIF = houseFontSans();
  }
  INFOGRAPHIC_HOUSE_STYLE_ACTIVE = style !== "legacy";
  return style;
}

export const INFOGRAPHIC_SCHEMA_VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"];
export const INFOGRAPHIC_MODULE_TYPES = ["hero_stat", "visual", "illustration", "text", "section_header", "pull_quote"];
// NEWSROOM_TOOL_ERROR_HINTS=1 (exact "1", default off): the story_node_ids field says before the call when it is required. The versions and module types
// are the ones the story_node_ids check in validateInfographicSpec reads (the same constants); scripts/test_tool_error_hints_rules.mjs pins them and probes the validator against this text.
export const STORY_NODE_IDS_REQUIRED_VERSIONS = ["1.4.0", "1.5.0"];
export const STORY_NODE_IDS_REQUIRED_TYPES = ["visual", "illustration", "hero_stat", "text"];
export const storyNodeIdsRequiredText = () => `Always required (at least 1 id) on every ${STORY_NODE_IDS_REQUIRED_TYPES.join(", ")} module: this tool writes the plan at the schema version the validator checks (InfographicSpec ${STORY_NODE_IDS_REQUIRED_VERSIONS.join(" and ")} both require it); ids of nodes that exist in the story graph.`;
export const INFOGRAPHIC_SPANS = ["full", "two_thirds", "half", "third"];
export const INFOGRAPHIC_LAYOUTS = ["feature", "poster", "briefing"];
export const INFOGRAPHIC_STORY_ARCS = ["explain", "compare", "chronology", "system", "question_answer", "profile"];
export const INFOGRAPHIC_AUDIENCES = ["general", "informed", "specialist"];
export const INFOGRAPHIC_QUALITY_TARGETS = ["publishable", "award"];
export const INFOGRAPHIC_STORY_ROLES = ["hook", "context", "evidence", "turn", "explanation", "resolution", "method"];
export const INFOGRAPHIC_EMPHASIS = ["hero", "primary", "secondary", "support"];
export const INFOGRAPHIC_DEFAULT_EMPHASIS = "secondary";
export const INFOGRAPHIC_DEFAULT_QUALITY_TARGET = "publishable";
// Critic pass score and the floor every rubric dimension must reach, per quality_target (award adds further checks).
export const INFOGRAPHIC_QUALITY_THRESHOLDS = { publishable: { pass: 88, dimension_floor: 72 }, award: { pass: 92, dimension_floor: 78 } };
// What the semantic-novelty comparison needs on a module; a module without all of them is left out and counted in a note.
export const SEMANTIC_NOVELTY_INPUTS = ["reader_question_id", "claim set", "new_information", "explanatory_dimension"];
export const INFOGRAPHIC_LAYOUT_STRATEGIES = ["balanced", "anchor", "rhythm"];
// NEWSROOM_GUIDE_ERRORS=1 (exact "1", default off): the two width blockers below say which layout can hold the module. Only the text changes; what is blocked does not.
const guideErrors = () => process.env.NEWSROOM_GUIDE_ERRORS === "1";
// The story roles whose modules count as the resolution of an answer node, for the refusal text; the check below lists the same two roles and a test reads the text back against the check.
const RESOLUTION_STORY_ROLES = ["resolution", "explanation"];
// NEWSROOM_TOOL_ERROR_HINTS=1 (exact "1", default off): the three reader-question closure blockers name the node ids still missing and where to put them. Only the text changes; what is blocked does not.
const closureHint = (code, missing, fix) => (process.env.NEWSROOM_TOOL_ERROR_HINTS === "1" ? `${code}: ${fix} Missing: ${missing.join(", ")}.` : code);
const NARROW_HINT = (kind, chartType, compact, cols) => compact
  ? `this ${chartType} chart has an 8-column variant, but only as the anchor of a 'hero_sidecar_stack' scene (anchor 8 of 12 columns, sidecar 4, the scene sets the width and the module span stays 'full'); ${cols ? `here it gets ${cols}` : "anywhere else"} it must be full width (a 'hero_with_rail' anchor draws its rail below the chart, not beside it)`
  : `this ${chartType || kind} has no 8-column variant, so it cannot sit beside a sidecar: use it as the anchor of a 'hero_with_rail' scene (its rail is drawn below the chart, not beside it) or on a row of its own`;
export const INFOGRAPHIC_SCENE_PATTERNS = ["hero_sidecar_stack", "hero_with_rail"];
// Same vocabulary as the story graph (see story_graph.mjs).
export const INFOGRAPHIC_EXPLANATORY_DIMENSIONS = [...STORY_DIMENSIONS];
export const INFOGRAPHIC_VISUAL_GRAMMARS = ["rank", "change", "trend", "anomaly", "benchmark", "composition", "distribution", "relationship", "uncertainty", "flow", "spatial", "network", "mechanism", "sequence"];

// The forms that exist only behind a switch travel with the table as pure data, `VISUAL_GRAMMAR_FORMS.gatedForms` (not enumerable, so nothing that walks the table
// sees it): { grammar: { form: "SWITCH_FORM" } }. The table itself holds only the always-on forms, so a reader that forgets the filter sees fewer forms, never more.
// Each group builds what its run allows by reading its own environment, exact "1" per switch (scripts/test_switch_read_sites.mjs scans these reads).
export const VISUAL_GRAMMAR_FORMS = Object.freeze(Object.defineProperty({
  rank: new Set(["horizontal_bar", "dot"]),
  change: new Set(["dumbbell", "slope"]),
  trend: new Set(["line", "multi_line", "small_multiples", "streamgraph"]),
  anomaly: new Set(["diverging_bar", "dot", "small_multiples"]),
  benchmark: new Set(["dot", "dumbbell", "horizontal_bar"]),
  composition: new Set(["horizontal_bar", "heatmap", "parallel_sets", "alluvial", "waffle", "stacked_bar_100"]),
  distribution: new Set(["dot", "heatmap", "small_multiples", "strip_plot", "mirrored_bar"]),
  relationship: new Set(["scatter", "node_link", "chord"]),
  uncertainty: new Set(["line", "multi_line", "small_multiples"]),
  flow: new Set(["sankey", "alluvial", "parallel_sets", "geo_flow_map", "cartographic_flow_map"]),
  spatial: new Set(["geo_flow_map", "cartographic_flow_map", "choropleth"]),
  network: new Set(["node_link", "adjacency_matrix", "chord"]),
  mechanism: new Set(["process_schematic"]),
  sequence: new Set(["timeline", "trajectory_profile", "line"]),
}, "gatedForms", { enumerable: false, value: Object.freeze({
  composition: Object.freeze({ people_dots: "NEWSROOM_STORY_FORMS" }),
  spatial: Object.freeze({ tile_map: "NEWSROOM_TILE_MAP", symbol_map: "NEWSROOM_SYMBOL_MAP" }),
  sequence: Object.freeze({ clock_dial: "NEWSROOM_STORY_FORMS" }),
}) }));
const ACTIVE_GRAMMAR_FORMS = Object.freeze(Object.fromEntries(Object.entries(VISUAL_GRAMMAR_FORMS).map(([grammar, forms]) => [grammar, new Set([...forms, ...Object.entries(VISUAL_GRAMMAR_FORMS.gatedForms[grammar] ?? {}).filter(([, name]) => gatedFormOn(name, process.env)).map(([form]) => form)])])));
// symbol_map on the page-lint side (K1055): the table's own active set, read once at module load (symbol_map: on unless exactly "0"; the other forms exactly "1"; through gatedFormOn). newsroom.ts derives the same value from its own copy of
// the table for its strict relation table and the chart_type enum; scripts/test_symbol_map_grammar.mjs pins the two equal in every switch state.
export const SYMBOL_MAP_GRAMMAR_ON = ACTIVE_GRAMMAR_FORMS.spatial.has("symbol_map");

// NEWSROOM_LEAN_GATES=1 (exact "1", default off): the lean legacy-gate path (K258). Off: nothing changes.
export function leanGatesEnabled(env = process.env) { return env.NEWSROOM_LEAN_GATES === "1"; }

// One-chart routing (K729): the page tool text says what to pair with a single requested chart. The request routing is read in src/prompt.rs.
export function oneChartRoutingEnabled(env = process.env) { return env.NEWSROOM_ONE_CHART_ROUTING !== "0"; }

// Lean gates (K258): the semantic-novelty check lives in lint and only warns. The page's own modules carry what it compares
// (reader_question_id, claim set, new_information, explanatory_dimension); a module without them is left out and counted in a note.
export function semanticNoveltyFindings(modules) {
  const candidates = [];
  for (const m of modules ?? []) {
    if (!m || m.type === "section_header" || m.type === "panel") continue;
    const claim_set = Array.isArray(m.claim_set) && m.claim_set.length ? m.claim_set : [m.claim_id, ...(m.claim_ids ?? [])].filter(Boolean);
    if (!m.reader_question_id || !claim_set.length || !m.new_information || !m.explanatory_dimension) continue;
    candidates.push({ id: String(m.id), reader_question_id: m.reader_question_id, claim_set, new_information: m.new_information, explanatory_dimension: m.explanatory_dimension, dependency_on: m.dependency_on ?? [], justification: m.justification });
  }
  const skipped = (modules ?? []).filter((m) => m && m.type !== "section_header" && m.type !== "panel").length - candidates.length;
  const note = skipped > 0 ? [`semantic_novelty: ${skipped} module(s) have no reader_question_id, claim set, new_information or explanatory_dimension and were not compared`] : [];
  if (candidates.length < 2) return { warnings: [], notes: note.length ? note : [] };
  let report;
  try { report = scoreSemanticNovelty({ modules: candidates }); } catch (error) { return { warnings: [], notes: [...note, `semantic_novelty: not computed (${String(error?.message ?? error).slice(0, 160)})`] }; }
  const warnings = report.decisions.filter((d) => d.redundancy === "medium" || (d.redundancy === "high" && d.action !== "KEEP_WITH_JUSTIFICATION"))
    .map((d) => `semantic_novelty: module '${d.module_id}' overlaps '${d.overlaps_most_with}' (${d.max_overlap}, ${d.redundancy}); ${d.redundancy === "high" ? "remove it, demote it or justify it" : "consider demoting it"}`);
  return { warnings, notes: note };
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function uniq(values) { return [...new Set(values.filter(Boolean).map(String))]; }
function hash(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }

// A generic, topic-blind verbatim quote check for a saved source's text
// (runtime/pi/pdf_extract.mjs's `[page N]\n...` marker convention for PDFs;
// a source with no such markers - HTML/plain-text extraction - has no page
// concept, so it collapses to a single implicit page 1, keeping every
// source_quote module shaped identically regardless of source format).
// Normalization is deliberately narrow - whitespace-collapse and
// line-break-hyphenation joins only - nothing semantic, so a lint/verifier
// pass here can never paper over an edited quote.
export function normalizeSourceQuoteText(value) {
  return String(value ?? "").replace(/-\n/g, "").replace(/\s+/g, " ").trim();
}

export function extractSourcePageText(sourceText, page) {
  const text = String(sourceText ?? "");
  const marker = /\[page (\d+)\]\n/g;
  const marks = [];
  let m;
  while ((m = marker.exec(text))) marks.push({ page: Number(m[1]), start: m.index, contentStart: marker.lastIndex });
  if (marks.length === 0) return Number(page) === 1 ? text : null;
  const index = marks.findIndex((mk) => mk.page === Number(page));
  if (index === -1) return null;
  const end = index + 1 < marks.length ? marks[index + 1].start : text.length;
  return text.slice(marks[index].contentStart, end);
}

export function sourceQuoteMatches(sourceText, page, quote) {
  const pageText = extractSourcePageText(sourceText, page);
  if (pageText === null) return false;
  const needle = normalizeSourceQuoteText(quote);
  if (!needle) return false;
  return normalizeSourceQuoteText(pageText).includes(needle);
}

// A text module's body/heading sit right beside its source_quote, but
// neither is bound to the quote or to any claim - so, unlike an ordinary
// claim_ids-backed text module (which can carry up to 900 characters of
// claim-bound prose), free text next to a source quote must never be able
// to read like a verified number of its own: short, and no digits (ASCII
// or full-width) or percent signs. Mirrored exactly in src/verify.rs and
// scripts/verify_artifact.py so both independent verifiers reject the same
// inputs the lint does.
const SOURCE_QUOTE_PROSE_MAX_CHARS = 60;
const SOURCE_QUOTE_PROSE_FORBIDDEN = /[0-9０-９%]/;
export function sourceQuoteProseFieldErrors(moduleId, field, value) {
  const errors = [];
  const text = String(value ?? "");
  if (text.length > SOURCE_QUOTE_PROSE_MAX_CHARS) errors.push(`text module '${moduleId}' source_quote ${field} must be at most ${SOURCE_QUOTE_PROSE_MAX_CHARS} characters`);
  if (SOURCE_QUOTE_PROSE_FORBIDDEN.test(text)) errors.push(`text module '${moduleId}' source_quote ${field} must not contain digits or a percent sign: a source-only note must never look like a verified figure`);
  return errors;
}

// Page language (B1, mirrors runtime/pi/viz.mjs's vizLang): defaults to
// "en". Gates the functional chrome labels this composer adds on its own
// (kicker/hero/eyebrow defaults, the byline prefix, the sources footer
// heading). Brand strings ("AGENTIC DATA NEWSROOM ...") are deliberately
// left out of this table and stay in English on every page.
function pageLang(spec) {
  return spec?.language === "zh" ? "zh" : "en";
}
const INFOGRAPHIC_STRINGS = {
  en: { kicker: "DATA FEATURE", primaryVisual: "PRIMARY VISUAL", theStory: "THE STORY", byPrefix: "By ", sourcesMethods: "SOURCES &amp; METHODS", sourceQuoteLabel: "SOURCE QUOTE", sourceQuotePage: "p.", sourceQuoteTranslation: "translation" },
  zh: { kicker: "数据专题", primaryVisual: "核心图示", theStory: "新闻故事", byPrefix: "撰稿：", sourcesMethods: "资料来源与方法", sourceQuoteLabel: "原文引述", sourceQuotePage: "页码", sourceQuoteTranslation: "译述" },
};
// True if `svg` visibly carries the localized "sources & methods" footer
// heading for this spec's page language. English keeps checking both the
// escaped and literal ampersand spellings the SVG string builder can emit;
// zh's heading has no ampersand to escape.
function hasSourcesMethodsLabel(svg, spec) {
  const t = INFOGRAPHIC_STRINGS[pageLang(spec)];
  return pageLang(spec) === "zh" ? svg.includes(t.sourcesMethods) : (svg.includes("SOURCES &amp; METHODS") || svg.includes("SOURCES & METHODS"));
}

// ---- K267 page polish (NEWSROOM_PAGE_POLISH=1, exact, default off) ---------------------------------------------------------------
// 1. A chart whose own title (drawn inside the chart SVG; it comes from the chart plan's `title`, not from the module `heading`) says nearly
//    the same sentence as the section title right above it is embedded without that title line. 2. A big number is not paired into a narrow
//    4-column cell: it becomes the full-width bar, and a chart narrower than its box (height-limited) is centred on a backing of its own paper
//    colour. 3. A big number takes the color_legend colour of its own meaning_id, or plain ink when it names none (never the house red, never another meaning's colour). 4. The rule above a short note and the stat bar label use the full column.
export function pagePolishEnabled(env = process.env) { return env.NEWSROOM_PAGE_POLISH === "1"; }

// Desktop only: the phone page is composed with the switch treated as off, so it is byte-identical either way.
let polishSuppressed = false;
const polishActive = () => !polishSuppressed && pagePolishEnabled();

const NEAR_SAME_TITLE_DICE = 0.7;

export function titlesNearlySame(a, b) {
  const norm = (v) => Array.from(String(v ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase());
  const x = norm(a), y = norm(b);
  if (x.length < 4 || y.length < 4) return x.length > 0 && x.join("") === y.join("");
  const grams = (chars) => { const m = new Map(); for (let i = 0; i + 1 < chars.length; i++) { const g = chars[i] + chars[i + 1]; m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const gx = grams(x), gy = grams(y);
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  return (2 * shared) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1)) >= NEAR_SAME_TITLE_DICE;
}

function unescapeXml(v) { return String(v).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&"); }

// The chart SVG without its own title line (and the blank above the next line), or the SVG itself when there is nothing safe to cut.
export function withoutChartTitle(svg, heading) {
  const source = String(svg ?? "");
  const named = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!named || !titlesNearlySame(unescapeXml(named[1]), heading)) return source;
  const title = unescapeXml(named[1]).trim();
  const vb = source.match(/<svg\b[^>]*viewBox=["']([^"']+)["']/i);
  if (!vb) return source;
  const box = vb[1].trim().split(/\s+/).map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return source;
  const num = (tag, name) => { const m = tag.match(new RegExp(`(?:^|\\s)${name}=["']\\s*(-?[\\d.]+)`)); return m ? Number(m[1]) : null; };
  const texts = [...source.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gi)];
  const at = texts.findIndex((m) => unescapeXml(m[2]).trim() === title && num(m[1], "y") !== null);
  if (at < 0) return source;
  const ty = num(texts[at][1], "y"), tsize = num(texts[at][1], "font-size") ?? 28;
  const next = texts[at + 1];
  const cropTo = next && num(next[1], "y") !== null ? num(next[1], "y") - 1.05 * (num(next[1], "font-size") ?? 15) - 8 : ty + 10;
  if (!(cropTo > box[1] + tsize * 0.5) || cropTo >= box[1] + box[3]) return source;
  // nothing else may be drawn above the crop line except the full-page paper rect
  const body = source.replace(/<defs\b[\s\S]*?<\/defs>/gi, "").replace(/<(?:title|desc)\b[\s\S]*?<\/(?:title|desc)>/gi, "");
  for (const m of body.matchAll(/<(text)\b([^>]*)>([^<]*)<\/text>|<(line|rect|circle)\b([^>]*?)\/?>/gi)) {
    const kind = (m[1] ?? m[4]).toLowerCase(), tag = ` ${m[2] ?? m[5]}`;
    if (kind === "text" && unescapeXml(m[3]).trim() === title) continue;
    if (kind === "rect" && (num(tag, "y") ?? 0) <= box[1] && (num(tag, "height") ?? 0) >= box[3] - 1) continue;
    const y = kind === "text" ? num(tag, "y") : kind === "line" ? Math.min(num(tag, "y1") ?? Infinity, num(tag, "y2") ?? Infinity) : kind === "circle" ? (num(tag, "cy") ?? Infinity) - (num(tag, "r") ?? 0) : num(tag, "y");
    if (y !== null && y < cropTo) return source;
  }
  const cut = source.slice(0, texts[at].index) + source.slice(texts[at].index + texts[at][0].length);
  const crop = Math.floor(cropTo - box[1]);
  return cut.replace(/(<svg\b[^>]*viewBox=["'])[^"']+(["'])/i, `$1${box[0]} ${box[1] + crop} ${box[2]} ${box[3] - crop}$2`);
}

// NEWSROOM_TITLE_ONE=1 (exact "1", default off, K318): a chart that sits right under a section heading keeps the title it draws itself, and the SECTION HEADING is the one dropped, but only
// when the two read the same after removing whitespace, punctuation, symbols and case (exact equality, not the K267 near-match). Neither text is rewritten; the eyebrow and deck stay.
// With the switch on, K267 no longer cuts a chart's title (the heading goes instead, or both stay). Desktop only; the phone page is composed from the unchanged spec.
const titleOneEnabled = () => process.env.NEWSROOM_TITLE_ONE === "1";
const titleKey = (v) => String(v ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
function chartDrawnTitle(svg) {
  const named = String(svg ?? "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!named) return "";
  const title = unescapeXml(named[1]).trim();
  if (!title) return "";
  const drawn = [...String(svg).matchAll(/<text\b[^>]*>([^<]*)<\/text>/gi)].some((m) => unescapeXml(m[1]).trim() === title);
  return drawn ? title : "";
}
export function withoutEqualHeadings(spec, assets) {
  const modules = spec.modules ?? [];
  let changed = false;
  const next = modules.map((module, i) => {
    if (module?.type !== "section_header" || !titleKey(module.heading)) return module;
    const after = modules[i + 1];
    if (after?.type !== "visual") return module;
    const title = chartDrawnTitle(assets?.[after.manifest_ref]?.desktopSvg);
    if (!title || titleKey(title) !== titleKey(module.heading)) return module;
    changed = true;
    return { ...module, heading: "" };
  });
  return changed ? { ...spec, modules: next } : spec;
}

// Assets for this page with each chart's duplicate title line removed; the layout and the drawing both see the same trimmed SVGs.
function polishAssets(spec, assets) {
  if (titleOneEnabled()) return assets;
  const out = { ...assets };
  let heading = "";
  for (const module of spec.modules ?? []) {
    if (module.type === "section_header") { heading = String(module.heading ?? ""); continue; }
    if (module.type !== "visual") continue;
    const asset = assets[module.manifest_ref];
    if (heading && asset) {
      const next = { ...asset };
      let changed = false;
      for (const key of ["desktopSvg", "mobileSvg", "compactSvg"]) {
        if (typeof asset[key] !== "string") continue;
        const trimmed = withoutChartTitle(asset[key], heading);
        if (trimmed !== asset[key]) { next[key] = trimmed; changed = true; }
      }
      if (changed) out[module.manifest_ref] = next;
    }
    heading = "";
  }
  return out;
}

// The accent for a big number under page polish: the colour color_legend registers for the number's own meaning_id; a number that names no registered meaning gets null (drawn in plain ink, never in a colour that means something else).
export function legendAccent(spec, module) {
  const meaning = String(module?.meaning_id ?? "").trim();
  if (!meaning) return null;
  const hit = (Array.isArray(spec?.color_legend) ? spec.color_legend : []).find((e) => String(e?.meaning_id ?? "").trim() === meaning && /^#[0-9a-f]{6}$/i.test(String(e?.color ?? "").trim()));
  return hit ? String(hit.color).trim() : null;
}

export function svgInfo(svg) {
  const match = String(svg ?? "").match(/<svg\b[^>]*viewBox=["']([^"']+)["'][^>]*>([\s\S]*)<\/svg>\s*$/i);
  if (!match) throw new Error("Embedded visualization is not a valid viewBox SVG");
  const nums = match[1].trim().split(/\s+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error("Embedded visualization has an invalid viewBox");
  return { minX: nums[0], minY: nums[1], width: nums[2], height: nums[3], inner: match[2] };
}

// Lowest drawn ink (viewBox y) of a chart SVG, or null when it cannot be bound
// with certainty (transforms, images, <use>, tspans that move). Text counts a
// quarter em of descender, strokes half their width. Only the bottom edge is
// used, to trim blank padding when a chart is embedded on the desktop page.
function svgInkBottom(info) {
  const inner = String(info.inner ?? "");
  if (/\btransform=|<image\b|<use\b|<foreignObject\b|<tspan\b[^>]*\b(?:y|dy)=/i.test(inner)) return null;
  const body = inner.replace(/<defs\b[\s\S]*?<\/defs>/gi, "").replace(/<(?:title|desc)\b[\s\S]*?<\/(?:title|desc)>/gi, "");
  const num = (tag, name) => { const m = tag.match(new RegExp(`(?:^|\\s)${name}=["']\\s*(-?[\\d.]+)`)); return m ? Number(m[1]) : null; };
  let bottom = -Infinity;
  const take = (v) => { if (Number.isFinite(v)) bottom = Math.max(bottom, v); };
  for (const m of body.matchAll(/<(text|line|rect|circle|ellipse|polygon|polyline|path)\b([^>]*?)\/?>/gi)) {
    const kind = m[1].toLowerCase(), tag = ` ${m[2]}`;
    const stroke = (num(tag, "stroke-width") ?? 1) / 2;
    if (kind === "text") take((num(tag, "y") ?? 0) + 0.25 * (num(tag, "font-size") ?? 16));
    else if (kind === "line") take(Math.max(num(tag, "y1") ?? 0, num(tag, "y2") ?? 0) + stroke);
    else if (kind === "rect") { if (!/\sfill=["'](?:#fff(?:fff)?|white)["']/i.test(tag) || /\sstroke=["'](?!none)/i.test(tag)) take((num(tag, "y") ?? 0) + (num(tag, "height") ?? 0) + stroke); }
    else if (kind === "circle") take((num(tag, "cy") ?? 0) + (num(tag, "r") ?? 0) + stroke);
    else if (kind === "ellipse") take((num(tag, "cy") ?? 0) + (num(tag, "ry") ?? 0) + stroke);
    else if (kind === "polygon" || kind === "polyline") {
      const pts = (tag.match(/points=["']([^"']+)["']/)?.[1] ?? "").trim().split(/[\s,]+/).map(Number);
      for (let i = 1; i < pts.length; i += 2) take(pts[i] + stroke);
    } else {
      const d = tag.match(/\sd=["']([^"']+)["']/)?.[1];
      if (d === undefined) return null;
      const yb = pathBottom(d);
      if (yb === null) return null;
      take(yb + stroke);
    }
  }
  return Number.isFinite(bottom) ? Math.min(bottom, info.minY + info.height) : null;
}

// Largest y reached by an SVG path (control points included, so it never
// under-estimates), or null if the path data cannot be read.
function pathBottom(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tokens) return null;
  const arity = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let i = 0, cmd = "", cy = 0, sy = 0, max = -Infinity;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i++]; if (cmd === "z" || cmd === "Z") { cy = sy; max = Math.max(max, cy); } continue; }
    const k = arity[cmd.toLowerCase()];
    if (!k) return null;
    const a = tokens.slice(i, i + k).map(Number);
    if (a.length < k || a.some((n) => !Number.isFinite(n))) return null;
    i += k;
    const rel = cmd === cmd.toLowerCase(), lower = cmd.toLowerCase();
    const yAt = (v) => (rel ? cy + v : v);
    if (lower === "h") { /* y unchanged */ }
    else if (lower === "v") { cy = yAt(a[0]); max = Math.max(max, cy); }
    else if (lower === "c") { max = Math.max(max, yAt(a[1]), yAt(a[3]), yAt(a[5])); cy = yAt(a[5]); }
    else if (lower === "s" || lower === "q") { max = Math.max(max, yAt(a[1]), yAt(a[3])); cy = yAt(a[3]); }
    else if (lower === "a") { max = Math.max(max, yAt(a[6]) + Math.abs(a[1])); cy = yAt(a[6]); }
    else { cy = yAt(a[1]); max = Math.max(max, cy); if (lower === "m") sy = cy; }
    if (lower === "m") { cmd = rel ? "l" : "L"; }
  }
  return Number.isFinite(max) ? max : null;
}

// Desktop page only: the embedded chart is cut just below its lowest ink (3
// units), so the blank padding a chart carries at the bottom does not become
// page spacing. Scale and width are unchanged; only blank rows are dropped.
const CHART_INK_PAD = 3;
// Inner markup of the charts drawn again at a slot width (NEWSROOM_EMBED_MIN_TEXT=1); only these use the safe left-ink estimate when trimmed.
const redrawSvgInners = new Set();
export function trimmedSvgInfo(svg) {
  const info = svgInfo(svg);
  const bottom = svgInkBottom(info);
  const left = svgInkLeft(info);
  const height = bottom === null ? info.height : Math.min(info.height, Math.max(1, Math.ceil(bottom + CHART_INK_PAD - info.minY)));
  // Also cut the blank left margin so the chart's ink starts at the page text column's left edge.
  const cut = left === null ? 0 : Math.max(0, Math.floor(left - info.minX));
  return { ...info, height, minX: info.minX + cut, width: info.width - cut };
}

// Leftmost drawn ink (viewBox x) of a chart SVG, or null when it cannot be bound with certainty (transforms,
// images, <use>, centred/right-anchored text, relative path starts). Strokes count half their width.
function svgInkLeft(info) {
  const inner = String(info.inner ?? "");
  if (/\btransform=|<image\b|<use\b|<foreignObject\b|<tspan\b[^>]*\bx=/i.test(inner)) return null;
  const body = inner.replace(/<defs\b[\s\S]*?<\/defs>/gi, "").replace(/<(?:title|desc)\b[\s\S]*?<\/(?:title|desc)>/gi, "");
  const num = (tag, name) => { const m = tag.match(new RegExp(`(?:^|\\s)${name}=["']\\s*(-?[\\d.]+)`)); return m ? Number(m[1]) : null; };
  let left = Infinity;
  const take = (v) => { if (Number.isFinite(v)) left = Math.min(left, v); };
  for (const m of body.matchAll(/<(text)\b([^>]*?)>([\s\S]*?)<\/text>|<(line|rect|circle|ellipse|polygon|polyline|path)\b([^>]*?)\/?>/gi)) {
    const kind = (m[1] ?? m[4]).toLowerCase(), tag = ` ${m[2] ?? m[5]}`;
    const stroke = (num(tag, "stroke-width") ?? 1) / 2;
    if (kind === "text") {
      // Anchored text reaches left by an over-estimate of its width (CJK 1 em, other glyphs 0.65 em), so the cut is never too deep.
      const anchor = tag.match(/text-anchor=["'](start|middle|end)/i)?.[1]?.toLowerCase() ?? "start";
      const chars = [...String(m[3]).replace(/<[^>]*>/g, "")];
      // Opt-in (NEWSROOM_PAGE_TRIM_TEXT_SAFE=1): every glyph counts a full em, an upper bound for any sans advance ("80%" is about 2 em, more than 3 x 0.65).
      // A chart drawn again at a slot width (K261, redrawSvgs) counts the same way: its tick text sits at the cut edge ("50%" is wider than 3 x 0.65 em).
      const nonCjkEm = process.env.NEWSROOM_PAGE_TRIM_TEXT_SAFE === "1" || redrawSvgInners.has(String(info.inner)) ? 1 : 0.65;
      const w = chars.reduce((sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : nonCjkEm), 0) * (num(tag, "font-size") ?? 16);
      take((num(tag, "x") ?? 0) - (anchor === "end" ? w : anchor === "middle" ? w / 2 : 0));
    } else if (kind === "line") take(Math.min(num(tag, "x1") ?? 0, num(tag, "x2") ?? 0) - stroke);
    else if (kind === "rect") { if (!/\sfill=["'](?:#fff(?:fff)?|white)["']/i.test(tag) || /\sstroke=["'](?!none)/i.test(tag)) take((num(tag, "x") ?? 0) - stroke); }
    else if (kind === "circle") take((num(tag, "cx") ?? 0) - (num(tag, "r") ?? 0) - stroke);
    else if (kind === "ellipse") take((num(tag, "cx") ?? 0) - (num(tag, "rx") ?? 0) - stroke);
    else if (kind === "polygon" || kind === "polyline") {
      const pts = (tag.match(/points=["']([^"']+)["']/)?.[1] ?? "").trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < pts.length; i += 2) take(pts[i] - stroke);
    } else {
      const d = tag.match(/\sd=["']([^"']+)["']/)?.[1];
      if (d === undefined) return null;
      const xl = pathLeft(d);
      if (xl === null) return null;
      take(xl - stroke);
    }
  }
  return Number.isFinite(left) ? Math.max(left, info.minX) : null;
}

// Smallest x reached by an SVG path (control points included), or null if the path data cannot be read.
function pathLeft(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  if (!tokens) return null;
  const arity = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let i = 0, cmd = "", cx = 0, sx = 0, min = Infinity;
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i++]; if (cmd === "z" || cmd === "Z") { cx = sx; min = Math.min(min, cx); } continue; }
    const k = arity[cmd.toLowerCase()];
    if (!k) return null;
    const a = tokens.slice(i, i + k).map(Number);
    if (a.length < k || a.some((n) => !Number.isFinite(n))) return null;
    i += k;
    const rel = cmd === cmd.toLowerCase(), lower = cmd.toLowerCase();
    const xAt = (v) => (rel ? cx + v : v);
    if (lower === "v") { /* x unchanged */ }
    else if (lower === "h") { cx = xAt(a[0]); min = Math.min(min, cx); }
    else if (lower === "c") { min = Math.min(min, xAt(a[0]), xAt(a[2]), xAt(a[4])); cx = xAt(a[4]); }
    else if (lower === "s" || lower === "q") { min = Math.min(min, xAt(a[0]), xAt(a[2])); cx = xAt(a[2]); }
    else if (lower === "a") { min = Math.min(min, xAt(a[5]) - Math.abs(a[0])); cx = xAt(a[5]); }
    else { cx = xAt(a[0]); min = Math.min(min, cx); if (lower === "m") sx = cx; }
    if (lower === "m") { cmd = rel ? "l" : "L"; }
  }
  return Number.isFinite(min) ? min : null;
}

// Smallest font-size (px) drawn in an SVG, or null if it declares none.
function svgMinFontSize(svg) {
  const sizes = [...String(svg ?? "").matchAll(/font-size=["']([\d.]+)(?:px)?["']/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  return sizes.length ? Math.min(...sizes) : null;
}

function namespaceSvgInner(inner, prefix) {
  const ids = [];
  let output = inner.replace(/\bid=["']([^"']+)["']/g, (_m, id) => {
    ids.push(id);
    return `id="${prefix}-${id}"`;
  });
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}-${id})`)
      .replace(new RegExp(`(["'\\s])#${escaped}(["'\\s<])`, "g"), `$1#${prefix}-${id}$2`)
      .replace(new RegExp(`aria-labelledby=(["'])${escaped}([^"']*)\\1`, "g"), (_m, q, rest) => `aria-labelledby=${q}${prefix}-${id}${rest}${q}`);
  }
  return output;
}

// `headline` (fix 8, house style only) switches the wrap algorithm from
// plain greedy wrapText to wrapHeadline - prefer breaking after full-width
// punctuation when the rest still fits, else balance the lines, never leave
// 3 characters or fewer on the last line - for CJK page titles and section
// headings only (see drawHeader/drawSectionHeader). Every other caller
// (deks, body text, captions, pull quotes) leaves it false and is
// unaffected; legacy style is unaffected regardless, since
// INFOGRAPHIC_HOUSE_STYLE_ACTIVE is only ever true under house style.
function lines(text, maxChars, maxLines = 99, headline = false) {
  const wrap = headline && INFOGRAPHIC_HOUSE_STYLE_ACTIVE ? wrapHeadline : wrapText;
  const out = wrap(String(text ?? ""), maxChars).slice(0, maxLines);
  if (out.length === maxLines && wrap(String(text ?? ""), maxChars).length > maxLines) {
    out[maxLines - 1] = out[maxLines - 1].replace(/…?$/, "…");
  }
  return out;
}

function textBlock(parts, text, x, y, opts = {}) {
  const size = opts.size ?? 16;
  const lineHeight = opts.lineHeight ?? Math.round(size * 1.35);
  const rows = lines(text, opts.maxChars ?? 70, opts.maxLines ?? 99, opts.headline ?? false);
  const family = opts.family ?? SANS;
  const fill = opts.fill ?? INK;
  const weight = opts.weight ?? 400;
  const anchor = opts.anchor ?? "start";
  const style = opts.italic ? "font-style=\"italic\"" : "";
  rows.forEach((row, index) => {
    parts.push(`<text x="${x}" y="${y + index * lineHeight}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${style}>${esc(row)}</text>`);
  });
  return rows.length * lineHeight;
}

export function validateInfographicSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") return ["infographic spec must be an object"];
  if (!INFOGRAPHIC_SCHEMA_VERSIONS.includes(spec.schema_version)) errors.push(`schema_version must be one of ${INFOGRAPHIC_SCHEMA_VERSIONS.join(", ")}`);
  if (!String(spec.title ?? "").trim()) errors.push("title is required");
  if (String(spec.title ?? "").length > 180) errors.push("title exceeds 180 characters");
  if (!String(spec.dek ?? "").trim()) errors.push("dek is required");
  if (String(spec.dek ?? "").length > 520) errors.push("dek exceeds 520 characters");
  if (!String(spec.alt ?? "").trim() || String(spec.alt).length < 30) errors.push("alt must be at least 30 characters");
  if (!INFOGRAPHIC_LAYOUTS.includes(spec.layout ?? "feature")) errors.push(`layout must be one of ${INFOGRAPHIC_LAYOUTS.join(", ")}`);
  if (spec.language !== undefined && !["en", "zh"].includes(spec.language)) errors.push("language must be 'en' or 'zh'");
  if (["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) {
    if (!String(spec.intent ?? "").trim()) errors.push("intent is required in InfographicSpec 1.1+");
    if (!String(spec.primary_message ?? "").trim()) errors.push("primary_message is required in InfographicSpec 1.1+");
    if (!INFOGRAPHIC_STORY_ARCS.includes(spec.story_arc)) errors.push(`story_arc must be one of ${INFOGRAPHIC_STORY_ARCS.join(", ")}`);
    if (!INFOGRAPHIC_AUDIENCES.includes(spec.audience)) errors.push(`audience must be one of ${INFOGRAPHIC_AUDIENCES.join(", ")}`);
    if (!INFOGRAPHIC_QUALITY_TARGETS.includes(spec.quality_target)) errors.push(`quality_target must be one of ${INFOGRAPHIC_QUALITY_TARGETS.join(", ")}`);
    if (["1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version) && !COMPETITION_PROFILE_IDS.includes(spec.competition_profile ?? "editorial")) errors.push(`competition_profile must be one of ${COMPETITION_PROFILE_IDS.join(", ")}`);
  }
  if (!Array.isArray(spec.modules) || spec.modules.length < 3) errors.push("modules must contain at least 3 items");
  if (storyboardEnabled() && hasPanels(spec)) {
    if (spec.modules.length > STORYBOARD_MODULE_CAP) errors.push(`modules cannot exceed ${STORYBOARD_MODULE_CAP} items on a storyboard page`);
  } else if (Array.isArray(spec.modules) && spec.modules.length > 12) errors.push("modules cannot exceed 12 items in v1.0");
  errors.push(...storyboardPageErrors(spec));
  const seen = new Set();
  for (const module of spec.modules ?? []) {
    if (!String(module?.id ?? "").trim()) errors.push("every module requires id");
    else if (seen.has(module.id)) errors.push(`duplicate module id '${module.id}'`);
    else seen.add(module.id);
    if (isPanel(module)) errors.push(...panelFieldErrors(module));
    else if (!INFOGRAPHIC_MODULE_TYPES.includes(module?.type)) errors.push(`module '${module?.id ?? "?"}' has unsupported type '${module?.type}'`);
    if (module?.source_quote !== undefined && module?.type !== "text") errors.push(`module '${module?.id ?? "?"}' source_quote is only supported on 'text' modules`);
    if (!INFOGRAPHIC_SPANS.includes(module?.span ?? "full")) errors.push(`module '${module?.id ?? "?"}' has unsupported span '${module?.span}'`);
    if (module?.story_role !== undefined && !INFOGRAPHIC_STORY_ROLES.includes(module.story_role)) errors.push(`module '${module?.id ?? "?"}' has unsupported story_role '${module.story_role}'`);
    if (module?.priority !== undefined && (!Number.isInteger(module.priority) || module.priority < 1 || module.priority > 5)) errors.push(`module '${module?.id ?? "?"}' priority must be an integer from 1 to 5`);
    if (module?.emphasis !== undefined && !INFOGRAPHIC_EMPHASIS.includes(module.emphasis)) errors.push(`module '${module?.id ?? "?"}' has unsupported emphasis '${module.emphasis}'`);
    if (module?.explanatory_dimension !== undefined && !INFOGRAPHIC_EXPLANATORY_DIMENSIONS.includes(module.explanatory_dimension)) errors.push(unsupportedDimensionError(`module '${module?.id ?? "?"}'`, module.explanatory_dimension, INFOGRAPHIC_EXPLANATORY_DIMENSIONS));
    if (module?.visual_grammar !== undefined && !INFOGRAPHIC_VISUAL_GRAMMARS.includes(module.visual_grammar)) errors.push(`module '${module?.id ?? "?"}' has unsupported visual_grammar '${module.visual_grammar}'`);
    if (module?.story_node_ids !== undefined && (!Array.isArray(module.story_node_ids) || module.story_node_ids.some((id) => !String(id ?? "").trim()))) errors.push(`module '${module?.id ?? "?"}' story_node_ids must contain non-empty story node ids`);
    if (STORY_NODE_IDS_REQUIRED_VERSIONS.includes(spec.schema_version) && STORY_NODE_IDS_REQUIRED_TYPES.includes(module?.type) && (!Array.isArray(module.story_node_ids) || module.story_node_ids.length === 0)) errors.push(`module '${module?.id ?? "?"}' requires story_node_ids in InfographicSpec 1.4+`);
    if (["1.4.0", "1.5.0"].includes(spec.schema_version) && module?.type === "visual" && !INFOGRAPHIC_VISUAL_GRAMMARS.includes(module?.visual_grammar)) errors.push(`visual module '${module?.id ?? "?"}' requires visual_grammar in InfographicSpec 1.4+`);
    if (module?.claim_set !== undefined && (!Array.isArray(module.claim_set) || module.claim_set.some((id) => !String(id ?? "").trim()))) errors.push(`module '${module?.id ?? "?"}' claim_set must contain non-empty claim ids`);
    if (module?.dependency_on !== undefined && !Array.isArray(module.dependency_on)) errors.push(`module '${module?.id ?? "?"}' dependency_on must be an array`);
    if (module?.type === "visual" && !String(module.manifest_ref ?? "").trim()) errors.push(`visual module '${module.id}' requires manifest_ref`);
    if (module?.type === "illustration") {
      if (!String(module.asset_ref ?? "").trim()) errors.push(`illustration module '${module.id}' requires asset_ref`);
      if (!String(module.alt ?? "").trim() || String(module.alt).length < 20) errors.push(`illustration module '${module.id}' alt must be at least 20 characters`);
      if (!String(module.credit ?? "").trim()) errors.push(`illustration module '${module.id}' requires credit`);
      if (!Array.isArray(module.claim_ids) || module.claim_ids.length === 0) errors.push(`illustration module '${module.id}' requires claim_ids`);
    }
    if (module?.type === "hero_stat") {
      if (module.value === undefined || module.value === null || String(module.value).trim() === "") errors.push(`hero_stat '${module.id}' requires value`);
      if (!String(module.label ?? "").trim()) errors.push(`hero_stat '${module.id}' requires label`);
      if (!String(module.claim_id ?? "").trim()) errors.push(`hero_stat '${module.id}' requires claim_id`);
    }
    if (module?.type === "text") {
      const hasSourceQuote = module.source_quote !== undefined && module.source_quote !== null;
      if (hasSourceQuote) {
        // A source quote is a non-asserting definitional/scope note (e.g. a
        // PDF metadata caveat): it may never also carry claim_ids, because
        // that would let unverifiable source-only text ride in on the back
        // of a claim binding it never earned.
        if (Array.isArray(module.claim_ids) && module.claim_ids.length > 0) errors.push(`text module '${module.id}' cannot combine source_quote with claim_ids: a source quote never counts as a verified finding`);
        // Body is optional beside a source_quote (the quote block itself
        // carries the content); if given, neither body nor heading is bound
        // to a claim or to the quote, so both must stay short and free of
        // anything that could pass for a verified figure.
        if (String(module.body ?? "").trim()) errors.push(...sourceQuoteProseFieldErrors(module.id, "body", module.body));
        if (String(module.heading ?? "").trim()) errors.push(...sourceQuoteProseFieldErrors(module.id, "heading", module.heading));
        const sq = module.source_quote;
        if (!sq || typeof sq !== "object") {
          errors.push(`text module '${module.id}' source_quote must be an object`);
        } else {
          if (!/^sources\/[0-9a-f]{64}\.json$/.test(String(sq.source_ref ?? ""))) errors.push(`text module '${module.id}' source_quote.source_ref must be a content-addressed sources/<sha256>.json path`);
          if (!String(sq.quote ?? "").trim()) errors.push(`text module '${module.id}' source_quote requires a verbatim quote`);
          if (!Number.isInteger(sq.page) || sq.page < 1) errors.push(`text module '${module.id}' source_quote requires a positive integer page`);
          if (sq.translation !== undefined && !String(sq.translation ?? "").trim()) errors.push(`text module '${module.id}' source_quote.translation cannot be blank when present`);
          // Generic on page language, not on the quote's own language: a zh
          // page must label every non-original rendering as 译述 (B1 language
          // mechanism), so a zh page's source_quote must supply one.
          if (spec.language === "zh" && !String(sq.translation ?? "").trim()) errors.push(`text module '${module.id}' source_quote requires translation (labeled 译述) on a zh page`);
        }
      } else {
        if (!String(module.body ?? "").trim()) errors.push(`text module '${module.id}' requires body`);
        if (!Array.isArray(module.claim_ids) || module.claim_ids.length === 0) errors.push(`text module '${module.id}' requires claim_ids`);
      }
    }
    if (module?.type === "pull_quote" && !String(module.text ?? "").trim()) errors.push(`pull_quote '${module.id}' requires text`);
    if (module?.type === "section_header" && !String(module.heading ?? "").trim()) errors.push(`section_header '${module.id}' requires heading`);
  }
  if (["1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version) && spec.mobile_module_order !== undefined) {
    if (!Array.isArray(spec.mobile_module_order)) errors.push("mobile_module_order must be an array");
    else {
      const ids = (spec.modules ?? []).map((module) => String(module.id));
      const order = spec.mobile_module_order.map(String);
      if (order.length !== ids.length || new Set(order).size !== ids.length || ids.some((id) => !order.includes(id))) errors.push("mobile_module_order must contain every module id exactly once");
    }
  }

  if (["1.4.0", "1.5.0"].includes(spec.schema_version)) {
    if (!String(spec.reader_question ?? "").trim()) errors.push("reader_question is required for InfographicSpec 1.4+");
    if (!String(spec.visual_thesis ?? "").trim()) errors.push("visual_thesis is required for InfographicSpec 1.4+");
    // Lean gates: the concept tournament, the asset plan and the novelty report are gone, so the concept set, the selected concept, the asset plan and the novelty report are not required (a value given is still checked).
    const requiredRefs = ["story_graph_ref", "editorial_discovery_ref", "visual_concept_ref", "selected_concept_id", "novelty_ref", "asset_plan_ref"].filter((field) => !(leanGatesEnabled() && (field === "visual_concept_ref" || field === "selected_concept_id" || field === "asset_plan_ref" || field === "novelty_ref")));
    for (const field of requiredRefs) if (!String(spec[field] ?? "").trim()) errors.push(`${field} is required for InfographicSpec 1.4+`);
    if (!spec.scene_graph) errors.push("scene_graph is required for InfographicSpec 1.4+");
    if (spec.schema_version === "1.5.0" && (!spec.editorial_grammar || typeof spec.editorial_grammar !== "object")) errors.push("editorial_grammar is required for InfographicSpec 1.5");
  }

  if (["1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) {
    if (spec.schema_version === "1.3.0" && spec.quality_target === "award") {
      for (const field of ["editorial_discovery_ref", "visual_concept_ref", "selected_concept_id", "novelty_ref", "asset_plan_ref"]) if (!String(spec[field] ?? "").trim()) errors.push(`${field} is required for InfographicSpec 1.3 award mode`);
      if (!spec.scene_graph) errors.push("scene_graph is required for InfographicSpec 1.3 award mode");
    }
    if (spec.scene_graph !== undefined) {
      const graph = spec.scene_graph;
      const graphVersion = graph?.schema_version;
      const maxScenes = graphVersion === "0.2.0" ? 6 : 3;
      if (!graph || typeof graph !== "object" || !["0.1.0", "0.2.0"].includes(graphVersion) || !Array.isArray(graph.scenes) || graph.scenes.length < 1 || graph.scenes.length > maxScenes) errors.push("scene_graph must use schema_version 0.1.0 with 1..3 scenes or 0.2.0 with 1..6 scenes");
      else {
        if (spec.schema_version === "1.5.0" && graphVersion !== "0.2.0") errors.push("InfographicSpec 1.5 requires SceneGraph 0.2.0");
        const moduleById = new Map((spec.modules ?? []).map((module) => [String(module.id), module]));
        const memberIds = new Set();
        const memberScene = new Map();
        const sceneIds = new Set();
        for (const scene of graph.scenes) {
          if (!String(scene?.id ?? "").trim() || sceneIds.has(String(scene.id))) errors.push(`scene '${scene?.id ?? "?"}' requires a unique id`);
          else sceneIds.add(String(scene.id));
          if (!INFOGRAPHIC_SCENE_PATTERNS.includes(scene?.pattern)) errors.push(`scene '${scene?.id ?? "?"}' has unsupported pattern '${scene?.pattern}'`);
          const anchor = String(scene?.anchor_module_id ?? "");
          const sidecars = Array.isArray(scene?.sidecar_module_ids) ? scene.sidecar_module_ids.map(String) : [];
          if (!moduleById.has(anchor)) errors.push(`scene '${scene?.id ?? "?"}' references missing anchor module '${anchor}'`);
          else if (!["visual", "illustration"].includes(moduleById.get(anchor)?.type)) errors.push(`scene '${scene?.id ?? "?"}' anchor must be a visual or illustration module`);
          if (sidecars.length < 1 || sidecars.length > 3 || new Set(sidecars).size !== sidecars.length) errors.push(`scene '${scene?.id ?? "?"}' requires 1..3 unique sidecar_module_ids`);
          if (graphVersion === "0.2.0") {
            if (!COGNITIVE_GOALS.includes(scene?.primary_cognitive_goal)) errors.push(`scene '${scene?.id ?? "?"}' has unsupported primary_cognitive_goal '${scene?.primary_cognitive_goal ?? ""}'`);
            if (!String(scene?.hero_object_id ?? "").trim()) errors.push(`scene '${scene?.id ?? "?"}' requires hero_object_id`);
            if (!Array.isArray(scene?.supporting_claim_ids)) errors.push(`scene '${scene?.id ?? "?"}' requires supporting_claim_ids`);
            if (!scene?.scene_budget || typeof scene.scene_budget !== "object") errors.push(`scene '${scene?.id ?? "?"}' requires scene_budget`);
          }
          for (const id of [anchor, ...sidecars]) {
            if (!moduleById.has(id)) errors.push(`scene '${scene?.id ?? "?"}' references missing module '${id}'`);
            if (memberIds.has(id)) {
              // NEWSROOM_SCENE_DUPLICATE_WORDING=1 (default off): only the wording differs. A module listed twice in the
              // SAME scene (anchor and sidecar) gets its own text; the check and the refusal are unchanged.
              if (process.env.NEWSROOM_SCENE_DUPLICATE_WORDING === "1" && memberScene.get(id) === scene) errors.push(`module '${id}' is written twice in scene '${scene?.id ?? "?"}' (as anchor and as sidecar); list it once`);
              else errors.push(`module '${id}' cannot belong to more than one scene`);
            }
            memberIds.add(id);
            if (!memberScene.has(id)) memberScene.set(id, scene);
          }
        }
      }
    }
  }
  return errors;
}

// A decorative illustration (a page cover) explains nothing: it is read from the STORED illustration manifest
// (metadata.decorative === true, written by the adapter and carried through normalize), never from the page plan,
// and it earns no credit in any page gate, critic score, ordinal or hero choice. It is still fully validated.
export function isDecorativeIllustration(module, assets = {}) {
  return module?.type === "illustration" && assets?.[module.asset_ref]?.manifest?.metadata?.decorative === true;
}

export function evaluateInfographicSynthesis(spec, assets = {}, storyGraph = null) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  if (!["1.4.0", "1.5.0"].includes(spec?.schema_version)) return { passed: true, blockers, warnings, notes, metrics: { enforced: false } };
  if (!storyGraph || typeof storyGraph !== "object") {
    blockers.push("story_graph_required_for_synthesis_gate");
    return { passed: false, blockers, warnings, notes, metrics: { enforced: true } };
  }
  if (storyGraph.passed === false) blockers.push("story_graph_has_blocking_issues");
  if (String(spec.reader_question ?? "").trim() !== String(storyGraph.reader_question ?? "").trim()) blockers.push("reader_question_must_match_story_graph");
  if (String(spec.visual_thesis ?? "").trim() !== String(storyGraph.visual_thesis ?? "").trim()) blockers.push("visual_thesis_must_match_story_graph");

  const nodeById = new Map((storyGraph.nodes ?? []).map((node) => [String(node.id), node]));
  const mappedNodeIds = [];
  const resolutionNodeIds = [];
  const mappedDimensions = new Set();
  const contentModules = (spec.modules ?? []).filter((module) => ["visual", "illustration", "hero_stat", "text"].includes(module.type) && !isDecorativeIllustration(module, assets));
  const visualModules = contentModules.filter((module) => module.type === "visual");
  const illustrationModules = contentModules.filter((module) => module.type === "illustration");
  const visualKinds = new Set();

  for (const module of contentModules) {
    for (const id of module.story_node_ids ?? []) {
      mappedNodeIds.push(String(id));
      const node = nodeById.get(String(id));
      if (node?.explanatory_dimension) mappedDimensions.add(String(node.explanatory_dimension));
      if (["resolution", "explanation"].includes(module.story_role)) resolutionNodeIds.push(String(id));
    }
    if (module.type === "visual") {
      const asset = assets[module.manifest_ref];
      const chartType = String(asset?.manifest?.chart_type ?? "");
      if (chartType) visualKinds.add(chartType);
      const allowed = ACTIVE_GRAMMAR_FORMS[module.visual_grammar];
      if (!allowed) blockers.push(`visual '${module.id}' has unsupported module visual_grammar '${module.visual_grammar ?? ""}'`);
      else if (chartType && !allowed.has(chartType)) blockers.push(`visual '${module.id}' grammar '${module.visual_grammar}' is incompatible with chart_type '${chartType}'`);
    }
  }

  const closure = evaluateQuestionClosure(storyGraph, mappedNodeIds, resolutionNodeIds, { lean: leanGatesEnabled() });
  if (closure.unknown_node_ids.length) blockers.push(`modules reference unknown story nodes: ${closure.unknown_node_ids.join(", ")}`);
  const notIn = (all, done) => (all ?? []).filter((id) => !done.includes(id));
  if (closure.covered_entry_node_ids.length !== (storyGraph.entry_node_ids ?? []).length) blockers.push(closureHint("reader_question_closure_missing_entry_coverage", notIn(storyGraph.entry_node_ids, closure.covered_entry_node_ids), `every entry node of the story graph must be listed in the story_node_ids of some module, for example "story_node_ids": ["${(storyGraph.entry_node_ids ?? [])[0] ?? "n1"}"].`));
  if (closure.covered_answer_node_ids.length !== (storyGraph.answer_node_ids ?? []).length) blockers.push(closureHint("reader_question_closure_missing_answer_coverage", notIn(storyGraph.answer_node_ids, closure.covered_answer_node_ids), `every answer node of the story graph must be listed in the story_node_ids of some module, for example "story_node_ids": ["${(storyGraph.answer_node_ids ?? [])[0] ?? "n1"}"].`));
  if (closure.resolved_answer_node_ids.length !== (storyGraph.answer_node_ids ?? []).length) blockers.push(closureHint("reader_question_closure_missing_resolution_module", notIn(storyGraph.answer_node_ids, closure.resolved_answer_node_ids), `every answer node must be listed in the story_node_ids of a module whose story_role is one of ${RESOLUTION_STORY_ROLES.join(", ")}, for example "story_role": "${RESOLUTION_STORY_ROLES[0]}".`));
  if (!leanGatesEnabled() && closure.node_coverage < 0.6) blockers.push(`story_graph_module_coverage_too_low:${closure.node_coverage}`);

  const nonSupportRelations = new Set((storyGraph.edges ?? []).map((edge) => String(edge.relation)).filter((relation) => relation && relation !== "supports"));
  const defaultChartEquivalent = visualModules.length <= 1 && illustrationModules.length === 0;
  if (defaultChartEquivalent) blockers.push("default_chart_equivalence: infographic collapses to one ordinary chart without an explanatory/spatial illustration module");
  if (mappedDimensions.size < 2) blockers.push("explanatory_completeness: fewer than two story dimensions are represented on the page");
  if (nonSupportRelations.size < 1) blockers.push("narrative_composability: no explanatory relation beyond evidence support is visible in the story graph");
  if (contentModules.length < 4) blockers.push("explanatory_completeness: InfographicSpec 1.4 requires at least four claim-bearing content modules");
  if (visualModules.length + illustrationModules.length < 2) blockers.push("visual_synthesis: InfographicSpec 1.4 requires at least two visual/explanatory modules");
  if (visualKinds.size === 1 && visualModules.length >= 3 && illustrationModules.length === 0) warnings.push("visual_language_repetition: three or more visual modules use one chart type with no explanatory illustration");

  notes.push(`story_node_coverage=${closure.node_coverage}`);
  notes.push(`mapped_dimensions=${[...mappedDimensions].sort().join(",")}`);
  notes.push(`visual_kinds=${[...visualKinds].sort().join(",") || "none"}`);
  notes.push(`default_chart_equivalent=${defaultChartEquivalent}`);
  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    notes,
    metrics: {
      enforced: true,
      story_node_coverage: closure.node_coverage,
      mapped_dimension_count: mappedDimensions.size,
      visual_module_count: visualModules.length,
      illustration_module_count: illustrationModules.length,
      visual_kind_count: visualKinds.size,
      default_chart_equivalent: defaultChartEquivalent,
      question_closure: closure.passed,
    },
  };
}


// ---------------------------------------------------------------------------
// D1: page-level subject set.  The page plan may declare one
// {computation_ref, key_field, cutoff_date}.  Members are read by the runtime
// from that computation's rows (never typed by the model); each chart's
// subjects are read by the runtime from the category field of that chart's own
// SQL rows and arrive on the asset as `asset.subjects`.  A chart whose
// subjects go beyond the set is restyled by the composer automatically
// (annotateSubjectSets) and only needs the model's caption text; a missing
// caption blocks, as does a chart that writes a different cutoff date.
// ---------------------------------------------------------------------------
const subjectKey = (value) => String(value ?? "").trim();

export function distinctSubjects(rows, field) {
  if (!Array.isArray(rows) || !field) return [];
  return [...new Set(rows.map((row) => subjectKey(row?.[field])).filter(Boolean))];
}

function subjectSetMembers(assets, context) {
  const raw = context?.subject_set_members ?? assets?.__subject_set_members;
  if (raw === undefined || raw === null) return null;
  return new Set([...raw].map(subjectKey).filter(Boolean));
}

export function outOfSetSubjects(subjects, members) {
  return (subjects ?? []).map(subjectKey).filter((subject) => subject && !members.has(subject));
}

// Marks every visual asset whose subjects exceed the set so composeOne draws it
// distinguished.  Runtime-owned: nothing here is read from model-written fields.
export function annotateSubjectSets(spec, assets, members) {
  for (const module of spec?.modules ?? []) {
    if (module?.type !== "visual") continue;
    const asset = assets?.[module.manifest_ref];
    if (!asset) continue;
    const out = members && Array.isArray(asset.subjects) ? outOfSetSubjects(asset.subjects, members) : [];
    if (out.length) asset.out_of_set_subjects = out; else delete asset.out_of_set_subjects;
  }
}

export function evaluateSubjectSets(spec, assets = {}, context = {}) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  const visuals = (spec?.modules ?? []).filter((module) => module?.type === "visual");
  const declared = spec?.subject_set;
  if (declared === undefined || declared === null) {
    // No set declared: keep today's behaviour (no block).  Two or more charts whose
    // subjects partly overlap without being equal is the one thing worth a warning.
    const lists = visuals
      .map((module) => ({ id: module.id, subjects: new Set((assets[module.manifest_ref]?.subjects ?? []).map(subjectKey).filter(Boolean)) }))
      .filter((entry) => entry.subjects.size > 0);
    let partial = false;
    for (let i = 0; i < lists.length && !partial; i += 1) {
      for (let j = i + 1; j < lists.length && !partial; j += 1) {
        const a = lists[i].subjects;
        const b = lists[j].subjects;
        const shared = [...a].filter((subject) => b.has(subject)).length;
        if (shared > 0 && (shared < a.size || shared < b.size) && !(shared === a.size && shared === b.size)) partial = true;
      }
    }
    if (partial) warnings.push("subject_sets_partially_overlap: two or more charts cover partly overlapping but unequal subjects; declare a page subject_set (computation_ref, key_field, cutoff_date) or align the charts");
    return { blockers, warnings, notes };
  }
  const missing = ["computation_ref", "key_field", "cutoff_date"].filter((key) => !String(declared?.[key] ?? "").trim());
  if (missing.length) {
    blockers.push(`subject_set_incomplete: subject_set is missing ${missing.join(", ")}`);
    return { blockers, warnings, notes };
  }
  const members = subjectSetMembers(assets, context);
  if (!members || members.size === 0) {
    blockers.push(`subject_set_unresolved: the runtime could not read any '${declared.key_field}' members from computation '${declared.computation_ref}'`);
    return { blockers, warnings, notes };
  }
  notes.push(`subject_set_members=${members.size}`);
  const cutoff = String(declared.cutoff_date).trim();
  for (const module of visuals) {
    const asset = assets[module.manifest_ref];
    if (!asset) continue;
    const chartCutoff = String(asset.manifest?.cutoff_date ?? "").trim();
    // A page that declares a cutoff date needs every chart to state the same one:
    // a chart that says nothing cannot be shown to match.
    if (!chartCutoff) blockers.push(`subject_set_cutoff_missing: visual '${module.id}' does not declare a cutoff_date but the page declares '${cutoff}'; set cutoff_date '${cutoff}' on the chart plan`);
    else if (chartCutoff !== cutoff) blockers.push(`subject_set_cutoff_mismatch: visual '${module.id}' writes cutoff date '${chartCutoff}' but the page declares '${cutoff}'`);
    if (!Array.isArray(asset.subjects)) {
      if (asset.manifest?.category_field) blockers.push(`subject_set_unresolved: visual '${module.id}' subjects could not be read from its own rows`);
      continue;
    }
    const out = outOfSetSubjects(asset.subjects, members);
    if (out.length === 0) continue;
    notes.push(`out_of_set:${module.id}=${out.length}`);
    if (!String(module.subject_caption ?? "").trim()) {
      const shown = out.slice(0, 5).join(", ") + (out.length > 5 ? `, +${out.length - 5} more` : "");
      blockers.push(`subject_set_out_of_set_without_caption: visual '${module.id}' includes ${out.length} subject(s) outside the page subject set (${shown}) and has no subject_caption readers can see`);
    }
  }
  return { blockers, warnings, notes };
}

// Hero value gate (always on; the lint takes no parameter that turns it off). Each hero_stat is re-filled from its own claim's
// bindings by the runtime (newsroom.ts fillHeroModule: value from value_from,
// label and detail placeholders, unit only as the claim shows it); context.hero_checks
// ({ module_id: [blocker, ...] }) carries what that re-check refused, so the stored
// plan must equal the filled one and no number may be unbound. Pure: lint only reads it.
// Unlike the claim checks before it, an empty verified set lets no claim id through.
function heroValueBlockers(module, verified, heroChecks) {
  const id = String(module.id);
  const claimId = String(module.claim_id ?? "");
  if (!verified.has(claimId)) return [`hero_stat '${id}' claim '${claimId}' is not verified (hero value gate)`];
  const checks = heroChecks && Array.isArray(heroChecks[id]) ? heroChecks[id] : null;
  if (!checks) return [`hero_stat '${id}' was not re-checked against its claim bindings (hero value gate)`];
  return checks.map(String);
}

// ---- Hero number recompute ----------------------------------------------------------------------------------------
// NEWSROOM_HERO_RECOMPUTE=1 (exact "1", default off): a hero_stat's big number must equal the value the program recomputes from the
// stored query result of its own claim, after the rounding the page shows. The recomputed value is the number in the computation
// row the claim's binding points at, read from the stored computation; nothing here reads model output or changes a claim's status.
// Pure: the caller reads the computation row and hands the value in.

export function heroRecomputeEnabled() {
  return process.env.NEWSROOM_HERO_RECOMPUTE === "1";
}

const SHOWN_NUMBER = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

/** The shown text as a number and the number of decimals it shows; null when the text is not a bare number (nothing to recompute). */
export function shownNumber(text) {
  const raw = String(text ?? "").trim();
  if (!SHOWN_NUMBER.test(raw)) return null;
  const dot = raw.indexOf(".");
  return { value: Number(raw.replace(/,/g, "")), decimals: dot === -1 ? 0 : raw.length - dot - 1 };
}

/** The recomputed value as the program writes it: float toFixed(decimals), the same call that makes a bound number's text (formatClaimValue in newsroom.ts), as a number. */
export function roundedTo(value, decimals) {
  return Number(value.toFixed(Math.min(100, decimals)));
}

/**
 * Refusal text, or null when the shown number is the recomputed value as the page rounds it (or the check does not apply: the
 * recomputed cell is not a number, or the shown text is not a bare number). The text carries the recomputed value.
 */
export function heroRecomputeRefusal({ heroId, claimId, placeholder, shownText, recomputed }) {
  const shown = shownNumber(shownText);
  if (!shown) return null;
  const numeric = typeof recomputed === "number" ? recomputed : (typeof recomputed === "string" && recomputed.trim() !== "" ? Number(recomputed) : NaN);
  if (!Number.isFinite(numeric)) return null;
  const expected = roundedTo(numeric, shown.decimals);
  if (Math.abs(expected - shown.value) <= 1e-9 * Math.max(1, Math.abs(expected))) return null;
  return `HERO_VALUE_RECOMPUTE_MISMATCH: hero_stat '${heroId}' claim '${claimId}' shows ${String(shownText).slice(0, 30)} for ${placeholder}, but the program recomputes ${numeric} from the claim's query result (${expected.toFixed(shown.decimals)} at ${shown.decimals} decimal${shown.decimals === 1 ? "" : "s"}); run the query and record the claim again`;
}

// ---- Page top ---------------------------------------------------------------------------------------------------
// The page opens with its one prominent verified number, or else its lead chart - never with prose. The first content
// module is the first module that is not a section_header and not a decorative illustration: a decorative cover
// directly under the title is header art, not content. Spec order is the order the composer starts from. Warning
// only; the warning text is the same guidance the plan tool gives the model (newsroom.ts imports this sentence).
export const PAGE_TOP_GUIDANCE = "The first content module after the title and dek is a hero_stat bound with value_from when the story has one prominent verified number; otherwise it is the lead visual. Never open with a text module or a pull quote.";
const PAGE_TOP_TYPES = new Set(["hero_stat", "visual", "illustration"]);

export function pageTopWarning(spec, assets = {}) {
  const modules = Array.isArray(spec?.modules) ? spec.modules : [];
  const first = modules.find((module) => module && module.type !== "section_header" && !isDecorativeIllustration(module, assets));
  if (!first || PAGE_TOP_TYPES.has(first.type)) return null;
  return `page_top_not_hero_or_lead_visual: the first content module '${first.id}' is a ${first.type} module. ${PAGE_TOP_GUIDANCE}`;
}

// ---- Reader-facing words ----------------------------------------------------------------------------------------
// Pure checks over the strings of a page that readers see. They never read the data behind a page, never grant
// anything, and never change a string. Exported so render QA can run the same checker on the final page text.
//
// Fields read, as { field, text, copy } (readerTextEntries):
//   page      title, dek, kicker (copy); byline, date_label, alt, source_note
//   scene     title, dek (copy); eyebrow                                   (scene_graph.scenes[])
//   module    label, heading, deck, body, text, detail, subject_caption (copy); label_short, eyebrow, value, unit,
//             attribution, credit, alt; source_quote.translation
//   assets    the source_note of every visual and illustration manifest, and an illustration manifest's credit and
//             provenance disclosure (the page prints them in its source list and caption)
//   charts    module:<id>:chart_text (not copy): the text, tspan, title and desc contents of each visual's desktop SVG,
//             entities decoded, plus aria-label / aria-description / aria-roledescription values (chartSvgText); also
//             module:<id>:chart_text.mobile / .compact (the lines those variants add) and module:<id>:illustration_text[.mobile]
//             for an illustration's SVG
// "copy" fields are running copy: they are also read for unsupported quantifiers and vague times.
// Still not read: the raw text of a source_quote.quote (see below).
// Deliberately not read: planning fields no composer draws (intent, primary_message, reader_question,
// visual_thesis, new_information, story_role, annotations, ids and refs), source_quote.quote (verbatim words of the
// source) and label_template / detail_template (templates by design; the filled label and detail are read).
const READER_COPY_KEYS = ["label", "heading", "deck", "body", "text", "detail", "subject_caption"];
const READER_OTHER_KEYS = ["label_short", "eyebrow", "value", "unit", "attribution", "credit", "alt"];

const SVG_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeSvgEntities = (text) => text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
  const code = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : null;
  if (code !== null) return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  return SVG_ENTITIES[name.toLowerCase()] ?? whole;
});

/** The inner markup of the element whose id is `id` (any tag; nested same-name tags are balanced), or "" when there is none. */
function svgElementContentById(svg, id) {
  // The id attribute is compared after entity decoding, so id="&#97;" is the id "a".
  const tagPattern = /<([A-Za-z][\w:.-]*)\b[^>]*?\sid\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
  let open = null;
  for (let tag = tagPattern.exec(svg); tag; tag = tagPattern.exec(svg)) {
    if (decodeSvgEntities(tag[2] ?? tag[3] ?? "") === id) { open = tag; break; }
  }
  if (!open || /\/\s*>$/.test(open[0])) return "";
  const name = open[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  tags.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let tag = tags.exec(svg); tag; tag = tags.exec(svg)) {
    if (tag[1]) depth -= 1;
    else if (!/\/\s*>$/.test(tag[0])) depth += 1;
    if (depth === 0) return svg.slice(open.index + open[0].length, tag.index);
  }
  return "";
}

/** The reader-visible text of one SVG string: the contents of its text, tspan, title and desc elements, entities decoded,
 *  one line per element, plus the attribute and referenced-element text listed below. */
export function chartSvgText(svg) {
  if (typeof svg !== "string" || !svg) return "";
  const lines = [];
  const take = (inner) => {
    const line = decodeSvgEntities(inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body) => body.replace(/&/g, "&amp;").replace(/</g, "&lt;")).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (line) lines.push(line);
  };
  // text, title and desc first (a text element's tspans come with it), then any tspan outside those.
  const outer = /<(text|title|desc)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const rest = svg.replace(outer, (_, __, inner) => { take(inner); return " "; });
  for (const match of rest.matchAll(/<tspan\b[^>]*>([\s\S]*?)<\/tspan\s*>/gi)) take(match[1]);
  // Text read out by assistive technology is reader text too: aria-label, aria-description, aria-roledescription.
  // xlink:title is a tooltip on a link: reader text too.
  for (const match of svg.matchAll(/\s(?:aria-(?:label|description|roledescription)|xlink:title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) take(match[1] ?? match[2] ?? "");
  // aria-labelledby / aria-describedby name other elements by id: the whole text content of each, whatever its tag.
  for (const match of svg.matchAll(/\saria-(?:labelledby|describedby)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    // Decode before splitting: aria-labelledby="a&#32;b" names the two ids a and b.
    for (const id of decodeSvgEntities(match[1] ?? match[2] ?? "").split(/\s+/).filter(Boolean)) {
      const content = svgElementContentById(svg, id);
      if (content) take(content);
    }
  }
  return lines.join("\n");
}

/** The lines of `svg` that `seen` (the lines already read from another variant) does not have. */
function newSvgLines(svg, seen) {
  return chartSvgText(svg).split("\n").filter((line) => line && !seen.has(line)).join("\n");
}

export function readerTextEntries(spec, assets = {}) {
  const out = [];
  const add = (field, value, copy) => {
    if (value === undefined || value === null || typeof value === "object") return;
    const text = String(value);
    if (text.trim()) out.push({ field, text, copy });
  };
  for (const key of ["title", "dek", "kicker"]) add(key, spec?.[key], true);
  for (const key of ["byline", "date_label", "alt"]) add(key, spec?.[key], false);
  add("source_note", effectivePageSourceNote(spec, assets), false);
  for (const scene of Array.isArray(spec?.scene_graph?.scenes) ? spec.scene_graph.scenes : []) {
    add(`scene:${scene?.id}:eyebrow`, scene?.eyebrow, false);
    add(`scene:${scene?.id}:title`, scene?.title, true);
    add(`scene:${scene?.id}:dek`, scene?.dek, true);
  }
  for (const module of Array.isArray(spec?.modules) ? spec.modules : []) {
    if (!module || typeof module !== "object") continue;
    const id = String(module.id ?? "?");
    for (const key of READER_COPY_KEYS) add(`module:${id}:${key}`, module[key], true);
    for (const key of READER_OTHER_KEYS) add(`module:${id}:${key}`, module[key], false);
    add(`module:${id}:source_quote.translation`, module.source_quote?.translation, false);
    // Every SVG variant the page can embed is read: desktop, mobile and compact charts, and an illustration's own text. A
    // variant adds only the lines the desktop text does not already have.
    const svgAsset = module.type === "visual" ? assets?.[module.manifest_ref] : module.type === "illustration" ? assets?.[module.asset_ref] : null;
    if (svgAsset) {
      const desktopText = chartSvgText(svgAsset.desktopSvg);
      const seen = new Set(desktopText.split("\n"));
      const prefix = module.type === "visual" ? "chart_text" : "illustration_text";
      add(`module:${id}:${prefix}`, desktopText, false);
      for (const [variant, svg] of [["mobile", svgAsset.mobileSvg], ["compact", svgAsset.compactSvg]]) add(`module:${id}:${prefix}.${variant}`, newSvgLines(svg, seen), false);
    }
    const manifest = module.type === "visual" ? assets?.[module.manifest_ref]?.manifest : module.type === "illustration" ? assets?.[module.asset_ref]?.manifest : null;
    if (manifest && typeof manifest === "object") {
      add(`module:${id}:manifest.source_note`, manifest.source_note, false);
      if (module.type === "illustration") {
        add(`module:${id}:manifest.credit`, manifest.credit, false);
        add(`module:${id}:manifest.disclosure`, manifest.provenance?.disclosure, false);
      }
    }
  }
  return out;
}

// Blockers: pipeline phrases - words only the pipeline's own notes use. A reader never needs one. Bare 闸门, 未绑定 and
// 缺口修复 are ordinary words (a reservoir gate, an unbound account, a funding gap repair), so they only warn below.
//   process_term      1. 未经闸门; 行绑定 (row binding), except as the tail of 进行绑定 / 银行绑定; 闸门 directly followed by 核, 检, 校, 拦,
//                        放行, 通过 or 判定, except 闸门检修 (an ordinary word: the maintenance of a reservoir gate).
//                     2. subject rule: a pipeline subject (数值 数字 数据 结论 声明 占位符 字段) and a process word (闸门 未绑定 绑定
//                        缺口修复) in one clause, in either order, with at most 4 characters between them and none of 。；;，,！!？?、
//                        or a line break among them (数值未绑定, 这个数字没有通过闸门, 该数据行绑定失败, 结论绑定失败).
//   field_name        value_from, claim_id(s), story_node(s) / story_node_id(s): whole field names only.
//   placeholder_word  TODO, FIXME, TBD, placeholder(s), lorem - any case, whole words only.
//   template_braces   any {...} with something inside, such as an unfilled {max.value}.
const PROCESS_PHRASE_RE = /未经闸门|闸门(?=核|检|校|拦|放行|通过|判定)(?!检修)|(?<![进银])行绑定/gu;
const PROCESS_SUBJECT_RE = /数值|数字|数据|结论|声明|占位符|字段/gu;
const PROCESS_WORD_RE = /缺口修复|未绑定|闸门|绑定/gu;
const CLAUSE_BREAK_RE = /[。；;，,！!？?、\n\r]/u;
const SUBJECT_GAP = 4;

/** The pipeline phrases blocked in one text: [{ term, index }] in text order. The subject rule never reports a word that a phrase
 *  of rule 1 already covers. */
function processTermHits(text) {
  const phrases = [...text.matchAll(PROCESS_PHRASE_RE)].map((match) => ({ term: match[0], index: match.index }));
  const covered = (index, length) => phrases.some((hit) => index < hit.index + hit.term.length && hit.index < index + length);
  const subjects = [...text.matchAll(PROCESS_SUBJECT_RE)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const clause = (from, to) => to - from <= SUBJECT_GAP && !CLAUSE_BREAK_RE.test(text.slice(from, to));
  const bound = [];
  for (const match of text.matchAll(PROCESS_WORD_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (covered(start, match[0].length)) continue;
    if (subjects.some((subject) => (subject.end <= start && clause(subject.end, start)) || (subject.start >= end && clause(end, subject.start)))) bound.push({ term: match[0], index: start });
  }
  return [...phrases, ...bound].sort((x, y) => x.index - y.index);
}

const READER_BLOCKER_RULES = [
  { id: "process_term", find: processTermHits },
  { id: "field_name", re: /(?<![A-Za-z0-9_])(?:value_from|claim_ids?|story_node(?:_ids?|s)?)(?![A-Za-z0-9_])/giu },
  { id: "placeholder_word", re: /(?<![A-Za-z])(?:todo|fixme|tbd|placeholders?|lorem)(?![A-Za-z])/giu },
  { id: "template_braces", re: /\{[^{}]*[^{}\s][^{}]*\}/gu },
];

// Warnings: broader words that are sometimes the story's own (a 模拟 model, a 测试 score, a movie's runtime), and the
// bare process words above that a pipeline phrase did not already block.
//   process_word      闸门, 未绑定 and 缺口修复 where the blocker rules above did not take them (a reservoir gate, an unbound account).
//   review_term       模拟 测试 校验 运行时 (not 运行时间/长/刻/段) and the whole words runtime, lint, mock, prompt (with plural / -ed).
// Not caught, by design: 气候模型 (model), 门槛 (threshold), 测量 (measurement), 检测, 运行时间 (running time).
function bareProcessWordHits(text) {
  const blocked = processTermHits(text);
  return [...text.matchAll(/缺口修复|未绑定|闸门/gu)]
    .filter((match) => !blocked.some((hit) => match.index < hit.index + hit.term.length && hit.index < match.index + match[0].length))
    .map((match) => ({ term: match[0], index: match.index }));
}
const READER_WARNING_RULES = [
  { id: "process_word", find: bareProcessWordHits },
  { id: "review_term", re: /模拟|测试|校验|运行时(?![间长刻段])|(?<![A-Za-z])(?:runtime|lint(?:s|ing)?|mock(?:s|ed)?|prompts?)(?![A-Za-z])/giu },
];

function readerExcerpt(text, index, length) {
  const from = Math.max(0, index - 12);
  const to = Math.min(text.length, index + length + 12);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
}

function scanReaderText(entries, rules) {
  const out = [];
  for (const { field, text } of entries) {
    const seen = new Set();
    for (const rule of rules) {
      const found = rule.find ? rule.find(text) : [...text.matchAll(rule.re)].map((match) => ({ term: match[0], index: match.index }));
      for (const { term, index } of found) {
        const key = `${rule.id}:${term.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ rule: rule.id, term, field, excerpt: readerExcerpt(text, index, term.length) });
      }
    }
  }
  return out;
}

// Input: one string (for example a whole rendered page's text), an array of strings, or an array of { field, text }.
function readerEntryList(input) {
  const many = Array.isArray(input);
  return (many ? input : [input]).flatMap((item, index) => {
    if (typeof item === "string") return item.trim() ? [{ field: many ? `text[${index}]` : "page text", text: item, copy: false }] : [];
    if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()) return [{ field: String(item.field ?? `text[${index}]`), text: item.text, copy: item.copy === true }];
    return [];
  });
}

/** Process terms (blockers) and broad review terms (warnings) in reader-facing text. Each finding is { rule, term, field, excerpt, message }. */
export function checkReaderText(input) {
  const entries = readerEntryList(input);
  return {
    blockers: scanReaderText(entries, READER_BLOCKER_RULES).map((hit) => ({ ...hit, message: `reader_text_${hit.rule}: ${hit.field} shows "${hit.term}" to readers (${hit.excerpt}); say it in story words, never as a process note, field name or template` })),
    warnings: scanReaderText(entries, READER_WARNING_RULES).map((hit) => ({ ...hit, message: `reader_text_${hit.rule}: ${hit.field} uses "${hit.term}" (${hit.excerpt}); keep it only when it is a story word, not a process term` })),
  };
}

// Quantifiers need a count behind them. A phrase of this list in running copy is supported only when some verified
// claim bound to the page states that same phrase; otherwise the copy should give the count the data shows.
// Longest phrase wins (绝大多数 before 大多数 before 多数). Not quantifiers: 多数据 / 少数量 / 少数字 (a word that
// merely contains 多数/少数: more data, fewer digits), 少数民族 (an ethnic minority), and 过半 inside 通过半导体 /
// 经过半年 / 超过半年 (过半数, 超过半数 and 已过半 are quantifiers).
const QUANTIFIER_RE = /绝大多数|几乎所有|一半以上|更多国家|更少国家|大多数|多数|少数|过半/gu;
// Vague time: a relative phrase with no period behind it. Read per field: a field that also states a four-digit
// year is taken to state its period. Not vague: 项目前期 / 题目前面 (目 ends one word, 前 starts the next), 最新鲜 / 最新颖.
const VAGUE_TIME_RE = /最近一年|近年来|近几年|近期|目前|如今|最新/gu;
const STATED_YEAR_RE = /(?<!\d)(?:19|20)\d{2}(?!\d)/u;

function quantifierPhrases(text) {
  const out = [];
  for (const match of text.matchAll(QUANTIFIER_RE)) {
    const phrase = match[0];
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + phrase.length] ?? "";
    if (phrase.endsWith("数") && /[据量字值目码]/u.test(after)) continue;
    if (phrase === "少数" && after === "民") continue;
    if (phrase === "过半" && after !== "数" && (/[通经超越度穿错]/u.test(before) || /[年导个小天夜岛径月场途价]/u.test(after))) continue;
    out.push(phrase);
  }
  return out;
}

function vagueTimePhrases(text) {
  const out = [];
  for (const match of text.matchAll(VAGUE_TIME_RE)) {
    const phrase = match[0];
    const before = text[match.index - 1] ?? "";
    const after = text[match.index + phrase.length] ?? "";
    if (phrase === "目前" && /[项题节栏科剧曲书条名篇数品总要纲眼]/u.test(before)) continue;
    if (phrase === "最新" && /[鲜颖奇]/u.test(after)) continue;
    out.push(phrase);
  }
  return out;
}

/**
 * Warnings for unsupported quantifiers and vague times in the running copy ("copy" entries) of a page.
 * options.claim_texts is the text of every verified claim bound to the page; without it (null) the quantifier check is
 * skipped, because there is nothing to compare with. Each finding is { rule, term, field, message }.
 */
export function checkReaderWording(input, options = {}) {
  const claimTexts = Array.isArray(options.claim_texts) ? options.claim_texts.map(String) : null;
  const warnings = [];
  for (const { field, text, copy } of readerEntryList(input)) {
    if (!copy) continue;
    if (claimTexts) {
      for (const phrase of new Set(quantifierPhrases(text))) {
        if (claimTexts.some((claim) => claim.includes(phrase))) continue;
        warnings.push({ rule: "unsupported_quantifier", term: phrase, field, message: `unsupported_quantifier: ${field} says "${phrase}" but no verified claim bound to this page states it; state the count from the data (for example "12 of 20 countries") or bind a claim that supports the phrase` });
      }
    }
    if (STATED_YEAR_RE.test(text)) continue;
    for (const phrase of new Set(vagueTimePhrases(text))) {
      warnings.push({ rule: "vague_time", term: phrase, field, message: `vague_time_reference: ${field} says "${phrase}" with no period stated; state the year or the date range (for example 2022年1月至2024年12月)` });
    }
  }
  return { warnings };
}

// Text of every verified claim the page cites: a module's claim_id / claim_ids / claim_set, a module annotation's claim,
// a chart or illustration manifest's own claim, and a scene's supporting claims. A record counts when the caller lists its
// id as verified or the record carries the system's own publishable verification; the model cannot write either.
function boundClaimTexts(spec, assets, records, verified) {
  const cited = new Set();
  const add = (id) => { if (id !== undefined && id !== null && String(id).trim()) cited.add(String(id)); };
  const addAll = (ids) => { for (const id of Array.isArray(ids) ? ids : []) add(id); };
  for (const module of Array.isArray(spec?.modules) ? spec.modules : []) {
    if (!module || typeof module !== "object") continue;
    add(module.claim_id);
    addAll(module.claim_ids);
    addAll(module.claim_set);
    for (const annotation of Array.isArray(module.annotations) ? module.annotations : []) add(annotation?.claim_id);
    const manifest = module.type === "visual" ? assets?.[module.manifest_ref]?.manifest : module.type === "illustration" ? assets?.[module.asset_ref]?.manifest : null;
    add(manifest?.claim_id);
    addAll(manifest?.claim_ids);
  }
  for (const scene of Array.isArray(spec?.scene_graph?.scenes) ? spec.scene_graph.scenes : []) addAll(scene?.supporting_claim_ids);
  return records
    .filter((record) => cited.has(String(record?.claim_id ?? "")) && (verified.has(String(record?.claim_id)) || (record?.verification?.authority === "system" && record?.verification?.publishable === true)))
    .map((record) => String(record?.claim ?? ""));
}

// The chart's own SVG height when it fills a full-span slot (plus the label strip moduleHeight reserves), or null when the asset is missing.
function storyboardNativeHeight(module, assets) {
  const asset = assets?.[module.manifest_ref];
  if (typeof asset?.desktopSvg !== "string") return null;
  const info = trimmedSvgInfo(asset.desktopSvg);
  return info.width > 0 && info.height > 0 ? Math.ceil(DESKTOP_CONTENT_W * info.height / info.width) + 36 : null;
}

// The room a panel note gets: a text module of PANEL_NOTE_LINES body lines, measured by moduleHeight at the page width.
function storyboardNoteAllowance(assets) {
  const chars = Math.max(44, Math.round(DESKTOP_CONTENT_W / 10));
  let body = "字";
  while (lines(body, chars, 12).length < PANEL_NOTE_LINES) body += "字";
  return moduleHeight({ type: "text", body }, DESKTOP_CONTENT_W, assets);
}

export function lintInfographicSpec(specIn, assets = {}, context = {}) {
  // NEWSROOM_STORYBOARD: the panel rules read the page as written; every other gate then reads the expanded, ordinary modules.
  const board = storyboardEnabled() && hasPanels(specIn);
  const spec = board ? expandPanels(specIn) : specIn;
  const blockers = validateInfographicSpec(specIn);
  if (board) blockers.push(...storyboardBlockers(specIn, context.story_graph ?? null, (m) => moduleHeight(m, DESKTOP_CONTENT_W, assets), (m) => storyboardNativeHeight(m, assets), storyboardNoteAllowance(assets)));
  if (storyboardEnabled() && Array.isArray(context.chart_page_styles)) blockers.push(...pageStyleBlockers(specIn.render_style, context.chart_page_styles));
  const warnings = [];
  const notes = [];
  const verified = new Set((context.verified_claim_ids ?? []).map(String));
  // newsroom.ts always passes mobile_pages: false (desktop-only pages);
  // callers that don't pass mobile_pages keep the both-variants behavior.
  const mobilePages = context.mobile_pages !== false;
  const sceneSlots = mobilePages ? new Map() : desktopSceneSlots(spec);
  let visualCount = 0;
  let claimCount = 0;
  const sourceNotes = [];
  // Publication headlines, decks and theses are assertions too.  When the
  // runtime supplies claim records, fail closed if those fields introduce a
  // causal/motive label without a separately reviewed causal or mechanistic
  // claim.  Merely binding descriptive calculations must not turn
  // "crisis-driven", "caused by conflict", etc. into verified copy.
  if (Array.isArray(context.verified_claim_records)) {
    const hasCausalSupport = context.verified_claim_records.some((record) =>
      ["causal", "mechanistic"].includes(String(record?.claim_kind ?? ""))
      && record?.verification?.authority === "system"
      && record?.verification?.publishable === true);
    const editorialFields = [
      ["title", spec.title],
      ["dek", spec.dek],
      ["primary_message", spec.primary_message],
      ["visual_thesis", spec.visual_thesis],
      ...((spec.modules ?? []).flatMap((module) => [
        [`module:${module.id}:label`, module.label],
        [`module:${module.id}:heading`, module.heading],
        [`module:${module.id}:body`, module.body],
        [`module:${module.id}:text`, module.text],
        [`module:${module.id}:new_information`, module.new_information],
      ])),
    ];
    for (const [field, value] of editorialFields) {
      if (!String(value ?? "").trim()) continue;
      const support = evaluateClaimSupport({ requested_status: "supported", claim_kind: "descriptive", claim: value, extra_causal_phrases_en: process.env.NEWSROOM_CAUSAL_PHRASES_EN === "1" });
      if (!hasCausalSupport && support.reasons.includes("claim_contains_unbound_causal_or_motive_language")) {
        blockers.push(`unbound_causal_editorial_language:${field}`);
      }
    }
  }
  for (const module of spec.modules ?? []) {
    if (module.type === "visual") {
      visualCount += 1;
      const asset = assets[module.manifest_ref];
      if (!asset) { blockers.push(`visual '${module.id}' references missing asset '${module.manifest_ref}'`); continue; }
      if (!asset.desktopSvg || (mobilePages && !asset.mobileSvg)) blockers.push(`visual '${module.id}' requires desktop${mobilePages ? " and mobile" : ""} SVG variant${mobilePages ? "s" : ""}`);
      if (!mobilePages && spanColumns(module.span) < 12) blockers.push(guideErrors() ? `visual '${module.id}' must use span 'full' with mobile pages off, because a narrower module would shrink chart text below the 12px floor; ${NARROW_HINT("chart", String(asset.manifest?.chart_type ?? ""), typeof asset.compactSvg === "string", 0)}` : `visual '${module.id}' must use span 'full' with mobile pages off: there is no compact chart variant, and a narrower module would shrink chart text below the 12px floor`);
      const visualSlot = sceneSlots.get(String(module.id));
      if (visualSlot && visualSlot.cols < 12 && !(visualSlot.cols === 8 && typeof asset.compactSvg === "string")) blockers.push(guideErrors() ? `visual '${module.id}' gets only ${visualSlot.cols} of 12 columns in scene '${visualSlot.scene_id}' with mobile pages off: ${NARROW_HINT("chart", String(asset.manifest?.chart_type ?? ""), typeof asset.compactSvg === "string", visualSlot.cols)}` : `visual '${module.id}' gets only ${visualSlot.cols} of 12 columns in scene '${visualSlot.scene_id}' with mobile pages off: there is no compact chart variant, so a scene may hold a visual only as the anchor of a 'hero_with_rail' scene or as that scene's only sidecar`);
      if (!asset.manifest) blockers.push(`visual '${module.id}' is missing visualization manifest metadata`);
      if (asset.critic && asset.critic.passed === false) blockers.push(`visual '${module.id}' upstream critic did not pass`);
      if (!asset.critic) warnings.push(`visual '${module.id}' has no upstream critic metadata`);
      if (asset.manifest?.verification_mode === "draft" || asset.manifest?.artifact_status === "DRAFT" || asset.manifest?.publishable === false) blockers.push(`visual '${module.id}' uses a DRAFT/non-publishable visualization manifest`);
      if (asset.manifest?.claim_id && !verified.has(String(asset.manifest.claim_id))) blockers.push(`visual '${module.id}' references unverified claim '${asset.manifest.claim_id}'`);
      {
        // Every verified claim hung on this visual (manifest claim, module
        // claim_id/claim_ids/claim_set, module annotations) must belong to the
        // visual's own computation (verdicts from claim_binding.mjs, computed
        // per visual in the async layer). Absent context means the caller did
        // not compute them: skip.
        const verdicts = context.visual_claim_bindings?.[String(module.id)];
        if (verdicts && typeof verdicts === "object") {
          const labelled = [[String(asset.manifest?.claim_id ?? ""), `claim '${asset.manifest?.claim_id}'`]];
          for (const claimId of [module.claim_id, ...(module.claim_ids ?? []), ...(module.claim_set ?? [])]) labelled.push([String(claimId ?? ""), `claim '${claimId}'`]);
          for (const annotation of Array.isArray(module.annotations) ? module.annotations : []) labelled.push([String(annotation?.claim_id ?? ""), `annotation '${annotation?.id}' claim '${annotation?.claim_id}'`]);
          const seen = new Set();
          for (const [claimId, label] of labelled) {
            const verdict = claimId ? verdicts[claimId] : null;
            if (!verdict || verdict.ok === true) continue;
            const key = `${claimId}|${label}`;
            if (seen.has(key)) continue;
            seen.add(key);
            blockers.push(`visual '${module.id}' ${label} is not bound to the visual's own computation: ${verdict.message}`);
          }
        }
      }
      if (asset.manifest?.source_note) sourceNotes.push(asset.manifest.source_note);
      {
        // B1: a chart declares its own language (runtime/pi/newsroom.ts
        // newsroom_viz_plan `language`, carried onto its render manifest); a
        // page mixing an en chart into a zh page (or vice versa) is exactly
        // the mixed_language_chart_internals failure mode, so lint blocks it
        // deterministically instead of relying on the vision critic.
        const pageLanguage = spec.language === "zh" ? "zh" : "en";
        const chartLanguage = asset.manifest?.language === "zh" ? "zh" : "en";
        if (chartLanguage !== pageLanguage) blockers.push(`visual '${module.id}' chart language '${chartLanguage}' differs from page language '${pageLanguage}'`);
      }
      if (["1.4.0", "1.5.0"].includes(spec.schema_version) && module.visual_grammar) {
        const allowed = ACTIVE_GRAMMAR_FORMS[module.visual_grammar];
        const chartType = String(asset.manifest?.chart_type ?? "");
        if (allowed && chartType && !allowed.has(chartType)) blockers.push(`visual '${module.id}' grammar '${module.visual_grammar}' is incompatible with chart_type '${chartType}'`);
      }
    }
    if (module.type === "illustration") {
      visualCount += 1;
      const asset = assets[module.asset_ref];
      if (!asset) { blockers.push(`illustration '${module.id}' references missing asset '${module.asset_ref}'`); continue; }
      if (!asset.desktopSvg || (mobilePages && !asset.mobileSvg)) blockers.push(`illustration '${module.id}' requires desktop${mobilePages ? " and mobile" : ""} SVG variant${mobilePages ? "s" : ""}`);
      if (!mobilePages && spanColumns(module.span) < 12) blockers.push(guideErrors() ? `illustration '${module.id}' must use span 'full' with mobile pages off, because a narrower module would shrink chart text below the 12px floor; an illustration has no 8-column variant, so use it as the anchor of a 'hero_with_rail' scene (its rail is drawn below it, not beside it) or on a row of its own` : `illustration '${module.id}' must use span 'full' with mobile pages off: there is no compact chart variant, and a narrower module would shrink chart text below the 12px floor`);
      const illustrationSlot = sceneSlots.get(String(module.id));
      if (illustrationSlot && illustrationSlot.cols < 12) blockers.push(guideErrors() ? `illustration '${module.id}' gets only ${illustrationSlot.cols} of 12 columns in scene '${illustrationSlot.scene_id}' with mobile pages off: an illustration has no 8-column variant, so it cannot sit beside a sidecar in a 'hero_sidecar_stack' scene; use it as the anchor of a 'hero_with_rail' scene (its rail is drawn below it, not beside it), as that scene's only sidecar, or on a row of its own` : `illustration '${module.id}' gets only ${illustrationSlot.cols} of 12 columns in scene '${illustrationSlot.scene_id}' with mobile pages off: there is no compact illustration variant, so a scene may hold an illustration only as the anchor of a 'hero_with_rail' scene or as that scene's only sidecar`);
      if (!asset.manifest) blockers.push(`illustration '${module.id}' is missing illustration manifest metadata`);
      if (asset.critic && asset.critic.passed === false) blockers.push(`illustration '${module.id}' upstream critic did not pass`);
      if (!asset.critic) warnings.push(`illustration '${module.id}' has no upstream critic metadata`);
      if (asset.manifest?.kind === "rich_illustration") {
        if (asset.manifest?.schema_version !== "0.2.0") blockers.push(`rich illustration '${module.id}' has unsupported schema_version`);
        const provenance = asset.manifest?.provenance ?? {};
        if (!String(provenance.origin ?? "").trim()) blockers.push(`rich illustration '${module.id}' is missing origin provenance`);
        if (!String(provenance.digital_source_type ?? "").trim()) blockers.push(`rich illustration '${module.id}' is missing digital_source_type`);
        if (!String(provenance.disclosure ?? "").trim()) blockers.push(`rich illustration '${module.id}' is missing editorial disclosure`);
        if (["generative_ai", "mixed"].includes(provenance.origin) && (!String(provenance.provider ?? "").trim() || !String(provenance.model ?? "").trim())) blockers.push(`rich illustration '${module.id}' is missing AI system metadata`);
        if (["generative_ai", "mixed"].includes(provenance.origin) && spec.quality_target === "award") warnings.push(`award-target page includes AI-origin illustration '${module.id}'; confirm the target competition permits generated imagery`);
        if (spec.competition_profile === "snd47_infographics" && ["generative_ai", "mixed"].includes(provenance.origin)) blockers.push(`SND47 infographic profile rejects reader-facing AI-origin illustration '${module.id}'`);
      }
      for (const claimId of module.claim_ids ?? []) {
        claimCount += 1;
        if (!verified.has(String(claimId))) blockers.push(`illustration '${module.id}' references unverified claim '${claimId}'`);
      }
      if (asset.manifest?.source_note) sourceNotes.push(asset.manifest.source_note);
    }
    if (module.type === "hero_stat") {
      claimCount += 1;
      if (!verified.has(String(module.claim_id))) blockers.push(`hero_stat '${module.id}' references unverified claim '${module.claim_id}'`);
      blockers.push(...heroValueBlockers(module, verified, context.hero_checks));
      if (String(module.label ?? "").length > 120) warnings.push(`hero_stat '${module.id}' label is long for magazine display`);
    }
    if (module.type === "text") {
      for (const claimId of module.claim_ids ?? []) {
        claimCount += 1;
        if (!verified.has(String(claimId))) blockers.push(`text module '${module.id}' references unverified claim '${claimId}'`);
      }
      if (String(module.body ?? "").length > 900) warnings.push(`text module '${module.id}' exceeds the preferred 900-character magazine budget`);
      if (module.source_quote) {
        const sq = module.source_quote;
        const sourceTexts = context.source_texts instanceof Map ? context.source_texts : new Map(Object.entries(context.source_texts ?? {}));
        if (!sourceTexts.has(String(sq.source_ref))) {
          blockers.push(`text module '${module.id}' source_quote references source '${sq.source_ref}' that was not supplied for lint verification`);
        } else if (!sourceQuoteMatches(sourceTexts.get(String(sq.source_ref)), sq.page, sq.quote)) {
          blockers.push(`text module '${module.id}' source_quote text does not appear verbatim on page ${sq.page} of '${sq.source_ref}'`);
        }
        sourceNotes.push(sq.source_ref);
      }
    }
    if (module.type === "pull_quote") {
      if (String(module.text ?? "").length > 280) warnings.push(`pull_quote '${module.id}' is too long for a pull quote`);
      for (const claimId of module.claim_ids ?? []) {
        claimCount += 1;
        if (!verified.has(String(claimId))) blockers.push(`pull_quote '${module.id}' references unverified claim '${claimId}'`);
      }
    }
  }
  if (visualCount < 2) warnings.push("Magazine feature has fewer than two verified visual modules");
  if (visualCount > 7) warnings.push("More than seven visual modules may overload a single feature page");
  // K1056: page render QA takes one symbol-map spec+rows pair and checks every circle in the page SVG, so a page carries at most one (switch on only).
  if (SYMBOL_MAP_GRAMMAR_ON) {
    const symbolMaps = (spec.modules ?? []).filter((m) => m.type === "visual" && assets[m.manifest_ref]?.manifest?.chart_type === "symbol_map").length;
    if (symbolMaps > 1) blockers.push(`symbol_map_limit: a page carries at most 1 symbol_map, found ${symbolMaps}`);
  }
  if ((spec.modules ?? []).filter((m) => m.type === "hero_stat").length > 4) warnings.push("More than four hero statistics weakens hierarchy");
  if (String(spec.title ?? "").length > 90) warnings.push("Headline is long; consider a tighter display headline");
  if (String(spec.dek ?? "").length > 260) warnings.push("Deck is long; consider moving context into a text module");
  if (["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) {
    const roles = new Set((spec.modules ?? []).map((m) => m.story_role).filter(Boolean));
    const priorityOne = (spec.modules ?? []).filter((m) => m.priority === 1);
    const heroVisuals = (spec.modules ?? []).filter((m) => (m.type === "visual" || m.type === "illustration") && m.emphasis === "hero" && !isDecorativeIllustration(m, assets));
    if (spec.quality_target === "award") {
      if (!roles.has("hook")) blockers.push("award-target infographic requires at least one hook module");
      if (!roles.has("evidence")) blockers.push("award-target infographic requires at least one evidence module");
      if (!roles.has("resolution") && !roles.has("explanation")) warnings.push("award-target infographic has no explicit resolution/explanation role");
      if (priorityOne.length === 0) blockers.push("award-target infographic requires at least one priority-1 module");
      if (heroVisuals.length === 0) warnings.push("award-target infographic has no explicit hero visual anchor");
    }
    const missingRoles = (spec.modules ?? []).filter((m) => m.type !== "section_header" && !m.story_role).length;
    if (missingRoles) warnings.push(`${missingRoles} non-section modules have no story_role`);
  }
  if (leanGatesEnabled() && ["1.4.0", "1.5.0"].includes(spec.schema_version)) {
    const novelty = semanticNoveltyFindings(spec.modules);
    warnings.push(...novelty.warnings);
    notes.push(...novelty.notes);
  }
  // Page top (warning only) and the words readers see. A process term, field name or template brace in reader text
  // blocks; broader review terms, quantifiers no bound claim states and relative times with no period only warn. The
  // quantifier check needs the bound claims' text, so it runs only when the caller supplies claim records.
  const pageTop = pageTopWarning(spec, assets);
  if (pageTop) warnings.push(pageTop);
  const readerEntries = readerTextEntries(spec, assets);
  const readerText = checkReaderText(readerEntries);
  blockers.push(...readerText.blockers.map((hit) => hit.message));
  warnings.push(...readerText.warnings.map((hit) => hit.message));
  const readerWording = checkReaderWording(readerEntries, {
    claim_texts: Array.isArray(context.verified_claim_records) ? boundClaimTexts(spec, assets, context.verified_claim_records, verified) : null,
  });
  warnings.push(...readerWording.warnings.map((hit) => hit.message));
  notes.push(`visual_modules=${visualCount}`);
  notes.push(`claim_references=${claimCount}`);
  notes.push(`unique_sources=${uniq(sourceNotes).length}`);
  if (["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) {
    notes.push(`story_arc=${spec.story_arc}`);
    notes.push(`audience=${spec.audience}`);
    notes.push(`quality_target=${spec.quality_target}`);
    if (["1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) notes.push(`competition_profile=${spec.competition_profile ?? "editorial"}`);
  }
  const validators = runEditorialValidators(spec, assets, context);
  for (const row of validators.issues) {
    const message = `${row.rule_id}: ${row.message}`;
    if (["FATAL", "ERROR"].includes(row.severity)) blockers.push(message);
    else if (row.severity === "WARNING") warnings.push(message);
    else notes.push(message);
  }
  const subjectSets = evaluateSubjectSets(spec, assets, context);
  blockers.push(...subjectSets.blockers);
  warnings.push(...subjectSets.warnings);
  notes.push(...subjectSets.notes);
  const synthesis = evaluateInfographicSynthesis(spec, assets, context.story_graph ?? null);
  blockers.push(...synthesis.blockers);
  warnings.push(...synthesis.warnings);
  notes.push(...synthesis.notes);
  return {
    schema_version: spec.schema_version,
    passed: blockers.length === 0,
    blockers,
    warnings,
    notes,
    validators,
    synthesis,
    content_hash: hash(spec),
  };
}

function spanColumns(span) { return ({ full: 12, two_thirds: 8, half: 6, third: 4 })[span ?? "full"] ?? 12; }

// A chart that has a compact (8-column) SVG uses it, and only it, in a slot
// exactly as wide as that variant was laid out for. Any other width keeps the
// desktop/mobile choice below, so the 12px floor is never met by shrinking.
function compactFits(asset, width, mobile) {
  return !mobile && typeof asset?.compactSvg === "string" && Math.abs(width - COMPACT_VIEW_W) <= 2;
}

// NEWSROOM_EMBED_MIN_TEXT=1 (exact "1", default off, K261): a chart embedded on the desktop page is never scaled so far down that its smallest text
// falls under the render check's floor (MIN_FONT_SIZE_FLOOR, read from render_qa_geometry.mjs, not a threshold of its own). When the variant the page
// would normally use is, the other variants are tried and the one that needs the least scaling and keeps the floor is used instead; when none does,
// the normal variant stays (the render check still reports it).
const embedMinTextEnabled = () => process.env.NEWSROOM_EMBED_MIN_TEXT === "1";

function embeddedTextFloorOk(svg, width) {
  const smallest = svgMinFontSize(svg);
  return smallest === null || (smallest * width) / trimmedSvgInfo(svg).width >= MIN_FONT_SIZE_FLOOR - 1e-9;
}

// Charts drawn again at a slot's width (K261 step 2): svg text -> { manifest_ref, width, sha256 } for the page manifest. Redraws are memoised per
// chart inputs + width; the record list is rebuilt for each page composition (composeOne) from the redraws the final draw actually used.
const widthRedraws = new Map();
let usedWidthRedraws = new Map();
// The caller's chart-level check (the same render check and critic the draw step ran on the original chart) a redraw must pass to be used; none given = no redraw.
let activeChartCheck = null;

// K261: every <text> of a chart drawn again at a slot width must lie inside the box the page embeds it from (the trimmed viewBox) - left and right edges,
// by an over-estimate of the glyph advance (CJK 1 em, "%" 1 em, other glyphs 0.7 em). Texts with a transform or no plain x are not judged here.
export function textInkInsideEmbedBox(svg) {
  const box = trimmedSvgInfo(svg);
  const body = String(svgInfo(svg).inner ?? "").replace(/<defs\b[\s\S]*?<\/defs>/gi, "").replace(/<(?:title|desc)\b[\s\S]*?<\/(?:title|desc)>/gi, "");
  for (const m of body.matchAll(/<text\b([^>]*?)>([\s\S]*?)<\/text>/gi)) {
    const tag = ` ${m[1]}`;
    if (/\btransform=/i.test(tag)) continue;
    const num = (name) => { const v = tag.match(new RegExp(`(?:^|\\s)${name}=["']\\s*(-?[\\d.]+)`)); return v ? Number(v[1]) : null; };
    const x = num("x");
    if (x === null) continue;
    const fs = num("font-size") ?? 16;
    const w = [...String(m[2]).replace(/<[^>]*>/g, "")].reduce((sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef%]/.test(ch) ? 1 : 0.7), 0) * fs;
    const anchor = tag.match(/text-anchor=["'](start|middle|end)/i)?.[1]?.toLowerCase() ?? "start";
    const left = x - (anchor === "end" ? w : anchor === "middle" ? w / 2 : 0);
    if (left < box.minX - 1e-9 || left + w > box.minX + box.width + 1e-9) return false;
  }
  return true;
}

function widthRedraw(asset, width, module) {
  const inputs = asset.inputs;
  if (!inputs || !hasWidthVariant(inputs.spec)) return null;
  const w = Math.round(width);
  const key = `${asset.inputsSha256 ?? ""}|${w}`;
  if (!widthRedraws.has(key)) {
    let svg = null;
    try { svg = renderVizSvgAtWidth(inputs.spec, inputs.rows, w); } catch { svg = null; }
    if (svg !== null) {
      redrawSvgInners.add(String(svgInfo(svg).inner));
      if (!(activeChartCheck && activeChartCheck(inputs, svg) === true && textInkInsideEmbedBox(svg))) { redrawSvgInners.delete(String(svgInfo(svg).inner)); svg = null; }
    }
    widthRedraws.set(key, svg === null ? null : { svg, manifest_ref: String(module.manifest_ref), width: w, sha256: createHash("sha256").update(svg).digest("hex") });
  }
  return widthRedraws.get(key);
}

// The SVG a visual module is embedded from in a desktop slot `width` wide (the phone page keeps its own choice). Last resort when no stored variant keeps
// the floor: the same spec and rows are drawn again at the slot's width by the desktop renderer (no scaling, no change of data or labels).
function visualEmbedSource(asset, width, module) {
  const normal = compactFits(asset, width, false) ? asset.compactSvg : spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
  if (!embedMinTextEnabled() || embeddedTextFloorOk(normal, width)) return normal;
  const fitting = [asset.compactSvg, asset.mobileSvg, asset.desktopSvg].filter((svg) => typeof svg === "string" && embeddedTextFloorOk(svg, width));
  if (fitting.length) return fitting.reduce((best, svg) => (width / trimmedSvgInfo(svg).width < width / trimmedSvgInfo(best).width ? svg : best));
  const redraw = widthRedraw(asset, width, module);
  return redraw && embeddedTextFloorOk(redraw.svg, width) ? redraw.svg : normal;
}

function visualAspect(asset, mobilePreferred, trim = false) {
  const source = mobilePreferred ? asset.mobileSvg : asset.desktopSvg;
  const info = trim ? trimmedSvgInfo(source) : svgInfo(source);
  return info.height / info.width;
}

// NEWSROOM_HEADER_BOX_INK=1 (exact "1", default off): a deck-less desktop section header box ends where the layout puts the next module, on every page; storyboard pages always do.
const headerBoxInkEnabled = () => process.env.NEWSROOM_HEADER_BOX_INK === "1";

function moduleHeight(module, width, assets, mobile = false) {
  const type = module.type;
  if (type === "hero_stat") {
    const labelChars = mobile ? 46 : Math.max(28, Math.round(width / 10));
    const labelLines = lines(module.label ?? "", labelChars, 3).length;
    const detailLines = module.detail ? lines(module.detail, mobile ? 62 : Math.max(38, Math.round(width / 8)), 2).length : 0;
    // Desktop house style, no detail: the box ends just below the label (rhythm).
    if (!mobile && INFOGRAPHIC_HOUSE_STYLE_ACTIVE && !detailLines) return 112 + Math.max(0, labelLines - 1) * 20;
    return (mobile ? 166 : INFOGRAPHIC_HOUSE_STYLE_ACTIVE ? 140 : 154) + Math.max(0, labelLines - 1) * (mobile ? 20 : 20) + detailLines * 10;
  }
  if (type === "section_header") {
    const headingChars = mobile ? 31 : 48;
    const deckChars = mobile ? 55 : 86;
    const headingLines = String(module.heading ?? "") === "" ? 0 : lines(module.heading ?? "", headingChars, 3).length;
    const deckLines = module.deck ? lines(module.deck, deckChars, 3).length : 0;
    // Desktop: the last deck baseline plus its 4px descender allowance (inkBottomSlack) ended 6px below the box bottom; grow the box so that ink stays inside it.
    // Storyboard (K261) or NEWSROOM_HEADER_BOX_INK=1 (K266, the same fix for any page): the layout puts the next module's ink RHYTHM_AFTER_HEADING below this heading's ink, so a deck-less box ends where that module's box starts (its ink top is BODY_INK_TOP) - from the same ink-bottom the layout uses, never below the plain height. Off: unchanged.
    const plain = (mobile ? 72 : 70) + headingLines * (mobile ? 37 : 42) + deckLines * (mobile ? 22 : 23) + (!mobile && deckLines ? 6 : 0);
    return !mobile && !deckLines && (storyboardEnabled() || headerBoxInkEnabled()) ? Math.min(plain, sectionHeaderInkBottom(headingLines, 0) + RHYTHM_AFTER_HEADING - BODY_INK_TOP) : plain;
  }
  if (type === "pull_quote") {
    if (!mobile) return 78 + lines(`“${module.text}”`, pullQuoteChars(width), 7).length * 38;
    return 92 + lines(module.text, 34, 7).length * 34;
  }
  if (type === "text") {
    const chars = mobile ? 54 : Math.max(44, Math.round(width / 10));
    // Desktop headings wrap and step exactly as drawTextModule draws them.
    const heading = !module.heading ? 0 : mobile ? lines(module.heading, chars, 3).length * 28 : lines(module.heading, Math.max(30, Math.round(width / 17)), 3).length * 32;
    const bodyLines = String(module.body ?? "").trim() ? lines(module.body, chars, 12).length : 0;
    // Desktop: the box ends just below the last drawn line (rhythm).
    if (!mobile) return Math.ceil(textInkBottom(module, width) + TEXT_BOTTOM_PAD);
    let height = 72 + (mobile ? 0 : 6) + heading + bodyLines * (mobile ? 24 : 22);
    if (module.source_quote) height += sourceQuoteBlockHeight(module.source_quote, width, mobile);
    return height;
  }
  if (type === "visual" || type === "illustration") {
    const asset = assets[type === "visual" ? module.manifest_ref : module.asset_ref];
    if (!asset) return mobile ? 500 : 520;
    const aspect = type === "visual" && !mobile && embedMinTextEnabled() ? (() => { const info = trimmedSvgInfo(visualEmbedSource(asset, width, module)); return info.height / info.width; })() : type === "visual" && compactFits(asset, width, mobile) ? (() => { const info = mobile ? svgInfo(asset.compactSvg) : trimmedSvgInfo(asset.compactSvg); return info.height / info.width; })() : visualAspect(asset, mobile || spanColumns(module.span) <= 6, !mobile);
    const provenanceCaption = type === "illustration" && (asset.manifest?.kind === "rich_illustration" || module.credit) ? (mobile ? 52 : 44) : 0;
    // The compact chart embeds 1:1, so its slot must hold the full top pad (see
    // embedVisual) or the chart shrinks below the 12px text floor.
    const compact = type === "visual" && compactFits(asset, width, mobile);
    // K259 (desktop): the full-size slot reserved 12 (36 with a label), short of the topPad + 6 that embedVisual spends (20/32/30 + 6), so an
    // unlabeled chart was drawn 14px under its native height, below scale 1, and its 12px text under the floor. Desktop reserves what is spent;
    // the phone page keeps its old reserve (it is byte-pinned against the parent in test_page_rhythm and not part of this fix).
    const spent = (module.emphasis === "hero" ? 30 : module.label ? 32 : 20) + 6;
    const reserve = compact || !mobile ? spent : module.label ? 36 : 12;
    const captionH = outOfSetCaptionHeight(asset, module, mobile);
    let maxHeight = mobile ? 980 : 900;
    if (type === "visual" && !mobile) {
      // Desktop: the 900 cap must not shrink the chart below its 12px text
      // floor. embedVisual fits the chart into (box.h - topPad - 6 - caption),
      // so give it the native height times 12 / smallest font, plus exactly
      // that padding. Charts that already fit are unchanged (max keeps 900).
      const source = visualEmbedSource(asset, width, module);
      const nativeH = trimmedSvgInfo(source).height;
      const minFont = svgMinFontSize(source);
      const topPad = module.emphasis === "hero" ? 30 : module.label ? 32 : 20;
      maxHeight = Math.max(maxHeight, Math.ceil(nativeH * (minFont ? 12 / minFont : 1)) + topPad + 6 + captionH);
      // New route: the chart fills its column's width; the slot is as tall as that takes, not held to the cap.
      if (process.env.NEWSROOM_NEXT === "1") maxHeight = Math.max(maxHeight, Math.ceil(width * aspect + reserve + provenanceCaption + captionH));
    }
    return clamp(width * aspect + reserve + provenanceCaption + captionH, mobile ? 390 : 0, maxHeight);
  }
  return 180;
}

function moduleDensity(module) {
  if (!module) return 0;
  if (module.type === "section_header") return clamp((String(module.heading ?? "").length + String(module.deck ?? "").length) / 420, 0.1, 0.55);
  if (module.type === "hero_stat") return clamp((String(module.label ?? "").length + String(module.detail ?? "").length) / 360, 0.18, 0.5);
  if (module.type === "visual") return module.emphasis === "hero" ? 0.42 : 0.52;
  if (module.type === "pull_quote") return clamp(String(module.text ?? "").length / 420, 0.28, 0.7);
  if (module.type === "text") return clamp((String(module.heading ?? "").length + String(module.body ?? "").length) / 980, 0.35, 1);
  return 0.5;
}

function effectiveColumns(module, strategy) {
  if (module.type === "section_header") return 12;
  let cols = spanColumns(module.span);
  if (strategy === "anchor" && (module.type === "visual" || module.type === "illustration") && (module.emphasis === "hero" || module.priority === 1)) cols = 12;
  if (strategy === "rhythm" && module.emphasis === "hero") cols = Math.max(cols, 8);
  if (strategy === "rhythm" && module.type === "pull_quote" && module.story_role === "turn") cols = Math.max(cols, 6);
  return cols;
}

// The desktop columns each scene member gets, as laid out by
// buildDesktopScene: hero_with_rail gives its anchor the full width and
// splits the rail among its sidecars; hero_sidecar_stack gives the anchor 8
// columns and each sidecar 4.
function desktopSceneSlots(spec) {
  const slots = new Map();
  for (const scene of normalizedScenes(spec)) {
    const rail = scene.pattern === "hero_with_rail";
    const count = scene.sidecar_module_ids.length;
    slots.set(scene.anchor_module_id, { scene_id: String(scene.id), cols: rail ? 12 : 8 });
    for (const id of scene.sidecar_module_ids) slots.set(id, { scene_id: String(scene.id), cols: rail ? (count === 1 ? 12 : count === 2 ? 6 : 4) : 4 });
  }
  return slots;
}

function normalizedScenes(spec) {
  if (!["1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version) || !spec.scene_graph?.scenes) return [];
  return spec.scene_graph.scenes.map((scene) => ({ ...scene, sidecar_module_ids: (scene.sidecar_module_ids ?? []).map(String), anchor_module_id: String(scene.anchor_module_id) }));
}

// ---- Desktop vertical rhythm ---------------------------------------------
// Whitespace between modules is measured from visible ink (the lowest ink of
// what is above to the highest ink of what is below), not from box edges, and
// uses three values, all taken from the grid's existing constants:
//   RHYTHM_AFTER_HEADING  section heading / scene header -> its first module
//   RHYTHM_WITHIN         one module -> the next inside a section
//   RHYTHM_BETWEEN        a section's last module -> the next section heading,
//                         and the last module -> the footer rule
// Proximity (Gestalt): things of one group sit closer than groups do, so
// WITHIN < BETWEEN. Each module's blank inset above and below its ink is known
// from how it is drawn (inkTop/inkBottom below), so no module carries a spare
// minimum height.
const RHYTHM_AFTER_HEADING = 28;
// Ink top of an ordinary chart/text module (see inkTop).
const BODY_INK_TOP = 10;
const RHYTHM_WITHIN = 28;
const RHYTHM_BETWEEN = 44;
const TEXT_BOTTOM_PAD = 6;
// The desktop page is 1440 wide with 96 margins, so a full-span module is 1248 wide; the layout and the storyboard height estimate both use these.
const DESKTOP_PAGE_W = 1440, DESKTOP_MARGIN = 96, DESKTOP_CONTENT_W = DESKTOP_PAGE_W - DESKTOP_MARGIN * 2;

// Top of the ink, measured from a module box's top edge.
function inkTop(module, bar) {
  if (module.type === "hero_stat") return bar || INFOGRAPHIC_HOUSE_STYLE_ACTIVE ? 0 : 28;
  if (module.type === "section_header") return 33;
  // Text, chart, illustration and pull-quote modules open with a hairline (too light to count as ink) and a small ordinal, which is their first ink.
  return module.emphasis === "hero" ? 8 : BODY_INK_TOP;
}

// Ink bottom of a desktop text module, measured from its box top (drawTextModule).
function textInkBottom(module, width) {
  const chars = Math.max(44, Math.round(width / 10));
  const headLines = module.heading ? lines(module.heading, Math.max(30, Math.round(width / 17)), 3).length : 0;
  const bodyLines = String(module.body ?? "").trim() ? lines(module.body, chars, 12).length : 0;
  const bodyTop = 48 + headLines * 32 + (module.heading ? 16 : 0);
  let bottom = bodyLines ? bodyTop + (bodyLines - 1) * 23 + 4 : 48 + Math.max(0, headLines - 1) * 32 + 7;
  if (module.source_quote) bottom = bodyTop + bodyLines * 23 + 14 + sourceQuoteBlockHeight(module.source_quote, width, false);
  return bottom;
}

// Lowest ink of a desktop section header, measured from its box top (drawn by the section_header renderer); inkBottomSlack and the storyboard box height share it.
function sectionHeaderInkBottom(headingLines, deckLines) {
  return deckLines ? 95 + headingLines * 42 + (deckLines - 1) * 23 + 4 : 91 + (headingLines - 1) * 42;
}

// Blank space between the lowest ink and a module box's bottom edge.
function inkBottomSlack(box, assets) {
  const { module, h, w } = box;
  if (module.type === "text") return h - textInkBottom(module, w);
  if (module.type === "hero_stat") {
    if (box.stat_bar) return TEXT_BOTTOM_PAD;
    const detailLines = module.detail ? lines(module.detail, Math.max(38, Math.round(w / 8)), 2).length : 0;
    return detailLines ? 17 - (detailLines - 1) * 16 : TEXT_BOTTOM_PAD;
  }
  if (module.type === "section_header") {
    const headingLines = String(module.heading ?? "") === "" ? 0 : lines(module.heading ?? "", 48, 3).length;
    const deckLines = module.deck ? lines(module.deck, 86, 3).length : 0;
    return h - sectionHeaderInkBottom(headingLines, deckLines);
  }
  if (module.type === "visual") {
    const asset = assets?.[module.manifest_ref];
    if (!asset) return 0;
    const captionH = outOfSetCaptionHeight(asset, module, false);
    if (captionH) return 4;
    const source = visualEmbedSource(asset, w, module);
    const info = trimmedSvgInfo(source);
    return 6 + (info.height === svgInfo(source).height ? 0 : CHART_INK_PAD * (w / info.width));
  }
  return 0;
}

export const _rhythmDebug = { svgInfo, svgInkBottom, trimmedSvgInfo, svgInkLeft, inkTop: (b) => inkTop(b.module, b.stat_bar), inkBottomSlack, sceneHeaderInk };
function sceneHeaderHeight(scene) {
  const titleLines = scene.title ? lines(scene.title, 48, 2).length : 0;
  const dekLines = scene.dek ? lines(scene.dek, 82, 2).length : 0;
  return (scene.eyebrow || scene.title || scene.dek) ? 28 + titleLines * 38 + dekLines * 22 + 20 : 0;
}

// Scene rule: a hero_with_rail rail with exactly one sidecar, a hero_stat.
function railStatBand(sidecars) {
  return INFOGRAPHIC_HOUSE_STYLE_ACTIVE && sidecars.length === 1 && sidecars[0].type === "hero_stat";
}

// Ink of a scene header, measured from the scene's top: [top, bottom], or null
// when the scene has no header (drawSceneChrome).
function sceneHeaderInk(scene) {
  if (!(scene.eyebrow || scene.title || scene.dek)) return null;
  const titleLines = scene.title ? lines(scene.title, 48, 2).length : 0;
  const dekLines = scene.dek ? lines(scene.dek, 82, 2).length : 0;
  const titleBase = scene.eyebrow ? 52 : 30;
  const top = scene.eyebrow ? 6 : scene.title ? titleBase - (/[\u2e80-\u9fff\uff00-\uffef]/.test(scene.title) ? 29 : 23) : titleBase + 7 - 14;
  const bottom = scene.dek ? titleBase + titleLines * 39 + 7 + (dekLines - 1) * 22 + 4 : scene.title ? titleBase + (titleLines - 1) * 39 + 4 : 19;
  return { top, bottom };
}

// Lowest ink of a group of laid-out boxes, from the group's own origin.
const boxesInkBottom = (boxes, assets, originY) => Math.max(...boxes.map((b) => b.y - originY + b.h - inkBottomSlack(b, assets)));
const boxesInkTop = (boxes, originY) => Math.min(...boxes.map((b) => b.y - originY + inkTop(b.module, b.stat_bar)));

// Built at y = 0; the caller moves it into place by its ink (see flush).
function buildDesktopScene(scene, spec, assets, y, rowIndex, margin, contentW, gap, col) {
  const byId = new Map((spec.modules ?? []).map((module) => [String(module.id), module]));
  const anchor = byId.get(scene.anchor_module_id);
  const sidecars = scene.sidecar_module_ids.map((id) => byId.get(id)).filter(Boolean);
  const header = sceneHeaderInk(scene);
  const sceneY = y;
  const boxes = [];
  // The anchor starts RHYTHM_AFTER_HEADING below the header's ink (or at the top without a header).
  const anchorInkTop = inkTop(anchor, false);
  const contentY = Math.round(header ? y + header.bottom + RHYTHM_AFTER_HEADING - anchorInkTop : y - anchorInkTop);
  const finish = (inkBottomAbs) => {
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    const top = header ? sceneY + header.top : boxesInkTop(boxes, 0);
    return { boxes, meta: { ...scene, x: margin, y: sceneY, w: contentW, h: bottom - sceneY, header_h: header ? contentY - sceneY : 0 }, height: bottom - sceneY, ink_top: top - sceneY, ink_bottom: inkBottomAbs - sceneY, header_ink_bottom: header ? header.bottom : null, body_ink_top: contentY + anchorInkTop - sceneY };
  };
  if (scene.pattern === "hero_with_rail") {
    const anchorW = contentW;
    const anchorH = moduleHeight(anchor, anchorW, assets, false);
    const anchorBox = { id: anchor.id, module: anchor, x: margin, y: contentY, w: anchorW, h: anchorH, cols: 12, density: moduleDensity(anchor), row_index: rowIndex, scene_id: scene.id, scene_role: "anchor" };
    boxes.push(anchorBox);
    const sideCols = sidecars.length === 1 ? 12 : sidecars.length === 2 ? 6 : 4;
    const bar = railStatBand(sidecars);
    const sized = sidecars.map((module) => {
      const w = shortTextWidth(module, sideCols * col + Math.max(0, sideCols - 1) * gap);
      return { module, w, h: bar ? heroStatBarMetrics(module, w).h : moduleHeight(module, w, assets, false) };
    });
    // The rail starts RHYTHM_WITHIN below the anchor's ink; its top is the highest ink among the sidecars.
    const railInkTop = sized.length ? Math.min(...sized.map((item) => inkTop(item.module, bar))) : 0;
    const railY = Math.round(contentY + anchorH - inkBottomSlack(anchorBox, assets) + RHYTHM_WITHIN - railInkTop);
    let xCols = 0;
    let railBottom = contentY + anchorH - inkBottomSlack(anchorBox, assets);
    sized.forEach(({ module, w, h }) => {
      const box = { id: module.id, module, x: margin + xCols * (col + gap), y: railY, w, h, cols: sideCols, density: moduleDensity(module), row_index: rowIndex, scene_id: scene.id, scene_role: "sidecar", ...(bar ? { stat_bar: true } : {}) };
      boxes.push(box);
      xCols += sideCols;
      railBottom = Math.max(railBottom, railY + h - inkBottomSlack(box, assets));
    });
    return finish(railBottom);
  }
  const anchorCols = 8;
  const sideCols = 4;
  const anchorW = anchorCols * col + (anchorCols - 1) * gap;
  const sideW = sideCols * col + (sideCols - 1) * gap;
  const anchorH = moduleHeight(anchor, anchorW, assets, false);
  const anchorBox = { id: anchor.id, module: anchor, x: margin, y: contentY, w: anchorW, h: anchorH, cols: anchorCols, density: moduleDensity(anchor), row_index: rowIndex, scene_id: scene.id, scene_role: "anchor" };
  boxes.push(anchorBox);
  let inkBottomAbs = contentY + anchorH - inkBottomSlack(anchorBox, assets);
  let sideY = Math.round(contentY + anchorInkTop - (sidecars[0] ? inkTop(sidecars[0], false) : 0));
  for (const [index, module] of sidecars.entries()) {
    const h = moduleHeight(module, sideW, assets, false);
    const box = { id: module.id, module, x: margin + anchorCols * (col + gap), y: sideY, w: sideW, h, cols: sideCols, density: moduleDensity(module), row_index: rowIndex, scene_id: scene.id, scene_role: "sidecar" };
    boxes.push(box);
    const bottom = sideY + h - inkBottomSlack(box, assets);
    inkBottomAbs = Math.max(inkBottomAbs, bottom);
    sideY = Math.round(bottom + RHYTHM_WITHIN - (sidecars[index + 1] ? inkTop(sidecars[index + 1], false) : 0));
  }
  return finish(inkBottomAbs);
}

function layoutDesktopWithStrategy(spec, assets, strategy) {
  const width = DESKTOP_PAGE_W, margin = DESKTOP_MARGIN, contentW = DESKTOP_CONTENT_W, gap = 28;
  const col = (contentW - gap * 11) / 12;
  const boxes = [];
  const scenes = [];
  let rowCols = 0, row = [], rowIndex = 0;
  // Vertical placement by ink (see RHYTHM_*): `prev` is the unit above - the
  // lowest ink of it, and whether it is a heading its next unit belongs to.
  let prev = null;
  const rhythm = [];
  const gapAfter = (startsSection) => (prev.heading ? RHYTHM_AFTER_HEADING : startsSection ? RHYTHM_BETWEEN : RHYTHM_WITHIN);
  const flush = () => {
    if (!row.length) return;
    const rowH = Math.max(...row.map((item) => item.h));
    const heading = row.length === 1 && row[0].module.type === "section_header";
    const startsSection = row.some((item) => item.module.type === "section_header");
    const top = Math.min(...row.map((item) => inkTop(item.module, item.stat_bar)));
    const bottom = Math.max(...row.map((item) => item.h - inkBottomSlack(item, assets)));
    const y = prev ? Math.round(prev.inkBottom + gapAfter(startsSection) - top) : 0;
    for (const item of row) boxes.push({ ...item, y, h: rowH, row_index: rowIndex });
    rhythm.push({ kind: heading ? "heading" : "row", section_start: startsSection, ink_top: y + top, ink_bottom: y + bottom });
    prev = { inkBottom: y + bottom, heading };
    rowCols = 0; row = []; rowIndex += 1;
  };
  const configuredScenes = normalizedScenes(spec);
  const sceneByMember = new Map();
  for (const scene of configuredScenes) for (const id of [scene.anchor_module_id, ...scene.sidecar_module_ids]) sceneByMember.set(String(id), scene);
  const placedScenes = new Set();
  let previousDensities = [];
  const ordered = statsAfterLinkedVisual(spec.modules, configuredScenes);
  // Desktop only, and only for a big number outside any scene that would sit
  // alone on its row: it pairs with a short text module right after it (4/8
  // columns) or becomes a full-width bar. Anything else is left as it was.
  const statColsOverride = new Map();
  const statBars = new Set();
  const forceBreakFor = (m, nextRowCols, prevDensities) => nextRowCols && (
    m.type === "section_header" || m.emphasis === "hero" || m.story_role === "turn" ||
    (strategy === "rhythm" && prevDensities.slice(-2).every((d) => d >= 0.72) && prevDensities.length >= 2 && moduleDensity(m) >= 0.72)
  );
  for (const [index, module] of ordered.entries()) {
    const scene = sceneByMember.get(String(module.id));
    if (scene) {
      if (!placedScenes.has(scene.id)) {
        flush();
        const built = buildDesktopScene(scene, spec, assets, 0, rowIndex, margin, contentW, gap, col);
        const sceneY = prev ? Math.round(prev.inkBottom + (prev.heading ? RHYTHM_AFTER_HEADING : RHYTHM_BETWEEN) - built.ink_top) : 0;
        boxes.push(...built.boxes.map((b) => ({ ...b, y: b.y + sceneY })));
        scenes.push({ ...built.meta, y: built.meta.y + sceneY });
        if (built.header_ink_bottom !== null) rhythm.push({ kind: "heading", section_start: true, ink_top: sceneY + built.ink_top, ink_bottom: sceneY + built.header_ink_bottom });
        rhythm.push({ kind: "row", section_start: built.header_ink_bottom === null, ink_top: sceneY + built.body_ink_top, ink_bottom: sceneY + built.ink_bottom });
        prev = { inkBottom: sceneY + built.ink_bottom, heading: false };
        rowIndex += 1;
        placedScenes.add(scene.id);
      }
      continue;
    }
    if (module.type === "hero_stat" && INFOGRAPHIC_HOUSE_STYLE_ACTIVE && !statColsOverride.has(String(module.id))) {
      const own = effectiveColumns(module, strategy);
      const startsRow = !rowCols || forceBreakFor(module, rowCols, previousDensities) || own === 12 || rowCols + own > 12;
      if (startsRow) {
        const next = ordered[index + 1];
        const nextScened = next ? sceneByMember.has(String(next.id)) : false;
        const nextCols = next ? (statColsOverride.get(String(next.id)) ?? effectiveColumns(next, strategy)) : 0;
        if (statIsAlone(own, next, nextCols, nextScened, previousDensities, module)) {
          if (!polishActive() && statPairsWithText(module, next, nextScened, col, gap) && !forceBreakFor(next, STAT_PAIR_STAT_COLS, [...previousDensities, moduleDensity(module)])) { statColsOverride.set(String(module.id), STAT_PAIR_STAT_COLS); statColsOverride.set(String(next.id), 12 - STAT_PAIR_STAT_COLS); }
          else statBars.add(String(module.id));
        }
      }
    }
    if (module.type === "text" && INFOGRAPHIC_HOUSE_STYLE_ACTIVE && !statColsOverride.has(String(module.id))) {
      const own = effectiveColumns(module, strategy);
      const next = ordered[index + 1];
      const nextScened = next ? sceneByMember.has(String(next.id)) : false;
      const startsRow = !rowCols || forceBreakFor(module, rowCols, previousDensities) || own === 12 || rowCols + own > 12;
      if (!polishActive() && startsRow && own === 12 && textPairsWithStat(module, next, nextScened, col, gap)
        && !forceBreakFor(next, 8, [...previousDensities, moduleDensity(module)])) {
        statColsOverride.set(String(module.id), 12 - STAT_PAIR_STAT_COLS);
        statColsOverride.set(String(next.id), STAT_PAIR_STAT_COLS);
      }
    }
    const bar = statBars.has(String(module.id));
    const cols = bar ? 12 : (statColsOverride.get(String(module.id)) ?? effectiveColumns(module, strategy));
    const density = moduleDensity(module);
    const denseRun = previousDensities.slice(-2).every((d) => d >= 0.72) && previousDensities.length >= 2 && density >= 0.72;
    const forceBreak = rowCols && (
      module.type === "section_header" ||
      module.emphasis === "hero" ||
      module.story_role === "turn" ||
      (strategy === "rhythm" && denseRun)
    );
    if (forceBreak || (rowCols && rowCols + cols > 12) || (cols === 12 && rowCols)) flush();
    const x = margin + rowCols * (col + gap);
    const w = shortTextWidth(module, cols * col + Math.max(0, cols - 1) * gap);
    const h = bar ? heroStatBarMetrics(module, w).h : moduleHeight(module, w, assets, false);
    row.push({ id: module.id, module, x, w, h, cols, density, ...(bar ? { stat_bar: true } : {}) });
    rowCols += cols;
    previousDensities.push(density);
    if (cols === 12 || rowCols === 12) flush();
  }
  flush();
  return { width, margin, contentW, boxes, scenes, contentHeight: Math.max(0, prev ? prev.inkBottom + RHYTHM_BETWEEN - 54 : 0), rhythm, strategy };
}

function scoreLayoutCandidate(spec, layout) {
  const rows = new Map();
  for (const box of layout.boxes) {
    const arr = rows.get(box.row_index) ?? [];
    arr.push(box); rows.set(box.row_index, arr);
  }
  let penalty = 0;
  const maxY = Math.max(1, layout.contentHeight);
  for (const row of rows.values()) {
    const minX = Math.min(...row.map((b) => b.x));
    const maxX = Math.max(...row.map((b) => b.x + b.w));
    const fill = (maxX - minX) / layout.contentW;
    const sectionOnly = row.length === 1 && row[0].module.type === "section_header";
    if (!sectionOnly && fill < 0.58) penalty += (0.58 - fill) * 28;
    if (row.length === 1 && row[0].cols <= 4 && row[0].module.emphasis !== "hero") penalty += 5;
  }
  for (const box of layout.boxes) {
    const p = Number.isInteger(box.module.priority) ? box.module.priority : 3;
    const yNorm = box.y / maxY;
    penalty += yNorm * (6 - p) * 5;
    if (box.module.emphasis === "hero" && box.w < layout.contentW * 0.64) penalty += 18;
    if (box.module.priority === 1 && box.w < layout.contentW * 0.5) penalty += 10;
  }
  const firstVisual = layout.boxes.find((b) => b.module.type === "visual" || b.module.type === "illustration");
  if (firstVisual) {
    const anchorY = firstVisual.y / maxY;
    if (anchorY > 0.46) penalty += (anchorY - 0.46) * 75;
  }
  let denseRun = 0;
  for (const module of spec.modules) {
    if (moduleDensity(module) >= 0.72) denseRun += 1;
    else denseRun = 0;
    if (denseRun > 2) penalty += 7 * (denseRun - 2);
  }
  return Number(penalty.toFixed(3));
}

function layoutDesktop(spec, assets) {
  if (!["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) return layoutDesktopWithStrategy(spec, assets, "balanced");
  const candidates = INFOGRAPHIC_LAYOUT_STRATEGIES.map((strategy) => {
    const layout = layoutDesktopWithStrategy(spec, assets, strategy);
    return { layout, score: scoreLayoutCandidate(spec, layout) };
  }).sort((a, b) => a.score - b.score || INFOGRAPHIC_LAYOUT_STRATEGIES.indexOf(a.layout.strategy) - INFOGRAPHIC_LAYOUT_STRATEGIES.indexOf(b.layout.strategy));
  const chosen = candidates[0].layout;
  return {
    ...chosen,
    candidate_scores: candidates.map((c) => ({ strategy: c.layout.strategy, score: c.score })),
  };
}

function moduleSequence(spec, mobile = false) {
  if (!mobile || !["1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version) || !Array.isArray(spec.mobile_module_order)) return spec.modules ?? [];
  const byId = new Map((spec.modules ?? []).map((module) => [String(module.id), module]));
  return spec.mobile_module_order.map((id) => byId.get(String(id))).filter(Boolean);
}

function layoutMobile(spec, assets) {
  const width = 720, margin = 46, contentW = width - margin * 2;
  const boxes = [];
  let y = 0;
  for (const module of moduleSequence(spec, true)) {
    const h = moduleHeight(module, contentW, assets, true);
    boxes.push({ id: module.id, module, x: margin, y, w: contentW, h, cols: 12, density: moduleDensity(module) });
    const gap = 34 + (module.emphasis === "hero" ? 16 : 0) + (module.story_role === "turn" ? 10 : 0);
    y += h + gap;
  }
  return { width, margin, contentW, boxes, scenes: [], contentHeight: Math.max(0, y - 34), strategy: "single_column", candidate_scores: [{ strategy: "single_column", score: 0 }] };
}

function headerMetrics(spec, mobile) {
  const titleChars = mobile ? 19 : 31;
  const dekChars = mobile ? 42 : 78;
  const titleLines = lines(spec.title, titleChars, mobile ? 6 : 4, true).length;
  const dekLines = lines(spec.dek, dekChars, mobile ? 8 : 5).length;
  const top = mobile ? 48 : 58;
  const titleSize = mobile ? 45 : 68;
  // A Latin display title can be set at 1.06em, but CJK glyphs fill the em
  // box, so two rows of them would sit about 4px apart; 1.2em leaves 14px.
  const wideTitle = Array.from(String(spec.title ?? "")).some(isWideChar);
  const titleLH = mobile ? (wideTitle ? 54 : 50) : (wideTitle ? 82 : 72);
  const dekSize = mobile ? 19 : 22;
  const dekLH = mobile ? 27 : 31;
  // Kicker baseline to first title baseline. On desktop the 68px title needs
  // 58px to clear the 14px kicker line under render QA's text boxes (0.8em
  // above, 0.25em below the baseline) and about 66px under Chrome's font
  // boxes; 68 also leaves CJK glyphs, which fill the em box, clear of it.
  const kicker = mobile ? 44 : 68;
  const meta = spec.byline || spec.date_label ? (mobile ? 42 : 38) : 10;
  return { top, kicker, titleSize, titleLH, titleLines, dekSize, dekLH, dekLines, meta, height: top + kicker + titleLines * titleLH + dekLines * dekLH + meta + (mobile ? 44 : 52) };
}

function drawHeader(parts, spec, width, margin, mobile) {
  const h = headerMetrics(spec, mobile);
  const t = INFOGRAPHIC_STRINGS[pageLang(spec)];
  parts.push(`<line x1="${margin}" y1="${h.top - 18}" x2="${width - margin}" y2="${h.top - 18}" stroke="${INK}" stroke-width="${mobile ? 5 : 6}"/>`);
  parts.push(`<text x="${margin}" y="${h.top}" font-family="${SANS}" font-size="${mobile ? 13 : 14}" font-weight="700" letter-spacing="2" fill="${ACCENT}">${esc(String(spec.kicker ?? t.kicker).toUpperCase())}</text>`);
  if (!mobile && process.env.NEWSROOM_TYPESET_FOOTER !== "1") parts.push(`<text x="${width - margin}" y="${h.top}" text-anchor="end" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.5" fill="${MUTED}">AGENTIC DATA NEWSROOM · 01</text>`);
  let y = h.top + h.kicker;
  textBlock(parts, spec.title, margin, y, { family: SERIF, size: h.titleSize, lineHeight: h.titleLH, weight: 700, maxChars: mobile ? 19 : 31, maxLines: mobile ? 6 : 4, headline: true });
  y += h.titleLines * h.titleLH + (mobile ? 18 : 22);
  textBlock(parts, spec.dek, margin, y, { size: h.dekSize, lineHeight: h.dekLH, fill: MUTED, maxChars: mobile ? 42 : 78, maxLines: mobile ? 8 : 5 });
  y += h.dekLines * h.dekLH + (mobile ? 18 : 20);
  const meta = [spec.byline ? `${t.byPrefix}${spec.byline}` : null, spec.date_label].filter(Boolean).join("  ·  ");
  if (meta) parts.push(`<text x="${margin}" y="${y}" font-family="${SANS}" font-size="${mobile ? 13 : 14}" font-weight="600" fill="${INK}">${esc(meta)}</text>`);
  parts.push(`<line x1="${margin}" y1="${h.height - 18}" x2="${width - margin}" y2="${h.height - 18}" stroke="${GRID}" stroke-width="1"/>`);
  return h.height;
}

// A big number that shares a claim with a visual reads best directly after
// that visual. Stable: only an unscened stat that precedes its linked
// visual moves, to just behind it; every other module keeps its place.
function statsAfterLinkedVisual(modules, scenes = []) {
  const claimsOf = (m) => new Set([m.claim_id, ...(m.claim_ids ?? []), ...(m.claim_set ?? [])].filter(Boolean).map(String));
  const scened = new Set(scenes.flatMap((sc) => [sc.anchor_module_id, ...(sc.sidecar_module_ids ?? [])]).map(String));
  const out = [...modules];
  for (const stat of modules) {
    if (stat.type !== "hero_stat" || scened.has(String(stat.id))) continue;
    const mine = claimsOf(stat);
    if (!mine.size) continue;
    const from = out.indexOf(stat);
    const to = out.findIndex((m, i) => i > from && m.type === "visual" && !scened.has(String(m.id)) && [...claimsOf(m)].some((c) => mine.has(c)));
    if (to < 0) continue;
    out.splice(from, 1);
    out.splice(to, 0, stat);
  }
  return out;
}

// The one rule for which modules print a number: hero_stat draws no ordinal chrome, so it must not consume a number either.
function printsOrdinal(module, isDecorative) {
  return !(module.type === "section_header" || module.type === "hero_stat" || module.emphasis === "hero" || isDecorative(module));
}

// The order a reader meets placed boxes: rows top to bottom (boxes whose tops are within ROW_TOLERANCE_PX of the row's first box
// share a row), left to right inside a row. Used for the printed numbers (desktop) and by moduleOrderWarnings; returns a new array.
const ROW_TOLERANCE_PX = 4;
export function readingOrder(boxes) {
  const rows = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && box.y - row[0].y <= ROW_TOLERANCE_PX) row.push(box);
    else rows.push([box]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

// Desktop passes the placed boxes, so the printed numbers follow what the reader sees (a scene puts its anchor ahead of its
// sidecars whatever the plan order is). Without boxes (mobile) the numbers follow the plan order, as before.
export function editorialOrdinalMap(spec, assets = {}, boxes = null) {
  const map = new Map();
  const isDecorative = (module) => isDecorativeIllustration(module, assets);
  const modules = spec.modules ?? [];
  let ordered = modules;
  if (boxes) {
    const placed = readingOrder(boxes).map((box) => box.module);
    const placedIds = new Set(placed.map((m) => String(m.id)));
    ordered = [...placed, ...modules.filter((m) => !placedIds.has(String(m.id)))];
  }
  let ordinal = 1;
  for (const module of ordered) if (printsOrdinal(module, isDecorative) && !map.has(String(module.id))) map.set(String(module.id), ordinal++);
  return map;
}

function drawSceneChrome(parts, scene, startY, mobile) {
  if (mobile) return;
  const y = scene.y + startY;
  if (scene.eyebrow) parts.push(`<text x="${scene.x}" y="${y + 16}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.8" fill="${ACCENT}">${esc(String(scene.eyebrow).toUpperCase())}</text>`);
  if (scene.title) textBlock(parts, scene.title, scene.x, y + (scene.eyebrow ? 52 : 30), { family: SERIF, size: 34, lineHeight: 39, weight: 700, maxChars: 48, maxLines: 2 });
  const titleLines = scene.title ? lines(scene.title, 48, 2).length : 0;
  if (scene.dek) textBlock(parts, scene.dek, scene.x, y + (scene.eyebrow ? 52 : 30) + titleLines * 39 + 7, { size: 15.5, lineHeight: 22, fill: MUTED, maxChars: 82, maxLines: 2 });
  parts.push(`<rect data-role="scene-boundary" data-scene-id="${esc(scene.id)}" x="${scene.x}" y="${y}" width="${scene.w}" height="${scene.h}" fill="none" stroke="none"/>`);
}

// The module label line is one unwrapped line of letter-spaced capitals, so
// a long label in a narrow module runs into its neighbour. Fit it to the
// module: the full label, else label_short, else the label cut with an
// ellipsis. Bold capitals average about 0.72em plus the letter-spacing.
// A wide (CJK/fullwidth) code point costs a full em plus the letter-spacing
// instead of that 0.72em Latin average, so it spends more than 1 unit of room.
function fitChromeText(prefix, module, width, size, spacing) {
  const advance = size * 0.72 + spacing;
  const room = Math.floor(width / advance);
  const wideCost = (size + spacing) / advance;
  const costOf = (char) => (isWideChar(char) ? wideCost : 1);
  const cost = (text) => Array.from(text).reduce((sum, char) => sum + costOf(char), 0);
  for (const label of [module.label, module.label_short]) {
    const text = `${prefix}${String(label ?? "").toUpperCase()}`;
    if (label && cost(text) <= room) return text;
  }
  const units = Array.from(`${prefix}${String(module.label).toUpperCase()}`);
  const maxCost = Math.max(1, room - 1);
  let kept = 0;
  let running = 0;
  for (const char of units) {
    const next = running + costOf(char);
    if (kept > 0 && next > maxCost) break;
    running = next;
    kept++;
  }
  return `${units.slice(0, Math.max(1, kept)).join("").trimEnd()}…`;
}

function drawModuleChrome(parts, box, ordinal, mobile, spec) {
  // Fix 10: hero_stat draws its own big label directly under the numeral
  // (see drawHeroStat) - the ordinal/label kicker below would print that
  // exact same module.label a second time, in miniature, above it. Skip
  // hero_stat's chrome entirely (hairline included), the same way
  // section_header already opts out of it, rather than keeping the hairline
  // and only dropping the label: hero_stat's own accent top rule (fix 9)
  // already marks its top edge, so a second, chrome-drawn hairline there
  // would be redundant too.
  if (box.module.type === "section_header" || box.module.type === "hero_stat") return;
  const y = box.y;
  const size = mobile ? 12 : 13;
  if (box.module.emphasis === "hero") {
    parts.push(`<text x="${box.x}" y="${y + 18}" font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="1.8" fill="${ACCENT}">${box.module.label ? esc(fitChromeText("", box.module, box.w, size, 1.8)) : INFOGRAPHIC_STRINGS[pageLang(spec)].primaryVisual}</text>`);
    return;
  }
  const number = String(ordinal ?? 0).padStart(2, "0");
  parts.push(`<line x1="${box.x}" y1="${y}" x2="${box.x + box.w}" y2="${y}" stroke="${box.module.tone === "dark" ? "#8a959d" : GRID}" stroke-width="1"/>`);
  // Fix 11: a visual module's own embedded chart SVG already carries its own
  // title (see renderVizSvg/embedVisual) - this kicker's "${number} · LABEL"
  // form was repeating that exact same string in miniature just above it.
  // Every other module type (text, illustration, ...) keeps its label in the
  // kicker; a visual module is restricted to a bare ordinal instead.
  const showLabel = box.module.type !== "visual" && Boolean(box.module.label);
  // NEWSROOM_ONE_NUMBERING=1: a page whose sections already carry panel numbers (1, 2, ...) does not number its modules a second time
  // (01 ... 12); the hairline stays, a labelled module keeps its label without the "NN · " prefix and a chart keeps nothing.
  const onePanelNumbering = process.env.NEWSROOM_ONE_NUMBERING === "1" && (spec?.modules ?? []).some((m) => m?.type === "section_header" && /^\d+$/.test(String(m.eyebrow ?? "")));
  if (onePanelNumbering) {
    if (showLabel) parts.push(`<text x="${box.x}" y="${y + 20}" font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="1.5" fill="${ACCENT}">${esc(fitChromeText("", box.module, box.w, size, 1.5))}</text>`);
    return;
  }
  parts.push(`<text x="${box.x}" y="${y + 20}" font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="1.5" fill="${ACCENT}">${showLabel ? esc(fitChromeText(`${number} · `, box.module, box.w, size, 1.5)) : number}</text>`);
}

function outOfSetCaptionHeight(asset, module, mobile) {
  return asset?.out_of_set_subjects?.length && String(module.subject_caption ?? "").trim()
    ? lines(module.subject_caption, mobile ? 54 : 110, 3).length * (mobile ? 16 : 17) + 12
    : 0;
}

function embedVisual(parts, asset, box, module, mobile) {
  const sourceSvg = !mobile && embedMinTextEnabled() ? visualEmbedSource(asset, box.w, module) : compactFits(asset, box.w, mobile) ? asset.compactSvg : mobile || spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
  if (!mobile && embedMinTextEnabled() && asset.inputs) for (const redraw of widthRedraws.values()) if (redraw && redraw.svg === sourceSvg) usedWidthRedraws.set(`${redraw.manifest_ref}|${redraw.width}`, { manifest_ref: redraw.manifest_ref, width: redraw.width, sha256: redraw.sha256 });
  const info = mobile ? svgInfo(sourceSvg) : trimmedSvgInfo(sourceSvg);
  const topPad = module.emphasis === "hero" ? 30 : (module.label ? 32 : 20);
  const captionH = outOfSetCaptionHeight(asset, module, mobile);
  const availableH = box.h - topPad - 6 - captionH;
  const targetW = box.w;
  const naturalH = targetW * (info.height / info.width);
  const targetH = Math.min(availableH, naturalH);
  const y = box.y + topPad;
  const inner = namespaceSvgInner(info.inner, `embed-${hash(module.id).slice(0, 8)}-${mobile ? "m" : "d"}`);
  // K267: a chart held narrower than its box by the height limit sits centred on a backing of its own paper colour across the whole box
  const narrowed = polishActive() && !mobile && targetH < naturalH - 0.5;
  const paper = narrowed ? String(info.inner).match(/<rect\b[^>]*\bwidth=["'][\d.]+["'][^>]*\bheight=["'][\d.]+["'][^>]*\bfill=["'](#[0-9a-f]{3,8})["']/i)?.[1] : null;
  if (paper) parts.push(`<rect data-role="infographic-visual-backing" data-module-id="${esc(module.id)}" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" fill="${paper}"/>`);
  parts.push(`<svg data-role="infographic-visual" data-module-id="${esc(module.id)}" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" viewBox="${info.minX} ${info.minY} ${info.width} ${info.height}" preserveAspectRatio="${mobile || paper ? "xMidYMin" : "xMinYMin"} meet">${inner}</svg>`);
  if (captionH) {
    // D1: the chart goes beyond the page subject set, so the runtime restyles it
    // (dashed frame) and prints the model's caption where readers see it.
    parts.push(`<rect data-role="out-of-set-frame" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" fill="none" stroke="${MUTED}" stroke-width="1.2" stroke-dasharray="6 4"/>`);
    parts.push('<g data-role="out-of-set-caption">');
    textBlock(parts, module.subject_caption, box.x, y + targetH + 18, { size: mobile ? 12 : 13, lineHeight: mobile ? 16 : 17, maxChars: mobile ? 54 : 110, maxLines: 3, fill: MUTED, italic: true });
    parts.push("</g>");
  }
}

function illustrationCaption(asset, module) {
  const credit = String(module.credit ?? asset.manifest?.credit ?? "").trim();
  const disclosure = String(asset.manifest?.provenance?.disclosure ?? "").trim();
  return uniq([credit, disclosure]).join(" · ");
}

function embedIllustration(parts, asset, box, module, mobile) {
  const sourceSvg = mobile || spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
  const info = svgInfo(sourceSvg);
  const topPad = module.emphasis === "hero" ? 30 : (module.label ? 32 : 20);
  const caption = illustrationCaption(asset, module);
  const captionH = caption ? (mobile ? 48 : 40) : 0;
  const availableH = box.h - topPad - captionH - 6;
  const targetW = box.w;
  const naturalH = targetW * (info.height / info.width);
  const targetH = Math.min(availableH, naturalH);
  const y = box.y + topPad;
  const inner = namespaceSvgInner(info.inner, `illustration-${hash(module.id).slice(0, 8)}-${mobile ? "m" : "d"}`);
  parts.push(`<svg data-role="infographic-illustration" data-module-id="${esc(module.id)}" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" viewBox="${info.minX} ${info.minY} ${info.width} ${info.height}" preserveAspectRatio="xMidYMin meet">${inner}</svg>`);
  if (caption) textBlock(parts, caption, box.x, y + targetH + (mobile ? 15 : 14), { size: mobile ? 12 : 12.5, lineHeight: 16, fill: MUTED, maxChars: mobile ? 78 : Math.max(62, Math.round(box.w / 7)), maxLines: 2, role: "illustration-credit" });
  if (caption) parts.push(`<rect data-role="illustration-credit" data-module-id="${esc(module.id)}" x="${box.x}" y="${y + targetH}" width="1" height="1" fill="none"/>`);
}

// E2 tuning knobs. A big number that would sit alone on a desktop row pairs
// with the next module when that is a short text (<= STAT_PAIR_MAX_TEXT_LINES
// body lines at the width it gets beside the number, no source quote); the
// number takes STAT_PAIR_STAT_COLS of 12 columns and the text the rest.
// Otherwise it is drawn as a full-width bar (STAT_BAR_* below).
const STAT_PAIR_MAX_TEXT_LINES = 4;
const STAT_PAIR_STAT_COLS = 4;
const STAT_BAR_PAD = 30;
const STAT_BAR_MIN_NUMERAL_ZONE = 150;
const STAT_BAR_GUTTER = 36;

// Page-rhythm tuning knobs. A text block that sets in at most
// TEXT_SHORT_MAX_LINES lines across a full 12-column row never fills that row
// on its own: it pairs with a big number right after it (8 + 4 columns), and
// otherwise its box is narrowed to a readable measure (the row height already
// follows the text). clreq (W3C) gives no numeric line length, so the cap is converted from
// Bringhurst's 45-75 Latin characters: 75 is the upper bound and the code's
// width unit counts a Latin character as 1 and a Han character as 2
// (viz.mjs textUnits), i.e. about 37 Han characters.
const TEXT_SHORT_MAX_LINES = 2;
const TEXT_MEASURE_MAX_UNITS = 75;
const TEXT_FULL_ROW_MIN_W = 1200;

function textIsShortFullRow(module, width) {
  if (module.source_quote || width < TEXT_FULL_ROW_MIN_W) return false;
  const body = String(module.body ?? "").trim();
  return Boolean(body) && lines(body, Math.max(44, Math.round(width / 10))).length <= TEXT_SHORT_MAX_LINES;
}

// Box width for a short text that has a whole 12-column row to itself: the
// readable measure, not the row. Anything else keeps the width it was given.
function shortTextWidth(module, width) {
  if (polishActive()) return width; // the rule above a short note runs the whole column like every other row
  return module.type === "text" && textIsShortFullRow(module, width) ? Math.min(width, TEXT_MEASURE_MAX_UNITS * 10) : width;
}

// Does a stat's label and detail still fit its 2-line cut at the paired width?
function statFitsPaired(stat, col, gap) {
  const statW = STAT_PAIR_STAT_COLS * col + (STAT_PAIR_STAT_COLS - 1) * gap;
  if (lines(stat.label ?? "", Math.max(28, Math.round(statW / 10))).length > 2) return false;
  return !stat.detail || lines(stat.detail, Math.max(38, Math.round(statW / 8))).length <= 2;
}

// A short lone text pairs with the big number right after it (text 8, stat 4).
function textPairsWithStat(text, next, nextScened, col, gap) {
  if (text.type !== "text" || !next || nextScened || next.type !== "hero_stat") return false;
  if (!textIsShortFullRow(text, 12 * col + 11 * gap)) return false;
  return statFitsPaired(next, col, gap);
}

// Pairing rule: is the stat alone in its row? (next is the module after it.)
function statIsAlone(own, next, nextCols, nextScened, previousDensities, module) {
  if (own === 12 || !next || nextScened || next.type === "section_header" || nextCols === 12 || own + nextCols > 12) return true;
  return Boolean(next.emphasis === "hero" || next.story_role === "turn");
}

// Pairing rule: may the next module share the stat's row at (12 - stat cols)?
function statPairsWithText(stat, next, nextScened, col, gap) {
  // The stacked stat cuts its label and detail at 2 lines: pair only when
  // both fit at the narrow width, otherwise the band, which never truncates.
  if (!statFitsPaired(stat, col, gap)) return false;
  if (!next || nextScened || next.type !== "text" || next.source_quote || next.emphasis === "hero" || next.story_role === "turn") return false;
  const width = (12 - STAT_PAIR_STAT_COLS) * col + (11 - STAT_PAIR_STAT_COLS) * gap;
  const body = String(next.body ?? "").trim();
  return !body || lines(body, Math.max(44, Math.round(width / 10))).length <= STAT_PAIR_MAX_TEXT_LINES;
}

// Width of the big numeral (58px serif) plus its unit (24px) at the left of a
// full-width stat bar: digits ~0.56em, wide (CJK) characters 1em, '.' ~0.3em.
// NEWSROOM_HERO_SIZE_UP=1 (exact "1", default off, K298): the numeral is drawn at heroNumeralSize px and the unit keeps the 24/58 ratio.
const HERO_NUMERAL_BASE = 58, HERO_NUMERAL_MAX = 88, HERO_NUMERAL_ZONE_SHARE = 0.45;
const heroSizeUpEnabled = () => process.env.NEWSROOM_HERO_SIZE_UP === "1";
// NEWSROOM_HERO_GLYPH_WIDTH=1 (exact "1", default off, K318): the bold serif numerals and the minus sign are drawn wider than 0.56em (a lead number such as
// \u2212325.6 with a three-character unit put the unit 2px into the detail line at 58px), so the width estimate uses 0.62em for a digit or sign and 0.32em for a point.
const heroGlyphWide = () => process.env.NEWSROOM_HERO_GLYPH_WIDTH === "1";
const heroGlyphs = (text, size) => Array.from(String(text ?? "")).reduce((sum, ch) => sum + size * (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : ch === "." || ch === "," ? (heroGlyphWide() ? 0.32 : 0.3) : heroGlyphWide() ? 0.62 : 0.56), 0);
function statNumeralWidth(module, size = HERO_NUMERAL_BASE) {
  return Math.ceil(heroGlyphs(heroValueText(module), size) + (module.unit ? 7 + heroGlyphs(module.unit, (24 / HERO_NUMERAL_BASE) * size) : 0));
}
// Numeral size of a full-width stat bar: 88px, 5.3x the 16.5px page body text. The two public scales checked against the source put the largest display size at
// 4.2x the body (GOV.UK: 80px over 19px body) and 5.75x (Carbon: 92px over 16px); 88 sits between them. When the numeral and unit would take more than 45% of the bar,
// the largest whole size that fits is used instead, never under today's 58.
function heroNumeralSize(module, width) {
  if (!heroSizeUpEnabled()) return HERO_NUMERAL_BASE;
  const room = HERO_NUMERAL_ZONE_SHARE * (width - 2 * STAT_BAR_PAD - STAT_BAR_GUTTER);
  const fit = Math.floor(Math.max(0, room - (module.unit ? 7 : 0)) / Math.max(1e-6, heroGlyphs(heroValueText(module), 1) + (module.unit ? heroGlyphs(module.unit, 24 / HERO_NUMERAL_BASE) : 0)));
  return Math.max(HERO_NUMERAL_BASE, Math.min(HERO_NUMERAL_MAX, fit));
}

// Full-width stat bar (desktop): numeral on the left, label and detail to its
// right; the row height follows the wrapped text.
// NEWSROOM_HERO_THOUSANDS=1 (exact): a hero number written as plain digits of five or more places (70646) is drawn with thousands
// separators (70,646), the same grouping the chart labels and story forms already use (plainNum in story_forms.mjs, 10,000 and up).
// GB/T 15835-2011 allows the three-digit grouping for four or more places; 万/亿 conversion is not used here because a hero value
// is the exact bound number and its unit text already follows it. Drawing only: the plan's value string, the claim binding and the
// number checks keep the original digits. Off, or any value that is not a bare number, is returned untouched.
export function heroValueText(module) {
  const raw = String(module?.value ?? "");
  if (process.env.NEWSROOM_HERO_THOUSANDS !== "1") return raw;
  const m = raw.match(/^(-?)(\d{5,})(\.\d+)?$/);
  return m ? `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${m[3] ?? ""}` : raw;
}

function heroStatBarMetrics(module, width) {
  const pad = STAT_BAR_PAD;
  const size = heroNumeralSize(module, width);
  const textX = pad + Math.max(STAT_BAR_MIN_NUMERAL_ZONE, statNumeralWidth(module, size) + STAT_BAR_GUTTER);
  const avail = Math.max(240, width - textX - pad);
  const labelLines = lines(module.label ?? "", Math.max(20, Math.floor(avail / 10.5)));
  const detailLines = module.detail ? lines(module.detail, Math.max(24, Math.floor(avail / 8.2))) : [];
  const textH = 22 + (labelLines.length - 1) * 20 + (detailLines.length ? 10 + detailLines.length * 16 : 0);
  // Page polish: the label starts on the numeral's own baseline instead of floating at the bar's top right.
  if (polishActive()) return { pad, textX, labelLines, detailLines, size, labelBase: size, h: size + 6 + (labelLines.length - 1) * 20 + (detailLines.length ? 10 + 16 * detailLines.length : 0) + TEXT_BOTTOM_PAD };
  // Size-up: the numeral baseline is at `size`, so the bar is at least that tall (off: size is 58 and the old height wins, unchanged).
  return { pad, textX, labelLines, detailLines, size, h: Math.max(size > HERO_NUMERAL_BASE ? size + 6 : 59, detailLines.length ? 36 + (labelLines.length - 1) * 20 + 16 * detailLines.length : 31 + (labelLines.length - 1) * 20) + TEXT_BOTTOM_PAD };
}

function drawHeroStatBar(parts, box, module, accent = ACCENT) {
  const m = heroStatBarMetrics(module, box.w);
  // The row gap above (40px) or the rail gap (14px) already separates the band
  // from the module above, so its rule sits on the box edge.
  const top = box.y;
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${top}" width="${box.w}" height="3" fill="${accent}"/>`);
  parts.push(`<text x="${box.x + m.pad}" y="${top + m.size}" font-family="${SERIF}" font-size="${m.size}" font-weight="700" fill="${accent}">${esc(heroValueText(module))}${module.unit ? `<tspan font-size="${Math.round((24 / HERO_NUMERAL_BASE) * m.size)}" dx="7" fill="${INK}">${esc(module.unit)}</tspan>` : ""}</text>`);
  const x = box.x + m.textX;
  const labelY = m.labelBase !== undefined ? top + m.labelBase : top + 3 + 6 + 18;
  m.labelLines.forEach((line, i) => parts.push(`<text x="${x}" y="${labelY + i * 20}" font-family="${SANS}" font-size="15.5" font-weight="700" fill="${INK}">${esc(line)}</text>`));
  const detailY = labelY + (m.labelLines.length - 1) * 20 + 10 + 12;
  m.detailLines.forEach((line, i) => parts.push(`<text x="${x}" y="${detailY + i * 16}" font-family="${SANS}" font-size="12" fill="${MUTED}">${esc(line)}</text>`));
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${box.y + box.h - 1}" width="1" height="1" fill="none"/>`);
}

function drawHeroStat(parts, box, module, mobile, accent = ACCENT) {
  if (box.stat_bar && !mobile && INFOGRAPHIC_HOUSE_STYLE_ACTIVE) return drawHeroStatBar(parts, box, module, accent);
  const pad = mobile ? 28 : 30;
  // Desktop house style: the red rule sits at box.y, the same y as the hairline drawModuleChrome draws for neighbouring modules.
  const top = box.y + (INFOGRAPHIC_HOUSE_STYLE_ACTIVE ? (mobile ? 14 : 0) : 28);
  if (!INFOGRAPHIC_HOUSE_STYLE_ACTIVE) {
    // Legacy: unchanged, byte-for-byte - the solid tone-coloured card fix 9
    // replaces under house style. tone still selects the card colour and
    // its matching foreground/detail contrast pair exactly as before.
    const tone = module.tone ?? "accent";
    const fill = tone === "dark" ? DARK : tone === "light" ? FAINT : LEGACY_ACCENT;
    const fg = tone === "light" ? LEGACY_INK : "#ffffff";
    // "#f5d9d5" (a muted pink) reads at 10:1 against DARK but only 3.54:1 against
    // ACCENT's brighter red - below the 4.5:1 floor for 12px normal text. Give the
    // accent tone its own near-white tint (4.61:1 against ACCENT) instead of
    // reusing the dark-tone colour; "dark" and "light" keep their prior values.
    const muted = tone === "light" ? LEGACY_MUTED : tone === "accent" ? "#fefcfc" : "#f5d9d5";
    parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${top}" width="${box.w}" height="${box.h - 28}" rx="5" fill="${fill}"/>`);
    parts.push(`<text x="${box.x + pad}" y="${top + (mobile ? 69 : 66)}" font-family="${SERIF}" font-size="${mobile ? 54 : 58}" font-weight="700" fill="${fg}">${esc(heroValueText(module))}${module.unit ? `<tspan font-size="${mobile ? 22 : 24}" dx="7">${esc(module.unit)}</tspan>` : ""}</text>`);
    textBlock(parts, module.label, box.x + pad, top + (mobile ? 106 : 102), { size: mobile ? 15 : 15.5, lineHeight: mobile ? 20 : 20, weight: 700, fill: fg, maxChars: mobile ? 48 : Math.max(28, Math.round(box.w / 10)), maxLines: 2 });
    if (module.detail) textBlock(parts, module.detail, box.x + pad, box.y + box.h - 20, { size: 12, lineHeight: 16, fill: muted, maxChars: mobile ? 70 : Math.max(38, Math.round(box.w / 8)), maxLines: 2 });
    // Invisible end marker (paired with the start rect's same data-role, both
    // carrying data-module-id): lets tooling bound "everything this one call
    // drew" without depending on how many text lines label/detail wrapped to.
    parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${box.y + box.h - 1}" width="1" height="1" fill="none"/>`);
    return;
  }
  // House style (fix 9): no filled card. The numeral carries the page's one
  // accent colour on plain white; the unit, label and detail read in ink/
  // muted like any other module's text; a thin accent rule across the top
  // (in place of the old solid slab) is the only colour cue marking this as
  // a highlighted number. tone no longer selects a card colour under house
  // style - one accent, used the same way everywhere else on the page,
  // replaces the three-tone card palette (contrast is unaffected: ACCENT
  // and INK/MUTED on white are already the combinations used throughout the
  // rest of this file).
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${top}" width="${box.w}" height="3" fill="${accent}"/>`);
  parts.push(`<text x="${box.x + pad}" y="${top + (mobile ? 69 : 66)}" font-family="${SERIF}" font-size="${mobile ? 54 : 58}" font-weight="700" fill="${accent}">${esc(heroValueText(module))}${module.unit ? `<tspan font-size="${mobile ? 22 : 24}" dx="7" fill="${INK}">${esc(module.unit)}</tspan>` : ""}</text>`);
  textBlock(parts, module.label, box.x + pad, top + (mobile ? 106 : 102), { size: mobile ? 15 : 15.5, lineHeight: mobile ? 20 : 20, weight: 700, fill: INK, maxChars: mobile ? 48 : Math.max(28, Math.round(box.w / 10)), maxLines: 2 });
  if (module.detail) textBlock(parts, module.detail, box.x + pad, box.y + box.h - 20, { size: 12, lineHeight: 16, fill: MUTED, maxChars: mobile ? 70 : Math.max(38, Math.round(box.w / 8)), maxLines: 2 });
  // Invisible end marker - see the matching comment in the legacy branch above.
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${box.y + box.h - 1}" width="1" height="1" fill="none"/>`);
}

// Source-quote note block: a visibly distinct footnote-style panel beneath a
// text module's own (claim-bound) body copy. It is never styled like the
// module's asserted body text - a tinted background, an eyebrow label, an
// italic verbatim quote and an explicit page number, plus a labeled
// translation line when the plan supplies one - so a reader (and the
// browser-QA/vision critic) can tell it apart from a verified finding at a
// glance. Language-generic: which labels it prints follows the page's own
// language (B1), not the quote's source language.
function sourceQuoteChars(width, mobile) { return mobile ? 50 : Math.max(40, Math.round(width / 11)); }
function sourceQuoteBlockHeight(sourceQuote, width, mobile) {
  const chars = sourceQuoteChars(width, mobile);
  const quoteLines = lines(`“${sourceQuote.quote}”`, chars, 6).length;
  const translationLines = sourceQuote.translation ? lines(sourceQuote.translation, chars, 5).length : 0;
  return 30 + quoteLines * (mobile ? 21 : 20) + (translationLines ? translationLines * (mobile ? 20 : 19) + 8 : 0) + 22;
}
function drawSourceQuoteBlock(parts, x, y, width, sourceQuote, mobile, spec) {
  const strings = INFOGRAPHIC_STRINGS[pageLang(spec)];
  const chars = sourceQuoteChars(width, mobile);
  let cursor = y;
  parts.push(`<rect data-role="source-quote-note" x="${x}" y="${cursor}" width="${width}" height="6" fill="${GRID}"/>`);
  cursor += 22;
  parts.push(`<text x="${x}" y="${cursor}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.4" fill="${MUTED}">${esc(strings.sourceQuoteLabel.toUpperCase())} · ${esc(strings.sourceQuotePage)} ${esc(sourceQuote.page)}</text>`);
  cursor += 20;
  const quoteHeight = textBlock(parts, `“${sourceQuote.quote}”`, x, cursor, { size: mobile ? 14.5 : 15, lineHeight: mobile ? 21 : 20, fill: MUTED, italic: true, maxChars: chars, maxLines: 6 });
  cursor += quoteHeight;
  if (sourceQuote.translation) {
    cursor += 6;
    textBlock(parts, `${strings.sourceQuoteTranslation}: ${sourceQuote.translation}`, x, cursor, { size: mobile ? 13.5 : 14, lineHeight: mobile ? 20 : 19, fill: MUTED, maxChars: chars, maxLines: 5 });
  }
}

function drawTextModule(parts, box, module, mobile, spec) {
  // Below drawModuleChrome's ordinal line (13px at +20 on desktop), a 27px
  // heading at +42 overlaps it; +48 clears it. moduleHeight adds the 6px.
  const top = box.y + (mobile ? 42 : 48);
  if (module.heading) {
    textBlock(parts, module.heading, box.x, top, { family: SERIF, size: mobile ? 25 : 27, lineHeight: mobile ? 30 : 32, weight: 700, maxChars: mobile ? 35 : Math.max(30, Math.round(box.w / 17)), maxLines: 3 });
  }
  const headLines = module.heading ? lines(module.heading, mobile ? 35 : Math.max(30, Math.round(box.w / 17)), 3).length : 0;
  const bodyTop = top + headLines * (mobile ? 30 : 32) + (module.heading ? 16 : 0);
  const bodyHeight = String(module.body ?? "").trim()
    ? textBlock(parts, module.body, box.x, bodyTop, { size: mobile ? 16 : 16.5, lineHeight: mobile ? 24 : 23, fill: INK, maxChars: mobile ? 54 : Math.max(44, Math.round(box.w / 10)), maxLines: 12 })
    : 0;
  if (module.source_quote) drawSourceQuoteBlock(parts, box.x, bodyTop + bodyHeight + 14, box.w, module.source_quote, mobile, spec);
}

function drawSectionHeader(parts, box, module, mobile, spec) {
  const y = box.y + (mobile ? 44 : 42);
  const headingChars = mobile ? 31 : 48;
  const headingLH = mobile ? 37 : 42;
  const headingLines = String(module.heading ?? "") === "" ? 0 : lines(module.heading ?? "", headingChars, 3, true).length;
  parts.push(`<text x="${box.x}" y="${y}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="2" fill="${ACCENT}">${esc(String(module.eyebrow ?? INFOGRAPHIC_STRINGS[pageLang(spec)].theStory).toUpperCase())}</text>`);
  textBlock(parts, module.heading, box.x, y + (mobile ? 38 : 40), { family: SERIF, size: mobile ? 31 : 36, lineHeight: headingLH, weight: 700, maxChars: headingChars, maxLines: 3, headline: true });
  if (module.deck) textBlock(parts, module.deck, box.x, y + (mobile ? 38 : 40) + headingLines * headingLH + 13, { size: mobile ? 15 : 16, lineHeight: mobile ? 22 : 23, fill: MUTED, maxChars: mobile ? 55 : 86, maxLines: 3 });
}

// Desktop pull quotes are 30px bold serif, about 0.55em a character, set 34px
// in from the module edge; moduleHeight and drawPullQuote wrap them alike.
function pullQuoteChars(width) {
  return Math.max(12, Math.floor((width - 34) / 16.5));
}

function drawPullQuote(parts, box, module, mobile) {
  const y = box.y + 38;
  parts.push(`<rect x="${box.x}" y="${box.y + 28}" width="${mobile ? 6 : 7}" height="${Math.max(80, box.h - 48)}" fill="${ACCENT}"/>`);
  textBlock(parts, `“${module.text}”`, box.x + (mobile ? 28 : 34), y + 22, { family: SERIF, size: mobile ? 27 : 30, lineHeight: mobile ? 34 : 38, weight: 700, maxChars: mobile ? 33 : pullQuoteChars(box.w), maxLines: 7 });
  if (module.attribution) textBlock(parts, module.attribution, box.x + (mobile ? 28 : 34), box.y + box.h - 20, { size: mobile ? 12 : 13, lineHeight: 17, weight: 700, fill: MUTED, maxChars: 55, maxLines: 2 });
}

// NEWSROOM_LOCAL_SOURCE_NOTE=1: when every visual on the page carries a program-written source line (source_note_program, set from an
// accepted note beside a user's data file), the model's page-level source_note is not shown and not read as reader text. The saved plan
// keeps the model's text. One function, used by the footer and by the reader-text checks, so what is checked is what is printed.
export function pageSourceNoteReplaced(spec, assets) {
  if (process.env.NEWSROOM_LOCAL_SOURCE_NOTE !== "1") return false;
  const visuals = (spec?.modules ?? []).filter((m) => m.type === "visual");
  if (!visuals.length || !visuals.every((m) => assets?.[m.manifest_ref]?.manifest?.source_note_program === true)) return false;
  return typeof spec?.source_note === "string" && spec.source_note.trim() !== "";
}

export function effectivePageSourceNote(spec, assets) {
  return pageSourceNoteReplaced(spec, assets) ? undefined : spec?.source_note;
}

function sourceList(spec, assets) {
  const notes = uniq([
    effectivePageSourceNote(spec, assets),
    ...(spec.modules ?? []).filter((m) => m.type === "visual").map((m) => assets[m.manifest_ref]?.manifest?.source_note),
    ...(spec.modules ?? []).filter((m) => m.type === "illustration").map((m) => assets[m.asset_ref]?.manifest?.source_note),
  ]);
  // Notes often join several citations with "；"/";" and the page-level note
  // usually restates the chart notes: write each citation once, dropping any
  // segment already contained in a longer one.
  const norm = (x) => x.replace(/\s+/g, "").toLowerCase();
  const segments = notes.flatMap((note) => String(note).split(/[；;]\s*/).map((x) => x.trim()).filter(Boolean));
  const kept = segments.filter((seg, i) => !segments.some((other, j) => j !== i && (norm(other).includes(norm(seg)) && (norm(other).length > norm(seg).length || j < i))));
  return kept;
}

// NEWSROOM_DATA_NOTES: a chart whose one-line source-flag note was too long for its line said only 「详见数据说明」; the program-written full
// sentence (manifest.data_note_full) is printed once here, under the sources. Empty when no chart carries one, so the page is unchanged.
function dataNoteText(spec, assets) {
  const full = uniq((spec.modules ?? []).filter((m) => m.type === "visual").map((m) => assets[m.manifest_ref]?.manifest?.data_note_full).filter((x) => typeof x === "string" && x !== ""));
  return full.length ? `数据说明：${full.join("；")}` : "";
}

function composeOne(spec, assets, mobile) {
  applyInfographicStyle(spec);
  const header = headerMetrics(spec, mobile);
  const layout = mobile ? layoutMobile(spec, assets) : layoutDesktop(spec, assets);
  const dataNoteBlock = dataNoteText(spec, assets);
  const dataNoteMaxChars = mobile ? 92 : 172;
  const footerH = (mobile ? 150 : 128) + (dataNoteBlock ? lines(dataNoteBlock, dataNoteMaxChars, 3).length * (mobile ? 16 : 17) + 6 : 0);
  const startY = header.height;
  const pageHeight = startY + layout.contentHeight + footerH + (mobile ? 34 : 42);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${pageHeight}" role="img" aria-labelledby="info-title info-desc" data-infographic-version="${esc(spec.schema_version)}" data-viewport="${mobile ? "mobile" : "desktop"}" data-layout-strategy="${esc(layout.strategy ?? (mobile ? "single_column" : "balanced"))}"${tabularRootAttrs()}>`];
  parts.push(`<title id="info-title">${esc(spec.title)}</title>`);
  parts.push(`<desc id="info-desc">${esc(spec.alt)}</desc>`);
  parts.push(`<rect width="${layout.width}" height="${pageHeight}" fill="${PAPER}"/>`);
  drawHeader(parts, spec, layout.width, layout.margin, mobile);
  const shiftedBoxes = layout.boxes.map((box) => ({ ...box, y: box.y + startY }));
  for (const scene of layout.scenes ?? []) drawSceneChrome(parts, scene, startY, mobile);
  const ordinals = editorialOrdinalMap(spec, assets, mobile ? null : layout.boxes);
  const polish = polishActive();
  shiftedBoxes.forEach((box) => {
    const module = box.module;
    if (module.type !== "section_header" && !isDecorativeIllustration(module, assets)) drawModuleChrome(parts, box, ordinals.get(String(module.id)), mobile, spec);
    if (module.type === "hero_stat") drawHeroStat(parts, box, module, mobile, polish ? (legendAccent(spec, module) ?? INK) : ACCENT);
    else if (module.type === "visual") embedVisual(parts, assets[module.manifest_ref], box, module, mobile);
    else if (module.type === "illustration") embedIllustration(parts, assets[module.asset_ref], box, module, mobile);
    else if (module.type === "text") drawTextModule(parts, box, module, mobile, spec);
    else if (module.type === "section_header") drawSectionHeader(parts, box, module, mobile, spec);
    else if (module.type === "pull_quote") drawPullQuote(parts, box, module, mobile);
  });
  const footerY = startY + layout.contentHeight + (mobile ? 50 : 54);
  parts.push(`<line x1="${layout.margin}" y1="${footerY}" x2="${layout.width - layout.margin}" y2="${footerY}" stroke="${INK}" stroke-width="2"/>`);
  parts.push(`<text x="${layout.margin}" y="${footerY + 30}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.3" fill="${INK}">${INFOGRAPHIC_STRINGS[pageLang(spec)].sourcesMethods}</text>`);
  const sources = sourceList(spec, assets);
  const sourcesHeight = textBlock(parts, sources.join(" · "), layout.margin, footerY + 57, { size: mobile ? 12 : 12.5, lineHeight: mobile ? 16 : 17, fill: MUTED, maxChars: mobile ? 92 : 172, maxLines: mobile ? 5 : 4 });
  if (dataNoteBlock) textBlock(parts, dataNoteBlock, layout.margin, footerY + 57 + sourcesHeight + 6, { size: mobile ? 12 : 12.5, lineHeight: mobile ? 16 : 17, fill: MUTED, maxChars: dataNoteMaxChars, maxLines: 3 });
  // NEWSROOM_TYPESET_FOOTER=1 (exact): a zh page prints no English footer line, and an en page prints the brand without a
  // verification claim - the page is rendered before verification runs and nothing re-renders it afterwards, so the word
  // "VERIFIED" is never earned at render time.
  const footerLine = process.env.NEWSROOM_TYPESET_FOOTER === "1" ? (pageLang(spec) === "zh" ? null : "AGENTIC DATA NEWSROOM") : "AGENTIC DATA NEWSROOM · VERIFIED VISUAL STORY";
  if (footerLine) parts.push(`<text x="${layout.width - layout.margin}" y="${pageHeight - 26}" text-anchor="end" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.2" fill="${MUTED}">${footerLine}</text>`);
  for (const box of shiftedBoxes) parts.push(`<rect data-role="module-boundary" data-module-id="${esc(box.id)}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="none"/>`);
  parts.push("</svg>");
  const visualKinds = uniq((spec.modules ?? []).flatMap((m) => {
    if (m.type === "visual") return [assets[m.manifest_ref]?.manifest?.chart_type];
    if (m.type === "illustration") {
      if (isDecorativeIllustration(m, assets)) return [];
      const manifest = assets[m.asset_ref]?.manifest;
      if (manifest?.kind === "rich_illustration") return [`illustration:rich:${manifest?.provenance?.origin ?? "unknown"}`];
      return [manifest?.view ? `illustration:${manifest.view}` : "illustration"];
    }
    return [];
  }));
  return {
    svg: parts.join("\n") + "\n",
    width: layout.width,
    height: pageHeight,
    ...(mobile ? {} : {
      rhythm: (layout.rhythm ?? []).map((u) => ({ ...u, ink_top: u.ink_top + startY, ink_bottom: u.ink_bottom + startY })),
      footer_y: footerY,
    }),
    boxes: shiftedBoxes,
    scenes: (layout.scenes ?? []).map((scene) => ({ ...scene, y: scene.y + startY })),
    sources,
    layout_strategy: layout.strategy ?? (mobile ? "single_column" : "balanced"),
    candidate_scores: layout.candidate_scores ?? [{ strategy: layout.strategy ?? "balanced", score: 0 }],
    visual_kinds: visualKinds,
    ...((spec.modules ?? []).some((m) => isDecorativeIllustration(m, assets)) ? { decorative_module_ids: (spec.modules ?? []).filter((m) => isDecorativeIllustration(m, assets)).map((m) => String(m.id)) } : {}),
  };
}

export function composeInfographicBundle(specIn, assets = {}, { mobilePages = true, chartCheck = null } = {}) {
  activeChartCheck = typeof chartCheck === "function" ? chartCheck : null;
  widthRedraws.clear();
  const errors = validateInfographicSpec(specIn);
  if (errors.length) throw new Error(errors.join("; "));
  const spec = expandPanels(specIn);
  const phoneAssets = assets;
  if (pagePolishEnabled()) assets = polishAssets(spec, assets);
  usedWidthRedraws = new Map();
  const desktop = composeOne(titleOneEnabled() ? withoutEqualHeadings(spec, assets) : spec, assets, false);
  const embeddedVariants = [...usedWidthRedraws.values()];
  // Off, composeOne(..., true) is never called at all: it would otherwise
  // unconditionally read asset.mobileSvg while building the phone-facing
  // page (embedVisual/embedIllustration), which loadInfographicAssets no
  // longer populates once the switch is off.
  if (!mobilePages) return { desktop, ...(embeddedVariants.length ? { embedded_variants: embeddedVariants } : {}) };
  polishSuppressed = true;
  try { return { desktop, mobile: composeOne(spec, phoneAssets, true), ...(embeddedVariants.length ? { embedded_variants: embeddedVariants } : {}) }; } finally { polishSuppressed = false; }
}

function boxesOverlap(a, b, padding = 0) {
  return a.x < b.x + b.w - padding && a.x + a.w > b.x + padding && a.y < b.y + b.h - padding && a.y + a.h > b.y + padding;
}

// NEWSROOM_PAGE_MODULE_ORDER_CHECK=1: the plan's module order (numbers 01, 02, ... in plan order) must increase in the order a
// reader meets the modules (readingOrder). The layout may move a scene's anchor ahead of its sidecars, so the two orders can
// disagree. The desktop page prints its numbers in reading order (editorialOrdinalMap), so this only reports that the plan order
// differs from the page. Returns at most one warning (no score penalty, never a blocker); [] when the switch is not exactly "1".
function moduleOrderWarnings(spec, composed) {
  if (process.env.NEWSROOM_PAGE_MODULE_ORDER_CHECK !== "1") return [];
  const decorative = new Set(composed.decorative_module_ids ?? []);
  const ordinals = new Map();
  let ordinal = 1;
  for (const module of spec.modules ?? []) {
    if (!printsOrdinal(module, (m) => decorative.has(String(m.id)))) continue;
    ordinals.set(String(module.id), ordinal++);
  }
  const reading = readingOrder((composed.boxes ?? []).filter((box) => ordinals.has(String(box.id))));
  for (let i = 1; i < reading.length; i++) {
    const before = ordinals.get(String(reading[i - 1].id)), after = ordinals.get(String(reading[i].id));
    if (after <= before) {
      return [{ severity: "warning", code: "module_ordinal_out_of_order", modules: [reading[i - 1].id, reading[i].id], ordinals: [before, after] }];
    }
  }
  return [];
}

function critiqueLegacyOne(spec, composed, mobile) {
  const issues = [];
  let score = 100;
  const boxes = composed.boxes ?? [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.x < 0 || a.y < 0 || a.x + a.w > composed.width + 0.1 || a.y + a.h > composed.height + 0.1) {
      issues.push({ severity: "blocker", code: "module_out_of_bounds", module_id: a.id }); score -= 25;
    }
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(a, boxes[j], 1)) { issues.push({ severity: "blocker", code: "module_overlap", modules: [a.id, boxes[j].id] }); score -= 30; }
    }
  }
  issues.push(...moduleOrderWarnings(spec, composed));
  const visualCount = spec.modules.filter((m) => m.type === "visual" || m.type === "illustration").length;
  const heroCount = spec.modules.filter((m) => m.type === "hero_stat").length;
  if (visualCount < 2) { issues.push({ severity: "warning", code: "too_few_visuals" }); score -= 8; }
  if (visualCount > 7) { issues.push({ severity: "warning", code: "too_many_visuals" }); score -= 8; }
  if (heroCount > 4) { issues.push({ severity: "warning", code: "too_many_hero_stats" }); score -= 6; }
  if (String(spec.title).length > (mobile ? 120 : 100)) { issues.push({ severity: "warning", code: "headline_density" }); score -= 7; }
  if (String(spec.dek).length > (mobile ? 360 : 300)) { issues.push({ severity: "warning", code: "deck_density" }); score -= 5; }
  if (!hasSourcesMethodsLabel(composed.svg, spec)) { issues.push({ severity: "blocker", code: "source_strip_missing" }); score -= 25; }
  if (!composed.svg.includes('data-role="infographic-visual"')) { issues.push({ severity: "blocker", code: "visual_embedding_missing" }); score -= 25; }
  if (composed.svg.includes('data-rich-illustration-version="0.2.0"') && !composed.svg.includes('data-role="illustration-credit"')) { issues.push({ severity: "blocker", code: "rich_illustration_disclosure_missing" }); score -= 25; }
  if (mobile && composed.width !== 720) { issues.push({ severity: "warning", code: "mobile_width_unexpected" }); score -= 3; }
  return { passed: !issues.some((i) => i.severity === "blocker") && score >= 90, score: Math.max(0, score), issues };
}

function maxDenseRun(spec, mobile = false) {
  let run = 0, maxRun = 0;
  for (const module of moduleSequence(spec, mobile)) {
    if (moduleDensity(module) >= 0.72) run += 1;
    else run = 0;
    maxRun = Math.max(maxRun, run);
  }
  return maxRun;
}

function explicitAnchorBox(spec, composed) {
  const decorative = new Set(composed.decorative_module_ids ?? []);
  const isVisual = (box) => (box.module?.type === "visual" || box.module?.type === "illustration") && !decorative.has(String(box.id));
  const priorities = new Map((spec.modules ?? []).map((m) => [m.id, Number.isInteger(m.priority) ? m.priority : 3]));
  return (composed.boxes ?? []).find((box) => isVisual(box) && box.module?.emphasis === "hero")
    ?? (composed.boxes ?? []).find((box) => isVisual(box) && priorities.get(box.id) === 1)
    ?? (composed.boxes ?? []).find(isVisual)
    ?? null;
}

function clampScore(value) { return Math.round(clamp(value, 0, 100)); }

function critiqueAwardOne(spec, composed, mobile) {
  const issues = [];
  const boxes = composed.boxes ?? [];
  let geometryPenalty = 0;
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.x < 0 || a.y < 0 || a.x + a.w > composed.width + 0.1 || a.y + a.h > composed.height + 0.1) {
      issues.push({ severity: "blocker", code: "module_out_of_bounds", module_id: a.id });
      geometryPenalty += 35;
    }
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(a, boxes[j], 1)) {
        issues.push({ severity: "blocker", code: "module_overlap", modules: [a.id, boxes[j].id] });
        geometryPenalty += 40;
      }
    }
  }
  issues.push(...moduleOrderWarnings(spec, composed));
  if (!hasSourcesMethodsLabel(composed.svg, spec)) {
    issues.push({ severity: "blocker", code: "source_strip_missing" }); geometryPenalty += 30;
  }
  if (!composed.svg.includes('data-role="infographic-visual"')) {
    issues.push({ severity: "blocker", code: "visual_embedding_missing" }); geometryPenalty += 30;
  }
  if (composed.svg.includes('data-rich-illustration-version="0.2.0"') && !composed.svg.includes('data-role="illustration-credit"')) {
    issues.push({ severity: "blocker", code: "rich_illustration_disclosure_missing" }); geometryPenalty += 30;
  }
  if (mobile && composed.width !== 720) { issues.push({ severity: "warning", code: "mobile_width_unexpected" }); geometryPenalty += 5; }

  const modules = moduleSequence(spec, mobile);
  const roles = new Set(modules.map((m) => m.story_role).filter(Boolean));
  const decorativeIds = new Set(composed.decorative_module_ids ?? []);
  const visualCount = modules.filter((m) => (m.type === "visual" || m.type === "illustration") && !decorativeIds.has(String(m.id))).length;
  const heroStats = modules.filter((m) => m.type === "hero_stat").length;
  const sectionHeaders = modules.filter((m) => m.type === "section_header").length;
  const pullQuotes = modules.filter((m) => m.type === "pull_quote").length;
  const priorityOne = modules.filter((m) => m.priority === 1);
  const explicitHero = modules.find((m) => (m.type === "visual" || m.type === "illustration") && m.emphasis === "hero" && !decorativeIds.has(String(m.id)));
  const anchor = explicitAnchorBox(spec, composed);
  const anchorY = anchor ? anchor.y / Math.max(1, composed.height) : 1;
  const anchorWidth = anchor ? anchor.w / Math.max(1, composed.width) : 0;
  const denseRun = maxDenseRun(spec, mobile);
  const visualKinds = new Set((composed.visual_kinds ?? []).filter(Boolean));
  const hasResolution = roles.has("resolution") || roles.has("explanation");
  const hasTurn = roles.has("turn");
  const hasHook = roles.has("hook");
  const hasEvidence = roles.has("evidence");
  const hasIntent = String(spec.intent ?? "").trim().length >= 16;
  const hasMessage = String(spec.primary_message ?? "").trim().length >= 16;
  const hasAudience = INFOGRAPHIC_AUDIENCES.includes(spec.audience);
  const sourcePresent = hasSourcesMethodsLabel(composed.svg, spec);
  const titleLen = String(spec.title ?? "").length;
  const dekLen = String(spec.dek ?? "").length;
  const altLen = String(spec.alt ?? "").length;

  let impact = 55;
  impact += hasIntent ? 12 : 0;
  impact += hasMessage ? 14 : 0;
  impact += hasHook ? 8 : 0;
  impact += hasResolution ? 7 : 0;
  impact += priorityOne.length ? 4 : 0;

  let engagement = 68;
  engagement += explicitHero ? 10 : 0;
  engagement += visualKinds.size >= 2 ? 7 : 0;
  engagement += pullQuotes ? 4 : 0;
  engagement += heroStats ? 4 : 0;
  engagement += hasTurn ? 4 : 0;
  engagement -= Math.max(0, denseRun - 2) * 9;
  engagement -= visualCount > 7 ? 7 : 0;

  let clarity = 100;
  if (titleLen > (mobile ? 120 : 100)) clarity -= 9;
  if (dekLen > (mobile ? 360 : 300)) clarity -= 7;
  if (!hasMessage) clarity -= 15;
  if (!hasEvidence) clarity -= 14;
  if (!hasResolution) clarity -= 7;
  if (!sourcePresent) clarity -= 25;
  if (visualCount < 2) clarity -= 8;

  let effectiveness = 100;
  if (!hasIntent) effectiveness -= 18;
  if (!hasAudience) effectiveness -= 12;
  if (visualCount < 2 || visualCount > 7) effectiveness -= 10;
  if (heroStats > 4) effectiveness -= 7;
  if (modules.length > 12) effectiveness -= 12;
  if (denseRun > 3) effectiveness -= 10;

  let hierarchy = 72;
  hierarchy += priorityOne.length ? 8 : 0;
  hierarchy += explicitHero ? 8 : 0;
  hierarchy += anchorY <= 0.45 ? 7 : anchorY <= 0.58 ? 2 : -10;
  hierarchy += anchorWidth >= 0.62 || mobile ? 5 : -5;
  if (priorityOne.length > 3) hierarchy -= 10;

  let rhythm = 100;
  rhythm -= Math.max(0, denseRun - 2) * 15;
  if (modules.length >= 8 && sectionHeaders === 0) rhythm -= 8;
  if (modules.length >= 8 && !hasTurn) rhythm -= 7;
  const repeatedText = modules.filter((m) => m.type === "text").length;
  if (repeatedText >= 4 && sectionHeaders === 0) rhythm -= 8;

  let inclusion = 100;
  if (altLen < 30) inclusion -= 25;
  if (!hasAudience) inclusion -= 10;
  if (!sourcePresent) inclusion -= 20;
  if (mobile && composed.width !== 720) inclusion -= 10;

  let responsive = 100;
  if (mobile && composed.width !== 720) responsive -= 20;
  if (!mobile && composed.width !== 1440) responsive -= 12;
  if (!composed.svg.includes('data-viewport=')) responsive -= 10;
  if (visualCount > 0 && !composed.svg.includes('data-role="infographic-visual"')) responsive -= 35;

  let craft = 100 - geometryPenalty;
  const candidate = (composed.candidate_scores ?? [])[0];
  if (!mobile && candidate && Number.isFinite(candidate.score)) {
    const normalizedLayoutPenalty = candidate.score / Math.max(1, modules.length);
    craft -= Math.min(15, normalizedLayoutPenalty * 1.2);
  }

  let originality = 70;
  originality += Math.min(18, Math.max(0, visualKinds.size - 1) * 6);
  originality += pullQuotes ? 3 : 0;
  originality += hasTurn ? 4 : 0;
  originality += spec.complexity_budget === "exploratory" ? 3 : 0;
  if (visualKinds.size <= 1 && visualCount >= 3) originality -= 7;

  const rubric = {
    impact_story_focus: clampScore(impact),
    engagement: clampScore(engagement),
    clarity_information_flow: clampScore(clarity),
    effectiveness: clampScore(effectiveness),
    hierarchy: clampScore(hierarchy),
    editorial_rhythm: clampScore(rhythm),
    inclusion_accessibility: clampScore(inclusion),
    responsive_execution: clampScore(responsive),
    craft_geometry: clampScore(craft),
    originality_variety: clampScore(originality),
  };
  const weights = {
    impact_story_focus: 0.08,
    engagement: 0.05,
    clarity_information_flow: 0.15,
    effectiveness: 0.15,
    hierarchy: 0.12,
    editorial_rhythm: 0.10,
    inclusion_accessibility: 0.10,
    responsive_execution: 0.10,
    craft_geometry: 0.10,
    originality_variety: 0.05,
  };
  const score = clampScore(Object.entries(weights).reduce((sum, [key, weight]) => sum + rubric[key] * weight, 0));

  if (anchorY > 0.58) issues.push({ severity: "warning", code: "visual_anchor_too_late", value: Number(anchorY.toFixed(3)) });
  if (!explicitHero) issues.push({ severity: "warning", code: "explicit_visual_anchor_missing" });
  if (denseRun > 3) issues.push({ severity: "warning", code: "dense_module_run", value: denseRun });
  if (!hasResolution) issues.push({ severity: "warning", code: "story_resolution_missing" });
  if (!hasTurn && modules.length >= 8) issues.push({ severity: "warning", code: "editorial_turn_missing" });
  if (priorityOne.length > 3) issues.push({ severity: "warning", code: "too_many_priority_one_modules", value: priorityOne.length });
  if (visualKinds.size <= 1 && visualCount >= 3) issues.push({ severity: "warning", code: "visual_language_repetition" });
  if (rubric.clarity_information_flow < 85) issues.push({ severity: "warning", code: "award_clarity_below_target", score: rubric.clarity_information_flow });
  if (rubric.editorial_rhythm < 85) issues.push({ severity: "warning", code: "award_rhythm_below_target", score: rubric.editorial_rhythm });
  if (rubric.hierarchy < 85) issues.push({ severity: "warning", code: "award_hierarchy_below_target", score: rubric.hierarchy });

  const bar = INFOGRAPHIC_QUALITY_THRESHOLDS[spec.quality_target === "award" ? "award" : INFOGRAPHIC_DEFAULT_QUALITY_TARGET];
  const threshold = bar.pass;
  const hardDimensionFloor = bar.dimension_floor;
  const dimensionFloorPassed = Object.values(rubric).every((value) => value >= hardDimensionFloor);
  const awardCriticalDimensions = [
    rubric.clarity_information_flow,
    rubric.effectiveness,
    rubric.hierarchy,
    rubric.editorial_rhythm,
    rubric.inclusion_accessibility,
  ];
  const awardCriticalPassed = spec.quality_target !== "award" || awardCriticalDimensions.every((value) => value >= 85);
  if (!awardCriticalPassed) issues.push({ severity: "warning", code: "award_critical_dimension_below_target" });
  const blockers = issues.some((issue) => issue.severity === "blocker");
  return { passed: !blockers && score >= threshold && dimensionFloorPassed && awardCriticalPassed, score, threshold, rubric, issues };
}

// bundle.mobile is optional: a caller with phone-facing pages off (see
// runtime/pi/newsroom.ts, which always does) passes only { desktop }, and
// this returns a desktop-only critique - viewports, score and passed all
// derive from desktop alone rather than folding in a mobile page that was
// never written. When bundle.mobile is present, this is byte-identical to
// the pre-switch behavior.
export function critiqueInfographic(spec, bundle) {
  const mobileOn = bundle.mobile !== undefined;
  if (!["1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"].includes(spec.schema_version)) {
    const desktop = critiqueLegacyOne(spec, bundle.desktop, false);
    if (!mobileOn) {
      return {
        schema_version: spec.schema_version,
        quality_target: "legacy",
        passed: desktop.passed,
        score: desktop.score,
        viewports: { desktop },
        issues: desktop.issues.map((issue) => ({ ...issue, viewport: "desktop" })),
      };
    }
    const mobile = critiqueLegacyOne(spec, bundle.mobile, true);
    return {
      schema_version: spec.schema_version,
      quality_target: "legacy",
      passed: desktop.passed && mobile.passed,
      score: Math.min(desktop.score, mobile.score),
      viewports: { desktop, mobile },
      issues: [
        ...desktop.issues.map((issue) => ({ ...issue, viewport: "desktop" })),
        ...mobile.issues.map((issue) => ({ ...issue, viewport: "mobile" })),
      ],
    };
  }
  const desktop = critiqueAwardOne(spec, bundle.desktop, false);
  if (!mobileOn) {
    return {
      schema_version: spec.schema_version,
      quality_target: spec.quality_target,
      competition_profile: spec.competition_profile ?? "editorial",
      passed: desktop.passed,
      score: desktop.score,
      rubric: desktop.rubric,
      viewports: { desktop },
      issues: desktop.issues.map((issue) => ({ ...issue, viewport: "desktop" })),
    };
  }
  const mobile = critiqueAwardOne(spec, bundle.mobile, true);
  const rubricKeys = Object.keys(desktop.rubric);
  const rubric = Object.fromEntries(rubricKeys.map((key) => [key, Math.min(desktop.rubric[key], mobile.rubric[key])]));
  return {
    schema_version: spec.schema_version,
    quality_target: spec.quality_target,
    competition_profile: spec.competition_profile ?? "editorial",
    passed: desktop.passed && mobile.passed,
    score: Math.min(desktop.score, mobile.score),
    rubric,
    viewports: { desktop, mobile },
    issues: [
      ...desktop.issues.map((issue) => ({ ...issue, viewport: "desktop" })),
      ...mobile.issues.map((issue) => ({ ...issue, viewport: "mobile" })),
    ],
  };
}

// Opt-in plan preflight (NEWSROOM_LAYOUT_IGNORED_FIELDS=exactly "1"): reports
// layout fields the renderer ignores and what to use instead. Reports only.
export function layoutIgnoredFieldsEnabled(env = process.env) { return env.NEWSROOM_LAYOUT_IGNORED_FIELDS === "1"; }

export function layoutIgnoredFieldIssues(spec) {
  const issues = [];
  const slots = desktopSceneSlots(spec ?? {});
  for (const module of spec?.modules ?? []) {
    const id = String(module?.id ?? "");
    const slot = slots.get(id);
    if (slot && module.span && module.span !== "full" && spanColumns(module.span) !== slot.cols) {
      issues.push(`module '${id}' span '${module.span}' is ignored: its scene '${slot.scene_id}' sets the width to ${slot.cols} of 12 columns (hero_with_rail takes 12, 6 or 4 by rail count and draws the rail below the anchor; use hero_sidecar_stack for side by side)`);
    }
    if (module?.tone !== undefined && module.type !== "hero_stat") issues.push(`module '${id}' tone is ignored: tone only applies to hero_stat`);
    if (module?.type === "visual" && module.heading !== undefined && String(module.heading) !== "") issues.push(`module '${id}' heading is not drawn on a visual: the chart's own title is shown; put the wording in the chart title`);
  }
  return issues;
}

// K315: report-only record of tools reaching this module's exports (key infographic.mjs::name). test_k315_export_wrap pins this list.
{
  annotateSubjectSets = trackExport("infographic.mjs::annotateSubjectSets", annotateSubjectSets);
  distinctSubjects = trackExport("infographic.mjs::distinctSubjects", distinctSubjects);
  heroRecomputeEnabled = trackExport("infographic.mjs::heroRecomputeEnabled", heroRecomputeEnabled);
  heroRecomputeRefusal = trackExport("infographic.mjs::heroRecomputeRefusal", heroRecomputeRefusal);
  lintInfographicSpec = trackExport("infographic.mjs::lintInfographicSpec", lintInfographicSpec);
}
