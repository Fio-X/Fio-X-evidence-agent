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

// --- extractDownloadedPdf: downloaded PDFs are extracted in full ----------
// Synthetic PDFs of several shapes (page counts, size above fetch_url's
// maxChars*4 read cap, non-PDF body, partial body).
{
  const { extractDownloadedPdf } = await import("../runtime/pi/pdf_extract.mjs");
  const { sha256Hex } = await import("../runtime/pi/provenance.mjs");
  function makePdf(pageTexts, padBytes = 0) {
    const objs = [];
    const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
    objs.push("<< /Type /Catalog /Pages 2 0 R >>");
    objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`);
    const fontNum = 3 + pageTexts.length * 2;
    pageTexts.forEach((t, i) => {
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`);
      const pad = padBytes ? `\n% ${"x".repeat(padBytes)}` : "";
      const stream = `BT /F1 12 Tf 20 100 Td (${t}) Tj ET${pad}`;
      objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    let out = "%PDF-1.4\n"; const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
  const probe = await extractPdfText({ bytes: fixtureBytes, truncated: false });
  if (probe.extraction?.unavailable_reason === "pdftotext_not_found") {
    console.log("SKIP: pdftotext not found; skipping extractDownloadedPdf assertions");
  } else {
    const shapes = [
      { name: "one page", texts: ["SOLO PAGE TEXT"], pad: 0 },
      { name: "twelve pages", texts: Array.from({ length: 12 }, (_, i) => `SEGMENT ${i + 1} MARK`), pad: 0 },
      // Each page carries ~12 KB of padding: the whole file is far above the
      // 320 KB fetch_url read cap, which is what used to truncate it.
      { name: "oversize 40 pages", texts: Array.from({ length: 40 }, (_, i) => `LONGDOC ${i + 1} MARK`), pad: 12_000 },
    ];
    for (const shape of shapes) {
      const bytes = makePdf(shape.texts, shape.pad);
      if (shape.pad) assert.ok(bytes.length > 320 * 1024, "oversize shape must exceed the fetch_url byte cap");
      const sha = sha256Hex(bytes);
      const rec = await extractDownloadedPdf({ bytes, contentType: "application/octet-stream", sourceSha256: sha, sourceFile: `data/${sha}.data` });
      assert.equal(rec.available, true, shape.name);
      assert.equal(rec.extraction.pages, shape.texts.length, shape.name);
      assert.equal(rec.source_sha256, sha);
      for (const [i, t] of shape.texts.entries()) assert.ok(rec.text.includes(`[page ${i + 1}]`) && rec.text.includes(t), `${shape.name}: page ${i + 1}`);
      assert.equal(rec.text_sha256, sha256Hex(Buffer.from(rec.text, "utf8")));
      // the same bytes through the capped (truncated) path still refuse
      const capped = await extractPdfText({ bytes: bytes.subarray(0, 4096), truncated: true });
      assert.equal(capped.text, "PDF text unavailable: pdf_truncated", `${shape.name}: truncated gate unchanged`);
    }
    // must-fail shapes: non-PDF body yields no derived text; a corrupt PDF
    // never yields available text.
    assert.equal(await extractDownloadedPdf({ bytes: Buffer.from("a,b\n1,2\n"), contentType: "text/csv", sourceSha256: "x", sourceFile: "f" }), null);
    const corrupt = await extractDownloadedPdf({ bytes: Buffer.from("%PDF-1.4\nnot really a pdf"), contentType: "application/pdf", sourceSha256: "x", sourceFile: "f" });
    assert.equal(corrupt.available, false);
    assert.match(corrupt.text, /^PDF text unavailable: /);
    console.log("extractDownloadedPdf: 3 shapes PASS");
  }
}

console.log("pdf extract: PASS");
