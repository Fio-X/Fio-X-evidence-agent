#!/usr/bin/env node
// K256: the storyboard page-height check, recomputed from real sizes. Off: no storyboard rule runs. On (NEWSROOM_STORYBOARD=1): each panel's room is
// header + its chart's own height at the 1248px page width (at least the ordinary 490) + its note; a chart taller than the hard cap (1100, measured: tallest story chart ~999) is refused.
// This is a recomputation from rendered sizes, not a relaxation. Run: node scripts/test_storyboard_page_height.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const R = fileURLToPath(new URL("../runtime/pi/", import.meta.url));
const mode = process.argv[2] ?? "all";
if (mode === "all") {
  const { spawnSync } = await import("node:child_process");
  for (const m of ["off", "on"]) {
    const env = { ...process.env }; delete env.NEWSROOM_STORYBOARD; if (m === "on") env.NEWSROOM_STORYBOARD = "1";
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m], { env, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    assert.equal(r.status, 0, `${m} half failed`);
  }
  console.log("storyboard page height PASS");
  process.exit(0);
}
const sb = await import(R + "storyboard.mjs");
const { lintInfographicSpec } = await import(R + "infographic.mjs");

const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img"><rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/><text x="20" y="30" font-size="14">t</text><text x="20" y="${h - 8}" font-size="14">source</text></svg>`;
const asset = (w, h) => ({ desktopSvg: svg(w, h), mobileSvg: svg(w, h), manifest: { kind: "chart" } });
const KINDS = ["lead_in", "scale", "space", "basis"];
// bodies: [type, manifest key or null]
const page = (bodies, noteBody = "短注") => {
  const modules = [];
  bodies.forEach(([type, ref], i) => {
    const n = i + 1;
    modules.push({ id: `p${n}`, type: "panel", panel_no: n, panel_kind: KINDS[i], heading: "这一格只说一件事", body_module_id: `b${n}`, note_module_id: `n${n}`, story_node_ids: [`s${n}`], color_use: ["#d0746f"] });
    modules.push(type === "hero_stat"
      ? { id: `b${n}`, type, story_node_ids: [`s${n}`], value: 1, label: "x", claim_id: "c1" }
      : { id: `b${n}`, type, story_node_ids: [`s${n}`], manifest_ref: ref, visual_grammar: "trend", claim_id: "c1" });
    modules.push({ id: `n${n}`, type: "text", story_node_ids: [`s${n}`], body: noteBody, claim_ids: ["c1"] });
  });
  return { schema_version: "1.5.0", language: "zh", color_legend: [{ color: "#d0746f", meaning_id: "synthetic" }], modules };
};
const heightErrors = (spec, assets) => lintInfographicSpec(spec, assets, {}).blockers.filter((b) => /^storyboard_(page_height|panel_chart_height)/.test(b));
// wave 1040x597, state tiles 1248x820, ordinary bar 1040x420
const A = { wave: asset(1040, 597), tiles: asset(1248, 820), bar: asset(1040, 420) };

