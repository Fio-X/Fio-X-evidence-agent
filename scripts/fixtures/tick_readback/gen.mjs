// Regenerates the tick/value-label read-back fixtures in this folder: renders a bar chart and a
// mirrored bar chart with the repo's own renderer (runtime/pi/viz.mjs), then adds the data attributes
// the NEWSROOM_QA_TICK_READBACK convention asks for (see k198 report). The fixtures are test inputs,
// not product output. Run: node scripts/fixtures/tick_readback/gen.mjs
import { renderVizSvg } from "../../../runtime/pi/viz.mjs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = { schema_version: "0.9.0", reader_task: "comparison", takeaway: "T.", alt: "图。", source_note: "fixture", claim_id: "c1", sql: "SELECT 1", unit: "人", language: "zh", highlight_values: [], annotations: [] };
const hbSpec = { ...base, title: "各城市人口", subtitle: "万人", chart_type: "horizontal_bar", category_field: "city", value_field: "pop" };
const mbSpec = { ...base, title: "各年龄段人口", subtitle: "万人", chart_type: "mirrored_bar", category_field: "band", series_field: "side", value_field: "pop" };
const hbRows = [["上海", 24870003], ["北京", 21890003], ["深圳", 17680003], ["广州", 18730003], ["拉萨", 705803]].map(([city, pop]) => ({ city, pop }));
const hbRowsBig = [["上海", 188700003], ["北京", 121890003], ["深圳", 97680003], ["广州", 138730003], ["成都", 60940003]].map(([city, pop]) => ({ city, pop }));
const bands = ["0-14", "15-39", "40-64", "65+"];
const mbRows = [];
bands.forEach((b, i) => { mbRows.push({ band: b, side: "男", pop: (1200 + i * 310) * 10000 + 5 }); mbRows.push({ band: b, side: "女", pop: (1100 + i * 280) * 10000 + 7 }); });

const SUFFIX = { "万亿": 1e12, "亿": 1e8, "万": 1e4 };
function tickNumber(text) {
  const m = /^(\d+(?:\.\d+)?)(万亿|亿|万)?/.exec(text);
  return Number(m[1]) * (m[2] ? SUFFIX[m[2]] : 1);
}
const decode = (s) => s.replace(/<[^>]*>/g, "");
const bareNumber = (text) => /^[\d.,]+/.exec(text)[0].replace(/(万亿|亿|万).*$/, "");
const stripSuffix = (text) => text.replace(/(万亿|亿|万)/, "").replace(/\s+人$/, "");
const UNIT = '<text data-role="axis-unit-line" data-scale="SCALE" x="54" y="92" text-anchor="start" font-size="12" font-weight="400" fill="#666666">单位：万人</text>';

// writing: "A" suffix on every tick and label; "B" bare ticks + unit line, labels keep suffix; "K202" bare ticks and bare labels
function annotateHorizontal(svg, rows, writing) {
  const names = rows.map((r) => r.city);
  let barIdx = 0;
  let labelIdx = 0;
  let out = svg.replace(/<text ([^>]*?)text-anchor="middle"([^>]*)>([^<]*)<\/text>/g, (all, a, b, text) => {
    const v = tickNumber(text);
    const shown = writing === "A" ? text : stripSuffix(text);
    return `<text data-role="axis-tick-label" data-tick-value="${v}" ${a}text-anchor="middle"${b}>${shown}</text>`;
  });
  out = out.replace(/<rect data-role="data-bar" /g, () => {
    const r = rows[barIdx++];
    return `<rect data-role="data-bar" data-category="${r.city}" data-value="${r.pop}" `;
  });
  out = out.replace(/<text ([^>]*?)text-anchor="start"([^>]*?font-weight="600"[^>]*)>([^<]*)<\/text>/g, (all, a, b, text) => {
    const r = rows[labelIdx++];
    const shown = writing === "K202" ? stripSuffix(text) : text;
    return `<text data-role="value-label" data-category="${r.city}" data-value="${r.pop}" ${a}text-anchor="start"${b}>${shown}</text>`;
  });
  if (barIdx !== names.length || labelIdx !== names.length) throw new Error(`horizontal annotate: ${barIdx} bars ${labelIdx} labels for ${names.length} rows`);
  if (writing !== "A") out = out.replace(/(<text data-role="axis-tick-label")/, `${UNIT.replace("SCALE", "10000")}$1`);
  return out;
}

function annotateMirrored(svg, rows, writing) {
  let barIdx = 0;
  let out = svg.replace(/<rect data-role="data-bar" ([^>]*?)\/>/g, (all, rest) => {
    const r = rows[barIdx++];
    return `<rect data-role="data-bar" data-category="${r.band}" data-series="${r.side}" data-value="${r.pop}" data-side="${r.side === "男" ? "left" : "right"}" ${rest}/>`;
  });
  out = out.replace(/<text data-role="axis-tick-label" x="([\d.]+)" ([^>]*)>([^<]*)<\/text>/g, (all, x, rest, text) => {
    const shown = writing === "A" ? text : stripSuffix(text);
    return `<text data-role="axis-tick-label" data-tick-value="${tickNumber(text)}" data-side="${Number(x) < 520 ? "left" : "right"}" x="${x}" ${rest}>${shown}</text>`;
  });
  if (barIdx !== rows.length) throw new Error(`mirrored annotate: ${barIdx} bars for ${rows.length} rows`);
  if (writing !== "A") out = out.replace(/(<text data-role="axis-tick-label")/, `${UNIT.replace("SCALE", "10000")}$1`);
  return out;
}

const fixtures = {};
function add(name, svg, spec, rows) {
  writeFileSync(join(here, `${name}.svg`), svg);
  fixtures[name] = { file: `${name}.svg`, chart_type: spec.chart_type, category_field: spec.category_field, value_field: spec.value_field, ...(spec.series_field ? { series_field: spec.series_field } : {}), rows };
}
const hb = renderVizSvg(hbSpec, hbRows);
add("hb_A", annotateHorizontal(hb, hbRows, "A"), hbSpec, hbRows);
add("hb_B", annotateHorizontal(hb, hbRows, "B"), hbSpec, hbRows);
add("hb_K202", annotateHorizontal(hb, hbRows, "K202"), hbSpec, hbRows);
// the old, mixed writing the renderer produces today (ticks 5000万 and 1亿 on one axis), no unit line
add("hb_OFF", annotateHorizontal(renderVizSvg(hbSpec, hbRowsBig), hbRowsBig, "A"), hbSpec, hbRowsBig);
const mb = renderVizSvg(mbSpec, mbRows);
add("mb_A", annotateMirrored(mb, mbRows, "A"), mbSpec, mbRows);
add("mb_B", annotateMirrored(mb, mbRows, "B"), mbSpec, mbRows);
writeFileSync(join(here, "fixtures.json"), JSON.stringify(fixtures, null, 1) + "\n");
console.log(Object.keys(fixtures).join(" "));
