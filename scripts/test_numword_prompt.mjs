// NEWSROOM_NUMWORD_PROMPT (K97): the rule the prompt gives the model must agree with the checks, which this change does not touch.
// The right example in src/prompt.rs must pass numberWordIn and carry no digit; each wrong example must be refused by numberWordIn or hold a digit.
// If someone loosens numberWordIn (the mutant), the wrong example stops being refused and this test goes red. The old sentence "say it in words"
// must not be the guidance any more when the switch is on (the Rust test pins that; here the source text is read back).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { numberWordIn } from "../runtime/pi/number_words.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(`${ROOT}src/prompt.rs`, "utf8");
const guidance = source.match(/const NUMWORD_GUIDANCE: &str = "((?:[^"\\]|\\.)*)";/)?.[1];
assert.ok(guidance, "NUMWORD_GUIDANCE found in src/prompt.rs");
const text = guidance.replace(/\\"/g, '"').replace(/\\n/g, "\n");
const right = text.match(/Right: "([^"]+)"/)?.[1];
const wrongs = [...text.matchAll(/Wrong: "([^"]+)"(?: or "([^"]+)")?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean));
assert.ok(right && wrongs.length === 2, "one right and two wrong examples");
let n = 0;
// The runtime's own claim-template filler (type-stripped copy of runtime/pi/newsroom.ts): the right example must fill with every placeholder legal,
// each wrong example must be refused. Mutant: write {share_latest} (not a runtime placeholder) as the right example -> this goes red.
const scratch = mkdtempSync(join(tmpdir(), "numword-prompt-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const stub = (name, code) => { mkdirSync(join(scratch, "node_modules", name), { recursive: true }); writeFileSync(join(scratch, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" })); writeFileSync(join(scratch, "node_modules", name, "index.js"), code); };
cpSync(join(ROOT, "runtime"), join(scratch, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(scratch, "config"), { recursive: true });
stub("typebox", "const f = () => ({}); export const Type = new Proxy({}, { get: () => f });");
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const copy = join(scratch, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(scratch, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const { fillClaimTemplate } = await import(pathToFileURL(copy).href);
const rows = [{ year: 2019, share: 0.71 }, { year: 2023, share: 0.64 }];
const filled = fillClaimTemplate(right, rows, ["share"]);
assert.ok(filled.bindings.length >= 1 && !/[{}]/.test(filled.text), `right example fills with runtime placeholders: ${filled.text}`); n += 1;
for (const wrong of wrongs) { assert.throws(() => fillClaimTemplate(wrong, rows, ["share"]), /CLAIM_TEMPLATE_ERROR/, `runtime refuses: ${wrong}`); n += 1; }
assert.equal(numberWordIn(right), null, `right example passes the number-word check: ${right}`); n += 1;
assert.ok(!/\d/.test(right.replace(/\{[^}]*\}/g, "")), "right example holds no digit outside placeholders"); n += 1;
for (const wrong of wrongs) {
  const bare = wrong.replace(/\{[^}]*\}/g, "");
  assert.ok(numberWordIn(wrong) !== null || /\d/.test(bare), `wrong example is refused by a check (word or digit): ${wrong}`); n += 1;
}
// the words the rule names are the ones the check refuses
for (const word of ["Two-thirds of output", "the top five exporters", "三成的产量", "百分之八十的产量"]) { assert.notEqual(numberWordIn(word), null, `refused: ${word}`); n += 1; }
// the old advice is gone from the replacement, and the rule names all three places
assert.ok(!/in words/.test(text), "no advice to say it in words"); n += 1;
for (const place of ["conclusion sentence", "main chart's labels and description", "text module or heading"]) { assert.ok(text.includes(place), place); n += 1; }
console.log(`numword prompt: ${n} checks -- PASS`);
