// The page-bottom strip of a scene-renderer topic (runtime/leaves_js/illus_strip.cjs sceneStrip): the people set draws the
// people library's crowd with the ink skin as line art (strokes only, no fill), the economy set (the trade topic) with the geo
// skin and the tech topic (no set names it yet) with the iso skin as flat shapes, each filled only with a page theme colour by
// name (FILLS, the same four as src/next_leaf.rs STRIP_FILLS) and outlined in one of the two pens; the topic's style is
// node.json topics.scenes'. Each strip passes the rules of strip_faults (mirrored here), lights nobody, is the same for the
// same request; each figure is its own group, every two at least 8 px apart, and nothing reaches under the ground line. The
// energy set, a request with a family or a count, and the economy set's pieces keep the old piece strip, byte for byte (the
// hashes are the base strip's outputs), as does the people ink strip.
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
const { strip, sceneStyle, sceneStrip, FILLS } = require(CHILD);
const setOf = (n) => JSON.parse(readFileSync(new URL(`../runtime/leaves_js/pieces-${n}.json`, import.meta.url), "utf8"));
const node = JSON.parse(readFileSync(new URL("../runtime/illus_hero/node.json", import.meta.url), "utf8"));
const COLOURS = ["var(--t-title)", "var(--t-sec)"];
const ask = (set, o = {}) => ({ set, width: 1140, ink: COLOURS[0], accent: COLOURS[1], knobs: {}, ...o });

// the fills a strip may use: the same four names in the child and in the core's check, and no more
const rust = readFileSync(new URL("../src/next_leaf.rs", import.meta.url), "utf8");
const STRIP_FILLS = JSON.parse(rust.match(/pub const STRIP_FILLS: &\[&str\] = &(\[[^\]]*\]);/)[1]);
assert.deepEqual(FILLS, ["--bg", "--bar", "--t-sec", "--t-title"], "the child's fill list");
assert.deepEqual(STRIP_FILLS, FILLS, "the core's STRIP_FILLS and the child's FILLS");

// strip_faults (src/next_leaf.rs), mirrored: <g> with a transform at most, <path/> with d, a stroke of the colours, a width,
// a fill that is none or var(--name) of STRIP_FILLS, round caps and joins, a transform, the stroke and the fill named;
// nothing between the tags.
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
        "stroke-width": () => Number(value) > 0 && Number.isFinite(Number(value)), fill: () => value === "none" || STRIP_FILLS.some((t) => value === `var(${t})`),
        "stroke-linecap": () => value === "round", "stroke-linejoin": () => value === "round", transform: () => transform(value) }[key] || (() => false))();
      if (!ok) off.push(`<${name} ${key}="${value.slice(0, 30)}">`);
      rest = rest.slice(a[0].length);
    }
    if (name === "path" && !t.includes(' stroke="')) off.push("a path without a stroke");
    if (name === "path" && !t.includes(' fill="')) off.push("a path without a fill");
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

// the mirror refuses what the core refuses: another colour, a link, an opacity, a filter, a style, an unnamed fill
const P = (attrs) => `<path d="M0 1l2 3" stroke="var(--t-title)" stroke-width="1" ${attrs}/>`;
for (const f of ["var(--bg)", "var(--bar)", "var(--t-sec)", "var(--t-title)", "none"]) assert.deepEqual(faults(P(`fill="${f}"`), COLOURS), [], f);
for (const bad of ['fill="#c93f2b"', 'fill="red"', 'fill="url(#x)"', 'fill="var(--not-a-token)"', 'fill="var(--accent)"', 'fill="var(--bg)" fill-opacity="0.5"',
  'fill="var(--bg)" opacity="0.5"', 'fill="var(--bg)" filter="url(#f)"', 'fill="none" style="fill:red"', ""]) assert.notDeepEqual(faults(P(bad), COLOURS), [], bad);

// the topic and its style come from the existing data: the module's strip_topics and node.json topics.scenes
assert.deepEqual(["people", "trade", "tech"].map((t) => [node.topics.scenes[t].renderer, node.topics.scenes[t].style]), [["scene", "ink"], ["scene", "geo"], ["scene", "iso"]]);
assert.deepEqual(sceneStyle(setOf("people")), { topic: "people", style: "ink" });
assert.deepEqual(sceneStyle(setOf("economy")), { topic: "trade", style: "geo" });
assert.equal(sceneStyle(setOf("energy")), null, "the energy topic is not drawn by the scene renderer");
// tech: its opening picture is iso, its page-bottom strip is geo (data: topics.scenes.tech.strip_style), as the iso strip's feet
// float at the strip's size; a set naming the tech topic (none does yet: the economy set's pieces stand in) draws the geo strip
assert.equal(node.topics.scenes.tech.style, "iso", "the opening picture of tech stays iso");
assert.equal(node.topics.scenes.tech.strip_style, "geo");
for (const t of ["people", "trade"]) assert.equal(node.topics.scenes[t].strip_style, undefined, `${t} has no separate strip style`);
const techSet = (() => { const e = setOf("economy"); return { ...e, strip_topics: { ...e.strip_topics, pieces: { tech: e.pieces } } }; })();
assert.deepEqual(sceneStyle(techSet), { topic: "tech", style: "geo" });

