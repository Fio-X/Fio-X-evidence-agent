#!/usr/bin/env node
// The bake's type check (runtime/leaves_py/type-contrast.js), its pure parts without a browser: WCAG 2.x relative luminance
// and contrast ratio against known pairs, the large-text rule at its edges, compositing a colour with alpha, the rgb() forms
// Chrome computes, and the floors it lists texts below. The page part runs in Chrome only (scripts/test_bake_sandbox.py).
// Run: node scripts/test_type_contrast.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../runtime/leaves_py/type-contrast.js', import.meta.url), 'utf8');
const check = (0, eval)(src);
const { FONT, BODY, LARGE, luminance, ratio, large, over, parse, round } = check('pure');
let n = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n += 1; };

// the floors: 11 px, 4.5:1 body, 3:1 large (WCAG 2.x SC 1.4.3)
eq([FONT, BODY, LARGE], [11, 4.5, 3], 'the floors');
// luminance: black 0, white 1; ratio: black on white 21:1 either way, a colour on itself 1:1
eq([luminance([0, 0, 0]), luminance([255, 255, 255])], [0, 1], 'black and white');
eq([ratio([0, 0, 0], [255, 255, 255]), ratio([255, 255, 255], [0, 0, 0])], [21, 21], 'black on white');
eq(ratio([18, 52, 86], [18, 52, 86]), 1, 'a colour on itself');
// known pairs, to two decimals: #767676 is the lightest grey that passes body text on
// white, #777 just fails; #959595 sits on the large-text line, 3:1
eq(round(ratio([118, 118, 118], [255, 255, 255])), 4.54, '#767676 on white');
eq(round(ratio([119, 119, 119], [255, 255, 255])), 4.48, '#777 on white');
eq(round(ratio([149, 149, 149], [255, 255, 255])), 3, '#959595 on white');
eq(round(ratio([0, 0, 255], [255, 255, 255])), 8.59, 'blue on white');
// a dark channel takes the linear part of the sRGB curve (at or under 0.04045)
eq(round(luminance([10, 10, 10]) * 1e6), round(10 / 255 / 12.92 * 1e6), 'the linear part');
// large text: 24 px and up, or bold (700 and up) at 18.66 px and up
eq([large(24, 400), large(23.9, 400), large(18.66, 700), large(18.65, 700), large(18.66, 600), large(30, 100)], [true, false, true, false, false, true], 'large');
// a colour with its alpha over an opaque one; full alpha is the colour, none the background
eq(over([0, 0, 0, 0.5], [255, 255, 255]), [127.5, 127.5, 127.5], 'half black on white');
eq([over([10, 20, 30, 1], [255, 255, 255]), over([10, 20, 30, 0], [1, 2, 3])], [[10, 20, 30], [1, 2, 3]], 'alpha 1 and 0');
// the forms Chrome computes a colour in; anything else is not parsed (the page part reads it from a canvas)
eq(parse('rgb(1, 2, 3)'), [1, 2, 3, 1], 'rgb()');
eq(parse('rgba(1, 2, 3, 0.25)'), [1, 2, 3, 0.25], 'rgba()');
eq(parse('rgba(0, 0, 0, 0)'), [0, 0, 0, 0], 'transparent');
eq(parse('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5], 'the space form');
eq([parse('oklch(0.5 0.1 200)'), parse('#fff'), parse('none')], [null, null, null], 'not rgb()');
// the page part is the same function called with no argument: a string of JSON in a browser, never the pure parts
assert.equal(typeof check, 'function');
console.log(`type-contrast pure parts: ${n} checks passed`);
