import { createHash } from "node:crypto";
import { isWideChar, wrapText, wrapHeadline, HOUSE_FONT_SANS, COMPACT_VIEW_W } from "./viz.mjs";
import { COMPETITION_PROFILE_IDS } from "./competition.mjs";
import { evaluateQuestionClosure } from "./story_graph.mjs";
import { COGNITIVE_GOALS, runEditorialValidators } from "./editorial_validators.mjs";
import { evaluateClaimSupport } from "./evidence_gate.mjs";
import { buildCandidates, extractNumbers, matchNumber } from "./number_shadow.mjs";

// Fix 7 (house style wiring): page chrome - header/footer rules, kickers,
// section heads, body text, pull quotes, the sources footer - now follows
// runtime/pi/viz.mjs's house palette by default, so a composed page matches
// the charts embedded in it.
//
// Fix 9 (hero_stat restyle, its own separate/droppable commit): under house
// style, hero_stat no longer draws its old solid tone-coloured card at all
// (see drawHeroStat) - the LEGACY_INK/LEGACY_MUTED/LEGACY_ACCENT/FAINT/DARK
// constants below now serve *only* hero_stat's legacy-style rendering
// (style_id/style:"legacy" or NEWSROOM_HOUSE_STYLE=legacy), which stays
// byte-for-byte on these exact old values, tone included.
//
// Fix 12 (font unification): LEGACY_SANS/LEGACY_SERIF are the same Arial/
// Georgia stacks this file always used, renamed to match the LEGACY_* colour
// constants' own naming; style_id/style:"legacy" (or
// NEWSROOM_HOUSE_STYLE=legacy) still resolves to exactly these two, byte-
// for-byte. House style instead collapses both to viz.mjs's own
// HOUSE_FONT_SANS (imported below, not re-declared here - "don't create a
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
// bindings in between. "house" is the default; style_id/style: "legacy" (or
// NEWSROOM_HOUSE_STYLE=legacy) restores today's exact chrome colours.
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

// Mirrors viz.mjs's styleFor exactly (same precedence, same env var, same
// "legacy"/"default" trigger strings) so one NEWSROOM_HOUSE_STYLE=legacy
// toggle reverts a whole page - its charts and its own chrome - together.
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
  if (process.env.NEWSROOM_HOUSE_STYLE === "legacy") return "legacy";
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
    SANS = HOUSE_FONT_SANS; SERIF = HOUSE_FONT_SANS;
  }
  INFOGRAPHIC_HOUSE_STYLE_ACTIVE = style !== "legacy";
  return style;
}

export const INFOGRAPHIC_SCHEMA_VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"];
export const INFOGRAPHIC_MODULE_TYPES = ["hero_stat", "visual", "illustration", "text", "section_header", "pull_quote"];
export const INFOGRAPHIC_SPANS = ["full", "two_thirds", "half", "third"];
export const INFOGRAPHIC_LAYOUTS = ["feature", "poster", "briefing"];
export const INFOGRAPHIC_STORY_ARCS = ["explain", "compare", "chronology", "system", "question_answer", "profile"];
export const INFOGRAPHIC_AUDIENCES = ["general", "informed", "specialist"];
export const INFOGRAPHIC_QUALITY_TARGETS = ["publishable", "award"];
export const INFOGRAPHIC_STORY_ROLES = ["hook", "context", "evidence", "turn", "explanation", "resolution", "method"];
export const INFOGRAPHIC_EMPHASIS = ["hero", "primary", "secondary", "support"];
export const INFOGRAPHIC_LAYOUT_STRATEGIES = ["balanced", "anchor", "rhythm"];
export const INFOGRAPHIC_SCENE_PATTERNS = ["hero_sidecar_stack", "hero_with_rail"];
export const INFOGRAPHIC_EXPLANATORY_DIMENSIONS = ["trend", "rank", "spatial", "mechanism", "comparison", "distribution", "uncertainty", "human_scale", "method", "context", "outcome"];
export const INFOGRAPHIC_VISUAL_GRAMMARS = ["rank", "change", "trend", "anomaly", "benchmark", "composition", "distribution", "relationship", "uncertainty", "flow", "spatial", "network", "mechanism", "sequence"];

