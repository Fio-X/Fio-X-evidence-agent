// K257: alt is the title plus the claim, so a number word in the title was reported twice (title and alt). Now it is reported once, as title; a number
// word in the claim part or in a free-text alt is still refused. No switch: nothing is let through, the same word is just not reported twice.
import assert from "node:assert/strict";
import { storyTextBlockers } from "../runtime/pi/story_forms.mjs";
let n = 0;
const fields = (spec) => storyTextBlockers(spec).map((b) => b.split(" has")[0]);
const spec = (title, claim) => ({ title, alt: `${title}${/[.!?。！？]$/u.test(title) ? "" : "."} ${claim}` });
const CLEAN = "美国 2020 年为 35 万人。";
// a word in the title: title only, once
for (const t of ["三成家庭受影响", "两条线分开了", "共有十个国家", "排名第二大", "增长了一半"]) { assert.deepEqual(fields(spec(t, CLEAN)), ["title"], t); n++; }
// a clean title: a number word in the claim part is still refused, as alt
for (const c of ["三成家庭受影响。", "排名第二大。", "增长了一半。", "增长两倍。", "占百分之十。", "共有十个国家。", "有一半以上。", "四根柱高于平均。"]) { assert.deepEqual(fields(spec("出口增长", c)), ["alt"], c); n++; }
// a free-text alt (does not start with the title) is checked whole
assert.deepEqual(fields({ title: "出口增长", alt: "一张图，三成家庭受影响，数据来自表格。" }), ["alt"]); n++;
// nothing to report
assert.deepEqual(fields(spec("出口增长", CLEAN)), []); n++;
// subtitle and source_note unchanged
assert.deepEqual(fields({ title: "出口增长", subtitle: "共有十个国家", alt: "出口增长. " + CLEAN }), ["subtitle"]); n++;
assert.deepEqual(fields({ title: "出口增长", source_note: "三成样本", alt: "出口增长. " + CLEAN }), ["source_note"]); n++;
console.log(`ok test_numword_alt_dedup (${n} checks)`);
