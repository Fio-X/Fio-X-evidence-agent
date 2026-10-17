// K814: the refusal text for missing required properties says what the schema expects, and lines that differ only in array indexes are folded.
// Wording only: pass/fail, the normalized arguments and validate()'s error list must equal the base (ab2f9bf6) verdicts in
// fixtures/schema-refusal/verdicts-ab2f9bf6.json for every fixture case. Offline; no model, no network.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INLINE_CASES, loadTree, runInline, visualConceptsRaw } from "./schema_refusal_cases.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = JSON.parse(readFileSync(join(ROOT, "fixtures/schema-refusal/verdicts-ab2f9bf6.json"), "utf8"));
const tmp = makeTestTmp("refusal-expected-");
const lineBlock = (text) => text.split("\n\nArguments as sent:")[0].split("\n").slice(1);
const results = [];
const check = (text) => results.push(text);

// Expand "k[0,2..5].y" back to its paths so the folded lines can be compared with validate()'s errors one to one.
const expand = (line) => {
  const [path, ...rest] = line.replace(/^ {2}- /, "").split(": ");
  const message = rest.join(": ").replace(/ \(.*\)$/, "");
  let paths = [""];
  for (const part of path.split(/(\[[^\]]*\])/).filter(Boolean)) {
    if (part.startsWith("[")) {
      const numbers = part.slice(1, -1).split(",").flatMap((p) => { const m = p.match(/^(\d+)\.\.(\d+)$/); return m ? Array.from({ length: m[2] - m[1] + 1 }, (_, i) => String(Number(m[1]) + i)) : [p]; });
      paths = paths.flatMap((p) => numbers.map((n) => (p ? `${p}.${n}` : n)));
    } else paths = paths.map((p) => (p && !part.startsWith(".") ? `${p}.${part}` : p + part).replace(/^\./, "")).map((p) => p);
  }
  return paths.map((p) => `${p}: ${message}`);
};
const baseMessage = ([path, message]) => `${path}: ${message}`;

async function suite(root) {
  const { schema, host } = await loadTree(root, tmp, "newsroom_visual_concepts");
  const fails = [];
  // 1. Same verdicts as the base, case by case.
  INLINE_CASES.forEach((c, i) => {
    const now = runInline(host, c), was = BASE.inline[i];
    if (c.name !== was.name) fails.push(`fixture order: ${c.name}`);
    if (now.ok !== was.ok) fails.push(`${c.name}: pass/fail changed`);
    if (JSON.stringify(now.errors) !== JSON.stringify(was.errors)) fails.push(`${c.name}: validate() errors changed`);
    if (was.ok && JSON.stringify(now.args) !== JSON.stringify(was.args)) fails.push(`${c.name}: normalized arguments changed`);
    if (!was.ok) {
      const expanded = lineBlock(now.text).flatMap(expand).sort();
      const expected = was.errors.map(baseMessage).sort();
      if (JSON.stringify(expanded) !== JSON.stringify(expected)) fails.push(`${c.name}: folded lines do not expand to the base error list`);
    }
  });
  const text = (name) => { const c = INLINE_CASES.find((x) => x.name === name); return lineBlock(runInline(host, c).text); };
  // 2. Expected shapes.
  const enumLine = text("missing enum field").find((l) => l.includes("kind"));
  if (!/kind: Expected required property \(string; one of "a", "b", "c"\)$/.test(enumLine ?? "")) fails.push(`missing enum field does not show its values: ${enumLine}`);
  const long = text("long enum is capped")[0];
  if (!long?.includes('"v11" (+3 more)') || long.includes('"v12"')) fails.push(`long enum not capped at 12: ${long}`);
  if (!text("missing const").some((l) => /v: Expected required property \(string; const "0\.2\.0"\)$/.test(l))) fails.push("missing const not shown");
  if (!text("required union property has no type").some((l) => /u: Expected required property \(one of several shapes\)$/.test(l))) fails.push("union property shape not shown");
  if (!text("flat: wrong number, missing string").some((l) => l === "  - s: Expected required property (string)")) fails.push("missing string has no type");
  // 3. Folding.
  const folded = text("array items missing in several positions");
  for (const line of ['  - items[0..4].x: Expected required property (string; one of "a", "b")', "  - items[0..4].z: Expected required property (integer)"]) if (!folded.includes(line)) fails.push(`folding: missing line ${line}`);
  if (!folded.includes("  - items[0,2..5].y: Expected required property (array of string)")) fails.push("folding: y indexes");
  if (!text("two index levels, full product").includes("  - m[0,1].c[0,1].role: Expected required property (string)")) fails.push("folding: two levels, full product");
  if (text("two index levels, not a product").length !== 3) fails.push("folding: a non-product set must stay as separate lines");
  if (!text("root array").includes("  - [0..2].id: Expected required property (string)")) fails.push("folding: root array");
  if (text("digit-named object keys are not indexes").length !== 2) fails.push("folding: digit-named object keys were folded");
  if (!text("array of enum strings, wrong items").some((l) => l.includes("tags[1..3]"))) fails.push("folding: wrong-value lines in an array");
  // 4. The 99-line refusal.
  const raw = visualConceptsRaw(schema);
  const failure = host.validationFailure("newsroom_visual_concepts", schema, raw);
  const errors = host.validate(schema, host.convert(schema, raw));
  if (errors.length !== BASE.visual_concepts.error_count) fails.push(`99-line case: ${errors.length} errors, base ${BASE.visual_concepts.error_count}`);
  const lines = lineBlock(failure.text), linesBytes = Buffer.byteLength(failure.text.split("\n\nArguments as sent:")[0]);
  if (lines.length >= BASE.visual_concepts.error_count) fails.push(`99-line case not folded: ${lines.length} lines`);
  const bytes = { lines: lines.length, error_lines_bytes: linesBytes, text_bytes: Buffer.byteLength(failure.text) };
  return { fails, bytes };
}

