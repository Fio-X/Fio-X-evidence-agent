#!/usr/bin/env node
// NEWSROOM_VISION_VETO_REPORT_ONLY (default off; only the exact "1" turns it on): the image-aware vision veto (failed record, score below 80, rubric floor, blocker,
// no record) stops blocking newsroom_publication_plan's lineage gate and is returned for the report instead. Every other lineage refusal (no manifest, no passing
// program critic) is identical on and off, and off the gate is the one it was. Loads a type-stripped copy of runtime/pi/newsroom.ts in which only the
// lint-currency lookup is stubbed out (it needs a full render fixture and is not a vision gate). No provider, no network.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "vision-veto-report-only-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of ["NEWSROOM_VISION_VETO_REPORT_ONLY", "NEWSROOM_VISION_VETO_ONLY", "NEWSROOM_MODEL_PASS_SELFREPORT"]) delete process.env[name];
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
const stripped = stripTypeScriptTypes(source, { mode: "strip" });
assert.ok(stripped.includes("await assertPageLintCurrent(found.manifest);"), "lint stub target present");
writeFileSync(join(tree, "runtime/pi/newsroom.test-copy.mjs"), stripped.replace("await assertPageLintCurrent(found.manifest);", "/* lint lookup stubbed in this test */"));
const mod = await import(pathToFileURL(join(tree, "runtime/pi/newsroom.test-copy.mjs")).href);
const vision = await import(pathToFileURL(join(tree, "runtime/pi/vision.mjs")).href);

const PAGE = "infographics/page.json";
const PLAN = "infographics/plans/plan.json";
const RUBRIC = Object.fromEntries(vision.VISION_RUBRIC_KEYS.map((key) => [key, 90]));
const PASS = { passed: true, score: 92, rubric: RUBRIC, issues: [] };
let seq = 0;
// An artifact tree holding one top-level page bound to PLAN, an optional program critic and the given vision records.
function investigation({ programCritic = true, vision: records = [], manifest = {} } = {}) {
  const dir = join(scratch, `inv-${++seq}`);
  for (const sub of ["infographics/vision-critics", "infographics/critics", "infographics/plans"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, PAGE), JSON.stringify({ plan_ref: PLAN, visual_review_required: true, ...manifest }));
  if (programCritic !== null) writeFileSync(join(dir, "infographics/critics/c.json"), JSON.stringify({ manifest_ref: PAGE, passed: programCritic }));
  records.forEach((record, i) => writeFileSync(join(dir, `infographics/vision-critics/v${i}.json`), JSON.stringify({ kind: "image_aware_model", manifest_ref: PAGE, ...record })));
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
}
const run = async (switchValue, env = {}) => {
  for (const name of ["NEWSROOM_VISION_VETO_ONLY", "NEWSROOM_MODEL_PASS_SELFREPORT"]) delete process.env[name];
  Object.assign(process.env, env);
  if (switchValue === undefined) delete process.env.NEWSROOM_VISION_VETO_REPORT_ONLY; else process.env.NEWSROOM_VISION_VETO_REPORT_ONLY = switchValue;
  let reported = null;
  try {
    await mod.__assertApprovedInfographicLineageForTest(PLAN, (report) => { reported = report; });
    return { threw: null, reported };
  } catch (error) {
    return { threw: String(error.message), reported };
  } finally {
    for (const name of ["NEWSROOM_VISION_VETO_ONLY", "NEWSROOM_MODEL_PASS_SELFREPORT"]) delete process.env[name];
  }
};

// 1. the switch: only the exact "1"
for (const value of [undefined, "0", "true", "on", "", " 1", "11", "yes"]) {
  if (value === undefined) delete process.env.NEWSROOM_VISION_VETO_REPORT_ONLY; else process.env.NEWSROOM_VISION_VETO_REPORT_ONLY = value;
  assert.equal(vision.visionVetoReportOnlyEnabled(), false, `off for ${JSON.stringify(value)}`);
}
process.env.NEWSROOM_VISION_VETO_REPORT_ONLY = "1";
assert.equal(vision.visionVetoReportOnlyEnabled(), true);
delete process.env.NEWSROOM_VISION_VETO_REPORT_ONLY;
check("switch is default off; only the exact \"1\" turns it on (8 off values)");

