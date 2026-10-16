#!/usr/bin/env node
// NEWSROOM_GROUP_EXEMPT_RECORD: a write that skips the judgement because of an exemption (the E1 temp names and folder, the bookkeeping files, session/) is
// appended to the call report as one {kind:"exempt_write"} row. Record only: it never refuses, never changes a write or a verdict. Only the exact value "1" turns it
// on; off, nothing is read or written. Checks: a row per exemption, the exact-"1" rule, off = same files and same verdicts, a refusal is unchanged, a record that
// cannot be written never throws, the report readers set the rows apart, and mutants (record call dropped, switch loosened) turn it red.
// Loads copies of runtime/pi/groups.mjs only. No provider, no network.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("group-exempt-record-");
const results = [];
const check = (name) => results.push(name);
const clearEnv = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name]; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const T = "newsroom_viz_render";
const REPORT = "runtime/cross-call-report.jsonl";

let treeSeq = 0;
const loadGroups = async (mutate) => {
  const tree = join(scratch, `tree-${++treeSeq}`);
  cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
  if (mutate) { const path = join(tree, "runtime/pi/groups.mjs"); writeFileSync(path, mutate(readFileSync(path, "utf8"))); }
  return import(pathToFileURL(join(tree, "runtime/pi/groups.mjs")).href);
};
const dirFor = (() => { let n = 0; return () => { const d = join(scratch, `art-${++n}`); mkdirSync(join(d, "runtime/preview-tmp"), { recursive: true }); mkdirSync(join(d, "session"), { recursive: true }); return d; }; })();
const setup = (dir) => {
  for (const f of ["events.jsonl", "session/a.jsonl", "session/b.jsonl", "old.json.tmp", "plain.json"]) writeFileSync(join(dir, f), "x\n");
};
const rowsOf = (dir) => (existsSync(join(dir, REPORT)) ? readFileSync(join(dir, REPORT), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const listing = (dir) => {
  const walk = (d, rel = "") => readdirSync(join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, join(rel, e.name)) : [join(rel, e.name)]));
  return walk(dir).filter((f) => f !== REPORT).sort().map((f) => `${f}\t${readFileSync(join(dir, f), "utf8")}`);
};

