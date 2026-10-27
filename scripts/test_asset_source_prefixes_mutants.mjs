#!/usr/bin/env node
// Mutations of the asset source path table in runtime/pi/art_direction.mjs (see test_asset_source_prefixes.mjs). Each mutated copy is written alone to a scratch
// folder (art_direction.mjs imports only node:crypto) and the test run against it must go red with the expected text. Nothing in the repository is edited.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, "runtime/pi/art_direction.mjs"), "utf8");
const scratch = makeTestTmp("asset-source-prefixes-mutants-");
const mutants = [
  ["P1: a row of the own-page table is dropped", "  { prefix: 'sources/', what: 'a source note' },\n", "", /own-page table equals the shared sample/],
  ["P2: a row's text drifts", "what: 'a data file' }", "what: 'a data document' }", /own-page table equals the shared sample/],
  ["P3: the visualizations except folder is lost", "{ prefix: 'visualizations/', except_folder: 'visualizations/illustrations/', ", "{ prefix: 'visualizations/', ", /own-page table equals the shared sample/],
  ["P4: an accepted folder may source another class", "{ folder: 'maps/basemaps/', kind: 'map', classes: MAP_ASSET_CLASSES }", "{ folder: 'maps/basemaps/', kind: 'map', classes: DRAWN_ASSET_CLASSES }", /accepted folders and their classes/],
  ["P5: the except folder matches files in sub-folders too", "/^[^/]+\\.json$/.test(rel.slice(folder.length))", "/\\.json$/.test(rel.slice(folder.length))", /probe|visualizations\/illustrations\/plans\/p\.json|maps\/basemaps\/requests\/r\.json|the real check gives|the table says own page/],
  ["P6: a new own-page prefix the sample does not have", "  { prefix: 'data/', what: 'a data file' },\n", "  { prefix: 'data/', what: 'a data file' },\n  { prefix: 'runtime/', what: 'a runtime file' },\n", /own-page table equals the shared sample/],
  ["P7: an accepted folder is renamed in the table only (the check follows the table, so the table must stay equal to the sample)", "{ folder: 'maps/basemaps/', kind: 'map', classes: MAP_ASSET_CLASSES }", "{ folder: 'maps/base/', kind: 'map', classes: MAP_ASSET_CLASSES }", /accepted folders and their classes equal the shared sample/],
  ["P8: a basemap may source any asset class", "if (!MAP_ASSET_CLASSES.includes(assetClass)) return `source_refs entry ${rel} is a basemap;", "if (false) return `source_refs entry ${rel} is a basemap;", /x\.json as a source for \w+: accepted/],
  ["P9: a rendered illustration may source any asset class", "if (!accepted.classes.includes(assetClass)) return `source_refs entry ${rel} is a graphic", "if (false) return `source_refs entry ${rel} is a graphic", /x\.json as a source for \w+: accepted/],
  ["P10: the check lower-cases the path before looking it up", "export function assetSourceRefProblem(rel, parsed, assetClass) {\n", "export function assetSourceRefProblem(rel, parsed, assetClass) {\n  rel = String(rel).toLowerCase();\n", /probe|Maps\/|MAPS\/|Visualizations\//],
  ["P11: the .json extension is matched without regard to case", "/^[^/]+\\.json$/.test(rel.slice(folder.length))", "/^[^/]+\\.json$/i.test(rel.slice(folder.length))", /x\.JSON|probe/],
  ["P12: a manifest that is not a JSON object is let through to the field checks", "if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return", "if (false) return", /is not an asset manifest|Cannot read|parsed/],
  ["P13: a table row has no explicit kind", "{ folder: 'maps/basemaps/', kind: 'map', classes: MAP_ASSET_CLASSES }", "{ folder: 'maps/basemaps/', classes: MAP_ASSET_CLASSES }", /accepted folders and their classes equal the shared sample/],
  ["P14: the map branch follows the wrong kind", "if (accepted.kind === 'map') {", "if (accepted.kind === 'drawn') {", /x\.json as a source for \w+: accepted|probe|source_url/],
];
let caught = 0;
for (const [name, from, to, mustSay] of mutants) {
  assert.equal(source.split(from).length, 2, `${name}: the anchor occurs exactly once`);
  const folder = join(scratch, `m${caught}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "art_direction.mjs"), source.replace(from, to));
  const run = spawnSync(process.execPath, [join(ROOT, "scripts/test_asset_source_prefixes.mjs")], { encoding: "utf8", env: { ...process.env, ASSET_SOURCE_PREFIXES_RUNTIME: folder } });
  assert.notEqual(run.status, 0, `${name}: SURVIVED`);
  assert.match(`${run.stdout}${run.stderr}`, mustSay, `${name}: red for another reason:\n${(run.stderr || run.stdout).slice(0, 500)}`);
  console.log(`  red  ${name}`);
  caught++;
}
console.log(`asset source prefixes mutations: ${caught}/${mutants.length} caught -- PASS`);
