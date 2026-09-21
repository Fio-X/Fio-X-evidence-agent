import { lintEditorialGrammarSelection } from './editorial_grammar.mjs';

export const VALIDATOR_SEVERITIES = ['FATAL', 'ERROR', 'WARNING', 'INFO'];
export const COGNITIVE_GOALS = ['ORIENT', 'ZOOM', 'EXPLAIN', 'MEASURE', 'COMPARE', 'CONSEQUENCE'];

function issue(validator, severity, rule_id, message, path = '', details = {}) {
  return { validator, severity, rule_id, message, path, ...details };
}

function moduleClaims(module) {
  return [...new Set([module?.claim_id, ...(module?.claim_ids ?? []), ...(module?.claim_set ?? [])].filter(Boolean).map(String))];
}

function sceneModules(spec, scene) {
  const byId = new Map((spec?.modules ?? []).map((module) => [String(module.id), module]));
  return [scene?.anchor_module_id, ...(scene?.sidecar_module_ids ?? [])].map(String).map((id) => byId.get(id)).filter(Boolean);
}

export function annotationTargetValidator(spec) {
  const validator = 'annotation_target_validator';
  const issues = [];
  for (const [moduleIndex, module] of (spec?.modules ?? []).entries()) {
    const targets = new Set([String(module.id), ...(module.graphic_object_ids ?? []).map(String)]);
    const annotationIds = new Set();
    for (const [annotationIndex, annotation] of (module.annotations ?? []).entries()) {
      const base = `/modules/${moduleIndex}/annotations/${annotationIndex}`;
      if (annotationIds.has(String(annotation.id))) issues.push(issue(validator, 'ERROR', 'annotation.id_unique', `annotation '${annotation.id}' is duplicated within module '${module.id}'`, `${base}/id`));
      annotationIds.add(String(annotation.id));
      if (!targets.has(String(annotation.target_object_id))) issues.push(issue(validator, 'ERROR', 'annotation.target_bound', `annotation '${annotation.id}' targets unknown object '${annotation.target_object_id}' in module '${module.id}'`, `${base}/target_object_id`));
      const claims = new Set(moduleClaims(module));
      if (annotation.claim_id && !claims.has(String(annotation.claim_id))) issues.push(issue(validator, 'ERROR', 'annotation.claim_bound', `annotation '${annotation.id}' claim '${annotation.claim_id}' is not bound to module '${module.id}'`, `${base}/claim_id`));
    }
  }
  return issues;
}

export function visualChannelOwnerValidator(spec) {
  const validator = 'visual_channel_owner_validator';
  const issues = [];
  for (const [moduleIndex, module] of (spec?.modules ?? []).entries()) {
    if (module.type !== 'visual') continue;
    const seen = new Map();
    const channels = module.visual_channels ?? [];
    if (spec.schema_version === '1.5.0' && channels.length === 0) issues.push(issue(validator, 'ERROR', 'visual_channel.owner_required', `visual module '${module.id}' must declare visual channel ownership`, `/modules/${moduleIndex}/visual_channels`));
    for (const [channelIndex, owner] of channels.entries()) {
      const channel = String(owner.channel ?? '');
      if (seen.has(channel)) issues.push(issue(validator, 'ERROR', 'visual_channel.single_owner', `channel '${channel}' in module '${module.id}' has multiple owners`, `/modules/${moduleIndex}/visual_channels/${channelIndex}/channel`, { first_owner: seen.get(channel), second_owner: owner.field }));
      else seen.set(channel, owner.field);
    }
    const quantitative = channels.filter((owner) => owner.role === 'quantitative');
    const accurate = quantitative.some((owner) => ['position', 'length', 'area', 'size', 'angle'].includes(owner.channel));
    if (quantitative.length && !accurate) issues.push(issue(validator, 'ERROR', 'visual_channel.color_only_quantity', `visual module '${module.id}' encodes quantity only through low-precision channels`, `/modules/${moduleIndex}/visual_channels`));
  }
  return issues;
}

