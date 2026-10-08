// NEWSROOM_SPEED_RECIPES appends a method recipe to the prompt. A recipe is not a recorded query, source or
// claim and carries no digits, so a number a model could copy out of it must still be refused by the claim
// gates, with the switch on. Loads runtime/pi/newsroom.ts from a type-stripped copy; no network, no provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "claim-integrity-"));
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { lintClaimTemplate } = await import(join(pi, "claim_lint.mjs"));
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
process.env.NEWSROOM_TOOL_PROFILE = "full";

import { readdirSync as ls } from "node:fs";
let passed = 0;
const check = (label) => { passed += 1; console.log(`PASS ${label}`); };
const { fillClaimTemplate } = mod;
process.env.NEWSROOM_SPEED_RECIPES = "1";
const dir = join(ROOT, "recipes");
const texts = ls(dir).filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
assert.ok(texts.length >= 2, "both recipe bodies are present");
for (const [name, text] of texts) assert.ok(!/[0-9]/.test(text), `${name}: a recipe holds no digit to copy`);
check("no recipe body holds a digit, so no number can be copied out of one");
const rows = [{ country: "Chad", year: 2022, share: 70 }];
const cols = ["country", "year", "share"];
// A number typed from anywhere that is not a result row (the prompt, a recipe, the model) is refused as typed.
assert.throws(() => fillClaimTemplate("Chad's share was 70 percent.", rows, cols), /^Error: CLAIM_TEMPLATE_ERROR: the claim has a typed number/, "typed number refused with recipes on");
assert.throws(() => fillClaimTemplate("The series covers 2022.", rows, cols), /^Error: CLAIM_TEMPLATE_ERROR: the claim has a typed number/, "typed year refused with recipes on");
check("a typed number or year is refused with the recipes switch on");
// A placeholder for a row the recorded query does not hold is refused.
assert.throws(() => fillClaimTemplate("Niger's share was {share@country=Niger} percent.", rows, cols), /^Error: CLAIM_TEMPLATE_ERROR: \{share@country=Niger\}: no result row has country = Niger/, "placeholder outside the recorded rows refused");
check("a placeholder outside the recorded rows is refused with the recipes switch on");
console.log(`recipes stay unverified: ${passed} checks PASS`);
