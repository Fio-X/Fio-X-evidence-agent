import { createHash } from 'node:crypto';
import { assertSafeSvg } from './svg_security.mjs';

export const RICH_ILLUSTRATION_SCHEMA_VERSION = '0.2.0';
export const ILLUSTRATION_ORIGINS = ['human', 'generative_ai', 'mixed', 'software'];
export const ILLUSTRATION_POLICIES = ['human_only', 'ai_disclosed', 'software_only'];
export const DIGITAL_SOURCE_TYPES = ['humanCreated', 'trainedAlgorithmicMedia', 'compositeSynthetic', 'algorithmicMedia'];

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
function text(value) { return String(value ?? '').trim(); }
function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function uniq(values) { return [...new Set(values.filter(Boolean).map(String))]; }

export function validateIllustrationSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['illustration spec must be an object'];
  if (spec.schema_version !== RICH_ILLUSTRATION_SCHEMA_VERSION) errors.push(`schema_version must be ${RICH_ILLUSTRATION_SCHEMA_VERSION}`);
  if (!text(spec.title)) errors.push('title is required');
  if (!text(spec.subject)) errors.push('subject is required');
  if (!text(spec.intent)) errors.push('intent is required');
  if (!text(spec.alt) || text(spec.alt).length < 30) errors.push('alt must be at least 30 characters');
  if (!text(spec.style_direction)) errors.push('style_direction is required');
  if (!['landscape', 'portrait', 'square', 'adaptive'].includes(spec.aspect_ratio)) errors.push('aspect_ratio must be landscape, portrait, square, or adaptive');
  if (!ILLUSTRATION_POLICIES.includes(spec.origin_policy)) errors.push(`origin_policy must be one of ${ILLUSTRATION_POLICIES.join(', ')}`);
  if (!Array.isArray(spec.claim_ids) || spec.claim_ids.length === 0) errors.push('claim_ids must contain at least one verified claim');
  if ((spec.claim_ids ?? []).some((id) => !text(id))) errors.push('claim_ids must contain non-empty strings');
  if (!Array.isArray(spec.evidence_refs) || spec.evidence_refs.length === 0) errors.push('evidence_refs must contain at least one source or computation artifact');
  if ((spec.evidence_refs ?? []).some((ref) => !text(ref))) errors.push('evidence_refs must contain non-empty strings');
  if (!text(spec.source_note)) errors.push('source_note is required');
  if (!text(spec.credit)) errors.push('credit is required');
  if (spec.factual_elements !== undefined && !Array.isArray(spec.factual_elements)) errors.push('factual_elements must be an array');
  const ids = new Set();
  for (const item of spec.factual_elements ?? []) {
    if (!text(item?.id)) errors.push('each factual element requires id');
    else if (ids.has(item.id)) errors.push(`duplicate factual element id '${item.id}'`);
    else ids.add(item.id);
    if (!text(item?.label)) errors.push(`factual element '${item?.id ?? '?'}' requires label`);
    if (!Array.isArray(item?.claim_ids) || item.claim_ids.length === 0) errors.push(`factual element '${item?.id ?? '?'}' requires claim_ids`);
  }
  return errors;
}

export function lintIllustrationSpec(spec, context = {}) {
  const blockers = validateIllustrationSpec(spec);
  const warnings = [];
  const notes = [];
  const verified = new Set((context.verified_claim_ids ?? []).map(String));
  const knownEvidence = new Set((context.evidence_refs ?? []).map(String));
  for (const id of spec.claim_ids ?? []) if (verified.size && !verified.has(String(id))) blockers.push(`claim '${id}' is not verified`);
  for (const element of spec.factual_elements ?? []) for (const id of element.claim_ids ?? []) if (verified.size && !verified.has(String(id))) blockers.push(`factual element '${element.id}' references unverified claim '${id}'`);
  for (const ref of spec.evidence_refs ?? []) if (knownEvidence.size && !knownEvidence.has(String(ref))) blockers.push(`evidence ref '${ref}' is unavailable`);
  if ((spec.factual_elements ?? []).length > 10) warnings.push('More than ten factual elements can reduce illustration legibility');
  if (text(spec.style_direction).length > 700) warnings.push('style_direction is unusually long and may reduce adapter portability');
  notes.push(`origin_policy=${spec.origin_policy}`);
  notes.push(`claims=${uniq(spec.claim_ids ?? []).length}`);
  notes.push(`evidence_refs=${uniq(spec.evidence_refs ?? []).length}`);
  return { schema_version: RICH_ILLUSTRATION_SCHEMA_VERSION, passed: blockers.length === 0, blockers, warnings, notes, content_hash: hash(spec) };
}


