#!/usr/bin/env node
// Switch names that the four groups each read for themselves (no shared reader function, see scripts/test_group_cross_calls.mjs): every read of
// one of them, in any file of runtime/pi/, must be the exact-"1" rule (`<env>.NAME === "1"` or `!== "1"`), never a truthy test or another value.
// #64 step 1: the two default-on switches (DEFAULT_ON) are read the other way round: on unless exactly "0" (`<env>.NAME !== "0"`, or `=== "0"` for "turned off").
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "pi");
const NAMES = ["NEWSROOM_SIGNED_SCALE", "NEWSROOM_HERO_GLYPH_WIDTH", "NEWSROOM_SIGNED_BARS", "NEWSROOM_LEGEND_TICK_FIT", "NEWSROOM_TITLE_ONE", "NEWSROOM_HERO_SIZE_UP", "NEWSROOM_CHORO_LEDGER_SIZE", "NEWSROOM_SIGNED_SCALE_CHECK", "NEWSROOM_RISO_MAP_RINGS", "NEWSROOM_CHORO_LEADER_CLEARANCE", "NEWSROOM_CHORO_BADGE_CLEAR", "NEWSROOM_CHORO_LIST_COMPACT", "NEWSROOM_GRAMMAR_HINT_ELIGIBLE", "NEWSROOM_MAP_FLOW_SUPPORT", "NEWSROOM_BASIS_TEXT_BODY", "NEWSROOM_GROUP_CALL_REPORT", "NEWSROOM_SANKEY_ONE_OTHER", "NEWSROOM_SPEED_FIRST_TRY_SHAPES", "NEWSROOM_US_STATES", "NEWSROOM_REVIEW_SPLIT", "NEWSROOM_STORYBOARD", "NEWSROOM_LEAN_GATES", "NEWSROOM_STORY_FORMS", "NEWSROOM_TILE_MAP", "NEWSROOM_PUBLICATION_EMBED_PAGE", "NEWSROOM_PUBLICATION_STYLE_COMPAT", "NEWSROOM_BAR_REF_DOMAIN", "NEWSROOM_BAR_ZERO_MARK", "NEWSROOM_BAR_LABEL_UNIT", "NEWSROOM_HERO_THOUSANDS", "NEWSROOM_ONE_NUMBERING", "NEWSROOM_GROUP_HANDOFF", "NEWSROOM_YEAR_LABEL_GARBLED"];
const DEFAULT_ON = new Set(["NEWSROOM_GROUP_CALL_REPORT", "NEWSROOM_GROUP_HANDOFF"]);
const files = readdirSync(DIR).filter((f) => /\.(mjs|ts)$/.test(f));
const bad = [];
const seen = Object.fromEntries(NAMES.map((n) => [n, 0]));
for (const file of files) {
  const lines = readFileSync(join(DIR, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const name of NAMES) {
      // a read: property access on an env object (process.env, env, ctx.env ...), with or without ?. and bracket form
      const re = new RegExp(`(?:env\\??\\.${name}|env\\??\\.?\\[\\s*["']${name}["']\\s*\\])(?![\\w])(.{0,12})`, "g");
      for (const m of line.matchAll(re)) {
        seen[name] += 1;
        const exact = DEFAULT_ON.has(name) ? /^\s*[!=]==\s*["']0["']/ : /^\s*[!=]==\s*["']1["']/;
        if (!exact.test(m[1])) bad.push(`${file}:${i + 1} ${name}: ${line.trim().slice(0, 140)}`);
      }
    }
  });
}
assert.deepEqual(bad, [], `switch read that is not its exact rule ("1" for opt-in switches, "0" for the default-on ones):\n${bad.join("\n")}`);
for (const name of NAMES) assert.ok(seen[name] > 0, `no read of ${name} found: the scan is not looking at the code any more`);

