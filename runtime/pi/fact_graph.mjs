export const FACT_GRAPH_SCHEMA_VERSION = '0.1.0';
export const QUANTITY_ORIGINS = ['source_extraction', 'database', 'calculation', 'measurement'];
export const VERIFICATION_RULE_ID = 'verification.source+extraction+computation+claim.v1';

function issue(severity, rule_id, message, path = '') {
  return { severity, rule_id, message, path };
}

function ids(rows) {
  return new Set((rows ?? []).map((row) => String(row?.id ?? '')).filter(Boolean));
}

export function validateFactGraph(graph) {
  const issues = [];
  const collections = ['entities', 'relations', 'quantities', 'processes', 'locations', 'time', 'scale', 'evidence', 'calculations', 'uncertainty'];
  if (graph?.schema_version !== FACT_GRAPH_SCHEMA_VERSION) issues.push(issue('FATAL', 'fact_graph.schema_version', `schema_version must be ${FACT_GRAPH_SCHEMA_VERSION}`, '/schema_version'));
  for (const name of collections) if (!Array.isArray(graph?.[name])) issues.push(issue('FATAL', 'fact_graph.collection_required', `${name} must be an array`, `/${name}`));
  if (issues.some((row) => row.severity === 'FATAL')) return { passed: false, issues };

  const evidenceIds = ids(graph.evidence);
  const calculationIds = ids(graph.calculations);
  const allFactIds = new Set(collections.flatMap((name) => name === 'evidence' || name === 'calculations' ? [] : [...ids(graph[name])]));
  const seen = new Set();
  for (const name of collections) {
    for (const [index, row] of graph[name].entries()) {
      if (!row?.id) issues.push(issue('ERROR', 'fact_graph.id_required', `${name} item requires id`, `/${name}/${index}/id`));
      else if (seen.has(row.id)) issues.push(issue('ERROR', 'fact_graph.duplicate_id', `duplicate id '${row.id}'`, `/${name}/${index}/id`));
      else seen.add(row.id);
    }
  }
  for (const [index, quantity] of graph.quantities.entries()) {
    if (!QUANTITY_ORIGINS.includes(quantity.origin)) issues.push(issue('FATAL', 'quantity.origin_forbidden', `quantity '${quantity.id ?? index}' has forbidden origin '${quantity.origin ?? ''}'`, `/quantities/${index}/origin`));
    if (quantity.origin === 'calculation' && !calculationIds.has(quantity.calculation_id)) issues.push(issue('ERROR', 'quantity.calculation_missing', `quantity '${quantity.id}' references missing calculation '${quantity.calculation_id ?? ''}'`, `/quantities/${index}/calculation_id`));
    for (const ref of quantity.evidence_ids ?? []) if (!evidenceIds.has(ref)) issues.push(issue('ERROR', 'quantity.evidence_missing', `quantity '${quantity.id}' references missing evidence '${ref}'`, `/quantities/${index}/evidence_ids`));
  }
  for (const [index, calculation] of graph.calculations.entries()) {
    for (const ref of calculation.input_fact_ids ?? []) if (!allFactIds.has(ref)) issues.push(issue('ERROR', 'calculation.input_missing', `calculation '${calculation.id}' references missing fact '${ref}'`, `/calculations/${index}/input_fact_ids`));
  }
  return { passed: !issues.some((row) => row.severity === 'FATAL' || row.severity === 'ERROR'), issues };
}

export function deriveVerification({ source_resolved, extraction_passed, computation_replayed, claim_supported }) {
  const gates = {
    source_resolved: source_resolved === true,
    extraction_passed: extraction_passed === true,
    computation_replayed: computation_replayed === true,
    claim_supported: claim_supported === true,
  };
  return {
    authority: 'system',
    ...gates,
    publishable: Object.values(gates).every(Boolean),
    rule_id: VERIFICATION_RULE_ID,
  };
}

export function validateFactSignature(signature) {
  const expected = deriveVerification(signature?.verification ?? {});
  const issues = [];
  if (signature?.verification?.authority !== 'system') issues.push(issue('FATAL', 'verification.authority', 'verification authority must be system', '/verification/authority'));
  if (signature?.verification?.publishable !== expected.publishable) issues.push(issue('FATAL', 'verification.publishable_derived', 'publishable must equal source_resolved AND extraction_passed AND computation_replayed AND claim_supported', '/verification/publishable'));
  return { passed: issues.length === 0, verification: expected, issues };
}
