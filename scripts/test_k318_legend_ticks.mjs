#!/usr/bin/env node
// K318: NEWSROOM_LEGEND_TICK_FIT=1 (exact "1", default off) thins choropleth legend tick labels by measured width: the first and last ticks and a zero tick are never
// dropped, the others go when their box would touch a kept one. Off (unset, "0", "true", " 1") is byte-identical.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

const src = readFileSync(new URL("./test_k309_signed_scale.mjs", import.meta.url), "utf8");
const mapSpec = eval("(" + src.match(/const mapSpec = (\{.*\});\n/)[1] + ")");
const KEY = "NEWSROOM_LEGEND_TICK_FIT";
const withEnv = (v, fn) => { const old = process.env[KEY]; if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v; try { return fn(); } finally { if (old === undefined) delete process.env[KEY]; else process.env[KEY] = old; } };
const countries = ["BRA", "CHN", "RUS", "IND", "USA", "AUS", "CAN", "ARG"];
const draw = (vals, extra = {}) => renderVizBundle({ ...mapSpec, ...extra }, countries.map((c, i) => ({ c, v: vals[i % vals.length] })), { mobilePages: false }).desktop;
const legendTexts = (svg) => { const g = svg.match(/<g data-role="choropleth-legend">([\s\S]*?)<\/g>/)[1]; return [...g.matchAll(/<text(?![^>]*legend-title)[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]); };
const SHAPES = {
  skewedWide: [1234567, 2345678, 3456789, 4567890, 5678901, 6789012, 7890123, 89012345],
  skewedSmall: [1, 2, 3, 4, 5, 6, 7, 100],
  decimals: [0.0123, 0.0234, 0.0345, 0.0456, 0.0567, 0.0678, 0.0789, 0.9012],
  signedLike: [-325.6, 161.1, 91, -10, -50, 9, -200, 2],
  even: [10, 20, 30, 40, 50, 60, 70, 80],
  single: [5],
};
for (const [name, vals] of Object.entries(SHAPES)) {
  for (const extra of [{}, { unit: "万公顷/年" }, { unit: "people per square kilometre" }]) {
    const off = withEnv(undefined, () => draw(vals, extra));
    for (const v of ["0", "true", " 1", "1 ", "yes"]) assert.equal(withEnv(v, () => draw(vals, extra)), off, `${name}: ${JSON.stringify(v)} is byte-identical to off`);
    const on = withEnv("1", () => draw(vals, extra));
    const a = legendTexts(off), b = legendTexts(on);
    assert.ok(b.length <= a.length, `${name}: never adds a tick`);
    assert.equal(b[0], a[0], `${name}: first tick kept`);
    assert.equal(b[b.length - 1], a[a.length - 1], `${name}: last tick kept`);
    if (name === "skewedWide" && extra.unit === "people per square kilometre") assert.ok(b.length < a.length, "a long end label thins the crowded middle ticks");
    console.log(name, JSON.stringify(extra), "off", a.join(" | "), "on", b.join(" | "));
  }
}
console.log("k318 legend ticks PASS");
