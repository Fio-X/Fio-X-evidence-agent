// Page-stage preflight (NEWSROOM_SPEED_PREFLIGHT=1, default off). Pure logic
// over an injected artifact reader so it can be tested without Pi:
//
//  - fill*: copies a missing reference only when exactly one already-written
//    artifact is bound to the artifacts the call already names. A value the
//    model supplies is never read here, let alone overridden; the original
//    validators still judge it. Facts, claims, SQL, evidence, verified status,
//    selected_concept_id, story nodes and claim ids are never filled.
//  - *PrerequisiteIssues: lists every unmet precondition at once, using the
//    same conditions the tool's own checks use, so it can only reject earlier,
//    never accept anything the tool would reject.

const MAX_SCAN = 200;

const message = (error) => String(error?.message ?? error).split("\n")[0];

export async function candidates(io, dir, accept) {
  let refs;
  try { refs = await io.list(dir); } catch { return { found: [], truncated: false }; }
  const truncated = refs.length > MAX_SCAN;
  const found = [];
  for (const ref of refs.slice(0, MAX_SCAN)) {
    let artifact;
    try { artifact = await io.read(ref); } catch { continue; }
    if (await accept(artifact, ref)) found.push(ref);
  }
  return { found, truncated };
}

// One candidate fills the field; none or several leave it for the model, with
// the reason kept for the error message.
export function settle(state, field, result, none) {
  if (result.truncated) state.unresolved[field] = `more than ${MAX_SCAN} artifacts to scan; supply it explicitly`;
  else if (result.found.length === 1) { state.params[field] = result.found[0]; state.filled.push(field); }
  else if (!result.found.length) state.unresolved[field] = none;
  else state.unresolved[field] = `${result.found.length} candidates (${result.found.slice(0, 4).join(", ")}${result.found.length > 4 ? ", ..." : ""}); supply the one you mean`;
}

// A manifest that is rejected (moved away), unreadable, or a DRAFT / non-publishable
// visual is not a current artifact: nothing bound to it is a fill candidate. Uses
// the same loader the tools use, so "current" means what they accept.
async function unusableManifest(io, module) {
  const visual = module.type === "visual";
  try {
    const manifest = await io.manifest(visual ? "visualizations" : "visualizations/illustrations", String(module[visual ? "manifest_ref" : "asset_ref"]), visual ? "visualizations/" : "visualizations/illustrations/");
    if (visual && (manifest?.verification_mode === "draft" || manifest?.artifact_status === "DRAFT" || manifest?.publishable === false)) return `the manifest ${module.manifest_ref} is a DRAFT / non-publishable visualization; no critic is filled for it`;
  } catch (error) {
    return `the manifest cannot be used (${message(error)}); no critic is filled for it`;
  }
  return null;
}

// The filled key lands right after the key it is derived from, which is where
// the schema lists it, so the same module hashes the same either way.
function insertAfter(object, afterKey, key, value) {
  const out = {};
  for (const [k, v] of Object.entries(object)) {
    if (k === key) continue;
    out[k] = v;
    if (k === afterKey) out[key] = value;
  }
  return out;
}

// Only an omitted field is derivable. An explicit "" or null is a value the model
// supplied: it is never replaced here and the original validators reject it.
const missing = (value) => value === undefined;

