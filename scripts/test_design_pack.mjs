// design pack (runtime/pi/design_pack.mjs): the program runs the design tools in order and drafts the design text.
// Fake tools stand in for every tool and artifact read. Each case guards one behaviour:
// scripts/test_design_pack_mutations.mjs puts each old behaviour back in a copy of the module and expects this file to fail.
// DESIGN_PACK_MODULE names the module under test (the mutation script points it at a mutated copy).
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { numberWordIn } from "../runtime/pi/number_words.mjs";

const modulePath = process.env.DESIGN_PACK_MODULE ?? fileURLToPath(new URL("../runtime/pi/design_pack.mjs", import.meta.url));
const pack = await import(pathToFileURL(modulePath).href);
const { runDesignPack, designPackText, hasNumber, directionOf, directionProblem, directionWordsIn, evenlySpaced, draftBeforeRows, rowTemplates, publicationModuleFor, DRAFT_FIELDS, schemaHint, exampleOf, derivedSchema, innerCallBook } = pack;
const MAX_REVISIONS = 2, MAX_SUBMISSIONS = 3; // the page's numbers, not read from the module under test

let checks = 0;
const check = (name, fn) => { try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; } checks += 1; };
const checkAsync = async (name, fn) => { try { await fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; } checks += 1; };

// ---- the claim filler's contract, in miniature: placeholders from rows only; typed digits and number words are refused ----
function fill(template, rows) {
  const bare = template.replace(/\{[^}]+\}/g, "");
  if (/\p{Nd}/u.test(bare)) throw new Error("CLAIM_TEMPLATE_ERROR: typed digits");
  if (numberWordIn(bare) !== null) throw new Error("CLAIM_TEMPLATE_ERROR: number word");
  const bindings = [];
  const text = template.replace(/\{(first|last|max|min)\.([^.}]+)(?:\.([^}]+))?\}/g, (_all, which, field, label) => {
    const list = rows;
    const pick = which === "first" ? list[0] : which === "last" ? list[list.length - 1] : [...list].sort((a, b) => (which === "max" ? b[field] - a[field] : a[field] - b[field]))[0];
    const value = label ? pick[label] : pick[field];
    bindings.push({ which, field, label: label ?? null, value });
    return String(value);
  }).replace(/\{(max|min)\.([^.}]+)\}/g, "");
  return { text, bindings };
}

const LINE_PLAN = { chart_type: "line", value_field: "v", time_field: "year", language: "zh", claim_id: "c1", measure_semantics: [{ field: "v", phenomenon: "出生率", scope: "中国" }], sql: "select year, v from t" };
const ROWS_DOWN = [{ year: 2000, v: 12.5 }, { year: 2001, v: 11.4 }, { year: 2002, v: 10.2 }];

function harness(options = {}) {
  const log = [];
  const rows = options.rows ?? ROWS_DOWN;
  const plan = options.plan ?? LINE_PLAN;
  const claim = Object.freeze({ claim: "出生率持续下降", source_refs: Object.freeze(["data/a.csv"]) });
  const refuse = options.refuse ?? {};
  const deps = {
    enabled: () => true,
    numberWordIn,
    call: async (tool, params) => {
      log.push({ tool, params });
      if (refuse[tool]) throw new Error(`${tool} refused: ${refuse[tool]}`);
      const details = {
        newsroom_editorial_discovery: { discoveryRef: "d" }, newsroom_story_graph: { storyGraphRef: "g" },
        newsroom_visual_concepts: { conceptRef: "c", selectedConceptId: "k" }, newsroom_semantic_novelty: { noveltyRef: "n" },
        newsroom_asset_requirements: { assetPlanRef: "a" }, newsroom_publication_plan: { planRef: "pp" },
        newsroom_publication_render: { htmlRef: "h", manifestRef: "pm" },
        newsroom_publication_qa: { passed: options.qaPassed ?? true, judged: options.qaJudged ?? true, reportRef: "publications/qa/x/browser-qa.json" },
      }[tool];
      return { content: [{ type: "text", text: "ok" }], details };
    },
    runChain: async (kind, params) => {
      log.push({ tool: `chain:${kind}`, params });
      if (refuse[`chain:${kind}`]) return { status: "STOPPED", failedAt: "newsroom_viz_lint", code: "STEP_REFUSED", message: refuse[`chain:${kind}`], report: "", state: {}, images: [] };
      return { status: "COMPLETE", state: kind === "viz" ? { planRef: "visualizations/plans/p", manifestRef: "visualizations/m", criticRef: "cr", computationRef: "computations/x" } : { planRef: "ip", manifestRef: "im", criticRef: "ic", previewRef: "pv" }, images: [] };
    },
    claim: async () => claim,
    sourceNote: async () => "host: label",
    rows: async () => rows,
    readJson: async (ref) => (ref.startsWith("visualizations/plans") ? plan : { variants: { desktop: "visualizations/a.svg" } }),
    fill: async (template, r) => fill(template, r),
    screenshot: async () => null,
  };
  return { deps, log, claim };
}
const chartInput = (extra = {}) => ({ ...LINE_PLAN, ...extra });
const packInput = (extra = {}) => ({
  discovery: {}, story_graph: { visual_thesis: "出生率在下降，原因待查" }, visual_concepts: {}, semantic_novelty: {}, asset_requirements: {},
  charts: [chartInput()],
  page: { modules: [{ id: "m1", type: "visual", chart: 0, story_node_ids: ["n1"], explanatory_dimension: "trend" }], primary_message: "出生率在下降。" },
  publication: {},
  ...extra,
});

