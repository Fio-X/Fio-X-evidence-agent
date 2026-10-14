// Route A chain replay, page-tool segment. Usage: node scripts/test_chain_replay_a.mjs <dir> <clean|bad|off>
// Real page tools (plan, lint, render, critic, preview) on a hand-written fixture, with the four group switches ON (or all 0 for the groups-off variant), a stubbed rasterizer, no
// model, no network. It leaves the run at <dir>/<mode>/run for the Python driver (test_chain_replay.py) to carry into the completion gate.
//   clean: SPEED_PREFLIGHT on, a plan that omits the derivable references: all five steps succeed and the references are filled.
//   bad:   the same, but the novelty record says passed:false: preflight refuses the plan and nothing is written to infographics/plans.
//   off:   SPEED_PREFLIGHT "0", the clean fixture and plan: refused by the ordinary required-field check, NOT by preflight (so the bad case's
//          refusal comes from preflight and from nothing else).
// Mutation check (do it in a scratch tree, keep nothing): make preflight never refuse (preflightError returning null) and `bad` goes red.
// Exit codes: 0 pass, 77 skipped (no duckdb binary), anything else fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ENV, ROOT, freshRun, loadTree, omittedPlan, pipeline, readerQuestion, register, schemaOrdered, setupRasterStub } from "./lib_page_chain_fixture.mjs";

const [dir, mode, groupValue = "1"] = process.argv.slice(2);
if (!["0", "1"].includes(groupValue)) { console.error("group value must be 0 or 1"); process.exit(2); }
if (!dir || !["clean", "bad", "off"].includes(mode)) { console.error("usage: test_chain_replay_a.mjs <dir> <clean|bad|off>"); process.exit(2); }
if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") { console.log("SKIP: duckdb binary not found"); process.exit(77); }
for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_") && key !== "NEWSROOM_DUCKDB_BIN") delete process.env[key];
setupRasterStub();

const GROUPS = ["NEWSROOM_GROUP_TOOLS", "NEWSROOM_GROUP_ENFORCE", "NEWSROOM_GROUP_HANDOFF", "NEWSROOM_GROUP_CALL_REPORT"];
const { mod } = await loadTree(mode);
const tools = register(mod, { ...BASE_ENV, ...Object.fromEntries(GROUPS.map((k) => [k, groupValue])), NEWSROOM_SPEED_PREFLIGHT: mode === "off" ? "0" : "1" });
const art = freshRun(`chain-${mode}`);
if (mode === "bad") writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: false }));
const plans = () => readdirSync(join(art, "infographics/plans"));
const plan = () => schemaOrdered(tools, omittedPlan());
const planError = async () => { try { await tools.get("newsroom_infographic_plan").execute("p", plan()); } catch (error) { return String(error?.message ?? error); } assert.fail("the plan was accepted"); };
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

if (mode === "clean") {
  const run = await pipeline(tools, plan(), { omit: true });
  ok(run.lint.details.passed === true, "lint passed");
  ok(Boolean(run.render.details.manifestRef && run.critic.details.criticRef && run.preview.details), "render, critic and preview each returned a result");
  const saved = JSON.parse(readFileSync(join(art, run.p.details.planRef), "utf8"));
  assert.equal(saved.reader_question, readerQuestion); checks++;
  assert.equal(saved.modules[0].critic_ref, "visualizations/critics/map.json", "critic_ref filled by preflight"); checks++;
  assert.equal(plans().length, 1, "exactly one plan file"); checks++;
  const report = join(art, "runtime/cross-call-report.jsonl");
  const hasRow = existsSync(report) && readFileSync(report, "utf8").split("\n").filter(Boolean).some((l) => JSON.parse(l).tool === "newsroom_infographic_plan");
  ok(hasRow === (groupValue === "1"), "call report has a newsroom_infographic_plan row exactly when the group switches are on");
} else if (mode === "bad") {
  const message = await planError();
  ok(/^Preflight found \d+ unmet preconditions? for newsroom_infographic_plan/.test(message), message);
  ok(/novelty_ref is missing and could not be derived: no passing editorial\/novelty artifact.*newsroom_semantic_novelty/.test(message), message);
  assert.deepEqual(plans(), [], "nothing written to infographics/plans"); checks++;
} else {
  const message = await planError();
  ok(!/Preflight found/.test(message), `off: refused by the ordinary check, not by preflight: ${message.slice(0, 200)}`);
  assert.deepEqual(plans(), [], "nothing written"); checks++;
}
mkdirSync(join(dir, mode), { recursive: true });
cpSync(art, join(dir, mode, "run"), { recursive: true });
console.log(`chain replay A (${mode}): ${checks} checks -- PASS`);
