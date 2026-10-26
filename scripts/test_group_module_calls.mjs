#!/usr/bin/env node
// K315: static ratchet on cross-group references OUTSIDE runtime/pi/newsroom.ts (that file has its own, scripts/test_group_cross_calls.mjs). It only reads source. Two parts,
// both pinned as of the day they were written (10-13) in the same table, runtime/pi/groups.json "cross_calls", and both may only shrink:
//   1. cross_calls.modules: every name that a TypeScript/JavaScript module imports from a module that groups.json assigns to ANOTHER group
//      (key `<callee module relative to runtime/pi>::<name>`, value {owner, groups = the importing modules' groups, from = the importing modules, write, why}).
//      The run-time record (always on, K315 export wrap) reads this table next to cross_calls.imported, so `declared` means the same thing for both.
//   2. cross_calls.rust_modules: every item that a Rust file under src/ reaches in a module of another group (`use crate::m::x`, `crate::m::x`, or `x` through
//      `use crate::m;` then `m::x`), key `<src file> -> <src file of the module>::<name>`, value {from_group, owner, why}. Names are taken as written; a glob is `*`.
//      The Rust side has no run-time hook (a call there is fixed at compile time), so this is the only place a new cross-group reference in Rust turns red.
//   3. cross_calls.rust_rule_next: the one rule for the new route's Rust files (`files`), in place of pinned lines for them. A reference from one of those files
//      passes when it names a type or constant (`shared_kinds`, judged from the item's own definition) of another file in `files`, or, from an agent file, one
//      of the system functions listed under `agent_calls`, or, from an agent file, the one entry function of another group's command file
//      (`group_entries`, e.g. next_knowledge.rs `call`); anything else from them (a function, `Type::function`, a glob, an item not found) is red as before.
//      Files outside `files` are read and pinned exactly as in part 2: the rule never removes or loosens one of their lines.
// Red when: a key, a group, an importing module or a write mark is added to a pinned entry; an entry no longer holds exactly (delete or shorten the line).
// How it reads the code (no parser is installed): comments and string text are blanked, imports are read by their own syntax and every import of another group's module counts, used or not (an import is the way in). What it misses: names built at run time, calls through objects passed as arguments, method calls on a
// value (`catalog.top5()`: only the type and `Type::function` paths show), `super::` and `self::` paths in Rust (counted and printed by --print so a growth shows), a Rust item reached only inside a #[cfg(test)] module (not scanned), macros that build paths.
// Baseline changes follow scripts/test_group_cross_calls.mjs: an addition is a hand edit with a why and sign-off; --write-baseline only writes the sections while they are
// missing, afterwards it only removes or narrows lines.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { blank, importsOf } from "./test_group_cross_calls.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };
const BASELINE_PATH = argAfter("--baseline-file") ?? join(REPO, "runtime/pi/groups.json");
const PI = "runtime/pi/";
const WRITE_NAME = /(?:write|save|append|record|store|persist|materialize)/i;
const WHY = "10-13 现状，待拆";
// The one name every wrapped module imports from groups.mjs for the K315 report-only block. test_k315_export_wrap pins that it is used only inside that block.
const RECORD_PLUMBING = new Set(["trackExport"]);

