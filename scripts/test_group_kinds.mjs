// The path -> artifact kind table now lives in runtime/pi/groups.json (artifact_kinds), shared with the Rust side. This test pins it:
//  1. the hand-written sample file (scripts/fixtures/group_path_samples.json, also read by the Rust test) is classified as written;
//  2. against the old regex table (copied below as an oracle): every path the old table classified keeps its kind (only the five bare
//     folder names of the run skeleton changed), and every path that changed was 待查 before: the table was filled in, no rule was edited;
//  3. the added kinds list fixed names only (exact), each with a note saying who writes it and why it is this group's;
//  4. mutants: a deleted row, a table that cannot be read and a table with a wrong owner change the answer (nothing falls back to "fine").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const g = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const samples = JSON.parse(readFileSync(join(ROOT, "scripts/fixtures/group_path_samples.json"), "utf8"));
const kindOf = (path) => g.classifyArtifact(path)?.kind ?? null;
let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };

// 1
for (const row of samples) eq(kindOf(row.path), row.kind, `sample ${JSON.stringify(row.path)}`);

// 2: the table as it was in groups.mjs before it moved into groups.json
const OLD = [[/^claims\.jsonl$/, "evidence"], [/^(computations|sources|searches|data)\//, "evidence"], [/^runtime\/query-rows\//, "evidence"], [/^shadow\//, "observation"], [/^visualizations\/graph-analysis\//, "evidence"], [/^editorial\/(preferences|award-runs)\//, "pass_decision"], [/^infographics\/(vision-critics|competition-preflight)\//, "pass_decision"], [/^verification-rounds\//, "pass_decision"], [/^plan\.json$/, "project_state"], [/^runtime\//, "project_state"], [/^infographics\/(plan-rejections|plan-patches|chain-rejections|chain-patches)\//, "project_state"], [/^(visualizations|infographics|editorial|maps|models|publications|lieflat)\//, "visual_spec"], [/^config\//, "rules"]];
const oldKind = (path) => { for (const [re, kind] of OLD) if (re.test(path)) return kind; return null; };
const SKELETON = new Set(["data/", "data/origins/", "computations/", "visualizations/", "infographics/", "runtime/", "sources/", "searches/", "runtime/assets/", "runtime/vendor/"]);
// The files runtime.rs copies into the run folder, read from the source so the table cannot drift from what the program writes.
const runtimeSource = readFileSync(join(ROOT, "src/runtime.rs"), "utf8");
const MATERIALIZED = new Set();
for (const [dir, prefix] of [["runtime_dir", "runtime/"], ["assets_dir", "runtime/assets/"], ["vendor_dir", "runtime/vendor/"]]) for (const m of runtimeSource.matchAll(new RegExp(`${dir}\\s*\\.join\\("([^"]+)"\\)`, "g"))) MATERIALIZED.add(prefix + m[1]);
assert.equal(MATERIALIZED.size, 111, "runtime.rs materializes 111 fixed names under runtime/ (108th: runtime/record_only.mjs, 10-13 integ; 109th and 110th: runtime/location_evidence.mjs and runtime/location_proof.mjs, #202; 111th: runtime/refs_block2.mjs, #217)");
assert.ok(MATERIALIZED.has("runtime/record_only.mjs"), "record_only.mjs is named: the next module added to runtime.rs without a row goes red");
const dirs = ["", "data", "computations", "sources", "searches", "visualizations", "infographics", "editorial", "maps", "models", "publications", "lieflat", "config", "runtime", "shadow", "verification-rounds", "session", "plan-progress"];
const leaves = ["", "a.json", "x/y.json", "claims.jsonl", "plan.json", "story.json", "answer.md", "graph-analysis/g.json", "query-rows/q.json", "origins/o.json", "plan-rejections/r.json", "plan-patches/p.json", "chain-rejections/r.json", "chain-patches/p.json", "vision-critics/v.json", "competition-preflight/c.json", "preferences/p.json", "award-runs/a.json"];
const paths = new Set(samples.map((row) => row.path));
for (const d of dirs) for (const l of leaves) paths.add(d && l ? `${d}/${l}` : d ? `${d}/` : l);
let filledIn = 0;
for (const path of paths) {
  const before = oldKind(path), after = kindOf(path);
  if (before !== null && !SKELETON.has(path) && !MATERIALIZED.has(path)) eq(after, before, `old classification kept: ${JSON.stringify(path)}`);
  if (before === null && after !== null) filledIn += 1;
  if (before !== after && before !== null) assert.ok(SKELETON.has(path) || MATERIALIZED.has(path), `a classified path changed kind: ${JSON.stringify(path)} ${before} -> ${after}`);
}
assert.ok(filledIn >= 12, `previously-unclassified paths now classified: ${filledIn}`);
console.log(`group kinds: ${filledIn} paths in the sample went from 待查 to classified (fixed names only)`);

// 3: every rule with a note is a fixed name (exact), nothing added is a prefix; the materialized rows are exactly what runtime.rs writes
const list = g.loadGroups();
const rules = list.artifact_kinds.rules;
const added = rules.filter((r) => r.note !== undefined);
for (const rule of added) {
  assert.ok(rule.exact !== undefined && rule.prefix === undefined, `added rule is a fixed name, not a prefix: ${JSON.stringify(rule)}`);
  assert.ok(typeof rule.note === "string" && rule.note.length > 30, `added rule has a note: ${JSON.stringify(rule.exact)}`);
  checks += 2;
}
eq(added.filter((r) => r.kind === "materialized_runtime").map((r) => r.exact).sort(), [...MATERIALIZED].sort(), "materialized_runtime rows == the names runtime.rs writes");
eq(added.filter((r) => r.kind === "run_record" && (r.exact === "" || r.exact.endsWith("/"))).length, 12, "skeleton folders (the run folder + 11 fixed subfolders)");
eq(added.length, 12 + 111 + 12 + 2 + 5, "added fixed names: 12 skeleton + 111 materialized + 12 run files / state / verification + 2 agent-session + 5 torn copies (1011af)");
for (const name of MATERIALIZED) eq(kindOf(name), "materialized_runtime", `${name} is materialized_runtime`);
for (const name of ["runtime/query-rows/q.json", "runtime/tool-chain-events.jsonl", "runtime/fetch-split-probe/p.json", "runtime/newsroom.ts.bak", "runtime/assets/other.json", "runtime/gis/adnplot.R"]) eq(kindOf(name), name === "runtime/query-rows/q.json" ? "evidence" : "project_state", `${name} stays out of the materialized kind`);
for (const rule of rules) assert.ok(list.artifact_kinds.ownership[rule.kind]?.owner, `rule kind has an owner: ${rule.kind}`);
for (const name of ["answer.md", "assistant-answer.md", "conversation.md", "prompt.md"]) eq(g.classifyArtifact(name)?.tag, "transcript", `${name} is tagged transcript`);

// 4: mutants. The table is the parsed object groups.mjs caches, so a change here is seen by the classifier; each is undone afterwards.
const table = list.artifact_kinds;
const keep = { rules: table.rules, ownership: table.ownership };
try {
  table.rules = rules.filter((r) => r.exact !== "claims.jsonl");
  eq(kindOf("claims.jsonl"), null, "mutant: a deleted row makes the path 待查 (refused), never fine");
  table.rules = keep.rules;
  table.rules = rules.map((r) => (r.exact === "verification.json" ? { ...r, kind: "run_record" } : r));
  eq(kindOf("verification.json"), "run_record", "mutant: a changed row changes the answer");
  table.rules = keep.rules;
  table.ownership = { ...keep.ownership, evidence: { ...keep.ownership.evidence, owner: "visual" } };
  eq(g.classifyArtifact("claims.jsonl").owner, "visual", "mutant: the owner comes from the table");
  table.ownership = { ...keep.ownership };
  delete table.ownership.evidence;
  eq(g.classifyArtifact("claims.jsonl"), null, "a rule whose kind has no owner classifies nothing");
} finally { table.rules = keep.rules; table.ownership = keep.ownership; }
eq(kindOf("claims.jsonl"), "evidence", "table restored");
console.log(`group kinds: ${checks} checks -- PASS`);
