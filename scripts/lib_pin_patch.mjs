// Exact patch lists for the byte-pin tests.
//
// A pin test compares the tool definitions the head registers with the ones an older commit registered. Some differences are approved on
// purpose. Each one is one entry of a list (scripts/fixtures/pin_patches/<test>.json): tool, field, path inside the field, the exact old value
// (omitted = absent), the exact new value (omitted = absent), and the merged commit that made the change. For every tool a profile registers:
//   1. each entry must hold exactly: the baseline has the old value at the path and the head has the new one;
//   2. the list is reversed on a copy of the head, and the whole definition must then equal the baseline's byte for byte
//      (JSON.stringify of everything but the functions, so key order counts).
// A tool without entries must be byte-equal as it is. There is no replacer, no regex and no prefix match: a value that differs in any way
// other than the listed one fails. A list entry that no registered tool ever exercised fails too (finish()), so a stale entry cannot stay.
//
// An entry may carry "switch": "<switch name>". The change then exists only while that switch is not exactly "0"; at "0" the head must hold the old value.
//
// PIN_PATCH_RECORD=<dir> turns check() into a recorder: it collects the exact differences it sees and finish() writes <dir>/<name>.json. Used once
// to write the lists from the baseline and head definitions (every string comes from the two sources, none is typed); never set in CI.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIELDS = ["description", "promptSnippet", "promptGuidelines", "parameters"];
const GUIDELINES = "promptGuidelines";
const LIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pin_patches");
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const json = (x) => JSON.stringify(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const has = (entry, key) => Object.prototype.hasOwnProperty.call(entry, key);
const where = (entry) => `${entry.tool} ${entry.field}${entry.path ? `.${entry.path.join(".")}` : ""}`;

/**
 * The one approved change of default since the older baselines: the visual-story profile never offers the two Lieflat tools, and the
 * visual-skill enum loses "lieflat-charts" with them. Reduces an older commit's visual-story definitions (a Map or a plain object keyed by
 * tool name) by exactly that, so that everything else is still compared byte for byte. Other profiles are returned as they are.
 */
export function withoutApprovedLieflat(definitions, profile) {
  if (profile !== "visual-story") return definitions;
  const dropEnum = (node) => (Array.isArray(node) ? node.map(dropEnum) : node && typeof node === "object" ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "enum" && Array.isArray(v) ? v.filter((x) => x !== "lieflat-charts") : dropEnum(v)])) : node);
  const keep = ([name]) => !name.startsWith("newsroom_lieflat_");
  const fix = ([name, tool]) => [name, name === "newsroom_visual_skill" ? { ...tool, parameters: dropEnum(tool.parameters) } : tool];
  if (definitions instanceof Map) return new Map([...definitions].filter(keep).map(fix));
  return Object.fromEntries(Object.entries(definitions).filter(keep).map(fix));
}

/**
 * The approved change of registration (NEWSROOM_REFUSED_OPTIONS_FIX): newsroom_illustration_generate is registered only when an illustration
 * adapter is configured, or when that switch is exactly "0". Reduces an older commit's definitions (a Map or a plain object keyed by tool name)
 * by exactly that one tool, and only in the environment where the head leaves it out. With an adapter, or with the switch at "0", nothing is
 * dropped, and any other tool missing from the head still fails the same-tools check.
 */
const approvedGap = new Set();
export function withoutApprovedIllustration(definitions, env = process.env) {
  const registered = String(env.NEWSROOM_ILLUSTRATION_ADAPTER ?? "").trim() !== "" || env.NEWSROOM_REFUSED_OPTIONS_FIX === "0";
  if (registered) return definitions;
  const keep = ([name]) => name !== "newsroom_illustration_generate";
  if ((definitions instanceof Map ? definitions.has("newsroom_illustration_generate") : "newsroom_illustration_generate" in definitions)) approvedGap.add("newsroom_illustration_generate");
  if (definitions instanceof Map) return new Map([...definitions].filter(keep));
  return Object.fromEntries(Object.entries(definitions).filter(keep));
}

/** The model-visible definition: every non-function field, as the tests compare it (key order included). */
export const definitionOf = (tool) => json(tool);

function valueAt(root, path) {
  let node = root;
  for (const key of path) {
    if (!isObj(node) && !Array.isArray(node)) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(node, key)) return { found: false };
    node = node[key];
  }
  return { found: true, value: node };
}

