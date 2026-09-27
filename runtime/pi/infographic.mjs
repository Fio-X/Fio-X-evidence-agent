import { createHash } from "node:crypto";
import { wrapText } from "./viz.mjs";
import { COMPETITION_PROFILE_IDS } from "./competition.mjs";
import { evaluateQuestionClosure } from "./story_graph.mjs";

const INK = "#1d2329";
const MUTED = "#69727a";
const GRID = "#d9dde1";
const FAINT = "#f4f2ee";
const ACCENT = "#c9473d";
const DARK = "#24313a";
const PAPER = "#fffdf9";
const SANS = "Arial, Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

export const INFOGRAPHIC_SCHEMA_VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"];
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
  composition: new Set(["horizontal_bar", "heatmap", "parallel_sets", "alluvial"]),
  distribution: new Set(["dot", "heatmap", "small_multiples"]),
  relationship: new Set(["scatter", "node_link", "chord"]),
  uncertainty: new Set(["line", "multi_line", "small_multiples"]),
  flow: new Set(["sankey", "alluvial", "parallel_sets", "geo_flow_map", "cartographic_flow_map"]),
  spatial: new Set(["geo_flow_map", "cartographic_flow_map"]),
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

function svgInfo(svg) {
  const match = String(svg ?? "").match(/<svg\b[^>]*viewBox=["']([^"']+)["'][^>]*>([\s\S]*)<\/svg>\s*$/i);
  if (!match) throw new Error("Embedded visualization is not a valid viewBox SVG");
  const nums = match[1].trim().split(/\s+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error("Embedded visualization has an invalid viewBox");
  return { minX: nums[0], minY: nums[1], width: nums[2], height: nums[3], inner: match[2] };
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

function lines(text, maxChars, maxLines = 99) {
  const out = wrapText(String(text ?? ""), maxChars).slice(0, maxLines);
  if (out.length === maxLines && wrapText(String(text ?? ""), maxChars).length > maxLines) {
    out[maxLines - 1] = out[maxLines - 1].replace(/…?$/, "…");
  }
  return out;
}

function textBlock(parts, text, x, y, opts = {}) {
  const size = opts.size ?? 16;
  const lineHeight = opts.lineHeight ?? Math.round(size * 1.35);
  const rows = lines(text, opts.maxChars ?? 70, opts.maxLines ?? 99);
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
  if (["1.1.0", "1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version)) {
    if (!String(spec.intent ?? "").trim()) errors.push("intent is required in InfographicSpec 1.1+");
    if (!String(spec.primary_message ?? "").trim()) errors.push("primary_message is required in InfographicSpec 1.1+");
    if (!INFOGRAPHIC_STORY_ARCS.includes(spec.story_arc)) errors.push(`story_arc must be one of ${INFOGRAPHIC_STORY_ARCS.join(", ")}`);
    if (!INFOGRAPHIC_AUDIENCES.includes(spec.audience)) errors.push(`audience must be one of ${INFOGRAPHIC_AUDIENCES.join(", ")}`);
    if (!INFOGRAPHIC_QUALITY_TARGETS.includes(spec.quality_target)) errors.push(`quality_target must be one of ${INFOGRAPHIC_QUALITY_TARGETS.join(", ")}`);
    if (["1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version) && !COMPETITION_PROFILE_IDS.includes(spec.competition_profile ?? "editorial")) errors.push(`competition_profile must be one of ${COMPETITION_PROFILE_IDS.join(", ")}`);
  }
  if (!Array.isArray(spec.modules) || spec.modules.length < 3) errors.push("modules must contain at least 3 items");
  if (Array.isArray(spec.modules) && spec.modules.length > 12) errors.push("modules cannot exceed 12 items in v1.0");
  const seen = new Set();
  for (const module of spec.modules ?? []) {
    if (!String(module?.id ?? "").trim()) errors.push("every module requires id");
    else if (seen.has(module.id)) errors.push(`duplicate module id '${module.id}'`);
    else seen.add(module.id);
    if (!INFOGRAPHIC_MODULE_TYPES.includes(module?.type)) errors.push(`module '${module?.id ?? "?"}' has unsupported type '${module?.type}'`);
    if (!INFOGRAPHIC_SPANS.includes(module?.span ?? "full")) errors.push(`module '${module?.id ?? "?"}' has unsupported span '${module?.span}'`);
    if (module?.story_role !== undefined && !INFOGRAPHIC_STORY_ROLES.includes(module.story_role)) errors.push(`module '${module?.id ?? "?"}' has unsupported story_role '${module.story_role}'`);
    if (module?.priority !== undefined && (!Number.isInteger(module.priority) || module.priority < 1 || module.priority > 5)) errors.push(`module '${module?.id ?? "?"}' priority must be an integer from 1 to 5`);
    if (module?.emphasis !== undefined && !INFOGRAPHIC_EMPHASIS.includes(module.emphasis)) errors.push(`module '${module?.id ?? "?"}' has unsupported emphasis '${module.emphasis}'`);
    if (module?.explanatory_dimension !== undefined && !INFOGRAPHIC_EXPLANATORY_DIMENSIONS.includes(module.explanatory_dimension)) errors.push(`module '${module?.id ?? "?"}' has unsupported explanatory_dimension '${module.explanatory_dimension}'`);
    if (module?.visual_grammar !== undefined && !INFOGRAPHIC_VISUAL_GRAMMARS.includes(module.visual_grammar)) errors.push(`module '${module?.id ?? "?"}' has unsupported visual_grammar '${module.visual_grammar}'`);
    if (module?.story_node_ids !== undefined && (!Array.isArray(module.story_node_ids) || module.story_node_ids.some((id) => !String(id ?? "").trim()))) errors.push(`module '${module?.id ?? "?"}' story_node_ids must contain non-empty story node ids`);
    if (spec.schema_version === "1.4.0" && ["visual","illustration","hero_stat","text"].includes(module?.type) && (!Array.isArray(module.story_node_ids) || module.story_node_ids.length === 0)) errors.push(`module '${module?.id ?? "?"}' requires story_node_ids in InfographicSpec 1.4`);
    if (spec.schema_version === "1.4.0" && module?.type === "visual" && !INFOGRAPHIC_VISUAL_GRAMMARS.includes(module?.visual_grammar)) errors.push(`visual module '${module?.id ?? "?"}' requires visual_grammar in InfographicSpec 1.4`);
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
      if (!String(module.body ?? "").trim()) errors.push(`text module '${module.id}' requires body`);
      if (!Array.isArray(module.claim_ids) || module.claim_ids.length === 0) errors.push(`text module '${module.id}' requires claim_ids`);
    }
    if (module?.type === "pull_quote" && !String(module.text ?? "").trim()) errors.push(`pull_quote '${module.id}' requires text`);
    if (module?.type === "section_header" && !String(module.heading ?? "").trim()) errors.push(`section_header '${module.id}' requires heading`);
  }
  if (["1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version) && spec.mobile_module_order !== undefined) {
    if (!Array.isArray(spec.mobile_module_order)) errors.push("mobile_module_order must be an array");
    else {
      const ids = (spec.modules ?? []).map((module) => String(module.id));
      const order = spec.mobile_module_order.map(String);
      if (order.length !== ids.length || new Set(order).size !== ids.length || ids.some((id) => !order.includes(id))) errors.push("mobile_module_order must contain every module id exactly once");
    }
  }

  if (spec.schema_version === "1.4.0") {
    if (!String(spec.reader_question ?? "").trim()) errors.push("reader_question is required for InfographicSpec 1.4");
    if (!String(spec.visual_thesis ?? "").trim()) errors.push("visual_thesis is required for InfographicSpec 1.4");
    for (const field of ["story_graph_ref", "editorial_discovery_ref", "visual_concept_ref", "selected_concept_id", "novelty_ref", "asset_plan_ref"]) if (!String(spec[field] ?? "").trim()) errors.push(`${field} is required for InfographicSpec 1.4`);
    if (!spec.scene_graph) errors.push("scene_graph is required for InfographicSpec 1.4");
  }

  if (["1.3.0", "1.4.0"].includes(spec.schema_version)) {
    if (spec.schema_version === "1.3.0" && spec.quality_target === "award") {
      for (const field of ["editorial_discovery_ref", "visual_concept_ref", "selected_concept_id", "novelty_ref", "asset_plan_ref"]) if (!String(spec[field] ?? "").trim()) errors.push(`${field} is required for InfographicSpec 1.3 award mode`);
      if (!spec.scene_graph) errors.push("scene_graph is required for InfographicSpec 1.3 award mode");
    }
    if (spec.scene_graph !== undefined) {
      const graph = spec.scene_graph;
      if (!graph || typeof graph !== "object" || graph.schema_version !== "0.1.0" || !Array.isArray(graph.scenes) || graph.scenes.length < 1 || graph.scenes.length > 3) errors.push("scene_graph must use schema_version 0.1.0 with 1..3 scenes");
      else {
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

export function evaluateInfographicSynthesis(spec, assets = {}, storyGraph = null) {
  const blockers = [];
  const warnings = [];
  const notes = [];
  if (spec?.schema_version !== "1.4.0") return { passed: true, blockers, warnings, notes, metrics: { enforced: false } };
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
  const contentModules = (spec.modules ?? []).filter((module) => ["visual", "illustration", "hero_stat", "text"].includes(module.type));
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

export function lintInfographicSpec(spec, assets = {}, context = {}) {
  const blockers = validateInfographicSpec(spec);
  const warnings = [];
  const notes = [];
  const verified = new Set((context.verified_claim_ids ?? []).map(String));
  let visualCount = 0;
  let claimCount = 0;
  const sourceNotes = [];
  for (const module of spec.modules ?? []) {
    if (module.type === "visual") {
      visualCount += 1;
      const asset = assets[module.manifest_ref];
      if (!asset) { blockers.push(`visual '${module.id}' references missing asset '${module.manifest_ref}'`); continue; }
      if (!asset.desktopSvg || !asset.mobileSvg) blockers.push(`visual '${module.id}' requires desktop and mobile SVG variants`);
      if (!asset.manifest) blockers.push(`visual '${module.id}' is missing visualization manifest metadata`);
      if (asset.critic && asset.critic.passed === false) blockers.push(`visual '${module.id}' upstream critic did not pass`);
      if (!asset.critic) warnings.push(`visual '${module.id}' has no upstream critic metadata`);
      if (asset.manifest?.claim_id && verified.size && !verified.has(String(asset.manifest.claim_id))) blockers.push(`visual '${module.id}' references unverified claim '${asset.manifest.claim_id}'`);
      if (asset.manifest?.source_note) sourceNotes.push(asset.manifest.source_note);
      if (spec.schema_version === "1.4.0" && module.visual_grammar) {
        const allowed = VISUAL_GRAMMAR_FORMS[module.visual_grammar];
        const chartType = String(asset.manifest?.chart_type ?? "");
        if (allowed && chartType && !allowed.has(chartType)) blockers.push(`visual '${module.id}' grammar '${module.visual_grammar}' is incompatible with chart_type '${chartType}'`);
      }
    }
    if (module.type === "illustration") {
      visualCount += 1;
      const asset = assets[module.asset_ref];
      if (!asset) { blockers.push(`illustration '${module.id}' references missing asset '${module.asset_ref}'`); continue; }
      if (!asset.desktopSvg || !asset.mobileSvg) blockers.push(`illustration '${module.id}' requires desktop and mobile SVG variants`);
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
        if (verified.size && !verified.has(String(claimId))) blockers.push(`illustration '${module.id}' references unverified claim '${claimId}'`);
      }
      if (asset.manifest?.source_note) sourceNotes.push(asset.manifest.source_note);
    }
    if (module.type === "hero_stat") {
      claimCount += 1;
      if (verified.size && !verified.has(String(module.claim_id))) blockers.push(`hero_stat '${module.id}' references unverified claim '${module.claim_id}'`);
      if (String(module.label ?? "").length > 120) warnings.push(`hero_stat '${module.id}' label is long for magazine display`);
    }
    if (module.type === "text") {
      for (const claimId of module.claim_ids ?? []) {
        claimCount += 1;
        if (verified.size && !verified.has(String(claimId))) blockers.push(`text module '${module.id}' references unverified claim '${claimId}'`);
      }
      if (String(module.body ?? "").length > 900) warnings.push(`text module '${module.id}' exceeds the preferred 900-character magazine budget`);
    }
    if (module.type === "pull_quote") {
      if (String(module.text ?? "").length > 280) warnings.push(`pull_quote '${module.id}' is too long for a pull quote`);
      for (const claimId of module.claim_ids ?? []) {
        claimCount += 1;
        if (verified.size && !verified.has(String(claimId))) blockers.push(`pull_quote '${module.id}' references unverified claim '${claimId}'`);
      }
    }
  }
  if (visualCount < 2) warnings.push("Magazine feature has fewer than two verified visual modules");
  if (visualCount > 7) warnings.push("More than seven visual modules may overload a single feature page");
  if ((spec.modules ?? []).filter((m) => m.type === "hero_stat").length > 4) warnings.push("More than four hero statistics weakens hierarchy");
  if (String(spec.title ?? "").length > 90) warnings.push("Headline is long; consider a tighter display headline");
  if (String(spec.dek ?? "").length > 260) warnings.push("Deck is long; consider moving context into a text module");
  if (["1.1.0", "1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version)) {
    const roles = new Set((spec.modules ?? []).map((m) => m.story_role).filter(Boolean));
    const priorityOne = (spec.modules ?? []).filter((m) => m.priority === 1);
    const heroVisuals = (spec.modules ?? []).filter((m) => (m.type === "visual" || m.type === "illustration") && m.emphasis === "hero");
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
  if (["1.1.0", "1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version)) {
    notes.push(`story_arc=${spec.story_arc}`);
    notes.push(`audience=${spec.audience}`);
    notes.push(`quality_target=${spec.quality_target}`);
    if (["1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version)) notes.push(`competition_profile=${spec.competition_profile ?? "editorial"}`);
  }
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
    synthesis,
    content_hash: hash(spec),
  };
}

function spanColumns(span) { return ({ full: 12, two_thirds: 8, half: 6, third: 4 })[span ?? "full"] ?? 12; }

function visualAspect(asset, mobilePreferred) {
  const info = svgInfo(mobilePreferred ? asset.mobileSvg : asset.desktopSvg);
  return info.height / info.width;
}

function moduleHeight(module, width, assets, mobile = false) {
  const type = module.type;
  if (type === "hero_stat") {
    const labelChars = mobile ? 46 : Math.max(28, Math.round(width / 10));
    const labelLines = lines(module.label ?? "", labelChars, 3).length;
    const detailLines = module.detail ? lines(module.detail, mobile ? 62 : Math.max(38, Math.round(width / 8)), 2).length : 0;
    return (mobile ? 166 : 154) + Math.max(0, labelLines - 1) * (mobile ? 20 : 20) + detailLines * 10;
  }
  if (type === "section_header") {
    const headingChars = mobile ? 31 : 48;
    const deckChars = mobile ? 55 : 86;
    const headingLines = lines(module.heading ?? "", headingChars, 3).length;
    const deckLines = module.deck ? lines(module.deck, deckChars, 3).length : 0;
    return (mobile ? 72 : 70) + headingLines * (mobile ? 37 : 42) + deckLines * (mobile ? 22 : 23);
  }
  if (type === "pull_quote") {
    const chars = mobile ? 34 : Math.max(34, Math.round(width / 15));
    return (mobile ? 92 : 78) + lines(module.text, chars, 7).length * (mobile ? 34 : 30);
  }
  if (type === "text") {
    const chars = mobile ? 54 : Math.max(44, Math.round(width / 10));
    const heading = module.heading ? lines(module.heading, chars, 3).length * (mobile ? 28 : 26) : 0;
    return 72 + heading + lines(module.body, chars, 12).length * (mobile ? 24 : 22);
  }
  if (type === "visual" || type === "illustration") {
    const asset = assets[type === "visual" ? module.manifest_ref : module.asset_ref];
    if (!asset) return mobile ? 500 : 520;
    const aspect = visualAspect(asset, mobile || spanColumns(module.span) <= 6);
    const provenanceCaption = type === "illustration" && (asset.manifest?.kind === "rich_illustration" || module.credit) ? (mobile ? 44 : 38) : 0;
    return clamp(width * aspect + (module.label ? 36 : 12) + provenanceCaption, mobile ? 390 : 330, mobile ? 980 : 900);
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

function normalizedScenes(spec) {
  if (!["1.3.0", "1.4.0"].includes(spec.schema_version) || !spec.scene_graph?.scenes) return [];
  return spec.scene_graph.scenes.map((scene) => ({ ...scene, sidecar_module_ids: (scene.sidecar_module_ids ?? []).map(String), anchor_module_id: String(scene.anchor_module_id) }));
}

function sceneHeaderHeight(scene) {
  const titleLines = scene.title ? lines(scene.title, 48, 2).length : 0;
  const dekLines = scene.dek ? lines(scene.dek, 82, 2).length : 0;
  return (scene.eyebrow || scene.title || scene.dek) ? 28 + titleLines * 38 + dekLines * 22 + 20 : 0;
}

function buildDesktopScene(scene, spec, assets, y, rowIndex, margin, contentW, gap, col) {
  const byId = new Map((spec.modules ?? []).map((module) => [String(module.id), module]));
  const anchor = byId.get(scene.anchor_module_id);
  const sidecars = scene.sidecar_module_ids.map((id) => byId.get(id)).filter(Boolean);
  const headerH = sceneHeaderHeight(scene);
  const sceneY = y;
  const contentY = y + headerH;
  const boxes = [];
  if (scene.pattern === "hero_with_rail") {
    const anchorW = contentW;
    const anchorH = moduleHeight(anchor, anchorW, assets, false);
    boxes.push({ id: anchor.id, module: anchor, x: margin, y: contentY, w: anchorW, h: anchorH, cols: 12, density: moduleDensity(anchor), row_index: rowIndex, scene_id: scene.id, scene_role: "anchor" });
    const railY = contentY + anchorH + gap;
    const sideCols = sidecars.length === 1 ? 12 : sidecars.length === 2 ? 6 : 4;
    let xCols = 0;
    let railH = 0;
    sidecars.forEach((module) => {
      const w = sideCols * col + Math.max(0, sideCols - 1) * gap;
      const h = moduleHeight(module, w, assets, false);
      boxes.push({ id: module.id, module, x: margin + xCols * (col + gap), y: railY, w, h, cols: sideCols, density: moduleDensity(module), row_index: rowIndex, scene_id: scene.id, scene_role: "sidecar" });
      xCols += sideCols;
      railH = Math.max(railH, h);
    });
    return { boxes, meta: { ...scene, x: margin, y: sceneY, w: contentW, h: headerH + anchorH + gap + railH, header_h: headerH }, height: headerH + anchorH + gap + railH };
  }
  const anchorCols = 8;
  const sideCols = 4;
  const anchorW = anchorCols * col + (anchorCols - 1) * gap;
  const sideW = sideCols * col + (sideCols - 1) * gap;
  const anchorH = moduleHeight(anchor, anchorW, assets, false);
  boxes.push({ id: anchor.id, module: anchor, x: margin, y: contentY, w: anchorW, h: anchorH, cols: anchorCols, density: moduleDensity(anchor), row_index: rowIndex, scene_id: scene.id, scene_role: "anchor" });
  let sideY = contentY;
  for (const module of sidecars) {
    const h = moduleHeight(module, sideW, assets, false);
    boxes.push({ id: module.id, module, x: margin + anchorCols * (col + gap), y: sideY, w: sideW, h, cols: sideCols, density: moduleDensity(module), row_index: rowIndex, scene_id: scene.id, scene_role: "sidecar" });
    sideY += h + gap;
  }
  const sideH = Math.max(0, sideY - contentY - gap);
  const contentH = Math.max(anchorH, sideH);
  return { boxes, meta: { ...scene, x: margin, y: sceneY, w: contentW, h: headerH + contentH, header_h: headerH }, height: headerH + contentH };
}

function layoutDesktopWithStrategy(spec, assets, strategy) {
  const width = 1440, margin = 96, contentW = width - margin * 2, gap = 28;
  const col = (contentW - gap * 11) / 12;
  const boxes = [];
  const scenes = [];
  let y = 0, rowCols = 0, row = [], rowIndex = 0;
  const flush = () => {
    if (!row.length) return;
    const rowH = Math.max(...row.map((item) => item.h));
    const rowHasHero = row.some((item) => item.module.emphasis === "hero");
    const rowHasTurn = row.some((item) => item.module.story_role === "turn");
    for (const item of row) boxes.push({ ...item, y, h: rowH, row_index: rowIndex });
    y += rowH + 40 + (rowHasHero ? 18 : 0) + (rowHasTurn ? 12 : 0);
    rowCols = 0; row = []; rowIndex += 1;
  };
  const configuredScenes = normalizedScenes(spec);
  const sceneByMember = new Map();
  for (const scene of configuredScenes) for (const id of [scene.anchor_module_id, ...scene.sidecar_module_ids]) sceneByMember.set(String(id), scene);
  const placedScenes = new Set();
  let previousDensities = [];
  for (const module of spec.modules) {
    const scene = sceneByMember.get(String(module.id));
    if (scene) {
      if (!placedScenes.has(scene.id)) {
        flush();
        const built = buildDesktopScene(scene, spec, assets, y, rowIndex, margin, contentW, gap, col);
        boxes.push(...built.boxes);
        scenes.push(built.meta);
        y += built.height + 58;
        rowIndex += 1;
        placedScenes.add(scene.id);
      }
      continue;
    }
    const cols = effectiveColumns(module, strategy);
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
    const w = cols * col + Math.max(0, cols - 1) * gap;
    const h = moduleHeight(module, w, assets, false);
    row.push({ id: module.id, module, x, w, h, cols, density });
    rowCols += cols;
    previousDensities.push(density);
    if (cols === 12 || rowCols === 12) flush();
  }
  flush();
  return { width, margin, contentW, boxes, scenes, contentHeight: Math.max(0, y - 40), strategy };
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
  if (!["1.1.0", "1.2.0", "1.3.0"].includes(spec.schema_version)) return layoutDesktopWithStrategy(spec, assets, "balanced");
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
  if (!mobile || !["1.2.0", "1.3.0"].includes(spec.schema_version) || !Array.isArray(spec.mobile_module_order)) return spec.modules ?? [];
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
  const titleLines = lines(spec.title, titleChars, mobile ? 6 : 4).length;
  const dekLines = lines(spec.dek, dekChars, mobile ? 8 : 5).length;
  const top = mobile ? 48 : 58;
  const titleSize = mobile ? 45 : 68;
  const titleLH = mobile ? 50 : 72;
  const dekSize = mobile ? 19 : 22;
  const dekLH = mobile ? 27 : 31;
  const kicker = mobile ? 44 : 52;
  const meta = spec.byline || spec.date_label ? (mobile ? 42 : 38) : 10;
  return { top, kicker, titleSize, titleLH, titleLines, dekSize, dekLH, dekLines, meta, height: top + kicker + titleLines * titleLH + dekLines * dekLH + meta + (mobile ? 44 : 52) };
}

function drawHeader(parts, spec, width, margin, mobile) {
  const h = headerMetrics(spec, mobile);
  parts.push(`<line x1="${margin}" y1="${h.top - 18}" x2="${width - margin}" y2="${h.top - 18}" stroke="${INK}" stroke-width="${mobile ? 5 : 6}"/>`);
  parts.push(`<text x="${margin}" y="${h.top}" font-family="${SANS}" font-size="${mobile ? 13 : 14}" font-weight="700" letter-spacing="2" fill="${ACCENT}">${esc(String(spec.kicker ?? "DATA FEATURE").toUpperCase())}</text>`);
  if (!mobile) parts.push(`<text x="${width - margin}" y="${h.top}" text-anchor="end" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="1.5" fill="${MUTED}">AGENTIC DATA NEWSROOM · 01</text>`);
  let y = h.top + (mobile ? 44 : 52);
  textBlock(parts, spec.title, margin, y, { family: SERIF, size: h.titleSize, lineHeight: h.titleLH, weight: 700, maxChars: mobile ? 19 : 31, maxLines: mobile ? 6 : 4 });
  y += h.titleLines * h.titleLH + (mobile ? 18 : 22);
  textBlock(parts, spec.dek, margin, y, { size: h.dekSize, lineHeight: h.dekLH, fill: MUTED, maxChars: mobile ? 42 : 78, maxLines: mobile ? 8 : 5 });
  y += h.dekLines * h.dekLH + (mobile ? 18 : 20);
  const meta = [spec.byline ? `By ${spec.byline}` : null, spec.date_label].filter(Boolean).join("  ·  ");
  if (meta) parts.push(`<text x="${margin}" y="${y}" font-family="${SANS}" font-size="${mobile ? 13 : 14}" font-weight="600" fill="${INK}">${esc(meta)}</text>`);
  parts.push(`<line x1="${margin}" y1="${h.height - 18}" x2="${width - margin}" y2="${h.height - 18}" stroke="${GRID}" stroke-width="1"/>`);
  return h.height;
}

function editorialOrdinalMap(spec) {
  const map = new Map();
  let ordinal = 1;
  for (const module of spec.modules ?? []) {
    if (module.type === "section_header" || module.emphasis === "hero") continue;
    map.set(String(module.id), ordinal++);
  }
  return map;
}

function drawSceneChrome(parts, scene, startY, mobile) {
  if (mobile) return;
  const y = scene.y + startY;
  if (scene.eyebrow) parts.push(`<text x="${scene.x}" y="${y + 16}" font-family="${SANS}" font-size="11" font-weight="700" letter-spacing="1.8" fill="${ACCENT}">${esc(String(scene.eyebrow).toUpperCase())}</text>`);
  if (scene.title) textBlock(parts, scene.title, scene.x, y + (scene.eyebrow ? 52 : 30), { family: SERIF, size: 34, lineHeight: 39, weight: 700, maxChars: 48, maxLines: 2 });
  const titleLines = scene.title ? lines(scene.title, 48, 2).length : 0;
  if (scene.dek) textBlock(parts, scene.dek, scene.x, y + (scene.eyebrow ? 52 : 30) + titleLines * 39 + 7, { size: 15.5, lineHeight: 22, fill: MUTED, maxChars: 82, maxLines: 2 });
  parts.push(`<rect data-role="scene-boundary" data-scene-id="${esc(scene.id)}" x="${scene.x}" y="${y}" width="${scene.w}" height="${scene.h}" fill="none" stroke="none"/>`);
}

function drawModuleChrome(parts, box, ordinal, mobile) {
  if (box.module.type === "section_header") return;
  const y = box.y;
  if (box.module.emphasis === "hero") {
    parts.push(`<text x="${box.x}" y="${y + 18}" font-family="${SANS}" font-size="${mobile ? 10.5 : 11.5}" font-weight="700" letter-spacing="1.8" fill="${ACCENT}">${box.module.label ? esc(String(box.module.label).toUpperCase()) : "PRIMARY VISUAL"}</text>`);
    return;
  }
  parts.push(`<line x1="${box.x}" y1="${y}" x2="${box.x + box.w}" y2="${y}" stroke="${box.module.tone === "dark" ? "#8a959d" : GRID}" stroke-width="1"/>`);
  parts.push(`<text x="${box.x}" y="${y + 20}" font-family="${SANS}" font-size="${mobile ? 10 : 11}" font-weight="700" letter-spacing="1.5" fill="${ACCENT}">${String(ordinal ?? 0).padStart(2, "0")}${box.module.label ? ` · ${esc(String(box.module.label).toUpperCase())}` : ""}</text>`);
}

function embedVisual(parts, asset, box, module, mobile) {
  const sourceSvg = mobile || spanColumns(module.span) <= 6 ? asset.mobileSvg : asset.desktopSvg;
  const info = svgInfo(sourceSvg);
  const topPad = module.emphasis === "hero" ? 30 : (module.label ? 32 : 20);
  const availableH = box.h - topPad - 6;
  const targetW = box.w;
  const naturalH = targetW * (info.height / info.width);
  const targetH = Math.min(availableH, naturalH);
  const y = box.y + topPad;
  const inner = namespaceSvgInner(info.inner, `embed-${hash(module.id).slice(0, 8)}-${mobile ? "m" : "d"}`);
  parts.push(`<svg data-role="infographic-visual" data-module-id="${esc(module.id)}" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" viewBox="${info.minX} ${info.minY} ${info.width} ${info.height}" preserveAspectRatio="xMidYMin meet">${inner}</svg>`);
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
  const captionH = caption ? (mobile ? 42 : 34) : 0;
  const availableH = box.h - topPad - captionH - 6;
  const targetW = box.w;
  const naturalH = targetW * (info.height / info.width);
  const targetH = Math.min(availableH, naturalH);
  const y = box.y + topPad;
  const inner = namespaceSvgInner(info.inner, `illustration-${hash(module.id).slice(0, 8)}-${mobile ? "m" : "d"}`);
  parts.push(`<svg data-role="infographic-illustration" data-module-id="${esc(module.id)}" x="${box.x}" y="${y}" width="${targetW}" height="${targetH}" viewBox="${info.minX} ${info.minY} ${info.width} ${info.height}" preserveAspectRatio="xMidYMin meet">${inner}</svg>`);
  if (caption) textBlock(parts, caption, box.x, y + targetH + (mobile ? 15 : 14), { size: mobile ? 9.5 : 10.5, lineHeight: mobile ? 13 : 14, fill: MUTED, maxChars: mobile ? 78 : Math.max(62, Math.round(box.w / 7)), maxLines: 2, role: "illustration-credit" });
  if (caption) parts.push(`<rect data-role="illustration-credit" data-module-id="${esc(module.id)}" x="${box.x}" y="${y + targetH}" width="1" height="1" fill="none"/>`);
}

function drawHeroStat(parts, box, module, mobile) {
  const tone = module.tone ?? "accent";
  const fill = tone === "dark" ? DARK : tone === "light" ? FAINT : ACCENT;
  const fg = tone === "light" ? INK : "#ffffff";
  const muted = tone === "light" ? MUTED : "#f5d9d5";
  const pad = mobile ? 28 : 30;
  parts.push(`<rect data-role="hero-stat" data-module-id="${esc(module.id)}" x="${box.x}" y="${box.y + 28}" width="${box.w}" height="${box.h - 28}" rx="5" fill="${fill}"/>`);
  parts.push(`<text x="${box.x + pad}" y="${box.y + 28 + (mobile ? 69 : 66)}" font-family="${SERIF}" font-size="${mobile ? 54 : 58}" font-weight="700" fill="${fg}">${esc(module.value)}${module.unit ? `<tspan font-size="${mobile ? 22 : 24}" dx="7">${esc(module.unit)}</tspan>` : ""}</text>`);
  textBlock(parts, module.label, box.x + pad, box.y + 28 + (mobile ? 106 : 102), { size: mobile ? 15 : 15.5, lineHeight: mobile ? 20 : 20, weight: 700, fill: fg, maxChars: mobile ? 48 : Math.max(28, Math.round(box.w / 10)), maxLines: 2 });
  if (module.detail) textBlock(parts, module.detail, box.x + pad, box.y + box.h - 20, { size: mobile ? 11.5 : 12, lineHeight: 16, fill: muted, maxChars: mobile ? 70 : Math.max(38, Math.round(box.w / 8)), maxLines: 2 });
}

function drawTextModule(parts, box, module, mobile) {
  const top = box.y + 42;
  if (module.heading) {
    textBlock(parts, module.heading, box.x, top, { family: SERIF, size: mobile ? 25 : 27, lineHeight: mobile ? 30 : 32, weight: 700, maxChars: mobile ? 35 : Math.max(30, Math.round(box.w / 17)), maxLines: 3 });
  }
  const headLines = module.heading ? lines(module.heading, mobile ? 35 : Math.max(30, Math.round(box.w / 17)), 3).length : 0;
  textBlock(parts, module.body, box.x, top + headLines * (mobile ? 30 : 32) + (module.heading ? 16 : 0), { size: mobile ? 16 : 16.5, lineHeight: mobile ? 24 : 23, fill: INK, maxChars: mobile ? 54 : Math.max(44, Math.round(box.w / 10)), maxLines: 12 });
}

function drawSectionHeader(parts, box, module, mobile) {
  const y = box.y + (mobile ? 44 : 42);
  const headingChars = mobile ? 31 : 48;
  const headingLH = mobile ? 37 : 42;
  const headingLines = lines(module.heading ?? "", headingChars, 3).length;
  parts.push(`<text x="${box.x}" y="${y}" font-family="${SANS}" font-size="${mobile ? 11 : 12}" font-weight="700" letter-spacing="2" fill="${ACCENT}">${esc(String(module.eyebrow ?? "THE STORY").toUpperCase())}</text>`);
  textBlock(parts, module.heading, box.x, y + (mobile ? 38 : 40), { family: SERIF, size: mobile ? 31 : 36, lineHeight: headingLH, weight: 700, maxChars: headingChars, maxLines: 3 });
  if (module.deck) textBlock(parts, module.deck, box.x, y + (mobile ? 38 : 40) + headingLines * headingLH + 13, { size: mobile ? 15 : 16, lineHeight: mobile ? 22 : 23, fill: MUTED, maxChars: mobile ? 55 : 86, maxLines: 3 });
}

function drawPullQuote(parts, box, module, mobile) {
  const y = box.y + 38;
  parts.push(`<rect x="${box.x}" y="${box.y + 28}" width="${mobile ? 6 : 7}" height="${Math.max(80, box.h - 48)}" fill="${ACCENT}"/>`);
  textBlock(parts, `“${module.text}”`, box.x + (mobile ? 28 : 34), y + 22, { family: SERIF, size: mobile ? 27 : 30, lineHeight: mobile ? 34 : 38, weight: 700, maxChars: mobile ? 33 : Math.max(30, Math.round(box.w / 17)), maxLines: 7 });
  if (module.attribution) textBlock(parts, module.attribution, box.x + (mobile ? 28 : 34), box.y + box.h - 20, { size: mobile ? 12 : 13, lineHeight: 17, weight: 700, fill: MUTED, maxChars: 55, maxLines: 2 });
}

function sourceList(spec, assets) {
  return uniq([
    spec.source_note,
    ...(spec.modules ?? []).filter((m) => m.type === "visual").map((m) => assets[m.manifest_ref]?.manifest?.source_note),
    ...(spec.modules ?? []).filter((m) => m.type === "illustration").map((m) => assets[m.asset_ref]?.manifest?.source_note),
  ]);
}

function composeOne(spec, assets, mobile) {
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
  const ordinals = editorialOrdinalMap(spec);
  shiftedBoxes.forEach((box) => {
    const module = box.module;
    if (module.type !== "section_header") drawModuleChrome(parts, box, ordinals.get(String(module.id)), mobile);
    if (module.type === "hero_stat") drawHeroStat(parts, box, module, mobile);
    else if (module.type === "visual") embedVisual(parts, assets[module.manifest_ref], box, module, mobile);
    else if (module.type === "illustration") embedIllustration(parts, assets[module.asset_ref], box, module, mobile);
    else if (module.type === "text") drawTextModule(parts, box, module, mobile);
    else if (module.type === "section_header") drawSectionHeader(parts, box, module, mobile);
    else if (module.type === "pull_quote") drawPullQuote(parts, box, module, mobile);
  });
  const footerY = startY + layout.contentHeight + (mobile ? 50 : 54);
  parts.push(`<line x1="${layout.margin}" y1="${footerY}" x2="${layout.width - layout.margin}" y2="${footerY}" stroke="${INK}" stroke-width="2"/>`);
  parts.push(`<text x="${layout.margin}" y="${footerY + 30}" font-family="${SANS}" font-size="${mobile ? 11 : 12}" font-weight="700" letter-spacing="1.3" fill="${INK}">SOURCES &amp; METHODS</text>`);
  const sources = sourceList(spec, assets);
  textBlock(parts, sources.join(" · "), layout.margin, footerY + 57, { size: mobile ? 10.5 : 11.5, lineHeight: mobile ? 15 : 16, fill: MUTED, maxChars: mobile ? 92 : 172, maxLines: mobile ? 5 : 4 });
  parts.push(`<text x="${layout.width - layout.margin}" y="${pageHeight - 26}" text-anchor="end" font-family="${SANS}" font-size="10" font-weight="700" letter-spacing="1.2" fill="${MUTED}">AGENTIC DATA NEWSROOM · VERIFIED VISUAL STORY</text>`);
  for (const box of shiftedBoxes) parts.push(`<rect data-role="module-boundary" data-module-id="${esc(box.id)}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="none"/>`);
  parts.push("</svg>");
  const visualKinds = uniq((spec.modules ?? []).flatMap((m) => {
    if (m.type === "visual") return [assets[m.manifest_ref]?.manifest?.chart_type];
    if (m.type === "illustration") {
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
    boxes: shiftedBoxes,
    scenes: (layout.scenes ?? []).map((scene) => ({ ...scene, y: scene.y + startY })),
    sources,
    layout_strategy: layout.strategy ?? (mobile ? "single_column" : "balanced"),
    candidate_scores: layout.candidate_scores ?? [{ strategy: layout.strategy ?? "balanced", score: 0 }],
    visual_kinds: visualKinds,
  };
}

export function composeInfographicBundle(spec, assets = {}) {
  const errors = validateInfographicSpec(spec);
  if (errors.length) throw new Error(errors.join("; "));
  return { desktop: composeOne(spec, assets, false), mobile: composeOne(spec, assets, true) };
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
  if (!composed.svg.includes("SOURCES &amp; METHODS") && !composed.svg.includes("SOURCES & METHODS")) { issues.push({ severity: "blocker", code: "source_strip_missing" }); score -= 25; }
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
  const priorities = new Map((spec.modules ?? []).map((m) => [m.id, Number.isInteger(m.priority) ? m.priority : 3]));
  return (composed.boxes ?? []).find((box) => (box.module?.type === "visual" || box.module?.type === "illustration") && box.module?.emphasis === "hero")
    ?? (composed.boxes ?? []).find((box) => (box.module?.type === "visual" || box.module?.type === "illustration") && priorities.get(box.id) === 1)
    ?? (composed.boxes ?? []).find((box) => box.module?.type === "visual" || box.module?.type === "illustration")
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
  if (!composed.svg.includes("SOURCES &amp; METHODS") && !composed.svg.includes("SOURCES & METHODS")) {
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
  const visualCount = modules.filter((m) => m.type === "visual" || m.type === "illustration").length;
  const heroStats = modules.filter((m) => m.type === "hero_stat").length;
  const sectionHeaders = modules.filter((m) => m.type === "section_header").length;
  const pullQuotes = modules.filter((m) => m.type === "pull_quote").length;
  const priorityOne = modules.filter((m) => m.priority === 1);
  const explicitHero = modules.find((m) => (m.type === "visual" || m.type === "illustration") && m.emphasis === "hero");
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
  const sourcePresent = composed.svg.includes("SOURCES &amp; METHODS") || composed.svg.includes("SOURCES & METHODS");
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

export function critiqueInfographic(spec, bundle) {
  if (!["1.1.0", "1.2.0", "1.3.0", "1.4.0"].includes(spec.schema_version)) {
    const desktop = critiqueLegacyOne(spec, bundle.desktop, false);
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

