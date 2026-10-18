// The exact patch lists of the byte-pin tests (scripts/lib_pin_patch.mjs): the engine must pass a head that differs from its baseline only by the
// listed changes, and must fail on everything else; every committed list must be well formed.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPinPatches, withoutApprovedIllustration } from "./lib_pin_patch.mjs";

const results = [];
const check = (name) => results.push(name);
const tmp = mkdtempSync(join(tmpdir(), "pin-patch-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const clone = (x) => JSON.parse(JSON.stringify(x));

const baseTool = () => ({
  name: "plan", label: "Plan", description: "Plan a chart.", promptSnippet: "plan()",
  promptGuidelines: ["Keep titles short.", "Use chart_type='bar' for ranks.", "Never invent a number."],
  parameters: { type: "object", properties: { chart_type: { type: "string", enum: ["bar", "line"] }, names: { type: "string", enum: ["a", "b"], description: "old wording" }, old_flag: { type: "boolean", __optional: true } }, required: ["chart_type"] },
  execute() {},
});
const other = () => ({ name: "lint", label: "Lint", description: "Lint it.", promptGuidelines: ["Run after plan."], parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] }, execute() {} });
const headTool = () => {
  const t = baseTool();
  t.promptGuidelines = ["Keep titles short.", "Use chart_type='bar' for ranks, or 'dot' for two values.", "Never invent a number.", "A page top names the period."];
  t.parameters.properties.chart_type.enum = ["bar", "line", "dot"];
  t.parameters.properties.names.description = "new wording";
  t.parameters.properties.new_field = { type: "integer", minimum: 0 };
  delete t.parameters.properties.old_flag.__optional;
  return t;
};
const LIST = {
  baseline: "abc1234",
  entries: [
    { tool: "plan", field: "promptGuidelines", old: "Use chart_type='bar' for ranks.", new: "Use chart_type='bar' for ranks, or 'dot' for two values.", commit: "c1" },
    { tool: "plan", field: "promptGuidelines", new: "A page top names the period.", commit: "c2" },
    { tool: "plan", field: "parameters", path: ["properties", "chart_type", "enum"], old: ["bar", "line"], new: ["bar", "line", "dot"], commit: "c3" },
    { tool: "plan", field: "parameters", path: ["properties", "names", "description"], old: "old wording", new: "new wording", commit: "c4" },
    { tool: "plan", field: "parameters", path: ["properties", "new_field"], new: { type: "integer", minimum: 0 }, commit: "c5" },
    { tool: "plan", field: "parameters", path: ["properties", "old_flag", "__optional"], old: true, commit: "c6" },
  ],
};
const write = (name, list) => writeFileSync(join(tmp, `${name}.json`), JSON.stringify(list));
const run = ({ list = LIST, head = [headTool(), other()], base = [baseTool(), other()], baseline = "abc1234", finish = true } = {}) => {
  write("t", list);
  const pins = loadPinPatches("t", { baseline, dir: tmp });
  pins.check(new Map(base.map((t) => [t.name, t])), new Map(head.map((t) => [t.name, t])), "case");
  if (finish) pins.finish();
};
const refuses = (name, pattern, options) => { assert.throws(() => run(options), pattern, name); check(`refused: ${name}`); };

run();
check("passes: a head that differs from its baseline only by the listed changes (guideline change and add, enum, description, new field, removed flag)");

