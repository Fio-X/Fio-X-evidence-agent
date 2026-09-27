import { createHash } from 'node:crypto';

export const EDITORIAL_DISCOVERY_SCHEMA_VERSION = '0.1.0';
export const VISUAL_CONCEPT_SET_SCHEMA_VERSION = '0.1.0';
export const SEMANTIC_NOVELTY_SCHEMA_VERSION = '0.1.0';
export const DISCOVERY_DECISIONS = ['RESEARCH_MORE', 'REVISE', 'KILL', 'CONTINUE'];
export const EXPLANATORY_DIMENSIONS = ['trend', 'rank', 'spatial', 'mechanism', 'comparison', 'distribution', 'uncertainty', 'human_scale', 'method', 'context'];
export const CONCEPT_FRAMINGS = ['spatial', 'temporal', 'mechanism', 'comparison', 'human_scale', 'object_scene', 'progressive_reveal'];

function text(value) { return String(value ?? '').trim(); }
function uniq(values) { return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))]; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function editorialHash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function validateEditorialDiscovery(discovery) {
  const errors = [];
  if (!discovery || typeof discovery !== 'object') return ['editorial discovery must be an object'];
  if (discovery.schema_version && discovery.schema_version !== EDITORIAL_DISCOVERY_SCHEMA_VERSION) errors.push(`schema_version must be ${EDITORIAL_DISCOVERY_SCHEMA_VERSION}`);
  if (!text(discovery.reader_problem)) errors.push('reader_problem is required');
  const listFields = ['candidate_questions', 'surprises', 'counterintuitive_findings', 'human_scale_refs', 'spatial_dimensions', 'temporal_dimensions', 'mechanisms', 'uncertainties', 'kill_reasons'];
  for (const field of listFields) if (!Array.isArray(discovery[field])) errors.push(`${field} must be an array`);
  if (Array.isArray(discovery.candidate_questions) && (discovery.candidate_questions.length < 1 || discovery.candidate_questions.length > 12)) errors.push('candidate_questions must contain 1..12 items');
  if (discovery.missing_reporting !== undefined && !Array.isArray(discovery.missing_reporting)) errors.push('missing_reporting must be an array');
  for (const item of discovery.missing_reporting ?? []) {
    if (!item || typeof item !== 'object' || !text(item.need)) errors.push('every missing_reporting item requires need');
    if (typeof item?.blocking !== 'boolean') errors.push(`missing_reporting '${item?.need ?? '?'}' requires boolean blocking`);
  }
  return errors;
}

export function assessEditorialDiscovery(input) {
  const discovery = { schema_version: EDITORIAL_DISCOVERY_SCHEMA_VERSION, ...input };
  const errors = validateEditorialDiscovery(discovery);
  if (errors.length) throw new Error(errors.join('; '));
  const questions = uniq(discovery.candidate_questions);
  const blockingGaps = (discovery.missing_reporting ?? []).filter((item) => item.blocking === true);
  let decision = 'CONTINUE';
  const reasons = [];
  if ((discovery.kill_reasons ?? []).length && questions.length < 2) {
    decision = 'KILL'; reasons.push('kill_reasons_present_with_weak_question_set');
  } else if (blockingGaps.length) {
    decision = 'RESEARCH_MORE'; reasons.push('blocking_reporting_gap');
  } else if (questions.length < 3 || (!(discovery.surprises ?? []).length && !(discovery.mechanisms ?? []).length && !(discovery.spatial_dimensions ?? []).length)) {
    decision = 'REVISE'; reasons.push('insufficient_editorial_search_breadth');
  } else {
    reasons.push('sufficient_question_diversity_and_no_blocking_gap');
  }
  const artifact = {
    ...discovery,
    candidate_questions: questions,
    decision,
    decision_reasons: reasons,
    metrics: {
      candidate_question_count: questions.length,
      blocking_reporting_gap_count: blockingGaps.length,
      discovery_dimension_count: [discovery.surprises, discovery.human_scale_refs, discovery.spatial_dimensions, discovery.temporal_dimensions, discovery.mechanisms, discovery.uncertainties].filter((items) => (items ?? []).length).length,
    },
  };
  artifact.content_hash = editorialHash(artifact);
  return artifact;
}

function normalizeConcept(concept) {
  return {
    ...concept,
    concept_id: text(concept.concept_id),
    reader_question: text(concept.reader_question),
    editorial_premise: text(concept.editorial_premise),
    surprise: text(concept.surprise),
    visual_metaphor: text(concept.visual_metaphor),
    hero_scene: text(concept.hero_scene),
    framing: text(concept.framing),
    hero_evidence_refs: uniq(concept.hero_evidence_refs),
    supporting_evidence_refs: uniq(concept.supporting_evidence_refs),
    media_mix: uniq(concept.media_mix),
    risk_flags: uniq(concept.risk_flags),
    reporting_gaps: uniq(concept.reporting_gaps),
    asset_requirements: Array.isArray(concept.asset_requirements) ? concept.asset_requirements : [],
  };
}