// ---- TypeScript / JavaScript modules ---------------------------------------------------------------------------------------------------------
const resolveModule = (groupsJson, from, spec) => {
  const base = normalize(join(dirname(from), spec)).replace(/\\/g, "/");
  for (const candidate of [base, base.replace(/\.js$/, ".mjs"), base.replace(/\.js$/, ".ts")]) if (groupsJson.files?.[candidate]) return candidate;
  return null;
};
/** files: Map(repo path -> source text) of every runtime/pi module except newsroom.ts. Returns { key: { owner, groups, from, write } }. */
export function analyzeModules({ files, groupsJson }) {
  const out = {};
  for (const [file, text] of files) {
    const fromGroup = groupsJson.files?.[file]?.group;
    if (!fromGroup || file === `${PI}newsroom.ts`) continue;
    const clean = blank(text);
    for (const imp of importsOf(clean, text)) {
      if (!imp.from.startsWith(".")) continue;
      const to = resolveModule(groupsJson, file, imp.from);
      const owner = to && groupsJson.files[to].group;
      if (!owner || owner === fromGroup) continue;
      if (RECORD_PLUMBING.has(imp.imported) && to === `${PI}groups.mjs`) continue; // the K315 record's own wrap block (pinned by test_k315_export_wrap), not a call into the system group
      const key = `${to.replace(PI, "")}::${imp.imported}`;
      const entry = (out[key] ??= { owner, groups: new Set(), from: new Set(), write: WRITE_NAME.test(imp.imported) });
      entry.groups.add(fromGroup);
      entry.from.add(file.replace(PI, ""));
    }
  }
  for (const entry of Object.values(out)) { entry.groups = [...entry.groups].sort(); entry.from = [...entry.from].sort(); }
  return out;
}