// 2. reasons mirror visionCriticFails
for (const [label, record, reason] of [["passed false", { ...PASS, passed: false }, "passed_false"], ["score 79", { ...PASS, score: 79 }, "score_below_80"], ["no score", { ...PASS, score: undefined }, "score_missing"], ["item 50", { ...PASS, rubric: { ...RUBRIC, typography: 50 } }, "rubric_typography_below_60"], ["missing key", { ...PASS, rubric: { ...RUBRIC, legibility: undefined } }, "rubric_legibility_missing"], ["blocker", { ...PASS, issues: [{ severity: "blocker" }] }, "blocker_issue"]]) {
  assert.ok(vision.visionCriticReasons(record).includes(reason), label);
  assert.equal(vision.visionCriticFails(record), true, `${label} fails`);
}
assert.deepEqual(vision.visionCriticReasons(PASS), []);
check("visionCriticReasons names every veto reason and is empty for a clean record");

// 3. a vision-vetoed page: off refuses as before, on publishes and reports score and reasons
const VETOED = [{ ...PASS, score: 70, rubric: { ...RUBRIC, typography: 50 } }];
for (const [label, setup] of [["low score", { vision: VETOED }], ["passed false", { vision: [{ ...PASS, passed: false }] }], ["blocker", { vision: [{ ...PASS, issues: [{ severity: "blocker" }] }] }], ["no record", { vision: [] }], ["one failing of two", { vision: [PASS, { ...PASS, score: 40 }] }]]) {
  investigation(setup);
  const off = await run(undefined);
  assert.match(off.threw ?? "", /Publication blocked: infographic .* image-aware review \(NEWSROOM_VISION_VETO_ONLY\)/, `${label}: off refuses`);
  assert.equal(off.reported, null);
  assert.equal((await run("0")).threw, off.threw, `${label}: "0" is off`);
  const on = await run("1");
  assert.equal(on.threw, null, `${label}: on does not block`);
  assert.equal(on.reported.would_have_blocked, true);
  assert.equal(on.reported.manifest_ref, PAGE);
  assert.ok(on.reported.gate_message && on.reported.gate_message.length > 0);
  assert.equal(on.reported.records.length, setup.vision.length);
}
investigation({ vision: VETOED });
const detail = (await run("1")).reported;
assert.deepEqual(detail.records.map((r) => [r.ref, r.score, r.passed]), [["infographics/vision-critics/v0.json", 70, true]]);
assert.deepEqual(detail.records[0].reasons, ["score_below_80", "rubric_typography_below_60"]);
const lines = mod.__visionVetoLinesForTest(detail);
assert.ok(lines.includes("score=70") && lines.includes("score_below_80,rubric_typography_below_60") && lines.includes("infographics/vision-critics/v0.json"), lines);
assert.equal(mod.__visionVetoLinesForTest(null), "");
check("vetoed page (5 shapes): off and \"0\" refuse with the old text; on publishes and returns critic path, score and reasons");

// 4. a clean page: same silent pass on and off; the report says nothing would have blocked
investigation({ vision: [PASS] });
assert.deepEqual(await run(undefined), { threw: null, reported: null });
const clean = await run("1");
assert.equal(clean.threw, null);
assert.equal(clean.reported.would_have_blocked, false);
assert.equal(mod.__visionVetoLinesForTest(clean.reported), "", "nothing to report for a clean page");
check("clean page: passes on and off, on reports would_have_blocked=false and no veto text");

// 5. the older gate paths (VETO_ONLY=0, MODEL_PASS_SELFREPORT) report too
investigation({ vision: [{ ...PASS, passed: false }] });
assert.match((await run(undefined, { NEWSROOM_VISION_VETO_ONLY: "0" })).threw ?? "", /has no passing image-aware vision critic/);
assert.equal((await run("1", { NEWSROOM_VISION_VETO_ONLY: "0" })).reported.would_have_blocked, true);
investigation({ vision: [PASS, { ...PASS, score: 10 }] });
assert.match((await run(undefined, { NEWSROOM_VISION_VETO_ONLY: "0", NEWSROOM_MODEL_PASS_SELFREPORT: "1" })).threw ?? "", /was vetoed by image-aware vision critic/);
const legacy = await run("1", { NEWSROOM_VISION_VETO_ONLY: "0", NEWSROOM_MODEL_PASS_SELFREPORT: "1" });
assert.equal(legacy.threw, null);
assert.match(legacy.reported.gate_message, /v1\.json vetoed/);
check("VETO_ONLY=0 and MODEL_PASS_SELFREPORT paths: refused when off, reported when on");