refuses("an unlisted change in a listed tool", /byte-identical/, { head: (() => { const h = headTool(); h.description = "Plan a chart!"; return [h, other()]; })() });
refuses("an unlisted change in a tool without entries", /byte-identical/, { head: (() => { const o = other(); o.promptGuidelines = ["Run after plan.", "Extra."]; return [headTool(), o]; })() });
refuses("a listed value changed again in the head", /holds exactly the new value/, { head: (() => { const h = headTool(); h.parameters.properties.names.description = "newer wording"; return [h, other()]; })() });
refuses("the baseline moved off the listed old value", /holds exactly the old value/, { base: (() => { const b = baseTool(); b.parameters.properties.names.description = "older wording"; return [b, other()]; })() });
refuses("a listed change reverted in the head", /holds exactly the new value|carries exactly the new guideline/, { head: [baseTool(), other()] });
refuses("a half-applied enum (one value missing)", /holds exactly the new value/, { head: (() => { const h = headTool(); h.parameters.properties.chart_type.enum = ["bar", "dot"]; return [h, other()]; })() });
refuses("a guideline that starts like the listed one but differs after it", /carries exactly the new guideline once/, { head: (() => { const h = headTool(); h.promptGuidelines[1] = "Use chart_type='bar' for ranks, or 'dot' for two values!"; return [h, other()]; })() });
refuses("a different key order in the head (byte order counts)", /byte-identical/, { head: (() => { const h = headTool(); const { chart_type, names, ...rest } = h.parameters.properties; h.parameters.properties = { names, chart_type, ...rest }; return [h, other()]; })() });
refuses("a different guideline order in the head", /byte-identical/, { head: (() => { const h = headTool(); [h.promptGuidelines[0], h.promptGuidelines[2]] = [h.promptGuidelines[2], h.promptGuidelines[0]]; return [h, other()]; })() });
refuses("a tool registered on one side only", /the same tools are registered/, { head: [headTool()] });
refuses("a list entry no tool exercised (stale)", /every listed change was exercised/, { list: { ...LIST, entries: [...LIST.entries, { tool: "gone", field: "description", path: [], old: "x", new: "y" }] }, finish: true });
refuses("a list written for another baseline", /was written for baseline/, { baseline: "def5678" });
{
  const listed = clone(LIST);
  listed.entries[3] = { ...listed.entries[3], old: "wrong old" };
  refuses("an old value that is not what the baseline holds", /holds exactly the old value/, { list: listed });
}
{
  const pins = (write("t", LIST), loadPinPatches("t", { baseline: "abc1234", dir: tmp }));
  const head = headTool();
  pins.check(new Map([["plan", baseTool()]]), new Map([["plan", head]]), "mutation");
  assert.equal(JSON.stringify(head), JSON.stringify(headTool()), "checking never changes the head it is given");
  check("the head's own definitions are not modified by a check");
}

// ---- the approved change of registration: newsroom_illustration_generate, and only that tool, and only in the environment that leaves it out ----
{
  const illustration = () => ({ name: "newsroom_illustration_generate", description: "Generate an illustration." });
  const baseSet = () => new Map([baseTool(), other(), illustration()].map((t) => [t.name, t]));
  const headSet = () => new Map([headTool(), other()].map((t) => [t.name, t]));
  const names = (m) => (m instanceof Map ? [...m.keys()] : Object.keys(m));
  const runSets = (base, head) => { write("t", LIST); loadPinPatches("t", { baseline: "abc1234", dir: tmp }).check(base, head, "reg"); };
  assert.deepEqual(names(withoutApprovedIllustration(baseSet(), {})), ["plan", other().name], "default: only the illustration tool is left out");
  assert.deepEqual(names(withoutApprovedIllustration(baseSet(), { NEWSROOM_REFUSED_OPTIONS_FIX: "1" })), ["plan", other().name]);
  assert.deepEqual(names(withoutApprovedIllustration(baseSet(), { NEWSROOM_ILLUSTRATION_ADAPTER: "x" })), ["plan", other().name, "newsroom_illustration_generate"], "with an adapter nothing is left out");
  assert.deepEqual(names(withoutApprovedIllustration(baseSet(), { NEWSROOM_REFUSED_OPTIONS_FIX: "0" })), ["plan", other().name, "newsroom_illustration_generate"], 'at "0" nothing is left out');
  assert.deepEqual(names(withoutApprovedIllustration(baseSet(), { NEWSROOM_ILLUSTRATION_ADAPTER: "  " })), ["plan", other().name], "a blank adapter is no adapter");
  assert.deepEqual(names(withoutApprovedIllustration(Object.fromEntries(baseSet()), {})), ["plan", other().name], "a plain object works too");
  runSets(withoutApprovedIllustration(baseSet(), {}), headSet());
  check("passes: the head without the illustration tool, by default");
  assert.throws(() => runSets(baseSet(), headSet()), /the same tools are registered/, "unreduced, the missing tool is still refused");
  check("refused: the illustration tool missing from the head when nothing approved the gap");
  assert.throws(() => runSets(withoutApprovedIllustration(baseSet(), { NEWSROOM_REFUSED_OPTIONS_FIX: "0" }), headSet()), /the same tools are registered/);
  check('refused: the illustration tool missing from the head at "0"');
  const missingOther = new Map([...headSet()].filter(([name]) => name !== other().name));
  assert.throws(() => runSets(withoutApprovedIllustration(baseSet(), {}), missingOther), /the same tools are registered/, "a different tool removed still fails");
  check("refused: any other tool missing from the head still fails, even where the illustration tool may be absent");
  // an unused entry: exempt for the illustration tool only after the approved gap was applied and none of its entries was used
  const stale = (tool) => ({ ...LIST, entries: [...LIST.entries, { tool, field: "description", path: [], old: "x", new: "y", commit: "c" }] });
  const staleRun = (tool) => { write("t", stale(tool)); const pins = loadPinPatches("t", { baseline: "abc1234", dir: tmp }); pins.check(withoutApprovedIllustration(baseSet(), {}), headSet(), "reg"); pins.finish(); };
  staleRun("newsroom_illustration_generate");
  check("passes: an entry for the illustration tool that no registered tool exercised, after the approved gap");
  assert.throws(() => staleRun("some_other_tool"), /every listed change was exercised/);
  check("refused: an unused entry for any other tool still fails");
  const reduced = withoutApprovedIllustration(new Map([baseTool(), other()].map((t) => [t.name, t])), {});
  assert.deepEqual(names(reduced), ["plan", other().name], "no illustration tool in the baseline: nothing changes");
}

