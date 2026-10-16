#!/usr/bin/env node
// #64 step 4: NEWSROOM_GROUP_TOOLS is on by default: exactly "0" is off, exactly "1" is on, anything else follows the effective refusal switch (ENFORCE). A leftover HANDOFF value is ignored.
// Checks, with the table's own rows as fixtures:
// 1. nothing set: a declared child-process call that writes an undeclared file is refused and the file is deleted again (the per-tool check is really on).
// 2. TOOLS="0": the same call runs unchanged (no judgement); the other values ("", "false", " 0", "00", "no", "yes", "true") do not turn it off.
// 3. one rule over the matrix TOOLS x ENFORCE x HANDOFF: groupToolsEnabled equals the expected answer.
// 4. dependency rules at start-up (assertGroupToolsSwitches, and the real registration of newsroom.ts):
//    nothing set starts; ENFORCE "0" alone starts (tools off); a leftover HANDOFF "0" starts and changes nothing;
//    TOOLS=1 with the refusal off (ENFORCE "0") stops with GROUP_TOOLS_NEEDS_ENFORCE; TOOLS "0" starts.
// 5. TOOLS_HASH_ALL=1 with nothing else set passes its "needs TOOLS" check (its default stays off); with TOOLS "0" or the refusal off it stops with GROUP_TOOLS_HASH_ALL_NEEDS_TOOLS.
// Not covered here: the run-end line naming TOOLS "0" and the start-up note (src/artifact.rs and src/group_guard.rs tests).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE_ENV, loadTree, register } from "./lib_page_chain_fixture.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("group-tools-default-");
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const clearSwitches = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_")) delete process.env[name]; process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; /* the off-table call refusal is on by default; this test is about something else, so both are pinned off */ };
clearSwitches();
const g = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const ENFORCE = "NEWSROOM_GROUP_ENFORCE", HANDOFF = "NEWSROOM_GROUP_HANDOFF", TOOLS = "NEWSROOM_GROUP_TOOLS", HASH_ALL = "NEWSROOM_GROUP_TOOLS_HASH_ALL";
const set = (values) => { clearSwitches(); for (const [name, value] of Object.entries(values)) process.env[name] = value; };
const results = [];
const ok = (text) => results.push(text);
let seq = 0;
const newRun = () => { const dir = join(scratch, `run-${++seq}`); mkdirSync(dir, { recursive: true }); return dir; };

// fixtures from the table: a visual tool that declares nothing, and a file it writes into the run folder
const TOOL = "newsroom_viz_render";
assert.equal(list.tools[TOOL].group, "visual");
const stray = (dir, ran) => g.runInTool(TOOL, () => g.runDeclared(dir, [], async () => { ran.count += 1; writeFileSync(join(dir, "stray.csv"), "x"); }).catch((e) => e));

// 1. nothing set: the undeclared file is refused and deleted
{
  set({});
  const dir = newRun();
  const ran = { count: 0 };
  assert.equal(g.groupToolsEnabled(), true);
  const outcome = await stray(dir, ran);
  assert.equal(outcome?.code, "GROUP_TOOLS_REFUSED", `refusal: ${outcome?.message}`);
  assert.equal(ran.count, 1);
  assert.equal(existsSync(join(dir, "stray.csv")), false, "the file is deleted again");
  ok("nothing set: the per-tool check is on, an undeclared file is refused and deleted");
}

// 2. TOOLS="0": no judgement; other values do not turn it off
{
  set({ [TOOLS]: "0" });
  const dir = newRun();
  const ran = { count: 0 };
  assert.equal(g.groupToolsEnabled(), false);
  const outcome = await stray(dir, ran);
  assert.equal(outcome, undefined, "runs unchanged with TOOLS=0");
  assert.equal(existsSync(join(dir, "stray.csv")), true, "nothing judged, nothing deleted");
  for (const other of ["", "false", " 0", "00", "no", "yes", "true"]) {
    set({ [TOOLS]: other });
    assert.equal(g.groupToolsEnabled(), true, `TOOLS=${JSON.stringify(other)}: only exactly "0" turns it off`);
  }
  ok('TOOLS="0": the call runs unchanged and nothing is judged; only the exact value "0" counts');
}

