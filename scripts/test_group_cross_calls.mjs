#!/usr/bin/env node
// Static ratchet on cross-group calls inside runtime/pi/newsroom.ts (the file keeps the bodies of tools from all four groups, see groups.json "files").
// It only reads source. It pins two things, as of the day it was written (10-11), and lets them only shrink:
//   1. every top-level function of newsroom.ts that is reached (directly or through other top-level functions) from tools of two or more groups;
//   2. every function imported from a module that groups.json assigns to a group, when a tool of another group reaches it.
// Red when: a group is added to a pinned entry; a new function is reached by two or more groups; a pinned entry no longer holds exactly
// (so the baseline can only get shorter: delete or edit the line); a registered tool is missing from groups.json or has no group;
// a tool site cannot be attributed to a tool name (listed as unattributed, never skipped silently).
// Baseline: the "cross_calls" table in runtime/pi/groups.json (K214 part C): the one table; the run-time gate for the knowledge entry functions reads the same lines.
//
// How it reads the code (no TypeScript parser is resolvable from this repository, nothing is installed, so it matches by name):
//   - comments, string and template-literal text are blanked first, regex literals are blanked by a simple rule;
//   - a "top-level declaration" starts at column 0 with function / const / let / var / class / type / interface / enum / export / import;
//   - an identifier counts as a use when it equals a top-level name and is not a property access (`.name`);
//   - what this misses: a local variable or parameter that shadows a top-level name (counted as a use: can only add groups, never hide one),
//     names built at run time (`registeredTools.get(name)` is a tool-to-tool call through the registry, listed apart, not followed),
//     calls through objects passed as arguments, and uses inside modules other than newsroom.ts.
// Why classes (every baseline entry says one): "设计上共用" = a pure helper, meant to be shared (it only computes: no file, network, process, environment, clock or
// random access, no async/await (that is I/O through a callback), no writer object in its text or in anything it reaches, and no artifact write; imports from node:fs, child_process, http, net, os and the like count as access, and so
// does any further import from another module of this repository, because that file is judged on its own entry); everything else is "10-11 现状，待拆".
// A line marked "设计上共用" turns red as soon as the function stops being pure. Imported functions are judged from the text of their own module.
// The baseline can only get shorter: `--write-baseline` on an existing baseline removes entries and narrows group lists, and refuses (exit 1) to add anything;
// a new entry has to be written into groups.json by hand and signed off by fe (with a why). Without a cross_calls table it writes the whole thing.
// "write" marks an entry whose function (or something it reaches) calls an artifact write primitive; for imported functions it is judged by the name.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };
const BASELINE_PATH = argAfter("--baseline-file") ?? join(REPO, "runtime/pi/groups.json"); // a groups.json-shaped file; the table is its "cross_calls"
const readTable = () => (existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")).cross_calls ?? null : null);

// ---- reading the source ------------------------------------------------------------------------------------------------------------------
// Same length as the input: comments, strings and template text become spaces (newlines stay), so offsets and line numbers still line up.
export function blank(src) {
  const out = src.split("");
  const n = src.length;
  const wipe = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const stack = []; // template literals being read: brace depth of each open ${ }
  let i = 0, lastSig = "";
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (stack.length && stack[stack.length - 1] === 0 && c === "}" ) { stack.pop(); i = readTemplate(i + 1, true); continue; }
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; wipe(i, end); i = end; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; wipe(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      wipe(i + 1, Math.min(j, n)); i = j + 1; lastSig = c; continue;
    }
    if (c === "`") { i = readTemplate(i + 1, false); lastSig = "`"; continue; }
    if (c === "/" && /[(,=:[!&|?{};]|^$|return|typeof|case/.test(lastSig)) { // a regex literal
      let j = i + 1, inClass = false;
      while (j < n && src[j] !== "\n") { if (src[j] === "\\") { j += 2; continue; } if (src[j] === "[") inClass = true; else if (src[j] === "]") inClass = false; else if (src[j] === "/" && !inClass) break; j++; }
      if (j < n && src[j] === "/") { wipe(i + 1, j); i = j + 1; lastSig = "/"; continue; }
    }
    if (stack.length) { if (c === "{") stack[stack.length - 1]++; else if (c === "}") stack[stack.length - 1]--; }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join("");
  function readTemplate(start) { // returns the index after the template text; pushes when a ${ opens
    let j = start;
    while (j < n && src[j] !== "`") {
      if (src[j] === "\\") { wipe(j, j + 2); j += 2; continue; }
      if (src[j] === "$" && src[j + 1] === "{") { stack.push(0); return j + 2; }
      wipe(j, j + 1); j++;
    }
    return j + 1;
  }
}

const DECL = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const COL0 = /^(?:export\b|import\b|function\b|async\s+function\b|const\b|let\b|var\b|class\b|type\b|interface\b|enum\b|declare\b)/;

// Top-level declarations: { name, kind: "function" | "value", start, end } in character offsets of the blanked text.
export function topLevel(clean) {
  const lines = clean.split("\n");
  const starts = [];
  let offset = 0;
  const offs = lines.map((line) => { const o = offset; offset += line.length + 1; return o; });
  lines.forEach((line, idx) => {
    if (!COL0.test(line)) return;
    if (/^import\b/.test(line)) { starts.push({ idx, import: true }); return; }
    const m = DECL.exec(line);
    starts.push(m ? { idx, name: m[2], keyword: m[1] } : { idx, other: true });
  });
  const decls = [];
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? offs[starts[k + 1].idx] : clean.length;
    if (s.import || s.other || !s.name) return;
    const start = offs[s.idx];
    let kind = "value";
    if (s.keyword.startsWith("function")) kind = "function";
    else if (s.keyword === "const" || s.keyword === "let" || s.keyword === "var") {
      const head = clean.slice(start, Math.min(end, start + 400)).replace(/\s+/g, " ");
      if (/=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(head)) kind = "function";
    }
    decls.push({ name: s.name, kind, start, end, line: s.idx + 1, isDefault: /^export\s+default/.test(lines[s.idx]) });
  });
  return decls;
}

// Matching close of the bracket at `open` in blanked text.
function closeOf(clean, open) {
  const pair = { "{": "}", "(": ")", "[": "]" }[clean[open]];
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === clean[open]) depth++;
    else if (clean[i] === pair && --depth === 0) return i;
  }
  return -1;
}

