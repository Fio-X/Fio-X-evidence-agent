// Page read-back (NEWSROOM_PAGE_OCR_CHECK=1, report only).
// The text a rendered page prints is read back with the macOS Vision framework and compared with the text the page's svg says it should print.
// Findings are structural and only suspicions: they are never a pass/fail record and no gate reads them.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_OCR_TOOL_VERSION = "page-ocr-1";
export const TILE_HEIGHT = 1000;
export const TILE_OVERLAP = 300;
export const SMALL_FONT_PX = 12;
export const MISSING_BELOW = 0.3;
export const FUZZY_FROM = 0.6;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// ---- the image -------------------------------------------------------------------------------

export function pngSize(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("not a PNG file");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// 1000 px tiles that overlap by 300 px; the last tile is moved up so it ends on the page's last row.
export function tilePlan(height, tile = TILE_HEIGHT, overlap = TILE_OVERLAP) {
  if (!Number.isInteger(height) || height < 1) throw new Error("page height must be a positive integer");
  if (height <= tile) return [{ y: 0, h: height }];
  const step = tile - overlap;
  const tiles = [];
  for (let y = 0; y + tile < height; y += step) tiles.push({ y, h: tile });
  tiles.push({ y: height - tile, h: tile });
  return tiles;
}

// ---- the expected text ---------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attr(attrs, name) {
  const found = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return found ? (found[1] ?? found[2]) : null;
}
function styleProp(attrs, name) {
  const style = attr(attrs, "style");
  if (!style) return null;
  const found = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
  return found ? found[1].trim() : null;
}
function fontSizeOf(attrs) {
  const raw = styleProp(attrs, "font-size") ?? attr(attrs, "font-size");
  if (!raw) return null;
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
function hidden(attrs) {
  const display = styleProp(attrs, "display") ?? attr(attrs, "display");
  const visibility = styleProp(attrs, "visibility") ?? attr(attrs, "visibility");
  return String(display ?? "").trim() === "none" || String(visibility ?? "").trim() === "hidden";
}

// Page pixels per svg unit: the png width over the svg's viewBox (or width) width.
function svgScale(svgText, pngWidth) {
  const root = /<svg\b([^>]*)>/i.exec(svgText);
  if (!root || !pngWidth) return 1;
  const box = attr(root[1], "viewBox");
  let unitWidth = null;
  if (box) { const parts = box.trim().split(/[\s,]+/).map(Number); if (parts.length === 4 && parts[2] > 0) unitWidth = parts[2]; }
  if (!unitWidth) { const width = parseFloat(attr(root[1], "width") ?? ""); if (width > 0) unitWidth = width; }
  return unitWidth ? pngWidth / unitWidth : 1;
}

export function normalizeText(text) {
  return String(text ?? "").normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

// Every visible <text> of the svg: {text, norm, font_px}. font_px is null when no font size is stated anywhere above the text.
export function extractExpectedTexts(svgText, { pngWidth = 0 } = {}) {
  const scale = svgScale(svgText, pngWidth);
  const out = [];
  const tag = /<(\/?)([a-zA-Z][\w:.-]*)\b([^>]*?)(\/?)>/g;
  const stack = [];
  let current = null;
  let last = 0;
  let match;
  while ((match = tag.exec(svgText))) {
    if (current) current.parts.push(svgText.slice(last, match.index));
    last = tag.lastIndex;
    const [, closing, name, attrs, selfClosing] = match;
    const lower = name.toLowerCase();
    if (closing) {
      if (current && lower === "text") {
        const text = decodeEntities(current.parts.join("")).replace(/\s+/g, " ").trim();
        if (text && !current.hidden) out.push({ text, norm: normalizeText(text), font_px: current.font === null ? null : Math.round(current.font * scale * 10) / 10 });
        current = null;
      }
      while (stack.length && stack[stack.length - 1].name !== lower) stack.pop();
      stack.pop();
      continue;
    }
    const own = fontSizeOf(attrs);
    const inheritedFont = own ?? [...stack].reverse().find((entry) => entry.font !== null)?.font ?? null;
    const inheritedHidden = hidden(attrs) || stack.some((entry) => entry.hidden);
    if (!selfClosing) stack.push({ name: lower, font: own, hidden: hidden(attrs) });
    if (lower === "text" && !current && !selfClosing) current = { parts: [], font: inheritedFont, hidden: inheritedHidden };
    else if (current && (lower === "tspan" || lower === "textpath")) {
      // a nested piece may state its own size; the smallest one decides whether the line is judgeable
      if (own !== null && (current.font === null || own < current.font)) current.font = own;
    }
  }
  return out;
}

// ---- reading the page back -----------------------------------------------------------------

const rectOverlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));

