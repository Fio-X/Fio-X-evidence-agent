#!/usr/bin/env node
// NEWSROOM_SPEED_CONTRACT_TEXT: statements are built from the checks' own constants, and the literals that stay in
// contract_text.mjs still equal the literals in the check source. Offline; calls the module directly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACT_LITERALS, contractStatements, loadGrammarRegistrySync } from "../runtime/pi/contract_text.mjs";
import { VISUAL_GRAMMAR_FORMS } from "../runtime/pi/infographic.mjs";
import { SVG_FORBIDDEN, SVG_MAX_BYTES, assertSafeSvg } from "../runtime/pi/svg_security.mjs";

const src = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const infographic = src("runtime/pi/infographic.mjs");
const validators = src("runtime/pi/editorial_validators.mjs");
const newsroom = src("runtime/pi/newsroom.ts");
const registry = loadGrammarRegistrySync(new URL("../runtime/pi/newsroom.ts", import.meta.url));
assert.ok(registry?.grammars?.length, "registry readable");
const readerTasks = new Set(newsroom.match(/SEMANTIC_REQUIRED_READER_TASKS = new Set\((\[[^\]]*\])\)/) ? JSON.parse(newsroom.match(/SEMANTIC_REQUIRED_READER_TASKS = new Set\((\[[^\]]*\])\)/)[1]) : []);
assert.ok(readerTasks.size >= 6, "reader task set found in newsroom.ts");
const build = (over = {}) => contractStatements({ readerTasks, visualGrammarForms: VISUAL_GRAMMAR_FORMS, registry, ...over });
const svgArgs = { svgForbidden: SVG_FORBIDDEN, svgMaxBytes: SVG_MAX_BYTES };
const base = build(svgArgs);

// 1. Every statement exists, and the set-built ones name every member of the check's own set.
for (const key of ["planAlt", "moduleAlt", "moduleClaimIds", "readerTask", "visualGrammar", "modules", "sceneAnchor", "deliveryRole", "heroUnit", "scaleType", "assetAvailable", "primaryGrammar", "svgAsset", "lintImmutable"]) assert.ok(base[key], `statement ${key}`);
for (const task of readerTasks) assert.ok(base.readerTask.includes(task), `readerTask names ${task}`);
for (const [grammar, forms] of Object.entries(VISUAL_GRAMMAR_FORMS)) for (const form of forms) assert.ok(base.visualGrammar.includes(`${grammar}: `) && base.visualGrammar.includes(form), `${grammar} lists ${form}`);
for (const g of registry.grammars) {
  assert.ok(base.primaryGrammar.includes(g.id), `registry grammar ${g.id}`);
  for (const f of g.required_evidence) assert.ok(base.primaryGrammar.includes(f), `${g.id} evidence ${f}`);
}

// 2. Changing a constant in a test copy changes the text.
assert.notEqual(build({ readerTasks: new Set([...readerTasks, "zz_task"]) }).readerTask, base.readerTask);
assert.ok(build({ readerTasks: new Set([...readerTasks, "zz_task"]) }).readerTask.includes("zz_task"));
const forms = { ...VISUAL_GRAMMAR_FORMS, rank: new Set(["zz_form"]) };
assert.ok(build({ visualGrammarForms: forms }).visualGrammar.includes("rank: zz_form"));
const reg2 = JSON.parse(JSON.stringify(registry)); reg2.grammars[0].required_evidence = ["zz_feature"];
assert.ok(build({ registry: reg2 }).primaryGrammar.includes("zz_feature"));
assert.equal(build({ registry: null }).primaryGrammar, undefined, "no registry: statement omitted");
for (const [key, field, text] of [["planAltMin", "planAlt", 31], ["illustrationAltMin", "moduleAlt", 21], ["minContentModules", "modules", 5], ["maxSidecars", "sceneAnchor", 4], ["minNodeCoverage", "modules", 0.7]]) {
  assert.ok(build({ literals: { ...CONTRACT_LITERALS, [key]: text } })[field].includes(String(key === "minNodeCoverage" ? Math.round(text * 100) : text)), `${key} flows into ${field}`);
}

