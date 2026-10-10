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
import { renderVizBundle, worldListBreaksFor, worldListValueText } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
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

const qaOf = (svg, env = { NEWSROOM_MAP_WORLD_LIST: "1" }) => {
  const saved = process.env.NEWSROOM_MAP_WORLD_LIST;
  delete process.env.NEWSROOM_MAP_WORLD_LIST;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const qa = runRenderQa({ desktop: svg }, { choropleth: { rows, category_field: "iso3", value_field: "v", category_names: "iso3", unit: "%", map_extent: "world", highlight_values: [] } });
    return Object.values(qa.viewports).flatMap((v) => v.value_labels?.failures ?? []);
  } finally { if (saved === undefined) delete process.env.NEWSROOM_MAP_WORLD_LIST; else process.env.NEWSROOM_MAP_WORLD_LIST = saved; }
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
  { // K195 note 8: the group titles write class edges with the legend's own formatter (fmtSpec), so a legend change carries over
    const legend = on.match(/<g data-role="choropleth-legend">[\s\S]*?<\/g>/)[0];
    const ticks = [...legend.matchAll(/y="[\d.]+" text-anchor[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/\s*%$/, ""));
    const edgeNumbers = [...on.matchAll(/data-role="choropleth-world-list-group"[^>]*>([^<]*)<\/text>/g)].flatMap((m) => m[1].replace(/[^0-9.\u2013<\u2265]/g, "").split(/[\u2013<\u2265]/).filter(Boolean));
    assert.ok(edgeNumbers.length >= 3 && ticks.length >= 3, `group edges and legend ticks were found (${edgeNumbers}; ${ticks})`);
    for (const e of edgeNumbers) assert.ok(ticks.includes(e), `group-title edge ${e} reads as a legend tick (${ticks.join(", ")})`);
  }
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b), "groups follow the legend order");
  assert.deepEqual(pyFailures(on), [], "the Python verifier reads every country back exactly once");
}

