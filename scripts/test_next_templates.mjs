// New route (NEWSROOM_NEXT=1, `deps.next` in the design pack): the template rows the shape registry picks from, the flow (sankey) and
// composition (stacked_bar_100) drafting templates, and the sheet reading the registry's pick. With the switch off nothing changes: the drafts,
// notes and refusals equal the base commit's module on the same input. BASE_DESIGN_PACK names that module (a copy of the base file); without it
// the off comparison is reported as not run and the script fails.
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { numberWordIn } from "../runtime/pi/number_words.mjs";

const modulePath = process.env.DESIGN_PACK_MODULE ?? fileURLToPath(new URL("../runtime/pi/design_pack.mjs", import.meta.url));
const pack = await import(pathToFileURL(modulePath).href);
const { runDesignPack, rowTemplates, draftBeforeRows, publicationModuleFor, TEMPLATE_CHART_TYPES, NEXT_TEMPLATE_CHART_TYPES, NEXT_TEMPLATE_ROWS, NEXT_PUBLICATION_TYPES, PUBLICATION_TYPES } = pack;

let checks = 0;
const check = (name, fn) => { try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; } checks += 1; };
const checkAsync = async (name, fn) => { try { await fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; } checks += 1; };

// The claim filler in miniature (as in test_design_pack.mjs): placeholders over rows, typed digits and number words refused.
function fill(template, rows) {
  const bare = template.replace(/\{[^}]+\}/g, "");
  if (/\p{Nd}/u.test(bare)) throw new Error("CLAIM_TEMPLATE_ERROR: typed digits");
  if (numberWordIn(bare) !== null) throw new Error("CLAIM_TEMPLATE_ERROR: number word");
  const text = template.replace(/\{(first|last|max|min)\.([^.}]+)(?:\.([^}]+))?\}/g, (_all, which, field, label) => {
    const pick = which === "first" ? rows[0] : which === "last" ? rows[rows.length - 1] : [...rows].sort((a, b) => (which === "max" ? b[field] - a[field] : a[field] - b[field]))[0];
    return String(label ? pick[label] : pick[field]);
  });
  return { text, bindings: [] };
}

const PAGE_SVG = `infographics/${"e".repeat(64)}.svg`;
const SANKEY = { chart_type: "sankey", source_field: "siec", target_field: "nrg_bal", value_field: "value", language: "zh", claim_id: "c1", measure_semantics: [{ field: "value", phenomenon: "能源流向", scope: "德国" }], sql: "select 1" };
const SANKEY_ROWS = [{ siec: "煤", nrg_bal: "发电", value: 40 }, { siec: "气", nrg_bal: "供热", value: 25 }, { siec: "油", nrg_bal: "交通", value: 60 }];
const STACKED = { chart_type: "stacked_bar_100", category_field: "geo", series_field: "siec", value_field: "share", unit: "%", language: "zh", claim_id: "c1", measure_semantics: [{ field: "share", phenomenon: "发电量", scope: "欧盟" }], sql: "select 1" };
const STACKED_ROWS = [{ geo: "德国", siec: "煤", share: 30 }, { geo: "德国", siec: "风", share: 70 }, { geo: "法国", siec: "核", share: 65 }, { geo: "法国", siec: "风", share: 35 }];

