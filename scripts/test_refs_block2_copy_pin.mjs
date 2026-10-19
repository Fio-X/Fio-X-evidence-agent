// refs_block2.mjs keeps local copies of preflight.mjs's candidates() and settle(), of the `missing` line and of MAX_SCAN (a visual-group module may not
// import them; see the header of refs_block2.mjs). This pins the copies: the function bodies and the MAX_SCAN value must stay
// byte-identical (the `missing` line decides that "" and null are given values, never replaced) to preflight.mjs, so the scan limit and the one-candidate rule cannot drift apart. Text compare only.
// A one-character change in the copy must turn it red (shown below on in-memory copies).
// Run: node scripts/test_refs_block2_copy_pin.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PI = join(fileURLToPath(new URL("..", import.meta.url)), "runtime", "pi");

// The text of `function <name>` (with its async / export prefix removed) up to its closing brace at column 0.
const functionText = (source, name) => {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `function ${name} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `function ${name} has no closing brace at column 0`);
  return source.slice(start, end + 3).replace(/^export /, "");
};
const maxScan = (source) => {
  const found = source.match(/^const MAX_SCAN = (\d+);$/gm);
  assert.equal(found?.length, 1, "exactly one MAX_SCAN definition");
  return found[0];
};

const missingLine = (source) => {
  const found = source.match(/^const missing = .*;$/gm);
  assert.equal(found?.length, 1, "exactly one `missing` definition");
  return found[0];
};

const compare = (preflight, copy) => {
  for (const name of ["candidates", "settle"]) assert.equal(functionText(copy, name), functionText(preflight, name), `${name} in refs_block2.mjs differs from preflight.mjs`);
  assert.equal(maxScan(copy), maxScan(preflight), "MAX_SCAN in refs_block2.mjs differs from preflight.mjs");
  assert.equal(missingLine(copy), missingLine(preflight), "the `missing` line in refs_block2.mjs differs from preflight.mjs");
};

const preflight = readFileSync(join(PI, "preflight.mjs"), "utf8");
const copy = readFileSync(join(PI, "refs_block2.mjs"), "utf8");
compare(preflight, copy);

// Mutations of the copy, each one character: all must be refused by an assertion.
const once = (text, from, to) => { assert.equal(text.split(from).length - 1, 1, `mutation anchor must match once: ${from}`); return text.replace(from, () => to); };
for (const [label, from, to] of [
  ["max-scan-value", "const MAX_SCAN = 200;", "const MAX_SCAN = 201;"],
  ["candidates-slice", "refs.slice(0, MAX_SCAN)", "refs.slice(1, MAX_SCAN)"],
  ["missing-empty", "const missing = (value) => value === undefined;", "const missing = (value) => value === undefined || value === \"\";"],
  ["settle-one", "result.found.length === 1", "result.found.length >= 1"],
]) {
  assert.throws(() => compare(preflight, once(copy, from, to)), (e) => e?.code === "ERR_ASSERTION", `mutation ${label} must turn the pin red`);
}
console.log("refs_block2 copies of candidates, settle, missing and MAX_SCAN are byte-identical to preflight.mjs; four mutations red -- PASS");
