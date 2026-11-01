#!/usr/bin/env node
// Static check: second-layer nodes read no file and reach no host, pinned per file. It only reads source and changes nothing.
//
// The rule (scripts/fixtures/node-file-reads-pinned.json): a second-layer node gets everything on its stdin line from the visual
// group's entry. A file under `files` (runtime/nodes/, runtime/leaves_py/) has a finding when it
//   - imports a builtin module (node:fs, child_process, net, os, ...; Python os, io, pathlib, subprocess, socket, urllib, ...), except
//     the one stdin/stdout module its runner line allows (run.mjs node:readline, run.py sys);
//   - imports a package other than `js_packages` (d3, d3-*), or a Python module outside `py_modules` that is no sibling node file;
//   - imports a relative module outside `files`, or one that groups.json gives to another group (e.g. runtime/pi/economy_names.mjs,
//     knowledge), or a relative path that is not a code file (.json, .wasm, no extension);
//   - loads code at run time or reaches the host: import(), require(), eval, new Function, Worker, fetch, WebSocket, XMLHttpRequest,
//     process.* (a runner may use process.stdin, process.stdout, process.argv), globalThis, Deno, Bun; Python open(), __import__,
//     exec, eval, compile, importlib, __builtins__.
// A module of the node folders that a file imports (JS relative import, Python sibling module) is followed: the import itself is a
// finding of the importer ("imports words (runtime/leaves_py/words.py), which breaks the rule") whenever the imported module has a
// finding of its own or through what it imports, since its top level runs at import.
// Findings are counted by SITE (each import statement, each call) and carry no line number, so a pinned list stays stable while
// unrelated lines move.
//
// Pinned per file (`pinned`, {file: {finding: sites}}), measured on a clean checkout:
//   - a file not pinned is red as soon as it has one finding (a new file must be clean);
//   - more sites than pinned is red; fewer sites is red too until the pin is lowered to the new count;
//   - a pinned finding that no longer holds is red ("delete the line").
// Files under `not_nodes` (bake.py, knobs.py: program steps, not nodes) are skipped and listed by name in the output.
// Group ownership comes from runtime/pi/groups.json (read, never written): its file_rules place the node folders' code files in
// the visual group (P3). The rule's parameters here are held equal to groups.json cross_calls.node_rule by
// scripts/test_group_node_rule.mjs.
//
// Self-tests run first (17 must-fail sources, 3 must-pass sources, 1 site count, 2 ownership, 6 compare cases); then the real
// files are scanned and compared with `pinned`. Any self-test not as expected, or any compare problem, exits non-zero.
// --print-pinned prints the measured {file: {finding: sites}} map as JSON (for lowering pins), and still compares.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "scripts/fixtures/node-file-reads-pinned.json";
const SPEC = JSON.parse(readFileSync(join(REPO, FIXTURE), "utf8"));
const RULE = SPEC;
const GROUPS = JSON.parse(readFileSync(join(REPO, "runtime/pi/groups.json"), "utf8"));
const groupOf = (g, rel) =>
  g.files?.[rel]?.group ?? (g.file_rules ?? []).find((r) => rel.startsWith(r.prefix) && (!r.suffix || rel.endsWith(r.suffix)))?.group ?? null;
const underRule = (rel) => RULE.files.some((p) => rel.startsWith(p));
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// ---- stripping ------------------------------------------------------------------------------------------------------------------------
/** JS: [code with comments blanked (strings kept, for import specifiers), code with comments and strings blanked]. Same length. */
export function stripJs(src) {
  let code = "", bare = "";
  const put = (s, keepInCode, keepInBare) => {
    code += keepInCode ? s : s.replace(/[^\n]/g, " ");
    bare += keepInBare ? s : s.replace(/[^\n]/g, " ");
  };
  for (let i = 0; i < src.length;) {
    const two = src.slice(i, i + 2), c = src[i];
    if (two === "//") { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; put(src.slice(i, e), false, false); i = e; continue; }
    if (two === "/*") { const j = src.indexOf("*/", i + 2); const e = j < 0 ? src.length : j + 2; put(src.slice(i, e), false, false); i = e; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      put(c, true, true); put(src.slice(i + 1, j), true, false); put(src.slice(j, j + 1), true, true); i = j + 1; continue;
    }
    put(c, true, true); i++;
  }
  return [code, bare];
}

