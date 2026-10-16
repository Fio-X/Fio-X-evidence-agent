#!/usr/bin/env node
// Re-records the base-output fixtures (scripts/fixtures/base-output/*.json) by running each test in record mode against a worktree of the old commit.
// Usage: node scripts/gen_base_output_fixtures.mjs <name>=<worktree>@<commit> ...
//   make the worktree with `git worktree add --detach <dir> <commit>` from a full local clone; the commit is given here, checked against the worktree's HEAD and written nowhere.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// name -> the test that records it, and the extra environment of the recording. The record made with NEWSROOM_REVIEW_SPLIT on (the default) is a second file; the one made without it is never replaced.
const TESTS = {};
const args = process.argv.slice(2);
if (!args.length) throw new Error("usage: gen_base_output_fixtures.mjs <name>=<worktree>@<commit> ...");
for (const arg of args) {
  const eq = arg.indexOf("="), at = arg.lastIndexOf("@");
  const name = arg.slice(0, eq), wt = arg.slice(eq + 1, at), commit = arg.slice(at + 1);
  if (eq < 1 || at < eq + 2 || !commit || !TESTS[name]) throw new Error("unknown or incomplete argument (expected <name>=<worktree>@<commit>)");
  const run = spawnSync("node", [`scripts/${TESTS[name].test}.mjs`], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...TESTS[name].env, NEWSROOM_BASE_RECORD_WT: wt, NEWSROOM_BASE_RECORD_COMMIT: commit } });
  if (run.status !== 0) throw new Error(`${name}: the test failed in record mode (rc ${run.status})`);
}
