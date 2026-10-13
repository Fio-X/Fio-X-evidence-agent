// Number words: numberWordIn refuses a number written as a word in a claim or hero template, where
// literalNumberIn refuses digits. Placeholders are masked first; a scale or unit word right after a
// placeholder or digit passes. Unit lists, fillClaimTemplate, and the real claim templates (when present).
// The inline-plan and hero tool paths are covered in test_page_inline_claim.mjs and test_hero_value_tool_path.mjs.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { numberWordIn } from "../runtime/pi/number_words.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let n = 0;
const refuse = (text) => { assert.notEqual(numberWordIn(text), null, `should refuse: ${text}`); n += 1; };
const pass = (text) => { assert.equal(numberWordIn(text), null, `should pass: ${text}`); n += 1; };

for (const t of [
  "A couple of countries lead", "a COUPLE OF regions", "Eleven countries report a rise", "The two-child policy ended", "the second-largest economy",
  "the top five exporters", "Two-thirds of output", "output doubled", "half of the sample", "something happened in ten years",
  "两国都在增长", "十年来持续上升", "共有十个国家", "第二大经济体", "前五名", "三成的产量", "一半的地区", "二十多个城市",
  "a dozen countries", "threefold", "ten-fold", "上升三个百分点",
]) refuse(t);
for (const t of [
  "{max.x} million", "{max.x} percent", "{max.x} percentage points", "{max.x} basis points", "{max.x}% rise", "net zero", "the Group of Seven", "in the first half",
  "{max.x}万吨", "{max.x}倍", "{max.x}成", "百分之{max.x}", "两国关系", "一带一路", "十四五", "the {first.decade}s", "{max.x} hundred", "{max.x}million",
  "{max.x.country} has a score of {max.x}", "test scores rose", "上升了{max.x}个百分点", "上升了{max.x}个基点", "a manifold rise", "{max.x}-fold",
]) pass(t);
refuse("{max.x} 3 times and ten more");
refuse("{max.x} million, and ten others");
// K257: 根 is a counting word (四根柱 was the one gap in the list)
for (const t of ["四根柱", "两根线", "三根柱子", "十根", "二十多根"]) refuse(t);
for (const t of ["一根柱", "根本", "树根", "根{max.x}", "{max.x}根"]) pass(t);
assert.match(numberWordIn("Among the ten African countries"), /ten/);
assert.equal(numberWordIn("没有数字词"), null);

// fillClaimTemplate refuses a number word; a scale word after a placeholder still fills.
const dir = mkdtempSync(join(tmpdir(), "number-words-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const stub = (name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
stub("typebox", `const f = () => ({}); export const Type = new Proxy({}, { get: () => f });`);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const copy = join(dir, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const { fillClaimTemplate } = await import(copy);
const rows = [{ country: "A", year: 2021, x: 5 }, { country: "B", year: 2022, x: 9 }];
const measures = ["x"];
assert.throws(() => fillClaimTemplate("The {max.x} hottest of ten years", rows, measures), /^Error: CLAIM_TEMPLATE_ERROR: the claim has a number word \(near "[^"]*ten[^"]*"\)/);
assert.throws(() => fillClaimTemplate("{max.x.country} leads, 十个 follow", rows, measures), /number word/);
assert.doesNotThrow(() => fillClaimTemplate("{max.x.country} leads at {max.x} million", rows, measures));
n += 3;

// Real templates (read-only, outside the repo): the prototype refuses exactly 十年 and 十个 of twelve.
const real = process.env.NEWSROOM_NUMWORDS_REAL_CLAIMS;
if (real && existsSync(real)) {
  const refused = readFileSync(real, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).claim_template).filter(Boolean).filter((t) => numberWordIn(t) !== null);
  console.log(`  real templates refused: ${refused.length}`);
}
console.log(`ok test_number_words (${n} checks)`);