// 6. every non-vision refusal is identical on and off, including when the vision record would also veto
const nonVision = [
  ["failed program critic", { programCritic: false, vision: [PASS] }],
  ["no program critic", { programCritic: null, vision: [PASS] }],
  ["failed program critic and vetoed vision", { programCritic: false, vision: VETOED }],
  ["no program critic and no vision record", { programCritic: null, vision: [] }],
];
for (const [label, setup] of nonVision) {
  investigation(setup);
  const off = await run(undefined);
  const on = await run("1");
  assert.ok(off.threw && /has no passing critic/.test(off.threw), `${label}: refused (${off.threw})`);
  assert.equal(on.threw, off.threw, `${label}: same refusal with the switch on`);
  assert.equal(on.reported, null, `${label}: never reaches the vision report`);
}
// no manifest bound to the plan at all
investigation({ manifest: { plan_ref: "infographics/plans/other.json" }, vision: VETOED });
const noManifestOff = await run(undefined);
assert.match(noManifestOff.threw ?? "", /no top-level, non-rejected infographic manifest/);
assert.equal((await run("1")).threw, noManifestOff.threw);
check("non-vision refusals (no manifest, failed/missing program critic) are identical on and off, vision verdict or not");

// 7a. the embedded-page lookup (resolveEmbeddedPage) runs the same lineage check and reports through its own callback
const KEY = "ab".repeat(32);
const EMBED_PAGE = `infographics/${KEY}.json`;
const EMBED_ASSET = `infographics/${KEY}.svg`;
function embeddedInvestigation(records) {
  const dir = join(scratch, `inv-${++seq}`);
  for (const sub of ["infographics/vision-critics", "infographics/critics", "infographics/plans"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, EMBED_PAGE), JSON.stringify({ plan_ref: PLAN, visual_review_required: true, variants: { desktop: EMBED_ASSET }, claim_ids: ["c1"] }));
  writeFileSync(join(dir, "infographics/critics/c.json"), JSON.stringify({ manifest_ref: EMBED_PAGE, passed: true }));
  records.forEach((record, i) => writeFileSync(join(dir, `infographics/vision-critics/v${i}.json`), JSON.stringify({ kind: "image_aware_model", manifest_ref: EMBED_PAGE, ...record })));
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
}
const embedded = async (switchValue) => {
  if (switchValue === undefined) delete process.env.NEWSROOM_VISION_VETO_REPORT_ONLY; else process.env.NEWSROOM_VISION_VETO_REPORT_ONLY = switchValue;
  let reported = null;
  try {
    const page = await mod.__resolveEmbeddedPageForTest(EMBED_ASSET, PLAN, (report) => { reported = report; });
    return { threw: null, reported, page };
  } catch (error) {
    return { threw: String(error.message), reported };
  }
};
embeddedInvestigation(VETOED);
const embOff = await embedded(undefined);
assert.match(embOff.threw ?? "", /Publication blocked: infographic .* image-aware review/);
assert.equal(embOff.reported, null);
const embOn = await embedded("1");
assert.equal(embOn.threw, null, "on: the embedded page resolves");
assert.deepEqual(embOn.page, { manifestRef: EMBED_PAGE, claimIds: ["c1"] });
assert.equal(embOn.reported.would_have_blocked, true);
assert.equal(embOn.reported.manifest_ref, EMBED_PAGE);
embeddedInvestigation([]);
assert.equal((await embedded("1")).reported.would_have_blocked, true, "no vision record also reported");
embeddedInvestigation([PASS]);
assert.equal((await embedded("1")).reported.would_have_blocked, false);
assert.equal((await embedded(undefined)).threw, null);
const callers = [...source.matchAll(/await resolveEmbeddedPage\([^\n]*\);/g)].map((x) => x[0]);
assert.equal(callers.length, 2, "two call sites");
assert.ok(callers.every((line) => line.includes("(report) => { visionVeto = report; }")), "both call sites pass the report callback");
check("embedded page lookup: off refuses as before; on resolves and returns the report through its callback (vetoed, no record, clean)");

// 7. wiring: the report-only branch sits inside the vision-review block, ahead of the original gate, and the original gate text is intact
const lineage = /async function assertApprovedInfographicLineage[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
assert.ok(lineage.includes("if (visionVetoReportOnlyEnabled()) {") && lineage.indexOf("visionVetoReportOnlyEnabled") > lineage.indexOf("visual_review_required === true") && lineage.indexOf("visionVetoReportOnlyEnabled") < lineage.indexOf("if (visionVetoOnlyEnabled())"), "report-only branch first inside the vision block");
const without = lineage.replace(/    if \(visionVetoReportOnlyEnabled\(\)\) \{\n[\s\S]*?\n      return;\n    \}\n/, "");
assert.ok(!without.includes("visionVetoReportOnlyEnabled") && without.includes("if (visionVetoOnlyEnabled()) {") && without.includes("const hasVision = await hasPassingLinkedCritic") && without.includes("linkedVisionVeto(found.ref)"), "removing the block leaves the original gate");
check("off: removing the report-only block leaves the original lineage gate unchanged");

for (const name of results) console.log(`PASS ${name}`);
console.log(`${results.length} checks passed`);
