export const EDITORIAL_GRAMMAR_SCHEMA_VERSION = '0.1.0';
export const EDITORIAL_GRAMMARS = ['CUTAWAY', 'SCALE_TRANSLATOR', 'MECHANISM_FLOW', 'SPECIMEN_GRID', 'THEN_NOW', 'ROUTE_SPINE'];

function issue(severity, rule_id, message, path = '') {
  return { severity, rule_id, message, path };
}

function registryMap(registry) {
  return new Map((registry?.grammars ?? []).map((grammar) => [grammar.id, grammar]));
}

export function lintEditorialGrammarSelection(selection, registry) {
  const issues = [];
  const grammars = registryMap(registry);
  const supporting = selection?.supporting ?? [];
  const candidates = selection?.candidates ?? [];
  const capabilities = new Set(selection?.available_renderer_capabilities ?? []);
  const evidence = new Set(selection?.evidence_features ?? []);
  const goals = new Set(selection?.cognitive_goals ?? []);
  if (selection?.schema_version !== EDITORIAL_GRAMMAR_SCHEMA_VERSION) issues.push(issue('FATAL', 'grammar.schema_version', `schema_version must be ${EDITORIAL_GRAMMAR_SCHEMA_VERSION}`, '/schema_version'));
  if (!grammars.has(selection?.primary)) issues.push(issue('FATAL', 'grammar.primary_unknown', `unknown primary grammar '${selection?.primary ?? ''}'`, '/primary'));
  if (supporting.length > 2) issues.push(issue('FATAL', 'grammar.supporting_limit', 'supporting editorial grammars must contain at most two items', '/supporting'));
  if (new Set(supporting).size !== supporting.length) issues.push(issue('ERROR', 'grammar.supporting_unique', 'supporting editorial grammars must be unique', '/supporting'));
  if (supporting.includes(selection?.primary)) issues.push(issue('ERROR', 'grammar.primary_supporting_distinct', 'primary grammar cannot also be supporting', '/supporting'));
  const primary = grammars.get(selection?.primary);
  for (const [index, grammarId] of supporting.entries()) {
    if (!grammars.has(grammarId)) issues.push(issue('ERROR', 'grammar.supporting_unknown', `unknown supporting grammar '${grammarId}'`, `/supporting/${index}`));
    else if (primary && !(primary.compatible_supporting ?? []).includes(grammarId)) issues.push(issue('ERROR', 'grammar.incompatible_supporting', `${grammarId} is incompatible with primary ${selection.primary}`, `/supporting/${index}`));
  }
  if (candidates.length !== 3) issues.push(issue('FATAL', 'grammar.candidate_count', 'exactly three editorial grammar candidates are required', '/candidates'));
  const candidateIds = candidates.map((candidate) => candidate?.grammar);
  if (new Set(candidateIds).size !== candidateIds.length) issues.push(issue('ERROR', 'grammar.candidate_unique', 'candidate grammars must be unique', '/candidates'));
  const selectedCandidate = candidates.find((candidate) => candidate?.grammar === selection?.selected);
  if (!selectedCandidate) issues.push(issue('FATAL', 'grammar.selection_not_candidate', 'selected grammar must be one of the three candidates', '/selected'));
  else {
    const selectedEntry = grammars.get(selectedCandidate.grammar);
    const selectedHardPass = (selectedEntry?.required_evidence ?? []).every((feature) => evidence.has(feature));
    const selectedRendererPass = (selectedEntry?.renderer_capabilities ?? []).some((capability) => capabilities.has(capability));
    if (!selectedHardPass) issues.push(issue('FATAL', 'grammar.hard_constraint_failed', `selected grammar ${selection.selected} failed a hard constraint`, '/selected'));
    if (!selectedRendererPass) issues.push(issue('FATAL', 'grammar.renderer_unavailable', `selected grammar ${selection.selected} has no available renderer`, '/selected'));
  }
  if (selection?.selected !== selection?.primary) issues.push(issue('ERROR', 'grammar.selected_primary_mismatch', 'selected grammar must equal project primary grammar', '/selected'));
  for (const [index, candidate] of candidates.entries()) {
    const entry = grammars.get(candidate?.grammar);
    if (!entry) continue;
    const required = entry.required_evidence ?? [];
    const evidenceMatches = required.filter((feature) => evidence.has(feature)).length;
    const computedHardPass = required.every((feature) => evidence.has(feature));
    const computedRendererPass = (entry.renderer_capabilities ?? []).some((capability) => capabilities.has(capability));
    const goalMatches = (entry.cognitive_goals ?? []).filter((goal) => goals.has(goal)).length;
    const evidenceScore = required.length ? evidenceMatches / required.length : 1;
    const goalScore = goals.size ? goalMatches / goals.size : 0;
    const computedSoftScore = Number((evidenceScore * 0.7 + Math.min(1, goalScore) * 0.3).toFixed(4));
    if (candidate.hard_constraints_passed !== computedHardPass) issues.push(issue('ERROR', 'grammar.hard_constraint_result_mismatch', `candidate ${candidate.grammar} hard-constraint result does not match evidence features`, `/candidates/${index}/hard_constraints_passed`));
    if (candidate.renderer_capability_passed !== computedRendererPass) issues.push(issue('ERROR', 'grammar.renderer_result_mismatch', `candidate ${candidate.grammar} renderer result does not match available capabilities`, `/candidates/${index}/renderer_capability_passed`));
    if (Math.abs(Number(candidate.soft_score) - computedSoftScore) > 0.0001) issues.push(issue('ERROR', 'grammar.soft_score_mismatch', `candidate ${candidate.grammar} soft score does not match deterministic ranking`, `/candidates/${index}/soft_score`));
  }
  const selectedLog = (selection?.decision_log ?? []).some((row) => row.stage === 'final_selection' && row.grammar === selection?.selected && row.outcome === 'select');
  if (!selectedLog) issues.push(issue('ERROR', 'grammar.decision_log_missing', 'decision log must record the final selection', '/decision_log'));
  return { passed: !issues.some((row) => row.severity === 'FATAL' || row.severity === 'ERROR'), issues };
}