const real = await suite(ROOT);
assert.deepEqual(real.fails, [], real.fails.join("\n"));
check(`verdicts equal the base for ${INLINE_CASES.length} cases (pass/fail, arguments, validate() errors); folded lines expand to the base error list; shapes, long-enum cap, folding rules`);
check(`99-line refusal: ${BASE.visual_concepts.error_count} error lines / ${BASE.visual_concepts.error_lines_bytes} B (whole text ${BASE.visual_concepts.text_bytes} B) before; ${real.bytes.lines} lines / ${real.bytes.error_lines_bytes} B (whole text ${real.bytes.text_bytes} B) after`);
assert.ok(real.bytes.text_bytes < BASE.visual_concepts.text_bytes, "the 99-line refusal is smaller");

// 5. Mutations on copies of the tree: each must turn the suite red.
const mutate = (label, file, from, to) => {
  const dir = join(tmp, `mut-${label}`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  const path = join(dir, "runtime/pi", file), source = readFileSync(path, "utf8");
  assert.ok(source.includes(from), `mutation fixture missing: ${label}`);
  writeFileSync(path, source.replace(from, to));
  return dir;
};
const mutations = [
  ["no expected type", "tool_host_schema.mjs", 'parts.push(types === "array"', 'parts.push(types === "array" && false), parts.pop(), void (types === "array"'],
  ["enum values dropped", "tool_host_schema.mjs", 'if (Array.isArray(sub.enum)) {', "if (false) {"],
  ["enum cap removed", "tool_host_schema.mjs", "sub.enum.slice(0, ENUM_SHOWN)", "sub.enum"],
  ["no folding", "tool_host_schema.mjs", "if (members.length > 1 && positions.length > 0", "if (false && positions.length > 0"],
  ["fold without the product check", "tool_host_schema.mjs", "positions.length > 0 && product === members.length)", "positions.length > 0)"],
  ["the check itself changes (an error is dropped)", "tool_host_schema.mjs", 'errors.push([at, "Expected required property"]);', "if (key !== 'concept_id') errors.push([at, \"Expected required property\"]);"],
];
for (const [label, file, from, to] of mutations) {
  const dir = mutate(label.replace(/\W+/g, "-"), file, from, to);
  const outcome = await suite(dir).catch((error) => ({ fails: [`threw: ${String(error.message).slice(0, 60)}`] }));
  assert.ok(outcome.fails.length > 0, `mutation not caught: ${label}`);
  check(`mutation caught: ${label} (${outcome.fails.length} failing checks)`);
}
for (const text of results) console.log(`PASS ${text}`);
