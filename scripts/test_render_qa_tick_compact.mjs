// #222: with NEWSROOM_QA_TICK_READBACK=1 the compact (8-column) chart picture gets the same tick / value-label read-back as the desktop one.
// renderVizCompactSvg draws through the same renderVizSvg at a narrower layout width, so it writes the same read-back attributes; the phone
// picture comes from another renderer and stays without the read-back. Off (default), nothing changes. Pictures are drawn live by the repo's
// own renderer with the switch on; every edit is made on a copy of the text.
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "pi");
const SWITCH = "NEWSROOM_QA_TICK_READBACK";
const old = process.env[SWITCH];
process.env[SWITCH] = "1";
const viz = await import(join(root, "viz.mjs"));

const base = { schema_version: "0.9.0", reader_task: "comparison", takeaway: "T.", alt: "图。", source_note: "fixture", claim_id: "c1", sql: "SELECT 1", unit: "人", language: "zh", highlight_values: [], annotations: [] };
const spec = { ...base, title: "各城市人口", subtitle: "万人", chart_type: "horizontal_bar", category_field: "city", value_field: "pop" };
const small = [["上海", 24870003], ["北京", 21890003], ["深圳", 17680003], ["广州", 18730003], ["拉萨", 705803]].map(([city, pop]) => ({ city, pop }));
const big = Array.from({ length: 8 }, (_, i) => ({ city: `城市${i + 1}`, pop: (9 - i) * 31000000 + 7 }));
const ctxFor = (rows) => ({ chart_type: spec.chart_type, rows, category_field: spec.category_field, value_field: spec.value_field, unit: spec.unit, language: spec.language });

function pictures(rows) {
  return { desktop: viz.renderVizSvg(spec, rows), compact: viz.renderVizCompactSvg(spec, rows), mobile: viz.renderVizMobileSvg(spec, rows) };
}
const edit = (svg, find, replace) => { assert.ok(svg.includes(find), `edit target not found: ${find}`); return svg.replace(find, () => replace); };
const firstTick = (svg) => /<text [^>]*data-role="axis-tick-label"[^>]*>[^<]*<\/text>/.exec(svg)[0];

// the edits, each changing one field of the compact picture
const edits = {
  "tick text": (svg) => { const m = [...svg.matchAll(/(<text [^>]*data-role="axis-tick-label"[^>]*>)([^<]*)(<\/text>)/g)][1]; return edit(svg, m[0], `${m[1]}999${m[3]}`); },
  "tick position": (svg) => { const t = [...svg.matchAll(/<text [^>]*data-role="axis-tick-label"[^>]*>/g)][1][0]; const x = /\bx="([\d.]+)"/.exec(t)[1]; return edit(svg, t, t.replace(`x="${x}"`, `x="${Number(x) + 6}"`)); },
  "bar value": (svg) => { const m = /data-role="data-bar"[^>]*data-value="(\d+)"/.exec(svg); return edit(svg, m[0], m[0].replace(`data-value="${m[1]}"`, `data-value="${Number(m[1]) * 3}"`)); },
  "value label": (svg) => { const m = /(<text [^>]*data-role="value-label"[^>]*>)([^<]*)(<\/text>)/.exec(svg); return edit(svg, m[0], `${m[1]}9${m[2].slice(1)}${m[3]}`); },
};

async function suite(runRenderQa, label) {
  const out = [];
  const fails = [];
  for (const [name, rows] of [["5 rows", small], ["8 rows", big]]) {
    const p = pictures(rows);
    const ctx = ctxFor(rows);
    const run = (pics) => runRenderQa(pics, { tick_readback: ctx });
    // good pictures: no failure on any viewport, the compact one is read back and passes
    const ok = run({ desktop: p.desktop, compact: p.compact });
    // the phone picture is drawn by another renderer: it never gets the read-back, whatever else it reports
    const withPhone = run({ desktop: p.desktop, compact: p.compact, mobile: p.mobile });
    if (withPhone.viewports.mobile.tick_readback !== undefined) fails.push(`${label} ${name}: the phone picture must stay without tick_readback`);
    if (ok.passed !== true) fails.push(`${label} ${name}: good desktop and compact pictures must pass`);
    if (ok.viewports.compact.tick_readback?.passed !== true) fails.push(`${label} ${name}: compact must carry a passing tick_readback`);
    if (ok.viewports.desktop.tick_readback?.passed !== true) fails.push(`${label} ${name}: desktop must carry a passing tick_readback`);
    // one field of the compact picture changed -> red, and the failure is on the compact viewport only
    for (const [field, fn] of Object.entries(edits)) {
      const r = run({ desktop: p.desktop, compact: fn(p.compact) });
      const f = r.viewports.compact.tick_readback?.failures ?? [];
      if (r.passed !== false || f.length === 0) fails.push(`${label} ${name}: compact ${field} changed must turn the report red`);
      if ((r.viewports.desktop.tick_readback?.failures ?? []).length !== 0) fails.push(`${label} ${name}: ${field}: desktop must stay green`);
    }
    out.push(name);
  }
  return fails;
}