/** One tool call whose child process writes under every exemption; returns what the call did and what it left. */
async function scenario(g, value) {
  clearEnv();
  Object.assign(process.env, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1" });
  if (value !== undefined) process.env.NEWSROOM_GROUP_EXEMPT_RECORD = value;
  const dir = dirFor();
  setup(dir);
  const outcome = await g.runInTool(T, () => g.runDeclared(dir, ["runtime/preview-tmp/a.png"], async () => {
    await sleep(15);
    writeFileSync(join(dir, "runtime/preview-tmp/a.png"), "png");           // declared, in the preview folder
    writeFileSync(join(dir, "runtime/preview-tmp/b.png"), "png");           // not declared, same folder
    writeFileSync(join(dir, "new.json.tmp"), "x");                          // a new temp name
    appendFileSync(join(dir, "old.json.tmp"), "more\n");                    // an existing temp name changed
    appendFileSync(join(dir, "events.jsonl"), "more\n");                    // a bookkeeping file changed
    appendFileSync(join(dir, "session/a.jsonl"), "more\n");                 // session/ changed
    rmSync(join(dir, "session/b.jsonl"));                                   // session/ removed
    writeFileSync(join(dir, "new.json.tmp"), "xx");                         // the same path again: one row only
  }, { watch: [".", "runtime/preview-tmp"] })).catch((e) => e);
  return { dir, outcome };
}
const EXPECTED = [
  ["events.jsonl", "bookkeeping_file", "change"],
  ["new.json.tmp", "temp_suffix", "new"],
  ["old.json.tmp", "temp_suffix", "change"],
  ["runtime/preview-tmp/a.png", "preview_tmp", "declared"],
  ["runtime/preview-tmp/b.png", "preview_tmp", "new"],
  ["session/a.jsonl", "session_folder", "change"],
  ["session/b.jsonl", "session_folder", "delete"],
];
const shape = (rows) => rows.map((r) => [r.path, r.exemption, r.op]).sort((a, b) => a[0].localeCompare(b[0], "en-US"));

async function exercise(g) {
  // 1. on: one row per exemption and path, nothing else
  const on = await scenario(g, "1");
  assert.equal(on.outcome, undefined, "the call passes with the record on");
  const rows = rowsOf(on.dir);
  assert.ok(rows.every((r) => r.kind === "exempt_write" && r.side === "js" && r.tool === T && Object.keys(r).length === 6), "every row: kind, side, tool, path, exemption, op");
  assert.deepEqual(shape(rows), EXPECTED, "a row for each exemption, a repeated path once");

  // 2. only the exact "1" turns it on; any other value writes no report at all and leaves the same files and the same verdict
  const off = await scenario(g, undefined);
  assert.equal(off.outcome, undefined);
  assert.equal(existsSync(join(off.dir, REPORT)), false, "unset: no report file");
  assert.deepEqual(listing(off.dir).map((l) => l.split("\t")[0]), listing(on.dir).map((l) => l.split("\t")[0]), "on or off, the same files are left");
  for (const value of ["", "0", "true", "yes", "01", " 1", "1 ", "11", "on"]) {
    const other = await scenario(g, value);
    assert.equal(other.outcome, undefined, `${JSON.stringify(value)}: the call passes`);
    assert.equal(existsSync(join(other.dir, REPORT)), false, `${JSON.stringify(value)}: no report file`);
    assert.deepEqual(listing(other.dir), listing(off.dir), `${JSON.stringify(value)}: byte-identical to unset`);
  }
  assert.deepEqual(listing(on.dir), listing(off.dir), "on: the files the call leaves are byte-identical to off");
  return { on };
}

const g = await loadGroups();
await exercise(g);
check("record on (exact \"1\"): one row for each exemption (temp name new/changed, preview folder declared/new, bookkeeping file changed, session/ changed/removed), a repeated path once; unset and 9 other values write no report and leave byte-identical files");

// 3. a refusal is the same with the record on: only the undeclared file is named, and the exempt writes are still recorded
{
  const run = async (value) => {
    clearEnv();
    Object.assign(process.env, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1" });
    if (value) process.env.NEWSROOM_GROUP_EXEMPT_RECORD = value;
    const dir = dirFor();
    setup(dir);
    const err = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { await sleep(15); writeFileSync(join(dir, "stray.csv"), "x"); writeFileSync(join(dir, "z.json.tmp"), "x"); appendFileSync(join(dir, "plain.json"), "more\n"); })).catch((e) => e);
    return { dir, err };
  };
  const a = await run("1"), b = await run(undefined);
  assert.ok(a.err instanceof g.BoundaryRefusal && b.err instanceof g.BoundaryRefusal, "both refuse");
  assert.equal(a.err.message, b.err.message, "the refusal text is identical with the record on");
  assert.deepEqual(a.err.detail.extra, ["stray.csv"]); assert.deepEqual(a.err.detail.changed, ["plain.json"]);
  assert.deepEqual(a.err.detail.extra, b.err.detail.extra); assert.deepEqual(a.err.detail.changed, b.err.detail.changed);
  assert.deepEqual(shape(rowsOf(a.dir)), [["z.json.tmp", "temp_suffix", "new"]], "the exempt temp file is recorded, the refused ones are not (they are judged)");
  check("a refusal is word for word the same with the record on; the judged files are not recorded, the exempt temp file is");
}

// 4. the report's own file is never recorded, and a record that cannot be written never throws
{
  clearEnv();
  Object.assign(process.env, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_EXEMPT_RECORD: "1" });
  const dir = dirFor();
  setup(dir);
  writeFileSync(join(dir, REPORT), "");
  const own = await g.runInTool(T, () => g.runDeclared(dir, [], async () => { await sleep(15); appendFileSync(join(dir, REPORT), "{}\n"); })).catch((e) => e);
  assert.equal(own, undefined);
  assert.deepEqual(rowsOf(dir).filter((r) => r.kind === "exempt_write"), [], "a change to the report itself writes no row");
  const dirBad = dirFor();
  setup(dirBad);
  mkdirSync(join(dirBad, REPORT), { recursive: true }); // a folder where the report file should be: the append fails
  const bad = await g.runInTool(T, () => g.runDeclared(dirBad, [], async () => { await sleep(15); writeFileSync(join(dirBad, "q.json.tmp"), "x"); })).catch((e) => e);
  assert.equal(bad, undefined, "a record that cannot be written does not stop the call");
  check("the report's own file is not recorded; a record that cannot be written is swallowed and the call passes");
}

