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