export async function fillPlanRefs(params, io) {
  const state = { params: { ...params }, filled: [], unresolved: {} };
  const p = state.params;
  if (!missing(p.story_graph_ref) && (missing(p.reader_question) || missing(p.visual_thesis))) {
    try {
      const graph = await io.read(String(p.story_graph_ref), "editorial/story-graphs/");
      if (missing(p.reader_question) && typeof graph.reader_question === "string") { p.reader_question = graph.reader_question; state.filled.push("reader_question"); }
      if (missing(p.visual_thesis) && typeof graph.visual_thesis === "string") { p.visual_thesis = graph.visual_thesis; state.filled.push("visual_thesis"); }
    } catch { /* the prerequisite listing reports the unreadable graph */ }
  }
  const selected = missing(p.selected_concept_id) ? null : String(p.selected_concept_id);
  if (missing(p.visual_concept_ref)) {
    if (selected === null) state.unresolved.visual_concept_ref = "selected_concept_id is needed to find the concept set";
    else {
      const discoveryOk = new Map();
      const sets = await candidates(io, "editorial/concepts/", () => true);
      const finalists = [];
      for (const ref of sets.found) {
        const concepts = await io.read(ref).catch(() => null);
        if (!concepts || !(concepts.finalists ?? []).includes(selected)) continue;
        const discoveryRef = typeof concepts.discovery_ref === "string" ? concepts.discovery_ref : null;
        if (discoveryRef) {
          if (!discoveryOk.has(discoveryRef)) discoveryOk.set(discoveryRef, await io.read(discoveryRef).then((d) => d?.decision === "CONTINUE", () => false));
          if (!discoveryOk.get(discoveryRef)) continue;
        }
        finalists.push(ref);
      }
      settle(state, "visual_concept_ref", { found: finalists, truncated: sets.truncated }, `no editorial/concepts artifact lists '${selected}' as a finalist; call newsroom_visual_concepts first`);
    }
  }
  if (missing(p.editorial_discovery_ref) && !missing(p.visual_concept_ref)) {
    const concepts = await io.read(String(p.visual_concept_ref), "editorial/concepts/").catch(() => null);
    if (concepts && typeof concepts.discovery_ref === "string") { p.editorial_discovery_ref = concepts.discovery_ref; state.filled.push("editorial_discovery_ref"); }
    else state.unresolved.editorial_discovery_ref = "the bound concept set names no discovery artifact; supply editorial_discovery_ref";
  } else if (missing(p.editorial_discovery_ref)) {
    state.unresolved.editorial_discovery_ref = "needs visual_concept_ref first";
  }
  if (missing(p.novelty_ref)) {
    if (missing(p.visual_concept_ref)) state.unresolved.novelty_ref = "needs visual_concept_ref first";
    else settle(state, "novelty_ref", await candidates(io, "editorial/novelty/", (n) => n?.concept_ref === p.visual_concept_ref && n?.passed === true), "no passing editorial/novelty artifact is bound to this concept set; call newsroom_semantic_novelty first");
  }
  if (missing(p.asset_plan_ref)) {
    if (missing(p.visual_concept_ref) || selected === null) state.unresolved.asset_plan_ref = "needs visual_concept_ref and selected_concept_id first";
    else settle(state, "asset_plan_ref", await candidates(io, "editorial/assets/", (a) => a?.concept_ref === p.visual_concept_ref && a?.concept_id === selected && a?.decision === "CONTINUE"), "no CONTINUE editorial/assets plan is bound to this concept; call newsroom_asset_requirements first");
  }
  if (Array.isArray(p.modules)) {
    let changed = false;
    const modules = [];
    for (const module of p.modules) {
      if (module && typeof module === "object" && missing(module.critic_ref) && (module.type === "visual" || module.type === "illustration")) {
        const key = module.type === "visual" ? "manifest_ref" : "asset_ref";
        const dir = module.type === "visual" ? "visualizations/critics/" : "visualizations/illustrations/critics/";
        if (!missing(module[key])) {
          const unusable = await unusableManifest(io, module);
          if (unusable) { state.unresolved[`modules[${module.id}].critic_ref`] = unusable; modules.push(module); continue; }
          const found = await candidates(io, dir, (c) => c?.manifest_ref === module[key] && c?.passed === true);
          if (!found.truncated && found.found.length === 1) { modules.push(insertAfter(module, key, "critic_ref", found.found[0])); changed = true; state.filled.push(`modules[${module.id}].critic_ref`); continue; }
          state.unresolved[`modules[${module.id}].critic_ref`] = found.found.length ? `${found.found.length} passing critics bind ${module[key]}; supply the one you mean` : `no passing critic is bound to ${module[key]}; call ${module.type === "visual" ? "newsroom_viz_critic" : "the illustration critic"} first`;
        }
      }
      modules.push(module);
    }
    if (changed) p.modules = modules;
  }
  return state;
}

