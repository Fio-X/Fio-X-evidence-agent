#!/usr/bin/env node
// K214 part A: the hand-off writers are checked against groups.json "handoffs". With NEWSROOM_GROUP_ENFORCE=1 (and HANDOFF) a write by a writer is
// refused unless a row lists its path and the asking tool. This test walks the table: every (row, requester) is let in, every row has a wrong-requester
// and a wrong-path counterexample that is refused and logged, and with the switches off nothing is checked and nothing is written.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const g = await import("../runtime/pi/groups.mjs");
const table = g.loadGroups().handoffs;
const scratch = makeTestTmp("handoff-table-");
let n = 0;
const fresh = () => join(scratch, `d${n++}`);
const sample = (p) => (p.endsWith("/") ? `${p}x.json` : p);
const as = (writer, tool, root, path) => g.runInTool(tool, () => g.asHandoffWriter(writer, () => g.recordBoundaryWrite(root, path, "write_if_absent")));
const refusals = (root) => { const f = join(root, g.REFUSAL_LOG_PATH); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const refused = (fn) => { try { fn(); } catch (e) { return e?.code === "BOUNDARY_REFUSED" ? e : assert.fail(`wrong error: ${e?.message}`); } return null; };

// table shape: every row names a listed writer, a path, requesters that are tools in groups.json, and says why
const tools = g.loadGroups().tools;
const problems = [];
for (const [i, r] of table.rows.entries()) {
  const at = `row ${i} (${r.writer} ${r.paths.join(",")})`;
  if (!table.writers[r.writer]) problems.push(`${at}: writer not in handoffs.writers`);
  if (!r.paths?.length || !r.requesters?.length) problems.push(`${at}: empty paths or requesters`);
  if (!r.why || !r.remove_when) problems.push(`${at}: why / remove_when missing`);
  const kind = g.classifyArtifact(sample(r.paths[0]))?.kind;
  if (!table.writers[r.writer]?.kinds.includes(kind)) problems.push(`${at}: the path is the kind ${kind ?? "unclassified"}, which the writer does not write`);
  for (const q of r.requesters) if (!tools[q]) problems.push(`${at}: requester ${q} is not a tool in groups.json`);
  for (const q of r.not_measured ?? []) if (!r.requesters.includes(q)) problems.push(`${at}: not_measured ${q} is not a requester`);
}
for (const w of Object.keys(table.writers)) if (!table.rows.some((r) => r.writer === w)) problems.push(`writer ${w} has no row`);
assert.deepEqual(problems, [], problems.join("\n"));

// Rust side (not run here, read as text): the four as_* doors in src/group_guard.rs are exactly the rows of handoffs.rust, as_writer is private,
// and every asking command is a command of COMMAND_GROUPS
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const guard = readFileSync(join(root, "src/group_guard.rs"), "utf8");
  const cli = readFileSync(join(root, "src/cli.rs"), "utf8");
  const doors = [...guard.matchAll(/^pub fn (as_[a-z_]+)</gm)].map((m) => m[1]).sort();
  assert.deepEqual(doors, table.rust.map((r) => r.as).sort(), "the as_* doors and handoffs.rust must list the same functions");
  assert.ok(!/^pub fn as_writer\b/m.test(guard), "as_writer must stay private");
  const commands = new Set([...cli.slice(cli.indexOf("COMMAND_GROUPS")).split("];")[0].matchAll(/\("([a-z0-9-]+)", "[a-z]+"\)/g)].map((m) => m[1]));
  for (const r of table.rust) {
    for (const c of r.commands) assert.ok(commands.has(c), `${r.as}: ${c} is not a command in COMMAND_GROUPS`);
    for (const c of r.not_measured) assert.ok(r.commands.includes(c), `${r.as}: not_measured ${c} is not a listed command`);
    assert.ok(r.why && r.remove_when, `${r.as}: why / remove_when missing`);
  }
}

