import { createHash } from 'node:crypto';

export const ASSET_PLAN_SCHEMA_VERSION = '0.1.0';
export const EXPERT_PREFERENCE_SCHEMA_VERSION = '0.1.0';
export const REFERENCE_CORPUS_SCHEMA_VERSION = '0.1.0';
export const AWARD_MODE_STATUS_SCHEMA_VERSION = '0.1.0';

export const ASSET_CLASSES = [
  'published_gis', 'archival_photo', 'verified_diagram', 'portrait_or_object_photo',
  'expert_explanation', 'geographic_coordinates', 'historical_series', 'human_scale_reference',
  'vector_illustration', 'verified_3d',
];
export const PRODUCTION_LANES = ['software_schematic', 'human_vector', 'human_illustration', 'gis_render', 'photo_collage', 'verified_3d', 'generated_disclosed'];

function text(value) { return String(value ?? '').trim(); }
function uniq(values) { return [...new Set((values ?? []).map((v) => text(v)).filter(Boolean))]; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function artDirectionHash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function planEditorialAssets(input) {
  const conceptRef = text(input?.concept_ref);
  const conceptId = text(input?.concept_id);
  if (!conceptRef) throw new Error('concept_ref is required');
  if (!conceptId) throw new Error('concept_id is required');
  if (!Array.isArray(input?.requirements)) throw new Error('requirements must be an array');
  const requirements = input.requirements.map((raw, index) => {
    const assetClass = text(raw?.asset_class);
    const status = text(raw?.status || (raw?.blocking ? 'blocking' : raw?.required === false ? 'optional' : 'required'));
    if (!ASSET_CLASSES.includes(assetClass)) throw new Error(`requirement ${index + 1} has unsupported asset_class '${assetClass}'`);
    if (!['blocking', 'required', 'optional'].includes(status)) throw new Error(`requirement ${index + 1} has unsupported status '${status}'`);
    const available = Boolean(raw?.available);
    const sourceRefs = uniq(raw?.source_refs);
    const productionLane = text(raw?.production_lane);
    if (productionLane && !PRODUCTION_LANES.includes(productionLane)) throw new Error(`requirement ${index + 1} has unsupported production_lane '${productionLane}'`);
    if (available && sourceRefs.length === 0) throw new Error(`available requirement ${index + 1} requires source_refs`);
    return {
      id: text(raw?.id) || `asset-${index + 1}`,
      asset_class: assetClass,
      status,
      available,
      purpose: text(raw?.purpose),
      source_refs: sourceRefs,
      production_lane: productionLane || null,
      evidence_needed: text(raw?.evidence_needed) || null,
      rejection_reason: text(raw?.rejection_reason) || null,
    };
  });
  const ids = requirements.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('asset requirement ids must be unique');
  const blockers = requirements.filter((r) => r.status === 'blocking' && !r.available);
  const missingRequired = requirements.filter((r) => r.status === 'required' && !r.available);
  const decision = blockers.length ? 'RESEARCH_MORE' : missingRequired.length ? 'REVISE' : 'CONTINUE';
  const artifact = {
    schema_version: ASSET_PLAN_SCHEMA_VERSION,
    kind: 'editorial_asset_plan',
    concept_ref: conceptRef,
    concept_id: conceptId,
    requirements,
    decision,
    blocking_missing: blockers.map((r) => r.id),
    required_missing: missingRequired.map((r) => r.id),
    available_count: requirements.filter((r) => r.available).length,
  };
  artifact.content_hash = artDirectionHash(artifact);
  return artifact;
}

export function validateExternalAssetManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['asset manifest must be an object'];
  if (!text(manifest.asset_id)) errors.push('asset_id is required');
  if (!ASSET_CLASSES.includes(text(manifest.asset_class))) errors.push(`asset_class must be one of ${ASSET_CLASSES.join(', ')}`);
  if (!PRODUCTION_LANES.includes(text(manifest.production_lane))) errors.push(`production_lane must be one of ${PRODUCTION_LANES.join(', ')}`);
  if (!text(manifest.source_url)) errors.push('source_url is required');
  if (!text(manifest.license)) errors.push('license is required');
  if (!text(manifest.credit)) errors.push('credit is required');
  if (!['human', 'software', 'mixed', 'generative_ai'].includes(text(manifest.origin))) errors.push('origin must be human, software, mixed, or generative_ai');
  if (!/^[a-f0-9]{64}$/i.test(text(manifest.source_sha256))) errors.push('source_sha256 must be a SHA-256 hex digest');
  if (!/^[a-f0-9]{64}$/i.test(text(manifest.output_sha256))) errors.push('output_sha256 must be a SHA-256 hex digest');
  if (text(manifest.origin) === 'human' && !['human_vector', 'human_illustration', 'photo_collage'].includes(text(manifest.production_lane))) errors.push('human origin requires a human production lane');
  if (text(manifest.origin) === 'generative_ai' && text(manifest.production_lane) !== 'generated_disclosed') errors.push('generative_ai origin requires generated_disclosed lane');
  return errors;
}

