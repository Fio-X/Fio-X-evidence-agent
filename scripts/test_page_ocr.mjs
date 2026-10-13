// NEWSROOM_PAGE_OCR_CHECK=1: newsroom_page_ocr_check reads a rendered page PNG back as text (macOS Vision) and compares it with the
// svg's <text>. Report only: findings are suspicions, nothing is a pass or fail record. Off: the tool does not exist.
// Parts 1-2 and 4 run everywhere (the reader's lines are given by the test); part 3 uses the real Vision reader and is
// skipped on every other system.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ocr = await import(join(ROOT, "runtime/pi/page_ocr.mjs"));
const results = [];
const check = (name) => { results.push(name); };

// ---- Part 1: the page, the tiles, the expected text -----------------------------------------
{
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0); header.writeUInt32BE(0x0d0a1a0a, 4); header.writeUInt32BE(13, 8); header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(1440, 16); header.writeUInt32BE(4805, 20);
  assert.deepEqual(ocr.pngSize(header), { width: 1440, height: 4805 });
  assert.throws(() => ocr.pngSize(Buffer.from("nope")), /not a PNG/);
  const tiles = ocr.tilePlan(4805);
  assert.equal(tiles.length, 7, "a 4805 px page is read in 7 tiles");
  assert.deepEqual(tiles[0], { y: 0, h: 1000 });
  assert.equal(tiles.at(-1).y + tiles.at(-1).h, 4805, "the last tile ends on the last row");
  for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i - 1].y + tiles[i - 1].h - tiles[i].y >= 300, `tiles ${i - 1} and ${i} overlap by at least 300 px`);
  assert.deepEqual(ocr.tilePlan(800), [{ y: 0, h: 800 }]);
  assert.deepEqual(ocr.tilePlan(1000), [{ y: 0, h: 1000 }]);
  assert.equal(ocr.tilePlan(1001).length, 2);
  assert.throws(() => ocr.tilePlan(0), /positive/);
  check("png size and 1000/300 tiling");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 100" font-size="12">
    <g font-size="20"><text x="1" y="2">Big &amp; bold</text><text style="font-size:6px">tiny label</text></g>
    <text x="3" y="4">Inherits root</text>
    <text display="none">Hidden text</text>
    <text><tspan>Two</tspan><tspan> parts</tspan></text>
    <title>Not a label</title><text/>
  </svg>`;
  const found = ocr.extractExpectedTexts(svg, { pngWidth: 1440 });
  assert.deepEqual(found.map((t) => [t.text, t.font_px]), [["Big & bold", 40], ["tiny label", 12], ["Inherits root", 24], ["Two parts", 24]]);
  assert.equal(ocr.extractExpectedTexts("<svg><text>No size</text></svg>")[0].font_px, null, "an unstated size is not guessed");
  assert.equal(ocr.normalizeText(" A-b, c。"), "abc");
  check("expected texts: entities, inherited and scaled sizes, hidden, tspans");

  const twice = ocr.dedupeLines([
    { text: "Idaho", x: 10, y: 700, w: 80, h: 20 }, { text: "Idaho", x: 10, y: 701, w: 80, h: 20 },
    { text: "Idaho", x: 10, y: 900, w: 80, h: 20 },
  ]);
  assert.equal(twice.length, 2, "the same line seen by two tiles is one; the same text elsewhere is another");
  check("lines seen by two overlapping tiles count once");
}

// ---- Part 2: findings, with the reader's lines given -----------------------------------------
const line = (text, y = 10, x = 10) => ({ text, x, y, w: 10 * text.length, h: 20 });
const exp = (text, font_px = 24) => ({ text, norm: ocr.normalizeText(text), font_px });
const kinds = (r) => r.findings.map((f) => f.kind).sort();
{
  const clean = ocr.compareReadBack({ expected: [exp("Wisconsin"), exp("Alabama"), exp("Total deaths")], lines: [line("Wisconsin", 10), line("Alabama", 50), line("Total deaths", 90)] });
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.exact_hits, 3);

  const misread = ocr.compareReadBack({ expected: [exp("美国的药物过量死亡"), exp("威斯康星")], lines: [line("美国药物过量死亡", 10), line("成斯康星", 50)] });
  assert.deepEqual(misread.findings, [], "one or two wrong characters are not findings");
  assert.equal(misread.fuzzy_hits, 2);

  const cut = ocr.compareReadBack({ expected: [exp("Massachusetts Institute")], lines: [line("Massachusett…", 10)] });
  assert.deepEqual(kinds(cut), ["ellipsis_not_in_expected"]);
  const dots = ocr.compareReadBack({ expected: [exp("Massachusetts Institute")], lines: [line("Massachusett...", 10)] });
  assert.deepEqual(kinds(dots), ["ellipsis_not_in_expected"], "three dots count as an ellipsis too");
  const legend = ocr.compareReadBack({ expected: [exp("…60% 及以上"), exp("Other")], lines: [line("…60% 及以上", 10), line("Other", 40)] });
  assert.deepEqual(legend.findings, [], "an ellipsis the svg itself prints is not a cut label");

  const twin = ocr.compareReadBack({ expected: [exp("Idaho"), exp("Wisconsin")], lines: [line("Idaho", 10), line("Idaho", 60)] });
  assert.deepEqual(kinds(twin), ["expected_text_not_found", "text_seen_more_often_than_expected"]);
  assert.equal(twin.findings.find((f) => f.kind === "text_seen_more_often_than_expected").seen_count, 2);
  assert.equal(twin.findings.find((f) => f.kind === "expected_text_not_found").text, "Wisconsin");

  const covered = ocr.compareReadBack({ expected: [exp("Hidden label")], lines: [line("zzzzzzzzzzz", 10)] });
  assert.deepEqual(kinds(covered), ["expected_text_not_found"]);

  const small = ocr.compareReadBack({ expected: [exp("Rhode Island", 9), exp("A", 24)], lines: [line("zzzzzzz", 10)] });
  assert.deepEqual(small.findings, [], "text under 12 px and one-character texts are not judged");
  assert.deepEqual(small.unjudgeable.map((u) => u.reason).sort(), ["small_font", "too_short"]);

  const numbers = ocr.compareReadBack({ expected: [exp("50"), exp("50")], lines: [line("50", 10), line("50", 50), line("50", 90)] });
  assert.deepEqual(numbers.findings, [], "repeated numbers are not names; they are not counted");
  check("findings: clean, misread, cut label, legend ellipsis, repeated name, covered text, small text");
}

// ---- Part 3: the tool, the switch, and the real reader -----------------------------------------
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
function loadTree(label) {
  const dir = makeTestTmp(`pageocr-tree-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return import(join(pi, "newsroom.test-copy.mjs")).then((mod) => ({ mod, dir }));
}
function register(mod, env) {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const TOOL = "newsroom_page_ocr_check";
const BASE_ENV = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_HIDE_LIEFLAT: undefined, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_MOBILE_PAGES: undefined };

