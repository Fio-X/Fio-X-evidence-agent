// A STYLE_MAPPING_BLOCKED refusal names the profiles that fit the call's dimensions and topologies (K1015), computed by asking the resolver about each registry profile.
// description (only with NEWSROOM_FIRST_TRY_ENUMS=1). The words come from the registry through the resolver's reader;
// a test registry with a changed word proves none is written in code. Offline, real tool on a type-stripped copy.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE_DESCRIPTION = "Resolve a functional editorial style profile from story dimensions and topology. The result controls typography, density, annotation, geometry, motion restraint, surface and interaction depth; it is not a decorative theme switch.";

function stub(tmp, name, source) {
  mkdirSync(join(tmp, "node_modules", name), { recursive: true });
  writeFileSync(join(tmp, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tmp, "node_modules", name, "index.js"), source);
}
// One runtime tree per registry: the registry path is fixed when style_mapping.mjs loads.
async function load(label, editRegistry) {
  const tmp = makeTestTmp(`style-map-words-${label}-`);
  cpSync(join(ROOT, "runtime"), join(tmp, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tmp, "config"), { recursive: true });
  const registryPath = join(tmp, "config", "editorial-style-mappings.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (editRegistry) { editRegistry(registry); writeFileSync(registryPath, JSON.stringify(registry)); }
  stub(tmp, "typebox", "const builder = () => ({});\nexport const Type = new Proxy({}, { get: () => builder });\n");
  stub(tmp, "@earendil-works/pi-ai", "export const StringEnum = () => ({});\n");
  const pi = join(tmp, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  const mod = await import(join(pi, "newsroom.test-copy.mjs"));
  return {
    registry,
    tool(enumsSwitch) {
      process.env.NEWSROOM_TOOL_PROFILE = "full";
      if (enumsSwitch === undefined) delete process.env.NEWSROOM_FIRST_TRY_ENUMS; else process.env.NEWSROOM_FIRST_TRY_ENUMS = enumsSwitch;
      const tools = new Map();
      mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
      return tools.get("newsroom_style_map");
    },
  };
}
const refusal = async (tool, params) => {
  try { await tool.execute("t", params); } catch (error) { return String(error.message); }
  assert.fail("the call was expected to be refused");
};
const listed = (text) => { const m = text.match(/Profiles that fit these dimensions and topologies: (.*?); pass requested as one of them\./); assert.ok(m, `the refusal carries the profile note: ${text}`); return m[1]; };
const real = await load("real");
const tool = real.tool();
// a profile that does not fit is requested on purpose, so the call is refused and the note is read off the refusal
const wrong = "analytical_precision";
assert.equal(listed(await refusal(tool, { requested: wrong, dimensions: ["flow", "spatial"], topologies: ["flow_edges", "geography"] })), "japanese_editorial");
assert.equal(listed(await refusal(tool, { requested: wrong, dimensions: ["trend", "rank", "spatial"], topologies: ["tabular", "geography"] })), "japanese_editorial");
assert.equal(listed(await refusal(tool, { dimensions: ["not_a_dimension"], topologies: ["tabular"] })), "none");
// the note comes from the registry through the resolver: a registry where japanese_editorial no longer takes flow_edges lists none for the first call
const narrowed = await load("narrowed", (registry) => {
  const p = registry.profiles.japanese_editorial;
  p.compatible_topologies = p.compatible_topologies.filter((t) => t !== "flow_edges");
});
assert.equal(listed(await refusal(narrowed.tool(), { requested: wrong, dimensions: ["flow", "spatial"], topologies: ["flow_edges", "geography"] })), "none");
// no profile name is written in code: a registry with a new profile that fits lists it
const added = await load("added", (registry) => {
  registry.profiles.zz_new_profile = structuredClone(registry.profiles.japanese_editorial);
});
assert.equal(listed(await refusal(added.tool(), { requested: wrong, dimensions: ["flow", "spatial"], topologies: ["flow_edges", "geography"] })), "japanese_editorial, zz_new_profile");
// the tool description is untouched (no new words in it)
for (const value of [undefined, "0", "1"]) assert.ok(!real.tool(value).description.includes("Profiles that fit"), `switch ${value}: description unchanged`);
console.log(JSON.stringify({ status: "PASS" }));
