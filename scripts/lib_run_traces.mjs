// The one place that says which files under runtime/ are run traces, not artifacts, and may be left out when a test compares or counts an artifact tree.
// Exactly two exact paths. runtime/boundary-refusals.jsonl is never listed: if it shows up, something was refused, and every tree check must see it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const BOUNDARY_REPORT = "runtime/group-boundary-report.json";
export const CHAIN_EVENTS = "runtime/tool-chain-events.jsonl";
export const RUN_TRACES = [BOUNDARY_REPORT, CHAIN_EVENTS];

/**
 * files: paths under dir (relative or absolute). Returns the same list without the run traces, after checking them:
 *  - the boundary report may exist only with NEWSROOM_GROUP_BOUNDARY=1 (exact), and must be a JSON object with a not_traced array;
 *  - the chain event log may exist only when the test runs chain tools ({ chain: true }), and every line must be JSON;
 *  - no other file is skipped, and boundary-refusals.jsonl stays in the list.
 */
export function withoutRunTraces(dir, files, { env = process.env, chain = false, label = "tree" } = {}) {
  const rel = (file) => (isAbsolute(file) ? relative(dir, file) : file);
  const present = new Set(files.map(rel));
  if (present.has(BOUNDARY_REPORT)) {
    assert.equal(env.NEWSROOM_GROUP_BOUNDARY, "1", `${label}: ${BOUNDARY_REPORT} exists although NEWSROOM_GROUP_BOUNDARY is not 1`);
    const report = JSON.parse(readFileSync(join(dir, BOUNDARY_REPORT), "utf8"));
    assert.ok(report && typeof report === "object" && !Array.isArray(report) && Array.isArray(report.not_traced), `${label}: the boundary report is an object with a not_traced array`);
  }
  if (present.has(CHAIN_EVENTS)) {
    assert.ok(chain, `${label}: ${CHAIN_EVENTS} exists but this test runs no chain tool`);
    for (const line of readFileSync(join(dir, CHAIN_EVENTS), "utf8").split("\n").filter(Boolean)) JSON.parse(line);
  }
  return files.filter((file) => !RUN_TRACES.includes(rel(file)));
}