// ---- direction words ----
check("synonyms of up and down are found, flat words too", () => {
  for (const word of ["上升", "增加", "增长", "走高", "攀升", "回升", "上涨"]) assert.deepEqual(directionWordsIn(`出生率${word}`), ["up"], word);
  for (const word of ["下降", "减少", "下滑", "回落", "走低", "下跌"]) assert.deepEqual(directionWordsIn(`出生率${word}`), ["down"], word);
  for (const word of ["持平", "基本不变"]) assert.deepEqual(directionWordsIn(`出生率${word}`), ["flat"], word);
});
check("a text that disagrees with the values is refused and echoed", () => {
  for (const word of ["回落", "走高", "攀升", "下滑", "回升", "走低"]) {
    const expected = ["回落", "下滑", "走低"].includes(word) ? "up" : "down";
    const problem = directionProblem(`出生率${word}`, expected);
    assert.match(problem ?? "", /DESIGN_PACK_DIRECTION/, word);
    assert.ok(problem.includes(`出生率${word}`), "echoes the filled text");
  }
  assert.equal(directionProblem("出生率下降", "down"), null);
  assert.equal(directionProblem("出生率下降", null), null);
});
check("known gaps are not refused (negation, comparison, piecewise): written down so nobody claims coverage", () => {
  assert.equal(directionProblem("出生率不再上升", "up"), null);
  assert.equal(directionProblem("出生率比上一期多", "down"), null);
  assert.equal(directionProblem("出生率先降后升", "up"), null);
});
check("direction of first vs last, 1% is level, non-numbers give null", () => {
  assert.equal(directionOf(10, 12), "up");
  assert.equal(directionOf(12, 10), "down");
  assert.equal(directionOf(100, 100.5), "flat");
  assert.equal(directionOf(0, 0), "flat");
  assert.equal(directionOf(null, 3), null);
  assert.equal(directionOf("x", 3), null);
});
check("only evenly spaced times get a trend sentence", () => {
  assert.equal(evenlySpaced([2000, 2001, 2002]), true);
  assert.equal(evenlySpaced([2000, 2001, 2005]), false);
  assert.equal(evenlySpaced([2000, 2001]), false);
  assert.equal(evenlySpaced(["2020-01", "2020-02", "2020-03"]), true);
  const out = rowTemplates(LINE_PLAN, [{ year: 2000, v: 1 }, { year: 2001, v: 2 }, { year: 2005, v: 3 }], numberWordIn);
  assert.equal(out.l3, null);
  assert.equal(out.direction, null);
});

