#!/usr/bin/env node
// Tests for runtime/pi/render_qa.mjs: the report builder that composes the
// two pure render-QA checks (render_qa_geometry.mjs, render_qa_contrast.mjs)
// into one report per rendered visual, across both responsive viewports, and
// binds each viewport to the sha256 of its own SVG bytes.
//
// These are unit fixtures built by hand in this file - they exercise the
// composition/aggregation logic in render_qa.mjs itself (schema_version,
// pass/fail AND-ing across viewports and checks, failure_count arithmetic,
// hash binding, the "unmeasured never fails" policy). They are not evidence
// of any real chart's quality.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runRenderQa, RENDER_QA_REPORT_SCHEMA_VERSION } from "../runtime/pi/render_qa.mjs";
import { RENDER_QA_GEOMETRY_VERSION } from "../runtime/pi/render_qa_geometry.mjs";
import { RENDER_QA_CONTRAST_VERSION } from "../runtime/pi/render_qa_contrast.mjs";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const page = (bodyMarkup, viewBox = "0 0 200 100") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>Fixture</title><desc>Fixture</desc>${bodyMarkup}</svg>`;

const cleanDesktop = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="16" fill="#111111">Readable label</text>`);
const cleanMobile = page(`<rect x="0" y="0" width="140" height="100" fill="#ffffff"/><text x="10" y="50" font-size="16" fill="#111111">Readable label</text>`, "0 0 140 100");

// --- schema/version constants ----------------------------------------------
{
  assert.equal(RENDER_QA_REPORT_SCHEMA_VERSION, "render-qa/1.0.0");
  const report = runRenderQa({ desktop: cleanDesktop, mobile: cleanMobile });
  assert.equal(report.schema_version, "render-qa/1.0.0");
  assert.equal(report.geometry_check_version, RENDER_QA_GEOMETRY_VERSION);
  assert.equal(report.contrast_check_version, RENDER_QA_CONTRAST_VERSION);
}
console.log("unit: schema_version and check versions -- PASS");

// --- clean pair passes, failure_count 0, hashes bound to the exact bytes ---
{
  const report = runRenderQa({ desktop: cleanDesktop, mobile: cleanMobile });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.failure_count, 0);
  assert.equal(report.viewports.desktop.passed, true);
  assert.equal(report.viewports.mobile.passed, true);
  assert.deepEqual(report.viewports.desktop.geometry.failures, []);
  assert.deepEqual(report.viewports.desktop.contrast.failures, []);
  assert.equal(report.viewports.desktop.svg_sha256, sha256(cleanDesktop));
  assert.equal(report.viewports.mobile.svg_sha256, sha256(cleanMobile));
  assert.notEqual(report.viewports.desktop.svg_sha256, report.viewports.mobile.svg_sha256);
}
console.log("unit: clean desktop+mobile pair passes and hashes are bound to the exact bytes -- PASS");

// --- a contrast failure on one viewport fails only that viewport, and the
//     whole report, while failure_count reflects just that viewport --------
{
  const lowContrastDesktop = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="16" fill="#dddddd">Low contrast label</text>`);
  const report = runRenderQa({ desktop: lowContrastDesktop, mobile: cleanMobile });
  assert.equal(report.passed, false, JSON.stringify(report));
  assert.equal(report.viewports.desktop.passed, false);
  assert.equal(report.viewports.mobile.passed, true);
  assert.equal(report.viewports.desktop.contrast.failures.length, 1);
  assert.equal(report.viewports.desktop.contrast.failures[0].rule, "text_contrast");
  assert.equal(report.viewports.desktop.geometry.failures.length, 0);
  assert.equal(report.failure_count, 1);
}
console.log("unit: a single-viewport contrast failure fails that viewport and the report -- PASS");

// --- a geometry failure (font below floor) fails only via geometry --------
{
  const tinyFontDesktop = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="8" fill="#111111">Too small</text>`);
  const report = runRenderQa({ desktop: tinyFontDesktop, mobile: cleanMobile });
  assert.equal(report.passed, false, JSON.stringify(report));
  assert.equal(report.viewports.desktop.geometry.failures.length, 1);
  assert.equal(report.viewports.desktop.geometry.failures[0].rule, "font_below_floor");
  assert.equal(report.viewports.desktop.contrast.failures.length, 0);
  assert.equal(report.failure_count, 1);
}
console.log("unit: a single-viewport geometry failure (font_below_floor) fails that viewport and the report -- PASS");