export function identifiers(clean, from, to) {
  const out = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  re.lastIndex = from;
  for (let m = re.exec(clean); m && m.index < to; m = re.exec(clean)) {
    let p = m.index - 1;
    while (p >= from && (clean[p] === " " || clean[p] === "\n" || clean[p] === "\t")) p--;
    const prev = clean[p];
    if (prev === "." && !(clean[p - 1] === "." && clean[p - 2] === ".")) continue; // property access, not a spread
    out.add(m[0]);
  }
  return out;
}

// ---- tools ----------------------------------------------------------------------------------------------------------------------------------
// A tool site is a call of registerScopedTool(pi, {..}) or pi.registerTool({..} | variable). Returns sites with the code spans they own and the tool names.
// Only the tool itself counts (its object literal, plus the local helpers of the registering function that the literal uses): the registering function's
// own start-up conditions (`toolEnabled`, switches) run once at registration, not when the tool runs.
const LOCAL = /^[ \t]+(?:async\s+)?(?:const|let|function)\s+([A-Za-z_$][\w$]*)/;
function statementEnd(clean, from, limit) {
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = clean[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) return i + 1;
    if (depth < 0) return i;
  }
  return limit;
}
// Only declarations at the registration's own indentation or shallower count: a `const rows` inside another tool's execute() is not a helper of this one.
function localDecls(clean, host, maxIndent) {
  const out = [];
  let offset = host.start;
  for (const line of clean.slice(host.start, host.end).split("\n")) {
    const m = LOCAL.exec(line);
    if (m && /^[ \t]*/.exec(line)[0].length <= maxIndent) out.push({ name: m[1], start: offset, end: statementEnd(clean, offset, host.end) });
    offset += line.length + 1;
  }
  return out;
}
export function toolSites(src, clean, decls) {
  const sites = [];
  const enclosing = (pos) => decls.find((d) => pos >= d.start && pos < d.end);
  const re = /\b(?:registerScopedTool\s*\(\s*[A-Za-z_$][\w$]*\s*,|[A-Za-z_$][\w$]*\.registerTool\s*\()\s*/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const host = enclosing(m.index);
    if (host?.name === "registerScopedTool" || host?.name === "newsroomExtension") continue; // forwarding code (the dispatcher, the group-order replay), not a tool
    const argStart = m.index + m[0].length;
    const lineStart = clean.lastIndexOf("\n", m.index) + 1;
    sites.push({ host, at: m.index, argStart, literal: clean[argStart] === "{", indent: /^[ \t]*/.exec(clean.slice(lineStart))[0].length });
  }
  const out = [];
  for (const s of sites) {
    const names = new Set();
    let spans = [];
    const hostText = s.host ? src.slice(s.host.start, s.host.end) : "";
    if (s.literal) {
      const close = closeOf(clean, s.argStart);
      const first = firstLevel(clean.slice(s.argStart, close + 1), src.slice(s.argStart, close + 1));
      const lit = /^name\s*:\s*["']([\w-]+)["']/.exec(first.nameProp ?? "");
      if (lit) names.add(lit[1]);
      else if (first.shorthandName) for (const x of hostText.matchAll(/\bconst\s+name\s*=\s*["']([\w-]+)["']/g)) names.add(x[1]);
      else if (/\bname\s*:\s*kind\.patchTool\b/.test(first.nameProp ?? "")) for (const x of src.matchAll(/\bpatchTool\s*:\s*["']([\w-]+)["']/g)) names.add(x[1]);
      spans.push([s.argStart, close + 1]);
    } else if (s.host) { // registerTool(variable): the tool is the object that variable is built from
      for (const x of hostText.matchAll(/\bconst\s+name\s*=\s*["']([\w-]+)["']/g)) names.add(x[1]);
      const arg = /^[A-Za-z_$][\w$]*/.exec(clean.slice(s.argStart, s.argStart + 80));
      const local = s.host && arg ? localDecls(clean, s.host, s.indent).find((d) => d.name === arg[0]) : null;
      if (local) spans.push([local.start, local.end]);
    }
    if (s.host) { // local helpers of the registering function that the tool uses, followed to a fixed point
      const locals = localDecls(clean, s.host, s.indent);
      const taken = new Set();
      for (let grew = true; grew;) {
        grew = false;
        for (const [from, to] of [...spans]) for (const id of identifiers(clean, from, to)) {
          const d = locals.find((l) => l.name === id);
          if (d && !taken.has(d.name)) { taken.add(d.name); spans.push([d.start, d.end]); grew = true; }
        }
      }
    }
    out.push({ line: src.slice(0, s.at).split("\n").length, host: s.host?.name ?? null, spans, names: [...names], literal: s.literal });
  }
  return out;
}

// First-level properties of an object literal: whether `name:` is a string literal, and whether the shorthand `name,` is used.
function firstLevel(clean, original) {
  let depth = 0, nameProp = null, shorthandName = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 1 && /\s|,|\{/.test(clean[i - 1] ?? "{") && clean.startsWith("name", i) && !/[\w$]/.test(clean[i + 4] ?? "")) {
      const rest = clean.slice(i + 4, i + 12);
      if (/^\s*,/.test(rest)) shorthandName = true;
      else if (/^\s*:/.test(rest)) nameProp = original.slice(i, i + 80);
    }
  }
  return { nameProp, shorthandName };
}

// ---- imports ---------------------------------------------------------------------------------------------------------------------------------
export function importsOf(clean, original) {
  const out = []; // { local, imported, from }
  const re = /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
  for (let m = re.exec(original); m; m = re.exec(original)) {
    if (clean.slice(m.index, m.index + 6) !== "import") continue;
    const clause = m[1].replace(/^type\s+/, "");
    const named = /\{([\s\S]*)\}/.exec(clause);
    if (named) for (const part of named[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const [imported, local = imported] = p.split(/\s+as\s+/);
      out.push({ local: local.trim(), imported: imported.trim(), from: m[2] });
    }
    const rest = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
    for (const piece of rest.split(/\s+/).filter(Boolean)) {
      if (piece === "*" || piece === "as") continue;
      out.push({ local: piece, imported: clause.includes("*") ? "*" : "default", from: m[2] });
    }
  }
  return out;
}

const WRITE_PRIMITIVES = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|renameSync|copyFileSync|rmSync|unlinkSync|writeArtifact\w*|appendArtifact\w*|saveClaim|saveComputation|saveQueryRows|saveDecision|saveRejection|saveChainEvent|writeTextArtifact|writeBytesArtifact|recordClaimArtifact)\b/;
const IMPURE = /\b(?:readFileSync|readdirSync|statSync|lstatSync|existsSync|openSync|readSync|readFile|readdir|createReadStream|fetch|spawn|spawnSync|exec|execSync|execFile|execFileSync|process|Date|Math\.random|randomUUID|setTimeout|setInterval|globalThis|require|import|async|await|[A-Za-z]*Writer)\b/;
const IMPURE_MODULE = /^(?:node:)?(?:fs|fs\/promises|child_process|http|https|net|dns|os|worker_threads|readline|tty|process)$/;
const WRITE_NAME = /(?:write|save|append|record|store|persist|materialize)/i;

// ---- the analysis -----------------------------------------------------------------------------------------------------------------------------
export function analyze({ src, groupsJson, file = "runtime/pi/newsroom.ts", readModule = () => null }) {
  const clean = blank(src);
  const decls = topLevel(clean);
  const byName = new Map(decls.map((d) => [d.name, d]));
  const sites = toolSites(src, clean, decls);
  const toolGroup = (name) => groupsJson.tools?.[name]?.group ?? null;

  const problems = [];
  const toolSpans = []; // { tool, from, to }
  const attributed = new Set();
  for (const s of sites) {
    if (!s.names.length) { problems.push(`UNATTRIBUTED tool site at ${file}:${s.line} (host ${s.host ?? "top level"}): no tool name found`); continue; }
    for (const name of s.names) { attributed.add(name); toolSpans.push({ tool: name, spans: s.spans }); }
  }
  for (const name of attributed) if (!toolGroup(name)) problems.push(`UNGROUPED tool ${name}: registered in ${file} but not in groups.json tools`);
  for (const name of Object.keys(groupsJson.tools ?? {})) if (!attributed.has(name)) problems.push(`UNATTRIBUTED tool ${name}: in groups.json but no registration site was recognised in ${file}`);

  // Nodes: every top-level declaration and every imported name. Edges: identifiers used inside the declaration.
  const imports = importsOf(clean, src);
  const importByLocal = new Map(imports.map((i) => [i.local, i]));
  const nodeNames = new Set([...byName.keys(), ...importByLocal.keys()]);
  const edges = new Map();
  for (const d of decls) {
    const used = identifiers(clean, d.start, d.end);
    edges.set(d.name, [...used].filter((id) => id !== d.name && nodeNames.has(id)));
  }
  // groups that reach each node
  const reach = new Map(); // node -> Set(group)
  const reachedByTool = new Map(); // node -> Set(tool)
  const visit = (node, tool, group, seen) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (!reach.has(node)) { reach.set(node, new Set()); reachedByTool.set(node, new Set()); }
    reach.get(node).add(group); reachedByTool.get(node).add(tool);
    for (const next of edges.get(node) ?? []) visit(next, tool, group, seen);
  };
  for (const span of toolSpans) {
    const group = toolGroup(span.tool);
    if (!group) continue;
    const seen = new Set();
    for (const [from, to] of span.spans) for (const id of identifiers(clean, from, to)) if (nodeNames.has(id)) visit(id, span.tool, group, seen);
  }
  // does a function write (itself or through what it reaches)?
  const writes = new Map();
  const writesOf = (node, stack = new Set()) => {
    if (writes.has(node)) return writes.get(node);
    if (stack.has(node)) return false;
    stack.add(node);
    const d = byName.get(node);
    let w = false;
    if (d) w = WRITE_PRIMITIVES.test(clean.slice(d.start, d.end)) || (edges.get(node) ?? []).some((next) => writesOf(next, stack));
    else if (importByLocal.has(node)) w = WRITE_NAME.test(importByLocal.get(node).imported);
    stack.delete(node);
    writes.set(node, w);
    return w;
  };

  // purity (see the header): text of the function and of every top-level function it reaches in this file; imports from the repository are judged from their module
  const modulePure = (() => {
    const memo = new Map();
    return (spec, name) => {
      const key = `${spec}::${name}`;
      if (memo.has(key)) return memo.get(key);
      memo.set(key, false); // cycles and unknowns stay impure
      const text = readModule(spec);
      let ok = false;
      if (text != null) {
        const mclean = blank(text);
        const mdecls = topLevel(mclean);
        const mby = new Map(mdecls.map((x) => [x.name, x]));
        const mimports = importsOf(mclean, text);
        const seen = new Set();
        const pureIn = (n) => {
          if (seen.has(n)) return true;
          seen.add(n);
          const x = mby.get(n);
          if (!x) return false;
          const body = mclean.slice(x.start, x.end);
          if (IMPURE.test(body) || WRITE_PRIMITIVES.test(body)) return false;
          for (const id of identifiers(mclean, x.start, x.end)) {
            if (id === n) continue;
            const imp = mimports.find((i) => i.local === id);
            if (imp) { if (imp.from.startsWith(".") || IMPURE_MODULE.test(imp.from)) return false; continue; }
            if (mby.has(id) && !pureIn(id)) return false;
          }
          return true;
        };
        ok = pureIn(name);
      }
      memo.set(key, ok);
      return ok;
    };
  })();
  const pures = new Map();
  const pureOf = (node, stack = new Set()) => {
    if (pures.has(node)) return pures.get(node);
    if (stack.has(node)) return true;
    stack.add(node);
    let p = false;
    const d = byName.get(node);
    if (d) {
      const body = clean.slice(d.start, d.end);
      p = !IMPURE.test(body) && !WRITE_PRIMITIVES.test(body) && (edges.get(node) ?? []).every((next) => pureOf(next, stack));
    } else if (importByLocal.has(node)) {
      const imp = importByLocal.get(node);
      p = imp.from.startsWith(".") ? modulePure(imp.from, imp.imported) : !IMPURE_MODULE.test(imp.from);
    }
    stack.delete(node);
    pures.set(node, p);
    return p;
  };

  const functions = {};
  for (const d of decls) {
    if (d.kind !== "function") continue;
    const groups = [...(reach.get(d.name) ?? [])].sort();
    if (groups.length >= 2) functions[d.name] = { groups, write: writesOf(d.name), pure: pureOf(d.name) };
  }
  const moduleGroup = (spec) => {
    const path = join(dirname(file), spec).replace(/\\/g, "/");
    for (const candidate of [path, path.replace(/\.js$/, ".mjs"), path.replace(/\.js$/, ".ts")]) if (groupsJson.files?.[candidate]) return groupsJson.files[candidate].group;
    return null;
  };
  const imported = {};
  for (const imp of imports) {
    if (!imp.from.startsWith(".")) continue;
    const owner = moduleGroup(imp.from);
    if (!owner) continue;
    const others = [...(reach.get(imp.local) ?? [])].filter((g) => g !== owner).sort();
    if (others.length) imported[`${imp.from.replace(/^\.\//, "")}::${imp.imported}`] = { owner, groups: others, write: writesOf(imp.local), pure: pureOf(imp.local) };
  }
  const toolsByFunction = (name) => [...(reachedByTool.get(name) ?? [])].sort();
  return { edges, nodeNames, problems, functions, imported, stats: { topLevel: decls.length, functions: decls.filter((d) => d.kind === "function").length, sites: sites.length, tools: attributed.size, imports: imports.length }, toolsByFunction, toolSpans, decls, reach };
}

// ---- ratchet ---------------------------------------------------------------------------------------------------------------------------------
export function compare(current, known) {
  const red = [];
  for (const section of ["functions", "imported"]) {
    const now = current[section], was = known[section] ?? {};
    for (const [key, entry] of Object.entries(now)) {
      const base = was[key];
      const tag = entry.write ? " [write]" : "";
      if (!base) { red.push(`NEW ${section === "functions" ? "function reached by two or more groups" : "import used by a group other than the module's owner"}: ${key} -> ${entry.groups.join(", ")}${tag}`); continue; }
      if (String(base.why ?? "").startsWith(WHY_SHARED) && (!entry.pure || entry.write)) red.push(`${key} is marked "${WHY_SHARED}" but is no longer a pure helper (it now touches a file, the network, the process, the environment, the clock or an artifact write)`);
      const extra = entry.groups.filter((g) => !base.groups.includes(g));
      if (extra.length) red.push(`MORE GROUPS reach ${key}: ${extra.join(", ")} (known: ${base.groups.join(", ")})`);
      else if (entry.write && !base.write) red.push(`${key} now reaches an artifact write that the baseline does not mark`);
      else if (entry.groups.length < base.groups.length || (!entry.write && base.write)) red.push(`STALE baseline entry ${section}.${key}: it now holds less (${entry.groups.join(", ")}${tag}); please shorten the baseline line`);
    }
    // a gated function is a table line even when one group alone reaches it (the run-time gate needs the line); it is not stale for that
    const gatedOnly = (key) => section === "functions" && (known.gated ?? []).includes(key) && was[key].groups.length < 2;
    for (const key of Object.keys(was)) if (!now[key] && !gatedOnly(key)) red.push(`STALE baseline entry ${section}.${key} no longer holds; please delete it from the baseline`);
  }
  return red;
}

const WHY_SHARED = "设计上共用";
const WHY_TODO = "10-11 现状，待拆";
const whyOf = (entry) => `${entry.pure && !entry.write ? WHY_SHARED : WHY_TODO + (entry.write ? "（写）" : "")}`;
const NOTE = "Cross-group references as of the day they were pinned. The test and the run-time gate read this one table. It may only get shorter; an addition needs fe sign-off and a why.";
export function baselineFrom(current) {
  const wrap = (section) => Object.fromEntries(Object.keys(section).sort().map((k) => [k, { groups: section[k].groups, ...(section[k].owner ? { owner: section[k].owner } : {}), write: section[k].write, why: whyOf(section[k]) }]));
  return { schema_version: "0.1.0", note: NOTE, functions: wrap(current.functions), imported: wrap(current.imported) };
}
// Existing baseline: delete entries that no longer hold, narrow group lists, drop write marks that went away, turn "待拆" into "设计上共用" for functions that are
// pure. Anything that would add a line, a group or a write mark throws: that is a hand edit with fe's sign-off.
export function shrinkBaseline(current, known) {
  const additions = compare(current, known).filter((m) => /^(NEW|MORE GROUPS|.* now reaches an artifact write)/.test(m));
  if (additions.length) throw new Error(`the baseline may only get shorter; this would add:\n${additions.join("\n")}`);
  const out = { ...known, functions: {}, imported: {} };
  for (const section of ["functions", "imported"]) for (const [key, base] of Object.entries(known[section] ?? {})) {
    const now = current[section][key];
    if (!now) continue;
    let why = base.why;
    if (now.pure && !now.write && String(why).startsWith(WHY_TODO)) why = WHY_SHARED;
    out[section][key] = { ...base, groups: now.groups, write: now.write, why };
  }
  return out;
}

// ---- main ------------------------------------------------------------------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const groupsJson = JSON.parse(readFileSync(join(REPO, "runtime/pi/groups.json"), "utf8"));
  const src = readFileSync(join(REPO, "runtime/pi/newsroom.ts"), "utf8");
  const readModule = (spec) => {
    const base = join(REPO, "runtime/pi", spec);
    for (const candidate of [base, base.replace(/\.js$/, ".mjs"), base.replace(/\.js$/, ".ts")]) if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    return null;
  };
  const current = analyze({ src, groupsJson, readModule });

  if (process.argv.includes("--print")) {
    console.log(JSON.stringify({ stats: current.stats, problems: current.problems, functions: Object.keys(current.functions).length, imported: Object.keys(current.imported).length }, null, 1));
    process.exit(0);
  }
  // --paths <name> [group]: for every tool (of that group, if given) that reaches <name>, the chain of top-level names it goes through, shortest first.
  const pathsAt = process.argv.indexOf("--paths");
  if (pathsAt > 0) {
    const [target, onlyGroup] = process.argv.slice(pathsAt + 1);
    for (const span of current.toolSpans) {
      const group = groupsJson.tools?.[span.tool]?.group;
      if (onlyGroup && group !== onlyGroup) continue;
      const clean = blank(src);
      const prev = new Map();
      const queue = [];
      for (const [from, to] of span.spans) for (const id of identifiers(clean, from, to)) if (current.nodeNames.has(id) && !prev.has(id)) { prev.set(id, null); queue.push(id); }
      for (let k = 0; k < queue.length; k++) for (const next of current.edges.get(queue[k]) ?? []) if (!prev.has(next)) { prev.set(next, queue[k]); queue.push(next); }
      if (!prev.has(target)) continue;
      const chain = [];
      for (let n = target; n; n = prev.get(n)) chain.unshift(n);
      console.log(`${span.tool} (${group}): ${chain.join(" -> ")}`);
    }
    process.exit(0);
  }
  if (process.argv.includes("--write-baseline")) {
    const whole = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    let next;
    if (!whole.cross_calls) { const fresh = baselineFrom(current); next = { note: fresh.note, functions: fresh.functions, imported: fresh.imported }; }
    else {
      try { next = shrinkBaseline(current, whole.cross_calls); } catch (error) { console.error(error.message); process.exit(1); }
    }
    writeFileSync(BASELINE_PATH, JSON.stringify({ ...whole, cross_calls: next }, null, 1) + "\n");
    console.log("baseline written");
    process.exit(0);
  }

  // self-test on a small fixture: a visual tool calling a knowledge-only function is red; removing the call leaves a stale entry; the real file is green
  const FIX_GROUPS = { tools: { read_a: { group: "knowledge" }, draw_b: { group: "visual" } }, files: { "runtime/pi/k.mjs": { group: "knowledge" } } };
  const fixture = (visualCalls, knowledgeFn) => `import { fromK } from "./k.mjs";
function readOnlyKnowledge(x) { return x; }
function shared(x) { return x; }
function writeBits() { writeFileSync("p", "x"); }
export default function ext(pi) {
  registerScopedTool(pi, {
    name: "read_a",
    async execute() { shared(1); fromK(); ${knowledgeFn} },
  });
  registerScopedTool(pi, {
    name: "draw_b",
    async execute() { // readOnlyKnowledge(2) in a comment is not a call
      const s = "readOnlyKnowledge(3) in a string is not a call";
      ${visualCalls}
    },
  });
}
`;
  const check = (visualCalls, knowledgeFn, known) => {
    const r = analyze({ src: fixture(visualCalls, knowledgeFn), groupsJson: FIX_GROUPS });
    assert.deepEqual(r.problems, [], "fixture tools are recognised");
    return { r, red: compare(r, known) };
  };
  const base = check("", "readOnlyKnowledge(1);", { functions: {}, imported: {} });
  assert.deepEqual(base.red, [], "nothing shared yet: green");
  const bad = check("readOnlyKnowledge(2);", "readOnlyKnowledge(1);", { functions: {}, imported: {} });
  assert.ok(bad.red.some((m) => m.startsWith("NEW function reached by two or more groups: readOnlyKnowledge")), `visual tool calling a knowledge function is red: ${bad.red}`);
  const viaHelper = check("shared(2);", "", { functions: {}, imported: {} });
  assert.ok(viaHelper.red.some((m) => m.includes("shared")), "a function shared through its callers is seen");
  const known = baselineFrom(bad.r);
  assert.deepEqual(check("readOnlyKnowledge(2);", "readOnlyKnowledge(1);", known).red.filter((m) => m.includes("readOnlyKnowledge")), [], "the pinned line is green");
  const gone = check("", "readOnlyKnowledge(1);", known);
  assert.ok(gone.red.some((m) => /STALE baseline entry functions\.readOnlyKnowledge/.test(m) && /delete it from the baseline/.test(m)), `removing the call asks to delete the baseline line: ${gone.red}`);
  const gatedKnown = { ...known, gated: ["readOnlyKnowledge"], functions: { ...known.functions, readOnlyKnowledge: { ...known.functions.readOnlyKnowledge, groups: ["visual"] } } };
  assert.deepEqual(compare(gone.r, gatedKnown).filter((m) => m.includes("readOnlyKnowledge")), [], "a gated function's single-group line is not stale");
  const imp = analyze({ src: fixture("fromK();", ""), groupsJson: FIX_GROUPS });
  assert.deepEqual(Object.keys(imp.imported), ["k.mjs::fromK"], "an import from a knowledge module used by a visual tool is pinned");
  assert.deepEqual(imp.imported["k.mjs::fromK"].groups, ["visual"]);
  const w = analyze({ src: fixture("writeBits();", "writeBits();"), groupsJson: FIX_GROUPS });
  assert.equal(w.functions.writeBits.write, true, "a function that calls a write primitive is marked write");
  assert.equal(blank("const a = '/*'; // x\nconst b = `t ${ f('y') } u`;\n").includes("f("), true, "template expressions stay visible");
  assert.equal(blank("const re = /['\"]/g; foo();").includes("foo()"), true, "a regex literal with quotes does not swallow the code after it");
  const unnamed = analyze({ src: fixture("", "").replace('name: "draw_b"', "label: 'x'"), groupsJson: FIX_GROUPS });
  assert.ok(unnamed.problems.some((m) => m.startsWith("UNATTRIBUTED")), "a tool site without a name is red, not skipped");
  // why classes and the shrink-only rule
  const both = analyze({ src: fixture("shared(2); writeBits();", "writeBits();"), groupsJson: FIX_GROUPS });
  const pinned = baselineFrom(both);
  assert.equal(pinned.functions.shared.why, WHY_SHARED, "a pure shared helper is marked designed-shared");
  assert.equal(pinned.functions.writeBits.why, `${WHY_TODO}（写）`, "a writing function is marked to-split and write");
  const impureNow = analyze({ src: fixture("shared(2); writeBits();", "writeBits();").replace("function shared(x) { return x; }", "function shared(x) { return readFileSync(x); }"), groupsJson: FIX_GROUPS });
  assert.ok(compare(impureNow, pinned).some((m) => m.includes("shared") && m.includes(WHY_SHARED) && /no longer a pure helper/.test(m)), "a designed-shared line turns red when the function stops being pure");
  assert.throws(() => shrinkBaseline(both, { ...pinned, functions: { shared: pinned.functions.shared } }), /only get shorter/, "--write-baseline on an existing baseline refuses to add an entry");
  const shorter = shrinkBaseline(check("", "writeBits();", pinned).r, pinned);
  assert.ok(!("shared" in shorter.functions) || shorter.functions.shared.groups.length < 2, "shrinking drops what no longer holds");
  assert.deepEqual(Object.keys(shrinkBaseline(both, pinned).functions).sort(), Object.keys(pinned.functions).sort(), "an unchanged baseline stays as it is");
  console.log("self-test -- PASS");

  // the real file
  assert.deepEqual(current.problems, [], `every tool is recognised and grouped:\n${current.problems.join("\n")}`);
  const known2 = readTable();
  assert.ok(known2, "groups.json has a cross_calls table (node scripts/test_group_cross_calls.mjs --write-baseline once)");
  for (const section of ["functions", "imported"]) for (const [key, entry] of Object.entries(known2[section] ?? {})) assert.ok(typeof entry.why === "string" && entry.why.length > 0, `baseline entry ${section}.${key} says why`);
  const red = compare(current, known2);
  assert.deepEqual(red, [], `cross-group calls changed:\n${red.join("\n")}`);
  console.log(`group cross calls: ${current.stats.functions} functions, ${current.stats.tools} tools, ${Object.keys(current.functions).length} functions reached by 2+ groups, ${Object.keys(current.imported).length} imports used across groups -- PASS`);
}