// ---- numbers: placeholders only, and a model word with a number is not copied ----
check("number words and digits in the model's own words are detected", () => {
  for (const text of ["净变化最大的60个国家", "各八个国家", "十年", "两倍", "共有十个国家"]) assert.equal(hasNumber(text, numberWordIn), true, text);
  for (const text of ["一天", "唯一", "出生率", "中国"]) assert.equal(hasNumber(text, numberWordIn), false, text);
});
check("a scope with a number is not copied into the title; a phenomenon with a number gives no title", () => {
  const withScope = draftBeforeRows({ ...LINE_PLAN, measure_semantics: [{ field: "v", phenomenon: "净变化", scope: "净变化最大的60个国家" }] }, numberWordIn);
  assert.equal(withScope.title.text, "净变化");
  assert.equal(withScope.title.origin, "copied_model_text");
  assert.deepEqual(withScope.title.from, ["measure_semantics.phenomenon"]);
  const both = draftBeforeRows({ ...LINE_PLAN, measure_semantics: [{ field: "v", phenomenon: "各八个国家的净变化", scope: "x" }] }, numberWordIn);
  assert.equal(both.title, undefined);
  const ok = draftBeforeRows(LINE_PLAN, numberWordIn);
  assert.equal(ok.title.text, "出生率：中国");
  assert.deepEqual(ok.title.from, ["measure_semantics.phenomenon", "measure_semantics.scope"]);
});
check("a title over the length limit is not drafted whole", () => {
  const long = "出".repeat(41);
  const out = draftBeforeRows({ ...LINE_PLAN, measure_semantics: [{ field: "v", phenomenon: long, scope: "" }] }, numberWordIn);
  assert.equal(out.title, undefined);
});
await checkAsync("every number in a drafted sentence is a value of the chart's own rows", async () => {
  const { deps } = harness();
  const out = await runDesignPack(deps, packInput(), {});
  assert.equal(out.status, "RENDERED", designPackText(out));
  const allowed = new Set(ROWS_DOWN.flatMap((row) => [String(row.year), String(row.v)]));
  const numeric = Object.entries(out.drafts).filter(([path]) => /\.(l2|l3|body|dek|alt|accessibility_summary|accessibility_long_description)$/.test(path) && /placeholder/.test(JSON.stringify(out.audit.filter((row) => row.path === path))));
  assert.ok(numeric.length > 0, "some field was filled from placeholders");
  for (const [path, text] of numeric) for (const number of text.match(/\d+(\.\d+)?/g) ?? []) assert.ok(allowed.has(number), `${path} has ${number}, not a row value`);
});
await checkAsync("typed digits or number words in a rewrite are refused", async () => {
  for (const text of ["出生率下降了3%", "出生率下降了三成", "2020年出生率下降"]) {
    const { deps } = harness();
    const state = {};
    const first = await runDesignPack(deps, packInput(), state);
    assert.equal(first.status, "RENDERED");
    const out = await runDesignPack(deps, { revise: { "page.dek": text } }, state);
    assert.equal(out.status, "STOPPED", text);
    assert.match(out.problems.map((p) => p.message).join("\n"), /page\.dek/, text);
  }
});
await checkAsync("a rewrite with placeholders over the rows is accepted and audited as rewritten", async () => {
  const { deps } = harness();
  const state = {};
  const first = await runDesignPack(deps, packInput(), state);
  assert.ok(first.drafts["page.dek"] !== undefined);
  const out = await runDesignPack(deps, { revise: { "page.dek": "从{first.year}到{last.year}，出生率下降" } }, state);
  assert.equal(out.status, "RENDERED", designPackText(out));
  assert.equal(out.drafts["page.dek"], "从2000到2002，出生率下降");
  const row = out.audit.find((r) => r.path === "page.dek" && r.rewritten);
  assert.ok(row, "a rewritten row exists");
  assert.equal(row.origin, "model");
  assert.ok(row.bindings.length >= 2);
});
await checkAsync("a rewrite whose direction word contradicts the rows is refused with the filled text", async () => {
  const { deps } = harness();
  const state = {};
  await runDesignPack(deps, packInput(), state);
  const out = await runDesignPack(deps, { revise: { "page.dek": "从{first.year}到{last.year}，出生率上升" } }, state);
  assert.equal(out.status, "STOPPED");
  assert.match(out.problems[0].message, /DESIGN_PACK_DIRECTION/);
  assert.ok(out.problems[0].message.includes("从2000到2002，出生率上升"));
});
await checkAsync("a keep (=) leaves the draft and writes no rewritten row", async () => {
  const { deps } = harness();
  const state = {};
  const first = await runDesignPack(deps, packInput(), state);
  const out = await runDesignPack(deps, { revise: { "page.dek": "=" } }, state);
  assert.equal(out.status, "RENDERED");
  assert.equal(out.drafts["page.dek"], first.drafts["page.dek"]);
  assert.equal(out.audit.filter((r) => r.rewritten).length, 0);
});

