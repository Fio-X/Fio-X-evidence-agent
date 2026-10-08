#!/usr/bin/env node
// NEWSROOM_SANKEY_OTHER_NOTE=1 (default off): the merged "other" node gets its own label when a data node in its column
// already has it, the footer names the merged nodes (names only), a target-only highlight marks that target's largest
// incoming flow, and the render result lists the merged nodes. Off, the SVG is byte-identical.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { lintVizSpec, renderVizBundle, sankeyMergeSummary } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const spec = (extra = {}) => ({ schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "煤是最大的化石排放来源", chart_type: "sankey", title: "碳的来源与去向", subtitle: "单位：十亿吨碳", alt: "桑基图显示各来源的流向。", source_note: "测试数据", claim_id: "claim-n", sql: "SELECT 1", unit: "GtC", language: "zh", source_field: "source", target_field: "target", value_field: "value", flow_conservation: "none", highlight_values: [], annotations: [], ...extra });
const rowsOf = (list) => list.map(([source, target, value]) => ({ source, target, value }));
const render = (sp, rows, mobile = false) => { const b = renderVizBundle(sp, rows, { mobilePages: mobile }); return mobile ? b.mobile : b.desktop; };
const qa = (svg) => { const v = runRenderQa({ desktop: svg }).viewports.desktop; return [...(v.geometry?.failures ?? []), ...(v.contrast?.failures ?? [])].map((f) => f.rule); };
const withSwitch = (value, fn) => { const old = process.env.NEWSROOM_SANKEY_OTHER_NOTE; if (value === undefined) delete process.env.NEWSROOM_SANKEY_OTHER_NOTE; else process.env.NEWSROOM_SANKEY_OTHER_NOTE = value; try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_SANKEY_OTHER_NOTE; else process.env.NEWSROOM_SANKEY_OTHER_NOTE = old; } };

// Left column: three small sources merge; one real "其他" data node stays big enough to stay unmerged.
const clash = rowsOf([["煤", "化石", 40], ["石油", "化石", 30], ["其他", "化石", 20], ["小甲", "化石", 1], ["小乙", "化石", 1], ["化石", "大气", 50], ["化石", "海洋", 42]]);
// no merge: every node is big
const plain = rowsOf([["煤", "化石", 40], ["石油", "化石", 30], ["化石", "大气", 40], ["化石", "海洋", 30]]);
// merge with no data node called 其他
const merged = rowsOf([["煤", "化石", 40], ["石油", "化石", 30], ["水泥生产", "化石", 1], ["火炬燃烧", "化石", 1], ["化石", "大气", 40], ["化石", "海洋", 32]]);

// off: byte-identical (the switch unset and any non-"1" value render the same SVG)
const baseline = withSwitch(undefined, () => render(spec(), merged));
for (const v of ["0", "true", ""]) assert.equal(withSwitch(v, () => render(spec(), merged)), baseline, `switch ${JSON.stringify(v)} is off`);
assert.ok(!baseline.includes("水泥生产、火炬燃烧"), "off: no footnote");

// on: footnote only when a merge happened
const on = withSwitch("1", () => render(spec(), merged));
assert.match(on, /其他（左列）：水泥生产、火炬燃烧/);
assert.deepEqual(qa(on), [], "footnote passes render QA");
assert.equal(withSwitch("1", () => render(spec(), plain)), withSwitch(undefined, () => render(spec(), plain)), "no merge: byte-identical with the switch on");
const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(on);
const offH = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(baseline)[1]);
assert.ok(Number(viewBox[2]) >= offH, "height never shrinks");
for (const m of on.matchAll(/<text[^>]* y="([\d.]+)"/g)) assert.ok(Number(m[1]) <= Number(viewBox[2]), "text inside the viewBox");
// numbers: the footnote line holds names only
const noteLine = /<text[^>]*>[^<]*其他（左列）：[^<]*<\/text>/.exec(on)[0];
assert.ok(!/\d/.test(noteLine.replace(/<[^>]*>/g, "")), "names only, no digits");
// mobile page also grows for the note
const onMobile = withSwitch("1", () => render(spec(), merged, true));
assert.match(onMobile, /其他（左列）/);

// clash: a data node called 其他 stays a node of its own, so the merged node is named apart
const clashOn = withSwitch("1", () => render(spec(), clash));
const labels = [...clashOn.matchAll(/data-role="flow-node-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
assert.equal(labels.filter((l) => l === "其他").length, 1, "one node called 其他");
assert.ok(labels.includes("其他（合并）"), `merged node is 其他（合并）: ${labels}`);
assert.match(clashOn, /其他（合并，左列）：小[甲乙]、小[甲乙]/);
assert.deepEqual(qa(clashOn), []);
const clashOff = withSwitch(undefined, () => render(spec(), clash));
assert.ok(!clashOff.includes("其他（合并）"), "off: unchanged label");
// English
const en = withSwitch("1", () => render(spec({ language: "en", title: "Carbon sources", subtitle: "GtC" }), rowsOf(clash.map((r) => [r.source === "其他" ? "Other" : r.source === "小甲" ? "Tiny A" : r.source === "小乙" ? "Tiny B" : r.source === "煤" ? "Coal" : r.source === "石油" ? "Oil" : r.source === "化石" ? "Fossil" : r.source, r.target === "化石" ? "Fossil" : r.target === "大气" ? "Air" : r.target === "海洋" ? "Sea" : r.target, r.value]))));
assert.match(en, />Other \(combin[^<]*</, "merged node label (long labels are cut by the node label budget)");
assert.match(en, /Other \(combined, left column\): Tiny [AB], Tiny [AB]/);

// target-only highlight = the target's largest incoming flow; both ends and source-only keep their rules
const hi = (values, on = true) => { const svg = withSwitch(on ? "1" : undefined, () => render(spec({ highlight_values: values }), plain)); return [...svg.matchAll(/data-role="flow-link" data-flow-key="([^"]*)"[^>]* stroke="#D0021B"/gi)].map((m) => m[1]); };
assert.deepEqual(hi(["大气"]), ["化石→大气"], "target only: its largest incoming flow");
assert.deepEqual(hi(["大气"], false), [], "off: target-only highlights nothing");
assert.deepEqual(hi(["煤"]), ["煤→化石"], "source only: largest outgoing");
assert.deepEqual(hi(["化石", "海洋"]), ["化石→海洋"], "both ends: that flow");
assert.deepEqual(hi(["化石", "海洋"], false), ["化石→海洋"], "both ends: same with the switch off");

// summary the render result prints
const summary = withSwitch("1", () => sankeyMergeSummary(spec(), merged));
assert.deepEqual(summary.map((m) => [m.label, m.column, m.members]), [["其他", "左列", ["水泥生产", "火炬燃烧"]]]);
assert.deepEqual(withSwitch("1", () => sankeyMergeSummary(spec(), plain)), []);

// the real table
const csv = "/Users/fio/code/PJ004-local-docs/demo-1008/data-flows/flow_tables/gcb_2023_flows.csv";
if (existsSync(csv)) {
  const gcb = readFileSync(csv, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).map(([source, target, value]) => ({ source, target, value: Number(value) }));
  const off = withSwitch(undefined, () => render(spec(), gcb)), onG = withSwitch("1", () => render(spec(), gcb));
  assert.deepEqual(qa(off), [], "GCB off: render QA");
  assert.deepEqual(qa(onG), [], "GCB on: render QA");
  assert.match(onG, /注：其他（左列）：[^<]*水泥生产[^<]*火炬燃烧[^<]*其他/, "GCB: the footnote names every merged node, the data node 其他 included");
}
console.log("PASS sankey other note");