function harness(plan, rows, next) {
  const log = [];
  const deps = {
    ...(next === undefined ? {} : { next }),
    enabled: () => true,
    numberWordIn,
    call: async (tool, params) => {
      log.push({ tool, params });
      const details = { newsroom_editorial_discovery: { discoveryRef: "d" }, newsroom_story_graph: { storyGraphRef: "g" }, newsroom_visual_concepts: { conceptRef: "c", selectedConceptId: "k" }, newsroom_semantic_novelty: { noveltyRef: "n" }, newsroom_asset_requirements: { assetPlanRef: "a" }, newsroom_publication_plan: { planRef: "pp" }, newsroom_publication_render: { htmlRef: "h", manifestRef: "pm" }, newsroom_publication_qa: { passed: true, judged: true, reportRef: "publications/qa/x/browser-qa.json" } }[tool];
      return { content: [{ type: "text", text: "ok" }], details };
    },
    runChain: async (kind, params) => {
      log.push({ tool: `chain:${kind}`, params });
      return { status: "COMPLETE", state: kind === "viz" ? { planRef: "visualizations/plans/p", manifestRef: "visualizations/m", criticRef: "cr", computationRef: "computations/x" } : { planRef: "ip", manifestRef: "im", criticRef: "ic", previewRef: "pv" }, images: [] };
    },
    claim: async () => ({ claim: "煤电占比最高", source_refs: ["data/a.csv"] }),
    sourceNote: async () => "欧盟统计局",
    rows: async () => rows,
    readJson: async (ref) => (ref.startsWith("visualizations/plans") ? plan : { variants: { desktop: ref === "im" ? PAGE_SVG : "visualizations/a.svg" } }),
    fill: async (template, r) => fill(template, r),
    screenshot: async () => null,
  };
  return { deps, log };
}
const packOf = (plan) => ({
  discovery: {}, story_graph: {}, visual_concepts: {}, semantic_novelty: {}, asset_requirements: {},
  charts: [{ ...plan }],
  page: { modules: [{ id: "m1", type: "visual", chart: 0, story_node_ids: ["n1"] }], primary_message: "能源去向。" },
  publication: {},
});
const runPack = async (module, plan, rows, next) => {
  const { deps, log } = harness(plan, rows, next);
  return { out: await module.runDesignPack(deps, packOf(plan), {}), log };
};

// ---- the tables ----
check("the off list is the old four; the new list adds flow and composition, one row each, and every row publishes", () => {
  assert.deepEqual([...TEMPLATE_CHART_TYPES], ["horizontal_bar", "dot", "line", "choropleth"]);
  assert.deepEqual([...NEXT_TEMPLATE_CHART_TYPES], ["horizontal_bar", "dot", "line", "choropleth", "sankey", "stacked_bar_100"]);
  assert.equal(NEXT_TEMPLATE_ROWS.sankey.relation, "flow");
  assert.equal(NEXT_TEMPLATE_ROWS.stacked_bar_100.relation, "composition");
  assert.deepEqual(NEXT_TEMPLATE_ROWS.stacked_bar_100.fixed, { unit: "%" });
  for (const type of NEXT_TEMPLATE_CHART_TYPES) assert.ok(Object.hasOwn(NEXT_PUBLICATION_TYPES, type), type);
  assert.equal(Object.hasOwn(PUBLICATION_TYPES, "stacked_bar_100"), false, "the off table does not publish a stacked share bar");
  assert.ok(Object.isFrozen(NEXT_TEMPLATE_ROWS) && Object.values(NEXT_TEMPLATE_ROWS).every((row) => Object.isFrozen(row) && Object.isFrozen(row.fields)));
});

