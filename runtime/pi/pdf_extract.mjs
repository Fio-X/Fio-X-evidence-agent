// PDF text extraction for fetch_url. A source's text is either faithfully
// extracted text, or an explicit statement that extraction was unavailable -
// it is never decoded binary. See runtime/pi/newsroom.ts's fetchText, which
// sniffs application/pdf (or a %PDF- body) before deciding whether to run
// readBodyText's UTF-8 decode or this module's pdftotext path.
import { randomBytes } from "node:crypto";
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
      extraction: { tool: "pdftotext", version, pages: pages.length },
    };
  } finally {
    try { await unlink(tempPath); } catch {}
  }
}
