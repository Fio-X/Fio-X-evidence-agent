// The visual-story profile registers neither Lieflat tool, with nothing set;
// every other profile is unaffected. Loads the real extension from
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
  stub("typebox", "export const Type = new Proxy({}, { get: (_, kind) => (...args) => { while (args.length && args[args.length - 1] === undefined) args.pop(); return { kind, args }; } });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = (values) => ({ enum: values });\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));

  const LIEFLAT = ["newsroom_lieflat_catalog", "newsroom_lieflat_render"];
  const definitions = (profile) => {
    process.env.NEWSROOM_TOOL_PROFILE = profile;
    const tools = new Map();
    newsroomExtension(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
    return tools;
  };
  const registered = (profile) => new Set(definitions(profile).keys());
  // What the model reads of a tool: everything except the handler.
  const visible = (tool) => JSON.stringify({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines, promptSnippet: tool.promptSnippet });
  const surface = (profile) => Object.fromEntries([...definitions(profile)].map(([name, tool]) => [name, visible(tool)]));

  // With nothing set, visual-story registers neither Lieflat tool.
  const lean = registered("visual-story");
  for (const name of LIEFLAT) assert.ok(!lean.has(name), `${name} not registered under visual-story`);
  // Every other profile that offers them still does; only visual-story hides them.
  const others = ["investigate", "visual", "publication", "competition", "full"].map((profile) => [profile, registered(profile)]);
  const offering = others.filter(([, names]) => LIEFLAT.every((name) => names.has(name))).map(([profile]) => profile);
  console.log(`visual-story registered tools=${lean.size}; profiles still offering Lieflat: ${offering.join(",")}`);
  assert.ok(offering.length > 0, "some other profile still offers the Lieflat tools");
  // Nothing the model can read in a visual-story run points at Lieflat.
  for (const [name, text] of Object.entries(surface("visual-story"))) {
    assert.ok(!/lieflat/i.test(text), `${name} still mentions Lieflat`);
  }
  // A profile that offers the tools still sees the skill.
  assert.ok(/lieflat-charts/.test(surface(offering[0]).newsroom_visual_skill ?? ""), "the visual skill still lists lieflat-charts where the tools are offered");

  // Reference-pattern retrieval: the visual-story corpus drops the Lieflat entry only.
  const art = join(tmp, "artifact");
  mkdirSync(art, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const matches = async (profile) => {
    const tool = definitions(profile).get("newsroom_reference_patterns");
    if (!tool) return null;
    const out = await tool.execute("t", { tags: ["chart", "report", "editorial", "offline", "catalog"], limit: 6 });
    return out.details.matches.map((item) => item.id);
  };
  const storyIds = await matches("visual-story");
  const otherIds = await matches(offering.find((profile) => registered(profile).has("newsroom_reference_patterns")));
  assert.ok(storyIds && otherIds, "reference-pattern tool registered");
  assert.ok(otherIds.includes("lieflat-charts"));
  assert.ok(!storyIds.includes("lieflat-charts"));
  console.log(JSON.stringify({ status: "PASS", visualStory: lean.size }));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