// ---- drafting templates ----
check("sankey: L1 names source, target and measure; L2 the largest link; off (default list) nothing", () => {
  assert.equal(draftBeforeRows(SANKEY, numberWordIn, NEXT_TEMPLATE_CHART_TYPES).l1, "桑基图，从siec流向nrg_bal，线宽为能源流向");
  assert.equal(rowTemplates(SANKEY, SANKEY_ROWS, numberWordIn, NEXT_TEMPLATE_CHART_TYPES).l2, "最大一股：{max.value.siec}到{max.value.nrg_bal}（{max.value}）");
  assert.equal(rowTemplates({ ...SANKEY, language: "en" }, SANKEY_ROWS, numberWordIn, NEXT_TEMPLATE_CHART_TYPES).l2, "Largest flow: {max.value.siec} to {max.value.nrg_bal} ({max.value})");
  assert.equal(rowTemplates(SANKEY, SANKEY_ROWS, numberWordIn), null);
  assert.equal(draftBeforeRows(SANKEY, numberWordIn).l1, undefined);
  assert.equal(rowTemplates({ ...SANKEY, target_field: "" }, SANKEY_ROWS, numberWordIn, NEXT_TEMPLATE_CHART_TYPES), null, "no target, no template");
});
check("stacked share bar: L1 names bars, segments and measure; L2 the largest and smallest segment; the en name holds no digit", () => {
  assert.equal(draftBeforeRows(STACKED, numberWordIn, NEXT_TEMPLATE_CHART_TYPES).l1, "百分比堆积条形图，每个geo一条，按siec分段，段长为占发电量的比例");
  const en = draftBeforeRows({ ...STACKED, language: "en" }, numberWordIn, NEXT_TEMPLATE_CHART_TYPES).l1;
  assert.equal(en, "Stacked share bar chart: one bar for each geo, split by siec into shares of 发电量");
  assert.equal(rowTemplates(STACKED, STACKED_ROWS, numberWordIn, NEXT_TEMPLATE_CHART_TYPES).l2, "占比最高：{max.share.geo}的{max.share.siec}（{max.share}），最低：{min.share.geo}的{min.share.siec}（{min.share}）");
  assert.equal(rowTemplates(STACKED, STACKED_ROWS, numberWordIn), null);
  assert.equal(rowTemplates({ ...STACKED, series_field: undefined }, STACKED_ROWS, numberWordIn, NEXT_TEMPLATE_CHART_TYPES), null, "no series, no template");
});
check("publication: a stacked share bar publishes its SVG on the new table and is refused on the off table", () => {
  assert.deepEqual(publicationModuleFor(STACKED, { desktopSvgRef: "visualizations/a.svg" }, NEXT_PUBLICATION_TYPES), { type: "static_svg", asset_ref: "visualizations/a.svg" });
  assert.throws(() => publicationModuleFor(STACKED, { desktopSvgRef: "visualizations/a.svg" }), /DESIGN_PACK_NO_PUBLICATION_TYPE/);
});

// ---- the pack, switch on ----
await checkAsync("on: a sankey chart gets a drafted title, alt and filled L2 (largest link)", async () => {
  const { out, log } = await runPack(pack, SANKEY, SANKEY_ROWS, true);
  assert.equal(out.status, "RENDERED", JSON.stringify(out.problems));
  const viz = log.find((entry) => entry.tool === "chain:viz");
  assert.equal(viz.params.title, "能源流向：德国");
  assert.match(viz.params.alt, /^桑基图，从siec流向nrg_bal/);
  assert.ok(!out.notes.some((note) => /no drafting template/.test(note)));
  const l2 = out.audit.find((row) => row.path === "page.alt");
  assert.ok(l2 && JSON.stringify(l2).includes("最大一股"), "the page alt carries the filled L2");
  assert.ok(Object.values(out.drafts).some((text) => text.includes("最大一股：油到交通（60）")));
});
await checkAsync("on: a stacked share bar renders and publishes its SVG; L2 filled", async () => {
  const { out, log } = await runPack(pack, STACKED, STACKED_ROWS, true);
  assert.equal(out.status, "RENDERED", JSON.stringify(out.problems));
  const publication = log.find((entry) => entry.tool === "newsroom_publication_plan");
  assert.equal(publication.params.modules[0].type, "static_svg");
  assert.equal(publication.params.modules[0].asset_ref, PAGE_SVG, "on: the publication embeds the composed page the critics reviewed");
  assert.ok(publication.params.modules.slice(1).every((module) => module.type === "text"), "on: only text modules follow the page");
  assert.ok(String(publication.params.modules[0].accessibility_summary ?? "").length > 0, "on: the page module carries the charts' filled summary");
  assert.ok(Object.values(out.drafts).some((text) => text.includes("占比最高：德国的风（70），最低：德国的煤（30）")));
});

