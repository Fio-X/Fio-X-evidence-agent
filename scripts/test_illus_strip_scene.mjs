// The page-bottom strip of a scene-renderer topic (runtime/leaves_js/illus_strip.cjs sceneStrip): the people set draws the
// people library's crowd in the ink style, the economy set in the geo style (the topic's style in node.json topics.scenes),
// and the iso skin (the tech topic's, a topic no set names yet) draws through the same path. Each strip is as wide as asked
// and as high as the height knob, holds no text and no fill, strokes only in the two colour names asked (the same rules as
// src/next_leaf.rs strip_faults, mirrored here), lights nobody, and is the same for the same request; a set of a topic the
// scene renderer does not draw (energy) and a request with a family or a count keep the old piece strip byte for byte.
//
// Run: node scripts/test_illus_strip_scene.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CHILD = fileURLToPath(new URL("../runtime/leaves_js/illus_strip.cjs", import.meta.url));
const { strip, sceneStyle, sceneStrip } = require(CHILD);
const setOf = (n) => JSON.parse(readFileSync(new URL(`../runtime/leaves_js/pieces-${n}.json`, import.meta.url), "utf8"));
const node = JSON.parse(readFileSync(new URL("../runtime/illus_hero/node.json", import.meta.url), "utf8"));
const COLOURS = ["var(--t-title)", "var(--t-sec)"];
const ask = (set, o = {}) => ({ set, width: 1140, ink: COLOURS[0], accent: COLOURS[1], knobs: {}, ...o });

// strip_faults (src/next_leaf.rs), mirrored: <g> with a transform at most, <path/> with d, a stroke of the colours, a width,
// fill none, round caps and joins, a transform; nothing between the tags.
function faults(svg, colours) {
  const off = [];
  let depth = 0;
  const transform = (v) => /^translate\(-?[\d.e-]+,-?[\d.e-]+\)( scale\(-?[\d.e-]+\))?$/.test(v);
  for (const m of svg.matchAll(/([^<]*)<([^>]*)>/g)) {
    if (m[1].trim()) off.push(`text ${m[1].slice(0, 40)}`);
    const tag = m[2];
    if (tag === "/g") { if (!depth--) off.push("unbalanced </g>"); continue; }
    const closed = tag.endsWith("/"), t = closed ? tag.slice(0, -1) : tag, name = t.split(" ")[0];
    const allowed = name === "g" && !closed ? ["transform"] : name === "path" && closed ? ["d", "stroke", "stroke-width", "fill", "stroke-linecap", "stroke-linejoin", "transform"] : null;
    if (!allowed) { off.push(`element <${name}>`); continue; }
    let rest = t.slice(name.length).trim();
    while (rest) {
      const a = rest.match(/^([a-z-]+)="([^"]*)"\s*/);
      if (!a) { off.push(`attribute ${rest.slice(0, 40)}`); break; }
      const [, key, value] = a;
      const ok = allowed.includes(key) && ({ d: () => /^[0-9 ,.\-eEMCLQTZmclqtz]*$/.test(value), stroke: () => colours.includes(value),
        "stroke-width": () => Number(value) > 0 && Number.isFinite(Number(value)), fill: () => value === "none",
        "stroke-linecap": () => value === "round", "stroke-linejoin": () => value === "round", transform: () => transform(value) }[key] || (() => false))();
      if (!ok) off.push(`<${name} ${key}="${value.slice(0, 30)}">`);
      rest = rest.slice(a[0].length);
    }
    if (name === "path" && !t.includes(' stroke="')) off.push("a path without a stroke");
    if (name === "g") depth++;
  }
  if (depth) off.push(`${depth} group(s) open`);
  return off;
}

// the topic and its style come from the existing data: the module's strip_topics and node.json topics.scenes
assert.deepEqual(sceneStyle(setOf("people")), { topic: "people", style: node.topics.scenes.people.style });
assert.deepEqual(sceneStyle(setOf("economy")), { topic: "trade", style: node.topics.scenes.trade.style });
assert.equal(sceneStyle(setOf("energy")), null, "the energy topic is not drawn by the scene renderer");
assert.deepEqual(["people", "trade", "tech"].map((t) => node.topics.scenes[t].style), ["ink", "geo", "iso"]);
assert.equal(node.topics.scenes.tech.renderer, "scene");

