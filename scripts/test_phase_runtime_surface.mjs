#!/usr/bin/env node
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TOOL_REGISTRY } from "../runtime/pi/tool_registry.mjs";
import { toolEnabled } from "../runtime/pi/tool_phase_policy.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extension = join(root, "runtime/pi/newsroom.ts");
const metricsDir = mkdtempSync(join(tmpdir(), "news-phase-surface-"));
const rows = [];
const cases = [
  ["visual-story-all", "visual-story", undefined, "all"],
  ["visual-story-discover", "visual-story", "discover", "discover"],
  ["visual-story-verify", "visual-story", "verify", "verify"],
  ["visual-story-design", "visual-story", "design", "design"],
  ["investigate-all", "investigate", undefined, "all"],
  ["investigate-verify", "investigate", "verify", "verify"],
  ["visual-story-invalid", "visual-story", "invalid", "core"],
];
for (const [label, profile, requestedPhase, expectedPhase] of cases) {
  const metrics = join(metricsDir, `${label}.jsonl`);
  const env = { ...process.env, NEWSROOM_PHASE_METRICS: "1", NEWSROOM_PHASE_METRICS_FILE: metrics, NEWSROOM_TOOL_PROFILE: profile, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  if (requestedPhase === undefined) delete env.NEWSROOM_PHASE;
  else env.NEWSROOM_PHASE = requestedPhase;
  const result = spawnSync("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", extension], {
    cwd: root, env, input: '{"id":"phase-surface","type":"get_state"}\n', encoding: "utf8", timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pi startup failed for ${label}: exit ${result.status}`);
  const response = result.stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse).find((event) => event.id === "phase-surface");
  if (!response?.success) throw new Error(`Pi state probe failed for ${label}`);
  const entries = readFileSync(metrics, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const expectedTools = TOOL_REGISTRY.tools.filter((tool) => toolEnabled(tool.name, { profile, phase: expectedPhase }));
  if (entries.length !== expectedTools.length) throw new Error(`${label}: registered ${entries.length}, expected ${expectedTools.length}`);
  if (entries.some((entry) => entry.phase !== expectedPhase)) throw new Error(`${label}: invalid phase was not normalized to ${expectedPhase}`);
  rows.push({ label, profile, phase: expectedPhase, effective_tool_count: entries.length, schema_bytes: entries.reduce((total, entry) => total + entry.schema_bytes, 0) });
}
appendFileSync(join(metricsDir, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log(JSON.stringify({ status: "PASS", metrics_dir: metricsDir, rows }, null, 2));