// The grammar -> chart-form table: VISUAL_GRAMMAR_FORMS stays a pure constant that holds only the always-on forms (byte-for-byte the table of a run with every
// switch off) and carries the switched forms as non-enumerable data, gatedForms. Each group filters it with its own exact-"1" read of the named switch.
const { VISUAL_GRAMMAR_FORMS } = await import(join(DIR, "infographic.mjs"));
const OFF_TABLE = {"rank":["horizontal_bar","dot"],"change":["dumbbell","slope"],"trend":["line","multi_line","small_multiples","streamgraph"],"anomaly":["diverging_bar","dot","small_multiples"],"benchmark":["dot","dumbbell","horizontal_bar"],"composition":["horizontal_bar","heatmap","parallel_sets","alluvial","waffle","stacked_bar_100"],"distribution":["dot","heatmap","small_multiples","strip_plot","mirrored_bar"],"relationship":["scatter","node_link","chord"],"uncertainty":["line","multi_line","small_multiples"],"flow":["sankey","alluvial","parallel_sets","geo_flow_map","cartographic_flow_map"],"spatial":["geo_flow_map","cartographic_flow_map","choropleth"],"network":["node_link","adjacency_matrix","chord"],"mechanism":["process_schematic"],"sequence":["timeline","trajectory_profile","line"]};
assert.deepEqual(Object.fromEntries(Object.entries(VISUAL_GRAMMAR_FORMS).map(([grammar, forms]) => [grammar, [...forms]])), OFF_TABLE, "the table with every switch off changed");
assert.equal(Object.keys(VISUAL_GRAMMAR_FORMS).includes("gatedForms"), false, "gatedForms must not be enumerable");
const gated = VISUAL_GRAMMAR_FORMS.gatedForms;
assert.deepEqual(JSON.parse(JSON.stringify(gated)), { composition: { people_dots: "NEWSROOM_STORY_FORMS" }, spatial: { tile_map: "NEWSROOM_TILE_MAP" }, sequence: { clock_dial: "NEWSROOM_STORY_FORMS" } });
for (const names of Object.values(gated)) for (const name of Object.values(names)) assert.ok(NAMES.includes(name), `${name} is not in the scanned switch names`);
// every group that filters the table by the switch name it carries does it with the exact "1" rule
for (const file of ["infographic.mjs", "newsroom.ts"]) {
  const text = readFileSync(join(DIR, file), "utf8");
  const reads = [...text.matchAll(/process\.env\[name(?: as string)?\](.{0,12})/g)];
  assert.ok(reads.length >= 1, `${file}: no filter read of the gated switches found`);
  for (const m of reads) assert.match(m[1], /^\s*===\s*"1"/, `${file}: a gated-form filter that is not the exact "1" rule`);
}
// with the switches on, the filter the groups use yields the forms the table had before they moved out (people_dots, tile_map, clock_dial)
const active = (env) => Object.fromEntries(Object.entries(VISUAL_GRAMMAR_FORMS).map(([grammar, forms]) => [grammar, [...forms, ...Object.entries(gated[grammar] ?? {}).filter(([, name]) => env[name] === "1").map(([form]) => form)]]));
assert.deepEqual(active({}), OFF_TABLE);
assert.deepEqual(active({ NEWSROOM_STORY_FORMS: "1" }).composition.slice(-1), ["people_dots"]);
assert.deepEqual(active({ NEWSROOM_STORY_FORMS: "1" }).sequence.slice(-1), ["clock_dial"]);
assert.deepEqual(active({ NEWSROOM_TILE_MAP: "1" }).spatial.slice(-1), ["tile_map"]);
assert.deepEqual(active({ NEWSROOM_STORY_FORMS: "true", NEWSROOM_TILE_MAP: "yes" }), OFF_TABLE);
console.log(`test_switch_read_sites: ok (${Object.entries(seen).map(([n, c]) => `${n.replace("NEWSROOM_", "")}=${c}`).join(" ")})`);
