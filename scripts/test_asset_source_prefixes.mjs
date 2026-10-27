#!/usr/bin/env node
// The design-pack asset source rule's path table is one shared sample (fixtures/design_pack/asset-source-prefixes.json) that the JS check reads today and the Rust audit is meant to read once that side lands.
// This test keeps the JS side equal to it: the same own-page prefixes (with their except folders and texts), the same accepted folders and classes, and the same verdict for
// every probe path, where the verdict is taken from the real check (assetSourceRefProblem) and not from a copy of the matcher. Until the Rust side lands, nothing compares it with the same file.
// Mutations are in scripts/test_asset_source_prefixes_mutants.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const shared = JSON.parse(readFileSync(join(ROOT, "fixtures/design_pack/asset-source-prefixes.json"), "utf8"));
const dir = process.env.ASSET_SOURCE_PREFIXES_RUNTIME ?? join(ROOT, "runtime/pi");
const art = await import(pathToFileURL(join(dir, "art_direction.mjs")).href);
let checks = 0;
const check = (text) => { checks++; console.log(`  PASS ${text}`); };

assert.deepEqual(JSON.parse(JSON.stringify(art.OWN_PAGE_KINDS)), shared.own_page, "own-page table equals the shared sample, row for row (prefix, except_folder, text)");
check(`the own-page table has the shared sample's ${shared.own_page.length} rows, in order`);
assert.deepEqual(JSON.parse(JSON.stringify(art.ACCEPTED_SOURCE_FOLDERS)), shared.accepted_folders, "accepted folders and their classes equal the shared sample");
check("the accepted folders and the asset classes each may source equal the shared sample");
assert.equal(new Set(shared.own_page.map((r) => r.prefix)).size, shared.own_page.length, "no prefix twice");
for (const row of shared.own_page) if (row.except_folder) assert.ok(row.except_folder.startsWith(row.prefix) && shared.accepted_folders.some((f) => f.folder === row.except_folder), `${row.prefix}: its except folder is an accepted folder under it`);
check("every except folder sits under its prefix and is an accepted folder");

const good = { source_url: "https://example.org/b", license: "Public domain", variants: { desktop: "d" }, plan_ref: "p" };
const verdictOf = (rel) => {
  const own = art.OWN_PAGE_KINDS.find((r) => rel.startsWith(r.prefix) && !(r.except_folder && rel.startsWith(r.except_folder) && /^[^/]+\.json$/.test(rel.slice(r.except_folder.length))));
  const text = art.assetSourceRefProblem(rel, good, "published_gis") ?? "";
  if (/ of this run, not an asset manifest/.test(text)) { assert.ok(own, `${rel}: the check named an own-page kind the table does not have`); assert.ok(text.includes(` is ${own.what} of this run`), `${rel}: the refusal names the table's text: ${text.slice(0, 120)}`); return "own_page"; }
  assert.equal(own, undefined, `${rel}: the table says own page but the check did not refuse it as one`);
  return /not a source this run can recognise/.test(text) ? "unknown" : "accepted_folder";
};
for (const [rel, expected] of Object.entries(shared.probes)) assert.equal(verdictOf(rel), expected, `${rel}`);
check(`the real check gives the shared sample's verdict for all ${Object.keys(shared.probes).length} probe paths`);
const everyClass = [...new Set([...shared.accepted_folders.flatMap((f) => f.classes), "archival_photo", "historical_series"])];
for (const { folder, classes } of shared.accepted_folders) for (const assetClass of everyClass) {
  const problem = art.assetSourceRefProblem(`${folder}x.json`, good, assetClass);
  assert.equal(problem === null, classes.includes(assetClass), `${folder}x.json as a source for ${assetClass}: ${problem ?? "accepted"}`);
}
check("a well-formed file in each accepted folder is a source for exactly the classes the shared sample lists for that folder, and for no other class");
for (const { folder, kind, classes } of shared.accepted_folders) {
  assert.ok(kind === "map" || kind === "drawn", `${folder}: kind is map or drawn`);
  for (const parsed of [null, [], "text", 3, true]) {
    const problem = art.assetSourceRefProblem(`${folder}x.json`, parsed, classes[0]);
    assert.match(problem ?? "accepted", /is not an asset manifest \(it is not a JSON object\)/, `${folder}x.json with parsed ${JSON.stringify(parsed)}: ${problem ?? "accepted"}`);
  }
}
check("every accepted folder has an explicit kind (map or drawn), and a manifest that does not parse to a JSON object (null, array, string, number, boolean) is refused as such");
console.log(`asset source prefixes: ${checks} checks -- PASS`);
