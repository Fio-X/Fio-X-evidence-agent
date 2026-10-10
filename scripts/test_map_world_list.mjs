#!/usr/bin/env node
// Covers NEWSROOM_MAP_WORLD_LIST=1 (opt-in, only with NEWSROOM_MAP_WORLD=1): the world map prints every country the map
// does not label once, in a list under it grouped by legend class, using the footnote name/value roles with data-iso3,
// so the Python verifier (NEWSROOM_VERIFY_MAP_FOOTNOTES=1) reads each country back exactly once. Also covers the
// multi-part country fix (one choropleth-data path per country) and that the switch is off by default and only "1" turns
// it on. Synthetic rows only.
//   NEWSROOM_MAP_WORLD=1 node scripts/test_map_world_list.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
assert.equal(process.env.NEWSROOM_MAP_WORLD, "1", "run test_map_world_list.mjs with NEWSROOM_MAP_WORLD=1");
delete process.env.NEWSROOM_MAP_WORLD_LIST;
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID, joinChoroplethRows, neAttributesAsset, worldLabelIso3s, worldListIso3s } from "../runtime/pi/choropleth.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const spec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Inflation by economy", alt: "A world map of inflation by economy, darker meaning higher.",
  source_note: "Synthetic fixture", claim_id: "claim-world-fixture", sql: "SELECT iso3, v FROM fixture", unit: "%", chart_type: "choropleth",
  category_field: "iso3", value_field: "v", category_names: "iso3", basemap_id: basemap.id, basemap_source_url: basemap.source_url,
  basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], map_extent: "world",
};
const seen = new Set();
const ISO = neAttributesAsset().features.filter((f) => f.iso3 && f.continent !== "Antarctica" && f.continent !== "Seven seas (open ocean)" && !seen.has(f.iso3) && seen.add(f.iso3)).map((f) => f.iso3);
const skew = (i) => Math.round((0.5 + (((i * 37) % 97) / 97) ** 4 * 60 + (i % 7 === 0 ? 3 : 0)) * 10) / 10;
const ROWS = ISO.map((iso3, i) => ({ iso3, v: skew(i) }));
const rows = ROWS.filter((r) => joinChoroplethRows([r], spec)[0]?.entry?.kind === "economy" && joinChoroplethRows([r], spec)[0].featureIndices.length);
assert.ok(rows.length > 150, `enough synthetic economies (${rows.length})`);
const joinedAll = rows.map((r) => joinChoroplethRows([r], spec)[0]);
const render = (env = {}) => {
  const saved = process.env.NEWSROOM_MAP_WORLD_LIST;
  delete process.env.NEWSROOM_MAP_WORLD_LIST;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { return renderVizBundle(spec, rows).desktop; } finally { if (saved === undefined) delete process.env.NEWSROOM_MAP_WORLD_LIST; else process.env.NEWSROOM_MAP_WORLD_LIST = saved; }
};