// 3. one rule over the whole matrix
{
  const enforceOn = (e) => e !== "0"; // a leftover HANDOFF value never matters
  for (const t of [undefined, "0", "1", "", "true"]) for (const e of [undefined, "0", "1", "", "true"]) for (const h of [undefined, "0", "1"]) {
    set({ ...(t === undefined ? {} : { [TOOLS]: t }), ...(e === undefined ? {} : { [ENFORCE]: e }), ...(h === undefined ? {} : { [HANDOFF]: h }) });
    const expected = t === "0" ? false : t === "1" ? true : enforceOn(e);
    assert.equal(g.groupToolsEnabled(), expected, `TOOLS=${t} ENFORCE=${e} HANDOFF=${h}`);
  }
  ok("groupToolsEnabled: TOOLS 0 off, 1 on, anything else follows groupEnforceEnabled (TOOLS x ENFORCE x HANDOFF)");
}

// 4. dependency rules at start-up, in the check and in the real registration of newsroom.ts
const { mod } = await loadTree("group-tools-default");
const registerWith = (env) => { set({}); return register(mod, { ...BASE_ENV, NEWSROOM_GROUP_ENFORCE: undefined, NEWSROOM_GROUP_TOOLS: undefined, ...env }); };
{
  set({});
  g.assertGroupToolsSwitches();
  assert.equal(g.groupToolsEnabled(), true, "nothing set: tools on because enforcement is on");
  assert.ok(registerWith({}).size > 50, "nothing set registers");
  for (const env of [{ [ENFORCE]: "0" }, { [TOOLS]: "0" }, { [ENFORCE]: "0", [HANDOFF]: "0" }]) {
    set(env);
    g.assertGroupToolsSwitches();
    assert.equal(g.groupToolsEnabled(), false, JSON.stringify(env));
    assert.ok(registerWith(env).size > 50, `registers ${JSON.stringify(env)}`);
  }
  set({ [HANDOFF]: "0" });
  assert.equal(g.groupEnforceEnabled(), true, "a leftover HANDOFF=0 alone: enforcement stays on");
  assert.equal(g.groupToolsEnabled(), true, "a leftover HANDOFF=0 alone: tools stay on");
  assert.ok(registerWith({ [TOOLS]: "1", [HANDOFF]: "0" }).size > 50, "TOOLS=1 with a leftover HANDOFF=0 registers");
  for (const env of [{ [TOOLS]: "1", [ENFORCE]: "0" }]) {
    set(env);
    assert.throws(() => g.assertGroupToolsSwitches(), /GROUP_TOOLS_NEEDS_ENFORCE/, JSON.stringify(env));
    assert.throws(() => registerWith(env), /GROUP_TOOLS_NEEDS_ENFORCE/, `registration ${JSON.stringify(env)}`);
  }
  set({ [TOOLS]: "1" });
  g.assertGroupToolsSwitches();
  ok('nothing set / ENFORCE 0 / TOOLS 0 / a leftover HANDOFF 0 all start; TOOLS=1 with the refusal off stops with GROUP_TOOLS_NEEDS_ENFORCE');
}

// 5. HASH_ALL: its own default stays off; the "needs TOOLS" check is met by the new default
{
  set({ [HASH_ALL]: "1" });
  assert.equal(g.groupToolsHashAllEnabled(), true);
  g.assertGroupToolsSwitches();
  set({});
  assert.equal(g.groupToolsHashAllEnabled(), false, "HASH_ALL stays default off");
  for (const env of [{ [HASH_ALL]: "1", [TOOLS]: "0" }, { [HASH_ALL]: "1", [ENFORCE]: "0" }]) {
    set(env);
    assert.throws(() => g.assertGroupToolsSwitches(), /GROUP_TOOLS_HASH_ALL_NEEDS_TOOLS/, JSON.stringify(env));
  }
  ok("HASH_ALL=1 alone passes its needs-TOOLS check; with TOOLS 0 or the refusal off it stops; its default stays off");
}

rmSync(scratch, { recursive: true, force: true });
console.log(results.map((r) => `ok - ${r}`).join("\n"));
