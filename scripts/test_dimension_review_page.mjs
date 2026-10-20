#!/usr/bin/env node
// The blind page (scripts/build_dimension_review.mjs): outside its script block the page, the file names, the image paths, the alt text and every HTML
// attribute carry none of baseline / candidate / 对照 / 试验; the sides are drawn at random; the key sits beside the folder, not in it; six commands appear
// only after all six answers, the five items with --dimension and the total without, with the side mapped back to baseline/candidate.
// BUILDER=<path> runs the same checks on another copy of the builder (the mutants in test_dimension_review_page_mutants.py).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";

const builderPath = process.env.BUILDER || fileURLToPath(new URL("./build_dimension_review.mjs", import.meta.url));
const { buildDimensionReview } = await import(pathToFileURL(builderPath).href);
const scratch = mkdtempSync(join(tmpdir(), "dimreview-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const RUN = join(scratch, "run o'dir");
mkdirSync(join(RUN, "editorial", "x"), { recursive: true });
const BYTES = { baseline: PNG, candidate: Buffer.concat([PNG, Buffer.from("x")]) };
writeFileSync(join(RUN, "editorial/x/baseline-control.png"), BYTES.baseline);
writeFileSync(join(RUN, "editorial/x/candidate-试验.png"), BYTES.candidate);
const REL = { baseline: "editorial/x/baseline-control.png", candidate: "editorial/x/candidate-试验.png" };
const SIDE_WORDS = /baseline|candidate|对照|试验/i;
const build = (seed, name, over = {}) => buildDimensionReview({ outDir: join(scratch, name), run: RUN, ...REL, seed, ...over });
const withoutScript = (html) => html.replace(/<script>[\s\S]*?<\/script>/g, "");
const tagsAndText = (html) => withoutScript(html);  // visible text AND every attribute: the whole page but the script block

const seen = new Set();
for (let i = 0; i < 12; i++) {
  const r = build(`s${i}`, `out${i}`);
  seen.add(r.sideOf.A);
  const html = readFileSync(r.indexPath, "utf8");
  assert.doesNotMatch(tagsAndText(html), SIDE_WORDS, "page outside its script block has no side-identifying word");
  assert.ok(html.includes("<script>"), "the script block exists (the known weakness is stated in the builder)");
  const names = readdirSync(join(scratch, `out${i}`));
  assert.deepEqual(names.sort(), ["a.png", "b.png", "index.html"], "neutral file names only");
  for (const n of names) assert.doesNotMatch(n, SIDE_WORDS, "file names");
  for (const side of ["A", "B"]) assert.ok(readFileSync(join(scratch, `out${i}`, r.files[side])).equals(BYTES[r.sideOf[side]]), "each copied file is the source the mapping names");
  const key = JSON.parse(readFileSync(`${join(scratch, `out${i}`)}.key.json`, "utf8"));
  const scriptSide = JSON.parse(/const SIDE = (\{[^}]*\});/.exec(html)[1]);
  assert.deepEqual(key.sides, scriptSide, "the key file and the page's mapping agree");
  assert.deepEqual(Object.values(scriptSide).sort(), ["baseline", "candidate"], "the key names both sides once");
  assert.ok(!existsSync(join(scratch, `out${i}`, "key.json")) && existsSync(`${join(scratch, `out${i}`)}.key.json`), "key beside the folder, not in it");
  assert.doesNotMatch(withoutScript(html), /editorial\//, "no paths outside the script");
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 2);
  for (const tag of imgs) assert.doesNotMatch(tag, SIDE_WORDS, "image src and alt");
}
assert.equal(seen.size, 2, "both sides turn up as A across seeds");

// run the page script against a minimal DOM
function click(r, answers) {
  const html = readFileSync(r.indexPath, "utf8");
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  let handler; const els = { commands: { textContent: "" }, msg: { textContent: "" } };
  const doc = {
    getElementById: (id) => (id === "show" ? { addEventListener: (_, f) => { handler = f; } } : els[id]),
    querySelector: (sel) => { const m = /q(\d)/.exec(sel); const v = answers[Number(m[1])]; return v == null ? null : { value: v }; },
  };
  vm.runInNewContext(code, { document: doc });
  assert.equal(els.commands.textContent, "", "no command before the click");
  handler();
  return els;
}
const r = build("fixed", "fixed");
const A = r.sideOf.A, B = r.sideOf.B;
assert.notEqual(A, B);
const partial = click(r, ["A", "B", "tie", "A", null, "A"]);
assert.equal(partial.commands.textContent, "", "no commands until all six are answered");
const all = click(r, ["A", "B", "tie", "A", "B", "A"]);
const lines = all.commands.textContent.split("\n");
assert.equal(lines.length, 6);
const dims = ["informativeness", "chart_choice", "gist_at_a_glance", "numbers_units_sources", "looks_vs_reference"];
dims.forEach((d, i) => assert.ok(lines[i].includes(` --dimension ${d} `), `line ${i} carries its dimension`));
assert.ok(!lines[5].includes("--dimension"), "the total has no --dimension");
const want = [A, B, "tie", A, B, A];
lines.forEach((line, i) => assert.ok(line.endsWith(` --preference ${want[i]}`), `side mapped back, line ${i}: ${line}`));
const q = (v) => `'${v.replace(/'/g, "'\\''")}'`;
assert.ok(lines.every((l) => l.startsWith(`news review ${q(RUN)} --baseline ${q(REL.baseline)} --candidate ${q(REL.candidate)} --reviewer "你的名字" `)), "the paths news review takes: inside the run folder, shell-quoted, no hash");
assert.ok(lines.every((l) => !l.includes("@sha256") && !l.includes("<")), "no hash and no shell redirection in the commands");

// the five ids are the ones news review accepts
const rust = readFileSync(fileURLToPath(new URL("../src/commands/review.rs", import.meta.url)), "utf8");
const rustDims = [.../pub const DIMENSIONS: \[&str; 5\] = \[([^\]]*)\]/.exec(rust)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
assert.deepEqual(rustDims, dims, "the page's items are the ones news review accepts");

// each item's title goes with its id (a swap of two titles would ask one thing and record another)
const TITLE = { informativeness: "信息量", chart_choice: "图表选择", gist_at_a_glance: "一眼看懂", numbers_units_sources: "数字、单位、来源", looks_vs_reference: "好看" };
const legends = [...readFileSync(r.indexPath, "utf8").matchAll(/<legend>([^<]*)<\/legend>/g)].map((m) => m[1]);
assert.equal(legends.length, 6);
dims.forEach((d, i) => assert.ok(legends[i].startsWith(TITLE[d] + ":"), `item ${i} title matches its id ${d}: ${legends[i]}`));
assert.ok(legends[5].startsWith("总体"), "the last item is the total");

// a relative --run is written as an absolute path
const rel = buildDimensionReview({ outDir: join(scratch, "relrun"), run: relative(process.cwd(), RUN), ...REL, seed: "x" });
assert.ok(readFileSync(rel.indexPath, "utf8").includes(`const RUN = ${JSON.stringify(RUN)};`), "a relative run folder is resolved before it goes into the commands");

// refusals, with the same path rules news review applies
let n = 0;
const refuses = (over, re, message, outName = `refuse${++n}`) => assert.throws(() => build("r", outName, over), re, message);
refuses({ baseline: "/etc/hosts" }, /inside the run folder/, "refuses an absolute path");
refuses({ baseline: "../x.png" }, /inside the run folder/, "refuses a .. path");
refuses({ baseline: "editorial/x/missing.png" }, /not a file/, "refuses a missing file");
symlinkSync(join(RUN, REL.baseline), join(RUN, "editorial/x/link.png"));
refuses({ baseline: "editorial/x/link.png" }, /symbolic link/, "refuses a symbolic link");
writeFileSync(join(RUN, "editorial/x/other.jpg"), PNG);
refuses({ baseline: "editorial/x/other.jpg" }, /same extension/, "refuses different extensions");
mkdirSync(join(scratch, "busy")); writeFileSync(join(scratch, "busy", "left.txt"), "x");
refuses({}, /new or empty/, "refuses a non-empty output folder", "busy");
console.log("dimension review page: ok");