// ---- switch off: equal to the base module ----
const basePath = process.env.BASE_DESIGN_PACK;
await checkAsync("off: drafts, audit, notes, problems and tool params equal the base module (sankey, stacked share bar, line)", async () => {
  assert.ok(basePath, "BASE_DESIGN_PACK is not set: the off comparison did not run");
  const base = await import(pathToFileURL(basePath).href);
  const LINE = { chart_type: "line", value_field: "v", time_field: "year", category_field: "year", language: "zh", claim_id: "c1", measure_semantics: [{ field: "v", phenomenon: "出生率", scope: "中国" }], sql: "select 1" };
  const LINE_ROWS = [{ year: 2000, v: 12.5 }, { year: 2001, v: 11.4 }, { year: 2002, v: 10.2 }];
  for (const [plan, rows] of [[SANKEY, SANKEY_ROWS], [STACKED, STACKED_ROWS], [LINE, LINE_ROWS]]) {
    for (const next of [undefined, false]) {
      const now = await runPack(pack, plan, rows, next);
      const was = await runPack(base, plan, rows, undefined);
      for (const key of ["status", "drafts", "audit", "notes", "problems"]) assert.deepEqual(now.out[key], was.out[key], `${plan.chart_type} next=${next} ${key}`);
      assert.deepEqual(now.log, was.log, `${plan.chart_type} next=${next} tool params`);
    }
  }
});