export function rankEditorialGrammarCandidates({ evidence_features = [], cognitive_goals = [], available_renderer_capabilities = [] }, registry) {
  const evidence = new Set(evidence_features);
  const goals = new Set(cognitive_goals);
  const capabilities = new Set(available_renderer_capabilities);
  return (registry?.grammars ?? []).map((grammar) => {
    const required = grammar.required_evidence ?? [];
    const evidenceMatches = required.filter((feature) => evidence.has(feature)).length;
    const hard_constraints_passed = required.every((feature) => evidence.has(feature));
    const renderer_capability_passed = (grammar.renderer_capabilities ?? []).some((capability) => capabilities.has(capability));
    const goalMatches = (grammar.cognitive_goals ?? []).filter((goal) => goals.has(goal)).length;
    const evidenceScore = required.length ? evidenceMatches / required.length : 1;
    const goalScore = goals.size ? goalMatches / goals.size : 0;
    const soft_score = Number((evidenceScore * 0.7 + Math.min(1, goalScore) * 0.3).toFixed(4));
    const reason_codes = [hard_constraints_passed ? 'evidence_requirements_met' : 'evidence_requirements_missing', renderer_capability_passed ? 'renderer_available' : 'renderer_unavailable', goalMatches ? 'cognitive_goal_match' : 'no_cognitive_goal_match'];
    return { grammar: grammar.id, hard_constraints_passed, renderer_capability_passed, soft_score, reason_codes };
  }).sort((a, b) => Number(b.hard_constraints_passed) - Number(a.hard_constraints_passed) || Number(b.renderer_capability_passed) - Number(a.renderer_capability_passed) || b.soft_score - a.soft_score || a.grammar.localeCompare(b.grammar));
}

export function selectEditorialGrammar(context, registry) {
  const eligible = rankEditorialGrammarCandidates(context, registry).filter((candidate) => candidate.hard_constraints_passed && candidate.renderer_capability_passed);
  if (eligible.length < 3) throw new Error('EDITORIAL_GRAMMAR_CANDIDATES_INSUFFICIENT: fewer than three candidates pass hard constraints and renderer capability filtering');
  const candidates = eligible.slice(0, 3);
  return { candidates, selected: candidates[0].grammar };
}

export function materializeEditorialGrammarSelection(input, registry) {
  const knownEvidence = new Set((registry?.grammars ?? []).flatMap((grammar) => grammar.required_evidence ?? []));
  const unknownEvidence = (input?.evidence_features ?? []).filter((feature) => !knownEvidence.has(feature));
  if (unknownEvidence.length) {
    throw new Error(`EDITORIAL_GRAMMAR_EVIDENCE_FEATURE_UNKNOWN: ${unknownEvidence.join(', ')}; allowed: ${[...knownEvidence].sort().join(', ')}`);
  }
  const context = {
    evidence_features: input?.evidence_features ?? [],
    cognitive_goals: input?.cognitive_goals ?? [],
    available_renderer_capabilities: input?.available_renderer_capabilities ?? [],
  };
  const ranked = rankEditorialGrammarCandidates(context, registry);
  const eligible = ranked.filter((candidate) => candidate.hard_constraints_passed && candidate.renderer_capability_passed);
  const requested = eligible.find((candidate) => candidate.grammar === input?.primary);
  if (!requested) {
    const known = ranked.find((candidate) => candidate.grammar === input?.primary);
    const reason = known
      ? `hard_constraints_passed=${known.hard_constraints_passed}, renderer_capability_passed=${known.renderer_capability_passed}`
      : 'unknown grammar';
    throw new Error(`EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE: ${input?.primary ?? ''} (${reason})`);
  }
  const candidates = [requested, ...ranked.filter((candidate) => candidate.grammar !== requested.grammar)].slice(0, 3);
  if (candidates.length < 3) throw new Error('EDITORIAL_GRAMMAR_CANDIDATES_INSUFFICIENT: registry contains fewer than three candidates');
  return {
    schema_version: EDITORIAL_GRAMMAR_SCHEMA_VERSION,
    project_id: input.project_id,
    primary: requested.grammar,
    supporting: input.supporting ?? [],
    ...context,
    candidates,
    selected: requested.grammar,
    decision_log: [
      ...candidates.map((candidate) => ({
        stage: candidate.hard_constraints_passed ? 'renderer_capability' : 'hard_constraint',
        grammar: candidate.grammar,
        outcome: candidate.hard_constraints_passed && candidate.renderer_capability_passed ? 'pass' : 'reject',
        reason_code: candidate.hard_constraints_passed
          ? (candidate.renderer_capability_passed ? 'system_verified_evidence_and_renderer' : 'renderer_unavailable')
          : 'required_evidence_missing',
      })),
      { stage: 'final_selection', grammar: requested.grammar, outcome: 'select', reason_code: 'eligible_editorial_primary' },
    ],
  };
}