function annotateSvg(svg, spec, provenance, viewport) {
  let value = assertSafeSvg(svg, { label: `${viewport} SVG` });
  const rootAttrs = ` data-rich-illustration-version="${RICH_ILLUSTRATION_SCHEMA_VERSION}" data-origin="${esc(provenance.origin)}" data-digital-source-type="${esc(provenance.digital_source_type)}"`;
  value = value.replace(/<svg\b/i, `<svg${rootAttrs}`);
  const title = `<title>${esc(spec.title)}</title>`;
  const desc = `<desc>${esc(spec.alt)}</desc>`;
  if (!/<title\b/i.test(value)) value = value.replace(/(<svg\b[^>]*>)/i, `$1${title}`);
  if (!/<desc\b/i.test(value)) value = value.replace(/(<svg\b[^>]*>)(?:<title\b[^>]*>[\s\S]*?<\/title>)?/i, (match) => `${match}${desc}`);
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function normalizeIllustrationAdapterResponse(spec, response) {
  if (!response || typeof response !== 'object') throw new Error('Illustration adapter returned no JSON object');
  const origin = text(response.origin);
  if (!ILLUSTRATION_ORIGINS.includes(origin)) throw new Error(`Illustration adapter origin must be one of ${ILLUSTRATION_ORIGINS.join(', ')}`);
  if (spec.origin_policy === 'human_only' && origin !== 'human') throw new Error(`origin_policy=human_only rejects adapter origin '${origin}'`);
  if (spec.origin_policy === 'software_only' && origin !== 'software') throw new Error(`origin_policy=software_only rejects adapter origin '${origin}'`);
  const digitalSourceType = text(response.digital_source_type);
  if (!DIGITAL_SOURCE_TYPES.includes(digitalSourceType)) throw new Error(`digital_source_type must be one of ${DIGITAL_SOURCE_TYPES.join(', ')}`);
  if ((origin === 'generative_ai' || origin === 'mixed') && digitalSourceType === 'humanCreated') throw new Error('AI or mixed origin cannot declare humanCreated digital_source_type');
  if (origin === 'human' && digitalSourceType !== 'humanCreated') throw new Error('Human origin must declare humanCreated digital_source_type');
  const provider = text(response.provider);
  const model = text(response.model);
  const version = text(response.version);
  if ((origin === 'generative_ai' || origin === 'mixed') && (!provider || !model)) throw new Error('AI or mixed illustration output requires provider and model');
  const disclosure = text(response.disclosure) || (origin === 'generative_ai' ? `AI-generated illustration using ${provider} ${model}.` : origin === 'mixed' ? `Illustration includes AI-generated material using ${provider} ${model}.` : origin === 'software' ? 'Software-generated explanatory illustration.' : 'Human-created illustration.');
  const provenance = {
    origin,
    digital_source_type: digitalSourceType,
    provider: provider || null,
    model: model || null,
    version: version || null,
    adapter_id: text(response.adapter_id) || null,
    disclosure,
    prompt_hash: response.prompt_hash ? text(response.prompt_hash) : null,
    content_credentials: response.content_credentials && typeof response.content_credentials === 'object' ? response.content_credentials : null,
    license: text(response.license) || null,
  };
  const desktop = annotateSvg(response?.variants?.desktop ?? response.desktop_svg, spec, provenance, 'desktop');
  const mobile = annotateSvg(response?.variants?.mobile ?? response.mobile_svg, spec, provenance, 'mobile');
  return {
    desktop,
    mobile,
    provenance,
    metadata: response.metadata && typeof response.metadata === 'object' ? response.metadata : {},
    adapter_response_hash: hash(response),
  };
}

export function critiqueRichIllustration(spec, manifest, bundle) {
  const issues = [];
  let score = 100;
  const origin = manifest?.provenance?.origin;
  if (!ILLUSTRATION_ORIGINS.includes(origin)) { issues.push({ severity: 'blocker', code: 'origin_missing' }); score -= 30; }
  if (!text(manifest?.provenance?.digital_source_type)) { issues.push({ severity: 'blocker', code: 'digital_source_type_missing' }); score -= 20; }
  if (!text(manifest?.provenance?.disclosure)) { issues.push({ severity: 'blocker', code: 'disclosure_missing' }); score -= 25; }
  if ((origin === 'generative_ai' || origin === 'mixed') && (!text(manifest?.provenance?.provider) || !text(manifest?.provenance?.model))) { issues.push({ severity: 'blocker', code: 'ai_system_metadata_missing' }); score -= 30; }
  if (spec.origin_policy === 'human_only' && origin !== 'human') { issues.push({ severity: 'blocker', code: 'origin_policy_violation' }); score -= 50; }
  if (spec.origin_policy === 'software_only' && origin !== 'software') { issues.push({ severity: 'blocker', code: 'origin_policy_violation' }); score -= 50; }
  for (const [viewport, svg] of Object.entries(bundle ?? {})) {
    try { assertSafeSvg(svg, viewport); } catch (error) { issues.push({ severity: 'blocker', code: 'unsafe_svg', viewport, message: String(error) }); score -= 30; }
    if (!String(svg).includes('data-rich-illustration-version="0.2.0"')) { issues.push({ severity: 'blocker', code: 'provenance_markup_missing', viewport }); score -= 20; }
    if (!/<title\b/i.test(String(svg)) || !/<desc\b/i.test(String(svg))) { issues.push({ severity: 'blocker', code: 'accessibility_markup_missing', viewport }); score -= 20; }
  }
  if ((spec.factual_elements ?? []).length > 10) { issues.push({ severity: 'warning', code: 'factual_element_density' }); score -= 6; }
  return { schema_version: RICH_ILLUSTRATION_SCHEMA_VERSION, passed: !issues.some((issue) => issue.severity === 'blocker') && score >= 90, score: Math.max(0, score), issues };
}

export function illustrationAdapterRequest(spec, context = {}) {
  return {
    protocol: 'agentic-data-newsroom.rich-illustration.v1',
    spec,
    evidence: {
      claim_ids: uniq(spec.claim_ids ?? []),
      evidence_refs: uniq(spec.evidence_refs ?? []),
      source_note: spec.source_note,
      factual_elements: spec.factual_elements ?? [],
    },
    policy: {
      origin_policy: spec.origin_policy,
      external_network_allowed: false,
      embedded_raster_allowed: false,
      responsive_variants_required: true,
    },
    request_hash: hash({ spec, evidence_snapshot_hash: context.evidence_snapshot_hash ?? null }),
  };
}
