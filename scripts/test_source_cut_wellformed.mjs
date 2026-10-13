#!/usr/bin/env node
// K56: fetched text must never be cut inside a surrogate pair, because the
// strict JSON readers refuse the lone high surrogate in the saved snapshot.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cutFetchedText, decodeBoundedText, sliceWellFormed } from "../runtime/pi/net.mjs";
import { sourceContentHash } from "../runtime/pi/provenance.mjs";

process.env.NEWSROOM_FETCH_WELLFORMED_CUT = "1";
const text = "ab中文😀cd𠀀e😀😀f";
const bytes = new TextEncoder().encode(text);
let splitCases = 0;
for (let max = 0; max <= text.length + 1; max++) {
  const viaDecode = decodeBoundedText(bytes, max);
  const viaHelper = sliceWellFormed(text, max);
  for (const out of [viaDecode.text, viaHelper]) {
    assert.ok(out.isWellFormed(), `max=${max} output must be well-formed`);
    assert.ok(text.startsWith(out), `max=${max} output must be a prefix`);
    const plain = text.slice(0, max);
    const split = plain.length > 0 && !plain.isWellFormed();
    assert.equal(out.length, split ? max - 1 : plain.length, `max=${max} length`);
    if (split) splitCases++;
  }
  assert.equal(viaDecode.truncated, text.length > max, `max=${max} truncated`);
}
assert.ok(splitCases > 0, "sweep must hit at least one split pair");

// Both cut sites in newsroom.ts must go through the helper.
const source = await readFile(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
assert.match(source, /body: cutFetchedText\(body, maxChars\)/);
assert.ok(!/body\.slice\(0, maxChars\)/.test(source), "plain body.slice must be gone");
const net = await readFile(new URL("../runtime/pi/net.mjs", import.meta.url), "utf8");
assert.match(net, /text: cutFetchedText\(text, maxChars\)/);

// Switch not exactly "1": the plain slice, as before.
for (const value of [undefined, "0", "true", ""]) {
  if (value === undefined) delete process.env.NEWSROOM_FETCH_WELLFORMED_CUT; else process.env.NEWSROOM_FETCH_WELLFORMED_CUT = value;
  assert.equal(cutFetchedText("abc😀def", 4), "abc😀def".slice(0, 4), `switch ${JSON.stringify(value)}`);
  assert.equal(decodeBoundedText(new TextEncoder().encode("abc😀def"), 4).text, "abc😀def".slice(0, 4));
}
process.env.NEWSROOM_FETCH_WELLFORMED_CUT = "1";
assert.equal(cutFetchedText("abc😀def", 4), "abc");

// Hashes pinned for the Python and Rust snapshot tests (same record fields
// as the fetch_url writer in newsroom.ts, text cut at maxChars=4 on "abc😀def").
const base = { finalUrl: "https://example.org/emoji", status: 200, contentType: "text/html", truncated: true };
const helperText = sliceWellFormed("abc😀def", 4);
assert.equal(helperText, "abc");
const HELPER_HASH = "97d11664003459e55307a9407490fd492853b246c7097eada313805388d10172";
const PLAIN_HASH = "e3db4cd4bb38976feae3e84e03bb24e905a832167efe888eb1cfc6d3932bcb59";
assert.equal(sourceContentHash({ ...base, text: helperText }), HELPER_HASH);
assert.equal(sourceContentHash({ ...base, text: "abc😀def".slice(0, 4) }), PLAIN_HASH);
console.log(JSON.stringify({ status: "PASS", sweep_max: text.length + 1, split_cases: splitCases }));
