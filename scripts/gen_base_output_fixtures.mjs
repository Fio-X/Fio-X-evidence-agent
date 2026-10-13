#!/usr/bin/env node
// Re-records the base-output fixtures (scripts/fixtures/base-output/*.json) by running each test in record mode against a worktree of the old commit.
// Usage: node scripts/gen_base_output_fixtures.mjs <name>=<worktree> ...   (make worktrees with `git worktree add --detach <dir> <commit>` from a full local clone)
//   viz_round3=<@abd9d8b> qa_not_applicable=<@d36d7ff> reader_task_example_fix=<@f2aec34> refused_options_fix=<@6a6a69a>
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTS = { viz_round3: "test_viz_round3_conventions", qa_not_applicable: "test_qa_not_applicable", reader_task_example_fix: "test_reader_task_example_fix", refused_options_fix: "test_refused_options_fix" };
const args = process.argv.slice(2);
if (!args.length) throw new Error("usage: gen_base_output_fixtures.mjs <name>=<worktree> ...");
for (const arg of args) {
  const [name, wt] = arg.split("=");
  if (!TESTS[name] || !wt) throw new Error(`unknown or incomplete argument ${arg}`);
  const run = spawnSync("node", [`scripts/${TESTS[name]}.mjs`], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NEWSROOM_BASE_RECORD_WT: wt } });
  if (run.status !== 0) throw new Error(`${name}: the test failed in record mode (rc ${run.status})`);
}