export function retrieveReferencePatterns(input) {
  const corpus = Array.isArray(input?.corpus) ? input.corpus : [];
  const query = new Set(uniq(input?.tags).map((x) => x.toLowerCase()));
  if (!corpus.length) throw new Error('reference corpus is empty');
  if (!query.size) throw new Error('at least one retrieval tag is required');
  const scored = corpus.map((item) => {
    const tags = new Set(uniq(item?.tags).map((x) => x.toLowerCase()));
    let overlap = 0;
    for (const tag of query) if (tags.has(tag)) overlap += 1;
    const copyRiskPenalty = text(item?.copy_risk) === 'high' ? 1 : 0;
    return { ...item, retrieval_score: overlap * 10 - copyRiskPenalty };
  }).filter((item) => item.retrieval_score > 0)
    .sort((a, b) => b.retrieval_score - a.retrieval_score || text(a.id).localeCompare(text(b.id)))
    .slice(0, Math.min(6, Math.max(1, Number(input?.limit) || 4)));
  const artifact = {
    schema_version: REFERENCE_CORPUS_SCHEMA_VERSION,
    kind: 'reference_pattern_retrieval',
    tags: [...query].sort(),
    matches: scored,
  };
  artifact.content_hash = artDirectionHash(artifact);
  return artifact;
}

export function evaluateExpertPreference(input) {
  const baselineRef = text(input?.baseline_ref);
  const candidateRef = text(input?.candidate_ref);
  const minimumReviewers = Number(input?.minimum_reviewers ?? 3);
  if (!baselineRef || !candidateRef) throw new Error('baseline_ref and candidate_ref are required');
  if (!Number.isInteger(minimumReviewers) || minimumReviewers < 3) throw new Error('minimum_reviewers must be an integer >= 3');
  const reviews = Array.isArray(input?.reviews) ? input.reviews : [];
  const normalized = reviews.map((review, index) => {
    const id = text(review?.reviewer_id_hash);
    if (!/^[a-f0-9]{16,64}$/i.test(id)) throw new Error(`review ${index + 1} requires a non-identifying reviewer_id_hash`);
    if (review?.qualified !== true) throw new Error(`review ${index + 1} must explicitly attest qualified=true`);
    const preference = text(review?.preference);
    if (!['baseline', 'candidate', 'tie'].includes(preference)) throw new Error(`review ${index + 1} preference must be baseline, candidate, or tie`);
    return {
      reviewer_id_hash: id,
      qualified: true,
      preference,
      story_specificity: text(review?.story_specificity) || null,
      hierarchy: text(review?.hierarchy) || null,
      space_intent: text(review?.space_intent) || null,
      visual_voice: text(review?.visual_voice) || null,
      information_gain: text(review?.information_gain) || null,
      delayed_memory: text(review?.delayed_memory) || null,
      jury_survival: text(review?.jury_survival) || null,
      comment: text(review?.comment) || null,
    };
  });
  const unique = new Set(normalized.map((r) => r.reviewer_id_hash));
  if (unique.size !== normalized.length) throw new Error('reviewer_id_hash values must be unique');
  const candidateWins = normalized.filter((r) => r.preference === 'candidate').length;
  const baselineWins = normalized.filter((r) => r.preference === 'baseline').length;
  const ties = normalized.filter((r) => r.preference === 'tie').length;
  const decisive = candidateWins + baselineWins;
  const candidateShare = decisive ? candidateWins / decisive : 0;
  const enoughReviewers = normalized.length >= minimumReviewers;
  const status = enoughReviewers ? (candidateShare >= Number(input?.candidate_threshold ?? 0.7) ? 'PASS' : 'FAIL') : 'PENDING';
  const artifact = {
    schema_version: EXPERT_PREFERENCE_SCHEMA_VERSION,
    kind: 'expert_pairwise_preference',
    baseline_ref: baselineRef,
    candidate_ref: candidateRef,
    minimum_reviewers: minimumReviewers,
    candidate_threshold: Number(input?.candidate_threshold ?? 0.7),
    reviews: normalized,
    counts: { candidate: candidateWins, baseline: baselineWins, tie: ties, total: normalized.length },
    candidate_decisive_share: Number(candidateShare.toFixed(4)),
    status,
    human_evidence_required: true,
  };
  artifact.content_hash = artDirectionHash(artifact);
  return artifact;
}


