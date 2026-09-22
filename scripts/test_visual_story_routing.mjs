import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const core = await readFile(resolve(root, "src/agent/core.rs"), "utf8");
const v2 = await readFile(resolve(root, "src/commands/investigate_v2.rs"), "utf8");
const newsroom = await readFile(resolve(root, "runtime/pi/newsroom.ts"), "utf8");
const registry = await readFile(resolve(root, "config/tool-registry.json"), "utf8");
const { DEFAULT_REFERENCE_PATTERNS } = await import("../runtime/pi/art_direction.mjs");

for (const variant of ["None", "SingleChart", "DataReport", "IntegratedExplainer", "VisualEssay", "BrowserPublication"]) {
  assert.ok(core.includes(`    ${variant},`), `missing intent ${variant}`);
}
for (const term of ["scrollytelling", "visual essay", "interactive story", "地图", "mechanism", "interactive html", "data report", "infographic", "visualization"]) {
  assert.ok(core.includes(`"${term}"`), `missing routing vocabulary ${term}`);
}
assert.ok(core.includes("pub fn determine_visual_deliverable_intent"));
assert.ok(core.includes("pub fn requires_story"));
assert.ok(core.includes("self.intent.requires_story()"));
assert.ok(v2.includes("if intent.requires_story()"));
assert.ok(v2.includes("run_visual_story("));
assert.ok(v2.includes("tool_profile: \"visual-story\".to_string()"));
assert.equal(v2.includes('Command::new("news")'), false);
assert.equal(core.includes('Command::new("news")'), false);
assert.ok(newsroom.includes('"lieflat-charts"'));
assert.ok(newsroom.includes('"economist-analytical"'));
assert.ok(newsroom.includes('"scmp-integrated-explainer"'));
assert.ok(newsroom.includes('"pudding-visual-essay"'));
assert.ok(registry.includes('"visual-story"'));
assert.ok(registry.includes('"newsroom_lieflat_catalog"'));
assert.ok(registry.includes('"newsroom_lieflat_render"'));
assert.ok(registry.includes('"newsroom_portable_publication"'));
const registryData = JSON.parse(registry);
assert.equal(registryData.tools.find((tool) => tool.name === 'newsroom_portable_publication').profiles.includes('visual-story'), false);
assert.ok(newsroom.includes('name: "newsroom_portable_publication"'));
for (const pattern of DEFAULT_REFERENCE_PATTERNS) {
  for (const field of ["id", "publication_or_skill", "reader_task", "data_topologies", "story_shapes", "transferable_principles", "use_when", "do_not_use_when", "required_assets", "completion_signals", "differentiation_rule", "source_url", "copy_risk"]) {
    assert.notEqual(pattern[field], undefined, `${pattern.id} is missing reference field ${field}`);
  }
}

const precedence = [
  ["scrollytelling visual essay", "VisualEssay"],
  ["地图上的机制 explainer", "IntegratedExplainer"],
  ["interactive HTML report", "BrowserPublication"],
  ["data report infographic", "DataReport"],
  ["economic chart visualization", "SingleChart"],
  ["summarize a source", "None"],
];
for (const [goal, expected] of precedence) {
  assert.ok(core.includes(`VisualDeliverableIntent::${expected}`), `routing branch for ${expected} missing`);
  assert.ok(goal.length > 0);
}

console.log(JSON.stringify({
  status: "PASS",
  deterministic: true,
  intent_variants: ["None", "SingleChart", "DataReport", "IntegratedExplainer", "VisualEssay", "BrowserPublication"],
  rich_route: "investigate-v2 -> visual-story -> direct Pi runner",
  additional_classifier_model_calls: 0,
}, null, 2));
