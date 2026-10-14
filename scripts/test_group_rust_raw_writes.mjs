#!/usr/bin/env node
// K368 (#62, hole B3): static ratchet on raw file writes in non-test Rust. Outside src/group_guard.rs, production code under src/ must not call
// std::fs / tokio::fs write functions (write, create_dir_all, create_dir, copy, rename, remove_file, remove_dir_all, remove_dir, hard_link,
// set_permissions), File::create / File::create_new, or OpenOptions: every write goes through a group_guard wrapper, which is where the group
// judgement lives. Calls through an imported or aliased name count too (`use std::fs::write as w; w(..)`, `use std::fs as f; f::write(..)`,
// `use std::fs::{File as F}; F::create(..)`, an aliased OpenOptions, a glob import of a fs module).
// The cargo test group_guard::tests::no_raw_write_calls_outside_this_module is the same rule, but it needs a compile and it stops reading a file at the
// first `#[cfg(test)] mod`. This one runs in the node job and reads the whole file: only a `#[cfg(test)]` that is IMMEDIATELY followed by `mod x { .. }`
// is a test module (its braces are matched and the block is blanked); other `#[cfg(test)]` items (a test-only fn or static) are NOT blanked and still count.
// Red when: a raw write appears in non-test Rust outside group_guard.rs. The allowance is exactly one file and it never grows: there is no list here.
// `--root <dir>` reads <dir>/src instead of the repository (the mutation checks below run that way on temporary copies).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO = join(dirname(HERE), "..");
const argAfter = (flag) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : null; };
const ROOT = argAfter("--root") ?? REPO;
const ALLOWED_FILE = "src/group_guard.rs";
const WRITE_FNS = ["write", "create_dir_all", "create_dir", "copy", "rename", "remove_file", "remove_dir_all", "remove_dir", "hard_link", "set_permissions"];
const FN_ALT = WRITE_FNS.join("|");

/** Comments, string and char literals become spaces (length and newlines kept). Unlike group_guard's scan this does not cut the file anywhere. */
export function blankRust(text) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const two = text.slice(i, i + 2);
    const space = (end) => { out += text.slice(i, end).replace(/[^\n]/g, " "); i = end; };
    if (two === "//") { const j = text.indexOf("\n", i); space(j < 0 ? text.length : j); continue; }
    if (two === "/*") {
      let depth = 1, j = i + 2;
      while (j < text.length && depth) { if (text.startsWith("/*", j)) { depth++; j += 2; } else if (text.startsWith("*/", j)) { depth--; j += 2; } else j++; }
      space(j); continue;
    }
    const raw = /^b?r(#*)"/.exec(text.slice(i, i + 12));
    if (raw) { const close = `"${raw[1]}`; const j = text.indexOf(close, i + raw[0].length); space(j < 0 ? text.length : j + close.length); continue; }
    if (text[i] === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; space(Math.min(j + 1, text.length)); continue; }
    const ch = /^'(?:\\.[^']{0,8}|[^\\'])'/.exec(text.slice(i, i + 12));
    if (ch) { space(i + ch[0].length); continue; }
    out += text[i++];
  }
  return out;
}

/** Blank every `#[cfg(test)] mod x { .. }` block (attributes between are allowed). Input must already be blanked of comments and strings. */
export function dropTestModules(blanked) {
  const head = /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*([{;])/g;
  let out = blanked, m;
  while ((m = head.exec(blanked))) {
    if (m[1] === ";") { // `#[cfg(test)] mod x;` has no body here (the file is separate); nothing to blank
      continue;
    }
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < blanked.length; j++) {
      if (blanked[j] === "{") depth++;
      else if (blanked[j] === "}" && --depth === 0) break;
    }
    out = out.slice(0, m.index) + blanked.slice(m.index, j + 1).replace(/[^\n]/g, " ") + out.slice(j + 1);
    head.lastIndex = j + 1;
  }
  return out;
}

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
    const self = /^self(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(piece.trim());
    if (self) { out.push({ path: [...prefix, ...head], alias: self[1] ?? head[head.length - 1] ?? prefix[prefix.length - 1] }); continue; }
    out.push(...expandUse(piece, [...prefix, ...head]));
  }
  return out;
}
const isFsModule = (p) => p.length >= 2 && p[p.length - 1] === "fs" && ["std", "tokio"].includes(p[0]);

