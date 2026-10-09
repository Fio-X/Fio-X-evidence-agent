#!/usr/bin/env node
// Boundary-report coverage: the JS-side writes in lieflat.mjs, parallel_scheduler.mjs and shadow.mjs now reach the report (NEWSROOM_GROUP_BOUNDARY=1).
// With the switch off nothing is recorded and no report file appears. What the report still cannot see stays listed in not_traced.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "group-coverage-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const rt = (name) => import(pathToFileURL(join(ROOT, "runtime/pi", name)).href);
const groups = await rt("groups.mjs");
const lieflat = await rt("lieflat.mjs");
const shadow = await rt("shadow.mjs");
const scheduler = await rt("parallel_scheduler.mjs");
const reportPath = join(dir, "runtime/group-boundary-report.json");
const results = [];
const check = (name) => results.push(name);

const writeAll = async () => {
  await groups.runInTool("newsroom_lieflat_render", () => lieflat.writeLieflatArtifact(dir, "lieflat/a.json", { a: 1 }));
  await groups.runInTool("newsroom_update_plan", () => shadow.writeShadowRecord(dir, "prose_numbers", { k: 1 }, { v: 1 }));
  await groups.runInTool("newsroom_parallel_tasks", () => scheduler.runTaskDag([{ id: "big", kind: "local_hash" }], async () => ({ blob: "x".repeat(5000) }), { artifactRoot: dir, resultBudgets: Object.fromEntries(Object.keys(scheduler.DEFAULT_RESULT_BUDGETS).map((k) => [k, 100])) }));
};

// off: the same writes happen, nothing is recorded
await writeAll();
assert.ok(existsSync(join(dir, "lieflat/a.json")) && !existsSync(reportPath), "switch off: files are written and no report appears");
check("off: writes happen as before and no report file is created");

// on
process.env.NEWSROOM_GROUP_BOUNDARY = "1";
groups.resetBoundaryReport();
for (const sub of ["lieflat", "shadow", "runtime/parallel-results"]) rmSync(join(dir, sub), { recursive: true, force: true });
await writeAll();
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const find = (tool) => report.records.filter((r) => r.tool === tool);
assert.equal(find("newsroom_lieflat_render").length, 1, "the lieflat write is recorded");
assert.deepEqual(find("newsroom_lieflat_render")[0].examples, ["lieflat/a.json"]);
assert.equal(find("newsroom_lieflat_render")[0].status, "ok", "lieflat/ is a visual_spec written by a visual tool");
const par = find("newsroom_parallel_tasks");
assert.ok(par.length >= 1 && par.every((r) => r.examples.every((e) => e.startsWith("runtime/parallel-results/"))), "the parallel result file is recorded");
const sh = find("newsroom_update_plan");
assert.equal(sh.length, 1);
assert.deepEqual([sh[0].status, sh[0].reason], ["待查", "path matches no artifact kind"], "shadow records have no owner yet: shown as 待查, never as fine");
check("on: lieflat, parallel-result and shadow writes reach the report; the ownerless shadow record is 待查");

// the report never claims zero while something is 待查 or untraced
assert.ok(report.totals.to_check >= 1 && report.complete === false);
assert.ok(report.not_traced.length >= 4, "what stays untraced is still listed");
for (const line of ["Rust-side writes", "child processes", "phase-metrics file", "chain or edit tool"]) assert.ok(report.not_traced.some((t) => t.includes(line)), line);
assert.ok(!report.not_traced.some((t) => /lieflat\.mjs, parallel_scheduler\.mjs and shadow\.mjs/.test(t)), "the hooked sites are no longer listed as untraced");
assert.doesNotMatch(report.summary, /0 violation/i);
check("the report keeps listing what it cannot see and never says 0 violations");

console.log(`group coverage: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
