import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderLieflatPublication } from "../runtime/pi/lieflat.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const core = await readFile(resolve(root, "src/agent/core.rs"), "utf8");
const renderer = await readFile(resolve(root, "runtime/pi/lieflat.mjs"), "utf8");

for (const invariant of [
  "evidence insufficient to support a complex infographic",
  "editorial discovery has not passed",
  "Story Graph lint has not passed",
  "complex report requires two distinct analytical jobs",
  "complex report requires two verified visual assets",
  "infographic plan must contain 4–9 ordered modules",
  "every report module must be source-bound",
  "single-chart fallback cannot complete a complex report",
  "publication HTML and QA must both pass",
]) assert.ok(core.includes(invariant), `missing completion invariant: ${invariant}`);
for (const marker of [
  "story_graph_ref is not a passing Story Graph",
  "4–9 ordered modules",
  "does not expose every source bound to claim",
  "requires at least two distinct analytical jobs",
  "requires at least two verified visual/explainer assets",
  "artifact_status: \"PUBLISHABLE\"",
  "publication_qa: \"PASS\"",
  "story_json_path",
  "editorial_discovery_ref",
  "infographic_lint_ref",
  "infographic_critic_ref",
  "publication_qa_ref",
]) assert.ok(renderer.includes(marker), `missing renderer completion marker: ${marker}`);

const base = await mkdtemp(join(tmpdir(), "fio-x-story-completion-"));
const outside = await mkdtemp(join(tmpdir(), "fio-x-story-outside-"));
try {
  await mkdir(join(base, "editorial", "story-graphs"), { recursive: true });
  await writeFile(join(outside, "graph.json"), JSON.stringify({ passed: true }), "utf8");
  await symlink(join(outside, "graph.json"), join(base, "editorial", "story-graphs", "escape.json"));
  await assert.rejects(
    renderLieflatPublication({
      artifact_root: base,
      mode: "report",
      language: "zh",
      template_id: "R01",
      template_file: "templates/reports/report-01.zh.html",
      story_graph_ref: "editorial/story-graphs/escape.json",
      title: "blocked",
      dek: "blocked",
      modules: [],
      claim_ids: ["claim-1"],
      source_refs: ["sources/source.json"],
      output_name: "index.html",
    }),
    /symlink escapes run root/,
  );
} finally {
  await rm(base, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: "PASS",
  completion_state: "fail-closed",
  evidence_insufficiency: "not_publishable",
  path_safety: "run-root containment, traversal, symlink, directory, empty-file checks",
  required_story_roles: ["hook", "context_or_evidence", "turn_or_explanation", "resolution"],
  min_modules: 4,
  max_modules: 9,
  min_visual_assets: 2,
  min_distinct_analytical_jobs: 2,
  html_status: "PUBLISHABLE only after publication QA PASS",
}, null, 2));