const art = makeTestTmp("pageocr-art-");
process.env.NEWSROOM_ARTIFACT_DIR = art;
const { mod } = await loadTree("main");

{
  const off = register(mod, { ...BASE_ENV, NEWSROOM_PAGE_OCR_CHECK: undefined });
  assert.equal(off.has(TOOL), false, "switch off: the tool is not offered");
  for (const value of ["true", "0", "yes", " 1", "1 ", "on"]) assert.equal(register(mod, { ...BASE_ENV, NEWSROOM_PAGE_OCR_CHECK: value }).has(TOOL), false, `only the exact string "1" turns it on (${JSON.stringify(value)})`);
  const on = register(mod, { ...BASE_ENV, NEWSROOM_PAGE_OCR_CHECK: "1" });
  assert.equal(on.has(TOOL), true, "switch on: the tool is offered");
  const others = (tools) => JSON.stringify([...tools.keys()].filter((n) => n !== TOOL).sort());
  assert.equal(others(on), others(off), "the switch adds that tool and changes no other");
  const slim = (tools) => JSON.stringify([...tools].filter(([n]) => n !== TOOL).map(([n, t]) => [n, t.description, t.promptSnippet, t.promptGuidelines, t.parameters]).sort());
  assert.equal(slim(on), slim(off), "no other tool's definition changes");
  check("switch off: tool absent and every other definition equal; exact \"1\" only");
}