export function summarizeAwardMode(input) {
  const refs = {
    discovery_ref: text(input?.discovery_ref),
    concepts_ref: text(input?.concepts_ref),
    asset_plan_ref: text(input?.asset_plan_ref),
    novelty_ref: text(input?.novelty_ref),
    page_ref: text(input?.page_ref),
    preference_ref: text(input?.preference_ref) || null,
  };
  const metrics = {
    concepts_generated: Number(input?.metrics?.concepts_generated ?? 0),
    concepts_killed: Number(input?.metrics?.concepts_killed ?? 0),
    research_gap_requests: Number(input?.metrics?.research_gap_requests ?? 0),
    prototype_count: Number(input?.metrics?.prototype_count ?? 0),
    raster_revision_count: Number(input?.metrics?.raster_revision_count ?? 0),
    provider_tokens: Number(input?.metrics?.provider_tokens ?? 0),
    provider_cost_usd: Number(input?.metrics?.provider_cost_usd ?? 0),
    wall_time_ms: Number(input?.metrics?.wall_time_ms ?? 0),
    human_review_count: Number(input?.metrics?.human_review_count ?? 0),
  };
  for (const [key, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`award-mode metric '${key}' must be a finite non-negative number`);
  }
  const missingRefs = Object.entries(refs).filter(([key, value]) => key !== 'preference_ref' && !value).map(([key]) => key);
  const conceptBudgetOk = metrics.concepts_generated >= 8 && metrics.concepts_generated <= 20 && metrics.concepts_killed >= Math.ceil(metrics.concepts_generated / 2);
  const prototypeBudgetOk = metrics.prototype_count >= 2;
  const rasterObserved = metrics.raster_revision_count >= 1;
  const preferenceStatus = text(input?.preference_status || 'PENDING').toUpperCase();
  if (!['PENDING', 'PASS', 'FAIL'].includes(preferenceStatus)) throw new Error('preference_status must be PENDING, PASS, or FAIL');
  let status = 'READY_FOR_HUMAN';
  const blockers = [];
  if (missingRefs.length) blockers.push(`missing_refs:${missingRefs.join(',')}`);
  if (!conceptBudgetOk) blockers.push('concept_search_budget_not_met');
  if (!prototypeBudgetOk) blockers.push('prototype_budget_not_met');
  if (!rasterObserved) blockers.push('raster_review_not_observed');
  if (blockers.length) status = 'BLOCKED';
  else if (preferenceStatus === 'FAIL') status = 'FAIL';
  else if (preferenceStatus === 'PASS') status = 'PASS';
  const artifact = {
    schema_version: AWARD_MODE_STATUS_SCHEMA_VERSION,
    kind: 'award_mode_status', refs, metrics,
    gates: { concept_search_budget_ok: conceptBudgetOk, prototype_budget_ok: prototypeBudgetOk, raster_review_observed: rasterObserved },
    preference_status: preferenceStatus,
    status, blockers,
    human_evidence_required: true,
  };
  artifact.content_hash = artDirectionHash(artifact);
  return artifact;
}

