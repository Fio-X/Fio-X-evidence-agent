#!/usr/bin/env node
// The font floor measures text at the smallest scale the accumulated matrix applies in any direction,
// so a squash in one direction cannot be offset by a stretch in the other. Entry: runRenderQa.
import assert from "node:assert/strict";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

process.env.NEWSROOM_QA_DIRECTIONAL_FONT_SCALE = "1";
const page = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><title>Fixture</title><desc>Fixture</desc><rect x="0" y="0" width="400" height="300" fill="#ffffff"/>${body}</svg>`;
const text = `<text x="10" y="40" font-size="12" fill="#111111">i</text>`;
const floorFailures = (svg) => runRenderQa({ desktop: svg }).viewports.desktop.geometry.failures.filter((f) => f.rule === "font_below_floor");

const caught = {
  "scale(100,0.01)": page(`<g transform="translate(20,20) scale(100,0.01)">${text}</g>`),
  "scale(0.01,100)": page(`<g transform="translate(20,20) scale(0.01,100)">${text}</g>`),
  "nested svg preserveAspectRatio=none squashed to 1/10 height, stretched 10x wide": page(`<svg x="20" y="20" width="200" height="20" viewBox="0 0 20 200" preserveAspectRatio="none">${text}</svg>`),
  "scale(0.5)": page(`<g transform="scale(0.5)">${text}</g>`),
};
for (const [name, svg] of Object.entries(caught)) {
  const failures = floorFailures(svg);
  assert.equal(failures.length, 1, `${name}: font_below_floor must catch the text`);
  assert.match(failures[0].message, /below the \d+px floor/, name);
}
const passes = {
  "no transform": page(text),
  "rotate(90)": page(`<g transform="translate(60,20) rotate(90)">${text}</g>`),
  "uniform scale(2) with rotate": page(`<g transform="translate(60,20) rotate(30) scale(2)">${text}</g>`),
};
for (const [name, svg] of Object.entries(passes)) assert.equal(floorFailures(svg).length, 0, `${name}: must not trip the floor`);
// Switch not exactly "1": the old geometric-mean measure is unchanged, so the squashed text is not caught.
for (const value of [undefined, "0", "true", ""]) {
  if (value === undefined) delete process.env.NEWSROOM_QA_DIRECTIONAL_FONT_SCALE; else process.env.NEWSROOM_QA_DIRECTIONAL_FONT_SCALE = value;
  assert.equal(floorFailures(caught["scale(100,0.01)"]).length, 0, `switch ${JSON.stringify(value)}: old measure must not catch the squashed text`);
  assert.equal(floorFailures(caught["scale(0.5)"]).length, 1, `switch ${JSON.stringify(value)}: uniform scale is caught either way`);
}
console.log(JSON.stringify({ status: "PASS", caught: Object.keys(caught).length, passes: Object.keys(passes).length }));
