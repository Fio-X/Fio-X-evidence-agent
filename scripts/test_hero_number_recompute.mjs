#!/usr/bin/env node
// NEWSROOM_HERO_RECOMPUTE=1: a hero_stat's big number must equal the value recomputed from its claim's query result, after the rounding the
// page shows. Pure matcher tests, synthetic numbers only; the tool path (newsroom.ts fillHeroModule) is covered in test_hero_value_tool_path.mjs.
import assert from "node:assert/strict";
import { heroRecomputeEnabled, heroRecomputeRefusal, roundedTo, shownNumber } from "../runtime/pi/hero_recompute.mjs";

const refusal = (shownText, recomputed) => heroRecomputeRefusal({ heroId: "h1", claimId: "c1", placeholder: "{max.value}", shownText, recomputed });
let n = 0;
const t = (name, f) => { f(); n += 1; console.log(`  ok  ${name}`); };

t("a matching number passes (48.4 against a recomputed 48.38)", () => assert.equal(refusal("48.4", 48.38), null));
t("a number off by 1% is refused and the record carries the recomputed value", () => {
  const msg = refusal("48.9", 48.38); // 48.9 is 1.07% above 48.38
  assert.match(msg, /^HERO_VALUE_RECOMPUTE_MISMATCH: hero_stat 'h1' claim 'c1'/);
  assert.match(msg, /recomputes 48\.38 /);
  assert.match(msg, /48\.4 at 1 decimal/);
});
t("a number about 1% off is refused", () => assert.match(refusal("48.9", 48.4), /recomputes 48\.4 /));
t("the shown number must be the rounding to the decimals it shows, not just near", () => {
  assert.equal(refusal("48.4", 48.44), null);
  assert.match(refusal("48.4", 48.46), /recomputes 48\.46 /);
  assert.equal(refusal("48", 48.4), null);
  assert.match(refusal("48", 48.6), /recomputes 48\.6 /);
  assert.equal(refusal("48.38", 48.38), null);
});
t("negative, thousands separators and half-up rounding", () => {
  assert.equal(refusal("-0.05", -0.0499), null);
  assert.equal(refusal("1,234.6", 1234.55), null);
  assert.equal(refusal("2.5", 2.45), null);
  assert.match(refusal("1,234", 1234.9), /recomputes 1234\.9 /);
});
t("a recomputed cell given as a numeric string is read; a non-number or non-bare shown text is not compared", () => {
  assert.equal(refusal("48.4", "48.38"), null);
  assert.match(refusal("49", "48.38"), /recomputes 48\.38 /);
  assert.equal(refusal("B", "B"), null);
  assert.equal(refusal("48.4", null), null);
  assert.equal(refusal("48.4%", 48.38), null);
  assert.equal(shownNumber("1,2"), null);
  assert.equal(roundedTo(0.125, 2), 0.13);
});
t("the switch is read as exactly 1 and is off by default", () => {
  const was = process.env.NEWSROOM_HERO_RECOMPUTE;
  try {
    delete process.env.NEWSROOM_HERO_RECOMPUTE; assert.equal(heroRecomputeEnabled(), false);
    for (const v of ["0", "true", "on", "", "11"]) { process.env.NEWSROOM_HERO_RECOMPUTE = v; assert.equal(heroRecomputeEnabled(), false, v); }
    process.env.NEWSROOM_HERO_RECOMPUTE = "1"; assert.equal(heroRecomputeEnabled(), true);
  } finally { if (was === undefined) delete process.env.NEWSROOM_HERO_RECOMPUTE; else process.env.NEWSROOM_HERO_RECOMPUTE = was; }
});
console.log(`hero number recompute: ${n} checks -- PASS`);