export function misleadingQuantitativeValidator(spec, assets = {}) {
  const validator = 'misleading_quantitative_validator';
  const issues = [];
  for (const [moduleIndex, module] of (spec?.modules ?? []).entries()) {
    if (module.type !== 'visual') continue;
    const encoding = module.quantitative_encoding;
    const path = `/modules/${moduleIndex}/quantitative_encoding`;
    if (spec.schema_version === '1.5.0' && !encoding) {
      issues.push(issue(validator, 'ERROR', 'quantitative.encoding_required', `visual module '${module.id}' must declare quantitative encoding semantics`, path));
      continue;
    }
    if (!encoding) continue;
    const chartType = String(assets[module.manifest_ref]?.manifest?.chart_type ?? '');
    if (['horizontal_bar', 'diverging_bar'].includes(chartType) && !['zero', 'symmetric_zero'].includes(encoding.baseline_policy)) issues.push(issue(validator, 'ERROR', 'quantitative.zero_baseline_required', `bar visual '${module.id}' requires a zero or symmetric-zero baseline`, `${path}/baseline_policy`));
    if (encoding.scale_type === 'log' && (!(Number(encoding.domain_min) > 0) || !(Number(encoding.domain_max) > Number(encoding.domain_min)))) issues.push(issue(validator, 'ERROR', 'quantitative.log_domain_positive', `log scale in module '${module.id}' requires 0 < domain_min < domain_max`, path));
    if (['area', 'size'].includes(encoding.mark_semantics) && encoding.area_proportional !== true) issues.push(issue(validator, 'ERROR', 'quantitative.area_must_be_proportional', `area/size encoding in module '${module.id}' must declare proportional area`, `${path}/area_proportional`));
    const flowLike = module.visual_grammar === 'flow' || ['sankey', 'alluvial', 'parallel_sets', 'geo_flow_map', 'cartographic_flow_map'].includes(chartType);
    if (flowLike && encoding.quantity_kind === 'stock_change') issues.push(issue(validator, 'FATAL', 'quantitative.stock_change_is_not_flow', `module '${module.id}' cannot label stock change as migration flow`, `${path}/quantity_kind`));
    if (flowLike && encoding.quantity_kind === 'stock') issues.push(issue(validator, 'ERROR', 'quantitative.stock_is_not_flow', `module '${module.id}' uses flow geometry for a stock quantity without flow semantics`, `${path}/quantity_kind`));
    if (encoding.quantity_kind === 'estimated_flow' && encoding.uncertainty_disclosed !== true) issues.push(issue(validator, 'ERROR', 'quantitative.estimate_uncertainty_disclosed', `estimated flow module '${module.id}' must disclose uncertainty`, `${path}/uncertainty_disclosed`));
  }
  return issues;
}

export function sceneCognitiveBudgetValidator(spec) {
  const validator = 'scene_cognitive_budget_validator';
  const issues = [];
  for (const [sceneIndex, scene] of (spec?.scene_graph?.scenes ?? []).entries()) {
    if (spec?.scene_graph?.schema_version !== '0.2.0') continue;
    const base = `/scene_graph/scenes/${sceneIndex}`;
    const modules = sceneModules(spec, scene);
    const objectIds = new Set(modules.flatMap((module) => [String(module.id), ...(module.graphic_object_ids ?? []).map(String)]));
    if (!COGNITIVE_GOALS.includes(scene.primary_cognitive_goal)) issues.push(issue(validator, 'ERROR', 'scene.cognitive_goal_supported', `scene '${scene.id}' has unsupported cognitive goal '${scene.primary_cognitive_goal ?? ''}'`, `${base}/primary_cognitive_goal`));
    if (!objectIds.has(String(scene.hero_object_id))) issues.push(issue(validator, 'ERROR', 'scene.hero_bound', `scene '${scene.id}' hero '${scene.hero_object_id}' does not resolve to a scene object`, `${base}/hero_object_id`));
    const heroModules = modules.filter((module) => module.emphasis === 'hero');
    if (heroModules.length > 1) issues.push(issue(validator, 'ERROR', 'scene.single_hero', `scene '${scene.id}' has ${heroModules.length} hero-emphasis modules`, base));
    const budget = scene.scene_budget ?? {};
    const supportingCount = (scene.sidecar_module_ids ?? []).length;
    const annotationCount = modules.reduce((total, module) => total + (module.annotations ?? []).length, 0);
    const claims = new Set(modules.flatMap(moduleClaims));
    if (supportingCount > Number(budget.max_supporting_objects ?? -1)) issues.push(issue(validator, 'ERROR', 'scene.supporting_budget', `scene '${scene.id}' exceeds its supporting-object budget`, `${base}/scene_budget/max_supporting_objects`, { actual: supportingCount }));
    if (annotationCount > Number(budget.max_annotations ?? -1)) issues.push(issue(validator, 'ERROR', 'scene.annotation_budget', `scene '${scene.id}' exceeds its annotation budget`, `${base}/scene_budget/max_annotations`, { actual: annotationCount }));
    if (claims.size > Number(budget.max_claims ?? -1)) issues.push(issue(validator, 'ERROR', 'scene.claim_budget', `scene '${scene.id}' exceeds its claim budget`, `${base}/scene_budget/max_claims`, { actual: claims.size }));
    for (const claimId of scene.supporting_claim_ids ?? []) if (!claims.has(String(claimId))) issues.push(issue(validator, 'ERROR', 'scene.supporting_claim_bound', `scene '${scene.id}' references supporting claim '${claimId}' outside its modules`, `${base}/supporting_claim_ids`));
  }
  return issues;
}

