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
// NEWSROOM_REQUIRE_NO_SKIP=1 (exact): a section that needs a tool missing here fails instead of printing SKIP.
const skipSection = (message) => {
  if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") throw new Error(`section cannot run, and the run requires none to be skipped: ${message}`);
  console.log(message);
};

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
    skipSection("SKIP: pdftotext not found on PATH; skipping real-extraction assertions");
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

// --- extractDownloadedPdf: downloaded PDFs become a complete row table -----
// Synthetic PDFs of several shapes (one page, many pages, a file above
// fetch_url's byte cap, English and Chinese table layouts, non-PDF body,
// corrupt body). Rows are {page, line, x, text}, ordered by (page, line) and
// byte-identical across extractions of the same PDF.
{
  const { extractDownloadedPdf, pdfPagesToRows, serializePdfRows } = await import("../runtime/pi/pdf_extract.mjs");
  const { sha256Hex } = await import("../runtime/pi/provenance.mjs");
  const { buildPdf, reportPages } = await import("./pdf_fixtures.mjs");
  const probe = await extractPdfText({ bytes: fixtureBytes, truncated: false });
  if (probe.extraction?.unavailable_reason === "pdftotext_not_found") {
    skipSection("SKIP: pdftotext not found; skipping extractDownloadedPdf assertions");
  } else {
    const oneCell = (text, y = 700) => ({ x: 40, y, text });
    const shapes = [
      { name: "one page", pages: [[oneCell("SOLO PAGE TEXT")]] },
      { name: "twelve pages", pages: Array.from({ length: 12 }, (_, i) => [oneCell(`SEGMENT ${i + 1} MARK`)]) },
      // 600 pages with padding cells: far above fetch_url's read cap in text volume
      { name: "many pages", pages: Array.from({ length: 150 }, (_, i) => Array.from({ length: 30 }, (_, r) => oneCell(`LONGDOC ${i + 1} row ${r + 1} ${"lorem ".repeat(8)}`, 760 - r * 20))) },
      { name: "chinese table", pages: reportPages({ header: "年度报告", columns: ["地区", "金额（百万元）"], colX: [40, 300], rowsByPage: [[["甲", "10"], ["乙", "20"], ["小计", "30"]]] }) },
    ];
    for (const shape of shapes) {
      const bytes = buildPdf(shape.pages);
      const sha = sha256Hex(bytes);
      const args = { bytes, contentType: "application/octet-stream", sourceSha256: sha, sourceFile: `data/${sha}.pdf` };
      const rec = await extractDownloadedPdf(args);
      assert.equal(rec.available, true, shape.name);
      assert.equal(rec.extraction.pages, shape.pages.length, shape.name);
      assert.equal(rec.meta.source_sha256, sha);
      assert.equal(rec.rowsFile, `data/derived/${sha}.pdf-rows.json`);
      assert.equal(rec.meta.rows_sha256, sha256Hex(Buffer.from(rec.rowsText, "utf8")));
      // rows sorted by (page, line), complete columns, every page present
      for (let i = 1; i < rec.rows.length; i += 1) {
        const a = rec.rows[i - 1], b = rec.rows[i];
        assert.ok(a.page < b.page || (a.page === b.page && a.line < b.line), `${shape.name}: rows sorted`);
      }
      for (const row of rec.rows) assert.deepEqual(Object.keys(row), ["page", "line", "x", "text"]);
      assert.equal(new Set(rec.rows.map((r) => r.page)).size, shape.pages.length, `${shape.name}: every page has rows`);
      if (shape.name === "many pages") assert.ok(bytes.length > 100 * 1024 && rec.rows.length === 150 * 30, "complete, not capped");
      // determinism: a second extraction is byte-identical
      const again = await extractDownloadedPdf(args);
      assert.equal(again.rowsText, rec.rowsText, `${shape.name}: byte-identical across extractions`);
      assert.equal(again.meta.rows_sha256, rec.meta.rows_sha256);
      // the same bytes through the capped (truncated) path still refuse
      const capped = await extractPdfText({ bytes: bytes.subarray(0, 4096), truncated: true });
      assert.equal(capped.text, "PDF text unavailable: pdf_truncated", `${shape.name}: truncated gate unchanged`);
    }
    // pure helper: blank lines dropped, nothing merged or converted
    const rows = pdfPagesToRows(["  a  b\n\n  c", "d"]);
    assert.deepEqual(rows, [{ page: 1, line: 1, x: 2, text: "a  b" }, { page: 1, line: 3, x: 2, text: "c" }, { page: 2, line: 1, x: 0, text: "d" }]);
    assert.equal(serializePdfRows([]), "[\n\n]\n");
    // must-fail shapes: non-PDF body yields no table; a corrupt PDF never
    // yields an available table.
    assert.equal(await extractDownloadedPdf({ bytes: Buffer.from("a,b\n1,2\n"), contentType: "text/csv", sourceSha256: "x", sourceFile: "f" }), null);
    const corrupt = await extractDownloadedPdf({ bytes: Buffer.from("%PDF-1.4\nnot really a pdf"), contentType: "application/pdf", sourceSha256: "x", sourceFile: "f" });
    assert.equal(corrupt.available, false);
    assert.equal(corrupt.rows.length, 0);
    console.log("extractDownloadedPdf: 4 shapes PASS");
  }
}

console.log("pdf extract: PASS");