// ---- the approved gap covers only the run that saw it ----
{
  const baseSet = () => new Map([baseTool(), other(), { name: "newsroom_illustration_generate", description: "Generate an illustration." }].map((t) => [t.name, t]));
  const headSet = () => new Map([headTool(), other()].map((t) => [t.name, t]));
  const staleList = { ...LIST, entries: [...LIST.entries, { tool: "newsroom_illustration_generate", field: "description", path: [], old: "x", new: "y", commit: "c" }] };
  const run = (reduce) => { write("t", staleList); const pins = loadPinPatches("t", { baseline: "abc1234", dir: tmp }); pins.check(reduce ? withoutApprovedIllustration(baseSet(), {}) : new Map([...baseSet()].filter(([n]) => n !== "newsroom_illustration_generate")), headSet(), "reg"); pins.finish(); };
  run(true);
  assert.throws(() => run(false), /every listed change was exercised/);
  check("refused: a second run in the same process with an unused illustration entry, when only the first saw the gap");
}

// ---- presence of a key is its own property, not an inherited name ----
{
  const mk = (flag) => ({ name: "p", description: "d", promptSnippet: "s", promptGuidelines: ["one"],
    parameters: { type: "object", properties: { a: { type: "string" }, ...(flag ? { constructor: { type: "string" } } : {}), c: { type: "string" } }, required: ["a"] }, execute() {} });
  const entry = { tool: "p", field: "parameters", path: ["properties", "constructor"], old: { type: "string" }, after: "a", commit: "c" };
  write("t", { baseline: "abc1234", entries: [entry] });
  const pins = loadPinPatches("t", { baseline: "abc1234", dir: tmp });
  pins.check(new Map([["p", mk(true)]]), new Map([["p", mk(false)]]), "inherited");
  pins.finish();
  check('passes: a removed property named "constructor" goes back at its own position (after "a"), as any other key does');
}