export function grammarCompatibilityValidator(spec, registry) {
  const validator = 'grammar_compatibility_validator';
  const issues = [];
  if (spec?.schema_version !== '1.5.0') return issues;
  if (!registry) return [issue(validator, 'FATAL', 'grammar.registry_required', 'InfographicSpec 1.5 requires the editorial grammar registry')];
  const lint = lintEditorialGrammarSelection(spec.editorial_grammar, registry);
  for (const row of lint.issues) issues.push(issue(validator, row.severity, row.rule_id, row.message, `/editorial_grammar${row.path ?? ''}`));
  const byId = new Map((registry.grammars ?? []).map((grammar) => [grammar.id, grammar]));
  const selectedIds = [spec.editorial_grammar?.primary, ...(spec.editorial_grammar?.supporting ?? [])].filter(Boolean);
  const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean);
  const goals = new Set(selected.flatMap((grammar) => grammar.cognitive_goals ?? []));
  const visualGrammars = new Set(selected.flatMap((grammar) => grammar.compatible_visual_grammars ?? []));
  const visualGrammarModes = new Set((spec.modules ?? [])
    .filter((module) => module.type === 'visual' && module.visual_grammar)
    .map((module) => String(module.visual_grammar) === 'trend' ? 'change' : String(module.visual_grammar)));
  const recommendation = editorialGrammarRecommendation(visualGrammarModes, registry);
  for (const [sceneIndex, scene] of (spec.scene_graph?.scenes ?? []).entries()) if (!goals.has(scene.primary_cognitive_goal)) issues.push(issue(validator, 'ERROR', 'grammar.cognitive_goal_incompatible', `scene goal '${scene.primary_cognitive_goal}' is unsupported by the selected editorial grammar set`, `/scene_graph/scenes/${sceneIndex}/primary_cognitive_goal`));
  for (const [moduleIndex, module] of (spec.modules ?? []).entries()) if (module.type === 'visual' && module.visual_grammar && !visualGrammars.has(module.visual_grammar)) {
    const recommendationText = recommendation
      ? `; recommended editorial grammar: primary ${recommendation.primary}, supporting ${recommendation.supporting.join(' + ') || 'none'}`
      : '';
    issues.push(issue(validator, 'ERROR', 'grammar.visual_mode_incompatible', `module visual grammar '${module.visual_grammar}' is unsupported by the selected editorial grammar set${recommendationText}`, `/modules/${moduleIndex}/visual_grammar`, recommendation ? { recommendation } : {}));
  }
  return issues;
}

function editorialGrammarRecommendation(unsupportedVisualGrammars, registry) {
  const modes = new Set(unsupportedVisualGrammars);
  if (!modes.size) return null;
  if (modes.has('spatial') && modes.has('flow') && modes.has('change')) {
    const recommendation = {
      primary: 'ROUTE_SPINE',
      supporting: ['THEN_NOW'],
      max_supporting: 2,
      reason: 'ROUTE_SPINE covers route geography and flows while THEN_NOW covers change over comparable timepoints',
    };
    if (modes.has('composition')) {
      recommendation.supporting = ['THEN_NOW', 'SPECIMEN_GRID'];
      recommendation.supporting_options = [
        ['THEN_NOW', 'SPECIMEN_GRID'],
        ['THEN_NOW', 'SCALE_TRANSLATOR'],
      ];
      recommendation.reason += '; add one composition grammar only (SPECIMEN_GRID or SCALE_TRANSLATOR)';
    }
    return recommendation;
  }
  const grammars = registry.grammars ?? [];
  const ranked = grammars.map((grammar) => ({
    grammar,
    coverage: modes.size - [...modes].filter((mode) => !(grammar.compatible_visual_grammars ?? []).includes(mode)).length,
  })).sort((a, b) => b.coverage - a.coverage || a.grammar.id.localeCompare(b.grammar.id));
  const primary = ranked[0]?.grammar;
  if (!primary || ranked[0].coverage === 0) return null;
  return {
    primary: primary.id,
    supporting: [],
    max_supporting: 2,
    reason: `primary ${primary.id} covers ${ranked[0].coverage}/${modes.size} unsupported visual grammar modes`,
  };
}

export function runEditorialValidators(spec, assets = {}, context = {}) {
  const groups = {
    annotation_target_validator: annotationTargetValidator(spec),
    visual_channel_owner_validator: visualChannelOwnerValidator(spec),
    misleading_quantitative_validator: misleadingQuantitativeValidator(spec, assets),
    scene_cognitive_budget_validator: sceneCognitiveBudgetValidator(spec),
    grammar_compatibility_validator: grammarCompatibilityValidator(spec, context.editorial_grammar_registry),
  };
  const issues = Object.values(groups).flat();
  return {
    passed: !issues.some((row) => row.severity === 'FATAL' || row.severity === 'ERROR'),
    severity_counts: Object.fromEntries(VALIDATOR_SEVERITIES.map((severity) => [severity, issues.filter((row) => row.severity === severity).length])),
    issues,
    validators: Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, { passed: !rows.some((row) => row.severity === 'FATAL' || row.severity === 'ERROR'), issues: rows }])),
  };
}
