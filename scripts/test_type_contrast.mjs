#!/usr/bin/env node
// The bake's type check (runtime/leaves_py/type-contrast.js), its pure parts without a browser: WCAG 2.x relative luminance
// and contrast ratio against known pairs, the large-text rule at its edges, compositing a colour with alpha, the rgb() forms
// Chrome computes, the floors it lists texts below, the rounding down of what it reports, and what it cannot read (an
// unreadable paint, an outline-only text, a pseudo-element's text, a text painted apart from its colour, an image on the page
// ground). The page part runs in Chrome only
// (scripts/test_bake_sandbox.py).
// Run: node scripts/test_type_contrast.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../runtime/leaves_py/type-contrast.js', import.meta.url), 'utf8');
const check = (0, eval)(src);
const { FONT, BODY, LARGE, luminance, ratio, large, over, parse, down, pseudoText, unreadable, outlined, apart, groundImage } = check('pure');
const round = (x) => Math.round(x * 100) / 100; // the known pairs below are given to two decimals
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
// what it reports is rounded down to two decimals, never up: a value under a floor (each has two decimals) is reported
// under it, one at or over it at or over it
eq([down(4.495), down(4.4999), down(4.5), down(4.59258), down(10.995), down(11), down(21)], [4.49, 4.49, 4.5, 4.59, 10.99, 11, 21], 'down');
eq([down(4.5 - 1e-12), down(0.07 * 100 / 100), down(2.05)], [4.5, 0.07, 2.05], 'float error at a floor');
eq(down(ratio([119, 119, 119], [255, 255, 255])) < BODY && round(ratio([119, 119, 119], [255, 255, 255])) < BODY, true, '#777 stays under');
eq([down(ratio([118, 118, 118], [255, 255, 255])) >= BODY], [true], '#767676 stays over');
// a paint it cannot read as one colour: html images and embedded content, a background image (the svg root's too), an svg
// image, use or foreignObject, a fill by url(); a plain shape, an html box or the svg root with a colour is read
eq(['img', 'canvas', 'video', 'iframe', 'object', 'embed'].map((n) => unreadable(n, false, '', 'none')), [true, true, true, true, true, true], 'html media');
eq([unreadable('div', false, '', 'url("a.png")'), unreadable('div', false, '', 'linear-gradient(red, blue)'), unreadable('div', false, '', 'none')], [true, true, false], 'background image');
eq([unreadable('svg', true, 'rgb(0, 0, 0)', 'url("a.png")'), unreadable('svg', true, 'rgb(0, 0, 0)', 'none')], [true, false], 'the svg root');
eq(['image', 'use', 'foreignObject'].map((n) => unreadable(n, true, 'rgb(0, 0, 0)', 'none')), [true, true, true], 'svg image, use, foreignObject');
eq([unreadable('rect', true, 'url("#g")', 'none'), unreadable('path', true, 'url(#p)', 'none'), unreadable('rect', true, 'rgb(1, 2, 3)', 'none')], [true, true, false], 'fill by url()');
// an outline-only text: no fill and a stroke of some width; no fill and no stroke is not seen at all
eq([outlined('none', 'rgb(0, 0, 0)', '1px'), outlined('none', 'none', '1px'), outlined('none', 'rgb(0, 0, 0)', '0px'), outlined('rgb(0, 0, 0)', 'rgb(0, 0, 0)', '1px')], [true, false, false, false], 'outline only');
// a pseudo-element prints text when its content is a string or a generated value; none, normal and "" print nothing
eq(['"注"', "'x'", 'counter(item)', 'attr(data-n)', 'open-quote'].map(pseudoText), [true, true, true, true, true], 'pseudo text');
eq(['none', 'normal', '""', "''", '', undefined].map(pseudoText), [false, false, false, false, false, false], 'no pseudo text');
// a text whose paint is not the colour read: clipped to a background (background-clip: text) whatever its colours, or a
// -webkit-text-fill-color other than its color in html; in svg the property takes the color by default, so only one set
// apart from both the color and the fill counts
const BLACK = '0,0,0,1', RED = '255,0,0,1', CLEAR = '0,0,0,0';
eq([apart(false, BLACK, BLACK, '', false), apart(false, RED, BLACK, '', false), apart(false, CLEAR, BLACK, '', false)], ['', '-webkit-text-fill-color', '-webkit-text-fill-color'], 'html text fill');
eq([apart(false, BLACK, BLACK, '', true), apart(false, CLEAR, CLEAR, '', true), apart(true, BLACK, BLACK, RED, true)], ['background-clip: text', 'background-clip: text', 'background-clip: text'], 'clipped to a background');
eq([apart(true, BLACK, BLACK, RED, false), apart(true, RED, BLACK, RED, false), apart(true, CLEAR, BLACK, RED, false)], ['', '', '-webkit-text-fill-color'], 'svg text fill');
// a background image on html or body itself (an image or a gradient); none on both is a plain page ground
eq([groundImage('url("bg.png")', 'none'), groundImage('none', 'linear-gradient(red, blue)'), groundImage('none', 'none'), groundImage('none', null)], [true, true, false, false], 'page ground image');
// the page part is the same function called with no argument: a string of JSON in a browser, never the pure parts
assert.equal(typeof check, 'function');
console.log(`type-contrast pure parts: ${n} checks passed`);
