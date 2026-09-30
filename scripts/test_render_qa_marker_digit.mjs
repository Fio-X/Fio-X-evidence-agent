#!/usr/bin/env node
// Regression tests for the choropleth numbered-marker exemption in
// render_qa_geometry.mjs's text_crosses_data_mark rule.
//
// A choropleth numbered marker (the fallback for a country too small to
// label directly) draws its own number centred inside its circle. Only that
// exact pair is exempt: the text's role must name the circle's role, its
// content must be the circle's data-number, and its box centre must sit
// inside the circle. Every other text that lands on a marker still fails.
import assert from "node:assert/strict";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

const MAIN = "choropleth-footnote-marker";
const INSET = "choropleth-inset-footnote-marker";

function page(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">${body}</svg>`;
}
function marker(role, number, cx, cy) {
  return `<circle data-role="${role}" data-number="${number}" cx="${cx}" cy="${cy}" r="9" fill="#1A1A1A"/>`;
}
function digit(role, text, x, y) {
  const roleAttr = role ? ` data-role="${role}"` : "";
  return `<text${roleAttr} x="${x}" y="${y}" text-anchor="middle" font-size="12" font-weight="700" fill="#FFFFFF">${text}</text>`;
}
function crossings(svgText) {
  return checkSvgGeometry(svgText).failures.filter((f) => f.rule === "text_crosses_data_mark");
}

// (1) and (2): a marker's own number, drawn the way viz.mjs draws it
// (x = cx, baseline at cy + 4), is exempt for both marker kinds.
assert.deepEqual(crossings(page(marker(MAIN, 1, 200, 150) + digit(`${MAIN}-label`, "1", 200, 154))), [], "main marker's own digit must pass");
assert.deepEqual(crossings(page(marker(INSET, 2, 200, 150) + digit(`${INSET}-label`, "2", 200, 154))), [], "inset marker's own digit must pass");
console.log("own digit inside its own marker (main and inset): PASS");

// (3) A country name landing on a marker still fails: the circle stays a
// data mark for every other text.
assert.equal(crossings(page(marker(MAIN, 1, 200, 150) + `<text data-role="choropleth-label" x="200" y="154" text-anchor="middle" font-size="12">刚果（布）</text>`)).length, 1, "a country label on a marker must fail");
console.log("country label on a marker still fails: PASS");

// (4) A digit whose content is not the circle's data-number fails.
assert.equal(crossings(page(marker(MAIN, 1, 200, 150) + digit(`${MAIN}-label`, "2", 200, 154))).length, 1, "a different number on a marker must fail");
console.log("wrong number on a marker still fails: PASS");

// (5) The role pairing is exact: an inset digit role on a main-map marker
// fails.
assert.equal(crossings(page(marker(MAIN, 1, 200, 150) + digit(`${INSET}-label`, "1", 200, 154))).length, 1, "a digit paired with the other marker kind must fail");
console.log("digit role paired with the wrong marker kind still fails: PASS");

// (6) A matching digit pushed off-centre (box centre outside the circle,
// box still overlapping it) fails.
assert.equal(crossings(page(marker(MAIN, 1, 200, 150) + digit(`${MAIN}-label`, "1", 211, 154))).length, 1, "an off-centre digit must fail");
console.log("off-centre digit still fails: PASS");

// (7) An untagged digit (the markup before this fix) fails: the exemption
// needs the role, not just the geometry.
assert.equal(crossings(page(marker(MAIN, 1, 200, 150) + digit(null, "1", 200, 154))).length, 1, "an untagged digit must fail");
console.log("untagged digit still fails: PASS");

// (8) The pair is matched in page space: a marker and its digit inside a
// scaled nested chart (infographic.mjs's embed shape) still pass.
const nested = page(`<svg data-role="infographic-visual" x="100" y="50" width="200" height="150" viewBox="0 0 400 300">${marker(MAIN, 1, 200, 150)}${digit(`${MAIN}-label`, "1", 200, 154)}</svg>`);
assert.deepEqual(crossings(nested), [], "own digit inside a scaled nested chart must pass");
console.log("own digit inside a scaled nested chart: PASS");

console.log("render_qa_geometry marker-digit exemption: PASS");