// ---- the sheet reads the registry's pick ----
const SERIES = { sql: "SELECT siec, nrg_bal, value FROM t", columns: ["siec", "nrg_bal", "value"], rows: SANKEY_ROWS };
const sheet = async (packIn, next, chartForm = async () => ({ ok: true, chart_type: "horizontal_bar", relations: ["rank"] })) => {
  let asked = 0;
  const deps = { pageBuild: true, ...(next === undefined ? {} : { next }), sheetData: async () => [{ claim_id: "c1", verified: true, claim: "x", series: SERIES }], chartForm: async (need) => { asked += 1; return chartForm(need); }, codeScheme: async () => null };
  const out = await runDesignPack(deps, { part: "sheet", ...packIn }, {});
  return { out, asked };
};
const sankeyPick = { claim_id: "c1", chart_type: "sankey", fields: { source_field: "siec", target_field: "nrg_bal", value_field: "value" } };
await checkAsync("on: the sheet builds the chart from the pick and its row; the old matcher is not asked", async () => {
  const { out, asked } = await sheet({ templates: [sankeyPick] }, true);
  assert.equal(out.status, "SHEET", JSON.stringify(out.problems));
  assert.equal(asked, 0);
  assert.deepEqual(out.sheet.charts[0], { claim_id: "c1", chart_type: "sankey", sql: SERIES.sql, source_field: "siec", target_field: "nrg_bal", value_field: "value", claim_spec: { claim_id: "c1", relation: "flow" } });
  const stacked = await sheet({ templates: [{ claim_id: "c1", chart_type: "stacked_bar_100", fields: { category_field: "siec", series_field: "nrg_bal", value_field: "value" } }] }, true);
  assert.equal(stacked.out.sheet.charts[0].unit, "%");
  assert.equal(stacked.out.sheet.charts[0].claim_spec.relation, "composition");
});
await checkAsync("on: a pick that does not fit its row is refused by name, nothing filled in", async () => {
  const refused = async (pick, pattern) => {
    const { out } = await sheet({ templates: [pick] }, true);
    assert.equal(out.status, "STOPPED", JSON.stringify(pick));
    assert.match(out.problems[0].message, pattern);
  };
  await refused({ ...sankeyPick, chart_type: "heatmap" }, /DESIGN_PACK_SHEET_NO_FORM: c1: chart type 'heatmap' has no template row/);
  await refused({ ...sankeyPick, fields: { source_field: "siec", value_field: "value" } }, /target_field \(not given\)/);
  await refused({ ...sankeyPick, fields: { ...sankeyPick.fields, target_field: "geo" } }, /'geo' is not a series column/);
  await refused({ ...sankeyPick, fields: { ...sankeyPick.fields, series_field: "siec" } }, /sankey takes source_field, target_field, value_field, not series_field/);
  await refused({ ...sankeyPick, relation: "rank" }, /not relation/);
  await refused({ ...sankeyPick, claim_id: "c9" }, /no template for this claim/);
  await refused({ claim_id: "c1", chart_type: "choropleth", fields: { category_field: "siec", value_field: "value" } }, /choropleth needs category_names/);
  const listless = await sheet({ templates: { c1: sankeyPick } }, true);
  assert.match(listless.out.problems[0].message, /DESIGN_PACK_SHEET_TEMPLATE/);
});
await checkAsync("on: the model cannot change a field the template row filled", async () => {
  const state = {};
  const deps = { ...harness(SANKEY, SANKEY_ROWS, true).deps, pageBuild: true, sheetData: async () => [{ claim_id: "c1", verified: true, claim: "x", series: SERIES }], chartForm: async () => assert.fail("not asked"), codeScheme: async () => null };
  assert.equal((await runDesignPack(deps, { part: "sheet", templates: [sankeyPick] }, state)).status, "SHEET");
  const out = await runDesignPack(deps, { ...packOf({}), charts: [{ claim_id: "c1", target_field: "siec" }] }, state);
  assert.equal(out.status, "STOPPED");
  assert.match(out.problems.map((p) => p.message).join("\n"), /DESIGN_PACK_PROGRAM_FIELD: the sheet fills charts\[0\]\.target_field/);
});
await checkAsync("on: a template's names reach every fill of its chart's text; malformed names are refused", async () => {
  const GEO_ROWS = [{ country_iso2: "SE", value: 66 }, { country_iso2: "EL", value: 25 }];
  const GEO = { sql: "SELECT country_iso2, value FROM t", columns: ["country_iso2", "value"], rows: GEO_ROWS };
  const BAR = { chart_type: "horizontal_bar", category_field: "country_iso2", value_field: "value", category_names: "iso2", language: "zh", claim_id: "c1", measure_semantics: [{ field: "value", phenomenon: "可再生能源占比", scope: "欧盟" }], sql: GEO.sql };
  const pick = { claim_id: "c1", chart_type: "horizontal_bar", fields: { category_field: "country_iso2", value_field: "value" }, category_names: "iso2", names: { SE: "瑞典", EL: "希腊" } };
  const given = [];
  const state = {};
  const deps = { ...harness(BAR, GEO_ROWS, true).deps, pageBuild: true, sheetData: async () => [{ claim_id: "c1", verified: true, claim: "x", series: GEO }], chartForm: async () => assert.fail("not asked"), codeScheme: async () => null, fill: async (template, r, _plan, names) => { given.push(names); return fill(template, r); } };
  const first = await runDesignPack(deps, { part: "sheet", templates: [pick] }, state);
  assert.equal(first.status, "SHEET", JSON.stringify(first.problems));
  assert.equal(Object.hasOwn(first.sheet.charts[0], "names"), false, "the names stay out of the chart plan");
  const out = await runDesignPack(deps, { ...packOf({}), charts: [{ claim_id: "c1" }] }, state);
  assert.equal(out.status, "PREVIEWED", JSON.stringify(out.problems));
  assert.ok(given.length > 0 && given.every((names) => JSON.stringify(names) === JSON.stringify(pick.names)), JSON.stringify(given));
  const refused = async (bad, pattern) => {
    const { out: stopped } = await sheet({ templates: [bad] }, true);
    assert.equal(stopped.status, "STOPPED", JSON.stringify(bad));
    assert.match(stopped.problems[0].message, pattern);
  };
  await refused({ ...sankeyPick, names: ["瑞典"] }, /names maps each code/);
  await refused({ ...sankeyPick, names: { SE: "" } }, /names maps each code/);
  await refused({ ...sankeyPick, names: { SE: "瑞典" } }, /names comes with category_names/);
});
await checkAsync("on, page build: the page stops at its preview; part publish publishes that page once; a publish with no preview or with more is refused", async () => {
  const state = {};
  const { deps, log } = harness(SANKEY, SANKEY_ROWS, true);
  Object.assign(deps, { pageBuild: true, sheetData: async () => [{ claim_id: "c1", verified: true, claim: "x", series: SERIES }], chartForm: async () => assert.fail("not asked"), codeScheme: async () => null });
  const noPreview = await runDesignPack(deps, { part: "publish" }, {});
  assert.equal(noPreview.status, "STOPPED");
  assert.match(noPreview.problems[0].message, /DESIGN_PACK_NOT_PREVIEWED/);
  assert.equal((await runDesignPack(deps, { part: "sheet", templates: [sankeyPick] }, state)).status, "SHEET");
  const previewed = await runDesignPack(deps, { ...packOf({}), charts: [{ claim_id: "c1" }] }, state);
  assert.equal(previewed.status, "PREVIEWED", JSON.stringify(previewed.problems));
  assert.match(previewed.next, /vision_critic.*part "publish"/);
  assert.ok(!log.some((entry) => entry.tool.startsWith("newsroom_publication_")), "nothing is published before the critic");
  const more = await runDesignPack(deps, { part: "publish", charts: [] }, state);
  assert.equal(more.status, "STOPPED");
  assert.match(more.problems[0].message, /DESIGN_PACK_PUBLISH_INVALID: part "publish" takes nothing else; also sent: charts/);
  assert.ok(!log.some((entry) => entry.tool.startsWith("newsroom_publication_")), "a refused publish publishes nothing");
  const published = await runDesignPack(deps, { part: "publish" }, state);
  assert.equal(published.status, "RENDERED", JSON.stringify(published.problems));
  assert.deepEqual(log.filter((entry) => entry.tool.startsWith("newsroom_publication_")).map((entry) => entry.tool), ["newsroom_publication_plan", "newsroom_publication_render", "newsroom_publication_qa"]);
  for (const [path, text] of Object.entries(previewed.drafts)) assert.equal(published.drafts[path], text, `the published page is the previewed one (${path})`);
  assert.ok(Object.keys(published.drafts).filter((path) => !(path in previewed.drafts)).every((path) => path.startsWith("publication.")), "publishing adds only the publication's own text");
  const again = await runDesignPack(deps, { part: "publish" }, state);
  assert.match(again.problems[0].message, /DESIGN_PACK_NOT_PREVIEWED/, "one preview publishes once");
});
await checkAsync("on: a ranked template sorts by value and highlights the top and the bottom row; equal values highlight none", async () => {
  const ranked = async (rows) => {
    const series = { sql: "SELECT country_iso2, value FROM t", columns: ["country_iso2", "value"], rows };
    const deps = { pageBuild: true, next: true, sheetData: async () => [{ claim_id: "c1", verified: true, claim: "x", series }], chartForm: async () => assert.fail("not asked"), codeScheme: async () => null };
    const pick = { claim_id: "c1", chart_type: "horizontal_bar", fields: { category_field: "country_iso2", value_field: "value" } };
    const out = await runDesignPack(deps, { part: "sheet", templates: [pick] }, {});
    assert.equal(out.status, "SHEET", JSON.stringify(out.problems));
    return out.sheet.charts[0];
  };
  const chart = await ranked([{ country_iso2: "AT", value: 44.2 }, { country_iso2: "BE", value: 14.9 }, { country_iso2: "SE", value: 65.4 }]);
  assert.equal(chart.sort, "desc");
  assert.deepEqual(chart.highlight_values, ["SE", "BE"]);
  const flat = await ranked([{ country_iso2: "AT", value: 5 }, { country_iso2: "BE", value: 5 }]);
  assert.equal(flat.sort, "desc");
  assert.equal(Object.hasOwn(flat, "highlight_values"), false);
});
await checkAsync("off: templates are not read; the old matcher picks as before", async () => {
  for (const next of [undefined, false]) {
    const { out, asked } = await sheet({ templates: [sankeyPick] }, next);
    assert.equal(out.status, "SHEET");
    assert.equal(asked, 1);
    assert.equal(out.sheet.charts[0].chart_type, "horizontal_bar");
  }
});

console.log(`next templates: ${checks} checks -- PASS`);