// ---- the field white list and what the pack must not touch ----
await checkAsync("every drafted path is a white-listed field of its kind", async () => {
  const { deps } = harness();
  const out = await runDesignPack(deps, packInput(), {});
  const allowed = {
    chart: new Set(DRAFT_FIELDS.chart), page: new Set(DRAFT_FIELDS.page), module: new Set([...DRAFT_FIELDS.page_module, ...DRAFT_FIELDS.publication_module]),
  };
  for (const path of Object.keys(out.drafts)) {
    const key = path.split(".").pop();
    if (path.startsWith("charts[")) assert.ok(allowed.chart.has(key) || /^l[123]$/.test(key), path);
    else if (path.startsWith("page.modules.") || path.startsWith("publication.modules.")) assert.ok(allowed.module.has(key), path);
    else assert.ok(allowed.page.has(key), path);
  }
  for (const banned of ["chart_type", "encoding", "layout", "style_profile", "editorial_grammar", "sql", "claim_id", "claim"]) assert.ok(!Object.keys(out.drafts).some((path) => path.endsWith(`.${banned}`)), banned);
});
await checkAsync("the pack hands the chain the model's SQL and claim id unchanged and does not modify the claim record", async () => {
  const { deps, log, claim } = harness();
  const out = await runDesignPack(deps, packInput(), {});
  assert.equal(out.status, "RENDERED");
  const viz = log.find((entry) => entry.tool === "chain:viz");
  assert.equal(viz.params.sql, LINE_PLAN.sql);
  assert.equal(viz.params.claim_id, LINE_PLAN.claim_id);
  assert.equal(viz.params.takeaway, claim.claim, "takeaway is the claim's own sentence, verbatim");
  assert.ok(Object.isFrozen(claim));
});
await checkAsync("a takeaway the model sent is never replaced", async () => {
  const { deps, log } = harness();
  await runDesignPack(deps, packInput({ charts: [chartInput({ takeaway: "我自己的话" })] }), {});
  assert.equal(log.find((entry) => entry.tool === "chain:viz").params.takeaway, "我自己的话");
});

