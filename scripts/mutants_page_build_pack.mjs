// Mutation check for test_page_build_pack.mjs (K1690): each mutant edits one rule in place, the test must fail, and the file is restored afterwards.
// Run: node scripts/mutants_page_build_pack.mjs   (one test run per mutant)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MUTANTS = [
  ["a program field of a chart is changed and not refused", "runtime/pi/design_pack.mjs", "    if (wrong.length) { problems.push({ step: \"charts\"", "    if (false) { problems.push({ step: \"charts\""],
  ["a program field of a page module is changed and not refused", "runtime/pi/design_pack.mjs", "if (module[key] !== undefined && String(module[key]) !== String(own[key])) wrong.push(", "if (false && module[key] !== undefined && String(module[key]) !== String(own[key])) wrong.push("],
  ["a patch that is not the latest rejection is still accepted", "runtime/pi/design_pack.mjs", "if (pack.patch_of !== last.ref) return stop(", "if (false) return stop("],
  ["one step fewer after the continuation (no publication) still RENDERED", "runtime/pi/design_pack.mjs", "    await publication(page, last.chartOut);\n    state.lastPack", "    state.lastPack"],
  ["a chart does not use the series computation but is still verified", "runtime/pi/newsroom.ts", "claim.computation_refs[1] : null;\n            if (typeof ref !== \"string\" || !ref) continue;\n            const record = await readArtifactJson(ref, \"computations/\");\n            const rows = Array.isArray(record?.rows)", "claim.computation_refs[0] : null;\n            if (typeof ref !== \"string\" || !ref) continue;\n            const record = await readArtifactJson(ref, \"computations/\");\n            const rows = Array.isArray(record?.rows)"],
  ["a pack result names an inner tool again", "runtime/pi/newsroom.ts", "patchThroughPack ? packSafeText(designPackText(out)) : designPackText(out)", "designPackText(out)"],
  ["the chain the pack runs loses its boundary context", "runtime/pi/newsroom.ts", "function packChainBoundary(tool: any) { return packPageBuildOn() ? withBoundaryContext(tool) : tool; }", "function packChainBoundary(tool: any) { return tool; }"],
  ["the chain the pack runs gets the boundary context also with page build off", "runtime/pi/newsroom.ts", "function packChainBoundary(tool: any) { return packPageBuildOn() ? withBoundaryContext(tool) : tool; }", "function packChainBoundary(tool: any) { return withBoundaryContext(tool); }"],
  ["the patch number check only looks at top-level strings", "runtime/pi/design_pack.mjs", "if (typeof value === \"string\") return [[path, value]];\n  if (Array.isArray(value))", "if (typeof value === \"string\") return [[path, value]];\n  return [];\n  if (Array.isArray(value))"],
  ["scene_graph is put back into the skipped keys", "runtime/pi/design_pack.mjs", "\"editorial_grammar\", \"pattern\"", "\"editorial_grammar\", \"scene_graph\", \"pattern\""],
  ["the vision critic result gets no next sentence", "runtime/pi/newsroom.ts", "${result.details?.passed ? VISION_NEXT_PASS : VISION_NEXT_REVISE}", ""],
  ["the story graph fills the publication step also with page build off", "runtime/pi/design_pack.mjs", "reader_question: page.params.reader_question ?? (deps.pageBuild ? pack.story_graph?.reader_question : undefined),", "reader_question: page.params.reader_question ?? pack.story_graph?.reader_question,", "test_design_pack.mjs"],
  ["the composer prints a skipped key (field) of a text module", "runtime/pi/infographic.mjs", "  if (module.source_quote) drawSourceQuoteBlock(parts, box.x, bodyTop + bodyHeight + 14, box.w, module.source_quote, mobile, spec);\n}", "  if (module.field) textBlock(parts, module.field, box.x, bodyTop + bodyHeight + 40, { size: 16, lineHeight: 23, fill: INK, maxChars: 40, maxLines: 2 });\n  if (module.source_quote) drawSourceQuoteBlock(parts, box.x, bodyTop + bodyHeight + 14, box.w, module.source_quote, mobile, spec);\n}"],
  ["needs_compute without runStop", "runtime/pi/design_pack.mjs", "      runStop = { reason: \"needs_compute\", step: \"design_pack\" };\n", ""],
];

const run = (test = "test_page_build_pack.mjs") => spawnSync("node", [join(ROOT, "scripts", test)], { encoding: "utf8", cwd: ROOT });
const baseline = run();
console.log(`baseline: exit ${baseline.status}`);
if (baseline.status !== 0) { console.log(baseline.stdout.slice(-800), baseline.stderr.slice(-800)); process.exit(1); }
let survived = 0;
for (const [label, file, from, to, test] of MUTANTS) {
  const path = join(ROOT, file);
  const original = readFileSync(path, "utf8");
  if (original.split(from).length !== 2) { console.log(`ERROR  ${label}: the text to mutate occurs ${original.split(from).length - 1} times`); survived += 1; continue; }
  try {
    writeFileSync(path, original.replace(from, () => to));
    const result = run(test);
    const failed = result.status !== 0;
    if (!failed) survived += 1;
    const why = (result.stderr.match(/AssertionError[^\n]*|Error: [^\n]*/) ?? [""])[0].slice(0, 160);
    console.log(`${failed ? "RED     " : "SURVIVED"} ${label}${failed ? `  (${why})` : ""}`);
  } finally {
    writeFileSync(path, original);
  }
}
console.log(survived ? `${survived} mutant(s) did not turn the test red` : "all mutants turned the test red");
process.exit(survived ? 1 : 0);
