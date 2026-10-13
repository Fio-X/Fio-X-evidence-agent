#!/usr/bin/env node
// K281 infographic page details, both default off (exact "1"):
//   NEWSROOM_HERO_THOUSANDS - a hero number of five or more plain digits is drawn with thousands separators (drawing only)
//   NEWSROOM_ONE_NUMBERING  - a page whose sections carry panel numbers does not number its modules a second time (01 ... 12)
import assert from "node:assert/strict";
const { composeInfographicBundle, heroValueText } = await import("../runtime/pi/infographic.mjs");

const SWITCHES = ["NEWSROOM_HERO_THOUSANDS", "NEWSROOM_ONE_NUMBERING"];
const withEnv = (env, fn) => {
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

// hero value
for (const v of ["70646", "1234567", "-12345", "70646.5"]) assert.equal(withEnv({}, () => heroValueText({ value: v })), v, `off: ${v} untouched`);
assert.equal(withEnv({ NEWSROOM_HERO_THOUSANDS: "1" }, () => heroValueText({ value: "70646" })), "70,646");
assert.equal(withEnv({ NEWSROOM_HERO_THOUSANDS: "1" }, () => heroValueText({ value: "1234567" })), "1,234,567");
assert.equal(withEnv({ NEWSROOM_HERO_THOUSANDS: "1" }, () => heroValueText({ value: "-12345" })), "-12,345");
assert.equal(withEnv({ NEWSROOM_HERO_THOUSANDS: "1" }, () => heroValueText({ value: "70646.5" })), "70,646.5");
for (const v of ["9999", "54.4", "7.06万", "2025", "70,646", "约 70646"]) assert.equal(withEnv({ NEWSROOM_HERO_THOUSANDS: "1" }, () => heroValueText({ value: v })), v, `on: ${v} untouched`);
assert.equal(withEnv({ NEWSROOM_HERO_THOUSANDS: "2" }, () => heroValueText({ value: "70646" })), "70646", "only exact 1");

// numbering
const svgOf = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><text x="20" y="30" font-size="14">t</text></svg>`;
const page = (eyebrow) => ({
  schema_version: "1.0.0", language: "zh", title: "标题", dek: "副题", kicker: "数据专题",
  alt: "这是一段足够长的替代文本，用来满足三十个字符的最低要求，没有别的意思。",
  modules: [
    { id: "h1", type: "section_header", span: "full", ...(eyebrow ? { eyebrow } : {}), heading: "第一节" },
    { id: "t1", type: "text", span: "full", label: "说明", body: "一段正文。", claim_ids: ["x"] },
    { id: "v1", type: "visual", span: "full", label: "图", manifest_ref: "c1", claim_id: "x", claim_ids: ["x"] },
    { id: "hero", type: "hero_stat", span: "full", value: "70646", unit: "人", label: "总数", claim_id: "x" },
  ],
});
const assets = { c1: { desktopSvg: svgOf(1040, 400), mobileSvg: svgOf(1040, 400), manifest: { kind: "chart" } } };
const kickers = (svg) => [...svg.matchAll(/letter-spacing="1.5"[^>]*>([^<]*)</g)].map((m) => m[1]).filter((t) => !t.startsWith("AGENTIC"));
const compose = (env, eyebrow) => withEnv(env, () => composeInfographicBundle(page(eyebrow), assets, { mobilePages: false }).desktop.svg);
const off = compose({}, "1");
assert.deepEqual(kickers(off), ["01 · 说明", "02"], "off: module ordinals as before");
assert.equal(compose({ NEWSROOM_ONE_NUMBERING: "1" }, undefined) , compose({}, undefined), "on, no panel numbers on the page: byte-identical");
const on = compose({ NEWSROOM_ONE_NUMBERING: "1" }, "1");
assert.deepEqual(kickers(on), ["说明"], "on with panel numbers: the label stays, the second numbering is gone");
assert.ok(/>1<\/text>/.test(on), "on: the panel number is still drawn");
assert.ok(withEnv({ NEWSROOM_HERO_THOUSANDS: "1" }, () => composeInfographicBundle(page("1"), assets, { mobilePages: false }).desktop.svg).includes("70,646"), "hero drawn with the separator");
assert.ok(off.includes(">70646"), "hero off: plain digits");
console.log("test_page_details_k281: ok");