// ---- the chart-type table ----
check("each publication type comes from the table: static types carry the rendered SVG, sankey is plotly sankey", () => {
  const svg = publicationModuleFor(LINE_PLAN, { desktopSvgRef: "visualizations/a.svg", computationRef: "computations/x" });
  assert.deepEqual(svg, { type: "static_svg", asset_ref: "visualizations/a.svg" });
  const sankey = publicationModuleFor({ chart_type: "sankey", source_field: "s", target_field: "t", value_field: "v" }, { computationRef: "computations/x" });
  assert.equal(sankey.type, "plotly");
  assert.equal(sankey.engine, "plotly");
  assert.equal(sankey.visual_type, "sankey");
  assert.deepEqual(JSON.parse(sankey.field_mapping_json), { source: "s", target: "t", value: "v" });
  assert.equal(sankey.map_ref, undefined);
  for (const type of ["horizontal_bar", "dot", "choropleth"]) assert.equal(publicationModuleFor({ chart_type: type }, { desktopSvgRef: "x" }).type, "static_svg", type);
});
check("a chart type that is not in the table has no publication counterpart and is refused, never defaulted", () => {
  for (const type of ["treemap", "sunburst", "scatter", "statistical", "", undefined, "constructor", "__proto__", "toString"]) assert.throws(() => publicationModuleFor({ chart_type: type }, { desktopSvgRef: "x", computationRef: "c" }), /DESIGN_PACK_NO_PUBLICATION_TYPE/, String(type));
  assert.throws(() => publicationModuleFor(LINE_PLAN, { desktopSvgRef: null }), /no desktop variant/);
  assert.throws(() => publicationModuleFor({ chart_type: "sankey", value_field: "v" }, { computationRef: "c" }), /source_field/);
});
await checkAsync("a publication module that sends a table key is refused: the table is not the model's to override", async () => {
  const { deps } = harness();
  const out = await runDesignPack(deps, packInput({ publication: { modules: [{ id: "m1", type: "plotly", visual_type: "scatter" }] } }), {});
  assert.equal(out.status, "STOPPED");
  assert.match(out.problems[0].message, /DESIGN_PACK_PUBLICATION_TYPE_FIXED/);
});
await checkAsync("a chart type outside the table stops that chart with the reason", async () => {
  const plan = { ...LINE_PLAN, chart_type: "treemap" };
  const { deps, log } = harness({ plan });
  const out = await runDesignPack(deps, packInput({ charts: [chartInput({ chart_type: "treemap" })] }), {});
  assert.equal(out.status, "STOPPED");
  assert.match(out.problems.map((p) => p.message).join("\n"), /DESIGN_PACK_NO_PUBLICATION_TYPE/);
  assert.ok(!log.some((entry) => entry.tool === "newsroom_publication_plan"), "no publication plan for a page that cannot be published");
});
check("a chart type with no template (sankey, heat map, multi series) is not drafted", () => {
  for (const type of ["sankey", "heatmap", "multi_line", "treemap"]) {
    assert.equal(rowTemplates({ ...LINE_PLAN, chart_type: type }, ROWS_DOWN, numberWordIn), null, type);
    assert.equal(draftBeforeRows({ ...LINE_PLAN, chart_type: type, measure_semantics: [] }, numberWordIn).l1, undefined, type);
  }
  for (const type of ["horizontal_bar", "dot", "line", "choropleth"]) assert.ok(rowTemplates({ ...LINE_PLAN, chart_type: type, category_field: "c" }, ROWS_DOWN, numberWordIn), type);
});
await checkAsync("a sankey chart runs without drafted title, alt or captions, and says so", async () => {
  const plan = { ...LINE_PLAN, chart_type: "sankey", source_field: "s", target_field: "t", measure_semantics: [{ field: "v", phenomenon: "能源流向", scope: "德国" }] };
  const { deps, log } = harness({ plan });
  const out = await runDesignPack(deps, packInput({ charts: [chartInput({ chart_type: "sankey", source_field: "s", target_field: "t" })] }), {});
  assert.equal(out.status, "RENDERED", designPackText(out));
  const viz = log.find((entry) => entry.tool === "chain:viz");
  assert.equal(viz.params.title, undefined);
  assert.equal(viz.params.alt, undefined);
  assert.ok(out.notes.some((note) => /no drafting template/.test(note)));
  const publication = log.find((entry) => entry.tool === "newsroom_publication_plan");
  assert.equal(publication.params.modules[0].visual_type, "sankey");
});

