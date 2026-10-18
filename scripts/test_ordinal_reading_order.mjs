#!/usr/bin/env node
// The numbers a desktop page prints on its modules follow the order a reader meets them (rows top to bottom, left to right in a
// row), not the plan array: a scene puts its anchor ahead of its sidecars whatever the array says. Mobile keeps plan order.
// Driver mode runs the checks on the tree and then on mutated runtime copies, each of which must go red.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SELF = fileURLToPath(import.meta.url);

if (process.env.ORDINAL_WORKER === "1") {
  const { assets, sceneSpec, composeInfographicBundle } = await import("./lib_scene_fixture_1060.mjs");
  const RT = process.env.ORDINAL_RUNTIME_DIR ? pathToFileURL(process.env.ORDINAL_RUNTIME_DIR + "/").href : new URL("../runtime/pi/", import.meta.url).href;
  const { readingOrder, editorialOrdinalMap } = await import(RT + "infographic.mjs");

  // 1. readingOrder: the independent guard.
  const box = (id, x, y) => ({ id, module: { id, type: "text" }, x, y, w: 400, h: 200 });
  const ids = (boxes) => readingOrder(boxes).map((b) => b.id);
  assert.deepEqual(ids([box("c", 40, 900), box("a", 40, 100), box("b", 40, 500)]), ["a", "b", "c"], "rows top to bottom");
  assert.deepEqual(ids([box("b", 520, 100), box("a", 40, 100)]), ["a", "b"], "same top: left to right");
  assert.deepEqual(ids([box("b", 520, 100), box("a", 40, 102)]), ["a", "b"], "tops within 4px share a row: left to right, not by 2px of height");
  assert.deepEqual(ids([box("b", 520, 100), box("a", 40, 104)]), ["a", "b"], "exactly 4px apart is still one row");
  assert.deepEqual(ids([box("a", 520, 100), box("b", 40, 105)]), ["a", "b"], "5px apart are two rows: top row first");
  assert.deepEqual(ids([box("c", 40, 400), box("a", 520, 100), box("b", 40, 130)]), ["a", "b", "c"], "rows are cut by distance from the row's first box");
  const input = [box("b", 520, 100), box("a", 40, 100)];
  readingOrder(input);
  assert.deepEqual(input.map((b) => b.id), ["b", "a"], "the input array is not reordered");

  // 2. editorialOrdinalMap: modules that print no number take none; the rest are numbered in reading order.
  const deco = { id: "d", type: "illustration", asset_ref: "ill.json" };
  const decoAssets = { "ill.json": { manifest: { metadata: { decorative: true } } } };
  const mods = [{ id: "a", type: "text" }, { id: "b", type: "text" }, deco, { id: "h", type: "hero_stat" }, { id: "s", type: "section_header" }, { id: "x", type: "visual", emphasis: "hero" }];
  const boxesFor = (order) => order.map((id, i) => ({ id, module: mods.find((m) => m.id === id), x: 40, y: 100 + i * 300, w: 400, h: 200 }));
  const map = editorialOrdinalMap({ modules: mods }, decoAssets, boxesFor(["d", "b", "h", "s", "x", "a"]));
  assert.deepEqual([...map.entries()], [["b", 1], ["a", 2]], "decorative, hero_stat, section_header and hero emphasis take no number; the rest follow reading order");
  assert.deepEqual([...editorialOrdinalMap({ modules: mods }, decoAssets).entries()], [["a", 1], ["b", 2]], "without boxes the plan order is used");

  // 2b. A page whose plan order already is its reading order prints exactly what the plan-order numbering printed before. Pages that
  // were right must not move: the two-column page below reads a, b (row 1), c (row 2); a column-major or leftover-first numbering
  // would renumber it.
  const inOrder = [{ id: "a", type: "text" }, { id: "b", type: "text" }, { id: "c", type: "text" }, deco, { id: "h2", type: "hero_stat" }, { id: "e", type: "text" }];
  const at = { a: [40, 100], b: [520, 100], c: [40, 400], h2: [520, 400], e: [40, 700] };
  const inOrderBoxes = Object.entries(at).map(([id, [x, y]]) => ({ id, module: inOrder.find((m) => m.id === id), x, y, w: 400, h: 200 }));
  const planNumbers = [...editorialOrdinalMap({ modules: inOrder }, decoAssets).entries()];
  assert.deepEqual(planNumbers, [["a", 1], ["b", 2], ["c", 3], ["e", 4]], "fixture: plan-order numbers");
  assert.deepEqual([...editorialOrdinalMap({ modules: inOrder }, decoAssets, inOrderBoxes).entries()], planNumbers, "plan order equal to reading order: numbers identical to the plan-order numbering");
  assert.deepEqual([...editorialOrdinalMap({ modules: inOrder }, decoAssets, inOrderBoxes.filter((b) => b.id !== "e")).entries()], planNumbers, "a module with no box is numbered after the placed ones, which keeps an in-order page unchanged");

  // 3. A real scene page. The flow chart is the hero (no number); plan order is bar, text, but the scene shows the flow and its
  // text sidecar before bar, so the text is the first numbered module a reader meets.
  const kickers = (svg) => {
    const found = [];
    for (const m of svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*letter-spacing="1.5"[^>]*>(\d\d)(?: · ([^<]*))?<\/text>/g)) found.push({ n: m[3], label: m[4] ?? "", x: +m[1], y: +m[2] });
    return found.sort((a, b) => a.y - b.y || a.x - b.x);
  };
  const sceneBundle = composeInfographicBundle(sceneSpec, assets);
  const desktop = kickers(sceneBundle.desktop.svg);
  assert.deepEqual(desktop.map((k) => k.n), ["01", "02"], `desktop numbers read 01, 02 down the page: ${JSON.stringify(desktop)}`);
  assert.equal(desktop[0].label, "WHY IT MATTERS", "the text sidecar, met first, is 01");
  const numbered = ["bar", "text"];
  assert.deepEqual(readingOrder(sceneBundle.desktop.boxes.filter((b) => numbered.includes(b.id))).map((b) => b.id), ["text", "bar"], "fixture: the reader meets text before bar");
  assert.deepEqual(sceneSpec.modules.filter((m) => numbered.includes(m.id)).map((m) => m.id), ["bar", "text"], "fixture: the plan order is bar, text");
  // Mobile keeps plan-order numbers, whatever the mobile reading order is.
  const swapped = { ...sceneSpec, mobile_module_order: sceneSpec.mobile_module_order.map((id) => (id === "bar" ? "text" : id === "text" ? "bar" : id)) };
  const mobile = kickers(composeInfographicBundle(swapped, assets).mobile.svg);
  assert.deepEqual(mobile.map((k) => k.label), ["WHY IT MATTERS", ""], "fixture: mobile shows text before bar");
  assert.deepEqual(mobile.map((k) => k.n), ["02", "01"], `mobile keeps plan-order numbers (bar 01, text 02): ${JSON.stringify(mobile)}`);
  console.log("ordinal reading order: PASS");
  process.exit(0);
}