function parentAt(root, path) {
  const parent = valueAt(root, path.slice(0, -1));
  assert.ok(parent.found && (isObj(parent.value) || Array.isArray(parent.value)), `the parent of ${path.join(".")} exists`);
  return parent.value;
}

// ---- recording ---------------------------------------------------------------------------------------------------------------------------
function recordDiff(out, tool, field, path, a, b, pos) {
  if (json(a) === json(b)) return;
  if (field === GUIDELINES && Array.isArray(a) && Array.isArray(b)) {
    const inA = new Set(a), inB = new Set(b);
    const added = b.filter((entry) => !inA.has(entry)), removed = a.filter((entry) => !inB.has(entry));
    for (const oldText of [...removed]) {
      // a guideline that was reworded keeps its first words: pair it with the new text, so the entry is a change and not two
      const at = added.findIndex((entry) => entry.slice(0, 24) === oldText.slice(0, 24));
      if (at < 0) continue;
      out.push({ tool, field, old: oldText, new: added[at] });
      added.splice(at, 1);
      removed.splice(removed.indexOf(oldText), 1);
    }
    for (const text of removed) out.push({ tool, field, old: text, at: a.indexOf(text) });
    for (const text of added) out.push({ tool, field, new: text });
    return;
  }
  if (isObj(a) && isObj(b)) {
    const keysA = Object.keys(a);
    for (const key of new Set([...keysA, ...Object.keys(b)])) {
      const at = keysA.indexOf(key);
      recordDiff(out, tool, field, [...path, key], a[key], b[key], { after: at > 0 ? keysA[at - 1] : null });
    }
    return;
  }
  // Arrays of objects of the same length (a stand-in schema keeps the builder's arguments as an array) are compared element by element, so an entry
  // names the one property that changed; every other array (enum values, required names, anyOf) is one value.
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => x !== null && typeof x === "object")) {
    a.forEach((x, i) => recordDiff(out, tool, field, [...path, i], x, b[i]));
    return;
  }
  const entry = { tool, field, ...(field === GUIDELINES ? {} : { path }) };
  if (a !== undefined) entry.old = a;
  if (b !== undefined) entry.new = b;
  // a removed property or guideline goes back where it stood, not at the end: the record keeps the key it followed
  if (b === undefined && pos && field !== GUIDELINES) entry.after = pos.after;
  out.push(entry);
}

// ---- reversing ---------------------------------------------------------------------------------------------------------------------------
function reverseEntry(surface, entry) {
  if (entry.field === GUIDELINES) {
    const list = surface[GUIDELINES];
    assert.ok(Array.isArray(list), `${where(entry)}: the head has a guideline list`);
    if (has(entry, "new")) {
      const at = list.indexOf(entry.new);
      assert.notEqual(at, -1, `${where(entry)}: the head carries the new guideline`);
      if (has(entry, "old")) list[at] = entry.old; else list.splice(at, 1);
    } else if (Number.isInteger(entry.at)) list.splice(entry.at, 0, entry.old);
    else list.push(entry.old);
    return;
  }
  if (entry.path.length === 0) { if (has(entry, "old")) surface[entry.field] = clone(entry.old); else delete surface[entry.field]; return; }
  const parent = parentAt(surface[entry.field], entry.path), key = entry.path.at(-1);
  if (has(entry, "old") && has(entry, "after") && !Array.isArray(parent) && !(key in parent)) {
    // put the key back right after the one it followed (null: first), so the key order is the baseline's
    const kept = Object.entries(parent);
    for (const k of Object.keys(parent)) delete parent[k];
    if (entry.after === null) parent[key] = clone(entry.old);
    for (const [k, v] of kept) { parent[k] = v; if (k === entry.after) parent[key] = clone(entry.old); }
  } else if (has(entry, "old")) parent[key] = clone(entry.old);
  else if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key];
}