/** Python: [code with comments blanked (strings kept), code with comments and strings blanked]. */
export function stripPy(src) {
  let code = "", bare = "";
  const put = (s, keepInCode, keepInBare) => {
    code += keepInCode ? s : s.replace(/[^\n]/g, " ");
    bare += keepInBare ? s : s.replace(/[^\n]/g, " ");
  };
  for (let i = 0; i < src.length;) {
    const c = src[i], three = src.slice(i, i + 3);
    if (c === "#") { const j = src.indexOf("\n", i); const e = j < 0 ? src.length : j; put(src.slice(i, e), false, false); i = e; continue; }
    if (three === '"""' || three === "'''") {
      const j = src.indexOf(three, i + 3); const e = j < 0 ? src.length : j + 3;
      put(src.slice(i, e), true, false); i = e; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      put(c, true, true); put(src.slice(i + 1, j), true, false); put(src.slice(j, j + 1), true, true); i = j + 1; continue;
    }
    put(c, true, true); i++;
  }
  return [code, bare];
}

// ---- the rule -------------------------------------------------------------------------------------------------------------------------
/** A source reader: the self-test overlay first, then the repository; null when there is no such file. */
export const makeReader = (overlay = {}) => (rel) => {
  if (rel in overlay) return overlay[rel];
  const abs = join(REPO, rel);
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null;
};
const sites = (re, text) => text.match(new RegExp(re.source, "g"))?.length ?? 0;

