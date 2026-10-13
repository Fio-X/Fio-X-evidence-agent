#!/usr/bin/env node
// K261: a storyboard section header's box ends where the ink rhythm puts the next module, so the page critic's module_overlap no longer
// fires on header -> body (3px of box, no ink). Off: box heights unchanged. A real overlap is still a blocker.
// Run: node scripts/test_storyboard_header_box.mjs   (re-runs itself with NEWSROOM_STORYBOARD=1 for the "on" half)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const mode = process.argv[2];
const { composeInfographicBundle, critiqueInfographic } = await import(R + "infographic.mjs");
const mk = (heading, deck) => ({ schema_version: "1.0.0", layout: "feature", language: "zh", title: "T", dek: "副题副题副题", alt: "一张用来测试版面的页面示意图，不含任何数据，只检查模块之间的间距是否合理。", modules: [
  { id: "h1", type: "section_header", span: "full", heading, ...(deck ? { deck } : {}) },
  { id: "a", type: "text", span: "full", heading: "标题", body: "正文正文正文。", priority: 2, claim_ids: ["c1"] },
  { id: "h2", type: "section_header", span: "full", heading, ...(deck ? { deck } : {}) },
  { id: "b", type: "text", span: "full", heading: "标题二", body: "正文。", priority: 2, claim_ids: ["c1"] }] });
const boxesOf = (spec) => composeInfographicBundle(spec, {}, { mobilePages: false }).desktop.boxes;
const overlaps = (spec, bundle) => critiqueInfographic(spec, bundle).issues.filter((i) => i.code === "module_overlap");
const by = (boxes, id) => boxes.find((b) => b.id === id);
if (mode === "off") {
  const boxes = boxesOf(mk("一行标题"));
  ok(by(boxes, "h1").h === 112 && by(boxes, "a").y === by(boxes, "h1").y + 109, "off: a one-line header box is 112 tall and the next module starts 109 below its top (unchanged)");
  const spec = mk("一行标题");
  ok(overlaps(spec, composeInfographicBundle(spec, {}, { mobilePages: false })).length === 2, "off: the 3px box overlap is still reported (behaviour unchanged)");
  console.log(`storyboard header box (off half) PASS checks=${checks}`);
} else if (mode === "on") {
  const one = mk("一行标题"), boxes = boxesOf(one);
  ok(by(boxes, "h1").h === 109 && by(boxes, "a").y === by(boxes, "h1").y + 109, "on: the header box is 109 tall, and the next module sits exactly where it did (ink positions unchanged)");
  ok(overlaps(one, composeInfographicBundle(one, {}, { mobilePages: false })).length === 0, "on: header -> body no longer overlaps");
  const two = mk("一行标题", "副题一行");
  ok(by(boxesOf(two), "h1").h === 141, "on: a header with a deck keeps its height");
  ok(overlaps(two, composeInfographicBundle(two, {}, { mobilePages: false })).length === 0, "on: a header with a deck has no overlap either");
  const long = mk("一个很长的标题".repeat(6));
  const lb = boxesOf(long);
  ok(by(lb, "a").y >= by(lb, "h1").y + by(lb, "h1").h, "on: a three-line header ends at or above the next module");
  // any heading length / count of lines: box bottom <= next box top, no critic overlap, deck-less box never taller than before
  for (const n of [1, 3, 8, 12, 20, 40]) {
    const spec = mk("标题字".repeat(n)), bx = boxesOf(spec), bundle2 = composeInfographicBundle(spec, {}, { mobilePages: false });
    ok(by(bx, "a").y >= by(bx, "h1").y + by(bx, "h1").h && by(bx, "b").y >= by(bx, "h2").y + by(bx, "h2").h, `on: ${n * 3}-char heading box ends at or above the next box`);
    ok(overlaps(spec, bundle2).length === 0, `on: ${n * 3}-char heading has no module_overlap`);
  }
  // strictness: a genuine overlap is still a blocker
  const bundle = composeInfographicBundle(one, {}, { mobilePages: false });
  bundle.desktop.boxes.find((b) => b.id === "a").y -= 20;
  ok(overlaps(one, bundle).some((i) => i.modules.join() === "h1,a"), "on: a real 20px overlap is still a blocker");
  console.log(`storyboard header box (on half) PASS checks=${checks}`);
} else if (mode === "k266") {
  // NEWSROOM_HEADER_BOX_INK=1 gives any page (no storyboard) the same box
  for (const n of [1, 3, 12, 40]) {
    const spec = mk("标题字".repeat(n)), bx = boxesOf(spec), bundle2 = composeInfographicBundle(spec, {}, { mobilePages: false });
    ok(by(bx, "a").y >= by(bx, "h1").y + by(bx, "h1").h, `k266: ${n * 3}-char heading box ends at or above the next box`);
    ok(overlaps(spec, bundle2).length === 0, `k266: ${n * 3}-char heading has no module_overlap`);
  }
  ok(by(boxesOf(mk("一行标题")), "h1").h === 109, "k266: a one-line header box is 109 tall");
  ok(by(boxesOf(mk("一行标题", "副题一行")), "h1").h === 141, "k266: a header with a deck keeps its height");
  console.log(`header box ink (k266) PASS checks=${checks}`);
} else {
  const clean = { ...process.env }; delete clean.NEWSROOM_HEADER_BOX_INK; delete clean.NEWSROOM_STORYBOARD;
  for (const m of ["off", "on", "k266"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m], { stdio: "inherit", env: { ...clean, ...(m === "on" ? { NEWSROOM_STORYBOARD: "1" } : {}), ...(m === "k266" ? { NEWSROOM_HEADER_BOX_INK: "1" } : {}), ...(m === "off" ? { NEWSROOM_STORYBOARD: "0" } : {}) } });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}