/** Every raw write in the non-test part of one Rust file: [{ line, text }] (1-based lines of the original). */
export function rawWriteHits(source) {
  const code = dropTestModules(blankRust(source));
  const original = source.split("\n");
  const hits = new Map();
  const hit = (index) => { if (!hits.has(index)) hits.set(index, { line: index + 1, text: original[index].trim() }); };
  const lineOf = (offset) => code.slice(0, offset).split("\n").length - 1;

  const ns = new Set(["fs"]), files = new Set(["File"]), opens = new Set(["OpenOptions"]), bare = new Set();
  for (const use of code.matchAll(/\buse\s+([^;]+);/g)) {
    for (const { path, alias } of expandUse(use[1])) {
      const last = path[path.length - 1];
      if (last === "*" && isFsModule(path.slice(0, -1))) { hit(lineOf(use.index)); continue; }
      if (isFsModule(path)) ns.add(alias);
      else if (isFsModule(path.slice(0, -1))) {
        if (WRITE_FNS.includes(last)) bare.add(alias);
        else if (last === "File") files.add(alias);
        else if (last === "OpenOptions") opens.add(alias);
      }
    }
  }
  const call = (pattern) => { for (const m of code.matchAll(pattern)) hit(lineOf(m.index)); };
  for (const n of ns) call(new RegExp(`(?<![\\w])${n}::(?:${FN_ALT})\\s*\\(`, "g"));
  for (const n of ns) call(new RegExp(`(?<![\\w])${n}::(?:File::create(?:_new)?|OpenOptions)\\b`, "g"));
  for (const n of files) call(new RegExp(`(?<![\\w])${n}::create(?:_new)?\\s*\\(`, "g"));
  for (const n of opens) call(new RegExp(`(?<![\\w])${n}\\b(?!\\s*::\\s*[A-Z])`, "g"));
  for (const n of bare) call(new RegExp(`(?<![\\w.:])${n}\\s*\\(`, "g"));
  return [...hits.values()].sort((a, b) => a.line - b.line);
}

function rustFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".rs")) out.push(path);
    }
  };
  if (existsSync(join(root, "src"))) walk(join(root, "src"));
  return out.sort();
}
export function scanTree(root) {
  const found = [];
  for (const file of rustFiles(root)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    if (rel === ALLOWED_FILE) continue;
    for (const h of rawWriteHits(readFileSync(file, "utf8"))) found.push(`${rel}:${h.line}: ${h.text}`);
  }
  return found;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const found = scanTree(ROOT);
  const scanned = rustFiles(ROOT).length;
  if (argAfter("--root")) { // child mode for the mutation checks: print and exit with the verdict
    for (const f of found) console.log(f);
    process.exit(found.length ? 1 : 0);
  }
  assert.ok(scanned >= 30, `expected to scan the whole src/ tree, saw ${scanned} files`);
  assert.deepEqual(found, [], `raw file writes outside ${ALLOWED_FILE} in non-test Rust:\n${found.join("\n")}`);
  console.log(`ok: ${scanned} Rust files read, no raw file write outside ${ALLOWED_FILE}`);

  // ---- sample checks on the scanner itself (in memory) -------------------------------------------------------------------------------------
  const must = (name, source) => assert.ok(rawWriteHits(source).length > 0, `must be caught: ${name}`);
  const clean = (name, source) => assert.deepEqual(rawWriteHits(source), [], `must not be caught: ${name}`);
  must("qualified fs::write", "fn g() { std::fs::write(\"a\", \"b\").unwrap(); }");
  must("tokio create_dir_all", "fn g() { tokio::fs::create_dir_all(\"a\"); }");
  must("plain import", "use std::fs::write;\nfn g() { write(\"a\", \"b\").unwrap(); }");
  must("aliased import", "use std::fs::write as w;\nfn g() { w(\"a\", \"b\").unwrap(); }");
  must("namespace alias", "use std::fs as f;\nfn g() { f::rename(\"a\", \"b\").unwrap(); }");
  must("self alias in a group", "use std::{fs::{self as files}, io};\nfn g() { files::create_dir_all(\"a\").unwrap(); }");
  must("File alias", "use std::fs::{self, File as F};\nfn g() { F::create(\"a\").unwrap(); }");
  must("OpenOptions", "fn g() { let o = std::fs::OpenOptions::new(); }");
  must("OpenOptions alias", "use std::fs::{\n    File,\n    OpenOptions as Opts,\n};\nfn g() { Opts::new(); }");
  must("glob import", "use std::fs::*;\nfn g() {}");
  must("code after a mid-file test module", "#[cfg(test)]\nmod tests { fn t() {} }\nfn g() { std::fs::remove_file(\"a\").unwrap(); }");
  must("a #[cfg(test)] fn is not a test module", "#[cfg(test)]\nfn helper() { std::fs::write(\"a\", \"b\").unwrap(); }");
  clean("in a test module", "fn g() {}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { std::fs::write(\"a\", \"b\").unwrap(); let _ = \"}\"; }\n}\n");
  clean("reads", "use std::fs;\nfn g() { fs::read_to_string(\"a\").unwrap(); let _ = std::fs::File::open(\"a\"); }");
  clean("text in a string and a comment", "fn g() { let _ = \"std::fs::write(a)\"; } // fs::remove_file(a)\n/* fs::copy(a, b) */");
  clean("a method that shares a name", "fn g(w: &mut W) { w.write(b\"a\"); w.copy(); }");
  clean("io::copy", "fn g() { std::io::copy(&mut r, &mut w).unwrap(); }");
  console.log("ok: scanner samples (aliases, mid-file test module, test-only fn, strings) behave");

  // ---- mutation checks on temporary copies of src/ -------------------------------------------------------------------------------------------
  const tmp = mkdtempSync(join(tmpdir(), "k368-b3-"));
  try {
    const run = (name, edit, expectRed) => {
      const dir = mkdtempSync(join(tmp, "m-"));
      cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
      edit(dir);
      const res = spawnSync(process.execPath, [HERE, "--root", dir], { encoding: "utf8" });
      assert.equal(res.status === 1, expectRed, `mutation "${name}": expected ${expectRed ? "red" : "green"}, exit ${res.status}\n${res.stdout}${res.stderr}`);
      console.log(`ok: mutation "${name}" -> ${expectRed ? "red" : "green"}`);
    };
    const patch = (file, fn) => (dir) => { const p = join(dir, file); writeFileSync(p, fn(readFileSync(p, "utf8"))); };
    const raw = "\nfn k368_mutant() { std::fs::write(\"a\", \"b\").unwrap(); }\n";
    run("raw write in the non-test part of verify.rs", patch("src/verify.rs", (t) => t + raw), true);
    run("raw write in a nested module file", patch("src/commands/inspect.rs", (t) => t + raw), true);
    run("aliased import in the non-test part", patch("src/staging.rs", (t) => "use std::fs::rename as mv;\n" + t + "\nfn k368_mutant() { mv(\"a\", \"b\").unwrap(); }\n"), true);
    run("raw write inside the test module only", patch("src/verify.rs", (t) => {
      const at = t.search(/#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/);
      assert.ok(at >= 0, "verify.rs has a test module");
      const open = t.indexOf("{", at);
      return t.slice(0, open + 1) + "\n    fn k368_test_only() { std::fs::write(\"a\", \"b\").unwrap(); }\n" + t.slice(open + 1);
    }), false);
    run("raw write in group_guard.rs (the one allowed file)", patch("src/group_guard.rs", (t) => t + raw), false);
    run("unchanged copy", () => {}, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("PASS test_group_rust_raw_writes");
}