const run = (runtimeDir) => spawnSync(process.execPath, [SELF], { env: { ...process.env, ORDINAL_WORKER: "1", ...(runtimeDir ? { ORDINAL_RUNTIME_DIR: runtimeDir } : {}) }, encoding: "utf8" });
const base = run(null);
assert.equal(base.status, 0, `tree run must pass:\n${base.stdout}\n${base.stderr}`);
process.stdout.write(base.stdout);

const mutants = [
  ["numbers follow the plan array again", "  if (boxes) {\n    const placed", "  if (false) {\n    const placed"],
  ["same-row boxes are not sorted left to right", "return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));", "return rows.flat();"],
  ["row tolerance 0", "const ROW_TOLERANCE_PX = 4;", "const ROW_TOLERANCE_PX = 0;"],
  ["row tolerance too wide", "const ROW_TOLERANCE_PX = 4;", "const ROW_TOLERANCE_PX = 400;"],
  ["rows are no longer sorted top to bottom first", "[...boxes].sort((a, b) => a.y - b.y || a.x - b.x)", "[...boxes]"],
  ["the decorative skip is dropped", "if (printsOrdinal(module, isDecorative) && !map.has", "if (printsOrdinal(module, () => false) && !map.has"],
  ["the skip rule keeps hero_stat numbered", 'module.type === "hero_stat" || module.emphasis === "hero" || isDecorative(module));', 'module.emphasis === "hero" || isDecorative(module));'],
  ["mobile uses the boxes too", "editorialOrdinalMap(spec, assets, mobile ? null : layout.boxes)", "editorialOrdinalMap(spec, assets, layout.boxes)"],
  ["modules without a box are numbered before the placed ones", "ordered = [...placed, ...modules.filter((m) => !placedIds.has(String(m.id)))];", "ordered = [...modules.filter((m) => !placedIds.has(String(m.id))), ...placed];"],
  ["reading order goes column by column", "[...boxes].sort((a, b) => a.y - b.y || a.x - b.x)", "[...boxes].sort((a, b) => a.x - b.x || a.y - b.y)"],
  ["readingOrder sorts the caller's array in place", "for (const box of [...boxes].sort(", "for (const box of boxes.sort("],
];
const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ordinal-mut-"));
try {
  for (const [name, from, to] of mutants) {
    const dir = path.join(tmp, "m");
    rmSync(dir, { recursive: true, force: true });
    cpSync(path.join(root, "runtime"), path.join(dir, "runtime"), { recursive: true });
    cpSync(path.join(root, "config"), path.join(dir, "config"), { recursive: true });
    const file = path.join(dir, "runtime/pi/infographic.mjs");
    const text = readFileSync(file, "utf8");
    assert.equal(text.split(from).length - 1, 1, `mutant anchor must be unique: ${name}`);
    writeFileSync(file, text.replace(from, () => to));
    const r = run(path.join(dir, "runtime/pi"));
    assert.notEqual(r.status, 0, `mutant must turn the test red: ${name}`);
    console.log(`mutant red: ${name}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`ordinal reading order: PASS (${mutants.length} mutants red)`);
