#!/usr/bin/env node
// K308 item 8: the emphasis_tone schema text and refusal name no topic; the tones and their rendering are unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TONES, toneErrors, storyTone, STORY_COLORS } from "../runtime/pi/story_forms.mjs";
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const src = readFileSync(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
const line = src.split("\n").find((l) => l.includes("emphasis_tone: Type.Optional(StringEnum"));
ok(line && /\["coral", "slate"\]/.test(line), "schema enum is still coral, slate");
ok(!/opioid|fell very little/i.test(line), "schema description names no topic");
process.env.NEWSROOM_STORY_FORMS = "1";
const err = toneErrors({ emphasis_tone: "teal", chart_type: "multi_line" }).join(" ");
ok(/emphasis_tone must be 'coral'/.test(err) && !/opioid|fell very little/i.test(err), "refusal names no topic");
ok(TONES.join() === "coral,slate" && storyTone({ emphasis_tone: "coral" }) === STORY_COLORS.coral && storyTone({}) === STORY_COLORS.slate, "tones and default unchanged");
console.log(`K308 item 8 tone text: PASS (${checks} checks)`);
