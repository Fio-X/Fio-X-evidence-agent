#!/usr/bin/env node
// K296: a basis panel may carry a text body (method / scope / caveat words) behind NEWSROOM_BASIS_TEXT_BODY=1 (exact "1", default off).
// Run: node scripts/test_k296_basis_text.mjs   (re-runs itself with the switches set for the "on" half)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const mode = process.argv[2];
const sb = await import(R + "storyboard.mjs");
const KINDS = ["lead_in", "scale", "cause", "space", "compare", "basis"];
const board = (basisText) => {
  const modules = [];
  KINDS.forEach((kind, i) => {
    const n = i + 1;
    modules.push({ id: `p${n}`, type: "panel", panel_no: n, panel_kind: kind, heading: "这一格只说一件事", body_module_id: `b${n}`, note_module_id: `n${n}`, story_node_ids: [`s${n}`], color_use: ["#d0746f"] });
    const text = basisText && kind === "basis";
    modules.push(text ? { id: `b${n}`, type: "text", story_node_ids: [`s${n}`], body: "口径说明", claim_ids: ["c1"] }
      : { id: `b${n}`, type: i === 0 ? "hero_stat" : "visual", story_node_ids: [`s${n}`], manifest_ref: `m${n}`, visual_grammar: "trend", value: 1, label: "x", claim_id: "c1" });
    modules.push({ id: `n${n}`, type: "text", story_node_ids: [`s${n}`], body: "短注", claim_ids: ["c1"] });
  });
  return { schema_version: "1.5.0", language: "zh", color_legend: [{ color: "#d0746f", meaning_id: "synthetic" }], modules };
};
const refs = (spec) => sb.storyboardBlockers(spec, null).filter((b) => b.startsWith("storyboard_panel_refs"));
const withKind = (spec, id, kind) => { spec.modules.find((m) => m.id === id).panel_kind = kind; return spec; };
if (mode === undefined) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "on"], { env: { ...process.env, NEWSROOM_STORYBOARD: "1", NEWSROOM_BASIS_TEXT_BODY: "1" }, encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr);
  assert.equal(r.status, 0, "on half failed");
  // switch not exact "1": same as off
  for (const v of ["2", "true", ""]) {
    const x = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "off"], { env: { ...process.env, NEWSROOM_STORYBOARD: "1", NEWSROOM_BASIS_TEXT_BODY: v }, encoding: "utf8" });
    assert.equal(x.status, 0, `value '${v}' half failed: ${x.stderr}`);
  }
  console.log("k296 PASS");
  process.exit(0);
}
if (mode === "off") {
  ok(refs(board(true)).some((b) => /'p6' body_module_id 'b6' is a text; expected hero_stat or visual or illustration/.test(b)), "off: basis text body refused with the old message");
  ok(refs(board(false)).length === 0, "off: normal board clean");
  console.log(`k296 off checks=${checks}`); process.exit(0);
}
// on
ok(refs(board(true)).length === 0, "on: basis text body accepted");
ok(refs(board(false)).length === 0, "on: normal board still clean");
const mid = board(false); mid.modules.find((m) => m.id === "b3").type = "text";
ok(refs(mid).some((b) => /'p3' body_module_id 'b3' is a text/.test(b)), "on: text body on a non-basis panel still refused");
ok(sb.storyboardBlockers(withKind(board(true), "p6", "compare"), null).some((b) => b.startsWith("storyboard_basis")), "on: no basis panel still refused");
const notLast = board(true); notLast.modules.find((m) => m.id === "p6").panel_no = 2; notLast.modules.find((m) => m.id === "p2").panel_no = 6;
ok(sb.storyboardBlockers(notLast, null).some((b) => b.startsWith("storyboard_basis")), "on: basis not last still refused");
ok(!sb.storyboardBlockers(board(true), null).some((b) => b.startsWith("storyboard_basis")), "on: basis rule satisfied");
console.log(`k296 on checks=${checks}`);