// --- failures on both viewports both count toward failure_count -----------
{
  const tinyFontDesktop = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="8" fill="#111111">Too small</text>`);
  const lowContrastMobile = page(`<rect x="0" y="0" width="140" height="100" fill="#ffffff"/><text x="10" y="50" font-size="16" fill="#eeeeee">Low contrast</text>`, "0 0 140 100");
  const report = runRenderQa({ desktop: tinyFontDesktop, mobile: lowContrastMobile });
  assert.equal(report.passed, false, JSON.stringify(report));
  assert.equal(report.viewports.desktop.passed, false);
  assert.equal(report.viewports.mobile.passed, false);
  assert.equal(report.failure_count, 2);
}
console.log("unit: failures on both viewports both count toward failure_count -- PASS");

// --- unmeasured elements are recorded and counted but never fail the report
{
  // "rotate(10deg)" uses a CSS unit the SVG transform grammar does not
  // allow, so the geometry check cannot resolve it (documented in
  // render_qa_geometry.mjs): it produces a note, not a failure, and
  // font_below_floor still applies (16px, above the floor).
  const rotatedText = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><g transform="rotate(10deg)"><text x="20" y="50" font-size="16" fill="#111111">Rotated label</text></g>`);
  const report = runRenderQa({ desktop: rotatedText, mobile: cleanMobile });
  assert.equal(report.viewports.desktop.geometry.notes.length > 0, true, "expected an unresolved-transform note");
  assert.equal(report.viewports.desktop.geometry.failures.length, 0);
  assert.equal(report.viewports.desktop.passed, true, JSON.stringify(report.viewports.desktop));
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.failure_count, 0);
}
console.log("unit: unmeasured/note-only elements do not fail a viewport or the report -- PASS");

// --- mobile is optional: a desktop-only call is valid, and the report shape
//     covers desktop alone (no mobile key, passed/failure_count from desktop)
{
  const report = runRenderQa({ desktop: cleanDesktop });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.failure_count, 0);
  assert.deepEqual(Object.keys(report.viewports), ["desktop"]);
  assert.equal(report.viewports.desktop.svg_sha256, sha256(cleanDesktop));
  assert.equal(report.viewports.mobile, undefined);

  const tinyFontDesktop = page(`<rect x="0" y="0" width="200" height="100" fill="#ffffff"/><text x="20" y="50" font-size="8" fill="#111111">Too small</text>`);
  const failingReport = runRenderQa({ desktop: tinyFontDesktop });
  assert.equal(failingReport.passed, false, JSON.stringify(failingReport));
  assert.equal(failingReport.failure_count, 1);
  assert.deepEqual(Object.keys(failingReport.viewports), ["desktop"]);
}
console.log("unit: a desktop-only call is valid and the report covers desktop alone -- PASS");

// --- missing desktop, or a non-string mobile, is a programmer error, not a
//     silent pass
{
  assert.throws(() => runRenderQa({}), /desktop SVG text is required/);
  assert.throws(() => runRenderQa({ mobile: cleanMobile }), /desktop SVG text is required/);
  assert.throws(() => runRenderQa({ desktop: cleanDesktop, mobile: 42 }), /mobile SVG text must be a string/);
  assert.throws(() => runRenderQa({ desktop: cleanDesktop, mobile: null }), /mobile SVG text must be a string/);
}
console.log("unit: missing desktop, or a non-string mobile, throws rather than silently passing -- PASS");

console.log("render_qa unit tests: PASS");
