// The Chinese-question rule is written twice: src/prompt.rs language_instruction (Rust) and runtime/pi/publication.mjs writesChinese (JS).
// Both are asserted against the one case list fixtures/language-rule-cases.json (the Rust side: prompt.rs test language_rule_matches_shared_cases).
// Mutations: a flipped expected value, a changed threshold, a wider code point range and a kana-counting rule all turn this test red. Offline.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CASES = join(ROOT, "fixtures/language-rule-cases.json");
const load = (path) => JSON.parse(readFileSync(path, "utf8")).cases;
const mod = (path) => import(`${pathToFileURL(path).href}?t=${Math.random()}`);

async function misses(pubPath, casesPath) {
  const { writesChinese, publicationLanguageFor } = await mod(pubPath);
  const out = [];
  for (const c of load(casesPath)) {
    if (writesChinese(c.text) !== c.chinese) out.push(`writesChinese: ${c.name}`);
    if (publicationLanguageFor(undefined, c.text) !== (c.chinese ? "zh" : undefined)) out.push(`publicationLanguageFor: ${c.name}`);
    if (publicationLanguageFor("en", c.text) !== "en" || publicationLanguageFor("zh", c.text) !== "zh") out.push(`explicit wins: ${c.name}`);
  }
  return out;
}

const cases = load(CASES);
assert.ok(cases.length >= 15, "the case list is not trimmed");
assert.ok(cases.some((c) => c.chinese) && cases.some((c) => !c.chinese), "both outcomes are covered");
assert.deepEqual(await misses(join(ROOT, "runtime/pi/publication.mjs"), CASES), [], "the JS rule matches the shared cases");
console.log(`language rule: PASS (${cases.length} cases, JS side)`);

const dir = makeTestTmp("language-rule-");
cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true }); // publication.mjs imports its neighbours
const pubSource = readFileSync(join(ROOT, "runtime/pi/publication.mjs"), "utf8");
const mutated = (name, from, to) => {
  assert.ok(pubSource.includes(from), `fixture text missing: ${from}`);
  const path = join(dir, "runtime/pi/publication.mjs");
  writeFileSync(path, pubSource.replace(from, to));
  return path;
};
const caught = [];
const red = async (label, pub, casesPath = CASES) => { const m = await misses(pub, casesPath); assert.ok(m.length > 0, `mutation not caught: ${label}`); caught.push(`${label} (${m.length} case(s) red)`); };
const real = join(ROOT, "runtime/pi/publication.mjs");
// the expected value of one case flipped (the code is the real code)
const flipped = JSON.parse(readFileSync(CASES, "utf8"));
flipped.cases[3].chinese = !flipped.cases[3].chinese;
const flippedPath = join(dir, "flipped.json");
writeFileSync(flippedPath, JSON.stringify(flipped));
await red("one case's expected value flipped", real, flippedPath);
await red("threshold 2 -> 1", mutated("min1", "PUBLICATION_ZH_MIN_HAN=2", "PUBLICATION_ZH_MIN_HAN=1"));
await red("threshold 2 -> 3", mutated("min3", "PUBLICATION_ZH_MIN_HAN=2", "PUBLICATION_ZH_MIN_HAN=3"));
await red("range widened to extension A", mutated("extA", "c>=0x4e00&&c<=0x9fff", "c>=0x3400&&c<=0x9fff"));
await red("range counts kana", mutated("kana", "c>=0x4e00&&c<=0x9fff", "(c>=0x4e00&&c<=0x9fff)||(c>=0x3040&&c<=0x30ff)"));
await red("range ends early", mutated("short", "c<=0x9fff", "c<=0x9ffe"));
await red("explicit language loses", mutated("explicit", "return explicit?explicit:writesChinese(readerQuestion)?'zh':undefined;", "return writesChinese(readerQuestion)?'zh':explicit;"));
await red("unset never zh (the old default)", mutated("old", "writesChinese(readerQuestion)?'zh':undefined", "undefined"));
console.log(`mutations: PASS (${caught.length} caught)`);
for (const label of caught) console.log(`  caught: ${label}`);
// The Rust side reads the same file.
assert.ok(readFileSync(join(ROOT, "src/prompt.rs"), "utf8").includes("language-rule-cases.json"), "the Rust test reads the shared case list");
console.log("test_language_rule_cases: ok");
