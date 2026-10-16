#!/usr/bin/env node
// 1011ah step 7a: the Node side of per-call staging (groups.mjs runInStagedCall / stagedWriteRoot / withStagedCall). Outside a staged call nothing
// changes; inside, the write root is <call folder>/<own | writer-NAME>/<mode>; a path that leaves it throws; a call a tool makes inside another
// staged call gets its own sibling folder. The Rust side (src/staging.rs) judges the files; this only checks where they land. No model, no network.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { asHandoffWriter, countedByRust, readThroughStaging, recordBoundaryWrite, resetBoundaryReport, runInStagedCall, runInTool, stageOp, stagedWriteRoot, stagingActive, withStagedCall } from "../runtime/pi/groups.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

const scratch = makeTestTmp("staging-root-");
const run = join(scratch, "run");
const staging = join(run, "staging");

// outside a staged call: the run folder, unchanged
assert.equal(stagedWriteRoot("/run", "a.json", "write"), "/run");
assert.equal(stagingActive(), false);
runInStagedCall("c1", null, () => assert.equal(stagedWriteRoot("/run", "a.json", "write"), "/run"));

// inside: the call's folder, by mode
runInStagedCall("c1", join(staging, "c1"), () => {
  assert.equal(stagingActive(), true);
  assert.equal(stagedWriteRoot("/run", "data/a.csv", "write"), join(staging, "c1", "own", "write"));
  assert.equal(stagedWriteRoot("/run", "claims.jsonl", "append"), join(staging, "c1", "own", "append"));
  assert.equal(stagedWriteRoot("/run", "claims.jsonl", "once"), join(staging, "c1", "own", "once"));
  assert.throws(() => stagedWriteRoot("/run", "a", "rename"), /unknown staging mode/);
  assert.throws(() => stagedWriteRoot("/run", "../../data/a.csv", "write"), /leaves the call's staging folder/);
  assert.throws(() => stagedWriteRoot("/run", "..", "write"), /leaves the call's staging folder/);
  assert.throws(() => stagedWriteRoot("/run", "", "write"), /leaves the call's staging folder/);
  // a hand-off writer's files go to their own folder, so Rust can tell who wrote
  asHandoffWriter("knowledge_writer", () => assert.equal(stagedWriteRoot("/run", "claims.jsonl", "once"), join(staging, "c1", "writer-knowledge_writer", "once")));
  assert.throws(() => asHandoffWriter("made_up_writer", () => {}), /not listed/);
});

// a call made inside a staged call has its own sibling folder; the same call id keeps the outer folder
const inner = withStagedCall({ name: "record_claim", execute: async (id) => ({ id, root: stagedWriteRoot("/run", "claims.jsonl", "once") }) });
assert.equal((await inner.execute("c9", {})).root, "/run", "no staged call around it: unchanged");
await runInStagedCall("c1", join(staging, "c1"), async () => {
  const same = await inner.execute("c1", {});
  assert.equal(same.root, join(staging, "c1", "own", "once"));
  const nested = await inner.execute("c1:record_claim", {});
  assert.equal(nested.root, join(staging, "c1:record_claim", "own", "once"));
  assert.ok(existsSync(join(staging, "c1:record_claim")));
  // two inner calls running at the same time keep their own folders
  const both = await Promise.all([inner.execute("c1:a", {}), inner.execute("c1:b", {})]);
  assert.deepEqual(both.map((r) => r.root), [join(staging, "c1:a", "own", "once"), join(staging, "c1:b", "own", "once")]);
  // and the outer folder is still the outer one afterwards
  assert.equal(stagedWriteRoot("/run", "x", "write"), join(staging, "c1", "own", "write"));
});
assert.equal(resolve(staging, "c1:record_claim").startsWith(staging), true);

// ---- 1011ai step 7b: reads, the operations journal and the report count ----------------------------------------------------------------
const put = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
put(join(run, "claims.jsonl"), "old\n");
put(join(run, "data", "a.csv"), "run\n");
const base = (rel) => async () => readFileSync(join(run, rel));
// outside a staged call: nothing to read through
assert.equal(await readThroughStaging("data/a.csv", base("data/a.csv")), null);
await runInStagedCall("c1", join(staging, "c1"), async () => {
  assert.equal(await readThroughStaging("data/a.csv", base("data/a.csv")), null, "nothing staged: the caller reads the run folder");
  // write then read in the same call: the staged copy, not the run folder's
  put(join(staging, "c1", "own", "write", "data", "a.csv"), "staged\n");
  assert.equal((await readThroughStaging("data/a.csv", base("data/a.csv"))).toString(), "staged\n");
  // a path that exists only staged
  put(join(staging, "c1", "own", "once", "data", "new.json"), "{}");
  assert.equal((await readThroughStaging("data/new.json", base("data/new.json"))).toString(), "{}");
  // an append sees the run folder's content plus the staged part; two appends keep their order of folders
  put(join(staging, "c1", "own", "append", "claims.jsonl"), "new\n");
  assert.equal((await readThroughStaging("claims.jsonl", base("claims.jsonl"))).toString(), "old\nnew\n");
  // a rewrite staged too: the rewrite replaces, the appended part goes after it
  put(join(staging, "c1", "own", "write", "claims.jsonl"), "fresh\n");
  assert.equal((await readThroughStaging("claims.jsonl", base("claims.jsonl"))).toString(), "fresh\nnew\n");
  // an append to a file the run folder does not have yet
  put(join(staging, "c1", "own", "append", "log.jsonl"), "1\n");
  assert.equal((await readThroughStaging("log.jsonl", base("log.jsonl"))).toString(), "1\n");
  // a hand-off writer's file of the same call is seen too
  put(join(staging, "c1", "writer-knowledge_writer", "once", "w.json"), "w");
  assert.equal((await readThroughStaging("w.json", base("w.json"))).toString(), "w");
});

// a chain: the inner call sees the outer call's staged files and the outer call sees the inner one's (everything is on disk at once today); a parallel
// sibling and an unrelated call are not visible
put(join(staging, "o1", "own", "write", "from-outer.json"), "outer");
put(join(staging, "o1:inner_tool", "own", "write", "from-inner.json"), "inner");
put(join(staging, "o1:other_tool", "own", "write", "sibling.json"), "sibling");
put(join(staging, "zz", "own", "write", "stranger.json"), "stranger");
const none = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
await runInStagedCall("o1:inner_tool", join(staging, "o1:inner_tool"), async () => {
  assert.equal((await readThroughStaging("from-outer.json", none)).toString(), "outer");
  assert.equal((await readThroughStaging("from-inner.json", none)).toString(), "inner");
  assert.equal(await readThroughStaging("sibling.json", none), null);
  assert.equal(await readThroughStaging("stranger.json", none), null);
});
await runInStagedCall("o1", join(staging, "o1"), async () => {
  assert.equal((await readThroughStaging("from-inner.json", none)).toString(), "inner");
});

// known gap 6 (1011aj, pinned, not fixed): a file appended to and then overwritten in one call. Today's direct writes would end with the overwrite
// alone (append A, then write B -> "B"); the read through the staging gives the rewrite first and the appended part after it ("BA"), whichever
// came first. Rust moves the appends in before the rewrite, so what is saved is "B" (see staging.rs, the same-named test).
put(join(staging, "g6", "own", "append", "log.txt"), "A");
put(join(staging, "g6", "own", "write", "log.txt"), "B");
await runInStagedCall("g6", join(staging, "g6"), async () => {
  assert.equal((await readThroughStaging("log.txt", none)).toString(), "BA");
});

// the three protocol operations are handed over as journal lines, not done here
assert.equal(stageOp("unlink", "a/b.json"), false, "outside a staged call: the caller does it");
await runInStagedCall("p1", join(staging, "p1"), async () => {
  assert.equal(stageOp("unlink", "visualizations/m.json"), true);
  assert.equal(stageOp("rename", "publications/k", "publications/rejected/k"), true);
  assert.throws(() => stageOp("rename", "../x", "y"), /run-relative/);
  assert.throws(() => stageOp("rename", "/abs/x", "y"), /run-relative/);
  assert.throws(() => stageOp("rename", "a", ""), /run-relative/);
  assert.throws(() => stageOp("chmod", "a"), /unknown staged operation/);
  const lines = readFileSync(join(staging, "p1", "ops.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ op: "unlink", from: "visualizations/m.json" }, { op: "rename", from: "publications/k", to: "publications/rejected/k" }]);
  // inside asHandoffWriter the line names the writer as its last key; src/staging.rs parses these same literal lines (one format for both languages)
  await asHandoffWriter("review_reject_writer", async () => {
    assert.equal(stageOp("rename", "publications/k1", "publications/rejected/k1"), true);
    assert.equal(stageOp("unlink", "visualizations/a.json"), true);
  });
  assert.equal(stageOp("unlink", "visualizations/m2.json"), true);
  const raw = readFileSync(join(staging, "p1", "ops.jsonl"), "utf8").trim().split("\n");
  assert.equal(raw[2], '{"op":"rename","from":"publications/k1","to":"publications/rejected/k1","writer":"review_reject_writer"}');
  assert.equal(raw[3], '{"op":"unlink","from":"visualizations/a.json","writer":"review_reject_writer"}');
  assert.equal(raw[0], '{"op":"unlink","from":"visualizations/m.json"}', "no writer: byte-equal to the line before this change");
  assert.equal(raw[4], '{"op":"unlink","from":"visualizations/m2.json"}', "after the writer scope ends the line has no writer again");
  // a path this call deleted or renamed away reads as gone; one it staged and did not delete still reads
  put(join(staging, "p1", "own", "write", "keep.json"), "k");
  await assert.rejects(readThroughStaging("visualizations/m.json", base("visualizations/m.json")), { code: "ENOENT" });
  await assert.rejects(readThroughStaging("publications/k/index.html", none), { code: "ENOENT" });
  assert.equal((await readThroughStaging("keep.json", none)).toString(), "k");
});

// the report: a write counted by Rust in a staged call (go.counted) is left out of Node's own count; everything else is counted as before
process.env.NEWSROOM_GROUP_BOUNDARY = "1";
const reportPath = join(run, "runtime", "group-boundary-report.json");
const writesSeen = () => JSON.parse(readFileSync(reportPath, "utf8")).totals.writes;
resetBoundaryReport();
await runInTool("record_claim", async () => {
  recordBoundaryWrite(run, "claims.jsonl", "write", { countedByRust: true });
  assert.equal(writesSeen(), 1, "no staged call: Node counts it");
  await runInStagedCall("d1", join(staging, "d1"), async () => {
    assert.equal(countedByRust(), false);
    recordBoundaryWrite(run, "claims.jsonl", "write", { countedByRust: true });
    assert.equal(writesSeen(), 2, "staged but the host does not count: Node counts it");
  }, false);
  await runInStagedCall("d2", join(staging, "d2"), async () => {
    assert.equal(countedByRust(), true);
    recordBoundaryWrite(run, "claims.jsonl", "write", { countedByRust: true });
    assert.equal(writesSeen(), 2, "counted by Rust: Node leaves it out");
    recordBoundaryWrite(run, "data/a.csv", "write"); // a write site that is not redirected: Node works the record out but leaves it to Rust (1011aj step 8)
    assert.equal(writesSeen(), 2, "Node does not write the report file in a counted call");
    const left = readFileSync(join(staging, "d2", "report.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(left.length, 1);
    assert.deepEqual({ tool: left[0].tool, op: left[0].op, kind: left[0].kind, status: left[0].status, path: left[0].path }, { tool: "record_claim", op: "write", kind: "evidence", status: "ok", path: "data/a.csv" });
  }, true);
  // Rust adds its own count to the file between two of Node's; Node rereads and keeps it
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  report.records.push({ tool: "newsroom_viz_plan", tool_group: "visual", op: "write", kind: "visual_spec", owner: "visual", status: "ok", count: 3, examples: [] });
  writeFileSync(reportPath, JSON.stringify(report));
  recordBoundaryWrite(run, "claims.jsonl", "write");
  assert.equal(writesSeen(), 2 + 3 + 1, "the 3 Rust counted stay, Node's own 2 and the new one add to them");
});
delete process.env.NEWSROOM_GROUP_BOUNDARY;
console.log("test_staging_root: ok");