if (mode === "off") {
  ok(sb.storyboardEnabled() === false, "off: switch off");
  ok(heightErrors(page([["hero_stat"], ["visual", "wave"], ["visual", "tiles"], ["visual", "bar"]]), A).length === 0, "off: the storyboard height rule does not run");
  // the flat cap still works for a caller that gives no native heights (old two-argument form)
  const spec = page([["hero_stat"], ["visual", "wave"], ["visual", "tiles"], ["visual", "bar"]]);
  ok(sb.storyboardBlockers(spec, null, () => 100).every((b) => !b.startsWith("storyboard_page_height")), "flat cap: small modules fit");
  ok(sb.storyboardBlockers(spec, null, () => 600).some((b) => b.startsWith("storyboard_page_height")), "flat cap: tall modules blocked");
  console.log(`storyboard page height (off) PASS checks=${checks}`);
} else {
  ok(sb.storyboardEnabled() === true, "on: switch on");
  // fe's page: big number, wave, state tiles, basis note: passes now
  const fe = page([["hero_stat"], ["visual", "wave"], ["visual", "tiles"], ["visual", "bar"]]);
  ok(heightErrors(fe, A).length === 0, `on: big number + wave + state tiles + basis passes (${heightErrors(fe, A)})`);
  // the old flat cap (560 per panel, 1100 wide) would have refused it: native heights are 752 and 856 at 1248
  const flat = sb.storyboardBlockers(fe, null, (m) => ({ b2: 752, b3: 856 }[m.id] ?? 140));
  ok(flat.some((b) => b.startsWith("storyboard_page_height")), "old flat cap refused the same page");
  // four tall state-tile charts: each is within its own native room, so the page is allowed only because each panel's room is its chart's height
  ok(heightErrors(page([["visual", "tiles"], ["visual", "tiles"], ["visual", "tiles"], ["visual", "tiles"]]), A).length === 0, "on: tall charts get their own native height");
  // an SVG with two charts stacked (1040x1700 -> 2000+ at page width) is refused whatever the other panels leave over
  const stacked = { ...A, two: asset(1040, 1700) };
  const two = heightErrors(page([["hero_stat"], ["visual", "two"], ["visual", "bar"], ["visual", "bar"]]), stacked);
  ok(two.some((b) => b.startsWith("storyboard_panel_chart_height")), `on: two tall charts in one panel refused (${two})`);
  // a super-tall SVG is refused
  const huge = heightErrors(page([["hero_stat"], ["visual", "huge"], ["visual", "bar"], ["visual", "bar"]]), { ...A, huge: asset(1040, 4000) });
  ok(huge.some((b) => b.startsWith("storyboard_panel_chart_height")), "on: an over-tall SVG is refused");
  // a chart with no asset is held to the highest tier (900 room, still counted at its estimated height)
  const noAsset = heightErrors(page([["hero_stat"], ["visual", "missing"], ["visual", "bar"], ["visual", "bar"]]), A);
  ok(noAsset.length === 0, `on: a chart without an asset is held to the highest tier, not refused outright (${noAsset})`);
  // the measured tall charts pass alone in a panel: the state-tile map is 999 px at page width (1248x963 + 36), the day clock 969 (1040x769 -> 1248 wide)
  const tallOk = heightErrors(page([["hero_stat"], ["visual", "tile"], ["visual", "clock"], ["visual", "bar"]]), { ...A, tile: asset(1248, 963), clock: asset(1040, 777) });
  ok(tallOk.length === 0, `on: a 999 px state-tile map and a 969 px clock each pass alone in a panel (${tallOk})`);
  // above the hard cap (1100) is still refused: a 1040x900 chart is about 1116 at page width
  ok(heightErrors(page([["hero_stat"], ["visual", "tall"], ["visual", "bar"], ["visual", "bar"]]), { ...A, tall: asset(1040, 900) }).some((b) => b.startsWith("storyboard_panel_chart_height")), "on: a chart over the hard cap is refused");
  // just under it passes (1040x850 is about 1096)
  ok(heightErrors(page([["hero_stat"], ["visual", "tall"], ["visual", "bar"], ["visual", "bar"]]), { ...A, tall: asset(1040, 850) }).length === 0, "on: a chart just under the hard cap passes");
  // a note has a fixed room (PANEL_NOTE_LINES body lines): charts at their ordinary room (about 490) with very long notes are refused, the same charts with short notes pass
  const bars = [["visual", "ord"], ["visual", "ord"], ["visual", "ord"], ["visual", "ord"]], ordinary = { ord: asset(1040, 380) };
  ok(heightErrors(page(bars), ordinary).length === 0, `on: ordinary charts with short notes pass (${heightErrors(page(bars), ordinary)})`);
  ok(heightErrors(page(bars, "很长的注释。".repeat(120)), ordinary).some((b) => b.startsWith("storyboard_page_height")), "on: very long notes push the 4-panel page over the cap");
  ok(sb.PANEL_NOTE_LINES === 3, "note room is three body lines");
  // the real width is the named constant
  ok(sb.PANEL_CHART_HARD_CAP === 1100 && sb.PANEL_UNKNOWN_CHART_ALLOW === 900 && sb.PANEL_BODY_ALLOW === 490, "constants");
  console.log(`storyboard page height (on) PASS checks=${checks}`);
}
