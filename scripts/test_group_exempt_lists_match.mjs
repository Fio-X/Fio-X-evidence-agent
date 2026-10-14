#!/usr/bin/env node
// The exemption rules live twice: runtime/pi/groups.mjs (exemptionOf, BOOKKEEPING_FILES) and src/group_guard.rs (exempt_reason, FILES). A path one side exempts and the
// other judges would be judged differently by the two writers. This reads both sources as text and checks the bookkeeping files are the same list in the same
// order, the temp folder, temp suffixes and session folder agree, and the four exemption names come out in the same order. Mutants turn it red. No build, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, "utf8");
const strings = (text) => [...text.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);

export function jsRules(text) {
  const files = /BOOKKEEPING_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text)?.[1];
  const folders = /BOOKKEEPING_FOLDERS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text)?.[1];
  const exemptionOf = /export const exemptionOf = [\s\S]*?: null\);/.exec(text)?.[0];
  assert.ok(files && folders && exemptionOf, "the JS rules are found");
  return {
    files: strings(files), folders: strings(folders),
    order: [...exemptionOf.matchAll(/\? "([a-z_]+)"|: "([a-z_]+)"/g)].map((m) => m[1] ?? m[2]),
    tempFolders: strings(/E1_TEMP_FOLDERS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text)?.[1] ?? ""),
    tempSuffixes: strings(/E1_TEMP_SUFFIXES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text)?.[1] ?? ""),
  };
}
export function rustRules(text) {
  const fn = /pub fn exempt_reason\(rel: &str\)[\s\S]*?\n}\n/.exec(text)?.[0];
  assert.ok(fn, "the Rust exempt_reason is found");
  const files = /const FILES: &\[&str\] = &\[([\s\S]*?)\];/.exec(fn)?.[1];
  assert.ok(files, "the Rust FILES list is found");
  return {
    files: strings(files),
    order: [...fn.matchAll(/Some\("([a-z_]+)"\)/g)].map((m) => m[1]),
    starts: [...fn.matchAll(/rel\.starts_with\("([^"]+)"\)/g)].map((m) => m[1]),
    ends: [...fn.matchAll(/rel\.ends_with\("([^"]+)"\)/g)].map((m) => m[1]),
  };
}
export function problems(js, rust) {
  const out = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(js.files, rust.files)) out.push(`bookkeeping files differ: JS ${JSON.stringify(js.files)} vs Rust ${JSON.stringify(rust.files)}`);
  if (!same(js.order, rust.order)) out.push(`exemption order differs: JS ${js.order} vs Rust ${rust.order}`);
  if (!same([...js.tempFolders, ...js.folders].sort(), [...rust.starts].sort())) out.push(`folder rules differ: JS ${[...js.tempFolders, ...js.folders]} vs Rust ${rust.starts}`);
  if (!same([...js.tempSuffixes].sort(), [...rust.ends].sort())) out.push(`temp suffixes differ: JS ${js.tempSuffixes} vs Rust ${rust.ends}`);
  return out;
}

const jsText = read("runtime/pi/groups.mjs");
const rustText = read("src/group_guard.rs");
const results = [];
const check = (name) => { results.push(name); console.log(`  ok  ${name}`); };

const js = jsRules(jsText);
const rust = rustRules(rustText);
assert.ok(js.files.length >= 8 && js.order.length === 4, "the lists are not empty");
assert.deepEqual(problems(js, rust), []);
check("the JS and Rust exemption rules agree: bookkeeping files (same list, same order), folders, temp suffixes, exemption order");

const mutants = {
  "a bookkeeping file added on the JS side": () => problems(jsRules(jsText.replace('"conversation.md",', '"conversation.md", "extra.json",')), rust),
  "a bookkeeping file dropped on the Rust side": () => problems(js, rustRules(rustText.replace('        "conversation.md",\n', ""))),
  "a temp suffix dropped on the Rust side": () => problems(js, rustRules(rustText.replace(' || rel.ends_with(".write-tmp")', ""))),
  "the Rust order swapped": () => problems(js, rustRules(rustText.replace('Some("preview_tmp")', 'Some("session_folder")'))),
};
for (const [name, run] of Object.entries(mutants)) {
  assert.ok(run().length > 0, `mutant stayed green: ${name}`);
  check(`mutation: ${name} -> red`);
}
console.log(`group exempt lists match: PASS (${results.length} checks)`);
