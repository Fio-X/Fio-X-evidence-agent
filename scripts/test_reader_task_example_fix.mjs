// NEWSROOM_SPEED_READER_TASK_EXAMPLE_FIX=1 (default off): the planning tool's
// claim_spec.reader_task description lists "trend", a value the checks refuse
// (the model copied it and was sent back). This switch swaps that one sentence
// for the corrected one without the other rule hints (NEWSROOM_SPEED_RULE_HINTS,
// about 3.4 KB more text).
//  1. Off: tool definitions of every profile are byte-identical to 35cb1cf, with
//     and without the other description switches.
//  2. On, big switch off: the definitions differ from 35cb1cf by that one
//     sentence and nothing else (the exact difference is asserted).
//  3. Big switch on: the output is what the big switch alone gives, whatever
//     the small switch says; the old example appears nowhere.
// Loads runtime/pi/newsroom.ts from a type-stripped copy. The 35cb1cf side comes
// from `git archive` and is skipped when history is unavailable; the literal
// checks below it always run. No provider or network access.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutApprovedLieflat, loadPinPatches } from "./lib_pin_patch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = "35cb1cf";
const scratch = mkdtempSync(join(tmpdir(), "reader-task-fix-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN"]) delete process.env[name];

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
async function loadTree(label, source) {
  const dir = mkdtempSync(join(scratch, `tree-${label}-`));
  cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(source, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return await import(join(pi, "newsroom.test-copy.mjs"));
}
function baselineSource() {
  const dir = mkdtempSync(join(scratch, "baseline-"));
  const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASELINE, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) return null;
  writeFileSync(join(dir, "baseline.tar"), archive.stdout);
  return spawnSync("tar", ["-xf", join(dir, "baseline.tar"), "-C", dir]).status === 0 ? dir : null;
}
// Tools read the environment when they register, so it is set right before.
function definitions(mod, env) {
  for (const [k, v] of Object.entries({ NEWSROOM_TOOL_PROFILE: undefined, NEWSROOM_SPEED_RULE_HINTS: undefined, NEWSROOM_SPEED_READER_TASK_EXAMPLE_FIX: undefined, NEWSROOM_SPEED_FIRST_TRY_ALL: undefined, NEWSROOM_SPEED_FIRST_TRY_TEXT: undefined, NEWSROOM_SPEED_CONTRACT_TEXT: undefined, ...env })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return Object.fromEntries([...tools].map(([name, tool]) => [name, JSON.parse(JSON.stringify({ ...tool, execute: undefined }))]));
}
// Every path where two JSON values differ, with both sides.
function diff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => diff(a[key], b[key], `${path}/${key}`));
  }
  return [{ path, before: a, after: b }];
}

