#!/usr/bin/env node
// The design pack runs its tools one after the other inside one call. A step reads what an earlier step staged only when it is named as finished,
// and a chain tool the pack ran leaves its steps in folders under its own id (named with ":*"). Same harness as test_chain_staging_reads.mjs.
// DESIGN_PACK_MODULE / GROUPS_MODULE point at mutated copies (scripts/test_design_pack_mutations.mjs).
// (K241: a step of a tool chain must read what the chain's earlier, finished steps staged (plan -> lint), while a parallel sibling step and any other
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

process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; // the made-up tool newsroom_viz_other has no group; the all-rows refusal is on by default. Set before groups.mjs is imported below, which decides at load which calls to wrap

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("pack-staging-");
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
import { copyFileSync } from "node:fs";
if (process.env.DESIGN_PACK_MODULE) copyFileSync(process.env.DESIGN_PACK_MODULE, join(pi, "design_pack.mjs"));
if (process.env.GROUPS_MODULE) copyFileSync(process.env.GROUPS_MODULE, join(pi, "groups.mjs"));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
const { innerCallBook } = await import(join(pi, "design_pack.mjs"));
const groups = await import(join(pi, "groups.mjs"));
const { runInStagedCall, withStagedCall, runInTool, asHandoffWriter } = groups;
const { sourceContentHash } = await import(join(pi, "provenance.mjs"));

