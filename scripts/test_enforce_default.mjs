#!/usr/bin/env node
// #64 step 3: NEWSROOM_GROUP_ENFORCE is on unless exactly "0". Checks, with the table's own rows as fixtures:
// 1. nothing set: a cross-group registered write (a visual tool writing a knowledge path) is refused, and leaves no file; the owner's own write passes.
// 2. ENFORCE="0": the same write goes through (the call record may still note it, nothing is refused).
// 3. HANDOFF="0" with ENFORCE unset: nothing is enforced (the default does not apply without the hand-off), any other ENFORCE value than "0" or "1" follows the same rule as unset.
// 4. ENFORCE=1 with HANDOFF="0" stops at start-up: newsroom.ts is really registered (the shared register helper), so the stop runs; the Rust side is tested in group_guard.rs.
// 5. TOOLS=1 needs the refusal: met by default; stops with GROUP_TOOLS_NEEDS_ENFORCE when ENFORCE is "0" and when HANDOFF is "0" with ENFORCE unset (as the Rust side).
// 6. art_direction.mjs uses groupEnforceEnabled itself (one rule): programRecordsMode equals it over ENFORCE x HANDOFF.
// Not covered here: a not_measured hand-off pair that is reached (scripts/test_node_handoff_fixture.mjs runs those with ENFORCE=1 explicitly).
// The run-end line that names a switch turned off is made by the Rust side (artifact.rs) and tested there.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE_ENV, loadTree, register } from "./lib_page_chain_fixture.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("enforce-default-");
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const clearSwitches = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_")) delete process.env[name]; };
clearSwitches();
const g = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const art = await import(pathToFileURL(join(ROOT, "runtime/pi/art_direction.mjs")).href);
const ENFORCE = "NEWSROOM_GROUP_ENFORCE", HANDOFF = "NEWSROOM_GROUP_HANDOFF", TOOLS = "NEWSROOM_GROUP_TOOLS";
const set = (values) => { clearSwitches(); for (const [name, value] of Object.entries(values)) process.env[name] = value; };
const results = [];
const ok = (text) => results.push(text);
let seq = 0;
const newRun = () => { const dir = join(scratch, `run-${++seq}`); mkdirSync(dir, { recursive: true }); return dir; };

// fixtures from the table: a visual tool and a knowledge path it does not own; the knowledge owner of that path
const VISUAL_TOOL = "newsroom_viz_plan", KNOWLEDGE_PATH = "computations/x.json", OWNER_TOOL = "duckdb_query";
assert.equal(list.tools[VISUAL_TOOL].group, "visual");
assert.equal(list.tools[OWNER_TOOL].group, "knowledge");
const write = (dir, tool, path) => g.runInTool(tool, () => g.recordBoundaryWrite(dir, path, "write_if_absent"));
const refused = (dir, tool, path) => { try { write(dir, tool, path); return false; } catch (error) { assert.equal(error?.name, "BoundaryRefusal", `refusal type: ${error?.message}`); return true; } };

// 1. nothing set: refused, and the owner's write passes
{
  set({});
  const dir = newRun();
  assert.equal(g.groupEnforceEnabled(), true);
  assert.equal(refused(dir, VISUAL_TOOL, KNOWLEDGE_PATH), true, "cross-group write refused with nothing set");
  assert.equal(refused(dir, OWNER_TOOL, KNOWLEDGE_PATH), false, "the owner's own write passes");
  assert.equal(art.programRecordsMode(), true, "the program-records mode follows the same default");
  assert.ok(existsSync(join(dir, "runtime/boundary-refusals.jsonl")), "the refusal is recorded");
  ok("nothing set: a cross-group write is refused and recorded, the owner's write passes");
}

// 2. ENFORCE="0": the same write goes through
{
  set({ [ENFORCE]: "0" });
  const dir = newRun();
  assert.equal(g.groupEnforceEnabled(), false);
  assert.equal(refused(dir, VISUAL_TOOL, KNOWLEDGE_PATH), false, "not refused with ENFORCE=0");
  assert.equal(existsSync(join(dir, "runtime/boundary-refusals.jsonl")), false, "no refusal record");
  assert.equal(art.programRecordsMode(), false);
  for (const other of ["", "false", " 0", "00", "no", "yes", "true"]) {
    set({ [ENFORCE]: other });
    assert.equal(g.groupEnforceEnabled(), true, `ENFORCE=${JSON.stringify(other)}: only exactly "0" turns it off`);
  }
  ok('ENFORCE="0": the write goes through and nothing is recorded as refused; only the exact value "0" counts');
}