async function load(file) {
  return (await import(`${join(root, file)}?${Date.now()}${Math.random()}`)).runRenderQa;
}

// mutants: temporary copies next to the real files, each of which must turn at least one case red; removed in finally
const tmp = [];
function mutant(name, { qa, ticks }) {
  let src = readFileSync(join(root, "render_qa.mjs"), "utf8");
  const qaFile = `render_qa_mut_${name}.mjs`;
  let ticksName = "render_qa_ticks.mjs";
  if (ticks) {
    ticksName = `render_qa_ticks_mut_${name}.mjs`;
    writeFileSync(join(root, ticksName), ticks(readFileSync(join(root, "render_qa_ticks.mjs"), "utf8")));
    tmp.push(ticksName);
    src = src.replace("./render_qa_ticks.mjs", `./${ticksName}`);
  }
  if (qa) src = qa(src);
  writeFileSync(join(root, qaFile), src);
  tmp.push(qaFile);
  return qaFile;
}
const swap = (s, a, b) => { assert.ok(s.includes(a), `mutant target not found: ${a}`); return s.replace(a, () => b); };
const COMPACT_LINE = "viewports.compact = checkViewport(compact, compactOptions);";

try {
  const real = await load("render_qa.mjs");
  const bad = await suite(real, "real");
  assert.deepEqual(bad, [], bad.join("\n"));

  // switch off or anything but the exact "1": the compact report is as before (no tick_readback on any viewport)
  const p = pictures(small);
  for (const value of [undefined, "0", "", "yes", " 1", "true"]) {
    if (value === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = value;
    const r = real({ desktop: p.desktop, compact: edits["tick text"](p.compact), mobile: p.mobile }, { tick_readback: ctxFor(small) });
    for (const v of ["desktop", "compact", "mobile"]) assert.equal(r.viewports[v].tick_readback, undefined, `switch ${JSON.stringify(value)}: ${v} must have no tick_readback`);
  }
  process.env[SWITCH] = "1";

  // the heatmap proof stays desktop-only: a heatmap option reaches neither the compact nor the phone viewport
  const heat = { heatmap: { rows: [], spec: {}, x_field: "x", y_field: "y", value_field: "v" } };
  const rh = real({ desktop: p.desktop, compact: p.compact, mobile: p.mobile }, { ...heat, tick_readback: ctxFor(small) });
  assert.equal(rh.viewports.compact.value_labels, undefined, "compact must not get the heatmap label proof");

  // a changed compact picture is red through a real page-level call too: the story/page path passes {desktop, compact} with chartRenderQaOptions
  // (runtime/pi/newsroom.ts: the visualization tool and the split critic), so the options carry tick_readback exactly as in this suite.

  const mutants = {
    "compact-dropped": mutant("a", { qa: (s) => swap(s, COMPACT_LINE, "viewports.compact = checkViewport(compact, (({ tick_readback: _t, ...o }) => o)(compactOptions));") }),
    "old-line": mutant("b", { qa: (s) => swap(s, COMPACT_LINE, "viewports.compact = checkViewport(compact, otherOptions);") }),
    "phone-reads-back": mutant("c", { qa: (s) => swap(s, "if (mobile !== undefined) viewports.mobile = checkViewport(mobile, otherOptions);", "if (mobile !== undefined) viewports.mobile = checkViewport(mobile, options);") }),
    "tolerance-wide": mutant("d", { ticks: (s) => swap(s, "export const TICK_POSITION_TOLERANCE = 1.0;", "export const TICK_POSITION_TOLERANCE = 50;") }),
  };
  for (const [name, file] of Object.entries(mutants)) {
    const failures = await suite(await load(file), `mutant ${name}`);
    assert.ok(failures.length > 0, `mutant must turn a case red: ${name}`);
  }
  console.log(`ok test_render_qa_tick_compact: 2 chart sizes x (good, ${Object.keys(edits).length} edits), switch matrix, heatmap stays desktop-only, ${Object.keys(mutants).length} mutants red`);
} finally {
  for (const f of tmp) rmSync(join(root, f), { force: true });
  if (old === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = old;
}
