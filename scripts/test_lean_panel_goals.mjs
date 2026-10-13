#!/usr/bin/env node
// K261: with lean gates a panel's scene goal is EXPLAIN only for a mechanism chart body; any other body falls to COMPARE / MEASURE by its
// visual grammar (table in storyboard.mjs). The Python mirror in verify_artifact.py must give the same goals. Run: node scripts/test_lean_panel_goals.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
const { panelSceneGoal, deriveSceneGraphFromPanels, PANEL_SCENE_GOALS, EXPLAIN_FALLBACK_GOALS } = await import(R + "storyboard.mjs");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
// table: cause kind (and no kind) on every visual grammar
const table = { mechanism: "EXPLAIN", composition: "COMPARE", rank: "COMPARE", benchmark: "COMPARE", distribution: "COMPARE", spatial: "COMPARE", change: "MEASURE", trend: "MEASURE", sequence: "MEASURE", flow: "MEASURE" };
for (const [g, goal] of Object.entries(table)) {
  eq(panelSceneGoal("cause", { type: "visual", visual_grammar: g }), goal, `cause on ${g}`);
  eq(panelSceneGoal(undefined, { type: "visual", visual_grammar: g }), goal, `no kind on ${g}`);
}
eq(panelSceneGoal("cause", { type: "illustration" }), "MEASURE", "cause on an illustration falls to MEASURE");
ok(Object.keys(EXPLAIN_FALLBACK_GOALS).every((g) => g in table), "every fallback grammar is in the table under test");
// other kinds never change
for (const [kind, goal] of Object.entries(PANEL_SCENE_GOALS)) if (kind !== "cause") for (const g of Object.keys(table)) eq(panelSceneGoal(kind, { visual_grammar: g }), goal, `${kind} on ${g} unchanged`);
// a run-7-shaped page (panel kinds and chart grammars of the replayed storyboard): no EXPLAIN scene; python mirror agrees
const kinds = [["p1", "lead_in", "hero_stat", null], ["p2", "scale", "visual", "trend"], ["p3", "cause", "visual", "composition"], ["p4", "space", "visual", "spatial"], ["p5", "scale", "visual", "sequence"], ["p6", "basis", "hero_stat", null]];
const modules = kinds.flatMap(([id, kind, type, g], i) => [
  { id, type: "panel", panel_no: i + 1, panel_kind: kind, heading: `H${i + 1}`, body_module_id: `b${id}`, note_module_id: `t${id}` },
  { id: `b${id}`, type, ...(g ? { visual_grammar: g } : {}), claim_ids: [`c${i}`] }, { id: `t${id}`, type: "text", claim_ids: [`c${i}`] }]);
const page = { modules };
const { scene_graph } = deriveSceneGraphFromPanels(page);
const goals = Object.fromEntries(scene_graph.scenes.map((s) => [s.id, s.primary_cognitive_goal]));
ok(!Object.values(goals).includes("EXPLAIN"), `no EXPLAIN scene: ${JSON.stringify(goals)}`);
eq(goals["scene-p3"], "COMPARE", "p3 (cause, composition) is COMPARE");
const py = execFileSync(process.env.PY ?? "python3", ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from verify_artifact import derive_scene_graph;g,e=derive_scene_graph(json.loads(sys.argv[2]));print(json.dumps(g))", fileURLToPath(new URL("./", import.meta.url)), JSON.stringify(page)], { encoding: "utf8" });
eq(JSON.parse(py), scene_graph, "python and runtime derive the same scene graph");
console.log(`lean panel goals PASS checks=${n}`);
