// K257: NEWSROOM_NUMWORD_CONTEXT=1 (exact "1", default off) lets a few words through by their position. Each state runs in its own process.
// Off: every example is refused exactly as before. On: the listed ones pass and every true number word is still refused.
// Run: node scripts/test_numword_context.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const mode = process.argv[2] ?? "all";
if (mode === "all") {
  for (const value of [undefined, "0", "true", "1"]) {
    const env = { ...process.env }; delete env.NEWSROOM_NUMWORD_CONTEXT;
    if (value !== undefined) env.NEWSROOM_NUMWORD_CONTEXT = value;
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), value === "1" ? "on" : "off"], { env, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr.split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n"));
    assert.equal(r.status, 0, `NEWSROOM_NUMWORD_CONTEXT=${value} failed`);
  }
  console.log("numword context PASS");
  process.exit(0);
}
const on = mode === "on";
const w = await import("../runtime/pi/number_words.mjs");
let n = 0;
const refused = (t) => w.numberWordIn(t) !== null;
const refuse = (t) => { assert.ok(refused(t), `should refuse: ${t}`); n++; };
const pass = (t) => { assert.ok(!refused(t), `should pass: ${t}`); n++; };
assert.equal(w.numwordContextEnabled(), on); n++;

// 四周 as "all around": passes only with the switch on
for (const t of ["四周环海", "向四周扩散", "四周都是山", "围绕四周布置", "朝四周辐射"]) (on ? pass : refuse)(t);
// time uses and every other number word: refused with the switch on or off
for (const t of ["过去四周增长了", "持续四周", "四周内完成", "前四周的数据", "三周", "四个月", "九周后", "连续四周下降", "二十周", "两周内", "共有十个国家", "三成的产量", "一半的地区", "排名第二大", "两倍", "百分之十"]) refuse(t);
// a form's one-line reason (numberWordInReason): a count of one or two chart parts passes only with the switch on
const reasonRefused = (t) => w.numberWordInReason(t) !== null;
for (const t of ["两条线对比走势", "两个点连成线", "一条线看趋势", "一根柱子", "一个点代表一个州", "用两个点和一条线"]) { assert.equal(reasonRefused(t), !on && w.numberWordIn(t) !== null, `reason: ${t}`); n++; }
assert.ok(reasonRefused("两条线对比走势") === !on); n++;
for (const t of ["三条线", "十一个点", "二十一个点", "两个国家", "三个点", "十个州", "四根柱", "一半", "两倍", "百分之十", "第二大", "共有十个国家"]) { assert.ok(reasonRefused(t), `reason still refused: ${t}`); n++; }
// numberWordIn itself does not change with the switch
assert.ok(refused("两条线") && refused("两个点")); n++;
// the form-selection check uses the reason function
const fsel = await import("../runtime/pi/form_selection.mjs");
const cands = (reason) => [{ class: "comparison", form: "horizontal_bar", one_line_reason: reason }, { class: "big_number", form: "hero_stat", one_line_reason: "只有一个数时最直接" }, { class: "table", form: "table", one_line_reason: "要查精确值时用" }];
const reasonErr = (reason) => fsel.formSelectionBlockers({ chart_type: "horizontal_bar", candidates: cands(reason), chosen: "horizontal_bar", rejected_by_rule: [] }).some((m) => /one_line_reason must not carry/.test(m));
assert.equal(reasonErr("两条线对比走势"), !on); n++;
assert.equal(reasonErr("三条线对比走势"), true); n++;
assert.equal(reasonErr("共有十个国家"), true); n++;
assert.equal(reasonErr("排序后一眼看出高低"), false); n++;
assert.equal(reasonErr("两条线, 2 个点"), true); n++;
// off: the returned snippets are what 6331003 returned (pinned), so the switch off changes no byte
if (!on) for (const [t, snip] of [["四周环海", "四周环海"], ["向四周扩散", "向四周扩散"], ["他们四周都是山", "他们四周都是山"], ["持续四周", "持续四周"], ["共有十个国家，占{max.x}", "共有十个国家，占{...}"], ["no words here", null]]) { assert.equal(w.numberWordIn(t), snip, t); n++; }
console.log(`numword context (${on ? "on" : "off"}) PASS checks=${n}`);