/** One file's own findings (Map finding -> sites) and the node-folder modules it imports ({spec, to}, one per import site). */
function direct(rel, src, g, read) {
  const out = new Map();
  const add = (what, n = 1) => n > 0 && out.set(what, (out.get(what) ?? 0) + n);
  const local = [];
  const runner = RULE.runners[rel] ?? { js_builtins: [], py_modules: [] };
  if (/\.(mjs|cjs|js)$/.test(rel)) {
    const [code, bare] = stripJs(src);
    for (const m of code.matchAll(/\b(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?(["'])([^"'\n]+)\1/g)) {
      const spec = m[2];
      if (spec.startsWith(".")) {
        const to = normalize(join(dirname(rel), spec)).replace(/\\/g, "/");
        const owner = groupOf(g, to);
        if (owner && owner !== "visual") add(`imports ${spec}: owned by ${owner}, not visual`);
        else if (!underRule(to)) add(`imports ${spec}: outside the node folders (${owner ?? "no group"})`);
        else if (!owner) add(`imports ${spec}: owned by no group`);
        else if (!/\.(mjs|cjs|js)$/.test(to)) add(`imports ${spec}: not a code file (a node imports only .mjs, .cjs, .js; data comes on stdin)`);
        else local.push({ spec, to });
      } else if (BUILTIN.has(spec)) {
        if (!runner.js_builtins.includes(spec)) add(`imports builtin ${spec}`);
      } else {
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (!RULE.js_packages.includes(pkg) && !RULE.js_packages.some((p) => pkg.startsWith(`${p}-`))) add(`imports package ${pkg}`);
      }
    }
    const reach = [
      [/\bimport\s*\(/, "loads code at run time: import()"],
      [/\brequire\s*\(/, "loads code at run time: require()"],
      [/\beval\s*\(/, "calls eval"],
      [/\bnew\s+Function\b/, "builds code: new Function"],
      [/\bnew\s+Worker\b/, "starts a worker"],
      [/\bfetch\s*\(/, "calls fetch"],
      [/\b(?:WebSocket|XMLHttpRequest)\b/, "opens a socket"],
      [/\b(?:globalThis|Deno|Bun)\b/, "reaches the host object"],
    ];
    for (const [re, what] of reach) add(what, sites(re, bare));
    const allowedProcess = RULE.runners[rel] ? new Set(["stdin", "stdout", "argv"]) : new Set();
    for (const m of bare.matchAll(/\bprocess\s*(?:\.\s*(\w+)|\[)?/g)) {
      if (!m[1] || !allowedProcess.has(m[1])) add(`reaches process${m[1] ? `.${m[1]}` : ""}`);
    }
  } else if (rel.endsWith(".py")) {
    const [, bare] = stripPy(src);
    const mods = [];
    for (const line of bare.split("\n")) {
      let m = /^\s*import\s+(.+)$/.exec(line);
      if (m) for (const part of m[1].split(",")) mods.push(part.trim().split(/\s+as\s+/)[0].split(".")[0]);
      m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
      if (m && m[1].startsWith(".")) for (const part of m[2].replace(/[()]/g, "").split(",")) mods.push(part.trim().split(/\s+as\s+/)[0]);
      else if (m) mods.push(m[1].split(".")[0]);
    }
    for (const mod of mods) {
      const to = `${dirname(rel)}/${mod}.py`;
      if (read(to) != null) local.push({ spec: mod, to }); // a module of the node folder: followed, never skipped
      else if (!RULE.py_modules.includes(mod) && !runner.py_modules.includes(mod)) add(`imports ${mod}`);
    }
    const reach = [
      [/(?<![\w.])open\s*\(/, "calls open()"],
      [/\b__import__\s*\(/, "loads code at run time: __import__"],
      [/(?<![\w.])exec\s*\(/, "calls exec"],
      [/(?<![\w.])eval\s*\(/, "calls eval"],
      [/(?<![\w.])compile\s*\(/, "calls compile"],
      [/\bimportlib\b/, "loads code at run time: importlib"],
      [/\b__builtins__\b/, "reaches __builtins__"],
    ];
    for (const [re, what] of reach) add(what, sites(re, bare));
  }
  return { out, local };
}

/** Findings of one file (repo-relative `rel`, text `src`) with the node-folder modules it imports followed: Map(finding -> sites). */
export function findings(rel, src, g = GROUPS, read = makeReader(), memo = new Map(), stack = new Set()) {
  if (memo.has(rel)) return memo.get(rel);
  stack.add(rel);
  const { out, local } = direct(rel, src, g, read);
  for (const { spec, to } of local) {
    if (stack.has(to)) continue; // an import cycle: the module's own findings are counted where the scan meets it first
    const text = read(to);
    const what = text == null ? `imports ${spec} (${to}), which is no file` : `imports ${spec} (${to}), which breaks the rule`;
    if (text == null || findings(to, text, g, read, memo, stack).size) out.set(what, (out.get(what) ?? 0) + 1);
  }
  stack.delete(rel);
  memo.set(rel, out);
  return out;
}
const show = (f) => [...f].sort(([a], [b]) => (a < b ? -1 : 1)).map(([w, n]) => `${w} x${n}`);

/** compare(real, pinned): both {file: {finding: sites}}; returns one line per problem (empty when they agree). */
export const compare = (realMap, pinned) => {
  const out = [];
  for (const [file, fs] of Object.entries(realMap)) {
    const pin = pinned[file];
    for (const [w, n] of Object.entries(fs)) {
      const p = pin?.[w];
      if (!pin) out.push(`${file}: not pinned, so it must be clean; it has ${n} site(s) of ${w}`);
      else if (p === undefined) out.push(`${file}: ${w} (${n}) is not pinned for this file`);
      else if (n > p) out.push(`${file}: ${w} ${n} sites, pinned ${p}: counts may only go down`);
      else if (n < p) out.push(`${file}: ${w} ${n} sites, pinned ${p}: lower the pin to ${n}`);
    }
  }
  for (const [file, ps] of Object.entries(pinned)) for (const w of Object.keys(ps))
    if (!realMap[file]?.[w]) out.push(`${file}: pinned ${w} no longer holds: delete the line`);
  return out;
};

// ---- self-tests of the scan -----------------------------------------------------------------------------------------------------------
const results = [];
const red = (name, rel, src, want, overlay = {}) => {
  const got = show(findings(rel, src, GROUPS, makeReader(overlay)));
  assert.ok(got.some((f) => f.includes(want)), `${name}: expected a finding with ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  results.push(`must-fail ${name}: red as expected (${got.join("; ")})`);
};
const green = (name, rel, src, overlay = {}) => {
  const got = show(findings(rel, src, GROUPS, makeReader(overlay)));
  assert.deepEqual(got, [], `${name}: expected no finding, got ${JSON.stringify(got)}`);
  results.push(`must-pass ${name}: no finding as expected`);
};

red("F1 a JS fill node reads the land file itself", "runtime/nodes/bubbles_fill.mjs",
  `import { readFileSync } from "node:fs";\nexport const fill = (req) => JSON.parse(readFileSync("runtime/assets/naturalearth-admin0-50m.geojson", "utf8"));\n`,
  "imports builtin node:fs");
red("F2 a JS fill node calls the knowledge group's name module", "runtime/nodes/bars_fill.mjs",
  `import { iso2Of } from "../pi/economy_names.mjs";\nexport const fill = (req) => ({ codes: req.rows.map((r) => iso2Of(r.dims.geo)) });\n`,
  "owned by knowledge");
red("F3 a Python fill node opens a file", "runtime/leaves_py/bubbles_fill.py",
  `import json\n\ndef fill(req):\n    return json.load(open("/data/ne.geojson"))\n`,
  "calls open()");
red("F4 a JS node loads another group's module at run time", "runtime/nodes/bars_fill.mjs",
  `export const fill = async (req) => (await import("../pi/economy_names.mjs")).iso2Of(req.rows[0].dims.geo);\n`,
  "loads code at run time: import()");
red("F5 a JS node reads the environment", "runtime/nodes/legend.mjs",
  `export const draw = (req) => ({ svg: process.env.HOME });\n`,
  "reaches process.env");
red("F6 a Python node starts a process", "runtime/leaves_py/column_fill.py",
  `import subprocess\n\ndef fill(req):\n    return subprocess.run(["curl", "x"]).returncode\n`,
  "imports subprocess");
red("F7 the runner's stdin module is not allowed in a node", "runtime/nodes/bars_fill.mjs",
  `import { createInterface } from "node:readline";\nexport const fill = (req) => ({});\n`,
  "imports builtin node:readline");
red("F8 a Python node imports os by from", "runtime/leaves_py/bars_fill.py",
  `from os import path\n\ndef fill(req):\n    return path.exists("x")\n`,
  "imports os");
red("F9 a new Python node imports words (words.py opens words.zh.json at import)", "runtime/leaves_py/bars_fill.py",
  `import words\n\ndef fill(req):\n    return {"w": words.word("column.note.hi")}\n`,
  "imports words (runtime/leaves_py/words.py), which breaks the rule");
red("F10 a new Python node imports prod (prod.py reads places.json at import)", "runtime/leaves_py/bars_fill.py",
  `from prod import esc\n\ndef fill(req):\n    return {}\n`,
  "imports prod (runtime/leaves_py/prod.py), which breaks the rule");
red("F11 a new Python node imports facts (facts.py reads csv files)", "runtime/leaves_py/bars_fill.py",
  `import facts as FX\n\ndef fill(req):\n    return {}\n`,
  "imports facts (runtime/leaves_py/facts.py), which breaks the rule");
red("F12 a JS node imports a sibling that reads a file (two steps down)", "runtime/nodes/bars_fill.mjs",
  `import { W } from "./helper.mjs";\nexport const fill = (req) => ({ w: W });\n`,
  "imports ./helper.mjs (runtime/nodes/helper.mjs), which breaks the rule",
  { "runtime/nodes/helper.mjs": `import { R } from "./reader.mjs";\nexport const W = R;\n`,
    "runtime/nodes/reader.mjs": `import { readFileSync } from "node:fs";\nexport const R = readFileSync("words.json", "utf8");\n` });
red("F13 a Python node imports a sibling by relative from", "runtime/leaves_py/bars_fill.py",
  `from . import helper\n\ndef fill(req):\n    return {}\n`,
  "imports helper (runtime/leaves_py/helper.py), which breaks the rule",
  { "runtime/leaves_py/helper.py": `import os\nX = os.getcwd()\n` });
red("F14 a JS node imports a sibling json (import attributes)", "runtime/nodes/bars_fill.mjs",
  `import WORDS from "./words.zh.json" with { type: "json" };\nexport const fill = (req) => ({ w: WORDS["column.note.hi"] });\n`,
  "imports ./words.zh.json: not a code file",
  { "runtime/nodes/words.zh.json": `{"column.note.hi": "x"}\n` });
red("F15 a JS node imports a sibling wasm", "runtime/nodes/bars_fill.mjs",
  `import * as M from "./layout.wasm";\nexport const fill = (req) => ({ m: M });\n`,
  "imports ./layout.wasm: not a code file");
red("F16 a JS node imports a sibling with no extension", "runtime/nodes/bars_fill.mjs",
  `import { W } from "./words";\nexport const fill = (req) => ({ w: W });\n`,
  "imports ./words: not a code file");
red("F17 a Python node reads a sibling json through pkgutil", "runtime/leaves_py/bars_fill.py",
  `import json, pkgutil\n\ndef fill(req):\n    return json.loads(pkgutil.get_data(__name__, "words.zh.json"))\n`,
  "imports pkgutil");

const twice = findings("runtime/leaves_py/x_fill.py", `def a():\n    return open("a")\n\ndef b():\n    return open("b")\n`, GROUPS, makeReader());
assert.equal(twice.get("calls open()"), 2, "two open() calls are two sites");
results.push("site count: two open() calls in one file count 2 (pinned counts sites, not file x kind)");

green("P1 a pure JS fill node (d3, a sibling, words in comments and strings)", "runtime/nodes/bars_fill.mjs",
  `// readFileSync("x") and process.env in a comment are not code\nimport { geoMercator } from "d3";\nimport { r1 } from "./common.mjs";\nconst NOTE = "open( require( import( fetch( in a string are words";\nexport const fill = (req) => ({ fragment: { selects: [], note: NOTE, x: r1(geoMercator ? 1 : 0) } });\n`);
green("P2 the JS runner (stdin/stdout only)", "runtime/nodes/run.mjs",
  `import { createInterface } from "node:readline";\nimport * as bars from "./bars_fill.mjs";\nif (import.meta.url === \`file://\${process.argv[1]}\`) {\n  const rl = createInterface({ input: process.stdin });\n  rl.on("line", (l) => process.stdout.write(JSON.stringify(bars.fill(JSON.parse(l))) + "\\n"));\n}\n`,
  { "runtime/nodes/bars_fill.mjs": `import { r1 } from "./common.mjs";\nexport const fill = (req) => ({ n: r1(req.rows.length) });\n` });
green("P3 a pure Python fill node (stdlib only, a pure sibling followed, open( in a docstring)", "runtime/leaves_py/bars_fill.py",
  `"""bars fill: never open( a file; the rows come on stdin."""\nimport json, math\nfrom collections import OrderedDict\nimport purehelp\n\ndef fill(req):\n    return {"fragment": OrderedDict(n=math.floor(len(req["rows"]) * purehelp.K))}\n`,
  { "runtime/leaves_py/purehelp.py": `import math\nK = math.pi / math.pi\n` });

// Ownership: groups.json places the node folders' code files in the visual group; a module of another group stays its own.
for (const rel of ["runtime/nodes/run.mjs", "runtime/leaves_py/bubbles.py"])
  assert.equal(groupOf(GROUPS, rel), "visual", `${rel} is not visual in groups.json`);
results.push("ownership: runtime/nodes/run.mjs and runtime/leaves_py/bubbles.py are visual in groups.json");
assert.equal(groupOf(GROUPS, "runtime/pi/economy_names.mjs"), "knowledge");
results.push("ownership: runtime/pi/economy_names.mjs stays knowledge in groups.json");

// ---- self-tests of compare ------------------------------------------------------------------------------------------------------------
const P = { "runtime/leaves_py/a.py": { "calls open()": 2 } };
const pinCases = [
  ["a new file with one finding", { ...P, "runtime/nodes/new.mjs": { "imports node:fs": 1 } }, "not pinned, so it must be clean"],
  ["a pinned file with one more site", { "runtime/leaves_py/a.py": { "calls open()": 3 } }, "may only go down"],
  ["a pinned file with one site fewer, pin not lowered", { "runtime/leaves_py/a.py": { "calls open()": 1 } }, "lower the pin"],
  ["a pinned file with a finding kind it was not pinned for", { "runtime/leaves_py/a.py": { "calls open()": 2, "calls eval": 1 } }, "is not pinned for this file"],
  ["a pinned finding gone", {}, "delete the line"],
];
const pinBad = [];
for (const [label, r, want] of pinCases) {
  const got = compare(r, P);
  if (got.some((x) => x.includes(want))) results.push(`pin must-fail ${label}: red as expected`);
  else pinBad.push(`pin must-fail ${label}: NOT red, got ${JSON.stringify(got)}`);
}
if (compare(P, P).length) pinBad.push("pin must-pass equal counts: NOT clean");
else results.push("pin must-pass equal counts: clean as expected");

// ---- the real files -------------------------------------------------------------------------------------------------------------------
const real = [];
const walkDir = (dir) => {
  for (const name of readdirSync(join(REPO, dir)).sort()) {
    const rel = `${dir}${name}`;
    if (RULE.skip_dirs.includes(name)) continue;
    if (statSync(join(REPO, rel)).isDirectory()) walkDir(`${rel}/`);
    else if (/\.(mjs|cjs|js|py)$/.test(name)) real.push(rel);
  }
};
for (const p of RULE.files) if (existsSync(join(REPO, p))) walkDir(p);
assert.ok(real.length > 0, "the real scan found no file under files");
const read = makeReader();
const memo = new Map();
const realMap = {};
const lines = [];
const skipped = [];
let total = 0, own = 0;
for (const rel of real) {
  if (RULE.not_nodes[rel]) { skipped.push(rel); lines.push(`  ${rel}: SKIPPED (not_nodes)`); continue; }
  const f = findings(rel, read(rel), GROUPS, read, memo);
  if (!f.size) { lines.push(`  ${rel}: clean`); continue; }
  realMap[rel] = Object.fromEntries(f);
  total += [...f.values()].reduce((a, b) => a + b, 0);
  own += [...f].filter(([w]) => !w.includes("which breaks the rule")).reduce((a, [, c]) => a + c, 0);
  lines.push(`  ${rel}: ${show(f).join("; ")}`);
}
const problems = compare(realMap, RULE.pinned);
for (const rel of Object.keys(RULE.not_nodes))
  if (!real.includes(rel)) problems.push(`${rel}: listed under not_nodes but no such file under ${RULE.files.join(" ")}: delete the line`);

// ---- report ---------------------------------------------------------------------------------------------------------------------------
const count = (prefix) => results.filter((r) => r.startsWith(prefix)).length;
console.log(results.join("\n"));
for (const x of pinBad) console.log(`  NOT AS EXPECTED ${x}`);
const want = 17 + 3 + 1 + 2 + pinCases.length + 1;
const selfOk = results.length === want && pinBad.length === 0;
console.log(`self-tests: ${results.length}/${want} as expected (${count("must-fail")} must-fail red, ${count("must-pass")} must-pass green, ` +
  `1 site count, 2 ownership, ${count("pin must-fail")} pin must-fail red, ${count("pin must-pass")} pin must-pass green)`);
console.log(`real scan (files ${RULE.files.join(" ")}):`);
console.log(lines.join("\n"));
console.log(`skipped (not_nodes, not scanned): ${skipped.length ? skipped.join(", ") : "none"}`);
console.log(`real scan: ${real.length} files, ${skipped.length} skipped, ${Object.keys(realMap).length} with findings, ${total} sites ` +
  `(${own} own, ${total - own} imports of a breaking module)`);
if (process.argv.includes("--print-pinned")) console.log(JSON.stringify(realMap, null, 1));
const pinnedSites = Object.values(RULE.pinned).reduce((a, fs) => a + Object.values(fs).reduce((b, n) => b + n, 0), 0);
console.log(`pinned compare: ${Object.keys(RULE.pinned).length} files pinned, ${pinnedSites} sites pinned, ${problems.length} problem(s)`);
for (const x of problems) console.log(`  RED ${x}`);
if (!selfOk || problems.length) {
  console.log("FAIL: test_node_file_reads_pinned");
  process.exitCode = 1;
} else console.log("ok: test_node_file_reads_pinned");
