#!/usr/bin/env node
// NEWSROOM_REVIEW_SPLIT=1: the two moves of newsroom_publication_qa (a failed publication to publications/rejected/<key>, and the start-up failure rename
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
const ON = { NEWSROOM_REVIEW_SPLIT: "1", NEWSROOM_GROUP_ENFORCE: "1" };
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

// f. review split off: nothing changes (the QA tool's own moves are not split-checked)
{
  setEnv({ NEWSROOM_GROUP_ENFORCE: "1" });
  const dir = freshRun();
  move(dir, QA, "publications/rejected/k1", "rename");
  move(dir, QA, "publications/qa/q1/startup-failure.json", "rename");
  assert.deepEqual(refusalsOf(dir), []);
  const rows = reportOf(dir).records.filter((r) => r.requested_by === QA);
  assert.deepEqual(rows, [], "off: no hand-off row is involved, the QA tool is its own writer");
}
check("f: with the review split off the QA tool's moves are as before (allowed, not routed through the writer)");

// g. the real rejectPublication: same paths and bytes with the split on or off; only the writer in the report differs
{
  const layout = (split) => {
    setEnv(split ? ON : { NEWSROOM_GROUP_ENFORCE: "1" });
    const dir = freshRun();
    const key = "k1";
    mkdirSync(join(dir, "publications", key, "assets"), { recursive: true });
    writeFileSync(join(dir, "publications", key, "index.html"), "<html></html>\n");
    writeFileSync(join(dir, "publications", key, "manifest.json"), "{}\n");
    return { dir, key };
  };
  const report = { status: "FAIL", profile: "p", viewports: [] };
  const outcome = {};
  for (const split of [false, true]) {
    const { dir, key } = layout(split);
    const moved = groups.runInTool(QA, () => mod.__rejectPublicationForTest(split, key, `publications/${key}/manifest.json`, report, "publications/qa/q1/browser-qa.json"));
    const rejected = await moved;
    assert.equal(rejected.rejectedManifestRef, `publications/rejected/${key}/manifest.json`);
    assert.deepEqual(refusalsOf(dir), [], `split ${split}: nothing refused`);
    const files = Object.fromEntries(walk(join(dir, "publications")).map((f) => [relative(dir, f), readFileSync(f, "utf8")]));
    outcome[split] = { files, writers: [...new Set(reportOf(dir).records.filter((r) => r.op !== "mkdir").map((r) => r.tool))] };
  }
  assert.deepEqual(outcome.true.files, outcome.false.files, "same paths and bytes with the split on or off");
  assert.ok(Object.keys(outcome.true.files).includes("publications/rejected/k1/rejection.json") && !Object.keys(outcome.true.files).includes("publications/k1/index.html"));
  assert.ok(outcome.true.writers.includes(WRITER), JSON.stringify(outcome.true.writers));
  assert.ok(!outcome.false.writers.includes(WRITER), JSON.stringify(outcome.false.writers));
}
check("g: the real rejectPublication leaves the same files with the split on and off; on, the report names review_reject_writer");

// h. both call sites in newsroom.ts go through the writer when the split is on (the start-up block needs a browser, so it is read from the source)
{
  const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.equal((source.match(/\brejectPublication\(/g) ?? []).length, 3, "rejectPublication: its definition and the two branches of rejectPublicationFor");
  assert.ok(/function rejectPublicationFor\([^)]*\)[^{]*\{\s*return split \? asReviewRejectWriter\(\(\) => rejectPublication\(/.test(source));
  assert.ok(source.includes('await rejectPublicationFor(process.env.NEWSROOM_REVIEW_SPLIT === "1"'));
  assert.ok(source.includes('process.env.NEWSROOM_REVIEW_SPLIT === "1") await asReviewRejectWriter(moveStartupFailure); else await moveStartupFailure();'));
  const block = source.slice(source.indexOf("const moveStartupFailure"), source.indexOf("await moveStartupFailure();") + 30);
  assert.ok(block.includes('stageOp("rename"') && block.includes("recordBoundaryWrite("), "the start-up move keeps its boundary record and staged rename");
}
check("h: newsroom.ts reaches rejectPublication only through rejectPublicationFor, and wraps the start-up rename, both on the split switch");

console.log(`publication reject writer: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
