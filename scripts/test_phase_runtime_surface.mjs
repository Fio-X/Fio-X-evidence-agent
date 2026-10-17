#!/usr/bin/env node
import { makeTestTmp } from "./tmp_helper.mjs";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TOOL_REGISTRY } from "../runtime/pi/tool_registry.mjs";
import { toolEnabled } from "../runtime/pi/tool_phase_policy.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const extension = join(root, "runtime/pi/newsroom.ts");
const metricsDir = makeTestTmp("news-phase-surface-");
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
// newsroom_illustration_generate is registered only when an illustration adapter is configured (NEWSROOM_REFUSED_OPTIONS_FIX on unless exactly "0");
// each case runs under three arms: default (no adapter, 44 tools in visual-story-all), an adapter set (45), and "0" (45, registered as before).
const ILLUSTRATION = "newsroom_illustration_generate";
const arms = [
  ["default", { NEWSROOM_REFUSED_OPTIONS_FIX: undefined, NEWSROOM_ILLUSTRATION_ADAPTER: undefined }, false],
  ["adapter", { NEWSROOM_REFUSED_OPTIONS_FIX: undefined, NEWSROOM_ILLUSTRATION_ADAPTER: "test-adapter" }, true],
  ["zero", { NEWSROOM_REFUSED_OPTIONS_FIX: "0", NEWSROOM_ILLUSTRATION_ADAPTER: undefined }, true],
];
for (const [armName, armEnv, illustrationRegistered] of arms) for (const [caseLabel, profile, requestedPhase, expectedPhase] of cases) {
  const label = armName === "default" ? caseLabel : `${caseLabel}-${armName}`;
  const metrics = join(metricsDir, `${label}.jsonl`);
  const env = { ...process.env, NEWSROOM_PHASE_METRICS: "1", NEWSROOM_PHASE_METRICS_FILE: metrics, NEWSROOM_TOOL_PROFILE: profile, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const [key, value] of Object.entries(armEnv)) { if (value === undefined) delete env[key]; else env[key] = value; }
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
  // visual-story never registers the two Lieflat tools (approved default); the registry still lists them for the other profiles.
  const expectedTools = TOOL_REGISTRY.tools.filter((tool) => toolEnabled(tool.name, { profile, phase: expectedPhase }) && !(profile === "visual-story" && tool.name.startsWith("newsroom_lieflat_")) && (illustrationRegistered || tool.name !== ILLUSTRATION));
  if (entries.length !== expectedTools.length) throw new Error(`${label}: registered ${entries.length}, expected ${expectedTools.length}`);
  if (entries.some((entry) => entry.phase !== expectedPhase)) throw new Error(`${label}: invalid phase was not normalized to ${expectedPhase}`);
  rows.push({ label, profile, phase: expectedPhase, effective_tool_count: entries.length, schema_bytes: entries.reduce((total, entry) => total + entry.schema_bytes, 0) });
}
appendFileSync(join(metricsDir, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
console.log(JSON.stringify({ status: "PASS", metrics_dir: metricsDir, rows }, null, 2));
