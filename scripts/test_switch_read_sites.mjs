#!/usr/bin/env node
// Switch names that the four groups each read for themselves (no shared reader function, see scripts/test_group_cross_calls.mjs): every read of
// one of them, in any file of runtime/pi/, must be the exact-"1" rule (`<env>.NAME === "1"` or `!== "1"`), never a truthy test or another value.
// #64 step 1: the default-on switches (DEFAULT_ON) are read the other way round: on unless exactly "0" (`<env>.NAME !== "0"`, or `=== "0"` for "turned off").
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "runtime", "pi");
const NAMES = ["NEWSROOM_SIGNED_SCALE", "NEWSROOM_HERO_GLYPH_WIDTH", "NEWSROOM_SIGNED_BARS", "NEWSROOM_LEGEND_TICK_FIT", "NEWSROOM_TITLE_ONE", "NEWSROOM_HERO_SIZE_UP", "NEWSROOM_CHORO_LEDGER_SIZE", "NEWSROOM_SIGNED_SCALE_CHECK", "NEWSROOM_RISO_MAP_RINGS", "NEWSROOM_CHORO_LEADER_CLEARANCE", "NEWSROOM_CHORO_BADGE_CLEAR", "NEWSROOM_CHORO_LIST_COMPACT", "NEWSROOM_GRAMMAR_HINT_ELIGIBLE", "NEWSROOM_MAP_FLOW_SUPPORT", "NEWSROOM_BASIS_TEXT_BODY", "NEWSROOM_SANKEY_ONE_OTHER", "NEWSROOM_SPEED_FIRST_TRY_SHAPES", "NEWSROOM_US_STATES", "NEWSROOM_STORYBOARD", "NEWSROOM_LEAN_GATES", "NEWSROOM_STORY_FORMS", "NEWSROOM_TILE_MAP", "NEWSROOM_PUBLICATION_EMBED_PAGE", "NEWSROOM_PUBLICATION_STYLE_COMPAT", "NEWSROOM_BAR_REF_DOMAIN", "NEWSROOM_BAR_ZERO_MARK", "NEWSROOM_BAR_LABEL_UNIT", "NEWSROOM_HERO_THOUSANDS", "NEWSROOM_ONE_NUMBERING", "NEWSROOM_EVEN_SPLIT_PICTOGRAM", "NEWSROOM_CAUSAL_PHRASES_EN", "NEWSROOM_YEAR_LABEL_GARBLED", "NEWSROOM_XLS_FAILURE_PROVENANCE", "NEWSROOM_HERO_RECOMPUTE", "NEWSROOM_SANKEY_MIXED_UNITS", "NEWSROOM_GROUP_CALL_REFUSE", "NEWSROOM_GROUP_CALL_REFUSE_ALL", "NEWSROOM_REFUSED_OPTIONS_FIX", "NEWSROOM_ONE_CHART_ROUTING", "NEWSROOM_D3_PLAN_REFUSAL", "NEWSROOM_SYMBOL_MAP"];
const DEFAULT_ON = new Set(["NEWSROOM_GROUP_CALL_REFUSE", "NEWSROOM_GROUP_CALL_REFUSE_ALL", "NEWSROOM_GRAMMAR_HINT_ELIGIBLE", "NEWSROOM_REFUSED_OPTIONS_FIX", "NEWSROOM_ONE_CHART_ROUTING", "NEWSROOM_D3_PLAN_REFUSAL", "NEWSROOM_LOCATION_EVIDENCE", "NEWSROOM_SYMBOL_MAP", "NEWSROOM_SPEED_AUTO_CHECKS", "NEWSROOM_TOOL_RESULT_IMAGES"]);
// The one place that states which exact value a switch is read against: "1" for opt-in switches, "0" for the default-on ones. The JS scan below and the
// Rust/Python scan further down both ask it, so moving a name into DEFAULT_ON flips every language's demand in the same change.
const exactValue = (name) => (DEFAULT_ON.has(name) ? "0" : "1");
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
        const exact = new RegExp(`^\\s*[!=]==\\s*["']${exactValue(name)}["']`);
        if (!exact.test(m[1])) bad.push(`${file}:${i + 1} ${name}: ${line.trim().slice(0, 140)}`);
      }
    }
  });
}
assert.deepEqual(bad, [], `switch read that is not its exact rule ("1" for opt-in switches, "0" for the default-on ones):\n${bad.join("\n")}`);
// the exemption is only sound if its read-site files exist: symbol_map_switch.mjs is imported by choropleth.mjs and infographic.mjs; newsroom.ts does NOT import it
// (that would be a cross-group call) and holds its own copy of the rule. K1199: exactly these two files read NEWSROOM_SYMBOL_MAP, and test_flip_defaults_switches.mjs
// (section D) pins their answers equal. Removing the "0" later means changing both.
{
  const SW = "runtime/pi/symbol_map_switch.mjs";
  assert.ok(existsSync(join(ROOT, SW)), `${SW} is missing: the exemption for NEWSROOM_SYMBOL_MAP has no read site`);
  for (const [f, imp] of [["runtime/pi/choropleth.mjs", /import\s*\{[^}]*\bsymbolMapOn\b[^}]*\}\s*from\s*"\.\/symbol_map_switch\.mjs"/], ["runtime/pi/infographic.mjs", /import\s*\{[^}]*\bgatedFormOn\b[^}]*\}\s*from\s*"\.\/symbol_map_switch\.mjs"/]])
    assert.ok(imp.test(readFileSync(join(ROOT, f), "utf8")), `${f} does not import the symbol map switch reader from ./symbol_map_switch.mjs`);
  const news = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.equal(/symbol_map_switch/.test(news.replace(/^\s*\/\/.*$/gm, "")), false, "newsroom.ts imports or names symbol_map_switch.mjs in code: that would be a cross-group call");
  assert.ok(news.includes('.filter(([, name]) => (name === "NEWSROOM_SYMBOL_MAP" ? process.env[name as string] !== "0" : process.env[name as string] === "1"))'), "newsroom.ts does not hold its own gated-form rule, inline in the grammar table, in the pinned form");
  assert.equal(news.split('name === "NEWSROOM_SYMBOL_MAP"').length - 1, 1, "newsroom.ts holds more than one copy of the symbol map rule");
  // a reader here is a file whose code compares a computed env key against "0" (the exact-0 rule of a default-on switch) and names NEWSROOM_SYMBOL_MAP
  const readers = files.filter((f) => { const code = readFileSync(join(DIR, f), "utf8").replace(/^\s*\/\/.*$/gm, ""); return /["']NEWSROOM_SYMBOL_MAP["']/.test(code) && /env\[[A-Za-z_]+(?: as string)?\]\s*[!=]==\s*["']0["']/.test(code); }).sort();
  for (const f of readers) assert.equal([...readFileSync(join(DIR, f), "utf8").replace(/^\s*\/\/.*$/gm, "").matchAll(/env\[[A-Za-z_]+(?: as string)?\]\s*!==\s*["']0["']/g)].length, 1, `${f}: exactly one exact-0 rule for the symbol map switch`);
  assert.deepEqual(readers, ["newsroom.ts", "symbol_map_switch.mjs"], "the files that read NEWSROOM_SYMBOL_MAP must be exactly newsroom.ts and symbol_map_switch.mjs (no third copy, none removed)");
}
// NEWSROOM_SYMBOL_MAP is read only in those two files (a constant or a computed key, not an env-property read); test_flip_defaults_switches.mjs pins them equal
for (const name of NAMES.filter((n) => n !== "NEWSROOM_SYMBOL_MAP")) assert.ok(seen[name] > 0, `no read of ${name} found: the scan is not looking at the code any more`);

// Product code outside runtime/pi/ that reads switches of its own: every Rust file under src/ and every top-level scripts/*.py that is not a test (scripts/test_* are tests and are not scanned).
// A read is an env accessor on the quoted name (Rust `std::env::var("NAME")`, Python `os.environ.get("NAME")` / `os.environ["NAME"]` / `os.getenv("NAME")`), comments excluded;
// it must be compared against the exact value of exactValue(name) (Rust `.is_ok_and(|v| v == "1")` or `.map(|v| v == "1")`; Python `== "1"`). Each file's read count is pinned,
// so a new reader (in any src file or any script) or a removed one turns the test red. A second count per file pins the raw number of quoted names
// (no comment stripping, any quote style): it catches a read the accessor pattern does not see (through a const, var_os, a default argument, or text after // or # inside a string).
// per file: [accessor reads, quoted names]; a file that is not listed must have 0 of both
const OTHER_NAMES = {}; // no switch is read outside runtime/pi/ now; a name added here pins its readers
const rustFiles = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? rustFiles(p) : f.endsWith(".rs") ? [p] : []; });
const otherFiles = [...rustFiles(join(ROOT, "src")), ...readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".py") && !f.startsWith("test_")).map((f) => join(ROOT, "scripts", f))].map((p) => p.slice(ROOT.length + 1));
// the reads of `name` in one file's text, as { line, rest } where rest is what follows the accessor (a read may continue on the next line)
const readsOf = (name, text, lang) => {
  const code = text.split("\n").map((l) => (lang === "rs" ? l.replace(/\/\/.*$/, "") : l.replace(/(^|\s)#.*$/, ""))).join("\n");
  const access = lang === "rs" ? `env::var\\(\\s*"${name}"\\s*\\)` : `(?:environ\\.get\\(\\s*["']${name}["']\\s*\\)|environ\\[\\s*["']${name}["']\\s*\\]|getenv\\(\\s*["']${name}["']\\s*\\))`;
  return [...code.matchAll(new RegExp(`${access}([^;]{0,60})`, "g"))].map((m) => ({ line: code.slice(0, m.index).split("\n").length, rest: m[1] }));
};
const exactRead = (name, rest, lang) => new RegExp(lang === "rs" ? `^\\s*\\.(?:is_ok_and|map)\\(\\|v\\|\\s*v\\s*[!=]=\\s*"${exactValue(name)}"\\s*\\)` : `^\\s*[!=]=\\s*["']${exactValue(name)}["']`).test(rest);
// the checker itself must tell the exact rule from the loose ones, in both languages
assert.equal(exactRead("NEWSROOM_GROUP_CALL_REFUSE", `.is_ok_and(|v| v == "0")`, "rs"), true);
assert.equal(exactRead("NEWSROOM_GROUP_CALL_REFUSE", `\n        .map(|v| v != "0")\n        .unwrap_or(true)`, "rs"), true);
for (const loose of [`.is_ok()`, `.is_ok_and(|v| !v.is_empty())`, `.map(|v| v == "1")`, `.is_ok_and(|v| v == "true")`]) assert.equal(exactRead("NEWSROOM_GROUP_CALL_REFUSE", loose, "rs"), false, loose);
assert.equal(exactRead("NEWSROOM_GROUP_CALL_REFUSE", ` != "0"`, "py"), true);
for (const loose of [` == "1"`, ` == "true"`, `)`, ` in ("1", "true")`]) assert.equal(exactRead("NEWSROOM_GROUP_CALL_REFUSE", loose, "py"), false, loose);
{
  const badOther = [];
  for (const [name, pinned] of Object.entries(OTHER_NAMES)) {
    for (const file of otherFiles) {
      const lang = file.endsWith(".rs") ? "rs" : "py";
      const text = readFileSync(join(ROOT, file), "utf8");
      const reads = readsOf(name, text, lang);
      const quoted = [...text.matchAll(new RegExp(`["']${name}["']`, "g"))].length;
      for (const r of reads) if (!exactRead(name, r.rest, lang)) badOther.push(`${file}:${r.line} ${name}: ${r.rest.trim().slice(0, 80)}`);
      const [pinnedReads, pinnedQuoted] = pinned[file] ?? [0, 0];
      if (reads.length !== pinnedReads) badOther.push(`${file} ${name}: ${reads.length} reads, pinned ${pinnedReads}`);
      if (quoted !== pinnedQuoted) badOther.push(`${file} ${name}: ${quoted} quoted names, pinned ${pinnedQuoted}`);
    }
  }
  assert.deepEqual(badOther, [], `Rust/Python switch read that is not its exact rule (its exact value), or a read count that moved:\n${badOther.join("\n")}`);
}

// The grammar -> chart-form table: VISUAL_GRAMMAR_FORMS stays a pure constant that holds only the always-on forms (byte-for-byte the table of a run with every
// switch off) and carries the switched forms as non-enumerable data, gatedForms. Each group filters it through gatedFormOn with the named switch.
const { VISUAL_GRAMMAR_FORMS } = await import(join(DIR, "infographic.mjs"));
const OFF_TABLE = {"rank":["horizontal_bar","dot"],"change":["dumbbell","slope"],"trend":["line","multi_line","small_multiples","streamgraph"],"anomaly":["diverging_bar","dot","small_multiples"],"benchmark":["dot","dumbbell","horizontal_bar"],"composition":["horizontal_bar","heatmap","parallel_sets","alluvial","waffle","stacked_bar_100"],"distribution":["dot","heatmap","small_multiples","strip_plot","mirrored_bar"],"relationship":["scatter","node_link","chord"],"uncertainty":["line","multi_line","small_multiples"],"flow":["sankey","alluvial","parallel_sets","geo_flow_map","cartographic_flow_map"],"spatial":["geo_flow_map","cartographic_flow_map","choropleth"],"network":["node_link","adjacency_matrix","chord"],"mechanism":["process_schematic"],"sequence":["timeline","trajectory_profile","line"]};
assert.deepEqual(Object.fromEntries(Object.entries(VISUAL_GRAMMAR_FORMS).map(([grammar, forms]) => [grammar, [...forms]])), OFF_TABLE, "the table with every switch off changed");
assert.equal(Object.keys(VISUAL_GRAMMAR_FORMS).includes("gatedForms"), false, "gatedForms must not be enumerable");
const gated = VISUAL_GRAMMAR_FORMS.gatedForms;
assert.deepEqual(JSON.parse(JSON.stringify(gated)), { composition: { people_dots: "NEWSROOM_STORY_FORMS" }, spatial: { tile_map: "NEWSROOM_TILE_MAP", symbol_map: "NEWSROOM_SYMBOL_MAP" }, sequence: { clock_dial: "NEWSROOM_STORY_FORMS" } });
for (const names of Object.values(gated)) for (const name of Object.values(names)) assert.ok(NAMES.includes(name), `${name} is not in the scanned switch names`);
// every group that filters the table by the switch name it carries does it through gatedFormOn (symbol_map_switch.mjs): exact "1" for every form, except the symbol map switch (on unless exactly "0")
// (newsroom.ts writes the rule out inline in the same filter, K1199: pinned above and by test_flip_defaults_switches.mjs section D)
for (const file of ["infographic.mjs"]) {
  const text = readFileSync(join(DIR, file), "utf8");
  assert.ok(/\.filter\(\(\[, name\]\) => gatedFormOn\(name(?: as string)?, process\.env\)\)/.test(text), `${file}: the gated-form filter does not go through gatedFormOn`);
  assert.equal([...text.matchAll(/process\.env\[name(?: as string)?\]/g)].length, 0, `${file}: a gated-form filter reads the environment itself`);
}
const { gatedFormOn } = await import(join(DIR, "symbol_map_switch.mjs"));
// with the switches on, the filter the groups use yields the forms the table had before they moved out (people_dots, tile_map, clock_dial)
const active = (env) => Object.fromEntries(Object.entries(VISUAL_GRAMMAR_FORMS).map(([grammar, forms]) => [grammar, [...forms, ...Object.entries(gated[grammar] ?? {}).filter(([, name]) => gatedFormOn(name, env)).map(([form]) => form)]]));
assert.deepEqual(active({}).spatial, [...OFF_TABLE.spatial, "symbol_map"], "unset: symbol_map is on, nothing else is");
assert.deepEqual({ ...active({}), spatial: OFF_TABLE.spatial }, OFF_TABLE, "unset: only the symbol map joins the table");
assert.deepEqual(active({ NEWSROOM_SYMBOL_MAP: "0" }), OFF_TABLE, "exactly 0 gives the table with every switch off");
assert.deepEqual(active({ NEWSROOM_STORY_FORMS: "1" }).composition.slice(-1), ["people_dots"]);
assert.deepEqual(active({ NEWSROOM_STORY_FORMS: "1" }).sequence.slice(-1), ["clock_dial"]);
assert.deepEqual(active({ NEWSROOM_SYMBOL_MAP: "0", NEWSROOM_TILE_MAP: "1" }).spatial.slice(-1), ["tile_map"]);
assert.deepEqual(active({ NEWSROOM_TILE_MAP: "1" }).spatial.slice(-2), ["tile_map", "symbol_map"], "tile_map on and the symbol map on by default");
assert.deepEqual(active({ NEWSROOM_SYMBOL_MAP: "1" }).spatial.slice(-1), ["symbol_map"]);
assert.deepEqual(active({ NEWSROOM_SYMBOL_MAP: "0", NEWSROOM_STORY_FORMS: "true", NEWSROOM_TILE_MAP: "yes" }), OFF_TABLE);
console.log(`test_switch_read_sites: ok (${Object.entries(seen).map(([n, c]) => `${n.replace("NEWSROOM_", "")}=${c}`).join(" ")})`);