const check = (r, label, style, W = 1140, H = 225, YG = 184) => {
  assert.equal(r.refused, undefined, `${label}: ${JSON.stringify(r.refused)}`);
  if (r.w !== undefined) assert.deepEqual([r.w, r.h, r.style], [W, H, style], label);
  assert.deepEqual(faults(r.svg, COLOURS), [], label);
  assert.ok(!/<text|<rect|<circle|<image|<use|<filter|<defs|<clipPath|<mask|opacity|style=|url\(|#[0-9a-f]{3,6}/i.test(r.svg), `${label}: text, opacity, a link or a colour of its own`);
  const fills = new Set([...r.svg.matchAll(/ fill="([^"]*)"/g)].map((m) => m[1]));
  if (style === "ink") assert.deepEqual([...fills], ["none"], `${label}: the ink strip fills nothing`);
  else {
    for (const f of fills) assert.ok(f === "none" || FILLS.some((t) => f === `var(${t})`), `${label}: fill ${f}`);
    assert.ok(fills.has("var(--t-title)") && fills.has("var(--bg)"), `${label}: the figures are filled in the ink, with paper details: ${[...fills]}`);
  }
  assert.equal(r.lit, 0, `${label}: nobody is lit`);
  for (const c of COLOURS) assert.ok(r.svg.includes(`stroke="${c}"`), `${label}: both pens are used: ${c}`);
  // one group per figure inside the strip's group, then the ground line
  const inner = r.svg.slice(3, r.svg.lastIndexOf("<path")), ground = r.svg.slice(r.svg.lastIndexOf("<path"));
  const figs = inner.split("<g>").slice(1).map((g) => [...g.matchAll(/ d="([^"]*)"/g)].flatMap((m) => points(m[1])));
  assert.equal(figs.length, r.figures, label);
  assert.ok(r.figures >= 8 && r.figures <= 30, `${label}: ${r.figures} figures`);
  const boxes = figs.map((p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))]);
  for (const b of boxes) assert.ok(b[0] >= 0 && b[2] <= W && b[1] >= 0, `${label}: a figure out of the strip ${b}`);
  // nothing of a figure under the ground line (the d writer rounds to a tenth), and every figure stands on it
  for (const b of boxes) assert.ok(b[3] <= YG + 0.051, `${label}: a figure reaches ${b[3]} under the ground at ${YG}`);
  for (const b of boxes) assert.ok(b[3] >= YG - 1, `${label}: a figure floats, its lowest point ${b[3]} above the ground at ${YG}`);
  // the figures stand apart: every two neighbours' boxes at least 8 px (GAP_MIN; the d writer rounds each end to a tenth)
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] - boxes[i - 1][2] >= 8 - 0.1 - 1e-9, `${label}: figures ${i - 1} and ${i} are ${boxes[i][0] - boxes[i - 1][2]} px apart`);
  // the row spans the strip
  assert.ok(boxes[0][0] < 12 && boxes[boxes.length - 1][2] > W - 12, `${label}: the row spans ${boxes[0][0]}..${boxes[boxes.length - 1][2]}`);
  assert.ok(points(ground.match(/ d="([^"]*)"/)[1]).every(([, y]) => Math.abs(y - YG - 1) < 1), `${label}: the ground line`);
};

const sha = (t) => createHash("sha256").update(t).digest("hex");
const people = strip(ask(setOf("people")));
assert.equal(people.topic, "people");
check(people, "people", "ink");
assert.equal(sha(people.svg), "62dfcd83f0ecac13774987755812cf3e0ec4f29c6e03fcb998b771b3ba11b89d", "the people ink strip as before");
assert.equal(strip(ask(setOf("people"))).svg, people.svg, "the same request, the same strip");
assert.notEqual(strip(ask(setOf("people"), { knobs: { seed: 12 } })).svg, people.svg, "another seed, another crowd");
for (const seed of [1, 12, 77, 4242]) check(strip(ask(setOf("people"), { knobs: { seed } })), `people seed ${seed}`, "ink");
check(strip(ask(setOf("people"), { width: 800, knobs: { height: 160, baseline: 130 } })), "people 800x160", "ink", 800, 160, 130);
check(strip(ask(setOf("people"), { width: 2000 })), "people 2000", "ink", 2000);

// trade (geo) through the page's own request; tech (iso) through the same drawing, as no set names it yet
const pens = { ink: COLOURS[0], second: COLOURS[1] };
const trade = strip(ask(setOf("economy")));
assert.equal(trade.topic, "trade");
check(trade, "trade", "geo");
assert.equal(strip(ask(setOf("economy"))).svg, trade.svg, "the same request, the same strip");
for (const seed of [1, 12, 77, 4242]) check(strip(ask(setOf("economy"), { knobs: { seed } })), `trade seed ${seed}`, "geo");
check(strip(ask(setOf("economy"), { width: 800, knobs: { height: 160, baseline: 130 } })), "trade 800x160", "geo", 800, 160, 130);
check(strip(ask(setOf("economy"), { width: 2000 })), "trade 2000", "geo", 2000);
const seed0 = setOf("economy").knobs.find((k) => k.name === "seed").default;
// a tech-named set through the page's own request: the geo strip, the same figures as the trade strip (same style, same seed)
const techPage = strip(ask(techSet));
assert.equal(techPage.topic, "tech");
check(techPage, "tech page strip", "geo");
assert.equal(techPage.svg, trade.svg, "tech's strip is the geo strip, not the iso one");
const tech = sceneStrip("iso", 1140, 225, 184, seed0, pens);
check(tech, "tech", "iso");
for (const seed of [1, 12, 77, 4242]) check(sceneStrip("iso", 1140, 225, 184, seed, pens), `tech seed ${seed}`, "iso");
check(sceneStrip("iso", 800, 160, 130, seed0, pens), "tech 800x160", "iso", 800, 160, 130);
assert.equal(sceneStrip("iso", 1140, 225, 184, seed0, pens).svg, tech.svg);
assert.ok(new Set([...tech.svg.matchAll(/ fill="([^"]*)"/g)].map((m) => m[1])).has("var(--bar)"), "the iso skin's light parts are the light grey");
assert.equal(new Set([people.svg, trade.svg, tech.svg]).size, 3, "three styles, three strips");
// a pen that is no theme fill: the flat styles are not drawn (the caller keeps the pieces), the ink style still is
assert.equal(sceneStrip("geo", 1140, 225, 184, seed0, { ink: "var(--t-title)", second: "var(--accent)" }), null);
assert.equal(sceneStrip("iso", 1140, 225, 184, seed0, { ink: "var(--t-dark)", second: "var(--t-sec)" }), null);
const accented = strip(ask(setOf("economy"), { accent: "var(--accent)" }));
assert.equal(accented.style, undefined, "the trade set with an accent pen keeps its pieces");
assert.ok(accented.svg.startsWith("<g transform="));
assert.equal(strip(ask(setOf("people"), { accent: "var(--accent)" })).style, "ink");

// the energy set and the economy set's pieces: the old piece strip byte for byte; a family request: no people
const energy = strip(ask(setOf("energy")));
assert.equal(sha(energy.svg), "b6709f4cf6e976aa43f2645f0d8a56ee78dbc0c0868caadb05d23ade6ec881ff", "the energy strip as before");
// The economy pieces' paths carry full double precision (13 to 14 decimals), which the last digits of a platform's maths can move (the
// same hash differed on CI's Linux), so this one is pinned on the text with every decimal number rounded to a tenth: the same strip, whole
// structure and coordinates, but not the platform's last bits.
const tenth = (t) => t.replace(/-?\d+\.\d+(?:e[-+]?\d+)?/g, (m) => { const v = (+m).toFixed(1); return v === "-0.0" ? "0.0" : v; });
const economyPieces = tenth(strip(ask(setOf("economy")), { scene: false }).svg);
assert.equal(sha(economyPieces), "2050140ef0f3f8d9a2e4e6771a7a2e3485dd11e57129a97c54c01a821488fc99", `the economy pieces as before (rounded to a tenth; ${economyPieces.length} chars, begins ${economyPieces.slice(0, 160)})`);
assert.equal(strip(ask(setOf("people"), { family: "pop65", count: 27 })).style, undefined, "a family request keeps strip_topics' pieces");
assert.equal(strip(ask(setOf("economy"), { family: "pop65", count: 27 })).style, undefined, "a family request keeps strip_topics' pieces");
assert.equal(energy.style, undefined);
// pieces no topic lists: the pieces
const off = strip(ask({ ...setOf("people"), pieces: [{ name: "crowd", cell: 300, pad_l: 0 }, { name: "cairn", cell: 300, pad_l: 0 }] }));
assert.equal(off.style, undefined);
assert.ok(off.svg.startsWith("<g transform="));

// over stdin, with no environment, the child draws the same crowds
for (const [name, want] of [["people", people.svg], ["economy", trade.svg]]) {
  const run = spawnSync(process.execPath, [CHILD], { input: JSON.stringify(ask(setOf(name))) + "\n", encoding: "utf8", env: {} });
  assert.equal(JSON.parse(run.stdout.trim()).svg, want, run.stderr);
}
console.log(`test_illus_strip_scene: ok (svg bytes: people ink ${people.svg.length} (${people.figures} figures), trade geo ${trade.svg.length} (${trade.figures}), tech iso ${tech.svg.length} (${tech.figures}))`);