const VISUAL_GRAMMAR_FORMS = Object.freeze({
  rank: new Set(["horizontal_bar", "dot"]),
  change: new Set(["dumbbell", "slope"]),
  trend: new Set(["line", "multi_line", "small_multiples", "streamgraph"]),
  anomaly: new Set(["diverging_bar", "dot", "small_multiples"]),
  benchmark: new Set(["dot", "dumbbell", "horizontal_bar"]),
  composition: new Set(["horizontal_bar", "heatmap", "parallel_sets", "alluvial", "waffle"]),
  distribution: new Set(["dot", "heatmap", "small_multiples"]),
  relationship: new Set(["scatter", "node_link", "chord"]),
  uncertainty: new Set(["line", "multi_line", "small_multiples"]),
  flow: new Set(["sankey", "alluvial", "parallel_sets", "geo_flow_map", "cartographic_flow_map"]),
  spatial: new Set(["geo_flow_map", "cartographic_flow_map", "choropleth"]),
  network: new Set(["node_link", "adjacency_matrix", "chord"]),
  mechanism: new Set(["process_schematic"]),
  sequence: new Set(["timeline", "trajectory_profile", "line"]),
});

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

function svgInfo(svg) {
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
function trimmedSvgInfo(svg) {
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
      const w = chars.reduce((sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.65), 0) * (num(tag, "font-size") ?? 16);
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
  if (Array.isArray(spec.modules) && spec.modules.length > 12) errors.push("modules cannot exceed 12 items in v1.0");
  const seen = new Set();
  for (const module of spec.modules ?? []) {
    if (!String(module?.id ?? "").trim()) errors.push("every module requires id");
    else if (seen.has(module.id)) errors.push(`duplicate module id '${module.id}'`);
    else seen.add(module.id);
    if (!INFOGRAPHIC_MODULE_TYPES.includes(module?.type)) errors.push(`module '${module?.id ?? "?"}' has unsupported type '${module?.type}'`);
    if (module?.source_quote !== undefined && module?.type !== "text") errors.push(`module '${module?.id ?? "?"}' source_quote is only supported on 'text' modules`);
    if (!INFOGRAPHIC_SPANS.includes(module?.span ?? "full")) errors.push(`module '${module?.id ?? "?"}' has unsupported span '${module?.span}'`);
    if (module?.story_role !== undefined && !INFOGRAPHIC_STORY_ROLES.includes(module.story_role)) errors.push(`module '${module?.id ?? "?"}' has unsupported story_role '${module.story_role}'`);
    if (module?.priority !== undefined && (!Number.isInteger(module.priority) || module.priority < 1 || module.priority > 5)) errors.push(`module '${module?.id ?? "?"}' priority must be an integer from 1 to 5`);
    if (module?.emphasis !== undefined && !INFOGRAPHIC_EMPHASIS.includes(module.emphasis)) errors.push(`module '${module?.id ?? "?"}' has unsupported emphasis '${module.emphasis}'`);
    if (module?.explanatory_dimension !== undefined && !INFOGRAPHIC_EXPLANATORY_DIMENSIONS.includes(module.explanatory_dimension)) errors.push(`module '${module?.id ?? "?"}' has unsupported explanatory_dimension '${module.explanatory_dimension}'`);
    if (module?.visual_grammar !== undefined && !INFOGRAPHIC_VISUAL_GRAMMARS.includes(module.visual_grammar)) errors.push(`module '${module?.id ?? "?"}' has unsupported visual_grammar '${module.visual_grammar}'`);
    if (module?.story_node_ids !== undefined && (!Array.isArray(module.story_node_ids) || module.story_node_ids.some((id) => !String(id ?? "").trim()))) errors.push(`module '${module?.id ?? "?"}' story_node_ids must contain non-empty story node ids`);
    if (["1.4.0", "1.5.0"].includes(spec.schema_version) && ["visual","illustration","hero_stat","text"].includes(module?.type) && (!Array.isArray(module.story_node_ids) || module.story_node_ids.length === 0)) errors.push(`module '${module?.id ?? "?"}' requires story_node_ids in InfographicSpec 1.4+`);
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
    for (const field of ["story_graph_ref", "editorial_discovery_ref", "visual_concept_ref", "selected_concept_id", "novelty_ref", "asset_plan_ref"]) if (!String(spec[field] ?? "").trim()) errors.push(`${field} is required for InfographicSpec 1.4+`);
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
            if (memberIds.has(id)) errors.push(`module '${id}' cannot belong to more than one scene`);
            memberIds.add(id);
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
      const allowed = VISUAL_GRAMMAR_FORMS[module.visual_grammar];
      if (!allowed) blockers.push(`visual '${module.id}' has unsupported module visual_grammar '${module.visual_grammar ?? ""}'`);
      else if (chartType && !allowed.has(chartType)) blockers.push(`visual '${module.id}' grammar '${module.visual_grammar}' is incompatible with chart_type '${chartType}'`);
    }
  }

  const closure = evaluateQuestionClosure(storyGraph, mappedNodeIds, resolutionNodeIds);
  if (closure.unknown_node_ids.length) blockers.push(`modules reference unknown story nodes: ${closure.unknown_node_ids.join(", ")}`);
  if (closure.covered_entry_node_ids.length !== (storyGraph.entry_node_ids ?? []).length) blockers.push("reader_question_closure_missing_entry_coverage");
  if (closure.covered_answer_node_ids.length !== (storyGraph.answer_node_ids ?? []).length) blockers.push("reader_question_closure_missing_answer_coverage");
  if (closure.resolved_answer_node_ids.length !== (storyGraph.answer_node_ids ?? []).length) blockers.push("reader_question_closure_missing_resolution_module");
  if (closure.node_coverage < 0.6) blockers.push(`story_graph_module_coverage_too_low:${closure.node_coverage}`);

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

// Hero value gate (NEWSROOM_HERO_VALUE_GATE=1, passed in by the caller as
// context.hero_value_gate). Each hero_stat is re-filled from its own claim's
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

export function lintInfographicSpec(spec, assets = {}, context = {}) {
  const blockers = validateInfographicSpec(spec);
  const warnings = [];
  const notes = [];
  const verified = new Set((context.verified_claim_ids ?? []).map(String));
  // The phone-facing mobile page is off by default (NEWSROOM_MOBILE_PAGES);
  // callers that don't pass mobile_pages keep today's both-variants behavior.
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
      const support = evaluateClaimSupport({ requested_status: "supported", claim_kind: "descriptive", claim: value });
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
      if (!mobilePages && spanColumns(module.span) < 12) blockers.push(`visual '${module.id}' must use span 'full' with mobile pages off: there is no compact chart variant, and a narrower module would shrink chart text below the 12px floor`);
      const visualSlot = sceneSlots.get(String(module.id));
      if (visualSlot && visualSlot.cols < 12 && !(visualSlot.cols === 8 && typeof asset.compactSvg === "string")) blockers.push(`visual '${module.id}' gets only ${visualSlot.cols} of 12 columns in scene '${visualSlot.scene_id}' with mobile pages off: there is no compact chart variant, so a scene may hold a visual only as the anchor of a 'hero_with_rail' scene or as that scene's only sidecar`);
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
        const allowed = VISUAL_GRAMMAR_FORMS[module.visual_grammar];
        const chartType = String(asset.manifest?.chart_type ?? "");
        if (allowed && chartType && !allowed.has(chartType)) blockers.push(`visual '${module.id}' grammar '${module.visual_grammar}' is incompatible with chart_type '${chartType}'`);
      }
    }
    if (module.type === "illustration") {
      visualCount += 1;
      const asset = assets[module.asset_ref];
      if (!asset) { blockers.push(`illustration '${module.id}' references missing asset '${module.asset_ref}'`); continue; }
      if (!asset.desktopSvg || (mobilePages && !asset.mobileSvg)) blockers.push(`illustration '${module.id}' requires desktop${mobilePages ? " and mobile" : ""} SVG variant${mobilePages ? "s" : ""}`);
      if (!mobilePages && spanColumns(module.span) < 12) blockers.push(`illustration '${module.id}' must use span 'full' with mobile pages off: there is no compact chart variant, and a narrower module would shrink chart text below the 12px floor`);
      const illustrationSlot = sceneSlots.get(String(module.id));
      if (illustrationSlot && illustrationSlot.cols < 12) blockers.push(`illustration '${module.id}' gets only ${illustrationSlot.cols} of 12 columns in scene '${illustrationSlot.scene_id}' with mobile pages off: there is no compact illustration variant, so a scene may hold an illustration only as the anchor of a 'hero_with_rail' scene or as that scene's only sidecar`);
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
      if (context.hero_value_gate === true) blockers.push(...heroValueBlockers(module, verified, context.hero_checks));
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

function visualAspect(asset, mobilePreferred, trim = false) {
  const source = mobilePreferred ? asset.mobileSvg : asset.desktopSvg;
  const info = trim ? trimmedSvgInfo(source) : svgInfo(source);
  return info.height / info.width;
}

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
    const headingLines = lines(module.heading ?? "", headingChars, 3).length;
    const deckLines = module.deck ? lines(module.deck, deckChars, 3).length : 0;
    return (mobile ? 72 : 70) + headingLines * (mobile ? 37 : 42) + deckLines * (mobile ? 22 : 23);
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
    const aspect = type === "visual" && compactFits(asset, width, mobile) ? (() => { const info = mobile ? svgInfo(asset.compactSvg) : trimmedSvgInfo(asset.compactSvg); return info.height / info.width; })() : visualAspect(asset, mobile || spanColumns(module.span) <= 6, !mobile);
    const provenanceCaption = type === "illustration" && (asset.manifest?.kind === "rich_illustration" || module.credit) ? (mobile ? 52 : 44) : 0;
    // The compact chart embeds 1:1, so its slot must hold the full top pad (see
    // embedVisual) or the chart shrinks below the 12px text floor.
    const compact = type === "visual" && compactFits(asset, width, mobile);
    const reserve = compact ? (module.emphasis === "hero" ? 30 : module.label ? 32 : 20) + 6 : module.label ? 36 : 12;
    const captionH = outOfSetCaptionHeight(asset, module, mobile);
    let maxHeight = mobile ? 980 : 900;
    if (type === "visual" && !mobile) {
      // Desktop: the 900 cap must not shrink the chart below its 12px text
      // floor. embedVisual fits the chart into (box.h - topPad - 6 - caption),
      // so give it the native height times 12 / smallest font, plus exactly
      // that padding. Charts that already fit are unchanged (max keeps 900).
      const source = compactFits(asset, width, mobile) ? asset.compactSvg : spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
      const nativeH = trimmedSvgInfo(source).height;
      const minFont = svgMinFontSize(source);
      const topPad = module.emphasis === "hero" ? 30 : module.label ? 32 : 20;
      maxHeight = Math.max(maxHeight, Math.ceil(nativeH * (minFont ? 12 / minFont : 1)) + topPad + 6 + captionH);
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
const RHYTHM_WITHIN = 28;
const RHYTHM_BETWEEN = 44;
const TEXT_BOTTOM_PAD = 6;

// Top of the ink, measured from a module box's top edge.
function inkTop(module, bar) {
  if (module.type === "hero_stat") return bar || INFOGRAPHIC_HOUSE_STYLE_ACTIVE ? 0 : 28;
  if (module.type === "section_header") return 33;
  if (module.type === "pull_quote") return 28;
  // Text, chart and illustration modules open with a hairline (too light to count as ink) and a small ordinal.
  return module.emphasis === "hero" ? 8 : 10;
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
    const headingLines = lines(module.heading ?? "", 48, 3).length;
    const deckLines = module.deck ? lines(module.deck, 86, 3).length : 0;
    return h - (deckLines ? 95 + headingLines * 42 + (deckLines - 1) * 23 + 4 : 91 + (headingLines - 1) * 42);
  }
  if (module.type === "visual") {
    const asset = assets?.[module.manifest_ref];
    if (!asset) return 0;
    const captionH = outOfSetCaptionHeight(asset, module, false);
    if (captionH) return 4;
    const source = compactFits(asset, w, false) ? asset.compactSvg : spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
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
  const width = 1440, margin = 96, contentW = width - margin * 2, gap = 28;
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
          if (statPairsWithText(module, next, nextScened, col, gap) && !forceBreakFor(next, STAT_PAIR_STAT_COLS, [...previousDensities, moduleDensity(module)])) { statColsOverride.set(String(module.id), STAT_PAIR_STAT_COLS); statColsOverride.set(String(next.id), 12 - STAT_PAIR_STAT_COLS); }
          else statBars.add(String(module.id));
        }
      }
    }
    if (module.type === "text" && INFOGRAPHIC_HOUSE_STYLE_ACTIVE && !statColsOverride.has(String(module.id))) {
      const own = effectiveColumns(module, strategy);
      const next = ordered[index + 1];
      const nextScened = next ? sceneByMember.has(String(next.id)) : false;
      const startsRow = !rowCols || forceBreakFor(module, rowCols, previousDensities) || own === 12 || rowCols + own > 12;
      if (startsRow && own === 12 && textPairsWithStat(module, next, nextScened, col, gap)
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
  if (!mobile) parts.push(`<text x="${width - margin}" y="${h.top}" text-anchor="end" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.5" fill="${MUTED}">AGENTIC DATA NEWSROOM · 01</text>`);
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

function editorialOrdinalMap(spec, assets = {}) {
  const map = new Map();
  let ordinal = 1;
  for (const module of spec.modules ?? []) {
    // hero_stat draws no ordinal chrome, so it must not consume a number either.
    if (module.type === "section_header" || module.type === "hero_stat" || module.emphasis === "hero" || isDecorativeIllustration(module, assets)) continue;
    map.set(String(module.id), ordinal++);
  }
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
  parts.push(`<text x="${box.x}" y="${y + 20}" font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="1.5" fill="${ACCENT}">${showLabel ? esc(fitChromeText(`${number} · `, box.module, box.w, size, 1.5)) : number}</text>`);
}

function outOfSetCaptionHeight(asset, module, mobile) {
  return asset?.out_of_set_subjects?.length && String(module.subject_caption ?? "").trim()
    ? lines(module.subject_caption, mobile ? 54 : 110, 3).length * (mobile ? 16 : 17) + 12
    : 0;
}

function embedVisual(parts, asset, box, module, mobile) {
  const sourceSvg = compactFits(asset, box.w, mobile) ? asset.compactSvg : mobile || spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
  const info = mobile ? svgInfo(sourceSvg) : trimmedSvgInfo(sourceSvg);
  const topPad = module.emphasis === "hero" ? 30 : (module.label ? 32 : 20);
  const captionH = outOfSetCaptionHeight(asset, module, mobile);
  const availableH = box.h - topPad - 6 - captionH;
  const targetW = box.w;
  const naturalH = targetW * (info.height / info.width);
  const targetH = Math.min(availableH, naturalH);
  const y = box.y + topPad;
  const inner = namespaceSvgInner(info.inner, `embed-${hash(module.id).slice(0, 8)}-${mobile ? "m" : "d"}`);
  parts.push(`<svg data-role="infographic-visual" data-module-id="${esc(module.id)}" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" viewBox="${info.minX} ${info.minY} ${info.width} ${info.height}" preserveAspectRatio="${mobile ? "xMidYMin" : "xMinYMin"} meet">${inner}</svg>`);
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
function statNumeralWidth(module) {
  const glyphs = (text, size) => Array.from(String(text ?? "")).reduce((sum, ch) => sum + size * (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : ch === "." || ch === "," ? 0.3 : 0.56), 0);
  return Math.ceil(glyphs(module.value, 58) + (module.unit ? 7 + glyphs(module.unit, 24) : 0));
}

// Full-width stat bar (desktop): numeral on the left, label and detail to its
// right; the row height follows the wrapped text.
function heroStatBarMetrics(module, width) {
  const pad = STAT_BAR_PAD;
  const textX = pad + Math.max(STAT_BAR_MIN_NUMERAL_ZONE, statNumeralWidth(module) + STAT_BAR_GUTTER);
  const avail = Math.max(240, width - textX - pad);
  const labelLines = lines(module.label ?? "", Math.max(20, Math.floor(avail / 10.5)));
  const detailLines = module.detail ? lines(module.detail, Math.max(24, Math.floor(avail / 8.2))) : [];
  const textH = 22 + (labelLines.length - 1) * 20 + (detailLines.length ? 10 + detailLines.length * 16 : 0);
  return { pad, textX, labelLines, detailLines, h: Math.max(59, detailLines.length ? 36 + (labelLines.length - 1) * 20 + 16 * detailLines.length : 31 + (labelLines.length - 1) * 20) + TEXT_BOTTOM_PAD };
}

function drawHeroStatBar(parts, box, module) {
  const m = heroStatBarMetrics(module, box.w);
  // The row gap above (40px) or the rail gap (14px) already separates the band
  // from the module above, so its rule sits on the box edge.
  const top = box.y;
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${top}" width="${box.w}" height="3" fill="${ACCENT}"/>`);
  parts.push(`<text x="${box.x + m.pad}" y="${top + 58}" font-family="${SERIF}" font-size="58" font-weight="700" fill="${ACCENT}">${esc(module.value)}${module.unit ? `<tspan font-size="24" dx="7" fill="${INK}">${esc(module.unit)}</tspan>` : ""}</text>`);
  const x = box.x + m.textX;
  const labelY = top + 3 + 6 + 18;
  m.labelLines.forEach((line, i) => parts.push(`<text x="${x}" y="${labelY + i * 20}" font-family="${SANS}" font-size="15.5" font-weight="700" fill="${INK}">${esc(line)}</text>`));
  const detailY = labelY + (m.labelLines.length - 1) * 20 + 10 + 12;
  m.detailLines.forEach((line, i) => parts.push(`<text x="${x}" y="${detailY + i * 16}" font-family="${SANS}" font-size="12" fill="${MUTED}">${esc(line)}</text>`));
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${box.y + box.h - 1}" width="1" height="1" fill="none"/>`);
}

function drawHeroStat(parts, box, module, mobile) {
  if (box.stat_bar && !mobile && INFOGRAPHIC_HOUSE_STYLE_ACTIVE) return drawHeroStatBar(parts, box, module);
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
    parts.push(`<text x="${box.x + pad}" y="${top + (mobile ? 69 : 66)}" font-family="${SERIF}" font-size="${mobile ? 54 : 58}" font-weight="700" fill="${fg}">${esc(module.value)}${module.unit ? `<tspan font-size="${mobile ? 22 : 24}" dx="7">${esc(module.unit)}</tspan>` : ""}</text>`);
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
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${top}" width="${box.w}" height="3" fill="${ACCENT}"/>`);
  parts.push(`<text x="${box.x + pad}" y="${top + (mobile ? 69 : 66)}" font-family="${SERIF}" font-size="${mobile ? 54 : 58}" font-weight="700" fill="${ACCENT}">${esc(module.value)}${module.unit ? `<tspan font-size="${mobile ? 22 : 24}" dx="7" fill="${INK}">${esc(module.unit)}</tspan>` : ""}</text>`);
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
  const headingLines = lines(module.heading ?? "", headingChars, 3, true).length;
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

function sourceList(spec, assets) {
  const notes = uniq([
    spec.source_note,
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

function composeOne(spec, assets, mobile) {
  applyInfographicStyle(spec);
  const header = headerMetrics(spec, mobile);
  const layout = mobile ? layoutMobile(spec, assets) : layoutDesktop(spec, assets);
  const footerH = mobile ? 150 : 128;
  const startY = header.height;
  const pageHeight = startY + layout.contentHeight + footerH + (mobile ? 34 : 42);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${pageHeight}" role="img" aria-labelledby="info-title info-desc" data-infographic-version="${esc(spec.schema_version)}" data-viewport="${mobile ? "mobile" : "desktop"}" data-layout-strategy="${esc(layout.strategy ?? (mobile ? "single_column" : "balanced"))}">`];
  parts.push(`<title id="info-title">${esc(spec.title)}</title>`);
  parts.push(`<desc id="info-desc">${esc(spec.alt)}</desc>`);
  parts.push(`<rect width="${layout.width}" height="${pageHeight}" fill="${PAPER}"/>`);
  drawHeader(parts, spec, layout.width, layout.margin, mobile);
  const shiftedBoxes = layout.boxes.map((box) => ({ ...box, y: box.y + startY }));
  for (const scene of layout.scenes ?? []) drawSceneChrome(parts, scene, startY, mobile);
  const ordinals = editorialOrdinalMap(spec, assets);
  shiftedBoxes.forEach((box) => {
    const module = box.module;
    if (module.type !== "section_header" && !isDecorativeIllustration(module, assets)) drawModuleChrome(parts, box, ordinals.get(String(module.id)), mobile, spec);
    if (module.type === "hero_stat") drawHeroStat(parts, box, module, mobile);
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
  textBlock(parts, sources.join(" · "), layout.margin, footerY + 57, { size: mobile ? 12 : 12.5, lineHeight: mobile ? 16 : 17, fill: MUTED, maxChars: mobile ? 92 : 172, maxLines: mobile ? 5 : 4 });
  parts.push(`<text x="${layout.width - layout.margin}" y="${pageHeight - 26}" text-anchor="end" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.2" fill="${MUTED}">AGENTIC DATA NEWSROOM · VERIFIED VISUAL STORY</text>`);
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

export function composeInfographicBundle(spec, assets = {}, { mobilePages = true } = {}) {
  const errors = validateInfographicSpec(spec);
  if (errors.length) throw new Error(errors.join("; "));
  const desktop = composeOne(spec, assets, false);
  // Off, composeOne(..., true) is never called at all: it would otherwise
  // unconditionally read asset.mobileSvg while building the phone-facing
  // page (embedVisual/embedIllustration), which loadInfographicAssets no
  // longer populates once the switch is off.
  return mobilePages ? { desktop, mobile: composeOne(spec, assets, true) } : { desktop };
}

function boxesOverlap(a, b, padding = 0) {
  return a.x < b.x + b.w - padding && a.x + a.w > b.x + padding && a.y < b.y + b.h - padding && a.y + a.h > b.y + padding;
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

  const threshold = spec.quality_target === "award" ? 92 : 88;
  const hardDimensionFloor = spec.quality_target === "award" ? 78 : 72;
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
// runtime/pi/newsroom.ts mobilePagesEnabled()) passes only { desktop }, and
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
