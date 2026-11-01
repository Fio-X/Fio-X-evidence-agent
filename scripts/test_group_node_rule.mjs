#!/usr/bin/env node
// Rule three (runtime/pi/groups.json cross_calls.node_rule, P3): a second-layer node gets everything it uses on its one stdin
// line from the visual group's entry. It only reads source and changes nothing.
//
// The scan of the node files and their per-file pins is scripts/test_node_file_reads_pinned.mjs (its fixture is the entry's
// `pinned_in`); this test holds the entry, that fixture and the registries to each other, so the rule has one text:
//   - groups.json has cross_calls.node_rule with files, skip_dirs, not_nodes, runners, js_packages, py_modules and pinned_in,
//     and no pinned list of its own (pins live in pinned_in only, where they may only go down);
//   - pinned_in's rule parameters are the entry's, key by key;
//   - every tracked code file under the entry's files (and each runner and not_nodes file) is the visual group's in groups.json;
//     each runner and not_nodes file lies under files;
//   - the page tree core's runner folders (src/next_tree.rs RUNNER_DIRS, under the run's runtime/) are the entry's files;
//   - every node the page tree core binds external (runtime/page_tree/node-bindings.json) names a runner that is a code file
//     under the entry's files with no `..`, and the leaf registry (runtime/leaves_py/knobs.json binding) binds the same nodes
//     external, each binding "external" (absent is rust);
//   - src/next_tree.rs is the visual group's and under cross_calls.rust_rule_next.files (its calls are held by
//     scripts/test_group_module_calls.mjs).
// Self-tests: the real inputs are clean, and each of the must-fail copies below is red with its own reason.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const PARAMS = ["files", "skip_dirs", "not_nodes", "runners", "js_packages", "py_modules"];
const CODE = /\.(?:mjs|cjs|js|py)$/;

const groupOf = (g, rel) =>
  g.files?.[rel]?.group ?? (g.file_rules ?? []).find((r) => rel.startsWith(r.prefix ?? "") && (!r.suffix || rel.endsWith(r.suffix)) && (r.prefix || r.suffix))?.group ?? null;
const same = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

/** The RUNNER_DIRS of src/next_tree.rs, as written. */
export const runnerDirs = (src) => {
  const m = src.match(/pub const RUNNER_DIRS: \[&str; \d+\] = \[([^\]]*)\];/);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
};

/** Every problem of the inputs, one line each; [] is clean. */
export function problemsOf({ groups, pinned, bindings, knobs, treeSrc, codeFiles }) {
  const out = [];
  const rule = groups.cross_calls?.node_rule;
  if (!rule) return ["groups.json has no cross_calls.node_rule"];
  for (const k of [...PARAMS, "pinned_in"]) if (rule[k] == null) out.push(`node_rule has no ${k}`);
  if ("pinned" in rule) out.push(`node_rule holds a pinned list; pins live in ${rule.pinned_in} only`);
  if (!pinned) out.push(`pinned_in ${rule.pinned_in} cannot be read`);
  else for (const k of PARAMS) if (!same(rule[k], pinned[k])) out.push(`node_rule.${k} and ${rule.pinned_in} ${k} differ: one rule, one text`);
  const files = rule.files ?? [];
  const under = (rel) => files.some((p) => rel.startsWith(p));
  for (const rel of codeFiles.filter(under)) if (groupOf(groups, rel) !== "visual") out.push(`${rel}: under node_rule.files, and groups.json gives it ${groupOf(groups, rel)}, not visual`);
  for (const rel of [...Object.keys(rule.runners ?? {}), ...Object.keys(rule.not_nodes ?? {})]) {
    if (!under(rel)) out.push(`${rel}: named by node_rule, not under its files`);
    else if (groupOf(groups, rel) !== "visual") out.push(`${rel}: named by node_rule, not visual in groups.json`);
  }
  const dirs = runnerDirs(treeSrc);
  if (!dirs) out.push("src/next_tree.rs has no RUNNER_DIRS");
  else if (!same([...dirs.map((d) => `runtime/${d}`)].sort(), [...files].sort())) out.push(`src/next_tree.rs RUNNER_DIRS ${JSON.stringify(dirs)} under runtime/ are not node_rule.files ${JSON.stringify(files)}`);
  const external = Object.entries(bindings.nodes ?? {}).filter(([, e]) => e.binding === "external");
  for (const [name, e] of Object.entries(bindings.nodes ?? {}))
    if (e.binding != null && e.binding !== "external") out.push(`node-bindings.json ${name}: binding ${JSON.stringify(e.binding)}; only "external" (absent is rust)`);
  for (const [name, e] of external) {
    const rel = `runtime/${e.runner ?? ""}`;
    if (typeof e.runner !== "string" || !CODE.test(rel) || rel.split("/").some((s) => s === ".." || s === "." || s === "") || !under(rel))
      out.push(`node-bindings.json ${name}: runner ${JSON.stringify(e.runner)} is not a code file under node_rule.files`);
  }
  const leafExternal = [];
  for (const [name, n] of Object.entries(knobs.nodes ?? {})) {
    if (n.binding == null) continue;
    if (n.binding !== "external") out.push(`knobs.json ${name}: binding ${JSON.stringify(n.binding)}; only "external" (absent is rust)`);
    else leafExternal.push(name);
  }
  const coreExternal = external.map(([n]) => n).sort();
  if (!same(leafExternal.sort(), coreExternal)) out.push(`knobs.json binds ${JSON.stringify(leafExternal)} external, node-bindings.json ${JSON.stringify(coreExternal)}`);
  if (groups.files?.["src/next_tree.rs"]?.group !== "visual") out.push("src/next_tree.rs is not the visual group's in groups.json");
  if (!(groups.cross_calls?.rust_rule_next?.files ?? []).includes("src/next_tree.rs")) out.push("src/next_tree.rs is not under cross_calls.rust_rule_next.files");
  return out;
}