export const DEFAULT_REFERENCE_PATTERNS = [
  { id:'lieflat-charts', publication:'Lieflat Charts', publication_or_skill:'Lieflat Charts', tags:['chart','report','editorial','offline','catalog'], reader_task:['match a data shape to a chart or report template','scan a conclusion and then inspect evidence'], data_topologies:['ranking','time_series','composition','matrix','flow','multi_module_report'], story_shapes:['claim-led chart','hook-to-resolution report','one-page evidence brief'], transferable_principle:'Select by data shape and reader task, then bind every visual module to verified evidence.', transferable_principles:['Prefer the simplest honest grammar for the topology.','Keep a conclusion, annotation, and source line close to each module.','Use Lupi Editorial, Lupi Basics, then Glance unless fast reading is explicit.'], use_when:['the output is an offline chart or evidence-bound report','the source data can be represented by a supported catalog contract'], do_not_use_when:['the requested geometry requires an unqualified network, map, or remote dependency','the evidence supports only one finding for a multi-module report'], required_assets:['verified claims','source snapshots','computation rows and hashes','selected catalog template'], completion_signals:['catalog comparison recorded','real template id recorded','source-bound modules','non-empty offline HTML or SVG'], differentiation_rule:'Use the pinned catalog as infrastructure but write a subject-specific thesis, data, annotations, and layout; do not retain demo data, conclusions, or template copy.', source_url:'https://github.com/larashero3-dotcom/lieflat-charts/tree/eace082a317b696c5570c25826a53a7fa113e984', copy_risk:'low' },
  { id:'economist-analytical', publication:'The Economist', publication_or_skill:'Economist analytical method', tags:['analytical','comparison','chart','clarity','annotation'], reader_task:['find the main comparison quickly','understand the benchmark and direction of change'], data_topologies:['ranking','time_series','before_after','distribution','comparison'], story_shapes:['one-claim chart','benchmark comparison','annotated trend'], transferable_principle:'Make one chart carry one judgment with a conclusion-led headline and a visible comparison baseline.', transferable_principles:['Prefer familiar forms over novelty for its own sake.','Label important values directly and control the color hierarchy.','Expose source and calculation provenance.'], use_when:['one analytical question is answerable with one chart','the reader needs a fast, defensible comparison'], do_not_use_when:['the story needs several heterogeneous mechanisms or spatial layers','a decorative chart would hide uncertainty or a weak baseline'], required_assets:['verified claim','comparison baseline','direct labels','source and computation note'], completion_signals:['one core judgment','direct labels','explicit benchmark','restrained palette','traceable source and calculation'], differentiation_rule:'Borrow analytical discipline only; do not copy Economist typography, logo, font, house colors, or fixed skin.', source_url:'https://www.economist.com/graphic-detail', copy_risk:'low' },
  { id:'scmp-integrated-explainer', publication:'South China Morning Post', publication_or_skill:'SCMP integrated explainer method', tags:['spatial','mechanism','scene','illustration','map'], reader_task:['understand how a place, object, or mechanism works','relate evidence to human scale and physical structure'], data_topologies:['geography','mechanism','process','timeline','object_anatomy'], story_shapes:['scene-to-mechanism','map-to-consequence','cross-section explanation'], transferable_principle:'Use the subject itself as the spatial scaffold and attach evidence directly to it.', transferable_principles:['Research the data and mechanism before choosing visual treatment.','Use a concept sketch to decide which spatial or physical structure organizes the page.','Mix maps, sections, timelines, illustrations, photos, and data only when each answers a reader question.'], use_when:['place, object, architecture, or mechanism is the mental model','a sourced human-scale comparison clarifies magnitude'], do_not_use_when:['location is incidental to a statistical question','geometry, route, or physical comparison cannot be sourced'], required_assets:['provenance-aware map or diagram','human-scale reference with source','mechanism evidence','concept sketch'], completion_signals:['spatial skeleton is explicit','at least two visual grammars','map provenance complete','no invented route or geometry'], differentiation_rule:'Change the premise, geometry, asset mix, and writing to fit the current reported subject; do not reproduce SCMP artwork or typography.', source_url:'https://multimedia.scmp.com/infographics/', copy_risk:'low' },
  { id:'delayed-gratification-two-speed', publication:'Delayed Gratification', tags:['comparison','density','magazine','two-speed','small-stories'], transferable_principle:'Pair an immediate takeaway with layered secondary stories so density rewards exploration.', differentiation_rule:'Derive visual grammar from the current dataset and publication voice.', source_url:'https://www.designweek.co.uk/issues/25-31-october-2021/delayed-gratification/', copy_risk:'low' },
  { id:'national-geographic-object-anatomy', publication:'National Geographic', tags:['object_scene','mechanism','illustration','anatomy','human-scale'], transferable_principle:'Use researched object anatomy when a physical subject is the reader mental model.', differentiation_rule:'Require subject-specific reporting and verified geometry before reconstruction.', source_url:'https://snd.org/national-geographics-fernando-baptista-washington-posts-emma-kumer-honored-with-worlds-best-designer-awards-from-society-for-news-design/', copy_risk:'low' },
  { id:'reuters-runtime-audit', publication:'Reuters Graphics', tags:['responsive','audit','browser','quality'], transferable_principle:'Observe actual reader pixels across devices and retain visual regression evidence.', differentiation_rule:'Use the audit workflow pattern without copying publication styling.', source_url:'https://github.com/reuters-graphics', copy_risk:'low' },
  { id:'nyt-responsive-artboard', publication:'The New York Times', tags:['responsive','illustration','web','mobile'], transferable_principle:'Preserve authored graphics through explicit responsive variants and inspectable web output.', differentiation_rule:'Keep art direction story-specific and treat export mechanics as infrastructure.', source_url:'https://github.com/newsdev/ai2html', copy_risk:'low' },
  { id:'pudding-visual-essay', publication:'The Pudding', publication_or_skill:'The Pudding visual essay method', tags:['discovery','concept','research','restart','scrollytelling'], reader_task:['follow a question through changing evidence states','understand why the conclusion changes or holds'], data_topologies:['tabular','events','time_series','flow','geography'], story_shapes:['hook-context-evidence-turn-resolution','scrolling reveal','question-led essay'], transferable_principle:'Build a visual essay around a reader question and make every interaction change the narrative state.', transferable_principles:['Name the audience and reader question before designing.','Use hook → context → evidence → turn → resolution.','Make scroll behavior robust to fast movement, return, reduced motion, and no JavaScript.'], use_when:['the story benefits from sequential explanation or a meaningful turn','the visual state can change without hiding the core evidence'], do_not_use_when:['animation is only decoration','a static chart answers the question more directly'], required_assets:['Story Graph','state map','responsive sections','reduced-motion and no-JS fallback','verified evidence per section'], completion_signals:['ordered story roles','state transition per interactive step','fast-scroll-safe behavior','no-JS core information','mobile QA'], differentiation_rule:'Use the process and narrative tests, not The Pudding’s visual identity, code, copy, or published interaction patterns.', source_url:'https://pudding.cool/process/', copy_risk:'low' },
  { id:'snd-art-direction', publication:'Society for News Design', tags:['competition','art-direction','typography','voice','craft'], transferable_principle:'Judge integrated voice, hierarchy, craft and news judgment after correctness is secured.', differentiation_rule:'Treat criteria as evaluation dimensions rather than a style template.', source_url:'https://snd.org/results/', copy_risk:'low' },
  { id:'iib-impact-clarity-beauty', publication:'Information is Beautiful Awards', tags:['competition','clarity','impact','beauty','innovation'], transferable_principle:'Balance analytical clarity with engagement and distinctive visual form.', differentiation_rule:'Use the criteria to compare concepts without imitating winning artwork.', source_url:'https://www.informationisbeautifulawards.com/', copy_risk:'low' },
  { id:'oja-medium-fit', publication:'Online Journalism Awards', tags:['competition','digital','mobile','interaction','medium-fit'], transferable_principle:'Choose media because they improve the story on digital and mobile platforms.', differentiation_rule:'Only add interaction when the current reader task benefits.', source_url:'https://awards.journalists.org/awards/visual-digital-storytelling/', copy_risk:'low' },
  { id:'sigma-public-interest', publication:'Sigma Awards', tags:['competition','data','public-interest','analysis','innovation'], transferable_principle:'Anchor visual innovation in substantial analysis and public-interest reporting.', differentiation_rule:'Preserve current evidence provenance and journalistic purpose.', source_url:'https://www.sigmaawards.org/rules/', copy_risk:'low' }
].map((pattern) => ({
  ...pattern,
  publication_or_skill: pattern.publication_or_skill ?? pattern.publication,
  reader_task: pattern.reader_task ?? ['understand the evidence and the editorial judgment'],
  data_topologies: pattern.data_topologies ?? ['mixed evidence'],
  story_shapes: pattern.story_shapes ?? ['claim → evidence → implication'],
  transferable_principles: pattern.transferable_principles ?? [pattern.transferable_principle],
  use_when: pattern.use_when ?? ['the method improves the current reader task without changing the evidence'],
  do_not_use_when: pattern.do_not_use_when ?? ['the method would add decoration or imply unsupported meaning'],
  required_assets: pattern.required_assets ?? ['verified evidence', 'source and provenance record'],
  completion_signals: pattern.completion_signals ?? ['claim-bound output', 'responsive or delivery QA'],
  differentiation_rule: pattern.differentiation_rule ?? 'Transfer the method, not the source publication’s identity, copy, or artwork.',
  source_url: pattern.source_url ?? null,
  copy_risk: pattern.copy_risk ?? 'low',
}));
