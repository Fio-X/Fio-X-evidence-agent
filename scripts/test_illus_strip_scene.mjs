// The page-bottom strip of the people topic (runtime/leaves_js/illus_strip.cjs sceneStrip): the people set draws the people
// library's crowd with the ink skin (the topic's style in node.json topics.scenes), as wide as asked and as high as the height
// knob, no text and no fill, strokes only in the two colour names asked (the rules of src/next_leaf.rs strip_faults, mirrored
// here), nobody lit, the same for the same request; each figure is its own group, every two at least 6 px apart, and no figure
// stroke reaches under the ground line. The sets of other topics (energy; economy, whose trade topic is drawn in another style)
// and a request with a family or a count keep the old piece strip, byte for byte (the hashes are the base strip's outputs).
//
// Run: node scripts/test_illus_strip_scene.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CHILD = fileURLToPath(new URL("../runtime/leaves_js/illus_strip.cjs", import.meta.url));
const { strip, sceneStyle } = require(CHILD);
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

const points = (d) => { // the absolute points of a path written as absolute M then relative l
  const out = [];
  for (const sub of d.split("M").slice(1)) {
    const [head, tail = ""] = sub.replace(/Z/g, "").split("l"), num = (t) => (t.match(/-?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
    let [x, y] = num(head); const rel = num(tail); out.push([x, y]);
    for (let i = 0; i + 1 < rel.length; i += 2) { x += rel[i]; y += rel[i + 1]; out.push([x, y]); }
  }
  return out;
};

// the topic and its style come from the existing data: the module's strip_topics and node.json topics.scenes; only ink draws
assert.deepEqual(sceneStyle(setOf("people")), { topic: "people", style: node.topics.scenes.people.style });
assert.equal(node.topics.scenes.people.style, "ink");
assert.equal(sceneStyle(setOf("economy")), null, "the trade topic is drawn in another style: its pieces");
assert.equal(sceneStyle(setOf("energy")), null, "the energy topic is not drawn by the scene renderer");

const check = (r, label, W = 1140, H = 225, YG = 184) => {
  assert.equal(r.refused, undefined, `${label}: ${JSON.stringify(r.refused)}`);
  assert.deepEqual([r.w, r.h, r.style], [W, H, "ink"], label);
  assert.deepEqual(faults(r.svg, COLOURS), [], label);
  assert.ok(!/<text|<rect|<circle|<image|<use|<filter|<defs|<clipPath|<mask|fill="(?!none)|opacity|#[0-9a-f]{3,6}/i.test(r.svg), `${label}: text, fill, opacity or a colour of its own`);
  assert.equal(r.lit, 0, `${label}: nobody is lit`);
  for (const c of COLOURS) assert.ok(r.svg.includes(`stroke="${c}"`), `${label}: both pens are used: ${c}`);
  // one group per figure inside the strip's group, then the ground line
  const inner = r.svg.slice(3, r.svg.lastIndexOf("<path")), ground = r.svg.slice(r.svg.lastIndexOf("<path"));
  const figs = inner.split("<g>").slice(1).map((g) => [...g.matchAll(/ d="([^"]*)"/g)].flatMap((m) => points(m[1])));
  assert.equal(figs.length, r.figures, label);
  assert.ok(r.figures >= 8 && r.figures <= 30, `${label}: ${r.figures} figures`);
  const boxes = figs.map((p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]);
  for (const b of boxes) assert.ok(b[0] >= 0 && b[2] <= W && b[1] >= 0, `${label}: a figure out of the strip ${b}`);
  // nothing of a figure under the ground line (the d writer rounds to a tenth)
  for (const b of boxes) assert.ok(b[3] <= YG + 0.051, `${label}: a figure reaches ${b[3]} under the ground at ${YG}`);
  // the figures stand apart: every two neighbours' boxes at least 6 px
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] - boxes[i - 1][2] >= 6, `${label}: figures ${i - 1} and ${i} are ${boxes[i][0] - boxes[i - 1][2]} px apart`);
  // the row spans the strip
  assert.ok(boxes[0][0] < 12 && boxes[boxes.length - 1][2] > W - 12, `${label}: the row spans ${boxes[0][0]}..${boxes[boxes.length - 1][2]}`);
  assert.ok(points(ground.match(/ d="([^"]*)"/)[1]).every(([, y]) => Math.abs(y - YG - 1) < 1), `${label}: the ground line`);
};

const people = strip(ask(setOf("people")));
assert.equal(people.topic, "people");
check(people, "people");
assert.equal(strip(ask(setOf("people"))).svg, people.svg, "the same request, the same strip");
assert.notEqual(strip(ask(setOf("people"), { knobs: { seed: 12 } })).svg, people.svg, "another seed, another crowd");
for (const seed of [1, 12, 77, 4242]) check(strip(ask(setOf("people"), { knobs: { seed } })), `people seed ${seed}`);
check(strip(ask(setOf("people"), { width: 800, knobs: { height: 160, baseline: 130 } })), "people 800x160", 800, 160, 130);
check(strip(ask(setOf("people"), { width: 2000 })), "people 2000", 2000);

// the other sets, and a family request: the old piece strip byte for byte
const sha = (t) => createHash("sha256").update(t).digest("hex");
const energy = strip(ask(setOf("energy"))), economy = strip(ask(setOf("economy")));
assert.equal(sha(energy.svg), "b6709f4cf6e976aa43f2645f0d8a56ee78dbc0c0868caadb05d23ade6ec881ff", "the energy strip as before");
assert.equal(sha(economy.svg), "5b05706c22db61a022adbe7f66b1b8cde4d94f982093f13a44b45bbb2a95e9f0", "the economy strip as before");
assert.equal(energy.style, undefined);
assert.equal(economy.style, undefined);
assert.equal(strip(ask(setOf("people"), { family: "pop65", count: 27 })).style, undefined, "a family request keeps strip_topics' pieces");
// pieces no topic lists: the pieces
const off = strip(ask({ ...setOf("people"), pieces: [{ name: "crowd", cell: 300, pad_l: 0 }, { name: "cairn", cell: 300, pad_l: 0 }] }));
assert.equal(off.style, undefined);
assert.ok(off.svg.startsWith("<g transform="));

// over stdin, with no environment, the child draws the same crowd
const run = spawnSync(process.execPath, [CHILD], { input: JSON.stringify(ask(setOf("people"))) + "\n", encoding: "utf8", env: {} });
assert.equal(JSON.parse(run.stdout.trim()).svg, people.svg, run.stderr);
console.log(`test_illus_strip_scene: ok (people ink: ${people.figures} figures, ${people.svg.length} svg bytes)`);
