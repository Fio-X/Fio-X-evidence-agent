// The iso strip's feet (runtime/leaves_js/illus_strip.cjs sceneStrip, style iso): every shoe either stands on the ground line
// or hangs from the end of its leg, never apart from both. The measure is the strip's own placement: sceneStrip(..., {feet: true})
// returns, for each placed figure, its pose and per foot the shoe's outline (the iso skin drawn again with a marker shoe colour,
// moved, fitted and shifted as the figure's shapes are) and the leg's end (the trouser hem's centre, 0.12 head above the ankle,
// projected the skin's way and placed the same way). A shoe is
//   grounded: its lowest point within GROUND px of the ground line, or
//   attached: the leg's end inside the shoe's outline or within ATTACH px of it.
// Also: no pose that leans on a thing of the scene (a wall the strip does not draw) is in the row.
//
// Run: node scripts/test_illus_strip_feet.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sceneStrip } = require("../runtime/leaves_js/illus_strip.cjs");
const L = await import("../runtime/illus_hero/scene/people_lib/lib.mjs");
const set = JSON.parse(readFileSync(new URL("../runtime/leaves_js/pieces-economy.json", import.meta.url), "utf8"));
const seed0 = set.knobs.find((k) => k.name === "seed").default;
const pens = { ink: "var(--t-title)", second: "var(--t-sec)" };
const GROUND = 4, ATTACH = 1; // px; a head is about 28 px at the 225 px strip, so ATTACH is under 0.04 head

const inside = ([x, y], P) => { // even-odd point in polygon
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const segDist = ([x, y], [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const gap = (p, P) => (inside(p, P) ? 0 : Math.min(...P.map((q, i) => segDist(p, q, P[(i + 1) % P.length]))));

let shoes = 0, grounded = 0, attached = 0;
const cases = [];
for (const seed of [seed0, 1, 12, 77, 4242, 9001]) for (const [W, H, YG] of [[1140, 225, 184], [800, 160, 130], [2000, 225, 184]]) cases.push([seed, W, H, YG]);
for (const [seed, W, H, YG] of cases) {
  const r = sceneStrip("iso", W, H, YG, seed, pens, { feet: true });
  const label = `iso seed ${seed} ${W}x${H}`;
  assert.ok(r && Array.isArray(r.feet), `${label}: the feet measure`);
  assert.equal(r.feet.length, r.figures, `${label}: one entry per placed figure`);
  r.feet.forEach(({ pose, feet }, i) => {
    const needs = L.getPose(pose)?.needs;
    assert.ok(!needs || needs === "partner", `${label}: figure ${i} (${pose}) leans on a ${needs} the strip does not draw`);
    assert.equal(feet.length, 2, `${label}: figure ${i} (${pose}) has two feet`);
    for (const { side, hem, shoe } of feet) {
      assert.ok(shoe && shoe.length >= 3, `${label}: figure ${i} (${pose}) foot ${side}: no shoe found`);
      shoes++;
      const low = Math.max(...shoe.map((q) => q[1])), onGround = YG - low <= GROUND, d = gap(hem, shoe), onLeg = d <= ATTACH;
      grounded += onGround; attached += onLeg;
      assert.ok(onGround || onLeg, `${label}: figure ${i} (${pose}) foot ${side} floats: its lowest point is ${(YG - low).toFixed(1)} px above the ground and the leg's end ${d.toFixed(1)} px from the shoe`);
    }
  });
}
console.log(`test_illus_strip_feet: ok (${cases.length} strips, ${shoes} shoes: ${grounded} on the ground, ${attached} on the leg's end)`);
