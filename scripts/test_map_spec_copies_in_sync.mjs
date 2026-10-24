// runtime/pi/map_spec.mjs is the copy of runtime/visual/map_spec.mjs that scripts/build_browser_publication_bundle.py writes, with one import path
// rewritten. The two must stay the same apart from that rewrite, or a change made to one is silently missing from the other.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
// The rewrite the build script applies when it writes the pi copy.
const asPiCopy = (visualText) => visualText.replaceAll("../pi/basemap_registry.mjs", "./basemap_registry.mjs");
const inSync = (piText, visualText) => asPiCopy(visualText) === piText;

const pi = read("runtime/pi/map_spec.mjs");
const visual = read("runtime/visual/map_spec.mjs");
assert.ok(inSync(pi, visual), "runtime/visual/map_spec.mjs and runtime/pi/map_spec.mjs differ beyond the import path: make the same change in both");
console.log("  ok  the two map_spec.mjs copies are the same apart from the basemap_registry import path");

// The check itself must go red: one line removed from the visual copy, one character changed in it, one line added to the pi copy.
const lines = visual.split("\n");
const dropped = lines.filter((_, i) => i !== 12).join("\n");
assert.ok(!inSync(pi, dropped), "a line missing from the visual copy is caught");
assert.ok(!inSync(pi, visual.replace("scale.unit must be km", "scale.unit must be mi")), "a changed text in the visual copy is caught");
assert.ok(!inSync(`${pi}\n// extra`, visual), "an extra line in the pi copy is caught");
assert.ok(inSync(pi, visual) && asPiCopy(visual) !== visual, "the import rewrite is what separates the two copies");
console.log("  ok  the check is red for a dropped line, a changed text and an extra line");
console.log("map_spec copies in sync: PASS");