// ---- order, no retry, limits, no completion claim ----
await checkAsync("the tools run in order, each through the deps (their own execute)", async () => {
  const { deps, log } = harness();
  const out = await runDesignPack(deps, packInput(), {});
  assert.equal(out.status, "RENDERED", designPackText(out));
  assert.deepEqual(log.map((entry) => entry.tool), [
    "newsroom_editorial_discovery", "newsroom_story_graph", "newsroom_visual_concepts", "newsroom_semantic_novelty", "newsroom_asset_requirements",
    "chain:viz", "chain:infographic", "newsroom_publication_plan", "newsroom_publication_render", "newsroom_publication_qa",
  ]);
});
await checkAsync("a refused step is reported and never retried with other parameters", async () => {
  for (const refused of ["newsroom_story_graph", "newsroom_publication_plan", "chain:viz"]) {
    const { deps, log } = harness({ refuse: { [refused]: "bad field" } });
    const out = await runDesignPack(deps, packInput(), {});
    assert.equal(out.status, "STOPPED", refused);
    assert.equal(log.filter((entry) => entry.tool === refused).length, 1, `${refused} ran once`);
    assert.match(designPackText(out), /nothing was retried/);
  }
});
// ---- what a refused step says: the sub-tool's own field table, allowed values and one passing shape; the refusal itself is untouched ----
const NODE_SCHEMA = { type: "object", required: ["nodes", "edges"], properties: {
  nodes: { type: "array", minItems: 1, items: { type: "object", required: ["id", "kind"], properties: { id: { type: "string" }, kind: { type: "string", enum: ["entry", "answer"] }, note: { type: "string" } } } },
  edges: { type: "array", items: { type: "object", required: ["relation"], properties: { relation: { type: "string", enum: ["causal", "spatial"] } } } },
  title: { type: "string" },
} };
check("the hint lists required and optional fields, the allowed values and one passing shape", () => {
  const hint = schemaHint("newsroom_story_graph", NODE_SCHEMA);
  assert.match(hint, /nodes: array of \{id: string; kind: one of entry \| answer; note\?: string\}/);
  assert.match(hint, /edges: array of \{relation: one of causal \| spatial\}/);
  assert.match(hint, /title\?: string/);
  assert.match(hint, /One shape that passes the type check: \{"nodes":\[\{"id":"\.\.\.","kind":"entry"\}\],"edges":\[\{"relation":"causal"\}\]\}/);
  assert.deepEqual(exampleOf(NODE_SCHEMA).edges, [{ relation: "causal" }]);
});
check("no object schema, no hint; a long table is cut", () => {
  assert.equal(schemaHint("t", undefined), "");
  assert.equal(schemaHint("t", { type: "string" }), "");
  const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 200 }, (_v, i) => [`field_number_${i}`, { type: "string" }])) };
  assert.ok(schemaHint("t", wide).length < 1700);
});
check("a derived schema drops what the pack supplies and makes the defaulted field optional, from the sub-tool's own schema", () => {
  const own = { type: "object", required: ["concept_ref", "concept_id", "assets"], properties: { concept_ref: { type: "string" }, concept_id: { type: "string" }, assets: { type: "array" } } };
  const derived = derivedSchema(own, { omit: ["concept_ref"], optional: ["concept_id"] });
  assert.deepEqual(Object.keys(derived.properties), ["concept_id", "assets"]);
  assert.deepEqual(derived.required, ["assets"]);
  assert.equal(derived.properties.assets, own.properties.assets, "same field object, not a copy by hand");
  assert.deepEqual(own.required, ["concept_ref", "concept_id", "assets"], "the sub-tool's schema is untouched");
  assert.equal(derivedSchema(undefined), null);
  assert.equal(derivedSchema({ type: "string" }), null);
});
await checkAsync("a refused step keeps its own message and gains the hint; the refusal itself is the same with or without a schema", async () => {
  const schemas = { newsroom_story_graph: NODE_SCHEMA };
  const withHint = harness({ refuse: { newsroom_story_graph: "params.nodes is not iterable" } });
  withHint.deps.schemaOf = (tool) => schemas[tool];
  const plain = harness({ refuse: { newsroom_story_graph: "params.nodes is not iterable" } });
  const a = await runDesignPack(withHint.deps, packInput(), {});
  const b = await runDesignPack(plain.deps, packInput(), {});
  assert.equal(a.status, "STOPPED");
  assert.equal(a.status, b.status);
  assert.equal(a.problems.length, b.problems.length);
  assert.equal(withHint.log.filter((e) => e.tool === "newsroom_story_graph").length, 1, "never retried");
  const problem = a.problems.find((p) => /story_graph/.test(p.step));
  assert.ok(problem.message.startsWith("newsroom_story_graph refused: params.nodes is not iterable"));
  assert.match(problem.message, /kind: one of entry \| answer/);
  assert.equal(b.problems.find((p) => /story_graph/.test(p.step)).message, "newsroom_story_graph refused: params.nodes is not iterable");
  assert.deepEqual(withHint.log.map((e) => e.tool), plain.log.map((e) => e.tool), "the same tools ran");
  const broken = harness({ refuse: { newsroom_story_graph: "x" } });
  broken.deps.schemaOf = () => { throw new Error("no schema"); };
  assert.equal((await runDesignPack(broken.deps, packInput(), {})).status, "STOPPED", "a failing schema lookup never turns a refusal into a pass");
});
check("the inner call book names each call after the ones that returned, a chain's entry ends in :*, a failed call is not listed", () => {
  const book = innerCallBook("p");
  const a = book.next("newsroom_editorial_discovery");
  assert.equal(a.callId, "p:s1:newsroom_editorial_discovery");
  assert.deepEqual(a.finished, []);
  book.ok(a);
  const b = book.next("newsroom_visual_concepts");
  assert.deepEqual(b.finished, ["s1:newsroom_editorial_discovery"]);
  const failed = book.next("newsroom_semantic_novelty"); // not ok()
  const c = book.next("newsroom_viz_chain", { nested: true });
  assert.deepEqual(c.finished, ["s1:newsroom_editorial_discovery"], "b and the failed call are not listed");
  book.ok(c);
  assert.deepEqual(book.next("x").finished, ["s1:newsroom_editorial_discovery", "s4:newsroom_viz_chain:*"]);
  assert.equal(failed.callId, "p:s3:newsroom_semantic_novelty");
});
await checkAsync("a refused first-half step stops the later steps that need it and says which", async () => {
  const { deps, log } = harness({ refuse: { newsroom_editorial_discovery: "no" } });
  const out = await runDesignPack(deps, packInput(), {});
  assert.equal(out.status, "STOPPED");
  assert.ok(!log.some((entry) => entry.tool === "newsroom_visual_concepts"));
  assert.ok(out.problems.some((p) => /newsroom_visual_concepts/.test(p.step)));
  assert.ok(!log.some((entry) => entry.tool === "chain:viz"), "no chart after a refused first half");
});
await checkAsync("at most two revision rounds", async () => {
  const { deps } = harness();
  const state = {};
  await runDesignPack(deps, packInput(), state);
  for (let round = 1; round <= MAX_REVISIONS; round += 1) assert.equal((await runDesignPack(deps, { revise: { "page.dek": "=" } }, state)).status, "RENDERED", `round ${round}`);
  const third = await runDesignPack(deps, { revise: { "page.dek": "=" } }, state);
  assert.equal(third.status, "STOPPED");
  assert.match(third.problems[0].message, /DESIGN_PACK_REVISION_LIMIT/);
});
await checkAsync("the judgement pack is run at most three times", async () => {
  const { deps } = harness({ refuse: { newsroom_story_graph: "no" } });
  const state = {};
  for (let send = 1; send <= MAX_SUBMISSIONS; send += 1) assert.equal((await runDesignPack(deps, packInput(), state)).problems[0].step !== "pack", true, `send ${send}`);
  const fourth = await runDesignPack(deps, packInput(), state);
  assert.match(fourth.problems[0].message, /DESIGN_PACK_SUBMISSION_LIMIT/);
});
await checkAsync("revise names only drafted fields and needs a rendered page", async () => {
  const { deps } = harness();
  const none = await runDesignPack(deps, { revise: { "page.dek": "=" } }, {});
  assert.match(none.problems[0].message, /DESIGN_PACK_NO_PAGE/);
  const state = {};
  await runDesignPack(deps, packInput(), state);
  const unknown = await runDesignPack(deps, { revise: { "page.nonsense": "=" } }, state);
  assert.match(unknown.problems[0].message, /DESIGN_PACK_REVISE_INVALID/);
  assert.equal(state.revisions ?? 0, 0, "a refused revise does not use a round");
});
await checkAsync("the halves: second before first is refused; first then second runs the whole chain", async () => {
  const { deps, log } = harness();
  const state = {};
  const early = await runDesignPack(deps, packInput({ part: "second" }), state);
  assert.match(early.problems[0].message, /DESIGN_PACK_FIRST_HALF_MISSING/);
  const first = await runDesignPack(deps, packInput({ part: "first" }), state);
  assert.equal(first.status, "FIRST_HALF_DONE");
  assert.equal(log.filter((entry) => entry.tool === "newsroom_editorial_discovery").length, 1);
  const second = await runDesignPack(deps, packInput({ part: "second" }), state);
  assert.equal(second.status, "RENDERED", designPackText(second));
  assert.equal(log.filter((entry) => entry.tool === "newsroom_editorial_discovery").length, 1, "the first half is not run again");
  const bad = await runDesignPack(deps, packInput({ part: "third" }), {});
  assert.match(bad.problems[0].message, /DESIGN_PACK_PART_INVALID/);
});
await checkAsync("the pack never says the page is complete and sends the model to the vision critic", async () => {
  const { deps } = harness();
  const out = await runDesignPack(deps, packInput(), {});
  const text = designPackText(out);
  assert.match(text, /NOT complete/);
  assert.match(text, /newsroom_infographic_vision_critic/);
  assert.ok(!/\bcomplete[d]?\b(?! )/i.test(text.replace(/NOT complete/g, "")) || !/page is complete/i.test(text.replace(/NOT complete/g, "")));
});
await checkAsync("a browser check that did not judge is not a pass, and neither is a failed one", async () => {
  const unjudged = await runDesignPack(harness({ qaJudged: false, qaPassed: false }).deps, packInput(), {});
  assert.equal(unjudged.status, "STOPPED");
  assert.match(unjudged.problems.map((p) => p.message).join("\n"), /DESIGN_PACK_QA_NOT_JUDGED/);
  const failed = await runDesignPack(harness({ qaPassed: false }).deps, packInput(), {});
  assert.equal(failed.status, "STOPPED");
  assert.match(failed.problems.map((p) => p.message).join("\n"), /DESIGN_PACK_QA_FAILED/);
  assert.deepEqual(unjudged.images, []);
});
await checkAsync("the pack calls render and QA itself and does not read the auto-publish switch", async () => {
  const { deps, log } = harness();
  const before = process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS;
  for (const value of [undefined, "1"]) {
    if (value === undefined) delete process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS; else process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS = value;
    log.length = 0;
    await runDesignPack(deps, packInput(), {});
    assert.ok(log.some((entry) => entry.tool === "newsroom_publication_render"), `render called (switch ${value})`);
    assert.ok(log.some((entry) => entry.tool === "newsroom_publication_qa"), `qa called (switch ${value})`);
  }
  if (before === undefined) delete process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS; else process.env.NEWSROOM_SPEED_AUTO_PUBLISH_CHECKS = before;
  const source = (await import("node:fs")).readFileSync(modulePath, "utf8");
  assert.ok(!/AUTO_PUBLISH|process\.env/.test(source), "the module reads no environment");
});