// 3. HANDOFF="0" with ENFORCE unset (or any value but "1"): nothing enforced
{
  for (const extra of [{}, { [ENFORCE]: "" }, { [ENFORCE]: "true" }]) {
    set({ [HANDOFF]: "0", ...extra });
    const dir = newRun();
    assert.equal(g.groupEnforceEnabled(), false, `off with the hand-off at 0 and ${JSON.stringify(extra)}`);
    assert.equal(refused(dir, VISUAL_TOOL, KNOWLEDGE_PATH), false);
    assert.equal(art.programRecordsMode(), false);
  }
  set({ [HANDOFF]: "0", [ENFORCE]: "1" });
  assert.equal(g.groupEnforceEnabled(), true, "an explicit ENFORCE=1 stays on (and newsroom.ts stops at start-up, see 4)");
  set({ [HANDOFF]: "1" });
  assert.equal(g.groupEnforceEnabled(), true);
  ok('HANDOFF="0" with ENFORCE unset: nothing is enforced; ENFORCE=1 stays explicit');
}

// 4. the start-up stop of newsroom.ts for ENFORCE=1 with HANDOFF="0" runs for real: the extension is registered with the shared helper
const { mod } = await loadTree("enforce-default");
const registerWith = (env) => { set({}); return register(mod, { ...BASE_ENV, NEWSROOM_GROUP_ENFORCE: undefined, NEWSROOM_GROUP_HANDOFF: undefined, NEWSROOM_GROUP_TOOLS: undefined, ...env }); };
{
  assert.throws(() => registerWith({ [ENFORCE]: "1", [HANDOFF]: "0" }), /GROUP_ENFORCE_NEEDS_HANDOFF/);
  assert.ok(registerWith({}).size > 50, "nothing set registers");
  assert.ok(registerWith({ [HANDOFF]: "0" }).size > 50, "HANDOFF=0 with ENFORCE unset registers (nothing is enforced)");
  assert.ok(registerWith({ [ENFORCE]: "0", [HANDOFF]: "0" }).size > 50);
  ok('ENFORCE=1 with HANDOFF=0 stops newsroom.ts at start-up (really registered); HANDOFF=0 alone does not');
}

// 5. TOOLS=1: met by default; stops when ENFORCE is "0" and when the hand-off is "0" with ENFORCE unset, in the start-up check and in the real registration
{
  set({ [TOOLS]: "1" });
  g.assertGroupToolsSwitches();
  set({ [TOOLS]: "1", [ENFORCE]: "1" });
  g.assertGroupToolsSwitches();
  for (const env of [{ [TOOLS]: "1", [ENFORCE]: "0" }, { [TOOLS]: "1", [HANDOFF]: "0" }]) {
    set(env);
    assert.throws(() => g.assertGroupToolsSwitches(), /GROUP_TOOLS_NEEDS_ENFORCE/, JSON.stringify(env));
    assert.throws(() => registerWith(env), /GROUP_TOOLS_NEEDS_ENFORCE/, `registration ${JSON.stringify(env)}`);
  }
  assert.ok(registerWith({ [TOOLS]: "1" }).size > 50, "TOOLS=1 alone registers");
  ok('TOOLS=1 starts by default and stops with GROUP_TOOLS_NEEDS_ENFORCE for ENFORCE="0" and for HANDOFF="0" with ENFORCE unset');
}

// 6. one rule: programRecordsMode (art_direction.mjs) follows groupEnforceEnabled over the whole matrix
{
  for (const e of [undefined, "0", "1", "", "true"]) for (const h of [undefined, "0", "1"]) {
    set({ ...(e === undefined ? {} : { [ENFORCE]: e }), ...(h === undefined ? {} : { [HANDOFF]: h }) });
    assert.equal(art.programRecordsMode(), g.groupEnforceEnabled(), `ENFORCE=${e} HANDOFF=${h}`);
  }
  ok("programRecordsMode equals groupEnforceEnabled for ENFORCE x HANDOFF");
}

rmSync(scratch, { recursive: true, force: true });
console.log(results.map((r) => `ok - ${r}`).join("\n"));