function assertHolds(entry, side, entryTool) {
  const label = `${side}: ${where(entry)}`;
  const want = side === "baseline" ? "old" : "new";
  const other = side === "baseline" ? "new" : "old";
  if (entry.field === GUIDELINES) {
    const list = entryTool[GUIDELINES] ?? [];
    if (has(entry, want)) assert.equal(list.filter((text) => text === entry[want]).length, 1, `${label} carries exactly the ${want} guideline once`);
    else assert.ok(!list.includes(entry[other]), `${label} does not carry the ${other} guideline`);
    if (has(entry, other) && has(entry, want)) assert.ok(!list.includes(entry[other]), `${label} does not carry the ${other} guideline`);
    return;
  }
  const found = valueAt(entryTool[entry.field], entry.path);
  if (has(entry, want)) { assert.ok(found.found, `${label} exists`); assert.equal(json(found.value), json(entry[want]), `${label} holds exactly the ${want} value`); }
  else assert.ok(!found.found, `${label} is absent`);
}

// ---- the patch list --------------------------------------------------------------------------------------------------------------------------
export function loadPinPatches(name, { baseline, dir = LIST_DIR } = {}) {
  const file = join(dir, `${name}.json`);
  const record = process.env.PIN_PATCH_RECORD;
  let list = { baseline, entries: [] };
  if (!record) {
    list = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(Array.isArray(list.entries) && list.entries.length > 0, `${basename(file)} lists entries`);
    if (baseline !== undefined) assert.equal(list.baseline, baseline, `${basename(file)} was written for baseline ${list.baseline}, this test reads ${baseline}`);
    for (const [i, entry] of list.entries.entries()) {
      assert.ok(typeof entry.tool === "string" && FIELDS.includes(entry.field), `${basename(file)} entry ${i}: tool and field`);
      assert.ok(entry.field === GUIDELINES ? !entry.path : Array.isArray(entry.path), `${basename(file)} entry ${i}: path`);
      assert.ok(has(entry, "old") || has(entry, "new"), `${basename(file)} entry ${i} changes something`);
    }
  }
  const used = new Set();
  const recorded = new Map();

  /** base and head are Maps of tool name -> registered tool, for one profile / environment. Returns the names that carried entries. */
  function check(base, head, label) {
    assert.deepEqual([...head.keys()], [...base.keys()], `${label}: the same tools are registered, in the same order`);
    const touched = [];
    for (const [name, headTool] of head) {
      const baseTool = base.get(name);
      if (record) {
        const out = [];
        for (const field of FIELDS) recordDiff(out, name, field, [], baseTool[field], headTool[field]);
        for (const entry of out) recorded.set(json(entry), entry);
        continue;
      }
      const entries = list.entries.filter((entry) => entry.tool === name);
      const surface = JSON.parse(definitionOf(headTool));
      // An entry that names a switch (the change exists only while that switch is not exactly "0"): with the switch at "0" the head must hold the
      // old value, exactly as the baseline does, and there is nothing to reverse; otherwise it is an ordinary entry.
      const switchedOff = (entry) => typeof entry.switch === "string" && process.env[entry.switch] === "0";
      for (const entry of entries) {
        assertHolds(entry, "baseline", baseTool);
        assertHolds(entry, switchedOff(entry) ? "baseline" : "head", headTool);
      }
      // entries that remove a head value go first, so a restored one is put back by its baseline position
      const order = [...entries].sort((x, y) => Number(!has(x, "new")) - Number(!has(y, "new")));
      for (const entry of order) { if (!switchedOff(entry)) reverseEntry(surface, entry); used.add(list.entries.indexOf(entry)); }
      assert.equal(json(surface), definitionOf(baseTool), `${label}: ${name}${entries.length ? ` with its ${entries.length} listed change(s) reversed` : ""} is byte-identical to the baseline`);
      if (entries.length) touched.push(name);
    }
    return touched;
  }

  function finish() {
    if (record) {
      mkdirSync(record, { recursive: true });
      writeFileSync(join(record, `${name}.json`), json({ baseline, entries: [...recorded.values()] }));
      return;
    }
    // The one approved gap: while the illustration tool is left out of the head, a test that never saw it registered has nothing to exercise
    // for it. Its entries are exempt only when none of them was used; every other tool's unused entry still fails.
    const gapTool = (entry) => approvedGap.has(entry.tool) && !list.entries.some((e, i) => e.tool === entry.tool && used.has(i));
    const idle = list.entries.filter((entry, i) => !used.has(i) && !gapTool(entry)).map(where);
    assert.deepEqual(idle, [], `${name}: every listed change was exercised by a registered tool`);
  }
  return { check, finish, entries: list.entries };
}
