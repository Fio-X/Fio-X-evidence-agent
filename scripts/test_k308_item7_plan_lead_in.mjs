#!/usr/bin/env node
// K308 item 7: the plan reports storyboard_lead_in / storyboard_basis in the same turn (NEWSROOM_FIRST_TRY_PANELS=1, with NEWSROOM_STORYBOARD=1).
// Same strings as the page lint; off: nothing added. Run: node scripts/test_k308_item7_plan_lead_in.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const set = (env) => { for (const k of ["NEWSROOM_STORYBOARD", "NEWSROOM_FIRST_TRY_PANELS"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } };
const sb = await import(new URL("../runtime/pi/storyboard.mjs", import.meta.url).pathname);
const KINDS = ["lead_in", "scale", "cause", "space", "compare", "basis"];
const board = (kinds) => {
  const modules = [];
  kinds.forEach((kind, i) => {
    const n = i + 1;
    modules.push({ id: `p${n}`, type: "panel", panel_no: n, panel_kind: kind, heading: "这一格只说一件事", body_module_id: `b${n}`, note_module_id: `n${n}`, story_node_ids: [`s${n}`], color_use: ["ink"] });
    modules.push({ id: `b${n}`, type: "visual", story_node_ids: [`s${n}`], manifest_ref: `m${n}`, visual_grammar: "trend" });
    modules.push({ id: `n${n}`, type: "text", story_node_ids: [`s${n}`], body: "短注" });
  });
  return { schema_version: "1.5.0", language: "zh", modules };
};
const bad = board(["space", ...KINDS.slice(1)]); // p1 is 'space', the run's shape
const good = board(KINDS);
const ON = { NEWSROOM_STORYBOARD: "1", NEWSROOM_FIRST_TRY_PANELS: "1" };
for (const env of [{}, { NEWSROOM_STORYBOARD: "1" }, { NEWSROOM_FIRST_TRY_PANELS: "1" }, { NEWSROOM_STORYBOARD: "1", NEWSROOM_FIRST_TRY_PANELS: "true" }, { NEWSROOM_STORYBOARD: "1", NEWSROOM_FIRST_TRY_PANELS: " 1" }]) {
  set(env); ok(sb.storyboardPlanIssues(bad).length === 0, `off ${JSON.stringify(env)}: nothing added`);
}
set(ON);
const issues = sb.storyboardPlanIssues(bad);
ok(issues.length === 1 && /^storyboard_lead_in: exactly one panel has panel_kind 'lead_in' and it is panel 1$/.test(issues[0]), `on: reports lead_in (${issues})`);
ok(sb.storyboardBlockers(bad).includes(issues[0]), "on: the very string the page lint produces");
ok(sb.storyboardPlanIssues(good).length === 0, "on: a good board adds nothing");
ok(sb.storyboardPlanIssues(board(["lead_in", "scale", "cause", "space", "compare", "compare"])).some((t) => t.startsWith("storyboard_basis:")), "on: basis reported too");
ok(sb.storyboardPlanIssues({ schema_version: "1.5.0", modules: [{ id: "a", type: "text" }] }).length === 0, "on: a page without panels adds nothing");
set({});
const src = readFileSync(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
ok((src.match(/storyboardPlanIssues\(/g) ?? []).length === 2, "wired into both plan preflight lists (the all-checks list and the plan tool)");
console.log(`K308 item 7 plan lead-in: PASS (${checks} checks)`);
