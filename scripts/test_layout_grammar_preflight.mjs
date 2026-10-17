import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layoutIgnoredFieldsEnabled, layoutIgnoredFieldIssues } from '../runtime/pi/infographic.mjs';
import { grammarCoverPreflightEnabled, grammarCoverPreflightIssues } from '../runtime/pi/editorial_grammar.mjs';

delete process.env.NEWSROOM_GRAMMAR_HINT_ELIGIBLE; // each arm below sets its own value; an outer "0" must not change the default arm
const registry = JSON.parse(fs.readFileSync(new URL('../config/editorial-grammar-registry.json', import.meta.url), 'utf8'));

// Switches: exactly "1".
for (const [fn, name] of [[layoutIgnoredFieldsEnabled, 'NEWSROOM_LAYOUT_IGNORED_FIELDS'], [grammarCoverPreflightEnabled, 'NEWSROOM_GRAMMAR_COVER_PREFLIGHT']]) {
  assert.equal(fn({}), false);
  for (const v of ['', '0', 'true', 'yes', ' 1', '11']) assert.equal(fn({ [name]: v }), false, `${name}=${v}`);
  assert.equal(fn({ [name]: '1' }), true);
}

// K223
const scene = (pattern, anchor, sides) => ({ schema_version: '1.5.0', scene_graph: { scenes: [{ id: 's_use', pattern, anchor_module_id: anchor, sidecar_module_ids: sides }] } });
const mods = (over = {}) => [{ id: 'm_sankey', type: 'visual', span: 'full', visual_grammar: 'flow', ...over.sankey }, { id: 'm_homes', type: 'hero_stat', span: 'third', ...over.homes }];
{
  const spec = { ...scene('hero_with_rail', 'm_sankey', ['m_homes']), modules: mods({ homes: { span: 'half', tone: 'accent' }, sankey: { heading: 'x' } }) };
  const out = layoutIgnoredFieldIssues(spec);
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.match(out[1], /m_homes.*span 'half' is ignored.*12 of 12.*hero_sidecar_stack/);
  assert.match(out[0], /m_sankey. heading is not drawn/);
}
{ // hero_stat tone is honoured; default full span and matching spans are silent; non-members are silent
  const spec = { ...scene('hero_with_rail', 'm_sankey', ['m_homes']), modules: mods({ homes: { span: 'full', tone: 'dark' } }) };
  assert.deepEqual(layoutIgnoredFieldIssues(spec), []);
  const two = { ...scene('hero_with_rail', 'm_sankey', ['m_homes', 'm_b']), modules: [...mods({ homes: { span: 'half' } }), { id: 'm_b', type: 'text', span: 'half' }] };
  assert.deepEqual(layoutIgnoredFieldIssues(two), []);
  assert.deepEqual(layoutIgnoredFieldIssues({ schema_version: '1.5.0', modules: [{ id: 'x', type: 'text', span: 'half' }] }), []);
}
{ const t = { ...scene('hero_sidecar_stack', 'm_sankey', ['m_homes']), modules: mods({ homes: { type: 'text', span: 'third', tone: 'light' } }) };
  const out = layoutIgnoredFieldIssues(t);
  assert.equal(out.length, 1); assert.match(out[0], /tone only applies to hero_stat/); }
assert.deepEqual(layoutIgnoredFieldIssues(null), []);

// K222
const g15 = (primary, supporting, modules, goals = []) => ({ schema_version: '1.5.0', editorial_grammar: { primary, supporting }, modules, scene_graph: { scenes: goals.map((g, i) => ({ id: `s${i}`, primary_cognitive_goal: g })) } });
const vis = (...modes) => modes.map((m, i) => ({ id: `v${i}`, type: 'visual', visual_grammar: m }));
{ // the run-1 case: flow + spatial under FLOW_LEDGER + SPECIMEN_GRID
  const out = grammarCoverPreflightIssues(g15('FLOW_LEDGER', ['SPECIMEN_GRID'], vis('flow', 'spatial')), registry);
  assert.equal(out.length, 1, JSON.stringify(out));
  // NEWSROOM_GRAMMAR_HINT_ELIGIBLE on unless exactly "0": the default message names only grammars the page's own evidence allows; with "0" it is the old text
  assert.match(out[0], /^editorial grammar coverage: the selected set leaves visual modes spatial uncovered; no primary with at most two of its supporting grammars covers modes flow, spatial; split the page or drop a mode; ROUTE_SPINE would cover them, but ROUTE_SPINE lacks /);
  process.env.NEWSROOM_GRAMMAR_HINT_ELIGIBLE = '0';
  try {
    const old = grammarCoverPreflightIssues(g15('FLOW_LEDGER', ['SPECIMEN_GRID'], vis('flow', 'spatial')), registry);
    assert.equal(old.length, 1, JSON.stringify(old));
    assert.match(old[0], /^editorial grammar coverage: .*visual modes spatial uncovered; legal combinations: ROUTE_SPINE/);
  } finally { delete process.env.NEWSROOM_GRAMMAR_HINT_ELIGIBLE; }
}
{ const out = grammarCoverPreflightIssues(g15('THEMATIC_MAP', ['ROUTE_SPINE'], vis('spatial')), registry);
  assert.equal(out.length, 1); assert.match(out[0], /^editorial grammar THEMATIC_MAP allows supporting: SCALE_TRANSLATOR, THEN_NOW, SPECIMEN_GRID \(ROUTE_SPINE is not one of them\)/); }
{ // trend counts as change; covered set is silent; the registry is not modified
  const before = JSON.stringify(registry);
  assert.deepEqual(grammarCoverPreflightIssues(g15('ROUTE_SPINE', ['THEN_NOW'], vis('flow', 'spatial', 'trend')), registry), []);
  assert.equal(JSON.stringify(registry), before);
}
{ // nothing covers it: says so
  const out = grammarCoverPreflightIssues(g15('CUTAWAY', [], vis('network', 'flow', 'spatial', 'mechanism', 'uncertainty', 'sequence', 'anomaly', 'relationship')), registry);
  assert.equal(out.length, 1); assert.match(out[0], /no primary with at most two of its supporting grammars covers modes/);
}
{ const out = grammarCoverPreflightIssues(g15('CUTAWAY', [], vis('rank'), ['CONSEQUENCE']), registry);
  assert.equal(out.length, 1); assert.match(out[0], /scene goals CONSEQUENCE/); }
// Other schema versions and missing registry or primary: silent.
assert.deepEqual(grammarCoverPreflightIssues({ ...g15('CUTAWAY', [], vis('spatial')), schema_version: '1.4.0' }, registry), []);
assert.deepEqual(grammarCoverPreflightIssues(g15('CUTAWAY', [], vis('spatial')), null), []);
assert.deepEqual(grammarCoverPreflightIssues(g15('NOPE', [], vis('spatial')), registry), []);
console.log('layout/grammar preflight tests ok');
