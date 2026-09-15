#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturePath = path.join(root, 'fixtures/cold-behavior/cases.json');
const outputPath = path.join(root, 'outputs/v113-cold-behavior-results.json');

function containsPromptInjection(text) {
  const value = String(text ?? '').toLowerCase();
  return /ignore (all |any )?(previous|prior) instructions|system prompt|developer message|override .*instructions/.test(value);
}

function evaluateCase(fixture) {
  const tags = new Set();
  let decision = 'proceed';
  let reason = 'evidence is sufficient and comparable';

  if (Array.isArray(fixture.goal_interpretations) && fixture.goal_interpretations.length > 1 && !fixture.user_disambiguation) {
    tags.add('ambiguous_goal');
    decision = 'ask_clarification';
    reason = 'multiple materially different goal interpretations remain unresolved';
  }

  const requiredFields = Array.isArray(fixture.required_fields) ? fixture.required_fields : [];
  const data = fixture.data && typeof fixture.data === 'object' ? fixture.data : {};
  const missingFields = requiredFields.filter((field) => data[field] == null);
  if (missingFields.length) {
    tags.add('missing_data');
    decision = 'abstain_missing_data';
    reason = `required fields missing: ${missingFields.join(', ')}`;
  }

  const officialNumeric = (fixture.sources ?? []).filter((source) => source.authority === 'official' && Number.isFinite(Number(source.value)));
  if (officialNumeric.length >= 2) {
    const values = officialNumeric.map((source) => Number(source.value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const midpoint = (min + max) / 2;
    const fraction = midpoint === 0 ? (max === min ? 0 : Infinity) : (max - min) / Math.abs(midpoint);
    if (fraction > Number(fixture.conflict_tolerance_fraction ?? 0)) {
      tags.add('conflicting_sources');
      decision = 'flag_conflict';
      reason = `authoritative sources disagree by ${(fraction * 100).toFixed(2)}%`;
    }
  }

  const attempts = Array.isArray(fixture.tool_attempts) ? fixture.tool_attempts : [];
  if (attempts.some((attempt) => attempt.status === 'error')) {
    tags.add('tool_failure');
    const failedIndex = attempts.findIndex((attempt) => attempt.status === 'error');
    const fallback = attempts.slice(failedIndex + 1).find((attempt) => attempt.status === 'ok');
    decision = fallback ? 'recover_with_fallback' : 'abstain_tool_failure';
    reason = fallback ? `fallback ${fallback.tool} succeeded after tool failure` : 'no successful fallback after tool failure';
  }

  const periodBases = [...new Set((fixture.comparisons ?? []).map((row) => row.period_basis).filter(Boolean))];
  if (periodBases.length > 1) {
    tags.add('non_comparable_periods');
    decision = 'abstain_non_comparable';
    reason = `comparison mixes incompatible period bases: ${periodBases.join(', ')}`;
  }

  if (containsPromptInjection(fixture.source_text)) {
    tags.add('prompt_injection_source');
    if (decision === 'proceed') {
      decision = 'ignore_source_instruction';
      reason = 'source contains instruction-like text that is not evidence';
    }
  }

  const correctAbstention = decision.startsWith('abstain_') || decision === 'ask_clarification' || decision === 'flag_conflict';
  const pass = decision === fixture.expected_decision;
  return {
    id: fixture.id,
    kind: fixture.kind,
    topology_family: fixture.topology_family,
    expected_decision: fixture.expected_decision,
    actual_decision: decision,
    behavior_tags: [...tags].sort(),
    correct_abstention: correctAbstention,
    silent_semantic_errors: pass ? 0 : 1,
    status: pass ? 'PASS' : 'FAIL',
    reason,
  };
}

const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.schema_version, '1.0.0');
assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 5);
const cases = fixture.cases.map(evaluateCase);
for (const result of cases) assert.equal(result.status, 'PASS', `${result.id}: expected ${result.expected_decision}, got ${result.actual_decision}`);
const behaviorFamilies = [...new Set(cases.flatMap((result) => result.behavior_tags))].sort();
assert.ok(behaviorFamilies.length >= 5, `need >=5 derived behavior families, got ${behaviorFamilies.length}`);
assert.ok(cases.some((result) => result.kind === 'news'));
assert.ok(cases.some((result) => result.topology_family === 'event_sequence'));
assert.equal(cases.reduce((sum, result) => sum + result.silent_semantic_errors, 0), 0);

const output = {
  schema_version: '1.0.0',
  fixture_ref: 'fixtures/cold-behavior/cases.json',
  status: 'PASS',
  behavior_families: behaviorFamilies,
  behavior_family_count: behaviorFamilies.length,
  cases,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