export function validateVisualConcepts(concepts) {
  const errors = [];
  if (!Array.isArray(concepts)) return ['concepts must be an array'];
  if (concepts.length < 8 || concepts.length > 20) errors.push('award-mode concepts must contain 8..20 candidates');
  const ids = new Set();
  for (const raw of concepts) {
    const concept = normalizeConcept(raw ?? {});
    if (!concept.concept_id) errors.push('every concept requires concept_id');
    else if (ids.has(concept.concept_id)) errors.push(`duplicate concept_id '${concept.concept_id}'`);
    else ids.add(concept.concept_id);
    for (const field of ['reader_question', 'editorial_premise', 'visual_metaphor', 'hero_scene', 'mobile_treatment', 'why_memorable']) if (!text(concept[field])) errors.push(`concept '${concept.concept_id || '?'}' requires ${field}`);
    if (!CONCEPT_FRAMINGS.includes(concept.framing)) errors.push(`concept '${concept.concept_id || '?'}' has unsupported framing '${concept.framing}'`);
    if (!concept.hero_evidence_refs.length) errors.push(`concept '${concept.concept_id || '?'}' requires hero_evidence_refs`);
    if (!concept.media_mix.length) errors.push(`concept '${concept.concept_id || '?'}' requires media_mix`);
    for (const asset of concept.asset_requirements) {
      if (!asset || typeof asset !== 'object' || !text(asset.kind)) errors.push(`concept '${concept.concept_id || '?'}' asset requirement requires kind`);
      if (typeof asset?.available !== 'boolean') errors.push(`concept '${concept.concept_id || '?'}' asset requirement '${asset?.kind ?? '?'}' requires boolean available`);
      if (typeof asset?.blocking !== 'boolean') errors.push(`concept '${concept.concept_id || '?'}' asset requirement '${asset?.kind ?? '?'}' requires boolean blocking`);
    }
  }
  if (new Set(concepts.map((concept) => concept?.framing).filter(Boolean)).size < 3) errors.push('concept set must cover at least three distinct framings');
  return errors;
}

function genericConceptPenalty(concept) {
  const generic = /dashboard|collection of charts|clean data story|magazine layout|standard charts|generic infographic/i;
  return generic.test(`${concept.visual_metaphor} ${concept.hero_scene}`) ? 18 : 0;
}

export function scoreVisualConcept(raw) {
  const concept = normalizeConcept(raw);
  const evidenceCount = new Set([...concept.hero_evidence_refs, ...concept.supporting_evidence_refs]).size;
  const distinctiveMedia = concept.media_mix.filter((item) => /map|gis|illustration|photo|object|scene|3d|cutaway|timeline/i.test(item)).length;
  const blockingAssets = concept.asset_requirements.filter((asset) => asset.blocking && !asset.available).length;
  const unavailableAssets = concept.asset_requirements.filter((asset) => !asset.available).length;
  let score = 38;
  score += Math.min(16, evidenceCount * 3);
  score += Math.min(14, distinctiveMedia * 4);
  score += CONCEPT_FRAMINGS.includes(concept.framing) ? 6 : 0;
  score += text(concept.surprise).length >= 24 ? 5 : 0;
  score += text(concept.mobile_treatment).length >= 35 ? 5 : 0;
  score += text(concept.why_memorable).length >= 35 ? 6 : 0;
  score += text(concept.editorial_premise).length >= 40 ? 4 : 0;
  score -= genericConceptPenalty(concept);
  score -= blockingAssets * 24;
  score -= Math.max(0, unavailableAssets - blockingAssets) * 4;
  score -= concept.risk_flags.length * 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function tournamentVisualConcepts(input) {
  const concepts = (input.concepts ?? []).map(normalizeConcept);
  const errors = validateVisualConcepts(concepts);
  if (errors.length) throw new Error(errors.join('; '));
  const scores = Object.fromEntries(concepts.map((concept) => [concept.concept_id, scoreVisualConcept(concept)]));
  const pairwise = [];
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i], b = concepts[j];
      const scoreA = scores[a.concept_id], scoreB = scores[b.concept_id];
      const winner = scoreA === scoreB ? [a.concept_id, b.concept_id].sort()[0] : scoreA > scoreB ? a.concept_id : b.concept_id;
      pairwise.push({ a: a.concept_id, b: b.concept_id, score_a: scoreA, score_b: scoreB, winner });
    }
  }
  const ranked = [...concepts].sort((a, b) => scores[b.concept_id] - scores[a.concept_id] || a.concept_id.localeCompare(b.concept_id));
  const finalists = ranked.slice(0, Math.min(3, ranked.length)).map((concept) => concept.concept_id);
  const rejected = ranked.slice(finalists.length).map((concept) => ({ concept_id: concept.concept_id, score: scores[concept.concept_id], reason: concept.why_reject || (genericConceptPenalty(concept) ? 'generic_visual_premise' : 'lower_tournament_score') }));
  const artifact = {
    schema_version: VISUAL_CONCEPT_SET_SCHEMA_VERSION,
    kind: 'visual_concept_tournament',
    discovery_ref: text(input.discovery_ref),
    concepts,
    scores,
    pairwise,
    finalists,
    selected_concept_id: finalists[0],
    rejected,
    diversity: { framing_count: new Set(concepts.map((concept) => concept.framing)).size, media_count: new Set(concepts.flatMap((concept) => concept.media_mix)).size },
  };
  artifact.content_hash = editorialHash(artifact);
  return artifact;
}

