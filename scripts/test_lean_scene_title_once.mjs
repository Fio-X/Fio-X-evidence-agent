#!/usr/bin/env node
// K258 (e): on a storyboard page the scene graph is derived from the panels and carries no title, eyebrow or dek, so the page prints each panel's title
// once and no extra scene-title line under it. A model-written graph with scene titles (the old path) did print them. Run: node scripts/test_lean_scene_title_once.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const HERE = fileURLToPath(new URL("..", import.meta.url));
process.env.NEWSROOM_STORYBOARD = "1"; process.env.NEWSROOM_LEAN_GATES = "1";
const sb = await import(pathToFileURL(HERE + "runtime/pi/storyboard.mjs").href);
const { composeInfographicBundle } = await import(pathToFileURL(HERE + "runtime/pi/infographic.mjs").href);
const board = JSON.parse(readFileSync(HERE + "fixtures/lean-gates/storyboard-4-panel-plan.json", "utf8"));
const { content_hash: _h, ...spec } = board;
const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img"><rect width="${w}" height="${h}" fill="#fff"/><text x="20" y="30" font-size="14">t</text></svg>`;
const assets = {};
for (const m of spec.modules.filter((x) => x.type === "visual")) assets[m.manifest_ref] = { desktopSvg: svg(1040, 420), mobileSvg: svg(1040, 420), manifest: { kind: "chart" } };
// drawn lines only: the page description (<desc>) quotes the panel titles, that is not a printed line
const count = (s, t) => s.split(`>${t}</text>`).length - 1;
const render = (graph) => composeInfographicBundle({ ...spec, scene_graph: graph }, assets, { mobilePages: false }).desktop;
const text = (r) => (typeof r === "string" ? r : r.svg ?? r.html ?? JSON.stringify(r));

const { scene_graph: modelGraph } = board;
const titles = modelGraph.scenes.map((s) => s.title).filter(Boolean);
ok(titles.length === 2, "fixture's model-written graph carries scene titles");
const derived = sb.withDerivedSceneGraph({ ...spec, scene_graph: undefined }).scene_graph;
ok(derived.scenes.every((s) => !s.title && !s.eyebrow && !s.dek), "derived scenes carry no title, eyebrow or dek");
const panelTitles = spec.modules.filter((m) => m.type === "panel").map((m) => m.heading).filter(Boolean);
const derivedPage = text(render(derived)), modelPage = text(render(modelGraph));
for (const t of panelTitles) ok(count(derivedPage, t) === 1, `derived graph: panel title '${t}' appears once (${count(derivedPage, t)})`);
for (const t of titles) {
  ok(count(derivedPage, t) === 0, `derived graph: no scene-title line '${t}' on the page`);
  ok(count(modelPage, t) >= 1, `control: a model-written scene title '${t}' is drawn`);
}
console.log(`lean scene title once PASS checks=${checks}`);
