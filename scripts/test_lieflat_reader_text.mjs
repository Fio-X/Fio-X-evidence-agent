import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hashRows } from "../runtime/pi/viz.mjs";
import { sourceContentHash } from "../runtime/pi/provenance.mjs";
import { renderLieflatPublication } from "../runtime/pi/lieflat.mjs";

// This test guards Task T1: a Lieflat reader page (chart or report) must
// never show a claim id, a source/data/computation file path, or a raw hash
// to the reader -- but every claim id, source ref, and computation ref that
// backs the page must still be recoverable by a machine (from unrendered
// data-* attributes and from the page's JSON manifest sidecar).

const tempRoots = [];
const unique = (values) => [...new Set(values)];

async function writeJson(base, relativePath, value) {
  const path = join(base, relativePath);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Same fixture shape as scripts/test_lieflat_report.mjs (proven to satisfy
// the report completion gates): 5 modules covering hook/context/evidence/
// turn/resolution, each bound to its own source and computation.
async function fixture(language) {
  const base = await mkdtemp(join(tmpdir(), `fio-x-lieflat-reader-text-${language}-`));
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
    prompt: "prompt.md", latest_answer: "answer.md", conversation: "conversation.md", events: "events.jsonl",
    tool_audit: "tools.json", session_stats: "session-stats.json", run_metrics: "run-metrics.jsonl", plan: "plan.json", claims: "claims.jsonl",
  };
  for (const ref of Object.values(files)) {
    const path = join(base, ref);
    try { await stat(path); } catch { await writeFile(path, "", "utf8"); }
  }
  await writeJson(base, "story.json", {
    schema_version: "0.7.0",
    id: `reader-text-${language}`,
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
  const dek = language === "zh" ? "这是一份用于验证读者可见文本的证据绑定报告。" : "An evidence-bound report fixture for verifying reader-visible text.";
  return {
    base,
    sourceRefs,
    computationRefs,
    claimIds: claims.map((claim) => claim.claim_id),
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
        annotation: `Editorial note for finding ${module.index}`,
      })),
      claim_ids: claims.map((claim) => claim.claim_id),
      source_refs: sourceRefs,
      output_name: "index.html",
    },
  };
}

// Reader-visible text is whatever remains after dropping <head>, every tag
// (attributes included), <style>, and <noscript>. data-* attributes live
// inside tags, so they never survive this extraction -- exactly the point.
function visibleText(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const withoutStyle = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutNoscript = withoutStyle.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const stripped = withoutNoscript.replace(/<[^>]*>/g, " ");
  return stripped
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function assertNoInternalIdentifiers(html, label) {
  const text = visibleText(html);
  assert.equal(/claim-/i.test(text), false, `${label}: reader-visible text must not contain a claim id`);
  assert.equal(/\b(?:sources|data|computations)\//i.test(text), false, `${label}: reader-visible text must not contain a source/data/computation path`);
  assert.equal(/[0-9a-f]{12,}/i.test(text), false, `${label}: reader-visible text must not contain a 12+ character hex string`);
  return text;
}

function getAttr(tagHtml, name) {
  const match = tagHtml.match(new RegExp(`${name}="([^"]*)"`));
  if (!match) return "";
  return match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function csvAttr(tagHtml, name) {
  const raw = getAttr(tagHtml, name);
  return raw ? raw.split(",").filter(Boolean) : [];
}

try {
  // ---- Chart mode: runtime/pi/lieflat.mjs renderLieflatChart (T1's named bug) ----
  const chartFixture = await fixture("zh");
  const chartModule = chartFixture.input.modules[0];
  const chartResult = await renderLieflatPublication({
    mode: "chart",
    language: "zh",
    template_id: "L2",
    template_file: "templates/lupi-gallery.html",
    modules: [chartModule],
    claim_ids: chartModule.claim_ids,
    source_refs: chartModule.source_refs,
    output_name: "index.html",
    artifact_root: chartFixture.base,
  });
  const chartHtml = await readFile(chartResult.html_path, "utf8");
  const chartVisible = assertNoInternalIdentifiers(chartHtml, "chart page");
  assert.ok(chartVisible.includes("example.test"), "chart page should show a human source host when no title exists");

  const chartSourceTagMatch = chartHtml.match(/<p class="source"[^>]*>/);
  assert.ok(chartSourceTagMatch, "chart page must keep a .source element");
  const chartSourceTag = chartSourceTagMatch[0];
  assert.deepEqual(csvAttr(chartSourceTag, "data-claim-ids"), chartModule.claim_ids);
  assert.deepEqual(csvAttr(chartSourceTag, "data-source-refs"), chartModule.source_refs);
  assert.equal(getAttr(chartSourceTag, "data-computation-ref"), chartModule.data_ref);

  const chartManifest = JSON.parse(await readFile(chartResult.manifest_path, "utf8"));
  assert.deepEqual(chartManifest.claim_ids, chartModule.claim_ids);
  assert.deepEqual(chartManifest.source_refs, chartModule.source_refs);
  assert.equal(chartManifest.computation_ref, chartModule.data_ref);

  // ---- Report mode: runtime/pi/lieflat.mjs renderLieflatPublication (mode="report") ----
  const reportFixture = await fixture("zh");
  const reportResult = await renderLieflatPublication({ ...reportFixture.input, artifact_root: reportFixture.base });
  const reportHtml = await readFile(reportResult.html_path, "utf8");
  const reportVisible = assertNoInternalIdentifiers(reportHtml, "report page");
  assert.ok(reportVisible.includes("example.test"), "report page should show a human source host when no title exists");

  const mainTagMatch = reportHtml.match(/<main[^>]*>/);
  assert.ok(mainTagMatch, "report page must have a <main> element");
  const mainTag = mainTagMatch[0];
  assert.deepEqual(csvAttr(mainTag, "data-claim-ids").sort(), [...reportFixture.claimIds].sort());
  assert.deepEqual(csvAttr(mainTag, "data-source-refs").sort(), [...reportFixture.sourceRefs].sort());

  const bindingTags = [...reportHtml.matchAll(/<p class="lf-binding"[^>]*>/g)].map((match) => match[0]);
  assert.equal(bindingTags.length, reportFixture.input.modules.length, "one lf-binding element per module");
  const boundClaimIds = unique(bindingTags.flatMap((tag) => csvAttr(tag, "data-claim-ids")));
  const boundSourceRefs = unique(bindingTags.flatMap((tag) => csvAttr(tag, "data-source-refs")));
  assert.deepEqual(boundClaimIds.sort(), [...reportFixture.claimIds].sort());
  assert.deepEqual(boundSourceRefs.sort(), [...reportFixture.sourceRefs].sort());

  const reportManifest = JSON.parse(await readFile(reportResult.manifest_path, "utf8"));
  assert.deepEqual([...reportManifest.claim_ids].sort(), [...reportFixture.claimIds].sort());
  assert.deepEqual([...reportManifest.source_refs].sort(), [...reportFixture.sourceRefs].sort());
  for (const module of reportManifest.modules) {
    assert.ok(module.claim_ids.length > 0, `manifest module '${module.id}' must keep its claim_ids`);
    assert.ok(module.source_refs.length > 0, `manifest module '${module.id}' must keep its source_refs`);
  }

  console.log(JSON.stringify({
    status: "PASS",
    chart_html: chartResult.html_path,
    chart_source_line_sample: chartVisible.slice(chartVisible.indexOf("数据来源"), chartVisible.indexOf("数据来源") + 60),
    report_html: reportResult.html_path,
    modules_checked: bindingTags.length,
  }, null, 2));
} finally {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
}
