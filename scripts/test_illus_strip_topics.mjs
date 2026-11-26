// The page-bottom strip follows the page's topic and data (runtime/leaves_js/illus_strip.cjs, pieces-energy.json strip_topics): the measure
// family id (never question text) picks the topic's piece list, an unknown family the neutral list, the member count sets how many pieces
// stand and which leads and the pen's seed; a request with neither draws the set's own four pieces as before; a count off 1..200 refuses.
//
// Run: node scripts/test_illus_strip_topics.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { strip } = require(fileURLToPath(new URL("../runtime/leaves_js/illus_strip.cjs", import.meta.url)));
const lib = require(fileURLToPath(new URL("../runtime/leaves_js/pieces-energy.cjs", import.meta.url)));
const set = JSON.parse(readFileSync(new URL("../runtime/leaves_js/pieces-energy.json", import.meta.url), "utf8"));
const node = JSON.parse(readFileSync(new URL("../runtime/illus_hero/node.json", import.meta.url), "utf8"));
const fams = JSON.parse(readFileSync(new URL("../runtime/pi/assets/measure-families.json", import.meta.url), "utf8")).families;
const ask = (o = {}) => ({ set, width: 1140, ink: "var(--t-title)", accent: "var(--accent)", knobs: {}, ...o });
const T = set.strip_topics;

// the family map is the hero's, and covers every measure family there is
// a collage topic's strip is its renderer_else_topic's (labour, the unemployment family: the people strip)
const routed = Object.fromEntries(Object.entries(node.topics.families).map(([f, t]) => [f, node.topics.scenes[t].renderer === "collage" ? node.topics.scenes[t].renderer_else_topic : t]));
assert.deepEqual(T.families, routed);
assert.deepEqual(fams.map((f) => f.id).filter((id) => !(id in T.families)), []);
assert.equal(T.neutral, node.topics.neutral);
for (const [topic, list] of Object.entries(T.pieces)) for (const p of list) assert.equal(typeof lib[p.name], "function", `${topic}: ${p.name} is not a piece`);
assert.deepEqual(T.pieces.energy, set.pieces, "the energy topic is the set's own pieces");

// no family and no count: exactly the old strip
const base = strip(ask());
assert.equal(base.topic, undefined);
assert.deepEqual(Object.keys(base.kept), ["turbine", "solar", "dam", "biomass"]);

// each topic draws its own pieces; the first piece of each is not the energy turbine
const piecesOf = (family, count) => { const r = strip(ask({ family, count })); assert.equal(r.refused, undefined, JSON.stringify(r.refused)); return r; };
const by = Object.fromEntries(["renewable_share", "co2", "pop65", "energy_imports", "asylum", "nothing_like_it"].map((f) => [f, piecesOf(f, 27)]));
assert.deepEqual(Object.values(by).map((r) => r.topic), ["energy", "emissions", "people", "trade", "migration", "neutral"]);
assert.equal(new Set(Object.values(by).map((r) => r.svg)).size, 6, "six topics, six strips");
assert.ok(by.co2.pieces.every((n) => ["stack", "cloud", "forest"].includes(n)), by.co2.pieces.join());
assert.ok(by.pop65.pieces.every((n) => ["crowd", "ages"].includes(n)));
assert.ok(by.energy_imports.pieces.every((n) => ["containers", "crane", "coins"].includes(n)));
assert.ok(by.asylum.pieces.every((n) => ["signpost", "route", "fence"].includes(n)));
assert.deepEqual(by.nothing_like_it.pieces, ["cairn", "cairn", "cairn"], "an unknown family is the neutral strip");

// every piece of every topic is strokes only and carries its accent
for (const [topic, list] of Object.entries(T.pieces)) {
  const r = strip(ask({ family: Object.keys(T.families).find((f) => T.families[f] === topic), count: 60 }));
  assert.ok(!/<text|<rect|<circle|fill="(?!none)/.test(r.svg), topic);
  const groups = r.svg.split("<g transform=").slice(1);
  assert.equal(groups.length, r.pieces.length, topic);
  for (const g of groups) assert.ok(g.slice(0, g.indexOf("</g>")).includes('stroke="var(--accent)"'), `${topic}: a piece without its accent`);
  assert.deepEqual([...new Set([...r.svg.matchAll(/stroke="([^"]*)"/g)].map((m) => m[1]))].sort(), ["var(--accent)", "var(--t-title)"], topic);
}

// the member count sets how many pieces stand, and the rest of the strip with it
assert.equal(piecesOf("energy_imports", 6).pieces.length, 3, "few members: the least");
assert.equal(piecesOf("energy_imports", 27).pieces.length, 4, "27 members: about one a 6, at most the list");
assert.equal(piecesOf("co2", 27).pieces.length, 3);
assert.notEqual(piecesOf("energy_imports", 20).svg, piecesOf("energy_imports", 21).svg, "another count, another strip");
assert.notDeepEqual(piecesOf("energy_imports", 20).pieces, piecesOf("energy_imports", 21).pieces, "the lead piece turns with the count");
assert.equal(piecesOf("energy_imports", 27).svg, piecesOf("energy_imports", 27).svg, "the same data, the same strip");
assert.equal(piecesOf("renewable_share", 6).pieces.length, 3);

// a family or a count that is none refuses in words with an example
const refused = (o) => strip(ask(o)).refused || [];
assert.deepEqual(refused({ family: "co2", count: 0 }), ["count: 0 is not a whole number on 1..200; e.g. 27"]);
assert.deepEqual(refused({ family: "co2", count: 2.5 }), ["count: 2.5 is not a whole number on 1..200; e.g. 27"]);
assert.deepEqual(refused({ family: 7, count: 5 }), ['family: 7 is no measure family id; e.g. renewable_share']);
assert.ok(refused({ family: "co2", set: { ...set, strip_topics: undefined } })[0].includes("no strip_topics"));
console.log("test_illus_strip_topics: ok");
