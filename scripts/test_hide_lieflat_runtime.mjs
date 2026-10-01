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
  stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const { default: newsroomExtension } = await import(join(pi, "newsroom.test-copy.mjs"));

  const LIEFLAT = ["newsroom_lieflat_catalog", "newsroom_lieflat_render"];
  const registered = (profile, hide) => {
    process.env.NEWSROOM_TOOL_PROFILE = profile;
    if (hide === undefined) delete process.env.NEWSROOM_HIDE_LIEFLAT;
    else process.env.NEWSROOM_HIDE_LIEFLAT = hide;
    const tools = new Set();
    newsroomExtension(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.add(tool.name) : () => {}) }));
    return tools;
  };

  const base = registered("visual-story", undefined);
  for (const name of LIEFLAT) assert.ok(base.has(name), `${name} registered by default`);
  assert.deepEqual([...registered("visual-story", "0")].sort(), [...base].sort(), "marker other than 1 changes nothing");

  const lean = registered("visual-story", "1");
  console.log(`visual-story registered tools: baseline=${base.size} lean=${lean.size}`);
  assert.equal(base.size - lean.size, 2);
  assert.deepEqual([...base].filter((name) => !lean.has(name)).sort(), LIEFLAT);

  for (const profile of ["investigate", "visual", "publication", "competition", "full"]) {
    assert.deepEqual([...registered(profile, "1")].sort(), [...registered(profile, undefined)].sort(), `${profile} unaffected`);
  }
  console.log(JSON.stringify({ status: "PASS", baseline: base.size, lean: lean.size }));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