{ // no dots: a small country is listed, not also drawn as a dot (off state keeps its dots)
  assert.ok(/data-role="choropleth-data-dot"/.test(off), "the off state draws dots for small countries");
  assert.ok(!/data-role="choropleth-data-dot"/.test(on), "list mode draws no dots");
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

{ // render QA in list mode: every country with data has exactly one name and one value, on the map or in the list
  assert.deepEqual(qaOf(on), [], "render QA passes the list");
  const iso3List = [...worldListIso3s(joinedAll, spec)];
  const target = iso3List[5];
  const nameRe = new RegExp(`<text data-role="choropleth-footnote-name" data-iso3="${target}"[^>]*>[^<]*</text>`);
  const valueRe = new RegExp(`<text data-role="choropleth-footnote-value" data-iso3="${target}"[^>]*>([^<]*)</text>`);
  const rules = (svg, env) => qaOf(svg, env).map((f) => `${f.rule}:${f.message}`);
  const rejects = (label, svg, re) => { const f = rules(svg); assert.ok(f.some((m) => re.test(m)), `${label}: render QA rejects (${f.slice(0, 2).join(" | ")})`); };
  rejects("a list row is deleted", on.replace(nameRe, "").replace(valueRe, ""), new RegExp(`value_label_missing:${target} has no visible name label`));
  const minIso3 = [...worldLabelIso3s(joinedAll, spec)][0];
  const dup = `<text data-role="choropleth-footnote-name" data-iso3="${minIso3}" x="1" y="1">x</text><text data-role="choropleth-footnote-value" data-iso3="${minIso3}" x="1" y="1">1.0%</text>`;
  rejects("a map-labelled country is listed again", on.replace("</svg>", `${dup}</svg>`), new RegExp(`value_label_duplicate:${minIso3} has 2 name labels`));
  rejects("a list value is wrong", on.replace(valueRe, (m, t) => m.replace(t, "99.9%")), new RegExp(`value_label_mismatch:${target} shows`));
  const ghost = `<text data-role="choropleth-footnote-name" data-iso3="ZZZ" x="1" y="1">Nowhere</text><text data-role="choropleth-footnote-value" data-iso3="ZZZ" x="1" y="1">1.0%</text>`;
  rejects("a country with no data is listed", on.replace("</svg>", `${ghost}</svg>`), /value_label_unexpected:ZZZ is labelled although it has no data row/);
  // the list rule is the program's switch, not the chart's: with the switch off the same markup is still rejected
  const offRules = rules(on, {});
  assert.ok(offRules.some((m) => /value_label_unexpected:.*world mode labels only/.test(m)), "with the switch off the old rule still rejects listed countries");
  // the off-state render passes exactly as before
  assert.deepEqual(qaOf(off, {}), [], "off-state render still passes render QA");
}

{ // K195: a list value just below a class boundary whose one-decimal text equals the boundary's text gets a second decimal
  const B = [0.056, 2, 5, 10, 20, 40.128];
  const t = (v) => worldListValueText(v, "t", { unit: "t" }, B);
  assert.equal(t(1.952), "1.95 t", "below the 2 boundary and reading 2.0: two decimals");
  assert.equal(t(4.97), "4.97 t", "below the 5 boundary and reading 5.0: two decimals");
  for (const v of [2.011, 2.021, 5.012, 2, 5]) assert.equal(t(v), `${v.toFixed(1)} t`, `${v} is on or above the boundary: unchanged`);
  assert.equal(t(1.94), "1.9 t", "1.94 does not read as the boundary: unchanged");
  assert.equal(t(0.066), "0.1 t", "values far from a boundary keep one decimal");
  // end to end: one listed row sits just below an edge; the list prints two decimals, both verifiers and render QA read it
  const edges = worldListBreaksFor(rows.map((r) => r.v), spec).slice(1, -1);
  const labelled = worldLabelIso3s(joinedAll, spec);
  const pick = rows.find((r) => !labelled.has(joinChoroplethRows([r], spec)[0].iso3) && r.v >= edges[1] && r.v < edges[2]);
  const edge = edges[1];
  const near = Math.round((edge - 0.02) * 1000) / 1000;
  const rows2 = rows.map((r) => (r === pick ? { ...r, v: near } : r));
  assert.deepEqual(worldListBreaksFor(rows2.map((r) => r.v), spec).slice(1, -1), edges, "the edit keeps the class breaks");
  const saved = process.env.NEWSROOM_MAP_WORLD_LIST;
  process.env.NEWSROOM_MAP_WORLD_LIST = "1";
  try {
    const svg = renderVizBundle(spec, rows2).desktop;
    const m = svg.match(new RegExp(`data-role="choropleth-footnote-value" data-iso3="${pick.iso3}"[^>]*>([^<]*)</text>`));
    assert.equal(m?.[1], `${near.toFixed(2)}%`, "the near-edge row prints two decimals");
    assert.deepEqual(pyFailures(svg), [], "Python verifier reads the two-decimal row");
    const qa = (x) => Object.values(runRenderQa({ desktop: x }, { choropleth: { rows: rows2, category_field: "iso3", value_field: "v", category_names: "iso3", unit: "%", map_extent: "world", highlight_values: [] } }).viewports).flatMap((v) => v.value_labels?.failures ?? []);
    assert.deepEqual(qa(svg), [], "render QA accepts the two-decimal row");
    const one = svg.replace(`>${near.toFixed(2)}%</text>`, `>${near.toFixed(1)}%</text>`);
    assert.notEqual(one, svg);
    assert.ok(qa(one).some((f) => f.rule === "value_label_mismatch"), "render QA rejects the old one-decimal text for that row (exact text)");
  } finally { if (saved === undefined) delete process.env.NEWSROOM_MAP_WORLD_LIST; else process.env.NEWSROOM_MAP_WORLD_LIST = saved; }
  assert.equal(render(), off, "off state unchanged");
}

{ // K195 (review M4): the map's own labels keep the shared one-decimal text; only the list rows get the extra digit
  const edges = worldListBreaksFor(rows.map((r) => r.v), spec).slice(1, -1);
  const labelled = worldLabelIso3s(joinedAll, spec);
  const nearOf = (edge) => Math.round((edge - 0.02) * 1000) / 1000;
  // a large country, so the map has room for its label; the values are replaced below, so its own value does not matter
  const onMap = rows.find((r) => ["BRA", "CHN", "IND", "RUS", "ARG", "KAZ"].includes(r.iso3) && !labelled.has(r.iso3));
  assert.ok(onMap, "fixture row for the map label");
  const spec3 = { ...spec, highlight_values: [onMap.iso3] }; // a named country is labelled on the map, so it is not a list row
  const saved = process.env.NEWSROOM_MAP_WORLD_LIST;
  process.env.NEWSROOM_MAP_WORLD_LIST = "1";
  try {
    // some countries are numbered footnotes instead of list rows (they keep the shared text there): try candidates until one is a list row
    let hit = null;
    for (const inList of rows.filter((r) => r !== onMap && !labelled.has(r.iso3)).slice(0, 60)) {
      const rows3 = rows.map((r) => (r === onMap ? { ...r, v: nearOf(edges[0]) } : r === inList ? { ...r, v: nearOf(edges[1]) } : r));
      if (JSON.stringify(worldListBreaksFor(rows3.map((r) => r.v), spec).slice(1, -1)) !== JSON.stringify(edges)) continue;
      const svg = renderVizBundle(spec3, rows3).desktop;
      if (new RegExp(`choropleth-footnote-marker" data-iso3="${inList.iso3}"`).test(svg)) continue;
      if (new RegExp(`choropleth-footnote-value" data-iso3="${inList.iso3}"`).test(svg)) { hit = { inList, svg }; break; }
    }
    assert.ok(hit, "a list-only row just under a class edge exists in the fixture");
    const { inList, svg } = hit;
    const mapLabel = svg.match(new RegExp(`<text data-role="choropleth-label-value" data-iso3="${onMap.iso3}"[^>]*>([^<]*)</text>`));
    assert.ok(mapLabel, "the highlighted country is labelled on the map");
    assert.equal(mapLabel[1], `${nearOf(edges[0]).toFixed(1)}%`, "the map label just under a class edge keeps one decimal");
    assert.ok(!new RegExp(`choropleth-footnote-value" data-iso3="${onMap.iso3}"`).test(svg), "the map-labelled country is not repeated in the list");
    const row = svg.match(new RegExp(`data-role="choropleth-footnote-value" data-iso3="${inList.iso3}"[^>]*>([^<]*)</text>`));
    assert.equal(row?.[1], `${nearOf(edges[1]).toFixed(2)}%`, "the list row just under a class edge gets the extra digit");
    assert.deepEqual(pyFailures(svg), [], "Python verifier reads both");
  } finally { if (saved === undefined) delete process.env.NEWSROOM_MAP_WORLD_LIST; else process.env.NEWSROOM_MAP_WORLD_LIST = saved; }
}

{ // both switches on (NEWSROOM_TYPESET_CHOROPLETH_ZH + the world list): list rows follow the zh 万 rules and the same half-up digits
  const zh = { ...spec, language: "zh" };
  const B = [0.056, 2, 5, 10, 20, 40.128];
  const prev = process.env.NEWSROOM_TYPESET_CHOROPLETH_ZH;
  process.env.NEWSROOM_TYPESET_CHOROPLETH_ZH = "1";
  try {
    // with a 万-sized value on the map, a value under 1万 is an integer; without one it keeps one decimal
    assert.equal(worldListValueText(8765.5, "人", zh, B, true), "8766 人", "wan context: integer below 1万");
    assert.equal(worldListValueText(12345.67, "人", zh, B, true), "1.2万 人", "1万 and up in 万");
    // no 万 context: the K195 extra digit still applies, and it is rounded half up like the label (1.95 is the exact tie at 2 digits)
    assert.equal(worldListValueText(1.952, "t", { ...zh, unit: "t" }, B, false), "1.95 t", "no wan context: second decimal below the 2 boundary");
    assert.equal(worldListValueText(1.95, "t", { ...zh, unit: "t" }, [0, 2, 5, 40], false), "1.95 t", "typeset zh: the extra digit is the half-up text");
    // end to end: one country is 万-sized, one sits just below an edge; the list prints under the zh rules and both readers agree
    const labelled = worldLabelIso3s(joinedAll, zh);
    const unlabelled = rows.filter((r) => !labelled.has(joinChoroplethRows([r], zh)[0].iso3));
    const big = unlabelled[0], small = unlabelled[1];
    const rows3 = rows.map((r) => (r === big ? { ...r, v: 23456.7 } : r === small ? { ...r, v: 8.5 } : r));
    const saved = process.env.NEWSROOM_MAP_WORLD_LIST;
    process.env.NEWSROOM_MAP_WORLD_LIST = "1";
    try {
      const svg = renderVizBundle(zh, rows3).desktop;
      assert.deepEqual(pyFailures(svg), [], "Python verifier reads the zh list back");
      const text = (iso3) => (svg.match(new RegExp(`data-role="choropleth-footnote-value" data-iso3="${iso3}"[^>]*>([^<]*)</text>`)) ?? [])[1];
      assert.match(text(big.iso3) ?? "", /^2\.3万/, "the 万-sized row is in 万");
      assert.equal(text(small.iso3), "9%", "wan context: the small row is an integer (8.5 rounds half up)");
      const qa = runRenderQa({ desktop: svg }, { choropleth: { rows: rows3, category_field: "iso3", value_field: "v", category_names: "iso3", unit: "%", map_extent: "world", highlight_values: [], language: "zh" } });
      assert.deepEqual(Object.values(qa.viewports).flatMap((v) => v.value_labels?.failures ?? []), [], "render QA accepts the zh list text");
    } finally { if (saved === undefined) delete process.env.NEWSROOM_MAP_WORLD_LIST; else process.env.NEWSROOM_MAP_WORLD_LIST = saved; }
  } finally { if (prev === undefined) delete process.env.NEWSROOM_TYPESET_CHOROPLETH_ZH; else process.env.NEWSROOM_TYPESET_CHOROPLETH_ZH = prev; }
}

{ // pinned: the off-state output of this fixture is the pre-switch output (hash taken at 559f6ba, before this switch existed)
  const sha = createHash("sha256").update(off).digest("hex");
  assert.equal(sha, "7c07d446e2becafe62522049c3fba2433aac875ec3c76ecc80619e11c06080a7", `off-state world map output changed (sha256 ${sha})`);
}
console.log("test_map_world_list.mjs: ok");
