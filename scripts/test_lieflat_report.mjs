import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hashRows } from "../runtime/pi/viz.mjs";
import { sourceContentHash } from "../runtime/pi/provenance.mjs";
import { catalogLieflat, projectRows, renderLieflatPublication } from "../runtime/pi/lieflat.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const tempRoots = [];

async function writeJson(base, relative, value) {
  const path = join(base, relative);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(language) {
  const base = await mkdtemp(join(tmpdir(), `fio-x-lieflat-${language}-`));
  tempRoots.push(base);
  await mkdir(join(base, "sources"), { recursive: true });
  await mkdir(join(base, "computations"), { recursive: true });
  await mkdir(join(base, "editorial", "story-graphs"), { recursive: true });

  const sourceRefs = [];
  const computationRefs = [];
  const claims = [];
  const modules = [
    ["hook", "ranking", "L2", "The comparison starts with the largest observed difference"],
    ["context", "trend", "F2", "The change is part of a measured sequence"],
    ["evidence", "distribution", "G19", "The distribution is wider than the headline average"],
    ["turn", "relationship", "F8", "The relationship changes how the headline should be read"],
    ["resolution", "benchmark", "F11", "The verified result clears the stated benchmark"],
  ].map(([role, job, chart, title], index) => ({ role, job, chart, title, index: index + 1 }));

  for (const module of modules) {
    const sourceRef = `sources/source-${module.index}.json`;
    const finalUrl = `https://example.test/evidence/${module.index}`;
    const sourceText = `Primary evidence snapshot ${module.index}: measured observation for the fixture.`;
    const source = {
      schema_version: "0.7.0",
      final_url: finalUrl,
      status: 200,
      content_type: "text/plain",
      truncated: false,
      content_hash: sourceContentHash({ finalUrl, status: 200, contentType: "text/plain", truncated: false, text: sourceText }),
      text: sourceText,
    };
    await writeJson(base, sourceRef, source);
    sourceRefs.push(sourceRef);

    const rows = [
      { label: `A${module.index}`, value: module.index * 7 },
      { label: `B${module.index}`, value: module.index * 11 },
      { label: `C${module.index}`, value: module.index * 13 },
    ];
    const computationRef = `computations/rows-${module.index}.json`;
    await writeJson(base, computationRef, {
      schema_version: "0.7.0",
      sql: `SELECT label, value FROM fixture_${module.index}`,
      result_hash: hashRows(rows),
      rows,
    });
    computationRefs.push(computationRef);
    claims.push({
      schema_version: "0.7.0",
      claim_id: `claim-${module.index}`,
      claim: module.title,
      status: "verified",
      source_refs: [sourceRef],
      computation_refs: [computationRef],
    });
  }
  await writeFile(join(base, "claims.jsonl"), `${claims.map((claim) => JSON.stringify(claim)).join("\n")}\n`, "utf8");
  const files = {
    prompt: "prompt.md",
    latest_answer: "answer.md",
    conversation: "conversation.md",
    events: "events.jsonl",
    tool_audit: "tools.json",
    session_stats: "session-stats.json",
    run_metrics: "run-metrics.jsonl",
    plan: "plan.json",
    claims: "claims.jsonl",
  };
  for (const ref of Object.values(files)) {
    const path = join(base, ref);
    try { await stat(path); } catch { await writeFile(path, "", "utf8"); }
  }
  await writeJson(base, "story.json", {
    schema_version: "0.7.0",
    id: `fixture-${language}`,
    kind: "investigation",
    created_at: "2026-09-18T00:00:00Z",
    updated_at: "2026-09-18T00:00:00Z",
    topic: language === "zh" ? "五个证据共同指向一个转折" : "Five findings point to one turn",
    status: "draft",
    files,
  });
  await writeJson(base, "editorial/story-graphs/fixture.json", {
    schema_version: "0.1.0",
    kind: "story_graph",
    passed: true,
    reader_question: language === "zh" ? "这些变化如何共同改变结论？" : "How do these changes alter the conclusion together?",
    visual_thesis: language === "zh" ? "五个独立证据共同指向一个可验证的转折。" : "Five independent findings point to one verifiable turn.",
    nodes: [],
    edges: [],
  });

  const graphRef = "editorial/story-graphs/fixture.json";
  const title = language === "zh" ? "五个证据共同指向一个转折" : "Five findings point to one turn";
  const dek = language === "zh" ? "这是一份用于验证离线发布链路的证据绑定报告。" : "An evidence-bound report fixture for the offline publication path.";
  return {
    base,
    input: {
      mode: "report",
      language,
      template_id: "R01",
      template_file: `templates/reports/report-01.${language}.html`,
      story_graph_ref: graphRef,
      title,
      dek,
      reader_question: language === "zh" ? "这些变化如何共同改变结论？" : "How do these changes alter the conclusion together?",
      modules: modules.map((module) => ({
        id: `module-${module.index}`,
        story_role: module.role,
        analytical_job: module.job,
        reader_question: module.title,
        claim_ids: [`claim-${module.index}`],
        source_refs: [sourceRefs[module.index - 1]],
        chart_template_id: module.chart,
        data_ref: computationRefs[module.index - 1],
        title: module.title,
        annotation: `Bound to ${sourceRefs[module.index - 1]}`,
      })),
      claim_ids: claims.map((claim) => claim.claim_id),
      source_refs: sourceRefs,
      output_name: "index.html",
    },
  };
}

try {
  const semanticLine = projectRows(
    [{ year: 2000, total_electricity_twh: 15275.82, weighted_avg_carbon_intensity: 527.17 }],
    { id: "semantic-line", label_field: "year", value_fields: ["total_electricity_twh", "weighted_avg_carbon_intensity"] },
    "line",
  );
  assert.equal(semanticLine[0].label, "2000");
  assert.equal(semanticLine[0].value, 15275.82);
  assert.deepEqual(semanticLine[0].value_fields, ["total_electricity_twh", "weighted_avg_carbon_intensity"]);
  const semanticScatter = projectRows(
    [{ country: "A", year: 2023, low_carbon_share_pct: 100, carbon_intensity_gco2_per_kwh: 24.19 }],
    { id: "semantic-scatter", label_field: "country", value_fields: ["low_carbon_share_pct", "carbon_intensity_gco2_per_kwh"] },
    "scatter",
  );
  assert.equal(semanticScatter[0].label, "A");
  assert.equal(semanticScatter[0].x, 100);
  assert.equal(semanticScatter[0].y, 24.19);

  const catalog = catalogLieflat({ mode: "report", language: "zh", analytical_job: "research", data_shape: "multi-module", reader_task: "evidence", reading_speed: "normal", module_count: 5, offline_required: true });
  assert.match(catalog.data_contract.report_template_role, /layout shells only/);
  assert.match(catalog.data_contract.quantitative_module_template_mode, /mode=chart/);
  assert.ok(catalog.data_contract.quantitative_module_template_ids.includes("L2"));
  const zh = await fixture("zh");
  const result = await renderLieflatPublication({ ...zh.input, artifact_root: zh.base });
  assert.equal(result.template_id, "R01");
  assert.match(result.html_path, /publications\/[^/]+\/index\.html$/);
  assert.ok(result.html_bytes > 0);
  assert.equal(result.self_contained, true);
  assert.equal(result.network_required, false);
  assert.equal(result.story_completion.module_count, 5);
  assert.equal(result.story_completion.source_bound_module_count, 5);
  assert.deepEqual(result.story_completion.story_roles_covered, ["hook", "context", "evidence", "turn", "resolution"]);

  const html = await readFile(result.html_path, "utf8");
  assert.ok(html.includes('data-lieflat-template="R01"'));
  assert.ok(html.includes("prefers-reduced-motion"));
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("<noscript>"));
  for (const forbidden of ["cdn.jsdelivr.net", "fonts.googleapis.com", "moxt.ai", "<script", "2026 SAMPLE"]) assert.equal(html.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  const manifest = JSON.parse(await readFile(result.manifest_path, "utf8"));
  assert.equal(manifest.artifact_status, "PUBLISHABLE");
  assert.equal(manifest.publication_qa, "PASS");
  assert.equal(manifest.visual_assets.length, 5);
  assert.equal(manifest.editorial_discovery_ref.startsWith("editorial/"), true);
  assert.equal(manifest.infographic_lint_ref.startsWith("infographics/"), true);
  assert.equal(manifest.publication_qa_ref.startsWith("publications/"), true);
  const report = await readFile(result.report_path, "utf8");
  assert.ok(report.includes(result.html_path));
  assert.ok(report.includes(result.manifest_path));
  assert.ok(await stat(join(zh.base, "story.json")));
  assert.ok(await stat(join(zh.base, "lieflat", "LICENSE")));
  assert.ok(await stat(join(zh.base, "lieflat", "THIRD_PARTY_NOTICES.md")));
  assert.ok(await stat(join(zh.base, "publications", result.manifest_path.split("/").at(-2), "assets")));
  assert.ok(await stat(join(zh.base, "editorial", result.editorial_discovery_ref.split("/").slice(1).join("/"))));
  assert.ok(await stat(join(zh.base, "visualizations", result.template_id ? result.manifest_path.split("/").at(-2) : "missing")));
  assert.ok(await stat(join(zh.base, "infographics")));

  const staleStory = JSON.parse(await readFile(join(zh.base, "story.json"), "utf8"));
  staleStory.status = "draft";
  await writeFile(join(zh.base, "story.json"), JSON.stringify(staleStory), "utf8");
  const recovered = await renderLieflatPublication({ ...zh.input, artifact_root: zh.base });
  assert.equal(JSON.parse(await readFile(join(zh.base, "story.json"))).kind, "investigation");
  assert.equal(recovered.self_contained, true);

  const wrongModuleTemplate = await fixture("zh");
  await assert.rejects(
    renderLieflatPublication({
      ...wrongModuleTemplate.input,
      artifact_root: wrongModuleTemplate.base,
      modules: wrongModuleTemplate.input.modules.map((module, index) => index === 0 ? { ...module, chart_template_id: "R03" } : module),
    }),
    /report shell 'R03' as chart_template_id.*mode='chart'/,
  );

  const repeatedTemplate = await fixture("zh");
  await assert.rejects(
    renderLieflatPublication({
      ...repeatedTemplate.input,
      artifact_root: repeatedTemplate.base,
      modules: repeatedTemplate.input.modules.map((module) => ({ ...module, chart_template_id: "L2" })),
    }),
    /compose complementary chart grammars/,
  );

  const chart = await renderLieflatPublication({
    ...zh.input,
    mode: "chart",
    template_id: "L2",
    template_file: "templates/lupi-gallery.html",
    story_graph_ref: undefined,
    modules: [zh.input.modules[0]],
    claim_ids: ["claim-1"],
    source_refs: ["sources/source-1.json"],
    output_name: "index.html",
    artifact_root: zh.base,
  });
  assert.match(chart.file_path, /visualizations\/[^/]+\.svg$/);
  assert.ok(chart.html_bytes > 0);
  assert.equal(chart.module_count, 1);
  assert.equal(chart.publication_qa, "NOT_APPLICABLE");
  assert.ok((await readFile(chart.html_path, "utf8")).includes('data-lieflat-template="L2"'));

  const en = await fixture("en");
  const english = await renderLieflatPublication({ ...en.input, artifact_root: en.base });
  assert.match(english.html_path, /\.html$/);
  const englishHtml = await readFile(english.html_path, "utf8");
  assert.match(englishHtml, /<html lang="en">/);
  assert.equal(englishHtml.includes("数据新闻信息图报告"), false);
  assert.equal(englishHtml.includes("数据表"), false);
  assert.ok(englishHtml.includes("Data table"));

  const insufficient = await fixture("zh");
  await assert.rejects(
    renderLieflatPublication({
      ...insufficient.input,
      artifact_root: insufficient.base,
      modules: insufficient.input.modules.slice(0, 1),
      claim_ids: ["claim-1"],
      source_refs: ["sources/source-1.json"],
    }),
    /4–9 ordered modules/,
  );

  console.log(JSON.stringify({
    status: "PASS",
    catalog_report_candidates: catalog.candidates.length,
    zh_html: result.html_path,
    en_html: english.html_path,
    module_count: result.module_count,
    visual_asset_count: result.visual_asset_count,
    source_bound_module_count: result.source_bound_module_count,
    self_contained: result.self_contained,
    network_requests: result.network_requests,
    desktop_qa: result.desktop_qa,
    mobile_qa: result.mobile_qa,
  }, null, 2));
} finally {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
}
