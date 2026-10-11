#!/usr/bin/env node
// K214 part C: the run-time gate for the knowledge entry functions (groups.json cross_calls.gated).
// With NEWSROOM_GROUP_ENFORCE=1 a gated function lets a knowledge tool through, lets a group through that its cross_calls line lists, and refuses
// every other tool, a tool without a group, and a table line that is missing. With the switch off it does nothing. A refusal is logged to
// runtime/boundary-refusals.jsonl. Also: every gated name is a line of the table and starts with its assertCrossCall in newsroom.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";
import { BoundaryRefusal, REFUSAL_LOG_PATH, assertCrossCall, crossCallProblem, runInTool } from "../runtime/pi/groups.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const table = list.cross_calls;
const toolOf = (group) => Object.keys(list.tools).find((t) => list.tools[t].group === group);

// every gated name: a table line, and the first statement of its function in newsroom.ts
const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
assert.ok(table.gated.length >= 5, "the gated list is not empty");
for (const name of table.gated) {
  assert.ok(table.functions[name], `${name} has a cross_calls line`);
  const call = `assertCrossCall(artifactRoot(), "${name}")`;
  assert.ok(src.includes(call), `${name} starts with ${call}`);
}

// the decision
const knowledge = toolOf("knowledge"), visual = toolOf("visual"), system = toolOf("system");
assert.equal(crossCallProblem(list, "queryDuckDb", knowledge), null, "same group passes");
assert.equal(crossCallProblem(list, "queryDuckDb", null), null, "no asking tool (a command) passes");
assert.equal(crossCallProblem(list, "notGated", visual), null, "an ungated name passes");
assert.equal(crossCallProblem(list, "recordClaimArtifact", visual), null, "a listed group passes");
assert.match(crossCallProblem(list, "recordClaimArtifact", system) ?? "", /not listed/, "a group the line does not list is refused");
assert.match(crossCallProblem(list, "recordClaimArtifact", "no_such_tool") ?? "", /no group/, "a tool without a group is refused");
const trimmed = structuredClone(list);
trimmed.cross_calls.functions.recordClaimArtifact.groups = ["agent"];
assert.match(crossCallProblem(trimmed, "recordClaimArtifact", visual) ?? "", /not listed/, "taking a group off the line refuses it");
delete trimmed.cross_calls.functions.recordClaimArtifact;
assert.match(crossCallProblem(trimmed, "recordClaimArtifact", visual) ?? "", /not listed/, "a missing line refuses");

// the switch and the log
const root = makeTestTmp("cross-call-gate-");
delete process.env.NEWSROOM_GROUP_ENFORCE;
runInTool(system, () => assertCrossCall(root, "recordClaimArtifact"));
assert.ok(!existsSync(join(root, REFUSAL_LOG_PATH)), "switch off: nothing happens, nothing logged");
process.env.NEWSROOM_GROUP_ENFORCE = "1";
runInTool(visual, () => assertCrossCall(root, "recordClaimArtifact"));
assert.throws(() => runInTool(system, () => assertCrossCall(root, "recordClaimArtifact")), (e) => e instanceof BoundaryRefusal && e.detail.status === "cross_call_not_listed");
const logged = readFileSync(join(root, REFUSAL_LOG_PATH), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(logged.length, 1);
assert.equal(logged[0].op, "cross_call");
assert.equal(logged[0].tool, system);
delete process.env.NEWSROOM_GROUP_ENFORCE;
rmSync(root, { recursive: true, force: true });
console.log("group cross-call gate -- PASS");
