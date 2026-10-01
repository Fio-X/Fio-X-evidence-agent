import { createHash } from 'node:crypto';

export const VISION_CRITIC_SCHEMA_VERSION = '0.2.0';
export const VISION_RUBRIC_KEYS = [
  'hierarchy', 'legibility', 'composition', 'visual_coherence', 'typography',
  'source_legibility', 'responsive_quality', 'illustration_integration',
  'color_contrast', 'editorial_distinctiveness',
];
export const VISION_PATCH_FIELDS = ['span', 'emphasis', 'priority', 'move_before', 'mobile_move_before'];

function numberInRange(value, min, max) { return Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max; }
function text(value) { return String(value ?? '').trim(); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex'); }

export function validateVisionCriticReport(report, moduleIds = []) {
  const errors = [];
  const modules = new Set(moduleIds.map(String));
  if (!report || typeof report !== 'object') return ['vision critic report must be an object'];
  if (!numberInRange(report.score, 0, 100)) errors.push('score must be between 0 and 100');
  if (!numberInRange(report.confidence, 0, 1)) errors.push('confidence must be between 0 and 1');
  for (const key of VISION_RUBRIC_KEYS) if (!numberInRange(report?.rubric?.[key], 0, 100)) errors.push(`rubric.${key} must be between 0 and 100`);
  if (!Array.isArray(report.issues)) errors.push('issues must be an array');
  for (const issue of report.issues ?? []) {
    if (!['blocker', 'warning', 'nit'].includes(issue?.severity)) errors.push('issue severity must be blocker, warning, or nit');
    if (!['desktop', 'mobile', 'cross_view'].includes(issue?.viewport)) errors.push('issue viewport must be desktop, mobile, or cross_view');
    if (!text(issue?.code)) errors.push('issue code is required');
    if (!text(issue?.evidence)) errors.push(`issue '${issue?.code ?? '?'}' requires visible evidence`);
    if (!text(issue?.recommendation)) errors.push(`issue '${issue?.code ?? '?'}' requires recommendation`);
    if (issue?.module_id && modules.size && !modules.has(String(issue.module_id))) errors.push(`issue '${issue.code}' references unknown module '${issue.module_id}'`);
  }
  if (report.patches !== undefined && !Array.isArray(report.patches)) errors.push('patches must be an array');
  if ((report.patches ?? []).length > 8) errors.push('patches cannot exceed 8 items');
  const patchKeys = new Set();
  for (const patch of report.patches ?? []) {
    const target = String(patch?.target_module_id ?? '');
    if (!modules.has(target)) errors.push(`patch references unknown module '${patch?.target_module_id}'`);
    if (!VISION_PATCH_FIELDS.includes(patch?.field)) errors.push(`patch field '${patch?.field}' is not allowed`);
    const value = text(patch?.value);
    if (patch?.field === 'span' && !['full', 'half', 'two_thirds', 'third'].includes(value)) errors.push(`invalid span patch '${value}'`);
    if (patch?.field === 'emphasis' && !['hero', 'primary', 'secondary', 'support'].includes(value)) errors.push(`invalid emphasis patch '${value}'`);
    if (patch?.field === 'priority' && !['1', '2', '3', '4', '5'].includes(value)) errors.push(`invalid priority patch '${value}'`);
    if (['move_before', 'mobile_move_before'].includes(patch?.field) && !modules.has(value)) errors.push(`${patch.field} patch references unknown module '${value}'`);
    if (['move_before', 'mobile_move_before'].includes(patch?.field) && target === value) errors.push(`${patch.field} patch cannot move a module before itself`);
    const key = `${target}:${patch?.field}`;
    if (patchKeys.has(key)) errors.push(`duplicate patch for '${key}'`);
    patchKeys.add(key);
  }
  return errors;
}

export function normalizeVisionCriticReport(report, moduleIds = []) {
  const errors = validateVisionCriticReport(report, moduleIds);
  if (errors.length) throw new Error(errors.join('; '));
  const issues = report.issues ?? [];
  const score = Number(report.score);
  const floor = Math.min(...VISION_RUBRIC_KEYS.map((key) => Number(report.rubric[key])));
  const passed = report.passed === true && score >= 80 && floor >= 60 && !issues.some((issue) => issue.severity === 'blocker');
  return {
    schema_version: VISION_CRITIC_SCHEMA_VERSION,
    passed,
    score,
    confidence: Number(report.confidence),
    rubric: Object.fromEntries(VISION_RUBRIC_KEYS.map((key) => [key, Number(report.rubric[key])])),
    issues,
    patches: report.patches ?? [],
  };
}

function stripContentHash(spec) {
  const clone = structuredClone(spec);
  delete clone.content_hash;
  return clone;
}

function immutableProjection(spec) {
  const top = stripContentHash(spec);
  delete top.mobile_module_order;
  const modules = (top.modules ?? []).map((module) => {
    const copy = { ...module };
    delete copy.span;
    delete copy.emphasis;
    delete copy.priority;
    return copy;
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  top.modules = modules;
  return top;
}

function moveBefore(order, target, before) {
  const next = order.filter((id) => id !== target);
  const index = next.indexOf(before);
  if (index < 0) throw new Error(`Cannot move '${target}' before unknown module '${before}'`);
  next.splice(index, 0, target);
  return next;
}

export function applyVisionPatches(spec, report) {
  const source = stripContentHash(spec);
  const ids = (source.modules ?? []).map((module) => String(module.id));
  const normalized = normalizeVisionCriticReport(report, ids);
  if (!normalized.patches.length) throw new Error('vision critic contains no machine-actionable patches');
  const normalizedSource = structuredClone(source);
  if (normalizedSource.schema_version === '1.1.0') normalizedSource.schema_version = '1.2.0';
  if (normalizedSource.schema_version === '1.2.0' && !normalizedSource.competition_profile) normalizedSource.competition_profile = 'editorial';
  const beforeImmutableHash = hash(immutableProjection(normalizedSource));
  const next = structuredClone(normalizedSource);
  let mobileOrder = Array.isArray(next.mobile_module_order) && next.mobile_module_order.length === ids.length
    ? [...next.mobile_module_order]
    : [...ids];
  const applied = [];

  for (const patch of normalized.patches) {
    const target = next.modules.find((module) => String(module.id) === String(patch.target_module_id));
    if (!target) throw new Error(`patch target '${patch.target_module_id}' is missing`);
    if (patch.field === 'span') target.span = patch.value;
    else if (patch.field === 'emphasis') target.emphasis = patch.value;
    else if (patch.field === 'priority') target.priority = Number(patch.value);
    else if (patch.field === 'move_before') {
      const order = next.modules.map((module) => String(module.id));
      const moved = moveBefore(order, String(patch.target_module_id), String(patch.value));
      const byId = new Map(next.modules.map((module) => [String(module.id), module]));
      next.modules = moved.map((id) => byId.get(id));
    } else if (patch.field === 'mobile_move_before') {
      mobileOrder = moveBefore(mobileOrder, String(patch.target_module_id), String(patch.value));
    }
    applied.push({ target_module_id: String(patch.target_module_id), field: patch.field, value: String(patch.value) });
  }
  next.mobile_module_order = mobileOrder;

  const afterImmutableHash = hash(immutableProjection(next));
  if (beforeImmutableHash !== afterImmutableHash) throw new Error('vision patch attempted to modify immutable editorial evidence fields');
  return {
    spec: next,
    applied,
    safety: {
      immutable_projection_sha256: beforeImmutableHash,
      evidence_fields_preserved: true,
      source_schema_version: source.schema_version,
      revised_schema_version: next.schema_version,
      allowed_patch_fields: VISION_PATCH_FIELDS,
    },
  };
}

// ---- Plan edits (opt-in, NEWSROOM_SPEED_PLAN_EDIT) -------------------------
// The model states layout decisions directly instead of re-sending the whole
// plan. The module fields are the vision-patch fields; the scene fields add
// the pattern and which modules anchor or accompany a scene. Everything else
// stays inside the immutable projection, so copy, claims, refs, numbers,
// scene budgets and module membership cannot change through this path.
export const PLAN_EDIT_MODULE_FIELDS = VISION_PATCH_FIELDS;
export const PLAN_EDIT_SCENE_FIELDS = ['pattern', 'anchor_module_id', 'sidecar_module_ids'];
export const PLAN_EDIT_MAX_OPS = 12;
const SPANS = ['full', 'half', 'two_thirds', 'third'];
const EMPHASES = ['hero', 'primary', 'secondary', 'support'];
const SCENE_PATTERNS = ['hero_sidecar_stack', 'hero_with_rail'];

// Like the vision projection, but the editable scene fields are removed too.
export function planEditProjection(spec) {
  const top = immutableProjection(spec);
  if (top.scene_graph && Array.isArray(top.scene_graph.scenes)) {
    top.scene_graph = {
      ...top.scene_graph,
      scenes: top.scene_graph.scenes.map((scene) => {
        const copy = { ...scene };
        for (const field of PLAN_EDIT_SCENE_FIELDS) delete copy[field];
        return copy;
      }),
    };
  }
  return top;
}

export function validatePlanEditOps(ops, spec) {
  const errors = [];
  if (!Array.isArray(ops) || ops.length === 0) return ['ops must be a non-empty array'];
  if (ops.length > PLAN_EDIT_MAX_OPS) errors.push(`ops cannot exceed ${PLAN_EDIT_MAX_OPS} items`);
  const moduleIds = new Set((spec.modules ?? []).map((module) => String(module.id)));
  const sceneIds = new Set((spec.scene_graph?.scenes ?? []).map((scene) => String(scene.id)));
  const seen = new Set();
  for (const [index, op] of ops.entries()) {
    const label = `ops[${index}]`;
    if (!op || typeof op !== 'object' || Array.isArray(op)) { errors.push(`${label} must be an object`); continue; }
    const extra = Object.keys(op).filter((key) => !['scope', 'id', 'field', 'value'].includes(key));
    if (extra.length) errors.push(`${label} has unsupported key(s): ${extra.join(', ')}`);
    const { scope, field, value } = op;
    const id = String(op.id ?? '');
    if (scope !== 'module' && scope !== 'scene') { errors.push(`${label} scope must be 'module' or 'scene'`); continue; }
    const allowed = scope === 'module' ? PLAN_EDIT_MODULE_FIELDS : PLAN_EDIT_SCENE_FIELDS;
    if (!allowed.includes(field)) { errors.push(`${label} field '${field}' is not editable on a ${scope} (editable: ${allowed.join(', ')})`); continue; }
    if (!(scope === 'module' ? moduleIds : sceneIds).has(id)) { errors.push(`${label} refers to unknown ${scope} '${id}'`); continue; }
    const key = `${scope}:${id}:${field}`;
    if (seen.has(key)) errors.push(`${label} duplicates an edit of ${key}`);
    seen.add(key);
    if (field === 'span' && !SPANS.includes(value)) errors.push(`${label} invalid span '${value}'`);
    else if (field === 'emphasis' && !EMPHASES.includes(value)) errors.push(`${label} invalid emphasis '${value}'`);
    else if (field === 'priority' && !(Number.isInteger(value) && value >= 1 && value <= 5)) errors.push(`${label} priority must be an integer from 1 to 5`);
    else if (field === 'move_before' || field === 'mobile_move_before' || field === 'anchor_module_id') {
      if (typeof value !== 'string' || !moduleIds.has(value)) errors.push(`${label} ${field} must name an existing module`);
      else if (field !== 'anchor_module_id' && value === id) errors.push(`${label} cannot move a module before itself`);
    } else if (field === 'pattern' && !SCENE_PATTERNS.includes(value)) errors.push(`${label} invalid scene pattern '${value}'`);
    else if (field === 'sidecar_module_ids') {
      const list = Array.isArray(value) ? value : null;
      if (!list || list.length < 1 || list.length > 3 || list.some((item) => typeof item !== 'string' || !moduleIds.has(item)) || new Set(list).size !== list.length) {
        errors.push(`${label} sidecar_module_ids must be 1-3 distinct existing module ids`);
      }
    }
  }
  return errors;
}

// Returns the edited plan core (no content_hash) and the audit facts. Throws
// on any invalid op or if anything outside the editable fields changed.
export function applyPlanEdits(spec, ops) {
  const source = stripContentHash(spec);
  const errors = validatePlanEditOps(ops, source);
  if (errors.length) throw new Error(`plan edit rejected: ${errors.join('; ')}`);
  const before = hash(planEditProjection(source));
  const next = structuredClone(source);
  const ids = next.modules.map((module) => String(module.id));
  let mobileOrder = Array.isArray(next.mobile_module_order) && next.mobile_module_order.length === ids.length
    ? [...next.mobile_module_order]
    : null;
  const applied = [];
  for (const op of ops) {
    if (op.scope === 'scene') {
      const scene = next.scene_graph.scenes.find((item) => String(item.id) === String(op.id));
      scene[op.field] = structuredClone(op.value);
    } else {
      const target = next.modules.find((module) => String(module.id) === String(op.id));
      if (op.field === 'move_before') {
        const moved = moveBefore(next.modules.map((module) => String(module.id)), String(op.id), String(op.value));
        const byId = new Map(next.modules.map((module) => [String(module.id), module]));
        next.modules = moved.map((id) => byId.get(id));
      } else if (op.field === 'mobile_move_before') {
        mobileOrder = moveBefore(mobileOrder ?? ids, String(op.id), String(op.value));
      } else {
        target[op.field] = op.value;
      }
    }
    applied.push({ scope: op.scope, id: String(op.id), field: op.field, value: structuredClone(op.value) });
  }
  if (mobileOrder) next.mobile_module_order = mobileOrder;
  const after = hash(planEditProjection(next));
  if (before !== after) throw new Error('plan edit attempted to modify immutable editorial evidence fields');
  return {
    spec: next,
    applied,
    safety: { immutable_projection_sha256: before, evidence_fields_preserved: true, editable_module_fields: PLAN_EDIT_MODULE_FIELDS, editable_scene_fields: PLAN_EDIT_SCENE_FIELDS },
  };
}