// Keep the schema's key order when something was filled, so the same content
// hashes to the same plan whether or not the model typed the derived fields.
export function inSchemaOrder(params, schemaKeys) {
  const ordered = {};
  for (const key of schemaKeys) if (key in params) ordered[key] = params[key];
  for (const key of Object.keys(params)) if (!(key in ordered)) ordered[key] = params[key];
  return ordered;
}

export async function planPrerequisiteIssues(spec, io, unresolved = {}) {
  const issues = [];
  const attempt = async (fn) => { try { await fn(); } catch (error) { issues.push(message(error)); } };
  for (const [field, reason] of Object.entries(unresolved)) {
    if (field.startsWith("modules[")) continue; // reported with its module below
    if (missing(spec[field])) issues.push(`${field} is missing and could not be derived: ${reason}`);
  }
  for (const field of ["reader_question", "visual_thesis"]) if (missing(spec[field])) issues.push(`${field} is missing; it is copied from the StoryGraph only when story_graph_ref is readable`);
  await attempt(async () => {
    let graph;
    try { graph = await io.read(String(spec.story_graph_ref), "editorial/story-graphs/"); }
    catch (error) { throw new Error(`story_graph_ref '${spec.story_graph_ref}' cannot be read (${message(error)}); call newsroom_story_graph first`); }
    if (!graph.passed) issues.push("the StoryGraph has blocking narrative-closure issues; fix it with newsroom_story_graph before planning");
    if (!missing(spec.reader_question) && String(graph.reader_question) !== String(spec.reader_question)) issues.push("reader_question must exactly match the StoryGraph reader_question");
    if (!missing(spec.visual_thesis) && String(graph.visual_thesis) !== String(spec.visual_thesis)) issues.push("visual_thesis must exactly match the StoryGraph visual_thesis");
    const nodes = new Set((graph.nodes ?? []).map((node) => String(node.id)));
    for (const module of spec.modules ?? []) for (const id of module.story_node_ids ?? []) if (!nodes.has(String(id))) issues.push(`module '${module.id}' references unknown story node '${id}'`);
  });
  if (!missing(spec.editorial_discovery_ref)) await attempt(async () => {
    const discovery = await io.read(String(spec.editorial_discovery_ref), "editorial/discovery/");
    if (discovery.decision !== "CONTINUE") throw new Error(`editorial discovery decision is '${discovery.decision}', so the page cannot proceed`);
  });
  if (!missing(spec.visual_concept_ref)) await attempt(async () => {
    const concepts = await io.read(String(spec.visual_concept_ref), "editorial/concepts/");
    if (!missing(spec.selected_concept_id) && !(concepts.finalists ?? []).includes(spec.selected_concept_id)) throw new Error(`selected_concept_id '${spec.selected_concept_id}' is not a finalist of ${spec.visual_concept_ref}`);
  });
  if (!missing(spec.novelty_ref)) await attempt(async () => {
    const novelty = await io.read(String(spec.novelty_ref), "editorial/novelty/");
    if (novelty.concept_ref !== spec.visual_concept_ref) throw new Error("the novelty report does not belong to the selected concept set");
    if (!novelty.passed) throw new Error("the novelty report has unresolved high semantic redundancy");
  });
  if (!missing(spec.asset_plan_ref)) await attempt(async () => {
    const plan = await io.read(String(spec.asset_plan_ref), "editorial/assets/");
    if (plan.concept_ref !== spec.visual_concept_ref || plan.concept_id !== spec.selected_concept_id) throw new Error("the asset plan does not belong to the selected visual concept");
    if (plan.decision !== "CONTINUE") throw new Error(`the asset plan decision is '${plan.decision}'`);
  });
  const verified = await io.verified().catch(() => new Set());
  for (const issue of await moduleIssues(spec.modules ?? [], io, verified, unresolved)) issues.push(issue);
  return issues;
}

