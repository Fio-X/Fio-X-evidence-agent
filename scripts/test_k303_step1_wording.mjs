#!/usr/bin/env node
// K303 step 1: NEWSROOM_FIRST_TRY_WORDING=1 (exact "1", default off) makes a number-word refusal name every refused word. Off: the old text, byte for byte.
// Run: node scripts/test_k303_step1_wording.mjs
import assert from "node:assert/strict";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const nw = await import(R + "number_words.mjs");
const sf = await import(R + "story_forms.mjs");
const sb = await import(R + "storyboard.mjs");
const SWITCH = "NEWSROOM_FIRST_TRY_WORDING";
const TEXT = "钟面四周均匀排着灰点，每点代表当天，共三个";
const legacy = (field, near) => `${field} has a number word (near "${near}"); a number written in words is still a number no row backs. Say it without a number, or let the picture show it`;

for (const off of [undefined, "0", "true", "yes", " 1"]) {
  if (off === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = off;
  ok(nw.firstTryWordingEnabled() === false, `switch off for ${JSON.stringify(off)}`);
  ok(nw.numberWordNames(TEXT) === "", "no extra text when off");
  const got = sf.storyTextBlockers({ alt: TEXT });
  ok(got.length === 1 && got[0] === legacy("alt", nw.numberWordIn(TEXT)), "off: the legacy alt message, byte for byte");
}
// numberWordIn itself never changes
ok(nw.numberWordIn(TEXT) === "钟面四周均匀排着灰点，每点代表当", "numberWordIn snippet unchanged (recorded output of the step-1 wording base)");
ok(nw.numberWordIn("每点代表一天") === null, "numberWordIn: 一天 still passes");
ok(nw.numberWordIn("共三个点") === "共三个点", "numberWordIn: 三个 still refused");
ok(nw.numberWordIn("每点代表 {x} 天") === null, "numberWordIn: a placeholder text passes");

process.env[SWITCH] = "1";
ok(nw.firstTryWordingEnabled() === true, "switch on");
const hits = nw.numberWordHits(TEXT);
ok(JSON.stringify(hits) === JSON.stringify(["四周", "三个"]), `every refused word is named: ${JSON.stringify(hits)}`);
const on = sf.storyTextBlockers({ alt: TEXT });
ok(on.length === 1 && on[0].startsWith(legacy("alt", nw.numberWordIn(TEXT))), "on: the same refusal first");
ok(on[0].includes('"四周"') && on[0].includes('"三个"'), "on: both words named");
// the set of refused texts is unchanged: a clean text is still clean, a dirty one still refused
ok(sf.storyTextBlockers({ alt: "每点代表 {x} 天" }).length === 0, "on: clean text still passes");
ok(nw.numberWordHits("每点代表 {x} 天").length === 0, "on: no hits in a clean text");
ok(nw.numberWordNames("clean text") === "", "on: nothing to name");
// storyboard heading
const board = { schema_version: "1.5.0", language: "zh", modules: [{ id: "p1", type: "panel", panel_no: 1, panel_kind: "lead_in", heading: "四周是三个点", body_module_id: "b1", note_module_id: "n1", story_node_ids: ["s1"] }] };
const head = sb.storyboardBlockers(board, null).filter((b) => b.startsWith("storyboard_title_number_word"));
ok(head.length === 1 && head[0].includes('"四周"') && head[0].includes('"三个"'), "on: heading refusal names both words");
delete process.env[SWITCH];
const head0 = sb.storyboardBlockers(board, null).filter((b) => b.startsWith("storyboard_title_number_word"));
ok(head0.length === 1 && !head0[0].includes("refused word"), "off: heading refusal unchanged");
console.log(`K303 step 1 wording: PASS (${checks} checks)`);