// ---- Rust ------------------------------------------------------------------------------------------------------------------------------------
/** Blank comments, string and char literals (length kept) and cut the file at its first `#[cfg(test)] mod x {` block. */
export function blankRust(src) {
  const cut = src.search(/^#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/m);
  const text = cut >= 0 ? src.slice(0, cut) : src;
  let out = "";
  for (let i = 0; i < text.length;) {
    const two = text.slice(i, i + 2);
    if (two === "//") { const j = text.indexOf("\n", i); const end = j < 0 ? text.length : j; out += " ".repeat(end - i); i = end; continue; }
    if (two === "/*") { let depth = 1, j = i + 2; while (j < text.length && depth) { if (text.startsWith("/*", j)) { depth++; j += 2; } else if (text.startsWith("*/", j)) { depth--; j += 2; } else j++; } out += text.slice(i, j).replace(/[^\n]/g, " "); i = j; continue; }
    const raw = /^r(#*)"/.exec(text.slice(i, i + 12));
    if (raw) { const close = `"${raw[1]}`; const j = text.indexOf(close, i + raw[0].length); const end = j < 0 ? text.length : j + close.length; out += text.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (text[i] === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1).replace(/[^\n]/g, " "); i = j + 1; continue; }
    const ch = /^'(?:\\.[^']{0,8}|[^\\'])'/.exec(text.slice(i, i + 12));
    if (ch) { out += " ".repeat(ch[0].length); i += ch[0].length; continue; }
    out += text[i++];
  }
  return out;
}
const rustModulePath = (file) => {
  const parts = file.replace(/^src\//, "").replace(/\.rs$/, "").split("/");
  if (parts[parts.length - 1] === "mod") parts.pop();
  return parts[0] === "main" ? null : parts;
};
// `use` trees: expand `a::{b, c::{d, e as f}, self}` into [{ path: [..], alias }]
function expandUse(tree, prefix = []) {
  const out = [];
  const t = tree.trim();
  const brace = t.indexOf("{");
  if (brace < 0) {
    const m = /^(.*?)(?:\s+as\s+([A-Za-z_]\w*))?$/s.exec(t);
    const path = [...prefix, ...m[1].split("::").map((x) => x.trim()).filter(Boolean)];
    if (path.length) out.push({ path, alias: m[2] ?? path[path.length - 1] });
    return out;
  }
  const head = t.slice(0, brace).split("::").map((x) => x.trim()).filter(Boolean);
  let depth = 0, start = brace + 1;
  const pieces = [];
  for (let i = brace + 1; i < t.length; i++) {
    if (t[i] === "{") depth++;
    else if (t[i] === "}") { if (depth === 0) { pieces.push(t.slice(start, i)); break; } depth--; }
    else if (t[i] === "," && depth === 0) { pieces.push(t.slice(start, i)); start = i + 1; }
  }
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    if (piece.trim() === "self") { if ([...prefix, ...head].length) out.push({ path: [...prefix, ...head], alias: head[head.length - 1] ?? prefix[prefix.length - 1] }); continue; }
    out.push(...expandUse(piece, [...prefix, ...head]));
  }
  return out;
}
/** The kind of every item a Rust file defines by name: "type" (struct, enum, trait, type, union), "const" (const only), "fn", or "unknown" for a
 *  static (a LazyLock runs code on first read, a static mut is mutable global state: neither is a shared word). */
export function itemKinds(clean) {
  const kinds = new Map();
  const vis = String.raw`^[ \t]*(?:pub(?:\([^)]*\))?\s+)?`;
  for (const m of clean.matchAll(new RegExp(`${vis}(?:const\\s+|async\\s+|unsafe\\s+|extern\\s+(?:"[^"]*"\\s+)?)*fn\\s+([A-Za-z_]\\w*)`, "gm"))) if (!kinds.has(m[1])) kinds.set(m[1], "fn");
  for (const m of clean.matchAll(new RegExp(`${vis}const\\s+([A-Za-z_]\\w*)\\s*:`, "gm"))) kinds.set(m[1], "const");
  for (const m of clean.matchAll(new RegExp(`${vis}static(?:\\s+mut)?\\s+([A-Za-z_]\\w*)\\s*:`, "gm"))) kinds.set(m[1], "unknown");
  for (const m of clean.matchAll(new RegExp(`${vis}(?:struct|enum|trait|type|union)\\s+([A-Za-z_]\\w*)`, "gm"))) kinds.set(m[1], "type");
  return kinds;
}
/** Whether rule one lets this reference through: only from a file in rule.files (see the header, part 3). */
export function ruleAllows(rule, entry) {
  if (!rule?.files?.includes(entry.from)) return false;
  if (rule.files.includes(entry.target) && (rule.shared_kinds ?? []).includes(entry.kind)) return true;
  if (entry.from_group === "agent" && rule.files.includes(entry.target) && entry.kind === "fn" && (rule.group_entries?.[entry.target] ?? []).includes(entry.name)) return true;
  return entry.from_group === "agent" && entry.kind === "fn" && (rule.agent_calls?.[entry.target] ?? []).includes(entry.name);
}
/** files: Map(src path -> source text). Returns { key: { from_group, owner } } and the number of `super::` / `self::` paths seen (not followed).
 *  For a file under rule one (groupsJson.cross_calls.rust_rule_next.files) a reference rule one lets through is counted in `allowed`, not returned,
 *  and `Type::function` paths to another group's types are references of their own (kind "fn"). */
export function analyzeRust({ files, groupsJson, rule = groupsJson.cross_calls?.rust_rule_next }) {
  const modules = new Map(); // "a::b" -> file
  for (const file of files.keys()) { const mp = rustModulePath(file); if (mp) modules.set(mp.join("::"), file); }
  const longest = (segments) => { for (let n = segments.length; n > 0; n--) { const f = modules.get(segments.slice(0, n).join("::")); if (f) return { file: f, rest: segments.slice(n) }; } return null; };
  const out = {};
  const allowed = {};
  const kindsOf = new Map();
  const kindOf = (target, name) => {
    if (!kindsOf.has(target)) kindsOf.set(target, itemKinds(blankRust(files.get(target) ?? "")));
    return name.includes("::") ? "fn" : kindsOf.get(target).get(name) ?? "unknown";
  };
  let unfollowed = 0;
  for (const [file, text] of files) {
    const fromGroup = groupsJson.files?.[file]?.group;
    if (!fromGroup) continue;
    const ruled = rule?.files?.includes(file) ?? false;
    const clean = blankRust(text);
    unfollowed += (clean.match(/\b(?:super|self)::/g) ?? []).length;
    const note = (target, name) => {
      const owner = groupsJson.files?.[target]?.group;
      if (!owner || owner === fromGroup || target === file) return;
      const key = `${file} -> ${target}::${name}`;
      if (ruled && ruleAllows(rule, { from: file, from_group: fromGroup, target, name, kind: kindOf(target, name) })) { allowed[key] = { from_group: fromGroup, owner, kind: kindOf(target, name) }; return; }
      out[key] = { from_group: fromGroup, owner };
    };
    // Under rule one a type is vocabulary only: `Type::function` through it is a call of its own.
    const assoc = (target, rest) => { if (ruled && rest.length > 1 && /^[a-z_]/.test(rest[1])) note(target, `${rest[0]}::${rest[1]}`); };
    const items = new Map(); // local name -> [module file, item name] (rule one files only)
    const aliases = new Map(); // local name -> module file
    const useRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+crate::([^;]*);/gm;
    let body = clean;
    for (const m of clean.matchAll(useRe)) {
      for (const { path, alias } of expandUse(m[1])) {
        const hit = longest(path);
        if (!hit) continue;
        if (hit.rest.length) { note(hit.file, hit.rest[0] === "*" ? "*" : hit.rest[0]); assoc(hit.file, hit.rest); if (hit.rest.length === 1 && hit.rest[0] !== "*") items.set(alias, [hit.file, hit.rest[0]]); }
        else aliases.set(alias, hit.file);
      }
      body = body.replace(m[0], " ".repeat(m[0].length));
    }
    for (const m of body.matchAll(/(?<![\w:])crate::([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/g)) {
      const hit = longest(m[1].split("::"));
      if (hit?.rest.length) { note(hit.file, hit.rest[0]); assoc(hit.file, hit.rest); }
    }
    for (const [alias, target] of aliases) {
      for (const m of body.matchAll(new RegExp(`(?<![\\w:.])${alias}::([A-Za-z_]\\w*)((?:::[A-Za-z_]\\w*)?)`, "g"))) { note(target, m[1]); assoc(target, [m[1], ...m[2].split("::").filter(Boolean)]); }
    }
    if (ruled) for (const [local, [target, name]] of items) {
      for (const m of body.matchAll(new RegExp(`(?<![\\w:.])${local}::([A-Za-z_]\\w*)`, "g"))) assoc(target, [name, m[1]]);
    }
  }
  return { entries: out, unfollowed, allowed };
}

// ---- ratchet ---------------------------------------------------------------------------------------------------------------------------------
const SECTIONS = ["modules", "rust_modules"];
export function compare(current, known) {
  const red = [];
  for (const section of SECTIONS) {
    const now = current[section] ?? {}, was = known?.[section] ?? {};
    for (const [key, entry] of Object.entries(now)) {
      const base = was[key];
      if (!base) { red.push(`NEW ${section === "modules" ? "module import across groups" : "Rust reference across groups"}: ${key}`); continue; }
      if (section === "modules") {
        const extraGroups = entry.groups.filter((g) => !(base.groups ?? []).includes(g));
        const extraFrom = entry.from.filter((f) => !(base.from ?? []).includes(f));
        if (extraGroups.length) red.push(`MORE GROUPS import ${key}: ${extraGroups.join(", ")} (known: ${(base.groups ?? []).join(", ")})`);
        else if (extraFrom.length) red.push(`NEW IMPORTER of ${key}: ${extraFrom.join(", ")}`);
        else if (entry.write && !base.write) red.push(`${key} is now written as a write by name but the baseline does not mark it`);
        else if (entry.groups.length < (base.groups ?? []).length || entry.from.length < (base.from ?? []).length || (!entry.write && base.write)) red.push(`STALE baseline entry ${section}.${key}: it now holds less; please shorten the baseline line`);
      }
    }
    for (const key of Object.keys(was)) if (!now[key]) red.push(`STALE baseline entry ${section}.${key} no longer holds; please delete it from the baseline`);
  }
  return red;
}
const whyOf = (section) => (section === "modules" ? WHY : `${WHY}（Rust，只有静态棘轮看得见）`);
export function baselineFrom(current) {
  const out = {};
  for (const section of SECTIONS) out[section] = Object.fromEntries(Object.keys(current[section]).sort().map((key) => [key, { ...current[section][key], why: whyOf(section) }]));
  return out;
}
/** Keep what still holds, narrowed to what holds now. Throws on anything that would add a line, a group, an importer or a write mark. */
export function shrinkBaseline(current, known) {
  const additions = compare(current, known).filter((m) => /^(NEW |MORE GROUPS|.* is now written)/.test(m));
  if (additions.length) throw new Error(`the baseline may only get shorter; this would add:\n${additions.join("\n")}`);
  const out = {};
  for (const section of SECTIONS) {
    out[section] = {};
    for (const [key, base] of Object.entries(known[section] ?? {})) {
      const now = current[section]?.[key];
      if (now) out[section][key] = { ...base, ...(section === "modules" ? { groups: now.groups, from: now.from, write: now.write } : {}) };
    }
  }
  return out;
}

// ---- reading the repository ------------------------------------------------------------------------------------------------------------------
export function readSources(groupsJson, root = REPO) {
  const ts = new Map(), rust = new Map();
  for (const file of Object.keys(groupsJson.files ?? {})) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    if (file.startsWith(PI) && /\.(mjs|ts|js)$/.test(file)) ts.set(file, readFileSync(path, "utf8"));
    else if (file.startsWith("src/") && file.endsWith(".rs")) rust.set(file, readFileSync(path, "utf8"));
  }
  return { ts, rust };
}
export function analyzeAll(groupsJson, root = REPO) {
  const { ts, rust } = readSources(groupsJson, root);
  const r = analyzeRust({ files: rust, groupsJson });
  return { modules: analyzeModules({ files: ts, groupsJson }), rust_modules: r.entries, rust_rule_allowed: r.allowed, unfollowed: r.unfollowed, stats: { ts_modules: ts.size, rust_files: rust.size } };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const groupsJson = JSON.parse(readFileSync(join(REPO, "runtime/pi/groups.json"), "utf8"));
  const current = analyzeAll(groupsJson);
  const summary = () => ({ stats: current.stats, modules: Object.keys(current.modules).length, module_importers: Object.values(current.modules).reduce((n, e) => n + e.from.length, 0), rust_references: Object.keys(current.rust_modules).length, rust_rule_one_passed: Object.keys(current.rust_rule_allowed).length, rust_unfollowed_super_self: current.unfollowed });
  if (process.argv.includes("--print")) { console.log(JSON.stringify(summary(), null, 1)); process.exit(0); }
  if (process.argv.includes("--write-baseline")) {
    const whole = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
    const table = whole.cross_calls ?? {};
    let next;
    if (!table.modules || !table.rust_modules) next = baselineFrom(current);
    else { try { next = shrinkBaseline(current, table); } catch (error) { console.error(error.message); process.exit(1); } }
    writeFileSync(BASELINE_PATH, JSON.stringify({ ...whole, cross_calls: { ...table, ...next } }, null, 1) + "\n");
    console.log("baseline written");
    process.exit(0);
  }

  // self-test on small fixtures
  const FIX = { files: { "runtime/pi/v.mjs": { group: "visual" }, "runtime/pi/k.mjs": { group: "knowledge" }, "runtime/pi/v2.mjs": { group: "visual" }, "src/a.rs": { group: "agent" }, "src/k.rs": { group: "knowledge" }, "src/a2.rs": { group: "agent" }, "src/commands/mod.rs": { group: "system" } } };
  const tsFix = (v, v2 = `export const w = 1;`) => analyzeModules({ files: new Map([["runtime/pi/v.mjs", v], ["runtime/pi/k.mjs", "export function f() {}\nexport function g() {}\n"], ["runtime/pi/v2.mjs", v2]]), groupsJson: FIX });
  assert.deepEqual(Object.keys(tsFix(`import { f } from "./k.mjs";\nf();\n`)), ["k.mjs::f"], "a visual module using a knowledge export is pinned");
  assert.deepEqual(tsFix(`import { f } from "./k.mjs";\nf();\n`)["k.mjs::f"], { owner: "knowledge", groups: ["visual"], from: ["v.mjs"], write: false });
  assert.deepEqual(Object.keys(tsFix(`import { f } from "./k.mjs";\n`)), ["k.mjs::f"], "an import counts even when it is not used yet: it is the way in");
  assert.deepEqual(tsFix(`import { f as h } from "./k.mjs";\nh();\n`)["k.mjs::f"].from, ["v.mjs"], "an alias is keyed by the exported name");
  assert.deepEqual(Object.keys(tsFix(`import { trackExport } from "./groups.mjs";\n`)), [], "fixture: groups.mjs is not in the fixture table");
  assert.deepEqual(tsFix(`export const a = 1;\n`, `import { w } from "./v.mjs";\nw;\n`), {}, "a same-group import is not a cross reference");
  const baseTs = { modules: tsFix(`import { f } from "./k.mjs";\nf();\n`), rust_modules: {} };
  const known = baselineFrom(baseTs);
  assert.deepEqual(compare(baseTs, known), [], "the pinned state is green");
  assert.match(compare({ modules: tsFix(`import { f, g } from "./k.mjs";\nf(); g();\n`), rust_modules: {} }, known).join("\n"), /NEW module import across groups: k\.mjs::g/, "a new cross import is red");
  assert.match(compare({ modules: tsFix(`import { f } from "./k.mjs";\nf();\n`, `import { f } from "./k.mjs";\nf();\n`), rust_modules: {} }, known).join("\n"), /NEW IMPORTER of k\.mjs::f: v2\.mjs/, "a second importer is red");
  assert.match(compare({ modules: {}, rust_modules: {} }, known).join("\n"), /STALE baseline entry modules\.k\.mjs::f no longer holds/, "a removed import leaves a stale line");
  assert.throws(() => shrinkBaseline({ modules: tsFix(`import { f, g } from "./k.mjs";\nf(); g();\n`), rust_modules: {} }, known), /only get shorter/, "--write-baseline never adds a line");
  assert.deepEqual(shrinkBaseline({ modules: {}, rust_modules: {} }, known).modules, {}, "--write-baseline drops a line that no longer holds");

  const rs = (a, a2 = "") => analyzeRust({ files: new Map([["src/a.rs", a], ["src/k.rs", "pub fn x() {}\n"], ["src/a2.rs", a2], ["src/commands/mod.rs", ""]]), groupsJson: FIX });
  assert.deepEqual(Object.keys(rs("use crate::k::x;\nfn f() { x(); }\n").entries), ["src/a.rs -> src/k.rs::x"], "use crate::m::x");
  assert.deepEqual(Object.keys(rs("fn f() { crate::k::x(); }\n").entries), ["src/a.rs -> src/k.rs::x"], "an inline crate:: path");
  assert.deepEqual(Object.keys(rs("use crate::k;\nfn f() { k::x(); }\n").entries), ["src/a.rs -> src/k.rs::x"], "module alias then alias::x");
  assert.deepEqual(Object.keys(rs("use crate::{k, a2};\nfn f() { k::x(); a2::y(); }\n").entries), ["src/a.rs -> src/k.rs::x"], "a brace list; a same-group module is not a cross reference");
  assert.deepEqual(Object.keys(rs("use crate::k::{x, y as z};\n").entries).sort(), ["src/a.rs -> src/k.rs::x", "src/a.rs -> src/k.rs::y"], "names in braces, with `as`");
  assert.deepEqual(Object.keys(rs("// use crate::k::x;\nfn f() { let s = \"crate::k::x\"; }\n").entries), [], "comments and strings are not references");
  assert.deepEqual(Object.keys(rs("fn f() {}\n#[cfg(test)]\nmod tests {\n use crate::k::x;\n}\n").entries), [], "a #[cfg(test)] module is not scanned");
  assert.deepEqual(Object.keys(rs("use crate::commands::run;\n").entries), ["src/a.rs -> src/commands/mod.rs::run"], "a directory module resolves to its mod.rs");
  const baseRs = { modules: {}, rust_modules: rs("use crate::k::x;\n").entries };
  const knownRs = baselineFrom(baseRs);
  assert.deepEqual(compare(baseRs, knownRs), [], "the pinned Rust state is green");
  assert.match(compare({ modules: {}, rust_modules: rs("use crate::k::x;\nuse crate::k::y;\n").entries }, knownRs).join("\n"), /NEW Rust reference across groups: src\/a\.rs -> src\/k\.rs::y/, "a new cross-group reference is red");
  assert.match(compare({ modules: {}, rust_modules: rs("use crate::k::x;\n", "use crate::k::x;\n").entries }, knownRs).join("\n"), /NEW Rust reference across groups: src\/a2\.rs -> src\/k\.rs::x/, "another file reaching the same item is red");
  assert.match(compare({ modules: {}, rust_modules: {} }, knownRs).join("\n"), /STALE baseline entry rust_modules/, "a removed reference leaves a stale line");
  // rule one (cross_calls.rust_rule_next): a.rs and k.rs are new-route files, a2.rs is not; g.rs is a system file with one listed write entry
  const RULE = { files: ["src/a.rs", "src/k.rs", "src/v.rs"], shared_kinds: ["type", "const"], agent_calls: { "src/g.rs": ["create_new"] }, group_entries: { "src/k.rs": ["call"], "src/v.rs": ["call"] } };
  const FIX1 = { files: { ...FIX.files, "src/g.rs": { group: "system" }, "src/v.rs": { group: "visual" } } };
  const K = "pub struct Catalog { n: u8 }\nimpl Catalog {\n    pub fn load() -> Catalog { Catalog { n: 0 } }\n}\npub enum Role { Time }\npub const SHARE: f64 = 0.5;\npub fn x() {}\npub fn call() {}\n";
  const G = "pub fn create_new() {}\npub fn enter_command() {}\n";
  const ruled = (a, a2 = "", k = K) => analyzeRust({ files: new Map([["src/a.rs", a], ["src/k.rs", k], ["src/a2.rs", a2], ["src/g.rs", G], ["src/commands/mod.rs", ""]]), groupsJson: FIX1, rule: RULE });
  assert.deepEqual(itemKinds(blankRust(K)), new Map([["load", "fn"], ["x", "fn"], ["call", "fn"], ["SHARE", "const"], ["Catalog", "type"], ["Role", "type"]]), "item kinds come from the definitions");
  const passed = ruled("use crate::k::{Catalog, Role, SHARE};\nfn f(c: &Catalog) -> f64 { let _ = Role::Time; SHARE }\n");
  assert.deepEqual(passed.entries, {}, "rule one: a type, an enum variant path and a constant of another new-route group pass");
  assert.deepEqual(Object.keys(passed.allowed).sort(), ["src/a.rs -> src/k.rs::Catalog", "src/a.rs -> src/k.rs::Role", "src/a.rs -> src/k.rs::SHARE"], "rule one: what passed is counted");
  assert.deepEqual(Object.keys(ruled("use crate::k::x;\nfn f() { x(); }\n").entries), ["src/a.rs -> src/k.rs::x"], "rule one: a function of another group is still red");
  assert.deepEqual(Object.keys(ruled("use crate::k::Catalog;\nfn f() { Catalog::load(); }\n").entries), ["src/a.rs -> src/k.rs::Catalog::load"], "rule one: Type::function through a shared type is a call, red");
  assert.deepEqual(Object.keys(ruled("fn f() { crate::k::Catalog::load(); }\n").entries), ["src/a.rs -> src/k.rs::Catalog::load"], "rule one: an inline crate::m::Type::function is a call, red");
  assert.deepEqual(Object.keys(ruled("use crate::k;\nfn f() { k::Catalog::load(); }\n").entries), ["src/a.rs -> src/k.rs::Catalog::load"], "rule one: m::Type::function through a module alias is a call, red");
  assert.deepEqual(Object.keys(ruled("use crate::k::*;\n").entries), ["src/a.rs -> src/k.rs::*"], "rule one: a glob is red");
  assert.deepEqual(ruled("fn f() { crate::g::create_new(); }\n").entries, {}, "rule one: an agent file may call a listed system write entry");
  const entry = ruled("use crate::k::{self, Role};\nfn f() { let _ = k::call(Role::Time); crate::k::call(Role::Time); }\n");
  assert.deepEqual(entry.entries, {}, "rule one: another group's command entry (group_entries) passes, by alias and inline");
  assert.ok(entry.allowed["src/a.rs -> src/k.rs::call"], "rule one: the entry call is counted as passed");
  assert.deepEqual(Object.keys(ruled("", "use crate::k::call;\n").entries), ["src/a2.rs -> src/k.rs::call"], "rule one: a file outside the rule may not call the entry");
  assert.deepEqual(Object.keys(ruled("use crate::k::x;\n").entries), ["src/a.rs -> src/k.rs::x"], "rule one: a command file's other functions stay red");
  assert.deepEqual(Object.keys(analyzeRust({ files: new Map([["src/k.rs", "fn f() { crate::v::call(); }\n"], ["src/v.rs", "pub fn call() {}\n"]]), groupsJson: FIX1, rule: RULE }).entries), ["src/k.rs -> src/v.rs::call"], "rule one: only the agent group may call another group's command entry");
  assert.deepEqual(Object.keys(ruled("fn f() { crate::g::enter_command(); }\n").entries), ["src/a.rs -> src/g.rs::enter_command"], "rule one: another system function is red");
  assert.deepEqual(Object.keys(analyzeRust({ files: new Map([["src/k.rs", "fn f() { crate::g::create_new(); }\n"], ["src/g.rs", G]]), groupsJson: FIX1, rule: RULE }).entries), ["src/k.rs -> src/g.rs::create_new"], "rule one: the system write entries are for the agent group only");
  const legacy = ruled("", "use crate::k::{Catalog, SHARE};\nfn f() { Catalog::load(); }\n");
  assert.deepEqual(Object.keys(legacy.entries).sort(), ["src/a2.rs -> src/k.rs::Catalog", "src/a2.rs -> src/k.rs::SHARE"], "rule one: a file outside the rule keeps its lines exactly as before (no pass, no new Type::function line)");
  assert.deepEqual(legacy.entries, rs("", "use crate::k::{Catalog, SHARE};\nfn f() { Catalog::load(); }\n").entries, "rule one: outside the rule the reading is the one with no rule");
  assert.deepEqual(Object.keys(ruled("use crate::k::Catalog;\n", "", "pub fn Catalog() {}\n").entries), ["src/a.rs -> src/k.rs::Catalog"], "rule one: a name defined as a function is not a type");
  const S = "pub static TABLE: std::sync::LazyLock<u8> = std::sync::LazyLock::new(|| 0);\npub static mut COUNT: u8 = 0;\n";
  assert.deepEqual(Object.keys(ruled("use crate::k::{TABLE, COUNT};\n", "", S).entries).sort(), ["src/a.rs -> src/k.rs::COUNT", "src/a.rs -> src/k.rs::TABLE"], "rule one: a static (lazy or mut) is not a shared constant, red");
  console.log("self-test -- PASS");

  // the real tree
  const table = (existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {}).cross_calls;
  assert.ok(table?.modules && table?.rust_modules, "groups.json cross_calls has the modules and rust_modules sections (node scripts/test_group_module_calls.mjs --write-baseline once)");
  for (const section of SECTIONS) for (const [key, entry] of Object.entries(table[section])) assert.ok(typeof entry.why === "string" && entry.why.length > 0, `baseline entry ${section}.${key} says why`);
  const red = compare(current, table);
  assert.deepEqual(red, [], `cross-group references outside newsroom.ts changed:\n${red.join("\n")}`);
  console.log(`group module calls: ${current.stats.ts_modules} modules, ${Object.keys(current.modules).length} imported names across groups, ${current.stats.rust_files} Rust files, ${Object.keys(current.rust_modules).length} Rust references across groups, ${current.unfollowed} super::/self:: paths not followed -- PASS`);
}
