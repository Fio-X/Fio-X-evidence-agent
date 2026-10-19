#!/usr/bin/env node
// The blind page (scripts/build_dimension_review.mjs): outside its script block the page, the file names, the image paths, the alt text and every HTML
// attribute carry none of baseline / candidate / 对照 / 试验; the sides are drawn at random; the key sits beside the folder, not in it; six commands appear
// only after all six answers, the five items with --dimension and the total without, with the side mapped back to baseline/candidate.
// BUILDER=<path> runs the same checks on another copy of the builder (the mutants in test_dimension_review_page_mutants.py).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";

const builderPath = process.env.BUILDER || fileURLToPath(new URL("./build_dimension_review.mjs", import.meta.url));
const { buildDimensionReview } = await import(pathToFileURL(builderPath).href);
const scratch = mkdtempSync(join(tmpdir(), "dimreview-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
mkdirSync(join(scratch, "in"));
writeFileSync(join(scratch, "in", "baseline-control.png"), PNG);
writeFileSync(join(scratch, "in", "candidate-试验.png"), Buffer.concat([PNG, Buffer.from("x")]));
const SIDE_WORDS = /baseline|candidate|对照|试验/i;
const build = (seed, name) => buildDimensionReview({
  outDir: join(scratch, name), baseline: join(scratch, "in", "baseline-control.png"), candidate: join(scratch, "in", "candidate-试验.png"),
  baselineRef: "editorial/x/base.png@sha256:aa", candidateRef: "editorial/x/cand.png@sha256:bb", run: "RUN", seed,
});
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
  assert.ok(!existsSync(join(scratch, `out${i}`, "key.json")) && existsSync(`${join(scratch, `out${i}`)}.key.json`), "key beside the folder, not in it");
  assert.doesNotMatch(readFileSync(join(scratch, `out${i}`, "index.html"), "utf8").replace(/<script>[\s\S]*?<\/script>/, ""), /sha256|editorial\//, "no refs outside the script");
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
assert.ok(lines.every((l) => l.startsWith("news review RUN --baseline editorial/x/base.png@sha256:aa --candidate editorial/x/cand.png@sha256:bb --reviewer ")));
console.log("dimension review page: ok");
