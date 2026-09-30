import assert from "node:assert/strict";
import { renderVizBundle, wrapText, textUnits } from "../runtime/pi/viz.mjs";
import { composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const title = "欧洲可再生能源发电量在过去五年出现显著增长但不同国家之间的转型速度差异仍然很大";
const lines = wrapText(title, 18);
assert.ok(lines.length >= 3, lines);
assert.equal(lines.join(""), title);

const spec = {
  reader_task: "ranking",
  takeaway: "测试中文移动端标题自动换行",
  chart_type: "horizontal_bar",
  title,
  subtitle: "同一观察年份的国家比较，避免混合年份产生误导。",
  alt: "横向条形图展示三个国家的可再生能源占比。",
  source_note: "离线测试数据",
  note: "仅用于排版回归测试。",
  claim_id: "claim-cjk",
  sql: "SELECT 1",
  unit: "%",
  category_field: "country",
  value_field: "value",
  mixed_period_strategy: "reject",
  sort: "desc",
  highlight_values: ["甲国"],
  direct_labels: true,
  annotations: [],
};
const rows = [
  { country: "甲国", value: 82.1 },
  { country: "乙国", value: 65.4 },
  { country: "丙国", value: 41.3 },
];
const bundle = renderVizBundle(spec, rows);
assert.match(bundle.mobile, /data-viewport="mobile"/);
assert.match(bundle.desktop, /data-viewport="desktop"/);
const mobileTitleLines = (bundle.mobile.match(/font-size="25"/g) || []).length;
assert.ok(mobileTitleLines >= 2, `expected wrapped mobile title, got ${mobileTitleLines} line(s)`);
assert.ok(bundle.mobile.includes("欧洲可再生能源发电量"));
assert.ok(bundle.mobile.includes("转型速度差异仍然很大"));
console.log(`CJK wrapping: PASS (${lines.length} logical lines; ${mobileTitleLines} mobile title nodes)`);

// Every wrapped line must fit the unit budget (a wide/CJK character costs 2
// units, matching render QA's full-em measurement), and re-joining the
// lines must reproduce the input exactly - wrapping only inserts breaks, it
// never drops or reorders characters.
for (const maxChars of [12, 18, 30, 44]) {
  const wrapped = wrapText(title, maxChars);
  for (const line of wrapped) assert.ok(textUnits(line) <= maxChars, `line "${line}" exceeds ${maxChars} units (has ${textUnits(line)})`);
  assert.equal(wrapped.join(""), title, `wrapText(maxChars=${maxChars}) lost or reordered characters`);
}
console.log("CJK unit-budget invariant: PASS");

// Kinsoku shori: a line must never start with a closing bracket/quote or
// sentence punctuation, and never end with the matching opening one.
const commaCase = wrapText("一二三四五六七八九，十", 18);
assert.equal(commaCase.join(""), "一二三四五六七八九，十");
assert.ok(!commaCase.some((line) => line.startsWith("，")), `a line starts with "，": ${JSON.stringify(commaCase)}`);

const quotedCase = wrapText("“你好世界，这是一个测试”的句子非常长需要换行才能显示完整内容", 10);
assert.equal(quotedCase.join(""), "“你好世界，这是一个测试”的句子非常长需要换行才能显示完整内容");
assert.ok(!quotedCase.some((line) => line.startsWith("”") || line.startsWith("，")), `a line starts with a NO_START char: ${JSON.stringify(quotedCase)}`);
assert.ok(!quotedCase.some((line) => line.endsWith("“")), `a line ends with a NO_END char: ${JSON.stringify(quotedCase)}`);

const bracketedCase = wrapText("前面的文本（括号里的内容）后面还有更多的文本需要换行测试", 10);
assert.equal(bracketedCase.join(""), "前面的文本（括号里的内容）后面还有更多的文本需要换行测试");
assert.ok(!bracketedCase.some((line) => line.startsWith("）")), `a line starts with "）": ${JSON.stringify(bracketedCase)}`);
assert.ok(!bracketedCase.some((line) => line.endsWith("（")), `a line ends with "（": ${JSON.stringify(bracketedCase)}`);
console.log("CJK kinsoku (no punctuation orphaned at a line start/end): PASS");

// Latin text must wrap byte-for-byte as the pre-fix algorithm did. Expected
// output computed by running scripts against runtime/pi/viz.mjs at ad6cb72
// (the commit this fix is based on), before any of this fix's edits.
const latinCases = [
  ["The quick brown fox jumps over the lazy dog and keeps running", 20,
    ["The quick brown fox", "jumps over the lazy", "dog and keeps", "running"]],
  ["Supercalifragilisticexpialidocious is a very long single word indeed", 12,
    ["Supercalifra", "gilisticexpi", "alidocious", "is a very", "long single", "word indeed"]],
  ["Reader, meet the data: growth was 3.2% (up from 1.1%) last year.", 18,
    ["Reader, meet the", "data: growth was", "3.2% (up from", "1.1%) last year."]],
];
for (const [text, maxChars, expected] of latinCases) {
  assert.deepEqual(wrapText(text, maxChars), expected, `Latin wrapText(${maxChars}) regressed for "${text}"`);
}
console.log("Latin wrapText regression (byte-identical to ad6cb72): PASS");

// A full zh infographic page (long title/dek, a pull quote and text module
// with punctuation, and Chinese hero_stat labels long enough to exercise
// fitChromeText's ellipsis path) must clear render QA with zero geometry
// failures - this is the end-to-end regression the whole fix is for.
const zhClaim = "claim-cjk-infographic";
const zhInfographicSpec = {
  schema_version: "1.0.0",
  kicker: "系统 / 数据专题",
  title: "当所有部分同处一页时，系统更容易被读懂，也更容易被检验和核实",
  dek: "这个测试用例把已核实的数字、解释性文字和长标题合成一个编辑版面，用来检查中文换行与标点断行规则是否正确工作。",
  alt: "一个中文信息图测试页面，包含标题、副标题、引述、正文与两个关键数字模块，用来检验渲染质量。",
  byline: "测试代理",
  date_label: "测试版",
  layout: "feature",
  complexity_budget: "medium",
  source_note: "离线测试数据",
  modules: [
    { id: "section-1", type: "section_header", span: "full", eyebrow: "前提", heading: "数字因层级而获得意义，也因版面而被读懂", deck: "这段说明用来检验中文标题在窄栏中的自动换行与标点规则。" },
    { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "太焦耳", label: "系统在过去五年中累计输送的能源总量统计数字", detail: "已核实的测试数据", claim_id: zhClaim, label_short: "能源总量" },
    { id: "stat-loss", type: "hero_stat", span: "third", tone: "dark", value: "20", unit: "太焦耳", label: "作为损耗流失的能源占比，约为五分之一强", detail: "占总量的五分之一", claim_id: zhClaim },
    { id: "quote-1", type: "pull_quote", span: "third", label: "为什么重要", text: "系统在到达任何家庭或工厂之前，就已经损失了五分之一的能量（这是一个不小的比例）。", attribution: "测试计算", claim_ids: [zhClaim] },
    { id: "text-1", type: "text", span: "two_thirds", label: "为什么重要", heading: "一个版面，几种阅读速度，先扫读再细读", body: "标题给出论点，大数字奖励扫读，图表支持比较，解释性文字给读者足够的上下文来理解结构，而不让图表脱离已核实的论断，这段文字特意写得足够长以便触发多行换行。", claim_ids: [zhClaim] },
    { id: "text-2", type: "text", span: "half", label: "方法", heading: "数字是如何得出的", body: "行数据来自已核实的计算，编排器从不臆造数值，每个模块都保留其论断绑定关系。", claim_ids: [zhClaim] },
  ],
};

const desktopOnlyBundle = composeInfographicBundle(zhInfographicSpec, {}, { mobilePages: false });
const desktopOnlyQa = runRenderQa({ desktop: desktopOnlyBundle.desktop.svg });
assert.ok(desktopOnlyQa.passed && desktopOnlyQa.failure_count === 0,
  `zh infographic (desktop-only) render QA failed: ${JSON.stringify(desktopOnlyQa.viewports.desktop.geometry.failures.concat(desktopOnlyQa.viewports.desktop.contrast.failures))}`);
console.log("zh infographic desktop-only render QA: PASS (0 failures)");

// A wrapped Chinese title gets 1.2em leading (82px at 68px), not the 72px a
// Latin title uses.
const titleBaselines = [...desktopOnlyBundle.desktop.svg.matchAll(/<text[^>]*\by="([\d.]+)"[^>]*font-size="68"/g)].map((m) => Number(m[1]));
assert.ok(titleBaselines.length >= 2, `expected a wrapped zh title, got ${titleBaselines.length} line(s)`);
assert.equal(titleBaselines[1] - titleBaselines[0], 82, `zh title leading: ${titleBaselines}`);

const bothBundle = composeInfographicBundle(zhInfographicSpec, {}, { mobilePages: true });
const bothQa = runRenderQa({ desktop: bothBundle.desktop.svg, mobile: bothBundle.mobile.svg });
assert.ok(bothQa.passed && bothQa.failure_count === 0,
  `zh infographic (desktop+mobile) render QA failed: ${JSON.stringify({ desktop: bothQa.viewports.desktop.geometry.failures.concat(bothQa.viewports.desktop.contrast.failures), mobile: bothQa.viewports.mobile.geometry.failures.concat(bothQa.viewports.mobile.contrast.failures) })}`);
console.log("zh infographic desktop+mobile render QA: PASS (0 failures)");