// Python verifier, loaded as a module (it registers itself in sys.modules for its dataclasses).
const PY = `
import sys, importlib.util
sp = importlib.util.spec_from_file_location('v', sys.argv[1] + '/scripts/verify_artifact.py'); m = importlib.util.module_from_spec(sp); sys.modules['v'] = m; sp.loader.exec_module(m)
f = m.verify_choropleth_labels_from_svg(sys.stdin.read())
print('\\n'.join(f))
`;
const pyFailures = (svg) => {
  const r = spawnSync("python3", ["-I", "-c", PY, root], { input: svg, encoding: "utf8", env: { PATH: process.env.PATH, NEWSROOM_VERIFY_MAP_FOOTNOTES: "1" } });
  assert.equal(r.status, 0, `python verifier ran: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
};

const off = render();
const on = render({ NEWSROOM_MAP_WORLD_LIST: "1" });

{ // off by default: only the exact string "1" turns it on; any other value leaves the output byte-identical
  for (const v of ["true", "0", "", "yes", " 1", "on"]) assert.equal(render({ NEWSROOM_MAP_WORLD_LIST: v }), off, `NEWSROOM_MAP_WORLD_LIST=${JSON.stringify(v)} changes nothing`);
  assert.ok(!/choropleth-world-list/.test(off), "no list markup when off");
  assert.notEqual(on, off, "the switch changes the output");
  // the switch needs world mode: without NEWSROOM_MAP_WORLD a world spec is refused, and a non-world map never reads it
  const { map_extent, ...plain } = spec;
  const few = rows.slice(0, 12);
  const a = renderVizBundle(plain, few).desktop;
  process.env.NEWSROOM_MAP_WORLD_LIST = "1";
  const b = renderVizBundle(plain, few).desktop;
  delete process.env.NEWSROOM_MAP_WORLD_LIST;
  assert.equal(a, b, "a map without map_extent ignores the switch");
}

{ // the list: every country the map does not label, once, grouped by class; the labelled ones are not repeated
  const labelled = worldLabelIso3s(joinedAll, spec);
  const listed = worldListIso3s(joinedAll, spec);
  assert.equal(listed.size + labelled.size, rows.length, "listed + labelled = every country with data");
  for (const iso3 of labelled) assert.ok(!listed.has(iso3), `${iso3} is labelled on the map, so not in the list`);
  const names = [...on.matchAll(/data-role="choropleth-footnote-name" data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  const values = [...on.matchAll(/data-role="choropleth-footnote-value" data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  for (const iso3 of listed) { assert.equal(names.filter((x) => x === iso3).length, 1, `${iso3} has one list name`); assert.equal(values.filter((x) => x === iso3).length, 1, `${iso3} has one list value`); }
  assert.ok(/data-role="choropleth-world-list-group"/.test(on), "group headers");
  const groups = [...on.matchAll(/data-role="choropleth-world-list-group" data-class="(\d)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b), "groups follow the legend order");
  assert.deepEqual(pyFailures(on), [], "the Python verifier reads every country back exactly once");
}

{ // multi-part countries: one choropleth-data path per country (Australia is drawn in three pieces on the basemap)
  const paths = [...on.matchAll(/<path data-role="choropleth-data" data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  assert.equal(new Set(paths).size, paths.length, "no country has two choropleth-data paths");
  const multi = joinedAll.filter((it) => it.featureIndices.length > 1).map((it) => it.iso3);
  assert.ok(multi.length > 0, "the fixture has multi-part countries");
  const offPaths = [...off.matchAll(/<path data-role="choropleth-data" data-iso3="([A-Z]{3})"/g)].map((m) => m[1]);
  assert.ok(new Set(offPaths).size < offPaths.length, "off state keeps today's several paths per multi-part country");
}

{ // tampered markup: each is rejected by the Python verifier
  const iso3List = [...worldListIso3s(joinedAll, spec)];
  const target = iso3List[5];
  const nameRe = new RegExp(`<text data-role="choropleth-footnote-name" data-iso3="${target}"[^>]*>[^<]*</text>`);
  const valueRe = new RegExp(`<text data-role="choropleth-footnote-value" data-iso3="${target}"[^>]*>([^<]*)</text>`);
  assert.ok(nameRe.test(on) && valueRe.test(on), "found the target row");
  const rejects = (label, svg, re) => { const f = pyFailures(svg); assert.ok(f.some((m) => re.test(m)), `${label}: rejected (${f.slice(0, 2).join(" | ")})`); };
  rejects("a list row is deleted", on.replace(nameRe, "").replace(valueRe, ""), new RegExp(`${target} has 0 rendered name labels`));
  const minIso3 = [...worldLabelIso3s(joinedAll, spec)][0];
  const dup = `<text data-role="choropleth-footnote-name" data-iso3="${minIso3}" x="1" y="1">x</text><text data-role="choropleth-footnote-value" data-iso3="${minIso3}" x="1" y="1">1.0%</text>`;
  rejects("a map-labelled country is listed again", on.replace("</svg>", `${dup}</svg>`), new RegExp(`${minIso3} has 2 rendered name labels`));
  rejects("a list value is wrong", on.replace(valueRe, (m, t) => m.replace(t, "99.9%")), new RegExp(`${target}'s rendered value label`));
  const ghost = `<text data-role="choropleth-footnote-name" data-iso3="ZZZ" x="1" y="1">Nowhere</text><text data-role="choropleth-footnote-value" data-iso3="ZZZ" x="1" y="1">1.0%</text>`;
  rejects("a country with no data is listed", on.replace("</svg>", `${ghost}</svg>`), /ZZZ has a rendered label but no matching choropleth-data region/);
}

{ // pinned: the off-state output of this fixture is the pre-switch output (hash taken at 559f6ba, before this switch existed)
  const sha = createHash("sha256").update(off).digest("hex");
  assert.equal(sha, "7c07d446e2becafe62522049c3fba2433aac875ec3c76ecc80619e11c06080a7", `off-state world map output changed (sha256 ${sha})`);
}
console.log("test_map_world_list.mjs: ok");