if (process.platform !== "darwin") {
  console.log(`SKIP: real reader part — Vision 仅 macOS (platform ${process.platform})`);
  results.push("SKIP real reader: Vision 仅 macOS");
} else {
  const work = makeTestTmp("pageocr-work-");
  process.env.HOME = join(work, "home"); // the compiled reader's cache goes here, not to the real home
  mkdirSync(process.env.HOME, { recursive: true });
  const renderer = join(work, "render");
  const built = spawnSync("swiftc", ["-O", join(ROOT, "scripts/page_ocr_fixture_render.swift"), "-o", renderer], { encoding: "utf8" });
  assert.equal(built.status, 0, `test renderer must compile: ${built.stderr}`);
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_PAGE_OCR_CHECK: "1" });
  const tool = tools.get(TOOL);
  mkdirSync(join(art, "pages"), { recursive: true });
  const makePage = (name, texts) => {
    const png = join(art, "pages", `${name}.png`);
    const run = spawnSync(renderer, [png, JSON.stringify({ width: 900, height: 300, texts })], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const svgTexts = texts.filter((t) => t.expected !== null).map((t) => `<text x="${t.x}" y="${t.y}" font-size="${t.size}">${t.expected ?? t.text}</text>`).join("");
    writeFileSync(join(art, "pages", `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300">${svgTexts}</svg>`);
    return { png: `pages/${name}.png`, svg: `pages/${name}.svg` };
  };
  const t = (text, y, extra = {}) => ({ text, x: 20, y, size: 28, ...extra });
  const before = readdirSync(join(art, "pages")).length;
  const reports = {};
  for (const [name, texts] of Object.entries({
    clean: [t("Wisconsin", 20), t("Total deaths", 100), t("Alabama", 180)],
    cut: [t("Wisconsin", 20), t("Massachusett…", 100, { expected: "Massachusetts Institute" }), t("Alabama", 180)],
    twin: [t("Wisconsin", 20), t("Wisconsin", 100, { expected: "Rhode Island" }), t("Alabama", 180)],
  })) {
    const page = makePage(name, texts);
    const result = await tool.execute("t", { png_ref: page.png, svg_ref: page.svg });
    assert.equal(result.details.available, true, `${name}: the reader ran`);
    const report = JSON.parse(readFileSync(join(art, result.details.reportRef), "utf8"));
    reports[name] = report;
    assert.match(result.details.reportRef, /^publications\/qa\/ocr-[0-9a-f]{24}\.json$/);
    for (const key of ["png_sha256", "svg_sha256", "tile_count", "expected_count", "exact_hits", "fuzzy_hits", "findings", "tool_version"]) assert.ok(key in report, `${name}: report has ${key}`);
    assert.equal(report.status_source, "program_report_only");
    assert.equal(JSON.stringify(report).includes('"passed"'), false, `${name}: no pass/fail field`);
    assert.equal(report.tile_count, 1);
    assert.equal(report.coverage.page_header_html_text, false);
  }
  assert.deepEqual(reports.clean.findings, [], "clean page: no findings");
  assert.deepEqual(reports.cut.findings.map((f) => f.kind), ["ellipsis_not_in_expected"], "cut label: one ellipsis finding");
  assert.deepEqual(reports.twin.findings.map((f) => f.kind).sort(), ["expected_text_not_found", "text_seen_more_often_than_expected"], "duplicated name: seen more often, and the lost one is not found");
  const again = await tool.execute("t", { png_ref: "pages/clean.png", svg_ref: "pages/clean.svg" });
  assert.equal(again.details.reportRef.startsWith("publications/qa/ocr-"), true, "a second run of the same page works");
  // it writes the reports and nothing else besides the pages the test made
  const written = readdirSync(join(art, "publications", "qa")).filter((n) => !/^ocr-[0-9a-f]{24}\.json$/.test(n));
  assert.deepEqual(written, [], "only ocr-<key>.json files are written");
  assert.equal(readdirSync(join(art, "pages")).length, before + 6, "the pages are untouched");
  await assert.rejects(() => tool.execute("t", { png_ref: "../x.png", svg_ref: "pages/clean.svg" }), /escapes|ENOENT/);
  await assert.rejects(() => tool.execute("t", { png_ref: "pages/clean.svg", svg_ref: "pages/clean.svg" }), /\.png/);
  check("real Vision reader: clean / cut label / duplicated name pages give exactly the expected findings; report-only");
}

console.log(`page ocr check: ${results.length} checks`);
for (const name of results) console.log(`  - ${name}`);
void existsSync;
