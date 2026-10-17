// The image-aware review tool's guideline states the 0-100 scale and the pass rule, with the numbers read from the code that enforces them.
// Text only: no threshold, schema or score changes. Offline, source-level (no runtime tree).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { VISION_RUBRIC_FLOOR, VISION_RUBRIC_KEYS, VISION_SCORE_FLOOR, normalizeVisionCriticReport, validateVisionCriticReport, visionCriticFails } from "../runtime/pi/vision.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const start = source.indexOf('name: "newsroom_infographic_vision_critic"');
assert.ok(start > 0, "the vision critic tool is where the test expects it");
const block = source.slice(start, source.indexOf("parameters:", start));
const line = block.split("\n").find((l) => l.includes("0-100 scale"));
assert.ok(line, "a guideline states the 0-100 scale");
// the numbers come from the constants, never typed into the sentence
assert.ok(line.includes("${VISION_SCORE_FLOOR}") && line.includes("${VISION_RUBRIC_FLOOR}"), "the floors are read from vision.mjs");
assert.ok(!/\b(80|60)\b/.test(line), "no typed floor in the sentence");
const text = new Function("VISION_SCORE_FLOOR", "VISION_RUBRIC_FLOOR", `return ${line.trim().replace(/,$/, "")};`)(VISION_SCORE_FLOOR, VISION_RUBRIC_FLOOR);
assert.match(text, new RegExp(`score is at least ${VISION_SCORE_FLOOR}, every rubric item is at least ${VISION_RUBRIC_FLOOR} and no issue is a blocker`));

// the sentence is true of the code: the floors, the scale and the blocker rule
const rubric = (n) => Object.fromEntries(VISION_RUBRIC_KEYS.map((key) => [key, n]));
const report = (score, rub, severity = "warning") => ({ passed: true, score, confidence: 0.9, rubric: rub, issues: [{ severity, code: "c", viewport: "desktop", evidence: "e", recommendation: "r" }] });
assert.equal(visionCriticFails({ passed: true, score: VISION_SCORE_FLOOR, rubric: rubric(VISION_RUBRIC_FLOOR), issues: [] }), false, "exactly at the floors passes");
assert.equal(visionCriticFails({ passed: true, score: VISION_SCORE_FLOOR - 1, rubric: rubric(100), issues: [] }), true, "score below its floor fails");
assert.equal(visionCriticFails({ passed: true, score: 100, rubric: { ...rubric(100), hierarchy: VISION_RUBRIC_FLOOR - 1 }, issues: [] }), true, "one rubric item below its floor fails");
assert.equal(visionCriticFails({ passed: true, score: 100, rubric: rubric(100), issues: [{ severity: "blocker" }] }), true, "a blocker fails");
assert.equal(normalizeVisionCriticReport(report(VISION_SCORE_FLOOR, rubric(VISION_RUBRIC_FLOOR))).passed, true, "the recorded verdict agrees at the floors");
assert.equal(normalizeVisionCriticReport(report(VISION_SCORE_FLOOR - 1, rubric(100))).passed, false);
assert.equal(normalizeVisionCriticReport(report(100, { ...rubric(100), legibility: VISION_RUBRIC_FLOOR - 1 })).passed, false);
assert.deepEqual(validateVisionCriticReport(report(100, rubric(100)), []), [], "100 is on the scale");
assert.ok(validateVisionCriticReport(report(101, rubric(100)), []).length > 0, "101 is off the scale");
assert.ok(validateVisionCriticReport(report(-1, rubric(100)), []).length > 0, "-1 is off the scale");
console.log("PASS vision review text: 0-100 scale and pass rule match vision.mjs");
