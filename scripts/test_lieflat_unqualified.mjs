import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hashRows } from "../runtime/pi/viz.mjs";
import { sourceContentHash } from "../runtime/pi/provenance.mjs";
import { renderLieflatPublication } from "../runtime/pi/lieflat.mjs";

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
      // This fixture's report+chart calls are this suite's only coverage of
      // renderLieflatPublication/renderLieflatChart with phone-facing mobile
      // pages on (NEWSROOM_MOBILE_PAGES=1 at the newsroom_lieflat_render tool
      // layer); off-by-default coverage lives in test_render_qa_tool_path.mjs.
      mobile_pages: true,
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

// Regression for issue #37: a Lieflat page must not look measured, and
// `news verify` must still reject it as a publication.
const newsBin = process.env.NEWS_BIN || resolve(root, "target/debug/news");

function verify(base) {
  return spawnSync(newsBin, ["verify", base], { encoding: "utf8", timeout: 120000 });
}

try {
  const zh = await fixture("zh");
  const result = await renderLieflatPublication({ ...zh.input, artifact_root: zh.base });
  const manifest = JSON.parse(await readFile(result.manifest_path, "utf8"));

  // 1. No self-issued pass or score constants anywhere in the Lieflat output.
  assert.equal(manifest.artifact_status, "UNQUALIFIED");
  assert.equal(manifest.qualification.deliverable, false);
  assert.equal(manifest.qualification.measured, false);
  const written = [];
  for (const ref of [manifest.infographic_plan_ref, manifest.infographic_lint_ref, manifest.infographic_critic_ref, manifest.publication_qa_ref, manifest.manifest_ref]) {
    written.push([ref, JSON.parse(await readFile(join(zh.base, ref), "utf8"))]);
  }
  const constants = /"(passed|score|desktop_qa|mobile_qa)"\s*:\s*(true|100|"PASS")|"publication_qa"\s*:\s*"PASS"|"artifact_status"\s*:\s*"(PUBLISHABLE|VERIFIED)"/;
  for (const [ref, value] of written) {
    assert.equal(constants.test(JSON.stringify(value)), false, `${ref} carries a self-issued pass constant`);
  }
  assert.equal(constants.test(JSON.stringify(result)), false, "tool result carries a self-issued pass constant");
  assert.equal(constants.test(await readFile(result.report_path, "utf8")), false);

  // 2. The verifier still rejects the Lieflat-only publication by name.
  const report = verify(zh.base);
  assert.equal(report.error, undefined, String(report.error));
  assert.notEqual(report.status, 0, "news verify must reject a Lieflat-only publication");
  const output = `${report.stdout}\n${report.stderr}`;
  assert.match(output, /is a Lieflat publication \(kind=lieflat_publication\)/);

  console.log(JSON.stringify({
    status: "PASS",
    lieflat_artifact_status: manifest.artifact_status,
    lieflat_publication_qa: manifest.publication_qa,
    verify_exit_code: report.status,
    verify_rejects_lieflat_publication: true,
  }, null, 2));
} finally {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
}