// ---- the real inputs -------------------------------------------------------------------------------------------------------------
const groups = readJson("runtime/pi/groups.json");
const rule = groups.cross_calls?.node_rule ?? {};
const real = {
  groups,
  pinned: rule.pinned_in ? readJson(rule.pinned_in) : null,
  bindings: readJson("runtime/page_tree/node-bindings.json"),
  knobs: readJson("runtime/leaves_py/knobs.json"),
  treeSrc: readFileSync(join(REPO, "src/next_tree.rs"), "utf8"),
  codeFiles: spawnSync("git", ["-C", REPO, "ls-files", "--cached", "--others", "--exclude-standard", ...(rule.files ?? [])], { encoding: "utf8" })
    .stdout.split("\n").filter((f) => CODE.test(f) && !(rule.skip_dirs ?? []).some((d) => f.split("/").includes(d))),
};
assert.ok(real.codeFiles.length > 0, "found the node folders' code files");

// ---- must-fail copies --------------------------------------------------------------------------------------------------------------
const copy = (x) => JSON.parse(JSON.stringify(x));
const mutants = [
  ["no node_rule", (i) => delete i.groups.cross_calls.node_rule, "no cross_calls.node_rule"],
  ["a pinned list inside groups.json", (i) => (i.groups.cross_calls.node_rule.pinned = {}), "holds a pinned list"],
  ["the pinned fixture allows one more Python module", (i) => i.pinned.py_modules.push("os"), "py_modules and"],
  ["the entry drops a node folder", (i) => (i.groups.cross_calls.node_rule.files = ["runtime/nodes/"]), "RUNNER_DIRS"],
  ["the Python leaves lose their group", (i) => (i.groups.file_rules = i.groups.file_rules.filter((r) => !(r.prefix === "runtime/leaves_py/" && r.suffix === ".py"))), "not visual"],
  ["a runner outside the node folders", (i) => (i.groups.cross_calls.node_rule.runners["runtime/pi/run.mjs"] = {}), "not under its files"],
  ["the core may run a node from runtime/pi/", (i) => (i.treeSrc = i.treeSrc.replace(/pub const RUNNER_DIRS: \[&str; 2\] = \[/, 'pub const RUNNER_DIRS: [&str; 3] = ["pi/", ')), "RUNNER_DIRS"],
  ["an external node run from another group's folder", (i) => {
    i.bindings.nodes.bars = { binding: "external", runner: "../pi/economy_names.mjs" };
    i.knobs.nodes.bars = { ...(i.knobs.nodes.bars ?? {}), binding: "external" };
  }, "is not a code file under node_rule.files"],
  ["an external node whose runner is data", (i) => {
    i.bindings.nodes.bars = { binding: "external", runner: "leaves_py/words.zh.json" };
    i.knobs.nodes.bars = { ...(i.knobs.nodes.bars ?? {}), binding: "external" };
  }, "is not a code file under node_rule.files"],
  ["the leaf registry binds a node external the core does not", (i) => (i.knobs.nodes.bars = { ...(i.knobs.nodes.bars ?? {}), binding: "external" }), "knobs.json binds"],
  ["a binding that is neither absent nor external", (i) => (i.knobs.nodes.bars = { ...(i.knobs.nodes.bars ?? {}), binding: "rust" }), "only \"external\""],
  ["next_tree.rs out of rule one's files", (i) => (i.groups.cross_calls.rust_rule_next.files = i.groups.cross_calls.rust_rule_next.files.filter((f) => f !== "src/next_tree.rs")), "rust_rule_next"],
];
const results = [];
const bad = [];
const clean = problemsOf(real);
if (clean.length) bad.push(`must-pass the real inputs: NOT clean: ${clean.join("; ")}`);
else results.push("must-pass the real inputs: clean");
for (const [label, mutate, want] of mutants) {
  const i = { ...real, groups: copy(real.groups), pinned: copy(real.pinned), bindings: copy(real.bindings), knobs: copy(real.knobs) };
  mutate(i);
  const got = problemsOf(i);
  if (got.some((p) => p.includes(want))) results.push(`must-fail ${label}: red as expected`);
  else bad.push(`must-fail ${label}: NOT red with "${want}", got ${JSON.stringify(got)}`);
}
console.log(results.join("\n"));
for (const x of bad) console.log(`  NOT AS EXPECTED ${x}`);
const external = Object.entries(real.bindings.nodes ?? {}).filter(([, e]) => e.binding === "external").map(([n]) => n);
console.log(`node rule: ${results.length}/${mutants.length + 1} as expected (${mutants.length} must-fail red, 1 must-pass clean); ` +
  `${real.codeFiles.length} node code files visual; runner folders ${JSON.stringify(rule.files)}; nodes bound external: ${external.length ? external.join(", ") : "none"}`);
if (bad.length) {
  console.log("FAIL: test_group_node_rule");
  process.exitCode = 1;
} else console.log("ok: test_group_node_rule");
