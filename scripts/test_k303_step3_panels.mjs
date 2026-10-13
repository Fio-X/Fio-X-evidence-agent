#!/usr/bin/env node
// K303 step 3: NEWSROOM_FIRST_TRY_PANELS=1 (exact "1", default off) adds text to two storyboard refusals. Off: byte for byte. Same panels refused either way.
// Run: node scripts/test_k303_step3_panels.mjs
import assert from "node:assert/strict";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const sb = await import(R + "storyboard.mjs");
const SWITCH = "NEWSROOM_FIRST_TRY_PANELS";
const KINDS = ["lead_in", "scale", "cause", "space", "compare", "scale"]; // the last panel is not a basis panel
const board = () => {
  const modules = [];
  KINDS.forEach((kind, i) => {
    const n = i + 1;
    modules.push({ id: `p${n}`, type: "panel", panel_no: n, panel_kind: kind, heading: "这一格只说一件事", body_module_id: `b${n}`, note_module_id: `n${n}`, story_node_ids: [`s${n}`], color_use: ["#d0746f"] });
    modules.push(n === 6 ? { id: `b${n}`, type: "text", story_node_ids: [`s${n}`], body: "口径说明", claim_ids: ["c1"] }
      : { id: `b${n}`, type: i === 0 ? "hero_stat" : "visual", story_node_ids: [`s${n}`], manifest_ref: `m${n}`, visual_grammar: "trend", value: 1, label: "x", claim_id: "c1" });
    modules.push({ id: `n${n}`, type: "text", story_node_ids: [`s${n}`], body: "短注", claim_ids: ["c1"] });
  });
  return { schema_version: "1.5.0", language: "zh", color_legend: [{ color: "#d0746f", meaning_id: "synthetic" }], modules };
};
const pick = (prefix) => sb.storyboardBlockers(board(), null).filter((b) => b.startsWith(prefix));
const BASIS_OFF = "storyboard_basis: exactly one panel has panel_kind 'basis' and it is the last panel";
const REFS_OFF = "storyboard_panel_refs: panel 'p6' body_module_id 'b6' is a text; expected hero_stat or visual or illustration";
for (const off of [undefined, "0", "true", " 1"]) {
  if (off === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = off;
  ok(sb.firstTryPanelsEnabled() === false, `off for ${JSON.stringify(off)}`);
  ok(pick("storyboard_basis").join("|") === BASIS_OFF, "off: basis refusal byte for byte");
  ok(pick("storyboard_panel_refs").join("|") === REFS_OFF, "off: refs refusal byte for byte");
}
const offAll = sb.storyboardBlockers(board(), null);
process.env[SWITCH] = "1";
ok(sb.firstTryPanelsEnabled() === true, "on");
const onAll = sb.storyboardBlockers(board(), null);
ok(onAll.length === offAll.length, "on: the same number of refusals");
ok(onAll.map((b) => b.split(":")[0]).join() === offAll.map((b) => b.split(":")[0]).join(), "on: the same codes in the same order");
ok(pick("storyboard_basis")[0].startsWith(BASIS_OFF) && /; now: p1 is lead_in, p2 is scale, .*, p6 is scale$/.test(pick("storyboard_basis")[0]), "on: basis refusal lists every panel's kind");
ok(pick("storyboard_panel_refs")[0].startsWith(REFS_OFF) && /claim template/.test(pick("storyboard_panel_refs")[0]), "on: refs refusal says what a hero_stat body needs");
// a clean board stays clean
const clean = board(); clean.modules.find((m) => m.id === "p6").panel_kind = "basis"; clean.modules.find((m) => m.id === "b6").type = "visual";
ok(sb.storyboardBlockers(clean, null).filter((b) => /^storyboard_(basis|panel_refs)/.test(b)).length === 0, "on: a good basis panel is not refused");
delete process.env[SWITCH];
console.log(`K303 step 3 panels: PASS (${checks} checks)`);
