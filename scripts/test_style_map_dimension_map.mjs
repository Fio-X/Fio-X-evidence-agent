// newsroom_style_map applies the same dimension boundary map as the publication plan (relationship -> network),
// so a story that uses the program's own word is not refused. Registry, resolver and check are unchanged:
// a word the registry does not know is still refused. Offline, real tool on a type-stripped copy of the runtime.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmp = makeTestTmp("style-map-dimension-map-");
const stub = (name, source) => {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
};
cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
stub("typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
stub("@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
const pi = join(tmp, "runtime", "pi");
writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(join(pi, "newsroom.test-copy.mjs"));
process.env.NEWSROOM_TOOL_PROFILE = "full";
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const styleMap = tools.get("newsroom_style_map");
assert.ok(styleMap, "newsroom_style_map is registered");
const call = (params) => styleMap.execute("t", params);

const topologies = ["graph_edges"];
const mapped = await call({ dimensions: ["relationship", "outcome"], topologies });
const plain = await call({ dimensions: ["network", "outcome"], topologies });
assert.equal(mapped.details.profile, plain.details.profile, "relationship resolves like network");
assert.equal(mapped.details.profile, "investigative_network");

// Same with a requested profile: the mapped word is compatible there, as the render already finds it.
const requested = await call({ requested: "investigative_network", dimensions: ["relationship"], topologies });
assert.equal(requested.details.profile, "investigative_network");

// Nothing is loosened: a word the registry does not know is still refused.
await assert.rejects(() => call({ requested: "investigative_network", dimensions: ["not_a_dimension"], topologies }), /STYLE_MAPPING_BLOCKED: dimension:not_a_dimension/);
console.log(JSON.stringify({ status: "PASS", profile: mapped.details.profile }));
