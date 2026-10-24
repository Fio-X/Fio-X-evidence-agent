// Mutation check for the design pack: each entry puts one old or looser behaviour back into a copy of
// runtime/pi/design_pack.mjs and test_design_pack.mjs must fail on it. The copy lives in a fresh temp directory.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(root, "runtime/pi/design_pack.mjs"), "utf8");
const MUTATIONS = [
  ["a number in the model's words counts as no number", "return /\\p{Nd}/u.test(value) || numberWordIn(value) !== null;", "return false;"],
  ["a direction that disagrees is never refused", "const wrong = directionWordsIn(filledText).filter((kind) => kind !== expected);", "const wrong = [];"],
  ["a synonym is missing from the word list", 'down: Object.freeze(["下降", "减少", "下滑", "回落", "走低", "下跌"])', 'down: Object.freeze(["下降", "减少", "下滑", "走低", "下跌"])'],
  ["a rewrite skips the filler", "filled = await deps.fill(value, ctx.rows, ctx.plan);", "filled = { text: value, bindings: [] };"],
  ["a refused step is retried", "try { return await deps.call(tool, toolParams, label); } catch (error) {", "try { try { return await deps.call(tool, toolParams, label); } catch { return await deps.call(tool, toolParams, label); } } catch (error) {"],
  ["a third revision round is allowed", "export const MAX_REVISIONS = 2;", "export const MAX_REVISIONS = 3;"],
  ["a fourth judgement pack is run", "export const MAX_SUBMISSIONS = 3;", "export const MAX_SUBMISSIONS = 4;"],
  ["a chart type outside the table defaults to a static chart", "PUBLICATION_TYPES[type] : null;", "PUBLICATION_TYPES[type] : PUBLICATION_TYPES.line;"],
  ["an unjudged browser check passes", "if (qa.details?.judged === false)", "if (false)"],
  ["the text says the page is complete", "The page is NOT complete: look at the images", "The page is complete: look at the images"],
  ["the pack reads the auto-publish switch", "export const MAX_REVISIONS = 2;", "export const MAX_REVISIONS = process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS ? 2 : 2;"],
  ["the title length limit is gone", "chart_title: 40,", "chart_title: 4000,"],
  ["a sankey gets a drafting template", 'export const TEMPLATE_CHART_TYPES = Object.freeze(["horizontal_bar", "dot", "line", "choropleth"]);', 'export const TEMPLATE_CHART_TYPES = Object.freeze(["horizontal_bar", "dot", "line", "choropleth", "sankey"]);'],
  ["the audit names the scope as a source when it was dropped", 'from: withScope && whole !== null ?', 'from: Boolean(scope) ?'],
  ["a rewrite is not marked rewritten", 'origin: "model", rewritten: true, template: value, computation_ref', 'origin: "model", rewritten: false, template: value, computation_ref'],
  ["the table key check is gone", "if (forbidden.length) {", "if (false) {"],
  ["loading the module opens a connection", "export const MAX_REVISIONS = 2;", 'globalThis.fetch?.("http://127.0.0.1:9/x"); export const MAX_REVISIONS = 2;'],
  ["loading the module writes a file", "export const MAX_REVISIONS = 2;", 'globalThis.process.getBuiltinModule("node:fs").writeFileSync("side-effect.txt", "x"); export const MAX_REVISIONS = 2;'],
  ["loading the module registers a tool", "export const MAX_REVISIONS = 2;", 'globalThis.pi?.registerTool?.({}); export const MAX_REVISIONS = 2;'],
];
const dir = mkdtempSync(join(tmpdir(), "design-pack-mut-"));
let failed = 0;
try {
  for (const [name, from, to] of MUTATIONS) {
    const count = source.split(from).length - 1;
    if (count !== 1) { console.error(`BAD MUTATION (${count} matches): ${name}`); failed += 1; continue; }
    const file = join(dir, "design_pack.mjs");
    writeFileSync(file, source.replace(from, to));
    const run = spawnSync(process.execPath, [join(root, "scripts/test_design_pack.mjs")], { cwd: dir, env: { ...process.env, DESIGN_PACK_MODULE: file }, encoding: "utf8" });
    if (run.status === 0) { console.error(`NOT CAUGHT: ${name}`); failed += 1; } else console.log(`caught: ${name}`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (failed) { console.error(`design pack mutations: ${failed} problem(s) -- FAIL`); process.exit(1); }
console.log(`design pack mutations: ${MUTATIONS.length} caught -- PASS`);