const check = (r, label, W = 1140, H = 225) => {
  assert.equal(r.refused, undefined, `${label}: ${JSON.stringify(r.refused)}`);
  if (r.w !== undefined) assert.deepEqual([r.w, r.h], [W, H], label);
  assert.deepEqual(faults(r.svg, COLOURS), [], label);
  assert.ok(!/<text|<rect|<circle|<image|<use|<filter|<defs|<clipPath|<mask|fill="(?!none)|opacity|#[0-9a-f]{3,6}/i.test(r.svg), `${label}: text, fill, opacity or a colour of its own`);
  assert.equal(r.lit, 0, `${label}: nobody is lit`);
  assert.ok(r.figures >= 8 && r.figures <= 30, `${label}: ${r.figures} figures`);
  // every coordinate the strip draws stays near its box (the d writer: absolute M, then relative l)
  for (const m of r.svg.matchAll(/ d="([^"]*)"/g)) for (const sub of m[1].split("M").slice(1)) {
    const [head, tail = ""] = sub.replace(/Z/g, "").split("l");
    const num = (s) => s.match(/-?(?:\d+\.?\d*|\.\d+)/g) || [];
    let [x, y] = num(head).map(Number); const rel = num(tail).map(Number);
    for (let i = 0; i <= rel.length; i += 2) { assert.ok(x > -20 && x < W + 20 && y > -20 && y < H + 20, `${label}: a point at ${x},${y}`); x += rel[i] || 0; y += rel[i + 1] || 0; }
  }
};

// people (ink) and trade (geo) through the page's own request; tech (iso) through the same drawing, as no set names it yet
const people = strip(ask(setOf("people"))), trade = strip(ask(setOf("economy")));
assert.deepEqual([people.topic, people.style, trade.topic, trade.style], ["people", "ink", "trade", "geo"]);
check(people, "people");
check(trade, "trade");
const tech = sceneStrip("iso", 1140, 225, 184, 11, { ink: COLOURS[0], second: COLOURS[1] });
check(tech, "tech");
for (const r of [people, trade, tech]) for (const c of COLOURS) assert.ok(r.svg.includes(`stroke="${c}"`), `both pens are used: ${c}`);
assert.equal(new Set([people.svg, trade.svg, tech.svg]).size, 3, "three styles, three strips");

// the same request, the same strip; another seed, another crowd; the height and baseline knobs hold
assert.equal(strip(ask(setOf("people"))).svg, people.svg);
assert.equal(strip(ask(setOf("economy"))).svg, trade.svg);
assert.equal(sceneStrip("iso", 1140, 225, 184, 11, { ink: COLOURS[0], second: COLOURS[1] }).svg, tech.svg);
assert.notEqual(strip(ask(setOf("people"), { knobs: { seed: 12 } })).svg, people.svg);
check(strip(ask(setOf("people"), { width: 800, knobs: { height: 160, baseline: 130 } })), "people 800x160", 800, 160);
check(strip(ask(setOf("economy"), { width: 2000 })), "trade 2000", 2000, 225);

// no scene topic, or a family or a count asked: the old piece strip, byte for byte
const energy = setOf("energy");
const plain = strip(ask(energy));
assert.equal(plain.style, undefined);
assert.deepEqual(Object.keys(plain.kept), ["turbine", "solar", "dam", "biomass"]);
assert.ok(plain.svg.startsWith("<g transform="), "the energy set keeps its rough.js pieces");
assert.equal(strip(ask(setOf("people"), { family: "pop65", count: 27 })).style, undefined, "a family request keeps strip_topics' pieces");
// the scene path off (the people set renamed to pieces no topic lists) draws what the pieces drew before
const off = strip(ask({ ...setOf("people"), pieces: [{ name: "crowd", cell: 300, pad_l: 0 }, { name: "cairn", cell: 300, pad_l: 0 }] }));
assert.equal(off.style, undefined);
assert.ok(off.svg.startsWith("<g transform="));

// over stdin, with no environment, the child draws the same crowd
const run = spawnSync(process.execPath, [CHILD], { input: JSON.stringify(ask(setOf("people"))) + "\n", encoding: "utf8", env: {} });
assert.equal(JSON.parse(run.stdout.trim()).svg, people.svg, run.stderr);
console.log(`test_illus_strip_scene: ok (svg bytes: people ink ${people.svg.length}, trade geo ${trade.svg.length}, tech iso ${tech.svg.length})`);