// Claims and upstream visual artifacts of each module, shared by plan and render.
export async function moduleIssues(modules, io, verified, unresolved = {}) {
  const issues = [];
  for (const module of modules) {
    const claimIds = [module.claim_id, ...(module.claim_ids ?? [])].filter(Boolean).map(String);
    for (const claimId of claimIds) if (!verified.has(claimId)) issues.push(`module '${module.id}' references unverified claim '${claimId}'`);
    const visual = module.type === "visual";
    if (!visual && module.type !== "illustration") continue;
    const refKey = visual ? "manifest_ref" : "asset_ref";
    const label = visual ? "visual" : "illustration";
    if (missing(module[refKey]) || missing(module.critic_ref)) {
      const reason = unresolved[`modules[${module.id}].critic_ref`];
      issues.push(`${label} module '${module.id}' requires ${refKey} and critic_ref${reason ? ` (critic_ref: ${reason})` : ""}`);
      continue;
    }
    try {
      const manifest = await io.manifest(visual ? "visualizations" : "visualizations/illustrations", String(module[refKey]), visual ? "visualizations/" : "visualizations/illustrations/");
      const critic = await io.read(String(module.critic_ref), visual ? "visualizations/critics/" : "visualizations/illustrations/critics/");
      if (!critic.passed) issues.push(`${label} module '${module.id}' critic did not pass`);
      if (critic.manifest_ref && critic.manifest_ref !== module[refKey]) issues.push(`${label} module '${module.id}' critic does not match its ${refKey}`);
      if (visual) {
        if (manifest.verification_mode === "draft" || manifest.artifact_status === "DRAFT" || manifest.publishable === false) issues.push(`visual module '${module.id}' uses a DRAFT/non-publishable manifest; bind a verified visual`);
        if (manifest.claim_id && !verified.has(String(manifest.claim_id))) issues.push(`visual module '${module.id}' manifest references unverified claim '${manifest.claim_id}'`);
      } else {
        for (const claimId of manifest.claim_ids ?? []) if (!verified.has(String(claimId))) issues.push(`illustration module '${module.id}' manifest references unverified claim '${claimId}'`);
      }
    } catch (error) {
      issues.push(`${label} module '${module.id}': ${message(error)}`);
    }
  }
  return issues;
}

// render / critic / preview: each reference is derivable from the one before it.
// A passing lint of this plan whose upstream asset hashes still match (the render's
// own staleness test, supplied by the reader when it can load the assets).
const lintAccept = async (a, p, io) => a?.plan_ref === p.plan_ref && a?.passed === true && !(a?.blockers ?? []).length && (typeof io.lintCurrent !== "function" || (await io.lintCurrent(a)));
const manifestAccept = async (a, p, io, ref) => a?.plan_ref === p.plan_ref && a?.lint_ref === p.lint_ref && Boolean(a?.variants) && (typeof io.pageManifestUsableRef !== "function" || (await io.pageManifestUsableRef(ref)));
const STAGE_FILL = {
  newsroom_infographic_render: [{ field: "lint_ref", from: ["plan_ref"], dir: "infographics/lints/", accept: lintAccept, none: (p) => `no passing infographic lint is bound to ${p.plan_ref}; call newsroom_infographic_lint first` }],
  newsroom_infographic_critic: [
    { field: "lint_ref", from: ["plan_ref"], dir: "infographics/lints/", accept: lintAccept, none: (p) => `no passing infographic lint is bound to ${p.plan_ref}; call newsroom_infographic_lint first` },
    { field: "manifest_ref", from: ["plan_ref", "lint_ref"], dir: "infographics/", accept: manifestAccept, none: (p) => `no rendered infographic manifest is bound to ${p.plan_ref}; call newsroom_infographic_render first` },
  ],
  newsroom_infographic_preview: [{ field: "critic_ref", from: ["manifest_ref"], dir: "infographics/critics/", accept: async (a, p, io) => a?.manifest_ref === p.manifest_ref && a?.passed === true && (typeof io.pageManifestUsableRef !== "function" || (await io.pageManifestUsableRef(p.manifest_ref))), none: (p) => `no passing deterministic infographic critic is bound to ${p.manifest_ref}; call newsroom_infographic_critic first` }],
};

