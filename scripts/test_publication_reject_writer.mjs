#!/usr/bin/env node
// The review split (always on; a leftover NEWSROOM_REVIEW_SPLIT value changes nothing): the two moves of newsroom_publication_qa (a failed publication to publications/rejected/<key>, and the start-up failure rename
// publications/qa/<qaKey>/browser-qa.json -> startup-failure.json) run inside review_reject_writer, like the critics' manifest move. The hand-off row is
// writer review_reject_writer, paths publications/, requester newsroom_publication_qa only. No rasterizer and no browser are needed: the cases use groups.mjs
// directly, and the real rejectPublication of a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, loadTree, walk } from "./lib_page_chain_fixture.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";

for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_")) delete process.env[name];
const { mod, dir: tree } = await loadTree("pubqa-reject");
const groups = await import(pathToFileURL(join(tree, "runtime/pi/groups.mjs")).href);
const results = [];
const check = (name) => results.push(name);

const QA = "newsroom_publication_qa";
const WRITER = "review_reject_writer";
const setEnv = (env) => {
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_GROUP_") || key === "NEWSROOM_REVIEW_SPLIT") delete process.env[key];
  Object.assign(process.env, { NEWSROOM_GROUP_BOUNDARY: "1", ...env });
};
const ON = { NEWSROOM_GROUP_ENFORCE: "1" };
const LEFTOVER = { NEWSROOM_REVIEW_SPLIT: "0", NEWSROOM_GROUP_ENFORCE: "1" }; // no variable turns the split off: this changes nothing
let seq = 0;
const freshRun = () => {
  const dir = join(makeTestTmp("pubqa-reject-"), `run-${++seq}`);
  mkdirSync(dir, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  groups.resetBoundaryReport();
  return dir;
};
const refusalsOf = (dir) => { const f = join(dir, "runtime/boundary-refusals.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const reportOf = (dir) => JSON.parse(readFileSync(join(dir, "runtime/group-boundary-report.json"), "utf8"));
// One boundary-checked write as `tool`, optionally as a hand-off writer (the same call the program makes).
const move = (dir, tool, ref, op = "write", writer = null) => groups.runInTool(tool, () => {
  const run = () => groups.recordBoundaryWrite(dir, join(dir, ref), op);
  return writer ? groups.asHandoffWriter(writer, run) : run();
});

const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8")).handoffs.rows;
const pubRows = table.filter((r) => r.writer === WRITER && r.paths.includes("publications/"));
assert.equal(pubRows.length, 1, "exactly one review_reject_writer row covers publications/");
assert.deepEqual(pubRows[0].requesters, [QA], "and its only requester is newsroom_publication_qa");
assert.deepEqual(pubRows[0].paths, ["publications/"]);
assert.deepEqual(pubRows[0].not_measured, []);
check("the table has one publications/ row for review_reject_writer, asked by newsroom_publication_qa only");

// a. outside the writer the QA tool may not move a publication (today's refusal)
{
  setEnv(ON);
  const dir = freshRun();
  assert.throws(() => move(dir, QA, "publications/rejected/k1", "rename"), groups.BoundaryRefusal);
  assert.ok(refusalsOf(dir).some((r) => r.status === "draw_path_by_review_tool" && r.tool === QA), JSON.stringify(refusalsOf(dir)));
}
check("a: the QA tool renaming publications/<key> to publications/rejected/<key> itself is refused (draw_path_by_review_tool)");

// b. inside the writer, with the QA tool as requester: allowed; the report names the writer and the asking tool
{
  setEnv(ON);
  const dir = freshRun();
  move(dir, QA, "publications/rejected/k1", "rename", WRITER);
  move(dir, QA, "publications/rejected/k1/browser-qa.json", "write", WRITER);
  move(dir, QA, "publications/rejected/k1/rejection.json", "write", WRITER);
  assert.deepEqual(refusalsOf(dir), []);
  const rows = reportOf(dir).records.filter((r) => r.requested_by === QA);
  assert.ok(rows.length > 0 && rows.every((r) => r.tool === WRITER), JSON.stringify(rows));
}
check("b: the same move inside review_reject_writer is allowed; the report names review_reject_writer as writer and the QA tool as requested_by");

// c. a critic is not a requester for publications/
{
  setEnv(ON);
  const dir = freshRun();
  assert.throws(() => move(dir, "newsroom_viz_critic", "publications/rejected/k1", "rename", WRITER), groups.BoundaryRefusal);
  assert.ok(refusalsOf(dir).length >= 1);
}
check("c: a critic asking review_reject_writer for publications/ is refused");

// d. the writer with the QA tool as requester stays inside its row
{
  setEnv(ON);
  const dir = freshRun();
  for (const ref of ["visualizations/rejected/k1/manifest.json", "infographics/rejected/k1/manifest.json", "maps/k1.json"]) {
    assert.throws(() => move(dir, QA, ref, "write", WRITER), groups.BoundaryRefusal, ref);
  }
}
check("d: the writer asked by the QA tool is refused outside publications/ (the critics' paths and a path no row lists)");

// e. the start-up failure rename
{
  setEnv(ON);
  const dir = freshRun();
  assert.throws(() => move(dir, QA, "publications/qa/q1/startup-failure.json", "rename"), groups.BoundaryRefusal);
  assert.ok(refusalsOf(dir).some((r) => r.status === "draw_path_by_review_tool"));
  move(dir, QA, "publications/qa/q1/startup-failure.json", "rename", WRITER);
}
check("e: the start-up failure rename is refused outside the writer and allowed inside it");

// f. a leftover NEWSROOM_REVIEW_SPLIT=0 changes nothing: the QA tool's own moves are refused outside the writer and allowed inside it
{
  setEnv(LEFTOVER);
  const dir = freshRun();
  assert.throws(() => move(dir, QA, "publications/rejected/k1", "rename"), groups.BoundaryRefusal);
  assert.throws(() => move(dir, QA, "publications/qa/q1/startup-failure.json", "rename"), groups.BoundaryRefusal);
  assert.ok(refusalsOf(dir).some((r) => r.status === "draw_path_by_review_tool"));
  move(dir, QA, "publications/rejected/k1", "rename", WRITER);
  move(dir, QA, "publications/qa/q1/startup-failure.json", "rename", WRITER);
}
check("f: a leftover NEWSROOM_REVIEW_SPLIT=0 changes nothing: the QA tool's moves are still refused outside review_reject_writer");

// g. the real rejectPublication: the same paths and bytes with or without a leftover "0"; the report names the writer
{
  const layout = (env) => {
    setEnv(env);
    const dir = freshRun();
    const key = "k1";
    mkdirSync(join(dir, "publications", key, "assets"), { recursive: true });
    writeFileSync(join(dir, "publications", key, "index.html"), "<html></html>\n");
    writeFileSync(join(dir, "publications", key, "manifest.json"), "{}\n");
    return { dir, key };
  };
  const report = { status: "FAIL", profile: "p", viewports: [] };
  const outcome = {};
  for (const [name, env] of [["unset", ON], ["leftover", LEFTOVER]]) {
    const { dir, key } = layout(env);
    const moved = groups.runInTool(QA, () => mod.__rejectPublicationForTest(key, `publications/${key}/manifest.json`, report, "publications/qa/q1/browser-qa.json"));
    const rejected = await moved;
    assert.equal(rejected.rejectedManifestRef, `publications/rejected/${key}/manifest.json`);
    assert.deepEqual(refusalsOf(dir), [], `${name}: nothing refused`);
    const files = Object.fromEntries(walk(join(dir, "publications")).map((f) => [relative(dir, f), readFileSync(f, "utf8")]));
    outcome[name] = { files, writers: [...new Set(reportOf(dir).records.filter((r) => r.op !== "mkdir").map((r) => r.tool))] };
  }
  assert.deepEqual(outcome.unset.files, outcome.leftover.files, "same paths and bytes with a leftover 0");
  assert.ok(Object.keys(outcome.unset.files).includes("publications/rejected/k1/rejection.json") && !Object.keys(outcome.unset.files).includes("publications/k1/index.html"));
  for (const name of ["unset", "leftover"]) assert.ok(outcome[name].writers.includes(WRITER), JSON.stringify(outcome[name].writers));
}
check("g: the real rejectPublication leaves the same files with or without a leftover 0; the report names review_reject_writer");

// h. staged call (the Rust agent path): the real rejectPublication stages its rename and writes; the ops line carries the writer and the
// files sit under writer-review_reject_writer, also with a leftover "0". src/staging.rs parses the same literal line.
{
  const stagedRun = async (env) => {
    setEnv(env);
    const dir = freshRun();
    mkdirSync(join(dir, "publications", "k1"), { recursive: true });
    writeFileSync(join(dir, "publications", "k1", "manifest.json"), "{}\n");
    const call = join(dir, "staging", "s1");
    mkdirSync(call, { recursive: true });
    await groups.runInStagedCall("s1", call, () => groups.runInTool(QA, () => mod.__rejectPublicationForTest("k1", "publications/k1/manifest.json", { status: "FAIL", profile: "p", viewports: [] }, "publications/qa/q1/browser-qa.json")));
    assert.deepEqual(refusalsOf(dir), []);
    const lines = readFileSync(join(call, "ops.jsonl"), "utf8").trim().split("\n");
    return { dir, call, lines, files: walk(call).map((f) => relative(call, f)).filter((f) => f !== "ops.jsonl").sort() };
  };
  for (const env of [ON, LEFTOVER]) {
    const run = await stagedRun(env);
    assert.equal(run.lines[0], '{"op":"rename","from":"publications/k1","to":"publications/rejected/k1","writer":"review_reject_writer"}');
    assert.ok(run.files.length > 0 && run.files.every((f) => f.startsWith("writer-review_reject_writer/")), JSON.stringify(run.files));
    assert.equal(existsSync(join(run.dir, "publications", "k1", "manifest.json")), true, "staged: the move is left to Rust");
  }
}
check("h: under a staged call the real rejectPublication writes an ops line that names review_reject_writer, with or without a leftover 0");

// i. both call sites in newsroom.ts always go through the writer (the start-up block needs a browser, so it is read from the source)
{
  const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.equal((source.match(/\brejectPublication\(/g) ?? []).length, 2, "rejectPublication: its definition and the one call in rejectPublicationFor");
  assert.ok(/function rejectPublicationFor\([^)]*\)[^{]*\{\s*return asReviewRejectWriter\(\(\) => rejectPublication\(/.test(source));
  assert.ok(source.includes("await rejectPublicationFor(pubKey,"));
  assert.ok(source.includes("await asReviewRejectWriter(moveStartupFailure);") && !/await moveStartupFailure\(\);/.test(source));
  assert.ok(!source.includes("REVIEW_SPLIT"), "newsroom.ts reads no review-split variable");
  const block = source.slice(source.indexOf("const moveStartupFailure"), source.indexOf("await asReviewRejectWriter(moveStartupFailure);") + 50);
  assert.ok(block.includes('stageOp("rename"') && block.includes("recordBoundaryWrite("), "the start-up move keeps its boundary record and staged rename");
}
check("i: newsroom.ts reaches rejectPublication only through rejectPublicationFor, and wraps the start-up rename");

console.log(`publication reject writer: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