// ---- a removed value goes back where it stood (the entry's "at" and "after") ----------------------------------------------------------------------
{
  const mk = (flag) => ({ name: "p", description: "d", promptSnippet: "s", promptGuidelines: ["one", "two", "three"],
    parameters: { type: "object", properties: { a: { type: "string" }, ...(flag ? { b: { type: "string" } } : {}), c: { type: "string" } }, required: ["a"] }, execute() {} });
  const entries = [
    { tool: "p", field: "parameters", path: ["properties", "b"], old: { type: "string" }, after: "a", commit: "c" },
    { tool: "p", field: "promptGuidelines", old: "two", at: 1, commit: "c" },
  ];
  const head = mk(false); head.promptGuidelines = ["one", "three"];
  const go = (list, h) => { write("t", { baseline: "abc1234", entries: list }); const pins = loadPinPatches("t", { baseline: "abc1234", dir: tmp }); pins.check(new Map([["p", mk(true)]]), new Map([["p", h]]), "pos"); pins.finish(); };
  go(entries, head);
  check("passes: removed property and guideline are restored in their baseline position");
  assert.throws(() => go(entries.map((e) => (e.after ? { ...e, after: "c" } : e)), head), /byte-identical/);
  check("refused: a removed property restored in another position");
  assert.throws(() => go(entries.map((e) => (e.at === undefined ? e : { ...e, at: 0 })), head), /byte-identical/);
  check("refused: a removed guideline restored at another index");
}

// ---- an entry with "switch": the change exists only while that switch is not exactly "0" -------------------------------------------------------------
{
  const SW = "PIN_PATCH_TEST_SWITCH";
  const outer = process.env[SW];
  const entries = LIST.entries.map((e, i) => (i === 3 ? { ...e, switch: SW } : e));
  const withEnv = (value, fn) => {
    const saved = process.env[SW];
    if (value === undefined) delete process.env[SW]; else process.env[SW] = value;
    try { return fn(); } finally { if (saved === undefined) delete process.env[SW]; else process.env[SW] = saved; }
  };
  const offHead = () => { const h = headTool(); h.parameters.properties.names.description = "old wording"; return h; };
  const go = (head) => run({ list: { ...LIST, entries }, head: [head, other()] });
  withEnv(undefined, () => go(headTool()));
  check("passes: a switched entry with the switch unset needs the new value in the head");
  withEnv("1", () => go(headTool()));
  check('passes: a switched entry with the switch at "1" needs the new value in the head');
  withEnv("0", () => go(offHead()));
  check('passes: a switched entry with the switch at "0" needs the old value in the head');
  assert.throws(() => withEnv("0", () => go(headTool())), /holds exactly the old value/);
  check('refused: the new value in the head while its switch is "0"');
  assert.throws(() => withEnv(undefined, () => go(offHead())), /holds exactly the new value/);
  check("refused: the old value in the head while its switch is not off");
  assert.throws(() => withEnv("", () => go(offHead())), /holds exactly the new value/);
  check('refused: a blank switch is not "0"');
  // the switch off must not hide any other change in that tool
  assert.throws(() => withEnv("0", () => { const h = offHead(); h.description = "Plan a chart!"; go(h); }), /byte-identical/);
  check('refused: an unlisted change in a tool whose switched entry is off ("0")');
  // an entry that names no switch is never switched off
  assert.throws(() => withEnv("0", () => run({ list: LIST, head: [offHead(), other()] })), /holds exactly the new value/);
  check('refused: an entry without a switch ignores the environment');
  assert.equal(process.env[SW], outer, "the test left the environment as it found it");
}

