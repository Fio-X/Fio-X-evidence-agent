#!/usr/bin/env node
// NEWSROOM_VISION_VETO_ONLY (K250, default on; only the exact "0" turns it off): the image-aware critic only vetoes. The publication gate needs a review record to exist,
// reads no model passed=true as proof, and rejects when any linked record re-derives as failing (score < 80, a rubric item < 60 or missing, a blocker,
// explicit passed=false). Set to "0", the gate reads as before. Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "vision-veto-only-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
delete process.env.NEWSROOM_VISION_VETO_ONLY;
const results = [];
const check = (name) => results.push(name);

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const tree = join(scratch, "tree");
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
stub(tree, "typebox", "export const Type = new Proxy({}, { get: () => (...a) => ({ a }) });\n");
stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const source = readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8");
writeFileSync(join(tree, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(source, { mode: "strip" }));
const mod = await import(pathToFileURL(join(tree, "runtime/pi/newsroom.test-copy.mjs")).href);
const vision = await import(pathToFileURL(join(tree, "runtime/pi/vision.mjs")).href);

const PAGE = "infographics/page.json";
const RUBRIC = Object.fromEntries(vision.VISION_RUBRIC_KEYS.map((key) => [key, 90]));
const PASS = { passed: true, score: 92, rubric: RUBRIC, issues: [] };
let seq = 0;
function investigation(critics) {
  const dir = join(scratch, `inv-${++seq}`);
  mkdirSync(join(dir, "infographics/vision-critics"), { recursive: true });
  critics.forEach((critic, i) => writeFileSync(join(dir, `infographics/vision-critics/v${i}.json`), JSON.stringify({ kind: "image_aware_model", manifest_ref: PAGE, ...critic })));
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  return dir;
}
const blocker = (critics) => { investigation(critics); return mod.__visionVetoOnlyBlockerForTest(PAGE); };

// 1. the switch: only the exact "1"
for (const value of [undefined, "1", "true", "on", "", " 0", "00", "off"]) {
  if (value === undefined) delete process.env.NEWSROOM_VISION_VETO_ONLY; else process.env.NEWSROOM_VISION_VETO_ONLY = value;
  assert.equal(vision.visionVetoOnlyEnabled(), true, `on for ${JSON.stringify(value)}`);
}
process.env.NEWSROOM_VISION_VETO_ONLY = "0";
assert.equal(vision.visionVetoOnlyEnabled(), false);
delete process.env.NEWSROOM_VISION_VETO_ONLY;
check("switch is default on; only the exact \"0\" turns it off (8 on values)");

// 2. re-derivation: the model's passed=true proves nothing, and a record without `passed` is read from its numbers
assert.equal(vision.visionCriticFails(PASS), false, "clean record");
assert.equal(vision.visionCriticFails({ score: 92, rubric: RUBRIC }), false, "passed is not read");
assert.equal(vision.visionCriticFails({ ...PASS, passed: false }), true, "explicit passed=false vetoes");
assert.equal(vision.visionCriticFails({ ...PASS, score: 80, rubric: { ...RUBRIC, typography: 50 } }), true, "hand-written passed=true, 80, one item 50");
assert.equal(vision.visionCriticFails({ ...PASS, score: 80, rubric: { ...RUBRIC, typography: 60 } }), false, "score 80 and an item at 60 are the floors, not failures");
for (const [label, record] of [["score 79.9", { ...PASS, score: 79.9 }], ["no score", { ...PASS, score: undefined }], ["string score", { ...PASS, score: "95" }], ["missing key", { ...PASS, rubric: { ...RUBRIC, legibility: undefined } }], ["no rubric", { ...PASS, rubric: undefined }], ["string item", { ...PASS, rubric: { ...RUBRIC, hierarchy: "90" } }], ["blocker", { ...PASS, issues: [{ severity: "blocker" }] }]]) {
  assert.equal(vision.visionCriticFails(record), true, `${label} fails`);
}
check("visionCriticFails: passed never read as proof; score 80 / item 60 floors; 7 failing shapes");

// 3. the gate helper reads every linked record
assert.equal(await blocker([PASS]), null, "a clean record releases nothing and blocks nothing");
assert.equal(await blocker([]), "no image-aware vision critic record", "no record: blocked");
assert.equal(await blocker([PASS, { ...PASS, score: 40 }]), "infographics/vision-critics/v1.json", "one failing of two blocks");
assert.equal(await blocker([{ ...PASS, passed: false }, PASS]), "infographics/vision-critics/v0.json", "order does not matter");
assert.equal(await blocker([{ ...PASS, manifest_ref: "infographics/other.json", score: 10 }]), "no image-aware vision critic record", "another page's record is not this page's review");
{
  const dir = investigation([PASS]);
  writeFileSync(join(dir, "infographics/vision-critics/broken.json"), "{");
  assert.equal(await mod.__visionVetoOnlyBlockerForTest(PAGE), null, "an unparsable file is skipped");
}
check("gate helper: every linked record read; none blocks; failing one blocks; other pages and broken files skipped");

// 4. wiring: the gate takes the new path only behind the switch and the original gate text stays intact
const lineage = /async function assertApprovedInfographicLineage[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
assert.ok(lineage.includes("if (visionVetoOnlyEnabled()) {") && lineage.indexOf("if (visionVetoOnlyEnabled())") < lineage.indexOf("const hasVision = await hasPassingLinkedCritic"), "new path first, behind the switch");
const without = lineage.replace(/    if \(visionVetoOnlyEnabled\(\)\) \{\n[\s\S]*?\n      return;\n    \}\n/, "");
assert.ok(!without.includes("visionVetoOnlyEnabled") && without.includes("const hasVision = await hasPassingLinkedCritic") && without.includes("linkedVisionVeto(found.ref)"), "removing the block leaves the original gate");
check("off: removing the guarded block leaves the original lineage gate unchanged");

for (const name of results) console.log(`PASS ${name}`);
console.log(`${results.length} checks passed`);
