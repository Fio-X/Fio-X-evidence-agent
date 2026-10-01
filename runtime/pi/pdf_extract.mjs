// PDF text extraction for fetch_url. A source's text is either faithfully
// extracted text, or an explicit statement that extraction was unavailable -
// it is never decoded binary. See runtime/pi/newsroom.ts's fetchText, which
// sniffs application/pdf (or a %PDF- body) before deciding whether to run
// readBodyText's UTF-8 decode or this module's pdftotext path.
import { createHash, randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process.mjs";

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export const PDF_UNAVAILABLE_REASONS = Object.freeze([
  "pdftotext_not_found",
  "pdf_truncated",
  "extraction_failed",
]);

export function looksLikePdf(contentType, bytes) {
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("application/pdf")) return true;
  if (!bytes || bytes.byteLength < PDF_MAGIC_BYTES.length) return false;
  for (let i = 0; i < PDF_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== PDF_MAGIC_BYTES[i]) return false;
  }
  return true;
}

export function pdfUnavailableMessage(reason) {
  if (!PDF_UNAVAILABLE_REASONS.includes(reason)) {
    throw new Error(`Unknown PDF unavailable reason: ${reason}`);
  }
  return `PDF text unavailable: ${reason}`;
}

// pdftotext -layout separates pages with a form feed (\f) and, at least on
// poppler 26.x, emits a trailing form feed after the final page too. Treat
// that trailing empty segment as the separator it is, not an extra blank
// page, so the reported page count matches the document.
export function splitPdfPages(rawText) {
  const segments = String(rawText ?? "").split("\f");
  if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  return segments;
}

export function formatPagesWithMarkers(pages) {
  return pages.map((page, index) => `[page ${index + 1}]\n${page.trim()}`).join("\n\n");
}

async function pdftotextVersion(bin, signal) {
  const result = await runProcess(bin, ["-v"], signal, undefined, undefined, 8192, 5_000, true);
  const match = /pdftotext version (\S+)/.exec(`${result.stdout}\n${result.stderr}`);
  return match?.[1] ?? "unknown";
}

// Extracts text from a fetched PDF body, honoring the same size/time limits
// fetch_url already applies to the network read. Returns { text, extraction }
// where text is either the paginated extraction or one of the three
// PDF_UNAVAILABLE_REASONS messages, and extraction records enough provenance
// (tool, version, page count, or the unavailable reason) for both verifiers
// to audit later without re-running pdftotext themselves.
export async function extractPdfText({ bytes, truncated = false, signal, pdftotextBin, timeoutMs = 20_000 } = {}) {
  const bin = pdftotextBin || process.env.NEWSROOM_PDFTOTEXT_BIN || "pdftotext";

  // A body cut off by fetch_url's byte cap is not a complete PDF: poppler's
  // xref/trailer live at the end of the file, so a truncated fetch is never
  // safe to hand to pdftotext, however plausible the leading bytes look.
  if (truncated) {
    return {
      text: pdfUnavailableMessage("pdf_truncated"),
      extraction: { tool: "pdftotext", unavailable_reason: "pdf_truncated" },
    };
  }

  let version;
  try {
    version = await pdftotextVersion(bin, signal);
  } catch {
    return {
      text: pdfUnavailableMessage("pdftotext_not_found"),
      extraction: { tool: "pdftotext", unavailable_reason: "pdftotext_not_found" },
    };
  }

  const tempPath = join(tmpdir(), `newsroom-pdf-${randomBytes(12).toString("hex")}.pdf`);
  await writeFile(tempPath, bytes);
  try {
    let result;
    try {
      result = await runProcess(bin, ["-layout", "-enc", "UTF-8", tempPath, "-"], signal, undefined, undefined, 5_000_000, timeoutMs, true);
    } catch {
      return {
        text: pdfUnavailableMessage("extraction_failed"),
        extraction: { tool: "pdftotext", version, unavailable_reason: "extraction_failed" },
      };
    }
    if (result.code !== 0) {
      return {
        text: pdfUnavailableMessage("extraction_failed"),
        extraction: { tool: "pdftotext", version, unavailable_reason: "extraction_failed" },
      };
    }
    const pages = splitPdfPages(result.stdout);
    return {
      text: formatPagesWithMarkers(pages),
      pages,
      extraction: { tool: "pdftotext", version, pages: pages.length },
    };
  } finally {
    try { await unlink(tempPath); } catch {}
  }
}

// Row table of a PDF's layout text: one row per non-blank line,
// {page, line, x, text}. `line` is the 1-based line number within the page's
// layout text, `x` the character column of the first glyph, `text` the line
// without leading/trailing spaces. Rows are ordered by (page, line), so the
// same PDF always yields the same rows. Nothing is merged, dropped (other than
// blank lines), re-ordered, or unit-converted: repeated page headers, unit
// rows and subtotal rows stay as printed, for SQL to deal with explicitly.
export function pdfPagesToRows(pages) {
  const rows = [];
  pages.forEach((page, pageIndex) => {
    String(page).split("\n").forEach((raw, lineIndex) => {
      const line = raw.replace(/\r$/, "");
      const text = line.trim();
      if (!text) return;
      rows.push({ page: pageIndex + 1, line: lineIndex + 1, x: line.length - line.trimStart().length, text });
    });
  });
  return rows;
}

// Canonical bytes of a row table: one JSON object per line inside an array.
// DuckDB reads it directly with read_json_auto.
export function serializePdfRows(rows) {
  return `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
}

// download_data stores the complete body (up to its 25 MB cap), so unlike
// fetch_url's capped read the PDF is never truncated here and can be
// extracted in full. Returns null for non-PDF bodies. Otherwise returns the
// row table, its serialized bytes and a metadata record binding the table to
// the exact PDF bytes by sha256. The data file itself is never replaced.
export async function extractDownloadedPdf({ bytes, contentType, sourceSha256, sourceFile, signal, pdftotextBin, timeoutMs = 60_000 } = {}) {
  if (!looksLikePdf(contentType, bytes)) return null;
  const pdf = await extractPdfText({ bytes, truncated: false, signal, pdftotextBin, timeoutMs });
  const available = !pdf.extraction.unavailable_reason;
  if (!available) return { available: false, extraction: pdf.extraction, rows: [], rowsText: "", meta: null };
  const rows = pdfPagesToRows(pdf.pages);
  const rowsText = serializePdfRows(rows);
  const rowsFile = `data/derived/${sourceSha256}.pdf-rows.json`;
  return {
    available: true,
    extraction: pdf.extraction,
    rows,
    rowsText,
    rowsFile,
    meta: {
      schema_version: "0.2.0",
      kind: "pdf_row_table",
      source_sha256: sourceSha256,
      source_file: sourceFile,
      rows_file: rowsFile,
      rows_sha256: createHash("sha256").update(rowsText, "utf8").digest("hex"),
      row_count: rows.length,
      columns: ["page", "line", "x", "text"],
      extraction: pdf.extraction,
    },
  };
}