// 3. Drift: each literal kept here is still the literal in the check.
const has = (source, re, what) => assert.ok(re.test(source), `check source no longer matches ${what}; update CONTRACT_LITERALS and the statement`);
const L = CONTRACT_LITERALS;
has(infographic, new RegExp(`String\\(spec\\.alt\\)\\.length < ${L.planAltMin}\\)`), "plan alt minimum");
has(infographic, new RegExp(`String\\(module\\.alt\\)\\.length < ${L.illustrationAltMin}\\) errors`), "illustration alt minimum");
has(infographic, new RegExp(`contentModules\\.length < ${L.minContentModules}\\)`), "content module minimum");
has(infographic, new RegExp(`visualModules\\.length \\+ illustrationModules\\.length < ${L.minVisualModules}\\)`), "visual module minimum");
has(infographic, new RegExp(`mappedDimensions\\.size < ${L.minStoryDimensions}\\)`), "story dimension minimum");
has(infographic, new RegExp(`nonSupportRelations\\.size < ${L.minNonSupportRelations}\\)`), "non-supports relation minimum");
has(infographic, new RegExp(`node_coverage < ${L.minNodeCoverage}\\)`), "node coverage minimum");
has(infographic, /\["resolution", "explanation"\]\.includes\(module\.story_role\)/, "resolution roles");
has(src("runtime/pi/story_graph.mjs"), /resolvedAnswers=graph\.answer_node_ids\.filter\(\(id\)=>resolution\.has\(id\)\)/, "resolved answers");
has(infographic, new RegExp(`sidecars\\.length > ${L.maxSidecars}`), "sidecar maximum");
has(infographic, /relation !== "supports"/, "non-supports relation rule");
has(infographic, /\["visual", "illustration"\]\.includes\(moduleById\.get\(anchor\)\?\.type\)/, "scene anchor type");
has(infographic, /text module '\$\{module\.id\}' requires claim_ids/, "text module claim_ids");
has(infographic, /illustration module '\$\{module\.id\}' requires claim_ids/, "illustration claim_ids");
has(validators, /encoding\.scale_type === 'log' && \(!\(Number\(encoding\.domain_min\) > 0\) \|\| !\(Number\(encoding\.domain_max\) > Number\(encoding\.domain_min\)\)\)/, "log domain");
has(validators, /\['horizontal_bar', 'diverging_bar'\]\.includes\(chartType\) && !\['zero', 'symmetric_zero'\]\.includes\(encoding\.baseline_policy\)/, "bar baseline");
has(src("runtime/pi/art_direction.mjs"), /if \(available && sourceRefs\.length === 0\)/, "available needs source_refs");
has(newsroom, /!params\.story_graph_ref \|\| !Array\.isArray\(params\.story_node_ids\) \|\| !params\.story_node_ids\.length\) throw new Error\("INFOGRAPHIC_MODULE_BINDING_REQUIRED/, "module binding rule");
has(validators, /=== 'trend' \? 'change'/, "trend counts as change");

// 4. K802: the SVG rule and the lint-immutability rule.
// 4a. svgAsset is built from the refusal list itself: every row's words and the byte limit are in it, and the check refuses on that same list.
for (const row of SVG_FORBIDDEN) assert.ok(base.svgAsset.includes(row[2]), `svgAsset names ${row[1]}`);
assert.ok(base.svgAsset.includes(String(SVG_MAX_BYTES)), "svgAsset names the byte limit");
assert.equal(build({}).svgAsset, undefined, "no list passed: statement omitted");
const svgSource = src("runtime/pi/svg_security.mjs");
assert.equal((svgSource.match(/pattern\.test\(value\)/g) || []).length, 1, "assertSafeSvg tests patterns in one place only");
assert.ok(/for\(const \[pattern,reason\] of SVG_FORBIDDEN\)/.test(svgSource), "assertSafeSvg refuses on SVG_FORBIDDEN and on nothing else");
// every row really refuses an svg carrying it, with its own reason in the message
const samples = { script: "<script>1</script>", foreignObject: "<foreignObject></foreignObject>", "event handler": "<rect onclick='x'/>", "external or active reference": "<a href='https://x'/>", "active embedded content": "<iframe></iframe>", "CSS import": "<style>@import 'x';</style>", "external CSS URL": "<rect style='fill:url(https://x)'/>" };
assert.deepEqual(SVG_FORBIDDEN.map((row) => row[1]).sort(), Object.keys(samples).sort(), "a new refusal needs a sample here and words in the description");
for (const [reason, sample] of Object.entries(samples)) assert.throws(() => assertSafeSvg(`<svg viewBox="0 0 1 1">${sample}</svg>`), new RegExp(`contains ${reason}`));
// mutation: a value added to the constant flows into the text, so a test copy with an unlisted word shows the drift
const grown = [...SVG_FORBIDDEN, [/zz/, "zz", "zz thing"]];
assert.ok(build({ svgForbidden: grown, svgMaxBytes: SVG_MAX_BYTES }).svgAsset.includes("zz thing"));
assert.throws(() => assert.deepEqual(grown.map((row) => row[1]).sort(), Object.keys(samples).sort()), "the sample table goes red when the constant grows");
// 4b. lintImmutable states what the code does: the lint file is keyed by plan and data hash, written once, and a different byte string at that path throws.
assert.ok(/const lintKey = sha256Hex\(JSON\.stringify\(\{ plan_ref: params\.plan_ref, data_hash: lint\.data_hash \}\)\);/.test(newsroom), "lint file key is plan_ref + data_hash");
assert.ok(/await writeArtifactIfAbsent\(lintRef, \{\s*\.\.\.lint,[\s\S]{0,200}?\.\.\.lintStamp,/.test(newsroom), "the lint file is written once and carries the verification stamp");
assert.ok(/Immutable artifact collision: existing bytes differ at/.test(newsroom), "the collision refusal exists");
assert.ok(/const key = sha256Hex\(JSON\.stringify\(specCore\)\);/.test(newsroom), "a plan is content-addressed, so an unchanged plan keeps its plan_ref");
assert.ok(base.lintImmutable.includes("immutable artifact collision") && base.lintImmutable.includes("newsroom_viz_plan"));
// wiring: the two sentences reach the tool definitions only through contractHint (off = untouched; test_tool_defs_unchanged pins that)
assert.ok(/asset_ref: Type\.Optional\(Type\.String\(contractHint\("svgAsset"\)\)\)/.test(newsroom), "publication module asset_ref carries svgAsset");
assert.ok(/contractTextEnabled\(\) \? " " \+ contractHint\("lintImmutable"\)\.description : ""/.test(newsroom), "viz_lint description carries lintImmutable");
console.log("test_contract_text: ok");