const run = join(tmp, "run");
mkdirSync(run, { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = run;
const staging = join(run, "staging");
const comp = { a: 1 };
const discoveryRef = "computations/discovery.json"; // stands for the discovery artifact the next step must read
const chainRef = "computations/chart.json";
const asKnowledgeWriter = (fn) => asHandoffWriter("knowledge_writer", fn);
const read = (ref) => mod.__normalizeArtifactRefsForTest([ref], "computation");
const outer = (id, fn) => runInStagedCall(id, join(staging, id), fn);
// one pack call step: the id and finished list come from the book, exactly as the pack's execute builds them
const step = (book, tool, fn, options) => {
  const call = book.next(tool, options);
  return runInTool(tool, () => withStagedCall({ execute: fn }).execute(call.callId, {}, undefined, undefined, undefined, { chainDone: call.finished })).then((value) => { book.ok(call); return value; });
};
// the table lists newsroom_viz_plan as the requester of the computation writer, so the staged files here are written under that tool name; the call ids are the pack's own
const writeRef = (ref) => () => runInTool("newsroom_viz_plan", () => asKnowledgeWriter(() => mod.__writeArtifactIfAbsentForTest(ref, comp)));

// (a) the failure of the German rehearsal: the discovery step staged its file in its own folder, the concept step (next in the pack) cannot see it when the pack names nothing as finished
await outer("p0", async () => {
  await runInTool("newsroom_editorial_discovery", () => withStagedCall({ execute: writeRef(discoveryRef) }).execute("p0:s1:newsroom_editorial_discovery", {}));
  await runInTool("newsroom_visual_concepts", () => withStagedCall({ execute: async () => { await assert.rejects(() => read(discoveryRef), /computation reference does not exist/); } }).execute("p0:s2:newsroom_visual_concepts", {}, undefined, undefined, undefined, { chainDone: [] }));
});

// (b) with the book the same two steps work, and the step after them sees both
await outer("p1", async () => {
  const book = innerCallBook("p1");
  await step(book, "newsroom_editorial_discovery", writeRef(discoveryRef));
  await step(book, "newsroom_visual_concepts", async () => { assert.deepEqual(await read(discoveryRef), [discoveryRef]); });
  await step(book, "newsroom_semantic_novelty", async () => { assert.deepEqual(await read(discoveryRef), [discoveryRef]); });
});

// (c) a step that did not return is not listed: its staged file stays invisible to the steps after it
await outer("p2", async () => {
  const book = innerCallBook("p2");
  await assert.rejects(step(book, "newsroom_editorial_discovery", async () => { await writeRef(discoveryRef)(); throw new Error("refused"); }), /refused/);
  await step(book, "newsroom_visual_concepts", async () => { await assert.rejects(() => read(discoveryRef), /computation reference does not exist/); });
});

// (d) a chain tool the pack ran: its steps sit under its id, the entry is named with ":*", and the next pack step reads them; an unnamed chain stays invisible
await outer("p3", async () => {
  const book = innerCallBook("p3");
  await step(book, "newsroom_editorial_discovery", writeRef(discoveryRef));
  const chainId = "p3:s2:newsroom_viz_chain";
  await step(book, "newsroom_viz_chain", async () => {
    // a chain step the way chain code starts it: its id is the chain's id plus the tool, finished steps named by tool
    await runInTool("newsroom_viz_plan", () => withStagedCall({ execute: writeRef(chainRef) }).execute(`${chainId}:newsroom_viz_plan`, {}));
    await runInTool("newsroom_viz_lint", () => withStagedCall({ execute: async () => { assert.deepEqual(await read(chainRef), [chainRef]); assert.deepEqual(await read(discoveryRef), [discoveryRef], "the first half stays visible inside the chain"); } }).execute(`${chainId}:newsroom_viz_lint`, {}, undefined, undefined, undefined, { chainDone: ["newsroom_viz_plan"] }));
  }, { nested: true });
  await step(book, "newsroom_publication_plan", async () => { assert.deepEqual(await read(chainRef), [chainRef]); });
});
await outer("p4", async () => {
  const book = innerCallBook("p4");
  const chainId = "p4:s1:newsroom_viz_chain";
  const call = book.next("newsroom_viz_chain", { nested: true });
  await runInTool("newsroom_viz_chain", () => withStagedCall({ execute: async () => {
    await runInTool("newsroom_viz_plan", () => withStagedCall({ execute: writeRef(chainRef) }).execute(`${chainId}:newsroom_viz_plan`, {}));
  } }).execute(call.callId, {}, undefined, undefined, undefined, { chainDone: call.finished }));
  // the chain was not recorded as finished (book.ok not called): the next step cannot read its folder
  await step(book, "newsroom_publication_plan", async () => { await assert.rejects(() => read(chainRef), /computation reference does not exist/); });
});

// (e) other calls and unrelated sibling folders stay invisible: ":*" reaches only the folder it names and the ones under it
await outer("p5", async () => {
  await runInTool("newsroom_viz_other", () => withStagedCall({ execute: writeRef(chainRef) }).execute("p5:s1:newsroom_viz_other", {}));
  await runInTool("newsroom_viz_chain", () => withStagedCall({ execute: async () => {} }).execute("p5:s2:newsroom_viz_chain", {}));
  const reader = (names) => runInTool("newsroom_publication_plan", () => withStagedCall({ execute: async () => read(chainRef) }).execute("p5:s3:newsroom_publication_plan", {}, undefined, undefined, undefined, { chainDone: names }));
  await assert.rejects(() => reader(["s2:newsroom_viz_chain:*"]), /computation reference does not exist/);
  await assert.rejects(() => reader(["s2:newsroom_viz_chain"]), /computation reference does not exist/);
  await assert.rejects(() => reader(["s1:newsroom_viz_other:*:*", "s1:newsroom_viz_oth:*"]), /computation reference does not exist/);
  assert.deepEqual(await reader(["s1:newsroom_viz_other:*"]), [chainRef], "the named folder itself is reached");
});
// (f) visibleFolders itself (not exported: its source is cut out of the copy under test and run on a folder tree). Plain seen entries behave as before the
// ":*" entry existed, duplicates included; only what a ":*" entry expands to is de-duplicated.
{
  const { readdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const text = readFileSync(join(pi, "groups.mjs"), "utf8");
  const start = text.indexOf("function visibleFolders(ctx) {");
  const end = text.indexOf("\nconst isFile = ", start);
  assert.ok(start > 0 && end > start, "found visibleFolders");
  const visibleFolders = new Function("readdirSync", "join", "dirname", `${text.slice(start, end)}\nreturn visibleFolders;`)(readdirSync, join, dirname);
  // the behaviour before the ":*" entry: the seen list filtered to existing folders other than the call itself, in the order given
  const oldVisible = (ctx) => {
    const root = dirname(ctx.dir);
    const names = readdirSync(root);
    const mine = names.filter((n) => n === ctx.callId);
    const outer = names.filter((n) => ctx.callId.startsWith(`${n}:`)).sort((a, b) => a.length - b.length);
    const seen = (ctx.seen ?? []).filter((n) => names.includes(n) && n !== ctx.callId);
    const inner = names.filter((n) => n.startsWith(`${ctx.callId}:`)).sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    return [...outer, ...seen, ...mine, ...inner].map((n) => join(root, n));
  };
  const tree = join(tmp, "visible-tree");
  for (const name of ["p", "p:s1:a", "p:s2:chain", "p:s2:chain:t1", "p:s2:chain:t1:x", "p:s2:chain:t2", "p:s2:chain2", "p:s3:b", "p:s9:z"]) mkdirSync(join(tree, name), { recursive: true });
  const ctx = (seen) => ({ callId: "p:s9:z", dir: join(tree, "p:s9:z"), seen });
  const base = (n) => n.slice(tree.length + 1);
  // no wildcard: same output as the old code, for repeated, missing, self and out-of-order entries
  for (const seen of [undefined, [], ["p:s1:a"], ["p:s1:a", "p:s1:a"], ["p:s3:b", "p:s1:a", "p:s3:b"], ["p:s9:z", "p:gone", "p:s2:chain"], ["p:s1:a", "p:s2:chain", "p:s1:a"]]) {
    assert.deepEqual(visibleFolders(ctx(seen)), oldVisible(ctx(seen)), `no wildcard, seen ${JSON.stringify(seen)}: same as before`);
  }
  assert.equal(visibleFolders(ctx(["p:s1:a", "p:s1:a"])).filter((n) => base(n) === "p:s1:a").length, 2, "a repeated plain entry stays repeated, as before");
  // a finished chain: its folder and every folder under it (two levels) are visible, once each; the name that only starts like it is not
  const chainSeen = visibleFolders(ctx(["p:s2:chain:*"])).map(base).filter((n) => n.startsWith("p:s2:"));
  assert.deepEqual(chainSeen, ["p:s2:chain", "p:s2:chain:t1", "p:s2:chain:t2", "p:s2:chain:t1:x"]);
  assert.ok(!visibleFolders(ctx(["p:s2:chain:*"])).map(base).includes("p:s2:chain2"));
  // repeated wildcard entries and a wildcard next to the plain name of the same folder list each folder once
  const twice = visibleFolders(ctx(["p:s2:chain:*", "p:s2:chain:*", "p:s2:chain"])).map(base);
  assert.equal(twice.filter((n) => n === "p:s2:chain").length, 1);
  assert.equal(twice.filter((n) => n === "p:s2:chain:t1:x").length, 1);
  assert.equal(twice.filter((n) => n === "p:s2:chain:t1").length, 1);
  assert.ok(!visibleFolders(ctx(["p:s9:z:*"])).map(base).some((n, i, all) => all.indexOf(n) !== i), "no folder twice when the call's own id is named");
}
const { existsSync } = await import("node:fs");
assert.equal(existsSync(join(run, discoveryRef)), false, "everything is still staged, nothing reached the run folder");

console.log("test_design_pack_staging: ok");
