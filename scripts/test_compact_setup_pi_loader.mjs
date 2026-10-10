// Proves the compact-setup schema check runs inside Pi's own extension loader (jiti aliases for typebox/compile), not only in the
// stub-based tests: the materialized runtime files are loaded by the installed Pi, and a shared value the full form refuses is
// refused there. No model, no provider: only the loader and the tool handler. Skips (exit 0, says so) when Pi is not installed.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const piDir = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim() + "/@earendil-works/pi-coding-agent";
const loaderPath = join(piDir, "dist/core/extensions/loader.js");
if (!existsSync(loaderPath)) { console.log("SKIP pi loader test: Pi is not installed"); process.exit(0); }
const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(loaderPath).href);

const dir = makeTestTmp("compact-pi-loader-");
cpSync(join(ROOT, "runtime", "pi"), join(dir, "runtime", "pi"), { recursive: true }); // what the Rust materializer writes next to newsroom.ts
cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
const art = join(dir, "run"); for (const d of ["editorial/discovery", "runtime"]) mkdirSync(join(art, d), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
process.env.NEWSROOM_TOOL_PROFILE = "full";
process.env.NEWSROOM_SPEED_COMPACT_SETUP = "1";
process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1";

const loaded = await loadExtensions([join(dir, "runtime", "pi", "newsroom.ts")], dir, { on() {}, emit() {} }, createExtensionRuntime());
assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
const tools = new Map([...loaded.extensions[0].tools].map(([name, t]) => [name, t.definition ?? t]));
const vc = tools.get("newsroom_visual_concepts");
assert.ok(vc, "newsroom_visual_concepts is registered by Pi's loader");
assert.ok(!vc.parameters.required.includes("discovery_ref") && "shared" in vc.parameters.properties, "compact schema is active in the loaded tool");

const disc = await tools.get("newsroom_editorial_discovery").execute("t", { reader_problem: "p", candidate_questions: ["a", "b", "c"], surprises: ["s"], counterintuitive_findings: [], human_scale_refs: [], spatial_dimensions: [], temporal_dimensions: ["t"], mechanisms: [], uncertainties: ["u"], missing_reporting: [], kill_reasons: [] });
assert.ok(String(disc.content?.[0]?.text ?? "").includes("editorial/discovery/"));
const FRAMES = ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal", "spatial"];
const shared = { reader_question: "Q?", editorial_premise: "P", hero_evidence_refs: ["c1"], supporting_evidence_refs: [], asset_requirements: [], media_mix: ["chart"], risk_flags: Array.from({ length: 30 }, (_, i) => `r${i}`), reporting_gaps: [] };
const concepts = FRAMES.map((framing, i) => ({ concept_id: `c${i + 1}`, framing, visual_metaphor: `m${i}`, hero_scene: `h${i}`, why_memorable: `w${i}` }));
let error = "";
try { await vc.execute("t", { shared, concepts }); } catch (e) { error = String(e?.message ?? e); }
assert.match(error, /concepts\[0\]\.risk_flags/, error.slice(0, 300));
assert.match(error, /fail the same schema the full form uses/);
const ok = await vc.execute("t", { shared: { ...shared, risk_flags: ["r"] }, concepts });
assert.match(String(ok.content?.[0]?.text ?? ""), /Visual concept tournament recorded/);
console.log("PASS pi loader: typebox/compile resolves in Pi's loader; 30 risk_flags in shared is refused with the path, a valid shared set is accepted");
