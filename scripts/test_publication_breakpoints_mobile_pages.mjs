import assert from 'node:assert/strict';
import { validatePublicationSpec } from '../runtime/web/publication.mjs';

// PublicationSpec.delivery.breakpoints must shrink to exactly [1440] when the
// phone-facing mobile page is off (NEWSROOM_MOBILE_PAGES unset), and keep
// requiring at least two widths when it is on - unchanged from before the
// switch existed. See runtime/pi/newsroom.ts (mobilePagesEnabled) for the
// caller that turns the env var into this option.
function specWithBreakpoints(breakpoints) {
  return {
    schema_version: '0.1.0',
    title: 'Breakpoint fixture',
    dek: 'A minimal deterministic fixture for delivery.breakpoints validation.',
    reader_question: 'Does the fixture validate?',
    visual_thesis: 'Only delivery.breakpoints varies across these cases.',
    story_graph_ref: 'editorial/story-graphs/test.json',
    infographic_plan_ref: 'infographics/plans/test.json',
    source_note: 'Synthetic fixture; not evidence-bound.',
    delivery: { mode: 'html', self_contained: true, static_fallback: 'png', breakpoints },
    interaction: { allowed: [], replay: [] },
    modules: [
      { id: 'm1', type: 'text', story_node_ids: ['n1'], explanatory_dimension: 'context', text: 'First module.' },
      { id: 'm2', type: 'text', story_node_ids: ['n2'], explanatory_dimension: 'outcome', text: 'Second module.' },
    ],
  };
}

function breakpointErrors(breakpoints, options) {
  return validatePublicationSpec(specWithBreakpoints(breakpoints), options).filter((e) => e.includes('breakpoints'));
}

// Off: exactly [1440] is the only width that passes.
assert.deepEqual(breakpointErrors([1440], { mobilePages: false }), []);

// Off: every other set is rejected, including supersets, other single widths,
// a mobile width, and an empty array.
for (const rejected of [[1024, 1440], [1280], [390, 1440], []]) {
  const errors = breakpointErrors(rejected, { mobilePages: false });
  assert.equal(errors.length, 1, `expected exactly one breakpoints error for ${JSON.stringify(rejected)} off, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /delivery\.breakpoints must be exactly \[1440\] when mobile pages are off/);
}

// On (default; option omitted entirely, matching every pre-existing caller
// that never passed mobilePages before this switch existed): a lone [1440]
// is still rejected, exactly as before.
for (const options of [{ mobilePages: true }, {}]) {
  const errors = breakpointErrors([1440], options);
  assert.equal(errors.length, 1, `expected [1440] alone to still fail on, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /delivery\.breakpoints requires at least two widths/);
}
assert.deepEqual(breakpointErrors([390, 1440], { mobilePages: true }), []);

console.log('publication breakpoints require exactly [1440] off and at least two widths on -- PASS');
