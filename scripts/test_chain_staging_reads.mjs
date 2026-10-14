#!/usr/bin/env node
// K241: a step of a tool chain must read what the chain's earlier, finished steps staged (plan -> lint), while a parallel sibling step and any other
// call stay invisible and a call outside a staged run is unchanged. The evidence checks are not loosened: only the set of staging folders a call may read grows.
// 1011aj step 8: reads that may follow a write in the same staged call. The evidence checks (a computation reference, a source snapshot, a data file
// and its sidecar) must see a file the call itself just wrote (still in its staging folder), must not see a parallel sibling's or another call's
// staging, and must be unchanged outside a staged call. Loads newsroom.ts from a type-stripped copy (same approach as test_atomic_artifact_runtime).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("chain-staging-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const groups = await import(join(pi, "groups.mjs"));
const { runInStagedCall, withStagedCall, runInTool, asHandoffWriter } = groups;
const { sourceContentHash } = await import(join(pi, "provenance.mjs"));

const run = join(tmp, "run");
mkdirSync(run, { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = run;
const staging = join(run, "staging");
const comp = { a: 1 };
const ref = "computations/plan.json";
// each step runs as the tool named after the colon (the tool context a real call has); the plan step saves its computation record through the knowledge writer, as the table lists
const callStep = (id, fn, chainDone) => runInTool(id.split(":")[1], () => withStagedCall({ execute: fn }).execute(id, {}, undefined, undefined, undefined, chainDone === undefined ? undefined : { chainDone }));
const asKnowledgeWriter = (fn) => asHandoffWriter("knowledge_writer", fn);
const read = () => mod.__normalizeArtifactRefsForTest([ref], "computation");
const outer = (id, fn) => runInStagedCall(id, join(staging, id), fn);

// (a) reproduction: the plan step stages a file, the lint step (run after it, named as finished) reads it. Without the K241 fix the lint step looks only at the run folder and fails.
await outer("x1", async () => {
  await callStep("x1:newsroom_viz_plan", () => asKnowledgeWriter(() => mod.__writeArtifactIfAbsentForTest(ref, comp)));
  await callStep("x1:newsroom_viz_lint", async () => {
    assert.deepEqual(await read(), [ref]);
  }, ["newsroom_viz_plan"]);
});
const { existsSync } = await import("node:fs");
assert.equal(existsSync(join(run, ref)), false, "the plan is still only staged, not in the run folder");

// (b) a parallel sibling (not named as finished) cannot see the staged plan; neither can an unrelated call
await outer("x2", async () => {
  await callStep("x2:newsroom_viz_plan", () => asKnowledgeWriter(() => mod.__writeArtifactIfAbsentForTest(ref, comp)));
  await callStep("x2:newsroom_viz_other", async () => {
    await assert.rejects(read, /computation reference does not exist/);
  });
  // naming a different tool as finished does not reveal the plan's folder either
  await callStep("x2:newsroom_viz_lint", async () => {
    await assert.rejects(read, /computation reference does not exist/);
  }, ["newsroom_viz_render"]);
});
// (d) only the chain's own sixth argument names finished steps: a chainDone the model put in its parameters (second argument) is never read,
// and a sixth argument that is not { chainDone: [names] } (no argument, a string, a non-array) adds nothing.
await outer("x3", async () => {
  await callStep("x3:newsroom_viz_plan", () => asKnowledgeWriter(() => mod.__writeArtifactIfAbsentForTest(ref, comp)));
  await withStagedCall({ execute: async () => { await assert.rejects(read, /computation reference does not exist/); } }).execute("x3:newsroom_viz_lint", { chainDone: ["newsroom_viz_plan"] });
  for (const bad of [undefined, "newsroom_viz_plan", { chainDone: "newsroom_viz_plan" }, { chainDone: [7, ""] }, { other: ["newsroom_viz_plan"] }]) {
    await withStagedCall({ execute: async () => { await assert.rejects(read, /computation reference does not exist/); } }).execute("x3:newsroom_viz_lint", {}, undefined, undefined, undefined, bad);
  }
});
await outer("y1", async () => { await assert.rejects(read, /computation reference does not exist/); });

// (c) outside a staged call the sixth argument changes nothing: the tool just runs
assert.equal(await callStep("z:newsroom_viz_lint", async () => 7, ["newsroom_viz_plan"]), 7);

console.log("test_chain_staging_reads: ok");