// The same line seen by two overlapping tiles: same text, same place.
export function dedupeLines(lines) {
  const kept = [];
  for (const line of lines) {
    const norm = normalizeText(line.text);
    if (!norm) continue;
    const twin = kept.find((other) => other.norm === norm && Math.abs((other.y + other.h / 2) - (line.y + line.h / 2)) <= Math.max(other.h, line.h) * 0.8 && rectOverlap(other, line) >= Math.min(other.w, line.w) * 0.5);
    if (!twin) kept.push({ ...line, norm });
  }
  return kept;
}

function editDistance(a, b) {
  const A = [...a], B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const row = [i];
    for (let j = 1; j <= B.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[B.length];
}
const ratio = (a, b) => (a.length === 0 && b.length === 0 ? 1 : 1 - editDistance(a, b) / Math.max([...a].length, [...b].length));

// Best similarity of the expected text to any stretch of a read-back line (a line may hold more than the one label).
function bestSimilarity(norm, ocrNorms) {
  const target = [...norm];
  let best = 0;
  for (const line of ocrNorms) {
    const chars = [...line];
    if (chars.length <= target.length + 1) { best = Math.max(best, ratio(norm, line)); continue; }
    for (let size = Math.max(1, target.length - 1); size <= target.length + 1; size++) {
      for (let at = 0; at + size <= chars.length; at++) best = Math.max(best, ratio(norm, chars.slice(at, at + size).join("")));
      if (best === 1) return 1;
    }
  }
  return best;
}

const hasWord = (norm) => /[\p{L}]/u.test(norm);

export function compareReadBack({ expected, lines }) {
  const read = dedupeLines(lines);
  const full = read.map((line) => line.norm).join("");
  const readNorms = read.map((line) => line.norm);
  const findings = [];
  const unjudgeable = [];
  let exact = 0, fuzzy = 0, missed = 0;
  const seen = new Set();
  for (const item of expected) {
    if (!item.norm) continue;
    if (item.norm.length < 2) { unjudgeable.push({ text: item.text, reason: "too_short" }); continue; }
    if (full.includes(item.norm)) { exact++; continue; }
    const similarity = bestSimilarity(item.norm, readNorms);
    if (similarity >= FUZZY_FROM) { fuzzy++; continue; }
    missed++;
    if (item.font_px !== null && item.font_px < SMALL_FONT_PX) { unjudgeable.push({ text: item.text, reason: "small_font", font_px: item.font_px }); continue; }
    if (similarity < MISSING_BELOW) {
      const key = `m:${item.norm}`;
      if (!seen.has(key)) { seen.add(key); findings.push({ kind: "expected_text_not_found", text: item.text, similarity: Math.round(similarity * 100) / 100, ...(item.font_px === null ? { font_px: null } : { font_px: item.font_px }) }); }
    }
  }
  // a read-back line with an ellipsis the svg does not have: a cut label
  for (const line of read) {
    if (!/[…]|\.\.\./.test(line.text)) continue;
    const stem = normalizeText(line.text.split(/…|\.\.\./)[0]);
    // the svg itself prints an ellipsis in this text (a legend like "…60%"): a text that merely starts like the read line is exactly the cut-off case
    const present = expected.some((item) => /[…]|\.\.\./.test(item.text) && item.norm.includes(line.norm));
    if (present) continue;
    findings.push({ kind: "ellipsis_not_in_expected", text: line.text, near_expected: stem ? expected.filter((item) => item.norm.startsWith(stem)).slice(0, 3).map((item) => item.text) : [] });
  }
  // the same text read more often than the svg prints it (two labels drawn with one name)
  const counts = new Map();
  for (const item of expected) if (item.norm) counts.set(item.norm, (counts.get(item.norm) ?? 0) + 1);
  const seenCounts = new Map();
  for (const line of read) seenCounts.set(line.norm, (seenCounts.get(line.norm) ?? 0) + 1);
  for (const [norm, times] of seenCounts) {
    const want = counts.get(norm) ?? 0;
    if (want > 0 && times > want && hasWord(norm) && norm.length >= 2) {
      const sample = expected.find((item) => item.norm === norm);
      findings.push({ kind: "text_seen_more_often_than_expected", text: sample.text, expected_count: want, seen_count: times });
    }
  }
  return { expected_count: expected.filter((item) => item.norm).length, exact_hits: exact, fuzzy_hits: fuzzy, not_found: missed, read_line_count: read.length, unjudgeable, findings };
}

// ---- Vision (macOS only) -----------------------------------------------------------------

export const SWIFT_SOURCE_PATH = fileURLToPath(new URL("./page_ocr.swift", import.meta.url));

function run(file, args, { timeout = 120_000 } = {}) {
  return new Promise((resolveRun) => {
    execFile(file, args, { timeout, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => resolveRun({ error, stdout, stderr }));
  });
}

export function visionAvailable() {
  return process.platform === "darwin";
}

// The compiled reader lives outside any run folder; its name carries the source hash, so a changed source compiles once more.
export async function ensureReader({ source, cacheDir = join(homedir(), "Library", "Caches", "news", "page-ocr") } = {}) {
  if (!visionAvailable()) return { ok: false, reason: "Vision 仅 macOS" };
  const swift = source ?? readFileSync(SWIFT_SOURCE_PATH, "utf8");
  const hash = sha256(swift).slice(0, 16);
  const binary = join(cacheDir, `page_ocr-${hash}`);
  if (existsSync(binary)) return { ok: true, binary, source_hash: hash };
  mkdirSync(cacheDir, { recursive: true });
  const sourceFile = join(cacheDir, `page_ocr-${hash}.swift`);
  writeFileSync(sourceFile, swift);
  const partial = `${binary}.partial-${process.pid}`;
  const built = await run("swiftc", ["-O", sourceFile, "-o", partial], { timeout: 300_000 });
  if (built.error || !existsSync(partial)) return { ok: false, reason: `swiftc is not usable here (${String(built.error?.code ?? "build failed")})` };
  renameSync(partial, binary);
  return { ok: true, binary, source_hash: hash };
}

export async function readPageBack({ pngPath, tiles, reader }) {
  const { error, stdout } = await run(reader.binary, [pngPath, JSON.stringify(tiles)], { timeout: 300_000 });
  if (error) throw new Error(`the page reader failed (${String(error.code ?? error.killed ?? "error")})`);
  const parsed = JSON.parse(stdout);
  return parsed.lines.map((line) => ({ text: String(line.text), x: Number(line.x), y: Number(line.y), w: Number(line.w), h: Number(line.h), tile: Number(line.tile) }));
}

// The whole check. `read` is injectable: (pngPath, tiles) => lines. Returns the report body (nothing is written here).
export async function pageOcrReport({ pngBytes, svgText, pngPath, read }) {
  const { width, height } = pngSize(pngBytes);
  const tiles = tilePlan(height);
  const expected = extractExpectedTexts(svgText, { pngWidth: width });
  const lines = await read(pngPath, tiles);
  const result = compareReadBack({ expected, lines });
  return {
    schema_version: "0.1.0",
    kind: "page_ocr_check",
    status_source: "program_report_only",
    png_sha256: sha256(Buffer.from(pngBytes)),
    read_sha256: sha256(JSON.stringify(dedupeLines(lines).map((line) => line.text))),
    svg_sha256: sha256(Buffer.from(svgText, "utf8")),
    png_width: width,
    png_height: height,
    tile_count: tiles.length,
    tool_version: PAGE_OCR_TOOL_VERSION,
    coverage: { svg_text: true, page_header_html_text: false },
    note: "Findings are suspicions from a text reader, not evidence and not a pass or fail. Page-header text that is HTML and not svg text is not compared.",
    ...result,
  };
}