// off: no check, no file, even for a requester no row lists
{
  const root = fresh();
  assert.doesNotThrow(() => as("knowledge_writer", "newsroom_viz_render", root, "computations/x.json"));
  assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0, "switches off: nothing may be written");
}

process.env.NEWSROOM_GROUP_HANDOFF = "1";
process.env.NEWSROOM_GROUP_ENFORCE = "1";
let allowed = 0, counter = 0, unmeasured = 0;
for (const row of table.rows) {
  for (const q of row.requesters) {
    const root = fresh();
    if ((row.not_measured ?? []).includes(q)) {
      // listed from reading the code but never seen in a run: refused, and logged, until a run measures it
      const err = refused(() => as(row.writer, q, root, sample(row.paths[0])));
      assert.ok(err, `${q} -> ${row.writer} ${row.paths[0]} is not measured yet and must be refused`);
      assert.match(refusals(root)[0]?.reason ?? "", /not measured yet/, "the log says why");
      assert.equal(refusals(root).length, 1, "the not-measured refusal is logged once");
      unmeasured++;
      continue;
    }
    assert.doesNotThrow(() => as(row.writer, q, root, sample(row.paths[0])), `${q} -> ${row.writer} ${row.paths[0]} must be let in`);
    assert.deepEqual(refusals(root), []);
    allowed++;
  }
  // wrong requester: a tool no row lists for this writer and path
  const listed = new Set(table.rows.filter((r) => r.writer === row.writer && r.paths.some((p) => sample(row.paths[0]).startsWith(p))).flatMap((r) => r.requesters));
  const stranger = Object.keys(tools).find((t) => !listed.has(t) && tools[t].group === "visual") ?? Object.keys(tools).find((t) => !listed.has(t));
  const root = fresh();
  const err = refused(() => as(row.writer, stranger, root, sample(row.paths[0])));
  assert.ok(err, `${stranger} must be refused as a requester of ${row.writer} ${row.paths[0]}`);
  assert.match(err.detail.status, /handoff_not_listed|check_failed|cross_group/);
  assert.equal(refusals(root).length, 1, "the refusal is logged once");
  counter++;
}
// a write with no asking tool at all (a direct call outside any tool) is refused too
{
  const root = fresh();
  const err = refused(() => g.asHandoffWriter("shadow_writer", () => g.recordBoundaryWrite(root, "shadow/x.json", "write_if_absent")));
  assert.ok(err, "no asking tool: refused");
}
// wrong path: each writer, asked by one of its own requesters, for a path outside its rows (inside its group's kind, so only the table can stop it)
for (const [name, w] of Object.entries(table.writers)) {
  const own = table.rows.find((r) => r.writer === name);
  const root = fresh();
  const err = refused(() => as(name, own.requesters[0], root, "nowhere/x.json"));
  assert.ok(err, `${name} must not write an unclassified path`);
  // a path of the same kind but not listed: the other writers' folders
  const other = table.rows.find((r) => r.writer !== name && table.writers[r.writer].kinds.some((k) => w.kinds.includes(k)) && !table.rows.some((x) => x.writer === name && x.paths.some((p) => sample(r.paths[0]).startsWith(p))));
  if (other) {
    const r2 = fresh();
    const e2 = refused(() => as(name, own.requesters[0], r2, sample(other.paths[0])));
    assert.ok(e2, `${name} must not write ${other.paths[0]}, which no row of it lists`);
  }
}
// an unlisted writer cannot even start
assert.throws(() => g.asHandoffWriter("tool_made_writer", () => {}), /not listed/);
// the old entry point is not exported
assert.equal(g.runAsWriter, undefined, "runAsWriter must not be exported");
console.log(`ok: handoffs table: ${allowed} measured (row, requester) pairs let in, ${unmeasured} not-measured pairs refused, ${counter} rows with a refused wrong requester, wrong paths refused, writers fixed by the table, off = no check`);