export const STAGE_FILL_TOOLS = Object.keys(STAGE_FILL);
export const STAGE_FILL_FIELDS = { newsroom_infographic_render: ["lint_ref"], newsroom_infographic_critic: ["lint_ref", "manifest_ref"], newsroom_infographic_preview: ["critic_ref"] };

export async function fillStageRefs(tool, params, io) {
  const state = { params: { ...params }, filled: [], unresolved: {} };
  for (const rule of STAGE_FILL[tool] ?? []) {
    if (!missing(state.params[rule.field])) continue;
    if (rule.from.some((key) => missing(state.params[key]))) { state.unresolved[rule.field] = `needs ${rule.from.join(" and ")} first`; continue; }
    settle(state, rule.field, await candidates(io, rule.dir, (a, ref) => rule.accept(a, state.params, io, ref)), rule.none(state.params));
  }
  return state;
}

// All unmet render-time preconditions: lint binding plus every module's upstream artifacts.
export async function renderPrerequisiteIssues(params, io, unresolved = {}) {
  const issues = [];
  for (const [field, reason] of Object.entries(unresolved)) if (missing(params[field])) issues.push(`${field} is missing and could not be derived: ${reason}`);
  let spec = null;
  try { spec = await io.read(String(params.plan_ref), "infographics/plans/"); } catch (error) { issues.push(`plan_ref '${params.plan_ref}' cannot be read (${message(error)}); call newsroom_infographic_plan first`); }
  if (!missing(params.lint_ref)) {
    try {
      const lint = await io.read(String(params.lint_ref), "infographics/lints/");
      if (lint.plan_ref !== params.plan_ref) issues.push("the infographic lint does not belong to the supplied plan");
      if (!lint.passed || (lint.blockers ?? []).length) issues.push("the infographic lint has blocking failures; fix the plan and lint it again");
    } catch (error) { issues.push(`lint_ref '${params.lint_ref}' cannot be read (${message(error)})`); }
  }
  if (spec) for (const issue of await loadableIssues(spec.modules ?? [], io)) issues.push(issue);
  return issues;
}

// Only what loading a page's upstream assets itself rejects (readable, not
// rejected, critic bound to its manifest); claim and critic-pass checks belong
// to plan time and stay there.
async function loadableIssues(modules, io) {
  const issues = [];
  for (const module of modules) {
    const visual = module.type === "visual";
    if (!visual && module.type !== "illustration") continue;
    const refKey = visual ? "manifest_ref" : "asset_ref";
    if (missing(module[refKey])) continue;
    try {
      await io.manifest(visual ? "visualizations" : "visualizations/illustrations", String(module[refKey]), visual ? "visualizations/" : "visualizations/illustrations/");
      if (!missing(module.critic_ref)) {
        const critic = await io.read(String(module.critic_ref), visual ? "visualizations/critics/" : "visualizations/illustrations/critics/");
        if (critic.manifest_ref && critic.manifest_ref !== module[refKey]) issues.push(`${visual ? "visual" : "illustration"} module '${module.id}': critic '${module.critic_ref}' does not belong to '${module[refKey]}'`);
      }
    } catch (error) {
      issues.push(`${visual ? "visual" : "illustration"} module '${module.id}': ${message(error)}`);
    }
  }
  return issues;
}

export function preflightError(tool, issues) {
  return new Error(`Preflight found ${issues.length} unmet precondition${issues.length === 1 ? "" : "s"} for ${tool}; fix them together before calling again:\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`);
}
