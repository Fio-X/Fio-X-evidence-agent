// The illustration strip child (runtime/leaves_js/illus_strip.cjs): a piece set's strip is the same for the same seed, one
// group per piece, each with its accent stroke, every stroke in the two colour names asked, no text; the child refuses a
// width, colour or knob off its range, naming the range and an example; one line in, one line out over stdin.
//
// Run: node scripts/test_illus_strip.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CHILD = fileURLToPath(new URL("../runtime/leaves_js/illus_strip.cjs", import.meta.url));
const { strip } = require(CHILD);
const set = JSON.parse(readFileSync(new URL("../runtime/leaves_js/pieces-energy.json", import.meta.url), "utf8"));
const ask = (o = {}) => ({ set, width: 1140, ink: "var(--t-title)", accent: "var(--accent)", knobs: {}, ...o });

const a = strip(ask()), b = strip(ask());
assert.equal(a.refused, undefined, JSON.stringify(a.refused));
assert.equal(a.svg, b.svg, "the same seed draws the same strip");
assert.notEqual(strip(ask({ knobs: { seed: 12 } })).svg, a.svg, "another seed draws another strip");
assert.deepEqual([a.w, a.h], [1140, 225]);
assert.deepEqual(Object.keys(a.kept), ["turbine", "solar", "dam", "biomass"]);
const groups = a.svg.split("<g transform=").slice(1);
assert.equal(groups.length, 4, "one group per piece");
for (const g of groups) assert.ok(g.slice(0, g.indexOf("</g>")).includes('stroke="var(--accent)"'), "each piece has its accent");
const strokes = new Set([...a.svg.matchAll(/stroke="([^"]*)"/g)].map((m) => m[1]));
assert.deepEqual([...strokes].sort(), ["var(--accent)", "var(--t-title)"]);
assert.ok(!/<text|<rect|<circle|fill="(?!none)/.test(a.svg), "strokes only, no text");
assert.ok(a.dropped.every((d) => /^(turbine|solar|dam|biomass): a \w+ [\d.]+ px$/.test(d)), a.dropped.join("; "));
assert.ok(strip(ask({ knobs: { marker: 0 } })).svg.length < a.svg.length, "no marker draws less");

const refused = (o) => strip(ask(o)).refused || [];
assert.deepEqual(refused({ width: 300 }), ["width: 300 is not a whole number on 600..2000; e.g. 1140"]);
assert.deepEqual(refused({ accent: "#D0021B" }), ['accent: "#D0021B" is no page colour name; e.g. var(--accent)']);
assert.deepEqual(refused({ knobs: { roughness: 2 } }), ["knob roughness: 2 is not on 0.4..1 step 0.05; e.g. 0.6"]);
assert.deepEqual(refused({ knobs: { pen: 1 } }), ["knob pen: the set energy has no such knob; e.g. height"]);
assert.deepEqual(refused({ knobs: { baseline: 100 } }), ["knob baseline: 100 is not within 0.6..0.9 of the height 225"]);
assert.deepEqual(refused({ set: { ...set, module: "../x.cjs" } }), ['set: "../x.cjs" is no piece module; e.g. pieces-energy.cjs']);
assert.deepEqual(refused({ set: { ...set, pieces: [{ name: "kiln", cell: 1 }] } }), ["piece kiln: pieces-energy.cjs draws no such piece; e.g. turbine"]);

const run = spawnSync(process.execPath, [CHILD], { input: JSON.stringify(ask()) + "\nnot json\n", encoding: "utf8", env: {} });
const lines = run.stdout.trim().split("\n").map((l) => JSON.parse(l));
assert.equal(lines.length, 2);
assert.equal(lines[0].svg, a.svg, "the child over stdin draws the same strip");
assert.match(lines[1].refused[0], /^strip: /);
console.log("test_illus_strip: ok");
