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
  ["innerRecordOf ignores the pack's status", 'if (out?.status !== "RENDERED" || !Array.isArray(out.steps)) return {};', 'if (!Array.isArray(out?.steps)) return {};'],
  ["innerRecordOf accepts steps that are not a list", 'if (out?.status !== "RENDERED" || !Array.isArray(out.steps)) return {};', 'if (out?.status !== "RENDERED") return {};'],
  ["innerRecordOf does not check the step count", "out.steps.length === INNER_STEP_TOOLS.length && out.steps.every(", "out.steps.every("],
  ["innerRecordOf does not check the step order", "entry?.tool === INNER_STEP_TOOLS[index]", "INNER_STEP_TOOLS.includes(entry?.tool)"],
  ["the asset refusal loses its hint", '${tool === "newsroom_asset_requirements" ? assetSourceHint(error, toolParams) : ""}', ""],
  ["the asset hint names assets that do cite a source", " && !(Array.isArray(item?.source_refs) && item.source_refs.length));", ");"],
  ["the pack fills source_refs itself", "concept_id: pack.asset_requirements?.concept_id ?? refs.selectedConceptId });", 'concept_id: pack.asset_requirements?.concept_id ?? refs.selectedConceptId, requirements: (pack.asset_requirements?.requirements ?? []).map((r) => ({ ...r, source_refs: r.source_refs ?? ["data/file.csv"] })) });'],
  ["the asset hint goes back to any artifact the run holds", "Only two kinds of file can be a source_refs entry.", "Put in source_refs the path of an artifact this run already holds."],
  ["the asset hint drops the map route", "the output of newsroom_basemap_prepare, maps/basemaps/<name>.json", "any file"],
  ["the asset hint drops the illustration route", "the illustration manifest that newsroom_explainer_render wrote in this run, visualizations/illustrations/<name>.json", "any file"],
  ["the asset hint says any other file of the run will do", "and not any other file of the run.", "and any other file of the run will do."],
  ["the asset hint opens the list again with other words", "Nothing else is a source: not a data file", "Anything else the run holds is a source: not a data file"],
  ["the asset hint no longer says the tool comes first", "Run the tool first, then cite its output. ", ""],
  ["the asset hint drops a map class", "For a map (published_gis, geographic_coordinates)", "For a map (published_gis)"],
  ["the asset hint drops a drawn class", "(verified_diagram, vector_illustration, human_scale_reference)", "(verified_diagram, vector_illustration)"],
  ["the asset hint no longer says what available false costs", "That has a price: a required requirement that is not available makes the asset plan REVISE and a blocking one makes it RESEARCH_MORE, and the infographic plan is then refused. Do not change status to get past it.", ""],
  ["the asset hint advises changing the status", "Do not change status to get past it.", "Set status to optional to get past it."],
  ["the page plan does not get the asset plan ref", ", asset_plan_ref: refs.assetPlanRef };", " };"],
  ["a number in the model's words counts as no number", "return /\\p{Nd}/u.test(value) || numberWordIn(value) !== null;", "return false;"],
  ["a direction that disagrees is never refused", "const wrong = directionWordsIn(filledText).filter((kind) => kind !== expected);", "const wrong = [];"],
  ["a synonym is missing from the word list", 'down: Object.freeze(["下降", "减少", "下滑", "回落", "走低", "下跌"])', 'down: Object.freeze(["下降", "减少", "下滑", "走低", "下跌"])'],
  ["a rewrite skips the filler", "filled = await deps.fill(value, ctx.rows, ctx.plan);", "filled = { text: value, bindings: [] };"],
  ["a refused step is retried", "try { return await deps.call(tool, toolParams, label); } catch (error) {", "try { try { return await deps.call(tool, toolParams, label); } catch { return await deps.call(tool, toolParams, label); } } catch (error) {"],
  ["a third revision round is allowed", "export const MAX_REVISIONS = 2;", "export const MAX_REVISIONS = 3;"],
  ["a fourth judgement pack is run", "export const MAX_SUBMISSIONS = 3;", "export const MAX_SUBMISSIONS = 4;"],
  ["a chart type outside the table defaults to a static chart", "table[type] : null;", "table[type] : table.line;"],
  ["an unjudged browser check passes", "if (qa.details?.judged === false)", "if (false)"],
  ["the text says the page is complete", "The page is NOT complete: look at the images", "The page is complete: look at the images"],
  ["the pack reads the auto-publish switch", "export const MAX_REVISIONS = 2;", "export const MAX_REVISIONS = process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS ? 2 : 2;"],
  ["an out-of-order inner step list is handed over", "steps.every((entry, index) => entry.tool === INNER_STEP_TOOLS[index]) ? steps : null;", "steps.length ? steps : null;"],
  ["the browser report stays in the recorded QA step", "const { report: _report, ...details } = result?.details ?? {};", "const details = result?.details ?? {};"],
  ["the QA step is left out of the record", 'recordPublicationStep("newsroom_publication_qa",', '(() => {})("newsroom_publication_qa",'],
  ["the title length limit is gone", "chart_title: 40,", "chart_title: 4000,"],
  ["a sankey gets a drafting template", 'export const TEMPLATE_CHART_TYPES = Object.freeze(["horizontal_bar", "dot", "line", "choropleth"]);', 'export const TEMPLATE_CHART_TYPES = Object.freeze(["horizontal_bar", "dot", "line", "choropleth", "sankey"]);'],
  ["the audit names the scope as a source when it was dropped", 'from: withScope && whole !== null ?', 'from: Boolean(scope) ?'],
  ["a rewrite is not marked rewritten", 'origin: "model", rewritten: true, template: value, computation_ref', 'origin: "model", rewritten: false, template: value, computation_ref'],
  ["the table key check is gone", "if (forbidden.length) {", "if (false) {"],
  ["a refused step's problem is dropped when a hint is built", "problems.push({ step: label, message: `${String(error?.message ?? error)}${tool === \"newsroom_asset_requirements\" ? assetSourceHint(error, toolParams) : \"\"}${schemaHintFor(tool)}` });", "if (!schemaHintFor(tool)) problems.push({ step: label, message: String(error?.message ?? error) });"],
  ["a refused step carries no field table", "return text.length > HINT_LIMIT ?", "return HINT_LIMIT ? \"\" :"],
  ["the hint leaves out the allowed values", "if (Array.isArray(schema.enum)) return `one of ${schema.enum.map(String).join(\" | \")}`;", "if (Array.isArray(schema.enum)) return \"string\";"],
  ["a derived schema keeps the field the pack supplies", "filter(([key]) => !omit.includes(key))", "filter(([key]) => true)"],
  ["a call is never listed as finished", "ok(call) { finished.push(call.nested ? `${call.suffix}:*` : call.suffix); },", "ok(call) { void call; },"],
  ["a chain's entry does not reach its steps", "finished.push(call.nested ? `${call.suffix}:*` : call.suffix);", "finished.push(call.suffix);"],
  ["loading the module opens a connection", "export const MAX_REVISIONS = 2;", 'globalThis.fetch?.("http://127.0.0.1:9/x"); export const MAX_REVISIONS = 2;'],
  ["loading the module writes a file", "export const MAX_REVISIONS = 2;", 'globalThis.process.getBuiltinModule("node:fs").writeFileSync("side-effect.txt", "x"); export const MAX_REVISIONS = 2;'],
  ["loading the module registers a tool", "export const MAX_REVISIONS = 2;", 'globalThis.pi?.registerTool?.({}); export const MAX_REVISIONS = 2;'],
];
// Mutations of runtime/pi/groups.mjs: the pack's staging test must fail on each.
const groupsSource = readFileSync(join(root, "runtime/pi/groups.mjs"), "utf8");
const GROUPS_MUTATIONS = [
  ["a seen entry ending in :* names only its own folder", 'n === entry.slice(0, -2) || n.startsWith(entry.slice(0, -1))', 'n === entry.slice(0, -2)'],
  ["a seen entry ending in :* names every folder with the same start", 'n === entry.slice(0, -2) || n.startsWith(entry.slice(0, -1))', 'n === entry.slice(0, -2) || n.startsWith(entry.slice(0, -2))'],
  ["plain seen entries are de-duplicated", "const seen = [...plain, ...wild];", "const seen = [...new Set([...plain, ...wild])];"],
  ["a wildcard expansion is not de-duplicated against the plain entries", "n !== ctx.callId && !plain.includes(n));", "n !== ctx.callId);"],
  ["a wildcard entry's repeats are listed again", "const wild = [...new Set(entries.filter(isWild).flatMap(", "const wild = [...(entries.filter(isWild).flatMap("],
  ["every sibling folder is visible", "const seen = [...plain, ...wild];", "const seen = names.filter((n) => n !== ctx.callId);"],
];
// Mutations of the statement in runtime/pi/newsroom.ts that wraps the pack's outcome: the pack's test must fail on each.
const newsroomSource = readFileSync(join(root, "runtime/pi/newsroom.ts"), "utf8");
const NEWSROOM_MUTATIONS = [
  ["the wrapper builds no record from the pack outcome", "const innerRecord = innerRecordOf(out);", "const innerRecord = {};"],
  ["the wrapper hands over the steps whatever the pack's outcome", "const innerRecord = innerRecordOf(out);", 'const innerRecord = out.steps ? { chain: "newsroom_design_pack", chainStatus: "COMPLETE", steps: out.steps } : {};'],
  ["the chain's steps are emptied before the pack sees them", "steps: Array.isArray(details.steps) ? details.steps : [],", "steps: [],"],
  ["the chain's steps are read from the wrong key", "steps: Array.isArray(details.steps) ? details.steps : [],", "steps: Array.isArray(details.stepList) ? details.stepList : [],"],
  ["the details drop the record", "designPack: true, ...innerRecord,", "designPack: true,"],
];
const dir = mkdtempSync(join(tmpdir(), "design-pack-mut-"));
let failed = 0;
try {
  for (const [name, from, to] of MUTATIONS) {
    const count = source.split(from).length - 1;
    if (count !== 1) { console.error(`BAD MUTATION (${count} matches): ${name}`); failed += 1; continue; }
    const file = join(dir, "design_pack.mjs");
    writeFileSync(file, source.replace(from, to));
    const env = { ...process.env, DESIGN_PACK_MODULE: file };
    const runs = ["test_design_pack.mjs", "test_design_pack_staging.mjs"].map((test) => spawnSync(process.execPath, [join(root, "scripts", test)], { cwd: dir, env, encoding: "utf8" }));
    if (runs.every((run) => run.status === 0)) { console.error(`NOT CAUGHT: ${name}`); failed += 1; } else console.log(`caught: ${name}`);
  }
  for (const [name, from, to] of NEWSROOM_MUTATIONS) {
    const count = newsroomSource.split(from).length - 1;
    if (count !== 1) { console.error(`BAD MUTATION (${count} matches): ${name}`); failed += 1; continue; }
    const file = join(dir, "newsroom.ts");
    writeFileSync(file, newsroomSource.replace(from, to));
    const run = spawnSync(process.execPath, [join(root, "scripts/test_design_pack.mjs")], { cwd: dir, env: { ...process.env, NEWSROOM_TS: file }, encoding: "utf8" });
    if (run.status === 0) { console.error(`NOT CAUGHT: ${name}`); failed += 1; } else console.log(`caught: ${name}`);
  }
  for (const [name, from, to] of GROUPS_MUTATIONS) {
    const count = groupsSource.split(from).length - 1;
    if (count !== 1) { console.error(`BAD MUTATION (${count} matches): ${name}`); failed += 1; continue; }
    const file = join(dir, "groups.mjs");
    writeFileSync(file, groupsSource.replace(from, to));
    const run = spawnSync(process.execPath, [join(root, "scripts/test_design_pack_staging.mjs")], { cwd: dir, env: { ...process.env, GROUPS_MODULE: file }, encoding: "utf8" });
    if (run.status === 0) { console.error(`NOT CAUGHT: ${name}`); failed += 1; } else console.log(`caught: ${name}`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (failed) { console.error(`design pack mutations: ${failed} problem(s) -- FAIL`); process.exit(1); }
console.log(`design pack mutations: ${MUTATIONS.length + NEWSROOM_MUTATIONS.length + GROUPS_MUTATIONS.length} caught -- PASS`);