function tokenSet(value) {
  return new Set(String(value ?? '').toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, ' ').split(/\s+/).filter((token) => token.length >= 3));
}
function jaccard(a, b) {
  const aa = new Set(a), bb = new Set(b);
  if (!aa.size && !bb.size) return 0;
  let intersection = 0;
  for (const item of aa) if (bb.has(item)) intersection += 1;
  return intersection / Math.max(1, new Set([...aa, ...bb]).size);
}

export function scoreSemanticNovelty(input) {
  const modules = (input.modules ?? []).map((module) => ({
    ...module,
    id: text(module.id),
    reader_question_id: text(module.reader_question_id),
    claim_set: uniq(module.claim_set),
    new_information: text(module.new_information),
    explanatory_dimension: text(module.explanatory_dimension),
    dependency_on: uniq(module.dependency_on),
    justification: text(module.justification),
  }));
  const errors = [];
  if (modules.length < 2 || modules.length > 30) errors.push('semantic novelty requires 2..30 modules');
  const seenIds = new Set();
  for (const module of modules) {
    if (!module.id) errors.push('every semantic module requires id');
    else if (seenIds.has(module.id)) errors.push(`duplicate semantic module id '${module.id}'`);
    else seenIds.add(module.id);
    if (!module.reader_question_id) errors.push(`module '${module.id || '?'}' requires reader_question_id`);
    if (!module.claim_set.length) errors.push(`module '${module.id || '?'}' requires claim_set`);
    if (!module.new_information) errors.push(`module '${module.id || '?'}' requires new_information`);
    if (!EXPLANATORY_DIMENSIONS.includes(module.explanatory_dimension)) errors.push(`module '${module.id || '?'}' has unsupported explanatory_dimension '${module.explanatory_dimension}'`);
  }
  if (errors.length) throw new Error(errors.join('; '));
  const pairwise = [];
  const decisions = [];
  let highRedundancy = 0;
  for (let i = 0; i < modules.length; i++) {
    let maxOverlap = 0;
    let maxPrior = null;
    for (let j = 0; j < i; j++) {
      const current = modules[i], prior = modules[j];
      const questionOverlap = current.reader_question_id === prior.reader_question_id ? 1 : 0;
      const claimOverlap = jaccard(current.claim_set, prior.claim_set);
      const textOverlap = jaccard(tokenSet(current.new_information), tokenSet(prior.new_information));
      const dimensionOverlap = current.explanatory_dimension === prior.explanatory_dimension ? 1 : 0;
      let overlap = 0.45 * questionOverlap + 0.35 * claimOverlap + 0.15 * textOverlap + 0.05 * dimensionOverlap;
      if (current.dependency_on.includes(prior.id) && current.explanatory_dimension !== prior.explanatory_dimension) overlap = Math.max(0, overlap - 0.25);
      overlap = Number(overlap.toFixed(4));
      pairwise.push({ prior_module_id: prior.id, module_id: current.id, overlap });
      if (overlap > maxOverlap) { maxOverlap = overlap; maxPrior = prior.id; }
    }
    const level = maxOverlap >= 0.72 ? 'high' : maxOverlap >= 0.58 ? 'medium' : 'low';
    let action = level === 'high' ? 'REMOVE_OR_JUSTIFY' : level === 'medium' ? 'DEMOTE_OR_JUSTIFY' : 'KEEP';
    if (level === 'high' && modules[i].justification) action = 'KEEP_WITH_JUSTIFICATION';
    if (level === 'high' && !modules[i].justification) highRedundancy += 1;
    decisions.push({ module_id: modules[i].id, max_overlap: Number(maxOverlap.toFixed(4)), overlaps_most_with: maxPrior, redundancy: level, action });
  }
  const artifact = {
    schema_version: SEMANTIC_NOVELTY_SCHEMA_VERSION,
    kind: 'semantic_novelty_report',
    concept_ref: text(input.concept_ref),
    modules,
    pairwise,
    decisions,
    passed: highRedundancy === 0,
    high_redundancy_count: highRedundancy,
    average_novelty: Number((decisions.reduce((sum, item) => sum + (1 - item.max_overlap), 0) / decisions.length).toFixed(4)),
  };
  artifact.content_hash = editorialHash(artifact);
  return artifact;
}
