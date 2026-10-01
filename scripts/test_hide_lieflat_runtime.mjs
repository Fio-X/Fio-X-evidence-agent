// The opt-in NEWSROOM_HIDE_LIEFLAT=1 marker removes exactly the two Lieflat
// tools, and only from the visual-story profile. Loads the real extension from
// a temporary type-stripped copy (same approach as test_render_qa_tool_path.mjs).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "hide-lieflat-runtime-"));
try {
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const stub = (name, source) => {
    mkdirSync(join(tmp, "node_modules", name), { recursive: true });
    writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
  };
  // Structural stubs: parameters keep their shape (and enum values) so the
  // test can search them for Lieflat references.
  stub("typebox", "export const Type = new Proxy({}, { get: (_, kind) => (...args) => ({ kind, args }) });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = (values) => ({ enum: values });\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));

  const LIEFLAT = ["newsroom_lieflat_catalog", "newsroom_lieflat_render"];
  const definitions = (profile, hide) => {
    process.env.NEWSROOM_TOOL_PROFILE = profile;
    if (hide === undefined) delete process.env.NEWSROOM_HIDE_LIEFLAT;
    else process.env.NEWSROOM_HIDE_LIEFLAT = hide;
    const tools = new Map();
    newsroomExtension(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
    return tools;
  };
  const registered = (profile, hide) => new Set(definitions(profile, hide).keys());
  // What the model reads of a tool: everything except the handler.
  const visible = (tool) => JSON.stringify({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines, promptSnippet: tool.promptSnippet });
  const surface = (profile, hide) => Object.fromEntries([...definitions(profile, hide)].map(([name, tool]) => [name, visible(tool)]));

  const base = registered("visual-story", undefined);
  for (const name of LIEFLAT) assert.ok(base.has(name), `${name} registered by default`);
  assert.deepEqual([...registered("visual-story", "0")].sort(), [...base].sort(), "marker other than 1 changes nothing");

  const lean = registered("visual-story", "1");
  console.log(`visual-story registered tools: baseline=${base.size} lean=${lean.size}`);
  assert.equal(base.size - lean.size, 2);
  assert.deepEqual([...base].filter((name) => !lean.has(name)).sort(), LIEFLAT);

  for (const profile of ["investigate", "visual", "publication", "competition", "full"]) {
    assert.deepEqual([...registered(profile, "1")].sort(), [...registered(profile, undefined)].sort(), `${profile} unaffected`);
    assert.deepEqual(surface(profile, "1"), surface(profile, undefined), `${profile} definitions unaffected`);
  }
  assert.deepEqual(surface("visual-story", "0"), surface("visual-story", undefined), "switch off: definitions identical");
  // Nothing the model can read in a lean visual-story run points at Lieflat.
  for (const [name, text] of Object.entries(surface("visual-story", "1"))) {
    assert.ok(!/lieflat/i.test(text), `${name} still mentions Lieflat`);
  }
  // Default run still sees the skill and the reference pattern.
  assert.ok(/lieflat-charts/.test(surface("visual-story", undefined).newsroom_visual_skill));

  // Reference-pattern retrieval: lean corpus drops the Lieflat entry only.
  const art = join(tmp, "artifact");
  mkdirSync(art, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const matches = async (hide) => {
    const tool = definitions("visual-story", hide).get("newsroom_reference_patterns");
    const out = await tool.execute("t", { tags: ["chart", "report", "editorial", "offline", "catalog"], limit: 6 });
    return out.details.matches.map((item) => item.id);
  };
  const defaultIds = await matches(undefined);
  const leanIds = await matches("1");
  assert.ok(defaultIds.includes("lieflat-charts"));
  assert.deepEqual(leanIds, defaultIds.filter((id) => id !== "lieflat-charts"));
  console.log(JSON.stringify({ status: "PASS", baseline: base.size, lean: lean.size }));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
