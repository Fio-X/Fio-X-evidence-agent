#!/usr/bin/env node
// Hand-written pins for the basemap registry (runtime/pi/basemap_registry.mjs): id -> sha256 of the file, source url, license.
// The registry computes each hash from the file when it loads and keeps url and license as plain text, so every check that compares a value with the
// registry compares it with itself. These pins are the independent side: they are typed in here, not read from the registry.
//   sha256: computed from the file on disk, then copied in by hand.
//   url and license (the three Natural Earth rows): read from the upstream pages (the download pages exist; the terms of use page,
//   https://www.naturalearthdata.com/about/terms-of-use/, says "All versions of Natural Earth raster + vector map data found on this website are in the public domain.").
// Changing a basemap file, its url or its license must be a deliberate edit of this table.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const piDir = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "pi");

const PINS = {
  naturalearth_admin0_110m: {
    sha256: "eb485f15dece54e2a188e65839b4a15539e4b2a58716732634253a831e085be1",
    source_url: "https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/",
    license: "Public domain (Natural Earth terms of use)",
  },
  naturalearth_admin0_50m: {
    sha256: "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e",
    source_url: "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/",
    license: "Public domain (Natural Earth terms of use)",
  },
  naturalearth_admin1_us_110m: {
    sha256: "c118b78d9ecce4b934061559e8d2ef072dd038076dd6386eb8e7ec02498f0c0c",
    source_url: "https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-1-states-provinces/",
    license: "Public domain (Natural Earth terms of use)",
  },
  gshhg_syros_i_local: {
    sha256: "9d4166023edd928cffb3236ad75ea3d8a4f5bb822e2f55adc98f9320e5b6d2c8",
    // NOT independently verified upstream: the GSHHG page was unreachable from the test machine, and the upstream GMT page says "v3 or any earlier
    // version", which may not match "or-later". These two values are pinned to what the registry says today, so a change to them is deliberate;
    // that does not claim they are right.
    source_url: "https://www.soest.hawaii.edu/pwessel/gshhg/",
    license: "LGPL-3.0-or-later (GSHHG 2.3.6 via basemap-data 2.0.0)",
  },
};

// the registry module at `dir` (a runtime/pi directory or a copy of it); every failed expectation is returned as text
async function suite(dir, label) {
  const mod = await import(`${pathToFileURL(join(dir, "basemap_registry.mjs")).href}?${Math.random()}`);
  const fails = [];
  const listed = mod.listBasemaps();
  const ids = listed.map((b) => b.id);
  // completeness: every registered id has a pin, and every pin is registered
  for (const id of ids) if (!(id in PINS)) fails.push(`${label}: ${id} is registered but has no pin`);
  for (const id of Object.keys(PINS)) if (!ids.includes(id)) fails.push(`${label}: ${id} is pinned but not registered`);
  for (const meta of listed) {
    const pin = PINS[meta.id];
    if (!pin) continue;
    // the hash is computed here from the file on disk, not read from the registry's content_hash
    const onDisk = createHash("sha256").update(readFileSync(join(dir, "assets", meta.file))).digest("hex");
    if (onDisk !== pin.sha256) fails.push(`${label}: ${meta.id} file sha256 ${onDisk.slice(0, 12)} differs from the pin ${pin.sha256.slice(0, 12)}`);
    if (meta.content_hash !== pin.sha256) fails.push(`${label}: ${meta.id} registry content_hash differs from the pin`);
    if (meta.source_url !== pin.source_url) fails.push(`${label}: ${meta.id} source_url differs from the pin`);
    if (meta.license !== pin.license) fails.push(`${label}: ${meta.id} license differs from the pin`);
  }
  return fails;
}

// a copy of the registry and its assets, patched; the real files are never touched
function copyWith(name, patchRegistry, patchAsset) {
  const dir = makeTestTmp(`basemap-pins-${name}-`);
  cpSync(join(piDir, "basemap_registry.mjs"), join(dir, "basemap_registry.mjs"));
  mkdirSync(join(dir, "assets"));
  for (const file of ["naturalearth-admin0-110m.geojson", "naturalearth-admin0-50m.geojson", "naturalearth-admin1-us-110m.geojson", "gshhs-i-syros-local.geojson"]) {
    cpSync(join(piDir, "assets", file), join(dir, "assets", file));
  }
  if (patchRegistry) writeFileSync(join(dir, "basemap_registry.mjs"), patchRegistry(readFileSync(join(dir, "basemap_registry.mjs"), "utf8")));
  if (patchAsset) { const [file, fn] = patchAsset; writeFileSync(join(dir, "assets", file), fn(readFileSync(join(dir, "assets", file), "utf8"))); }
  return dir;
}
const swap = (s, a, b) => { assert.ok(s.includes(a), `mutant target not found: ${a}`); return s.replace(a, () => b); };
// change the last digit of the first decimal coordinate
const nudge = (text) => text.replace(/(\d+\.\d*?)(\d)(?=[,\]\s])/, (_, head, last) => `${head}${(Number(last) + 1) % 10}`);

const real = await suite(piDir, "real");
assert.deepEqual(real, [], real.join("\n"));

// each mutant must turn the suite red, for the reason named
const mutants = [
  ["110m-coordinate", copyWith("a", null, ["naturalearth-admin0-110m.geojson", nudge]), "naturalearth_admin0_110m file sha256"],
  ["syros-coordinate", copyWith("b", null, ["gshhs-i-syros-local.geojson", nudge]), "gshhg_syros_i_local file sha256"],
  ["110m-url-only", copyWith("c", (s) => swap(s, "downloads/110m-cultural-vectors/110m-admin-0-countries/", "downloads/110m-cultural-vectors/110m-admin-0-countries-x/"), null), "naturalearth_admin0_110m source_url"],
  ["license-only", copyWith("d", (s) => swap(s, "license: 'Public domain (Natural Earth terms of use)',\n    resolution: '110m',\n    nominal_scale: 110_000_000,\n    detail_class: 'global'", "license: 'CC0',\n    resolution: '110m',\n    nominal_scale: 110_000_000,\n    detail_class: 'global'"), null), "naturalearth_admin0_110m license"],
  ["registered-without-pin", copyWith("e", (s) => swap(s, "export const DEFAULT_BASEMAP_ID", "DEFINITIONS.push({ ...DEFINITIONS[0], id: 'extra_basemap' });\nREGISTRY.set('extra_basemap', Object.freeze({ ...DEFINITIONS[0], id: 'extra_basemap', content_hash: 'x', data: {} }));\nexport const DEFAULT_BASEMAP_ID"), null), "extra_basemap is registered but has no pin"],
  ["pinned-not-registered", copyWith("f", (s) => swap(s, "REGISTRY.set(definition.id,", "if (definition.id !== 'gshhg_syros_i_local') REGISTRY.set(definition.id,"), null), "gshhg_syros_i_local is pinned but not registered"],
];
for (const [name, dir, reason] of mutants) {
  const failures = await suite(dir, `mutant ${name}`);
  assert.ok(failures.length > 0, `mutant must turn the suite red: ${name}`);
  assert.ok(failures.some((f) => f.includes(reason)), `mutant ${name} must fail for the reason "${reason}", got: ${failures.join(" | ")}`);
}
console.log(`ok test_basemap_pins: ${Object.keys(PINS).length} pins (hash from disk, url, license), completeness both ways, ${mutants.length} mutants red for the named reason`);