// 5. the two report readers set the rows apart: the checker does not call one undeclared, the summary lists them under their own heading
{
  clearEnv();
  Object.assign(process.env, { NEWSROOM_GROUP_TOOLS: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_EXEMPT_RECORD: "1" });
  const { dir } = await scenario(g, "1");
  const file = join(dir, REPORT);
  const call = JSON.stringify({ tool: "newsroom_viz_render", tool_group: "visual", function: "queryDuckDb", callee_owner: "knowledge", declared: true });
  const withoutRows = join(scratch, "plain-report.jsonl"), withRows = join(scratch, "mixed-report.jsonl");
  writeFileSync(withoutRows, `${call}\n`);
  writeFileSync(withRows, `${call}\n${readFileSync(file, "utf8")}`);
  const run = (script, target) => spawnSync(process.execPath, [join(ROOT, "scripts", script), target], { encoding: "utf8" });
  const plainCheck = run("check_cross_call_report.mjs", withoutRows), mixedCheck = run("check_cross_call_report.mjs", withRows);
  assert.equal(mixedCheck.status, plainCheck.status, "the checker's verdict does not change with the rows");
  assert.match(mixedCheck.stdout, /7 exempt-write row\(s\) not judged/);
  assert.doesNotMatch(plainCheck.stdout, /exempt-write/, "no rows: the line is word for word as before");
  const plainSum = run("summarize_cross_call_report.mjs", withoutRows), mixedSum = run("summarize_cross_call_report.mjs", withRows);
  assert.match(mixedSum.stdout, /EXEMPT WRITES \(7, record only, never judged\)/);
  const bare = (out, target) => out.split(target).join("<report>");
  assert.ok(bare(mixedSum.stdout, withRows).startsWith(bare(plainSum.stdout, withoutRows).trimEnd()), "everything before the new heading is what the summary printed without the rows");
  assert.doesNotMatch(plainSum.stdout, /EXEMPT WRITES/);
  // a row that says it is exempt must prove it: a forged one is a bad row, the checker is red and the summary lists it apart
  assert.equal(plainCheck.status, 0, "the clean report is green, so a red below is the forged row");
  const forged = {
    "a forged exempt row on a path that is not exempt": { kind: "exempt_write", side: "js", tool: T, path: "plain.json", exemption: "temp_suffix", op: "change" },
    "a wrong exemption name": { kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "whatever", op: "change" },
    "an exemption that does not match the path": { kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "session_folder", op: "change" },
    "an exempt row with no op": (({ op, ...rest }) => rest)({ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }),
    "an exempt row with no side": (({ side, ...rest }) => rest)({ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }),
    "an exempt row with no tool field": (({ tool, ...rest }) => rest)({ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }),
    "an exempt row with no path": (({ path, ...rest }) => rest)({ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }),
    "an exempt row with no exemption": (({ exemption, ...rest }) => rest)({ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }),
    "an unknown side": { ...{ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }, side: "python" },
    "an unknown op": { ...{ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }, op: "whatever" },
    "a tool that is not in the table": { ...{ kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change" }, tool: "not_a_tool" },
    "an absolute path": { kind: "exempt_write", side: "js", tool: T, path: "/abs/old.json.tmp", exemption: "temp_suffix", op: "change" },
    "a path with a parent segment": { kind: "exempt_write", side: "js", tool: T, path: "../old.json.tmp", exemption: "temp_suffix", op: "change" },
    "a path with a backslash": { kind: "exempt_write", side: "js", tool: T, path: "a\\b.tmp", exemption: "temp_suffix", op: "change" },
    "a path with a newline": { kind: "exempt_write", side: "js", tool: T, path: "old.json\nEXEMPT WRITES (99).tmp", exemption: "temp_suffix", op: "change" },
    "a path with a control character": { kind: "exempt_write", side: "js", tool: T, path: "old\u0007.tmp", exemption: "temp_suffix", op: "change" },
    "an exempt row that carries call fields": { kind: "exempt_write", side: "js", tool: T, path: "old.json.tmp", exemption: "temp_suffix", op: "change", tool_group: "visual", function: "queryDuckDb", declared: true },
  };
  const reasonOf = [
    [/no op/, /lacks fields .*op/], [/no side/, /lacks fields .*side/], [/no tool field/, /lacks fields .*tool/], [/no path/, /lacks fields .*path/], [/no exemption/, /lacks fields .*exemption/],
    [/unknown side/, /unknown side/], [/unknown op/, /unknown op/], [/not in the table/, /unknown tool/], [/absolute|parent|backslash|newline|control/, /not a plain relative path/],
    [/not exempt/, /is not exempt as/], [/wrong exemption/, /unknown exemption/], [/does not match/, /is not exempt as/], [/call fields/, /carries fields/],
  ];
  for (const [name, row] of Object.entries(forged)) {
    const bad = join(scratch, "forged-report.jsonl");
    writeFileSync(bad, `${call}\n${readFileSync(file, "utf8")}${JSON.stringify(row)}\n`);
    const checked = run("check_cross_call_report.mjs", bad);
    assert.equal(checked.status, 1, `the checker must be red for ${name}`);
    assert.match(checked.stdout, /BAD EXEMPT ROW/);
    assert.match(checked.stdout, reasonOf.find(([when]) => when.test(name))[1], `the reason for ${name}`);
    assert.match(checked.stdout, /1 bad exempt-write row\(s\)/);
    assert.match(checked.stdout, /7 exempt-write row\(s\) not judged/, "the valid rows are still counted");
    const summed = run("summarize_cross_call_report.mjs", bad);
    assert.match(summed.stdout, /EXEMPT WRITES \(7, record only, never judged\)/, "the forged row is not listed as an exempt write");
    assert.match(summed.stdout, /BAD ROWS \(1, said exempt_write but did not prove it\)/);
    assert.equal(summed.stdout.split("\n").filter((line) => /^EXEMPT WRITES/.test(line)).length, 1, "a string in a row cannot start a heading of its own");
    assert.doesNotMatch(summed.stdout, /^EXEMPT WRITES \(99/m);
  }
  check("report readers: a forged exempt row (non-exempt path, wrong or mismatched exemption name, call fields) turns the checker red and is listed as a bad row, not as an exempt write");
  check("report readers: the checker counts the rows without judging them, the summary lists them under their own heading; with no rows both print what they printed before");
}

// 6. mutants: each is red (the exercise throws), the unchanged copy is green
const mutants = {
  "the record call is dropped": (s) => s.replace('appendFileSync(file, `${JSON.stringify({ kind: "exempt_write"', 'void (`${JSON.stringify({ kind: "exempt_write"'),
  "the switch accepts any non-empty value": (s) => s.replace('process.env.NEWSROOM_GROUP_EXEMPT_RECORD === "1"', 'Boolean(process.env.NEWSROOM_GROUP_EXEMPT_RECORD)'),
  "the declared preview-folder write is not recorded": (s) => s.replace('else noteExempt(root, path, "declared");', ""),
  "a bookkeeping change is not recorded": (s) => s.replace('if (moved && (isBookkeeping(path) || (isE1Temp(path) && !declared.has(path)))) noteExempt(root, path, "change");', ""),
  "a removal under session/ is not recorded": (s) => s.replace('noteExempt(root, path, "delete");', ""),
};
{
  await exercise(await loadGroups((s) => s));
  check("mutation: an unchanged copy -> green");
  for (const [name, mutate] of Object.entries(mutants)) {
    const mutated = await loadGroups(mutate);
    let red = false;
    try { await exercise(mutated); } catch (error) { red = error?.code === "ERR_ASSERTION"; }
    assert.ok(red, `mutant must turn the exercise red: ${name}`);
    check(`mutation: ${name} -> red`);
  }
  // a mutant that changes nothing would be a false red: prove each edit really hit the source
  const src = readFileSync(join(ROOT, "runtime/pi/groups.mjs"), "utf8");
  for (const [name, mutate] of Object.entries(mutants)) assert.notEqual(mutate(src), src, `the edit for "${name}" matches the source`);
}
clearEnv();
for (const name of results) console.log(`  ok  ${name}`);
console.log(`group exempt record: PASS (${results.length} checks)`);