// ---- restoring several values, the first property, and a position that is gone ------------------------------------------------------------------
{
  const mk = (names) => ({ name: "q", description: "d", promptSnippet: "s", promptGuidelines: names,
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } }, required: [] }, execute() {} });
  const base = () => mk(["g0", "g1", "g2", "g3", "g4"]);
  const go = (list, head) => { write("t", { baseline: "abc1234", entries: list }); const p = loadPinPatches("t", { baseline: "abc1234", dir: tmp }); p.check(new Map([["q", base()]]), new Map([["q", head]]), "multi"); p.finish(); };
  const gone = (text, at) => ({ tool: "q", field: "promptGuidelines", old: text, at, commit: "c" });
  const apart = mk(["g0", "g2", "g4"]);
  go([gone("g1", 1), gone("g3", 3)], apart);
  check("passes: two removed guidelines, apart, each back at its own index");
  const next = mk(["g0", "g3", "g4"]);
  go([gone("g1", 1), gone("g2", 2)], next);
  check("passes: two adjacent removed guidelines restored in order");
  const first = mk(["g1", "g2", "g3", "g4"]);
  go([gone("g0", 0)], first);
  check("passes: a removed first guideline goes back to index 0");
  assert.throws(() => go([gone("g1", 1), gone("g3", 3)], mk(["g0", "g2", "g4", "g9"])), /byte-identical/);
  check("refused: restoring two guidelines leaves an unlisted guideline in the head");
  // removed properties: first position (after: null), and several at once
  const prop = (key, after) => ({ tool: "q", field: "parameters", path: ["properties", key], old: { type: "string" }, after, commit: "c" });
  const withProps = (keys) => { const h = mk(base().promptGuidelines); h.parameters.properties = Object.fromEntries(keys.map((k) => [k, { type: "string" }])); return h; };
  go([prop("a", null)], withProps(["b", "c"]));
  check("passes: a removed first property (after: null) goes back first");
  go([prop("a", null), prop("c", "b")], withProps(["b"]));
  check("passes: a removed first and a removed last property are both restored in place");
  go([prop("b", "a"), prop("c", "b")], withProps(["a"]));
  check("passes: two removed neighbours restored in order (the second follows the first)");
  assert.throws(() => go([prop("a", "c")], withProps(["b", "c"])), /byte-identical/);
  check("refused: a first property restored after another key");
  assert.throws(() => go([prop("b", "zzz")], withProps(["a", "c"])), /byte-identical/);
  check('refused: an "after" key that is not in the head (the property cannot be placed)');
}

// ---- a head with one more registered tool than the reduced baseline ----------------------------------------------------------------------------
{
  const illustration = () => ({ name: "newsroom_illustration_generate", description: "Generate an illustration." });
  const baseSet = () => new Map([baseTool(), other(), illustration()].map((t) => [t.name, t]));
  const withIllustration = new Map([headTool(), other(), illustration()].map((t) => [t.name, t]));
  write("t", LIST);
  const pins = loadPinPatches("t", { baseline: "abc1234", dir: tmp });
  assert.throws(() => pins.check(withoutApprovedIllustration(baseSet(), {}), withIllustration, "extra"), /the same tools are registered/);
  check("refused: the head registers the illustration tool but the default baseline leaves it out");
  pins.check(withoutApprovedIllustration(baseSet(), { NEWSROOM_ILLUSTRATION_ADAPTER: "x" }), withIllustration, "adapter");
  check("passes: the illustration tool in both, when an adapter is set");
}

// ---- every committed list is well formed ---------------------------------------------------------------------------
const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "pin_patches");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
assert.deepEqual(FILES, ["compact_setup.json", "editorial_hints.json", "flow_extent_hint.json", "flow_maps_back.json", "page_inline_claim.json", "reader_task_example_fix.contract_text.json", "reader_task_example_fix.json", "refused_options_fix.json", "speed_prompt_hints_runtime.json", "viz_report_all.json"]);
for (const file of FILES) {
  const list = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  assert.match(list.baseline, /^[0-9a-f]{7,40}$/, `${file}: baseline`);
  const seen = new Set();
  for (const entry of list.entries) {
    assert.match(String(entry.commit), /^[0-9a-f]{7,40}(,[0-9a-f]{7,40})*$/, `${file}: ${entry.tool} ${entry.path?.join(".") ?? entry.field} names the merged commit(s) that made it`);
    const key = JSON.stringify([entry.tool, entry.field, entry.path ?? null, entry.old ?? null, entry.new ?? null]);
    assert.ok(!seen.has(key), `${file}: no duplicate entry`);
    seen.add(key);
    assert.notDeepEqual(entry.old, entry.new, `${file}: an entry changes something`);
  }
}
check(`lists: ${FILES.length} files, each with its baseline, a merged commit on every entry, and no duplicate or empty entry`);

console.log(`${results.length} checks passed:`);
for (const r of results) console.log(`  PASS ${r}`);
