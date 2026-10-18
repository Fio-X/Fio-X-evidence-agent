// Every file src/runtime.rs writes under runtime/ (each `runtime_dir.join("name")`) needs a materialized_runtime / exact rule in runtime/pi/groups.json
// artifact_kinds.rules. Without one the product's own write is refused by the boundary and the binary exits at start (#217 once lacked the refs_block2.mjs rule; no test caught it).
// Only starting the real binary exercises the rule itself; this test keeps the list and the rules in step. Pure source read, no build, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const runtimeSource = readFileSync(`${ROOT}src/runtime.rs`, "utf8");
const groups = JSON.parse(readFileSync(`${ROOT}runtime/pi/groups.json`, "utf8"));

const joinedNames = (source) => [...new Set([...source.matchAll(/runtime_dir\s*\.join\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]))].sort();
const missingRules = (source, table) => {
  const rules = table.artifact_kinds?.rules;
  assert.ok(Array.isArray(rules), "groups.json has no artifact_kinds.rules");
  const exact = new Set(rules.filter((r) => r.kind === "materialized_runtime" && typeof r.exact === "string").map((r) => r.exact));
  return joinedNames(source).filter((name) => !exact.has(`runtime/${name}`));
};

const names = joinedNames(runtimeSource);
assert.ok(names.length > 60, `only ${names.length} runtime_dir.join names found; the pattern no longer matches src/runtime.rs`);
assert.ok(names.includes("refs_block2.mjs") && names.includes("lieflat.mjs"), "the pattern missed known names");
assert.deepEqual(missingRules(runtimeSource, groups), [], "runtime_dir.join names with no materialized_runtime exact rule in groups.json");

// mutants: a rule deleted, and a new module joined without a rule, must both be reported
for (const victim of ["runtime/refs_block2.mjs", "runtime/lieflat.mjs"]) {
  const cut = structuredClone(groups);
  const before = cut.artifact_kinds.rules.length;
  cut.artifact_kinds.rules = cut.artifact_kinds.rules.filter((r) => r.exact !== victim);
  assert.equal(cut.artifact_kinds.rules.length, before - 1, `${victim}: expected exactly one rule to delete`);
  assert.deepEqual(missingRules(runtimeSource, cut), [victim.replace("runtime/", "")], `deleting the ${victim} rule was not caught`);
}
assert.deepEqual(missingRules(`${runtimeSource}\nlet x = runtime_dir.join("brand_new_module.mjs");`, groups), ["brand_new_module.mjs"], "a new runtime module without a rule was not caught");
assert.deepEqual(missingRules(runtimeSource, { artifact_kinds: { rules: [{ kind: "project_state", prefix: "runtime/" }] } }).length, names.length, "a prefix rule must not stand in for the exact rules");

console.log(`PASS ${names.length} runtime_dir.join names each have a materialized_runtime exact rule; deleting one, adding one unlisted, or a prefix rule instead is caught`);