// ---- importing the module (it is loaded in every run, switch on or off) does nothing: no registration, no file, no network ----
await checkAsync("importing the module registers nothing, writes no file and opens no connection", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const source = readFileSync(modulePath, "utf8");
  assert.ok(!/^\s*import\b|\brequire\(|\bimport\(/m.test(source), "the module imports nothing, statically or dynamically");
  const dir = mkdtempSync(join(tmpdir(), "design-pack-import-"));
  try {
    const probe = `
      import fs from "node:fs"; import net from "node:net"; import { syncBuiltinESMExports } from "node:module";
      const touched = [];
      for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "createWriteStream", "renameSync", "copyFileSync", "rmSync", "unlinkSync"]) {
        fs[name] = () => { touched.push("fs." + name); throw new Error("blocked"); };
      }
      net.Socket.prototype.connect = function () { touched.push("net.connect"); throw new Error("blocked"); };
      globalThis.fetch = () => { touched.push("fetch"); throw new Error("blocked"); };
      globalThis.pi = new Proxy({}, { get(_t, key) { touched.push("pi." + String(key)); throw new Error("blocked"); } });
      syncBuiltinESMExports();
      let loadError = null;
      try { await import(process.env.DESIGN_PACK_PROBE_URL); } catch (error) { loadError = String(error?.message ?? error); }
      console.log(JSON.stringify({ touched, loadError }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, DESIGN_PACK_PROBE_URL: pathToFileURL(modulePath).href } });
    assert.equal(run.status, 0, run.stderr);
    const seen = JSON.parse(run.stdout.trim().split("\n").pop());
    assert.deepEqual(seen, { touched: [], loadError: null }, "nothing was touched while the module loaded");
    assert.deepEqual(readdirSync(dir), [], "the working folder is still empty");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`design pack: ${checks} checks -- PASS`);
