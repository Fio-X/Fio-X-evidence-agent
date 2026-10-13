export const EDITORIAL_GRAMMAR_SCHEMA_VERSION = '0.1.0';
export const EDITORIAL_GRAMMARS = ['CUTAWAY', 'SCALE_TRANSLATOR', 'MECHANISM_FLOW', 'SPECIMEN_GRID', 'THEN_NOW', 'ROUTE_SPINE', 'THEMATIC_MAP', 'FLOW_LEDGER'];

function issue(severity, rule_id, message, path = '') {
  return { severity, rule_id, message, path };
}

// Opt-in (NEWSROOM_MAP_FLOW_SUPPORT=exactly "1", K293): a THEMATIC_MAP page may take FLOW_LEDGER as a supporting grammar. Applied here, where every
// reader gets the registry, as a copy of the one entry; the registry file and object are untouched. FLOW_LEDGER's own evidence is still required.
export function mapFlowSupportEnabled(env = process.env) { return env.NEWSROOM_MAP_FLOW_SUPPORT === '1'; }

function registryMap(registry) {
  const map = new Map((registry?.grammars ?? []).map((grammar) => [grammar.id, grammar]));
  const mapEntry = map.get('THEMATIC_MAP');
  if (mapFlowSupportEnabled() && mapEntry && map.has('FLOW_LEDGER') && !(mapEntry.compatible_supporting ?? []).includes('FLOW_LEDGER')) {
    map.set('THEMATIC_MAP', { ...mapEntry, compatible_supporting: [...(mapEntry.compatible_supporting ?? []), 'FLOW_LEDGER'] });
  }
  return map;
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

// The legal (primary, supporting) sets of a registry for the page's visual modes and scene goals: every set whose grammars together cover them.
// With `ranked` (lean gates, K261) only grammars with their own evidence and renderer may be used, as primary or supporting, and equal-size sets
// are ordered by the tighter fit (fewer declared visual modes in total) then rank; without it the registry order is the old one. The lean pick
// and the plan-time refusal both call this, so a printed combination is one the pick accepts.
function enumerateLegalSets(registry, byId, modes, goals, ranked) {
  const eligible = ranked ? new Set(ranked.filter((c) => c.hard_constraints_passed && c.renderer_capability_passed).map((c) => c.grammar)) : null;
  const order = ranked ? new Map(ranked.map((c, i) => [c.grammar, i])) : null;
  const ok = (id) => byId.has(id) && (!eligible || eligible.has(id));
  const cover = (ids) => {
    const set = ids.map((id) => byId.get(id));
    const haveModes = new Set(set.flatMap((g) => g.compatible_visual_grammars ?? []));
    const haveGoals = new Set(set.flatMap((g) => g.cognitive_goals ?? []));
    return modes.every((m) => haveModes.has(m)) && goals.every((g) => haveGoals.has(g));
  };
  const out = [];
  for (const g of byId.values()) {
    if (!ok(g.id)) continue;
    for (const sup of supportingSets((g.compatible_supporting ?? []).filter(ok))) if (cover([g.id, ...sup])) out.push({ primary: g.id, supporting: sup });
  }
  if (!ranked) return out.sort((a, b) => a.supporting.length - b.supporting.length || a.primary.localeCompare(b.primary) || a.supporting.join().localeCompare(b.supporting.join()));
  const breadth = (c) => [c.primary, ...c.supporting].reduce((sum, id) => sum + (byId.get(id).compatible_visual_grammars ?? []).length, 0);
  const key = (c) => c.supporting.map((id) => String(order.get(id)).padStart(2, '0')).join('');
  return out.sort((a, b) => a.supporting.length - b.supporting.length || breadth(a) - breadth(b) || order.get(a.primary) - order.get(b.primary) || key(a).localeCompare(key(b)));
}

// Opt-in plan preflight (NEWSROOM_GRAMMAR_COVER_PREFLIGHT=exactly "1"): the
// coverage check infographic_lint runs later, reported once at plan time with
// the legal combinations enumerated from the registry. Registry untouched.
export function grammarCoverPreflightEnabled(env = process.env) { return env.NEWSROOM_GRAMMAR_COVER_PREFLIGHT === '1'; }

// Opt-in (NEWSROOM_GRAMMAR_HINT_ELIGIBLE=exactly "1", K292): the grammar sets a refusal message recommends are only ones the page's own evidence and
// renderer allow; when none is, the message says which grammar would cover the modes and what evidence it lacks. Message text only: no decision changes.
export function grammarHintEligibleEnabled(env = process.env) { return env.NEWSROOM_GRAMMAR_HINT_ELIGIBLE === '1'; }

function rankedFor(selection, registry) {
  return rankEditorialGrammarCandidates({ evidence_features: selection?.evidence_features, cognitive_goals: selection?.cognitive_goals, available_renderer_capabilities: selection?.available_renderer_capabilities }, registry);
}

/** "ROUTE_SPINE + THEN_NOW would cover them, but ROUTE_SPINE lacks verified_locations", or a no-set text; '' when an eligible set exists. */
export function ineligibleCoverHint(modes, goals, registry, selection) {
  const byId = registryMap(registry);
  const ranked = rankedFor(selection, registry);
  if (enumerateLegalSets(registry, byId, modes, goals, ranked).length) return '';
  const all = enumerateLegalSets(registry, byId, modes, goals, null);
  if (!all.length) return `no editorial grammar set in the registry covers modes ${modes.join(', ')}`;
  const evidence = new Set(selection?.evidence_features ?? []);
  const capabilities = new Set(selection?.available_renderer_capabilities ?? []);
  const lacks = (id) => {
    const entry = byId.get(id);
    const missing = (entry.required_evidence ?? []).filter((feature) => !evidence.has(feature));
    if (!(entry.renderer_capabilities ?? []).some((capability) => capabilities.has(capability))) missing.push('a renderer');
    return missing.length ? `${id} lacks ${missing.join(', ')}` : '';
  };
  const first = all[0], ids = [first.primary, ...first.supporting];
  const why = ids.map(lacks).filter(Boolean).join('; ');
  return `${ids.join(' + ')} would cover them, but ${why}${MODEL_REPORTED_EVIDENCE.some((f) => why.includes(f)) ? ' (only the plan can report that, and only if true)' : ''}`;
}

/** The eligible { primary, supporting } the validator's recommendation may name for these visual modes (null when none), or { lacks: text }. */
export function eligibleGrammarRecommendation(modes, registry, selection) {
  const byId = registryMap(registry);
  const legal = enumerateLegalSets(registry, byId, [...modes], [], rankedFor(selection, registry));
  if (legal.length) return { primary: legal[0].primary, supporting: legal[0].supporting };
  return { lacks: ineligibleCoverHint([...modes], [], registry, selection) };
}

function supportingSets(options) {
  const sets = [[]];
  for (let i = 0; i < options.length; i += 1) {
    sets.push([options[i]]);
    for (let j = i + 1; j < options.length; j += 1) sets.push([options[i], options[j]]);
  }
  return sets;
}

export function grammarCoverPreflightIssues(spec, registry, { lean = false } = {}) {
  const issues = [];
  if (spec?.schema_version !== '1.5.0' || !registry?.grammars) return issues;
  const byId = registry ? registryMap(registry) : new Map();
  const selection = spec.editorial_grammar;
  const primary = byId.get(selection?.primary);
  if (!primary) return issues;
  for (const id of selection?.supporting ?? []) {
    if (byId.has(id) && !(primary.compatible_supporting ?? []).includes(id)) {
      issues.push(`editorial grammar ${primary.id} allows supporting: ${(primary.compatible_supporting ?? []).join(', ') || 'none'} (${id} is not one of them)`);
      break;
    }
  }
  const modes = [...new Set((spec.modules ?? []).filter((m) => m?.type === 'visual' && m.visual_grammar).map((m) => (String(m.visual_grammar) === 'trend' ? 'change' : String(m.visual_grammar))))].sort();
  const goals = [...new Set((spec.scene_graph?.scenes ?? []).map((s) => s?.primary_cognitive_goal).filter(Boolean).map(String))].sort();
  const cover = (ids) => {
    const set = ids.map((id) => byId.get(id));
    const haveModes = new Set(set.flatMap((g) => g.compatible_visual_grammars ?? []));
    const haveGoals = new Set(set.flatMap((g) => g.cognitive_goals ?? []));
    return { modes: modes.filter((m) => !haveModes.has(m)), goals: goals.filter((g) => !haveGoals.has(g)) };
  };
  const selectedIds = [selection.primary, ...(selection.supporting ?? [])].filter((id) => byId.has(id));
  const missing = cover(selectedIds);
  if (!missing.modes.length && !missing.goals.length) return issues;
  const gaps = [missing.modes.length ? `visual modes ${missing.modes.join(', ')}` : '', missing.goals.length ? `scene goals ${missing.goals.join(', ')}` : ''].filter(Boolean).join(' and ');
  // Lean (K261): only grammars the page's own evidence and renderer allow are listed, by the same enumeration the lean pick uses.
  const hint = grammarHintEligibleEnabled();
  const legal = lean || hint
    ? enumerateLegalSets(registry, byId, modes, goals, rankEditorialGrammarCandidates({ evidence_features: selection.evidence_features, cognitive_goals: selection.cognitive_goals, available_renderer_capabilities: selection.available_renderer_capabilities }, registry))
    : enumerateLegalSets(registry, byId, modes, goals, null);
  const need = [modes.length ? `modes ${modes.join(', ')}` : '', goals.length ? `goals ${goals.join(', ')}` : ''].filter(Boolean).join(' and ');
  const text = legal.length
    ? `legal combinations: ${legal.slice(0, 3).map((c) => `${c.primary}${c.supporting.length ? ` + ${c.supporting.join(' + ')}` : ''}`).join('; ')}${hint ? '; this list follows the visual modes the modules declare now (a module visual_grammar of change, trend or sequence is what makes THEN_NOW eligible), so fix any visual_grammar problem reported with it before choosing' : ''}`
    : `no primary with at most two of its supporting grammars covers ${need}; split the page or drop a mode${hint ? `; ${ineligibleCoverHint(modes, goals, registry, selection)}` : ''}`;
  issues.push(`editorial grammar coverage: the selected set leaves ${gaps} uncovered; ${text}`);
  return issues;
}

/** Lean storyboard pages (K261): the plan tool refuses a grammar set that leaves a derived scene goal or a visual mode uncovered, at plan time, with the legal combinations. null when covered. */
export function leanGrammarCoverRefusal(spec, registry) {
  const issues = grammarCoverPreflightIssues(spec, registry, { lean: true });
  return issues.length ? `Invalid editorial grammar selection: ${issues.join('; ')}` : null;
}

// ---- Lean gates (K258, NEWSROOM_LEAN_GATES=1): the model picks only primary / supporting, the program derives the rest ----------
// project_id (the story graph ref's file name), available_renderer_capabilities (svg, canvas2d always; webgl_map when a chart is a map),
// cognitive_goals (the scene graph's goals) and evidence_features (from the modules, not from what the model says about them).
// human_scale_reference is derived from a clock_dial / people_dots chart; verified_locations cannot be derived. Either one the model
// reports through reported_evidence_features is accepted and marked 模型自报 in the decision log. A grammar needs ALL its required
// evidence, so neither of the two can make one eligible on its own. The output is the full selection (candidates, scores, log).
export const GRAMMAR_VISUAL_EVIDENCE = Object.freeze({
  spatial: 'spatial_structure', flow: 'origin_destination_relation',
  change: 'comparable_timepoints', trend: 'comparable_timepoints', sequence: 'comparable_timepoints',
  rank: 'comparable_entities', benchmark: 'comparable_entities', distribution: 'comparable_entities', composition: 'comparable_entities',
  mechanism: 'process_or_causal_relation',
});
export const MODEL_REPORTED_EVIDENCE = Object.freeze(['human_scale_reference', 'verified_locations']);
const HUMAN_SCALE_CHARTS = new Set(['people_dots', 'clock_dial']);
const MAP_CHARTS = new Set(['geo_flow_map', 'cartographic_flow_map', 'choropleth']);

const sameSet = (a, b) => a.length === b.length && [...new Set(a)].every((x) => b.includes(x)) && new Set(a).size === new Set(b).size;

/** What the program knows about the page: { project_id, available_renderer_capabilities, cognitive_goals, evidence_features }. */
export function deriveEditorialGrammarFacts({ modules = [], scene_graph, chartTypes = {}, story_graph_ref } = {}) {
  const visuals = modules.filter((m) => m?.type === 'visual');
  const evidence = new Set();
  for (const m of visuals) {
    const feature = GRAMMAR_VISUAL_EVIDENCE[String(m.visual_grammar)];
    if (feature) evidence.add(feature);
    if (HUMAN_SCALE_CHARTS.has(chartTypes[String(m.id)])) evidence.add('human_scale_reference');
  }
  if (visuals.length || modules.some((m) => m?.type === 'hero_stat')) evidence.add('quantity');
  const capabilities = ['canvas2d', 'svg'];
  if (visuals.some((m) => MAP_CHARTS.has(chartTypes[String(m.id)]) || (chartTypes[String(m.id)] === undefined && m.visual_grammar === 'spatial'))) capabilities.push('webgl_map');
  const goals = [...new Set((scene_graph?.scenes ?? []).map((s) => s?.primary_cognitive_goal).filter(Boolean).map(String))].sort();
  const project_id = String(story_graph_ref ?? '').split('/').pop().replace(/\.json$/, '').slice(0, 120);
  return { project_id, available_renderer_capabilities: capabilities.sort(), cognitive_goals: goals, evidence_features: [...evidence].sort() };
}

function legalCombinations(spec, facts, registry, ranked) {
  const byId = registryMap(registry);
  const order = new Map(ranked.map((c, i) => [c.grammar, i]));
  const modes = [...new Set((spec.modules ?? []).filter((m) => m?.type === 'visual' && m.visual_grammar).map((m) => (String(m.visual_grammar) === 'trend' ? 'change' : String(m.visual_grammar))))];
  return { combos: enumerateLegalSets(registry, byId, modes, facts.cognitive_goals, ranked), order, modes };
}

/**
 * The editorial_grammar the plan stores, built from the model's primary / supporting (both optional) plus what the program derives.
 * spec: { modules, scene_graph, chartTypes, story_graph_ref }. A derived field the model also gives must equal the derived value.
 */
export function materializeLeanEditorialGrammarSelection(input, spec, registry) {
  const facts = deriveEditorialGrammarFacts(spec);
  const given = input ?? {};
  const mismatch = (field, derived) => { throw new Error(`EDITORIAL_GRAMMAR_DERIVED_FIELD: ${field} 由程序推出 (${JSON.stringify(derived)}); leave it out (lean gates)`); };
  if (given.project_id !== undefined && given.project_id !== facts.project_id) mismatch('project_id', facts.project_id);
  for (const field of ['available_renderer_capabilities', 'cognitive_goals', 'evidence_features']) {
    if (given[field] !== undefined && !sameSet(given[field], facts[field])) mismatch(field, facts[field]);
  }
  const reported = [...new Set(given.reported_evidence_features ?? [])];
  const badReport = reported.filter((f) => !MODEL_REPORTED_EVIDENCE.includes(f));
  if (badReport.length) throw new Error(`EDITORIAL_GRAMMAR_REPORTED_EVIDENCE: ${badReport.join(', ')} is derived by the program; only ${MODEL_REPORTED_EVIDENCE.join(', ')} can be reported`);
  const selfReported = reported.filter((f) => !facts.evidence_features.includes(f)).sort();
  if (!facts.cognitive_goals.length) throw new Error('EDITORIAL_GRAMMAR_GOALS_UNDERIVABLE: the scene graph has no scene, so there are no cognitive goals to derive');
  const evidence_features = [...new Set([...facts.evidence_features, ...selfReported])].sort();
  const context = { evidence_features, cognitive_goals: facts.cognitive_goals, available_renderer_capabilities: facts.available_renderer_capabilities };
  const ranked = rankEditorialGrammarCandidates(context, registry);
  const { combos, modes } = legalCombinations(spec, facts, registry, ranked);
  let { primary, supporting } = given;
  if (primary === undefined) {
    const fit = supporting === undefined ? combos : combos.filter((c) => sameSet(c.supporting, supporting));
    if (!fit.length) throw new Error(`EDITORIAL_GRAMMAR_NO_LEGAL_COMBINATION: no eligible primary${supporting === undefined ? '' : ` with supporting ${supporting.join(' + ') || 'none'}`} covers modes ${modes.join(', ') || 'none'} and goals ${facts.cognitive_goals.join(', ')}`);
    primary = fit[0].primary;
    supporting = fit[0].supporting;
  } else if (supporting === undefined) {
    supporting = combos.find((c) => c.primary === primary)?.supporting ?? [];
  }
  const ineligibleSupporting = (supporting ?? []).filter((id) => ranked.some((c) => c.grammar === id) && !ranked.some((c) => c.grammar === id && c.hard_constraints_passed && c.renderer_capability_passed));
  if (ineligibleSupporting.length) {
    const eligibleIds = ranked.filter((c) => c.hard_constraints_passed && c.renderer_capability_passed).map((c) => c.grammar);
    const legal = combos.slice(0, 3).map((c) => [c.primary, ...c.supporting].join(' + '));
    throw new Error(`EDITORIAL_GRAMMAR_SUPPORTING_INELIGIBLE: ${ineligibleSupporting.join(', ')} lacks the page's evidence or renderer; eligible grammars: ${eligibleIds.join(', ')}${legal.length ? `; legal combinations: ${legal.join('; ')}` : ''}`);
  }
  const selection = materializeEditorialGrammarSelection({ ...context, project_id: facts.project_id, primary, supporting }, registry);
  for (const feature of selfReported) {
    const grammar = (registry.grammars ?? []).find((g) => (g.required_evidence ?? []).includes(feature))?.id ?? selection.primary;
    selection.decision_log.push({ stage: 'hard_constraint', grammar, outcome: 'pass', reason_code: `模型自报:${feature}` });
  }
  return selection;
}
