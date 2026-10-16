// The exact patch lists of the byte-pin tests (scripts/lib_pin_patch.mjs): the engine must pass a head that differs from its baseline only by the
// listed changes, and must fail on everything else; every committed list must be well formed.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPinPatches } from "./lib_pin_patch.mjs";

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

// ---- every committed list is well formed ---------------------------------------------------------------------------
const DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "pin_patches");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
assert.deepEqual(FILES, ["compact_setup.json", "editorial_hints.json", "flow_extent_hint.json", "flow_maps_back.json", "page_inline_claim.json", "reader_task_example_fix.json", "refused_options_fix.json", "shadow_parity.json", "speed_prompt_hints_runtime.json", "viz_report_all.json"]);
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
