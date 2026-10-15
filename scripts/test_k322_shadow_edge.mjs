#!/usr/bin/env node
// K322 (K335 update): with NEWSROOM_SHADOW_CHECKS=1 the plan lint reads data through queryDuckDbShadowRead (shadow check A; before K335 it was queryDuckDb). That edge
// is a conditional one and stays on cross_calls.tool_allow.queryDuckDbShadowRead for every tool that reaches lintInfographicPlan; queryDuckDb itself no longer sees it. Checks: (1) a shadow-on run of newsroom_infographic_lint with
// NEWSROOM_GROUP_CALL_REPORT (on by default) records registryDateFor / shadowAsOf / queryDuckDbShadowRead calls (and no queryDuckDb call) with tool_allowed=true for the lint tool and the checker accepts the record;
// (2) a visual tool that is on no queryDuckDbShadowRead list and calls lintInfographicPlan goes red in the ratchet; (3) the K322 knowledgeSide split: viz_lint is not on
// the claim-function lists any more.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadNewsroom, REPO } from "./precision_harness.mjs";

for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_") || name === "NEWSROOM_SHADOW_CHECKS") delete process.env[name];
const groupsJson = JSON.parse(readFileSync(join(REPO, "runtime/pi/groups.json"), "utf8"));
const known = groupsJson.cross_calls;

// ---- 1. shadow-on run, report on ----
const timeline = JSON.parse(readFileSync(join(REPO, "fixtures", "complex", "timeline.json"), "utf8"));
const SOURCE = "id,start_d,end_d,snapshot_date\nX,2015-03-01,2019-05-01,2020-01-01\nY,2016-01-01,,2020-01-01\nZ,2020-02-01,,2020-01-01\nW,2014-01-01,2030-01-01,2020-01-01\n";
const h = await loadNewsroom({ prefix: "k322-", env: { NEWSROOM_SHADOW_CHECKS: "1", NEWSROOM_GROUP_CALL_REPORT: "1" } });
try {
  const fileSrc = h.addData("members", SOURCE);
  const fileA = h.addData("timeline", ["date,event", ...timeline.rows.map((row) => `${row.date},${row.event}`)].join("\n") + "\n");
  const qa = await h.query(`SELECT date, event FROM read_csv_auto('${fileA}')`);
  const claim = await h.recordClaim("The timeline has 4 dated milestones", [fileA], [qa]);
  const setRef = await h.query(`SELECT id FROM read_csv_auto('${fileSrc}') WHERE end_d IS NULL ORDER BY id`);
  const planRef = "visualizations/plans/plan.json";
  writeFileSync(join(h.art, planRef), JSON.stringify({ ...timeline.spec, sql: `SELECT date, event FROM read_csv_auto('${fileA}') ORDER BY date`, claim_id: claim.claim_id }));
  const lint = await h.tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
  const render = await h.tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lint.details.lintRef });
  const igRef = "infographics/plans/plan.json";
  writeFileSync(join(h.art, igRef), JSON.stringify({
    schema_version: "1.0.0", title: "Members", dek: "d", alt: "A header, a statistic and a chart.",
    subject_set: { computation_ref: setRef, key_field: "id", cutoff_date: "2017-12-31" },
    modules: [
      { id: "m1", type: "section_header", span: "full", heading: "Overview" },
      { id: "m2", type: "hero_stat", span: "full", value: "2", label: "Members", claim_id: claim.claim_id },
      { id: "m3", type: "visual", span: "full", manifest_ref: render.details.manifestRef },
    ],
  }));
  const reportPath = join(h.art, "runtime", "cross-call-report.jsonl");
  const before = existsSync(reportPath) ? readFileSync(reportPath, "utf8").split("\n").filter(Boolean).length : 0;
  const result = await h.tools.get("newsroom_infographic_lint").execute("i", { plan_ref: igRef });
  assert.ok(result.details.shadow_asof, "shadow check A ran (the shadow-on path under test)");
  const lines = readFileSync(reportPath, "utf8").split("\n").filter(Boolean).slice(before).map((l) => JSON.parse(l));
  const mine = lines.filter((r) => r.tool === "newsroom_infographic_lint");
  const seen = new Set(mine.map((r) => r.function));
  for (const fn of ["resolveSubjectSets", "registryDateFor", "queryDuckDbShadowRead"]) assert.ok(seen.has(fn), `the record shows ${fn} under newsroom_infographic_lint (saw ${[...seen].join(",")})`);
  assert.ok(!seen.has("queryDuckDb"), "the shadow path no longer reaches queryDuckDb (K335)");
  for (const r of mine.filter((r) => r.function === "queryDuckDbShadowRead")) assert.equal(r.tool_allowed, true, "queryDuckDbShadowRead from the lint tool is on the list");
  const checked = spawnSync(process.execPath, [join(REPO, "scripts/check_cross_call_report.mjs"), reportPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(checked.status, 0, `checker accepts the shadow-on record: ${checked.stdout}${checked.stderr}`);
  console.log(`shadow-on record: ${mine.length} lines under newsroom_infographic_lint, ${checked.stdout.trim().split("\n").pop()} -- PASS`);
} finally {
  rmSync(h.tmp, { recursive: true, force: true });
}

// ---- 2. mutation: a new tool that reaches the shadow path is red ----
const { analyze, compareToolAllow } = await import(pathToFileURL(join(REPO, "scripts/test_group_cross_calls.mjs")).href);
const src = readFileSync(join(REPO, "runtime/pi/newsroom.ts"), "utf8");
const readModule = (spec) => {
  const base = join(REPO, "runtime/pi", spec);
  for (const candidate of [base, base.replace(/\.js$/, ".mjs"), base.replace(/\.js$/, ".ts")]) if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  return null;
};
const run = (text) => analyze({ src: text, groupsJson, readModule });
const outsider = Object.keys(groupsJson.tools).find((t) => groupsJson.tools[t].group === "visual" && !known.tool_allow.queryDuckDbShadowRead.tools.includes(t) && new RegExp(`name: "${t}"`).test(src));
assert.ok(outsider, "fixture: a visual tool that is not on the queryDuckDbShadowRead list");
const at = src.indexOf(`name: "${outsider}"`);
const exec = src.indexOf("async execute(", at);
const open = src.indexOf("{", src.indexOf(")", exec));
assert.deepEqual(compareToolAllow(run(src), known), [], "unmutated source is green");
const red = compareToolAllow(run(`${src.slice(0, open + 1)}\n      await lintInfographicPlan({});${src.slice(open + 1)}`), known);
assert.ok(red.some((m) => m.startsWith(`NEW tool reaches queryDuckDbShadowRead: ${outsider} (visual)`)), `${outsider} calling lintInfographicPlan is red: ${red.slice(0, 3)}`);
assert.ok(red.every((m) => !m.startsWith("NEW tool reaches queryDuckDb:")), "the shadow path does not put the tool on the queryDuckDb list (K335)");
console.log(`mutation (new tool through the shadow path: ${outsider}) -- PASS`);

// ---- 3. the split: viz_lint no longer holds the claim functions ----
for (const name of ["recordClaimArtifact", "replayComputationEvidence"]) assert.deepEqual(known.tool_allow[name].tools, ["newsroom_viz_plan"], `${name}: only viz_plan`);
assert.deepEqual(known.tool_allow.validateSourceEvidence.tools, ["newsroom_chart", "newsroom_viz_plan"]);
console.log("K322 shadow edge -- PASS");
