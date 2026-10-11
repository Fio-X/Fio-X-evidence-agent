#!/usr/bin/env node
// NEWSROOM_MODEL_PASS_SELFREPORT=1 (K98, exact "1", default off): the image-aware (vision) critic may only veto a page. Every vision critic linked to
// the page counts; one that failed, scored below 80 or reports a blocker blocks publication even next to a passing one, and a model pass never
// releases a page alone. Off, the publication gate reads exactly as before. Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "vision-veto-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
delete process.env.NEWSROOM_MODEL_PASS_SELFREPORT;
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

const PAGE = "infographics/page.json";
const PASS = { passed: true, score: 92, issues: [] };
let seq = 0;
function investigation(critics) {
  const dir = join(scratch, `inv-${++seq}`);
  mkdirSync(join(dir, "infographics/vision-critics"), { recursive: true });
  critics.forEach((critic, i) => writeFileSync(join(dir, `infographics/vision-critics/v${i}.json`), JSON.stringify({ kind: "image_aware_model", manifest_ref: PAGE, ...critic })));
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  return dir;
}
const veto = (critics) => { investigation(critics); return mod.__linkedVisionVetoForTest(PAGE); };

// 1. a model pass alone is no veto; every linked critic is read, a later pass does not override an earlier failure
assert.equal(await veto([PASS]), null, "a passing, scoring, blocker-free critique is no veto");
assert.equal(await veto([]), null, "no vision critic: no veto (the missing-critic gate is the existing one)");
assert.equal(await veto([{ passed: false, score: 95 }, PASS]), "infographics/vision-critics/v0.json", "a failing critique vetoes although another passed");
assert.equal(await veto([PASS, { passed: false, score: 95 }]), "infographics/vision-critics/v1.json", "order does not matter");
check("model passed:true is no veto; passed:false still vetoes next to a passing critique");

// 2. the thresholds a passing critique is already held to in verify.rs veto too
for (const [label, critic] of [["score below 80", { passed: true, score: 79.9 }], ["no score", { passed: true }], ["blocker", { passed: true, score: 95, issues: [{ severity: "blocker" }] }], ["passed missing", { score: 95 }], ["passed as string", { passed: "true", score: 95 }]]) {
  assert.ok(await veto([PASS, critic]), `${label} vetoes`);
}
assert.equal(await veto([PASS, { passed: true, score: 80, issues: [{ severity: "major" }] }]), null, "score 80 with a non-blocker issue is no veto");
check("score < 80, missing score, blocker issue, non-boolean passed all veto (5 cases); 80 + non-blocker does not");

// 3. critics for another page and unreadable files never count
assert.equal(await veto([{ passed: false, score: 10, manifest_ref: "infographics/other.json" }, PASS]), null, "another page's failure is not this page's veto");
{
  const dir = investigation([PASS]);
  writeFileSync(join(dir, "infographics/vision-critics/broken.json"), "{");
  assert.equal(await mod.__linkedVisionVetoForTest(PAGE), null, "an unparsable file is skipped as in hasPassingLinkedCritic");
}
check("only critics linked by manifest_ref count; unparsable files are skipped");

// 4. the publication gate: the veto runs after the unchanged passing-critic check, only when the switch is exactly "1"
const lineage = /async function assertApprovedInfographicLineage[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
assert.ok(lineage, "assertApprovedInfographicLineage found");
const passIdx = lineage.indexOf('hasPassingLinkedCritic("infographics/vision-critics", found.ref)');
const vetoIdx = lineage.indexOf("linkedVisionVeto(found.ref)");
assert.ok(passIdx > 0 && vetoIdx > passIdx, "veto runs after the passing-critic requirement, which stays");
assert.match(lineage.slice(passIdx, vetoIdx), /if \(modelPassSelfReportEnabled\(\)\) \{\s*const veto = await $/, "veto is guarded by the switch");
assert.match(lineage.slice(vetoIdx), /^linkedVisionVeto\(found\.ref\);\s*if \(veto\) \{\s*throw new Error\(/, "a veto throws");
assert.equal((source.match(/linkedVisionVeto\(/g) ?? []).length, 3, "defined once, called by the gate and the test hook only");
assert.match(source, /export const modelPassSelfReportEnabled|modelPassSelfReportEnabled,/, "switch read from art_direction.mjs");
const art = await import(pathToFileURL(join(tree, "runtime/pi/art_direction.mjs")).href);
for (const value of [undefined, "true", "on", "0", "", " 1", "01"]) {
  if (value === undefined) delete process.env.NEWSROOM_MODEL_PASS_SELFREPORT; else process.env.NEWSROOM_MODEL_PASS_SELFREPORT = value;
  assert.equal(art.modelPassSelfReportEnabled(), false, `off for ${JSON.stringify(value)}`);
}
process.env.NEWSROOM_MODEL_PASS_SELFREPORT = "1";
assert.equal(art.modelPassSelfReportEnabled(), true);
delete process.env.NEWSROOM_MODEL_PASS_SELFREPORT;
check("gate: veto after the unchanged pass requirement, behind the exact-\"1\" switch (7 off values)");

// 5. off: the gate text before this change is intact (only the guarded block was added)
const before = lineage.replace(/    if \(modelPassSelfReportEnabled\(\)\) \{\n      const veto = await linkedVisionVeto[\s\S]*?\n      \}\n    \}\n/, "");
assert.ok(!before.includes("linkedVisionVeto") && before.includes("const hasVision = await hasPassingLinkedCritic"), "removing the guarded block leaves the original gate");
check("off: removing the guarded block leaves the original lineage gate unchanged");

for (const name of results) console.log(`PASS ${name}`);
console.log(`${results.length} checks passed`);