const OLD_SENTENCE = "Use the same controlled value as the top-level reader_task (for example ranking, comparison, change, trend, distribution, correlation, or relationship), not a prose sentence.";
const NEW_SENTENCE = "Use the same controlled value as the top-level reader_task (one of ranking, comparison, change, distribution, correlation, part_to_whole, spatial, flow, relationship, hierarchy, sequence, process), not a prose sentence.";
const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
const SWITCH = { NEWSROOM_SPEED_READER_TASK_EXAMPLE_FIX: "1" };
const BIG = { NEWSROOM_SPEED_RULE_HINTS: "1" };
// Description switches that may be on next to it; the small switch must not depend on them (FIRST_TRY_ALL already has no example).
const CHAIN = { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1" };
const OTHERS = [{}, { NEWSROOM_SPEED_FIRST_TRY_TEXT: "1" }, { NEWSROOM_SPEED_CONTRACT_TEXT: "1" }, CHAIN, { ...CHAIN, NEWSROOM_SPEED_INLINE_CLAIM: "1" }, { NEWSROOM_SPEED_FIRST_TRY_ALL: "1" }];

const current = await loadTree("current", ROOT);
const claimSpecReaderTask = (defs) => defs.newsroom_viz_plan?.parameters?.properties?.claim_spec?.properties?.reader_task?.description;

// ---- Literal checks (no history needed) -------------------------------------
for (const profile of PROFILES) {
  const off = definitions(current, { NEWSROOM_TOOL_PROFILE: profile });
  if (!off.newsroom_viz_plan) continue;
  assert.equal(claimSpecReaderTask(off), OLD_SENTENCE, `${profile}: off keeps the old sentence`);
  assert.equal(claimSpecReaderTask(definitions(current, { NEWSROOM_TOOL_PROFILE: profile, ...SWITCH })), NEW_SENTENCE, `${profile}: on gives the corrected sentence`);
  assert.equal(claimSpecReaderTask(definitions(current, { NEWSROOM_TOOL_PROFILE: profile, ...BIG })), NEW_SENTENCE, `${profile}: big switch gives the same sentence`);
}
for (const notOne of ["0", "true", "yes", "", " 1", "01"]) {
  assert.equal(claimSpecReaderTask(definitions(current, { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_READER_TASK_EXAMPLE_FIX: notOne })), OLD_SENTENCE, `value ${JSON.stringify(notOne)} is off`);
}
assert.ok(PROFILES.some((p) => definitions(current, { NEWSROOM_TOOL_PROFILE: p }).newsroom_viz_plan), "some profile registers the planning tool");

// ---- 3. Big switch on: whatever the small switch says -----------------------
for (const profile of PROFILES) for (const other of OTHERS) {
  const alone = definitions(current, { NEWSROOM_TOOL_PROFILE: profile, ...BIG, ...other });
  const both = definitions(current, { NEWSROOM_TOOL_PROFILE: profile, ...BIG, ...SWITCH, ...other });
  assert.deepEqual(diff(alone, both), [], `${profile} ${JSON.stringify(other)}: big switch output is the same with the small switch`);
  assert.equal((JSON.stringify(both).match(/not a prose sentence/g) ?? []).length, alone.newsroom_viz_plan ? (JSON.stringify(alone).match(/not a prose sentence/g) ?? []).length : 0, `${profile}: no second copy of the sentence`);
  assert.ok(!JSON.stringify(both).includes("for example ranking, comparison, change, trend"), `${profile}: no old example`);
}

// ---- 1 and 2. Against 35cb1cf -----------------------------------------------
const baselineDir = baselineSource();
if (!baselineDir) {
  console.log(`${BASELINE} history unavailable; skipped the byte comparison with it`);
} else {
  const baseline = await loadTree("baseline", baselineDir);
  let compared = 0;
  // Off differs from the baseline only by the approved description changes listed in the pin list (exact old and new text).
  const pins = loadPinPatches("reader_task_example_fix", { baseline: BASELINE });
  const asMap = (defs) => new Map(Object.entries(defs));
  for (const profile of PROFILES) for (const other of OTHERS) {
    const env = { NEWSROOM_TOOL_PROFILE: profile, ...other };
    const before = withoutApprovedLieflat(definitions(baseline, env), profile);
    const off = definitions(current, env);
    pins.check(asMap(before), asMap(off), `${profile} ${JSON.stringify(other)}: off against ${BASELINE}`);
    const changes = diff(off, definitions(current, { ...env, ...SWITCH }));
    if (!before.newsroom_viz_plan || other.NEWSROOM_SPEED_FIRST_TRY_ALL) {
      // No planning tool, or FIRST_TRY_ALL already replaced the example: nothing to change.
      assert.deepEqual(changes, [], `${profile} ${JSON.stringify(other)}: nothing changes`);
    } else {
      // The exact difference: the one sentence, at every place it is registered.
      assert.ok(changes.length >= 1, `${profile}: the switch changes something`);
      for (const change of changes) {
        assert.match(change.path, /claim_spec\/properties\/reader_task\/description$/, `${profile}: only the reader_task sentence changes (${change.path})`);
        assert.deepEqual([change.before, change.after], [OLD_SENTENCE, NEW_SENTENCE], `${profile}: ${change.path}`);
      }
      if (compared === 0) console.log(`exact difference (${profile}): ${JSON.stringify(changes)}`);
    }
    compared += 1;
  }
  pins.finish();
  console.log(`ok: off is byte-identical to ${BASELINE}; on differs by one sentence (${compared} profile/switch combinations)`);
}
console.log("ok: reader_task example switch");
