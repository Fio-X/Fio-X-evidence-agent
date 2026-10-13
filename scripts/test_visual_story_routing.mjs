import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const newsroom = await readFile(resolve(root, "runtime/pi/newsroom.ts"), "utf8");
const registry = await readFile(resolve(root, "config/tool-registry.json"), "utf8");
const { DEFAULT_REFERENCE_PATTERNS } = await import("../runtime/pi/art_direction.mjs");

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

console.log(JSON.stringify({
  status: "PASS",
  deterministic: true,
  additional_classifier_model_calls: 0,
}, null, 2));
