// newsroom_style_map states the words the style registry accepts: in the refusal text (always) and in the tool
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
const words = (registry, key) => [...new Set(Object.values(registry.profiles).flatMap((p) => p[key]))];

const real = await load("real");
const dims = words(real.registry, "compatible_dimensions");
const tops = words(real.registry, "compatible_topologies");
assert.ok(dims.length > 0 && tops.length > 0);

// (a) switch on: the description carries every registry dimension and topology word.
const described = real.tool("1").description;
for (const word of [...dims, ...tops]) assert.ok(described.includes(word), `description names ${word}`);
assert.ok(described.startsWith(BASE_DESCRIPTION));

// (c) switch off, unset or any value but exactly 1: the description is byte-identical to the one before this change.
for (const value of [undefined, "0", "true", "11"]) assert.equal(real.tool(value).description, BASE_DESCRIPTION, `switch ${value}: unchanged`);

// (b) a refusal lists the allowed words: the requested profile's own, or the union plus the profile clause.
const tool = real.tool();
const own = real.registry.profiles.investigative_network;
const withProfile = await refusal(tool, { requested: "investigative_network", dimensions: ["trend", "not_a_dimension"], topologies: ["tabular"] });
assert.match(withProfile, /^STYLE_MAPPING_BLOCKED: dimension:trend \| dimension:not_a_dimension \| topology:tabular\. /);
assert.ok(withProfile.includes(`Allowed for investigative_network: dimensions ${own.compatible_dimensions.join(", ")}; topologies ${own.compatible_topologies.join(", ")}.`));
const noProfile = await refusal(tool, { dimensions: ["not_a_dimension"], topologies: ["tabular"] });
assert.ok(noProfile.includes(`Allowed words: dimensions ${dims.join(", ")}; topologies ${tops.join(", ")}.`));
assert.ok(noProfile.includes("The profile is chosen from the dimensions."));

// (b) nothing is written in code: a registry with a changed word set shows the changed words, and not the old one.
const swapped = await load("swapped", (registry) => {
  const profile = registry.profiles.investigative_network;
  profile.compatible_dimensions = profile.compatible_dimensions.filter((d) => d !== "network").concat("zz_new_dimension");
});
assert.ok(!swapped.registry.profiles.investigative_network.compatible_dimensions.includes("network"));
const changed = await refusal(swapped.tool(), { requested: "investigative_network", dimensions: ["not_a_dimension"], topologies: ["graph_edges"] });
assert.ok(changed.includes("zz_new_dimension"));
const changedList = changed.split("Allowed for investigative_network: dimensions ")[1].split(";")[0].split(", ");
assert.ok(!changedList.includes("network"), "the dropped word is no longer offered");
assert.ok(swapped.tool("1").description.includes("zz_new_dimension"));

console.log(JSON.stringify({ status: "PASS", dimensions: dims.length, topologies: tops.length }));
