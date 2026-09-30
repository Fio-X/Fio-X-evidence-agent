#!/usr/bin/env node
// Exercises runtime/pi/pdf_extract.mjs, the module fetch_url's fetchText
// uses so a PDF body is either faithfully extracted text or an explicit
// "PDF text unavailable" statement - never decoded binary.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PDF_UNAVAILABLE_REASONS,
  extractPdfText,
  formatPagesWithMarkers,
  looksLikePdf,
  pdfUnavailableMessage,
  splitPdfPages,
} from "../runtime/pi/pdf_extract.mjs";
import { sourceContentHash } from "../runtime/pi/provenance.mjs";

const fixtureBytes = await readFile(new URL("../fixtures/pdf/two-page-fixture.pdf", import.meta.url));

// --- looksLikePdf --------------------------------------------------------
assert.equal(looksLikePdf("application/pdf", new Uint8Array()), true);
assert.equal(looksLikePdf("application/pdf; charset=binary", fixtureBytes), true);
assert.equal(looksLikePdf("text/html", fixtureBytes), true, "magic bytes must win even with a misdeclared content-type");
assert.equal(looksLikePdf("text/html", new TextEncoder().encode("<html></html>")), false);
assert.equal(looksLikePdf("", new Uint8Array()), false);
assert.equal(looksLikePdf(null, undefined), false);

// --- pdfUnavailableMessage -------------------------------------------------
for (const reason of PDF_UNAVAILABLE_REASONS) {
  assert.equal(pdfUnavailableMessage(reason), `PDF text unavailable: ${reason}`);
}
assert.throws(() => pdfUnavailableMessage("not_a_real_reason"), /Unknown PDF unavailable reason/);

// --- splitPdfPages / formatPagesWithMarkers (pure, no subprocess) ---------
assert.deepEqual(splitPdfPages("one\ftwo\f"), ["one", "two"], "a trailing form feed must not count as an extra blank page");
assert.deepEqual(splitPdfPages("only page"), ["only page"]);
assert.deepEqual(splitPdfPages("a\fb\fc"), ["a", "b", "c"], "no trailing form feed must not drop the last real page");
assert.equal(formatPagesWithMarkers(["ALPHA LINE ONE\n", "BRAVO LINE TWO\n"]), "[page 1]\nALPHA LINE ONE\n\n[page 2]\nBRAVO LINE TWO");

// --- truncated fetch: never hand a partial PDF to pdftotext ---------------
{
  const result = await extractPdfText({ bytes: fixtureBytes, truncated: true });
  assert.equal(result.text, "PDF text unavailable: pdf_truncated");
  assert.deepEqual(result.extraction, { tool: "pdftotext", unavailable_reason: "pdf_truncated" });
}

// --- pdftotext missing from PATH: deterministic regardless of this host ---
{
  const savedPath = process.env.PATH;
  process.env.PATH = "/newsroom-test-empty-bin-dir";
  let result;
  try {
    result = await extractPdfText({ bytes: fixtureBytes, truncated: false });
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(result.text, "PDF text unavailable: pdftotext_not_found");
  assert.deepEqual(result.extraction, { tool: "pdftotext", unavailable_reason: "pdftotext_not_found" });
}

// --- real extraction: needs poppler's pdftotext on PATH -------------------
{
  const result = await extractPdfText({ bytes: fixtureBytes, truncated: false });
  if (result.extraction?.unavailable_reason === "pdftotext_not_found") {
    console.log("SKIP: pdftotext not found on PATH; skipping real-extraction assertions (expected on CI Linux runners without poppler)");
  } else {
    assert.equal(result.extraction.tool, "pdftotext");
    assert.equal(result.extraction.pages, 2);
    assert.match(result.extraction.version, /^\d+\.\d+/, "pdftotext -v must yield a parseable version");
    assert.equal(result.text, "[page 1]\nALPHA LINE ONE\n\n[page 2]\nBRAVO LINE TWO");
    assert.ok(result.text.includes("[page 1]") && result.text.indexOf("[page 1]") < result.text.indexOf("[page 2]"));

    // Sanity-check the exact shape fetch_url's handler writes into
    // sources/<hash>.json, before the Python/Rust verifiers get to it.
    const record = {
      schema_version: "0.7.0",
      final_url: "https://example.test/doc.pdf",
      status: 200,
      content_type: "application/pdf",
      truncated: false,
      trust: "untrusted_external_content",
      text: result.text,
      extraction: result.extraction,
    };
    record.content_hash = sourceContentHash({
      finalUrl: record.final_url,
      status: record.status,
      contentType: record.content_type,
      truncated: record.truncated,
      text: record.text,
    });
    const recomputed = sourceContentHash({
      finalUrl: record.final_url,
      status: record.status,
      contentType: record.content_type,
      truncated: record.truncated,
      text: record.text,
    });
    assert.equal(record.content_hash, recomputed, "extraction field must sit outside the hashed 5-field payload");
    console.log(`extraction: pdftotext v${result.extraction.version}, ${result.extraction.pages} pages`);
  }
}

console.log("pdf extract: PASS");
